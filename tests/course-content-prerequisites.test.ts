import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type sql from "mssql";

import { createApp } from "../src/app";
import { createAuthenticate } from "../src/middleware/authenticate.middleware";
import { issueAccessToken } from "../src/modules/auth/token.service";
import { findPrerequisiteCycle } from "../src/modules/courses/course-prerequisites";
import type { CourseModule } from "../src/modules/courses/course.types";
import { SqlServerCourseRepository } from "../src/modules/courses/sqlserver-course.repository";
import { RecordInUseError, RecordNotFoundError, UnsupportedFieldsError } from "../src/repositories/repository.errors";
import { createTestHarness, type TestHarness } from "./fakes";
import { startServer, type TestServer } from "./helpers/server";

/**
 * Batch 2 item 7: course content and prerequisites against the live schema.
 *  - NXA_CourseModules is unique on (CourseVersionId, SequenceNumber) with no
 *    filter: modules are attached to the course's current version (approved:
 *    version 1 is created when the course has none).
 *  - Reorders park stored rows on negative sequence numbers first.
 *  - Lesson study text is NXA_Lessons.ContentText.
 *  - Prerequisites are NXA_CoursePrerequisites course links: no self, only
 *    existing courses, no cycles; a no-op writes nothing.
 */

type Handler = (q: string, inputs: Record<string, unknown>) => unknown;

class MockSqlRequest {
  inputs: Record<string, unknown> = {};
  constructor(private readonly handler: Handler) {}
  input(name: string, typeOrValue: unknown, value?: unknown): this {
    this.inputs[name] = value !== undefined ? value : typeOrValue;
    return this;
  }
  async query<T = unknown>(command: string): Promise<{ recordset: T[]; rowsAffected: number[] }> {
    const res = this.handler(command, this.inputs);
    if (res instanceof Error) throw res;
    const r = (res ?? {}) as { recordset?: T[]; rowsAffected?: number[] };
    return { recordset: r.recordset ?? [], rowsAffected: r.rowsAffected ?? [1] };
  }
}

const tracked = (handler: Handler) => {
  const state = { began: 0, committed: false, rolledBack: false };
  const seen: Array<{ q: string; inputs: Record<string, unknown> }> = [];
  const wrapped: Handler = (q, inputs) => {
    seen.push({ q, inputs: { ...inputs } });
    return handler(q, inputs);
  };
  const pool = {
    request: () => new MockSqlRequest(wrapped),
    transaction: () => ({
      begin: async () => {
        state.began += 1;
      },
      commit: async () => {
        state.committed = true;
      },
      rollback: async () => {
        state.rolledBack = true;
      },
      request: () => new MockSqlRequest(wrapped),
    }),
  } as unknown as sql.ConnectionPool;
  const writes = () => seen.filter((s) => /\b(INSERT|UPDATE|DELETE|MERGE)\b/.test(s.q));
  return { state, seen, writes, repo: new SqlServerCourseRepository(pool) };
};

const courseRow = { CourseId: 10, CourseCode: "FS", CourseName: "Full Stack", Status: "DRAFT", ListPrice: 1, DurationValue: 12 };

describe("prerequisite cycle detection", () => {
  it("finds direct and multi-hop cycles and ignores the course's replaced links", () => {
    assert.deepEqual(findPrerequisiteCycle("A", ["B"], [["B", "A"]]), ["A", "B", "A"]);
    assert.deepEqual(findPrerequisiteCycle("A", ["B"], [["B", "C"], ["C", "A"]]), ["A", "B", "C", "A"]);
    assert.equal(findPrerequisiteCycle("A", ["B", "C"], [["B", "C"], ["C", "D"]]), null, "a diamond is not a cycle");
    assert.equal(findPrerequisiteCycle("A", [], [["B", "A"]]), null);
    assert.equal(findPrerequisiteCycle("A", ["B"], [["A", "X"], ["X", "A"]]), null, "A's stored links are replaced");
  });
});

