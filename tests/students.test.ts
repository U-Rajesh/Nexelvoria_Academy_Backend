import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import express, { type RequestHandler } from "express";

import { createApp } from "../src/app";
import type { UserRole } from "../src/contracts/user.contract";
import { errorHandler } from "../src/middleware/error.middleware";
import { notFoundHandler } from "../src/middleware/not-found.middleware";
import type { Enrollment } from "../src/modules/enrollments/enrollment.types";
import { createStudentRoutes } from "../src/modules/students/student.routes";
import { createStudentService } from "../src/modules/students/student.service";
import type { Student } from "../src/modules/students/student.types";
import { ApiError } from "../src/utils/api-error";
import { createTestHarness, InMemoryStudentRepository, type TestHarness } from "./fakes";
import { json, startServer, type TestServer } from "./helpers/server";

/**
 * Step 3, Task 3.1 - Student Management: admin READ endpoints.
 *
 *   GET /api/v1/students             api-contracts 5 #1
 *   GET /api/v1/students/:studentId  api-contracts 5 #3
 *
 * Evidence in three layers: the service over the fakes, the router on a
 * TEST-ONLY app with injected identity, and the REAL app (401 everywhere,
 * because authentication does not exist yet).
 */

// --- fixtures --------------------------------------------------------------

const student = (overrides: Partial<Student> & { id: string }): Student => ({
  name: `Student ${overrides.id}`,
  email: `${overrides.id}@test.local`,
  mobile: "9000000000",
  role: "student",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  collegeName: "Nexelvoria Institute",
  degreeBranch: "CSE",
  passingYear: "2026",
  courseInterestedIn: "Java Full Stack",
  dateOfBirth: "2004-01-01",
  gender: "female",
  fullAddress: "Hyderabad",
  isEmailVerified: true,
  isMobileVerified: true,
  adminApprovalStatus: "approved",
  enrolledCourseIds: [],
  ...overrides,
});

const enrollment = (
  id: string,
  studentId: string,
  batchId: string | undefined,
  status: Enrollment["status"] = "active",
): Enrollment => ({
  id,
  studentId,
  courseId: "course-1",
  ...(batchId === undefined ? {} : { batchId }),
  status,
  enrolledAt: "2026-02-01T00:00:00.000Z",
  progressPercentage: 0,
  completedLessonIds: [],
  bookmarkedLessonIds: [],
});

const PAGE = { page: 1, pageSize: 10, sortOrder: "asc" } as const;

/**
 * Test apps below inject identity directly, so the required `authenticate`
 * dependency is a pass-through here (the same pattern as courses.manage and
 * teachers tests). The REAL application test uses the real middleware.
 */
const passThrough: RequestHandler = (_req, _res, next) => next();

const ids = (r: { items: { id: string }[] }) => r.items.map((s) => s.id);

// --- 1. service -------------------------------------------------------------

