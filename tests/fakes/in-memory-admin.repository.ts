import type { EntityId } from "../../src/contracts/identifier.contract";
import type { UserStatus } from "../../src/contracts/user.contract";
import { RecordNotFoundError } from "../../src/repositories/repository.errors";
import type { AdminRepository } from "../../src/modules/admin/admin.repository";
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
} from "../../src/modules/admin/admin.types";
import type { Student } from "../../src/modules/students/student.types";
import type { Teacher } from "../../src/modules/teachers/teacher.types";

export class InMemoryAdminRepository implements AdminRepository {
  public admins: AdminProfile[] = [];
  public batches: BatchRecord[] = [];
  public enrollments: EnrollmentAdminRecord[] = [];
  public auditLogs: AuditLogRecord[] = [];
  public refunds: RefundRecord[] = [];
  public financialOverrides: FinancialOverrideRecord[] = [];
  public roles: GlobalRoleRecord[] = [];
  public teachers: Teacher[] = [];
  public batchStudentsMap: Map<string, Student[]> = new Map();
  public teacherAllocationsMap: Map<string, string[]> = new Map(); // batchId -> teacherUserIds

  public instituteSettings: InstituteSettingsRecord = {
    instituteName: "Nexelvoria Academy",
    tagline: "Empowering Next-Gen Tech Leaders",
    supportEmail: "contact@nexelvoria.in",
    supportPhone: "+91 80000 12345",
    whatsappNumber: "+91 80000 12345",
    address: "Hitec City, Hyderabad, Telangana",
    timezone: "Asia/Kolkata",
    minAttendancePercentage: 75,
    isSmsEnabled: false,
    currencySymbol: "₹",
    gstNumber: "36AAAAA0000A1Z5",
  };

  public systemConfig: SystemConfigRecord = {
    institute: {
      name: "Nexelvoria Academy",
      code: "NXA",
      affiliation: "State Technical Board",
      supportEmail: "contact@nexelvoria.in",
      supportPhone: "+91 80000 12345",
      whatsappNumber: "+91 80000 12345",
      address: "Hitec City, Hyderabad, Telangana",
      website: "https://nexelvoria.in",
      gstNumber: "36AAAAA0000A1Z5",
      currency: "INR",
      timezone: "Asia/Kolkata",
    },
    branding: {
      logoUrl: "/logo.png",
      faviconUrl: "/favicon.ico",
      primaryColor: "#4f46e5",
      secondaryColor: "#06b6d4",
      tagline: "Empowering Next-Gen Tech Leaders",
      motto: "Learn. Build. Excel.",
    },
    academic: {
      currentAcademicYear: "2026-2027",
      activeTerm: "Spring 2026",
      isRegistrationOpen: true,
      isCatalogPublic: true,
      maxBatchCapacity: 40,
      minAttendancePercentage: 75,
      assignmentGracePeriodDays: 2,
      passPercentage: 60,
    },
    paymentGateway: {
      provider: "razorpay",
      keyId: "rzp_test_key",
      keySecretMasked: "••••••••••••",
      webhookSecretMasked: "••••••••••••",
      isLiveMode: false,
      autoReconcile: true,
    },
    emailSms: {
      smtpHost: "smtp.mailtrap.io",
      smtpPort: 587,
      smtpUser: "nexelvoria-auth",
      smtpPasswordMasked: "••••••••••••",
      senderName: "Nexelvoria Academy",
      senderEmail: "notifications@nexelvoria.in",
      isSmsEnabled: false,
      smsProvider: "twilio",
      smsApiKeyMasked: "••••••••••••",
    },
    notifications: {
      emailOnAdmission: true,
      emailOnPayment: true,
      emailOnExamResult: true,
      smsOnClassReminder: false,
      pushAnnouncements: true,
    },
    security: {
      sessionTimeoutMinutes: 60,
      enforceTwoFactor: false,
      maxFailedLogins: 5,
      passwordExpiryDays: 90,
      requireSpecialChars: true,
    },
    maintenance: {
      isMaintenanceMode: false,
      message: "System is undergoing scheduled maintenance.",
      allowedIps: "127.0.0.1, ::1",
    },
  };

