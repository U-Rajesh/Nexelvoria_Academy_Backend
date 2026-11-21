import "dotenv/config";

/**
 * Microsoft SQL Server connection configuration.
 *
 * ===========================================================================
 * SEPARATE FROM `env.ts`, AND VALIDATED ON DEMAND.
 *
 * `env.ts` throws at import time, which is right for values the process
 * cannot start without. The database is not yet one of those: no repository
 * adapter exists, `createProductionContainer()` registers nothing, and
 * `/api/v1/health` must keep answering whether or not SQL Server is
 * reachable.
 *
 * So this module parses when asked and reports problems as thrown errors the
 * caller chooses to handle, rather than killing the process on import.
 * ===========================================================================
 *
 * ===========================================================================
 * THE PASSWORD NEVER LEAVES THIS MODULE IN READABLE FORM.
 *
 * `SqlServerConfig.password` is the only place it is held, and
 * `describeSqlServerConfig()` is the ONLY approved way to describe this
 * configuration anywhere - a log line, an error, a health payload, a test
 * assertion. It omits the password entirely rather than masking it, because
 * a mask still invites someone to log the "safe" version of a secret.
 *
 * Never `JSON.stringify` a `SqlServerConfig`. Use the describe helper.
 * ===========================================================================
 */

export interface SqlServerConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  /** SENSITIVE. Never logged, never returned, never serialised. */
  password: string;
  /** TLS for the connection itself. Must be true anywhere but a local box. */
  encrypt: boolean;
  /**
   * Skips certificate verification. DEVELOPMENT ONLY.
   *
   * With this true, TLS still encrypts but no longer authenticates: anything
   * able to intercept the connection can present its own certificate. That
   * is why `loadSqlServerConfig` refuses it under NODE_ENV=production.
   */
  trustServerCertificate: boolean;
  poolMin: number;
  poolMax: number;
  /** Milliseconds to wait for a free pooled connection before failing. */
  acquireTimeoutMs: number;
  /** Milliseconds before an individual statement is cancelled. */
  requestTimeoutMs: number;
}

/** Thrown when the configuration is missing or unusable. */
export class SqlServerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlServerConfigError";
  }
}

/** The four values that identify the server. Nothing works without them. */
export const REQUIRED_SQLSERVER_VARS = [
  "SQLSERVER_HOST",
  "SQLSERVER_DATABASE",
  "SQLSERVER_USER",
  "SQLSERVER_PASSWORD",
] as const;

/**
 * Trims a value and treats whitespace as absent.
 *
 * `.env` files on Windows carry CRLF line endings, so a value read naively
 * ends with `\r` and is never empty - which is exactly how an unconfigured
 * placeholder gets mistaken for a real setting. Trimming here is not
 * cosmetic; it is what makes the required-variable check honest.
 */
const read = (source: NodeJS.ProcessEnv, key: string): string | undefined => {
  const value = source[key]?.trim();

  return value === undefined || value === "" ? undefined : value;
};

/** Parses a boolean flag. Anything other than true/false is an error. */
const readBoolean = (
  source: NodeJS.ProcessEnv,
  key: string,
  fallback: boolean,
): boolean => {
  const value = read(source, key)?.toLowerCase();

  if (value === undefined) {
    return fallback;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new SqlServerConfigError(
    `Invalid ${key} value: "${value}". Expected "true" or "false".`,
  );
};

const readInt = (
  source: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  { min = 0 }: { min?: number } = {},
): number => {
  const value = read(source, key);

  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < min) {
    throw new SqlServerConfigError(
      `Invalid ${key} value: "${value}". Expected an integer of at least ${String(min)}.`,
    );
  }

  return parsed;
};

/** Hosts for which unencrypted traffic never leaves the machine. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "(local)"]);

/** True when every required variable is present. Cheap, and never throws. */
export const isSqlServerConfigured = (
  source: NodeJS.ProcessEnv = process.env,
): boolean => REQUIRED_SQLSERVER_VARS.every((key) => read(source, key) !== undefined);

