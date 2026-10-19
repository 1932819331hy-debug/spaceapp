import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { stageContainerTarget } from "../stage-container-targets.mjs";

async function write(root, path, contents) {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
}

async function makeFixture(root) {
  await write(root, "package.json", JSON.stringify({ name: "fixture", type: "module" }));
  await write(root, "apps/api/package.json", JSON.stringify({
    name: "@space/api",
    exports: { ".": "./dist/index.js" }
  }));
  await write(root, "apps/api/dist/databases/sqlite-worker.py", "# fixture\n");
  await write(root, "apps/api/dist/browser-host-main.js", 'import "@space/shared";\nimport "nested-only";\nnew URL("../package.json", import.meta.url);\n');
  await write(root, "apps/api/dist/server.js", 'import "@space/shared";\nimport "node:sqlite";\nimport "./app.js";\nimport "./space-control-capture.js";\n');
  await write(root, "apps/api/dist/app.js", 'import "./design/wiring.js";\n');
  await write(root, "apps/api/dist/design/wiring.js", 'import "./render.js";\n');
  await write(root, "apps/api/dist/design/render.js", 'new URL("../../../../scripts/space-design-render.mjs", import.meta.url);\n');
  await write(root, "apps/api/dist/space-control-capture.js", 'new URL("../../../scripts/space-media-capture.mjs", import.meta.url);\n');
  await write(root, "apps/api/dist/index.js", 'import "@space/shared";\n');
  await write(root, "apps/worker/dist/worker.js", 'import "node:process";\nnew URL("./workflows.js", import.meta.url);\n');
  await write(root, "apps/worker/dist/workflows.js", 'import "tiny-parent";\n');
  await write(root, "apps/web/server.mjs", 'import "node:process";\n');
  await write(root, "apps/web/dist/server.js", "export {};\n");
  await write(root, "packages/db/package.json", JSON.stringify({ name: "@space/db" }));
  await write(root, "packages/db/dist/migrate.js", "export {};\n");
  await write(root, "packages/db/migrations/0001_fixture.sql", "SELECT 1;\n");
  await write(root, "packages/shared/package.json", JSON.stringify({
    name: "@space/shared",
    exports: { ".": "./dist/index.js" }
  }));
  await write(root, "packages/shared/dist/index.js", 'import "tiny-parent";\nnew URL("./asset.js", import.meta.resolve("@space/shared"));\n');
  await write(root, "packages/shared/dist/asset.js", "export {};\n");
  await write(root, "packages/cli-host/package.json", JSON.stringify({ name: "@space/cli-host" }));
  await write(root, "packages/cli-host/dist/main.js", 'import "./pty-loader.js";\n');
  await write(root, "packages/cli-host/dist/pty-loader.js", 'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\nrequire("node-pty");\n');
  await write(root, "node_modules/tiny-parent/package.json", JSON.stringify({
    name: "tiny-parent",
    dependencies: { "tiny-leaf": "1" }
  }));
  await write(root, "node_modules/tiny-parent/index.js", "export {};\n");
  await write(root, "node_modules/tiny-leaf/package.json", JSON.stringify({ name: "tiny-leaf" }));
  await write(root, "node_modules/tiny-leaf/index.js", "export {};\n");
  await write(root, "node_modules/node-pty/package.json", JSON.stringify({ name: "node-pty" }));
  await write(root, "node_modules/node-pty/index.js", "export {};\n");
  await write(root, "apps/api/node_modules/nested-only/package.json", JSON.stringify({ name: "nested-only" }));
  await write(root, "apps/api/node_modules/nested-only/index.js", "export {};\n");

  for (const path of [
    "apps/web/public/brand/spaceapp-logo.svg",
    "agent-skills/README.md", "demos/README.md", "packages/gateway/grammars/README.md",
    "starter-memory/AGENTS.md", "starter-memory/installation-guide.md",
    "scripts/reset-owner-password.mjs", "scripts/rotate-owner-setup-token.mjs",
    "scripts/portable-backup.mjs", "scripts/portable-restore.mjs"
  ]) await write(root, path, "fixture\n");
}

async function resolveManifestEdges(root, manifest) {
  const groups = new Map();
  for (const edge of manifest.resolutionEdges) {
    if (edge.builtin || edge.omitted) continue;
    const key = JSON.stringify([dirname(edge.from), edge.mode ?? "import"]);
    const group = groups.get(key) ?? new Set();
    group.add(edge.specifier);
    groups.set(key, group);
  }
  let index = 0;
  for (const [key, specifiers] of groups) {
    const [directory, mode] = JSON.parse(key);
    const probe = join(root, directory, `.test-resolution-${process.pid}-${index++}.mjs`);
    const resolver = mode === "require"
      ? "createRequire(import.meta.url).resolve(specifier)"
      : "import.meta.resolve(specifier)";
    const source = `import fs from "node:fs"; import {createRequire} from "node:module"; import {fileURLToPath} from "node:url"; for (const specifier of ${JSON.stringify([...specifiers])}) { const resolved = ${resolver}; const resolvedPath = resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved; if ((resolved.startsWith("file:") || !resolved.includes(":")) && !fs.existsSync(resolvedPath)) throw new Error("missing " + specifier); }`;
    await writeFile(probe, source);
    try {
      await import(pathToFileURL(probe).href);
    } finally {
      await rm(probe, { force: true });
    }
  }
}

