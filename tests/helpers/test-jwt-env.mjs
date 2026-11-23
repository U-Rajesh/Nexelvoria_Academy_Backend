/**
 * Test-only JWT configuration, applied before anything reads the environment.
 *
 * Loaded by `npm test` through `tsx --import ./tests/helpers/test-jwt-env.mjs`.
 * Node runs an `--import` hook after it has processed `--env-file` and before
 * the main module, and the hook is inherited by every child process the
 * `node:test` runner spawns per test file - so these values are in place
 * before any test imports `src/config/env.ts`.
 *
 * ===========================================================================
 * WHY THIS IS NOT IN `.env.test`, WHICH IS WHERE YOU WOULD LOOK FIRST.
 *
 * `.env.test` is committed, and `tests/env-test-config.test.ts` guards it with
 * two rules. The first allow-lists its keys. The second is stricter and
 * deliberate: SECRET_KEY_PATTERN rejects any key whose NAME matches
 * /SECRET|PASSWORD|TOKEN|.../, and it is commented "names that must never
 * appear, EVEN IF ALLOW-LISTED LATER".
 *
 * `JWT_SECRET` matches that pattern. Putting it in `.env.test` would mean
 * relaxing a security guard in order to satisfy a security test, which is a
 * bad trade however it is written up. So the value lives here instead: a file
 * under `tests/`, which `tsconfig.json` does not include, so it can never be
 * emitted to `dist/` or imported by the built application.
 *
 * `JWT_ISSUER` and `JWT_AUDIENCE` are not secrets and would be allowed in
 * `.env.test`. They are kept here anyway, beside the secret they belong with,
 * so the JWT test configuration is one thing in one place rather than two
 * halves in two files.
 * ===========================================================================
 *
 * ===========================================================================
 * THESE ASSIGNMENTS OVERRIDE, AND THAT IS THE WHOLE POINT.
 *
 * `src/config/env.ts` imports `dotenv/config`, which loads a developer's local
 * `.env` with dotenv's default `override: false` - so whatever `.env` holds
 * wins over a built-in default but loses to anything already in
 * `process.env`. Assigning here, ahead of that import, is therefore what
 * makes the suite HERMETIC: a real `JWT_SECRET` in someone's `.env`, or one
 * exported by a CI runner, cannot change a test result or get exercised by
 * the suite.
 *
 * That is not hypothetical. Before this file existed, `.env` supplied the
 * JWT configuration to every test run, and `tests/token.test.ts` failed
 * because the suite was reading a real development secret. There is no
 * legitimate reason for the unit tests to sign anything with a real key.
 * ===========================================================================
 *
 * NOTHING HERE IS A SECRET. These values sign and verify tokens that exist
 * only inside a test process; they are not accepted by any deployed
 * environment, and production configuration is untouched - `env.ts` still
 * refuses to start without a real `JWT_SECRET` when NODE_ENV=production.
 */

/**
 * Satisfies every rule `parseJwtSecret` and `tests/token.test.ts` impose:
 * at least 32 characters, not one of the rejected placeholder values, and
 * self-describing via "test-only" so an accidental leak into a real
 * environment is obvious on sight rather than mistaken for a live key.
 */
process.env["JWT_SECRET"] =
  "test-only-jwt-signing-key-for-the-automated-suite-not-a-real-secret";

/** Both carry "test", which is what distinguishes them from a real deployment. */
process.env["JWT_ISSUER"] = "nexelvoria-academy-test";
process.env["JWT_AUDIENCE"] = "nexelvoria-academy-test-clients";

// Increase SQL Server timeout for test probe to absorb network jitter
process.env["SQLSERVER_POOL_ACQUIRE_TIMEOUT_MS"] = "30000";
process.env["SQLSERVER_REQUEST_TIMEOUT_MS"] = "30000";