  constructor() {
    this.roles = [
      {
        id: "1",
        roleCode: "super_admin",
        roleName: "Super Administrator",
        description: "Full system authority",
        isSystemRole: true,
        isActive: true,
        permissions: ["all"],
        createdAt: new Date().toISOString(),
      },
      {
        id: "2",
        roleCode: "admin",
        roleName: "Academic Administrator",
        description: "Student, course, and batch management",
        isSystemRole: true,
        isActive: true,
        permissions: ["manage_students", "manage_batches", "view_reports"],
        createdAt: new Date().toISOString(),
      },
    ];
  }

  async getDashboardStats(): Promise<DashboardStats> {
    return {
      totalStudents: 120,
      activeStudents: 105,
      pendingApprovals: 5,
      totalCourses: 8,
      activeBatches: this.batches.length,
      totalTeachers: this.teachers.length,
      totalRevenueINR: 5400000,
      pendingFeesINR: 320000,
      certificatesIssued: 45,
      placementRate: 88,
      activePlacements: 14,
      supportTicketsCount: 3,
      systemAlertsCount: 0,
      totalEnrollments: this.enrollments.length,
      placementsCount: 28,
    };
  }

  async getSuperAdminDashboardStats(): Promise<SuperAdminDashboardStats> {
    return {
      totalRevenueYTD: 5400000,
      monthlyRecurringRevenue: 450000,
      totalActiveStudents: 105,
      totalFacultyMembers: this.teachers.length,
      totalAdminAccounts: this.admins.length,
      pendingFinancialOverrides: this.financialOverrides.filter((f) => f.status === "pending").length,
      pendingRefundRequests: this.refunds.filter((r) => r.refundStatus === "pending").length,
      systemHealthScore: 99.8,
      criticalSecurityAlerts: 0,
      activeCourseBatches: this.batches.length,
      certificatesAwaitingSignoff: 2,
      dataIntegrityStatus: "HEALTHY",
    };
  }

  async findAdmins(filter?: { search?: string | undefined; status?: string | undefined }): Promise<AdminProfile[]> {
    return this.admins.filter((a) => {
      if (filter?.status && a.status !== filter.status) return false;
      if (filter?.search) {
        const s = filter.search.toLowerCase();
        return a.name.toLowerCase().includes(s) || a.email.toLowerCase().includes(s);
      }
      return true;
    });
  }

  async findAdminById(id: EntityId): Promise<AdminProfile | null> {
    return this.admins.find((a) => a.id === id || a.userId === id) ?? null;
  }

  async createAdmin(input: {
    name: string;
    email: string;
    mobile: string;
    department?: string | undefined;
    permissions?: string[] | undefined;
    adminLevel?: string | undefined;
    employeeCode?: string | undefined;
  }): Promise<AdminProfile> {
    const id = `adm-${this.admins.length + 1}`;
    const admin: AdminProfile = {
      id,
      userId: id,
      name: input.name,
      email: input.email.toLowerCase(),
      mobile: input.mobile,
      role: "admin",
      status: "active",
      department: input.department ?? "Admissions & Operations",
      permissions: input.permissions ?? ["manage_students", "approve_students"],
      employeeCode: input.employeeCode ?? `EMP-${Date.now().toString().slice(-4)}`,
      adminLevel: input.adminLevel ?? "General",
      createdAt: new Date().toISOString(),
    };
    this.admins.push(admin);
    return admin;
  }

  async updateAdmin(
    id: EntityId,
    input: {
      name?: string | undefined;
      mobile?: string | undefined;
      department?: string | undefined;
      permissions?: string[] | undefined;
    },
  ): Promise<AdminProfile> {
    const admin = await this.findAdminById(id);
    if (!admin) throw new RecordNotFoundError("admin", id);
    if (input.name) admin.name = input.name;
    if (input.mobile) admin.mobile = input.mobile;
    if (input.department) admin.department = input.department;
    if (input.permissions) admin.permissions = input.permissions;
    return admin;
  }

