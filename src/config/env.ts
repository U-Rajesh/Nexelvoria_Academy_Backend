import { randomBytes } from "node:crypto";

import "dotenv/config";

/**
 * Centralised, validated access to environment variables.
 * Every module should read configuration from here instead of
 * touching `process.env` directly.
 *
 * Invalid configuration throws at import time, which means the process
 * fails at startup rather than at the first request that needs the value.
 */

type NodeEnv = "development" | "production" | "test";

const parsePort = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const port = Number(value);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT value: "${value}". Expected an integer between 1 and 65535.`);
  }

  return port;
};

const parseNodeEnv = (value: string | undefined): NodeEnv => {
  if (value === "production" || value === "test" || value === "development") {
    return value;
  }

  return "development";
};

/** Positive integer with a fallback, used for limits and windows. */
const parsePositiveInt = (name: string, value: string | undefined, fallback: number): number => {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name} value: "${value}". Expected a positive integer.`);
  }

  return parsed;
};

/**
 * Comma-separated list of allowed browser origins, e.g.
 *   CORS_ORIGINS=http://localhost:5173,https://app.nexelvoria.edu.in
 *
 * Each entry must be a bare scheme+host+port with no trailing slash and no
 * path, because that is exactly the string a browser sends in the `Origin`
 * header - comparing against anything else silently never matches.
 */
const parseOrigins = (value: string | undefined): readonly string[] => {
  if (value === undefined || value.trim() === "") {
    return [];
  }

  const origins = value
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  for (const origin of origins) {
    if (origin === "*") {
      throw new Error(
        'CORS_ORIGINS must not contain "*". List the frontend origins explicitly.',
      );
    }

    let parsed: URL;

    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`Invalid CORS_ORIGINS entry: "${origin}". Expected e.g. https://app.example.com`);
    }

    if (parsed.origin !== origin) {
      throw new Error(
        `Invalid CORS_ORIGINS entry: "${origin}". Use the bare origin with no trailing slash or path (expected "${parsed.origin}").`,
      );
    }
  }

  return Object.freeze(origins);
};

/**
 * Minimum accepted length for JWT_SECRET.
 *
 * HS256 keys shorter than the hash output (32 bytes) weaken the HMAC, and a
 * short secret is brute-forceable offline once an attacker holds one token.
 */
const MIN_JWT_SECRET_LENGTH = 32;

/**
 * Values that look like a secret but are not. Rejected outright so a
 * copy-pasted .env.example placeholder can never reach production.
 */
const JWT_SECRET_PLACEHOLDERS = new Set([
  "change-me",
  "changeme",
  "change_me",
  "secret",
  "jwt-secret",
  "your-secret-here",
  "replace-me",
  "replace-with-a-long-random-secret",
  "replace-with-a-long-random-secret-at-least-32-chars",
]);

/**
 * Label carried by every test-only JWT secret. A secret containing it is
 * refused in production, so a test value can never be promoted to a deploy.
 */
const TEST_ONLY_SECRET_MARKER = "test-only";

/**
 * Validates the JWT signing secret.
 *
 * Production fails closed: a missing, short or placeholder secret throws at
 * startup rather than signing tokens with something guessable.
 *
 * Outside production a missing secret falls back to a random, per-process
 * value so `npm run dev` works without configuration. The cost is explicit
 * and acceptable in development: tokens stop verifying when the process
 * restarts. A secret that IS supplied is validated in every environment, so
 * nobody develops against a weak key and ships it.
 */
