import { randomUUID } from "node:crypto";

import { describeCredentialRepositoryContract } from "./contracts/credential-repository.contract";
import { InMemoryCredentialRepository } from "./fakes";

/**
 * Runs the CredentialRepository contract against the in-memory fake.
 *
 * Only FIXTURE SETUP lives here; every assertion is in
 * tests/contracts/credential-repository.contract.ts, so a future SQL Server
 * adapter reuses the identical suite with its own fixture:
 *
 *   describeCredentialRepositoryContract("SqlServerCredentialRepository", async () => ({
 *     repository: new SqlServerCredentialRepository(pool),
 *     reset: () => truncateCredentialTables(pool),
 *     makeUserId: () => insertUserRow(pool),          // satisfies the FK to users
 *     seedCredential: (row) => insertCredentialRow(pool, row),
 *   }));
 *
 * The concurrency tests in the suite prove the fake's semantics only; they
 * are meaningful for atomicity only when run against a real database.
 */
describeCredentialRepositoryContract("InMemoryCredentialRepository", async () => {
  // A fresh repository per fixture: each test gets isolated state. The fake
  // has no users table, so any fresh id is a valid owner.
  const repository = new InMemoryCredentialRepository();
  return {
    repository,
    reset: async () => {
      repository.reset();
    },
    makeUserId: async () => `user-${randomUUID()}`,
    seedCredential: async (record) => {
      repository.seed(record);
    },
  };
});
