import type { CredentialRepository } from "../../src/modules/auth/credential.repository";
import type { OtpChallengeRepository } from "../../src/modules/auth/otp.repository";
import type { StudentRegistrationRepository } from "../../src/modules/auth/registration.repository";
import type { SessionRepository } from "../../src/modules/auth/session.repository";
import type { StudentRepository } from "../../src/modules/students/student.repository";
import type { UserRepository } from "../../src/modules/users/user.repository";

/**
 * ===========================================================================
 * REPOSITORY PORT CONFORMANCE SUITE
 *
 * One executable specification per port, written against the INTERFACE and
 * nothing else. Each suite is a function taking a factory, so the same tests
 * run against any implementation:
 *
 *   describeUserRepositoryContract("in-memory fake", () => makeFakeHarness());
 *   describeUserRepositoryContract("mssql adapter",  () => makeSqlHarness());
 *
 * Today only the fakes exist, so `tests/conformance.test.ts` runs them
 * against the fakes. When the MS SQL Server adapters arrive, a second runner
 * points these identical tests at a real database and the adapter is either
 * conformant or it is not.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, AND WHY IT IS THE FIRST THING BUILT IN PHASE 5.
 *
 * Several ports do not merely describe operations - they REQUIRE PARTICULAR
 * SQL. `credentials.resetFailedAttemptsIfAuthorized` must be one guarded
 * UPDATE; `sessions.rotateRefreshToken` must be a compare-and-set;
 * `otpChallenges.consume` must be conditional and report `@@ROWCOUNT`.
 *
 * A SELECT-then-UPDATE adapter satisfies every type signature, passes every
 * existing unit test, and is WRONG in production - it erases lockouts,
 * leaves two live refresh tokens, and lets one passcode verify twice. Those
 * defects appear only under concurrency, which no test of the fakes can
 * provoke.
 *
 * So the contract is written down here, once, as tests. The fakes are held to
 * it today (which is how we know the suite is honest), and the adapters will
 * be held to the same text against a real database.
 *
 * ---------------------------------------------------------------------------
 * HONEST LIMITATION, STATED UP FRONT.
 *
 * The suites marked `[concurrency]` fire overlapping calls with
 * `Promise.all`. Against the in-memory fakes that is NOT true concurrency:
 * the fakes never await inside a method, so the event loop runs them to
 * completion one after another. Passing here therefore proves only the
 * SEQUENTIAL half of the contract - "a second consume returns false", "the
 * counter ends at N".
 *
 * Against a real adapter the same tests do interleave, and that is where
 * they earn their keep. They are written now so the specification exists
 * before the SQL does, not because the fakes are under suspicion.
 * ===========================================================================
 */

/**
 * What a suite needs: a fresh repository, and a way to dispose of it.
 *
 * A FACTORY rather than a shared instance, because each test must start from
 * empty state. For the fakes that is a new object; for SQL it will be a
 * transaction rolled back, or a truncate between tests.
 */
export interface PortHarness<T> {
  repo: T;
  /** Called after each test. Close a pool, roll back, or truncate. */
  cleanup?: () => Promise<void> | void;
}

export type HarnessFactory<T> = () => Promise<PortHarness<T>> | PortHarness<T>;

export type UserHarnessFactory = HarnessFactory<UserRepository>;
export type CredentialHarnessFactory = HarnessFactory<CredentialRepository>;
export type SessionHarnessFactory = HarnessFactory<SessionRepository>;
export type StudentHarnessFactory = HarnessFactory<StudentRepository>;
export type OtpHarnessFactory = HarnessFactory<OtpChallengeRepository>;
export type RegistrationHarnessFactory = HarnessFactory<StudentRegistrationRepository>;

/**
 * Admissions data for a student profile.
 *
 * Exported so every suite seeds the same shape and a schema mismatch shows
 * up in one place rather than five.
 */
export const PROFILE_INPUT = {
  collegeName: "JNTU Hyderabad",
  degreeBranch: "B.Tech CSE",
  passingYear: "2025",
  courseInterestedIn: "Full Stack Development",
  dateOfBirth: "2003-04-12",
  gender: "male" as const,
  fullAddress: "12-3-45 Ameerpet, Hyderabad, Telangana 500016",
};

/** A plausible argon2id PHC string. Never a real hash - nothing verifies it. */
export const fakeHash = (seed: string): string =>
  `$argon2id$v=19$m=47104,t=2,p=1$${Buffer.from(seed).toString("base64url")}$${Buffer.from(
    `digest-${seed}`,
  ).toString("base64url")}`;

/** An ISO instant offset from now, for expiry and window assertions. */
export const isoIn = (seconds: number): string =>
  new Date(Date.now() + seconds * 1000).toISOString();
