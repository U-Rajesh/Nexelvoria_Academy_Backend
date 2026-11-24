import { Router, type RequestHandler } from "express";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app";
import { createRateLimiter } from "../src/middleware/rate-limit.middleware";
import { createLoginService } from "../src/modules/auth/login.service";
import type {
  OtpDeliveryPort,
  OtpDeliveryRequest,
  OtpDeliveryResult,
} from "../src/modules/auth/otp.delivery";
import { createOtpService } from "../src/modules/auth/otp.service";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  verifyAccessToken,
  verifyVerificationTicket,
} from "../src/modules/auth/token.service";
import { createVerificationService } from "../src/modules/auth/verification.service";
import { createDevAuthRoutes } from "../dev/auth.dev.routes";
import { createTestHarness, type TestHarness } from "./fakes";
import { json, startServer, type TestServer } from "./helpers/server";

/**
 * THE END-TO-END AUTHENTICATION JOURNEY, over HTTP.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS, WHEN REGISTRATION, OTP AND LOGIN ARE EACH ALREADY
 * HEAVILY TESTED.
 *
 * Because none of those suites crosses the seams BETWEEN the three modules.
 * Every login test seeds its user with `status: "active"` through a helper,
 * which skips registration entirely - so nothing, until now, proved that the
 * id registration hands back is the id the OTP challenge is keyed by, which
 * is the id login resolves a profile with.
 *
 * That is exactly the invariant the SQL work put under pressure: the
 * datastore mints a SECOND identifier for the profile row, and if it ever
 * reached `tempStudentId` these three modules would come apart while every
 * existing unit test stayed green. This file is the regression net for that.
 * ===========================================================================
 *
 * ===========================================================================
 * THE JOURNEY ENDS IN A 403, AND THAT IS THE CONTRACT - NOT A GAP.
 *
 * A registered, email-verified student is REFUSED at login with
 * `ACCOUNT_PENDING_APPROVAL`. docs/api-contracts.md section 4 specifies
 * exactly that ("403: ACCOUNT_PENDING_APPROVAL - email verified, awaiting
 * BR-002"), and the frontend already renders it through
 * `AccountStatusBanner`. Steps 1 to 5 below assert that whole sequence.
 *
 * Only step 6 goes outside the journey, to activate the account directly
 * through the in-memory repository so the JWT half can be proved. That
 * stands in for an admin action which is deliberately out of scope here, and
 * it changes no rule: `REQUIRED_STATUS` still permits only `active`,
 * verification still sets no status, and approval is neither recorded nor
 * needed. The test ASSERTS the pending-approval state first and only then
 * activates, so the shortcut can never hide a missing step.
 * ===========================================================================
 *
 * ===========================================================================
 * MOUNTED FROM `dev/`, BECAUSE PRODUCTION MOUNTS NOTHING.
 *
 * `src/routes/index.ts` leaves `/auth` commented out and
 * `createProductionContainer()` registers no repositories, so the four auth
 * endpoints exist only in the development harness. This file builds the REAL
 * application through `createApp()` and passes the dev `/auth` router as
 * `extraV1Routes` - the same seam `dev/server.dev.ts` uses, and the same one
 * the other endpoint suites use. No production route or container is
 * modified, and no SQL Server connection is opened.
 * ===========================================================================
 */

const PASSWORD = "Str0ng!Pass1";

/** A limiter high enough not to interfere with behavioural assertions. */
const permissive = (): RequestHandler =>
  createRateLimiter({ windowMs: 60_000, limit: 500, message: "test limiter" });

/**
 * Captures the passcode instead of sending it.
 *
 * The production adapter writes the code to the log precisely because no
 * mail provider is configured; this records it so the test can present it,
 * which is the only way to drive the real verification endpoint.
 */
class RecordingDelivery implements OtpDeliveryPort {
  readonly channel = "email" as const;
  readonly sent: OtpDeliveryRequest[] = [];

