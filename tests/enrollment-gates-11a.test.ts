import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type sql from "mssql";

import { createApp } from "../src/app";
import { createAuthenticate } from "../src/middleware/authenticate.middleware";
import { issueAccessToken } from "../src/modules/auth/token.service";
import { SqlServerAdminRepository } from "../src/modules/admin/sqlserver-admin.repository";
import { BatchFullError } from "../src/modules/enrollments/enrollment.repository";
import { SqlServerEnrollmentRepository } from "../src/modules/enrollments/sqlserver-enrollment.repository";
import { createStudentAccessResolver } from "../src/modules/students/student-access";
import { createTestHarness, type TestHarness } from "./fakes";
import { startServer, type TestServer } from "./helpers/server";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Item 11A-2: approved decisions D4 (prerequisites) and D6 (batch capacity).
 * Self-enrollment: 422 PREREQUISITES_NOT_MET / 409 BATCH_FULL. Admin
 * enrollment: the same rules, overridable only with a reason that is written
 * into the enrollment's audit row in the same transaction. Mock pools and
 * in-memory fakes only.
 */

// ------------------------------------------------------------------ mock pool
interface Executed {
  q: string;
  inputs: Record<string, unknown>;
  where: "tx" | "pool";
}
const makePool = (handler: (q: string) => unknown, opts: { failAudit?: boolean } = {}) => {
  const state = { log: [] as Executed[], commits: 0, rollbacks: 0 };
  class Req {
    inputs: Record<string, unknown> = {};
    constructor(private readonly where: "tx" | "pool") {}
    input(n: string, t: unknown, v?: unknown) {
      this.inputs[n] = v !== undefined ? v : t;
      return this;
    }
    async query(q: string) {
      state.log.push({ q, inputs: { ...this.inputs }, where: this.where });
      if (q.includes("INSERT INTO dbo.NXA_AuditLogs")) {
        if (opts.failAudit) throw new Error("audit write failed");
        return { recordset: [{ AuditLogId: 1 }], rowsAffected: [1] };
      }
      const r = (handler(q) ?? {}) as { recordset?: unknown[]; rowsAffected?: number[] };
      return { recordset: r.recordset ?? [], rowsAffected: r.rowsAffected ?? [1] };
    }
  }
  const pool = {
    request: () => new Req("pool"),
    transaction: () => ({ begin: async () => {}, commit: async () => void state.commits++, rollback: async () => void state.rollbacks++, request: () => new Req("tx") }),
  } as unknown as sql.ConnectionPool;
  return { pool, state };
};
const idx = (log: Executed[], re: RegExp) => log.findIndex((e) => re.test(e.q));

