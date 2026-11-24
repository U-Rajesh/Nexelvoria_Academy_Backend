import type { EntityId, IsoDateTime } from "../../contracts/identifier.contract";

/**
 * Account security records (AUTH-006, AUTH-008, AUTH-014) over the live tables
 * NXA_LoginHistory and NXA_PasswordResetTokens.
 *
 * Nothing here ever stores or returns a password, a password hash, an OTP or
 * a raw reset token.
 */

/** One NXA_LoginHistory row as returned to its owner (or a Super Admin). */
export interface LoginHistoryEntry {
  id: EntityId;
  userId?: EntityId | undefined;
  /** The email / mobile typed at sign-in (never the password). */
  loginIdentifier: string;
  isSuccessful: boolean;
  /** A machine reason code such as `invalid_credentials`; never free text from the client. */
  failureReason?: string | undefined;
  ipAddress?: string | undefined;
  deviceInfo?: string | undefined;
  loggedAt: IsoDateTime;
}

export interface RecordLoginInput {
  /** Absent when the identifier matched no account. */
  userId?: EntityId | undefined;
  loginIdentifier: string;
  isSuccessful: boolean;
  failureReason?: string | undefined;
  ipAddress?: string | undefined;
  deviceInfo?: string | undefined;
}

export interface CreateResetGrantInput {
  userId: EntityId;
  /** Hash of a server-side random value; the raw value is discarded, never sent anywhere. */
  tokenHash: Buffer;
  expiresAt: Date;
  requestIp?: string | undefined;
}

export interface AccountSecurityRepository {
  recordLogin(input: RecordLoginInput): Promise<void>;
  /** Newest first, at most `limit` rows, for ONE user. */
  listLoginHistory(userId: EntityId, limit: number): Promise<LoginHistoryEntry[]>;
  /** Records a password-reset request (single-use grant, expiring with its OTP). */
  createResetGrant(input: CreateResetGrantInput): Promise<void>;
  /**
   * Atomically marks the newest unused, unexpired grant of the user as used.
   * Returns false when none exists, so a grant can never be used twice.
   */
  consumeResetGrant(userId: EntityId): Promise<boolean>;
}
