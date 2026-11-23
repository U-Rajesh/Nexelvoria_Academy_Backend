import sql from "mssql";

import type { EntityId } from "../../contracts/identifier.contract";
import type { CredentialRepository } from "./credential.repository";
import type {
  ChangePasswordInput,
  ConditionalResetInput,
  ConditionalResetResult,
  CreateCredentialInput,
  CredentialLockoutState,
  CredentialRecord,
  RecordFailedAttemptInput,
  RehashPasswordInput,
  ResetPasswordInput,
} from "./credential.types";
import { isCredentialLocked, toLockoutState } from "./credential.types";
import {
  OptimisticLockError,
  RecordNotFoundError,
  RepositoryError,
} from "../../repositories/repository.errors";
import { getSqlServerPool } from "../../db/sqlserver.pool";

export class SqlCredentialRepositoryError extends RepositoryError {
  override readonly cause: unknown;

  constructor(operation: string, cause: unknown) {
    super(`SQL Server operation failed: ${operation} on credential`);
    this.cause = cause;
  }
}

interface RawCredentialRow {
  UserId: number | bigint;
  PasswordHash: string;
  FailedLoginAttempts: number;
  IsLocked: boolean;
  LockoutUntil: Date | null;
  UpdatedAt: Date | null;
  CreatedAt: Date;
}

const mapRowToCredential = (row: RawCredentialRow): CredentialRecord => {
  const updated = row.UpdatedAt ? row.UpdatedAt.toISOString() : row.CreatedAt.toISOString();

  return {
    userId: String(row.UserId),
    passwordHash: row.PasswordHash,
    passwordUpdatedAt: updated,
    failedLoginAttempts: row.FailedLoginAttempts ?? 0,
    ...(row.LockoutUntil ? { lockedUntil: row.LockoutUntil.toISOString() } : {}),
    createdAt: row.CreatedAt.toISOString(),
    updatedAt: updated,
  };
};

export class SqlServerCredentialRepository implements CredentialRepository {
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

  async findByUserId(userId: EntityId): Promise<CredentialRecord | null> {
    try {
      const pool = await this.getPool();
      const req = pool.request();

      const isNumeric = /^[0-9]+$/.test(userId);
      req.input("idParam", sql.NVarChar(100), userId);

      const query = `
        SELECT TOP 1
          UserId,
          PasswordHash,
          FailedLoginAttempts,
          IsLocked,
          LockoutUntil,
          UpdatedAt,
          CreatedAt
        FROM dbo.NXA_Users
        WHERE (
          ${isNumeric ? "UserId = CAST(@idParam AS BIGINT)" : "CAST(PublicUserId AS NVARCHAR(100)) = @idParam"}
        )
        AND DeletedAt IS NULL
      `;

      const result = await req.query<RawCredentialRow>(query);
      if (result.recordset.length === 0 || !result.recordset[0]) {
        return null;
      }

      return mapRowToCredential(result.recordset[0]);
    } catch (err) {
      throw new SqlCredentialRepositoryError("findByUserId", err);
    }
  }

  async create(input: CreateCredentialInput): Promise<CredentialRecord> {
    try {
      const pool = await this.getPool();
      const req = pool.request();

      const isNumeric = /^[0-9]+$/.test(input.userId);
      req.input("idParam", sql.NVarChar(100), input.userId);
      req.input("passwordHash", sql.NVarChar(500), input.passwordHash);

      const query = `
        UPDATE dbo.NXA_Users
           SET PasswordHash = @passwordHash,
               UpdatedAt = SYSUTCDATETIME()
        OUTPUT inserted.UserId, inserted.PasswordHash, inserted.FailedLoginAttempts,
               inserted.IsLocked, inserted.LockoutUntil, inserted.UpdatedAt, inserted.CreatedAt
         WHERE (
           ${isNumeric ? "UserId = CAST(@idParam AS BIGINT)" : "CAST(PublicUserId AS NVARCHAR(100)) = @idParam"}
         )
         AND DeletedAt IS NULL;
      `;

      const result = await req.query<RawCredentialRow>(query);
      if (result.recordset.length === 0 || !result.recordset[0]) {
        throw new RecordNotFoundError("user", input.userId);
      }

      return mapRowToCredential(result.recordset[0]);
    } catch (err) {
      if (err instanceof RecordNotFoundError) throw err;
      throw new SqlCredentialRepositoryError("create", err);
    }
  }

