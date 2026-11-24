import sql from "mssql";
import { getSqlServerPool } from "../../db/sqlserver.pool";
import type { EntityId } from "../../contracts/identifier.contract";
import type {
  AccountSecurityRepository,
  CreateResetGrantInput,
  LoginHistoryEntry,
  RecordLoginInput,
} from "./account-security.repository";

const isId = (id: string | undefined | null): id is string => typeof id === "string" && /^\d{1,19}$/.test(id);
const clip = (v: string | undefined, max: number): string | null => (v === undefined || v === "" ? null : v.slice(0, max));

/**
 * NXA_LoginHistory: LoginIdentifier nvarchar(254), FailureReason nvarchar(250),
 * IpAddress varchar(45), DeviceInfo nvarchar(300), UserId bigint NULL.
 * NXA_PasswordResetTokens: TokenHash varbinary (unique), ExpiresAt, UsedAt, RequestIp varchar(45).
 */
export class SqlServerAccountSecurityRepository implements AccountSecurityRepository {
  constructor(private readonly getPool: () => Promise<sql.ConnectionPool> = getSqlServerPool) {}

  async recordLogin(input: RecordLoginInput): Promise<void> {
    const pool = await this.getPool();
    await pool
      .request()
      .input("UserId", sql.BigInt, isId(input.userId) ? input.userId : null)
      .input("Identifier", sql.NVarChar(254), input.loginIdentifier.slice(0, 254))
      .input("Ok", sql.Bit, input.isSuccessful)
      .input("Reason", sql.NVarChar(250), clip(input.failureReason, 250))
      .input("Ip", sql.VarChar(45), clip(input.ipAddress, 45))
      .input("Device", sql.NVarChar(300), clip(input.deviceInfo, 300))
      .query(`
        INSERT INTO dbo.NXA_LoginHistory (UserId, LoginIdentifier, IsSuccessful, FailureReason, IpAddress, DeviceInfo, LoggedAt)
        VALUES (@UserId, @Identifier, @Ok, @Reason, @Ip, @Device, SYSUTCDATETIME())
      `);
  }

  async listLoginHistory(userId: EntityId, limit: number): Promise<LoginHistoryEntry[]> {
    if (!isId(userId)) return [];
    const pool = await this.getPool();
    const r = await pool
      .request()
      .input("UserId", sql.BigInt, userId)
      .input("Limit", sql.Int, Math.max(1, Math.min(200, Math.trunc(limit))))
      .query(`
        SELECT TOP (@Limit) LoginHistoryId, UserId, LoginIdentifier, IsSuccessful, FailureReason, IpAddress, DeviceInfo, LoggedAt
        FROM dbo.NXA_LoginHistory
        WHERE UserId = @UserId
        ORDER BY LoggedAt DESC, LoginHistoryId DESC
      `);
    return r.recordset.map((x) => ({
      id: String(x.LoginHistoryId),
      userId: x.UserId != null ? String(x.UserId) : undefined,
      loginIdentifier: x.LoginIdentifier,
      isSuccessful: Boolean(x.IsSuccessful),
      failureReason: x.FailureReason ?? undefined,
      ipAddress: x.IpAddress ?? undefined,
      deviceInfo: x.DeviceInfo ?? undefined,
      loggedAt: new Date(x.LoggedAt).toISOString(),
    }));
  }

  async createResetGrant(input: CreateResetGrantInput): Promise<void> {
    if (!isId(input.userId)) return;
    const pool = await this.getPool();
    await pool
      .request()
      .input("UserId", sql.BigInt, input.userId)
      .input("Hash", sql.VarBinary(sql.MAX), input.tokenHash)
      .input("ExpiresAt", sql.DateTime2, input.expiresAt)
      .input("Ip", sql.VarChar(45), clip(input.requestIp, 45))
      .query(`
        INSERT INTO dbo.NXA_PasswordResetTokens (UserId, TokenHash, ExpiresAt, RequestIp, CreatedAt)
        VALUES (@UserId, @Hash, @ExpiresAt, @Ip, SYSUTCDATETIME())
      `);
  }

  async consumeResetGrant(userId: EntityId): Promise<boolean> {
    if (!isId(userId)) return false;
    const pool = await this.getPool();
    // One statement: the newest live grant is locked and stamped, so two
    // concurrent resets cannot both consume it.
    const r = await pool
      .request()
      .input("UserId", sql.BigInt, userId)
      .query<{ PasswordResetTokenId: number | bigint }>(`
        UPDATE t
           SET UsedAt = SYSUTCDATETIME()
        OUTPUT inserted.PasswordResetTokenId
          FROM dbo.NXA_PasswordResetTokens t
         WHERE t.PasswordResetTokenId = (
                 SELECT TOP 1 g.PasswordResetTokenId
                   FROM dbo.NXA_PasswordResetTokens g WITH (UPDLOCK, HOLDLOCK)
                  WHERE g.UserId = @UserId AND g.UsedAt IS NULL AND g.ExpiresAt > SYSUTCDATETIME()
                  ORDER BY g.CreatedAt DESC, g.PasswordResetTokenId DESC
               )
           AND t.UsedAt IS NULL
      `);
    return r.recordset.length === 1;
  }
}