describe("self-enrollment capacity under a lock (SQL mock pool)", () => {
  const handler = (capacity: number | null, enrolled: number) => (q: string) => {
    if (q.includes("FROM dbo.NXA_Enrollments e") || q.includes("WHERE StudentUserId = @studentId AND CourseId")) return { recordset: [] };
    if (q.includes("SELECT Capacity FROM dbo.NXA_Batches WITH (UPDLOCK, HOLDLOCK)")) return { recordset: [{ Capacity: capacity }] };
    if (q.includes("COUNT(1) AS cnt FROM dbo.NXA_Enrollments WITH (UPDLOCK, HOLDLOCK)")) return { recordset: [{ cnt: enrolled }] };
    if (q.includes("SELECT ListPrice")) return { recordset: [{ ListPrice: 20000 }] };
    if (q.includes("INSERT INTO dbo.NXA_Enrollments")) return { recordset: [{ EnrollmentId: 501 }] };
    return { recordset: [] };
  };
  const input = { studentId: "401", courseId: "5", batchId: "10", enrollmentType: "self" as const, status: "pending_approval" as const, enforceBatchCapacity: true };

  it("refuses the enrollment when the batch is at capacity, and inserts nothing", async () => {
    const { pool, state } = makePool(handler(2, 2));
    await assert.rejects(new SqlServerEnrollmentRepository(pool).create(input), (e: Error) => e instanceof BatchFullError);
    assert.equal(idx(state.log, /INSERT INTO dbo\.NXA_Enrollments/), -1);
    assert.equal(state.rollbacks, 1);
    assert.equal(state.commits, 0);
  });

  it("locks the batch, counts non-cancelled enrollments and inserts, all on one transaction", async () => {
    const { pool, state } = makePool(handler(2, 1));
    await new SqlServerEnrollmentRepository(pool).create(input).catch(() => undefined); // the reload is not mocked
    const lock = idx(state.log, /SELECT Capacity FROM dbo\.NXA_Batches WITH \(UPDLOCK, HOLDLOCK\)/);
    const count = idx(state.log, /COUNT\(1\) AS cnt FROM dbo\.NXA_Enrollments WITH \(UPDLOCK, HOLDLOCK\)/);
    const insert = idx(state.log, /INSERT INTO dbo\.NXA_Enrollments/);
    assert.ok(lock >= 0 && lock < count && count < insert, "lock, then count, then insert");
    for (const i of [lock, count, insert]) assert.equal(state.log[i]!.where, "tx");
    assert.match(state.log[count]!.q, /UPPER\(EnrollmentStatus\) <> 'CANCELLED'/, "counted as the batch's CurrentEnrollments");
    assert.equal(state.commits, 1);
  });

  it("treats a NULL capacity as no limit (no count, no invented fallback)", async () => {
    const { pool, state } = makePool(handler(null, 999));
    await new SqlServerEnrollmentRepository(pool).create(input).catch(() => undefined);
    assert.equal(idx(state.log, /COUNT\(1\) AS cnt FROM dbo\.NXA_Enrollments WITH/), -1);
    assert.ok(idx(state.log, /INSERT INTO dbo\.NXA_Enrollments/) >= 0);
  });
});

