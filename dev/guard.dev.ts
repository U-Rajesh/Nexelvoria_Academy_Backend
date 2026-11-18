/**
 * The runtime guard for every development-only module in this directory.
 *
 * ============================ DEVELOPMENT ONLY ============================
 * Nothing in `dev/` may ever run in production. It exists so the Student
 * Registration service can be exercised over HTTP against the in-memory
 * fakes, BEFORE the MS SQL Server adapters and before the atomic
 * transaction required by open-questions Q-X1 exists.
 *
 * Four independent guards keep this out of production:
 *
 *  1. LOCATION - `dev/` is not in `tsconfig.json`'s `include`, and
 *     `rootDir` is `src`. `npm run build` compiles `src/` only, so nothing
 *     here is ever emitted to `dist/` and `node dist/server.js` cannot
 *     import it. This is the real guarantee; the rest are defence in depth.
 *  2. WIRING - `createProductionContainer()` registers no repositories, and
 *     `src/routes/index.ts` still mounts no `/auth` router. The production
 *     app has no registration endpoint at all.
 *  3. RUNTIME (fakes) - `InMemoryStore`'s constructor throws when
 *     NODE_ENV=production, so the repositories cannot even be constructed.
 *  4. RUNTIME (this file) - imported first by every module in `dev/`, so a
 *     production process fails before any app, config or route is built.
 * ==========================================================================
 */

/** The exact refusal message, exported so a test can assert on it. */
export const DEV_ONLY_REFUSAL =
  "dev/ is a development-only Student Registration harness and must never run with " +
  "NODE_ENV=production. It serves the registration service over in-memory fakes, and " +
  "its three writes are NOT atomic (open-questions Q-X1). Use `npm run dev` or " +
  "`npm start` for the production application, which mounts no registration route.";

/**
 * Throws unless this process is a development or test process.
 *
 * Takes the value as an argument (defaulting to the real environment) so the
 * refusal itself is unit-testable without mutating `process.env`.
 */
export const assertDevelopmentOnly = (
  nodeEnv: string | undefined = process.env["NODE_ENV"],
): void => {
  if (nodeEnv === "production") {
    throw new Error(DEV_ONLY_REFUSAL);
  }
};

// Enforced on import, not merely offered. A module that imports this file
// cannot be loaded in a production process.
assertDevelopmentOnly();
