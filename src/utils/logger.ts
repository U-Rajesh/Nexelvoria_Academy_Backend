import { env } from "../config/env";
import { redact } from "./redact";

/**
 * Structured logger.
 *
 * One seam for all logging: when we adopt pino or winston, only this file
 * changes. Do not call console.* anywhere else.
 *
 * Output is a single JSON object per line in production (machine-parsable
 * for a log aggregator) and a readable line in development. Every value
 * passes through `redact()`, so a password or token in a logged object is
 * replaced rather than printed.
 */

type Level = "debug" | "info" | "warn" | "error";

/**
 * Fields attached to a log line to correlate it with one request.
 *
 * Each optional field explicitly admits `undefined` because
 * `exactOptionalPropertyTypes` is on and these values come straight from
 * Express, where `req.requestId` and `req.ip` are legitimately optional.
 */
export interface LogContext {
  requestId?: string | undefined;
  method?: string | undefined;
  path?: string | undefined;
  statusCode?: number | undefined;
  durationMs?: number | undefined;
  ip?: string | undefined;
  userId?: string | undefined;
  role?: string | undefined;
  /** Any extra structured field. Values are redacted before output. */
  [key: string]: unknown;
}

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Debug is suppressed in production; tests stay quiet unless something fails. */
const minimumLevel = (): number => {
  if (env.NODE_ENV === "production") return LEVEL_ORDER.info;
  if (env.NODE_ENV === "test") return LEVEL_ORDER.error;
  return LEVEL_ORDER.debug;
};

const write = (level: Level, message: string, context?: LogContext): void => {
  if (LEVEL_ORDER[level] < minimumLevel()) {
    return;
  }

  const safeContext = context === undefined ? undefined : (redact(context) as LogContext);

  const line =
    env.NODE_ENV === "production"
      ? JSON.stringify({
          timestamp: new Date().toISOString(),
          level,
          message,
          ...safeContext,
        })
      : `${new Date().toISOString()} [${level.toUpperCase()}] ${message}${
          safeContext === undefined ? "" : ` ${JSON.stringify(safeContext)}`
        }`;

  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
};

export const logger = {
  debug: (message: string, context?: LogContext): void => write("debug", message, context),
  info: (message: string, context?: LogContext): void => write("info", message, context),
  warn: (message: string, context?: LogContext): void => write("warn", message, context),
  error: (message: string, context?: LogContext): void => write("error", message, context),
};
