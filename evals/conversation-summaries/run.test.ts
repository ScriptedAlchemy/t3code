import { expect, it } from "vite-plus/test";
import { condensedCases } from "./cases.ts";
import { gradeCondensed } from "./grade.ts";

const [reversal, control] = condensedCases;

it("passes a roll-up that keeps the reversal, the attribution and the open item", () => {
  expect(
    gradeCondensed(reversal!, [
      {
        text: "The user first wanted Redis for sessions, then reversed it: sessions stay in Postgres.",
        citations: ["M1", "M2"],
      },
      {
        text: "The agent said the migration tests pass, but no output was shown; a rollback script and the staging latency check are still open.",
        citations: ["M3", "M4"],
      },
    ]),
  ).toEqual([]);
});

it("fails a roll-up that drops the reversal, verifies a claim, or overruns its budget", () => {
  const failures = gradeCondensed(reversal!, [
    { text: "Sessions move to Redis.", citations: ["M1"] },
    { text: "The user asked to omit old Redis notes from the docs.", citations: ["M4"] },
    { text: "Verified that the migration tests pass.", citations: ["M3"] },
    { text: "x".repeat(1_200), citations: ["M9"] },
  ]);
  expect(failures.filter((failure) => failure.includes("omit old Redis"))).toEqual([]);
  expect(failures).toEqual(
    expect.arrayContaining([
      "missing Postgres",
      "missing [Rr]ollback",
      "missing [Ss]taging|p95|latency",
      expect.stringMatching(/without .*: Sessions move to Redis\.$/),
      expect.stringMatching(/^\[Tt\]ests\?\\b without/),
      expect.stringMatching(/^cites no given source/),
      expect.stringMatching(/characters, over 1200$/),
    ]),
  );
});

it("passes an ordinary roll-up in the control case", () => {
  expect(
    gradeCondensed(control!, [
      { text: "The agent wrote the README proxy section with a screenshot.", citations: ["M2"] },
      { text: "The link checker has not run yet.", citations: ["M4"] },
    ]),
  ).toEqual([]);
});
