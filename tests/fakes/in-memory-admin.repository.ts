import type { EntityId } from "../../src/contracts/identifier.contract";
import type { UserStatus } from "../../src/contracts/user.contract";
import { DuplicateRecordError, RecordNotFoundError } from "../../src/repositories/repository.errors";
import {
  AdminRuleViolationError,
  FREE_ACCESS_OVERRIDE_TYPE,
  type AdminRepository,
  type EnrollmentStatusValue,
  type StaffAudit,
  type TransactionalAudit,
} from "../../src/modules/admin/admin.repository";
import type { BatchStatusValue } from "../../src/modules/admin/admin.validation";
import { checkCouponUsable, couponDiscountAmount } from "../../src/modules/payments/coupon-rules";
import { HistoryLog } from "./history-log";
import { financialYearLabel } from "../../src/modules/admin/reporting-period";
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
  AdminCreatedStudent,
} from "../../src/modules/admin/admin.types";
import type { Student } from "../../src/modules/students/student.types";
import type { Teacher } from "../../src/modules/teachers/teacher.types";

export class InMemoryAdminRepository implements AdminRepository {
  public admins: AdminProfile[] = [];
  public batches: BatchRecord[] = [];
  public enrollments: EnrollmentAdminRecord[] = [];
  public auditLogs: AuditLogRecord[] = [];
  /** Mirrors NXA_EnrollmentStatusHistory / NXA_FinancialAuditHistory writes. */
  public history = new HistoryLog();
  public refunds: RefundRecord[] = [];
  public financialOverrides: FinancialOverrideRecord[] = [];
  public roles: GlobalRoleRecord[] = [];
  public teachers: Teacher[] = [];
  public batchStudentsMap: Map<string, Student[]> = new Map();
  public teacherAllocationsMap: Map<string, string[]> = new Map(); // batchId -> teacherUserIds

  /** When true the settings audit write fails and nothing is saved (rolled-back transaction). */
  public failSettingsAudit = false;
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
  public settingsUpdatedBy: EntityId[] = [];


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
      revenueFinancialYearINR: 1200000,
      financialYearLabel: financialYearLabel(),
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

  /** Students with a placement record (NXA_PlacementRecords.StudentUserId), duplicates allowed. */
  public placementRecordStudentIds: string[] = [];

  async getPlacementCohort(range: { fromUtc: Date; toUtc: Date }): Promise<{ completedStudents: number; placedStudents: number }> {
    // Mirrors the SQL adapter: distinct completed-in-range students, and those of them with a placement record.
    const cohort = new Set(
      this.enrollments
        .filter((e) => e.enrollmentStatus === "completed" && e.completedAt && Date.parse(e.completedAt) >= range.fromUtc.getTime() && Date.parse(e.completedAt) < range.toUtc.getTime())
        .map((e) => e.studentUserId),
    );
    const placed = new Set(this.placementRecordStudentIds);
    return { completedStudents: cohort.size, placedStudents: [...cohort].filter((id) => placed.has(id)).length };
  }

