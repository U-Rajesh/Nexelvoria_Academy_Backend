import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DuplicateRecordError,
  RecordNotFoundError,
} from "../../src/repositories/repository.errors";
import type { UserRepository } from "../../src/modules/users/user.repository";
import type { UserHarnessFactory } from "./harness";

/** A valid user payload. `role` and `status` are server-owned. */
const userInput = (overrides: Partial<Parameters<UserRepository["create"]>[0]> = {}) => ({
  name: "Aarav Sharma",
  email: "aarav@test.local",
  mobile: "9876543210",
  role: "student" as const,
  status: "pending" as const,
  ...overrides,
});

/**
 * The `users` port contract.
 *
 * Conventions under test (handoff section 9): single reads return `null` when
 * absent, writes against a missing id throw `RecordNotFoundError`, and
 * uniqueness violations throw `DuplicateRecordError` - never a driver error.
 */
export const describeUserRepositoryContract = (
  label: string,
  makeHarness: UserHarnessFactory,
): void => {
  describe(`UserRepository contract [${label}]`, () => {
    const withRepo = async (fn: (repo: UserRepository) => Promise<void>): Promise<void> => {
      const harness = await makeHarness();

      try {
        await fn(harness.repo);
      } finally {
        await harness.cleanup?.();
      }
    };

    describe("reads of absent records", () => {
      it("findById returns null, it does not throw", async () => {
        await withRepo(async (repo) => {
          assert.equal(await repo.findById("user-nobody"), null);
        });
      });

      it("findByEmail and findByMobile return null", async () => {
        await withRepo(async (repo) => {
          assert.equal(await repo.findByEmail("nobody@test.local"), null);
          assert.equal(await repo.findByMobile("9999999999"), null);
        });
      });

      it("existsByEmail and existsByMobile return false", async () => {
        await withRepo(async (repo) => {
          assert.equal(await repo.existsByEmail("nobody@test.local"), false);
          assert.equal(await repo.existsByMobile("9999999999"), false);
        });
      });
    });

    describe("create", () => {
      it("assigns an id and a createdAt", async () => {
        await withRepo(async (repo) => {
          const user = await repo.create(userInput());

          assert.ok(typeof user.id === "string" && user.id.length > 0);
          assert.ok(typeof user.createdAt === "string" && user.createdAt.length > 0);
        });
      });

      it("ids are strings on the wire, whatever the database uses", async () => {
        // open-questions Q1: the key type is the database team's decision
        // (BIGINT IDENTITY, UNIQUEIDENTIFIER, ...), but `EntityId` is a
        // string and the frontend types every id as one. An adapter
        // returning a number breaks the contract even though TypeScript
        // might not notice through an `any`.
        await withRepo(async (repo) => {
          const user = await repo.create(userInput());

          assert.equal(typeof user.id, "string");
        });
      });

      it("the created user is findable by id, email and mobile", async () => {
        await withRepo(async (repo) => {
          const user = await repo.create(userInput());

          assert.equal((await repo.findById(user.id))?.id, user.id);
          assert.equal((await repo.findByEmail("aarav@test.local"))?.id, user.id);
          assert.equal((await repo.findByMobile("9876543210"))?.id, user.id);
        });
      });

      it("stores the role and status it was given", async () => {
        await withRepo(async (repo) => {
          const user = await repo.create(userInput({ role: "admin", status: "active" }));

          assert.equal(user.role, "admin");
          assert.equal(user.status, "active");
        });
      });

      it("throws DuplicateRecordError on a repeated email", async () => {
        await withRepo(async (repo) => {
          await repo.create(userInput());

          await assert.rejects(
            () => repo.create(userInput({ mobile: "9876500001" })),
            (err: unknown) => {
              assert.ok(
                err instanceof DuplicateRecordError,
                "must be DuplicateRecordError, never a driver error (handoff 9)",
              );
              return true;
            },
          );
        });
      });

      it("throws DuplicateRecordError on a repeated mobile", async () => {
        await withRepo(async (repo) => {
          await repo.create(userInput());

          await assert.rejects(
            () => repo.create(userInput({ email: "other@test.local" })),
            (err: unknown) => err instanceof DuplicateRecordError,
          );
        });
      });

      it("names the colliding field, so a service can map it to the right 409", async () => {
        // `registration.service.ts` reads `err.field` to decide between
        // "email_taken" and "mobile_taken". An adapter that throws a
        // DuplicateRecordError with an unhelpful field makes both
        // registrations report the wrong conflict.
        await withRepo(async (repo) => {
          await repo.create(userInput());

          await assert.rejects(
            () => repo.create(userInput({ email: "other@test.local" })),
            (err: unknown) => {
              assert.ok(err instanceof DuplicateRecordError);
              assert.match(err.field.toLowerCase(), /mobile/);
              return true;
            },
          );
        });
      });
    });

    describe("email is matched case-insensitively", () => {
      // handoff Q17: SQL Server's default collation is case-insensitive, but
      // the API must not DEPEND on that - the adapter is responsible either
      // way, because login and the duplicate check both resolve by email.
      it("findByEmail ignores case", async () => {
        await withRepo(async (repo) => {
          const user = await repo.create(userInput({ email: "Mixed.Case@Test.Local" }));

          const found = await repo.findByEmail("mixed.case@test.local");
          assert.equal(found?.id, user.id);
        });
      });

      it("existsByEmail ignores case", async () => {
        await withRepo(async (repo) => {
          await repo.create(userInput({ email: "Mixed.Case@Test.Local" }));

          assert.equal(await repo.existsByEmail("MIXED.CASE@TEST.LOCAL"), true);
        });
      });

      it("a differently-cased duplicate is still a duplicate", async () => {
        await withRepo(async (repo) => {
          await repo.create(userInput({ email: "aarav@test.local" }));

          await assert.rejects(
            () => repo.create(userInput({ email: "AARAV@TEST.LOCAL", mobile: "9876500002" })),
            (err: unknown) => err instanceof DuplicateRecordError,
          );
        });
      });
    });

    describe("writes against a missing record", () => {
      it("update throws RecordNotFoundError", async () => {
        await withRepo(async (repo) => {
          await assert.rejects(
            () => repo.update("user-nobody", { name: "New Name" }),
            (err: unknown) => err instanceof RecordNotFoundError,
          );
        });
      });

      it("setStatus throws RecordNotFoundError", async () => {
        await withRepo(async (repo) => {
          await assert.rejects(
            () => repo.setStatus("user-nobody", "active"),
            (err: unknown) => err instanceof RecordNotFoundError,
          );
        });
      });
    });

    describe("update and setStatus", () => {
      it("update patches only the fields given", async () => {
        await withRepo(async (repo) => {
          const user = await repo.create(userInput());

          const updated = await repo.update(user.id, { name: "Renamed" });

          assert.equal(updated.name, "Renamed");
          assert.equal(updated.email, "aarav@test.local", "email must be untouched");
          assert.equal(updated.status, "pending", "status must be untouched");
        });
      });

      it("setStatus changes status and nothing else", async () => {
        await withRepo(async (repo) => {
          const user = await repo.create(userInput());

          const updated = await repo.setStatus(user.id, "active");

          assert.equal(updated.status, "active");
          assert.equal(updated.name, user.name);
          assert.equal(updated.email, user.email);
        });
      });
    });

    describe("findMany", () => {
      it("returns the shared PaginatedResult shape", async () => {
        await withRepo(async (repo) => {
          await repo.create(userInput());

          const page = await repo.findMany({}, { page: 1, pageSize: 10 });

          assert.deepEqual(Object.keys(page).sort(), [
            "items",
            "page",
            "pageSize",
            "total",
            "totalPages",
          ]);
          assert.equal(page.page, 1);
          assert.equal(page.pageSize, 10);
          assert.equal(page.total, 1);
        });
      });

      it("is empty rather than null when nothing matches", async () => {
        await withRepo(async (repo) => {
          const page = await repo.findMany({}, { page: 1, pageSize: 10 });

          assert.deepEqual(page.items, []);
          assert.equal(page.total, 0);
        });
      });

      it("does not return the same row on two different pages", async () => {
        // handoff Q17: OFFSET/FETCH needs a deterministic ORDER BY. Without
        // a tiebreaker, rows can repeat or vanish across pages - a silent
        // data-integrity bug in any admin list.
        await withRepo(async (repo) => {
          for (let i = 0; i < 6; i += 1) {
            await repo.create(
              userInput({ email: `u${String(i)}@test.local`, mobile: `98765000${String(10 + i)}` }),
            );
          }

          const first = await repo.findMany({}, { page: 1, pageSize: 3 });
          const second = await repo.findMany({}, { page: 2, pageSize: 3 });

          const ids = [...first.items, ...second.items].map((u) => u.id);
          assert.equal(new Set(ids).size, ids.length, "pages must not overlap");
          assert.equal(ids.length, 6, "and must not skip rows");
        });
      });
    });

    describe("the port exposes no credential material", () => {
      it("a created user carries no password, hash or token field", async () => {
        // The users table is exactly where a hash is likely to live once
        // auth exists, and `Student extends User`, so a leak here reaches
        // every student response.
        await withRepo(async (repo) => {
          const user = await repo.create(userInput());

          const serialised = JSON.stringify(user);
          assert.ok(
            !/password|hash|token|otp|secret/i.test(serialised),
            `user record must carry no credential material: ${serialised}`,
          );
        });
      });
    });
  });
};
