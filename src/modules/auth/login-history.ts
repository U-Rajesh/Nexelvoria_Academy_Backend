import { logger } from "../../utils/logger";
import type { UserRepository } from "../users/user.repository";
import type { AccountSecurityRepository } from "./account-security.repository";
import type { LoginService } from "./login.service";

/**
 * AUTH-008 / AUTH-014: records every sign-in attempt in NXA_LoginHistory.
 *
 * Wraps the existing login service without changing it. Stored: the
 * identifier typed (email or mobile), success flag, the login service's
 * machine reason code on failure, IP and device. Never the password.
 *
 * Recording is best effort: a failed history write is logged and never
 * changes the login outcome (a sign-in must not fail because history did).
 */
export const withLoginHistory = (
  inner: LoginService,
  deps: { users: () => UserRepository; accountSecurity: () => AccountSecurityRepository },
): LoginService => ({
  async login(input, client) {
    const result = await inner.login(input, client);
    try {
      const raw = (input as { identifier?: unknown } | null)?.identifier;
      const identifier = typeof raw === "string" ? raw.trim().slice(0, 254) : "";
      if (identifier !== "") {
        let userId: string | undefined;
        if (result.outcome === "success") {
          userId = result.data.user.id;
        } else {
          const users = deps.users();
          const user = identifier.includes("@") ? await users.findByEmail(identifier) : await users.findByMobile(identifier);
          userId = user?.id;
        }
        const device = [client?.device, client?.browser, client?.os].filter(Boolean).join(" · ");
        await deps.accountSecurity().recordLogin({
          userId,
          loginIdentifier: identifier,
          isSuccessful: result.outcome === "success",
          ...(result.outcome === "failure" ? { failureReason: result.reason } : {}),
          ...(client?.ipAddress ? { ipAddress: client.ipAddress } : {}),
          ...(device ? { deviceInfo: device } : {}),
        });
      }
    } catch (err) {
      logger.error("login history write failed", { errorType: err instanceof Error ? err.name : typeof err });
    }
    return result;
  },
});
