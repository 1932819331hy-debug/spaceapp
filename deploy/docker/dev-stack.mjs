#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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
  assertSafeDevStackOverrides,
  claimSupervisor,
  ownedSupervisorPid,
  releaseSupervisor
} from "./dev-stack-safety.mjs";

const scriptPath = fileURLToPath(import.meta.url);

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

function terminateTree(child, signal = "SIGTERM") {
  if (!child || child.exitCode != null) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function waitDead(child, timeoutMs = 7000) {
  if (!child || child.exitCode != null) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && child.exitCode == null) await sleep(100);
  if (child.exitCode == null) terminateTree(child, "SIGKILL");
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

export async function down(config) {
  const pid = await ownedSupervisorPid(config);
  if (pid && pid !== process.pid) {
    process.kill(pid, "SIGTERM");
    await waitSupervisorExit(pid);
  }
  if (existsSync(config.composeFile)) await compose(config, ["down", "--remove-orphans"]);
}

export async function reset(config) {
  await down(config);
  if (existsSync(config.composeFile)) await compose(config, ["down", "-v", "--remove-orphans"]);
  const remaining = await dockerResources(config);
  if (remaining.containers.length || remaining.volumes.length) {
    throw new Error(`Reset left owned Docker resources behind; state preserved for retry: ${JSON.stringify(remaining)}`);
  }
  await rm(config.stateRoot, { recursive: true, force: true });
  const tmpSocketRoot = dirname(config.socketPath);
  if (!tmpSocketRoot.startsWith(config.stateRoot) && tmpSocketRoot.includes(`spaceapp-dev-${config.rootHash}`)) {
    await rm(tmpSocketRoot, { recursive: true, force: true });
  }
  console.log("[dev:stack] Reset complete; owned containers, volumes and state were removed.");
}

export async function status(config) {
  const pid = await ownedSupervisorPid(config, { strict: false });
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
  const { databaseUrl, sessionSecret, postgresPassword } = await prepareState(config);
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

  await run("docker", ["compose", "version"]);
  await claimSupervisor(config);
  let children = new Map();
  let stopping = false;
  let reloadChain = Promise.resolve();

  const stopChildren = async () => {
    for (const child of children.values()) terminateTree(child);
    await Promise.all([...children.values()].map((child) => waitDead(child)));
    children = new Map();
    try { await rm(config.socketPath, { force: true }); } catch {}
  };

  const shutdown = async (reason) => {
    if (stopping) return;
    stopping = true;
    console.log(`[dev:stack] Stopping (${reason})...`);
    await stopChildren();
    if (existsSync(config.composeFile)) await compose(config, ["down", "--remove-orphans"], { allowFailure: true });
    await releaseSupervisor(config);
  };

  const unexpectedExit = (name, child, code, signal) => {
    if (stopping || child !== children.get(name)) return;
    console.error(`[dev:stack] ${name} exited unexpectedly (${code ?? signal}); stopping the stack.`);
    process.exitCode = 1;
    void shutdown("child-failure").finally(() => process.exit(1));
  };

  const spawnChildren = async (forceBuild = false) => {
    await ensureBuild(config, forceBuild);
    const openCodeWrapper = await installOpenCode(config, openCodeVersion);
    const env = sourceEnv(config, databaseUrl, sessionSecret, openCodeWrapper);
    children.set("cli-host", spawnService(config, "cli-host", process.execPath, ["packages/cli-host/dist/main.js"], env, unexpectedExit));
    children.set("worker", spawnService(config, "worker", process.execPath, ["apps/worker/dist/worker.js"], env, unexpectedExit));
    children.set("api", spawnService(config, "api", "npm", ["exec", "--", "tsx", "watch", "apps/api/src/server.ts"], env, unexpectedExit));
    children.set("web", spawnService(config, "web", "npm", ["run", "dev", "-w", "@space/web", "--", "--host", "127.0.0.1", "--port", String(config.ports.web)], env, unexpectedExit));
  };

  const reload = () => {
    reloadChain = reloadChain.then(async () => {
      if (stopping) return;
      console.log("[dev:stack] Rebuilding workspaces and restarting source services...");
      await stopChildren();
      await spawnChildren(true);
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
