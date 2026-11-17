import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app";
import { createContainer } from "../src/container/container";
import {
  createCourseService,
  isPubliclyVisible,
  toPublicCourse,
} from "../src/modules/courses/course.service";
import type { CourseRepository } from "../src/modules/courses/course.repository";
import type { Course, CourseModule } from "../src/modules/courses/course.types";
import { ApiError } from "../src/utils/api-error";
import { createTestHarness, type TestHarness } from "./fakes";
import { json, startServer, type TestServer } from "./helpers/server";

/**
 * Step 1 - Public Courses API.
 *
 *   GET /api/v1/courses        published catalogue
 *   GET /api/v1/courses/:slug  one published course
 *
 * The central guarantee under test: NOTHING unpublished, and no paid
 * lesson content, is reachable anonymously.
 */

// --- fixtures --------------------------------------------------------------

/** Two chapters' worth of lessons: one free preview, two paid. */
const curriculum = (courseId: string): CourseModule[] => [
  {
    id: `${courseId}-mod-1`,
    courseId,
    title: "Foundations",
    description: "Core syntax",
    order: 1,
    chapters: [
      {
        id: `${courseId}-ch-1`,
        moduleId: `${courseId}-mod-1`,
        title: "Getting started",
        order: 1,
        lessons: [
          {
            // Deliberately out of order, to prove the projection sorts.
            id: `${courseId}-l-2`,
            chapterId: `${courseId}-ch-1`,
            title: "Paid lesson",
            durationMinutes: 40,
            lessonType: "video",
            videoUrl: "https://cdn.test/paid.mp4",
            pdfUrl: "https://cdn.test/paid.pdf",
            studyMaterialText: "PAID MATERIAL",
            externalLinks: [{ title: "Paid link", url: "https://paid.test" }],
            isFreePreview: false,
            order: 2,
          },
          {
            id: `${courseId}-l-1`,
            chapterId: `${courseId}-ch-1`,
            title: "Free preview lesson",
            durationMinutes: 15,
            lessonType: "video",
            videoUrl: "https://cdn.test/preview.mp4",
            // Present on a FREE-PREVIEW lesson, yet still never public:
            // only videoUrl is approved for anonymous callers.
            pdfUrl: "https://cdn.test/preview-notes.pdf",
            studyMaterialText: "PREVIEW STUDY NOTES",
            externalLinks: [{ title: "Preview link", url: "https://preview-link.test" }],
            isFreePreview: true,
            order: 1,
          },
        ],
      },
    ],
  },
];

let seq = 0;

const course = (overrides: Partial<Course> = {}): Course => {
  seq += 1;
  const id = overrides.id ?? `course-${seq}`;

  return {
    id,
    slug: `course-${seq}`,
    courseCode: `CRS-${seq}`,
    title: `Course ${seq}`,
    shortDescription: "Short description",
    longDescription: "Long description",
    thumbnailUrl: "https://cdn.test/thumb.png",
    durationWeeks: 12,
    totalHours: 120,
    feeINR: 50000,
    level: "Beginner",
    category: "Software Development",
    technologies: ["TypeScript"],
    modules: curriculum(id),
    isPublished: true,
    status: "Published",
    hasPlacementGuarantee: false,
    prerequisites: [],
    learningOutcomes: ["Ship things"],
    ...overrides,
  };
};

/** Every lesson in a (public) course, flattened. */
const lessonsOf = (c: { modules: CourseModule[] }) =>
  c.modules.flatMap((m) => m.chapters.flatMap((ch) => ch.lessons));

// --- service (no HTTP) -----------------------------------------------------

