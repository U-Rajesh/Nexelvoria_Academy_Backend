import type { FinancialSummary, ReportDefinition, ReportFilter } from "./reports.types";

const IST_OFFSET_MS = 330 * 60 * 1000;

/** Exports larger than this are refused (narrow the filters) instead of being silently truncated. */
export const MAX_EXPORT_ROWS = 50_000;

/** Longest range for dashboard analytics (monthly series). */
export const MAX_ANALYTICS_MONTHS = 24;

export class ReportTooLargeError extends Error {
  constructor(readonly total: number) {
    super(`This export would contain ${total} rows; the limit is ${MAX_EXPORT_ROWS}. Narrow the date range or filters.`);
    this.name = "ReportTooLargeError";
  }
}

/** 00:00 IST of a YYYY-MM-DD day (plus `addDays`), as a UTC instant. */
export function istDayStartUtc(day: string, addDays = 0): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + addDays) - IST_OFFSET_MS);
}

/** Today's date in IST as YYYY-MM-DD. */
export function istToday(now: Date = new Date()): string {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 1 April of the Indian financial year containing `now` (IST), as YYYY-MM-DD. */
export function financialYearStartDay(now: Date = new Date()): string {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const year = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  return `${year}-04-01`;
}

/** Every YYYY-MM from `from` to `to` inclusive. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const endY = Number(to.slice(0, 4));
  const endM = Number(to.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

/** Filter lines printed in exported files (the same filters that produced the on-screen result). */
export function describeFilters(def: ReportDefinition, filter: ReportFilter): string[] {
  const lines = [`${def.dateField}: ${filter.from ?? "any"} to ${filter.to ?? "any"} (IST)`];
  if (filter.status) lines.push(`Status: ${filter.status}`);
  if (filter.search) lines.push(`Search: ${filter.search}`);
  return lines;
}

/** The financial summary as report rows (screen table and exports use the same rows). */
export function financialSummaryRows(s: FinancialSummary): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const add = (section: string, metric: string, count: number | null, amount: number | null, basis: string) =>
    rows.push({ section, metric, count, amount, basis });

  add("Revenue", "Gateway payments (successful)", s.revenue.gatewaySuccessful.count, s.revenue.gatewaySuccessful.amount, "Transaction status 'successful', recorded in range");
  add("Revenue", "Manual payments (verified)", s.revenue.manualVerified.count, s.revenue.manualVerified.amount, "Verification status 'verified', recorded in range");
  add("Revenue", "Total collected", s.revenue.gatewaySuccessful.count + s.revenue.manualVerified.count, s.revenue.totalCollected, "Successful + verified; refunds not deducted");
  for (const l of s.revenue.gatewayNotCounted) add("Not counted as revenue", `Gateway: ${l.status || "(no status)"}`, l.count, l.amount, "Recorded in range, not successful");
  for (const l of s.revenue.manualNotCounted) add("Not counted as revenue", `Manual: ${l.status || "(no status)"}`, l.count, l.amount, "Recorded in range, not verified");
  add("Refunds", "Requested", s.refunds.requested.count, s.refunds.requested.amount, "Requested in range (any status)");
  add("Refunds", "Pending", s.refunds.pending.count, s.refunds.pending.amount, "Requested in range, status 'pending'");
  add("Refunds", "Approved", s.refunds.approved.count, s.refunds.approved.amount, "Approved in range");
  add("Refunds", "Completed", s.refunds.completed.count, s.refunds.completed.amount, "Completed in range (money returned)");
  add("Discounts", "Enrollment discounts", s.discounts.enrollmentDiscounts.count, s.discounts.enrollmentDiscounts.amount, "Enrollments created in range, not cancelled");
  for (const l of s.discounts.couponRedemptions) add("Discounts", `Coupon redemptions: ${l.status || "(no status)"}`, l.count, l.amount, "Redeemed in range");
  for (const l of s.scholarships.awards) add("Scholarships", `Awards: ${l.status || "(no status)"}`, l.count, l.amount, "Awarded in range; not assumed to have reduced fees");
  for (const e of s.expenses.byCurrency) add("Expenses", `Recorded expenses (${e.currency})`, e.count, e.amount, "Expense date in range");
  add("Expenses", "With an approver recorded", s.expenses.withApprover.count, s.expenses.withApprover.amount, "Expense date in range");
  for (const c of s.expenses.byCategory) add("Expenses by category", `${c.category} (${c.currency})`, c.count, c.amount, "Expense date in range");
  return rows;
}
