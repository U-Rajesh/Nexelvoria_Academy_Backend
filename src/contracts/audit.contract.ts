/**
 * A sink for administrative audit records (ADM-016, BR-007, BR-017).
 *
 * Modules other than `admin` receive one of these from the route registry,
 * which binds it to the admin repository's NXA_AuditLogs writer. Keeping it a
 * plain function keeps those modules independent of the admin module.
 */
export interface AuditEntry {
  actorUserId: string;
  actionType: string;
  moduleCode: string;
  entityName: string;
  entityId: string;
  details?: string;
  oldValues?: string;
  newValues?: string;
}

export type AuditSink = (entry: AuditEntry) => Promise<void>;

/**
 * An audit entry handed to a repository, which writes it in the SAME
 * transaction as the change it records (SEC audit logs): both commit or
 * neither does, a failed audit write fails the change, and a no-op writes
 * neither. The repository supplies the module code, entity name and entity id.
 * Never carries a password, hash, token, OTP or message content.
 */
export type TransactionalAuditEntry = Omit<AuditEntry, "moduleCode" | "entityName" | "entityId">;
