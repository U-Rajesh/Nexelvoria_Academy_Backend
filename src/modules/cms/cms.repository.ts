import type {
  WebsiteBanner,
  BlogArticle,
  FAQItem,
  TestimonialItem,
  AchievementItem,
  TrainerProfile,
  CareerOpening,
  HiringPartner,
  CollegePartner,
  CorporateTrainingService,
  LeadEnquiry,
  PageContent,
  NewsletterSubscription,
  CallbackRequest,
} from "./cms.types";

/**
 * Collections kept as one JSON array per NXA_WebsiteContent row (existing
 * slugs and content types; the dedicated tables need columns or file storage
 * that do not exist). Item visibility lives on each item.
 */
export const CMS_COLLECTIONS = {
  banners: { slug: "website_banners", title: "Website Announcement Banners", contentType: "banners", entityName: "Banner", visibilityField: "isActive" },
  testimonials: { slug: "testimonials_list", title: "Student Placement Testimonials", contentType: "testimonials", entityName: "Testimonial", visibilityField: "isPublished" },
  trainers: { slug: "trainers_list", title: "Industry Trainers and Mentors", contentType: "trainers", entityName: "TrainerProfile", visibilityField: "isActive" },
  achievements: { slug: "achievements_list", title: "Student Hackathon & Career Achievements", contentType: "achievements", entityName: "Achievement", visibilityField: "isActive" },
  careers: { slug: "careers_list", title: "Internal Academy Career Openings", contentType: "careers", entityName: "CareerOpening", visibilityField: "isActive" },
  corporate: { slug: "corporate_training_services", title: "Corporate Training Enterprise Tracks", contentType: "corporate", entityName: "CorporateTrainingService", visibilityField: "isActive" },
} as const;
export type CmsCollectionKey = keyof typeof CMS_COLLECTIONS;

/** A CMS business rule refused the change (mapped to 409/422 by the service). */
export class CmsRuleError extends Error {
  constructor(readonly code: string, message: string, readonly status: 409 | 422 = 422) {
    super(message);
    this.name = "CmsRuleError";
  }
}

/** The company is still referenced (jobs, placement records, feedback) and cannot be deleted. */
export class CompanyInUseError extends Error {
  constructor(readonly companyId: string) {
    super("This company is referenced by jobs or placement records and cannot be deleted. Deactivate it instead.");
    this.name = "CompanyInUseError";
  }
}

/**
 * Every write runs in one transaction with its WEBSITE_CMS audit row; an
 * unchanged save writes nothing and is not audited. Unknown ids throw
 * RecordNotFoundError (an update never turns into a create).
 */
export interface CmsRepository {
  // Banners
  getBanners(onlyActive?: boolean): Promise<WebsiteBanner[]>;
  saveBanners(banners: WebsiteBanner[], userId: string): Promise<WebsiteBanner[]>;
  deleteBanner(id: string, userId: string): Promise<boolean>;

  // Articles (Blog)
  getArticles(onlyPublished?: boolean): Promise<BlogArticle[]>;
  getArticleBySlug(slug: string, onlyPublished?: boolean): Promise<BlogArticle | null>;
  saveArticle(article: BlogArticle, userId: string): Promise<BlogArticle>;
  deleteArticle(id: string, userId: string): Promise<boolean>;

  // FAQs
  getFaqs(onlyActive?: boolean): Promise<FAQItem[]>;
  saveFaq(faq: FAQItem, userId: string): Promise<FAQItem>;
  deleteFaq(id: string, userId: string): Promise<boolean>;

  // Testimonials
  getTestimonials(onlyPublished?: boolean): Promise<TestimonialItem[]>;
  saveTestimonial(testimonial: TestimonialItem, userId: string): Promise<TestimonialItem>;
  deleteTestimonial(id: string, userId: string): Promise<boolean>;

  // Trainers & Mentors
  getTrainers(onlyActive?: boolean): Promise<TrainerProfile[]>;
  saveTrainer(trainer: TrainerProfile, userId: string): Promise<TrainerProfile>;
  deleteTrainer(id: string, userId: string): Promise<boolean>;

  // Achievements
  getAchievements(onlyActive?: boolean): Promise<AchievementItem[]>;
  saveAchievement(achievement: AchievementItem, userId: string): Promise<AchievementItem>;
  deleteAchievement(id: string, userId: string): Promise<boolean>;

  // Careers
  getCareers(onlyActive?: boolean): Promise<CareerOpening[]>;
  saveCareer(career: CareerOpening, userId: string): Promise<CareerOpening>;
  deleteCareer(id: string, userId: string): Promise<boolean>;

  // Hiring Partners
  getHiringPartners(onlyActive?: boolean): Promise<HiringPartner[]>;
  /**
   * Empty id: inserts a new company. Numeric id: updates that company
   * (RecordNotFoundError when it does not exist). Any other id is refused with
   * RecordNotFoundError and never creates a company. Stores only NXA_Companies fields.
   */
  saveHiringPartner(partner: HiringPartner, userId: string): Promise<HiringPartner>;
  /** Throws CompanyInUseError when jobs or placement records still reference the company. */
  deleteHiringPartner(id: string, userId: string): Promise<boolean>;

  // College Partners
  getCollegePartners(onlyActive?: boolean): Promise<CollegePartner[]>;
  getCollegePartnerById(id: string): Promise<CollegePartner | null>;
  saveCollegePartner(partner: CollegePartner, userId: string): Promise<CollegePartner>;
  deleteCollegePartner(id: string, userId: string): Promise<boolean>;
  updateCollegePartnerStatus(id: string, status: 'active' | 'inactive' | 'mou_in_progress', userId: string): Promise<CollegePartner>;

  // Corporate Training Services
  getCorporateTrainingServices(onlyActive?: boolean): Promise<CorporateTrainingService[]>;
  saveCorporateTrainingService(service: CorporateTrainingService, userId: string): Promise<CorporateTrainingService>;
  deleteCorporateTrainingService(id: string, userId: string): Promise<boolean>;
  updateCorporateTrainingServiceStatus(id: string, isActive: boolean, userId: string): Promise<CorporateTrainingService>;
  /** ids must list every service exactly once (CmsRuleError otherwise). */
  reorderCorporateTrainingServices(ids: string[], userId: string): Promise<CorporateTrainingService[]>;

  // Page Content Configuration (home, about, contact, etc.)
  getPageContent(slug: string, onlyPublished?: boolean): Promise<PageContent | null>;
  savePageContent(content: PageContent, userId: string): Promise<PageContent>;

  // Enquiries (Leads)
  submitEnquiry(enquiry: Omit<LeadEnquiry, "id" | "submittedAt" | "status">): Promise<LeadEnquiry>;
  getEnquiries(): Promise<LeadEnquiry[]>;
  updateEnquiryStatus(id: string, status: LeadEnquiry["status"], userId: string): Promise<LeadEnquiry>;

  // Callback requests (NXA_CallbackRequests). Status values are not confirmed: read-only for Admins.
  submitCallbackRequest(input: { name: string; phone: string; preferredTimeSlot?: string | undefined }): Promise<CallbackRequest>;
  getCallbackRequests(): Promise<CallbackRequest[]>;

  // Newsletter
  subscribeNewsletter(email: string): Promise<NewsletterSubscription>;
}
