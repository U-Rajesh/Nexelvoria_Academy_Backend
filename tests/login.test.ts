import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

import { env } from "../src/config/env";
import type { UserRole } from "../src/contracts/user.contract";
import type { CredentialRepository } from "../src/modules/auth/credential.repository";
import {
  createLoginService,
  type LoginResult,
  type LoginService,
} from "../src/modules/auth/login.service";
import { hashPassword } from "../src/modules/auth/password.service";
import type { SessionRepository } from "../src/modules/auth/session.repository";
import { OptimisticLockError } from "../src/repositories/repository.errors";
import { hashRefreshToken } from "../src/modules/auth/token.service";
import type { User } from "../src/modules/users/user.types";
import { createTestHarness, type TestHarness } from "./fakes";

/**
 * Login service tests.
 *
 * Real argon2id and real JWTs throughout, over the in-memory fakes. Hashing
 * costs ~120ms, so a single password hash is reused across the suite where
 * the test is not about hashing itself.
 */

const PASSWORD = "Password@123";
const WRONG_PASSWORD = "WrongPass@456";
const THRESHOLD = 5;

/** Hashed once - argon2 is deliberately slow. */
let passwordHash: string;

/**
 * Returns `base` with some methods replaced.
 *
 * A typed proxy rather than an object spread: spreading a class instance
 * copies no prototype methods, and casting the result would strip the
 * contextual types off the overrides. Non-overridden methods are bound to
 * the original so `this` still resolves.
 */
const withOverrides = <T extends object>(base: T, overrides: Partial<T>): T =>
  new Proxy(base, {
    get(target, prop, receiver): unknown {
      if (prop in overrides) {
        return overrides[prop as keyof T];
      }

      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? (value as (...args: never[]) => unknown).bind(target) : value;
    },
  });

const userFixture = (overrides: Partial<User> = {}): User => ({
  id: "user-1",
  name: "Ananya Rao",
  email: "ananya@test.local",
  mobile: "9876543210",
  role: "student",
  status: "active",
  createdAt: new Date().toISOString(),
  ...overrides,
});

