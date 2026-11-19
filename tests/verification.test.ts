import { Router, type RequestHandler } from "express";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app";
import { createRateLimiter } from "../src/middleware/rate-limit.middleware";
import {
  createOtpService,
  type OtpService,
} from "../src/modules/auth/otp.service";
import type {
  OtpDeliveryPort,
  OtpDeliveryRequest,
  OtpDeliveryResult,
} from "../src/modules/auth/otp.delivery";
import {
  createVerificationService,
  type VerificationService,
} from "../src/modules/auth/verification.service";
import { deriveAccountState } from "../src/modules/students/account-state";
import { issueVerificationTicket } from "../src/modules/auth/token.service";
import { createDevAuthRoutes } from "../dev/auth.dev.routes";
import { createTestHarness, type TestHarness } from "./fakes";
import { json, startServer, type TestServer } from "./helpers/server";

/** Records what was "sent" so a test can learn the code. */
class RecordingDelivery implements OtpDeliveryPort {
  readonly channel = "email" as const;
  readonly sent: OtpDeliveryRequest[] = [];
  failWith: string | null = null;

  async send(request: OtpDeliveryRequest): Promise<OtpDeliveryResult> {
    if (this.failWith !== null) {
      return { delivered: false, reason: this.failWith };
    }

    this.sent.push(request);

    return { delivered: true };
  }

  get lastCode(): string {
    const last = this.sent[this.sent.length - 1];
    assert.ok(last !== undefined, "no OTP was delivered");

    return last.code;
  }
}

const validInput = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "Ananya Rao",
  email: "ananya@test.local",
  mobile: "9876543210",
  password: "Str0ng!Pass1",
  confirmPassword: "Str0ng!Pass1",
  collegeName: "JNTU Hyderabad",
  degreeBranch: "B.Tech CSE",
  passingYear: "2025",
  courseInterestedIn: "Full Stack Development",
  dateOfBirth: "2003-04-12",
  gender: "male",
  fullAddress: "12-3-45 Ameerpet, Hyderabad, Telangana 500016",
  guardianContact: "9876500000",
  termsAccepted: true,
  ...overrides,
});

const permissive = (): RequestHandler =>
  createRateLimiter({ windowMs: 60_000, limit: 500, message: "test limiter" });

// ---------------------------------------------------------------------------
// accountState derivation
// ---------------------------------------------------------------------------

