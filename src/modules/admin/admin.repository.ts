import type { EntityId } from "../../contracts/identifier.contract";
import type { UserStatus } from "../../contracts/user.contract";
import type {
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
  SystemConfigRecord,
} from "./admin.types";
import type { Student } from "../students/student.types";
import type { Teacher } from "../teachers/teacher.types";

export interface AdminRepository {
  getDashboardStats(): Promise<DashboardStats>;
  getSuperAdminDashboardStats(): Promise<SuperAdminDashboardStats>;

  // Admin Account Management
  findAdmins(filter?: { search?: string | undefined; status?: string | undefined }): Promise<AdminProfile[]>;
  findAdminById(id: EntityId): Promise<AdminProfile | null>;
  createAdmin(input: {
    name: string;
    email: string;
    mobile: string;
    department?: string | undefined;
    permissions?: string[] | undefined;
    adminLevel?: string | undefined;
    employeeCode?: string | undefined;
  }): Promise<AdminProfile>;
  updateAdmin(
    id: EntityId,
    input: {
      name?: string | undefined;
      mobile?: string | undefined;
      department?: string | undefined;
      permissions?: string[] | undefined;
    },
  ): Promise<AdminProfile>;
  setAdminStatus(id: EntityId, status: UserStatus): Promise<AdminProfile>;
  resetAdminPassword(id: EntityId): Promise<{ temporaryPassword?: string | undefined }>;

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
  }): Promise<BatchRecord>;
  updateBatch(
    id: EntityId,
    input: {
      batchName?: string | undefined;
      startDate?: string | undefined;
      endDate?: string | undefined;
      capacity?: number | undefined;
      scheduleDescription?: string | undefined;
    },
  ): Promise<BatchRecord>;
  setBatchStatus(id: EntityId, status: string): Promise<BatchRecord>;
  allocateTeacher(batchId: EntityId, teacherUserId: EntityId, courseId?: EntityId): Promise<void>;
  unallocateTeacher(batchId: EntityId, teacherUserId: EntityId): Promise<void>;
  findBatchStudents(batchId: EntityId): Promise<Student[]>;

  // Enrollment Administration
  findEnrollments(filter?: {
    studentId?: string | undefined;
    courseId?: string | undefined;
    batchId?: string | undefined;
    status?: string | undefined;
  }): Promise<EnrollmentAdminRecord[]>;
  createEnrollment(input: {
    studentUserId: EntityId;
    courseId: EntityId;
    batchId?: EntityId | undefined;
    coursePrice?: number | undefined;
    discountAmount?: number | undefined;
    finalAmount?: number | undefined;
    currencyCode?: string | undefined;
  }): Promise<EnrollmentAdminRecord>;
  setEnrollmentStatus(id: EntityId, status: string): Promise<EnrollmentAdminRecord>;

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
    },
    updatedByUserId?: EntityId,
  ): Promise<InstituteSettingsRecord>;
  getSystemConfig(): Promise<SystemConfigRecord>;
  saveSystemConfig(
    config: Partial<SystemConfigRecord>,
    updatedByUserId?: EntityId,
  ): Promise<SystemConfigRecord>;

  // Refunds & Financial Overrides
  findRefunds(status?: string | undefined): Promise<RefundRecord[]>;
  updateRefundStatus(
    id: EntityId,
    status: string,
    decidedByUserId: EntityId,
    remarks?: string | undefined,
  ): Promise<RefundRecord>;
  findFinancialOverrides(status?: string | undefined): Promise<FinancialOverrideRecord[]>;
  updateFinancialOverride(
    id: EntityId,
    status: "approved" | "rejected",
    decidedByUserId: EntityId,
    remarks?: string | undefined,
  ): Promise<FinancialOverrideRecord>;

  // Global Roles & Permissions
  findRoles(): Promise<GlobalRoleRecord[]>;
  createRole(role: {
    roleCode: string;
    roleName: string;
    description: string;
    permissions: string[];
  }): Promise<GlobalRoleRecord>;
  updateRolePermissions(roleId: EntityId, permissions: string[]): Promise<GlobalRoleRecord>;

  // User Administration
  unlockUserAccount(userId: EntityId): Promise<void>;
  findTeachers(filter?: { search?: string | undefined; status?: string | undefined }): Promise<Teacher[]>;
  createTeacherUser(input: {
    name: string;
    email: string;
    mobile: string;
    specialization?: string | undefined;
    experienceYears?: number | undefined;
    qualifications?: string | undefined;
    bio?: string | undefined;
  }): Promise<Teacher>;
}
