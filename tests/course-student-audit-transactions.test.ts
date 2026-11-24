import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type sql from "mssql";

import { createApp } from "../src/app";
import { createAuthenticate } from "../src/middleware/authenticate.middleware";
import { issueAccessToken } from "../src/modules/auth/token.service";
import type { CourseAudit } from "../src/modules/courses/course.repository";
import { SqlServerCourseRepository } from "../src/modules/courses/sqlserver-course.repository";
import type { CourseModule } from "../src/modules/courses/course.types";
import { SqlServerStudentRepository } from "../src/modules/students/sqlserver-student.repository";
import type { StudentAudit } from "../src/modules/students/student.repository";
import type { Student } from "../src/modules/students/student.types";
import { createTestHarness, type TestHarness } from "./fakes";
import { startServer, type TestServer } from "./helpers/server";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Batch 3 item 10D: SEC audit logs for course management (create, update,
 * curriculum incl. lesson unlock / publish dates, prerequisites, status,
 * publish) and student decisions (approve, reject, status). The audit row is
 * written in the SAME transaction as the change: both commit or neither does,
 * a failed audit write fails the request, and a no-op writes neither.
 *
 * Mock pools and in-memory fakes only - live SQL Server behaviour is not
 * exercised here.
 */

// ------------------------------------------------------------------ mock pool
interface Executed {
  q: string;
  inputs: Record<string, unknown>;
}

const makePool = (handler: (q: string, inputs: Record<string, unknown>) => unknown, opts: { failAudit?: boolean } = {}) => {
  const state = { tx: [] as Executed[], pool: [] as Executed[], begins: 0, commits: 0, rollbacks: 0 };
  class Req {
    inputs: Record<string, unknown> = {};
    constructor(private readonly where: "tx" | "pool") {}
    input(name: string, typeOrValue: unknown, value?: unknown): this {
      this.inputs[name] = value !== undefined ? value : typeOrValue;
      return this;
    }
    async query(q: string) {
      state[this.where].push({ q, inputs: { ...this.inputs } });
      if (q.includes("INSERT INTO dbo.NXA_AuditLogs")) {
        if (opts.failAudit) throw new Error("audit write failed");
        return { recordset: [{ AuditLogId: 9001 }], rowsAffected: [1] };
      }
      const r = handler(q, this.inputs);
      if (r instanceof Error) throw r;
      const o = (r ?? {}) as { recordset?: unknown[]; rowsAffected?: number[] };
      return { recordset: o.recordset ?? [], rowsAffected: o.rowsAffected ?? [1] };
    }
  }
  const pool = {
    request: () => new Req("pool"),
    transaction: () => ({
      begin: async () => void state.begins++,
      commit: async () => void state.commits++,
      rollback: async () => void state.rollbacks++,
      request: () => new Req("tx"),
    }),
  } as unknown as sql.ConnectionPool;
  return { pool, state };
};

const auditsIn = (list: Executed[]) => list.filter((e) => e.q.includes("INSERT INTO dbo.NXA_AuditLogs"));
const sqlError = (message: string, number: number) => Object.assign(new Error(message), { number });
const ACTOR = "9";

const courseRow = {
  CourseId: 10,
  CourseCode: "FS-PYTHON",
  CourseName: "Full Stack Python Development",
  CourseLevel: "Beginner",
  Description: "Comprehensive Full Stack Python",
  ShortDescription: "Learn Python, Django, React",
  DurationValue: 16,
  DurationUnit: "WEEKS",
  ListPrice: 25000,
  CurrencyCode: "INR",
  IsPreviewEnabled: 1,
  Status: "PUBLISHED",
  CreatedAt: new Date("2026-01-01T00:00:00Z"),
  UpdatedAt: null,
};
const curriculumRow = {
  ModuleId: 101,
  CourseId: 10,
  ModuleTitle: "Python Fundamentals",
  ModuleDescription: "Basics of Python",
  ModuleSequence: 1,
  ChapterId: 201,
  ChapterTitle: "Variables and Data Types",
  ChapterDescription: "Syntax overview",
  ChapterSequence: 1,
  LessonId: 301,
  LessonTitle: "Installing Python",
  LessonType: "video",
  DurationMinutes: 15,
  ExternalUrl: "https://video.nexelvoria.in/py1",
  IsPreview: 1,
  IsDownloadAllowed: 0,
  LessonSequence: 1,
};
/** A course with one module / chapter / lesson, as findById reads it. */
const courseHandler = (q: string): unknown => {
  if (q.includes("FROM dbo.NXA_CourseVersions")) return { recordset: [{ CourseVersionId: 9, IsCurrent: true }] };
  if (q.includes("WITH (UPDLOCK, HOLDLOCK)") && q.includes("LessonId")) return { recordset: [{ ModuleId: 101, ChapterId: 201, LessonId: 301 }] };
  if (q.includes("FROM dbo.NXA_CourseModules")) return { recordset: [curriculumRow] };
  if (q.includes("INSERT INTO dbo.NXA_Courses")) return { recordset: [{ CourseId: 10 }] };
  return { recordset: [courseRow] };
};

