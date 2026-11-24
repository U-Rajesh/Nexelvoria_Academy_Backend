import { RecordNotFoundError } from "../../src/repositories/repository.errors";
import {
  FinanceRuleError,
  type AdminHistoryEntityType,
  type CouponRedemptionRecord,
  type CouponStatus,
  type CouponStatusChange,
  type FinanceRepository,
  type FinancialHistoryEntry,
  type RefundDetail,
  type Scholarship,
  type ScholarshipAward,
  type ScholarshipInput,
} from "../../src/modules/finance/finance.repository";

export interface FakeCoupon { id: string; code: string; discountId: string; couponActive: boolean; discountActive: boolean; usageCount: number; usageLimit: number | null; perUserLimit: number | null }
export interface FakeAudit { actorUserId: string; actionType: string; entityName: string; entityId: string }

export class InMemoryFinanceRepository implements FinanceRepository {
  coupons: FakeCoupon[] = [];
  redemptions: CouponRedemptionRecord[] = [];
  history: FinancialHistoryEntry[] = [];
  refunds: Array<Omit<RefundDetail, "history">> = [];
  scholarships: Scholarship[] = [];
  awards: ScholarshipAward[] = [];
  auditLogs: FakeAudit[] = [];
  /** Test hook: the financial history write fails (proves rollback). */
  failHistory = false;
  private seq = 5000;

  reset(): void {
    this.coupons = [];
    this.redemptions = [];
    this.history = [];
    this.refunds = [];
    this.scholarships = [];
    this.awards = [];
    this.auditLogs = [];
    this.failHistory = false;
  }

  private nextId(): string {
    return String(++this.seq);
  }

  /** Snapshot/restore, so a failed write leaves nothing behind (transaction). */
  private tx<T>(work: () => T): T {
    const snap = {
      coupons: this.coupons.map((c) => ({ ...c })),
      scholarships: this.scholarships.map((s) => ({ ...s })),
      history: [...this.history],
      auditLogs: [...this.auditLogs],
    };
    try {
      return work();
    } catch (err) {
      Object.assign(this, snap);
      throw err;
    }
  }

  private record(audit: FakeAudit, h: Omit<FinancialHistoryEntry, "id" | "performedAt" | "performedByUserId" | "entityId" | "actionType">): void {
    this.auditLogs.push(audit);
    if (this.failHistory) throw new Error("financial history write failed");
    this.history.push({ id: this.nextId(), entityId: audit.entityId, actionType: audit.actionType, performedByUserId: audit.actorUserId, performedAt: new Date().toISOString(), ...h });
  }

  private status(c: FakeCoupon): CouponStatus {
    return { id: c.id, code: c.code, discountId: c.discountId, couponActive: c.couponActive, discountActive: c.discountActive, isActive: c.couponActive && c.discountActive, usageCount: c.usageCount, usageLimit: c.usageLimit, perUserLimit: c.perUserLimit };
  }

  async setCouponActive(couponId: string, isActive: boolean, reason: string | undefined, actorUserId: string): Promise<CouponStatusChange> {
    const c = this.coupons.find((x) => x.id === couponId);
    if (!c) throw new RecordNotFoundError("coupon", couponId);
    if (c.couponActive === isActive) return { coupon: this.status(c), changed: false };
    if (isActive && !c.discountActive) throw new FinanceRuleError("DISCOUNT_INACTIVE", "The coupon's discount is inactive.", 409);
    return this.tx(() => {
      const was = c.couponActive;
      c.couponActive = isActive;
      const action = isActive ? "ACTIVATE_COUPON" : "DEACTIVATE_COUPON";
      this.record(
        { actorUserId, actionType: action, entityName: "Coupon", entityId: couponId },
        { entityType: "Coupon", oldValues: { isActive: was }, newValues: { isActive, code: c.code }, reason },
      );
      return { coupon: this.status(c), changed: true };
    });
  }

  async listCouponRedemptions(couponId: string): Promise<CouponRedemptionRecord[]> {
    if (!this.coupons.some((c) => c.id === couponId)) throw new RecordNotFoundError("coupon", couponId);
    return this.redemptions.filter((r) => r.couponId === couponId);
  }

  async getFinancialHistory(entityType: AdminHistoryEntityType, entityId: string): Promise<FinancialHistoryEntry[]> {
    return this.history.filter((h) => h.entityType === entityType && h.entityId === entityId).reverse();
  }

  async getRefundDetail(refundId: string): Promise<RefundDetail> {
    const r = this.refunds.find((x) => x.id === refundId);
    if (!r) throw new RecordNotFoundError("refund", refundId);
    return { ...r, history: this.history.filter((h) => h.entityType === "Refund" && h.entityId === refundId).reverse() };
  }

  async listScholarships(): Promise<Scholarship[]> {
    return this.scholarships.map((s) => ({ ...s, awardCount: this.awards.filter((a) => a.scholarshipId === s.id).length }));
  }

  async createScholarship(input: ScholarshipInput, actorUserId: string): Promise<Scholarship> {
    if (input.discountType === "percentage" && input.discountValue > 100) throw new FinanceRuleError("PERCENTAGE_OVER_100", "Over 100.");
    return this.tx(() => {
      const s: Scholarship = {
        id: this.nextId(), name: input.name, description: input.description, discountType: input.discountType, discountValue: input.discountValue,
        startsAt: input.startsAt, endsAt: input.endsAt, isActive: input.isActive, createdAt: new Date().toISOString(), awardCount: 0,
      };
      this.scholarships.push(s);
      this.record(
        { actorUserId, actionType: "CREATE_SCHOLARSHIP", entityName: "Scholarship", entityId: s.id },
        { entityType: "Scholarship", newValues: { name: s.name, discountType: s.discountType, discountValue: s.discountValue, isActive: s.isActive } },
      );
      return { ...s };
    });
  }

  async setScholarshipActive(scholarshipId: string, isActive: boolean, reason: string | undefined, actorUserId: string): Promise<{ scholarship: Scholarship; changed: boolean }> {
    const s = this.scholarships.find((x) => x.id === scholarshipId);
    if (!s) throw new RecordNotFoundError("scholarship", scholarshipId);
    if (s.isActive === isActive) return { scholarship: { ...s }, changed: false };
    return this.tx(() => {
      const was = s.isActive;
      s.isActive = isActive;
      const action = isActive ? "ACTIVATE_SCHOLARSHIP" : "DEACTIVATE_SCHOLARSHIP";
      this.record(
        { actorUserId, actionType: action, entityName: "Scholarship", entityId: scholarshipId },
        { entityType: "Scholarship", oldValues: { isActive: was }, newValues: { isActive }, reason },
      );
      return { scholarship: { ...s }, changed: true };
    });
  }

  async listScholarshipAwards(filter: { scholarshipId?: string | undefined }): Promise<ScholarshipAward[]> {
    return this.awards.filter((a) => filter.scholarshipId === undefined || a.scholarshipId === filter.scholarshipId);
  }
}
