#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const targetFiles = Object.freeze({
  core: [
    "apps/api/dist/server.js",
    "apps/worker/dist/worker.js",
    "apps/web/server.mjs",
    "packages/db/dist/migrate.js"
  ],
  browser: ["apps/api/dist/browser-host-main.js", "packages/db/dist/migrate.js"],
  cli: ["packages/cli-host/dist/main.js"]
});

function option(args, key) {
  const index = args.indexOf(key);
  return index === -1 ? undefined : args[index + 1];
}

export function createContainerRuntimeSmokeScript(target) {
  if (!targetFiles[target]) throw new Error(`Unknown container target: ${target}`);
  const files = JSON.stringify(targetFiles[target]);
  const targetChecks = {
    core: "if (fs.existsSync('/app/node_modules/node-pty')) throw Error('core image contains node-pty');",
    browser: "if (!fs.existsSync('/usr/bin/chromium')) throw Error('browser image is missing Chromium');",
    cli: "const require = createRequire(import.meta.url); require('node-pty'); const socketPath = `/tmp/spaceapp-cli-smoke-${process.pid}.sock`; const host = cp.spawn(process.execPath, ['/app/packages/cli-host/dist/main.js'], {env: {...process.env, SPACE_CLI_HOST_SOCKET: socketPath}, stdio:'ignore'}); let socket; try { let response; const requestId = cryptoRandomUUID(); for (let attempt=0; attempt<20; attempt++) { try { response = await new Promise((resolve, reject) => { socket = netCreateConnection(socketPath); const chunks = []; let timer = setTimeout(() => reject(Error('CLI host ping timed out')), 250); socket.once('error', reject); socket.once('connect', () => { const payload = Buffer.from(JSON.stringify({kind:'request', requestId, method:'ping', params:{}})); const frame = Buffer.allocUnsafe(4 + payload.length); frame.writeUInt32BE(payload.length, 0); payload.copy(frame, 4); socket.write(frame); }); socket.on('data', chunk => { const bytes = Buffer.concat([...chunks, chunk]); chunks.push(chunk); if (bytes.length < 4) return; const length = bytes.readUInt32BE(0); if (bytes.length < 4 + length) return; clearTimeout(timer); try { resolve(JSON.parse(bytes.subarray(4, 4 + length).toString('utf8'))); } catch (error) { reject(error); } }); }); if (response?.kind === 'response' && response.requestId === requestId && response.ok === true && response.result?.ok === true) break; } catch { socket?.destroy(); socket = undefined; if (host.exitCode !== null || host.signalCode !== null) break; await new Promise(resolve => setTimeout(resolve, 100)); } } if (response?.kind !== 'response' || response.requestId !== requestId || response.ok !== true || response.result?.ok !== true) throw Error('CLI host ping failed'); } finally { socket?.destroy(); if (host.exitCode === null && host.signalCode === null) { const exited = new Promise(resolve => host.once('exit', resolve)); host.kill('SIGTERM'); await Promise.race([exited, new Promise(resolve => setTimeout(() => { host.kill('SIGKILL'); resolve(); }, 1000))]); } }"
  }[target];
  const script = [
    "import fs from 'node:fs';",
    "import cp from 'node:child_process';",
    "import path from 'node:path';",
    "import {fileURLToPath, pathToFileURL} from 'node:url';",
    "import {createRequire} from 'node:module';",
    "import {createConnection as netCreateConnection} from 'node:net';",
    "import {randomUUID as cryptoRandomUUID} from 'node:crypto';",
    "const manifest = JSON.parse(fs.readFileSync('/app/container-runtime-manifest.json', 'utf8')); if (manifest.target !== " + JSON.stringify(target) + ") throw Error('runtime manifest target mismatch'); for (const stagedPath of manifest.stagedPaths) if (!fs.existsSync('/app/' + stagedPath)) throw Error('missing staged runtime path: ' + stagedPath);",
    "const edgeGroups = new Map(); for (const edge of manifest.resolutionEdges) { if (edge.builtin || edge.omitted) continue; const key = JSON.stringify([path.dirname(edge.from), edge.mode ?? 'import']); const group = edgeGroups.get(key) ?? new Set(); group.add(edge.specifier); edgeGroups.set(key, group); } const probes = []; try { let index = 0; for (const [key, specifiers] of edgeGroups) { const [directory, mode] = JSON.parse(key); const probe = path.join('/app', directory, `.spaceapp-resolution-${process.pid}-${index++}.mjs`); const source = `import fs from 'node:fs'; import {createRequire} from 'node:module'; import {fileURLToPath} from 'node:url'; const require = createRequire(import.meta.url); for (const specifier of ${JSON.stringify([...specifiers])}) { const resolved = ${mode === 'require' ? 'require.resolve(specifier)' : 'import.meta.resolve(specifier)'}; const resolvedPath = resolved.startsWith('file:') ? fileURLToPath(resolved) : resolved; if ((resolved.startsWith('file:') || !resolved.includes(':')) && !fs.existsSync(resolvedPath)) throw Error('unresolved runtime import: ' + specifier + ' from ' + import.meta.url); }`; fs.writeFileSync(probe, source); probes.push(probe); } for (const probe of probes) await import(pathToFileURL(probe).href); } finally { for (const probe of probes) fs.rmSync(probe, {force:true}); }",
    `for (const file of ${files}) { if (!fs.existsSync('/app/' + file)) throw Error('missing runtime entrypoint: ' + file); const result = cp.spawnSync(process.execPath, ['--check', '/app/' + file], {encoding:'utf8'}); if (result.status !== 0) throw Error(result.stderr); }`,
    targetChecks,
    "process.stdout.write('runtime entrypoints and target smoke passed\\n');"
  ].join("\n");
  return script;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const postgresImage = "pgvector/pgvector:0.8.3-pg17-trixie@sha256:3a3147ccd9a0aee952bb69e1acea1eb3cc7183544185b87a662f872cfa47ae3b";
const runLabel = "com.spaceapp.container-runtime-smoke.run";
const commandTimeoutMs = 30_000;
const databaseStartupTimeoutMs = 90_000;
const migrationTimeoutMs = 120_000;
const serviceStartupTimeoutMs = 120_000;

function capture(stream, state, limit = 128 * 1024) {
  stream.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    const remaining = limit - state.size;
    if (remaining <= 0) return;
    const kept = text.slice(0, remaining);
    state.parts.push(kept);
    state.size += kept.length;
  });
}