describe("deriveAccountState", () => {
  it("is pending_verification before the email is confirmed", () => {
    assert.equal(
      deriveAccountState({
        status: "pending",
        isEmailVerified: false,
        adminApprovalStatus: "pending",
      }),
      "pending_verification",
    );
  });

  it("is pending_approval once the email is confirmed (BR-002 gate)", () => {
    assert.equal(
      deriveAccountState({
        status: "pending",
        isEmailVerified: true,
        adminApprovalStatus: "pending",
      }),
      "pending_approval",
    );
  });

  it("is approved once an admin has approved, whatever the activation status", () => {
    // CORRECTED at Phase 4. This originally required `status === "active"`
    // as well, which left an approved-but-not-yet-active student with no
    // nameable state at all.
    //
    // `AccountState` describes the REGISTRATION lifecycle; `UserStatus`
    // describes whether the account may be used. BR-002 says approval gates
    // PAYMENT and activation follows payment, so an approved student is
    // legitimately still `pending` for a while - and the admin list needs to
    // show "approved" during exactly that window.
    assert.equal(
      deriveAccountState({
        status: "active",
        isEmailVerified: true,
        adminApprovalStatus: "approved",
      }),
      "approved",
    );

    assert.equal(
      deriveAccountState({
        status: "pending",
        isEmailVerified: true,
        adminApprovalStatus: "approved",
      }),
      "approved",
    );
  });

  it("lets a rejection outrank verification", () => {
    // Re-verifying an email must not revive a rejected application.
    assert.equal(
      deriveAccountState({
        status: "pending",
        isEmailVerified: true,
        adminApprovalStatus: "rejected",
      }),
      "rejected",
    );

    assert.equal(
      deriveAccountState({
        status: "active",
        isEmailVerified: true,
        adminApprovalStatus: "rejected",
      }),
      "rejected",
    );
  });

  it("lets a suspension outrank approval", () => {
    assert.equal(
      deriveAccountState({
        status: "suspended",
        isEmailVerified: true,
        adminApprovalStatus: "approved",
      }),
      "suspended",
    );
  });

  it("reports deactivated, which the union can now express", () => {
    // `deactivated` was added to ACCOUNT_STATES at the Student Login
    // integration. Before that this returned `undefined` and the admin badge
    // was blank for deactivated students.
    assert.equal(
      deriveAccountState({
        status: "deactivated",
        isEmailVerified: true,
        adminApprovalStatus: "approved",
      }),
      "deactivated",
    );
  });

  it("lets a rejection still outrank deactivation", () => {
    assert.equal(
      deriveAccountState({
        status: "deactivated",
        isEmailVerified: true,
        adminApprovalStatus: "rejected",
      }),
      "rejected",
    );
  });

  it("keeps suspended and deactivated distinct", () => {
    const suspended = deriveAccountState({
      status: "suspended",
      isEmailVerified: true,
      adminApprovalStatus: "approved",
    });
    const deactivated = deriveAccountState({
      status: "deactivated",
      isEmailVerified: true,
      adminApprovalStatus: "approved",
    });

    assert.equal(suspended, "suspended");
    assert.equal(deactivated, "deactivated");
    assert.notEqual(suspended, deactivated);
  });

  it("does not consider isMobileVerified at all (mobile OTP is descoped)", () => {
    // The signature has no mobile field, so a student with an unverified
    // mobile still reaches pending_approval. If this ever changes, BR-014
    // has been revisited.
    assert.equal(
      deriveAccountState({
        status: "pending",
        isEmailVerified: true,
        adminApprovalStatus: "pending",
      }),
      "pending_approval",
    );
  });
});

// ---------------------------------------------------------------------------
// verification service
// ---------------------------------------------------------------------------

