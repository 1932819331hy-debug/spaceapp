#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
export const repoRoot = resolve(dirname(scriptPath), "..");
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function parsePort(raw, fallback, name) {
  const value = raw == null || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error(`${name} must be an integer port between 1024 and 65535.`);
  }
  return value;
}

function assertDistinctPorts(ports) {
  const values = Object.entries(ports);
  const seen = new Map();
  for (const [name, value] of values) {
    if (seen.has(value)) throw new Error(`${name} conflicts with ${seen.get(value)} on port ${value}.`);
    seen.set(value, name);
  }
  for (const [name, value] of [["api", ports.api], ["web", ports.web]]) {
    if (value === 4910 || value === 4911) {
      throw new Error(`${name} port ${value} is reserved for an installed SpaceApp; choose another dev port.`);
    }
  }
}

function inside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export async function assertSafeStateRoot(stateRoot, root = repoRoot) {
  const resolvedState = resolve(stateRoot);
  const resolvedRoot = resolve(root);
  const resolvedHome = resolve(homedir());
  if (resolvedState === resolve(sep) || resolvedState === resolvedRoot || resolvedState === resolvedHome) {
    throw new Error(`Unsafe dev-stack state directory: ${resolvedState}`);
  }
  if (inside(resolvedState, resolvedRoot) && resolvedState !== resolvedRoot) {
    throw new Error("The dev-stack state directory may not be an ancestor of the repository.");
  }
  if (existsSync(resolvedState)) {
    const info = await lstat(resolvedState);
    if (info.isSymbolicLink()) throw new Error("The dev-stack state directory may not be a symlink.");
  }
  return resolvedState;
}

export function parsePinnedImages(composeText) {
  const postgres = composeText.match(/image:\s*(pgvector\/pgvector:[^\s]+@sha256:[a-f0-9]{64})/i)?.[1];
  const temporal = composeText.match(/image:\s*(temporalio\/auto-setup:[^\s]+@sha256:[a-f0-9]{64})/i)?.[1];
  if (!postgres || !temporal) throw new Error("Could not read digest-pinned PostgreSQL and Temporal images from the launcher Compose template.");
  return { postgres, temporal };
}

export function parseOpenCodeVersion(dockerfileText) {
  const version = dockerfileText.match(/opencode-ai@([0-9]+\.[0-9]+\.[0-9]+)/)?.[1];
  if (!version) throw new Error("Could not read the pinned opencode-ai version from Dockerfile.");
  return version;
}

export async function resolveDevStackConfig(env = process.env, root = repoRoot) {
  const rootHash = createHash("sha256").update(await realpath(root)).digest("hex").slice(0, 10);
  const stateRoot = await assertSafeStateRoot(env.SPACE_DEV_STACK_DIR || join(root, ".dev-stack"), root);
  const ports = {
    api: parsePort(env.SPACE_DEV_API_PORT, 5910, "SPACE_DEV_API_PORT"),
    web: parsePort(env.SPACE_DEV_WEB_PORT, 5911, "SPACE_DEV_WEB_PORT"),
    postgres: parsePort(env.SPACE_DEV_POSTGRES_PORT, 55432, "SPACE_DEV_POSTGRES_PORT"),
    temporal: parsePort(env.SPACE_DEV_TEMPORAL_PORT, 57233, "SPACE_DEV_TEMPORAL_PORT")
  };
  assertDistinctPorts(ports);
  const project = env.SPACE_DEV_COMPOSE_PROJECT || `spaceapp-dev-${rootHash}`;
  if (!/^[a-z0-9][a-z0-9_-]{2,50}$/i.test(project)) throw new Error("SPACE_DEV_COMPOSE_PROJECT contains unsupported characters.");
  const preferredSocket = join(stateRoot, "run", "cli-host.sock");
  const socketPath = Buffer.byteLength(preferredSocket) <= 96
    ? preferredSocket
    : join(tmpdir(), `spaceapp-dev-${rootHash}`, "cli-host.sock");
  return {
    root,
    rootHash,
    stateRoot,
    project,
    ports,
    composeFile: join(stateRoot, "compose.yml"),
    configFile: join(stateRoot, "config.json"),
    pidFile: join(stateRoot, "supervisor.pid"),
    buildMarker: join(stateRoot, "build-marker.json"),
    secretsDir: join(stateRoot, "secrets"),
    socketPath,
    socketRoot: dirname(socketPath),
    binDir: join(stateRoot, "bin"),
    vendorDir: join(stateRoot, "vendor", "opencode"),
    providerRoot: join(stateRoot, "providers", "opencode"),
    workspacesRoot: join(stateRoot, "workspaces"),
    memoryRoot: join(stateRoot, "memory"),
    memoryGraphRoot: join(stateRoot, "memory-graph"),
    artifactRoot: join(stateRoot, "artifacts"),
    projectsRoot: join(stateRoot, "projects"),
    diagnosticsRoot: join(stateRoot, "diagnostics"),
    openCodeChatRoot: join(stateRoot, "opencode-chat")
  };
}

