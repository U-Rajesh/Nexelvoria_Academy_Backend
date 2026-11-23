import type { ConnectionPool } from "mssql";
import sql from "mssql";
import type { CertificateRepository } from "./certificate.repository";
import type { CertificateRecord } from "./certificate.types";

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

  async getCertificateById(id: string): Promise<CertificateRecord | null> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("id", sql.BigInt, Number(id) || 0)
      .query(`
        SELECT c.CertificateId, c.StudentUserId, c.CourseId, c.EnrollmentId,
               c.CertificateNumber, c.VerificationToken, c.CourseNameAtIssue,
               c.StudentNameAtIssue, c.AttendancePercentage, c.PassingMarksVerified,
               c.CourseCompletionVerified, c.CertificateStatus, c.IssuedAt,
               c.IssuedByUserId, c.CertificateObjectKey,
               r.RevocationReason, r.RevokedAt
        FROM dbo.NXA_Certificates c
        LEFT JOIN dbo.NXA_CertificateRevocationHistory r ON c.CertificateId = r.CertificateId
        WHERE c.CertificateId = @id
      `);

    if (result.recordset.length === 0) return null;
    const row = result.recordset[0];
    return this.mapRow(row);
  }

  async getCertificateByNumber(certificateNumber: string): Promise<CertificateRecord | null> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("certNum", sql.VarChar(60), certificateNumber.trim().toUpperCase())
      .query(`
        SELECT c.CertificateId, c.StudentUserId, c.CourseId, c.EnrollmentId,
               c.CertificateNumber, c.VerificationToken, c.CourseNameAtIssue,
               c.StudentNameAtIssue, c.AttendancePercentage, c.PassingMarksVerified,
               c.CourseCompletionVerified, c.CertificateStatus, c.IssuedAt,
               c.IssuedByUserId, c.CertificateObjectKey,
               r.RevocationReason, r.RevokedAt
        FROM dbo.NXA_Certificates c
        LEFT JOIN dbo.NXA_CertificateRevocationHistory r ON c.CertificateId = r.CertificateId
        WHERE UPPER(c.CertificateNumber) = @certNum
      `);

    if (result.recordset.length === 0) return null;
    return this.mapRow(result.recordset[0]);
  }

  async getCertificateByToken(token: string): Promise<CertificateRecord | null> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("token", sql.VarChar(100), token.trim().toLowerCase())
      .query(`
        SELECT c.CertificateId, c.StudentUserId, c.CourseId, c.EnrollmentId,
               c.CertificateNumber, c.VerificationToken, c.CourseNameAtIssue,
               c.StudentNameAtIssue, c.AttendancePercentage, c.PassingMarksVerified,
               c.CourseCompletionVerified, c.CertificateStatus, c.IssuedAt,
               c.IssuedByUserId, c.CertificateObjectKey,
               r.RevocationReason, r.RevokedAt
        FROM dbo.NXA_Certificates c
        LEFT JOIN dbo.NXA_CertificateRevocationHistory r ON c.CertificateId = r.CertificateId
        WHERE LOWER(CAST(c.VerificationToken AS VARCHAR(50))) = @token
      `);

    if (result.recordset.length === 0) return null;
    return this.mapRow(result.recordset[0]);
  }

  async getCertificatesByStudentId(studentId: string): Promise<CertificateRecord[]> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("studentId", sql.BigInt, Number(studentId) || 0)
      .query(`
        SELECT c.CertificateId, c.StudentUserId, c.CourseId, c.EnrollmentId,
               c.CertificateNumber, c.VerificationToken, c.CourseNameAtIssue,
               c.StudentNameAtIssue, c.AttendancePercentage, c.PassingMarksVerified,
               c.CourseCompletionVerified, c.CertificateStatus, c.IssuedAt,
               c.IssuedByUserId, c.CertificateObjectKey,
               r.RevocationReason, r.RevokedAt
        FROM dbo.NXA_Certificates c
        LEFT JOIN dbo.NXA_CertificateRevocationHistory r ON c.CertificateId = r.CertificateId
        WHERE c.StudentUserId = @studentId
        ORDER BY c.IssuedAt DESC
      `);

    return result.recordset.map((row) => this.mapRow(row));
  }

  async getAllCertificates(): Promise<CertificateRecord[]> {
    const pool = await this.getPool();
    const result = await pool.request().query(`
      SELECT c.CertificateId, c.StudentUserId, c.CourseId, c.EnrollmentId,
             c.CertificateNumber, c.VerificationToken, c.CourseNameAtIssue,
             c.StudentNameAtIssue, c.AttendancePercentage, c.PassingMarksVerified,
             c.CourseCompletionVerified, c.CertificateStatus, c.IssuedAt,
             c.IssuedByUserId, c.CertificateObjectKey,
             r.RevocationReason, r.RevokedAt
      FROM dbo.NXA_Certificates c
      LEFT JOIN dbo.NXA_CertificateRevocationHistory r ON c.CertificateId = r.CertificateId
      ORDER BY c.IssuedAt DESC
    `);

    return result.recordset.map((row) => this.mapRow(row));
  }

  async revokeCertificate(id: string, reason: string, revokedByUserId: string): Promise<CertificateRecord> {
    const pool = await this.getPool();
    await pool
      .request()
      .input("id", sql.BigInt, Number(id) || 0)
      .query(`
        UPDATE dbo.NXA_Certificates
        SET CertificateStatus = 'revoked'
        WHERE CertificateId = @id
      `);

    await pool
      .request()
      .input("certId", sql.BigInt, Number(id) || 0)
      .input("reason", sql.NVarChar(sql.MAX), reason)
      .input("revokedByUserId", sql.BigInt, Number(revokedByUserId) || 0)
      .query(`
        INSERT INTO dbo.NXA_CertificateRevocationHistory (CertificateId, RevocationReason, RevokedByUserId, RevokedAt)
        VALUES (@certId, @reason, @revokedByUserId, SYSUTCDATETIME())
      `);

    const cert = await this.getCertificateById(id);
    if (!cert) throw new Error("Certificate not found after revocation");
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
      certificateStatus: row.CertificateStatus === "revoked" ? "revoked" : "valid",
      issuedAt: row.IssuedAt.toISOString(),
      issuedByUserId: String(row.IssuedByUserId),
      pdfUrl: row.CertificateObjectKey ?? undefined,
      revocationReason: row.RevocationReason ?? undefined,
      revokedAt: row.RevokedAt?.toISOString() ?? undefined,
    };
  }
}
