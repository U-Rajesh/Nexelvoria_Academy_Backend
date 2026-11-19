import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import express, { type RequestHandler } from "express";

import { createApp } from "../src/app";
import { createContainer } from "../src/container/container";
import type { UserRole } from "../src/contracts/user.contract";
import { errorHandler } from "../src/middleware/error.middleware";
import { notFoundHandler } from "../src/middleware/not-found.middleware";
import { generateRefreshToken, issueAccessToken } from "../src/modules/auth/token.service";
import type { TeacherRepository } from "../src/modules/teachers/teacher.repository";
import { createTeacherRoutes } from "../src/modules/teachers/teacher.routes";
import { createTeacherService, toTeacherResponse } from "../src/modules/teachers/teacher.service";
import type { Teacher } from "../src/modules/teachers/teacher.types";
import type { UpdateTeacherBody } from "../src/modules/teachers/teacher.validation";
import { ApiError } from "../src/utils/api-error";
import { createTestHarness, type TestHarness } from "./fakes";
import { json, startServer, type TestServer } from "./helpers/server";

/**
 * Teacher Management T1/T2 - admin list, read and profile update.
 *
 *   GET   /api/v1/teachers              api-contracts 6 #1
 *   GET   /api/v1/teachers/:teacherId   api-contracts 6 #3
 *   PATCH /api/v1/teachers/:teacherId   api-contracts 6 #4 (profile fields)
 *
 * Four layers of evidence:
 *   1. the service over the in-memory fakes;
 *   2. the module router on a TEST-ONLY app with an injected principal;
 *   3. the REAL application with REAL authentication - a genuine session in
 *      the session fake plus an access token from the real token service;
 *   4. the real app over an EMPTY container (production state): fail closed.
 */

// --- fixtures ----------------------------------------------------------------

const teacher = (overrides: Partial<Teacher> & { id: string }): Teacher => ({
  name: `Teacher ${overrides.id}`,
  email: `${overrides.id}@test.local`,
  mobile: "9000000000",
  role: "teacher",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  specialization: "Full Stack Development",
  experienceYears: 5,
  bio: "Bio",
  qualifications: "M.Tech",
  assignedCourseIds: [],
  assignedBatchIds: [],
  rating: 4.5,
  ...overrides,
});

const PAGE = { page: 1, pageSize: 10, sortOrder: "asc" } as const;

const ids = (r: { items: { id: string }[] }) => r.items.map((t) => t.id);

/**
 * Every field a teacher response may carry - the frontend's `TeacherProfile`.
 * Written out HERE, independently of `toTeacherResponse`, so the test fails
 * if the whitelist drifts in either direction.
 */
const PERMITTED_FIELDS = [
  "id", "name", "email", "mobile", "role", "status", "createdAt", "avatarUrl",
  "specialization", "experienceYears", "bio", "qualifications",
  "assignedCourseIds", "assignedBatchIds", "rating",
].sort();

/** Fields an adapter might wrongly map onto a teacher row. */
const LEAKY = {
  passwordHash: "$2b$10$LEAKED-HASH",
  refreshToken: "rt-LEAKED",
  otpCode: "123456",
  failedLoginAttempts: 3,
  internalNotes: "do not expose",
};
const LEAK_PATTERN = /LEAKED|passwordHash|refreshToken|otpCode|123456|failedLoginAttempts|internalNotes/;

const withLeaks = (id: string): Teacher =>
  ({ ...teacher({ id, avatarUrl: "https://cdn.test/a.png" }), ...LEAKY }) as Teacher;

// --- 1. service ---------------------------------------------------------------

