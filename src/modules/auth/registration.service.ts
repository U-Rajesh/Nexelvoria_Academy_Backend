import type { FieldIssue } from "../../contracts/api.contract";
import type { EntityId } from "../../contracts/identifier.contract";
import { logger } from "../../utils/logger";
import { describeError } from "../../utils/redact";
import {
  DuplicateRecordError,
  RepositoryError,
} from "../../repositories/repository.errors";
import type { StudentRepository } from "../students/student.repository";
import type { StudentProfileInput } from "../students/student.types";
import type { UserRepository } from "../users/user.repository";
import { type RegistrationInput, registrationSchema } from "./auth.validation";
import type { CredentialRepository } from "./credential.repository";
import { hashPassword } from "./password.service";
import {
  RegistrationRejectedError,
  type StudentRegistrationRepository,
} from "./registration.repository";

/**
 * Student self-registration.
 *
 * Application service only - no HTTP, no status codes, no `ApiError`.
 *
 * ===========================================================================
 * WHAT REGISTRATION DOES, AND THE TWO THINGS IT DELIBERATELY DOES NOT DO.
 *
 * It creates the IDENTITY and the CREDENTIAL: a `pending` user and an
 * argon2id password hash. That is the part the contracts fully support.
 *
 * It does NOT issue OTP challenges. No OTP service exists, and **Q3** is
 * unresolved - BR-001 requires both an email and a mobile OTP while BR-014
 * disables SMS, so there is no safe way to choose the channels yet. The
 * account is left at `pending`, which is correct whichever way Q3 resolves,
 * and `login` already refuses a `pending` account. Registration is therefore
 * INCOMPLETE as a user journey until the OTP step exists.
 *
 * It DOES persist the admissions profile as of Step 6K-2 (college, degree,
 * passing year, address, guardian contact and the optional profile links),
 * through `StudentRepository.createForUser`. That became possible once
 * open-questions **Q25** was settled as Option A - a one-to-one SHARED
 * PRIMARY KEY, so `Student.id === User.id`.
 *
 * Before Q25 was answered this write was deliberately withheld: the only
 * contract available was `StudentRepository.create`, which mints its own
 * id, so the row would have been an orphan invisible to
 * `UserRepository.findByEmail` and therefore to login. `createForUser`
 * exists precisely to make that impossible - it keys the profile by the
 * user's own id and reads the identity from the user record rather than
 * duplicating it.
 * ===========================================================================
 *
 * ===========================================================================
 * TWO PATHS, AND WHICH ONE RUNS DEPENDS ON ONE OPTIONAL DEPENDENCY.
 *
 * As of Step 6K Stage 2 this service has an ATOMIC path. Supply
 * `deps.registration` - a `StudentRegistrationRepository` - and the whole
 * sequential region below is skipped: identity, credential and profile are
 * written by ONE call inside ONE datastore transaction, so `incomplete` and
 * `profile_incomplete` cannot occur and there is no partial state to repair.
 * That is Route A of docs/transaction-design.md section 3, and it is what a
 * production registration route would be mounted on.
 *
 * OMIT it - which production, the development harness and the whole
 * regression suite still do today - and the sequential path below runs
 * unchanged. Everything from here to the end of this banner describes THAT
 * path only.
 * ---------------------------------------------------------------------------
 * THE SEQUENTIAL PATH IS NOT ATOMIC, AND IS NOT PRODUCTION-READY.
 *
 * Three repositories, no unit of work (Q-CR6 / Q-X1), and no transaction is
 * invented here. Nothing in that path pretends that sequential repository
 * calls are transactional, because they are not.
 *
 * The ORDER is chosen so that the one failure we cannot avoid is the
 * RECOVERABLE one:
 *
 *   1. create the user       - takes the email and mobile, atomically
 *   2. create the credential  - failure here is UNRECOVERABLE
 *   3. create the profile     - failure here is RECOVERABLE
 *
 * Why that order, specifically:
 *
 *   - If step 2 fails, the user exists with no credential and **cannot log
 *     in**: `login` treats a missing credential exactly like a wrong
 *     password, so the failure mode is closed, not open. But the email and
 *     mobile are now taken and the person cannot simply register again.
 *     `UserRepository` has no delete, by deliberate design (status changes
 *     are used instead), so the service reports `incomplete` and an operator
 *     must intervene. See §21.3.
 *
 *   - If step 3 fails, the account itself is sound - it can still be
 *     verified and activated - but it carries no admissions data. That is
 *     recoverable: `createForUser` can safely be re-attempted (it throws
 *     `DuplicateRecordError` if the profile already exists), or an admin can
 *     supply the data. The service reports `profile_incomplete`.
 *
 * Putting the recoverable failure LAST is the only atomicity-adjacent
 * guarantee available without a transaction. It is deliberate, not
 * incidental.
 *
 * NO COMPENSATING DELETES. A failed step is never "undone" by deleting
 * what came before: `UserRepository` exposes no delete by design, and a
 * compensation that itself fails leaves worse state than no compensation at
 * all. What the service does instead is report precisely which partial state
 * exists, and log it loudly enough for an operator to act.
 * ===========================================================================
 */