describe("login service", () => {
  let h: TestHarness;
  let service: LoginService;

  before(async () => {
    passwordHash = await hashPassword(PASSWORD);
  });

  beforeEach(() => {
    h = createTestHarness();
    service = createLoginService({
      users: h.users,
      credentials: h.credentials,
      sessions: h.sessions,
      maxFailedLoginAttempts: THRESHOLD,
    });
  });

  /** Seeds an active user with a working credential. */
  const seedUser = async (overrides: Partial<User> = {}): Promise<User> => {
    const user = h.users.seed(userFixture(overrides));
    await h.credentials.create({ userId: user.id, passwordHash });
    return user;
  };

  /** Builds a service with one dependency swapped for a broken one. */
  const serviceWith = (overrides: {
    sessions?: SessionRepository;
    credentials?: CredentialRepository;
  }): LoginService =>
    createLoginService({
      users: h.users,
      credentials: overrides.credentials ?? h.credentials,
      sessions: overrides.sessions ?? h.sessions,
      maxFailedLoginAttempts: THRESHOLD,
    });

  const expectFailure = (result: LoginResult): Extract<LoginResult, { outcome: "failure" }> => {
    assert.equal(result.outcome, "failure");
    if (result.outcome !== "failure") assert.fail("expected a failure");
    return result;
  };

  const expectSuccess = (result: LoginResult): Extract<LoginResult, { outcome: "success" }> => {
    assert.equal(result.outcome, "success", `expected success, got ${JSON.stringify(result)}`);
    if (result.outcome !== "success") assert.fail("expected success");
    return result;
  };

  describe("successful login", () => {
    it("authenticates by email and returns a complete result", async () => {
      const user = await seedUser();

      const result = await service.login({ identifier: user.email, password: PASSWORD });
      const { data } = expectSuccess(result);

      assert.equal(data.user.id, user.id);
      assert.ok(data.accessToken);
      assert.equal(data.expiresIn, 900, "15 minutes");
      assert.ok(data.refreshToken);
      assert.ok(data.refreshTokenExpiresAt);
      assert.ok(data.sessionId);
    });

    it("authenticates by 10-digit mobile number", async () => {
      const user = await seedUser();

      const result = await service.login({ identifier: user.mobile, password: PASSWORD });
      assert.equal(expectSuccess(result).data.user.id, user.id);
    });

    it("treats the email identifier case-insensitively", async () => {
      await seedUser({ email: "ananya@test.local" });

      const result = await service.login({
        identifier: "ANANYA@TEST.LOCAL",
        password: PASSWORD,
      });

      assert.equal(result.outcome, "success");
    });

    it("trims surrounding whitespace from the identifier", async () => {
      const user = await seedUser();

      const result = await service.login({
        identifier: `  ${user.email}  `,
        password: PASSWORD,
      });

      assert.equal(result.outcome, "success");
    });

    it("honours rememberMe by extending only the refresh lifetime", async () => {
      await seedUser();

      const normal = expectSuccess(
        await service.login({ identifier: "ananya@test.local", password: PASSWORD }),
      );

      h.sessions.reset();

      const remembered = expectSuccess(
        await service.login({
          identifier: "ananya@test.local",
          password: PASSWORD,
          rememberMe: true,
        }),
      );

      assert.ok(
        Date.parse(remembered.data.refreshTokenExpiresAt) >
          Date.parse(normal.data.refreshTokenExpiresAt),
        "remembered sessions last longer",
      );
      assert.equal(remembered.data.expiresIn, normal.data.expiresIn, "access token unchanged");
    });
  });

  describe("the access token", () => {
    it("carries the authoritative role and the session id", async () => {
      const user = await seedUser({ role: "admin" });

      const { data } = expectSuccess(
        await service.login({ identifier: user.email, password: PASSWORD }),
      );

      const claims = jwt.verify(data.accessToken, env.JWT_SECRET, {
        algorithms: ["HS256"],
        issuer: env.JWT_ISSUER,
        audience: env.JWT_AUDIENCE,
      }) as Record<string, unknown>;

      assert.equal(claims["sub"], user.id);
      assert.equal(claims["role"], "admin", "role comes from the user record");
      assert.equal(claims["sid"], data.sessionId, "linked to the session");
    });

    it("uses the stored role, never one supplied by the caller", async () => {
      const user = await seedUser({ role: "student" });

      const { data } = expectSuccess(
        await service.login({
          identifier: user.email,
          password: PASSWORD,
          // Extra fields are stripped by the schema and would be ignored
          // regardless: the role is read from the user record.
          role: "super_admin",
        } as unknown),
      );

      const claims = jwt.decode(data.accessToken) as Record<string, unknown>;
      assert.equal(claims["role"], "student", "client input must not influence the role");
    });

    it("issues a token for every role from the user record", async () => {
      for (const role of ["student", "teacher", "admin", "super_admin"] as const) {
        h.reset();
        const user = h.users.seed(
          userFixture({ id: `user-${role}`, email: `${role}@test.local`, mobile: "9000000001", role }),
        );
        await h.credentials.create({ userId: user.id, passwordHash });

        const { data } = expectSuccess(
          await service.login({ identifier: user.email, password: PASSWORD }),
        );

        const claims = jwt.decode(data.accessToken) as Record<string, unknown>;
        assert.equal(claims["role"], role as UserRole);
      }
    });
  });

  describe("the session", () => {
    it("stores only the refresh token HASH, never the raw token", async () => {
      const user = await seedUser();

      const { data } = expectSuccess(
        await service.login({ identifier: user.email, password: PASSWORD }),
      );

      const session = await h.sessions.findBySessionId(data.sessionId);
      assert.ok(session);

      assert.equal(session.refreshTokenHash, hashRefreshToken(data.refreshToken));
      assert.notEqual(session.refreshTokenHash, data.refreshToken);
      assert.equal(
        JSON.stringify(session).includes(data.refreshToken),
        false,
        "the raw refresh token must never be persisted",
      );
    });

    it("records client metadata without using it for authorization", async () => {
      const user = await seedUser();

      const { data } = expectSuccess(
        await service.login(
          { identifier: user.email, password: PASSWORD },
          {
            device: "Windows Desktop",
            browser: "Chrome 131.0",
            os: "Windows 11",
            ipAddress: "203.0.113.10",
            location: "Hyderabad, India",
          },
        ),
      );

      const session = await h.sessions.findBySessionId(data.sessionId);
      assert.equal(session?.device, "Windows Desktop");
      assert.equal(session?.ipAddress, "203.0.113.10");
    });

    it("opens the session as active and owned by the user", async () => {
      const user = await seedUser();

      const { data } = expectSuccess(
        await service.login({ identifier: user.email, password: PASSWORD }),
      );

      const session = await h.sessions.findBySessionId(data.sessionId);
      assert.equal(session?.userId, user.id);
      assert.equal(session?.revokedAt, undefined);
    });
  });

  describe("rejected logins", () => {
    it("rejects a wrong password generically", async () => {
      const user = await seedUser();

      const failure = expectFailure(
        await service.login({ identifier: user.email, password: WRONG_PASSWORD }),
      );

      assert.equal(failure.reason, "invalid_credentials");
      // No attempt count in the result: a field present for a known user and
      // absent for an unknown one is an account-existence oracle.
      assert.equal("attemptsRemaining" in failure, false);
    });

    it("rejects an unknown user with the SAME reason", async () => {
      await seedUser();

      const failure = expectFailure(
        await service.login({ identifier: "nobody@test.local", password: PASSWORD }),
      );

      // Identical to a wrong password: no enumeration.
      assert.equal(failure.reason, "invalid_credentials");
      assert.equal("attemptsRemaining" in failure, false);
    });

    it("rejects an unknown mobile number with the same reason", async () => {
      await seedUser();

      const failure = expectFailure(
        await service.login({ identifier: "9111111111", password: PASSWORD }),
      );

      assert.equal(failure.reason, "invalid_credentials");
    });

    it("rejects a user with no credential, indistinguishably", async () => {
      // A data fault, not something a caller should be able to detect.
      h.users.seed(userFixture());

      const failure = expectFailure(
        await service.login({ identifier: "ananya@test.local", password: PASSWORD }),
      );

      assert.equal(failure.reason, "invalid_credentials");
    });

    it("rejects malformed input without counting an attempt", async () => {
      const user = await seedUser();

      for (const input of [
        {},
        { identifier: "", password: PASSWORD },
        { identifier: user.email },
        { identifier: user.email, password: "" },
        { identifier: "ab", password: PASSWORD },
        null,
        "not-an-object",
      ]) {
        const failure = expectFailure(await service.login(input));
        assert.equal(failure.reason, "invalid_credentials");
      }

      const credential = await h.credentials.findByUserId(user.id);
      assert.equal(credential?.failedLoginAttempts, 0, "malformed input is not an attempt");
    });

    it("creates no session and issues no token on failure", async () => {
      const user = await seedUser();

      const result = await service.login({ identifier: user.email, password: WRONG_PASSWORD });

      assert.equal(result.outcome, "failure");
      assert.equal(h.sessions.count, 0, "no session may exist for a failed login");
      assert.deepEqual(await h.sessions.listSessionsForUser(user.id), []);
    });
  });

  describe("account state (checked only after the password is proven)", () => {
    it("rejects a pending account", async () => {
      const user = await seedUser({ status: "pending" });

      const failure = expectFailure(
        await service.login({ identifier: user.email, password: PASSWORD }),
      );

      assert.equal(failure.reason, "account_pending");
      assert.equal(h.sessions.count, 0);
    });

    it("rejects a suspended account", async () => {
      const user = await seedUser({ status: "suspended" });

      assert.equal(
        expectFailure(await service.login({ identifier: user.email, password: PASSWORD })).reason,
        "account_suspended",
      );
    });

    it("rejects a deactivated account", async () => {
      const user = await seedUser({ status: "deactivated" });

      assert.equal(
        expectFailure(await service.login({ identifier: user.email, password: PASSWORD })).reason,
        "account_deactivated",
      );
    });

    it("reports invalid_credentials — NOT the status — for a wrong password", async () => {
      // State must only be disclosed to someone who proved the credentials.
      const user = await seedUser({ status: "suspended" });

      assert.equal(
        expectFailure(await service.login({ identifier: user.email, password: WRONG_PASSWORD }))
          .reason,
        "invalid_credentials",
        "a suspended account must not be revealed by a wrong-password attempt",
      );
    });

    it("uses the authoritative status, not anything from the caller", async () => {
      const user = await seedUser({ status: "suspended" });

      const failure = expectFailure(
        await service.login({
          identifier: user.email,
          password: PASSWORD,
          status: "active",
        } as unknown),
      );

      assert.equal(failure.reason, "account_suspended");
    });
  });

  describe("lockout", () => {
    it("increments the counter on each failure", async () => {
      const user = await seedUser();

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const failure = expectFailure(
          await service.login({ identifier: user.email, password: WRONG_PASSWORD }),
        );

        assert.equal(failure.reason, "invalid_credentials");
        // The count is tracked authoritatively in the credential store and
        // logged for operators - it is never returned.
        assert.equal("attemptsRemaining" in failure, false);
        assert.equal(
          (await h.credentials.findByUserId(user.id))?.failedLoginAttempts,
          attempt,
        );
      }

      assert.equal((await h.credentials.findByUserId(user.id))?.failedLoginAttempts, 3);
    });

    it("locks on the fifth consecutive failure", async () => {
      const user = await seedUser();

      for (let i = 0; i < THRESHOLD; i += 1) {
        await service.login({ identifier: user.email, password: WRONG_PASSWORD });
      }

      const credential = await h.credentials.findByUserId(user.id);
      assert.equal(credential?.failedLoginAttempts, THRESHOLD);

      // Even the CORRECT password is now refused.
      const failure = expectFailure(
        await service.login({ identifier: user.email, password: PASSWORD }),
      );

      assert.equal(failure.reason, "account_locked");
      assert.equal(h.sessions.count, 0, "a locked account gets no session");
    });

    it("does not unlock on a correct password — no automatic unlock", async () => {
      // Current policy (Q4a): locked until a verified password reset or an
      // administrator unlock.
      const user = await seedUser();

      for (let i = 0; i < THRESHOLD; i += 1) {
        await service.login({ identifier: user.email, password: WRONG_PASSWORD });
      }

      await service.login({ identifier: user.email, password: PASSWORD });
      await service.login({ identifier: user.email, password: PASSWORD });

      const credential = await h.credentials.findByUserId(user.id);
      assert.ok(credential);
      assert.ok(credential.failedLoginAttempts >= THRESHOLD, "still locked");
    });

    it("an administrator unlock restores access", async () => {
      const user = await seedUser();

      for (let i = 0; i < THRESHOLD; i += 1) {
        await service.login({ identifier: user.email, password: WRONG_PASSWORD });
      }

      await h.credentials.clearLockout(user.id);

      const result = await service.login({ identifier: user.email, password: PASSWORD });
      assert.equal(result.outcome, "success", "unlock is the confirmed recovery path");
    });

    it("resets the counter after a successful login", async () => {
      const user = await seedUser();

      await service.login({ identifier: user.email, password: WRONG_PASSWORD });
      await service.login({ identifier: user.email, password: WRONG_PASSWORD });

      assert.equal((await h.credentials.findByUserId(user.id))?.failedLoginAttempts, 2);

      await service.login({ identifier: user.email, password: PASSWORD });

      assert.equal(
        (await h.credentials.findByUserId(user.id))?.failedLoginAttempts,
        0,
        "confirmed: success zeroes the counter",
      );
    });

    it("counts no attempt against an unknown user", async () => {
      await seedUser();

      await service.login({ identifier: "nobody@test.local", password: WRONG_PASSWORD });

      assert.equal((await h.credentials.findByUserId("user-1"))?.failedLoginAttempts, 0);
    });
  });

  describe("password rehash", () => {
    /** Seeds a credential hashed with weaker-than-current parameters. */
    const seedLegacyCredential = async (user: User): Promise<string> => {
      const argon2 = (await import("argon2")).default;

      const legacy = await argon2.hash(PASSWORD, {
        type: argon2.argon2id,
        memoryCost: 19_456,
        timeCost: 2,
        parallelism: 1,
      });

      await h.credentials.create({ userId: user.id, passwordHash: legacy });
      return legacy;
    };

    it("upgrades a weak hash on a successful login", async () => {
      const user = h.users.seed(userFixture());
      const legacy = await seedLegacyCredential(user);

      const result = await service.login({ identifier: user.email, password: PASSWORD });
      assert.equal(result.outcome, "success");

      const credential = await h.credentials.findByUserId(user.id);
      assert.ok(credential);
      assert.notEqual(credential.passwordHash, legacy, "the hash was upgraded");
      assert.match(credential.passwordHash, /m=47104,t=2/, "now at current parameters");
    });

    it("does not change passwordUpdatedAt when rehashing", async () => {
      const user = h.users.seed(userFixture());
      await seedLegacyCredential(user);

      const before = await h.credentials.findByUserId(user.id);
      assert.ok(before);

      await service.login({ identifier: user.email, password: PASSWORD });

      const after = await h.credentials.findByUserId(user.id);
      assert.equal(
        after?.passwordUpdatedAt,
        before.passwordUpdatedAt,
        "a rehash is a storage upgrade, not a password change",
      );
    });

    it("leaves a current hash untouched", async () => {
      const user = await seedUser();

      await service.login({ identifier: user.email, password: PASSWORD });

      assert.equal((await h.credentials.findByUserId(user.id))?.passwordHash, passwordHash);
    });

    it("REFUSES the login when the password actually changed during the rehash", async () => {
      // The verification is stale: issuing a session would grant access on
      // the strength of a password that is no longer current.
      //
      // Note what is simulated: a REAL concurrent change (the stored hash
      // becomes a third value), not merely a thrown OptimisticLockError. A
      // CAS failure on its own no longer decides the login - the
      // authorization gate reads the authoritative hash and decides, which
      // is why this test changes the data rather than just the error.
      const user = h.users.seed(userFixture());
      await seedLegacyCredential(user);

      const racing = withOverrides<CredentialRepository>(h.credentials, {
        rehashPassword: async () => {
          // Someone else's password change lands first.
          await h.credentials.resetPassword({
            userId: user.id,
            newPasswordHash: "$argon2id$v=19$m=47104,t=2,p=1$c29tZW9uZWVsc2U$Y2hhbmdlZA",
          });

          throw new OptimisticLockError("credential", user.id);
        },
      });

      const failure = expectFailure(
        await serviceWith({ credentials: racing }).login({
          identifier: user.email,
          password: PASSWORD,
        }),
      );

      assert.equal(failure.reason, "password_changed_concurrently");
      assert.equal(h.sessions.count, 0, "no session on a stale verification");
    });

    it("still logs in when a rehash reports an error but nothing changed", async () => {
      // A lost CAS or a timeout where the stored hash is still the one we
      // verified is not an authentication problem: the gate accepts it.
      const user = h.users.seed(userFixture());
      await seedLegacyCredential(user);

      const noisy = withOverrides<CredentialRepository>(h.credentials, {
        rehashPassword: () => {
          throw new OptimisticLockError("credential", user.id);
        },
      });

      const result = await serviceWith({ credentials: noisy }).login({
        identifier: user.email,
        password: PASSWORD,
      });

      assert.equal(result.outcome, "success", "an unchanged hash is still authoritative");
    });

    it("still logs in when the rehash fails for an unrelated reason", async () => {
      // The password was correct and the stored hash is still usable, so an
      // upgrade problem must not deny a valid login.
      const user = h.users.seed(userFixture());
      await seedLegacyCredential(user);

      const flaky = withOverrides<CredentialRepository>(h.credentials, {
        rehashPassword: () => {
          throw new Error("write timeout");
        },
      });

      const result = await serviceWith({ credentials: flaky }).login({
        identifier: user.email,
        password: PASSWORD,
      });

      assert.equal(result.outcome, "success", "an upgrade failure is not an auth failure");
    });
  });

  describe("infrastructure failures", () => {
    it("fails closed when the session cannot be created", async () => {
      const user = await seedUser();

      const broken = withOverrides<SessionRepository>(h.sessions, {
        create: () => {
          throw new Error("connection reset");
        },
      });

      const failure = expectFailure(
        await serviceWith({ sessions: broken }).login({
          identifier: user.email,
          password: PASSWORD,
        }),
      );

      assert.equal(failure.reason, "authentication_unavailable");
      assert.equal(h.sessions.count, 0, "no partial state");
    });

    it("revokes the session when the token cannot be issued", async () => {
      // No unit of work across repositories, so the orphan is compensated
      // explicitly rather than left active.
      //
      // The failure is induced realistically: a user row carrying the
      // `public` role reaches token issuance (login checks status and
      // lockout, not role) and `issueAccessToken` refuses it, because
      // `public` means "not authenticated". That is itself a guard worth
      // having - such a row must never yield a token.
      const user = await seedUser({ role: "public" });

      const failure = expectFailure(
        await service.login({ identifier: user.email, password: PASSWORD }),
      );

      assert.equal(failure.reason, "authentication_unavailable");

      // A session WAS created before the token failed; it must not remain
      // usable, because its refresh token was never returned to anyone.
      const active = await h.sessions.listSessionsForUser(user.id);
      assert.deepEqual(active, [], "no active session may survive a failed token issue");

      const all = await h.sessions.listSessionsForUser(user.id, {
        includeRevoked: true,
        includeExpired: true,
      });

      assert.equal(all.length, 1, "the orphan exists...");
      assert.ok(all[0]?.revokedAt, "...and was revoked by the compensating action");
    });

    it("fails closed when the conditional counter reset throws", async () => {
      // Changed deliberately: a throw leaves both the counter and the lock
      // state unknown, so the login must not proceed.
      const user = await seedUser();

      const flaky = withOverrides<CredentialRepository>(h.credentials, {
        resetFailedAttemptsIfAuthorized: () => {
          throw new Error("write timeout");
        },
      });

      const failure = expectFailure(
        await serviceWith({ credentials: flaky }).login({
          identifier: user.email,
          password: PASSWORD,
        }),
      );

      assert.equal(failure.reason, "authentication_unavailable");
      assert.equal(h.sessions.count, 0);
    });
  });

  describe("no sensitive information leaks", () => {
    it("never returns a credential hash in the result", async () => {
      const user = await seedUser();

      const { data } = expectSuccess(
        await service.login({ identifier: user.email, password: PASSWORD }),
      );

      const serialised = JSON.stringify(data);

      assert.equal(serialised.includes(passwordHash), false, "no hash in the result");
      assert.equal(serialised.includes("argon2"), false, "not even a fragment");
      assert.equal("passwordHash" in data.user, false, "User carries no hash by design");
    });

    it("never returns the plaintext password", async () => {
      const user = await seedUser();

      const result = await service.login({ identifier: user.email, password: PASSWORD });

      assert.equal(JSON.stringify(result).includes(PASSWORD), false);
    });

    it("never returns the signing secret", async () => {
      const user = await seedUser();

      const result = await service.login({ identifier: user.email, password: PASSWORD });

      assert.equal(JSON.stringify(result).includes(env.JWT_SECRET), false);
    });

    it("returns no refresh token on a failure", async () => {
      const user = await seedUser();

      const failure = expectFailure(
        await service.login({ identifier: user.email, password: WRONG_PASSWORD }),
      );

      assert.equal("refreshToken" in failure, false);
      assert.equal("accessToken" in failure, false);
      assert.equal("user" in failure, false, "a failure reveals nothing about the account");
    });

    it("keeps the failure shape minimal and uniform", async () => {
      const user = await seedUser();

      const wrongPassword = expectFailure(
        await service.login({ identifier: user.email, password: WRONG_PASSWORD }),
      );
      const unknownUser = expectFailure(
        await service.login({ identifier: "nobody@test.local", password: PASSWORD }),
      );

      // IDENTICAL shape and reason for a known and an unknown user, so a
      // controller cannot leak account existence by serialising the result.
      assert.deepEqual(Object.keys(wrongPassword).sort(), ["outcome", "reason"]);
      assert.deepEqual(Object.keys(unknownUser).sort(), ["outcome", "reason"]);
      assert.deepEqual(wrongPassword, unknownUser, "externally indistinguishable");
    });
  });

  describe("safe error logging", () => {
    /** Swaps console.* for a collector. Restored by the returned function. */
    const captureLogs = (): { lines: string[]; restore: () => void } => {
      const lines: string[] = [];
      const originalError = console.error;
      const originalWarn = console.warn;
      const originalLog = console.log;

      const capture = (...args: unknown[]): void => {
        lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      };

      console.error = capture;
      console.warn = capture;
      console.log = capture;

      return {
        lines,
        restore: () => {
          console.error = originalError;
          console.warn = originalWarn;
          console.log = originalLog;
        },
      };
    };

    /**
     * A driver-style exception stuffed with secrets.
     *
     * SQL Server really does put the login name in its error text, and a
     * connection-string parse failure really can echo the password. The
     * login service must log the error's CLASS and nothing else.
     */
    const SENSITIVE =
      "Login failed for user 'sa' with password 'P@ssw0rd!' on server " +
      "db-prod-01.internal:1433 (connection string " +
      "Server=db-prod-01;User Id=sa;Password=P@ssw0rd!;)";

    const SECRETS = ["P@ssw0rd!", "db-prod-01", "1433", "Password=", "Login failed for user"];

    const assertNoSecrets = (lines: string[]): string => {
      const output = lines.join("\n");

      for (const secret of SECRETS) {
        assert.equal(output.includes(secret), false, `logs must not contain ${secret}`);
      }

      return output;
    };

    it("logs no driver message when the credential lookup fails", async () => {
      const user = await seedUser();

      const broken = withOverrides<CredentialRepository>(h.credentials, {
        findByUserId: () => {
          throw new Error(SENSITIVE);
        },
      });

      const captured = captureLogs();

      try {
        const result = await serviceWith({ credentials: broken }).login({
          identifier: user.email,
          password: PASSWORD,
        });

        assert.equal(
          expectFailure(result).reason,
          "authentication_unavailable",
          "a repository fault must fail CLOSED, not throw out of login()",
        );
      } finally {
        captured.restore();
      }

      const output = assertNoSecrets(captured.lines);

      // No user id here on purpose: this read is what establishes who the
      // caller is, so when it fails there is no trusted id to log. The
      // error class is the whole payload.
      assert.ok(output.includes("Error"), "the error CLASS is logged");
      assert.equal(output.includes(user.email), false, "the identifier is not logged either");
    });

    it("logs no driver message when recording a failed attempt fails", async () => {
      const user = await seedUser();

      const broken = withOverrides<CredentialRepository>(h.credentials, {
        recordFailedAttempt: () => {
          throw new Error(SENSITIVE);
        },
      });

      const captured = captureLogs();

      try {
        await serviceWith({ credentials: broken }).login({
          identifier: user.email,
          password: WRONG_PASSWORD,
        });
      } finally {
        captured.restore();
      }

      assertNoSecrets(captured.lines);
    });

    it("logs no driver message when the guarded reset fails", async () => {
      const user = await seedUser();

      const broken = withOverrides<CredentialRepository>(h.credentials, {
        resetFailedAttemptsIfAuthorized: () => {
          throw new Error(SENSITIVE);
        },
      });

      const captured = captureLogs();

      try {
        await serviceWith({ credentials: broken }).login({
          identifier: user.email,
          password: PASSWORD,
        });
      } finally {
        captured.restore();
      }

      assertNoSecrets(captured.lines);
    });

    it("logs no driver message when session creation fails", async () => {
      const user = await seedUser();

      const broken = withOverrides<SessionRepository>(h.sessions, {
        create: () => {
          throw new Error(SENSITIVE);
        },
      });

      const captured = captureLogs();

      try {
        const result = await serviceWith({ sessions: broken }).login({
          identifier: user.email,
          password: PASSWORD,
        });

        assert.equal(expectFailure(result).reason, "authentication_unavailable");
      } finally {
        captured.restore();
      }

      assertNoSecrets(captured.lines);
    });

    it("logs no driver message when a rehash fails", async () => {
      // Seeded with weak parameters so a successful verification asks for a
      // rehash, which then fails with a secret-bearing exception.
      const user = h.users.seed(userFixture());
      const argon2 = (await import("argon2")).default;
      const weakHash = await argon2.hash(PASSWORD, {
        type: argon2.argon2id,
        memoryCost: 19_456,
        timeCost: 2,
        parallelism: 1,
      });
      await h.credentials.create({ userId: user.id, passwordHash: weakHash });

      const broken = withOverrides<CredentialRepository>(h.credentials, {
        rehashPassword: () => {
          throw new Error(SENSITIVE);
        },
      });

      const captured = captureLogs();

      try {
        await serviceWith({ credentials: broken }).login({
          identifier: user.email,
          password: PASSWORD,
        });
      } finally {
        captured.restore();
      }

      assertNoSecrets(captured.lines);
    });

    it("never logs the submitted password, right or wrong", async () => {
      const user = await seedUser();
      const captured = captureLogs();

      try {
        await service.login({ identifier: user.email, password: PASSWORD });
        await service.login({ identifier: user.email, password: WRONG_PASSWORD });
        await service.login({ identifier: "nobody@test.local", password: PASSWORD });
      } finally {
        captured.restore();
      }

      const output = captured.lines.join("\n");

      assert.equal(output.includes(PASSWORD), false, "the correct password is never logged");
      assert.equal(output.includes(WRONG_PASSWORD), false, "nor a wrong one");
    });
  });
});
