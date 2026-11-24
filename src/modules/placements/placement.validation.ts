import { z } from "zod";
import { APPLICATION_STATUSES, JOB_STATUSES } from "./placement.types";

/** BIGINT identity ids. */
const id = (label: string) => z.string().regex(/^\d{1,19}$/, `${label} must be a numeric id`);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use the YYYY-MM-DD format");
const dateTime = (label: string) =>
  z
    .string()
    .trim()
    .refine((v) => !Number.isNaN(Date.parse(v)), { message: `${label} must be a valid date-time` });
const optionalText = (max: number) => z.string().trim().max(max).optional();
/** An optional text column that an edit may clear (null or ""). */
const clearableText = (max: number) => z.union([z.string().trim().max(max), z.null()]).optional();

export const idParamsSchema = z.object({ id: id("Id") });
export const jobIdParamsSchema = z.object({ jobId: id("Job ID") });

/** NXA_Companies column sizes (ContactEmail nvarchar(254), ContactMobile varchar(25), ...). */
const companyFields = {
  companyName: z.string().trim().min(2, "Company name is required").max(200),
  websiteUrl: z.string().trim().url().max(500).optional(),
  industry: optionalText(120),
  description: optionalText(20000),
  address: optionalText(500),
  contactName: optionalText(150),
  contactEmail: z.string().trim().email().max(254).optional(),
  contactMobile: z
    .string()
    .trim()
    .max(25)
    .regex(/^[0-9+()\- ]{6,25}$/, "Contact mobile may contain digits, spaces, +, - and parentheses")
    .optional(),
};

/**
 * NXA_Companies has IsActive but no hiring-status or logo column, so
 * "partner" and logoUrl are refused rather than silently dropped.
 */
export const createCompanySchema = z
  .object({
    ...companyFields,
    hiringStatus: z.enum(["active", "inactive"]).default("active"),
    logoUrl: z.unknown().optional(),
  })
  .refine((v) => v.logoUrl === undefined, {
    message: "Company logos cannot be stored: the database has no logo column",
    path: ["logoUrl"],
  });

