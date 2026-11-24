import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type sql from "mssql";

import { createApp } from "../src/app";
import { createAuthenticate } from "../src/middleware/authenticate.middleware";
import { issueAccessToken } from "../src/modules/auth/token.service";
import { SqlServerTeacherRepository } from "../src/modules/teachers/sqlserver-teacher.repository";
import { SqlServerSupportRepository } from "../src/modules/support/sqlserver-support.repository";
import { SqlServerAcademicsRepository } from "../src/modules/academics/sqlserver-academics.repository";
import { createAdminService } from "../src/modules/admin/admin.service";
import type { Course } from "../src/modules/courses/course.types";
import { createTestHarness, type TestHarness } from "./fakes";
import { startServer, type TestServer } from "./helpers/server";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Batch 3 item 10B: COM-010 messaging, ASM-012 evaluation history, PUB-006
 * trainer-course links, public prerequisites, and audit coverage fixes
 * (single notification send audited; no-op status changes not audited).
 */
describe("gap closure 10B (HTTP)", () => {
  let harness: TestHarness;
  let server: TestServer;
  const tokens: Record<string, string> = {};
  const json = async (res: Response) => (await res.json()) as Record<string, any>;
  const auth = (who: string) => ({ headers: { Authorization: `Bearer ${tokens[who]}`, "Content-Type": "application/json" } });
  // Numeric ids, as NXA_Users.UserId: messaging only accepts BIGINT ids.
  const USERS: Record<string, { id: string; role: "admin" | "super_admin" | "teacher" | "student"; name: string }> = {
    admin: { id: "201", role: "admin", name: "Asha Admin" },
    super: { id: "202", role: "super_admin", name: "Sam Super" },
    teacher: { id: "301", role: "teacher", name: "Tara Teacher" },
    student: { id: "401", role: "student", name: "Ravi Student" },
    student2: { id: "402", role: "student", name: "Meena Student" },
  };

  beforeEach(async () => {
    harness = createTestHarness();
    for (const [key, u] of Object.entries(USERS)) {
      harness.support.usersByRole[u.role] = [...(harness.support.usersByRole[u.role] ?? []), u.id];
      harness.support.userNames[u.id] = u.name;
      const session = await harness.sessions.create({ userId: u.id, refreshTokenHash: Buffer.alloc(64, 7).toString("hex"), ipAddress: "127.0.0.1", expiresAt: new Date(Date.now() + 3600000).toISOString() });
      tokens[key] = issueAccessToken({ userId: u.id, role: u.role, sessionId: session.sessionId }).token;
    }
    const authenticate = createAuthenticate({ studentAccess: null, sessions: () => harness.sessions });
    server = await startServer(createApp({ container: harness.container, authenticate }));
  });

  afterEach(async () => {
    await server.close();
  });

  // ---------------------------------------------------------------- COM-010
  it("lets a student and an Admin exchange messages, with read state and staff audit (COM-010)", async () => {
    const contacts = (await json(await server.get("/api/v1/support/messages/contacts", auth("student"))))["data"];
    assert.deepEqual(contacts.map((c: any) => c.userId).sort(), ["201", "202"]);

    const sent = await server.post("/api/v1/support/messages", { recipientUserId: "201", body: "When does the next batch start?" }, auth("student"));
    assert.equal(sent.status, 201);
    assert.equal(harness.support.auditLogs.filter((a) => a.actionType === "SEND_MESSAGE").length, 0, "a student's own message is not an Admin action");

    const inbox = (await json(await server.get("/api/v1/support/messages/conversations", auth("admin"))))["data"];
    assert.deepEqual(inbox.map((c: any) => [c.userId, c.name, c.unreadCount]), [["401", "Ravi Student", 1]]);

    const thread = (await json(await server.get("/api/v1/support/messages/conversations/401", auth("admin"))))["data"];
    assert.equal(thread.length, 1);
    assert.equal((await json(await server.post("/api/v1/support/messages/conversations/401/read", {}, auth("admin"))))["data"].marked, 1);
    assert.equal((await json(await server.post("/api/v1/support/messages/conversations/401/read", {}, auth("admin"))))["data"].marked, 0, "nothing left to mark");

    assert.equal((await server.post("/api/v1/support/messages", { recipientUserId: "401", body: "It starts on 1 December." }, auth("admin"))).status, 201);
    const audit = harness.support.auditLogs.filter((a) => a.actionType === "SEND_MESSAGE");
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.actorUserId, "201");
    assert.doesNotMatch(JSON.stringify(audit[0]), /1 December/, "message text stays out of the audit log");

    const studentView = (await json(await server.get("/api/v1/support/messages/conversations/201", auth("student"))))["data"];
    assert.deepEqual(studentView.map((m: any) => m.senderUserId), ["401", "201"]);
    const outsider = (await json(await server.get("/api/v1/support/messages/conversations/201", auth("student2"))))["data"];
    assert.deepEqual(outsider, [], "another student cannot read this conversation");
  });

  it("refuses messages outside student <-> Admin pairs, to inactive users, and invalid input (COM-010)", async () => {
    assert.equal((await server.post("/api/v1/support/messages", { recipientUserId: "402", body: "hi" }, auth("student"))).status, 403);
    assert.equal((await server.post("/api/v1/support/messages", { recipientUserId: "401", body: "hi" }, auth("teacher"))).status, 403);
    assert.equal((await server.post("/api/v1/support/messages", { recipientUserId: "202", body: "hi" }, auth("admin"))).status, 403, "staff to staff is not this channel");
    harness.support.inactiveUserIds.add("202");
    assert.equal((await server.post("/api/v1/support/messages", { recipientUserId: "202", body: "hi" }, auth("student"))).status, 422);
    for (const body of [{ recipientUserId: "201", body: "   " }, { recipientUserId: "abc", body: "hi" }, { recipientUserId: "201", body: "hi", attachment: "x.pdf" }, { recipientUserId: "201", body: "x".repeat(4001) }]) {
      assert.equal((await server.post("/api/v1/support/messages", body, auth("student"))).status, 422, JSON.stringify(body).slice(0, 60));
    }
    assert.equal((await server.post("/api/v1/support/messages", { recipientUserId: "401", body: "hi" }, auth("student"))).status, 422, "not to yourself");
    assert.equal((await server.get("/api/v1/support/messages/conversations")).status, 401);
    assert.equal(harness.support.messages.length, 0);
  });

  // ---------------------------------------------------------------- SEC audit: single notification send
  it("audits a single notification sent by an Admin", async () => {
    const res = await server.post("/api/v1/support/notifications/send", { recipientUserId: "401", title: "Fee reminder", messageBody: "Your fee is due." }, auth("admin"));
    assert.equal(res.status, 201);
    const a = harness.support.auditLogs.filter((x) => x.actionType === "SEND_NOTIFICATION");
    assert.equal(a.length, 1);
    assert.equal(a[0]!.actorUserId, "201");
  });

  // ---------------------------------------------------------------- PUB-006
  it("links trainer profiles to real courses and shows only published ones publicly (PUB-006)", async () => {
    const mk = async (slug: string, title: string, published: boolean) => {
      const c = await harness.courses.create({ slug, title, shortDescription: "x", longDescription: "x", durationWeeks: 8, feeINR: 30000, level: "Beginner", prerequisites: [], learningOutcomes: [] } as never);
      if (published) harness.courses.seed({ ...(c as Course), isPublished: true, status: "Published" } as Course);
      return c.id;
    };
    const java = await mk("java-fs", "Full Stack Java", true);
    const draft = await mk("ai-draft", "AI Engineering", false);

    const trainer = { name: "Dr. Vikram", role: "Architect", specialization: "Cloud", bio: "Twelve years of cloud.", courseIds: [java, draft], coursesTaught: ["free text is ignored"] };
    const saved = await server.post("/api/v1/admin/cms/trainers", trainer, auth("admin"));
    assert.equal(saved.status, 200);
    const s = (await json(saved))["data"];
    assert.deepEqual(s.coursesTaught, ["Full Stack Java", "AI Engineering"], "titles come from the linked courses");
    assert.deepEqual(s.courseIds, [java, draft]);

    await server.put(`/api/v1/admin/cms/trainers/${s.id}`, { ...trainer, courseIds: [java, draft], isActive: true }, auth("admin"));
    const pub = (await json(await server.get("/api/v1/public/trainers")))["data"];
    assert.deepEqual(pub[0].coursesTaught, ["Full Stack Java"], "unpublished courses are not shown publicly");
    assert.deepEqual(pub[0].linkedCourses, [{ id: java, title: "Full Stack Java", slug: "java-fs" }]);
    assert.equal("courseIds" in pub[0], false);

    const bad = await server.post("/api/v1/admin/cms/trainers", { ...trainer, courseIds: ["999999"] }, auth("admin"));
    assert.equal(bad.status, 422);
    assert.match((await json(bad))["details"][0].message, /999999/);
    assert.equal((await server.post("/api/v1/admin/cms/trainers", { ...trainer, courseIds: ["java"] }, auth("admin"))).status, 422);
  });

  // ---------------------------------------------------------------- prerequisites (public)
  it("lists real prerequisite courses on the public course page", async () => {
    const base = await harness.courses.create({ slug: "java-core", title: "Core Java", shortDescription: "x", longDescription: "x", durationWeeks: 8, feeINR: 1, level: "Beginner", prerequisites: [], learningOutcomes: [] } as never);
    const adv = await harness.courses.create({ slug: "java-adv", title: "Advanced Java", shortDescription: "x", longDescription: "x", durationWeeks: 8, feeINR: 1, level: "Intermediate", prerequisites: [], learningOutcomes: [] } as never);
    harness.courses.seed({ ...(adv as Course), isPublished: true, status: "Published" } as Course);
    await harness.courses.replacePrerequisites(adv.id, [base.id]);
    const res = (await json(await server.get("/api/v1/courses/java-adv")))["data"];
    assert.deepEqual(res.prerequisites, ["Core Java"]);
  });

  // ---------------------------------------------------------------- ASM-012
  it("shows Admins every evaluation version of a submission (ASM-012)", async () => {
    const a = harness.academics as any;
    a.assignments.push({ id: "71", courseId: "11", title: "Saga pattern", maximumMarks: 50, createdByTeacherUserId: "301" });
    a.submissions.push({ id: "81", assignmentId: "71", studentUserId: "401", submissionType: "github", submissionVersion: 1, submittedAt: new Date().toISOString() });
    await server.post("/api/v1/admin/academics/assignment-submissions/81/evaluations", { marksAwarded: 30, feedback: "Good start" }, auth("admin"));
    await server.post("/api/v1/admin/academics/assignment-submissions/81/evaluations", { marksAwarded: 42, feedback: "Re-evaluated" }, auth("super"));
    const history = (await json(await server.get("/api/v1/admin/academics/assignment-submissions/81/evaluations", auth("admin"))))["data"];
    assert.deepEqual(history.map((h: any) => [h.evaluationVersion, h.marksAwarded]), [[2, 42], [1, 30]], "earlier versions are kept");
    assert.equal((await server.get("/api/v1/admin/academics/assignment-submissions/999/evaluations", auth("admin"))).status, 404);
    assert.equal((await server.get("/api/v1/admin/academics/assignment-submissions/81/evaluations", auth("teacher"))).status, 403);
  });
});