/** Why a registration was refused. INTERNAL; a caller maps these. */
export type RegistrationFailureReason =
  /** Input failed validation. `issues` carries the field-level detail. */
  | "validation_failed"
  /** The email is already registered. */
  | "email_taken"
  /** The mobile number is already registered. */
  | "mobile_taken"
  /**
   * The email or the mobile is taken, but the datastore did not say which.
   *
   * Only reachable on the ATOMIC path. `StudentRegistrationRepository`
   * documents `field` as "email", "mobile", or - where the datastore
   * reported no more than that SOME unique constraint failed - "record".
   *
   * It gets its own reason rather than being folded into `email_taken`
   * because a caller maps that to a message naming the email, and telling
   * a student their email is registered when it may have been their mobile
   * sends them to the wrong recovery flow. Still a conflict, so still a
   * 409 - just one that claims neither field.
   */
  | "identifier_taken"
  /**
   * The user was created but the credential was not, so the account cannot
   * be used and the identifiers are now held by an unusable record.
   * Requires operator intervention. UNRECOVERABLE with today's contracts.
   */
  | "incomplete"
  /**
   * The user AND credential were created, but the student profile was not.
   *
   * Deliberately distinct from `incomplete`, because the operator response
   * is different: the account here is sound and can still be verified and
   * activated - it simply has no admissions data. Re-attempting
   * `createForUser` for that user id is safe, so this is RECOVERABLE.
   */
  | "profile_incomplete"
  /** A repository failed before anything was created. */
  | "registration_unavailable";

/**
 * Confirmed success payload.
 *
 * Shape is fixed by the frontend: `registerStudent` is typed
 * `ApiResponse<{ tempStudentId, email, mobile }>` and `RegisterPage`
 * navigates to `/verify-otp?studentId=${result.tempStudentId}`. The name is
 * the frontend's, not ours - see decision **D2**, which corrects
 * docs/api-contracts.md where it had proposed `{ studentId, otpChannels }`.
 *
 * It carries no password hash, no token and no internal field.
 */
export interface RegistrationSuccess {
  tempStudentId: EntityId;
  email: string;
  mobile: string;
}

export type RegistrationResult =
  | { outcome: "success"; data: RegistrationSuccess }
  | {
      outcome: "failure";
      reason: RegistrationFailureReason;
      /** Present only for `validation_failed`. Never echoes the password. */
      issues?: FieldIssue[];
    };

