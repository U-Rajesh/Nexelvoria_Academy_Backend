import sql from "mssql";

import type { EntityId } from "../../contracts/identifier.contract";
import type { UserRole, UserStatus } from "../../contracts/user.contract";
import { getSqlServerPool } from "../../db/sqlserver.pool";
import { RecordNotFoundError } from "../../repositories/repository.errors";
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
import type { AdminRepository, StaffAudit } from "./admin.repository";
import type { Student } from "../students/student.types";
import type { Teacher } from "../teachers/teacher.types";
import { randomBytes } from "node:crypto";

import { DuplicateRecordError } from "../../repositories/repository.errors";
import { logger } from "../../utils/logger";
import { checkCouponUsable, couponDiscountAmount } from "../payments/coupon-rules";
import { writeEnrollmentStatusHistory, writeFinancialAuditHistory } from "../../db/history-writers";
import {
  AdminRuleViolationError,
  FREE_ACCESS_OVERRIDE_TYPE,
  type EnrollmentStatusValue,
  type TransactionalAudit,
} from "./admin.repository";
import type { BatchStatusValue } from "./admin.validation";
import { financialYearLabel, financialYearStart, istMonthStart } from "./reporting-period";

export interface AuditLogInput {
  actorUserId: EntityId;
  actionType: string;
  moduleCode: string;
  entityName: string;
  entityId: string;
  oldValues?: string | undefined;
  newValues?: string | undefined;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
  details?: string | undefined;
}

/**
 * Inserts one NXA_AuditLogs row using the given request, so callers can write
 * the audit record inside the same transaction as the change it records
 * (BR-007 / BR-017: overrides must have audit records). NXA_AuditLogs has no
 * free-text column, so `details` is preserved in NewValues when no structured
 * new values are supplied.
 */
export const writeAuditLog = async (req: sql.Request, log: AuditLogInput): Promise<string> => {
  const newValues = log.newValues ?? (log.details ? JSON.stringify({ note: log.details }) : null);
  req.input("actorId", sql.BigInt, log.actorUserId);
  req.input("action", sql.VarChar(80), log.actionType);
  req.input("module", sql.VarChar(50), log.moduleCode);
  req.input("ename", sql.VarChar(150), log.entityName);
  req.input("eid", sql.VarChar(100), log.entityId);
  req.input("oldVal", sql.NVarChar(sql.MAX), log.oldValues ?? null);
  req.input("newVal", sql.NVarChar(sql.MAX), newValues);
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
  return String(result.recordset[0]?.AuditLogId);
};

/**
 * Keys in this schema are BIGINT. A non-numeric id can never match a row, so
 * it is reported as not-found instead of failing with a conversion error.
 */
const requireNumericIds = (ids: Record<string, string | undefined>): void => {
  for (const [entity, id] of Object.entries(ids)) {
    if (id !== undefined && !/^[0-9]+$/.test(id)) throw new RecordNotFoundError(entity, id);
  }
};

/** Maps stored key/value rows to settings; unset keys stay absent. */
const toInstituteSettings = (map: Map<string, string>): InstituteSettingsRecord => {
  const text = (k: string): string | undefined => {
    const v = map.get(k)?.trim();
    return v ? v : undefined;
  };
  const attendance = text("minAttendancePercentage");
  const sms = text("isSmsEnabled");
  const maintenance = text("maintenanceMode");
  const numberOf = (k: string): number | undefined => {
    const v = text(k);
    return v !== undefined && Number.isFinite(Number(v)) ? Number(v) : undefined;
  };
  const flag = (k: string): boolean | undefined => {
    const v = text(k);
    return v === undefined ? undefined : v === "true";
  };
  return {
    instituteName: text("instituteName"),
    tagline: text("tagline"),
    supportEmail: text("supportEmail"),
    supportPhone: text("supportPhone"),
    whatsappNumber: text("whatsappNumber"),
    address: text("address"),
    timezone: text("timezone") ?? "Asia/Kolkata",
    minAttendancePercentage: attendance !== undefined && Number.isFinite(Number(attendance)) ? Number(attendance) : undefined,
    minExamPercentage: numberOf("minExamPercentage"),
    defaultLessonSequentialUnlock: flag("defaultLessonSequentialUnlock"),
    defaultLessonDownloadAllowed: flag("defaultLessonDownloadAllowed"),
    maxFailedLoginAttempts: numberOf("maxFailedLoginAttempts"),
    isSmsEnabled: sms === undefined ? undefined : sms === "true",
    currencySymbol: text("currencySymbol"),
    gstNumber: text("gstNumber"),
    maintenanceMode: maintenance === undefined ? undefined : maintenance === "true",
    maintenanceMessage: text("maintenanceMessage"),
  };
};

/**
 * Writes a staff action's audit row on the caller's transaction, so the change
 * and its audit commit or roll back together (SEC audit logs). Existing
 * conventions are kept: action / module / entity names and the `details` note.
 */
const writeStaffAudit = async (tx: sql.Transaction, audit: StaffAudit | undefined, entityId: string): Promise<void> => {
  if (!audit) return;
  await writeAuditLog(tx.request(), {
    actorUserId: audit.actorUserId,
    actionType: audit.actionType,
    moduleCode: audit.moduleCode,
    entityName: audit.entityName,
    entityId,
    details: audit.details,
  });
};

/** SQL Server unique constraint / unique index violation (2627 / 2601). */
const isUniqueViolation = (err: unknown): boolean => {
  const n = (err as { number?: number; originalError?: { number?: number; info?: { number?: number } } }) ?? {};
  const code = n.number ?? n.originalError?.number ?? n.originalError?.info?.number;
  return code === 2627 || code === 2601;
};

/**
 * Roles live in NXA_UserRoles -> NXA_Roles.RoleCode; NXA_Users has no Role
 * column. These fragments mirror the resolution used by login
 * (sqlserver-user.repository.ts): a user with no role row is a student, and
 * both `super_admin` and `superadmin` codes denote the super admin.
 */
const roleCodeOf = (userAlias: string): string => `COALESCE((
  SELECT TOP 1 LOWER(r.RoleCode)
  FROM dbo.NXA_UserRoles ur
  JOIN dbo.NXA_Roles r ON r.RoleId = ur.RoleId
  WHERE ur.UserId = ${userAlias}.UserId
  ORDER BY ur.AssignedAt DESC
), 'student')`;

const hasRole = (userAlias: string, codes: readonly string[]): string => `EXISTS (
  SELECT 1
  FROM dbo.NXA_UserRoles ur
  JOIN dbo.NXA_Roles r ON r.RoleId = ur.RoleId
  WHERE ur.UserId = ${userAlias}.UserId
    AND LOWER(r.RoleCode) IN (${codes.map((c) => `'${c}'`).join(", ")})
)`;

const ADMIN_ROLE_CODES = ["admin", "super_admin", "superadmin"] as const;
const TEACHER_ROLE_CODES = ["teacher"] as const;

/** Same normalisation as student registration: country code + local number. */
const DEFAULT_COUNTRY_CODE = "+91";

const toAdminRole = (code: string | null | undefined): UserRole => {
  const c = (code ?? "").toLowerCase();
  return c === "super_admin" || c === "superadmin" ? "super_admin" : "admin";
};

