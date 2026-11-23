import type { CertificateRecord } from "./certificate.types";

export interface CertificateRepository {
  issueCertificate(cert: Omit<CertificateRecord, "id" | "issuedAt">): Promise<CertificateRecord>;
  getCertificateById(id: string): Promise<CertificateRecord | null>;
  getCertificateByNumber(certificateNumber: string): Promise<CertificateRecord | null>;
  getCertificateByToken(token: string): Promise<CertificateRecord | null>;
  getCertificatesByStudentId(studentId: string): Promise<CertificateRecord[]>;
  getAllCertificates(): Promise<CertificateRecord[]>;
  revokeCertificate(id: string, reason: string, revokedByUserId: string): Promise<CertificateRecord>;
  logVerification(certificateId: string, result: string, requestIp: string): Promise<void>;
}