export interface RegistrationServiceDeps {
  users: UserRepository;
  credentials: CredentialRepository;
  /**
   * Student profiles, keyed by the USER's id.
   *
   * Only `createForUser` is used from this port - never `create`, which
   * mints its own id and would produce a record unreachable from the
   * identity login resolves.
   */
  students: StudentRepository;
  /**
   * Student registration as ONE atomic operation.
   *
   * OPTIONAL, and ABSENT is exactly what production and every existing
   * test get today - with it omitted this service behaves precisely as it
   * did before, three sequential writes and all.
   *
   * SUPPLIED, it REPLACES `users` + `credentials` + `students` for the
   * registration write. The three ports above stay on the deps because
   * nothing else may be broken by this being optional, and because the
   * sequential path remains the one the in-memory development harness and
   * the regression suite exercise.
   *
   * This is Route A of docs/transaction-design.md section 3. When it is
   * wired, `incomplete` and `profile_incomplete` become UNREACHABLE:
   * there is no longer a window in which a user exists without a profile,
   * so there is no partial state left to report.
   */
  registration?: StudentRegistrationRepository;
}

export interface RegistrationService {
  register(input: unknown): Promise<RegistrationResult>;
}

/**
 * The ONLY path from validated registration input to a student profile.
 *
 * An explicit WHITELIST, built field by field rather than spread. A field
 * added to `registrationSchema` later is DROPPED here until someone
 * deliberately adds it, which is what stops an unreviewed input field
 * reaching storage.
 *
 * Identity (`name`, `email`, `mobile`, `status`) is absent on purpose: it
 * belongs to the user record, and `createForUser` reads it from there.
 *
 * EMPTY STRINGS ARE OMITTED, not stored. The schema accepts `""` for the
 * optional URLs, because the frontend submits an untouched input that way.
 * Persisting `""` would put `linkedInUrl: ""` into every API response for
 * every student who skipped the field; absent is the honest representation
 * and matches the "omits absent optional fields" rule the student response
 * whitelist already follows.
 *
 * `resumeUrl` is absent by design: registration collects no file, because
 * file storage is unresolved (open-questions **Q11**). `accountState` is
 * absent for the reason given on `StudentProfileInput` - the mapping from
 * status and approval is not a confirmed business rule, so no value is
 * invented.
 */
const toStudentProfile = (data: RegistrationInput): StudentProfileInput => {
  /** Treats an absent value and a blank string identically. */
  const present = (value: string | undefined): string | undefined =>
    value === undefined || value.trim() === "" ? undefined : value.trim();

  const guardianContact = present(data.guardianContact);
  const linkedInUrl = present(data.linkedInUrl);
  const githubUrl = present(data.githubUrl);
  const resumeFileName = present(data.resumeFileName);
  const resumeFileSize = present(data.resumeFileSize);

  return {
    // --- required admissions data, all validated by the schema ---
    collegeName: data.collegeName,
    degreeBranch: data.degreeBranch,
    passingYear: data.passingYear,
    courseInterestedIn: data.courseInterestedIn,
    dateOfBirth: data.dateOfBirth,
    gender: data.gender,
    fullAddress: data.fullAddress,

    // --- optional: included only when actually supplied ---
    ...(guardianContact === undefined ? {} : { guardianContact }),
    ...(linkedInUrl === undefined ? {} : { linkedInUrl }),
    ...(githubUrl === undefined ? {} : { githubUrl }),
    ...(resumeFileName === undefined ? {} : { resumeFileName }),
    ...(resumeFileSize === undefined ? {} : { resumeFileSize }),
  };
};

