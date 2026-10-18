import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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
  renderCompose,
  resolveConfig,
  run,
  sleep,
  sourceEnv
} from "./dev-stack-lib.mjs";
import { ensureDarwinNodePtySpawnHelpers, reset } from "./dev-stack.mjs";
import {
  assertSafeDevStackOverrides,
  claimStateOwnership,
  claimSupervisor,
  ownedSupervisorPid,
  readStateOwnership,
  releaseSupervisor,
  supervisorRecordMatches,
  terminateOwnedProcessGroups,
  writeProcessRecords
} from "./dev-stack-safety.mjs";

const ownership = (rootHash) => ({ version: 1, rootHash, token: "a".repeat(48) });

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

test("OpenCode wrapper isolates writable state and preserves literal checkout paths", async () => {
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
      env: { ...process.env, ...Object.fromEntries(keys.map((key) => [key, "/proc/spaceapp-unwritable"])), OPENCODE_API_KEY: "parent-key" }
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

test("reset removes only the state directory it initialized when Docker inventory is empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-reset-empty-"));
  const oldPath = process.env.PATH;
  try {
    const bin = join(root, "fake-bin");
    await mkdir(bin);
    await writeFile(join(bin, "docker"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    process.env.PATH = `${bin}:${oldPath || ""}`;
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
    }, ownership(config.rootHash));
    for (const port of [config.ports.postgres, config.ports.temporal]) assert.match(compose, new RegExp(`127\\.0\\.0\\.1:${port}:`));
    assert.match(compose, /POSTGRES_PASSWORD: \$\{SPACEAPP_DEV_POSTGRES_PASSWORD/);
    assert.match(compose, /POSTGRES_PWD: \$\{SPACEAPP_DEV_POSTGRES_PASSWORD/);
    assert.doesNotMatch(compose, /\/run\/secrets\/postgres-password|secrets:\s*\[postgres-password\]/);
    assert.match(compose, /condition: service_healthy/);
    assert.match(compose, /temporal operator cluster health --address temporal:7233/);
    assert.equal((compose.match(/com\.spaceapp\.dev-stack\.owner:/g) || []).length, 4);

    const wrapper = join(config.binDir, "opencode-vscode-parity");
    const oldComposePassword = process.env.SPACEAPP_DEV_POSTGRES_PASSWORD;
    const oldProcessToken = process.env.SPACE_DEV_PROCESS_TOKEN;
    process.env.SPACEAPP_DEV_POSTGRES_PASSWORD = "compose-only-secret";
    process.env.SPACE_DEV_PROCESS_TOKEN = "caller-supplied-token";
    try {
      const env = sourceEnv(config, "postgresql://spaceapp:test@127.0.0.1:55432/spaceapp_dev", "session-secret-with-enough-length", wrapper);
      assert.equal(env.SPACE_CLI_COMMAND_PATH, config.binDir);
      assert.equal(env.SPACE_CLI_OPENCODE_COMMAND, "opencode-vscode-parity");
      assert.equal(env.SPACE_DEV_LOGIN, "false");
      assert.equal(env.SPACE_API_HOST, "127.0.0.1");
      assert.equal(env.SPACE_WEB_HOST, "127.0.0.1");
      assert.equal(env.SPACEAPP_DEV_POSTGRES_PASSWORD, undefined);
      assert.equal(env.SPACE_DEV_PROCESS_TOKEN, undefined);
      assert.throws(() => sourceEnv(config, "postgresql://x", "session-secret-with-enough-length", "/tmp/opencode-vscode-parity"), /controlled dev-stack command directory/);
    } finally {
      if (oldComposePassword === undefined) delete process.env.SPACEAPP_DEV_POSTGRES_PASSWORD;
      else process.env.SPACEAPP_DEV_POSTGRES_PASSWORD = oldComposePassword;
      if (oldProcessToken === undefined) delete process.env.SPACE_DEV_PROCESS_TOKEN;
      else process.env.SPACE_DEV_PROCESS_TOKEN = oldProcessToken;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsafe state roots and installed-instance ports fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-dev-root-"));
  try {
    await assert.rejects(() => assertSafeStateRoot(root, root), /Unsafe dev-stack state directory/);
    const target = join(root, "real-state");
    const link = join(root, ".dev-stack-link");
    await mkdir(target);
    await symlink(target, link);
    await assert.rejects(() => assertSafeStateRoot(link, join(root, "checkout")), /may not be a symlink/);
    await assert.rejects(() => resolveConfig({ SPACE_DEV_API_PORT: "4910" }, root), /reserved for an installed SpaceApp/);
    await assert.rejects(() => resolveConfig({ SPACE_DEV_API_PORT: "6000", SPACE_DEV_WEB_PORT: "6000" }, root), /conflicts/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("destructive ownership selectors cannot be overridden", () => {
  assert.doesNotThrow(() => assertSafeDevStackOverrides({}));
  assert.throws(() => assertSafeDevStackOverrides({ SPACE_DEV_STACK_DIR: "/tmp/shared" }), /SPACE_DEV_STACK_DIR/);
  assert.throws(() => assertSafeDevStackOverrides({ SPACE_DEV_COMPOSE_PROJECT: "someone-elses-project" }), /SPACE_DEV_COMPOSE_PROJECT/);
});

test("state ownership never adopts a pre-existing or corrupt directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-state-owner-"));
  const config = await resolveConfig({}, root);
  try {
    const owner = await claimStateOwnership(config);
    assert.equal(owner.rootHash, config.rootHash);
    assert.match(owner.token, /^[a-f0-9]{48}$/);
    assert.deepEqual(await readStateOwnership(config), owner);

    await writeFile(config.ownerFile, "not-json\n", { mode: 0o600 });
    await assert.rejects(() => readStateOwnership(config), /unreadable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const preexistingRoot = await mkdtemp(join(tmpdir(), "spaceapp-state-preexisting-"));
  const preexistingConfig = await resolveConfig({}, preexistingRoot);
  try {
    await mkdir(preexistingConfig.stateRoot, { mode: 0o700 });
    await assert.rejects(() => claimStateOwnership(preexistingConfig), /Refusing to adopt pre-existing state directory/);
    await writeFile(join(preexistingConfig.stateRoot, "keep-me"), "foreign\n");
    await assert.rejects(() => claimStateOwnership(preexistingConfig), /Refusing to adopt pre-existing state directory/);
    assert.equal(await readFile(join(preexistingConfig.stateRoot, "keep-me"), "utf8"), "foreign\n");
  } finally {
    await rm(preexistingRoot, { recursive: true, force: true });
  }
});

test("docker inventory fails closed and rejects same-project resources without the ownership label", async () => {
  const config = { project: "spaceapp-dev-test" };
  const owner = { token: "b".repeat(48) };
  const failingRunner = async () => ({ code: 1, stdout: "", stderr: "daemon unavailable" });
  await assert.rejects(() => dockerResources(config, owner, failingRunner), /Docker inventory failed/);

  const collisionRunner = async (_command, args) => {
    const owned = args.some((arg) => String(arg).includes("com.spaceapp.dev-stack.owner="));
    const kind = args[0] === "ps" ? "container" : args[0] === "volume" ? "volume" : "network";
    return { code: 0, stdout: owned ? "" : `${kind}-1`, stderr: "" };
  };
  await assert.rejects(() => dockerResources(config, owner, collisionRunner), /not proven to belong/);

  const cleanRunner = async (_command, args) => {
    const kind = args[0] === "ps" ? "container" : args[0] === "volume" ? "volume" : "network";
    return { code: 0, stdout: `${kind}-1`, stderr: "" };
  };
  assert.deepEqual(await dockerResources(config, owner, cleanRunner), {
    containers: ["container-1"],
    volumes: ["volume-1"],
    networks: ["network-1"]
  });
});

test("supervisor identity rejects PID reuse and atomically claims a checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-supervisor-test-"));
  const config = {
    rootHash: "0123456789",
    pidFile: join(root, "supervisor.pid")
  };
  const ownedIdentity = async () => ({ startedAt: "Sun Oct 18 07:40:00 2026", args: "node deploy/docker/dev-stack.mjs" });
  try {
    const record = await claimSupervisor(config, ownedIdentity);
    assert.equal(record.pid, process.pid);
    assert.equal(JSON.parse(await readFile(config.pidFile, "utf8")).rootHash, config.rootHash);
    assert.equal(supervisorRecordMatches(config, record, await ownedIdentity()), true);
    await assert.rejects(() => claimSupervisor(config, ownedIdentity), /already running/);

    const reusedIdentity = async () => ({ startedAt: "Sun Oct 18 07:41:00 2026", args: "node unrelated-tool.mjs" });
    await assert.rejects(() => ownedSupervisorPid(config, { identityProvider: reusedIdentity }), /Refusing to signal PID/);

    await releaseSupervisor(config, process.pid);
    await writeFile(config.pidFile, `${process.pid}\n`, { mode: 0o600 });
    await assert.rejects(() => claimSupervisor(config, ownedIdentity), /stale or unverified/);
  } finally {
    await releaseSupervisor(config, process.pid).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("persisted process-group ownership cleans descendants after the leader exits", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-process-owner-"));
  const config = {
    rootHash: "abcdef0123",
    processFile: join(root, "process-groups.json")
  };
  const owner = ownership(config.rootHash);
  const childPidFile = join(root, "child.pid");
  const childScript = "setInterval(() => {}, 1000)";
  const leaderScript = `
    const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    const child = spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], { stdio: "ignore", env: process.env });
    fs.writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));
    setTimeout(() => process.exit(0), 50);
  `;
  const leader = spawn(process.execPath, ["-e", leaderScript], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, SPACE_DEV_PROCESS_TOKEN: owner.token }
  });
  leader.unref();
  const record = { name: "orphan-probe", pid: leader.pid, pgid: leader.pid, sid: leader.pid };
  try {
    await writeProcessRecords(config, owner, [record]);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (existsSync(childPidFile)) {
        const leaderStatus = await run("ps", ["-p", String(leader.pid), "-o", "stat="], { capture: true, allowFailure: true });
        if (leaderStatus.code !== 0 || leaderStatus.stdout.startsWith("Z")) break;
      }
      await sleep(50);
    }
    assert.equal(existsSync(childPidFile), true);
    const childPid = Number(await readFile(childPidFile, "utf8"));
    assert.ok(Number.isInteger(childPid) && childPid > 1);

    await terminateOwnedProcessGroups(config, owner, { timeoutMs: 1500 });
    const groupStatus = await run("ps", ["-axo", "pid=,pgid=,sid=,stat="], { capture: true, allowFailure: true });
    const liveMembers = groupStatus.stdout.split(/\r?\n/).filter((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/);
      return match && Number(match[2]) === record.pgid && Number(match[3]) === record.sid && !match[4].startsWith("Z");
    });
    assert.deepEqual(liveMembers, []);
    assert.equal(existsSync(config.processFile), false);
  } finally {
    try { process.kill(-leader.pid, "SIGKILL"); } catch {}
    await rm(root, { recursive: true, force: true });
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