const studentRow = {
  UserId: 201,
  FullName: "Priya Nair",
  Email: "priya@nexelvoria.in",
  MobileNumber: "9123456780",
  AccountStatus: "active",
  EmailVerified: 1,
  MobileVerified: 0,
  UserCreatedAt: new Date("2026-02-01T10:00:00Z"),
  ApprovalStatus: "pending",
  EnrolledCourseIds: "",
};
const studentHandler = () => ({ recordset: [studentRow] });

const loadModules = async (): Promise<CourseModule[]> => {
  const { pool } = makePool(courseHandler);
  const course = await new SqlServerCourseRepository(pool).findById("10");
  assert.ok(course && course.modules.length === 1, "fixture course has a curriculum");
  return structuredClone(course.modules);
};
const withLessonChange = (modules: CourseModule[], change: Record<string, unknown>): CourseModule[] => {
  const next = structuredClone(modules);
  Object.assign(next[0]!.chapters[0]!.lessons[0]!, change);
  return next;
};

interface Op {
  name: string;
  handler: (q: string, inputs: Record<string, unknown>) => unknown;
  mutation: RegExp;
  entityId: string;
  module: string;
  entity: string;
  action: string;
  details?: string;
  newValues?: string;
  run: (pool: sql.ConnectionPool) => Promise<unknown>;
}

const courseAudit = (actionType: string, details: string): CourseAudit => ({ actorUserId: ACTOR, actionType, details });
const studentAudit = (actionType: string, newValues: string, oldValues?: string): StudentAudit => ({
  actorUserId: ACTOR,
  actionType,
  newValues,
  ...(oldValues ? { oldValues } : {}),
});

const prereqHandler = (q: string): unknown => {
  if (q.includes("FROM dbo.NXA_CoursePrerequisites WITH")) return { recordset: [] };
  if (q.includes("JOIN dbo.NXA_Courses c")) return { recordset: [{ CourseId: 11, CourseCode: "JAVA-FS", CourseName: "Java Full Stack" }] };
  if (q.includes("CourseId IN (")) return { recordset: [{ CourseId: 11 }] };
  return { recordset: [{ CourseId: 10 }] };
};