describe("students service - admin reads", () => {
  let h: TestHarness;
  let service: ReturnType<typeof createStudentService>;

  beforeEach(() => {
    h = createTestHarness();
    service = createStudentService({ students: h.students });
  });

  describe("getStudentById", () => {
    it("returns the student", async () => {
      h.students.seed(student({ id: "s1", name: "Ananya" }));
      assert.equal((await service.getStudentById("s1")).name, "Ananya");
    });

    it("throws 404 for an unknown id", async () => {
      await assert.rejects(
        service.getStudentById("nope"),
        (err: unknown) =>
          err instanceof ApiError && err.status === 404 && err.message === "Student not found",
      );
    });
  });

  describe("listStudents - filters", () => {
    beforeEach(() => {
      h.students.seed(
        student({ id: "s1", status: "active", adminApprovalStatus: "approved", passingYear: "2025" }),
      );
      h.students.seed(
        student({ id: "s2", status: "pending", adminApprovalStatus: "pending", passingYear: "2026" }),
      );
      h.students.seed(
        student({
          id: "s3",
          status: "suspended",
          adminApprovalStatus: "rejected",
          passingYear: "2026",
          collegeName: "Osmania University",
          enrolledCourseIds: ["course-9"],
        }),
      );
    });

    it("filters by status, approvalStatus, passingYear and courseId", async () => {
      assert.deepEqual(ids(await service.listStudents({ ...PAGE, status: "suspended" })), ["s3"]);
      assert.deepEqual(ids(await service.listStudents({ ...PAGE, approvalStatus: "pending" })), [
        "s2",
      ]);
      assert.deepEqual(
        ids(await service.listStudents({ ...PAGE, passingYear: "2026", sortBy: "name" })),
        ["s2", "s3"],
      );
      assert.deepEqual(ids(await service.listStudents({ ...PAGE, courseId: "course-9" })), ["s3"]);
    });

    it("searches name, email, mobile and collegeName", async () => {
      assert.deepEqual(ids(await service.listStudents({ ...PAGE, search: "osmania" })), ["s3"]);
    });

    it("backs the approvals view with approvalStatus=pending", async () => {
      const result = await service.listStudents({ ...PAGE, approvalStatus: "pending" });
      assert.equal(result.total, 1);
    });
  });

  describe("listStudents - batchId (Option A: resolved through enrolments)", () => {
    it("returns only students with an enrolment in that batch", async () => {
      for (const id of ["s1", "s2", "s3"]) h.students.seed(student({ id }));
      h.enrollments.seed(enrollment("e1", "s1", "batch-A"));
      h.enrollments.seed(enrollment("e2", "s2", "batch-B"));
      h.enrollments.seed(enrollment("e3", "s3", "batch-A"));

      const result = await service.listStudents({ ...PAGE, batchId: "batch-A", sortBy: "name" });
      assert.deepEqual(ids(result), ["s1", "s3"]);
      assert.equal(result.total, 2);
    });

    it("returns an empty page - not everyone - for a batch with no enrolments", async () => {
      h.students.seed(student({ id: "s1" }));
      h.enrollments.seed(enrollment("e1", "s1", "batch-A"));

      const result = await service.listStudents({ ...PAGE, batchId: "batch-Z" });
      assert.equal(result.total, 0);
    });

    it("ignores enrolments with no batch assigned", async () => {
      h.students.seed(student({ id: "s1" }));
      h.enrollments.seed(enrollment("e1", "s1", undefined));

      assert.equal((await service.listStudents({ ...PAGE, batchId: "batch-A" })).total, 0);
    });

    it("counts a student once even with several enrolments in the batch", async () => {
      h.students.seed(student({ id: "s1" }));
      h.enrollments.seed(enrollment("e1", "s1", "batch-A"));
      h.enrollments.seed({ ...enrollment("e2", "s1", "batch-A"), courseId: "course-2" });

      assert.equal((await service.listStudents({ ...PAGE, batchId: "batch-A" })).total, 1);
    });

    it("combines batchId with other filters", async () => {
      h.students.seed(student({ id: "s1", status: "active" }));
      h.students.seed(student({ id: "s2", status: "suspended" }));
      h.enrollments.seed(enrollment("e1", "s1", "batch-A"));
      h.enrollments.seed(enrollment("e2", "s2", "batch-A"));

      const result = await service.listStudents({ ...PAGE, batchId: "batch-A", status: "active" });
      assert.deepEqual(ids(result), ["s1"]);
    });

    it("the fake THROWS on batchId without an enrolment source - never silently ignores it", async () => {
      const standalone = new InMemoryStudentRepository();
      standalone.seed(student({ id: "s1" }));

      await assert.rejects(
        standalone.findMany({ batchId: "batch-A" }, { page: 1, pageSize: 10 }),
        /needs an enrolment source/,
      );
      // Other filters still work standalone - backward compatible.
      assert.equal((await standalone.findMany({}, { page: 1, pageSize: 10 })).total, 1);
    });
  });

  describe("listStudents - sorting", () => {
    beforeEach(() => {
      h.students.seed(
        student({ id: "s1", name: "charlie", createdAt: "2026-01-01T00:00:00.000Z", passingYear: "2027" }),
      );
      h.students.seed(
        student({ id: "s2", name: "Alpha", createdAt: "2026-03-01T00:00:00.000Z", passingYear: "2025" }),
      );
      h.students.seed(
        student({ id: "s3", name: "bravo", createdAt: "2026-02-01T00:00:00.000Z", passingYear: "2026" }),
      );
    });

    it("defaults to createdAt DESC (newest first)", async () => {
      assert.deepEqual(ids(await service.listStudents(PAGE)), ["s2", "s3", "s1"]);
    });

    it("sorts by name case-insensitively, both directions", async () => {
      assert.deepEqual(ids(await service.listStudents({ ...PAGE, sortBy: "name" })), [
        "s2",
        "s3",
        "s1",
      ]);
      assert.deepEqual(
        ids(await service.listStudents({ ...PAGE, sortBy: "name", sortOrder: "desc" })),
        ["s1", "s3", "s2"],
      );
    });

    it("sorts by createdAt and passingYear", async () => {
      assert.deepEqual(ids(await service.listStudents({ ...PAGE, sortBy: "createdAt" })), [
        "s1",
        "s3",
        "s2",
      ]);
      assert.deepEqual(ids(await service.listStudents({ ...PAGE, sortBy: "passingYear" })), [
        "s2",
        "s3",
        "s1",
      ]);
    });

    it("falls back to the default for a non-allow-listed or hostile sortBy", async () => {
      for (const sortBy of ["email", "mobile", "name; DROP TABLE Students--"]) {
        assert.deepEqual(ids(await service.listStudents({ ...PAGE, sortBy })), ["s2", "s3", "s1"], sortBy);
      }
    });
  });

  describe("listStudents - id ASC tiebreaker", () => {
    it("breaks ties by id ASC regardless of direction, comparing ids numerically", async () => {
      const same = "2026-05-05T00:00:00.000Z";
      // Seeded out of order; "s10" must sort AFTER "s2" (numeric, not lexical).
      for (const id of ["s10", "s2", "s1"]) h.students.seed(student({ id, createdAt: same }));

      assert.deepEqual(ids(await service.listStudents(PAGE)), ["s1", "s2", "s10"]);
      assert.deepEqual(
        ids(await service.listStudents({ ...PAGE, sortBy: "createdAt", sortOrder: "asc" })),
        ["s1", "s2", "s10"],
      );
    });

    it("pages through ties without repeating or skipping anyone", async () => {
      const same = "2026-05-05T00:00:00.000Z";
      for (let i = 1; i <= 7; i += 1) h.students.seed(student({ id: `s${i}`, createdAt: same }));

      const seen: string[] = [];
      for (const page of [1, 2, 3]) {
        seen.push(...ids(await service.listStudents({ ...PAGE, page, pageSize: 3 })));
      }
      assert.deepEqual(seen, ["s1", "s2", "s3", "s4", "s5", "s6", "s7"]);
    });
  });
});

