import sql from "mssql";

import type { PaginatedResult, PaginationQuery } from "../../contracts/api.contract";
import type { EntityId } from "../../contracts/identifier.contract";
import {
  DuplicateRecordError,
  RecordNotFoundError,
} from "../../repositories/repository.errors";
import { getSqlServerPool } from "../../db/sqlserver.pool";
import { deriveAccountState } from "./account-state";
import { writeAuditLog } from "../admin/sqlserver-admin.repository";
import type { StudentAudit, StudentRepository } from "./student.repository";
import {
  DEFAULT_STUDENT_SORT,
  type AdminApprovalStatus,
  type AdminSettableStudentStatus,
  type ApprovalDecision,
  type CreateStudentInput,
  type Gender,
  type Student,
  type StudentFilter,
  type StudentProfileInput,
  type StudentSort,
  type UpdateStudentInput,
} from "./student.types";

interface StudentRow {
  UserId: number | bigint | string;
  FullName: string;
  Email: string;
  MobileNumber: string;
  AccountStatus: string;
  EmailVerified: boolean | number;
  MobileVerified: boolean | number;
  UserCreatedAt: Date | string;
  CollegeName: string | null;
  Degree: string | null;
  Branch: string | null;
  PassingYear: number | null;
  InterestedCourseId: number | bigint | string | null;
  DateOfBirth: Date | string | null;
  Gender: string | null;
  AddressLine1: string | null;
  AddressLine2: string | null;
  City: string | null;
  State: string | null;
  Country: string | null;
  PostalCode: string | null;
  GuardianName: string | null;
  GuardianMobile: string | null;
  GuardianCountryCode: string | null;
  LinkedInUrl: string | null;
  GitHubUrl: string | null;
  ResumeObjectKey: string | null;
  ApprovalStatus: string;
  ApprovedByUserId: number | bigint | string | null;
  ApprovedAt: Date | string | null;
  RejectionReason: string | null;
  EnrolledCourseIds?: string | null;
}

const mapRowToStudent = (row: StudentRow): Student => {
  const userId = String(row.UserId);
  const isEmailVerified = Boolean(row.EmailVerified);
  const isMobileVerified = Boolean(row.MobileVerified);
  const rawApproval = (row.ApprovalStatus ?? "pending").toLowerCase();
  const adminApprovalStatus: AdminApprovalStatus =
    rawApproval === "approved" || rawApproval === "rejected" ? rawApproval : "pending";

  const rawGender = (row.Gender ?? "other").toLowerCase();
  const gender: Gender =
    rawGender === "male" || rawGender === "female" ? rawGender : "other";

  const degree = row.Degree?.trim() ?? "";
  const branch = row.Branch?.trim() ?? "";
  const degreeBranch = degree && branch ? `${degree} - ${branch}` : degree || branch || "Not Specified";

  const addressParts = [
    row.AddressLine1,
    row.AddressLine2,
    row.City,
    row.State,
    row.PostalCode,
    row.Country,
  ].filter((p): p is string => Boolean(p?.trim()));
  const fullAddress = addressParts.length > 0 ? addressParts.join(", ") : "Not Specified";

  const guardianParts = [row.GuardianName, row.GuardianCountryCode, row.GuardianMobile].filter(
    (p): p is string => Boolean(p?.trim()),
  );
  const guardianContact = guardianParts.length > 0 ? guardianParts.join(" ") : undefined;

  const enrolledCourseIds = row.EnrolledCourseIds
    ? row.EnrolledCourseIds.split(",").map((id) => id.trim()).filter(Boolean)
    : [];

  const rawStatus = (row.AccountStatus ?? "pending").toLowerCase();
  const status =
    rawStatus === "active" || rawStatus === "suspended" || rawStatus === "deactivated"
      ? rawStatus
      : "pending";

  const student: Student = {
    id: userId,
    name: row.FullName ?? "",
    email: row.Email ?? "",
    mobile: row.MobileNumber ?? "",
    role: "student",
    status,
    createdAt: row.UserCreatedAt instanceof Date ? row.UserCreatedAt.toISOString() : String(row.UserCreatedAt),
    collegeName: row.CollegeName ?? "Not Specified",
    degreeBranch,
    passingYear: row.PassingYear ? String(row.PassingYear) : "2024",
    courseInterestedIn: row.InterestedCourseId ? String(row.InterestedCourseId) : "General",
    dateOfBirth: row.DateOfBirth instanceof Date ? row.DateOfBirth.toISOString().split("T")[0]! : String(row.DateOfBirth ?? "2000-01-01"),
    gender,
    fullAddress,
    ...(guardianContact === undefined ? {} : { guardianContact }),
    ...(row.ResumeObjectKey ? { resumeUrl: row.ResumeObjectKey } : {}),
    ...(row.LinkedInUrl ? { linkedInUrl: row.LinkedInUrl } : {}),
    ...(row.GitHubUrl ? { githubUrl: row.GitHubUrl } : {}),
    isEmailVerified,
    isMobileVerified,
    adminApprovalStatus,
    ...(row.RejectionReason ? { adminApprovalRemarks: row.RejectionReason } : {}),
    ...(row.ApprovedAt
      ? {
          approvedAt:
            row.ApprovedAt instanceof Date
              ? row.ApprovedAt.toISOString()
              : String(row.ApprovedAt),
        }
      : {}),
    enrolledCourseIds,
  };

  const accountState = deriveAccountState(student);
  if (accountState !== undefined) {
    student.accountState = accountState;
  }
  return student;
};

