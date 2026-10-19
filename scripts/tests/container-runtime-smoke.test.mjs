import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createContainerRuntimeSmokeScript, runContainerRuntimeSmoke } from "../container-runtime-smoke.mjs";
import { stageContainerTarget } from "../stage-container-targets.mjs";

async function write(root, path, contents) {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
}

function fakeDockerRunner({ runId, target, readiness = "ready", probeRunning = false, probeStartTimeout = false, ownershipFailure = false }) {
  const calls = [];
  return {
    calls,
    async runner(command, args, options) {
      assert.equal(command, "docker");
      assert.ok(options.timeoutMs > 0);
      calls.push(args);
      if (args[0] === "network" && args[1] === "create") return { code: 0, stdout: "network-id\n", stderr: "" };
      if (args[0] === "run" && args.includes("--detach")) {
        const name = args[args.indexOf("--name") + 1];
        if (probeStartTimeout && name.endsWith("-probe")) return { code: null, stdout: "", stderr: "docker client timed out", timedOut: true };
        return { code: 0, stdout: `container-${name}\n`, stderr: "" };
      }
      if (args[0] === "run") return { code: 0, stdout: "runtime probe passed\n", stderr: "" };
      if (args[0] === "container" && args[1] === "inspect") {
        const format = args[3];
        if (format === "{{.State.Health.Status}}") return { code: 0, stdout: "healthy\n", stderr: "" };
        if (format === "{{.State.Status}}") return { code: 0, stdout: `${probeRunning && args.at(-1).includes("-probe") ? "running" : "exited"}\n`, stderr: "" };
        if (format === "{{.State.ExitCode}}") return { code: 0, stdout: "0\n", stderr: "" };
        if (format === "{{.State.Running}}") return { code: 0, stdout: "true\n", stderr: "" };
        if (format?.includes(".Config.Labels")) return ownershipFailure
          ? { code: 1, stdout: "", stderr: "Docker daemon unavailable\n" }
          : { code: 0, stdout: `${runId}\n`, stderr: "" };
      }
      if (args[0] === "network" && args[1] === "inspect") return ownershipFailure
        ? { code: 1, stdout: "", stderr: "Docker daemon unavailable\n" }
        : { code: 0, stdout: `${runId}\n`, stderr: "" };
      if (args[0] === "exec") {
        const inline = args.at(-1);
        if (inline.includes("/readyz")) {
          const ok = readiness === "ready";
          return { code: ok ? 0 : 2, stdout: JSON.stringify({ status: 200, body: { ok } }) + "\n", stderr: "" };
        }
        if (inline.includes("BrowserHostClient")) return { code: 0, stdout: '{"hostPid":123,"status":{"enabled":true,"statusReason":"Managed Chrome browser sessions are enabled."}}\n', stderr: "" };
        if (args.includes("/usr/bin/chromium")) return { code: 0, stdout: "<html>spaceapp-browser-smoke</html>\n", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "logs") return { code: 0, stdout: "bounded smoke logs\n", stderr: "" };
      if (args[0] === "container" && args[1] === "rm") return { code: 0, stdout: "removed\n", stderr: "" };
      if (args[0] === "network" && args[1] === "rm") return { code: 0, stdout: "removed\n", stderr: "" };
      throw new Error(`Unexpected fake Docker invocation for ${target}: ${args.join(" ")}`);
    }
  };
}

test("container runtime smoke scripts parse and resolve the staged import graph", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "spaceapp-smoke-script-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  for (const target of ["core", "browser", "cli"]) {
    const path = join(directory, `${target}.mjs`);
    const script = createContainerRuntimeSmokeScript(target);
    await writeFile(path, script);
    execFileSync(process.execPath, ["--check", path], { stdio: "pipe" });
    assert.match(script, /import\.meta\.resolve\(specifier\)/);
    assert.match(script, /container-runtime-manifest\.json/);
  }

  const cliScript = createContainerRuntimeSmokeScript("cli");
  assert.doesNotMatch(cliScript, /packages\/cli-host\/dist\/client\.js/);
  assert.match(cliScript, /createConnection as netCreateConnection/);

  assert.throws(() => createContainerRuntimeSmokeScript("unknown"), /Unknown container target/);
});

test("CLI smoke pings the staged host protocol without importing the unstaged client graph", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "spaceapp-cli-smoke-graph-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source");
  const output = join(directory, "output");

  await mkdir(join(source, "apps"), { recursive: true });
  await write(source, "agent-skills/README.md", "smoke fixture\n");
  await write(source, "package.json", JSON.stringify({ name: "fixture", type: "module" }));
  await write(source, "packages/cli-host/package.json", JSON.stringify({ name: "@space/cli-host", type: "module" }));
  await write(source, "packages/cli-host/dist/main.js", 'import "./server.js";\n');
  await write(source, "packages/cli-host/dist/server.js", "export {};\n");
  // The production CLI client is intentionally outside main.js's runtime graph.
  await write(source, "packages/cli-host/dist/client.js", 'throw new Error("client.js should not be needed by the CLI smoke");\n');
  await write(source, "node_modules/node-pty/package.json", JSON.stringify({ name: "node-pty", main: "index.cjs" }));
  await write(source, "node_modules/node-pty/index.cjs", "module.exports = {};\n");

  const staged = join(output, "cli");
  await stageContainerTarget({ source, output: staged, target: "cli" });
  await assert.rejects(readFile(join(staged, "packages/cli-host/dist/client.js")), { code: "ENOENT" });

  const fakeProcessAndSocket = `import {EventEmitter} from "node:events";
const cp = {
  spawnSync: () => ({status: 0, stderr: ""}),
  spawn: () => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = signal => {
      child.signalCode = signal;
      queueMicrotask(() => child.emit("exit", null, signal));
    };
    return child;
  }
};
function netCreateConnection() {
  const socket = new EventEmitter();
  socket.destroy = () => {};
  socket.write = frame => {
    const requestLength = frame.readUInt32BE(0);
    const request = JSON.parse(frame.subarray(4, 4 + requestLength).toString("utf8"));
    const payload = Buffer.from(JSON.stringify({kind:"response", requestId:request.requestId, ok:true, result:{ok:true}}));
    const response = Buffer.allocUnsafe(4 + payload.length);
    response.writeUInt32BE(payload.length, 0);
    payload.copy(response, 4);
    queueMicrotask(() => socket.emit("data", response));
  };
  queueMicrotask(() => socket.emit("connect"));
  return socket;
}
`;
  const script = createContainerRuntimeSmokeScript("cli")
    .replace('import cp from \'node:child_process\';', fakeProcessAndSocket)
    .replace('import {createConnection as netCreateConnection} from \'node:net\';', "")
    .replaceAll("'/app/", `'${staged}/`)
    .replaceAll("'/app'", JSON.stringify(staged));
  execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: staged,
    timeout: 8_000,
    stdio: "pipe"
  });
});

