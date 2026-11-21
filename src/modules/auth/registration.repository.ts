import type { FieldIssue } from "../../contracts/api.contract";
import type { EntityId } from "../../contracts/identifier.contract";
import type { UserStatus } from "../../contracts/user.contract";
import { RepositoryError } from "../../repositories/repository.errors";
import type { AdminApprovalStatus, StudentProfileInput } from "../students/student.types";

/**
 * The student-registration PORT: ONE atomic operation.
 *
 * An interface only. No SQL, no driver import, no stored-procedure name and
 * no MS SQL Server concept, so the same port is satisfied by a real adapter
 * or by the in-memory fake the tests use.
 *
 * ===========================================================================
 * WHY A COARSE PORT, WHEN EVERY OTHER PORT IS FINE-GRAINED.
 *
 * docs/transaction-design.md section 2.2 weighs three ways to express a
 * multi-entity write and REJECTS coarse repository methods as the general
 * answer - they push business sequencing into the adapter, so the rule ends
 * up written twice - with one stated exception:
 *
 *     "EXCEPT where a stored procedure already is that method: see section 3."
 *
 * This is that exception, and nothing else may cite it as a precedent. The
 * registration procedure inserts the user and the student profile inside ONE
 * explicit transaction with rollback, so the sequencing is already the
 * database's rather than ours. Expressing it as three fine-grained ports
 * would mean three read-backs after a write that already returned everything
 * needed, and would reintroduce exactly the non-atomicity the procedure
 * exists to remove.
 *
 * This is Route A of the decision tree in transaction-design section 3, and
 * the consequence recorded there holds: NO unit-of-work port is needed for
 * registration, and the `incomplete` and `profile_incomplete` members of
 * `RegistrationFailureReason` become UNREACHABLE once the service uses this
 * port, because there is no longer a window in which a user exists without a
 * profile.
 * ===========================================================================
 *
 * ===========================================================================
 * THE IDENTIFIER RULE. READ THIS BEFORE USING `studentProfileId`.
 *
 * The datastore mints TWO identities: the user row's and the profile row's.
 * `userId` is the PUBLIC student identifier and the only one that may reach
 * an API response, a URL or a token. `studentProfileId` is INTERNAL - it is
 * carried here for support and log correlation, and for nothing else.
 *
 * This matters because every downstream flow resolves a student BY USER ID.
 * `verification.service.ts` calls `users.findById(studentId)` and
 * `students.findById(studentId)` with the SAME value; `login.service.ts`
 * resolves a pending profile with `students.findById(userId)`; and the admin
 * approval routes post back the `id` that `toStudentResponse` emitted.
 * Letting the profile id reach `Student.id` would break all three at once.
 *
 * NOTE for whoever maintains `StudentRepository`: its `createForUser`
 * doc-comment still asserts that an adapter "MUST use `userId` as the
 * student's primary key and MUST NOT generate a second id" (open-questions
 * Q25, Option A). The delivered schema does generate a second id, so that
 * sentence describes an invariant the database does not implement. The
 * invariant that DOES hold, and the one this port guarantees, is the weaker
 * and sufficient one: a student is always ADDRESSED by the user id.
 * ===========================================================================
 */

/**
 * Everything needed to register a student, in DOMAIN terms.
 *
 * Deliberately not shaped like any procedure's parameter list. Translating
 * these fields onto storage - splitting a combined degree, flattening an
 * address, resolving a course title - is the adapter's work, and keeping it
 * there is what lets a fake and a real adapter share one specification.
 */
export interface StudentRegistrationInput {
  /** Full legal name. */
  name: string;
  /** Already trimmed and lowercased by the validation schema. */
  email: string;
  /**
   * The NATIONAL mobile number, with no dialing code.
   *
   * NO COUNTRY CODE HERE, and that is a decision rather than an oversight.
   * The frontend collects one ten-digit number, `User.mobile` holds one
   * string, and no caller in this codebase has a dialing code to supply - so
   * requiring one would mean inventing a value in the service.
   *
   * An adapter whose storage needs a dialing code supplies its own
   * configured value and ECHOES it back on `StudentRegistrationRecord`.
   * Where that storage enforces uniqueness on the (dialing code, number)
   * PAIR, satisfying it is the adapter's concern; what this port guarantees
   * is that two registrations of the same national number against the same
   * implementation collide. Adding an explicit `countryCode` later is an
   * additive change.
   */
  mobile: string;
  /**
   * An argon2id hash, produced by `password.service.ts`.
   *
   * HASHING STAYS IN THE APPLICATION. No implementation of this port may
   * hash, rehash or verify a password, and none may log this value.
   */
  passwordHash: string;
  /**
   * The admissions profile, exactly as `registration.service.ts` already
   * builds it. Reusing the existing type rather than restating its fields
   * means a field added to the student contract cannot be quietly dropped
   * here.
   */
  profile: StudentProfileInput;
}

/**
 * What a successful registration returns.
 *
 * It carries NO password hash and no credential material of any kind. The
 * conformance suite asserts that, because `Student extends User` and a leak
 * here would reach every student response.
 */
