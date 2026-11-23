import crypto from "node:crypto";
import type { CertificateRepository } from "./certificate.repository";
import type {
  CertificateEligibility,
  CertificateRecord,
  CertificateVerificationResult,
} from "./certificate.types";
import { ApiError } from "../../utils/api-error";

export class CertificateService {
  constructor(private readonly certificateRepo: CertificateRepository) {}

  async checkEligibility(
    _studentUserId: string,
    _courseId: string,
    opts?: { attendancePercentage?: number; courseCompletionVerified?: boolean; passingMarksVerified?: boolean }
  ): Promise<CertificateEligibility> {
    const attendance = opts?.attendancePercentage ?? 85;
    const completion = opts?.courseCompletionVerified ?? true;
    const passing = opts?.passingMarksVerified ?? true;

    const reasons: string[] = [];
    const minAttendance = 75;

    if (attendance < minAttendance) {
      reasons.push(`Attendance is ${attendance}%, which is below the required ${minAttendance}%.`);
    }
    if (!completion) {
      reasons.push("Course completion has not been fully verified.");
    }
    if (!passing) {
      reasons.push("Passing marks requirement has not been met.");
    }

    return {
      isEligible: reasons.length === 0,
      attendancePercentage: attendance,
      minAttendanceRequired: minAttendance,
      passingMarksVerified: passing,
      courseCompletionVerified: completion,
      reasons,
    };
  }

  async issueCertificate(data: {
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
    const attendance = data.attendancePercentage ?? 85;
    const passing = data.passingMarksVerified ?? true;
    const completion = data.courseCompletionVerified ?? true;

    if (attendance < 75 || !passing || !completion) {
      throw ApiError.badRequest("Student does not satisfy the academic requirements for certification.");
    }

    const randomSuffix = crypto.randomBytes(4).toString("hex").toUpperCase();
    const certificateNumber = `NXA-2026-${randomSuffix}`;
    const verificationToken = crypto.randomUUID();

    return this.certificateRepo.issueCertificate({
      studentUserId: data.studentUserId,
      studentNameAtIssue: data.studentNameAtIssue,
      courseId: data.courseId,
      courseNameAtIssue: data.courseNameAtIssue,
      enrollmentId: data.enrollmentId,
      certificateNumber,
      verificationToken,
      attendancePercentage: attendance,
      passingMarksVerified: passing,
      courseCompletionVerified: completion,
      certificateStatus: "valid",
      issuedByUserId: data.issuedByUserId,
      pdfUrl: `/api/v1/certificates/download/${certificateNumber}`,
    });
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

    if (cert.certificateStatus === "revoked") {
      return {
        isValid: false,
        certificate: cert,
        message: `Certificate has been revoked: ${cert.revocationReason ?? "Administrative action"}.`,
        verificationDate: now,
      };
    }

    return {
      isValid: true,
      certificate: cert,
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

  async revokeCertificate(id: string, reason: string, adminUserId: string): Promise<CertificateRecord> {
    const existing = await this.certificateRepo.getCertificateById(id);
    if (!existing) {
      throw ApiError.notFound("Certificate not found.");
    }

    return this.certificateRepo.revokeCertificate(id, reason, adminUserId);
  }
}