describe("verification service", () => {
  let h: TestHarness;
  let delivery: RecordingDelivery;
  let otp: OtpService;
  let service: VerificationService;

  /** Registers a student directly through the fakes and returns its id. */
  const seedStudent = async (
    email = "seed@test.local",
    mobile = "9876543210",
  ): Promise<string> => {
    const user = await h.users.create({
      name: "Seed Student",
      email,
      mobile,
      role: "student",
      status: "pending",
    });

    await h.students.createForUser(user.id, {
      collegeName: "JNTU",
      degreeBranch: "B.Tech CSE",
      passingYear: "2025",
      courseInterestedIn: "Full Stack Development",
      dateOfBirth: "2003-04-12",
      gender: "male",
      fullAddress: "12-3-45 Ameerpet, Hyderabad 500016",
    });

    return user.id;
  };

  beforeEach(() => {
    h = createTestHarness();
    delivery = new RecordingDelivery();
    otp = createOtpService({
      challenges: h.container.repositories.otpChallenges,
      delivery,
    });
    service = createVerificationService({
      otp,
      users: h.container.repositories.users,
      students: h.container.repositories.students,
    });
  });

  describe("sendEmailChallenge", () => {
    it("sends to the address on the USER RECORD, never one supplied by a caller", async () => {
      const id = await seedStudent("real.address@test.local");

      const result = await service.sendEmailChallenge(id);

      assert.equal(result.outcome, "success");
      assert.equal(delivery.sent.length, 1);
      assert.equal(delivery.sent[0]?.destination, "real.address@test.local");
    });

    it("returns the destination MASKED", async () => {
      const id = await seedStudent("ananya.rao@test.local");

      const result = await service.sendEmailChallenge(id);

      assert.ok(result.outcome === "success");
      assert.equal(result.data.sentTo, "a***o@test.local");
      assert.ok(!result.data.sentTo.includes("ananya.rao"));
    });

    it("reports unknown_account for an id that does not exist", async () => {
      const result = await service.sendEmailChallenge("user-nobody");

      assert.ok(result.outcome === "failure");
      assert.equal(result.reason, "unknown_account");
      assert.equal(delivery.sent.length, 0);
    });

    it("reports unknown_account when a user has no student profile", async () => {
      // Same reason as a missing user, so the two cannot be told apart.
      const user = await h.users.create({
        name: "Profileless",
        email: "noprofile@test.local",
        mobile: "9876500999",
        role: "student",
        status: "pending",
      });

      const result = await service.sendEmailChallenge(user.id);

      assert.ok(result.outcome === "failure");
      assert.equal(result.reason, "unknown_account");
    });

    it("refuses to re-send once the email is already verified", async () => {
      const id = await seedStudent();
      await h.students.markVerified(id, "email");

      const result = await service.sendEmailChallenge(id);

      assert.ok(result.outcome === "failure");
      assert.equal(result.reason, "already_verified");
      assert.equal(delivery.sent.length, 0);
    });

    it("surfaces the cooldown with a retry delay", async () => {
      const id = await seedStudent();
      await service.sendEmailChallenge(id);

      const again = await service.sendEmailChallenge(id);

      assert.ok(again.outcome === "failure");
      assert.equal(again.reason, "cooldown_active");
      assert.ok((again.retryAfterSeconds ?? 0) > 0);
    });

    it("surfaces a delivery failure", async () => {
      const id = await seedStudent();
      delivery.failWith = "smtp 554";

      const result = await service.sendEmailChallenge(id);

      assert.ok(result.outcome === "failure");
      assert.equal(result.reason, "delivery_failed");
    });
  });

  describe("verifyEmail", () => {
    it("accepts the correct code and marks the student verified", async () => {
      const id = await seedStudent();
      await service.sendEmailChallenge(id);

      const result = await service.verifyEmail(id, delivery.lastCode);

      assert.equal(result.outcome, "success");

      const student = await h.students.findById(id);
      assert.equal(student?.isEmailVerified, true);
    });

    it("reports pending_approval and awaitingAdminApproval after success", async () => {
      const id = await seedStudent();
      await service.sendEmailChallenge(id);

      const result = await service.verifyEmail(id, delivery.lastCode);

      assert.ok(result.outcome === "success");
      assert.equal(result.data.accountState, "pending_approval");
      assert.equal(result.data.awaitingAdminApproval, true);
      assert.equal(result.data.isEmailVerified, true);
      assert.equal(result.data.studentId, id);
    });

    it("leaks no profile data and issues no token", async () => {
      const id = await seedStudent("private.person@test.local");
      await service.sendEmailChallenge(id);

      const result = await service.verifyEmail(id, delivery.lastCode);

      assert.ok(result.outcome === "success");

      // Exactly the four status fields - nothing from the profile.
      assert.deepEqual(Object.keys(result.data).sort(), [
        "accountState",
        "awaitingAdminApproval",
        "isEmailVerified",
        "studentId",
      ]);

      const serialised = JSON.stringify(result.data);
      assert.ok(!serialised.includes("private.person"), "the email must not be returned");
      assert.ok(!serialised.includes("Ameerpet"), "the address must not be returned");
      assert.ok(!/token/i.test(serialised), "no token may be issued");
    });

    it("does NOT mark mobile verified (mobile OTP is descoped)", async () => {
      const id = await seedStudent();
      await service.sendEmailChallenge(id);
      await service.verifyEmail(id, delivery.lastCode);

      const student = await h.students.findById(id);
      assert.equal(student?.isMobileVerified, false);
    });

    it("rejects a wrong code and reports attempts remaining", async () => {
      const id = await seedStudent();
      await service.sendEmailChallenge(id);
      const wrong = delivery.lastCode === "000000" ? "111111" : "000000";

      const result = await service.verifyEmail(id, wrong);

      assert.ok(result.outcome === "failure");
      assert.equal(result.reason, "invalid_code");
      assert.equal(result.attemptsRemaining, 4);

      const student = await h.students.findById(id);
      assert.equal(student?.isEmailVerified, false, "a wrong code must not verify");
    });

    it("refuses a replay of a consumed code", async () => {
      const id = await seedStudent();
      await service.sendEmailChallenge(id);
      const code = delivery.lastCode;

      assert.equal((await service.verifyEmail(id, code)).outcome, "success");

      const replay = await service.verifyEmail(id, code);
      assert.ok(replay.outcome === "failure");
      // Caught by the already-verified guard before the OTP store is asked.
      assert.equal(replay.reason, "already_verified");
    });

    it("reports unknown_account for an unknown id", async () => {
      const result = await service.verifyEmail("user-nobody", "123456");

      assert.ok(result.outcome === "failure");
      assert.equal(result.reason, "unknown_account");
    });

    it("will not let one student verify with another's code", async () => {
      const victim = await seedStudent("victim@test.local", "9876500001");
      const attacker = await seedStudent("attacker@test.local", "9876500002");

      await service.sendEmailChallenge(victim);
      const victimCode = delivery.lastCode;

      const result = await service.verifyEmail(attacker, victimCode);

      assert.ok(result.outcome === "failure");
      assert.equal(result.reason, "no_active_challenge");

      const victimStudent = await h.students.findById(victim);
      assert.equal(victimStudent?.isEmailVerified, false);
    });

    it("reports verification_unavailable when the student record cannot be updated", async () => {
      const id = await seedStudent();
      await service.sendEmailChallenge(id);

      const broken = createVerificationService({
        otp,
        users: h.container.repositories.users,
        students: {
          ...h.container.repositories.students,
          findById: (studentId: string) => h.students.findById(studentId),
          markVerified: () => Promise.reject(new Error("db down")),
        } as never,
      });

      const result = await broken.verifyEmail(id, delivery.lastCode);

      assert.ok(result.outcome === "failure");
      assert.equal(result.reason, "verification_unavailable");
    });
  });
});

