import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type sql from "mssql";

import { SqlServerPaymentRepository } from "../src/modules/payments/sqlserver-payment.repository";
import { SqlServerCertificateRepository } from "../src/modules/certificates/sqlserver-certificate.repository";
import { SqlServerPlacementRepository } from "../src/modules/placements/sqlserver-placement.repository";
import { SqlServerSupportRepository } from "../src/modules/support/sqlserver-support.repository";

// Mock SQL Request and ConnectionPool for testing SQL Server adapters safely without database writes
class MockSqlRequest {
  public inputs: Record<string, unknown> = {};
  public handler: (query: string, inputs: Record<string, unknown>) => unknown;

  constructor(handler: (query: string, inputs: Record<string, unknown>) => unknown) {
    this.handler = handler;
  }

  input(name: string, _typeOrValue: unknown, value?: unknown): this {
    this.inputs[name] = value !== undefined ? value : _typeOrValue;
    return this;
  }

  async query<T = unknown>(command: string): Promise<{ recordset: T[]; rowsAffected: number[] }> {
    const res = this.handler(command, this.inputs);
    if (res instanceof Error) {
      throw res;
    }
    const r = (res ?? {}) as { recordset?: T[]; rowsAffected?: number[] };
    return {
      recordset: r.recordset ?? [],
      rowsAffected: r.rowsAffected ?? [1],
    };
  }
}

const createMockPool = (
  handler: (query: string, inputs: Record<string, unknown>) => unknown
): sql.ConnectionPool => {
  return {
    request: () => new MockSqlRequest(handler),
  } as unknown as sql.ConnectionPool;
};