describe("curriculum save against the live schema (SqlServerCourseRepository.replaceCurriculum)", () => {
  const stored = [
    { ModuleId: 101, ChapterId: 201, LessonId: 301 },
    { ModuleId: 101, ChapterId: 201, LessonId: 302 },
  ];
  const tree = (lessons: Array<Record<string, unknown>>, moduleId = "101", chapterId = "201"): CourseModule[] => [
    {
      id: moduleId, courseId: "10", title: "M1", description: "", order: 1,
      chapters: [{
        id: chapterId, moduleId, title: "C1", order: 1,
        lessons: lessons.map((l, i) => ({ chapterId, durationMinutes: 10, isFreePreview: false, order: i + 1, id: `x${i}`, title: `L${i}`, ...l })),
      }],
    },
  ] as CourseModule[];

  const handler = (over: { versions?: unknown[]; stored?: unknown[]; fail?: (q: string) => Error | undefined } = {}): Handler => (q) => {
    const f = over.fail?.(q);
    if (f) return f;
    if (q.includes("FROM dbo.NXA_CourseVersions")) return { recordset: over.versions ?? [{ CourseVersionId: 9, IsCurrent: true }] };
    if (q.includes("INSERT INTO dbo.NXA_CourseVersions")) return { recordset: [{ CourseVersionId: 77 }] };
    if (q.includes("FROM dbo.NXA_CourseModules m WITH (UPDLOCK, HOLDLOCK)")) return { recordset: over.stored ?? stored };
    if (q.includes("INSERT INTO dbo.NXA_CourseModules")) return { recordset: [{ ModuleId: 401 }] };
    if (q.includes("INSERT INTO dbo.NXA_Chapters")) return { recordset: [{ ChapterId: 501 }] };
    if (q.includes("FROM dbo.NXA_CourseModules m") && q.includes("LEFT JOIN")) {
      return {
        recordset: [{
          ModuleId: 101, CourseId: 10, ModuleTitle: "M1", ModuleDescription: null, ModuleSequence: 1,
          ChapterId: 201, ChapterTitle: "C1", ChapterDescription: null, ChapterSequence: 1,
          LessonId: 301, LessonTitle: "L0", LessonType: "reading", DurationMinutes: 10, ExternalUrl: null,
          ContentText: "Read chapter 3", IsPreview: 0, IsDownloadAllowed: 0, LessonSequence: 1,
        }],
      };
    }
    if (/\b(INSERT|UPDATE|DELETE)\b/.test(q)) return { recordset: [] };
    return { recordset: [courseRow] };
  };

  it("creates version 1 for a course without versions and attaches every module to it", async () => {
    const t = tracked(handler({ versions: [], stored: [] }));
    await t.repo.replaceCurriculum("10", tree([{ id: "new-1", title: "Intro" }], "m-new", "c-new"));
    const v = t.writes().find((w) => w.q.includes("INSERT INTO dbo.NXA_CourseVersions"))!;
    assert.match(v.q, /\(CourseId, VersionNumber, IsCurrent, CreatedAt\)/);
    assert.match(v.q, /VALUES \(@courseId, 1, 1, SYSUTCDATETIME\(\)\)/);
    const m = t.writes().find((w) => w.q.includes("INSERT INTO dbo.NXA_CourseModules"))!;
    assert.match(m.q, /\(CourseId, CourseVersionId, ModuleTitle/);
    assert.equal(m.inputs["versionId"], "77", "never a NULL version, which collides across courses");
    assert.ok(t.state.committed);
  });

  it("uses the existing current version, parks sequences before reordering, and keeps ids", async () => {
    const t = tracked(handler());
    await t.repo.replaceCurriculum("10", tree([{ id: "302", title: "Second now first" }, { id: "301", title: "First now second" }]));
    assert.equal(t.writes().filter((w) => w.q.includes("INSERT INTO dbo.NXA_CourseVersions")).length, 0);
    const parkIdx = t.seen.findIndex((s) => s.q.includes("SET SequenceNumber = -rn"));
    const firstUpdate = t.seen.findIndex((s) => s.q.includes("UPDATE dbo.NXA_Lessons\n") || /UPDATE dbo\.NXA_Lessons\s+SET ChapterId/.test(s.q));
    assert.ok(parkIdx >= 0 && parkIdx < firstUpdate, "rows are parked on negative sequences before the final order is written");
    assert.match(t.seen[parkIdx]!.q, /CourseVersionId = @versionId/);
    const lessonUpdates = t.seen.filter((s) => /UPDATE dbo\.NXA_Lessons\s+SET ChapterId/.test(s.q));
    assert.deepEqual(lessonUpdates.map((u) => [u.inputs["id"], u.inputs["seq"]]), [["302", 1], ["301", 2]]);
    const moduleUpdate = t.seen.find((s) => /UPDATE dbo\.NXA_CourseModules\s+SET ModuleTitle/.test(s.q))!;
    assert.equal(moduleUpdate.inputs["versionId"], "9");
  });

  it("stores lesson study text in ContentText and reads it back", async () => {
    const t = tracked(handler());
    const course = await t.repo.replaceCurriculum("10", tree([{ id: "301", title: "L0", studyMaterialText: "Read chapter 3" }, { id: "n1", title: "New", studyMaterialText: "Notes" }]));
    const upd = t.seen.find((s) => /UPDATE dbo\.NXA_Lessons\s+SET ChapterId/.test(s.q))!;
    assert.match(upd.q, /ContentText = @content/);
    assert.equal(upd.inputs["content"], "Read chapter 3");
    const ins = t.seen.find((s) => s.q.includes("INSERT INTO dbo.NXA_Lessons"))!;
    assert.match(ins.q, /ExternalUrl, ContentText, IsPreview/);
    assert.equal(ins.inputs["content"], "Notes");
    assert.equal(course.modules[0]!.chapters[0]!.lessons[0]!.studyMaterialText, "Read chapter 3");
  });

  it("still refuses PDF and link content (NXA_LearningMaterials types are not established)", async () => {
    const t = tracked(handler());
    await assert.rejects(t.repo.replaceCurriculum("10", tree([{ id: "301", title: "L", pdfUrl: "https://x/y.pdf" }])), UnsupportedFieldsError);
    assert.equal(t.state.began, 0);
  });

  it("re-saving the same tree inserts and deletes nothing", async () => {
    const t = tracked(handler());
    await t.repo.replaceCurriculum("10", tree([{ id: "301", title: "L0" }, { id: "302", title: "L1" }]));
    assert.equal(t.writes().filter((w) => /\b(INSERT|DELETE)\b/.test(w.q)).length, 0);
  });

  it("refuses ambiguous versions without writing anything", async () => {
    for (const versions of [
      [{ CourseVersionId: 1, IsCurrent: true }, { CourseVersionId: 2, IsCurrent: true }],
      [{ CourseVersionId: 1, IsCurrent: false }],
    ]) {
      const t = tracked(handler({ versions }));
      await assert.rejects(t.repo.replaceCurriculum("10", tree([{ id: "301", title: "L0" }])), RecordInUseError);
      assert.ok(t.state.rolledBack && !t.state.committed);
      assert.equal(t.writes().length, 0);
    }
  });

  it("rolls back the whole save when a write fails midway", async () => {
    const t = tracked(handler({ fail: (q) => (q.includes("INSERT INTO dbo.NXA_Lessons") ? new Error("insert failed") : undefined) }));
    await assert.rejects(t.repo.replaceCurriculum("10", tree([{ id: "301", title: "L0" }, { id: "n1", title: "New" }])), /insert failed/);
    assert.ok(t.state.rolledBack && !t.state.committed);
  });

  it("treats a non-numeric course id as not found without querying", async () => {
    const t = tracked(handler());
    await assert.rejects(t.repo.replaceCurriculum("course-x", []), RecordNotFoundError);
    assert.equal(t.seen.length, 0);
  });
});

describe("prerequisites against the live schema (SqlServerCourseRepository)", () => {
  const handler = (over: { courseExists?: boolean; found?: number[]; edges?: Array<[number, number]>; fail?: (q: string) => Error | undefined } = {}): Handler => (q) => {
    const f = over.fail?.(q);
    if (f) return f;
    if (q.includes("WHERE CourseId = @id AND DeletedAt IS NULL")) return { recordset: over.courseExists === false ? [] : [{ CourseId: 10 }] };
    if (q.includes("CourseId IN (")) return { recordset: (over.found ?? [20, 30]).map((id) => ({ CourseId: id })) };
    if (q.includes("FROM dbo.NXA_CoursePrerequisites WITH (UPDLOCK, HOLDLOCK)")) {
      return { recordset: (over.edges ?? []).map(([c, p]) => ({ CourseId: c, PrerequisiteCourseId: p })) };
    }
    if (q.includes("JOIN dbo.NXA_Courses c ON c.CourseId = p.PrerequisiteCourseId")) {
      return { recordset: [{ CourseId: 20, CourseCode: "JAVA", CourseName: "Core Java" }] };
    }
    return { recordset: [] };
  };

  it("adds and removes only the difference, in one transaction", async () => {
    const t = tracked(handler({ edges: [[10, 30], [10, 40]], found: [20, 30] }));
    const r = await t.repo.replacePrerequisites("10", ["20", "30"]);
    assert.equal(r.changed, true);
    assert.ok(t.state.committed);
    const del = t.writes().filter((w) => w.q.includes("DELETE FROM dbo.NXA_CoursePrerequisites"));
    const ins = t.writes().filter((w) => w.q.includes("INSERT INTO dbo.NXA_CoursePrerequisites"));
    assert.deepEqual(del.map((d) => d.inputs["prereqId"]), ["40"]);
    assert.deepEqual(ins.map((i) => i.inputs["prereqId"]), ["20"]);
    assert.match(ins[0]!.q, /\(CourseId, PrerequisiteCourseId\)/);
    assert.deepEqual(r.prerequisites, [{ courseId: "20", courseCode: "JAVA", title: "Core Java" }]);
  });

  it("writes nothing for an unchanged set", async () => {
    const t = tracked(handler({ edges: [[10, 20]], found: [20] }));
    const r = await t.repo.replacePrerequisites("10", ["20"]);
    assert.equal(r.changed, false);
    assert.equal(t.writes().length, 0);
  });

  it("refuses a self-dependency before opening a transaction", async () => {
    const t = tracked(handler());
    await assert.rejects(t.repo.replacePrerequisites("10", ["10"]), (e: Error & { code?: string }) => e.code === "SELF_PREREQUISITE");
    assert.equal(t.state.began, 0);
  });

  it("refuses unknown or deleted prerequisite courses and rolls back", async () => {
    const t = tracked(handler({ found: [20] }));
    await assert.rejects(
      t.repo.replacePrerequisites("10", ["20", "99"]),
      (e: Error & { code?: string; courseIds?: string[] }) => e.code === "UNKNOWN_PREREQUISITE_COURSE" && e.courseIds?.join() === "99",
    );
    assert.ok(t.state.rolledBack);
    assert.equal(t.writes().length, 0);
    const nonNumeric = tracked(handler());
    await assert.rejects(nonNumeric.repo.replacePrerequisites("10", ["java-101"]), (e: Error & { code?: string }) => e.code === "UNKNOWN_PREREQUISITE_COURSE");
  });

  it("refuses a circular chain and rolls back", async () => {
    // 20 already requires 30, and 30 requires 10: making 20 a prerequisite of 10 closes the loop.
    const t = tracked(handler({ edges: [[20, 30], [30, 10]], found: [20] }));
    await assert.rejects(
      t.repo.replacePrerequisites("10", ["20"]),
      (e: Error & { code?: string; courseIds?: string[] }) => e.code === "CIRCULAR_PREREQUISITE" && e.courseIds?.join("->") === "10->20->30->10",
    );
    assert.ok(t.state.rolledBack && !t.state.committed);
    assert.equal(t.writes().length, 0);
  });

  it("reports an unknown course and rolls back when a write fails", async () => {
    const missing = tracked(handler({ courseExists: false }));
    await assert.rejects(missing.repo.replacePrerequisites("10", []), RecordNotFoundError);
    await assert.rejects(missing.repo.findPrerequisites("10"), RecordNotFoundError);
    await assert.rejects(tracked(handler()).repo.findPrerequisites("course-x"), RecordNotFoundError);

    const failing = tracked(handler({ found: [20], fail: (q) => (q.includes("INSERT INTO dbo.NXA_CoursePrerequisites") ? new Error("insert failed") : undefined) }));
    await assert.rejects(failing.repo.replacePrerequisites("10", ["20"]), /insert failed/);
    assert.ok(failing.state.rolledBack && !failing.state.committed);
  });
});

describe("course content and prerequisite endpoints", () => {
  let harness: TestHarness;
  let server: TestServer;
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const auth = (role: string) => ({ headers: { Authorization: `Bearer ${tokens[role]}`, "Content-Type": "application/json" } });
  const json = async (res: Response) => (await res.json()) as Record<string, any>;

  const makeCourse = async (slug: string, title: string) =>
    (
      await harness.courses.create({
        slug, title, shortDescription: "x", longDescription: "x", durationWeeks: 8, feeINR: 30000, level: "Beginner",
        prerequisites: [], learningOutcomes: [],
      } as Parameters<TestHarness["courses"]["create"]>[0])
    ).id;

  beforeEach(async () => {
    harness = createTestHarness();
    let seq = 30;
    for (const role of ["admin", "super_admin", "teacher", "student"] as const) {
      seq++;
      const user = await harness.users.create({ name: `${role} User`, email: `${role}-${seq}@test.local`, mobile: `98765432${seq}`, role, status: "active" });
      const session = await harness.sessions.create({
        userId: user.id,
        refreshTokenHash: Buffer.alloc(64, 1).toString("hex"),
        ipAddress: "127.0.0.1",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
      tokens[role] = issueAccessToken({ userId: user.id, role, sessionId: session.sessionId }).token;
    }
    ids["a"] = await makeCourse("course-a", "Course A");
    ids["b"] = await makeCourse("course-b", "Course B");
    ids["c"] = await makeCourse("course-c", "Course C");
    const authenticate = createAuthenticate({ studentAccess: null, sessions: () => harness.sessions });
    server = await startServer(createApp({ container: harness.container, authenticate }));
  });

  afterEach(async () => {
    await server.close();
  });

  const putPrereqs = (course: string, list: string[], role = "admin") =>
    server.put(`/api/v1/courses/${course}/prerequisites`, { prerequisiteCourseIds: list }, auth(role));

  it("sets, reads, no-ops and clears prerequisites for Admin and Super Admin", async () => {
    const set = await putPrereqs(ids["a"]!, [ids["b"]!]);
    assert.equal(set.status, 200);
    const body = await json(set);
    assert.equal(body["message"], "Prerequisites updated");
    assert.deepEqual(body["data"].map((p: { courseId: string }) => p.courseId), [ids["b"]]);

    const same = await json(await putPrereqs(ids["a"]!, [ids["b"]!], "super_admin"));
    assert.equal(same["message"], "Prerequisites unchanged");

    const read = await json(await server.get(`/api/v1/courses/manage/${ids["a"]}/prerequisites`, auth("super_admin")));
    assert.equal(read["data"][0].title, "Course B");

    const cleared = await json(await putPrereqs(ids["a"]!, []));
    assert.deepEqual(cleared["data"], []);
  });

  it("refuses self, unknown, duplicate and circular prerequisites with 422 and changes nothing", async () => {
    await putPrereqs(ids["b"]!, [ids["c"]!]);
    await putPrereqs(ids["c"]!, [ids["a"]!]);

    const self = await putPrereqs(ids["a"]!, [ids["a"]!]);
    assert.equal(self.status, 422);
    assert.equal((await json(self))["error"], "SELF_PREREQUISITE");

    const unknown = await putPrereqs(ids["a"]!, ["no-such-course"]);
    assert.equal(unknown.status, 422);
    assert.equal((await json(unknown))["error"], "UNKNOWN_PREREQUISITE_COURSE");

    assert.equal((await putPrereqs(ids["a"]!, [ids["b"]!, ids["b"]!])).status, 422, "duplicates");

    const cycle = await putPrereqs(ids["a"]!, [ids["b"]!]); // a -> b -> c -> a
    assert.equal(cycle.status, 422);
    const cb = await json(cycle);
    assert.equal(cb["error"], "CIRCULAR_PREREQUISITE");
    assert.match(JSON.stringify(cb["details"]), /->/);
    assert.deepEqual(harness.courses.prerequisiteLinks.get(ids["a"]!) ?? [], []);
  });

  it("returns 404 for an unknown course", async () => {
    assert.equal((await putPrereqs("missing-course", [ids["a"]!])).status, 404);
    assert.equal((await server.get("/api/v1/courses/manage/missing-course/prerequisites", auth("admin"))).status, 404);
  });

  it("keeps prerequisites and curriculum management Admin / Super Admin only", async () => {
    for (const role of ["teacher", "student"]) {
      assert.equal((await putPrereqs(ids["a"]!, [ids["b"]!], role)).status, 403, role);
      assert.equal((await server.get(`/api/v1/courses/manage/${ids["a"]}/prerequisites`, auth(role))).status, 403, role);
      assert.equal((await server.put(`/api/v1/courses/${ids["a"]}/curriculum`, { modules: [] }, auth(role))).status, 403, role);
    }
    const anon = await server.put(`/api/v1/courses/${ids["a"]}/prerequisites`, { prerequisiteCourseIds: [] }, { headers: { "Content-Type": "application/json" } });
    assert.equal(anon.status, 401);
    assert.equal(harness.courses.prerequisiteLinks.size, 0);
  });

  it("refuses curriculum items attached to the wrong course or parent, and over-long descriptions", async () => {
    const lesson = { id: "l1", chapterId: "c1", title: "Intro", durationMinutes: 5, isFreePreview: false, order: 1 };
    const chapter = { id: "c1", moduleId: "m1", title: "Basics", order: 1, lessons: [lesson] };
    const mod = { id: "m1", courseId: ids["a"], title: "Module 1", description: "", order: 1, chapters: [chapter] };
    const put = (modules: unknown[]) => server.put(`/api/v1/courses/${ids["a"]}/curriculum`, { modules }, auth("admin"));

    assert.equal((await put([{ ...mod, courseId: ids["b"] }])).status, 422, "module of another course");
    assert.equal((await put([{ ...mod, chapters: [{ ...chapter, moduleId: "other" }] }])).status, 422, "chapter under the wrong module");
    assert.equal((await put([{ ...mod, chapters: [{ ...chapter, lessons: [{ ...lesson, chapterId: "other" }] }] }])).status, 422, "lesson under the wrong chapter");
    assert.equal((await put([{ ...mod, chapters: [{ ...chapter, lessons: [lesson, { ...lesson }] }] }])).status, 422, "duplicate lesson id");
    assert.equal((await put([{ ...mod, description: "x".repeat(1001) }])).status, 422, "NXA_CourseModules.ModuleDescription is nvarchar(1000)");

    const ok = await put([mod]);
    assert.equal(ok.status, 200);
    assert.equal((await json(ok))["data"].modules[0].chapters[0].lessons[0].title, "Intro");
  });
});
