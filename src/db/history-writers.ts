import sql from "mssql";

/**
 * History rows written inside the caller's transaction (pass `tx.request()`),
 * so a failed history insert rolls back the business change with it.
 *
 * Live schema:
 *  - NXA_EnrollmentStatusHistory: EnrollmentId bigint, OldStatus varchar(25) NULL,
 *    NewStatus varchar(25), ChangedByUserId bigint NULL, ChangeReason nvarchar(500) NULL,
 *    ChangedAt datetime2 (set explicitly here).
 *  - NXA_FinancialAuditHistory (PAY-013): EntityType varchar(40), EntityId bigint,
 *    ActionType varchar(40), OldValues / NewValues nvarchar(max) NULL,
 *    PerformedByUserId bigint NOT NULL, Reason nvarchar(500) NULL,
 *    PerformedAt datetime2 (set explicitly here).
 * Neither table has CHECK constraints. Status values are copied exactly as
 * stored in NXA_Enrollments.EnrollmentStatus.
 */

export interface EnrollmentStatusHistoryInput {
  enrollmentId: string;
  /** NULL for a newly created enrollment. */
  oldStatus: string | null;
  newStatus: string;
  /** NULL when no user made the change (e.g. a verified gateway payment). */
  changedByUserId: string | null;
  reason?: string | null | undefined;
}

export const writeEnrollmentStatusHistory = async (req: sql.Request, h: EnrollmentStatusHistoryInput): Promise<void> => {
  req.input("hEnrollmentId", sql.BigInt, h.enrollmentId);
  req.input("hOldStatus", sql.VarChar(25), h.oldStatus);
  req.input("hNewStatus", sql.VarChar(25), h.newStatus);
  req.input("hChangedBy", sql.BigInt, h.changedByUserId);
  req.input("hReason", sql.NVarChar(500), h.reason ?? null);
  await req.query(`
    INSERT INTO dbo.NXA_EnrollmentStatusHistory (EnrollmentId, OldStatus, NewStatus, ChangedByUserId, ChangeReason, ChangedAt)
    VALUES (@hEnrollmentId, @hOldStatus, @hNewStatus, @hChangedBy, @hReason, SYSUTCDATETIME())
  `);
};

export interface FinancialAuditHistoryInput {
  entityType: string;
  entityId: string;
  actionType: string;
  performedByUserId: string;
  oldValues?: unknown;
  newValues?: unknown;
  reason?: string | null | undefined;
}

export const writeFinancialAuditHistory = async (req: sql.Request, f: FinancialAuditHistoryInput): Promise<void> => {
  req.input("fEntityType", sql.VarChar(40), f.entityType);
  req.input("fEntityId", sql.BigInt, f.entityId);
  req.input("fActionType", sql.VarChar(40), f.actionType);
  req.input("fOld", sql.NVarChar(sql.MAX), f.oldValues === undefined ? null : JSON.stringify(f.oldValues));
  req.input("fNew", sql.NVarChar(sql.MAX), f.newValues === undefined ? null : JSON.stringify(f.newValues));
  req.input("fPerformedBy", sql.BigInt, f.performedByUserId);
  req.input("fReason", sql.NVarChar(500), f.reason ?? null);
  await req.query(`
    INSERT INTO dbo.NXA_FinancialAuditHistory (EntityType, EntityId, ActionType, OldValues, NewValues, PerformedByUserId, Reason, PerformedAt)
    VALUES (@fEntityType, @fEntityId, @fActionType, @fOld, @fNew, @fPerformedBy, @fReason, SYSUTCDATETIME())
  `);
};
