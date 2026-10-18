import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  assertSafeStateRoot,
  dockerResources,
  installOpenCode,
  parseOpenCodeVersion,
  parsePinnedImages,
  pidAlive,
  renderCompose,
  resolveConfig,
  sourceEnv
} from "./dev-stack-lib.mjs";
import { ensureDarwinNodePtySpawnHelpers, reset, stopRecordedProcesses, terminateTree, waitDead } from "./dev-stack.mjs";
import {
  assertOwnedState,
  assertSafeDevStackOverrides,
  claimStateOwnership,
  claimSupervisor,
  managedProcessRecordMatches,
  ownedSupervisorPid,
  processIdentity,
  releaseSupervisor,
  supervisorRecordMatches,
  writeManagedProcessRecords
} from "./dev-stack-safety.mjs";

test("source stack derives third-party pins from canonical files", () => {
  const images = parsePinnedImages(`
services:
  postgres:
    image: pgvector/pgvector:0.8.3-pg17-trixie@sha256:${"a".repeat(64)}
  temporal:
    image: temporalio/auto-setup:1.29.1@sha256:${"b".repeat(64)}
`);
  assert.equal(images.postgres, `pgvector/pgvector:0.8.3-pg17-trixie@sha256:${"a".repeat(64)}`);
  assert.equal(images.temporal, `temporalio/auto-setup:1.29.1@sha256:${"b".repeat(64)}`);
  assert.equal(parseOpenCodeVersion("RUN npm install --global opencode-ai@1.18.4"), "1.18.4");
  assert.throws(() => parsePinnedImages("services: {}"), /digest-pinned/);
  assert.throws(() => parseOpenCodeVersion("RUN npm install opencode-ai@latest"), /pinned/);
});

