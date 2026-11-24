import type { EntityId } from "../../contracts/identifier.contract";
import type { UserStatus } from "../../contracts/user.contract";
import type { AdminRepository, StaffAudit } from "./admin.repository";
import type {
  AdminCreatedStudent,
  AdminProfile,
  AuditLogRecord,
  BatchRecord,
  DashboardStats,
  EnrollmentAdminRecord,
  FinancialOverrideRecord,
  GlobalRoleRecord,
  InstituteSettingsRecord,
  RefundRecord,
  SuperAdminDashboardStats,
} from "./admin.types";
import type {
  AllocateTeacherBody,
  CreateAdminBody,
  CreateBatchBody,
  CreateEnrollmentAdminBody,
  CreateRoleBody,
  CreateStudentAdminBody,
  CreateTeacherAdminBody,
  UpdateTeacherAdminBody,
  TeacherStatusBody,
  InstituteSettingsBody,
  UpdateAdminBody,
  UpdateBatchBody,
} from "./admin.validation";
import type { Student } from "../students/student.types";
import type { Teacher } from "../teachers/teacher.types";
import type { SessionRepository } from "../auth/session.repository";
import type { VerificationService } from "../auth/verification.service";
import { buildSystemConfigStatus, type SystemConfigStatus, type TestMailer } from "./system-config";
import { generateTemporaryPassword, hashPassword } from "../auth/password.service";
import { DuplicateRecordError, RecordNotFoundError } from "../../repositories/repository.errors";
import { ApiError } from "../../utils/api-error";
import { HttpStatus } from "../../utils/http-status";
import { AdminRuleViolationError, type EnrollmentStatusValue } from "./admin.repository";
import type { BatchStatusValue } from "./admin.validation";
import { logger } from "../../utils/logger";
import { BLOCKED_SETTING_KEYS, SETTINGS_CATALOG, settingDefinition, type SettingDefinition } from "./settings-catalog";
import { effectiveLockoutThreshold } from "../auth/credential.types";
import { placementRate } from "./placement-rate";
import { financialYearStartDay, istDayStartUtc, istToday } from "../reports/reports.rules";
import type { MaintenanceBody } from "./admin.validation";
import { DEFAULT_MAINTENANCE_MESSAGE } from "../../middleware/maintenance.middleware";

export interface AdminServiceDeps {
  admin: AdminRepository;
  /**
   * Session store, used to revoke access when an admin is suspended or has
   * their password reset. A factory so the container resolves it lazily.
   */
  sessions?: () => SessionRepository;
  /**
   * Email OTP issue (BR-001), reused from the auth module for admin-created
   * students. Absent when the OTP store is not configured; the response then
   * says no code was sent rather than pretending one was.
   */
  verification?: Pick<VerificationService, "sendEmailChallenge">;
  /**
   * Real SMTP sender for the Super Admin test email. Absent when SMTP is not
   * configured; the endpoint then refuses rather than reporting a send.
   */
  testMailer?: TestMailer | undefined;
  /** Environment the configuration report is built from (tests inject one). */
  configSource?: NodeJS.ProcessEnv;
  /** Called after settings are saved (the maintenance guard drops its cached state). */
  onSettingsChanged?: () => void;
}

/** Outcome of one BR-001 verification channel for a newly created student. */
export type VerificationChannelStatus =
  | { status: "sent"; sentTo: string; expiresAt: string }
  | { status: "not_sent"; reason: string }
  | { status: "unavailable"; reason: string }
  /** Not performed at launch by approved decision (CL-001); not a failure. */
  | { status: "deferred"; reason: string };

/**
 * Mobile OTP is deferred at launch (BR-001 clarification CL-001; BR-014: SMS
 * disabled). The mobile number is stored and stays unverified.
 */
export const MOBILE_OTP_DEFERRED_REASON =
  "Mobile OTP verification is deferred at launch (BR-001 clarification CL-001; SMS is disabled under BR-014). " +
  "The mobile number is stored unverified.";

