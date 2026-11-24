import sql from "mssql";
import { getSqlServerPool } from "../../db/sqlserver.pool";
import { writeFinancialAuditHistory } from "../../db/history-writers";
import { RecordNotFoundError } from "../../repositories/repository.errors";
import { writeAuditLog } from "../admin/sqlserver-admin.repository";
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
} from "./finance.repository";

const isId = (id: string | undefined | null): id is string => typeof id === "string" && /^\d{1,19}$/.test(id);
const iso = (d: Date | string | null | undefined): string | undefined => (d ? new Date(d).toISOString() : undefined);
const parseJson = (v: string | null | undefined): unknown => {
  if (v == null) return undefined;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

/* eslint-disable @typescript-eslint/no-explicit-any */
const toCouponStatus = (r: any): CouponStatus => ({
  id: String(r.CouponId),
  code: r.CouponCode,
  discountId: String(r.DiscountId),
  couponActive: Boolean(r.CouponActive),
  discountActive: Boolean(r.DiscountActive),
  isActive: Boolean(r.CouponActive) && Boolean(r.DiscountActive),
  usageCount: Number(r.UsageCount ?? 0),
  usageLimit: r.UsageLimit ?? null,
  perUserLimit: r.PerUserLimit ?? null,
});

const toScholarship = (r: any): Scholarship => ({
  id: String(r.ScholarshipId),
  name: r.ScholarshipName,
  description: r.Description ?? undefined,
  discountType: String(r.DiscountType ?? "").toLowerCase() === "percentage" ? "percentage" : "fixed_amount",
  discountValue: Number(r.DiscountValue),
  startsAt: iso(r.StartsAt),
  endsAt: iso(r.EndsAt),
  isActive: Boolean(r.IsActive),
  createdAt: iso(r.CreatedAt) ?? "",
  awardCount: Number(r.AwardCount ?? 0),
});

const toHistory = (r: any): FinancialHistoryEntry => ({
  id: String(r.FinancialAuditHistoryId),
  entityType: r.EntityType,
  entityId: String(r.EntityId),
  actionType: r.ActionType,
  oldValues: parseJson(r.OldValues),
  newValues: parseJson(r.NewValues),
  reason: r.Reason ?? undefined,
  performedByUserId: String(r.PerformedByUserId),
  performedByName: r.PerformedByName ?? undefined,
  performedAt: iso(r.PerformedAt) ?? "",
});
/* eslint-enable @typescript-eslint/no-explicit-any */

const COUPON_SELECT = `
  SELECT c.CouponId, c.CouponCode, c.DiscountId, c.IsActive AS CouponActive, d.IsActive AS DiscountActive,
         c.UsageCount, c.UsageLimit, c.PerUserLimit
  FROM dbo.NXA_Coupons c
  JOIN dbo.NXA_Discounts d ON d.DiscountId = c.DiscountId
`;

const SCHOLARSHIP_SELECT = `
  SELECT s.ScholarshipId, s.ScholarshipName, s.Description, s.DiscountType, s.DiscountValue, s.StartsAt, s.EndsAt,
         s.IsActive, s.CreatedAt,
         (SELECT COUNT(1) FROM dbo.NXA_ScholarshipAwards a WHERE a.ScholarshipId = s.ScholarshipId) AS AwardCount
  FROM dbo.NXA_Scholarships s
`;

const HISTORY_SELECT = `
  SELECT h.FinancialAuditHistoryId, h.EntityType, h.EntityId, h.ActionType, h.OldValues, h.NewValues, h.Reason,
         h.PerformedByUserId, u.FullName AS PerformedByName, h.PerformedAt
  FROM dbo.NXA_FinancialAuditHistory h
  LEFT JOIN dbo.NXA_Users u ON u.UserId = h.PerformedByUserId
`;

export class SqlServerFinanceRepository implements FinanceRepository {
  constructor(private readonly getPool: () => Promise<sql.ConnectionPool> = getSqlServerPool) {}

  private async inTransaction<T>(work: (tx: sql.Transaction) => Promise<T>): Promise<T> {
    const pool = await this.getPool();
    const tx = pool.transaction();
    await tx.begin();
    try {
      const result = await work(tx);
      await tx.commit();
      return result;
    } catch (err) {
      try {
        await tx.rollback();
      } catch {
        // the original error is the one worth reporting
      }
      throw err;
    }
  }

  // ------------------------------------------------------------------ coupons
  async setCouponActive(couponId: string, isActive: boolean, reason: string | undefined, actorUserId: string): Promise<CouponStatusChange> {
    if (!isId(couponId)) throw new RecordNotFoundError("coupon", couponId);
    return this.inTransaction(async (tx) => {
      const cur = await tx
        .request()
        .input("Id", sql.BigInt, couponId)
        .query(`
          SELECT c.CouponId, c.CouponCode, c.DiscountId, c.IsActive AS CouponActive, d.IsActive AS DiscountActive,
                 c.UsageCount, c.UsageLimit, c.PerUserLimit
          FROM dbo.NXA_Coupons c WITH (UPDLOCK, HOLDLOCK)
          JOIN dbo.NXA_Discounts d ON d.DiscountId = c.DiscountId
          WHERE c.CouponId = @Id
        `);
      const row = cur.recordset[0];
      if (!row) throw new RecordNotFoundError("coupon", couponId);
      const before = toCouponStatus(row);
      if (before.couponActive === isActive) return { coupon: before, changed: false };
      if (isActive && !before.discountActive) {
        throw new FinanceRuleError(
          "DISCOUNT_INACTIVE",
          "The coupon's discount is inactive, so the coupon would still be unusable. It was not activated.",
          409,
        );
      }

      const upd = await tx
        .request()
        .input("Id", sql.BigInt, couponId)
        .input("Active", sql.Bit, isActive)
        .input("Was", sql.Bit, before.couponActive)
        .query(`UPDATE dbo.NXA_Coupons SET IsActive = @Active WHERE CouponId = @Id AND IsActive = @Was`);
      if ((upd.rowsAffected[0] ?? 0) !== 1) {
        throw new FinanceRuleError("COUPON_CHANGED", "The coupon was changed by someone else. Reload and retry.", 409);
      }

      const action = isActive ? "ACTIVATE_COUPON" : "DEACTIVATE_COUPON";
      await writeAuditLog(tx.request(), {
        actorUserId,
        actionType: action,
        moduleCode: "FINANCE",
        entityName: "Coupon",
        entityId: couponId,
        oldValues: JSON.stringify({ isActive: before.couponActive }),
        newValues: JSON.stringify({ isActive, code: before.code, ...(reason ? { reason } : {}) }),
      });
      await writeFinancialAuditHistory(tx.request(), {
        entityType: "Coupon",
        entityId: couponId,
        actionType: action,
        performedByUserId: actorUserId,
        oldValues: { isActive: before.couponActive },
        newValues: { isActive, code: before.code },
        reason,
      });
      const after: CouponStatus = { ...before, couponActive: isActive, isActive: isActive && before.discountActive };
      return { coupon: after, changed: true };
    });
  }

  async listCouponRedemptions(couponId: string): Promise<CouponRedemptionRecord[]> {
    if (!isId(couponId)) throw new RecordNotFoundError("coupon", couponId);
    const pool = await this.getPool();
    const c = await pool.request().input("Id", sql.BigInt, couponId).query(`${COUPON_SELECT} WHERE c.CouponId = @Id`);
    if (c.recordset.length === 0) throw new RecordNotFoundError("coupon", couponId);
    const r = await pool.request().input("Id", sql.BigInt, couponId).query(`
      SELECT cr.CouponRedemptionId, cr.CouponId, cr.EnrollmentId, cr.StudentUserId, u.FullName AS StudentName,
             cr.DiscountAmount, cr.RedemptionStatus, cr.RedeemedAt
      FROM dbo.NXA_CouponRedemptions cr
      LEFT JOIN dbo.NXA_Users u ON u.UserId = cr.StudentUserId
      WHERE cr.CouponId = @Id
      ORDER BY cr.RedeemedAt DESC, cr.CouponRedemptionId DESC
    `);
    return r.recordset.map((x) => ({
      id: String(x.CouponRedemptionId),
      couponId: String(x.CouponId),
      enrollmentId: String(x.EnrollmentId),
      studentUserId: String(x.StudentUserId),
      studentName: x.StudentName ?? undefined,
      discountAmount: Number(x.DiscountAmount),
      redemptionStatus: x.RedemptionStatus ?? undefined,
      redeemedAt: iso(x.RedeemedAt) ?? "",
    }));
  }

  // ------------------------------------------------------------------ history
  async getFinancialHistory(entityType: AdminHistoryEntityType, entityId: string): Promise<FinancialHistoryEntry[]> {
    if (!isId(entityId)) return [];
    const pool = await this.getPool();
    const r = await pool
      .request()
      .input("Type", sql.VarChar(40), entityType)
      .input("Id", sql.BigInt, entityId)
      .query(`${HISTORY_SELECT} WHERE h.EntityType = @Type AND h.EntityId = @Id ORDER BY h.PerformedAt DESC, h.FinancialAuditHistoryId DESC`);
    return r.recordset.map(toHistory);
  }

  // ------------------------------------------------------------------ refunds
  async getRefundDetail(refundId: string): Promise<RefundDetail> {
    if (!isId(refundId)) throw new RecordNotFoundError("refund", refundId);
    const pool = await this.getPool();
    const r = await pool.request().input("Id", sql.BigInt, refundId).query(`
      SELECT r.RefundId, r.RefundReference, r.Amount, r.Reason, r.RefundStatus, r.RequestedByUserId, ru.FullName AS RequestedByName,
             r.RequestedAt, r.ApprovedBySuperAdminUserId, r.ApprovedAt, r.CompletedAt, r.GatewayRefundId,
             t.TransactionId, t.Amount AS TransactionAmount, t.TransactionStatus, t.PaymentMethod, t.ProcessedAt, t.PaymentOrderId,
             po.EnrollmentId, po.StudentUserId, su.FullName AS StudentName
      FROM dbo.NXA_Refunds r
      JOIN dbo.NXA_Transactions t ON t.TransactionId = r.TransactionId
      LEFT JOIN dbo.NXA_PaymentOrders po ON po.PaymentOrderId = t.PaymentOrderId
      LEFT JOIN dbo.NXA_Users ru ON ru.UserId = r.RequestedByUserId
      LEFT JOIN dbo.NXA_Users su ON su.UserId = po.StudentUserId
      WHERE r.RefundId = @Id
    `);
    const x = r.recordset[0];
    if (!x) throw new RecordNotFoundError("refund", refundId);
    const h = await pool
      .request()
      .input("Id", sql.BigInt, refundId)
      .query(`${HISTORY_SELECT} WHERE h.EntityType = 'Refund' AND h.EntityId = @Id ORDER BY h.PerformedAt DESC, h.FinancialAuditHistoryId DESC`);
    return {
      id: String(x.RefundId),
      refundReference: x.RefundReference,
      amount: Number(x.Amount),
      reason: x.Reason,
      refundStatus: String(x.RefundStatus ?? "").toLowerCase(),
      requestedByUserId: String(x.RequestedByUserId),
      requestedByName: x.RequestedByName ?? undefined,
      requestedAt: iso(x.RequestedAt) ?? "",
      approvedBySuperAdminUserId: x.ApprovedBySuperAdminUserId != null ? String(x.ApprovedBySuperAdminUserId) : undefined,
      approvedAt: iso(x.ApprovedAt),
      completedAt: iso(x.CompletedAt),
      gatewayRefundId: x.GatewayRefundId ?? undefined,
      transaction: {
        id: String(x.TransactionId),
        amount: Number(x.TransactionAmount),
        transactionStatus: x.TransactionStatus,
        paymentMethod: x.PaymentMethod ?? undefined,
        processedAt: iso(x.ProcessedAt),
        paymentOrderId: String(x.PaymentOrderId),
        enrollmentId: x.EnrollmentId != null ? String(x.EnrollmentId) : undefined,
        studentUserId: x.StudentUserId != null ? String(x.StudentUserId) : undefined,
        studentName: x.StudentName ?? undefined,
      },
      history: h.recordset.map(toHistory),
    };
  }

  // ------------------------------------------------------------- scholarships
  private async getScholarship(id: string): Promise<Scholarship | null> {
    const pool = await this.getPool();
    const r = await pool.request().input("Id", sql.BigInt, id).query(`${SCHOLARSHIP_SELECT} WHERE s.ScholarshipId = @Id`);
    return r.recordset[0] ? toScholarship(r.recordset[0]) : null;
  }

  async listScholarships(): Promise<Scholarship[]> {
    const pool = await this.getPool();
    const r = await pool.request().query(`${SCHOLARSHIP_SELECT} ORDER BY s.CreatedAt DESC, s.ScholarshipId DESC`);
    return r.recordset.map(toScholarship);
  }

  async createScholarship(input: ScholarshipInput, actorUserId: string): Promise<Scholarship> {
    if (input.discountType === "percentage" && input.discountValue > 100) {
      throw new FinanceRuleError("PERCENTAGE_OVER_100", "A percentage scholarship cannot exceed 100.");
    }
    if (input.startsAt && input.endsAt && new Date(input.endsAt) <= new Date(input.startsAt)) {
      throw new FinanceRuleError("INVALID_DATE_RANGE", "The scholarship must end after it starts.");
    }
    const id = await this.inTransaction(async (tx) => {
      const ins = await tx
        .request()
        .input("Name", sql.NVarChar(150), input.name)
        .input("Description", sql.NVarChar(1000), input.description ?? null)
        .input("Type", sql.VarChar(15), input.discountType)
        .input("Value", sql.Decimal(12, 2), input.discountValue)
        .input("StartsAt", sql.DateTime2, input.startsAt ? new Date(input.startsAt) : null)
        .input("EndsAt", sql.DateTime2, input.endsAt ? new Date(input.endsAt) : null)
        .input("Active", sql.Bit, input.isActive)
        .query<{ ScholarshipId: number | bigint }>(`
          INSERT INTO dbo.NXA_Scholarships (ScholarshipName, Description, DiscountType, DiscountValue, StartsAt, EndsAt, IsActive, CreatedAt)
          OUTPUT INSERTED.ScholarshipId
          VALUES (@Name, @Description, @Type, @Value, @StartsAt, @EndsAt, @Active, SYSUTCDATETIME())
        `);
      const newId = String(ins.recordset[0]?.ScholarshipId);
      const values = { name: input.name, discountType: input.discountType, discountValue: input.discountValue, isActive: input.isActive };
      await writeAuditLog(tx.request(), {
        actorUserId,
        actionType: "CREATE_SCHOLARSHIP",
        moduleCode: "FINANCE",
        entityName: "Scholarship",
        entityId: newId,
        newValues: JSON.stringify(values),
      });
      await writeFinancialAuditHistory(tx.request(), {
        entityType: "Scholarship",
        entityId: newId,
        actionType: "CREATE_SCHOLARSHIP",
        performedByUserId: actorUserId,
        newValues: values,
      });
      return newId;
    });
    const created = await this.getScholarship(id);
    if (!created) throw new RecordNotFoundError("scholarship", id);
    return created;
  }

  async setScholarshipActive(
    scholarshipId: string,
    isActive: boolean,
    reason: string | undefined,
    actorUserId: string,
  ): Promise<{ scholarship: Scholarship; changed: boolean }> {
    if (!isId(scholarshipId)) throw new RecordNotFoundError("scholarship", scholarshipId);
    const changed = await this.inTransaction(async (tx) => {
      const cur = await tx
        .request()
        .input("Id", sql.BigInt, scholarshipId)
        .query<{ IsActive: boolean }>(`SELECT IsActive FROM dbo.NXA_Scholarships WITH (UPDLOCK, HOLDLOCK) WHERE ScholarshipId = @Id`);
      const row = cur.recordset[0];
      if (!row) throw new RecordNotFoundError("scholarship", scholarshipId);
      if (Boolean(row.IsActive) === isActive) return false;
      await tx
        .request()
        .input("Id", sql.BigInt, scholarshipId)
        .input("Active", sql.Bit, isActive)
        .query(`UPDATE dbo.NXA_Scholarships SET IsActive = @Active WHERE ScholarshipId = @Id`);
      const action = isActive ? "ACTIVATE_SCHOLARSHIP" : "DEACTIVATE_SCHOLARSHIP";
      await writeAuditLog(tx.request(), {
        actorUserId,
        actionType: action,
        moduleCode: "FINANCE",
        entityName: "Scholarship",
        entityId: scholarshipId,
        oldValues: JSON.stringify({ isActive: Boolean(row.IsActive) }),
        newValues: JSON.stringify({ isActive, ...(reason ? { reason } : {}) }),
      });
      await writeFinancialAuditHistory(tx.request(), {
        entityType: "Scholarship",
        entityId: scholarshipId,
        actionType: action,
        performedByUserId: actorUserId,
        oldValues: { isActive: Boolean(row.IsActive) },
        newValues: { isActive },
        reason,
      });
      return true;
    });
    const scholarship = await this.getScholarship(scholarshipId);
    if (!scholarship) throw new RecordNotFoundError("scholarship", scholarshipId);
    return { scholarship, changed };
  }

  async listScholarshipAwards(filter: { scholarshipId?: string | undefined }): Promise<ScholarshipAward[]> {
    const pool = await this.getPool();
    const req = pool.request();
    let where = "1=1";
    if (filter.scholarshipId !== undefined) {
      if (!isId(filter.scholarshipId)) return [];
      req.input("ScholarshipId", sql.BigInt, filter.scholarshipId);
      where = "a.ScholarshipId = @ScholarshipId";
    }
    const r = await req.query(`
      SELECT a.ScholarshipAwardId, a.ScholarshipId, s.ScholarshipName, a.StudentUserId, u.FullName AS StudentName, a.EnrollmentId,
             a.AwardAmount, a.ApprovalStatus, a.Reason, a.ApprovedByUserId, a.ApprovedAt, a.CreatedAt
      FROM dbo.NXA_ScholarshipAwards a
      LEFT JOIN dbo.NXA_Scholarships s ON s.ScholarshipId = a.ScholarshipId
      LEFT JOIN dbo.NXA_Users u ON u.UserId = a.StudentUserId
      WHERE ${where}
      ORDER BY a.CreatedAt DESC, a.ScholarshipAwardId DESC
    `);
    return r.recordset.map((x) => ({
      id: String(x.ScholarshipAwardId),
      scholarshipId: String(x.ScholarshipId),
      scholarshipName: x.ScholarshipName ?? undefined,
      studentUserId: String(x.StudentUserId),
      studentName: x.StudentName ?? undefined,
      enrollmentId: String(x.EnrollmentId),
      awardAmount: Number(x.AwardAmount),
      approvalStatus: x.ApprovalStatus ?? undefined,
      reason: x.Reason ?? undefined,
      approvedByUserId: x.ApprovedByUserId != null ? String(x.ApprovedByUserId) : undefined,
      approvedAt: iso(x.ApprovedAt),
      createdAt: iso(x.CreatedAt) ?? "",
    }));
  }
}
