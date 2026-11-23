import crypto from "node:crypto";
import type { PaymentRepository } from "./payment.repository";
import type { CourseRepository } from "../courses/course.repository";
import type { EnrollmentRepository } from "../enrollments/enrollment.repository";
import type {
  PaymentOrder,
  PaymentTransaction,
  PaymentReceipt,
  ManualPaymentRecord,
  CouponDiscount,
} from "./payment.types";
import { ApiError } from "../../utils/api-error";
import { isProduction } from "../../config/env";

export interface PaymentServiceDeps {
  payments: PaymentRepository;
  courses?: CourseRepository | undefined;
  enrollments?: EnrollmentRepository | undefined;
  webhookSecret?: string | undefined;
}

export class PaymentService {
  private readonly webhookSecret: string;

  constructor(private readonly deps: PaymentServiceDeps) {
    const rawSecret = deps.webhookSecret ?? process.env.RAZORPAY_WEBHOOK_SECRET ?? process.env.RAZORPAY_KEY_SECRET;
    if (isProduction && (!rawSecret || rawSecret.trim() === "")) {
      throw new Error(
        "RAZORPAY_WEBHOOK_SECRET is required when NODE_ENV=production. Payment gateway cannot run in production without secret."
      );
    }
    this.webhookSecret = rawSecret ?? (isProduction ? "" : "default_sandbox_secret");
  }

