import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type sql from "mssql";

import { createApp } from "../src/app";
import { createAuthenticate } from "../src/middleware/authenticate.middleware";
import { issueAccessToken } from "../src/modules/auth/token.service";
import { FinanceRuleError } from "../src/modules/finance/finance.repository";
import { SqlServerFinanceRepository } from "../src/modules/finance/sqlserver-finance.repository";
import { ManualPaymentRuleError } from "../src/modules/payments/payment.repository";
import { SqlServerPaymentRepository } from "../src/modules/payments/sqlserver-payment.repository";
import { RecordNotFoundError } from "../src/repositories/repository.errors";
import { createTestHarness, type TestHarness } from "./fakes";
import { startServer, type TestServer } from "./helpers/server";

/**
 * Batch 3 item 4: coupon activation/deactivation, manual payment reference
 * integrity, refund detail + history (Super Admin), scholarships, and
 * NXA_FinancialAuditHistory written in the same transaction as each change.
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

const finance = (pool: sql.ConnectionPool) => new SqlServerFinanceRepository(async () => pool);
const couponRow = (over: Record<string, unknown> = {}) => ({
  CouponId: 31, CouponCode: "DIWALI", DiscountId: 9, CouponActive: true, DiscountActive: true, UsageCount: 4, UsageLimit: 10, PerUserLimit: 1, ...over,
});

describe("SqlServerFinanceRepository: coupon status", () => {
  const handler = (over: { row?: unknown; updated?: number; failHistory?: boolean } = {}): Handler => (q) => {
    if (/FROM dbo\.NXA_Coupons c WITH \(UPDLOCK, HOLDLOCK\)/.test(q)) return { recordset: over.row === undefined ? [couponRow()] : over.row ? [over.row] : [] };
    if (/UPDATE dbo\.NXA_Coupons/.test(q)) return { rowsAffected: [over.updated ?? 1] };
    if (/INSERT INTO dbo\.NXA_AuditLogs/.test(q)) return { recordset: [{ AuditLogId: 1 }] };
    if (/INSERT INTO dbo\.NXA_FinancialAuditHistory/.test(q) && over.failHistory) return new Error("history failed");
    return {};
  };

  it("deactivates under a lock with a guarded update, audit log and financial history in one transaction", async () => {
    const t = trackedPool(handler());
    const res = await finance(t.pool).setCouponActive("31", false, "Campaign ended early", "7");
    assert.equal(res.changed, true);
    assert.equal(res.coupon.isActive, false);
    assert.equal(t.state.committed, true);
    const upd = t.writes().find((w) => /UPDATE dbo\.NXA_Coupons/.test(w.q))!;
    assert.match(upd.q, /AND IsActive = @Was/, "guarded against a concurrent change");
    assert.equal(upd.inputs["Active"], false);
    const audit = t.seen.find((x) => /NXA_AuditLogs/.test(x.q))!;
    assert.deepEqual([audit.inputs["action"], audit.inputs["module"], audit.inputs["actorId"]], ["DEACTIVATE_COUPON", "FINANCE", "7"]);
    const hist = t.seen.find((x) => /NXA_FinancialAuditHistory/.test(x.q))!;
    assert.deepEqual([hist.inputs["fEntityType"], hist.inputs["fActionType"], hist.inputs["fReason"], hist.inputs["fPerformedBy"]], ["Coupon", "DEACTIVATE_COUPON", "Campaign ended early", "7"]);
    assert.equal(t.writes().filter((w) => /NXA_CouponRedemptions|DELETE/.test(w.q)).length, 0, "redemptions untouched, nothing deleted");
    assert.equal(t.writes().length, 3, "exactly one update, one audit row, one history row");
  });

  it("refuses to activate a coupon whose discount is inactive (409), writing nothing", async () => {
    const t = trackedPool(handler({ row: couponRow({ CouponActive: false, DiscountActive: false }) }));
    await assert.rejects(finance(t.pool).setCouponActive("31", true, undefined, "7"), (e: unknown) => e instanceof FinanceRuleError && e.code === "DISCOUNT_INACTIVE" && e.status === 409);
    assert.equal(t.writes().length, 0);
    assert.equal(t.state.rolledBack, true);
  });

  it("an unchanged status writes nothing (no duplicate audit)", async () => {
    const t = trackedPool(handler());
    const res = await finance(t.pool).setCouponActive("31", true, undefined, "7");
    assert.equal(res.changed, false);
    assert.equal(t.writes().length, 0);
  });

  it("a concurrent change (0 rows updated) is a 409 and rolls back", async () => {
    const t = trackedPool(handler({ updated: 0 }));
    await assert.rejects(finance(t.pool).setCouponActive("31", false, undefined, "7"), (e: unknown) => e instanceof FinanceRuleError && e.code === "COUPON_CHANGED");
    assert.equal(t.state.rolledBack, true);
    assert.equal(t.seen.filter((x) => /NXA_AuditLogs|NXA_FinancialAuditHistory/.test(x.q)).length, 0);
  });

  it("rolls the status change back when the financial history write fails", async () => {
    const t = trackedPool(handler({ failHistory: true }));
    await assert.rejects(finance(t.pool).setCouponActive("31", false, undefined, "7"));
    assert.equal(t.state.rolledBack, true);
    assert.equal(t.state.committed, false);
  });

  it("unknown and non-numeric coupons are not found; non-numeric never opens a transaction", async () => {
    let t = trackedPool(handler({ row: null }));
    await assert.rejects(finance(t.pool).setCouponActive("31", false, undefined, "7"), RecordNotFoundError);
    t = trackedPool(handler());
    await assert.rejects(finance(t.pool).setCouponActive("disc-1", false, undefined, "7"), RecordNotFoundError);
    assert.equal(t.state.began, 0);
  });
});

describe("SqlServerPaymentRepository: manual payment reference integrity", () => {
  it("refuses a payment mode + reference already recorded (409) before inserting anything", async () => {
    const t = trackedPool((q) => {
      if (/FROM dbo\.NXA_Enrollments WITH \(UPDLOCK\)/.test(q)) return { recordset: [{ StudentUserId: 301, EnrollmentStatus: "APPROVED_UNPAID", FinalAmount: "20000.00" }] };
      if (/FROM dbo\.NXA_ManualPaymentRecords WITH \(UPDLOCK, HOLDLOCK\)/.test(q)) return { recordset: [{ ManualPaymentRecordId: 88 }] };
      return {};
    });
    const repo = new SqlServerPaymentRepository(async () => t.pool);
    await assert.rejects(
      repo.recordManualPayment({ studentUserId: "301", enrollmentId: "901", amount: 20000, paymentMode: "bank_transfer", referenceNumber: "UTR123", enteredByUserId: "7" }),
      (e: unknown) => e instanceof ManualPaymentRuleError && e.code === "DUPLICATE_PAYMENT_REFERENCE" && e.status === 409,
    );
    assert.equal(t.writes().length, 0);
    assert.equal(t.state.rolledBack, true);
    const dup = t.seen.find((x) => /NXA_ManualPaymentRecords WITH/.test(x.q))!;
    assert.deepEqual([dup.inputs["dupMode"], dup.inputs["dupRef"]], ["bank_transfer", "UTR123"]);
  });
});

describe("SqlServerFinanceRepository: scholarships and refunds", () => {
  it("creates a scholarship with audit log and financial history in one transaction", async () => {
    const t = trackedPool((q) => {
      if (/INSERT INTO dbo\.NXA_Scholarships/.test(q)) return { recordset: [{ ScholarshipId: 12 }] };
      if (/INSERT INTO dbo\.NXA_AuditLogs/.test(q)) return { recordset: [{ AuditLogId: 1 }] };
      if (/WHERE s\.ScholarshipId = @Id/.test(q)) {
        return { recordset: [{ ScholarshipId: 12, ScholarshipName: "Merit", DiscountType: "percentage", DiscountValue: 25, IsActive: true, CreatedAt: new Date(), AwardCount: 0 }] };
      }
      return {};
    });
    const s = await finance(t.pool).createScholarship({ name: "Merit", discountType: "percentage", discountValue: 25, isActive: true }, "7");
    assert.equal(s.id, "12");
    const ins = t.writes().find((w) => /INSERT INTO dbo\.NXA_Scholarships/.test(w.q))!;
    assert.deepEqual([ins.inputs["Type"], ins.inputs["Value"], ins.inputs["Active"]], ["percentage", 25, true]);
    assert.equal(t.seen.find((x) => /NXA_FinancialAuditHistory/.test(x.q))!.inputs["fEntityType"], "Scholarship");
    assert.equal(t.state.committed, true);

    const bad = trackedPool(() => ({}));
    await assert.rejects(finance(bad.pool).createScholarship({ name: "Too much", discountType: "percentage", discountValue: 120, isActive: true }, "7"), FinanceRuleError);
    assert.equal(bad.state.began, 0);
  });

  it("deactivating a scholarship is audited; repeating it writes nothing; awards are never touched", async () => {
    let active = true;
    const h: Handler = (q, i) => {
      if (/SELECT IsActive FROM dbo\.NXA_Scholarships/.test(q)) return { recordset: [{ IsActive: active }] };
      if (/UPDATE dbo\.NXA_Scholarships/.test(q)) {
        active = i["Active"] as boolean;
        return {};
      }
      if (/INSERT INTO dbo\.NXA_AuditLogs/.test(q)) return { recordset: [{ AuditLogId: 1 }] };
      if (/WHERE s\.ScholarshipId = @Id/.test(q)) return { recordset: [{ ScholarshipId: 12, ScholarshipName: "Merit", DiscountType: "percentage", DiscountValue: 25, IsActive: active, CreatedAt: new Date(), AwardCount: 3 }] };
      return {};
    };
    let t = trackedPool(h);
    const first = await finance(t.pool).setScholarshipActive("12", false, "Budget closed", "7");
    assert.equal(first.changed, true);
    assert.equal(t.seen.find((x) => /NXA_AuditLogs/.test(x.q))!.inputs["action"], "DEACTIVATE_SCHOLARSHIP");
    assert.equal(t.writes().filter((w) => /NXA_ScholarshipAwards/.test(w.q)).length, 0);
    t = trackedPool(h);
    const again = await finance(t.pool).setScholarshipActive("12", false, undefined, "7");
    assert.equal(again.changed, false);
    assert.equal(t.writes().length, 0);
  });

  it("refund detail joins the transaction and reads only Refund history", async () => {
    const t = trackedPool((q) => {
      if (/FROM dbo\.NXA_Refunds r/.test(q)) {
        return {
          recordset: [{
            RefundId: 4, RefundReference: "RF-4", Amount: 5000, Reason: "Course cancelled", RefundStatus: "APPROVED", RequestedByUserId: 301, RequestedByName: "Asha",
            RequestedAt: new Date(), ApprovedBySuperAdminUserId: 2, ApprovedAt: new Date(), CompletedAt: null, GatewayRefundId: null,
            TransactionId: 70, TransactionAmount: 20000, TransactionStatus: "SUCCESS", PaymentMethod: "upi", ProcessedAt: new Date(), PaymentOrderId: 60,
            EnrollmentId: 901, StudentUserId: 301, StudentName: "Asha",
          }],
        };
      }
      if (/FROM dbo\.NXA_FinancialAuditHistory h/.test(q)) {
        return { recordset: [{ FinancialAuditHistoryId: 1, EntityType: "Refund", EntityId: 4, ActionType: "APPROVE_REFUND", OldValues: '{"refundStatus":"PENDING"}', NewValues: null, Reason: null, PerformedByUserId: 2, PerformedAt: new Date() }] };
      }
      return {};
    });
    const d = await finance(t.pool).getRefundDetail("4");
    assert.equal(d.refundStatus, "approved");
    assert.equal(d.completedAt, undefined, "approval is not completion");
    assert.equal(d.transaction.enrollmentId, "901");
    assert.deepEqual(d.history[0]!.oldValues, { refundStatus: "PENDING" });
    assert.match(t.seen.find((x) => /NXA_FinancialAuditHistory h/.test(x.q))!.q, /h\.EntityType = 'Refund'/);
    assert.equal(t.writes().length, 0, "read only");
  });
});

describe("/admin/finance endpoints", () => {
  let harness: TestHarness;
  let server: TestServer;
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const auth = (role: string) => ({ headers: { Authorization: `Bearer ${tokens[role]}`, "Content-Type": "application/json" } });
  const json = async (res: Response) => (await res.json()) as Record<string, any>;
  const base = "/api/v1/admin/finance";

  beforeEach(async () => {
    harness = createTestHarness();
    let seq = 50;
    for (const role of ["admin", "super_admin", "teacher", "student"] as const) {
      seq++;
      const user = await harness.users.create({ name: `${role} F`, email: `${role}-f${seq}@test.local`, mobile: `98765422${seq}`, role, status: "active" });
      const session = await harness.sessions.create({
        userId: user.id,
        refreshTokenHash: Buffer.alloc(64, 1).toString("hex"),
        ipAddress: "127.0.0.1",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
      tokens[role] = issueAccessToken({ userId: user.id, role, sessionId: session.sessionId }).token;
      ids[role] = user.id;
    }
    const f = harness.finance;
    f.coupons.push(
      { id: "31", code: "DIWALI", discountId: "9", couponActive: true, discountActive: true, usageCount: 4, usageLimit: 10, perUserLimit: 1 },
      { id: "32", code: "OLD", discountId: "10", couponActive: false, discountActive: false, usageCount: 0, usageLimit: null, perUserLimit: null },
    );
    f.redemptions.push({ id: "700", couponId: "31", enrollmentId: "901", studentUserId: "301", discountAmount: 500, redeemedAt: new Date().toISOString() });
    f.refunds.push({
      id: "4", refundReference: "RF-4", amount: 5000, reason: "Course cancelled", refundStatus: "pending", requestedByUserId: "301", requestedAt: new Date().toISOString(),
      transaction: { id: "70", amount: 20000, transactionStatus: "SUCCESS", paymentOrderId: "60" },
    });
    const authenticate = createAuthenticate({ studentAccess: null, sessions: () => harness.sessions });
    server = await startServer(createApp({ container: harness.container, authenticate }));
  });

  afterEach(async () => {
    await server.close();
  });

  it("authorization: admin and super_admin manage coupons and scholarships; refund detail is Super Admin only", async () => {
    for (const role of ["teacher", "student"]) {
      assert.equal((await server.patch(`${base}/coupons/31/status`, { isActive: false }, auth(role))).status, 403, role);
      assert.equal((await server.get(`${base}/scholarships`, auth(role))).status, 403, role);
      assert.equal((await server.get(`${base}/refunds/4`, auth(role))).status, 403, role);
    }
    assert.equal((await server.get(`${base}/refunds/4`, auth("admin"))).status, 403, "PAY-012: refunds stay with Super Admin");
    assert.equal((await server.get(`${base}/refunds/4`, auth("super_admin"))).status, 200);
    assert.equal((await server.get(`${base}/refunds/999`, auth("super_admin"))).status, 404);
    assert.equal((await server.get(`${base}/scholarships`)).status, 401);
  });

  it("coupon status: deactivate, idempotent repeat, refused activation, validation, redemptions preserved", async () => {
    const off = await server.patch(`${base}/coupons/31/status`, { isActive: false, reason: "Campaign ended" }, auth("admin"));
    assert.equal(off.status, 200);
    assert.equal((await json(off))["data"].changed, true);
    const again = await json(await server.patch(`${base}/coupons/31/status`, { isActive: false }, auth("admin")));
    assert.equal(again["data"].changed, false);
    assert.equal(harness.finance.auditLogs.length, 1, "no duplicate audit for a no-op");

    const blocked = await server.patch(`${base}/coupons/32/status`, { isActive: true }, auth("super_admin"));
    assert.equal(blocked.status, 409);
    assert.equal((await json(blocked))["error"], "DISCOUNT_INACTIVE");

    for (const body of [{}, { isActive: "no" }, { isActive: false, reason: "x" }, { isActive: false, extra: 1 }]) {
      assert.equal((await server.patch(`${base}/coupons/31/status`, body, auth("admin"))).status, 422, JSON.stringify(body));
    }
    assert.equal((await server.patch(`${base}/coupons/999/status`, { isActive: false }, auth("admin"))).status, 404);
    assert.equal((await server.patch(`${base}/coupons/disc-1/status`, { isActive: false }, auth("admin"))).status, 422);

    const redemptions = (await json(await server.get(`${base}/coupons/31/redemptions`, auth("admin"))))["data"];
    assert.equal(redemptions.length, 1, "redemption records preserved");

    const history = (await json(await server.get(`${base}/history?entityType=Coupon&entityId=31`, auth("admin"))))["data"];
    assert.equal(history.length, 1);
    assert.equal(history[0].actionType, "DEACTIVATE_COUPON");
    assert.equal(history[0].reason, "Campaign ended");
    assert.equal((await server.get(`${base}/history?entityType=Refund&entityId=4`, auth("admin"))).status, 422, "refund history is not exposed to Admin");
  });

  it("a failed financial history write rolls the coupon change back", async () => {
    harness.finance.failHistory = true;
    const res = await server.patch(`${base}/coupons/31/status`, { isActive: false }, auth("admin"));
    assert.equal(res.status, 500);
    assert.equal(harness.finance.coupons.find((c) => c.id === "31")!.couponActive, true);
    assert.equal(harness.finance.auditLogs.length, 0);
  });

  it("scholarships: create, validate, deactivate, list awards read-only", async () => {
    const created = await server.post(`${base}/scholarships`, { name: "Merit 2026", discountType: "percentage", discountValue: 25 }, auth("admin"));
    assert.equal(created.status, 201);
    const s = (await json(created))["data"];
    assert.equal(s.isActive, true);
    for (const body of [
      { name: "Too much", discountType: "percentage", discountValue: 150 },
      { name: "Bad type", discountType: "waiver", discountValue: 10 },
      { name: "Dates", discountType: "fixed_amount", discountValue: 1000, startsAt: "2026-12-31", endsAt: "2026-01-01" },
      { name: "xx", discountType: "fixed_amount", discountValue: 1000 },
    ]) {
      assert.equal((await server.post(`${base}/scholarships`, body, auth("admin"))).status, 422, JSON.stringify(body));
    }
    const off = await json(await server.patch(`${base}/scholarships/${s.id}/status`, { isActive: false, reason: "Budget closed" }, auth("super_admin")));
    assert.equal(off["data"].scholarship.isActive, false);
    assert.equal((await json(await server.get(`${base}/scholarships`, auth("admin"))))["data"].length, 1);
    assert.equal((await server.get(`${base}/scholarship-awards?scholarshipId=${s.id}`, auth("admin"))).status, 200);
    const history = (await json(await server.get(`${base}/history?entityType=Scholarship&entityId=${s.id}`, auth("admin"))))["data"];
    assert.deepEqual(history.map((h: { actionType: string }) => h.actionType), ["DEACTIVATE_SCHOLARSHIP", "CREATE_SCHOLARSHIP"]);
  });

  it("manual payment: the same mode + reference cannot settle a second enrollment; reference is length-checked", async () => {
    const student = ids["student"]!;
    harness.payments.manualPaymentTargets.set("enr-a", { studentUserId: student, status: "approved_unpaid", finalAmount: 20000 });
    harness.payments.manualPaymentTargets.set("enr-b", { studentUserId: student, status: "approved_unpaid", finalAmount: 20000 });
    const pay = (enrollmentId: string, referenceNumber: string) =>
      server.post("/api/v1/payments/admin/manual", { studentUserId: student, enrollmentId, amount: 20000, paymentMode: "bank_transfer", referenceNumber }, auth("admin"));
    assert.equal((await pay("enr-a", "UTR-555")).status, 201);
    const dup = await pay("enr-b", "  utr-555 ");
    assert.equal(dup.status, 409);
    assert.equal(harness.payments.manualPaymentTargets.get("enr-b")?.status, "approved_unpaid", "nothing activated");
    assert.equal((await pay("enr-a", "UTR-555")).status, 409, "already paid enrollment");
    assert.equal((await pay("enr-b", "x".repeat(101))).status, 422);
    assert.equal((await pay("enr-b", "UTR-556")).status, 201);
  });

  it("removed actions stay removed: no coupon toggle, delete or manual-payment verify endpoints", async () => {
    assert.equal((await server.post("/api/v1/payments/admin/discounts/31/toggle", {}, auth("admin"))).status, 404);
    assert.equal((await server.delete("/api/v1/payments/admin/discounts/31", auth("admin"))).status, 404);
    assert.equal((await server.post("/api/v1/payments/admin/manual/1/verify", { status: "rejected" }, auth("admin"))).status, 404);
  });
});