export function renderCompose(config, images) {
  return `services:\n  postgres:\n    image: ${images.postgres}\n    restart: unless-stopped\n    environment:\n      POSTGRES_DB: spaceapp_dev\n      POSTGRES_USER: spaceapp\n      POSTGRES_PASSWORD_FILE: /run/secrets/postgres-password\n    ports:\n      - \"127.0.0.1:${config.ports.postgres}:5432\"\n    secrets:\n      - postgres-password\n    volumes:\n      - postgres-data:/var/lib/postgresql/data\n    healthcheck:\n      test: [\"CMD-SHELL\", \"pg_isready -U spaceapp -d spaceapp_dev\"]\n      interval: 2s\n      timeout: 3s\n      retries: 30\n\n  temporal:\n    image: ${images.temporal}\n    restart: unless-stopped\n    depends_on:\n      postgres:\n        condition: service_healthy\n    environment:\n      DB: postgres12\n      DB_PORT: 5432\n      POSTGRES_USER: spaceapp\n      POSTGRES_SEEDS: postgres\n      DYNAMIC_CONFIG_FILE_PATH: config/dynamicconfig/docker.yaml\n    entrypoint: [\"/bin/sh\", \"-ec\"]\n    command:\n      - export POSTGRES_PWD=\"$$(cat /run/secrets/postgres-password)\"; exec /etc/temporal/entrypoint.sh autosetup\n    ports:\n      - \"127.0.0.1:${config.ports.temporal}:7233\"\n    secrets:\n      - postgres-password\n    healthcheck:\n      test: [\"CMD-SHELL\", \"temporal operator cluster health --address temporal:7233 >/dev/null && temporal operator namespace describe --namespace default --address temporal:7233 >/dev/null\"]\n      interval: 3s\n      timeout: 5s\n      retries: 40\n\nsecrets:\n  postgres-password:\n    file: ./secrets/postgres-password\n\nvolumes:\n  postgres-data:\n`;
}

async function run(command, args, options = {}) {
  const { capture = false, allowFailure = false, env = process.env, cwd = repoRoot } = options;
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    }
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      const result = { code: code ?? 1, signal, stdout: stdout.trim(), stderr: stderr.trim() };
      if (!allowFailure && code !== 0) {
        rejectPromise(new Error(`${command} ${args.join(" ")} failed (${code ?? signal}).${stderr ? `\n${stderr}` : ""}`));
      } else {
        resolvePromise(result);
      }
    });
  });
}

function composeArgs(config, ...args) {
  return ["compose", "-p", config.project, "-f", config.composeFile, ...args];
}

async function compose(config, args, options = {}) {
  return run("docker", composeArgs(config, ...args), options);
}

