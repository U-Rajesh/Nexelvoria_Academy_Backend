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

export interface CouponDiscount {
  id: string;
  code: string;
  description: string;
  discountType: 'percentage' | 'fixed_amount';
  value: number;
  applicableCourseIds?: string[] | undefined;
  isActive: boolean;
  validUntil?: string | undefined;
}
