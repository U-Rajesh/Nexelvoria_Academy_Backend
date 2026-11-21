import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { EntityId } from "../../src/contracts/identifier.contract";
import { USER_STATUSES } from "../../src/contracts/user.contract";
import type { TeacherRepository } from "../../src/modules/teachers/teacher.repository";
import type {
  CreateTeacherInput,
  Teacher,
  TeacherAllocation,
} from "../../src/modules/teachers/teacher.types";
import {
  DuplicateRecordError,
  RecordNotFoundError,
  RepositoryError,
} from "../../src/repositories/repository.errors";

/**
 * TeacherRepository CONTRACT TESTS - implementation-agnostic.
 *
 * Every test here exercises the public `TeacherRepository` port only, so the
 * same suite can run against the in-memory fake today and a SQL Server
 * adapter later. An implementation opts in by supplying a fixture:
 *
 *   describeTeacherRepositoryContract("SqlServerTeacherRepository", makeSqlFixture);
 *
 * DELIBERATELY NOT ASSERTED (undecided or undocumented - see the inspection
 * report): create defaults for `status` and `rating`; whether one teacher may
 * hold two courses in the SAME batch (only EXACT duplicate allocations are
 * tested); `findByBatch` ordering (compared as sets); mobile uniqueness;
 * accent/locale collation (case-insensitivity is tested with ASCII only).
 *
 * SQL FIXTURE REQUIREMENTS (no SQL Server fixture exists yet - these bind
 * the first one):
 *   - Run ONLY against a DISPOSABLE test database created for these suites.
 *     `reset()` deletes every row in the tables under test, so a fixture
 *     must NEVER point at a shared or development database, and its reset
 *     should refuse to run unless the target is positively identified as
 *     that disposable database.
 *   - Do NOT wrap tests in one transaction that is rolled back between
 *     tests. Overlapping operations (the concurrency tests) must run on
 *     SEPARATE pooled connections; a single transaction puts them all on one
 *     connection, serialises them, and hides the races under test.
 *   - Reset safely between tests: delete or truncate the tables under test
 *     in foreign-key order and commit, so every connection sees an empty
 *     state before the next test starts.
 *
 * This file is not itself a test file (`npm test` runs `tests/*.test.ts`
 * only); `tests/teacher-repository.contract.test.ts` invokes it.
 */

/** A row for `insertTeacher`: everything except what the store owns. */
export type TeacherRow = Omit<Teacher, "id" | "assignedCourseIds" | "assignedBatchIds">;

/**
 * What an implementation must provide to run the contract.
 *
 * Fixture SETUP lives here, never in the assertions below.
 */
export interface TeacherRepositoryFixture {
  /** The implementation under test. */
  repository: TeacherRepository;

  /**
   * Restores an empty state. SQL: delete/truncate the tables under test in a
   * DISPOSABLE test database - never a rolled-back transaction, never a
   * shared or development database (see SQL FIXTURE REQUIREMENTS above).
   */
  reset(): Promise<void>;

  /**
   * Inserts a fully specified teacher with NO allocations, bypassing
   * `create()`. Needed because `create()` sets `createdAt` itself, and the
   * sort and tie tests need controlled timestamps. The implementation
   * assigns the id (ids are never hard-coded here - Q-K1).
   */
  insertTeacher(row: TeacherRow): Promise<Teacher>;

  /**
   * The implementation's real `id ASC` order. Numeric-aware for sequential
   * keys; a SQL Server fixture returns whatever its key type sorts as.
   */
  compareIds(a: EntityId, b: EntityId): number;
}

export type TeacherRepositoryFixtureFactory = () => Promise<TeacherRepositoryFixture>;

const PAGE = { page: 1, pageSize: 50 } as const;

