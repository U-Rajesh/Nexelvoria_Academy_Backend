export interface HiringCompany {
  id: string;
  companyName: string;
  websiteUrl?: string | undefined;
  industry?: string | undefined;
  hiringStatus: 'active' | 'inactive' | 'partner';
  logoUrl?: string | undefined;
  createdAt: string;
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
  jobStatus: 'open' | 'closed' | 'draft';
  jobDescription: string;
  publishedByUserId?: string | undefined;
  publishedAt?: string | undefined;
  createdAt: string;
}

export interface JobApplication {
  id: string;
  jobId: string;
  jobTitle?: string | undefined;
  companyName?: string | undefined;
  studentUserId: string;
  studentName?: string | undefined;
  applicationStatus: 'applied' | 'shortlisted' | 'rejected' | 'selected';
  resumeObjectKey?: string | undefined;
  coverLetter?: string | undefined;
  appliedAt: string;
  updatedAt: string;
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

export interface InterviewQuestion {
  id: string;
  category: string;
  questionText: string;
  difficultyLevel: 'beginner' | 'intermediate' | 'advanced';
  sampleAnswer?: string | undefined;
  createdByUserId?: string | undefined;
}

export interface PlacementRecord {
  id: string;
  studentUserId: string;
  studentName?: string | undefined;
  companyId: string;
  companyName?: string | undefined;
  jobTitle: string;
  packageOffered: number;
  offerDate: string;
  verificationStatus: 'verified' | 'pending' | 'rejected';
}
