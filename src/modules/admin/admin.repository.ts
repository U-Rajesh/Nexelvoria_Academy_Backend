import type { EntityId } from "../../contracts/identifier.contract";
import type { UserStatus } from "../../contracts/user.contract";
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
import type { Student } from "../students/student.types";
import type { Teacher } from "../teachers/teacher.types";
import type { BatchStatusValue, ENROLLMENT_STATUSES } from "./admin.validation";

export type EnrollmentStatusValue = (typeof ENROLLMENT_STATUSES)[number];

/** Audit details a repository writes atomically with the change itself. */
export interface TransactionalAudit {
  actorUserId: EntityId;
  actionType: string;
  /** Business justification (mandatory for free-access overrides). */
  reason?: string | undefined;
}

/**
 * NXA_EnrollmentOverrides.OverrideType stored for an Admin free-access grant
 * (varchar(30); value approved by the product owner, decision B1).
 */
export const FREE_ACCESS_OVERRIDE_TYPE = "FREE_ACCESS";

/**
 * A request that is well-formed but violates an approved business rule
 * (e.g. the batch does not belong to the course). Mapped to HTTP 422.
 */
export class AdminRuleViolationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** 422 for an invalid request, 409 for a state conflict (e.g. already decided). */
    readonly status: 409 | 422 = 422,
  ) {
    super(message);
    this.name = "AdminRuleViolationError";
  }
}

/**
 * A staff action's audit entry, written by the repository on the same
 * transaction as the change it describes (SEC audit logs): both commit or
 * neither does. No entry is written for a no-op. `details` must never carry a
 * password, hash, token or OTP.
 */
export interface StaffAudit {
  actorUserId: EntityId;
  actionType: string;
  moduleCode: string;
  entityName: string;
  details: string;
}

export interface AdminRepository {
  getDashboardStats(): Promise<DashboardStats>;
  /**
   * D15 cohort for [fromUtc, toUtc): distinct students with an enrollment
   * COMPLETED in the range, and how many of THOSE students have a placement
   * record. Counted per student, never per record.
   */
  getPlacementCohort(range: { fromUtc: Date; toUtc: Date }): Promise<{ completedStudents: number; placedStudents: number }>;
  getSuperAdminDashboardStats(): Promise<SuperAdminDashboardStats>;

  // Admin Account Management
  findAdmins(filter?: { search?: string | undefined; status?: string | undefined }): Promise<AdminProfile[]>;
  findAdminById(id: EntityId): Promise<AdminProfile | null>;
  /**
   * Creates the NXA_Users row (with an argon2id `passwordHash`), assigns the
   * `admin` role through NXA_UserRoles and writes NXA_AdminProfiles, all in one
   * transaction. Throws `DuplicateRecordError` when the email or mobile is taken.
   */
  createAdmin(input: {
    name: string;
    email: string;
    mobile: string;
    passwordHash: string;
    assignedByUserId: EntityId;
    department?: string | undefined;
    permissions?: string[] | undefined;
    adminLevel?: string | undefined;
    employeeCode?: string | undefined;
  }, audit?: StaffAudit): Promise<AdminProfile>;
  updateAdmin(
    id: EntityId,
    input: {
      name?: string | undefined;
      mobile?: string | undefined;
      department?: string | undefined;
      permissions?: string[] | undefined;
    },
    audit?: StaffAudit,
  ): Promise<AdminProfile>;
  /** No-op (already in that status) writes nothing and writes no audit. */
  setAdminStatus(id: EntityId, status: UserStatus, audit?: StaffAudit): Promise<AdminProfile>;
  /**
   * Replaces the stored password hash of an `admin` account and clears its
   * lockout state. Throws `RecordNotFoundError` when no such admin exists.
   */
  setAdminPassword(id: EntityId, passwordHash: string, audit?: StaffAudit): Promise<void>;

