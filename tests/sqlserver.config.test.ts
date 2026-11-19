import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  REQUIRED_SQLSERVER_VARS,
  SqlServerConfigError,
  describeSqlServerConfig,
  isSqlServerConfigured,
  loadSqlServerConfig,
  type SqlServerConfig,
} from "../src/config/sqlserver";
import {
  SqlServerUnavailableError,
  closeSqlServerPool,
  describeDriverError,
  getSqlServerPool,
  isSqlServerPoolConnected,
  verifySqlServerConnection,
} from "../src/db/sqlserver.pool";

/**
 * A sentinel that must never appear in any output.
 *
 * Long and distinctive so a leak is unambiguous: if this string shows up in a
 * description, an error, or a log line, a real password would have too.
 */
const SENTINEL_PASSWORD = "p@ssw0rd-SENTINEL-DO-NOT-LEAK-7f3a9c";

/** A complete, valid environment. Nothing here touches the real `.env`. */
const validEnv = (overrides: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  SQLSERVER_HOST: "sql.example.internal",
  SQLSERVER_PORT: "1433",
  SQLSERVER_DATABASE: "NexelvoriaAcademy",
  SQLSERVER_USER: "nexelvoria_app",
  SQLSERVER_PASSWORD: SENTINEL_PASSWORD,
  SQLSERVER_ENCRYPT: "true",
  SQLSERVER_TRUST_SERVER_CERT: "false",
  SQLSERVER_POOL_MIN: "0",
  SQLSERVER_POOL_MAX: "10",
  SQLSERVER_POOL_ACQUIRE_TIMEOUT_MS: "15000",
  SQLSERVER_REQUEST_TIMEOUT_MS: "15000",
  ...overrides,
});

