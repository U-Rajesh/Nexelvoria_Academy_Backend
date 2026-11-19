// Side-effect import: refuses to load in a production process. MUST stay
// first, so the refusal happens before any fake is constructed.
import "./guard.dev";

import { randomBytes } from "node:crypto";

import type { RequestHandler } from "express";

import { createAuthenticate } from "../src/middleware/authenticate.middleware";
import type { AppContainer } from "../src/container/container";
import {
  createLoginService,
  type LoginService,
} from "../src/modules/auth/login.service";
import { hashPassword } from "../src/modules/auth/password.service";
import { createLoggingOtpDelivery } from "../src/modules/auth/otp.delivery";
import { createOtpService } from "../src/modules/auth/otp.service";
import type { RegistrationServiceDeps } from "../src/modules/auth/registration.service";
import {
  createVerificationService,
  type VerificationService,
} from "../src/modules/auth/verification.service";
import { createTestHarness, type TestHarness } from "../tests/fakes";

/**
 * DEVELOPMENT ONLY - the shared in-memory container for the local
 * registration harness. See dev/guard.dev.ts for why this cannot reach
 * production.
 *
 * ONE CONTAINER PER PROCESS, deliberately.
 *
 * `createContainer()` memoises each repository on first access, so a single
 * container yields a single instance of every fake - which is what makes
 * state survive across HTTP requests. A container per request would hand
 * every request an empty store, and a registration would never be visible
 * to the duplicate check that follows it.
 *
 * The consequence to know about: state lives in this process's memory only.
 * It is lost on restart (including every `tsx watch` reload), it is not
 * shared between processes, and it is NOT a database.
 */
let harness: TestHarness | undefined;

/**
 * The process-wide harness, created on first use.
 *
 * Returned whole rather than just the container so a local script can seed
 * or inspect the fakes directly, exactly as a test does.
 */
export const getDevHarness = (): TestHarness => {
  harness ??= createTestHarness();

  return harness;
};

/** The shared container. Pass to `createApp({ container })`. */
export const createDevContainer = (): AppContainer => getDevHarness().container;

/**
 * The three repositories the registration service needs, resolved from the
 * shared container.
 *
 * Dependencies are passed as GETTERS, matching `src/routes/index.ts`: the
 * repository is resolved on the first request that needs it rather than at
 * wiring time, so building the routes can never fail on a missing adapter.
 */
export const createDevRegistrationDeps = (
  container: AppContainer = createDevContainer(),
): RegistrationServiceDeps => ({
  get users() {
    return container.repositories.users;
  },
  get credentials() {
    return container.repositories.credentials;
  },
  get students() {
    return container.repositories.students;
  },
});

/**
 * The email-verification service, over the shared in-memory container and
 * the DEVELOPMENT delivery adapter.
 *
 * `createLoggingOtpDelivery()` writes the passcode to the application log
 * instead of emailing it, because no email provider has been chosen or
 * provisioned. It refuses to be constructed under NODE_ENV=production, so
 * this wiring cannot silently become the production one - and `dev/` is not
 * in the build anyway (see guard.dev.ts).
 *
 * Replacing the adapter is the whole integration: a real SMTP or transactional
 * adapter satisfies `OtpDeliveryPort` and nothing below it changes.
 */
export const createDevVerificationService = (
  container: AppContainer = createDevContainer(),
): VerificationService =>
  createVerificationService({
    otp: createOtpService({
      challenges: container.repositories.otpChallenges,
      delivery: createLoggingOtpDelivery(),
    }),
    get users() {
      return container.repositories.users;
    },
    get students() {
      return container.repositories.students;
    },
  });

/**
 * Consecutive failed sign-ins before the credential locks.
 *
 * 5 is the confirmed frontend figure (`SystemConfig.security.maxFailedLogins`
 * / `businessRules`). Injected rather than read inside the service so the
 * policy has a single owner; the real application will read it from settings.
 */
export const DEV_MAX_FAILED_LOGIN_ATTEMPTS = 5;

/**
 * The login service over the shared in-memory container.
 *
 * The service itself is UNCHANGED - same lockout counting, same status
 * gates, same deliberately-generic refusals. Only its repositories differ.
 */
export const createDevLoginService = (
  container: AppContainer = createDevContainer(),
): LoginService =>
  createLoginService({
    get users() {
      return container.repositories.users;
    },
    get credentials() {
      return container.repositories.credentials;
    },
    get sessions() {
      return container.repositories.sessions;
    },
    /**
     * Supplied so a `pending` refusal can say WHICH step the student is
     * waiting on - email verification or admin approval. Read only for that
     * distinction; it never widens access, and omitting it simply yields the
     * generic `account_pending`.
     */
    get students() {
      return container.repositories.students;
    },
    maxFailedLoginAttempts: DEV_MAX_FAILED_LOGIN_ATTEMPTS,
  });

/**
 * Authentication middleware over the shared in-memory session store.
 *
 * This is what finally populates `req.principal`, which is why the admin
 * approval endpoints can succeed in this harness and nowhere else:
 * `createAuthenticate` is wired into no other entry point, so in production
 * every guarded route still fails closed with 401. Wiring it there needs a
 * registered session adapter and is the backend lead's decision.
 *
 * `sessions` is passed as a RESOLVER, matching `AuthenticateDeps` - the
 * repository is resolved per request, never at app-construction time.
 */
export const createDevAuthenticate = (
  container: AppContainer = createDevContainer(),
): RequestHandler =>
  createAuthenticate({ sessions: () => container.repositories.sessions });

