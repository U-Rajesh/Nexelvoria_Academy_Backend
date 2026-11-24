/**
 * Reporting periods for the Admin and Super Admin dashboards.
 *
 * Boundaries are computed in the institute time zone (Asia/Kolkata, UTC+05:30,
 * no DST) and returned as UTC instants, because stored timestamps are UTC
 * (SYSUTCDATETIME).
 *
 * Financial year: the Indian financial year, 1 April to 31 March (approved
 * decision, Milestone 3 review). Every year-to-date figure must use
 * `financialYearStart` so the dashboards cannot disagree.
 */

const IST_OFFSET_MS = 330 * 60 * 1000;

/** April, as a zero-based month index. */
const FINANCIAL_YEAR_START_MONTH = 3;

const istParts = (now: Date): { year: number; month: number } => {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return { year: ist.getUTCFullYear(), month: ist.getUTCMonth() };
};

/** 00:00 IST on the first day of the current month, as a UTC instant. */
export const istMonthStart = (now: Date = new Date()): Date => {
  const { year, month } = istParts(now);
  return new Date(Date.UTC(year, month, 1) - IST_OFFSET_MS);
};

/** 00:00 IST on 1 April of the financial year containing `now`, as a UTC instant. */
export const financialYearStart = (now: Date = new Date()): Date => {
  const { year, month } = istParts(now);
  const startYear = month >= FINANCIAL_YEAR_START_MONTH ? year : year - 1;
  return new Date(Date.UTC(startYear, FINANCIAL_YEAR_START_MONTH, 1) - IST_OFFSET_MS);
};

/** e.g. "FY 2026-27" for any date from 1 Apr 2026 to 31 Mar 2027 (IST). */
export const financialYearLabel = (now: Date = new Date()): string => {
  const start = new Date(financialYearStart(now).getTime() + IST_OFFSET_MS).getUTCFullYear();
  return `FY ${start}-${String((start + 1) % 100).padStart(2, "0")}`;
};