describe("courses service - public catalogue", () => {
  let h: TestHarness;
  let service: ReturnType<typeof createCourseService>;

  const PAGE = { page: 1, pageSize: 10, sortOrder: "asc" } as const;

  beforeEach(() => {
    h = createTestHarness();
    service = createCourseService({ courses: h.courses });
  });

  describe("isPubliclyVisible", () => {
    it("accepts published courses in Published or Active status", () => {
      assert.equal(isPubliclyVisible(course({ status: "Published" })), true);
      assert.equal(isPubliclyVisible(course({ status: "Active" })), true);
    });

    it("accepts a published course with no status (legacy rows)", () => {
      const { status: _omit, ...noStatus } = course();
      assert.equal(isPubliclyVisible(noStatus), true);
    });

    it("rejects anything not flagged isPublished, whatever its status", () => {
      for (const status of ["Draft", "Published", "Active", "Inactive", "Archived"] as const) {
        assert.equal(isPubliclyVisible(course({ isPublished: false, status })), false, status);
      }
    });

    it("rejects Draft, Inactive and Archived even if isPublished is wrongly true", () => {
      // Defence in depth: a broken invariant must fail hidden, not leaked.
      for (const status of ["Draft", "Inactive", "Archived"] as const) {
        assert.equal(isPubliclyVisible(course({ isPublished: true, status })), false, status);
      }
    });
  });

  describe("listPublishedCourses", () => {
    it("returns only published courses", async () => {
      h.courses.seed(course({ slug: "live" }));
      h.courses.seed(course({ slug: "draft", isPublished: false, status: "Draft" }));
      h.courses.seed(course({ slug: "archived", isPublished: false, status: "Archived" }));

      const result = await service.listPublishedCourses(PAGE);

      assert.deepEqual(
        result.items.map((c) => c.slug),
        ["live"],
      );
      assert.equal(result.total, 1);
    });

    it("drops a row whose status contradicts isPublished", async () => {
      h.courses.seed(course({ slug: "ok" }));
      h.courses.seed(course({ slug: "corrupt", isPublished: true, status: "Archived" }));

      const result = await service.listPublishedCourses(PAGE);
      assert.deepEqual(
        result.items.map((c) => c.slug),
        ["ok"],
      );
    });

    it("passes category, level, placement and search filters through", async () => {
      h.courses.seed(
        course({ slug: "a", category: "Data & AI", level: "Advanced", hasPlacementGuarantee: true }),
      );
      h.courses.seed(course({ slug: "b", category: "Data & AI", level: "Beginner" }));
      h.courses.seed(course({ slug: "c", technologies: ["Kubernetes"] }));

      const byCategory = await service.listPublishedCourses({ ...PAGE, category: "Data & AI" });
      assert.deepEqual(byCategory.items.map((c) => c.slug).sort(), ["a", "b"]);

      const byLevel = await service.listPublishedCourses({ ...PAGE, level: "Advanced" });
      assert.deepEqual(byLevel.items.map((c) => c.slug), ["a"]);

      const byGuarantee = await service.listPublishedCourses({
        ...PAGE,
        hasPlacementGuarantee: false,
      });
      assert.deepEqual(byGuarantee.items.map((c) => c.slug).sort(), ["b", "c"]);

      const bySearch = await service.listPublishedCourses({ ...PAGE, search: "kubernetes" });
      assert.deepEqual(bySearch.items.map((c) => c.slug), ["c"]);
    });

    it("paginates in the frontend's PaginatedResult shape", async () => {
      for (let i = 0; i < 3; i += 1) h.courses.seed(course());

      const result = await service.listPublishedCourses({ ...PAGE, page: 2, pageSize: 2 });

      assert.equal(result.items.length, 1);
      assert.equal(result.total, 3);
      assert.equal(result.page, 2);
      assert.equal(result.pageSize, 2);
      assert.equal(result.totalPages, 2);
    });

    it("sorts by an allow-listed field in either direction", async () => {
      h.courses.seed(course({ slug: "b", title: "beta", feeINR: 300 }));
      h.courses.seed(course({ slug: "a", title: "Alpha", feeINR: 100 }));
      h.courses.seed(course({ slug: "c", title: "Gamma", feeINR: 200 }));

      const byTitle = await service.listPublishedCourses({ ...PAGE, sortBy: "title" });
      // Case-insensitive, like SQL Server's default collation.
      assert.deepEqual(byTitle.items.map((c) => c.slug), ["a", "b", "c"]);

      const byFeeDesc = await service.listPublishedCourses({
        ...PAGE,
        sortBy: "feeINR",
        sortOrder: "desc",
      });
      assert.deepEqual(byFeeDesc.items.map((c) => c.slug), ["b", "c", "a"]);
    });

    it("passes a typed sort to the repository and nothing for an unknown field", async () => {
      const calls: unknown[] = [];
      // Only findMany is exercised by the list path; any other call would
      // throw, which is itself a useful assertion.
      const recording: Pick<CourseRepository, "findMany"> = {
        findMany: async (filter, pagination, sort) => {
          calls.push(sort);
          return h.courses.findMany(filter, pagination, sort);
        },
      };
      const spy = createCourseService({ courses: recording as CourseRepository });

      await spy.listPublishedCourses({ ...PAGE, sortBy: "durationWeeks", sortOrder: "desc" });
      await spy.listPublishedCourses({ ...PAGE, sortBy: "title; DROP TABLE Courses--" });
      await spy.listPublishedCourses({ ...PAGE, sortBy: "isPublished" });
      await spy.listPublishedCourses(PAGE);

      assert.deepEqual(calls, [
        { field: "durationWeeks", order: "desc" },
        undefined,
        undefined,
        undefined,
      ]);
    });

    it("keeps a stable order across pages when sort keys tie", async () => {
      for (const slug of ["t1", "t2", "t3", "t4", "t5"]) {
        h.courses.seed(course({ slug, feeINR: 1000 }));
      }

      const seen: string[] = [];
      for (const page of [1, 2, 3]) {
        const r = await service.listPublishedCourses({
          ...PAGE,
          page,
          pageSize: 2,
          sortBy: "feeINR",
        });
        seen.push(...r.items.map((c) => c.slug));
      }

      // Every row exactly once - nothing repeated or skipped between pages.
      assert.deepEqual(seen, ["t1", "t2", "t3", "t4", "t5"]);
    });

    it("strips paid lesson content from list items too", async () => {
      h.courses.seed(course());
      const [item] = (await service.listPublishedCourses(PAGE)).items;
      assert.ok(item);

      const paid = lessonsOf(item).find((l) => !l.isFreePreview);
      assert.ok(paid);
      assert.equal(paid.videoUrl, undefined);
    });
  });

  describe("getPublishedCourseBySlug", () => {
    it("returns a published course", async () => {
      h.courses.seed(course({ slug: "java-full-stack", title: "Java" }));

      const result = await service.getPublishedCourseBySlug("java-full-stack");
      assert.equal(result.title, "Java");
    });

    it("throws 404 for a missing slug", async () => {
      await assert.rejects(
        service.getPublishedCourseBySlug("nope"),
        (err: unknown) => err instanceof ApiError && err.status === 404,
      );
    });

    it("throws the SAME 404 for an unpublished course (no existence leak)", async () => {
      h.courses.seed(course({ slug: "secret-draft", isPublished: false, status: "Draft" }));

      const missing = await service.getPublishedCourseBySlug("nope").catch((e: unknown) => e);
      const draft = await service.getPublishedCourseBySlug("secret-draft").catch((e: unknown) => e);

      assert.ok(missing instanceof ApiError && draft instanceof ApiError);
      assert.equal(draft.status, 404);
      assert.equal(draft.message, missing.message);
      assert.equal(draft.code, missing.code);
    });

    it("hides Inactive and Archived courses", async () => {
      h.courses.seed(course({ slug: "inactive", isPublished: false, status: "Inactive" }));
      h.courses.seed(course({ slug: "archived", isPublished: true, status: "Archived" }));

      for (const slug of ["inactive", "archived"]) {
        await assert.rejects(
          service.getPublishedCourseBySlug(slug),
          (err: unknown) => err instanceof ApiError && err.status === 404,
        );
      }
    });
  });

  describe("toPublicCourse projection", () => {
    it("removes content from paid lessons but keeps their outline (BR-003)", () => {
      const pub = toPublicCourse(course({ id: "c1" }));
      const paid = lessonsOf(pub).find((l) => l.id === "c1-l-2");

      assert.ok(paid);
      assert.equal(paid.title, "Paid lesson");
      assert.equal(paid.durationMinutes, 40);
      assert.equal(paid.isFreePreview, false);
      assert.equal(paid.videoUrl, undefined);
      assert.equal(paid.pdfUrl, undefined);
      assert.equal(paid.studyMaterialText, undefined);
      assert.equal(paid.externalLinks, undefined);

      // And the paid strings appear nowhere in the serialised output.
      const wire = JSON.stringify(pub);
      assert.doesNotMatch(wire, /paid\.mp4|paid\.pdf|PAID MATERIAL|paid\.test/);
    });

    it("exposes ONLY videoUrl on free-preview lessons (approved rule)", () => {
      const pub = toPublicCourse(course({ id: "c1" }));
      const preview = lessonsOf(pub).find((l) => l.id === "c1-l-1") as
        | Record<string, unknown>
        | undefined;

      assert.ok(preview);
      assert.equal(preview["videoUrl"], "https://cdn.test/preview.mp4");
      assert.equal("pdfUrl" in preview, false);
      assert.equal("studyMaterialText" in preview, false);
      assert.equal("externalLinks" in preview, false);

      const wire = JSON.stringify(pub);
      assert.doesNotMatch(wire, /preview-notes\.pdf|PREVIEW STUDY NOTES|preview-link\.test/);
    });

    it("emits no videoUrl key for a free-preview lesson that has no video", () => {
      const c = course({ id: "c1" });
      const lesson = c.modules[0]?.chapters[0]?.lessons.find((l) => l.isFreePreview);
      assert.ok(lesson);
      delete lesson.videoUrl;

      const out = lessonsOf(toPublicCourse(c)).find((l) => l.id === lesson.id);
      assert.ok(out);
      assert.equal("videoUrl" in out, false);
    });

    it("treats a non-boolean isFreePreview as NOT a preview (fails closed)", () => {
      const c = course({ id: "c1" });
      const lesson = c.modules[0]?.chapters[0]?.lessons.find((l) => l.isFreePreview);
      assert.ok(lesson);
      // Simulates a garbled value from an adapter.
      (lesson as unknown as Record<string, unknown>)["isFreePreview"] = "true";

      const out = lessonsOf(toPublicCourse(c)).find((l) => l.id === lesson.id);
      assert.equal(out?.videoUrl, undefined);
      // Normalised: the emitted flag is a real boolean, not the garbled string.
      assert.equal(out?.isFreePreview, false);
    });

    it("omits status and always reports isPublished: true", () => {
      const pub = toPublicCourse(course({ status: "Active" }));
      assert.equal("status" in pub, false);
      assert.equal(pub.isPublished, true);
    });

    it("is a whitelist: unknown fields from the repository never leak", () => {
      const c = course() as Course & Record<string, unknown>;
      c["internalNotes"] = "do not publish";
      const lesson = c.modules[0]?.chapters[0]?.lessons[0] as unknown as Record<string, unknown>;
      lesson["storageKey"] = "s3://private/key";

      const wire = JSON.stringify(toPublicCourse(c));
      assert.doesNotMatch(wire, /internalNotes|do not publish|storageKey|s3:\/\/private/);
    });

    it("sorts lessons by their order field", () => {
      const pub = toPublicCourse(course({ id: "c1" }));
      assert.deepEqual(
        lessonsOf(pub).map((l) => l.order),
        [1, 2],
      );
    });

    it("does not mutate the source course", () => {
      const c = course();
      const before = structuredClone(c);
      toPublicCourse(c);
      assert.deepEqual(c, before);
    });
  });
});

