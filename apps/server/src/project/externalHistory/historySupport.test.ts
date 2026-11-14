import { expect, it } from "vite-plus/test";
import { ExternalHistoryError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { BUILT_IN_DRIVERS } from "../../provider/builtInDrivers.ts";
import { makeHistorySupport } from "./historySupport.ts";

it("requires a history decision for every built-in driver", () => {
  const open = () => Effect.fail(new ExternalHistoryError({ reason: "missing" }));
  const table = makeHistorySupport({
    claudeAgent: open,
    pi: open,
    opencode: open,
    openCodeRoots: () => Effect.succeed([]),
  });
  expect(Object.keys(table).toSorted()).toEqual(
    BUILT_IN_DRIVERS.map((driver) => driver.driverKind).toSorted(),
  );
});