async function privateFile(path, value) {
  if (!existsSync(path)) await writeFile(path, `${value}\n`, { mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
}

async function prepareState(config) {
  for (const path of [
    config.stateRoot, config.secretsDir, config.socketRoot, config.binDir, config.vendorDir,
    config.providerRoot, config.workspacesRoot, config.memoryRoot, config.memoryGraphRoot,
    config.artifactRoot, config.projectsRoot, config.diagnosticsRoot, config.openCodeChatRoot
  ]) await mkdir(path, { recursive: true, mode: 0o700 });
  const postgresPassword = randomBytes(24).toString("base64url");
  await privateFile(join(config.secretsDir, "postgres-password"), postgresPassword);
  await privateFile(join(config.secretsDir, "session-secret"), randomBytes(32).toString("hex"));
  await privateFile(join(config.secretsDir, "setup-token"), randomBytes(32).toString("hex"));
  const storedPassword = (await readFile(join(config.secretsDir, "postgres-password"), "utf8")).trim();
  const databaseUrl = `postgresql://spaceapp:${encodeURIComponent(storedPassword)}@127.0.0.1:${config.ports.postgres}/spaceapp_dev`;
  await writeFile(join(config.secretsDir, "database-url"), `${databaseUrl}\n`, { mode: 0o600 });
  await chmod(join(config.secretsDir, "database-url"), 0o600);
  return databaseUrl;
}

async function newestMtime(path) {
  if (!existsSync(path)) return 0;
  const info = await stat(path);
  if (!info.isDirectory()) return info.mtimeMs;
  let newest = info.mtimeMs;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "coverage") continue;
    newest = Math.max(newest, await newestMtime(join(path, entry.name)));
  }
  return newest;
}

