import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type sql from "mssql";

import { createApp } from "../src/app";
import { createAuthenticate } from "../src/middleware/authenticate.middleware";
import { issueAccessToken } from "../src/modules/auth/token.service";
import { SqlServerCourseRepository } from "../src/modules/courses/sqlserver-course.repository";
import { SqlServerSupportRepository } from "../src/modules/support/sqlserver-support.repository";
import { recordAttendanceBodySchema } from "../src/modules/teachers/teacher.validation";
import { createTestHarness, type TestHarness } from "./fakes";
import { startServer, type TestServer } from "./helpers/server";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Batch 3 item 10A (gap closure):
 * SUP-005 ticket status history, SUP-006 category management, COM-008 Admin
 * notification history, SEC API authorization (public jobs / certificate
 * verification), ADM-006 no invented course fields, BR-010 in the teacher
 * portal, and the generic settings endpoint no longer bypassing the settings rules.
 */
describe("gap closure 10A (HTTP)", () => {
  let harness: TestHarness;
  let server: TestServer;
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const auth = (role: string) => ({ headers: { Authorization: `Bearer ${tokens[role]}`, "Content-Type": "application/json" } });
  const json = async (res: Response) => (await res.json()) as Record<string, any>;
  const supportAudits = () => harness.support.auditLogs.filter((l) => l.moduleCode === "SUPPORT");

  beforeEach(async () => {
    harness = createTestHarness();
    let seq = 30;
    for (const role of ["admin", "super_admin", "teacher", "student"] as const) {
      seq++;
      const user = await harness.users.create({ name: `${role} User`, email: `${role}-${seq}@gap.test`, mobile: `98733300${seq}`, role, status: "active" });
      ids[role] = user.id;
      harness.support.usersByRole[role] = [user.id];
      harness.support.userNames[user.id] = `${role} User`;
      const session = await harness.sessions.create({ userId: user.id, refreshTokenHash: Buffer.alloc(64, 5).toString("hex"), ipAddress: "127.0.0.1", expiresAt: new Date(Date.now() + 3600000).toISOString() });
      tokens[role] = issueAccessToken({ userId: user.id, role, sessionId: session.sessionId }).token;
    }
    const authenticate = createAuthenticate({ studentAccess: null, sessions: () => harness.sessions });
    server = await startServer(createApp({ container: harness.container, authenticate }));
  });

  afterEach(async () => {
    await server.close();
  });

  // ---------------------------------------------------------------- SUP-006
  it("manages ticket categories with audit, duplicate and no-op handling (SUP-006)", async () => {
    const created = await server.post("/api/v1/support/admin/categories", { name: "Fees & Payments" }, auth("admin"));
    assert.equal(created.status, 201);
    const cat = (await json(created))["data"];
    assert.deepEqual(cat, { id: cat.id, name: "Fees & Payments", isActive: true });
    assert.equal((await server.post("/api/v1/support/admin/categories", { name: "fees & payments" }, auth("super_admin"))).status, 409);

    assert.equal((await server.patch(`/api/v1/support/admin/categories/${cat.id}`, { isActive: false }, auth("admin"))).status, 200);
    const same = await json(await server.patch(`/api/v1/support/admin/categories/${cat.id}`, { isActive: false }, auth("admin")));
    assert.match(same["message"], /No changes/);
    assert.deepEqual(supportAudits().map((a) => a.actionType), ["CREATE_SUPPORT_CATEGORY", "DEACTIVATE_SUPPORT_CATEGORY"]);

    const all = (await json(await server.get("/api/v1/support/admin/categories", auth("admin"))))["data"];
    assert.equal(all[0].isActive, false, "inactive categories stay visible to Admins");
    assert.deepEqual((await json(await server.get("/api/v1/support/categories", auth("student"))))["data"], [], "students only see active ones");
    const raise = await server.post("/api/v1/support/tickets", { categoryId: cat.id, subject: "Fee receipt", description: "I need my fee receipt please" }, auth("student"));
    assert.equal(raise.status, 422, "an inactive category cannot be used");

    assert.equal((await server.patch("/api/v1/support/admin/categories/99999", { name: "Ghost" }, auth("admin"))).status, 404);
    for (const body of [{ name: "" }, { name: "Valid", colour: "red" }, {}]) {
      assert.equal((await server.post("/api/v1/support/admin/categories", body, auth("admin"))).status, 422, JSON.stringify(body));
    }
    for (const role of ["teacher", "student"]) assert.equal((await server.get("/api/v1/support/admin/categories", auth(role))).status, 403, role);
  });

  // ---------------------------------------------------------------- SUP-005
  it("returns the full status history of a ticket to Admins (SUP-005)", async () => {
    harness.support.categories.push({ id: "1", name: "General", isActive: true });
    const ticket = (await json(await server.post("/api/v1/support/tickets", { categoryId: "1", subject: "Cannot log in", description: "The login page keeps failing for me" }, auth("student"))))["data"];
    await server.patch(`/api/v1/support/admin/tickets/${ticket.id}/status`, { status: "in_progress" }, auth("admin"));
    await server.patch(`/api/v1/support/admin/tickets/${ticket.id}/status`, { status: "resolved" }, auth("super_admin"));

    const history = (await json(await server.get(`/api/v1/support/admin/tickets/${ticket.id}/history`, auth("admin"))))["data"];
    assert.deepEqual(history.map((h: any) => [h.previousStatus ?? null, h.newStatus, h.changedByName]), [
      [null, "open", "student User"],
      ["open", "in_progress", "admin User"],
      ["in_progress", "resolved", "super_admin User"],
    ]);
    assert.equal((await server.get("/api/v1/support/admin/tickets/424242/history", auth("admin"))).status, 404);
    assert.equal((await server.get("/api/v1/support/admin/tickets/TCK-1/history", auth("admin"))).status, 422);
    assert.equal((await server.get(`/api/v1/support/admin/tickets/${ticket.id}/history`, auth("student"))).status, 403);
  });

  // ---------------------------------------------------------------- COM-008
  it("lists every notification sent, with recipient, filters and server-side paging (COM-008)", async () => {
    for (let i = 1; i <= 3; i++) {
      await server.post("/api/v1/support/notifications/send", { recipientUserId: ids["student"], title: `Fee reminder ${i}`, messageBody: "Your fee is due soon.", notificationType: "payment" }, auth("admin"));
    }
    await server.post("/api/v1/support/notifications/send", { recipientUserId: ids["teacher"], title: "Timetable change", messageBody: "Your Friday class moved.", notificationType: "academic" }, auth("admin"));

    const page1 = (await json(await server.get("/api/v1/support/admin/notifications?pageSize=2", auth("admin"))))["data"];
    assert.equal(page1.total, 4);
    assert.equal(page1.totalPages, 2);
    assert.equal(page1.rows.length, 2);
    assert.equal(page1.rows[0].recipientName !== undefined, true);

    const payments = (await json(await server.get("/api/v1/support/admin/notifications?notificationType=payment", auth("super_admin"))))["data"];
    assert.equal(payments.total, 3);
    // Recipient ids are BIGINT identities: a numeric recipient filters, anything else is refused (422 below).
    harness.support.notifications.push({ id: "9001", recipientUserId: "900", notificationType: "academic", title: "Batch moved", messageBody: "Room changed.", priority: "normal", createdAt: new Date().toISOString() });
    const byRecipient = (await json(await server.get("/api/v1/support/admin/notifications?recipientUserId=900", auth("admin"))))["data"];
    assert.deepEqual(byRecipient.rows.map((r: any) => r.title), ["Batch moved"]);
    const searched = (await json(await server.get("/api/v1/support/admin/notifications?search=friday", auth("admin"))))["data"];
    assert.equal(searched.total, 1);

    for (const q of ["from=2026-02-30", "from=2026-05-01&to=2026-04-01", "pageSize=500", "notificationType=sms", "recipientUserId=abc"]) {
      assert.equal((await server.get(`/api/v1/support/admin/notifications?${q}`, auth("admin"))).status, 422, q);
    }
    for (const role of ["teacher", "student"]) assert.equal((await server.get("/api/v1/support/admin/notifications", auth(role))).status, 403, role);
  });

  // ---------------------------------------------------------------- settings bypass
  it("does not let the generic settings endpoint bypass the settings rules", async () => {
    const blocked = await server.put("/api/v1/support/admin/system-config", { settingKey: "minAttendancePercentage", settingValue: "40" }, auth("super_admin"));
    assert.equal(blocked.status, 422);
    // D1 made the key editable, but only through the validated settings endpoint (75% floor, Super Admin only).
    assert.match((await json(blocked))["details"][0].message, /admin\/settings/);
    const maintenance = await server.put("/api/v1/support/admin/system-config", { settingKey: "maintenanceMode", settingValue: "true" }, auth("super_admin"));
    assert.equal(maintenance.status, 422);
    assert.match((await json(maintenance))["message"], /super-admin\/maintenance/);
    const profile = await server.put("/api/v1/support/admin/system-config", { settingKey: "instituteName", settingValue: "X" }, auth("super_admin"));
    assert.equal(profile.status, 422, "profile keys go through the validated settings endpoint");
  });

  // ---------------------------------------------------------------- SEC: public jobs
  it("exposes only open jobs publicly, while Admins see every status", async () => {
    const company = (await json(await server.post("/api/v1/placements/companies", { companyName: "Infosys", industry: "IT", contactEmail: "hr@infosys.test" }, auth("admin"))))["data"];
    const mk = async (jobStatus: string) =>
      (await json(await server.post("/api/v1/placements/jobs", { companyId: company.id, jobTitle: `SDE ${jobStatus}`, workLocation: "Pune", jobDescription: "Build reliable services", jobStatus }, auth("admin"))))["data"];
    const open = await mk("open");
    const draft = await mk("draft");

    const pub = (await json(await server.get("/api/v1/placements/jobs?status=draft")))["data"];
    assert.deepEqual(pub.map((j: any) => j.id), [open.id], "a status filter cannot reveal drafts");
    assert.equal((await server.get(`/api/v1/placements/jobs/${draft.id}`)).status, 404);
    assert.equal((await server.get(`/api/v1/placements/jobs/${open.id}`)).status, 200);

    const adminList = (await json(await server.get("/api/v1/placements/admin/jobs", auth("admin"))))["data"];
    assert.deepEqual(adminList.map((j: any) => j.id).sort(), [open.id, draft.id].sort());
    assert.equal((await server.get(`/api/v1/placements/admin/jobs/${draft.id}`, auth("super_admin"))).status, 200);
    assert.equal((await server.get("/api/v1/placements/admin/jobs")).status, 401);
    assert.equal((await server.get("/api/v1/placements/admin/jobs", auth("student"))).status, 403);
  });

  // ---------------------------------------------------------------- SEC: certificate verification
  it("verifies certificates publicly without exposing internal identifiers", async () => {
    await harness.certificates.issueCertificate({
      studentUserId: "501",
      studentNameAtIssue: "Asha Rao",
      courseId: "11",
      courseNameAtIssue: "Full Stack Java",
      enrollmentId: "77",
      certificateNumber: "NXA-2026-0100",
      verificationToken: "secret-token-0100",
      attendancePercentage: 88,
      passingMarksVerified: true,
      courseCompletionVerified: true,
      certificateStatus: "valid",
      issuedByUserId: "9",
    });
    const res = (await json(await server.get("/api/v1/certificates/public/verify/NXA-2026-0100")))["data"];
    assert.equal(res.isValid, true);
    assert.deepEqual(Object.keys(res.certificate).sort(), ["attendancePercentage", "certificateNumber", "certificateStatus", "courseNameAtIssue", "issuedAt", "studentNameAtIssue"]);
    assert.doesNotMatch(JSON.stringify(res), /secret-token-0100|"501"|"77"/);
  });
});