describe("Batch 6 SQL Server Adapters (Unit with mock pool)", () => {
  describe("SqlServerPaymentRepository", () => {
    it("creates payment order and updates status", async () => {
      let insertedQuery = "";
      let capturedInputs: Record<string, unknown> = {};

      const pool = createMockPool((query, inputs) => {
        if (query.includes("INSERT INTO dbo.NXA_PaymentOrders")) {
          insertedQuery = query;
          capturedInputs = { ...inputs };
          return {
            recordset: [
              {
                PaymentOrderId: 1001,
                StudentUserId: inputs.studentUserId,
                EnrollmentId: inputs.enrollmentId,
                GatewayName: inputs.gatewayName,
                GatewayOrderId: inputs.gatewayOrderId,
                OrderReference: inputs.orderReference,
                Amount: inputs.amount,
                CurrencyCode: inputs.currencyCode,
                OrderStatus: inputs.orderStatus,
                ExpiresAt: new Date(),
                CreatedAt: new Date(),
                UpdatedAt: new Date(),
              },
            ],
          };
        }
        if (query.includes("UPDATE dbo.NXA_PaymentOrders")) {
          return { rowsAffected: [1] };
        }
        if (query.includes("WHERE PaymentOrderId = @id")) {
          return {
            recordset: [
              {
                PaymentOrderId: inputs.id,
                StudentUserId: 101,
                EnrollmentId: 201,
                GatewayName: "razorpay",
                GatewayOrderId: "order_123",
                OrderReference: "ORD-001",
                Amount: 25000,
                CurrencyCode: "INR",
                OrderStatus: "paid",
                ExpiresAt: new Date(),
                CreatedAt: new Date(),
                UpdatedAt: new Date(),
              },
            ],
          };
        }
        return {};
      });

      const repo = new SqlServerPaymentRepository(async () => pool);
      const order = await repo.createPaymentOrder({
        studentUserId: "101",
        enrollmentId: "201",
        gatewayName: "razorpay",
        gatewayOrderId: "order_123",
        orderReference: "ORD-001",
        amount: 25000,
        currencyCode: "INR",
        orderStatus: "created",
        expiresAt: new Date().toISOString(),
      });

      assert.ok(insertedQuery.includes("INSERT INTO dbo.NXA_PaymentOrders"));
      assert.equal(capturedInputs.gatewayOrderId, "order_123");
      assert.equal(order.id, "1001");

      const updated = await repo.updatePaymentOrderStatus("1001", "paid");
      assert.equal(updated.orderStatus, "paid");
    });

    it("records webhook event and checks idempotency", async () => {
      let recorded = false;
      const pool = createMockPool((query, inputs) => {
        if (query.includes("INSERT INTO dbo.NXA_PaymentWebhookEvents")) {
          recorded = true;
          return {
            recordset: [
              {
                PaymentWebhookEventId: 777,
                GatewayName: inputs.gatewayName,
                GatewayEventId: inputs.gatewayEventId,
                EventType: inputs.eventType,
                SignatureValid: inputs.signatureValid,
                ProcessingStatus: inputs.processingStatus,
                Payload: inputs.payload,
                ReceivedAt: new Date(),
                ProcessedAt: new Date(),
              },
            ],
          };
        }
        if (query.includes("FROM dbo.NXA_PaymentWebhookEvents") && query.includes("GatewayName = @gatewayName")) {
          return {
            recordset: [
              {
                PaymentWebhookEventId: 777,
                GatewayName: inputs.gatewayName,
                GatewayEventId: inputs.eventId,
                EventType: "payment.captured",
                SignatureValid: 1,
                ProcessingStatus: "processed",
                Payload: "{}",
                ReceivedAt: new Date(),
                ProcessedAt: new Date(),
              },
            ],
          };
        }
        return {};
      });

      const repo = new SqlServerPaymentRepository(async () => pool);
      const ev = await repo.recordWebhookEvent({
        gatewayName: "razorpay",
        gatewayEventId: "evt_12345",
        eventType: "payment.captured",
        signatureValid: true,
        processingStatus: "processed",
        payload: "{}",
      });

      assert.equal(recorded, true);
      assert.equal(ev.id, "777");

      const existing = await repo.getWebhookEventByGatewayId("razorpay", "evt_12345");
      assert.ok(existing);
      assert.equal(existing.gatewayEventId, "evt_12345");
    });
  });

  describe("SqlServerCertificateRepository", () => {
    it("issues certificate and verifies by number or token", async () => {
      let logged = false;
      const pool = createMockPool((query, inputs) => {
        if (query.includes("INSERT INTO dbo.NXA_Certificates")) {
          return {
            recordset: [
              {
                CertificateId: 999,
                StudentUserId: 101,
                CourseId: 501,
                EnrollmentId: 201,
                CertificateNumber: inputs.certificateNumber,
                VerificationToken: inputs.verificationToken,
                CourseNameAtIssue: inputs.courseNameAtIssue,
                StudentNameAtIssue: inputs.studentNameAtIssue,
                AttendancePercentage: 90,
                PassingMarksVerified: 1,
                CourseCompletionVerified: 1,
                CertificateStatus: "valid",
                IssuedAt: new Date(),
                IssuedByUserId: 1,
              },
            ],
          };
        }
        if (query.includes("WHERE UPPER(c.CertificateNumber) = @certNum")) {
          return {
            recordset: [
              {
                CertificateId: 999,
                StudentUserId: 101,
                CourseId: 501,
                EnrollmentId: 201,
                CertificateNumber: inputs.certNum,
                VerificationToken: "token-abc",
                CourseNameAtIssue: "Full Stack Development",
                StudentNameAtIssue: "Aarav Sharma",
                AttendancePercentage: 90,
                PassingMarksVerified: 1,
                CourseCompletionVerified: 1,
                CertificateStatus: "valid",
                IssuedAt: new Date(),
                IssuedByUserId: 1,
              },
            ],
          };
        }
        if (query.includes("INSERT INTO dbo.NXA_CertificateVerificationLogs")) {
          logged = true;
          return { rowsAffected: [1] };
        }
        return {};
      });

      const repo = new SqlServerCertificateRepository(async () => pool);
      const cert = await repo.issueCertificate({
        studentUserId: "101",
        courseId: "501",
        enrollmentId: "201",
        certificateNumber: "NXA-2026-TEST",
        verificationToken: "token-abc",
        courseNameAtIssue: "Full Stack Development",
        studentNameAtIssue: "Aarav Sharma",
        attendancePercentage: 90,
        passingMarksVerified: true,
        courseCompletionVerified: true,
        certificateStatus: "valid",
        issuedByUserId: "1",
      });

      assert.equal(cert.certificateNumber, "NXA-2026-TEST");

      const fetched = await repo.getCertificateByNumber("NXA-2026-TEST");
      assert.ok(fetched);
      assert.equal(fetched.studentNameAtIssue, "Aarav Sharma");

      await repo.logVerification(fetched.id, "VERIFIED", "127.0.0.1");
      assert.equal(logged, true);
    });
  });

  describe("SqlServerPlacementRepository", () => {
    it("handles companies, jobs, applications, and mock interviews", async () => {
      let createdCompany = false;
      let scheduledMock = false;

      const pool = createMockPool((query, _inputs) => {
        if (query.includes("INSERT INTO dbo.NXA_Companies")) {
          createdCompany = true;
          return { rowsAffected: [1] };
        }
        if (query.includes("SELECT CompanyId, CompanyName")) {
          return {
            recordset: [
              {
                CompanyId: "comp-1",
                CompanyName: "TCS",
                WebsiteUrl: "https://tcs.com",
                Industry: "IT Services",
                HiringStatus: "active",
                LogoUrl: null,
                CreatedAt: new Date(),
              },
            ],
          };
        }
        if (query.includes("INSERT INTO dbo.NXA_MockInterviews")) {
          scheduledMock = true;
          return { rowsAffected: [1] };
        }
        if (query.includes("SELECT m.MockInterviewId")) {
          return {
            recordset: [
              {
                MockInterviewId: "mock-1",
                StudentUserId: "student-1",
                TeacherUserId: "teacher-1",
                ScheduledAt: new Date(),
                InterviewStatus: "scheduled",
                CreatedAt: new Date(),
              },
            ],
          };
        }
        return {};
      });

      const repo = new SqlServerPlacementRepository(async () => pool);

      const comp = await repo.createCompany({
        companyName: "TCS",
        websiteUrl: "https://tcs.com",
        industry: "IT Services",
        hiringStatus: "active",
      });
      assert.equal(createdCompany, true);
      assert.equal(comp.companyName, "TCS");

      const companies = await repo.getCompanies();
      assert.equal(companies.length, 1);
      assert.equal(companies[0]!.companyName, "TCS");

      await repo.scheduleMockInterview({
        studentUserId: "student-1",
        teacherUserId: "teacher-1",
        scheduledAt: new Date().toISOString(),
        interviewStatus: "scheduled",
      });
      assert.equal(scheduledMock, true);
    });
  });

  describe("SqlServerSupportRepository", () => {
    it("handles tickets, replies, notifications, audit logs, and settings", async () => {
      let insertedTicket = false;
      let insertedReply = false;
      let updatedSetting = false;

      const pool = createMockPool((query, inputs) => {
        if (query.includes("INSERT INTO dbo.NXA_SupportTickets")) {
          insertedTicket = true;
          return { rowsAffected: [1] };
        }
        if (query.includes("INSERT INTO dbo.NXA_TicketReplies")) {
          insertedReply = true;
          return { rowsAffected: [1] };
        }
        if (query.includes("SELECT TOP 1 t.SupportTicketId")) {
          return {
            recordset: [
              {
                SupportTicketId: inputs.SupportTicketId,
                TicketNumber: "TCK-001",
                StudentUserId: "student-1",
                CategoryId: "tech",
                Subject: "Course Access",
                Description: "Cannot access lesson 3",
                Priority: "medium",
                TicketStatus: "open",
                CreatedAt: new Date(),
              },
            ],
          };
        }
        if (query.includes("SELECT r.TicketReplyId")) {
          return { recordset: [] };
        }
        if (query.includes("UPDATE dbo.NXA_InstituteSettings")) {
          updatedSetting = true;
          return { rowsAffected: [1] };
        }
        if (query.includes("SELECT TOP 1 InstituteSettingId")) {
          return {
            recordset: [
              {
                InstituteSettingId: "set-1",
                SettingKey: inputs.SettingKey,
                SettingValue: "Nexelvoria Live",
                ValueType: "string",
                IsSecret: 0,
                UpdatedAt: new Date(),
              },
            ],
          };
        }
        return {};
      });

      const repo = new SqlServerSupportRepository(async () => pool);

      const ticket = await repo.createTicket({
        ticketNumber: "TCK-001",
        studentUserId: "student-1",
        categoryId: "tech",
        subject: "Course Access",
        description: "Cannot access lesson 3",
        priority: "medium",
        ticketStatus: "open",
      });
      assert.equal(insertedTicket, true);
      assert.equal(ticket.ticketNumber, "TCK-001");

      const reply = await repo.addReply({
        ticketId: ticket.id,
        repliedByUserId: "student-1",
        replyText: "Still having issues.",
        isInternal: false,
      });
      assert.equal(insertedReply, true);
      assert.equal(reply.replyText, "Still having issues.");

      const setting = await repo.updateSetting("app_name", "Nexelvoria Live", "admin-1");
      assert.equal(updatedSetting, true);
      assert.equal(setting.settingValue, "Nexelvoria Live");
    });
  });
});
