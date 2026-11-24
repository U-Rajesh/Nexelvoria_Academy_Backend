import sql from "mssql";
import { getSqlServerPool } from "../../db/sqlserver.pool";
import { RecordNotFoundError } from "../../repositories/repository.errors";
import { writeAuditLog } from "../admin/sqlserver-admin.repository";
import { AcademicRuleError, type AcademicsRepository, type ClassSessionInput } from "./academics.repository";
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

const isId = (id: string | undefined | null): id is string => typeof id === "string" && /^\d{1,19}$/.test(id);
const iso = (d: Date | string | null | undefined): string | undefined => (d ? new Date(d).toISOString() : undefined);
const num = (v: unknown): number => Number(v ?? 0);

/** Enrollments whose students attend classes (BR-004: full access). */
const ATTENDING_ENROLLMENT = "UPPER(e.EnrollmentStatus) IN ('ACTIVE', 'COMPLETED')";
/** Same convention as the Admin enrollment flow for closed batches. */
const CLOSED_BATCH_STATUSES = ["completed", "cancelled"];

const SESSION_SELECT = `
  SELECT cs.ClassSessionId, cs.BatchId, b.BatchCode, cs.CourseId, c.CourseName, cs.TeacherUserId, tu.FullName AS TeacherName,
         cs.SessionTitle, cs.StartsAt, cs.EndsAt, cs.MeetingUrl, cs.SessionStatus, cs.CreatedByUserId, cs.CreatedAt
  FROM dbo.NXA_ClassSessions cs
  LEFT JOIN dbo.NXA_Batches b ON b.BatchId = cs.BatchId
  LEFT JOIN dbo.NXA_Courses c ON c.CourseId = cs.CourseId
  LEFT JOIN dbo.NXA_Users tu ON tu.UserId = cs.TeacherUserId
`;

/* eslint-disable @typescript-eslint/no-explicit-any */
const toSession = (r: any): ClassSession => ({
  id: String(r.ClassSessionId),
  batchId: String(r.BatchId),
  batchCode: r.BatchCode ?? undefined,
  courseId: String(r.CourseId),
  courseName: r.CourseName ?? undefined,
  teacherUserId: String(r.TeacherUserId),
  teacherName: r.TeacherName ?? undefined,
  sessionTitle: r.SessionTitle,
  startsAt: iso(r.StartsAt) ?? "",
  endsAt: iso(r.EndsAt) ?? "",
  meetingUrl: r.MeetingUrl ?? undefined,
  sessionStatus: r.SessionStatus ?? undefined,
  createdByUserId: r.CreatedByUserId != null ? String(r.CreatedByUserId) : undefined,
  createdAt: iso(r.CreatedAt) ?? "",
});

const toSubmission = (r: any): SubmissionOverview => ({
  id: String(r.AssignmentSubmissionId),
  assignmentId: String(r.AssignmentId),
  studentUserId: String(r.StudentUserId),
  studentName: r.StudentName ?? undefined,
  submissionType: r.SubmissionType,
  submissionStatus: r.SubmissionStatus ?? undefined,
  submissionVersion: num(r.SubmissionVersion),
  submittedAt: iso(r.SubmittedAt) ?? "",
  gitHubUrl: r.GitHubUrl ?? undefined,
  objectKey: r.ObjectKey ?? undefined,
  textContent: r.TextContent ?? undefined,
  latestEvaluation:
    r.EvaluationRecordId != null
      ? {
          id: String(r.EvaluationRecordId),
          marksAwarded: num(r.MarksAwarded),
          feedback: r.Feedback ?? undefined,
          evaluationVersion: num(r.EvaluationVersion),
          evaluatedByUserId: String(r.EvaluatedByUserId),
          evaluatedAt: iso(r.EvaluatedAt) ?? "",
        }
      : undefined,
});
/* eslint-enable @typescript-eslint/no-explicit-any */

export class SqlServerAcademicsRepository implements AcademicsRepository {
  constructor(private readonly getPool: () => Promise<sql.ConnectionPool> = getSqlServerPool) {}

  private async inTransaction<T>(work: (tx: sql.Transaction) => Promise<T>): Promise<T> {
    const pool = await this.getPool();
    const tx = pool.transaction();
    await tx.begin();
    try {
      const result = await work(tx);
      await tx.commit();
      return result;
    } catch (err) {
      try {
        await tx.rollback();
      } catch {
        // the original error is the one worth reporting
      }
      throw err;
    }
  }

  private async getSession(sessionId: string): Promise<ClassSession | null> {
    if (!isId(sessionId)) return null;
    const pool = await this.getPool();
    const r = await pool.request().input("Id", sql.BigInt, sessionId).query(`${SESSION_SELECT} WHERE cs.ClassSessionId = @Id`);
    return r.recordset[0] ? toSession(r.recordset[0]) : null;
  }

  // ---------------------------------------------------------------- schedules
  async listClassSessions(filter: { batchId?: string; teacherUserId?: string; from?: string; to?: string }): Promise<ClassSession[]> {
    const pool = await this.getPool();
    const req = pool.request();
    const where: string[] = ["1=1"];
    if (filter.batchId !== undefined) {
      if (!isId(filter.batchId)) return [];
      req.input("BatchId", sql.BigInt, filter.batchId);
      where.push("cs.BatchId = @BatchId");
    }
    if (filter.teacherUserId !== undefined) {
      if (!isId(filter.teacherUserId)) return [];
      req.input("TeacherId", sql.BigInt, filter.teacherUserId);
      where.push("cs.TeacherUserId = @TeacherId");
    }
    if (filter.from) {
      req.input("From", sql.DateTime2, new Date(filter.from));
      where.push("cs.EndsAt >= @From");
    }
    if (filter.to) {
      req.input("To", sql.DateTime2, new Date(filter.to));
      where.push("cs.StartsAt <= @To");
    }
    const r = await req.query(`${SESSION_SELECT} WHERE ${where.join(" AND ")} ORDER BY cs.StartsAt ASC, cs.ClassSessionId ASC`);
    return r.recordset.map(toSession);
  }

