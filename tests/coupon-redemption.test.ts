import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type sql from "mssql";

import { SqlServerAdminRepository } from "../src/modules/admin/sqlserver-admin.repository";
import { checkCouponUsable, couponDiscountAmount } from "../src/modules/payments/coupon-rules";
import type { PaymentGateway } from "../src/modules/payments/payment.gateway";
import { PaymentService } from "../src/modules/payments/payment.service";
import { createDiscountSchema } from "../src/modules/payments/payment.validation";
import type { CouponDiscount } from "../src/modules/payments/payment.types";
import { SqlServerPaymentRepository } from "../src/modules/payments/sqlserver-payment.repository";
import { createTestHarness, type TestHarness } from "./fakes";

/**
 * Batch 2 item 2: coupons live in NXA_Coupons (CouponCode, IsActive,
 * UsageLimit, PerUserLimit, UsageCount) -> NXA_Discounts, and redemptions in
 * NXA_CouponRedemptions (unique per coupon + enrollment).
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
  const state = { committed: false, rolledBack: false };
  const pool = {
    request: () => new MockSqlRequest(handler),
    transaction: () => ({
      begin: async () => {},
      commit: async () => {
        state.committed = true;
      },
      rollback: async () => {
        state.rolledBack = true;
      },
      request: () => new MockSqlRequest(handler),
    }),
  } as unknown as sql.ConnectionPool;
  return { pool, state };
};

const uniqueViolation = (): Error => Object.assign(new Error("Violation of UNIQUE KEY constraint"), { number: 2627 });

describe("coupon rules (shared by Admin enrollment and payments)", () => {
  const now = new Date("2026-11-23T10:00:00Z");
  const base = { isActive: true, usageLimit: null, usageCount: 0, perUserLimit: null };

  it("accepts an active coupon within its dates and limits", () => {
    assert.equal(
      checkCouponUsable({ ...base, startsAt: new Date("2026-11-01"), endsAt: new Date("2026-12-01"), usageLimit: 10, usageCount: 9 }, now, 0),
      null,
    );
  });

  it("treats NULL limits as unlimited", () => {
    assert.equal(checkCouponUsable({ ...base, usageCount: 100000 }, now, 500), null);
  });

  it("rejects inactive, not-started, expired, exhausted and per-user-limited coupons", () => {
    assert.equal(checkCouponUsable({ ...base, isActive: false }, now, null)?.code, "DISCOUNT_INACTIVE");
    assert.equal(checkCouponUsable({ ...base, startsAt: new Date("2026-12-01") }, now, null)?.code, "DISCOUNT_NOT_STARTED");
    assert.equal(checkCouponUsable({ ...base, endsAt: new Date("2026-11-22") }, now, null)?.code, "DISCOUNT_EXPIRED");
    assert.equal(checkCouponUsable({ ...base, usageLimit: 5, usageCount: 5 }, now, null)?.code, "DISCOUNT_USAGE_LIMIT_REACHED");
    assert.equal(checkCouponUsable({ ...base, perUserLimit: 1 }, now, 1)?.code, "DISCOUNT_PER_USER_LIMIT_REACHED");
  });

  it("skips the per-user limit only when no user is known", () => {
    assert.equal(checkCouponUsable({ ...base, perUserLimit: 1 }, now, null), null);
  });

  it("never discounts more than the price", () => {
    assert.equal(couponDiscountAmount("percentage", 20, 50000), 10000);
    assert.equal(couponDiscountAmount("percentage", 150, 50000), 50000);
    assert.equal(couponDiscountAmount("fixed_amount", 60000, 50000), 50000);
    assert.equal(couponDiscountAmount("fixed_amount", 5000, 0), 0);
  });
});

describe("Admin enrollment with a coupon (SQL Server adapter)", () => {
  const couponRow = (over: Record<string, unknown> = {}) => ({
    CouponId: 12,
    CouponCode: "MERIT5K",
    CouponActive: true,
    UsageLimit: 100,
    PerUserLimit: null,
    UsageCount: 3,
    DiscountId: 7,
    DiscountName: "Merit 5K",
    DiscountType: "fixed_amount",
    DiscountValue: 5000,
    StartsAt: null,
    EndsAt: null,
    DiscountActive: true,
    ...over,
  });

  const enrollmentRow = {
    EnrollmentId: 901, StudentUserId: 301, StudentName: null, StudentEmail: null, CourseId: 5, CourseTitle: null,
    BatchId: null, BatchCode: null, EnrollmentNumber: "E", EnrollmentStatus: "APPROVED_UNPAID", CoursePrice: 45000,
    DiscountAmount: 5000, FinalAmount: 40000, CurrencyCode: "INR", EnrollmentSource: "ADMIN", ActivatedAt: null,
    CompletedAt: null, CreatedAt: new Date(),
  };

  interface Scenario {
    coupon?: Record<string, unknown> | null;
    userRedemptions?: number;
    redemptionError?: Error;
    usageRowsAffected?: number;
  }

  /** Runs one Admin enrollment with code "merit5k"; records every statement. */
  const run = async (sc: Scenario) => {
    const seen: Array<{ q: string; inputs: Record<string, unknown> }> = [];
    const { pool, state } = trackedPool((q, inputs) => {
      seen.push({ q, inputs: { ...inputs } });
      if (q.includes("SELECT sp.ApprovalStatus")) return { recordset: [{ ApprovalStatus: "APPROVED", AccountStatus: "active" }] };
      if (q.includes("SELECT ListPrice")) return { recordset: [{ ListPrice: 45000, CurrencyCode: "INR" }] };
      if (q.includes("FROM dbo.NXA_Coupons c")) {
        return { recordset: sc.coupon === null ? [] : [couponRow(sc.coupon ?? {})] };
      }
      if (q.includes("FROM dbo.NXA_CouponRedemptions")) return { recordset: [{ cnt: sc.userRedemptions ?? 0 }] };
      if (q.includes("WITH (UPDLOCK, HOLDLOCK)")) return { recordset: [] };
      if (q.includes("INSERT INTO dbo.NXA_Enrollments")) return { recordset: [{ EnrollmentId: 901 }] };
      if (q.includes("INSERT INTO dbo.NXA_CouponRedemptions")) {
        return sc.redemptionError ?? { recordset: [{ CouponRedemptionId: 44 }] };
      }
      if (q.includes("UPDATE dbo.NXA_Coupons")) return { recordset: [], rowsAffected: [sc.usageRowsAffected ?? 1] };
      if (q.includes("INSERT INTO dbo.NXA_AuditLogs")) return { recordset: [{ AuditLogId: 1 }] };
      return { recordset: [enrollmentRow] };
    });
    const attempt = new SqlServerAdminRepository(pool).createEnrollment({
      studentUserId: "301",
      courseId: "5",
      discountCode: "merit5k",
      status: "approved_unpaid",
      createdByUserId: "1",
      audit: { actorUserId: "1", actionType: "MANUAL_ENROLLMENT" },
    });
    const find = (needle: string) => seen.filter((s) => s.q.includes(needle));
    return { attempt, state, seen, find };
  };

  const rejectsWith = async (sc: Scenario, code: string) => {
    const r = await run(sc);
    await assert.rejects(r.attempt, (err: Error & { code?: string }) => err.code === code);
    assert.ok(r.state.rolledBack && !r.state.committed, `${code}: rolled back`);
    return r;
  };

  it("redeems a valid coupon: locked lookup by CouponCode, redemption, guarded usage increment, audit", async () => {
    const r = await run({});
    await r.attempt;
    assert.ok(r.state.committed && !r.state.rolledBack);

    const [lookup] = r.find("FROM dbo.NXA_Coupons c");
    assert.match(lookup!.q, /FROM dbo\.NXA_Coupons c WITH \(UPDLOCK, HOLDLOCK\)/, "concurrent redemptions are serialized");
    assert.equal(lookup!.inputs["code"], "MERIT5K");

    const [enr] = r.find("INSERT INTO dbo.NXA_Enrollments");
    assert.equal(enr!.inputs["discount"], 5000);
    assert.equal(enr!.inputs["final"], 40000);

    const [red] = r.find("INSERT INTO dbo.NXA_CouponRedemptions");
    const cols = /NXA_CouponRedemptions\s*\(([^)]*)\)/.exec(red!.q)?.[1]?.split(",").map((c) => c.trim());
    assert.deepEqual(cols, ["CouponId", "EnrollmentId", "StudentUserId", "DiscountAmount", "RedeemedAt"]);
    assert.doesNotMatch(red!.q, /RedemptionStatus/, "no status value is invented; the table default applies");
    assert.equal(red!.inputs["couponId"], "12");
    assert.equal(red!.inputs["enrollmentId"], "901", "the redemption belongs to the new enrollment");
    assert.equal(red!.inputs["studentId"], "301");
    assert.equal(red!.inputs["amount"], 5000);

    const [usage] = r.find("UPDATE dbo.NXA_Coupons");
    assert.match(usage!.q, /SET UsageCount = UsageCount \+ 1/);
    assert.match(usage!.q, /UsageLimit IS NULL OR UsageCount < UsageLimit/, "the increment itself is guarded");

    const order = r.seen
      .map((s) => s.q)
      .filter((q) => /INSERT INTO dbo\.NXA_(Enrollments|CouponRedemptions|AuditLogs)|UPDATE dbo\.NXA_Coupons/.test(q))
      .map((q) => /NXA_(\w+)/.exec(q)![1]);
    assert.deepEqual(order, ["Enrollments", "CouponRedemptions", "Coupons", "AuditLogs"]);
  });

  it("rejects an unknown coupon code and writes nothing", async () => {
    const r = await rejectsWith({ coupon: null }, "DISCOUNT_NOT_FOUND");
    assert.equal(r.find("INSERT INTO").length, 0);
  });

  it("rejects an inactive coupon or an inactive discount", async () => {
    await rejectsWith({ coupon: { CouponActive: false } }, "DISCOUNT_INACTIVE");
    await rejectsWith({ coupon: { DiscountActive: false } }, "DISCOUNT_INACTIVE");
  });

  it("rejects an expired or not-yet-valid coupon", async () => {
    await rejectsWith({ coupon: { EndsAt: new Date(Date.now() - 60_000) } }, "DISCOUNT_EXPIRED");
    await rejectsWith({ coupon: { StartsAt: new Date(Date.now() + 86_400_000) } }, "DISCOUNT_NOT_STARTED");
  });

  it("rejects an exhausted coupon before any enrollment is created", async () => {
    const r = await rejectsWith({ coupon: { UsageLimit: 3, UsageCount: 3 } }, "DISCOUNT_USAGE_LIMIT_REACHED");
    assert.equal(r.find("INSERT INTO").length, 0);
  });

  it("enforces the per-user limit from the student's recorded redemptions", async () => {
    const r = await rejectsWith({ coupon: { PerUserLimit: 1 }, userRedemptions: 1 }, "DISCOUNT_PER_USER_LIMIT_REACHED");
    const [count] = r.find("FROM dbo.NXA_CouponRedemptions");
    assert.match(count!.q, /WHERE CouponId = @couponId AND StudentUserId = @studentId/);
    assert.equal(count!.inputs["couponId"], 12);
    assert.equal(count!.inputs["studentId"], "301");
    assert.equal(r.find("INSERT INTO").length, 0);

    const ok = await run({ coupon: { PerUserLimit: 2 }, userRedemptions: 1 });
    await ok.attempt;
    assert.ok(ok.state.committed);
  });

  it("does not query per-user redemptions when the coupon has no per-user limit", async () => {
    const r = await run({});
    await r.attempt;
    assert.equal(r.find("FROM dbo.NXA_CouponRedemptions").length, 0);
  });

  it("refuses a coupon that gives no discount instead of recording a zero redemption", async () => {
    await rejectsWith({ coupon: { DiscountType: "percentage", DiscountValue: 0 } }, "DISCOUNT_NOT_APPLICABLE");
  });

  it("maps a duplicate redemption to a conflict and rolls back the enrollment", async () => {
    const r = await run({ redemptionError: uniqueViolation() });
    await assert.rejects(r.attempt, (err: Error) => err.name === "DuplicateRecordError");
    assert.ok(r.state.rolledBack && !r.state.committed);
    assert.equal(r.find("INSERT INTO dbo.NXA_AuditLogs").length, 0);
  });

  it("rolls back when a concurrent redemption used the last slot (guarded increment affects no row)", async () => {
    const r = await run({ usageRowsAffected: 0 });
    await assert.rejects(r.attempt, (err: Error & { code?: string }) => err.code === "DISCOUNT_USAGE_LIMIT_REACHED");
    assert.ok(r.state.rolledBack && !r.state.committed, "enrollment and redemption are not kept");
    assert.equal(r.find("INSERT INTO dbo.NXA_AuditLogs").length, 0);
  });

  it("rolls back everything when the redemption insert fails (e.g. a CHECK violation)", async () => {
    const r = await run({ redemptionError: new Error("The INSERT statement conflicted with the CHECK constraint") });
    await assert.rejects(r.attempt, /CHECK constraint/);
    assert.ok(r.state.rolledBack && !r.state.committed);
    assert.equal(r.find("UPDATE dbo.NXA_Coupons").length, 0);
  });
});

