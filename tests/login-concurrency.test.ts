import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

import type { UserRole } from "../src/contracts/user.contract";
import type { CredentialRepository } from "../src/modules/auth/credential.repository";
import {
  createLoginService,
  type LoginResult,
  type LoginService,
} from "../src/modules/auth/login.service";
import { hashPassword } from "../src/modules/auth/password.service";
import type { SessionRepository } from "../src/modules/auth/session.repository";
import type { UserRepository } from "../src/modules/users/user.repository";
import type { User } from "../src/modules/users/user.types";
import { createTestHarness, type TestHarness } from "./fakes";

/**
 * Step 6H security hardening: time-of-check / time-of-use races.
 *
 * Every race is simulated DETERMINISTICALLY by injecting repository
 * behaviour that mutates state at a known point - no sleeps, no timers, no
 * reliance on scheduling. A counter-based override fires on a chosen call,
 * which is what makes "the password changed between verification and token
 * issuance" reproducible.
 *
 * The defect being guarded against: the service verified the password and
 * read the user, then did further work. The snapshot could go stale, and a
 * session could be issued for an account that had since been suspended,
 * locked, demoted, or had its password changed.
 */

const PASSWORD = "Password@123";
const WRONG_PASSWORD = "WrongPass@456";
const THRESHOLD = 5;

let passwordHash: string;

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

/** Returns `base` with some methods replaced, preserving `this` binding. */
const withOverrides = <T extends object>(base: T, overrides: Partial<T>): T =>
  new Proxy(base, {
    get(target, prop, receiver): unknown {
      if (prop in overrides) {
        return overrides[prop as keyof T];
      }

      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function"
        ? (value as (...args: never[]) => unknown).bind(target)
        : value;
    },
  });

/**
 * Runs `effect` on the nth call of a wrapped method.
 *
 * The deterministic barrier: the service reads the user twice (once up
 * front, once per authorization gate), so firing on a chosen call number
 * places the simulated concurrent change at an exact point in the flow.
 */
const onCall = (n: number, effect: () => void | Promise<void>): (() => Promise<void>) => {
  let calls = 0;

  return async (): Promise<void> => {
    calls += 1;
    if (calls === n) {
      await effect();
    }
  };
};

