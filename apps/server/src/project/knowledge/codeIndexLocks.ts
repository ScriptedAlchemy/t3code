// @effect-diagnostics nodeBuiltinImport:off - native SQLite lock handles; every call is a bounded synchronous filesystem step, and test processes load this module without the Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import {
  INDEX_DIRECTORY,
  generationDirectory,
  ignoreIndexDirectory,
  readPublishedGeneration,
  validateIndexDirectory,
} from "./codeIndexLayout.ts";

/**
 * Servers on one machine share a checkout's index, so its builder and readers coordinate through
 * SQLite's file locks (fcntl on POSIX, LockFileEx on Windows) on empty lock databases. The kernel
 * drops those locks when their process exits, however it exits, so a crashed server leaves no
 * record for a PID check to judge, and a recycled PID holds nothing.
 */
const BUILD_LOCK = "build.lock";
// Held alongside the build lock. Only builders touch the build lock, so a query's probe goes here.
const BUILDING_LOCK = "building.lock";
// In each generation: readers hold it shared, and a deleter must take it exclusively.
const READERS_LOCK = "readers.lock";
// Waits out the momentary locks of probes and failed deletion attempts, never a build or a read.
const MOMENTARY_LOCK_WAIT_MS = 1_000;

const SQLITE_BUSY = 5;
const SQLITE_CANTOPEN = 14;
const sqliteCode = (cause: unknown) =>
  cause instanceof Error && "errcode" in cause && typeof cause.errcode === "number"
    ? cause.errcode & 0xff
    : undefined;

/** The connection holding `path`'s exclusive lock, or null while another connection holds a lock. */
function lockExclusive(path: string, waitMs: number): NodeSqlite.DatabaseSync | null {
  const database = new NodeSqlite.DatabaseSync(path);
  try {
    // With no journal the lock never creates a -journal file beside it.
    database.exec(`PRAGMA busy_timeout = ${waitMs}; PRAGMA journal_mode = OFF; BEGIN EXCLUSIVE;`);
    return database;
  } catch (cause) {
    database.close();
    if (sqliteCode(cause) === SQLITE_BUSY) return null;
    throw cause;
  }
}

/**
 * A shared lock on `path`: null while an exclusive holder keeps it, "missing" when the file
 * cannot be opened. A reader creates the file and waits out momentary locks; a probe does neither.
 */
function lockShared(path: string, role: "reader" | "probe") {
  let database: NodeSqlite.DatabaseSync;
  try {
    database = new NodeSqlite.DatabaseSync(path, { readOnly: role === "probe" });
  } catch (cause) {
    if (sqliteCode(cause) === SQLITE_CANTOPEN) return "missing" as const;
    throw cause;
  }
  try {
    database.exec(
      `PRAGMA busy_timeout = ${role === "reader" ? MOMENTARY_LOCK_WAIT_MS : 0}; BEGIN; SELECT count(*) FROM sqlite_master;`,
    );
    return database;
  } catch (cause) {
    database.close();
    if (sqliteCode(cause) === SQLITE_BUSY) return null;
    throw cause;
  }
}

/** Takes the checkout's build lock and returns its release, or null while another builder holds it. */
export function tryLockBuild(checkoutPath: string): (() => void) | null {
  const control = NodePath.join(checkoutPath, INDEX_DIRECTORY);
  NodeFS.mkdirSync(control, { recursive: true });
  validateIndexDirectory(checkoutPath, INDEX_DIRECTORY);
  ignoreIndexDirectory(checkoutPath, INDEX_DIRECTORY);
  const build = lockExclusive(NodePath.join(control, BUILD_LOCK), 0);
  if (build === null) return null;
  try {
    const building = lockExclusive(NodePath.join(control, BUILDING_LOCK), MOMENTARY_LOCK_WAIT_MS);
    if (building === null) throw new Error("building-lock-unavailable");
    return () => {
      building.close();
      build.close();
    };
  } catch (cause) {
    build.close();
    throw cause;
  }
}

const closeLock = (lock: ReturnType<typeof lockShared>) => {
  if (lock !== null && lock !== "missing") lock.close();
};

/** Whether any process, this one included, is building the checkout's index now. */
export function isBuildRunning(checkoutPath: string): boolean {
  try {
    const probe = lockShared(NodePath.join(checkoutPath, INDEX_DIRECTORY, BUILDING_LOCK), "probe");
    closeLock(probe);
    return probe === null;
  } catch {
    return false;
  }
}

/**
 * Deletes `generation` unless a reader in any process holds it. Its last reader deletes it
 * instead. Callers ensure no build writes it: the builder holds the build lock, and a reader
 * removes only generations older than the published one.
 */
export function removeGenerationUnlessRead(checkoutPath: string, generation: number): void {
  const name = generationDirectory(generation);
  const directory = NodePath.join(checkoutPath, name);
  try {
    validateIndexDirectory(checkoutPath, name);
  } catch {
    // Nothing reads a generation that fails validation; `rm` unlinks a planted link unfollowed.
    NodeFS.rmSync(directory, { recursive: true, force: true });
    return;
  }
  let lock: NodeSqlite.DatabaseSync | null;
  try {
    lock = lockExclusive(NodePath.join(directory, READERS_LOCK), 0);
  } catch (cause) {
    if (sqliteCode(cause) === SQLITE_CANTOPEN) return;
    throw cause;
  }
  if (lock === null) return;
  try {
    // Windows cannot delete the open lock file, so it goes after the lock is released.
    for (const entry of NodeFS.readdirSync(directory)) {
      if (entry !== READERS_LOCK) {
        NodeFS.rmSync(NodePath.join(directory, entry), { recursive: true, force: true });
      }
    }
  } finally {
    lock.close();
  }
  NodeFS.rmSync(directory, { recursive: true, force: true });
}

export interface GenerationPin {
  readonly generation: number | null;
  readonly release: () => void;
}

const unpinned = (generation: number | null): GenerationPin => ({
  generation,
  release: () => undefined,
});

/**
 * Holds the published generation for a read until `release`. The pointer is read again once the
 * lock is held: a generation is deleted only after it stops being published, and never published
 * again, so a pin that still finds it published holds a lock its deleter has to wait for.
 */
export function pinPublishedGeneration(checkoutPath: string): GenerationPin {
  let generation = readPublishedGeneration(checkoutPath);
  while (generation !== null) {
    const name = generationDirectory(generation);
    validateIndexDirectory(checkoutPath, name);
    const lock = lockShared(NodePath.join(checkoutPath, name, READERS_LOCK), "reader");
    let current: number | null;
    try {
      current = readPublishedGeneration(checkoutPath);
    } catch (cause) {
      closeLock(lock);
      throw cause;
    }
    if (current === generation) {
      // A missing published directory reads as unindexed; there is nothing in it to protect.
      if (lock === "missing") return unpinned(generation);
      if (lock === null) throw new Error("published-generation-locked");
      const pinned = generation;
      return {
        generation: pinned,
        release: () => {
          lock.close();
          retireIfSuperseded(checkoutPath, pinned);
        },
      };
    }
    closeLock(lock);
    generation = current;
  }
  return unpinned(null);
}

function retireIfSuperseded(checkoutPath: string, generation: number): void {
  try {
    const published = readPublishedGeneration(checkoutPath);
    // Builds write only generations newer than the published one.
    if (published !== null && generation < published) {
      removeGenerationUnlessRead(checkoutPath, generation);
    }
  } catch {
    // The next build sweeps a generation left behind.
  }
}
