export interface PaymentOrder {
  id: string;
  studentUserId: string;
  enrollmentId: string;
  gatewayName: string;
  gatewayOrderId: string;
  orderReference: string;
  amount: number;
  currencyCode: string;
  orderStatus: 'created' | 'paid' | 'failed' | 'expired';
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentTransaction {
  id: string;
  paymentOrderId: string;
  gatewayPaymentId: string;
  paymentMethod: string;
  amount: number;
  currencyCode: string;
  transactionStatus: 'successful' | 'failed' | 'pending' | 'refunded';
  gatewaySignatureValid: boolean;
  gatewayPayload?: string | undefined;
  receiptNumber?: string | undefined;
  paidAt?: string | undefined;
  studentUserId?: string | undefined;
  studentName?: string | undefined;
  courseId?: string | undefined;
  courseTitle?: string | undefined;
  createdAt: string;
}

export interface PaymentReceipt {
  id: string;
  transactionId: string;
  receiptNumber: string;
  receiptObjectKey?: string | undefined;
  issuedAt: string;
  amountINR: number;
  studentName: string;
  courseTitle: string;
}

export interface PaymentWebhookEvent {
  id: string;
  gatewayName: string;
  gatewayEventId: string;
  eventType: string;
  signatureValid: boolean;
  processingStatus: 'received' | 'processed' | 'failed' | 'duplicate';
  payload: string;
  receivedAt: string;
  processedAt?: string | undefined;
}

export interface ManualPaymentRecord {
  id: string;
  studentUserId: string;
  studentName?: string | undefined;
  enrollmentId: string;
  courseId?: string | undefined;
  courseTitle?: string | undefined;
  amount: number;
  paymentMode: 'cash' | 'bank_transfer' | 'cheque' | 'pos_card' | 'other';
  referenceNumber: string;
  proofObjectKey?: string | undefined;
  verificationStatus: 'pending' | 'verified' | 'rejected';
  verifiedByUserId?: string | undefined;
  verifiedAt?: string | undefined;
  enteredByUserId: string;
  createdAt: string;
}

/**
 * A coupon: an NXA_Coupons row (code, limits, usage) and the NXA_Discounts row
 * it applies (type, value, validity). `id` is the CouponId.
 */
export interface CouponDiscount {
  id: string;
  /** NXA_Discounts.DiscountId the coupon applies. */
  discountId?: string | undefined;
  code: string;
  description: string;
  discountType: 'percentage' | 'fixed_amount';
  value: number;
  /** Not storable in the live schema (no coupon-course table); always empty when read. */
  applicableCourseIds?: string[] | undefined;
  /** Coupon AND discount active. */
  isActive: boolean;
  /** Date (YYYY-MM-DD) of NXA_Discounts.EndsAt, for display. */
  validUntil?: string | undefined;
  /** Exact NXA_Discounts.StartsAt / EndsAt (ISO), used for the validity checks. */
  startsAt?: string | undefined;
  endsAt?: string | undefined;
  /** NULL in the database means no limit. */
  usageLimit?: number | null | undefined;
  perUserLimit?: number | null | undefined;
  usageCount?: number | undefined;
}
