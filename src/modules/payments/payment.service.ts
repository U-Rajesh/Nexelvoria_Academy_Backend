import crypto from "node:crypto";
import { ManualPaymentRuleError, type ManualPaymentInput, type PaymentRepository } from "./payment.repository";
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
import { logger } from "../../utils/logger";
import { HttpStatus } from "../../utils/http-status";
import { isProduction, isTest } from "../../config/env";
import { DuplicateRecordError } from "../../repositories/repository.errors";
import { checkCouponUsable, couponDiscountAmount } from "./coupon-rules";
import type { UserRepository } from "../users/user.repository";
import type { PaymentGateway } from "./payment.gateway";

export interface PaymentServiceDeps {
  payments: PaymentRepository;
  courses?: CourseRepository | undefined;
  enrollments?: EnrollmentRepository | undefined;
  /** Receipt names come from the real user record (never placeholders). */
  users?: UserRepository | undefined;
  /** Real gateway; absent until the Razorpay integration is provided. */
  gateway?: PaymentGateway | undefined;
  webhookSecret?: string | undefined;
  /**
   * Test-only behaviour (the fixed test secret and the signature override).
   * Defaults to `NODE_ENV === "test"`; never true on a deployed environment.
   */
  testMode?: boolean | undefined;
}

/** Fixed secret used only by the automated test suite. */
const TEST_ONLY_SECRET = "default_sandbox_secret";
/** Accepted as a signature ONLY in test mode - never on dev, staging or production. */
const TEST_ONLY_SIGNATURE = "sandbox_signature_override";
const TEST_ONLY_WEBHOOK_SIGNATURE = "sandbox_webhook_signature";

export class PaymentService {
  private readonly webhookSecret: string;
  private readonly testMode: boolean;

  constructor(private readonly deps: PaymentServiceDeps) {
    this.testMode = deps.testMode ?? isTest;
    const rawSecret = deps.webhookSecret ?? process.env.RAZORPAY_WEBHOOK_SECRET ?? process.env.RAZORPAY_KEY_SECRET;
    if (isProduction && (!rawSecret || rawSecret.trim() === "")) {
      throw new Error(
        "RAZORPAY_WEBHOOK_SECRET is required when NODE_ENV=production. Payment gateway cannot run in production without secret."
      );
    }
    // Outside the test suite there is no default: without a configured secret,
    // signature verification is unavailable rather than using a known value.
    this.webhookSecret = rawSecret?.trim() ? rawSecret : this.testMode ? TEST_ONLY_SECRET : "";
  }

