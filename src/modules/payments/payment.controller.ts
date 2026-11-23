import type { Request, Response, NextFunction } from "express";
import type { PaymentService } from "./payment.service";
import {
  createPaymentOrderSchema,
  createDiscountSchema,
  manualPaymentSchema,
  validateCouponSchema,
  verifyPaymentSchema,
} from "./payment.validation";
import { ApiError } from "../../utils/api-error";
import { sendSuccess } from "../../utils/send";
import { HttpStatus } from "../../utils/http-status";

function getActorId(req: Request): string {
  const id = req.principal?.id ?? (req as any).user?.userId ?? (req as any).user?.id;
  if (!id) {
    throw ApiError.unauthorized("Authentication required", "UNAUTHENTICATED");
  }
  return String(id);
}

export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  createOrder = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const studentUserId = getActorId(req);
      const parsed = createPaymentOrderSchema.parse(req.body);

      const result = await this.paymentService.createOrder({
        studentUserId,
        courseId: parsed.courseId,
        enrollmentId: parsed.enrollmentId,
        couponCode: parsed.couponCode,
      });

      sendSuccess(res, {
        status: HttpStatus.CREATED,
        data: result,
        message: "Payment order initialized successfully.",
      });
    } catch (err) {
      next(err);
    }
  };

  verifyPayment = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const studentUserId = getActorId(req);
      const parsed = verifyPaymentSchema.parse(req.body);

      const result = await this.paymentService.verifyPayment({
        orderId: parsed.orderId,
        gatewayPaymentId: parsed.gatewayPaymentId,
        gatewaySignature: parsed.gatewaySignature,
        paymentMethod: parsed.paymentMethod,
        studentUserId,
      });

      sendSuccess(res, {
        data: result,
        message: "Payment verified successfully.",
      });
    } catch (err) {
      next(err);
    }
  };

  handleWebhook = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const signature =
        (req.headers["x-razorpay-signature"] as string) ||
        (req.headers["x-cashfree-signature"] as string) ||
        (req.headers["x-webhook-signature"] as string) ||
        "";
      const rawPayload = JSON.stringify(req.body);
      const gatewayEventId = (req.body?.event_id as string) || (req.headers["x-event-id"] as string) || `evt_${Date.now()}`;
      const eventType = (req.body?.event as string) || "unknown";

      const result = await this.paymentService.processWebhook({
        signature,
        rawPayload,
        gatewayEventId,
        eventType,
      });

      sendSuccess(res, { data: result });
    } catch (err) {
      next(err);
    }
  };

  getMyPaymentHistory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const studentUserId = getActorId(req);
      const history = await this.paymentService.getStudentPaymentHistory(studentUserId);
      sendSuccess(res, { data: history });
    } catch (err) {
      next(err);
    }
  };

  getReceipt = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const receiptId = String(req.params["receiptId"]);
      const receipt = await this.paymentService.getReceiptById(receiptId);
      if (!receipt) {
        throw ApiError.notFound("Receipt not found.");
      }
      sendSuccess(res, { data: receipt });
    } catch (err) {
      next(err);
    }
  };

  recordManualPayment = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const adminUserId = getActorId(req);
      const parsed = manualPaymentSchema.parse(req.body);

      const record = await this.paymentService.recordManualPayment({
        ...parsed,
        enteredByUserId: adminUserId,
      });

      sendSuccess(res, {
        status: HttpStatus.CREATED,
        data: record,
        message: "Manual payment recorded successfully.",
      });
    } catch (err) {
      next(err);
    }
  };

  getManualPayments = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const records = await this.paymentService.getManualPayments();
      sendSuccess(res, { data: records });
    } catch (err) {
      next(err);
    }
  };

  getAllTransactions = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const records = await this.paymentService.getAllPayments();
      sendSuccess(res, { data: records });
    } catch (err) {
      next(err);
    }
  };

  validateDiscount = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = validateCouponSchema.parse({
        code: req.query["code"],
        courseId: req.query["courseId"],
        grossAmountINR: req.query["grossAmountINR"] ? Number(req.query["grossAmountINR"]) : undefined,
      });

      const discount = await this.paymentService.validateCoupon(parsed);
      sendSuccess(res, { data: discount });
    } catch (err) {
      next(err);
    }
  };

  createDiscount = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = createDiscountSchema.parse(req.body);
      const discount = await this.paymentService.createDiscount({
        code: parsed.code,
        description: parsed.description,
        discountType: parsed.discountType,
        value: parsed.value,
        applicableCourseIds: parsed.applicableCourseIds,
        isActive: parsed.isActive,
        validUntil: parsed.validUntil,
      });

      sendSuccess(res, {
        status: HttpStatus.CREATED,
        data: discount,
        message: "Coupon created successfully.",
      });
    } catch (err) {
      next(err);
    }
  };

  getAllDiscounts = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const discounts = await this.paymentService.getDiscounts();
      sendSuccess(res, { data: discounts });
    } catch (err) {
      next(err);
    }
  };
}
