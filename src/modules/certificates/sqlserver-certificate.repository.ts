import type { ConnectionPool } from "mssql";
import sql from "mssql";
import type { CertificateRepository } from "./certificate.repository";
import type { CertificateRecord } from "./certificate.types";
import { CertificateRuleError } from "./certificate.repository";
import { writeAuditLog } from "../admin/sqlserver-admin.repository";
import { RecordNotFoundError } from "../../repositories/repository.errors";

/** Ids are BIGINT; anything else can never match a row. */
const isNumericId = (id: string): boolean => /^\d{1,19}$/.test(id);

export class SqlServerCertificateRepository implements CertificateRepository {
  constructor(private readonly getPool: () => Promise<ConnectionPool>) {}

  async issueCertificate(cert: Omit<CertificateRecord, "id" | "issuedAt">): Promise<CertificateRecord> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("studentUserId", sql.BigInt, Number(cert.studentUserId) || 0)
      .input("courseId", sql.BigInt, Number(cert.courseId) || 0)
      .input("enrollmentId", sql.BigInt, Number(cert.enrollmentId) || 0)
      .input("certificateNumber", sql.VarChar(60), cert.certificateNumber)
      .input("verificationToken", sql.UniqueIdentifier, cert.verificationToken)
      .input("courseNameAtIssue", sql.NVarChar(200), cert.courseNameAtIssue)
      .input("studentNameAtIssue", sql.NVarChar(150), cert.studentNameAtIssue)
      .input("attendancePercentage", sql.Decimal(5, 2), cert.attendancePercentage)
      .input("passingMarksVerified", sql.Bit, cert.passingMarksVerified ? 1 : 0)
      .input("courseCompletionVerified", sql.Bit, cert.courseCompletionVerified ? 1 : 0)
      .input("certificateStatus", sql.VarChar(20), cert.certificateStatus)
      .input("issuedByUserId", sql.BigInt, Number(cert.issuedByUserId) || 0)
      .input("certificateObjectKey", sql.NVarChar(700), cert.pdfUrl ?? null)
      .query(`
        INSERT INTO dbo.NXA_Certificates (
          StudentUserId, CourseId, EnrollmentId, CertificateNumber,
          VerificationToken, CourseNameAtIssue, StudentNameAtIssue,
          AttendancePercentage, PassingMarksVerified, CourseCompletionVerified,
          CertificateStatus, IssuedAt, IssuedByUserId, CertificateObjectKey
        )
        OUTPUT INSERTED.CertificateId, INSERTED.IssuedAt
        VALUES (
          @studentUserId, @courseId, @enrollmentId, @certificateNumber,
          @verificationToken, @courseNameAtIssue, @studentNameAtIssue,
          @attendancePercentage, @passingMarksVerified, @courseCompletionVerified,
          @certificateStatus, SYSUTCDATETIME(), @issuedByUserId, @certificateObjectKey
        )
      `);