// --- 2. router on a TEST-ONLY app with injected identity ---------------------

describe("students HTTP - admin read routes (test app, injected identity)", () => {
  const h = createTestHarness();
  let server: TestServer;

  /**
   * TEST-ONLY identity, the same approach as authorize.test.ts `asRole`.
   * Nothing like it exists in src/.
   */
  let identity: UserRole | undefined;
  const injectIdentity: RequestHandler = (req, _res, next) => {
    if (identity !== undefined) {
      req.principal = { id: `user-${identity}`, role: identity, sessionId: `session-${identity}` };
    }
    next();
  };

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use(injectIdentity);
    app.use("/api/v1/students", createStudentRoutes({ students: h.students, authenticate: passThrough }));
    app.use(notFoundHandler);
    app.use(errorHandler);
    server = await startServer(app);
  });

  after(async () => {
    await server.close();
  });

  beforeEach(() => {
    h.reset();
    identity = undefined;
    h.students.seed(student({ id: "s1", name: "Ananya", adminApprovalStatus: "pending" }));
    h.students.seed(student({ id: "s2", name: "Bhavya" }));
  });

  const get = (path: string) => server.get(`/api/v1/students${path}`);

  describe("authorization", () => {
    it("401s both routes without an identity", async () => {
      for (const path of ["", "/s1"]) {
        const res = await get(path);
        assert.equal(res.status, 401, path);
        assert.equal((await json(res))["error"], "UNAUTHENTICATED");
      }
    });

    it("checks auth BEFORE validation - a bad query still gets 401, not 422", async () => {
      assert.equal((await get("?status=bogus")).status, 401);
    });

    for (const role of ["student", "teacher"] as const) {
      it(`403s both routes for a ${role}`, async () => {
        identity = role;
        for (const path of ["", "/s1"]) {
          const res = await get(path);
          assert.equal(res.status, 403, `${role} ${path}`);
          assert.equal((await json(res))["error"], "INSUFFICIENT_ROLE");
        }
      });
    }

    for (const role of ["admin", "super_admin"] as const) {
      it(`allows ${role} (super_admin inherits admin)`, async () => {
        identity = role;
        assert.equal((await get("")).status, 200);
        assert.equal((await get("/s1")).status, 200);
      });
    }
  });

  describe("as admin", () => {
    beforeEach(() => {
      identity = "admin";
    });

    it("GET /students returns the paginated envelope, newest first by default", async () => {
      const body = await json(await get(""));
      assert.equal(body["success"], true);

      const data = body["data"] as { items: Student[]; total: number; page: number; pageSize: number };
      assert.deepEqual(Object.keys(data).sort(), ["items", "page", "pageSize", "total", "totalPages"]);
      assert.equal(data.total, 2);
      assert.equal(data.pageSize, 10);
    });

    it("GET /students?approvalStatus=pending backs the approvals view", async () => {
      const body = await json(await get("?approvalStatus=pending"));
      assert.deepEqual(ids(body["data"] as { items: Student[] }), ["s1"]);
    });

    it("GET /students?batchId= filters through enrolments", async () => {
      h.enrollments.seed(enrollment("e1", "s2", "batch-A"));
      const body = await json(await get("?batchId=batch-A"));
      assert.deepEqual(ids(body["data"] as { items: Student[] }), ["s2"]);
    });

    it("GET /students sorts via sortBy/sortOrder", async () => {
      const body = await json(await get("?sortBy=name&sortOrder=desc"));
      assert.deepEqual(ids(body["data"] as { items: Student[] }), ["s2", "s1"]);
    });

    it("rejects invalid query values with 422 field details", async () => {
      const cases = [
        ["status=bogus", "status"],
        ["approvalStatus=maybe", "approvalStatus"],
        ["passingYear=20x6", "passingYear"],
        ["sortOrder=sideways", "sortOrder"],
        ["pageSize=1000", "pageSize"],
        ["batchId=", "batchId"],
      ] as const;

      for (const [qs, field] of cases) {
        const res = await get(`?${qs}`);
        assert.equal(res.status, 422, qs);
        const details = (await json(res))["details"] as { field: string }[];
        assert.ok(details.some((d) => d.field === field), `${qs} -> ${field}`);
      }
    });

    it("GET /students/:studentId returns the student", async () => {
      const res = await get("/s1");
      assert.equal(res.status, 200);
      const data = (await json(res))["data"] as Student;
      assert.equal(data.id, "s1");
      assert.equal(data.name, "Ananya");
    });

    it("GET /students/:studentId is 404 for an unknown student", async () => {
      const res = await get("/does-not-exist");
      assert.equal(res.status, 404);
      const body = await json(res);
      assert.equal(body["error"], "NOT_FOUND");
      assert.equal(body["message"], "Student not found");
    });

    it("exposes no write routes yet (later tasks)", async () => {
      const post = await server.post("/api/v1/students", { name: "x" });
      assert.equal(post.status, 404);
    });
  });
});

