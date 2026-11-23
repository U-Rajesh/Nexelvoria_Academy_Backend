import { z } from "zod";

export const websiteBannerSchema = z.object({
  id: z.string().optional(),
  text: z.string().min(1, "Banner text is required"),
  badgeText: z.string().min(1, "Badge text is required"),
  linkText: z.string().min(1, "Link text is required"),
  linkUrl: z.string().min(1, "Link URL is required"),
  isActive: z.boolean(),
  theme: z.enum(["indigo", "amber", "emerald"]),
});

export const saveBannersSchema = z.object({
  banners: z.array(websiteBannerSchema),
});

export const blogArticleSchema = z.object({
  id: z.string().optional(),
  slug: z.string().min(1, "Slug is required"),
  title: z.string().min(3, "Title must be at least 3 characters"),
  category: z.string().min(1, "Category is required"),
  author: z.string().min(1, "Author name is required"),
  authorRole: z.string().default("Contributing Author"),
  authorAvatar: z.string().default(""),
  date: z.string().default(() => new Date().toISOString()),
  readTime: z.string().default("5 min read"),
  excerpt: z.string().min(1, "Excerpt is required"),
  content: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  featuredImage: z.string().default(""),
  isPublished: z.boolean().default(true),
  order: z.number().int().optional(),
});

export const faqItemSchema = z.object({
  id: z.string().optional(),
  category: z.string().min(1, "Category is required"),
  question: z.string().min(3, "Question must be at least 3 characters"),
  answer: z.string().min(3, "Answer must be at least 3 characters"),
  order: z.number().int().default(1),
  isActive: z.boolean().default(true),
});

export const testimonialItemSchema = z.object({
  id: z.string().optional(),
  studentName: z.string().min(2, "Student name is required"),
  previousRole: z.string().default("Student"),
  currentRole: z.string().min(2, "Current role is required"),
  companyName: z.string().min(2, "Company name is required"),
  companyLogo: z.string().optional(),
  packageCTC: z.string().min(1, "Package CTC is required"),
  courseName: z.string().min(2, "Course name is required"),
  rating: z.number().min(1).max(5).default(5),
  avatarUrl: z.string().default(""),
  quote: z.string().min(5, "Quote is required"),
  year: z.string().default(() => new Date().getFullYear().toString()),
  isPublished: z.boolean().default(true),
  displayOrder: z.number().int().optional(),
});

export const achievementItemSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(3, "Title is required"),
  studentName: z.string().min(2, "Student name is required"),
  category: z.string().min(1, "Category is required"),
  description: z.string().min(5, "Description is required"),
  date: z.string().default(() => new Date().toISOString()),
  badge: z.string().default("Achievement"),
  photoUrl: z.string().optional(),
  isActive: z.boolean().default(true),
  displayOrder: z.number().int().optional(),
});

export const trainerProfileSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(2, "Trainer name is required"),
  role: z.string().min(2, "Role is required"),
  specialization: z.string().min(2, "Specialization is required"),
  experienceYears: z.number().min(0).default(3),
  bio: z.string().min(5, "Bio is required"),
  qualifications: z.string().default("B.Tech / M.Tech"),
  rating: z.number().min(1).max(5).default(5.0),
  avatarUrl: z.string().default(""),
  formerCompanies: z.array(z.string()).default([]),
  linkedinUrl: z.string().default(""),
  coursesTaught: z.array(z.string()).default([]),
  type: z.enum(["trainer", "mentor"]).optional(),
  isActive: z.boolean().default(true),
  displayOrder: z.number().int().optional(),
});

export const careerOpeningSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(3, "Title is required"),
  department: z.string().min(2, "Department is required"),
  location: z.string().default("Hyderabad / Hybrid"),
  type: z.string().default("Full Time"),
  experience: z.string().default("2-4 Years"),
  description: z.string().min(10, "Description is required"),
  responsibilities: z.array(z.string()).default([]),
  requirements: z.array(z.string()).default([]),
  isActive: z.boolean().default(true),
});

export const hiringPartnerSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(2, "Company name is required"),
  logoUrl: z.string().default(""),
  industry: z.string().default("Information Technology"),
  placementsCount: z.number().int().min(0).default(0),
  isFeatured: z.boolean().default(false),
  isActive: z.boolean().default(true),
  displayOrder: z.number().int().optional(),
});

export const collegePartnerSchema = z.object({
  id: z.string().optional(),
  collegeName: z.string().min(2, "College name is required"),
  partnershipType: z.string().default("Academic MOU"),
  location: z.string().optional(),
  logoUrl: z.string().optional(),
  mouSignedDate: z.string().optional(),
  validUntil: z.string().optional(),
  status: z.enum(["active", "inactive", "mou_in_progress"]).default("active"),
  contactPerson: z.string().optional(),
  contactEmail: z.string().email().optional(),
  contactMobile: z.string().optional(),
  websiteUrl: z.string().optional(),
  studentsTrainedCount: z.number().int().optional(),
  notes: z.string().optional(),
});

export const updateCollegePartnerStatusSchema = z.object({
  status: z.enum(["active", "inactive", "mou_in_progress"]),
});

export const corporateTrainingServiceSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(3, "Title is required"),
  shortDescription: z.string().min(5, "Short description is required"),
  fullDescription: z.string().min(10, "Full description is required"),
  topics: z.array(z.string()).min(1, "At least one topic is required"),
  targetAudience: z.string().default("Engineering Teams"),
  deliveryMode: z.string().default("Virtual / Onsite"),
  duration: z.string().default("40 Hours"),
  technologies: z.array(z.string()).default([]),
  isActive: z.boolean().default(true),
  order: z.number().int().default(1),
});

export const leadEnquirySchema = z.object({
  type: z.enum(["general", "course_admission", "callback", "college_mou", "corporate_training"]),
  name: z.string().min(2, "Name is required"),
  email: z.string().email().optional(),
  phone: z.string().min(7, "Valid phone number is required"),
  courseOfInterest: z.string().optional(),
  preferredTimeSlot: z.string().optional(),
  organization: z.string().optional(),
  collegeName: z.string().optional(),
  companyName: z.string().optional(),
  message: z.string().optional(),
});

export const updateEnquiryStatusSchema = z.object({
  status: z.enum(["new", "contacted", "enrolled", "closed"]),
});

export const pageContentSchema = z.object({
  title: z.string().min(1, "Title is required"),
  content: z.record(z.string(), z.unknown()),
  isPublished: z.boolean().default(true),
});

export const newsletterSubscriptionSchema = z.object({
  email: z.string().email("Valid email address is required"),
});
