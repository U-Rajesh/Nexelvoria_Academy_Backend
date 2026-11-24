import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type sql from "mssql";

import { createApp } from "../src/app";
import { createAuthenticate } from "../src/middleware/authenticate.middleware";
import { issueAccessToken } from "../src/modules/auth/token.service";
import {
  BR011_MIN_ATTENDANCE_PERCENT,
  BR011_MIN_EXAM_PERCENT,
  attendanceFigure,
  effectiveThreshold,
  isBelowThreshold,
} from "../src/modules/academics/academic-rules";
import { applyNewLessonDefaults } from "../src/modules/courses/course.service";
import type { CourseModule } from "../src/modules/courses/course.types";
import { SqlServerReportsRepository } from "../src/modules/reports/sqlserver-reports.repository";
import { createTestHarness, type TestHarness } from "./fakes";
import { startServer, type TestServer } from "./helpers/server";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Item 11A-1: approved decisions D1 (BR-011 floors), D2 (attendance formula)
 * and D9 (academic and course settings). Mock pools and in-memory fakes only.
 */

describe("D2 attendance formula and D1 floors (unit)", () => {
  it("Present ÷ marked sessions × 100, Leave counts as not attended", () => {
    assert.deepEqual(attendanceFigure({ present: 3, absent: 1, leave: 0 }), { markedSessions: 4, percentage: 75, percentageDisplay: "75.0" });
    const withLeave = attendanceFigure({ present: 3, absent: 0, leave: 1 });
    assert.equal(withLeave.percentage, 75, "leave is in the denominator, not the numerator");
    assert.deepEqual(attendanceFigure({ present: 0, absent: 0, leave: 4 }), { markedSessions: 4, percentage: 0, percentageDisplay: "0.0" });
    assert.equal(attendanceFigure({ present: 5, absent: 0, leave: 0 }).percentage, 100);
  });

  it("returns no percentage when nothing is marked (no division by zero, nothing fabricated)", () => {
    assert.deepEqual(attendanceFigure({ present: 0, absent: 0, leave: 0 }), { markedSessions: 0, percentage: null, percentageDisplay: null });
    assert.equal(isBelowThreshold(null, 75), null);
  });

  it("displays one decimal but compares the unrounded value", () => {
    // 1499 / 2000 = 74.95% -> shows "75.0" (toFixed rounds half up here) yet is below 75.
    const f = attendanceFigure({ present: 2999, absent: 1001, leave: 0 });
    assert.equal(f.percentageDisplay, "75.0");
    assert.ok(f.percentage! < 75);
    assert.equal(isBelowThreshold(f.percentage, 75), true);
    assert.equal(isBelowThreshold(75, 75), false, "exactly at the minimum is not below it");
    assert.equal(attendanceFigure({ present: 2, absent: 1, leave: 0 }).percentageDisplay, "66.7");
  });

  it("never lets a saved value lower the BR-011 floors", () => {
    assert.equal(BR011_MIN_ATTENDANCE_PERCENT, 75);
    assert.equal(BR011_MIN_EXAM_PERCENT, 60);
    assert.equal(effectiveThreshold(undefined, 75), 75, "never saved: the floor");
    assert.equal(effectiveThreshold(60, 75), 75, "a lower stored value (e.g. written before D1) is ignored");
    assert.equal(effectiveThreshold(80, 75), 80, "raised: applied");
    assert.equal(effectiveThreshold(101, 75), 75);
    assert.equal(effectiveThreshold(Number.NaN, 60), 60);
    assert.equal(effectiveThreshold(65, 60), 65);
  });
});

describe("D9 new-lesson defaults (unit)", () => {
  const tree = (lessons: Array<Record<string, unknown>>): CourseModule[] =>
    [{ id: "m1", courseId: "c1", title: "M", description: "", order: 1, chapters: [{ id: "ch1", moduleId: "m1", title: "C", order: 1, lessons }] }] as any;

  it("fills only unset fields of lessons that are not stored yet", () => {
    const out = applyNewLessonDefaults(
      tree([
        { id: "stored-1", title: "Existing", isFreePreview: false },
        { id: "new-1", title: "New" },
        { id: "new-2", title: "Explicit", isSequentialUnlock: false, isDownloadRestricted: true },
      ]),
      new Set(["stored-1"]),
      { sequentialUnlock: true, downloadAllowed: true },
    );
    const [existing, fresh, explicit] = out[0]!.chapters[0]!.lessons as any[];
    assert.equal(existing.isSequentialUnlock, undefined, "an existing lesson is never changed");
    assert.equal(existing.isDownloadRestricted, undefined);
    assert.equal(fresh.isSequentialUnlock, true);
    assert.equal(fresh.isDownloadRestricted, false, "download allowed -> not restricted");
    assert.equal(explicit.isSequentialUnlock, false, "a value the editor sent wins");
    assert.equal(explicit.isDownloadRestricted, true);
  });

  it("changes nothing for a default that was never saved", () => {
    const out = applyNewLessonDefaults(tree([{ id: "new-1", title: "New" }]), new Set(), {});
    assert.deepEqual(out[0]!.chapters[0]!.lessons[0], { id: "new-1", title: "New" });
  });
});

