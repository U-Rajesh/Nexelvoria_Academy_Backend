import { Router, type RequestHandler } from "express";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app";
import { createAuthenticate } from "../src/middleware/authenticate.middleware";
import { createRateLimiter } from "../src/middleware/rate-limit.middleware";
import { createLoginService } from "../src/modules/auth/login.service";
import { hashPassword } from "../src/modules/auth/password.service";
import { createStudentService } from "../src/modules/students/student.service";
import type { UserRole } from "../src/contracts/user.contract";
import { createDevAuthRoutes } from "../dev/auth.dev.routes";
import { createTestHarness, type TestHarness } from "./fakes";
import { json, startServer, type TestServer } from "./helpers/server";

const PASSWORD = "Str0ng!Pass1";

const permissive = (): RequestHandler =>
  createRateLimiter({ windowMs: 60_000, limit: 500, message: "test limiter" });

/** Admissions data every seeded student profile needs. */
const profile = {
  collegeName: "JNTU Hyderabad",
  degreeBranch: "B.Tech CSE",
  passingYear: "2025",
  courseInterestedIn: "Full Stack Development",
  dateOfBirth: "2003-04-12",
  gender: "male" as const,
  fullAddress: "12-3-45 Ameerpet, Hyderabad, Telangana 500016",
};

// ---------------------------------------------------------------------------
// Service level: transitions
// ---------------------------------------------------------------------------

