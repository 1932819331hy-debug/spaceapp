import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const readRepoFile = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const apiPackage = JSON.parse(readRepoFile("../../apps/api/package.json"));
const cliHostPackage = JSON.parse(readRepoFile("../../packages/cli-host/package.json"));
const apiLockEntry = JSON.parse(readRepoFile("../../package-lock.json")).packages["apps/api"];
const cliHostSourceUrl = new URL("../../packages/cli-host/src/node-pty-spawn.ts", import.meta.url).href;

test("the API dependency closure leaves node-pty in the CLI host only", () => {
  assert.equal(apiPackage.dependencies["node-pty"], undefined);
  assert.equal(apiLockEntry.dependencies["node-pty"], undefined);
  assert.equal(cliHostPackage.dependencies["node-pty"], "^1.1.0");
});

test("the native PTY module loads on first spawn and receives the original arguments", () => {
  const childSource = String.raw`
    import assert from "node:assert/strict";
    import Module from "node:module";

    const originalLoad = Module._load;
    const spawnCalls = [];
    const ptyHandle = { pid: 12345 };
    let moduleLoads = 0;
    Module._load = function (request, parent, isMain) {
      if (request === "node-pty") {
        moduleLoads += 1;
        return { spawn(...args) { spawnCalls.push(args); return ptyHandle; } };
      }
      return Reflect.apply(originalLoad, this, [request, parent, isMain]);
    };

    const { spawnNodePty } = await import(process.env.SPACEAPP_NODE_PTY_SOURCE_URL);
    assert.equal(moduleLoads, 0, "importing the CLI host must not load node-pty");

    const spec = {
      command: "codex",
      args: ["--help", "two words"],
      cols: 123,
      rows: 45,
      cwd: "/work/project",
      env: { HOME: "/var/lib/spaceapp-cli", LANG: "C.UTF-8" }
    };
    assert.equal(spawnNodePty(spec), ptyHandle);
    assert.equal(moduleLoads, 1, "the first spawn must load node-pty once");
    assert.deepEqual(spawnCalls, [[
      "/bin/sh",
      ["-c", '/usr/bin/stty -isig; exec "$@"', "space-cli-host", "codex", "--help", "two words"],
      {
        name: "xterm-256color",
        cols: 123,
        rows: 45,
        cwd: "/work/project",
        env: { HOME: "/var/lib/spaceapp-cli", LANG: "C.UTF-8" }
      }
    ]]);

    const secondSpec = { ...spec, command: "claude", args: [], cols: 80, rows: 24 };
    assert.equal(spawnNodePty(secondSpec), ptyHandle);
    assert.equal(moduleLoads, 1, "subsequent spawns must reuse the loaded module");
    assert.equal(spawnCalls.length, 2);
    assert.deepEqual(spawnCalls[1][1], ["-c", '/usr/bin/stty -isig; exec "$@"', "space-cli-host", "claude"]);
    assert.equal(spawnCalls[1][2].cols, 80);
    assert.equal(spawnCalls[1][2].rows, 24);
  `;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", childSource], {
    encoding: "utf8",
    env: { ...process.env, SPACEAPP_NODE_PTY_SOURCE_URL: cliHostSourceUrl }
  });

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