  /** Shared checks for create/update; runs inside the caller's transaction. */
  private async validateSchedule(
    tx: sql.Transaction,
    s: { batchId: string; courseId: string; teacherUserId: string; startsAt: Date; endsAt: Date; excludeSessionId?: string },
  ): Promise<void> {
    if (!(s.endsAt > s.startsAt)) {
      throw new AcademicRuleError("INVALID_TIME_RANGE", "The session must end after it starts.");
    }
    if (!isId(s.teacherUserId)) throw new AcademicRuleError("TEACHER_NOT_ALLOCATED", "The teacher is not allocated to this batch.");

    const t = tx.request();
    t.input("TeacherId", sql.BigInt, s.teacherUserId);
    t.input("BatchId", sql.BigInt, s.batchId);
    t.input("CourseId", sql.BigInt, s.courseId);
    const teacher = await t.query(`
      SELECT TOP 1 1 AS x
      FROM dbo.NXA_TeacherAllocations ta
      JOIN dbo.NXA_Users u ON u.UserId = ta.TeacherUserId AND u.DeletedAt IS NULL
      WHERE ta.TeacherUserId = @TeacherId AND ta.IsActive = 1
        AND (ta.BatchId = @BatchId OR (ta.BatchId IS NULL AND ta.CourseId = @CourseId))
        AND EXISTS (
          SELECT 1 FROM dbo.NXA_UserRoles ur JOIN dbo.NXA_Roles r ON r.RoleId = ur.RoleId
          WHERE ur.UserId = u.UserId AND LOWER(r.RoleCode) = 'teacher'
        )
    `);
    if (teacher.recordset.length === 0) {
      throw new AcademicRuleError("TEACHER_NOT_ALLOCATED", "The teacher is not allocated to this batch.");
    }

    // Overlap checks under a range lock, so two concurrent saves cannot both pass.
    const o = tx.request();
    o.input("BatchId", sql.BigInt, s.batchId);
    o.input("TeacherId", sql.BigInt, s.teacherUserId);
    o.input("StartsAt", sql.DateTime2, s.startsAt);
    o.input("EndsAt", sql.DateTime2, s.endsAt);
    o.input("Exclude", sql.BigInt, s.excludeSessionId ?? null);
    const clash = await o.query<{ BatchId: number | bigint; TeacherUserId: number | bigint }>(`
      SELECT BatchId, TeacherUserId
      FROM dbo.NXA_ClassSessions WITH (UPDLOCK, HOLDLOCK)
      WHERE (BatchId = @BatchId OR TeacherUserId = @TeacherId)
        AND StartsAt < @EndsAt AND EndsAt > @StartsAt
        AND (@Exclude IS NULL OR ClassSessionId <> @Exclude)
    `);
    if (clash.recordset.some((c) => String(c.BatchId) === s.batchId)) {
      throw new AcademicRuleError("BATCH_SCHEDULE_CONFLICT", "The batch already has a session in this time range.", 409);
    }
    if (clash.recordset.length > 0) {
      throw new AcademicRuleError("TEACHER_SCHEDULE_CONFLICT", "The teacher already has a session in this time range.", 409);
    }
  }

  async createClassSession(input: ClassSessionInput, actorUserId: string): Promise<ClassSession> {
    if (!isId(input.batchId)) throw new RecordNotFoundError("batch", input.batchId);
    const id = await this.inTransaction(async (tx) => {
      const b = tx.request();
      b.input("BatchId", sql.BigInt, input.batchId);
      const batch = await b.query<{ CourseId: number | bigint; Status: string | null }>(
        `SELECT CourseId, Status FROM dbo.NXA_Batches WHERE BatchId = @BatchId`,
      );
      const row = batch.recordset[0];
      if (!row) throw new RecordNotFoundError("batch", input.batchId);
      if (CLOSED_BATCH_STATUSES.includes(String(row.Status ?? "").toLowerCase())) {
        throw new AcademicRuleError("BATCH_CLOSED", `Cannot schedule a session for a ${String(row.Status).toLowerCase()} batch.`);
      }
      const courseId = String(row.CourseId);
      const startsAt = new Date(input.startsAt);
      const endsAt = new Date(input.endsAt);
      await this.validateSchedule(tx, { batchId: input.batchId, courseId, teacherUserId: input.teacherUserId, startsAt, endsAt });

      const ins = tx.request();
      ins.input("BatchId", sql.BigInt, input.batchId);
      ins.input("CourseId", sql.BigInt, courseId);
      ins.input("TeacherId", sql.BigInt, input.teacherUserId);
      ins.input("Title", sql.NVarChar(200), input.sessionTitle);
      ins.input("StartsAt", sql.DateTime2, startsAt);
      ins.input("EndsAt", sql.DateTime2, endsAt);
      ins.input("MeetingUrl", sql.NVarChar(1000), input.meetingUrl ?? null);
      ins.input("CreatedBy", sql.BigInt, isId(actorUserId) ? actorUserId : null);
      // SessionStatus is omitted: its table default applies (allowed values are not visible).
      const created = await ins.query<{ ClassSessionId: number | bigint }>(`
        INSERT INTO dbo.NXA_ClassSessions (BatchId, CourseId, TeacherUserId, SessionTitle, StartsAt, EndsAt, MeetingUrl, CreatedByUserId, CreatedAt)
        OUTPUT INSERTED.ClassSessionId
        VALUES (@BatchId, @CourseId, @TeacherId, @Title, @StartsAt, @EndsAt, @MeetingUrl, @CreatedBy, SYSUTCDATETIME())
      `);
      const newId = String(created.recordset[0]?.ClassSessionId);
      await writeAuditLog(tx.request(), {
        actorUserId,
        actionType: "CREATE_CLASS_SESSION",
        moduleCode: "ATTENDANCE_MGMT",
        entityName: "ClassSession",
        entityId: newId,
        newValues: JSON.stringify({ batchId: input.batchId, teacherUserId: input.teacherUserId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() }),
      });
      return newId;
    });
    const session = await this.getSession(id);
    if (!session) throw new RecordNotFoundError("class session", id);
    return session;
  }

