import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createApp } from "../src/app";
import { createAuthenticate } from "../src/middleware/authenticate.middleware";
import { issueAccessToken } from "../src/modules/auth/token.service";
import { createStudentAccessResolver, decideStudentAccess } from "../src/modules/students/student-access";
import { createTestHarness, type TestHarness } from "./fakes";
import { seedEnrollment, seedLessons } from "./helpers/learning-access";
import { startServer, type TestServer } from "./helpers/server";

/**
 * CL-001 decisions 1 and 2, exercised through direct API requests with the
 * REAL per-request access resolver (not the null resolver older suites use).
 */

const PROFILE = {
  collegeName: "JNTU Hyderabad",
  degreeBranch: "B.Tech CSE",
  passingYear: "2025",
  courseInterestedIn: "Full Stack Development",
  dateOfBirth: "2003-04-12",
  gender: "male" as const,
  fullAddress: "12-3-45 Ameerpet, Hyderabad, Telangana 500016",
};

describe("decideStudentAccess", () => {
  const facts = (status: "pending" | "active" | "suspended" | "deactivated", approval: "pending" | "approved" | "rejected", email = true) => ({
    status,
    student: { adminApprovalStatus: approval, isEmailVerified: email },
  });

  it("limited while approval is pending, approved after approval - with or without activation", () => {
    assert.deepEqual(decideStudentAccess(facts("pending", "pending")), { allowed: true, tier: "limited" });
    assert.deepEqual(decideStudentAccess(facts("pending", "approved")), { allowed: true, tier: "approved" });
    assert.deepEqual(decideStudentAccess(facts("active", "approved")), { allowed: true, tier: "approved" });
  });

  it("blocks suspended and deactivated accounts regardless of approval", () => {
    assert.deepEqual(decideStudentAccess(facts("suspended", "approved")), { allowed: false, reason: "suspended" });
    assert.deepEqual(decideStudentAccess(facts("deactivated", "approved")), { allowed: false, reason: "deactivated" });
  });

  it("blocks unverified, rejected and profile-less accounts", () => {
    assert.deepEqual(decideStudentAccess(facts("pending", "pending", false)), { allowed: false, reason: "email_unverified" });
    assert.deepEqual(decideStudentAccess(facts("pending", "approved", false)), { allowed: false, reason: "email_unverified" });
    assert.deepEqual(decideStudentAccess(facts("pending", "rejected")), { allowed: false, reason: "rejected" });
    assert.deepEqual(decideStudentAccess({ status: "active", student: null }), { allowed: false, reason: "no_profile" });
  });
});

