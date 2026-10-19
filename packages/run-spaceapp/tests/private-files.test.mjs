import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import test from "node:test";
import { createPrivateStagingFile, mkdirPrivate, restrictPrivatePath } from "../src/private-files.mjs";
import { writeCredential } from "../src/index.mjs";
import { assertPrivatePath, grantEveryoneInFixture, windowsAcl } from "./helpers/private-path.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-private-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("private directories replace permissive grants and new credentials inherit their protection", async (t) => {
  const root = await fixture(t);
  const providers = join(root, "secrets", "providers");
  await mkdir(providers, { recursive: true });
  if (process.platform === "win32") {
    await grantEveryoneInFixture(root, { directory: true });
    await grantEveryoneInFixture(providers, { directory: true });
    assert.ok((await windowsAcl(providers)).rules.some((rule) => rule.sid === "S-1-1-0"));
  } else {
    await chmod(providers, 0o777);
  }
  const path = await writeCredential(root, "gemini", "first-synthetic-key\n");
  await assertPrivatePath(providers, { directory: true });
  await assertPrivatePath(path);
  assert.equal(await readFile(path, "utf8"), "first-synthetic-key");
  // Replacing a legacy file with an explicit broad grant must not preserve it.
  if (process.platform === "win32") await grantEveryoneInFixture(path);
  else await chmod(path, 0o666);
  await writeCredential(root, "gemini", "replacement-synthetic-key");
  await assertPrivatePath(path);
  assert.equal(await readFile(path, "utf8"), "replacement-synthetic-key");
});

test("private archive permissions survive writing and same-volume rename under a publicly readable parent", async (t) => {
  const root = await fixture(t);
  if (process.platform === "win32") await grantEveryoneInFixture(root, { directory: true });
  else await chmod(root, 0o777);
  if (process.platform === "win32") {
    // Negative control for the previous mode-only archive creation: a real
    // Windows ACL still grants Everyone access after both mode and chmod 0600.
    const legacy = join(root, "legacy-mode-only.tar.gz");
    await writeFile(legacy, "synthetic legacy archive", { mode: 0o600 });
    await chmod(legacy, 0o600);
    assert.ok((await windowsAcl(legacy)).rules.some((rule) => rule.sid === "S-1-1-0" && rule.type === 0));
    await assert.rejects(assertPrivatePath(legacy), { name: "AssertionError" });
    await rm(legacy);
  }
  const archive = join(root, "archive [literal] '$();.tar.gz");
  const { path: temporary, directory } = await createPrivateStagingFile(archive, { protect: async (path, options) => {
    if (options?.directory) {
      if (process.platform === "win32") {
        await assert.rejects(stat(path), { code: "ENOENT" });
        assert.equal(options.createDirectory, true);
        assert.equal(options.exclusive, true);
      } else {
        assert.deepEqual(await readdir(path), []);
      }
    } else {
      // This is the file's inherited ACL, before applying its explicit ACL.
      await assertPrivatePath(path);
    }
    await restrictPrivatePath(path, options);
  } });
  await assertPrivatePath(directory, { directory: true });
  await assertPrivatePath(temporary, { protectedDacl: true });
  await writeFile(temporary, "synthetic archive", { flag: "r+" });
  await rename(temporary, archive);
  await assertPrivatePath(archive, { protectedDacl: true });
  assert.equal(await readFile(archive, "utf8"), "synthetic archive");
});

test("a failed permission check removes staging before its producer can write data", async (t) => {
  const root = await fixture(t);
  const path = join(root, "failed-archive.tar.gz");
  for (const failDirectory of [true, false]) {
    let produced = false;
    await assert.rejects(async () => {
      await createPrivateStagingFile(path, { protect: async (target, options) => {
        if (options?.directory && process.platform === "win32") await assert.rejects(stat(target), { code: "ENOENT" });
        else if (options?.directory) assert.deepEqual(await readdir(target), []);
        else assert.equal((await stat(target)).size, 0);
        if (Boolean(options?.directory) === failDirectory) throw new Error("ACL readback denied");
        await restrictPrivatePath(target, options);
      } });
      produced = true;
      await writeFile(path, "must not be written");
    }, /ACL readback denied/);
    assert.equal(produced, false);
    assert.deepEqual(await readdir(root), []);
  }
});

test("private staging does not overwrite an existing destination", async (t) => {
  const path = join(await fixture(t), "existing");
  await writeFile(path, "keep existing data");
  const staged = await createPrivateStagingFile(path);
  assert.equal((await stat(staged.path)).size, 0);
  assert.equal(await readFile(path, "utf8"), "keep existing data");
});

test("Windows permission enforcement fails closed on process failure or unverified success", async (t) => {
  const path = join(await fixture(t), "unused [literal] '$();");
  for (const execute of [
    async () => { throw new Error("PowerShell unavailable"); },
    async () => ({ stdout: "" }),
    async () => ({ stdout: "access denied" })
  ]) {
    await assert.rejects(restrictPrivatePath(path, { platform: "win32", execute }), /Cannot enforce private Windows permissions/);
  }
  let invocation;
  await assert.rejects(restrictPrivatePath(path, { platform: "win32", execute: async (...args) => {
    invocation = args;
    throw new Error("capture without executing");
  } }), /Cannot enforce/);
  assert.ok(win32.isAbsolute(invocation[0]), "ACL enforcement must not search the working directory or PATH");
  assert.equal(win32.basename(invocation[0]), "powershell.exe");
  assert.deepEqual(Object.keys(invocation[2].env).filter((name) => name.toUpperCase() === "PSMODULEPATH"), ["PSModulePath"]);
  assert.equal(invocation[2].env.PSModulePath, win32.join(win32.dirname(invocation[0]), "Modules"), "Windows PowerShell must not inherit PowerShell 7 module paths through Node");
  assert.equal(invocation[2].env.SPACEAPP_PRIVATE_PATH, path);
  assert.ok(!invocation[1].at(-1).includes(path), "The path must never become PowerShell code");
});

test("private directories reject writable Windows locations and retain private POSIX modes", async (t) => {
  const root = await fixture(t);
  const shared = join(root, "shared");
  await mkdir(shared);
  if (process.platform === "win32") {
    await grantEveryoneInFixture(shared, { directory: true, writable: true });
    await assert.rejects(createPrivateStagingFile(join(shared, "archive.tar.gz")), /Cannot enforce private Windows permissions/);
    await assert.rejects(mkdirPrivate(join(shared, "private")), /Cannot enforce private Windows permissions/);
    assert.deepEqual(await readdir(shared), [], "Unsafe parents must be rejected before creating storage");
    const providers = join(root, "secrets", "providers");
    await mkdir(providers, { recursive: true });
    await grantEveryoneInFixture(providers, { directory: true, writable: true });
    await assert.rejects(writeCredential(root, "gemini", "must not be written"), /Cannot enforce private Windows permissions/);
    assert.deepEqual(await readdir(providers), [], "Unsafe existing provider directories must not receive new keys");
    await assert.rejects(restrictPrivatePath(shared, { directory: true, createDirectory: true, exclusive: true }), /Cannot enforce private Windows permissions/);
    assert.equal((await stat(shared)).isDirectory(), true, "A pre-existing staging name must not be deleted");
  } else {
    await mkdirPrivate(join(shared, "private"));
    await assertPrivatePath(join(shared, "private"), { directory: true });
  }
});