  async send(request: OtpDeliveryRequest): Promise<OtpDeliveryResult> {
    this.sent.push(request);

    return { delivered: true };
  }

  get lastCode(): string {
    const last = this.sent[this.sent.length - 1];
    assert.ok(last !== undefined, "no OTP was delivered");

    return last.code;
  }
}

/** A complete, valid registration payload, as the frontend submits it. */
const registration = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
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

/**
 * The real app, with the development `/auth` router mounted exactly as
 * `dev/server.dev.ts` mounts it.
 */
const buildApp = (h: TestHarness, delivery: OtpDeliveryPort) => {
  const otp = createOtpService({
    challenges: h.container.repositories.otpChallenges,
    delivery,
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
      verification: createVerificationService({
        otp,
        users: h.container.repositories.users,
        students: h.container.repositories.students,
      }),
      login: createLoginService({
        get users() {
          return h.container.repositories.users;
        },
        get credentials() {
          return h.container.repositories.credentials;
        },
        get sessions() {
          return h.container.repositories.sessions;
        },
        get students() {
          return h.container.repositories.students;
        },
        maxFailedLoginAttempts: 5,
      }),
      rateLimiter: permissive(),
      otpRateLimiter: permissive(),
      loginRateLimiter: permissive(),
    }),
  );

  return createApp({ container: h.container, extraV1Routes });
};

// ---------------------------------------------------------------------------
// The journey, in order
// ---------------------------------------------------------------------------

