import { randomUUID } from "node:crypto";

import type { EntityId } from "../../src/contracts/identifier.contract";
import {
  RegistrationRejectedError,
  type StudentRegistrationInput,
  type StudentRegistrationRecord,
  type StudentRegistrationRepository,
} from "../../src/modules/auth/registration.repository";
import type { StudentProfileInput } from "../../src/modules/students/student.types";
import { DuplicateRecordError } from "../../src/repositories/repository.errors";
import { InMemoryStore, equalsIgnoreCase } from "./in-memory-store";

/**
 * TEST-ONLY in-memory `StudentRegistrationRepository`. See in-memory-store.ts
 * for the three guards that keep every fake out of production.
 *
 * ===========================================================================
 * THIS FAKE MODELS THE DATASTORE'S VALIDATION, NOT JUST ITS STORAGE.
 *
 * Most fakes only need to remember rows. This one also reproduces the
 * business validation the registration datastore performs for itself - the
 * loose email pattern, the mobile length and digit rules, the two uniqueness
 * checks and their ORDER.
 *
 * That is deliberate. Those rules are the reason `RegistrationRejectedError`
 * exists, so a fake that skipped them would make the conformance suite
 * untestable against anything but a real database - and a specification that
 * only one implementation can be measured against is not a specification.
 *
 * It does NOT reproduce two things, and both absences are intentional:
 *
 *  - COURSE VALIDATION. The datastore validates an optional course
 *    identifier, but this port accepts `courseInterestedIn` as a TITLE
 *    (which is what the frontend submits) and resolving a title to an
 *    identifier is unsettled. Until it is, no caller can supply a course
 *    identifier, so the rule is unreachable and faking it would assert a
 *    behaviour nothing exercises.
 *  - DIALING-CODE VALIDATION. The dialing code is supplied by the
 *    implementation rather than the caller, so rejecting it would be
 *    rejecting our own configuration. The port documents that as a
 *    deployment fault, not a client error.
 * ===========================================================================
 */

/** A stored registration. Internal to the fake; never returned as-is. */
interface StoredRegistration {
  /** The user id, which is also this row's key - the PUBLIC identifier. */
  id: EntityId;
  studentProfileId: EntityId;
  name: string;
  email: string;
  countryCode: string;
  mobileNumber: string;
  /**
   * Held because this port IS the credential store, and deliberately never
   * copied onto a returned record.
   */
  passwordHash: string;
  profile: StudentProfileInput;
  createdAt: string;
}

/**
 * The datastore's email check, which is a LOOSE pattern by design rather
 * than full RFC validation - something before an at-sign, something after
 * it, and a dot with something after that.
 *
 * `registrationSchema` is far stricter, so this only ever fires for a caller
 * that bypassed the schema.
 */
const LOOSE_EMAIL = /^.+@.+\..+$/;

/** The datastore's mobile check: digits only, 6 to 15 of them. */
const DIGITS_ONLY = /^[0-9]+$/;
const MOBILE_MIN_LENGTH = 6;
const MOBILE_MAX_LENGTH = 15;

export class InMemoryStudentRegistrationRepository implements StudentRegistrationRepository {
  private readonly store = new InMemoryStore<StoredRegistration>("user");

  /** Mints profile ids from their own sequence, as a second identity column
   * does. Separate from the user sequence on purpose: a test that assumed
   * the two were equal would pass here and fail against the real schema. */
  private profileSequence = 0;

  /**
   * The dialing code this instance stores numbers under, and the one it
   * reports back. Configurable so a test can prove the uniqueness key is the
   * (dialing code, number) pair rather than the number alone.
   */
  constructor(private readonly countryCode = "+91") {}

  reset(): void {
    this.store.reset();
    this.profileSequence = 0;
  }

  get count(): number {
    return this.store.size;
  }

