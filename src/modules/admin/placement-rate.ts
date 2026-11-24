/**
 * Approved decision D15 (docs/requirement-clarifications.md).
 *
 * Placement rate for a period, cohort-based:
 * - denominator: distinct students with an enrollment COMPLETED in the period
 *   (NXA_Enrollments.EnrollmentStatus = COMPLETED, CompletedAt in range);
 * - numerator: distinct students of that same cohort with at least one
 *   NXA_PlacementRecords row (any number of records counts once).
 * The numerator is a subset of the denominator by construction.
 * EmploymentStatus is not used (its allowed values are not confirmed).
 */
export interface PlacementCohort {
  completedStudents: number;
  placedStudents: number;
}

/** Unrounded percentage, or null for an empty cohort (never a fabricated 0). */
export const placementRate = (c: PlacementCohort): number | null =>
  c.completedStudents > 0 ? (Math.min(c.placedStudents, c.completedStudents) / c.completedStudents) * 100 : null;

/** D15 system alerts: the open action queues, with a breakdown. */
export interface SystemAlerts {
  pendingStudentApprovals: number;
  pendingRefundRequests: number;
  /** Always 0 with the current schema: an override is authorized when it is recorded. */
  pendingFinancialOverrides: number;
}
