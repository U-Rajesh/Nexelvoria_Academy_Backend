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
} from "./cms.types";

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
  saveHiringPartner(partner: HiringPartner, userId: string): Promise<HiringPartner>;
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

  // Page Content Configuration (home, about, contact, etc.)
  getPageContent(slug: string, onlyPublished?: boolean): Promise<PageContent | null>;
  savePageContent(content: PageContent, userId: string): Promise<PageContent>;

  // Enquiries (Leads)
  submitEnquiry(enquiry: Omit<LeadEnquiry, "id" | "submittedAt" | "status">): Promise<LeadEnquiry>;
  getEnquiries(): Promise<LeadEnquiry[]>;
  updateEnquiryStatus(id: string, status: LeadEnquiry["status"], userId: string): Promise<LeadEnquiry>;

  // Newsletter
  subscribeNewsletter(email: string): Promise<NewsletterSubscription>;
}
