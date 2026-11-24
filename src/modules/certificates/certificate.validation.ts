import { z } from "zod";

export const issueCertificateSchema = z.object({
  studentUserId: z.string().min(1, "Student User ID is required"),
  courseId: z.string().min(1, "Course ID is required"),
  enrollmentId: z.string().min(1, "Enrollment ID is required"),
  studentNameAtIssue: z.string().min(2, "Student Name is required"),
  courseNameAtIssue: z.string().min(2, "Course Name is required"),
  attendancePercentage: z.number().min(0).max(100).default(85),
  passingMarksVerified: z.boolean().default(true),
  courseCompletionVerified: z.boolean().default(true),
});

export const revokeCertificateSchema = z.object({
  // NXA_CertificateRevocationHistory.Reason is nvarchar(500) NOT NULL.
  reason: z
    .string()
    .trim()
    .min(5, "Revocation reason must be at least 5 characters")
    .max(500, "Revocation reason must be at most 500 characters"),
});
