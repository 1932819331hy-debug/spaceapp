#!/usr/bin/env node
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  compose,
  dockerResources,
  ensureBuild,
  ensureTemporalNamespace,
  installOpenCode,
  parseOpenCodeVersion,
  parsePinnedImages,
  pidAlive,
  prepareState,
  renderCompose,
  repoRoot,
  resolveConfig,
  run,
  sleep,
  sourceEnv,
  waitHealthy,
  waitReady
} from "./dev-stack-lib.mjs";
import {
  assertOwnedState,
  assertSafeDevStackOverrides,
  claimStateOwnership,
  claimSupervisor,
  ownedManagedProcessRecords,
  ownedSupervisorPid,
  processIdentity,
  releaseSupervisor,
  writeManagedProcessRecords
} from "./dev-stack-safety.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const ownershipFileName = ".ownership.json";
const processFileName = ".processes.json";

function prefixStream(stream, label, target) {
  let pending = "";
  stream.on("data", (chunk) => {
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || "";
    for (const line of lines) target.write(`[${label}] ${line}\n`);
  });
  stream.on("end", () => { if (pending) target.write(`[${label}] ${pending}\n`); });
}

function processGroupAlive(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(process.platform === "win32" ? pgid : -pgid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

export function terminateTree(child, signal = "SIGTERM") {
  if (!child) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else if (child.exitCode == null) child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

export async function waitDead(child, timeoutMs = 7000) {
  if (!child?.pid) return;
  const alive = () => process.platform === "win32" ? child.exitCode == null : processGroupAlive(child.pid);
  let deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && alive()) await sleep(100);
  if (!alive()) return;
  terminateTree(child, "SIGKILL");
  deadline = Date.now() + 2000;
  while (Date.now() < deadline && alive()) await sleep(100);
  if (alive()) throw new Error(`Managed process group ${child.pid} did not stop cleanly.`);
}

async function waitRecordedDead(record, timeoutMs = 7000) {
  const alive = () => processGroupAlive(record.pgid);
  let deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && alive()) await sleep(100);
  if (!alive()) return;
  try {
    process.kill(process.platform === "win32" ? record.pid : -record.pgid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  deadline = Date.now() + 2000;
  while (Date.now() < deadline && alive()) await sleep(100);
  if (alive()) throw new Error(`Recorded dev-stack process group ${record.pgid} did not stop cleanly.`);
}

function spawnService(config, name, command, args, env, onUnexpectedExit) {
  const child = spawn(command, args, {
    cwd: config.root,
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });
  prefixStream(child.stdout, name, process.stdout);
  prefixStream(child.stderr, name, process.stderr);
  child.once("exit", (code, signal) => onUnexpectedExit(name, child, code, signal));
  return child;
}

async function identifyManagedChild(config, name, child) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const identity = await processIdentity(child.pid);
    if (identity && identity.pgid === child.pid) {
      return {
        name,
        pid: child.pid,
        pgid: child.pid,
        rootHash: config.rootHash,
        startedAt: identity.startedAt,
        args: identity.args
      };
    }
    if (child.exitCode != null) break;
    await sleep(25);
  }
  throw new Error(`Could not establish managed process identity for ${name}.`);
}

export async function stopRecordedProcesses(config) {
  const records = await ownedManagedProcessRecords(config);
  if (!records.length) return;
  for (const record of records) {
    try {
      process.kill(process.platform === "win32" ? record.pid : -record.pgid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  await Promise.all(records.map((record) => waitRecordedDead(record)));
  await writeManagedProcessRecords(config, []);
}

export async function ensureDarwinNodePtySpawnHelpers(root, platform = process.platform) {
  if (platform !== "darwin") return [];
  const prebuilds = join(root, "node_modules", "node-pty", "prebuilds");
  if (!existsSync(prebuilds)) return [];

  const repaired = [];
  for (const entry of await readdir(prebuilds, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("darwin-")) continue;
    const helper = join(prebuilds, entry.name, "spawn-helper");
    if (!existsSync(helper)) continue;
    const info = await stat(helper);
    const currentMode = info.mode & 0o777;
    const desiredMode = currentMode | 0o111;
    if (currentMode === desiredMode) continue;
    await chmod(helper, desiredMode);
    repaired.push(helper);
  }
  return repaired;
}

async function waitSupervisorExit(pid, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && pidAlive(pid)) await sleep(100);
  if (pidAlive(pid)) throw new Error(`Dev-stack supervisor ${pid} did not stop cleanly.`);
}

async function waitServiceHealthyWithDiagnostics(config, service, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "missing";
  while (Date.now() < deadline) {
    const id = (await compose(config, ["ps", "-q", service], { capture: true })).stdout;
    if (id) {
      const status = await run("docker", ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", id], {
        capture: true,
        allowFailure: true
      });
      lastStatus = status.stdout || `inspect-exit-${status.code}`;
      if (lastStatus === "healthy") return;
      if (["exited", "dead"].includes(lastStatus)) break;
    }
    await sleep(1000);
  }

  const logs = await compose(config, ["logs", "--no-color", "--tail", "200", service], { capture: true, allowFailure: true });
  const diagnostic = [logs.stdout, logs.stderr].filter(Boolean).join("\n");
  if (diagnostic) process.stderr.write(`[dev:stack] ${service} diagnostic logs:\n${diagnostic}\n`);
  throw new Error(`${service} did not become healthy within ${Math.round(timeoutMs / 1000)} seconds; last status=${lastStatus}.`);
}

async function cleanupDocker(config, { volumes = false } = {}) {
  const resources = await dockerResources(config);
  const hasRuntimeResources = resources.containers.length || resources.networks.length;
  const hasVolumeResources = volumes && resources.volumes.length;
  if (!hasRuntimeResources && !hasVolumeResources) return resources;

  if (existsSync(config.composeFile)) {
    const args = ["down"];
    if (volumes) args.push("-v");
    args.push("--remove-orphans");
    await compose(config, args);
  } else {
    if (resources.containers.length) await run("docker", ["rm", "-f", ...resources.containers]);
    if (resources.networks.length) await run("docker", ["network", "rm", ...resources.networks]);
    if (volumes && resources.volumes.length) await run("docker", ["volume", "rm", ...resources.volumes]);
  }

  const remaining = await dockerResources(config);
  if (remaining.containers.length || remaining.networks.length || (volumes && remaining.volumes.length)) {
    throw new Error(`Docker cleanup left owned resources behind; state preserved for retry: ${JSON.stringify(remaining)}`);
  }
  return remaining;
}

async function removeOwnedState(config, ownership) {
  if (!existsSync(config.stateRoot)) return;
  const knownEntries = new Set([
    ownershipFileName,
    processFileName,
    "compose.yml",
    "config.json",
    "supervisor.pid",
    "build-marker.json",
    "secrets",
    "bin",
    "vendor",
    "providers",
    "workspaces",
    "memory",
    "memory-graph",
    "artifacts",
    "projects",
    "diagnostics",
    "opencode-chat",
    "run"
  ]);
  const entries = await readdir(config.stateRoot);
  const unknownEntries = entries.filter((entry) => !knownEntries.has(entry));
  for (const entry of entries) {
    if (entry === ownershipFileName || unknownEntries.includes(entry)) continue;
    await rm(join(config.stateRoot, entry), { recursive: true, force: true });
  }
  await rm(join(config.stateRoot, ownershipFileName), { force: false });
  if (ownership.createdStateRoot && unknownEntries.length === 0) {
    await rm(config.stateRoot, { recursive: false, force: false });
  }
  if (unknownEntries.length) {
    console.warn(`[dev:stack] Preserved unrecognized entries in ${config.stateRoot}: ${unknownEntries.join(", ")}`);
  }
}

export async function down(config) {
  const ownership = await assertOwnedState(config, { allowMissing: true });
  if (ownership) {
    const pid = await ownedSupervisorPid(config);
    if (pid && pid !== process.pid) {
      process.kill(pid, "SIGTERM");
      await waitSupervisorExit(pid);
    }
    await stopRecordedProcesses(config);
  }
  await cleanupDocker(config, { volumes: false });
}

export async function reset(config) {
  const ownership = await assertOwnedState(config, { allowMissing: true });
  await down(config);
  await cleanupDocker(config, { volumes: true });
  const remaining = await dockerResources(config);
  if (remaining.containers.length || remaining.volumes.length || remaining.networks.length) {
    throw new Error(`Reset left owned Docker resources behind; state preserved for retry: ${JSON.stringify(remaining)}`);
  }

  if (ownership) {
    const tmpSocketRoot = dirname(config.socketPath);
    if (!tmpSocketRoot.startsWith(config.stateRoot) && tmpSocketRoot.includes(`spaceapp-dev-${config.rootHash}`)) {
      await rm(tmpSocketRoot, { recursive: true, force: true });
    }
    await assertOwnedState(config);
    await removeOwnedState(config, ownership);
  }
  console.log("[dev:stack] Reset complete; owned containers, volumes and state were removed.");
}

export async function status(config) {
  const ownership = await assertOwnedState(config, { allowMissing: true });
  const pid = ownership ? await ownedSupervisorPid(config, { strict: false }) : null;
  const resources = await dockerResources(config);
  const payload = {
    running: Boolean(pid),
    supervisorPid: pid,
    project: config.project,
    stateRoot: config.stateRoot,
    ports: config.ports,
    docker: resources
  };
  console.log(JSON.stringify(payload, null, 2));
  return payload;
}

export async function rebuild(config) {
  await assertOwnedState(config);
  const pid = await ownedSupervisorPid(config);
  if (!pid) {
    await ensureBuild(config, true);
    console.log("[dev:stack] Rebuilt source workspaces; no running supervisor to restart.");
    return;
  }
  process.kill(pid, "SIGHUP");
  console.log(`[dev:stack] Rebuild requested from supervisor ${pid}.`);
}

export async function start(config) {
  const composeTemplate = await readFile(resolve(config.root, "packages/run-spaceapp/templates/compose.yml"), "utf8");
  const dockerfile = await readFile(resolve(config.root, "Dockerfile"), "utf8");
  const images = parsePinnedImages(composeTemplate);
  const openCodeVersion = parseOpenCodeVersion(dockerfile);

  await run("docker", ["compose", "version"]);
  await claimStateOwnership(config);
  await claimSupervisor(config);

  let children = new Map();
  let processRecords = new Map();
  let stopping = false;
  let reloadChain = Promise.resolve();
  let databaseUrl;
  let sessionSecret;
  let postgresPassword;

  const stopChildren = async () => {
    const current = [...children.values()];
    children = new Map();
    for (const child of current) terminateTree(child);
    await Promise.all(current.map((child) => waitDead(child)));
    processRecords = new Map();
    await writeManagedProcessRecords(config, []);
    try { await rm(config.socketPath, { force: true }); } catch {}
  };

  const shutdown = async (reason) => {
    if (stopping) return;
    stopping = true;
    console.log(`[dev:stack] Stopping (${reason})...`);
    try {
      await stopChildren();
      if (existsSync(config.composeFile)) await compose(config, ["down", "--remove-orphans"], { allowFailure: true });
    } finally {
      await releaseSupervisor(config);
    }
  };

  const unexpectedExit = (name, child, code, signal) => {
    if (stopping || child !== children.get(name)) return;
    console.error(`[dev:stack] ${name} exited unexpectedly (${code ?? signal}); stopping the stack.`);
    process.exitCode = 1;
    void shutdown("child-failure").finally(() => process.exit(1));
  };

  const spawnManaged = async (name, command, args, env) => {
    const child = spawnService(config, name, command, args, env, unexpectedExit);
    children.set(name, child);
    const record = await identifyManagedChild(config, name, child);
    processRecords.set(name, record);
    await writeManagedProcessRecords(config, [...processRecords.values()]);
  };

  const spawnChildren = async (forceBuild = false) => {
    await ensureBuild(config, forceBuild);
    const repairedHelpers = await ensureDarwinNodePtySpawnHelpers(config.root);
    if (repairedHelpers.length) {
      console.log(`[dev:stack] Repaired execute permission on ${repairedHelpers.length} node-pty macOS spawn helper(s).`);
    }
    const openCodeWrapper = await installOpenCode(config, openCodeVersion);
    const env = sourceEnv(config, databaseUrl, sessionSecret, openCodeWrapper);
    await spawnManaged("cli-host", process.execPath, ["packages/cli-host/dist/main.js"], env);
    await spawnManaged("worker", process.execPath, ["apps/worker/dist/worker.js"], env);
    await spawnManaged("api", "npm", ["exec", "--", "tsx", "watch", "apps/api/src/server.ts"], env);
    await spawnManaged("web", "npm", ["run", "dev", "-w", "@space/web", "--", "--host", "127.0.0.1", "--port", String(config.ports.web)], env);
  };

  const reload = () => {
    reloadChain = reloadChain.then(async () => {
      if (stopping) return;
      console.log("[dev:stack] Rebuilding workspaces and restarting source services...");
      await stopChildren();
      if (stopping) return;
      await spawnChildren(true);
      if (stopping) {
        await stopChildren();
        return;
      }
      await waitReady(config);
      console.log("[dev:stack] Rebuild complete; source services are ready.");
    }).catch((error) => {
      console.error(`[dev:stack] rebuild failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
      void shutdown("rebuild-failure").finally(() => process.exit(1));
    });
  };

  process.once("SIGINT", () => { void shutdown("SIGINT").finally(() => process.exit(process.exitCode || 0)); });
  process.once("SIGTERM", () => { void shutdown("SIGTERM").finally(() => process.exit(process.exitCode || 0)); });
  process.on("SIGHUP", reload);

  try {
    await stopRecordedProcesses(config);
    ({ databaseUrl, sessionSecret, postgresPassword } = await prepareState(config));
    await mkdir(dirname(config.composeFile), { recursive: true, mode: 0o700 });
    await writeFile(config.composeFile, renderCompose(config, images), { mode: 0o600 });
    await writeFile(config.configFile, `${JSON.stringify({
      root: config.root,
      stateRoot: config.stateRoot,
      project: config.project,
      ports: config.ports,
      socketPath: config.socketPath,
      openCodeVersion
    }, null, 2)}\n`, { mode: 0o600 });

    console.log(`[dev:stack] Starting digest-pinned PostgreSQL and Temporal (${config.project})...`);
    await compose(config, ["up", "-d", "postgres", "temporal"], {
      env: { ...process.env, SPACEAPP_DEV_POSTGRES_PASSWORD: postgresPassword }
    });
    await Promise.all([
      waitHealthy(config, "postgres"),
      waitServiceHealthyWithDiagnostics(config, "temporal", 240_000)
    ]);
    await ensureTemporalNamespace(config);
    await ensureBuild(config);
    console.log("[dev:stack] Applying database migrations...");
    await run("npm", ["run", "db:migrate"], { cwd: config.root, env: { ...process.env, SPACE_DATABASE_URL: databaseUrl } });
    await spawnChildren(false);
    await waitReady(config);
    const setupToken = (await readFile(resolve(config.secretsDir, "setup-token"), "utf8")).trim();
    console.log("\n============================================================");
    console.log("SpaceApp dev stack is READY");
    console.log(`Web:   http://127.0.0.1:${config.ports.web}`);
    console.log(`API:   http://127.0.0.1:${config.ports.api}`);
    console.log(`Owner setup token: ${setupToken}`);
    console.log("Package changes: npm run dev:stack -- rebuild");
    console.log("Stop: npm run dev:stack -- down | Reset: npm run dev:stack -- reset");
    console.log("============================================================\n");
    await new Promise(() => {});
  } catch (error) {
    process.exitCode = 1;
    await shutdown("startup-failure");
    throw error;
  }
}

async function main() {
  const command = process.argv[2] || "up";
  assertSafeDevStackOverrides();
  const config = await resolveConfig();
  if (["up", "start"].includes(command)) return start(config);
  if (["down", "stop"].includes(command)) return down(config);
  if (command === "reset") return reset(config);
  if (command === "status") return status(config);
  if (command === "rebuild") return rebuild(config);
  throw new Error(`Unknown dev:stack command ${JSON.stringify(command)}. Use up, down, reset, status, or rebuild.`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`[dev:stack] ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
