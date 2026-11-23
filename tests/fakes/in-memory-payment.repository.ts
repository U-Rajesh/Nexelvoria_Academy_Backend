import crypto from "node:crypto";
import type { PaymentRepository } from "../../src/modules/payments/payment.repository";
import type {
  CouponDiscount,
  ManualPaymentRecord,
  PaymentOrder,
  PaymentReceipt,
  PaymentTransaction,
  PaymentWebhookEvent,
} from "../../src/modules/payments/payment.types";

export class InMemoryPaymentRepository implements PaymentRepository {
  orders: PaymentOrder[] = [];
  transactions: PaymentTransaction[] = [];
  receipts: PaymentReceipt[] = [];
  webhookEvents: PaymentWebhookEvent[] = [];
  manualPayments: ManualPaymentRecord[] = [];
  discounts: CouponDiscount[] = [];

  reset(): void {
    this.orders = [];
    this.transactions = [];
    this.receipts = [];
    this.webhookEvents = [];
    this.manualPayments = [];
    this.discounts = [];
  }

  async createPaymentOrder(order: Omit<PaymentOrder, "id" | "createdAt" | "updatedAt">): Promise<PaymentOrder> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const newOrder: PaymentOrder = {
      ...order,
      id,
      createdAt: now,
      updatedAt: now,
    };
    this.orders.push(newOrder);
    return newOrder;
  }

  async getPaymentOrderById(id: string): Promise<PaymentOrder | null> {
    return this.orders.find((o) => o.id === id) ?? null;
  }

  async getPaymentOrderByGatewayOrderId(gatewayOrderId: string): Promise<PaymentOrder | null> {
    return this.orders.find((o) => o.gatewayOrderId === gatewayOrderId) ?? null;
  }

  async updatePaymentOrderStatus(id: string, status: PaymentOrder["orderStatus"]): Promise<PaymentOrder> {
    const order = this.orders.find((o) => o.id === id);
    if (!order) throw new Error("Order not found.");
    order.orderStatus = status;
    order.updatedAt = new Date().toISOString();
    return order;
  }

  async createTransaction(tx: Omit<PaymentTransaction, "id" | "createdAt">): Promise<PaymentTransaction> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const newTx: PaymentTransaction = {
      ...tx,
      id,
      createdAt: now,
    };
    this.transactions.push(newTx);
    return newTx;
  }

  async getTransactionByGatewayPaymentId(gatewayPaymentId: string): Promise<PaymentTransaction | null> {
    return this.transactions.find((t) => t.gatewayPaymentId === gatewayPaymentId) ?? null;
  }

  async getTransactionById(id: string): Promise<PaymentTransaction | null> {
    return this.transactions.find((t) => t.id === id) ?? null;
  }

  async createReceipt(receipt: Omit<PaymentReceipt, "id">): Promise<PaymentReceipt> {
    const id = crypto.randomUUID();
    const newReceipt: PaymentReceipt = {
      ...receipt,
      id,
    };
    this.receipts.push(newReceipt);
    return newReceipt;
  }

  async getReceiptByTransactionId(txId: string): Promise<PaymentReceipt | null> {
    return this.receipts.find((r) => r.transactionId === txId) ?? null;
  }

  async getReceiptById(id: string): Promise<PaymentReceipt | null> {
    return this.receipts.find((r) => r.id === id) ?? null;
  }

  async recordWebhookEvent(event: Omit<PaymentWebhookEvent, "id" | "receivedAt">): Promise<PaymentWebhookEvent> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const newEvent: PaymentWebhookEvent = {
      ...event,
      id,
      receivedAt: now,
    };
    this.webhookEvents.push(newEvent);
    return newEvent;
  }

  async getWebhookEventByGatewayId(gatewayName: string, eventId: string): Promise<PaymentWebhookEvent | null> {
    return (
      this.webhookEvents.find(
        (e) => e.gatewayName === gatewayName && e.gatewayEventId === eventId
      ) ?? null
    );
  }

  async recordManualPayment(input: Omit<ManualPaymentRecord, "id" | "createdAt">): Promise<ManualPaymentRecord> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const newPayment: ManualPaymentRecord = {
      ...input,
      id,
      createdAt: now,
    };
    this.manualPayments.push(newPayment);
    return newPayment;
  }

  async getManualPayments(): Promise<ManualPaymentRecord[]> {
    return [...this.manualPayments];
  }

  async verifyManualPayment(
    id: string,
    status: "verified" | "rejected",
    verifiedByUserId: string
  ): Promise<ManualPaymentRecord> {
    const record = this.manualPayments.find((p) => p.id === id);
    if (!record) throw new Error("Manual payment record not found.");
    record.verificationStatus = status;
    record.verifiedByUserId = verifiedByUserId;
    record.verifiedAt = new Date().toISOString();
    return record;
  }

  async getPaymentsByStudentId(studentId: string): Promise<PaymentTransaction[]> {
    const studentOrders = new Set(this.orders.filter((o) => o.studentUserId === studentId).map((o) => o.id));
    return this.transactions.filter((t) => studentOrders.has(t.paymentOrderId));
  }

  async getAllPayments(): Promise<PaymentTransaction[]> {
    return [...this.transactions];
  }

  async getDiscounts(): Promise<CouponDiscount[]> {
    return [...this.discounts];
  }

  async getDiscountByCode(code: string): Promise<CouponDiscount | null> {
    return this.discounts.find((d) => d.code.toUpperCase() === code.toUpperCase()) ?? null;
  }

  async createDiscount(discount: Omit<CouponDiscount, "id">): Promise<CouponDiscount> {
    const id = crypto.randomUUID();
    const newDiscount: CouponDiscount = {
      ...discount,
      id,
    };
    this.discounts.push(newDiscount);
    return newDiscount;
  }

  async toggleDiscount(id: string): Promise<CouponDiscount> {
    const disc = this.discounts.find((d) => d.id === id);
    if (!disc) throw new Error("Discount not found.");
    disc.isActive = !disc.isActive;
    return disc;
  }

  async deleteDiscount(id: string): Promise<boolean> {
    const idx = this.discounts.findIndex((d) => d.id === id);
    if (idx === -1) return false;
    this.discounts.splice(idx, 1);
    return true;
  }
}
