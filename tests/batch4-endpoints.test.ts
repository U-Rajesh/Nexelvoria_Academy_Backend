import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app";
import { issueAccessToken } from "../src/modules/auth/token.service";
import { createAuthenticate } from "../src/middleware/authenticate.middleware";
import { validatePasswordPolicy, verifyPassword } from "../src/modules/auth/password.service";
import { createTestHarness, type TestHarness } from "./fakes";
import { json, startServer, type TestServer } from "./helpers/server";

describe("Batch 4: Admin & Super Admin Endpoints Integration", () => {
  let harness: TestHarness;
  let server: TestServer;
  let studentUserId: string;
  let teacherUserId: string;
  let adminUserId: string;
  let superAdminUserId: string;
  let courseId: string;
  let createdBatchId: string;
  let createdAdminId: string;

  before(async () => {
    harness = createTestHarness();

    // Create users for each role
    const studentUser = await harness.users.create({
      name: "Student A",
      email: "student.a@test.local",
      mobile: "9876543210",
      role: "student",
      status: "active",
    });
    studentUserId = studentUser.id;

    const teacherUser = await harness.users.create({
      name: "Teacher T",
      email: "teacher.t@test.local",
      mobile: "9876543211",
      role: "teacher",
      status: "active",
    });
    teacherUserId = teacherUser.id;

    const adminUser = await harness.users.create({
      name: "Admin X",
      email: "admin.x@test.local",
      mobile: "9876543212",
      role: "admin",
      status: "active",
    });
    adminUserId = adminUser.id;

    const superAdminUser = await harness.users.create({
      name: "SuperAdmin Root",
      email: "super.root@test.local",
      mobile: "9876543213",
      role: "super_admin",
      status: "active",
    });
    superAdminUserId = superAdminUser.id;

    const course = await harness.courses.create({
      slug: "cloud-devops",
      title: "Cloud & DevOps Engineering",
      shortDescription: "Learn AWS, Docker, Kubernetes",
      longDescription: "Complete track for cloud architects",
      thumbnailUrl: "/thumb.png",
      durationWeeks: 12,
      totalHours: 120,
      feeINR: 50000,
      level: "Intermediate",
      category: "Cloud & DevOps",
      technologies: ["AWS", "Docker", "Kubernetes"],
      hasPlacementGuarantee: true,
      prerequisites: [],
      learningOutcomes: [],
    });
    courseId = course.id;

    // Facts the admin fake checks, standing in for NXA_Users/NXA_UserRoles,
    // NXA_Courses.ListPrice and NXA_StudentProfiles.ApprovalStatus.
    harness.admin.activeTeacherIds.add(teacherUserId);
    harness.admin.coursePrices.set(courseId, 50000);
    harness.admin.studentApprovals.set(studentUserId, "approved");
    harness.admin.definedDiscounts.set("EARLY10", { type: "percentage", value: 10, isActive: true });
    harness.admin.definedDiscounts.set("OLD", { type: "fixed_amount", value: 2000, isActive: false });

    // Seed dummy refund and override in fake
    harness.admin.refunds.push({
      id: "ref-1",
      refundReference: "REF-001",
      requestedByUserId: studentUserId,
      amount: 10000,
      reason: "Accidental double registration",
      refundStatus: "pending",
      requestedAt: new Date().toISOString(),
    });

    harness.admin.financialOverrides.push({
      id: "fov-1",
      studentId: studentUserId,
      courseId,
      enrollmentId: "enr-1",
      originalAmountINR: 50000,
      proposedAmountINR: 35000,
      discountOrWaiverINR: 15000,
      adjustmentType: "merit_scholarship",
      reason: "State entrance rank holder",
      requestedByAdminId: adminUserId,
      requestedAt: new Date().toISOString(),
      status: "approved",
      decidedAt: new Date().toISOString(),
    });

    const authenticate = createAuthenticate({
      studentAccess: null,
      sessions: () => harness.sessions,
    });

    const app = createApp({
      container: harness.container,
      authenticate,
    });

    server = await startServer(app);
  });

  after(async () => {
    await server.close();
  });

  const getToken = async (userId: string, role: any) => {
    const session = await harness.sessions.create({
      userId,
      refreshTokenHash: Buffer.alloc(64, 1).toString("hex"),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });

    const { token } = issueAccessToken({
      userId,
      role,
      sessionId: session.sessionId,
    });
    return token;
  };

  describe("Security and Role Authorization Gates", () => {
    it("rejects unauthenticated requests on /admin routes with 401", async () => {
      const res = await server.get("/api/v1/admin/dashboard/stats");
      assert.equal(res.status, 401);
    });

    it("rejects student callers on /admin routes with 403", async () => {
      const token = await getToken(studentUserId, "student");
      const res = await server.get("/api/v1/admin/dashboard/stats", {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 403);
    });

    it("rejects teacher callers on /admin routes with 403", async () => {
      const token = await getToken(teacherUserId, "teacher");
      const res = await server.get("/api/v1/admin/dashboard/stats", {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 403);
    });

    it("allows admin callers on /admin routes with 200", async () => {
      const token = await getToken(adminUserId, "admin");
      const res = await server.get("/api/v1/admin/dashboard/stats", {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      const body = await json(res);
      assert.equal(body["success"], true);
      assert.ok(body["data"]);
    });

    it("rejects admin callers on /super-admin routes with 403", async () => {
      const token = await getToken(adminUserId, "admin");
      const res = await server.get("/api/v1/super-admin/dashboard/stats", {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 403);
    });

    it("allows super_admin callers on /super-admin routes with 200", async () => {
      const token = await getToken(superAdminUserId, "super_admin");
      const res = await server.get("/api/v1/super-admin/dashboard/stats", {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      const body = await json(res);
      assert.equal(body["success"], true);
      assert.ok(body["data"]);
    });

    it("allows super_admin callers on /admin routes through role inheritance with 200", async () => {
      const token = await getToken(superAdminUserId, "super_admin");
      const res = await server.get("/api/v1/admin/dashboard/stats", {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
    });
  });

  describe("Admin: Student account decisions", () => {
    const auth = (token: string) => ({
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    let candidateId: string;

    before(async () => {
      const user = await harness.users.create({
        name: "Candidate S",
        email: "cand.s@test.local",
        mobile: "9123456780",
        role: "student",
        status: "active",
      });
      await harness.students.createForUser(user.id, {
        collegeName: "JNTU Hyderabad",
        degreeBranch: "B.Tech CSE",
        passingYear: "2025",
        courseInterestedIn: "Full Stack Development",
        dateOfBirth: "2003-04-12",
        gender: "male",
        fullAddress: "Ameerpet, Hyderabad",
      });
      // Approval requires verified email and mobile (BR-001).
      await harness.students.markVerified(user.id, "email");
      await harness.students.markVerified(user.id, "mobile");
      candidateId = user.id;
    });

    it("records approval in the audit trail with the deciding admin", async () => {
      const token = await getToken(adminUserId, "admin");
      const res = await server.post(`/api/v1/students/${candidateId}/approve`, { remarks: "Documents verified" }, auth(token));
      assert.equal(res.status, 200);
      const log = harness.admin.auditLogs.find((l) => l.actionType === "APPROVE_STUDENT" && l.entityId === candidateId);
      assert.ok(log);
      assert.equal(log.actorUserId, adminUserId);
      assert.equal(log.moduleCode, "STUDENT_MGMT");
    });

    it("suspension signs the student out and records old and new status", async () => {
      const studentToken = await getToken(candidateId, "student");
      assert.equal((await server.get("/api/v1/students/me", auth(studentToken))).status, 200);

      const token = await getToken(adminUserId, "admin");
      const res = await server.patch(`/api/v1/students/${candidateId}/status`, { status: "suspended" }, auth(token));
      assert.equal(res.status, 200);

      assert.equal((await server.get("/api/v1/students/me", auth(studentToken))).status, 401, "existing session revoked");
      const log = harness.admin.auditLogs.find((l) => l.actionType === "SET_STUDENT_STATUS" && l.entityId === candidateId);
      assert.ok(log);
      assert.match(String(log.oldValues), /active/);
      assert.match(String(log.newValues), /suspended/);
    });
  });

  describe("Admin: create student (ADM-003)", () => {
    const auth = (token: string) => ({
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    const body = {
      name: "Ravi Kumar",
      email: "Ravi.Kumar@Test.Local",
      mobile: "7000000100",
      collegeName: "Osmania University",
      passingYear: 2025,
    };
    let newStudentId = "";

    it("creates a pending, unverified, unapproved student with a one-time password", async () => {
      const token = await getToken(adminUserId, "admin");
      const res = await server.post("/api/v1/admin/students", body, auth(token));
      assert.equal(res.status, 201);
      const data = (await json(res))["data"] as Record<string, unknown>;
      newStudentId = String(data["id"]);

      assert.equal(data["email"], "ravi.kumar@test.local");
      assert.equal(data["accountStatus"], "pending");
      assert.equal(data["approvalStatus"], "pending");
      assert.equal(data["accountState"], "pending_verification");
      assert.equal(data["isEmailVerified"], false);
      assert.equal(data["isMobileVerified"], false);

      // Secure credential: policy-compliant, shown once, stored only as a hash.
      const temporaryPassword = String(data["temporaryPassword"]);
      assert.ok(validatePasswordPolicy(temporaryPassword).valid);
      const hash = harness.admin.passwordHashes.get(newStudentId);
      assert.ok(hash && hash !== temporaryPassword);
      assert.ok(await verifyPassword(hash, temporaryPassword));

      // The account really is a pending student, not an active one.
      const user = await harness.users.findById(newStudentId);
      assert.equal(user?.role, "student");
      assert.equal(user?.status, "pending");
      const student = await harness.students.findById(newStudentId);
      assert.equal(student?.adminApprovalStatus, "pending");

      // Audited, without the password.
      const log = harness.admin.auditLogs.find((l) => l.actionType === "CREATE_STUDENT" && l.entityId === newStudentId);
      assert.ok(log);
      assert.equal(log.actorUserId, adminUserId);
      assert.doesNotMatch(JSON.stringify(log), new RegExp(temporaryPassword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    });

    it("issues the email OTP through the existing OTP service and reports mobile OTP as deferred (CL-001)", async () => {
      const challenge = await harness.otpChallenges.findActiveByUser(newStudentId, "email_verification");
      assert.ok(challenge, "an email verification challenge was issued");
      assert.equal(challenge.destination, "ravi.kumar@test.local");
      assert.ok(!("code" in challenge), "only the code hash is stored");

      const token = await getToken(adminUserId, "admin");
      const res = await server.post(
        "/api/v1/admin/students",
        { ...body, email: "second.student@test.local", mobile: "7000000101" },
        auth(token),
      );
      const verification = ((await json(res))["data"] as Record<string, unknown>)["verification"] as Record<
        string,
        Record<string, unknown>
      >;
      assert.equal(verification["email"]?.["status"], "sent");
      assert.equal(verification["mobile"]?.["status"], "deferred");
    });

    it("cannot be approved or enrolled before verification", async () => {
      const token = await getToken(adminUserId, "admin");
      const approve = await server.post(`/api/v1/students/${newStudentId}/approve`, {}, auth(token));
      assert.equal(approve.status, 422);
      assert.match(JSON.stringify(await json(approve)), /EMAIL_NOT_VERIFIED/);

      const enroll = await server.post(
        "/api/v1/admin/enrollments",
        { studentUserId: newStudentId, courseId },
        auth(token),
      );
      assert.equal(enroll.status, 422, "only approved students can enroll");

      // CL-001: email verification is enough; the mobile stays unverified.
      await harness.students.markVerified(newStudentId, "email");
      const approved = await server.post(`/api/v1/students/${newStudentId}/approve`, {}, auth(token));
      assert.equal(approved.status, 200);
      const data = (await json(approved))["data"] as Record<string, unknown>;
      assert.equal(data["adminApprovalStatus"], "approved");
      assert.equal(data["isMobileVerified"], false, "never marked verified without verification");
    });

    it("rejects duplicate email and mobile, regardless of case", async () => {
      const token = await getToken(adminUserId, "admin");
      const dupEmail = await server.post(
        "/api/v1/admin/students",
        { ...body, email: "RAVI.KUMAR@test.local", mobile: "7000000109" },
        auth(token),
      );
      assert.equal(dupEmail.status, 409);
      const dupMobile = await server.post(
        "/api/v1/admin/students",
        { ...body, email: "other.ravi@test.local" },
        auth(token),
      );
      assert.equal(dupMobile.status, 409);
    });

    it("validates input and ignores client-supplied status, role or password", async () => {
      const token = await getToken(adminUserId, "admin");
      const bad = await server.post("/api/v1/admin/students", { ...body, mobile: "12345" }, auth(token));
      assert.equal(bad.status, 422);

      const sneaky = await server.post(
        "/api/v1/admin/students",
        {
          ...body,
          email: "sneaky@test.local",
          mobile: "7000000102",
          status: "active",
          role: "admin",
          password: "Chosen#Password1",
        },
        auth(token),
      );
      assert.equal(sneaky.status, 201);
      const data = (await json(sneaky))["data"] as Record<string, unknown>;
      assert.equal(data["accountStatus"], "pending");
      const user = await harness.users.findById(String(data["id"]));
      assert.equal(user?.role, "student");
      assert.notEqual(data["temporaryPassword"], "Chosen#Password1");
    });

    it("refuses an unknown interested course", async () => {
      const token = await getToken(adminUserId, "admin");
      const res = await server.post(
        "/api/v1/admin/students",
        { ...body, email: "nocourse@test.local", mobile: "7000000103", interestedCourseId: "no-such-course" },
        auth(token),
      );
      assert.equal(res.status, 422);
    });

    it("is not available to teachers or students", async () => {
      for (const role of ["teacher", "student"] as const) {
        const token = await getToken(adminUserId, role);
        const res = await server.post(
          "/api/v1/admin/students",
          { ...body, email: `${role}.made@test.local`, mobile: "7000000104" },
          auth(token),
        );
        assert.equal(res.status, 403);
      }
    });
  });

  describe("Admin: Course management audit", () => {
    it("creates a course from storable fields only and records it in the audit trail", async () => {
      const token = await getToken(adminUserId, "admin");
      const res = await server.post(
        "/api/v1/courses",
        {
          slug: "data-engineering",
          courseCode: "data-engineering",
          title: "Data Engineering",
          shortDescription: "Pipelines and warehouses",
          longDescription: "Batch and streaming data pipelines",
          durationWeeks: 16,
          feeINR: 60000,
          level: "Advanced",
        },
        { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } },
      );
      assert.equal(res.status, 201);
      const id = String(((await json(res))["data"] as Record<string, unknown>)["id"]);
      const log = harness.admin.auditLogs.find((l) => l.actionType === "CREATE_COURSE" && l.entityId === id);
      assert.ok(log, "course creation is audited");
      assert.equal(log.actorUserId, adminUserId);
      assert.equal(log.moduleCode, "COURSE_MGMT");
    });
  });

  describe("Admin: Batch Management Lifecycle", () => {
    it("creates a new batch cohort with 201", async () => {
      const token = await getToken(adminUserId, "admin");
      const res = await server.post(
        "/api/v1/admin/batches",
        {
          courseId,
          batchCode: "BAT-CLOUD-01",
          batchName: "Morning Cloud Cohort",
          startDate: "2026-03-01",
          endDate: "2026-06-01",
          capacity: 40,
          scheduleDescription: "MWF 9:00 AM - 11:00 AM IST",
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
      );
      assert.equal(res.status, 201);
      const body = await json(res);
      assert.equal(body["success"], true);
      const data = body["data"] as Record<string, unknown>;
      assert.ok(data["id"]);
      assert.equal(data["batchCode"], "BAT-CLOUD-01");
      createdBatchId = String(data["id"]);
    });

    it("retrieves batches list and batch by id with 200", async () => {
      const token = await getToken(adminUserId, "admin");
      const listRes = await server.get("/api/v1/admin/batches", {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(listRes.status, 200);

      const oneRes = await server.get(`/api/v1/admin/batches/${createdBatchId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(oneRes.status, 200);
      const body = await json(oneRes);
      assert.equal((body["data"] as Record<string, unknown>)["batchCode"], "BAT-CLOUD-01");
    });

    it("updates batch details with 200", async () => {
      const token = await getToken(adminUserId, "admin");
      const res = await server.put(
        `/api/v1/admin/batches/${createdBatchId}`,
        {
          batchName: "Morning Cloud Architect Cohort",
          capacity: 45,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
      );
      assert.equal(res.status, 200);
      const body = await json(res);
      assert.equal((body["data"] as Record<string, unknown>)["batchName"], "Morning Cloud Architect Cohort");
    });

    it("allocates and unallocates faculty to cohort", async () => {
      const token = await getToken(adminUserId, "admin");
      const allocRes = await server.post(
        `/api/v1/admin/batches/${createdBatchId}/allocate`,
        {
          teacherUserId,
          courseId,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
      );
      assert.equal(allocRes.status, 200);

      const unallocRes = await server.delete(
        `/api/v1/admin/batches/${createdBatchId}/allocate/${teacherUserId}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      assert.equal(unallocRes.status, 200);
    });

    it("updates batch status to ongoing", async () => {
      const token = await getToken(adminUserId, "admin");
      const res = await server.patch(
        `/api/v1/admin/batches/${createdBatchId}/status`,
        { status: "ongoing" },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
      );
      assert.equal(res.status, 200);
      const body = await json(res);
      assert.equal((body["data"] as Record<string, unknown>)["status"], "ongoing");
    });

    describe("business rules", () => {
      const auth = (token: string) => ({
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });

      it("rejects an unknown batch status with 422", async () => {
        const token = await getToken(adminUserId, "admin");
        const res = await server.patch(`/api/v1/admin/batches/${createdBatchId}/status`, { status: "archived" }, auth(token));
        assert.equal(res.status, 422);
      });

      it("rejects an end date before the start date", async () => {
        const token = await getToken(adminUserId, "admin");
        const res = await server.post(
          "/api/v1/admin/batches",
          { courseId, batchCode: "BAT-BAD-DATES", batchName: "Bad dates", startDate: "2026-06-01", endDate: "2026-03-01" },
          auth(token),
        );
        assert.equal(res.status, 422);
      });

      it("requires the course in an allocation (no course-only or course-less allocation)", async () => {
        const token = await getToken(adminUserId, "admin");
        const res = await server.post(`/api/v1/admin/batches/${createdBatchId}/allocations`, { teacherUserId }, auth(token));
        assert.equal(res.status, 422);
      });

      it("rejects an allocation whose batch belongs to a different course", async () => {
        const token = await getToken(adminUserId, "admin");
        const res = await server.post(
          `/api/v1/admin/batches/${createdBatchId}/allocations`,
          { teacherUserId, courseId: "some-other-course" },
          auth(token),
        );
        assert.equal(res.status, 422);
        assert.equal((await json(res))["error"], "BATCH_COURSE_MISMATCH");
      });

      it("rejects allocating a non-teacher, and a duplicate allocation with 409", async () => {
        const token = await getToken(adminUserId, "admin");
        const nonTeacher = await server.post(
          `/api/v1/admin/batches/${createdBatchId}/allocations`,
          { teacherUserId: studentUserId, courseId },
          auth(token),
        );
        assert.equal(nonTeacher.status, 422);

        const first = await server.post(`/api/v1/admin/batches/${createdBatchId}/allocations`, { teacherUserId, courseId }, auth(token));
        assert.equal(first.status, 200);
        const again = await server.post(`/api/v1/admin/batches/${createdBatchId}/allocations`, { teacherUserId, courseId }, auth(token));
        assert.equal(again.status, 409);

        const batch = await json(await server.get(`/api/v1/admin/batches/${createdBatchId}`, auth(token)));
        assert.deepEqual((batch["data"] as Record<string, unknown>)["allocatedTeacherIds"], [teacherUserId]);

        const remove = await server.delete(`/api/v1/admin/batches/${createdBatchId}/allocations/${teacherUserId}`, auth(token));
        assert.equal(remove.status, 200);
        const removeAgain = await server.delete(`/api/v1/admin/batches/${createdBatchId}/allocations/${teacherUserId}`, auth(token));
        assert.equal(removeAgain.status, 404);
      });
    });
  });

  describe("Admin: Enrollment and User Administration", () => {
    let createdEnrollmentId: string;

    it("manually creates enrollment for student with 201", async () => {
      const token = await getToken(adminUserId, "admin");
      const res = await server.post(
        "/api/v1/admin/enrollments",
        {
          studentUserId,
          courseId,
          batchId: createdBatchId,
          // Client-supplied money fields are not part of the contract and are ignored.
          coursePrice: 1,
          finalAmount: 1,
          discountCode: "early10",
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
      );
      assert.equal(res.status, 201);
      const body = await json(res);
      const data = body["data"] as Record<string, unknown>;
      assert.ok(data["id"]);
      createdEnrollmentId = String(data["id"]);
      // Client-supplied coursePrice/finalAmount are ignored; price is the course's.
      assert.equal(data["coursePrice"], 50000);
      assert.equal(data["finalAmount"], 45000);
      // Without a free override the student still has to pay.
      assert.equal(data["enrollmentStatus"], "approved_unpaid");
    });

    describe("enrollment business rules", () => {
      const auth = (token: string) => ({
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });

      it("rejects a second enrollment of the same student in the same course with 409", async () => {
        const token = await getToken(adminUserId, "admin");
        const res = await server.post("/api/v1/admin/enrollments", { studentUserId, courseId }, auth(token));
        assert.equal(res.status, 409);
      });

      it("accepts only defined, active discounts (no free-typed amounts)", async () => {
        harness.admin.studentApprovals.set("disc-student", "approved");
        const token = await getToken(adminUserId, "admin");
        const unknown = await server.post(
          "/api/v1/admin/enrollments",
          { studentUserId: "disc-student", courseId, discountCode: "NOPE" },
          auth(token),
        );
        assert.equal(unknown.status, 422);
        assert.equal((await json(unknown))["error"], "DISCOUNT_NOT_FOUND");
        const inactive = await server.post(
          "/api/v1/admin/enrollments",
          { studentUserId: "disc-student", courseId, discountCode: "OLD" },
          auth(token),
        );
        assert.equal((await json(inactive))["error"], "DISCOUNT_INACTIVE");
        // A raw amount is not part of the contract: it is ignored, not applied.
        const raw = await server.post(
          "/api/v1/admin/enrollments",
          { studentUserId: "disc-student", courseId, discountAmount: 49000 },
          auth(token),
        );
        assert.equal(raw.status, 201);
        assert.equal(((await json(raw))["data"] as Record<string, unknown>)["discountAmount"], 0);
      });

      it("refuses to enroll a student who is not approved (BR-002)", async () => {
        harness.admin.studentApprovals.set("pending-student", "pending");
        const token = await getToken(adminUserId, "admin");
        const res = await server.post("/api/v1/admin/enrollments", { studentUserId: "pending-student", courseId }, auth(token));
        assert.equal(res.status, 422);
        assert.equal((await json(res))["error"], "STUDENT_NOT_APPROVED");
      });

      it("requires a reason for a free access override", async () => {
        harness.admin.studentApprovals.set("free-student", "approved");
        const token = await getToken(adminUserId, "admin");
        const res = await server.post(
          "/api/v1/admin/enrollments",
          { studentUserId: "free-student", courseId, freeAccessOverride: true },
          auth(token),
        );
        assert.equal(res.status, 422);
      });

      it("creates an ACTIVE enrollment for an audited free override", async () => {
        const token = await getToken(adminUserId, "admin");
        const res = await server.post(
          "/api/v1/admin/enrollments",
          { studentUserId: "free-student", courseId, freeAccessOverride: true, overrideReason: "Merit scholarship approved by the board" },
          auth(token),
        );
        assert.equal(res.status, 201);
        const data = (await json(res))["data"] as Record<string, unknown>;
        assert.equal(data["enrollmentStatus"], "active");
        assert.equal(data["finalAmount"], 0, "free access waives the whole fee");
        assert.equal(data["discountAmount"], data["coursePrice"]);
        const log = harness.admin.auditLogs.find((l) => l.entityId === data["id"] && l.actionType === "FREE_ACCESS_OVERRIDE");
        assert.ok(log, "the free override is audited");
        assert.equal(log.actorUserId, adminUserId);
        assert.match(String(log.newValues), /Merit scholarship/);
        assert.match(String(log.newValues), /"freeAccess":true/);
        assert.match(String(log.newValues), /"requestedByUserId"/);
        assert.match(String(log.newValues), /"overrideType":"FREE_ACCESS"/);

        // The grant is recorded as an override authorized by the granting Admin.
        const override = harness.admin.financialOverrides.find((o) => o.enrollmentId === data["id"]);
        assert.ok(override, "an override record is written for the free access grant");
        assert.equal(override.adjustmentType, "FREE_ACCESS");
        assert.equal(override.status, "approved");
        assert.equal(override.requestedByAdminId, adminUserId);
        assert.equal(override.reason, "Merit scholarship approved by the board");
        assert.equal(override.discountOrWaiverINR, data["coursePrice"]);
        assert.match(String(log.newValues), new RegExp(`"overrideId":"${override.id}"`));

        // ...and appears in the Super Admin override history.
        const saToken = await getToken(superAdminUserId, "super_admin");
        const list = await server.get("/api/v1/super-admin/financial-overrides", auth(saToken));
        assert.equal(list.status, 200);
        const rows = (await json(list))["data"] as Array<Record<string, unknown>>;
        assert.ok(rows.some((r) => r["id"] === override.id && r["status"] === "approved"));
      });

      it("records no override for a paid (non-free) enrollment", async () => {
        harness.admin.studentApprovals.set("paid-student", "approved");
        const before = harness.admin.financialOverrides.length;
        const token = await getToken(adminUserId, "admin");
        const res = await server.post("/api/v1/admin/enrollments", { studentUserId: "paid-student", courseId }, auth(token));
        assert.equal(res.status, 201);
        assert.equal(harness.admin.financialOverrides.length, before);
      });

      it("rejects a discount code combined with free access", async () => {
        const token = await getToken(adminUserId, "admin");
        const res = await server.post(
          "/api/v1/admin/enrollments",
          {
            studentUserId: "free-student",
            courseId,
            discountCode: "EARLY10",
            freeAccessOverride: true,
            overrideReason: "Merit scholarship approved by the board",
          },
          auth(token),
        );
        assert.equal(res.status, 422);
      });

      it("does not let a teacher or student grant free access", async () => {
        for (const role of ["teacher", "student"] as const) {
          const token = await getToken(adminUserId, role);
          const res = await server.post(
            "/api/v1/admin/enrollments",
            { studentUserId: "free-student", courseId, freeAccessOverride: true, overrideReason: "Merit scholarship approved by the board" },
            auth(token),
          );
          assert.equal(res.status, 403, `${role} must be refused`);
        }
      });

      it("never activates an unpaid enrollment by status change (payment or free override only)", async () => {
        const token = await getToken(adminUserId, "admin");
        const res = await server.patch(
          `/api/v1/admin/enrollments/${createdEnrollmentId}/status`,
          { status: "active", reason: "Bank transfer verified by finance team" },
          auth(token),
        );
        assert.equal(res.status, 422);
        assert.match(JSON.stringify(await json(res)), /ACTIVATION_REQUIRES_PAYMENT/);
        assert.equal(harness.admin.enrollments.find((e) => e.id === createdEnrollmentId)?.enrollmentStatus, "approved_unpaid");
      });

      it("resumes a suspended, previously activated enrollment with a reason, audited", async () => {
        const token = await getToken(adminUserId, "admin");
        const activeEnr = harness.admin.enrollments.find((e) => e.enrollmentStatus === "active" && e.activatedAt);
        assert.ok(activeEnr, "the free-override enrollment is active");

        const suspend = await server.patch(`/api/v1/admin/enrollments/${activeEnr.id}/status`, { status: "suspended" }, auth(token));
        assert.equal(suspend.status, 200);

        const noReason = await server.patch(`/api/v1/admin/enrollments/${activeEnr.id}/status`, { status: "active" }, auth(token));
        assert.equal(noReason.status, 422);

        const ok = await server.patch(
          `/api/v1/admin/enrollments/${activeEnr.id}/status`,
          { status: "active", reason: "Suspension lifted after fee query was resolved" },
          auth(token),
        );
        assert.equal(ok.status, 200);
        const log = harness.admin.auditLogs.find((l) => l.entityId === activeEnr.id && l.actionType === "RESUME_ENROLLMENT");
        assert.ok(log);
        assert.match(String(log.oldValues), /suspended/);
      });

      it("rejects an unknown enrollment status with 422", async () => {
        const token = await getToken(adminUserId, "admin");
        const res = await server.patch(`/api/v1/admin/enrollments/${createdEnrollmentId}/status`, { status: "paid" }, auth(token));
        assert.equal(res.status, 422);
      });
    });

    it("lists enrollments and updates enrollment status", async () => {
      const token = await getToken(adminUserId, "admin");
      const listRes = await server.get("/api/v1/admin/enrollments", {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(listRes.status, 200);

      const statusRes = await server.patch(
        `/api/v1/admin/enrollments/${createdEnrollmentId}/status`,
        { status: "completed" },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
      );
      assert.equal(statusRes.status, 200);
    });

    it("manages teachers list and creates new teacher user", async () => {
      const token = await getToken(adminUserId, "admin");
      const listRes = await server.get("/api/v1/admin/teachers", {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(listRes.status, 200);

      const createRes = await server.post(
        "/api/v1/admin/teachers",
        {
          name: "Dr. Arvind Gupta",
          email: "arvind.gupta@nexelvoria.edu.in",
          mobile: "9876543299",
          specialization: "Cloud Architecture",
          experienceYears: 12,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
      );
      assert.equal(createRes.status, 201);
    });

    it("unlocks locked student account", async () => {
      const token = await getToken(adminUserId, "admin");
      const res = await server.post(
        `/api/v1/admin/users/${studentUserId}/unlock`,
        {},
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      assert.equal(res.status, 200);
    });

    it("retrieves and updates institute settings", async () => {
      const token = await getToken(adminUserId, "admin");
      const getRes = await server.get("/api/v1/admin/settings", {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(getRes.status, 200);

      const putRes = await server.put(
        "/api/v1/admin/settings",
        {
          // Batch 3 item 9: minAttendancePercentage is stored but never applied, so it is now refused (Q8).
          supportPhone: "+91 90000 11111",
          tagline: "Empowering Next-Gen Engineers",
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
      );
      assert.equal(putRes.status, 200);
      const body = await json(putRes);
      assert.equal((body["data"] as Record<string, unknown>)["supportPhone"], "+91 90000 11111");

      // Attributed to the acting admin, audited with old and new values of the changed keys only.
      assert.equal(harness.admin.settingsUpdatedBy.at(-1), adminUserId);
      const log = harness.admin.auditLogs.filter((l) => l.actionType === "UPDATE_SETTINGS").at(-1);
      assert.ok(log);
      assert.equal(log.actorUserId, adminUserId);
      assert.match(String(log.oldValues), /"supportPhone":"\+91 80000 12345"/);
      assert.match(String(log.newValues), /"supportPhone":"\+91 90000 11111"/);
    });

    it("retrieves admin activity logs with 200", async () => {
      const token = await getToken(adminUserId, "admin");
      const res = await server.get("/api/v1/admin/activity-logs", {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
    });
  });

  describe("Super Admin: Governance, RBAC, Configuration & Financial Oversight", () => {
    it("creates an administrator account with 201", async () => {
      const token = await getToken(superAdminUserId, "super_admin");
      const res = await server.post(
        "/api/v1/super-admin/admins",
        {
          name: "Suresh Rao",
          email: "suresh.rao@nexelvoria.edu.in",
          mobile: "9876599881",
          department: "Examination Department",
          permissions: ["manage_tests", "view_reports"],
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
      );
      assert.equal(res.status, 201);
      const body = await json(res);
      const data = body["data"] as Record<string, unknown>;
      assert.ok(data["id"]);
      createdAdminId = String(data["id"]);
    });

    it("lists and updates admin account", async () => {
      const token = await getToken(superAdminUserId, "super_admin");
      const listRes = await server.get("/api/v1/super-admin/admins", {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(listRes.status, 200);

      const updateRes = await server.put(
        `/api/v1/super-admin/admins/${createdAdminId}`,
        { department: "Senior Admissions & Operations" },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
      );
      assert.equal(updateRes.status, 200);

      const statusRes = await server.patch(
        `/api/v1/super-admin/admins/${createdAdminId}/status`,
        { status: "suspended" },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
      );
      assert.equal(statusRes.status, 200);

      const pwRes = await server.post(
        `/api/v1/super-admin/admins/${createdAdminId}/reset-password`,
        {},
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      assert.equal(pwRes.status, 200);
    });

    describe("admin account lifecycle security", () => {
      const auth = (token: string) => ({
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      let adminId: string;
      let issuedPassword: string;

      it("issues a policy-compliant one-time password whose argon2id hash is what gets stored", async () => {
        const token = await getToken(superAdminUserId, "super_admin");
        const res = await server.post(
          "/api/v1/super-admin/admins",
          { name: "Lakshmi Iyer", email: "Lakshmi.Iyer@nexelvoria.edu.in", mobile: "9876500001" },
          auth(token),
        );
        assert.equal(res.status, 201);
        const data = (await json(res))["data"] as Record<string, unknown>;
        adminId = String(data["id"]);
        issuedPassword = String(data["temporaryPassword"]);

        assert.equal(validatePasswordPolicy(issuedPassword).valid, true);
        const stored = harness.admin.passwordHashes.get(adminId);
        assert.ok(stored?.startsWith("$argon2id$"), "an argon2id hash is persisted");
        assert.notEqual(stored, issuedPassword, "plaintext is never stored");
        assert.equal((await verifyPassword(stored, issuedPassword)).valid, true);
      });

      it("rejects a duplicate email with 409 instead of creating a second account", async () => {
        const token = await getToken(superAdminUserId, "super_admin");
        const res = await server.post(
          "/api/v1/super-admin/admins",
          { name: "Lakshmi Two", email: "lakshmi.iyer@nexelvoria.edu.in", mobile: "9876500002" },
          auth(token),
        );
        assert.equal(res.status, 409);
      });

      it("reset-password stores a new hash, invalidates the old password and signs the admin out", async () => {
        const adminToken = await getToken(adminId, "admin");
        const before = await server.get("/api/v1/admin/stats", auth(adminToken));
        assert.equal(before.status, 200);

        const token = await getToken(superAdminUserId, "super_admin");
        const res = await server.post(`/api/v1/super-admin/admins/${adminId}/reset-password`, {}, auth(token));
        assert.equal(res.status, 200);
        const next = String(((await json(res))["data"] as Record<string, unknown>)["temporaryPassword"]);
        assert.notEqual(next, issuedPassword);

        const stored = harness.admin.passwordHashes.get(adminId);
        assert.equal((await verifyPassword(stored, next)).valid, true);
        assert.equal((await verifyPassword(stored, issuedPassword)).valid, false);

        const after = await server.get("/api/v1/admin/stats", auth(adminToken));
        assert.equal(after.status, 401, "existing sessions are revoked");
      });

      it("suspending an admin revokes their live sessions", async () => {
        const adminToken = await getToken(adminId, "admin");
        const token = await getToken(superAdminUserId, "super_admin");
        const res = await server.patch(`/api/v1/super-admin/admins/${adminId}/status`, { status: "suspended" }, auth(token));
        assert.equal(res.status, 200);
        const after = await server.get("/api/v1/admin/stats", auth(adminToken));
        assert.equal(after.status, 401);
      });

      it("forbids a super admin from suspending or resetting their own account", async () => {
        const token = await getToken(superAdminUserId, "super_admin");
        const s = await server.patch(`/api/v1/super-admin/admins/${superAdminUserId}/status`, { status: "suspended" }, auth(token));
        assert.equal(s.status, 403);
        const r = await server.post(`/api/v1/super-admin/admins/${superAdminUserId}/reset-password`, {}, auth(token));
        assert.equal(r.status, 403);
      });

      it("returns 404 when resetting the password of an unknown admin", async () => {
        const token = await getToken(superAdminUserId, "super_admin");
        const res = await server.post("/api/v1/super-admin/admins/adm-999/reset-password", {}, auth(token));
        assert.equal(res.status, 404);
      });
    });

    it("lists real roles without inventing permissions, and refuses role/permission changes", async () => {
      const token = await getToken(superAdminUserId, "super_admin");
      harness.admin.roles.push({
        id: "1", roleCode: "super_admin", roleName: "Super Administrator", description: "",
        isSystemRole: true, isActive: true, permissions: [], createdAt: new Date().toISOString(),
      });
      const listRes = await server.get("/api/v1/super-admin/roles", { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(listRes.status, 200);
      const roles = (await json(listRes))["data"] as Array<Record<string, unknown>>;
      assert.ok(roles.every((r) => Array.isArray(r["permissions"]) && (r["permissions"] as unknown[]).length === 0));

      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      const roleCountBefore = harness.admin.roles.length;
      const createRes = await server.post(
        "/api/v1/super-admin/roles",
        { roleCode: "auditor", roleName: "Compliance Auditor", description: "Read-only", permissions: ["view_reports"] },
        { headers },
      );
      assert.equal(createRes.status, 422);
      assert.match(JSON.stringify(await json(createRes)), /RBAC_CATALOG_UNAVAILABLE/);

      const permRes = await server.put("/api/v1/super-admin/roles/1/permissions", { permissions: ["export_data"] }, { headers });
      assert.equal(permRes.status, 422);
      assert.equal(harness.admin.roles.length, roleCountBefore, "nothing was created");
    });

    it("reports the real platform configuration read-only, without secrets", async () => {
      const token = await getToken(superAdminUserId, "super_admin");
      const getRes = await server.get("/api/v1/super-admin/config", { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(getRes.status, 200);
      const data = (await json(getRes))["data"] as Record<string, any>;
      assert.equal(data["source"], "server_environment");
      assert.equal(data["editable"], false);
      assert.equal(data["security"]["maxFailedLoginAttempts"], 5);
      assert.equal(data["sms"]["configured"], false);
      assert.match(String(data["reporting"]["financialYear"]), /^FY \d{4}-\d{2}$/);
      assert.doesNotMatch(JSON.stringify(data), /pass"|keySecret|rzp_test/i);

      const putRes = await server.put(
        "/api/v1/super-admin/config",
        { academic: { isRegistrationOpen: true } },
        { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } },
      );
      assert.equal(putRes.status, 422, "no fake save");
      assert.match(JSON.stringify(await json(putRes)), /SYSTEM_CONFIG_READ_ONLY/);
    });

    it("never reports a test email as sent when SMTP is not configured", async () => {
      const token = await getToken(superAdminUserId, "super_admin");
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      const missing = await server.post("/api/v1/super-admin/config/test-email", {}, { headers });
      assert.equal(missing.status, 422, "a recipient is required");

      const res = await server.post("/api/v1/super-admin/config/test-email", { recipientEmail: "owner@test.local" }, { headers });
      assert.equal(res.status, 503);
      assert.match(JSON.stringify(await json(res)), /SMTP_NOT_CONFIGURED/);

      const adminToken = await getToken(adminUserId, "admin");
      const denied = await server.post(
        "/api/v1/super-admin/config/test-email",
        { recipientEmail: "owner@test.local" },
        { headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" } },
      );
      assert.equal(denied.status, 403);
    });

    it("retrieves administrative audit logs with 200", async () => {
      const token = await getToken(superAdminUserId, "super_admin");
      const res = await server.get("/api/v1/super-admin/audit-logs", {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
    });

    it("approves or rejects refund requests", async () => {
      const token = await getToken(superAdminUserId, "super_admin");
      const listRes = await server.get("/api/v1/super-admin/refunds", {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(listRes.status, 200);

      const decideRes = await server.post(
        "/api/v1/super-admin/refunds/ref-1/decide",
        {
          status: "approved",
          remarks: "Approved per refund policy clause 4.2",
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
      );
      assert.equal(decideRes.status, 200);
      const body = await json(decideRes);
      assert.equal((body["data"] as Record<string, unknown>)["refundStatus"], "approved");

      const log = harness.admin.auditLogs.find((l) => l.entityId === "ref-1" && l.actionType === "APPROVE_REFUND");
      assert.ok(log, "the refund decision is audited");
      assert.match(String(log.newValues), /refund policy clause 4\.2/, "remarks are kept in the audit record");

      // A decided refund cannot be decided again.
      const again = await server.post("/api/v1/super-admin/refunds/ref-1/reject", { mandatoryReason: "Changed my mind about this" }, {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      assert.equal(again.status, 409);
      assert.equal(harness.admin.refunds.find((r) => r.id === "ref-1")?.refundStatus, "approved");
    });

    it("requires a reason to reject a refund and records the rejection", async () => {
      const token = await getToken(superAdminUserId, "super_admin");
      harness.admin.refunds.push({
        id: "ref-2",
        refundReference: "REF-002",
        requestedByUserId: studentUserId,
        amount: 5000,
        reason: "Course not as expected",
        refundStatus: "pending",
        requestedAt: new Date().toISOString(),
      });
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

      const noReason = await server.post("/api/v1/super-admin/refunds/ref-2/reject", {}, { headers });
      assert.equal(noReason.status, 422);
      const shortReason = await server.post("/api/v1/super-admin/refunds/ref-2/decide", { status: "rejected", remarks: "no" }, { headers });
      assert.equal(shortReason.status, 422);
      assert.equal(harness.admin.refunds.find((r) => r.id === "ref-2")?.refundStatus, "pending");

      const ok = await server.post(
        "/api/v1/super-admin/refunds/ref-2/reject",
        { mandatoryReason: "Outside the refund window per policy" },
        { headers },
      );
      assert.equal(ok.status, 200);
      const refund = harness.admin.refunds.find((r) => r.id === "ref-2");
      assert.equal(refund?.refundStatus, "rejected");
      assert.equal(refund?.approvedBySuperAdminUserId, undefined, "a rejection is not stamped as an approval");
      const log = harness.admin.auditLogs.find((l) => l.entityId === "ref-2" && l.actionType === "REJECT_REFUND");
      assert.ok(log);
      assert.match(String(log.newValues), /Outside the refund window/);
    });

    it("returns 404 for an unknown refund", async () => {
      const token = await getToken(superAdminUserId, "super_admin");
      const res = await server.post("/api/v1/super-admin/refunds/missing/approve", {}, {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      assert.equal(res.status, 404);
    });

    it("does not let an admin decide refunds", async () => {
      const token = await getToken(adminUserId, "admin");
      const res = await server.post("/api/v1/super-admin/refunds/ref-1/approve", {}, {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      assert.equal(res.status, 403);
    });

    it("lists overrides as granted history and refuses to re-approve them", async () => {
      const token = await getToken(superAdminUserId, "super_admin");
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      const listRes = await server.get("/api/v1/super-admin/financial-overrides", { headers });
      assert.equal(listRes.status, 200);
      const rows = (await json(listRes))["data"] as Array<Record<string, unknown>>;
      assert.ok(rows.length > 0);
      assert.ok(rows.every((r) => r["status"] === "approved"), "every recorded override is already authorized");

      const pending = await server.get("/api/v1/super-admin/financial-overrides?status=pending", { headers });
      assert.equal(pending.status, 200);
      assert.deepEqual((await json(pending))["data"], []);

      const auditCount = harness.admin.auditLogs.length;
      const decideRes = await server.post(
        "/api/v1/super-admin/financial-overrides/fov-1/decide",
        { status: "approved", remarks: "Merit scholarship approved for top percentile student" },
        { headers },
      );
      assert.equal(decideRes.status, 409);
      const again = await server.post("/api/v1/super-admin/financial-overrides/fov-1/approve", {}, { headers });
      assert.equal(again.status, 409);
      assert.equal(harness.admin.auditLogs.length, auditCount, "a refused decision is not audited as a change");

      const missing = await server.post("/api/v1/super-admin/financial-overrides/missing/approve", {}, { headers });
      assert.equal(missing.status, 404);
    });

    it("refuses to fake an override rejection the schema cannot store", async () => {
      const token = await getToken(superAdminUserId, "super_admin");
      harness.admin.financialOverrides.push({
        id: "fov-2",
        studentId: studentUserId,
        courseId,
        enrollmentId: "enr-2",
        originalAmountINR: 40000,
        proposedAmountINR: 0,
        discountOrWaiverINR: 40000,
        adjustmentType: "free_access",
        reason: "Scholarship",
        requestedByAdminId: adminUserId,
        requestedAt: new Date().toISOString(),
        status: "approved",
      });
      const res = await server.post(
        "/api/v1/super-admin/financial-overrides/fov-2/reject",
        { mandatoryReason: "Scholarship criteria not met" },
        { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } },
      );
      assert.equal(res.status, 422);
      const body = await json(res);
      assert.match(JSON.stringify(body), /OVERRIDE_REJECTION_UNSUPPORTED/);
      assert.equal(harness.admin.financialOverrides.find((f) => f.id === "fov-2")?.status, "approved", "unchanged");
    });
  });
});