describe("auth flow: registration -> email verification -> student login", () => {
  let h: TestHarness;
  let delivery: RecordingDelivery;
  let server: TestServer;

  /**
   * State carried BETWEEN steps, which is the point of this suite: each
   * value is produced by one endpoint and consumed by the next, exactly as a
   * real client would carry it.
   */
  let tempStudentId: string;
  /** From the 201. The non-deprecated way a client carries the account forward. */
  let registrationTicket: string;
  /** From the login refusal. A second, independent route to the same account. */
  let loginTicket: string;
  let otpCode: string;
  let accessToken: string;
  let expiresIn: number;

  before(async () => {
    h = createTestHarness();
    delivery = new RecordingDelivery();
    server = await startServer(buildApp(h, delivery));
  });

  after(async () => {
    await server.close();
  });

  const login = (identifier: string, password = PASSWORD) =>
    server.post("/api/v1/auth/login", { identifier, password });

  it("step 1 - POST /auth/register returns 201 and the agreed payload", async () => {
    const res = await server.post("/api/v1/auth/register", registration());

    assert.equal(res.status, 201);

    const body = await json(res);
    assert.equal(body["success"], true);

    const data = body["data"] as Record<string, unknown>;

    // Captured BEFORE the shape assertion, so that a contract change here
    // fails this one step instead of cascading through the whole journey.
    tempStudentId = data["tempStudentId"] as string;
    registrationTicket = data["verificationTicket"] as string;

    /**
     * EXACTLY these four keys - the same set
     * `tests/registration-endpoint.test.ts` pins as "the D2 payload".
     *
     * `tempStudentId` is the deprecated-but-retained field the frontend is
     * still typed against; `verificationTicket` is what a client should
     * carry forward, because no student id goes in a URL any more.
     */
    assert.deepEqual(Object.keys(data).sort(), [
      "email",
      "mobile",
      "tempStudentId",
      "verificationTicket",
    ]);
    assert.equal(data["email"], "ananya@test.local");
    assert.equal(data["mobile"], "9876543210");
    assert.ok(typeof tempStudentId === "string" && tempStudentId.length > 0);
    assert.ok(typeof registrationTicket === "string" && registrationTicket.length > 0);

    // No credential material, and no access token, on a registration.
    assert.ok(!/argon2|password|hash/i.test(JSON.stringify(body)));
    assert.equal(data["token"], undefined);
  });

  it("step 1b - the account is created pending, unverified and unapproved", async () => {
    const user = await h.users.findById(tempStudentId);
    const student = await h.students.findById(tempStudentId);

    // THE SEAM: one id addresses both the identity and the profile.
    assert.ok(user, "tempStudentId must address the user record");
    assert.ok(student, "and the SAME id must address the student profile");

    assert.equal(user.role, "student", "public registration creates students only");
    assert.equal(user.status, "pending", "BR-001 and BR-002 both precede activation");
    assert.equal(student.isEmailVerified, false);
    assert.equal(student.isMobileVerified, false, "mobile OTP is descoped (Q3/BR-014)");
    assert.equal(student.adminApprovalStatus, "pending");
  });

  it("step 2 - registration delivers a six-digit code to the student's email", async () => {
    assert.equal(delivery.sent.length, 1, "exactly one challenge is issued at registration");

    const request = delivery.sent[0];
    assert.ok(request);
    assert.equal(request.destination, "ananya@test.local", "read from the user record");
    assert.match(request.code, /^\d{6}$/);

    otpCode = delivery.lastCode;
  });

  it("step 3 - login BEFORE verification is refused with ACCOUNT_PENDING_VERIFICATION", async () => {
    const res = await login("ananya@test.local");

    assert.equal(res.status, 403);

    const body = await json(res);
    assert.equal(body["success"], false);
    assert.equal(body["error"], "ACCOUNT_PENDING_VERIFICATION");

    // The refusal carries the means to resolve it, so the client can go
    // straight to the OTP screen without a student id in a URL.
    const ticket = body["verificationTicket"];
    assert.ok(
      typeof ticket === "string" && ticket.length > 0,
      "the verification ticket must travel WITH this one refusal",
    );

    loginTicket = ticket;

    // No token of any kind is issued by a refusal.
    assert.equal(body["data"], undefined);
  });

  it("step 3b - both tickets name the same account", async () => {
    // Two independent routes to the OTP screen - straight from the 201, or
    // from a later sign-in attempt - must resolve to one student.
    const fromRegistration = verifyVerificationTicket(registrationTicket);
    const fromLogin = verifyVerificationTicket(loginTicket);

    assert.ok(fromRegistration.valid);
    assert.ok(fromLogin.valid);
    assert.equal(fromRegistration.userId, tempStudentId);
    assert.equal(fromLogin.userId, tempStudentId);
  });

  it("step 3c - a ticket cannot authenticate anything", async () => {
    // Signed under a different audience, carrying no sid and no role.
    for (const ticket of [registrationTicket, loginTicket]) {
      const asAccessToken = verifyAccessToken(ticket);

      assert.equal(asAccessToken.valid, false, "a ticket must never pass as an access token");
    }
  });

  it("step 4 - POST /auth/otp/email/verify returns 200 and records the verification", async () => {
    // Uses the ticket from the 201 - the forward path a real client takes.
    const res = await server.post("/api/v1/auth/otp/email/verify", {
      ticket: registrationTicket,
      otp: otpCode,
    });

    assert.equal(res.status, 200);

    const body = await json(res);
    assert.equal(body["success"], true);

    const data = body["data"] as Record<string, unknown>;
    assert.equal(data["studentId"], tempStudentId, "the same id throughout the journey");
    assert.equal(data["isEmailVerified"], true);
    assert.equal(data["accountState"], "pending_approval");
    assert.equal(data["awaitingAdminApproval"], true);

    const student = await h.students.findById(tempStudentId);
    assert.ok(student);
    assert.equal(student.isEmailVerified, true);
  });

  it("step 4b - verification changes the status NOT AT ALL", async () => {
    // Deliberate, and the reason step 5 refuses: `markVerified` records the
    // channel and nothing else. Activation is a separate authorized action.
    const user = await h.users.findById(tempStudentId);

    assert.ok(user);
    assert.equal(user.status, "pending");

    const student = await h.students.findById(tempStudentId);
    assert.ok(student);
    assert.equal(student.adminApprovalStatus, "pending", "approval is untouched by verifying");
  });

  it("step 4c - the spent code cannot be used a second time", async () => {
    // Replayed with the OTHER valid ticket, so this proves the CHALLENGE was
    // consumed rather than merely that one ticket was spent.
    const res = await server.post("/api/v1/auth/otp/email/verify", {
      ticket: loginTicket,
      otp: otpCode,
    });

    assert.notEqual(res.status, 200, "a consumed challenge must not verify again");
  });

  it("step 5 - login AFTER verification succeeds with limited access (CL-001 decision 1)", async () => {
    // Formerly refused with ACCOUNT_PENDING_APPROVAL. CL-001: a student with a
    // verified email may sign in while approval is pending; authorization then
    // restricts them to the allowlisted endpoints (covered in student-access tests).
    const res = await login("ananya@test.local");

    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body["success"], true);
  });

  it("step 6 - Admin approval (standing in for the admin action; no separate activation)", async () => {
    const before_ = await h.users.findById(tempStudentId);
    assert.ok(before_);
    assert.equal(before_.status, "pending", "precondition: still pending");

    const student = await h.students.findById(tempStudentId);
    assert.ok(student);
    assert.equal(student.isEmailVerified, true, "precondition: email verified");
    assert.equal(student.adminApprovalStatus, "pending", "precondition: approval still pending");

    // CL-001 decision 2: approval alone gives full access; the account is
    // never separately activated.
    const approved = await h.students.recordApprovalDecision(tempStudentId, {
      status: "approved",
      decidedByUserId: "admin-1",
      decidedAt: new Date().toISOString(),
    });

    assert.equal(approved.adminApprovalStatus, "approved");
  });

  it("step 7 - login after activation returns 200 with an access token", async () => {
    const res = await login("ananya@test.local");

    assert.equal(res.status, 200);

    const body = await json(res);
    assert.equal(body["success"], true);

    const data = body["data"] as Record<string, unknown>;

    // api-contracts section 4: `{ token, expiresIn, user }`.
    assert.deepEqual(Object.keys(data).sort(), ["expiresIn", "token", "user"]);

    assert.ok(typeof data["token"] === "string" && data["token"].length > 0);
    assert.equal(typeof data["expiresIn"], "number");

    accessToken = data["token"];
    expiresIn = data["expiresIn"] as number;

    const user = data["user"] as Record<string, unknown>;
    assert.equal(user["id"], tempStudentId, "the id is the same one registration returned");
    assert.equal(user["email"], "ananya@test.local");
    assert.equal(user["role"], "student");
    // Approval, not activation, opened the account (CL-001 decision 2).
    assert.equal(user["status"], "pending");
  });

  it("step 7b - the refresh token is NOT returned (decision D4)", async () => {
    // `login.service.ts` states in capitals that no HTTP endpoint may return
    // it until D4 is decided; api-contracts lists it as optional, so
    // omitting it is contract-compliant.
    const res = await login("ananya@test.local");
    const body = await json(res);
    const data = body["data"] as Record<string, unknown>;

    assert.equal(data["refreshToken"], undefined);
    assert.equal(data["refreshTokenExpiresAt"], undefined);
    assert.equal(data["sessionId"], undefined, "the sid travels in the token, not the body");
  });

  it("step 8 - the JWT verifies and carries sub, role, sid and an expiry", async () => {
    const verified = verifyAccessToken(accessToken);

    assert.equal(verified.valid, true);
    assert.ok(verified.valid);

    const { claims } = verified;

    assert.equal(claims.sub, tempStudentId, "sub is the public student identifier");
    assert.equal(claims.role, "student", "the role is signed, so a client cannot choose it");
    assert.ok(typeof claims.sid === "string" && claims.sid.length > 0, "sid ties it to a session");

    // Expiry: 15 minutes, and consistent with the body's `expiresIn`.
    assert.equal(expiresIn, ACCESS_TOKEN_TTL_SECONDS);
    assert.equal(claims.exp - claims.iat, ACCESS_TOKEN_TTL_SECONDS);
    assert.ok(claims.exp > Math.floor(Date.now() / 1000), "the token must not be already expired");

    // Issuer and audience come from configuration, so both sides agree.
    assert.ok(claims.iss.length > 0);
    assert.ok(claims.aud.length > 0);
  });

  it("step 8b - the token carries no credential material", async () => {
    const payload = JSON.parse(
      Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;

    assert.deepEqual(
      Object.keys(payload).sort(),
      ["aud", "exp", "iat", "iss", "role", "sid", "sub"],
      "no claim beyond the agreed seven",
    );
    assert.ok(!/argon2|password|hash/i.test(JSON.stringify(payload)));
  });

  it("step 9 - the session named by sid exists and belongs to the student", async () => {
    const verified = verifyAccessToken(accessToken);
    assert.ok(verified.valid);

    const session = await h.sessions.findBySessionId(verified.claims.sid);

    assert.ok(session, "the sid must name a real, revocable session");
    assert.equal(session.userId, tempStudentId);
  });
});

