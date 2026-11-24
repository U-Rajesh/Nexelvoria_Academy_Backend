import assert from "node:assert/strict";
import crypto from "node:crypto";
import { beforeEach, describe, it } from "node:test";

import type { PaymentGateway } from "../src/modules/payments/payment.gateway";
import { PaymentService } from "../src/modules/payments/payment.service";
import { createTestHarness, type TestHarness } from "./fakes";

/**
 * Findings 4-7: no simulated gateway, test-only behaviour isolated from
 * deployed environments, receipts from real records, no coupon stacking.
 */

const SECRET = "configured-gateway-secret";

describe("payments: gateway, signatures, receipts and coupons", () => {
  let h: TestHarness;
  let studentId: string;
  let courseId: string;

  const fakeGateway = (): PaymentGateway & { calls: number } => {
    const g = {
      calls: 0,
      async createOrder() {
        g.calls += 1;
        return { gatewayOrderId: `order_real_${g.calls}` };
      },
    };
    return g;
  };

  const service = (overrides: Partial<ConstructorParameters<typeof PaymentService>[0]> = {}) =>
    new PaymentService({
      payments: h.payments,
      courses: h.courses,
      enrollments: h.enrollments,
      users: h.users,
      webhookSecret: SECRET,
      testMode: false,
      ...overrides,
    });

  const enroll = (extra: Record<string, unknown> = {}) =>
    h.enrollments.create({
      studentId,
      courseId,
      enrollmentType: "admin",
      status: "approved_unpaid",
      ...extra,
    } as Parameters<TestHarness["enrollments"]["create"]>[0]);

  const sign = (gatewayOrderId: string, paymentId: string, secret = SECRET) =>
    crypto.createHmac("sha256", secret).update(`${gatewayOrderId}|${paymentId}`).digest("hex");

  beforeEach(async () => {
    h = createTestHarness();
    studentId = (await h.users.create({ name: "Meera Iyer", email: "meera@test.local", mobile: "9200000001", role: "student", status: "pending" })).id;
    courseId = (
      await h.courses.create({
        slug: "dsa-course",
        title: "Data Structures & Algorithms",
        shortDescription: "x",
        longDescription: "x",
        durationWeeks: 8,
        feeINR: 30000,
        level: "Beginner",
        prerequisites: [],
        learningOutcomes: [],
      })
    ).id;
  });

  describe("finding 4 - no simulated gateway", () => {
    it("refuses with 503 PAYMENT_GATEWAY_UNAVAILABLE and stores nothing when no gateway is wired", async () => {
      const enr = await enroll();
      await assert.rejects(
        service().createOrder({ studentUserId: studentId, courseId, enrollmentId: enr.id }),
        (err: { status?: number; code?: string }) => err.status === 503 && err.code === "PAYMENT_GATEWAY_UNAVAILABLE",
      );
      assert.equal((await h.payments.getPaymentOrderByGatewayOrderId("order_real_1")), null);
    });

    it("uses the gateway's order id when a real gateway is provided", async () => {
      const enr = await enroll();
      const gateway = fakeGateway();
      const result = await service({ gateway }).createOrder({ studentUserId: studentId, courseId, enrollmentId: enr.id });
      assert.equal(gateway.calls, 1);
      assert.equal(result.order.gatewayOrderId, "order_real_1");
      assert.equal(result.finalAmount, 30000);
    });
  });

  describe("finding 7 - coupons do not stack on an Admin discount", () => {
    it("refuses a coupon when the enrollment already carries a discount", async () => {
      const enr = await enroll({ discountAmountINR: 5000, amountDueINR: 25000 });
      await assert.rejects(
        service({ gateway: fakeGateway() }).createOrder({ studentUserId: studentId, courseId, enrollmentId: enr.id, couponCode: "ANY" }),
        (err: { status?: number; code?: string }) => err.status === 422 && err.code === "COUPON_NOT_STACKABLE",
      );
    });

    it("charges the discounted amount due when no coupon is given", async () => {
      const enr = await enroll({ discountAmountINR: 5000, amountDueINR: 25000 });
      const result = await service({ gateway: fakeGateway() }).createOrder({ studentUserId: studentId, courseId, enrollmentId: enr.id });
      assert.equal(result.finalAmount, 25000);
    });
  });

  describe("finding 5 - test-only behaviour never reaches a deployed environment", () => {
    const seedOrder = async () => {
      const enr = await enroll();
      return h.payments.createPaymentOrder({
        studentUserId: studentId,
        enrollmentId: enr.id,
        gatewayName: "razorpay",
        gatewayOrderId: "order_gw_1",
        orderReference: "ORD-1",
        amount: 30000,
        currencyCode: "INR",
        orderStatus: "created",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
    };

    it("rejects the sandbox signature override outside test mode", async () => {
      const order = await seedOrder();
      await assert.rejects(
        service().verifyPayment({
          orderId: order.id,
          gatewayPaymentId: "pay_1",
          gatewaySignature: "sandbox_signature_override",
          paymentMethod: "upi",
          studentUserId: studentId,
        }),
        (err: { status?: number }) => err.status === 400,
      );
      assert.equal((await h.payments.getPaymentOrderById(order.id))?.orderStatus, "created");
    });

    it("has no default secret outside test mode: verification is unavailable", async () => {
      const prev = { w: process.env.RAZORPAY_WEBHOOK_SECRET, k: process.env.RAZORPAY_KEY_SECRET };
      delete process.env.RAZORPAY_WEBHOOK_SECRET;
      delete process.env.RAZORPAY_KEY_SECRET;
      try {
        const order = await seedOrder();
        const noSecret = new PaymentService({ payments: h.payments, enrollments: h.enrollments, courses: h.courses, users: h.users, testMode: false });
        await assert.rejects(
          noSecret.verifyPayment({
            orderId: order.id,
            gatewayPaymentId: "pay_1",
            gatewaySignature: sign(order.gatewayOrderId, "pay_1", "default_sandbox_secret"),
            paymentMethod: "upi",
            studentUserId: studentId,
          }),
          (err: { status?: number }) => err.status === 503,
          "the well-known test secret is not accepted",
        );
      } finally {
        if (prev.w !== undefined) process.env.RAZORPAY_WEBHOOK_SECRET = prev.w;
        if (prev.k !== undefined) process.env.RAZORPAY_KEY_SECRET = prev.k;
      }
    });

    it("rejects the sandbox webhook signature outside test mode", async () => {
      const result = service().processWebhook({
        signature: "sandbox_webhook_signature",
        rawPayload: JSON.stringify({ event: "payment.captured" }),
        gatewayEventId: "evt_1",
        eventType: "payment.captured",
      });
      await assert.rejects(result, (err: { status?: number }) => err.status === 400);
    });

    it("still accepts the override inside the automated test suite only", async () => {
      const order = await seedOrder();
      const res = await service({ testMode: true }).verifyPayment({
        orderId: order.id,
        gatewayPaymentId: "pay_1",
        gatewaySignature: "sandbox_signature_override",
        paymentMethod: "upi",
        studentUserId: studentId,
      });
      assert.equal(res.success, true);
    });
  });

  describe("finding 6 - receipts carry real student and course names", () => {
    it("uses the user's name and the course title from the database", async () => {
      const enr = await enroll();
      const order = await h.payments.createPaymentOrder({
        studentUserId: studentId,
        enrollmentId: enr.id,
        gatewayName: "razorpay",
        gatewayOrderId: "order_gw_r",
        orderReference: "ORD-R",
        amount: 30000,
        currencyCode: "INR",
        orderStatus: "created",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
      const res = await service().verifyPayment({
        orderId: order.id,
        gatewayPaymentId: "pay_r",
        gatewaySignature: sign("order_gw_r", "pay_r"),
        paymentMethod: "card",
        studentUserId: studentId,
      });
      assert.equal(res.receipt.studentName, "Meera Iyer");
      assert.equal(res.receipt.courseTitle, "Data Structures & Algorithms");
      assert.match(res.receipt.receiptNumber, /^REC-\d{4}-[0-9A-F]{10}$/);
      assert.equal((await h.enrollments.findById(enr.id))?.status, "active");
    });

    it("refuses (503) instead of printing placeholders, and records nothing", async () => {
      const enr = await enroll();
      const order = await h.payments.createPaymentOrder({
        studentUserId: studentId,
        enrollmentId: enr.id,
        gatewayName: "razorpay",
        gatewayOrderId: "order_gw_x",
        orderReference: "ORD-X",
        amount: 30000,
        currencyCode: "INR",
        orderStatus: "created",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
      const withoutUsers = new PaymentService({
        payments: h.payments,
        courses: h.courses,
        enrollments: h.enrollments,
        webhookSecret: SECRET,
        testMode: false,
      });
      await assert.rejects(
        withoutUsers.verifyPayment({
          orderId: order.id,
          gatewayPaymentId: "pay_x",
          gatewaySignature: sign("order_gw_x", "pay_x"),
          paymentMethod: "card",
          studentUserId: studentId,
        }),
        (err: { status?: number; code?: string }) => err.status === 503 && err.code === "RECEIPT_DETAILS_UNAVAILABLE",
      );
      assert.equal((await h.payments.getPaymentOrderById(order.id))?.orderStatus, "created", "not marked paid");
      assert.equal((await h.enrollments.findById(enr.id))?.status, "approved_unpaid", "not activated");
    });
  });
});