  async createOrder(params: {
    studentUserId: string;
    courseId: string;
    enrollmentId: string;
    couponCode?: string | undefined;
  }): Promise<{ order: PaymentOrder; grossAmount: number; discountAmount: number; finalAmount: number }> {
    let fee = 25000;
    if (this.deps.courses) {
      const course = await this.deps.courses.findById(params.courseId);
      if (course) fee = course.feeINR;
    }

    let discountAmount = 0;
    if (params.couponCode) {
      const couponRes = await this.validateCoupon({
        code: params.couponCode,
        courseId: params.courseId,
        grossAmountINR: fee,
      });
      if (couponRes.valid) {
        discountAmount = couponRes.discountAmountINR;
      }
    }

    const finalAmount = Math.max(0, fee - discountAmount);
    const orderRef = `ORD-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const gatewayOrderId = `order_rzp_${Date.now()}`;
    const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

    const order = await this.deps.payments.createPaymentOrder({
      studentUserId: params.studentUserId,
      enrollmentId: params.enrollmentId,
      gatewayName: "razorpay",
      gatewayOrderId,
      orderReference: orderRef,
      amount: finalAmount,
      currencyCode: "INR",
      orderStatus: "created",
      expiresAt,
    });

    return {
      order,
      grossAmount: fee,
      discountAmount,
      finalAmount,
    };
  }

  async verifyPayment(params: {
    orderId: string;
    gatewayPaymentId: string;
    gatewaySignature: string;
    paymentMethod: string;
    studentUserId: string;
  }): Promise<{ success: boolean; transaction: PaymentTransaction; receipt: PaymentReceipt }> {
    const order = await this.deps.payments.getPaymentOrderById(params.orderId);
    if (!order) {
      throw ApiError.notFound("Payment order not found.");
    }

    if (order.orderStatus === "paid") {
      throw ApiError.conflict("Payment order has already been fulfilled.");
    }

    if (!this.webhookSecret) {
      throw ApiError.serviceUnavailable("Payment gateway secret is not configured.");
    }

    // Verify HMAC-SHA256 signature
    const text = `${order.gatewayOrderId}|${params.gatewayPaymentId}`;
    const expectedSignature = crypto
      .createHmac("sha256", this.webhookSecret)
      .update(text)
      .digest("hex");

    const allowDevOverride = !isProduction && params.gatewaySignature === "sandbox_signature_override";
    const isValid = expectedSignature === params.gatewaySignature || allowDevOverride;

    if (!isValid) {
      throw ApiError.badRequest("Invalid payment signature.");
    }

    await this.deps.payments.updatePaymentOrderStatus(order.id, "paid");

    const tx = await this.deps.payments.createTransaction({
      paymentOrderId: order.id,
      gatewayPaymentId: params.gatewayPaymentId,
      amount: order.amount,
      currencyCode: order.currencyCode,
      paymentMethod: params.paymentMethod,
      transactionStatus: "successful",
      gatewaySignatureValid: true,
      gatewayPayload: JSON.stringify({ verified: true, signature: params.gatewaySignature }),
    });

    const receiptNumber = `REC-2026-${Math.floor(1000 + Math.random() * 9000)}`;
    const receipt = await this.deps.payments.createReceipt({
      transactionId: tx.id,
      receiptNumber,
      issuedAt: new Date().toISOString(),
      amountINR: order.amount,
      studentName: "Enrolled Student",
      courseTitle: "Academy Course",
    });

    // Activate enrollment (BR-004)
    if (this.deps.enrollments && order.enrollmentId) {
      try {
        await this.deps.enrollments.setStatus(order.enrollmentId, "active");
      } catch {
        // Log and continue
      }
    }

    return { success: true, transaction: tx, receipt };
  }

  async processWebhook(params: {
    signature: string;
    rawPayload: string;
    gatewayEventId: string;
    eventType: string;
  }): Promise<{ status: "processed" | "duplicate" | "ignored" }> {
    // 1. Idempotency check
    const existing = await this.deps.payments.getWebhookEventByGatewayId("razorpay", params.gatewayEventId);
    if (existing) {
      return { status: "duplicate" };
    }

    if (!this.webhookSecret) {
      throw ApiError.serviceUnavailable("Payment gateway secret is not configured.");
    }

    // 2. Validate webhook signature
    const expectedSignature = crypto
      .createHmac("sha256", this.webhookSecret)
      .update(params.rawPayload)
      .digest("hex");

    const allowDevOverride = !isProduction && params.signature === "sandbox_webhook_signature";
    const isValid = expectedSignature === params.signature || allowDevOverride;

    if (!isValid) {
      await this.deps.payments.recordWebhookEvent({
        gatewayName: "razorpay",
        gatewayEventId: params.gatewayEventId,
        eventType: params.eventType,
        signatureValid: false,
        processingStatus: "failed",
        payload: params.rawPayload,
      });
      throw ApiError.badRequest("Invalid webhook signature");
    }

    // 3. Process payload
    let parsed: any;
    try {
      parsed = JSON.parse(params.rawPayload);
    } catch {
      parsed = {};
    }

    if (params.eventType === "payment.captured" || params.eventType === "order.paid") {
      const orderId = parsed.payload?.payment?.entity?.order_id ?? parsed.payload?.order?.entity?.id;
      if (orderId) {
        const order = await this.deps.payments.getPaymentOrderByGatewayOrderId(orderId);
        if (order && order.orderStatus !== "paid") {
          await this.deps.payments.updatePaymentOrderStatus(order.id, "paid");
          if (this.deps.enrollments && order.enrollmentId) {
            try {
              await this.deps.enrollments.setStatus(order.enrollmentId, "active");
            } catch {}
          }
        }
      }
    }

    await this.deps.payments.recordWebhookEvent({
      gatewayName: "razorpay",
      gatewayEventId: params.gatewayEventId,
      eventType: params.eventType,
      signatureValid: true,
      processingStatus: "processed",
      payload: params.rawPayload,
      processedAt: new Date().toISOString(),
    });

    return { status: "processed" };
  }

  async validateCoupon(params: {
    code: string;
    courseId?: string | undefined;
    grossAmountINR?: number | undefined;
  }): Promise<{
    valid: boolean;
    coupon?: CouponDiscount | undefined;
    discountAmountINR: number;
    finalAmountINR: number;
    message: string;
  }> {
    const coupon = await this.deps.payments.getDiscountByCode(params.code);
    const baseAmount = params.grossAmountINR || 0;

    if (!coupon) {
      return {
        valid: false,
        discountAmountINR: 0,
        finalAmountINR: baseAmount,
        message: "Invalid coupon code.",
      };
    }

    if (!coupon.isActive) {
      return {
        valid: false,
        coupon,
        discountAmountINR: 0,
        finalAmountINR: baseAmount,
        message: "This coupon code is no longer active.",
      };
    }

    const today = new Date().toISOString().slice(0, 10);
    if (coupon.validUntil && coupon.validUntil < today) {
      return {
        valid: false,
        coupon,
        discountAmountINR: 0,
        finalAmountINR: baseAmount,
        message: "This coupon code has expired.",
      };
    }

    if (params.courseId && coupon.applicableCourseIds && coupon.applicableCourseIds.length > 0) {
      if (!coupon.applicableCourseIds.includes(params.courseId)) {
        return {
          valid: false,
          coupon,
          discountAmountINR: 0,
          finalAmountINR: baseAmount,
          message: "This coupon code is not applicable to the selected course.",
        };
      }
    }

    let discountAmount = 0;
    if (coupon.discountType === "percentage") {
      discountAmount = Math.round((baseAmount * coupon.value) / 100);
    } else {
      discountAmount = Math.min(coupon.value, baseAmount);
    }
    const finalAmount = Math.max(0, baseAmount - discountAmount);

    return {
      valid: true,
      coupon,
      discountAmountINR: discountAmount,
      finalAmountINR: finalAmount,
      message: `Coupon applied: ${coupon.description} (Savings: ₹ ${discountAmount.toLocaleString("en-IN")})`,
    };
  }

  async recordManualPayment(params: {
    studentUserId: string;
    enrollmentId: string;
    amount: number;
    paymentMode: ManualPaymentRecord["paymentMode"];
    referenceNumber: string;
    proofObjectKey?: string | undefined;
    enteredByUserId: string;
  }): Promise<ManualPaymentRecord> {
    const record = await this.deps.payments.recordManualPayment({
      ...params,
      verificationStatus: "verified",
      verifiedByUserId: params.enteredByUserId,
      verifiedAt: new Date().toISOString(),
    });

    // Activate enrollment
    if (this.deps.enrollments && params.enrollmentId) {
      try {
        await this.deps.enrollments.setStatus(params.enrollmentId, "active");
      } catch {}
    }

    return record;
  }

  async getStudentPaymentHistory(studentId: string): Promise<PaymentTransaction[]> {
    return this.deps.payments.getPaymentsByStudentId(studentId);
  }

  async getAllPayments(): Promise<PaymentTransaction[]> {
    return this.deps.payments.getAllPayments();
  }

  async getReceiptById(receiptId: string): Promise<PaymentReceipt | null> {
    return this.deps.payments.getReceiptById(receiptId);
  }

  async getManualPayments(): Promise<ManualPaymentRecord[]> {
    return this.deps.payments.getManualPayments();
  }

  async getDiscounts(): Promise<CouponDiscount[]> {
    return this.deps.payments.getDiscounts();
  }

  async createDiscount(discount: Omit<CouponDiscount, "id">): Promise<CouponDiscount> {
    return this.deps.payments.createDiscount(discount);
  }

  async toggleDiscount(id: string): Promise<CouponDiscount> {
    return this.deps.payments.toggleDiscount(id);
  }

  async deleteDiscount(id: string): Promise<boolean> {
    return this.deps.payments.deleteDiscount(id);
  }
}
