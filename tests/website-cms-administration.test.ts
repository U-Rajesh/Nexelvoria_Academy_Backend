import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type sql from "mssql";

import { createApp } from "../src/app";
import { createAuthenticate } from "../src/middleware/authenticate.middleware";
import { issueAccessToken } from "../src/modules/auth/token.service";
import { SqlServerCmsRepository } from "../src/modules/cms/sqlserver-cms.repository";
import { createTestHarness, type TestHarness } from "./fakes";
import { startServer, type TestServer } from "./helpers/server";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Batch 3 item 7: Website CMS is backend-first and audited.
 * - every Admin change is persisted and audited (WEBSITE_CMS) in one step; a no-op writes nothing;
 * - new testimonials, achievements and FAQs start hidden; hidden / draft content never reaches public APIs;
 * - approved ordering rules; unknown ids are 404, never silently created;
 * - enquiries and callback requests are persisted; public submissions are validated and rate limited.
 */

const testimonial = (over: Record<string, unknown> = {}) => ({
  studentName: "Asha Rao", currentRole: "SDE", companyName: "Amazon", packageCTC: "24 LPA", courseName: "Full Stack", quote: "Great mentors and projects.", ...over,
});
const achievement = (over: Record<string, unknown> = {}) => ({
  title: "Won Smart India Hackathon", studentName: "Ravi K", category: "Hackathon", description: "First prize nationally.", date: "2026-03-01T00:00:00.000Z", ...over,
});
const faq = (over: Record<string, unknown> = {}) => ({ category: "General", question: "Do you offer weekend batches?", answer: "Yes, on Saturdays.", order: 1, ...over });
const article = (over: Record<string, unknown> = {}) => ({ slug: "cloud-guide", title: "Cloud Guide", category: "Cloud", author: "Team", excerpt: "Intro", ...over });