describe("Payment repository coupons (SQL Server adapter)", () => {
  const repo = (pool: sql.ConnectionPool) => new SqlServerPaymentRepository(async () => pool);

  it("looks a code up in NXA_Coupons.CouponCode joined to its discount", async () => {
    let query = "";
    let code: unknown;
    const { pool } = trackedPool((q, inputs) => {
      query = q;
      code = inputs["code"];
      return {
        recordset: [{
          CouponId: 12, CouponCode: "NXA2026", CouponActive: true, UsageLimit: 50, PerUserLimit: 1, UsageCount: 7,
          DiscountId: 7, DiscountName: "Launch offer", DiscountType: "percentage", DiscountValue: 20,
          StartsAt: null, EndsAt: new Date("2026-12-31T18:29:59Z"), DiscountActive: false,
        }],
      };
    });
    const c = await repo(pool).getDiscountByCode(" nxa2026 ");
    assert.equal(code, "NXA2026");
    assert.match(query, /FROM dbo\.NXA_Coupons c\s+JOIN dbo\.NXA_Discounts d ON d\.DiscountId = c\.DiscountId/);
    assert.match(query, /WHERE c\.CouponCode = @code/);
    assert.doesNotMatch(query, /DiscountName\) = @code/, "the discount name is not a coupon code");
    assert.equal(c!.id, "12");
    assert.equal(c!.discountId, "7");
    assert.equal(c!.code, "NXA2026");
    assert.equal(c!.isActive, false, "an inactive discount makes the coupon unusable");
    assert.equal(c!.usageLimit, 50);
    assert.equal(c!.perUserLimit, 1);
    assert.equal(c!.usageCount, 7);
    assert.equal(c!.endsAt, "2026-12-31T18:29:59.000Z");
  });

  it("creates the discount and its coupon atomically, with an audit", async () => {
    const order: string[] = [];
    let couponInputs: Record<string, unknown> = {};
    const { pool, state } = trackedPool((q, inputs) => {
      if (q.includes("INSERT INTO dbo.NXA_Discounts")) {
        order.push("discount");
        return { recordset: [{ DiscountId: 7 }] };
      }
      if (q.includes("INSERT INTO dbo.NXA_Coupons")) {
        order.push("coupon");
        couponInputs = { ...inputs };
        assert.match(q, /\(CouponCode, DiscountId, IsActive, UsageLimit, PerUserLimit, UsageCount, CreatedAt\)/);
        return { recordset: [{ CouponId: 12 }] };
      }
      if (q.includes("INSERT INTO dbo.NXA_AuditLogs")) {
        order.push("audit");
        return { recordset: [{ AuditLogId: 1 }] };
      }
      return { recordset: [] };
    });
    const created = await repo(pool).createDiscount(
      {
        code: "nxa2026", description: "Launch offer", discountType: "percentage", value: 20, isActive: true,
        usageLimit: 50, perUserLimit: 1,
      },
      "5",
    );
    assert.deepEqual(order, ["discount", "coupon", "audit"]);
    assert.ok(state.committed);
    assert.equal(couponInputs["code"], "NXA2026");
    assert.equal(couponInputs["discountId"], "7");
    assert.equal(couponInputs["usageLimit"], 50);
    assert.equal(couponInputs["perUserLimit"], 1);
    assert.equal(created.id, "12");
    assert.equal(created.usageCount, 0);
  });

  it("reports a duplicate coupon code and keeps no orphan discount", async () => {
    const { pool, state } = trackedPool((q) => {
      if (q.includes("INSERT INTO dbo.NXA_Discounts")) return { recordset: [{ DiscountId: 7 }] };
      if (q.includes("INSERT INTO dbo.NXA_Coupons")) return uniqueViolation();
      return { recordset: [] };
    });
    await assert.rejects(
      repo(pool).createDiscount({ code: "NXA2026", description: "Launch offer", discountType: "percentage", value: 20, isActive: true }),
      (err: Error) => err.name === "DuplicateRecordError",
    );
    assert.ok(state.rolledBack && !state.committed);
  });

  it("does not delete coupons", async () => {
    let queried = false;
    const { pool } = trackedPool(() => {
      queried = true;
      return { recordset: [] };
    });
    await assert.rejects(repo(pool).deleteDiscount("12"), /not supported/);
    assert.equal(queried, false);
  });
});

