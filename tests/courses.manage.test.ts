import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import express, { type RequestHandler } from "express";

import { createApp } from "../src/app";
import { createContainer } from "../src/container/container";
import type { UserRole } from "../src/contracts/user.contract";
import { generateRefreshToken, issueAccessToken } from "../src/modules/auth/token.service";
import { errorHandler } from "../src/middleware/error.middleware";
import { notFoundHandler } from "../src/middleware/not-found.middleware";
import type { CourseRepository } from "../src/modules/courses/course.repository";
import { createCourseRoutes } from "../src/modules/courses/course.routes";
import {
  createCourseService,
  isPublishedForStatus,
} from "../src/modules/courses/course.service";
import {
  COURSE_STATUSES,
  type Course,
  type CourseModule,
} from "../src/modules/courses/course.types";
import type { CreateCourseBody } from "../src/modules/courses/course.validation";
import { ApiError } from "../src/utils/api-error";
import { createTestHarness, type TestHarness } from "./fakes";
import { json, startServer, type TestServer } from "./helpers/server";

/**
 * Step 2A - Courses Management API (admin-only).
 *
 * Three layers of evidence:
 *   1. the service, called directly over the in-memory fake;
 *   2. the module router on a TEST-ONLY app with injected identities;
 *   3. the REAL application, where every management route must be 401
 *      because authentication does not exist yet.
 */

// --- fixtures --------------------------------------------------------------

const createBody = (overrides: Partial<CreateCourseBody> = {}): CreateCourseBody => ({
  slug: "java-full-stack",
  title: "Java Full Stack",
  shortDescription: "Short",
  longDescription: "Long",
  thumbnailUrl: "https://cdn.test/thumb.png",
  durationWeeks: 24,
  totalHours: 320,
  feeINR: 75000,
  level: "Beginner",
  category: "Software Development",
  technologies: ["Java"],
  hasPlacementGuarantee: false,
  prerequisites: [],
  learningOutcomes: ["Build APIs"],
  ...overrides,
});

const seeded = (h: TestHarness, overrides: Partial<Course> = {}): Course =>
  h.courses.seed({
    id: "course-x",
    slug: "seeded-course",
    title: "Seeded",
    shortDescription: "Short",
    longDescription: "Long",
    thumbnailUrl: "https://cdn.test/t.png",
    durationWeeks: 10,
    totalHours: 100,
    feeINR: 1000,
    level: "Beginner",
    category: "Testing",
    technologies: [],
    modules: [],
    isPublished: false,
    status: "Draft",
    hasPlacementGuarantee: false,
    prerequisites: [],
    learningOutcomes: [],
    ...overrides,
  });

const tree = (courseId: string): CourseModule[] => [
  {
    id: "m1",
    courseId,
    title: "Module 1",
    description: "",
    order: 1,
    chapters: [
      {
        id: "c1",
        moduleId: "m1",
        title: "Chapter 1",
        order: 1,
        lessons: [
          {
            id: "l1",
            chapterId: "c1",
            title: "Lesson 1",
            durationMinutes: 10,
            isFreePreview: true,
            videoUrl: "https://cdn.test/v.mp4",
            order: 1,
          },
          {
            id: "l2",
            chapterId: "c1",
            title: "Lesson 2",
            durationMinutes: 20,
            isFreePreview: false,
            order: 2,
          },
        ],
      },
    ],
  },
];

const PAGE = { page: 1, pageSize: 10, sortOrder: "asc" } as const;

const isApiError = (status: number) => (err: unknown) =>
  err instanceof ApiError && err.status === status;

// --- 1. service --------------------------------------------------------------