async function ensureBuild(config, force = false) {
  if (process.env.SPACE_DEV_SKIP_BUILD === "true" && !force) return;
  const keyArtifacts = [
    "packages/contracts/dist/index.js",
    "packages/runtime/dist/index.js",
    "packages/db/dist/migrate.js",
    "packages/cli-host/dist/main.js",
    "apps/worker/dist/worker.js"
  ].map((path) => join(config.root, path));
  const marker = existsSync(config.buildMarker) ? JSON.parse(await readFile(config.buildMarker, "utf8")) : null;
  const sourceMtime = Math.max(
    await newestMtime(join(config.root, "packages")),
    await newestMtime(join(config.root, "apps", "worker", "src"))
  );
  const needsBuild = force || process.env.SPACE_DEV_FORCE_BUILD === "true" || !marker ||
    keyArtifacts.some((path) => !existsSync(path)) || sourceMtime > Number(marker.sourceMtime || 0);
  if (!needsBuild) return;
  console.log("[dev:stack] Building source workspaces before migrations...");
  await run("npm", ["run", "build"], { cwd: config.root });
  await writeFile(config.buildMarker, `${JSON.stringify({ sourceMtime, builtAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
}

async function installOpenCode(config, version) {
  const packageJson = join(config.vendorDir, "node_modules", "opencode-ai", "package.json");
  let installedVersion = null;
  if (existsSync(packageJson)) {
    try { installedVersion = JSON.parse(await readFile(packageJson, "utf8")).version; } catch {}
  }
  if (installedVersion !== version) {
    console.log(`[dev:stack] Installing pinned opencode-ai@${version} inside the dev state directory...`);
    await rm(config.vendorDir, { recursive: true, force: true });
    await mkdir(config.vendorDir, { recursive: true, mode: 0o700 });
    await run("npm", ["install", "--prefix", config.vendorDir, "--no-package-lock", "--no-save", "--no-audit", "--no-fund", `opencode-ai@${version}`]);
  }
  const wrapper = join(config.binDir, "opencode-vscode-parity");
  const binary = join(config.vendorDir, "node_modules", ".bin", "opencode");
  const wrapperText = `#!/bin/sh\nset -eu\nexport HOME=${JSON.stringify(join(config.providerRoot, "home"))}\nexport XDG_CONFIG_HOME=${JSON.stringify(join(config.providerRoot, "config"))}\nexport XDG_DATA_HOME=${JSON.stringify(join(config.providerRoot, "data"))}\nexport XDG_CACHE_HOME=${JSON.stringify(join(config.providerRoot, "cache"))}\nexec ${JSON.stringify(binary)} \"$@\"\n`;
  await writeFile(wrapper, wrapperText, { mode: 0o700 });
  await chmod(wrapper, 0o700);
  return wrapper;
}

async function waitContainerHealthy(config, service, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const id = (await compose(config, ["ps", "-q", service], { capture: true })).stdout;
    if (id) {
      const statusResult = await run("docker", ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", id], { capture: true, allowFailure: true });
      if (statusResult.stdout === "healthy") return;
      if (statusResult.stdout === "unhealthy" || statusResult.stdout === "exited" || statusResult.stdout === "dead") {
        throw new Error(`${service} became ${statusResult.stdout} during dev-stack startup.`);
      }
    }
    await sleep(1000);
  }
  throw new Error(`${service} did not become healthy within ${Math.round(timeoutMs / 1000)} seconds.`);
}

async function ensureTemporalNamespace(config) {
  const describe = await compose(config, ["exec", "-T", "temporal", "temporal", "operator", "namespace", "describe", "--namespace", "spaceapp-dev", "--address", "temporal:7233"], { capture: true, allowFailure: true });
  if (describe.code === 0) return;
  await compose(config, ["exec", "-T", "temporal", "temporal", "operator", "namespace", "create", "--namespace", "spaceapp-dev", "--address", "temporal:7233"]);
}

function sanitizedBaseEnv() {
  const env = { ...process.env };
  for (const key of [
    "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GROK_API_KEY",
    "DEEPSEEK_API_KEY", "OPENROUTER_API_KEY", "GITHUB_TOKEN", "GH_TOKEN"
  ]) delete env[key];
  return env;
}

function sourceEnv(config, databaseUrl, openCodeWrapper) {
  return {
    ...sanitizedBaseEnv(),
    SPACE_INSTANCE: "dev",
    SPACE_INSTALL_ROOT: config.root,
    SPACE_RUNTIME_STORE: "postgres",
    SPACE_DATABASE_URL: databaseUrl,
    SPACE_DATABASE_URL_FILE: join(config.secretsDir, "database-url"),
    SPACE_SESSION_SECRET_FILE: join(config.secretsDir, "session-secret"),
    SPACE_SETUP_TOKEN_FILE: join(config.secretsDir, "setup-token"),
    SPACE_DEV_LOGIN: "false",
    SPACE_GOOGLE_AUTH_DISABLED: "true",
    SPACE_PUBLIC_DISTRIBUTION: "true",
    SPACE_OPTIONAL_MODULES: "none",
    SPACEAPP_WORKFLOWS_ENABLED: "true",
    SPACE_API_HOST: "127.0.0.1",
    SPACE_API_PORT: String(config.ports.api),
    SPACE_WEB_HOST: "127.0.0.1",
    SPACE_WEB_PORT: String(config.ports.web),
    SPACE_API_ORIGIN: `http://127.0.0.1:${config.ports.api}`,
    SPACE_TEMPORAL_ADDRESS: `127.0.0.1:${config.ports.temporal}`,
    SPACE_TEMPORAL_NAMESPACE: "spaceapp-dev",
    SPACE_TEMPORAL_TASK_QUEUE: "space-dev-agent-turns",
    SPACE_CLI_ENABLED: "true",
    SPACE_CLI_HOST_SOCKET: config.socketPath,
    SPACE_CLI_COMMAND_PATH: config.binDir,
    SPACE_CLI_OPENCODE_COMMAND: openCodeWrapper,
    SPACE_CLI_WORKSPACE_ROOT: config.workspacesRoot,
    SPACE_CLI_ROOT_ENABLED: "false",
    SPACE_BROWSER_SESSIONS_ENABLED: "false",
    SPACE_BROWSER_HOST_TRANSPORT: "in-process",
    SPACE_MEMORY_ROOT: config.memoryRoot,
    SPACE_MEMORY_GRAPH_ROOT: config.memoryGraphRoot,
    SPACE_ARTIFACT_ROOT: config.artifactRoot,
    SPACE_PROJECTS_ROOT: config.projectsRoot,
    SPACE_APP_DIAGNOSTICS_ROOT: config.diagnosticsRoot,
    SPACE_OPENCODE_CHAT_STATE_ROOT: config.openCodeChatRoot,
    SPACE_ENABLE_DUMMY_TURNS: "false",
    SPACE_ROOM_AGENT_AUTOPILOT_ENABLED: "false"
  };
}

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

async function waitReady(config, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${config.ports.api}/readyz`;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const body = await response.json();
        if (body.ok === true && body.dependencies?.database === "RUNNING" && body.dependencies?.worker === "RUNNING" && body.dependencies?.cliHost === "RUNNING") return body;
      }
    } catch {}
    await sleep(500);
  }
  throw new Error("The source stack did not reach /readyz with database, worker and CLI host RUNNING.");
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error?.code === "ESRCH") return false; throw error; }
}

async function readSupervisorPid(config) {
  if (!existsSync(config.pidFile)) return null;
  const value = Number.parseInt((await readFile(config.pidFile, "utf8")).trim(), 10);
  return Number.isInteger(value) ? value : null;
}

async function waitSupervisorExit(pid, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && pidAlive(pid)) await sleep(100);
  if (pidAlive(pid)) throw new Error(`Dev-stack supervisor ${pid} did not stop cleanly.`);
}

async function remainingDockerResources(config) {
  const containers = await run("docker", ["ps", "-aq", "--filter", `label=com.docker.compose.project=${config.project}`], { capture: true, allowFailure: true });
  const volumes = await run("docker", ["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${config.project}`], { capture: true, allowFailure: true });
  return { containers: containers.stdout.split(/\s+/).filter(Boolean), volumes: volumes.stdout.split(/\s+/).filter(Boolean) };
}