const OPS: Op[] = [
  {
    name: "course create",
    handler: courseHandler,
    mutation: /INSERT INTO dbo\.NXA_Courses/,
    entityId: "10",
    module: "COURSE_MGMT",
    entity: "Course",
    action: "CREATE_COURSE",
    details: "Created course FS-PYTHON",
    run: (pool) =>
      new SqlServerCourseRepository(pool).create(
        { slug: "fs-python", title: "Full Stack Python", shortDescription: "S", longDescription: "L", durationWeeks: 16, feeINR: 25000, level: "Beginner" },
        ({ courseCode }) => courseAudit("CREATE_COURSE", `Created course ${courseCode}`),
      ),
  },
  {
    name: "course update",
    handler: courseHandler,
    mutation: /UPDATE dbo\.NXA_Courses\s+SET CourseName/,
    entityId: "10",
    module: "COURSE_MGMT",
    entity: "Course",
    action: "UPDATE_COURSE",
    details: "Updated fields: title",
    run: (pool) => new SqlServerCourseRepository(pool).update("10", { title: "Python Full Stack" }, courseAudit("UPDATE_COURSE", "Updated fields: title")),
  },
  {
    name: "course status",
    handler: courseHandler,
    mutation: /SET Status = @status/,
    entityId: "10",
    module: "COURSE_MGMT",
    entity: "Course",
    action: "SET_COURSE_STATUS",
    details: "Status set to Archived",
    run: (pool) =>
      new SqlServerCourseRepository(pool).setPublication("10", { status: "Archived", isPublished: false }, courseAudit("SET_COURSE_STATUS", "Status set to Archived")),
  },
  {
    name: "course unpublish",
    handler: courseHandler,
    mutation: /SET Status = @status/,
    entityId: "10",
    module: "COURSE_MGMT",
    entity: "Course",
    action: "UNPUBLISH_COURSE",
    details: "Published: false",
    run: (pool) => new SqlServerCourseRepository(pool).setPublication("10", { status: "Draft", isPublished: false }, courseAudit("UNPUBLISH_COURSE", "Published: false")),
  },
  {
    name: "curriculum (lesson unlock + publish date)",
    handler: courseHandler,
    mutation: /UPDATE dbo\.NXA_Lessons/,
    entityId: "10",
    module: "COURSE_MGMT",
    entity: "Course",
    action: "UPDATE_CURRICULUM",
    details: "Curriculum saved: 1 module(s)",
    run: async (pool) =>
      new SqlServerCourseRepository(pool).replaceCurriculum(
        "10",
        withLessonChange(await loadModules(), { isSequentialUnlock: true, publishAt: "2026-12-01T04:30:00.000Z" }),
        courseAudit("UPDATE_CURRICULUM", "Curriculum saved: 1 module(s)"),
      ),
  },
  {
    name: "course prerequisites",
    handler: prereqHandler,
    mutation: /INSERT INTO dbo\.NXA_CoursePrerequisites/,
    entityId: "10",
    module: "COURSE_MGMT",
    entity: "Course",
    action: "SET_COURSE_PREREQUISITES",
    details: "Prerequisites set to: 11",
    run: (pool) =>
      new SqlServerCourseRepository(pool).replacePrerequisites("10", ["11"], (saved) =>
        courseAudit("SET_COURSE_PREREQUISITES", `Prerequisites set to: ${saved.map((p) => p.courseId).join(", ") || "none"}`),
      ),
  },
  {
    name: "student status",
    handler: studentHandler,
    mutation: /SET AccountStatus = @status/,
    entityId: "201",
    module: "STUDENT_MGMT",
    entity: "Student",
    action: "SET_STUDENT_STATUS",
    newValues: JSON.stringify({ status: "suspended" }),
    run: (pool) =>
      new SqlServerStudentRepository(pool).setStatus(
        "201",
        "suspended",
        studentAudit("SET_STUDENT_STATUS", JSON.stringify({ status: "suspended" }), JSON.stringify({ status: "active" })),
      ),
  },
  {
    name: "student approval",
    handler: studentHandler,
    mutation: /UPDATE dbo\.NXA_StudentProfiles/,
    entityId: "201",
    module: "STUDENT_MGMT",
    entity: "Student",
    action: "APPROVE_STUDENT",
    newValues: JSON.stringify({ approvalStatus: "approved" }),
    run: (pool) =>
      new SqlServerStudentRepository(pool).recordApprovalDecision(
        "201",
        { status: "approved", decidedByUserId: ACTOR, decidedAt: new Date().toISOString() },
        studentAudit("APPROVE_STUDENT", JSON.stringify({ approvalStatus: "approved" })),
      ),
  },
  {
    name: "student rejection",
    handler: studentHandler,
    mutation: /UPDATE dbo\.NXA_StudentProfiles/,
    entityId: "201",
    module: "STUDENT_MGMT",
    entity: "Student",
    action: "REJECT_STUDENT",
    newValues: JSON.stringify({ approvalStatus: "rejected", remarks: "Incomplete documents" }),
    run: (pool) =>
      new SqlServerStudentRepository(pool).recordApprovalDecision(
        "201",
        { status: "rejected", remarks: "Incomplete documents", decidedByUserId: ACTOR, decidedAt: new Date().toISOString() },
        studentAudit("REJECT_STUDENT", JSON.stringify({ approvalStatus: "rejected", remarks: "Incomplete documents" })),
      ),
  },
];

