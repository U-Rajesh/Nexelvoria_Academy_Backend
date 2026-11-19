import sql from "mssql";

import {
  describeSqlServerConfig,
  loadSqlServerConfig,
  type SqlServerConfig,
} from "../config/sqlserver";
import { logger } from "../utils/logger";

/**
 * The one SQL Server connection pool, shared by every backend module.
 *
 * ===========================================================================
 * ONE POOL PER PROCESS, NOT ONE PER MODULE.
 *
 * `mssql` already pools: a `ConnectionPool` holds up to `poolMax` sockets and
 * hands them out per request. Creating one per repository would multiply that
 * ceiling by the number of repositories and exhaust the server's connection
 * limit - the database team sizes their limit against APPLICATION INSTANCES,
 * not against how many classes we happen to have.
 *
 * So the pool is created once, lazily, and every adapter receives the same
 * instance. `getSqlServerPool()` is the only way to obtain it.
 * ===========================================================================
 *
 * ===========================================================================
 * WHY EVERY DRIVER ERROR IS WRAPPED BEFORE IT ESCAPES.
 *
 * This is the highest-risk leak point in the whole integration.
 * `mssql` and `tedious` routinely build messages from the connection
 * configuration, and a failed login or a DNS error can arrive carrying the
 * server, the user, and in some shapes the PASSWORD itself. Anything that
 * then logs `err.message`, returns it in a 500, or lets it reach an error
 * tracker has published the credential.
 *
 * `SqlServerUnavailableError` therefore carries ONLY the original error's
 * name and code - never its message, and never the configuration. The
 * original is kept on `cause` for a debugger, which is deliberate: `cause`
 * is not walked by our logger, and `redact()` strips key names matching
 * /pass|secret|credential/ as a second line of defence.
 * ===========================================================================
 */

/** A failure reaching or using SQL Server, with nothing sensitive attached. */
export class SqlServerUnavailableError extends Error {
  /** The driver's error name, e.g. "ConnectionError". Safe to log. */
  readonly driverErrorName: string;
  /** The driver's error code, e.g. "ELOGIN", "ETIMEOUT". Safe to log. */
  readonly driverErrorCode: string;

  constructor(operation: string, cause: unknown) {
    const name = cause instanceof Error ? cause.name : "UnknownError";
    const code =
      typeof cause === "object" && cause !== null && "code" in cause
        ? String((cause as { code: unknown }).code)
        : "UNKNOWN";

    // The driver's own message is EXCLUDED on purpose - see the note above.
    super(
      `SQL Server is unavailable during "${operation}" (${name}/${code}). ` +
        "See the server log for the correlated entry.",
    );

    this.name = "SqlServerUnavailableError";
    this.driverErrorName = name;
    this.driverErrorCode = code;
    this.cause = cause;
  }
}

/**
 * A safe summary of a driver error, for logging.
 *
 * Name and code only. `ELOGIN` already tells an operator "wrong credentials"
 * and `ESOCKET` tells them "cannot reach the host", which is the whole
 * diagnostic value - the message adds nothing a log should carry.
 */
export const describeDriverError = (err: unknown): Record<string, unknown> => ({
  driverErrorName: err instanceof Error ? err.name : "UnknownError",
  driverErrorCode:
    typeof err === "object" && err !== null && "code" in err
      ? String((err as { code: unknown }).code)
      : "UNKNOWN",
});

/** Builds the driver config. Not exported: it holds the password. */
const toDriverConfig = (config: SqlServerConfig): sql.config => ({
  server: config.host,
  port: config.port,
  database: config.database,
  user: config.user,
  password: config.password,
  connectionTimeout: config.acquireTimeoutMs,
  requestTimeout: config.requestTimeoutMs,
  options: {
    encrypt: config.encrypt,
    trustServerCertificate: config.trustServerCertificate,
    // SQL Server 2025 default. Stated rather than inferred so a driver
    // default change cannot silently alter behaviour.
    enableArithAbort: true,
  },
  pool: {
    min: config.poolMin,
    max: config.poolMax,
    // How long an idle socket is kept. Shorter than most server-side
    // timeouts, so the pool discards a connection before the server does -
    // otherwise the first query on a reused socket fails.
    idleTimeoutMillis: 30_000,
    acquireTimeoutMillis: config.acquireTimeoutMs,
  },
});

/**
 * The process-wide pool, and the in-flight promise that creates it.
 *
 * The promise is cached as well as the pool: two concurrent first calls must
 * not each start a connection. Without it, a burst at startup opens several
 * pools and only one is ever remembered - the rest leak.
 */
