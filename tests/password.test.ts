import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ApiError } from "../src/utils/api-error";
import { PASSWORD_MAX_LENGTH, passwordPolicySchema } from "../src/modules/auth/auth.validation";
import {
  ARGON2_OPTIONS,
  hashPassword,
  needsRehash,
  validatePasswordPolicy,
  verifyAgainstDummyHash,
  verifyPassword,
} from "../src/modules/auth/password.service";

/**
 * Password security tests.
 *
 * Real argon2id is used throughout - the parameters are not lowered for
 * speed, because the whole point is to test the configuration that ships.
 * Each hash costs ~120 ms, so hashing is kept to the minimum needed.
 */

/** A password satisfying every policy rule. */
const VALID = "Password@123";

type Detail = { field: string; message: string };

describe("password security", () => {
  describe("hashing", () => {
    it("produces an argon2id PHC string with the configured parameters", async () => {
      const hash = await hashPassword(VALID);

      // The PHC string carries algorithm, version, parameters and salt, which
      // is what makes a future parameter change safe for existing hashes.
      assert.match(hash, /^\$argon2id\$v=19\$m=47104,t=2,p=1\$/);
      assert.equal(ARGON2_OPTIONS.memoryCost, 47_104);
      assert.equal(ARGON2_OPTIONS.timeCost, 2);
      assert.equal(ARGON2_OPTIONS.parallelism, 1);
    });

    it("never embeds the plaintext in the hash", async () => {
      const hash = await hashPassword(VALID);

      assert.equal(hash.includes(VALID), false);
      assert.equal(hash.toLowerCase().includes("password"), false);
    });

    it("produces a different hash each time — random per-password salt", async () => {
      const [a, b] = await Promise.all([hashPassword(VALID), hashPassword(VALID)]);

      assert.notEqual(a, b, "identical passwords must not produce identical hashes");

      // Prove the difference is the salt, not the parameters.
      const salt = (hash: string): string => hash.split("$")[4] ?? "";
      assert.notEqual(salt(a), salt(b));
      assert.ok(salt(a).length > 0);

      // Both must still verify, which is what a per-password salt buys:
      // two users with the same password share no stored value, so one
      // cracked hash reveals nothing about the other.
      assert.equal((await verifyPassword(a, VALID)).valid, true);
      assert.equal((await verifyPassword(b, VALID)).valid, true);
    });

    it("refuses to hash a password that fails policy", async () => {
      await assert.rejects(
        () => hashPassword("weak"),
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.status, 422);
          assert.equal(err.code, "VALIDATION_ERROR");
          return true;
        },
      );
    });

    it("never puts the password in the thrown error", async () => {
      const secret = "sup3rsecret";

      await assert.rejects(
        () => hashPassword(secret),
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.message.includes(secret), false);
          assert.equal(
            JSON.stringify(err.details ?? []).includes(secret),
            false,
            "field issues must not echo the password",
          );
          return true;
        },
      );
    });

    it("reports the field name so reset flows point at the right input", async () => {
      await assert.rejects(
        () => hashPassword("weak", "newPassword"),
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal((err.details as Detail[])[0]?.field, "newPassword");
          return true;
        },
      );
    });
  });

  describe("verification", () => {
    it("accepts the correct password", async () => {
      const hash = await hashPassword(VALID);
      const result = await verifyPassword(hash, VALID);

      assert.equal(result.valid, true);
      assert.equal(result.needsRehash, false, "freshly hashed, so no upgrade needed");
    });

    it("rejects an incorrect password", async () => {
      const hash = await hashPassword(VALID);

      assert.equal((await verifyPassword(hash, "WrongPass@123")).valid, false);
    });

    it("rejects a near-miss: case, whitespace and truncation", async () => {
      const hash = await hashPassword(VALID);

      for (const wrong of ["password@123", "PASSWORD@123", " Password@123", "Password@123 ", "Password@12"]) {
        assert.equal(
          (await verifyPassword(hash, wrong)).valid,
          false,
          `"${wrong}" must not verify`,
        );
      }
    });

    it("returns only a boolean and a rehash hint — never the hash", async () => {
      const hash = await hashPassword(VALID);
      const result = await verifyPassword(hash, VALID);

      assert.deepEqual(
        Object.keys(result).sort(),
        ["needsRehash", "valid"],
        "the result must not carry the hash, the plaintext or a failure reason",
      );
      assert.equal(JSON.stringify(result).includes("argon2"), false);
    });

    it("does not re-apply the policy at verification time", async () => {
      // A password hashed under an older, weaker policy must keep working:
      // tightening policy must not lock existing users out.
      const legacyHash = await hashPassword("Legacy@123");

      // "short" would fail today's policy, but verification only answers
      // "is this the right password" — and it is not.
      assert.equal((await verifyPassword(legacyHash, "short")).valid, false);
      assert.equal((await verifyPassword(legacyHash, "Legacy@123")).valid, true);
    });
  });

  describe("invalid stored hash handling (fails closed)", () => {
    it("denies for null, undefined and empty values", async () => {
      for (const bad of [null, undefined, "", "   "]) {
        const result = await verifyPassword(bad, VALID);

        assert.equal(result.valid, false, `${String(bad)} must deny`);
        assert.equal(result.needsRehash, false);
      }
    });

    it("denies for a non-string stored value", async () => {
      for (const bad of [42, true, {}, [], Buffer.from("x")]) {
        assert.equal((await verifyPassword(bad, VALID)).valid, false);
      }
    });

    it("denies for a foreign hash format rather than crashing", async () => {
      // A bcrypt hash, an MD5-looking string, and plaintext in the column.
      const foreign = [
        "$2b$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTU",
        "5f4dcc3b5aa765d61d8327deb882cf99",
        "Password@123",
        "$argon2i$v=19$m=47104,t=2,p=1$c2FsdHNhbHQ$aaaa",
      ];

      for (const hash of foreign) {
        const result = await verifyPassword(hash, VALID);
        assert.equal(result.valid, false, `${hash.slice(0, 12)}... must deny`);
      }
    });

    it("denies for a corrupt argon2id hash without throwing", async () => {
      const valid = await hashPassword(VALID);

      const corrupted = [
        valid.slice(0, valid.length - 10), // truncated digest
        `${valid}tampered`, // appended garbage
        "$argon2id$v=19$m=47104,t=2,p=1$", // header only
        "$argon2id$totally-malformed",
      ];

      for (const hash of corrupted) {
        // Must resolve, not reject — a corrupt row is a failed login, not a 500.
        const result = await verifyPassword(hash, VALID);
        assert.equal(result.valid, false);
      }
    });

    it("denies an absurdly long candidate without hashing it", async () => {
      const hash = await hashPassword(VALID);
      const huge = "A1!a".repeat(1000); // 4000 chars, far over the cap

      const started = Date.now();
      const result = await verifyPassword(hash, huge);

      assert.equal(result.valid, false);
      assert.ok(
        Date.now() - started < 50,
        "an over-length candidate must be rejected before any hashing work",
      );
    });

    it("denies an empty candidate password", async () => {
      const hash = await hashPassword(VALID);

      assert.equal((await verifyPassword(hash, "")).valid, false);
      assert.equal((await verifyPassword(hash, null)).valid, false);
      assert.equal((await verifyPassword(hash, undefined)).valid, false);
    });
  });

  describe("rehash detection", () => {
    it("reports false for a hash made with current parameters", async () => {
      const hash = await hashPassword(VALID);

      assert.equal(needsRehash(hash), false);
    });

    it("reports true for a hash made with weaker parameters", () => {
      // A real argon2id PHC string at the OWASP minimum (m=19MiB, t=2),
      // i.e. what an older deployment would have stored.
      const weaker =
        "$argon2id$v=19$m=19456,t=2,p=1$VWAH53whxOADzUQp00Zb9Q$oxFPnPOU/ABUbfaeaUNswMKz7c0+sPA1ti5ud4Iod0U";

      assert.equal(
        needsRehash(weaker),
        true,
        "a hash below current policy must be flagged for upgrade",
      );
    });

    it("surfaces the upgrade hint through verifyPassword on a correct password", async () => {
      // This is the only moment the plaintext is available to re-hash with,
      // so the hint has to ride along with a successful verification.
      const weakParams = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;
      const argon2 = (await import("argon2")).default;

      const legacyHash = await argon2.hash(VALID, {
        type: argon2.argon2id,
        ...weakParams,
      });

      const correct = await verifyPassword(legacyHash, VALID);
      assert.equal(correct.valid, true);
      assert.equal(correct.needsRehash, true, "correct password + old params -> upgrade");

      const wrong = await verifyPassword(legacyHash, "WrongPass@123");
      assert.equal(wrong.valid, false);
      assert.equal(
        wrong.needsRehash,
        false,
        "never hint an upgrade when the password was wrong",
      );
    });

    it("reports false for unparseable input instead of throwing", () => {
      for (const bad of [null, undefined, "", 7, {}, "not-a-hash"]) {
        assert.equal(needsRehash(bad), false);
      }
    });
  });

  describe("policy validation", () => {
    it("accepts a compliant password", () => {
      const result = validatePasswordPolicy(VALID);

      assert.equal(result.valid, true);
      assert.deepEqual(result.issues, []);
    });

    it("accepts the documented examples and realistic passphrases", () => {
      for (const password of ["Password@123", "Aa1!aaaa", "Nexelvoria#2026", "pQ7$zmLw01"]) {
        assert.equal(validatePasswordPolicy(password).valid, true, `${password} should pass`);
      }
    });

    it("rejects each rule individually with the frontend's wording", () => {
      const cases: { password: string; expected: string }[] = [
        { password: "Aa1!aaa", expected: "Password must be at least 8 characters" },
        { password: "password@123", expected: "Must contain at least one uppercase letter" },
        { password: "PASSWORD@123", expected: "Must contain at least one lowercase letter" },
        { password: "Password@abc", expected: "Must contain at least one number" },
        { password: "Password1234", expected: "Must contain at least one special character" },
      ];

      for (const { password, expected } of cases) {
        const result = validatePasswordPolicy(password);

        assert.equal(result.valid, false, `${password} must fail`);
        assert.ok(
          result.issues.some((i) => i.message === expected),
          `${password} should report: ${expected}`,
        );
      }
    });

    it("reports every failing rule at once, not just the first", () => {
      // "abc" fails length, uppercase, number and special character.
      const result = validatePasswordPolicy("abc");

      assert.equal(result.valid, false);
      assert.equal(
        result.issues.length,
        4,
        `expected 4 issues, got ${JSON.stringify(result.issues)}`,
      );
    });

    it("rejects non-string input", () => {
      for (const bad of [null, undefined, 12345678, {}, [], true]) {
        assert.equal(validatePasswordPolicy(bad).valid, false, `${String(bad)} must fail`);
      }
    });

    it("enforces the maximum length DoS guard", () => {
      const atLimit = `Aa1!${"a".repeat(PASSWORD_MAX_LENGTH - 4)}`;
      const overLimit = `${atLimit}a`;

      assert.equal(atLimit.length, PASSWORD_MAX_LENGTH);
      assert.equal(validatePasswordPolicy(atLimit).valid, true, "exactly at the cap is allowed");
      assert.equal(validatePasswordPolicy(overLimit).valid, false, "one over the cap is rejected");
    });

    it("labels issues with the requested field name", () => {
      assert.equal(validatePasswordPolicy("weak").issues[0]?.field, "password");
      assert.equal(validatePasswordPolicy("weak", "newPassword").issues[0]?.field, "newPassword");
    });

    it("exposes the policy as a reusable zod schema", () => {
      // So login/registration/reset schemas compose it rather than restating
      // the rules and drifting from the frontend.
      assert.equal(passwordPolicySchema.safeParse(VALID).success, true);
      assert.equal(passwordPolicySchema.safeParse("weak").success, false);
    });

    it("treats unicode characters as special characters", () => {
      // The frontend rule is /[^A-Za-z0-9]/, so any non-alphanumeric counts.
      assert.equal(validatePasswordPolicy("Passwörd1").valid, true);
    });
  });

  describe("timing equalization for unknown identifiers", () => {
    it("always denies", async () => {
      assert.equal(await verifyAgainstDummyHash(VALID), false);
      assert.equal(await verifyAgainstDummyHash("anything"), false);
      assert.equal(await verifyAgainstDummyHash(null), false);
    });

    it("costs comparable time to a real verification", async () => {
      const hash = await hashPassword(VALID);

      // Warm the lazily built dummy hash so the first-call cost is excluded.
      await verifyAgainstDummyHash(VALID);

      const timeOf = async (fn: () => Promise<unknown>): Promise<number> => {
        const started = process.hrtime.bigint();
        await fn();
        return Number(process.hrtime.bigint() - started) / 1_000_000;
      };

      const realMs = await timeOf(() => verifyPassword(hash, "WrongPass@123"));
      const dummyMs = await timeOf(() => verifyAgainstDummyHash("WrongPass@123"));

      // Without this, "no such user" returns in <1ms while "wrong password"
      // takes ~120ms — a reliable account-existence oracle. Generous bounds
      // because CI timing is noisy; the point is the same order of magnitude.
      assert.ok(dummyMs > realMs * 0.25, `dummy ${dummyMs.toFixed(0)}ms vs real ${realMs.toFixed(0)}ms`);
      assert.ok(dummyMs < realMs * 4, `dummy ${dummyMs.toFixed(0)}ms vs real ${realMs.toFixed(0)}ms`);
    });
  });

  describe("safe error logging", () => {
    /** Swaps console.* for a collector. Restored by the returned function. */
    const captureLogs = (): { lines: string[]; restore: () => void } => {
      const lines: string[] = [];
      const originalError = console.error;
      const originalWarn = console.warn;
      const originalLog = console.log;

      const capture = (...args: unknown[]): void => {
        lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      };

      console.error = capture;
      console.warn = capture;
      console.log = capture;

      return {
        lines,
        restore: () => {
          console.error = originalError;
          console.warn = originalWarn;
          console.log = originalLog;
        },
      };
    };

    it("logs the error class, not the parse failure's message", async () => {
      // A structurally broken hash that passes the `$argon2id$` prefix check
      // and then fails inside argon2's parser. The parser's message is
      // argon2's own, but it is attacker-INFLUENCED: the garbage below came
      // from storage. Only the class may be logged.
      const corrupt = "$argon2id$v=19$m=47104,t=2,p=1$" + "!!!not-base64!!!" + "$" + "@@@@";

      const captured = captureLogs();

      try {
        const result = await verifyPassword(corrupt, "Password@123");
        assert.equal(result.valid, false, "a corrupt hash must deny, not admit");
      } finally {
        captured.restore();
      }

      const output = captured.lines.join("\n");

      assert.ok(output.includes("Error"), "the error CLASS is logged");
      assert.equal(output.includes("!!!not-base64!!!"), false, "no fragment of the stored value");
      assert.equal(output.includes("$argon2id$"), false, "and not the hash itself");
    });

    it("never logs the stored hash or the candidate password", async () => {
      const hash = await hashPassword("Password@123");
      const captured = captureLogs();

      try {
        await verifyPassword(hash, "Password@123");
        await verifyPassword(hash, "WrongPass@456");
        await verifyPassword(null, "Password@123");
        await verifyPassword("plaintext-stored-by-mistake", "Password@123");
      } finally {
        captured.restore();
      }

      const output = captured.lines.join("\n");

      assert.equal(output.includes(hash), false, "the hash is never logged");
      assert.equal(output.includes("Password@123"), false, "nor the right password");
      assert.equal(output.includes("WrongPass@456"), false, "nor a wrong one");
      assert.equal(
        output.includes("plaintext-stored-by-mistake"),
        false,
        "nor a non-argon2 stored value, which could itself be a credential",
      );

      // The fault IS reported - the type of the bad value, not the value.
      assert.ok(output.includes("storedHashType"), "the fault is still diagnosable");
    });

    it("never puts a password in a thrown policy error", async () => {
      const weak = "sup3rsecret";

      await assert.rejects(
        () => hashPassword(weak),
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal(JSON.stringify(err.details ?? []).includes(weak), false);
          assert.equal(err.message.includes(weak), false);
          return true;
        },
      );
    });
  });
});