const BASE_STUDENT_QUERY = `
  SELECT 
    u.UserId,
    u.FullName,
    u.Email,
    u.MobileNumber,
    u.AccountStatus,
    u.EmailVerified,
    u.MobileVerified,
    u.CreatedAt AS UserCreatedAt,
    p.CollegeName,
    p.Degree,
    p.Branch,
    p.PassingYear,
    p.InterestedCourseId,
    p.DateOfBirth,
    p.Gender,
    p.AddressLine1,
    p.AddressLine2,
    p.City,
    p.State,
    p.Country,
    p.PostalCode,
    p.GuardianName,
    p.GuardianMobile,
    p.GuardianCountryCode,
    p.LinkedInUrl,
    p.GitHubUrl,
    p.ResumeObjectKey,
    p.ApprovalStatus,
    p.ApprovedByUserId,
    p.ApprovedAt,
    p.RejectionReason,
    (
      -- Approved decision: derived from ACTIVE and COMPLETED enrollments only.
      -- Display data; it must never be used for authorization.
      SELECT STRING_AGG(CAST(e.CourseId AS VARCHAR(50)), ',')
      FROM dbo.NXA_Enrollments e
      WHERE e.StudentUserId = u.UserId
        AND UPPER(e.EnrollmentStatus) IN ('ACTIVE', 'COMPLETED')
    ) AS EnrolledCourseIds
  FROM dbo.NXA_Users u
  INNER JOIN dbo.NXA_StudentProfiles p ON p.UserId = u.UserId
`;

/**
 * Writes a student-management audit row on the change's own transaction (SEC
 * audit logs), so the change and its audit commit or roll back together.
 */
const writeStudentAudit = async (tx: sql.Transaction, audit: StudentAudit | undefined, studentId: string): Promise<void> => {
  if (!audit) return;
  await writeAuditLog(tx.request(), { ...audit, moduleCode: "STUDENT_MGMT", entityName: "Student", entityId: studentId });
};

export class SqlServerStudentRepository implements StudentRepository {
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

  async findById(id: EntityId): Promise<Student | null> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("id", sql.BigInt, id);

    const result = await req.query<StudentRow>(`
      ${BASE_STUDENT_QUERY}
      WHERE u.UserId = @id AND u.DeletedAt IS NULL
    `);

    if (result.recordset.length === 0 || !result.recordset[0]) {
      return null;
    }

