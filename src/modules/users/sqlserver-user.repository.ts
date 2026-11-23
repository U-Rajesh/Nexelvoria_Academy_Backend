import sql from "mssql";

import type { PaginatedResult, PaginationQuery } from "../../contracts/api.contract";
import type { EntityId } from "../../contracts/identifier.contract";
import type { UserRole, UserStatus } from "../../contracts/user.contract";
import type { UserRepository } from "./user.repository";
import type {
  CreateUserInput,
  UpdateUserInput,
  User,
  UserFilter,
} from "./user.types";
import {
  DuplicateRecordError,
  RecordNotFoundError,
  RepositoryError,
} from "../../repositories/repository.errors";
import { getSqlServerPool } from "../../db/sqlserver.pool";

export class SqlUserRepositoryError extends RepositoryError {
  override readonly cause: unknown;

  constructor(operation: string, cause: unknown) {
    super(`SQL Server operation failed: ${operation} on user`);
    this.cause = cause;
  }
}

interface RawUserRow {
  UserId: number | bigint;
  PublicUserId: string;
  FullName: string;
  Email: string | null;
  NormalizedEmail: string | null;
  MobileNumber: string | null;
  NormalizedMobile: string | null;
  AccountStatus: string;
  RoleCode: string | null;
  CreatedAt: Date;
}

const mapRowToUser = (row: RawUserRow): User => {
  const roleCode = (row.RoleCode || "").toLowerCase();
  let role: UserRole = "student";
  if (roleCode === "admin") role = "admin";
  else if (roleCode === "super_admin" || roleCode === "superadmin") role = "super_admin";
  else if (roleCode === "teacher") role = "teacher";
  else if (roleCode === "public") role = "public";

  const statusRaw = (row.AccountStatus || "").toLowerCase();
  let status: UserStatus = "pending";
  if (statusRaw === "active") status = "active";
  else if (statusRaw === "suspended") status = "suspended";
  else if (statusRaw === "deactivated") status = "deactivated";

  return {
    id: String(row.UserId),
    name: row.FullName,
    email: row.Email || "",
    mobile: row.MobileNumber || "",
    role,
    status,
    createdAt: row.CreatedAt.toISOString(),
  };
};

export class SqlServerUserRepository implements UserRepository {
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

  async findById(id: EntityId): Promise<User | null> {
    try {
      const pool = await this.getPool();
      const req = pool.request();

      const isNumeric = /^[0-9]+$/.test(id);
      req.input("idParam", sql.NVarChar(100), id);

      const query = `
        SELECT TOP 1
          u.UserId,
          u.PublicUserId,
          u.FullName,
          u.Email,
          u.NormalizedEmail,
          u.MobileNumber,
          u.NormalizedMobile,
          u.AccountStatus,
          u.CreatedAt,
          r.RoleCode
        FROM dbo.NXA_Users u
        LEFT JOIN dbo.NXA_UserRoles ur ON ur.UserId = u.UserId
        LEFT JOIN dbo.NXA_Roles r ON r.RoleId = ur.RoleId
        WHERE (
          ${isNumeric ? "u.UserId = CAST(@idParam AS BIGINT)" : "CAST(u.PublicUserId AS NVARCHAR(100)) = @idParam"}
        )
        AND u.DeletedAt IS NULL
      `;

      const result = await req.query<RawUserRow>(query);
      if (result.recordset.length === 0 || !result.recordset[0]) {
        return null;
      }

      return mapRowToUser(result.recordset[0]);
    } catch (err) {
      throw new SqlUserRepositoryError("findById", err);
    }
  }

  async findByEmail(email: string): Promise<User | null> {
    try {
      const pool = await this.getPool();
      const req = pool.request();
      const normalizedEmail = email.trim().toLowerCase();
      req.input("normalizedEmail", sql.NVarChar(254), normalizedEmail);

      const query = `
        SELECT TOP 1
          u.UserId,
          u.PublicUserId,
          u.FullName,
          u.Email,
          u.NormalizedEmail,
          u.MobileNumber,
          u.NormalizedMobile,
          u.AccountStatus,
          u.CreatedAt,
          r.RoleCode
        FROM dbo.NXA_Users u
        LEFT JOIN dbo.NXA_UserRoles ur ON ur.UserId = u.UserId
        LEFT JOIN dbo.NXA_Roles r ON r.RoleId = ur.RoleId
        WHERE (u.NormalizedEmail = @normalizedEmail OR LOWER(u.Email) = @normalizedEmail)
          AND u.DeletedAt IS NULL
      `;

      const result = await req.query<RawUserRow>(query);
      if (result.recordset.length === 0 || !result.recordset[0]) {
        return null;
      }

      return mapRowToUser(result.recordset[0]);
    } catch (err) {
      throw new SqlUserRepositoryError("findByEmail", err);
    }
  }