export const createRegistrationService = (
  deps: RegistrationServiceDeps,
): RegistrationService => {
  const fail = (
    reason: RegistrationFailureReason,
    issues?: FieldIssue[],
  ): RegistrationResult =>
    issues === undefined
      ? { outcome: "failure", reason }
      : { outcome: "failure", reason, issues };

  /**
   * Maps a duplicate-key error onto the field that collided.
   *
   * THREE cases, because an atomic datastore can know less than a
   * fine-grained one does. The sequential path only ever reaches here from
   * `users.create`, which names "email" or "mobile", so its behaviour is
   * unchanged; the third case exists for an atomic implementation that
   * reports only that SOME unique constraint failed.
   */
  const duplicateReason = (err: DuplicateRecordError): RegistrationFailureReason => {
    const field = err.field.toLowerCase();

    if (field.includes("mobile")) {
      return "mobile_taken";
    }

    if (field.includes("email")) {
      return "email_taken";
    }

    return "identifier_taken";
  };

  /**
   * Hashes the password ONCE, in the application, with argon2id.
   *
   * Shared by both paths, so a registration can never hash twice and can
   * never hash anywhere else. NO DATASTORE MAY HASH: the value crosses the
   * repository boundary as an opaque string, and the registration
   * procedure is documented as accepting it that way.
   *
   * `hashPassword` enforces the password policy a second time, so a
   * non-compliant password cannot reach storage even if a caller bypassed
   * the schema.
   */
  const hashOnce = async (
    password: string,
  ): Promise<
    { ok: true; passwordHash: string } | { ok: false; result: RegistrationResult }
  > => {
    try {
      return { ok: true, passwordHash: await hashPassword(password) };
    } catch (err) {
      // The only expected cause is a policy violation, which the schema
      // should already have caught.
      logger.error("registration refused: password could not be hashed", {
        errorType: describeError(err),
      });

      return {
        ok: false,
        result: fail("validation_failed", [
          { field: "password", message: "Password does not meet the required policy" },
        ]),
      };
    }
  };

  /**
   * The ATOMIC path: validate, hash, ONE call.
   *
   * ==========================================================================
   * WHAT THIS DELIBERATELY DOES NOT DO.
   *
   * NO FAST-PATH UNIQUENESS CHECK. The sequential path reads
   * `existsByEmail`/`existsByMobile` first purely to avoid paying ~120ms of
   * argon2 on an obvious duplicate - its own comment calls it a
   * convenience, not the guard. Here the datastore performs that check
   * INSIDE the transaction, under locks, which is strictly stronger; doing
   * it again beforehand would add two round trips and a window in which the
   * answer goes stale. The accepted cost is that a duplicate is detected
   * after the hash rather than before, which the registration rate limiter
   * already bounds.
   *
   * NO THREE WRITES, and no ordering rationale. Identity, credential and
   * profile are one unit here, so there is no recoverable-versus-
   * unrecoverable failure to arrange and nothing to compensate.
   *
   * NO READ-BACK AFTER THE WRITE. The sequential path confirms a profile by
   * reading it when the write errors, because a timeout that committed is
   * indistinguishable from one that did not. An atomic write has no such
   * ambiguity: it either committed or it rolled back.
   * ==========================================================================
   */
  const registerAtomically = async (
    registration: StudentRegistrationRepository,
    data: RegistrationInput,
  ): Promise<RegistrationResult> => {
    const hashed = await hashOnce(data.password);

    if (!hashed.ok) {
      return hashed.result;
    }

    let record;

    try {
      record = await registration.register({
        name: data.name,
        email: data.email,
        mobile: data.mobile,
        passwordHash: hashed.passwordHash,
        profile: toStudentProfile(data),
      });
    } catch (err) {
      if (err instanceof DuplicateRecordError) {
        logger.warn("registration refused: identifier already registered", {
          field: err.field,
        });

        return fail(duplicateReason(err));
      }

      if (err instanceof RegistrationRejectedError) {
        // The datastore applies validation of its own, which the schema has
        // already satisfied - so reaching here means the two disagree, and
        // that is worth a log line naming the rule rather than an opaque
        // failure. The reason code and the datastore's correlation id stay
        // in the LOG: the client is told which FIELDS were refused and
        // nothing about where the refusal came from.
        logger.warn("registration refused: the datastore rejected the input", {
          reasonCode: err.reasonCode,
          ...(err.referenceId === undefined ? {} : { referenceId: err.referenceId }),
          fields: err.issues.map((issue) => issue.field).join(","),
        });

        return fail("validation_failed", [...err.issues]);
      }

      // Nothing was written: an atomic failure rolls back. So this is the
      // same answer as a repository that was unreachable before it wrote,
      // and there is no partial state for an operator to repair.
      logger.error("registration refused: the atomic registration failed", {
        errorType: describeError(err),
        isRepositoryError: err instanceof RepositoryError,
      });

      return fail("registration_unavailable");
    }

    // `studentProfileId` is logged and NEVER returned - see the identifier
    // rule on the port. Every downstream flow addresses a student by the
    // user id, so that is the only one that may leave this service.
    logger.info("registration succeeded", {
      userId: record.userId,
      studentProfileId: record.studentProfileId,
      ...(record.referenceId === undefined ? {} : { referenceId: record.referenceId }),
    });

    return {
      outcome: "success",
      data: {
        // THE PUBLIC IDENTIFIER, and the contract the frontend already
        // consumes: `RegisterPage` navigates to
        // `/verify-otp?studentId=${result.tempStudentId}` and the email OTP
        // challenge is keyed by this same value. Putting
        // `record.studentProfileId` here would break verification, login's
        // pending-profile lookup and admin approval at once.
        tempStudentId: record.userId,
        // As STORED, rather than as submitted: the datastore echoes both
        // back, and reporting what was persisted is the honest answer. The
        // schema has already normalised them, so these match the input.
        email: record.email,
        mobile: record.mobileNumber,
      },
    };
  };

  return {
    async register(input: unknown): Promise<RegistrationResult> {
      // --- 1. validate ---------------------------------------------------
      const parsed = registrationSchema.safeParse(input);

      if (!parsed.success) {
        const issues: FieldIssue[] = parsed.error.issues.map((issue) => ({
          field: issue.path.length > 0 ? issue.path.join(".") : "registration",
          message: issue.message,
        }));

        // Field names and messages only - the submitted password never
        // appears in an issue.
        logger.warn("registration refused: validation failed", {
          fields: issues.map((issue) => issue.field).join(","),
        });

        return fail("validation_failed", issues);
      }

      // --- 2. ONE ATOMIC WRITE, where a transactional datastore is wired -
      // Checked straight after validation, so none of the sequential
      // machinery below - the fast-path reads, the write ordering, the
      // read-back - is reached at all on this path.
      if (deps.registration !== undefined) {
        return registerAtomically(deps.registration, parsed.data);
      }

      // ===================== THE SEQUENTIAL PATH =========================
      // Everything from here down runs ONLY when no atomic repository is
      // wired. Unchanged, and still not production-ready: see the
      // transaction-boundary note below.

      // The schema lowercases and trims the email, so uniqueness checks and
      // storage agree regardless of database collation.
      const { email, mobile, name, password } = parsed.data;

      // --- 2. fast-path uniqueness check ---------------------------------
      // A convenience only. It is NOT the guard: between this read and the
      // write below another registration could land, so the authoritative
      // check is the atomic `create` in step 4. Doing it here simply avoids
      // paying ~120ms for an argon2 hash on an obvious duplicate.
      try {
        if (await deps.users.existsByEmail(email)) {
          return fail("email_taken");
        }

        if (await deps.users.existsByMobile(mobile)) {
          return fail("mobile_taken");
        }
      } catch (err) {
        logger.error("registration refused: uniqueness check failed", {
          errorType: describeError(err),
        });

        return fail("registration_unavailable");
      }

      // --- 3. hash -------------------------------------------------------
      // The same single hash both paths use. See `hashOnce`.
      const hashed = await hashOnce(password);

      if (!hashed.ok) {
        return hashed.result;
      }

      const passwordHash = hashed.passwordHash;

      // =====================================================================
      // TRANSACTION BOUNDARY - NOT TRANSACTIONAL ON THIS PATH.
      //
      // Stages 4, 5 and 6 below are three independent writes, so a failure
      // at stage 5 or 6 leaves partial state an operator must resolve. NO
      // PRODUCTION HTTP ROUTE MAY BE MOUNTED ON THIS PATH.
      //
      // THE ANSWER NOW EXISTS, and it is the branch above rather than
      // anything in this region. `dbo.USP_NXA_Register_Student` was
      // delivered and does wrap the user and profile inserts in one
      // transaction with rollback, so Route A of
      // docs/transaction-design.md section 3 applies: supplying
      // `deps.registration` collapses these three stages into a single call
      // and makes the ordering rationale above moot. The unit-of-work port
      // of **Q-X1** is therefore NOT needed for registration - it may still
      // be needed elsewhere.
      //
      // This region is kept because it is the path the in-memory
      // development harness and the regression suite exercise, and because
      // no SQL adapter implementing the port exists yet (Stage 3).
      //
      // Three independent guards still keep registration unreachable in
      // production: `/auth` is not mounted in src/routes/index.ts,
      // `createProductionContainer()` registers no repositories, and no SQL
      // adapters exist.
      // =====================================================================

      // --- 4. create the user (authoritative uniqueness guard) -----------
      let userId: EntityId;

      try {
        const user = await deps.users.create({
          name,
          email,
          mobile,
          // FIXED, never taken from the input. Public registration creates
          // students only; a `role` in the payload is ignored, which is what
          // prevents self-service privilege escalation.
          role: "student",
          // Not active: BR-001 verification and BR-002 admin approval both
          // precede activation, and `login` refuses a `pending` account.
          status: "pending",
        });

        userId = user.id;
      } catch (err) {
        if (err instanceof DuplicateRecordError) {
          // The race the fast path cannot cover: a concurrent registration
          // took the identifier first. This is the real guard.
          logger.warn("registration refused: identifier already registered", {
            field: err.field,
          });

          return fail(duplicateReason(err));
        }

        logger.error("registration refused: user could not be created", {
          errorType: describeError(err),
        });

        return fail("registration_unavailable");
      }

      // --- 5. create the credential --------------------------------------
      try {
        await deps.credentials.create({ userId, passwordHash });
      } catch (err) {
        // The user exists but has no credential. It cannot be used to log
        // in, so this fails closed - but the email and mobile are now held
        // by an unusable record, and there is no contract to remove it.
        logger.error(
          "REGISTRATION INCOMPLETE: a user was created without a credential and cannot log " +
            "in. The email and mobile are now taken by an unusable record and need manual " +
            "cleanup - there is no transaction and no user-delete operation.",
          {
            userId,
            errorType: describeError(err),
            isRepositoryError: err instanceof RepositoryError,
          },
        );

        return fail("incomplete");
      }

      // --- 6. create the student profile ---------------------------------
      // LAST, deliberately - see the ordering note in the file header. The
      // profile is keyed by `userId`, so `Student.id === User.id` holds by
      // construction rather than by convention.
      try {
        await deps.students.createForUser(userId, toStudentProfile(parsed.data));
      } catch (err) {
        // The write may have landed despite the error - a timeout that
        // actually committed is indistinguishable from one that did not.
        // So CONFIRM by reading before reporting anything. This is a read
        // after an unconditional write, used only to establish what
        // happened; it gates nothing, and it is NOT a compensating delete.
        let persisted = false;

        try {
          persisted = (await deps.students.findById(userId)) !== null;
        } catch {
          // The outcome cannot be established. Fail closed and report the
          // partial state rather than claiming a success we cannot verify.
        }

        if (!persisted) {
          logger.error(
            "REGISTRATION PROFILE INCOMPLETE: a user and a credential were created but the " +
              "student profile was NOT. The account is sound and can still be verified and " +
              "activated, but it carries no admissions data. There is no transaction - an " +
              "operator or a later profile-completion step must supply it. Re-attempting " +
              "createForUser for this user id is safe.",
            {
              userId,
              errorType: describeError(err),
              isRepositoryError: err instanceof RepositoryError,
            },
          );

          return fail("profile_incomplete");
        }

        // The profile IS there, so the registration did complete. Reported
        // at warn because an erroring write that commits is worth knowing
        // about even when the outcome is correct.
        logger.warn(
          "the student profile write reported an error but the profile was persisted; " +
            "treating the registration as successful",
          { userId, errorType: describeError(err) },
        );
      }

      logger.info("registration succeeded", { userId });

      return {
        outcome: "success",
        data: { tempStudentId: userId, email, mobile },
      };
    },
  };
};
