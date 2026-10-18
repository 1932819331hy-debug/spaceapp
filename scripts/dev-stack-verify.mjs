#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), "..");
const stateRoot = resolve(process.env.SPACE_DEV_STACK_DIR || join(root, ".dev-stack"));
const config = JSON.parse(await readFile(join(stateRoot, "config.json"), "utf8"));
const api = `http://127.0.0.1:${config.ports.api}`;
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function setCookieHeader(response) {
  const values = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  return values[0] || response.headers.get("set-cookie") || "";
}

function cookiePair(raw) {
  return raw.split(";", 1)[0] || "";
}

async function jsonRequest(path, { method = "GET", body, cookie, csrf } = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (csrf) headers["x-space-csrf-token"] = csrf;
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
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const { payload } = await jsonRequest("/readyz");
      if (payload?.ok === true && payload.dependencies?.database === "RUNNING" && payload.dependencies?.worker === "RUNNING" && payload.dependencies?.cliHost === "RUNNING") return payload;
    } catch {}
    await sleep(500);
  }
  throw new Error("Timed out waiting for the real source stack to become ready.");
}

const ready = await waitReady();
console.log(`[dev-stack-verify] PASS readiness database=${ready.dependencies.database} worker=${ready.dependencies.worker} cliHost=${ready.dependencies.cliHost}`);

const setupToken = (await readFile(join(stateRoot, "secrets", "setup-token"), "utf8")).trim();
const email = "dev-stack-ci@example.com";
const password = "dev-stack-ci-password-42!";
const claimed = await jsonRequest("/api/setup/claim", {
  method: "POST",
  body: { token: setupToken, email, password }
});
const cookie = cookiePair(setCookieHeader(claimed.response));
if (!cookie) throw new Error("Owner setup succeeded without returning a session cookie.");
const starterRoomId = claimed.payload?.starterRoomId;
if (typeof starterRoomId !== "string" || !starterRoomId.startsWith("room:")) throw new Error("Owner setup did not return a starter room id.");
console.log(`[dev-stack-verify] PASS owner setup starterRoom=${starterRoomId}`);

const csrfResponse = await jsonRequest("/api/auth/csrf", { cookie });
const csrf = csrfResponse.payload?.csrfToken;
if (typeof csrf !== "string" || !csrf) throw new Error("Authenticated owner session did not return a CSRF token.");

await jsonRequest(`/api/rooms/${encodeURIComponent(starterRoomId)}`, {
  method: "PATCH",
  cookie,
  csrf,
  body: { projectPath: root }
});
console.log("[dev-stack-verify] PASS starter room uses the source checkout instead of /opt/spaceapp");

const panesResponse = await jsonRequest(`/api/panes?roomId=${encodeURIComponent(starterRoomId)}`, { cookie });
const panesPayload = panesResponse.payload;
const panes = Array.isArray(panesPayload) ? panesPayload : (panesPayload?.data ?? panesPayload?.panes ?? []);
const openCodePane = panes.find((pane) => pane?.terminalRuntimeId === "cli:opencode" || (pane?.mode === "TERMINAL" && /OpenCode/i.test(pane?.title || "")));
if (!openCodePane?.id) throw new Error("Getting Started does not contain an OpenCode terminal pane.");

const started = await jsonRequest(`/api/panes/${encodeURIComponent(openCodePane.id)}/cli/session`, {
  method: "POST",
  cookie,
  csrf,
  body: { runtimeId: "cli:opencode" }
});
const initialStatus = started.payload?.session?.status ?? started.payload?.status ?? null;
console.log(`[dev-stack-verify] OpenCode start returned status=${initialStatus ?? "unknown"}`);

const deadline = Date.now() + 60_000;
let session = null;
while (Date.now() < deadline) {
  const current = await jsonRequest(`/api/panes/${encodeURIComponent(openCodePane.id)}/cli/session`, { cookie });
  session = current.payload?.session ?? current.payload;
  if (["RUNNING", "READY", "ATTACHED"].includes(session?.status)) break;
  if (["ERROR", "EXITED", "FAILED"].includes(session?.status)) {
    throw new Error(`OpenCode pane entered ${session.status}: ${session.statusReason || "no reason"}`);
  }
  await sleep(500);
}
if (!session || !["RUNNING", "READY", "ATTACHED"].includes(session.status)) {
  throw new Error(`OpenCode pane did not reach an active status; last status=${session?.status ?? "missing"}.`);
}
console.log(`[dev-stack-verify] PASS OpenCode pane active status=${session.status}`);

const finalReady = await jsonRequest("/readyz");
if (finalReady.payload?.ok !== true) throw new Error("Stack lost readiness after starting the OpenCode pane.");
console.log("[dev-stack-verify] PASS source-stack acceptance");