// --- 3. the REAL application -------------------------------------------------

describe("students HTTP - real application (no authentication exists yet)", () => {
  const h = createTestHarness();
  let server: TestServer;

  before(async () => {
    server = await startServer(createApp({ container: h.container }));
  });

  after(async () => {
    await server.close();
  });

  beforeEach(() => {
    h.reset();
    h.students.seed(student({ id: "s1" }));
  });

  it("answers 401 on both routes", async () => {
    assert.equal((await server.get("/api/v1/students")).status, 401);
    assert.equal((await server.get("/api/v1/students/s1")).status, 401);
  });

  it("cannot be talked into a role by headers or query", async () => {
    const res = await server.get("/api/v1/students?role=admin", {
      headers: { "X-User-Role": "admin", Authorization: "Bearer forged" },
    });
    assert.equal(res.status, 401);
  });

  it("does not disturb health or the public course catalogue", async () => {
    assert.equal((await server.get("/api/v1/health")).status, 200);
    assert.equal((await server.get("/api/v1/courses")).status, 200);
  });
});

// --- 4. response whitelist (Task 3.1 correction) -----------------------------

/**
 * Every field a student response may carry: the agreed `StudentProfile`
 * contract minus the deliberately unmodelled auth/session fields and
 * `resumeDataUrl`. Written out HERE, independently of `toStudentResponse`,
 * so the test fails if the whitelist drifts in either direction.
 */
