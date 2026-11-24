/**
 * Placement types mapped to the live schema (NXA_Companies, NXA_Jobs,
 * NXA_JobApplications, NXA_JobApplicationStatusHistory, NXA_InterviewRounds,
 * NXA_Offers, NXA_PlacementRecords, NXA_CompanyFeedback,
 * NXA_InterviewQuestionBank, NXA_MockInterviews, NXA_JobEligibilityCriteria,
 * NXA_PlacementPackages, NXA_StudentPlacementPackages). Fields with no column
 * in the database (company logo, question creator, placement "rejected"
 * verification) are not offered.
 *
 * Status vocabulary (approved decision D1): jobs open/closed/draft,
 * applications applied/shortlisted/rejected/selected. Technical / HR interview
 * progress is tracked as interview rounds, not as application statuses.
 */

export const JOB_STATUSES = ["open", "closed", "draft"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const APPLICATION_STATUSES = ["applied", "shortlisted", "rejected", "selected"] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export interface HiringCompany {
  id: string;
  companyName: string;
  websiteUrl?: string | undefined;
  industry?: string | undefined;
  description?: string | undefined;
  address?: string | undefined;
  contactName?: string | undefined;
  contactEmail?: string | undefined;
  contactMobile?: string | undefined;
  /** NXA_Companies.IsActive. */
  isActive: boolean;
  /** Derived from IsActive, kept for existing consumers. */
  hiringStatus: 'active' | 'inactive';
  createdAt: string;
}

/** Editable company columns (IsActive changes through the status endpoint). */
export interface CompanyInput {
  companyName: string;
  websiteUrl?: string | undefined;
  industry?: string | undefined;
  description?: string | undefined;
  address?: string | undefined;
  contactName?: string | undefined;
  contactEmail?: string | undefined;
  contactMobile?: string | undefined;
}

export interface JobOpening {
  id: string;
  companyId: string;
  companyName?: string | undefined;
  jobTitle: string;
  employmentType: 'full_time' | 'internship' | 'contract';
  workLocation: string;
  salaryMin?: number | undefined;
  salaryMax?: number | undefined;
  minExperienceYears: number;
  applicationDeadline?: string | undefined;
  jobStatus: JobStatus;
  jobDescription: string;
  publishedByUserId?: string | undefined;
  publishedAt?: string | undefined;
  createdAt: string;
}

/** Editable job columns (the company and status are not edited here). */
export interface JobUpdate {
  jobTitle?: string | undefined;
  employmentType?: JobOpening["employmentType"] | undefined;
  workLocation?: string | undefined;
  salaryMin?: number | null | undefined;
  salaryMax?: number | null | undefined;
  minExperienceYears?: number | undefined;
  applicationDeadline?: string | null | undefined;
  jobDescription?: string | undefined;
}

export interface JobApplication {
  id: string;
  jobId: string;
  jobTitle?: string | undefined;
  companyId?: string | undefined;
  companyName?: string | undefined;
  studentUserId: string;
  studentName?: string | undefined;
  applicationStatus: ApplicationStatus;
  resumeObjectKey?: string | undefined;
  coverLetter?: string | undefined;
  appliedAt: string;
  updatedAt: string;
}

export interface ApplicationFilter {
  jobId?: string | undefined;
  companyId?: string | undefined;
  status?: ApplicationStatus | undefined;
  studentUserId?: string | undefined;
}

/** One NXA_JobApplicationStatusHistory row. */
export interface ApplicationStatusChange {
  id: string;
  jobApplicationId: string;
  previousStatus?: string | undefined;
  newStatus: string;
  changeReason?: string | undefined;
  changedByUserId?: string | undefined;
  changedByName?: string | undefined;
  changedAt: string;
}

/** NXA_InterviewRounds: technical / HR / other rounds of one application. */
export interface InterviewRound {
  id: string;
  jobApplicationId: string;
  roundNumber: number;
  roundName: string;
  scheduledAt?: string | undefined;
  meetingUrl?: string | undefined;
  feedback?: string | undefined;
  /** As stored: rows take the table default; its allowed values are not visible. */
  roundStatus?: string | undefined;
}

export interface InterviewRoundInput {
  roundName: string;
  /** Omitted: the next number after the application's highest round. */
  roundNumber?: number | undefined;
  scheduledAt?: string | undefined;
  meetingUrl?: string | undefined;
}

export interface InterviewRoundUpdate {
  roundName?: string | undefined;
  scheduledAt?: string | null | undefined;
  meetingUrl?: string | null | undefined;
  feedback?: string | null | undefined;
}

/** NXA_Offers. The letter file (OfferObjectKey) needs file storage, which does not exist. */
export interface JobOffer {
  id: string;
  jobApplicationId: string;
  studentUserId?: string | undefined;
  studentName?: string | undefined;
  jobTitle?: string | undefined;
  companyName?: string | undefined;
  offerReference: string;
  offeredSalary?: number | undefined;
  offerDate?: string | undefined;
  joiningDate?: string | undefined;
  /** As stored: rows take the table default; its allowed values are not visible. */
  offerStatus?: string | undefined;
  hasLetter: boolean;
  createdAt: string;
}

export interface OfferInput {
  offerReference: string;
  offeredSalary?: number | undefined;
  offerDate?: string | undefined;
  joiningDate?: string | undefined;
}

export interface MockInterview {
  id: string;
  studentUserId: string;
  studentName?: string | undefined;
  teacherUserId: string;
  teacherName?: string | undefined;
  scheduledAt: string;
  meetingUrl?: string | undefined;
  interviewStatus: 'scheduled' | 'completed' | 'cancelled';
  overallScore?: number | undefined;
  feedback?: string | undefined;
  createdAt: string;
}

/** NXA_InterviewQuestionBank (no creator column exists). */
export interface InterviewQuestion {
  id: string;
  category: string;
  questionText: string;
  /** NXA_InterviewQuestionBank.Difficulty (nullable). */
  difficultyLevel?: 'beginner' | 'intermediate' | 'advanced' | undefined;
  /** NXA_InterviewQuestionBank.SuggestedAnswer. */
  sampleAnswer?: string | undefined;
  /** NXA_InterviewQuestionBank.IsActive (only staff see inactive questions). */
  isActive?: boolean | undefined;
}

export interface QuestionUpdate {
  category?: string | undefined;
  questionText?: string | undefined;
  difficultyLevel?: InterviewQuestion["difficultyLevel"];
  sampleAnswer?: string | null | undefined;
}

/**
 * NXA_PlacementRecords: always tied to a job application (and so to its job
 * and company), optionally to an offer. Job title comes from the job; package
 * and offer date from the offer, when one is linked.
 */
export interface PlacementRecord {
  id: string;
  studentUserId: string;
  studentName?: string | undefined;
  companyId: string;
  companyName?: string | undefined;
  jobId: string;
  jobTitle?: string | undefined;
  jobApplicationId: string;
  offerId?: string | undefined;
  /** NXA_Offers.OfferedSalary of the linked offer. */
  packageOffered?: number | undefined;
  /** NXA_Offers.OfferDate of the linked offer. */
  offerDate?: string | undefined;
  joiningDate?: string | undefined;
  /** NXA_PlacementRecords.EmploymentStatus as stored (allowed values are not visible). */
  employmentStatus?: string | undefined;
  /** "verified" when VerifiedAt is set; a rejection cannot be stored. */
  verificationStatus: 'verified' | 'pending';
  verifiedAt?: string | undefined;
  verifiedByUserId?: string | undefined;
}

export interface CreatePlacementInput {
  jobApplicationId: string;
  offerId?: string | undefined;
  joiningDate?: string | undefined;
  verificationStatus: 'verified' | 'pending';
}

/** NXA_CompanyFeedback (employer feedback, PLC-012). */
export interface CompanyFeedback {
  id: string;
  companyId: string;
  companyName?: string | undefined;
  jobApplicationId?: string | undefined;
  studentUserId?: string | undefined;
  studentName?: string | undefined;
  feedbackText: string;
  /** NXA_CompanyFeedback.Rating as stored; the rating scale is not approved, so it is never written. */
  rating?: number | undefined;
  submittedAt: string;
}

/** NXA_JobEligibilityCriteria, read-only (criterion vocabulary not approved). */
export interface JobEligibilityCriterion {
  id: string;
  jobId: string;
  criterionType: string;
  operator: string;
  criterionValue: string;
}

/** NXA_PlacementPackages, read-only (PackageType codes and guarantee terms not approved). */
export interface PlacementPackage {
  id: string;
  packageName: string;
  packageType: string;
  description?: string | undefined;
  price: number;
  isActive: boolean;
  hasTerms: boolean;
  createdAt: string;
  studentCount: number;
}

/** NXA_StudentPlacementPackages, read-only. */
export interface StudentPlacementPackage {
  id: string;
  studentUserId: string;
  studentName?: string | undefined;
  placementPackageId: string;
  packageName?: string | undefined;
  enrollmentId: string;
  packageStatus?: string | undefined;
  startDate?: string | undefined;
  endDate?: string | undefined;
  createdAt: string;
}

/** PLC-013: counts as stored; statuses are grouped, never interpreted. */
export interface PlacementAnalytics {
  companies: { total: number; active: number };
  jobs: { total: number; byStatus: Record<string, number> };
  applications: { total: number; byStatus: Record<string, number> };
  interviewRounds: number;
  offers: { total: number; averageOfferedSalary: number | null; highestOfferedSalary: number | null };
  placements: { total: number; verified: number; pending: number };
  mockInterviews: { total: number; byStatus: Record<string, number>; averageScore: number | null };
  placementsByCompany: Array<{ companyId: string; companyName?: string | undefined; placements: number }>;
}

export interface JobAnnouncementResult {
  jobId: string;
  recipientCount: number;
}