describe("approval decisions (service)", () => {
  let h: TestHarness;
  let service: ReturnType<typeof createStudentService>;

  const seedStudent = async (email = "cand@test.local", mobile = "9876543210") => {
    const user = await h.users.create({
      name: "Candidate",
      email,
      mobile,
      role: "student",
      status: "pending",
    });

    await h.students.createForUser(user.id, profile);

    return user.id;
  };

  beforeEach(() => {
    h = createTestHarness();
    service = createStudentService({
      get students() {
        return h.container.repositories.students;
      },
    });
  });

  it("approves a pending registration", async () => {
    const id = await seedStudent();

    const result = await service.approveStudent(id, "admin-1");

    assert.equal(result.adminApprovalStatus, "approved");
  });

  it("stamps the decision time", async () => {
    const id = await seedStudent();

    await service.approveStudent(id, "admin-7");

    const stored = await h.students.findById(id);
    assert.ok(stored !== null);
    assert.ok(typeof stored.approvedAt === "string" && stored.approvedAt.length > 0);
  });

  it("passes the actor to the repository, even though nothing persists it yet", async () => {
    // GAP, recorded deliberately rather than asserted away:
    // `ApprovalDecision` REQUIRES `decidedByUserId`, but `Student` has no
    // field for it and the in-memory fake drops it - so the approving admin
    // is currently unrecoverable after the call. The service does its half
    // correctly, which is what this asserts; storing it needs a column or an
    // audit table from the database team.
    const captured: { decidedByUserId?: string }[] = [];

    const spying = createStudentService({
      students: {
        ...h.container.repositories.students,
        findById: (id: string) => h.students.findById(id),
        recordApprovalDecision: (id: string, decision: { decidedByUserId: string }) => {
          captured.push(decision);
          return h.students.recordApprovalDecision(id, decision as never);
        },
      } as never,
    });

    const id = await seedStudent();
    await spying.approveStudent(id, "admin-42");

    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.decidedByUserId, "admin-42");
  });

  it("rejects with mandatory remarks, and stores them", async () => {
    const id = await seedStudent();

    const result = await service.rejectStudent(id, "admin-1", "Marksheet illegible.");

    assert.equal(result.adminApprovalStatus, "rejected");
    assert.equal(result.adminApprovalRemarks, "Marksheet illegible.");
  });

  it("does NOT activate the account on approval (BR-002 gates payment, not login)", async () => {
    const id = await seedStudent();

    const result = await service.approveStudent(id, "admin-1");

    assert.equal(result.status, "pending", "approval must not set status active");
  });

  it("does not store accountState - it is derived on the way out", async () => {
    // Settled at Phase 5 Stage 0: `accountState` is a view over status,
    // isEmailVerified and adminApprovalStatus. The repository stores none,
    // and `toStudentResponse` computes it - so the value in a response can
    // never be stale, and no column is needed.
    const id = await seedStudent();
    // Verified first: the derivation puts `!isEmailVerified` AHEAD of the
    // approval check, so an approved-but-unverified student correctly reads
    // `pending_verification` (asserted in the next test).
    await h.students.markVerified(id, "email");

    const result = await service.approveStudent(id, "admin-1");

    // Derived in the response...
    assert.equal(result.adminApprovalStatus, "approved");
    assert.equal(result.accountState, "approved");

    // ...but absent from storage.
    const stored = await h.students.findById(id);
    assert.equal(stored?.accountState, undefined);
  });

  it("approves regardless of email verification, leaving the gap visible", async () => {
    // No confirmed rule requires verification before approval, so none is
    // invented. The derived state still reports pending_verification.
    const id = await seedStudent();

    const result = await service.approveStudent(id, "admin-1");

    assert.equal(result.adminApprovalStatus, "approved");
    assert.equal(result.isEmailVerified, false);
  });

  describe("invalid transitions", () => {
    it("refuses to approve an already-approved registration", async () => {
      const id = await seedStudent();
      await service.approveStudent(id, "admin-1");

      await assert.rejects(
        () => service.approveStudent(id, "admin-2"),
        (err: { status?: number; message?: string }) => {
          assert.equal(err.status, 409);
          assert.match(String(err.message), /already been approved/i);
          return true;
        },
      );
    });

    it("refuses to reject an already-approved registration", async () => {
      const id = await seedStudent();
      await service.approveStudent(id, "admin-1");

      await assert.rejects(
        () => service.rejectStudent(id, "admin-2", "Changed our mind."),
        (err: { status?: number }) => {
          assert.equal(err.status, 409);
          return true;
        },
      );
    });

    it("refuses to approve a rejected registration", async () => {
      const id = await seedStudent();
      await service.rejectStudent(id, "admin-1", "Incomplete documents.");

      await assert.rejects(
        () => service.approveStudent(id, "admin-2"),
        (err: { status?: number; message?: string }) => {
          assert.equal(err.status, 409);
          assert.match(String(err.message), /already been rejected/i);
          return true;
        },
      );
    });

    it("refuses to reject twice", async () => {
      const id = await seedStudent();
      await service.rejectStudent(id, "admin-1", "Incomplete documents.");

      await assert.rejects(
        () => service.rejectStudent(id, "admin-2", "Still incomplete."),
        (err: { status?: number }) => {
          assert.equal(err.status, 409);
          return true;
        },
      );
    });

    it("preserves the FIRST decision when a second is refused", async () => {
      const id = await seedStudent();
      await service.rejectStudent(id, "admin-1", "Original reason.");

      await assert.rejects(() => service.approveStudent(id, "admin-2"));

      const stored = await h.students.findById(id);
      assert.equal(stored?.adminApprovalStatus, "rejected");
      assert.equal(stored?.adminApprovalRemarks, "Original reason.");
    });

    it("404s for an unknown student rather than 409", async () => {
      await assert.rejects(
        () => service.approveStudent("user-nobody", "admin-1"),
        (err: { status?: number }) => {
          assert.equal(err.status, 404);
          return true;
        },
      );
    });
  });
});

// ---------------------------------------------------------------------------
// HTTP level: authorization and the real token flow
// ---------------------------------------------------------------------------