  // Batch Management
  findBatches(filter?: { courseId?: string | undefined; status?: string | undefined }): Promise<BatchRecord[]>;
  findBatchById(id: EntityId): Promise<BatchRecord | null>;
  createBatch(input: {
    courseId: EntityId;
    batchCode: string;
    batchName: string;
    startDate?: string | undefined;
    endDate?: string | undefined;
    capacity?: number | undefined;
    scheduleDescription?: string | undefined;
  }, audit?: StaffAudit): Promise<BatchRecord>;
  updateBatch(
    id: EntityId,
    input: {
      batchName?: string | undefined;
      startDate?: string | undefined;
      endDate?: string | undefined;
      capacity?: number | undefined;
      scheduleDescription?: string | undefined;
    },
    audit?: StaffAudit,
  ): Promise<BatchRecord>;
  /** No-op (already in that status) writes nothing and writes no audit. */
  setBatchStatus(id: EntityId, status: BatchStatusValue, audit?: StaffAudit): Promise<BatchRecord>;
  /**
   * Allocates the (course, batch, teacher) triple. Throws
   * `AdminRuleViolationError` when the batch does not belong to the course or
   * the user is not an active teacher, `RecordNotFoundError` for an unknown
   * batch, and `DuplicateRecordError` when the triple is already active.
   */
  allocateTeacher(input: {
    batchId: EntityId;
    courseId: EntityId;
    teacherUserId: EntityId;
    allocatedByUserId: EntityId;
  }, audit?: StaffAudit): Promise<void>;
  /** Throws `RecordNotFoundError` when there is no active allocation. */
  unallocateTeacher(batchId: EntityId, teacherUserId: EntityId, audit?: StaffAudit): Promise<void>;
  findBatchStudents(batchId: EntityId): Promise<Student[]>;

  // Enrollment Administration
  findEnrollments(filter?: {
    studentId?: string | undefined;
    courseId?: string | undefined;
    batchId?: string | undefined;
    status?: string | undefined;
  }): Promise<EnrollmentAdminRecord[]>;
  /**
   * Admin enrollment. Price comes from the course (ListPrice). Enforces: the
   * user is an approved student (BR-002), the course exists, the batch (if
   * any) belongs to the course and is not completed/cancelled, the discount
   * does not exceed the price, and the student has no non-cancelled
   * enrollment in the course. Throws `AdminRuleViolationError`,
   * `RecordNotFoundError` or `DuplicateRecordError`.
   */
  createEnrollment(input: {
    studentUserId: EntityId;
    courseId: EntityId;
    batchId?: EntityId | undefined;
    /**
     * D6: the batch is at capacity -> refused (409 BATCH_FULL) unless this
     * reason is given; the override is recorded in the enrollment's audit row.
     */
    capacityOverrideReason?: string | undefined;
    /**
     * D4: a prerequisite course is not COMPLETED -> refused (422
     * PREREQUISITES_NOT_MET) unless this reason is given; recorded in the audit row.
     */
    prerequisiteOverrideReason?: string | undefined;
    /** Code of a defined NXA_Discounts record; must be active and in date. */
    discountCode?: string | undefined;
    status: "approved_unpaid" | "active";
    /**
     * Free access override (BR-004/BR-007/BR-017): the whole course price is
     * waived (FinalAmount 0) and the enrollment is ACTIVE. Requires
     * `status: "active"` and a reason in `audit`; cannot carry a discount code.
     * Records an NXA_EnrollmentOverrides row (OverrideType FREE_ACCESS_OVERRIDE_TYPE,
     * ApprovedByUserId = the granting user) in the same transaction.
     */
    freeAccess?: boolean | undefined;
    createdByUserId: EntityId;
    /** Written in the same transaction as the enrollment (BR-017). */
    audit: TransactionalAudit;
  }): Promise<EnrollmentAdminRecord>;
  findEnrollmentById(id: EntityId): Promise<EnrollmentAdminRecord | null>;
  /**
   * Changes the status, stamping ActivatedAt / CompletedAt, and writes the
   * audit record (with old and new status) in the same transaction.
   */
  setEnrollmentStatus(
    id: EntityId,
    status: EnrollmentStatusValue,
    audit: TransactionalAudit,
  ): Promise<EnrollmentAdminRecord>;

  // Audit Logs
  findAuditLogs(filter?: {
    actorUserId?: string | undefined;
    moduleCode?: string | undefined;
    startDate?: string | undefined;
    endDate?: string | undefined;
  }): Promise<AuditLogRecord[]>;
  createAuditLog(log: {
    actorUserId: EntityId;
    actionType: string;
    moduleCode: string;
    entityName: string;
    entityId: string;
    oldValues?: string | undefined;
    newValues?: string | undefined;
    ipAddress?: string | undefined;
    userAgent?: string | undefined;
    correlationId?: string | undefined;
    details?: string | undefined;
  }): Promise<AuditLogRecord>;