test("core and browser runtime smokes use isolated PostgreSQL and clean up only owned resources", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "spaceapp-runtime-smoke-driver-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runId = "11111111-1111-4111-8111-111111111111";

  for (const target of ["core", "browser"]) {
    const fake = fakeDockerRunner({ runId, target });
    const temp = join(directory, target);
    await mkdir(temp, { recursive: true });
    const result = await runContainerRuntimeSmoke(["--target", target, "--image", `smoke:${target}`], {
      runner: fake.runner,
      temporaryDirectory: temp,
      runId,
      repoRoot: new URL("../..", import.meta.url).pathname
    });
    assert.equal(result.target, target);
    assert.ok(fake.calls.some(args => args[0] === "network" && args[1] === "create"));
    assert.ok(fake.calls.some(args => args[0] === "run" && args.includes("POSTGRES_PASSWORD=smoke-" + runId)));
    assert.ok(fake.calls.some(args => args[0] === "container" && args[1] === "rm" && args.includes("--force")));
    assert.ok(fake.calls.some(args => args[0] === "network" && args[1] === "rm"));
    if (target === "core") {
      assert.match(result.result, /migrations ran/);
      assert.ok(fake.calls.some(args => args[0] === "exec" && args.at(-1).includes("/readyz")));
      assert.ok(fake.calls.some(args => args[0] === "run" && args.some(value => value.includes("target=/run/secrets/database-url"))));
    } else {
      assert.match(result.result, /Browser Host socket health/);
      assert.ok(fake.calls.some(args => args[0] === "run" && args.at(-1) === "/app/packages/db/dist/migrate.js"));
      assert.ok(fake.calls.some(args => args[0] === "exec" && args.at(-1).includes("BrowserHostClient")));
      assert.ok(fake.calls.some(args => args[0] === "exec" && args.includes("/usr/bin/chromium")));
    }
  }
});

test("core smoke fails closed on /readyz false, reports logs, and still removes its resources", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "spaceapp-runtime-smoke-timeout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runId = "22222222-2222-4222-8222-222222222222";
  const fake = fakeDockerRunner({ runId, target: "core", readiness: "false" });
  let logicalTime = 0;
  const temp = join(directory, "core");
  await mkdir(temp, { recursive: true });
  await assert.rejects(runContainerRuntimeSmoke(["--target", "core", "--image", "smoke:core"], {
    runner: fake.runner,
    sleep: async (delay) => { logicalTime += delay; },
    now: () => logicalTime,
    temporaryDirectory: temp,
    runId
  }), /timed out[\s\S]*bounded smoke logs/);
  assert.ok(fake.calls.some(args => args[0] === "container" && args[1] === "rm" && args.includes("--force")));
  assert.ok(fake.calls.some(args => args[0] === "network" && args[1] === "rm"));
});

test("smoke reports unverified ownership without deleting resources", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "spaceapp-runtime-smoke-ownership-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runId = "33333333-3333-4333-8333-333333333333";
  const fake = fakeDockerRunner({ runId, target: "core", ownershipFailure: true });
  const temp = join(directory, "core");
  await mkdir(temp, { recursive: true });

  await assert.rejects(runContainerRuntimeSmoke(["--target", "core", "--image", "smoke:core"], {
    runner: fake.runner,
    temporaryDirectory: temp,
    runId,
    repoRoot: new URL("../..", import.meta.url).pathname
  }), /Cleanup failed:[\s\S]*Could not verify ownership of container spaceapp-smoke-core-[\s\S]*network spaceapp-smoke-core-/);
  assert.equal(fake.calls.some(args => args[0] === "container" && args[1] === "rm"), false);
  assert.equal(fake.calls.some(args => args[0] === "network" && args[1] === "rm"), false);
});

test("timed-out CLI probe start is stopped through owned-container cleanup", async (t) => {
  const runId = "44444444-4444-4444-8444-444444444444";
  const fake = fakeDockerRunner({ runId, target: "cli", probeStartTimeout: true });

  await assert.rejects(runContainerRuntimeSmoke(["--target", "cli", "--image", "smoke:cli"], {
    runner: fake.runner,
    runId
  }), /Timed out: docker run --detach/);
  assert.ok(fake.calls.some(args => args[0] === "run" && args.includes("--detach") && args.some(value => value.includes("--name") || value.includes("spaceapp-smoke-cli-"))));
  assert.ok(fake.calls.some(args => args[0] === "container" && args[1] === "rm" && args.includes("--force")));
  assert.equal(fake.calls.some(args => args[0] === "network" && args[1] === "create"), false);
});