  async updateClassSession(
    sessionId: string,
    changes: Partial<Omit<ClassSessionInput, "batchId">>,
    actorUserId: string,
  ): Promise<ClassSession> {
    if (!isId(sessionId)) throw new RecordNotFoundError("class session", sessionId);
    await this.inTransaction(async (tx) => {
      const cur = tx.request();
      cur.input("Id", sql.BigInt, sessionId);
      const before = await cur.query<{
        BatchId: number | bigint; CourseId: number | bigint; TeacherUserId: number | bigint;
        SessionTitle: string; StartsAt: Date; EndsAt: Date; MeetingUrl: string | null;
      }>(`SELECT BatchId, CourseId, TeacherUserId, SessionTitle, StartsAt, EndsAt, MeetingUrl FROM dbo.NXA_ClassSessions WITH (UPDLOCK, HOLDLOCK) WHERE ClassSessionId = @Id`);
      const row = before.recordset[0];
      if (!row) throw new RecordNotFoundError("class session", sessionId);

      const next = {
        teacherUserId: changes.teacherUserId ?? String(row.TeacherUserId),
        sessionTitle: changes.sessionTitle ?? row.SessionTitle,
        startsAt: changes.startsAt ? new Date(changes.startsAt) : new Date(row.StartsAt),
        endsAt: changes.endsAt ? new Date(changes.endsAt) : new Date(row.EndsAt),
        meetingUrl: changes.meetingUrl !== undefined ? changes.meetingUrl : row.MeetingUrl,
      };
      const unchanged =
        next.teacherUserId === String(row.TeacherUserId) &&
        next.sessionTitle === row.SessionTitle &&
        next.startsAt.getTime() === new Date(row.StartsAt).getTime() &&
        next.endsAt.getTime() === new Date(row.EndsAt).getTime() &&
        (next.meetingUrl ?? null) === (row.MeetingUrl ?? null);
      if (unchanged) return;

      await this.validateSchedule(tx, {
        batchId: String(row.BatchId),
        courseId: String(row.CourseId),
        teacherUserId: next.teacherUserId,
        startsAt: next.startsAt,
        endsAt: next.endsAt,
        excludeSessionId: sessionId,
      });

      const upd = tx.request();
      upd.input("Id", sql.BigInt, sessionId);
      upd.input("TeacherId", sql.BigInt, next.teacherUserId);
      upd.input("Title", sql.NVarChar(200), next.sessionTitle);
      upd.input("StartsAt", sql.DateTime2, next.startsAt);
      upd.input("EndsAt", sql.DateTime2, next.endsAt);
      upd.input("MeetingUrl", sql.NVarChar(1000), next.meetingUrl ?? null);
      await upd.query(`
        UPDATE dbo.NXA_ClassSessions
        SET TeacherUserId = @TeacherId, SessionTitle = @Title, StartsAt = @StartsAt, EndsAt = @EndsAt, MeetingUrl = @MeetingUrl
        WHERE ClassSessionId = @Id
      `);
      await writeAuditLog(tx.request(), {
        actorUserId,
        actionType: "UPDATE_CLASS_SESSION",
        moduleCode: "ATTENDANCE_MGMT",
        entityName: "ClassSession",
        entityId: sessionId,
        oldValues: JSON.stringify({ teacherUserId: String(row.TeacherUserId), sessionTitle: row.SessionTitle, startsAt: iso(row.StartsAt), endsAt: iso(row.EndsAt) }),
        newValues: JSON.stringify({ teacherUserId: next.teacherUserId, sessionTitle: next.sessionTitle, startsAt: next.startsAt.toISOString(), endsAt: next.endsAt.toISOString() }),
      });
    });
    const session = await this.getSession(sessionId);
    if (!session) throw new RecordNotFoundError("class session", sessionId);
    return session;
  }

  // --------------------------------------------------------------- attendance
  async getSessionAttendance(sessionId: string): Promise<{ session: ClassSession; roster: AttendanceRosterEntry[] }> {
    const session = await this.getSession(sessionId);
    if (!session) throw new RecordNotFoundError("class session", sessionId);
    const pool = await this.getPool();
    // Everyone attending the batch, plus anyone already holding a record for the session.
    const r = await pool
      .request()
      .input("Id", sql.BigInt, sessionId)
      .input("BatchId", sql.BigInt, session.batchId)
      .query(`
        SELECT x.StudentUserId, u.FullName AS StudentName,
               ar.AttendanceRecordId, ar.AttendanceStatus, ar.Remarks, ar.MarkedAt, ar.MarkedByUserId
        FROM (
          SELECT e.StudentUserId FROM dbo.NXA_Enrollments e WHERE e.BatchId = @BatchId AND ${ATTENDING_ENROLLMENT}
          UNION
          SELECT StudentUserId FROM dbo.NXA_AttendanceRecords WHERE ClassSessionId = @Id
        ) x
        LEFT JOIN dbo.NXA_Users u ON u.UserId = x.StudentUserId
        LEFT JOIN dbo.NXA_AttendanceRecords ar ON ar.ClassSessionId = @Id AND ar.StudentUserId = x.StudentUserId
        ORDER BY u.FullName ASC, x.StudentUserId ASC
      `);
    const roster: AttendanceRosterEntry[] = r.recordset.map((row) => ({
      studentUserId: String(row.StudentUserId),
      studentName: row.StudentName ?? undefined,
      record:
        row.AttendanceRecordId != null
          ? {
              id: String(row.AttendanceRecordId),
              status: String(row.AttendanceStatus ?? "").toLowerCase(),
              remarks: row.Remarks ?? undefined,
              markedAt: iso(row.MarkedAt) ?? "",
              markedByUserId: String(row.MarkedByUserId),
            }
          : undefined,
    }));
    return { session, roster };
  }

