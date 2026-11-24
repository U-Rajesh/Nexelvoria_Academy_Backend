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
  // A post is published only when the Admin says so; omission never publishes it.
  isPublished: z.boolean().default(false),
  order: z.number().int().optional(),
});

export const faqItemSchema = z.object({
  id: z.string().optional(),
  // NXA_Faqs has no category column: accepted for compatibility, never stored.
  category: z.string().max(100).default(""),
  question: z.string().trim().min(3, "Question must be at least 3 characters").max(500),
  answer: z.string().min(3, "Answer must be at least 3 characters"),
  order: z.number().int().min(0).default(1),
  // Approved rule: a new FAQ starts hidden (enforced by the repository on create).
  isActive: z.boolean().default(false),
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
  // Approved rule: a new testimonial starts hidden (enforced by the repository on create).
  isPublished: z.boolean().default(false),
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
  // Approved rule: a new achievement starts hidden (enforced by the repository on create).
  isActive: z.boolean().default(false),
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
  // PUB-006: courses are linked by id; the titles are derived by the server.
  coursesTaught: z.array(z.string()).default([]),
  // Same id convention as the course module; existence is checked against the course records.
  courseIds: z.array(z.string().trim().min(1).max(128)).max(30).optional(),
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

/**
 * NXA_Companies stores name (200), industry (120), website (500) and IsActive.
 * logoUrl, placementsCount, isFeatured and displayOrder are accepted for
 * compatibility with existing clients but have no column and are not stored;
 * no value is defaulted into the database.
 */
/**
 * Updating a hiring partner needs the real NXA_Companies id (BIGINT). Sample
 * or client-generated ids such as "hp-1" are refused, so an update can never
 * turn into the creation of a duplicate company. Creation is POST /partners.
 */
export const hiringPartnerIdParamsSchema = z.object({
  id: z
    .string()
    .regex(
      /^\d{1,19}$/,
      "A valid database company ID (numeric) is required to update a hiring partner. Use POST /partners to create a new one.",
    ),
});

export const hiringPartnerSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(2, "Company name is required").max(200),
  logoUrl: z.string().optional(),
  industry: z.string().trim().max(120).optional(),
  websiteUrl: z.string().url().max(500).optional(),
  placementsCount: z.number().int().min(0).optional(),
  isFeatured: z.boolean().optional(),
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
  // Icon name or image URL. Uploaded images need file storage, which is not configured.
  icon: z
    .string()
    .max(2048)
    .refine((v) => !v.startsWith("data:"), "Image uploads are not available yet (no file storage). Use an icon name or an image URL.")
    .optional(),
  isActive: z.boolean().default(true),
  order: z.number().int().min(0).default(1),
});

export const leadEnquirySchema = z.object({
  type: z.enum(["general", "course_admission", "callback", "college_mou", "corporate_training"]),
  // Lengths follow NXA_Enquiries / NXA_CallbackRequests columns.
  name: z.string().trim().min(2, "Name is required").max(150),
  email: z.string().trim().email().max(254).optional(),
  // NXA_Enquiries.Mobile is nullable; a callback needs a number (NXA_CallbackRequests.Mobile is required).
  phone: z.union([z.literal(""), z.string().trim().regex(/^\+?[0-9 ()-]{7,25}$/, "Valid phone number is required")]).default(""),
  courseOfInterest: z.string().max(200).optional(),
  preferredTimeSlot: z.string().max(100).optional(),
  organization: z.string().max(200).optional(),
  collegeName: z.string().max(200).optional(),
  companyName: z.string().max(200).optional(),
  message: z.string().max(4000).optional(),
}).superRefine((v, ctx) => {
  if (v.type === "callback" && !v.phone) {
    ctx.addIssue({ code: "custom", path: ["phone"], message: "A phone number is required for a callback request." });
  } else if (!v.phone && !v.email) {
    ctx.addIssue({ code: "custom", path: ["phone"], message: "Provide a phone number or an email address." });
  }
});

export const updateEnquiryStatusSchema = z.object({
  status: z.enum(["new", "contacted", "enrolled", "closed"]),
});

/** BIGINT identity in the URL (blog articles, FAQs, college partners, enquiries). */
export const numericIdParamsSchema = z.object({
  id: z.string().regex(/^\d{1,19}$/, "A valid numeric id is required."),
});

/** Item id of a JSON collection (testimonials, trainers, ...). */
export const itemIdParamsSchema = z.object({
  id: z.string().trim().min(1).max(100),
});

export const corporateServiceStatusSchema = z.object({
  isActive: z.boolean(),
});

export const reorderCorporateServicesSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
});

export const pageSlugParamsSchema = z.object({
  slug: z.string().regex(/^[a-z0-9_]{1,100}$/, "Invalid page slug."),
});

export const pageContentSchema = z.object({
  title: z.string().min(1, "Title is required"),
  content: z.record(z.string(), z.unknown()),
  isPublished: z.boolean().default(true),
});

export const newsletterSubscriptionSchema = z.object({
  email: z.string().email("Valid email address is required"),
});