describe("sql server configuration", () => {
  describe("required variables", () => {
    it("reports unconfigured when any identity value is missing", () => {
      assert.equal(isSqlServerConfigured({}), false);

      for (const key of REQUIRED_SQLSERVER_VARS) {
        const env = validEnv();
        delete env[key];

        assert.equal(isSqlServerConfigured(env), false, `${key} must be required`);
      }
    });

    it("treats whitespace as missing, not as a value", () => {
      // Windows .env files are CRLF, so a naively-read value ends with "\r"
      // and looks non-empty. That is exactly how an unconfigured placeholder
      // gets mistaken for a real setting.
      assert.equal(isSqlServerConfigured(validEnv({ SQLSERVER_HOST: "   " })), false);
      assert.equal(isSqlServerConfigured(validEnv({ SQLSERVER_PASSWORD: "\r" })), false);
      assert.equal(isSqlServerConfigured(validEnv({ SQLSERVER_HOST: "\t\n" })), false);
    });

    it("reports configured when all four are present", () => {
      assert.equal(isSqlServerConfigured(validEnv()), true);
    });

    it("names the missing variables, and no values at all", () => {
      // The host sentinel must be DISTINCTIVE: an earlier version of this
      // test looked for "h", which also occurs inside "SQLSERVER_HOST" and
      // so could never pass.
      const hostSentinel = "host-SENTINEL-6b2e";

      try {
        loadSqlServerConfig({
          SQLSERVER_HOST: hostSentinel,
          SQLSERVER_PASSWORD: SENTINEL_PASSWORD,
        });
        assert.fail("expected a configuration error");
      } catch (err) {
        assert.ok(err instanceof SqlServerConfigError);
        assert.match(err.message, /SQLSERVER_DATABASE/);
        assert.match(err.message, /SQLSERVER_USER/);
        // Not even the values that WERE supplied may appear.
        assert.ok(!err.message.includes(SENTINEL_PASSWORD), "the password must not leak");
        assert.ok(!err.message.includes(hostSentinel), "no value may be echoed");
      }
    });
  });

  describe("parsing", () => {
    it("reads a complete configuration", () => {
      const config = loadSqlServerConfig(validEnv());

      assert.equal(config.host, "sql.example.internal");
      assert.equal(config.port, 1433);
      assert.equal(config.database, "NexelvoriaAcademy");
      assert.equal(config.user, "nexelvoria_app");
      assert.equal(config.encrypt, true);
      assert.equal(config.trustServerCertificate, false);
      assert.equal(config.poolMax, 10);
    });

    it("applies defaults for the optional values", () => {
      const config = loadSqlServerConfig({
        SQLSERVER_HOST: "h",
        SQLSERVER_DATABASE: "d",
        SQLSERVER_USER: "u",
        SQLSERVER_PASSWORD: SENTINEL_PASSWORD,
      });

      assert.equal(config.port, 1433);
      assert.equal(config.encrypt, true, "TLS must default to ON");
      assert.equal(
        config.trustServerCertificate,
        false,
        "certificate verification must default to ON",
      );
      assert.equal(config.poolMax, 10);
      assert.equal(config.requestTimeoutMs, 15_000);
    });

    it("rejects a non-boolean flag rather than guessing", () => {
      assert.throws(
        () => loadSqlServerConfig(validEnv({ SQLSERVER_ENCRYPT: "yes" })),
        /Expected "true" or "false"/,
      );
    });

    it("rejects a non-integer or out-of-range number", () => {
      assert.throws(() => loadSqlServerConfig(validEnv({ SQLSERVER_PORT: "abc" })), /Invalid/);
      assert.throws(() => loadSqlServerConfig(validEnv({ SQLSERVER_PORT: "0" })), /Invalid/);
      assert.throws(
        () => loadSqlServerConfig(validEnv({ SQLSERVER_POOL_MAX: "0" })),
        /Invalid/,
      );
      assert.throws(
        () => loadSqlServerConfig(validEnv({ SQLSERVER_REQUEST_TIMEOUT_MS: "-1" })),
        /Invalid/,
      );
    });

    it("rejects a pool minimum above its maximum", () => {
      assert.throws(
        () =>
          loadSqlServerConfig(
            validEnv({ SQLSERVER_POOL_MIN: "20", SQLSERVER_POOL_MAX: "10" }),
          ),
        /cannot exceed/,
      );
    });
  });

  describe("TLS is enforced, not merely configurable", () => {
    it("REFUSES encrypt=false in production", () => {
      // An unencrypted connection sends the password and every row in clear
      // text. A warning would be ignored; this must not load at all.
      assert.throws(
        () =>
          loadSqlServerConfig(
            validEnv({ NODE_ENV: "production", SQLSERVER_ENCRYPT: "false" }),
          ),
        /SQLSERVER_ENCRYPT must be true when NODE_ENV=production/,
      );
    });

    it("REFUSES trustServerCertificate=true in production", () => {
      // TLS still encrypts, but no longer authenticates - an interceptor
      // presenting any certificate would be accepted.
      assert.throws(
        () =>
          loadSqlServerConfig(
            validEnv({ NODE_ENV: "production", SQLSERVER_TRUST_SERVER_CERT: "true" }),
          ),
        /SQLSERVER_TRUST_SERVER_CERT must be false when NODE_ENV=production/,
      );
    });

    it("refuses encrypt=false against a REMOTE host, in any environment", () => {
      assert.throws(
        () => loadSqlServerConfig(validEnv({ SQLSERVER_ENCRYPT: "false" })),
        /non-local host/,
      );
    });

    it("permits encrypt=false for a local server only", () => {
      for (const host of ["localhost", "127.0.0.1", "::1", "(local)"]) {
        const config = loadSqlServerConfig(
          validEnv({ SQLSERVER_ENCRYPT: "false", SQLSERVER_HOST: host }),
        );

        assert.equal(config.encrypt, false, `${host} may run unencrypted`);
      }
    });

    it("allows trustServerCertificate=true outside production", () => {
      // Needed for a local server with a self-signed certificate.
      const config = loadSqlServerConfig(
        validEnv({ NODE_ENV: "development", SQLSERVER_TRUST_SERVER_CERT: "true" }),
      );

      assert.equal(config.trustServerCertificate, true);
    });

    it("the production refusals hold for the real NODE_ENV too", () => {
      // Guards against the check being accidentally keyed to the injected
      // object instead of the process environment.
      assert.throws(
        () =>
          loadSqlServerConfig({
            ...validEnv({ SQLSERVER_ENCRYPT: "false", SQLSERVER_HOST: "remote.example" }),
            NODE_ENV: "production",
          }),
        SqlServerConfigError,
      );
    });
  });

  describe("THE PASSWORD NEVER APPEARS IN ANY OUTPUT", () => {
    let config: SqlServerConfig;

    before(() => {
      config = loadSqlServerConfig(validEnv());
    });

    it("is absent from describeSqlServerConfig", () => {
      const described = describeSqlServerConfig(config);
      const serialised = JSON.stringify(described);

      assert.ok(!serialised.includes(SENTINEL_PASSWORD), "the password must not be described");
      assert.ok(!/password/i.test(serialised), "no password field may exist at all");
    });

    it("describes only the fields an operator needs", () => {
      assert.deepEqual(Object.keys(describeSqlServerConfig(config)).sort(), [
        "database",
        "encrypt",
        "pool",
        "requestTimeoutMs",
        "server",
        "trustServerCertificate",
        "user",
      ]);
    });

    it("is not masked but OMITTED - there is no 'safe' rendering to log", () => {
      const serialised = JSON.stringify(describeSqlServerConfig(config));

      assert.ok(!serialised.includes("***"));
      assert.ok(!serialised.includes("REDACTED"));
    });

    it("is absent from a wrapped driver error, including its message", () => {
      // The driver builds messages from the connection config, so a raw
      // message can carry the credential. The wrapper must not forward it.
      const driverError = Object.assign(
        new Error(`Login failed for user 'nexelvoria_app' password '${SENTINEL_PASSWORD}'`),
        { name: "ConnectionError", code: "ELOGIN" },
      );

      const wrapped = new SqlServerUnavailableError("connect", driverError);

      assert.ok(!wrapped.message.includes(SENTINEL_PASSWORD), "message must not leak it");
      assert.equal(wrapped.driverErrorName, "ConnectionError");
      assert.equal(wrapped.driverErrorCode, "ELOGIN");
      // Name and code are the whole diagnostic value.
      assert.match(wrapped.message, /ConnectionError\/ELOGIN/);
    });

    it("is absent from describeDriverError", () => {
      const driverError = Object.assign(
        new Error(`connect failed with password ${SENTINEL_PASSWORD}`),
        { name: "ConnectionError", code: "ESOCKET" },
      );

      const serialised = JSON.stringify(describeDriverError(driverError));

      assert.ok(!serialised.includes(SENTINEL_PASSWORD));
      assert.deepEqual(Object.keys(describeDriverError(driverError)).sort(), [
        "driverErrorCode",
        "driverErrorName",
      ]);
    });

    it("the original error is still reachable on `cause` for a debugger", () => {
      // Deliberate: `cause` is not walked by the logger, so keeping it costs
      // nothing while preserving the real diagnostic.
      const driverError = new Error("original detail");
      const wrapped = new SqlServerUnavailableError("query", driverError);

      assert.equal(wrapped.cause, driverError);
    });

    it("handles a non-Error cause without crashing", () => {
      for (const cause of [undefined, null, "a string", 42, {}]) {
        const wrapped = new SqlServerUnavailableError("connect", cause);

        assert.equal(wrapped.driverErrorName, "UnknownError");
        assert.ok(wrapped.message.length > 0);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Connectivity: needs the real development database
// ---------------------------------------------------------------------------

describe("sql server connectivity (SELECT 1)", () => {
  /**
   * These tests SKIP when SQL Server is not configured, and say so.
   *
   * A green `npm test` without a configured database is NOT evidence of
   * connectivity. The probe must succeed against the real development server
   * before that can be claimed - which is what `npm run db:check` is for.
   */
  const configured = isSqlServerConfigured();

  before(() => {
    if (!configured) {
      console.warn("");
      console.warn("  ── SQL SERVER CONNECTIVITY TESTS SKIPPED ─────────────────");
      console.warn("  SQLSERVER_HOST / DATABASE / USER / PASSWORD are not set.");
      console.warn("  Connectivity is UNVERIFIED until `npm run db:check` prints");
      console.warn("  SELECT 1 SUCCEEDED against the development database.");
      console.warn("  ──────────────────────────────────────────────────────────");
      console.warn("");
    }
  });

  after(async () => {
    // Safe either way: closing an unopened pool is a no-op.
    await closeSqlServerPool();
  });

  it("reports no pool before anything connects", (ctx) => {
    if (configured) {
      ctx.skip("a configured environment may already hold a pool");

      return;
    }

    assert.equal(isSqlServerPoolConnected(), false);
  });

  it("SELECT 1 succeeds against the development database", async (ctx) => {
    if (!configured) {
      ctx.skip(
        "NOT CONFIGURED: set SQLSERVER_HOST, SQLSERVER_DATABASE, SQLSERVER_USER and " +
          "SQLSERVER_PASSWORD in .env. Connectivity remains UNVERIFIED.",
      );

      return;
    }

    const result = await verifySqlServerConnection();

    assert.equal(
      result.ok,
      true,
      `SELECT 1 failed: ${result.driverErrorName ?? "?"}/${result.driverErrorCode ?? "?"}`,
    );
    assert.ok(result.latencyMs >= 0);
    assert.ok(isSqlServerPoolConnected(), "the pool must be connected afterwards");
  });

  it("returns the same pool instance on repeated calls", async (ctx) => {
    if (!configured) {
      ctx.skip("NOT CONFIGURED - pool sharing is unverified.");

      return;
    }

    const [first, second] = await Promise.all([getSqlServerPool(), getSqlServerPool()]);

    assert.equal(first, second, "one pool per process, shared by every module");
  });

  it("fails cleanly against an unreachable host, leaking nothing", async () => {
    // Runs WITHOUT a configured database: this is the failure path, and it
    // must behave the same either way. Port 1 is never listening.
    const result = await verifySqlServerConnection({
      host: "127.0.0.1",
      port: 1,
      database: "nope",
      user: "nobody",
      password: SENTINEL_PASSWORD,
      encrypt: false,
      trustServerCertificate: true,
      poolMin: 0,
      poolMax: 1,
      acquireTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
    });

    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes(SENTINEL_PASSWORD), "no credential may leak");
    assert.ok(result.driverErrorName !== undefined, "the driver error is still identified");
  });
});
