import express, { type Application, type RequestHandler, type Router } from "express";
import cors from "cors";
import helmet from "helmet";

// Side-effect import: installs our Request augmentations (req.user,
// req.validatedQuery, req.requestId). Must be imported once, before
// anything uses them.
import "./contracts/express.contract";

import { buildCorsOptions } from "./config/cors";
import { createProductionContainer, type AppContainer } from "./container/container";
import { env } from "./config/env";
import { helmetOptions } from "./config/security";
import { errorHandler } from "./middleware/error.middleware";
import { notFoundHandler } from "./middleware/not-found.middleware";
import { apiRateLimiter } from "./middleware/rate-limit.middleware";
import { requestContext } from "./middleware/request-context.middleware";
import { requestLogger } from "./middleware/request-logger.middleware";
import { createApiV1Router } from "./routes";

/**
 * Builds and configures the Express application.
 *
 * Intentionally does NOT start a server - see src/server.ts. Keeping the
 * two apart is what lets tests exercise the app over an in-memory request
 * without binding a port.
 *
 * Middleware order is significant and must stay as written:
 *   1. request id        - first, so every later log line can be correlated
 *   2. request logging   - starts the timer before any work happens
 *   3. security headers
 *   4. CORS
 *   5. rate limiting     - before body parsing, so a flood is rejected
 *                          without paying to parse its payload
 *   6. body parsers      - with size limits
 *   7. routes
 *   8. 404
 *   9. error handler     - last
 */
export interface CreateAppOptions {
  /**
   * Application dependencies. Defaults to the production container, which
   * registers no repositories because the MS SQL Server adapters do not
   * exist yet. Tests pass a container backed by in-memory fakes.
   */
  container?: AppContainer;

  /**
   * Extra routes to mount under `/api/v1`, after the registered modules and
   * BEFORE the 404 handler.
   *
   * Exists for ONE reason: a router added to the returned app would sit
   * behind `notFoundHandler` and never be reached, so a local harness cannot
   * extend the real application from outside without this seam.
   *
   * PRODUCTION PASSES NOTHING. `src/server.ts` calls `createApp()` with no
   * options, so this is inert there. It is NOT a place to register a feature
   * module - those belong in `src/routes/index.ts`, which is the only route
   * registry. Today its single caller is `dev/server.dev.ts`, the
   * development-only Student Registration harness, which is excluded from the
   * build (see dev/guard.dev.ts).
   */
  extraV1Routes?: Router;

  /**
   * Authentication middleware, forwarded to the route registry.
   *
   * PRODUCTION PASSES NOTHING, exactly like `extraV1Routes`:
   * `src/server.ts` calls `createApp()` with no options, so this is inert
   * there and every guarded route continues to fail closed with 401.
   *
   * Its one caller today is `dev/server.dev.ts`, which supplies a real
   * `createAuthenticate({ sessions })` over the in-memory session store so
   * the admin approval flow can be exercised end to end. Wiring it in
   * production requires a registered session adapter and is the backend
   * lead's decision - see the note in `src/routes/index.ts`.
   */
  authenticate?: RequestHandler;
}

export const createApp = (options: CreateAppOptions = {}): Application => {
  const container = options.container ?? createProductionContainer();
  const app = express();

  // Number of proxies in front of this process. Must match reality: too
  // high lets a client spoof X-Forwarded-For and evade rate limiting, too
  // low makes every client share the proxy's IP. 1 assumes a single
  // reverse proxy / load balancer.
  app.set("trust proxy", 1);

  // Do not advertise the framework.
  app.disable("x-powered-by");

  // Reject obviously malformed query strings rather than guessing.
  app.set("query parser", "extended");

  // 1. Correlation id, echoed as X-Request-Id.
  app.use(requestContext);

  // 2. One structured log line per completed request (metadata only).
  app.use(requestLogger);

  // 3. Security headers.
  app.use(helmet(helmetOptions));

  // 4. CORS, restricted to configured origins. Production refuses to start
  //    without CORS_ORIGINS, so there is no permissive production default.
  app.use(cors(buildCorsOptions()));

  // 5. Rate limiting, before the body is read.
  app.use("/api", apiRateLimiter);

  // 6. Body parsers with explicit size limits.
  app.use(express.json({ limit: env.BODY_LIMIT }));
  app.use(express.urlencoded({ extended: true, limit: env.BODY_LIMIT }));

  // 7. Versioned API routes, built over the injected dependencies.
  app.use(
    "/api/v1",
    createApiV1Router(container, options.extraV1Routes, options.authenticate),
  );

  // 8. Unmatched route -> 404 via the error pipeline.
  app.use(notFoundHandler);

  // 9. Central error handler. Must be registered last.
  app.use(errorHandler);

  return app;
};
