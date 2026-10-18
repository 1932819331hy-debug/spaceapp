import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pidAlive, run } from "./dev-stack-lib.mjs";

const unsafeOverrideKeys = ["SPACE_DEV_STACK_DIR", "SPACE_DEV_COMPOSE_PROJECT"];
const ownershipFileName = ".ownership.json";
const processFileName = ".processes.json";

const ownershipFile = (config) => join(config.stateRoot, ownershipFileName);
const processFile = (config) => join(config.stateRoot, processFileName);

function isZombie(identity) {
  return typeof identity?.state === "string" && identity.state.startsWith("Z");
}

function processGroupExists(pgid) {
  if (process.platform === "win32" || !Number.isInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

export function assertSafeDevStackOverrides(env = process.env) {
  for (const key of unsafeOverrideKeys) {
    if (env[key] != null && env[key] !== "") {
      throw new Error(`${key} is intentionally unsupported: dev-stack state and Compose ownership are derived from this checkout so reset cannot target unrelated resources.`);
    }
  }
}

export async function readStateOwnership(config) {
  const path = ownershipFile(config);
  if (!existsSync(path)) return null;
  let parsed;
  try {
    parsed = JSON.parse((await readFile(path, "utf8")).trim());
  } catch {
    throw new Error("Dev-stack ownership record is corrupt; refusing destructive lifecycle operations.");
  }
  if (parsed?.version !== 1 || parsed.rootHash !== config.rootHash || parsed.project !== config.project || typeof parsed.createdStateRoot !== "boolean") {
    throw new Error("Dev-stack ownership record does not match this checkout; refusing destructive lifecycle operations.");
  }
  return parsed;
}

export async function assertOwnedState(config, { allowMissing = false } = {}) {
  if (!existsSync(config.stateRoot)) {
    if (allowMissing) return null;
    throw new Error("Dev-stack state directory is missing; ownership cannot be proven.");
  }
  const info = await lstat(config.stateRoot);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("Dev-stack state path is not an owned directory; refusing lifecycle operations.");
  }
  const record = await readStateOwnership(config);
  if (!record) throw new Error("Existing .dev-stack directory is not owned by dev:stack; refusing to modify or remove it.");
  return record;
}

export async function claimStateOwnership(config) {
  const existed = existsSync(config.stateRoot);
  if (existed) {
    const info = await lstat(config.stateRoot);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Existing .dev-stack path is not a safe directory.");
    const existing = await readStateOwnership(config);
    if (existing) return existing;
    const entries = await readdir(config.stateRoot);
    if (entries.length) {
      throw new Error("Existing .dev-stack directory was not initialized by dev:stack and is not empty; refusing to take ownership.");
    }
  } else {
    await mkdir(config.stateRoot, { recursive: false, mode: 0o700 });
  }

  const record = {
    version: 1,
    rootHash: config.rootHash,
    project: config.project,
    createdStateRoot: !existed
  };
  try {
    await writeFile(ownershipFile(config), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    return assertOwnedState(config);
  }
  return record;
}

async function psField(pid, field) {
  const result = await run("ps", ["-p", String(pid), "-o", `${field}=`], { capture: true, allowFailure: true });
  if (result.code !== 0 || !result.stdout) return null;
  return result.stdout.trim();
}

export async function processIdentity(pid) {
  if (!pidAlive(pid)) return null;
  const [startedAt, args, state, pgidRaw] = await Promise.all([
    psField(pid, "lstart"),
    psField(pid, "args"),
    psField(pid, "stat"),
    psField(pid, "pgid")
  ]);
  const pgid = Number.parseInt(pgidRaw || "", 10);
  if (!startedAt || !args || !state || !Number.isInteger(pgid)) return null;
  return { startedAt, args, state, pgid };
}

export function supervisorRecordMatches(config, record, identity) {
  if (!record || !identity || record.legacy === true || isZombie(identity)) return false;
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
  const identity = await identityProvider(record.pid);
  if (isZombie(identity)) {
    await rm(config.pidFile, { force: true });
    return null;
  }
  if (supervisorRecordMatches(config, record, identity)) return record.pid;
  if (strict) {
    throw new Error(`Refusing to signal PID ${record.pid}: the pidfile does not identify this checkout's dev-stack supervisor.`);
  }
  return null;
}

export async function claimSupervisor(config, identityProvider = processIdentity) {
  const existing = await readSupervisorRecord(config);
  if (existing) {
    if (!pidAlive(existing.pid)) {
      await rm(config.pidFile, { force: true });
    } else {
      const identity = await identityProvider(existing.pid);
      if (isZombie(identity)) {
        await rm(config.pidFile, { force: true });
      } else if (supervisorRecordMatches(config, existing, identity)) {
        throw new Error(`Dev stack is already running under supervisor ${existing.pid}.`);
      } else {
        throw new Error("A stale or unverified dev-stack supervisor record exists. Run `npm run dev:stack -- status` (or `down`) to clear a dead record before starting again; live unowned PIDs are never signalled or replaced.");
      }
    }
  }

  const identity = await identityProvider(process.pid);
  if (!identity?.startedAt || isZombie(identity)) throw new Error("Could not establish dev-stack supervisor process identity.");
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

export function managedProcessRecordMatches(config, record, identity) {
  if (!record || !identity) return false;
  if (!Number.isInteger(record.pid) || record.pid <= 1 || !Number.isInteger(record.pgid) || record.pgid <= 1) return false;
  return record.rootHash === config.rootHash
    && record.pid === record.pgid
    && identity.pgid === record.pgid
    && record.startedAt === identity.startedAt
    && record.args === identity.args;
}

export async function readManagedProcessRecords(config) {
  const path = processFile(config);
  if (!existsSync(path)) return [];
  let parsed;
  try {
    parsed = JSON.parse((await readFile(path, "utf8")).trim());
  } catch {
    throw new Error("Dev-stack managed-process record is corrupt; refusing to signal recorded PIDs.");
  }
  if (parsed?.version !== 1 || parsed.rootHash !== config.rootHash || !Array.isArray(parsed.processes)) {
    throw new Error("Dev-stack managed-process record does not belong to this checkout.");
  }
  return parsed.processes;
}

export async function writeManagedProcessRecords(config, processes) {
  const path = processFile(config);
  if (!processes.length) {
    await rm(path, { force: true });
    return;
  }
  await writeFile(path, `${JSON.stringify({ version: 1, rootHash: config.rootHash, processes }, null, 2)}\n`, { mode: 0o600 });
}

export async function ownedManagedProcessRecords(config, { strict = true, identityProvider = processIdentity } = {}) {
  const records = await readManagedProcessRecords(config);
  const owned = [];
  let changed = false;
  for (const record of records) {
    if (!Number.isInteger(record.pid) || record.pid <= 1 || record.pid !== record.pgid || record.rootHash !== config.rootHash) {
      if (strict) throw new Error("Refusing to use an invalid managed-process ownership record.");
      continue;
    }

    if (!pidAlive(record.pid)) {
      if (processGroupExists(record.pgid)) {
        // A POSIX process group cannot be replaced by a new group with the same PGID while
        // descendants of the recorded group still exist. With the original leader PID absent,
        // this is the only safe case where we may recover the recorded descendants by PGID.
        owned.push({ ...record, leaderExited: true });
      } else {
        changed = true;
      }
      continue;
    }

    const identity = await identityProvider(record.pid);
    if (!identity) {
      if (strict) throw new Error(`Refusing to signal PID ${record.pid}: process identity could not be established.`);
      continue;
    }
    if (!managedProcessRecordMatches(config, record, identity)) {
      if (strict) throw new Error(`Refusing to signal PID ${record.pid}: managed-process identity no longer matches the recorded dev-stack service.`);
      continue;
    }
    owned.push(record);
  }
  if (changed) await writeManagedProcessRecords(config, owned);
  return owned;
}
