import type {
  AssignmentOverview,
  AttendanceChange,
  AttendanceMarkResult,
  AttendanceRosterEntry,
  AttendanceStatusValue,
  AttendanceSummary,
  ClassSession,
  RetakeAuthorization,
  SubmissionOverview,
  EvaluationVersion,
  TestAttemptOverview,
  TestOverview,
} from "./academics.types";

/** A well-formed request the academic data does not allow (409 conflict / 422 invalid). */
export class AcademicRuleError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 409 | 422 = 422,
  ) {
    super(message);
    this.name = "AcademicRuleError";
  }
}

export interface ClassSessionInput {
  batchId: string;
  teacherUserId: string;
  sessionTitle: string;
  startsAt: string;
  endsAt: string;
  meetingUrl?: string | undefined;
}

/**
 * Admin / Super Admin academic oversight. Ids are BIGINT identities: a
 * non-numeric id finds nothing (reads) or throws RecordNotFoundError (writes).
 * Every write runs in one transaction with its audit record.
 */
export interface AcademicsRepository {
  // Class schedules (ATT-001)
  listClassSessions(filter: { batchId?: string; teacherUserId?: string; from?: string; to?: string }): Promise<ClassSession[]>;
  /**
   * The batch must exist and not be completed/cancelled; the teacher must hold
   * an active allocation to the batch (or its course); the time range may not
   * overlap another session of the batch or of the teacher.
   */
  createClassSession(input: ClassSessionInput, actorUserId: string): Promise<ClassSession>;
  /** Same rules as create; the batch cannot change. An unchanged session writes nothing. */
  updateClassSession(
    sessionId: string,
    changes: Partial<Omit<ClassSessionInput, "batchId">>,
    actorUserId: string,
  ): Promise<ClassSession>;

  // Attendance (ATT-002, ATT-005, ATT-009)
  getSessionAttendance(sessionId: string): Promise<{ session: ClassSession; roster: AttendanceRosterEntry[] }>;
  /**
   * Inserts new records; a different status on an existing record is a
   * correction that needs `reason` and writes NXA_AttendanceChangeHistory.
   * Students must hold an ACTIVE or COMPLETED enrollment in the session's batch.
   */
  markAttendance(
    sessionId: string,
    records: Array<{ studentUserId: string; status: AttendanceStatusValue; remarks?: string | undefined }>,
    reason: string | undefined,
    actorUserId: string,
  ): Promise<AttendanceMarkResult>;
  getAttendanceChanges(sessionId: string): Promise<AttendanceChange[]>;
  getAttendanceSummary(batchId: string): Promise<AttendanceSummary>;

  // Assignments (ADM-011, ASM-005: evaluation by authorized Admins)
  listAssignments(filter: { courseId?: string; batchId?: string }): Promise<AssignmentOverview[]>;
  listSubmissions(assignmentId: string): Promise<SubmissionOverview[]>;
  /** A new evaluation version (marks 0..MaximumMarks); never overwrites earlier ones. */
  evaluateSubmission(
    submissionId: string,
    input: { marksAwarded: number; feedback?: string | undefined },
    actorUserId: string,
  ): Promise<SubmissionOverview>;

  /** ASM-012: every evaluation version of a submission, newest first. RecordNotFoundError for an unknown submission. */
  listEvaluations(submissionId: string): Promise<EvaluationVersion[]>;

  // Tests (ADM-011, ASM-011 / BR-012: Admin override of retake permissions)
  listTests(filter: { courseId?: string; batchId?: string }): Promise<TestOverview[]>;
  listTestAttempts(testId: string): Promise<TestAttemptOverview[]>;
  listRetakeAuthorizations(testId: string): Promise<RetakeAuthorization[]>;
  /** The student must hold a non-cancelled enrollment in the test's course (and batch, if set). */
  authorizeRetake(
    testId: string,
    input: { studentUserId: string; additionalAttempts: number; reason: string },
    actorUserId: string,
  ): Promise<RetakeAuthorization>;
}