describe("Admin enrollment overrides in the same transaction (SQL mock pool)", () => {
  const handler = (o: { capacity?: number | null; enrolled?: number; missingPrereq?: boolean } = {}) => (q: string) => {
    if (q.includes("SELECT sp.ApprovalStatus")) return { recordset: [{ ApprovalStatus: "APPROVED", AccountStatus: "active" }] };
    if (q.includes("SELECT ListPrice, CurrencyCode")) return { recordset: [{ ListPrice: 20000, CurrencyCode: "INR" }] };
    if (q.includes("SELECT CourseId, Status FROM dbo.NXA_Batches")) return { recordset: [{ CourseId: 5, Status: "ongoing" }] };
    if (q.includes("SELECT Capacity FROM dbo.NXA_Batches WITH (UPDLOCK, HOLDLOCK)")) return { recordset: [{ Capacity: o.capacity === undefined ? 2 : o.capacity }] };
    if (q.includes("COUNT(1) AS cnt FROM dbo.NXA_Enrollments WITH (UPDLOCK, HOLDLOCK)")) return { recordset: [{ cnt: o.enrolled ?? 2 }] };
    if (q.includes("FROM dbo.NXA_CoursePrerequisites p")) return { recordset: o.missingPrereq ? [{ PrerequisiteCourseId: 4, CourseCode: "JAVA-CORE", CourseName: "Core Java" }] : [] };
    if (q.includes("SELECT TOP 1 1 AS x FROM dbo.NXA_Enrollments")) return { recordset: [] };
    if (q.includes("INSERT INTO dbo.NXA_Enrollments")) return { recordset: [{ EnrollmentId: 77 }] };
    return { recordset: [] };
  };
  const base = { studentUserId: "401", courseId: "5", batchId: "10", status: "approved_unpaid" as const, createdByUserId: "201", audit: { actorUserId: "201", actionType: "MANUAL_ENROLLMENT" } };
  const auditOf = (log: Executed[]) => {
    const a = log.find((e) => e.q.includes("INSERT INTO dbo.NXA_AuditLogs"));
    return a ? JSON.parse(String(a.inputs["newVal"])) : null;
  };

  it("refuses a full batch without a reason (409 BATCH_FULL) and writes nothing", async () => {
    const { pool, state } = makePool(handler());
    await assert.rejects(new SqlServerAdminRepository(pool).createEnrollment(base), (e: any) => e.code === "BATCH_FULL" && e.status === 409);
    assert.equal(idx(state.log, /INSERT INTO dbo\.NXA_Enrollments/), -1);
    assert.equal(auditOf(state.log), null);
    assert.equal(state.rollbacks, 1);
  });

  it("records the exact capacity override reason in the enrollment's audit row", async () => {
    const { pool, state } = makePool(handler());
    await new SqlServerAdminRepository(pool).createEnrollment({ ...base, capacityOverrideReason: "Sponsor seat agreed with the trainer" }).catch(() => undefined);
    assert.deepEqual(auditOf(state.log).capacityOverride, { reason: "Sponsor seat agreed with the trainer", capacity: 2, enrolled: 2 });
    const insert = idx(state.log, /INSERT INTO dbo\.NXA_Enrollments/);
    const audit = idx(state.log, /INSERT INTO dbo\.NXA_AuditLogs/);
    assert.ok(insert >= 0 && insert < audit && state.log[audit]!.where === "tx", "same transaction, after the insert");
    assert.equal(state.commits, 1);
  });

  it("refuses missing prerequisites without a reason, and records the override with one", async () => {
    const refused = makePool(handler({ capacity: null, missingPrereq: true }));
    await assert.rejects(new SqlServerAdminRepository(refused.pool).createEnrollment(base), (e: any) => e.code === "PREREQUISITES_NOT_MET" && /Core Java \(JAVA-CORE\)/.test(e.message));
    assert.equal(idx(refused.state.log, /INSERT INTO dbo\.NXA_Enrollments/), -1);

    const ok = makePool(handler({ capacity: null, missingPrereq: true }));
    await new SqlServerAdminRepository(ok.pool).createEnrollment({ ...base, prerequisiteOverrideReason: "Equivalent course completed elsewhere" }).catch(() => undefined);
    assert.deepEqual(auditOf(ok.state.log).prerequisiteOverride, { reason: "Equivalent course completed elsewhere", missingCourseIds: ["4"] });
    assert.equal(auditOf(ok.state.log).capacityOverride, undefined, "no capacity override when the batch has no limit");
  });

  it("checks prerequisites against COMPLETED enrollments only", async () => {
    const { pool, state } = makePool(handler({ capacity: null }));
    await new SqlServerAdminRepository(pool).createEnrollment(base).catch(() => undefined);
    const q = state.log.find((e) => e.q.includes("FROM dbo.NXA_CoursePrerequisites p"))!;
    assert.match(q.q, /UPPER\(pe\.EnrollmentStatus\) = 'COMPLETED'/);
    assert.equal(q.where, "tx");
  });

  it("rolls the enrollment back when the audit write fails", async () => {
    const { pool, state } = makePool(handler(), { failAudit: true });
    await assert.rejects(new SqlServerAdminRepository(pool).createEnrollment({ ...base, capacityOverrideReason: "Sponsor seat agreed with the trainer" }), /audit write failed/);
    assert.equal(state.commits, 0);
    assert.equal(state.rollbacks, 1);
  });
});

