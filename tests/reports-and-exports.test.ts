import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { inflateRawSync } from "node:zlib";
import type sql from "mssql";

import { createApp } from "../src/app";
import { createAuthenticate } from "../src/middleware/authenticate.middleware";
import { issueAccessToken } from "../src/modules/auth/token.service";
import { SqlServerReportsRepository } from "../src/modules/reports/sqlserver-reports.repository";
import { crc32, toCsv, toPdf, toXlsx, type ReportColumn } from "../src/modules/reports/report-files";
import { MAX_EXPORT_ROWS, istDayStartUtc, monthsBetween } from "../src/modules/reports/reports.rules";
import { createTestHarness, type TestHarness } from "./fakes";
import { startServer, type TestServer } from "./helpers/server";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Batch 3 item 8: reports and dashboards (REP-001..REP-008).
 * Screen results and exports come from the same server-side query; exports are
 * genuine CSV / XLSX / PDF files; financial figures keep payments, refund
 * requests and completed refunds apart.
 */

// ---------------------------------------------------------------- file readers used by the tests
function unzip(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > 0, "zip end-of-central-directory record present");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, "central directory entry");
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    assert.equal(buf.readUInt32LE(local), 0x04034b50, "local header");
    const lnlen = buf.readUInt16LE(local + 26);
    const lelen = buf.readUInt16LE(local + 28);
    const raw = buf.subarray(local + 30 + lnlen + lelen, local + 30 + lnlen + lelen + csize);
    const data = method === 8 ? inflateRawSync(raw) : raw;
    assert.equal(data.length, usize, `${name} size`);
    assert.equal(crc32(data), crc, `${name} crc`);
    files.set(name, data);
    p += 46 + nlen + elen + clen;
  }
  return files;
}