describe("Payment service coupon validation", () => {
  let h: TestHarness;
  let studentId: string;
  let courseId: string;

  const coupon = (over: Partial<CouponDiscount> = {}): CouponDiscount => ({
    id: "c-1",
    code: "SAVE10",
    description: "Ten percent",
    discountType: "percentage",
    value: 10,
    isActive: true,
    usageLimit: null,
    perUserLimit: null,
    usageCount: 0,
    ...over,
  });

  const gateway = (): PaymentGateway => ({ createOrder: async () => ({ gatewayOrderId: "order_gw_1" }) });
  const service = () =>
    new PaymentService({
      payments: h.payments,
      courses: h.courses,
      enrollments: h.enrollments,
      users: h.users,
      gateway: gateway(),
      webhookSecret: "configured-gateway-secret",
      testMode: false,
    });

  beforeEach(async () => {
    h = createTestHarness();
    studentId = (await h.users.create({ name: "Meera Iyer", email: "meera@test.local", mobile: "9200000001", role: "student", status: "pending" })).id;
    courseId = (
      await h.courses.create({
        slug: "coupon-course", title: "Coupon Course", shortDescription: "x", longDescription: "x",
        durationWeeks: 8, feeINR: 30000, level: "Beginner", prerequisites: [], learningOutcomes: [],
      })
    ).id;
  });

  it("applies a valid coupon", async () => {
    h.payments.discounts.push(coupon());
    const r = await service().validateCoupon({ code: "save10", grossAmountINR: 30000, studentUserId: studentId });
    assert.equal(r.valid, true);
    assert.equal(r.discountAmountINR, 3000);
  });

  it("rejects unknown, inactive, expired, not-started and exhausted coupons with a reason code", async () => {
    const cases: Array<[Partial<CouponDiscount>, string]> = [
      [{ isActive: false }, "DISCOUNT_INACTIVE"],
      [{ endsAt: new Date(Date.now() - 60_000).toISOString() }, "DISCOUNT_EXPIRED"],
      [{ startsAt: new Date(Date.now() + 86_400_000).toISOString() }, "DISCOUNT_NOT_STARTED"],
      [{ usageLimit: 2, usageCount: 2 }, "DISCOUNT_USAGE_LIMIT_REACHED"],
    ];
    for (const [over, code] of cases) {
      h.payments.discounts = [coupon(over)];
      const r = await service().validateCoupon({ code: "SAVE10", grossAmountINR: 30000 });
      assert.equal(r.valid, false, code);
      assert.equal(r.code, code);
      assert.equal(r.discountAmountINR, 0);
    }
    h.payments.discounts = [];
    assert.equal((await service().validateCoupon({ code: "NOPE", grossAmountINR: 30000 })).code, "DISCOUNT_NOT_FOUND");
  });

  it("applies the per-user limit for the student, not for staff previews", async () => {
    h.payments.discounts.push(coupon({ perUserLimit: 1 }));
    h.payments.couponRedemptions.push({ couponId: "c-1", studentUserId: studentId });
    const forStudent = await service().validateCoupon({ code: "SAVE10", grossAmountINR: 30000, studentUserId: studentId });
    assert.equal(forStudent.code, "DISCOUNT_PER_USER_LIMIT_REACHED");
    const preview = await service().validateCoupon({ code: "SAVE10", grossAmountINR: 30000 });
    assert.equal(preview.valid, true);
  });

  it("refuses a payment order with an unusable coupon instead of silently charging the full fee", async () => {
    h.payments.discounts.push(coupon({ usageLimit: 1, usageCount: 1 }));
    const enr = await h.enrollments.create({
      studentId, courseId, enrollmentType: "admin", status: "approved_unpaid",
    } as Parameters<TestHarness["enrollments"]["create"]>[0]);
    await assert.rejects(
      service().createOrder({ studentUserId: studentId, courseId, enrollmentId: enr.id, couponCode: "SAVE10" }),
      (err: { status?: number; code?: string }) => err.status === 422 && err.code === "DISCOUNT_USAGE_LIMIT_REACHED",
    );
    assert.equal((await h.payments.getAllPayments()).length, 0);
  });

  it("maps a duplicate coupon code on create to 409", async () => {
    h.payments.discounts.push(coupon());
    await assert.rejects(
      service().createDiscount({ code: "save10", description: "Dup", discountType: "percentage", value: 5, isActive: true }),
      (err: { status?: number; code?: string }) => err.status === 409 && err.code === "COUPON_CODE_EXISTS",
    );
  });
});

describe("coupon creation validation", () => {
  const valid = { code: "NXA2026", description: "Launch offer", discountType: "percentage", value: 20 };

  it("accepts a coupon with optional limits", () => {
    const parsed = createDiscountSchema.parse({ ...valid, usageLimit: 50, perUserLimit: 1 });
    assert.equal(parsed.usageLimit, 50);
    assert.equal(parsed.perUserLimit, 1);
  });

  it("rejects what the live schema cannot store or a code longer than CouponCode varchar(40)", () => {
    assert.equal(createDiscountSchema.safeParse({ ...valid, applicableCourseIds: ["5"] }).success, false);
    assert.equal(createDiscountSchema.safeParse({ ...valid, code: "X".repeat(41) }).success, false);
    assert.equal(createDiscountSchema.safeParse({ ...valid, code: "HAS SPACE" }).success, false);
    assert.equal(createDiscountSchema.safeParse({ ...valid, value: 120 }).success, false);
    assert.equal(createDiscountSchema.safeParse({ ...valid, usageLimit: 0 }).success, false);
    assert.equal(createDiscountSchema.safeParse({ ...valid, perUserLimit: 1.5 }).success, false);
  });
});