const PERMITTED_FIELDS = [
  "id", "name", "email", "mobile", "role", "status", "createdAt", "avatarUrl",
  "collegeName", "degreeBranch", "passingYear", "courseInterestedIn", "dateOfBirth",
  "gender", "fullAddress", "guardianContact",
  "resumeUrl", "resumeFileName", "resumeFileSize", "linkedInUrl", "githubUrl",
  "isEmailVerified", "isMobileVerified", "adminApprovalStatus", "adminApprovalRemarks",
  "approvedAt", "accountState", "enrolledCourseIds",
].sort();

/** Internal / credential / future fields an adapter might wrongly map. */
const LEAKY_FIELDS = {
  passwordHash: "$2b$10$LEAKED-HASH",
  otpCode: "123456",
  otpExpiresAt: "2026-11-17T10:00:00.000Z",
  refreshToken: "rt-LEAKED",
  twoFactorSecret: "TOTP-LEAKED",
  failedLoginAttempts: 3,
  lockedUntil: "2026-11-18T00:00:00.000Z",
  resumeDataUrl: "data:application/pdf;base64,LEAKED",
  internalNotes: "do not expose",
};

/** A student with EVERY permitted field set, plus the leaky extras. */
const fullStudentWithLeaks = (id: string): Student =>
  ({
    ...student({ id }),
    avatarUrl: "https://cdn.test/a.png",
    guardianContact: "9848022338",
    resumeUrl: "https://cdn.test/r.pdf",
    resumeFileName: "r.pdf",
    resumeFileSize: "120 KB",
    linkedInUrl: "https://linkedin.com/in/x",
    githubUrl: "https://github.com/x",
    adminApprovalRemarks: "ok",
    approvedAt: "2026-01-02T00:00:00.000Z",
    accountState: "approved",
    enrolledCourseIds: ["course-1"],
    ...LEAKY_FIELDS,
  }) as Student;

const LEAK_PATTERN = /LEAKED|passwordHash|otpCode|refreshToken|twoFactorSecret|failedLoginAttempts|lockedUntil|resumeDataUrl|internalNotes|123456/;

