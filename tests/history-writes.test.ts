import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type sql from "mssql";

import { createApp } from "../src/app";
import { createAuthenticate } from "../src/middleware/authenticate.middleware";
import { SqlServerAdminRepository } from "../src/modules/admin/sqlserver-admin.repository";
import { issueAccessToken } from "../src/modules/auth/token.service";
import { SqlServerEnrollmentRepository } from "../src/modules/enrollments/sqlserver-enrollment.repository";
import { SqlServerPaymentRepository } from "../src/modules/payments/sqlserver-payment.repository";
import { createTestHarness, type TestHarness } from "./fakes";
import { startServer, type TestServer } from "./helpers/server";

/**
 * Batch 2 item 5: NXA_EnrollmentStatusHistory and NXA_FinancialAuditHistory
 * (PAY-013) are written inside the same transaction as the business change;
 * a failed history insert rolls the change back; no-ops write nothing.
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

const tracked = (handler: Handler) => {
  const state = { committed: false, rolledBack: false };
  const seen: Array<{ q: string; inputs: Record<string, unknown> }> = [];
  const wrapped: Handler = (q, inputs) => {
    seen.push({ q, inputs: { ...inputs } });
    return handler(q, inputs);
  };
  const pool = {
    request: () => new MockSqlRequest(wrapped),
    transaction: () => ({
      begin: async () => {},
      commit: async () => {
        state.committed = true;
      },
      rollback: async () => {
        state.rolledBack = true;
      },
      request: () => new MockSqlRequest(wrapped),
    }),
  } as unknown as sql.ConnectionPool;
  const statusRows = () => seen.filter((s) => s.q.includes("INSERT INTO dbo.NXA_EnrollmentStatusHistory"));
  const financialRows = () => seen.filter((s) => s.q.includes("INSERT INTO dbo.NXA_FinancialAuditHistory"));
  return { pool, state, seen, statusRows, financialRows };
};

const historyFails = (table: "NXA_EnrollmentStatusHistory" | "NXA_FinancialAuditHistory") => (q: string) =>
  q.includes(`INSERT INTO dbo.${table}`) ? new Error(`${table} insert failed`) : undefined;

const columns = (q: string, table: string) =>
  new RegExp(`${table}\\s*\\(([^)]*)\\)`).exec(q)?.[1]?.split(",").map((c) => c.trim());

describe("history rows: exact live columns", () => {
  it("writes every supported column of both tables, with an explicit timestamp", async () => {
    const t = tracked((q) => {
      if (q.includes("WITH (UPDLOCK)")) return { recordset: [{ EnrollmentStatus: "ACTIVE", ActivatedAt: new Date() }] };
      if (q.includes("FROM dbo.NXA_Refunds") && q.includes("UPDLOCK")) return { recordset: [] };
      return { recordset: [] };
    });
    await assert.rejects(new SqlServerAdminRepository(t.pool).setEnrollmentStatus("901", "suspended", { actorUserId: "7", actionType: "SET_ENROLLMENT_STATUS" }));
    const [s] = t.statusRows();
    assert.deepEqual(columns(s!.q, "NXA_EnrollmentStatusHistory"), [
      "EnrollmentId", "OldStatus", "NewStatus", "ChangedByUserId", "ChangeReason", "ChangedAt",
    ]);
    assert.match(s!.q, /SYSUTCDATETIME\(\)\)/);
  });
});

describe("Admin enrollment creation (SqlServerAdminRepository.createEnrollment)", () => {
  const enrollmentRow = {
    EnrollmentId: 901, StudentUserId: 301, CourseId: 5, BatchId: null, EnrollmentNumber: "E", EnrollmentStatus: "ACTIVE",
    CoursePrice: 45000, DiscountAmount: 45000, FinalAmount: 0, CurrencyCode: "INR", EnrollmentSource: "ADMIN",
    ActivatedAt: new Date(), CompletedAt: null, CreatedAt: new Date(),
  };
  const handler = (extra?: (q: string) => unknown): Handler => (q) => {
    const x = extra?.(q);
    if (x !== undefined) return x;
    if (q.includes("SELECT sp.ApprovalStatus")) return { recordset: [{ ApprovalStatus: "APPROVED", AccountStatus: "active" }] };
    if (q.includes("SELECT ListPrice")) return { recordset: [{ ListPrice: 45000, CurrencyCode: "INR" }] };
    if (q.includes("FROM dbo.NXA_Coupons c")) {
      return {
        recordset: [{
          CouponId: 12, CouponCode: "MERIT5K", CouponActive: true, UsageLimit: null, PerUserLimit: null, UsageCount: 0,
          DiscountId: 7, DiscountName: "Merit", DiscountType: "fixed_amount", DiscountValue: 5000, StartsAt: null, EndsAt: null, DiscountActive: true,
        }],
      };
    }
    if (q.includes("WITH (UPDLOCK, HOLDLOCK)")) return { recordset: [] };
    if (q.includes("INSERT INTO dbo.NXA_Enrollments")) return { recordset: [{ EnrollmentId: 901 }] };
    if (q.includes("INSERT INTO dbo.NXA_EnrollmentOverrides")) return { recordset: [{ EnrollmentOverrideId: 55 }] };
    if (q.includes("INSERT INTO dbo.NXA_CouponRedemptions")) return { recordset: [{ CouponRedemptionId: 44 }] };
    if (q.includes("INSERT INTO")) return { recordset: [{ Id: 1 }] };
    return { recordset: [enrollmentRow], rowsAffected: [1] };
  };

  it("records the initial status and the free-access waiver with actor, reason and override id", async () => {
    const t = tracked(handler());
    await new SqlServerAdminRepository(t.pool).createEnrollment({
      studentUserId: "301", courseId: "5", status: "active", freeAccess: true, createdByUserId: "7",
      audit: { actorUserId: "7", actionType: "FREE_ACCESS_OVERRIDE", reason: "Scholarship approved by board" },
    });
    assert.ok(t.state.committed);
    const [s] = t.statusRows();
    assert.equal(s!.inputs["hEnrollmentId"], "901");
    assert.equal(s!.inputs["hOldStatus"], null, "a new enrollment has no previous status");
    assert.equal(s!.inputs["hNewStatus"], "ACTIVE");
    assert.equal(s!.inputs["hChangedBy"], "7");
    assert.equal(s!.inputs["hReason"], "Scholarship approved by board");

    const fin = t.financialRows();
    assert.equal(fin.length, 1);
    assert.equal(fin[0]!.inputs["fEntityType"], "EnrollmentOverride");
    assert.equal(fin[0]!.inputs["fEntityId"], "55");
    assert.equal(fin[0]!.inputs["fActionType"], "FREE_ACCESS_OVERRIDE");
    assert.equal(fin[0]!.inputs["fPerformedBy"], "7");
    assert.equal(fin[0]!.inputs["fReason"], "Scholarship approved by board");
    const nv = JSON.parse(String(fin[0]!.inputs["fNew"]));
    assert.equal(nv.enrollmentId, "901");
    assert.equal(nv.waivedAmount, 45000);
    assert.equal(nv.finalAmount, 0);
  });

  it("records a coupon redemption, and no financial row for a plain paid enrollment", async () => {
    const t = tracked(handler());
    await new SqlServerAdminRepository(t.pool).createEnrollment({
      studentUserId: "301", courseId: "5", discountCode: "merit5k", status: "approved_unpaid", createdByUserId: "1",
      audit: { actorUserId: "1", actionType: "MANUAL_ENROLLMENT" },
    });
    assert.equal(t.statusRows()[0]!.inputs["hNewStatus"], "APPROVED_UNPAID");
    assert.equal(t.statusRows()[0]!.inputs["hReason"], null);
    const [fin] = t.financialRows();
    assert.equal(fin!.inputs["fEntityType"], "CouponRedemption");
    assert.equal(fin!.inputs["fEntityId"], "44");
    assert.equal(fin!.inputs["fActionType"], "REDEEM_COUPON");
    assert.equal(fin!.inputs["fPerformedBy"], "1");
    const nv = JSON.parse(String(fin!.inputs["fNew"]));
    assert.equal(nv.couponCode, "MERIT5K");
    assert.equal(nv.discountAmount, 5000);
    assert.equal(nv.enrollmentId, "901");

    const plain = tracked(handler());
    await new SqlServerAdminRepository(plain.pool).createEnrollment({
      studentUserId: "301", courseId: "5", status: "approved_unpaid", createdByUserId: "1",
      audit: { actorUserId: "1", actionType: "MANUAL_ENROLLMENT" },
    });
    assert.equal(plain.statusRows().length, 1);
    assert.equal(plain.financialRows().length, 0);
  });

  it("rolls back the enrollment when either history insert fails", async () => {
    for (const table of ["NXA_EnrollmentStatusHistory", "NXA_FinancialAuditHistory"] as const) {
      const t = tracked(handler(historyFails(table)));
      await assert.rejects(
        new SqlServerAdminRepository(t.pool).createEnrollment({
          studentUserId: "301", courseId: "5", status: "active", freeAccess: true, createdByUserId: "7",
          audit: { actorUserId: "7", actionType: "FREE_ACCESS_OVERRIDE", reason: "Scholarship approved by board" },
        }),
        new RegExp(`${table} insert failed`),
      );
      assert.ok(t.state.rolledBack && !t.state.committed, table);
    }
  });
});

describe("Admin enrollment status change (setEnrollmentStatus)", () => {
  const run = (current: string, extra?: (q: string) => unknown) =>
    tracked((q) => {
      const x = extra?.(q);
      if (x !== undefined) return x;
      if (q.includes("WITH (UPDLOCK)")) return { recordset: [{ EnrollmentStatus: current, ActivatedAt: new Date() }] };
      return { recordset: [{ EnrollmentId: 901, StudentUserId: 301, CourseId: 5, EnrollmentStatus: "SUSPENDED", CoursePrice: 1, DiscountAmount: 0, FinalAmount: 1, CurrencyCode: "INR", EnrollmentSource: "ADMIN", CreatedAt: new Date() }] };
    });

  it("records old and new status with actor and reason", async () => {
    const t = run("ACTIVE");
    await new SqlServerAdminRepository(t.pool).setEnrollmentStatus("901", "suspended", {
      actorUserId: "7", actionType: "SET_ENROLLMENT_STATUS", reason: "Fee dispute under review",
    });
    const [s] = t.statusRows();
    assert.equal(s!.inputs["hOldStatus"], "ACTIVE");
    assert.equal(s!.inputs["hNewStatus"], "SUSPENDED");
    assert.equal(s!.inputs["hChangedBy"], "7");
    assert.equal(s!.inputs["hReason"], "Fee dispute under review");
    assert.equal(t.financialRows().length, 0, "a status change is not a financial event");
    assert.ok(t.state.committed);
  });

  it("writes nothing for a no-op change", async () => {
    const t = run("SUSPENDED");
    await assert.rejects(
      new SqlServerAdminRepository(t.pool).setEnrollmentStatus("901", "suspended", { actorUserId: "7", actionType: "SET_ENROLLMENT_STATUS" }),
      (err: Error & { code?: string }) => err.code === "STATUS_UNCHANGED",
    );
    assert.equal(t.statusRows().length, 0);
    assert.equal(t.seen.filter((s) => s.q.includes("UPDATE dbo.NXA_Enrollments")).length, 0);
  });

  it("rolls back the status change when the history insert fails", async () => {
    const t = run("ACTIVE", historyFails("NXA_EnrollmentStatusHistory"));
    await assert.rejects(
      new SqlServerAdminRepository(t.pool).setEnrollmentStatus("901", "suspended", { actorUserId: "7", actionType: "SET_ENROLLMENT_STATUS" }),
      /insert failed/,
    );
    assert.ok(t.state.rolledBack && !t.state.committed);
  });
});

describe("refund decisions (updateRefundStatus)", () => {
  const run = (current: string, extra?: (q: string) => unknown) =>
    tracked((q) => {
      const x = extra?.(q);
      if (x !== undefined) return x;
      if (q.includes("WITH (UPDLOCK)")) return { recordset: [{ RefundStatus: current, Amount: 15000 }] };
      return { recordset: [] };
    });

  it("records approval and rejection with old/new status, amount, actor and reason; never 'completed'", async () => {
    for (const [decision, action] of [["approved", "APPROVE_REFUND"], ["rejected", "REJECT_REFUND"]] as const) {
      const t = run("PENDING");
      await assert.rejects(new SqlServerAdminRepository(t.pool).updateRefundStatus("55", decision, "101", "Policy clause 4.2"), (err: Error) => err.name === "RecordNotFoundError");
      assert.ok(t.state.committed, "committed before the reload");
      const [fin] = t.financialRows();
      assert.equal(fin!.inputs["fEntityType"], "Refund");
      assert.equal(fin!.inputs["fEntityId"], "55");
      assert.equal(fin!.inputs["fActionType"], action);
      assert.equal(fin!.inputs["fPerformedBy"], "101");
      assert.equal(fin!.inputs["fReason"], "Policy clause 4.2");
      assert.deepEqual(JSON.parse(String(fin!.inputs["fOld"])), { refundStatus: "PENDING" });
      const nv = JSON.parse(String(fin!.inputs["fNew"]));
      assert.equal(nv.refundStatus, decision.toUpperCase());
      assert.equal(nv.amount, 15000);
      assert.doesNotMatch(String(fin!.inputs["fNew"]), /COMPLETED/i);
    }
  });

  it("writes no history for an already-decided refund", async () => {
    const t = run("APPROVED");
    await assert.rejects(new SqlServerAdminRepository(t.pool).updateRefundStatus("55", "approved", "101"), (err: Error & { code?: string }) => err.code === "REFUND_ALREADY_DECIDED");
    assert.equal(t.financialRows().length, 0);
  });

  it("rolls back the decision when the financial history insert fails", async () => {
    const t = run("PENDING", historyFails("NXA_FinancialAuditHistory"));
    await assert.rejects(new SqlServerAdminRepository(t.pool).updateRefundStatus("55", "approved", "101"), /insert failed/);
    assert.ok(t.state.rolledBack && !t.state.committed);
  });
});

describe("manual payments (SqlServerPaymentRepository.recordManualPayment)", () => {
  const input = {
    studentUserId: "301", enrollmentId: "901", amount: 40000, paymentMode: "bank_transfer" as const,
    referenceNumber: "UTR123", enteredByUserId: "7",
  };
  const run = (status: string, extra?: (q: string) => unknown) =>
    tracked((q) => {
      const x = extra?.(q);
      if (x !== undefined) return x;
      if (q.includes("FROM dbo.NXA_Enrollments WITH (UPDLOCK)")) return { recordset: [{ StudentUserId: 301, EnrollmentStatus: status, FinalAmount: 40000 }] };
      // Duplicate mode + reference check (Batch 3 item 4): none recorded.
      if (q.includes("FROM dbo.NXA_ManualPaymentRecords WITH (UPDLOCK, HOLDLOCK)")) return { recordset: [] };
      if (q.includes("INSERT INTO dbo.NXA_ManualPaymentRecords")) return { recordset: [{ ManualPaymentRecordId: 81, CreatedAt: new Date(), VerifiedAt: new Date() }] };
      return { recordset: [{ AuditLogId: 1 }] };
    });

  it("records the activation and the payment with actor and related ids", async () => {
    const t = run("APPROVED_UNPAID");
    await new SqlServerPaymentRepository(async () => t.pool).recordManualPayment(input);
    assert.ok(t.state.committed);
    const [s] = t.statusRows();
    assert.equal(s!.inputs["hEnrollmentId"], "901");
    assert.equal(s!.inputs["hOldStatus"], "APPROVED_UNPAID");
    assert.equal(s!.inputs["hNewStatus"], "ACTIVE");
    assert.equal(s!.inputs["hChangedBy"], "7");
    assert.match(String(s!.inputs["hReason"]), /Manual payment 81 recorded \(bank_transfer, reference UTR123\)/);
    const [fin] = t.financialRows();
    assert.equal(fin!.inputs["fEntityType"], "ManualPayment");
    assert.equal(fin!.inputs["fEntityId"], "81");
    assert.equal(fin!.inputs["fActionType"], "RECORD_MANUAL_PAYMENT");
    assert.equal(fin!.inputs["fPerformedBy"], "7");
    const nv = JSON.parse(String(fin!.inputs["fNew"]));
    assert.deepEqual([nv.enrollmentId, nv.studentUserId, nv.amount, nv.referenceNumber], ["901", "301", 40000, "UTR123"]);
  });

  it("writes no history when the enrollment is not awaiting payment", async () => {
    const t = run("ACTIVE");
    await assert.rejects(new SqlServerPaymentRepository(async () => t.pool).recordManualPayment(input), (err: Error & { code?: string }) => err.code === "ENROLLMENT_NOT_AWAITING_PAYMENT");
    assert.equal(t.statusRows().length + t.financialRows().length, 0);
  });

  it("rolls back the payment and activation when either history insert fails", async () => {
    for (const table of ["NXA_EnrollmentStatusHistory", "NXA_FinancialAuditHistory"] as const) {
      const t = run("APPROVED_UNPAID", historyFails(table));
      await assert.rejects(new SqlServerPaymentRepository(async () => t.pool).recordManualPayment(input), /insert failed/);
      assert.ok(t.state.rolledBack && !t.state.committed, table);
    }
  });
});

describe("coupon creation (SqlServerPaymentRepository.createDiscount)", () => {
  const coupon = { code: "NXA2026", description: "Launch offer", discountType: "percentage" as const, value: 20, isActive: true, usageLimit: 50 };
  const run = (extra?: (q: string) => unknown) =>
    tracked((q) => {
      const x = extra?.(q);
      if (x !== undefined) return x;
      if (q.includes("INSERT INTO dbo.NXA_Discounts")) return { recordset: [{ DiscountId: 7 }] };
      if (q.includes("INSERT INTO dbo.NXA_Coupons")) return { recordset: [{ CouponId: 12 }] };
      return { recordset: [{ AuditLogId: 1 }] };
    });

  it("records the coupon definition with the creating Admin", async () => {
    const t = run();
    await new SqlServerPaymentRepository(async () => t.pool).createDiscount(coupon, "5");
    const [fin] = t.financialRows();
    assert.equal(fin!.inputs["fEntityType"], "Coupon");
    assert.equal(fin!.inputs["fEntityId"], "12");
    assert.equal(fin!.inputs["fActionType"], "CREATE_COUPON");
    assert.equal(fin!.inputs["fPerformedBy"], "5");
    const nv = JSON.parse(String(fin!.inputs["fNew"]));
    assert.equal(nv.code, "NXA2026");
    assert.equal(nv.discountId, "7");
    assert.equal(nv.usageLimit, 50);
  });

  it("rolls back the coupon when the history insert fails", async () => {
    const t = run(historyFails("NXA_FinancialAuditHistory"));
    await assert.rejects(new SqlServerPaymentRepository(async () => t.pool).createDiscount(coupon, "5"), /insert failed/);
    assert.ok(t.state.rolledBack && !t.state.committed);
  });
});

describe("online payment activation (SqlServerEnrollmentRepository.setStatus)", () => {
  const row = (status: string) => ({
    EnrollmentId: 901, StudentUserId: 301, CourseId: 5, BatchId: null, EnrollmentStatus: status, EnrollmentSource: "SELF",
    FinalAmount: 40000, CreatedAt: new Date(), CompletedLessonIds: null, BookmarkedLessonIds: null,
  });
  const run = (current: string, extra?: (q: string) => unknown) =>
    tracked((q) => {
      const x = extra?.(q);
      if (x !== undefined) return x;
      if (q.includes("WITH (UPDLOCK, HOLDLOCK)")) return { recordset: [{ EnrollmentStatus: current }] };
      return { recordset: [row("ACTIVE")] };
    });

  it("records the activation with no user actor and the payment order in the reason", async () => {
    const t = run("APPROVED_UNPAID");
    const enr = await new SqlServerEnrollmentRepository(t.pool).setStatus("901", "active", {
      changedByUserId: null,
      reason: "Online payment verified for payment order 77",
    });
    assert.equal(enr.status, "active");
    const [s] = t.statusRows();
    assert.equal(s!.inputs["hOldStatus"], "APPROVED_UNPAID");
    assert.equal(s!.inputs["hNewStatus"], "ACTIVE");
    assert.equal(s!.inputs["hChangedBy"], null);
    assert.equal(s!.inputs["hReason"], "Online payment verified for payment order 77");
    assert.ok(t.state.committed);
  });

  it("writes neither the row nor history for a no-op, and rolls back when history fails", async () => {
    const noop = run("ACTIVE");
    await new SqlServerEnrollmentRepository(noop.pool).setStatus("901", "active");
    assert.equal(noop.statusRows().length, 0);
    assert.equal(noop.seen.filter((s) => s.q.includes("UPDATE dbo.NXA_Enrollments")).length, 0);

    const failing = run("APPROVED_UNPAID", historyFails("NXA_EnrollmentStatusHistory"));
    await assert.rejects(new SqlServerEnrollmentRepository(failing.pool).setStatus("901", "active"), /insert failed/);
    assert.ok(failing.state.rolledBack && !failing.state.committed);

    const missing = run("APPROVED_UNPAID", (q) => (q.includes("WITH (UPDLOCK, HOLDLOCK)") ? { recordset: [] } : undefined));
    await assert.rejects(new SqlServerEnrollmentRepository(missing.pool).setStatus("902", "active"), (err: Error) => err.name === "RecordNotFoundError");
    assert.equal(missing.statusRows().length, 0);
  });
});

describe("history through the API: authorization and fakes", () => {
  let harness: TestHarness;
  let server: TestServer;
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const auth = (role: string) => ({ headers: { Authorization: `Bearer ${tokens[role]}`, "Content-Type": "application/json" } });

  beforeEach(async () => {
    harness = createTestHarness();
    let seq = 70;
    for (const role of ["admin", "super_admin", "teacher", "student"] as const) {
      seq++;
      const user = await harness.users.create({ name: `${role} User`, email: `${role}-${seq}@test.local`, mobile: `98765432${seq}`, role, status: "active" });
      const session = await harness.sessions.create({
        userId: user.id,
        refreshTokenHash: Buffer.alloc(64, 1).toString("hex"),
        ipAddress: "127.0.0.1",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
      tokens[role] = issueAccessToken({ userId: user.id, role, sessionId: session.sessionId }).token;
      ids[role] = user.id;
    }
    const authenticate = createAuthenticate({ studentAccess: null, sessions: () => harness.sessions });
    server = await startServer(createApp({ container: harness.container, authenticate }));
  });

  afterEach(async () => {
    await server.close();
  });

  it("only Super Admin decides refunds; the decision is recorded once", async () => {
    harness.admin.refunds.push({
      id: "ref-9", refundReference: "REF-9", requestedByUserId: ids["student"]!, amount: 10000,
      reason: "Duplicate payment", refundStatus: "pending", requestedAt: new Date().toISOString(),
    });
    for (const role of ["admin", "teacher", "student"]) {
      assert.equal((await server.post("/api/v1/super-admin/refunds/ref-9/approve", {}, auth(role))).status, 403, role);
    }
    assert.equal(harness.admin.history.financial.length, 0);
    assert.equal((await server.post("/api/v1/super-admin/refunds/ref-9/approve", { remarks: "Verified duplicate" }, auth("super_admin"))).status, 200);
    assert.equal((await server.post("/api/v1/super-admin/refunds/ref-9/approve", {}, auth("super_admin"))).status, 409);
    assert.deepEqual(
      harness.admin.history.financial.map((f) => [f.entityType, f.entityId, f.actionType, f.performedByUserId]),
      [["Refund", "ref-9", "APPROVE_REFUND", ids["super_admin"]]],
    );
  });

  it("only Admin roles record manual payments; the activation and payment are recorded", async () => {
    harness.payments.manualPaymentTargets.set("enr-9", { studentUserId: "stu-9", status: "approved_unpaid", finalAmount: 40000 });
    const body = { studentUserId: "stu-9", enrollmentId: "enr-9", amount: 40000, paymentMode: "bank_transfer", referenceNumber: "UTR123" };
    for (const role of ["teacher", "student"]) {
      assert.equal((await server.post("/api/v1/payments/admin/manual", body, auth(role))).status, 403, role);
    }
    assert.equal(harness.payments.history.financial.length, 0);
    assert.equal((await server.post("/api/v1/payments/admin/manual", body, auth("admin"))).status, 201);
    assert.deepEqual(harness.payments.history.enrollmentStatus.map((h) => [h.enrollmentId, h.oldStatus, h.newStatus, h.changedByUserId]), [
      ["enr-9", "APPROVED_UNPAID", "ACTIVE", ids["admin"]],
    ]);
    assert.equal(harness.payments.history.financial[0]!.entityType, "ManualPayment");
  });

  it("records coupon creation with the creating Admin, and nothing for refused roles", async () => {
    const body = { code: "SAVE10", description: "Ten percent", discountType: "percentage", value: 10 };
    assert.equal((await server.post("/api/v1/payments/admin/discounts", body, auth("teacher"))).status, 403);
    assert.equal(harness.payments.history.financial.length, 0);
    assert.equal((await server.post("/api/v1/payments/admin/discounts", body, auth("super_admin"))).status, 201);
    assert.deepEqual(harness.payments.history.financial.map((f) => [f.entityType, f.actionType, f.performedByUserId]), [
      ["Coupon", "CREATE_COUPON", ids["super_admin"]],
    ]);
  });
});
