import type { CertificateRecord } from "./certificate.types";

/** A well-formed request that conflicts with the certificate's state (e.g. already revoked). */
export class CertificateRuleError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 409 | 422 = 422,
  ) {
    super(message);
    this.name = "CertificateRuleError";
  }
}

export interface CertificateRepository {
  issueCertificate(cert: Omit<CertificateRecord, "id" | "issuedAt">): Promise<CertificateRecord>;
  getCertificateById(id: string): Promise<CertificateRecord | null>;
  getCertificateByNumber(certificateNumber: string): Promise<CertificateRecord | null>;
  getCertificateByToken(token: string): Promise<CertificateRecord | null>;
  getCertificatesByStudentId(studentId: string): Promise<CertificateRecord[]>;
  getAllCertificates(): Promise<CertificateRecord[]>;
  /**
   * Revokes the certificate, records the reason in its revocation history and
   * writes the audit record in one transaction. Throws RecordNotFoundError for
   * an unknown id and CertificateRuleError (409) when it is already revoked.
   */
  revokeCertificate(id: string, reason: string, revokedByUserId: string): Promise<CertificateRecord>;
  logVerification(certificateId: string, result: string, requestIp: string): Promise<void>;
}