let pool: sql.ConnectionPool | undefined;
let connecting: Promise<sql.ConnectionPool> | undefined;

/**
 * Returns the shared pool, connecting on first use.
 *
 * Throws `SqlServerUnavailableError` when the server cannot be reached and
 * `SqlServerConfigError` when the configuration is unusable. It never
 * returns a pool that is not connected.
 */
export const getSqlServerPool = async (
  config: SqlServerConfig = loadSqlServerConfig(),
): Promise<sql.ConnectionPool> => {
  if (pool?.connected === true) {
    return pool;
  }

  connecting ??= (async (): Promise<sql.ConnectionPool> => {
    const created = new sql.ConnectionPool(toDriverConfig(config));

    /**
     * An 'error' listener is MANDATORY, not hygiene.
     *
     * `ConnectionPool` is an EventEmitter, and an unhandled 'error' event
     * terminates the process. These fire for transient socket drops that the
     * pool recovers from on its own, so the process must survive them.
     */
    created.on("error", (err: unknown) => {
      logger.error("sql server pool error", describeDriverError(err));
    });

    try {
      await created.connect();
    } catch (err) {
      // Logged with name/code only, then re-thrown wrapped.
      logger.error("sql server connection failed", {
        ...describeDriverError(err),
        ...describeSqlServerConfig(config),
      });

      // Reset so a later call can retry rather than awaiting a dead promise.
      connecting = undefined;

      throw new SqlServerUnavailableError("connect", err);
    }

    pool = created;

    // Host, database, user and TLS flags - never the password.
    logger.info("sql server pool connected", describeSqlServerConfig(config));

    return created;
  })();

  return connecting;
};

/** True when a connected pool exists. Used by diagnostics; never connects. */
export const isSqlServerPoolConnected = (): boolean => pool?.connected === true;

/**
 * Closes the pool and forgets it.
 *
 * Tolerates an already-broken connection: shutdown must not hang on a
 * database that has gone away.
 */
export const closeSqlServerPool = async (): Promise<void> => {
  const existing = pool;

  pool = undefined;
  connecting = undefined;

  if (existing === undefined) {
    return;
  }

  try {
    await existing.close();
    logger.info("sql server pool closed");
  } catch (err) {
    logger.warn("sql server pool did not close cleanly", describeDriverError(err));
  }
};

/** What `SELECT 1` tells us. */
export interface SqlServerConnectivity {
  ok: boolean;
  /** Round trip for the probe, in milliseconds. */
  latencyMs: number;
  /** `@@VERSION`, trimmed to its first line. Not sensitive. */
  serverVersion?: string;
  /** Present only on failure: driver name/code, never a message. */
  driverErrorName?: string;
  driverErrorCode?: string;
}

/**
 * The connectivity probe: `SELECT 1`.
 *
 * ===========================================================================
 * WHY `SELECT 1` AND NOTHING MORE.
 *
 * It is the smallest statement that proves the whole path end to end - DNS,
 * TCP, the TLS handshake, authentication, database selection, and the
 * server's willingness to execute a query. It touches no table, so it cannot
 * be affected by a schema we have not seen and cannot modify anything.
 *
 * `@@VERSION` is read alongside it purely to confirm WHICH server answered,
 * which is worth knowing the first time a connection is made.
 * ===========================================================================
 *
 * Never throws: connectivity failure is the expected answer when the
 * database is not configured or not reachable, and a probe that throws
 * cannot be used in a health check.
 */
export const verifySqlServerConnection = async (
  config: SqlServerConfig = loadSqlServerConfig(),
): Promise<SqlServerConnectivity> => {
  const startedAt = Date.now();

  try {
    const connected = await getSqlServerPool(config);
    const result = await connected.request().query<{
      probe: number;
      version: string;
    }>("SELECT 1 AS probe, @@VERSION AS version");

    const row = result.recordset[0];
    const latencyMs = Date.now() - startedAt;

    if (row?.probe !== 1) {
      logger.error("sql server probe returned an unexpected result", { latencyMs });

      return { ok: false, latencyMs };
    }

    const serverVersion = row.version.split("\n")[0]?.trim();

    logger.info("sql server probe succeeded", {
      latencyMs,
      ...(serverVersion === undefined ? {} : { serverVersion }),
    });

    return {
      ok: true,
      latencyMs,
      ...(serverVersion === undefined ? {} : { serverVersion }),
    };
  } catch (err) {
    const described = describeDriverError(err);

    logger.error("sql server probe failed", { ...described, latencyMs: Date.now() - startedAt });

    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      driverErrorName: String(described["driverErrorName"]),
      driverErrorCode: String(described["driverErrorCode"]),
    };
  }
};