export interface StudentAccountCreated extends StaffAccountCreated<AdminCreatedStudent> {
  verification: { email: VerificationChannelStatus; mobile: VerificationChannelStatus };
}

export interface AdminService {
  getDashboardStats(): Promise<DashboardStats>;
  /** D15 placement rate for a chosen IST date range (inclusive). */
  getPlacementRate(range: { from: string; to: string }): Promise<{ from: string; to: string; completedStudents: number; placedStudents: number; placementRate: number | null }>;
  getSuperAdminDashboardStats(): Promise<SuperAdminDashboardStats>;

  // Admins
  getAdmins(filter?: { search?: string | undefined; status?: string | undefined }): Promise<AdminProfile[]>;
  getAdminById(id: EntityId): Promise<AdminProfile | null>;
  createAdmin(actorId: EntityId, input: CreateAdminBody): Promise<StaffAccountCreated<AdminProfile>>;
  updateAdmin(actorId: EntityId, id: EntityId, input: UpdateAdminBody): Promise<AdminProfile>;
  setAdminStatus(actorId: EntityId, id: EntityId, status: UserStatus): Promise<AdminProfile>;
  resetAdminPassword(actorId: EntityId, id: EntityId): Promise<{ temporaryPassword: string }>;

  // Batches
  getBatches(filter?: { courseId?: string | undefined; status?: string | undefined }): Promise<BatchRecord[]>;
  getBatchById(id: EntityId): Promise<BatchRecord | null>;
  createBatch(actorId: EntityId, input: CreateBatchBody): Promise<BatchRecord>;
  updateBatch(actorId: EntityId, id: EntityId, input: UpdateBatchBody): Promise<BatchRecord>;
  setBatchStatus(actorId: EntityId, id: EntityId, status: BatchStatusValue): Promise<BatchRecord>;
  allocateTeacher(actorId: EntityId, batchId: EntityId, input: AllocateTeacherBody): Promise<void>;
  unallocateTeacher(actorId: EntityId, batchId: EntityId, teacherId: EntityId): Promise<void>;
  getBatchStudents(batchId: EntityId): Promise<Student[]>;

  // Enrollments
  getEnrollments(filter?: {
    studentId?: string | undefined;
    courseId?: string | undefined;
    batchId?: string | undefined;
    status?: string | undefined;
  }): Promise<EnrollmentAdminRecord[]>;
  createEnrollment(actorId: EntityId, input: CreateEnrollmentAdminBody): Promise<EnrollmentAdminRecord>;
  setEnrollmentStatus(actorId: EntityId, id: EntityId, status: EnrollmentStatusValue, reason?: string): Promise<EnrollmentAdminRecord>;

  // Audit Logs
  getAuditLogs(filter?: {
    actorUserId?: string | undefined;
    moduleCode?: string | undefined;
    startDate?: string | undefined;
    endDate?: string | undefined;
  }): Promise<AuditLogRecord[]>;

  // Settings & System Config
  getInstituteSettings(): Promise<InstituteSettingsRecord>;
  saveInstituteSettings(actorId: EntityId, input: InstituteSettingsBody, actorRole?: string): Promise<InstituteSettingsRecord>;
  getSystemConfig(): Promise<SystemConfigStatus>;
  saveSystemConfig(): Promise<never>;
  getSettingsCatalog(): readonly SettingDefinition[];
  getMaintenance(): Promise<{ enabled: boolean; message: string }>;
  setMaintenance(actorId: EntityId, input: MaintenanceBody): Promise<{ enabled: boolean; message: string }>;
  sendTestEmail(actorId: EntityId, recipientEmail: string): Promise<{ sentTo: string; messageId: string; sentAt: string }>;

  // Refunds & Financial Overrides
  getRefunds(status?: string | undefined): Promise<RefundRecord[]>;
  decideRefund(
    actorId: EntityId,
    id: EntityId,
    status: "approved" | "rejected",
    remarks?: string | undefined,
  ): Promise<RefundRecord>;
  getFinancialOverrides(status?: string | undefined): Promise<FinancialOverrideRecord[]>;
  decideFinancialOverride(
    actorId: EntityId,
    id: EntityId,
    status: "approved" | "rejected",
    remarks?: string | undefined,
  ): Promise<FinancialOverrideRecord>;