describe("students - response whitelist (service level)", () => {
  it("strips unknown fields on BOTH reads, even from a misbehaving adapter", async () => {
    const row = fullStudentWithLeaks("s1");
    const adapter = {
      findById: async () => row,
      findMany: async () => ({ items: [row], total: 41, page: 3, pageSize: 20, totalPages: 3 }),
    } as unknown as Parameters<typeof createStudentService>[0]["students"];

    const service = createStudentService({ students: adapter });

    const one = await service.getStudentById("s1");
    assert.deepEqual(Object.keys(one).sort(), PERMITTED_FIELDS);

    const page = await service.listStudents({ ...PAGE, page: 3, pageSize: 20 });
    assert.deepEqual(Object.keys(page.items[0]!).sort(), PERMITTED_FIELDS);

    // Pagination metadata passes through untouched.
    assert.equal(page.total, 41);
    assert.equal(page.page, 3);
    assert.equal(page.pageSize, 20);
    assert.equal(page.totalPages, 3);
  });

  it("omits absent optional fields rather than sending undefined", async () => {
    const h = createTestHarness();
    h.students.seed(student({ id: "s1" })); // no optional fields set
    const out = await createStudentService({ students: h.students }).getStudentById("s1");

    for (const key of ["avatarUrl", "guardianContact", "resumeUrl", "approvedAt"]) {
      assert.equal(key in out, false, key);
    }

    // `accountState` is NOT in that list any more: it is DERIVED from
    // status + isEmailVerified + adminApprovalStatus rather than read from
    // storage, so it is present whenever those three name a state. This
    // student is active, verified and approved, so it derives "approved".
    assert.equal(out.accountState, "approved");
  });

  it("does not hand out the repository's own array (detached copy)", async () => {
    const row = fullStudentWithLeaks("s1");
    const adapter = { findById: async () => row } as unknown as Parameters<
      typeof createStudentService
    >[0]["students"];

    const out = await createStudentService({ students: adapter }).getStudentById("s1");
    out.enrolledCourseIds.push("mutated");
    assert.deepEqual(row.enrolledCourseIds, ["course-1"]);
  });
});

describe("students HTTP - response whitelist (test app, admin)", () => {
  const h = createTestHarness();
  let server: TestServer;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      // TEST-ONLY identity, as above.
      req.principal = { id: "user-admin", role: "admin", sessionId: "session-admin" };
      next();
    });
    app.use("/api/v1/students", createStudentRoutes({ students: h.students, authenticate: passThrough }));
    app.use(notFoundHandler);
    app.use(errorHandler);
    server = await startServer(app);
  });

  after(async () => {
    await server.close();
  });

  beforeEach(() => {
    h.reset();
    h.students.seed(fullStudentWithLeaks("s1"));
    h.students.seed(fullStudentWithLeaks("s2"));
  });

  it("GET /students/:studentId returns exactly the permitted fields, nothing leaked", async () => {
    const res = await server.get("/api/v1/students/s1");
    assert.equal(res.status, 200);

    const text = await res.text();
    assert.doesNotMatch(text, LEAK_PATTERN);

    const data = (JSON.parse(text) as { data: Record<string, unknown> }).data;
    assert.deepEqual(Object.keys(data).sort(), PERMITTED_FIELDS);
  });

  it("GET /students returns exactly the permitted fields per item, pagination intact", async () => {
    const res = await server.get("/api/v1/students?pageSize=1&page=2");
    assert.equal(res.status, 200);

    const text = await res.text();
    assert.doesNotMatch(text, LEAK_PATTERN);

    const data = (JSON.parse(text) as {
      data: { items: Record<string, unknown>[]; total: number; page: number; pageSize: number; totalPages: number };
    }).data;

    assert.equal(data.items.length, 1);
    assert.deepEqual(Object.keys(data.items[0]!).sort(), PERMITTED_FIELDS);
    assert.equal(data.total, 2);
    assert.equal(data.page, 2);
    assert.equal(data.pageSize, 1);
    assert.equal(data.totalPages, 2);
  });
});

// --- 5. Task 3.2: PATCH /students/:studentId/status ---------------------------

