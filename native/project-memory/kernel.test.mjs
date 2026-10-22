import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import * as NodeTest from "node:test";
import * as NodeEvents from "node:events";
import * as NodeWorkerThreads from "node:worker_threads";

const kernel = NodeModule.createRequire(import.meta.url)(
  `./build/project-memory-${process.platform}-${process.arch}.node`,
);
const digest = (values) => {
  const bytes = Buffer.alloc(values.length * 8);
  values.forEach((value, index) => bytes.writeDoubleLE(value, index * 8));
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
};

NodeTest.test("Node loads the original finite coefficient fixtures", async () => {
  const cases = [
    ["", [], "0c08ff5e22e7be2347afb9f78422791d5bbc914c49d704a52693c5aa5d049390"],
    ["a b", [" "], "0c08ff5e22e7be2347afb9f78422791d5bbc914c49d704a52693c5aa5d049390"],
    [
      "duplicate duplicate words",
      ["SQLite", "sqlite", "Grafeo"],
      "2de528046e516045c693b05a64cae2cb4315387d66c4e7ff5d217f4e6902706b",
    ],
    [
      "Grüße 東京 naïve café",
      ["Ünïcode", "東京"],
      "1b37fe065aec12b6900dabb6f798212da901b125eb2de36de58eb951a7a5c472",
    ],
    [
      "src/memory/encoding.rs crate::memory::encoding v1.2",
      ["path/to/file.rs", "crate::memory"],
      "d1f062a392f72a47b4bd48e2091ac17b01031ff2a2e9196afdb18775ff195213",
    ],
  ];
  for (const [content, entities, expected] of cases) {
    const vector = await kernel.encodeFact(content, entities);
    NodeAssert.ok(vector instanceof Float64Array);
    NodeAssert.equal(vector.length, 2048);
    NodeAssert.equal(digest(vector), expected);
    NodeAssert.equal(digest(await kernel.encodeFact(content, entities.toReversed())), expected);
  }
});

NodeTest.test("raw cosine preserves dimension errors and signed zero", () => {
  NodeAssert.throws(() => kernel.cosine(new Float64Array(3), new Float64Array(2048)), {
    code: "InvalidArg",
  });
  const left = Float64Array.from({ length: 2048 }, (_, i) => (i % 2 === 0 ? 1 : 0));
  const right = Float64Array.from({ length: 2048 }, (_, i) => (i % 2 === 0 ? -0 : -1));
  NodeAssert.ok(Object.is(kernel.cosine(left, right), 0));
  NodeAssert.equal(kernel.cosine(left, new Float64Array(2048)), 0);
});

NodeTest.test("batch evidence uses query entities, exact cosine and bounded score", async () => {
  const content = "sqlite";
  const candidate = {
    content,
    entities: ["sqlite"],
    fts: 1,
    jaccard: 1,
    trust: 1,
    updatedAt: 1,
    retrievalCount: 0,
  };
  const [match, decayed, reinforced] = await kernel.rankBatch(
    content,
    ["sqlite"],
    [
      candidate,
      { ...candidate, updatedAt: 1 - 365 * 86_400_000 + 10 ** 12 },
      { ...candidate, retrievalCount: Number.MAX_SAFE_INTEGER },
    ],
    10 ** 12 + 1,
  );
  const query = await kernel.encodeFact(content, ["sqlite"]);
  NodeAssert.equal(match.rawCosine, kernel.cosine(query, query));
  NodeAssert.equal(decayed.decay, 0.5);
  NodeAssert.equal(decayed.scoreMillionths, 500_000);
  NodeAssert.equal(reinforced.reinforcement, 1.5);
  NodeAssert.equal(reinforced.scoreMillionths, 150_000);
  NodeAssert.throws(
    () =>
      kernel.rankBatch(
        content,
        [],
        Array.from({ length: 33 }, () => ({ ...candidate })),
        1,
      ),
    {
      code: "InvalidArg",
    },
  );
  NodeAssert.throws(() => kernel.rankBatch(content, [], [{ ...candidate, trust: NaN }], 1), {
    code: "InvalidArg",
  });
});

NodeTest.test(
  "work yields to Node and native admission rejects a third outstanding task",
  async () => {
    const content = Array.from({ length: 1000 }, (_, i) => `token${i}`).join(" ");
    const events = [];
    const first = kernel.encodeFact(content, []).then(() => events.push("first"));
    const second = kernel.encodeFact(content, []);
    NodeAssert.throws(() => kernel.encodeFact(content, []), { code: "QueueFull" });
    const channel = new NodeWorkerThreads.MessageChannel();
    try {
      const delivered = NodeEvents.once(channel.port1, "message");
      channel.port2.postMessage("eventLoop");
      await delivered;
      events.push("eventLoop");
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
    await Promise.all([first, second]);
    NodeAssert.equal(events[0], "eventLoop");
    NodeAssert.equal((await kernel.encodeFact("available", [])).length, 2048);
  },
);

NodeTest.test("an aborted native batch rejects and releases admission", async () => {
  const controller = new AbortController();
  const promise = kernel.rankBatch(
    Array.from({ length: 1000 }, (_, i) => `token${i}`).join(" "),
    [],
    [
      {
        content: "sqlite",
        entities: [],
        fts: 1,
        jaccard: 1,
        trust: 1,
        updatedAt: 1,
        retrievalCount: 0,
      },
    ],
    1,
    controller.signal,
  );
  controller.abort();
  await NodeAssert.rejects(promise, { code: "Cancelled" });
  NodeAssert.equal((await kernel.encodeFact("after cancellation", [])).length, 2048);
});

NodeTest.test("Unicode lowercasing and entity deduplication retain Rust semantics", async () => {
  const sigma = await kernel.encodeFact("ΟΣ", []);
  NodeAssert.equal(digest(sigma), digest(await kernel.encodeFact("οσ", [])));
  NodeAssert.notEqual(digest(sigma), digest(await kernel.encodeFact("ος", [])));
  const entity = await kernel.encodeFact("context", ["foo"]);
  NodeAssert.equal(digest(entity), digest(await kernel.encodeFact("context", ["FOO", "foo"])));
  NodeAssert.notEqual(digest(entity), digest(await kernel.encodeFact("context", ["foo", " foo "])));
});