export async function down(config) {
  const pid = await readSupervisorPid(config);
  if (pid && pid !== process.pid && pidAlive(pid)) {
    process.kill(pid, "SIGTERM");
    await waitSupervisorExit(pid);
  }
  if (existsSync(config.composeFile)) await compose(config, ["down", "--remove-orphans"]);
}

export async function reset(config) {
  await down(config);
  if (existsSync(config.composeFile)) {
    await compose(config, ["down", "-v", "--remove-orphans"]);
  }
  const remaining = await remainingDockerResources(config);
  if (remaining.containers.length || remaining.volumes.length) {
    throw new Error(`Reset left owned Docker resources behind; state preserved for retry: ${JSON.stringify(remaining)}`);
  }
  if (config.socketRoot.startsWith(tmpdir()) && config.socketRoot !== tmpdir()) await rm(config.socketRoot, { recursive: true, force: true });
  await rm(config.stateRoot, { recursive: true, force: true });
  console.log("[dev:stack] Reset complete; owned containers, volumes and state were removed.");
}

export async function status(config) {
  const pid = await readSupervisorPid(config);
  const resources = await remainingDockerResources(config);
  const payload = {
    running: Boolean(pid && pidAlive(pid)),
    supervisorPid: pid,
    project: config.project,
    stateRoot: config.stateRoot,
    ports: config.ports,
    docker: resources
  };
  console.log(JSON.stringify(payload, null, 2));
  return payload;
}

async function writePublicConfig(config, openCodeVersion) {
  await writeFile(config.configFile, `${JSON.stringify({
    root: config.root,
    stateRoot: config.stateRoot,
    project: config.project,
    ports: config.ports,
    socketPath: config.socketPath,
    openCodeVersion
  }, null, 2)}\n`, { mode: 0o600 });
}