describe("students service - setStudentStatus (Task 3.2)", () => {
  let h: TestHarness;
  let service: ReturnType<typeof createStudentService>;

  beforeEach(() => {
    h = createTestHarness();
    service = createStudentService({ students: h.students });
  });

  it("sets each allowed status and returns the updated student", async () => {
    h.students.seed(student({ id: "s1", status: "pending" }));

    for (const status of ["suspended", "deactivated", "active"] as const) {
      const out = await service.setStudentStatus("s1", status);
      assert.equal(out.status, status);
      assert.equal((await h.students.findById("s1"))?.status, status, "persisted");
    }
  });

  it("is idempotent - setting the current status again succeeds", async () => {
    h.students.seed(student({ id: "s1", status: "active" }));
    assert.equal((await service.setStudentStatus("s1", "active")).status, "active");
  });

  it("allows any transition - no rules are invented (e.g. deactivated -> active)", async () => {
    h.students.seed(student({ id: "s1", status: "deactivated", adminApprovalStatus: "pending" }));
    assert.equal((await service.setStudentStatus("s1", "active")).status, "active");
  });

  it("writes status ONLY - accountState and approval are untouched (D1, Option A)", async () => {
    h.students.seed(
      student({ id: "s1", status: "active", accountState: "approved", adminApprovalStatus: "approved" }),
    );

    const out = await service.setStudentStatus("s1", "suspended");
    assert.equal(out.status, "suspended");
    assert.equal(out.adminApprovalStatus, "approved");

    // The SERVICE still writes no accountState - the seeded value is
    // untouched in storage, which is what "D1, Option A" guaranteed.
    const stored = await h.students.findById("s1");
    assert.equal(stored?.accountState, "approved", "storage must not be rewritten");

    // But the RESPONSE now DERIVES it, so a suspension IS reflected. This
    // resolves the integration concern recorded in api-contracts section 5:
    // the admin badge reads accountState and previously kept showing
    // "approved" after a suspension.
    assert.equal(out.accountState, "suspended");
  });

  it("maps an unknown student to 404", async () => {
    await assert.rejects(
      service.setStudentStatus("nope", "suspended"),
      (err: unknown) =>
        err instanceof ApiError && err.status === 404 && err.message === "Student not found",
    );
  });

  it("returns the whitelisted response, never the raw repository row", async () => {
    h.students.seed(fullStudentWithLeaks("s1"));
    const out = await service.setStudentStatus("s1", "suspended");
    assert.deepEqual(Object.keys(out).sort(), PERMITTED_FIELDS);
    assert.doesNotMatch(JSON.stringify(out), LEAK_PATTERN);
  });

  it("rethrows unexpected repository errors untouched (they become a 500)", async () => {
    const boom = new Error("connection reset");
    const failing = createStudentService({
      students: { setStatus: async () => Promise.reject(boom) } as unknown as Parameters<
        typeof createStudentService
      >[0]["students"],
    });
    await assert.rejects(failing.setStudentStatus("s1", "active"), (err: unknown) => err === boom);
  });
});

