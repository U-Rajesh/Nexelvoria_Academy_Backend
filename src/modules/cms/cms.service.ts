import type { CmsRepository } from "./cms.repository";
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

export interface CmsServiceDeps {
  cms: CmsRepository;
}

export class CmsService {
  constructor(private readonly deps: CmsServiceDeps) {}

  // --- Public Read Operations (Strictly Published / Active Only) ---

  async getPublicBanners(): Promise<WebsiteBanner[]> {
    return this.deps.cms.getBanners(true);
  }

  async getPublicArticles(): Promise<BlogArticle[]> {
    return this.deps.cms.getArticles(true);
  }

  async getPublicArticleBySlug(slug: string): Promise<BlogArticle | null> {
    return this.deps.cms.getArticleBySlug(slug, true);
  }

  async getPublicFaqs(): Promise<FAQItem[]> {
    return this.deps.cms.getFaqs(true);
  }

  async getPublicTestimonials(): Promise<TestimonialItem[]> {
    return this.deps.cms.getTestimonials(true);
  }

  async getPublicTrainers(): Promise<TrainerProfile[]> {
    return this.deps.cms.getTrainers(true);
  }

  async getPublicAchievements(): Promise<AchievementItem[]> {
    return this.deps.cms.getAchievements(true);
  }

  async getPublicCareers(): Promise<CareerOpening[]> {
    return this.deps.cms.getCareers(true);
  }

  async getPublicHiringPartners(): Promise<HiringPartner[]> {
    return this.deps.cms.getHiringPartners(true);
  }

  async getPublicCollegePartners(): Promise<CollegePartner[]> {
    return this.deps.cms.getCollegePartners(true);
  }

  async getPublicCorporateTrainingServices(): Promise<CorporateTrainingService[]> {
    return this.deps.cms.getCorporateTrainingServices(true);
  }

  async getPublicPageContent(slug: string): Promise<PageContent | null> {
    return this.deps.cms.getPageContent(slug, true);
  }

  async submitPublicEnquiry(enquiry: Omit<LeadEnquiry, "id" | "submittedAt" | "status">): Promise<LeadEnquiry> {
    return this.deps.cms.submitEnquiry(enquiry);
  }

  async subscribePublicNewsletter(email: string): Promise<NewsletterSubscription> {
    return this.deps.cms.subscribeNewsletter(email);
  }

  // --- Administrative Operations (Full Read & Write Access) ---

  async getAllBanners(): Promise<WebsiteBanner[]> {
    return this.deps.cms.getBanners(false);
  }

  async saveBanners(banners: WebsiteBanner[], userId: string): Promise<WebsiteBanner[]> {
    return this.deps.cms.saveBanners(banners, userId);
  }

  async deleteBanner(id: string, userId: string): Promise<boolean> {
    return this.deps.cms.deleteBanner(id, userId);
  }

  async getAllArticles(): Promise<BlogArticle[]> {
    return this.deps.cms.getArticles(false);
  }

  async getArticleBySlug(slug: string): Promise<BlogArticle | null> {
    return this.deps.cms.getArticleBySlug(slug, false);
  }

  async saveArticle(article: BlogArticle, userId: string): Promise<BlogArticle> {
    return this.deps.cms.saveArticle(article, userId);
  }

  async deleteArticle(id: string, userId: string): Promise<boolean> {
    return this.deps.cms.deleteArticle(id, userId);
  }

  async getAllFaqs(): Promise<FAQItem[]> {
    return this.deps.cms.getFaqs(false);
  }

  async saveFaq(faq: FAQItem, userId: string): Promise<FAQItem> {
    return this.deps.cms.saveFaq(faq, userId);
  }

  async deleteFaq(id: string, userId: string): Promise<boolean> {
    return this.deps.cms.deleteFaq(id, userId);
  }

  async getAllTestimonials(): Promise<TestimonialItem[]> {
    return this.deps.cms.getTestimonials(false);
  }

  async saveTestimonial(testimonial: TestimonialItem, userId: string): Promise<TestimonialItem> {
    return this.deps.cms.saveTestimonial(testimonial, userId);
  }

