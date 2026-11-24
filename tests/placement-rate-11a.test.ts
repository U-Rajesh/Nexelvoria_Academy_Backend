import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type sql from "mssql";

import { createApp } from "../src/app";
import { createAuthenticate } from "../src/middleware/authenticate.middleware";
import { placementRate } from "../src/modules/admin/placement-rate";
import { SqlServerAdminRepository } from "../src/modules/admin/sqlserver-admin.repository";
import { issueAccessToken } from "../src/modules/auth/token.service";
import { createTestHarness, type TestHarness } from "./fakes";
import { startServer, type TestServer } from "./helpers/server";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Item 11A-4: approved decision D15. Cohort placement rate and open-queue
 * system alerts. Mock pools and in-memory fakes only.
 */

describe("D15 placement rate (unit)", () => {
  it("is placed ÷ completed for the cohort, null for an empty cohort", () => {
    assert.equal(placementRate({ completedStudents: 4, placedStudents: 3 }), 75);
    assert.equal(placementRate({ completedStudents: 0, placedStudents: 0 }), null, "no completed students: no fabricated rate");
    assert.equal(placementRate({ completedStudents: 3, placedStudents: 0 }), 0);
    assert.equal(placementRate({ completedStudents: 2, placedStudents: 5 }), 100, "never above 100 even if the inputs disagree");
  });
});

describe("D15 cohort SQL (mock pool)", () => {
  it("counts distinct completed-in-period students and only those of them with a placement record", async () => {
    let captured: { q: string; inputs: Record<string, unknown> } | null = null;
    const request = () => {
      const inputs: Record<string, unknown> = {};
      const r: any = {
        input: (n: string, t: unknown, v?: unknown) => ((inputs[n] = v !== undefined ? v : t), r),
        query: async (q: string) => ((captured = { q, inputs }), { recordset: [{ completedStudents: 10, placedStudents: 4 }] }),
      };
      return r;
    };
    const repo = new SqlServerAdminRepository({ request } as unknown as sql.ConnectionPool);
    const from = new Date("2026-03-31T18:30:00Z");
    const to = new Date("2026-11-24T18:30:00Z");
    assert.deepEqual(await repo.getPlacementCohort({ fromUtc: from, toUtc: to }), { completedStudents: 10, placedStudents: 4 });
    const { q, inputs } = captured!;
    assert.match(q, /SELECT DISTINCT e\.StudentUserId[\s\S]*UPPER\(e\.EnrollmentStatus\) = 'COMPLETED' AND e\.CompletedAt >= @fromUtc AND e\.CompletedAt < @toUtc/);
    assert.match(q, /SELECT DISTINCT p\.StudentUserId FROM dbo\.NXA_PlacementRecords/, "duplicate records count once");
    assert.match(q, /FROM cohort c JOIN placed p ON p\.StudentUserId = c\.StudentUserId/, "the numerator is drawn from the cohort");
    assert.doesNotMatch(q, /EmploymentStatus/, "unconfirmed EmploymentStatus values are not used");
    assert.deepEqual([inputs["fromUtc"], inputs["toUtc"]], [from, to]);
  });
});