export const describeTeacherRepositoryContract = (
  label: string,
  makeFixture: TeacherRepositoryFixtureFactory,
): void => {
  describe(`TeacherRepository contract: ${label}`, () => {
    let fx: TeacherRepositoryFixture;
    let repo: TeacherRepository;

    // Unique per suite run AND per call, so the suite also works on a shared
    // database where other rows may already exist.
    const run = randomUUID().slice(0, 8);
    let counter = 0;
    const tag = (): string => `${run}-${(counter += 1)}`;
    const uniqueEmail = (prefix = "teacher"): string => `${prefix}.${tag()}@contract.test`;
    /** An id guaranteed not to exist in this run. */
    const missingId = (): EntityId => `missing-${randomUUID()}`;

    const createInput = (overrides: Partial<CreateTeacherInput> = {}): CreateTeacherInput => ({
      name: `Teacher ${tag()}`,
      email: uniqueEmail(),
      mobile: "9000000000",
      specialization: "Full Stack Development",
      experienceYears: 5,
      bio: "Contract test bio",
      qualifications: "M.Tech",
      ...overrides,
    });

    const row = (overrides: Partial<TeacherRow> = {}): TeacherRow => ({
      name: `Teacher ${tag()}`,
      email: uniqueEmail(),
      mobile: "9000000000",
      role: "teacher",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      specialization: "Full Stack Development",
      experienceYears: 5,
      bio: "Contract test bio",
      qualifications: "M.Tech",
      rating: 4,
      ...overrides,
    });

    /** Allocation ids are opaque strings to the port; make them unique per test. */
    const ref = (kind: "course" | "batch"): EntityId => `${kind}-${tag()}`;

    const ids = (teachers: { id: EntityId }[]): EntityId[] => teachers.map((t) => t.id);
    const sortedIds = (list: EntityId[]): EntityId[] => [...list].sort(fx.compareIds);

    beforeEach(async () => {
      fx = await makeFixture();
      await fx.reset();
      repo = fx.repository;
    });

    afterEach(async () => {
      await fx.reset();
    });

    // --- findById --------------------------------------------------------------

    describe("findById", () => {
      it("returns a created teacher with its stored fields", async () => {
        const input = createInput({ avatarUrl: "https://cdn.contract.test/a.png" });
        const created = await repo.create(input);

        const found = await repo.findById(created.id);
        assert.ok(found);
        assert.equal(found.id, created.id);
        assert.equal(found.name, input.name);
        assert.equal(found.email, input.email);
        assert.equal(found.mobile, input.mobile);
        assert.equal(found.specialization, input.specialization);
        assert.equal(found.experienceYears, input.experienceYears);
        assert.equal(found.bio, input.bio);
        assert.equal(found.qualifications, input.qualifications);
        assert.equal(found.avatarUrl, input.avatarUrl);
      });

      it("returns null - not a throw - for an unknown id", async () => {
        assert.equal(await repo.findById(missingId()), null);
      });

      it("returns a detached copy: mutating it does not change stored data", async () => {
        const created = await repo.create(createInput());
        const first = await repo.findById(created.id);
        assert.ok(first);

        first.name = "MUTATED";
        first.assignedCourseIds.push("course-mutated");

        const again = await repo.findById(created.id);
        assert.equal(again?.name, created.name);
        assert.deepEqual(again?.assignedCourseIds, []);
      });
    });

    // --- findByEmail / existsByEmail ---------------------------------------------

    describe("findByEmail", () => {
      it("finds a teacher by exact email", async () => {
        const created = await repo.create(createInput());
        assert.equal((await repo.findByEmail(created.email))?.id, created.id);
      });

      it("is case-insensitive (ASCII)", async () => {
        const created = await repo.create(createInput({ email: uniqueEmail("Mixed.Case") }));
        assert.equal((await repo.findByEmail(created.email.toUpperCase()))?.id, created.id);
        assert.equal((await repo.findByEmail(created.email.toLowerCase()))?.id, created.id);
      });

      it("returns null when no teacher has the email", async () => {
        assert.equal(await repo.findByEmail(uniqueEmail("nobody")), null);
      });

      it("returns a detached copy", async () => {
        const created = await repo.create(createInput());
        const found = await repo.findByEmail(created.email);
        assert.ok(found);
        found.bio = "MUTATED";
        assert.equal((await repo.findById(created.id))?.bio, created.bio);
      });
    });

    describe("existsByEmail", () => {
      it("is true for an existing email, in any ASCII case", async () => {
        const created = await repo.create(createInput());
        assert.equal(await repo.existsByEmail(created.email), true);
        assert.equal(await repo.existsByEmail(created.email.toUpperCase()), true);
      });

      it("is false for an unknown email", async () => {
        assert.equal(await repo.existsByEmail(uniqueEmail("absent")), false);
      });
    });

    // --- create ------------------------------------------------------------------

    describe("create", () => {
      it("assigns a distinct id to each teacher and stores it", async () => {
        const a = await repo.create(createInput());
        const b = await repo.create(createInput());

        assert.equal(typeof a.id, "string");
        assert.ok(a.id.length > 0);
        assert.notEqual(a.id, b.id);
        assert.equal((await repo.findById(a.id))?.email, a.email);
      });

      it("returns a teacher with role 'teacher', no allocations and an ISO createdAt", async () => {
        const created = await repo.create(createInput());

        assert.equal(created.role, "teacher");
        assert.deepEqual(created.assignedCourseIds, []);
        assert.deepEqual(created.assignedBatchIds, []);
        assert.equal(Number.isNaN(Date.parse(created.createdAt)), false);
        // status and rating defaults are deliberately NOT asserted (undocumented).
      });

      it("rejects a duplicate email with DuplicateRecordError on field 'email'", async () => {
        const input = createInput();
        await repo.create(input);

        await assert.rejects(repo.create(createInput({ email: input.email })), (err: unknown) => {
          assert.ok(err instanceof DuplicateRecordError);
          assert.ok(err instanceof RepositoryError);
          assert.equal(err.field, "email");
          assert.equal(typeof err.entity, "string");
          assert.ok(err.entity.length > 0);
          return true;
        });
      });

      it("treats emails differing only in ASCII case as duplicates", async () => {
        const input = createInput({ email: uniqueEmail("case.dup") });
        await repo.create(input);

        await assert.rejects(
          repo.create(createInput({ email: input.email.toUpperCase() })),
          DuplicateRecordError,
        );
      });

      it("a rejected duplicate writes nothing", async () => {
        const input = createInput();
        await repo.create(input);
        const before = (await repo.findMany({}, PAGE)).total;

        await assert.rejects(repo.create(createInput({ email: input.email })), DuplicateRecordError);
        assert.equal((await repo.findMany({}, PAGE)).total, before);
      });

      it("is mutation-safe: changing the input or result afterwards does not change the store", async () => {
        const input = createInput();
        const created = await repo.create(input);

        input.name = "MUTATED INPUT";
        created.name = "MUTATED RESULT";

        const stored = await repo.findById(created.id);
        assert.notEqual(stored?.name, "MUTATED INPUT");
        assert.notEqual(stored?.name, "MUTATED RESULT");
      });
    });

    // --- update ------------------------------------------------------------------

    describe("update", () => {
      it("changes only the given fields and returns the updated teacher", async () => {
        const created = await repo.create(createInput());

        const updated = await repo.update(created.id, { bio: "New bio", experienceYears: 11 });

        assert.equal(updated.id, created.id);
        assert.equal(updated.bio, "New bio");
        assert.equal(updated.experienceYears, 11);
        assert.equal(updated.email, created.email);
        assert.equal(updated.specialization, created.specialization);
        assert.equal(updated.role, "teacher");
        assert.equal(updated.createdAt, created.createdAt);
        assert.deepEqual(updated.assignedBatchIds, created.assignedBatchIds);
      });

      it("persists the change", async () => {
        const created = await repo.create(createInput());
        await repo.update(created.id, { qualifications: "PhD", specialization: "Cloud" });

        const stored = await repo.findById(created.id);
        assert.equal(stored?.qualifications, "PhD");
        assert.equal(stored?.specialization, "Cloud");
      });

      it("throws RecordNotFoundError (with the id) for an unknown teacher", async () => {
        const id = missingId();
        await assert.rejects(repo.update(id, { bio: "x" }), (err: unknown) => {
          assert.ok(err instanceof RecordNotFoundError);
          assert.equal(err.id, id);
          return true;
        });
      });

      it("returns a detached copy", async () => {
        const created = await repo.create(createInput());
        const updated = await repo.update(created.id, { bio: "Kept" });
        updated.bio = "MUTATED";
        assert.equal((await repo.findById(created.id))?.bio, "Kept");
      });
    });

    // --- setStatus ---------------------------------------------------------------

    describe("setStatus", () => {
      it("sets every UserStatus value and persists it, leaving other fields alone", async () => {
        const created = await repo.create(createInput());

        for (const status of USER_STATUSES) {
          const out = await repo.setStatus(created.id, status);
          assert.equal(out.status, status);

          const stored = await repo.findById(created.id);
          assert.equal(stored?.status, status, status);
          assert.equal(stored?.email, created.email);
          assert.equal(stored?.bio, created.bio);
        }
      });

      it("throws RecordNotFoundError for an unknown teacher", async () => {
        await assert.rejects(repo.setStatus(missingId(), "suspended"), RecordNotFoundError);
      });
    });

    // --- findMany: filters ----------------------------------------------------------

    describe("findMany filters", () => {
      it("returns every teacher in the PaginatedResult shape", async () => {
        await repo.create(createInput());
        await repo.create(createInput());

        const result = await repo.findMany({}, PAGE);
        assert.deepEqual(Object.keys(result).sort(), [
          "items",
          "page",
          "pageSize",
          "total",
          "totalPages",
        ]);
        assert.equal(result.total, 2);
        assert.equal(result.items.length, 2);
      });

      it("filters by status", async () => {
        const active = await fx.insertTeacher(row({ status: "active" }));
        const suspended = await fx.insertTeacher(row({ status: "suspended" }));

        assert.deepEqual(ids((await repo.findMany({ status: "suspended" }, PAGE)).items), [
          suspended.id,
        ]);
        assert.deepEqual(ids((await repo.findMany({ status: "active" }, PAGE)).items), [active.id]);
      });

      it("filters by specialization, case-insensitively (ASCII)", async () => {
        const data = await fx.insertTeacher(row({ specialization: "Data Science" }));
        await fx.insertTeacher(row({ specialization: "Cloud Engineering" }));

        for (const value of ["Data Science", "DATA SCIENCE", "data science"]) {
          assert.deepEqual(ids((await repo.findMany({ specialization: value }, PAGE)).items), [
            data.id,
          ], value);
        }
      });

      it("searches name, email and specialization, case-insensitively (ASCII)", async () => {
        const byName = await fx.insertTeacher(row({ name: `Quintessa ${tag()}` }));
        const byEmail = await fx.insertTeacher(row({ email: uniqueEmail("zephyrine") }));
        const bySpec = await fx.insertTeacher(row({ specialization: "Xylophonics" }));

        assert.deepEqual(ids((await repo.findMany({ search: "QUINTESSA" }, PAGE)).items), [
          byName.id,
        ]);
        assert.deepEqual(ids((await repo.findMany({ search: "Zephyrine" }, PAGE)).items), [
          byEmail.id,
        ]);
        assert.deepEqual(ids((await repo.findMany({ search: "xylophon" }, PAGE)).items), [
          bySpec.id,
        ]);
      });

      it("filters by courseId and batchId through allocations", async () => {
        const allocated = await repo.create(createInput());
        await repo.create(createInput());
        const courseId = ref("course");
        const batchId = ref("batch");
        await repo.addAllocation({ teacherId: allocated.id, courseId, batchId });

        assert.deepEqual(ids((await repo.findMany({ courseId }, PAGE)).items), [allocated.id]);
        assert.deepEqual(ids((await repo.findMany({ batchId }, PAGE)).items), [allocated.id]);
      });

      it("combines filters with AND", async () => {
        const match = await fx.insertTeacher(
          row({ status: "active", specialization: "Cloud", name: `Orvalle ${tag()}` }),
        );
        await fx.insertTeacher(row({ status: "suspended", specialization: "Cloud", name: `Orvalle ${tag()}` }));
        await fx.insertTeacher(row({ status: "active", specialization: "Data", name: `Orvalle ${tag()}` }));

        const result = await repo.findMany(
          { status: "active", specialization: "cloud", search: "orvalle" },
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
        item.name = "MUTATED";
        assert.equal((await repo.findById(created.id))?.name, created.name);
      });
    });

    // --- findMany: pagination ---------------------------------------------------------

    describe("findMany pagination", () => {
      it("pages with correct metadata, including a page past the end", async () => {
        for (let i = 0; i < 5; i += 1) await repo.create(createInput());

        const first = await repo.findMany({}, { page: 1, pageSize: 2 });
        assert.equal(first.items.length, 2);
        assert.equal(first.total, 5);
        assert.equal(first.page, 1);
        assert.equal(first.pageSize, 2);
        assert.equal(first.totalPages, 3);

        const last = await repo.findMany({}, { page: 3, pageSize: 2 });
        assert.equal(last.items.length, 1);

        const beyond = await repo.findMany({}, { page: 9, pageSize: 2 });
        assert.deepEqual(beyond.items, []);
        assert.equal(beyond.total, 5);
        assert.equal(beyond.page, 9);
      });

      it("pages are disjoint and together return every row exactly once", async () => {
        for (let i = 0; i < 5; i += 1) await repo.create(createInput());

        const all = ids((await repo.findMany({}, PAGE)).items);
        const paged: EntityId[] = [];
        for (const page of [1, 2, 3]) {
          paged.push(...ids((await repo.findMany({}, { page, pageSize: 2 })).items));
        }

        assert.deepEqual(paged, all);
        assert.equal(new Set(paged).size, 5);
      });
    });

    // --- findMany: sorting ------------------------------------------------------------

    describe("findMany sorting", () => {
      let early: Teacher;
      let middle: Teacher;
      let late: Teacher;

      beforeEach(async () => {
        // name case is mixed on purpose; experienceYears 2 < 10 < 30 would
        // sort WRONGLY as text ("10" < "2"), so numeric sorting is proven.
        early = await fx.insertTeacher(
          row({ name: "charlie", createdAt: "2026-01-01T00:00:00.000Z", experienceYears: 10 }),
        );
        middle = await fx.insertTeacher(
          row({ name: "Alpha", createdAt: "2026-02-01T00:00:00.000Z", experienceYears: 30 }),
        );
        late = await fx.insertTeacher(
          row({ name: "bravo", createdAt: "2026-03-01T00:00:00.000Z", experienceYears: 2 }),
        );
      });

      const order = async (sort?: Parameters<TeacherRepository["findMany"]>[2]) =>
        ids((await repo.findMany({}, PAGE, sort)).items);

      it("defaults to createdAt DESC when sort is omitted", async () => {
        assert.deepEqual(await order(), [late.id, middle.id, early.id]);
      });

      it("sorts by name case-insensitively (ASCII), both directions", async () => {
        assert.deepEqual(await order({ field: "name", order: "asc" }), [
          middle.id,
          late.id,
          early.id,
        ]);
        assert.deepEqual(await order({ field: "name", order: "desc" }), [
          early.id,
          late.id,
          middle.id,
        ]);
      });

      it("sorts by createdAt, both directions", async () => {
        assert.deepEqual(await order({ field: "createdAt", order: "asc" }), [
          early.id,
          middle.id,
          late.id,
        ]);
        assert.deepEqual(await order({ field: "createdAt", order: "desc" }), [
          late.id,
          middle.id,
          early.id,
        ]);
      });

      it("sorts by experienceYears NUMERICALLY, both directions", async () => {
        assert.deepEqual(await order({ field: "experienceYears", order: "asc" }), [
          late.id,
          early.id,
          middle.id,
        ]);
        assert.deepEqual(await order({ field: "experienceYears", order: "desc" }), [
          middle.id,
          early.id,
          late.id,
        ]);
      });
    });

    describe("findMany deterministic tiebreak (id ASC)", () => {
      let tied: Teacher[];

      beforeEach(async () => {
        tied = [];
        for (let i = 0; i < 5; i += 1) {
          tied.push(
            await fx.insertTeacher(
              row({ name: "Same Name", createdAt: "2026-06-01T00:00:00.000Z", experienceYears: 7 }),
            ),
          );
        }
      });

      it("breaks ties by id ASC regardless of sort direction", async () => {
        const expected = sortedIds(ids(tied));

        for (const sort of [
          undefined,
          { field: "createdAt", order: "desc" },
          { field: "createdAt", order: "asc" },
          { field: "name", order: "desc" },
          { field: "experienceYears", order: "desc" },
        ] as const) {
          const got = ids((await repo.findMany({}, PAGE, sort)).items);
          assert.deepEqual(got, expected, JSON.stringify(sort ?? "default"));
        }
      });

      it("keeps page boundaries stable across tied rows: no repeats, no gaps", async () => {
        const expected = sortedIds(ids(tied));

        for (const sort of [undefined, { field: "experienceYears", order: "desc" }] as const) {
          const paged: EntityId[] = [];
          for (const page of [1, 2, 3]) {
            paged.push(...ids((await repo.findMany({}, { page, pageSize: 2 }, sort)).items));
          }
          assert.deepEqual(paged, expected, JSON.stringify(sort ?? "default"));
        }
      });

      it("returns the same order on repeated calls", async () => {
        const first = ids((await repo.findMany({}, PAGE)).items);
        const second = ids((await repo.findMany({}, PAGE)).items);
        assert.deepEqual(second, first);
      });
    });

    // --- allocations -----------------------------------------------------------------

    describe("addAllocation", () => {
      it("allocates and reflects it in every read path", async () => {
        const teacher = await repo.create(createInput());
        const allocation: TeacherAllocation = {
          teacherId: teacher.id,
          courseId: ref("course"),
          batchId: ref("batch"),
        };

        const out = await repo.addAllocation(allocation);
        assert.equal(out.id, teacher.id);
        assert.deepEqual(out.assignedCourseIds, [allocation.courseId]);
        assert.deepEqual(out.assignedBatchIds, [allocation.batchId]);

        assert.deepEqual(await repo.findAllocations(teacher.id), [allocation]);
        assert.equal(await repo.isAllocatedToBatch(teacher.id, allocation.batchId), true);
        assert.deepEqual(ids(await repo.findByBatch(allocation.batchId)), [teacher.id]);

        const stored = await repo.findById(teacher.id);
        assert.deepEqual(stored?.assignedBatchIds, [allocation.batchId]);
      });

      it("holds allocations to several batches at once", async () => {
        const teacher = await repo.create(createInput());
        const a = { teacherId: teacher.id, courseId: ref("course"), batchId: ref("batch") };
        const b = { teacherId: teacher.id, courseId: ref("course"), batchId: ref("batch") };

        await repo.addAllocation(a);
        const out = await repo.addAllocation(b);

        assert.deepEqual([...out.assignedBatchIds].sort(), [a.batchId, b.batchId].sort());
        assert.deepEqual([...out.assignedCourseIds].sort(), [a.courseId, b.courseId].sort());
        assert.equal((await repo.findAllocations(teacher.id)).length, 2);
      });

      it("rejects an EXACT duplicate with DuplicateRecordError and keeps one copy", async () => {
        const teacher = await repo.create(createInput());
        const allocation = { teacherId: teacher.id, courseId: ref("course"), batchId: ref("batch") };
        await repo.addAllocation(allocation);

        await assert.rejects(repo.addAllocation({ ...allocation }), DuplicateRecordError);
        assert.equal((await repo.findAllocations(teacher.id)).length, 1);
        // Same teacher + same batch + DIFFERENT course is deliberately not
        // tested: allocation uniqueness is undecided (Q-R2 vs handoff 7).
      });

      it("throws RecordNotFoundError for an unknown teacher", async () => {
        await assert.rejects(
          repo.addAllocation({ teacherId: missingId(), courseId: ref("course"), batchId: ref("batch") }),
          RecordNotFoundError,
        );
      });

      it("is mutation-safe: changing the input afterwards does not change the store", async () => {
        const teacher = await repo.create(createInput());
        const allocation = { teacherId: teacher.id, courseId: ref("course"), batchId: ref("batch") };
        const originalBatch = allocation.batchId;
        await repo.addAllocation(allocation);

        allocation.batchId = "batch-mutated";

        assert.equal(await repo.isAllocatedToBatch(teacher.id, originalBatch), true);
        assert.equal(await repo.isAllocatedToBatch(teacher.id, "batch-mutated"), false);
      });
    });

    describe("removeAllocation", () => {
      it("removes the batch allocation from every read path and keeps the others", async () => {
        const teacher = await repo.create(createInput());
        const keep = { teacherId: teacher.id, courseId: ref("course"), batchId: ref("batch") };
        const drop = { teacherId: teacher.id, courseId: ref("course"), batchId: ref("batch") };
        await repo.addAllocation(keep);
        await repo.addAllocation(drop);

        const out = await repo.removeAllocation(teacher.id, drop.batchId);

        assert.deepEqual(out.assignedBatchIds, [keep.batchId]);
        assert.equal(out.assignedBatchIds.includes(drop.batchId), false);
        assert.equal(await repo.isAllocatedToBatch(teacher.id, drop.batchId), false);
        assert.equal(await repo.isAllocatedToBatch(teacher.id, keep.batchId), true);
        assert.deepEqual(await repo.findAllocations(teacher.id), [keep]);
        assert.deepEqual(await repo.findByBatch(drop.batchId), []);
        assert.deepEqual(ids((await repo.findMany({ batchId: drop.batchId }, PAGE)).items), []);
      });

      it("throws RecordNotFoundError for an unknown teacher", async () => {
        await assert.rejects(repo.removeAllocation(missingId(), ref("batch")), RecordNotFoundError);
      });

      it("resolves without error when the teacher holds no such allocation", async () => {
        const teacher = await repo.create(createInput());
        const held = { teacherId: teacher.id, courseId: ref("course"), batchId: ref("batch") };
        await repo.addAllocation(held);

        const out = await repo.removeAllocation(teacher.id, ref("batch"));
        assert.equal(out.id, teacher.id);
        assert.deepEqual(await repo.findAllocations(teacher.id), [held]);
      });
    });

    describe("findAllocations", () => {
      it("returns only the given teacher's allocations", async () => {
        const a = await repo.create(createInput());
        const b = await repo.create(createInput());
        const mine = { teacherId: a.id, courseId: ref("course"), batchId: ref("batch") };
        await repo.addAllocation(mine);
        await repo.addAllocation({ teacherId: b.id, courseId: ref("course"), batchId: ref("batch") });

        assert.deepEqual(await repo.findAllocations(a.id), [mine]);
      });

      it("returns [] for a teacher with no allocations", async () => {
        const teacher = await repo.create(createInput());
        assert.deepEqual(await repo.findAllocations(teacher.id), []);
      });

      it("returns detached copies", async () => {
        const teacher = await repo.create(createInput());
        const allocation = { teacherId: teacher.id, courseId: ref("course"), batchId: ref("batch") };
        await repo.addAllocation(allocation);

        const [first] = await repo.findAllocations(teacher.id);
        assert.ok(first);
        first.batchId = "batch-mutated";

        assert.deepEqual(await repo.findAllocations(teacher.id), [allocation]);
      });
    });

    describe("isAllocatedToBatch", () => {
      it("is true only for the teacher's own allocated batch", async () => {
        const a = await repo.create(createInput());
        const b = await repo.create(createInput());
        const batchA = ref("batch");
        const batchB = ref("batch");
        await repo.addAllocation({ teacherId: a.id, courseId: ref("course"), batchId: batchA });
        await repo.addAllocation({ teacherId: b.id, courseId: ref("course"), batchId: batchB });

        assert.equal(await repo.isAllocatedToBatch(a.id, batchA), true);
        assert.equal(await repo.isAllocatedToBatch(a.id, batchB), false, "another teacher's batch");
        assert.equal(await repo.isAllocatedToBatch(a.id, ref("batch")), false, "unknown batch");
      });

      it("is false for an unknown teacher", async () => {
        assert.equal(await repo.isAllocatedToBatch(missingId(), ref("batch")), false);
      });
    });

    describe("findByBatch", () => {
      it("returns every teacher allocated to the batch, and only them (order not assumed)", async () => {
        const a = await repo.create(createInput());
        const b = await repo.create(createInput());
        const other = await repo.create(createInput());
        const batchId = ref("batch");
        await repo.addAllocation({ teacherId: a.id, courseId: ref("course"), batchId });
        await repo.addAllocation({ teacherId: b.id, courseId: ref("course"), batchId });
        await repo.addAllocation({ teacherId: other.id, courseId: ref("course"), batchId: ref("batch") });

        const found = ids(await repo.findByBatch(batchId));
        assert.deepEqual(new Set(found), new Set([a.id, b.id]));
        assert.equal(found.length, 2);
      });

      it("returns [] for a batch nobody is allocated to", async () => {
        await repo.create(createInput());
        assert.deepEqual(await repo.findByBatch(ref("batch")), []);
      });

      it("returns detached teachers", async () => {
        const teacher = await repo.create(createInput());
        const batchId = ref("batch");
        await repo.addAllocation({ teacherId: teacher.id, courseId: ref("course"), batchId });

        const [found] = await repo.findByBatch(batchId);
        assert.ok(found);
        found.name = "MUTATED";
        found.assignedBatchIds.length = 0;

        const stored = await repo.findById(teacher.id);
        assert.equal(stored?.name, teacher.name);
        assert.deepEqual(stored?.assignedBatchIds, [batchId]);
      });
    });

    // --- error properties ----------------------------------------------------------------

    describe("documented error properties", () => {
      it("RecordNotFoundError is a RepositoryError carrying entity and id", async () => {
        const id = missingId();
        await assert.rejects(repo.setStatus(id, "active"), (err: unknown) => {
          assert.ok(err instanceof RecordNotFoundError);
          assert.ok(err instanceof RepositoryError);
          assert.equal(err.id, id);
          assert.equal(typeof err.entity, "string");
          assert.ok(err.entity.length > 0);
          return true;
        });
      });

      it("DuplicateRecordError carries the duplicated value", async () => {
        const input = createInput();
        await repo.create(input);

        await assert.rejects(repo.create(createInput({ email: input.email })), (err: unknown) => {
          assert.ok(err instanceof DuplicateRecordError);
          assert.equal(err.value.toLowerCase(), input.email.toLowerCase());
          return true;
        });
      });
    });
  });
};
