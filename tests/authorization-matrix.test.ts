import { Router, type RequestHandler } from "express";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app";
import { createAuthenticate } from "../src/middleware/authenticate.middleware";
import { createRateLimiter } from "../src/middleware/rate-limit.middleware";
import { createLoginService } from "../src/modules/auth/login.service";
import { hashPassword } from "../src/modules/auth/password.service";
import type { UserRole } from "../src/contracts/user.contract";
import { createDevAuthRoutes } from "../dev/auth.dev.routes";
import { createTestHarness, type TestHarness } from "./fakes";
import { json, startServer, type TestServer } from "./helpers/server";

const PASSWORD = "Str0ng!Pass1";

const permissive = (): RequestHandler =>
  createRateLimiter({ windowMs: 60_000, limit: 1000, message: "test limiter" });

const PROFILE = {
  collegeName: "JNTU Hyderabad",
  degreeBranch: "B.Tech CSE",
  passingYear: "2025",
  courseInterestedIn: "Full Stack Development",
  dateOfBirth: "2003-04-12",
  gender: "male" as const,
  fullAddress: "12-3-45 Ameerpet, Hyderabad, Telangana 500016",
};

/**
 * End-to-end authorization matrix: every role, every guarded endpoint.
 *
 * ===========================================================================
 * WHY THIS EXISTS ALONGSIDE `authorize.test.ts`.
 *
 * That file tests the GUARDS in isolation, mounted on throwaway routes with
 * an injected identity. It is thorough and it already proves the important
 * rule that an `admin` is refused by `requireSuperAdmin`.
 *
 * What it cannot prove is that the REAL ENDPOINTS are wired to the right
 * guard. A route registered without `requireAdmin`, or with the wrong tier,
 * would pass every test in that file and be wide open in production.
 *
 * So this file goes through the whole chain exactly as a browser does:
 * sign in over HTTP, take the issued JWT, call a real endpoint, and check
 * the status. If somebody later mounts an admin route with the wrong guard,
 * a test here fails.
 * ===========================================================================
 */
