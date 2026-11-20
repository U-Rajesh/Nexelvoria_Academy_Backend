import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { EntityId } from "../../src/contracts/identifier.contract";
import type { CourseRepository } from "../../src/modules/courses/course.repository";
import type {
  Course,
  CourseModule,
  CourseSort,
  CreateCourseInput,
} from "../../src/modules/courses/course.types";
import {
  DuplicateRecordError,
  RecordNotFoundError,
  RepositoryError,
} from "../../src/repositories/repository.errors";

/**
 * CourseRepository CONTRACT TESTS - implementation-agnostic.
 *
 * Every test exercises the public `CourseRepository` port only, so the same
 * suite runs against the in-memory fake today and a SQL Server adapter
 * later:
 *
 *   describeCourseRepositoryContract("SqlServerCourseRepository", makeSqlFixture);
 *
 * No direct-insert hook is needed: `Course` has no server-set timestamp, so
 * every sorted or filtered field is settable through `create()`, and
 * publication state through `setPublication()`.
 *
 * DELIBERATELY NOT ASSERTED (undocumented or undecided - see the inspection
 * report): a specific default order when `sort` is omitted (only
 * determinism and stable paging); the CASING a slug is stored in; curriculum
 * array POSITION (compared by the documented `order` field only); how
 * `publishedOnly` treats a contradictory `status`; publication changes via
 * `update()`; accent/locale collation (ASCII only).
 *
 * Not a test file itself (`npm test` runs `tests/*.test.ts` only);
 * `tests/course-repository.contract.test.ts` invokes it.
 */

/** What an implementation must provide. Setup lives here, never in assertions. */
export interface CourseRepositoryFixture {
  /** The implementation under test. */
  repository: CourseRepository;
  /** Restores an empty state. SQL: truncate or roll back the test transaction. */
  reset(): Promise<void>;
  /** The implementation's real `id ASC` order (numeric-aware for sequential keys). */
  compareIds(a: EntityId, b: EntityId): number;
}

export type CourseRepositoryFixtureFactory = () => Promise<CourseRepositoryFixture>;

const PAGE = { page: 1, pageSize: 50 } as const;

