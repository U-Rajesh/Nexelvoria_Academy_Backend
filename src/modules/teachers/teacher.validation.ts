import { z } from "zod";

export const updateTeacherProfileBodySchema = z
  .object({
    specialization: z.string().trim().max(200).optional(),
    experienceYears: z.coerce.number().min(0).max(100).optional(),
    bio: z.string().trim().max(4000).optional(),
    qualifications: z.string().trim().max(200).optional(),
  })
  .strict();

export type UpdateTeacherProfileBody = z.infer<typeof updateTeacherProfileBodySchema>;

export const attendanceRecordItemSchema = z
  .object({
    studentUserId: z.string().trim().min(1).optional(),
    studentId: z.string().trim().min(1).optional(),
    // BR-010: attendance is Present, Absent or Leave only.
    status: z.enum(["present", "absent", "leave"]),
    remarks: z.string().trim().max(500).optional(),
  })
  .transform((val) => ({
    studentUserId: val.studentUserId ?? val.studentId ?? "",
    status: val.status,
    remarks: val.remarks,
  }));

export const recordAttendanceBodySchema = z
  .object({
    batchId: z.string().trim().min(1),
    courseId: z.string().trim().min(1).optional(),
    date: z.string().trim().min(1).optional(),
    sessionDate: z.string().trim().min(1).optional(),
    sessionTitle: z.string().trim().min(1).max(200).optional(),
    topicCovered: z.string().trim().min(1).max(200).optional(),
    startsAt: z.string().trim().optional(),
    endsAt: z.string().trim().optional(),
    records: z.array(attendanceRecordItemSchema).optional(),
    entries: z.array(attendanceRecordItemSchema).optional(),
  })
  .transform((val) => ({
    batchId: val.batchId,
    courseId: val.courseId,
    date: val.date ?? val.sessionDate ?? new Date().toISOString().split("T")[0]!,
    sessionTitle: val.sessionTitle ?? val.topicCovered ?? "Class Session",
    startsAt: val.startsAt,
    endsAt: val.endsAt,
    records: val.records ?? val.entries ?? [],
  }));

export type RecordAttendanceBody = z.infer<typeof recordAttendanceBodySchema>;

export const createAssignmentBodySchema = z
  .object({
    courseId: z.string().trim().min(1),
    batchId: z.string().trim().min(1).optional(),
    lessonId: z.string().trim().optional(),
    title: z.string().trim().min(1).max(200),
    instructions: z.string().trim().max(4000).optional(),
    maximumMarks: z.coerce.number().min(1).max(1000).default(100),
    dueAt: z.string().trim().optional(),
    allowLateSubmission: z.boolean().default(false),
  })
  .strict();

export type CreateAssignmentBody = z.infer<typeof createAssignmentBodySchema>;

export const evaluateSubmissionBodySchema = z.object({
  marksAwarded: z.coerce.number().min(0),
  feedback: z.string().trim().max(2000).optional(),
  assessmentType: z.string().trim().optional(),
});

export type EvaluateSubmissionBody = z.infer<typeof evaluateSubmissionBodySchema>;

export const createTestBodySchema = z
  .object({
    courseId: z.string().trim().min(1),
    batchId: z.string().trim().min(1).optional(),
    title: z.string().trim().min(1).max(200),
    instructions: z.string().trim().max(4000).optional(),
    durationMinutes: z.coerce.number().min(5).max(360).default(60),
    maximumMarks: z.coerce.number().min(1).max(1000).default(100),
    passingMarks: z.coerce.number().min(0).max(1000).optional(),
    startsAt: z.string().trim().optional(),
    endsAt: z.string().trim().optional(),
    maxAttempts: z.coerce.number().min(1).max(10).default(1),
  })
  .strict();

export type CreateTestBody = z.infer<typeof createTestBodySchema>;

export const uploadMaterialBodySchema = z
  .object({
    lessonId: z.string().trim().min(1),
    materialName: z.string().trim().min(1).max(200),
    materialType: z.string().trim().min(1).max(30).default("pdf"),
    externalUrl: z.string().trim().url().max(1000).optional(),
    fileSizeBytes: z.coerce.number().min(0).optional(),
    mimeType: z.string().trim().max(150).optional(),
  })
  .strict();

export type UploadMaterialBody = z.infer<typeof uploadMaterialBodySchema>;

export const replyDoubtBodySchema = z
  .object({
    replyText: z.string().trim().min(1).max(4000),
  })
  .strict();

export type ReplyDoubtBody = z.infer<typeof replyDoubtBodySchema>;

export const postDoubtBodySchema = z
  .object({
    courseId: z.string().trim().min(1).optional(),
    lessonId: z.string().trim().min(1),
    doubtText: z.string().trim().min(1).max(4000),
  })
  .strict();

export type PostDoubtBody = z.infer<typeof postDoubtBodySchema>;

export const lessonProgressBodySchema = z
  .object({
    isCompleted: z.boolean().default(true),
    progressPercent: z.coerce.number().min(0).max(100).default(100),
  })
  .strict();

export type LessonProgressBody = z.infer<typeof lessonProgressBodySchema>;

export const studentSubmissionBodySchema = z
  .object({
    submissionType: z.enum(["github", "file", "text"]).default("github"),
    githubUrl: z.string().trim().url().max(500).optional(),
    textContent: z.string().trim().max(4000).optional(),
    objectKey: z.string().trim().max(700).optional(),
  })
  .strict();

export type StudentSubmissionBody = z.infer<typeof studentSubmissionBodySchema>;