describe("Attendance Summary report SQL (mock pool)", () => {
  it("filters the period on the sessions being aggregated, and returns raw counts only", async () => {
    const queries: string[] = [];
    const request = () => {
      const r: any = { input: () => r, query: async (q: string) => (queries.push(q), q.includes("COUNT(1) AS total") ? { recordset: [{ total: 1 }] } : { recordset: [{ batchCode: "B1", present: 3, absent: 1, leave: 0, otherStatus: 0 }] }) };
      return r;
    };
    const pool = { request } as unknown as sql.ConnectionPool;
    const repo = new SqlServerReportsRepository(async () => pool);
    const res = await repo.runReport("attendance-summary", { from: "2026-11-01", to: "2026-11-30", search: "B1" }, { page: 1, pageSize: 25 });
    assert.equal(res.total, 1);
    const data = queries[1]!;
    const inner = data.slice(0, data.indexOf("GROUP BY"));
    assert.match(inner, /AND cs\.StartsAt >= @fromUtc AND cs\.StartsAt < @toUtc/, "the range filters sessions inside the aggregate");
    const outer = data.slice(data.indexOf(") s"));
    assert.doesNotMatch(outer, /cs\.StartsAt/, "the outer query does not filter the aggregate by date");
    assert.match(outer, /s\.studentName LIKE @search/);
    assert.doesNotMatch(data, /RANGE/, "the marker is always replaced");
    assert.doesNotMatch(data, /\bpercentage\b|\* ?100/i, "no percentage is computed in SQL");
  });
});