describe("Website CMS administration (HTTP, backend-first and audited)", () => {
  let harness: TestHarness;
  let server: TestServer;
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const auth = (role: string) => ({ headers: { Authorization: `Bearer ${tokens[role]}`, "Content-Type": "application/json" } });
  const json = async (res: Response) => (await res.json()) as Record<string, any>;

  beforeEach(async () => {
    harness = createTestHarness();
    let seq = 40;
    for (const role of ["admin", "super_admin", "teacher", "student"] as const) {
      seq++;
      const user = await harness.users.create({ name: `${role} User`, email: `${role}-${seq}@cms.test`, mobile: `98700000${seq}`, role, status: "active" });
      ids[role] = user.id;
      const session = await harness.sessions.create({
        userId: user.id,
        refreshTokenHash: Buffer.alloc(64, 2).toString("hex"),
        ipAddress: "127.0.0.1",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
      tokens[role] = issueAccessToken({ userId: user.id, role, sessionId: session.sessionId }).token;
    }
    const authenticate = createAuthenticate({ studentAccess: null, sessions: () => harness.sessions });
    server = await startServer(createApp({ container: harness.container, authenticate }));
  });

  afterEach(async () => {
    await server.close();
  });

  it("creates testimonials, achievements and FAQs hidden, even when the client asks for visible", async () => {
    const t = await json(await server.post("/api/v1/admin/cms/testimonials", testimonial({ isPublished: true }), auth("admin")));
    const a = await json(await server.post("/api/v1/admin/cms/achievements", achievement({ isActive: true }), auth("admin")));
    const f = await json(await server.post("/api/v1/admin/cms/faqs", faq({ isActive: true }), auth("admin")));
    assert.equal(t["data"].isPublished, false);
    assert.equal(a["data"].isActive, false);
    assert.equal(f["data"].isActive, false);
    for (const path of ["testimonials", "achievements", "faqs"]) {
      assert.deepEqual((await json(await server.get(`/api/v1/public/${path}`)))["data"], [], `${path} hidden from the public`);
      assert.equal((await json(await server.get(`/api/v1/admin/cms/${path}`, auth("admin"))))["data"].length, 1, `${path} visible to Admin`);
    }
    assert.deepEqual(harness.cms.audits.map((x) => [x.action, x.entityName, x.actorUserId]), [
      ["CMS_CREATE", "Testimonial", ids["admin"]],
      ["CMS_CREATE", "Achievement", ids["admin"]],
      ["CMS_CREATE", "Faq", ids["admin"]],
    ]);
  });

  it("publishes and hides as separate audited actions, and the public site follows", async () => {
    const t = (await json(await server.post("/api/v1/admin/cms/testimonials", testimonial(), auth("admin"))))["data"];
    const pub = await server.put(`/api/v1/admin/cms/testimonials/${t.id}`, { ...t, isPublished: true }, auth("super_admin"));
    assert.equal(pub.status, 200);
    assert.equal((await json(await server.get("/api/v1/public/testimonials")))["data"].length, 1);
    await server.put(`/api/v1/admin/cms/testimonials/${t.id}`, { ...t, isPublished: false }, auth("admin"));
    assert.equal((await json(await server.get("/api/v1/public/testimonials")))["data"].length, 0);
    const last = harness.cms.audits.slice(-2);
    assert.deepEqual(last.map((x) => x.action), ["CMS_PUBLISH", "CMS_UNPUBLISH"]);
    assert.equal(last[0]!.actorUserId, ids["super_admin"]);
    assert.deepEqual(last[0]!.oldValues, { isPublished: false });
    assert.deepEqual(last[0]!.newValues, { isPublished: true });
    assert.equal(last[0]!.entityId, t.id);
  });

  it("records field-level changes on update and writes no audit for an unchanged save", async () => {
    const f = (await json(await server.post("/api/v1/admin/cms/faqs", faq(), auth("admin"))))["data"];
    const before = harness.cms.audits.length;
    const same = await server.put(`/api/v1/admin/cms/faqs/${f.id}`, { ...f, category: "General" }, auth("admin"));
    assert.equal(same.status, 200);
    assert.equal(harness.cms.audits.length, before, "no-op is not audited");

    await server.put(`/api/v1/admin/cms/faqs/${f.id}`, { ...f, answer: "Yes, Saturdays and Sundays." }, auth("admin"));
    const upd = harness.cms.audits.at(-1)!;
    assert.equal(upd.action, "CMS_UPDATE");
    assert.deepEqual(upd.newValues, { answer: "Yes, Saturdays and Sundays." });
    assert.deepEqual(upd.oldValues, { answer: "Yes, on Saturdays." });
  });

  it("deletes permanently with an audit row, and returns 404 for unknown ids without creating anything", async () => {
    const a = (await json(await server.post("/api/v1/admin/cms/achievements", achievement(), auth("admin"))))["data"];
    assert.equal((await server.delete(`/api/v1/admin/cms/achievements/${a.id}`, auth("admin"))).status, 200);
    assert.equal(harness.cms.achievements.length, 0);
    assert.equal(harness.cms.audits.at(-1)!.action, "CMS_DELETE");
    assert.equal((await server.delete(`/api/v1/admin/cms/achievements/${a.id}`, auth("admin"))).status, 404);

    const ghost = await server.put("/api/v1/admin/cms/testimonials/testi-missing", testimonial(), auth("admin"));
    assert.equal(ghost.status, 404);
    assert.equal(harness.cms.testimonials.length, 0, "an update never creates");
    assert.equal((await server.put("/api/v1/admin/cms/faqs/abc", faq(), auth("admin"))).status, 422, "FAQ ids are numeric");
    assert.equal((await server.delete("/api/v1/admin/cms/faqs/999999", auth("admin"))).status, 404);
  });

  it("refuses a body id that differs from the URL id", async () => {
    const t = (await json(await server.post("/api/v1/admin/cms/testimonials", testimonial(), auth("admin"))))["data"];
    const res = await server.put(`/api/v1/admin/cms/testimonials/${t.id}`, { ...t, id: "testi-other" }, auth("admin"));
    assert.equal(res.status, 422);
  });

  it("keeps the change when the audit write fails out of the store (rollback)", async () => {
    const t = (await json(await server.post("/api/v1/admin/cms/testimonials", testimonial(), auth("admin"))))["data"];
    harness.cms.failAudit = true;
    const res = await server.put(`/api/v1/admin/cms/testimonials/${t.id}`, { ...t, isPublished: true }, auth("admin"));
    assert.equal(res.status, 500);
    assert.equal(harness.cms.testimonials[0]!.isPublished, false, "the failed change was not applied");
    const del = await server.delete(`/api/v1/admin/cms/testimonials/${t.id}`, auth("admin"));
    assert.equal(del.status, 500);
    assert.equal(harness.cms.testimonials.length, 1);
  });

  it("orders testimonials by position then name, FAQs by position then question, achievements newest first", async () => {
    const mk = async (path: string, body: unknown) => (await json(await server.post(`/api/v1/admin/cms/${path}`, body, auth("admin"))))["data"];
    await mk("testimonials", testimonial({ studentName: "Zara", displayOrder: 1 }));
    await mk("testimonials", testimonial({ studentName: "Bala", displayOrder: 2 }));
    await mk("testimonials", testimonial({ studentName: "Anil", displayOrder: 1 }));
    await mk("faqs", faq({ question: "Zeta question?", order: 1 }));
    await mk("faqs", faq({ question: "Alpha question?", order: 2 }));
    await mk("faqs", faq({ question: "Beta question?", order: 1 }));
    await mk("achievements", achievement({ title: "Older win", date: "2025-01-01T00:00:00.000Z" }));
    await mk("achievements", achievement({ title: "Newest win", date: "2026-06-01T00:00:00.000Z" }));
    const names = (await json(await server.get("/api/v1/admin/cms/testimonials", auth("admin"))))["data"].map((x: any) => x.studentName);
    assert.deepEqual(names, ["Anil", "Zara", "Bala"]);
    const qs = (await json(await server.get("/api/v1/admin/cms/faqs", auth("admin"))))["data"].map((x: any) => x.question);
    assert.deepEqual(qs, ["Beta question?", "Zeta question?", "Alpha question?"]);
    const titles = (await json(await server.get("/api/v1/admin/cms/achievements", auth("admin"))))["data"].map((x: any) => x.title);
    assert.deepEqual(titles, ["Newest win", "Older win"]);
  });

  it("serves only published blog posts publicly; a draft slug is 404", async () => {
    const draft = await json(await server.post("/api/v1/admin/cms/blogs", article(), auth("admin")));
    assert.equal(draft["data"].isPublished, false, "omitting isPublished never publishes");
    assert.equal((await server.get("/api/v1/public/blogs/cloud-guide")).status, 404);
    assert.deepEqual((await json(await server.get("/api/v1/public/blogs")))["data"], []);
    await server.put(`/api/v1/admin/cms/blogs/${draft["data"].id}`, { ...draft["data"], isPublished: true }, auth("admin"));
    assert.equal((await server.get("/api/v1/public/blogs/cloud-guide")).status, 200);
    assert.equal(harness.cms.audits.at(-1)!.action, "CMS_PUBLISH");
    const dup = await server.post("/api/v1/admin/cms/blogs", article({ title: "Another" }), auth("admin"));
    assert.equal(dup.status, 409, "slug is unique");
  });

  it("restricts page content to the allowlisted singleton pages, public only when published", async () => {
    const saved = await server.put("/api/v1/admin/cms/content/social_links", { title: "Social Links", content: { links: [] }, isPublished: false }, auth("admin"));
    assert.equal(saved.status, 200);
    assert.equal((await server.get("/api/v1/public/content/social_links")).status, 404, "unpublished page is not public");
    await server.put("/api/v1/admin/cms/content/social_links", { title: "Social Links", content: { links: [] }, isPublished: true }, auth("admin"));
    assert.equal((await server.get("/api/v1/public/content/social_links")).status, 200);
    assert.deepEqual(harness.cms.audits.map((a) => a.action), ["CMS_CREATE", "CMS_PUBLISH"]);

    // Collection rows (which hold hidden items) can never be read or overwritten as pages.
    assert.equal((await server.get("/api/v1/public/content/testimonials_list")).status, 404);
    assert.equal((await server.put("/api/v1/admin/cms/content/testimonials_list", { title: "x", content: {} }, auth("admin"))).status, 404);
    assert.equal((await server.put("/api/v1/admin/cms/content/Bad-Slug!", { title: "x", content: {} }, auth("admin"))).status, 422);
  });

  it("validates CMS payloads", async () => {
    assert.equal((await server.post("/api/v1/admin/cms/testimonials", { studentName: "A" }, auth("admin"))).status, 422);
    assert.equal((await server.post("/api/v1/admin/cms/faqs", faq({ question: "?" }), auth("admin"))).status, 422);
    assert.equal((await server.patch("/api/v1/admin/cms/corporate-training/services/corp-1/status", { isActive: "yes" }, auth("admin"))).status, 422);
    assert.equal(harness.cms.audits.length, 0);
  });

  it("allows only Admin and Super Admin to read drafts or change content", async () => {
    for (const role of ["teacher", "student"]) {
      assert.equal((await server.get("/api/v1/admin/cms/testimonials", auth(role))).status, 403, role);
      assert.equal((await server.post("/api/v1/admin/cms/faqs", faq(), auth(role))).status, 403, role);
      assert.equal((await server.get("/api/v1/admin/cms/enquiries", auth(role))).status, 403, role);
      assert.equal((await server.get("/api/v1/admin/cms/callbacks", auth(role))).status, 403, role);
    }
    assert.equal((await server.post("/api/v1/admin/cms/testimonials", testimonial())).status, 401);
    assert.equal((await server.put("/api/v1/admin/cms/content/homepage", { title: "x", content: {} })).status, 401);
    assert.equal(harness.cms.testimonials.length + harness.cms.faqs.length, 0);
  });

  it("persists public enquiries, lists them for Admin and audits status changes once", async () => {
    const res = await server.post("/api/v1/public/enquiries", { type: "course_admission", name: "Sneha", phone: "+91 98765 43210", email: "s@x.test", message: "Cloud batch?" });
    assert.equal(res.status, 201);
    const created = (await json(res))["data"];
    const list = (await json(await server.get("/api/v1/admin/cms/enquiries", auth("admin"))))["data"];
    assert.deepEqual(list.map((e: any) => e.id), [created.id]);

    assert.equal((await server.patch(`/api/v1/admin/cms/enquiries/${created.id}/status`, { status: "contacted" }, auth("admin"))).status, 200);
    assert.equal((await server.patch(`/api/v1/admin/cms/enquiries/${created.id}/status`, { status: "contacted" }, auth("admin"))).status, 200);
    assert.deepEqual(harness.cms.audits.map((a) => [a.action, a.oldValues, a.newValues]), [["CMS_ENQUIRY_STATUS", { status: "new" }, { status: "contacted" }]]);
    assert.equal((await server.patch(`/api/v1/admin/cms/enquiries/${created.id}/status`, { status: "lost" }, auth("admin"))).status, 422);
    assert.equal((await server.patch("/api/v1/admin/cms/enquiries/424242/status", { status: "closed" }, auth("admin"))).status, 404);
  });

  it("stores callback requests separately and lists them read-only for Admin", async () => {
    const res = await server.post("/api/v1/public/enquiries", { type: "callback", name: "Kiran", phone: "9876543210", preferredTimeSlot: "Evening" });
    assert.equal(res.status, 201);
    assert.match((await json(res))["message"], /Callback request received/);
    assert.equal(harness.cms.enquiries.length, 0);
    const list = (await json(await server.get("/api/v1/admin/cms/callbacks", auth("admin"))))["data"];
    assert.deepEqual(list.map((c: any) => [c.name, c.phone, c.preferredTimeSlot]), [["Kiran", "9876543210", "Evening"]]);
  });

  it("accepts an email-only general enquiry but requires a phone for callbacks and some contact detail otherwise", async () => {
    const emailOnly = await server.post("/api/v1/public/enquiries", { type: "general", name: "Mira", email: "mira@x.test", message: "Question" });
    assert.equal(emailOnly.status, 201);
    assert.equal((await server.post("/api/v1/public/enquiries", { type: "callback", name: "Mira", email: "mira@x.test" })).status, 422);
    assert.equal((await server.post("/api/v1/public/enquiries", { type: "general", name: "Mira", phone: "" })).status, 422);
    assert.equal(harness.cms.enquiries.length, 1);
    assert.equal(harness.cms.callbacks.length, 0);
  });

  it("rejects invalid public submissions and rate limits repeated ones", async () => {
    assert.equal((await server.post("/api/v1/public/enquiries", { type: "general", name: "A", phone: "1" })).status, 422);
    assert.equal((await server.post("/api/v1/public/enquiries", { type: "spam", name: "Abc", phone: "9876543210" })).status, 422);
    let limited = 0;
    for (let i = 0; i < 12; i++) {
      const r = await server.post("/api/v1/public/enquiries", { type: "general", name: "Repeat Sender", phone: "9876543210" });
      if (r.status === 429) limited++;
    }
    assert.ok(limited > 0, "the per-IP submission limit applies");
    assert.ok(harness.cms.enquiries.length <= 10);
  });

  it("reorders corporate training services atomically and refuses an incomplete order", async () => {
    const mk = async (title: string, order: number) =>
      (await json(await server.post("/api/v1/admin/cms/corporate-training/services", { title, shortDescription: "Short text", fullDescription: "Full description text", topics: ["x"], order }, auth("admin"))))["data"];
    const a = await mk("Track A", 1);
    const b = await mk("Track B", 2);
    const res = await server.put("/api/v1/admin/cms/corporate-training/order", { ids: [b.id, a.id] }, auth("admin"));
    assert.equal(res.status, 200);
    assert.deepEqual((await json(res))["data"].map((s: any) => s.title), ["Track B", "Track A"]);
    assert.equal(harness.cms.audits.at(-1)!.action, "CMS_REORDER");
    assert.equal((await server.put("/api/v1/admin/cms/corporate-training/order", { ids: [a.id] }, auth("admin"))).status, 422);
    const off = await server.patch(`/api/v1/admin/cms/corporate-training/services/${a.id}/status`, { isActive: false }, auth("admin"));
    assert.equal(off.status, 200);
    assert.equal(harness.cms.audits.at(-1)!.action, "CMS_DEACTIVATE");
  });
});

// ---------------------------------------------------------------------------
// SQL Server adapter against a mock pool: transaction + audit + locking.
// ---------------------------------------------------------------------------
type Handler = (q: string, inputs: Record<string, unknown>) => unknown;

class MockSqlRequest {
  inputs: Record<string, unknown> = {};
  constructor(private readonly handler: Handler, private readonly onTx: boolean) {}
  input(name: string, typeOrValue: unknown, value?: unknown): this {
    this.inputs[name] = value !== undefined ? value : typeOrValue;
    return this;
  }
  async query<T = unknown>(command: string): Promise<{ recordset: T[]; rowsAffected: number[] }> {
    const res = this.handler(command, { ...this.inputs, __tx: this.onTx });
    if (res instanceof Error) throw res;
    const r = (res ?? {}) as { recordset?: T[]; rowsAffected?: number[] };
    return { recordset: r.recordset ?? [], rowsAffected: r.rowsAffected ?? [1] };
  }
}

const tracked = (handler: Handler) => {
  const seen: Array<{ q: string; inputs: Record<string, unknown> }> = [];
  const state = { began: 0, committed: 0, rolledBack: 0 };
  const req = (onTx: boolean) =>
    new MockSqlRequest((q, inputs) => {
      seen.push({ q, inputs });
      return handler(q, inputs);
    }, onTx);
  const pool = {
    request: () => req(false),
    transaction: () => ({
      begin: async () => void state.began++,
      commit: async () => void state.committed++,
      rollback: async () => void state.rolledBack++,
      request: () => req(true),
    }),
  } as unknown as sql.ConnectionPool;
  const writes = () => seen.filter((s) => /^\s*(INSERT|UPDATE|DELETE|MERGE)/i.test(s.q));
  return { seen, state, writes, repo: new SqlServerCmsRepository(async () => pool) };
};

const testiBody = JSON.stringify([
  { id: "testi-1", studentName: "Asha", currentRole: "SDE", companyName: "Amazon", packageCTC: "24", courseName: "FS", rating: 5, avatarUrl: "", quote: "Great", year: "2026", previousRole: "Student", isPublished: false },
]);

describe("SqlServerCmsRepository CMS writes (mock pool)", () => {
  it("locks the collection row, writes body and audit in one transaction", async () => {
    const t = tracked((q) => (q.includes("FROM dbo.NXA_WebsiteContent WITH (UPDLOCK, HOLDLOCK)") ? { recordset: [{ Body: testiBody }] } : { recordset: [{ AuditLogId: 1 }] }));
    const saved = await t.repo.saveTestimonial({ ...JSON.parse(testiBody)[0], isPublished: true }, "7");
    assert.equal(saved.isPublished, true);
    assert.deepEqual(t.state, { began: 1, committed: 1, rolledBack: 0 });
    const [upd, audit] = t.writes();
    assert.match(upd!.q, /UPDATE dbo\.NXA_WebsiteContent SET Body = @body/);
    assert.equal(upd!.inputs["__tx"], true);
    assert.match(audit!.q, /INSERT INTO dbo\.NXA_AuditLogs/);
    assert.equal(audit!.inputs["__tx"], true, "audit row is part of the same transaction");
    assert.equal(audit!.inputs["action"], "CMS_PUBLISH");
    assert.equal(audit!.inputs["module"], "WEBSITE_CMS");
    assert.equal(audit!.inputs["ename"], "Testimonial");
    assert.equal(audit!.inputs["eid"], "testi-1");
    assert.equal(audit!.inputs["actorId"], "7");
  });

  it("writes nothing and no audit for an unchanged item", async () => {
    const t = tracked(() => ({ recordset: [{ Body: testiBody }] }));
    await t.repo.saveTestimonial(JSON.parse(testiBody)[0], "7");
    assert.equal(t.writes().length, 0);
    assert.deepEqual(t.state, { began: 1, committed: 1, rolledBack: 0 });
  });

  it("rolls back the change when the audit insert fails", async () => {
    const t = tracked((q) => {
      if (q.includes("INSERT INTO dbo.NXA_AuditLogs")) return new Error("audit insert failed");
      return { recordset: [{ Body: testiBody }] };
    });
    await assert.rejects(t.repo.deleteTestimonial("testi-1", "7"), /audit insert failed/);
    assert.deepEqual(t.state, { began: 1, committed: 0, rolledBack: 1 });
  });

  it("creates a new testimonial hidden with a random id, and records a NULL row author for a non-numeric actor", async () => {
    const t = tracked((q) => (q.includes("WITH (UPDLOCK, HOLDLOCK)") ? { recordset: [] } : { recordset: [{ AuditLogId: 1 }] }));
    const saved = await t.repo.saveTestimonial({ ...JSON.parse(testiBody)[0], id: "", isPublished: true }, "7");
    assert.equal(saved.isPublished, false);
    assert.match(saved.id, /^testi-[0-9a-f-]{36}$/);
    const ins = t.writes()[0]!;
    assert.match(ins.q, /INSERT INTO dbo\.NXA_WebsiteContent/);
    assert.equal(ins.inputs["contentType"], "testimonials");

    const anon = tracked((q) => (q.includes("WITH (UPDLOCK, HOLDLOCK)") ? { recordset: [] } : { recordset: [{ AuditLogId: 1 }] }));
    await anon.repo.saveTestimonial({ ...JSON.parse(testiBody)[0], id: "" }, "user-abc");
    assert.equal(anon.writes()[0]!.inputs["userId"], null, "no fabricated user id 1");
  });

  it("inserts a new FAQ unpublished and audits it in the same transaction", async () => {
    const t = tracked((q) => {
      if (q.includes("INSERT INTO dbo.NXA_Faqs")) return { recordset: [{ FaqId: 31 }] };
      if (q.includes("SELECT FaqId")) return { recordset: [{ FaqId: 31, Question: "Q?", Answer: "A.", DisplayOrder: 1, IsPublished: 0 }] };
      return { recordset: [{ AuditLogId: 1 }] };
    });
    const saved = await t.repo.saveFaq({ id: "", category: "General", question: "Q?", answer: "A.", order: 1, isActive: true }, "7");
    assert.equal(saved.isActive, false);
    const [ins, audit] = t.writes();
    assert.match(ins!.q, /VALUES \(@question, @answer, @order, 0\)/);
    assert.equal(audit!.inputs["eid"], "31");
  });

  it("reports a missing article on delete instead of deleting id 0", async () => {
    const t = tracked(() => ({ recordset: [] }));
    await assert.rejects(t.repo.deleteArticle("55", "7"), (e: Error) => e.name === "RecordNotFoundError");
    await assert.rejects(t.repo.deleteArticle("abc", "7"), (e: Error) => e.name === "RecordNotFoundError");
    assert.equal(t.state.rolledBack, 1);
    assert.equal(t.writes().filter((w) => w.q.includes("NXA_AuditLogs")).length, 0);
  });

  it("reads public page content only for 'page' rows", async () => {
    const t = tracked(() => ({ recordset: [] }));
    await t.repo.getPageContent("homepage", true);
    assert.match(t.seen[0]!.q, /ContentType = 'page' AND IsPublished = 1/);
  });

  it("stores the course only when it is a real course id, and callbacks in NXA_CallbackRequests", async () => {
    const t = tracked((q) => {
      if (q.includes("INSERT INTO dbo.NXA_Enquiries")) return { recordset: [{ EnquiryId: 9, CreatedAt: new Date() }] };
      if (q.includes("INSERT INTO dbo.NXA_CallbackRequests")) return { recordset: [{ CallbackRequestId: 4, RequestStatus: "pending", CreatedAt: new Date() }] };
      return {};
    });
    await t.repo.submitEnquiry({ type: "course_admission", name: "A", phone: "9876543210", courseOfInterest: "Full Stack" });
    await t.repo.submitEnquiry({ type: "course_admission", name: "A", phone: "9876543210", courseOfInterest: "12" });
    const [byName, byId] = t.writes();
    assert.equal(byName!.inputs["courseId"], null);
    assert.equal(byName!.inputs["message"], "Course of interest: Full Stack", "a course name is kept, not dropped");
    assert.equal(byId!.inputs["courseId"], "12");
    assert.match(byId!.q, /\(SELECT CourseId FROM dbo\.NXA_Courses WHERE CourseId = @courseId\)/);

    const cb = await t.repo.submitCallbackRequest({ name: "Kiran", phone: "9876543210", preferredTimeSlot: "Evening" });
    const ins = t.writes().at(-1)!;
    assert.match(ins.q, /INSERT INTO dbo\.NXA_CallbackRequests \(FullName, Mobile, PreferredTime, CreatedAt\)/);
    assert.equal("requestStatus" in ins.inputs || "status" in ins.inputs, false, "the status default is not overridden");
    assert.equal(cb.id, "4");
    assert.equal(cb.status, "pending");
  });

  it("does not audit an enquiry status that is already set", async () => {
    const t = tracked((q) => (q.includes("SELECT EnquiryStatus") ? { recordset: [{ EnquiryStatus: "contacted" }] } : { recordset: [{ EnquiryId: 1, FullName: "A", Mobile: "1", EnquiryStatus: "contacted", CreatedAt: new Date() }] }));
    await t.repo.updateEnquiryStatus("1", "contacted", "7");
    assert.equal(t.writes().length, 0);
  });
});