// --- HTTP (the real app over in-memory fakes) ------------------------------

describe("courses HTTP - public endpoints", () => {
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
  });

  describe("GET /api/v1/courses", () => {
    it("is anonymous and returns the paginated success envelope", async () => {
      h.courses.seed(course({ slug: "live" }));

      const res = await server.get("/api/v1/courses");
      assert.equal(res.status, 200);

      const body = await json(res);
      assert.equal(body["success"], true);

      const data = body["data"] as Record<string, unknown>;
      assert.deepEqual(Object.keys(data).sort(), [
        "items",
        "page",
        "pageSize",
        "total",
        "totalPages",
      ]);
      assert.equal(data["page"], 1);
      assert.equal(data["pageSize"], 10);
    });

    it("never lists unpublished courses", async () => {
      h.courses.seed(course({ slug: "live" }));
      h.courses.seed(course({ slug: "hidden-draft", isPublished: false, status: "Draft" }));
      h.courses.seed(course({ slug: "hidden-inactive", isPublished: false, status: "Inactive" }));

      const body = await json(await server.get("/api/v1/courses?pageSize=100"));
      const items = (body["data"] as { items: { slug: string }[] }).items;

      assert.deepEqual(
        items.map((c) => c.slug),
        ["live"],
      );
    });

    it("ignores caller attempts to widen visibility", async () => {
      h.courses.seed(course({ slug: "hidden-draft", isPublished: false, status: "Draft" }));

      const res = await server.get(
        "/api/v1/courses?publishedOnly=false&status=Draft&isPublished=false",
      );
      assert.equal(res.status, 200);
      assert.equal((((await json(res))["data"]) as { total: number }).total, 0);
    });

    it("applies typed filters from the query string", async () => {
      h.courses.seed(course({ slug: "ai", category: "Data & AI", hasPlacementGuarantee: true }));
      h.courses.seed(course({ slug: "dev" }));

      const body = await json(
        await server.get("/api/v1/courses?category=Data%20%26%20AI&hasPlacementGuarantee=true"),
      );
      const items = (body["data"] as { items: { slug: string }[] }).items;
      assert.deepEqual(
        items.map((c) => c.slug),
        ["ai"],
      );
    });

    it("treats hasPlacementGuarantee=false as false, not truthy", async () => {
      h.courses.seed(course({ slug: "guaranteed", hasPlacementGuarantee: true }));
      h.courses.seed(course({ slug: "plain", hasPlacementGuarantee: false }));

      const body = await json(await server.get("/api/v1/courses?hasPlacementGuarantee=false"));
      const items = (body["data"] as { items: { slug: string }[] }).items;
      assert.deepEqual(
        items.map((c) => c.slug),
        ["plain"],
      );
    });

    it("rejects invalid filters with 422 and field details", async () => {
      const cases = [
        ["category=Astrology", "category"],
        ["level=Expert", "level"],
        ["hasPlacementGuarantee=yes", "hasPlacementGuarantee"],
        ["pageSize=9999", "pageSize"],
        ["page=0", "page"],
      ] as const;

      for (const [qs, field] of cases) {
        const res = await server.get(`/api/v1/courses?${qs}`);
        assert.equal(res.status, 422, qs);

        const body = await json(res);
        assert.equal(body["error"], "VALIDATION_ERROR", qs);
        const details = body["details"] as { field: string }[];
        assert.ok(
          details.some((d) => d.field === field),
          `${qs} should report ${field}`,
        );
      }
    });

    it("ignores unknown params (forward compatible)", async () => {
      h.courses.seed(course());
      const res = await server.get("/api/v1/courses?foo=bar&unknown=1");
      assert.equal(res.status, 200);
    });

    it("sorts via sortBy and sortOrder (api-contracts 3.6)", async () => {
      h.courses.seed(course({ slug: "mid", totalHours: 200 }));
      h.courses.seed(course({ slug: "low", totalHours: 100 }));
      h.courses.seed(course({ slug: "high", totalHours: 300 }));

      const slugsFor = async (qs: string) => {
        const body = await json(await server.get(`/api/v1/courses?${qs}`));
        return (body["data"] as { items: { slug: string }[] }).items.map((c) => c.slug);
      };

      assert.deepEqual(await slugsFor("sortBy=totalHours"), ["low", "mid", "high"]);
      assert.deepEqual(await slugsFor("sortBy=totalHours&sortOrder=desc"), ["high", "mid", "low"]);
    });

    it("falls back to the default order for a non-allow-listed sortBy (3.8)", async () => {
      h.courses.seed(course({ slug: "first", title: "Zulu" }));
      h.courses.seed(course({ slug: "second", title: "Alpha" }));

      const res = await server.get("/api/v1/courses?sortBy=title;DROP%20TABLE%20Courses--");
      assert.equal(res.status, 200);

      const items = ((await json(res))["data"] as { items: { slug: string }[] }).items;
      // Insertion (default) order, NOT title order: the hostile value was dropped.
      assert.deepEqual(
        items.map((c) => c.slug),
        ["first", "second"],
      );
    });

    it("rejects an invalid sortOrder with 422 (3.6)", async () => {
      const res = await server.get("/api/v1/courses?sortBy=title&sortOrder=sideways");
      assert.equal(res.status, 422);

      const body = await json(res);
      assert.equal(body["error"], "VALIDATION_ERROR");
      assert.ok((body["details"] as { field: string }[]).some((d) => d.field === "sortOrder"));
    });

    it("does not ship paid lesson content", async () => {
      h.courses.seed(course());
      const res = await server.get("/api/v1/courses");
      assert.doesNotMatch(await res.text(), /paid\.mp4|PAID MATERIAL/);
    });
  });

  describe("GET /api/v1/courses/:slug", () => {
    it("returns a published course anonymously", async () => {
      h.courses.seed(course({ slug: "java-full-stack", title: "Java Full Stack" }));

      const res = await server.get("/api/v1/courses/java-full-stack");
      assert.equal(res.status, 200);

      const body = await json(res);
      assert.equal(body["success"], true);
      const data = body["data"] as Record<string, unknown>;
      assert.equal(data["title"], "Java Full Stack");
      assert.equal(data["isPublished"], true);
      assert.equal("status" in data, false);
    });

    it("matches slugs case-insensitively (Q17 normalisation)", async () => {
      h.courses.seed(course({ slug: "java-full-stack" }));
      const res = await server.get("/api/v1/courses/Java-Full-Stack");
      assert.equal(res.status, 200);
    });

    it("returns an identical 404 for missing and unpublished courses", async () => {
      h.courses.seed(course({ slug: "secret-draft", isPublished: false, status: "Draft" }));

      const missing = await server.get("/api/v1/courses/does-not-exist");
      const draft = await server.get("/api/v1/courses/secret-draft");

      assert.equal(missing.status, 404);
      assert.equal(draft.status, 404);

      const strip = (b: Record<string, unknown>) => {
        const { requestId: _r, ...rest } = b;
        return rest;
      };
      assert.deepEqual(strip(await json(draft)), strip(await json(missing)));
    });

    it("hides archived courses", async () => {
      h.courses.seed(course({ slug: "old-course", isPublished: false, status: "Archived" }));
      assert.equal((await server.get("/api/v1/courses/old-course")).status, 404);
    });

    it("rejects a malformed slug with 422", async () => {
      for (const bad of ["bad_slug", "has%20space", "trailing-", "a--b"]) {
        const res = await server.get(`/api/v1/courses/${bad}`);
        assert.equal(res.status, 422, bad);
        assert.equal((await json(res))["error"], "VALIDATION_ERROR", bad);
      }
    });

    it("serves only the free-preview videoUrl - no paid or non-video content", async () => {
      h.courses.seed(course({ slug: "with-preview" }));

      const text = await (await server.get("/api/v1/courses/with-preview")).text();
      assert.match(text, /preview\.mp4/);
      assert.doesNotMatch(text, /paid\.mp4|paid\.pdf|PAID MATERIAL|paid\.test/);
      assert.doesNotMatch(text, /preview-notes\.pdf|PREVIEW STUDY NOTES|preview-link\.test/);
      assert.doesNotMatch(text, /"pdfUrl"|"studyMaterialText"|"externalLinks"/);
    });
  });

  // Step 1 asserted these were 404 (no management surface). Step 2A added
  // the admin-only management routes, so the guarantee is now: they exist,
  // and anonymous callers are refused with 401. Full coverage lives in
  // tests/courses.manage.test.ts.
  describe("management surface is protected (Step 2A)", () => {
    it("refuses anonymous writes on /courses with 401", async () => {
      const post = await server.post("/api/v1/courses", { title: "x" });
      assert.equal(post.status, 401);

      const patch = await fetch(`${server.url}/api/v1/courses/some-course`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      assert.equal(patch.status, 401);
    });
  });
});

describe("courses HTTP - production container (no adapters registered)", () => {
  let server: TestServer;

  before(async () => {
    // Same wiring as production: an empty container.
    server = await startServer(createApp({ container: createContainer({}) }));
  });

  after(async () => {
    await server.close();
  });

  it("still boots and serves health - course routes resolve lazily", async () => {
    assert.equal((await server.get("/api/v1/health")).status, 200);
  });

  it("fails a course request cleanly through the error pipeline", async () => {
    const res = await server.get("/api/v1/courses");
    assert.equal(res.status, 500);

    const body = await json(res);
    assert.equal(body["success"], false);
    assert.equal(body["error"], "INTERNAL_SERVER_ERROR");
  });
});
