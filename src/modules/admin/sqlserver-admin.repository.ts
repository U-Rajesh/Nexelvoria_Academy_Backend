import sql from "mssql";

import type { EntityId } from "../../contracts/identifier.contract";
import type { UserRole, UserStatus } from "../../contracts/user.contract";
import { getSqlServerPool } from "../../db/sqlserver.pool";
import { RecordNotFoundError } from "../../repositories/repository.errors";
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
import type { AdminRepository } from "./admin.repository";
import type { Student } from "../students/student.types";
import type { Teacher } from "../teachers/teacher.types";

export class SqlServerAdminRepository implements AdminRepository {
  constructor(
    private readonly poolOrFactory:
      | sql.ConnectionPool
      | (() => Promise<sql.ConnectionPool>) = getSqlServerPool,
  ) {}

  private async getPool(): Promise<sql.ConnectionPool> {
    return typeof this.poolOrFactory === "function"
      ? await this.poolOrFactory()
      : this.poolOrFactory;
  }

  async getDashboardStats(): Promise<DashboardStats> {
    const pool = await this.getPool();

    const [uCounts, cCount, bCount, eCounts, feeStats] = await Promise.all([
      pool.request().query<{ role: string; status: string; cnt: number }>(`
        SELECT Role AS role, AccountStatus AS status, COUNT(1) AS cnt
        FROM dbo.NXA_Users
        GROUP BY Role, AccountStatus
      `),
      pool.request().query<{ cnt: number }>(`
        SELECT COUNT(1) AS cnt FROM dbo.NXA_Courses WHERE DeletedAt IS NULL
      `),
      pool.request().query<{ cnt: number }>(`
        SELECT COUNT(1) AS cnt FROM dbo.NXA_Batches WHERE Status IN ('upcoming', 'ongoing')
      `),
      pool.request().query<{ cnt: number }>(`
        SELECT COUNT(1) AS cnt FROM dbo.NXA_Enrollments
      `),
      pool.request().query<{ totalRevenue: number | null; pendingRevenue: number | null }>(`
        SELECT 
          SUM(CASE WHEN EnrollmentStatus = 'ACTIVE' THEN FinalAmount ELSE 0 END) AS totalRevenue,
          SUM(CASE WHEN EnrollmentStatus = 'PENDING' THEN FinalAmount ELSE 0 END) AS pendingRevenue
        FROM dbo.NXA_Enrollments
      `),
    ]);

    let totalStudents = 0;
    let activeStudents = 0;
    let pendingApprovals = 0;
    let totalTeachers = 0;

    for (const r of uCounts.recordset) {
      const role = (r.role ?? "").toLowerCase();
      const status = (r.status ?? "").toLowerCase();
      if (role === "student") {
        totalStudents += Number(r.cnt);
        if (status === "active") activeStudents += Number(r.cnt);
        if (status === "pending" || status === "pending_approval") pendingApprovals += Number(r.cnt);
      } else if (role === "teacher") {
        totalTeachers += Number(r.cnt);
      }
    }

    const totalRevenueINR = Math.round(Number(feeStats.recordset[0]?.totalRevenue ?? 0));
    const pendingFeesINR = Math.round(Number(feeStats.recordset[0]?.pendingRevenue ?? 0));

    return {
      totalStudents,
      activeStudents,
      pendingApprovals,
      totalCourses: cCount.recordset[0]?.cnt ?? 0,
      activeBatches: bCount.recordset[0]?.cnt ?? 0,
      totalTeachers,
      totalRevenueINR,
      pendingFeesINR,
      certificatesIssued: 0,
      placementRate: 85,
      activePlacements: 12,
      supportTicketsCount: 0,
      systemAlertsCount: 0,
      totalEnrollments: eCounts.recordset[0]?.cnt ?? 0,
      placementsCount: 24,
    };
  }

  async getSuperAdminDashboardStats(): Promise<SuperAdminDashboardStats> {
    const pool = await this.getPool();

    const [uCounts, overrides, refunds, batches] = await Promise.all([
      pool.request().query<{ role: string; cnt: number }>(`
        SELECT Role AS role, COUNT(1) AS cnt
        FROM dbo.NXA_Users
        GROUP BY Role
      `),
      pool.request().query<{ cnt: number }>(`
        SELECT COUNT(1) AS cnt FROM dbo.NXA_EnrollmentOverrides
      `),
      pool.request().query<{ cnt: number }>(`
        SELECT COUNT(1) AS cnt FROM dbo.NXA_Refunds WHERE RefundStatus = 'PENDING'
      `),
      pool.request().query<{ cnt: number }>(`
        SELECT COUNT(1) AS cnt FROM dbo.NXA_Batches WHERE Status = 'ongoing'
      `),
    ]);

    let totalActiveStudents = 0;
    let totalFacultyMembers = 0;
    let totalAdminAccounts = 0;

    for (const r of uCounts.recordset) {
      const role = (r.role ?? "").toLowerCase();
      if (role === "student") totalActiveStudents += Number(r.cnt);
      else if (role === "teacher") totalFacultyMembers += Number(r.cnt);
      else if (role === "admin" || role === "super_admin") totalAdminAccounts += Number(r.cnt);
    }

    return {
      totalRevenueYTD: 2450000,
      monthlyRecurringRevenue: 380000,
      totalActiveStudents,
      totalFacultyMembers,
      totalAdminAccounts,
      pendingFinancialOverrides: overrides.recordset[0]?.cnt ?? 0,
      pendingRefundRequests: refunds.recordset[0]?.cnt ?? 0,
      systemHealthScore: 99.4,
      criticalSecurityAlerts: 0,
      activeCourseBatches: batches.recordset[0]?.cnt ?? 0,
      certificatesAwaitingSignoff: 0,
      dataIntegrityStatus: "HEALTHY",
    };
  }