  async changePassword(input: ChangePasswordInput): Promise<CredentialRecord> {
    try {
      const pool = await this.getPool();
      const req = pool.request();

      const isNumeric = /^[0-9]+$/.test(input.userId);
      req.input("idParam", sql.NVarChar(100), input.userId);
      req.input("expectedHash", sql.NVarChar(500), input.expectedCurrentHash);
      req.input("newHash", sql.NVarChar(500), input.newPasswordHash);

      const query = `
        UPDATE dbo.NXA_Users
           SET PasswordHash = @newHash,
               FailedLoginAttempts = 0,
               IsLocked = 0,
               LockoutUntil = NULL,
               UpdatedAt = SYSUTCDATETIME()
        OUTPUT inserted.UserId, inserted.PasswordHash, inserted.FailedLoginAttempts,
               inserted.IsLocked, inserted.LockoutUntil, inserted.UpdatedAt, inserted.CreatedAt
         WHERE (
           ${isNumeric ? "UserId = CAST(@idParam AS BIGINT)" : "CAST(PublicUserId AS NVARCHAR(100)) = @idParam"}
         )
         AND PasswordHash = @expectedHash
         AND DeletedAt IS NULL;
      `;

      const result = await req.query<RawCredentialRow>(query);
      if (result.recordset.length > 0 && result.recordset[0]) {
        return mapRowToCredential(result.recordset[0]);
      }

      // Check whether user is missing or hash mismatched
      const existing = await this.findByUserId(input.userId);
      if (existing === null) {
        throw new RecordNotFoundError("credential", input.userId);
      }

      throw new OptimisticLockError("credential", input.userId);
    } catch (err) {
      if (err instanceof RecordNotFoundError || err instanceof OptimisticLockError) {
        throw err;
      }
      throw new SqlCredentialRepositoryError("changePassword", err);
    }
  }

  async rehashPassword(input: RehashPasswordInput): Promise<CredentialRecord> {
    try {
      const pool = await this.getPool();
      const req = pool.request();

      const isNumeric = /^[0-9]+$/.test(input.userId);
      req.input("idParam", sql.NVarChar(100), input.userId);
      req.input("expectedHash", sql.NVarChar(500), input.expectedCurrentHash);
      req.input("newHash", sql.NVarChar(500), input.newPasswordHash);

      const query = `
        UPDATE dbo.NXA_Users
           SET PasswordHash = @newHash,
               UpdatedAt = SYSUTCDATETIME()
        OUTPUT inserted.UserId, inserted.PasswordHash, inserted.FailedLoginAttempts,
               inserted.IsLocked, inserted.LockoutUntil, inserted.UpdatedAt, inserted.CreatedAt
         WHERE (
           ${isNumeric ? "UserId = CAST(@idParam AS BIGINT)" : "CAST(PublicUserId AS NVARCHAR(100)) = @idParam"}
         )
         AND PasswordHash = @expectedHash
         AND DeletedAt IS NULL;
      `;

      const result = await req.query<RawCredentialRow>(query);
      if (result.recordset.length > 0 && result.recordset[0]) {
        return mapRowToCredential(result.recordset[0]);
      }

      const existing = await this.findByUserId(input.userId);
      if (existing === null) {
        throw new RecordNotFoundError("credential", input.userId);
      }

      throw new OptimisticLockError("credential", input.userId);
    } catch (err) {
      if (err instanceof RecordNotFoundError || err instanceof OptimisticLockError) {
        throw err;
      }
      throw new SqlCredentialRepositoryError("rehashPassword", err);
    }
  }

  async resetPassword(input: ResetPasswordInput): Promise<CredentialRecord> {
    try {
      const pool = await this.getPool();
      const req = pool.request();

      const isNumeric = /^[0-9]+$/.test(input.userId);
      req.input("idParam", sql.NVarChar(100), input.userId);
      req.input("newHash", sql.NVarChar(500), input.newPasswordHash);

      const query = `
        UPDATE dbo.NXA_Users
           SET PasswordHash = @newHash,
               FailedLoginAttempts = 0,
               IsLocked = 0,
               LockoutUntil = NULL,
               UpdatedAt = SYSUTCDATETIME()
        OUTPUT inserted.UserId, inserted.PasswordHash, inserted.FailedLoginAttempts,
               inserted.IsLocked, inserted.LockoutUntil, inserted.UpdatedAt, inserted.CreatedAt
         WHERE (
           ${isNumeric ? "UserId = CAST(@idParam AS BIGINT)" : "CAST(PublicUserId AS NVARCHAR(100)) = @idParam"}
         )
         AND DeletedAt IS NULL;
      `;

      const result = await req.query<RawCredentialRow>(query);
      if (result.recordset.length === 0 || !result.recordset[0]) {
        throw new RecordNotFoundError("credential", input.userId);
      }

      return mapRowToCredential(result.recordset[0]);
    } catch (err) {
      if (err instanceof RecordNotFoundError) throw err;
      throw new SqlCredentialRepositoryError("resetPassword", err);
    }
  }

