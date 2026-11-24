import type { ConnectionPool } from "mssql";
import sql from "mssql";
import { ManualPaymentRuleError, type ManualPaymentInput, type PaymentRepository } from "./payment.repository";
import { writeAuditLog } from "../admin/sqlserver-admin.repository";
import { DuplicateRecordError } from "../../repositories/repository.errors";
import { writeEnrollmentStatusHistory, writeFinancialAuditHistory } from "../../db/history-writers";
import type {
  PaymentOrder,
  PaymentTransaction,
  PaymentReceipt,
  PaymentWebhookEvent,
  ManualPaymentRecord,
  CouponDiscount,
} from "./payment.types";

export class SqlServerPaymentRepository implements PaymentRepository {
  constructor(private readonly getPool: () => Promise<ConnectionPool>) {}

  async createPaymentOrder(order: Omit<PaymentOrder, "id" | "createdAt" | "updatedAt">): Promise<PaymentOrder> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("studentUserId", sql.BigInt, Number(order.studentUserId) || 0)
      .input("enrollmentId", sql.BigInt, Number(order.enrollmentId) || 0)
      .input("gatewayName", sql.VarChar(30), order.gatewayName)
      .input("gatewayOrderId", sql.VarChar(120), order.gatewayOrderId)
      .input("orderReference", sql.VarChar(60), order.orderReference)
      .input("amount", sql.Decimal(12, 2), order.amount)
      .input("currencyCode", sql.Char(3), order.currencyCode)
      .input("orderStatus", sql.VarChar(20), order.orderStatus)
      .input("expiresAt", sql.DateTime2(0), new Date(order.expiresAt))
      .query(`
        INSERT INTO dbo.NXA_PaymentOrders (
          StudentUserId, EnrollmentId, GatewayName, GatewayOrderId,
          OrderReference, Amount, CurrencyCode, OrderStatus, ExpiresAt,
          CreatedAt, UpdatedAt
        )
        OUTPUT INSERTED.PaymentOrderId, INSERTED.CreatedAt, INSERTED.UpdatedAt
        VALUES (
          @studentUserId, @enrollmentId, @gatewayName, @gatewayOrderId,
          @orderReference, @amount, @currencyCode, @orderStatus, @expiresAt,
          SYSUTCDATETIME(), SYSUTCDATETIME()
        )
      `);