  async findAdmins(filter?: { search?: string | undefined; status?: string | undefined }): Promise<AdminProfile[]> {
    const pool = await this.getPool();
    const req = pool.request();
    const conditions: string[] = ["u.Role IN ('admin', 'super_admin')"];

    if (filter?.status) {
      req.input("status", sql.VarChar(20), filter.status.toUpperCase());
      conditions.push("UPPER(u.AccountStatus) = @status");
    }
    if (filter?.search && filter.search.trim() !== "") {
      req.input("search", sql.NVarChar(150), `%${filter.search.trim()}%`);
      conditions.push("(u.FullName LIKE @search OR u.Email LIKE @search)");
    }

    const result = await req.query<{
      UserId: number | bigint;
      FullName: string;
      Email: string;
      MobileNumber: string;
      Role: string;
      AccountStatus: string;
      CreatedAt: Date;
      EmployeeCode: string | null;
      AdminLevel: string | null;
      IsActive: boolean | null;
    }>(`
      SELECT 
        u.UserId,
        u.FullName,
        u.Email,
        u.MobileNumber,
        u.Role,
        u.AccountStatus,
        u.CreatedAt,
        ap.EmployeeCode,
        ap.AdminLevel,
        ap.IsActive
      FROM dbo.NXA_Users u
      LEFT JOIN dbo.NXA_AdminProfiles ap ON ap.UserId = u.UserId
      WHERE ${conditions.join(" AND ")}
      ORDER BY u.CreatedAt DESC
    `);

    return result.recordset.map((r) => ({
      id: String(r.UserId),
      userId: String(r.UserId),
      name: r.FullName,
      email: r.Email,
      mobile: r.MobileNumber,
      role: (r.Role.toLowerCase() as UserRole) ?? "admin",
      status: (r.AccountStatus.toLowerCase() as UserStatus) ?? "active",
      department: r.AdminLevel ?? "Admissions & Operations",
      permissions: ["manage_students", "approve_students", "manage_batches", "view_reports"],
      ...(r.EmployeeCode ? { employeeCode: r.EmployeeCode } : {}),
      ...(r.AdminLevel ? { adminLevel: r.AdminLevel } : {}),
      createdAt: r.CreatedAt.toISOString(),
    }));
  }

  async findAdminById(id: EntityId): Promise<AdminProfile | null> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("userId", sql.BigInt, id);

    const result = await req.query<{
      UserId: number | bigint;
      FullName: string;
      Email: string;
      MobileNumber: string;
      Role: string;
      AccountStatus: string;
      CreatedAt: Date;
      EmployeeCode: string | null;
      AdminLevel: string | null;
      IsActive: boolean | null;
    }>(`
      SELECT 
        u.UserId,
        u.FullName,
        u.Email,
        u.MobileNumber,
        u.Role,
        u.AccountStatus,
        u.CreatedAt,
        ap.EmployeeCode,
        ap.AdminLevel,
        ap.IsActive
      FROM dbo.NXA_Users u
      LEFT JOIN dbo.NXA_AdminProfiles ap ON ap.UserId = u.UserId
      WHERE u.UserId = @userId AND u.Role IN ('admin', 'super_admin')
    `);

    const r = result.recordset[0];
    if (!r) return null;

    return {
      id: String(r.UserId),
      userId: String(r.UserId),
      name: r.FullName,
      email: r.Email,
      mobile: r.MobileNumber,
      role: (r.Role.toLowerCase() as UserRole) ?? "admin",
      status: (r.AccountStatus.toLowerCase() as UserStatus) ?? "active",
      department: r.AdminLevel ?? "Admissions & Operations",
      permissions: ["manage_students", "approve_students", "manage_batches", "view_reports"],
      ...(r.EmployeeCode ? { employeeCode: r.EmployeeCode } : {}),
      ...(r.AdminLevel ? { adminLevel: r.AdminLevel } : {}),
      createdAt: r.CreatedAt.toISOString(),
    };
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
    const pool = await this.getPool();
    const tx = pool.transaction();
    await tx.begin();

    try {
      const uReq = tx.request();
      uReq.input("name", sql.NVarChar(150), input.name);
      uReq.input("email", sql.NVarChar(255), input.email.toLowerCase());
      uReq.input("mobile", sql.VarChar(20), input.mobile);
      uReq.input("role", sql.VarChar(20), "admin");
      uReq.input("status", sql.VarChar(20), "ACTIVE");

      const uRes = await uReq.query<{ UserId: number | bigint }>(`
        INSERT INTO dbo.NXA_Users (FullName, Email, MobileNumber, Role, AccountStatus, CreatedAt, UpdatedAt)
        OUTPUT inserted.UserId
        VALUES (@name, @email, @mobile, @role, @status, SYSUTCDATETIME(), SYSUTCDATETIME())
      `);

      const userId = uRes.recordset[0]!.UserId;
      const empCode = input.employeeCode ?? `ADM-${userId}`;

      const apReq = tx.request();
      apReq.input("userId", sql.BigInt, userId);
      apReq.input("empCode", sql.VarChar(40), empCode);
      apReq.input("level", sql.VarChar(20), input.adminLevel ?? input.department ?? "General");

      await apReq.query(`
        INSERT INTO dbo.NXA_AdminProfiles (UserId, EmployeeCode, AdminLevel, IsActive, CreatedAt)
        VALUES (@userId, @empCode, @level, 1, SYSUTCDATETIME())
      `);

      await tx.commit();

      return {
        id: String(userId),
        userId: String(userId),
        name: input.name,
        email: input.email.toLowerCase(),
        mobile: input.mobile,
        role: "admin",
        status: "active",
        department: input.department ?? "Admissions & Operations",
        permissions: input.permissions ?? ["manage_students", "approve_students"],
        employeeCode: empCode,
        adminLevel: input.adminLevel ?? "General",
        createdAt: new Date().toISOString(),
      };
    } catch (err) {
      await tx.rollback();
      throw err;
    }
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
    const existing = await this.findAdminById(id);
    if (!existing) throw new RecordNotFoundError("admin", id);

    const pool = await this.getPool();
    const req = pool.request();
    req.input("userId", sql.BigInt, id);
    req.input("name", sql.NVarChar(150), input.name ?? existing.name);
    req.input("mobile", sql.VarChar(20), input.mobile ?? existing.mobile);
    req.input("level", sql.VarChar(20), input.department ?? existing.department);

    await req.query(`
      UPDATE dbo.NXA_Users
      SET FullName = @name, MobileNumber = @mobile, UpdatedAt = SYSUTCDATETIME()
      WHERE UserId = @userId;

      UPDATE dbo.NXA_AdminProfiles
      SET AdminLevel = @level
      WHERE UserId = @userId;
    `);

