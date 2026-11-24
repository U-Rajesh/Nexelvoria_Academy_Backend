import type {
  PaymentOrder,
  PaymentTransaction,
  PaymentReceipt,
  PaymentWebhookEvent,
  ManualPaymentRecord,
  CouponDiscount,
} from "./payment.types";

/**
 * A manual payment that violates an approved rule. `status` is the HTTP
 * status the service maps it to (404 unknown enrollment, 409 wrong state,
 * 422 invalid request).
 */
export class ManualPaymentRuleError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 404 | 409 | 422,
  ) {
    super(message);
    this.name = "ManualPaymentRuleError";
  }
}

/** Input for an admin-recorded offline payment (ADM-009). */
export interface ManualPaymentInput {
  studentUserId: string;
  enrollmentId: string;
  amount: number;
  paymentMode: ManualPaymentRecord["paymentMode"];
  referenceNumber: string;
  proofObjectKey?: string | undefined;
  /** The admin recording (and thereby verifying) the payment. */
  enteredByUserId: string;
}

export interface PaymentRepository {
  createPaymentOrder(order: Omit<PaymentOrder, "id" | "createdAt" | "updatedAt">): Promise<PaymentOrder>;
  getPaymentOrderById(id: string): Promise<PaymentOrder | null>;
  getPaymentOrderByGatewayOrderId(gatewayOrderId: string): Promise<PaymentOrder | null>;
  updatePaymentOrderStatus(id: string, status: PaymentOrder["orderStatus"]): Promise<PaymentOrder>;

  createTransaction(tx: Omit<PaymentTransaction, "id" | "createdAt">): Promise<PaymentTransaction>;
  getTransactionByGatewayPaymentId(paymentId: string): Promise<PaymentTransaction | null>;
  getTransactionById(id: string): Promise<PaymentTransaction | null>;

  createReceipt(receipt: Omit<PaymentReceipt, "id">): Promise<PaymentReceipt>;
  getReceiptByTransactionId(txId: string): Promise<PaymentReceipt | null>;
  getReceiptById(receiptId: string): Promise<PaymentReceipt | null>;

  recordWebhookEvent(event: Omit<PaymentWebhookEvent, "id" | "receivedAt">): Promise<PaymentWebhookEvent>;
  getWebhookEventByGatewayId(gatewayName: string, eventId: string): Promise<PaymentWebhookEvent | null>;

  /**
   * Records a verified offline payment and activates the enrollment in ONE
   * transaction, with its audit record (BR-017). The enrollment must belong
   * to the student, be APPROVED_UNPAID (BR-002 approval already given), and
   * the amount must equal its full payable amount (BR-005: no installments),
   * and the same payment mode + reference number may not already be recorded
   * (one offline payment cannot settle two enrollments).
   * Throws `ManualPaymentRuleError` otherwise; nothing is written.
   *
   * There is no separate verify/reject step: the recording Admin verifies the
   * payment (VerificationStatus 'verified'), and no pending value is known.
   */
  recordManualPayment(input: ManualPaymentInput): Promise<ManualPaymentRecord>;
  getManualPayments(): Promise<ManualPaymentRecord[]>;

  getPaymentsByStudentId(studentId: string): Promise<PaymentTransaction[]>;
  getAllPayments(): Promise<PaymentTransaction[]>;

  getDiscounts(): Promise<CouponDiscount[]>;
  /** NXA_Coupons by CouponCode (input upper-cased), with its NXA_Discounts row. */
  getDiscountByCode(code: string): Promise<CouponDiscount | null>;
  /** Number of NXA_CouponRedemptions rows the student already has for the coupon. */
  countCouponRedemptions(couponId: string, studentUserId: string): Promise<number>;
  /**
   * Creates the NXA_Discounts row and its NXA_Coupons row (UsageCount 0) in one
   * transaction, audited. Throws DuplicateRecordError when the code exists.
   */
  createDiscount(discount: Omit<CouponDiscount, "id">, createdByUserId?: string | undefined): Promise<CouponDiscount>;
  /** Not supported: always throws (redemptions reference the coupon). Deactivate instead. */
  deleteDiscount(id: string): Promise<boolean>;
}
