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

  /**
   * A verification ticket, accompanying ONE refusal:
   * `ACCOUNT_PENDING_VERIFICATION` from `POST /auth/login`.
   *
   * THE ONLY DOMAIN-SPECIFIC FIELD ON THIS ENVELOPE, and it is here
   * deliberately rather than by drift. The refusal and the means to resolve
   * it belong in the same response: a student who signs in with the correct
   * password but an unverified email must be able to go straight to the OTP
   * screen, and the ticket is what identifies their account without putting
   * a student id in a URL.
   *
   * Opaque, short-lived (15 minutes) and purpose-scoped - it cannot
   * authenticate anything (see `issueVerificationTicket`). Never present on
   * any other failure, and never sent to a caller who has not already proven
   * the password.
   *
   * Additive and optional, so the frontend's `ApiResponse` ignores it.
   */
  verificationTicket?: string;
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
  "TOKEN_EXPIRED",
  "FORBIDDEN",
  "INSUFFICIENT_ROLE",

  // --- account state, returned by login ONLY after a correct password ----
  //
  // These are safe to distinguish precisely because the caller has already
  // authenticated: `invalid_credentials` (an unknown user, a missing
  // credential, or a wrong password) collapses into one generic 401, so a
  // stranger learns nothing. Anyone seeing a code below already knows the
  // password, and therefore already knows the account exists.
  //
  // The frontend renders a different screen per state, so these must be
  // distinguishable codes rather than one FORBIDDEN with differing prose -
  // a UI must branch on a code, never on a message.

  /**
   * Status is `pending` and the precise reason could NOT be established -
   * the student repository was unavailable, threw, or the user has no
   * student profile.
   *
   * Deliberately vague, and never substituted with a guess: reporting
   * `ACCOUNT_PENDING_APPROVAL` here would tell a student to wait for an
   * administrator when what they actually need is to verify their email.
   */
  "ACCOUNT_PENDING",
  /** Email not yet verified. A verification ticket accompanies this. */
  "ACCOUNT_PENDING_VERIFICATION",
  /** Email verified, awaiting BR-002 admin approval. No ticket is issued. */
  "ACCOUNT_PENDING_APPROVAL",
  /** Locked after consecutive failed sign-ins. */
  "ACCOUNT_LOCKED",
  /** Suspended by staff. */
  "ACCOUNT_SUSPENDED",
  /** Deactivated by staff. */
  "ACCOUNT_DEACTIVATED",
  "NOT_FOUND",
  "ROUTE_NOT_FOUND",
  "CONFLICT",
  "TOO_MANY_REQUESTS",
  "SERVICE_UNAVAILABLE",
  "PAYLOAD_TOO_LARGE",
  "MALFORMED_JSON",
  "INTERNAL_SERVER_ERROR",
  // Login refusals (auth module, decision D1). Disclosed only AFTER the
  // password has been verified, so they never reveal whether an account
  // exists.
  "INVALID_CREDENTIALS",
  "ACCOUNT_LOCKED",
  "ACCOUNT_PENDING",
  "ACCOUNT_SUSPENDED",
  "ACCOUNT_DEACTIVATED",
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

/**
 * Largest page number accepted.
 *
 * Bounded so `page * pageSize` can never leave the safe-integer range:
 * 1,000,000 x 100 is 1e8, far below `Number.MAX_SAFE_INTEGER`. Without a
 * cap, a page of 1e18 produces an offset that silently loses precision.
 */
export const MAX_PAGE = 1_000_000;

/**
 * Normalises untrusted pagination input into a usable `PaginationQuery`.
 *
 * `Math.trunc` and `Math.max` alone are NOT safe here: `Math.trunc(NaN)` is
 * `NaN` and `Math.max(1, NaN)` is `NaN`, so a non-numeric page size
 * propagates into the response as `pageSize: NaN` and `totalPages: NaN`,
 * which serialise to `null`. `Infinity` survives both as well.
 *
 * This is DEFENSIVE normalisation for the service layer, deliberately
 * distinct from `paginationSchema` in validate.middleware.ts: at the HTTP
 * edge, out-of-range input is REJECTED with 422, because a client asking
 * for `pageSize=9999` has a bug worth surfacing. Inside a service the input
 * may come from another service or a test, and the invariant that matters is
 * that a response can never contain `NaN`. So the edge validates strictly
 * and the service clamps.
 *
 * Guarantees for any input, including `NaN`, `Infinity`, negatives,
 * fractions and absurd magnitudes:
 *   - `page` is a safe integer in [1, MAX_PAGE]
 *   - `pageSize` is a safe integer in [1, MAX_PAGE_SIZE]
 */
export const normalizePagination = (input: Partial<PaginationQuery> = {}): PaginationQuery => {
  const clamp = (value: unknown, fallback: number, max: number): number => {
    // Rejects NaN and both infinities in one check; `typeof` keeps strings
    // and other shapes out even when a caller bypasses the types.
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fallback;
    }

    // Truncate towards zero first, so 2.7 -> 2 and -2.7 -> -2, then clamp.
    const whole = Math.trunc(value);

    if (whole < 1) {
      return 1;
    }

    return whole > max ? max : whole;
  };

  return {
    page: clamp(input.page, 1, MAX_PAGE),
    pageSize: clamp(input.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
  };
};

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