    const row = result.recordset[0];
    return {
      ...cert,
      id: String(row.CertificateId),
      issuedAt: row.IssuedAt.toISOString(),
    };
  }

  /**
   * Certificate columns plus the LATEST revocation (NXA_CertificateRevocationHistory:
   * Reason, RevokedAt). OUTER APPLY TOP 1 keeps one row per certificate even
   * when it has several history rows.
   */
  private static readonly CERT_SELECT = `
    SELECT c.CertificateId, c.StudentUserId, c.CourseId, c.EnrollmentId,
           c.CertificateNumber, c.VerificationToken, c.CourseNameAtIssue,
           c.StudentNameAtIssue, c.AttendancePercentage, c.PassingMarksVerified,
           c.CourseCompletionVerified, c.CertificateStatus, c.IssuedAt,
           c.IssuedByUserId, c.CertificateObjectKey,
           r.Reason AS RevocationReason, r.RevokedAt
    FROM dbo.NXA_Certificates c
    OUTER APPLY (
      SELECT TOP 1 h.Reason, h.RevokedAt
      FROM dbo.NXA_CertificateRevocationHistory h
      WHERE h.CertificateId = c.CertificateId
      ORDER BY h.RevokedAt DESC, h.CertificateRevocationHistoryId DESC
    ) r
  `;

  async getCertificateById(id: string): Promise<CertificateRecord | null> {
    if (!isNumericId(id)) return null;
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("id", sql.BigInt, id)
      .query(`${SqlServerCertificateRepository.CERT_SELECT} WHERE c.CertificateId = @id`);
    const row = result.recordset[0];
    return row ? this.mapRow(row) : null;
  }

  async getCertificateByNumber(certificateNumber: string): Promise<CertificateRecord | null> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("certNum", sql.VarChar(60), certificateNumber.trim().toUpperCase())
      .query(`${SqlServerCertificateRepository.CERT_SELECT} WHERE UPPER(c.CertificateNumber) = @certNum`);
    const row = result.recordset[0];
    return row ? this.mapRow(row) : null;
  }

  async getCertificateByToken(token: string): Promise<CertificateRecord | null> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("token", sql.VarChar(100), token.trim().toLowerCase())
      .query(`${SqlServerCertificateRepository.CERT_SELECT} WHERE LOWER(CAST(c.VerificationToken AS VARCHAR(50))) = @token`);
    const row = result.recordset[0];
    return row ? this.mapRow(row) : null;
  }

  async getCertificatesByStudentId(studentId: string): Promise<CertificateRecord[]> {
    if (!isNumericId(studentId)) return [];
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("studentId", sql.BigInt, studentId)
      .query(`${SqlServerCertificateRepository.CERT_SELECT} WHERE c.StudentUserId = @studentId ORDER BY c.IssuedAt DESC`);
    return result.recordset.map((row) => this.mapRow(row));
  }

  async getAllCertificates(): Promise<CertificateRecord[]> {
    const pool = await this.getPool();
    const result = await pool.request().query(`${SqlServerCertificateRepository.CERT_SELECT} ORDER BY c.IssuedAt DESC`);
    return result.recordset.map((row) => this.mapRow(row));
  }

  /**
   * CER-008/CER-009: marks the certificate revoked, records the reason in
   * NXA_CertificateRevocationHistory and writes the audit record, all in one
   * transaction. The certificate row is locked first, so two concurrent
   * revocations cannot both succeed.
   */
  async revokeCertificate(id: string, reason: string, revokedByUserId: string): Promise<CertificateRecord> {
    if (!isNumericId(id)) throw new RecordNotFoundError("certificate", id);
    const pool = await this.getPool();
    const tx = pool.transaction();
    await tx.begin();
    try {
      const cur = tx.request();
      cur.input("id", sql.BigInt, id);
      const before = await cur.query<{ CertificateStatus: string; CertificateNumber: string }>(`
        SELECT CertificateStatus, CertificateNumber
        FROM dbo.NXA_Certificates WITH (UPDLOCK, HOLDLOCK)
        WHERE CertificateId = @id
      `);
      const row = before.recordset[0];
      if (!row) throw new RecordNotFoundError("certificate", id);
      if ((row.CertificateStatus ?? "").toLowerCase() === "revoked") {
        throw new CertificateRuleError("CERTIFICATE_ALREADY_REVOKED", "This certificate has already been revoked.", 409);
      }

      const upd = tx.request();
      upd.input("id", sql.BigInt, id);
      const updated = await upd.query(`
        UPDATE dbo.NXA_Certificates
        SET CertificateStatus = 'revoked'
        WHERE CertificateId = @id AND LOWER(CertificateStatus) <> 'revoked'
      `);
      if ((updated.rowsAffected[0] ?? 0) !== 1) {
        throw new CertificateRuleError("CERTIFICATE_ALREADY_REVOKED", "This certificate has already been revoked.", 409);
      }

      const hist = tx.request();
      hist.input("certId", sql.BigInt, id);
      hist.input("reason", sql.NVarChar(500), reason);
      hist.input("revokedByUserId", sql.BigInt, revokedByUserId);
      await hist.query(`
        INSERT INTO dbo.NXA_CertificateRevocationHistory (CertificateId, Reason, RevokedByUserId, RevokedAt)
        VALUES (@certId, @reason, @revokedByUserId, SYSUTCDATETIME())
      `);

      await writeAuditLog(tx.request(), {
        actorUserId: revokedByUserId,
        actionType: "REVOKE_CERTIFICATE",
        moduleCode: "CERTIFICATE_MGMT",
        entityName: "Certificate",
        entityId: id,
        oldValues: JSON.stringify({ status: row.CertificateStatus }),
        newValues: JSON.stringify({ status: "revoked", certificateNumber: row.CertificateNumber, reason }),
      });

      await tx.commit();
    } catch (err) {
      try {
        await tx.rollback();
      } catch {
        // the original error is the one worth reporting
      }
      throw err;
    }

    const cert = await this.getCertificateById(id);
    if (!cert) throw new RecordNotFoundError("certificate", id);
    return cert;
  }

  async logVerification(certificateId: string, result: string, requestIp: string): Promise<void> {
    const pool = await this.getPool();
    await pool
      .request()
      .input("certId", sql.BigInt, Number(certificateId) || 0)
      .input("result", sql.VarChar(20), result)
      .input("ip", sql.VarChar(45), requestIp)
      .query(`
        INSERT INTO dbo.NXA_CertificateVerificationLogs (CertificateId, VerificationResult, RequestIp, VerifiedAt)
        VALUES (@certId, @result, @ip, SYSUTCDATETIME())
      `);
  }

  private mapRow(row: any): CertificateRecord {
    return {
      id: String(row.CertificateId),
      studentUserId: String(row.StudentUserId),
      courseId: String(row.CourseId),
      enrollmentId: String(row.EnrollmentId),
      certificateNumber: row.CertificateNumber,
      verificationToken: String(row.VerificationToken),
      courseNameAtIssue: row.CourseNameAtIssue,
      studentNameAtIssue: row.StudentNameAtIssue,
      attendancePercentage: Number(row.AttendancePercentage),
      passingMarksVerified: Boolean(row.PassingMarksVerified),
      courseCompletionVerified: Boolean(row.CourseCompletionVerified),
      certificateStatus: String(row.CertificateStatus ?? "").toLowerCase() === "revoked" ? "revoked" : "valid",
      issuedAt: row.IssuedAt.toISOString(),
      // IssuedByUserId is nullable in the live schema.
      issuedByUserId: row.IssuedByUserId != null ? String(row.IssuedByUserId) : "",
      pdfUrl: row.CertificateObjectKey ?? undefined,
      revocationReason: row.RevocationReason ?? undefined,
      revokedAt: row.RevokedAt?.toISOString() ?? undefined,
    };
  }
}
