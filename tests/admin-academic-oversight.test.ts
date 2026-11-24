import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type sql from "mssql";

import { createApp } from "../src/app";
import { createAuthenticate } from "../src/middleware/authenticate.middleware";
import { issueAccessToken } from "../src/modules/auth/token.service";
import { AcademicRuleError } from "../src/modules/academics/academics.repository";
import { SqlServerAcademicsRepository } from "../src/modules/academics/sqlserver-academics.repository";
import { RecordNotFoundError } from "../src/repositories/repository.errors";
import { createTestHarness, type TestHarness } from "./fakes";
import { startServer, type TestServer } from "./helpers/server";

/**
 * Batch 3 item 3: Admin academic oversight over the live tables
 * NXA_ClassSessions, NXA_AttendanceRecords, NXA_AttendanceChangeHistory,
 * NXA_EvaluationRecords and NXA_RetakeAuthorizations.
 */

type Handler = (q: string, inputs: Record<string, unknown>) => unknown;

class MockSqlRequest {
  inputs: Record<string, unknown> = {};
  constructor(private readonly handler: Handler) {}
  input(name: string, typeOrValue: unknown, value?: unknown): this {
    this.inputs[name] = value !== undefined ? value : typeOrValue;
    return this;
  }
  async query<T = unknown>(command: string): Promise<{ recordset: T[]; rowsAffected: number[] }> {
    const res = this.handler(command, this.inputs);
    if (res instanceof Error) throw res;
    const r = (res ?? {}) as { recordset?: T[]; rowsAffected?: number[] };
    return { recordset: r.recordset ?? [], rowsAffected: r.rowsAffected ?? [1] };
  }
}

const trackedPool = (handler: Handler) => {
  const state = { committed: false, rolledBack: false, began: 0 };
  const seen: Array<{ q: string; inputs: Record<string, unknown> }> = [];
  const wrapped: Handler = (q, inputs) => {
    seen.push({ q, inputs: { ...inputs } });
    return handler(q, inputs);
  };
  const pool = {
    request: () => new MockSqlRequest(wrapped),
    transaction: () => ({
      begin: async () => {
        state.began += 1;
      },
      commit: async () => {
        state.committed = true;
      },
      rollback: async () => {
        state.rolledBack = true;
      },
      request: () => new MockSqlRequest(wrapped),
    }),
  } as unknown as sql.ConnectionPool;
  const writes = () => seen.filter((s) => /\b(INSERT|UPDATE|DELETE|MERGE)\b/.test(s.q));
  return { pool, state, seen, writes };
};

const repoFor = (pool: sql.ConnectionPool) => new SqlServerAcademicsRepository(async () => pool);
const PAST = new Date(Date.now() - 3600_000);
const FUTURE = new Date(Date.now() + 86_400_000);

const sessionRow = {
  ClassSessionId: 70, BatchId: 10, BatchCode: "B-10", CourseId: 5, CourseName: "Java", TeacherUserId: 40, TeacherName: "T",
  SessionTitle: "Intro", StartsAt: PAST, EndsAt: new Date(PAST.getTime() + 3600_000), MeetingUrl: null, SessionStatus: "SCHEDULED",
  CreatedByUserId: 1, CreatedAt: PAST,
};

