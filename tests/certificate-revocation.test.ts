import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type sql from "mssql";

import { createApp } from "../src/app";
import { createAuthenticate } from "../src/middleware/authenticate.middleware";
import { issueAccessToken } from "../src/modules/auth/token.service";
import { SqlServerCertificateRepository } from "../src/modules/certificates/sqlserver-certificate.repository";
import type { CertificateRecord } from "../src/modules/certificates/certificate.types";
import { createTestHarness, type TestHarness } from "./fakes";
import { startServer, type TestServer } from "./helpers/server";

/**
 * Batch 2 item 3: the live revocation history table is
 * NXA_CertificateRevocationHistory with `Reason nvarchar(500) NOT NULL`
 * (not `RevocationReason`). Issuance stays blocked (eligibility, template).
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

const trackedPool = (handler: Handler) => {
  const state = { committed: false, rolledBack: false, began: 0 };
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
  return { pool, state, seen, writes };
};

const certRow = (over: Record<string, unknown> = {}) => ({
  CertificateId: 501,
  StudentUserId: 301,
  CourseId: 5,
  EnrollmentId: 901,
  CertificateNumber: "NXA-2026-0001",
  VerificationToken: "2f1c7a52-6a7b-4f0e-9c1e-2b9f3c0d4e5f",
  CourseNameAtIssue: "Full Stack Java",
  StudentNameAtIssue: "Asha Rao",
  AttendancePercentage: 88.5,
  PassingMarksVerified: true,
  CourseCompletionVerified: true,
  CertificateStatus: "ISSUED",
  IssuedAt: new Date("2026-10-01T10:00:00Z"),
  IssuedByUserId: 7,
  CertificateObjectKey: null,
  RevocationReason: null,
  RevokedAt: null,
  ...over,
});

const repo = (pool: sql.ConnectionPool) => new SqlServerCertificateRepository(async () => pool);

describe("SqlServerCertificateRepository against the live schema", () => {
  it("reads the revocation reason from NXA_CertificateRevocationHistory.Reason (latest row only)", async () => {
    const { pool, seen } = trackedPool(() => ({
      recordset: [
        certRow({ CertificateStatus: "REVOKED", RevocationReason: "Fraudulent attendance", RevokedAt: new Date("2026-11-01") }),
        certRow({ CertificateId: 502, CertificateNumber: "NXA-2026-0002", IssuedByUserId: null }),
      ],
    }));
    const list = await repo(pool).getAllCertificates();
    const q = seen[0]!.q;
    assert.match(q, /r\.Reason AS RevocationReason/);
    assert.doesNotMatch(q, /\b(h|r)\.RevocationReason\b/, "no RevocationReason column exists in the live table");
    assert.match(q, /OUTER APPLY \(\s*SELECT TOP 1 h\.Reason, h\.RevokedAt\s+FROM dbo\.NXA_CertificateRevocationHistory h/);
    assert.match(q, /ORDER BY h\.RevokedAt DESC/);
    assert.equal(list.length, 2, "one row per certificate");
    assert.equal(list[0]!.certificateStatus, "revoked", "status compared case-insensitively");
    assert.equal(list[0]!.revocationReason, "Fraudulent attendance");
    assert.equal(list[0]!.revokedAt, new Date("2026-11-01").toISOString());
    assert.equal(list[1]!.certificateStatus, "valid");
    assert.equal(list[1]!.issuedByUserId, "", "nullable IssuedByUserId is not rendered as 'null'");
  });

  it("uses the same corrected query for details, number and token lookups", async () => {
    const { pool, seen } = trackedPool(() => ({ recordset: [certRow()] }));
    const r = repo(pool);
    assert.equal((await r.getCertificateById("501"))!.id, "501");
    assert.equal((await r.getCertificateByNumber(" nxa-2026-0001 "))!.certificateNumber, "NXA-2026-0001");
    assert.ok(await r.getCertificateByToken("2F1C7A52-6A7B-4F0E-9C1E-2B9F3C0D4E5F"));
    assert.equal(seen[1]!.inputs["certNum"], "NXA-2026-0001");
    assert.equal(seen[2]!.inputs["token"], "2f1c7a52-6a7b-4f0e-9c1e-2b9f3c0d4e5f");
    for (const s of seen) assert.match(s.q, /r\.Reason AS RevocationReason/);
  });

  it("treats a non-numeric id as not found without querying", async () => {
    const { pool, seen } = trackedPool(() => ({ recordset: [certRow()] }));
    assert.equal(await repo(pool).getCertificateById("abc"), null);
    assert.deepEqual(await repo(pool).getCertificatesByStudentId("x-1"), []);
    assert.equal(seen.length, 0);
  });

  describe("revocation", () => {
    interface Scenario {
      current?: Record<string, unknown> | null;
      updateRows?: number;
      historyError?: Error;
      auditError?: Error;
    }
    const run = (sc: Scenario) => {
      let revoked = false;
      const t = trackedPool((q) => {
        if (q.includes("WITH (UPDLOCK, HOLDLOCK)")) {
          return { recordset: sc.current === null ? [] : [{ CertificateStatus: "ISSUED", CertificateNumber: "NXA-2026-0001", ...sc.current }] };
        }
        if (q.includes("UPDATE dbo.NXA_Certificates")) return { recordset: [], rowsAffected: [sc.updateRows ?? 1] };
        if (q.includes("INSERT INTO dbo.NXA_CertificateRevocationHistory")) {
          if (sc.historyError) return sc.historyError;
          revoked = true;
          return { recordset: [] };
        }
        if (q.includes("INSERT INTO dbo.NXA_AuditLogs")) return sc.auditError ?? { recordset: [{ AuditLogId: 1 }] };
        return {
          recordset: [
            certRow(revoked ? { CertificateStatus: "revoked", RevocationReason: "Fraudulent attendance", RevokedAt: new Date() } : {}),
          ],
        };
      });
      return { ...t, attempt: repo(t.pool).revokeCertificate("501", "Fraudulent attendance", "7") };
    };

    it("locks the row, updates status, writes history with Reason and audits, in one transaction", async () => {
      const r = run({});
      const cert = await r.attempt;
      assert.ok(r.state.committed && !r.state.rolledBack);
      assert.equal(r.state.began, 1);
      assert.equal(cert.certificateStatus, "revoked");
      assert.equal(cert.revocationReason, "Fraudulent attendance");

      const writes = r.writes();
      assert.match(writes[0]!.q, /UPDATE dbo\.NXA_Certificates\s+SET CertificateStatus = 'revoked'/);
      assert.match(writes[0]!.q, /LOWER\(CertificateStatus\) <> 'revoked'/, "the update itself is guarded");

      const hist = writes[1]!;
      const cols = /NXA_CertificateRevocationHistory\s*\(([^)]*)\)/.exec(hist.q)?.[1]?.split(",").map((c) => c.trim());
      assert.deepEqual(cols, ["CertificateId", "Reason", "RevokedByUserId", "RevokedAt"]);
      assert.equal(hist.inputs["reason"], "Fraudulent attendance");
      assert.equal(hist.inputs["revokedByUserId"], "7");

      const audit = writes[2]!;
      assert.match(audit.q, /INSERT INTO dbo\.NXA_AuditLogs/);
      assert.equal(audit.inputs["action"], "REVOKE_CERTIFICATE");
      assert.equal(audit.inputs["actorId"], "7");
      assert.match(String(audit.inputs["newVal"]), /Fraudulent attendance/);
      assert.match(String(audit.inputs["oldVal"]), /ISSUED/);

      assert.match(r.seen[0]!.q, /FROM dbo\.NXA_Certificates WITH \(UPDLOCK, HOLDLOCK\)/, "state is read under a lock");
    });

    it("reports an unknown certificate as not found and writes nothing", async () => {
      const r = run({ current: null });
      await assert.rejects(r.attempt, (err: Error) => err.name === "RecordNotFoundError");
      assert.ok(r.state.rolledBack && !r.state.committed);
      assert.equal(r.writes().length, 0);
    });

    it("rejects a non-numeric id without opening a transaction", async () => {
      const t = trackedPool(() => ({ recordset: [] }));
      await assert.rejects(repo(t.pool).revokeCertificate("NXA-1", "Fraudulent attendance", "7"), (err: Error) => err.name === "RecordNotFoundError");
      assert.equal(t.state.began, 0);
      assert.equal(t.seen.length, 0);
    });

    it("refuses to revoke an already revoked certificate (any letter case)", async () => {
      const r = run({ current: { CertificateStatus: "REVOKED" } });
      await assert.rejects(r.attempt, (err: Error & { code?: string; status?: number }) => err.code === "CERTIFICATE_ALREADY_REVOKED" && err.status === 409);
      assert.ok(r.state.rolledBack && !r.state.committed);
      assert.equal(r.writes().length, 0);
    });

    it("rolls back when a concurrent revocation won the race (guarded update affects no row)", async () => {
      const r = run({ updateRows: 0 });
      await assert.rejects(r.attempt, (err: Error & { code?: string }) => err.code === "CERTIFICATE_ALREADY_REVOKED");
      assert.ok(r.state.rolledBack && !r.state.committed);
      assert.equal(r.writes().filter((w) => w.q.includes("INSERT")).length, 0);
    });

    it("rolls back the status change when the history insert fails", async () => {
      const r = run({ historyError: new Error("Invalid column name") });
      await assert.rejects(r.attempt, /Invalid column name/);
      assert.ok(r.state.rolledBack && !r.state.committed);
      assert.equal(r.writes().filter((w) => w.q.includes("NXA_AuditLogs")).length, 0);
    });

    it("rolls back everything when the audit write fails", async () => {
      const r = run({ auditError: new Error("audit unavailable") });
      await assert.rejects(r.attempt, /audit unavailable/);
      assert.ok(r.state.rolledBack && !r.state.committed);
    });
  });
});

describe("certificate endpoints: listing, verification, revocation and authorization", () => {
  let harness: TestHarness;
  let server: TestServer;
  const tokens: Record<string, string> = {};
  let cert: CertificateRecord;

  const auth = (role: string) => ({ headers: { Authorization: `Bearer ${tokens[role]}`, "Content-Type": "application/json" } });
  const json = async (res: Response) => (await res.json()) as Record<string, any>;

  beforeEach(async () => {
    harness = createTestHarness();
    let seq = 40;
    for (const role of ["admin", "super_admin", "teacher", "student"] as const) {
      seq++;
      const user = await harness.users.create({
        name: `${role} User`,
        email: `${role}-${seq}@test.local`,
        mobile: `98765432${seq}`,
        role,
        status: "active",
      });
      const session = await harness.sessions.create({
        userId: user.id,
        refreshTokenHash: Buffer.alloc(64, 1).toString("hex"),
        ipAddress: "127.0.0.1",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
      tokens[role] = issueAccessToken({ userId: user.id, role, sessionId: session.sessionId }).token;
    }
    cert = await harness.certificates.issueCertificate({
      studentUserId: "student-x",
      studentNameAtIssue: "Asha Rao",
      courseId: "course-1",
      courseNameAtIssue: "Full Stack Java",
      enrollmentId: "enr-1",
      certificateNumber: "NXA-2026-0001",
      verificationToken: "token-0001",
      attendancePercentage: 88,
      passingMarksVerified: true,
      courseCompletionVerified: true,
      certificateStatus: "valid",
      issuedByUserId: "admin-1",
    });
    const authenticate = createAuthenticate({ studentAccess: null, sessions: () => harness.sessions });
    server = await startServer(createApp({ container: harness.container, authenticate }));
  });

  afterEach(async () => {
    await server.close();
  });

  it("lists certificates for Admin and Super Admin only", async () => {
    for (const role of ["admin", "super_admin"]) {
      const res = await server.get("/api/v1/certificates/admin/all", auth(role));
      assert.equal(res.status, 200, role);
      assert.equal(((await json(res))["data"] as unknown[]).length, 1);
    }
    for (const role of ["teacher", "student"]) {
      assert.equal((await server.get("/api/v1/certificates/admin/all", auth(role))).status, 403, role);
    }
    assert.equal((await server.get("/api/v1/certificates/admin/all")).status, 401);
  });

  it("verifies a certificate publicly by number and by token, and logs each check", async () => {
    const byNumber = await json(await server.get("/api/v1/certificates/public/verify/nxa-2026-0001"));
    assert.equal(byNumber["data"].isValid, true);
    const byToken = await json(await server.get("/api/v1/certificates/public/verify/token-0001"));
    assert.equal(byToken["data"].isValid, true);
    const unknown = await json(await server.get("/api/v1/certificates/public/verify/NXA-NOPE"));
    assert.equal(unknown["data"].isValid, false);
    assert.equal(harness.certificates.verificationLogs.length, 2, "only found certificates are logged");
  });

  it("revokes for Admin, then reports it as revoked publicly and refuses a second revocation", async () => {
    const res = await server.post(`/api/v1/certificates/${cert.id}/revoke`, { reason: "  Fraudulent attendance  " }, auth("admin"));
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body["data"].certificateStatus, "revoked");
    assert.equal(body["data"].revocationReason, "Fraudulent attendance", "reason is trimmed");

    const pub = await json(await server.get("/api/v1/certificates/public/verify/NXA-2026-0001"));
    assert.equal(pub["data"].isValid, false);
    assert.match(pub["data"].message, /Fraudulent attendance/);

    const again = await server.post(`/api/v1/certificates/${cert.id}/revoke`, { reason: "Second attempt" }, auth("super_admin"));
    assert.equal(again.status, 409);
    assert.equal((await json(again))["error"], "CERTIFICATE_ALREADY_REVOKED");
  });

  it("lets a Super Admin revoke", async () => {
    const res = await server.post(`/api/v1/certificates/${cert.id}/revoke`, { reason: "Issued in error" }, auth("super_admin"));
    assert.equal(res.status, 200);
  });

  it("returns 404 for an unknown certificate id", async () => {
    const res = await server.post("/api/v1/certificates/does-not-exist/revoke", { reason: "Issued in error" }, auth("admin"));
    assert.equal(res.status, 404);
  });

  it("validates the revocation reason (5-500 characters after trimming)", async () => {
    for (const reason of [undefined, "  abc  ", "x".repeat(501)]) {
      const res = await server.post(`/api/v1/certificates/${cert.id}/revoke`, reason === undefined ? {} : { reason }, auth("admin"));
      assert.equal(res.status, 422, String(reason).slice(0, 20));
    }
    assert.equal((await harness.certificates.getCertificateById(cert.id))!.certificateStatus, "valid", "nothing changed");
  });

  it("does not let a teacher, student or anonymous caller revoke", async () => {
    for (const role of ["teacher", "student"]) {
      const res = await server.post(`/api/v1/certificates/${cert.id}/revoke`, { reason: "Issued in error" }, auth(role));
      assert.equal(res.status, 403, role);
    }
    const anon = await server.post(`/api/v1/certificates/${cert.id}/revoke`, { reason: "Issued in error" }, {
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(anon.status, 401);
    assert.equal((await harness.certificates.getCertificateById(cert.id))!.certificateStatus, "valid");
  });

  it("keeps issuance blocked (no eligibility rules or template are invented)", async () => {
    const res = await server.post(
      "/api/v1/certificates/issue",
      {
        studentUserId: "student-x", courseId: "course-1", enrollmentId: "enr-2",
        studentNameAtIssue: "Asha Rao", courseNameAtIssue: "Full Stack Java",
      },
      auth("admin"),
    );
    assert.equal(res.status, 503);
    assert.equal((await json(res))["error"], "CERTIFICATE_ELIGIBILITY_UNAVAILABLE");
  });
});