describe("D1 / D2 / D9 settings, summary and report (HTTP, in-memory fakes)", () => {
  let harness: TestHarness;
  let server: TestServer;
  const tokens: Record<string, string> = {};
  const auth = (who: string) => ({ headers: { Authorization: `Bearer ${tokens[who]}`, "Content-Type": "application/json" } });
  const json = async (res: Response) => (await res.json()) as Record<string, any>;
  const settingsAudits = () => harness.admin.auditLogs.filter((l) => l.actionType === "UPDATE_SETTINGS");

  beforeEach(async () => {
    harness = createTestHarness();
    for (const [key, id, role] of [["admin", "201", "admin"], ["super", "202", "super_admin"], ["teacher", "301", "teacher"]] as const) {
      const session = await harness.sessions.create({ userId: id, refreshTokenHash: Buffer.alloc(64, 7).toString("hex"), ipAddress: "127.0.0.1", expiresAt: new Date(Date.now() + 3600000).toISOString() });
      tokens[key] = issueAccessToken({ userId: id, role, sessionId: session.sessionId }).token;
    }
    delete harness.admin.instituteSettings.minAttendancePercentage;
    const authenticate = createAuthenticate({ studentAccess: null, sessions: () => harness.sessions });
    server = await startServer(createApp({ container: harness.container, authenticate }));
  });

  afterEach(async () => {
    await server.close();
  });

  it("lets only the Super Admin raise the minimum attendance and examination thresholds, never below the floors", async () => {
    for (const body of [{ minAttendancePercentage: 74 }, { minAttendancePercentage: 101 }, { minExamPercentage: 59 }, { minExamPercentage: 100.5 }]) {
      assert.equal((await server.put("/api/v1/admin/settings", body, auth("super"))).status, 422, JSON.stringify(body));
    }
    const admin = await server.put("/api/v1/admin/settings", { minAttendancePercentage: 80 }, auth("admin"));
    assert.equal(admin.status, 403, "an Admin cannot change a Super Admin setting");
    assert.equal((await json(admin))["error"], "SUPER_ADMIN_SETTING");
    assert.equal((await server.put("/api/v1/admin/settings", { minAttendancePercentage: 80 }, auth("teacher"))).status, 403);
    assert.equal(settingsAudits().length, 0, "refused saves are not audited");

    assert.equal((await server.put("/api/v1/admin/settings", { minAttendancePercentage: 80, minExamPercentage: 65 }, auth("super"))).status, 200);
    assert.deepEqual(JSON.parse(String(settingsAudits()[0]!.newValues)), { minAttendancePercentage: 80, minExamPercentage: 65 });
    assert.equal(settingsAudits()[0]!.actorUserId, "202");
    assert.equal((await server.put("/api/v1/admin/settings", { minAttendancePercentage: 80 }, auth("super"))).status, 200);
    assert.equal(settingsAudits().length, 1, "a no-op save is not audited");

    const catalog = (await json(await server.get("/api/v1/admin/settings/catalog", auth("admin"))))["data"];
    const att = catalog.find((s: any) => s.key === "minAttendancePercentage");
    assert.deepEqual([att.status, att.min, att.max, att.defaultValue, att.editableBy], ["applied", 75, 100, 75, "super_admin"]);
    assert.equal(catalog.find((s: any) => s.key === "minExamPercentage").status, "stored", "saved, but nothing consumes it yet (honestly labelled)");
  });

  it("keeps the previous thresholds when the settings audit fails", async () => {
    harness.admin.failSettingsAudit = true;
    assert.equal((await server.put("/api/v1/admin/settings", { minAttendancePercentage: 90 }, auth("super"))).status, 500);
    assert.equal(harness.admin.instituteSettings.minAttendancePercentage, undefined);
  });

  it("lets an Admin set the new-lesson defaults (D9)", async () => {
    assert.equal((await server.put("/api/v1/admin/settings", { defaultLessonSequentialUnlock: true, defaultLessonDownloadAllowed: true }, auth("admin"))).status, 200);
    assert.equal(harness.admin.instituteSettings.defaultLessonSequentialUnlock, true);
    assert.equal((await server.put("/api/v1/admin/settings", { defaultLessonSequentialUnlock: "yes" }, auth("admin"))).status, 422);
  });

  it("applies the defaults to new lessons only, and leaves existing lessons as stored", async () => {
    const course = await harness.courses.create({ slug: "java-fs", courseCode: "java-fs", title: "Java", shortDescription: "s", longDescription: "l", durationWeeks: 1, feeINR: 1, level: "Beginner" } as any);
    const lesson = (id: string, extra: Record<string, unknown> = {}) => ({ id, chapterId: "c1", title: id, durationMinutes: 10, isFreePreview: false, order: 1, ...extra });
    const body = (lessons: unknown[]) => ({ modules: [{ id: "m1", courseId: course.id, title: "M1", description: "", order: 1, chapters: [{ id: "c1", moduleId: "m1", title: "C1", order: 1, lessons }] }] });
    const stored = () => harness.courses.findById(course.id).then((c) => c!.modules[0]!.chapters[0]!.lessons as any[]);

    // Before any default is saved: lessons are stored exactly as sent.
    assert.equal((await server.put(`/api/v1/courses/${course.id}/curriculum`, body([lesson("l1")]), auth("admin"))).status, 200);
    assert.equal((await stored())[0].isSequentialUnlock, undefined);

    await server.put("/api/v1/admin/settings", { defaultLessonSequentialUnlock: true, defaultLessonDownloadAllowed: true }, auth("admin"));
    assert.equal((await server.put(`/api/v1/courses/${course.id}/curriculum`, body([lesson("l1"), lesson("l2"), lesson("l3", { isSequentialUnlock: false })]), auth("admin"))).status, 200);
    const [l1, l2, l3] = await stored();
    assert.equal(l1.isSequentialUnlock, undefined, "an existing lesson is not changed when a default changes");
    assert.equal(l1.isDownloadRestricted, undefined);
    assert.deepEqual([l2.isSequentialUnlock, l2.isDownloadRestricted], [true, false], "the new lesson takes the defaults");
    assert.equal(l3.isSequentialUnlock, false, "an explicit value is kept");
  });

  it("adds the D2 percentage and the below-minimum flag to the Admin attendance summary", async () => {
    const a = harness.academics;
    a.batches.push({ id: "10", courseId: "5", status: "ongoing" });
    for (const s of ["401", "402", "403"]) a.enrollments.push({ studentUserId: s, courseId: "5", batchId: "10", status: "ACTIVE" });
    const past = (d: number) => new Date(Date.now() - d * 86400000).toISOString();
    for (let i = 1; i <= 5; i++) a.sessions.push({ id: String(i), batchId: "10", courseId: "5", teacherUserId: "301", sessionTitle: `S${i}`, startsAt: past(i), endsAt: past(i) } as any);
    const mark = (sessionId: string, studentUserId: string, status: string) =>
      a.records.push({ id: `${sessionId}-${studentUserId}`, sessionId, studentUserId, status, markedAt: past(0), markedByUserId: "301" });
    // 401: 3 present of 4 marked (session 5 unmarked) = 75%.
    mark("1", "401", "PRESENT"); mark("2", "401", "PRESENT"); mark("3", "401", "PRESENT"); mark("4", "401", "ABSENT");
    // 402: 2 present, 1 leave = 66.7%; plus one LATE record, outside the formula.
    mark("1", "402", "PRESENT"); mark("2", "402", "PRESENT"); mark("3", "402", "LEAVE"); mark("4", "402", "LATE");
    // 403: nothing marked.

    const summary = (await json(await server.get("/api/v1/admin/academics/attendance/summary?batchId=10", auth("admin"))))["data"];
    assert.equal(summary.minimumAttendancePercentage, 75, "never saved: the BR-011 floor");
    const by = (id: string) => summary.students.find((s: any) => s.studentUserId === id);
    assert.deepEqual([by("401").attendancePercentage, by("401").markedSessions, by("401").belowMinimum], [75, 4, false], "unmarked session 5 is not counted");
    assert.deepEqual([by("402").attendancePercentageDisplay, by("402").markedSessions, by("402").other, by("402").belowMinimum], ["66.7", 3, 1, true]);
    assert.deepEqual([by("403").attendancePercentage, by("403").belowMinimum], [null, null], "no marks: no fabricated percentage");

    harness.admin.instituteSettings.minAttendancePercentage = 80;
    const raised = (await json(await server.get("/api/v1/admin/academics/attendance/summary?batchId=10", auth("admin"))))["data"];
    assert.equal(raised.minimumAttendancePercentage, 80);
    assert.equal(raised.students.find((s: any) => s.studentUserId === "401").belowMinimum, true);

    harness.admin.instituteSettings.minAttendancePercentage = 50; // e.g. a row written before D1
    const floored = (await json(await server.get("/api/v1/admin/academics/attendance/summary?batchId=10", auth("admin"))))["data"];
    assert.equal(floored.minimumAttendancePercentage, 75, "a stored value below the floor never applies");
  });

  it("serves the Attendance Summary report and its exports with the same figures", async () => {
    const row = (studentName: string, present: number, absent: number, leave: number) => ({
      at: new Date().toISOString(),
      search: studentName,
      data: { batchCode: "B1", batchName: "Batch 1", studentName, present, absent, leave, otherStatus: 0 },
    });
    harness.reports.rows["attendance-summary"] = [row("Asha", 3, 1, 0), row("Ravi", 2, 0, 2), row("Meena", 0, 0, 0)];
    harness.admin.instituteSettings.minAttendancePercentage = 80;

    const page = (await json(await server.get("/api/v1/admin/reports/attendance-summary", auth("admin"))))["data"];
    assert.equal(page.minimumAttendancePercentage, 80);
    const by = (n: string) => page.rows.find((r: any) => r.studentName === n);
    assert.deepEqual([by("Asha").attendancePercentage, by("Asha").belowMinimum, by("Asha").markedSessions], ["75.0", "yes", 4]);
    assert.deepEqual([by("Ravi").attendancePercentage, by("Ravi").belowMinimum], ["50.0", "yes"], "leave counts as not attended");
    assert.deepEqual([by("Meena").attendancePercentage, by("Meena").belowMinimum], ["", ""]);

    const csv = await server.get("/api/v1/admin/reports/attendance-summary/export?format=csv", auth("super"));
    assert.equal(csv.status, 200);
    const text = await csv.text();
    assert.match(text, /Asha.*75\.0.*yes/);
    assert.equal(harness.reports.exports.at(-1)?.reportCode, "attendance-summary", "the export is audited");
    assert.equal((await server.get("/api/v1/admin/reports/attendance-summary", auth("teacher"))).status, 403);
  });
});