describe("SqlServerAcademicsRepository: class schedules", () => {
  const scheduleHandler = (over: { batch?: unknown[]; teacher?: unknown[]; clash?: unknown[] } = {}): Handler => (q) => {
    if (/SELECT CourseId, Status FROM dbo\.NXA_Batches/.test(q)) return { recordset: over.batch ?? [{ CourseId: 5, Status: "active" }] };
    if (/NXA_TeacherAllocations/.test(q)) return { recordset: over.teacher ?? [{ x: 1 }] };
    if (/FROM dbo\.NXA_ClassSessions WITH \(UPDLOCK, HOLDLOCK\)\s+WHERE \(BatchId/.test(q)) return { recordset: over.clash ?? [] };
    if (/INSERT INTO dbo\.NXA_ClassSessions/.test(q)) return { recordset: [{ ClassSessionId: 70 }] };
    if (/INSERT INTO dbo\.NXA_AuditLogs/.test(q)) return { recordset: [{ AuditLogId: 1 }] };
    if (/WHERE cs\.ClassSessionId = @Id/.test(q)) return { recordset: [sessionRow] };
    return {};
  };
  const input = { batchId: "10", teacherUserId: "40", sessionTitle: "Intro", startsAt: "2026-12-01T09:00:00Z", endsAt: "2026-12-01T10:00:00Z" };

  it("validates teacher allocation and overlaps under a range lock, inserts without SessionStatus, audits, commits", async () => {
    const t = trackedPool(scheduleHandler());
    const s = await repoFor(t.pool).createClassSession(input, "1");
    assert.equal(s.id, "70");
    assert.equal(t.state.committed, true);
    const teacherQ = t.seen.find((x) => /NXA_TeacherAllocations/.test(x.q))!;
    assert.match(teacherQ.q, /IsActive = 1/);
    assert.match(teacherQ.q, /ta\.BatchId = @BatchId OR \(ta\.BatchId IS NULL AND ta\.CourseId = @CourseId\)/);
    assert.match(teacherQ.q, /LOWER\(r\.RoleCode\) = 'teacher'/);
    const ins = t.seen.find((x) => /INSERT INTO dbo\.NXA_ClassSessions/.test(x.q))!;
    assert.doesNotMatch(ins.q, /SessionStatus/, "SessionStatus is left to its table default");
    assert.equal(ins.inputs["CourseId"], "5", "course comes from the batch, not the request");
    assert.equal(ins.inputs["CreatedBy"], "1");
    const audit = t.seen.find((x) => /NXA_AuditLogs/.test(x.q))!;
    assert.equal(audit.inputs["action"], "CREATE_CLASS_SESSION");
    assert.equal(audit.inputs["module"], "ATTENDANCE_MGMT");
  });

  it("rejects a batch overlap (409) and a teacher overlap (409) with rollback and no insert", async () => {
    for (const [clash, code] of [
      [[{ BatchId: 10, TeacherUserId: 41 }], "BATCH_SCHEDULE_CONFLICT"],
      [[{ BatchId: 11, TeacherUserId: 40 }], "TEACHER_SCHEDULE_CONFLICT"],
    ] as const) {
      const t = trackedPool(scheduleHandler({ clash: [...clash] }));
      await assert.rejects(repoFor(t.pool).createClassSession(input, "1"), (e: unknown) => e instanceof AcademicRuleError && e.code === code && e.status === 409);
      assert.equal(t.state.rolledBack, true);
      assert.equal(t.writes().length, 0);
    }
  });

  it("rejects an unallocated teacher, a closed batch, an unknown batch and an inverted range", async () => {
    let t = trackedPool(scheduleHandler({ teacher: [] }));
    await assert.rejects(repoFor(t.pool).createClassSession(input, "1"), (e: unknown) => e instanceof AcademicRuleError && e.code === "TEACHER_NOT_ALLOCATED");
    assert.equal(t.writes().length, 0);

    t = trackedPool(scheduleHandler({ batch: [{ CourseId: 5, Status: "Completed" }] }));
    await assert.rejects(repoFor(t.pool).createClassSession(input, "1"), (e: unknown) => e instanceof AcademicRuleError && e.code === "BATCH_CLOSED");

    t = trackedPool(scheduleHandler({ batch: [] }));
    await assert.rejects(repoFor(t.pool).createClassSession(input, "1"), RecordNotFoundError);

    t = trackedPool(scheduleHandler());
    await assert.rejects(
      repoFor(t.pool).createClassSession({ ...input, endsAt: input.startsAt }, "1"),
      (e: unknown) => e instanceof AcademicRuleError && e.code === "INVALID_TIME_RANGE",
    );
    assert.equal(t.writes().length, 0);
  });

  it("an update excludes the session itself from the overlap check; an unchanged update writes nothing", async () => {
    const current = { BatchId: 10, CourseId: 5, TeacherUserId: 40, SessionTitle: "Intro", StartsAt: new Date("2026-12-01T09:00:00Z"), EndsAt: new Date("2026-12-01T10:00:00Z"), MeetingUrl: null };
    const h: Handler = (q) => (/SELECT BatchId, CourseId, TeacherUserId/.test(q) ? { recordset: [current] } : scheduleHandler()(q, {}));
    let t = trackedPool(h);
    await repoFor(t.pool).updateClassSession("70", { sessionTitle: "Intro" }, "1");
    assert.equal(t.writes().length, 0, "no-op");

    t = trackedPool(h);
    await repoFor(t.pool).updateClassSession("70", { endsAt: "2026-12-01T11:00:00Z" }, "1");
    const clash = t.seen.find((x) => /ClassSessionId <> @Exclude/.test(x.q))!;
    assert.equal(clash.inputs["Exclude"], "70");
    assert.ok(t.writes().some((w) => /UPDATE dbo\.NXA_ClassSessions/.test(w.q)));
    assert.equal(t.seen.find((x) => /NXA_AuditLogs/.test(x.q))!.inputs["action"], "UPDATE_CLASS_SESSION");
  });

  it("rejects non-numeric ids before opening a transaction", async () => {
    const t = trackedPool(scheduleHandler());
    await assert.rejects(repoFor(t.pool).createClassSession({ ...input, batchId: "b-1" }, "1"), RecordNotFoundError);
    await assert.rejects(repoFor(t.pool).updateClassSession("abc", { sessionTitle: "x" }, "1"), RecordNotFoundError);
    assert.equal(t.state.began, 0);
  });
});

describe("SqlServerAcademicsRepository: attendance", () => {
  const handler = (over: { startsAt?: Date; existing?: unknown[]; failHistory?: boolean } = {}): Handler => (q) => {
    if (/SELECT BatchId, StartsAt FROM dbo\.NXA_ClassSessions WITH \(UPDLOCK, HOLDLOCK\)/.test(q)) return { recordset: [{ BatchId: 10, StartsAt: over.startsAt ?? PAST }] };
    if (/SELECT DISTINCT e\.StudentUserId/.test(q)) return { recordset: [{ StudentUserId: 301 }, { StudentUserId: 302 }, { StudentUserId: 303 }] };
    if (/FROM dbo\.NXA_AttendanceRecords WITH \(UPDLOCK, HOLDLOCK\)/.test(q)) {
      return { recordset: over.existing ?? [{ AttendanceRecordId: 900, StudentUserId: 301, AttendanceStatus: "PRESENT" }, { AttendanceRecordId: 901, StudentUserId: 302, AttendanceStatus: "ABSENT" }] };
    }
    if (/INSERT INTO dbo\.NXA_AttendanceChangeHistory/.test(q) && over.failHistory) return new Error("history insert failed");
    if (/INSERT INTO dbo\.NXA_AuditLogs/.test(q)) return { recordset: [{ AuditLogId: 1 }] };
    return {};
  };

  it("creates new records, corrects changed ones with history, leaves identical ones untouched, in one audited transaction", async () => {
    const t = trackedPool(handler());
    const res = await repoFor(t.pool).markAttendance(
      "70",
      [
        { studentUserId: "301", status: "absent" }, // PRESENT -> ABSENT: correction
        { studentUserId: "302", status: "absent" }, // unchanged
        { studentUserId: "303", status: "leave" }, // new
      ],
      "Marked wrongly by mistake",
      "1",
    );
    assert.deepEqual(res, { created: 1, corrected: 1, unchanged: 1 });
    assert.equal(t.state.committed, true);

    const ins = t.writes().filter((w) => /INSERT INTO dbo\.NXA_AttendanceRecords/.test(w.q));
    assert.equal(ins.length, 1);
    assert.equal(ins[0]!.inputs["Status"], "LEAVE");
    assert.equal(ins[0]!.inputs["MarkedBy"], "1");

    const upd = t.writes().filter((w) => /UPDATE dbo\.NXA_AttendanceRecords/.test(w.q));
    assert.equal(upd.length, 1, "only the changed record is updated");
    assert.equal(upd[0]!.inputs["RecordId"], 900);

    const hist = t.writes().filter((w) => /INSERT INTO dbo\.NXA_AttendanceChangeHistory/.test(w.q));
    assert.equal(hist.length, 1);
    assert.deepEqual(
      { old: hist[0]!.inputs["Old"], next: hist[0]!.inputs["New"], reason: hist[0]!.inputs["Reason"], by: hist[0]!.inputs["ChangedBy"] },
      { old: "PRESENT", next: "ABSENT", reason: "Marked wrongly by mistake", by: "1" },
    );
    assert.equal(t.seen.find((x) => /NXA_AuditLogs/.test(x.q))!.inputs["action"], "CORRECT_ATTENDANCE");
  });

  it("refuses a correction without a reason and writes nothing", async () => {
    const t = trackedPool(handler());
    await assert.rejects(
      repoFor(t.pool).markAttendance("70", [{ studentUserId: "301", status: "leave" }], undefined, "1"),
      (e: unknown) => e instanceof AcademicRuleError && e.code === "CORRECTION_REASON_REQUIRED",
    );
    assert.equal(t.writes().length, 0);
    assert.equal(t.state.rolledBack, true);
  });

  it("refuses students outside the batch, sessions not yet started and unknown sessions", async () => {
    let t = trackedPool(handler());
    await assert.rejects(
      repoFor(t.pool).markAttendance("70", [{ studentUserId: "999", status: "present" }], undefined, "1"),
      (e: unknown) => e instanceof AcademicRuleError && e.code === "STUDENT_NOT_IN_BATCH",
    );
    assert.equal(t.writes().length, 0);

    t = trackedPool(handler({ startsAt: FUTURE }));
    await assert.rejects(
      repoFor(t.pool).markAttendance("70", [{ studentUserId: "303", status: "present" }], undefined, "1"),
      (e: unknown) => e instanceof AcademicRuleError && e.code === "SESSION_NOT_STARTED",
    );

    t = trackedPool((q) => (/NXA_ClassSessions WITH/.test(q) ? { recordset: [] } : {}));
    await assert.rejects(repoFor(t.pool).markAttendance("70", [{ studentUserId: "303", status: "present" }], undefined, "1"), RecordNotFoundError);
  });

  it("rolls the whole batch back when the history write fails", async () => {
    const t = trackedPool(handler({ failHistory: true }));
    await assert.rejects(repoFor(t.pool).markAttendance("70", [{ studentUserId: "303", status: "present" }, { studentUserId: "301", status: "absent" }], "Correcting record", "1"));
    assert.equal(t.state.rolledBack, true);
    assert.equal(t.state.committed, false);
  });

  it("a resubmission with identical statuses writes nothing and no audit", async () => {
    const t = trackedPool(handler());
    const res = await repoFor(t.pool).markAttendance("70", [{ studentUserId: "301", status: "present" }], undefined, "1");
    assert.deepEqual(res, { created: 0, corrected: 0, unchanged: 1 });
    assert.equal(t.writes().length, 0);
  });

  it("the summary reports counts per BR-010 status and no percentage", async () => {
    const t = trackedPool((q) => {
      if (/SELECT BatchId FROM dbo\.NXA_Batches/.test(q)) return { recordset: [{ BatchId: 10 }] };
      if (/COUNT\(1\) AS cnt/.test(q)) return { recordset: [{ cnt: 4 }] };
      if (/PresentCount/.test(q)) return { recordset: [{ StudentUserId: 301, StudentName: "A", PresentCount: 2, AbsentCount: 1, LeaveCount: 1, OtherCount: 0, RecordedCount: 4 }] };
      return {};
    });
    const s = await repoFor(t.pool).getAttendanceSummary("10");
    assert.equal(s.heldSessions, 4);
    assert.deepEqual(s.students[0], { studentUserId: "301", studentName: "A", present: 2, absent: 1, leave: 1, other: 0, recordedSessions: 4 });
    assert.ok(!("percentage" in s.students[0]!));
  });
});

describe("SqlServerAcademicsRepository: evaluations and retakes", () => {
  it("adds a new evaluation version (never overwrites), with the teacher-flow values, and audits", async () => {
    const t = trackedPool((q) => {
      if (/NextVersion/.test(q)) return { recordset: [{ MaximumMarks: "50.00", NextVersion: 3 }] };
      if (/INSERT INTO dbo\.NXA_AuditLogs/.test(q)) return { recordset: [{ AuditLogId: 1 }] };
      if (/WHERE s\.AssignmentSubmissionId = @Id/.test(q)) {
        return { recordset: [{ AssignmentSubmissionId: 55, AssignmentId: 5, StudentUserId: 301, SubmissionType: "GITHUB", SubmissionStatus: "EVALUATED", SubmissionVersion: 1, SubmittedAt: PAST, EvaluationRecordId: 9, MarksAwarded: 42, EvaluationVersion: 3, EvaluatedByUserId: 1, EvaluatedAt: PAST }] };
      }
      return {};
    });
    const r = await repoFor(t.pool).evaluateSubmission("55", { marksAwarded: 42 }, "1");
    assert.equal(r.latestEvaluation?.evaluationVersion, 3);
    const ins = t.writes().find((w) => /INSERT INTO dbo\.NXA_EvaluationRecords/.test(w.q))!;
    assert.match(ins.q, /'assignment'/);
    assert.equal(ins.inputs["Version"], 3);
    assert.equal(t.writes().filter((w) => /UPDATE dbo\.NXA_EvaluationRecords|DELETE/.test(w.q)).length, 0);
    assert.equal(t.seen.find((x) => /NXA_AuditLogs/.test(x.q))!.inputs["action"], "EVALUATE_SUBMISSION");
  });

  it("rejects marks above the assignment maximum with no writes", async () => {
    const t = trackedPool((q) => (/NextVersion/.test(q) ? { recordset: [{ MaximumMarks: 50, NextVersion: 1 }] } : {}));
    await assert.rejects(repoFor(t.pool).evaluateSubmission("55", { marksAwarded: 51 }, "1"), (e: unknown) => e instanceof AcademicRuleError && e.code === "MARKS_OUT_OF_RANGE");
    assert.equal(t.writes().length, 0);
  });

  it("authorizes a retake only for an enrolled student, with explicit attempts and reason, audited", async () => {
    const base: Handler = (q) => {
      if (/SELECT CourseId, BatchId FROM dbo\.NXA_Tests/.test(q)) return { recordset: [{ CourseId: 5, BatchId: 10 }] };
      if (/FROM dbo\.NXA_Enrollments e/.test(q)) return { recordset: [{ x: 1 }] };
      if (/INSERT INTO dbo\.NXA_RetakeAuthorizations/.test(q)) return { recordset: [{ RetakeAuthorizationId: 77 }] };
      if (/INSERT INTO dbo\.NXA_AuditLogs/.test(q)) return { recordset: [{ AuditLogId: 1 }] };
      if (/WHERE ra\.RetakeAuthorizationId = @Id/.test(q)) return { recordset: [{ RetakeAuthorizationId: 77, TestId: 8, StudentUserId: 301, AdditionalAttempts: 1, Reason: "Medical leave", AuthorizedByUserId: 1, AuthorizedAt: PAST }] };
      return {};
    };
    const t = trackedPool(base);
    const r = await repoFor(t.pool).authorizeRetake("8", { studentUserId: "301", additionalAttempts: 1, reason: "Medical leave" }, "1");
    assert.equal(r.id, "77");
    const ins = t.writes().find((w) => /INSERT INTO dbo\.NXA_RetakeAuthorizations/.test(w.q))!;
    assert.deepEqual([ins.inputs["Additional"], ins.inputs["Reason"], ins.inputs["AuthorizedBy"]], [1, "Medical leave", "1"]);
    assert.equal(t.seen.find((x) => /NXA_AuditLogs/.test(x.q))!.inputs["action"], "AUTHORIZE_RETAKE");
    assert.match(t.seen.find((x) => /FROM dbo\.NXA_Enrollments e/.test(x.q))!.q, /@BatchId IS NULL OR e\.BatchId = @BatchId/);

    const t2 = trackedPool((q, i) => (/FROM dbo\.NXA_Enrollments e/.test(q) ? { recordset: [] } : base(q, i)));
    await assert.rejects(
      repoFor(t2.pool).authorizeRetake("8", { studentUserId: "302", additionalAttempts: 1, reason: "Medical leave" }, "1"),
      (e: unknown) => e instanceof AcademicRuleError && e.code === "STUDENT_NOT_ENROLLED",
    );
    assert.equal(t2.writes().length, 0);
    assert.equal(t2.state.rolledBack, true);
  });

  it("rolls the retake back when the audit write fails", async () => {
    const t = trackedPool((q) => {
      if (/SELECT CourseId, BatchId FROM dbo\.NXA_Tests/.test(q)) return { recordset: [{ CourseId: 5, BatchId: null }] };
      if (/FROM dbo\.NXA_Enrollments e/.test(q)) return { recordset: [{ x: 1 }] };
      if (/INSERT INTO dbo\.NXA_RetakeAuthorizations/.test(q)) return { recordset: [{ RetakeAuthorizationId: 77 }] };
      if (/INSERT INTO dbo\.NXA_AuditLogs/.test(q)) return new Error("audit failed");
      return {};
    });
    await assert.rejects(repoFor(t.pool).authorizeRetake("8", { studentUserId: "301", additionalAttempts: 2, reason: "Network outage" }, "1"));
    assert.equal(t.state.rolledBack, true);
    assert.equal(t.state.committed, false);
  });
});

describe("/admin/academics endpoints", () => {
  let harness: TestHarness;
  let server: TestServer;
  const tokens: Record<string, string> = {};
  const auth = (role: string) => ({ headers: { Authorization: `Bearer ${tokens[role]}`, "Content-Type": "application/json" } });
  const json = async (res: Response) => (await res.json()) as Record<string, any>;
  const base = "/api/v1/admin/academics";

  beforeEach(async () => {
    harness = createTestHarness();
    let seq = 30;
    for (const role of ["admin", "super_admin", "teacher", "student"] as const) {
      seq++;
      const user = await harness.users.create({ name: `${role} U`, email: `${role}-a${seq}@test.local`, mobile: `98765411${seq}`, role, status: "active" });
      const session = await harness.sessions.create({
        userId: user.id,
        refreshTokenHash: Buffer.alloc(64, 1).toString("hex"),
        ipAddress: "127.0.0.1",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
      tokens[role] = issueAccessToken({ userId: user.id, role, sessionId: session.sessionId }).token;
    }
    const a = harness.academics;
    a.batches.push({ id: "10", courseId: "5", status: "active" }, { id: "11", courseId: "5", status: "cancelled" }, { id: "12", courseId: "6", status: "active" });
    a.teacherIds.add("40").add("41");
    a.allocations.push({ teacherUserId: "40", courseId: "5", batchId: "10", isActive: true }, { teacherUserId: "41", courseId: "6", isActive: true });
    a.enrollments.push(
      { studentUserId: "301", courseId: "5", batchId: "10", status: "ACTIVE" },
      { studentUserId: "302", courseId: "5", batchId: "10", status: "ACTIVE" },
      { studentUserId: "303", courseId: "5", batchId: "10", status: "CANCELLED" },
    );
    a.assignments.push({ id: "500", courseId: "5", batchId: "10", title: "A1", maximumMarks: 50, createdByTeacherUserId: "40" });
    a.submissions.push({ id: "550", assignmentId: "500", studentUserId: "301", submissionType: "GITHUB", submissionStatus: "SUBMITTED", submissionVersion: 1, submittedAt: PAST.toISOString() });
    a.tests.push({ id: "800", courseId: "5", batchId: "10", title: "T1", durationMinutes: 60, maximumMarks: 100, maxAttempts: 1, createdByTeacherUserId: "40" });
    const authenticate = createAuthenticate({ studentAccess: null, sessions: () => harness.sessions });
    server = await startServer(createApp({ container: harness.container, authenticate }));
  });

  afterEach(async () => {
    await server.close();
  });

  const pastSlot = (h: number) => ({ startsAt: new Date(Date.now() - h * 3600_000).toISOString(), endsAt: new Date(Date.now() - (h - 1) * 3600_000).toISOString() });

  it("only admin and super_admin reach any academics endpoint (teacher and student get 403, anonymous 401)", async () => {
    for (const role of ["teacher", "student"]) {
      assert.equal((await server.get(`${base}/class-sessions`, auth(role))).status, 403, role);
      assert.equal((await server.post(`${base}/class-sessions`, { batchId: "10", teacherUserId: "40", sessionTitle: "X1x", ...pastSlot(5) }, auth(role))).status, 403, role);
      assert.equal((await server.post(`${base}/tests/800/retake-authorizations`, { studentUserId: "301", additionalAttempts: 1, reason: "Because" }, auth(role))).status, 403, role);
    }
    assert.equal((await server.get(`${base}/tests`)).status, 401);
    for (const role of ["admin", "super_admin"]) assert.equal((await server.get(`${base}/class-sessions`, auth(role))).status, 200, role);
  });

  it("schedules: create, reject invalid relationships and duplicates, update", async () => {
    const ok = await server.post(`${base}/class-sessions`, { batchId: "10", teacherUserId: "40", sessionTitle: "Intro", ...pastSlot(5) }, auth("admin"));
    assert.equal(ok.status, 201);
    const created = (await json(ok))["data"];
    assert.equal(created.courseId, "5");

    const cases: Array<[Record<string, unknown>, number, string?]> = [
      [{ batchId: "10", teacherUserId: "40", sessionTitle: "Dup", ...pastSlot(5) }, 409, "BATCH_SCHEDULE_CONFLICT"],
      [{ batchId: "12", teacherUserId: "40", sessionTitle: "Other", ...pastSlot(5) }, 422, "TEACHER_NOT_ALLOCATED"],
      [{ batchId: "11", teacherUserId: "40", sessionTitle: "Closed", ...pastSlot(9) }, 422, "BATCH_CLOSED"],
      [{ batchId: "99", teacherUserId: "40", sessionTitle: "Nope", ...pastSlot(9) }, 404],
      [{ batchId: "10", teacherUserId: "40", sessionTitle: "Back", startsAt: pastSlot(9).endsAt, endsAt: pastSlot(9).startsAt }, 422],
      [{ batchId: "b-10", teacherUserId: "40", sessionTitle: "Bad id", ...pastSlot(9) }, 422],
      [{ batchId: "10", teacherUserId: "40", sessionTitle: "Status", sessionStatus: "LIVE", ...pastSlot(9) }, 422],
    ];
    for (const [body, status, code] of cases) {
      const res = await server.post(`${base}/class-sessions`, body, auth("admin"));
      assert.equal(res.status, status, JSON.stringify(body));
      if (code) assert.equal((await json(res))["error"], code);
    }
    assert.equal(harness.academics.sessions.length, 1, "nothing invalid was saved");

    // Teacher 41 overlapping another batch's session of the same teacher.
    harness.academics.allocations.push({ teacherUserId: "40", courseId: "6", batchId: "12", isActive: true });
    const tClash = await server.post(`${base}/class-sessions`, { batchId: "12", teacherUserId: "40", sessionTitle: "Clash", ...pastSlot(5) }, auth("admin"));
    assert.equal(tClash.status, 409);

    const patched = await server.patch(`${base}/class-sessions/${created.id}`, { sessionTitle: "Intro (rescheduled)" }, auth("super_admin"));
    assert.equal(patched.status, 200);
    assert.equal((await json(patched))["data"].sessionTitle, "Intro (rescheduled)");
    assert.equal((await server.patch(`${base}/class-sessions/${created.id}`, { batchId: "12" }, auth("admin"))).status, 422, "batch cannot move");
    assert.deepEqual(harness.academics.auditLogs.map((l) => l.actionType), ["CREATE_CLASS_SESSION", "UPDATE_CLASS_SESSION"]);
  });

  it("attendance: mark, correct with reason and history, never silently overwrite", async () => {
    const s = (await json(await server.post(`${base}/class-sessions`, { batchId: "10", teacherUserId: "40", sessionTitle: "Intro", ...pastSlot(5) }, auth("admin"))))["data"];
    const url = `${base}/class-sessions/${s.id}/attendance`;

    const roster = (await json(await server.get(url, auth("admin"))))["data"].roster;
    assert.deepEqual(roster.map((r: { studentUserId: string }) => r.studentUserId), ["301", "302"], "cancelled enrollment excluded");

    const first = await server.put(url, { records: [{ studentUserId: "301", status: "present" }, { studentUserId: "302", status: "absent" }] }, auth("admin"));
    assert.equal(first.status, 200);
    assert.deepEqual((await json(first))["data"], { created: 2, corrected: 0, unchanged: 0 });

    const noReason = await server.put(url, { records: [{ studentUserId: "302", status: "leave" }] }, auth("admin"));
    assert.equal(noReason.status, 422);
    assert.equal(harness.academics.records.find((r) => r.studentUserId === "302")!.status, "ABSENT", "not overwritten");

    const corrected = await server.put(url, { records: [{ studentUserId: "302", status: "leave" }], reason: "Approved leave letter" }, auth("super_admin"));
    assert.deepEqual((await json(corrected))["data"], { created: 0, corrected: 1, unchanged: 0 });
    const history = (await json(await server.get(`${url}/history`, auth("admin"))))["data"];
    assert.equal(history.length, 1);
    assert.deepEqual([history[0].oldStatus, history[0].newStatus, history[0].changeReason], ["absent", "leave", "Approved leave letter"]);

    for (const body of [
      { records: [{ studentUserId: "303", status: "present" }] }, // cancelled enrollment
      { records: [{ studentUserId: "301", status: "late" }] }, // not a BR-010 status
      { records: [{ studentUserId: "301", status: "present" }, { studentUserId: "301", status: "absent" }] }, // duplicate
      { records: [] },
    ]) {
      assert.equal((await server.put(url, body, auth("admin"))).status, 422, JSON.stringify(body));
    }

    const summary = (await json(await server.get(`${base}/attendance/summary?batchId=10`, auth("admin"))))["data"];
    assert.equal(summary.heldSessions, 1);
    assert.deepEqual(summary.students.find((x: { studentUserId: string }) => x.studentUserId === "302"), {
      studentUserId: "302", present: 0, absent: 0, leave: 1, other: 0, recordedSessions: 1,
      // D2 (approved): Leave counts as not attended.
      markedSessions: 1, attendancePercentage: 0, attendancePercentageDisplay: "0.0", belowMinimum: true,
    });
    assert.equal((await server.get(`${base}/class-sessions/9999/attendance`, auth("admin"))).status, 404);
  });

  it("attendance on a future session is refused", async () => {
    const future = { startsAt: FUTURE.toISOString(), endsAt: new Date(FUTURE.getTime() + 3600_000).toISOString() };
    const s = (await json(await server.post(`${base}/class-sessions`, { batchId: "10", teacherUserId: "40", sessionTitle: "Later", ...future }, auth("admin"))))["data"];
    const res = await server.put(`${base}/class-sessions/${s.id}/attendance`, { records: [{ studentUserId: "301", status: "present" }] }, auth("admin"));
    assert.equal(res.status, 422);
  });

  it("assessments: list, evaluate in versions, authorize retakes; audit failure rolls back", async () => {
    assert.equal((await json(await server.get(`${base}/assignments?courseId=5`, auth("admin"))))["data"].length, 1);
    assert.equal((await json(await server.get(`${base}/assignments/500/submissions`, auth("admin"))))["data"].length, 1);
    assert.equal((await server.get(`${base}/assignments/9999/submissions`, auth("admin"))).status, 404);

    const ev1 = await server.post(`${base}/assignment-submissions/550/evaluations`, { marksAwarded: 40, feedback: "Good" }, auth("admin"));
    assert.equal(ev1.status, 201);
    const ev2 = await json(await server.post(`${base}/assignment-submissions/550/evaluations`, { marksAwarded: 45 }, auth("super_admin")));
    assert.equal(ev2["data"].latestEvaluation.evaluationVersion, 2);
    assert.equal(harness.academics.evaluations.length, 2, "earlier evaluation kept");
    assert.equal((await server.post(`${base}/assignment-submissions/550/evaluations`, { marksAwarded: 51 }, auth("admin"))).status, 422);

    assert.equal((await json(await server.get(`${base}/tests`, auth("admin"))))["data"][0].attemptCount, 0);
    const retake = await server.post(`${base}/tests/800/retake-authorizations`, { studentUserId: "301", additionalAttempts: 1, reason: "Medical leave" }, auth("admin"));
    assert.equal(retake.status, 201);
    assert.equal((await json(await server.get(`${base}/tests/800/retake-authorizations`, auth("admin"))))["data"].length, 1);
    for (const [body, status] of [
      [{ studentUserId: "303", additionalAttempts: 1, reason: "Cancelled one" }, 422],
      [{ studentUserId: "301", additionalAttempts: 0, reason: "Zero attempts" }, 422],
      [{ studentUserId: "301", additionalAttempts: 1, reason: "" }, 422],
    ] as const) {
      assert.equal((await server.post(`${base}/tests/800/retake-authorizations`, body, auth("admin"))).status, status, JSON.stringify(body));
    }
    assert.equal((await server.post(`${base}/tests/9999/retake-authorizations`, { studentUserId: "301", additionalAttempts: 1, reason: "Missing test" }, auth("admin"))).status, 404);

    harness.academics.failAudit = true;
    const failed = await server.post(`${base}/tests/800/retake-authorizations`, { studentUserId: "302", additionalAttempts: 1, reason: "Network outage" }, auth("admin"));
    assert.equal(failed.status, 500);
    assert.equal(harness.academics.retakes.length, 1, "rolled back with the audit");
  });

  it("teacher endpoints are unchanged by this module (teacher cannot use admin academics)", async () => {
    assert.equal((await server.put(`${base}/class-sessions/1/attendance`, { records: [{ studentUserId: "301", status: "present" }] }, auth("teacher"))).status, 403);
    assert.equal((await server.post(`${base}/assignment-submissions/550/evaluations`, { marksAwarded: 1 }, auth("teacher"))).status, 403);
  });
});