const parseJwtSecret = (value: string | undefined, nodeEnv: NodeEnv): string => {
  const secret = value?.trim() ?? "";

  if (secret === "") {
    if (nodeEnv === "production") {
      throw new Error(
        "JWT_SECRET is required when NODE_ENV=production. Generate one with: " +
          "node -e \"console.log(require('node:crypto').randomBytes(48).toString('base64url'))\"",
      );
    }

    // Bootstrap-only console use: env.ts cannot import the logger because
    // the logger imports env, and this must be visible before anything else
    // loads. The secret itself is never printed.
    console.warn(
      "[config] JWT_SECRET is not set. Using a random per-process secret for " +
        `NODE_ENV=${nodeEnv}; tokens will not survive a restart. Set JWT_SECRET in .env.`,
    );

    // Under NODE_ENV=test the random secret is LABELLED test-only, so the
    // suite can assert it never runs on a real key (token.test.ts). The
    // label is not a weakness: the value is still 48 random bytes, and
    // production refuses any secret carrying it (below).
    const generated = randomBytes(48).toString("base64url");
    return nodeEnv === "test" ? `${TEST_ONLY_SECRET_MARKER}-${generated}` : generated;
  }

  if (nodeEnv === "production" && secret.toLowerCase().includes(TEST_ONLY_SECRET_MARKER)) {
    throw new Error(
      "JWT_SECRET is marked test-only and must never be used in production. Set a real random secret.",
    );
  }

  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET is too short (${secret.length} characters). ` +
        `At least ${MIN_JWT_SECRET_LENGTH} are required.`,
    );
  }

  if (JWT_SECRET_PLACEHOLDERS.has(secret.toLowerCase())) {
    throw new Error("JWT_SECRET is a placeholder value. Set a real random secret.");
  }

  return secret;
};

/** Non-secret identifier validation for issuer/audience. */
const parseJwtLabel = (name: string, value: string | undefined, fallback: string): string => {
  const label = value?.trim() ?? "";

  if (label === "") {
    return fallback;
  }

  if (label.length > 200) {
    throw new Error(`${name} is too long (max 200 characters).`);
  }

  return label;
};

const NODE_ENV = parseNodeEnv(process.env["NODE_ENV"]);
const CORS_ORIGINS = parseOrigins(process.env["CORS_ORIGINS"]);

/**
 * Production must declare its allowed origins. Falling back to a permissive
 * default in production is how a wildcard CORS policy reaches the internet,
 * so this fails closed instead.
 */
if (NODE_ENV === "production" && CORS_ORIGINS.length === 0) {
  throw new Error(
    "CORS_ORIGINS is required when NODE_ENV=production. Set it to the frontend origin(s), comma-separated.",
  );
}

export const env = {
  PORT: parsePort(process.env["PORT"], 4000),
  NODE_ENV,

  /** Allowed browser origins. Empty in dev means "use the dev defaults". */
  CORS_ORIGINS,

  /** Max accepted request body, passed to the body parsers. */
  BODY_LIMIT: process.env["BODY_LIMIT"]?.trim() ?? "1mb",

  /** General API rate limit: max requests per IP per window. */
  RATE_LIMIT_MAX: parsePositiveInt("RATE_LIMIT_MAX", process.env["RATE_LIMIT_MAX"], 300),

  /** General API rate limit window, in minutes. */
  RATE_LIMIT_WINDOW_MINUTES: parsePositiveInt(
    "RATE_LIMIT_WINDOW_MINUTES",
    process.env["RATE_LIMIT_WINDOW_MINUTES"],
    15,
  ),

  /**
   * HS256 signing secret for access tokens.
   *
   * SENSITIVE. Never log this value, never return it from an endpoint, and
   * never include it in an error message. `redact()` strips keys matching
   * /secret/, which covers it if an object carrying it is ever logged.
   */
  JWT_SECRET: parseJwtSecret(process.env["JWT_SECRET"], NODE_ENV),

  /** `iss` claim, validated on every verify. Not a secret. */
  JWT_ISSUER: parseJwtLabel("JWT_ISSUER", process.env["JWT_ISSUER"], "nexelvoria-academy"),

  /** `aud` claim, validated on every verify. Not a secret. */
  JWT_AUDIENCE: parseJwtLabel(
    "JWT_AUDIENCE",
    process.env["JWT_AUDIENCE"],
    "nexelvoria-academy-api",
  ),

  /**
   * Consecutive failed logins that lock a credential (decision D4).
   *
   * Lockout is PERMANENT until cleared (decision Q4a, option A): there is
   * no time-based unlock. Until password-reset or account-unlock APIs
   * exist, a locked account can only be recovered by a controlled database
   * intervention (`CredentialRepository.clearLockout`). See
   * docs/api-contracts.md, section 4.
   */
  MAX_FAILED_LOGIN_ATTEMPTS: parsePositiveInt(
    "MAX_FAILED_LOGIN_ATTEMPTS",
    process.env["MAX_FAILED_LOGIN_ATTEMPTS"],
    5,
  ),
} as const;

export const isProduction = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";
