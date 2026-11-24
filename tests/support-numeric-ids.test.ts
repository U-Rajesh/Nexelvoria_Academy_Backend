import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type sql from "mssql";

import { createApp } from "../src/app";
import { createAuthenticate } from "../src/middleware/authenticate.middleware";
import { issueAccessToken } from "../src/modules/auth/token.service";
import { SqlServerSupportRepository } from "../src/modules/support/sqlserver-support.repository";
import { SqlServerTeacherRepository } from "../src/modules/teachers/sqlserver-teacher.repository";
import { createTestHarness, type TestHarness } from "./fakes";
import { startServer, type TestServer } from "./helpers/server";

/**
 * Batch 3 item 1: support / notifications and the teacher repository against
 * the live schema. Every support id is a database identity (BIGINT, or INT for
 * categories) - never an application-generated GUID - and NXA_Users has no
 * AvatarUrl or Role column (roles live in NXA_UserRoles -> NXA_Roles).
 */

type Handler = (q: string, inputs: Record<string, unknown>) => unknown;

class MockSqlRequest {
  inputs: Record<string, unknown> = {};
  types: Record<string, unknown> = {};
  constructor(private readonly handler: Handler, private readonly log: Array<{ q: string; inputs: Record<string, unknown>; types: Record<string, unknown> }>) {}
  input(name: string, typeOrValue: unknown, value?: unknown): this {
    if (value !== undefined || arguments.length === 3) {
      this.types[name] = typeOrValue;
      this.inputs[name] = value;
    } else {
      this.inputs[name] = typeOrValue;
    }
    return this;
  }
  async query<T = unknown>(command: string): Promise<{ recordset: T[]; rowsAffected: number[] }> {
    this.log.push({ q: command, inputs: { ...this.inputs }, types: { ...this.types } });
    const res = this.handler(command, this.inputs);
    if (res instanceof Error) throw res;
    const r = (res ?? {}) as { recordset?: T[]; rowsAffected?: number[] };
    return { recordset: r.recordset ?? [], rowsAffected: r.rowsAffected ?? [1] };
  }
}

const tracked = (handler: Handler) => {
  const state = { began: 0, committed: false, rolledBack: false };
  const seen: Array<{ q: string; inputs: Record<string, unknown>; types: Record<string, unknown> }> = [];
  const pool = {
    request: () => new MockSqlRequest(handler, seen),
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
      request: () => new MockSqlRequest(handler, seen),
    }),
  } as unknown as sql.ConnectionPool;
  const writes = () => seen.filter((s) => /\b(INSERT|UPDATE|DELETE|MERGE)\b/.test(s.q));
  return { state, seen, writes, pool, repo: new SqlServerSupportRepository(async () => pool) };
};

const sqlError = (num: number): Error => Object.assign(new Error(`SQL error ${num}`), { number: num });
const fail = (needle: string) => (q: string) => (q.includes(needle) ? new Error(`${needle} failed`) : undefined);

const ticketRow = (over: Record<string, unknown> = {}) => ({
  SupportTicketId: 501, TicketNumber: "TCK-ABC", StudentUserId: 301, StudentName: "Asha", CategoryId: 3, CategoryName: "Technical",
  Subject: "Course access", Description: "Cannot open lesson 3", Priority: "medium", TicketStatus: "open",
  AssignedToUserId: null, CreatedAt: new Date(), ClosedAt: null, ...over,
});

