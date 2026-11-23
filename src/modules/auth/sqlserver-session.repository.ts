import sql from "mssql";

import type { EntityId, IsoDateTime } from "../../contracts/identifier.contract";
import type { SessionRepository } from "./session.repository";
import type {
  CreateSessionInput,
  ListSessionsOptions,
  RefreshTokenLookup,
  RevokeAllForUserInput,
  RevokeSessionFamilyInput,
  RevokeSessionInput,
  RotateRefreshTokenInput,
  Session,
} from "./session.types";
import {
  OptimisticLockError,
  RecordNotFoundError,
  RepositoryError,
} from "../../repositories/repository.errors";
import { SessionNotActiveError } from "./session.errors";
import { getSqlServerPool } from "../../db/sqlserver.pool";

export class SqlSessionRepositoryError extends RepositoryError {
  override readonly cause: unknown;

  constructor(operation: string, cause: unknown) {
    super(`SQL Server operation failed: ${operation} on session`);
    this.cause = cause;
  }
}

interface RawSessionRow {
  UserSessionId: number | bigint;
  UserId: number | bigint;
  RefreshTokenHash: Buffer;
  ExpiresAt: Date;
  RevokedAt: Date | null;
  IpAddress: string | null;
  UserAgent: string | null;
  DeviceInfo: string | null;
  CreatedAt: Date;
}

const mapRowToSession = (row: RawSessionRow): Session => {
  const hashHex = Buffer.isBuffer(row.RefreshTokenHash)
    ? row.RefreshTokenHash.toString("hex")
    : String(row.RefreshTokenHash);

  const sessionId = String(row.UserSessionId);
  const createdAtIso = row.CreatedAt.toISOString();

  return {
    sessionId,
    userId: String(row.UserId),
    refreshTokenHash: hashHex,
    familyId: sessionId,
    createdAt: createdAtIso,
    lastActiveAt: createdAtIso,
    expiresAt: row.ExpiresAt.toISOString(),
    ...(row.RevokedAt ? { revokedAt: row.RevokedAt.toISOString(), revocationReason: "logout" as const } : {}),
    ...(row.DeviceInfo ? { device: row.DeviceInfo } : {}),
    ...(row.UserAgent ? { browser: row.UserAgent } : {}),
    ...(row.IpAddress ? { ipAddress: row.IpAddress } : {}),
  };
};

export class SqlServerSessionRepository implements SessionRepository {
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

  async create(input: CreateSessionInput): Promise<Session> {
    try {
      const pool = await this.getPool();
      const req = pool.request();

      const isNumeric = /^[0-9]+$/.test(input.userId);
      let userIdBigInt: bigint | number;

      if (isNumeric) {
        userIdBigInt = Number(input.userId);
      } else {
        // Resolve user by public id
        const userReq = new sql.Request(pool);
        userReq.input("publicId", sql.NVarChar(100), input.userId);
        const userRes = await userReq.query<{ UserId: number | bigint }>(`
          SELECT TOP 1 UserId FROM dbo.NXA_Users WHERE CAST(PublicUserId AS NVARCHAR(100)) = @publicId
        `);
        if (userRes.recordset.length === 0 || !userRes.recordset[0]) {
          throw new RecordNotFoundError("user", input.userId);
        }
        userIdBigInt = userRes.recordset[0].UserId;
      }

      const hashBuffer = Buffer.from(input.refreshTokenHash, "hex");

      req.input("userId", sql.BigInt, userIdBigInt);
      req.input("hash", sql.VarBinary(64), hashBuffer);
      req.input("expiresAt", sql.DateTime2, new Date(input.expiresAt));
      req.input("ipAddress", sql.VarChar(45), input.ipAddress ?? null);
      req.input("userAgent", sql.NVarChar(500), input.browser ?? null);
      req.input("deviceInfo", sql.NVarChar(300), input.device ?? input.os ?? null);

      const query = `
        INSERT INTO dbo.NXA_UserSessions (
          UserId,
          RefreshTokenHash,
          ExpiresAt,
          IpAddress,
          UserAgent,
          DeviceInfo,
          CreatedAt
        )
        OUTPUT inserted.UserSessionId, inserted.UserId, inserted.RefreshTokenHash,
               inserted.ExpiresAt, inserted.RevokedAt, inserted.IpAddress,
               inserted.UserAgent, inserted.DeviceInfo, inserted.CreatedAt
        VALUES (
          @userId,
          @hash,
          @expiresAt,
          @ipAddress,
          @userAgent,
          @deviceInfo,
          SYSUTCDATETIME()
        )
      `;

      const result = await req.query<RawSessionRow>(query);
      const row = result.recordset[0];
      if (!row) {
        throw new SqlSessionRepositoryError("create", new Error("No session row returned"));
      }

      return mapRowToSession(row);
    } catch (err) {
      if (err instanceof RecordNotFoundError) throw err;
      throw new SqlSessionRepositoryError("create", err);
    }
  }