// ---------------------------------------------------------------- BR-010 (teacher portal)
describe("teacher attendance vocabulary (BR-010)", () => {
  it("accepts Present / Absent / Leave and refuses anything else", () => {
    const base = { batchId: "5", records: [{ studentUserId: "301", status: "leave" }] };
    assert.equal(recordAttendanceBodySchema.safeParse(base).success, true);
    for (const status of ["late", "excused", "LATE"]) {
      assert.equal(recordAttendanceBodySchema.safeParse({ ...base, records: [{ studentUserId: "301", status }] }).success, false, status);
    }
  });
});

// ---------------------------------------------------------------- SQL adapters (mock pool)
const mockPool = (handler: (q: string, inputs: Record<string, unknown>) => unknown) => {
  const seen: Array<{ q: string; inputs: Record<string, unknown> }> = [];
  const state = { committed: 0, rolledBack: 0 };
  const request = () => {
    const inputs: Record<string, unknown> = {};
    const r = {
      input(name: string, t: unknown, v?: unknown) {
        inputs[name] = v !== undefined ? v : t;
        return r;
      },
      async query(q: string) {
        seen.push({ q, inputs: { ...inputs } });
        const res = handler(q, inputs);
        if (res instanceof Error) throw res;
        return { recordset: (res as any)?.recordset ?? [], rowsAffected: [1] };
      },
    };
    return r;
  };
  const pool = { request, transaction: () => ({ begin: async () => {}, commit: async () => void state.committed++, rollback: async () => void state.rolledBack++, request }) } as unknown as sql.ConnectionPool;
  return { seen, state, pool };
};

