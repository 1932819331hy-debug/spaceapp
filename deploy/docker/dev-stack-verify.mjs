#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const stateRoot = resolve(process.env.SPACE_DEV_STACK_DIR || join(root, ".dev-stack"));
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function waitForJson(path, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }
  throw new Error(`Timed out waiting for source-stack bootstrap file ${path}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

const config = await waitForJson(join(stateRoot, "config.json"));
const api = `http://127.0.0.1:${config.ports.api}`;

function firstCookie(response) {
  const values = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  return (values[0] || response.headers.get("set-cookie") || "").split(";", 1)[0] || "";
}

async function request(path, { method = "GET", body, cookie, csrf, csrfHeader = "x-space-csrf-token" } = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (csrf) headers[csrfHeader] = csrf;
  const response = await fetch(`${api}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}): ${text.slice(0, 800)}`);
  return { response, payload };
}

async function waitReady() {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const { payload } = await request("/readyz");
      if (payload?.ok === true && payload.dependencies?.database === "RUNNING" && payload.dependencies?.worker === "RUNNING" && payload.dependencies?.cliHost === "RUNNING") return payload;
    } catch {}
    await sleep(500);
  }
  throw new Error("Timed out waiting for real source-stack readiness.");
}

const ready = await waitReady();
console.log(`[dev-stack-verify] PASS readiness database=${ready.dependencies.database} worker=${ready.dependencies.worker} cliHost=${ready.dependencies.cliHost}`);

const setupToken = (await readFile(join(stateRoot, "secrets", "setup-token"), "utf8")).trim();
const email = "dev-stack-ci@example.com";
const password = "dev-stack-ci-password-42!";
const claimed = await request("/api/setup/claim", {
  method: "POST",
  body: { token: setupToken, email, password }
});
const starterRoomId = claimed.payload?.starterRoomId;
if (typeof starterRoomId !== "string" || !starterRoomId.startsWith("room:")) throw new Error("Owner setup did not return the Getting Started room id.");
if (!firstCookie(claimed.response)) throw new Error("Owner setup succeeded without returning a session cookie.");
console.log(`[dev-stack-verify] PASS owner setup starterRoom=${starterRoomId}`);

const login = await request("/api/auth/login", {
  method: "POST",
  body: { email, password }
});
const cookie = firstCookie(login.response);
if (!cookie || login.payload?.isAuthenticated !== true || login.payload?.user?.role !== "ADMIN") {
  throw new Error("The owner created by setup could not sign in with its configured credentials.");
}
console.log("[dev-stack-verify] PASS owner credentials sign in through /api/auth/login");

const csrfResponse = await request("/api/auth/csrf", { cookie });
const csrf = csrfResponse.payload?.csrfToken;
const csrfHeader = csrfResponse.payload?.headerName || "x-space-csrf-token";
if (typeof csrf !== "string" || !csrf) throw new Error("Authenticated owner session did not return a CSRF token.");

await request(`/api/rooms/${encodeURIComponent(starterRoomId)}`, {
  method: "PATCH",
  cookie,
  csrf,
  csrfHeader,
  body: { projectPath: root }
});
console.log("[dev-stack-verify] PASS starter room points at the source checkout");

const panesResponse = await request(`/api/panes?roomId=${encodeURIComponent(starterRoomId)}`, { cookie });
const payload = panesResponse.payload;
const panes = Array.isArray(payload) ? payload : (payload?.data ?? payload?.panes ?? []);
const pane = panes.find((candidate) => candidate?.terminalRuntimeId === "cli:opencode" || (candidate?.mode === "TERMINAL" && /OpenCode/i.test(candidate?.title || "")));
if (!pane?.id) throw new Error("Getting Started does not contain an OpenCode terminal pane.");

const started = await request(`/api/panes/${encodeURIComponent(pane.id)}/cli/session`, {
  method: "POST",
  cookie,
  csrf,
  csrfHeader,
  body: { runtimeId: "cli:opencode" }
});
console.log(`[dev-stack-verify] OpenCode start returned status=${started.payload?.session?.status ?? started.payload?.status ?? "unknown"}`);

const deadline = Date.now() + 60_000;
let session = null;
while (Date.now() < deadline) {
  const current = await request(`/api/panes/${encodeURIComponent(pane.id)}/cli/session`, { cookie });
  session = current.payload?.session ?? current.payload;
  if (["RUNNING", "READY", "ATTACHED"].includes(session?.status)) break;
  if (["ERROR", "EXITED", "FAILED"].includes(session?.status)) throw new Error(`OpenCode pane entered ${session.status}: ${session.statusReason || "no reason"}`);
  await sleep(500);
}
if (!session || !["RUNNING", "READY", "ATTACHED"].includes(session.status)) throw new Error(`OpenCode pane did not become active; last status=${session?.status ?? "missing"}.`);
console.log(`[dev-stack-verify] PASS OpenCode pane active status=${session.status}`);

const finalReady = await request("/readyz");
if (finalReady.payload?.ok !== true) throw new Error("Stack lost readiness after starting OpenCode.");
console.log("[dev-stack-verify] PASS source-stack acceptance");
