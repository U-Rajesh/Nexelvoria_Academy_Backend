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

/** Exactly the non-secret variables src/config/env.ts reads. */
const ALLOWED_KEYS = [
  "NODE_ENV",
  "PORT",
  "CORS_ORIGINS",
  "BODY_LIMIT",
  "RATE_LIMIT_MAX",
  "RATE_LIMIT_WINDOW_MINUTES",
] as const;

/** Belt and braces: names that must never appear, even if allow-listed later. */
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

  it("contains no secret-looking key names", () => {
    const suspicious = [...entries.keys()].filter((key) => SECRET_KEY_PATTERN.test(key));
    assert.deepEqual(suspicious, []);
  });

  it("is what the running test process actually loaded", () => {
    // Proves `npm test` really reads this file (not a local .env).
    assert.equal(process.env["NODE_ENV"], "test");
    assert.equal(process.env["RATE_LIMIT_MAX"], entries.get("RATE_LIMIT_MAX"));
  });
});
