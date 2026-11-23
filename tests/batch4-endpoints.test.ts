import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app";
import { issueAccessToken } from "../src/modules/auth/token.service";
import { createAuthenticate } from "../src/middleware/authenticate.middleware";
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
      status: "pending",
    });

    const authenticate = createAuthenticate({
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
          coursePrice: 50000,
          discountAmount: 5000,
          finalAmount: 45000,
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
          minAttendancePercentage: 80,
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
      assert.equal((body["data"] as Record<string, unknown>)["minAttendancePercentage"], 80);
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

    it("manages global RBAC roles and permissions", async () => {
      const token = await getToken(superAdminUserId, "super_admin");
      const listRes = await server.get("/api/v1/super-admin/roles", {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(listRes.status, 200);

      const createRes = await server.post(
        "/api/v1/super-admin/roles",
        {
          roleCode: "auditor",
          roleName: "Compliance Auditor",
          description: "Read-only access to academic and financial logs",
          permissions: ["view_reports", "view_audit_logs"],
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
      );
      assert.equal(createRes.status, 201);
      const body = await json(createRes);
      const roleId = (body["data"] as Record<string, unknown>)["id"];

      const permRes = await server.put(
        `/api/v1/super-admin/roles/${roleId}/permissions`,
        { permissions: ["view_reports", "view_audit_logs", "export_data"] },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
      );
      assert.equal(permRes.status, 200);
    });

    it("retrieves and updates platform system configuration", async () => {
      const token = await getToken(superAdminUserId, "super_admin");
      const getRes = await server.get("/api/v1/super-admin/config", {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(getRes.status, 200);

      const putRes = await server.put(
        "/api/v1/super-admin/config",
        { academic: { isRegistrationOpen: true } },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
      );
      assert.equal(putRes.status, 200);

      const testEmailRes = await server.post(
        "/api/v1/super-admin/config/test-email",
        {},
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      assert.equal(testEmailRes.status, 200);
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
    });

    it("approves or rejects financial overrides", async () => {
      const token = await getToken(superAdminUserId, "super_admin");
      const listRes = await server.get("/api/v1/super-admin/financial-overrides", {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(listRes.status, 200);

      const decideRes = await server.post(
        "/api/v1/super-admin/financial-overrides/fov-1/decide",
        {
          status: "approved",
          remarks: "Merit scholarship approved for top percentile student",
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
      assert.equal((body["data"] as Record<string, unknown>)["status"], "approved");
    });
  });
});