describe("courses service - management", () => {
  let h: TestHarness;
  let service: ReturnType<typeof createCourseService>;

  beforeEach(() => {
    h = createTestHarness();
    service = createCourseService({ courses: h.courses });
  });

  describe("isPublishedForStatus (the frontend's rule)", () => {
    it("is true only for Published and Active", () => {
      const result = Object.fromEntries(COURSE_STATUSES.map((s) => [s, isPublishedForStatus(s)]));
      assert.deepEqual(result, {
        Draft: false,
        Published: true,
        Active: true,
        Inactive: false,
        Archived: false,
      });
    });
  });

  describe("listCourses", () => {
    it("includes drafts and every other status", async () => {
      seeded(h, { id: "a", slug: "a", status: "Draft", isPublished: false });
      seeded(h, { id: "b", slug: "b", status: "Published", isPublished: true });
      seeded(h, { id: "c", slug: "c", status: "Archived", isPublished: false });

      const result = await service.listCourses(PAGE);
      assert.equal(result.total, 3);
    });

    it("filters by status and sorts by an allow-listed field", async () => {
      seeded(h, { id: "a", slug: "a", status: "Draft", feeINR: 300 });
      seeded(h, { id: "b", slug: "b", status: "Draft", feeINR: 100 });
      seeded(h, { id: "c", slug: "c", status: "Archived", feeINR: 200 });

      const drafts = await service.listCourses({
        ...PAGE,
        status: "Draft",
        sortBy: "feeINR",
      });
      assert.deepEqual(drafts.items.map((c) => c.id), ["b", "a"]);
    });

    it("returns full course data, including paid lesson content", async () => {
      seeded(h, { modules: tree("course-x") });
      const [course] = (await service.listCourses(PAGE)).items;
      // Admin view is NOT the public projection.
      assert.equal(course?.status, "Draft");
    });
  });

  describe("getCourseById", () => {
    it("returns the course, or 404", async () => {
      seeded(h);
      assert.equal((await service.getCourseById("course-x")).id, "course-x");
      await assert.rejects(service.getCourseById("nope"), isApiError(404));
    });
  });

  describe("createCourse", () => {
    it("always creates an unpublished Draft with an empty curriculum", async () => {
      const course = await service.createCourse(createBody());

      assert.equal(course.status, "Draft");
      assert.equal(course.isPublished, false);
      assert.deepEqual(course.modules, []);
    });

    it("cannot be smuggled a status, publish flag or curriculum", async () => {
      const body = {
        ...createBody(),
        status: "Published",
        isPublished: true,
        modules: tree("x"),
      } as unknown as CreateCourseBody;

      const course = await service.createCourse(body);
      assert.equal(course.status, "Draft");
      assert.equal(course.isPublished, false);
      assert.deepEqual(course.modules, []);
    });

    it("does not generate a courseCode (Q2)", async () => {
      const course = await service.createCourse(createBody());
      assert.equal("courseCode" in course, false);

      const coded = await service.createCourse(
        createBody({ slug: "coded", courseCode: "CRS-JFS-101" }),
      );
      assert.equal(coded.courseCode, "CRS-JFS-101");
    });

    it("maps a duplicate slug to 409 (case-insensitive)", async () => {
      await service.createCourse(createBody({ slug: "dup" }));
      await assert.rejects(service.createCourse(createBody({ slug: "DUP" })), isApiError(409));
    });

    it("refuses the reserved slug even without HTTP validation", async () => {
      await assert.rejects(service.createCourse(createBody({ slug: "manage" })), isApiError(422));
      assert.equal(h.courses.count, 0);
    });

    it("checks the reserved slug case-insensitively at the service level", async () => {
      for (const slug of ["Manage", "MANAGE", "  manage  "]) {
        await assert.rejects(service.createCourse(createBody({ slug })), isApiError(422), slug);
      }
      assert.equal(h.courses.count, 0);
    });

    it("normalises the slug itself when called without HTTP validation", async () => {
      const course = await service.createCourse(createBody({ slug: "  Java-Full-Stack  " }));
      assert.equal(course.slug, "java-full-stack");
    });

    it("rejects a malformed slug at the service level", async () => {
      for (const slug of ["bad slug", "bad_slug", "trailing-", "a--b", "", "x".repeat(151)]) {
        const err = await service.createCourse(createBody({ slug })).catch((e: unknown) => e);
        assert.ok(err instanceof ApiError && err.status === 422, JSON.stringify(slug));
        assert.equal(err.details?.[0]?.field, "slug");
      }
      assert.equal(h.courses.count, 0);
    });
  });

  describe("updateCourse", () => {
    it("patches metadata fields", async () => {
      seeded(h);
      const updated = await service.updateCourse("course-x", { title: "Renamed", feeINR: 5 });

      assert.equal(updated.title, "Renamed");
      assert.equal(updated.feeINR, 5);
      assert.equal(updated.slug, "seeded-course");
    });

    it("never changes status, isPublished, modules or slug", async () => {
      seeded(h);
      const sneaky = {
        title: "x",
        status: "Published",
        isPublished: true,
        modules: tree("course-x"),
        slug: "hijacked",
      } as unknown as Parameters<typeof service.updateCourse>[1];

      // Called WITHOUT the HTTP schema: the service's own whitelist must hold.
      const updated = await service.updateCourse("course-x", sneaky);

      assert.equal(updated.title, "x");
      assert.equal(updated.status, "Draft");
      assert.equal(updated.isPublished, false);
      assert.deepEqual(updated.modules, []);
      assert.equal(updated.slug, "seeded-course");
    });

    it("404s for a missing course", async () => {
      await assert.rejects(service.updateCourse("nope", { title: "x" }), isApiError(404));
    });
  });

  describe("replaceCurriculum", () => {
    it("replaces the whole tree", async () => {
      seeded(h, { modules: tree("course-x") });
      const one = tree("course-x");
      one[0]!.chapters[0]!.lessons.pop();

      const updated = await service.replaceCurriculum("course-x", one);
      assert.equal(updated.modules[0]?.chapters[0]?.lessons.length, 1);
    });

    it("rejects a tree that is not internally consistent, with exact paths", async () => {
      seeded(h);
      const bad = tree("other-course");
      bad[0]!.chapters[0]!.moduleId = "wrong";
      bad[0]!.chapters[0]!.lessons[1]!.chapterId = "wrong";
      bad[0]!.chapters[0]!.lessons[1]!.id = "l1"; // duplicate

      const err = await service.replaceCurriculum("course-x", bad).catch((e: unknown) => e);
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 422);
      assert.deepEqual(
        err.details?.map((d) => d.field).sort(),
        [
          "modules.0.chapters.0.lessons.1.chapterId",
          "modules.0.chapters.0.lessons.1.id",
          "modules.0.chapters.0.moduleId",
          "modules.0.courseId",
        ],
      );

      // Nothing was written.
      assert.deepEqual((await h.courses.findById("course-x"))?.modules, []);
    });

    it("404s for a missing course", async () => {
      await assert.rejects(service.replaceCurriculum("nope", tree("nope")), isApiError(404));
    });
  });

  describe("status and publication", () => {
    /** Wraps the fake to record which write methods the service uses. */
    const recordingRepo = (calls: string[]): CourseRepository =>
      new Proxy(h.courses, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver) as unknown;
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            calls.push(String(prop));
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });

    it("derives isPublished from status for every status", async () => {
      seeded(h);

      for (const status of COURSE_STATUSES) {
        const course = await service.setCourseStatus("course-x", status);
        assert.equal(course.status, status);
        assert.equal(course.isPublished, isPublishedForStatus(status), status);
      }
    });

    it("writes status and isPublished in ONE setPublication call", async () => {
      seeded(h);
      const calls: string[] = [];
      const spied = createCourseService({ courses: recordingRepo(calls) });

      await spied.setCourseStatus("course-x", "Active");
      await spied.togglePublish("course-x");

      assert.equal(calls.filter((c) => c === "setPublication").length, 2);
      assert.equal(calls.includes("setStatus"), false, "deprecated setStatus must not be used");
      assert.equal(calls.includes("setPublished"), false, "deprecated setPublished must not be used");
    });

    it("archiving hides the course from the public catalogue", async () => {
      seeded(h, { status: "Published", isPublished: true });
      await service.getPublishedCourseBySlug("seeded-course");

      await service.setCourseStatus("course-x", "Archived");
      await assert.rejects(service.getPublishedCourseBySlug("seeded-course"), isApiError(404));
    });

    it("toggle: unpublished -> Published, published -> Draft", async () => {
      seeded(h);

      const on = await service.togglePublish("course-x");
      assert.equal(on.status, "Published");
      assert.equal(on.isPublished, true);

      const off = await service.togglePublish("course-x");
      assert.equal(off.status, "Draft");
      assert.equal(off.isPublished, false);
    });

    it("toggle on an Active course unpublishes it to Draft (frontend parity)", async () => {
      seeded(h, { status: "Active", isPublished: true });
      const off = await service.togglePublish("course-x");
      assert.equal(off.status, "Draft");
      assert.equal(off.isPublished, false);
    });

    it("404s for a missing course", async () => {
      await assert.rejects(service.setCourseStatus("nope", "Draft"), isApiError(404));
      await assert.rejects(service.togglePublish("nope"), isApiError(404));
    });
  });
});

