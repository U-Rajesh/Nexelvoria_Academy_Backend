import sql from "mssql";

import type { EntityId, IsoDateTime } from "../../contracts/identifier.contract";
import type { OtpChallengeRepository } from "./otp.repository";
import type { CreateOtpChallengeInput, OtpChallenge, OtpPurpose } from "./otp.types";
import {
  RecordNotFoundError,
  RepositoryError,
} from "../../repositories/repository.errors";
import { getSqlServerPool } from "../../db/sqlserver.pool";

export class SqlOtpRepositoryError extends RepositoryError {
  override readonly cause: unknown;

  constructor(operation: string, cause: unknown) {
    super(`SQL Server operation failed: ${operation} on OTP record`);
    this.cause = cause;
  }
}

interface RawOtpRow {
  OtpRecordId: number | bigint;
  UserId: number | bigint | null;
  OtpPurpose: string;
  OtpHash: Buffer | string;
  Destination: string;
  AttemptCount: number;
  ExpiresAt: Date;
  VerifiedAt: Date | null;
  CreatedAt: Date;
}

const mapRowToChallenge = (row: RawOtpRow, fallbackUserId?: EntityId): OtpChallenge => {
  const codeHash = Buffer.isBuffer(row.OtpHash)
    ? row.OtpHash.toString("hex")
    : String(row.OtpHash);

  return {
    id: String(row.OtpRecordId),
    userId: row.UserId != null ? String(row.UserId) : (fallbackUserId ?? ""),
    purpose: row.OtpPurpose as OtpPurpose,
    codeHash,
    destination: row.Destination,
    expiresAt: row.ExpiresAt.toISOString(),
    attempts: row.AttemptCount ?? 0,
    ...(row.VerifiedAt ? { consumedAt: row.VerifiedAt.toISOString() } : {}),
    createdAt: row.CreatedAt.toISOString(),
  };
};

export class SqlServerOtpChallengeRepository implements OtpChallengeRepository {
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

  private async resolveUserId(pool: sql.ConnectionPool, userId: EntityId): Promise<number | bigint> {
    if (/^[0-9]+$/.test(userId)) {
      return Number(userId);
    }

    const req = pool.request();
    req.input("publicId", sql.NVarChar(100), userId);
    const res = await req.query<{ UserId: number | bigint }>(`
      SELECT TOP 1 UserId FROM dbo.NXA_Users
      WHERE CAST(PublicUserId AS NVARCHAR(100)) = @publicId
    `);

    if (res.recordset.length === 0 || !res.recordset[0]) {
      throw new RecordNotFoundError("user", userId);
    }

    return res.recordset[0].UserId;
  }

  async create(input: CreateOtpChallengeInput): Promise<OtpChallenge> {
    try {
      const pool = await this.getPool();
      const userIdBigInt = await this.resolveUserId(pool, input.userId);

      const hashBuffer = /^[0-9a-fA-F]+$/.test(input.codeHash) && input.codeHash.length % 2 === 0
        ? Buffer.from(input.codeHash, "hex")
        : Buffer.from(input.codeHash, "utf-8");

      const req = pool.request();
      req.input("userId", sql.BigInt, userIdBigInt);
      req.input("purpose", sql.VarChar(40), input.purpose);
      req.input("otpHash", sql.VarBinary(64), hashBuffer);
      req.input("destination", sql.VarChar(254), input.destination);
      req.input("expiresAt", sql.DateTime2(0), new Date(input.expiresAt));
      req.input("createdAt", sql.DateTime2(0), new Date(input.createdAt));

      const query = `
        INSERT INTO dbo.NXA_OtpRecords (
          UserId,
          OtpPurpose,
          OtpHash,
          Destination,
          AttemptCount,
          ResendCount,
          ExpiresAt,
          CreatedAt
        )
        OUTPUT
          INSERTED.OtpRecordId,
          INSERTED.UserId,
          INSERTED.OtpPurpose,
          INSERTED.OtpHash,
          INSERTED.Destination,
          INSERTED.AttemptCount,
          INSERTED.ExpiresAt,
          INSERTED.VerifiedAt,
          INSERTED.CreatedAt
        VALUES (
          @userId,
          @purpose,
          @otpHash,
          @destination,
          0,
          0,
          @expiresAt,
          @createdAt
        );
      `;

      const result = await req.query<RawOtpRow>(query);
      const inserted = result.recordset[0];
      if (!inserted) {
        throw new Error("Failed to insert OTP challenge record into database.");
      }

      return mapRowToChallenge(inserted, input.userId);
    } catch (err: unknown) {
      if (err instanceof RecordNotFoundError) {
        throw err;
      }
      throw new SqlOtpRepositoryError("create", err);
    }
  }

  async findActiveByUser(userId: EntityId, purpose: OtpPurpose): Promise<OtpChallenge | null> {
    try {
      const pool = await this.getPool();
      let userIdBigInt: number | bigint;
      try {
        userIdBigInt = await this.resolveUserId(pool, userId);
      } catch (err) {
        if (err instanceof RecordNotFoundError) {
          return null;
        }
        throw err;
      }

      const req = pool.request();
      req.input("userId", sql.BigInt, userIdBigInt);
      req.input("purpose", sql.VarChar(40), purpose);

      const query = `
        SELECT TOP 1
          OtpRecordId,
          UserId,
          OtpPurpose,
          OtpHash,
          Destination,
          AttemptCount,
          ExpiresAt,
          VerifiedAt,
          CreatedAt
        FROM dbo.NXA_OtpRecords
        WHERE UserId = @userId
          AND OtpPurpose = @purpose
          AND VerifiedAt IS NULL
        ORDER BY CreatedAt DESC, OtpRecordId DESC;
      `;

      const result = await req.query<RawOtpRow>(query);
      if (result.recordset.length === 0 || !result.recordset[0]) {
        return null;
      }

      return mapRowToChallenge(result.recordset[0], userId);
    } catch (err: unknown) {
      throw new SqlOtpRepositoryError("findActiveByUser", err);
    }
  }