describe("students HTTP - PATCH /:studentId/status (test app, injected identity)", () => {
  const h = createTestHarness();
  let server: TestServer;

  /** TEST-ONLY identity, as in authorize.test.ts `asRole`. */
  let identity: UserRole | undefined;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use(((req, _res, next) => {
      if (identity !== undefined) {
        req.principal = { id: `user-${identity}`, role: identity, sessionId: `session-${identity}` };
      }
      next();
    }) as RequestHandler);
    app.use("/api/v1/students", createStudentRoutes({ students: h.students, authenticate: passThrough }));
    app.use(notFoundHandler);
    app.use(errorHandler);
    server = await startServer(app);
  });

  after(async () => {
    await server.close();
  });

  beforeEach(() => {
    h.reset();
    identity = undefined;
    h.students.seed(student({ id: "s1", status: "active", accountState: "approved" }));
  });

  const patch = (path: string, body?: unknown) =>
    fetch(`${server.url}/api/v1/students${path}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  describe("authorization", () => {
    it("401s without an identity, and before validation", async () => {
      const ok = await patch("/s1/status", { status: "suspended" });
      assert.equal(ok.status, 401);
      assert.equal((await json(ok))["error"], "UNAUTHENTICATED");

      // An invalid body still gets 401, not 422.
      assert.equal((await patch("/s1/status", { status: "pending" })).status, 401);

      assert.equal((await h.students.findById("s1"))?.status, "active", "nothing written");
    });

    for (const role of ["student", "teacher"] as const) {
      it(`403s a ${role} and writes nothing`, async () => {
        identity = role;
        const res = await patch("/s1/status", { status: "suspended" });
        assert.equal(res.status, 403);
        assert.equal((await json(res))["error"], "INSUFFICIENT_ROLE");
        assert.equal((await h.students.findById("s1"))?.status, "active");
      });
    }

    for (const role of ["admin", "super_admin"] as const) {
      it(`allows ${role}`, async () => {
        identity = role;
        assert.equal((await patch("/s1/status", { status: "suspended" })).status, 200);
      });
    }
  });

  describe("as admin", () => {
    beforeEach(() => {
      identity = "admin";
    });

    it("returns 200 with the updated, whitelisted StudentProfile", async () => {
      const res = await patch("/s1/status", { status: "deactivated" });
      assert.equal(res.status, 200);

      const body = await json(res);
      assert.equal(body["success"], true);
      const data = body["data"] as Student;
      assert.equal(data.status, "deactivated");

      // `deactivated` is now a member of `AccountState`, so the derivation
      // reports it instead of staying silent. The admin badge therefore
      // shows a deactivated student correctly.
      assert.equal(data.accountState, "deactivated");
      assert.ok(Object.keys(data).every((k) => PERMITTED_FIELDS.includes(k)));
    });

    it("the change is visible through GET /students/:studentId", async () => {
      await patch("/s1/status", { status: "suspended" });
      const data = (await json(await server.get("/api/v1/students/s1")))["data"] as Student;
      assert.equal(data.status, "suspended");
    });

    it("rejects pending and other invalid bodies with 422 on `status`", async () => {
      const cases: unknown[] = [
        { status: "pending" },
        { status: "Active" },
        { status: "banned" },
        { status: "" },
        { status: null },
        { status: 1 },
        {},
      ];

      for (const body of cases) {
        const res = await patch("/s1/status", body);
        assert.equal(res.status, 422, JSON.stringify(body));
        const payload = await json(res);
        assert.equal(payload["error"], "VALIDATION_ERROR");
        assert.ok(
          (payload["details"] as { field: string }[]).some((d) => d.field === "status"),
          JSON.stringify(body),
        );
      }

      assert.equal((await h.students.findById("s1"))?.status, "active", "nothing written");
    });

    it("rejects a request with no body at all with 422", async () => {
      assert.equal((await patch("/s1/status")).status, 422);
    });

    it("ignores extra body fields such as accountState or isEmailVerified", async () => {
      const res = await patch("/s1/status", {
        status: "suspended",
        accountState: "locked",
        isEmailVerified: false,
        adminApprovalStatus: "rejected",
      });
      const data = (await json(res))["data"] as Student;
      assert.equal(data.status, "suspended");
      assert.equal(data.isEmailVerified, true);
      assert.equal(data.adminApprovalStatus, "approved");

      // The forged `accountState: "locked"` is ignored outright - the value
      // is derived, so a client cannot set it at all. It reads "suspended"
      // because the status change really did happen.
      assert.equal(data.accountState, "suspended");
    });

    it("returns 404 for an unknown student", async () => {
      const res = await patch("/nope/status", { status: "suspended" });
      assert.equal(res.status, 404);
      const body = await json(res);
      assert.equal(body["error"], "NOT_FOUND");
      assert.equal(body["message"], "Student not found");
    });
  });
});

describe("students HTTP - PATCH status on the REAL application", () => {
  const h = createTestHarness();
  let server: TestServer;

  before(async () => {
    server = await startServer(createApp({ container: h.container }));
  });

  after(async () => {
    await server.close();
  });

  it("answers 401 and writes nothing, even with forged identity hints", async () => {
    h.reset();
    h.students.seed(student({ id: "s1", status: "active" }));

    const res = await fetch(`${server.url}/api/v1/students/s1/status`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-User-Role": "admin",
        Authorization: "Bearer forged",
      },
      body: JSON.stringify({ status: "suspended", role: "admin" }),
    });

    assert.equal(res.status, 401);
    assert.equal((await h.students.findById("s1"))?.status, "active");
  });
});
