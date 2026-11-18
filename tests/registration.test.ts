import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import type { CredentialRepository } from "../src/modules/auth/credential.repository";
import { createLoginService } from "../src/modules/auth/login.service";
import { verifyPassword } from "../src/modules/auth/password.service";
import {
  createRegistrationService,
  type RegistrationResult,
  type RegistrationService,
} from "../src/modules/auth/registration.service";
import type { StudentRepository } from "../src/modules/students/student.repository";
import type { UserRepository } from "../src/modules/users/user.repository";
import { describeError } from "../src/utils/redact";
import { createTestHarness, type TestHarness } from "./fakes";

/**
 * Registration service tests.
 *
 * Real argon2id throughout, over the in-memory fakes. Hashing costs ~120ms,
 * so the valid-input fixture is reused where the test is not about hashing.
 */

const PASSWORD = "Password@123";

/** A complete, valid registration payload. */
const validInput = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "Ananya Rao",
  email: "ananya@test.local",
  mobile: "9876543210",
  password: PASSWORD,
  confirmPassword: PASSWORD,
  collegeName: "Nexelvoria Institute of Technology",
  degreeBranch: "B.Tech CSE",
  passingYear: "2026",
  courseInterestedIn: "Java Full Stack",
  dateOfBirth: "2004-05-10",
  gender: "female",
  fullAddress: "12 Cyber Towers, Hyderabad 500081",
  guardianContact: "9876500000",
  termsAccepted: true,
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

