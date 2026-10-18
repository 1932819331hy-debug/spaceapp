import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertSafeStateRoot,
  parseOpenCodeVersion,
  parsePinnedImages,
  renderCompose,
  resolveConfig,
  sourceEnv
} from "./dev-stack-lib.mjs";
import {
  assertSafeDevStackOverrides,
  claimSupervisor,
  ownedSupervisorPid,
  releaseSupervisor,
  supervisorRecordMatches
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
  const ownedIdentity = async () => ({ startedAt: "Sun Oct 18 07:40:00 2026", args: "node deploy/docker/dev-stack.mjs" });
  try {
    const record = await claimSupervisor(config, ownedIdentity);
    assert.equal(record.pid, process.pid);
    assert.equal(JSON.parse(await readFile(config.pidFile, "utf8")).rootHash, config.rootHash);
    assert.equal(supervisorRecordMatches(config, record, await ownedIdentity()), true);
    await assert.rejects(() => claimSupervisor(config, ownedIdentity), /already running/);

    const reusedIdentity = async () => ({ startedAt: "Sun Oct 18 07:41:00 2026", args: "node unrelated-tool.mjs" });
    await assert.rejects(() => ownedSupervisorPid(config, { identityProvider: reusedIdentity }), /Refusing to signal PID/);
  } finally {
    await releaseSupervisor(config, process.pid).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