describe("D15 dashboard and placement-rate endpoint (HTTP, in-memory fakes)", () => {
  let harness: TestHarness;
  let server: TestServer;
  const tokens: Record<string, string> = {};
  const auth = (who: string) => ({ headers: { Authorization: `Bearer ${tokens[who]}`, "Content-Type": "application/json" } });
  const json = async (res: Response) => (await res.json()) as Record<string, any>;
  const completed = (studentUserId: string, completedAt: string) =>
    harness.admin.enrollments.push({
      id: `e-${harness.admin.enrollments.length + 1}`, studentUserId, courseId: "5", enrollmentNumber: "ENR", enrollmentStatus: "completed",
      coursePrice: 1, discountAmount: 0, finalAmount: 1, currencyCode: "INR", enrollmentSource: "admin", createdAt: completedAt, completedAt,
    } as any);

  beforeEach(async () => {
    harness = createTestHarness();
    for (const [key, id, role] of [["admin", "201", "admin"], ["super", "202", "super_admin"], ["teacher", "301", "teacher"]] as const) {
      const session = await harness.sessions.create({ userId: id, refreshTokenHash: Buffer.alloc(64, 7).toString("hex"), ipAddress: "127.0.0.1", expiresAt: new Date(Date.now() + 3600000).toISOString() });
      tokens[key] = issueAccessToken({ userId: id, role, sessionId: session.sessionId }).token;
    }
    const authenticate = createAuthenticate({ studentAccess: null, sessions: () => harness.sessions });
    server = await startServer(createApp({ container: harness.container, authenticate }));
  });

  afterEach(async () => {
    await server.close();
  });

  it("computes the cohort rate for a chosen period, with IST boundaries and distinct students", async () => {
    completed("s1", "2026-06-10T05:00:00Z");
    completed("s1", "2026-07-10T05:00:00Z"); // a second completed course: still one student
    completed("s2", "2026-06-30T18:29:59Z"); // 23:59:59 IST on 30 June: inside
    completed("s3", "2026-06-30T18:30:00Z"); // 00:00 IST on 1 July: outside June
    completed("s4", "2026-06-15T05:00:00Z");
    harness.admin.placementRecordStudentIds = ["s1", "s1", "s3", "s9"]; // s1 twice; s3 outside the period; s9 not in the cohort

    const june = (await json(await server.get("/api/v1/admin/dashboard/placement-rate?from=2026-06-01&to=2026-06-30", auth("admin"))))["data"];
    assert.deepEqual([june.completedStudents, june.placedStudents], [3, 1], "s1, s2, s4 completed in June; only s1 is placed");
    assert.ok(Math.abs(june.placementRate - 100 / 3) < 1e-9);

    const empty = (await json(await server.get("/api/v1/admin/dashboard/placement-rate?from=2025-01-01&to=2025-01-31", auth("admin"))))["data"];
    assert.deepEqual([empty.completedStudents, empty.placedStudents, empty.placementRate], [0, 0, null]);

    assert.equal((await server.get("/api/v1/admin/dashboard/placement-rate?from=2026-07-01&to=2026-06-01", auth("admin"))).status, 422);
    assert.equal((await server.get("/api/v1/admin/dashboard/placement-rate?from=June&to=2026-06-30", auth("admin"))).status, 422);
    assert.equal((await server.get("/api/v1/admin/dashboard/placement-rate?from=2026-06-01&to=2026-06-30", auth("teacher"))).status, 403);
  });

  it("shows the financial-year rate and the open action queues on the Admin dashboard", async () => {
    completed("s1", new Date().toISOString());
    completed("s2", new Date().toISOString());
    harness.admin.placementRecordStudentIds = ["s2"];
    harness.admin.refunds.push({ id: "r1", refundStatus: "pending" } as any, { id: "r2", refundStatus: "approved" } as any);

    const stats = (await json(await server.get("/api/v1/admin/dashboard/stats", auth("admin"))))["data"];
    assert.equal(stats.placementRate, 50);
    assert.deepEqual(stats.placementCohort, { completedStudents: 2, placedStudents: 1 });
    assert.match(stats.placementRatePeriod.from, /^\d{4}-04-01$/, "the current Indian financial year");
    const pendingRefunds = (await harness.admin.findRefunds("pending")).length;
    const pendingOverrides = (await harness.admin.findFinancialOverrides("pending")).length;
    assert.deepEqual(stats.systemAlerts, { pendingStudentApprovals: stats.pendingApprovals, pendingRefundRequests: pendingRefunds, pendingFinancialOverrides: pendingOverrides });
    assert.equal(stats.systemAlertsCount, stats.pendingApprovals + pendingRefunds + pendingOverrides);
  });
});
