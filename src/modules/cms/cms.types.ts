/**
 * Domain types for Public CMS, Marketing, and Communication Modules.
 * Strict exactOptionalPropertyTypes compliance: optional fields include `| undefined`.
 */

export interface WebsiteBanner {
  id: string;
  text: string;
  badgeText: string;
  linkText: string;
  linkUrl: string;
  isActive: boolean;
  theme: 'indigo' | 'amber' | 'emerald';
}

export interface BlogArticle {
  id: string;
  slug: string;
  title: string;
  category: string;
  author: string;
  authorRole: string;
  authorAvatar: string;
  date: string;
  readTime: string;
  excerpt: string;
  content: string[];
  tags: string[];
  featuredImage: string;
  isPublished: boolean;
  order?: number | undefined;
}

export interface FAQItem {
  id: string;
  category: 'Admissions' | 'Fees & Payments' | 'LMS & Attendance' | 'Certificates' | 'Placements' | 'General' | string;
  question: string;
  answer: string;
  order: number;
  isActive: boolean;
}

export interface TestimonialItem {
  id: string;
  studentName: string;
  previousRole: string;
  currentRole: string;
  companyName: string;
  companyLogo?: string | undefined;
  packageCTC: string;
  courseName: string;
  rating: number;
  avatarUrl: string;
  quote: string;
  year: string;
  isPublished: boolean;
  displayOrder?: number | undefined;
}

export interface AchievementItem {
  id: string;
  title: string;
  studentName: string;
  category: 'Hackathon' | 'Placement Milestone' | 'Open Source' | 'Promotion' | string;
  description: string;
  date: string;
  badge: string;
  photoUrl?: string | undefined;
  isActive: boolean;
  displayOrder?: number | undefined;
}

export interface TrainerProfile {
  id: string;
  name: string;
  role: string;
  specialization: string;
  experienceYears: number;
  bio: string;
  qualifications: string;
  rating: number;
  avatarUrl: string;
  formerCompanies: string[];
  linkedinUrl: string;
  /**
   * Titles of the linked courses. Since PUB-006 this is derived by the server
   * from `courseIds` (real NXA_Courses rows) and is no longer free text.
   */
  coursesTaught: string[];
  /** PUB-006: linked course ids (NXA_Courses.CourseId), stored with the profile. */
  courseIds?: string[] | undefined;
  /** Response only: the linked courses (public responses list published courses only). */
  linkedCourses?: Array<{ id: string; title: string; slug: string }> | undefined;
  type?: 'trainer' | 'mentor' | undefined;
  isActive: boolean;
  displayOrder?: number | undefined;
}

export interface CareerOpening {
  id: string;
  title: string;
  department: string;
  location: string;
  type: string;
  experience: string;
  description: string;
  responsibilities: string[];
  requirements: string[];
  isActive: boolean;
}

/**
 * A hiring partner is an NXA_Companies row. The live table has no logo,
 * featured or display-order column: those fields are accepted on input for
 * compatibility but never stored, and are absent from stored records.
 */
export interface HiringPartner {
  id: string;
  name: string;
  /** Not stored (no NXA_Companies column); always absent when read. */
  logoUrl?: string | undefined;
  industry?: string | undefined;
  websiteUrl?: string | undefined;
  /** Read: real count of NXA_PlacementRecords for the company. Not stored. */
  placementsCount?: number | undefined;
  /** Not stored (no column); always absent when read. */
  isFeatured?: boolean | undefined;
  isActive: boolean;
  /** Not stored (no column); always absent when read. */
  displayOrder?: number | undefined;
}

export interface CollegePartner {
  id: string;
  collegeName: string;
  partnershipType: string;
  location?: string | undefined;
  logoUrl?: string | undefined;
  mouSignedDate?: string | undefined;
  validUntil?: string | undefined;
  status: 'active' | 'inactive' | 'mou_in_progress';
  contactPerson?: string | undefined;
  contactEmail?: string | undefined;
  contactMobile?: string | undefined;
  websiteUrl?: string | undefined;
  studentsTrainedCount?: number | undefined;
  notes?: string | undefined;
  createdAt?: string | undefined;
}

export interface CorporateTrainingService {
  id: string;
  title: string;
  shortDescription: string;
  fullDescription: string;
  topics: string[];
  targetAudience: string;
  deliveryMode: string;
  duration: string;
  technologies: string[];
  /** Icon name or image URL (no file storage for uploads). */
  icon?: string | undefined;
  isActive: boolean;
  order: number;
}

export interface LeadEnquiry {
  id: string;
  type: 'general' | 'course_admission' | 'callback' | 'college_mou' | 'corporate_training';
  name: string;
  email?: string | undefined;
  phone: string;
  courseOfInterest?: string | undefined;
  preferredTimeSlot?: string | undefined;
  organization?: string | undefined;
  collegeName?: string | undefined;
  companyName?: string | undefined;
  message?: string | undefined;
  submittedAt: string;
  status: 'new' | 'contacted' | 'enrolled' | 'closed';
}

export interface PageContent {
  slug: string;
  title: string;
  content: Record<string, unknown>;
  isPublished: boolean;
  updatedAt?: string | undefined;
  updatedByUserId?: string | undefined;
}

export interface NewsletterSubscription {
  id: string;
  email: string;
  subscribedAt: string;
  isActive: boolean;
}

/** NXA_CallbackRequests row. `status` is the stored RequestStatus (allowed values not confirmed). */
export interface CallbackRequest {
  id: string;
  name: string;
  phone: string;
  preferredTimeSlot?: string | undefined;
  status?: string | undefined;
  requestedAt: string;
}