describe("student access through the API (CL-001)", () => {
  let h: TestHarness;
  let server: TestServer;
  let courseId: string;
  let otherCourseId: string;
  let adminId: string;
  const ids: Record<string, string> = {};

  const tokenFor = async (userId: string, role: "student" | "admin" | "teacher") => {
    const session = await h.sessions.create({
      userId,
      refreshTokenHash: Buffer.alloc(64, 1).toString("hex"),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    return issueAccessToken({ userId, role, sessionId: session.sessionId }).token;
  };

  const seedStudent = async (
    key: string,
    mobile: string,
    opts: { verified?: boolean; approval?: "pending" | "approved" | "rejected"; status?: "pending" | "suspended" | "deactivated" } = {},
  ) => {
    const user = await h.users.create({
      name: `Student ${key}`,
      email: `${key}@test.local`,
      mobile,
      role: "student",
      status: opts.status ?? "pending",
    });
    await h.students.createForUser(user.id, PROFILE);
    if (opts.verified !== false) await h.students.markVerified(user.id, "email");
    if (opts.approval && opts.approval !== "pending") {
      await h.students.recordApprovalDecision(user.id, {
        status: opts.approval,
        decidedByUserId: "admin-1",
        decidedAt: new Date().toISOString(),
      });
    }
    ids[key] = user.id;
    return user.id;
  };

  const call = async (method: string, path: string, token: string, body?: unknown) =>
    fetch(`${server.url}/api/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const errorCode = async (res: Response): Promise<string> => String(((await res.json()) as Record<string, unknown>)["error"]);

  before(async () => {
    h = createTestHarness();
    const mkCourse = (slug: string) =>
      h.courses.create({
        slug,
        title: slug,
        shortDescription: "x",
        longDescription: "x",
        durationWeeks: 4,
        feeINR: 20000,
        level: "Beginner",
        prerequisites: [],
        learningOutcomes: [],
      });
    courseId = (await mkCourse("access-course")).id;
    otherCourseId = (await mkCourse("other-course")).id;
    await seedLessons(h, courseId, ["les-a1"]);
    await seedLessons(h, otherCourseId, ["les-b1"]);

    adminId = (await h.users.create({ name: "Admin", email: "adm@test.local", mobile: "9100000000", role: "admin", status: "active" })).id;

    await seedStudent("limited", "9100000001");
    await seedStudent("approved", "9100000002", { approval: "approved" });
    await seedStudent("suspended", "9100000003", { approval: "approved", status: "suspended" });
    await seedStudent("rejected", "9100000004", { approval: "rejected" });
    await seedStudent("unverified", "9100000005", { verified: false });
    await seedStudent("other", "9100000006", { approval: "approved" });

    const app = createApp({
      container: h.container,
      authenticate: createAuthenticate({
        sessions: () => h.sessions,
        studentAccess: createStudentAccessResolver(() => h.students),
      }),
    });
    server = await startServer(app);
  });

  after(async () => {
    await server.close();
  });

  describe("limited access (verified, approval pending)", () => {
    it("allows the CL-001 allowlist", async () => {
      const t = await tokenFor(ids["limited"]!, "student");
      for (const [method, path] of [
        ["GET", "/students/me"],
        ["GET", "/enrollments/me"],
        ["GET", "/payments/me"],
        ["GET", "/support/notifications/my"],
        ["POST", "/support/notifications/read-all"],
        ["GET", "/support/tickets/my"],
      ] as const) {
        const res = await call(method, path, t);
        assert.equal(res.status, 200, `${method} ${path}`);
      }

      const me = (await (await call("GET", "/students/me", t)).json()) as { data: Record<string, unknown> };
      assert.equal(me.data["adminApprovalStatus"], "pending", "approval status is visible");

      h.support.categories.push({ id: "7", name: "Technical", isActive: true });
      const ticket = await call("POST", "/support/tickets", t, {
        categoryId: "7",
        subject: "Approval question",
        description: "When will my registration be reviewed?",
      });
      assert.equal(ticket.status, 201);
      const ticketId = ((await ticket.json()) as { data: { id: string } }).data.id;
      assert.equal((await call("GET", `/support/tickets/${ticketId}`, t)).status, 200);

      // Another student's ticket stays private.
      const other = await tokenFor(ids["other"]!, "student");
      assert.equal((await call("GET", `/support/tickets/${ticketId}`, other)).status, 403);
    });

    it("refuses payment, enrollment, profile edits, learning content, placements and certificates", async () => {
      const t = await tokenFor(ids["limited"]!, "student");
      for (const [method, path, body] of [
        ["POST", "/payments/orders", { courseId, enrollmentId: "1" }],
        ["POST", "/payments/verify", { orderId: "1", gatewayPaymentId: "p", gatewaySignature: "s", paymentMethod: "upi" }],
        ["GET", "/payments/receipts/1", undefined],
        ["GET", "/payments/discounts/validate?code=X&grossAmountINR=1000", undefined],
        ["POST", "/enrollments", { courseId }],
        ["PUT", "/students/me", { name: "Changed Name" }],
        ["GET", "/teachers/materials?lessonId=les-a1", undefined],
        ["GET", "/teachers/assignments", undefined],
        ["GET", "/teachers/tests", undefined],
        ["GET", "/teachers/doubts", undefined],
        ["POST", "/teachers/doubts", { lessonId: "les-a1", doubtText: "A question about this lesson" }],
        ["GET", "/teachers/attendance/my", undefined],
        ["POST", "/placements/jobs/1/apply", {}],
        ["GET", "/placements/applications/my", undefined],
        ["GET", "/placements/mock-interviews/my", undefined],
        ["GET", "/placements/questions", undefined],
        ["GET", "/certificates/my", undefined],
        ["GET", `/certificates/eligibility/${courseId}`, undefined],
      ] as const) {
        const res = await call(method, path, t, body);
        assert.equal(res.status, 403, `${method} ${path} must be refused`);
        assert.equal(await errorCode(res), "STUDENT_APPROVAL_PENDING", `${method} ${path}`);
      }
    });

    it("upgrades to full access as soon as the Admin approves - same token", async () => {
      const id = await seedStudent("upgrade", "9100000007");
      const t = await tokenFor(id, "student");
      assert.equal((await call("POST", "/enrollments", t, { courseId })).status, 403);

      await h.students.recordApprovalDecision(id, { status: "approved", decidedByUserId: adminId, decidedAt: new Date().toISOString() });

      const res = await call("POST", "/enrollments", t, { courseId });
      assert.equal(res.status, 201);
      assert.equal(((await res.json()) as { data: { status: string } }).data.status, "approved_unpaid");
    });
  });

  describe("blocked accounts", () => {
    it("refuses suspended (even if approved), rejected and unverified students on every endpoint", async () => {
      for (const key of ["suspended", "rejected", "unverified"]) {
        const t = await tokenFor(ids[key]!, "student");
        for (const path of ["/students/me", "/enrollments/me", "/support/notifications/my"]) {
          const res = await call("GET", path, t);
          assert.equal(res.status, 403, `${key} ${path}`);
          assert.equal(await errorCode(res), "ACCOUNT_NOT_PERMITTED");
        }
      }
    });

    it("blocks a student the moment they are suspended", async () => {
      const id = await seedStudent("tobesuspended", "9100000008", { approval: "approved" });
      const t = await tokenFor(id, "student");
      assert.equal((await call("GET", "/students/me", t)).status, 200);
      await h.users.setStatus(id, "suspended");
      assert.equal((await call("GET", "/students/me", t)).status, 403);
    });
  });

  describe("approved access", () => {
    it("selects a course and pays only for their own enrollment awaiting payment", async () => {
      const t = await tokenFor(ids["approved"]!, "student");
      const enr = await call("POST", "/enrollments", t, { courseId });
      assert.equal(enr.status, 201);
      const enrollmentId = ((await enr.json()) as { data: { id: string } }).data.id;

      // Passes every access and ownership check, then reports the gateway as
      // unavailable (no Razorpay integration yet) rather than simulating it.
      const order = await call("POST", "/payments/orders", t, { courseId, enrollmentId });
      assert.equal(order.status, 503);
      assert.equal(await errorCode(order), "PAYMENT_GATEWAY_UNAVAILABLE");

      const otherT = await tokenFor(ids["other"]!, "student");
      assert.equal((await call("POST", "/payments/orders", otherT, { courseId, enrollmentId })).status, 404, "not their enrollment");

      // Not yet paid: learning content stays locked (CRS-010).
      const locked = await call("GET", "/teachers/materials?lessonId=les-a1", t);
      assert.equal(locked.status, 403);
      assert.equal(await errorCode(locked), "CONTENT_LOCKED");
    });

    it("reaches learning content only for lessons of an ACTIVE enrollment", async () => {
      const id = await seedStudent("learner", "9100000009", { approval: "approved" });
      const t = await tokenFor(id, "student");
      await seedEnrollment(h, id, courseId);

      assert.equal((await call("GET", "/teachers/materials?lessonId=les-a1", t)).status, 200);
      const otherCourse = await call("GET", "/teachers/materials?lessonId=les-b1", t);
      assert.equal(otherCourse.status, 403, "a lesson of a course they are not enrolled in");
      assert.equal((await call("POST", "/teachers/doubts", t, { lessonId: "les-b1", doubtText: "Question on another course" })).status, 403);
      assert.equal((await call("POST", "/teachers/doubts", t, { lessonId: "les-a1", doubtText: "Question on my own course" })).status, 201);

      // Doubts list shows only their own.
      const doubts = (await (await call("GET", `/teachers/doubts?courseId=${courseId}`, t)).json()) as { data: { studentUserId: string }[] };
      assert.ok(doubts.data.every((d) => d.studentUserId === id));
    });

    it("applies BR-013: the placement portal needs an ACTIVE enrollment", async () => {
      const id = await seedStudent("placement", "9100000010", { approval: "approved" });
      const t = await tokenFor(id, "student");
      await seedEnrollment(h, id, courseId, { status: "approved_unpaid" });

      for (const [method, path] of [
        ["POST", "/placements/jobs/1/apply"],
        ["GET", "/placements/applications/my"],
        ["GET", "/placements/mock-interviews/my"],
        ["GET", "/placements/questions"],
      ] as const) {
        const res = await call(method, path, t, method === "POST" ? {} : undefined);
        assert.equal(res.status, 403, `${method} ${path}`);
        assert.equal(await errorCode(res), "PLACEMENT_NOT_ELIGIBLE");
      }

      await seedEnrollment(h, id, otherCourseId, { status: "active" });
      assert.equal((await call("GET", "/placements/applications/my", t)).status, 200);
      assert.equal((await call("GET", "/placements/questions", t)).status, 200);

      // A student may book a mock interview only for themselves.
      const forOther = await call("POST", "/placements/mock-interviews/schedule", t, {
        studentUserId: ids["other"],
        teacherUserId: "t-1",
        scheduledAt: new Date(Date.now() + 86400000).toISOString(),
      });
      assert.equal(forOther.status, 403);
    });

    it("reads only their own receipts", async () => {
      const t = await tokenFor(ids["approved"]!, "student");
      assert.equal((await call("GET", "/payments/receipts/not-mine", t)).status, 404);
    });
  });

  describe("self-enrollment batch rules (finding 3)", () => {
    it("requires the batch to exist, belong to the course and be open", async () => {
      const id = await seedStudent("batchpicker", "9100000011", { approval: "approved" });
      const t = await tokenFor(id, "student");
      const mkBatch = (cId: string, code: string) =>
        h.admin.createBatch({ courseId: cId, batchCode: code, batchName: code, startDate: "2026-12-01", endDate: "2027-03-01" });

      const otherCourseBatch = await mkBatch(otherCourseId, "OTHER-01");
      const wrong = await call("POST", "/enrollments", t, { courseId, batchId: otherCourseBatch.id });
      assert.equal(wrong.status, 422);
      assert.equal(await errorCode(wrong), "BATCH_COURSE_MISMATCH");

      const closed = await mkBatch(courseId, "CLOSED-01");
      await h.admin.setBatchStatus(closed.id, "completed");
      const closedRes = await call("POST", "/enrollments", t, { courseId, batchId: closed.id });
      assert.equal(closedRes.status, 422);
      assert.equal(await errorCode(closedRes), "BATCH_CLOSED");

      assert.equal((await call("POST", "/enrollments", t, { courseId, batchId: "no-such-batch" })).status, 404);
      assert.equal((await h.enrollments.findByStudent(id)).length, 0, "nothing was created");

      const open = await mkBatch(courseId, "OPEN-01");
      const ok = await call("POST", "/enrollments", t, { courseId, batchId: open.id });
      assert.equal(ok.status, 201);
    });
  });

  describe("placement records are not public (finding 2)", () => {
    it("refuses unauthenticated callers and students; Admin can read them", async () => {
      const anon = await fetch(`${server.url}/api/v1/placements/records`);
      assert.equal(anon.status, 401);

      const student = await tokenFor(ids["approved"]!, "student");
      assert.equal((await call("GET", "/placements/records", student)).status, 403);

      const admin = await tokenFor(adminId, "admin");
      assert.equal((await call("GET", "/placements/records", admin)).status, 200);
    });
  });
});