// --- 2. router on a TEST-ONLY app with injected identity ---------------------

describe("courses HTTP - management routes (test app, injected identity)", () => {
  const h = createTestHarness();
  let server: TestServer;

  /**
   * TEST-ONLY identity, the same approach as authorize.test.ts `asRole`.
   * It stands in for the authentication middleware that does not exist;
   * nothing like it exists in src/.
   */
  let identity: UserRole | undefined;
  const injectIdentity: RequestHandler = (req, _res, next) => {
    if (identity !== undefined) {
      req.principal = { id: `user-${identity}`, role: identity, sessionId: `session-${identity}` };
    }
    next();
  };

  const send = (method: string, path: string, body?: unknown) =>
    fetch(`${server.url}/api/v1/courses${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  /** Every management route, with a valid body where one is needed. */
  const managementCalls = (): [string, string, unknown?][] => [
    ["GET", "/manage"],
    ["GET", "/manage/course-x"],
    ["POST", "", createBody({ slug: "brand-new" })],
    ["PATCH", "/course-x", { title: "x" }],
    ["PUT", "/course-x/curriculum", { modules: [] }],
    ["PATCH", "/course-x/status", { status: "Active" }],
    ["PATCH", "/course-x/publish"],
  ];

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use(injectIdentity);
    // `injectIdentity` stands in for authentication in THIS test app, so the
    // router's (now required) `authenticate` is a pass-through here. The REAL
    // authenticate middleware is exercised in the "real authentication"
    // section below with genuine sessions and signed tokens.
    const passThrough: RequestHandler = (_req, _res, next) => next();
    app.use(
      "/api/v1/courses",
      createCourseRoutes({ courses: h.courses, authenticate: passThrough }),
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
    seeded(h);
  });

  describe("authorization", () => {
    it("401s every management route without an identity", async () => {
      for (const [method, path, body] of managementCalls()) {
        const res = await send(method, path, body);
        assert.equal(res.status, 401, `${method} ${path}`);
        assert.equal((await json(res))["error"], "UNAUTHENTICATED", `${method} ${path}`);
      }
    });

    it("checks auth BEFORE validation - a bad body still gets 401, not 422", async () => {
      const res = await send("POST", "", { nonsense: true });
      assert.equal(res.status, 401);
    });

    for (const role of ["student", "teacher"] as const) {
      it(`403s every management route for a ${role}`, async () => {
        identity = role;
        for (const [method, path, body] of managementCalls()) {
          const res = await send(method, path, body);
          assert.equal(res.status, 403, `${role} ${method} ${path}`);
          assert.equal((await json(res))["error"], "INSUFFICIENT_ROLE");
        }
      });
    }

    for (const role of ["admin", "super_admin"] as const) {
      it(`allows ${role} (super_admin inherits admin)`, async () => {
        identity = role;
        for (const [method, path, body] of managementCalls()) {
          const res = await send(method, path, body);
          assert.ok(res.status === 200 || res.status === 201, `${role} ${method} ${path}: ${res.status}`);
        }
      });
    }
  });

  describe("as admin", () => {
    beforeEach(() => {
      identity = "admin";
    });

    it("GET /manage lists drafts that the public catalogue hides", async () => {
      const manage = await json(await send("GET", "/manage"));
      assert.equal((manage["data"] as { total: number }).total, 1);

      const pub = await json(await send("GET", ""));
      assert.equal((pub["data"] as { total: number }).total, 0);
    });

    it("GET /manage is not mistaken for a slug", async () => {
      identity = undefined;
      // Would be a public 404 if /:slug won; the guard proves /manage won.
      assert.equal((await send("GET", "/manage")).status, 401);
    });

    it("GET /manage/:courseId returns the full course, or 404", async () => {
      const res = await send("GET", "/manage/course-x");
      assert.equal(res.status, 200);
      assert.equal(((await json(res))["data"] as Course).status, "Draft");

      assert.equal((await send("GET", "/manage/nope")).status, 404);
    });

    it("POST creates a Draft with 201 + Location, ignoring status/isPublished/modules", async () => {
      const res = await send("POST", "", {
        ...createBody({ slug: "Fresh-Course" }),
        status: "Published",
        isPublished: true,
        modules: tree("x"),
      });

      assert.equal(res.status, 201);
      const course = (await json(res))["data"] as Course;
      assert.equal(course.slug, "fresh-course"); // normalised (Q17)
      assert.equal(course.status, "Draft");
      assert.equal(course.isPublished, false);
      assert.deepEqual(course.modules, []);
      assert.equal(res.headers.get("location"), `/api/v1/courses/manage/${course.id}`);
    });

    it("POST treats a blank courseCode as absent (frontend sends '')", async () => {
      const res = await send("POST", "", { ...createBody({ slug: "blank-code" }), courseCode: "" });
      assert.equal(res.status, 201);
      assert.equal("courseCode" in ((await json(res))["data"] as Course), false);
    });

    it("POST rejects invalid input with 422 field details", async () => {
      const cases: [Record<string, unknown>, string][] = [
        [{ slug: "manage" }, "slug"],
        [{ slug: "Bad Slug!" }, "slug"],
        [{ thumbnailUrl: "javascript:alert(1)" }, "thumbnailUrl"],
        [{ feeINR: 999.5 }, "feeINR"],
        [{ feeINR: -1 }, "feeINR"],
        [{ level: "Beginner to Advanced" }, "level"],
        [{ title: "   " }, "title"],
      ];

      for (const [override, field] of cases) {
        const res = await send("POST", "", { ...createBody({ slug: "valid-slug" }), ...override });
        assert.equal(res.status, 422, JSON.stringify(override));
        const details = (await json(res))["details"] as { field: string }[];
        assert.ok(details.some((d) => d.field === field), `${JSON.stringify(override)} -> ${field}`);
      }
    });

    it("POST with a taken slug is 409", async () => {
      const res = await send("POST", "", createBody({ slug: "seeded-course" }));
      assert.equal(res.status, 409);
      assert.equal((await json(res))["error"], "CONFLICT");
    });

    it("PATCH updates metadata and ignores status, isPublished, modules and slug", async () => {
      const res = await send("PATCH", "/course-x", {
        title: "Renamed",
        status: "Published",
        isPublished: true,
        modules: tree("course-x"),
        slug: "hijacked",
      });

      assert.equal(res.status, 200);
      const course = (await json(res))["data"] as Course;
      assert.equal(course.title, "Renamed");
      assert.equal(course.status, "Draft");
      assert.equal(course.isPublished, false);
      assert.deepEqual(course.modules, []);
      assert.equal(course.slug, "seeded-course");
    });

    it("PATCH on a missing course is 404", async () => {
      assert.equal((await send("PATCH", "/nope", { title: "x" })).status, 404);
    });

    it("PUT curriculum replaces the tree; an inconsistent tree is 422", async () => {
      const ok = await send("PUT", "/course-x/curriculum", { modules: tree("course-x") });
      assert.equal(ok.status, 200);
      assert.equal(((await json(ok))["data"] as Course).modules.length, 1);

      const bad = await send("PUT", "/course-x/curriculum", { modules: tree("someone-else") });
      assert.equal(bad.status, 422);
    });

    it("PUT curriculum treats a blank studyMaterialText as unset, keeps real text verbatim", async () => {
      const modules = tree("course-x");
      const [l1, l2] = modules[0]!.chapters[0]!.lessons;
      // What the syllabus editor sends for an empty field, and a whitespace variant.
      (l1 as { studyMaterialText?: string }).studyMaterialText = "";
      (l2 as { studyMaterialText?: string }).studyMaterialText = "   ";

      const res = await send("PUT", "/course-x/curriculum", { modules });
      assert.equal(res.status, 200);
      const lessons = ((await json(res))["data"] as Course).modules[0]!.chapters[0]!.lessons;
      assert.equal("studyMaterialText" in lessons[0]!, false);
      assert.equal("studyMaterialText" in lessons[1]!, false);

      // Non-blank text is stored exactly as sent, leading whitespace included.
      (l1 as { studyMaterialText?: string }).studyMaterialText = "  indented notes";
      const kept = await send("PUT", "/course-x/curriculum", { modules });
      const stored = ((await json(kept))["data"] as Course).modules[0]!.chapters[0]!.lessons[0]!;
      assert.equal(stored.studyMaterialText, "  indented notes");
    });

    it("PUT curriculum rejects a bare array body (must be { modules })", async () => {
      assert.equal((await send("PUT", "/course-x/curriculum", tree("course-x"))).status, 422);
    });

    it("PATCH status derives isPublished and validates the value", async () => {
      const active = await send("PATCH", "/course-x/status", { status: "Active" });
      const data = (await json(active))["data"] as Course;
      assert.equal(data.status, "Active");
      assert.equal(data.isPublished, true);

      // Now publicly visible.
      assert.equal((await send("GET", "/seeded-course")).status, 200);

      const archived = await send("PATCH", "/course-x/status", { status: "Archived" });
      assert.equal(((await json(archived))["data"] as Course).isPublished, false);
      assert.equal((await send("GET", "/seeded-course")).status, 404);

      assert.equal((await send("PATCH", "/course-x/status", { status: "Deleted" })).status, 422);
    });

    it("PATCH status ignores a client-supplied isPublished", async () => {
      const res = await send("PATCH", "/course-x/status", { status: "Draft", isPublished: true });
      assert.equal(((await json(res))["data"] as Course).isPublished, false);
    });

    it("PATCH publish toggles server-side and ignores any body", async () => {
      // The body asks for false; the course is a Draft, so the toggle publishes.
      const res = await send("PATCH", "/course-x/publish", { isPublished: false });
      const data = (await json(res))["data"] as Course;
      assert.equal(data.isPublished, true);
      assert.equal(data.status, "Published");
    });

    it("status/publish on a missing course is 404", async () => {
      assert.equal((await send("PATCH", "/nope/status", { status: "Draft" })).status, 404);
      assert.equal((await send("PATCH", "/nope/publish")).status, 404);
    });
  });
});

// --- 3. the REAL application: everything protected is 401 --------------------

describe("courses HTTP - real application (no authentication exists yet)", () => {
  const h = createTestHarness();
  let server: TestServer;

  before(async () => {
    server = await startServer(createApp({ container: h.container }));
  });

  after(async () => {
    await server.close();
  });

  beforeEach(() => {
    h.reset();
    seeded(h, { status: "Published", isPublished: true });
  });

  const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${server.url}/api/v1/courses${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it("answers 401 on every management route", async () => {
    const calls: [string, string, unknown?][] = [
      ["GET", "/manage"],
      ["GET", "/manage/course-x"],
      ["POST", "", createBody({ slug: "new-one" })],
      ["PATCH", "/course-x", { title: "x" }],
      ["PUT", "/course-x/curriculum", { modules: [] }],
      ["PATCH", "/course-x/status", { status: "Draft" }],
      ["PATCH", "/course-x/publish"],
    ];

    for (const [method, path, body] of calls) {
      const res = await send(method, path, body);
      assert.equal(res.status, 401, `${method} ${path}`);
    }

    // And nothing changed.
    const course = await h.courses.findById("course-x");
    assert.equal(course?.status, "Published");
    assert.equal(h.courses.count, 1);
  });

  it("cannot be talked into a role by headers or body", async () => {
    const res = await send(
      "PATCH",
      "/course-x/status",
      { status: "Archived", role: "admin", user: { role: "super_admin" } },
      { "X-User-Role": "admin", Authorization: "Bearer forged" },
    );
    assert.equal(res.status, 401);
    assert.equal((await h.courses.findById("course-x"))?.status, "Published");
  });

  it("still serves the public endpoints", async () => {
    assert.equal((await send("GET", "")).status, 200);
    assert.equal((await send("GET", "/seeded-course")).status, 200);
  });
});

// --- 4. REAL application, REAL authentication (signed JWT + real session) ------

/**
 * The 7 management routes with a valid body each. `slug` varies per call so
 * repeated POSTs never collide. Expected success status per route.
 */
const managementRoutes = (slug: string): [string, string, unknown, number][] => [
  ["GET", "/manage", undefined, 200],
  ["GET", "/manage/course-x", undefined, 200],
  ["POST", "", createBody({ slug }), 201],
  ["PATCH", "/course-x", { title: "Renamed" }, 200],
  ["PUT", "/course-x/curriculum", { modules: [] }, 200],
  ["PATCH", "/course-x/status", { status: "Active" }, 200],
  ["PATCH", "/course-x/publish", undefined, 200],
];

describe("courses HTTP - real application with real authentication", () => {
  const h = createTestHarness();
  let server: TestServer;
  let slugSeq = 0;
  const nextSlug = () => `auth-course-${(slugSeq += 1)}`;

  /** Opens a REAL session in the session fake and mints a REAL signed token. */
  const login = async (role: UserRole) => {
    const userId = `user-${role}`;
    const refresh = generateRefreshToken();
    const session = await h.sessions.create({
      userId,
      refreshTokenHash: refresh.tokenHash,
      expiresAt: refresh.expiresAt,
    });
    const { token } = issueAccessToken({ userId, role, sessionId: session.sessionId });
    return { token, userId, sessionId: session.sessionId };
  };

  const send = (method: string, path: string, body?: unknown, token?: string) =>
    fetch(`${server.url}/api/v1/courses${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  before(async () => {
    server = await startServer(createApp({ container: h.container }));
  });

  after(async () => {
    await server.close();
  });

  beforeEach(() => {
    h.reset();
    seeded(h);
  });

  for (const role of ["admin", "super_admin"] as const) {
    it(`a ${role} with a valid session succeeds on all 7 management routes`, async () => {
      const { token } = await login(role);

      for (const [method, path, body, expected] of managementRoutes(nextSlug())) {
        const res = await send(method, path, body, token);
        assert.equal(res.status, expected, `${role} ${method} ${path}`);
        assert.equal((await json(res))["success"], true, `${role} ${method} ${path}`);
      }
    });
  }

  it("401 UNAUTHENTICATED on all 7 routes without a token, and nothing is written", async () => {
    for (const [method, path, body] of managementRoutes(nextSlug())) {
      const res = await send(method, path, body);
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal((await json(res))["error"], "UNAUTHENTICATED", `${method} ${path}`);
    }
    const stored = await h.courses.findById("course-x");
    assert.equal(stored?.title, "Seeded");
    assert.equal(stored?.status, "Draft");
    assert.equal(h.courses.count, 1);
  });

  it("401 on all 7 routes for a forged or malformed token", async () => {
    for (const bad of ["not-a-jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.forged-signature"]) {
      for (const [method, path, body] of managementRoutes(nextSlug())) {
        const res = await send(method, path, body, bad);
        assert.equal(res.status, 401, `${bad.slice(0, 10)} ${method} ${path}`);
      }
    }
  });

  for (const role of ["student", "teacher"] as const) {
    it(`403 INSUFFICIENT_ROLE on all 7 routes for an authenticated ${role}; nothing written`, async () => {
      const { token } = await login(role);

      for (const [method, path, body] of managementRoutes(nextSlug())) {
        const res = await send(method, path, body, token);
        assert.equal(res.status, 403, `${role} ${method} ${path}`);
        assert.equal((await json(res))["error"], "INSUFFICIENT_ROLE");
      }
      assert.equal((await h.courses.findById("course-x"))?.status, "Draft");
      assert.equal(h.courses.count, 1);
    });
  }

  it("401 once the session is revoked, even with a still-valid token", async () => {
    const { token, userId, sessionId } = await login("admin");
    assert.equal((await send("GET", "/manage", undefined, token)).status, 200);

    await h.sessions.revokeSession({ sessionId, userId, reason: "logout" });
    assert.equal((await send("GET", "/manage", undefined, token)).status, 401);
  });

  it("authentication runs before authorization and validation", async () => {
    // Anonymous + invalid body -> 401 (not 422).
    assert.equal((await send("POST", "", { nonsense: true })).status, 401);

    // Authenticated student + invalid body -> 403 (not 422).
    const { token } = await login("student");
    assert.equal((await send("POST", "", { nonsense: true }, token)).status, 403);

    // Authenticated admin + invalid body -> now validation runs: 422.
    const admin = await login("admin");
    assert.equal((await send("POST", "", { nonsense: true }, admin.token)).status, 422);
  });

  it("role hints in headers or body are ignored - only the signed token counts", async () => {
    const { token } = await login("student");
    const res = await fetch(`${server.url}/api/v1/courses/course-x/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-User-Role": "admin" },
      body: JSON.stringify({ status: "Active", role: "admin" }),
    });
    assert.equal(res.status, 403);
  });

  describe("public catalogue is unchanged and never role-dependent", () => {
    beforeEach(async () => {
      seeded(h, { id: "course-pub", slug: "published-course", status: "Published", isPublished: true });
    });

    it("stays anonymous: list and detail answer without any token", async () => {
      assert.equal((await send("GET", "")).status, 200);
      assert.equal((await send("GET", "/published-course")).status, 200);
    });

    it("lists only published courses - the seeded draft is hidden", async () => {
      const body = await json(await send("GET", ""));
      const slugs = (body["data"] as { items: { slug: string }[] }).items.map((c) => c.slug);
      assert.deepEqual(slugs, ["published-course"]);
    });

    it("never exposes an unpublished course's detail - even to an admin token", async () => {
      const anonymous = await send("GET", "/seeded-course");
      assert.equal(anonymous.status, 404);

      // A valid admin token does NOT widen the public path: it is not
      // role-dependent (api-contracts section 7).
      const { token } = await login("admin");
      const withAdmin = await send("GET", "/seeded-course", undefined, token);
      assert.equal(withAdmin.status, 404);

      const listWithAdmin = await json(await send("GET", "", undefined, token));
      assert.deepEqual(
        (listWithAdmin["data"] as { items: { slug: string }[] }).items.map((c) => c.slug),
        ["published-course"],
      );
    });

    it("the admin path is where drafts are visible, to an authenticated admin only", async () => {
      const { token } = await login("admin");
      const body = await json(await send("GET", "/manage", undefined, token));
      assert.equal((body["data"] as { total: number }).total, 2);
    });
  });
});

// --- 5. REAL application, EMPTY container (production state) -------------------

describe("courses HTTP - production state (no adapters registered)", () => {
  let server: TestServer;

  before(async () => {
    server = await startServer(createApp({ container: createContainer({}) }));
  });

  after(async () => {
    await server.close();
  });

  it("boots: course routes resolve their dependencies lazily", async () => {
    assert.equal((await server.get("/api/v1/health")).status, 200);
  });

  it("401 on all 7 management routes without a token", async () => {
    for (const [method, path, body] of managementRoutes("prod-anon")) {
      const res = await fetch(`${server.url}/api/v1/courses${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      assert.equal(res.status, 401, `${method} ${path}`);
    }
  });

  it("503 SERVICE_UNAVAILABLE - never access - on all 7 routes when sessions cannot be checked", async () => {
    const { token } = issueAccessToken({ userId: "user-admin", role: "admin", sessionId: "s-unchecked" });

    for (const [method, path, body] of managementRoutes("prod-token")) {
      const res = await fetch(`${server.url}/api/v1/courses${path}`, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      assert.equal(res.status, 503, `${method} ${path}`);
      assert.equal((await json(res))["error"], "SERVICE_UNAVAILABLE", `${method} ${path}`);
    }
  });
});

// --- 6. explicit admin response mapping -------------------------------------------

/**
 * Every field a management response may carry: the contract's `Course`.
 * Written out HERE, independently of `toAdminCourse`, so the test fails if
 * the whitelist drifts in either direction.
 */
const PERMITTED_COURSE_FIELDS = [
  "id", "slug", "courseCode", "title", "shortDescription", "longDescription", "thumbnailUrl",
  "durationWeeks", "totalHours", "feeINR", "discountedFeeINR", "level", "category",
  "technologies", "modules", "isPublished", "status", "hasPlacementGuarantee",
  "prerequisites", "learningOutcomes", "eligibilityCriteria", "syllabusPdfUrl",
].sort();

const LEAK_PATTERN = /LEAKED|internalNotes|rowVersion|createdByUserId|storageKey|debugSql/;

/** A course with every permitted field set, plus internal fields at every level. */
const leakyCourse = (): Course => {
  const modules = tree("course-x") as unknown as Record<string, unknown>[];
  modules[0]!["internalNotes"] = "LEAKED-module";
  const chapter = (modules[0]!["chapters"] as Record<string, unknown>[])[0]!;
  chapter["rowVersion"] = "LEAKED-chapter";
  (chapter["lessons"] as Record<string, unknown>[])[0]!["storageKey"] = "s3://LEAKED/lesson";

  return {
    id: "course-x",
    slug: "leaky-course",
    courseCode: "CRS-LEAK-1",
    title: "Leaky",
    shortDescription: "Short",
    longDescription: "Long",
    thumbnailUrl: "https://cdn.test/t.png",
    durationWeeks: 10,
    totalHours: 100,
    feeINR: 1000,
    discountedFeeINR: 900,
    level: "Beginner",
    category: "Testing",
    technologies: ["TS"],
    modules: modules as unknown as CourseModule[],
    isPublished: false,
    status: "Draft",
    hasPlacementGuarantee: false,
    prerequisites: [],
    learningOutcomes: ["x"],
    eligibilityCriteria: ["Graduates"],
    syllabusPdfUrl: "https://cdn.test/s.pdf",
    // Internal / future columns an adapter might wrongly map:
    internalNotes: "LEAKED-course",
    rowVersion: "LEAKED-rv",
    createdByUserId: "LEAKED-user",
  } as unknown as Course;
};

describe("courses service - explicit admin response mapping", () => {
  const leakyRepo = (): CourseRepository => {
    const row = leakyCourse();
    return {
      findById: async () => row,
      findMany: async () => ({
        items: [row],
        total: 41,
        page: 3,
        pageSize: 20,
        totalPages: 3,
        debugSql: "SELECT * FROM Courses -- LEAKED",
      }),
      create: async () => row,
      update: async () => row,
      replaceCurriculum: async () => row,
      setPublication: async () => row,
    } as unknown as CourseRepository;
  };

  it("every management operation returns only contract fields - nothing internal at any depth", async () => {
    const service = createCourseService({ courses: leakyRepo() });

    const outputs: [string, Course][] = [
      ["getCourseById", await service.getCourseById("course-x")],
      ["createCourse", await service.createCourse(createBody({ slug: "mapped-create" }))],
      ["updateCourse", await service.updateCourse("course-x", { title: "x" })],
      ["replaceCurriculum", await service.replaceCurriculum("course-x", tree("course-x"))],
      ["setCourseStatus", await service.setCourseStatus("course-x", "Active")],
      ["togglePublish", await service.togglePublish("course-x")],
      ["listCourses item", (await service.listCourses(PAGE)).items[0]!],
    ];

    for (const [name, out] of outputs) {
      assert.deepEqual(Object.keys(out).sort(), PERMITTED_COURSE_FIELDS, name);
      assert.doesNotMatch(JSON.stringify(out), LEAK_PATTERN, name);
    }
  });

  it("keeps the full admin curriculum, including paid lesson content and status", async () => {
    const out = await createCourseService({ courses: leakyRepo() }).getCourseById("course-x");

    assert.equal(out.status, "Draft");
    assert.deepEqual(out.modules, tree("course-x"));
  });

  it("builds the page explicitly: extra adapter properties on the page object never leak", async () => {
    const page = await createCourseService({ courses: leakyRepo() }).listCourses({
      ...PAGE,
      page: 3,
      pageSize: 20,
    });

    assert.deepEqual(Object.keys(page).sort(), ["items", "page", "pageSize", "total", "totalPages"]);
    assert.equal(page.total, 41);
    assert.equal(page.page, 3);
    assert.equal(page.pageSize, 20);
    assert.equal(page.totalPages, 3); // ceil(41 / 20), derived by toPaginatedResult
    assert.doesNotMatch(JSON.stringify(page), LEAK_PATTERN);
  });

  it("over HTTP with real authentication, a stored internal field never reaches the client", async () => {
    const h = createTestHarness();
    h.courses.seed(leakyCourse()); // the fake stores the extra fields as given
    const server = await startServer(createApp({ container: h.container }));

    try {
      const refresh = generateRefreshToken();
      const session = await h.sessions.create({
        userId: "user-admin",
        refreshTokenHash: refresh.tokenHash,
        expiresAt: refresh.expiresAt,
      });
      const { token } = issueAccessToken({ userId: "user-admin", role: "admin", sessionId: session.sessionId });
      const headers = { Authorization: `Bearer ${token}` };

      for (const path of ["/api/v1/courses/manage/course-x", "/api/v1/courses/manage"]) {
        const res = await server.get(path, { headers });
        assert.equal(res.status, 200, path);
        assert.doesNotMatch(await res.text(), LEAK_PATTERN, path);
      }
    } finally {
      await server.close();
    }
  });
});
