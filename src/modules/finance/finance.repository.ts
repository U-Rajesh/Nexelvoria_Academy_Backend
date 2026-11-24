/**
 * Admin / Super Admin financial administration (ADM-009/010, PAY-009/011/012/013)
 * over the live tables NXA_Coupons, NXA_Discounts, NXA_CouponRedemptions,
 * NXA_FinancialAuditHistory, NXA_Refunds, NXA_Transactions, NXA_PaymentOrders,
 * NXA_Scholarships and NXA_ScholarshipAwards.
 *
 * Ids are BIGINT identities: a non-numeric id finds nothing. Every write runs
 * in one transaction with its NXA_AuditLogs row and NXA_FinancialAuditHistory row.
 */

/** A well-formed request the financial data does not allow. */
export class FinanceRuleError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 409 | 422 = 422,
  ) {
    super(message);
    this.name = "FinanceRuleError";
  }
}

/** Same values NXA_Discounts.DiscountType already receives from coupon creation. */
export const SCHOLARSHIP_DISCOUNT_TYPES = ["percentage", "fixed_amount"] as const;
export type ScholarshipDiscountType = (typeof SCHOLARSHIP_DISCOUNT_TYPES)[number];

/** Entity types the payment code writes to NXA_FinancialAuditHistory (Refund is Super Admin only). */
export const ADMIN_HISTORY_ENTITY_TYPES = ["Coupon", "ManualPayment", "CouponRedemption", "EnrollmentOverride", "Scholarship"] as const;
export type AdminHistoryEntityType = (typeof ADMIN_HISTORY_ENTITY_TYPES)[number];

export interface CouponStatus {
  id: string;
  code: string;
  discountId: string;
  /** NXA_Coupons.IsActive */
  couponActive: boolean;
  /** NXA_Discounts.IsActive */
  discountActive: boolean;
  /** Usable only when both are active (the rule coupon redemption applies). */
  isActive: boolean;
  usageCount: number;
  usageLimit: number | null;
  perUserLimit: number | null;
}

export interface CouponStatusChange {
  coupon: CouponStatus;
  /** false when the coupon already had the requested state (nothing written). */
  changed: boolean;
}

export interface CouponRedemptionRecord {
  id: string;
  couponId: string;
  enrollmentId: string;
  studentUserId: string;
  studentName?: string | undefined;
  discountAmount: number;
  /** As stored; its allowed values are not visible to the application. */
  redemptionStatus?: string | undefined;
  redeemedAt: string;
}

export interface FinancialHistoryEntry {
  id: string;
  entityType: string;
  entityId: string;
  actionType: string;
  oldValues?: unknown;
  newValues?: unknown;
  reason?: string | undefined;
  performedByUserId: string;
  performedByName?: string | undefined;
  performedAt: string;
}

export interface RefundDetail {
  id: string;
  refundReference: string;
  amount: number;
  reason: string;
  refundStatus: string;
  requestedByUserId: string;
  requestedByName?: string | undefined;
  requestedAt: string;
  approvedBySuperAdminUserId?: string | undefined;
  approvedAt?: string | undefined;
  completedAt?: string | undefined;
  gatewayRefundId?: string | undefined;
  transaction: {
    id: string;
    amount: number;
    transactionStatus: string;
    paymentMethod?: string | undefined;
    processedAt?: string | undefined;
    paymentOrderId: string;
    enrollmentId?: string | undefined;
    studentUserId?: string | undefined;
    studentName?: string | undefined;
  };
  history: FinancialHistoryEntry[];
}

export interface Scholarship {
  id: string;
  name: string;
  description?: string | undefined;
  discountType: ScholarshipDiscountType;
  discountValue: number;
  startsAt?: string | undefined;
  endsAt?: string | undefined;
  isActive: boolean;
  createdAt: string;
  awardCount: number;
}

export interface ScholarshipInput {
  name: string;
  description?: string | undefined;
  discountType: ScholarshipDiscountType;
  discountValue: number;
  startsAt?: string | undefined;
  endsAt?: string | undefined;
  isActive: boolean;
}

export interface ScholarshipAward {
  id: string;
  scholarshipId: string;
  scholarshipName?: string | undefined;
  studentUserId: string;
  studentName?: string | undefined;
  enrollmentId: string;
  awardAmount: number;
  /** As stored; CK_NXA_ScholarshipAwards_Status values are not visible. */
  approvalStatus?: string | undefined;
  reason?: string | undefined;
  approvedByUserId?: string | undefined;
  approvedAt?: string | undefined;
  createdAt: string;
}

export interface FinanceRepository {
  /**
   * Sets NXA_Coupons.IsActive. Activation is refused (409) while the coupon's
   * discount is inactive, since the coupon would still be unusable. An
   * unchanged state writes nothing. Redemptions are never touched.
   */
  setCouponActive(couponId: string, isActive: boolean, reason: string | undefined, actorUserId: string): Promise<CouponStatusChange>;
  listCouponRedemptions(couponId: string): Promise<CouponRedemptionRecord[]>;

  getFinancialHistory(entityType: AdminHistoryEntityType, entityId: string): Promise<FinancialHistoryEntry[]>;

  /** Super Admin: one refund with its transaction and NXA_FinancialAuditHistory rows. */
  getRefundDetail(refundId: string): Promise<RefundDetail>;

  listScholarships(): Promise<Scholarship[]>;
  createScholarship(input: ScholarshipInput, actorUserId: string): Promise<Scholarship>;
  /** Unchanged state writes nothing. Existing awards are never touched. */
  setScholarshipActive(scholarshipId: string, isActive: boolean, reason: string | undefined, actorUserId: string): Promise<{ scholarship: Scholarship; changed: boolean }>;
  /** Read-only: award creation/approval is blocked on CK_NXA_ScholarshipAwards_Status. */
  listScholarshipAwards(filter: { scholarshipId?: string | undefined }): Promise<ScholarshipAward[]>;
}
