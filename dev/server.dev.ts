// Side-effect import: refuses to start when NODE_ENV=production. MUST stay
// the first import - import bodies run in order, so this executes before any
// config is read, any fake is constructed and any port is bound.
import "./guard.dev";

import { Router } from "express";

import { createApp } from "../src/app";
import { env } from "../src/config/env";
import { logger } from "../src/utils/logger";
import { createDevAuthRoutes } from "./auth.dev.routes";
import {
  createDevAuthenticate,
  createDevContainer,
  createDevLoginService,
  createDevRegistrationDeps,
  createDevVerificationService,
  seedDevAccounts,
} from "./container.dev";

/**
 * DEVELOPMENT ONLY - the local Student Registration integration server.
 *
 * Start with:  npm run dev:integration
 *
 * It is the SAME application as `npm run dev` - `createApp()` builds it, so
 * the middleware order, security headers, CORS policy, body limits, rate
 * limiting and error pipeline are byte-for-byte what production uses - with
 * exactly two differences, both confined to this file:
 *
 *   1. the container is backed by the in-memory fakes, not MS SQL Server;
 *   2. one extra router, `/auth`, is mounted under `/api/v1`.
 *
 * WHAT THIS IS NOT:
 *   - not a database (state is this process's memory; a restart clears it)
 *   - not atomic (three sequential writes; open-questions Q-X1)
 *   - not a login or OTP flow (neither is implemented; Q3 unresolved)
 *   - not resume storage (Q11 unresolved; `resumeDataUrl` is ignored)
 *   - NOT FOR PRODUCTION, and structurally incapable of running there
 */

const container = createDevContainer();

// Mounted under /api/v1 by createApp, BEFORE the 404 handler. A router added
// to the app after createApp() returns would sit behind notFoundHandler and
// never be reached.
const extraV1Routes = Router();
extraV1Routes.use(
  "/auth",
  createDevAuthRoutes({
    deps: createDevRegistrationDeps(container),
    verification: createDevVerificationService(container),
    login: createDevLoginService(container),
  }),
);

// Passing `authenticate` is what makes `req.principal` exist, and therefore
// what makes the admin approval endpoints reachable. Production passes
// nothing (`createApp()` with no options), so there every guarded route
// still fails closed with 401 - unchanged by this harness.
const app = createApp({
  container,
  extraV1Routes,
  authenticate: createDevAuthenticate(container),
});

const server = app.listen(env.PORT, () => {
  logger.warn(
    "DEVELOPMENT-ONLY registration harness: in-memory repositories, NOT atomic (Q-X1), " +
      "no OTP, no login, no database. State is lost on restart. Never run this in production.",
  );
  logger.info(`NEXELVORIA dev integration server on http://localhost:${env.PORT}`);
  logger.info(`Environment: ${env.NODE_ENV}`);
  logger.info(`Health:   http://localhost:${env.PORT}/api/v1/health`);
  logger.info(`Register: POST http://localhost:${env.PORT}/api/v1/auth/register`);
  logger.info(`Verify:   POST http://localhost:${env.PORT}/api/v1/auth/otp/email/verify`);
  logger.info(`Resend:   POST http://localhost:${env.PORT}/api/v1/auth/otp/email/resend`);
  logger.info(`Login:    POST http://localhost:${env.PORT}/api/v1/auth/login`);
  logger.info(`Approve:  POST http://localhost:${env.PORT}/api/v1/students/:studentId/approve`);
  logger.info(`Reject:   POST http://localhost:${env.PORT}/api/v1/students/:studentId/reject`);

  logger.info(`Repositories (in-memory): ${container.registered().join(", ")}`);

  // Seeded last so the credentials are the final thing on screen. Passwords
  // are generated per process (or read from the environment) - see
  // seedDevAccounts.
  void seedDevAccounts(container)
    .then((accounts) => {
      logger.warn(
        "DEVELOPMENT STAFF ACCOUNTS SEEDED - admin, teacher and super_admin. Generated " +
          "passwords are lost on restart. Never seed accounts like this outside development.",
        { roles: accounts.map((a) => a.role).join(", ") },
      );

      /**
       * Printed with console, NOT the logger, and deliberately so.
       *
       * `redact()` strips any context key matching /pass/ - which is exactly
       * right, and why the log line above carries no password. Rather than
       * weaken that control for one convenience, the credentials go straight
       * to stdout from a file that is excluded from the build and refuses to
       * load under NODE_ENV=production. `src/config/env.ts` prints its own
       * bootstrap warning the same way: some messages must not pass through
       * the pipeline they describe.
       *
       * THIS IS THE ONLY PLACE A DEVELOPMENT PASSWORD IS EVER SHOWN. No
       * endpoint returns one and no frontend file contains one.
       */
      console.warn("");
      console.warn("  ── DEVELOPMENT SIGN-IN (local terminal only) ──────────────");

      for (const account of accounts) {
        const source = account.fromEnvironment ? "from environment" : "generated";
        console.warn(`  ${account.role.padEnd(11)} ${account.email}`);
        console.warn(`  ${" ".repeat(11)} ${account.password}   (${source})`);
      }

      console.warn("  ───────────────────────────────────────────────────────────");
      console.warn("  Sign in at http://localhost:5173/login");
      console.warn("  Set DEV_SEED_<ROLE>_PASSWORD in .env for a stable password.");
      console.warn("");
    })
    .catch((err: unknown) => {
      logger.error("could not seed the development accounts", { err });
    });
});

const shutdown = (signal: string): void => {
  logger.info(`${signal} received, shutting down gracefully...`);

  server.close(() => {
    logger.info("Dev integration server closed.");
    process.exit(0);
  });
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// A process in an unknown state must not keep serving traffic - mirrors
// src/server.ts so local failure behaviour matches the real server's.
process.on("unhandledRejection", (reason: unknown) => {
  logger.error("unhandled promise rejection - shutting down", { err: reason });
  server.close(() => process.exit(1));
});

process.on("uncaughtException", (error: Error) => {
  logger.error("uncaught exception - shutting down", { err: error });
  server.close(() => process.exit(1));
});
