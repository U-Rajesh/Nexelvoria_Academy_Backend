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
  coursesTaught: string[];
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

export interface HiringPartner {
  id: string;
  name: string;
  logoUrl: string;
  industry: string;
  placementsCount: number;
  isFeatured: boolean;
  isActive: boolean;
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
