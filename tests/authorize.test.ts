import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Application, type RequestHandler } from "express";

import type { UserRole } from "../src/contracts/user.contract";
import { errorHandler } from "../src/middleware/error.middleware";
import {
  requireAdmin,
  requireAuth,
  requireAuthenticated,
  requireRoles,
  requireStudent,
  requireSuperAdmin,
  requireTeacher,
} from "../src/middleware/authorize.middleware";
import { requestContext } from "../src/middleware/request-context.middleware";
import { sendSuccess } from "../src/utils/send";
import { startServer, json } from "./helpers/server";

/**
 * Authorization guards.
 *
 * The guarded routes live HERE, in the test file - never in src. The real
 * application exposes no test or bypass endpoints, in production or
 * anywhere else.
 *
 * `asRole` stands in for `authenticate`, which in production derives the
 * identity from a verified access token (see tests/authenticate.test.ts for
 * that path end to end). It is test scaffolding only: it never ships, and
 * it is the single place a role is injected, which is exactly why the
 * production guards can safely refuse to read a role from anywhere but
 * `req.principal`.
 */
const asRole = (role: UserRole): RequestHandler => (req, _res, next) => {
  req.principal = { id: `user-${role}`, role, sessionId: `session-${role}` };
  next();
};

/** Builds an app whose one route is protected by `guard`. */
const appWith = (guard: RequestHandler, identity?: RequestHandler): Application => {
  const app = express();
  app.use(requestContext);

  if (identity) {
    app.use(identity);
  }

  app.get("/protected", guard, (_req, res) => sendSuccess(res, { message: "allowed" }));
  app.use(errorHandler);

  return app;
};

const callProtected = async (
  guard: RequestHandler,
  identity?: RequestHandler,
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const server = await startServer(appWith(guard, identity));

  try {
    const res = await server.get("/protected");
    return { status: res.status, body: await json(res) };
  } finally {
    await server.close();
  }
};

describe("authorization guards", () => {
  describe("missing authentication context (fail closed)", () => {
    it("requireAuth denies with 401 when no principal is present", async () => {
      const { status, body } = await callProtected(requireAuth);

      assert.equal(status, 401);
      assert.equal(body["success"], false);
      assert.equal(body["error"], "UNAUTHENTICATED");
    });

    it("every role guard denies with 401 when unauthenticated", async () => {
      const guards: [string, RequestHandler][] = [
        ["requireAuthenticated", requireAuthenticated],
        ["requireStudent", requireStudent],
        ["requireTeacher", requireTeacher],
        ["requireAdmin", requireAdmin],
        ["requireSuperAdmin", requireSuperAdmin],
      ];

      for (const [name, guard] of guards) {
        const { status, body } = await callProtected(guard);

        assert.equal(status, 401, `${name} must return 401 without identity`);
        assert.equal(body["error"], "UNAUTHENTICATED", `${name} code`);
      }
    });

    it("401 is used for missing auth and 403 for wrong role (never swapped)", async () => {
      // The frontend interceptor treats 401 as a session problem, so a role
      // mismatch must NOT be a 401 or the user gets logged out.
      const unauth = await callProtected(requireAdmin);
      const wrongRole = await callProtected(requireAdmin, asRole("student"));

      assert.equal(unauth.status, 401);
      assert.equal(wrongRole.status, 403);
    });
  });

  describe("role-based access denial", () => {
    it("denies a student reaching an admin route with 403", async () => {
      const { status, body } = await callProtected(requireAdmin, asRole("student"));

      assert.equal(status, 403);
      assert.equal(body["error"], "INSUFFICIENT_ROLE");
      assert.equal(body["success"], false);
    });

    it("denies a teacher reaching an admin route", async () => {
      const { status } = await callProtected(requireAdmin, asRole("teacher"));
      assert.equal(status, 403);
    });

    it("denies a student reaching a teacher route", async () => {
      const { status } = await callProtected(requireTeacher, asRole("student"));
      assert.equal(status, 403);
    });

    it("denies an admin reaching a student-only route", async () => {
      // Being more privileged is not the same as being a student.
      const { status } = await callProtected(requireStudent, asRole("admin"));
      assert.equal(status, 403);
    });

    it("denies the public role everywhere", async () => {
      const { status } = await callProtected(requireAuthenticated, asRole("public"));
      assert.equal(status, 403);
    });
  });

  describe("role inheritance (matches frontend route guards)", () => {
    it("allows admin on an admin route", async () => {
      const { status, body } = await callProtected(requireAdmin, asRole("admin"));

      assert.equal(status, 200);
      assert.equal(body["success"], true);
    });

    it("allows super_admin on an admin route — inheritance", async () => {
      // /admin/* is guarded by ['admin','super_admin'] in AppRoutes.tsx
      const { status, body } = await callProtected(requireAdmin, asRole("super_admin"));

      assert.equal(status, 200);
      assert.equal(body["success"], true);
    });

    it("allows super_admin on a super-admin route", async () => {
      const { status } = await callProtected(requireSuperAdmin, asRole("super_admin"));
      assert.equal(status, 200);
    });

    it("denies admin on a super-admin route — no upward inheritance", async () => {
      // BR-006: refund approval is super_admin only.
      const { status, body } = await callProtected(requireSuperAdmin, asRole("admin"));

      assert.equal(status, 403);
      assert.equal(body["error"], "INSUFFICIENT_ROLE");
    });

    it("allows each role on its own tier", async () => {
      assert.equal((await callProtected(requireStudent, asRole("student"))).status, 200);
      assert.equal((await callProtected(requireTeacher, asRole("teacher"))).status, 200);
    });
  });

  describe("identity is never taken from the request", () => {
    it("ignores a role supplied in a header", async () => {
      const server = await startServer(appWith(requireAdmin));

      try {
        const res = await server.get("/protected", {
          headers: { "X-User-Role": "super_admin", "X-User-Id": "attacker" },
        });

        assert.equal(res.status, 401, "headers must not grant a role");
      } finally {
        await server.close();
      }
    });

    it("ignores a role supplied in the query string", async () => {
      const server = await startServer(appWith(requireAdmin));

      try {
        const res = await server.get("/protected?role=admin&userId=attacker");
        assert.equal(res.status, 401, "query params must not grant a role");
      } finally {
        await server.close();
      }
    });
  });

  describe("requireRoles misuse", () => {
    it("throws at setup time when given no roles", () => {
      // A guard allowing nothing would 403 everything silently.
      assert.throws(() => requireRoles([]), /at least one role/);
    });
  });
});
