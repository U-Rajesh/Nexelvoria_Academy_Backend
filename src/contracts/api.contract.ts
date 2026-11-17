/**
 * The HTTP envelope every endpoint must use.
 *
 * Mirrors the frontend's `src/types/common.types.ts` so that one shape is
 * shared end to end. Do not invent per-module envelopes.
 */

/** Successful response. `data` is omitted for endpoints that return no payload. */
export interface ApiSuccess<T = never> {
  success: true;
  message?: string;
  data?: T;
}

/** Failure response. Produced centrally by the error middleware only. */
export interface ApiFailure {
  success: false;
  message: string;
  /** Machine-readable code, e.g. "VALIDATION_ERROR", "NOT_FOUND". */
  error?: string;
  /** Field-level validation problems, present only for 422 responses. */
  details?: FieldIssue[];
  /**
   * Correlation id for this request, echoed so a user can quote it in a
   * bug report and we can find the matching server log.
   *
   * Additive and optional: the frontend's `ApiResponse` does not declare
   * it and simply ignores it, so this is backwards compatible.
   */
  requestId?: string;
}

export type ApiResponse<T = never> = ApiSuccess<T> | ApiFailure;

export interface FieldIssue {
  /** Dotted path to the offending field, e.g. "address.city" or "items.0.id". */
  field: string;
  message: string;
}

/**
 * The closed set of `error` codes the API may return.
 *
 * The frontend is allowed to branch on these, so adding a member is an API
 * change: announce it. Domain-specific codes (e.g. "BATCH_FULL") are added
 * here when their module is built, not invented ad hoc in a service.
 */
export const API_ERROR_CODES = [
  "VALIDATION_ERROR",
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "INSUFFICIENT_ROLE",
  "NOT_FOUND",
  "ROUTE_NOT_FOUND",
  "CONFLICT",
  "TOO_MANY_REQUESTS",
  "PAYLOAD_TOO_LARGE",
  "MALFORMED_JSON",
  "INTERNAL_SERVER_ERROR",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/**
 * Page of results. Mirrors the frontend's `PaginatedResult<T>` exactly -
 * renaming any of these keys is a breaking change for the UI.
 */
export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** Matches the frontend's APP_CONFIG.defaultPageSize. */
export const DEFAULT_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 100;

/** Normalised pagination input, produced by the shared pagination schema. */
export interface PaginationQuery {
  page: number;
  pageSize: number;
}

/** Sort direction. `asc` is the default wherever a sort is supported. */
export type SortOrder = "asc" | "desc";

/**
 * Normalised list input: pagination plus the optional sort and free-text
 * search that every collection endpoint accepts.
 *
 * `sortBy` is validated per module against that module's own allow-list of
 * sortable fields - never interpolate it into a query unchecked.
 */
export interface ListQuery extends PaginationQuery {
  sortBy?: string;
  sortOrder: SortOrder;
  search?: string;
}

/** Builds a PaginatedResult from a page of rows and the total row count. */
export const toPaginatedResult = <T>(
  items: T[],
  total: number,
  { page, pageSize }: PaginationQuery,
): PaginatedResult<T> => ({
  items,
  total,
  page,
  pageSize,
  totalPages: pageSize > 0 ? Math.ceil(total / pageSize) : 0,
});