  async setAdminStatus(id: EntityId, status: UserStatus): Promise<AdminProfile> {
    const admin = await this.findAdminById(id);
    if (!admin) throw new RecordNotFoundError("admin", id);
    admin.status = status;
    return admin;
  }

  async resetAdminPassword(id: EntityId): Promise<{ temporaryPassword?: string | undefined }> {
    const admin = await this.findAdminById(id);
    if (!admin) throw new RecordNotFoundError("admin", id);
    return { temporaryPassword: "TempPassword#2026" };
  }

  async findBatches(filter?: { courseId?: string | undefined; status?: string | undefined }): Promise<BatchRecord[]> {
    return this.batches.filter((b) => {
      if (filter?.courseId && b.courseId !== filter.courseId) return false;
      if (filter?.status && b.status.toLowerCase() !== filter.status.toLowerCase()) return false;
      return true;
    });
  }

  async findBatchById(id: EntityId): Promise<BatchRecord | null> {
    return this.batches.find((b) => b.id === id) ?? null;
  }

  async createBatch(input: {
    courseId: EntityId;
    batchCode: string;
    batchName: string;
    startDate?: string | undefined;
    endDate?: string | undefined;
    capacity?: number | undefined;
    scheduleDescription?: string | undefined;
  }): Promise<BatchRecord> {
    const id = `batch-${this.batches.length + 1}`;
    const batch: BatchRecord = {
      id,
      courseId: input.courseId,
      batchCode: input.batchCode,
      batchName: input.batchName,
      ...(input.startDate ? { startDate: input.startDate } : {}),
      ...(input.endDate ? { endDate: input.endDate } : {}),
      capacity: input.capacity ?? 40,
      ...(input.scheduleDescription ? { scheduleDescription: input.scheduleDescription } : {}),
      status: "upcoming",
      timeZoneId: "Asia/Kolkata",
      currentEnrollments: 0,
      createdAt: new Date().toISOString(),
    };
    this.batches.push(batch);
    return batch;
  }

  async updateBatch(
    id: EntityId,
    input: {
      batchName?: string | undefined;
      startDate?: string | undefined;
      endDate?: string | undefined;
      capacity?: number | undefined;
      scheduleDescription?: string | undefined;
    },
  ): Promise<BatchRecord> {
    const batch = await this.findBatchById(id);
    if (!batch) throw new RecordNotFoundError("batch", id);
    if (input.batchName) batch.batchName = input.batchName;
    if (input.startDate) batch.startDate = input.startDate;
    if (input.endDate) batch.endDate = input.endDate;
    if (input.capacity) batch.capacity = input.capacity;
    if (input.scheduleDescription) batch.scheduleDescription = input.scheduleDescription;
    batch.updatedAt = new Date().toISOString();
    return batch;
  }

  async setBatchStatus(id: EntityId, status: string): Promise<BatchRecord> {
    const batch = await this.findBatchById(id);
    if (!batch) throw new RecordNotFoundError("batch", id);
    batch.status = status;
    batch.updatedAt = new Date().toISOString();
    return batch;
  }

  async allocateTeacher(batchId: EntityId, teacherUserId: EntityId, _courseId?: EntityId): Promise<void> {
    const teachers = this.teacherAllocationsMap.get(batchId) ?? [];
    if (!teachers.includes(teacherUserId)) {
      teachers.push(teacherUserId);
      this.teacherAllocationsMap.set(batchId, teachers);
    }
  }

  async unallocateTeacher(batchId: EntityId, teacherUserId: EntityId): Promise<void> {
    const teachers = this.teacherAllocationsMap.get(batchId) ?? [];
    const idx = teachers.indexOf(teacherUserId);
    if (idx !== -1) {
      teachers.splice(idx, 1);
      this.teacherAllocationsMap.set(batchId, teachers);
    }
  }

  async findBatchStudents(batchId: EntityId): Promise<Student[]> {
    return this.batchStudentsMap.get(batchId) ?? [];
  }