test("per-target runtime staging retains transitive closures and isolates node-pty to CLI", async (t) => {
  assert.equal(isBuiltin("node:sqlite"), true);
  assert.equal(isBuiltin("node:foo"), false);
  const root = await mkdtemp(join(tmpdir(), "spaceapp-stage-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const output = join(root, "output");
  await makeFixture(source);

  const browser = await stageContainerTarget({ source, output: join(output, "browser"), target: "browser" });
  assert.equal(browser.workspaceCount, 1);
  assert.equal(browser.externalPackageCount, 3);
  assert.equal(await readFile(join(output, "browser/node_modules/@space/shared/dist/index.js"), "utf8"), 'import "tiny-parent";\nnew URL("./asset.js", import.meta.resolve("@space/shared"));\n');
  assert.equal(await readFile(join(output, "browser/node_modules/@space/shared/dist/asset.js"), "utf8"), "export {};\n");
  assert.equal(await readFile(join(output, "browser/apps/api/package.json"), "utf8"), await readFile(join(source, "apps/api/package.json"), "utf8"));
  assert.equal(await readFile(join(output, "browser/apps/api/node_modules/nested-only/package.json"), "utf8"), JSON.stringify({ name: "nested-only" }));
  const browserManifest = JSON.parse(await readFile(join(output, "browser/container-runtime-manifest.json"), "utf8"));
  assert.equal(browserManifest.target, "browser");
  assert.ok(browserManifest.stagedPaths.includes("apps/api/dist/browser-host-main.js"));
  assert.ok(browserManifest.stagedPaths.includes("packages/db/dist/migrate.js"));
  assert.ok(browserManifest.stagedPaths.includes("node_modules/@space/shared"));
  await resolveManifestEdges(join(output, "browser"), browserManifest);
  assert.equal(await readFile(join(output, "browser/node_modules/tiny-leaf/package.json"), "utf8"), JSON.stringify({ name: "tiny-leaf" }));
  await assert.rejects(readFile(join(output, "browser/node_modules/node-pty/package.json")), { code: "ENOENT" });

  const core = await stageContainerTarget({ source, output: join(output, "core"), target: "core" });
  await assert.rejects(readFile(join(output, "core/node_modules/node-pty/package.json")), { code: "ENOENT" });
  assert.equal(await readFile(join(output, "core/apps/worker/dist/workflows.js"), "utf8"), 'import "tiny-parent";\n');
  assert.equal(await readFile(join(output, "core/packages/db/migrations/0001_fixture.sql"), "utf8"), "SELECT 1;\n");
  assert.equal(await readFile(join(output, "core/apps/api/package.json"), "utf8"), await readFile(join(source, "apps/api/package.json"), "utf8"));
  assert.equal(await readFile(join(output, "core/apps/api/dist/databases/sqlite-worker.py"), "utf8"), "# fixture\n");
  assert.equal(await readFile(join(output, "core/apps/web/public/brand/spaceapp-logo.svg"), "utf8"), "fixture\n");
  const coreManifestPath = join(output, "core/container-runtime-manifest.json");
  const coreManifest = JSON.parse(await readFile(coreManifestPath, "utf8"));
  assert.deepEqual(coreManifest.excludedOptionalResources.map(({ path }) => path), [
    "scripts/space-design-render.mjs",
    "scripts/space-media-capture.mjs"
  ]);
  assert.match(coreManifest.excludedOptionalResources.find(({ path }) => path === "scripts/space-design-render.mjs").reason,
    /optional public module disabled by default/);
  assert.ok(coreManifest.resolutionEdges.some(({ specifier, builtin }) => specifier === "node:sqlite" && builtin === true));
  await assert.rejects(readFile(join(output, "core/starter-memory/AGENTS.md")), { code: "ENOENT" });

  // The explicit public-export exceptions must not turn unrelated missing URL resources into silent omissions.
  await write(source, "apps/api/dist/design/render.js",
    'new URL("../../../../scripts/space-design-render.mjs", import.meta.url);\nnew URL("../../../../scripts/required-extra.mjs", import.meta.url);\n');
  await assert.rejects(
    stageContainerTarget({ source, output: join(output, "core-missing-required-resource"), target: "core" }),
    /Cannot resolve local runtime import \.\.\/\.\.\/\.\.\/\.\.\/scripts\/required-extra\.mjs/
  );

  // isBuiltin must recognize actual node: builtins without accepting arbitrary node: specifiers.
  await write(source, "apps/api/dist/server.js",
    'import "@space/shared";\nimport "node:sqlite";\nimport "node:foo";\nimport "./app.js";\nimport "./space-control-capture.js";\n');
  await assert.rejects(
    stageContainerTarget({ source, output: join(output, "core-unknown-node-builtin"), target: "core" }),
    /Cannot resolve installed dependency node:foo/
  );

  const cli = await stageContainerTarget({ source, output: join(output, "cli"), target: "cli" });
  assert.equal(cli.externalPackageCount, 1);
  assert.equal(await readFile(join(output, "cli/node_modules/node-pty/package.json"), "utf8"), JSON.stringify({ name: "node-pty" }));
  await assert.rejects(readFile(join(output, "cli/node_modules/tiny-parent/package.json")), { code: "ENOENT" });
  const cliManifest = JSON.parse(await readFile(join(output, "cli/container-runtime-manifest.json"), "utf8"));
  await resolveManifestEdges(join(output, "cli"), cliManifest);
});