describe("SEC audit: course and student changes share one SQL transaction with their audit (mock pool)", () => {
  for (const op of OPS) {
    it(`${op.name}: commits the change and one audit row together, with actor and entity`, async () => {
      const { pool, state } = makePool(op.handler);
      await op.run(pool);

      const audits = auditsIn(state.tx);
      assert.equal(audits.length, 1, "exactly one audit row, on the transaction (no duplicate)");
      assert.equal(auditsIn(state.pool).length, 0, "no audit written outside the transaction");
      assert.equal(state.begins, 1);
      assert.equal(state.commits, 1);
      assert.equal(state.rollbacks, 0);

      const mutationAt = state.tx.findIndex((e) => op.mutation.test(e.q));
      assert.ok(mutationAt >= 0, "the change runs on the same transaction");
      assert.ok(mutationAt < state.tx.indexOf(audits[0]!), "the audit row follows the change, before commit");

      const i = audits[0]!.inputs;
      assert.equal(i["actorId"], ACTOR);
      assert.equal(i["action"], op.action);
      assert.equal(i["module"], op.module);
      assert.equal(i["ename"], op.entity);
      assert.equal(i["eid"], op.entityId);
      assert.equal(i["newVal"], op.newValues ?? JSON.stringify({ note: op.details }));
    });

    it(`${op.name}: an audit write failure rolls the change back and fails the call`, async () => {
      const { pool, state } = makePool(op.handler, { failAudit: true });
      await assert.rejects(op.run(pool), /audit write failed/);
      assert.equal(state.commits, 0, "nothing is committed");
      assert.equal(state.rollbacks, 1, "the change is rolled back");
    });
  }

  it("keeps the previous status in the student status audit row", async () => {
    const { pool, state } = makePool(studentHandler);
    await OPS.find((o) => o.name === "student status")!.run(pool);
    assert.equal(auditsIn(state.tx)[0]!.inputs["oldVal"], JSON.stringify({ status: "active" }));
  });

  // ---------------------------------------------------------------- no-ops
  it("no-op saves write nothing and are not audited", async () => {
    const a = courseAudit("X", "n");
    const noRow = (pattern: RegExp, fallback: (q: string) => unknown, exists: unknown[]) => (q: string) => {
      if (pattern.test(q)) return { recordset: [], rowsAffected: [0] };
      if (/^SELECT (CourseId|UserId) FROM/.test(q.trim())) return { recordset: exists };
      return fallback(q);
    };

    const sameMeta = makePool(courseHandler);
    await new SqlServerCourseRepository(sameMeta.pool).update("10", { title: courseRow.CourseName, feeINR: 25000 }, a);
    assert.equal(sameMeta.state.begins, 0, "unchanged course: no transaction, no write");

    const sameTree = makePool(courseHandler);
    await new SqlServerCourseRepository(sameTree.pool).replaceCurriculum("10", await loadModules(), a);
    assert.equal(sameTree.state.begins, 0, "unchanged curriculum (incl. unlock / publish-date settings): no write");
    assert.equal(auditsIn(sameTree.state.tx).length, 0);

    const sameStatus = makePool(noRow(/SET Status = @status/, courseHandler, [{ CourseId: 10 }]));
    await new SqlServerCourseRepository(sameStatus.pool).setPublication("10", { status: "Published", isPublished: true }, a);
    assert.equal(auditsIn(sameStatus.state.tx).length, 0, "same course status: no audit");
    assert.match(sameStatus.state.tx[0]!.q, /<> @status/, "the update only matches a real change");

    const samePrereqs = makePool((q) =>
      q.includes("FROM dbo.NXA_CoursePrerequisites WITH") ? { recordset: [{ CourseId: 10, PrerequisiteCourseId: 11 }] } : prereqHandler(q),
    );
    const r = await new SqlServerCourseRepository(samePrereqs.pool).replacePrerequisites("10", ["11"], () => a);
    assert.equal(r.changed, false);
    assert.equal(auditsIn(samePrereqs.state.tx).length, 0, "same prerequisite set: no audit");

    const sameStudent = makePool(noRow(/SET AccountStatus = @status/, studentHandler, [{ UserId: 201 }]));
    await new SqlServerStudentRepository(sameStudent.pool).setStatus("201", "active", studentAudit("X", "{}"));
    assert.equal(auditsIn(sameStudent.state.tx).length, 0, "same student status: no audit");
  });

  // ---------------------------------------------------------------- business failures
  it("business failures roll back and write no audit row", async () => {
    const a = courseAudit("X", "n");
    const none = auditsIn;

    const dup = makePool((q) => (q.includes("INSERT INTO dbo.NXA_Courses") ? sqlError("Violation of UNIQUE KEY", 2627) : courseHandler(q)));
    await assert.rejects(
      new SqlServerCourseRepository(dup.pool).create({ slug: "fs-python", title: "T", shortDescription: "S", longDescription: "L", durationWeeks: 1, feeINR: 1, level: "Beginner" }, () => a),
      (e: Error) => e.name === "DuplicateRecordError",
    );
    assert.equal(none(dup.state.tx).length, 0);
    assert.equal(dup.state.rollbacks, 1);

    const goneOnUpdate = makePool((q) => (/SET CourseName/.test(q) ? { recordset: [], rowsAffected: [0] } : courseHandler(q)));
    await assert.rejects(new SqlServerCourseRepository(goneOnUpdate.pool).update("10", { title: "New" }, a), /not found/);
    assert.equal(none(goneOnUpdate.state.tx).length, 0);
    assert.equal(goneOnUpdate.state.rollbacks, 1);

    const unknownCourse = makePool((q) => (/SET Status = @status/.test(q) ? { recordset: [], rowsAffected: [0] } : q.trim().startsWith("SELECT CourseId FROM") ? { recordset: [] } : courseHandler(q)));
    await assert.rejects(new SqlServerCourseRepository(unknownCourse.pool).setPublication("10", { status: "Draft", isPublished: false }, a), /not found/);
    assert.equal(none(unknownCourse.state.tx).length, 0);
    assert.equal(unknownCourse.state.rollbacks, 1);

    const inUse = makePool((q) => {
      if (q.includes("DELETE FROM dbo.NXA_Lessons")) return sqlError("REFERENCE constraint", 547);
      if (q.includes("WITH (UPDLOCK, HOLDLOCK)") && q.includes("LessonId")) return { recordset: [{ ModuleId: 101, ChapterId: 201, LessonId: 301 }, { ModuleId: 101, ChapterId: 201, LessonId: 302 }] };
      return courseHandler(q);
    });
    await assert.rejects(
      new SqlServerCourseRepository(inUse.pool).replaceCurriculum("10", withLessonChange(await loadModules(), { title: "Renamed" }), a),
      (e: Error) => e.name === "RecordInUseError",
    );
    assert.equal(none(inUse.state.tx).length, 0);
    assert.equal(inUse.state.rollbacks, 1);

    const unknownPrereq = makePool((q) => (q.includes("CourseId IN (") ? { recordset: [] } : prereqHandler(q)));
    await assert.rejects(new SqlServerCourseRepository(unknownPrereq.pool).replacePrerequisites("10", ["11"], () => a), /do not exist/);
    assert.equal(none(unknownPrereq.state.tx).length, 0);
    assert.equal(unknownPrereq.state.rollbacks, 1);

    const noProfile = makePool(() => ({ recordset: [], rowsAffected: [0] }));
    await assert.rejects(
      new SqlServerStudentRepository(noProfile.pool).recordApprovalDecision("201", { status: "approved", decidedByUserId: ACTOR, decidedAt: new Date().toISOString() }, studentAudit("X", "{}")),
      /not found/,
    );
    assert.equal(none(noProfile.state.tx).length, 0);
    assert.equal(noProfile.state.rollbacks, 1);

    const noStudent = makePool(() => ({ recordset: [], rowsAffected: [0] }));
    await assert.rejects(new SqlServerStudentRepository(noStudent.pool).setStatus("201", "suspended", studentAudit("X", "{}")), /not found/);
    assert.equal(none(noStudent.state.tx).length, 0);
    assert.equal(noStudent.state.rollbacks, 1);
  });
});