// ---------------------------------------------------------------------------
// HTTP endpoints
// ---------------------------------------------------------------------------

describe("email verification over HTTP (development-only)", () => {
  let h: TestHarness;
  let delivery: RecordingDelivery;
  let server: TestServer;

  const buildApp = () => {
    const otp = createOtpService({
      challenges: h.container.repositories.otpChallenges,
      delivery,
    });

    const verification = createVerificationService({
      otp,
      users: h.container.repositories.users,
      students: h.container.repositories.students,
    });

    const extraV1Routes = Router();
    extraV1Routes.use(
      "/auth",
      createDevAuthRoutes({
        deps: {
          get users() {
            return h.container.repositories.users;
          },
          get credentials() {
            return h.container.repositories.credentials;
          },
          get students() {
            return h.container.repositories.students;
          },
        },
        verification,
        rateLimiter: permissive(),
        otpRateLimiter: permissive(),
      }),
    );

    return createApp({ container: h.container, extraV1Routes });
  };

  /**
   * Registers over HTTP and returns the VERIFICATION TICKET.
   *
   * Not the id: the OTP endpoints accept only a ticket now, so no student id
   * travels in a body or a URL.
   */
  const register = async (overrides: Record<string, unknown> = {}): Promise<string> => {
    const res = await server.post("/api/v1/auth/register", validInput(overrides));
    assert.equal(res.status, 201);

    const data = (await json(res))["data"] as Record<string, unknown>;

    return data["verificationTicket"] as string;
  };

  before(async () => {
    h = createTestHarness();
    delivery = new RecordingDelivery();
    server = await startServer(buildApp());
  });

  after(async () => {
    await server.close();
  });

  beforeEach(() => {
    h.reset();
    delivery.sent.length = 0;
    delivery.failWith = null;
  });

  it("issues a verification code as part of registration", async () => {
    await register();

    assert.equal(delivery.sent.length, 1, "registering must send one code");
    assert.equal(delivery.sent[0]?.destination, "ananya@test.local");
  });

  it("keeps the registration payload to the D2 fields plus the ticket", async () => {
    const res = await server.post("/api/v1/auth/register", validInput());
    const body = await json(res);

    assert.deepEqual(Object.keys(body).sort(), ["data", "message", "success"]);

    // TRANSITIONAL: `tempStudentId` is retained for compatibility and
    // deprecated. `verificationTicket` is the field a client should use.
    assert.deepEqual(Object.keys(body["data"] as object).sort(), [
      "email",
      "mobile",
      "tempStudentId",
      "verificationTicket",
    ]);
  });

  it("still returns 201 when the code cannot be delivered, and says so", async () => {
    delivery.failWith = "smtp 554";

    const res = await server.post("/api/v1/auth/register", validInput());

    assert.equal(res.status, 201, "the account was created; it must not report failure");
    assert.match(String((await json(res))["message"]), /could not be sent/i);
  });

  it("verifies with the correct code", async () => {
    const ticket = await register();

    const res = await server.post("/api/v1/auth/otp/email/verify", {
      ticket,
      otp: delivery.lastCode,
    });

    assert.equal(res.status, 200);

    const body = await json(res);
    assert.equal(body["success"], true);

    const data = body["data"] as Record<string, unknown>;
    assert.equal(data["isEmailVerified"], true);
    assert.equal(data["accountState"], "pending_approval");
    assert.equal(data["awaitingAdminApproval"], true);
  });

  it("returns no token and no profile fields on success", async () => {
    const ticket = await register();

    const res = await server.post("/api/v1/auth/otp/email/verify", {
      ticket,
      otp: delivery.lastCode,
    });

    const data = (await json(res))["data"] as Record<string, unknown>;

    assert.deepEqual(Object.keys(data).sort(), [
      "accountState",
      "awaitingAdminApproval",
      "isEmailVerified",
      "studentId",
    ]);

    const serialised = JSON.stringify(data);
    assert.ok(!/token/i.test(serialised));
    assert.ok(!serialised.includes("ananya@test.local"));
    assert.ok(!serialised.includes("Ameerpet"));
  });

  it("rejects a wrong code with 400 and the attempts remaining", async () => {
    const ticket = await register();
    const wrong = delivery.lastCode === "000000" ? "111111" : "000000";

    const res = await server.post("/api/v1/auth/otp/email/verify", {
      ticket,
      otp: wrong,
    });

    assert.equal(res.status, 400);
    assert.match(String((await json(res))["message"]), /not correct.*4 attempt/i);
  });

  it("returns 422 for a malformed code without spending an attempt", async () => {
    const ticket = await register();

    const res = await server.post("/api/v1/auth/otp/email/verify", {
      ticket,
      otp: "12ab",
    });

    assert.equal(res.status, 422);

    // The correct code still works, so no attempt was consumed.
    const ok = await server.post("/api/v1/auth/otp/email/verify", {
      ticket,
      otp: delivery.lastCode,
    });
    assert.equal(ok.status, 200);
  });



  it("returns 401 for a forged ticket, revealing nothing about any account", async () => {
    // No student id is accepted any more, so there is no id to probe. A
    // junk ticket fails the signature check before any lookup happens.
    const res = await server.post("/api/v1/auth/otp/email/verify", {
      ticket: "not.a.real.ticket",
      otp: "123456",
    });

    assert.equal(res.status, 401);
    assert.match(String((await json(res))["message"]), /not valid|expired/i);
  });

  it("returns 422 when the ticket is missing entirely", async () => {
    const res = await server.post("/api/v1/auth/otp/email/verify", { otp: "123456" });

    assert.equal(res.status, 422);
  });

  it("returns 409 when the email is already verified", async () => {
    const ticket = await register();

    assert.equal(
      (
        await server.post("/api/v1/auth/otp/email/verify", {
          ticket,
          otp: delivery.lastCode,
        })
      ).status,
      200,
    );

    const again = await server.post("/api/v1/auth/otp/email/verify", {
      ticket,
      otp: "123456",
    });

    assert.equal(again.status, 409);
    assert.match(String((await json(again))["message"]), /already verified/i);
  });

  it("returns 429 once the attempt ceiling is reached", async () => {
    const ticket = await register();
    const wrong = delivery.lastCode === "000000" ? "111111" : "000000";

    for (let i = 0; i < 5; i += 1) {
      const res = await server.post("/api/v1/auth/otp/email/verify", {
        ticket,
        otp: wrong,
      });
      assert.equal(res.status, 400, `guess ${i + 1} should be a 400`);
    }

    const blocked = await server.post("/api/v1/auth/otp/email/verify", {
      ticket,
      otp: wrong,
    });

    assert.equal(blocked.status, 429);
    assert.match(String((await json(blocked))["message"]), /too many incorrect attempts/i);
  });

  it("refuses a resend inside the cooldown with 429", async () => {
    const ticket = await register();

    const res = await server.post("/api/v1/auth/otp/email/resend", { ticket });

    assert.equal(res.status, 429);
    assert.match(String((await json(res))["message"]), /sent recently/i);
  });

  it("masks the address in the resend response", async () => {
    // A fresh student whose registration send is then expired past the
    // cooldown is awkward to arrange over HTTP, so this asserts the masking
    // on the cooldown-free path by seeding the student directly.
    const user = await h.users.create({
      name: "Resend Target",
      email: "resend.target@test.local",
      mobile: "9876500123",
      role: "student",
      status: "pending",
    });
    await h.students.createForUser(user.id, {
      collegeName: "JNTU",
      degreeBranch: "B.Tech CSE",
      passingYear: "2025",
      courseInterestedIn: "Full Stack Development",
      dateOfBirth: "2003-04-12",
      gender: "male",
      fullAddress: "12-3-45 Ameerpet, Hyderabad 500016",
    });

    const res = await server.post("/api/v1/auth/otp/email/resend", {
      ticket: issueVerificationTicket(user.id).ticket,
    });

    assert.equal(res.status, 200);

    const data = (await json(res))["data"] as Record<string, unknown>;
    assert.equal(data["sentTo"], "r***t@test.local");
    assert.ok(!JSON.stringify(data).includes("resend.target@test.local"));
    assert.ok(typeof data["expiresAt"] === "string");
    assert.ok(typeof data["resendAvailableAt"] === "string");
  });

  it("does not mount the descoped mobile or dual-OTP routes", async () => {
    for (const path of [
      "/api/v1/auth/otp/mobile/verify",
      "/api/v1/auth/otp/mobile/resend",
      "/api/v1/auth/otp/verify-dual",
    ]) {
      const res = await server.post(path, { ticket: "irrelevant", otp: "123456" });
      assert.equal(res.status, 404, `${path} must not exist`);
    }
  });
});

describe("the dev auth router without verification", () => {
  it("mounts no OTP routes and sends no code", async () => {
    // Proves the optional dependency really is optional - this is the shape
    // the pre-existing registration tests use.
    const h = createTestHarness();
    const extraV1Routes = Router();

    extraV1Routes.use(
      "/auth",
      createDevAuthRoutes({
        deps: {
          get users() {
            return h.container.repositories.users;
          },
          get credentials() {
            return h.container.repositories.credentials;
          },
          get students() {
            return h.container.repositories.students;
          },
        },
        rateLimiter: permissive(),
      }),
    );

    const server = await startServer(
      createApp({ container: h.container, extraV1Routes }),
    );

    try {
      const registered = await server.post("/api/v1/auth/register", validInput());
      assert.equal(registered.status, 201);

      const otpRoute = await server.post("/api/v1/auth/otp/email/verify", {
        ticket: "irrelevant",
        otp: "123456",
      });
      assert.equal(otpRoute.status, 404, "the OTP route must not be mounted");

      assert.equal(h.container.repositories.otpChallenges, h.otpChallenges);
      assert.equal(h.otpChallenges.all().length, 0, "no challenge may be created");
    } finally {
      await server.close();
    }
  });
});
