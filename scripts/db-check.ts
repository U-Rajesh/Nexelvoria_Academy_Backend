/**
 * `npm run db:check` - the SQL Server connectivity probe.
 *
 * Runs `SELECT 1` against the configured development database and reports
 * what happened. This is the script that decides whether SQL Server
 * connectivity can be CLAIMED: until it prints OK against the real database,
 * it cannot.
 *
 * It touches no table and modifies nothing, so it is safe to run against any
 * environment whose credentials you hold.
 *
 * NO PASSWORD IS PRINTED. Output is limited to host, port, database, user and
 * the TLS flags, via `describeSqlServerConfig`.
 *
 * Exit codes, so CI can use it:
 *   0  the probe succeeded
 *   1  the probe failed (unreachable, refused, timed out)
 *   2  SQL Server is not configured yet
 */
import {
  describeSqlServerConfig,
  isSqlServerConfigured,
  loadSqlServerConfig,
  REQUIRED_SQLSERVER_VARS,
  SqlServerConfigError,
} from "../src/config/sqlserver";
import { closeSqlServerPool, verifySqlServerConnection } from "../src/db/sqlserver.pool";

const main = async (): Promise<number> => {
  if (!isSqlServerConfigured()) {
    const missing = REQUIRED_SQLSERVER_VARS.filter((key) => {
      const value = process.env[key]?.trim();

      return value === undefined || value === "";
    });

    console.error("");
    console.error("  SQL Server is NOT CONFIGURED - the probe did not run.");
    console.error("");
    console.error(`  Missing or empty: ${missing.join(", ")}`);
    console.error("");
    console.error("  Set these in .env (gitignored, never committed) and re-run");
    console.error("  `npm run db:check`. Do not paste credentials into chat, a");
    console.error("  commit message, or .env.example.");
    console.error("");

    return 2;
  }

  let config;

  try {
    config = loadSqlServerConfig();
  } catch (err) {
    console.error("");
    console.error("  SQL Server configuration is INVALID - the probe did not run.");
    console.error("");
    console.error(
      `  ${err instanceof SqlServerConfigError ? err.message : "Unknown configuration error."}`,
    );
    console.error("");

    return 2;
  }

  // Safe fields only.
  console.log("");
  console.log("  Probing SQL Server with SELECT 1 ...");

  for (const [key, value] of Object.entries(describeSqlServerConfig(config))) {
    console.log(`    ${key.padEnd(23)} ${String(value)}`);
  }

  console.log("");

  const result = await verifySqlServerConnection(config);

  if (result.ok) {
    console.log("  SELECT 1 SUCCEEDED.");
    console.log(`    latency               ${String(result.latencyMs)} ms`);

    if (result.serverVersion !== undefined) {
      console.log(`    server                ${result.serverVersion}`);
    }

    console.log("");

    return 0;
  }

  console.error("  SELECT 1 FAILED.");
  console.error(`    driver error          ${result.driverErrorName ?? "unknown"}`);
  console.error(`    driver code           ${result.driverErrorCode ?? "unknown"}`);
  console.error(`    elapsed               ${String(result.latencyMs)} ms`);
  console.error("");
  console.error("  Common codes:");
  console.error("    ELOGIN    credentials rejected, or the user lacks access to the database");
  console.error("    ESOCKET   host unreachable, wrong port, or a firewall in the way");
  console.error("    ETIMEOUT  reachable but did not answer in time");
  console.error("    ENOTFOUND hostname does not resolve");
  console.error("");
  console.error("  A certificate failure usually means SQLSERVER_ENCRYPT=true against a");
  console.error("  server with a self-signed certificate. For LOCAL development only,");
  console.error("  SQLSERVER_TRUST_SERVER_CERT=true bypasses verification; never in");
  console.error("  production, where the configuration refuses to load.");
  console.error("");

  return 1;
};

void main()
  .then(async (code) => {
    await closeSqlServerPool();
    process.exit(code);
  })
  .catch(async (err: unknown) => {
    // A wrapped error carries only the driver's name and code, never its
    // message - so nothing sensitive can reach this output.
    console.error("");
    console.error("  The probe itself failed unexpectedly.");
    console.error(`  ${err instanceof Error ? `${err.name}: ${err.message}` : "Unknown error."}`);
    console.error("");

    await closeSqlServerPool();
    process.exit(1);
  });
