import type { CorsOptions } from "cors";

import { env } from "./env";

/**
 * CORS policy.
 *
 * The decision logic is exported as a pure function so it can be unit
 * tested without starting a server or juggling environment variables.
 */

/** Origins allowed automatically in development only. */
export const DEV_ORIGINS = Object.freeze([
  "http://localhost:5173", // Vite default
  "http://localhost:4173", // Vite preview
  "http://127.0.0.1:5173",
]);

/**
 * Decides whether a browser `Origin` is allowed.
 *
 * `undefined` means the request carried no Origin header - that is a
 * non-browser caller (curl, Postman, a health probe, server-to-server).
 * CORS exists to protect browser users from cross-site reads, and a client
 * with no Origin is not subject to it, so these are allowed. This is NOT a
 * bypass: without a browser there is no ambient cookie or session to abuse,
 * and authorization is still enforced separately.
 */
export const isOriginAllowed = (
  origin: string | undefined,
  allowed: readonly string[],
): boolean => {
  if (origin === undefined) {
    return true;
  }

  return allowed.includes(origin);
};

/**
 * Resolves the effective allow-list.
 *
 * Production never falls back to the dev defaults: `env.ts` already refuses
 * to start a production process without CORS_ORIGINS, so an empty list here
 * in production means nothing is allowed rather than everything.
 */
export const resolveAllowedOrigins = (): readonly string[] => {
  if (env.CORS_ORIGINS.length > 0) {
    return env.CORS_ORIGINS;
  }

  return env.NODE_ENV === "production" ? [] : DEV_ORIGINS;
};

/** Builds the options object handed to the `cors` middleware. */
export const buildCorsOptions = (allowed: readonly string[] = resolveAllowedOrigins()): CorsOptions => ({
  origin: (origin, callback) => {
    if (isOriginAllowed(origin, allowed)) {
      // Reflect the specific origin rather than "*", which is required for
      // credentialed requests and avoids a blanket public policy.
      callback(null, true);
      return;
    }

    // Deny by NOT setting the CORS headers. We deliberately do not pass an
    // error here: an error would surface as a 500. Omitting the headers is
    // the correct CORS denial - the browser blocks the read itself.
    callback(null, false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
  exposedHeaders: ["X-Request-Id", "RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset"],
  maxAge: 600,
});
