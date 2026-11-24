import sql from "mssql";
import { randomUUID } from "node:crypto";

import {
  RegistrationRejectedError,
  type StudentRegistrationInput,
  type StudentRegistrationRecord,
  type StudentRegistrationRepository,
} from "./registration.repository";
import {
  DuplicateRecordError,
  RepositoryError,
} from "../../repositories/repository.errors";
import { getSqlServerPool } from "../../db/sqlserver.pool";
import { logger } from "../../utils/logger";

const LOOSE_EMAIL = /^.+@.+\..+$/;
const DIGITS_ONLY = /^[0-9]+$/;
const MOBILE_MIN_LENGTH = 6;
const MOBILE_MAX_LENGTH = 15;

export class SqlRepositoryError extends RepositoryError {
  override readonly cause: unknown;

  constructor(
    readonly entity: string,
    readonly operation: string,
    cause: unknown,
  ) {
    super(`SQL Server operation failed: ${operation} on ${entity}`);
    this.cause = cause;
  }
}

export interface SqlServerRegistrationOptions {
  countryCode?: string | undefined;
  transactionFactory?: ((pool: sql.ConnectionPool) => sql.Transaction) | undefined;
}

/**
 * Microsoft SQL Server 2025 adapter for `StudentRegistrationRepository`.
 *
 * Implements the atomic student self-registration write:
 * 1. Validates mandatory caller fields and business rules.
 * 2. Begins an atomic SQL Server transaction (`sql.Transaction`).
 * 3. Checks for duplicate email/mobile using UPDLOCK/HOLDLOCK on `dbo.NXA_Users`.
 * 4. Inserts the user record into `dbo.NXA_Users` with Argon2id password hash.
 * 5. Inserts the admissions profile into `dbo.NXA_StudentProfiles`.
 * 6. Maps the student role in `dbo.NXA_UserRoles` if the role exists in `dbo.NXA_Roles`.
 * 7. Commits the transaction or rolls back on any error.
 * 8. Maps SQL unique constraint violations (2601 / 2627) to `DuplicateRecordError`.
 */