describe("registration service", () => {
  let h: TestHarness;
  let service: RegistrationService;

  beforeEach(() => {
    h = createTestHarness();
    service = createRegistrationService({
      users: h.users,
      credentials: h.credentials,
      students: h.students,
    });
  });

  const serviceWith = (overrides: {
    users?: UserRepository;
    credentials?: CredentialRepository;
    students?: StudentRepository;
  }): RegistrationService =>
    createRegistrationService({
      users: overrides.users ?? h.users,
      credentials: overrides.credentials ?? h.credentials,
      students: overrides.students ?? h.students,
    });

  const expectFailure = (
    result: RegistrationResult,
  ): Extract<RegistrationResult, { outcome: "failure" }> => {
    assert.equal(result.outcome, "failure", `expected failure, got ${JSON.stringify(result)}`);
    if (result.outcome !== "failure") assert.fail("expected a failure");
    return result;
  };

  const expectSuccess = (
    result: RegistrationResult,
  ): Extract<RegistrationResult, { outcome: "success" }> => {
    assert.equal(result.outcome, "success", `expected success, got ${JSON.stringify(result)}`);
    if (result.outcome !== "success") assert.fail("expected success");
    return result;
  };

  describe("successful registration", () => {
    it("creates a pending user and a credential", async () => {
      const { data } = expectSuccess(await service.register(validInput()));

      assert.ok(data.tempStudentId);
      assert.equal(data.email, "ananya@test.local");
      assert.equal(data.mobile, "9876543210");

      const user = await h.users.findById(data.tempStudentId);
      assert.ok(user);
      assert.equal(user.role, "student");
      assert.equal(user.status, "pending", "not active until verified and approved");
      assert.equal(user.name, "Ananya Rao");

      const credential = await h.credentials.findByUserId(data.tempStudentId);
      assert.ok(credential, "a credential exists");
      assert.equal(credential.failedLoginAttempts, 0);
    });

    it("stores a verifiable argon2id hash, never the password", async () => {
      const { data } = expectSuccess(await service.register(validInput()));

      const credential = await h.credentials.findByUserId(data.tempStudentId);
      assert.ok(credential);

      assert.match(credential.passwordHash, /^\$argon2id\$/);
      assert.equal((await verifyPassword(credential.passwordHash, PASSWORD)).valid, true);
      assert.equal(
        JSON.stringify(credential).includes(PASSWORD),
        false,
        "the plaintext must not be stored",
      );
    });

    it("normalises the email to lowercase so lookups agree", async () => {
      const { data } = expectSuccess(
        await service.register(validInput({ email: "  ANANYA@TEST.LOCAL  " })),
      );

      assert.equal(data.email, "ananya@test.local");
      assert.ok(await h.users.findByEmail("ananya@test.local"));
    });

    it("leaves the account unable to log in until it is activated", async () => {
      // Correct and deliberate: BR-001 verification and BR-002 approval both
      // precede activation, and no OTP step exists yet (Q3).
      expectSuccess(await service.register(validInput()));

      const login = await createLoginService({
        users: h.users,
        credentials: h.credentials,
        sessions: h.sessions,
        maxFailedLoginAttempts: 5,
      }).login({ identifier: "ananya@test.local", password: PASSWORD });

      assert.equal(login.outcome, "failure");
      if (login.outcome === "failure") {
        assert.equal(login.reason, "account_pending", "the password is right; the account is not");
      }
    });
  });

  describe("role escalation is impossible", () => {
    it("ignores a role supplied in the payload", async () => {
      for (const role of ["admin", "super_admin", "teacher", "public"]) {
        h.reset();

        const { data } = expectSuccess(
          await service.register(validInput({ role })),
        );

        const user = await h.users.findById(data.tempStudentId);
        assert.equal(user?.role, "student", `a payload role of "${role}" must be ignored`);
      }
    });

    it("ignores a status supplied in the payload", async () => {
      const { data } = expectSuccess(
        await service.register(validInput({ status: "active" })),
      );

      const user = await h.users.findById(data.tempStudentId);
      assert.equal(user?.status, "pending", "self-activation must be impossible");
    });

    it("ignores an id supplied in the payload", async () => {
      const { data } = expectSuccess(
        await service.register(validInput({ id: "user-chosen-by-client" })),
      );

      assert.notEqual(data.tempStudentId, "user-chosen-by-client");
    });
  });

  describe("required-field validation", () => {
    it("rejects a payload with every field missing", async () => {
      const failure = expectFailure(await service.register({}));

      assert.equal(failure.reason, "validation_failed");
      assert.ok(failure.issues && failure.issues.length >= 10, "every missing field is reported");
    });

    it("rejects each required field individually", async () => {
      const required = [
        "name",
        "email",
        "mobile",
        "password",
        "confirmPassword",
        "collegeName",
        "degreeBranch",
        "passingYear",
        "courseInterestedIn",
        "dateOfBirth",
        "gender",
        "fullAddress",
        "guardianContact",
        "termsAccepted",
      ];

      for (const field of required) {
        const input = validInput();
        delete input[field];

        const failure = expectFailure(await service.register(input));

        assert.equal(failure.reason, "validation_failed", `${field} must be required`);
        assert.ok(
          failure.issues?.some((issue) => issue.field === field),
          `the issue must name "${field}", got ${JSON.stringify(failure.issues)}`,
        );
      }
    });

    it("enforces the confirmed formats", async () => {
      const cases: [string, unknown, string][] = [
        ["name", "Al", "name"],
        ["email", "not-an-email", "email"],
        ["mobile", "1234567890", "mobile"],
        ["mobile", "98765", "mobile"],
        ["passingYear", "1999", "passingYear"],
        ["gender", "unspecified", "gender"],
        ["fullAddress", "short", "fullAddress"],
        ["guardianContact", "0000000000", "guardianContact"],
        ["linkedInUrl", "not-a-url", "linkedInUrl"],
        ["termsAccepted", false, "termsAccepted"],
      ];

      for (const [field, value, expectedField] of cases) {
        const failure = expectFailure(await service.register(validInput({ [field]: value })));

        assert.equal(failure.reason, "validation_failed", `${field}=${String(value)}`);
        assert.ok(
          failure.issues?.some((issue) => issue.field === expectedField),
          `${field}=${String(value)} should report ${expectedField}`,
        );
      }
    });

    it("accepts the optional fields as empty strings", async () => {
      expectSuccess(
        await service.register(validInput({ linkedInUrl: "", githubUrl: "" })),
      );
    });

    it("rejects mismatched password confirmation", async () => {
      const failure = expectFailure(
        await service.register(validInput({ confirmPassword: "Different@456" })),
      );

      assert.equal(failure.reason, "validation_failed");
      assert.ok(failure.issues?.some((issue) => issue.field === "confirmPassword"));
    });

    it("creates nothing when validation fails", async () => {
      expectFailure(await service.register({}));

      assert.equal(h.users.count, 0);
      assert.equal(h.credentials.count, 0);
    });
  });

  describe("password policy", () => {
    it("rejects every weak password with a field-level issue", async () => {
      // One case per policy rule, so a rule that is quietly dropped fails a
      // test. Each string breaks exactly one rule except the last two.
      const weak = [
        "Sh1!rt", // 6 chars - under PASSWORD_MIN_LENGTH
        "nouppercase1!", // no uppercase
        "NOLOWERCASE1!", // no lowercase
        "NoDigitsHere!", // no digit
        "NoSpecial1234", // no special character
        "a", // far too short, breaks four rules
        "", // empty
        `A1!${"a".repeat(130)}`, // over PASSWORD_MAX_LENGTH
      ];

      for (const password of weak) {
        const failure = expectFailure(
          await service.register(validInput({ password, confirmPassword: password })),
        );

        assert.equal(failure.reason, "validation_failed", `"${password}" must be refused`);
        assert.ok(
          failure.issues?.some((issue) => issue.field === "password"),
          `"${password}" should report the password field`,
        );
      }

      assert.equal(h.users.count, 0, "no weak password ever reaches storage");
    });

    it("never echoes the submitted password in an issue", async () => {
      const secret = "sup3rsecret";

      const failure = expectFailure(
        await service.register(validInput({ password: secret, confirmPassword: secret })),
      );

      assert.equal(JSON.stringify(failure).includes(secret), false);
    });
  });

  describe("uniqueness", () => {
    it("rejects a duplicate email", async () => {
      expectSuccess(await service.register(validInput()));

      const failure = expectFailure(
        await service.register(validInput({ mobile: "9876500001" })),
      );

      assert.equal(failure.reason, "email_taken");
      assert.equal(h.users.count, 1, "no second user");
    });

    it("rejects a duplicate email regardless of case", async () => {
      expectSuccess(await service.register(validInput()));

      const failure = expectFailure(
        await service.register(
          validInput({ email: "ANANYA@TEST.LOCAL", mobile: "9876500001" }),
        ),
      );

      assert.equal(failure.reason, "email_taken");
    });

    it("rejects a duplicate mobile", async () => {
      expectSuccess(await service.register(validInput()));

      const failure = expectFailure(
        await service.register(validInput({ email: "other@test.local" })),
      );

      assert.equal(failure.reason, "mobile_taken");
    });

    it("leaves no credential behind for a rejected duplicate", async () => {
      expectSuccess(await service.register(validInput()));
      expectFailure(await service.register(validInput({ mobile: "9876500001" })));

      assert.equal(h.credentials.count, 1, "exactly one credential exists");
    });
  });

  describe("concurrent duplicate registrations", () => {
    it("exactly one of two identical registrations succeeds", async () => {
      const results = await Promise.all([
        service.register(validInput()),
        service.register(validInput()),
      ]);

      const successes = results.filter((r) => r.outcome === "success");
      const failures = results.filter((r) => r.outcome === "failure");

      assert.equal(successes.length, 1, "exactly one may win");
      assert.equal(failures.length, 1);

      const loser = failures[0];
      if (loser?.outcome === "failure") {
        assert.ok(
          loser.reason === "email_taken" || loser.reason === "mobile_taken",
          `the loser must report a conflict, got ${loser.reason}`,
        );
      }

      assert.equal(h.users.count, 1, "only one user exists");
      assert.equal(h.credentials.count, 1);
    });

    it("relies on the atomic create, not the fast-path read", async () => {
      // The pre-check is a convenience. Forcing it to report "free" proves
      // the authoritative guard is the create itself.
      expectSuccess(await service.register(validInput()));

      const blind = withOverrides<UserRepository>(h.users, {
        existsByEmail: async () => false,
        existsByMobile: async () => false,
      });

      const failure = expectFailure(
        await serviceWith({ users: blind }).register(validInput()),
      );

      assert.equal(failure.reason, "email_taken", "the create's DuplicateRecordError is the guard");
      assert.equal(h.users.count, 1);
    });

    it("three concurrent attempts still yield one user", async () => {
      const results = await Promise.all([
        service.register(validInput()),
        service.register(validInput()),
        service.register(validInput()),
      ]);

      assert.equal(results.filter((r) => r.outcome === "success").length, 1);
      assert.equal(h.users.count, 1);
    });
  });

  describe("repository failures and partial writes", () => {
    it("fails closed when the uniqueness check throws", async () => {
      const broken = withOverrides<UserRepository>(h.users, {
        existsByEmail: () => {
          throw new Error("connection reset");
        },
      });

      const failure = expectFailure(
        await serviceWith({ users: broken }).register(validInput()),
      );

      assert.equal(failure.reason, "registration_unavailable");
      assert.equal(h.users.count, 0, "nothing was created");
    });

    it("fails closed when the user create throws", async () => {
      const broken = withOverrides<UserRepository>(h.users, {
        create: () => {
          throw new Error("connection reset");
        },
      });

      const failure = expectFailure(
        await serviceWith({ users: broken }).register(validInput()),
      );

      assert.equal(failure.reason, "registration_unavailable");
      assert.equal(h.credentials.count, 0, "no orphaned credential");
    });

    it("reports INCOMPLETE when the credential create fails after the user", async () => {
      // The documented partial-write case. The service must not report
      // success, and must not pretend the account is usable.
      const broken = withOverrides<CredentialRepository>(h.credentials, {
        create: () => {
          throw new Error("connection reset");
        },
      });

      const failure = expectFailure(
        await serviceWith({ credentials: broken }).register(validInput()),
      );

      assert.equal(failure.reason, "incomplete");

      // The honest state: the user EXISTS and has no credential.
      assert.equal(h.users.count, 1, "the user was created");
      assert.equal(h.credentials.count, 0, "and has no credential");
    });

    it("a partially created account cannot be logged into", async () => {
      // This is why the ordering is user-then-credential: the failure mode
      // is closed, not open.
      const broken = withOverrides<CredentialRepository>(h.credentials, {
        create: () => {
          throw new Error("connection reset");
        },
      });

      expectFailure(await serviceWith({ credentials: broken }).register(validInput()));

      const login = await createLoginService({
        users: h.users,
        credentials: h.credentials,
        sessions: h.sessions,
        maxFailedLoginAttempts: 5,
      }).login({ identifier: "ananya@test.local", password: PASSWORD });

      assert.equal(login.outcome, "failure");
      if (login.outcome === "failure") {
        assert.equal(
          login.reason,
          "invalid_credentials",
          "a user with no credential is indistinguishable from a wrong password",
        );
      }
      assert.equal(h.sessions.count, 0, "and no session is created");
    });

    it("a partially created account still holds the identifiers", async () => {
      // The documented cost: retrying is impossible because there is no
      // way to remove the orphan. Asserted so nobody assumes otherwise.
      const broken = withOverrides<CredentialRepository>(h.credentials, {
        create: () => {
          throw new Error("connection reset");
        },
      });

      expectFailure(await serviceWith({ credentials: broken }).register(validInput()));

      const retry = expectFailure(await service.register(validInput()));

      assert.equal(
        retry.reason,
        "email_taken",
        "the email stays taken - this needs operator intervention",
      );
    });
  });

  describe("no sensitive information leaks", () => {
    it("returns no hash, token or password on success", async () => {
      const success = expectSuccess(await service.register(validInput()));
      const serialised = JSON.stringify(success);

      assert.equal(serialised.includes(PASSWORD), false);
      assert.equal(serialised.includes("argon2"), false);
      assert.equal(serialised.includes("passwordHash"), false);
      assert.equal(serialised.includes("accessToken"), false);
      assert.equal(serialised.includes("refreshToken"), false);

      assert.deepEqual(
        Object.keys(success.data).sort(),
        ["email", "mobile", "tempStudentId"],
        "exactly the confirmed payload",
      );
    });

    it("keeps the failure shape minimal", async () => {
      expectSuccess(await service.register(validInput()));

      // A conflict carries no `issues` key at all, so nothing about the
      // existing account can be inferred from the shape.
      const duplicate = expectFailure(await service.register(validInput()));
      assert.deepEqual(Object.keys(duplicate).sort(), ["outcome", "reason"]);

      const invalid = expectFailure(await service.register({}));
      assert.deepEqual(Object.keys(invalid).sort(), ["issues", "outcome", "reason"]);
    });

    it("logs no driver text when a repository fails", async () => {
      const SENSITIVE =
        "Login failed for user 'sa' with password 'P@ssw0rd!' on server db-prod-01:1433";

      const lines: string[] = [];
      const originalError = console.error;
      const originalWarn = console.warn;
      const originalLog = console.log;

      const capture = (...args: unknown[]): void => {
        lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      };

      console.error = capture;
      console.warn = capture;
      console.log = capture;

      try {
        const broken = withOverrides<CredentialRepository>(h.credentials, {
          create: () => {
            throw new Error(SENSITIVE);
          },
        });

        await serviceWith({ credentials: broken }).register(validInput());
      } finally {
        console.error = originalError;
        console.warn = originalWarn;
        console.log = originalLog;
      }

      const output = lines.join("\n");

      for (const secret of ["P@ssw0rd!", "db-prod-01", "1433", "Login failed for user"]) {
        assert.equal(output.includes(secret), false, `logs must not contain ${secret}`);
      }

      assert.ok(output.includes("REGISTRATION INCOMPLETE"), "the operational warning is present");
      assert.ok(output.includes("Error"), "the error class is logged");
    });

    it("describeError is what keeps driver text out", () => {
      assert.equal(describeError(new Error("Server=db-prod-01;Password=secret;")), "Error");
    });
  });

  /**
   * Step 6K-2: the student PROFILE half of registration.
   *
   * Registration now writes three records - user, credential and student
   * profile - and the profile is keyed by the user's own id. These tests
   * assert the OBSERVABLE contract, including on partial failure. They
   * deliberately do NOT simulate a rollback: the writes are not atomic, and
   * a test that pretended otherwise would prove something false.
   */
  describe("student profile creation (Step 6K-2)", () => {
    /** Fails every `createForUser`, leaving user + credential written. */
    const brokenProfiles = (): StudentRepository =>
      withOverrides<StudentRepository>(h.students, {
        createForUser: () => {
          throw new Error("profile store unavailable");
        },
      });

    describe("successful registration", () => {
      it("creates a user, a credential AND a student profile", async () => {
        const { data } = expectSuccess(await service.register(validInput()));

        assert.ok(await h.users.findById(data.tempStudentId), "user exists");
        assert.ok(await h.credentials.findByUserId(data.tempStudentId), "credential exists");
        assert.ok(await h.students.findById(data.tempStudentId), "student profile exists");
        assert.equal(h.students.count, 1);
      });

      it("keeps Student.id === User.id end to end", async () => {
        const { data } = expectSuccess(await service.register(validInput()));

        const user = await h.users.findById(data.tempStudentId);
        const student = await h.students.findById(data.tempStudentId);

        assert.ok(user);
        assert.ok(student);
        assert.equal(student.id, user.id, "the shared primary key (Q25 Option A)");
        // The response id IS the shared key, so the frontend's
        // `tempStudentId` resolves both records.
        assert.equal(data.tempStudentId, user.id);
      });

      it("persists every admissions field exactly as submitted", async () => {
        const { data } = expectSuccess(await service.register(validInput()));
        const student = await h.students.findById(data.tempStudentId);

        assert.ok(student);
        assert.equal(student.collegeName, "Nexelvoria Institute of Technology");
        assert.equal(student.degreeBranch, "B.Tech CSE");
        assert.equal(student.passingYear, "2026");
        assert.equal(student.courseInterestedIn, "Java Full Stack");
        assert.equal(student.dateOfBirth, "2004-05-10");
        assert.equal(student.gender, "female");
        assert.equal(student.fullAddress, "12 Cyber Towers, Hyderabad 500081");
        assert.equal(student.guardianContact, "9876500000");
      });

      it("applies the server-owned defaults", async () => {
        const { data } = expectSuccess(await service.register(validInput()));
        const student = await h.students.findById(data.tempStudentId);

        assert.ok(student);
        assert.equal(student.role, "student");
        assert.equal(student.isEmailVerified, false, "BR-001 starts unverified");
        assert.equal(student.isMobileVerified, false, "BR-001 starts unverified");
        assert.equal(student.adminApprovalStatus, "pending", "BR-002 starts pending");
        assert.deepEqual(student.enrolledCourseIds, []);
        // No fabricated lifecycle value - the mapping is not a confirmed rule.
        assert.equal("accountState" in student, false);
      });

      it("takes identity from the user record, not from the profile input", async () => {
        const { data } = expectSuccess(await service.register(validInput()));

        const user = await h.users.findById(data.tempStudentId);
        const student = await h.students.findById(data.tempStudentId);

        assert.ok(user);
        assert.ok(student);
        assert.equal(student.name, user.name);
        assert.equal(student.email, user.email);
        assert.equal(student.email, "ananya@test.local", "normalised to lowercase");
        assert.equal(student.mobile, user.mobile);
        assert.equal(student.status, "pending");
        assert.equal(student.createdAt, user.createdAt);
      });

      it("stores the optional profile links when supplied", async () => {
        const { data } = expectSuccess(
          await service.register(
            validInput({
              linkedInUrl: "https://linkedin.com/in/ananya",
              githubUrl: "https://github.com/ananya",
              resumeFileName: "ananya-cv.pdf",
              resumeFileSize: "182kb",
            }),
          ),
        );

        const student = await h.students.findById(data.tempStudentId);

        assert.ok(student);
        assert.equal(student.linkedInUrl, "https://linkedin.com/in/ananya");
        assert.equal(student.githubUrl, "https://github.com/ananya");
        assert.equal(student.resumeFileName, "ananya-cv.pdf");
        assert.equal(student.resumeFileSize, "182kb");
      });

      it("omits optional fields submitted as empty strings (D-A)", async () => {
        // The frontend submits an untouched URL input as "". Storing that
        // would put `linkedInUrl: ""` into every API response.
        const { data } = expectSuccess(
          await service.register(validInput({ linkedInUrl: "", githubUrl: "" })),
        );

        const student = await h.students.findById(data.tempStudentId);

        assert.ok(student);
        assert.equal("linkedInUrl" in student, false, "absent, not an empty string");
        assert.equal("githubUrl" in student, false, "absent, not an empty string");
      });

      it("omits optional fields that were never supplied", async () => {
        const { data } = expectSuccess(await service.register(validInput()));
        const student = await h.students.findById(data.tempStudentId);

        assert.ok(student);
        for (const field of ["linkedInUrl", "githubUrl", "resumeFileName", "resumeFileSize"]) {
          assert.equal(field in student, false, `${field} must be absent`);
        }
        // Never collected at registration - file storage is unresolved (Q11).
        assert.equal("resumeUrl" in student, false);
      });

      it("writes no field the whitelist does not name", async () => {
        const { data } = expectSuccess(
          await service.register(
            validInput({ resumeUrl: "https://evil.test/x", smuggled: "nope" }),
          ),
        );

        const student = await h.students.findById(data.tempStudentId);

        assert.ok(student);
        assert.equal("resumeUrl" in student, false, "not accepted from the payload");
        assert.equal("smuggled" in student, false);
      });
    });

    describe("profile creation failure", () => {
      it("reports profile_incomplete and NEVER success", async () => {
        const result = await serviceWith({ students: brokenProfiles() }).register(validInput());

        const failure = expectFailure(result);
        assert.equal(failure.reason, "profile_incomplete");
        assert.notEqual(result.outcome, "success");
      });

      it("leaves the user and credential in place - the real partial state", async () => {
        // Documented, not hidden: the writes are not atomic, so the first
        // two records genuinely survive.
        await serviceWith({ students: brokenProfiles() }).register(validInput());

        const user = await h.users.findByEmail("ananya@test.local");
        assert.ok(user, "the user was created and still exists");
        assert.ok(await h.credentials.findByUserId(user.id), "the credential also exists");
      });

      it("writes no student profile", async () => {
        await serviceWith({ students: brokenProfiles() }).register(validInput());

        assert.equal(h.students.count, 0, "no partial profile row");
      });

      it("leaks no hash, token or password in the failure", async () => {
        const result = await serviceWith({ students: brokenProfiles() }).register(validInput());
        const serialised = JSON.stringify(result);

        assert.equal(serialised.includes(PASSWORD), false, "never the password");
        assert.equal(serialised.includes("$argon2"), false, "never a hash");
        assert.equal(serialised.includes("profile store unavailable"), false, "never driver text");
        // A failure carries only outcome + reason.
        assert.deepEqual(Object.keys(result).sort(), ["outcome", "reason"]);
      });

      it("is recoverable: createForUser succeeds afterwards", async () => {
        await serviceWith({ students: brokenProfiles() }).register(validInput());

        const user = await h.users.findByEmail("ananya@test.local");
        assert.ok(user);

        // The working repository can complete what the broken one could not.
        const student = await h.students.createForUser(user.id, {
          collegeName: "Nexelvoria Institute of Technology",
          degreeBranch: "B.Tech CSE",
          passingYear: "2026",
          courseInterestedIn: "Java Full Stack",
          dateOfBirth: "2004-05-10",
          gender: "female",
          fullAddress: "12 Cyber Towers, Hyderabad 500081",
        });

        assert.equal(student.id, user.id, "still the shared key");
      });

      it("reports SUCCESS when the write errored but actually committed", async () => {
        // A timeout that commits is indistinguishable from one that does
        // not, so the service confirms by reading rather than guessing.
        const flaky = withOverrides<StudentRepository>(h.students, {
          async createForUser(userId, profile) {
            await h.students.createForUser(userId, profile);
            throw new Error("connection reset after commit");
          },
        });

        const { data } = expectSuccess(
          await serviceWith({ students: flaky }).register(validInput()),
        );

        const student = await h.students.findById(data.tempStudentId);
        assert.ok(student, "the profile really is there");
        assert.equal(student.id, data.tempStudentId);
      });

      it("reports profile_incomplete when the confirming read also fails", async () => {
        // Fail closed: an outcome that cannot be established is never
        // reported as success.
        const blind = withOverrides<StudentRepository>(h.students, {
          createForUser: () => {
            throw new Error("write failed");
          },
          findById: () => {
            throw new Error("read failed too");
          },
        });

        const failure = expectFailure(
          await serviceWith({ students: blind }).register(validInput()),
        );

        assert.equal(failure.reason, "profile_incomplete");
      });
    });

    describe("existing guards still write no profile", () => {
      it("creates no profile for a duplicate email", async () => {
        expectSuccess(await service.register(validInput()));
        assert.equal(h.students.count, 1);

        const failure = expectFailure(
          await service.register(validInput({ mobile: "9876543211" })),
        );

        assert.equal(failure.reason, "email_taken");
        assert.equal(h.students.count, 1, "no second profile");
      });

      it("creates no profile for a duplicate mobile", async () => {
        expectSuccess(await service.register(validInput()));

        const failure = expectFailure(
          await service.register(validInput({ email: "other@test.local" })),
        );

        assert.equal(failure.reason, "mobile_taken");
        assert.equal(h.students.count, 1, "no second profile");
      });

      it("creates no profile when validation fails", async () => {
        const failure = expectFailure(await service.register(validInput({ collegeName: "" })));

        assert.equal(failure.reason, "validation_failed");
        assert.equal(h.students.count, 0);
        assert.equal(h.users.count, 0);
      });

      it("creates no profile when the credential write fails", async () => {
        const broken = withOverrides<CredentialRepository>(h.credentials, {
          create: () => {
            throw new Error("credential store down");
          },
        });

        const failure = expectFailure(
          await serviceWith({ credentials: broken }).register(validInput()),
        );

        assert.equal(failure.reason, "incomplete", "distinct from profile_incomplete");
        assert.equal(h.students.count, 0, "stage 6 is never reached");
      });

      it("still refuses a role supplied in the payload", async () => {
        const { data } = expectSuccess(
          await service.register(validInput({ role: "admin" })),
        );

        const user = await h.users.findById(data.tempStudentId);
        const student = await h.students.findById(data.tempStudentId);

        assert.equal(user?.role, "student");
        assert.equal(student?.role, "student");
      });

      it("still stores a verifiable argon2id hash, never the password", async () => {
        const { data } = expectSuccess(await service.register(validInput()));
        const credential = await h.credentials.findByUserId(data.tempStudentId);

        assert.ok(credential);
        assert.ok(credential.passwordHash.startsWith("$argon2id$"));
        assert.notEqual(credential.passwordHash, PASSWORD);
        assert.equal((await verifyPassword(credential.passwordHash, PASSWORD)).valid, true);
      });
    });
  });
});
