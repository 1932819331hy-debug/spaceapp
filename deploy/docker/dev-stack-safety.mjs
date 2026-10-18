import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { pidAlive, run } from "./dev-stack-lib.mjs";

const unsafeOverrideKeys = ["SPACE_DEV_STACK_DIR", "SPACE_DEV_COMPOSE_PROJECT"];

export function assertSafeDevStackOverrides(env = process.env) {
  for (const key of unsafeOverrideKeys) {
    if (env[key] != null && env[key] !== "") {
      throw new Error(`${key} is intentionally unsupported: dev-stack state and Compose ownership are derived from this checkout so reset cannot target unrelated resources.`);
    }
  }
}

async function psField(pid, field) {
  const result = await run("ps", ["-p", String(pid), "-o", `${field}=`], { capture: true, allowFailure: true });
  if (result.code !== 0 || !result.stdout) return null;
  return result.stdout.trim();
}

export async function processIdentity(pid) {
  if (!pidAlive(pid)) return null;
  const [startedAt, args] = await Promise.all([
    psField(pid, "lstart"),
    psField(pid, "args")
  ]);
  if (!startedAt || !args) return null;
  return { startedAt, args };
}

export function supervisorRecordMatches(config, record, identity) {
  if (!record || !identity || record.legacy === true) return false;
  if (!Number.isInteger(record.pid) || record.pid <= 1) return false;
  if (record.rootHash !== config.rootHash || record.startedAt !== identity.startedAt) return false;
  return /(?:^|[\\/\s])dev-stack\.mjs(?:\s|$)/.test(identity.args);
}

export async function readSupervisorRecord(config) {
  if (!existsSync(config.pidFile)) return null;
  const raw = (await readFile(config.pidFile, "utf8")).trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Number.isInteger(parsed)) return { pid: parsed, legacy: true };
    return Number.isInteger(parsed?.pid) ? parsed : null;
  } catch {
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) ? { pid, legacy: true } : null;
  }
}

export async function isOwnedSupervisor(config, record = null, identityProvider = processIdentity) {
  const candidate = record ?? await readSupervisorRecord(config);
  if (!candidate || !pidAlive(candidate.pid)) return false;
  const identity = await identityProvider(candidate.pid);
  return supervisorRecordMatches(config, candidate, identity);
}

export async function ownedSupervisorPid(config, { strict = true, identityProvider = processIdentity } = {}) {
  const record = await readSupervisorRecord(config);
  if (!record) return null;
  if (!pidAlive(record.pid)) {
    await rm(config.pidFile, { force: true });
    return null;
  }
  if (await isOwnedSupervisor(config, record, identityProvider)) return record.pid;
  if (strict) {
    throw new Error(`Refusing to signal PID ${record.pid}: the pidfile does not identify this checkout's dev-stack supervisor.`);
  }
  return null;
}

export async function claimSupervisor(config, identityProvider = processIdentity) {
  const existing = await readSupervisorRecord(config);
  if (existing) {
    if (await isOwnedSupervisor(config, existing, identityProvider)) {
      throw new Error(`Dev stack is already running under supervisor ${existing.pid}.`);
    }
    throw new Error("A stale or unverified dev-stack supervisor record exists. Run `npm run dev:stack -- status` (or `down`) to clear a dead record before starting again; live unowned PIDs are never signalled or replaced.");
  }

  const identity = await identityProvider(process.pid);
  if (!identity?.startedAt) throw new Error("Could not establish dev-stack supervisor process identity.");
  const record = { pid: process.pid, rootHash: config.rootHash, startedAt: identity.startedAt };
  try {
    await writeFile(config.pidFile, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("Another dev-stack supervisor claimed this checkout while startup was in progress.");
    throw error;
  }
  return record;
}

export async function releaseSupervisor(config, pid = process.pid) {
  const record = await readSupervisorRecord(config);
  if (record?.pid === pid) await rm(config.pidFile, { force: true });
}
