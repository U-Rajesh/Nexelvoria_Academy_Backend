import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type sql from "mssql";

import { createApp } from "../src/app";
import { createAuthenticate } from "../src/middleware/authenticate.middleware";
import { issueAccessToken } from "../src/modules/auth/token.service";
import { evaluateLessonAccess } from "../src/modules/courses/lesson-availability";
import { SqlServerCourseRepository } from "../src/modules/courses/sqlserver-course.repository";
import { curriculumBodySchema } from "../src/modules/courses/course.validation";
import type { Course, CourseModule, Lesson } from "../src/modules/courses/course.types";
import type { Enrollment } from "../src/modules/enrollments/enrollment.types";
import { createTestHarness, type TestHarness } from "./fakes";
import { startServer, type TestServer } from "./helpers/server";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * LMS-004 sequential unlocking and LMS-005 publish dates, enforced on the
 * server for every student lesson action (open, progress, materials, doubts).
 */
const lesson = (id: string, order: number, over: Partial<Lesson> = {}): Lesson => ({
  id, chapterId: "c1", title: `Lesson ${id}`, durationMinutes: 10, isFreePreview: false, order, studyMaterialText: `Content of ${id}`, ...over,
});
const FUTURE = new Date(Date.now() + 7 * 86400000).toISOString();
const PAST = new Date(Date.now() - 86400000).toISOString();

const modules = (lessons: Lesson[]): CourseModule[] => [
  { id: "m1", courseId: "11", title: "Module 1", description: "", order: 1, chapters: [{ id: "c1", moduleId: "m1", title: "Chapter 1", order: 1, lessons }] },
];

describe("lesson availability rules", () => {
  it("opens lessons in order only when they unlock in sequence, and never before their publish time", () => {
    const ls = [lesson("1", 1), lesson("2", 2, { isSequentialUnlock: true }), lesson("3", 3, { publishAt: FUTURE }), lesson("4", 4, { publishAt: PAST, isSequentialUnlock: true }), lesson("5", 5, { isPublished: false })];
    const before = evaluateLessonAccess(modules(ls), new Set());
    assert.deepEqual(before.map((a) => [a.lesson.id, a.state]), [["1", "available"], ["2", "locked"], ["3", "scheduled"], ["4", "locked"]], "unpublished lessons are not part of the course");
    assert.equal(before[1]!.requiresLessonId, "1");
    const after = evaluateLessonAccess(modules(ls), new Set(["1", "3"]));
    assert.deepEqual(after.map((a) => a.state), ["available", "available", "scheduled", "available"]);
  });
});