  async markAttendance(
    sessionId: string,
    records: Array<{ studentUserId: string; status: AttendanceStatusValue; remarks?: string | undefined }>,
    reason: string | undefined,
    actorUserId: string,
  ): Promise<AttendanceMarkResult> {
    if (!isId(sessionId)) throw new RecordNotFoundError("class session", sessionId);
    const bad = records.find((r) => !isId(r.studentUserId));
    if (bad) throw new AcademicRuleError("STUDENT_NOT_IN_BATCH", `Student ${bad.studentUserId} is not enrolled in this batch.`);

    return this.inTransaction(async (tx) => {
      const s = tx.request();
      s.input("Id", sql.BigInt, sessionId);
      const sess = await s.query<{ BatchId: number | bigint; StartsAt: Date }>(
        `SELECT BatchId, StartsAt FROM dbo.NXA_ClassSessions WITH (UPDLOCK, HOLDLOCK) WHERE ClassSessionId = @Id`,
      );
      const session = sess.recordset[0];
      if (!session) throw new RecordNotFoundError("class session", sessionId);
      if (new Date(session.StartsAt) > new Date()) {
        throw new AcademicRuleError("SESSION_NOT_STARTED", "Attendance can be recorded only once the session has started.");
      }

      // Who may be marked: students attending the session's batch.
      const e = tx.request();
      e.input("BatchId", sql.BigInt, session.BatchId);
      const enrolled = await e.query<{ StudentUserId: number | bigint }>(
        `SELECT DISTINCT e.StudentUserId FROM dbo.NXA_Enrollments e WHERE e.BatchId = @BatchId AND ${ATTENDING_ENROLLMENT}`,
      );
      const allowed = new Set(enrolled.recordset.map((x) => String(x.StudentUserId)));
      const outsider = records.find((r) => !allowed.has(r.studentUserId));
      if (outsider) {
        throw new AcademicRuleError("STUDENT_NOT_IN_BATCH", `Student ${outsider.studentUserId} is not enrolled in this batch.`);
      }

      const ex = tx.request();
      ex.input("Id", sql.BigInt, sessionId);
      const existing = await ex.query<{ AttendanceRecordId: number | bigint; StudentUserId: number | bigint; AttendanceStatus: string }>(
        `SELECT AttendanceRecordId, StudentUserId, AttendanceStatus FROM dbo.NXA_AttendanceRecords WITH (UPDLOCK, HOLDLOCK) WHERE ClassSessionId = @Id`,
      );
      const byStudent = new Map(existing.recordset.map((x) => [String(x.StudentUserId), x]));

      const corrections = records.filter((r) => {
        const cur = byStudent.get(r.studentUserId);
        return cur && String(cur.AttendanceStatus ?? "").toUpperCase() !== r.status.toUpperCase();
      });
      if (corrections.length > 0 && (!reason || reason.trim().length < 5)) {
        throw new AcademicRuleError(
          "CORRECTION_REASON_REQUIRED",
          "Changing an existing attendance record requires a reason of at least 5 characters.",
        );
      }

      const result: AttendanceMarkResult = { created: 0, corrected: 0, unchanged: 0 };
      for (const r of records) {
        const cur = byStudent.get(r.studentUserId);
        const status = r.status.toUpperCase();
        if (!cur) {
          const ins = tx.request();
          ins.input("Id", sql.BigInt, sessionId);
          ins.input("StudentId", sql.BigInt, r.studentUserId);
          ins.input("Status", sql.VarChar(10), status);
          ins.input("MarkedBy", sql.BigInt, actorUserId);
          ins.input("Remarks", sql.NVarChar(500), r.remarks ?? null);
          await ins.query(`
            INSERT INTO dbo.NXA_AttendanceRecords (ClassSessionId, StudentUserId, AttendanceStatus, MarkedByUserId, Remarks, MarkedAt)
            VALUES (@Id, @StudentId, @Status, @MarkedBy, @Remarks, SYSUTCDATETIME())
          `);
          result.created++;
        } else if (String(cur.AttendanceStatus ?? "").toUpperCase() !== status) {
          const upd = tx.request();
          upd.input("RecordId", sql.BigInt, cur.AttendanceRecordId);
          upd.input("Status", sql.VarChar(10), status);
          upd.input("MarkedBy", sql.BigInt, actorUserId);
          upd.input("Remarks", sql.NVarChar(500), r.remarks ?? null);
          await upd.query(`
            UPDATE dbo.NXA_AttendanceRecords
            SET AttendanceStatus = @Status, MarkedByUserId = @MarkedBy, MarkedAt = SYSUTCDATETIME(),
                Remarks = COALESCE(@Remarks, Remarks)
            WHERE AttendanceRecordId = @RecordId
          `);
          const h = tx.request();
          h.input("RecordId", sql.BigInt, cur.AttendanceRecordId);
          h.input("Old", sql.VarChar(10), cur.AttendanceStatus);
          h.input("New", sql.VarChar(10), status);
          h.input("Reason", sql.NVarChar(500), reason!.trim());
          h.input("ChangedBy", sql.BigInt, actorUserId);
          await h.query(`
            INSERT INTO dbo.NXA_AttendanceChangeHistory (AttendanceRecordId, OldStatus, NewStatus, ChangeReason, ChangedByUserId, ChangedAt)
            VALUES (@RecordId, @Old, @New, @Reason, @ChangedBy, SYSUTCDATETIME())
          `);
          result.corrected++;
        } else {
          result.unchanged++; // same status: nothing is overwritten
        }
      }

      if (result.created + result.corrected > 0) {
        await writeAuditLog(tx.request(), {
          actorUserId,
          actionType: result.corrected > 0 ? "CORRECT_ATTENDANCE" : "MARK_ATTENDANCE",
          moduleCode: "ATTENDANCE_MGMT",
          entityName: "ClassSession",
          entityId: sessionId,
          newValues: JSON.stringify({ ...result, ...(result.corrected > 0 ? { reason: reason!.trim() } : {}) }),
        });
      }
      return result;
    });
  }