describe("teachers service", () => {
  let h: TestHarness;
  let service: ReturnType<typeof createTeacherService>;

  beforeEach(() => {
    h = createTestHarness();
    service = createTeacherService({ teachers: h.teachers });
  });

  describe("listTeachers", () => {
    beforeEach(() => {
      h.teachers.seed(
        teacher({
          id: "t1",
          name: "charlie",
          status: "active",
          specialization: "Data Science",
          experienceYears: 10,
          createdAt: "2026-01-01T00:00:00.000Z",
          assignedCourseIds: ["course-1"],
          assignedBatchIds: ["batch-A"],
        }),
      );
      h.teachers.seed(
        teacher({
          id: "t2",
          name: "Alpha",
          status: "suspended",
          specialization: "Cloud",
          experienceYears: 2,
          createdAt: "2026-03-01T00:00:00.000Z",
        }),
      );
      h.teachers.seed(
        teacher({
          id: "t3",
          name: "bravo",
          status: "active",
          specialization: "data science",
          experienceYears: 6,
          createdAt: "2026-02-01T00:00:00.000Z",
          email: "bravo@nexelvoria.test",
        }),
      );
    });

    it("lists all teachers, newest first by default (createdAt DESC)", async () => {
      const result = await service.listTeachers(PAGE);
      assert.deepEqual(ids(result), ["t2", "t3", "t1"]);
      assert.equal(result.total, 3);
    });

    it("filters by status, specialization (case-insensitive), courseId and batchId", async () => {
      assert.deepEqual(ids(await service.listTeachers({ ...PAGE, status: "suspended" })), ["t2"]);
      assert.deepEqual(
        ids(
          await service.listTeachers({ ...PAGE, specialization: "DATA SCIENCE", sortBy: "name" }),
        ),
        ["t3", "t1"],
      );
      assert.deepEqual(ids(await service.listTeachers({ ...PAGE, courseId: "course-1" })), ["t1"]);
      assert.deepEqual(ids(await service.listTeachers({ ...PAGE, batchId: "batch-A" })), ["t1"]);
    });

    it("searches name, email and specialization", async () => {
      assert.deepEqual(ids(await service.listTeachers({ ...PAGE, search: "ALPHA" })), ["t2"]);
      assert.deepEqual(ids(await service.listTeachers({ ...PAGE, search: "nexelvoria.test" })), [
        "t3",
      ]);
      assert.deepEqual(ids(await service.listTeachers({ ...PAGE, search: "cloud" })), ["t2"]);
    });

    it("combines filters", async () => {
      const result = await service.listTeachers({
        ...PAGE,
        status: "active",
        specialization: "data science",
        search: "bravo",
      });
      assert.deepEqual(ids(result), ["t3"]);
    });

    it("sorts by name (case-insensitive), createdAt and experienceYears, both directions", async () => {
      assert.deepEqual(ids(await service.listTeachers({ ...PAGE, sortBy: "name" })), [
        "t2",
        "t3",
        "t1",
      ]);
      assert.deepEqual(
        ids(await service.listTeachers({ ...PAGE, sortBy: "name", sortOrder: "desc" })),
        ["t1", "t3", "t2"],
      );
      assert.deepEqual(ids(await service.listTeachers({ ...PAGE, sortBy: "createdAt" })), [
        "t1",
        "t3",
        "t2",
      ]);
      assert.deepEqual(
        ids(await service.listTeachers({ ...PAGE, sortBy: "experienceYears", sortOrder: "desc" })),
        ["t1", "t3", "t2"],
      );
    });

    it("sortOrder WITHOUT sortBy does not override the default (createdAt DESC, id ASC)", async () => {
      // Documented in database-handoff.md section 8: sortOrder only applies
      // to an explicit, allow-listed sortBy.
      assert.deepEqual(ids(await service.listTeachers({ ...PAGE, sortOrder: "asc" })), [
        "t2",
        "t3",
        "t1",
      ]);
      assert.deepEqual(ids(await service.listTeachers({ ...PAGE, sortOrder: "desc" })), [
        "t2",
        "t3",
        "t1",
      ]);
    });

    it("falls back to the default order for a non-allow-listed or hostile sortBy", async () => {
      for (const sortBy of ["email", "rating", "name; DROP TABLE Teachers--"]) {
        assert.deepEqual(ids(await service.listTeachers({ ...PAGE, sortBy })), ["t2", "t3", "t1"]);
      }
    });

    it("paginates with correct metadata", async () => {
      const page2 = await service.listTeachers({ ...PAGE, page: 2, pageSize: 2 });
      assert.deepEqual(ids(page2), ["t1"]);
      assert.equal(page2.total, 3);
      assert.equal(page2.page, 2);
      assert.equal(page2.pageSize, 2);
      assert.equal(page2.totalPages, 2);
    });
  });

  describe("ordering ties", () => {
    it("breaks ties by id ASC (numeric-aware) in either direction, without skipping rows", async () => {
      const same = "2026-05-05T00:00:00.000Z";
      for (const id of ["t10", "t2", "t1"]) h.teachers.seed(teacher({ id, createdAt: same }));

      assert.deepEqual(ids(await service.listTeachers(PAGE)), ["t1", "t2", "t10"]);
      assert.deepEqual(
        ids(await service.listTeachers({ ...PAGE, sortBy: "createdAt", sortOrder: "asc" })),
        ["t1", "t2", "t10"],
      );

      const seen: string[] = [];
      for (const page of [1, 2]) {
        seen.push(...ids(await service.listTeachers({ ...PAGE, page, pageSize: 2 })));
      }
      assert.deepEqual(seen, ["t1", "t2", "t10"]);
    });
  });

  describe("getTeacherById", () => {
    it("returns the teacher", async () => {
      h.teachers.seed(teacher({ id: "t1", name: "Ravi" }));
      assert.equal((await service.getTeacherById("t1")).name, "Ravi");
    });

    it("throws 404 for an unknown id", async () => {
      await assert.rejects(
        service.getTeacherById("nope"),
        (err: unknown) =>
          err instanceof ApiError && err.status === 404 && err.message === "Teacher not found",
      );
    });
  });

  describe("updateTeacher", () => {
    beforeEach(() => {
      h.teachers.seed(teacher({ id: "t1" }));
    });

    it("updates every allowed profile field and persists it", async () => {
      const out = await service.updateTeacher("t1", {
        specialization: "Cybersecurity",
        experienceYears: 12,
        bio: "New bio",
        qualifications: "PhD",
      });

      assert.equal(out.specialization, "Cybersecurity");
      assert.equal(out.experienceYears, 12);
      assert.equal(out.bio, "New bio");
      assert.equal(out.qualifications, "PhD");

      const stored = await h.teachers.findById("t1");
      assert.equal(stored?.specialization, "Cybersecurity");
    });

    it("accepts experienceYears at the maximum of 80", async () => {
      assert.equal((await service.updateTeacher("t1", { experienceYears: 80 })).experienceYears, 80);
    });

    describe("avatarUrl is not updatable (user-record field, Q25)", () => {
      const avatarBody = (extra: Record<string, unknown> = {}) =>
        ({ avatarUrl: "https://cdn.test/new.png", ...extra }) as unknown as UpdateTeacherBody;

      it("a body with ONLY avatarUrl is 422 and writes nothing", async () => {
        h.teachers.seed(teacher({ id: "t2", avatarUrl: "https://cdn.test/original.png" }));

        await assert.rejects(
          service.updateTeacher("t2", avatarBody()),
          (err: unknown) => err instanceof ApiError && err.status === 422,
        );
        assert.equal((await h.teachers.findById("t2"))?.avatarUrl, "https://cdn.test/original.png");
      });

      it("alongside an allowed field, avatarUrl is ignored and the avatar is unchanged", async () => {
        h.teachers.seed(teacher({ id: "t2", avatarUrl: "https://cdn.test/original.png" }));

        const out = await service.updateTeacher("t2", avatarBody({ bio: "New" }));
        assert.equal(out.bio, "New");
        assert.equal(out.avatarUrl, "https://cdn.test/original.png");
      });

      it("never passes avatarUrl to the repository", async () => {
        const writes: Record<string, unknown>[] = [];
        const recording = {
          update: async (_id: string, input: Record<string, unknown>) => {
            writes.push(input);
            return teacher({ id: "t1" });
          },
        } as unknown as TeacherRepository;

        await createTeacherService({ teachers: recording }).updateTeacher(
          "t1",
          avatarBody({ bio: "x" }),
        );

        assert.equal(writes.length, 1);
        assert.deepEqual(writes[0], { bio: "x" });
        assert.equal("avatarUrl" in writes[0]!, false);
      });
    });

    it("updates a single field and leaves the others unchanged", async () => {
      const out = await service.updateTeacher("t1", { bio: "Only bio" });
      assert.equal(out.bio, "Only bio");
      assert.equal(out.specialization, "Full Stack Development");
      assert.equal(out.experienceYears, 5);
    });

    it("ignores prohibited fields even when called WITHOUT the HTTP schema", async () => {
      const sneaky = {
        bio: "ok",
        email: "hijack@test.local",
        role: "admin",
        status: "suspended",
        rating: 1,
        assignedCourseIds: ["course-x"],
        assignedBatchIds: ["batch-x"],
        name: "Renamed",
        mobile: "9999999999",
        id: "t-other",
      } as unknown as UpdateTeacherBody;

      const out = await service.updateTeacher("t1", sneaky);

      assert.equal(out.bio, "ok");
      assert.equal(out.email, "t1@test.local");
      assert.equal(out.role, "teacher");
      assert.equal(out.status, "active");
      assert.equal(out.rating, 4.5);
      assert.deepEqual(out.assignedCourseIds, []);
      assert.deepEqual(out.assignedBatchIds, []);
      assert.equal(out.name, "Teacher t1");
      assert.equal(out.mobile, "9000000000");
      assert.equal(out.id, "t1");
    });

    it("refuses a body with no updatable fields (422), writing nothing", async () => {
      const onlyProhibited = { status: "suspended" } as unknown as UpdateTeacherBody;
      await assert.rejects(
        service.updateTeacher("t1", onlyProhibited),
        (err: unknown) => err instanceof ApiError && err.status === 422,
      );
      assert.equal((await h.teachers.findById("t1"))?.status, "active");
    });

    it("throws 404 when updating a missing teacher", async () => {
      await assert.rejects(
        service.updateTeacher("nope", { bio: "x" }),
        (err: unknown) =>
          err instanceof ApiError && err.status === 404 && err.message === "Teacher not found",
      );
    });

    it("passes unexpected repository errors through untouched (they become a 500)", async () => {
      const boom = new Error("connection reset");
      const failing = createTeacherService({
        teachers: { update: async () => Promise.reject(boom) } as unknown as TeacherRepository,
      });
      await assert.rejects(failing.updateTeacher("t1", { bio: "x" }), (err: unknown) => err === boom);
    });
  });

  describe("response whitelist", () => {
    it("strips unknown/internal fields on all three operations", async () => {
      const row = withLeaks("t1");
      const leakyRepo = {
        findById: async () => row,
        findMany: async () => ({ items: [row], total: 1, page: 1, pageSize: 10, totalPages: 1 }),
        update: async () => row,
      } as unknown as TeacherRepository;
      const leaky = createTeacherService({ teachers: leakyRepo });

      const one = await leaky.getTeacherById("t1");
      const list = await leaky.listTeachers(PAGE);
      const updated = await leaky.updateTeacher("t1", { bio: "x" });

      for (const out of [one, list.items[0]!, updated]) {
        assert.deepEqual(Object.keys(out).sort(), PERMITTED_FIELDS);
        assert.doesNotMatch(JSON.stringify(out), LEAK_PATTERN);
      }
    });

    it("builds the page explicitly: extra adapter properties on the page object never leak", async () => {
      const leakyPage = {
        items: [withLeaks("t1")],
        total: 41,
        page: 3,
        pageSize: 20,
        totalPages: 3,
        // What an adapter might wrongly attach to the page wrapper itself.
        debugSql: "SELECT * FROM Teachers -- LEAKED",
        nextCursor: "cursor-LEAKED",
        rawRows: [{ passwordHash: "$2b$10$LEAKED-HASH" }],
      };
      const leaky = createTeacherService({
        teachers: { findMany: async () => leakyPage } as unknown as TeacherRepository,
      });

      const page = await leaky.listTeachers({ ...PAGE, page: 3, pageSize: 20 });

      assert.deepEqual(Object.keys(page).sort(), ["items", "page", "pageSize", "total", "totalPages"]);
      assert.equal(page.total, 41);
      assert.equal(page.page, 3);
      assert.equal(page.pageSize, 20);
      assert.equal(page.totalPages, 3); // ceil(41 / 20), derived by toPaginatedResult
      assert.doesNotMatch(JSON.stringify(page), LEAK_PATTERN);
      assert.doesNotMatch(JSON.stringify(page), /debugSql|nextCursor|rawRows/);
    });

    it("omits an absent avatarUrl and hands out detached arrays", () => {
      const source = teacher({ id: "t1", assignedCourseIds: ["c1"] });
      const out = toTeacherResponse(source);

      assert.equal("avatarUrl" in out, false);
      out.assignedCourseIds.push("mutated");
      assert.deepEqual(source.assignedCourseIds, ["c1"]);
    });
  });
});

