import fs from "node:fs";

// Cross-process mutex for the JSON "load -> mutate -> save" stores in this
// project (outreach-log.json, negotiation-state.json, youtube-quota.json,
// gmail-send-quota.json). Without this, two processes touching the same
// file concurrently (e.g. the web dashboard left running while a CLI script
// like `report` or `followups` also writes) can both load stale state, then
// the second save silently clobbers the first — a lost update, not a crash,
// which makes it easy to miss.
//
// mkdir is atomic on the same filesystem even across processes (unlike a
// plain file existence check + write), so a lock is just "can I mkdir the
// .lock directory" — first one to succeed holds the lock, everyone else
// retries until it's gone.

const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 5000; // a lock older than this is assumed abandoned by a crashed process, not held

function tryAcquire(lockPath: string): boolean {
  try {
    fs.mkdirSync(lockPath);
    return true;
  } catch (err: any) {
    if (err.code !== "EEXIST") throw err;
    return false;
  }
}

function clearIfStale(lockPath: string) {
  try {
    const age = Date.now() - fs.statSync(lockPath).mtimeMs;
    if (age > LOCK_STALE_MS) fs.rmdirSync(lockPath);
  } catch {
    // Lock disappeared between our check and stat, or another process
    // already cleared it — either way, the next tryAcquire will sort it out.
  }
}

async function acquireLock(lockPath: string): Promise<void> {
  while (!tryAcquire(lockPath)) {
    clearIfStale(lockPath);
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
}

function releaseLock(lockPath: string) {
  try {
    fs.rmdirSync(lockPath);
  } catch {
    // Already released (e.g. force-cleared as stale by another waiter) — fine.
  }
}

// Runs `fn` (a synchronous load -> mutate -> save sequence) while holding an
// exclusive lock on `filePath + ".lock"`, so no other process can interleave
// its own read/write in between.
export async function withFileLock<T>(filePath: string, fn: () => T): Promise<T> {
  const lockPath = `${filePath}.lock`;
  await acquireLock(lockPath);
  try {
    return fn();
  } finally {
    releaseLock(lockPath);
  }
}