  async getAttendanceChanges(sessionId: string): Promise<AttendanceChange[]> {
    if (!(await this.getSession(sessionId))) throw new RecordNotFoundError("class session", sessionId);
    const pool = await this.getPool();
    const r = await pool.request().input("Id", sql.BigInt, sessionId).query(`
      SELECT h.AttendanceChangeHistoryId, h.AttendanceRecordId, ar.StudentUserId, h.OldStatus, h.NewStatus,
             h.ChangeReason, h.ChangedByUserId, u.FullName AS ChangedByName, h.ChangedAt
      FROM dbo.NXA_AttendanceChangeHistory h
      JOIN dbo.NXA_AttendanceRecords ar ON ar.AttendanceRecordId = h.AttendanceRecordId
      LEFT JOIN dbo.NXA_Users u ON u.UserId = h.ChangedByUserId
      WHERE ar.ClassSessionId = @Id
      ORDER BY h.ChangedAt DESC, h.AttendanceChangeHistoryId DESC
    `);
    return r.recordset.map((x) => ({
      id: String(x.AttendanceChangeHistoryId),
      attendanceRecordId: String(x.AttendanceRecordId),
      studentUserId: String(x.StudentUserId),
      oldStatus: String(x.OldStatus ?? "").toLowerCase(),
      newStatus: String(x.NewStatus ?? "").toLowerCase(),
      changeReason: x.ChangeReason,
      changedByUserId: String(x.ChangedByUserId),
      changedByName: x.ChangedByName ?? undefined,
      changedAt: iso(x.ChangedAt) ?? "",
    }));
  }

  async getAttendanceSummary(batchId: string): Promise<AttendanceSummary> {
    if (!isId(batchId)) throw new RecordNotFoundError("batch", batchId);
    const pool = await this.getPool();
    const b = await pool.request().input("BatchId", sql.BigInt, batchId).query(`SELECT BatchId FROM dbo.NXA_Batches WHERE BatchId = @BatchId`);
    if (b.recordset.length === 0) throw new RecordNotFoundError("batch", batchId);

    const held = await pool
      .request()
      .input("BatchId", sql.BigInt, batchId)
      .query<{ cnt: number }>(`SELECT COUNT(1) AS cnt FROM dbo.NXA_ClassSessions WHERE BatchId = @BatchId AND StartsAt <= SYSUTCDATETIME()`);

    const rows = await pool.request().input("BatchId", sql.BigInt, batchId).query(`
      SELECT x.StudentUserId, u.FullName AS StudentName,
             SUM(CASE WHEN UPPER(ar.AttendanceStatus) = 'PRESENT' THEN 1 ELSE 0 END) AS PresentCount,
             SUM(CASE WHEN UPPER(ar.AttendanceStatus) = 'ABSENT' THEN 1 ELSE 0 END) AS AbsentCount,
             SUM(CASE WHEN UPPER(ar.AttendanceStatus) = 'LEAVE' THEN 1 ELSE 0 END) AS LeaveCount,
             SUM(CASE WHEN ar.AttendanceRecordId IS NOT NULL AND UPPER(ar.AttendanceStatus) NOT IN ('PRESENT', 'ABSENT', 'LEAVE') THEN 1 ELSE 0 END) AS OtherCount,
             COUNT(ar.AttendanceRecordId) AS RecordedCount
      FROM (
        SELECT DISTINCT e.StudentUserId FROM dbo.NXA_Enrollments e WHERE e.BatchId = @BatchId AND ${ATTENDING_ENROLLMENT}
      ) x
      LEFT JOIN dbo.NXA_Users u ON u.UserId = x.StudentUserId
      LEFT JOIN dbo.NXA_ClassSessions cs ON cs.BatchId = @BatchId
      LEFT JOIN dbo.NXA_AttendanceRecords ar ON ar.ClassSessionId = cs.ClassSessionId AND ar.StudentUserId = x.StudentUserId
      GROUP BY x.StudentUserId, u.FullName
      ORDER BY u.FullName ASC, x.StudentUserId ASC
    `);
    return {
      batchId,
      heldSessions: num(held.recordset[0]?.cnt),
      students: rows.recordset.map((r) => ({
        studentUserId: String(r.StudentUserId),
        studentName: r.StudentName ?? undefined,
        present: num(r.PresentCount),
        absent: num(r.AbsentCount),
        leave: num(r.LeaveCount),
        other: num(r.OtherCount),
        recordedSessions: num(r.RecordedCount),
      })),
    };
  }