  async findEnrollments(filter?: {
    studentId?: string | undefined;
    courseId?: string | undefined;
    batchId?: string | undefined;
    status?: string | undefined;
  }): Promise<EnrollmentAdminRecord[]> {
    return this.enrollments.filter((e) => {
      if (filter?.studentId && e.studentUserId !== filter.studentId) return false;
      if (filter?.courseId && e.courseId !== filter.courseId) return false;
      if (filter?.batchId && e.batchId !== filter.batchId) return false;
      if (filter?.status && e.enrollmentStatus.toLowerCase() !== filter.status.toLowerCase()) return false;
      return true;
    });
  }

  async createEnrollment(input: {
    studentUserId: EntityId;
    courseId: EntityId;
    batchId?: EntityId | undefined;
    coursePrice?: number | undefined;
    discountAmount?: number | undefined;
    finalAmount?: number | undefined;
    currencyCode?: string | undefined;
  }): Promise<EnrollmentAdminRecord> {
    const id = `enr-${this.enrollments.length + 1}`;
    const enr: EnrollmentAdminRecord = {
      id,
      studentUserId: input.studentUserId,
      courseId: input.courseId,
      ...(input.batchId ? { batchId: input.batchId } : {}),
      enrollmentNumber: `ENR-${Date.now().toString().slice(-6)}`,
      enrollmentStatus: "active",
      coursePrice: input.coursePrice ?? 45000,
      discountAmount: input.discountAmount ?? 0,
      finalAmount: input.finalAmount ?? input.coursePrice ?? 45000,
      currencyCode: input.currencyCode ?? "INR",
      enrollmentSource: "ADMIN_MANUAL",
      createdAt: new Date().toISOString(),
    };
    this.enrollments.push(enr);
    return enr;
  }

  async setEnrollmentStatus(id: EntityId, status: string): Promise<EnrollmentAdminRecord> {
    const enr = this.enrollments.find((e) => e.id === id);
    if (!enr) throw new RecordNotFoundError("enrollment", id);
    enr.enrollmentStatus = status;
    return enr;
  }

  async findAuditLogs(filter?: {
    actorUserId?: string | undefined;
    moduleCode?: string | undefined;
    startDate?: string | undefined;
    endDate?: string | undefined;
  }): Promise<AuditLogRecord[]> {
    return this.auditLogs.filter((l) => {
      if (filter?.actorUserId && l.actorUserId !== filter.actorUserId) return false;
      if (filter?.moduleCode && l.moduleCode !== filter.moduleCode) return false;
      return true;
    });
  }

  async createAuditLog(log: {
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
  }): Promise<AuditLogRecord> {
    const record: AuditLogRecord = {
      id: `audit-${this.auditLogs.length + 1}`,
      timestamp: new Date().toISOString(),
      actorUserId: log.actorUserId,
      actionType: log.actionType,
      moduleCode: log.moduleCode,
      entityName: log.entityName,
      entityId: log.entityId,
      ...(log.oldValues ? { oldValues: log.oldValues } : {}),
      ...(log.newValues ? { newValues: log.newValues } : {}),
      ...(log.ipAddress ? { ipAddress: log.ipAddress } : {}),
      ...(log.userAgent ? { userAgent: log.userAgent } : {}),
      details: log.details ?? `${log.actionType} on ${log.entityName}`,
    };
    this.auditLogs.push(record);
    return record;
  }

  async getInstituteSettings(): Promise<InstituteSettingsRecord> {
    return this.instituteSettings;
  }

  async saveInstituteSettings(
    settings: Partial<InstituteSettingsRecord>,
    _updatedByUserId?: EntityId,
  ): Promise<InstituteSettingsRecord> {
    Object.assign(this.instituteSettings, settings);
    return this.instituteSettings;
  }

  async getSystemConfig(): Promise<SystemConfigRecord> {
    return this.systemConfig;
  }