  // Roles & Permissions
  getRoles(): Promise<GlobalRoleRecord[]>;
  createRole(actorId: EntityId, input: CreateRoleBody): Promise<GlobalRoleRecord>;
  updateRolePermissions(actorId: EntityId, roleId: EntityId, permissions: string[]): Promise<GlobalRoleRecord>;

  // User & Teacher Oversight
  unlockAccount(actorId: EntityId, userId: EntityId): Promise<void>;
  getTeachers(filter?: { search?: string | undefined; status?: string | undefined }): Promise<Teacher[]>;
  createTeacher(actorId: EntityId, input: CreateTeacherAdminBody): Promise<StaffAccountCreated<Teacher>>;
  updateTeacher(actorId: EntityId, id: EntityId, input: UpdateTeacherAdminBody): Promise<{ record: Teacher; changed: boolean }>;
  setTeacherStatus(actorId: EntityId, id: EntityId, input: TeacherStatusBody): Promise<{ record: Teacher; changed: boolean }>;
  createStudent(actorId: EntityId, input: CreateStudentAdminBody): Promise<StudentAccountCreated>;
}

/**
 * A staff account created by an administrator, plus its one-time temporary
 * password. The plaintext exists only in this response; only the argon2id
 * hash is persisted.
 */
export interface StaffAccountCreated<T> {
  account: T;
  temporaryPassword: string;
}

const rbacUnavailable = (): ApiError =>
  new ApiError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    "Role and permission management is not available yet: the permission catalog and role-permission " +
      "tables have not been verified. No change was made.",
    "RBAC_CATALOG_UNAVAILABLE",
  );

/** Translates repository-layer errors into HTTP errors at the service edge. */
const mapRepoErrors = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DuplicateRecordError) {
      const messages: Record<string, [string, string]> = {
        user: [`An account with this ${err.field} already exists`, "DUPLICATE_ACCOUNT"],
        batch: ["A batch with this code already exists", "DUPLICATE_BATCH_CODE"],
        allocation: ["This teacher is already allocated to the batch", "DUPLICATE_ALLOCATION"],
        enrollment: ["The student already has an enrollment in this course", "DUPLICATE_ENROLLMENT"],
      };
      const [message, code] = messages[err.entity] ?? [`This ${err.entity} already exists`, "DUPLICATE"];
      throw ApiError.conflict(message, code);
    }
    if (err instanceof RecordNotFoundError) {
      const label = err.entity === "admin" ? "Admin account" : err.entity.charAt(0).toUpperCase() + err.entity.slice(1);
      throw ApiError.notFound(`${label} not found`);
    }
    if (err instanceof AdminRuleViolationError) {
      throw new ApiError(err.status === 409 ? HttpStatus.CONFLICT : HttpStatus.UNPROCESSABLE_ENTITY, err.message, err.code);
    }
    throw err;
  }
};