  // -------------------------------------------------------------- assignments
  async listAssignments(filter: { courseId?: string; batchId?: string }): Promise<AssignmentOverview[]> {
    const pool = await this.getPool();
    const req = pool.request();
    const where: string[] = ["1=1"];
    if (filter.courseId !== undefined) {
      if (!isId(filter.courseId)) return [];
      req.input("CourseId", sql.BigInt, filter.courseId);
      where.push("a.CourseId = @CourseId");
    }
    if (filter.batchId !== undefined) {
      if (!isId(filter.batchId)) return [];
      req.input("BatchId", sql.BigInt, filter.batchId);
      where.push("a.BatchId = @BatchId");
    }
    const r = await req.query(`
      SELECT a.AssignmentId, a.CourseId, c.CourseName, a.BatchId, b.BatchCode, a.Title, a.Instructions, a.DueAt, a.MaximumMarks, a.Status,
             a.CreatedByTeacherUserId, tu.FullName AS TeacherName,
             (SELECT COUNT(1) FROM dbo.NXA_AssignmentSubmissions s WHERE s.AssignmentId = a.AssignmentId) AS SubmissionCount,
             (SELECT COUNT(1) FROM dbo.NXA_AssignmentSubmissions s
               WHERE s.AssignmentId = a.AssignmentId
                 AND EXISTS (SELECT 1 FROM dbo.NXA_EvaluationRecords er WHERE er.AssignmentSubmissionId = s.AssignmentSubmissionId)) AS EvaluatedCount
      FROM dbo.NXA_Assignments a
      LEFT JOIN dbo.NXA_Courses c ON c.CourseId = a.CourseId
      LEFT JOIN dbo.NXA_Batches b ON b.BatchId = a.BatchId
      LEFT JOIN dbo.NXA_Users tu ON tu.UserId = a.CreatedByTeacherUserId
      WHERE ${where.join(" AND ")}
      ORDER BY a.CreatedAt DESC, a.AssignmentId DESC
    `);
    return r.recordset.map((x) => ({
      id: String(x.AssignmentId),
      courseId: String(x.CourseId),
      courseName: x.CourseName ?? undefined,
      batchId: x.BatchId != null ? String(x.BatchId) : undefined,
      batchCode: x.BatchCode ?? undefined,
      title: x.Title,
      instructions: x.Instructions ?? undefined,
      dueAt: iso(x.DueAt),
      maximumMarks: num(x.MaximumMarks),
      status: x.Status ?? undefined,
      createdByTeacherUserId: String(x.CreatedByTeacherUserId),
      teacherName: x.TeacherName ?? undefined,
      submissionCount: num(x.SubmissionCount),
      evaluatedCount: num(x.EvaluatedCount),
    }));
  }

  private static readonly SUBMISSION_SELECT = `
    SELECT s.AssignmentSubmissionId, s.AssignmentId, s.StudentUserId, u.FullName AS StudentName, s.SubmissionType,
           s.SubmissionStatus, s.SubmissionVersion, s.SubmittedAt, s.GitHubUrl, s.ObjectKey, s.TextContent,
           ev.EvaluationRecordId, ev.MarksAwarded, ev.Feedback, ev.EvaluationVersion, ev.EvaluatedByUserId, ev.EvaluatedAt
    FROM dbo.NXA_AssignmentSubmissions s
    LEFT JOIN dbo.NXA_Users u ON u.UserId = s.StudentUserId
    OUTER APPLY (
      SELECT TOP 1 er.EvaluationRecordId, er.MarksAwarded, er.Feedback, er.EvaluationVersion, er.EvaluatedByUserId, er.EvaluatedAt
      FROM dbo.NXA_EvaluationRecords er
      WHERE er.AssignmentSubmissionId = s.AssignmentSubmissionId
      ORDER BY er.EvaluationVersion DESC, er.EvaluationRecordId DESC
    ) ev
  `;

  async listSubmissions(assignmentId: string): Promise<SubmissionOverview[]> {
    if (!isId(assignmentId)) throw new RecordNotFoundError("assignment", assignmentId);
    const pool = await this.getPool();
    const a = await pool.request().input("Id", sql.BigInt, assignmentId).query(`SELECT AssignmentId FROM dbo.NXA_Assignments WHERE AssignmentId = @Id`);
    if (a.recordset.length === 0) throw new RecordNotFoundError("assignment", assignmentId);
    const r = await pool
      .request()
      .input("Id", sql.BigInt, assignmentId)
      .query(`${SqlServerAcademicsRepository.SUBMISSION_SELECT} WHERE s.AssignmentId = @Id ORDER BY s.SubmittedAt DESC, s.AssignmentSubmissionId DESC`);
    return r.recordset.map(toSubmission);
  }

  async evaluateSubmission(
    submissionId: string,
    input: { marksAwarded: number; feedback?: string | undefined },
    actorUserId: string,
  ): Promise<SubmissionOverview> {
    if (!isId(submissionId)) throw new RecordNotFoundError("submission", submissionId);
    await this.inTransaction(async (tx) => {
      const s = tx.request();
      s.input("Id", sql.BigInt, submissionId);
      const sub = await s.query<{ MaximumMarks: number | string; NextVersion: number }>(`
        SELECT a.MaximumMarks,
               ISNULL((SELECT MAX(er.EvaluationVersion) FROM dbo.NXA_EvaluationRecords er WITH (UPDLOCK, HOLDLOCK)
                       WHERE er.AssignmentSubmissionId = s.AssignmentSubmissionId), 0) + 1 AS NextVersion
        FROM dbo.NXA_AssignmentSubmissions s WITH (UPDLOCK, HOLDLOCK)
        JOIN dbo.NXA_Assignments a ON a.AssignmentId = s.AssignmentId
        WHERE s.AssignmentSubmissionId = @Id
      `);
      const row = sub.recordset[0];
      if (!row) throw new RecordNotFoundError("submission", submissionId);
      const max = Number(row.MaximumMarks);
      if (input.marksAwarded < 0 || input.marksAwarded > max) {
        throw new AcademicRuleError("MARKS_OUT_OF_RANGE", `Marks must be between 0 and ${max}.`);
      }

      // Same AssessmentType / SubmissionStatus values the teacher evaluation writes.
      const ins = tx.request();
      ins.input("Id", sql.BigInt, submissionId);
      ins.input("EvaluatorId", sql.BigInt, actorUserId);
      ins.input("Marks", sql.Decimal(8, 2), input.marksAwarded);
      ins.input("Feedback", sql.NVarChar(sql.MAX), input.feedback ?? null);
      ins.input("Version", sql.Int, row.NextVersion);
      await ins.query(`
        INSERT INTO dbo.NXA_EvaluationRecords (AssessmentType, AssignmentSubmissionId, EvaluatedByUserId, MarksAwarded, Feedback, EvaluationVersion, EvaluatedAt)
        VALUES ('assignment', @Id, @EvaluatorId, @Marks, @Feedback, @Version, SYSUTCDATETIME())
      `);
      const upd = tx.request();
      upd.input("Id", sql.BigInt, submissionId);
      await upd.query(`UPDATE dbo.NXA_AssignmentSubmissions SET SubmissionStatus = 'EVALUATED' WHERE AssignmentSubmissionId = @Id`);
      await writeAuditLog(tx.request(), {
        actorUserId,
        actionType: "EVALUATE_SUBMISSION",
        moduleCode: "ASSESSMENT_MGMT",
        entityName: "AssignmentSubmission",
        entityId: submissionId,
        newValues: JSON.stringify({ marksAwarded: input.marksAwarded, evaluationVersion: row.NextVersion }),
      });
    });
    const pool = await this.getPool();
    const r = await pool
      .request()
      .input("Id", sql.BigInt, submissionId)
      .query(`${SqlServerAcademicsRepository.SUBMISSION_SELECT} WHERE s.AssignmentSubmissionId = @Id`);
    if (!r.recordset[0]) throw new RecordNotFoundError("submission", submissionId);
    return toSubmission(r.recordset[0]);
  }

