import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createApp } from "../src/app";
import { createAuthenticate } from "../src/middleware/authenticate.middleware";
import { issueAccessToken } from "../src/modules/auth/token.service";
import { createTestHarness, type TestHarness } from "./fakes";
import { startServer, type TestServer } from "./helpers/server";

/**
 * Contract between the frontend Admin support / notification screens
 * (Nexelvoria_Academy_Frontend: services/adminService.ts - getTickets, getTicket,
 * replyTicket, updateTicketStatus, sendNotification, broadcastNotification) and
 * the backend. Each request body below is exactly what those functions send,
 * and each assertion checks a response field the frontend mapper reads.
 */
describe("Admin support & notification frontend contract", () => {
  let harness: TestHarness;
  let server: TestServer;
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const auth = (role: string) => ({ headers: { Authorization: `Bearer ${tokens[role]}`, "Content-Type": "application/json" } });
  const json = async (res: Response) => (await res.json()) as Record<string, any>;

  beforeEach(async () => {
    harness = createTestHarness();
    let seq = 10;
    for (const role of ["admin", "super_admin", "student"] as const) {
      seq++;
      const user = await harness.users.create({ name: `${role} User`, email: `${role}-c${seq}@test.local`, mobile: `98765400${seq}`, role, status: "active" });
      const session = await harness.sessions.create({
        userId: user.id,
        refreshTokenHash: Buffer.alloc(64, 1).toString("hex"),
        ipAddress: "127.0.0.1",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
      tokens[role] = issueAccessToken({ userId: user.id, role, sessionId: session.sessionId }).token;
      ids[role] = user.id;
    }
    harness.support.categories.push({ id: "3", name: "Technical", isActive: true });
    harness.support.usersByRole = { student: [ids["student"]!], admin: [ids["admin"]!], super_admin: [ids["super_admin"]!] };
    const authenticate = createAuthenticate({ studentAccess: null, sessions: () => harness.sessions });
    server = await startServer(createApp({ container: harness.container, authenticate }));
  });

  afterEach(async () => {
    await server.close();
  });

  const raiseTicket = async () =>
    (await json(await server.post("/api/v1/support/tickets", { categoryId: "3", subject: "Course access", description: "Cannot open lesson 3 at all" }, auth("student"))))["data"];

  for (const role of ["admin", "super_admin"]) {
    it(`${role}: list -> detail -> reply (incl. internal) -> status, with every field the frontend maps`, async () => {
      const raised = await raiseTicket();

      // adminService.getTickets(): GET /support/admin/tickets[?status=]
      const list = await json(await server.get("/api/v1/support/admin/tickets", auth(role)));
      const t = list["data"].find((x: { id: string }) => x.id === raised.id);
      // studentName / assignedToName are optional (SQL joins may return null); the frontend falls back to "User #id".
      for (const field of ["id", "ticketNumber", "studentUserId", "categoryName", "subject", "priority", "ticketStatus", "createdAt"]) {
        assert.ok(field in t, `list item has ${field}`);
      }
      assert.equal((await server.get("/api/v1/support/admin/tickets?status=open", auth(role))).status, 200);

      // adminService.replyTicket(): POST /support/tickets/:id/replies { replyText, isInternal }
      const reply = await server.post(`/api/v1/support/tickets/${raised.id}/replies`, { replyText: "Please clear the cache.", isInternal: false }, auth(role));
      assert.equal(reply.status, 201);
      assert.ok((await json(reply))["data"].id, "frontend requires data.id to confirm the reply");
      assert.equal((await server.post(`/api/v1/support/tickets/${raised.id}/replies`, { replyText: "Escalate if repeated.", isInternal: true }, auth(role))).status, 201);

      // adminService.getTicket(): GET /support/tickets/:id (staff see internal notes)
      const detail = (await json(await server.get(`/api/v1/support/tickets/${raised.id}`, auth(role))))["data"];
      assert.equal(detail.description, "Cannot open lesson 3 at all");
      assert.equal(detail.ticketStatus, "in_progress", "a staff reply picks up an open ticket");
      assert.equal(detail.replies.length, 2);
      for (const field of ["id", "repliedByUserId", "replyText", "repliedAt", "isInternal"]) assert.ok(field in detail.replies[0], `reply has ${field}`);
      const studentView = (await json(await server.get(`/api/v1/support/tickets/${raised.id}`, auth("student"))))["data"];
      assert.equal(studentView.replies.length, 1, "the student never sees the internal note");

      // adminService.updateTicketStatus(): PATCH /support/admin/tickets/:id/status { status, assignedToUserId? }
      const upd = await server.patch(`/api/v1/support/admin/tickets/${raised.id}/status`, { status: "resolved" }, auth(role));
      assert.equal(upd.status, 200);
      assert.equal((await json(upd))["data"].ticketStatus, "resolved");
    });
  }

  it("rejects what the frontend validates against: empty reply, unknown status, non-numeric assignee", async () => {
    const raised = await raiseTicket();
    assert.equal((await server.post(`/api/v1/support/tickets/${raised.id}/replies`, { replyText: "", isInternal: false }, auth("admin"))).status, 422);
    assert.equal((await server.patch(`/api/v1/support/admin/tickets/${raised.id}/status`, { status: "archived" }, auth("admin"))).status, 422);
    assert.equal((await server.patch(`/api/v1/support/admin/tickets/${raised.id}/status`, { status: "closed", assignedToUserId: "user-1" }, auth("admin"))).status, 422);
  });

  it("sendNotification(): body { recipientUserId, title, messageBody, notificationType, priority } -> data.id", async () => {
    for (const notificationType of ["announcement", "academic", "placement", "payment", "system"]) {
      const res = await server.post(
        "/api/v1/support/notifications/send",
        { recipientUserId: ids["student"], title: "Ticket update", messageBody: "Your ticket was resolved.", notificationType, priority: "normal" },
        auth("admin"),
      );
      assert.equal(res.status, 201, notificationType);
      const n = (await json(res))["data"];
      assert.ok(n.id && n.recipientUserId, "frontend requires id and recipientUserId");
    }
    // A type the old screen used ("fee", "exam", "general") is not a backend type.
    assert.equal((await server.post("/api/v1/support/notifications/send", { recipientUserId: ids["student"], title: "Hi", messageBody: "Body text", notificationType: "fee" }, auth("admin"))).status, 422);
  });

  it("broadcastNotification(): body { audience: role codes, ... } -> data.recipientCount", async () => {
    const audiences: string[][] = [["student"], ["teacher"], ["student", "teacher"], ["admin", "super_admin"], ["student", "teacher", "admin", "super_admin"]];
    for (const audience of audiences) {
      const res = await server.post(
        "/api/v1/support/notifications/broadcast",
        { audience, title: "Holiday", messageBody: "Closed on Monday", notificationType: "announcement", priority: "normal" },
        auth("super_admin"),
      );
      assert.equal(res.status, 201, audience.join(","));
      assert.equal(typeof (await json(res))["data"].recipientCount, "number");
    }
    const teachers = await json(await server.post("/api/v1/support/notifications/broadcast", { audience: ["teacher"], title: "x1", messageBody: "yyyyy", notificationType: "announcement", priority: "normal" }, auth("admin")));
    assert.equal(teachers["data"].recipientCount, 0, "zero is reported as zero, never as success to everyone");
    // The old screen's audiences ("all", "students", batch codes) are not accepted.
    assert.equal((await server.post("/api/v1/support/notifications/broadcast", { audience: ["all"], title: "x1", messageBody: "yyyyy" }, auth("admin"))).status, 422);
  });

  it("broadcast history source: /admin/activity-logs accepts the moduleCode filter the frontend sends", async () => {
    const res = await server.get("/api/v1/admin/activity-logs?moduleCode=COMMUNICATION", auth("admin"));
    assert.equal(res.status, 200);
  });

  it("students cannot use the Admin support or notification endpoints", async () => {
    const raised = await raiseTicket();
    assert.equal((await server.get("/api/v1/support/admin/tickets", auth("student"))).status, 403);
    assert.equal((await server.patch(`/api/v1/support/admin/tickets/${raised.id}/status`, { status: "closed" }, auth("student"))).status, 403);
    assert.equal((await server.post("/api/v1/support/notifications/send", { recipientUserId: ids["admin"], title: "Hi", messageBody: "Body text" }, auth("student"))).status, 403);
    assert.equal((await server.post("/api/v1/support/notifications/broadcast", { audience: ["student"], title: "Hi", messageBody: "Body text" }, auth("student"))).status, 403);
  });
});
