/**
 * In-memory stand-in for NXA_EnrollmentStatusHistory and
 * NXA_FinancialAuditHistory, shared by the fakes that mirror the SQL writes.
 */
export interface EnrollmentStatusHistoryRow {
  enrollmentId: string;
  oldStatus: string | null;
  newStatus: string;
  changedByUserId: string | null;
  reason?: string | undefined;
}

export interface FinancialAuditHistoryRow {
  entityType: string;
  entityId: string;
  actionType: string;
  performedByUserId: string;
  oldValues?: unknown;
  newValues?: unknown;
  reason?: string | undefined;
}

export class HistoryLog {
  enrollmentStatus: EnrollmentStatusHistoryRow[] = [];
  financial: FinancialAuditHistoryRow[] = [];

  reset(): void {
    this.enrollmentStatus = [];
    this.financial = [];
  }
}