  async findBySessionId(sessionId: EntityId): Promise<Session | null> {
    try {
      const isNumeric = /^[0-9]+$/.test(sessionId);
      if (!isNumeric) {
        return null;
      }

      const pool = await this.getPool();
      const req = pool.request();
      req.input("sessionId", sql.BigInt, Number(sessionId));

      const query = `
        SELECT TOP 1
          UserSessionId,
          UserId,
          RefreshTokenHash,
          ExpiresAt,
          RevokedAt,
          IpAddress,
          UserAgent,
          DeviceInfo,
          CreatedAt
        FROM dbo.NXA_UserSessions
        WHERE UserSessionId = @sessionId
      `;

      const result = await req.query<RawSessionRow>(query);
      if (result.recordset.length === 0 || !result.recordset[0]) {
        return null;
      }

      return mapRowToSession(result.recordset[0]);
    } catch (err) {
      throw new SqlSessionRepositoryError("findBySessionId", err);
    }
  }

  async findByRefreshTokenHash(refreshTokenHash: string): Promise<Session | null> {
    try {
      const pool = await this.getPool();
      const req = pool.request();
      const hashBuffer = Buffer.from(refreshTokenHash, "hex");
      req.input("hash", sql.VarBinary(64), hashBuffer);

      const query = `
        SELECT TOP 1
          UserSessionId,
          UserId,
          RefreshTokenHash,
          ExpiresAt,
          RevokedAt,
          IpAddress,
          UserAgent,
          DeviceInfo,
          CreatedAt
        FROM dbo.NXA_UserSessions
        WHERE RefreshTokenHash = @hash
      `;

      const result = await req.query<RawSessionRow>(query);
      if (result.recordset.length === 0 || !result.recordset[0]) {
        return null;
      }

      return mapRowToSession(result.recordset[0]);
    } catch (err) {
      throw new SqlSessionRepositoryError("findByRefreshTokenHash", err);
    }
  }

  async resolveRefreshToken(refreshTokenHash: string): Promise<RefreshTokenLookup> {
    try {
      const session = await this.findByRefreshTokenHash(refreshTokenHash);
      if (session !== null) {
        return { status: "active", session };
      }

      return { status: "unknown" };
    } catch (err) {
      throw new SqlSessionRepositoryError("resolveRefreshToken", err);
    }
  }

  async rotateRefreshToken(input: RotateRefreshTokenInput): Promise<Session> {
    try {
      const existing = await this.findBySessionId(input.sessionId);
      if (existing === null) {
        throw new RecordNotFoundError("session", input.sessionId);
      }

      if (existing.revokedAt || Date.parse(existing.expiresAt) <= Date.now()) {
        throw new SessionNotActiveError(input.sessionId, existing.revokedAt ? "revoked" : "expired");
      }

      if (existing.refreshTokenHash !== input.expectedCurrentHash) {
        throw new OptimisticLockError("session", input.sessionId);
      }

      const pool = await this.getPool();
      const req = pool.request();
      req.input("sessionId", sql.BigInt, Number(input.sessionId));
      req.input("expectedHash", sql.VarBinary(64), Buffer.from(input.expectedCurrentHash, "hex"));
      req.input("newHash", sql.VarBinary(64), Buffer.from(input.newRefreshTokenHash, "hex"));

      const query = `
        UPDATE dbo.NXA_UserSessions
           SET RefreshTokenHash = @newHash
        OUTPUT inserted.UserSessionId, inserted.UserId, inserted.RefreshTokenHash,
               inserted.ExpiresAt, inserted.RevokedAt, inserted.IpAddress,
               inserted.UserAgent, inserted.DeviceInfo, inserted.CreatedAt
         WHERE UserSessionId = @sessionId AND RefreshTokenHash = @expectedHash;
      `;

      const result = await req.query<RawSessionRow>(query);
      if (result.recordset.length === 0 || !result.recordset[0]) {
        throw new OptimisticLockError("session", input.sessionId);
      }

      return mapRowToSession(result.recordset[0]);
    } catch (err) {
      if (
        err instanceof RecordNotFoundError ||
        err instanceof SessionNotActiveError ||
        err instanceof OptimisticLockError
      ) {
        throw err;
      }
      throw new SqlSessionRepositoryError("rotateRefreshToken", err);
    }
  }

  async updateLastActiveAt(_sessionId: EntityId, _lastActiveAt: IsoDateTime): Promise<void> {
    // Info only; NXA_UserSessions schema has no LastActiveAt column
  }