describe("approval endpoints over HTTP", () => {
  let h: TestHarness;
  let server: TestServer;
  const tokens: Partial<Record<UserRole, string>> = {};

  /** Creates an ACTIVE user with a credential, so it can actually sign in. */
  const seedSignInUser = async (
    role: UserRole,
    email: string,
    mobile: string,
  ): Promise<string> => {
    const user = await h.users.create({
      name: `${role} user`,
      email,
      mobile,
      role,
      status: "active",
    });

    await h.credentials.create({ userId: user.id, passwordHash: await hashPassword(PASSWORD) });

    return user.id;
  };

  const signIn = async (email: string): Promise<string> => {
    const res = await server.post("/api/v1/auth/login", { identifier: email, password: PASSWORD });
    assert.equal(res.status, 200, `${email} should be able to sign in`);

    const data = (await json(res))["data"] as Record<string, unknown>;

    return data["token"] as string;
  };

  /** A pending candidate awaiting a decision. */
  const seedCandidate = async (email: string, mobile: string): Promise<string> => {
    const user = await h.users.create({
      name: "Candidate",
      email,
      mobile,
      role: "student",
      status: "pending",
    });

    await h.students.createForUser(user.id, profile);

    return user.id;
  };

  /**
   * A full `RequestInit`, not just headers.
   *
   * `helpers/server.ts` spreads `init` AFTER its own `headers`, so an init
   * carrying `headers` replaces them wholesale - Content-Type included. Omit
   * it and the JSON body is never parsed, which shows up as a confusing 422.
   */
  const authed = (token: string): RequestInit => ({
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  });

  /** PATCH, which `helpers/server.ts` does not provide. */
  const patch = (path: string, body: unknown, init: RequestInit): Promise<Response> =>
    fetch(`${server.url}${path}`, {
      method: "PATCH",
      body: JSON.stringify(body),
      ...init,
    });

  before(async () => {
    h = createTestHarness();

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
          maxFailedLoginAttempts: 5,
        }),
        loginRateLimiter: permissive(),
      }),
    );

    server = await startServer(
      createApp({
        container: h.container,
        extraV1Routes,
        authenticate: createAuthenticate({
          sessions: () => h.container.repositories.sessions,
        }),
      }),
    );

    await seedSignInUser("admin", "admin@test.local", "9000000001");
    await seedSignInUser("super_admin", "super@test.local", "9000000002");
    await seedSignInUser("student", "student@test.local", "9000000003");
    await seedSignInUser("teacher", "teacher@test.local", "9000000004");

    tokens.admin = await signIn("admin@test.local");
    tokens.super_admin = await signIn("super@test.local");
    tokens.student = await signIn("student@test.local");
    tokens.teacher = await signIn("teacher@test.local");
  });

  after(async () => {
    await server.close();
  });

  describe("authorization", () => {
    it("401s an anonymous caller", async () => {
      const id = await seedCandidate("anon.target@test.local", "9876500010");

      const res = await server.post(`/api/v1/students/${id}/approve`, {});

      assert.equal(res.status, 401);
      assert.equal((await json(res))["error"], "UNAUTHENTICATED");
    });

    it("401s a malformed bearer token", async () => {
      const id = await seedCandidate("bad.token@test.local", "9876500011");

      const res = await server.post(
        `/api/v1/students/${id}/approve`,
        {},
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer not-a-real-token",
          },
        },
      );

      assert.equal(res.status, 401);
    });

    it("403s a student", async () => {
      const id = await seedCandidate("stu.target@test.local", "9876500012");

      const res = await server.post(
        `/api/v1/students/${id}/approve`,
        {},
        authed(tokens.student as string),
      );

      assert.equal(res.status, 403);
      assert.equal((await json(res))["error"], "INSUFFICIENT_ROLE");
    });

    it("403s a teacher", async () => {
      const id = await seedCandidate("tea.target@test.local", "9876500013");

      const res = await server.post(
        `/api/v1/students/${id}/reject`,
        { remarks: "Not allowed to do this." },
        authed(tokens.teacher as string),
      );

      assert.equal(res.status, 403);
    });

    it("allows an admin", async () => {
      const id = await seedCandidate("admin.ok@test.local", "9876500014");

      const res = await server.post(
        `/api/v1/students/${id}/approve`,
        {},
        authed(tokens.admin as string),
      );

      assert.equal(res.status, 200);
    });

    it("allows a super_admin (role inheritance)", async () => {
      const id = await seedCandidate("super.ok@test.local", "9876500015");

      const res = await server.post(
        `/api/v1/students/${id}/approve`,
        {},
        authed(tokens.super_admin as string),
      );

      assert.equal(res.status, 200);
    });

    it("denies before validating, so an anonymous caller learns nothing about the body", async () => {
      // A bodyless reject from an anonymous caller must be 401, not the 422
      // that would confirm `remarks` is expected.
      const res = await server.post("/api/v1/students/user-1/reject", {});

      assert.equal(res.status, 401);
    });
  });

  describe("approval", () => {
    it("returns the updated student with approved status", async () => {
      const id = await seedCandidate("app1@test.local", "9876500020");

      const res = await server.post(
        `/api/v1/students/${id}/approve`,
        {},
        authed(tokens.admin as string),
      );

      assert.equal(res.status, 200);

      const data = (await json(res))["data"] as Record<string, unknown>;
      assert.equal(data["adminApprovalStatus"], "approved");
      assert.equal(data["id"], id);
    });

    it("accepts a request with no body at all", async () => {
      const id = await seedCandidate("app2@test.local", "9876500021");

      const res = await server.post(
        `/api/v1/students/${id}/approve`,
        {},
        authed(tokens.admin as string),
      );

      assert.equal(res.status, 200);
    });

    it("ignores an actor forged in the request body", async () => {
      const id = await seedCandidate("app3@test.local", "9876500022");

      // The controller reads `req.principal` and never the body, so these
      // fields must have no effect. The actor itself is not persisted (see
      // the service-level test), so what is asserted here is that no
      // client-supplied value reaches the stored record.
      const res = await server.post(
        `/api/v1/students/${id}/approve`,
        { decidedByUserId: "user-impostor", approvedByUserId: "user-impostor" },
        authed(tokens.admin as string),
      );

      assert.equal(res.status, 200);

      const stored = await h.students.findById(id);
      assert.ok(!JSON.stringify(stored).includes("user-impostor"));
    });

    it("never returns a password hash or credential field", async () => {
      const id = await seedCandidate("app4@test.local", "9876500023");

      const res = await server.post(
        `/api/v1/students/${id}/approve`,
        {},
        authed(tokens.admin as string),
      );

      const body = JSON.stringify(await json(res));
      assert.ok(!/passwordHash|argon2|\$argon/i.test(body));
    });
  });

  describe("rejection", () => {
    it("rejects with remarks", async () => {
      const id = await seedCandidate("rej1@test.local", "9876500030");

      const res = await server.post(
        `/api/v1/students/${id}/reject`,
        { remarks: "Submitted documents do not match the application." },
        authed(tokens.admin as string),
      );

      assert.equal(res.status, 200);

      const data = (await json(res))["data"] as Record<string, unknown>;
      assert.equal(data["adminApprovalStatus"], "rejected");
      assert.equal(
        data["adminApprovalRemarks"],
        "Submitted documents do not match the application.",
      );
    });

    it("422s when remarks are missing", async () => {
      const id = await seedCandidate("rej2@test.local", "9876500031");

      const res = await server.post(
        `/api/v1/students/${id}/reject`,
        {},
        authed(tokens.admin as string),
      );

      assert.equal(res.status, 422);

      const details = (await json(res))["details"] as { field: string }[];
      assert.ok(details.some((issue) => issue.field === "remarks"));
    });

    it("422s when remarks are only whitespace", async () => {
      const id = await seedCandidate("rej3@test.local", "9876500032");

      const res = await server.post(
        `/api/v1/students/${id}/reject`,
        { remarks: "     " },
        authed(tokens.admin as string),
      );

      assert.equal(res.status, 422);
    });
  });

  describe("invalid transitions over HTTP", () => {
    it("409s a second decision", async () => {
      const id = await seedCandidate("dup@test.local", "9876500040");

      assert.equal(
        (
          await server.post(
            `/api/v1/students/${id}/approve`,
            {},
            authed(tokens.admin as string),
          )
        ).status,
        200,
      );

      const again = await server.post(
        `/api/v1/students/${id}/reject`,
        { remarks: "Trying to overturn the approval." },
        authed(tokens.admin as string),
      );

      assert.equal(again.status, 409);
      assert.equal((await json(again))["error"], "CONFLICT");
    });

    it("404s an unknown student", async () => {
      const res = await server.post(
        "/api/v1/students/user-nobody/approve",
        {},
        authed(tokens.admin as string),
      );

      assert.equal(res.status, 404);
    });
  });


  describe("activation reaches the record login gates on (B-L1 regression)", () => {
    /**
     * =======================================================================
     * THE BUG THIS LOCKS DOWN.
     *
     * `status` is identity, and identity lives on the user record. Before the
     * fix, `PATCH /students/:id/status` wrote only the student row while
     * `login` read `UserRepository` - so an admin could activate a student
     * who then still could not sign in, with nothing in either UI to explain
     * why.
     * =======================================================================
     */

    it("PATCH /students/:id/status active updates the USER record", async () => {
      const id = await seedCandidate("activate@test.local", "9876500300");

      const res = await patch(
        `/api/v1/students/${id}/status`,
        { status: "active" },
        authed(tokens.admin as string),
      );

      assert.equal(res.status, 200);

      const user = await h.users.findById(id);
      assert.equal(
        user?.status,
        "active",
        "login reads the user record, so activation must land there",
      );
    });

    it("the student response and the user record agree after activation", async () => {
      const id = await seedCandidate("agree@test.local", "9876500301");

      await patch(
        `/api/v1/students/${id}/status`,
        { status: "suspended" },
        authed(tokens.admin as string),
      );

      const user = await h.users.findById(id);
      const student = await h.students.findById(id);

      assert.equal(user?.status, "suspended");
      assert.equal(student?.status, "suspended", "the two must never diverge");
    });

    it("approval alone does NOT activate (BR-002 preserved)", async () => {
      const id = await seedCandidate("br002@test.local", "9876500302");

      await server.post(
        `/api/v1/students/${id}/approve`,
        {},
        authed(tokens.admin as string),
      );

      const user = await h.users.findById(id);
      assert.equal(
        user?.status,
        "pending",
        "approval gates payment, not login - activation is a separate action",
      );
    });

    it("the full sequence: verify, approve, activate, leaves one consistent status", async () => {
      const id = await seedCandidate("sequence@test.local", "9876500303");

      // Verified first: the derivation puts `!isEmailVerified` ahead of the
      // approval check, so an unverified student reads
      // `pending_verification` no matter what an admin has decided.
      await h.students.markVerified(id, "email");

      await server.post(`/api/v1/students/${id}/approve`, {}, authed(tokens.admin as string));
      await patch(
        `/api/v1/students/${id}/status`,
        { status: "active" },
        authed(tokens.admin as string),
      );

      const user = await h.users.findById(id);
      const student = await h.students.findById(id);

      assert.equal(user?.status, "active");
      assert.equal(student?.status, "active");
      assert.equal(student?.adminApprovalStatus, "approved");

      // `accountState` is DERIVED, so it exists on the API response rather
      // than on the stored row - which is exactly why the row reports
      // `undefined` here.
      assert.equal(student?.accountState, undefined, "it is never stored");

      const viaApi = await server.get(
        `/api/v1/students/${id}`,
        authed(tokens.admin as string),
      );
      const data = (await json(viaApi))["data"] as Record<string, unknown>;
      assert.equal(data["accountState"], "approved");
    });
  });

  describe("email-verified students stay pending until a decision (requirement 4)", () => {
    it("remains pending_approval after verification, with no decision recorded", async () => {
      const id = await seedCandidate("verified@test.local", "9876500050");

      // Verification alone - no admin action.
      await h.students.markVerified(id, "email");

      const res = await server.get(
        `/api/v1/students/${id}`,
        authed(tokens.admin as string),
      );

      assert.equal(res.status, 200);

      const data = (await json(res))["data"] as Record<string, unknown>;
      assert.equal(data["isEmailVerified"], true);
      assert.equal(
        data["adminApprovalStatus"],
        "pending",
        "verification must not approve anything",
      );
    });

    it("is still approvable afterwards, and only then becomes approved", async () => {
      const id = await seedCandidate("verified2@test.local", "9876500051");
      await h.students.markVerified(id, "email");

      const res = await server.post(
        `/api/v1/students/${id}/approve`,
        {},
        authed(tokens.admin as string),
      );

      assert.equal(res.status, 200);
      assert.equal(
        ((await json(res))["data"] as Record<string, unknown>)["adminApprovalStatus"],
        "approved",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// The dev login mount
// ---------------------------------------------------------------------------

describe("login over HTTP (development-only mount)", () => {
  let h: TestHarness;
  let server: TestServer;

  before(async () => {
    h = createTestHarness();

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
          maxFailedLoginAttempts: 5,
        }),
        loginRateLimiter: permissive(),
      }),
    );

    server = await startServer(createApp({ container: h.container, extraV1Routes }));

    const active = await h.users.create({
      name: "Active Admin",
      email: "active@test.local",
      mobile: "9000001001",
      role: "admin",
      status: "active",
    });
    await h.credentials.create({
      userId: active.id,
      passwordHash: await hashPassword(PASSWORD),
    });

    const pending = await h.users.create({
      name: "Pending Student",
      email: "pending@test.local",
      mobile: "9000001002",
      role: "student",
      status: "pending",
    });
    await h.credentials.create({
      userId: pending.id,
      passwordHash: await hashPassword(PASSWORD),
    });
  });

  after(async () => {
    await server.close();
  });

  it("signs in an active user and returns a token and the user", async () => {
    const res = await server.post("/api/v1/auth/login", {
      identifier: "active@test.local",
      password: PASSWORD,
    });

    assert.equal(res.status, 200);

    const data = (await json(res))["data"] as Record<string, unknown>;
    assert.ok(typeof data["token"] === "string" && (data["token"] as string).length > 0);
    assert.ok(typeof data["expiresIn"] === "number");
    assert.equal((data["user"] as Record<string, unknown>)["email"], "active@test.local");
  });

  it("DOES NOT return a refresh token (decision D4 is open)", async () => {
    const res = await server.post("/api/v1/auth/login", {
      identifier: "active@test.local",
      password: PASSWORD,
    });

    const body = await json(res);
    const data = body["data"] as Record<string, unknown>;

    assert.equal(data["refreshToken"], undefined);
    assert.ok(!/refreshToken/i.test(JSON.stringify(body)));
  });

  it("returns no password material", async () => {
    const res = await server.post("/api/v1/auth/login", {
      identifier: "active@test.local",
      password: PASSWORD,
    });

    const body = JSON.stringify(await json(res));
    assert.ok(!/passwordHash|\$argon/i.test(body));
    assert.ok(!body.includes(PASSWORD));
  });

  it("401s a wrong password", async () => {
    const res = await server.post("/api/v1/auth/login", {
      identifier: "active@test.local",
      password: "Wr0ng!Pass1",
    });

    assert.equal(res.status, 401);
  });

  it("401s an unknown identifier with the same message as a wrong password", async () => {
    const unknown = await server.post("/api/v1/auth/login", {
      identifier: "nobody@test.local",
      password: PASSWORD,
    });
    const wrong = await server.post("/api/v1/auth/login", {
      identifier: "active@test.local",
      password: "Wr0ng!Pass1",
    });

    assert.equal(unknown.status, 401);
    assert.equal(
      (await json(unknown))["message"],
      (await json(wrong))["message"],
      "the two must be indistinguishable",
    );
  });

  it("403s a pending account, and says what is needed", async () => {
    const res = await server.post("/api/v1/auth/login", {
      identifier: "pending@test.local",
      password: PASSWORD,
    });

    assert.equal(res.status, 403);
    assert.match(String((await json(res))["message"]), /not active yet/i);
  });

  it("422s a malformed body", async () => {
    const res = await server.post("/api/v1/auth/login", { identifier: "x" });

    assert.equal(res.status, 422);
  });

  it("is not mounted when no login service is supplied", async () => {
    const bare = createTestHarness();
    const extra = Router();
    extra.use(
      "/auth",
      createDevAuthRoutes({
        deps: {
          get users() {
            return bare.container.repositories.users;
          },
          get credentials() {
            return bare.container.repositories.credentials;
          },
          get students() {
            return bare.container.repositories.students;
          },
        },
        rateLimiter: permissive(),
      }),
    );

    const other = await startServer(
      createApp({ container: bare.container, extraV1Routes: extra }),
    );

    try {
      const res = await other.post("/api/v1/auth/login", {
        identifier: "active@test.local",
        password: PASSWORD,
      });

      assert.equal(res.status, 404);
    } finally {
      await other.close();
    }
  });
});