export class SqlServerStudentRegistrationRepository
  implements StudentRegistrationRepository
{
  private readonly countryCode: string;
  private readonly transactionFactory?: ((pool: sql.ConnectionPool) => sql.Transaction) | undefined;

  constructor(
    private readonly poolOrFactory:
      | sql.ConnectionPool
      | (() => Promise<sql.ConnectionPool>) = getSqlServerPool,
    options: SqlServerRegistrationOptions = {},
  ) {
    this.countryCode = options.countryCode ?? "+91";
    this.transactionFactory = options.transactionFactory;
  }

  private async getPool(): Promise<sql.ConnectionPool> {
    return typeof this.poolOrFactory === "function"
      ? await this.poolOrFactory()
      : this.poolOrFactory;
  }

  async register(
    input: StudentRegistrationInput,
  ): Promise<StudentRegistrationRecord> {
    const name = input.name.trim();
    const email = input.email.trim();
    const mobile = input.mobile.trim();
    const passwordHash = input.passwordHash.trim();

    // 1. Mandatory values check - caller defects throw plain Error, not RepositoryError
    if (name === "" || email === "" || mobile === "" || passwordHash === "") {
      throw new Error(
        "StudentRegistrationRepository.register: name, email, mobile and passwordHash are " +
          "all mandatory. An empty value here is a caller defect - registrationSchema has " +
          "already guaranteed every one of them is present.",
      );
    }

    // 2. Business validation in the datastore's own order
    if (!LOOSE_EMAIL.test(email)) {
      throw new RegistrationRejectedError(
        [{ field: "email", message: "Invalid email address." }],
        "INVALID_EMAIL",
        randomUUID(),
      );
    }

    if (
      !DIGITS_ONLY.test(mobile) ||
      mobile.length < MOBILE_MIN_LENGTH ||
      mobile.length > MOBILE_MAX_LENGTH
    ) {
      throw new RegistrationRejectedError(
        [{ field: "mobile", message: "Invalid mobile number." }],
        "INVALID_MOBILE",
        randomUUID(),
      );
    }

    const normalizedEmail = email.toLowerCase();
    const normalizedMobile = `${this.countryCode}${mobile}`;

    const pool = await this.getPool();
    const tx = this.transactionFactory ? this.transactionFactory(pool) : new sql.Transaction(pool);
    await tx.begin();

    const createReq = (): sql.Request =>
      typeof (tx as { request?: () => sql.Request }).request === "function"
        ? (tx as { request: () => sql.Request }).request()
        : new sql.Request(tx);

    try {
      // 3. Pre-check uniqueness inside transaction with lock protection
      const checkReq = createReq();
      checkReq.input("normalizedEmail", sql.NVarChar(254), normalizedEmail);
      checkReq.input("normalizedMobile", sql.VarChar(25), normalizedMobile);

      const existing = await checkReq.query<{
        NormalizedEmail: string | null;
        NormalizedMobile: string | null;
      }>(`
        SELECT TOP 1 NormalizedEmail, NormalizedMobile
        FROM dbo.NXA_Users WITH (UPDLOCK, HOLDLOCK)
        WHERE NormalizedEmail = @normalizedEmail OR NormalizedMobile = @normalizedMobile
      `);

      if (existing.recordset.length > 0) {
        const found = existing.recordset[0];
        if (
          found &&
          found.NormalizedEmail &&
          found.NormalizedEmail.toLowerCase() === normalizedEmail
        ) {
          throw new DuplicateRecordError("user", "email", email);
        }
        if (found && found.NormalizedMobile === normalizedMobile) {
          throw new DuplicateRecordError("user", "mobile", mobile);
        }
        throw new DuplicateRecordError("user", "record", email);
      }

      // 4. Parameterized Insert into dbo.NXA_Users
      const userReq = createReq();
      userReq.input("fullName", sql.NVarChar(150), name);
      userReq.input("email", sql.NVarChar(254), email);
      userReq.input("normalizedEmail", sql.NVarChar(254), normalizedEmail);
      userReq.input("countryCode", sql.VarChar(8), this.countryCode);
      userReq.input("mobileNumber", sql.VarChar(20), mobile);
      userReq.input("normalizedMobile", sql.VarChar(25), normalizedMobile);
      userReq.input("passwordHash", sql.NVarChar(500), passwordHash);

      const userInsert = await userReq.query<{
        UserId: number | bigint | string;
        PublicUserId: string;
      }>(`
        INSERT INTO dbo.NXA_Users (
          FullName,
          Email,
          NormalizedEmail,
          CountryCode,
          MobileNumber,
          NormalizedMobile,
          PasswordHash,
          AccountStatus,
          EmailVerified,
          MobileVerified,
          TwoFactorEnabled,
          IsLocked,
          FailedLoginAttempts,
          CreatedAt
        )
        OUTPUT inserted.UserId, inserted.PublicUserId
        VALUES (
          @fullName,
          @email,
          @normalizedEmail,
          @countryCode,
          @mobileNumber,
          @normalizedMobile,
          @passwordHash,
          'pending',
          0,
          0,
          0,
          0,
          0,
          SYSUTCDATETIME()
        )
      `);

      const userRow = userInsert.recordset[0];
      const userId = userRow?.UserId;
      const publicUserId = userRow?.PublicUserId;

      if (userId === undefined || userId === null) {
        throw new SqlRepositoryError(
          "user",
          "insert",
          new Error("NXA_Users insert did not return UserId"),
        );
      }

      // 5. Parse admissions profile values
      const p = input.profile;
      const [degreePart, ...branchParts] = (p.degreeBranch || "").trim().split(" ");
      const degree = (degreePart || p.degreeBranch || "").slice(0, 100);
      const branch = (branchParts.length > 0 ? branchParts.join(" ") : p.degreeBranch || "").slice(0, 100);
      const passingYear = p.passingYear ? Number.parseInt(p.passingYear, 10) : null;
      const dob = p.dateOfBirth && !Number.isNaN(new Date(p.dateOfBirth).getTime())
        ? new Date(p.dateOfBirth)
        : null;

      // 6. Parameterized Insert into dbo.NXA_StudentProfiles
      const profileReq = createReq();
      profileReq.input("userId", sql.BigInt, userId);
      profileReq.input("collegeName", sql.NVarChar(200), (p.collegeName || "").slice(0, 200));
      profileReq.input("degree", sql.NVarChar(100), degree || null);
      profileReq.input("branch", sql.NVarChar(100), branch || null);
      profileReq.input("passingYear", sql.SmallInt, Number.isNaN(passingYear) ? null : passingYear);
      profileReq.input("dateOfBirth", sql.Date, dob);
      profileReq.input("gender", sql.VarChar(30), p.gender || null);
      profileReq.input("addressLine1", sql.NVarChar(250), (p.fullAddress || "").slice(0, 250));
      profileReq.input("guardianCountryCode", sql.VarChar(8), p.guardianContact ? this.countryCode : null);
      profileReq.input("guardianMobile", sql.VarChar(20), p.guardianContact ? p.guardianContact.slice(0, 20) : null);
      profileReq.input("resumeObjectKey", sql.NVarChar(500), p.resumeFileName ? p.resumeFileName.slice(0, 500) : null);
      profileReq.input("linkedInUrl", sql.NVarChar(500), p.linkedInUrl ? p.linkedInUrl.slice(0, 500) : null);
      profileReq.input("githubUrl", sql.NVarChar(500), p.githubUrl ? p.githubUrl.slice(0, 500) : null);

      const profileInsert = await profileReq.query<{
        StudentProfileId: number | bigint | string;
      }>(`
        INSERT INTO dbo.NXA_StudentProfiles (
          UserId,
          CollegeName,
          Degree,
          Branch,
          PassingYear,
          DateOfBirth,
          Gender,
          AddressLine1,
          GuardianCountryCode,
          GuardianMobile,
          ResumeObjectKey,
          LinkedInUrl,
          GitHubUrl,
          ApprovalStatus,
          CreatedAt
        )
        OUTPUT inserted.StudentProfileId
        VALUES (
          @userId,
          @collegeName,
          @degree,
          @branch,
          @passingYear,
          @dateOfBirth,
          @gender,
          @addressLine1,
          @guardianCountryCode,
          @guardianMobile,
          @resumeObjectKey,
          @linkedInUrl,
          @githubUrl,
          'pending',
          SYSUTCDATETIME()
        )
      `);

      const studentProfileId = profileInsert.recordset[0]?.StudentProfileId;

      // 7. Look up active Student role from dbo.NXA_Roles
      const roleReq = createReq();
      roleReq.input("roleCode", sql.VarChar(40), "student");
      const roleLookup = await roleReq.query<{ RoleId: number }>(`
        SELECT RoleId FROM dbo.NXA_Roles WHERE RoleCode = @roleCode AND IsActive = 1
      `);

      if (roleLookup.recordset.length === 0 || !roleLookup.recordset[0]) {
        throw new SqlRepositoryError(
          "role",
          "lookup",
          new Error("Active Student role ('student') is not configured in dbo.NXA_Roles. Registration aborted and rolled back."),
        );
      }

      const studentRoleId = roleLookup.recordset[0].RoleId;
      const assignRoleReq = createReq();
      assignRoleReq.input("userId", sql.BigInt, userId);
      assignRoleReq.input("roleId", sql.Int, studentRoleId);
      await assignRoleReq.query(`
        INSERT INTO dbo.NXA_UserRoles (UserId, RoleId, AssignedAt)
        VALUES (@userId, @roleId, SYSUTCDATETIME())
      `);

      await tx.commit();

      const referenceId = publicUserId ? String(publicUserId) : randomUUID();

      return {
        userId: String(userId),
        studentProfileId: String(studentProfileId ?? `profile-${String(userId)}`),
        email,
        countryCode: this.countryCode,
        mobileNumber: mobile,
        status: "pending",
        adminApprovalStatus: "pending",
        isEmailVerified: false,
        isMobileVerified: false,
        referenceId,
      };
    } catch (err: unknown) {
      try {
        await tx.rollback();
      } catch (rollbackErr) {
        logger.warn("Transaction rollback skipped or already handled", {
          error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
        });
      }

      if (
        err instanceof DuplicateRecordError ||
        err instanceof RegistrationRejectedError ||
        err instanceof SqlRepositoryError
      ) {
        throw err;
      }

      // Map SQL Server unique constraint violations (2601 / 2627)
      const sqlErr = err as { number?: number; message?: string };
      if (sqlErr.number === 2601 || sqlErr.number === 2627) {
        const msg = (sqlErr.message || "").toLowerCase();
        if (msg.includes("email") || msg.includes("ux_nxa_users_normalizedemail")) {
          throw new DuplicateRecordError("user", "email", email);
        }
        if (msg.includes("mobile") || msg.includes("ux_nxa_users_normalizedmobile")) {
          throw new DuplicateRecordError("user", "mobile", mobile);
        }
        throw new DuplicateRecordError("user", "record", email);
      }

      throw new SqlRepositoryError("studentRegistration", "register", err);
    }
  }
}