    const updated = await this.findAdminById(id);
    if (!updated) throw new RecordNotFoundError("admin", id);
    return updated;
  }

  async setAdminStatus(id: EntityId, status: UserStatus): Promise<AdminProfile> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("userId", sql.BigInt, id);
    req.input("status", sql.VarChar(20), status.toUpperCase());

    const result = await req.query(`
      UPDATE dbo.NXA_Users
      SET AccountStatus = @status, UpdatedAt = SYSUTCDATETIME()
      WHERE UserId = @userId AND Role IN ('admin', 'super_admin');

      UPDATE dbo.NXA_AdminProfiles
      SET IsActive = CASE WHEN @status = 'ACTIVE' THEN 1 ELSE 0 END
      WHERE UserId = @userId;
    `);

    if ((result.rowsAffected[0] ?? 0) === 0) {
      throw new RecordNotFoundError("admin", id);
    }

    const updated = await this.findAdminById(id);
    if (!updated) throw new RecordNotFoundError("admin", id);
    return updated;
  }

  async resetAdminPassword(id: EntityId): Promise<{ temporaryPassword?: string | undefined }> {
    const admin = await this.findAdminById(id);
    if (!admin) throw new RecordNotFoundError("admin", id);
    return { temporaryPassword: "TempPass@" + Math.floor(100000 + Math.random() * 900000) };
  }

  // Batches
  async findBatches(filter?: { courseId?: string | undefined; status?: string | undefined }): Promise<BatchRecord[]> {
    const pool = await this.getPool();
    const req = pool.request();
    const conditions: string[] = ["1=1"];

    if (filter?.courseId) {
      req.input("courseId", sql.BigInt, filter.courseId);
      conditions.push("b.CourseId = @courseId");
    }
    if (filter?.status) {
      req.input("status", sql.VarChar(20), filter.status.toLowerCase());
      conditions.push("LOWER(b.Status) = @status");
    }

    const result = await req.query<{
      BatchId: number | bigint;
      CourseId: number | bigint;
      BatchCode: string;
      BatchName: string;
      StartDate: Date | null;
      EndDate: Date | null;
      Capacity: number | null;
      ScheduleDescription: string | null;
      Status: string;
      TimeZoneId: string | null;
      CreatedAt: Date;
      UpdatedAt: Date | null;
      CurrentEnrollments: number | null;
    }>(`
      SELECT 
        b.BatchId,
        b.CourseId,
        b.BatchCode,
        b.BatchName,
        b.StartDate,
        b.EndDate,
        b.Capacity,
        b.ScheduleDescription,
        b.Status,
        b.TimeZoneId,
        b.CreatedAt,
        b.UpdatedAt,
        (SELECT COUNT(1) FROM dbo.NXA_Enrollments e WHERE e.BatchId = b.BatchId) AS CurrentEnrollments
      FROM dbo.NXA_Batches b
      WHERE ${conditions.join(" AND ")}
      ORDER BY b.CreatedAt DESC
    `);

    return result.recordset.map((r) => ({
      id: String(r.BatchId),
      courseId: String(r.CourseId),
      batchCode: r.BatchCode,
      batchName: r.BatchName,
      ...(r.StartDate ? { startDate: r.StartDate.toISOString().split("T")[0] } : {}),
      ...(r.EndDate ? { endDate: r.EndDate.toISOString().split("T")[0] } : {}),
      capacity: r.Capacity ?? 40,
      ...(r.ScheduleDescription ? { scheduleDescription: r.ScheduleDescription } : {}),
      status: (r.Status ?? "upcoming").toLowerCase(),
      timeZoneId: r.TimeZoneId ?? "Asia/Kolkata",
      currentEnrollments: r.CurrentEnrollments ?? 0,
      createdAt: r.CreatedAt.toISOString(),
      ...(r.UpdatedAt ? { updatedAt: r.UpdatedAt.toISOString() } : {}),
    }));
  }

  async findBatchById(id: EntityId): Promise<BatchRecord | null> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("batchId", sql.BigInt, id);

    const result = await req.query<{
      BatchId: number | bigint;
      CourseId: number | bigint;
      BatchCode: string;
      BatchName: string;
      StartDate: Date | null;
      EndDate: Date | null;
      Capacity: number | null;
      ScheduleDescription: string | null;
      Status: string;
      TimeZoneId: string | null;
      CreatedAt: Date;
      UpdatedAt: Date | null;
      CurrentEnrollments: number | null;
    }>(`
      SELECT 
        b.BatchId,
        b.CourseId,
        b.BatchCode,
        b.BatchName,
        b.StartDate,
        b.EndDate,
        b.Capacity,
        b.ScheduleDescription,
        b.Status,
        b.TimeZoneId,
        b.CreatedAt,
        b.UpdatedAt,
        (SELECT COUNT(1) FROM dbo.NXA_Enrollments e WHERE e.BatchId = b.BatchId) AS CurrentEnrollments
      FROM dbo.NXA_Batches b
      WHERE b.BatchId = @batchId
    `);

    const r = result.recordset[0];
    if (!r) return null;

    return {
      id: String(r.BatchId),
      courseId: String(r.CourseId),
      batchCode: r.BatchCode,
      batchName: r.BatchName,
      ...(r.StartDate ? { startDate: r.StartDate.toISOString().split("T")[0] } : {}),
      ...(r.EndDate ? { endDate: r.EndDate.toISOString().split("T")[0] } : {}),
      capacity: r.Capacity ?? 40,
      ...(r.ScheduleDescription ? { scheduleDescription: r.ScheduleDescription } : {}),
      status: (r.Status ?? "upcoming").toLowerCase(),
      timeZoneId: r.TimeZoneId ?? "Asia/Kolkata",
      currentEnrollments: r.CurrentEnrollments ?? 0,
      createdAt: r.CreatedAt.toISOString(),
      ...(r.UpdatedAt ? { updatedAt: r.UpdatedAt.toISOString() } : {}),
    };
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
    const pool = await this.getPool();
    const req = pool.request();
    req.input("courseId", sql.BigInt, input.courseId);
    req.input("code", sql.VarChar(40), input.batchCode);
    req.input("name", sql.NVarChar(150), input.batchName);
    req.input("start", sql.Date, input.startDate ? new Date(input.startDate) : null);
    req.input("end", sql.Date, input.endDate ? new Date(input.endDate) : null);
    req.input("capacity", sql.Int, input.capacity ?? 40);
    req.input("desc", sql.NVarChar(500), input.scheduleDescription ?? null);

    const result = await req.query<{ BatchId: number | bigint }>(`
      INSERT INTO dbo.NXA_Batches (
        CourseId, BatchCode, BatchName, StartDate, EndDate, Capacity,
        ScheduleDescription, Status, TimeZoneId, CreatedAt, UpdatedAt
      )
      OUTPUT inserted.BatchId
      VALUES (
        @courseId, @code, @name, @start, @end, @capacity,
        @desc, 'upcoming', 'Asia/Kolkata', SYSUTCDATETIME(), SYSUTCDATETIME()
      )
    `);

    const id = String(result.recordset[0]?.BatchId);
    return {
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
    const existing = await this.findBatchById(id);
    if (!existing) throw new RecordNotFoundError("batch", id);

    const pool = await this.getPool();
    const req = pool.request();
    req.input("batchId", sql.BigInt, id);
    req.input("name", sql.NVarChar(150), input.batchName ?? existing.batchName);
    req.input("start", sql.Date, input.startDate ? new Date(input.startDate) : (existing.startDate ? new Date(existing.startDate) : null));
    req.input("end", sql.Date, input.endDate ? new Date(input.endDate) : (existing.endDate ? new Date(existing.endDate) : null));
    req.input("capacity", sql.Int, input.capacity ?? existing.capacity ?? 40);
    req.input("desc", sql.NVarChar(500), input.scheduleDescription ?? existing.scheduleDescription ?? null);

    await req.query(`
      UPDATE dbo.NXA_Batches
      SET BatchName = @name, StartDate = @start, EndDate = @end, Capacity = @capacity,
          ScheduleDescription = @desc, UpdatedAt = SYSUTCDATETIME()
      WHERE BatchId = @batchId
    `);

    const updated = await this.findBatchById(id);
    if (!updated) throw new RecordNotFoundError("batch", id);
    return updated;
  }

  async setBatchStatus(id: EntityId, status: string): Promise<BatchRecord> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("batchId", sql.BigInt, id);
    req.input("status", sql.VarChar(20), status.toLowerCase());

    const result = await req.query(`
      UPDATE dbo.NXA_Batches
      SET Status = @status, UpdatedAt = SYSUTCDATETIME()
      WHERE BatchId = @batchId
    `);

    if ((result.rowsAffected[0] ?? 0) === 0) {
      throw new RecordNotFoundError("batch", id);
    }

    const updated = await this.findBatchById(id);
    if (!updated) throw new RecordNotFoundError("batch", id);
    return updated;
  }

  async allocateTeacher(batchId: EntityId, teacherUserId: EntityId, courseId?: EntityId): Promise<void> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("batchId", sql.BigInt, batchId);
    req.input("teacherId", sql.BigInt, teacherUserId);
    req.input("courseId", sql.BigInt, courseId ?? 1);

    await req.query(`
      IF NOT EXISTS (
        SELECT 1 FROM dbo.NXA_TeacherAllocations 
        WHERE TeacherUserId = @teacherId AND BatchId = @batchId AND IsActive = 1
      )
      BEGIN
        INSERT INTO dbo.NXA_TeacherAllocations (TeacherUserId, CourseId, BatchId, IsActive, AllocatedAt)
        VALUES (@teacherId, @courseId, @batchId, 1, SYSUTCDATETIME())
      END
    `);
  }

  async unallocateTeacher(batchId: EntityId, teacherUserId: EntityId): Promise<void> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("batchId", sql.BigInt, batchId);
    req.input("teacherId", sql.BigInt, teacherUserId);

    await req.query(`
      UPDATE dbo.NXA_TeacherAllocations
      SET IsActive = 0
      WHERE BatchId = @batchId AND TeacherUserId = @teacherId
    `);
  }

  async findBatchStudents(batchId: EntityId): Promise<Student[]> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("batchId", sql.BigInt, batchId);

    const result = await req.query<{
      UserId: number | bigint;
      FullName: string;
      Email: string;
      MobileNumber: string;
      AccountStatus: string;
      CreatedAt: Date;
      CollegeName: string | null;
      DegreeBranch: string | null;
      PassingYear: string | null;
      CourseInterestedIn: string | null;
    }>(`
      SELECT 
        u.UserId,
        u.FullName,
        u.Email,
        u.MobileNumber,
        u.AccountStatus,
        u.CreatedAt,
        sp.CollegeName,
        sp.DegreeBranch,
        sp.PassingYear,
        sp.CourseInterestedIn
      FROM dbo.NXA_Enrollments e
      INNER JOIN dbo.NXA_Users u ON u.UserId = e.StudentUserId
      LEFT JOIN dbo.NXA_StudentProfiles sp ON sp.UserId = u.UserId
      WHERE e.BatchId = @batchId
    `);

    return result.recordset.map((r) => ({
      id: String(r.UserId),
      userId: String(r.UserId),
      name: r.FullName,
      email: r.Email,
      mobile: r.MobileNumber,
      role: "student",
      status: (r.AccountStatus.toLowerCase() as UserStatus) ?? "active",
      collegeName: r.CollegeName ?? "",
      degreeBranch: r.DegreeBranch ?? "",
      passingYear: r.PassingYear ?? "",
      courseInterestedIn: r.CourseInterestedIn ?? "",
      dateOfBirth: "",
      gender: "other",
      fullAddress: "",
      isEmailVerified: true,
      isMobileVerified: false,
      adminApprovalStatus: "approved",
      enrolledCourseIds: [],
      createdAt: r.CreatedAt.toISOString(),
    }));
  }

  // Enrollments
  async findEnrollments(filter?: {
    studentId?: string | undefined;
    courseId?: string | undefined;
    batchId?: string | undefined;
    status?: string | undefined;
  }): Promise<EnrollmentAdminRecord[]> {
    const pool = await this.getPool();
    const req = pool.request();
    const conditions: string[] = ["1=1"];

    if (filter?.studentId) {
      req.input("studentId", sql.BigInt, filter.studentId);
      conditions.push("e.StudentUserId = @studentId");
    }
    if (filter?.courseId) {
      req.input("courseId", sql.BigInt, filter.courseId);
      conditions.push("e.CourseId = @courseId");
    }
    if (filter?.batchId) {
      req.input("batchId", sql.BigInt, filter.batchId);
      conditions.push("e.BatchId = @batchId");
    }
    if (filter?.status) {
      req.input("status", sql.VarChar(25), filter.status.toUpperCase());
      conditions.push("UPPER(e.EnrollmentStatus) = @status");
    }

    const result = await req.query<{
      EnrollmentId: number | bigint;
      StudentUserId: number | bigint;
      StudentName: string | null;
      StudentEmail: string | null;
      CourseId: number | bigint;
      CourseTitle: string | null;
      BatchId: number | bigint | null;
      BatchCode: string | null;
      EnrollmentNumber: string;
      EnrollmentStatus: string;
      CoursePrice: number;
      DiscountAmount: number;
      FinalAmount: number;
      CurrencyCode: string;
      EnrollmentSource: string;
      ActivatedAt: Date | null;
      CompletedAt: Date | null;
      CreatedAt: Date;
    }>(`
      SELECT 
        e.EnrollmentId,
        e.StudentUserId,
        u.FullName AS StudentName,
        u.Email AS StudentEmail,
        e.CourseId,
        c.CourseName AS CourseTitle,
        e.BatchId,
        b.BatchCode,
        e.EnrollmentNumber,
        e.EnrollmentStatus,
        e.CoursePrice,
        e.DiscountAmount,
        e.FinalAmount,
        e.CurrencyCode,
        e.EnrollmentSource,
        e.ActivatedAt,
        e.CompletedAt,
        e.CreatedAt
      FROM dbo.NXA_Enrollments e
      LEFT JOIN dbo.NXA_Users u ON u.UserId = e.StudentUserId
      LEFT JOIN dbo.NXA_Courses c ON c.CourseId = e.CourseId
      LEFT JOIN dbo.NXA_Batches b ON b.BatchId = e.BatchId
      WHERE ${conditions.join(" AND ")}
      ORDER BY e.CreatedAt DESC
    `);

    return result.recordset.map((r) => ({
      id: String(r.EnrollmentId),
      studentUserId: String(r.StudentUserId),
      ...(r.StudentName ? { studentName: r.StudentName } : {}),
      ...(r.StudentEmail ? { studentEmail: r.StudentEmail } : {}),
      courseId: String(r.CourseId),
      ...(r.CourseTitle ? { courseTitle: r.CourseTitle } : {}),
      ...(r.BatchId ? { batchId: String(r.BatchId) } : {}),
      ...(r.BatchCode ? { batchCode: r.BatchCode } : {}),
      enrollmentNumber: r.EnrollmentNumber,
      enrollmentStatus: r.EnrollmentStatus.toLowerCase(),
      coursePrice: Number(r.CoursePrice),
      discountAmount: Number(r.DiscountAmount),
      finalAmount: Number(r.FinalAmount),
      currencyCode: r.CurrencyCode ?? "INR",
      enrollmentSource: r.EnrollmentSource ?? "DIRECT",
      ...(r.ActivatedAt ? { activatedAt: r.ActivatedAt.toISOString() } : {}),
      ...(r.CompletedAt ? { completedAt: r.CompletedAt.toISOString() } : {}),
      createdAt: r.CreatedAt.toISOString(),
    }));
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
    const pool = await this.getPool();
    const req = pool.request();
    const enrNum = `ENR-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;

    req.input("studentId", sql.BigInt, input.studentUserId);
    req.input("courseId", sql.BigInt, input.courseId);
    req.input("batchId", sql.BigInt, input.batchId ?? null);
    req.input("enrNum", sql.VarChar(40), enrNum);
    req.input("status", sql.VarChar(25), "ACTIVE");
    req.input("price", sql.Decimal(12, 2), input.coursePrice ?? 0);
    req.input("discount", sql.Decimal(12, 2), input.discountAmount ?? 0);
    req.input("final", sql.Decimal(12, 2), input.finalAmount ?? input.coursePrice ?? 0);
    req.input("currency", sql.Char(3), input.currencyCode ?? "INR");

    const result = await req.query<{ EnrollmentId: number | bigint }>(`
      INSERT INTO dbo.NXA_Enrollments (
        StudentUserId, CourseId, BatchId, EnrollmentNumber, EnrollmentStatus,
        CoursePrice, DiscountAmount, FinalAmount, CurrencyCode, EnrollmentSource,
        ActivatedAt, CreatedAt, UpdatedAt
      )
      OUTPUT inserted.EnrollmentId
      VALUES (
        @studentId, @courseId, @batchId, @enrNum, @status,
        @price, @discount, @final, @currency, 'ADMIN_MANUAL',
        SYSUTCDATETIME(), SYSUTCDATETIME(), SYSUTCDATETIME()
      )
    `);

    const id = String(result.recordset[0]?.EnrollmentId);
    return {
      id,
      studentUserId: input.studentUserId,
      courseId: input.courseId,
      ...(input.batchId ? { batchId: input.batchId } : {}),
      enrollmentNumber: enrNum,
      enrollmentStatus: "active",
      coursePrice: input.coursePrice ?? 0,
      discountAmount: input.discountAmount ?? 0,
      finalAmount: input.finalAmount ?? input.coursePrice ?? 0,
      currencyCode: input.currencyCode ?? "INR",
      enrollmentSource: "ADMIN_MANUAL",
      createdAt: new Date().toISOString(),
    };
  }

  async setEnrollmentStatus(id: EntityId, status: string): Promise<EnrollmentAdminRecord> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("enrId", sql.BigInt, id);
    req.input("status", sql.VarChar(25), status.toUpperCase());

    const result = await req.query(`
      UPDATE dbo.NXA_Enrollments
      SET EnrollmentStatus = @status, UpdatedAt = SYSUTCDATETIME()
      WHERE EnrollmentId = @enrId
    `);

    if ((result.rowsAffected[0] ?? 0) === 0) {
      throw new RecordNotFoundError("enrollment", id);
    }

    const all = await this.findEnrollments({ studentId: undefined });
    const enr = all.find((e) => e.id === id);
    if (!enr) throw new RecordNotFoundError("enrollment", id);
    return enr;
  }

  // Audit Logs
  async findAuditLogs(filter?: {
    actorUserId?: string | undefined;
    moduleCode?: string | undefined;
    startDate?: string | undefined;
    endDate?: string | undefined;
  }): Promise<AuditLogRecord[]> {
    const pool = await this.getPool();
    const req = pool.request();
    const conditions: string[] = ["1=1"];

    if (filter?.actorUserId) {
      req.input("actorId", sql.BigInt, filter.actorUserId);
      conditions.push("al.ActorUserId = @actorId");
    }
    if (filter?.moduleCode) {
      req.input("moduleCode", sql.VarChar(50), filter.moduleCode);
      conditions.push("al.ModuleCode = @moduleCode");
    }

    const result = await req.query<{
      AuditLogId: number | bigint;
      ActorUserId: number | bigint;
      ActorName: string | null;
      ActorRole: string | null;
      ActionType: string;
      ModuleCode: string;
      EntityName: string;
      EntityId: string;
      OldValues: string | null;
      NewValues: string | null;
      IpAddress: string | null;
      UserAgent: string | null;
      CorrelationId: string | null;
      CreatedAt: Date;
    }>(`
      SELECT TOP 200
        al.AuditLogId,
        al.ActorUserId,
        u.FullName AS ActorName,
        u.Role AS ActorRole,
        al.ActionType,
        al.ModuleCode,
        al.EntityName,
        al.EntityId,
        al.OldValues,
        al.NewValues,
        al.IpAddress,
        al.UserAgent,
        CAST(al.CorrelationId AS VARCHAR(50)) AS CorrelationId,
        al.CreatedAt
      FROM dbo.NXA_AuditLogs al
      LEFT JOIN dbo.NXA_Users u ON u.UserId = al.ActorUserId
      WHERE ${conditions.join(" AND ")}
      ORDER BY al.CreatedAt DESC
    `);

    return result.recordset.map((r) => ({
      id: String(r.AuditLogId),
      timestamp: r.CreatedAt.toISOString(),
      actorUserId: String(r.ActorUserId),
      ...(r.ActorName ? { actorName: r.ActorName } : {}),
      ...(r.ActorRole ? { actorRole: r.ActorRole } : {}),
      actionType: r.ActionType,
      moduleCode: r.ModuleCode,
      entityName: r.EntityName,
      entityId: r.EntityId,
      ...(r.OldValues ? { oldValues: r.OldValues } : {}),
      ...(r.NewValues ? { newValues: r.NewValues } : {}),
      ...(r.IpAddress ? { ipAddress: r.IpAddress } : {}),
      ...(r.UserAgent ? { userAgent: r.UserAgent } : {}),
      ...(r.CorrelationId ? { correlationId: r.CorrelationId } : {}),
      details: `${r.ActionType} on ${r.EntityName} (${r.EntityId})`,
    }));
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
    const pool = await this.getPool();
    const req = pool.request();
    req.input("actorId", sql.BigInt, log.actorUserId);
    req.input("action", sql.VarChar(80), log.actionType);
    req.input("module", sql.VarChar(50), log.moduleCode);
    req.input("ename", sql.VarChar(150), log.entityName);
    req.input("eid", sql.VarChar(100), log.entityId);
    req.input("oldVal", sql.NVarChar(sql.MAX), log.oldValues ?? null);
    req.input("newVal", sql.NVarChar(sql.MAX), log.newValues ?? null);
    req.input("ip", sql.VarChar(45), log.ipAddress ?? null);
    req.input("ua", sql.NVarChar(500), log.userAgent ?? null);

    const result = await req.query<{ AuditLogId: number | bigint }>(`
      INSERT INTO dbo.NXA_AuditLogs (
        ActorUserId, ActionType, ModuleCode, EntityName, EntityId,
        OldValues, NewValues, IpAddress, UserAgent, CorrelationId, CreatedAt
      )
      OUTPUT inserted.AuditLogId
      VALUES (
        @actorId, @action, @module, @ename, @eid,
        @oldVal, @newVal, @ip, @ua, NEWID(), SYSUTCDATETIME()
      )
    `);

    const id = String(result.recordset[0]?.AuditLogId);
    return {
      id,
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
  }

  // Settings
  async getInstituteSettings(): Promise<InstituteSettingsRecord> {
    const pool = await this.getPool();
    const result = await pool.request().query<{ SettingKey: string; SettingValue: string }>(`
      SELECT SettingKey, SettingValue FROM dbo.NXA_InstituteSettings
    `);

    const map = new Map<string, string>();
    for (const r of result.recordset) {
      map.set(r.SettingKey, r.SettingValue);
    }

    return {
      instituteName: map.get("instituteName") ?? "Nexelvoria Academy",
      tagline: map.get("tagline") ?? "Empowering Next-Gen Tech Leaders",
      supportEmail: map.get("supportEmail") ?? "contact@nexelvoria.in",
      supportPhone: map.get("supportPhone") ?? "+91 80000 12345",
      whatsappNumber: map.get("whatsappNumber") ?? "+91 80000 12345",
      address: map.get("address") ?? "Hitec City, Hyderabad, Telangana - 500081",
      timezone: map.get("timezone") ?? "Asia/Kolkata",
      minAttendancePercentage: Number(map.get("minAttendancePercentage") ?? 75),
      isSmsEnabled: map.get("isSmsEnabled") === "true",
      currencySymbol: map.get("currencySymbol") ?? "₹",
      gstNumber: map.get("gstNumber") ?? "36AAAAA0000A1Z5",
    };
  }

  async saveInstituteSettings(
    settings: Partial<InstituteSettingsRecord>,
    updatedByUserId?: EntityId,
  ): Promise<InstituteSettingsRecord> {
    const pool = await this.getPool();

    for (const [k, v] of Object.entries(settings)) {
      if (v !== undefined) {
        const req = pool.request();
        req.input("key", sql.VarChar(150), k);
        req.input("val", sql.NVarChar(sql.MAX), String(v));
        req.input("userId", sql.BigInt, updatedByUserId ?? 1);

        await req.query(`
          MERGE dbo.NXA_InstituteSettings AS target
          USING (SELECT @key AS SettingKey) AS source
          ON (target.SettingKey = source.SettingKey)
          WHEN MATCHED THEN
            UPDATE SET SettingValue = @val, UpdatedByUserId = @userId, UpdatedAt = SYSUTCDATETIME()
          WHEN NOT MATCHED THEN
            INSERT (SettingKey, SettingValue, ValueType, IsSecret, UpdatedByUserId, UpdatedAt)
            VALUES (@key, @val, 'string', 0, @userId, SYSUTCDATETIME());
        `);
      }
    }

    return this.getInstituteSettings();
  }

  async getSystemConfig(): Promise<SystemConfigRecord> {
    return {
      institute: {
        name: "Nexelvoria Academy",
        code: "NXA",
        affiliation: "State Technical Board & Global Cloud Consortium",
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
  }

  async saveSystemConfig(
    _config: Partial<SystemConfigRecord>,
    _updatedByUserId?: EntityId,
  ): Promise<SystemConfigRecord> {
    return this.getSystemConfig();
  }

  // Refunds
  async findRefunds(status?: string | undefined): Promise<RefundRecord[]> {
    const pool = await this.getPool();
    const req = pool.request();
    const conditions: string[] = ["1=1"];

    if (status) {
      req.input("status", sql.VarChar(20), status.toUpperCase());
      conditions.push("UPPER(r.RefundStatus) = @status");
    }

    const result = await req.query<{
      RefundId: number | bigint;
      RefundReference: string;
      TransactionId: number | bigint | null;
      RequestedByUserId: number | bigint;
      Amount: number;
      Reason: string;
      RefundStatus: string;
      GatewayRefundId: string | null;
      RequestedAt: Date;
      ApprovedAt: Date | null;
      ApprovedBySuperAdminUserId: number | bigint | null;
      CompletedAt: Date | null;
    }>(`
      SELECT *
      FROM dbo.NXA_Refunds r
      WHERE ${conditions.join(" AND ")}
      ORDER BY r.RequestedAt DESC
    `);

    return result.recordset.map((r) => ({
      id: String(r.RefundId),
      refundReference: r.RefundReference,
      ...(r.TransactionId ? { transactionId: String(r.TransactionId) } : {}),
      requestedByUserId: String(r.RequestedByUserId),
      amount: Number(r.Amount),
      reason: r.Reason,
      refundStatus: r.RefundStatus.toLowerCase(),
      ...(r.GatewayRefundId ? { gatewayRefundId: r.GatewayRefundId } : {}),
      requestedAt: r.RequestedAt.toISOString(),
      ...(r.ApprovedAt ? { approvedAt: r.ApprovedAt.toISOString() } : {}),
      ...(r.ApprovedBySuperAdminUserId ? { approvedBySuperAdminUserId: String(r.ApprovedBySuperAdminUserId) } : {}),
      ...(r.CompletedAt ? { completedAt: r.CompletedAt.toISOString() } : {}),
    }));
  }

  async updateRefundStatus(
    id: EntityId,
    status: string,
    decidedByUserId: EntityId,
    _remarks?: string | undefined,
  ): Promise<RefundRecord> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("id", sql.BigInt, id);
    req.input("status", sql.VarChar(20), status.toUpperCase());
    req.input("deciderId", sql.BigInt, decidedByUserId);

    const result = await req.query(`
      UPDATE dbo.NXA_Refunds
      SET RefundStatus = @status,
          ApprovedAt = SYSUTCDATETIME(),
          ApprovedBySuperAdminUserId = @deciderId
      WHERE RefundId = @id
    `);

    if ((result.rowsAffected[0] ?? 0) === 0) {
      throw new RecordNotFoundError("refund", id);
    }

    const all = await this.findRefunds();
    const updated = all.find((r) => r.id === id);
    if (!updated) throw new RecordNotFoundError("refund", id);
    return updated;
  }

  // Financial Overrides
  async findFinancialOverrides(status?: string | undefined): Promise<FinancialOverrideRecord[]> {
    const pool = await this.getPool();
    const req = pool.request();
    const conditions: string[] = ["1=1"];

    if (status) {
      req.input("status", sql.VarChar(30), status);
      conditions.push("fo.OverrideType = @status");
    }

    const result = await req.query<{
      EnrollmentOverrideId: number | bigint;
      EnrollmentId: number | bigint;
      OverrideType: string;
      Reason: string;
      ApprovedByUserId: number | bigint | null;
      CreatedAt: Date;
    }>(`
      SELECT *
      FROM dbo.NXA_EnrollmentOverrides fo
      WHERE ${conditions.join(" AND ")}
      ORDER BY fo.CreatedAt DESC
    `);

    return result.recordset.map((r) => ({
      id: String(r.EnrollmentOverrideId),
      studentId: "1",
      courseId: "1",
      enrollmentId: String(r.EnrollmentId),
      originalAmountINR: 45000,
      proposedAmountINR: 30000,
      discountOrWaiverINR: 15000,
      adjustmentType: r.OverrideType,
      reason: r.Reason,
      requestedByAdminId: "1",
      requestedAt: r.CreatedAt.toISOString(),
      status: r.ApprovedByUserId ? "approved" : "pending",
      ...(r.ApprovedByUserId ? { decidedBySuperAdminId: String(r.ApprovedByUserId) } : {}),
      ...(r.ApprovedByUserId ? { decidedAt: r.CreatedAt.toISOString() } : {}),
    }));
  }

  async updateFinancialOverride(
    id: EntityId,
    status: "approved" | "rejected",
    decidedByUserId: EntityId,
    remarks?: string | undefined,
  ): Promise<FinancialOverrideRecord> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("id", sql.BigInt, id);
    req.input("deciderId", sql.BigInt, decidedByUserId);

    await req.query(`
      UPDATE dbo.NXA_EnrollmentOverrides
      SET ApprovedByUserId = @deciderId
      WHERE EnrollmentOverrideId = @id
    `);

    return {
      id,
      studentId: "1",
      courseId: "1",
      enrollmentId: "1",
      originalAmountINR: 45000,
      proposedAmountINR: 30000,
      discountOrWaiverINR: 15000,
      adjustmentType: "merit_scholarship",
      reason: "Merit waiver",
      requestedByAdminId: "1",
      requestedAt: new Date().toISOString(),
      status,
      decidedAt: new Date().toISOString(),
      decidedBySuperAdminId: decidedByUserId,
      ...(remarks ? { superAdminRemarks: remarks } : {}),
    };
  }

  // Global Roles
  async findRoles(): Promise<GlobalRoleRecord[]> {
    const pool = await this.getPool();
    const result = await pool.request().query<{
      RoleId: number;
      RoleCode: string;
      RoleName: string;
      Description: string | null;
      IsSystemRole: boolean;
      IsActive: boolean;
      CreatedAt: Date;
    }>(`
      SELECT RoleId, RoleCode, RoleName, Description, IsSystemRole, IsActive, CreatedAt
      FROM dbo.NXA_Roles
      ORDER BY RoleId ASC
    `);

    return result.recordset.map((r) => ({
      id: String(r.RoleId),
      roleCode: r.RoleCode,
      roleName: r.RoleName,
      description: r.Description ?? "",
      isSystemRole: Boolean(r.IsSystemRole),
      isActive: Boolean(r.IsActive),
      permissions: ["view_dashboard", "manage_students"],
      createdAt: r.CreatedAt.toISOString(),
    }));
  }

  async createRole(role: {
    roleCode: string;
    roleName: string;
    description: string;
    permissions: string[];
  }): Promise<GlobalRoleRecord> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("code", sql.VarChar(40), role.roleCode);
    req.input("name", sql.NVarChar(100), role.roleName);
    req.input("desc", sql.NVarChar(500), role.description);

    const result = await req.query<{ RoleId: number }>(`
      INSERT INTO dbo.NXA_Roles (RoleCode, RoleName, Description, IsSystemRole, IsActive, CreatedAt)
      OUTPUT inserted.RoleId
      VALUES (@code, @name, @desc, 0, 1, SYSUTCDATETIME())
    `);

    const id = String(result.recordset[0]?.RoleId);
    return {
      id,
      roleCode: role.roleCode,
      roleName: role.roleName,
      description: role.description,
      isSystemRole: false,
      isActive: true,
      permissions: role.permissions,
      createdAt: new Date().toISOString(),
    };
  }

  async updateRolePermissions(roleId: EntityId, permissions: string[]): Promise<GlobalRoleRecord> {
    const roles = await this.findRoles();
    const found = roles.find((r) => r.id === roleId);
    if (!found) throw new RecordNotFoundError("role", roleId);

    found.permissions = permissions;
    return found;
  }

  async unlockUserAccount(userId: EntityId): Promise<void> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("userId", sql.BigInt, userId);

    await req.query(`
      UPDATE dbo.NXA_Users
      SET AccountStatus = 'ACTIVE', UpdatedAt = SYSUTCDATETIME()
      WHERE UserId = @userId
    `);
  }

  async findTeachers(filter?: { search?: string | undefined; status?: string | undefined }): Promise<Teacher[]> {
    const pool = await this.getPool();
    const req = pool.request();
    const conditions: string[] = ["u.Role = 'teacher'"];

    if (filter?.status) {
      req.input("status", sql.VarChar(20), filter.status.toUpperCase());
      conditions.push("UPPER(u.AccountStatus) = @status");
    }
    if (filter?.search && filter.search.trim() !== "") {
      req.input("search", sql.NVarChar(150), `%${filter.search.trim()}%`);
      conditions.push("(u.FullName LIKE @search OR u.Email LIKE @search)");
    }

    const result = await req.query<{
      UserId: number | bigint;
      FullName: string;
      Email: string;
      MobileNumber: string;
      Role: string;
      AccountStatus: string;
      CreatedAt: Date;
      Specialization: string | null;
      ExperienceYears: number | null;
      Qualification: string | null;
      Bio: string | null;
    }>(`
      SELECT 
        u.UserId,
        u.FullName,
        u.Email,
        u.MobileNumber,
        u.Role,
        u.AccountStatus,
        u.CreatedAt,
        tp.Specialization,
        tp.ExperienceYears,
        tp.Qualification,
        tp.Bio
      FROM dbo.NXA_Users u
      LEFT JOIN dbo.NXA_TeacherProfiles tp ON tp.UserId = u.UserId
      WHERE ${conditions.join(" AND ")}
      ORDER BY u.CreatedAt DESC
    `);

    return result.recordset.map((r) => ({
      id: String(r.UserId),
      name: r.FullName,
      email: r.Email,
      mobile: r.MobileNumber,
      role: "teacher",
      status: (r.AccountStatus.toLowerCase() as UserStatus) ?? "active",
      createdAt: r.CreatedAt.toISOString(),
      specialization: r.Specialization ?? "General",
      experienceYears: Number(r.ExperienceYears ?? 0),
      bio: r.Bio ?? "",
      qualifications: r.Qualification ?? "",
      assignedCourseIds: [],
      assignedBatchIds: [],
      rating: 4.8,
    }));
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
    const pool = await this.getPool();
    const tx = pool.transaction();
    await tx.begin();

    try {
      const uReq = tx.request();
      uReq.input("name", sql.NVarChar(150), input.name);
      uReq.input("email", sql.NVarChar(255), input.email.toLowerCase());
      uReq.input("mobile", sql.VarChar(20), input.mobile);
      uReq.input("role", sql.VarChar(20), "teacher");
      uReq.input("status", sql.VarChar(20), "ACTIVE");

      const uRes = await uReq.query<{ UserId: number | bigint }>(`
        INSERT INTO dbo.NXA_Users (FullName, Email, MobileNumber, Role, AccountStatus, CreatedAt, UpdatedAt)
        OUTPUT inserted.UserId
        VALUES (@name, @email, @mobile, @role, @status, SYSUTCDATETIME(), SYSUTCDATETIME())
      `);

      const userId = uRes.recordset[0]!.UserId;
      const empCode = `TCH-${userId}`;

      const tpReq = tx.request();
      tpReq.input("userId", sql.BigInt, userId);
      tpReq.input("empCode", sql.VarChar(40), empCode);
      tpReq.input("spec", sql.NVarChar(200), input.specialization ?? "General");
      tpReq.input("exp", sql.Decimal(4, 1), input.experienceYears ?? 0);
      tpReq.input("qual", sql.NVarChar(200), input.qualifications ?? "");
      tpReq.input("bio", sql.NVarChar(sql.MAX), input.bio ?? "");

      await tpReq.query(`
        INSERT INTO dbo.NXA_TeacherProfiles (
          UserId, EmployeeCode, Specialization, ExperienceYears, Qualification, Bio, IsActive, CreatedAt
        )
        VALUES (@userId, @empCode, @spec, @exp, @qual, @bio, 1, SYSUTCDATETIME())
      `);

      await tx.commit();

      return {
        id: String(userId),
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
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }
}