// ---------------------------------------------------------------- service-level no-op audit
describe("Admin status changes that change nothing are not audited", () => {
  it("skips the write and the audit for an unchanged batch status", async () => {
    const harness = createTestHarness();
    harness.admin.batches.push({ id: "5", courseId: "11", batchCode: "FS-01", batchName: "Full Stack 1", status: "ongoing" } as never);
    const service = createAdminService({ admin: harness.admin });
    const before = harness.admin.auditLogs.length;
    await service.setBatchStatus("201", "5", "ongoing" as never);
    assert.equal(harness.admin.auditLogs.length, before);
    await service.setBatchStatus("201", "5", "completed" as never);
    assert.equal(harness.admin.auditLogs.length, before + 1);
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
        return { recordset: (res as any)?.recordset ?? [], rowsAffected: (res as any)?.rowsAffected ?? [1] };
      },
    };
    return r;
  };
  const pool = { request, transaction: () => ({ begin: async () => {}, commit: async () => void state.committed++, rollback: async () => void state.rolledBack++, request }) } as unknown as sql.ConnectionPool;
  return { seen, state, pool };
};

describe("SQL adapters for 10B (mock pool)", () => {
  it("writes the next evaluation version with an audit row, and refuses unallocated teachers and out-of-range marks (ASM-012)", async () => {
    const row = { AssignmentSubmissionId: 81, AssignmentId: 71, StudentUserId: 401, SubmissionType: "GITHUB", SubmissionStatus: "EVALUATED", SubmittedAt: new Date(), MarksAwarded: 40, Feedback: "ok", EvaluatedAt: new Date() };
    const ok = mockPool((q) => (q.includes("AS Allowed") ? { recordset: [{ MaximumMarks: 50, NextVersion: 3, Allowed: 1 }] } : { recordset: [row] }));
    const res = await new SqlServerTeacherRepository(ok.pool).evaluateSubmission("81", "301", 40, "ok");
    assert.equal(res.assignmentId, "71", "the real record is returned, not placeholders");
    const ins = ok.seen.find((s) => s.q.includes("INSERT INTO dbo.NXA_EvaluationRecords"))!;
    assert.equal(ins.inputs["version"], 3);
    assert.ok(ok.seen.some((s) => s.q.includes("INSERT INTO dbo.NXA_AuditLogs")));
    assert.equal(ok.state.committed, 1);

    const denied = mockPool(() => ({ recordset: [{ MaximumMarks: 50, NextVersion: 1, Allowed: 0 }] }));
    await assert.rejects(new SqlServerTeacherRepository(denied.pool).evaluateSubmission("81", "399", 10), (e: Error) => e.name === "TeacherAccessError");
    assert.equal(denied.state.rolledBack, 1);
    const tooHigh = mockPool(() => ({ recordset: [{ MaximumMarks: 50, NextVersion: 1, Allowed: 1 }] }));
    await assert.rejects(new SqlServerTeacherRepository(tooHigh.pool).evaluateSubmission("81", "301", 51), (e: Error) => e.name === "TeacherRuleError");
    assert.equal(tooHigh.seen.filter((s) => s.q.includes("INSERT")).length, 0);
  });

  it("lists every evaluation version newest first (ASM-012)", async () => {
    const m = mockPool((q) => (q.includes("SELECT 1 AS x") ? { recordset: [{ x: 1 }] } : { recordset: [{ EvaluationRecordId: 9, EvaluationVersion: 2, MarksAwarded: 42, Feedback: null, EvaluatedByUserId: 202, EvaluatedByName: "Sam", EvaluatedAt: new Date() }] }));
    const h = await new SqlServerAcademicsRepository(async () => m.pool).listEvaluations("81");
    assert.equal(h[0]!.evaluatedByName, "Sam");
    assert.match(m.seen[1]!.q, /ORDER BY er\.EvaluationVersion DESC/);
  });

  it("checks the student <-> Admin pair and audits a staff message without its text (COM-010)", async () => {
    const pair = (over: Record<string, number>) => ({ RecipientActive: 1, SenderStaff: 1, SenderStudent: 0, RecipientStaff: 0, RecipientStudent: 1, ...over });
    const ok = mockPool((q) => {
      if (q.includes("AS RecipientActive")) return { recordset: [pair({})] };
      if (q.includes("INSERT INTO dbo.NXA_Messages")) return { recordset: [{ MessageId: 1, SenderUserId: 201, RecipientUserId: 401, MessageBody: "secret plan", SentAt: new Date(), ReadAt: null }] };
      return { recordset: [{ AuditLogId: 1 }] };
    });
    const msg = await new SqlServerSupportRepository(async () => ok.pool).sendMessage("201", "401", "secret plan", true);
    assert.equal(msg.id, "1");
    const audit = ok.seen.find((s) => s.q.includes("INSERT INTO dbo.NXA_AuditLogs"))!;
    assert.equal(audit.inputs["action"], "SEND_MESSAGE");
    assert.doesNotMatch(String(audit.inputs["newVal"]), /secret plan/);

    const studentToStudent = mockPool(() => ({ recordset: [pair({ SenderStaff: 0, SenderStudent: 1, RecipientStaff: 0, RecipientStudent: 1 })] }));
    await assert.rejects(new SqlServerSupportRepository(async () => studentToStudent.pool).sendMessage("401", "402", "hi", false), (e: any) => e.code === "MESSAGING_NOT_ALLOWED" && e.status === 403);
    assert.equal(studentToStudent.state.rolledBack, 1);
    assert.equal(studentToStudent.seen.filter((s) => s.q.includes("INSERT")).length, 0);
  });

  it("marks only messages addressed to the caller as read (COM-010)", async () => {
    const m = mockPool(() => ({ recordset: [], rowsAffected: [2] }));
    assert.equal(await new SqlServerSupportRepository(async () => m.pool).markConversationRead("201", "401"), 2);
    assert.match(m.seen[0]!.q, /WHERE RecipientUserId = @Me AND SenderUserId = @Other AND ReadAt IS NULL/);
  });
});
