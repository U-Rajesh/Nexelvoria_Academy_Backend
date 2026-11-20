import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  RegistrationRejectedError,
  type StudentRegistrationInput,
  type StudentRegistrationRepository,
} from "../../src/modules/auth/registration.repository";
import {
  DuplicateRecordError,
  RepositoryError,
} from "../../src/repositories/repository.errors";
import { PROFILE_INPUT, fakeHash, type RegistrationHarnessFactory } from "./harness";

/** A valid registration payload, as `registration.service.ts` would build it. */
const registrationInput = (
  overrides: Partial<StudentRegistrationInput> = {},
): StudentRegistrationInput => ({
  name: "Aarav Sharma",
  email: "aarav@test.local",
  mobile: "9876543210",
  passwordHash: fakeHash("aarav"),
  profile: { ...PROFILE_INPUT },
  ...overrides,
});

/**
 * The `studentRegistration` port contract.
 *
 * ===========================================================================
 * WHAT THIS SUITE IS MEASURING.
 *
 * Registration is ONE atomic operation here (transaction-design section 3,
 * Route A), so the contract is mostly about what CANNOT be observed: no
 * half-created account, no datastore spelling leaking out, no credential
 * material coming back, and no identifier confusion between the user and the
 * profile.
 *
 * Several of these are exactly the defects a type-correct adapter can still
 * have. An implementation that forwarded the datastore's own "PENDING"
 * instead of the domain's `pending` satisfies every signature, passes every
 * service unit test, and then shows the student the wrong screen - because
 * `deriveAccountState` reads that value. So it is pinned here.
 * ---------------------------------------------------------------------------
 * TWO RULES ARE DELIBERATELY NOT TESTED HERE, because they are not
 * observable through this port:
 *
 *  - THE (DIALING CODE, NUMBER) UNIQUENESS PAIR. An implementation's dialing
 *    code is fixed configuration, so "the same number under a different
 *    code" is unreachable through the port. That belongs to the adapter's
 *    own unit tests.
 *  - PROFILE ROUND-TRIPPING. This port has no read; the profile is read back
 *    through `StudentRepository`, so its mapping is tested there.
 * ===========================================================================
 */