export async function start(config) {
  const existingPid = await readSupervisorPid(config);
  if (existingPid && pidAlive(existingPid)) throw new Error(`Dev stack is already running under supervisor ${existingPid}.`);

  const composeTemplate = await readFile(join(config.root, "packages", "run-spaceapp", "templates", "compose.yml"), "utf8");
  const dockerfile = await readFile(join(config.root, "Dockerfile"), "utf8");
  const images = parsePinnedImages(composeTemplate);
  const openCodeVersion = parseOpenCodeVersion(dockerfile);
  const databaseUrl = await prepareState(config);
  await writeFile(config.composeFile, renderCompose(config, images), { mode: 0o600 });
  await writePublicConfig(config, openCodeVersion);
  await run("docker", ["compose", "version"]);

  let children = new Map();
  let stopping = false;
  let reloadInFlight = Promise.resolve();
  const stopChildren = async () => {
    for (const child of children.values()) terminateTree(child);
    await Promise.all([...children.values()].map((child) => waitDead(child)));
    children = new Map();
    try { await rm(config.socketPath, { force: true }); } catch {}
  };
  const fail = (name, child, code, signal) => {
    if (stopping || child !== children.get(name)) return;
    console.error(`[dev:stack] ${name} exited unexpectedly (${code ?? signal}); stopping the stack.`);
    process.exitCode = 1;
    void shutdown("child-failure");
  };
  const spawnChildren = async (forceBuild = false) => {
    await ensureBuild(config, forceBuild);
    const openCodeWrapper = await installOpenCode(config, openCodeVersion);
    const env = sourceEnv(config, databaseUrl, openCodeWrapper);
    children.set("cli-host", spawnService(config, "cli-host", process.execPath, ["packages/cli-host/dist/main.js"], env, fail));
    children.set("worker", spawnService(config, "worker", process.execPath, ["apps/worker/dist/worker.js"], env, fail));
    children.set("api", spawnService(config, "api", "npm", ["exec", "--", "tsx", "watch", "apps/api/src/server.ts"], env, fail));
    children.set("web", spawnService(config, "web", "npm", ["run", "dev", "-w", "@space/web", "--", "--host", "127.0.0.1", "--port", String(config.ports.web)], env, fail));
  };
  const reload = () => {
    reloadInFlight = reloadInFlight.then(async () => {
      if (stopping) return;
      console.log("[dev:stack] Rebuilding source workspaces and restarting source services...");
      await stopChildren();
      await spawnChildren(true);
      await waitReady(config);
      console.log("[dev:stack] Rebuild complete; source services are ready.");
    }).catch((error) => {
      console.error(`[dev:stack] rebuild failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
      void shutdown("rebuild-failure");
    });
  };
  const shutdown = async (reason) => {
    if (stopping) return;
    stopping = true;
    console.log(`[dev:stack] Stopping (${reason})...`);
    await stopChildren();
    if (existsSync(config.composeFile)) await compose(config, ["down", "--remove-orphans"], { allowFailure: true });
    try { await rm(config.pidFile, { force: true }); } catch {}
  };

  process.once("SIGINT", () => { void shutdown("SIGINT").finally(() => process.exit(process.exitCode || 0)); });
  process.once("SIGTERM", () => { void shutdown("SIGTERM").finally(() => process.exit(process.exitCode || 0)); });
  process.on("SIGHUP", reload);

  await writeFile(config.pidFile, `${process.pid}\n`, { mode: 0o600 });
  try {
    console.log(`[dev:stack] Starting digest-pinned PostgreSQL and Temporal (${config.project})...`);
    await compose(config, ["up", "-d", "postgres", "temporal"]);
    await Promise.all([waitContainerHealthy(config, "postgres"), waitContainerHealthy(config, "temporal")]);
    await ensureTemporalNamespace(config);
    await ensureBuild(config);
    console.log("[dev:stack] Applying database migrations...");
    await run("npm", ["run", "db:migrate"], { cwd: config.root, env: { ...sanitizedBaseEnv(), SPACE_DATABASE_URL: databaseUrl } });
    await spawnChildren(false);
    await waitReady(config);
    const setupToken = (await readFile(join(config.secretsDir, "setup-token"), "utf8")).trim();
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

export async function rebuild(config) {
  const pid = await readSupervisorPid(config);
  if (!pid || !pidAlive(pid)) {
    await ensureBuild(config, true);
    console.log("[dev:stack] Rebuilt source workspaces; no running supervisor to restart.");
    return;
  }
  process.kill(pid, "SIGHUP");
  console.log(`[dev:stack] Rebuild requested from supervisor ${pid}.`);
}

async function main() {
  const command = process.argv[2] || "up";
  const config = await resolveDevStackConfig();
  if (command === "up" || command === "start") return start(config);
  if (command === "down" || command === "stop") return down(config);
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