  async listEvaluations(submissionId: string): Promise<EvaluationVersion[]> {
    if (!isId(submissionId)) throw new RecordNotFoundError("submission", submissionId);
    const pool = await this.getPool();
    const exists = await pool.request().input("Id", sql.BigInt, submissionId).query(`SELECT 1 AS x FROM dbo.NXA_AssignmentSubmissions WHERE AssignmentSubmissionId = @Id`);
    if (exists.recordset.length === 0) throw new RecordNotFoundError("submission", submissionId);
    const r = await pool
      .request()
      .input("Id", sql.BigInt, submissionId)
      .query(`
        SELECT er.EvaluationRecordId, er.EvaluationVersion, er.MarksAwarded, er.Feedback, er.EvaluatedByUserId, u.FullName AS EvaluatedByName, er.EvaluatedAt
        FROM dbo.NXA_EvaluationRecords er
        LEFT JOIN dbo.NXA_Users u ON u.UserId = er.EvaluatedByUserId
        WHERE er.AssignmentSubmissionId = @Id
        ORDER BY er.EvaluationVersion DESC, er.EvaluationRecordId DESC
      `);
    return r.recordset.map((x) => ({
      id: String(x.EvaluationRecordId),
      evaluationVersion: Number(x.EvaluationVersion),
      marksAwarded: Number(x.MarksAwarded),
      ...(x.Feedback ? { feedback: x.Feedback } : {}),
      evaluatedByUserId: String(x.EvaluatedByUserId),
      ...(x.EvaluatedByName ? { evaluatedByName: x.EvaluatedByName } : {}),
      evaluatedAt: new Date(x.EvaluatedAt).toISOString(),
    }));
  }

  // -------------------------------------------------------------------- tests
  async listTests(filter: { courseId?: string; batchId?: string }): Promise<TestOverview[]> {
    const pool = await this.getPool();
    const req = pool.request();
    const where: string[] = ["1=1"];
    if (filter.courseId !== undefined) {
      if (!isId(filter.courseId)) return [];
      req.input("CourseId", sql.BigInt, filter.courseId);
      where.push("t.CourseId = @CourseId");
    }
    if (filter.batchId !== undefined) {
      if (!isId(filter.batchId)) return [];
      req.input("BatchId", sql.BigInt, filter.batchId);
      where.push("t.BatchId = @BatchId");
    }
    const r = await req.query(`
      SELECT t.TestId, t.CourseId, c.CourseName, t.BatchId, b.BatchCode, t.Title, t.DurationMinutes, t.MaximumMarks, t.PassingMarks,
             t.MaxAttempts, t.StartsAt, t.EndsAt, t.Status, t.CreatedByTeacherUserId,
             (SELECT COUNT(1) FROM dbo.NXA_TestAttempts ta WHERE ta.TestId = t.TestId) AS AttemptCount
      FROM dbo.NXA_Tests t
      LEFT JOIN dbo.NXA_Courses c ON c.CourseId = t.CourseId
      LEFT JOIN dbo.NXA_Batches b ON b.BatchId = t.BatchId
      WHERE ${where.join(" AND ")}
      ORDER BY t.CreatedAt DESC, t.TestId DESC
    `);
    return r.recordset.map((x) => ({
      id: String(x.TestId),
      courseId: String(x.CourseId),
      courseName: x.CourseName ?? undefined,
      batchId: x.BatchId != null ? String(x.BatchId) : undefined,
      batchCode: x.BatchCode ?? undefined,
      title: x.Title,
      durationMinutes: num(x.DurationMinutes),
      maximumMarks: num(x.MaximumMarks),
      passingMarks: x.PassingMarks != null ? num(x.PassingMarks) : undefined,
      maxAttempts: num(x.MaxAttempts),
      startsAt: iso(x.StartsAt),
      endsAt: iso(x.EndsAt),
      status: x.Status ?? undefined,
      createdByTeacherUserId: String(x.CreatedByTeacherUserId),
      attemptCount: num(x.AttemptCount),
    }));
  }

  private async assertTest(testId: string): Promise<{ CourseId: number | bigint; BatchId: number | bigint | null }> {
    if (!isId(testId)) throw new RecordNotFoundError("test", testId);
    const pool = await this.getPool();
    const t = await pool.request().input("Id", sql.BigInt, testId).query(`SELECT CourseId, BatchId FROM dbo.NXA_Tests WHERE TestId = @Id`);
    if (!t.recordset[0]) throw new RecordNotFoundError("test", testId);
    return t.recordset[0];
  }