describe("SQL adapters for 10A (mock pool)", () => {
  it("reads a course without inventing a thumbnail, category or total hours (ADM-006)", async () => {
    const m = mockPool((q) =>
      q.includes("NXA_CourseModules")
        ? { recordset: [] }
        : { recordset: [{ CourseId: 10, CourseCode: "FS-PY", CourseName: "Full Stack Python", CourseLevel: "Beginner", Description: "d", ShortDescription: "s", DurationValue: 16, DurationUnit: "WEEKS", ListPrice: 25000, CurrencyCode: "INR", IsPreviewEnabled: 1, Status: "PUBLISHED", CreatedAt: new Date(), UpdatedAt: null }] },
    );
    const course = await new SqlServerCourseRepository(m.pool).findById("10");
    assert.ok(course);
    assert.equal("thumbnailUrl" in course, false);
    assert.equal("category" in course, false);
    assert.equal("totalHours" in course, false);
    assert.equal(course.durationWeeks, 16);
  });

  it("updates a category and its audit row in one transaction, and rolls back when the audit fails (SUP-006)", async () => {
    const ok = mockPool((q) => (q.includes("SELECT CategoryName, IsActive") ? { recordset: [{ CategoryName: "General", IsActive: true }] } : q.includes("TOP 1 1") ? { recordset: [] } : { recordset: [{ AuditLogId: 1 }] }));
    const res = await new SqlServerSupportRepository(async () => ok.pool).updateCategory("3", { name: "Technical" }, "7");
    assert.equal(res.changed, true);
    const audit = ok.seen.find((s) => s.q.includes("INSERT INTO dbo.NXA_AuditLogs"))!;
    assert.equal(audit.inputs["action"], "UPDATE_SUPPORT_CATEGORY");
    assert.equal(audit.inputs["oldVal"], JSON.stringify({ name: "General" }));

    const fail = mockPool((q) => {
      if (q.includes("SELECT CategoryName, IsActive")) return { recordset: [{ CategoryName: "General", IsActive: true }] };
      if (q.includes("INSERT INTO dbo.NXA_AuditLogs")) return new Error("audit insert failed");
      return { recordset: [] };
    });
    await assert.rejects(new SqlServerSupportRepository(async () => fail.pool).updateCategory("3", { isActive: false }, "7"), /audit insert failed/);
    assert.deepEqual(fail.state, { committed: 0, rolledBack: 1 });

    const noop = mockPool(() => ({ recordset: [{ CategoryName: "General", IsActive: true }] }));
    const same = await new SqlServerSupportRepository(async () => noop.pool).updateCategory("3", { name: "General" }, "7");
    assert.equal(same.changed, false);
    assert.equal(noop.seen.filter((s) => /UPDATE|INSERT/.test(s.q)).length, 0);
  });

  it("pages notification history with IST bounds and an escaped search (COM-008)", async () => {
    const m = mockPool((q) => (q.includes("COUNT(1)") ? { recordset: [{ total: 30 }] } : { recordset: [] }));
    const r = await new SqlServerSupportRepository(async () => m.pool).getNotificationHistory({ from: "2026-04-01", to: "2026-04-30", search: "50%", page: 2, pageSize: 10 });
    assert.equal(r.total, 30);
    const data = m.seen[1]!;
    assert.deepEqual(data.inputs["FromUtc"], new Date("2026-03-31T18:30:00.000Z"));
    assert.deepEqual(data.inputs["ToUtc"], new Date("2026-04-30T18:30:00.000Z"));
    assert.equal(data.inputs["Search"], "%50\\%%");
    assert.equal(data.inputs["Offset"], 10);
    assert.match(data.q, /ORDER BY n\.CreatedAt DESC, n\.NotificationId DESC/);
  });
});
