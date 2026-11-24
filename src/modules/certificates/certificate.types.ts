export interface CertificateRecord {
  id: string;
  studentUserId: string;
  studentNameAtIssue: string;
  courseId: string;
  courseNameAtIssue: string;
  enrollmentId: string;
  certificateNumber: string;
  verificationToken: string;
  attendancePercentage: number;
  passingMarksVerified: boolean;
  courseCompletionVerified: boolean;
  certificateStatus: 'valid' | 'revoked';
  issuedAt: string;
  issuedByUserId: string;
  pdfUrl?: string | undefined;
  revokedAt?: string | undefined;
  revocationReason?: string | undefined;
}

export interface CertificateEligibility {
  isEligible: boolean;
  attendancePercentage: number;
  minAttendanceRequired: number;
  passingMarksVerified: boolean;
  courseCompletionVerified: boolean;
  reasons: string[];
}

/**
 * What anonymous verification may see (SEC API authorization): the facts
 * printed on the certificate. Internal ids, the verification token and the
 * issuing user are never returned publicly.
 */
export type PublicCertificateView = Pick<
  CertificateRecord,
  "certificateNumber" | "studentNameAtIssue" | "courseNameAtIssue" | "attendancePercentage" | "certificateStatus" | "issuedAt" | "revokedAt" | "revocationReason"
>;

export interface CertificateVerificationResult {
  isValid: boolean;
  certificate?: PublicCertificateView | undefined;
  message: string;
  verificationDate: string;
}
