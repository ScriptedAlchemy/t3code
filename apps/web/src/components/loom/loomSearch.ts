import type { LoomFilters, LoomRunStatusFilter } from "@t3tools/contracts";

/** URL state of a Loom view: the read window, filters, selection and collapsed lanes. */
export interface LoomSearch {
  readonly from?: string;
  readonly to?: string;
  readonly q?: string;
  readonly status?: ReadonlyArray<LoomRunStatusFilter>;
  readonly provider?: ReadonlyArray<string>;
  readonly model?: ReadonlyArray<string>;
  readonly branch?: ReadonlyArray<string>;
  readonly sel?: string;
  readonly collapsed?: ReadonlyArray<string>;
}

/** A URL update; an undefined value removes that key. */
export type LoomSearchPatch = { readonly [Key in keyof LoomSearch]?: LoomSearch[Key] | undefined };

export const LOOM_STATUS_OPTIONS: ReadonlyArray<{
  readonly value: LoomRunStatusFilter;
  readonly label: string;
}> = [
  { value: "active", label: "Active" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "interrupted", label: "Interrupted" },
];

const MAX_VALUES = 20;
const MAX_COLLAPSED = 100;

function strings(raw: unknown, limit: number): ReadonlyArray<string> | undefined {
  const values = (Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim().slice(0, 300));
  const unique = [...new Set(values)].slice(0, limit);
  return unique.length === 0 ? undefined : unique;
}

function isoString(raw: unknown): string | undefined {
  return typeof raw === "string" && Number.isFinite(Date.parse(raw)) ? raw : undefined;
}

export function validateLoomSearch(raw: Record<string, unknown>): LoomSearch {
  const status = strings(raw.status, 4)?.filter((value): value is LoomRunStatusFilter =>
    LOOM_STATUS_OPTIONS.some((option) => option.value === value),
  );
  const fields = {
    from: isoString(raw.from),
    to: isoString(raw.to),
    q: typeof raw.q === "string" && raw.q.trim() ? raw.q.trim().slice(0, 200) : undefined,
    status: status === undefined || status.length === 0 ? undefined : status,
    provider: strings(raw.provider, MAX_VALUES),
    model: strings(raw.model, MAX_VALUES),
    branch: strings(raw.branch, MAX_VALUES),
    sel: typeof raw.sel === "string" && raw.sel ? raw.sel.slice(0, 600) : undefined,
    collapsed: strings(raw.collapsed, MAX_COLLAPSED),
  };
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as LoomSearch;
}

export function loomFiltersOf(search: LoomSearch): LoomFilters | undefined {
  const filters: LoomFilters = {
    ...(search.q === undefined ? {} : { title: search.q }),
    ...(search.status === undefined ? {} : { statuses: search.status }),
    ...(search.provider === undefined
      ? {}
      : {
          providerInstanceIds: search.provider as NonNullable<LoomFilters["providerInstanceIds"]>,
        }),
    ...(search.model === undefined ? {} : { models: search.model }),
    ...(search.branch === undefined ? {} : { branches: search.branch }),
  };
  return Object.keys(filters).length === 0 ? undefined : filters;
}

/** A selected timeline entity, encoded as `kind:id` in the URL. */
export type LoomSelection =
  | { readonly kind: "lane"; readonly id: string }
  | { readonly kind: "run"; readonly id: string }
  | { readonly kind: "marker"; readonly id: string }
  | { readonly kind: "edge"; readonly id: string };

export function encodeLoomSelection(selection: LoomSelection): string {
  return `${selection.kind}:${selection.id}`;
}

export function decodeLoomSelection(value: string | undefined): LoomSelection | null {
  if (value === undefined) return null;
  const separator = value.indexOf(":");
  const kind = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (separator <= 0 || id.length === 0) return null;
  return kind === "lane" || kind === "run" || kind === "marker" || kind === "edge"
    ? { kind, id }
    : null;
}