  async getSuperAdminDashboardStats(): Promise<SuperAdminDashboardStats> {
    return {
      totalRevenueYTD: 1200000,
      financialYearLabel: financialYearLabel(),
      revenueThisMonth: 450000,
      totalActiveStudents: 105,
      totalFacultyMembers: this.teachers.length,
      totalAdminAccounts: this.admins.length,
      // Mirrors the SQL adapter: overrides are authorized when recorded.
      pendingFinancialOverrides: 0,
      pendingRefundRequests: this.refunds.filter((r) => r.refundStatus === "pending").length,
      systemHealthScore: null,
      criticalSecurityAlerts: null,
      activeCourseBatches: this.batches.length,
      certificatesAwaitingSignoff: null,
      dataIntegrityStatus: null,
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
    passwordHash: string;
    assignedByUserId: EntityId;
    department?: string | undefined;
    permissions?: string[] | undefined;
    adminLevel?: string | undefined;
    employeeCode?: string | undefined;
  }, audit?: StaffAudit): Promise<AdminProfile> {
    if (this.admins.some((a) => a.email.toLowerCase() === input.email.toLowerCase())) {
      throw new DuplicateRecordError("user", "email", input.email.toLowerCase());
    }
    const id = `adm-${this.admins.length + 1}`;
    await this.staffAudit(audit, id);
    this.passwordHashes.set(id, input.passwordHash);
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
    audit?: StaffAudit,
  ): Promise<AdminProfile> {
    const admin = await this.findAdminById(id);
    if (!admin) throw new RecordNotFoundError("admin", id);
    const changes =
      (input.name && input.name !== admin.name) ||
      (input.mobile && input.mobile !== admin.mobile) ||
      (input.department && input.department !== admin.department) ||
      (input.permissions && JSON.stringify(input.permissions) !== JSON.stringify(admin.permissions));
    if (!changes) return admin;
    await this.staffAudit(audit, id);
    if (input.name) admin.name = input.name;
    if (input.mobile) admin.mobile = input.mobile;
    if (input.department) admin.department = input.department;
    if (input.permissions) admin.permissions = input.permissions;
    return admin;
  }

  async setAdminStatus(id: EntityId, status: UserStatus, audit?: StaffAudit): Promise<AdminProfile> {
    const admin = await this.findAdminById(id);
    if (!admin) throw new RecordNotFoundError("admin", id);
    if (admin.status === status) return admin;
    await this.staffAudit(audit, id);
    admin.status = status;
    return admin;
  }

  /** Stored argon2id hashes, keyed by admin id (for assertions only). */
  readonly passwordHashes = new Map<EntityId, string>();