// ------------------------------------------------------------------ HTTP (routes + services, in-memory fakes)
describe("SEC audit: course and student routes (in-memory fakes)", () => {
  let harness: TestHarness;
  let server: TestServer;
  const tokens: Record<string, string> = {};
  const auth = (who: string) => ({ headers: { Authorization: `Bearer ${tokens[who]}`, "Content-Type": "application/json" } });
  const json = async (res: Response) => (await res.json()) as Record<string, any>;
  const USERS: Record<string, { id: string; role: "admin" | "super_admin" | "teacher" | "student" }> = {
    admin: { id: "201", role: "admin" },
    super: { id: "202", role: "super_admin" },
    teacher: { id: "301", role: "teacher" },
    student: { id: "401", role: "student" },
  };
  const audits = (action: string) => harness.admin.auditLogs.filter((l) => l.actionType === action);

  const newCourse = {
    slug: "data-engineering",
    courseCode: "data-engineering",
    title: "Data Engineering",
    shortDescription: "Pipelines and warehouses",
    longDescription: "Batch and streaming data pipelines",
    durationWeeks: 16,
    feeINR: 60000,
    level: "Advanced",
  };
  const curriculum = (courseId: string, lesson: Record<string, unknown> = {}) => ({
    modules: [
      {
        id: "m1", courseId, title: "Module 1", description: "", order: 1,
        chapters: [{
          id: "c1", moduleId: "m1", title: "Chapter 1", order: 1,
          lessons: [{ id: "l1", chapterId: "c1", title: "Lesson 1", durationMinutes: 10, isFreePreview: false, order: 1, ...lesson }],
        }],
      },
    ],
  });
  const pendingStudent = (id: string): Student => ({
    id,
    name: `Student ${id}`,
    email: `${id}@test.local`,
    mobile: "9000000000",
    role: "student",
    status: "pending",
    createdAt: "2026-01-01T00:00:00.000Z",
    collegeName: "Nexelvoria Institute",
    degreeBranch: "CSE",
    passingYear: "2026",
    courseInterestedIn: "Java Full Stack",
    dateOfBirth: "2004-01-01",
    gender: "female",
    fullAddress: "Hyderabad",
    isEmailVerified: true,
    isMobileVerified: false,
    adminApprovalStatus: "pending",
    enrolledCourseIds: [],
  } as Student);

  beforeEach(async () => {
    harness = createTestHarness();
    for (const [key, u] of Object.entries(USERS)) {
      const session = await harness.sessions.create({ userId: u.id, refreshTokenHash: Buffer.alloc(64, 7).toString("hex"), ipAddress: "127.0.0.1", expiresAt: new Date(Date.now() + 3600000).toISOString() });
      tokens[key] = issueAccessToken({ userId: u.id, role: u.role, sessionId: session.sessionId }).token;
    }
    const authenticate = createAuthenticate({ studentAccess: null, sessions: () => harness.sessions });
    server = await startServer(createApp({ container: harness.container, authenticate }));
  });

  afterEach(async () => {
    await server.close();
  });

  it("course management is audited once per real change, with the Admin as actor; no-ops are not", async () => {
    const created = await server.post("/api/v1/courses", newCourse, auth("admin"));
    assert.equal(created.status, 201);
    const id = String((await json(created))["data"]["id"]);
    assert.deepEqual(
      audits("CREATE_COURSE").map((l) => [l.actorUserId, l.entityId, l.moduleCode, l.entityName]),
      [["201", id, "COURSE_MGMT", "Course"]],
    );

    assert.equal((await server.patch(`/api/v1/courses/${id}`, { title: "Data Engineering" }, auth("admin"))).status, 200);
    assert.equal(audits("UPDATE_COURSE").length, 0, "same title: no audit");
    assert.equal((await server.patch(`/api/v1/courses/${id}`, { title: "Data Engineering Pro" }, auth("super"))).status, 200);
    assert.deepEqual(audits("UPDATE_COURSE").map((l) => [l.actorUserId, l.entityId]), [["202", id]]);

    assert.equal((await server.put(`/api/v1/courses/${id}/curriculum`, curriculum(id), auth("admin"))).status, 200);
    assert.equal((await server.put(`/api/v1/courses/${id}/curriculum`, curriculum(id), auth("admin"))).status, 200);
    assert.equal(audits("UPDATE_CURRICULUM").length, 1, "the same tree again: no audit");
    // LMS-004 / LMS-005 settings travel in the curriculum save.
    assert.equal(
      (await server.put(`/api/v1/courses/${id}/curriculum`, curriculum(id, { isSequentialUnlock: true, publishAt: "2026-12-01T10:00:00+05:30" }), auth("admin"))).status,
      200,
    );
    assert.equal(audits("UPDATE_CURRICULUM").length, 2, "lesson unlock / publish-date change is audited");

    const other = await server.post("/api/v1/courses", { ...newCourse, slug: "ml-ops", courseCode: "ml-ops", title: "ML Ops" }, auth("admin"));
    const otherId = String((await json(other))["data"]["id"]);
    assert.equal((await server.put(`/api/v1/courses/${id}/prerequisites`, { prerequisiteCourseIds: [otherId] }, auth("admin"))).status, 200);
    assert.equal((await server.put(`/api/v1/courses/${id}/prerequisites`, { prerequisiteCourseIds: [otherId] }, auth("admin"))).status, 200);
    assert.deepEqual(audits("SET_COURSE_PREREQUISITES").map((l) => l.entityId), [id], "unchanged set: no second audit");

    assert.equal((await server.patch(`/api/v1/courses/${id}/status`, { status: "Draft" }, auth("admin"))).status, 200);
    assert.equal(audits("SET_COURSE_STATUS").length, 0, "already Draft: no audit");
    assert.equal((await server.patch(`/api/v1/courses/${id}/publish`, {}, auth("admin"))).status, 200);
    assert.equal(audits("PUBLISH_COURSE").length, 1);
    assert.equal((await server.patch(`/api/v1/courses/${id}/publish`, {}, auth("admin"))).status, 200);
    assert.equal(audits("UNPUBLISH_COURSE").length, 1);
    assert.equal((await server.patch(`/api/v1/courses/${id}/status`, { status: "Archived" }, auth("admin"))).status, 200);
    assert.equal(audits("SET_COURSE_STATUS").length, 1);

    const actions = harness.admin.auditLogs.map((l) => l.actionType);
    assert.equal(actions.filter((a) => a === "CREATE_COURSE").length, 2, "one row per course created, no duplicates");
  });

  it("a course audit failure fails the request and leaves the course unchanged", async () => {
    harness.courses.failAudit = true;
    const res = await server.post("/api/v1/courses", newCourse, auth("admin"));
    assert.ok(res.status >= 500, `got ${res.status}`);
    assert.equal((await harness.courses.findBySlug("data-engineering")), null, "no course without its audit");

    harness.courses.failAudit = false;
    const id = String((await json(await server.post("/api/v1/courses", newCourse, auth("admin"))))["data"]["id"]);
    harness.courses.failAudit = true;
    assert.ok((await server.patch(`/api/v1/courses/${id}`, { title: "Changed" }, auth("admin"))).status >= 500);
    assert.ok((await server.put(`/api/v1/courses/${id}/curriculum`, curriculum(id), auth("admin"))).status >= 500);
    assert.ok((await server.patch(`/api/v1/courses/${id}/publish`, {}, auth("admin"))).status >= 500);
    const other = (await harness.courses.create({ slug: "ml-ops", courseCode: "ml-ops", title: "ML Ops", shortDescription: "s", longDescription: "l", durationWeeks: 1, feeINR: 1, level: "Beginner" } as any));
    assert.ok((await server.put(`/api/v1/courses/${id}/prerequisites`, { prerequisiteCourseIds: [other.id] }, auth("admin"))).status >= 500);

    const course = (await harness.courses.findById(id))!;
    assert.equal(course.title, "Data Engineering");
    assert.equal(course.modules.length, 0);
    assert.equal(course.isPublished, false);
    assert.deepEqual(await harness.courses.findPrerequisites(id), []);
    assert.equal(harness.admin.auditLogs.length, 1, "only the successful create was audited");
  });

  it("student approve / reject / status are audited with the Admin as actor; sessions are revoked only after commit", async () => {
    harness.students.seed(pendingStudent("s1"));
    harness.students.seed(pendingStudent("s2"));

    assert.equal((await server.post("/api/v1/students/s1/approve", { remarks: "Documents verified" }, auth("admin"))).status, 200);
    assert.deepEqual(
      audits("APPROVE_STUDENT").map((l) => [l.actorUserId, l.entityId, l.moduleCode, l.entityName, l.newValues]),
      [["201", "s1", "STUDENT_MGMT", "Student", JSON.stringify({ approvalStatus: "approved", remarks: "Documents verified" })]],
    );
    assert.equal((await server.post("/api/v1/students/s1/approve", {}, auth("admin"))).status, 409);
    assert.equal(audits("APPROVE_STUDENT").length, 1, "a refused second decision is not audited");

    assert.equal((await server.post("/api/v1/students/s2/reject", { remarks: "Incomplete documents" }, auth("super"))).status, 200);
    assert.deepEqual(audits("REJECT_STUDENT").map((l) => [l.actorUserId, l.entityId]), [["202", "s2"]]);

    assert.equal((await server.patch("/api/v1/students/s1/status", { status: "suspended" }, auth("admin"))).status, 200);
    assert.equal((await server.patch("/api/v1/students/s1/status", { status: "suspended" }, auth("admin"))).status, 200);
    assert.equal(audits("SET_STUDENT_STATUS").length, 1, "unchanged status the second time: no audit");
    const [st] = audits("SET_STUDENT_STATUS");
    assert.ok(st);
    assert.deepEqual([st.actorUserId, st.entityId, st.oldValues, st.newValues], ["201", "s1", JSON.stringify({ status: "pending" }), JSON.stringify({ status: "suspended" })]);
  });

  it("a student audit failure fails the request, leaves the decision unrecorded and keeps sessions", async () => {
    harness.students.seed(pendingStudent("s1"));
    const s1Session = await harness.sessions.create({ userId: "s1", refreshTokenHash: Buffer.alloc(64, 3).toString("hex"), ipAddress: "127.0.0.1", expiresAt: new Date(Date.now() + 3600000).toISOString() });
    harness.students.failAudit = true;

    assert.ok((await server.post("/api/v1/students/s1/approve", {}, auth("admin"))).status >= 500);
    assert.ok((await server.post("/api/v1/students/s1/reject", { remarks: "Incomplete documents" }, auth("admin"))).status >= 500);
    assert.ok((await server.patch("/api/v1/students/s1/status", { status: "suspended" }, auth("admin"))).status >= 500);

    const s = (await harness.students.findById("s1"))!;
    assert.deepEqual([s.adminApprovalStatus, s.status], ["pending", "pending"]);
    const live = await harness.sessions.findBySessionId(s1Session.sessionId);
    assert.ok(live && !live.revokedAt, "the session is not revoked when the status change rolled back");
    assert.equal(harness.admin.auditLogs.length, 0);
  });

  it("refused callers change nothing and leave no audit", async () => {
    harness.students.seed(pendingStudent("s1"));
    assert.equal((await server.post("/api/v1/courses", newCourse, auth("teacher"))).status, 403);
    assert.equal((await server.post("/api/v1/courses", newCourse, auth("student"))).status, 403);
    assert.equal((await server.post("/api/v1/courses", newCourse)).status, 401);
    assert.equal((await server.post("/api/v1/students/s1/approve", {}, auth("teacher"))).status, 403);
    assert.equal((await server.patch("/api/v1/students/s1/status", { status: "suspended" }, auth("student"))).status, 403);

    assert.equal(await harness.courses.findBySlug("data-engineering"), null);
    const s = (await harness.students.findById("s1"))!;
    assert.deepEqual([s.adminApprovalStatus, s.status], ["pending", "pending"]);
    assert.equal(harness.admin.auditLogs.length, 0, "no audit for refused requests");
  });
});