const toUserStatus = (raw: string | null | undefined): UserStatus => {
  const s = (raw ?? "").toLowerCase();
  return s === "active" || s === "suspended" || s === "deactivated" ? s : "pending";
};

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

  /**
   * Runs one KPI query against a table whose live schema is not yet verified.
   * A failure yields `null` ("not available") and is logged - it never takes
   * the whole dashboard down and never substitutes an invented number.
   */
  private async optionalMetric(
    label: string,
    run: (pool: sql.ConnectionPool) => Promise<number | null>,
  ): Promise<number | null> {
    try {
      return await run(await this.getPool());
    } catch (err) {
      logger.warn("dashboard metric unavailable", { metric: label, err });
      return null;
    }
  }

  private countMetric(label: string, query: string): Promise<number | null> {
    return this.optionalMetric(label, async (pool) => {
      const r = await pool.request().query<{ cnt: number }>(query);
      return Number(r.recordset[0]?.cnt ?? 0);
    });
  }

  /**
   * Collected revenue: successful gateway transactions plus manually verified
   * payments, optionally from `since`. Refunds are reported separately
   * (REP-008), not netted here.
   */
  private revenueMetric(label: string, since?: Date): Promise<number | null> {
    return this.optionalMetric(label, async (pool) => {
      const req = pool.request();
      let tFilter = "";
      let mFilter = "";
      if (since) {
        req.input("since", sql.DateTime2, since);
        tFilter = "AND t.CreatedAt >= @since";
        mFilter = "AND m.CreatedAt >= @since";
      }
      const r = await req.query<{ total: number | null }>(`
        SELECT
          ISNULL((SELECT SUM(t.Amount) FROM dbo.NXA_Transactions t
                  WHERE LOWER(t.TransactionStatus) = 'successful' ${tFilter}), 0)
          +
          ISNULL((SELECT SUM(m.Amount) FROM dbo.NXA_ManualPaymentRecords m
                  WHERE LOWER(m.VerificationStatus) = 'verified' ${mFilter}), 0) AS total
      `);
      return Math.round(Number(r.recordset[0]?.total ?? 0));
    });
  }

  async getDashboardStats(): Promise<DashboardStats> {
    const pool = await this.getPool();

    const [uCounts, cCount, bCount, eStats] = await Promise.all([
      pool.request().query<{ role: string; status: string; approval: string | null; cnt: number }>(`
        SELECT x.role, x.status, x.approval, COUNT(1) AS cnt
        FROM (
          SELECT
            ${roleCodeOf("u")} AS role,
            LOWER(u.AccountStatus) AS status,
            LOWER(sp.ApprovalStatus) AS approval
          FROM dbo.NXA_Users u
          LEFT JOIN dbo.NXA_StudentProfiles sp ON sp.UserId = u.UserId
          WHERE u.DeletedAt IS NULL
        ) x
        GROUP BY x.role, x.status, x.approval
      `),
      pool.request().query<{ cnt: number }>(`
        SELECT COUNT(1) AS cnt FROM dbo.NXA_Courses WHERE DeletedAt IS NULL
      `),
      pool.request().query<{ cnt: number }>(`
        SELECT COUNT(1) AS cnt FROM dbo.NXA_Batches WHERE LOWER(Status) IN ('upcoming', 'ongoing')
      `),
      pool.request().query<{ total: number; pendingFees: number | null }>(`
        SELECT
          COUNT(1) AS total,
          SUM(CASE WHEN UPPER(EnrollmentStatus) = 'APPROVED_UNPAID' THEN FinalAmount ELSE 0 END) AS pendingFees
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
        // CL-001 decision 2: approval (not a separate activation) gives a
        // student full access, so "active" means approved and not blocked.
        if (r.approval === "approved" && (status === "active" || status === "pending")) activeStudents += Number(r.cnt);
        // Approval is a student-profile fact, not an account status.
        if ((r.approval ?? "pending") === "pending") pendingApprovals += Number(r.cnt);
      } else if (role === "teacher") {
        totalTeachers += Number(r.cnt);
      }
    }

    const now = new Date();
    const [totalRevenueINR, revenueFinancialYearINR, certificatesIssued, activePlacements, placementsCount, supportTicketsCount] =
      await Promise.all([
        this.revenueMetric("totalRevenueINR"),
        this.revenueMetric("revenueFinancialYearINR", financialYearStart(now)),
        this.countMetric(
          "certificatesIssued",
          `SELECT COUNT(1) AS cnt FROM dbo.NXA_Certificates WHERE LOWER(CertificateStatus) <> 'revoked'`,
        ),
        this.countMetric("activePlacements", `SELECT COUNT(1) AS cnt FROM dbo.NXA_Jobs WHERE LOWER(JobStatus) = 'open'`),
        this.countMetric("placementsCount", `SELECT COUNT(1) AS cnt FROM dbo.NXA_PlacementRecords`),
        this.countMetric(
          "supportTicketsCount",
          `SELECT COUNT(1) AS cnt FROM dbo.NXA_SupportTickets WHERE LOWER(TicketStatus) IN ('open', 'in_progress')`,
        ),
      ]);

    return {
      totalStudents,
      activeStudents,
      pendingApprovals,
      totalCourses: Number(cCount.recordset[0]?.cnt ?? 0),
      activeBatches: Number(bCount.recordset[0]?.cnt ?? 0),
      totalTeachers,
      totalRevenueINR,
      revenueFinancialYearINR,
      financialYearLabel: financialYearLabel(now),
      // Fees awaiting payment on approved enrollments (APPROVED_UNPAID).
      pendingFeesINR: Math.round(Number(eStats.recordset[0]?.pendingFees ?? 0)),
      certificatesIssued,
      // No approved placement-rate formula exists in the SRS; not computed.
      placementRate: null,
      activePlacements,
      supportTicketsCount,
      // No system-alert source exists.
      systemAlertsCount: null,
      totalEnrollments: Number(eStats.recordset[0]?.total ?? 0),
      placementsCount,
    };
  }

  async getPlacementCohort(range: { fromUtc: Date; toUtc: Date }): Promise<{ completedStudents: number; placedStudents: number }> {
    const pool = await this.getPool();
    const r = await pool
      .request()
      .input("fromUtc", sql.DateTime2, range.fromUtc)
      .input("toUtc", sql.DateTime2, range.toUtc)
      .query<{ completedStudents: number; placedStudents: number }>(`
        WITH cohort AS (
          SELECT DISTINCT e.StudentUserId
          FROM dbo.NXA_Enrollments e
          WHERE UPPER(e.EnrollmentStatus) = 'COMPLETED' AND e.CompletedAt >= @fromUtc AND e.CompletedAt < @toUtc
        ),
        placed AS (
          SELECT DISTINCT p.StudentUserId FROM dbo.NXA_PlacementRecords p
        )
        SELECT
          (SELECT COUNT(1) FROM cohort) AS completedStudents,
          (SELECT COUNT(1) FROM cohort c JOIN placed p ON p.StudentUserId = c.StudentUserId) AS placedStudents
      `);
    const row = r.recordset[0];
    return { completedStudents: Number(row?.completedStudents ?? 0), placedStudents: Number(row?.placedStudents ?? 0) };
  }

  async getSuperAdminDashboardStats(): Promise<SuperAdminDashboardStats> {
    const pool = await this.getPool();

    const [uCounts, batches] = await Promise.all([
      pool.request().query<{ role: string; cnt: number }>(`
        SELECT x.role, COUNT(1) AS cnt
        FROM (
          SELECT
            ${roleCodeOf("u")} AS role,
            LOWER(u.AccountStatus) AS status,
            CASE WHEN EXISTS (
              SELECT 1 FROM dbo.NXA_StudentProfiles sp
              WHERE sp.UserId = u.UserId AND LOWER(sp.ApprovalStatus) = 'approved'
            ) THEN 1 ELSE 0 END AS approved
          FROM dbo.NXA_Users u
          WHERE u.DeletedAt IS NULL
        ) x
        -- Staff count when active; students when approved and not suspended or
        -- deactivated (CL-001 decision 2: approval replaces activation).
        WHERE (x.role = 'student' AND x.status IN ('active', 'pending') AND x.approved = 1)
           OR (x.role <> 'student' AND x.status = 'active')
        GROUP BY x.role
      `),
      pool.request().query<{ cnt: number }>(`
        SELECT COUNT(1) AS cnt FROM dbo.NXA_Batches WHERE LOWER(Status) = 'ongoing'
      `),
    ]);

    let totalActiveStudents = 0;
    let totalFacultyMembers = 0;
    let totalAdminAccounts = 0;

    for (const r of uCounts.recordset) {
      const role = (r.role ?? "").toLowerCase();
      if (role === "student") totalActiveStudents += Number(r.cnt);
      else if (role === "teacher") totalFacultyMembers += Number(r.cnt);
      else if (role === "admin" || role === "super_admin" || role === "superadmin") totalAdminAccounts += Number(r.cnt);
    }

    // Period boundaries in IST; YTD uses the Indian financial year (1 April).
    const now = new Date();

    const [totalRevenueYTD, revenueThisMonth, pendingFinancialOverrides, pendingRefundRequests] = await Promise.all([
      this.revenueMetric("totalRevenueYTD", financialYearStart(now)),
      this.revenueMetric("revenueThisMonth", istMonthStart(now)),
      // NXA_EnrollmentOverrides.ApprovedByUserId is NOT NULL: an override is
      // authorized when it is recorded, so none can be pending.
      Promise.resolve(0),
      this.countMetric(
        "pendingRefundRequests",
        `SELECT COUNT(1) AS cnt FROM dbo.NXA_Refunds WHERE UPPER(RefundStatus) = 'PENDING'`,
      ),
    ]);

    return {
      totalRevenueYTD,
      financialYearLabel: financialYearLabel(now),
      revenueThisMonth,
      totalActiveStudents,
      totalFacultyMembers,
      totalAdminAccounts,
      pendingFinancialOverrides,
      pendingRefundRequests,
      activeCourseBatches: Number(batches.recordset[0]?.cnt ?? 0),
      // No monitoring, security-alert, sign-off or integrity source exists yet.
      systemHealthScore: null,
      criticalSecurityAlerts: null,
      certificatesAwaitingSignoff: null,
      dataIntegrityStatus: null,
    };
  }

  private mapAdminRow(r: {
    UserId: number | bigint;
    FullName: string;
    Email: string | null;
    MobileNumber: string | null;
    RoleCode: string | null;
    AccountStatus: string;
    CreatedAt: Date;
    EmployeeCode: string | null;
    AdminLevel: string | null;
  }): AdminProfile {
    return {
      id: String(r.UserId),
      userId: String(r.UserId),
      name: r.FullName,
      email: r.Email ?? "",
      mobile: r.MobileNumber ?? "",
      role: toAdminRole(r.RoleCode),
      status: toUserStatus(r.AccountStatus),
      department: r.AdminLevel ?? "",
      // Fine-grained permissions have no persisted model yet; never fabricate them.
      permissions: [],
      ...(r.EmployeeCode ? { employeeCode: r.EmployeeCode } : {}),
      ...(r.AdminLevel ? { adminLevel: r.AdminLevel } : {}),
      createdAt: r.CreatedAt.toISOString(),
    };
  }

  private adminSelect(where: string): string {
    return `
      SELECT
        u.UserId,
        u.FullName,
        u.Email,
        u.MobileNumber,
        ${roleCodeOf("u")} AS RoleCode,
        u.AccountStatus,
        u.CreatedAt,
        ap.EmployeeCode,
        ap.AdminLevel
      FROM dbo.NXA_Users u
      LEFT JOIN dbo.NXA_AdminProfiles ap ON ap.UserId = u.UserId
      WHERE u.DeletedAt IS NULL AND ${hasRole("u", ADMIN_ROLE_CODES)} AND ${where}
    `;
  }

  async findAdmins(filter?: { search?: string | undefined; status?: string | undefined }): Promise<AdminProfile[]> {
    const pool = await this.getPool();
    const req = pool.request();
    const conditions: string[] = ["1=1"];

    if (filter?.status) {
      req.input("status", sql.VarChar(20), filter.status.toLowerCase());
      conditions.push("LOWER(u.AccountStatus) = @status");
    }
    if (filter?.search && filter.search.trim() !== "") {
      req.input("search", sql.NVarChar(160), `%${filter.search.trim()}%`);
      conditions.push("(u.FullName LIKE @search OR u.Email LIKE @search)");
    }

    const result = await req.query(`${this.adminSelect(conditions.join(" AND "))} ORDER BY u.CreatedAt DESC`);
    return result.recordset.map((r) => this.mapAdminRow(r));
  }

  async findAdminById(id: EntityId): Promise<AdminProfile | null> {
    if (!/^[0-9]+$/.test(id)) return null;
    const pool = await this.getPool();
    const req = pool.request();
    req.input("userId", sql.BigInt, id);

    const result = await req.query(this.adminSelect("u.UserId = @userId"));
    const r = result.recordset[0];
    return r ? this.mapAdminRow(r) : null;
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
    const userId = await this.insertStaffUser({ ...input, roleCode: "admin" }, async (tx, newUserId) => {
      const apReq = tx.request();
      apReq.input("userId", sql.BigInt, newUserId);
      apReq.input("empCode", sql.VarChar(40), input.employeeCode ?? `ADM-${newUserId}`);
      apReq.input("level", sql.VarChar(20), (input.adminLevel ?? input.department ?? "General").slice(0, 20));
      await apReq.query(`
        INSERT INTO dbo.NXA_AdminProfiles (UserId, EmployeeCode, AdminLevel, IsActive, CreatedAt)
        VALUES (@userId, @empCode, @level, 1, SYSUTCDATETIME())
      `);
      await writeStaffAudit(tx, audit, newUserId);
    });

    const created = await this.findAdminById(userId);
    if (!created) throw new RecordNotFoundError("admin", userId);
    return created;
  }

  /**
   * Shared staff-account insert: duplicate check, NXA_Users row with a real
   * password hash, role assignment, then the caller's profile insert - one
   * transaction, rolled back on any failure. Fails loudly when the role code
   * is not seeded in NXA_Roles rather than creating a role-less account.
   */
  private async insertStaffUser(
    input: {
      name: string;
      email: string;
      mobile: string;
      passwordHash: string;
      assignedByUserId: EntityId;
      roleCode: string;
      /** Staff accounts start `active`; admin-created students start `pending` (BR-001). */
      accountStatus?: "active" | "pending";
    },
    insertProfile: (tx: sql.Transaction, userId: string) => Promise<void>,
  ): Promise<string> {
    const pool = await this.getPool();
    const tx = pool.transaction();
    await tx.begin();

    try {
      const email = input.email.trim();
      const normalizedEmail = email.toLowerCase();
      const mobile = input.mobile.trim();
      const normalizedMobile = `${DEFAULT_COUNTRY_CODE}${mobile}`;

      const dupReq = tx.request();
      dupReq.input("normalizedEmail", sql.NVarChar(254), normalizedEmail);
      dupReq.input("normalizedMobile", sql.VarChar(25), normalizedMobile);
      const dup = await dupReq.query<{ NormalizedEmail: string | null; NormalizedMobile: string | null }>(`
        SELECT TOP 1 NormalizedEmail, NormalizedMobile
        FROM dbo.NXA_Users WITH (UPDLOCK, HOLDLOCK)
        WHERE NormalizedEmail = @normalizedEmail OR NormalizedMobile = @normalizedMobile
      `);
      const found = dup.recordset[0];
      if (found) {
        if ((found.NormalizedEmail ?? "").toLowerCase() === normalizedEmail) {
          throw new DuplicateRecordError("user", "email", normalizedEmail);
        }
        throw new DuplicateRecordError("user", "mobile", mobile);
      }

      const roleReq = tx.request();
      roleReq.input("roleCode", sql.VarChar(40), input.roleCode);
      const role = await roleReq.query<{ RoleId: number }>(`
        SELECT TOP 1 RoleId FROM dbo.NXA_Roles WHERE LOWER(RoleCode) = LOWER(@roleCode) AND IsActive = 1
      `);
      const roleId = role.recordset[0]?.RoleId;
      if (roleId === undefined) {
        throw new Error(`Role '${input.roleCode}' is not seeded in dbo.NXA_Roles`);
      }

      const uReq = tx.request();
      uReq.input("fullName", sql.NVarChar(150), input.name.trim());
      uReq.input("email", sql.NVarChar(254), email);
      uReq.input("normalizedEmail", sql.NVarChar(254), normalizedEmail);
      uReq.input("countryCode", sql.VarChar(8), DEFAULT_COUNTRY_CODE);
      uReq.input("mobile", sql.VarChar(20), mobile);
      uReq.input("normalizedMobile", sql.VarChar(25), normalizedMobile);
      uReq.input("passwordHash", sql.NVarChar(500), input.passwordHash);
      uReq.input("accountStatus", sql.VarChar(20), input.accountStatus ?? "active");
      const uRes = await uReq.query<{ UserId: number | bigint }>(`
        INSERT INTO dbo.NXA_Users (
          FullName, Email, NormalizedEmail, CountryCode, MobileNumber, NormalizedMobile,
          PasswordHash, AccountStatus, EmailVerified, MobileVerified, TwoFactorEnabled,
          IsLocked, FailedLoginAttempts, CreatedAt
        )
        OUTPUT inserted.UserId
        VALUES (
          @fullName, @email, @normalizedEmail, @countryCode, @mobile, @normalizedMobile,
          @passwordHash, @accountStatus, 0, 0, 0, 0, 0, SYSUTCDATETIME()
        )
      `);
      const userId = String(uRes.recordset[0]!.UserId);

      const urReq = tx.request();
      urReq.input("userId", sql.BigInt, userId);
      urReq.input("roleId", sql.Int, roleId);
      urReq.input("assignedBy", sql.BigInt, input.assignedByUserId);
      await urReq.query(`
        INSERT INTO dbo.NXA_UserRoles (UserId, RoleId, AssignedAt, AssignedByUserId)
        VALUES (@userId, @roleId, SYSUTCDATETIME(), @assignedBy)
      `);

      await insertProfile(tx, userId);
      await tx.commit();
      return userId;
    } catch (err) {
      try {
        await tx.rollback();
      } catch {
        // Already rolled back by SQL Server (e.g. XACT_ABORT); the original error matters.
      }
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
    audit?: StaffAudit,
  ): Promise<AdminProfile> {
    const existing = await this.findAdminById(id);
    if (!existing) throw new RecordNotFoundError("admin", id);

    // A save that changes nothing writes nothing and is not audited.
    const nextName = (input.name ?? existing.name).trim();
    const nextMobile = (input.mobile ?? existing.mobile).trim();
    const nextLevel = (input.department ?? existing.department ?? "").slice(0, 20);
    if (nextName === existing.name && nextMobile === existing.mobile && nextLevel === (existing.department ?? "")) return existing;

    const pool = await this.getPool();
    const tx = pool.transaction();
    await tx.begin();
    try {
      const mobile = (input.mobile ?? existing.mobile).trim();
      if (input.mobile !== undefined && mobile !== existing.mobile) {
        const dupReq = tx.request();
        dupReq.input("userId", sql.BigInt, id);
        dupReq.input("normalizedMobile", sql.VarChar(25), `${DEFAULT_COUNTRY_CODE}${mobile}`);
        const dup = await dupReq.query(`
          SELECT TOP 1 1 AS x FROM dbo.NXA_Users WITH (UPDLOCK, HOLDLOCK)
          WHERE NormalizedMobile = @normalizedMobile AND UserId <> @userId
        `);
        if (dup.recordset.length > 0) throw new DuplicateRecordError("user", "mobile", mobile);
      }

      const req = tx.request();
      req.input("userId", sql.BigInt, id);
      req.input("name", sql.NVarChar(150), (input.name ?? existing.name).trim());
      req.input("mobile", sql.VarChar(20), mobile);
      req.input("normalizedMobile", sql.VarChar(25), `${DEFAULT_COUNTRY_CODE}${mobile}`);
      req.input("level", sql.VarChar(20), (input.department ?? existing.department ?? "").slice(0, 20) || null);
      await req.query(`
        UPDATE dbo.NXA_Users
        SET FullName = @name, MobileNumber = @mobile, NormalizedMobile = @normalizedMobile,
            UpdatedAt = SYSUTCDATETIME()
        WHERE UserId = @userId;

        UPDATE dbo.NXA_AdminProfiles
        SET AdminLevel = @level
        WHERE UserId = @userId;
      `);
      await writeStaffAudit(tx, audit, id);
      await tx.commit();
    } catch (err) {
      try {
        await tx.rollback();
      } catch {
        // see insertStaffUser
      }
      throw err;
    }

    const updated = await this.findAdminById(id);
    if (!updated) throw new RecordNotFoundError("admin", id);
    return updated;
  }

  async setAdminStatus(id: EntityId, status: UserStatus, audit?: StaffAudit): Promise<AdminProfile> {
    if (!/^[0-9]+$/.test(id)) throw new RecordNotFoundError("admin", id);
    await this.inTeacherTransaction(async (tx) => {
      const req = tx.request();
      req.input("userId", sql.BigInt, id);
      req.input("status", sql.VarChar(20), status.toLowerCase());
      // Only a real change updates a row; an account already in that status is
      // left untouched and not audited.
      const result = await req.query(`
        UPDATE u SET AccountStatus = @status, UpdatedAt = SYSUTCDATETIME()
        FROM dbo.NXA_Users u
        WHERE u.UserId = @userId AND u.DeletedAt IS NULL AND ${hasRole("u", ADMIN_ROLE_CODES)}
          AND LOWER(ISNULL(u.AccountStatus, '')) <> @status;

        IF @@ROWCOUNT > 0
          UPDATE dbo.NXA_AdminProfiles
          SET IsActive = CASE WHEN @status = 'active' THEN 1 ELSE 0 END
          WHERE UserId = @userId;
      `);
      if ((result.rowsAffected[0] ?? 0) === 0) return;
      await writeStaffAudit(tx, audit, id);
    });

    const updated = await this.findAdminById(id);
    if (!updated) throw new RecordNotFoundError("admin", id);
    return updated;
  }

  async setAdminPassword(id: EntityId, passwordHash: string, audit?: StaffAudit): Promise<void> {
    if (!/^[0-9]+$/.test(id)) throw new RecordNotFoundError("admin", id);
    await this.inTeacherTransaction(async (tx) => {
      const req = tx.request();
      req.input("userId", sql.BigInt, id);
      req.input("passwordHash", sql.NVarChar(500), passwordHash);

      const result = await req.query(`
        UPDATE u
        SET PasswordHash = @passwordHash,
            FailedLoginAttempts = 0,
            IsLocked = 0,
            LockoutUntil = NULL,
            UpdatedAt = SYSUTCDATETIME()
        FROM dbo.NXA_Users u
        WHERE u.UserId = @userId AND u.DeletedAt IS NULL AND ${hasRole("u", ["admin"])}
      `);

      if ((result.rowsAffected[0] ?? 0) === 0) {
        throw new RecordNotFoundError("admin", id);
      }
      // The new password / hash never goes into the audit row (details is a fixed note).
      await writeStaffAudit(tx, audit, id);
    });
  }

  // Batches
  private batchSelect(where: string): string {
    return `
      SELECT
        b.BatchId,
        b.CourseId,
        c.CourseName,
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
        (
          SELECT COUNT(1) FROM dbo.NXA_Enrollments e
          WHERE e.BatchId = b.BatchId AND UPPER(e.EnrollmentStatus) <> 'CANCELLED'
        ) AS CurrentEnrollments,
        (
          SELECT STRING_AGG(CAST(ta.TeacherUserId AS VARCHAR(30)), ',')
          FROM dbo.NXA_TeacherAllocations ta
          WHERE ta.BatchId = b.BatchId AND ta.IsActive = 1
        ) AS AllocatedTeacherIds,
        (
          SELECT STRING_AGG(tu.FullName, '||')
          FROM dbo.NXA_TeacherAllocations ta
          JOIN dbo.NXA_Users tu ON tu.UserId = ta.TeacherUserId
          WHERE ta.BatchId = b.BatchId AND ta.IsActive = 1
        ) AS AllocatedTeacherNames
      FROM dbo.NXA_Batches b
      LEFT JOIN dbo.NXA_Courses c ON c.CourseId = b.CourseId
      WHERE ${where}
    `;
  }

  private mapBatchRow(r: {
    BatchId: number | bigint;
    CourseId: number | bigint;
    CourseName: string | null;
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
    AllocatedTeacherIds: string | null;
    AllocatedTeacherNames: string | null;
  }): BatchRecord {
    return {
      id: String(r.BatchId),
      courseId: String(r.CourseId),
      ...(r.CourseName ? { courseName: r.CourseName } : {}),
      batchCode: r.BatchCode,
      batchName: r.BatchName,
      ...(r.StartDate ? { startDate: r.StartDate.toISOString().split("T")[0] } : {}),
      ...(r.EndDate ? { endDate: r.EndDate.toISOString().split("T")[0] } : {}),
      // NULL capacity means "not set" - never a fabricated default.
      ...(r.Capacity !== null && r.Capacity !== undefined ? { capacity: Number(r.Capacity) } : {}),
      ...(r.ScheduleDescription ? { scheduleDescription: r.ScheduleDescription } : {}),
      status: (r.Status ?? "").toLowerCase(),
      ...(r.TimeZoneId ? { timeZoneId: r.TimeZoneId } : {}),
      currentEnrollments: Number(r.CurrentEnrollments ?? 0),
      allocatedTeacherIds: r.AllocatedTeacherIds ? r.AllocatedTeacherIds.split(",") : [],
      allocatedTeacherNames: r.AllocatedTeacherNames ? r.AllocatedTeacherNames.split("||") : [],
      createdAt: r.CreatedAt.toISOString(),
      ...(r.UpdatedAt ? { updatedAt: r.UpdatedAt.toISOString() } : {}),
    };
  }

  async findBatches(filter?: { courseId?: string | undefined; status?: string | undefined }): Promise<BatchRecord[]> {
    const pool = await this.getPool();
    const req = pool.request();
    const conditions: string[] = ["1=1"];

    if (filter?.courseId) {
      if (!/^[0-9]+$/.test(filter.courseId)) return [];
      req.input("courseId", sql.BigInt, filter.courseId);
      conditions.push("b.CourseId = @courseId");
    }
    if (filter?.status) {
      req.input("status", sql.VarChar(20), filter.status.toLowerCase());
      conditions.push("LOWER(b.Status) = @status");
    }

    const result = await req.query(`${this.batchSelect(conditions.join(" AND "))} ORDER BY b.CreatedAt DESC`);
    return result.recordset.map((r) => this.mapBatchRow(r));
  }

  async findBatchById(id: EntityId): Promise<BatchRecord | null> {
    if (!/^[0-9]+$/.test(id)) return null;
    const pool = await this.getPool();
    const req = pool.request();
    req.input("batchId", sql.BigInt, id);
    const result = await req.query(this.batchSelect("b.BatchId = @batchId"));
    const r = result.recordset[0];
    return r ? this.mapBatchRow(r) : null;
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
    requireNumericIds({ course: input.courseId });
    const batchId = await this.inTeacherTransaction(async (tx) => {
      const courseReq = tx.request();
      courseReq.input("courseId", sql.BigInt, input.courseId);
      const course = await courseReq.query(`
        SELECT 1 AS x FROM dbo.NXA_Courses WHERE CourseId = @courseId AND DeletedAt IS NULL
      `);
      if (course.recordset.length === 0) throw new RecordNotFoundError("course", input.courseId);

      const req = tx.request();
      req.input("courseId", sql.BigInt, input.courseId);
      req.input("code", sql.VarChar(40), input.batchCode);
      req.input("name", sql.NVarChar(150), input.batchName);
      req.input("start", sql.Date, input.startDate ? new Date(input.startDate) : null);
      req.input("end", sql.Date, input.endDate ? new Date(input.endDate) : null);
      req.input("capacity", sql.Int, input.capacity ?? null);
      req.input("desc", sql.NVarChar(500), input.scheduleDescription ?? null);

      let newId: string;
      try {
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
        newId = String(result.recordset[0]?.BatchId);
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicateRecordError("batch", "batchCode", input.batchCode);
        throw err;
      }
      await writeStaffAudit(tx, audit, newId);
      return newId;
    });

    const created = await this.findBatchById(batchId);
    if (!created) throw new RecordNotFoundError("batch", batchId);
    return created;
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
    const existing = await this.findBatchById(id);
    if (!existing) throw new RecordNotFoundError("batch", id);

    const startDate = input.startDate ?? existing.startDate;
    const endDate = input.endDate ?? existing.endDate;
    if (startDate && endDate && endDate < startDate) {
      throw new AdminRuleViolationError("INVALID_DATE_RANGE", "End date cannot be before start date");
    }
    const next = {
      batchName: input.batchName ?? existing.batchName,
      startDate,
      endDate,
      capacity: input.capacity ?? existing.capacity,
      scheduleDescription: input.scheduleDescription ?? existing.scheduleDescription,
    };
    // A save that changes nothing writes nothing and is not audited.
    const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
    if (
      same(next.batchName, existing.batchName) &&
      same(next.startDate, existing.startDate) &&
      same(next.endDate, existing.endDate) &&
      same(next.capacity, existing.capacity) &&
      same(next.scheduleDescription, existing.scheduleDescription)
    ) {
      return existing;
    }

    await this.inTeacherTransaction(async (tx) => {
      const req = tx.request();
      req.input("batchId", sql.BigInt, id);
      req.input("name", sql.NVarChar(150), next.batchName);
      req.input("start", sql.Date, startDate ? new Date(startDate) : null);
      req.input("end", sql.Date, endDate ? new Date(endDate) : null);
      req.input("capacity", sql.Int, next.capacity ?? null);
      req.input("desc", sql.NVarChar(500), next.scheduleDescription ?? null);
      const result = await req.query(`
        UPDATE dbo.NXA_Batches
        SET BatchName = @name, StartDate = @start, EndDate = @end, Capacity = @capacity,
            ScheduleDescription = @desc, UpdatedAt = SYSUTCDATETIME()
        WHERE BatchId = @batchId
      `);
      if ((result.rowsAffected[0] ?? 0) === 0) throw new RecordNotFoundError("batch", id);
      await writeStaffAudit(tx, audit, id);
    });

    const updated = await this.findBatchById(id);
    if (!updated) throw new RecordNotFoundError("batch", id);
    return updated;
  }

  async setBatchStatus(id: EntityId, status: BatchStatusValue, audit?: StaffAudit): Promise<BatchRecord> {
    if (!/^[0-9]+$/.test(id)) throw new RecordNotFoundError("batch", id);
    await this.inTeacherTransaction(async (tx) => {
      const req = tx.request();
      req.input("batchId", sql.BigInt, id);
      req.input("status", sql.VarChar(20), status);
      // Only a real change updates a row; a batch already in that status is
      // left untouched and not audited.
      const result = await req.query(`
        UPDATE dbo.NXA_Batches
        SET Status = @status, UpdatedAt = SYSUTCDATETIME()
        WHERE BatchId = @batchId AND LOWER(ISNULL(Status, '')) <> LOWER(@status)
      `);
      if ((result.rowsAffected[0] ?? 0) === 0) return;
      await writeStaffAudit(tx, audit, id);
    });

    const updated = await this.findBatchById(id);
    if (!updated) throw new RecordNotFoundError("batch", id);
    return updated;
  }

  async allocateTeacher(input: {
    batchId: EntityId;
    courseId: EntityId;
    teacherUserId: EntityId;
    allocatedByUserId: EntityId;
  }, audit?: StaffAudit): Promise<void> {
    requireNumericIds({ batch: input.batchId, course: input.courseId });
    if (!/^[0-9]+$/.test(input.teacherUserId)) {
      throw new AdminRuleViolationError("NOT_A_TEACHER", "The selected user is not a teacher account");
    }
    const pool = await this.getPool();
    const tx = pool.transaction();
    await tx.begin();

    try {
      const batchReq = tx.request();
      batchReq.input("batchId", sql.BigInt, input.batchId);
      const batch = await batchReq.query<{ CourseId: number | bigint; Status: string }>(`
        SELECT CourseId, Status FROM dbo.NXA_Batches WITH (UPDLOCK) WHERE BatchId = @batchId
      `);
      const b = batch.recordset[0];
      if (!b) throw new RecordNotFoundError("batch", input.batchId);
      if (String(b.CourseId) !== String(input.courseId)) {
        throw new AdminRuleViolationError("BATCH_COURSE_MISMATCH", "The selected batch does not belong to the selected course");
      }
      if (["completed", "cancelled"].includes((b.Status ?? "").toLowerCase())) {
        throw new AdminRuleViolationError("BATCH_CLOSED", `Cannot allocate a teacher to a ${b.Status.toLowerCase()} batch`);
      }

      const tReq = tx.request();
      tReq.input("teacherId", sql.BigInt, input.teacherUserId);
      const teacher = await tReq.query<{ AccountStatus: string }>(`
        SELECT u.AccountStatus FROM dbo.NXA_Users u
        WHERE u.UserId = @teacherId AND u.DeletedAt IS NULL AND ${hasRole("u", TEACHER_ROLE_CODES)}
      `);
      const t = teacher.recordset[0];
      if (!t) throw new AdminRuleViolationError("NOT_A_TEACHER", "The selected user is not a teacher account");
      if ((t.AccountStatus ?? "").toLowerCase() !== "active") {
        throw new AdminRuleViolationError("TEACHER_INACTIVE", "Only active teacher accounts can be allocated");
      }

      const ins = tx.request();
      ins.input("batchId", sql.BigInt, input.batchId);
      ins.input("courseId", sql.BigInt, input.courseId);
      ins.input("teacherId", sql.BigInt, input.teacherUserId);
      const result = await ins.query(`
        IF EXISTS (
          SELECT 1 FROM dbo.NXA_TeacherAllocations WITH (UPDLOCK, HOLDLOCK)
          WHERE TeacherUserId = @teacherId AND BatchId = @batchId AND IsActive = 1
        )
          SELECT CAST(1 AS BIT) AS AlreadyAllocated
        ELSE
        BEGIN
          INSERT INTO dbo.NXA_TeacherAllocations (TeacherUserId, CourseId, BatchId, IsActive, AllocatedAt)
          VALUES (@teacherId, @courseId, @batchId, 1, SYSUTCDATETIME());
          SELECT CAST(0 AS BIT) AS AlreadyAllocated;
        END
      `);
      if (result.recordset[0]?.AlreadyAllocated) {
        throw new DuplicateRecordError("allocation", "teacherUserId", input.teacherUserId);
      }

      await writeStaffAudit(tx, audit, input.batchId);
      await tx.commit();
    } catch (err) {
      try {
        await tx.rollback();
      } catch {
        // see insertStaffUser
      }
      throw err;
    }
  }

  async unallocateTeacher(batchId: EntityId, teacherUserId: EntityId, audit?: StaffAudit): Promise<void> {
    if (!/^[0-9]+$/.test(batchId) || !/^[0-9]+$/.test(teacherUserId)) {
      throw new RecordNotFoundError("allocation", `${batchId}/${teacherUserId}`);
    }
    await this.inTeacherTransaction(async (tx) => {
      const req = tx.request();
      req.input("batchId", sql.BigInt, batchId);
      req.input("teacherId", sql.BigInt, teacherUserId);
      const result = await req.query(`
        UPDATE dbo.NXA_TeacherAllocations
        SET IsActive = 0
        WHERE BatchId = @batchId AND TeacherUserId = @teacherId AND IsActive = 1
      `);
      if ((result.rowsAffected[0] ?? 0) === 0) {
        throw new RecordNotFoundError("allocation", `${batchId}/${teacherUserId}`);
      }
      await writeStaffAudit(tx, audit, batchId);
    });
  }

  async findBatchStudents(batchId: EntityId): Promise<Student[]> {
    if (!/^[0-9]+$/.test(batchId)) return [];
    const pool = await this.getPool();
    const req = pool.request();
    req.input("batchId", sql.BigInt, batchId);

    // Columns per the live NXA_StudentProfiles schema (Degree, Branch,
    // InterestedCourseId, ApprovalStatus ...).
    const result = await req.query<{
      UserId: number | bigint;
      FullName: string;
      Email: string | null;
      MobileNumber: string | null;
      AccountStatus: string;
      EmailVerified: boolean;
      MobileVerified: boolean;
      CreatedAt: Date;
      CollegeName: string | null;
      Degree: string | null;
      Branch: string | null;
      PassingYear: number | null;
      InterestedCourseId: number | bigint | null;
      DateOfBirth: Date | null;
      Gender: string | null;
      AddressLine1: string | null;
      ApprovalStatus: string | null;
      EnrolledCourseIds: string | null;
    }>(`
      SELECT
        u.UserId, u.FullName, u.Email, u.MobileNumber, u.AccountStatus,
        u.EmailVerified, u.MobileVerified, u.CreatedAt,
        sp.CollegeName, sp.Degree, sp.Branch, sp.PassingYear, sp.InterestedCourseId,
        sp.DateOfBirth, sp.Gender, sp.AddressLine1, sp.ApprovalStatus,
        (
          SELECT STRING_AGG(CAST(e2.CourseId AS VARCHAR(30)), ',')
          FROM dbo.NXA_Enrollments e2
          WHERE e2.StudentUserId = u.UserId AND UPPER(e2.EnrollmentStatus) IN ('ACTIVE', 'COMPLETED')
        ) AS EnrolledCourseIds
      FROM dbo.NXA_Enrollments e
      INNER JOIN dbo.NXA_Users u ON u.UserId = e.StudentUserId
      LEFT JOIN dbo.NXA_StudentProfiles sp ON sp.UserId = u.UserId
      WHERE e.BatchId = @batchId AND UPPER(e.EnrollmentStatus) <> 'CANCELLED'
      ORDER BY u.FullName
    `);

    return result.recordset.map((r) => {
      const degree = r.Degree?.trim() ?? "";
      const branch = r.Branch?.trim() ?? "";
      const approval = (r.ApprovalStatus ?? "pending").toLowerCase();
      const gender = (r.Gender ?? "").toLowerCase();
      return {
        id: String(r.UserId),
        userId: String(r.UserId),
        name: r.FullName,
        email: r.Email ?? "",
        mobile: r.MobileNumber ?? "",
        role: "student" as const,
        status: toUserStatus(r.AccountStatus),
        collegeName: r.CollegeName ?? "",
        degreeBranch: degree && branch ? `${degree} - ${branch}` : degree || branch,
        passingYear: r.PassingYear !== null && r.PassingYear !== undefined ? String(r.PassingYear) : "",
        courseInterestedIn: r.InterestedCourseId !== null && r.InterestedCourseId !== undefined ? String(r.InterestedCourseId) : "",
        dateOfBirth: r.DateOfBirth ? r.DateOfBirth.toISOString().split("T")[0]! : "",
        gender: gender === "male" || gender === "female" ? gender : "other",
        fullAddress: r.AddressLine1 ?? "",
        isEmailVerified: Boolean(r.EmailVerified),
        isMobileVerified: Boolean(r.MobileVerified),
        adminApprovalStatus: approval === "approved" || approval === "rejected" ? approval : "pending",
        // Display only (ACTIVE + COMPLETED); never used for authorization.
        enrolledCourseIds: r.EnrolledCourseIds ? r.EnrolledCourseIds.split(",") : [],
        createdAt: r.CreatedAt.toISOString(),
      } as Student;
    });
  }

  // Enrollments
  private enrollmentSelect(where: string): string {
    return `
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
      WHERE ${where}
    `;
  }

  private mapEnrollmentRow(r: {
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
    CurrencyCode: string | null;
    EnrollmentSource: string | null;
    ActivatedAt: Date | null;
    CompletedAt: Date | null;
    CreatedAt: Date;
  }): EnrollmentAdminRecord {
    return {
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
      enrollmentSource: (r.EnrollmentSource ?? "").toLowerCase(),
      ...(r.ActivatedAt ? { activatedAt: r.ActivatedAt.toISOString() } : {}),
      ...(r.CompletedAt ? { completedAt: r.CompletedAt.toISOString() } : {}),
      createdAt: r.CreatedAt.toISOString(),
    };
  }

  async findEnrollments(filter?: {
    studentId?: string | undefined;
    courseId?: string | undefined;
    batchId?: string | undefined;
    status?: string | undefined;
  }): Promise<EnrollmentAdminRecord[]> {
    const pool = await this.getPool();
    const req = pool.request();
    const conditions: string[] = ["1=1"];

    for (const [key, column] of [
      ["studentId", "e.StudentUserId"],
      ["courseId", "e.CourseId"],
      ["batchId", "e.BatchId"],
    ] as const) {
      const value = filter?.[key];
      if (value) {
        if (!/^[0-9]+$/.test(value)) return [];
        req.input(key, sql.BigInt, value);
        conditions.push(`${column} = @${key}`);
      }
    }
    if (filter?.status) {
      req.input("status", sql.VarChar(25), filter.status.toUpperCase());
      conditions.push("UPPER(e.EnrollmentStatus) = @status");
    }

    const result = await req.query(`${this.enrollmentSelect(conditions.join(" AND "))} ORDER BY e.CreatedAt DESC`);
    return result.recordset.map((r) => this.mapEnrollmentRow(r));
  }

  async findEnrollmentById(id: EntityId): Promise<EnrollmentAdminRecord | null> {
    if (!/^[0-9]+$/.test(id)) return null;
    const pool = await this.getPool();
    const req = pool.request();
    req.input("enrId", sql.BigInt, id);
    const result = await req.query(this.enrollmentSelect("e.EnrollmentId = @enrId"));
    const r = result.recordset[0];
    return r ? this.mapEnrollmentRow(r) : null;
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
    requireNumericIds({ student: input.studentUserId, course: input.courseId, batch: input.batchId });
    if (input.freeAccess) {
      // Defence in depth: the service and validation already guarantee these.
      if (input.status !== "active") throw new Error("A free access override must create an ACTIVE enrollment");
      if (!input.audit.reason) throw new AdminRuleViolationError("REASON_REQUIRED", "A free access override requires a reason");
      if (input.discountCode) {
        throw new AdminRuleViolationError("FREE_ACCESS_WITH_DISCOUNT", "A discount code cannot be combined with free access");
      }
    }
    const pool = await this.getPool();
    const tx = pool.transaction();
    await tx.begin();

    let enrollmentId: string;
    try {
      const sReq = tx.request();
      sReq.input("studentId", sql.BigInt, input.studentUserId);
      const student = await sReq.query<{ ApprovalStatus: string | null; AccountStatus: string }>(`
        SELECT sp.ApprovalStatus, u.AccountStatus
        FROM dbo.NXA_Users u
        JOIN dbo.NXA_StudentProfiles sp ON sp.UserId = u.UserId
        WHERE u.UserId = @studentId AND u.DeletedAt IS NULL
          AND NOT ${hasRole("u", [...ADMIN_ROLE_CODES, ...TEACHER_ROLE_CODES])}
      `);
      const s = student.recordset[0];
      if (!s) throw new RecordNotFoundError("student", input.studentUserId);
      if ((s.ApprovalStatus ?? "").toLowerCase() !== "approved") {
        throw new AdminRuleViolationError("STUDENT_NOT_APPROVED", "The student must be approved before enrollment (BR-002)");
      }
      if (["suspended", "deactivated"].includes((s.AccountStatus ?? "").toLowerCase())) {
        throw new AdminRuleViolationError("STUDENT_INACTIVE", `Cannot enroll a ${s.AccountStatus.toLowerCase()} account`);
      }

      const cReq = tx.request();
      cReq.input("courseId", sql.BigInt, input.courseId);
      const course = await cReq.query<{ ListPrice: number | string; CurrencyCode: string }>(`
        SELECT ListPrice, CurrencyCode FROM dbo.NXA_Courses WHERE CourseId = @courseId AND DeletedAt IS NULL
      `);
      const c = course.recordset[0];
      if (!c) throw new RecordNotFoundError("course", input.courseId);
      const price = Number(c.ListPrice);

      // Only a defined coupon may reduce the fee: NXA_Coupons.CouponCode -> its
      // NXA_Discounts row. The coupon row is locked (UPDLOCK, HOLDLOCK) until
      // commit, so concurrent redemptions of the same coupon are serialized and
      // the usage and per-user limits cannot be exceeded by a race.
      let discount = 0;
      let appliedCoupon: {
        couponId: string;
        code: string;
        discountId: string;
        name: string;
        type: string;
        value: number;
      } | null = null;
      if (input.discountCode) {
        const cpReq = tx.request();
        cpReq.input("code", sql.VarChar(40), input.discountCode.trim().toUpperCase());
        const cp = await cpReq.query<{
          CouponId: number | bigint;
          CouponCode: string;
          CouponActive: boolean;
          UsageLimit: number | null;
          PerUserLimit: number | null;
          UsageCount: number;
          DiscountId: number | bigint;
          DiscountName: string;
          DiscountType: string;
          DiscountValue: number | string;
          StartsAt: Date | null;
          EndsAt: Date | null;
          DiscountActive: boolean;
        }>(`
          SELECT c.CouponId, c.CouponCode, c.IsActive AS CouponActive, c.UsageLimit, c.PerUserLimit, c.UsageCount,
                 d.DiscountId, d.DiscountName, d.DiscountType, d.DiscountValue, d.StartsAt, d.EndsAt,
                 d.IsActive AS DiscountActive
          FROM dbo.NXA_Coupons c WITH (UPDLOCK, HOLDLOCK)
          JOIN dbo.NXA_Discounts d ON d.DiscountId = c.DiscountId
          WHERE c.CouponCode = @code
        `);
        const cpn = cp.recordset[0];
        if (!cpn) throw new AdminRuleViolationError("DISCOUNT_NOT_FOUND", "No coupon exists with this code");

        let userRedemptions: number | null = null;
        if (cpn.PerUserLimit != null) {
          const rReq = tx.request();
          rReq.input("couponId", sql.BigInt, cpn.CouponId);
          rReq.input("studentId", sql.BigInt, input.studentUserId);
          // Every recorded redemption counts: the allowed RedemptionStatus
          // values are not visible to the application, so none is excluded.
          const used = await rReq.query<{ cnt: number }>(`
            SELECT COUNT(1) AS cnt FROM dbo.NXA_CouponRedemptions WITH (UPDLOCK, HOLDLOCK)
            WHERE CouponId = @couponId AND StudentUserId = @studentId
          `);
          userRedemptions = Number(used.recordset[0]?.cnt ?? 0);
        }

        const rejection = checkCouponUsable(
          {
            isActive: Boolean(cpn.CouponActive) && Boolean(cpn.DiscountActive),
            startsAt: cpn.StartsAt,
            endsAt: cpn.EndsAt,
            usageLimit: cpn.UsageLimit,
            usageCount: cpn.UsageCount,
            perUserLimit: cpn.PerUserLimit,
          },
          new Date(),
          userRedemptions,
        );
        if (rejection) throw new AdminRuleViolationError(rejection.code, rejection.message);

        const value = Number(cpn.DiscountValue);
        discount = couponDiscountAmount(cpn.DiscountType, value, price);
        if (discount <= 0) {
          throw new AdminRuleViolationError("DISCOUNT_NOT_APPLICABLE", "This coupon gives no discount on this course");
        }
        appliedCoupon = {
          couponId: String(cpn.CouponId),
          code: cpn.CouponCode,
          discountId: String(cpn.DiscountId),
          name: cpn.DiscountName,
          type: cpn.DiscountType,
          value,
        };
      }

      // Free access waives the full course price.
      if (input.freeAccess) discount = price;

      let capacityOverride: { reason: string; capacity: number; enrolled: number } | null = null;
      if (input.batchId) {
        const bReq = tx.request();
        bReq.input("batchId", sql.BigInt, input.batchId);
        const batch = await bReq.query<{ CourseId: number | bigint; Status: string }>(`
          SELECT CourseId, Status FROM dbo.NXA_Batches WHERE BatchId = @batchId
        `);
        const b = batch.recordset[0];
        if (!b) throw new RecordNotFoundError("batch", input.batchId);
        if (String(b.CourseId) !== String(input.courseId)) {
          throw new AdminRuleViolationError("BATCH_COURSE_MISMATCH", "The selected batch does not belong to the selected course");
        }
        if (["completed", "cancelled"].includes((b.Status ?? "").toLowerCase())) {
          throw new AdminRuleViolationError("BATCH_CLOSED", `Cannot enroll into a ${b.Status.toLowerCase()} batch`);
        }
        // D6: the batch row is locked until commit, which serializes
        // enrollments into this batch (Admin and self-enrollment alike).
        // Counted exactly as the batch's CurrentEnrollments (every status
        // except CANCELLED). NULL capacity = no limit.
        const capReq = tx.request();
        capReq.input("batchId", sql.BigInt, input.batchId);
        const cap = await capReq.query<{ Capacity: number | null }>(`
          SELECT Capacity FROM dbo.NXA_Batches WITH (UPDLOCK, HOLDLOCK) WHERE BatchId = @batchId
        `);
        const capacity = cap.recordset[0]?.Capacity;
        if (capacity !== null && capacity !== undefined) {
          const cntReq = tx.request();
          cntReq.input("batchId", sql.BigInt, input.batchId);
          const cnt = await cntReq.query<{ cnt: number }>(`
            SELECT COUNT(1) AS cnt FROM dbo.NXA_Enrollments WITH (UPDLOCK, HOLDLOCK)
            WHERE BatchId = @batchId AND UPPER(EnrollmentStatus) <> 'CANCELLED'
          `);
          const enrolled = Number(cnt.recordset[0]?.cnt ?? 0);
          if (enrolled >= Number(capacity)) {
            if (!input.capacityOverrideReason) {
              throw new AdminRuleViolationError(
                "BATCH_FULL",
                `This batch is full (${enrolled} of ${capacity}). Give a capacity override reason to enroll anyway.`,
                409,
              );
            }
            capacityOverride = { reason: input.capacityOverrideReason, capacity: Number(capacity), enrolled };
          }
        }
      }

      // D4: every prerequisite course must have a COMPLETED enrollment, unless
      // the Admin gives an override reason (recorded in the audit row).
      const pReq = tx.request();
      pReq.input("courseId", sql.BigInt, input.courseId);
      pReq.input("studentId", sql.BigInt, input.studentUserId);
      const missingPrereqs = await pReq.query<{ PrerequisiteCourseId: number | bigint; CourseCode: string; CourseName: string }>(`
        SELECT p.PrerequisiteCourseId, c.CourseCode, c.CourseName
        FROM dbo.NXA_CoursePrerequisites p
        JOIN dbo.NXA_Courses c ON c.CourseId = p.PrerequisiteCourseId
        WHERE p.CourseId = @courseId
          AND NOT EXISTS (
            SELECT 1 FROM dbo.NXA_Enrollments pe
            WHERE pe.StudentUserId = @studentId AND pe.CourseId = p.PrerequisiteCourseId AND UPPER(pe.EnrollmentStatus) = 'COMPLETED'
          )
        ORDER BY c.CourseName ASC, p.PrerequisiteCourseId ASC
      `);
      // Every real row carries its (foreign key) PrerequisiteCourseId.
      const missing = missingPrereqs.recordset.filter((r) => r.PrerequisiteCourseId !== null && r.PrerequisiteCourseId !== undefined);
      let prerequisiteOverride: { reason: string; missingCourseIds: string[] } | null = null;
      if (missing.length > 0) {
        const names = missing.map((r) => `${r.CourseName} (${r.CourseCode})`).join(", ");
        if (!input.prerequisiteOverrideReason) {
          throw new AdminRuleViolationError(
            "PREREQUISITES_NOT_MET",
            `Prerequisite course(s) not completed: ${names}. Give a prerequisite override reason to enroll anyway.`,
          );
        }
        prerequisiteOverride = {
          reason: input.prerequisiteOverrideReason,
          missingCourseIds: missing.map((r) => String(r.PrerequisiteCourseId)),
        };
      }

      const dReq = tx.request();
      dReq.input("studentId", sql.BigInt, input.studentUserId);
      dReq.input("courseId", sql.BigInt, input.courseId);
      const dup = await dReq.query(`
        SELECT TOP 1 1 AS x FROM dbo.NXA_Enrollments WITH (UPDLOCK, HOLDLOCK)
        WHERE StudentUserId = @studentId AND CourseId = @courseId AND UPPER(EnrollmentStatus) <> 'CANCELLED'
      `);
      if (dup.recordset.length > 0) throw new DuplicateRecordError("enrollment", "courseId", input.courseId);

      const req = tx.request();
      const enrollmentNumber = `ENR-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(4).toString("hex").toUpperCase()}`;
      req.input("num", sql.VarChar(40), enrollmentNumber);
      req.input("studentId", sql.BigInt, input.studentUserId);
      req.input("courseId", sql.BigInt, input.courseId);
      req.input("batchId", sql.BigInt, input.batchId ?? null);
      req.input("status", sql.VarChar(25), input.status.toUpperCase());
      req.input("price", sql.Decimal(12, 2), price);
      req.input("discount", sql.Decimal(12, 2), discount);
      req.input("final", sql.Decimal(12, 2), price - discount);
      req.input("currency", sql.Char(3), c.CurrencyCode ?? "INR");
      req.input("createdBy", sql.BigInt, input.createdByUserId);

      const result = await req.query<{ EnrollmentId: number | bigint }>(`
        INSERT INTO dbo.NXA_Enrollments (
          StudentUserId, CourseId, BatchId, EnrollmentNumber, EnrollmentStatus,
          CoursePrice, DiscountAmount, FinalAmount, CurrencyCode, EnrollmentSource,
          CreatedByUserId, ActivatedAt, CreatedAt, UpdatedAt
        )
        OUTPUT inserted.EnrollmentId
        VALUES (
          @studentId, @courseId, @batchId, @num, @status,
          @price, @discount, @final, @currency, 'ADMIN',
          @createdBy, CASE WHEN @status = 'ACTIVE' THEN SYSUTCDATETIME() ELSE NULL END,
          SYSUTCDATETIME(), SYSUTCDATETIME()
        )
      `);
      enrollmentId = String(result.recordset[0]?.EnrollmentId);

      // BR-007/PAY-010: the free-access grant is recorded as an override,
      // authorized by the granting user, atomically with the enrollment.
      let overrideId: string | null = null;
      if (input.freeAccess) {
        const oReq = tx.request();
        oReq.input("enrollmentId", sql.BigInt, enrollmentId);
        oReq.input("overrideType", sql.VarChar(30), FREE_ACCESS_OVERRIDE_TYPE);
        oReq.input("reason", sql.NVarChar(500), input.audit.reason);
        oReq.input("approvedBy", sql.BigInt, input.audit.actorUserId);
        const ov = await oReq.query<{ EnrollmentOverrideId: number | bigint }>(`
          INSERT INTO dbo.NXA_EnrollmentOverrides (EnrollmentId, OverrideType, Reason, ApprovedByUserId, CreatedAt)
          OUTPUT inserted.EnrollmentOverrideId
          VALUES (@enrollmentId, @overrideType, @reason, @approvedBy, SYSUTCDATETIME())
        `);
        overrideId = String(ov.recordset[0]?.EnrollmentOverrideId);
      }

      // The coupon redemption and its usage count are written in the same
      // transaction as the enrollment. RedemptionStatus is not supplied: its
      // allowed values (CHECK) are not visible to the application, so the
      // column's table default applies.
      let redemptionId: string | null = null;
      if (appliedCoupon) {
        const rdReq = tx.request();
        rdReq.input("couponId", sql.BigInt, appliedCoupon.couponId);
        rdReq.input("enrollmentId", sql.BigInt, enrollmentId);
        rdReq.input("studentId", sql.BigInt, input.studentUserId);
        rdReq.input("amount", sql.Decimal(12, 2), discount);
        try {
          const rd = await rdReq.query<{ CouponRedemptionId: number | bigint }>(`
            INSERT INTO dbo.NXA_CouponRedemptions (CouponId, EnrollmentId, StudentUserId, DiscountAmount, RedeemedAt)
            OUTPUT inserted.CouponRedemptionId
            VALUES (@couponId, @enrollmentId, @studentId, @amount, SYSUTCDATETIME())
          `);
          redemptionId = String(rd.recordset[0]?.CouponRedemptionId);
        } catch (err) {
          if (isUniqueViolation(err)) throw new DuplicateRecordError("coupon redemption", "enrollmentId", enrollmentId);
          throw err;
        }

        // Guarded increment: never exceeds UsageLimit even if the row changed.
        const ucReq = tx.request();
        ucReq.input("couponId", sql.BigInt, appliedCoupon.couponId);
        const uc = await ucReq.query(`
          UPDATE dbo.NXA_Coupons
          SET UsageCount = UsageCount + 1
          WHERE CouponId = @couponId AND IsActive = 1 AND (UsageLimit IS NULL OR UsageCount < UsageLimit)
        `);
        if ((uc.rowsAffected[0] ?? 0) !== 1) {
          throw new AdminRuleViolationError("DISCOUNT_USAGE_LIMIT_REACHED", "This coupon code has reached its usage limit.");
        }
      }

      await writeAuditLog(tx.request(), {
        actorUserId: input.audit.actorUserId,
        actionType: input.audit.actionType,
        moduleCode: "ENROLLMENT_MGMT",
        entityName: "Enrollment",
        entityId: enrollmentId,
        newValues: JSON.stringify({
          enrollmentNumber,
          studentUserId: input.studentUserId,
          courseId: input.courseId,
          batchId: input.batchId ?? null,
          status: input.status,
          requestedByUserId: input.audit.actorUserId,
          coursePrice: price,
          discountAmount: discount,
          ...(appliedCoupon ? { coupon: { ...appliedCoupon, redemptionId } } : {}),
          ...(input.freeAccess
            ? { freeAccess: true, waivedAmount: price, overrideId, overrideType: FREE_ACCESS_OVERRIDE_TYPE }
            : {}),
          finalAmount: price - discount,
          ...(input.audit.reason ? { reason: input.audit.reason } : {}),
          ...(capacityOverride ? { capacityOverride } : {}),
          ...(prerequisiteOverride ? { prerequisiteOverride } : {}),
        }),
      });

      // Enrollment status history: the initial status of the new enrollment.
      await writeEnrollmentStatusHistory(tx.request(), {
        enrollmentId,
        oldStatus: null,
        newStatus: input.status.toUpperCase(),
        changedByUserId: input.audit.actorUserId,
        reason: input.audit.reason,
      });

      // PAY-013 financial audit history: the free-access waiver and any coupon redemption.
      if (input.freeAccess && overrideId) {
        await writeFinancialAuditHistory(tx.request(), {
          entityType: "EnrollmentOverride",
          entityId: overrideId,
          actionType: input.audit.actionType,
          performedByUserId: input.audit.actorUserId,
          newValues: {
            enrollmentId,
            studentUserId: input.studentUserId,
            overrideType: FREE_ACCESS_OVERRIDE_TYPE,
            coursePrice: price,
            waivedAmount: price,
            finalAmount: price - discount,
          },
          reason: input.audit.reason,
        });
      }
      if (appliedCoupon && redemptionId) {
        await writeFinancialAuditHistory(tx.request(), {
          entityType: "CouponRedemption",
          entityId: redemptionId,
          actionType: "REDEEM_COUPON",
          performedByUserId: input.audit.actorUserId,
          newValues: {
            enrollmentId,
            studentUserId: input.studentUserId,
            couponId: appliedCoupon.couponId,
            couponCode: appliedCoupon.code,
            discountId: appliedCoupon.discountId,
            coursePrice: price,
            discountAmount: discount,
            finalAmount: price - discount,
          },
        });
      }

      await tx.commit();
    } catch (err) {
      try {
        await tx.rollback();
      } catch {
        // see insertStaffUser
      }
      throw err;
    }

    const created = await this.findEnrollmentById(enrollmentId);
    if (!created) throw new RecordNotFoundError("enrollment", enrollmentId);
    return created;
  }

  async setEnrollmentStatus(
    id: EntityId,
    status: EnrollmentStatusValue,
    audit: TransactionalAudit,
  ): Promise<EnrollmentAdminRecord> {
    if (!/^[0-9]+$/.test(id)) throw new RecordNotFoundError("enrollment", id);
    const pool = await this.getPool();
    const tx = pool.transaction();
    await tx.begin();

    try {
      const cur = tx.request();
      cur.input("enrId", sql.BigInt, id);
      const before = await cur.query<{ EnrollmentStatus: string; ActivatedAt: Date | null }>(`
        SELECT EnrollmentStatus, ActivatedAt FROM dbo.NXA_Enrollments WITH (UPDLOCK) WHERE EnrollmentId = @enrId
      `);
      const oldStatus = before.recordset[0]?.EnrollmentStatus;
      if (oldStatus === undefined) throw new RecordNotFoundError("enrollment", id);
      if (oldStatus.toLowerCase() === status) {
        throw new AdminRuleViolationError("STATUS_UNCHANGED", `Enrollment is already ${status}`);
      }
      // BR-004 / CL-001 item 8: paid access comes from payment verification,
      // free access from the audited override. This endpoint may only resume
      // a suspended enrollment that one of those already activated.
      if (status === "active" && !(oldStatus.toUpperCase() === "SUSPENDED" && before.recordset[0]?.ActivatedAt)) {
        throw new AdminRuleViolationError(
          "ACTIVATION_REQUIRES_PAYMENT",
          "Enrollment access is granted only by a verified payment, a recorded manual payment or a free-access override. Manual activation can only resume a suspended enrollment that was already activated.",
        );
      }

      const req = tx.request();
      req.input("enrId", sql.BigInt, id);
      req.input("status", sql.VarChar(25), status.toUpperCase());
      // Same timestamp semantics as the enrollment module's setStatus.
      await req.query(`
        UPDATE dbo.NXA_Enrollments
        SET EnrollmentStatus = @status,
            ActivatedAt = CASE WHEN @status = 'ACTIVE' AND ActivatedAt IS NULL THEN SYSUTCDATETIME() ELSE ActivatedAt END,
            CompletedAt = CASE WHEN @status = 'COMPLETED' AND CompletedAt IS NULL THEN SYSUTCDATETIME() ELSE CompletedAt END,
            UpdatedAt = SYSUTCDATETIME()
        WHERE EnrollmentId = @enrId
      `);

      await writeAuditLog(tx.request(), {
        actorUserId: audit.actorUserId,
        actionType: audit.actionType,
        moduleCode: "ENROLLMENT_MGMT",
        entityName: "Enrollment",
        entityId: id,
        oldValues: JSON.stringify({ status: oldStatus.toLowerCase() }),
        newValues: JSON.stringify({ status, ...(audit.reason ? { reason: audit.reason } : {}) }),
      });

      // A no-op change was refused above (STATUS_UNCHANGED), so this is a real transition.
      await writeEnrollmentStatusHistory(tx.request(), {
        enrollmentId: id,
        oldStatus,
        newStatus: status.toUpperCase(),
        changedByUserId: audit.actorUserId,
        reason: audit.reason,
      });

      await tx.commit();
    } catch (err) {
      try {
        await tx.rollback();
      } catch {
        // see insertStaffUser
      }
      throw err;
    }

    const enr = await this.findEnrollmentById(id);
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
    const start = filter?.startDate ? new Date(filter.startDate) : undefined;
    if (start && !Number.isNaN(start.getTime())) {
      req.input("startDate", sql.DateTime2, start);
      conditions.push("al.CreatedAt >= @startDate");
    }
    const end = filter?.endDate ? new Date(filter.endDate) : undefined;
    if (end && !Number.isNaN(end.getTime())) {
      req.input("endDate", sql.DateTime2, end);
      conditions.push("al.CreatedAt <= @endDate");
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
        CASE WHEN u.UserId IS NULL THEN NULL ELSE ${roleCodeOf("u")} END AS ActorRole,
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
    const id = await writeAuditLog(pool.request(), log);
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
    // Secret-flagged rows never leave the repository; only known keys are mapped.
    const result = await pool.request().query<{ SettingKey: string; SettingValue: string }>(`
      SELECT SettingKey, SettingValue FROM dbo.NXA_InstituteSettings WHERE IsSecret = 0
    `);

    const map = new Map<string, string>();
    for (const r of result.recordset) {
      map.set(r.SettingKey, r.SettingValue);
    }

    return toInstituteSettings(map);
  }

  /**
   * Upserts only the supplied keys, in one transaction with an audit record
   * carrying the old and new values of exactly the keys that changed.
   */
  async saveInstituteSettings(
    settings: Partial<InstituteSettingsRecord>,
    updatedByUserId: EntityId,
  ): Promise<InstituteSettingsRecord> {
    const entries = Object.entries(settings).filter(
      (e): e is [string, string | number | boolean] => e[1] !== undefined && e[0] !== "updatedAt",
    );
    const pool = await this.getPool();
    const tx = pool.transaction();
    await tx.begin();

    try {
      const cur = await tx.request().query<{ SettingKey: string; SettingValue: string }>(`
        SELECT SettingKey, SettingValue FROM dbo.NXA_InstituteSettings WITH (UPDLOCK)
      `);
      const before = new Map(cur.recordset.map((r) => [r.SettingKey, r.SettingValue]));
      const oldValues: Record<string, string | null> = {};
      const newValues: Record<string, string> = {};

      for (const [k, v] of entries) {
        const value = String(v);
        if (before.get(k) === value) continue;
        oldValues[k] = before.get(k) ?? null;
        newValues[k] = value;

        const req = tx.request();
        req.input("key", sql.VarChar(150), k);
        req.input("val", sql.NVarChar(sql.MAX), value);
        req.input("userId", sql.BigInt, updatedByUserId);
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

      if (Object.keys(newValues).length > 0) {
        await writeAuditLog(tx.request(), {
          actorUserId: updatedByUserId,
          actionType: "UPDATE_SETTINGS",
          moduleCode: "INSTITUTE_SETTINGS",
          entityName: "InstituteSettings",
          entityId: "institute",
          oldValues: JSON.stringify(oldValues),
          newValues: JSON.stringify(newValues),
        });
      }

      await tx.commit();
    } catch (err) {
      try {
        await tx.rollback();
      } catch {
        // see insertStaffUser
      }
      throw err;
    }

    return this.getInstituteSettings();
  }

  // Refunds
  async findRefunds(status?: string | undefined, refundId?: EntityId): Promise<RefundRecord[]> {
    const pool = await this.getPool();
    const req = pool.request();
    const conditions: string[] = ["1=1"];

    if (status) {
      req.input("status", sql.VarChar(20), status.toUpperCase());
      conditions.push("UPPER(r.RefundStatus) = @status");
    }
    if (refundId !== undefined) {
      req.input("refundId", sql.BigInt, refundId);
      conditions.push("r.RefundId = @refundId");
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
      RequesterName: string | null;
      RequesterEmail: string | null;
    }>(`
      SELECT
        r.RefundId, r.RefundReference, r.TransactionId, r.RequestedByUserId, r.Amount,
        r.Reason, r.RefundStatus, r.GatewayRefundId, r.RequestedAt, r.ApprovedAt,
        r.ApprovedBySuperAdminUserId, r.CompletedAt,
        u.FullName AS RequesterName, u.Email AS RequesterEmail
      FROM dbo.NXA_Refunds r
      LEFT JOIN dbo.NXA_Users u ON u.UserId = r.RequestedByUserId
      WHERE ${conditions.join(" AND ")}
      ORDER BY r.RequestedAt DESC
    `);

    return result.recordset.map((r) => ({
      id: String(r.RefundId),
      refundReference: r.RefundReference,
      ...(r.TransactionId ? { transactionId: String(r.TransactionId) } : {}),
      requestedByUserId: String(r.RequestedByUserId),
      ...(r.RequesterName ? { requestedByName: r.RequesterName } : {}),
      ...(r.RequesterEmail ? { requestedByEmail: r.RequesterEmail } : {}),
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

  /**
   * Decides a PENDING refund (BR-006). Only a PENDING refund can be decided;
   * the status read takes an update lock so two Super Admins cannot both
   * decide it. ApprovedAt / ApprovedBySuperAdminUserId are stamped only on
   * approval (the columns mean "approved"); for a rejection the decider, time
   * and reason live in the audit record written in the same transaction.
   * NXA_Refunds has no remarks column, so remarks are kept in the audit only.
   * No gateway refund is triggered: an approved refund stays APPROVED until
   * the payment module completes it.
   */
  async updateRefundStatus(
    id: EntityId,
    status: "approved" | "rejected",
    decidedByUserId: EntityId,
    remarks?: string | undefined,
  ): Promise<RefundRecord> {
    requireNumericIds({ refund: id });
    const pool = await this.getPool();
    const tx = pool.transaction();
    await tx.begin();

    try {
      const cur = tx.request();
      cur.input("id", sql.BigInt, id);
      const before = await cur.query<{ RefundStatus: string; Amount: number }>(`
        SELECT RefundStatus, Amount FROM dbo.NXA_Refunds WITH (UPDLOCK) WHERE RefundId = @id
      `);
      const row = before.recordset[0];
      if (!row) throw new RecordNotFoundError("refund", id);
      const oldStatus = row.RefundStatus.toUpperCase();
      if (oldStatus !== "PENDING") {
        throw new AdminRuleViolationError(
          "REFUND_ALREADY_DECIDED",
          `This refund is already ${oldStatus.toLowerCase()} and cannot be decided again`,
          409,
        );
      }

      const req = tx.request();
      req.input("id", sql.BigInt, id);
      req.input("status", sql.VarChar(20), status.toUpperCase());
      req.input("deciderId", sql.BigInt, decidedByUserId);
      await req.query(`
        UPDATE dbo.NXA_Refunds
        SET RefundStatus = @status,
            ApprovedAt = CASE WHEN @status = 'APPROVED' THEN SYSUTCDATETIME() ELSE ApprovedAt END,
            ApprovedBySuperAdminUserId = CASE WHEN @status = 'APPROVED' THEN @deciderId ELSE ApprovedBySuperAdminUserId END
        WHERE RefundId = @id AND UPPER(RefundStatus) = 'PENDING'
      `);

      await writeAuditLog(tx.request(), {
        actorUserId: decidedByUserId,
        actionType: status === "approved" ? "APPROVE_REFUND" : "REJECT_REFUND",
        moduleCode: "FINANCE",
        entityName: "Refund",
        entityId: id,
        oldValues: JSON.stringify({ status: "pending" }),
        newValues: JSON.stringify({
          status,
          amount: Number(row.Amount),
          ...(remarks ? { remarks } : {}),
        }),
      });

      // PAY-013. An approved refund stays APPROVED: nothing is marked completed.
      await writeFinancialAuditHistory(tx.request(), {
        entityType: "Refund",
        entityId: id,
        actionType: status === "approved" ? "APPROVE_REFUND" : "REJECT_REFUND",
        performedByUserId: decidedByUserId,
        oldValues: { refundStatus: row.RefundStatus },
        newValues: { refundStatus: status.toUpperCase(), amount: Number(row.Amount) },
        reason: remarks,
      });

      await tx.commit();
    } catch (err) {
      try {
        await tx.rollback();
      } catch {
        // see insertStaffUser
      }
      throw err;
    }

    const [updated] = await this.findRefunds(undefined, id);
    if (!updated) throw new RecordNotFoundError("refund", id);
    return updated;
  }

  // Financial Overrides
  /**
   * Read-only history of NXA_EnrollmentOverrides with the real enrollment,
   * student and course they apply to. Amounts come from the enrollment
   * (CoursePrice, FinalAmount, DiscountAmount). ApprovedByUserId is NOT NULL:
   * it is the user who granted (and so authorized) the override, reported as
   * `requestedByAdminId`/`requestedByAdminName`; `decidedAt` is the recording
   * time. Every row is "approved"; "pending" and "rejected" match nothing.
   */
  async findFinancialOverrides(status?: string | undefined, overrideId?: EntityId): Promise<FinancialOverrideRecord[]> {
    const pool = await this.getPool();
    const req = pool.request();
    const conditions: string[] = ["1=1"];

    const wanted = status?.toLowerCase();
    if (wanted && wanted !== "approved") conditions.push("1=0");
    if (overrideId !== undefined) {
      req.input("overrideId", sql.BigInt, overrideId);
      conditions.push("fo.EnrollmentOverrideId = @overrideId");
    }

    const result = await req.query<{
      EnrollmentOverrideId: number | bigint;
      EnrollmentId: number | bigint;
      OverrideType: string;
      Reason: string;
      ApprovedByUserId: number | bigint;
      ApprovedByName: string | null;
      CreatedAt: Date;
      StudentUserId: number | bigint | null;
      StudentName: string | null;
      StudentEmail: string | null;
      CourseId: number | bigint | null;
      CourseTitle: string | null;
      CoursePrice: number | null;
      DiscountAmount: number | null;
      FinalAmount: number | null;
    }>(`
      SELECT
        fo.EnrollmentOverrideId, fo.EnrollmentId, fo.OverrideType, fo.Reason,
        fo.ApprovedByUserId, au.FullName AS ApprovedByName, fo.CreatedAt,
        e.StudentUserId, u.FullName AS StudentName, u.Email AS StudentEmail,
        e.CourseId, c.CourseName AS CourseTitle,
        e.CoursePrice, e.DiscountAmount, e.FinalAmount
      FROM dbo.NXA_EnrollmentOverrides fo
      LEFT JOIN dbo.NXA_Enrollments e ON e.EnrollmentId = fo.EnrollmentId
      LEFT JOIN dbo.NXA_Users u ON u.UserId = e.StudentUserId
      LEFT JOIN dbo.NXA_Users au ON au.UserId = fo.ApprovedByUserId
      LEFT JOIN dbo.NXA_Courses c ON c.CourseId = e.CourseId
      WHERE ${conditions.join(" AND ")}
      ORDER BY fo.CreatedAt DESC
    `);

    return result.recordset.map((r) => ({
      id: String(r.EnrollmentOverrideId),
      enrollmentId: String(r.EnrollmentId),
      studentId: r.StudentUserId != null ? String(r.StudentUserId) : "",
      ...(r.StudentName ? { studentName: r.StudentName } : {}),
      ...(r.StudentEmail ? { studentEmail: r.StudentEmail } : {}),
      courseId: r.CourseId != null ? String(r.CourseId) : "",
      ...(r.CourseTitle ? { courseTitle: r.CourseTitle } : {}),
      originalAmountINR: Number(r.CoursePrice ?? 0),
      proposedAmountINR: Number(r.FinalAmount ?? 0),
      discountOrWaiverINR: Number(r.DiscountAmount ?? 0),
      adjustmentType: r.OverrideType,
      reason: r.Reason,
      requestedByAdminId: String(r.ApprovedByUserId),
      ...(r.ApprovedByName ? { requestedByAdminName: r.ApprovedByName } : {}),
      requestedAt: r.CreatedAt.toISOString(),
      status: "approved" as const,
      decidedAt: r.CreatedAt.toISOString(),
    }));
  }

  /**
   * NXA_EnrollmentOverrides.ApprovedByUserId is NOT NULL: an override is
   * authorized by the user who records it, so no override is ever waiting for
   * a decision. Approving an existing override is a 409, rejecting is a 422,
   * and nothing is ever written.
   */
  async updateFinancialOverride(
    id: EntityId,
    status: "approved" | "rejected",
    _decidedByUserId: EntityId,
    _remarks?: string | undefined,
  ): Promise<FinancialOverrideRecord> {
    requireNumericIds({ "financial override": id });
    if (status === "rejected") {
      throw new AdminRuleViolationError(
        "OVERRIDE_REJECTION_UNSUPPORTED",
        "A financial override is authorized when it is granted and cannot be rejected afterwards. No change was made.",
      );
    }

    const [existing] = await this.findFinancialOverrides(undefined, id);
    if (!existing) throw new RecordNotFoundError("financial override", id);
    throw new AdminRuleViolationError(
      "OVERRIDE_ALREADY_DECIDED",
      "This financial override was approved when it was granted. No change was made.",
      409,
    );
  }

  // Student accounts (ADM-003)
  /**
   * Same end state as self-registration (sqlserver-registration.repository):
   * AccountStatus 'pending', EmailVerified/MobileVerified 0, profile
   * ApprovalStatus 'pending', `student` role. Unlike registration, a missing
   * `student` role is an error rather than a silent skip, and the audit
   * record is part of the transaction.
   */
  async createStudentUser(input: {
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
  }): Promise<AdminCreatedStudent> {
    if (input.interestedCourseId !== undefined && !/^[0-9]+$/.test(input.interestedCourseId)) {
      throw new AdminRuleViolationError("COURSE_NOT_FOUND", "The selected course does not exist");
    }
    const createdAt = new Date();

    const userId = await this.insertStaffUser(
      {
        name: input.name,
        email: input.email,
        mobile: input.mobile,
        passwordHash: input.passwordHash,
        assignedByUserId: input.createdByUserId,
        roleCode: "student",
        accountStatus: "pending",
      },
      async (tx, newUserId) => {
        if (input.interestedCourseId !== undefined) {
          const cReq = tx.request();
          cReq.input("courseId", sql.BigInt, input.interestedCourseId);
          const course = await cReq.query(
            `SELECT TOP 1 1 AS x FROM dbo.NXA_Courses WHERE CourseId = @courseId AND DeletedAt IS NULL`,
          );
          if (course.recordset.length === 0) {
            throw new AdminRuleViolationError("COURSE_NOT_FOUND", "The selected course does not exist");
          }
        }

        const pReq = tx.request();
        pReq.input("userId", sql.BigInt, newUserId);
        pReq.input("collegeName", sql.NVarChar(200), input.collegeName ?? null);
        pReq.input("degree", sql.NVarChar(100), input.degree ?? null);
        pReq.input("branch", sql.NVarChar(100), input.branch ?? null);
        pReq.input("passingYear", sql.SmallInt, input.passingYear ?? null);
        pReq.input("interestedCourseId", sql.BigInt, input.interestedCourseId ?? null);
        pReq.input("dateOfBirth", sql.Date, input.dateOfBirth ? new Date(`${input.dateOfBirth}T00:00:00Z`) : null);
        pReq.input("gender", sql.VarChar(30), input.gender ?? null);
        pReq.input("city", sql.NVarChar(100), input.city ?? null);
        pReq.input("state", sql.NVarChar(100), input.state ?? null);
        await pReq.query(`
          INSERT INTO dbo.NXA_StudentProfiles (
            UserId, CollegeName, Degree, Branch, PassingYear, InterestedCourseId,
            DateOfBirth, Gender, City, State, ApprovalStatus, CreatedAt
          )
          VALUES (
            @userId, @collegeName, @degree, @branch, @passingYear, @interestedCourseId,
            @dateOfBirth, @gender, @city, @state, 'pending', SYSUTCDATETIME()
          )
        `);

        await writeAuditLog(tx.request(), {
          actorUserId: input.createdByUserId,
          actionType: "CREATE_STUDENT",
          moduleCode: "STUDENT_MGMT",
          entityName: "Student",
          entityId: newUserId,
          newValues: JSON.stringify({
            name: input.name.trim(),
            email: input.email.trim().toLowerCase(),
            mobile: input.mobile.trim(),
            accountStatus: "pending",
            approvalStatus: "pending",
            emailVerified: false,
            mobileVerified: false,
            ...(input.interestedCourseId ? { interestedCourseId: input.interestedCourseId } : {}),
          }),
        });
      },
    );

    return {
      id: userId,
      name: input.name.trim(),
      email: input.email.trim().toLowerCase(),
      mobile: input.mobile.trim(),
      accountStatus: "pending",
      approvalStatus: "pending",
      isEmailVerified: false,
      isMobileVerified: false,
      accountState: "pending_verification",
      createdAt: createdAt.toISOString(),
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
      permissions: [],
      createdAt: r.CreatedAt.toISOString(),
    }));
  }

  async unlockUserAccount(userId: EntityId, audit?: StaffAudit): Promise<void> {
    if (!/^[0-9]+$/.test(userId)) throw new RecordNotFoundError("user", userId);
    await this.inTeacherTransaction(async (tx) => {
      // Unlock clears the credential lockout only. It must NOT change
      // AccountStatus: activating here would bypass approval and suspension.
      // Only an account with something to clear is updated and audited.
      const req = tx.request();
      req.input("userId", sql.BigInt, userId);
      const result = await req.query(`
        UPDATE dbo.NXA_Users
        SET FailedLoginAttempts = 0, IsLocked = 0, LockoutUntil = NULL, UpdatedAt = SYSUTCDATETIME()
        WHERE UserId = @userId AND DeletedAt IS NULL
          AND (ISNULL(FailedLoginAttempts, 0) <> 0 OR ISNULL(IsLocked, 0) <> 0 OR LockoutUntil IS NOT NULL)
      `);
      if ((result.rowsAffected[0] ?? 0) > 0) {
        await writeStaffAudit(tx, audit, userId);
        return;
      }
      const exists = await tx
        .request()
        .input("userId", sql.BigInt, userId)
        .query(`SELECT 1 AS x FROM dbo.NXA_Users WHERE UserId = @userId AND DeletedAt IS NULL`);
      if (exists.recordset.length === 0) throw new RecordNotFoundError("user", userId);
    });
  }

  async findTeachers(filter?: { search?: string | undefined; status?: string | undefined }): Promise<Teacher[]> {
    const pool = await this.getPool();
    const req = pool.request();
    const conditions: string[] = ["u.DeletedAt IS NULL", hasRole("u", TEACHER_ROLE_CODES)];

    if (filter?.status) {
      req.input("status", sql.VarChar(20), filter.status.toLowerCase());
      conditions.push("LOWER(u.AccountStatus) = @status");
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
      AccountStatus: string;
      CreatedAt: Date;
      Specialization: string | null;
      ExperienceYears: number | null;
      Qualification: string | null;
      Bio: string | null;
      AssignedCourseIds: string | null;
      AssignedBatchIds: string | null;
    }>(`
      SELECT
        u.UserId,
        u.FullName,
        u.Email,
        u.MobileNumber,
        u.AccountStatus,
        u.CreatedAt,
        tp.Specialization,
        tp.ExperienceYears,
        tp.Qualification,
        tp.Bio,
        (
          SELECT STRING_AGG(CAST(a.CourseId AS VARCHAR(30)), ',')
          FROM (SELECT DISTINCT ta.CourseId FROM dbo.NXA_TeacherAllocations ta
                WHERE ta.TeacherUserId = u.UserId AND ta.IsActive = 1) a
        ) AS AssignedCourseIds,
        (
          SELECT STRING_AGG(CAST(ta.BatchId AS VARCHAR(30)), ',')
          FROM dbo.NXA_TeacherAllocations ta
          WHERE ta.TeacherUserId = u.UserId AND ta.IsActive = 1 AND ta.BatchId IS NOT NULL
        ) AS AssignedBatchIds
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
      status: toUserStatus(r.AccountStatus),
      createdAt: r.CreatedAt.toISOString(),
      specialization: r.Specialization ?? "",
      experienceYears: Number(r.ExperienceYears ?? 0),
      bio: r.Bio ?? "",
      qualifications: r.Qualification ?? "",
      // Derived from active allocations (approved decision), never stored.
      assignedCourseIds: r.AssignedCourseIds ? r.AssignedCourseIds.split(",") : [],
      assignedBatchIds: r.AssignedBatchIds ? r.AssignedBatchIds.split(",") : [],
      // No rating source exists; 0 means "not rated", not a score.
      rating: 0,
    }));
  }

  async createTeacherUser(input: {
    name: string;
    email: string;
    mobile: string;
    passwordHash: string;
    assignedByUserId: EntityId;
    specialization?: string | undefined;
    experienceYears?: number | undefined;
    qualifications?: string | undefined;
    bio?: string | undefined;
  }, audit?: StaffAudit): Promise<Teacher> {
    const userId = await this.insertStaffUser({ ...input, roleCode: "teacher" }, async (tx, newUserId) => {
      const tpReq = tx.request();
      tpReq.input("userId", sql.BigInt, newUserId);
      tpReq.input("empCode", sql.VarChar(40), `TCH-${newUserId}`);
      tpReq.input("spec", sql.NVarChar(200), input.specialization ?? null);
      tpReq.input("exp", sql.Decimal(4, 1), input.experienceYears ?? 0);
      tpReq.input("qual", sql.NVarChar(200), input.qualifications ?? null);
      tpReq.input("bio", sql.NVarChar(sql.MAX), input.bio ?? null);
      await tpReq.query(`
        INSERT INTO dbo.NXA_TeacherProfiles (
          UserId, EmployeeCode, Specialization, ExperienceYears, Qualification, Bio, IsActive, CreatedAt
        )
        VALUES (@userId, @empCode, @spec, @exp, @qual, @bio, 1, SYSUTCDATETIME())
      `);
      await writeStaffAudit(tx, audit, newUserId);
    });

    const [created] = (await this.findTeachers()).filter((t) => t.id === userId);
    if (!created) throw new RecordNotFoundError("teacher", userId);
    return created;
  }

  /** Runs `work` in one transaction; rolls back and rethrows on any error. */
  private async inTeacherTransaction<T>(work: (tx: sql.Transaction) => Promise<T>): Promise<T> {
    const pool = await this.getPool();
    const tx = pool.transaction();
    await tx.begin();
    try {
      const result = await work(tx);
      await tx.commit();
      return result;
    } catch (err) {
      try {
        await tx.rollback();
      } catch {
        // the original error is the one worth reporting
      }
      throw err;
    }
  }

  private async findTeacherById(id: EntityId): Promise<Teacher> {
    const [teacher] = (await this.findTeachers()).filter((t) => t.id === String(id));
    if (!teacher) throw new RecordNotFoundError("teacher", id);
    return teacher;
  }

  /** Locks the teacher's user row; RecordNotFoundError when the user is not a live teacher. */
  private async lockTeacher(
    tx: sql.Transaction,
    id: EntityId,
  ): Promise<{ FullName: string; AccountStatus: string; Specialization: string | null; ExperienceYears: number | null; Qualification: string | null; Bio: string | null; HasProfile: number }> {
    const r = await tx
      .request()
      .input("id", sql.BigInt, id)
      .query(`
        SELECT u.FullName, u.AccountStatus, tp.Specialization, tp.ExperienceYears, tp.Qualification, tp.Bio,
               CASE WHEN tp.UserId IS NULL THEN 0 ELSE 1 END AS HasProfile
        FROM dbo.NXA_Users u WITH (UPDLOCK, HOLDLOCK)
        LEFT JOIN dbo.NXA_TeacherProfiles tp ON tp.UserId = u.UserId
        WHERE u.UserId = @id AND u.DeletedAt IS NULL AND ${hasRole("u", TEACHER_ROLE_CODES)}
      `);
    const row = r.recordset[0];
    if (!row) throw new RecordNotFoundError("teacher", id);
    return row;
  }

  async updateTeacher(
    id: EntityId,
    changes: {
      name?: string | undefined;
      specialization?: string | null | undefined;
      experienceYears?: number | undefined;
      qualifications?: string | null | undefined;
      bio?: string | null | undefined;
    },
    actorUserId: EntityId,
  ): Promise<{ record: Teacher; changed: boolean }> {
    requireNumericIds({ teacher: id });
    const changed = await this.inTeacherTransaction(async (tx) => {
      const cur = await this.lockTeacher(tx, id);
      const before: Record<string, unknown> = {
        name: cur.FullName,
        specialization: cur.Specialization ?? null,
        experienceYears: Number(cur.ExperienceYears ?? 0),
        qualifications: cur.Qualification ?? null,
        bio: cur.Bio ?? null,
      };
      const norm = (v: unknown) => (v === "" ? null : v);
      const diff = (Object.keys(changes) as Array<keyof typeof changes>).filter(
        (k) => changes[k] !== undefined && norm(changes[k]) !== before[k],
      );
      if (diff.length === 0) return false;

      if (diff.includes("name")) {
        await tx
          .request()
          .input("id", sql.BigInt, id)
          .input("name", sql.NVarChar(150), changes.name)
          .query(`UPDATE dbo.NXA_Users SET FullName = @name, UpdatedAt = SYSUTCDATETIME() WHERE UserId = @id`);
      }
      const profileKeys = diff.filter((k) => k !== "name");
      if (profileKeys.length > 0) {
        const next = {
          spec: diff.includes("specialization") ? norm(changes.specialization) : cur.Specialization,
          exp: diff.includes("experienceYears") ? changes.experienceYears : Number(cur.ExperienceYears ?? 0),
          qual: diff.includes("qualifications") ? norm(changes.qualifications) : cur.Qualification,
          bio: diff.includes("bio") ? norm(changes.bio) : cur.Bio,
        };
        const p = tx
          .request()
          .input("id", sql.BigInt, id)
          .input("spec", sql.NVarChar(200), next.spec ?? null)
          .input("exp", sql.Decimal(4, 1), next.exp ?? 0)
          .input("qual", sql.NVarChar(200), next.qual ?? null)
          .input("bio", sql.NVarChar(sql.MAX), next.bio ?? null);
        if (cur.HasProfile) {
          await p.query(`
            UPDATE dbo.NXA_TeacherProfiles
            SET Specialization = @spec, ExperienceYears = @exp, Qualification = @qual, Bio = @bio, UpdatedAt = SYSUTCDATETIME()
            WHERE UserId = @id
          `);
        } else {
          p.input("empCode", sql.VarChar(40), `TCH-${id}`);
          p.input("active", sql.Bit, String(cur.AccountStatus ?? "").toLowerCase() === "active");
          await p.query(`
            INSERT INTO dbo.NXA_TeacherProfiles (UserId, EmployeeCode, Specialization, ExperienceYears, Qualification, Bio, IsActive, CreatedAt)
            VALUES (@id, @empCode, @spec, @exp, @qual, @bio, @active, SYSUTCDATETIME())
          `);
        }
      }
      await writeAuditLog(tx.request(), {
        actorUserId,
        actionType: "UPDATE_TEACHER",
        moduleCode: "TEACHER_MGMT",
        entityName: "Teacher",
        entityId: String(id),
        oldValues: JSON.stringify(Object.fromEntries(diff.map((k) => [k, before[k]]))),
        newValues: JSON.stringify(Object.fromEntries(diff.map((k) => [k, norm(changes[k])]))),
      });
      return true;
    });
    return { record: await this.findTeacherById(id), changed };
  }

  async setTeacherStatus(
    id: EntityId,
    status: "active" | "deactivated",
    reason: string | undefined,
    actorUserId: EntityId,
  ): Promise<{ record: Teacher; changed: boolean }> {
    requireNumericIds({ teacher: id });
    const changed = await this.inTeacherTransaction(async (tx) => {
      const cur = await this.lockTeacher(tx, id);
      const previous = String(cur.AccountStatus ?? "").toLowerCase();
      if (previous === status) return false;
      await tx
        .request()
        .input("id", sql.BigInt, id)
        .input("status", sql.VarChar(20), status)
        .query(`UPDATE dbo.NXA_Users SET AccountStatus = @status, UpdatedAt = SYSUTCDATETIME() WHERE UserId = @id`);
      await tx
        .request()
        .input("id", sql.BigInt, id)
        .input("active", sql.Bit, status === "active")
        .query(`UPDATE dbo.NXA_TeacherProfiles SET IsActive = @active, UpdatedAt = SYSUTCDATETIME() WHERE UserId = @id`);
      await writeAuditLog(tx.request(), {
        actorUserId,
        actionType: status === "active" ? "ACTIVATE_TEACHER" : "DEACTIVATE_TEACHER",
        moduleCode: "TEACHER_MGMT",
        entityName: "Teacher",
        entityId: String(id),
        oldValues: JSON.stringify({ status: previous }),
        newValues: JSON.stringify({ status, ...(reason ? { reason } : {}) }),
      });
      return true;
    });
    return { record: await this.findTeacherById(id), changed };
  }
}
