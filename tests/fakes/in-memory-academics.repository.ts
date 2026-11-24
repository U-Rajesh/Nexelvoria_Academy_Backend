import { RecordNotFoundError } from "../../src/repositories/repository.errors";
import {
  AcademicRuleError,
  type AcademicsRepository,
  type ClassSessionInput,
} from "../../src/modules/academics/academics.repository";
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
} from "../../src/modules/academics/academics.types";

/** Seed rows, shaped like the live tables the SQL adapter reads. */
export interface FakeBatch { id: string; courseId: string; status: string }
export interface FakeAllocation { teacherUserId: string; courseId: string; batchId?: string; isActive: boolean }
export interface FakeEnrollment { studentUserId: string; courseId: string; batchId: string; status: string }
export interface FakeAttendanceRecord { id: string; sessionId: string; studentUserId: string; status: string; remarks?: string; markedAt: string; markedByUserId: string }
export interface FakeAssignment { id: string; courseId: string; batchId?: string; title: string; instructions?: string; maximumMarks: number; createdByTeacherUserId: string }
export interface FakeSubmission { id: string; assignmentId: string; studentUserId: string; submissionType: string; submissionStatus: string; submissionVersion: number; submittedAt: string }
export interface FakeEvaluation { id: string; submissionId: string; marksAwarded: number; feedback?: string; evaluationVersion: number; evaluatedByUserId: string; evaluatedAt: string; assessmentType: string }
export interface FakeTest { id: string; courseId: string; batchId?: string; title: string; durationMinutes: number; maximumMarks: number; maxAttempts: number; createdByTeacherUserId: string }
export interface FakeAudit { actorUserId: string; actionType: string; moduleCode: string; entityName: string; entityId: string; newValues?: string }

const isId = (v: string | undefined): v is string => typeof v === "string" && /^\d{1,19}$/.test(v);
const ATTENDING = ["ACTIVE", "COMPLETED"];

export class InMemoryAcademicsRepository implements AcademicsRepository {
  batches: FakeBatch[] = [];
  teacherIds = new Set<string>();
  allocations: FakeAllocation[] = [];
  enrollments: FakeEnrollment[] = [];
  sessions: ClassSession[] = [];
  records: FakeAttendanceRecord[] = [];
  changes: AttendanceChange[] = [];
  assignments: FakeAssignment[] = [];
  submissions: FakeSubmission[] = [];
  evaluations: FakeEvaluation[] = [];
  tests: FakeTest[] = [];
  attempts: TestAttemptOverview[] = [];
  retakes: RetakeAuthorization[] = [];
  auditLogs: FakeAudit[] = [];
  /** Test hook: fail the audit write to prove nothing else persists. */
  failAudit = false;
  private seq = 1000;

  reset(): void {
    this.batches = [];
    this.teacherIds.clear();
    this.allocations = [];
    this.enrollments = [];
    this.sessions = [];
    this.records = [];
    this.changes = [];
    this.assignments = [];
    this.submissions = [];
    this.evaluations = [];
    this.tests = [];
    this.attempts = [];
    this.retakes = [];
    this.auditLogs = [];
    this.failAudit = false;
  }

  private nextId(): string {
    return String(++this.seq);
  }

  private audit(entry: FakeAudit): void {
    if (this.failAudit) throw new Error("audit write failed");
    this.auditLogs.push(entry);
  }

  /** Runs work against a snapshot and restores it on failure (transaction rollback). */
  private tx<T>(work: () => T): T {
    const snap = {
      sessions: this.sessions.map((s) => ({ ...s })),
      records: this.records.map((r) => ({ ...r })),
      changes: [...this.changes],
      submissions: this.submissions.map((s) => ({ ...s })),
      evaluations: [...this.evaluations],
      retakes: [...this.retakes],
      auditLogs: [...this.auditLogs],
    };
    try {
      return work();
    } catch (err) {
      Object.assign(this, snap);
      throw err;
    }
  }

  private attendingStudents(batchId: string): Set<string> {
    return new Set(this.enrollments.filter((e) => e.batchId === batchId && ATTENDING.includes(e.status.toUpperCase())).map((e) => e.studentUserId));
  }

