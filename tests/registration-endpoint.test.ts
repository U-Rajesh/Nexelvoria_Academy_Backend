import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { Router, type RequestHandler } from "express";

import {
  createDevAuthRoutes,
  createRegistrationRateLimiter,
  REGISTRATION_RATE_LIMIT,
} from "../dev/auth.dev.routes";
import { assertDevelopmentOnly, DEV_ONLY_REFUSAL } from "../dev/guard.dev";
import { createApp } from "../src/app";
import { createRateLimiter } from "../src/middleware/rate-limit.middleware";
import { verifyPassword } from "../src/modules/auth/password.service";
import { createTestHarness, type TestHarness } from "./fakes";
import { json, startServer, type TestServer } from "./helpers/server";

/**
 * The DEVELOPMENT-ONLY registration endpoint: POST /api/v1/auth/register.
 *
 * Exercised over the real application built by `createApp()` - same
 * middleware, same error pipeline - with the in-memory fakes behind it and
 * `dev/auth.dev.routes.ts` passed in as `extraV1Routes`, exactly as
 * `dev/server.dev.ts` does it.
 *
 * Real argon2id throughout, so each successful registration costs ~120ms.
 */

const PROJECT_ROOT = path.resolve(__dirname, "..");
const PASSWORD = "Password@123";

/** A complete, valid payload. Mirrors what the frontend form submits. */
const validInput = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "Ananya Rao",
  email: "ananya@test.local",
  mobile: "9876543210",
  password: PASSWORD,
  confirmPassword: PASSWORD,
  collegeName: "Nexelvoria Institute of Technology",
  degreeBranch: "B.Tech CSE",
  passingYear: "2026",
  courseInterestedIn: "Full Stack Java and Cloud Microservices",
  dateOfBirth: "2004-05-10",
  gender: "female",
  fullAddress: "12 Cyber Towers, Hyderabad 500081",
  guardianContact: "9876500000",
  linkedInUrl: "",
  githubUrl: "",
  termsAccepted: true,
  ...overrides,
});

/**
 * Builds the dev app over a harness.
 *
 * `rateLimiter` is raised for the functional suites, which make far more
 * than five requests; the real limit gets its own suite below.
 */
const buildDevApp = (h: TestHarness, rateLimiter?: RequestHandler) => {
  const extraV1Routes = Router();

  extraV1Routes.use(
    "/auth",
    createDevAuthRoutes({
      deps: {
        get users() {
          return h.container.repositories.users;
        },
        get credentials() {
          return h.container.repositories.credentials;
        },
        get students() {
          return h.container.repositories.students;
        },
      },
      ...(rateLimiter === undefined ? {} : { rateLimiter }),
    }),
  );

  return createApp({ container: h.container, extraV1Routes });
};

/** A limiter high enough not to interfere with behavioural assertions. */
const permissiveLimiter = (): RequestHandler =>
  createRateLimiter({ windowMs: 60_000, limit: 500, message: "test limiter" });