  /**
   * TEST-ONLY inspection, off the port.
   *
   * Lets a test assert what was actually stored - the profile fields and the
   * hash - which the port deliberately does not return. Mirrors the `seed`
   * and `count` affordances the other fakes expose.
   */
  inspect(userId: EntityId): StoredRegistration | null {
    return this.store.get(userId);
  }

  /**
   * ATOMIC, in the only sense available in memory.
   *
   * Both uniqueness checks and both inserts run in ONE synchronous block
   * with no `await` between them, which is what models a transaction with a
   * UNIQUE index inside it. `InMemoryUserRepository.create` carries the same
   * note and for the same reason: every `await` is a microtask boundary, so
   * an awaited check would let two concurrent registrations both observe an
   * identifier as free and both insert - a race the real datastore cannot
   * have, and one that would make a concurrency test pass for the wrong
   * reason.
   */
  async register(input: StudentRegistrationInput): Promise<StudentRegistrationRecord> {
    const name = input.name.trim();
    const email = input.email.trim();
    const mobile = input.mobile.trim();

    // --- mandatory values -------------------------------------------------
    // A plain Error, not a RepositoryError: the schema guarantees these are
    // present, so an empty one is a defect in the calling code and must
    // reach whoever wrote it rather than becoming a client-facing 422.
    if (name === "" || email === "" || mobile === "" || input.passwordHash.trim() === "") {
      throw new Error(
        "StudentRegistrationRepository.register: name, email, mobile and passwordHash are " +
          "all mandatory. An empty value here is a caller defect - registrationSchema has " +
          "already guaranteed every one of them is present.",
      );
    }

    // --- business validation, in the datastore's own order ----------------
    if (!LOOSE_EMAIL.test(email)) {
      throw new RegistrationRejectedError(
        [{ field: "email", message: "Invalid email address." }],
        "INVALID_EMAIL",
        randomUUID(),
      );
    }

    if (
      !DIGITS_ONLY.test(mobile) ||
      mobile.length < MOBILE_MIN_LENGTH ||
      mobile.length > MOBILE_MAX_LENGTH
    ) {
      throw new RegistrationRejectedError(
        [{ field: "mobile", message: "Invalid mobile number." }],
        "INVALID_MOBILE",
        randomUUID(),
      );
    }

    // --- uniqueness, email first, exactly as the datastore checks ---------
    // Case-insensitive regardless of any collation: the adapter owns that
    // guarantee, so the fake must hold itself to it too (handoff Q17).
    if (this.store.find((row) => equalsIgnoreCase(row.email, email)) !== null) {
      throw new DuplicateRecordError("user", "email", email);
    }

    // The key is the (dialing code, number) PAIR, not the number alone -
    // which is why the same national number under a different dialing code
    // is a different person.
    const normalizedMobile = `${this.countryCode}${mobile}`;

    if (
      this.store.find((row) => `${row.countryCode}${row.mobileNumber}` === normalizedMobile) !==
      null
    ) {
      throw new DuplicateRecordError("user", "mobile", mobile);
    }

    // --- both rows, or neither --------------------------------------------
    this.profileSequence += 1;

    const stored = this.store.set({
      id: this.store.nextId(),
      studentProfileId: `profile-${String(this.profileSequence)}`,
      name,
      email,
      countryCode: this.countryCode,
      mobileNumber: mobile,
      passwordHash: input.passwordHash,
      profile: input.profile,
      createdAt: new Date().toISOString(),
    });

    // Built field by field, so the stored password hash cannot reach the
    // caller even if `StoredRegistration` gains fields later.
    return {
      userId: stored.id,
      studentProfileId: stored.studentProfileId,
      email: stored.email,
      countryCode: stored.countryCode,
      mobileNumber: stored.mobileNumber,
      // Fixed, never derived from input: BR-001 verification and BR-002
      // approval both precede activation.
      status: "pending",
      adminApprovalStatus: "pending",
      isEmailVerified: false,
      isMobileVerified: false,
      referenceId: randomUUID(),
    };
  }
}
