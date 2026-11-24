import { Router, type RequestHandler } from "express";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app";
import { createRateLimiter } from "../src/middleware/rate-limit.middleware";
import { createLoginService } from "../src/modules/auth/login.service";
import { createOtpService } from "../src/modules/auth/otp.service";
import type {
  OtpDeliveryPort,
  OtpDeliveryRequest,
  OtpDeliveryResult,
} from "../src/modules/auth/otp.delivery";
import { hashPassword } from "../src/modules/auth/password.service";
import {
  VERIFICATION_TICKET_AUDIENCE,
  VERIFICATION_TICKET_PURPOSE,
  issueVerificationTicket,
  verifyAccessToken,
  verifyVerificationTicket,
} from "../src/modules/auth/token.service";
import { createVerificationService } from "../src/modules/auth/verification.service";
import { createDevAuthRoutes } from "../dev/auth.dev.routes";
import { createTestHarness, type TestHarness } from "./fakes";
import { json, startServer, type TestServer } from "./helpers/server";

const PASSWORD = "Str0ng!Pass1";

const permissive = (): RequestHandler =>
  createRateLimiter({ windowMs: 60_000, limit: 500, message: "test limiter" });

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

const PROFILE = {
  collegeName: "JNTU Hyderabad",
  degreeBranch: "B.Tech CSE",
  passingYear: "2025",
  courseInterestedIn: "Full Stack Development",
  dateOfBirth: "2003-04-12",
  gender: "male" as const,
  fullAddress: "12-3-45 Ameerpet, Hyderabad, Telangana 500016",
};

// ---------------------------------------------------------------------------
// Ticket primitives: the security boundary
// ---------------------------------------------------------------------------