  async listClassSessions(filter: { batchId?: string; teacherUserId?: string; from?: string; to?: string }): Promise<ClassSession[]> {
    if (filter.batchId !== undefined && !isId(filter.batchId)) return [];
    if (filter.teacherUserId !== undefined && !isId(filter.teacherUserId)) return [];
    return this.sessions
      .filter((s) => (filter.batchId === undefined || s.batchId === filter.batchId) && (filter.teacherUserId === undefined || s.teacherUserId === filter.teacherUserId))
      .filter((s) => (!filter.from || Date.parse(s.endsAt) >= Date.parse(filter.from)) && (!filter.to || Date.parse(s.startsAt) <= Date.parse(filter.to)))
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
      .map((s) => ({ ...s }));
  }

  private validateSchedule(s: { batchId: string; courseId: string; teacherUserId: string; startsAt: Date; endsAt: Date; excludeId?: string }): void {
    if (!(s.endsAt > s.startsAt)) throw new AcademicRuleError("INVALID_TIME_RANGE", "The session must end after it starts.");
    const allocated =
      this.teacherIds.has(s.teacherUserId) &&
      this.allocations.some((a) => a.teacherUserId === s.teacherUserId && a.isActive && (a.batchId === s.batchId || (a.batchId === undefined && a.courseId === s.courseId)));
    if (!allocated) throw new AcademicRuleError("TEACHER_NOT_ALLOCATED", "The teacher is not allocated to this batch.");
    const overlapping = this.sessions.filter(
      (x) => x.id !== s.excludeId && (x.batchId === s.batchId || x.teacherUserId === s.teacherUserId) && Date.parse(x.startsAt) < s.endsAt.getTime() && Date.parse(x.endsAt) > s.startsAt.getTime(),
    );
    if (overlapping.some((x) => x.batchId === s.batchId)) throw new AcademicRuleError("BATCH_SCHEDULE_CONFLICT", "The batch already has a session in this time range.", 409);
    if (overlapping.length > 0) throw new AcademicRuleError("TEACHER_SCHEDULE_CONFLICT", "The teacher already has a session in this time range.", 409);
  }

  async createClassSession(input: ClassSessionInput, actorUserId: string): Promise<ClassSession> {
    const batch = this.batches.find((b) => b.id === input.batchId);
    if (!batch) throw new RecordNotFoundError("batch", input.batchId);
    if (["completed", "cancelled"].includes(batch.status.toLowerCase())) {
      throw new AcademicRuleError("BATCH_CLOSED", `Cannot schedule a session for a ${batch.status.toLowerCase()} batch.`);
    }
    return this.tx(() => {
      const startsAt = new Date(input.startsAt);
      const endsAt = new Date(input.endsAt);
      this.validateSchedule({ batchId: batch.id, courseId: batch.courseId, teacherUserId: input.teacherUserId, startsAt, endsAt });
      const session: ClassSession = {
        id: this.nextId(),
        batchId: batch.id,
        courseId: batch.courseId,
        teacherUserId: input.teacherUserId,
        sessionTitle: input.sessionTitle,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        meetingUrl: input.meetingUrl,
        createdByUserId: actorUserId,
        createdAt: new Date().toISOString(),
      };
      this.sessions.push(session);
      this.audit({ actorUserId, actionType: "CREATE_CLASS_SESSION", moduleCode: "ATTENDANCE_MGMT", entityName: "ClassSession", entityId: session.id });
      return { ...session };
    });
  }

