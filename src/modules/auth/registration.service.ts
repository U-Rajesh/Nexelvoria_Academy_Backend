import type { FieldIssue } from "../../contracts/api.contract";
import type { EntityId } from "../../contracts/identifier.contract";
import { logger } from "../../utils/logger";
import { describeError } from "../../utils/redact";
import {
  DuplicateRecordError,
  RepositoryError,
} from "../../repositories/repository.errors";
import type { UserRepository } from "../users/user.repository";
import { registrationSchema } from "./auth.validation";
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
 * It does NOT persist the admissions profile (college, degree, passing year,
 * address, guardian contact). The input is fully validated so nothing
 * invalid is accepted, but the fields are not written anywhere, because the
 * user-to-student creation linkage is unresolved - see
 * docs/auth-implementation-plan.md §21.2. Writing them through
 * `StudentRepository.create` today would produce a SECOND record with its
 * own unrelated id, invisible to `UserRepository.findByEmail` and therefore
 * to login. An unlinked orphan is worse than a documented gap, so the write
 * is withheld rather than guessed at.
 * ===========================================================================
 *
 * ===========================================================================
 * NO ATOMIC USER + CREDENTIAL CREATION.
 *
 * Two repositories, no unit of work (Q-CR6 / Q-X1), and no transaction is
 * invented here. The order is chosen to fail SAFE rather than to pretend:
 *
 *   1. create the user      - takes the email and mobile, atomically
 *   2. create the credential
 *
 * If step 2 fails, the user exists with no credential and **cannot log in**:
 * `login` treats a missing credential exactly like a wrong password, so the
 * failure mode is closed, not open.
 *
 * The cost is real and must not be glossed over: the email and mobile are
 * now taken, so the person cannot simply register again. Cleaning that up is
 * impossible with today's contracts - `UserRepository` has no delete, by
 * deliberate design (status changes are used instead) - so the service
 * reports `incomplete` and an operator must intervene. The smallest fixes
 * are a unit of work, or a narrow repository operation to discard an
 * unverified user; neither is added unasked. See §21.3.
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
   * Requires operator intervention.
   */
  | "incomplete"
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
}

export interface RegistrationService {
  register(input: unknown): Promise<RegistrationResult>;
}

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

      logger.info("registration succeeded", { userId });

      return {
        outcome: "success",
        data: { tempStudentId: userId, email, mobile },
      };
    },
  };
};