/** Run one process with an explicit deadline and bounded output capture. */
export function createProcessRunner(spawnProcess = spawn) {
  return (command, args, options = {}) => new Promise((resolvePromise, rejectPromise) => {
    const timeoutMs = options.timeoutMs ?? commandTimeoutMs;
    const stdout = { parts: [], size: 0 };
    const stderr = { parts: [], size: 0 };
    let timedOut = false;
    let forceKillTimer;
    let child;
    try {
      child = spawnProcess(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      rejectPromise(error);
      return;
    }
    capture(child.stdout, stdout);
    capture(child.stderr, stderr);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
      forceKillTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.once("error", (error) => {
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      rejectPromise(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      resolvePromise({
        code: timedOut ? null : code,
        signal,
        timedOut,
        stdout: stdout.parts.join(""),
        stderr: stderr.parts.join("")
      });
    });
  });
}

function commandError(args, result) {
  const command = ["docker", ...args].join(" ");
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  return new Error(`${result.timedOut ? "Timed out" : `Command failed (${result.code})`}: ${command}${output ? `\n${output}` : ""}`);
}

function inspectionConfirmsMissing(result) {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return /no such (?:object|container|network)|(?:container|network) .+ not found/i.test(output);
}

function dbHealthCommand(name) {
  return ["container", "inspect", "--format", "{{.State.Health.Status}}", name];
}

function containerStateCommand(name) {
  return ["container", "inspect", "--format", "{{.State.Running}}", name];
}

function containerExitCodeCommand(name) {
  return ["container", "inspect", "--format", "{{.State.ExitCode}}", name];
}

function containerRunLabelCommand(name) {
  return ["container", "inspect", "--format", `{{index .Config.Labels "${runLabel}"}}`, name];
}

function networkRunLabelCommand(name) {
  return ["network", "inspect", "--format", `{{index .Labels "${runLabel}"}}`, name];
}

function readonlyBind(source, target) {
  return `type=bind,source=${source},target=${target},readonly`;
}

function secretMounts(tempDirectory) {
  return [
    ["database-url", "/run/secrets/database-url"],
    ["session-secret", "/run/secrets/session-secret"],
    ["setup-token", "/run/secrets/setup-token"]
  ].flatMap(([file, target]) => ["--mount", readonlyBind(join(tempDirectory, file), target)]);
}

function coreReadinessProbe() {
  return "try { const response = await fetch('http://127.0.0.1:4911/readyz', {signal: AbortSignal.timeout(3000)}); const body = await response.json(); process.stdout.write(JSON.stringify({status: response.status, body}) + '\\n'); if (!response.ok || body.ok !== true) process.exitCode = 2; } catch (error) { process.stderr.write(String(error) + '\\n'); process.exitCode = 3; }";
}

function browserHostHealthProbe() {
  return "import {BrowserHostClient} from 'file:///app/packages/browser-host/dist/client.js'; const client = new BrowserHostClient({socketPath: process.env.SPACE_BROWSER_HOST_SOCKET, requestTimeoutMs: 3000, healthTimeoutMs: 3000, connectTimeoutMs: 1000}); try { const health = await client.health(); if (!Number.isSafeInteger(health?.hostPid) || health.hostPid <= 0) throw Error('Browser Host returned invalid health'); if (health.status?.enabled !== true) throw Error('Browser Host is not ready: ' + (health.status?.statusReason ?? 'session manager is disabled')); process.stdout.write(JSON.stringify({hostPid: health.hostPid, startedAt: health.startedAt, status: health.status}) + '\\n'); } finally { await client.close(); }";
}

async function runContainerRuntimeSmoke(args = process.argv.slice(2), dependencies = {}) {
  const target = option(args, "--target");
  const image = option(args, "--image");
  if (!targetFiles[target] || !image) {
    throw new Error("Usage: container-runtime-smoke.mjs --target <core|browser|cli> --image <name:tag>");
  }
  const runner = dependencies.runner ?? createProcessRunner();
  const sleep = dependencies.sleep ?? ((delay) => new Promise((resolvePromise) => setTimeout(resolvePromise, delay)));
  const now = dependencies.now ?? Date.now;
  const root = dependencies.repoRoot ?? repoRoot;
  const runId = dependencies.runId ?? randomUUID();
  const namePrefix = `spaceapp-smoke-${target}-${runId}`;
  const networkName = `${namePrefix}-network`;
  const databaseName = `${namePrefix}-postgres`;
  const serviceName = `${namePrefix}-service`;
  const migrationName = `${namePrefix}-migrations`;
  const runtimeProbeName = `${namePrefix}-probe`;
  let temporaryDirectory = dependencies.temporaryDirectory;
  const resources = {
    network: { name: networkName, type: "network" },
    containers: []
  };
  let networkCreationAttempted = false;
  let primaryError;
  const cleanupErrors = [];
  let smokeResult;

  const invoke = async (dockerArgs, { timeoutMs = commandTimeoutMs, allowFailure = false } = {}) => {
    const result = await runner("docker", dockerArgs, { timeoutMs });
    if (result.timedOut || (result.code !== 0 && !allowFailure)) throw commandError(dockerArgs, result);
    return result;
  };
  const poll = async ({ description, timeoutMs, intervalMs = 500, probe, ready, alive, onTimeout }) => {
    const deadline = now() + timeoutMs;
    let last;
    while (now() < deadline) {
      if (alive) {
        const aliveState = await alive();
        if (!aliveState) throw new Error(`${description}: target exited before becoming ready.`);
      }
      try {
        last = await probe();
        if (ready(last)) return last;
      } catch (error) {
        last = error;
      }
      await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
    }
    const logs = onTimeout ? await onTimeout().catch(() => "") : "";
    const detail = last instanceof Error ? last.message : JSON.stringify(last);
    throw new Error(`${description} timed out${detail ? `; last result: ${detail}` : ""}${logs ? `\n${logs}` : ""}`);
  };
  const inspectAlive = async (name) => {
    const result = await invoke(containerStateCommand(name), { allowFailure: true });
    return result.code === 0 && result.stdout.trim() === "true";
  };
  const getLogs = async (name) => {
    const result = await invoke(["container", "logs", "--tail", "80", name], { timeoutMs: 10_000, allowFailure: true });
    return [result.stdout, result.stderr].filter(Boolean).join("\n").slice(-16_000);
  };
  const startDetachedContainer = async (name, args) => {
    resources.containers.push({ name, type: "container" });
    const result = await invoke(["run", "--detach", "--name", name, "--label", `${runLabel}=${runId}`, ...args]);
    if (!result.stdout.trim()) throw new Error(`Docker did not return an ID for ${name}.`);
    return result.stdout.trim();
  };
  const waitForContainerExit = async (name, timeoutMs, description) => {
    await poll({
      description,
      timeoutMs,
      probe: async () => {
        const status = await invoke(["container", "inspect", "--format", "{{.State.Status}}", name]);
        return status.stdout.trim();
      },
      ready: (status) => status === "exited",
      onTimeout: () => getLogs(name)
    });
    const exit = await invoke(containerExitCodeCommand(name));
    if (exit.stdout.trim() !== "0") throw new Error(`${description} failed with exit code ${exit.stdout.trim()}.\n${await getLogs(name)}`);
  };

  const logsByName = async () => {
    const logs = [];
    for (const { name } of resources.containers) logs.push(`${name}:\n${await getLogs(name)}`);
    return logs.filter((item) => !item.endsWith("\n")).join("\n");
  };

  try {
    if (target === "cli") {
      const runtimeProbe = createContainerRuntimeSmokeScript(target);
      await startDetachedContainer(runtimeProbeName, ["--entrypoint", "node", image, "--input-type=module", "-e", runtimeProbe]);
      await waitForContainerExit(runtimeProbeName, serviceStartupTimeoutMs, "CLI socket ping smoke");
      smokeResult = { target, result: "CLI socket ping passed; no native PTY was spawned." };
    } else {
      networkCreationAttempted = true;
      await invoke(["network", "create", "--label", `${runLabel}=${runId}`, networkName]);
      await startDetachedContainer(databaseName, [
        "--network", networkName,
        "--network-alias", "postgres",
        "--env", "POSTGRES_DB=spaceapp",
        "--env", "POSTGRES_USER=spaceapp",
        "--env", `POSTGRES_PASSWORD=smoke-${runId}`,
        "--health-cmd", "pg_isready -U spaceapp -d spaceapp",
        "--health-interval", "1s",
        "--health-timeout", "3s",
        "--health-retries", "90",
        postgresImage
      ]);
      await poll({
        description: "pgvector PostgreSQL service startup",
        timeoutMs: databaseStartupTimeoutMs,
        probe: async () => (await invoke(dbHealthCommand(databaseName), { allowFailure: true })).stdout.trim(),
        ready: (status) => status === "healthy",
        alive: () => inspectAlive(databaseName),
        onTimeout: () => getLogs(databaseName)
      });

      temporaryDirectory ??= await mkdtemp(join(tmpdir(), `${namePrefix}-`));

      const databasePassword = `smoke-${runId}`;
      const databaseUrl = `postgres://spaceapp:${encodeURIComponent(databasePassword)}@postgres:5432/spaceapp`;
      await writeFile(join(temporaryDirectory, "database-url"), databaseUrl, { mode: 0o400 });
      await writeFile(join(temporaryDirectory, "session-secret"), randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""), { mode: 0o400 });
      await writeFile(join(temporaryDirectory, "setup-token"), randomUUID().replaceAll("-", ""), { mode: 0o400 });

      const runtimeProbe = createContainerRuntimeSmokeScript(target);
      await startDetachedContainer(runtimeProbeName, ["--network", networkName, "--entrypoint", "node", image, "--input-type=module", "-e", runtimeProbe]);
      await waitForContainerExit(runtimeProbeName, serviceStartupTimeoutMs, `${target} runtime resolution smoke`);

      if (target === "core") {
        await startDetachedContainer(serviceName, [
          "--network", networkName,
          ...secretMounts(temporaryDirectory),
          "--env", "SPACE_PUBLIC_DISTRIBUTION=true",
          "--env", "SPACE_RUNTIME_STORE=postgres",
          "--env", "SPACEAPP_WORKFLOWS_ENABLED=false",
          "--env", "SPACE_CLI_ENABLED=false",
          "--env", "SPACE_CLI_ROOT_ENABLED=false",
          "--env", "SPACE_BROWSER_SESSIONS_ENABLED=false",
          "--env", "SPACE_API_HOST=127.0.0.1",
          "--env", "SPACE_API_PORT=4910",
          "--env", "SPACE_API_ORIGIN=http://127.0.0.1:4910",
          "--env", "SPACE_WEB_HOST=0.0.0.0",
          "--env", "SPACE_WEB_PORT=4911",
          "--env", "SPACE_BROWSER_HOST_TRANSPORT=unix",
          image
        ]);
        await poll({
          description: "core startup, migrations, and /readyz",
          timeoutMs: serviceStartupTimeoutMs,
          intervalMs: 1_000,
          probe: async () => {
            const result = await invoke(["exec", "--user", "10001:10001", serviceName, "node", "--input-type=module", "-e", coreReadinessProbe()], { timeoutMs: 5_000, allowFailure: true });
            if (result.code !== 0) return { ready: false, output: result.stderr || result.stdout };
            const response = JSON.parse(result.stdout.trim().split("\n").at(-1));
            return { ready: response.status === 200 && response.body?.ok === true, response };
          },
          ready: (result) => result.ready,
          alive: () => inspectAlive(serviceName),
          onTimeout: () => getLogs(serviceName)
        });
        smokeResult = { target, result: "core entrypoint started, migrations ran, and /readyz returned ok:true." };
      }

      if (target === "browser") {
        const migrations = join(root, "packages/db/migrations");
        await startDetachedContainer(migrationName, [
          "--network", networkName,
          "--mount", readonlyBind(migrations, "/app/packages/db/migrations"),
          "--env", `SPACE_DATABASE_URL=${databaseUrl}`,
          "--entrypoint", "node",
          image,
          "/app/packages/db/dist/migrate.js"
        ]);
        await waitForContainerExit(migrationName, migrationTimeoutMs, "Browser smoke database migrations");

        await startDetachedContainer(serviceName, [
          "--network", networkName,
          "--mount", readonlyBind(join(temporaryDirectory, "database-url"), "/run/secrets/database-url"),
          "--env", "SPACE_RUNTIME_STORE=postgres",
          "--env", "SPACE_DATABASE_URL_FILE=/run/secrets/database-url",
          "--env", "SPACE_BROWSER_SESSIONS_ENABLED=true",
          "--env", "SPACE_BROWSER_HOST_SOCKET=/run/spaceapp-browser/browser-host.sock",
          "--env", "SPACE_BROWSER_SESSIONS_CHROME_PATH=/usr/bin/chromium",
          "--env", "SPACE_BROWSER_CHROME_PATH=/usr/bin/chromium",
          "--env", "SPACE_ARTIFACT_ROOT=/var/lib/spaceapp/artifacts",
          image
        ]);
        await poll({
          description: "Browser Host socket health",
          timeoutMs: serviceStartupTimeoutMs,
          intervalMs: 1_000,
          probe: async () => {
            const result = await invoke(["exec", "--user", "10001:10001", serviceName, "node", "--input-type=module", "-e", browserHostHealthProbe()], { timeoutMs: 5_000, allowFailure: true });
            if (result.code !== 0) return { ready: false, output: result.stderr || result.stdout };
            return { ready: true, output: result.stdout.trim() };
          },
          ready: (result) => result.ready,
          alive: () => inspectAlive(serviceName),
          onTimeout: () => getLogs(serviceName)
        });
        const chromium = await invoke([
          "exec", "--user", "10001:10001", serviceName,
          "/usr/bin/chromium", "--no-sandbox", "--headless", "--disable-dev-shm-usage",
          "--dump-dom", "data:text/html,spaceapp-browser-smoke"
        ], { timeoutMs: 25_000 });
        if (!chromium.stdout.includes("spaceapp-browser-smoke")) throw new Error("Chromium smoke did not render the expected DOM marker.");
        smokeResult = { target, result: "Browser Host socket health passed and Chromium rendered the smoke DOM." };
      }
      if (!smokeResult) throw new Error(`No runtime smoke implementation for target ${target}.`);
    }
  } catch (error) {
    primaryError = error;
    const logs = await logsByName().catch(() => "");
    if (logs) primaryError = new Error(`${error instanceof Error ? error.message : String(error)}\n${logs}`);
  } finally {
    const cleanupCommands = [];
    const inspectOwnership = async (resourceType, name, args) => {
      let ownership;
      try {
        ownership = await invoke(args, { timeoutMs: 5_000, allowFailure: true });
      } catch (error) {
        cleanupErrors.push(`Could not verify ownership of ${resourceType} ${name}; it was left untouched: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
      if (ownership.code !== 0) {
        if (inspectionConfirmsMissing(ownership)) return false;
        cleanupErrors.push(`Could not verify ownership of ${resourceType} ${name}; it was left untouched: ${[ownership.stdout, ownership.stderr].filter(Boolean).join("\n") || `inspect exited ${ownership.code}`}`);
        return false;
      }
      const actualRunId = ownership.stdout.trim();
      if (actualRunId !== runId) {
        cleanupErrors.push(`Ownership of ${resourceType} ${name} is unknown (label ${runLabel}=${actualRunId || "<empty>"}); it was left untouched.`);
        return false;
      }
      return true;
    };
    for (const { name } of [...resources.containers].reverse()) {
      if (await inspectOwnership("container", name, containerRunLabelCommand(name))) cleanupCommands.push(["container", "rm", "--force", name]);
    }
    if (networkCreationAttempted && await inspectOwnership("network", networkName, networkRunLabelCommand(networkName))) {
      cleanupCommands.push(["network", "rm", networkName]);
    }
    for (const cleanup of cleanupCommands) {
      const result = await invoke(cleanup, { timeoutMs: 10_000, allowFailure: true }).catch((error) => ({ code: 1, stdout: "", stderr: String(error) }));
      if (result.code !== 0) cleanupErrors.push(commandError(cleanup, result).message);
    }
    if (temporaryDirectory && !dependencies.temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }).catch((error) => cleanupErrors.push(`Could not remove temporary secret directory ${temporaryDirectory}: ${error instanceof Error ? error.message : String(error)}`));
  }
  if (primaryError && cleanupErrors.length > 0) throw new Error(`${primaryError instanceof Error ? primaryError.message : String(primaryError)}\nCleanup failed:\n${cleanupErrors.join("\n")}`, { cause: primaryError });
  if (primaryError) throw primaryError;
  if (cleanupErrors.length > 0) throw new Error(`Cleanup failed:\n${cleanupErrors.join("\n")}`);
  if (smokeResult) return smokeResult;
  throw new Error("Smoke orchestration ended without a result.");
}

export { runContainerRuntimeSmoke };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runContainerRuntimeSmoke();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
