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
 * NOT ATOMIC. THREE SEQUENTIAL WRITES, AND THIS IS NOT PRODUCTION-READY.
 *
 * Three repositories, no unit of work (Q-CR6 / Q-X1), and no transaction is
 * invented here. Nothing below pretends that sequential repository calls are
 * transactional, because they are not.
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

  /** Maps a duplicate-key error onto the field that collided. */
  const duplicateReason = (err: DuplicateRecordError): RegistrationFailureReason =>
    err.field.toLowerCase().includes("mobile") ? "mobile_taken" : "email_taken";

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
      // Enforces the policy a second time, so a non-compliant password can
      // never reach storage even if a caller bypassed the schema.
      let passwordHash: string;

      try {
        passwordHash = await hashPassword(password);
      } catch (err) {
        // The only expected cause is a policy violation, which the schema
        // should already have caught.
        logger.error("registration refused: password could not be hashed", {
          errorType: describeError(err),
        });

        return fail("validation_failed", [
          { field: "password", message: "Password does not meet the required policy" },
        ]);
      }

      // =====================================================================
      // TRANSACTION BOUNDARY - NOT YET TRANSACTIONAL.
      //
      // Stages 4, 5 and 6 below MUST become ONE atomic unit before this
      // service is exposed over HTTP. Two candidate implementations:
      //
      //   (a) `dbo.USP_NXA_Register_Student` - if that stored procedure
      //       inserts the user, the credential and the student inside one
      //       transaction, this entire region collapses into a SINGLE
      //       repository call and the ordering notes above become moot. Its
      //       signature is not yet available to the backend.
      //   (b) A unit-of-work port (open-questions **Q-X1**) wrapping the
      //       three writes in one mssql transaction.
      //
      // Until one of those exists, a failure at stage 5 or 6 leaves partial
      // state that an operator must resolve. DO NOT MOUNT AN HTTP ROUTE FOR
      // REGISTRATION UNTIL THIS IS CLOSED.
      //
      // Today three independent guards keep this flow unreachable in
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