/**
 * Validates and returns the configuration.
 *
 * Throws `SqlServerConfigError` rather than returning something partial: a
 * half-configured connection fails later, further from its cause, and
 * usually inside a request.
 */
export const loadSqlServerConfig = (
  source: NodeJS.ProcessEnv = process.env,
): SqlServerConfig => {
  const missing = REQUIRED_SQLSERVER_VARS.filter((key) => read(source, key) === undefined);

  if (missing.length > 0) {
    // Names the variables, never any value - including the ones that ARE set.
    throw new SqlServerConfigError(
      `SQL Server is not configured. Missing: ${missing.join(", ")}. ` +
        "Set these in .env (which is gitignored) and never commit them.",
    );
  }

  const host = read(source, "SQLSERVER_HOST") ?? "";
  const encrypt = readBoolean(source, "SQLSERVER_ENCRYPT", true);
  const trustServerCertificate = readBoolean(
    source,
    "SQLSERVER_TRUST_SERVER_CERT",
    false,
  );

  const nodeEnv = source["NODE_ENV"]?.trim();

  /**
   * Production fails closed on both TLS settings.
   *
   * These are refusals rather than warnings because each silently removes a
   * protection while leaving configuration that looks correct:
   *
   *  - `encrypt: false` sends credentials and query data in clear text.
   *  - `trustServerCertificate: true` keeps the encryption but drops
   *    authentication, so an interceptor presenting any certificate is
   *    accepted - which is most of what TLS was there to prevent.
   */
  if (nodeEnv === "production") {
    if (!encrypt) {
      throw new SqlServerConfigError(
        "SQLSERVER_ENCRYPT must be true when NODE_ENV=production. An unencrypted " +
          "connection sends the database password and every row in clear text.",
      );
    }

    if (trustServerCertificate) {
      throw new SqlServerConfigError(
        "SQLSERVER_TRUST_SERVER_CERT must be false when NODE_ENV=production. It " +
          "disables certificate verification, so TLS no longer proves which server " +
          "you are talking to.",
      );
    }
  }

  if (!encrypt && !LOCAL_HOSTS.has(host.toLowerCase())) {
    throw new SqlServerConfigError(
      `SQLSERVER_ENCRYPT is false for a non-local host. Unencrypted traffic to a ` +
        "remote server exposes the password on the network. Set it to true, or use " +
        "a local server for unencrypted development.",
    );
  }

  const poolMin = readInt(source, "SQLSERVER_POOL_MIN", 0);
  const poolMax = readInt(source, "SQLSERVER_POOL_MAX", 10, { min: 1 });

  if (poolMin > poolMax) {
    throw new SqlServerConfigError(
      `SQLSERVER_POOL_MIN (${String(poolMin)}) cannot exceed SQLSERVER_POOL_MAX ` +
        `(${String(poolMax)}).`,
    );
  }

  return {
    host,
    port: readInt(source, "SQLSERVER_PORT", 1433, { min: 1 }),
    database: read(source, "SQLSERVER_DATABASE") ?? "",
    user: read(source, "SQLSERVER_USER") ?? "",
    password: read(source, "SQLSERVER_PASSWORD") ?? "",
    encrypt,
    trustServerCertificate,
    poolMin,
    poolMax,
    acquireTimeoutMs: readInt(source, "SQLSERVER_POOL_ACQUIRE_TIMEOUT_MS", 15_000, {
      min: 1,
    }),
    requestTimeoutMs: readInt(source, "SQLSERVER_REQUEST_TIMEOUT_MS", 15_000, { min: 1 }),
  };
};

/**
 * The ONLY approved way to describe this configuration.
 *
 * Carries no password and no `user:pass@host` string. Use it for every log
 * line, error context and diagnostic; never serialise the config itself.
 */
export const describeSqlServerConfig = (
  config: SqlServerConfig,
): Record<string, unknown> => ({
  server: `${config.host}:${String(config.port)}`,
  database: config.database,
  user: config.user,
  encrypt: config.encrypt,
  trustServerCertificate: config.trustServerCertificate,
  pool: `${String(config.poolMin)}-${String(config.poolMax)}`,
  requestTimeoutMs: config.requestTimeoutMs,
});