    const row = result.recordset[0];
    return {
      ...order,
      id: String(row.PaymentOrderId),
      createdAt: row.CreatedAt.toISOString(),
      updatedAt: row.UpdatedAt.toISOString(),
    };
  }

  async getPaymentOrderById(id: string): Promise<PaymentOrder | null> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("id", sql.BigInt, Number(id) || 0)
      .query(`
        SELECT PaymentOrderId, StudentUserId, EnrollmentId, GatewayName,
               GatewayOrderId, OrderReference, Amount, CurrencyCode,
               OrderStatus, ExpiresAt, CreatedAt, UpdatedAt
        FROM dbo.NXA_PaymentOrders
        WHERE PaymentOrderId = @id
      `);

    if (result.recordset.length === 0) return null;
    const row = result.recordset[0];
    return {
      id: String(row.PaymentOrderId),
      studentUserId: String(row.StudentUserId),
      enrollmentId: String(row.EnrollmentId),
      gatewayName: row.GatewayName,
      gatewayOrderId: row.GatewayOrderId,
      orderReference: row.OrderReference,
      amount: Number(row.Amount),
      currencyCode: row.CurrencyCode.trim(),
      orderStatus: row.OrderStatus,
      expiresAt: row.ExpiresAt.toISOString(),
      createdAt: row.CreatedAt.toISOString(),
      updatedAt: row.UpdatedAt.toISOString(),
    };
  }

  async getPaymentOrderByGatewayOrderId(gatewayOrderId: string): Promise<PaymentOrder | null> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("gatewayOrderId", sql.VarChar(120), gatewayOrderId)
      .query(`
        SELECT PaymentOrderId, StudentUserId, EnrollmentId, GatewayName,
               GatewayOrderId, OrderReference, Amount, CurrencyCode,
               OrderStatus, ExpiresAt, CreatedAt, UpdatedAt
        FROM dbo.NXA_PaymentOrders
        WHERE GatewayOrderId = @gatewayOrderId
      `);

    if (result.recordset.length === 0) return null;
    const row = result.recordset[0];
    return {
      id: String(row.PaymentOrderId),
      studentUserId: String(row.StudentUserId),
      enrollmentId: String(row.EnrollmentId),
      gatewayName: row.GatewayName,
      gatewayOrderId: row.GatewayOrderId,
      orderReference: row.OrderReference,
      amount: Number(row.Amount),
      currencyCode: row.CurrencyCode.trim(),
      orderStatus: row.OrderStatus,
      expiresAt: row.ExpiresAt.toISOString(),
      createdAt: row.CreatedAt.toISOString(),
      updatedAt: row.UpdatedAt.toISOString(),
    };
  }

  async updatePaymentOrderStatus(id: string, status: PaymentOrder["orderStatus"]): Promise<PaymentOrder> {
    const pool = await this.getPool();
    await pool
      .request()
      .input("id", sql.BigInt, Number(id) || 0)
      .input("status", sql.VarChar(20), status)
      .query(`
        UPDATE dbo.NXA_PaymentOrders
        SET OrderStatus = @status, UpdatedAt = SYSUTCDATETIME()
        WHERE PaymentOrderId = @id
      `);

    const order = await this.getPaymentOrderById(id);
    if (!order) throw new Error("Payment order not found after update");
    return order;
  }

  async createTransaction(tx: Omit<PaymentTransaction, "id" | "createdAt">): Promise<PaymentTransaction> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("paymentOrderId", sql.BigInt, Number(tx.paymentOrderId) || 0)
      .input("gatewayPaymentId", sql.VarChar(120), tx.gatewayPaymentId)
      .input("paymentMethod", sql.VarChar(30), tx.paymentMethod)
      .input("amount", sql.Decimal(12, 2), tx.amount)
      .input("currencyCode", sql.Char(3), tx.currencyCode)
      .input("transactionStatus", sql.VarChar(20), tx.transactionStatus)
      .input("gatewaySignatureValid", sql.Bit, tx.gatewaySignatureValid ? 1 : 0)
      .input("gatewayPayload", sql.NVarChar(sql.MAX), tx.gatewayPayload ?? null)
      .query(`
        INSERT INTO dbo.NXA_Transactions (
          PaymentOrderId, GatewayPaymentId, PaymentMethod, Amount,
          CurrencyCode, TransactionStatus, GatewaySignatureValid,
          GatewayPayload, CreatedAt, ProcessedAt
        )
        OUTPUT INSERTED.TransactionId, INSERTED.CreatedAt
        VALUES (
          @paymentOrderId, @gatewayPaymentId, @paymentMethod, @amount,
          @currencyCode, @transactionStatus, @gatewaySignatureValid,
          @gatewayPayload, SYSUTCDATETIME(), SYSUTCDATETIME()
        )
      `);

    const row = result.recordset[0];
    return {
      ...tx,
      id: String(row.TransactionId),
      createdAt: row.CreatedAt.toISOString(),
    };
  }

  async getTransactionByGatewayPaymentId(paymentId: string): Promise<PaymentTransaction | null> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("paymentId", sql.VarChar(120), paymentId)
      .query(`
        SELECT TransactionId, PaymentOrderId, GatewayPaymentId, PaymentMethod,
               Amount, CurrencyCode, TransactionStatus, GatewaySignatureValid,
               GatewayPayload, CreatedAt, ProcessedAt
        FROM dbo.NXA_Transactions
        WHERE GatewayPaymentId = @paymentId
      `);

    if (result.recordset.length === 0) return null;
    const row = result.recordset[0];
    return {
      id: String(row.TransactionId),
      paymentOrderId: String(row.PaymentOrderId),
      gatewayPaymentId: row.GatewayPaymentId,
      paymentMethod: row.PaymentMethod,
      amount: Number(row.Amount),
      currencyCode: row.CurrencyCode.trim(),
      transactionStatus: row.TransactionStatus,
      gatewaySignatureValid: Boolean(row.GatewaySignatureValid),
      gatewayPayload: row.GatewayPayload ?? undefined,
      createdAt: row.CreatedAt.toISOString(),
    };
  }

  async getTransactionById(id: string): Promise<PaymentTransaction | null> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("id", sql.BigInt, Number(id) || 0)
      .query(`
        SELECT TransactionId, PaymentOrderId, GatewayPaymentId, PaymentMethod,
               Amount, CurrencyCode, TransactionStatus, GatewaySignatureValid,
               GatewayPayload, CreatedAt, ProcessedAt
        FROM dbo.NXA_Transactions
        WHERE TransactionId = @id
      `);

    if (result.recordset.length === 0) return null;
    const row = result.recordset[0];
    return {
      id: String(row.TransactionId),
      paymentOrderId: String(row.PaymentOrderId),
      gatewayPaymentId: row.GatewayPaymentId,
      paymentMethod: row.PaymentMethod,
      amount: Number(row.Amount),
      currencyCode: row.CurrencyCode.trim(),
      transactionStatus: row.TransactionStatus,
      gatewaySignatureValid: Boolean(row.GatewaySignatureValid),
      gatewayPayload: row.GatewayPayload ?? undefined,
      createdAt: row.CreatedAt.toISOString(),
    };
  }

  async createReceipt(receipt: Omit<PaymentReceipt, "id">): Promise<PaymentReceipt> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("transactionId", sql.BigInt, Number(receipt.transactionId) || 0)
      .input("receiptNumber", sql.VarChar(50), receipt.receiptNumber)
      .input("receiptObjectKey", sql.NVarChar(700), receipt.receiptObjectKey ?? null)
      .query(`
        INSERT INTO dbo.NXA_PaymentReceipts (TransactionId, ReceiptNumber, ReceiptObjectKey, IssuedAt)
        OUTPUT INSERTED.PaymentReceiptId, INSERTED.IssuedAt
        VALUES (@transactionId, @receiptNumber, @receiptObjectKey, SYSUTCDATETIME())
      `);

    const row = result.recordset[0];
    return {
      ...receipt,
      id: String(row.PaymentReceiptId),
      issuedAt: row.IssuedAt.toISOString(),
    };
  }

  async getReceiptByTransactionId(txId: string): Promise<PaymentReceipt | null> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("txId", sql.BigInt, Number(txId) || 0)
      .query(`
        SELECT PaymentReceiptId, TransactionId, ReceiptNumber, ReceiptObjectKey, IssuedAt
        FROM dbo.NXA_PaymentReceipts
        WHERE TransactionId = @txId
      `);

    if (result.recordset.length === 0) return null;
    const row = result.recordset[0];
    return {
      id: String(row.PaymentReceiptId),
      transactionId: String(row.TransactionId),
      receiptNumber: row.ReceiptNumber,
      receiptObjectKey: row.ReceiptObjectKey ?? undefined,
      issuedAt: row.IssuedAt.toISOString(),
      amountINR: 0,
      studentName: "",
      courseTitle: "",
    };
  }

  async getReceiptById(receiptId: string): Promise<PaymentReceipt | null> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("id", sql.BigInt, Number(receiptId) || 0)
      .query(`
        SELECT PaymentReceiptId, TransactionId, ReceiptNumber, ReceiptObjectKey, IssuedAt
        FROM dbo.NXA_PaymentReceipts
        WHERE PaymentReceiptId = @id
      `);

    if (result.recordset.length === 0) return null;
    const row = result.recordset[0];
    return {
      id: String(row.PaymentReceiptId),
      transactionId: String(row.TransactionId),
      receiptNumber: row.ReceiptNumber,
      receiptObjectKey: row.ReceiptObjectKey ?? undefined,
      issuedAt: row.IssuedAt.toISOString(),
      amountINR: 0,
      studentName: "",
      courseTitle: "",
    };
  }

  async recordWebhookEvent(event: Omit<PaymentWebhookEvent, "id" | "receivedAt">): Promise<PaymentWebhookEvent> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("gatewayName", sql.VarChar(30), event.gatewayName)
      .input("gatewayEventId", sql.VarChar(150), event.gatewayEventId)
      .input("eventType", sql.VarChar(100), event.eventType)
      .input("signatureValid", sql.Bit, event.signatureValid ? 1 : 0)
      .input("processingStatus", sql.VarChar(20), event.processingStatus)
      .input("payload", sql.NVarChar(sql.MAX), event.payload)
      .query(`
        INSERT INTO dbo.NXA_PaymentWebhookEvents (
          GatewayName, GatewayEventId, EventType, SignatureValid,
          ProcessingStatus, Payload, ReceivedAt, ProcessedAt
        )
        OUTPUT INSERTED.PaymentWebhookEventId, INSERTED.ReceivedAt, INSERTED.ProcessedAt
        VALUES (
          @gatewayName, @gatewayEventId, @eventType, @signatureValid,
          @processingStatus, @payload, SYSUTCDATETIME(), SYSUTCDATETIME()
        )
      `);

    const row = result.recordset[0];
    return {
      ...event,
      id: String(row.PaymentWebhookEventId),
      receivedAt: row.ReceivedAt.toISOString(),
      processedAt: row.ProcessedAt?.toISOString() ?? undefined,
    };
  }

  async getWebhookEventByGatewayId(gatewayName: string, eventId: string): Promise<PaymentWebhookEvent | null> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("gatewayName", sql.VarChar(30), gatewayName)
      .input("eventId", sql.VarChar(150), eventId)
      .query(`
        SELECT PaymentWebhookEventId, GatewayName, GatewayEventId, EventType,
               SignatureValid, ProcessingStatus, Payload, ReceivedAt, ProcessedAt
        FROM dbo.NXA_PaymentWebhookEvents
        WHERE GatewayName = @gatewayName AND GatewayEventId = @eventId
      `);

    if (result.recordset.length === 0) return null;
    const row = result.recordset[0];
    return {
      id: String(row.PaymentWebhookEventId),
      gatewayName: row.GatewayName,
      gatewayEventId: row.GatewayEventId,
      eventType: row.EventType,
      signatureValid: Boolean(row.SignatureValid),
      processingStatus: row.ProcessingStatus,
      payload: row.Payload,
      receivedAt: row.ReceivedAt.toISOString(),
      processedAt: row.ProcessedAt?.toISOString() ?? undefined,
    };
  }

  async recordManualPayment(input: ManualPaymentInput): Promise<ManualPaymentRecord> {
    if (!/^[0-9]+$/.test(input.enrollmentId) || !/^[0-9]+$/.test(input.studentUserId)) {
      throw new ManualPaymentRuleError("ENROLLMENT_NOT_FOUND", "Enrollment not found", 404);
    }
    const pool = await this.getPool();
    const tx = pool.transaction();
    await tx.begin();

    try {
      const enr = await tx
        .request()
        .input("enrollmentId", sql.BigInt, input.enrollmentId)
        .query<{ StudentUserId: number | bigint; EnrollmentStatus: string; FinalAmount: number | string }>(`
          SELECT StudentUserId, EnrollmentStatus, FinalAmount
          FROM dbo.NXA_Enrollments WITH (UPDLOCK)
          WHERE EnrollmentId = @enrollmentId
        `);
      const row = enr.recordset[0];
      if (!row) throw new ManualPaymentRuleError("ENROLLMENT_NOT_FOUND", "Enrollment not found", 404);
      if (String(row.StudentUserId) !== input.studentUserId) {
        throw new ManualPaymentRuleError("ENROLLMENT_STUDENT_MISMATCH", "The enrollment does not belong to this student", 422);
      }
      if (row.EnrollmentStatus.toUpperCase() !== "APPROVED_UNPAID") {
        throw new ManualPaymentRuleError(
          "ENROLLMENT_NOT_AWAITING_PAYMENT",
          `This enrollment is ${row.EnrollmentStatus.toLowerCase()} and is not awaiting payment`,
          409,
        );
      }
      const due = Math.round(Number(row.FinalAmount) * 100);
      if (Math.round(input.amount * 100) !== due) {
        throw new ManualPaymentRuleError(
          "AMOUNT_MISMATCH",
          `The payment must equal the full amount due (${(due / 100).toFixed(2)}); installments are not supported`,
          422,
        );
      }

      // The same offline payment (mode + reference) cannot be recorded twice.
      const dup = await tx
        .request()
        .input("dupMode", sql.VarChar(30), input.paymentMode)
        .input("dupRef", sql.VarChar(100), input.referenceNumber)
        .query<{ ManualPaymentRecordId: number | bigint }>(`
          SELECT TOP 1 ManualPaymentRecordId
          FROM dbo.NXA_ManualPaymentRecords WITH (UPDLOCK, HOLDLOCK)
          WHERE PaymentMode = @dupMode AND UPPER(LTRIM(RTRIM(ReferenceNumber))) = UPPER(@dupRef)
        `);
      if (dup.recordset.length > 0) {
        throw new ManualPaymentRuleError(
          "DUPLICATE_PAYMENT_REFERENCE",
          `A ${input.paymentMode} payment with reference ${input.referenceNumber} is already recorded (manual payment ${String(dup.recordset[0]!.ManualPaymentRecordId)})`,
          409,
        );
      }

      const ins = await tx
        .request()
        .input("studentUserId", sql.BigInt, input.studentUserId)
        .input("enrollmentId", sql.BigInt, input.enrollmentId)
        .input("amount", sql.Decimal(12, 2), input.amount)
        .input("paymentMode", sql.VarChar(30), input.paymentMode)
        .input("referenceNumber", sql.VarChar(100), input.referenceNumber)
        .input("proofObjectKey", sql.NVarChar(700), input.proofObjectKey ?? null)
        .input("enteredByUserId", sql.BigInt, input.enteredByUserId)
        .query<{ ManualPaymentRecordId: number | bigint; CreatedAt: Date; VerifiedAt: Date }>(`
          INSERT INTO dbo.NXA_ManualPaymentRecords (
            StudentUserId, EnrollmentId, Amount, PaymentMode, ReferenceNumber,
            ProofObjectKey, VerificationStatus, VerifiedByUserId, VerifiedAt, EnteredByUserId, CreatedAt
          )
          OUTPUT INSERTED.ManualPaymentRecordId, INSERTED.CreatedAt, INSERTED.VerifiedAt
          VALUES (
            @studentUserId, @enrollmentId, @amount, @paymentMode, @referenceNumber,
            @proofObjectKey, 'verified', @enteredByUserId, SYSUTCDATETIME(), @enteredByUserId, SYSUTCDATETIME()
          )
        `);
      const rec = ins.recordset[0]!;

      await tx
        .request()
        .input("enrollmentId", sql.BigInt, input.enrollmentId)
        .query(`
          UPDATE dbo.NXA_Enrollments
          SET EnrollmentStatus = 'ACTIVE',
              ActivatedAt = COALESCE(ActivatedAt, SYSUTCDATETIME()),
              UpdatedAt = SYSUTCDATETIME()
          WHERE EnrollmentId = @enrollmentId
        `);

      await writeAuditLog(tx.request(), {
        actorUserId: input.enteredByUserId,
        actionType: "RECORD_MANUAL_PAYMENT",
        moduleCode: "PAYMENT_MGMT",
        entityName: "Enrollment",
        entityId: input.enrollmentId,
        oldValues: JSON.stringify({ status: "approved_unpaid" }),
        newValues: JSON.stringify({
          status: "active",
          manualPaymentId: String(rec.ManualPaymentRecordId),
          amount: input.amount,
          paymentMode: input.paymentMode,
          referenceNumber: input.referenceNumber,
        }),
      });

      const manualPaymentId = String(rec.ManualPaymentRecordId);
      await writeEnrollmentStatusHistory(tx.request(), {
        enrollmentId: input.enrollmentId,
        oldStatus: row.EnrollmentStatus,
        newStatus: "ACTIVE",
        changedByUserId: input.enteredByUserId,
        reason: `Manual payment ${manualPaymentId} recorded (${input.paymentMode}, reference ${input.referenceNumber})`,
      });
      // PAY-013 / BR: manual payments must have audit records.
      await writeFinancialAuditHistory(tx.request(), {
        entityType: "ManualPayment",
        entityId: manualPaymentId,
        actionType: "RECORD_MANUAL_PAYMENT",
        performedByUserId: input.enteredByUserId,
        newValues: {
          enrollmentId: input.enrollmentId,
          studentUserId: input.studentUserId,
          amount: input.amount,
          paymentMode: input.paymentMode,
          referenceNumber: input.referenceNumber,
          verificationStatus: "verified",
        },
      });

      await tx.commit();

      return {
        id: String(rec.ManualPaymentRecordId),
        studentUserId: input.studentUserId,
        enrollmentId: input.enrollmentId,
        amount: input.amount,
        paymentMode: input.paymentMode,
        referenceNumber: input.referenceNumber,
        ...(input.proofObjectKey ? { proofObjectKey: input.proofObjectKey } : {}),
        verificationStatus: "verified",
        verifiedByUserId: input.enteredByUserId,
        verifiedAt: rec.VerifiedAt.toISOString(),
        enteredByUserId: input.enteredByUserId,
        createdAt: rec.CreatedAt.toISOString(),
      };
    } catch (err) {
      try {
        await tx.rollback();
      } catch {
        // already rolled back
      }
      throw err;
    }
  }

  async getManualPayments(): Promise<ManualPaymentRecord[]> {
    const pool = await this.getPool();
    const result = await pool.request().query(`
      SELECT m.ManualPaymentRecordId, m.StudentUserId, m.EnrollmentId, m.Amount,
             m.PaymentMode, m.ReferenceNumber, m.ProofObjectKey, m.VerificationStatus,
             m.VerifiedByUserId, m.VerifiedAt, m.EnteredByUserId, m.CreatedAt,
             u.FullName AS StudentName, c.CourseName AS CourseTitle, c.CourseId
      FROM dbo.NXA_ManualPaymentRecords m
      LEFT JOIN dbo.NXA_Users u ON m.StudentUserId = u.UserId
      LEFT JOIN dbo.NXA_Enrollments e ON m.EnrollmentId = e.EnrollmentId
      LEFT JOIN dbo.NXA_Courses c ON e.CourseId = c.CourseId
      ORDER BY m.CreatedAt DESC
    `);

    return result.recordset.map((row) => ({
      id: String(row.ManualPaymentRecordId),
      studentUserId: String(row.StudentUserId),
      studentName: row.StudentName ?? undefined,
      enrollmentId: String(row.EnrollmentId),
      courseId: row.CourseId ? String(row.CourseId) : undefined,
      courseTitle: row.CourseTitle ?? undefined,
      amount: Number(row.Amount),
      paymentMode: row.PaymentMode,
      referenceNumber: row.ReferenceNumber,
      proofObjectKey: row.ProofObjectKey ?? undefined,
      verificationStatus: row.VerificationStatus,
      verifiedByUserId: row.VerifiedByUserId ? String(row.VerifiedByUserId) : undefined,
      verifiedAt: row.VerifiedAt?.toISOString() ?? undefined,
      enteredByUserId: String(row.EnteredByUserId),
      createdAt: row.CreatedAt.toISOString(),
    }));
  }

  async getPaymentsByStudentId(studentId: string): Promise<PaymentTransaction[]> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("studentId", sql.BigInt, Number(studentId) || 0)
      .query(`
        SELECT t.TransactionId, t.PaymentOrderId, t.GatewayPaymentId, t.PaymentMethod,
               t.Amount, t.CurrencyCode, t.TransactionStatus, t.GatewaySignatureValid,
               t.GatewayPayload, t.CreatedAt, r.ReceiptNumber,
               o.StudentUserId, u.FullName AS StudentName, c.CourseId, c.CourseName AS CourseTitle
        FROM dbo.NXA_Transactions t
        INNER JOIN dbo.NXA_PaymentOrders o ON t.PaymentOrderId = o.PaymentOrderId
        LEFT JOIN dbo.NXA_PaymentReceipts r ON t.TransactionId = r.TransactionId
        LEFT JOIN dbo.NXA_Users u ON o.StudentUserId = u.UserId
        LEFT JOIN dbo.NXA_Enrollments e ON o.EnrollmentId = e.EnrollmentId
        LEFT JOIN dbo.NXA_Courses c ON e.CourseId = c.CourseId
        WHERE o.StudentUserId = @studentId
        ORDER BY t.CreatedAt DESC
      `);

    return result.recordset.map((row) => ({
      id: String(row.TransactionId),
      paymentOrderId: String(row.PaymentOrderId),
      gatewayPaymentId: row.GatewayPaymentId,
      paymentMethod: row.PaymentMethod,
      amount: Number(row.Amount),
      currencyCode: row.CurrencyCode.trim(),
      transactionStatus: row.TransactionStatus,
      gatewaySignatureValid: Boolean(row.GatewaySignatureValid),
      gatewayPayload: row.GatewayPayload ?? undefined,
      receiptNumber: row.ReceiptNumber ?? undefined,
      paidAt: row.CreatedAt.toISOString(),
      studentUserId: String(row.StudentUserId),
      studentName: row.StudentName ?? undefined,
      courseId: row.CourseId ? String(row.CourseId) : undefined,
      courseTitle: row.CourseTitle ?? undefined,
      createdAt: row.CreatedAt.toISOString(),
    }));
  }

  async getAllPayments(): Promise<PaymentTransaction[]> {
    const pool = await this.getPool();
    const result = await pool.request().query(`
      SELECT t.TransactionId, t.PaymentOrderId, t.GatewayPaymentId, t.PaymentMethod,
             t.Amount, t.CurrencyCode, t.TransactionStatus, t.GatewaySignatureValid,
             t.GatewayPayload, t.CreatedAt, r.ReceiptNumber,
             o.StudentUserId, u.FullName AS StudentName, c.CourseId, c.CourseName AS CourseTitle
      FROM dbo.NXA_Transactions t
      INNER JOIN dbo.NXA_PaymentOrders o ON t.PaymentOrderId = o.PaymentOrderId
      LEFT JOIN dbo.NXA_PaymentReceipts r ON t.TransactionId = r.TransactionId
      LEFT JOIN dbo.NXA_Users u ON o.StudentUserId = u.UserId
      LEFT JOIN dbo.NXA_Enrollments e ON o.EnrollmentId = e.EnrollmentId
      LEFT JOIN dbo.NXA_Courses c ON e.CourseId = c.CourseId
      ORDER BY t.CreatedAt DESC
    `);

    return result.recordset.map((row) => ({
      id: String(row.TransactionId),
      paymentOrderId: String(row.PaymentOrderId),
      gatewayPaymentId: row.GatewayPaymentId,
      paymentMethod: row.PaymentMethod,
      amount: Number(row.Amount),
      currencyCode: row.CurrencyCode.trim(),
      transactionStatus: row.TransactionStatus,
      gatewaySignatureValid: Boolean(row.GatewaySignatureValid),
      gatewayPayload: row.GatewayPayload ?? undefined,
      receiptNumber: row.ReceiptNumber ?? undefined,
      paidAt: row.CreatedAt.toISOString(),
      studentUserId: String(row.StudentUserId),
      studentName: row.StudentName ?? undefined,
      courseId: row.CourseId ? String(row.CourseId) : undefined,
      courseTitle: row.CourseTitle ?? undefined,
      createdAt: row.CreatedAt.toISOString(),
    }));
  }

  /**
   * Coupons as the live schema stores them: NXA_Coupons (code, limits, usage)
   * joined to the NXA_Discounts row it applies (type, value, validity).
   */
  private static readonly COUPON_SELECT = `
    SELECT c.CouponId, c.CouponCode, c.IsActive AS CouponActive, c.UsageLimit, c.PerUserLimit, c.UsageCount,
           d.DiscountId, d.DiscountName, d.DiscountType, d.DiscountValue, d.StartsAt, d.EndsAt,
           d.IsActive AS DiscountActive
    FROM dbo.NXA_Coupons c
    JOIN dbo.NXA_Discounts d ON d.DiscountId = c.DiscountId
  `;

  private static toCoupon(row: {
    CouponId: number | bigint;
    CouponCode: string;
    CouponActive: boolean;
    UsageLimit: number | null;
    PerUserLimit: number | null;
    UsageCount: number;
    DiscountId: number | bigint;
    DiscountName: string;
    DiscountType: string;
    DiscountValue: number | string;
    StartsAt: Date | null;
    EndsAt: Date | null;
    DiscountActive: boolean;
  }): CouponDiscount {
    return {
      id: String(row.CouponId),
      discountId: String(row.DiscountId),
      code: row.CouponCode,
      description: row.DiscountName,
      discountType: (row.DiscountType ?? "").toLowerCase() === "percentage" ? "percentage" : "fixed_amount",
      value: Number(row.DiscountValue),
      applicableCourseIds: [],
      isActive: Boolean(row.CouponActive) && Boolean(row.DiscountActive),
      validUntil: row.EndsAt ? row.EndsAt.toISOString().slice(0, 10) : undefined,
      startsAt: row.StartsAt ? row.StartsAt.toISOString() : undefined,
      endsAt: row.EndsAt ? row.EndsAt.toISOString() : undefined,
      usageLimit: row.UsageLimit,
      perUserLimit: row.PerUserLimit,
      usageCount: Number(row.UsageCount ?? 0),
    };
  }

  async getDiscounts(): Promise<CouponDiscount[]> {
    const pool = await this.getPool();
    const result = await pool.request().query(`${SqlServerPaymentRepository.COUPON_SELECT} ORDER BY c.CreatedAt DESC`);
    return result.recordset.map((row) => SqlServerPaymentRepository.toCoupon(row));
  }

  async getDiscountByCode(code: string): Promise<CouponDiscount | null> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("code", sql.VarChar(40), code.trim().toUpperCase())
      .query(`${SqlServerPaymentRepository.COUPON_SELECT} WHERE c.CouponCode = @code`);
    const row = result.recordset[0];
    return row ? SqlServerPaymentRepository.toCoupon(row) : null;
  }

  async countCouponRedemptions(couponId: string, studentUserId: string): Promise<number> {
    if (!/^\d+$/.test(couponId) || !/^\d+$/.test(studentUserId)) return 0;
    const pool = await this.getPool();
    // Every recorded redemption counts: the allowed RedemptionStatus values are
    // not visible to the application, so none is excluded.
    const result = await pool
      .request()
      .input("couponId", sql.BigInt, couponId)
      .input("studentId", sql.BigInt, studentUserId)
      .query<{ cnt: number }>(`
        SELECT COUNT(1) AS cnt FROM dbo.NXA_CouponRedemptions
        WHERE CouponId = @couponId AND StudentUserId = @studentId
      `);
    return Number(result.recordset[0]?.cnt ?? 0);
  }

  async createDiscount(discount: Omit<CouponDiscount, "id">, createdByUserId?: string | undefined): Promise<CouponDiscount> {
    const code = discount.code.trim().toUpperCase();
    const pool = await this.getPool();
    const tx = pool.transaction();
    await tx.begin();
    let couponId: string;
    let discountId: string;
    try {
      const dReq = tx.request();
      dReq.input("name", sql.NVarChar(150), discount.description.trim());
      dReq.input("type", sql.VarChar(15), discount.discountType);
      dReq.input("value", sql.Decimal(12, 2), discount.value);
      dReq.input("isActive", sql.Bit, discount.isActive ? 1 : 0);
      dReq.input("endsAt", sql.DateTime2(0), discount.validUntil ? new Date(discount.validUntil) : null);
      dReq.input("createdBy", sql.BigInt, createdByUserId && /^\d+$/.test(createdByUserId) ? createdByUserId : null);
      const d = await dReq.query<{ DiscountId: number | bigint }>(`
        INSERT INTO dbo.NXA_Discounts (DiscountName, DiscountType, DiscountValue, IsActive, StartsAt, EndsAt, CreatedByUserId, CreatedAt)
        OUTPUT INSERTED.DiscountId
        VALUES (@name, @type, @value, @isActive, SYSUTCDATETIME(), @endsAt, @createdBy, SYSUTCDATETIME())
      `);
      discountId = String(d.recordset[0]?.DiscountId);

      const cReq = tx.request();
      cReq.input("code", sql.VarChar(40), code);
      cReq.input("discountId", sql.BigInt, discountId);
      cReq.input("isActive", sql.Bit, discount.isActive ? 1 : 0);
      cReq.input("usageLimit", sql.Int, discount.usageLimit ?? null);
      cReq.input("perUserLimit", sql.Int, discount.perUserLimit ?? null);
      const c = await cReq.query<{ CouponId: number | bigint }>(`
        INSERT INTO dbo.NXA_Coupons (CouponCode, DiscountId, IsActive, UsageLimit, PerUserLimit, UsageCount, CreatedAt)
        OUTPUT INSERTED.CouponId
        VALUES (@code, @discountId, @isActive, @usageLimit, @perUserLimit, 0, SYSUTCDATETIME())
      `);
      couponId = String(c.recordset[0]?.CouponId);

      if (createdByUserId && /^\d+$/.test(createdByUserId)) {
        await writeAuditLog(tx.request(), {
          actorUserId: createdByUserId,
          actionType: "CREATE_COUPON",
          moduleCode: "FINANCE",
          entityName: "Coupon",
          entityId: couponId,
          newValues: JSON.stringify({
            code,
            discountId,
            discountType: discount.discountType,
            value: discount.value,
            usageLimit: discount.usageLimit ?? null,
            perUserLimit: discount.perUserLimit ?? null,
            isActive: discount.isActive,
          }),
        });
        // PAY-013: coupon (and its discount) definition.
        await writeFinancialAuditHistory(tx.request(), {
          entityType: "Coupon",
          entityId: couponId,
          actionType: "CREATE_COUPON",
          performedByUserId: createdByUserId,
          newValues: {
            code,
            discountId,
            discountType: discount.discountType,
            value: discount.value,
            usageLimit: discount.usageLimit ?? null,
            perUserLimit: discount.perUserLimit ?? null,
            isActive: discount.isActive,
            validUntil: discount.validUntil ?? null,
          },
        });
      }

      await tx.commit();
    } catch (err) {
      try {
        await tx.rollback();
      } catch {
        // the original error is the one worth reporting
      }
      const num = (err as { number?: number; originalError?: { info?: { number?: number } } })?.number ??
        (err as { originalError?: { info?: { number?: number } } })?.originalError?.info?.number;
      if (num === 2627 || num === 2601) throw new DuplicateRecordError("coupon", "code", code);
      throw err;
    }

    return {
      ...discount,
      id: couponId,
      discountId,
      code,
      applicableCourseIds: [],
      usageLimit: discount.usageLimit ?? null,
      perUserLimit: discount.perUserLimit ?? null,
      usageCount: 0,
    };
  }

  /**
   * Not supported: a coupon is referenced by its redemptions (and a discount by
   * its coupons), so deleting would lose history. Deactivate it instead.
   * Nothing is deleted.
   */
  async deleteDiscount(_id: string): Promise<boolean> {
    throw new Error("Deleting a coupon is not supported; deactivate it instead.");
  }
}