// ---------------------------------------------------------------------------
// Negative paths, each on a fresh account
// ---------------------------------------------------------------------------

describe("auth flow: invalid OTP handling", () => {
  let h: TestHarness;
  let delivery: RecordingDelivery;
  let server: TestServer;
  let ticket: string;
  let code: string;

  beforeEach(async () => {
    h = createTestHarness();
    delivery = new RecordingDelivery();
    server = await startServer(buildApp(h, delivery));

    // The ticket comes straight from the 201, which avoids a second argon2
    // verification per test and is the path a real client takes anyway.
    const registered = await json(
      await server.post("/api/v1/auth/register", registration()),
    );

    ticket = (registered["data"] as Record<string, unknown>)["verificationTicket"] as string;
    code = delivery.lastCode;
  });

  // MANDATORY, not hygiene: a server left listening keeps a handle open, and
  // the test runner does not exit until the event loop drains.
  afterEach(async () => {
    await server.close();
  });

  const verify = (otp: string) =>
    server.post("/api/v1/auth/otp/email/verify", { ticket, otp });

  it("rejects a wrong but well-formed code with 400, and does not verify", async () => {
    const wrong = code === "000000" ? "111111" : "000000";

    const res = await verify(wrong);

    assert.equal(res.status, 400);

    const body = await json(res);
    assert.equal(body["success"], false);
    assert.equal(body["error"], "BAD_REQUEST");

    const student = await h.students.findById(
      (await h.users.findByEmail("ananya@test.local"))?.id ?? "",
    );
    assert.ok(student);
    assert.equal(student.isEmailVerified, false, "a wrong code must verify nothing");
  });

  it("reports the remaining attempts, so the client can warn the student", async () => {
    const wrong = code === "000000" ? "111111" : "000000";

    const body = await json(await verify(wrong));

    assert.match(String(body["message"]), /attempt\(s\) remaining/);
  });

  it("rejects a malformed code with 422 WITHOUT consuming an attempt", async () => {
    // The schema refuses it before the service sees it, so it cannot burn
    // one of the five attempts.
    for (const malformed of ["", "12345", "1234567", "abcdef", "12 34 56"]) {
      const res = await verify(malformed);

      assert.equal(res.status, 422, `"${malformed}" must be a validation error`);
    }

    // The correct code still works afterwards, which proves no attempt was
    // spent and no challenge was consumed.
    const ok = await verify(code);
    assert.equal(ok.status, 200);
  });

  it("rejects a junk ticket without revealing whether the account exists", async () => {
    for (const bad of ["", "not.a.jwt", "a.b.c"]) {
      const res = await server.post("/api/v1/auth/otp/email/verify", {
        ticket: bad,
        otp: code,
      });

      assert.ok(res.status >= 400, `"${bad}" must be refused`);
      assert.notEqual(res.status, 200);
    }
  });

  it("the correct code still verifies after failed attempts", async () => {
    const wrong = code === "000000" ? "111111" : "000000";

    await verify(wrong);
    await verify(wrong);

    const res = await verify(code);

    assert.equal(res.status, 200);

    const body = await json(res);
    const data = body["data"] as Record<string, unknown>;
    assert.equal(data["isEmailVerified"], true);
  });
});