  async deleteTestimonial(id: string, userId: string): Promise<boolean> {
    return this.deps.cms.deleteTestimonial(id, userId);
  }

  async getAllTrainers(): Promise<TrainerProfile[]> {
    return this.deps.cms.getTrainers(false);
  }

  async saveTrainer(trainer: TrainerProfile, userId: string): Promise<TrainerProfile> {
    return this.deps.cms.saveTrainer(trainer, userId);
  }

  async deleteTrainer(id: string, userId: string): Promise<boolean> {
    return this.deps.cms.deleteTrainer(id, userId);
  }

  async getAllAchievements(): Promise<AchievementItem[]> {
    return this.deps.cms.getAchievements(false);
  }

  async saveAchievement(achievement: AchievementItem, userId: string): Promise<AchievementItem> {
    return this.deps.cms.saveAchievement(achievement, userId);
  }

  async deleteAchievement(id: string, userId: string): Promise<boolean> {
    return this.deps.cms.deleteAchievement(id, userId);
  }

  async getAllCareers(): Promise<CareerOpening[]> {
    return this.deps.cms.getCareers(false);
  }

  async saveCareer(career: CareerOpening, userId: string): Promise<CareerOpening> {
    return this.deps.cms.saveCareer(career, userId);
  }

  async deleteCareer(id: string, userId: string): Promise<boolean> {
    return this.deps.cms.deleteCareer(id, userId);
  }

  async getAllHiringPartners(): Promise<HiringPartner[]> {
    return this.deps.cms.getHiringPartners(false);
  }

  async saveHiringPartner(partner: HiringPartner, userId: string): Promise<HiringPartner> {
    return this.deps.cms.saveHiringPartner(partner, userId);
  }

  async deleteHiringPartner(id: string, userId: string): Promise<boolean> {
    return this.deps.cms.deleteHiringPartner(id, userId);
  }

  async getAllCollegePartners(): Promise<CollegePartner[]> {
    return this.deps.cms.getCollegePartners(false);
  }

  async getCollegePartnerById(id: string): Promise<CollegePartner | null> {
    return this.deps.cms.getCollegePartnerById(id);
  }

  async saveCollegePartner(partner: CollegePartner, userId: string): Promise<CollegePartner> {
    return this.deps.cms.saveCollegePartner(partner, userId);
  }

  async deleteCollegePartner(id: string, userId: string): Promise<boolean> {
    return this.deps.cms.deleteCollegePartner(id, userId);
  }

  async updateCollegePartnerStatus(id: string, status: 'active' | 'inactive' | 'mou_in_progress', userId: string): Promise<CollegePartner> {
    return this.deps.cms.updateCollegePartnerStatus(id, status, userId);
  }

  async getAllCorporateTrainingServices(): Promise<CorporateTrainingService[]> {
    return this.deps.cms.getCorporateTrainingServices(false);
  }

  async saveCorporateTrainingService(service: CorporateTrainingService, userId: string): Promise<CorporateTrainingService> {
    return this.deps.cms.saveCorporateTrainingService(service, userId);
  }

  async deleteCorporateTrainingService(id: string, userId: string): Promise<boolean> {
    return this.deps.cms.deleteCorporateTrainingService(id, userId);
  }

  async updateCorporateTrainingServiceStatus(id: string, isActive: boolean, userId: string): Promise<CorporateTrainingService> {
    return this.deps.cms.updateCorporateTrainingServiceStatus(id, isActive, userId);
  }

  async getPageContent(slug: string): Promise<PageContent | null> {
    return this.deps.cms.getPageContent(slug, false);
  }

  async savePageContent(content: PageContent, userId: string): Promise<PageContent> {
    return this.deps.cms.savePageContent(content, userId);
  }

  async getAllEnquiries(): Promise<LeadEnquiry[]> {
    return this.deps.cms.getEnquiries();
  }

  async updateEnquiryStatus(id: string, status: LeadEnquiry["status"], userId: string): Promise<LeadEnquiry> {
    return this.deps.cms.updateEnquiryStatus(id, status, userId);
  }
}

export const createCmsService = (deps: CmsServiceDeps): CmsService => {
  return new CmsService(deps);
};
