import type {
  PaymentOrder,
  PaymentTransaction,
  PaymentReceipt,
  PaymentWebhookEvent,
  ManualPaymentRecord,
  CouponDiscount,
} from "./payment.types";

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

  recordManualPayment(input: Omit<ManualPaymentRecord, "id" | "createdAt">): Promise<ManualPaymentRecord>;
  getManualPayments(): Promise<ManualPaymentRecord[]>;
  verifyManualPayment(id: string, status: "verified" | "rejected", verifiedByUserId: string): Promise<ManualPaymentRecord>;

  getPaymentsByStudentId(studentId: string): Promise<PaymentTransaction[]>;
  getAllPayments(): Promise<PaymentTransaction[]>;

  getDiscounts(): Promise<CouponDiscount[]>;
  getDiscountByCode(code: string): Promise<CouponDiscount | null>;
  createDiscount(discount: Omit<CouponDiscount, "id">): Promise<CouponDiscount>;
  toggleDiscount(id: string): Promise<CouponDiscount>;
  deleteDiscount(id: string): Promise<boolean>;
}