describe("no GUID ids or nonexistent columns remain", () => {
  const src = (p: string) => fs.readFileSync(path.join(__dirname, "..", "src", "modules", p), "utf8");
  it("support repository uses no UniqueIdentifier parameters or generated ids", () => {
    const s = src("support/sqlserver-support.repository.ts");
    assert.doesNotMatch(s, /sql\.UniqueIdentifier/);
    assert.doesNotMatch(s, /randomUUID/);
    // No identity column is ever supplied on insert.
    assert.doesNotMatch(
      s,
      /NXA_SupportTickets \(\s*SupportTicketId|NXA_TicketReplies \(\s*TicketReplyId|NXA_Notifications \(\s*NotificationId|NXA_AuditLogs \(\s*AuditLogId/,
    );
  });
  it("teacher repository references neither NXA_Users.AvatarUrl nor NXA_Users.Role", () => {
    const s = src("teachers/sqlserver-teacher.repository.ts");
    assert.doesNotMatch(s, /AvatarUrl/);
    assert.doesNotMatch(s, /u\.Role\b/);
    assert.doesNotMatch(s, /INSERT INTO dbo\.NXA_Users \([^)]*\bRole\b/);
  });
});

describe("SqlServerSupportRepository: tickets", () => {
  const handler = (over: { category?: unknown[]; extra?: (q: string) => unknown } = {}): Handler => (q) => {
    const x = over.extra?.(q);
    if (x !== undefined) return x;
    if (q.includes("FROM dbo.NXA_SupportTicketCategories WHERE")) return { recordset: over.category ?? [{ SupportTicketCategoryId: 3 }] };
    if (q.includes("INSERT INTO dbo.NXA_SupportTickets")) return { recordset: [{ SupportTicketId: 501 }] };
    if (q.includes("FROM dbo.NXA_SupportTickets t")) return { recordset: [ticketRow()] };
    return { recordset: [] };
  };
  const input = { ticketNumber: "TCK-ABC", studentUserId: "301", categoryId: "3", subject: "Course access", description: "Cannot open lesson 3", priority: "medium" as const, ticketStatus: "open" as const };

  it("creates a ticket with a database id, numeric parameters and a first status-history row", async () => {
    const t = tracked(handler());
    const ticket = await t.repo.createTicket(input);
    assert.ok(t.state.committed);
    const ins = t.writes().find((w) => w.q.includes("INSERT INTO dbo.NXA_SupportTickets"))!;
    assert.match(ins.q, /\(TicketNumber, StudentUserId, CategoryId, Subject, Description, Priority, TicketStatus, CreatedAt\)/);
    assert.equal(ins.inputs["StudentUserId"], "301");
    assert.equal(ins.inputs["CategoryId"], "3");
    const hist = t.writes().find((w) => w.q.includes("NXA_SupportTicketStatusHistory"))!;
    assert.equal(hist.inputs["Previous"], null);
    assert.equal(hist.inputs["Next"], "open");
    assert.equal(hist.inputs["TicketId"], "501");
    assert.equal(ticket.id, "501");
    assert.equal(ticket.categoryName, "Technical");
  });

  it("refuses an unknown or inactive category and writes nothing", async () => {
    const t = tracked(handler({ category: [] }));
    await assert.rejects(t.repo.createTicket(input), (e: Error & { code?: string }) => e.code === "CATEGORY_NOT_FOUND");
    assert.ok(t.state.rolledBack);
    assert.equal(t.writes().length, 0);
    const textual = tracked(handler());
    await assert.rejects(textual.repo.createTicket({ ...input, categoryId: "academic_help" }), (e: Error & { code?: string }) => e.code === "CATEGORY_NOT_FOUND");
    assert.equal(textual.state.began, 0);
  });

  it("maps a ticket-number collision to DuplicateRecordError and rolls back when history fails", async () => {
    const dup = tracked(handler({ extra: (q) => (q.includes("INSERT INTO dbo.NXA_SupportTickets") ? sqlError(2627) : undefined) }));
    await assert.rejects(dup.repo.createTicket(input), (e: Error) => e.name === "DuplicateRecordError");
    const hist = tracked(handler({ extra: fail("NXA_SupportTicketStatusHistory") }));
    await assert.rejects(hist.repo.createTicket(input), /failed/);
    assert.ok(hist.state.rolledBack && !hist.state.committed);
  });

  it("finds nothing for non-numeric ids without querying", async () => {
    const t = tracked(handler());
    assert.equal(await t.repo.getTicketById("abc-uuid"), null);
    assert.deepEqual(await t.repo.getTicketsByStudent("student-1"), []);
    assert.deepEqual(await t.repo.getAllTickets({ category: "tech" }), []);
    assert.equal(t.seen.length, 0);
  });
});

describe("SqlServerSupportRepository: status changes and replies", () => {
  const handler = (current: Record<string, unknown>, extra?: (q: string) => unknown): Handler => (q) => {
    const x = extra?.(q);
    if (x !== undefined) return x;
    if (q.includes("FROM dbo.NXA_SupportTickets WITH (UPDLOCK, HOLDLOCK)")) return { recordset: [current] };
    if (q.includes("LOWER(r.RoleCode) IN ('admin', 'super_admin')")) return { recordset: [{ x: 1 }] };
    if (q.includes("INSERT INTO dbo.NXA_TicketReplies")) return { recordset: [{ TicketReplyId: 601 }] };
    if (q.includes("FROM dbo.NXA_TicketReplies r")) {
      return { recordset: [{ TicketReplyId: 601, SupportTicketId: 501, RepliedByUserId: 7, ReplyText: "Fixed", IsInternal: false, RepliedAt: new Date() }] };
    }
    if (q.includes("FROM dbo.NXA_SupportTickets t")) return { recordset: [ticketRow({ TicketStatus: "resolved" })] };
    return { recordset: [] };
  };

  it("records status, history (with actor) and audit in one transaction", async () => {
    const t = tracked(handler({ TicketStatus: "in_progress", AssignedToUserId: null }));
    await t.repo.updateTicketStatus("501", "resolved", "7", "8");
    assert.ok(t.state.committed);
    const upd = t.writes().find((w) => w.q.includes("UPDATE dbo.NXA_SupportTickets"))!;
    assert.match(upd.q, /ClosedAt = COALESCE\(ClosedAt, SYSUTCDATETIME\(\)\)/);
    assert.equal(upd.inputs["Assignee"], "8");
    const hist = t.writes().find((w) => w.q.includes("NXA_SupportTicketStatusHistory"))!;
    assert.deepEqual([hist.inputs["Previous"], hist.inputs["Next"], hist.inputs["ChangedBy"]], ["in_progress", "resolved", "7"]);
    const audit = t.writes().find((w) => w.q.includes("NXA_AuditLogs"))!;
    assert.equal(audit.inputs["action"], "UPDATE_SUPPORT_TICKET");
  });

  it("clears ClosedAt when a ticket is reopened", async () => {
    const t = tracked(handler({ TicketStatus: "closed", AssignedToUserId: null }));
    await t.repo.updateTicketStatus("501", "open", "7");
    assert.match(t.writes().find((w) => w.q.includes("UPDATE dbo.NXA_SupportTickets"))!.q, /ClosedAt = NULL/);
  });

  it("writes nothing for an unchanged status and assignee", async () => {
    const t = tracked(handler({ TicketStatus: "RESOLVED", AssignedToUserId: 8 }));
    await t.repo.updateTicketStatus("501", "resolved", "7", "8");
    assert.equal(t.writes().length, 0);
  });

  it("refuses an assignee who is not Admin / Super Admin, an unknown ticket, and rolls back a failed history write", async () => {
    const notStaff = tracked(handler({ TicketStatus: "open" }, (q) => (q.includes("LOWER(r.RoleCode) IN") ? { recordset: [] } : undefined)));
    await assert.rejects(notStaff.repo.updateTicketStatus("501", "in_progress", "7", "301"), (e: Error & { code?: string }) => e.code === "ASSIGNEE_NOT_STAFF");
    assert.equal(notStaff.writes().length, 0);
    await assert.rejects(tracked(handler({})).repo.updateTicketStatus("501", "open", "7", "staff-1"), (e: Error & { code?: string }) => e.code === "ASSIGNEE_NOT_STAFF");

    const missing = tracked((q) => (q.includes("UPDLOCK") ? { recordset: [] } : { recordset: [] }));
    await assert.rejects(missing.repo.updateTicketStatus("999", "closed", "7"), (e: Error) => e.name === "RecordNotFoundError");

    const histFail = tracked(handler({ TicketStatus: "open" }, fail("NXA_SupportTicketStatusHistory")));
    await assert.rejects(histFail.repo.updateTicketStatus("501", "resolved", "7"), /failed/);
    assert.ok(histFail.state.rolledBack && !histFail.state.committed);
  });

  it("a staff reply to an open ticket inserts the reply and moves it to in_progress atomically", async () => {
    const t = tracked(handler({ TicketStatus: "open" }));
    const reply = await t.repo.addReply({ ticketId: "501", repliedByUserId: "7", replyText: "Fixed", isInternal: false }, { staffReply: true });
    assert.equal(reply.id, "601");
    const ins = t.writes().find((w) => w.q.includes("INSERT INTO dbo.NXA_TicketReplies"))!;
    assert.match(ins.q, /\(SupportTicketId, RepliedByUserId, ReplyText, AttachmentObjectKey, IsInternal, RepliedAt\)/);
    assert.ok(t.writes().some((w) => w.q.includes("SET TicketStatus = 'in_progress'")));
    assert.ok(t.writes().some((w) => w.q.includes("NXA_SupportTicketStatusHistory")));
    assert.ok(t.state.committed);

    const student = tracked(handler({ TicketStatus: "open" }));
    await student.repo.addReply({ ticketId: "501", repliedByUserId: "301", replyText: "Thanks", isInternal: false }, { staffReply: false });
    assert.equal(student.writes().filter((w) => w.q.includes("UPDATE")).length, 0);

    const failing = tracked(handler({ TicketStatus: "open" }, fail("SET TicketStatus = 'in_progress'")));
    await assert.rejects(failing.repo.addReply({ ticketId: "501", repliedByUserId: "7", replyText: "Fixed", isInternal: false }, { staffReply: true }), /failed/);
    assert.ok(failing.state.rolledBack && !failing.state.committed, "the reply is not kept without its status change");
  });
});

describe("SqlServerSupportRepository: notifications, audit and settings", () => {
  it("creates a notification with a database id and a numeric related entity", async () => {
    const t = tracked(() => ({ recordset: [{ NotificationId: 901, RecipientUserId: 301, NotificationType: "system", Title: "Hi", MessageBody: "Body text", Priority: "normal", CreatedAt: new Date(), RelatedEntityId: 501 }] }));
    const n = await t.repo.createNotification({ recipientUserId: "301", notificationType: "system", title: "Hi", messageBody: "Body text", priority: "normal", relatedEntityId: "501", relatedEntityType: "SupportTicket" });
    assert.match(t.seen[0]!.q, /\(\s*RecipientUserId, NotificationType, Title, MessageBody, Priority, RelatedEntityId, RelatedEntityType, CreatedAt\s*\)/);
    assert.equal(t.seen[0]!.inputs["RelatedEntityId"], "501");
    assert.equal(n.id, "901");
    assert.equal(n.relatedEntityId, "501");

    const nonNumeric = tracked(() => ({ recordset: [{ NotificationId: 902, RecipientUserId: 301, CreatedAt: new Date() }] }));
    await nonNumeric.repo.createNotification({ recipientUserId: "301", notificationType: "system", title: "Hi", messageBody: "Body text", priority: "normal", relatedEntityId: "TCK-1" });
    assert.equal(nonNumeric.seen[0]!.inputs["RelatedEntityId"], null);
  });

  it("reports a missing recipient instead of failing", async () => {
    const fk = tracked(() => sqlError(547));
    await assert.rejects(fk.repo.createNotification({ recipientUserId: "999", notificationType: "system", title: "Hi", messageBody: "Body", priority: "normal" }), (e: Error & { code?: string }) => e.code === "RECIPIENT_NOT_FOUND");
    const text = tracked(() => ({ recordset: [] }));
    await assert.rejects(text.repo.createNotification({ recipientUserId: "student-1", notificationType: "system", title: "Hi", messageBody: "Body", priority: "normal" }), (e: Error & { code?: string }) => e.code === "RECIPIENT_NOT_FOUND");
    assert.equal(text.seen.length, 0);
  });

  it("broadcasts in one set-based statement to the audience roles, audited, with the real count", async () => {
    const t = tracked((q) => (q.includes("INSERT INTO dbo.NXA_Notifications") ? { recordset: [], rowsAffected: [42] } : { recordset: [] }));
    const r = await t.repo.broadcastNotification(["student", "teacher", "student"], { notificationType: "announcement", title: "Holiday", messageBody: "Closed on Monday", priority: "normal" }, "7");
    assert.equal(r.recipientCount, 42);
    const ins = t.writes().find((w) => w.q.includes("INSERT INTO dbo.NXA_Notifications"))!;
    assert.match(ins.q, /SELECT u\.UserId, @NotificationType/);
    assert.match(ins.q, /u\.DeletedAt IS NULL/);
    assert.match(ins.q, /LOWER\(r\.RoleCode\) IN \(@role0, @role1\)/, "duplicate roles are collapsed");
    const audit = t.writes().find((w) => w.q.includes("NXA_AuditLogs"))!;
    assert.match(String(audit.inputs["newVal"]), /"recipientCount":42/);
    assert.ok(t.state.committed);

    const failing = tracked((q) => (q.includes("NXA_AuditLogs") ? new Error("audit failed") : { recordset: [], rowsAffected: [5] }));
    await assert.rejects(failing.repo.broadcastNotification(["student"], { notificationType: "announcement", title: "x", messageBody: "yyyyy", priority: "normal" }, "7"), /audit failed/);
    assert.ok(failing.state.rolledBack && !failing.state.committed, "no notifications without the audit record");
  });

  it("marks only the caller's own notification as read", async () => {
    const t = tracked(() => ({ recordset: [], rowsAffected: [0] }));
    assert.equal(await t.repo.markNotificationAsRead("901", "302"), false);
    assert.match(t.seen[0]!.q, /WHERE NotificationId = @NotificationId AND RecipientUserId = @RecipientUserId/);
    assert.equal(await t.repo.markNotificationAsRead("not-a-number", "302"), false);
  });

  it("writes audit records with a database id and NEWID() correlation", async () => {
    const t = tracked(() => ({ recordset: [{ AuditLogId: 77, CorrelationId: "6f1d1c5e-5c2a-4c7e-9e57-0a8c1c2b3d4e", CreatedAt: new Date() }] }));
    const a = await t.repo.createAuditLog({ moduleCode: "SUPPORT_MGMT", actionType: "X", entityName: "SupportTicket", entityId: "501", actorUserId: "7", correlationId: "caller-value" });
    assert.doesNotMatch(t.seen[0]!.q, /\(\s*AuditLogId/);
    assert.match(t.seen[0]!.q, /NEWID\(\)/);
    assert.equal(a.id, "77");
  });

  it("updates only existing settings, audits with secrets masked, and writes nothing for a no-op", async () => {
    const missing = tracked(() => ({ recordset: [] }));
    await assert.rejects(missing.repo.updateSetting("invented_key", "1", "7"), (e: Error) => e.name === "RecordNotFoundError");
    assert.equal(missing.writes().length, 0);

    const secret = tracked((q) =>
      q.includes("UPDLOCK") ? { recordset: [{ SettingValue: "old-secret", IsSecret: true }] }
        : q.includes("SELECT InstituteSettingId") ? { recordset: [{ InstituteSettingId: 1, SettingKey: "smtp_password", SettingValue: "new-secret", ValueType: "string", IsSecret: true, UpdatedAt: new Date() }] }
          : { recordset: [] },
    );
    const s = await secret.repo.updateSetting("smtp_password", "new-secret", "7");
    assert.equal(s.settingValue, "********");
    const audit = secret.writes().find((w) => w.q.includes("NXA_AuditLogs"))!;
    assert.doesNotMatch(String(audit.inputs["oldVal"]) + String(audit.inputs["newVal"]), /secret/);

    const same = tracked((q) => (q.includes("UPDLOCK") ? { recordset: [{ SettingValue: "x", IsSecret: false }] } : { recordset: [{ InstituteSettingId: 1, SettingKey: "k", SettingValue: "x", ValueType: "string", IsSecret: false, UpdatedAt: new Date() }] }));
    await same.repo.updateSetting("k", "x", "7");
    assert.equal(same.writes().length, 0);
  });
});

describe("SqlServerTeacherRepository: role via NXA_UserRoles, no invented values", () => {
  const row = {
    UserId: 401, FullName: "Ravi Kumar", Email: "ravi@x.test", MobileNumber: "9000000001", AccountStatus: "active", UserCreatedAt: new Date(),
    TeacherProfileId: 1, Specialization: null, ExperienceYears: 6, Qualification: "M.Tech", Bio: null, IsActive: true,
    AssignedCourseIds: "5,6", AssignedBatchIds: "101",
  };

  it("lists teachers by role membership and maps only stored values", async () => {
    const seen: string[] = [];
    const pool = {
      request: () => {
        const r = new MockSqlRequest((q) => (q.includes("COUNT(1) AS total") ? { recordset: [{ total: 1 }] } : { recordset: [row] }), []);
        const original = r.query.bind(r);
        r.query = async <T,>(q: string) => {
          seen.push(q);
          return original<T>(q);
        };
        return r;
      },
    } as unknown as sql.ConnectionPool;
    const repo = new SqlServerTeacherRepository(pool);
    const page = await repo.findMany({}, { page: 1, pageSize: 20 });
    for (const q of seen) {
      assert.match(q, /JOIN dbo\.NXA_Roles r ON r\.RoleId = ur\.RoleId/);
      assert.match(q, /LOWER\(r\.RoleCode\) = 'teacher'/);
      assert.match(q, /u\.DeletedAt IS NULL/);
      assert.doesNotMatch(q, /AvatarUrl|u\.Role\b/);
    }
    const t = page.items[0]!;
    assert.equal(t.id, "401");
    assert.equal(t.specialization, "", "no 'General' placeholder");
    assert.equal(t.rating, undefined, "no invented rating");
    assert.equal("avatarUrl" in t, false);
    assert.deepEqual(t.assignedCourseIds, ["5", "6"]);
  });

  it("finds a teacher by id or email only when the user holds the teacher role", async () => {
    const seen: string[] = [];
    const pool = {
      request: () => new MockSqlRequest((q) => {
        seen.push(q);
        return { recordset: [] };
      }, []),
    } as unknown as sql.ConnectionPool;
    const repo = new SqlServerTeacherRepository(pool);
    assert.equal(await repo.findById("301"), null);
    assert.equal(await repo.findByEmail("Student@X.test"), null);
    assert.match(seen[0]!, /WHERE u\.UserId = @userId AND u\.DeletedAt IS NULL AND EXISTS/);
    assert.match(seen[1]!, /WHERE u\.NormalizedEmail = @email/);
  });

  it("refuses to create a teacher outside the Admin flow, without touching the database", async () => {
    let queried = false;
    const pool = { request: () => new MockSqlRequest(() => { queried = true; return { recordset: [] }; }, []), transaction: () => { queried = true; } } as unknown as sql.ConnectionPool;
    await assert.rejects(
      new SqlServerTeacherRepository(pool).create({ name: "X", email: "x@x.test", mobile: "9000000002" } as Parameters<SqlServerTeacherRepository["create"]>[0]),
      /POST \/admin\/teachers/,
    );
    assert.equal(queried, false);
  });
});

describe("support endpoints: categories, tickets, replies, notifications and authorization", () => {
  let harness: TestHarness;
  let server: TestServer;
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const auth = (role: string) => ({ headers: { Authorization: `Bearer ${tokens[role]}`, "Content-Type": "application/json" } });
  const json = async (res: Response) => (await res.json()) as Record<string, any>;

  beforeEach(async () => {
    harness = createTestHarness();
    let seq = 50;
    for (const role of ["admin", "super_admin", "teacher", "student", "student2"] as const) {
      seq++;
      const realRole = role === "student2" ? "student" : role;
      const user = await harness.users.create({ name: `${role} User`, email: `${role}-${seq}@test.local`, mobile: `98765432${seq}`, role: realRole, status: "active" });
      const session = await harness.sessions.create({
        userId: user.id,
        refreshTokenHash: Buffer.alloc(64, 1).toString("hex"),
        ipAddress: "127.0.0.1",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
      tokens[role] = issueAccessToken({ userId: user.id, role: realRole, sessionId: session.sessionId }).token;
      ids[role] = user.id;
    }
    harness.support.categories.push({ id: "3", name: "Technical", isActive: true }, { id: "4", name: "Old", isActive: false });
    harness.support.usersByRole = { student: [ids["student"]!, ids["student2"]!], teacher: [ids["teacher"]!], admin: [ids["admin"]!], super_admin: [ids["super_admin"]!] };
    const authenticate = createAuthenticate({ studentAccess: null, sessions: () => harness.sessions });
    server = await startServer(createApp({ container: harness.container, authenticate }));
  });

  afterEach(async () => {
    await server.close();
  });

  const createTicket = (categoryId: unknown = "3", role = "student") =>
    server.post("/api/v1/support/tickets", { categoryId, subject: "Course access", description: "Cannot open lesson 3 at all" }, auth(role));

  it("lists active categories and creates tickets only in an active category", async () => {
    const cats = await json(await server.get("/api/v1/support/categories", auth("student")));
    assert.deepEqual(cats["data"], [{ id: "3", name: "Technical" }]);
    assert.equal((await createTicket("academic_help")).status, 422);
    assert.equal((await createTicket("4")).status, 422, "inactive category");
    assert.equal((await createTicket("99")).status, 422);
    const ok = await createTicket(3);
    assert.equal(ok.status, 201);
    const t = (await json(ok))["data"];
    assert.match(t.id, /^\d+$/);
    assert.equal(t.categoryName, "Technical");
    assert.deepEqual(harness.support.statusHistory.map((h) => [h.previousStatus, h.newStatus]), [[null, "open"]]);
  });

  it("keeps tickets private to their owner and admin operations for Admin / Super Admin", async () => {
    const id = (await json(await createTicket()))["data"].id;
    assert.equal((await server.get(`/api/v1/support/tickets/${id}`, auth("student2"))).status, 403);
    assert.equal((await server.post(`/api/v1/support/tickets/${id}/replies`, { replyText: "hi" }, auth("student2"))).status, 403);
    for (const role of ["student", "teacher"]) {
      assert.equal((await server.get("/api/v1/support/admin/tickets", auth(role))).status, 403, role);
      assert.equal((await server.patch(`/api/v1/support/admin/tickets/${id}/status`, { status: "closed" }, auth(role))).status, 403, role);
    }
    assert.equal((await server.get("/api/v1/support/admin/tickets", auth("admin"))).status, 200);
  });

  it("records an Admin reply and status changes with history, and treats an unchanged status as a no-op", async () => {
    const id = (await json(await createTicket()))["data"].id;
    const internal = await server.post(`/api/v1/support/tickets/${id}/replies`, { replyText: "Checking logs", isInternal: true }, auth("admin"));
    assert.equal(internal.status, 201);
    const studentView = await json(await server.get(`/api/v1/support/tickets/${id}`, auth("student")));
    assert.equal(studentView["data"].replies.length, 0, "internal notes stay internal");
    assert.equal(studentView["data"].ticketStatus, "in_progress");

    const resolved = await server.patch(`/api/v1/support/admin/tickets/${id}/status`, { status: "resolved" }, auth("admin"));
    assert.equal(resolved.status, 200);
    const again = await server.patch(`/api/v1/support/admin/tickets/${id}/status`, { status: "resolved" }, auth("super_admin"));
    assert.equal(again.status, 200);
    assert.deepEqual(
      harness.support.statusHistory.map((h) => [h.previousStatus, h.newStatus, h.changedByUserId]),
      [[null, "open", ids["student"]], ["open", "in_progress", ids["admin"]], ["in_progress", "resolved", ids["admin"]]],
    );

    const notStaff = await server.patch(`/api/v1/support/admin/tickets/${id}/status`, { status: "closed", assignedToUserId: "424242" }, auth("admin"));
    assert.equal(notStaff.status, 422, "only staff can be assigned");
    assert.equal((await json(notStaff))["error"], "ASSIGNEE_NOT_STAFF");
    assert.equal((await server.patch(`/api/v1/support/admin/tickets/${id}/status`, { status: "closed", assignedToUserId: "abc" }, auth("admin"))).status, 422);
    assert.equal((await server.patch("/api/v1/support/admin/tickets/424242/status", { status: "closed" }, auth("admin"))).status, 404);
  });

  it("sends a notification and lets only the recipient mark it read", async () => {
    const sent = await server.post("/api/v1/support/notifications/send", { recipientUserId: ids["student"], title: "Ticket update", messageBody: "Your ticket was resolved." }, auth("admin"));
    assert.equal(sent.status, 201);
    const nid = (await json(sent))["data"].id;
    assert.equal((await server.patch(`/api/v1/support/notifications/${nid}/read`, {}, auth("student2"))).status, 404, "another user's notification is not found");
    assert.equal((await server.patch(`/api/v1/support/notifications/${nid}/read`, {}, auth("student"))).status, 200);
    assert.equal((await server.post("/api/v1/support/notifications/send", { recipientUserId: ids["student"], title: "x", messageBody: "yyyyy" }, auth("teacher"))).status, 403);
    assert.equal((await server.post("/api/v1/support/notifications/send", { recipientUserId: ids["student"], title: "Hi", messageBody: "Body text", relatedEntityId: "TCK-1" }, auth("admin"))).status, 422);
  });

  it("broadcasts to the chosen audience only, with the real recipient count", async () => {
    assert.equal((await server.post("/api/v1/support/notifications/broadcast", { title: "Holiday", messageBody: "Closed on Monday" }, auth("admin"))).status, 422, "audience is required");
    const res = await server.post("/api/v1/support/notifications/broadcast", { audience: ["student"], title: "Holiday", messageBody: "Closed on Monday" }, auth("admin"));
    assert.equal(res.status, 201);
    const body = await json(res);
    assert.equal(body["data"].recipientCount, 2);
    assert.deepEqual(harness.support.notifications.map((n) => n.recipientUserId).sort(), [ids["student"], ids["student2"]].sort());
    assert.ok(!harness.support.notifications.some((n) => n.recipientUserId === ids["admin"]), "the sender is not the recipient");
    assert.equal((await server.post("/api/v1/support/notifications/broadcast", { audience: ["student"], title: "x", messageBody: "yyyyy" }, auth("teacher"))).status, 403);
  });

  it("updates only existing settings (Super Admin), never inventing keys", async () => {
    harness.support.settings.push({ id: "1", settingKey: "support_email", settingValue: "help@x.test", valueType: "string", isSecret: false, updatedAt: new Date().toISOString() });
    assert.equal((await server.put("/api/v1/support/admin/system-config", { settingKey: "invented_key", settingValue: "1" }, auth("super_admin"))).status, 404);
    assert.equal(harness.support.settings.length, 1);
    assert.equal((await server.put("/api/v1/support/admin/system-config", { settingKey: "support_email", settingValue: "desk@x.test" }, auth("admin"))).status, 403);
    const ok = await server.put("/api/v1/support/admin/system-config", { settingKey: "support_email", settingValue: "desk@x.test" }, auth("super_admin"));
    assert.equal(ok.status, 200);
    assert.equal((await json(ok))["data"].settingValue, "desk@x.test");
  });
});