    return mapRowToStudent(result.recordset[0]);
  }

  async findByEmail(email: string): Promise<Student | null> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("email", sql.NVarChar(254), email.trim().toLowerCase());

    const result = await req.query<StudentRow>(`
      ${BASE_STUDENT_QUERY}
      WHERE (u.NormalizedEmail = @email OR LOWER(u.Email) = @email) AND u.DeletedAt IS NULL
    `);

    if (result.recordset.length === 0 || !result.recordset[0]) {
      return null;
    }

    return mapRowToStudent(result.recordset[0]);
  }

  async existsByEmail(email: string): Promise<boolean> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("email", sql.NVarChar(254), email.trim().toLowerCase());

    const result = await req.query<{ cnt: number }>(`
      SELECT COUNT(1) AS cnt
      FROM dbo.NXA_Users u
      INNER JOIN dbo.NXA_StudentProfiles p ON p.UserId = u.UserId
      WHERE (u.NormalizedEmail = @email OR LOWER(u.Email) = @email) AND u.DeletedAt IS NULL
    `);

    return (result.recordset[0]?.cnt ?? 0) > 0;
  }

  async existsByMobile(mobile: string): Promise<boolean> {
    const pool = await this.getPool();
    const digits = mobile.replace(/[^0-9]/g, "");
    const req = pool.request();
    req.input("mobile", sql.VarChar(25), digits);

    const result = await req.query<{ cnt: number }>(`
      SELECT COUNT(1) AS cnt
      FROM dbo.NXA_Users u
      INNER JOIN dbo.NXA_StudentProfiles p ON p.UserId = u.UserId
      WHERE (u.NormalizedMobile = @mobile OR u.MobileNumber = @mobile) AND u.DeletedAt IS NULL
    `);

    return (result.recordset[0]?.cnt ?? 0) > 0;
  }

  async findMany(
    filter: StudentFilter,
    pagination: PaginationQuery,
    sort?: StudentSort,
  ): Promise<PaginatedResult<Student>> {
    const pool = await this.getPool();
    const req = pool.request();

    const conditions: string[] = ["u.DeletedAt IS NULL"];

    if (filter.status) {
      req.input("status", sql.VarChar(20), filter.status);
      conditions.push("u.AccountStatus = @status");
    }

    if (filter.approvalStatus) {
      req.input("approvalStatus", sql.VarChar(20), filter.approvalStatus);
      // Stored values are upper case (e.g. 'PENDING'); the API filter is lower
      // case. Compare case-insensitively rather than relying on DB collation.
      conditions.push("UPPER(p.ApprovalStatus) = UPPER(@approvalStatus)");
    }

    if (filter.passingYear) {
      const year = parseInt(filter.passingYear, 10);
      if (!Number.isNaN(year)) {
        req.input("passingYear", sql.SmallInt, year);
        conditions.push("p.PassingYear = @passingYear");
      }
    }

    if (filter.courseId) {
      req.input("courseId", sql.BigInt, filter.courseId);
      conditions.push(`
        EXISTS (
          SELECT 1 FROM dbo.NXA_Enrollments e 
          WHERE e.StudentUserId = u.UserId AND e.CourseId = @courseId
        )
      `);
    }

    if (filter.batchId) {
      req.input("batchId", sql.BigInt, filter.batchId);
      conditions.push(`
        EXISTS (
          SELECT 1 FROM dbo.NXA_Enrollments e 
          WHERE e.StudentUserId = u.UserId AND e.BatchId = @batchId
        )
      `);
    }

    if (filter.search && filter.search.trim() !== "") {
      req.input("search", sql.NVarChar(150), `%${filter.search.trim()}%`);
      conditions.push(`
        (u.FullName LIKE @search OR u.Email LIKE @search OR u.MobileNumber LIKE @search OR p.CollegeName LIKE @search)
      `);
    }

    const whereClause = conditions.join(" AND ");

    // Sorting
    const sortField = sort?.field ?? DEFAULT_STUDENT_SORT.field;
    const sortOrder = (sort?.order ?? DEFAULT_STUDENT_SORT.order).toUpperCase();
    const colMap: Record<string, string> = {
      name: "u.FullName",
      createdAt: "u.CreatedAt",
      passingYear: "p.PassingYear",
    };
    const orderByCol = colMap[sortField] ?? "u.CreatedAt";
    const orderClause = `ORDER BY ${orderByCol} ${sortOrder === "ASC" ? "ASC" : "DESC"}, u.UserId ASC`;

    // Count
    const countResult = await req.query<{ total: number }>(`
      SELECT COUNT(1) AS total
      FROM dbo.NXA_Users u
      INNER JOIN dbo.NXA_StudentProfiles p ON p.UserId = u.UserId
      WHERE ${whereClause}
    `);
    const total = countResult.recordset[0]?.total ?? 0;

    const page = Math.max(1, pagination.page);
    const pageSize = Math.max(1, pagination.pageSize);
    const offset = (page - 1) * pageSize;

    req.input("offset", sql.Int, offset);
    req.input("limit", sql.Int, pageSize);

    const rowsResult = await req.query<StudentRow>(`
      ${BASE_STUDENT_QUERY}
      WHERE ${whereClause}
      ${orderClause}
      OFFSET @offset ROWS
      FETCH NEXT @limit ROWS ONLY
    `);

    const items = rowsResult.recordset.map(mapRowToStudent);
    const totalPages = Math.ceil(total / pageSize);

    return {
      items,
      total,
      page,
      pageSize,
      totalPages,
    };
  }

  async create(input: CreateStudentInput): Promise<Student> {
    const pool = await this.getPool();
    const tx = pool.transaction();
    await tx.begin();

    try {
      const userReq = tx.request();
      userReq.input("name", sql.NVarChar(150), input.name.trim());
      const email = input.email.trim();
      userReq.input("email", sql.NVarChar(254), email);
      userReq.input("normEmail", sql.NVarChar(254), email.toLowerCase());
      const digits = input.mobile.replace(/[^0-9]/g, "");
      userReq.input("mobile", sql.VarChar(20), input.mobile.trim());
      userReq.input("normMobile", sql.VarChar(25), digits);

      const userInsert = await userReq.query<{ UserId: number | bigint }>(`
        INSERT INTO dbo.NXA_Users (
          FullName,
          Email,
          NormalizedEmail,
          MobileNumber,
          NormalizedMobile,
          PasswordHash,
          AccountStatus,
          CreatedAt
        )
        OUTPUT inserted.UserId
        VALUES (
          @name,
          @email,
          @normEmail,
          @mobile,
          @normMobile,
          '',
          'PENDING',
          SYSUTCDATETIME()
        )
      `);

      const userId = userInsert.recordset[0]?.UserId;
      if (!userId) {
        throw new Error("Failed to insert user record");
      }

      const profReq = tx.request();
      profReq.input("userId", sql.BigInt, userId);
      profReq.input("collegeName", sql.NVarChar(200), input.collegeName ?? null);
      profReq.input("degree", sql.NVarChar(100), input.degreeBranch ?? null);
      profReq.input("passingYear", sql.SmallInt, input.passingYear ? parseInt(input.passingYear, 10) : null);
      profReq.input("dateOfBirth", sql.Date, input.dateOfBirth ?? null);
      profReq.input("gender", sql.VarChar(30), input.gender ?? null);
      profReq.input("address1", sql.NVarChar(250), input.fullAddress ?? null);
      profReq.input("guardianContact", sql.VarChar(20), input.guardianContact ?? null);
      profReq.input("linkedInUrl", sql.NVarChar(500), input.linkedInUrl ?? null);
      profReq.input("githubUrl", sql.NVarChar(500), input.githubUrl ?? null);

      await profReq.query(`
        INSERT INTO dbo.NXA_StudentProfiles (
          UserId,
          CollegeName,
          Degree,
          PassingYear,
          DateOfBirth,
          Gender,
          AddressLine1,
          GuardianMobile,
          LinkedInUrl,
          GitHubUrl,
          ApprovalStatus,
          CreatedAt
        )
        VALUES (
          @userId,
          @collegeName,
          @degree,
          @passingYear,
          @dateOfBirth,
          @gender,
          @address1,
          @guardianContact,
          @linkedInUrl,
          @githubUrl,
          'PENDING',
          SYSUTCDATETIME()
        )
      `);

      await tx.commit();
      const created = await this.findById(String(userId));
      if (!created) {
        throw new Error("Failed to reload created student");
      }
      return created;
    } catch (err: unknown) {
      try {
        await tx.rollback();
      } catch {
        // ignore rollback errors
      }
      if (err instanceof Error && "number" in err) {
        const sqlNum = (err as { number: number }).number;
        if (sqlNum === 2601 || sqlNum === 2627) {
          throw new DuplicateRecordError("student", "email", input.email);
        }
      }
      throw err;
    }
  }

  async createForUser(userId: EntityId, profile: StudentProfileInput): Promise<Student> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("userId", sql.BigInt, userId);
    req.input("collegeName", sql.NVarChar(200), profile.collegeName ?? null);
    req.input("degree", sql.NVarChar(100), profile.degreeBranch ?? null);
    req.input("passingYear", sql.SmallInt, profile.passingYear ? parseInt(profile.passingYear, 10) : null);
    req.input("dateOfBirth", sql.Date, profile.dateOfBirth ?? null);
    req.input("gender", sql.VarChar(30), profile.gender ?? null);
    req.input("address1", sql.NVarChar(250), profile.fullAddress ?? null);
    req.input("guardianContact", sql.VarChar(20), profile.guardianContact ?? null);
    req.input("linkedInUrl", sql.NVarChar(500), profile.linkedInUrl ?? null);
    req.input("githubUrl", sql.NVarChar(500), profile.githubUrl ?? null);

    try {
      await req.query(`
        INSERT INTO dbo.NXA_StudentProfiles (
          UserId,
          CollegeName,
          Degree,
          PassingYear,
          DateOfBirth,
          Gender,
          AddressLine1,
          GuardianMobile,
          LinkedInUrl,
          GitHubUrl,
          ApprovalStatus,
          CreatedAt
        )
        VALUES (
          @userId,
          @collegeName,
          @degree,
          @passingYear,
          @dateOfBirth,
          @gender,
          @address1,
          @guardianContact,
          @linkedInUrl,
          @githubUrl,
          'PENDING',
          SYSUTCDATETIME()
        )
      `);

      const student = await this.findById(userId);
      if (!student) {
        throw new RecordNotFoundError("student", userId);
      }
      return student;
    } catch (err: unknown) {
      if (err instanceof Error && "number" in err) {
        const sqlNum = (err as { number: number }).number;
        if (sqlNum === 2601 || sqlNum === 2627) {
          throw new DuplicateRecordError("student", "userId", String(userId));
        }
      }
      throw err;
    }
  }

  async update(id: EntityId, input: UpdateStudentInput): Promise<Student> {
    const pool = await this.getPool();
    const existing = await this.findById(id);
    if (!existing) {
      throw new RecordNotFoundError("student", id);
    }

    const tx = pool.transaction();
    await tx.begin();

    try {
      // 1. User table updates if name/mobile changed
      if (input.name !== undefined || input.mobile !== undefined) {
        const userReq = tx.request();
        userReq.input("id", sql.BigInt, id);
        userReq.input("name", sql.NVarChar(150), (input.name ?? existing.name).trim());
        const mobile = (input.mobile ?? existing.mobile).trim();
        userReq.input("mobile", sql.VarChar(20), mobile);
        userReq.input("normMobile", sql.VarChar(25), mobile.replace(/[^0-9]/g, ""));

        await userReq.query(`
          UPDATE dbo.NXA_Users
          SET FullName = @name,
              MobileNumber = @mobile,
              NormalizedMobile = @normMobile,
              UpdatedAt = SYSUTCDATETIME()
          WHERE UserId = @id
        `);
      }

      // 2. StudentProfile table updates
      const profReq = tx.request();
      profReq.input("id", sql.BigInt, id);
      profReq.input("collegeName", sql.NVarChar(200), input.collegeName ?? existing.collegeName);
      profReq.input("degree", sql.NVarChar(100), input.degreeBranch ?? existing.degreeBranch);
      profReq.input(
        "passingYear",
        sql.SmallInt,
        input.passingYear ? parseInt(input.passingYear, 10) : parseInt(existing.passingYear, 10) || null,
      );
      profReq.input("address1", sql.NVarChar(250), input.fullAddress ?? existing.fullAddress);
      profReq.input("linkedInUrl", sql.NVarChar(500), input.linkedInUrl ?? existing.linkedInUrl ?? null);
      profReq.input("githubUrl", sql.NVarChar(500), input.githubUrl ?? existing.githubUrl ?? null);
      profReq.input("resumeUrl", sql.NVarChar(500), input.resumeUrl ?? existing.resumeUrl ?? null);

      await profReq.query(`
        UPDATE dbo.NXA_StudentProfiles
        SET CollegeName = @collegeName,
            Degree = @degree,
            PassingYear = @passingYear,
            AddressLine1 = @address1,
            LinkedInUrl = @linkedInUrl,
            GitHubUrl = @githubUrl,
            ResumeObjectKey = @resumeUrl,
            UpdatedAt = SYSUTCDATETIME()
        WHERE UserId = @id
      `);

      await tx.commit();
      const updated = await this.findById(id);
      if (!updated) {
        throw new RecordNotFoundError("student", id);
      }
      return updated;
    } catch (err) {
      try {
        await tx.rollback();
      } catch {
        // ignore
      }
      throw err;
    }
  }

  async setStatus(id: EntityId, status: AdminSettableStudentStatus, audit?: StudentAudit): Promise<Student> {
    const pool = await this.getPool();
    const tx = pool.transaction();
    await tx.begin();
    try {
      const req = tx.request();
      req.input("id", sql.BigInt, id);
      req.input("status", sql.VarChar(20), status);

      // Only a real change updates the row; the same status is not audited.
      const result = await req.query(`
        UPDATE dbo.NXA_Users
        SET AccountStatus = @status,
            UpdatedAt = SYSUTCDATETIME()
        WHERE UserId = @id AND DeletedAt IS NULL AND LOWER(ISNULL(AccountStatus, '')) <> LOWER(@status)
      `);

      if ((result.rowsAffected[0] ?? 0) === 0) {
        const exists = await tx
          .request()
          .input("id", sql.BigInt, id)
          .query(`SELECT UserId FROM dbo.NXA_Users WHERE UserId = @id AND DeletedAt IS NULL`);
        if (exists.recordset.length === 0) throw new RecordNotFoundError("student", id);
      } else {
        await writeStudentAudit(tx, audit, String(id));
      }
      await tx.commit();
    } catch (err) {
      try {
        await tx.rollback();
      } catch {
        // ignore
      }
      throw err;
    }

    const updated = await this.findById(id);
    if (!updated) {
      throw new RecordNotFoundError("student", id);
    }
    return updated;
  }

  async recordApprovalDecision(id: EntityId, decision: ApprovalDecision, audit?: StudentAudit): Promise<Student> {
    const pool = await this.getPool();
    const tx = pool.transaction();
    await tx.begin();
    try {
      const req = tx.request();
      req.input("id", sql.BigInt, id);
      req.input("status", sql.VarChar(20), decision.status);
      req.input("decidedBy", sql.BigInt, decision.decidedByUserId);
      req.input("remarks", sql.NVarChar(500), decision.remarks ?? null);

      const result = await req.query(`
        UPDATE dbo.NXA_StudentProfiles
        SET ApprovalStatus = @status,
            ApprovedByUserId = @decidedBy,
            ApprovedAt = SYSUTCDATETIME(),
            RejectionReason = @remarks,
            UpdatedAt = SYSUTCDATETIME()
        WHERE UserId = @id
      `);

      if ((result.rowsAffected[0] ?? 0) === 0) {
        throw new RecordNotFoundError("student", id);
      }
      await writeStudentAudit(tx, audit, String(id));
      await tx.commit();
    } catch (err) {
      try {
        await tx.rollback();
      } catch {
        // ignore
      }
      throw err;
    }

    const updated = await this.findById(id);
    if (!updated) {
      throw new RecordNotFoundError("student", id);
    }
    return updated;
  }

  async markVerified(id: EntityId, channel: "email" | "mobile"): Promise<Student> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("id", sql.BigInt, id);

    const col = channel === "email" ? "EmailVerified" : "MobileVerified";
    const result = await req.query(`
      UPDATE dbo.NXA_Users
      SET ${col} = 1,
          UpdatedAt = SYSUTCDATETIME()
      WHERE UserId = @id AND DeletedAt IS NULL
    `);

    if (result.rowsAffected[0] === 0) {
      throw new RecordNotFoundError("student", id);
    }

    const updated = await this.findById(id);
    if (!updated) {
      throw new RecordNotFoundError("student", id);
    }
    return updated;
  }

  async clearLockout(id: EntityId): Promise<Student> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("id", sql.BigInt, id);

    const result = await req.query(`
      UPDATE dbo.NXA_Users
      SET FailedLoginAttempts = 0,
          IsLocked = 0,
          LockoutUntil = NULL,
          UpdatedAt = SYSUTCDATETIME()
      WHERE UserId = @id AND DeletedAt IS NULL
    `);

    if (result.rowsAffected[0] === 0) {
      throw new RecordNotFoundError("student", id);
    }

    const updated = await this.findById(id);
    if (!updated) {
      throw new RecordNotFoundError("student", id);
    }
    return updated;
  }
}
