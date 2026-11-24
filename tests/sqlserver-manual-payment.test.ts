import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type sql from "mssql";

import { SqlServerPaymentRepository } from "../src/modules/payments/sqlserver-payment.repository";

type Handler = (q: string, inputs: Record<string, unknown>) => unknown;

/** Minimal mssql stand-in: records inputs, routes queries to a handler, tracks commit/rollback. */
const fakePool = (handler: Handler) => {
  const state = { committed: false, rolledBack: false };
  const request = () => {
    const inputs: Record<string, unknown> = {};
    const r = {
      input(name: string, _type: unknown, value: unknown) {
        inputs[name] = value;
        return r;
      },
      async query(q: string) {
        const out = handler(q, inputs);
        if (out instanceof Error) throw out;
        return out;
      },
    };
    return r;
  };
  const pool = {
    request,
    transaction: () => ({
      begin: async () => {},
      commit: async () => {
        state.committed = true;
      },
      rollback: async () => {
        state.rolledBack = true;
      },
      request,
    }),
  } as unknown as sql.ConnectionPool;
  return { repo: new SqlServerPaymentRepository(async () => pool), state };
};

const input = {
  studentUserId: "301",
  enrollmentId: "901",
  amount: 45000,
  paymentMode: "bank_transfer" as const,
  referenceNumber: "NEFT-778899",
  enteredByUserId: "7",
};

describe("SqlServerPaymentRepository.recordManualPayment (ADM-009, BR-017)", () => {
  it("records, activates and audits in one transaction, in that order", async () => {
    const order: string[] = [];
    let auditNew = "";
    const { repo, state } = fakePool((q, inputs) => {
      if (q.includes("FROM dbo.NXA_Enrollments WITH (UPDLOCK)")) {
        return { recordset: [{ StudentUserId: 301, EnrollmentStatus: "APPROVED_UNPAID", FinalAmount: "45000.00" }] };
      }
      if (q.includes("INSERT INTO dbo.NXA_ManualPaymentRecords")) {
        order.push("payment");
        assert.match(q, /'verified', @enteredByUserId, SYSUTCDATETIME\(\)/, "verifier and time are recorded");
        return { recordset: [{ ManualPaymentRecordId: 55, CreatedAt: new Date(), VerifiedAt: new Date() }] };
      }
      if (q.includes("UPDATE dbo.NXA_Enrollments")) {
        order.push("activate");
        assert.match(q, /EnrollmentStatus = 'ACTIVE'/);
        return { recordset: [], rowsAffected: [1] };
      }
      if (q.includes("INSERT INTO dbo.NXA_AuditLogs")) {
        order.push("audit");
        auditNew = String(inputs["newVal"]);
        assert.equal(inputs["action"], "RECORD_MANUAL_PAYMENT");
        assert.equal(inputs["actorId"], "7");
        return { recordset: [{ AuditLogId: 1 }] };
      }
      return { recordset: [] };
    });

    const rec = await repo.recordManualPayment(input);
    assert.equal(rec.id, "55");
    assert.equal(rec.verificationStatus, "verified");
    assert.equal(rec.verifiedByUserId, "7");
    assert.deepEqual(order, ["payment", "activate", "audit"]);
    assert.match(auditNew, /NEFT-778899/);
    assert.ok(state.committed && !state.rolledBack);
  });

  const refusals: [string, Record<string, unknown>, string][] = [
    ["another student's enrollment", { StudentUserId: 999, EnrollmentStatus: "APPROVED_UNPAID", FinalAmount: 45000 }, "ENROLLMENT_STUDENT_MISMATCH"],
    ["an enrollment that is already active", { StudentUserId: 301, EnrollmentStatus: "ACTIVE", FinalAmount: 45000 }, "ENROLLMENT_NOT_AWAITING_PAYMENT"],
    ["an unapproved enrollment", { StudentUserId: 301, EnrollmentStatus: "PENDING_APPROVAL", FinalAmount: 45000 }, "ENROLLMENT_NOT_AWAITING_PAYMENT"],
    ["a partial amount (no installments)", { StudentUserId: 301, EnrollmentStatus: "APPROVED_UNPAID", FinalAmount: 90000 }, "AMOUNT_MISMATCH"],
  ];

  for (const [name, row, code] of refusals) {
    it(`refuses ${name} and writes nothing`, async () => {
      let wrote = false;
      const { repo, state } = fakePool((q) => {
        if (q.includes("WITH (UPDLOCK)")) return { recordset: [row] };
        if (q.includes("INSERT") || q.includes("UPDATE")) wrote = true;
        return { recordset: [] };
      });
      await assert.rejects(repo.recordManualPayment(input), (err: Error & { code?: string }) => err.code === code);
      assert.equal(wrote, false);
      assert.ok(state.rolledBack && !state.committed);
    });
  }

  it("lists manual payments using the verified NXA_Courses.CourseName column", async () => {
    let listQuery = "";
    const { repo } = fakePool((q) => {
      listQuery = q;
      return { recordset: [] };
    });
    await repo.getManualPayments();
    assert.match(listQuery, /c\.CourseName AS CourseTitle/);
    assert.doesNotMatch(listQuery, /c\.Title\b/);
  });
});
