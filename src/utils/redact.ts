/**
 * Removes sensitive values before anything reaches a log.
 *
 * This is the last line of defence, not the first: the logging middleware
 * does not log request bodies at all. But errors and debug calls can carry
 * arbitrary objects, so anything on its way to a log passes through here.
 */

/** Key names whose values must never be logged. Matched case-insensitively. */
const SENSITIVE_KEY_PATTERN =
  /(pass(word)?|secret|token|otp|authorization|auth|cookie|session|apikey|api[-_]?key|credential|signature|cvv|card|private[-_]?key)/i;

export const REDACTED = "[REDACTED]";

/** Header names stripped from logs regardless of value. */
const SENSITIVE_HEADERS = Object.freeze([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "proxy-authorization",
]);

const MAX_DEPTH = 6;

/**
 * Returns a copy of `value` with sensitive properties replaced.
 *
 * Handles cycles, depth-limits deep graphs, and converts Errors into a
 * plain object so the stack survives JSON serialisation.
 */
export const redact = (value: unknown, depth = 0, seen = new WeakSet<object>()): unknown => {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (depth >= MAX_DEPTH) {
    return "[TRUNCATED]";
  }

  if (seen.has(value)) {
    return "[CIRCULAR]";
  }

  seen.add(value);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1, seen));
  }

  const output: Record<string, unknown> = {};

  for (const [key, item] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redact(item, depth + 1, seen);
  }

  return output;
};

/** Strips sensitive headers. Used only where headers are logged at all. */
export const redactHeaders = (
  headers: Record<string, unknown>,
): Record<string, unknown> => {
  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    output[key] = SENSITIVE_HEADERS.includes(lower) || SENSITIVE_KEY_PATTERN.test(lower)
      ? REDACTED
      : value;
  }

  return output;
};

/**
 * Describes an error for a log line WITHOUT its message.
 *
 * Driver and database exceptions routinely embed secrets in their text:
 * `"Login failed for user 'sa'"`, connection strings, host names, ports,
 * sometimes a parameter value. `redact()` cannot help, because it replaces
 * values under sensitive KEYS and an exception message is free text under a
 * perfectly innocent key.
 *
 * So the message is dropped entirely and only the error's class name is
 * kept. That is enough to correlate an incident with the database's own
 * logs - which hold the detail, in a place that is already trusted with it -
 * while the operational context (user id, session id, operation) comes from
 * the caller's own structured fields.
 *
 * Use this for ANY error that originated below the application: repository
 * calls, drivers, network clients. For errors we construct ourselves the
 * message is ours and safe to log.
 */
export const describeError = (err: unknown): string => {
  if (err instanceof Error) {
    return err.name === "" ? "Error" : err.name;
  }

  // Never stringify the value itself: a thrown string or object could be
  // anything, including a credential.
  return typeof err === "object" && err !== null ? "UnknownObjectThrown" : typeof err;
};