export const describeStudentRegistrationRepositoryContract = (
  label: string,
  makeHarness: RegistrationHarnessFactory,
): void => {
  describe(`StudentRegistrationRepository contract [${label}]`, () => {
    const withRepo = async (
      fn: (repo: StudentRegistrationRepository) => Promise<void>,
    ): Promise<void> => {
      const harness = await makeHarness();

      try {
        await fn(harness.repo);
      } finally {
        await harness.cleanup?.();
      }
    };

    describe("a successful registration", () => {
      it("returns both identifiers, as non-empty strings", async () => {
        await withRepo(async (repo) => {
          const record = await repo.register(registrationInput());

          assert.ok(
            typeof record.userId === "string" && record.userId.length > 0,
            "userId is the public student identifier and must always be present",
          );
          assert.ok(
            typeof record.studentProfileId === "string" && record.studentProfileId.length > 0,
            "studentProfileId is internal but must still be reported",
          );
        });
      });

      it("ids are strings on the wire, whatever the datastore uses", async () => {
        // open-questions Q1: the key type is the database team's decision
        // (BIGINT IDENTITY here), but `EntityId` is a string and the frontend
        // types every id as one. An adapter returning a number breaks the
        // contract even where TypeScript does not notice through an `any`.
        await withRepo(async (repo) => {
          const record = await repo.register(registrationInput());

          assert.equal(typeof record.userId, "string");
          assert.equal(typeof record.studentProfileId, "string");
        });
      });

      it("gives each registration its own userId", async () => {
        await withRepo(async (repo) => {
          const first = await repo.register(registrationInput());
          const second = await repo.register(
            registrationInput({ email: "second@test.local", mobile: "9876500001" }),
          );

          assert.notEqual(
            first.userId,
            second.userId,
            "two students must never share the public identifier",
          );
          assert.notEqual(first.studentProfileId, second.studentProfileId);
        });
      });

      it("echoes the stored email, national number and dialing code", async () => {
        await withRepo(async (repo) => {
          const record = await repo.register(registrationInput());

          assert.equal(record.email, "aarav@test.local");
          assert.equal(
            record.mobileNumber,
            "9876543210",
            "the national number is reported without its dialing code",
          );
          assert.ok(
            typeof record.countryCode === "string" && record.countryCode.length > 0,
            "the dialing code the number was stored under must be reported back",
          );
        });
      });

      it("reports the DOMAIN status values, never the datastore spelling", async () => {
        // THE SINGLE MOST LOAD-BEARING ASSERTION IN THIS FILE.
        //
        // The datastore stores "PENDING". `deriveAccountState` and every
        // `UserStatus` comparison in the application are lowercase, so an
        // adapter that forwards the stored spelling breaks the account-state
        // derivation while passing every type check.
        await withRepo(async (repo) => {
          const record = await repo.register(registrationInput());

          assert.equal(record.status, "pending");
          assert.equal(record.adminApprovalStatus, "pending");
        });
      });

      it("verifies no channel and approves nothing", async () => {
        // BR-001 verification and BR-002 approval both precede activation.
        await withRepo(async (repo) => {
          const record = await repo.register(registrationInput());

          assert.equal(record.isEmailVerified, false);
          assert.equal(record.isMobileVerified, false);
        });
      });

      it("reports a non-empty referenceId when it reports one at all", async () => {
        await withRepo(async (repo) => {
          const record = await repo.register(registrationInput());

          if (record.referenceId !== undefined) {
            assert.ok(
              typeof record.referenceId === "string" && record.referenceId.length > 0,
              "an empty referenceId is worse than none: it correlates nothing",
            );
          }
        });
      });
    });

    describe("the returned record exposes no credential material", () => {
      it("carries no password, hash or token field", async () => {
        // This port IS the credential store - it is handed the argon2id hash
        // - so it is the single most likely place for one to leak. And
        // because `Student extends User`, a leak here reaches every student
        // response.
        await withRepo(async (repo) => {
          const record = await repo.register(registrationInput());

          const serialised = JSON.stringify(record);
          assert.ok(
            !/password|hash|token|otp|secret/i.test(serialised),
            `the registration record must carry no credential material: ${serialised}`,
          );
        });
      });
    });

    describe("uniqueness", () => {
      it("throws DuplicateRecordError on a repeated email", async () => {
        await withRepo(async (repo) => {
          await repo.register(registrationInput());

          await assert.rejects(
            () => repo.register(registrationInput({ mobile: "9876500001" })),
            (err: unknown) => {
              assert.ok(
                err instanceof DuplicateRecordError,
                "must be DuplicateRecordError, never a driver error (handoff 9)",
              );
              return true;
            },
          );
        });
      });

      it("throws DuplicateRecordError on a repeated mobile", async () => {
        await withRepo(async (repo) => {
          await repo.register(registrationInput());

          await assert.rejects(
            () => repo.register(registrationInput({ email: "other@test.local" })),
            (err: unknown) => err instanceof DuplicateRecordError,
          );
        });
      });

      it("names the colliding field, so the service picks the right 409", async () => {
        // `registration.service.ts` reads `err.field` to choose between
        // `email_taken` and `mobile_taken`. An adapter that cannot name the
        // field makes one of the two 409s report the wrong message.
        await withRepo(async (repo) => {
          await repo.register(registrationInput());

          await assert.rejects(
            () => repo.register(registrationInput({ mobile: "9876500001" })),
            (err: unknown) => {
              assert.ok(err instanceof DuplicateRecordError);
              assert.match(err.field.toLowerCase(), /email/);
              return true;
            },
          );

          await assert.rejects(
            () => repo.register(registrationInput({ email: "other@test.local" })),
            (err: unknown) => {
              assert.ok(err instanceof DuplicateRecordError);
              assert.match(err.field.toLowerCase(), /mobile/);
              return true;
            },
          );
        });
      });

      it("matches a duplicate email case-insensitively", async () => {
        // handoff Q17: SQL Server's default collation is case-insensitive,
        // but the contract must not DEPEND on that - the adapter owns the
        // guarantee either way, because the duplicate check and login both
        // resolve by email.
        await withRepo(async (repo) => {
          await repo.register(registrationInput({ email: "aarav@test.local" }));

          await assert.rejects(
            () =>
              repo.register(
                registrationInput({ email: "AARAV@TEST.LOCAL", mobile: "9876500002" }),
              ),
            (err: unknown) => err instanceof DuplicateRecordError,
          );
        });
      });
    });

    describe("business-validation refusals", () => {
      it("refuses a malformed email with field issues", async () => {
        // Unreachable through the HTTP route, because `registrationSchema`
        // rejects it first. Pinned anyway: the datastore validates
        // independently, and the port promises to surface that as issues
        // rather than as an opaque failure.
        await withRepo(async (repo) => {
          await assert.rejects(
            () => repo.register(registrationInput({ email: "not-an-email" })),
            (err: unknown) => {
              assert.ok(
                err instanceof RegistrationRejectedError,
                "a business-validation refusal is not a duplicate and not a driver error",
              );
              assert.ok(err.issues.length > 0, "a refusal must say which field failed");
              assert.match(err.issues[0]?.field ?? "", /email/i);
              assert.ok(
                err.reasonCode.length > 0,
                "a stable reason code is what logs and triage branch on",
              );
              return true;
            },
          );
        });
      });

      it("refuses a mobile number that is too short", async () => {
        await withRepo(async (repo) => {
          await assert.rejects(
            () => repo.register(registrationInput({ mobile: "12345" })),
            (err: unknown) => {
              assert.ok(err instanceof RegistrationRejectedError);
              assert.match(err.issues[0]?.field ?? "", /mobile/i);
              return true;
            },
          );
        });
      });

      it("refuses a mobile number containing non-digits", async () => {
        await withRepo(async (repo) => {
          await assert.rejects(
            () => repo.register(registrationInput({ mobile: "98765abcde" })),
            (err: unknown) => err instanceof RegistrationRejectedError,
          );
        });
      });

      it("a refusal never echoes the password hash", async () => {
        await withRepo(async (repo) => {
          await assert.rejects(
            () => repo.register(registrationInput({ email: "not-an-email" })),
            (err: unknown) => {
              assert.ok(err instanceof RegistrationRejectedError);
              assert.ok(
                !/argon2|password|hash/i.test(JSON.stringify(err.issues)),
                "field issues are returned to the client and must never carry the hash",
              );
              return true;
            },
          );
        });
      });
    });

    describe("atomicity: either both rows or neither", () => {
      it("a refused registration leaves the identifiers free", async () => {
        // THE ATOMICITY TEST, and the reason this port exists.
        //
        // The refusal below happens on the mobile, AFTER the email would
        // have been written by a non-transactional implementation. If any
        // part of the write survived, the email would now be taken and the
        // retry would fail with a duplicate instead of succeeding.
        await withRepo(async (repo) => {
          await assert.rejects(
            () => repo.register(registrationInput({ mobile: "1" })),
            (err: unknown) => err instanceof RegistrationRejectedError,
          );

          const record = await repo.register(registrationInput());

          assert.ok(
            record.userId.length > 0,
            "the email must still be registerable: nothing may have been persisted",
          );
        });
      });

      it("a duplicate refusal does not disturb the existing registration", async () => {
        await withRepo(async (repo) => {
          const first = await repo.register(registrationInput());

          await assert.rejects(
            () => repo.register(registrationInput({ mobile: "9876500001" })),
            (err: unknown) => err instanceof DuplicateRecordError,
          );

          // The original identifiers are still held by the original row, so
          // a second duplicate attempt behaves identically.
          await assert.rejects(
            () => repo.register(registrationInput({ mobile: "9876500003" })),
            (err: unknown) => err instanceof DuplicateRecordError,
          );

          assert.ok(first.userId.length > 0);
        });
      });
    });

    describe("caller defects are not client errors", () => {
      it("an empty mandatory value throws, and not as a RepositoryError", async () => {
        // `registrationSchema` guarantees these are present, so an empty one
        // is a defect in the calling code. It must surface as a 500 reaching
        // whoever wrote the call - not as a 422 blaming the student. This is
        // the same choice `StudentRepository.createForUser` makes for a
        // wrong role, and for the same reason.
        await withRepo(async (repo) => {
          for (const field of ["name", "email", "mobile", "passwordHash"] as const) {
            await assert.rejects(
              () => repo.register(registrationInput({ [field]: "" })),
              (err: unknown) => {
                assert.ok(err instanceof Error, `an empty ${field} must throw`);
                assert.ok(
                  !(err instanceof RepositoryError),
                  `an empty ${field} is a caller defect, so it must NOT be a RepositoryError ` +
                    "- those carry an agreed HTTP mapping this condition has no place in",
                );
                return true;
              },
            );
          }
        });
      });
    });

    describe("[concurrency] two registrations racing for one email", () => {
      it("exactly one succeeds and the other is a duplicate", async () => {
        // HONEST LIMITATION, as harness.ts sets out: against the in-memory
        // fake this is not true concurrency - no fake awaits inside
        // `register`, so the event loop runs each to completion in turn.
        // Passing here proves only the SEQUENTIAL half.
        //
        // Against a real adapter the two calls genuinely interleave, and
        // this is where the datastore's locking during the duplicate check
        // earns its keep.
        await withRepo(async (repo) => {
          const results = await Promise.allSettled([
            repo.register(registrationInput()),
            repo.register(registrationInput()),
          ]);

          const fulfilled = results.filter((r) => r.status === "fulfilled");
          const rejected = results.filter((r) => r.status === "rejected");

          assert.equal(fulfilled.length, 1, "exactly one registration may win");
          assert.equal(rejected.length, 1, "and exactly one must lose");
          assert.ok(
            rejected[0]?.status === "rejected" &&
              rejected[0].reason instanceof DuplicateRecordError,
            "the loser must lose with DuplicateRecordError, not a driver error",
          );
        });
      });
    });
  });
};