  async findByMobile(mobile: string): Promise<User | null> {
    try {
      const pool = await this.getPool();
      const req = pool.request();
      const cleanMobile = mobile.trim();
      req.input("mobile", sql.VarChar(25), cleanMobile);

      const query = `
        SELECT TOP 1
          u.UserId,
          u.PublicUserId,
          u.FullName,
          u.Email,
          u.NormalizedEmail,
          u.MobileNumber,
          u.NormalizedMobile,
          u.AccountStatus,
          u.CreatedAt,
          r.RoleCode
        FROM dbo.NXA_Users u
        LEFT JOIN dbo.NXA_UserRoles ur ON ur.UserId = u.UserId
        LEFT JOIN dbo.NXA_Roles r ON r.RoleId = ur.RoleId
        WHERE (u.MobileNumber = @mobile OR u.NormalizedMobile = @mobile OR u.NormalizedMobile LIKE '%' + @mobile)
          AND u.DeletedAt IS NULL
      `;

      const result = await req.query<RawUserRow>(query);
      if (result.recordset.length === 0 || !result.recordset[0]) {
        return null;
      }

      return mapRowToUser(result.recordset[0]);
    } catch (err) {
      throw new SqlUserRepositoryError("findByMobile", err);
    }
  }

  async existsByEmail(email: string): Promise<boolean> {
    try {
      const pool = await this.getPool();
      const req = pool.request();
      const normalizedEmail = email.trim().toLowerCase();
      req.input("normalizedEmail", sql.NVarChar(254), normalizedEmail);

      const result = await req.query<{ Found: number }>(`
        SELECT TOP 1 1 AS Found
        FROM dbo.NXA_Users
        WHERE (NormalizedEmail = @normalizedEmail OR LOWER(Email) = @normalizedEmail)
          AND DeletedAt IS NULL
      `);

      return result.recordset.length > 0;
    } catch (err) {
      throw new SqlUserRepositoryError("existsByEmail", err);
    }
  }

  async existsByMobile(mobile: string): Promise<boolean> {
    try {
      const pool = await this.getPool();
      const req = pool.request();
      const cleanMobile = mobile.trim();
      req.input("mobile", sql.VarChar(25), cleanMobile);

      const result = await req.query<{ Found: number }>(`
        SELECT TOP 1 1 AS Found
        FROM dbo.NXA_Users
        WHERE (MobileNumber = @mobile OR NormalizedMobile = @mobile OR NormalizedMobile LIKE '%' + @mobile)
          AND DeletedAt IS NULL
      `);

      return result.recordset.length > 0;
    } catch (err) {
      throw new SqlUserRepositoryError("existsByMobile", err);
    }
  }

  async findMany(
    filter: UserFilter,
    pagination: PaginationQuery,
  ): Promise<PaginatedResult<User>> {
    try {
      const pool = await this.getPool();
      const req = pool.request();

      const page = Math.max(1, pagination.page ?? 1);
      const pageSize = Math.max(1, Math.min(100, pagination.pageSize ?? 20));
      const offset = (page - 1) * pageSize;

      req.input("offset", sql.Int, offset);
      req.input("pageSize", sql.Int, pageSize);

      const conditions: string[] = ["u.DeletedAt IS NULL"];

      if (filter.role !== undefined) {
        req.input("roleCode", sql.VarChar(40), filter.role);
        conditions.push("LOWER(r.RoleCode) = LOWER(@roleCode)");
      }

      if (filter.status !== undefined) {
        req.input("accountStatus", sql.VarChar(20), filter.status);
        conditions.push("LOWER(u.AccountStatus) = LOWER(@accountStatus)");
      }

      if (filter.search !== undefined && filter.search.trim() !== "") {
        req.input("search", sql.NVarChar(150), `%${filter.search.trim()}%`);
        conditions.push(
          "(u.FullName LIKE @search OR u.Email LIKE @search OR u.MobileNumber LIKE @search)",
        );
      }

      const whereClause = conditions.join(" AND ");

      const countResult = await req.query<{ Total: number }>(`
        SELECT COUNT(DISTINCT u.UserId) AS Total
        FROM dbo.NXA_Users u
        LEFT JOIN dbo.NXA_UserRoles ur ON ur.UserId = u.UserId
        LEFT JOIN dbo.NXA_Roles r ON r.RoleId = ur.RoleId
        WHERE ${whereClause}
      `);

      const total = countResult.recordset[0]?.Total ?? 0;

      const dataResult = await req.query<RawUserRow>(`
        SELECT
          u.UserId,
          u.PublicUserId,
          u.FullName,
          u.Email,
          u.NormalizedEmail,
          u.MobileNumber,
          u.NormalizedMobile,
          u.AccountStatus,
          u.CreatedAt,
          r.RoleCode
        FROM dbo.NXA_Users u
        LEFT JOIN dbo.NXA_UserRoles ur ON ur.UserId = u.UserId
        LEFT JOIN dbo.NXA_Roles r ON r.RoleId = ur.RoleId
        WHERE ${whereClause}
        ORDER BY u.CreatedAt DESC
        OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
      `);

      const items = dataResult.recordset.map(mapRowToUser);

      return {
        items,
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      };
    } catch (err) {
      throw new SqlUserRepositoryError("findMany", err);
    }
  }