  async saveSystemConfig(
    config: Partial<SystemConfigRecord>,
    _updatedByUserId?: EntityId,
  ): Promise<SystemConfigRecord> {
    Object.assign(this.systemConfig, config);
    return this.systemConfig;
  }

  async findRefunds(status?: string | undefined): Promise<RefundRecord[]> {
    return this.refunds.filter((r) => {
      if (status && r.refundStatus.toLowerCase() !== status.toLowerCase()) return false;
      return true;
    });
  }

  async updateRefundStatus(
    id: EntityId,
    status: string,
    decidedByUserId: EntityId,
    _remarks?: string | undefined,
  ): Promise<RefundRecord> {
    const ref = this.refunds.find((r) => r.id === id);
    if (!ref) throw new RecordNotFoundError("refund", id);
    ref.refundStatus = status;
    ref.approvedAt = new Date().toISOString();
    ref.approvedBySuperAdminUserId = decidedByUserId;
    return ref;
  }

  async findFinancialOverrides(status?: string | undefined): Promise<FinancialOverrideRecord[]> {
    return this.financialOverrides.filter((f) => {
      if (status && f.status.toLowerCase() !== status.toLowerCase()) return false;
      return true;
    });
  }

  async updateFinancialOverride(
    id: EntityId,
    status: "approved" | "rejected",
    decidedByUserId: EntityId,
    remarks?: string | undefined,
  ): Promise<FinancialOverrideRecord> {
    const found = this.financialOverrides.find((f) => f.id === id);
    if (!found) throw new RecordNotFoundError("override", id);
    found.status = status;
    found.decidedAt = new Date().toISOString();
    found.decidedBySuperAdminId = decidedByUserId;
    if (remarks) found.superAdminRemarks = remarks;
    return found;
  }

  async findRoles(): Promise<GlobalRoleRecord[]> {
    return this.roles;
  }

  async createRole(role: {
    roleCode: string;
    roleName: string;
    description: string;
    permissions: string[];
  }): Promise<GlobalRoleRecord> {
    const id = `role-${this.roles.length + 1}`;
    const newRole: GlobalRoleRecord = {
      id,
      roleCode: role.roleCode,
      roleName: role.roleName,
      description: role.description,
      isSystemRole: false,
      isActive: true,
      permissions: role.permissions,
      createdAt: new Date().toISOString(),
    };
    this.roles.push(newRole);
    return newRole;
  }

  async updateRolePermissions(roleId: EntityId, permissions: string[]): Promise<GlobalRoleRecord> {
    const role = this.roles.find((r) => r.id === roleId);
    if (!role) throw new RecordNotFoundError("role", roleId);
    role.permissions = permissions;
    return role;
  }

  async unlockUserAccount(_userId: EntityId): Promise<void> {
    // No-op for fake
  }

  async findTeachers(filter?: { search?: string | undefined; status?: string | undefined }): Promise<Teacher[]> {
    return this.teachers.filter((t) => {
      if (filter?.status && t.status !== filter.status) return false;
      if (filter?.search) {
        const s = filter.search.toLowerCase();
        return t.name.toLowerCase().includes(s) || t.email.toLowerCase().includes(s);
      }
      return true;
    });
  }

  async createTeacherUser(input: {
    name: string;
    email: string;
    mobile: string;
    specialization?: string | undefined;
    experienceYears?: number | undefined;
    qualifications?: string | undefined;
    bio?: string | undefined;
  }): Promise<Teacher> {
    const id = `tch-${this.teachers.length + 1}`;
    const teacher: Teacher = {
      id,
      name: input.name,
      email: input.email.toLowerCase(),
      mobile: input.mobile,
      role: "teacher",
      status: "active",
      createdAt: new Date().toISOString(),
      specialization: input.specialization ?? "General",
      experienceYears: input.experienceYears ?? 0,
      bio: input.bio ?? "",
      qualifications: input.qualifications ?? "",
      assignedCourseIds: [],
      assignedBatchIds: [],
      rating: 5.0,
    };
    this.teachers.push(teacher);
    return teacher;
  }
}