// ------------------------------------------------------------------ HTTP
describe("enrollment gates through the API (in-memory fakes)", () => {
  let h: TestHarness;
  let server: TestServer;
  let prereqCourse: string;
  let course: string;
  const json = async (res: Response) => (await res.json()) as Record<string, any>;

  const tokenFor = async (userId: string, role: "student" | "admin" | "teacher" | "super_admin") => {
    const session = await h.sessions.create({ userId, refreshTokenHash: Buffer.alloc(64, 1).toString("hex"), expiresAt: new Date(Date.now() + 3600000).toISOString() });
    return issueAccessToken({ userId, role, sessionId: session.sessionId }).token;
  };
  let n = 0;
  const approvedStudent = async () => {
    n += 1;
    const user = await h.users.create({ name: `Student ${n}`, email: `s${n}@test.local`, mobile: `91000001${String(n).padStart(2, "0")}`, role: "student", status: "pending" });
    await h.students.createForUser(user.id, { collegeName: "JNTU", degreeBranch: "CSE", passingYear: "2025", courseInterestedIn: "FS", dateOfBirth: "2003-04-12", gender: "male", fullAddress: "Hyderabad" });
    await h.students.markVerified(user.id, "email");
    await h.students.recordApprovalDecision(user.id, { status: "approved", decidedByUserId: "admin-1", decidedAt: new Date().toISOString() });
    return { id: user.id, token: await tokenFor(user.id, "student") };
  };
  const call = (method: string, path: string, token: string | null, body?: unknown) =>
    fetch(`${server.url}/api/v1${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  before(async () => {
    h = createTestHarness();
    const mk = (slug: string) => h.courses.create({ slug, title: slug === "core-java" ? "Core Java" : slug, shortDescription: "x", longDescription: "x", durationWeeks: 4, feeINR: 20000, level: "Beginner", prerequisites: [], learningOutcomes: [] } as any);
    prereqCourse = (await mk("core-java")).id;
    course = (await mk("java-fs")).id;
    await h.courses.replacePrerequisites(course, [prereqCourse]);
    server = await startServer(createApp({ container: h.container, authenticate: createAuthenticate({ sessions: () => h.sessions, studentAccess: createStudentAccessResolver(() => h.students) }) }));
  });

  after(async () => {
    await server.close();
  });

  it("refuses self-enrollment until every prerequisite course is completed (D4)", async () => {
    const s = await approvedStudent();
    const res = await call("POST", "/enrollments", s.token, { courseId: course });
    assert.equal(res.status, 422);
    const body = await json(res);
    assert.equal(body["error"], "PREREQUISITES_NOT_MET");
    assert.match(body["message"], /Core Java/);
    assert.equal(body["details"].length, 1);

    // An active (not completed) prerequisite enrollment is not enough.
    const pre = await h.enrollments.create({ studentId: s.id, courseId: prereqCourse, enrollmentType: "self", status: "active" });
    assert.equal((await call("POST", "/enrollments", s.token, { courseId: course })).status, 422);
    await h.enrollments.setStatus(pre.id, "completed", { changedByUserId: "admin-1" });
    assert.equal((await call("POST", "/enrollments", s.token, { courseId: course })).status, 201);
  });

  it("refuses self-enrollment into a full batch with 409 BATCH_FULL, and allows it below capacity (D6)", async () => {
    const batch = await h.admin.createBatch({ courseId: prereqCourse, batchCode: "CJ-01", batchName: "Core Java 01", capacity: 2 });
    const a = await approvedStudent();
    const b = await approvedStudent();
    const c = await approvedStudent();
    assert.equal((await call("POST", "/enrollments", a.token, { courseId: prereqCourse, batchId: batch.id })).status, 201);
    // The last place: two students race for it; exactly one gets it.
    const [r1, r2] = await Promise.all([
      call("POST", "/enrollments", b.token, { courseId: prereqCourse, batchId: batch.id }),
      call("POST", "/enrollments", c.token, { courseId: prereqCourse, batchId: batch.id }),
    ]);
    assert.deepEqual([r1.status, r2.status].sort(), [201, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    assert.equal((await json(loser))["error"], "BATCH_FULL");
    assert.equal((await h.enrollments.findMany({}, { page: 1, pageSize: 50 } as any)).items.filter((e: any) => e.batchId === batch.id).length, 2, "capacity never exceeded");

    // A cancelled enrollment frees its place (the batch's existing counting rule).
    const taken = (await h.enrollments.findByStudent(a.id))[0]!;
    await h.enrollments.setStatus(taken.id, "cancelled", { changedByUserId: "admin-1" });
    const loserId = r1.status === 409 ? b : c;
    assert.equal((await call("POST", "/enrollments", loserId.token, { courseId: prereqCourse, batchId: batch.id })).status, 201);
  });

  it("does not limit a batch whose capacity is NULL", async () => {
    const batch = await h.admin.createBatch({ courseId: prereqCourse, batchCode: "CJ-OPEN", batchName: "Open batch" });
    (h.admin.batches.find((x) => x.id === batch.id) as any).capacity = null;
    for (let i = 0; i < 3; i++) {
      const s = await approvedStudent();
      assert.equal((await call("POST", "/enrollments", s.token, { courseId: prereqCourse, batchId: batch.id })).status, 201);
    }
  });

  describe("Admin enrollment", () => {
    let admin: string;
    let teacher: string;
    before(async () => {
      admin = await tokenFor("201", "admin");
      teacher = await tokenFor("301", "teacher");
      h.admin.coursePrices.set(course, 20000);
      h.admin.coursePrices.set(prereqCourse, 20000);
    });
    const enrollable = (id: string) => h.admin.studentApprovals.set(id, "approved");

    it("requires a reason to enroll into a full batch, and audits it with the enrollment", async () => {
      const batch = await h.admin.createBatch({ courseId: prereqCourse, batchCode: "CJ-ADM", batchName: "Admin batch", capacity: 1 });
      for (const id of ["901", "902"]) enrollable(id);
      assert.equal((await call("POST", "/admin/enrollments", admin, { studentUserId: "901", courseId: prereqCourse, batchId: batch.id })).status, 201);

      const full = await call("POST", "/admin/enrollments", admin, { studentUserId: "902", courseId: prereqCourse, batchId: batch.id });
      assert.equal(full.status, 409);
      assert.equal((await json(full))["error"], "BATCH_FULL");
      assert.equal((await call("POST", "/admin/enrollments", admin, { studentUserId: "902", courseId: prereqCourse, batchId: batch.id, capacityOverrideReason: "short" })).status, 422, "a reason needs at least 10 characters");

      const before = h.admin.enrollments.length;
      h.admin.failEnrollmentAudit = true;
      assert.equal((await call("POST", "/admin/enrollments", admin, { studentUserId: "902", courseId: prereqCourse, batchId: batch.id, capacityOverrideReason: "Sponsor seat agreed" })).status, 500);
      assert.equal(h.admin.enrollments.length, before, "no enrollment without its audit");
      h.admin.failEnrollmentAudit = false;

      const ok = await call("POST", "/admin/enrollments", admin, { studentUserId: "902", courseId: prereqCourse, batchId: batch.id, capacityOverrideReason: "Sponsor seat agreed" });
      assert.equal(ok.status, 201);
      const audit = h.admin.auditLogs.filter((l) => l.actionType === "MANUAL_ENROLLMENT").at(-1)!;
      assert.equal(audit.actorUserId, "201");
      assert.deepEqual(JSON.parse(String(audit.newValues)).capacityOverride, { reason: "Sponsor seat agreed", capacity: 1, enrolled: 1 });
    });

    it("requires a reason when a prerequisite is not completed, and audits it", async () => {
      enrollable("903");
      const res = await call("POST", "/admin/enrollments", admin, { studentUserId: "903", courseId: course });
      assert.equal(res.status, 422);
      assert.equal((await json(res))["error"], "PREREQUISITES_NOT_MET");
      const ok = await call("POST", "/admin/enrollments", admin, { studentUserId: "903", courseId: course, prerequisiteOverrideReason: "Equivalent course completed elsewhere" });
      assert.equal(ok.status, 201);
      const values = JSON.parse(String(h.admin.auditLogs.filter((l) => l.actionType === "MANUAL_ENROLLMENT").at(-1)!.newValues));
      assert.deepEqual(values.prerequisiteOverride, { reason: "Equivalent course completed elsewhere", missingCourseIds: [prereqCourse] });
    });

    it("lets only staff enroll on a student's behalf", async () => {
      enrollable("904");
      const before = h.admin.enrollments.length;
      assert.equal((await call("POST", "/admin/enrollments", teacher, { studentUserId: "904", courseId: prereqCourse })).status, 403);
      assert.equal((await call("POST", "/admin/enrollments", null, { studentUserId: "904", courseId: prereqCourse })).status, 401);
      assert.equal(h.admin.enrollments.length, before);
    });
  });
});