/** Edit of company columns; activation goes through the status endpoint. */
export const updateCompanySchema = z
  .object({
    companyName: companyFields.companyName.optional(),
    websiteUrl: z.union([z.string().trim().url().max(500), z.null()]).optional(),
    industry: clearableText(120),
    description: clearableText(20000),
    address: clearableText(500),
    contactName: clearableText(150),
    contactEmail: z.union([z.string().trim().email().max(254), z.null()]).optional(),
    contactMobile: z.union([companyFields.contactMobile.unwrap(), z.null()]).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one field to change" });

/** Shared by company / question status changes. */
export const setActiveSchema = z
  .object({
    isActive: z.boolean(),
    reason: z.string().trim().min(5, "Reason must be at least 5 characters").max(500).optional(),
  })
  .strict();

export const createJobSchema = z
  .object({
    companyId: id("Company ID"),
    jobTitle: z.string().trim().min(2, "Job title is required").max(200),
    employmentType: z.enum(["full_time", "internship", "contract"]).default("full_time"),
    workLocation: z.string().trim().min(2, "Work location is required").max(200),
    salaryMin: z.number().nonnegative().max(9999999999.99).optional(),
    salaryMax: z.number().nonnegative().max(9999999999.99).optional(),
    // NXA_Jobs.MinExperienceYears is decimal(4,1).
    minExperienceYears: z.number().int().nonnegative().max(999).default(0),
    applicationDeadline: isoDate.optional(),
    jobStatus: z.enum(JOB_STATUSES).default("open"),
    jobDescription: z.string().min(10, "Job description must be at least 10 characters"),
  })
  .refine((v) => v.salaryMin === undefined || v.salaryMax === undefined || v.salaryMin <= v.salaryMax, {
    message: "The minimum salary cannot exceed the maximum",
    path: ["salaryMin"],
  });

/** Job edit: the company and status are not changed here. */
export const updateJobSchema = z
  .object({
    jobTitle: z.string().trim().min(2).max(200).optional(),
    employmentType: z.enum(["full_time", "internship", "contract"]).optional(),
    workLocation: z.string().trim().min(2).max(200).optional(),
    salaryMin: z.union([z.number().nonnegative().max(9999999999.99), z.null()]).optional(),
    salaryMax: z.union([z.number().nonnegative().max(9999999999.99), z.null()]).optional(),
    minExperienceYears: z.number().int().nonnegative().max(999).optional(),
    applicationDeadline: z.union([isoDate, z.null()]).optional(),
    jobDescription: z.string().min(10).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one field to change" });

export const updateJobStatusSchema = z.object({
  status: z.enum(JOB_STATUSES),
});

/** Placement alert (in-app). Defaults are built from the job when omitted. */
export const announceJobSchema = z
  .object({
    title: z.string().trim().min(3).max(250).optional(),
    messageBody: z.string().trim().min(5).max(4000).optional(),
  })
  .strict();

export const applyJobSchema = z.object({
  resumeObjectKey: z.string().max(700).optional(),
  coverLetter: z.string().optional(),
});

export const updateApplicationStatusSchema = z.object({
  status: z.enum(APPLICATION_STATUSES),
  // NXA_JobApplicationStatusHistory.ChangeReason nvarchar(500).
  reason: z.string().trim().max(500).optional(),
});

export const applicationsQuerySchema = z.object({
  jobId: id("Job ID").optional(),
  companyId: id("Company ID").optional(),
  studentUserId: id("Student ID").optional(),
  status: z.enum(APPLICATION_STATUSES).optional(),
});

/** NXA_InterviewRounds: RoundName nvarchar(150), MeetingUrl nvarchar(1000), RoundNumber int. */
export const createRoundSchema = z
  .object({
    roundName: z.string().trim().min(2).max(150),
    roundNumber: z.number().int().min(1).max(100).optional(),
    scheduledAt: dateTime("scheduledAt").optional(),
    meetingUrl: z.string().trim().url().max(1000).optional(),
  })
  .strict();

export const updateRoundSchema = z
  .object({
    roundName: z.string().trim().min(2).max(150).optional(),
    scheduledAt: z.union([dateTime("scheduledAt"), z.null()]).optional(),
    meetingUrl: z.union([z.string().trim().url().max(1000), z.null()]).optional(),
    feedback: z.union([z.string().trim().max(20000), z.null()]).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one field to change" });

/** NXA_Offers: OfferReference varchar(60) (unique), OfferedSalary decimal(12,2). */
export const createOfferSchema = z
  .object({
    offerReference: z
      .string()
      .trim()
      .min(2)
      .max(60)
      .regex(/^[\x20-\x7E]+$/, "Offer reference must be plain ASCII text"),
    offeredSalary: z.number().nonnegative().max(9999999999.99).optional(),
    offerDate: isoDate.optional(),
    joiningDate: isoDate.optional(),
  })
  .strict()
  .refine((v) => !v.offerDate || !v.joiningDate || v.joiningDate >= v.offerDate, {
    message: "The joining date cannot be before the offer date",
    path: ["joiningDate"],
  });

export const offersQuerySchema = z.object({ jobApplicationId: id("Job application ID").optional() });

export const scheduleMockInterviewSchema = z.object({
  studentUserId: z.string().min(1, "Student User ID is required"),
  teacherUserId: z.string().min(1, "Teacher User ID is required"),
  scheduledAt: dateTime("scheduledAt").refine((v) => Date.parse(v) > Date.now(), { message: "The interview must be scheduled in the future" }),
  meetingUrl: z.string().url().max(1000).optional(),
});

export const evaluateMockInterviewSchema = z.object({
  overallScore: z.number().min(0).max(100),
  feedback: z.string().min(5, "Feedback is required"),
  status: z.enum(["completed", "cancelled"]).default("completed"),
});

export const addQuestionSchema = z.object({
  category: z.string().trim().min(2, "Category is required").max(100),
  questionText: z.string().min(5, "Question text is required"),
  difficultyLevel: z.enum(["beginner", "intermediate", "advanced"]).default("intermediate"),
  sampleAnswer: z.string().optional(),
});

export const updateQuestionSchema = z
  .object({
    category: z.string().trim().min(2).max(100).optional(),
    questionText: z.string().min(5).optional(),
    difficultyLevel: z.enum(["beginner", "intermediate", "advanced"]).optional(),
    sampleAnswer: z.union([z.string(), z.null()]).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one field to change" });

export const setQuestionActiveSchema = z.object({ isActive: z.boolean() }).strict();

/**
 * A placement record is tied to an existing job application (student, job and
 * company come from it) and optionally to that application's offer. A
 * "rejected" verification cannot be stored.
 */
export const createPlacementSchema = z.object({
  jobApplicationId: id("Job application ID"),
  offerId: id("Offer ID").optional(),
  joiningDate: isoDate.optional(),
  verificationStatus: z.enum(["verified", "pending"]).default("pending"),
});

/** NXA_CompanyFeedback. Rating is not accepted: its scale has not been approved. */
export const createFeedbackSchema = z
  .object({
    feedbackText: z.string().trim().min(5).max(20000),
    jobApplicationId: id("Job application ID").optional(),
    rating: z.unknown().optional(),
  })
  .strict()
  .refine((v) => v.rating === undefined, {
    message: "Ratings cannot be recorded until the rating scale is approved",
    path: ["rating"],
  });

export const feedbackQuerySchema = z.object({ companyId: id("Company ID").optional() });