describe("student lesson access (HTTP)", () => {
  let harness: TestHarness;
  let server: TestServer;
  let token = "";
  let otherToken = "";
  const json = async (res: Response) => (await res.json()) as Record<string, any>;
  const auth = (t: string) => ({ headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" } });
  const course = (lessons: Lesson[]): Course =>
    ({ id: "11", slug: "fs", title: "Full Stack", shortDescription: "x", longDescription: "x", durationWeeks: 8, feeINR: 1, level: "Beginner", technologies: [], modules: modules(lessons), isPublished: true, status: "Published", hasPlacementGuarantee: false, prerequisites: [], learningOutcomes: [] }) as unknown as Course;
  const enroll = (studentId: string, completed: string[] = [], status = "active") =>
    harness.enrollments.seed({ id: `e-${studentId}`, studentId, courseId: "11", status, enrolledAt: new Date().toISOString(), progressPercentage: 0, completedLessonIds: completed, bookmarkedLessonIds: [] } as unknown as Enrollment);

  beforeEach(async () => {
    harness = createTestHarness();
    harness.courses.seed(course([lesson("101", 1), lesson("102", 2, { isSequentialUnlock: true }), lesson("103", 3, { publishAt: FUTURE })]));
    for (const [id, set] of [["501", (t: string) => (token = t)], ["502", (t: string) => (otherToken = t)]] as const) {
      const s = await harness.sessions.create({ userId: id, refreshTokenHash: Buffer.alloc(64, 9).toString("hex"), ipAddress: "127.0.0.1", expiresAt: new Date(Date.now() + 3600000).toISOString() });
      set(issueAccessToken({ userId: id, role: "student", sessionId: s.sessionId }).token);
    }
    const authenticate = createAuthenticate({ studentAccess: null, sessions: () => harness.sessions });
    server = await startServer(createApp({ container: harness.container, authenticate }));
  });

  afterEach(async () => {
    await server.close();
  });

  it("shows the outline with each lesson's state and serves only open lessons", async () => {
    enroll("501");
    const outline = (await json(await server.get("/api/v1/teachers/lms/courses/11/lessons", auth(token))))["data"];
    assert.deepEqual(outline.map((l: any) => [l.id, l.state]), [["101", "available"], ["102", "locked"], ["103", "scheduled"]]);
    assert.equal("studyMaterialText" in outline[0], false, "the outline carries no content");

    const open = await json(await server.get("/api/v1/teachers/lms/courses/11/lessons/101", auth(token)));
    assert.equal(open["data"].studyMaterialText, "Content of 101");

    const locked = await server.get("/api/v1/teachers/lms/courses/11/lessons/102", auth(token));
    assert.equal(locked.status, 403);
    const lockedBody = await json(locked);
    assert.equal(lockedBody["error"], "LESSON_LOCKED");
    assert.match(lockedBody["message"], /Lesson 101/);
    const scheduled = await server.get("/api/v1/teachers/lms/courses/11/lessons/103", auth(token));
    assert.equal(scheduled.status, 403);
    assert.equal((await json(scheduled))["error"], "LESSON_NOT_YET_AVAILABLE");
  });

  it("refuses progress on a locked or scheduled lesson through the API, and accepts it once unlocked", async () => {
    enroll("501");
    assert.equal((await server.post("/api/v1/teachers/lms/lessons/102/progress", { isCompleted: true }, auth(token))).status, 403);
    assert.equal((await server.post("/api/v1/teachers/lms/lessons/103/progress", { isCompleted: true }, auth(token))).status, 403);
    assert.equal((await server.post("/api/v1/teachers/lms/lessons/101/progress", { isCompleted: true }, auth(token))).status, 200);
    harness.enrollments.seed({ ...(await harness.enrollments.findByStudent("501"))[0]!, completedLessonIds: ["101"] });
    assert.equal((await server.get("/api/v1/teachers/lms/courses/11/lessons/102", auth(token))).status, 200, "unlocked after completing the previous lesson");
  });

  it("lets an Admin save sequential unlock and a publish time through the curriculum, and reads them back", async () => {
    const s = await harness.sessions.create({ userId: "201", refreshTokenHash: Buffer.alloc(64, 8).toString("hex"), ipAddress: "127.0.0.1", expiresAt: new Date(Date.now() + 3600000).toISOString() });
    const admin = issueAccessToken({ userId: "201", role: "admin", sessionId: s.sessionId }).token;
    const at = "2026-12-01T09:00:00+05:30";
    const body = {
      modules: [{ id: "m1", courseId: "11", title: "Module 1", description: "", order: 1, chapters: [{ id: "c1", moduleId: "m1", title: "Chapter 1", order: 1, lessons: [
        { id: "101", chapterId: "c1", title: "Lesson 101", durationMinutes: 10, isFreePreview: false, order: 1 },
        { id: "102", chapterId: "c1", title: "Lesson 102", durationMinutes: 10, isFreePreview: false, order: 2, isSequentialUnlock: true, publishAt: at },
      ] }] }],
    };
    assert.equal((await server.put("/api/v1/courses/11/curriculum", body, auth(admin))).status, 200);
    const managed = (await json(await server.get("/api/v1/courses/manage/11", auth(admin))))["data"];
    const l = managed.modules[0].chapters[0].lessons[1];
    assert.equal(l.isSequentialUnlock, true);
    assert.equal(Date.parse(l.publishAt), Date.parse(at));
  });

  it("gives no lesson to students without an active enrollment", async () => {
    enroll("502", [], "approved_unpaid");
    assert.equal((await server.get("/api/v1/teachers/lms/courses/11/lessons", auth(otherToken))).status, 403);
    assert.equal((await server.get("/api/v1/teachers/lms/courses/11/lessons/101", auth(otherToken))).status, 403);
    assert.equal((await server.get("/api/v1/teachers/lms/courses/11/lessons")).status, 401);
  });
});

describe("curriculum settings for LMS-004 / LMS-005", () => {
  it("accepts sequential unlock and an absolute publish time, and refuses a time without an offset", () => {
    const body = (publishAt: unknown) => ({
      modules: [{ id: "m1", courseId: "11", title: "M", description: "", order: 1, chapters: [{ id: "c1", moduleId: "m1", title: "C", order: 1, lessons: [{ id: "l1", chapterId: "c1", title: "L", durationMinutes: 5, isFreePreview: false, order: 1, isSequentialUnlock: true, publishAt }] }] }],
    });
    assert.equal(curriculumBodySchema.safeParse(body("2026-12-01T09:00:00+05:30")).success, true);
    assert.equal(curriculumBodySchema.safeParse(body(null)).success, true);
    assert.equal(curriculumBodySchema.safeParse(body("2026-12-01 09:00")).success, false);
  });

  it("reads IsSequentialUnlock, PublishAt and Status from NXA_Lessons", async () => {
    const seen: string[] = [];
    const pool = {
      request: () => {
        const r: any = { input: () => r, query: async (q: string) => {
          seen.push(q);
          if (q.includes("NXA_CourseModules")) {
            return { recordset: [{ ModuleId: 1, CourseId: 11, ModuleTitle: "M", ModuleDescription: null, ModuleSequence: 1, ChapterId: 2, ChapterTitle: "C", ChapterDescription: null, ChapterSequence: 1, LessonId: 3, LessonTitle: "L", LessonType: "reading", DurationMinutes: 5, ExternalUrl: null, ContentText: "x", IsPreview: 0, IsDownloadAllowed: 1, IsSequentialUnlock: 1, PublishAt: new Date("2026-12-01T03:30:00Z"), LessonStatus: "PUBLISHED", LessonSequence: 1 }] };
          }
          return { recordset: [{ CourseId: 11, CourseCode: "FS", CourseName: "Full Stack", CourseLevel: "Beginner", Description: "d", ShortDescription: "s", DurationValue: 8, DurationUnit: "WEEKS", ListPrice: 1, CurrencyCode: "INR", IsPreviewEnabled: 0, Status: "PUBLISHED", CreatedAt: new Date(), UpdatedAt: null }] };
        } };
        return r;
      },
    } as unknown as sql.ConnectionPool;
    const c = await new SqlServerCourseRepository(pool).findById("11");
    const l = c!.modules[0]!.chapters[0]!.lessons[0]!;
    assert.equal(l.isSequentialUnlock, true);
    assert.equal(l.publishAt, "2026-12-01T03:30:00.000Z");
    assert.equal(l.isPublished, true);
    assert.ok(seen.some((q) => /l\.IsSequentialUnlock,\s+l\.PublishAt,\s+l\.Status AS LessonStatus/.test(q)));
  });
});