  // Settings & Configuration
  getInstituteSettings(): Promise<InstituteSettingsRecord>;
  saveInstituteSettings(
    settings: {
      instituteName?: string | undefined;
      tagline?: string | undefined;
      supportEmail?: string | undefined;
      supportPhone?: string | undefined;
      whatsappNumber?: string | undefined;
      address?: string | undefined;
      timezone?: string | undefined;
      minAttendancePercentage?: number | undefined;
      isSmsEnabled?: boolean | undefined;
      currencySymbol?: string | undefined;
      gstNumber?: string | undefined;
      maintenanceMode?: boolean | undefined;
      maintenanceMessage?: string | undefined;
    },
    /** Required: every settings change is attributed and audited in the same transaction. */
    updatedByUserId: EntityId,
  ): Promise<InstituteSettingsRecord>;

  // Refunds & Financial Overrides
  findRefunds(status?: string | undefined): Promise<RefundRecord[]>;
  /**
   * Decides a PENDING refund (Super Admin only, BR-006) and writes the audit
   * record in the same transaction. Throws AdminRuleViolationError (409) when
   * the refund was already decided. No gateway refund is executed here, so an
   * approved refund is APPROVED, never COMPLETED.
   */
  updateRefundStatus(
    id: EntityId,
    status: "approved" | "rejected",
    decidedByUserId: EntityId,
    remarks?: string | undefined,
  ): Promise<RefundRecord>;
  /**
   * Read-only history of granted overrides. NXA_EnrollmentOverrides.ApprovedByUserId
   * is NOT NULL, so every row is an override authorized when it was recorded:
   * status is always "approved" and "pending"/"rejected" filters return nothing.
   */
  findFinancialOverrides(status?: string | undefined): Promise<FinancialOverrideRecord[]>;
  /**
   * Overrides are authorized when granted, so there is nothing left to decide:
   * approving an existing override throws AdminRuleViolationError (409),
   * rejecting throws AdminRuleViolationError (422), an unknown id throws
   * RecordNotFoundError. Never changes data.
   */
  updateFinancialOverride(
    id: EntityId,
    status: "approved" | "rejected",
    decidedByUserId: EntityId,
    remarks?: string | undefined,
  ): Promise<FinancialOverrideRecord>;

  // Global Roles & Permissions
  /** NXA_Roles rows. Creating roles and mapping permissions wait for the verified catalog. */
  findRoles(): Promise<GlobalRoleRecord[]>;

  // Student accounts (ADM-003)
  /**
   * Creates a student exactly as self-registration leaves one: account
   * `pending`, email and mobile unverified, approval `pending`, `student`
   * role, argon2id hash of a one-time password. The audit record is written
   * in the same transaction. Throws `DuplicateRecordError` (email/mobile),
   * `AdminRuleViolationError` (unknown interested course) or an error when
   * the `student` role is not seeded.
   */
  createStudentUser(input: {
    name: string;
    email: string;
    mobile: string;
    passwordHash: string;
    createdByUserId: EntityId;
    collegeName?: string | undefined;
    degree?: string | undefined;
    branch?: string | undefined;
    passingYear?: number | undefined;
    interestedCourseId?: EntityId | undefined;
    dateOfBirth?: string | undefined;
    gender?: string | undefined;
    city?: string | undefined;
    state?: string | undefined;
  }): Promise<AdminCreatedStudent>;

  // User Administration
  /** Clears the login lockout. Nothing locked: no write and no audit. */
  unlockUserAccount(userId: EntityId, audit?: StaffAudit): Promise<void>;
  findTeachers(filter?: { search?: string | undefined; status?: string | undefined }): Promise<Teacher[]>;
  createTeacherUser(input: {
    name: string;
    email: string;
    mobile: string;
    passwordHash: string;
    assignedByUserId: EntityId;
    specialization?: string | undefined;
    experienceYears?: number | undefined;
    qualifications?: string | undefined;
    bio?: string | undefined;
  }, audit?: StaffAudit): Promise<Teacher>;
  /**
   * Edits name and profile fields of a teacher account, with its audit record,
   * in one transaction. An unchanged teacher writes nothing (changed: false).
   * RecordNotFoundError when the user is not a teacher.
   */
  updateTeacher(
    id: EntityId,
    changes: {
      name?: string | undefined;
      specialization?: string | null | undefined;
      experienceYears?: number | undefined;
      qualifications?: string | null | undefined;
      bio?: string | null | undefined;
    },
    actorUserId: EntityId,
  ): Promise<{ record: Teacher; changed: boolean }>;
  /**
   * Sets the account status (active / deactivated) and NXA_TeacherProfiles.IsActive,
   * with its audit record, in one transaction. Unchanged: nothing written.
   */
  setTeacherStatus(
    id: EntityId,
    status: "active" | "deactivated",
    reason: string | undefined,
    actorUserId: EntityId,
  ): Promise<{ record: Teacher; changed: boolean }>;
}