test("OpenCode wrapper isolates every writable path and preserves literal checkout paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-opencode-$literal-'quote-"));
  try {
    const config = await resolveConfig({}, root);
    await mkdir(config.binDir, { recursive: true });
    await mkdir(join(config.vendorDir, "node_modules", "opencode-ai"), { recursive: true });
    await mkdir(join(config.vendorDir, "node_modules", ".bin"), { recursive: true });
    await writeFile(join(config.vendorDir, "node_modules", "opencode-ai", "package.json"), JSON.stringify({ version: "1.18.4" }));
    const keys = ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "TMPDIR", "TMP", "TEMP"];
    await writeFile(join(config.vendorDir, "node_modules", ".bin", "opencode"),
      `#!${process.execPath}\nconsole.log(JSON.stringify({paths:Object.fromEntries(${JSON.stringify(keys)}.map(k=>[k,process.env[k]])),key:process.env.OPENCODE_API_KEY,args:process.argv.slice(2)}));\n`, { mode: 0o700 });
    const wrapper = await installOpenCode(config, "1.18.4");
    const { stdout } = await promisify(execFile)(wrapper, ["argument with spaces", "$literal"], {
      env: { ...process.env, ...Object.fromEntries(keys.map(k => [k, "/proc/spaceapp-unwritable"])), OPENCODE_API_KEY: "parent-key" }
    });
    const result = JSON.parse(stdout);
    const dirs = ["home", "config", "data", "cache", "state", "tmp", "tmp", "tmp"];
    for (const [index, key] of keys.entries()) {
      assert.equal(result.paths[key], join(config.providerRoot, dirs[index]));
      assert.equal((await stat(result.paths[key])).isDirectory(), true);
    }
    assert.equal(result.key, undefined);
    assert.deepEqual(result.args, ["argument with spaces", "$literal"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reset removes the owned state root after an empty Docker inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-reset-empty-"));
  const oldPath = process.env.PATH;
  try {
    const bin = join(root, "fake-bin");
    await mkdir(bin);
    // Docker behavior is deliberately stubbed: this regression covers directory removal only.
    await writeFile(join(bin, "docker"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    process.env.PATH = `${bin}:${oldPath}`;
    const config = await resolveConfig({}, root);
    await claimStateOwnership(config);
    await reset(config);
    assert.equal(existsSync(config.stateRoot), false);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("defaults isolate installed SpaceApp and bind Docker ports to loopback", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-dev-test-"));
  try {
    const config = await resolveConfig({}, root);
    assert.notEqual(config.ports.api, 4910);
    assert.notEqual(config.ports.web, 4911);
    assert.match(config.project, /^spaceapp-dev-[a-f0-9]{10}$/);
    const compose = renderCompose(config, {
      postgres: `pgvector/pgvector:0.8.3@sha256:${"c".repeat(64)}`,
      temporal: `temporalio/auto-setup:1.29.1@sha256:${"d".repeat(64)}`
    });
    for (const port of [config.ports.postgres, config.ports.temporal]) assert.match(compose, new RegExp(`127\\.0\\.0\\.1:${port}:`));
    assert.match(compose, /POSTGRES_PASSWORD: \$\{SPACEAPP_DEV_POSTGRES_PASSWORD/);
    assert.match(compose, /POSTGRES_PWD: \$\{SPACEAPP_DEV_POSTGRES_PASSWORD/);
    assert.doesNotMatch(compose, /\/run\/secrets\/postgres-password|secrets:\s*\[postgres-password\]/);
    assert.match(compose, /condition: service_healthy/);
    assert.match(compose, /temporal operator cluster health --address temporal:7233/);
    assert.equal((compose.match(/com\.spaceapp\.dev-stack\.owner:/g) || []).length, 4);

    const wrapper = join(config.binDir, "opencode-vscode-parity");
    const oldComposePassword = process.env.SPACEAPP_DEV_POSTGRES_PASSWORD;
    process.env.SPACEAPP_DEV_POSTGRES_PASSWORD = "compose-only-secret";
    try {
      const env = sourceEnv(config, "postgresql://spaceapp:test@127.0.0.1:55432/spaceapp_dev", "session-secret-with-enough-length", wrapper);
      assert.equal(env.SPACE_CLI_COMMAND_PATH, config.binDir);
      assert.equal(env.SPACE_CLI_OPENCODE_COMMAND, "opencode-vscode-parity");
      assert.equal(env.SPACE_DEV_LOGIN, "false");
      assert.equal(env.SPACE_API_HOST, "127.0.0.1");
      assert.equal(env.SPACE_WEB_HOST, "127.0.0.1");
      assert.equal(env.SPACEAPP_DEV_POSTGRES_PASSWORD, undefined);
      assert.throws(() => sourceEnv(config, "postgresql://x", "session-secret-with-enough-length", "/tmp/opencode-vscode-parity"), /controlled dev-stack command directory/);
    } finally {
      if (oldComposePassword === undefined) delete process.env.SPACEAPP_DEV_POSTGRES_PASSWORD;
      else process.env.SPACEAPP_DEV_POSTGRES_PASSWORD = oldComposePassword;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsafe state roots and installed-instance ports fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-dev-root-"));
  try {
    await assert.rejects(() => assertSafeStateRoot(root, root), /Unsafe dev-stack state directory/);
    await assert.rejects(() => resolveConfig({ SPACE_DEV_API_PORT: "4910" }, root), /reserved for an installed SpaceApp/);
    await assert.rejects(() => resolveConfig({ SPACE_DEV_API_PORT: "6000", SPACE_DEV_WEB_PORT: "6000" }, root), /conflicts/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("state ownership never adopts a non-empty pre-existing directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-state-owner-"));
  try {
    const config = await resolveConfig({}, root);
    await mkdir(config.stateRoot, { mode: 0o700 });
    const keep = join(config.stateRoot, "keep.txt");
    await writeFile(keep, "user data\n");
    await assert.rejects(() => claimStateOwnership(config), /not initialized by dev:stack/);
    assert.equal(await readFile(keep, "utf8"), "user data\n");

    await rm(keep);
    const record = await claimStateOwnership(config);
    assert.equal(record.createdStateRoot, false);
    assert.equal((await assertOwnedState(config)).rootHash, config.rootHash);

    await writeFile(join(config.stateRoot, ".ownership.json"), "{broken\n", { mode: 0o600 });
    await assert.rejects(() => assertOwnedState(config), /ownership record is corrupt/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Docker inventory fails closed on query failure or same-project unowned resources", async () => {
  const config = { project: "spaceapp-dev-test", rootHash: "0123456789" };
  const ownerFilter = `label=com.spaceapp.dev-stack.owner=${config.rootHash}`;
  const cleanRunner = async (_command, args) => ({ code: 0, signal: null, stdout: args.includes(ownerFilter) ? "owned" : "owned", stderr: "" });
  assert.deepEqual(await dockerResources(config, cleanRunner), {
    containers: ["owned"],
    volumes: ["owned"],
    networks: ["owned"]
  });

  const collisionRunner = async (_command, args) => ({ code: 0, signal: null, stdout: args.includes(ownerFilter) ? "owned" : "owned foreign", stderr: "" });
  await assert.rejects(() => dockerResources(config, collisionRunner), /without this checkout's ownership label/);
  await assert.rejects(() => dockerResources(config, async () => { throw new Error("daemon unavailable"); }), /daemon unavailable/);
});

test("destructive ownership selectors cannot be overridden", () => {
  assert.doesNotThrow(() => assertSafeDevStackOverrides({}));
  assert.throws(() => assertSafeDevStackOverrides({ SPACE_DEV_STACK_DIR: "/tmp/shared" }), /SPACE_DEV_STACK_DIR/);
  assert.throws(() => assertSafeDevStackOverrides({ SPACE_DEV_COMPOSE_PROJECT: "someone-elses-project" }), /SPACE_DEV_COMPOSE_PROJECT/);
});

test("supervisor identity rejects PID reuse and atomically claims a checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-supervisor-test-"));
  const config = {
    rootHash: "0123456789",
    pidFile: join(root, "supervisor.pid")
  };
  const ownedIdentity = async () => ({ startedAt: "Sun Oct 18 07:40:00 2026", args: "node deploy/docker/dev-stack.mjs", state: "S", pgid: process.pid });
  try {
    const record = await claimSupervisor(config, ownedIdentity);
    assert.equal(record.pid, process.pid);
    assert.equal(JSON.parse(await readFile(config.pidFile, "utf8")).rootHash, config.rootHash);
    assert.equal(supervisorRecordMatches(config, record, await ownedIdentity()), true);
    await assert.rejects(() => claimSupervisor(config, ownedIdentity), /already running/);

    const reusedIdentity = async () => ({ startedAt: "Sun Oct 18 07:41:00 2026", args: "node unrelated-tool.mjs", state: "S", pgid: process.pid });
    await assert.rejects(() => ownedSupervisorPid(config, { identityProvider: reusedIdentity }), /Refusing to signal PID/);

    await releaseSupervisor(config, process.pid);
    await writeFile(config.pidFile, `${process.pid}\n`, { mode: 0o600 });
    await assert.rejects(() => claimSupervisor(config, ownedIdentity), /stale or unverified/);
  } finally {
    await releaseSupervisor(config, process.pid).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("managed process identity rejects PID reuse", () => {
  const config = { rootHash: "0123456789" };
  const record = {
    name: "api",
    pid: 4321,
    pgid: 4321,
    rootHash: config.rootHash,
    startedAt: "Sun Oct 18 08:00:00 2026",
    args: "npm exec -- tsx watch apps/api/src/server.ts"
  };
  assert.equal(managedProcessRecordMatches(config, record, {
    startedAt: record.startedAt,
    args: record.args,
    state: "S",
    pgid: record.pgid
  }), true);
  assert.equal(managedProcessRecordMatches(config, record, {
    startedAt: "Sun Oct 18 08:01:00 2026",
    args: record.args,
    state: "S",
    pgid: record.pgid
  }), false);
});

test("persisted managed process records allow cleanup after supervisor loss", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-orphan-test-"));
  const config = { rootHash: "0123456789", stateRoot: root };
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore"
  });
  try {
    let identity = null;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !identity) {
      identity = await processIdentity(child.pid);
      if (!identity) await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    assert.ok(identity);
    assert.equal(identity.pgid, child.pid);
    await writeManagedProcessRecords(config, [{
      name: "synthetic",
      pid: child.pid,
      pgid: child.pid,
      rootHash: config.rootHash,
      startedAt: identity.startedAt,
      args: identity.args
    }]);
    await stopRecordedProcesses(config);
    assert.equal(existsSync(join(root, ".processes.json")), false);
    assert.equal(pidAlive(child.pid), false);
  } finally {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    await rm(root, { recursive: true, force: true });
  }
});

test("terminateTree still kills descendants after the detached leader exits", { skip: process.platform === "win32" }, async () => {
  const leader = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    setTimeout(() => process.exit(0), 100);
  `], { detached: true, stdio: "ignore" });
  try {
    await once(leader, "exit");
    assert.notEqual(leader.exitCode, null);
    terminateTree(leader, "SIGTERM");
    await waitDead(leader, 500);
  } finally {
    try { process.kill(-leader.pid, "SIGKILL"); } catch {}
  }
});

test("macOS source stack repairs node-pty spawn-helper execute permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-pty-helper-"));
  const helper = join(root, "node_modules", "node-pty", "prebuilds", "darwin-x64", "spawn-helper");
  try {
    await mkdir(join(root, "node_modules", "node-pty", "prebuilds", "darwin-x64"), { recursive: true });
    await writeFile(helper, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    await chmod(helper, 0o644);

    const repaired = await ensureDarwinNodePtySpawnHelpers(root, "darwin");
    assert.deepEqual(repaired, [helper]);
    assert.equal((await stat(helper)).mode & 0o111, 0o111);
    assert.deepEqual(await ensureDarwinNodePtySpawnHelpers(root, "darwin"), []);

    await chmod(helper, 0o644);
    assert.deepEqual(await ensureDarwinNodePtySpawnHelpers(root, "linux"), []);
    assert.equal((await stat(helper)).mode & 0o111, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
