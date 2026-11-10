import { describe, expect, it } from "@effect/vitest";
import {
  conversationSummarySourceIdentity,
  MessageId,
  ThreadId,
  type ConversationSummaryRangeRef,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  buildSummaryTree,
  condensedPosition,
  handoffCover,
  leafPosition,
  planCondensation,
  type StoredSummary,
  type SummaryNode,
} from "./conversationSummaryTree.ts";

const threadId = ThreadId.make("tree-thread");
const at = (index: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(Date.UTC(2026, 0, 1, 0, index)));
const message = (index: number, range?: ConversationSummaryRangeRef["range"]) =>
  ({
    kind: "message",
    threadId,
    messageId: MessageId.make(`m${String(index).padStart(4, "0")}`),
    digest: "d".repeat(64),
    ...(range === undefined ? {} : { range }),
  }) as const;

const leaf = (id: string, sources: ReadonlyArray<ConversationSummaryRangeRef>): StoredSummary => ({
  id,
  sources,
  scrubbed: false,
  position: leafPosition(at(Number(id.slice(1))), sources[0]!),
});

/** A leaf per index covering one whole message. */
const leaves = (count: number) =>
  Array.from({ length: count }, (_, index) => leaf(`L${index}`, [message(index)]));

const parent = (id: string, children: ReadonlyArray<SummaryNode>): StoredSummary => ({
  id,
  sources: children.map((child) => ({ kind: "summary", threadId, summaryId: child.row.id })),
  scrubbed: false,
  position: condensedPosition(
    children[0]!.row.position,
    Math.max(...children.map((child) => child.depth)) + 1,
  ),
});

/** Sixteen leaves under four parents under one grandparent. */
function balanced() {
  const rows = leaves(16);
  const base = buildSummaryTree(rows, () => true).roots;
  rows.push(
    ...[0, 1, 2, 3].map((index) => parent(`P${index}`, base.slice(index * 4, index * 4 + 4))),
  );
  rows.push(parent("G", buildSummaryTree(rows, () => true).roots));
  return rows;
}

/** Append leaves one at a time and condense as the pass would, counting roll-ups. */
function grow(count: number) {
  const rows: Array<StoredSummary> = [];
  let rollups = 0;
  for (const row of leaves(count)) {
    rows.push(row);
    for (;;) {
      const group = planCondensation(buildSummaryTree(rows, () => true).roots);
      if (group === null) break;
      rows.push(parent(`P${rollups++}`, group));
    }
  }
  return { rows, rollups, roots: buildSummaryTree(rows, () => true).roots };
}

describe("planCondensation", () => {
  it.each([4, 16, 64, 200, 1000])(
    "keeps %i leaves shallow, absorbing four summaries per roll-up",
    (count: number) => {
      const { rows, rollups, roots } = grow(count);
      expect(rows.length - rollups).toBe(count);
      expect(roots.length).toBe(count - 3 * rollups);
      expect(Math.max(...roots.map((root) => root.depth))).toBeLessThanOrEqual(
        Math.ceil(Math.log(count) / Math.log(4)),
      );
      const densest = roots
        .map((root) => root.leafSources.length)
        .toSorted((a, b) => b - a)
        .slice(0, 5)
        .reduce((sum, size) => sum + size, 0);
      expect(densest / count).toBeGreaterThanOrEqual(count < 16 ? 0.5 : 0.9);
    },
  );

  it("prefers the lowest depth, then the oldest run", () => {
    const rows = [...grow(12).rows, ...leaves(20).slice(12)];
    const tree = buildSummaryTree(rows, () => true);
    expect(tree.roots.map((root) => root.depth)).toEqual([1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(planCondensation(tree.roots)?.map((node) => node.row.id)).toEqual([
      "L12",
      "L13",
      "L14",
      "L15",
    ]);
  });

  it("absorbs one odd root into a run of three deeper ones", () => {
    const tree = buildSummaryTree([...grow(12).rows, leaf("L12", [message(12)])], () => true);
    expect(planCondensation(tree.roots)?.map((node) => node.depth)).toEqual([1, 1, 1, 0]);
    expect(planCondensation(tree.roots.slice(0, 3))).toBeNull();
  });
});

describe("buildSummaryTree", () => {
  it("kills only the ancestors of a stale leaf and keeps their siblings as roots", () => {
    const tree = buildSummaryTree(balanced(), (row) => row.id !== "L5");
    expect(tree.dead.map((row) => row.id).toSorted()).toEqual(["G", "L5", "P1"]);
    expect(tree.roots.map((root) => root.row.id)).toEqual(["P0", "L4", "L6", "L7", "P2", "P3"]);
  });

  it("keeps a child with one parent when two passes raced", () => {
    const base = buildSummaryTree(leaves(5), () => true).roots;
    const first = parent("P-a", base.slice(0, 4));
    const second = parent("P-b", base.slice(1, 5));
    const tree = buildSummaryTree([...leaves(5), second, first], () => true);
    expect(tree.roots.map((root) => root.row.id)).toEqual(["P-a", "L4"]);
    expect(tree.dead.map((row) => row.id)).toEqual(["P-b"]);
  });
});

describe("handoffCover", () => {
  const identities = (count: number) =>
    new Set(
      Array.from({ length: count }, (_, index) =>
        conversationSummarySourceIdentity(message(index)),
      ),
    );

  it("uses the coarsest summaries and descends past an ineligible item", () => {
    const { roots } = buildSummaryTree(balanced(), () => true);
    const all = identities(16);
    expect(
      handoffCover({ roots, eligible: (id) => all.has(id), requested: (id) => all.has(id) }).map(
        (group) => group.nodes.map((node) => node.row.id),
      ),
    ).toEqual([["G"]]);
    const excluded = conversationSummarySourceIdentity(message(9));
    expect(
      handoffCover({
        roots,
        eligible: (id) => all.has(id) && id !== excluded,
        requested: (id) => all.has(id),
      }).map((group) => group.nodes.map((node) => node.row.id)),
    ).toEqual([["P0"], ["P1"], ["L8"], ["L10"], ["L11"], ["P3"]]);
    expect(
      handoffCover({ roots, eligible: (id) => all.has(id), requested: (id) => id === excluded }),
    ).toEqual([expect.objectContaining({ nodes: [roots[0]] })]);
  });

  it("groups summaries that share a split item and drops an incomplete one", () => {
    const half = (start: number, end: number) => message(1, { start, end, total: 20 });
    const rows = [
      leaf("L0", [message(0), half(0, 10)]),
      leaf("L1", [half(10, 20), message(2)]),
      leaf("L2", [message(3), message(4, { start: 0, end: 10, total: 20 })]),
    ];
    const all = identities(5);
    const cover = handoffCover({
      roots: buildSummaryTree(rows, () => true).roots,
      eligible: (id) => all.has(id),
      requested: (id) => all.has(id),
    });
    expect(cover.map((group) => group.nodes.map((node) => node.row.id))).toEqual([["L0", "L1"]]);
  });
});
