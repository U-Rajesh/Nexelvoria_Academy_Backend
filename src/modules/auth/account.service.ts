import { createHash, randomBytes } from "node:crypto";

import type { AuditSink } from "../../contracts/audit.contract";
import type { EntityId } from "../../contracts/identifier.contract";
import type { AuthenticatedPrincipal } from "../../contracts/user.contract";
import { OptimisticLockError, RecordNotFoundError } from "../../repositories/repository.errors";
import { ApiError } from "../../utils/api-error";
import { HttpStatus } from "../../utils/http-status";
import { logger } from "../../utils/logger";
import type { UserRepository } from "../users/user.repository";
import type { AccountSecurityRepository, LoginHistoryEntry } from "./account-security.repository";
import type { CredentialRepository } from "./credential.repository";
import type { OtpService } from "./otp.service";
import { hashPassword, validatePasswordPolicy, verifyPassword } from "./password.service";
import type { SessionRepository } from "./session.repository";

/**
 * Account security (AUTH-006 forgot/reset password, AUTH-007 change password,
 * AUTH-008 login history, AUTH-010 ending other sessions, AUTH-014 audit).
 *
 * Every self-service operation is keyed on the authenticated principal, never
 * on an id from the request. Responses never carry a password, hash, OTP or
 * reset token.
 */

const RESET_PURPOSE = "password_reset" as const;
/** One message for every reset failure, so the endpoint cannot reveal which accounts exist. */
const RESET_FAILED = "The reset code is invalid or has expired. Request a new code and try again.";

export interface AccountServiceDeps {
  users: UserRepository;
  credentials: CredentialRepository;
  sessions: SessionRepository;
  accountSecurity: AccountSecurityRepository;
  /** Email OTP (existing mechanism); absent = forgot password unavailable. */
  otp?: OtpService | undefined;
  /** NXA_AuditLogs writer. */
  audit?: AuditSink | undefined;
}

export interface AccountService {
  changePassword(principal: AuthenticatedPrincipal, currentPassword: string, newPassword: string): Promise<{ otherSessionsEnded: number }>;
  /** Always resolves (no account enumeration); delivery problems are logged, not returned. */
  requestPasswordReset(email: string, requestIp?: string | undefined): Promise<void>;
  resetPassword(email: string, code: string, newPassword: string): Promise<void>;
  endOtherSessions(principal: AuthenticatedPrincipal): Promise<{ sessionsEnded: number }>;
  recordSessionEnded(principal: AuthenticatedPrincipal, sessionId: string): Promise<void>;
  loginHistory(userId: EntityId, limit: number): Promise<LoginHistoryEntry[]>;
}

