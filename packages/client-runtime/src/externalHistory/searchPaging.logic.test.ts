import type { ExternalHistoryResponse } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import {
  externalHistoryPagingReducer as reduce,
  initialExternalHistoryPaging,
} from "./searchPaging.logic.ts";

type Page = Extract<ExternalHistoryResponse, { operation: "search" }>;
function page(nextCursor: string | null, matched = false): Page {
  return {
    operation: "search",
    nextCursor,
    examinedItems: 100,
    matches: matched
      ? [
          {
            ref: { sourceId: "claude", threadId: "thread", readCursor: "read", digest: "digest" },
            threadTitle: "Thread",
            itemId: "item",
            role: "user",
            excerpt: "needle",
            textOffset: 0,
            totalChars: 6,
          },
        ]
      : [],
  };
}

it("follows consecutive empty pages and keeps only matching pages in previous navigation", () => {
  let state = initialExternalHistoryPaging();
  for (const [cursor, nextCursor] of [
    [undefined, "empty"],
    ["empty", "first-match"],
  ] as const) {
    state = reduce(state, {
      type: "page",
      cursor,
      page: { ...page(nextCursor), examinedItems: cursor === undefined ? 0 : 100 },
    });
    expect(state.status).toBe("searching");
    expect(state.previous).toEqual([]);
  }
  state = reduce(state, { type: "page", cursor: "first-match", page: page("another-empty", true) });
  expect(state.status).toBe("ready");
  expect(state.examinedItems).toBe(200);
  expect(reduce(state, { type: "previous" })).toBe(state);
  state = reduce(state, { type: "next" });
  state = reduce(state, { type: "page", cursor: "another-empty", page: page("last-match") });
  state = reduce(state, { type: "page", cursor: "last-match", page: page(null, true) });
  expect(state.previous).toEqual(["first-match"]);
  expect(reduce(state, { type: "next" })).toBe(state);
  state = reduce(state, { type: "previous" });
  expect(state.cursor).toBe("first-match");
  expect(state.previous).toEqual([]);
});

it("finishes an exhausted search and preserves the first matching page's undefined cursor", () => {
  let state = reduce(initialExternalHistoryPaging(), {
    type: "page",
    cursor: undefined,
    page: page("empty", true),
  });
  state = reduce(state, { type: "next" });
  state = reduce(state, { type: "page", cursor: "empty", page: page(null) });
  expect(state.status).toBe("ready");
  expect(state.examinedItems).toBe(200);
  expect(state.previous).toEqual([undefined]);
  state = reduce(state, { type: "previous" });
  expect(state.cursor).toBeUndefined();
  expect(state.status).toBe("searching");
  const exhausted = reduce(initialExternalHistoryPaging(), {
    type: "page",
    cursor: undefined,
    page: page(null),
  });
  expect(exhausted.status).toBe("ready");
  expect(reduce(exhausted, { type: "next" })).toBe(exhausted);
  expect(reduce(exhausted, { type: "previous" })).toBe(exhausted);
});

it("stops scanning, ignores late or duplicate responses, and resumes from the pending cursor", () => {
  let state = reduce(initialExternalHistoryPaging(), {
    type: "page",
    cursor: undefined,
    page: page("pending"),
  });
  expect(reduce(state, { type: "page", cursor: undefined, page: page("pending") })).toBe(state);
  state = reduce(state, { type: "stop" });
  expect(state.status).toBe("stopped");
  expect(reduce(state, { type: "page", cursor: "pending", page: page(null, true) })).toBe(state);
  expect(state.examinedItems).toBe(100);
  state = reduce(state, { type: "resume" });
  expect(state.cursor).toBe("pending");
  state = reduce(state, { type: "page", cursor: "pending", page: page(null, true) });
  expect(state.status).toBe("ready");
  expect(state.examinedItems).toBe(200);
  expect(reduce(state, { type: "page", cursor: "pending", page: page(null, true) })).toBe(state);
  expect(reduce(state, { type: "stop" })).toBe(state);
});
