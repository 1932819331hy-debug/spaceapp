import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertSafeStateRoot,
  parseOpenCodeVersion,
  parsePinnedImages,
  renderCompose,
  resolveConfig
} from "./dev-stack-lib.mjs";

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
    assert.match(compose, /POSTGRES_PASSWORD_FILE: \/run\/secrets\/postgres-password/);
    assert.match(compose, /condition: service_healthy/);
    assert.match(compose, /temporal operator cluster health --address temporal:7233/);
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