export const describeCourseRepositoryContract = (
  label: string,
  makeFixture: CourseRepositoryFixtureFactory,
): void => {
  describe(`CourseRepository contract: ${label}`, () => {
    let fx: CourseRepositoryFixture;
    let repo: CourseRepository;

    // Unique per run and per call, so the suite also works on a shared
    // database. Lowercase hex + digits + hyphens = a valid slug.
    const run = randomUUID().slice(0, 8);
    let counter = 0;
    const tag = (): string => `${run}-${(counter += 1)}`;
    const uniqueSlug = (prefix = "course"): string => `${prefix}-${tag()}`;
    const missingId = (): EntityId => `missing-${randomUUID()}`;

    const createInput = (overrides: Partial<CreateCourseInput> = {}): CreateCourseInput => ({
      slug: uniqueSlug(),
      title: `Course ${tag()}`,
      shortDescription: "Contract short description",
      longDescription: "Contract long description",
      thumbnailUrl: "https://cdn.contract.test/thumb.png",
      durationWeeks: 12,
      totalHours: 120,
      feeINR: 50000,
      level: "Beginner",
      category: "Software Development",
      technologies: ["TypeScript"],
      hasPlacementGuarantee: false,
      prerequisites: [],
      learningOutcomes: ["Ship things"],
      ...overrides,
    });

    /** A two-module curriculum with unique client-supplied ids (Q1). */
    const curriculum = (courseId: EntityId) => {
      const m1 = `mod-${tag()}`;
      const m2 = `mod-${tag()}`;
      const c1 = `chap-${tag()}`;
      const c2 = `chap-${tag()}`;
      const firstLesson = `les-${tag()}`;
      const nestedLesson = `les-${tag()}`;

      const modules: CourseModule[] = [
        {
          id: m1,
          courseId,
          title: "Module 1",
          description: "",
          order: 1,
          chapters: [
            {
              id: c1,
              moduleId: m1,
              title: "Chapter 1",
              order: 1,
              lessons: [
                { id: firstLesson, chapterId: c1, title: "First", durationMinutes: 10, isFreePreview: true, order: 1 },
              ],
            },
          ],
        },
        {
          id: m2,
          courseId,
          title: "Module 2",
          description: "Second module",
          order: 2,
          chapters: [
            {
              id: c2,
              moduleId: m2,
              title: "Chapter 2",
              description: "Has every optional lesson field",
              order: 1,
              lessons: [
                {
                  id: nestedLesson,
                  chapterId: c2,
                  title: "Nested",
                  durationMinutes: 25,
                  lessonType: "video",
                  videoUrl: "https://cdn.contract.test/v.mp4",
                  pdfUrl: "https://cdn.contract.test/n.pdf",
                  studyMaterialText: "Notes",
                  externalLinks: [{ title: "Docs", url: "https://docs.contract.test" }],
                  isFreePreview: false,
                  order: 1,
                  isLocked: true,
                  isDownloadRestricted: true,
                },
              ],
            },
          ],
        },
      ];

      return { modules, firstLesson, nestedLesson };
    };

    /** Curriculum compared by the documented `order` field, never by position. */
    const byOrder = <T extends { order: number }>(list: T[]): T[] =>
      [...list].sort((a, b) => a.order - b.order);
    const moduleIds = (course: Course | null): EntityId[] =>
      byOrder(course?.modules ?? []).map((m) => m.id);

    const ids = (courses: { id: EntityId }[]): EntityId[] => courses.map((c) => c.id);
    const sortedIds = (list: EntityId[]): EntityId[] => [...list].sort(fx.compareIds);
    const list = async (sort?: CourseSort, filter = {}) =>
      ids((await repo.findMany(filter, PAGE, sort)).items);

    beforeEach(async () => {
      fx = await makeFixture();
      await fx.reset();
      repo = fx.repository;
    });

    afterEach(async () => {
      await fx.reset();
    });

    // --- findById / findBySlug / existsBySlug -------------------------------------

    describe("findById", () => {
      it("returns a created course with its stored fields", async () => {
        const input = createInput({
          courseCode: "CRS-CONTRACT-1",
          discountedFeeINR: 40000,
          eligibilityCriteria: ["Graduates"],
          syllabusPdfUrl: "https://cdn.contract.test/s.pdf",
          technologies: ["Java", "Spring"],
        });
        const created = await repo.create(input);

        const found = await repo.findById(created.id);
        assert.ok(found);
        assert.equal(found.id, created.id);
        assert.equal(found.title, input.title);
        assert.equal(found.feeINR, input.feeINR);
        assert.equal(found.discountedFeeINR, input.discountedFeeINR);
        assert.equal(found.courseCode, input.courseCode);
        assert.equal(found.level, input.level);
        assert.equal(found.category, input.category);
        assert.deepEqual(found.technologies, input.technologies);
        assert.deepEqual(found.eligibilityCriteria, input.eligibilityCriteria);
        assert.equal(found.syllabusPdfUrl, input.syllabusPdfUrl);
      });

      it("returns null - not a throw - for an unknown id", async () => {
        assert.equal(await repo.findById(missingId()), null);
      });

      it("returns a detached copy, including the nested curriculum", async () => {
        const created = await repo.create(createInput());
        const { modules } = curriculum(created.id);
        await repo.replaceCurriculum(created.id, modules);

        const first = await repo.findById(created.id);
        assert.ok(first);
        first.title = "MUTATED";
        first.technologies.push("mutated");
        first.modules[0]!.chapters[0]!.lessons[0]!.title = "MUTATED LESSON";
        first.modules.length = 0;

        const again = await repo.findById(created.id);
        assert.equal(again?.title, created.title);
        assert.deepEqual(again?.technologies, created.technologies);
        assert.equal(again?.modules.length, 2);
        const lesson = byOrder(again!.modules)[0]!.chapters[0]!.lessons[0]!;
        assert.equal(lesson.title, "First");
      });
    });

    describe("findBySlug", () => {
      it("finds a course by exact slug", async () => {
        const created = await repo.create(createInput());
        assert.equal((await repo.findBySlug(created.slug))?.id, created.id);
      });

      it("is case-insensitive (ASCII)", async () => {
        const created = await repo.create(createInput());
        assert.equal((await repo.findBySlug(created.slug.toUpperCase()))?.id, created.id);
      });

      it("returns null when no course has the slug", async () => {
        assert.equal(await repo.findBySlug(uniqueSlug("absent")), null);
      });

      it("returns a detached copy", async () => {
        const created = await repo.create(createInput());
        const found = await repo.findBySlug(created.slug);
        assert.ok(found);
        found.title = "MUTATED";
        assert.equal((await repo.findById(created.id))?.title, created.title);
      });
    });

    describe("existsBySlug", () => {
      it("is true for an existing slug, in any ASCII case", async () => {
        const created = await repo.create(createInput());
        assert.equal(await repo.existsBySlug(created.slug), true);
        assert.equal(await repo.existsBySlug(created.slug.toUpperCase()), true);
      });

      it("is false for an unknown slug", async () => {
        assert.equal(await repo.existsBySlug(uniqueSlug("absent")), false);
      });
    });

    // --- create ----------------------------------------------------------------------

    describe("create", () => {
      it("assigns a distinct id to each course", async () => {
        const a = await repo.create(createInput());
        const b = await repo.create(createInput());
        assert.equal(typeof a.id, "string");
        assert.ok(a.id.length > 0);
        assert.notEqual(a.id, b.id);
      });

      it("creates an unpublished Draft with an empty curriculum (documented)", async () => {
        const created = await repo.create(createInput());
        assert.equal(created.status, "Draft");
        assert.equal(created.isPublished, false);
        assert.deepEqual(created.modules, []);

        const stored = await repo.findById(created.id);
        assert.equal(stored?.status, "Draft");
        assert.equal(stored?.isPublished, false);
        assert.deepEqual(stored?.modules, []);
      });

      it("rejects a duplicate slug with DuplicateRecordError on field 'slug'", async () => {
        const input = createInput();
        await repo.create(input);

        await assert.rejects(repo.create(createInput({ slug: input.slug })), (err: unknown) => {
          assert.ok(err instanceof DuplicateRecordError);
          assert.ok(err instanceof RepositoryError);
          assert.equal(err.field, "slug");
          return true;
        });
      });

      it("treats slugs differing only in ASCII case as duplicates", async () => {
        const input = createInput();
        await repo.create(input);
        await assert.rejects(
          repo.create(createInput({ slug: input.slug.toUpperCase() })),
          DuplicateRecordError,
        );
      });

      it("a rejected duplicate writes nothing", async () => {
        const input = createInput();
        await repo.create(input);
        const before = (await repo.findMany({}, PAGE)).total;

        await assert.rejects(repo.create(createInput({ slug: input.slug })), DuplicateRecordError);
        assert.equal((await repo.findMany({}, PAGE)).total, before);
      });

      it("is mutation-safe: changing the input or result afterwards does not change the store", async () => {
        const input = createInput({ technologies: ["Go"] });
        const created = await repo.create(input);

        input.title = "MUTATED INPUT";
        input.technologies.push("mutated-input");
        created.title = "MUTATED RESULT";
        created.technologies.push("mutated-result");

        const stored = await repo.findById(created.id);
        assert.notEqual(stored?.title, "MUTATED INPUT");
        assert.notEqual(stored?.title, "MUTATED RESULT");
        assert.deepEqual(stored?.technologies, ["Go"]);
      });
    });

    // --- update ----------------------------------------------------------------------

    describe("update", () => {
      it("changes only the given metadata fields and returns the updated course", async () => {
        const created = await repo.create(createInput());

        const updated = await repo.update(created.id, { title: "Renamed", feeINR: 1234 });

        assert.equal(updated.id, created.id);
        assert.equal(updated.title, "Renamed");
        assert.equal(updated.feeINR, 1234);
        assert.equal(updated.slug, created.slug);
        assert.equal(updated.durationWeeks, created.durationWeeks);
        // Publication fields are not passed, so they must be untouched.
        assert.equal(updated.status, created.status);
        assert.equal(updated.isPublished, created.isPublished);
      });

      it("persists the change and leaves the curriculum alone", async () => {
        const created = await repo.create(createInput());
        const { modules } = curriculum(created.id);
        await repo.replaceCurriculum(created.id, modules);

        await repo.update(created.id, { shortDescription: "Updated short" });

        const stored = await repo.findById(created.id);
        assert.equal(stored?.shortDescription, "Updated short");
        assert.deepEqual(moduleIds(stored), moduleIds({ ...created, modules }));
      });

      it("throws RecordNotFoundError (with the id) for an unknown course", async () => {
        const id = missingId();
        await assert.rejects(repo.update(id, { title: "x" }), (err: unknown) => {
          assert.ok(err instanceof RecordNotFoundError);
          assert.equal(err.id, id);
          return true;
        });
      });

      it("returns a detached copy", async () => {
        const created = await repo.create(createInput());
        const updated = await repo.update(created.id, { title: "Kept" });
        updated.title = "MUTATED";
        assert.equal((await repo.findById(created.id))?.title, "Kept");
      });
    });

    // --- replaceCurriculum ---------------------------------------------------------------

    describe("replaceCurriculum", () => {
      it("replaces the whole tree - old modules are gone, not merged", async () => {
        const created = await repo.create(createInput());
        const first = curriculum(created.id);
        await repo.replaceCurriculum(created.id, first.modules);

        const second = curriculum(created.id);
        const replacement = [second.modules[0]!];
        const out = await repo.replaceCurriculum(created.id, replacement);

        assert.deepEqual(moduleIds(out), [replacement[0]!.id]);
        const stored = await repo.findById(created.id);
        assert.deepEqual(moduleIds(stored), [replacement[0]!.id]);
        for (const old of first.modules) {
          assert.equal(moduleIds(stored).includes(old.id), false);
        }
      });

      it("an empty array clears the curriculum", async () => {
        const created = await repo.create(createInput());
        await repo.replaceCurriculum(created.id, curriculum(created.id).modules);

        const out = await repo.replaceCurriculum(created.id, []);
        assert.deepEqual(out.modules, []);
        assert.deepEqual((await repo.findById(created.id))?.modules, []);
      });

      it("round-trips every optional chapter and lesson field", async () => {
        const created = await repo.create(createInput());
        const { modules } = curriculum(created.id);
        await repo.replaceCurriculum(created.id, modules);

        const stored = await repo.findById(created.id);
        const module2 = byOrder(stored!.modules)[1]!;
        const chapter = byOrder(module2.chapters)[0]!;
        const lesson = byOrder(chapter.lessons)[0]!;
        const expected = modules[1]!.chapters[0]!;

        assert.equal(chapter.description, expected.description);
        assert.deepEqual(lesson, expected.lessons[0]);
      });

      it("is mutation-safe: changing the input tree afterwards does not change the store", async () => {
        const created = await repo.create(createInput());
        const { modules } = curriculum(created.id);
        await repo.replaceCurriculum(created.id, modules);

        modules[0]!.title = "MUTATED";
        modules[0]!.chapters[0]!.lessons.length = 0;
        modules.pop();

        const stored = await repo.findById(created.id);
        assert.equal(stored?.modules.length, 2);
        const m1 = byOrder(stored!.modules)[0]!;
        assert.equal(m1.title, "Module 1");
        assert.equal(m1.chapters[0]!.lessons.length, 1);
      });

      it("throws RecordNotFoundError for an unknown course", async () => {
        await assert.rejects(repo.replaceCurriculum(missingId(), []), RecordNotFoundError);
      });
    });

    // --- setPublication -------------------------------------------------------------------

    describe("setPublication", () => {
      it("writes both supplied values and returns the updated course", async () => {
        const created = await repo.create(createInput());

        const out = await repo.setPublication(created.id, { status: "Published", isPublished: true });
        assert.equal(out.status, "Published");
        assert.equal(out.isPublished, true);

        const stored = await repo.findById(created.id);
        assert.equal(stored?.status, "Published");
        assert.equal(stored?.isPublished, true);
      });

      it("stores a contradictory pair EXACTLY as given - it never re-derives either value", async () => {
        const created = await repo.create(createInput());

        for (const change of [
          { status: "Archived", isPublished: true },
          { status: "Published", isPublished: false },
          { status: "Active", isPublished: false },
          { status: "Draft", isPublished: true },
        ] as const) {
          await repo.setPublication(created.id, change);
          const stored = await repo.findById(created.id);
          assert.equal(stored?.status, change.status, JSON.stringify(change));
          assert.equal(stored?.isPublished, change.isPublished, JSON.stringify(change));
        }
      });

      it("leaves every other field untouched", async () => {
        const created = await repo.create(createInput());
        const { modules } = curriculum(created.id);
        await repo.replaceCurriculum(created.id, modules);

        await repo.setPublication(created.id, { status: "Active", isPublished: true });

        const stored = await repo.findById(created.id);
        assert.equal(stored?.title, created.title);
        assert.equal(stored?.slug, created.slug);
        assert.equal(stored?.feeINR, created.feeINR);
        assert.equal(stored?.modules.length, 2);
      });

      it("throws RecordNotFoundError for an unknown course", async () => {
        await assert.rejects(
          repo.setPublication(missingId(), { status: "Draft", isPublished: false }),
          RecordNotFoundError,
        );
      });
    });

    // --- deprecated single-field writes (kept for backward compatibility) -------------------

    describe("setStatus (deprecated)", () => {
      it("writes status only - isPublished is unchanged", async () => {
        const created = await repo.create(createInput());
        await repo.setPublication(created.id, { status: "Published", isPublished: true });

        const out = await repo.setStatus(created.id, "Archived");
        assert.equal(out.status, "Archived");
        assert.equal(out.isPublished, true);
        assert.equal((await repo.findById(created.id))?.status, "Archived");
      });

      it("throws RecordNotFoundError for an unknown course", async () => {
        await assert.rejects(repo.setStatus(missingId(), "Draft"), RecordNotFoundError);
      });
    });

    describe("setPublished (deprecated)", () => {
      it("writes isPublished only - status is unchanged", async () => {
        const created = await repo.create(createInput());

        const out = await repo.setPublished(created.id, true);
        assert.equal(out.isPublished, true);
        assert.equal(out.status, created.status);
        assert.equal((await repo.findById(created.id))?.isPublished, true);
      });

      it("throws RecordNotFoundError for an unknown course", async () => {
        await assert.rejects(repo.setPublished(missingId(), true), RecordNotFoundError);
      });
    });

    // --- findLessonById ----------------------------------------------------------------------

    describe("findLessonById", () => {
      it("finds lessons anywhere in the tree, including a later module and chapter", async () => {
        const created = await repo.create(createInput());
        const { modules, firstLesson, nestedLesson } = curriculum(created.id);
        await repo.replaceCurriculum(created.id, modules);

        const first = await repo.findLessonById(created.id, firstLesson);
        assert.equal(first?.lesson.id, firstLesson);
        assert.equal(first?.lesson.title, "First");
        assert.equal(first?.lesson.isFreePreview, true);

        const nested = await repo.findLessonById(created.id, nestedLesson);
        assert.equal(nested?.lesson.id, nestedLesson);
        assert.equal(nested?.lesson.title, "Nested");
      });

      it("returns null for an unknown course or an unknown lesson", async () => {
        const created = await repo.create(createInput());
        const { modules, firstLesson } = curriculum(created.id);
        await repo.replaceCurriculum(created.id, modules);

        assert.equal(await repo.findLessonById(missingId(), firstLesson), null);
        assert.equal(await repo.findLessonById(created.id, `les-missing-${tag()}`), null);
      });

      it("no longer finds a lesson removed by a curriculum replace", async () => {
        const created = await repo.create(createInput());
        const { modules, firstLesson } = curriculum(created.id);
        await repo.replaceCurriculum(created.id, modules);
        await repo.replaceCurriculum(created.id, []);

        assert.equal(await repo.findLessonById(created.id, firstLesson), null);
      });

      it("returns a detached lesson", async () => {
        const created = await repo.create(createInput());
        const { modules, firstLesson } = curriculum(created.id);
        await repo.replaceCurriculum(created.id, modules);

        const found = await repo.findLessonById(created.id, firstLesson);
        assert.ok(found);
        found.lesson.title = "MUTATED";

        assert.equal((await repo.findLessonById(created.id, firstLesson))?.lesson.title, "First");
      });
    });

    // --- findMany: filters ----------------------------------------------------------------------

    describe("findMany filters", () => {
      it("returns every course in the PaginatedResult shape", async () => {
        await repo.create(createInput());
        await repo.create(createInput());

        const result = await repo.findMany({}, PAGE);
        assert.deepEqual(Object.keys(result).sort(), ["items", "page", "pageSize", "total", "totalPages"]);
        assert.equal(result.total, 2);
      });

      it("publishedOnly returns only courses with isPublished true", async () => {
        const published = await repo.create(createInput());
        await repo.create(createInput());
        await repo.setPublication(published.id, { status: "Published", isPublished: true });

        assert.deepEqual(await list(undefined, { publishedOnly: true }), [published.id]);
        assert.equal((await repo.findMany({}, PAGE)).total, 2, "without the flag, drafts are included");
      });

      it("filters by category, level, status and hasPlacementGuarantee", async () => {
        const a = await repo.create(
          createInput({ category: "Data & AI", level: "Advanced", hasPlacementGuarantee: true }),
        );
        const b = await repo.create(createInput({ category: "Cloud & DevOps", level: "Beginner" }));
        await repo.setPublication(b.id, { status: "Active", isPublished: true });

        assert.deepEqual(await list(undefined, { category: "Data & AI" }), [a.id]);
        assert.deepEqual(await list(undefined, { level: "Advanced" }), [a.id]);
        assert.deepEqual(await list(undefined, { status: "Active" }), [b.id]);
        assert.deepEqual(await list(undefined, { status: "Draft" }), [a.id]);
        assert.deepEqual(await list(undefined, { hasPlacementGuarantee: true }), [a.id]);
        assert.deepEqual(await list(undefined, { hasPlacementGuarantee: false }), [b.id]);
      });

      it("searches title, shortDescription and technologies, case-insensitively (ASCII)", async () => {
        const byTitle = await repo.create(createInput({ title: `Quillborne ${tag()}` }));
        const byShort = await repo.create(createInput({ shortDescription: "Learn Zephyrine today" }));
        const byTech = await repo.create(createInput({ technologies: ["Python", "Xylophon-Kit"] }));

        assert.deepEqual(await list(undefined, { search: "QUILLBORNE" }), [byTitle.id]);
        assert.deepEqual(await list(undefined, { search: "zephyrine" }), [byShort.id]);
        assert.deepEqual(await list(undefined, { search: "xylophon" }), [byTech.id]);
      });

      it("combines filters with AND", async () => {
        const match = await repo.create(createInput({ category: "Testing", title: `Orvalle ${tag()}` }));
        await repo.create(createInput({ category: "Testing", title: `Other ${tag()}` }));
        await repo.create(createInput({ category: "Cybersecurity", title: `Orvalle ${tag()}` }));
        await repo.setPublication(match.id, { status: "Published", isPublished: true });

        const result = await repo.findMany(
          { publishedOnly: true, category: "Testing", search: "orvalle" },
          PAGE,
        );
        assert.deepEqual(ids(result.items), [match.id]);
        assert.equal(result.total, 1);
      });

      it("returns an empty page, not an error, when nothing matches", async () => {
        await repo.create(createInput());
        const result = await repo.findMany({ search: `no-such-${tag()}` }, PAGE);
        assert.deepEqual(result.items, []);
        assert.equal(result.total, 0);
      });

      it("returns detached items", async () => {
        const created = await repo.create(createInput());
        const [item] = (await repo.findMany({}, PAGE)).items;
        assert.ok(item);
        item.title = "MUTATED";
        assert.equal((await repo.findById(created.id))?.title, created.title);
      });
    });

    // --- findMany: pagination --------------------------------------------------------------------

    describe("findMany pagination", () => {
      it("pages with correct metadata, including a page past the end", async () => {
        for (let i = 0; i < 5; i += 1) await repo.create(createInput());

        const first = await repo.findMany({}, { page: 1, pageSize: 2 });
        assert.equal(first.items.length, 2);
        assert.equal(first.total, 5);
        assert.equal(first.page, 1);
        assert.equal(first.pageSize, 2);
        assert.equal(first.totalPages, 3);

        assert.equal((await repo.findMany({}, { page: 3, pageSize: 2 })).items.length, 1);

        const beyond = await repo.findMany({}, { page: 9, pageSize: 2 });
        assert.deepEqual(beyond.items, []);
        assert.equal(beyond.total, 5);
      });
    });

    // --- findMany: sorting ------------------------------------------------------------------------

    describe("findMany sorting", () => {
      let a: Course;
      let b: Course;
      let c: Course;

      beforeEach(async () => {
        // Mixed-case titles; numeric values chosen so TEXT ordering would be
        // wrong ("120000" < "15000" < "900" as strings).
        a = await repo.create(
          createInput({ title: "charlie", feeINR: 900, durationWeeks: 4, totalHours: 300 }),
        );
        b = await repo.create(
          createInput({ title: "Alpha", feeINR: 120000, durationWeeks: 52, totalHours: 40 }),
        );
        c = await repo.create(
          createInput({ title: "bravo", feeINR: 15000, durationWeeks: 12, totalHours: 1000 }),
        );
      });

      it("sorts by title case-insensitively (ASCII), both directions", async () => {
        assert.deepEqual(await list({ field: "title", order: "asc" }), [b.id, c.id, a.id]);
        assert.deepEqual(await list({ field: "title", order: "desc" }), [a.id, c.id, b.id]);
      });

      it("sorts by feeINR numerically, both directions", async () => {
        assert.deepEqual(await list({ field: "feeINR", order: "asc" }), [a.id, c.id, b.id]);
        assert.deepEqual(await list({ field: "feeINR", order: "desc" }), [b.id, c.id, a.id]);
      });

      it("sorts by durationWeeks numerically, both directions", async () => {
        assert.deepEqual(await list({ field: "durationWeeks", order: "asc" }), [a.id, c.id, b.id]);
        assert.deepEqual(await list({ field: "durationWeeks", order: "desc" }), [b.id, c.id, a.id]);
      });

      it("sorts by totalHours numerically, both directions", async () => {
        assert.deepEqual(await list({ field: "totalHours", order: "asc" }), [b.id, a.id, c.id]);
        assert.deepEqual(await list({ field: "totalHours", order: "desc" }), [c.id, a.id, b.id]);
      });
    });

    describe("findMany deterministic ordering", () => {
      let tied: Course[];

      beforeEach(async () => {
        tied = [];
        for (let i = 0; i < 5; i += 1) {
          tied.push(
            await repo.create(
              createInput({ title: "Same Title", feeINR: 7000, durationWeeks: 8, totalHours: 80 }),
            ),
          );
        }
      });

      it("breaks ties by id ASC for every sort field, regardless of direction", async () => {
        const expected = sortedIds(ids(tied));

        for (const field of ["title", "feeINR", "durationWeeks", "totalHours"] as const) {
          for (const order of ["asc", "desc"] as const) {
            assert.deepEqual(await list({ field, order }), expected, `${field} ${order}`);
          }
        }
      });

      it("keeps page boundaries stable across tied rows: no repeats, no gaps", async () => {
        const expected = sortedIds(ids(tied));

        for (const sort of [
          { field: "feeINR", order: "desc" },
          { field: "title", order: "asc" },
        ] as const) {
          const paged: EntityId[] = [];
          for (const page of [1, 2, 3]) {
            paged.push(...ids((await repo.findMany({}, { page, pageSize: 2 }, sort)).items));
          }
          assert.deepEqual(paged, expected, JSON.stringify(sort));
        }
      });

      it("without sort: the order is deterministic and pages are disjoint and complete", async () => {
        // No specific default order is asserted - only determinism.
        const full = await list();
        assert.deepEqual(await list(), full, "same order on repeated calls");
        assert.deepEqual(new Set(full), new Set(ids(tied)));

        const paged: EntityId[] = [];
        for (const page of [1, 2, 3]) {
          paged.push(...ids((await repo.findMany({}, { page, pageSize: 2 })).items));
        }
        assert.deepEqual(paged, full);
        assert.equal(new Set(paged).size, 5);
      });
    });

    // --- documented error properties -----------------------------------------------------------------

    describe("documented error properties", () => {
      it("RecordNotFoundError is a RepositoryError carrying entity and id", async () => {
        const id = missingId();
        await assert.rejects(
          repo.setPublication(id, { status: "Draft", isPublished: false }),
          (err: unknown) => {
            assert.ok(err instanceof RecordNotFoundError);
            assert.ok(err instanceof RepositoryError);
            assert.equal(err.id, id);
            assert.equal(typeof err.entity, "string");
            assert.ok(err.entity.length > 0);
            return true;
          },
        );
      });

      it("DuplicateRecordError carries the duplicated slug value", async () => {
        const input = createInput();
        await repo.create(input);

        await assert.rejects(repo.create(createInput({ slug: input.slug })), (err: unknown) => {
          assert.ok(err instanceof DuplicateRecordError);
          assert.equal(err.value.toLowerCase(), input.slug.toLowerCase());
          assert.equal(typeof err.entity, "string");
          return true;
        });
      });
    });
  });
};