describe("login concurrency and stale-state hardening", () => {
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

  const seedUser = async (overrides: Partial<User> = {}): Promise<User> => {
    const user = h.users.seed(userFixture(overrides));
    await h.credentials.create({ userId: user.id, passwordHash });
    return user;
  };

  const serviceWith = (overrides: {
    users?: UserRepository;
    credentials?: CredentialRepository;
    sessions?: SessionRepository;
  }): LoginService =>
    createLoginService({
      users: overrides.users ?? h.users,
      credentials: overrides.credentials ?? h.credentials,
      sessions: overrides.sessions ?? h.sessions,
      maxFailedLoginAttempts: THRESHOLD,
    });

  const expectFailure = (result: LoginResult): Extract<LoginResult, { outcome: "failure" }> => {
    assert.equal(result.outcome, "failure", `expected failure, got ${JSON.stringify(result)}`);
    if (result.outcome !== "failure") assert.fail("expected a failure");
    return result;
  };

  /** No session may be left usable after a refused login. */
  const assertNoUsableSession = async (userId: string): Promise<void> => {
    assert.deepEqual(
      await h.sessions.listSessionsForUser(userId),
      [],
      "no active session may survive a refused login",
    );
  };

  describe("password changed after verification", () => {
    it("refuses when the stored hash changes before the session is created", async () => {
      const user = await seedUser();

      // Fires on the FIRST fresh credential read, i.e. the pre-session gate.
      const fire = onCall(2, async () => {
        await h.credentials.resetPassword({
          userId: user.id,
          newPasswordHash: "$argon2id$v=19$m=47104,t=2,p=1$b3RoZXI$Y2hhbmdlZA",
        });
      });

      const racing = withOverrides<CredentialRepository>(h.credentials, {
        findByUserId: async (id) => {
          await fire();
          return h.credentials.findByUserId(id);
        },
      });

      const failure = expectFailure(
        await serviceWith({ credentials: racing }).login({
          identifier: user.email,
          password: PASSWORD,
        }),
      );

      assert.equal(failure.reason, "password_changed_concurrently");
      assert.equal(h.sessions.count, 0, "no session was created at all");
    });

    it("refuses AND revokes when the hash changes after the session is created", async () => {
      const user = await seedUser();

      // Call 1 = initial read, call 2 = pre-session gate, call 3 = final
      // gate. Firing on 3 means the change lands after the session exists,
      // which is exactly the window the post-create gate closes.
      const fire = onCall(3, async () => {
        await h.credentials.resetPassword({
          userId: user.id,
          newPasswordHash: "$argon2id$v=19$m=47104,t=2,p=1$bGF0ZXI$Y2hhbmdlZA",
        });
      });

      const racing = withOverrides<CredentialRepository>(h.credentials, {
        findByUserId: async (id) => {
          await fire();
          return h.credentials.findByUserId(id);
        },
      });

      const failure = expectFailure(
        await serviceWith({ credentials: racing }).login({
          identifier: user.email,
          password: PASSWORD,
        }),
      );

      assert.equal(failure.reason, "password_changed_concurrently");

      // The session WAS created, then revoked by the compensating action.
      const all = await h.sessions.listSessionsForUser(user.id, {
        includeRevoked: true,
        includeExpired: true,
      });

      assert.equal(all.length, 1, "a session was created...");
      assert.ok(all[0]?.revokedAt, "...and then revoked");
      await assertNoUsableSession(user.id);
    });

    it("accepts the upgraded hash written by its own rehash", async () => {
      // The gate must accept EITHER the hash it verified or the one it just
      // wrote, or a successful rehash would look like someone else's change.
      const argon2 = (await import("argon2")).default;

      const user = h.users.seed(userFixture());
      const legacy = await argon2.hash(PASSWORD, {
        type: argon2.argon2id,
        memoryCost: 19_456,
        timeCost: 2,
        parallelism: 1,
      });

      await h.credentials.create({ userId: user.id, passwordHash: legacy });

      const result = await service.login({ identifier: user.email, password: PASSWORD });

      assert.equal(result.outcome, "success", "its own upgrade must not be mistaken for a change");

      const stored = await h.credentials.findByUserId(user.id);
      assert.notEqual(stored?.passwordHash, legacy, "the upgrade landed");
    });
  });

  describe("account state changed during login", () => {
    /** Builds a user repository that flips status on the nth read. */
    const flippingUsers = (user: User, call: number, status: User["status"]): UserRepository => {
      const fire = onCall(call, () => {
        h.users.seed({ ...user, status });
      });

      return withOverrides<UserRepository>(h.users, {
        findById: async (id) => {
          await fire();
          return h.users.findById(id);
        },
      });
    };

    it("refuses when the account is suspended before the session is created", async () => {
      const user = await seedUser();

      const failure = expectFailure(
        await serviceWith({ users: flippingUsers(user, 1, "suspended") }).login({
          identifier: user.email,
          password: PASSWORD,
        }),
      );

      assert.equal(failure.reason, "account_suspended");
      assert.equal(h.sessions.count, 0);
    });

    it("refuses AND revokes when suspension lands after the session is created", async () => {
      const user = await seedUser();

      // findById is called by the pre-session gate (1) and the final gate (2).
      const failure = expectFailure(
        await serviceWith({ users: flippingUsers(user, 2, "suspended") }).login({
          identifier: user.email,
          password: PASSWORD,
        }),
      );

      assert.equal(failure.reason, "account_suspended");

      const all = await h.sessions.listSessionsForUser(user.id, {
        includeRevoked: true,
        includeExpired: true,
      });

      assert.equal(all.length, 1);
      assert.ok(all[0]?.revokedAt, "the session created moments earlier is revoked");
      await assertNoUsableSession(user.id);
    });

    it("refuses when the account is deactivated mid-login", async () => {
      const user = await seedUser();

      const failure = expectFailure(
        await serviceWith({ users: flippingUsers(user, 2, "deactivated") }).login({
          identifier: user.email,
          password: PASSWORD,
        }),
      );

      assert.equal(failure.reason, "account_deactivated");
      await assertNoUsableSession(user.id);
    });

    it("refuses when the user is deleted mid-login", async () => {
      const user = await seedUser();

      const fire = onCall(2, () => {
        h.users.reset();
      });

      const vanishing = withOverrides<UserRepository>(h.users, {
        findById: async (id) => {
          await fire();
          return h.users.findById(id);
        },
      });

      const failure = expectFailure(
        await serviceWith({ users: vanishing }).login({
          identifier: user.email,
          password: PASSWORD,
        }),
      );

      assert.equal(failure.reason, "invalid_credentials");
      await assertNoUsableSession(user.id);
    });
  });

  describe("role changed during login", () => {
    it("mints the JWT with the role from the FINAL authoritative read", async () => {
      const user = await seedUser({ role: "super_admin" });

      // Demoted after the initial read: the token must carry the new role,
      // not the privileged one captured before verification.
      const fire = onCall(2, () => {
        h.users.seed({ ...user, role: "student" });
      });

      const demoting = withOverrides<UserRepository>(h.users, {
        findById: async (id) => {
          await fire();
          return h.users.findById(id);
        },
      });

      const result = await serviceWith({ users: demoting }).login({
        identifier: user.email,
        password: PASSWORD,
      });

      assert.equal(result.outcome, "success");
      if (result.outcome !== "success") return;

      const claims = jwt.decode(result.data.accessToken) as Record<string, unknown>;

      assert.equal(
        claims["role"],
        "student" as UserRole,
        "a demotion mid-login must not yield a privileged token",
      );
      assert.equal(result.data.user.role, "student", "the returned user matches the token");
    });

    it("reflects a promotion from the final read too", async () => {
      const user = await seedUser({ role: "student" });

      const fire = onCall(2, () => {
        h.users.seed({ ...user, role: "teacher" });
      });

      const promoting = withOverrides<UserRepository>(h.users, {
        findById: async (id) => {
          await fire();
          return h.users.findById(id);
        },
      });

      const result = await serviceWith({ users: promoting }).login({
        identifier: user.email,
        password: PASSWORD,
      });

      assert.equal(result.outcome, "success");
      if (result.outcome !== "success") return;

      const claims = jwt.decode(result.data.accessToken) as Record<string, unknown>;
      assert.equal(claims["role"], "teacher");
    });
  });

  describe("concurrent lockout cannot be bypassed", () => {
    it("refuses when a concurrent fifth failure locks the credential", async () => {
      const user = await seedUser();

      // Four failures already recorded; the fifth lands while our correct
      // password is being verified.
      for (let i = 0; i < THRESHOLD - 1; i += 1) {
        await h.credentials.recordFailedAttempt({
          userId: user.id,
          threshold: THRESHOLD,
        });
      }

      // The barrier sits ON the reset itself, which is the exact sequence
      // under review: the fifth failure lands while the password is being
      // verified, and the reset is attempted immediately afterwards.
      //
      // NO crutch: the reset runs for real. This test previously forced it
      // to throw, which HID the defect - an unconditional reset would have
      // erased the lock here and the login would have SUCCEEDED.
      const racing = withOverrides<CredentialRepository>(h.credentials, {
        resetFailedAttemptsIfAuthorized: async (input) => {
          // ...the concurrent fifth failure lands first.
          await h.credentials.recordFailedAttempt({
            userId: user.id,
            threshold: THRESHOLD,
          });

          // ...and the real, guarded reset now runs against a locked row.
          return h.credentials.resetFailedAttemptsIfAuthorized(input);
        },
      });

      const failure = expectFailure(
        await serviceWith({ credentials: racing }).login({
          identifier: user.email,
          password: PASSWORD,
        }),
      );

      assert.equal(
        failure.reason,
        "account_locked",
        "an authoritative locked state must not be bypassed by a correct password",
      );
      assert.equal(h.sessions.count, 0);
      assert.equal(
        (await h.credentials.findByUserId(user.id))?.failedLoginAttempts,
        THRESHOLD,
        "the lock must NOT have been erased by the reset",
      );
    });

    it("refuses AND revokes when the lock lands after the session is created", async () => {
      const user = await seedUser();

      // The conditional reset zeroes the counter, so a lock landing after
      // the session exists needs a full burst - which is what a parallel
      // guessing attack looks like.
      const fire = onCall(3, async () => {
        for (let i = 0; i < THRESHOLD; i += 1) {
          await h.credentials.recordFailedAttempt({ userId: user.id, threshold: THRESHOLD });
        }
      });

      const racing = withOverrides<CredentialRepository>(h.credentials, {
        findByUserId: async (id) => {
          await fire();
          return h.credentials.findByUserId(id);
        },
      });

      const failure = expectFailure(
        await serviceWith({ credentials: racing }).login({
          identifier: user.email,
          password: PASSWORD,
        }),
      );

      assert.equal(failure.reason, "account_locked");
      await assertNoUsableSession(user.id);
    });

    it("a failed counter reset does not grant a login when the state is locked", async () => {
      // Issue 2: previously the reset failure was logged and login continued
      // on the pre-verification snapshot, which could bypass a lockout.
      const user = await seedUser();

      for (let i = 0; i < THRESHOLD; i += 1) {
        await h.credentials.recordFailedAttempt({
          userId: user.id,
          threshold: THRESHOLD,
        });
      }

      // Already locked, so the snapshot check catches it first.
      const failure = expectFailure(
        await service.login({ identifier: user.email, password: PASSWORD }),
      );

      assert.equal(failure.reason, "account_locked");
    });

    it("fails closed when the conditional reset reports a storage error", async () => {
      // Stricter than before: a throw leaves BOTH the counter and the lock
      // state unknown, so the login cannot safely proceed.
      const user = await seedUser();

      await h.credentials.recordFailedAttempt({ userId: user.id, threshold: THRESHOLD });

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
      assert.equal(h.sessions.count, 0, "no session when the state is unknown");
    });

    it("refuses when the conditional reset reports a hash conflict", async () => {
      const user = await seedUser();

      const conflicting = withOverrides<CredentialRepository>(h.credentials, {
        resetFailedAttemptsIfAuthorized: async () => ({ status: "password_changed" as const }),
      });

      const failure = expectFailure(
        await serviceWith({ credentials: conflicting }).login({
          identifier: user.email,
          password: PASSWORD,
        }),
      );

      assert.equal(failure.reason, "password_changed_concurrently");
      assert.equal(h.sessions.count, 0);
    });

    it("refuses when the conditional reset reports the credential is gone", async () => {
      const user = await seedUser();

      const vanished = withOverrides<CredentialRepository>(h.credentials, {
        resetFailedAttemptsIfAuthorized: async () => ({ status: "not_found" as const }),
      });

      const failure = expectFailure(
        await serviceWith({ credentials: vanished }).login({
          identifier: user.email,
          password: PASSWORD,
        }),
      );

      assert.equal(failure.reason, "invalid_credentials");
      assert.equal(h.sessions.count, 0);
    });
  });

  describe("uncertain credential state fails closed", () => {
    it("refuses when the credential cannot be re-read", async () => {
      const user = await seedUser();

      const fire = onCall(2, () => {
        throw new Error("connection reset");
      });

      const broken = withOverrides<CredentialRepository>(h.credentials, {
        findByUserId: async (id) => {
          await fire();
          return h.credentials.findByUserId(id);
        },
      });

      const failure = expectFailure(
        await serviceWith({ credentials: broken }).login({
          identifier: user.email,
          password: PASSWORD,
        }),
      );

      assert.equal(
        failure.reason,
        "authentication_unavailable",
        "state that cannot be established must not grant access",
      );
      assert.equal(h.sessions.count, 0);
    });

    it("refuses when the user cannot be re-read", async () => {
      const user = await seedUser();

      const fire = onCall(1, () => {
        throw new Error("connection reset");
      });

      const broken = withOverrides<UserRepository>(h.users, {
        findById: async (id) => {
          await fire();
          return h.users.findById(id);
        },
      });

      const failure = expectFailure(
        await serviceWith({ users: broken }).login({
          identifier: user.email,
          password: PASSWORD,
        }),
      );

      assert.equal(failure.reason, "authentication_unavailable");
      await assertNoUsableSession(user.id);
    });

    it("refuses AND revokes when the final gate cannot read state", async () => {
      const user = await seedUser();

      const fire = onCall(2, () => {
        throw new Error("connection reset");
      });

      const broken = withOverrides<UserRepository>(h.users, {
        findById: async (id) => {
          await fire();
          return h.users.findById(id);
        },
      });

      const failure = expectFailure(
        await serviceWith({ users: broken }).login({
          identifier: user.email,
          password: PASSWORD,
        }),
      );

      assert.equal(failure.reason, "authentication_unavailable");

      const all = await h.sessions.listSessionsForUser(user.id, {
        includeRevoked: true,
        includeExpired: true,
      });

      assert.equal(all.length, 1, "a session existed");
      assert.ok(all[0]?.revokedAt, "and was revoked when state could not be confirmed");
    });

    it("a rehash timeout that actually committed still logs in", async () => {
      // The gate accepts the upgraded hash, so a write that succeeded while
      // reporting an error is not mistaken for someone else's change.
      const argon2 = (await import("argon2")).default;

      const user = h.users.seed(userFixture());
      const legacy = await argon2.hash(PASSWORD, {
        type: argon2.argon2id,
        memoryCost: 19_456,
        timeCost: 2,
        parallelism: 1,
      });
      await h.credentials.create({ userId: user.id, passwordHash: legacy });

      const timingOut = withOverrides<CredentialRepository>(h.credentials, {
        rehashPassword: async (input) => {
          // The write lands, then the call reports a timeout.
          const updated = await h.credentials.rehashPassword(input);
          void updated;
          throw new Error("ETIMEDOUT");
        },
      });

      const result = await serviceWith({ credentials: timingOut }).login({
        identifier: user.email,
        password: PASSWORD,
      });

      assert.equal(result.outcome, "success", "an uncertain-but-benign rehash is safe");
    });

    it("a rehash timeout that concealed a real change refuses", async () => {
      const argon2 = (await import("argon2")).default;

      const user = h.users.seed(userFixture());
      const legacy = await argon2.hash(PASSWORD, {
        type: argon2.argon2id,
        memoryCost: 19_456,
        timeCost: 2,
        parallelism: 1,
      });
      await h.credentials.create({ userId: user.id, passwordHash: legacy });

      const concealing = withOverrides<CredentialRepository>(h.credentials, {
        rehashPassword: async () => {
          // Someone else's change lands; our call reports a timeout, so the
          // error type reveals nothing about what happened.
          await h.credentials.resetPassword({
            userId: user.id,
            newPasswordHash: "$argon2id$v=19$m=47104,t=2,p=1$aGlkZGVu$Y2hhbmdlZA",
          });

          throw new Error("ETIMEDOUT");
        },
      });

      const failure = expectFailure(
        await serviceWith({ credentials: concealing }).login({
          identifier: user.email,
          password: PASSWORD,
        }),
      );

      assert.equal(
        failure.reason,
        "password_changed_concurrently",
        "a timeout must not be assumed benign",
      );
      assert.equal(h.sessions.count, 0);
    });
  });

  describe("account enumeration", () => {
    it("known and unknown users produce byte-identical failures", async () => {
      await seedUser();

      const known = expectFailure(
        await service.login({ identifier: "ananya@test.local", password: WRONG_PASSWORD }),
      );
      const unknown = expectFailure(
        await service.login({ identifier: "nobody@test.local", password: WRONG_PASSWORD }),
      );
      const unknownMobile = expectFailure(
        await service.login({ identifier: "9111111111", password: WRONG_PASSWORD }),
      );

      assert.deepEqual(known, unknown, "no field may differ");
      assert.deepEqual(known, unknownMobile);
      assert.deepEqual(Object.keys(known).sort(), ["outcome", "reason"]);
      assert.equal(JSON.stringify(known), JSON.stringify(unknown));
    });

    it("carries no lockout progress for any failure", async () => {
      const user = await seedUser();

      for (let i = 0; i < THRESHOLD - 1; i += 1) {
        const failure = expectFailure(
          await service.login({ identifier: user.email, password: WRONG_PASSWORD }),
        );

        const serialised = JSON.stringify(failure);

        assert.equal(serialised.includes("attempts"), false, "no attempt count");
        assert.equal(serialised.includes("Remaining"), false);
        assert.equal(serialised.includes(String(THRESHOLD)), false, "no threshold");
      }

      // The count IS tracked authoritatively, just not disclosed.
      assert.equal(
        (await h.credentials.findByUserId(user.id))?.failedLoginAttempts,
        THRESHOLD - 1,
      );
    });

    it("reveals nothing about state on a wrong password", async () => {
      for (const status of ["pending", "suspended", "deactivated"] as const) {
        h.reset();
        const user = h.users.seed(userFixture({ status }));
        await h.credentials.create({ userId: user.id, passwordHash });

        const failure = expectFailure(
          await service.login({ identifier: user.email, password: WRONG_PASSWORD }),
        );

        assert.equal(
          failure.reason,
          "invalid_credentials",
          `${status} must not be revealed by a wrong-password attempt`,
        );
      }
    });

    it("never leaks a hash, a token or the password on any failure path", async () => {
      const user = await seedUser();

      const failures = [
        await service.login({ identifier: user.email, password: WRONG_PASSWORD }),
        await service.login({ identifier: "nobody@test.local", password: PASSWORD }),
        await service.login({}),
      ];

      for (const failure of failures) {
        const serialised = JSON.stringify(failure);

        assert.equal(serialised.includes(passwordHash), false);
        assert.equal(serialised.includes("argon2"), false);
        assert.equal(serialised.includes(PASSWORD), false);
        assert.equal(serialised.includes(WRONG_PASSWORD), false);
      }
    });
  });

  describe("the happy path still works", () => {
    it("logs in cleanly when nothing changes", async () => {
      const user = await seedUser({ role: "admin" });

      const result = await service.login({ identifier: user.email, password: PASSWORD });

      assert.equal(result.outcome, "success");
      if (result.outcome !== "success") return;

      assert.equal(result.data.user.id, user.id);
      assert.ok(result.data.accessToken);
      assert.ok(result.data.refreshToken);
      assert.ok(result.data.sessionId);

      const session = await h.sessions.findBySessionId(result.data.sessionId);
      assert.equal(session?.userId, user.id);
      assert.equal(session?.revokedAt, undefined, "the session is live");
    });

    it("performs exactly two authorization gates", async () => {
      const user = await seedUser();

      let userReads = 0;
      let credentialReads = 0;

      const countingUsers = withOverrides<UserRepository>(h.users, {
        findById: async (id) => {
          userReads += 1;
          return h.users.findById(id);
        },
      });

      const countingCredentials = withOverrides<CredentialRepository>(h.credentials, {
        findByUserId: async (id) => {
          credentialReads += 1;
          return h.credentials.findByUserId(id);
        },
      });

      const result = await serviceWith({
        users: countingUsers,
        credentials: countingCredentials,
      }).login({ identifier: user.email, password: PASSWORD });

      assert.equal(result.outcome, "success");

      // findById: pre-session gate + final gate. The identifier lookup uses
      // findByEmail, which is not counted here.
      assert.equal(userReads, 2, "one read per gate");
      // findByUserId: initial load + both gates.
      assert.equal(credentialReads, 3, "initial load plus one per gate");
    });
  });
});