  async updateClassSession(sessionId: string, changes: Partial<Omit<ClassSessionInput, "batchId">>, actorUserId: string): Promise<ClassSession> {
    const cur = this.sessions.find((s) => s.id === sessionId);
    if (!cur) throw new RecordNotFoundError("class session", sessionId);
    return this.tx(() => {
      const next = {
        teacherUserId: changes.teacherUserId ?? cur.teacherUserId,
        sessionTitle: changes.sessionTitle ?? cur.sessionTitle,
        startsAt: new Date(changes.startsAt ?? cur.startsAt),
        endsAt: new Date(changes.endsAt ?? cur.endsAt),
        meetingUrl: changes.meetingUrl !== undefined ? changes.meetingUrl : cur.meetingUrl,
      };
      const unchanged =
        next.teacherUserId === cur.teacherUserId && next.sessionTitle === cur.sessionTitle && next.startsAt.toISOString() === cur.startsAt &&
        next.endsAt.toISOString() === cur.endsAt && next.meetingUrl === cur.meetingUrl;
      if (unchanged) return { ...cur };
      this.validateSchedule({ batchId: cur.batchId, courseId: cur.courseId, teacherUserId: next.teacherUserId, startsAt: next.startsAt, endsAt: next.endsAt, excludeId: cur.id });
      Object.assign(cur, { ...next, startsAt: next.startsAt.toISOString(), endsAt: next.endsAt.toISOString() });
      this.audit({ actorUserId, actionType: "UPDATE_CLASS_SESSION", moduleCode: "ATTENDANCE_MGMT", entityName: "ClassSession", entityId: cur.id });
      return { ...cur };
    });
  }

