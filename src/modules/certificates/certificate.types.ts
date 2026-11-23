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

export interface CertificateVerificationResult {
  isValid: boolean;
  certificate?: CertificateRecord | undefined;
  message: string;
  verificationDate: string;
}
