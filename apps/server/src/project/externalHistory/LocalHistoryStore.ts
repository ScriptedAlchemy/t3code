import type { ExternalHistoryError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as FileSystem from "effect/FileSystem";
import type { TranscriptItem } from "../agentTranscripts.ts";

export interface LocalThreadRef {
  readonly key: string;
  readonly title?: string;
  readonly cwd?: string;
  readonly updatedAt: number;
  readonly version: string;
}

export interface LocalThread {
  readonly version: string;
  readonly title: string;
  readonly cwd: string | null;
  readonly items: ReadonlyArray<TranscriptItem>;
  readonly origin?: "t3";
}

export interface LocalHistoryStore {
  readonly listThreads: Effect.Effect<ReadonlyArray<LocalThreadRef>, ExternalHistoryError>;
  readonly loadThread: (ref: LocalThreadRef) => Effect.Effect<LocalThread, ExternalHistoryError>;
}

export type ThreadCache = (
  key: string,
  load: Effect.Effect<LocalThread, ExternalHistoryError>,
) => Effect.Effect<LocalThread, ExternalHistoryError>;

export const makeThreadCache = Effect.sync((): ThreadCache => {
  const entries = new Map<string, { thread: LocalThread; bytes: number }>();
  let bytes = 0;
  return Effect.fn("ExternalHistory.cachedThread")(function* (key, load) {
    const cached = entries.get(key);
    if (cached) {
      entries.delete(key);
      entries.set(key, cached);
      return cached.thread;
    }
    const thread = yield* load;
    const size = thread.items.reduce(
      (sum, item) => sum + 2 * (item.text.length + item.id.length),
      0,
    );
    if (size <= 32 * 1024 * 1024) {
      const replaced = entries.get(key);
      if (replaced) bytes -= replaced.bytes;
      entries.delete(key);
      while (entries.size >= 64 || bytes + size > 32 * 1024 * 1024) {
        const oldest = entries.entries().next().value;
        if (!oldest) break;
        entries.delete(oldest[0]);
        bytes -= oldest[1].bytes;
      }
      entries.set(key, { thread, bytes: size });
      bytes += size;
    }
    return thread;
  });
});

export function fileVersion(info: FileSystem.File.Info): string {
  return JSON.stringify({
    size: String(info.size),
    dev: String(info.dev),
    ino: Option.map(info.ino, String).pipe(Option.getOrNull),
    mtime: Option.map(info.mtime, (date) => date.getTime()).pipe(Option.getOrNull),
    birthtime: Option.map(info.birthtime, (date) => date.getTime()).pipe(Option.getOrNull),
  });
}