  async getSessionAttendance(sessionId: string): Promise<{ session: ClassSession; roster: AttendanceRosterEntry[] }> {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) throw new RecordNotFoundError("class session", sessionId);
    const ids = new Set([...this.attendingStudents(session.batchId), ...this.records.filter((r) => r.sessionId === sessionId).map((r) => r.studentUserId)]);
    const roster = [...ids].sort().map((studentUserId) => {
      const r = this.records.find((x) => x.sessionId === sessionId && x.studentUserId === studentUserId);
      return {
        studentUserId,
        record: r ? { id: r.id, status: r.status.toLowerCase(), remarks: r.remarks, markedAt: r.markedAt, markedByUserId: r.markedByUserId } : undefined,
      };
    });
    return { session: { ...session }, roster };
  }

  async markAttendance(
    sessionId: string,
    records: Array<{ studentUserId: string; status: AttendanceStatusValue; remarks?: string | undefined }>,
    reason: string | undefined,
    actorUserId: string,
  ): Promise<AttendanceMarkResult> {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) throw new RecordNotFoundError("class session", sessionId);
    if (Date.parse(session.startsAt) > Date.now()) {
      throw new AcademicRuleError("SESSION_NOT_STARTED", "Attendance can be recorded only once the session has started.");
    }
    const allowed = this.attendingStudents(session.batchId);
    const outsider = records.find((r) => !allowed.has(r.studentUserId));
    if (outsider) throw new AcademicRuleError("STUDENT_NOT_IN_BATCH", `Student ${outsider.studentUserId} is not enrolled in this batch.`);
    const existing = (id: string) => this.records.find((x) => x.sessionId === sessionId && x.studentUserId === id);
    if (records.some((r) => { const c = existing(r.studentUserId); return c && c.status.toUpperCase() !== r.status.toUpperCase(); }) && (!reason || reason.trim().length < 5)) {
      throw new AcademicRuleError("CORRECTION_REASON_REQUIRED", "Changing an existing attendance record requires a reason of at least 5 characters.");
    }
    return this.tx(() => {
      const result: AttendanceMarkResult = { created: 0, corrected: 0, unchanged: 0 };
      const now = new Date().toISOString();
      for (const r of records) {
        const cur = existing(r.studentUserId);
        const status = r.status.toUpperCase();
        if (!cur) {
          this.records.push({ id: this.nextId(), sessionId, studentUserId: r.studentUserId, status, ...(r.remarks ? { remarks: r.remarks } : {}), markedAt: now, markedByUserId: actorUserId });
          result.created++;
        } else if (cur.status.toUpperCase() !== status) {
          this.changes.push({
            id: this.nextId(), attendanceRecordId: cur.id, studentUserId: cur.studentUserId, oldStatus: cur.status.toLowerCase(), newStatus: status.toLowerCase(),
            changeReason: reason!.trim(), changedByUserId: actorUserId, changedAt: now,
          });
          Object.assign(cur, { status, markedByUserId: actorUserId, markedAt: now, ...(r.remarks ? { remarks: r.remarks } : {}) });
          result.corrected++;
        } else {
          result.unchanged++;
        }
      }
      if (result.created + result.corrected > 0) {
        this.audit({ actorUserId, actionType: result.corrected > 0 ? "CORRECT_ATTENDANCE" : "MARK_ATTENDANCE", moduleCode: "ATTENDANCE_MGMT", entityName: "ClassSession", entityId: sessionId, newValues: JSON.stringify(result) });
      }
      return result;
    });
  }

  async getAttendanceChanges(sessionId: string): Promise<AttendanceChange[]> {
    if (!this.sessions.some((s) => s.id === sessionId)) throw new RecordNotFoundError("class session", sessionId);
    const recIds = new Set(this.records.filter((r) => r.sessionId === sessionId).map((r) => r.id));
    return this.changes.filter((c) => recIds.has(c.attendanceRecordId)).reverse();
  }

  async getAttendanceSummary(batchId: string): Promise<AttendanceSummary> {
    if (!this.batches.some((b) => b.id === batchId)) throw new RecordNotFoundError("batch", batchId);
    const sessions = this.sessions.filter((s) => s.batchId === batchId);
    const sessionIds = new Set(sessions.map((s) => s.id));
    const students = [...this.attendingStudents(batchId)].sort().map((studentUserId) => {
      const recs = this.records.filter((r) => sessionIds.has(r.sessionId) && r.studentUserId === studentUserId).map((r) => r.status.toUpperCase());
      const count = (v: string) => recs.filter((x) => x === v).length;
      return {
        studentUserId, present: count("PRESENT"), absent: count("ABSENT"), leave: count("LEAVE"),
        other: recs.filter((x) => !["PRESENT", "ABSENT", "LEAVE"].includes(x)).length, recordedSessions: recs.length,
      };
    });
    return { batchId, heldSessions: sessions.filter((s) => Date.parse(s.startsAt) <= Date.now()).length, students };
  }

  private latestEvaluation(submissionId: string): FakeEvaluation | undefined {
    return this.evaluations.filter((e) => e.submissionId === submissionId).sort((a, b) => b.evaluationVersion - a.evaluationVersion)[0];
  }

  private toSubmission(s: FakeSubmission): SubmissionOverview {
    const ev = this.latestEvaluation(s.id);
    return {
      id: s.id, assignmentId: s.assignmentId, studentUserId: s.studentUserId, submissionType: s.submissionType, submissionStatus: s.submissionStatus,
      submissionVersion: s.submissionVersion, submittedAt: s.submittedAt,
      latestEvaluation: ev ? { id: ev.id, marksAwarded: ev.marksAwarded, feedback: ev.feedback, evaluationVersion: ev.evaluationVersion, evaluatedByUserId: ev.evaluatedByUserId, evaluatedAt: ev.evaluatedAt } : undefined,
    };
  }

  async listAssignments(filter: { courseId?: string; batchId?: string }): Promise<AssignmentOverview[]> {
    return this.assignments
      .filter((a) => (filter.courseId === undefined || a.courseId === filter.courseId) && (filter.batchId === undefined || a.batchId === filter.batchId))
      .map((a) => {
        const subs = this.submissions.filter((s) => s.assignmentId === a.id);
        return {
          id: a.id, courseId: a.courseId, batchId: a.batchId, title: a.title, instructions: a.instructions, maximumMarks: a.maximumMarks, createdByTeacherUserId: a.createdByTeacherUserId,
          submissionCount: subs.length, evaluatedCount: subs.filter((s) => this.evaluations.some((e) => e.submissionId === s.id)).length,
        };
      });
  }

  async listEvaluations(submissionId: string): Promise<EvaluationVersion[]> {
    if (!this.submissions.some((s) => s.id === submissionId)) throw new RecordNotFoundError("submission", submissionId);
    return this.evaluations
      .filter((e) => e.submissionId === submissionId)
      .sort((a, b) => b.evaluationVersion - a.evaluationVersion)
      .map((e) => ({
        id: e.id,
        evaluationVersion: e.evaluationVersion,
        marksAwarded: e.marksAwarded,
        ...(e.feedback ? { feedback: e.feedback } : {}),
        evaluatedByUserId: e.evaluatedByUserId,
        evaluatedAt: e.evaluatedAt,
      }));
  }

  async listSubmissions(assignmentId: string): Promise<SubmissionOverview[]> {
    if (!this.assignments.some((a) => a.id === assignmentId)) throw new RecordNotFoundError("assignment", assignmentId);
    return this.submissions.filter((s) => s.assignmentId === assignmentId).map((s) => this.toSubmission(s));
  }

  async evaluateSubmission(submissionId: string, input: { marksAwarded: number; feedback?: string | undefined }, actorUserId: string): Promise<SubmissionOverview> {
    const sub = this.submissions.find((s) => s.id === submissionId);
    if (!sub) throw new RecordNotFoundError("submission", submissionId);
    const max = this.assignments.find((a) => a.id === sub.assignmentId)!.maximumMarks;
    if (input.marksAwarded < 0 || input.marksAwarded > max) throw new AcademicRuleError("MARKS_OUT_OF_RANGE", `Marks must be between 0 and ${max}.`);
    return this.tx(() => {
      const version = (this.latestEvaluation(submissionId)?.evaluationVersion ?? 0) + 1;
      this.evaluations.push({
        id: this.nextId(), submissionId, marksAwarded: input.marksAwarded, ...(input.feedback ? { feedback: input.feedback } : {}), evaluationVersion: version,
        evaluatedByUserId: actorUserId, evaluatedAt: new Date().toISOString(), assessmentType: "assignment",
      });
      sub.submissionStatus = "EVALUATED";
      this.audit({ actorUserId, actionType: "EVALUATE_SUBMISSION", moduleCode: "ASSESSMENT_MGMT", entityName: "AssignmentSubmission", entityId: submissionId });
      return this.toSubmission(sub);
    });
  }

  async listTests(filter: { courseId?: string; batchId?: string }): Promise<TestOverview[]> {
    return this.tests
      .filter((t) => (filter.courseId === undefined || t.courseId === filter.courseId) && (filter.batchId === undefined || t.batchId === filter.batchId))
      .map((t) => ({ ...t, attemptCount: this.attempts.filter((a) => a.testId === t.id).length }));
  }

  async listTestAttempts(testId: string): Promise<TestAttemptOverview[]> {
    if (!this.tests.some((t) => t.id === testId)) throw new RecordNotFoundError("test", testId);
    return this.attempts.filter((a) => a.testId === testId);
  }

  async listRetakeAuthorizations(testId: string): Promise<RetakeAuthorization[]> {
    if (!this.tests.some((t) => t.id === testId)) throw new RecordNotFoundError("test", testId);
    return this.retakes.filter((r) => r.testId === testId).reverse();
  }

  async authorizeRetake(testId: string, input: { studentUserId: string; additionalAttempts: number; reason: string }, actorUserId: string): Promise<RetakeAuthorization> {
    const test = this.tests.find((t) => t.id === testId);
    if (!test) throw new RecordNotFoundError("test", testId);
    const enrolled = this.enrollments.some(
      (e) => e.studentUserId === input.studentUserId && e.courseId === test.courseId && (test.batchId === undefined || e.batchId === test.batchId) && e.status.toUpperCase() !== "CANCELLED",
    );
    if (!enrolled) throw new AcademicRuleError("STUDENT_NOT_ENROLLED", "The student is not enrolled in this test's course.");
    return this.tx(() => {
      const r: RetakeAuthorization = {
        id: this.nextId(), testId, studentUserId: input.studentUserId, additionalAttempts: input.additionalAttempts, reason: input.reason,
        authorizedByUserId: actorUserId, authorizedAt: new Date().toISOString(),
      };
      this.retakes.push(r);
      this.audit({ actorUserId, actionType: "AUTHORIZE_RETAKE", moduleCode: "ASSESSMENT_MGMT", entityName: "RetakeAuthorization", entityId: r.id });
      return { ...r };
    });
  }
}
