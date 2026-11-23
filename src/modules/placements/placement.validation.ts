import { z } from "zod";

export const createCompanySchema = z.object({
  companyName: z.string().min(2, "Company name is required"),
  websiteUrl: z.string().url().optional(),
  industry: z.string().optional(),
  hiringStatus: z.enum(["active", "inactive", "partner"]).default("active"),
  logoUrl: z.string().url().optional(),
});

export const createJobSchema = z.object({
  companyId: z.string().min(1, "Company ID is required"),
  jobTitle: z.string().min(2, "Job title is required"),
  employmentType: z.enum(["full_time", "internship", "contract"]).default("full_time"),
  workLocation: z.string().min(2, "Work location is required"),
  salaryMin: z.number().nonnegative().optional(),
  salaryMax: z.number().nonnegative().optional(),
  minExperienceYears: z.number().int().nonnegative().default(0),
  applicationDeadline: z.string().optional(),
  jobStatus: z.enum(["open", "closed", "draft"]).default("open"),
  jobDescription: z.string().min(10, "Job description must be at least 10 characters"),
});

export const applyJobSchema = z.object({
  resumeObjectKey: z.string().optional(),
  coverLetter: z.string().optional(),
});

export const updateApplicationStatusSchema = z.object({
  status: z.enum(["applied", "shortlisted", "rejected", "selected"]),
});

export const scheduleMockInterviewSchema = z.object({
  studentUserId: z.string().min(1, "Student User ID is required"),
  teacherUserId: z.string().min(1, "Teacher User ID is required"),
  scheduledAt: z.string().min(1, "Scheduled date is required"),
  meetingUrl: z.string().url().optional(),
});

export const evaluateMockInterviewSchema = z.object({
  overallScore: z.number().min(0).max(100),
  feedback: z.string().min(5, "Feedback is required"),
  status: z.enum(["completed", "cancelled"]).default("completed"),
});

export const addQuestionSchema = z.object({
  category: z.string().min(2, "Category is required"),
  questionText: z.string().min(5, "Question text is required"),
  difficultyLevel: z.enum(["beginner", "intermediate", "advanced"]).default("intermediate"),
  sampleAnswer: z.string().optional(),
});
