import { expect, it } from "vite-plus/test";
import { externalHistorySearchFilters } from "./index.ts";

it.each([
  [{ cwdFilter: false, archived: false }, {}],
  [{ cwdFilter: true, archived: false }, { filterCwd: "/project" }],
  [{ cwdFilter: false, archived: true }, { includeArchived: true }],
  [
    { cwdFilter: true, archived: true },
    { filterCwd: "/project", includeArchived: true },
  ],
])("sends only filters allowed by source capabilities %j", (capabilities, expected) => {
  expect(
    externalHistorySearchFilters(capabilities, { filterCwd: " /project ", includeArchived: true }),
  ).toEqual(expected);
});
