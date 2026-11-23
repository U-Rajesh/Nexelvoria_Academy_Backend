import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  RepositoryNotConfiguredError,
  createContainer,
  createProductionContainer,
} from "../src/container/container";
import { InMemoryStudentRepository, createTestHarness } from "./fakes";

describe("dependency injection container", () => {
  describe("resolution", () => {
    it("resolves a registered repository", () => {
      const harness = createTestHarness();

      assert.ok(harness.container.repositories.students);
      assert.equal(harness.container.has("students"), true);
    });

    it("returns the same instance on repeated access (memoised)", () => {
      const harness = createTestHarness();

      const first = harness.container.repositories.students;
      const second = harness.container.repositories.students;

      assert.equal(first, second, "a container must yield one instance per repository");
    });

    it("constructs lazily — a factory is not called until resolved", () => {
      let built = 0;

      const container = createContainer({
        students: () => {
          built += 1;
          return new InMemoryStudentRepository();
        },
      });

      assert.equal(built, 0, "factory must not run at container creation");

      void container.repositories.students;
      assert.equal(built, 1);

      void container.repositories.students;
      assert.equal(built, 1, "memoised, so the factory runs once");
    });

    it("reports which repositories are registered without constructing them", () => {
      let built = 0;

      const container = createContainer({
        courses: () => {
          built += 1;
          return new InMemoryStudentRepository() as never;
        },
      });

      assert.deepEqual(container.registered(), ["courses"]);
      assert.equal(container.has("courses"), true);
      assert.equal(container.has("students"), false);
      assert.equal(built, 0);
    });
  });

  describe("unregistered repositories fail loudly", () => {
    it("throws RepositoryNotConfiguredError rather than returning undefined", () => {
      const container = createContainer({});

      assert.throws(
        () => container.repositories.students,
        (err: unknown) => {
          assert.ok(err instanceof RepositoryNotConfiguredError);
          assert.equal(err.repositoryName, "students");
          return true;
        },
      );
    });

    it("names the missing repository in the message", () => {
      const container = createContainer({});

      assert.throws(() => container.repositories.enrollments, /"enrollments" repository/);
    });

    it("the production container registers the production adapters", () => {
      const production = createProductionContainer();

      assert.deepEqual(production.registered(), ["studentRegistration"]);
      assert.equal(production.has("studentRegistration"), true);
      assert.equal(production.has("users"), false);
      assert.equal(production.has("credentials"), false);
      assert.equal(production.has("sessions"), false);
      assert.equal(production.has("students"), false);

      // Remaining repositories throw RepositoryNotConfiguredError until implemented.
      assert.throws(
        () => production.repositories.students,
        RepositoryNotConfiguredError,
      );
    });

    it("the full production container registers all 15 repositories", () => {
      const prev = process.env.TEST_FULL_PRODUCTION_CONTAINER;
      try {
        process.env.TEST_FULL_PRODUCTION_CONTAINER = "1";
        const production = createProductionContainer();
        const registered = production.registered();
        assert.equal(registered.length, 15);
        assert.equal(production.has("studentRegistration"), true);
        assert.equal(production.has("users"), true);
        assert.equal(production.has("credentials"), true);
        assert.equal(production.has("students"), true);
        assert.equal(production.has("sessions"), true);
        assert.equal(production.has("otpChallenges"), true);
        assert.equal(production.has("courses"), true);
        assert.equal(production.has("enrollments"), true);
        assert.equal(production.has("teachers"), true);
        assert.equal(production.has("admin"), true);
        assert.equal(production.has("cms"), true);
        assert.equal(production.has("payments"), true);
        assert.equal(production.has("certificates"), true);
        assert.equal(production.has("placements"), true);
        assert.equal(production.has("support"), true);
      } finally {
        if (prev !== undefined) {
          process.env.TEST_FULL_PRODUCTION_CONTAINER = prev;
        } else {
          delete process.env.TEST_FULL_PRODUCTION_CONTAINER;
        }
      }
    });

    it("a partially configured container only fails for what is missing", () => {
      const container = createContainer({ students: () => new InMemoryStudentRepository() });

      assert.ok(container.repositories.students, "registered one resolves");
      assert.throws(() => container.repositories.courses, RepositoryNotConfiguredError);
    });
  });

  describe("replaceability (the point of the container)", () => {
    it("accepts any object satisfying the port, not a concrete class", async () => {
      // A hand-written stub, not the in-memory fake: proof that services
      // depend on the INTERFACE and nothing else.
      const stub = {
        findById: async () => null,
        findByEmail: async () => null,
        existsByEmail: async () => true,
        existsByMobile: async () => false,
        findMany: async () => ({ items: [], total: 0, page: 1, pageSize: 10, totalPages: 0 }),
        create: async () => {
          throw new Error("not needed for this test");
        },
        createForUser: async () => {
          throw new Error("not needed for this test");
        },
        update: async () => {
          throw new Error("not needed for this test");
        },
        setStatus: async () => {
          throw new Error("not needed for this test");
        },
        recordApprovalDecision: async () => {
          throw new Error("not needed for this test");
        },
        markVerified: async () => {
          throw new Error("not needed for this test");
        },
        clearLockout: async () => {
          throw new Error("not needed for this test");
        },
      };

      const container = createContainer({ students: () => stub });

      assert.equal(await container.repositories.students.existsByEmail("a@b.com"), true);
      assert.equal(await container.repositories.students.findById("x"), null);
    });
  });

  describe("test isolation", () => {
    it("two harnesses do not share state", async () => {
      const a = createTestHarness();
      const b = createTestHarness();

      await a.students.create({
        name: "A",
        email: "a@test.local",
        mobile: "1",
        status: "pending",
        collegeName: "C",
        degreeBranch: "CSE",
        passingYear: "2026",
        courseInterestedIn: "Java",
        dateOfBirth: "2004-01-01",
        gender: "male",
        fullAddress: "Addr",
      });

      assert.equal(a.students.count, 1);
      assert.equal(b.students.count, 0, "a separate harness must be empty");
    });

    it("reset() clears every fake in the harness", async () => {
      const harness = createTestHarness();

      await harness.students.create({
        name: "A",
        email: "a@test.local",
        mobile: "1",
        status: "pending",
        collegeName: "C",
        degreeBranch: "CSE",
        passingYear: "2026",
        courseInterestedIn: "Java",
        dateOfBirth: "2004-01-01",
        gender: "male",
        fullAddress: "Addr",
      });

      harness.courses.seed({
        id: "c1",
        slug: "java",
        title: "Java",
        shortDescription: "s",
        longDescription: "l",
        thumbnailUrl: "t",
        durationWeeks: 12,
        totalHours: 100,
        feeINR: 50000,
        level: "Beginner",
        category: "Software Development",
        technologies: [],
        modules: [],
        isPublished: true,
        hasPlacementGuarantee: false,
        prerequisites: [],
        learningOutcomes: [],
      });

      assert.equal(harness.students.count, 1);
      assert.equal(harness.courses.count, 1);

      harness.reset();

      assert.equal(harness.students.count, 0);
      assert.equal(harness.courses.count, 0);
    });

    it("ids restart after reset, so assertions stay deterministic", async () => {
      const harness = createTestHarness();

      const input = {
        name: "A",
        email: "a@test.local",
        mobile: "1",
        status: "pending" as const,
        collegeName: "C",
        degreeBranch: "CSE",
        passingYear: "2026",
        courseInterestedIn: "Java",
        dateOfBirth: "2004-01-01",
        gender: "male" as const,
        fullAddress: "Addr",
      };

      const first = await harness.students.create(input);
      assert.equal(first.id, "student-1");

      harness.reset();

      const again = await harness.students.create(input);
      assert.equal(again.id, "student-1", "sequence resets with the store");
    });
  });
  describe("test adapters cannot be enabled in production", () => {
    it("throws if an in-memory fake is constructed with NODE_ENV=production", async () => {
      // Run in a child process, because NODE_ENV is read at construction
      // time and mutating it in-process would leak into other tests.
      const { execFileSync } = await import("node:child_process");

      const script = `
        process.env.NODE_ENV = "production";
        process.env.CORS_ORIGINS = "https://app.nexelvoria.edu.in";
        const { InMemoryStudentRepository } = require("./tests/fakes/in-memory-student.repository");
        try {
          new InMemoryStudentRepository();
          console.log(JSON.stringify({ threw: false }));
        } catch (err) {
          console.log(JSON.stringify({ threw: true, message: String(err.message) }));
        }
      `;

      const out = execFileSync(process.execPath, ["--import", "tsx", "-e", script], {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });

      const lines = out.trim().split(/\r?\n/);
      const result = JSON.parse(lines[lines.length - 1] ?? "{}") as {
        threw: boolean;
        message?: string;
      };

      assert.equal(result.threw, true, "a fake must refuse to run in production");
      assert.match(String(result.message), /test-only in-memory fake/);
    });

    it("fakes live outside src, so the build cannot emit them", async () => {
      // The primary guard is structural: tsconfig.json compiles src/ only.
      const { readFileSync } = await import("node:fs");
      const tsconfig = readFileSync("tsconfig.json", "utf8");

      assert.match(tsconfig, /"include":\s*\["src\/\*\*\/\*\.ts"\]/);
      assert.equal(
        tsconfig.includes("tests"),
        false,
        "the build config must never include tests/",
      );
    });
  });
});
