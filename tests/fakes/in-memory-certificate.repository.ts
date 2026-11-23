import crypto from "node:crypto";
import type { CertificateRepository } from "../../src/modules/certificates/certificate.repository";
import type { CertificateRecord } from "../../src/modules/certificates/certificate.types";

export class InMemoryCertificateRepository implements CertificateRepository {
  certificates: CertificateRecord[] = [];
  verificationLogs: { id: string; certificateId: string; result: string; requestIp: string; timestamp: string }[] = [];

  reset(): void {
    this.certificates = [];
    this.verificationLogs = [];
  }

  async issueCertificate(cert: Omit<CertificateRecord, "id" | "issuedAt">): Promise<CertificateRecord> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const newCert: CertificateRecord = {
      ...cert,
      id,
      issuedAt: now,
    };
    this.certificates.push(newCert);
    return newCert;
  }

  async getCertificateById(id: string): Promise<CertificateRecord | null> {
    return this.certificates.find((c) => c.id === id) ?? null;
  }

  async getCertificateByNumber(certificateNumber: string): Promise<CertificateRecord | null> {
    return (
      this.certificates.find(
        (c) => c.certificateNumber.toLowerCase() === certificateNumber.toLowerCase()
      ) ?? null
    );
  }

  async getCertificateByToken(token: string): Promise<CertificateRecord | null> {
    return this.certificates.find((c) => c.verificationToken === token) ?? null;
  }

  async getCertificatesByStudentId(studentId: string): Promise<CertificateRecord[]> {
    return this.certificates.filter((c) => c.studentUserId === studentId);
  }

  async getAllCertificates(): Promise<CertificateRecord[]> {
    return [...this.certificates];
  }

  async revokeCertificate(id: string, reason: string, _revokedByUserId: string): Promise<CertificateRecord> {
    const cert = this.certificates.find((c) => c.id === id);
    if (!cert) throw new Error("Certificate not found.");
    cert.certificateStatus = "revoked";
    cert.revokedAt = new Date().toISOString();
    cert.revocationReason = reason;
    return cert;
  }

  async logVerification(certificateId: string, result: string, requestIp: string): Promise<void> {
    this.verificationLogs.push({
      id: crypto.randomUUID(),
      certificateId,
      result,
      requestIp,
      timestamp: new Date().toISOString(),
    });
  }
}
