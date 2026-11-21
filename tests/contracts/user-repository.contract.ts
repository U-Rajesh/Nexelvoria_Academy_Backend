import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { EntityId } from "../../src/contracts/identifier.contract";
import type { UserRepository } from "../../src/modules/users/user.repository";
import type { CreateUserInput, User } from "../../src/modules/users/user.types";
import {
  DuplicateRecordError,
  RecordNotFoundError,
  RepositoryError,
} from "../../src/repositories/repository.errors";

/**
 * UserRepository CONTRACT TESTS - implementation-agnostic.
 *
 * Every test exercises the public `UserRepository` port only, so the same
 * suite runs against the in-memory fake today and a SQL Server adapter
 * later:
 *
 *   describeUserRepositoryContract("SqlServerUserRepository", makeSqlFixture);
 *
 * No direct-insert hook is needed: every field the port reads or filters on
 * is settable through `create()`, `update()` and `setStatus()`.
 *
 * DELIBERATELY NOT ASSERTED (undocumented or undecided): a default ORDER for
 * `findMany` (only membership, totals and page sizes); whether `update()`
 * enforces mobile uniqueness (the fake does not check; the port does not
 * say); the casing an email is STORED in; whether `search` is
 * case-insensitive beyond ASCII; accent/locale collation.
 *
 * REQUIRES A REAL SQL SERVER RUN to be meaningful: case-insensitive unique
 * email under the chosen collation (a unique index, not a pre-check),
 * unique mobile, and the duplicate check holding under CONCURRENT creates -
 * the fake is single-threaded, so the concurrent-create test below proves
 * only the fake's ordering, not an index.
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
 * Not a test file itself (`npm test` runs `tests/*.test.ts` only);
 * `tests/user-repository.contract.test.ts` invokes it.
 */

/** What an implementation must provide. Setup lives here, never in assertions. */
export interface UserRepositoryFixture {
  /** The implementation under test. */
  repository: UserRepository;
  /**
   * Restores an empty state. SQL: delete/truncate the tables under test in a
   * DISPOSABLE test database - never a rolled-back transaction, never a
   * shared or development database (see SQL FIXTURE REQUIREMENTS above).
   */
  reset(): Promise<void>;
}

export type UserRepositoryFixtureFactory = () => Promise<UserRepositoryFixture>;

const PAGE = { page: 1, pageSize: 50 } as const;

