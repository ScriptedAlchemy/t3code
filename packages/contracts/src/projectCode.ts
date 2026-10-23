import * as Schema from "effect/Schema";

import { ProjectId, ThreadId } from "./baseSchemas.ts";

const limit = Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 })));
const depth = Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const NonEmptyText = Schema.String.check(Schema.isNonEmpty());
const BoundedPath = Schema.String.check(Schema.isMaxLength(2048));
const BoundedIdentifier = Schema.String.check(Schema.isMaxLength(2048));
const BoundedName = Schema.String.check(Schema.isMaxLength(512));
const BoundedText = Schema.String.check(Schema.isMaxLength(2048));

export const ProjectCodeSymbolSelector = Schema.Struct({
  name: NonEmptyText.check(Schema.isMaxLength(512)),
  filePath: Schema.optional(BoundedPath),
  line: Schema.optional(PositiveInt),
});
export type ProjectCodeSymbolSelector = typeof ProjectCodeSymbolSelector.Type;

export const ProjectCodeQuery = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("search"),
    text: NonEmptyText.check(Schema.isMaxLength(2048)),
    limit,
  }),
  Schema.Struct({
    operation: Schema.Literal("symbols"),
    name: NonEmptyText.check(Schema.isMaxLength(512)),
    filePath: Schema.optional(BoundedPath),
    limit,
  }),
  Schema.Struct({
    operation: Schema.Literal("callers"),
    symbol: ProjectCodeSymbolSelector,
    depth,
    limit,
  }),
  Schema.Struct({
    operation: Schema.Literal("callees"),
    symbol: ProjectCodeSymbolSelector,
    depth,
    limit,
  }),
  Schema.Struct({
    operation: Schema.Literal("references"),
    symbol: ProjectCodeSymbolSelector,
    limit,
  }),
  Schema.Struct({
    operation: Schema.Literal("dependencies"),
    filePath: NonEmptyText.check(Schema.isMaxLength(2048)),
    direction: Schema.Literals(["imports", "imported-by"]),
    limit,
  }),
  Schema.Struct({
    operation: Schema.Literal("impact"),
    symbol: ProjectCodeSymbolSelector,
    depth,
    limit,
  }),
  Schema.Struct({ operation: Schema.Literal("status") }),
]);
export type ProjectCodeQuery = typeof ProjectCodeQuery.Type;

export const ProjectCodeQueryInput = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optional(ThreadId),
  query: ProjectCodeQuery,
});
export type ProjectCodeQueryInput = typeof ProjectCodeQueryInput.Type;

export const ProjectCodeError = Schema.Union([
  Schema.TaggedStruct("project-not-found", { projectId: ProjectId }),
  Schema.TaggedStruct("thread-project-mismatch", { projectId: ProjectId, threadId: ThreadId }),
  Schema.TaggedStruct("authority-failed", {
    authority: Schema.Literals([
      "project-store",
      "thread-store",
      "workspace-paths",
      "workspace-entries",
    ]),
  }),
  Schema.TaggedStruct("path-outside-checkout", { path: BoundedPath }),
  Schema.TaggedStruct("analysis-failed", {
    path: BoundedPath,
    reason: Schema.Literals(["worker-failed", "invalid-result"]),
  }),
]);
export type ProjectCodeError = typeof ProjectCodeError.Type;

export const ProjectCodeSymbol = Schema.Struct({
  id: BoundedIdentifier,
  name: BoundedName,
  qualifiedName: BoundedText,
  kind: BoundedName,
  language: BoundedName,
  path: BoundedPath,
  startLine: PositiveInt,
  endLine: PositiveInt,
  startColumn: NonNegativeInt,
  endColumn: NonNegativeInt,
  signature: Schema.NullOr(BoundedText),
  isExported: Schema.Boolean,
});
export type ProjectCodeSymbol = typeof ProjectCodeSymbol.Type;

export const ProjectCodeEdge = Schema.Struct({
  source: BoundedIdentifier,
  target: BoundedIdentifier,
  kind: BoundedName,
  confidence: Schema.NullOr(Schema.Number),
  resolvedBy: Schema.NullOr(BoundedName),
  provenance: Schema.NullOr(Schema.Literals(["tree-sitter", "scip", "heuristic"])),
  evidenceGrade: Schema.Literals(["compiler-indexed", "static-candidate", "heuristic-candidate"]),
  line: Schema.NullOr(PositiveInt),
  column: Schema.NullOr(NonNegativeInt),
  referenceName: Schema.NullOr(BoundedName),
  candidateTargets: Schema.Array(BoundedIdentifier).check(Schema.isMaxLength(20)),
});
export type ProjectCodeEdge = typeof ProjectCodeEdge.Type;