function checkPdf(buf: Buffer): { pages: number; text: string } {
  const text = buf.toString("latin1");
  assert.ok(text.startsWith("%PDF-1.4"), "PDF header");
  assert.ok(text.trimEnd().endsWith("%%EOF"), "PDF trailer");
  const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)![1]);
  assert.equal(text.slice(startxref, startxref + 4), "xref", "startxref points at the xref table");
  const entries = [...text.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  entries.forEach((off, i) => assert.equal(text.slice(off, off + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`, `object ${i + 1} offset`));
  for (const m of text.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
    const start = m.index! + m[0].length;
    assert.equal(text.slice(start + Number(m[1]), start + Number(m[1]) + 10), "\nendstream", "stream length is exact");
  }
  return { pages: Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(text)![1]), text };
}

const cols: ReportColumn[] = [
  { key: "name", label: "Name", type: "text" },
  { key: "amount", label: "Amount (INR)", type: "money" },
  { key: "count", label: "Count", type: "int" },
  { key: "day", label: "Day", type: "date" },
  { key: "at", label: "At (IST)", type: "datetime" },
];

describe("report file writers", () => {
  const rows = [
    { name: 'Asha "A" Rao, Jr', amount: 1234.5, count: 3, day: "2026-04-05", at: "2026-04-30T18:29:00.000Z" },
    { name: "=HYPERLINK(\"x\")", amount: null, count: null, day: null, at: null },
  ];

  it("writes RFC 4180 CSV with BOM, IST times, fixed money format and neutralised formulas", () => {
    const csv = toCsv({ columns: cols, rows }).toString("utf8");
    assert.ok(csv.startsWith("\uFEFF"));
    const lines = csv.slice(1).split("\r\n");
    assert.equal(lines[0], "Name,Amount (INR),Count,Day,At (IST)");
    assert.equal(lines[1], '"Asha ""A"" Rao, Jr",1234.50,3,2026-04-05,2026-04-30 23:59');
    assert.equal(lines[2], `"'=HYPERLINK(""x"")",,,,`);
    assert.equal(toCsv({ columns: cols, rows: [] }).toString("utf8").slice(1), "Name,Amount (INR),Count,Day,At (IST)\r\n", "empty dataset: header only");
  });

  it("writes a genuine XLSX package with typed, formatted cells", () => {
    const buf = toXlsx({ title: "Payments", generatedAt: new Date("2026-05-01T00:00:00Z"), filters: ["Recorded date: 2026-04-01 to 2026-04-30 (IST)"], columns: cols, rows });
    assert.equal(buf.subarray(0, 2).toString("latin1"), "PK", "zip container, not CSV");
    const files = unzip(buf);
    for (const f of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml"]) assert.ok(files.has(f), f);
    const sheet = files.get("xl/worksheets/sheet1.xml")!.toString("utf8");
    assert.match(sheet, /<t>Amount \(INR\)<\/t>/);
    assert.match(sheet, /<c r="B6" s="4"><v>1234.5<\/v><\/c>/, "money is a number with the #,##0.00 style");
    assert.match(sheet, /<c r="C6" s="5"><v>3<\/v><\/c>/, "integer cell");
    // 2026-04-05 -> serial 46117; 2026-04-30 23:59 IST -> 46142.999...
    assert.match(sheet, /<c r="D6" s="2"><v>46117<\/v><\/c>/);
    assert.match(sheet, /<c r="E6" s="3"><v>46142\.99930555/);
    assert.match(sheet, /Asha &quot;A&quot; Rao, Jr/);
    assert.match(files.get("xl/styles.xml")!.toString(), /formatCode="yyyy-mm-dd hh:mm"/);
    assert.match(sheet, /<autoFilter ref="A5:E7"\/>/);
  });

  it("writes a genuine multi-page PDF with title, generation date, filters and a repeated header", () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ name: `Student ${i + 1}`, amount: i, count: i, day: "2026-04-05", at: "2026-04-05T05:00:00Z" }));
    const { pages, text } = checkPdf(toPdf({ title: "Student Register", generatedAt: new Date("2026-05-01T00:00:00Z"), filters: ["Status: approved"], columns: cols, rows: many }));
    assert.ok(pages >= 3, `long reports span pages (got ${pages})`);
    assert.match(text, /\(Student Register\) Tj/);
    assert.match(text, /\(Generated: 2026-05-01 05:30 IST\) Tj/);
    assert.match(text, /\(Status: approved\) Tj/);
    assert.equal(text.match(/\(Amount \\\(INR\\\)\) Tj/g)!.length, pages, "header row on every page");
    assert.match(text, /\(Student 120\) Tj/);
    assert.match(text, new RegExp(`\\(Page ${pages} of ${pages}\\) Tj`));
    const empty = checkPdf(toPdf({ title: "Empty", generatedAt: new Date(), filters: [], columns: cols, rows: [] }));
    assert.equal(empty.pages, 1);
    assert.match(empty.text, /No records match the selected filters/);
  });
});

describe("reports API (HTTP)", () => {
  let harness: TestHarness;
  let server: TestServer;
  const tokens: Record<string, string> = {};
  const auth = (role: string) => ({ headers: { Authorization: `Bearer ${tokens[role]}` } });
  const json = async (res: Response) => (await res.json()) as Record<string, any>;

  const paymentRow = (i: number, at: string, status: string, amount = 1000) => ({
    at,
    status,
    search: `student ${i} ref-${i}`,
    data: { source: "gateway", reference: `ref-${i}`, studentName: `Student ${i}`, enrollmentNumber: `ENR-${i}`, courseName: "Full Stack", method: "upi", status, amount, recordedAt: at },
  });

  beforeEach(async () => {
    harness = createTestHarness();
    let seq = 60;
    for (const role of ["admin", "super_admin", "teacher", "student"] as const) {
      seq++;
      const user = await harness.users.create({ name: `${role} User`, email: `${role}-${seq}@rep.test`, mobile: `98711100${seq}`, role, status: "active" });
      const session = await harness.sessions.create({ userId: user.id, refreshTokenHash: Buffer.alloc(64, 3).toString("hex"), ipAddress: "127.0.0.1", expiresAt: new Date(Date.now() + 3600000).toISOString() });
      tokens[role] = issueAccessToken({ userId: user.id, role, sessionId: session.sessionId }).token;
    }
    const authenticate = createAuthenticate({ studentAccess: null, sessions: () => harness.sessions });
    server = await startServer(createApp({ container: harness.container, authenticate }));
  });

  afterEach(async () => {
    await server.close();
  });

  it("lists only the reports a role may use", async () => {
    const admin = (await json(await server.get("/api/v1/admin/reports/catalog", auth("admin"))))["data"].map((r: any) => r.code);
    const sup = (await json(await server.get("/api/v1/admin/reports/catalog", auth("super_admin"))))["data"].map((r: any) => r.code);
    assert.deepEqual(admin, ["students", "enrollments", "payments", "attendance", "attendance-summary", "assessments", "placements"]);
    assert.deepEqual(sup, ["students", "enrollments", "payments", "refunds", "attendance", "attendance-summary", "assessments", "placements", "expenses", "financial-summary"]);
  });

  it("refuses teachers, students and anonymous callers", async () => {
    for (const role of ["teacher", "student"]) {
      assert.equal((await server.get("/api/v1/admin/reports/payments", auth(role))).status, 403, role);
      assert.equal((await server.get("/api/v1/admin/reports/payments/export?format=csv", auth(role))).status, 403, role);
      assert.equal((await server.get("/api/v1/admin/reports/analytics", auth(role))).status, 403, role);
    }
    assert.equal((await server.get("/api/v1/admin/reports/payments")).status, 401);
  });

  it("keeps refunds, expenses and the financial summary Super Admin only, including exports", async () => {
    for (const path of ["refunds", "expenses", "refunds/export?format=csv", "financial-summary/export?format=pdf", "refunds/statuses"]) {
      assert.equal((await server.get(`/api/v1/admin/reports/${path}`, auth("admin"))).status, 403, path);
    }
    assert.equal((await server.get("/api/v1/admin/reports/financial-summary", auth("admin"))).status, 403);
    assert.equal(harness.reports.exports.length, 0, "nothing exported or audited");
    assert.equal((await server.get("/api/v1/admin/reports/refunds", auth("super_admin"))).status, 200);
  });

  it("paginates on the server with an exact total, newest first", async () => {
    harness.reports.rows.payments = Array.from({ length: 53 }, (_, i) => paymentRow(i + 1, new Date(Date.UTC(2026, 3, 1, 6, i)).toISOString(), "successful"));
    const p1 = (await json(await server.get("/api/v1/admin/reports/payments?pageSize=25", auth("admin"))))["data"];
    const p3 = (await json(await server.get("/api/v1/admin/reports/payments?pageSize=25&page=3", auth("admin"))))["data"];
    assert.equal(p1.total, 53);
    assert.equal(p1.totalPages, 3);
    assert.equal(p1.rows.length, 25);
    assert.equal(p1.rows[0].reference, "ref-53");
    assert.equal(p3.rows.length, 3);
    assert.equal(p3.rows[2].reference, "ref-1");
  });

  it("applies IST date boundaries inclusively, plus status and search filters", async () => {
    harness.reports.rows.payments = [
      paymentRow(1, "2026-03-31T18:29:59.000Z", "successful"), // 31 Mar 23:59:59 IST: outside
      paymentRow(2, "2026-03-31T18:30:00.000Z", "successful"), // 1 Apr 00:00 IST: inside
      paymentRow(3, "2026-04-30T18:29:59.000Z", "failed"), // 30 Apr 23:59:59 IST: inside
      paymentRow(4, "2026-04-30T18:30:00.000Z", "successful"), // 1 May 00:00 IST: outside
    ];
    const q = "from=2026-04-01&to=2026-04-30";
    const all = (await json(await server.get(`/api/v1/admin/reports/payments?${q}`, auth("admin"))))["data"];
    assert.deepEqual(all.rows.map((r: any) => r.reference), ["ref-3", "ref-2"]);
    const ok = (await json(await server.get(`/api/v1/admin/reports/payments?${q}&status=SUCCESSFUL`, auth("admin"))))["data"];
    assert.deepEqual(ok.rows.map((r: any) => r.reference), ["ref-2"]);
    const searched = (await json(await server.get(`/api/v1/admin/reports/payments?search=ref-3`, auth("admin"))))["data"];
    assert.equal(searched.total, 1);
    assert.deepEqual((await json(await server.get("/api/v1/admin/reports/payments/statuses", auth("admin"))))["data"], ["failed", "successful"]);
  });

  it("rejects invalid filters", async () => {
    for (const q of ["from=2026-13-01", "from=2026-02-30", "from=2026-05-01&to=2026-04-01", "pageSize=101", "page=0", "status=bad;drop", "search="]) {
      assert.equal((await server.get(`/api/v1/admin/reports/payments?${q}`, auth("admin"))).status, 422, q);
    }
    assert.equal((await server.get("/api/v1/admin/reports/salaries", auth("admin"))).status, 422, "unknown report");
    assert.equal((await server.get("/api/v1/admin/reports/payments/export?format=docx", auth("admin"))).status, 422);
    assert.equal((await server.get("/api/v1/admin/reports/payments/export", auth("admin"))).status, 422, "format is required");
  });

  it("exports exactly the rows the screen shows for the same filters, in every format, and audits each export", async () => {
    harness.reports.rows.payments = [
      paymentRow(1, "2026-04-02T05:00:00.000Z", "successful", 1500),
      paymentRow(2, "2026-04-03T05:00:00.000Z", "failed", 900),
      paymentRow(3, "2026-04-04T05:00:00.000Z", "successful", 2500),
    ];
    const q = "from=2026-04-01&to=2026-04-30&status=successful";
    const screen = (await json(await server.get(`/api/v1/admin/reports/payments?${q}`, auth("admin"))))["data"];

    const csvRes = await server.get(`/api/v1/admin/reports/payments/export?format=csv&${q}`, auth("admin"));
    assert.equal(csvRes.status, 200);
    assert.match(csvRes.headers.get("content-type")!, /text\/csv/);
    assert.match(csvRes.headers.get("content-disposition")!, /attachment; filename="payments-\d{4}-\d{2}-\d{2}\.csv"/);
    const csvLines = (await csvRes.text()).replace(/^\uFEFF/, "").trim().split("\r\n");
    assert.equal(csvLines.length - 1, screen.total);
    assert.deepEqual(csvLines.slice(1).map((l) => l.split(",")[1]), screen.rows.map((r: any) => r.reference));

    const xRes = await server.get(`/api/v1/admin/reports/payments/export?format=xlsx&${q}`, auth("admin"));
    assert.equal(xRes.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const sheet = unzip(Buffer.from(await xRes.arrayBuffer())).get("xl/worksheets/sheet1.xml")!.toString();
    assert.match(sheet, /Status: successful/);
    assert.match(sheet, /<v>2500<\/v>/);
    assert.doesNotMatch(sheet, /<v>900<\/v>/, "filtered-out rows are not exported");

    const pRes = await server.get(`/api/v1/admin/reports/payments/export?format=pdf&${q}`, auth("admin"));
    assert.equal(pRes.headers.get("content-type"), "application/pdf");
    const pdf = checkPdf(Buffer.from(await pRes.arrayBuffer()));
    assert.match(pdf.text, /\(Payments\) Tj/);
    assert.match(pdf.text, /\(ref-3\) Tj/);
    assert.doesNotMatch(pdf.text, /\(ref-2\) Tj/);

    assert.deepEqual(harness.reports.exports.map((e) => [e.reportCode, e.format, e.rowCount, e.filter.status]), [
      ["payments", "csv", 2, "successful"],
      ["payments", "xlsx", 2, "successful"],
      ["payments", "pdf", 2, "successful"],
    ]);
  });

  it("exports only the selected fields of a custom report, in report order, and refuses unknown fields", async () => {
    harness.reports.rows.payments = [paymentRow(1, "2026-04-02T05:00:00.000Z", "successful", 1500)];
    const res = await server.get("/api/v1/admin/reports/payments/export?format=csv&columns=amount,reference", auth("admin"));
    assert.equal(res.status, 200);
    const lines = (await res.text()).replace(/^﻿/, "").trim().split("\r\n");
    assert.deepEqual(lines, ["Reference,Amount (INR)", "ref-1,1500.00"]);
    assert.deepEqual(harness.reports.exports[0]!.columns, ["reference", "amount"]);
    assert.equal((await server.get("/api/v1/admin/reports/payments/export?format=csv&columns=amount,salary", auth("admin"))).status, 422);
    assert.equal((await server.get("/api/v1/admin/reports/payments/export?format=csv&columns=amount;drop", auth("admin"))).status, 422);
  });

  it("exports an empty result as a valid file with headers only", async () => {
    const res = await server.get("/api/v1/admin/reports/students/export?format=csv", auth("admin"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-report-row-count"), "0");
    assert.equal((await res.text()).replace(/^\uFEFF/, "").trim().split("\r\n").length, 1);
  });

  it("returns no file when the export audit cannot be written", async () => {
    harness.reports.rows.students = [{ at: "2026-04-02T05:00:00Z", status: "approved", search: "x", data: { name: "X" } }];
    harness.reports.failExportAudit = true;
    const res = await server.get("/api/v1/admin/reports/students/export?format=csv", auth("admin"));
    assert.equal(res.status, 500);
    assert.doesNotMatch(res.headers.get("content-type") ?? "", /text\/csv/);
  });

  it("refuses an export above the row limit instead of truncating it", async () => {
    const row = { at: "2026-04-02T05:00:00Z", status: "present", search: "", data: {} };
    harness.reports.rows.attendance = Array.from({ length: MAX_EXPORT_ROWS + 1 }, () => row);
    const res = await server.get("/api/v1/admin/reports/attendance/export?format=csv", auth("admin"));
    assert.equal(res.status, 422);
    assert.match((await json(res))["message"], /limit is 50000/);
    assert.equal(harness.reports.exports.length, 0);
    const page = (await json(await server.get("/api/v1/admin/reports/attendance?pageSize=100", auth("admin"))))["data"];
    assert.equal(page.total, MAX_EXPORT_ROWS + 1, "screens still page through large datasets");
    assert.equal(page.rows.length, 100);
  });

  it("reports revenue, refunds, discounts, scholarships and expenses separately (REP-008)", async () => {
    harness.reports.ledger.transactions = [
      { status: "successful", amount: 10000, at: "2026-04-05T05:00:00Z" },
      { status: "pending", amount: 5000, at: "2026-04-06T05:00:00Z" },
      { status: "failed", amount: 7000, at: "2026-04-07T05:00:00Z" },
      { status: "successful", amount: 99999, at: "2026-03-31T18:29:00Z" }, // previous day in IST
    ];
    harness.reports.ledger.manual = [
      { status: "verified", amount: 3000, at: "2026-04-08T05:00:00Z" },
      { status: "pending", amount: 2000, at: "2026-04-09T05:00:00Z" },
    ];
    harness.reports.ledger.refunds = [
      { status: "PENDING", amount: 1000, requestedAt: "2026-04-10T05:00:00Z" },
      { status: "COMPLETED", amount: 4000, requestedAt: "2026-03-20T05:00:00Z", approvedAt: "2026-04-02T05:00:00Z", completedAt: "2026-04-04T05:00:00Z" },
    ];
    harness.reports.ledger.awards = [{ status: "approved", amount: 5000, at: "2026-04-03T05:00:00Z" }];
    harness.reports.ledger.expenses = [
      { category: "Rent", currency: "INR", amount: 20000, date: "2026-04-30", approved: true },
      { category: "Rent", currency: "INR", amount: 1, date: "2026-05-01", approved: true },
    ];
    const res = await json(await server.get("/api/v1/admin/reports/financial-summary?from=2026-04-01&to=2026-04-30", auth("super_admin")));
    const s = res["data"].summary;
    assert.deepEqual(s.revenue.gatewaySuccessful, { count: 1, amount: 10000 });
    assert.deepEqual(s.revenue.manualVerified, { count: 1, amount: 3000 });
    assert.equal(s.revenue.totalCollected, 13000, "pending and failed payments are not revenue; refunds are not netted");
    assert.deepEqual(s.revenue.gatewayNotCounted.map((l: any) => l.status).sort(), ["failed", "pending"]);
    assert.deepEqual(s.refunds.requested, { count: 1, amount: 1000 }, "a request is not a refund");
    assert.deepEqual(s.refunds.pending, { count: 1, amount: 1000 });
    assert.deepEqual(s.refunds.completed, { count: 1, amount: 4000 }, "completion counts by completion date");
    assert.deepEqual(s.scholarships.awards, [{ status: "approved", count: 1, amount: 5000 }]);
    assert.deepEqual(s.expenses.byCurrency, [{ currency: "INR", count: 1, amount: 20000 }], "expense date is inclusive and calendar-based");
    const rows = res["data"].rows;
    assert.ok(rows.some((r: any) => r.metric === "Total collected" && r.amount === 13000));
    assert.ok(rows.some((r: any) => /not assumed to have reduced fees/.test(r.basis)));

    const x = await server.get("/api/v1/admin/reports/financial-summary/export?format=xlsx&from=2026-04-01&to=2026-04-30", auth("super_admin"));
    assert.equal(x.status, 200);
    assert.match(unzip(Buffer.from(await x.arrayBuffer())).get("xl/worksheets/sheet1.xml")!.toString(), /Total collected/);
  });

  it("builds monthly dashboard series from real records with consistent revenue rules (REP-001)", async () => {
    harness.reports.ledger.transactions = [
      { status: "successful", amount: 1000, at: "2026-04-30T18:29:00Z" }, // April in IST
      { status: "successful", amount: 2000, at: "2026-04-30T18:31:00Z" }, // May in IST
      { status: "failed", amount: 500, at: "2026-05-02T05:00:00Z" },
    ];
    harness.reports.ledger.registrations = ["2026-04-10T05:00:00Z", "2026-05-10T05:00:00Z", "2026-05-11T05:00:00Z"];
    harness.reports.ledger.attendance = [
      { batchCode: "FS-01", batchName: "Full Stack 1", status: "PRESENT", at: "2026-04-10T05:00:00Z" },
      { batchCode: "FS-01", batchName: "Full Stack 1", status: "ABSENT", at: "2026-04-11T05:00:00Z" },
    ];
    const a = (await json(await server.get("/api/v1/admin/reports/analytics?from=2026-04-01&to=2026-06-30", auth("admin"))))["data"];
    assert.deepEqual(a.months.map((m: any) => [m.month, m.revenueCollected, m.registrations]), [
      ["2026-04", 1000, 1],
      ["2026-05", 2000, 2],
      ["2026-06", 0, 0],
    ]);
    assert.deepEqual(a.attendanceByBatch, [{ batchCode: "FS-01", batchName: "Full Stack 1", byStatus: { present: 1, absent: 1 }, marked: 2 }]);
    assert.equal((await server.get("/api/v1/admin/reports/analytics?from=2024-01-01&to=2026-06-30", auth("admin"))).status, 422, "at most 24 months");
    const def = (await json(await server.get("/api/v1/admin/reports/analytics", auth("super_admin"))))["data"];
    assert.match(def.from, /^\d{4}-04-01$/, "defaults to the current financial year");
  });
});

// ---------------------------------------------------------------- SQL adapter (mock pool)
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
    const r = (res ?? {}) as { recordset?: T[] };
    return { recordset: r.recordset ?? [], rowsAffected: [1] };
  }
}
const tracked = (handler: Handler) => {
  const seen: Array<{ q: string; inputs: Record<string, unknown> }> = [];
  const pool = {
    request: () =>
      new MockSqlRequest((q, inputs) => {
        seen.push({ q, inputs });
        return handler(q, inputs);
      }),
  } as unknown as sql.ConnectionPool;
  return { seen, repo: new SqlServerReportsRepository(async () => pool) };
};

describe("SqlServerReportsRepository (mock pool)", () => {
  it("counts first, then pages with IST boundaries, a parameterised status and an escaped search", async () => {
    const t = tracked((q) => (q.startsWith("SELECT COUNT(1)") ? { recordset: [{ total: 60 }] } : { recordset: [{ reference: "r", recordedAt: new Date("2026-04-02T00:00:00Z") }] }));
    const res = await t.repo.runReport("payments", { from: "2026-04-01", to: "2026-04-30", status: "successful", search: "50%_off" }, { page: 2, pageSize: 25 });
    assert.equal(res.total, 60);
    assert.equal(res.rows[0]!.recordedAt, "2026-04-02T00:00:00.000Z");
    const [count, data] = t.seen;
    assert.match(count!.q, /^SELECT COUNT\(1\) AS total FROM \(/);
    assert.deepEqual(data!.inputs["fromUtc"], new Date("2026-03-31T18:30:00.000Z"));
    assert.deepEqual(data!.inputs["toUtc"], new Date("2026-04-30T18:30:00.000Z"));
    assert.match(data!.q, /p\.recordedAt < @toUtc/);
    assert.match(data!.q, /LOWER\(p\.status\) = @status/);
    assert.equal(data!.inputs["search"], "%50\\%\\_off%");
    assert.match(data!.q, /LIKE @search ESCAPE '\\'/);
    assert.equal(data!.inputs["offset"], 25);
    assert.match(data!.q, /OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY/);
    assert.match(data!.q, /OUTER APPLY \(SELECT TOP 1 r\.ReceiptNumber/, "a second receipt cannot duplicate a payment row");
    assert.match(data!.q, /UNION ALL/);
  });

  it("compares calendar dates for expenses and skips the data query when nothing matches", async () => {
    const t = tracked(() => ({ recordset: [{ total: 0 }] }));
    const res = await t.repo.runReport("expenses", { from: "2026-04-01", to: "2026-04-30" }, { page: 1, pageSize: 25 });
    assert.deepEqual(res, { rows: [], total: 0 });
    assert.equal(t.seen.length, 1);
    assert.match(t.seen[0]!.q, /x\.ExpenseDate >= @fromDate AND x\.ExpenseDate <= @toDate/);
  });

  it("refuses an oversized export before reading the rows", async () => {
    const t = tracked(() => ({ recordset: [{ total: MAX_EXPORT_ROWS + 1 }] }));
    await assert.rejects(t.repo.runReport("students", {}, null), (e: Error) => e.name === "ReportTooLargeError");
    assert.equal(t.seen.length, 1);
  });

  it("counts only successful and verified payments as revenue and keeps refund stages apart", async () => {
    const t = tracked((q) => {
      if (q.includes("FROM dbo.NXA_Transactions")) return { recordset: [{ status: "successful", cnt: 2, amt: 2000 }, { status: "pending", cnt: 1, amt: 500 }] };
      if (q.includes("FROM dbo.NXA_ManualPaymentRecords")) return { recordset: [{ status: "verified", cnt: 1, amt: 300.5 }, { status: "rejected", cnt: 1, amt: 100 }] };
      if (q.includes("FROM dbo.NXA_Refunds")) return { recordset: [{ reqCnt: 3, reqAmt: 900, penCnt: 1, penAmt: 300, apCnt: 1, apAmt: 300, coCnt: 1, coAmt: 300 }] };
      if (q.includes("FROM dbo.NXA_Enrollments")) return { recordset: [{ cnt: 2, amt: 1000 }] };
      if (q.includes("FROM dbo.NXA_ScholarshipAwards")) return { recordset: [{ status: "approved", cnt: 1, amt: 5000 }] };
      return { recordset: [] };
    });
    const s = await t.repo.financialSummary({ from: "2026-04-01", to: "2026-04-30" });
    assert.equal(s.revenue.totalCollected, 2300.5);
    assert.deepEqual(s.revenue.gatewayNotCounted, [{ status: "pending", count: 1, amount: 500 }]);
    assert.deepEqual(s.revenue.manualNotCounted, [{ status: "rejected", count: 1, amount: 100 }]);
    assert.deepEqual(s.refunds, { requested: { count: 3, amount: 900 }, pending: { count: 1, amount: 300 }, approved: { count: 1, amount: 300 }, completed: { count: 1, amount: 300 } });
    const refundsQ = t.seen.find((x) => x.q.includes("FROM dbo.NXA_Refunds"))!.q;
    assert.match(refundsQ, /CompletedAt >= @fromUtc AND CompletedAt < @toUtc/, "completed refunds use the completion date");
    assert.match(t.seen.find((x) => x.q.includes("FROM dbo.NXA_Enrollments"))!.q, /UPPER\(EnrollmentStatus\) <> 'CANCELLED'/);
  });

  it("audits an export with filters and row count but no report data", async () => {
    const t = tracked(() => ({ recordset: [{ AuditLogId: 1 }] }));
    await t.repo.recordExport({ actorUserId: "7", reportCode: "payments", format: "xlsx", filter: { status: "successful" }, rowCount: 12 });
    const a = t.seen[0]!;
    assert.match(a.q, /INSERT INTO dbo\.NXA_AuditLogs/);
    assert.equal(a.inputs["action"], "REPORT_EXPORT");
    assert.equal(a.inputs["module"], "REPORTS");
    assert.equal(a.inputs["eid"], "payments");
    assert.deepEqual(JSON.parse(String(a.inputs["newVal"])), { format: "xlsx", filter: { status: "successful" }, rowCount: 12 });
  });

  it("derives month buckets in IST", () => {
    assert.deepEqual(monthsBetween("2025-11-15", "2026-02-01"), ["2025-11", "2025-12", "2026-01", "2026-02"]);
    assert.deepEqual(istDayStartUtc("2026-04-01"), new Date("2026-03-31T18:30:00.000Z"));
  });
});
