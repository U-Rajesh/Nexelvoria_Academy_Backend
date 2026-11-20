import type { EntityId } from "../src/contracts/identifier.contract";
import { describeTeacherRepositoryContract } from "./contracts/teacher-repository.contract";
import { InMemoryTeacherRepository } from "./fakes";

/**
 * Runs the TeacherRepository contract against the in-memory fake.
 *
 * Only FIXTURE SETUP lives here; every assertion is in
 * tests/contracts/teacher-repository.contract.ts, so a future SQL Server
 * adapter reuses the identical suite with its own fixture:
 *
 *   describeTeacherRepositoryContract("SqlServerTeacherRepository", async () => ({
 *     repository: new SqlServerTeacherRepository(pool),
 *     reset: () => truncateTeacherTables(pool),
 *     insertTeacher: (row) => insertTeacherRow(pool, row),
 *     compareIds: <the key type's real ordering>,
 *   }));
 */
describeTeacherRepositoryContract("InMemoryTeacherRepository", async () => {
  // A fresh repository per fixture: each test gets isolated state.
  const repository = new InMemoryTeacherRepository();

  // Fixture-owned id sequence for inserted rows. Sequential numeric suffixes
  // so the fake's numeric-aware `id ASC` tiebreak is what `compareIds`
  // reproduces. Never visible to the contract as literals.
  let sequence = 0;

  return {
    repository,

    reset: async () => {
      repository.reset();
      sequence = 0;
    },

    insertTeacher: async (row) => {
      sequence += 1;
      return repository.seed({
        ...row,
        id: `teacher-fixture-${sequence}`,
        // Inserted rows never carry allocations: allocations exist only
        // through addAllocation (inspection finding F2).
        assignedCourseIds: [],
        assignedBatchIds: [],
      });
    },

    // Mirrors the fake's ordering: numeric-aware, so "...-2" < "...-10".
    compareIds: (a: EntityId, b: EntityId) => a.localeCompare(b, undefined, { numeric: true }),
  };
});