/**
 * Sign-in addresses for the development accounts.
 *
 * `.local` is reserved for local use and can never resolve publicly, so
 * these cannot collide with a real mailbox even by accident.
 */
export const DEV_ADMIN_EMAIL = "dev.admin@nexelvoria.local";
export const DEV_TEACHER_EMAIL = "dev.teacher@nexelvoria.local";
export const DEV_SUPER_ADMIN_EMAIL = "dev.superadmin@nexelvoria.local";

/** Roles that get a development account. Students register normally. */
export const DEV_SEED_ROLES = ["admin", "teacher", "super_admin"] as const;

export type DevSeedRole = (typeof DEV_SEED_ROLES)[number];

export interface SeededAccount {
  id: string;
  role: DevSeedRole;
  email: string;
  /**
   * Plaintext, for the terminal only.
   *
   * Printed once by `dev/server.dev.ts` via `console`, never returned by an
   * endpoint and never stored. `redact()` strips any context key matching
   * /pass/, so this must not be handed to the logger.
   */
  password: string;
  /** True when the value came from the environment rather than being generated. */
  fromEnvironment: boolean;
}

/** Per-role configuration. Identity only - no secret appears here. */
const DEV_ACCOUNTS: Record<
  DevSeedRole,
  { email: string; name: string; mobile: string; passwordEnvVar: string }
> = {
  admin: {
    email: DEV_ADMIN_EMAIL,
    name: "Development Admin",
    mobile: "9000000001",
    passwordEnvVar: "DEV_SEED_ADMIN_PASSWORD",
  },
  teacher: {
    email: DEV_TEACHER_EMAIL,
    name: "Development Teacher",
    mobile: "9000000002",
    passwordEnvVar: "DEV_SEED_TEACHER_PASSWORD",
  },
  super_admin: {
    email: DEV_SUPER_ADMIN_EMAIL,
    name: "Development Super Admin",
    mobile: "9000000003",
    passwordEnvVar: "DEV_SEED_SUPER_ADMIN_PASSWORD",
  },
};

/**
 * The password to seed for a role: the environment's, or a fresh random one.
 *
 * ===========================================================================
 * WHY NO PASSWORD IS WRITTEN IN THIS FILE.
 *
 * A fixed credential in source is a credential that gets reused somewhere it
 * should not be, and `dev/` being excluded from the build does not change
 * that. So there are exactly two sources:
 *
 *  1. A LOCAL ENVIRONMENT VARIABLE, for a developer who wants a stable
 *     password across restarts. `.env` is gitignored, so it never ships.
 *  2. A GENERATED value, when that variable is unset. It exists only in this
 *     process's memory and in the single line printed to the terminal, and
 *     both die with the process.
 *
 * The generated form satisfies the argon2 policy BY CONSTRUCTION - an
 * uppercase letter, a digit and a symbol are appended explicitly rather than
 * hoped for - so seeding can never fail on a weak-password rejection.
 *
 * An environment-supplied password is NOT validated against the policy here:
 * `hashPassword` enforces it and will reject a weak one loudly, which is the
 * right place for that error to surface.
 * ===========================================================================
 */
const resolveDevPassword = (envVar: string): { password: string; fromEnvironment: boolean } => {
  const configured = process.env[envVar]?.trim();

  if (configured !== undefined && configured !== "") {
    return { password: configured, fromEnvironment: true };
  }

  return { password: `${randomBytes(12).toString("base64url")}aZ9!`, fromEnvironment: false };
};

/**
 * Seeds one ACTIVE account for a role.
 *
 * `active` is deliberate and is the ONLY status login permits. It is also the
 * only shortcut taken: these are STAFF accounts, which a real deployment
 * creates through an administrative flow rather than self-registration, so
 * there is no OTP or approval step to bypass. Student accounts are NOT
 * seeded - they must register, verify and be approved like any other, and
 * nothing here changes that.
 */
const seedDevAccount = async (
  container: AppContainer,
  role: DevSeedRole,
): Promise<SeededAccount> => {
  const config = DEV_ACCOUNTS[role];
  const { password, fromEnvironment } = resolveDevPassword(config.passwordEnvVar);

  const user = await container.repositories.users.create({
    name: config.name,
    email: config.email,
    mobile: config.mobile,
    role,
    status: "active",
  });

  await container.repositories.credentials.create({
    userId: user.id,
    passwordHash: await hashPassword(password),
  });

  return { id: user.id, role, email: config.email, password, fromEnvironment };
};

/**
 * Seeds the three staff accounts: admin, teacher and super_admin.
 *
 * One per role on purpose. `requireAdmin` accepts both `admin` and
 * `super_admin` (inheritance), while `requireSuperAdmin` accepts only
 * `super_admin` - so proving the boundary needs an account that holds the
 * LOWER tier and must be refused. A single super-admin account would make
 * every authorization test pass for the wrong reason.
 */
export const seedDevAccounts = async (
  container: AppContainer = createDevContainer(),
): Promise<SeededAccount[]> => {
  const seeded: SeededAccount[] = [];

  for (const role of DEV_SEED_ROLES) {
    seeded.push(await seedDevAccount(container, role));
  }

  return seeded;
};

/**
 * @deprecated Use `seedDevAccounts`. Kept so any existing caller still
 * compiles; it seeds the admin alone.
 */
export const seedDevAdmin = async (
  container: AppContainer = createDevContainer(),
): Promise<SeededAccount> => seedDevAccount(container, "admin");