// --- 2. router on a TEST-ONLY app with an injected principal -------------------

describe("teachers HTTP - test app, injected principal", () => {
  const h = createTestHarness();
  let server: TestServer;

  /**
   * TEST-ONLY identity, the authorize.test.ts pattern. The guards read only
   * `req.principal`. `authenticate` is replaced by this injector here; the
   * REAL authenticate middleware is exercised in section 3.
   */
  let identity: UserRole | undefined;
  const injectPrincipal: RequestHandler = (req, _res, next) => {
    if (identity !== undefined) {
      req.principal = { id: `user-${identity}`, role: identity, sessionId: `session-${identity}` };
    }
    next();
  };
  const passThrough: RequestHandler = (_req, _res, next) => next();

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use(injectPrincipal);
    app.use(
      "/api/v1/teachers",
      createTeacherRoutes({ teachers: h.teachers, authenticate: passThrough }),
    );
    app.use(notFoundHandler);
    app.use(errorHandler);
    server = await startServer(app);
  });

  after(async () => {
    await server.close();
  });

  beforeEach(() => {
    h.reset();
    identity = undefined;
    h.teachers.seed(teacher({ id: "t1", name: "Ravi" }));
    h.teachers.seed(teacher({ id: "t2", name: "Meera", createdAt: "2026-02-01T00:00:00.000Z" }));
  });

  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${server.url}/api/v1/teachers${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const routes: [string, string, unknown?][] = [
    ["GET", ""],
    ["GET", "/t1"],
    ["PATCH", "/t1", { bio: "x" }],
  ];

  describe("authorization", () => {
    it("401s every route without a principal - and before validation", async () => {
      for (const [method, path, body] of routes) {
        const res = await call(method, path, body);
        assert.equal(res.status, 401, `${method} ${path}`);
        assert.equal((await json(res))["error"], "UNAUTHENTICATED");
      }
      assert.equal((await call("GET", "?status=bogus")).status, 401);
      assert.equal((await call("PATCH", "/t1", { experienceYears: -5 })).status, 401);
    });

    for (const role of ["student", "teacher"] as const) {
      it(`403s every route for a ${role} and writes nothing`, async () => {
        identity = role;
        for (const [method, path, body] of routes) {
          const res = await call(method, path, body);
          assert.equal(res.status, 403, `${role} ${method} ${path}`);
          assert.equal((await json(res))["error"], "INSUFFICIENT_ROLE");
        }
        assert.equal((await h.teachers.findById("t1"))?.bio, "Bio");
      });
    }

    for (const role of ["admin", "super_admin"] as const) {
      it(`allows ${role} on every route`, async () => {
        identity = role;
        for (const [method, path, body] of routes) {
          assert.equal((await call(method, path, body)).status, 200, `${role} ${method} ${path}`);
        }
      });
    }
  });

  describe("as admin", () => {
    beforeEach(() => {
      identity = "admin";
    });

    it("GET /teachers returns the paginated envelope with whitelisted items", async () => {
      const body = await json(await call("GET", "?pageSize=1&page=2"));
      assert.equal(body["success"], true);

      const data = body["data"] as {
        items: Record<string, unknown>[];
        total: number;
        page: number;
        pageSize: number;
        totalPages: number;
      };
      assert.deepEqual(Object.keys(data).sort(), ["items", "page", "pageSize", "total", "totalPages"]);
      assert.equal(data.total, 2);
      assert.equal(data.page, 2);
      assert.equal(data.pageSize, 1);
      assert.equal(data.totalPages, 2);
      assert.equal(data.items.length, 1);
      assert.ok(Object.keys(data.items[0]!).every((k) => PERMITTED_FIELDS.includes(k)));
    });

    it("GET /teachers applies filters, search and sort from the query string", async () => {
      h.teachers.seed(teacher({ id: "t3", name: "Zed", status: "suspended", specialization: "Cloud" }));

      const byStatus = await json(await call("GET", "?status=suspended"));
      assert.deepEqual(ids(byStatus["data"] as { items: { id: string }[] }), ["t3"]);

      const bySearch = await json(await call("GET", "?search=meera"));
      assert.deepEqual(ids(bySearch["data"] as { items: { id: string }[] }), ["t2"]);

      const sorted = await json(await call("GET", "?sortBy=name&sortOrder=desc"));
      assert.deepEqual(ids(sorted["data"] as { items: { id: string }[] }), ["t3", "t1", "t2"]);
    });

    it("GET /teachers rejects invalid query values with 422 field details", async () => {
      const cases = [
        ["status=retired", "status"],
        ["sortOrder=sideways", "sortOrder"],
        ["pageSize=1000", "pageSize"],
        ["page=0", "page"],
        ["specialization=", "specialization"],
        [`specialization=${"x".repeat(101)}`, "specialization"],
        ["batchId=", "batchId"],
      ] as const;

      for (const [qs, field] of cases) {
        const res = await call("GET", `?${qs}`);
        assert.equal(res.status, 422, qs);
        const payload = await json(res);
        assert.equal(payload["error"], "VALIDATION_ERROR");
        assert.ok(
          (payload["details"] as { field: string }[]).some((d) => d.field === field),
          `${qs} -> ${field}`,
        );
      }
    });

    it("GET /teachers ignores unknown query params", async () => {
      assert.equal((await call("GET", "?foo=bar")).status, 200);
    });

    it("GET /teachers/:teacherId returns the teacher, or 404", async () => {
      const ok = await call("GET", "/t1");
      assert.equal(ok.status, 200);
      const data = (await json(ok))["data"] as Teacher;
      assert.equal(data.id, "t1");
      assert.equal(data.name, "Ravi");

      const missing = await call("GET", "/does-not-exist");
      assert.equal(missing.status, 404);
      const body = await json(missing);
      assert.equal(body["error"], "NOT_FOUND");
      assert.equal(body["message"], "Teacher not found");
    });

    it("PATCH updates allowed fields and returns the updated profile", async () => {
      const res = await call("PATCH", "/t1", {
        specialization: "DevOps",
        experienceYears: 0,
        qualifications: "B.E.",
      });
      assert.equal(res.status, 200);

      const body = await json(res);
      assert.equal(body["success"], true);
      assert.equal(body["message"], "Teacher profile updated");
      const data = body["data"] as Teacher;
      assert.equal(data.specialization, "DevOps");
      assert.equal(data.experienceYears, 0);
      assert.equal(data.qualifications, "B.E.");

      // Visible through the read endpoint.
      const reread = (await json(await call("GET", "/t1")))["data"] as Teacher;
      assert.equal(reread.specialization, "DevOps");
    });

    it("PATCH cannot modify prohibited fields - they are ignored", async () => {
      const res = await call("PATCH", "/t1", {
        bio: "Allowed",
        email: "hijack@test.local",
        role: "admin",
        status: "suspended",
        rating: 1,
        assignedCourseIds: ["c-x"],
        assignedBatchIds: ["b-x"],
        name: "Renamed",
        mobile: "9999999999",
      });
      assert.equal(res.status, 200);

      const data = (await json(res))["data"] as Teacher;
      assert.equal(data.bio, "Allowed");
      assert.equal(data.email, "t1@test.local");
      assert.equal(data.role, "teacher");
      assert.equal(data.status, "active");
      assert.equal(data.rating, 4.5);
      assert.deepEqual(data.assignedCourseIds, []);
      assert.deepEqual(data.assignedBatchIds, []);
      assert.equal(data.name, "Ravi");
      assert.equal(data.mobile, "9000000000");
    });

    it("PATCH with ONLY prohibited fields is 422, not a silent no-op", async () => {
      const res = await call("PATCH", "/t1", { status: "suspended", email: "x@test.local" });
      assert.equal(res.status, 422);
      assert.equal((await json(res))["error"], "VALIDATION_ERROR");
      assert.equal((await h.teachers.findById("t1"))?.status, "active");
    });

    it("PATCH rejects invalid bodies with 422 field details", async () => {
      const cases: [unknown, string][] = [
        [{ experienceYears: -1 }, "experienceYears"],
        [{ experienceYears: 2.5 }, "experienceYears"],
        [{ experienceYears: "5" }, "experienceYears"],
        [{ experienceYears: 81 }, "experienceYears"],
        [{ specialization: "   " }, "specialization"],
        [{ bio: "x".repeat(2001) }, "bio"],
        [{ qualifications: "" }, "qualifications"],
      ];

      for (const [body, field] of cases) {
        const res = await call("PATCH", "/t1", body);
        assert.equal(res.status, 422, JSON.stringify(body));
        const details = (await json(res))["details"] as { field: string }[];
        assert.ok(details.some((d) => d.field === field), `${JSON.stringify(body)} -> ${field}`);
      }

      assert.equal((await h.teachers.findById("t1"))?.bio, "Bio", "nothing written");
    });

    it("PATCH accepts experienceYears 80 and rejects 81", async () => {
      const ok = await call("PATCH", "/t1", { experienceYears: 80 });
      assert.equal(ok.status, 200);
      assert.equal(((await json(ok))["data"] as Teacher).experienceYears, 80);

      const over = await call("PATCH", "/t1", { experienceYears: 81 });
      assert.equal(over.status, 422);
      assert.ok(
        ((await json(over))["details"] as { field: string }[]).some(
          (d) => d.field === "experienceYears",
        ),
      );
      assert.equal((await h.teachers.findById("t1"))?.experienceYears, 80, "81 was not written");
    });

    it("PATCH with ONLY avatarUrl is 422 (reported on `body`) and the avatar is unchanged", async () => {
      h.teachers.seed(teacher({ id: "t9", avatarUrl: "https://cdn.test/original.png" }));

      const res = await call("PATCH", "/t9", { avatarUrl: "https://cdn.test/new.png" });
      assert.equal(res.status, 422);
      const payload = await json(res);
      assert.equal(payload["error"], "VALIDATION_ERROR");
      assert.ok((payload["details"] as { field: string }[]).some((d) => d.field === "body"));

      assert.equal((await h.teachers.findById("t9"))?.avatarUrl, "https://cdn.test/original.png");
    });

    it("PATCH ignores avatarUrl sent with an allowed field", async () => {
      h.teachers.seed(teacher({ id: "t9", avatarUrl: "https://cdn.test/original.png" }));

      const res = await call("PATCH", "/t9", {
        bio: "Updated",
        avatarUrl: "javascript:alert(1)",
      });
      assert.equal(res.status, 200);
      const data = (await json(res))["data"] as Teacher;
      assert.equal(data.bio, "Updated");
      assert.equal(data.avatarUrl, "https://cdn.test/original.png");
    });

    it("GET /teachers with sortOrder but no sortBy keeps the default order", async () => {
      // t2 is newer than t1 (createdAt), so the default puts it first.
      for (const qs of ["?sortOrder=asc", "?sortOrder=desc"]) {
        const body = await json(await call("GET", qs));
        assert.deepEqual(ids(body["data"] as { items: { id: string }[] }), ["t2", "t1"], qs);
      }
    });

    it("PATCH with an empty object or no body at all is 422", async () => {
      assert.equal((await call("PATCH", "/t1", {})).status, 422);
      assert.equal((await call("PATCH", "/t1")).status, 422);
    });

    it("PATCH on a missing teacher is 404", async () => {
      const res = await call("PATCH", "/nope", { bio: "x" });
      assert.equal(res.status, 404);
      assert.equal((await json(res))["message"], "Teacher not found");
    });

    it("exposes no other write routes (creation, status, allocations are deferred)", async () => {
      assert.equal((await call("POST", "", { name: "x" })).status, 404);
      assert.equal((await call("PATCH", "/t1/status", { status: "suspended" })).status, 404);
      assert.equal((await call("POST", "/t1/allocations", {})).status, 404);
    });
  });
});

