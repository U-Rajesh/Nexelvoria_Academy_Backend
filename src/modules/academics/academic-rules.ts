/**
 * Approved academic rules (Group C decisions D1, D2 and D9; see
 * docs/requirement-clarifications.md). One implementation, used by every
 * attendance summary, report and export so the figures cannot disagree.
 */

/** BR-011 floors (D1). Settings may raise them, never lower them. */
export const BR011_MIN_ATTENDANCE_PERCENT = 75;
export const BR011_MIN_EXAM_PERCENT = 60;

/**
 * The threshold actually in force: a saved value applies only when it is at
 * or above the floor. A missing, invalid or lower stored value (for example a
 * row written before D1) falls back to the floor, so the rule cannot weaken.
 */
export const effectiveThreshold = (saved: number | undefined | null, floor: number): number =>
  typeof saved === "number" && Number.isFinite(saved) && saved >= floor && saved <= 100 ? saved : floor;

export interface AttendanceCounts {
  present: number;
  absent: number;
  leave: number;
}

export interface AttendanceFigure {
  /** Records counted: Present + Absent + Leave (D2: unmarked sessions are not counted). */
  markedSessions: number;
  /** Unrounded percentage, or null when nothing is marked (never a fabricated 0 or 100). */
  percentage: number | null;
  /** One decimal place, for display only. */
  percentageDisplay: string | null;
}

/**
 * D2: Present ÷ marked sessions × 100. Leave counts as not attended. Only the
 * BR-010 statuses take part; a record with any other status is reported
 * separately and is not part of the formula.
 */
export const attendanceFigure = (c: AttendanceCounts): AttendanceFigure => {
  const markedSessions = c.present + c.absent + c.leave;
  if (markedSessions === 0) return { markedSessions, percentage: null, percentageDisplay: null };
  const percentage = (c.present / markedSessions) * 100;
  return { markedSessions, percentage, percentageDisplay: percentage.toFixed(1) };
};

/** Compared on the unrounded value (74.96% is below 75%, even though it displays as 75.0). */
export const isBelowThreshold = (percentage: number | null, threshold: number): boolean | null =>
  percentage === null ? null : percentage < threshold;