  async setAdminPassword(id: EntityId, passwordHash: string, audit?: StaffAudit): Promise<void> {
    const admin = await this.findAdminById(id);
    if (!admin || admin.role !== "admin") throw new RecordNotFoundError("admin", id);
    await this.staffAudit(audit, id);
    this.passwordHashes.set(id, passwordHash);
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
  }, audit?: StaffAudit): Promise<BatchRecord> {
    const id = `batch-${this.batches.length + 1}`;
    await this.staffAudit(audit, id);
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
    audit?: StaffAudit,
  ): Promise<BatchRecord> {
    const batch = await this.findBatchById(id);
    if (!batch) throw new RecordNotFoundError("batch", id);
    const changes =
      (input.batchName && input.batchName !== batch.batchName) ||
      (input.startDate && input.startDate !== batch.startDate) ||
      (input.endDate && input.endDate !== batch.endDate) ||
      (input.capacity && input.capacity !== batch.capacity) ||
      (input.scheduleDescription && input.scheduleDescription !== batch.scheduleDescription);
    if (!changes) return batch;
    await this.staffAudit(audit, id);
    if (input.batchName) batch.batchName = input.batchName;
    if (input.startDate) batch.startDate = input.startDate;
    if (input.endDate) batch.endDate = input.endDate;
    if (input.capacity) batch.capacity = input.capacity;
    if (input.scheduleDescription) batch.scheduleDescription = input.scheduleDescription;
    batch.updatedAt = new Date().toISOString();
    return batch;
  }

  async setBatchStatus(id: EntityId, status: BatchStatusValue, audit?: StaffAudit): Promise<BatchRecord> {
    const batch = await this.findBatchById(id);
    if (!batch) throw new RecordNotFoundError("batch", id);
    if (String(batch.status).toLowerCase() === String(status).toLowerCase()) return batch;
    await this.staffAudit(audit, id);
    batch.status = status;
    batch.updatedAt = new Date().toISOString();
    return batch;
  }

  /** Teacher user ids the fake treats as active teacher accounts. */
  readonly activeTeacherIds = new Set<string>();
  /** Course id -> list price, standing in for NXA_Courses. */
  readonly coursePrices = new Map<string, number>();
  /** Upper-cased code -> coupon, standing in for NXA_Coupons joined to NXA_Discounts. */
  readonly definedDiscounts = new Map<
    string,
    {
      type: "percentage" | "fixed_amount";
      value: number;
      isActive: boolean;
      startsAt?: Date;
      endsAt?: Date;
      usageLimit?: number | null;
      perUserLimit?: number | null;
      usageCount?: number;
    }
  >();
  /** Stands in for NXA_CouponRedemptions. */
  readonly couponRedemptions: Array<{ code: string; enrollmentId: string; studentUserId: string; discountAmount: number }> = [];
  /** Student id -> approval status, standing in for NXA_StudentProfiles. */
  readonly studentApprovals = new Map<string, "pending" | "approved" | "rejected">();

  async allocateTeacher(input: {
    batchId: EntityId;
    courseId: EntityId;
    teacherUserId: EntityId;
    allocatedByUserId: EntityId;
  }, audit?: StaffAudit): Promise<void> {
    const batch = await this.findBatchById(input.batchId);
    if (!batch) throw new RecordNotFoundError("batch", input.batchId);
    if (batch.courseId !== input.courseId) {
      throw new AdminRuleViolationError("BATCH_COURSE_MISMATCH", "The selected batch does not belong to the selected course");
    }
    if (["completed", "cancelled"].includes(batch.status)) {
      throw new AdminRuleViolationError("BATCH_CLOSED", `Cannot allocate a teacher to a ${batch.status} batch`);
    }
    if (!this.activeTeacherIds.has(input.teacherUserId)) {
      throw new AdminRuleViolationError("NOT_A_TEACHER", "The selected user is not a teacher account");
    }
    const teachers = this.teacherAllocationsMap.get(input.batchId) ?? [];
    if (teachers.includes(input.teacherUserId)) {
      throw new DuplicateRecordError("allocation", "teacherUserId", input.teacherUserId);
    }
    await this.staffAudit(audit, input.batchId);
    teachers.push(input.teacherUserId);
    this.teacherAllocationsMap.set(input.batchId, teachers);
    batch.allocatedTeacherIds = [...teachers];
  }

  async unallocateTeacher(batchId: EntityId, teacherUserId: EntityId, audit?: StaffAudit): Promise<void> {
    const teachers = this.teacherAllocationsMap.get(batchId) ?? [];
    const idx = teachers.indexOf(teacherUserId);
    if (idx === -1) throw new RecordNotFoundError("allocation", `${batchId}/${teacherUserId}`);
    await this.staffAudit(audit, batchId);
    teachers.splice(idx, 1);
    this.teacherAllocationsMap.set(batchId, teachers);
    const batch = await this.findBatchById(batchId);
    if (batch) batch.allocatedTeacherIds = [...teachers];
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

  async findEnrollmentById(id: EntityId): Promise<EnrollmentAdminRecord | null> {
    return this.enrollments.find((e) => e.id === id) ?? null;
  }

  async createEnrollment(input: {
    studentUserId: EntityId;
    courseId: EntityId;
    batchId?: EntityId | undefined;
    discountCode?: string | undefined;
    status: "approved_unpaid" | "active";
    freeAccess?: boolean | undefined;
    createdByUserId: EntityId;
    capacityOverrideReason?: string | undefined;
    prerequisiteOverrideReason?: string | undefined;
    audit: TransactionalAudit;
  }): Promise<EnrollmentAdminRecord> {
    const approval = this.studentApprovals.get(input.studentUserId);
    if (!approval) throw new RecordNotFoundError("student", input.studentUserId);
    if (approval !== "approved") {
      throw new AdminRuleViolationError("STUDENT_NOT_APPROVED", "The student must be approved before enrollment (BR-002)");
    }
    const price = this.coursePrices.get(input.courseId);
    if (price === undefined) throw new RecordNotFoundError("course", input.courseId);
    let discount = 0;
    const couponCode = input.discountCode?.toUpperCase();
    const coupon = couponCode ? this.definedDiscounts.get(couponCode) : undefined;
    if (couponCode) {
      // Mirrors the SQL adapter: same rules module, same rejection codes.
      if (!coupon) throw new AdminRuleViolationError("DISCOUNT_NOT_FOUND", "No coupon exists with this code");
      const used = this.couponRedemptions.filter((r) => r.code === couponCode && r.studentUserId === input.studentUserId).length;
      const rejection = checkCouponUsable(coupon, new Date(), coupon.perUserLimit != null ? used : null);
      if (rejection) throw new AdminRuleViolationError(rejection.code, rejection.message);
      discount = couponDiscountAmount(coupon.type, coupon.value, price);
      if (discount <= 0) {
        throw new AdminRuleViolationError("DISCOUNT_NOT_APPLICABLE", "This coupon gives no discount on this course");
      }
    }
    if (input.freeAccess) discount = price;
    if (input.batchId) {
      const batch = await this.findBatchById(input.batchId);
      if (!batch) throw new RecordNotFoundError("batch", input.batchId);
      if (batch.courseId !== input.courseId) {
        throw new AdminRuleViolationError("BATCH_COURSE_MISMATCH", "The selected batch does not belong to the selected course");
      }
    }
    // D6 / D4, mirroring the SQL adapter.
    let capacityOverride: { reason: string; capacity: number; enrolled: number } | null = null;
    if (input.batchId) {
      const batch = (await this.findBatchById(input.batchId))!;
      const enrolled = this.enrollments.filter((e) => e.batchId === input.batchId && e.enrollmentStatus !== "cancelled").length;
      if (batch.capacity !== null && batch.capacity !== undefined && enrolled >= batch.capacity) {
        if (!input.capacityOverrideReason) {
          throw new AdminRuleViolationError("BATCH_FULL", `This batch is full (${enrolled} of ${batch.capacity}). Give a capacity override reason to enroll anyway.`, 409);
        }
        capacityOverride = { reason: input.capacityOverrideReason, capacity: batch.capacity, enrolled };
      }
    }
    const prereqs = this.prerequisitesOf ? await this.prerequisitesOf(input.courseId) : [];
    const missing = prereqs.filter(
      (p) => !this.enrollments.some((e) => e.studentUserId === input.studentUserId && e.courseId === p.courseId && e.enrollmentStatus === "completed"),
    );
    let prerequisiteOverride: { reason: string; missingCourseIds: string[] } | null = null;
    if (missing.length > 0) {
      if (!input.prerequisiteOverrideReason) {
        throw new AdminRuleViolationError("PREREQUISITES_NOT_MET", `Prerequisite course(s) not completed: ${missing.map((p) => (p.courseCode ? `${p.title} (${p.courseCode})` : p.title)).join(", ")}. Give a prerequisite override reason to enroll anyway.`);
      }
      prerequisiteOverride = { reason: input.prerequisiteOverrideReason, missingCourseIds: missing.map((p) => p.courseId) };
    }
    if (this.failEnrollmentAudit) throw new Error("audit write failed");
    if (
      this.enrollments.some(
        (e) => e.studentUserId === input.studentUserId && e.courseId === input.courseId && e.enrollmentStatus !== "cancelled",
      )
    ) {
      throw new DuplicateRecordError("enrollment", "courseId", input.courseId);
    }

    const id = `enr-${this.enrollments.length + 1}`;
    const enr: EnrollmentAdminRecord = {
      id,
      studentUserId: input.studentUserId,
      courseId: input.courseId,
      ...(input.batchId ? { batchId: input.batchId } : {}),
      enrollmentNumber: `ENR-FAKE-${this.enrollments.length + 1}`,
      enrollmentStatus: input.status,
      coursePrice: price,
      discountAmount: discount,
      finalAmount: price - discount,
      currencyCode: "INR",
      enrollmentSource: "admin",
      ...(input.status === "active" ? { activatedAt: new Date().toISOString() } : {}),
      createdAt: new Date().toISOString(),
    };
    this.enrollments.push(enr);
    if (couponCode && coupon) {
      this.couponRedemptions.push({ code: couponCode, enrollmentId: id, studentUserId: input.studentUserId, discountAmount: discount });
      coupon.usageCount = (coupon.usageCount ?? 0) + 1;
    }
    // Mirrors the SQL adapter: a free-access grant is recorded as an override
    // authorized by the granting user.
    let overrideId: string | null = null;
    if (input.freeAccess) {
      overrideId = `fov-${this.financialOverrides.length + 1}`;
      const now = new Date().toISOString();
      this.financialOverrides.push({
        id: overrideId,
        studentId: input.studentUserId,
        courseId: input.courseId,
        enrollmentId: id,
        originalAmountINR: price,
        proposedAmountINR: 0,
        discountOrWaiverINR: price,
        adjustmentType: FREE_ACCESS_OVERRIDE_TYPE,
        reason: input.audit.reason ?? "",
        requestedByAdminId: input.audit.actorUserId,
        requestedAt: now,
        status: "approved",
        decidedAt: now,
      });
    }
    // Mirrors the SQL adapter: the audit row is written atomically with the change.
    await this.createAuditLog({
      actorUserId: input.audit.actorUserId,
      actionType: input.audit.actionType,
      moduleCode: "ENROLLMENT_MGMT",
      entityName: "Enrollment",
      entityId: id,
      newValues: JSON.stringify({
        status: input.status,
        requestedByUserId: input.audit.actorUserId,
        coursePrice: price,
        finalAmount: price - discount,
        ...(input.freeAccess
          ? { freeAccess: true, waivedAmount: price, overrideId, overrideType: FREE_ACCESS_OVERRIDE_TYPE }
          : {}),
        ...(input.audit.reason ? { reason: input.audit.reason } : {}),
        ...(capacityOverride ? { capacityOverride } : {}),
        ...(prerequisiteOverride ? { prerequisiteOverride } : {}),
      }),
    });
    this.history.enrollmentStatus.push({
      enrollmentId: id,
      oldStatus: null,
      newStatus: input.status.toUpperCase(),
      changedByUserId: input.audit.actorUserId,
      reason: input.audit.reason,
    });
    if (input.freeAccess && overrideId) {
      this.history.financial.push({
        entityType: "EnrollmentOverride",
        entityId: overrideId,
        actionType: input.audit.actionType,
        performedByUserId: input.audit.actorUserId,
        newValues: { enrollmentId: id, coursePrice: price, waivedAmount: price, finalAmount: price - discount },
        reason: input.audit.reason,
      });
    }
    if (couponCode && coupon) {
      this.history.financial.push({
        entityType: "CouponRedemption",
        entityId: `red-${this.couponRedemptions.length}`,
        actionType: "REDEEM_COUPON",
        performedByUserId: input.audit.actorUserId,
        newValues: { enrollmentId: id, couponCode, discountAmount: discount },
      });
    }
    return enr;
  }

  async setEnrollmentStatus(
    id: EntityId,
    status: EnrollmentStatusValue,
    audit: TransactionalAudit,
  ): Promise<EnrollmentAdminRecord> {
    const enr = this.enrollments.find((e) => e.id === id);
    if (!enr) throw new RecordNotFoundError("enrollment", id);
    if (enr.enrollmentStatus === status) {
      throw new AdminRuleViolationError("STATUS_UNCHANGED", `Enrollment is already ${status}`);
    }
    if (status === "active" && !(enr.enrollmentStatus === "suspended" && enr.activatedAt)) {
      throw new AdminRuleViolationError(
        "ACTIVATION_REQUIRES_PAYMENT",
        "Enrollment access is granted only by a verified payment, a recorded manual payment or a free-access override. Manual activation can only resume a suspended enrollment that was already activated.",
      );
    }
    const oldStatus = enr.enrollmentStatus;
    enr.enrollmentStatus = status;
    if (status === "active" && !enr.activatedAt) enr.activatedAt = new Date().toISOString();
    if (status === "completed" && !enr.completedAt) enr.completedAt = new Date().toISOString();
    await this.createAuditLog({
      actorUserId: audit.actorUserId,
      actionType: audit.actionType,
      moduleCode: "ENROLLMENT_MGMT",
      entityName: "Enrollment",
      entityId: id,
      oldValues: JSON.stringify({ status: oldStatus }),
      newValues: JSON.stringify({ status, ...(audit.reason ? { reason: audit.reason } : {}) }),
    });
    this.history.enrollmentStatus.push({
      enrollmentId: id,
      oldStatus: oldStatus.toUpperCase(),
      newStatus: status.toUpperCase(),
      changedByUserId: audit.actorUserId,
      reason: audit.reason,
    });
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
    updatedByUserId: EntityId,
  ): Promise<InstituteSettingsRecord> {
    // Mirrors the SQL adapter: only changed keys are written and audited, an
    // empty string clears a value, and change + audit are atomic.
    const oldValues: Record<string, unknown> = {};
    const newValues: Record<string, unknown> = {};
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(settings)) {
      if (v === undefined) continue;
      const key = k as keyof InstituteSettingsRecord;
      const value = v === "" ? undefined : v;
      if (this.instituteSettings[key] === value) continue;
      oldValues[k] = this.instituteSettings[key] ?? null;
      newValues[k] = v;
      next[k] = value;
    }
    this.settingsUpdatedBy.push(updatedByUserId);
    if (Object.keys(newValues).length > 0) {
      if (this.failSettingsAudit) throw new Error("audit write failed");
      Object.assign(this.instituteSettings, next);
      await this.createAuditLog({
        actorUserId: updatedByUserId,
        actionType: "UPDATE_SETTINGS",
        moduleCode: "INSTITUTE_SETTINGS",
        entityName: "InstituteSettings",
        entityId: "institute",
        oldValues: JSON.stringify(oldValues),
        newValues: JSON.stringify(newValues),
      });
    }
    return this.instituteSettings;
  }

  async findRefunds(status?: string | undefined): Promise<RefundRecord[]> {
    return this.refunds.filter((r) => {
      if (status && r.refundStatus.toLowerCase() !== status.toLowerCase()) return false;
      return true;
    });
  }

  async updateRefundStatus(
    id: EntityId,
    status: "approved" | "rejected",
    decidedByUserId: EntityId,
    remarks?: string | undefined,
  ): Promise<RefundRecord> {
    const ref = this.refunds.find((r) => r.id === id);
    if (!ref) throw new RecordNotFoundError("refund", id);
    if (ref.refundStatus !== "pending") {
      throw new AdminRuleViolationError(
        "REFUND_ALREADY_DECIDED",
        `This refund is already ${ref.refundStatus} and cannot be decided again`,
        409,
      );
    }
    ref.refundStatus = status;
    if (status === "approved") {
      ref.approvedAt = new Date().toISOString();
      ref.approvedBySuperAdminUserId = decidedByUserId;
    }
    await this.createAuditLog({
      actorUserId: decidedByUserId,
      actionType: status === "approved" ? "APPROVE_REFUND" : "REJECT_REFUND",
      moduleCode: "FINANCE",
      entityName: "Refund",
      entityId: id,
      oldValues: JSON.stringify({ status: "pending" }),
      newValues: JSON.stringify({ status, amount: ref.amount, ...(remarks ? { remarks } : {}) }),
    });
    this.history.financial.push({
      entityType: "Refund",
      entityId: id,
      actionType: status === "approved" ? "APPROVE_REFUND" : "REJECT_REFUND",
      performedByUserId: decidedByUserId,
      oldValues: { refundStatus: "PENDING" },
      newValues: { refundStatus: status.toUpperCase(), amount: ref.amount },
      reason: remarks,
    });
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
    _decidedByUserId: EntityId,
    _remarks?: string | undefined,
  ): Promise<FinancialOverrideRecord> {
    // Mirrors the SQL adapter: overrides are authorized when granted; never changes data.
    if (status === "rejected") {
      throw new AdminRuleViolationError(
        "OVERRIDE_REJECTION_UNSUPPORTED",
        "A financial override is authorized when it is granted and cannot be rejected afterwards. No change was made.",
      );
    }
    const found = this.financialOverrides.find((f) => f.id === id);
    if (!found) throw new RecordNotFoundError("financial override", id);
    throw new AdminRuleViolationError(
      "OVERRIDE_ALREADY_DECIDED",
      "This financial override was approved when it was granted. No change was made.",
      409,
    );
  }

  async findRoles(): Promise<GlobalRoleRecord[]> {
    // Mirrors the SQL adapter: no permission catalog yet, so no permissions.
    return this.roles.map((r) => ({ ...r, permissions: [] }));
  }

  /** User ids the fake treats as locked out (FailedLoginAttempts / IsLocked / LockoutUntil set). */
  readonly lockedUserIds = new Set<string>();

  async unlockUserAccount(userId: EntityId, audit?: StaffAudit): Promise<void> {
    // Nothing to clear: no write and no audit (mirrors the SQL adapter).
    if (!this.lockedUserIds.has(userId)) return;
    await this.staffAudit(audit, userId);
    this.lockedUserIds.delete(userId);
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

  /**
   * Where admin-created students are persisted. The test harness binds this
   * to the user and student fakes so OTP verification and approval see the
   * same account; without it the fake keeps its own ids.
   */
  public studentAccountSink?: (input: {
    name: string;
    email: string;
    mobile: string;
    collegeName?: string | undefined;
  }) => Promise<string>;
  public createdStudentIds: string[] = [];

  async createStudentUser(input: {
    name: string;
    email: string;
    mobile: string;
    passwordHash: string;
    createdByUserId: EntityId;
    collegeName?: string | undefined;
    interestedCourseId?: EntityId | undefined;
  }): Promise<AdminCreatedStudent> {
    if (input.interestedCourseId !== undefined && !this.coursePrices.has(input.interestedCourseId)) {
      throw new AdminRuleViolationError("COURSE_NOT_FOUND", "The selected course does not exist");
    }
    const id = this.studentAccountSink
      ? await this.studentAccountSink(input)
      : `adm-stu-${this.createdStudentIds.length + 1}`;
    this.createdStudentIds.push(id);
    this.studentApprovals.set(id, "pending");
    this.passwordHashes.set(id, input.passwordHash);
    await this.createAuditLog({
      actorUserId: input.createdByUserId,
      actionType: "CREATE_STUDENT",
      moduleCode: "STUDENT_MGMT",
      entityName: "Student",
      entityId: id,
      newValues: JSON.stringify({ email: input.email, accountStatus: "pending", approvalStatus: "pending" }),
    });
    return {
      id,
      name: input.name,
      email: input.email.toLowerCase(),
      mobile: input.mobile,
      accountStatus: "pending",
      approvalStatus: "pending",
      isEmailVerified: false,
      isMobileVerified: false,
      accountState: "pending_verification",
      createdAt: new Date().toISOString(),
    };
  }

  async createTeacherUser(input: {
    name: string;
    email: string;
    mobile: string;
    specialization?: string | undefined;
    experienceYears?: number | undefined;
    qualifications?: string | undefined;
    bio?: string | undefined;
  }, audit?: StaffAudit): Promise<Teacher> {
    const id = `tch-${this.teachers.length + 1}`;
    await this.staffAudit(audit, id);
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

  /** D4: prerequisite courses of a course (the harness reads the course fake). */
  prerequisitesOf?: (courseId: string) => Promise<Array<{ courseId: string; courseCode?: string | undefined; title: string }>>;
  /** Test hook: the enrollment audit write fails; nothing is stored (as the SQL transaction). */
  public failEnrollmentAudit = false;

  /** Test hook: the teacher audit write fails, proving the change rolls back. */
  public failTeacherAudit = false;

  /**
   * Test hook: a staff action's audit write (admin, batch, allocation, unlock,
   * teacher create) fails. The fake writes the audit before applying the
   * change, so a failure leaves nothing changed - like the SQL transaction.
   */
  public failStaffAudit = false;

  private async staffAudit(audit: StaffAudit | undefined, entityId: string): Promise<void> {
    if (!audit) return;
    if (this.failStaffAudit) throw new Error("audit write failed");
    await this.createAuditLog({
      actorUserId: audit.actorUserId,
      actionType: audit.actionType,
      moduleCode: audit.moduleCode,
      entityName: audit.entityName,
      entityId,
      details: audit.details,
    });
  }

  private async teacherAudit(entry: { actorUserId: EntityId; actionType: string; entityId: string; oldValues: string; newValues: string }): Promise<void> {
    if (this.failTeacherAudit) throw new Error("audit write failed");
    await this.createAuditLog({ ...entry, moduleCode: "TEACHER_MGMT", entityName: "Teacher" });
  }

  async updateTeacher(
    id: EntityId,
    changes: { name?: string | undefined; specialization?: string | null | undefined; experienceYears?: number | undefined; qualifications?: string | null | undefined; bio?: string | null | undefined },
    actorUserId: EntityId,
  ): Promise<{ record: Teacher; changed: boolean }> {
    const t = this.teachers.find((x) => x.id === String(id));
    if (!t) throw new RecordNotFoundError("teacher", id);
    const before: Record<string, unknown> = { name: t.name, specialization: t.specialization || null, experienceYears: t.experienceYears, qualifications: t.qualifications || null, bio: t.bio || null };
    const norm = (v: unknown) => (v === "" ? null : v);
    const diff = (Object.keys(changes) as Array<keyof typeof changes>).filter((k) => changes[k] !== undefined && norm(changes[k]) !== before[k]);
    if (diff.length === 0) return { record: { ...t }, changed: false };
    const snapshot = { ...t };
    for (const k of diff) (t as unknown as Record<string, unknown>)[k] = norm(changes[k]) ?? "";
    try {
      await this.teacherAudit({ actorUserId, actionType: "UPDATE_TEACHER", entityId: String(id), oldValues: JSON.stringify(before), newValues: JSON.stringify(changes) });
    } catch (err) {
      Object.assign(t, snapshot);
      throw err;
    }
    return { record: { ...t }, changed: true };
  }

  async setTeacherStatus(id: EntityId, status: "active" | "deactivated", _reason: string | undefined, actorUserId: EntityId): Promise<{ record: Teacher; changed: boolean }> {
    const t = this.teachers.find((x) => x.id === String(id));
    if (!t) throw new RecordNotFoundError("teacher", id);
    if (t.status === status) return { record: { ...t }, changed: false };
    const previous = t.status;
    t.status = status;
    try {
      await this.teacherAudit({ actorUserId, actionType: status === "active" ? "ACTIVATE_TEACHER" : "DEACTIVATE_TEACHER", entityId: String(id), oldValues: JSON.stringify({ status: previous }), newValues: JSON.stringify({ status }) });
    } catch (err) {
      t.status = previous;
      throw err;
    }
    return { record: { ...t }, changed: true };
  }
}