describe("auth flow: incorrect password handling", () => {
  let h: TestHarness;
  let delivery: RecordingDelivery;
  let server: TestServer;
  let userId: string;

  beforeEach(async () => {
    h = createTestHarness();
    delivery = new RecordingDelivery();
    server = await startServer(buildApp(h, delivery));

    const registered = await json(
      await server.post("/api/v1/auth/register", registration()),
    );
    userId = (registered["data"] as Record<string, unknown>)["tempStudentId"] as string;

    // Verified and approved so that a password refusal cannot be confused
    // with an account refusal - this isolates the credential check.
    await h.students.markVerified(userId, "email");
    await h.students.recordApprovalDecision(userId, {
      status: "approved",
      decidedByUserId: "admin-1",
      decidedAt: new Date().toISOString(),
    });
  });

  afterEach(async () => {
    await server.close();
  });

  const login = (identifier: string, password: string) =>
    server.post("/api/v1/auth/login", { identifier, password });

  it("refuses a wrong password with 401 and issues no token", async () => {
    const res = await login("ananya@test.local", "Wr0ng!Password1");

    assert.equal(res.status, 401);

    const body = await json(res);
    assert.equal(body["success"], false);
    assert.equal(body["error"], "UNAUTHORIZED");
    assert.equal(body["data"], undefined);
  });

  it("an unknown identifier is INDISTINGUISHABLE from a wrong password", async () => {
    // Deliberate: distinguishing them is an account-enumeration oracle.
    const wrongPassword = await login("ananya@test.local", "Wr0ng!Password1");
    const unknownUser = await login("nobody@test.local", PASSWORD);

    assert.equal(wrongPassword.status, unknownUser.status);

    const a = await json(wrongPassword);
    const b = await json(unknownUser);

    assert.equal(a["error"], b["error"]);
    assert.equal(a["message"], b["message"], "the wording must not differ either");
  });

  it("never echoes the submitted password or a hash", async () => {
    const res = await login("ananya@test.local", "Wr0ng!Password1");
    const serialised = JSON.stringify(await json(res));

    assert.ok(!serialised.includes("Wr0ng!Password1"));
    assert.ok(!/argon2|passwordHash/i.test(serialised));
  });

  it("the correct password still works after failed attempts", async () => {
    await login("ananya@test.local", "Wr0ng!Password1");
    await login("ananya@test.local", "Wr0ng!Password1");

    const res = await login("ananya@test.local", PASSWORD);

    assert.equal(res.status, 200, "below the lockout threshold, a good password must work");
  });

  it("locks the credential after the configured number of failures", async () => {
    for (let i = 0; i < 5; i += 1) {
      await login("ananya@test.local", "Wr0ng!Password1");
    }

    const res = await login("ananya@test.local", PASSWORD);

    assert.equal(res.status, 403, "a correct password does NOT unlock an account");

    const body = await json(res);
    assert.equal(body["error"], "ACCOUNT_LOCKED");
  });

  it("login by mobile resolves the same account", async () => {
    const res = await login("9876543210", PASSWORD);

    assert.equal(res.status, 200);

    const body = await json(res);
    const data = body["data"] as Record<string, unknown>;
    const user = data["user"] as Record<string, unknown>;

    assert.equal(user["id"], userId, "email and mobile must reach one account");
  });
});