describe("verification tickets cannot authenticate", () => {
  it("a ticket is REJECTED by verifyAccessToken", () => {
    // The whole point of the separation. A ticket is signed with a different
    // key under a different audience and carries no sid or role, so the
    // access-token verifier must refuse it.
    const { ticket } = issueVerificationTicket("user-1");

    const verified = verifyAccessToken(ticket);

    assert.equal(verified.valid, false);
  });

  it("an access-token audience is not the ticket audience", () => {
    assert.notEqual(VERIFICATION_TICKET_AUDIENCE, "");
    assert.match(VERIFICATION_TICKET_AUDIENCE, /email-verification$/);
  });

  it("a ticket round-trips through its own verifier", () => {
    const { ticket } = issueVerificationTicket("user-42");

    const verified = verifyVerificationTicket(ticket);

    assert.equal(verified.valid, true);
    assert.ok(verified.valid);
    assert.equal(verified.userId, "user-42");
  });

  it("rejects junk, empty and non-string tickets without throwing", () => {
    for (const bad of ["", "   ", "not.a.jwt", "a.b.c", null, undefined, 42, {}]) {
      const verified = verifyVerificationTicket(bad);
      assert.equal(verified.valid, false, `${String(bad)} must be rejected`);
    }
  });

  it("reports the expiry reason distinctly, and nothing else", () => {
    // Only `expired` is worth telling a user apart; the rest would only help
    // someone forging one.
    const verified = verifyVerificationTicket("not.a.jwt");

    assert.ok(!verified.valid);
    assert.notEqual(verified.reason, "expired");
  });

  it("refuses to issue a ticket without a user id", () => {
    for (const bad of ["", "   "]) {
      assert.throws(() => issueVerificationTicket(bad), /without a user id/);
    }
  });

  it("carries the purpose claim", () => {
    const { ticket } = issueVerificationTicket("user-1");
    const payload = JSON.parse(
      Buffer.from(ticket.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;

    assert.equal(payload["purpose"], VERIFICATION_TICKET_PURPOSE);
    assert.equal(payload["aud"], VERIFICATION_TICKET_AUDIENCE);
    // Neither claim an access token requires.
    assert.equal(payload["sid"], undefined);
    assert.equal(payload["role"], undefined);
  });

  it("expires in 15 minutes", () => {
    const { ticket, expiresIn } = issueVerificationTicket("user-1");

    assert.equal(expiresIn, 15 * 60);

    const payload = JSON.parse(
      Buffer.from(ticket.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as { iat: number; exp: number };

    assert.equal(payload.exp - payload.iat, 15 * 60);
  });
});

// ---------------------------------------------------------------------------
// POST /auth/login
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/login (development-only)", () => {
  let h: TestHarness;
  let delivery: RecordingDelivery;
  let server: TestServer;

  const buildApp = () => {
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

  /** A student with a credential, at a chosen lifecycle point. */
  const seedStudent = async (options: {
    email: string;
    mobile: string;
    status?: "pending" | "active" | "suspended" | "deactivated";
    verified?: boolean;
    approved?: boolean;
    withProfile?: boolean;
  }): Promise<string> => {
    const user = await h.users.create({
      name: "Candidate",
      email: options.email,
      mobile: options.mobile,
      role: "student",
      status: options.status ?? "pending",
    });

    await h.credentials.create({
      userId: user.id,
      passwordHash: await hashPassword(PASSWORD),
    });

    if (options.withProfile !== false) {
      await h.students.createForUser(user.id, PROFILE);

      // An "active" student in the old model was verified and approved; under
      // CL-001 that is what lets a student sign in, so it is the default here.
      const usable = options.status === "active";

      if (options.verified ?? usable) {
        await h.students.markVerified(user.id, "email");
      }

      if (options.approved ?? usable) {
        await h.students.recordApprovalDecision(user.id, {
          status: "approved",
          decidedByUserId: "admin-1",
          decidedAt: new Date().toISOString(),
        });
      }
    }

    return user.id;
  };

  const login = (identifier: string, password = PASSWORD) =>
    server.post("/api/v1/auth/login", { identifier, password });

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
  });

  describe("credentials are never distinguishable", () => {
    it("an unknown identifier and a wrong password give the SAME 401 body", async () => {
      await seedStudent({ email: "known@test.local", mobile: "9000000001", status: "active" });

      const unknown = await login("nobody@test.local");
      const wrong = await login("known@test.local", "Wr0ng!Pass1");

      assert.equal(unknown.status, 401);
      assert.equal(wrong.status, 401);

      const a = await json(unknown);
      const b = await json(wrong);

      assert.equal(a["message"], b["message"]);
      assert.equal(a["error"], b["error"]);
    });

    it("neither 401 carries a ticket", async () => {
      await seedStudent({ email: "known2@test.local", mobile: "9000000002", status: "active" });

      for (const res of [await login("nobody2@test.local"), await login("known2@test.local", "Nope!1234")]) {
        assert.equal((await json(res))["verificationTicket"], undefined);
      }
    });
  });

  describe("account state is reported only after a correct password", () => {
    it("403 ACCOUNT_PENDING_VERIFICATION, with a ticket", async () => {
      await seedStudent({ email: "unver@test.local", mobile: "9000000010" });

      const res = await login("unver@test.local");

      assert.equal(res.status, 403);

      const body = await json(res);
      assert.equal(body["error"], "ACCOUNT_PENDING_VERIFICATION");
      assert.ok(
        typeof body["verificationTicket"] === "string" &&
          (body["verificationTicket"] as string).length > 0,
        "a pending-verification refusal must carry a ticket",
      );
    });

    it("200 for a verified student awaiting approval - limited access (CL-001 decision 1)", async () => {
      await seedStudent({
        email: "await@test.local",
        mobile: "9000000011",
        verified: true,
      });

      const res = await login("await@test.local");

      assert.equal(res.status, 200);
      const body = await json(res);
      assert.equal(body["verificationTicket"], undefined, "nothing to verify, so no ticket");
    });

    it("403 ACCOUNT_PENDING for a rejected registration", async () => {
      const id = await seedStudent({ email: "rejected@test.local", mobile: "9000000017", verified: true });
      await h.students.recordApprovalDecision(id, {
        status: "rejected",
        decidedByUserId: "admin-1",
        decidedAt: new Date().toISOString(),
      });

      const res = await login("rejected@test.local");

      assert.equal(res.status, 403);
      assert.equal((await json(res))["error"], "ACCOUNT_PENDING");
    });

    it("403 ACCOUNT_SUSPENDED for an approved student who is suspended", async () => {
      await seedStudent({
        email: "approvedsusp@test.local",
        mobile: "9000000018",
        status: "suspended",
        verified: true,
        approved: true,
      });

      const res = await login("approvedsusp@test.local");

      assert.equal(res.status, 403);
      assert.equal((await json(res))["error"], "ACCOUNT_SUSPENDED");
    });

    it("403 ACCOUNT_SUSPENDED", async () => {
      await seedStudent({
        email: "susp@test.local",
        mobile: "9000000012",
        status: "suspended",
      });

      const res = await login("susp@test.local");

      assert.equal(res.status, 403);
      assert.equal((await json(res))["error"], "ACCOUNT_SUSPENDED");
    });

    it("403 ACCOUNT_DEACTIVATED", async () => {
      await seedStudent({
        email: "deact@test.local",
        mobile: "9000000013",
        status: "deactivated",
      });

      const res = await login("deact@test.local");

      assert.equal(res.status, 403);
      assert.equal((await json(res))["error"], "ACCOUNT_DEACTIVATED");
    });

    it("403 ACCOUNT_LOCKED after the attempt ceiling", async () => {
      await seedStudent({ email: "lock@test.local", mobile: "9000000014", status: "active" });

      for (let i = 0; i < 5; i += 1) {
        await login("lock@test.local", "Wr0ng!Pass1");
      }

      const res = await login("lock@test.local");

      assert.equal(res.status, 403);
      assert.equal((await json(res))["error"], "ACCOUNT_LOCKED");
    });

    it("200 for an APPROVED student with no separate activation (CL-001 decision 2)", async () => {
      await seedStudent({
        email: "approvednotactive@test.local",
        mobile: "9000000016",
        verified: true,
        approved: true,
      });

      const res = await login("approvednotactive@test.local");

      assert.equal(res.status, 200);
    });

    it("403 ACCOUNT_PENDING (generic) when the reason cannot be established", async () => {
      // A user with NO student profile: the service cannot tell verification
      // from approval, so it must refuse generically rather than guess.
      await seedStudent({
        email: "noprofile@test.local",
        mobile: "9000000015",
        withProfile: false,
      });

      const res = await login("noprofile@test.local");

      assert.equal(res.status, 403);

      const body = await json(res);
      assert.equal(body["error"], "ACCOUNT_PENDING");
      assert.equal(body["verificationTicket"], undefined);
    });
  });

  describe("a successful sign-in", () => {
    it("returns a token, expiresIn and the user", async () => {
      await seedStudent({
        email: "ok@test.local",
        mobile: "9000000020",
        status: "active",
        verified: true,
        approved: true,
      });

      const res = await login("ok@test.local");

      assert.equal(res.status, 200);

      const data = (await json(res))["data"] as Record<string, unknown>;
      assert.ok(typeof data["token"] === "string" && (data["token"] as string).length > 0);
      assert.equal(typeof data["expiresIn"], "number");
      assert.equal((data["user"] as Record<string, unknown>)["email"], "ok@test.local");
    });

    it("the token IS a usable access token", async () => {
      await seedStudent({
        email: "ok2@test.local",
        mobile: "9000000021",
        status: "active",
      });

      const data = (await json(await login("ok2@test.local")))["data"] as Record<
        string,
        unknown
      >;

      const verified = verifyAccessToken(data["token"]);
      assert.equal(verified.valid, true);
    });

    it("returns NO refresh token (decision D4 is open)", async () => {
      await seedStudent({ email: "ok3@test.local", mobile: "9000000022", status: "active" });

      const body = await json(await login("ok3@test.local"));

      assert.ok(!/refreshToken/i.test(JSON.stringify(body)));
    });

    it("returns no password material and no ticket", async () => {
      await seedStudent({ email: "ok4@test.local", mobile: "9000000023", status: "active" });

      const body = await json(await login("ok4@test.local"));
      const serialised = JSON.stringify(body);

      assert.ok(!/passwordHash|\$argon/i.test(serialised));
      assert.ok(!serialised.includes(PASSWORD));
      assert.equal((body as Record<string, unknown>)["verificationTicket"], undefined);
    });

    it("accepts a mobile number as the identifier", async () => {
      await seedStudent({ email: "bymobile@test.local", mobile: "9000000024", status: "active" });

      const res = await login("9000000024");

      assert.equal(res.status, 200);
    });
  });

  describe("validation and shape", () => {
    it("422 for a malformed body", async () => {
      assert.equal((await server.post("/api/v1/auth/login", { identifier: "x" })).status, 422);
      assert.equal((await server.post("/api/v1/auth/login", {})).status, 422);
    });
  });

  describe("the ticket from a pending login drives verification", () => {
    it("completes the whole resume flow with no student id anywhere", async () => {
      await seedStudent({ email: "resume@test.local", mobile: "9000000030" });

      // 1. Sign in -> refused, but handed a ticket.
      const refused = await login("resume@test.local");
      const ticket = (await json(refused))["verificationTicket"] as string;

      // 2. Resend using the ticket alone.
      const resent = await server.post("/api/v1/auth/otp/email/resend", { ticket });
      assert.equal(resent.status, 200);

      // 3. Verify using the ticket and the delivered code.
      const verified = await server.post("/api/v1/auth/otp/email/verify", {
        ticket,
        otp: delivery.lastCode,
      });

      assert.equal(verified.status, 200);

      const data = (await json(verified))["data"] as Record<string, unknown>;
      assert.equal(data["isEmailVerified"], true);
      assert.equal(data["accountState"], "pending_approval");

      // 4. Signing in again now succeeds with LIMITED access while approval
      //    is pending (CL-001 decision 1).
      const again = await login("resume@test.local");
      assert.equal(again.status, 200);
    });

    it("a ticket for one student cannot verify another", async () => {
      const victim = await seedStudent({ email: "victim@test.local", mobile: "9000000031" });
      await seedStudent({ email: "attacker@test.local", mobile: "9000000032" });

      const attackerTicket = (await json(await login("attacker@test.local")))[
        "verificationTicket"
      ] as string;

      // The attacker's own ticket resolves to the attacker, so the victim's
      // delivered code must not verify under it.
      await server.post("/api/v1/auth/otp/email/resend", {
        ticket: issueVerificationTicket(victim).ticket,
      });
      const victimCode = delivery.lastCode;

      const res = await server.post("/api/v1/auth/otp/email/verify", {
        ticket: attackerTicket,
        otp: victimCode,
      });

      assert.notEqual(res.status, 200);

      const victimStudent = await h.students.findById(victim);
      assert.equal(victimStudent?.isEmailVerified, false);
    });

    it("an access token is not accepted as a ticket", async () => {
      await seedStudent({ email: "crossuse@test.local", mobile: "9000000033", status: "active" });

      const token = ((await json(await login("crossuse@test.local")))["data"] as Record<
        string,
        unknown
      >)["token"] as string;

      const res = await server.post("/api/v1/auth/otp/email/resend", { ticket: token });

      assert.equal(res.status, 401, "an access token must not work as a ticket");
    });
  });
});
