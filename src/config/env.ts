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
} as const;

export const isProduction = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";