export const ProjectCodeMatch = Schema.Struct({
  symbol: ProjectCodeSymbol,
  score: Schema.Number,
  highlights: Schema.Array(BoundedText).check(Schema.isMaxLength(16)),
});
export type ProjectCodeMatch = typeof ProjectCodeMatch.Type;

export const ProjectCodeUnresolvedReference = Schema.Struct({
  from: BoundedIdentifier,
  name: BoundedName,
  kind: BoundedName,
  filePath: BoundedPath,
  language: Schema.NullOr(BoundedName),
  line: PositiveInt,
  column: NonNegativeInt,
  candidates: Schema.Array(BoundedIdentifier).check(Schema.isMaxLength(20)),
});
export type ProjectCodeUnresolvedReference = typeof ProjectCodeUnresolvedReference.Type;

export const ProjectCodeFile = Schema.Struct({ path: BoundedPath });
export type ProjectCodeFile = typeof ProjectCodeFile.Type;

export const ProjectCodeSourceDigest = Schema.Struct({
  path: BoundedPath,
  digest: Schema.String.check(Schema.isMaxLength(64)),
  verified: Schema.Boolean,
});
export type ProjectCodeSourceDigest = typeof ProjectCodeSourceDigest.Type;

export const ProjectCodeSelection = Schema.Struct({
  state: Schema.Literals(["not-required", "matched", "ambiguous", "not-found"]),
  candidates: Schema.Array(ProjectCodeSymbol).check(Schema.isMaxLength(200)),
});
export type ProjectCodeSelection = typeof ProjectCodeSelection.Type;

export const ProjectCodeCoverage = Schema.Struct({
  state: Schema.Literals(["complete", "partial", "stale", "unavailable"]),
  catalogRevision: Schema.String,
  relationSemantics: Schema.Literal("static-candidates"),
  columnEncoding: Schema.Literal("utf16-code-units"),
  languages: Schema.Array(BoundedName).check(Schema.isMaxLength(64)),
  filesListed: NonNegativeInt,
  filesIndexed: NonNegativeInt,
  filesSkipped: NonNegativeInt,
  filesUnsupported: NonNegativeInt,
  filesFailed: NonNegativeInt,
  pendingReferences: NonNegativeInt,
  resultLimitReached: Schema.Boolean,
  limitations: Schema.Array(BoundedText).check(Schema.isMaxLength(16)),
});
export type ProjectCodeCoverage = typeof ProjectCodeCoverage.Type;

export const ProjectCodeStats = Schema.Struct({
  nodes: NonNegativeInt,
  edges: NonNegativeInt,
  files: NonNegativeInt,
  lastUpdated: Schema.Number,
});
export type ProjectCodeStats = typeof ProjectCodeStats.Type;

export const ProjectCodeQueryResult = Schema.Struct({
  operation: Schema.Literals([
    "search",
    "symbols",
    "callers",
    "callees",
    "references",
    "dependencies",
    "impact",
    "status",
  ]),
  checkoutPath: Schema.String.check(Schema.isMaxLength(4096)),
  matches: Schema.Array(ProjectCodeMatch).check(Schema.isMaxLength(200)),
  nodes: Schema.Array(ProjectCodeSymbol).check(Schema.isMaxLength(200)),
  edges: Schema.Array(ProjectCodeEdge).check(Schema.isMaxLength(200)),
  files: Schema.Array(ProjectCodeFile).check(Schema.isMaxLength(200)),
  unresolvedReferences: Schema.Array(ProjectCodeUnresolvedReference).check(Schema.isMaxLength(200)),
  selection: ProjectCodeSelection,
  sourceDigests: Schema.Array(ProjectCodeSourceDigest).check(Schema.isMaxLength(50)),
  stats: Schema.NullOr(ProjectCodeStats),
  coverage: ProjectCodeCoverage,
});
export type ProjectCodeQueryResult = typeof ProjectCodeQueryResult.Type;