export const createAccountService = (deps: AccountServiceDeps): AccountService => {
  /** Security events go to NXA_AuditLogs; a failed audit write is logged loudly, the committed change stands. */
  const audit = async (actorUserId: EntityId, actionType: string, entityId: EntityId, newValues?: Record<string, unknown>) => {
    if (!deps.audit) return;
    try {
      await deps.audit({
        actorUserId,
        actionType,
        moduleCode: "AUTH",
        entityName: "UserAccount",
        entityId,
        ...(newValues ? { newValues: JSON.stringify(newValues) } : {}),
      });
    } catch (err) {
      logger.error("security audit write failed", { actionType, entityId, errorType: err instanceof Error ? err.name : typeof err });
    }
  };

  const assertPolicy = (password: string, field: string) => {
    const policy = validatePasswordPolicy(password, field);
    if (!policy.valid) throw ApiError.validation(policy.issues, "The new password does not meet the password policy.");
  };

  return {
    async changePassword(principal, currentPassword, newPassword) {
      assertPolicy(newPassword, "newPassword");
      if (currentPassword === newPassword) {
        throw new ApiError(HttpStatus.UNPROCESSABLE_ENTITY, "The new password must be different from the current password.", "PASSWORD_UNCHANGED");
      }
      const credential = await deps.credentials.findByUserId(principal.id);
      if (!credential) throw ApiError.notFound("Account not found.");
      const check = await verifyPassword(credential.passwordHash, currentPassword);
      if (!check.valid) {
        await audit(principal.id, "PASSWORD_CHANGE_FAILED", principal.id, { reason: "invalid_current_password" });
        throw ApiError.badRequest("The current password is incorrect.", "INVALID_CURRENT_PASSWORD");
      }
      const newHash = await hashPassword(newPassword, "newPassword");
      try {
        await deps.credentials.changePassword({ userId: principal.id, expectedCurrentHash: credential.passwordHash, newPasswordHash: newHash });
      } catch (err) {
        if (err instanceof OptimisticLockError) {
          throw ApiError.conflict("Your password was changed by another request. Sign in again.", "PASSWORD_CHANGED_CONCURRENTLY");
        }
        throw err;
      }
      // Every other session ends; the one making the change stays signed in.
      const otherSessionsEnded = await deps.sessions.revokeAllForUser({
        userId: principal.id,
        reason: "password_changed",
        exceptSessionId: principal.sessionId,
      });
      await audit(principal.id, "PASSWORD_CHANGED", principal.id, { otherSessionsEnded });
      return { otherSessionsEnded };
    },

    async requestPasswordReset(email, requestIp) {
      if (!deps.otp) throw ApiError.serviceUnavailable("Password reset is not available right now.", "PASSWORD_RESET_UNAVAILABLE");
      const user = await deps.users.findByEmail(email);
      if (!user || !user.email) {
        logger.info("password reset requested for an unknown email (not revealed to the caller)");
        return;
      }
      const issued = await deps.otp.issue({ userId: user.id, purpose: RESET_PURPOSE, destination: user.email });
      if (issued.outcome !== "success") {
        logger.warn("password reset code not issued", { userId: user.id, reason: issued.reason });
        return;
      }
      // The grant row records the request; its random value never leaves the server.
      await deps.accountSecurity.createResetGrant({
        userId: user.id,
        tokenHash: createHash("sha256").update(randomBytes(32)).digest(),
        expiresAt: new Date(issued.data.expiresAt),
        requestIp,
      });
      await audit(user.id, "PASSWORD_RESET_REQUESTED", user.id);
    },

    async resetPassword(email, code, newPassword) {
      if (!deps.otp) throw ApiError.serviceUnavailable("Password reset is not available right now.", "PASSWORD_RESET_UNAVAILABLE");
      assertPolicy(newPassword, "newPassword");
      const user = await deps.users.findByEmail(email);
      if (!user) throw ApiError.badRequest(RESET_FAILED, "RESET_CODE_INVALID");
      const verified = await deps.otp.verify({ userId: user.id, purpose: RESET_PURPOSE, code });
      if (verified.outcome !== "success") {
        await audit(user.id, "PASSWORD_RESET_FAILED", user.id, { reason: verified.reason });
        throw ApiError.badRequest(RESET_FAILED, "RESET_CODE_INVALID");
      }
      // The OTP is now consumed; the matching grant is consumed too (single use).
      if (!(await deps.accountSecurity.consumeResetGrant(user.id))) {
        await audit(user.id, "PASSWORD_RESET_FAILED", user.id, { reason: "no_live_reset_grant" });
        throw ApiError.badRequest(RESET_FAILED, "RESET_CODE_INVALID");
      }
      const newHash = await hashPassword(newPassword, "newPassword");
      try {
        await deps.credentials.resetPassword({ userId: user.id, newPasswordHash: newHash });
      } catch (err) {
        if (err instanceof RecordNotFoundError) throw ApiError.badRequest(RESET_FAILED, "RESET_CODE_INVALID");
        throw err;
      }
      const sessionsEnded = await deps.sessions.revokeAllForUser({ userId: user.id, reason: "password_changed" });
      await audit(user.id, "PASSWORD_RESET", user.id, { sessionsEnded });
    },

    async endOtherSessions(principal) {
      const sessionsEnded = await deps.sessions.revokeAllForUser({
        userId: principal.id,
        reason: "logout_all",
        exceptSessionId: principal.sessionId,
      });
      // Nothing ended: no audit row for a no-op.
      if (sessionsEnded > 0) await audit(principal.id, "SESSIONS_ENDED", principal.id, { sessionsEnded, kept: "current" });
      return { sessionsEnded };
    },

    async recordSessionEnded(principal, sessionId) {
      await audit(principal.id, "SESSION_ENDED", principal.id, { sessionId, current: sessionId === principal.sessionId });
    },

    async loginHistory(userId, limit) {
      return deps.accountSecurity.listLoginHistory(userId, limit);
    },
  };
};
