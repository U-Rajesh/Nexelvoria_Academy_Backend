import type { ConnectionPool } from "mssql";
import sql from "mssql";
import type { PaymentRepository } from "./payment.repository";
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

  async recordManualPayment(input: Omit<ManualPaymentRecord, "id" | "createdAt">): Promise<ManualPaymentRecord> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("studentUserId", sql.BigInt, Number(input.studentUserId) || 0)
      .input("enrollmentId", sql.BigInt, Number(input.enrollmentId) || 0)
      .input("amount", sql.Decimal(12, 2), input.amount)
      .input("paymentMode", sql.VarChar(30), input.paymentMode)
      .input("referenceNumber", sql.VarChar(100), input.referenceNumber)
      .input("proofObjectKey", sql.NVarChar(700), input.proofObjectKey ?? null)
      .input("verificationStatus", sql.VarChar(20), input.verificationStatus)
      .input("enteredByUserId", sql.BigInt, Number(input.enteredByUserId) || 0)
      .query(`
        INSERT INTO dbo.NXA_ManualPaymentRecords (
          StudentUserId, EnrollmentId, Amount, PaymentMode, ReferenceNumber,
          ProofObjectKey, VerificationStatus, EnteredByUserId, CreatedAt
        )
        OUTPUT INSERTED.ManualPaymentRecordId, INSERTED.CreatedAt
        VALUES (
          @studentUserId, @enrollmentId, @amount, @paymentMode, @referenceNumber,
          @proofObjectKey, @verificationStatus, @enteredByUserId, SYSUTCDATETIME()
        )
      `);

    const row = result.recordset[0];
    return {
      ...input,
      id: String(row.ManualPaymentRecordId),
      createdAt: row.CreatedAt.toISOString(),
    };
  }

  async getManualPayments(): Promise<ManualPaymentRecord[]> {
    const pool = await this.getPool();
    const result = await pool.request().query(`
      SELECT m.ManualPaymentRecordId, m.StudentUserId, m.EnrollmentId, m.Amount,
             m.PaymentMode, m.ReferenceNumber, m.ProofObjectKey, m.VerificationStatus,
             m.VerifiedByUserId, m.VerifiedAt, m.EnteredByUserId, m.CreatedAt,
             u.FullName AS StudentName, c.Title AS CourseTitle, c.CourseId
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

  async verifyManualPayment(id: string, status: "verified" | "rejected", verifiedByUserId: string): Promise<ManualPaymentRecord> {
    const pool = await this.getPool();
    await pool
      .request()
      .input("id", sql.BigInt, Number(id) || 0)
      .input("status", sql.VarChar(20), status)
      .input("verifiedByUserId", sql.BigInt, Number(verifiedByUserId) || 0)
      .query(`
        UPDATE dbo.NXA_ManualPaymentRecords
        SET VerificationStatus = @status,
            VerifiedByUserId = @verifiedByUserId,
            VerifiedAt = SYSUTCDATETIME()
        WHERE ManualPaymentRecordId = @id
      `);

    const list = await this.getManualPayments();
    const match = list.find((m) => m.id === id);
    if (!match) throw new Error("Manual payment record not found after verification");
    return match;
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
               o.StudentUserId, u.FullName AS StudentName, c.CourseId, c.Title AS CourseTitle
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
             o.StudentUserId, u.FullName AS StudentName, c.CourseId, c.Title AS CourseTitle
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

  async getDiscounts(): Promise<CouponDiscount[]> {
    const pool = await this.getPool();
    const result = await pool.request().query(`
      SELECT DiscountId, DiscountName, DiscountType, DiscountValue,
             StartsAt, EndsAt, IsActive, CreatedAt
      FROM dbo.NXA_Discounts
      ORDER BY CreatedAt DESC
    `);

    return result.recordset.map((row) => ({
      id: String(row.DiscountId),
      code: row.DiscountName,
      description: row.DiscountName,
      discountType: row.DiscountType === "percentage" ? "percentage" : "fixed_amount",
      value: Number(row.DiscountValue),
      isActive: Boolean(row.IsActive),
      validUntil: row.EndsAt ? row.EndsAt.toISOString().slice(0, 10) : undefined,
    }));
  }

  async getDiscountByCode(code: string): Promise<CouponDiscount | null> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("code", sql.NVarChar(150), code.trim().toUpperCase())
      .query(`
        SELECT DiscountId, DiscountName, DiscountType, DiscountValue,
               StartsAt, EndsAt, IsActive, CreatedAt
        FROM dbo.NXA_Discounts
        WHERE UPPER(DiscountName) = @code
      `);

    if (result.recordset.length === 0) return null;
    const row = result.recordset[0];
    return {
      id: String(row.DiscountId),
      code: row.DiscountName,
      description: row.DiscountName,
      discountType: row.DiscountType === "percentage" ? "percentage" : "fixed_amount",
      value: Number(row.DiscountValue),
      isActive: Boolean(row.IsActive),
      validUntil: row.EndsAt ? row.EndsAt.toISOString().slice(0, 10) : undefined,
    };
  }

  async createDiscount(discount: Omit<CouponDiscount, "id">): Promise<CouponDiscount> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("name", sql.NVarChar(150), discount.code.trim().toUpperCase())
      .input("type", sql.VarChar(15), discount.discountType)
      .input("value", sql.Decimal(12, 2), discount.value)
      .input("isActive", sql.Bit, discount.isActive ? 1 : 0)
      .input("endsAt", sql.DateTime2(0), discount.validUntil ? new Date(discount.validUntil) : null)
      .query(`
        INSERT INTO dbo.NXA_Discounts (DiscountName, DiscountType, DiscountValue, IsActive, StartsAt, EndsAt, CreatedAt)
        OUTPUT INSERTED.DiscountId
        VALUES (@name, @type, @value, @isActive, SYSUTCDATETIME(), @endsAt, SYSUTCDATETIME())
      `);

    const row = result.recordset[0];
    return {
      ...discount,
      id: String(row.DiscountId),
    };
  }

  async toggleDiscount(id: string): Promise<CouponDiscount> {
    const pool = await this.getPool();
    await pool
      .request()
      .input("id", sql.BigInt, Number(id) || 0)
      .query(`
        UPDATE dbo.NXA_Discounts
        SET IsActive = CASE WHEN IsActive = 1 THEN 0 ELSE 1 END
        WHERE DiscountId = @id
      `);

    const discounts = await this.getDiscounts();
    const match = discounts.find((d) => d.id === id);
    if (!match) throw new Error("Discount not found after toggle");
    return match;
  }

  async deleteDiscount(id: string): Promise<boolean> {
    const pool = await this.getPool();
    await pool
      .request()
      .input("id", sql.BigInt, Number(id) || 0)
      .query(`
        DELETE FROM dbo.NXA_Discounts
        WHERE DiscountId = @id
      `);
    return true;
  }
}