  async createOrder(params: {
    studentUserId: string;
    courseId: string;
    enrollmentId: string;
    couponCode?: string | undefined;
  }): Promise<{ order: PaymentOrder; grossAmount: number; discountAmount: number; finalAmount: number }> {
    // CL-001 / BR-002: a student pays only for their OWN enrollment, and only
    // once an Admin has approved it (APPROVED_UNPAID). Approval of the student
    // account is enforced before this point by authorization.
    if (!this.deps.enrollments || !this.deps.courses) {
      throw ApiError.serviceUnavailable("Online payment is not available right now.", "PAYMENTS_UNAVAILABLE");
    }
    const enrollment = await this.deps.enrollments.findById(params.enrollmentId);
    if (!enrollment || enrollment.studentId !== params.studentUserId) {
      // Another student's enrollment is indistinguishable from a missing one.
      throw ApiError.notFound("Enrollment not found.");
    }
    if (enrollment.courseId !== params.courseId) {
      throw new ApiError(HttpStatus.UNPROCESSABLE_ENTITY, "The course does not match the enrollment.", "COURSE_MISMATCH");
    }
    if (enrollment.status !== "approved_unpaid") {
      throw ApiError.conflict("This enrollment is not awaiting payment.", "ENROLLMENT_NOT_AWAITING_PAYMENT");
    }
    const course = await this.deps.courses.findById(enrollment.courseId);
    if (!course) {
      throw ApiError.notFound("Course not found.");
    }
    // The enrollment's recorded amount due; the list price only when the
    // enrollment carries none. No hard-coded fallback price.
    const fee = enrollment.amountDueINR ?? course.feeINR;

    let discountAmount = 0;
    if (params.couponCode) {
      // An Admin-applied discount already lowered this enrollment's amount
      // due; a coupon may not stack on it.
      if ((enrollment.discountAmountINR ?? 0) > 0) {
        throw new ApiError(
          HttpStatus.UNPROCESSABLE_ENTITY,
          "A discount has already been applied to this enrollment, so a coupon cannot be added.",
          "COUPON_NOT_STACKABLE",
        );
      }
      const couponRes = await this.validateCoupon({
        code: params.couponCode,
        courseId: params.courseId,
        grossAmountINR: fee,
        studentUserId: params.studentUserId,
      });
      // A coupon the student asked for but cannot use is reported, never
      // silently dropped (which would charge the full fee unannounced).
      if (!couponRes.valid) {
        throw new ApiError(HttpStatus.UNPROCESSABLE_ENTITY, couponRes.message, couponRes.code ?? "COUPON_INVALID");
      }
      discountAmount = couponRes.discountAmountINR;
    }

    const finalAmount = Math.max(0, fee - discountAmount);

    // A real gateway order is required. Without the integration, payment is
    // unavailable - an order id is never generated locally.
    if (!this.deps.gateway) {
      throw ApiError.serviceUnavailable(
        "Online payment is not available yet. Please contact the institute to pay.",
        "PAYMENT_GATEWAY_UNAVAILABLE",
      );
    }
    const orderRef = `ORD-${Date.now()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
    const { gatewayOrderId } = await this.deps.gateway.createOrder({
      amountINR: finalAmount,
      currencyCode: "INR",
      receipt: orderRef,
    });
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
    if (!order || order.studentUserId !== params.studentUserId) {
      // Another student's order is indistinguishable from a missing one.
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

    // The override exists only for the automated test suite; on any deployed
    // environment (development, staging, production) it is just a wrong signature.
    const testOverride = this.testMode && params.gatewaySignature === TEST_ONLY_SIGNATURE;
    const presented = Buffer.from(params.gatewaySignature);
    const expected = Buffer.from(expectedSignature);
    const signatureMatches = presented.length === expected.length && crypto.timingSafeEqual(presented, expected);
    const isValid = signatureMatches || testOverride;

    if (!isValid) {
      throw ApiError.badRequest("Invalid payment signature.");
    }

    // Receipt details come from verified records; resolved before anything is
    // written so a missing record cannot leave a half-recorded payment.
    const receiptParties = await this.resolveReceiptParties(order.studentUserId, order.enrollmentId);

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

    const issuedAt = new Date();
    const receiptNumber = `REC-${issuedAt.getUTCFullYear()}-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
    const receipt = await this.deps.payments.createReceipt({
      transactionId: tx.id,
      receiptNumber,
      issuedAt: issuedAt.toISOString(),
      amountINR: order.amount,
      studentName: receiptParties.studentName,
      courseTitle: receiptParties.courseTitle,
    });

    // Activate enrollment (BR-004): only here, after verified payment.
    await this.activatePaidEnrollment(order.id, order.enrollmentId);

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

    // Test-suite-only override; on any deployed environment it is a wrong signature.
    const testOverride = this.testMode && params.signature === TEST_ONLY_WEBHOOK_SIGNATURE;
    const presented = Buffer.from(params.signature);
    const expected = Buffer.from(expectedSignature);
    const signatureMatches = presented.length === expected.length && crypto.timingSafeEqual(presented, expected);
    const isValid = signatureMatches || testOverride;

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
          await this.activatePaidEnrollment(order.id, order.enrollmentId);
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

  /**
   * Checks a coupon (NXA_Coupons + its NXA_Discounts row) with the same rules
   * as the Admin enrollment path (coupon-rules.ts): active, within dates,
   * overall usage limit and, when the student is known, the per-user limit.
   * Read-only: nothing is redeemed here.
   */
  async validateCoupon(params: {
    code: string;
    courseId?: string | undefined;
    grossAmountINR?: number | undefined;
    /** The student who would use it; enables the per-user limit check. */
    studentUserId?: string | undefined;
  }): Promise<{
    valid: boolean;
    code?: string | undefined;
    coupon?: CouponDiscount | undefined;
    discountAmountINR: number;
    finalAmountINR: number;
    message: string;
  }> {
    const coupon = await this.deps.payments.getDiscountByCode(params.code);
    const baseAmount = params.grossAmountINR || 0;
    const invalid = (code: string, message: string) => ({
      valid: false,
      code,
      ...(coupon ? { coupon } : {}),
      discountAmountINR: 0,
      finalAmountINR: baseAmount,
      message,
    });

    if (!coupon) return invalid("DISCOUNT_NOT_FOUND", "Invalid coupon code.");

    const userRedemptions =
      coupon.perUserLimit != null && params.studentUserId
        ? await this.deps.payments.countCouponRedemptions(coupon.id, params.studentUserId)
        : null;
    const rejection = checkCouponUsable(
      {
        isActive: coupon.isActive,
        startsAt: coupon.startsAt ? new Date(coupon.startsAt) : null,
        // Without an exact end time, the coupon is valid through its end date.
        endsAt: coupon.endsAt
          ? new Date(coupon.endsAt)
          : coupon.validUntil
            ? new Date(`${coupon.validUntil}T23:59:59.999Z`)
            : null,
        usageLimit: coupon.usageLimit,
        usageCount: coupon.usageCount,
        perUserLimit: coupon.perUserLimit,
      },
      new Date(),
      userRedemptions,
    );
    if (rejection) return invalid(rejection.code, rejection.message);

    if (params.courseId && coupon.applicableCourseIds && coupon.applicableCourseIds.length > 0) {
      if (!coupon.applicableCourseIds.includes(params.courseId)) {
        return invalid("DISCOUNT_NOT_APPLICABLE", "This coupon code is not applicable to the selected course.");
      }
    }

    const discountAmount = couponDiscountAmount(coupon.discountType, coupon.value, baseAmount);
    const finalAmount = Math.max(0, baseAmount - discountAmount);

    return {
      valid: true,
      coupon,
      discountAmountINR: discountAmount,
      finalAmountINR: finalAmount,
      message: `Coupon applied: ${coupon.description} (Savings: ₹ ${discountAmount.toLocaleString("en-IN")})`,
    };
  }

  /**
   * ADM-009 manual (offline) payment. The repository records it, activates
   * the enrollment and writes the audit record in one transaction, and
   * refuses a payment for the wrong student, an enrollment not awaiting
   * payment, or a partial amount. Nothing is swallowed.
   */
  async recordManualPayment(params: ManualPaymentInput): Promise<ManualPaymentRecord> {
    try {
      return await this.deps.payments.recordManualPayment(params);
    } catch (err) {
      if (err instanceof ManualPaymentRuleError) {
        const status =
          err.status === 404 ? HttpStatus.NOT_FOUND : err.status === 409 ? HttpStatus.CONFLICT : HttpStatus.UNPROCESSABLE_ENTITY;
        throw new ApiError(status, err.message, err.code);
      }
      throw err;
    }
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

  /**
   * A receipt only for the student who paid: receipt -> transaction ->
   * payment order -> studentUserId. Anything else is reported as not found.
   */
  async getReceiptForStudent(receiptId: string, studentUserId: string): Promise<PaymentReceipt | null> {
    const receipt = await this.deps.payments.getReceiptById(receiptId);
    if (!receipt) return null;
    const tx = await this.deps.payments.getTransactionById(receipt.transactionId);
    const order = tx ? await this.deps.payments.getPaymentOrderById(tx.paymentOrderId) : null;
    return order && order.studentUserId === studentUserId ? receipt : null;
  }

  /**
   * The student's name and the course title for a receipt, from the user,
   * enrollment and course records. Refuses (503) rather than printing a
   * placeholder when any of them cannot be read.
   */
  private async resolveReceiptParties(
    studentUserId: string,
    enrollmentId: string | undefined,
  ): Promise<{ studentName: string; courseTitle: string }> {
    const unavailable = () =>
      ApiError.serviceUnavailable(
        "The payment could not be confirmed because the receipt details are unavailable. No payment was recorded.",
        "RECEIPT_DETAILS_UNAVAILABLE",
      );
    if (!this.deps.users || !this.deps.enrollments || !this.deps.courses || !enrollmentId) throw unavailable();
    const [user, enrollment] = await Promise.all([
      this.deps.users.findById(studentUserId),
      this.deps.enrollments.findById(enrollmentId),
    ]);
    const course = enrollment ? await this.deps.courses.findById(enrollment.courseId) : null;
    if (!user?.name?.trim() || !course?.title?.trim()) throw unavailable();
    return { studentName: user.name.trim(), courseTitle: course.title.trim() };
  }

  /**
   * Marks the paid enrollment ACTIVE. A failure is logged loudly with the
   * identifiers needed to reconcile it - never silently ignored - because
   * the payment itself has already been recorded.
   */
  private async activatePaidEnrollment(orderId: string, enrollmentId: string | undefined): Promise<void> {
    if (!enrollmentId) return;
    if (!this.deps.enrollments) {
      logger.error("PAID ENROLLMENT NOT ACTIVATED: enrollment store is not wired", { orderId, enrollmentId });
      return;
    }
    try {
      // No user changes the status here: the verified gateway payment does (actor NULL).
      await this.deps.enrollments.setStatus(enrollmentId, "active", {
        changedByUserId: null,
        reason: `Online payment verified for payment order ${orderId}`,
      });
    } catch (err) {
      logger.error("PAID ENROLLMENT NOT ACTIVATED: activation failed after verified payment; reconcile manually", {
        orderId,
        enrollmentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async getManualPayments(): Promise<ManualPaymentRecord[]> {
    return this.deps.payments.getManualPayments();
  }

  async getDiscounts(): Promise<CouponDiscount[]> {
    return this.deps.payments.getDiscounts();
  }

  async createDiscount(discount: Omit<CouponDiscount, "id">, createdByUserId?: string | undefined): Promise<CouponDiscount> {
    try {
      return await this.deps.payments.createDiscount(discount, createdByUserId);
    } catch (err) {
      if (err instanceof DuplicateRecordError) {
        throw ApiError.conflict("A coupon with this code already exists.", "COUPON_CODE_EXISTS");
      }
      throw err;
    }
  }
}
