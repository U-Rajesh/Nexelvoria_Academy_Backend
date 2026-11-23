import type { EntityId } from "../../contracts/identifier.contract";
import type { UserStatus } from "../../contracts/user.contract";
import type { AdminRepository } from "./admin.repository";
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
import type {
  AllocateTeacherBody,
  CreateAdminBody,
  CreateBatchBody,
  CreateEnrollmentAdminBody,
  CreateRoleBody,
  CreateTeacherAdminBody,
  InstituteSettingsBody,
  UpdateAdminBody,
  UpdateBatchBody,
} from "./admin.validation";
import type { Student } from "../students/student.types";
import type { Teacher } from "../teachers/teacher.types";

export interface AdminServiceDeps {
  admin: AdminRepository;
}

export interface AdminService {
  getDashboardStats(): Promise<DashboardStats>;
  getSuperAdminDashboardStats(): Promise<SuperAdminDashboardStats>;

  // Admins
  getAdmins(filter?: { search?: string | undefined; status?: string | undefined }): Promise<AdminProfile[]>;
  getAdminById(id: EntityId): Promise<AdminProfile | null>;
  createAdmin(actorId: EntityId, input: CreateAdminBody): Promise<AdminProfile>;
  updateAdmin(actorId: EntityId, id: EntityId, input: UpdateAdminBody): Promise<AdminProfile>;
  setAdminStatus(actorId: EntityId, id: EntityId, status: UserStatus): Promise<AdminProfile>;
  resetAdminPassword(actorId: EntityId, id: EntityId): Promise<{ temporaryPassword?: string | undefined }>;

  // Batches
  getBatches(filter?: { courseId?: string | undefined; status?: string | undefined }): Promise<BatchRecord[]>;
  getBatchById(id: EntityId): Promise<BatchRecord | null>;
  createBatch(actorId: EntityId, input: CreateBatchBody): Promise<BatchRecord>;
  updateBatch(actorId: EntityId, id: EntityId, input: UpdateBatchBody): Promise<BatchRecord>;
  setBatchStatus(actorId: EntityId, id: EntityId, status: string): Promise<BatchRecord>;
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
  setEnrollmentStatus(actorId: EntityId, id: EntityId, status: string): Promise<EnrollmentAdminRecord>;

  // Audit Logs
  getAuditLogs(filter?: {
    actorUserId?: string | undefined;
    moduleCode?: string | undefined;
    startDate?: string | undefined;
    endDate?: string | undefined;
  }): Promise<AuditLogRecord[]>;

