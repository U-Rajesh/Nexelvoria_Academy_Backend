import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Guards the committed `.env.test`.
 *
 * The file is tracked in git so a fresh clone can run `npm test` with no
 * manual setup. That is only safe while it holds NO secrets, so this test
 * fails the suite the moment anything outside the allow-list is added.
 * To add a genuinely non-secret variable, extend ALLOWED_KEYS in review.
 */

const ENV_TEST_PATH = resolve(__dirname, "..", ".env.test");

/** Exactly the variables src/config/env.ts reads. */
const ALLOWED_KEYS = [
  "NODE_ENV",
  "PORT",
  "CORS_ORIGINS",
  "BODY_LIMIT",
  "RATE_LIMIT_MAX",
  "RATE_LIMIT_WINDOW_MINUTES",
  // Non-secret JWT labels (env.ts `parseJwtLabel`); the token tests require
  // them to identify the test environment.
  "JWT_ISSUER",
  "JWT_AUDIENCE",
  // Secret-named, so allowed ONLY with an empty value (see below). Pinning
  // it empty stops a developer's local `.env` secret leaking into tests.
  "JWT_SECRET",
] as const;

/**
 * Secret-named keys that may appear ONLY to pin them empty. Any value at all
 * fails the suite - a committed file must never carry a secret.
 */
const MUST_BE_EMPTY = ["JWT_SECRET"] as const;

/** Belt and braces: secret-looking names. Each must be in MUST_BE_EMPTY and empty. */
const SECRET_KEY_PATTERN = /(SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|PRIVATE|CREDENTIAL|CONNECTION|DSN|_KEY$)/i;

/** Minimal KEY=VALUE parser: skips blanks and comments. */
const parseEnvFile = (text: string): Map<string, string> => {
  const entries = new Map<string, string>();

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    assert.ok(eq > 0, `Malformed line in .env.test: "${line}"`);

    entries.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }

  return entries;
};

describe(".env.test (committed test configuration)", () => {
  const entries = parseEnvFile(readFileSync(ENV_TEST_PATH, "utf8"));

  it("sets NODE_ENV=test", () => {
    assert.equal(entries.get("NODE_ENV"), "test");
  });

  it("contains only allow-listed, non-secret keys", () => {
    const unexpected = [...entries.keys()].filter(
      (key) => !(ALLOWED_KEYS as readonly string[]).includes(key),
    );

    assert.deepEqual(unexpected, [], `Not allowed in the committed .env.test: ${unexpected.join(", ")}`);
  });

  it("contains no secret VALUES - secret-named keys exist only pinned empty", () => {
    const suspicious = [...entries.entries()].filter(
      ([key, value]) =>
        SECRET_KEY_PATTERN.test(key) &&
        !((MUST_BE_EMPTY as readonly string[]).includes(key) && value === ""),
    );

    assert.deepEqual(
      suspicious.map(([key]) => key),
      [],
      "a secret-named key must be in MUST_BE_EMPTY and have no value",
    );
  });

  it("pins JWT_SECRET empty, so the suite uses a generated test-only secret", () => {
    assert.equal(entries.has("JWT_SECRET"), true, "JWT_SECRET must be pinned");
    assert.equal(entries.get("JWT_SECRET"), "", "JWT_SECRET must never hold a value here");
    // Node's --env-file really loaded the empty pin (so dotenv cannot fill it).
    assert.equal(process.env["JWT_SECRET"], "");
  });

  it("is what the running test process actually loaded", () => {
    // Proves `npm test` really reads this file (not a local .env).
    assert.equal(process.env["NODE_ENV"], "test");
    assert.equal(process.env["RATE_LIMIT_MAX"], entries.get("RATE_LIMIT_MAX"));
  });
});
