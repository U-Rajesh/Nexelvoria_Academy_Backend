import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { StudentRepository } from "../../src/modules/students/student.repository";
import type { UserRepository } from "../../src/modules/users/user.repository";
import {
  DuplicateRecordError,
  RecordNotFoundError,
} from "../../src/repositories/repository.errors";
import { PROFILE_INPUT, type HarnessFactory } from "./harness";

/**
 * Students need a user to hang off, so this suite takes BOTH ports.
 *
 * That is not incidental: `Student.id === User.id` under the shared primary
 * key settled in open-questions Q25, and `createForUser` reads the identity
 * half from the user row. A suite with only the student port could not test
 * the relationship that matters most.
 */
export interface StudentPorts {
  students: StudentRepository;
  users: UserRepository;
}

/**
 * The `students` port contract, limited to the registration and approval
 * surface. Listing, filtering and sorting are covered by `students.test.ts`
 * at the service level.
 */
export const describeStudentRepositoryContract = (
  label: string,
  makeHarness: HarnessFactory<StudentPorts>,
): void => {
  describe(`StudentRepository contract [${label}]`, () => {
    const withRepo = async (fn: (ports: StudentPorts) => Promise<void>): Promise<void> => {
      const harness = await makeHarness();

      try {
        await fn(harness.repo);
      } finally {
        await harness.cleanup?.();
      }
    };

    const makeUser = async (
      ports: StudentPorts,
      email = "cand@test.local",
      mobile = "9876543210",
    ) =>
      ports.users.create({
        name: "Candidate",
        email,
        mobile,
        role: "student",
        status: "pending",
      });

    describe("createForUser", () => {
      it("keys the profile by the USER's id (Q25 shared primary key)", async () => {
        // `createForUser` exists precisely so the profile cannot be an
        // orphan with its own id, invisible to the identity login resolves.
        await withRepo(async (ports) => {
          const user = await makeUser(ports);

          const student = await ports.students.createForUser(user.id, PROFILE_INPUT);

          assert.equal(student.id, user.id, "Student.id must equal User.id");
        });
      });

      it("reads identity from the user row rather than duplicating it", async () => {
        await withRepo(async (ports) => {
          const user = await makeUser(ports, "identity@test.local", "9876500001");

          const student = await ports.students.createForUser(user.id, PROFILE_INPUT);

          assert.equal(student.email, "identity@test.local");
          assert.equal(student.mobile, "9876500001");
          assert.equal(student.name, user.name);
          assert.equal(student.status, user.status);
          assert.equal(student.role, "student");
        });
      });

      it("stores the admissions data it was given", async () => {
        await withRepo(async (ports) => {
          const user = await makeUser(ports);

          const student = await ports.students.createForUser(user.id, PROFILE_INPUT);

          assert.equal(student.collegeName, PROFILE_INPUT.collegeName);
          assert.equal(student.degreeBranch, PROFILE_INPUT.degreeBranch);
          assert.equal(student.passingYear, PROFILE_INPUT.passingYear);
          assert.equal(student.fullAddress, PROFILE_INPUT.fullAddress);
        });
      });

      it("starts unverified, unapproved, and enrolled in nothing", async () => {
        await withRepo(async (ports) => {
          const user = await makeUser(ports);

          const student = await ports.students.createForUser(user.id, PROFILE_INPUT);

          assert.equal(student.isEmailVerified, false);
          assert.equal(student.isMobileVerified, false);
          assert.equal(student.adminApprovalStatus, "pending");
          assert.deepEqual(student.enrolledCourseIds, []);
        });
      });

      it("does NOT invent an accountState", async () => {
        // It is derived from status + isEmailVerified + adminApprovalStatus
        // in the response layer, so storing one would be a second source of
        // truth and the database needs no column (handoff 16.1).
        await withRepo(async (ports) => {
          const user = await makeUser(ports);

          const student = await ports.students.createForUser(user.id, PROFILE_INPUT);

          assert.equal(student.accountState, undefined);
        });
      });

      it("throws DuplicateRecordError when a profile already exists for that user", async () => {
        // This is what makes re-attempting `createForUser` safe after a
        // partial registration.
        await withRepo(async (ports) => {
          const user = await makeUser(ports);
          await ports.students.createForUser(user.id, PROFILE_INPUT);

          await assert.rejects(
            () => ports.students.createForUser(user.id, PROFILE_INPUT),
            (err: unknown) => err instanceof DuplicateRecordError,
          );
        });
      });

      it("omits optional fields that were not supplied rather than storing blanks", async () => {
        await withRepo(async (ports) => {
          const user = await makeUser(ports);

          const student = await ports.students.createForUser(user.id, PROFILE_INPUT);

          for (const field of ["guardianContact", "linkedInUrl", "githubUrl", "resumeUrl"]) {
            assert.equal(
              field in student,
              false,
              `${field} was not supplied and must be absent, not ""`,
            );
          }
        });
      });
    });

    describe("findById", () => {
      it("returns null for an unknown id", async () => {
        await withRepo(async (ports) => {
          assert.equal(await ports.students.findById("user-nobody"), null);
        });
      });

      it("returns null for a user who has no profile yet", async () => {
        // A real state during a partial registration: the user and the
        // credential exist but the profile write failed.
        await withRepo(async (ports) => {
          const user = await makeUser(ports);

          assert.equal(await ports.students.findById(user.id), null);
        });
      });
    });

    describe("markVerified", () => {
      it("marks email without touching mobile", async () => {
        await withRepo(async (ports) => {
          const user = await makeUser(ports);
          await ports.students.createForUser(user.id, PROFILE_INPUT);

          const verified = await ports.students.markVerified(user.id, "email");

          assert.equal(verified.isEmailVerified, true);
          assert.equal(verified.isMobileVerified, false, "channels are independent");
        });
      });

      it("is idempotent - verifying an already-verified channel is not an error", async () => {
        await withRepo(async (ports) => {
          const user = await makeUser(ports);
          await ports.students.createForUser(user.id, PROFILE_INPUT);
          await ports.students.markVerified(user.id, "email");

          await assert.doesNotReject(() => ports.students.markVerified(user.id, "email"));
        });
      });

      it("does NOT approve anything - verification and approval are separate gates", async () => {
        // BR-001 then BR-002. Verification must leave the student awaiting a
        // human decision.
        await withRepo(async (ports) => {
          const user = await makeUser(ports);
          await ports.students.createForUser(user.id, PROFILE_INPUT);

          const verified = await ports.students.markVerified(user.id, "email");

          assert.equal(verified.adminApprovalStatus, "pending");
        });
      });

      it("throws RecordNotFoundError when no profile exists", async () => {
        await withRepo(async (ports) => {
          await assert.rejects(
            () => ports.students.markVerified("user-nobody", "email"),
            (err: unknown) => err instanceof RecordNotFoundError,
          );
        });
      });
    });

    describe("recordApprovalDecision", () => {
      const decide = (status: "approved" | "rejected", remarks?: string) => ({
        status,
        decidedByUserId: "admin-1",
        decidedAt: "2026-11-18T08:00:00.000Z",
        ...(remarks === undefined ? {} : { remarks }),
      });

      it("records an approval with its timestamp", async () => {
        await withRepo(async (ports) => {
          const user = await makeUser(ports);
          await ports.students.createForUser(user.id, PROFILE_INPUT);

          const decided = await ports.students.recordApprovalDecision(
            user.id,
            decide("approved"),
          );

          assert.equal(decided.adminApprovalStatus, "approved");
          assert.equal(decided.approvedAt, "2026-11-18T08:00:00.000Z");
        });
      });

      it("records a rejection with its remarks", async () => {
        await withRepo(async (ports) => {
          const user = await makeUser(ports);
          await ports.students.createForUser(user.id, PROFILE_INPUT);

          const decided = await ports.students.recordApprovalDecision(
            user.id,
            decide("rejected", "Documents incomplete."),
          );

          assert.equal(decided.adminApprovalStatus, "rejected");
          assert.equal(decided.adminApprovalRemarks, "Documents incomplete.");
        });
      });

      it("does NOT activate the account - approval gates payment, not login", async () => {
        await withRepo(async (ports) => {
          const user = await makeUser(ports);
          await ports.students.createForUser(user.id, PROFILE_INPUT);

          const decided = await ports.students.recordApprovalDecision(
            user.id,
            decide("approved"),
          );

          assert.equal(decided.status, "pending");
        });
      });

      it("does NOT write an accountState", async () => {
        await withRepo(async (ports) => {
          const user = await makeUser(ports);
          await ports.students.createForUser(user.id, PROFILE_INPUT);

          const decided = await ports.students.recordApprovalDecision(
            user.id,
            decide("approved"),
          );

          assert.equal(decided.accountState, undefined);
        });
      });

      it("throws RecordNotFoundError when no profile exists", async () => {
        await withRepo(async (ports) => {
          await assert.rejects(
            () => ports.students.recordApprovalDecision("user-nobody", decide("approved")),
            (err: unknown) => err instanceof RecordNotFoundError,
          );
        });
      });

      /**
       * NOT YET A TEST, AND DELIBERATELY SO.
       *
       * Two behaviours the SQL adapter will need, which cannot be specified
       * until the database team's schema is reviewed (approved "in principle"
       * only at Stage 0):
       *
       *  1. DECIDE-ONLY-ONCE should become a guarded UPDATE
       *     (`WHERE admin_approval_status = 'pending'`, `@@ROWCOUNT = 0` -> 409)
       *     so the service's current read-then-write race disappears.
       *  2. The decision and its AUDIT RECORD must be written in ONE
       *     transaction, and `decidedByUserId` must actually be persisted -
       *     today nothing stores it, so the approving admin is unrecoverable.
       *
       * Both are specified in `docs/transaction-design.md`. When the schema
       * lands, the tests go here and the fake grows to match.
       */
    });


    describe("UserRepository is authoritative for identity and status", () => {
      /**
       * =====================================================================
       * THE DIVERGENCE THESE TESTS EXIST TO PREVENT.
       *
       * `Student extends User`, so a student row carries `name`, `email`,
       * `mobile`, `status`, `avatarUrl` and `createdAt` - all of which belong
       * to the user record. An adapter that SNAPSHOTS them at creation
       * produces a bug that is invisible until it matters:
       *
       *   - an admin activates a student   -> the student copy says `active`
       *   - `login` reads UserRepository   -> the user row still says `pending`
       *   - the student looks active and cannot sign in, for ever.
       *
       * So these are not style preferences. A SQL adapter must JOIN the user
       * row on read and write identity THROUGH the user table.
       * =====================================================================
       */

      it("a status change made through the user record is visible on the student", async () => {
        await withRepo(async (ports) => {
          const user = await makeUser(ports);
          await ports.students.createForUser(user.id, PROFILE_INPUT);

          await ports.users.setStatus(user.id, "active");

          const student = await ports.students.findById(user.id);
          assert.equal(
            student?.status,
            "active",
            "the student must reflect the user's status, not a stale copy",
          );
        });
      });

      it("students.setStatus writes THROUGH to the user record", async () => {
        // This is the one that matters for login: the status it gates on
        // must be the status an admin just set.
        await withRepo(async (ports) => {
          const user = await makeUser(ports);
          await ports.students.createForUser(user.id, PROFILE_INPUT);

          await ports.students.setStatus(user.id, "active");

          const refreshed = await ports.users.findById(user.id);
          assert.equal(
            refreshed?.status,
            "active",
            "login reads the user record, so activation must reach it",
          );
        });
      });

      it("an email change on the user record is visible on the student", async () => {
        await withRepo(async (ports) => {
          const user = await makeUser(ports, "before@test.local", "9876500200");
          await ports.students.createForUser(user.id, PROFILE_INPUT);

          await ports.users.update(user.id, { name: "Renamed Person" });

          const student = await ports.students.findById(user.id);
          assert.equal(student?.name, "Renamed Person");
        });
      });

      it("students.update routes identity fields to the user record", async () => {
        await withRepo(async (ports) => {
          const user = await makeUser(ports);
          await ports.students.createForUser(user.id, PROFILE_INPUT);

          await ports.students.update(user.id, { name: "Via Student Port" });

          const refreshed = await ports.users.findById(user.id);
          assert.equal(
            refreshed?.name,
            "Via Student Port",
            "writing identity only to the student row would be a silent no-op",
          );
        });
      });

      it("profile fields are NOT routed to the user record", async () => {
        await withRepo(async (ports) => {
          const user = await makeUser(ports);
          await ports.students.createForUser(user.id, PROFILE_INPUT);

          const updated = await ports.students.update(user.id, {
            collegeName: "Osmania University",
          });

          assert.equal(updated.collegeName, "Osmania University");
          assert.equal(updated.name, user.name, "identity must be unaffected");
        });
      });

      it("findMany filters on the AUTHORITATIVE status, not a snapshot", async () => {
        await withRepo(async (ports) => {
          const user = await makeUser(ports);
          await ports.students.createForUser(user.id, PROFILE_INPUT);

          // Changed through the user record only.
          await ports.users.setStatus(user.id, "active");

          const active = await ports.students.findMany(
            { status: "active" },
            { page: 1, pageSize: 10 },
          );
          const pending = await ports.students.findMany(
            { status: "pending" },
            { page: 1, pageSize: 10 },
          );

          assert.equal(active.total, 1, "the student must match its real status");
          assert.equal(pending.total, 0, "and must not match the stale one");
        });
      });

      it("findByEmail resolves through the authoritative email", async () => {
        await withRepo(async (ports) => {
          const user = await makeUser(ports, "authoritative@test.local", "9876500201");
          await ports.students.createForUser(user.id, PROFILE_INPUT);

          const found = await ports.students.findByEmail("authoritative@test.local");
          assert.equal(found?.id, user.id);
        });
      });

      it("a user with no profile is not a student, even by email", async () => {
        await withRepo(async (ports) => {
          await makeUser(ports, "userwithoutprofile@test.local", "9876500202");

          assert.equal(await ports.students.findByEmail("userwithoutprofile@test.local"), null);
          assert.equal(await ports.students.existsByEmail("userwithoutprofile@test.local"), false);
        });
      });
    });

    describe("existence checks used by registration", () => {
      it("existsByEmail and existsByMobile see a created profile", async () => {
        await withRepo(async (ports) => {
          const user = await makeUser(ports, "dupe@test.local", "9876500099");
          await ports.students.createForUser(user.id, PROFILE_INPUT);

          assert.equal(await ports.students.existsByEmail("dupe@test.local"), true);
          assert.equal(await ports.students.existsByMobile("9876500099"), true);
        });
      });

      it("are false for an unknown identifier", async () => {
        await withRepo(async (ports) => {
          assert.equal(await ports.students.existsByEmail("nobody@test.local"), false);
          assert.equal(await ports.students.existsByMobile("9999999999"), false);
        });
      });
    });
  });
};