  // Settings & System Config
  getInstituteSettings(): Promise<InstituteSettingsRecord>;
  saveInstituteSettings(actorId: EntityId, input: InstituteSettingsBody): Promise<InstituteSettingsRecord>;
  getSystemConfig(): Promise<SystemConfigRecord>;
  saveSystemConfig(actorId: EntityId, input: Partial<SystemConfigRecord>): Promise<SystemConfigRecord>;

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
  createTeacher(actorId: EntityId, input: CreateTeacherAdminBody): Promise<Teacher>;
}

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
    } catch {
      // Audit failure must not block the primary operation
    }
  };

  return {
    async getDashboardStats(): Promise<DashboardStats> {
      return deps.admin.getDashboardStats();
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

    async createAdmin(actorId: EntityId, input: CreateAdminBody): Promise<AdminProfile> {
      const created = await deps.admin.createAdmin(input);
      await audit(actorId, "CREATE_ADMIN", "ADMIN_MGMT", "AdminProfile", created.id, `Created admin ${created.email}`);
      return created;
    },

    async updateAdmin(actorId: EntityId, id: EntityId, input: UpdateAdminBody): Promise<AdminProfile> {
      const updated = await deps.admin.updateAdmin(id, input);
      await audit(actorId, "UPDATE_ADMIN", "ADMIN_MGMT", "AdminProfile", id, `Updated admin details`);
      return updated;
    },

    async setAdminStatus(actorId: EntityId, id: EntityId, status: UserStatus): Promise<AdminProfile> {
      const updated = await deps.admin.setAdminStatus(id, status);
      await audit(actorId, "SET_ADMIN_STATUS", "ADMIN_MGMT", "AdminProfile", id, `Status set to ${status}`);
      return updated;
    },

    async resetAdminPassword(actorId: EntityId, id: EntityId): Promise<{ temporaryPassword?: string | undefined }> {
      const result = await deps.admin.resetAdminPassword(id);
      await audit(actorId, "RESET_ADMIN_PASSWORD", "ADMIN_MGMT", "AdminProfile", id, `Password reset initiated`);
      return result;
    },

    async getBatches(filter?: { courseId?: string | undefined; status?: string | undefined }): Promise<BatchRecord[]> {
      return deps.admin.findBatches(filter);
    },

    async getBatchById(id: EntityId): Promise<BatchRecord | null> {
      return deps.admin.findBatchById(id);
    },

    async createBatch(actorId: EntityId, input: CreateBatchBody): Promise<BatchRecord> {
      const batch = await deps.admin.createBatch(input);
      await audit(actorId, "CREATE_BATCH", "BATCH_MGMT", "Batch", batch.id, `Created batch ${batch.batchCode}`);
      return batch;
    },

    async updateBatch(actorId: EntityId, id: EntityId, input: UpdateBatchBody): Promise<BatchRecord> {
      const updated = await deps.admin.updateBatch(id, input);
      if (input.status) {
        await deps.admin.setBatchStatus(id, input.status);
      }
      await audit(actorId, "UPDATE_BATCH", "BATCH_MGMT", "Batch", id, `Updated batch`);
      return updated;
    },

    async setBatchStatus(actorId: EntityId, id: EntityId, status: string): Promise<BatchRecord> {
      const updated = await deps.admin.setBatchStatus(id, status);
      await audit(actorId, "SET_BATCH_STATUS", "BATCH_MGMT", "Batch", id, `Batch status set to ${status}`);
      return updated;
    },

    async allocateTeacher(actorId: EntityId, batchId: EntityId, input: AllocateTeacherBody): Promise<void> {
      await deps.admin.allocateTeacher(batchId, input.teacherUserId, input.courseId);
      await audit(actorId, "ALLOCATE_TEACHER", "TEACHER_ALLOC", "TeacherAllocation", batchId, `Allocated teacher ${input.teacherUserId}`);
    },

    async unallocateTeacher(actorId: EntityId, batchId: EntityId, teacherId: EntityId): Promise<void> {
      await deps.admin.unallocateTeacher(batchId, teacherId);
      await audit(actorId, "UNALLOCATE_TEACHER", "TEACHER_ALLOC", "TeacherAllocation", batchId, `Unallocated teacher ${teacherId}`);
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
      const enr = await deps.admin.createEnrollment(input);
      await audit(actorId, "MANUAL_ENROLLMENT", "ENROLLMENT_MGMT", "Enrollment", enr.id, `Enrolled student ${input.studentUserId}`);
      return enr;
    },

    async setEnrollmentStatus(actorId: EntityId, id: EntityId, status: string): Promise<EnrollmentAdminRecord> {
      const updated = await deps.admin.setEnrollmentStatus(id, status);
      await audit(actorId, "SET_ENROLLMENT_STATUS", "ENROLLMENT_MGMT", "Enrollment", id, `Enrollment status set to ${status}`);
      return updated;
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

    async saveInstituteSettings(actorId: EntityId, input: InstituteSettingsBody): Promise<InstituteSettingsRecord> {
      const saved = await deps.admin.saveInstituteSettings(input, actorId);
      await audit(actorId, "UPDATE_SETTINGS", "INSTITUTE_SETTINGS", "Settings", "main", "Updated institute settings");
      return saved;
    },

    async getSystemConfig(): Promise<SystemConfigRecord> {
      return deps.admin.getSystemConfig();
    },

    async saveSystemConfig(actorId: EntityId, input: Partial<SystemConfigRecord>): Promise<SystemConfigRecord> {
      const saved = await deps.admin.saveSystemConfig(input, actorId);
      await audit(actorId, "UPDATE_SYSTEM_CONFIG", "SYSTEM_CONFIG", "Config", "main", "Updated platform system configuration");
      return saved;
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
      const updated = await deps.admin.updateRefundStatus(id, status, actorId, remarks);
      await audit(actorId, "DECIDE_REFUND", "FINANCE", "Refund", id, `Refund ${status}`);
      return updated;
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
      const updated = await deps.admin.updateFinancialOverride(id, status, actorId, remarks);
      await audit(actorId, "DECIDE_OVERRIDE", "FINANCE", "FinancialOverride", id, `Override ${status}`);
      return updated;
    },

    async getRoles(): Promise<GlobalRoleRecord[]> {
      return deps.admin.findRoles();
    },

    async createRole(actorId: EntityId, input: CreateRoleBody): Promise<GlobalRoleRecord> {
      const role = await deps.admin.createRole(input);
      await audit(actorId, "CREATE_ROLE", "RBAC", "Role", role.id, `Created role ${role.roleCode}`);
      return role;
    },

    async updateRolePermissions(actorId: EntityId, roleId: EntityId, permissions: string[]): Promise<GlobalRoleRecord> {
      const updated = await deps.admin.updateRolePermissions(roleId, permissions);
      await audit(actorId, "UPDATE_ROLE_PERMS", "RBAC", "Role", roleId, `Updated permissions for role`);
      return updated;
    },

    async unlockAccount(actorId: EntityId, userId: EntityId): Promise<void> {
      await deps.admin.unlockUserAccount(userId);
      await audit(actorId, "UNLOCK_ACCOUNT", "USER_MGMT", "User", userId, "Unlocked user account");
    },

    async getTeachers(filter?: { search?: string | undefined; status?: string | undefined }): Promise<Teacher[]> {
      return deps.admin.findTeachers(filter);
    },

    async createTeacher(actorId: EntityId, input: CreateTeacherAdminBody): Promise<Teacher> {
      const teacher = await deps.admin.createTeacherUser(input);
      await audit(actorId, "CREATE_TEACHER", "TEACHER_MGMT", "Teacher", teacher.id, `Created faculty ${teacher.email}`);
      return teacher;
    },
  };
};