describe("POST /api/v1/auth/register (development-only)", () => {
  let h: TestHarness;
  let server: TestServer;

  beforeEach(async () => {
    h = createTestHarness();
    server = await startServer(buildDevApp(h, permissiveLimiter()));
  });

  afterEach(async () => {
    await server.close();
  });

  // --- success -----------------------------------------------------------

  describe("a valid registration", () => {
    it("returns 201 with exactly the D2 payload", async () => {
      const res = await server.post("/api/v1/auth/register", validInput());
      assert.equal(res.status, 201);

      const body = await json(res);
      assert.equal(body["success"], true);
      assert.equal(typeof body["message"], "string");

      // The envelope carries success, message and data - nothing else.
      assert.deepEqual(Object.keys(body).sort(), ["data", "message", "success"]);

      const data = body["data"] as Record<string, unknown>;
      // D2: exactly these three fields, no more.
      // TRANSITIONAL: `tempStudentId` is retained for compatibility and
      // deprecated; `verificationTicket` is what a client should carry
      // forward. No student id is placed in a URL any more.
      assert.deepEqual(Object.keys(data).sort(), [
        "email",
        "mobile",
        "tempStudentId",
        "verificationTicket",
      ]);
      assert.equal(data["email"], "ananya@test.local");
      assert.equal(data["mobile"], "9876543210");
      assert.equal(typeof data["tempStudentId"], "string");
      assert.ok((data["tempStudentId"] as string).length > 0);
    });

    it("gives the user and the student profile the SAME id (Q25 option A)", async () => {
      const res = await server.post("/api/v1/auth/register", validInput());
      const data = (await json(res))["data"] as Record<string, unknown>;
      const id = data["tempStudentId"] as string;

      const user = await h.users.findById(id);
      const student = await h.students.findById(id);

      assert.ok(user, "a user must exist for the returned tempStudentId");
      assert.ok(student, "a student profile must exist for the returned tempStudentId");
      assert.equal(user.id, id);
      assert.equal(student.id, id);
      assert.equal(student.id, user.id);

      // Identity is read from the user row, never duplicated by the caller.
      assert.equal(student.name, user.name);
      assert.equal(student.email, user.email);
      assert.equal(student.mobile, user.mobile);
    });

    it("stores the account unverified, unapproved and pending", async () => {
      const res = await server.post("/api/v1/auth/register", validInput());
      const id = ((await json(res))["data"] as Record<string, unknown>)["tempStudentId"] as string;

      const user = await h.users.findById(id);
      const student = await h.students.findById(id);
      assert.ok(user);
      assert.ok(student);

      assert.equal(user.role, "student");
      assert.equal(user.status, "pending");
      assert.equal(student.isEmailVerified, false);
      assert.equal(student.isMobileVerified, false);
      assert.equal(student.adminApprovalStatus, "pending");
      assert.deepEqual(student.enrolledCourseIds, []);
      // Left unset deliberately - the status/approval/accountState mapping is
      // not a confirmed business rule.
      assert.equal(student.accountState, undefined);
    });

    it("persists the admissions data the form collects", async () => {
      const res = await server.post("/api/v1/auth/register", validInput());
      const id = ((await json(res))["data"] as Record<string, unknown>)["tempStudentId"] as string;

      const student = await h.students.findById(id);
      assert.ok(student);
      assert.equal(student.collegeName, "Nexelvoria Institute of Technology");
      assert.equal(student.degreeBranch, "B.Tech CSE");
      assert.equal(student.passingYear, "2026");
      assert.equal(student.courseInterestedIn, "Full Stack Java and Cloud Microservices");
      assert.equal(student.dateOfBirth, "2004-05-10");
      assert.equal(student.gender, "female");
      assert.equal(student.fullAddress, "12 Cyber Towers, Hyderabad 500081");
      assert.equal(student.guardianContact, "9876500000");

      // Blank optional URLs are omitted, not stored as empty strings.
      assert.equal(student.linkedInUrl, undefined);
      assert.equal(student.githubUrl, undefined);
    });

    it("normalises the email to lower case for storage and uniqueness", async () => {
      const res = await server.post(
        "/api/v1/auth/register",
        validInput({ email: "  Ananya.Rao@Test.LOCAL  " }),
      );
      assert.equal(res.status, 201);

      const data = (await json(res))["data"] as Record<string, unknown>;
      assert.equal(data["email"], "ananya.rao@test.local");
    });
  });

  // --- the password ------------------------------------------------------

  describe("password handling", () => {
    it("hashes with argon2id and never returns the password or the hash", async () => {
      const res = await server.post("/api/v1/auth/register", validInput());
      const raw = await res.text();

      // Nothing password-shaped may appear anywhere in the response body.
      assert.ok(!raw.includes(PASSWORD), "the response must not echo the password");
      assert.ok(!raw.includes("argon2"), "the response must not expose a hash");
      assert.ok(!raw.toLowerCase().includes("passwordhash"));
      assert.ok(!raw.toLowerCase().includes("confirmpassword"));

      const id = (JSON.parse(raw)["data"] as Record<string, unknown>)["tempStudentId"] as string;
      const credential = await h.credentials.findByUserId(id);

      assert.ok(credential, "a credential must have been created");
      assert.ok(
        credential.passwordHash.startsWith("$argon2id$"),
        "the stored hash must be an argon2id PHC string",
      );
      assert.notEqual(credential.passwordHash, PASSWORD);
    });

    it("stores a hash that verifies the real password and rejects a wrong one", async () => {
      const res = await server.post("/api/v1/auth/register", validInput());
      const id = ((await json(res))["data"] as Record<string, unknown>)["tempStudentId"] as string;

      const credential = await h.credentials.findByUserId(id);
      assert.ok(credential);

      const right = await verifyPassword(credential.passwordHash, PASSWORD);
      assert.equal(right.valid, true);

      const wrong = await verifyPassword(credential.passwordHash, "Password@124");
      assert.equal(wrong.valid, false);
    });

    it("does not echo the submitted password in a 422", async () => {
      /**
       * THE FIXTURE MUST CONTAIN A NON-HEX CHARACTER. This is not arbitrary.
       *
       * The assertion scans the RAW body, which is the right strength - an
       * echo could appear in `message`, in `details`, anywhere. But the body
       * also carries `requestId`, a hex UUID from `randomUUID()`.
       *
       * The previous fixture was "abc", and `a`, `b` and `c` are all valid
       * hex digits, so roughly 0.55% of UUIDs contain "abc" by chance
       * (measured over 200,000 draws). This test therefore failed about one
       * run in 180 with nothing wrong: the password was never echoed, the
       * substring simply turned up in the correlation id.
       *
       * "z" cannot appear in a hex UUID, so the collision is impossible and
       * the assertion keeps its full strength.
       */
      const weak = "zzz";
      const res = await server.post(
        "/api/v1/auth/register",
        validInput({ password: weak, confirmPassword: weak }),
      );

      assert.equal(res.status, 422);
      const raw = await res.text();
      assert.ok(!raw.includes(weak), "a validation failure must not echo the password");
    });
  });

  // --- duplicates --------------------------------------------------------

  describe("duplicate identifiers", () => {
    it("returns 409 CONFLICT for a duplicate email", async () => {
      const first = await server.post("/api/v1/auth/register", validInput());
      assert.equal(first.status, 201);

      const res = await server.post(
        "/api/v1/auth/register",
        validInput({ mobile: "9876543211", guardianContact: "9876500001" }),
      );

      assert.equal(res.status, 409);
      const body = await json(res);
      assert.equal(body["success"], false);
      assert.equal(body["error"], "CONFLICT");
      assert.match(String(body["message"]), /email address already exists/i);

      // Nothing was created by the rejected attempt.
      assert.equal(h.users.count, 1);
      assert.equal(h.students.count, 1);
    });

    it("treats email duplicates case-insensitively", async () => {
      await server.post("/api/v1/auth/register", validInput());

      const res = await server.post(
        "/api/v1/auth/register",
        validInput({
          email: "ANANYA@TEST.LOCAL",
          mobile: "9876543211",
          guardianContact: "9876500001",
        }),
      );

      assert.equal(res.status, 409);
      assert.equal((await json(res))["error"], "CONFLICT");
      assert.equal(h.users.count, 1);
    });

    it("returns 409 CONFLICT for a duplicate mobile", async () => {
      await server.post("/api/v1/auth/register", validInput());

      const res = await server.post(
        "/api/v1/auth/register",
        validInput({ email: "someone.else@test.local" }),
      );

      assert.equal(res.status, 409);
      const body = await json(res);
      assert.equal(body["error"], "CONFLICT");
      assert.match(String(body["message"]), /mobile number already exists/i);
      assert.equal(h.users.count, 1);
      assert.equal(h.students.count, 1);
    });

    it("keeps state across requests, so the second request sees the first", async () => {
      // The point of ONE shared container: a per-request container would make
      // every duplicate check pass.
      await server.post("/api/v1/auth/register", validInput());
      const again = await server.post("/api/v1/auth/register", validInput());

      assert.equal(again.status, 409);
    });
  });

  // --- validation --------------------------------------------------------

  describe("invalid input", () => {
    it("returns 422 VALIDATION_ERROR with field-level details", async () => {
      const res = await server.post("/api/v1/auth/register", {
        name: "Jo",
        email: "not-an-email",
        mobile: "12345",
      });

      assert.equal(res.status, 422);
      const body = await json(res);
      assert.equal(body["success"], false);
      assert.equal(body["error"], "VALIDATION_ERROR");

      const details = body["details"] as { field: string; message: string }[];
      assert.ok(Array.isArray(details));
      assert.ok(details.length > 0);

      const fields = details.map((d) => d.field);
      for (const expected of ["name", "email", "mobile", "password", "termsAccepted"]) {
        assert.ok(fields.includes(expected), `details should mention ${expected}`);
      }

      assert.equal(h.users.count, 0);
      assert.equal(h.credentials.count, 0);
      assert.equal(h.students.count, 0);
    });

    it("returns 422 for an empty body", async () => {
      const res = await server.post("/api/v1/auth/register", {});
      assert.equal(res.status, 422);
      assert.equal((await json(res))["error"], "VALIDATION_ERROR");
    });

    it("returns 422 for a missing body", async () => {
      const res = await server.post("/api/v1/auth/register");
      assert.equal(res.status, 422);
      assert.equal((await json(res))["error"], "VALIDATION_ERROR");
    });

    it("returns 422 when the passwords do not match", async () => {
      const res = await server.post(
        "/api/v1/auth/register",
        validInput({ confirmPassword: "Password@124" }),
      );

      assert.equal(res.status, 422);
      const details = (await json(res))["details"] as { field: string }[];
      assert.ok(details.some((d) => d.field === "confirmPassword"));
    });

    it("returns 422 when the terms are not accepted", async () => {
      const res = await server.post("/api/v1/auth/register", validInput({ termsAccepted: false }));

      assert.equal(res.status, 422);
      const details = (await json(res))["details"] as { field: string }[];
      assert.ok(details.some((d) => d.field === "termsAccepted"));
      assert.equal(h.users.count, 0);
    });

    it("returns 422 for an invalid mobile and guardian contact", async () => {
      const res = await server.post(
        "/api/v1/auth/register",
        validInput({ mobile: "1234567890", guardianContact: "5555555555" }),
      );

      assert.equal(res.status, 422);
      const fields = ((await json(res))["details"] as { field: string }[]).map((d) => d.field);
      assert.ok(fields.includes("mobile"));
      assert.ok(fields.includes("guardianContact"));
    });

    it("returns 400 MALFORMED_JSON for a broken body", async () => {
      const res = await fetch(`${server.url}/api/v1/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });

      assert.equal(res.status, 400);
      assert.equal((await json(res))["error"], "MALFORMED_JSON");
    });
  });

  // --- what the endpoint refuses to trust --------------------------------

  describe("untrusted input", () => {
    it("ignores a role in the payload - registration always creates a student", async () => {
      const res = await server.post(
        "/api/v1/auth/register",
        validInput({ role: "admin", status: "active" }),
      );
      assert.equal(res.status, 201);

      const id = ((await json(res))["data"] as Record<string, unknown>)["tempStudentId"] as string;
      const user = await h.users.findById(id);

      assert.ok(user);
      assert.equal(user.role, "student");
      assert.equal(user.status, "pending");
    });

    it("ignores self-verification and self-approval attempts", async () => {
      const res = await server.post(
        "/api/v1/auth/register",
        validInput({
          isEmailVerified: true,
          isMobileVerified: true,
          adminApprovalStatus: "approved",
          accountState: "approved",
          enrolledCourseIds: ["course-1"],
        }),
      );
      assert.equal(res.status, 201);

      const id = ((await json(res))["data"] as Record<string, unknown>)["tempStudentId"] as string;
      const student = await h.students.findById(id);

      assert.ok(student);
      assert.equal(student.isEmailVerified, false);
      assert.equal(student.isMobileVerified, false);
      assert.equal(student.adminApprovalStatus, "pending");
      assert.equal(student.accountState, undefined);
      assert.deepEqual(student.enrolledCourseIds, []);
    });

    it("drops resumeDataUrl instead of persisting a base64 blob (Q11)", async () => {
      const res = await server.post(
        "/api/v1/auth/register",
        validInput({
          resumeDataUrl: "data:application/pdf;base64,JVBERi0xLjQKJeLjz9MK",
          resumeFileName: "Ananya_Rao_CV.pdf",
          resumeFileSize: "0.4 MB",
        }),
      );
      assert.equal(res.status, 201);

      const id = ((await json(res))["data"] as Record<string, unknown>)["tempStudentId"] as string;
      const student = await h.students.findById(id);

      assert.ok(student);
      // Metadata is kept; the blob is not, and no resume URL is invented.
      assert.equal(student.resumeFileName, "Ananya_Rao_CV.pdf");
      assert.equal(student.resumeFileSize, "0.4 MB");
      assert.equal(student.resumeUrl, undefined);
      assert.ok(!Object.hasOwn(student, "resumeDataUrl"));
      assert.ok(!JSON.stringify(student).includes("base64"));
    });

    it("rejects an oversized body with 413 before doing any work", async () => {
      const res = await server.post(
        "/api/v1/auth/register",
        validInput({ fullAddress: "x".repeat(1_200_000) }),
      );

      assert.equal(res.status, 413);
      assert.equal((await json(res))["error"], "PAYLOAD_TOO_LARGE");
      assert.equal(h.users.count, 0);
    });
  });
});

// --- rate limiting -------------------------------------------------------

describe("registration rate limiting", () => {
  let h: TestHarness;
  let server: TestServer;

  before(async () => {
    h = createTestHarness();
    // NO override: this exercises the real limiter the dev route ships with.
    server = await startServer(buildDevApp(h));
  });

  after(async () => {
    await server.close();
  });

  it("is far tighter than the general /api limit", () => {
    assert.equal(REGISTRATION_RATE_LIMIT.limit, 5);
    assert.equal(REGISTRATION_RATE_LIMIT.windowMs, 15 * 60 * 1000);
  });

  it("returns 429 TOO_MANY_REQUESTS once the limit is exceeded", async () => {
    const statuses: number[] = [];

    // Validation failures are cheap and still count against the limit, which
    // is the point - an attacker must not get free attempts.
    for (let i = 0; i < REGISTRATION_RATE_LIMIT.limit; i += 1) {
      const res = await server.post("/api/v1/auth/register", { name: "x" });
      statuses.push(res.status);
    }

    assert.ok(
      statuses.every((status) => status === 422),
      `the first ${REGISTRATION_RATE_LIMIT.limit} attempts should be served: ${statuses.join(",")}`,
    );

    const blocked = await server.post("/api/v1/auth/register", { name: "x" });
    assert.equal(blocked.status, 429);

    const body = await json(blocked);
    assert.equal(body["success"], false);
    assert.equal(body["error"], "TOO_MANY_REQUESTS");
    assert.match(String(body["message"]), /too many registration attempts/i);
  });

  it("builds a fresh limiter per call, so apps do not share counters", () => {
    assert.notEqual(createRegistrationRateLimiter(), createRegistrationRateLimiter());
  });
});

// --- production isolation -------------------------------------------------

describe("development-only isolation", () => {
  it("the guard refuses NODE_ENV=production", () => {
    assert.throws(
      () => assertDevelopmentOnly("production"),
      /must never run with NODE_ENV=production/,
    );
  });

  it("the guard permits development and test", () => {
    assert.doesNotThrow(() => assertDevelopmentOnly("development"));
    assert.doesNotThrow(() => assertDevelopmentOnly("test"));
    assert.doesNotThrow(() => assertDevelopmentOnly(undefined));
  });

  it("the dev server process exits non-zero under NODE_ENV=production", () => {
    const result = spawnSync(
      process.execPath,
      [
        path.join(PROJECT_ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
        path.join(PROJECT_ROOT, "dev", "server.dev.ts"),
      ],
      {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        timeout: 120_000,
        env: {
          ...process.env,
          NODE_ENV: "production",
          // Valid so env.ts does NOT reject the config first - the refusal
          // under test must be the dev guard, not a missing variable.
          JWT_SECRET: "throwaway-value-for-this-assertion-only-not-a-secret",
          CORS_ORIGINS: "http://localhost:5173",
          PORT: "45999",
        },
      },
    );

    assert.notEqual(result.status, 0, "the dev entry point must refuse to start");
    assert.equal(result.signal, null, "it must exit on its own, not be killed by the timeout");

    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    assert.match(output, /NODE_ENV=production/);
    assert.ok(
      output.includes(DEV_ONLY_REFUSAL.slice(0, 60)),
      "the refusal must name dev/ as development-only",
    );
  });

  it("no file under src/ imports dev-only or test-only code", () => {
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);

        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }

        if (!full.endsWith(".ts")) {
          continue;
        }

        const source = readFileSync(full, "utf8");
        // Comments legitimately mention dev/ and tests/; only a real module
        // specifier matters, so match the quoted path in an import/require.
        const specifiers = source.match(/(?:from|require\()\s*["'][^"']+["']/g) ?? [];

        for (const specifier of specifiers) {
          if (/["'][^"']*(?:\.\.\/)*(?:dev|tests)\//.test(specifier)) {
            offenders.push(`${path.relative(PROJECT_ROOT, full)}: ${specifier}`);
          }
        }
      }
    };

    walk(path.join(PROJECT_ROOT, "src"));

    assert.deepEqual(
      offenders,
      [],
      `src/ must never import from dev/ or tests/:\n${offenders.join("\n")}`,
    );
  });

  it("the production build config excludes dev/ and tests/", () => {
    const raw = readFileSync(path.join(PROJECT_ROOT, "tsconfig.json"), "utf8");
    const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "")) as {
      include: string[];
      compilerOptions: { rootDir: string };
    };

    assert.deepEqual(config.include, ["src/**/*.ts"]);
    assert.equal(config.compilerOptions.rootDir, "src");
  });
});

// --- regressions ----------------------------------------------------------

describe("the production application is unchanged", () => {
  let server: TestServer;

  before(async () => {
    // createApp() with no options: the production container and NO extra
    // routes - exactly what src/server.ts builds.
    server = await startServer(createApp());
  });

  after(async () => {
    await server.close();
  });

  it("mounts NO registration route (Q-X1 still open)", async () => {
    const res = await server.post("/api/v1/auth/register", validInput());

    assert.equal(res.status, 404);
    const body = await json(res);
    assert.equal(body["success"], false);
    assert.equal(body["error"], "ROUTE_NOT_FOUND");
  });

  it("mounts no /auth surface at all", async () => {
    for (const route of ["/api/v1/auth", "/api/v1/auth/login", "/api/v1/auth/me"]) {
      const res = await server.get(route);
      assert.equal(res.status, 404, `${route} should not exist`);
    }
  });

  it("still serves the exact health contract", async () => {
    const res = await server.get("/api/v1/health");
    assert.equal(res.status, 200);

    assert.deepEqual(await json(res), {
      success: true,
      message: "NEXELVORIA Backend is running",
    });
  });

  it("still 404s an unknown route in the standard envelope", async () => {
    const res = await server.get("/api/v1/does-not-exist");
    assert.equal(res.status, 404);
    assert.equal((await json(res))["error"], "ROUTE_NOT_FOUND");
  });
});
