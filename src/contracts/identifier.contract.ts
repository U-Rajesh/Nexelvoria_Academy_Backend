/**
 * Common identifier and date/time aliases.
 *
 * These are intentionally plain aliases of `string`, not branded types.
 * They document intent at call sites and give us one place to change if
 * the database team settles on a different representation.
 *
 * DATABASE NOTE (MS SQL Server 2025): the storage type is the database
 * team's decision, but whatever they choose must be serialised to a JSON
 * string on the wire, because the frontend's types declare every id as
 * `string`. If they use `UNIQUEIDENTIFIER`, lowercase it consistently; if
 * they use `INT IDENTITY`, stringify it. See docs/open-questions.md Q1.
 */

/** Opaque primary key of any persisted entity. Always a string on the wire. */
export type EntityId = string;

/**
 * Human-facing business reference, distinct from the primary key.
 * The frontend already shows these, so the backend must return them:
 *   certificateNumber  "NEX-2026-FSD-0042"
 *   ticketNumber       "TKT-1082"
 *   batchCode          "JFS-2026-B1"
 *   courseCode         "CRS-JFS-101"
 *   receiptNumber      (payments)
 *   orderId            (payments)
 * Generation rules are unconfirmed - see docs/open-questions.md Q2.
 */
export type BusinessCode = string;

/**
 * Full ISO-8601 timestamp in UTC, e.g. "2026-11-17T07:30:00.000Z".
 * Used for every `createdAt` / `updatedAt` / `*At` field.
 */
export type IsoDateTime = string;

/**
 * Calendar date with no time component, "YYYY-MM-DD".
 * Used where the frontend expects a date only, e.g.
 * `AttendanceSession.sessionDate`.
 */
export type IsoDate = string;

/** Slug used in public URLs, e.g. a course or article slug. */
export type Slug = string;
