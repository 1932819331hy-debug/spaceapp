import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  credentialProviders,
  removeCredential,
  writeCredential
} from "../src/index.mjs";
import { assertPrivatePath } from "./helpers/private-path.mjs";

test("credential providers distinguish bundled, owner-installed and experimental CLIs", () => {
  assert.deepEqual(credentialProviders(), {
    bundled: ["opencode"],
    ownerInstalled: ["codex", "gemini", "qwen", "kimi", "grok", "autohand", "cursor", "copilot", "claude"],
    experimental: ["deepseek"]
  });
});

test("credentials are allowlisted, newline-trimmed, and restricted to the owner and system administrators", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-credential-"));

  const path = await writeCredential(root, "gemini", "example-value\n");

  assert.equal(await readFile(path, "utf8"), "example-value");
  await assertPrivatePath(path);
  await assert.rejects(
    () => writeCredential(root, "../../escape", "value"),
    /provider/i
  );
  await assert.rejects(() => writeCredential(root, "codex", ""), /empty/i);

  assert.equal(await removeCredential(root, "gemini"), true);
  assert.equal(await removeCredential(root, "gemini"), false);
});
