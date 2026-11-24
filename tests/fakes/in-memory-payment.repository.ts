import crypto from "node:crypto";
import { DuplicateRecordError } from "../../src/repositories/repository.errors";
import { HistoryLog } from "./history-log";
import {
  ManualPaymentRuleError,
  type ManualPaymentInput,
  type PaymentRepository,
} from "../../src/modules/payments/payment.repository";
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
    this.couponRedemptions = [];
    this.history.reset();
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

  /**
   * Enrollments a manual payment may settle, keyed by enrollment id. Mirrors
   * the NXA_Enrollments row the SQL adapter locks and checks.
   */
  public manualPaymentTargets = new Map<
    string,
    { studentUserId: string; status: string; finalAmount: number }
  >();
  public manualPaymentAudit: { actorUserId: string; enrollmentId: string; amount: number }[] = [];
  /** Mirrors NXA_EnrollmentStatusHistory / NXA_FinancialAuditHistory writes. */
  public history = new HistoryLog();

  async recordManualPayment(input: ManualPaymentInput): Promise<ManualPaymentRecord> {
    const target = this.manualPaymentTargets.get(input.enrollmentId);
    if (!target) throw new ManualPaymentRuleError("ENROLLMENT_NOT_FOUND", "Enrollment not found", 404);
    if (target.studentUserId !== input.studentUserId) {
      throw new ManualPaymentRuleError("ENROLLMENT_STUDENT_MISMATCH", "The enrollment does not belong to this student", 422);
    }
    if (target.status !== "approved_unpaid") {
      throw new ManualPaymentRuleError("ENROLLMENT_NOT_AWAITING_PAYMENT", `This enrollment is ${target.status}`, 409);
    }
    if (Math.round(input.amount * 100) !== Math.round(target.finalAmount * 100)) {
      throw new ManualPaymentRuleError("AMOUNT_MISMATCH", "The payment must equal the full amount due", 422);
    }
    const dup = this.manualPayments.find(
      (p) => p.paymentMode === input.paymentMode && p.referenceNumber.trim().toUpperCase() === input.referenceNumber.trim().toUpperCase(),
    );
    if (dup) {
      throw new ManualPaymentRuleError("DUPLICATE_PAYMENT_REFERENCE", `Reference already recorded (manual payment ${dup.id})`, 409);
    }
    const now = new Date().toISOString();
    const newPayment: ManualPaymentRecord = {
      id: crypto.randomUUID(),
      studentUserId: input.studentUserId,
      enrollmentId: input.enrollmentId,
      amount: input.amount,
      paymentMode: input.paymentMode,
      referenceNumber: input.referenceNumber,
      ...(input.proofObjectKey ? { proofObjectKey: input.proofObjectKey } : {}),
      verificationStatus: "verified",
      verifiedByUserId: input.enteredByUserId,
      verifiedAt: now,
      enteredByUserId: input.enteredByUserId,
      createdAt: now,
    };
    this.manualPayments.push(newPayment);
    this.history.enrollmentStatus.push({
      enrollmentId: input.enrollmentId,
      oldStatus: target.status.toUpperCase(),
      newStatus: "ACTIVE",
      changedByUserId: input.enteredByUserId,
      reason: `Manual payment ${newPayment.id} recorded (${input.paymentMode}, reference ${input.referenceNumber})`,
    });
    this.history.financial.push({
      entityType: "ManualPayment",
      entityId: newPayment.id,
      actionType: "RECORD_MANUAL_PAYMENT",
      performedByUserId: input.enteredByUserId,
      newValues: { enrollmentId: input.enrollmentId, studentUserId: input.studentUserId, amount: input.amount },
    });
    target.status = "active";
    this.manualPaymentAudit.push({ actorUserId: input.enteredByUserId, enrollmentId: input.enrollmentId, amount: input.amount });
    return newPayment;
  }

  async getManualPayments(): Promise<ManualPaymentRecord[]> {
    return [...this.manualPayments];
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

  /** Redemptions seeded by tests: coupon id -> student ids (one entry per redemption). */
  couponRedemptions: Array<{ couponId: string; studentUserId: string }> = [];

  async countCouponRedemptions(couponId: string, studentUserId: string): Promise<number> {
    return this.couponRedemptions.filter((r) => r.couponId === couponId && r.studentUserId === studentUserId).length;
  }

  async createDiscount(discount: Omit<CouponDiscount, "id">, createdByUserId?: string | undefined): Promise<CouponDiscount> {
    if (this.discounts.some((d) => d.code.toUpperCase() === discount.code.toUpperCase())) {
      throw new DuplicateRecordError("coupon", "code", discount.code);
    }
    const id = crypto.randomUUID();
    const newDiscount: CouponDiscount = {
      ...discount,
      id,
    };
    this.discounts.push(newDiscount);
    if (createdByUserId) {
      this.history.financial.push({
        entityType: "Coupon",
        entityId: id,
        actionType: "CREATE_COUPON",
        performedByUserId: createdByUserId,
        newValues: { code: discount.code, discountType: discount.discountType, value: discount.value },
      });
    }
    return newDiscount;
  }

  /** Mirrors SQL: deleting a coupon is refused (redemptions reference it). */
  async deleteDiscount(_id: string): Promise<boolean> {
    throw new Error("Deleting a coupon is not supported; deactivate it instead.");
  }
}