describe("authorization matrix (real tokens, real endpoints)", () => {
  let h: TestHarness;
  let server: TestServer;
  const tokens: Partial<Record<UserRole, string>> = {};
  let candidateId = "";

  /** Every admin-guarded endpoint in the production registry. */
  const ADMIN_ENDPOINTS: { method: "GET" | "POST" | "PATCH" | "PUT"; path: string; body?: unknown }[] =
    [
      { method: "GET", path: "/api/v1/students" },
      { method: "GET", path: "/api/v1/students/user-1" },
      { method: "PATCH", path: "/api/v1/students/user-1/status", body: { status: "active" } },
      { method: "POST", path: "/api/v1/students/user-1/approve", body: {} },
      {
        method: "POST",
        path: "/api/v1/students/user-1/reject",
        body: { remarks: "Documents incomplete." },
      },
      { method: "GET", path: "/api/v1/courses/manage" },
      { method: "POST", path: "/api/v1/courses", body: {} },
      { method: "PATCH", path: "/api/v1/courses/course-1/status", body: { status: "archived" } },
    ];

  const call = (
    endpoint: { method: string; path: string; body?: unknown },
    token?: string,
  ): Promise<Response> =>
    fetch(`${server.url}${endpoint.path}`, {
      method: endpoint.method,
      headers: {
        "Content-Type": "application/json",
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      },
      ...(endpoint.body === undefined ? {} : { body: JSON.stringify(endpoint.body) }),
    });

  const seedAndSignIn = async (
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

    await h.credentials.create({
      userId: user.id,
      passwordHash: await hashPassword(PASSWORD),
    });

    if (role === "student") {
      // A student signs in once their email is verified (CL-001); approved
      // here so the matrix exercises full student access.
      await h.students.createForUser(user.id, PROFILE);
      await h.students.markVerified(user.id, "email");
      await h.students.recordApprovalDecision(user.id, {
        status: "approved",
        decidedByUserId: "admin-1",
        decidedAt: new Date().toISOString(),
      });
    }

    const res = await server.post("/api/v1/auth/login", {
      identifier: email,
      password: PASSWORD,
    });

    assert.equal(res.status, 200, `${role} must be able to sign in`);

    return ((await json(res))["data"] as Record<string, unknown>)["token"] as string;
  };

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
          get students() {
            return h.container.repositories.students;
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
          studentAccess: null,
          sessions: () => h.container.repositories.sessions,
        }),
      }),
    );

    tokens.student = await seedAndSignIn("student", "matrix.student@test.local", "9100000001");
    tokens.teacher = await seedAndSignIn("teacher", "matrix.teacher@test.local", "9100000002");
    tokens.admin = await seedAndSignIn("admin", "matrix.admin@test.local", "9100000003");
    tokens.super_admin = await seedAndSignIn(
      "super_admin",
      "matrix.super@test.local",
      "9100000004",
    );

    // A pending candidate so the admin paths act on something real.
    const candidate = await h.users.create({
      name: "Matrix Candidate",
      email: "matrix.candidate@test.local",
      mobile: "9100000010",
      role: "student",
      status: "pending",
    });
    await h.students.createForUser(candidate.id, PROFILE);
    // Approval requires verified email and mobile (BR-001).
    await h.students.markVerified(candidate.id, "email");
    await h.students.markVerified(candidate.id, "mobile");
    candidateId = candidate.id;
  });

  after(async () => {
    await server.close();
  });

  describe("unauthenticated callers", () => {
    it("every admin endpoint answers 401, never 403 or 200", async () => {
      for (const endpoint of ADMIN_ENDPOINTS) {
        const res = await call(endpoint);

        assert.equal(
          res.status,
          401,
          `${endpoint.method} ${endpoint.path} must be 401 without a token`,
        );
        assert.equal((await json(res))["error"], "UNAUTHENTICATED");
      }
    });

    it("a forged bearer token is refused everywhere", async () => {
      for (const endpoint of ADMIN_ENDPOINTS) {
        const res = await call(endpoint, "not.a.real.token");

        assert.equal(res.status, 401, `${endpoint.method} ${endpoint.path}`);
      }
    });
  });

  describe("a STUDENT token", () => {
    it("is refused by every admin endpoint with 403 INSUFFICIENT_ROLE", async () => {
      for (const endpoint of ADMIN_ENDPOINTS) {
        const res = await call(endpoint, tokens.student);

        assert.equal(
          res.status,
          403,
          `${endpoint.method} ${endpoint.path} must refuse a student`,
        );
        assert.equal((await json(res))["error"], "INSUFFICIENT_ROLE");
      }
    });
  });

  describe("a TEACHER token", () => {
    it("is refused by every admin endpoint - teachers are not administrators", async () => {
      for (const endpoint of ADMIN_ENDPOINTS) {
        const res = await call(endpoint, tokens.teacher);

        assert.equal(
          res.status,
          403,
          `${endpoint.method} ${endpoint.path} must refuse a teacher`,
        );
        assert.equal((await json(res))["error"], "INSUFFICIENT_ROLE");
      }
    });

    it("cannot approve a student registration", async () => {
      const res = await call(
        { method: "POST", path: `/api/v1/students/${candidateId}/approve`, body: {} },
        tokens.teacher,
      );

      assert.equal(res.status, 403);

      const student = await h.students.findById(candidateId);
      assert.equal(
        student?.adminApprovalStatus,
        "pending",
        "the decision must not have been recorded",
      );
    });

    it("cannot activate an account", async () => {
      const res = await call(
        {
          method: "PATCH",
          path: `/api/v1/students/${candidateId}/status`,
          body: { status: "active" },
        },
        tokens.teacher,
      );

      assert.equal(res.status, 403);

      const user = await h.users.findById(candidateId);
      assert.equal(user?.status, "pending", "the account must not have been activated");
    });
  });

  describe("an ADMIN token", () => {
    it("passes authorization on every admin endpoint", async () => {
      // Authorization is what is under test, not the request bodies - so a
      // 422 counts as a pass here. What must never appear is 401 or 403.
      for (const endpoint of ADMIN_ENDPOINTS) {
        const res = await call(endpoint, tokens.admin);

        assert.notEqual(res.status, 401, `${endpoint.method} ${endpoint.path} returned 401`);
        assert.notEqual(res.status, 403, `${endpoint.method} ${endpoint.path} returned 403`);
      }
    });

    it("can approve a pending registration", async () => {
      const res = await call(
        { method: "POST", path: `/api/v1/students/${candidateId}/approve`, body: {} },
        tokens.admin,
      );

      assert.equal(res.status, 200);
      assert.equal(
        ((await json(res))["data"] as Record<string, unknown>)["adminApprovalStatus"],
        "approved",
      );
    });
  });

  describe("a SUPER ADMIN token", () => {
    it("passes authorization on every admin endpoint (inheritance)", async () => {
      for (const endpoint of ADMIN_ENDPOINTS) {
        const res = await call(endpoint, tokens.super_admin);

        assert.notEqual(res.status, 401, `${endpoint.method} ${endpoint.path} returned 401`);
        assert.notEqual(res.status, 403, `${endpoint.method} ${endpoint.path} returned 403`);
      }
    });
  });

  describe("the role cannot be influenced by the client", () => {
    it("a teacher cannot escalate with a role header", async () => {
      const res = await fetch(`${server.url}/api/v1/students`, {
        headers: {
          Authorization: `Bearer ${tokens.teacher as string}`,
          "X-User-Role": "admin",
          "X-Role": "super_admin",
        },
      });

      assert.equal(res.status, 403, "headers must not influence the role");
    });

    it("a teacher cannot escalate with a query parameter", async () => {
      const res = await fetch(`${server.url}/api/v1/students?role=admin`, {
        headers: { Authorization: `Bearer ${tokens.teacher as string}` },
      });

      assert.equal(res.status, 403);
    });

    it("a teacher cannot escalate with a body field", async () => {
      const res = await call(
        {
          method: "POST",
          path: `/api/v1/students/${candidateId}/reject`,
          body: { remarks: "Trying to escalate.", role: "admin", principal: { role: "admin" } },
        },
        tokens.teacher,
      );

      assert.equal(res.status, 403);
    });
  });

  describe("session revocation is immediate", () => {
    it("an admin token stops working once its session is revoked", async () => {
      // Proves `authenticate` really does validate the session per request,
      // which is what makes logout and suspension meaningful.
      const email = "matrix.revoke@test.local";
      const token = await seedAndSignIn("admin", email, "9100000020");

      const before = await call({ method: "GET", path: "/api/v1/students" }, token);
      assert.notEqual(before.status, 401);

      const user = await h.users.findByEmail(email);
      assert.ok(user);
      await h.sessions.revokeAllForUser({ userId: user.id, reason: "logout_all" });

      const after = await call({ method: "GET", path: "/api/v1/students" }, token);
      assert.equal(after.status, 401, "a revoked session must refuse a valid token");
    });
  });
});