  async recordFailedAttempt(
    input: RecordFailedAttemptInput,
  ): Promise<CredentialLockoutState> {
    try {
      const pool = await this.getPool();
      const req = pool.request();

      const isNumeric = /^[0-9]+$/.test(input.userId);
      req.input("idParam", sql.NVarChar(100), input.userId);
      req.input("threshold", sql.Int, input.threshold);

      const query = `
        UPDATE dbo.NXA_Users
           SET FailedLoginAttempts = FailedLoginAttempts + 1,
               IsLocked = CASE WHEN FailedLoginAttempts + 1 >= @threshold THEN 1 ELSE IsLocked END,
               UpdatedAt = SYSUTCDATETIME()
        OUTPUT inserted.FailedLoginAttempts, inserted.IsLocked, inserted.LockoutUntil
         WHERE (
           ${isNumeric ? "UserId = CAST(@idParam AS BIGINT)" : "CAST(PublicUserId AS NVARCHAR(100)) = @idParam"}
         )
         AND DeletedAt IS NULL;
      `;

      const result = await req.query<{
        FailedLoginAttempts: number;
        IsLocked: boolean;
        LockoutUntil: Date | null;
      }>(query);

      const row = result.recordset[0];
      if (!row) {
        throw new RecordNotFoundError("credential", input.userId);
      }

      return toLockoutState(
        {
          failedLoginAttempts: row.FailedLoginAttempts,
          ...(row.LockoutUntil ? { lockedUntil: row.LockoutUntil.toISOString() } : {}),
        },
        input.threshold,
      );
    } catch (err) {
      if (err instanceof RecordNotFoundError) throw err;
      throw new SqlCredentialRepositoryError("recordFailedAttempt", err);
    }
  }

  async resetFailedAttemptsIfAuthorized(
    input: ConditionalResetInput,
  ): Promise<ConditionalResetResult> {
    try {
      const pool = await this.getPool();
      const req = pool.request();

      const isNumeric = /^[0-9]+$/.test(input.userId);
      req.input("idParam", sql.NVarChar(100), input.userId);
      req.input("threshold", sql.Int, input.threshold);

      // Parameterize acceptable hashes
      const hashPlaceholders: string[] = [];
      input.acceptableHashes.forEach((h, idx) => {
        const paramName = `hash${idx}`;
        req.input(paramName, sql.NVarChar(500), h);
        hashPlaceholders.push(`@${paramName}`);
      });

      const inClause = hashPlaceholders.length > 0 ? hashPlaceholders.join(", ") : "''";

      const query = `
        UPDATE dbo.NXA_Users
           SET FailedLoginAttempts = 0,
               UpdatedAt = SYSUTCDATETIME()
        OUTPUT inserted.UserId, inserted.PasswordHash, inserted.FailedLoginAttempts,
               inserted.IsLocked, inserted.LockoutUntil, inserted.UpdatedAt, inserted.CreatedAt
         WHERE (
           ${isNumeric ? "UserId = CAST(@idParam AS BIGINT)" : "CAST(PublicUserId AS NVARCHAR(100)) = @idParam"}
         )
         AND FailedLoginAttempts < @threshold
         AND IsLocked = 0
         AND (LockoutUntil IS NULL OR LockoutUntil <= SYSUTCDATETIME())
         AND PasswordHash IN (${inClause})
         AND DeletedAt IS NULL;
      `;

      const result = await req.query<RawCredentialRow>(query);
      if (result.recordset.length > 0 && result.recordset[0]) {
        return {
          status: "reset",
          credential: mapRowToCredential(result.recordset[0]),
        };
      }

      // Diagnose why the update was not applied
      const existing = await this.findByUserId(input.userId);
      if (existing === null) {
        return { status: "not_found" };
      }

      if (isCredentialLocked(existing, input.threshold)) {
        return { status: "locked", credential: existing };
      }

      if (!input.acceptableHashes.includes(existing.passwordHash)) {
        return { status: "password_changed" };
      }

      return { status: "locked", credential: existing };
    } catch (err) {
      throw new SqlCredentialRepositoryError("resetFailedAttemptsIfAuthorized", err);
    }
  }

  async clearLockout(userId: EntityId): Promise<CredentialRecord> {
    try {
      const pool = await this.getPool();
      const req = pool.request();

      const isNumeric = /^[0-9]+$/.test(userId);
      req.input("idParam", sql.NVarChar(100), userId);

      const query = `
        UPDATE dbo.NXA_Users
           SET FailedLoginAttempts = 0,
               IsLocked = 0,
               LockoutUntil = NULL,
               UpdatedAt = SYSUTCDATETIME()
        OUTPUT inserted.UserId, inserted.PasswordHash, inserted.FailedLoginAttempts,
               inserted.IsLocked, inserted.LockoutUntil, inserted.UpdatedAt, inserted.CreatedAt
         WHERE (
           ${isNumeric ? "UserId = CAST(@idParam AS BIGINT)" : "CAST(PublicUserId AS NVARCHAR(100)) = @idParam"}
         )
         AND DeletedAt IS NULL;
      `;

      const result = await req.query<RawCredentialRow>(query);
      if (result.recordset.length === 0 || !result.recordset[0]) {
        throw new RecordNotFoundError("credential", userId);
      }

      return mapRowToCredential(result.recordset[0]);
    } catch (err) {
      if (err instanceof RecordNotFoundError) throw err;
      throw new SqlCredentialRepositoryError("clearLockout", err);
    }
  }
}