// --- 3. REAL application, REAL authentication -----------------------------------

describe("teachers HTTP - real application with real authentication", () => {
  const h = createTestHarness();
  let server: TestServer;

  /** Opens a real session in the session fake and mints a matching token. */
  const login = async (role: UserRole): Promise<{ token: string; sessionId: string; userId: string }> => {
    const userId = `user-${role}`;
    const refresh = generateRefreshToken();
    const session = await h.sessions.create({
      userId,
      refreshTokenHash: refresh.tokenHash,
      expiresAt: refresh.expiresAt,
    });
    const { token } = issueAccessToken({ userId, role, sessionId: session.sessionId });
    return { token, sessionId: session.sessionId, userId };
  };

  const get = (path: string, token?: string, extra: Record<string, string> = {}) =>
    server.get(`/api/v1/teachers${path}`, {
      headers: { ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }), ...extra },
    });

  before(async () => {
    server = await startServer(createApp({ container: h.container }));
  });

  after(async () => {
    await server.close();
  });

  beforeEach(() => {
    h.reset();
    h.teachers.seed(teacher({ id: "t1", name: "Ravi" }));
  });

  it("401 without a token", async () => {
    const res = await get("");
    assert.equal(res.status, 401);
    assert.equal((await json(res))["error"], "UNAUTHENTICATED");
  });

  it("401 for a forged token, and role hints in headers/query are ignored", async () => {
    const res = await get("?role=admin", "forged.jwt.token", { "X-User-Role": "admin" });
    assert.equal(res.status, 401);
  });

  it("200 for an authenticated admin on list and detail", async () => {
    const { token } = await login("admin");
    assert.equal((await get("", token)).status, 200);

    const res = await get("/t1", token);
    assert.equal(res.status, 200);
    assert.equal(((await json(res))["data"] as Teacher).name, "Ravi");
  });

  it("200 for an authenticated super_admin (inherits admin)", async () => {
    const { token } = await login("super_admin");
    assert.equal((await get("", token)).status, 200);
  });

  it("403 for an authenticated student or teacher", async () => {
    for (const role of ["student", "teacher"] as const) {
      const { token } = await login(role);
      const res = await get("", token);
      assert.equal(res.status, 403, role);
      assert.equal((await json(res))["error"], "INSUFFICIENT_ROLE");
    }
  });

  it("PATCH works end to end for an authenticated admin", async () => {
    const { token } = await login("admin");
    const res = await fetch(`${server.url}/api/v1/teachers/t1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ experienceYears: 9 }),
    });
    assert.equal(res.status, 200);
    assert.equal((await h.teachers.findById("t1"))?.experienceYears, 9);
  });

  it("401 once the session is revoked, even with a still-valid token", async () => {
    const { token, sessionId, userId } = await login("admin");
    assert.equal((await get("", token)).status, 200);

    await h.sessions.revokeSession({ sessionId, userId, reason: "logout" });
    assert.equal((await get("", token)).status, 401);
  });

  it("does not disturb health or the public course catalogue", async () => {
    assert.equal((await server.get("/api/v1/health")).status, 200);
    assert.equal((await server.get("/api/v1/courses")).status, 200);
  });
});

// --- 4. REAL application, EMPTY container (production state) ----------------------

describe("teachers HTTP - production state (no adapters registered)", () => {
  let server: TestServer;

  before(async () => {
    server = await startServer(createApp({ container: createContainer({}) }));
  });

  after(async () => {
    await server.close();
  });

  it("still boots: teacher routes resolve their dependencies lazily", async () => {
    assert.equal((await server.get("/api/v1/health")).status, 200);
  });

  it("401 without a token", async () => {
    assert.equal((await server.get("/api/v1/teachers")).status, 401);
  });

  it("503 - never access - for a valid token when sessions cannot be checked", async () => {
    const { token } = issueAccessToken({ userId: "user-admin", role: "admin", sessionId: "s-1" });
    const res = await server.get("/api/v1/teachers", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 503);
    assert.equal((await json(res))["error"], "SERVICE_UNAVAILABLE");
  });
});
