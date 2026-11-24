/**
 * Admin academic oversight (ATT-001/002/005/009, ADM-011, ASM-005/011, BR-010/012)
 * over the live tables NXA_ClassSessions, NXA_AttendanceRecords,
 * NXA_AttendanceChangeHistory, NXA_Assignments, NXA_AssignmentSubmissions,
 * NXA_EvaluationRecords, NXA_Tests, NXA_TestAttempts, NXA_RetakeAuthorizations.
 */

/** BR-010: attendance statuses are Present, Absent and Leave (stored upper-case). */
export const ATTENDANCE_STATUSES = ["present", "absent", "leave"] as const;
export type AttendanceStatusValue = (typeof ATTENDANCE_STATUSES)[number];

export interface ClassSession {
  id: string;
  batchId: string;
  batchCode?: string | undefined;
  courseId: string;
  courseName?: string | undefined;
  teacherUserId: string;
  teacherName?: string | undefined;
  sessionTitle: string;
  startsAt: string;
  endsAt: string;
  meetingUrl?: string | undefined;
  /** NXA_ClassSessions.SessionStatus as stored (allowed values not visible). */
  sessionStatus?: string | undefined;
  createdByUserId?: string | undefined;
  createdAt: string;
}

export interface AttendanceRosterEntry {
  studentUserId: string;
  studentName?: string | undefined;
  record?: {
    id: string;
    /** As stored; teacher-portal records may hold values outside BR-010 (e.g. LATE). */
    status: string;
    remarks?: string | undefined;
    markedAt: string;
    markedByUserId: string;
  } | undefined;
}

export interface AttendanceChange {
  id: string;
  attendanceRecordId: string;
  studentUserId: string;
  oldStatus: string;
  newStatus: string;
  changeReason: string;
  changedByUserId: string;
  changedByName?: string | undefined;
  changedAt: string;
}

export interface AttendanceMarkResult {
  created: number;
  corrected: number;
  unchanged: number;
}

/**
 * Counts per student. The percentage fields are added by the routes with the
 * one shared D2 formula (`academic-rules.ts`), never by an adapter.
 */
export interface AttendanceSummaryRow {
  studentUserId: string;
  studentName?: string | undefined;
  present: number;
  absent: number;
  leave: number;
  /** Records with a status outside BR-010 (e.g. teacher-portal LATE / EXCUSED). */
  other: number;
  recordedSessions: number;
  /** Present + Absent + Leave records (unmarked sessions are not counted, D2). */
  markedSessions?: number;
  /** Unrounded; null when nothing is marked. */
  attendancePercentage?: number | null;
  /** One decimal place, for display. */
  attendancePercentageDisplay?: string | null;
  /** Below the minimum in force (unrounded comparison); null when nothing is marked. */
  belowMinimum?: boolean | null;
}

export interface AttendanceSummary {
  batchId: string;
  /** Sessions of the batch that have started. */
  heldSessions: number;
  /** The minimum attendance in force (BR-011 floor 75%, raised by settings). */
  minimumAttendancePercentage?: number;
  students: AttendanceSummaryRow[];
}

export interface AssignmentOverview {
  id: string;
  courseId: string;
  courseName?: string | undefined;
  batchId?: string | undefined;
  batchCode?: string | undefined;
  title: string;
  instructions?: string | undefined;
  dueAt?: string | undefined;
  maximumMarks: number;
  status?: string | undefined;
  createdByTeacherUserId: string;
  teacherName?: string | undefined;
  submissionCount: number;
  evaluatedCount: number;
}

export interface SubmissionOverview {
  id: string;
  assignmentId: string;
  studentUserId: string;
  studentName?: string | undefined;
  submissionType: string;
  submissionStatus?: string | undefined;
  submissionVersion: number;
  submittedAt: string;
  gitHubUrl?: string | undefined;
  objectKey?: string | undefined;
  textContent?: string | undefined;
  latestEvaluation?: {
    id: string;
    marksAwarded: number;
    feedback?: string | undefined;
    evaluationVersion: number;
    evaluatedByUserId: string;
    evaluatedAt: string;
  } | undefined;
}

/** ASM-012: one stored evaluation version of a submission. */
export interface EvaluationVersion {
  id: string;
  evaluationVersion: number;
  marksAwarded: number;
  feedback?: string | undefined;
  evaluatedByUserId: string;
  evaluatedByName?: string | undefined;
  evaluatedAt: string;
}

export interface TestOverview {
  id: string;
  courseId: string;
  courseName?: string | undefined;
  batchId?: string | undefined;
  batchCode?: string | undefined;
  title: string;
  durationMinutes: number;
  maximumMarks: number;
  passingMarks?: number | undefined;
  maxAttempts: number;
  startsAt?: string | undefined;
  endsAt?: string | undefined;
  status?: string | undefined;
  createdByTeacherUserId: string;
  attemptCount: number;
}

export interface TestAttemptOverview {
  id: string;
  testId: string;
  studentUserId: string;
  studentName?: string | undefined;
  attemptNumber: number;
  attemptStatus?: string | undefined;
  startedAt: string;
  submittedAt?: string | undefined;
  totalMarks?: number | undefined;
}

export interface RetakeAuthorization {
  id: string;
  testId: string;
  studentUserId: string;
  studentName?: string | undefined;
  additionalAttempts: number;
  reason?: string | undefined;
  authorizedByUserId: string;
  authorizedAt: string;
}
