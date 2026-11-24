import { CertificateRuleError, type CertificateRepository } from "./certificate.repository";
import { RecordNotFoundError } from "../../repositories/repository.errors";
import type {
  CertificateEligibility,
  CertificateRecord,
  CertificateVerificationResult,
  PublicCertificateView,
} from "./certificate.types";
import { ApiError } from "../../utils/api-error";

/** BR-011 eligibility cannot be decided yet (Q8 + verified data sources). */
const certificateEligibilityBlocked = (): ApiError =>
  ApiError.serviceUnavailable(
    "Certificate eligibility cannot be determined yet: passing marks (open question Q8) and verified attendance " +
      "and completion data are not available. Certificates cannot be issued until they are.",
    "CERTIFICATE_ELIGIBILITY_UNAVAILABLE",
  );

export class CertificateService {
  constructor(private readonly certificateRepo: CertificateRepository) {}

  /**
   * BR-011 certificate eligibility (attendance >= 75%, completion, passing
   * marks) is BLOCKED: course-specific passing marks are undecided (open
   * question Q8) and no verified attendance/completion data source is wired.
   * The previous version answered "eligible" from built-in defaults (85%
   * attendance, completed, passed). No rule is invented; the check is refused.
   */
  async checkEligibility(
    _studentUserId: string,
    _courseId: string,
  ): Promise<CertificateEligibility> {
    throw certificateEligibilityBlocked();
  }

  async issueCertificate(_data: {
    studentUserId: string;
    studentNameAtIssue: string;
    courseId: string;
    courseNameAtIssue: string;
    enrollmentId: string;
    attendancePercentage?: number | undefined;
    passingMarksVerified?: boolean | undefined;
    courseCompletionVerified?: boolean | undefined;
    issuedByUserId: string;
  }): Promise<CertificateRecord> {
    // Issuing depends on BR-011 eligibility, which is blocked (see
    // checkEligibility). Client-supplied or defaulted figures are not
    // accepted as proof of eligibility.
    throw certificateEligibilityBlocked();
  }

  async verifyCertificate(codeOrToken: string, requestIp: string): Promise<CertificateVerificationResult> {
    const cert =
      (await this.certificateRepo.getCertificateByNumber(codeOrToken)) ||
      (await this.certificateRepo.getCertificateByToken(codeOrToken));

    const now = new Date().toISOString();

    if (!cert) {
      return {
        isValid: false,
        message: "No certificate found matching the provided code or verification token.",
        verificationDate: now,
      };
    }

    await this.certificateRepo.logVerification(
      cert.id,
      cert.certificateStatus === "valid" ? "VERIFIED" : "REVOKED",
      requestIp
    );

    const view: PublicCertificateView = {
      certificateNumber: cert.certificateNumber,
      studentNameAtIssue: cert.studentNameAtIssue,
      courseNameAtIssue: cert.courseNameAtIssue,
      attendancePercentage: cert.attendancePercentage,
      certificateStatus: cert.certificateStatus,
      issuedAt: cert.issuedAt,
      ...(cert.revokedAt ? { revokedAt: cert.revokedAt } : {}),
      ...(cert.revocationReason ? { revocationReason: cert.revocationReason } : {}),
    };

    if (cert.certificateStatus === "revoked") {
      return {
        isValid: false,
        certificate: view,
        message: `Certificate has been revoked: ${cert.revocationReason ?? "Administrative action"}.`,
        verificationDate: now,
      };
    }

    return {
      isValid: true,
      certificate: view,
      message: "Certificate is authentic and valid.",
      verificationDate: now,
    };
  }

  async getStudentCertificates(studentUserId: string): Promise<CertificateRecord[]> {
    return this.certificateRepo.getCertificatesByStudentId(studentUserId);
  }

  async getAllCertificates(): Promise<CertificateRecord[]> {
    return this.certificateRepo.getAllCertificates();
  }

  /**
   * CER-008. The repository checks existence and state under a lock and
   * writes status, history and audit atomically; its errors map to 404 / 409.
   */
  async revokeCertificate(id: string, reason: string, adminUserId: string): Promise<CertificateRecord> {
    try {
      return await this.certificateRepo.revokeCertificate(id, reason, adminUserId);
    } catch (err) {
      if (err instanceof RecordNotFoundError) throw ApiError.notFound("Certificate not found.");
      if (err instanceof CertificateRuleError) throw new ApiError(err.status, err.message, err.code);
      throw err;
    }
  }
}
