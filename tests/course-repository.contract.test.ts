import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { EntityId } from "../src/contracts/identifier.contract";
import type { Course } from "../src/modules/courses/course.types";
import { describeCourseRepositoryContract } from "./contracts/course-repository.contract";
import { InMemoryCourseRepository } from "./fakes";

/**
 * Runs the CourseRepository contract against the in-memory fake.
 *
 * Only FIXTURE SETUP lives here; every contract assertion is in
 * tests/contracts/course-repository.contract.ts, so a future SQL Server
 * adapter reuses the identical suite with its own fixture:
 *
 *   describeCourseRepositoryContract("SqlServerCourseRepository", async () => ({
 *     repository: new SqlServerCourseRepository(pool),
 *     reset: () => truncateCourseTables(pool),
 *     compareIds: <the key type's real ordering>,
 *   }));
 */
describeCourseRepositoryContract("InMemoryCourseRepository", async () => {
  // A fresh repository per fixture: each test gets isolated state.
  const repository = new InMemoryCourseRepository();

  return {
    repository,
    reset: async () => {
      repository.reset();
    },
    // Numeric-aware, matching the fake's sequential ids ("course-2" < "course-10").
    compareIds: (a: EntityId, b: EntityId) => a.localeCompare(b, undefined, { numeric: true }),
  };
});

/**
 * Fake-specific REGRESSION test (not part of the reusable contract).
 *
 * The fake used to break sort-key ties by INSERTION order (a stable sort),
 * which equals `id ASC` only when rows are inserted in id order. Seeding
 * rows OUT of id order exposes the difference; the fix compares ids
 * explicitly (numeric-aware), matching the teacher and student fakes.
 */
describe("InMemoryCourseRepository regression: explicit id ASC tiebreak", () => {
  const seeded = (id: EntityId, slug: string): Course => ({
    id,
    slug,
    title: "Identical Title",
    shortDescription: "Short",
    longDescription: "Long",
    thumbnailUrl: "https://cdn.regression.test/t.png",
    durationWeeks: 10,
    totalHours: 100,
    feeINR: 5000,
    level: "Beginner",
    category: "Testing",
    technologies: [],
    modules: [],
    isPublished: false,
    status: "Draft",
    hasPlacementGuarantee: false,
    prerequisites: [],
    learningOutcomes: [],
  });

  it("orders tied rows by id ASC even when insertion order differs from id order", async () => {
    const repo = new InMemoryCourseRepository();
    // Inserted 10, 2, 1 - the reverse of numeric id order.
    repo.seed(seeded("course-10", "regression-ten"));
    repo.seed(seeded("course-2", "regression-two"));
    repo.seed(seeded("course-1", "regression-one"));

    const expected = ["course-1", "course-2", "course-10"];

    for (const field of ["title", "feeINR", "durationWeeks", "totalHours"] as const) {
      for (const order of ["asc", "desc"] as const) {
        const result = await repo.findMany({}, { page: 1, pageSize: 10 }, { field, order });
        assert.deepEqual(
          result.items.map((c) => c.id),
          expected,
          `${field} ${order}`,
        );
      }
    }
  });
});
