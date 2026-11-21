import { randomUUID } from "node:crypto";

import { describeSessionRepositoryContract } from "./contracts/session-repository.contract";
import { InMemorySessionRepository } from "./fakes";

/**
 * Runs the SessionRepository contract against the in-memory fake.
 *
 * Only FIXTURE SETUP lives here; every assertion is in
 * tests/contracts/session-repository.contract.ts, so a future SQL Server
 * adapter reuses the identical suite with its own fixture:
 *
 *   describeSessionRepositoryContract("SqlServerSessionRepository", async () => ({
 *     repository: new SqlServerSessionRepository(pool),
 *     reset: () => truncateSessionTables(pool),  // sessions + consumed tokens
 *     makeUserId: () => insertUserRow(pool),     // satisfies the FK to users
 *   }));
 *
 * The concurrent-rotation tests prove the fake's semantics only; rotation
 * atomicity (conditional UPDATE + consumed-token INSERT in one transaction)
 * must be verified against a real database.
 */
describeSessionRepositoryContract("InMemorySessionRepository", async () => {
  // A fresh repository per fixture: each test gets isolated state. The fake
  // has no users table, so any fresh id is a valid owner.
  const repository = new InMemorySessionRepository();
  return {
    repository,
    reset: async () => {
      repository.reset();
    },
    makeUserId: async () => `user-${randomUUID()}`,
  };
});