  async create(input: CreateUserInput): Promise<User> {
    try {
      const pool = await this.getPool();
      const req = pool.request();

      const email = input.email.trim();
      const normalizedEmail = email.toLowerCase();
      const mobile = input.mobile.trim();

      req.input("fullName", sql.NVarChar(150), input.name.trim());
      req.input("email", sql.NVarChar(254), email);
      req.input("normalizedEmail", sql.NVarChar(254), normalizedEmail);
      req.input("mobileNumber", sql.VarChar(20), mobile);
      req.input("normalizedMobile", sql.VarChar(25), mobile);
      req.input("accountStatus", sql.VarChar(20), input.status);

      const result = await req.query<RawUserRow>(`
        INSERT INTO dbo.NXA_Users (
          FullName,
          Email,
          NormalizedEmail,
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
        OUTPUT inserted.UserId, inserted.PublicUserId, inserted.FullName, inserted.Email,
               inserted.NormalizedEmail, inserted.MobileNumber, inserted.NormalizedMobile,
               inserted.AccountStatus, inserted.CreatedAt
        VALUES (
          @fullName,
          @email,
          @normalizedEmail,
          @mobileNumber,
          @normalizedMobile,
          '',
          @accountStatus,
          0,
          0,
          0,
          0,
          0,
          SYSUTCDATETIME()
        )
      `);

      const row = result.recordset[0];
      if (!row) {
        throw new SqlUserRepositoryError("create", new Error("No row returned from insert"));
      }

      return mapRowToUser({ ...row, RoleCode: input.role });
    } catch (err: unknown) {
      const sqlErr = err as { number?: number; message?: string };
      if (sqlErr.number === 2601 || sqlErr.number === 2627) {
        const msg = (sqlErr.message || "").toLowerCase();
        if (msg.includes("email")) {
          throw new DuplicateRecordError("user", "email", input.email);
        }
        if (msg.includes("mobile")) {
          throw new DuplicateRecordError("user", "mobile", input.mobile);
        }
        throw new DuplicateRecordError("user", "record", input.email);
      }
      throw new SqlUserRepositoryError("create", err);
    }
  }

  async update(id: EntityId, input: UpdateUserInput): Promise<User> {
    try {
      const existing = await this.findById(id);
      if (existing === null) {
        throw new RecordNotFoundError("user", id);
      }

      const pool = await this.getPool();
      const req = pool.request();

      const isNumeric = /^[0-9]+$/.test(id);
      req.input("idParam", sql.NVarChar(100), id);
      req.input("fullName", sql.NVarChar(150), input.name !== undefined ? input.name.trim() : existing.name);
      req.input("mobileNumber", sql.VarChar(20), input.mobile !== undefined ? input.mobile.trim() : existing.mobile);

      const query = `
        UPDATE dbo.NXA_Users
           SET FullName = @fullName,
               MobileNumber = @mobileNumber,
               UpdatedAt = SYSUTCDATETIME()
         WHERE (
           ${isNumeric ? "UserId = CAST(@idParam AS BIGINT)" : "CAST(PublicUserId AS NVARCHAR(100)) = @idParam"}
         )
         AND DeletedAt IS NULL;
      `;

      await req.query(query);

      return (await this.findById(id))!;
    } catch (err) {
      if (err instanceof RecordNotFoundError) throw err;
      throw new SqlUserRepositoryError("update", err);
    }
  }

  async setStatus(id: EntityId, status: UserStatus): Promise<User> {
    try {
      const pool = await this.getPool();
      const req = pool.request();

      const isNumeric = /^[0-9]+$/.test(id);
      req.input("idParam", sql.NVarChar(100), id);
      req.input("accountStatus", sql.VarChar(20), status);

      const query = `
        UPDATE dbo.NXA_Users
           SET AccountStatus = @accountStatus,
               UpdatedAt = SYSUTCDATETIME()
         WHERE (
           ${isNumeric ? "UserId = CAST(@idParam AS BIGINT)" : "CAST(PublicUserId AS NVARCHAR(100)) = @idParam"}
         )
         AND DeletedAt IS NULL;
      `;

      const result = await req.query(query);
      if (result.rowsAffected[0] === 0) {
        throw new RecordNotFoundError("user", id);
      }

      const updated = await this.findById(id);
      if (updated === null) {
        throw new RecordNotFoundError("user", id);
      }

      return updated;
    } catch (err) {
      if (err instanceof RecordNotFoundError) throw err;
      throw new SqlUserRepositoryError("setStatus", err);
    }
  }
}
