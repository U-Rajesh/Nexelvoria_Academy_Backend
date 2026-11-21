import { describeUserRepositoryContract } from "./contracts/user-repository.contract";
import { InMemoryUserRepository } from "./fakes";

/**
 * Runs the UserRepository contract against the in-memory fake.
 *
 * Only FIXTURE SETUP lives here; every assertion is in
 * tests/contracts/user-repository.contract.ts, so a future SQL Server
 * adapter reuses the identical suite with its own fixture:
 *
 *   describeUserRepositoryContract("SqlServerUserRepository", async () => ({
 *     repository: new SqlServerUserRepository(pool),
 *     reset: () => truncateUserTables(pool),
 *   }));
 */
describeUserRepositoryContract("InMemoryUserRepository", async () => {
  // A fresh repository per fixture: each test gets isolated state.
  const repository = new InMemoryUserRepository();
  return {
    repository,
    reset: async () => {
      repository.reset();
    },
  };
});