  async incrementAttempts(id: EntityId): Promise<OtpChallenge> {
    try {
      const pool = await this.getPool();
      const req = pool.request();
      req.input("id", sql.BigInt, Number(id));

      const query = `
        UPDATE dbo.NXA_OtpRecords
        SET AttemptCount = AttemptCount + 1
        OUTPUT
          INSERTED.OtpRecordId,
          INSERTED.UserId,
          INSERTED.OtpPurpose,
          INSERTED.OtpHash,
          INSERTED.Destination,
          INSERTED.AttemptCount,
          INSERTED.ExpiresAt,
          INSERTED.VerifiedAt,
          INSERTED.CreatedAt
        WHERE OtpRecordId = @id;
      `;

      const result = await req.query<RawOtpRow>(query);
      if (result.recordset.length === 0 || !result.recordset[0]) {
        throw new RecordNotFoundError("otp_challenge", id);
      }

      return mapRowToChallenge(result.recordset[0]);
    } catch (err: unknown) {
      if (err instanceof RecordNotFoundError) {
        throw err;
      }
      throw new SqlOtpRepositoryError("incrementAttempts", err);
    }
  }

  async consume(id: EntityId, consumedAt: IsoDateTime): Promise<boolean> {
    try {
      const pool = await this.getPool();
      const req = pool.request();
      req.input("id", sql.BigInt, Number(id));
      req.input("consumedAt", sql.DateTime2(0), new Date(consumedAt));

      const query = `
        UPDATE dbo.NXA_OtpRecords
        SET VerifiedAt = @consumedAt
        WHERE OtpRecordId = @id AND VerifiedAt IS NULL;
      `;

      const result = await req.query(query);
      return (result.rowsAffected[0] ?? 0) > 0;
    } catch (err: unknown) {
      throw new SqlOtpRepositoryError("consume", err);
    }
  }

  async countIssuedSince(
    userId: EntityId,
    purpose: OtpPurpose,
    since: IsoDateTime,
  ): Promise<number> {
    try {
      const pool = await this.getPool();
      let userIdBigInt: number | bigint;
      try {
        userIdBigInt = await this.resolveUserId(pool, userId);
      } catch (err) {
        if (err instanceof RecordNotFoundError) {
          return 0;
        }
        throw err;
      }

      const req = pool.request();
      req.input("userId", sql.BigInt, userIdBigInt);
      req.input("purpose", sql.VarChar(40), purpose);
      req.input("since", sql.DateTime2(0), new Date(since));

      const query = `
        SELECT COUNT(*) AS total
        FROM dbo.NXA_OtpRecords
        WHERE UserId = @userId
          AND OtpPurpose = @purpose
          AND CreatedAt >= @since;
      `;

      const result = await req.query<{ total: number }>(query);
      return Number(result.recordset[0]?.total ?? 0);
    } catch (err: unknown) {
      throw new SqlOtpRepositoryError("countIssuedSince", err);
    }
  }

  async findLatestByUser(userId: EntityId, purpose: OtpPurpose): Promise<OtpChallenge | null> {
    try {
      const pool = await this.getPool();
      let userIdBigInt: number | bigint;
      try {
        userIdBigInt = await this.resolveUserId(pool, userId);
      } catch (err) {
        if (err instanceof RecordNotFoundError) {
          return null;
        }
        throw err;
      }

      const req = pool.request();
      req.input("userId", sql.BigInt, userIdBigInt);
      req.input("purpose", sql.VarChar(40), purpose);

      const query = `
        SELECT TOP 1
          OtpRecordId,
          UserId,
          OtpPurpose,
          OtpHash,
          Destination,
          AttemptCount,
          ExpiresAt,
          VerifiedAt,
          CreatedAt
        FROM dbo.NXA_OtpRecords
        WHERE UserId = @userId
          AND OtpPurpose = @purpose
        ORDER BY CreatedAt DESC, OtpRecordId DESC;
      `;

      const result = await req.query<RawOtpRow>(query);
      if (result.recordset.length === 0 || !result.recordset[0]) {
        return null;
      }

      return mapRowToChallenge(result.recordset[0], userId);
    } catch (err: unknown) {
      throw new SqlOtpRepositoryError("findLatestByUser", err);
    }
  }

  async purgeExpiredBefore(before: IsoDateTime): Promise<number> {
    try {
      const pool = await this.getPool();
      const req = pool.request();
      req.input("before", sql.DateTime2(0), new Date(before));

      const query = `
        DELETE FROM dbo.NXA_OtpRecords
        WHERE ExpiresAt < @before;
      `;

      const result = await req.query(query);
      return Number(result.rowsAffected[0] ?? 0);
    } catch (err: unknown) {
      throw new SqlOtpRepositoryError("purgeExpiredBefore", err);
    }
  }
}
