import type { ExternalHistoryResponse } from "@t3tools/contracts";

type SearchPage = Extract<ExternalHistoryResponse, { operation: "search" }>;
type Position = {
  readonly cursor: string | undefined;
  readonly previous: ReadonlyArray<string | undefined>;
  readonly examinedItems: number;
};
type ExternalHistoryPaging = Position &
  (
    | { readonly status: "searching" | "stopped" }
    | { readonly status: "ready"; readonly page: SearchPage }
  );
type Action =
  | { readonly type: "page"; readonly cursor: string | undefined; readonly page: SearchPage }
  | { readonly type: "next" | "previous" | "stop" | "resume" };

export function initialExternalHistoryPaging(): ExternalHistoryPaging {
  return { status: "searching", cursor: undefined, previous: [], examinedItems: 0 };
}

export function externalHistoryPagingReducer(
  state: ExternalHistoryPaging,
  action: Action,
): ExternalHistoryPaging {
  const position = {
    cursor: state.cursor,
    previous: state.previous,
    examinedItems: state.examinedItems,
  };
  switch (action.type) {
    case "page": {
      if (state.status !== "searching" || action.cursor !== state.cursor) return state;
      const examinedItems = state.examinedItems + action.page.examinedItems;
      return action.page.matches.length === 0 && action.page.nextCursor !== null
        ? { ...position, status: "searching", cursor: action.page.nextCursor, examinedItems }
        : { ...position, status: "ready", page: action.page, examinedItems };
    }
    case "next":
      if (state.status !== "ready" || state.page.nextCursor === null) return state;
      return {
        ...position,
        status: "searching",
        cursor: state.page.nextCursor,
        previous: [...state.previous, state.cursor],
      };
    case "previous":
      if (state.previous.length === 0) return state;
      return {
        ...position,
        status: "searching",
        cursor: state.previous.at(-1),
        previous: state.previous.slice(0, -1),
      };
    case "stop":
      return state.status === "searching" ? { ...position, status: "stopped" } : state;
    case "resume":
      return state.status === "stopped" ? { ...position, status: "searching" } : state;
  }
}