  async listTestAttempts(testId: string): Promise<TestAttemptOverview[]> {
    await this.assertTest(testId);
    const pool = await this.getPool();
    const r = await pool.request().input("Id", sql.BigInt, testId).query(`
      SELECT ta.TestAttemptId, ta.TestId, ta.StudentUserId, u.FullName AS StudentName, ta.AttemptNumber, ta.AttemptStatus,
             ta.StartedAt, ta.SubmittedAt, ta.TotalMarks
      FROM dbo.NXA_TestAttempts ta
      LEFT JOIN dbo.NXA_Users u ON u.UserId = ta.StudentUserId
      WHERE ta.TestId = @Id
      ORDER BY ta.StudentUserId ASC, ta.AttemptNumber ASC
    `);
    return r.recordset.map((x) => ({
      id: String(x.TestAttemptId),
      testId: String(x.TestId),
      studentUserId: String(x.StudentUserId),
      studentName: x.StudentName ?? undefined,
      attemptNumber: num(x.AttemptNumber),
      attemptStatus: x.AttemptStatus ?? undefined,
      startedAt: iso(x.StartedAt) ?? "",
      submittedAt: iso(x.SubmittedAt),
      totalMarks: x.TotalMarks != null ? num(x.TotalMarks) : undefined,
    }));
  }

  private static readonly RETAKE_SELECT = `
    SELECT ra.RetakeAuthorizationId, ra.TestId, ra.StudentUserId, u.FullName AS StudentName, ra.AdditionalAttempts,
           ra.Reason, ra.AuthorizedByUserId, ra.AuthorizedAt
    FROM dbo.NXA_RetakeAuthorizations ra
    LEFT JOIN dbo.NXA_Users u ON u.UserId = ra.StudentUserId
  `;

  /* eslint-disable @typescript-eslint/no-explicit-any */
  private static toRetake(x: any): RetakeAuthorization {
    return {
      id: String(x.RetakeAuthorizationId),
      testId: String(x.TestId),
      studentUserId: String(x.StudentUserId),
      studentName: x.StudentName ?? undefined,
      additionalAttempts: num(x.AdditionalAttempts),
      reason: x.Reason ?? undefined,
      authorizedByUserId: String(x.AuthorizedByUserId),
      authorizedAt: iso(x.AuthorizedAt) ?? "",
    };
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  async listRetakeAuthorizations(testId: string): Promise<RetakeAuthorization[]> {
    await this.assertTest(testId);
    const pool = await this.getPool();
    const r = await pool
      .request()
      .input("Id", sql.BigInt, testId)
      .query(`${SqlServerAcademicsRepository.RETAKE_SELECT} WHERE ra.TestId = @Id ORDER BY ra.AuthorizedAt DESC, ra.RetakeAuthorizationId DESC`);
    return r.recordset.map((x) => SqlServerAcademicsRepository.toRetake(x));
  }

  async authorizeRetake(
    testId: string,
    input: { studentUserId: string; additionalAttempts: number; reason: string },
    actorUserId: string,
  ): Promise<RetakeAuthorization> {
    if (!isId(testId)) throw new RecordNotFoundError("test", testId);
    if (!isId(input.studentUserId)) {
      throw new AcademicRuleError("STUDENT_NOT_ENROLLED", "The student is not enrolled in this test's course.");
    }
    const id = await this.inTransaction(async (tx) => {
      const t = tx.request();
      t.input("Id", sql.BigInt, testId);
      const test = await t.query<{ CourseId: number | bigint; BatchId: number | bigint | null }>(
        `SELECT CourseId, BatchId FROM dbo.NXA_Tests WHERE TestId = @Id`,
      );
      const row = test.recordset[0];
      if (!row) throw new RecordNotFoundError("test", testId);

      const e = tx.request();
      e.input("StudentId", sql.BigInt, input.studentUserId);
      e.input("CourseId", sql.BigInt, row.CourseId);
      e.input("BatchId", sql.BigInt, row.BatchId);
      const enrolled = await e.query(`
        SELECT TOP 1 1 AS x FROM dbo.NXA_Enrollments e
        WHERE e.StudentUserId = @StudentId AND e.CourseId = @CourseId
          AND (@BatchId IS NULL OR e.BatchId = @BatchId)
          AND UPPER(e.EnrollmentStatus) <> 'CANCELLED'
      `);
      if (enrolled.recordset.length === 0) {
        throw new AcademicRuleError("STUDENT_NOT_ENROLLED", "The student is not enrolled in this test's course.");
      }

      const ins = tx.request();
      ins.input("TestId", sql.BigInt, testId);
      ins.input("StudentId", sql.BigInt, input.studentUserId);
      ins.input("Additional", sql.Int, input.additionalAttempts);
      ins.input("Reason", sql.NVarChar(500), input.reason);
      ins.input("AuthorizedBy", sql.BigInt, actorUserId);
      const created = await ins.query<{ RetakeAuthorizationId: number | bigint }>(`
        INSERT INTO dbo.NXA_RetakeAuthorizations (TestId, StudentUserId, AdditionalAttempts, Reason, AuthorizedByUserId, AuthorizedAt)
        OUTPUT INSERTED.RetakeAuthorizationId
        VALUES (@TestId, @StudentId, @Additional, @Reason, @AuthorizedBy, SYSUTCDATETIME())
      `);
      const newId = String(created.recordset[0]?.RetakeAuthorizationId);
      await writeAuditLog(tx.request(), {
        actorUserId,
        actionType: "AUTHORIZE_RETAKE",
        moduleCode: "ASSESSMENT_MGMT",
        entityName: "RetakeAuthorization",
        entityId: newId,
        newValues: JSON.stringify({ testId, studentUserId: input.studentUserId, additionalAttempts: input.additionalAttempts, reason: input.reason }),
      });
      return newId;
    });
    const pool = await this.getPool();
    const r = await pool.request().input("Id", sql.BigInt, id).query(`${SqlServerAcademicsRepository.RETAKE_SELECT} WHERE ra.RetakeAuthorizationId = @Id`);
    if (!r.recordset[0]) throw new RecordNotFoundError("retake authorization", id);
    return SqlServerAcademicsRepository.toRetake(r.recordset[0]);
  }
}