  async revokeSession(input: RevokeSessionInput): Promise<Session> {
    try {
      const pool = await this.getPool();
      const req = pool.request();

      const isSessionNumeric = /^[0-9]+$/.test(input.sessionId);
      const isUserNumeric = /^[0-9]+$/.test(input.userId);

      if (!isSessionNumeric) {
        throw new RecordNotFoundError("session", input.sessionId);
      }

      req.input("sessionId", sql.BigInt, Number(input.sessionId));
      req.input("userIdParam", sql.NVarChar(100), input.userId);

      const query = `
        UPDATE s
           SET RevokedAt = SYSUTCDATETIME()
        OUTPUT inserted.UserSessionId, inserted.UserId, inserted.RefreshTokenHash,
               inserted.ExpiresAt, inserted.RevokedAt, inserted.IpAddress,
               inserted.UserAgent, inserted.DeviceInfo, inserted.CreatedAt
          FROM dbo.NXA_UserSessions s
          JOIN dbo.NXA_Users u ON u.UserId = s.UserId
         WHERE s.UserSessionId = @sessionId
           AND (
             ${isUserNumeric ? "s.UserId = CAST(@userIdParam AS BIGINT)" : "CAST(u.PublicUserId AS NVARCHAR(100)) = @userIdParam"}
           );
      `;

      const result = await req.query<RawSessionRow>(query);
      if (result.recordset.length === 0 || !result.recordset[0]) {
        throw new RecordNotFoundError("session", input.sessionId);
      }

      return mapRowToSession(result.recordset[0]);
    } catch (err) {
      if (err instanceof RecordNotFoundError) throw err;
      throw new SqlSessionRepositoryError("revokeSession", err);
    }
  }

  async revokeAllForUser(input: RevokeAllForUserInput): Promise<number> {
    try {
      const pool = await this.getPool();
      const req = pool.request();

      const isUserNumeric = /^[0-9]+$/.test(input.userId);
      req.input("userIdParam", sql.NVarChar(100), input.userId);

      let exceptClause = "";
      if (input.exceptSessionId && /^[0-9]+$/.test(input.exceptSessionId)) {
        req.input("exceptSessionId", sql.BigInt, Number(input.exceptSessionId));
        exceptClause = "AND s.UserSessionId != @exceptSessionId";
      }

      const query = `
        UPDATE s
           SET RevokedAt = SYSUTCDATETIME()
          FROM dbo.NXA_UserSessions s
          JOIN dbo.NXA_Users u ON u.UserId = s.UserId
         WHERE (
           ${isUserNumeric ? "s.UserId = CAST(@userIdParam AS BIGINT)" : "CAST(u.PublicUserId AS NVARCHAR(100)) = @userIdParam"}
         )
         AND s.RevokedAt IS NULL
         ${exceptClause};
      `;

      const result = await req.query(query);
      return result.rowsAffected[0] ?? 0;
    } catch (err) {
      throw new SqlSessionRepositoryError("revokeAllForUser", err);
    }
  }

  async revokeSessionFamily(input: RevokeSessionFamilyInput): Promise<number> {
    try {
      if (!/^[0-9]+$/.test(input.familyId)) {
        return 0;
      }

      const pool = await this.getPool();
      const req = pool.request();
      req.input("sessionId", sql.BigInt, Number(input.familyId));

      const query = `
        UPDATE dbo.NXA_UserSessions
           SET RevokedAt = SYSUTCDATETIME()
         WHERE UserSessionId = @sessionId AND RevokedAt IS NULL;
      `;

      const result = await req.query(query);
      return result.rowsAffected[0] ?? 0;
    } catch (err) {
      throw new SqlSessionRepositoryError("revokeSessionFamily", err);
    }
  }

  async listSessionsForUser(
    userId: EntityId,
    options: ListSessionsOptions = {},
  ): Promise<Session[]> {
    try {
      const pool = await this.getPool();
      const req = pool.request();

      const isUserNumeric = /^[0-9]+$/.test(userId);
      req.input("userIdParam", sql.NVarChar(100), userId);

      const conditions: string[] = [
        isUserNumeric
          ? "s.UserId = CAST(@userIdParam AS BIGINT)"
          : "CAST(u.PublicUserId AS NVARCHAR(100)) = @userIdParam",
      ];

      if (!options.includeRevoked) {
        conditions.push("s.RevokedAt IS NULL");
      }

      if (!options.includeExpired) {
        conditions.push("s.ExpiresAt > SYSUTCDATETIME()");
      }

      const query = `
        SELECT
          s.UserSessionId,
          s.UserId,
          s.RefreshTokenHash,
          s.ExpiresAt,
          s.RevokedAt,
          s.IpAddress,
          s.UserAgent,
          s.DeviceInfo,
          s.CreatedAt
        FROM dbo.NXA_UserSessions s
        JOIN dbo.NXA_Users u ON u.UserId = s.UserId
        WHERE ${conditions.join(" AND ")}
        ORDER BY s.CreatedAt DESC
      `;

      const result = await req.query<RawSessionRow>(query);
      return result.recordset.map(mapRowToSession);
    } catch (err) {
      throw new SqlSessionRepositoryError("listSessionsForUser", err);
    }
  }

  async purgeConsumedRefreshTokens(_before: IsoDateTime): Promise<number> {
    return 0;
  }
}