export interface StudentRegistrationRecord {
  /** The PUBLIC student identifier. See the identifier rule above. */
  userId: EntityId;
  /** INTERNAL. Support and log correlation only - never on the wire. */
  studentProfileId: EntityId;
  /** As stored, which is what the validation schema normalised. */
  email: string;
  /**
   * The dialing code the number was stored under, for example "+91".
   *
   * Reported rather than accepted - see `StudentRegistrationInput.mobile`.
   */
  countryCode: string;
  /** The national number, as stored. */
  mobileNumber: string;
  /**
   * DOMAIN values, never the datastore's spelling.
   *
   * An implementation whose storage uses other labels - "PENDING", say -
   * maps them here through an allow-list that FAILS on anything
   * unrecognised. Defaulting an unknown status to `pending` would hand a
   * student the wrong screen, and `deriveAccountState` reads both of these.
   *
   * Registration always produces `pending` / `pending`: BR-001 verification
   * and BR-002 approval both precede activation.
   */
  status: UserStatus;
  adminApprovalStatus: AdminApprovalStatus;
  /** Both false at registration. Registering verifies no channel. */
  isEmailVerified: boolean;
  isMobileVerified: boolean;
  /**
   * The datastore's own correlation id for this execution, where it issues
   * one. Log it beside `req.requestId` so a support query can bridge the
   * application log and the database's. Optional, because not every
   * implementation has one. NEVER returned to a client.
   */
  referenceId?: string;
}

/**
 * The datastore refused the input on BUSINESS-VALIDATION grounds.
 *
 * ===========================================================================
 * WHY A MODULE-LOCAL ERROR RATHER THAN A FOURTH SHARED ONE.
 *
 * `repository.errors.ts` documents a settled mapping - not-found to 404,
 * duplicate and optimistic-lock to 409 - that every service relies on.
 * Adding a fourth member there would change a shared contract for a
 * condition only this port can raise, so it lives here instead.
 *
 * It still extends `RepositoryError`, so the `err instanceof RepositoryError`
 * checks already in `registration.service.ts` keep classifying it correctly.
 * ===========================================================================
 *
 * This is DEFENCE IN DEPTH, not the primary guard: `registrationSchema` has
 * already validated every field before the service calls this port. Reaching
 * here means the datastore applies a rule the schema does not, which is
 * worth surfacing as field issues rather than as an opaque failure.
 *
 * NOT for these two conditions, which are faults on OUR side of the line and
 * must not be dressed up as client input errors:
 *
 *  - A MANDATORY value arriving empty or absent. The schema guarantees it is
 *    present, so this is a defect in the calling code. Implementations throw
 *    a plain `Error`, deliberately not a `RepositoryError` - the same choice
 *    `StudentRepository.createForUser` makes for a wrong role, and for the
 *    same reason: it is a 500 that should reach whoever wrote the call.
 *  - A value the ADAPTER itself supplied being rejected, an unconfigured or
 *    inactive dialing code for instance. That is a deployment fault, not
 *    something a student can provoke or fix, so it must never produce a 422
 *    naming a field the student never filled in.
 */
export class RegistrationRejectedError extends RepositoryError {
  constructor(
    /** Field-level detail, safe to return. NEVER echoes the password. */
    readonly issues: readonly FieldIssue[],
    /**
     * The datastore's stable, machine-readable reason code, for logs and
     * triage. A code, never a human-readable message: messages get reworded
     * and nothing may branch on prose.
     */
    readonly reasonCode: string,
    /** The datastore's correlation id, where it issues one. */
    readonly referenceId?: string,
  ) {
    super(`Registration rejected by the datastore (${reasonCode})`);
  }
}

/**
 * Student self-registration as ONE atomic operation.
 *
 * Conventions every implementation must follow:
 *  - Either BOTH the identity and the profile are created, or NEITHER is.
 *    There is no partial outcome to report and no compensation to run.
 *  - A taken email or mobile throws `DuplicateRecordError`, never a driver
 *    error (handoff section 9).
 *  - A business-validation refusal throws `RegistrationRejectedError`.
 *  - A caller's own mistake throws a plain `Error`.
 *  - No implementation hashes a password, and none logs `passwordHash`.
 */
export interface StudentRegistrationRepository {
  /**
   * Creates the user identity, the stored credential and the student
   * profile, atomically.
   *
   * @throws DuplicateRecordError       when the email or mobile is taken.
   *   `field` NAMES the collision ("email" or "mobile") whenever the
   *   datastore distinguishes them, because `registration.service.ts` reads
   *   it to choose between `email_taken` and `mobile_taken`. Where the
   *   datastore reports only that SOME unique constraint failed, `field` is
   *   "record", and a caller must not then claim it was the email.
   * @throws RegistrationRejectedError  on a business-validation refusal.
   * @throws Error                      on a caller or configuration fault.
   */
  register(input: StudentRegistrationInput): Promise<StudentRegistrationRecord>;
}