export const describeUserRepositoryContract = (
  label: string,
  makeFixture: UserRepositoryFixtureFactory,
): void => {
  describe(`UserRepository contract: ${label}`, () => {
    let fx: UserRepositoryFixture;
    let repo: UserRepository;

    // Unique per run and per call, so values never collide with leftover rows.
    const run = randomUUID().slice(0, 8);
    let counter = 0;
    const tag = (): string => `${run}${(counter += 1)}`;
    const missingId = (): EntityId => `missing-${randomUUID()}`;
    /** A unique 10-digit mobile number. */
    const uniqueMobile = (): string =>
      `9${String(Date.now() % 1_000_000).padStart(6, "0")}${String((counter += 1) % 1000).padStart(3, "0")}`;

    const createInput = (overrides: Partial<CreateUserInput> = {}): CreateUserInput => {
      const t = tag();
      return {
        name: `Contract User ${t}`,
        email: `user-${t}@contract.test`,
        mobile: uniqueMobile(),
        role: "student",
        status: "active",
        ...overrides,
      };
    };

    const ids = (users: User[]): EntityId[] => users.map((u) => u.id).sort();
    const findAll = async (filter = {}) => (await repo.findMany(filter, PAGE)).items;

    beforeEach(async () => {
      fx = await makeFixture();
      await fx.reset();
      repo = fx.repository;
    });

    afterEach(async () => {
      await fx.reset();
    });

    // --- create ---------------------------------------------------------------------------

    describe("create", () => {
      it("assigns an id and createdAt and stores every supplied field", async () => {
        const input = createInput({ role: "teacher", status: "pending", avatarUrl: "https://cdn.contract.test/a.png" });
        const before = Date.now();
        const user = await repo.create(input);

        assert.equal(typeof user.id, "string");
        assert.ok(user.id.length > 0);
        assert.ok(!Number.isNaN(Date.parse(user.createdAt)), "createdAt is a parseable timestamp");
        assert.ok(Date.parse(user.createdAt) >= before - 1000, "createdAt is set by the adapter, now");
        assert.equal(user.name, input.name);
        assert.equal(user.email.toLowerCase(), input.email.toLowerCase());
        assert.equal(user.mobile, input.mobile);
        assert.equal(user.role, "teacher");
        assert.equal(user.status, "pending");
        assert.equal(user.avatarUrl, input.avatarUrl);
      });

      it("assigns distinct ids", async () => {
        const a = await repo.create(createInput());
        const b = await repo.create(createInput());
        assert.notEqual(a.id, b.id);
      });

      it("accepts every role and status value", async () => {
        for (const role of ["public", "student", "teacher", "admin", "super_admin"] as const) {
          assert.equal((await repo.create(createInput({ role }))).role, role);
        }
        for (const status of ["active", "pending", "suspended", "deactivated"] as const) {
          assert.equal((await repo.create(createInput({ status }))).status, status);
        }
      });

      it("rejects a duplicate email with DuplicateRecordError on field 'email'", async () => {
        const first = await repo.create(createInput());
        await assert.rejects(repo.create(createInput({ email: first.email })), (error: unknown) => {
          assert.ok(error instanceof DuplicateRecordError);
          assert.ok(error instanceof RepositoryError);
          assert.equal(error.field, "email");
          return true;
        });
      });

      it("treats email uniqueness case-insensitively", async () => {
        const first = await repo.create(createInput());
        await assert.rejects(
          repo.create(createInput({ email: first.email.toUpperCase() })),
          (error: unknown) => error instanceof DuplicateRecordError && error.field === "email",
        );
      });

      it("rejects a duplicate mobile with DuplicateRecordError on field 'mobile'", async () => {
        const first = await repo.create(createInput());
        await assert.rejects(
          repo.create(createInput({ mobile: first.mobile })),
          (error: unknown) => error instanceof DuplicateRecordError && error.field === "mobile",
        );
      });

      it("writes nothing when a create is rejected as a duplicate", async () => {
        const first = await repo.create(createInput());
        const rejected = createInput({ email: first.email });
        await assert.rejects(repo.create(rejected), DuplicateRecordError);
        assert.equal(await repo.findByMobile(rejected.mobile), null);
        assert.equal((await repo.findMany({}, PAGE)).total, 1);
      });

      it("concurrent creates with the same email: exactly one succeeds (fake: ordering only)", async () => {
        const email = `race-${tag()}@contract.test`;
        const results = await Promise.allSettled(
          Array.from({ length: 5 }, () => repo.create(createInput({ email }))),
        );
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
        for (const r of results) {
          if (r.status === "rejected") assert.ok(r.reason instanceof DuplicateRecordError);
        }
      });
    });

    // --- single reads -------------------------------------------------------------------------

    describe("findById / findByEmail / findByMobile", () => {
      it("findById returns the created user", async () => {
        const user = await repo.create(createInput());
        assert.deepEqual(await repo.findById(user.id), user);
      });

      it("findById returns null - not a throw - for an unknown id", async () => {
        assert.equal(await repo.findById(missingId()), null);
      });

      it("findByEmail matches regardless of case", async () => {
        const user = await repo.create(createInput());
        assert.equal((await repo.findByEmail(user.email))?.id, user.id);
        assert.equal((await repo.findByEmail(user.email.toUpperCase()))?.id, user.id);
      });

      it("findByEmail returns null for an unknown email", async () => {
        assert.equal(await repo.findByEmail(`nobody-${tag()}@contract.test`), null);
      });

      it("findByMobile matches exactly and returns null otherwise", async () => {
        const user = await repo.create(createInput());
        assert.equal((await repo.findByMobile(user.mobile))?.id, user.id);
        assert.equal(await repo.findByMobile(uniqueMobile()), null);
      });

      it("returns detached copies: mutating a result does not change the store", async () => {
        const user = await repo.create(createInput());
        const read = await repo.findById(user.id);
        assert.ok(read);
        read.name = "Mutated";
        assert.equal((await repo.findById(user.id))?.name, user.name);
      });
    });

    describe("existsByEmail / existsByMobile", () => {
      it("existsByEmail is true for a known email in any case and false otherwise", async () => {
        const user = await repo.create(createInput());
        assert.equal(await repo.existsByEmail(user.email), true);
        assert.equal(await repo.existsByEmail(user.email.toUpperCase()), true);
        assert.equal(await repo.existsByEmail(`nobody-${tag()}@contract.test`), false);
      });

      it("existsByMobile is true for a known mobile and false otherwise", async () => {
        const user = await repo.create(createInput());
        assert.equal(await repo.existsByMobile(user.mobile), true);
        assert.equal(await repo.existsByMobile(uniqueMobile()), false);
      });
    });

    // --- findMany -----------------------------------------------------------------------------

    describe("findMany", () => {
      it("returns every user with no filter", async () => {
        const a = await repo.create(createInput());
        const b = await repo.create(createInput());
        assert.deepEqual(ids(await findAll()), ids([a, b]));
      });

      it("filters by role", async () => {
        const student = await repo.create(createInput({ role: "student" }));
        await repo.create(createInput({ role: "teacher" }));
        assert.deepEqual(ids(await findAll({ role: "student" })), [student.id]);
      });

      it("filters by status", async () => {
        await repo.create(createInput({ status: "active" }));
        const suspended = await repo.create(createInput({ status: "suspended" }));
        assert.deepEqual(ids(await findAll({ status: "suspended" })), [suspended.id]);
      });

      it("combines role and status filters", async () => {
        const target = await repo.create(createInput({ role: "teacher", status: "pending" }));
        await repo.create(createInput({ role: "teacher", status: "active" }));
        await repo.create(createInput({ role: "student", status: "pending" }));
        assert.deepEqual(ids(await findAll({ role: "teacher", status: "pending" })), [target.id]);
      });

      it("searches name, email and mobile (ASCII case-insensitive)", async () => {
        const t = tag();
        const byName = await repo.create(createInput({ name: `Zed Needle${t}` }));
        const byEmail = await repo.create(createInput({ email: `needle${t}@contract.test` }));
        const other = await repo.create(createInput());

        assert.deepEqual(ids(await findAll({ search: `NEEDLE${t}` })), ids([byName, byEmail]));
        assert.deepEqual(ids(await findAll({ search: other.mobile })), [other.id]);
      });

      it("returns an empty page when nothing matches", async () => {
        await repo.create(createInput());
        const result = await repo.findMany({ search: `absent-${tag()}` }, PAGE);
        assert.deepEqual(result.items, []);
        assert.equal(result.total, 0);
      });

      it("pages with correct metadata, including a page past the end", async () => {
        const created: User[] = [];
        for (let i = 0; i < 5; i += 1) created.push(await repo.create(createInput()));

        const first = await repo.findMany({}, { page: 1, pageSize: 2 });
        assert.equal(first.items.length, 2);
        assert.equal(first.total, 5);
        assert.equal(first.page, 1);
        assert.equal(first.pageSize, 2);
        assert.equal(first.totalPages, 3);

        const second = await repo.findMany({}, { page: 2, pageSize: 2 });
        const third = await repo.findMany({}, { page: 3, pageSize: 2 });
        assert.equal(third.items.length, 1);
        // Pages are disjoint and together cover every row (order not asserted).
        assert.deepEqual(ids([...first.items, ...second.items, ...third.items]), ids(created));

        const beyond = await repo.findMany({}, { page: 9, pageSize: 2 });
        assert.deepEqual(beyond.items, []);
        assert.equal(beyond.total, 5);
      });

      it("total counts the filtered set, not the page", async () => {
        for (let i = 0; i < 3; i += 1) await repo.create(createInput({ role: "teacher" }));
        await repo.create(createInput({ role: "student" }));
        const page = await repo.findMany({ role: "teacher" }, { page: 1, pageSize: 2 });
        assert.equal(page.items.length, 2);
        assert.equal(page.total, 3);
        assert.ok(page.items.every((u) => u.role === "teacher"));
      });
    });

    // --- update / setStatus ---------------------------------------------------------------

    describe("update", () => {
      it("changes only the supplied fields", async () => {
        const user = await repo.create(createInput({ avatarUrl: "https://cdn.contract.test/old.png" }));
        const updated = await repo.update(user.id, { name: "Renamed" });

        assert.equal(updated.name, "Renamed");
        assert.equal(updated.email, user.email);
        assert.equal(updated.mobile, user.mobile);
        assert.equal(updated.avatarUrl, user.avatarUrl);
        assert.equal(updated.role, user.role);
        assert.equal(updated.status, user.status);
        assert.equal(updated.id, user.id);
        assert.equal(Date.parse(updated.createdAt), Date.parse(user.createdAt));
        assert.deepEqual(await repo.findById(user.id), updated);
      });

      it("updates mobile and avatarUrl, and the new mobile is findable", async () => {
        const user = await repo.create(createInput());
        const mobile = uniqueMobile();
        const updated = await repo.update(user.id, { mobile, avatarUrl: "https://cdn.contract.test/new.png" });
        assert.equal(updated.mobile, mobile);
        assert.equal(updated.avatarUrl, "https://cdn.contract.test/new.png");
        assert.equal((await repo.findByMobile(mobile))?.id, user.id);
      });

      it("throws RecordNotFoundError for an unknown id", async () => {
        await assert.rejects(repo.update(missingId(), { name: "x" }), RecordNotFoundError);
      });
    });

    describe("setStatus", () => {
      it("changes the status and nothing else", async () => {
        const user = await repo.create(createInput());
        const updated = await repo.setStatus(user.id, "suspended");
        assert.equal(updated.status, "suspended");
        assert.deepEqual({ ...updated, status: user.status }, user);
        assert.equal((await repo.findById(user.id))?.status, "suspended");
      });

      it("throws RecordNotFoundError for an unknown id", async () => {
        await assert.rejects(repo.setStatus(missingId(), "active"), (error: unknown) => {
          assert.ok(error instanceof RecordNotFoundError);
          assert.ok(error instanceof RepositoryError);
          return true;
        });
      });
    });
  });
};