export const createAdminService = (deps: AdminServiceDeps): AdminService => {
  const audit = async (
    actorId: EntityId,
    action: string,
    module: string,
    entityName: string,
    entityId: string,
    details?: string,
  ) => {
    try {
      await deps.admin.createAuditLog({
        actorUserId: actorId,
        actionType: action,
        moduleCode: module,
        entityName,
        entityId,
        ...(details ? { details } : {}),
      });
    } catch (err) {
      // Audit failure must not block the primary operation, but it must be visible.
      logger.error("audit log write failed", { action, module, entityName, entityId, err });
    }
  };

  /** An audit entry the repository writes in the same transaction as the change. */
  const staffAudit = (actorUserId: EntityId, actionType: string, moduleCode: string, entityName: string, details: string): StaffAudit => ({
    actorUserId,
    actionType,
    moduleCode,
    entityName,
    details,
  });

  /** D15: cohort placement rate for an inclusive IST date range. */
  const placementRateFor = async (range: { from: string; to: string }) => {
    if (range.from > range.to) throw ApiError.validation([{ field: "from", message: "The start date must not be after the end date." }]);
    const cohort = await deps.admin.getPlacementCohort({ fromUtc: istDayStartUtc(range.from), toUtc: istDayStartUtc(range.to, 1) });
    return { ...range, ...cohort, placementRate: placementRate(cohort) };
  };

  return {
    async getDashboardStats(): Promise<DashboardStats> {
      const base = await deps.admin.getDashboardStats();
      // D15: placement rate for the current Indian financial year to date.
      const period = { from: financialYearStartDay(), to: istToday() };
      const rate = await placementRateFor(period);
      // D15: open action queues. Every queue is read from its own store.
      const [refunds, overrides] = await Promise.all([deps.admin.findRefunds("pending"), deps.admin.findFinancialOverrides("pending")]);
      const systemAlerts = {
        pendingStudentApprovals: base.pendingApprovals,
        pendingRefundRequests: refunds.length,
        pendingFinancialOverrides: overrides.length,
      };
      return {
        ...base,
        placementRate: rate.placementRate,
        placementRatePeriod: period,
        placementCohort: { completedStudents: rate.completedStudents, placedStudents: rate.placedStudents },
        systemAlerts,
        systemAlertsCount: systemAlerts.pendingStudentApprovals + systemAlerts.pendingRefundRequests + systemAlerts.pendingFinancialOverrides,
      };
    },

    async getPlacementRate(range: { from: string; to: string }) {
      return placementRateFor(range);
    },

    async getSuperAdminDashboardStats(): Promise<SuperAdminDashboardStats> {
      return deps.admin.getSuperAdminDashboardStats();
    },

    async getAdmins(filter?: { search?: string | undefined; status?: string | undefined }): Promise<AdminProfile[]> {
      return deps.admin.findAdmins(filter);
    },

    async getAdminById(id: EntityId): Promise<AdminProfile | null> {
      return deps.admin.findAdminById(id);
    },

    async createAdmin(actorId: EntityId, input: CreateAdminBody): Promise<StaffAccountCreated<AdminProfile>> {
      const temporaryPassword = generateTemporaryPassword();
      const passwordHash = await hashPassword(temporaryPassword);
      // The account and its audit row are one transaction (SEC audit logs).
      const account = await mapRepoErrors(() =>
        deps.admin.createAdmin(
          { ...input, passwordHash, assignedByUserId: actorId },
          staffAudit(actorId, "CREATE_ADMIN", "ADMIN_MGMT", "AdminProfile", `Created admin ${input.email.trim()}`),
        ),
      );
      return { account, temporaryPassword };
    },

    async updateAdmin(actorId: EntityId, id: EntityId, input: UpdateAdminBody): Promise<AdminProfile> {
      // Audited in the change's transaction; saving the same values writes nothing and no audit.
      return mapRepoErrors(() =>
        deps.admin.updateAdmin(id, input, staffAudit(actorId, "UPDATE_ADMIN", "ADMIN_MGMT", "AdminProfile", `Updated admin details`)),
      );
    },

    async setAdminStatus(actorId: EntityId, id: EntityId, status: UserStatus): Promise<AdminProfile> {
      if (String(actorId) === String(id)) {
        throw ApiError.forbidden("You cannot change the status of your own account", "SELF_STATUS_CHANGE");
      }
      // A no-op (status already set) writes nothing and is not audited.
      const current = await deps.admin.findAdminById(id);
      if (current && current.status === status) return current;
      const updated = await mapRepoErrors(() =>
        deps.admin.setAdminStatus(id, status, staffAudit(actorId, "SET_ADMIN_STATUS", "ADMIN_MGMT", "AdminProfile", `Status set to ${status}`)),
      );
      if (status !== "active" && deps.sessions) {
        // A suspended/deactivated admin must lose access now, not at token expiry.
        await deps.sessions().revokeAllForUser({ userId: id, reason: "account_suspended" });
      }
      return updated;
    },

    async resetAdminPassword(actorId: EntityId, id: EntityId): Promise<{ temporaryPassword: string }> {
      if (String(actorId) === String(id)) {
        throw ApiError.forbidden("Use change-password for your own account", "SELF_PASSWORD_RESET");
      }
      const temporaryPassword = generateTemporaryPassword();
      const passwordHash = await hashPassword(temporaryPassword);
      // The temporary password itself is never written to the audit trail.
      await mapRepoErrors(() =>
        deps.admin.setAdminPassword(
          id,
          passwordHash,
          staffAudit(actorId, "RESET_ADMIN_PASSWORD", "ADMIN_MGMT", "AdminProfile", "Temporary password issued; sessions revoked"),
        ),
      );
      if (deps.sessions) {
        await deps.sessions().revokeAllForUser({ userId: id, reason: "password_changed" });
      }
      return { temporaryPassword };
    },

    async getBatches(filter?: { courseId?: string | undefined; status?: string | undefined }): Promise<BatchRecord[]> {
      return deps.admin.findBatches(filter);
    },

    async getBatchById(id: EntityId): Promise<BatchRecord | null> {
      return deps.admin.findBatchById(id);
    },

    async createBatch(actorId: EntityId, input: CreateBatchBody): Promise<BatchRecord> {
      return mapRepoErrors(() =>
        deps.admin.createBatch(input, staffAudit(actorId, "CREATE_BATCH", "BATCH_MGMT", "Batch", `Created batch ${input.batchCode}`)),
      );
    },

    async updateBatch(actorId: EntityId, id: EntityId, input: UpdateBatchBody): Promise<BatchRecord> {
      // Audited in the change's transaction; saving the same values writes nothing and no audit.
      return mapRepoErrors(() =>
        deps.admin.updateBatch(id, input, staffAudit(actorId, "UPDATE_BATCH", "BATCH_MGMT", "Batch", `Updated batch`)),
      );
    },

    async setBatchStatus(actorId: EntityId, id: EntityId, status: BatchStatusValue): Promise<BatchRecord> {
      // A no-op (status already set) writes nothing and is not audited.
      const current = await deps.admin.findBatchById(id);
      if (current && String(current.status).toLowerCase() === String(status).toLowerCase()) return current;
      return mapRepoErrors(() =>
        deps.admin.setBatchStatus(id, status, staffAudit(actorId, "SET_BATCH_STATUS", "BATCH_MGMT", "Batch", `Batch status set to ${status}`)),
      );
    },

    async allocateTeacher(actorId: EntityId, batchId: EntityId, input: AllocateTeacherBody): Promise<void> {
      await mapRepoErrors(() =>
        deps.admin.allocateTeacher({
          batchId,
          courseId: input.courseId,
          teacherUserId: input.teacherUserId,
          allocatedByUserId: actorId,
        }, staffAudit(
          actorId,
          "ALLOCATE_TEACHER",
          "TEACHER_ALLOC",
          "TeacherAllocation",
          `Allocated teacher ${input.teacherUserId} to course ${input.courseId}, batch ${batchId}`,
        )),
      );
    },

    async unallocateTeacher(actorId: EntityId, batchId: EntityId, teacherId: EntityId): Promise<void> {
      await mapRepoErrors(() =>
        deps.admin.unallocateTeacher(
          batchId,
          teacherId,
          staffAudit(actorId, "UNALLOCATE_TEACHER", "TEACHER_ALLOC", "TeacherAllocation", `Unallocated teacher ${teacherId}`),
        ),
      );
    },

    async getBatchStudents(batchId: EntityId): Promise<Student[]> {
      return deps.admin.findBatchStudents(batchId);
    },

    async getEnrollments(filter?: {
      studentId?: string | undefined;
      courseId?: string | undefined;
      batchId?: string | undefined;
      status?: string | undefined;
    }): Promise<EnrollmentAdminRecord[]> {
      return deps.admin.findEnrollments(filter);
    },

    async createEnrollment(actorId: EntityId, input: CreateEnrollmentAdminBody): Promise<EnrollmentAdminRecord> {
      // Without an authorized free override the student must still pay: the
      // enrollment waits as APPROVED_UNPAID (BR-004). A free override creates
      // an ACTIVE enrollment and is audited atomically with it (PAY-010, BR-017).
      const free = input.freeAccessOverride === true;
      return mapRepoErrors(() =>
        deps.admin.createEnrollment({
          studentUserId: input.studentUserId,
          courseId: input.courseId,
          batchId: input.batchId,
          discountCode: input.discountCode,
          status: free ? "active" : "approved_unpaid",
          freeAccess: free,
          createdByUserId: actorId,
          capacityOverrideReason: input.capacityOverrideReason,
          prerequisiteOverrideReason: input.prerequisiteOverrideReason,
          audit: {
            actorUserId: actorId,
            actionType: free ? "FREE_ACCESS_OVERRIDE" : "MANUAL_ENROLLMENT",
            reason: input.overrideReason,
          },
        }),
      );
    },

    async setEnrollmentStatus(
      actorId: EntityId,
      id: EntityId,
      status: EnrollmentStatusValue,
      reason?: string,
    ): Promise<EnrollmentAdminRecord> {
      // Resuming access (suspended -> active) must carry a justification
      // (BR-017). A first activation is refused by the repository: paid access
      // comes only from payment verification and free access only from the
      // audited override (BR-004, CL-001).
      if (status === "active" && !reason) {
        throw ApiError.validation(
          [{ field: "reason", message: "A reason is required to resume an enrollment" }],
          "Resuming an enrollment requires a reason",
        );
      }
      return mapRepoErrors(() =>
        deps.admin.setEnrollmentStatus(id, status, {
          actorUserId: actorId,
          actionType: status === "active" ? "RESUME_ENROLLMENT" : "SET_ENROLLMENT_STATUS",
          reason,
        }),
      );
    },

    async getAuditLogs(filter?: {
      actorUserId?: string | undefined;
      moduleCode?: string | undefined;
      startDate?: string | undefined;
      endDate?: string | undefined;
    }): Promise<AuditLogRecord[]> {
      return deps.admin.findAuditLogs(filter);
    },

    async getInstituteSettings(): Promise<InstituteSettingsRecord> {
      return deps.admin.getInstituteSettings();
    },

    async saveInstituteSettings(actorId: EntityId, input: InstituteSettingsBody, actorRole?: string): Promise<InstituteSettingsRecord> {
      // A setting that is stored but never applied is refused, never accepted and ignored.
      const blocked = Object.keys(input).filter((k) => BLOCKED_SETTING_KEYS.has(k));
      if (blocked.length > 0) {
        throw ApiError.validation(
          blocked.map((k) => ({ field: k, message: SETTINGS_CATALOG.find((s) => s.key === k)!.note })),
          `These settings cannot be changed yet: ${blocked.join(", ")}.`,
        );
      }
      // Super Admin-only settings (lockout threshold, BR-011 thresholds) are refused for an Admin; nothing is saved.
      if (actorRole !== "super_admin") {
        const restricted = Object.keys(input).filter((k) => settingDefinition(k)?.editableBy === "super_admin");
        if (restricted.length > 0) {
          throw ApiError.forbidden(`Only the Super Admin can change: ${restricted.join(", ")}.`, "SUPER_ADMIN_SETTING");
        }
      }
      // The repository audits the changed keys (old and new) in the same transaction; a no-op writes nothing.
      const saved = await deps.admin.saveInstituteSettings(input, actorId);
      deps.onSettingsChanged?.();
      return saved;
    },

    getSettingsCatalog() {
      return SETTINGS_CATALOG;
    },

    async getMaintenance() {
      const s = await deps.admin.getInstituteSettings();
      return { enabled: s.maintenanceMode === true, message: s.maintenanceMessage ?? DEFAULT_MAINTENANCE_MESSAGE };
    },

    async setMaintenance(actorId: EntityId, input: MaintenanceBody) {
      const s = await deps.admin.saveInstituteSettings(
        { maintenanceMode: input.enabled, ...(input.message !== undefined ? { maintenanceMessage: input.message } : {}) },
        actorId,
      );
      deps.onSettingsChanged?.();
      return { enabled: s.maintenanceMode === true, message: s.maintenanceMessage ?? DEFAULT_MAINTENANCE_MESSAGE };
    },

    async getSystemConfig(): Promise<SystemConfigStatus> {
      const status = buildSystemConfigStatus(deps.configSource ?? process.env);
      // D7: the lockout threshold in force is the Super Admin setting (3-10), 5 when never saved.
      const saved = (await deps.admin.getInstituteSettings().catch(() => undefined))?.maxFailedLoginAttempts;
      return { ...status, security: { ...status.security, maxFailedLoginAttempts: effectiveLockoutThreshold(saved, status.security.maxFailedLoginAttempts) } };
    },

    /**
     * Platform configuration is not stored anywhere the application reads:
     * it comes from the server environment. Accepting a save would be a fake
     * success, so it is refused. Institute details are saved via settings.
     */
    async saveSystemConfig(): Promise<never> {
      throw new ApiError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        "Platform configuration is read-only here: it is set in the server environment. " +
          "Edit institute details from Institute Settings.",
        "SYSTEM_CONFIG_READ_ONLY",
      );
    },

    async sendTestEmail(actorId: EntityId, recipientEmail: string) {
      if (deps.testMailer === undefined) {
        throw new ApiError(
          HttpStatus.SERVICE_UNAVAILABLE,
          "Outgoing email is not configured on this server (SMTP settings are missing).",
          "SMTP_NOT_CONFIGURED",
        );
      }
      let messageId: string;
      try {
        ({ messageId } = await deps.testMailer(recipientEmail));
      } catch (err) {
        logger.warn("SMTP test email failed", { error: err instanceof Error ? err.message : String(err) });
        await audit(actorId, "TEST_EMAIL_FAILED", "SYSTEM_CONFIG", "Smtp", "smtp", `Test email to ${recipientEmail} failed`);
        throw new ApiError(
          HttpStatus.SERVICE_UNAVAILABLE,
          "The SMTP server did not accept the test email. Check the server's SMTP settings and logs.",
          "SMTP_SEND_FAILED",
        );
      }
      await audit(actorId, "TEST_EMAIL_SENT", "SYSTEM_CONFIG", "Smtp", "smtp", `Test email sent to ${recipientEmail}`);
      return { sentTo: recipientEmail, messageId, sentAt: new Date().toISOString() };
    },

    async getRefunds(status?: string | undefined): Promise<RefundRecord[]> {
      return deps.admin.findRefunds(status);
    },

    async decideRefund(
      actorId: EntityId,
      id: EntityId,
      status: "approved" | "rejected",
      remarks?: string | undefined,
    ): Promise<RefundRecord> {
      // The repository writes the audit record in the same transaction.
      return mapRepoErrors(() => deps.admin.updateRefundStatus(id, status, actorId, remarks));
    },

    async getFinancialOverrides(status?: string | undefined): Promise<FinancialOverrideRecord[]> {
      return deps.admin.findFinancialOverrides(status);
    },

    async decideFinancialOverride(
      actorId: EntityId,
      id: EntityId,
      status: "approved" | "rejected",
      remarks?: string | undefined,
    ): Promise<FinancialOverrideRecord> {
      // The repository writes the audit record in the same transaction.
      return mapRepoErrors(() => deps.admin.updateFinancialOverride(id, status, actorId, remarks));
    },

    async getRoles(): Promise<GlobalRoleRecord[]> {
      return deps.admin.findRoles();
    },

    // Role creation and permission mapping wait for the verified permission
    // catalog and role-permission tables. Refused explicitly: the previous
    // implementation returned the submitted permissions without storing them.
    async createRole(): Promise<never> {
      throw rbacUnavailable();
    },

    async updateRolePermissions(): Promise<never> {
      throw rbacUnavailable();
    },

    async unlockAccount(actorId: EntityId, userId: EntityId): Promise<void> {
      // Audited in the same transaction; an account with nothing to clear writes nothing and no audit.
      await mapRepoErrors(() =>
        deps.admin.unlockUserAccount(userId, staffAudit(actorId, "UNLOCK_ACCOUNT", "USER_MGMT", "User", "Cleared login lockout")),
      );
    },

    async getTeachers(filter?: { search?: string | undefined; status?: string | undefined }): Promise<Teacher[]> {
      return deps.admin.findTeachers(filter);
    },

    async updateTeacher(actorId: EntityId, id: EntityId, input: UpdateTeacherAdminBody): Promise<{ record: Teacher; changed: boolean }> {
      // Audited by the repository in the same transaction as the change.
      return mapRepoErrors(() => deps.admin.updateTeacher(id, input, actorId));
    },

    async setTeacherStatus(actorId: EntityId, id: EntityId, input: TeacherStatusBody): Promise<{ record: Teacher; changed: boolean }> {
      const result = await mapRepoErrors(() => deps.admin.setTeacherStatus(id, input.status, input.reason, actorId));
      if (result.changed && input.status !== "active" && deps.sessions) {
        // A deactivated teacher loses access now, not at token expiry.
        await deps.sessions().revokeAllForUser({ userId: id, reason: "account_suspended" });
      }
      return result;
    },

    async createTeacher(actorId: EntityId, input: CreateTeacherAdminBody): Promise<StaffAccountCreated<Teacher>> {
      const temporaryPassword = generateTemporaryPassword();
      const passwordHash = await hashPassword(temporaryPassword);
      // The account and its audit row are one transaction (SEC audit logs).
      const account = await mapRepoErrors(() =>
        deps.admin.createTeacherUser(
          { ...input, passwordHash, assignedByUserId: actorId },
          staffAudit(actorId, "CREATE_TEACHER", "TEACHER_MGMT", "Teacher", `Created faculty ${input.email.trim()}`),
        ),
      );
      return { account, temporaryPassword };
    },

    /**
     * ADM-003. The account is created PENDING_VERIFICATION (account pending,
     * email and mobile unverified, approval pending) - never active or
     * approved because an admin created it. The creation and its audit
     * record are one transaction. Afterwards the BR-001 email OTP is issued
     * through the same service self-registration uses; a delivery failure
     * does not undo the account (the student can request a resend) and is
     * reported as such.
     */
    async createStudent(actorId: EntityId, input: CreateStudentAdminBody): Promise<StudentAccountCreated> {
      const temporaryPassword = generateTemporaryPassword();
      const passwordHash = await hashPassword(temporaryPassword);
      const account = await mapRepoErrors(() =>
        deps.admin.createStudentUser({ ...input, passwordHash, createdByUserId: actorId }),
      );

      let email: VerificationChannelStatus;
      if (deps.verification === undefined) {
        email = { status: "unavailable", reason: "Email OTP is not configured on this server." };
      } else {
        try {
          const sent = await deps.verification.sendEmailChallenge(account.id);
          email =
            sent.outcome === "success"
              ? { status: "sent", sentTo: sent.data.sentTo, expiresAt: sent.data.expiresAt }
              : { status: "not_sent", reason: sent.reason };
        } catch (err) {
          logger.error("admin-created student: email OTP could not be issued", {
            studentId: account.id,
            error: err instanceof Error ? err.message : String(err),
          });
          email = { status: "not_sent", reason: "verification_unavailable" };
        }
      }

      return {
        account,
        temporaryPassword,
        verification: { email, mobile: { status: "deferred", reason: MOBILE_OTP_DEFERRED_REASON } },
      };
    },
  };
};
