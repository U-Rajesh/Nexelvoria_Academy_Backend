import type { CmsRepository } from "../../src/modules/cms/cms.repository";
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
} from "../../src/modules/cms/cms.types";

export class InMemoryCmsRepository implements CmsRepository {
  banners: WebsiteBanner[] = [];
  articles: BlogArticle[] = [];
  faqs: FAQItem[] = [];
  testimonials: TestimonialItem[] = [];
  trainers: TrainerProfile[] = [];
  achievements: AchievementItem[] = [];
  careers: CareerOpening[] = [];
  partners: HiringPartner[] = [];
  collegePartners: CollegePartner[] = [];
  corporateServices: CorporateTrainingService[] = [];
  pageContent: Map<string, PageContent> = new Map();
  enquiries: LeadEnquiry[] = [];
  subscribers: NewsletterSubscription[] = [];

  // Banners
  async getBanners(onlyActive = false): Promise<WebsiteBanner[]> {
    return onlyActive ? this.banners.filter((b) => b.isActive) : [...this.banners];
  }

  async saveBanners(banners: WebsiteBanner[]): Promise<WebsiteBanner[]> {
    this.banners = [...banners];
    return [...this.banners];
  }

  async deleteBanner(id: string): Promise<boolean> {
    this.banners = this.banners.filter((b) => b.id !== id);
    return true;
  }

  // Articles
  async getArticles(onlyPublished = false): Promise<BlogArticle[]> {
    return onlyPublished ? this.articles.filter((a) => a.isPublished) : [...this.articles];
  }

  async getArticleBySlug(slug: string, onlyPublished = false): Promise<BlogArticle | null> {
    const article = this.articles.find((a) => a.slug === slug);
    if (!article) return null;
    if (onlyPublished && !article.isPublished) return null;
    return article;
  }

  async saveArticle(article: BlogArticle): Promise<BlogArticle> {
    const targetId = article.id || `art-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const prepared: BlogArticle = { ...article, id: targetId };
    const idx = this.articles.findIndex((a) => a.id === targetId || a.slug === article.slug);
    if (idx >= 0) {
      this.articles[idx] = prepared;
    } else {
      this.articles.unshift(prepared);
    }
    return prepared;
  }

  async deleteArticle(id: string): Promise<boolean> {
    this.articles = this.articles.filter((a) => a.id !== id);
    return true;
  }

  // FAQs
  async getFaqs(onlyActive = false): Promise<FAQItem[]> {
    const faqs = onlyActive ? this.faqs.filter((f) => f.isActive) : [...this.faqs];
    return faqs.sort((a, b) => a.order - b.order);
  }

  async saveFaq(faq: FAQItem): Promise<FAQItem> {
    const targetId = faq.id || `faq-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const prepared: FAQItem = { ...faq, id: targetId };
    const idx = this.faqs.findIndex((f) => f.id === targetId);
    if (idx >= 0) {
      this.faqs[idx] = prepared;
    } else {
      this.faqs.push(prepared);
    }
    return prepared;
  }

  async deleteFaq(id: string): Promise<boolean> {
    this.faqs = this.faqs.filter((f) => f.id !== id);
    return true;
  }

  // Testimonials
  async getTestimonials(onlyPublished = false): Promise<TestimonialItem[]> {
    return onlyPublished ? this.testimonials.filter((t) => t.isPublished) : [...this.testimonials];
  }

  async saveTestimonial(testimonial: TestimonialItem): Promise<TestimonialItem> {
    const targetId = testimonial.id || `tst-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const prepared: TestimonialItem = { ...testimonial, id: targetId };
    const idx = this.testimonials.findIndex((t) => t.id === targetId);
    if (idx >= 0) {
      this.testimonials[idx] = prepared;
    } else {
      this.testimonials.unshift(prepared);
    }
    return prepared;
  }

  async deleteTestimonial(id: string): Promise<boolean> {
    this.testimonials = this.testimonials.filter((t) => t.id !== id);
    return true;
  }

  // Trainers
  async getTrainers(onlyActive = false): Promise<TrainerProfile[]> {
    return onlyActive ? this.trainers.filter((t) => t.isActive) : [...this.trainers];
  }

  async saveTrainer(trainer: TrainerProfile): Promise<TrainerProfile> {
    const targetId = trainer.id || `trn-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const prepared: TrainerProfile = { ...trainer, id: targetId };
    const idx = this.trainers.findIndex((t) => t.id === targetId);
    if (idx >= 0) {
      this.trainers[idx] = prepared;
    } else {
      this.trainers.push(prepared);
    }
    return prepared;
  }

  async deleteTrainer(id: string): Promise<boolean> {
    this.trainers = this.trainers.filter((t) => t.id !== id);
    return true;
  }

  // Achievements
  async getAchievements(onlyActive = false): Promise<AchievementItem[]> {
    return onlyActive ? this.achievements.filter((a) => a.isActive) : [...this.achievements];
  }

  async saveAchievement(achievement: AchievementItem): Promise<AchievementItem> {
    const targetId = achievement.id || `ach-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const prepared: AchievementItem = { ...achievement, id: targetId };
    const idx = this.achievements.findIndex((a) => a.id === targetId);
    if (idx >= 0) {
      this.achievements[idx] = prepared;
    } else {
      this.achievements.push(prepared);
    }
    return prepared;
  }

  async deleteAchievement(id: string): Promise<boolean> {
    this.achievements = this.achievements.filter((a) => a.id !== id);
    return true;
  }

  // Careers
  async getCareers(onlyActive = false): Promise<CareerOpening[]> {
    return onlyActive ? this.careers.filter((c) => c.isActive) : [...this.careers];
  }

  async saveCareer(career: CareerOpening): Promise<CareerOpening> {
    const targetId = career.id || `car-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const prepared: CareerOpening = { ...career, id: targetId };
    const idx = this.careers.findIndex((c) => c.id === targetId);
    if (idx >= 0) {
      this.careers[idx] = prepared;
    } else {
      this.careers.push(prepared);
    }
    return prepared;
  }

  async deleteCareer(id: string): Promise<boolean> {
    this.careers = this.careers.filter((c) => c.id !== id);
    return true;
  }

  // Hiring Partners
  async getHiringPartners(onlyActive = false): Promise<HiringPartner[]> {
    return onlyActive ? this.partners.filter((p) => p.isActive) : [...this.partners];
  }

  async saveHiringPartner(partner: HiringPartner): Promise<HiringPartner> {
    const targetId = partner.id || `prt-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const prepared: HiringPartner = { ...partner, id: targetId };
    const idx = this.partners.findIndex((p) => p.id === targetId);
    if (idx >= 0) {
      this.partners[idx] = prepared;
    } else {
      this.partners.push(prepared);
    }
    return prepared;
  }

  async deleteHiringPartner(id: string): Promise<boolean> {
    this.partners = this.partners.filter((p) => p.id !== id);
    return true;
  }

  // College Partners
  async getCollegePartners(onlyActive = false): Promise<CollegePartner[]> {
    return onlyActive ? this.collegePartners.filter((c) => c.status === "active") : [...this.collegePartners];
  }

  async getCollegePartnerById(id: string): Promise<CollegePartner | null> {
    return this.collegePartners.find((c) => c.id === id) || null;
  }

  async saveCollegePartner(partner: CollegePartner): Promise<CollegePartner> {
    const targetId = partner.id || `col-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const prepared: CollegePartner = { ...partner, id: targetId };
    const idx = this.collegePartners.findIndex((c) => c.id === targetId);
    if (idx >= 0) {
      this.collegePartners[idx] = prepared;
    } else {
      this.collegePartners.unshift(prepared);
    }
    return prepared;
  }

  async deleteCollegePartner(id: string): Promise<boolean> {
    this.collegePartners = this.collegePartners.filter((c) => c.id !== id);
    return true;
  }

  async updateCollegePartnerStatus(id: string, status: 'active' | 'inactive' | 'mou_in_progress'): Promise<CollegePartner> {
    const partner = this.collegePartners.find((c) => c.id === id);
    if (!partner) throw new Error("College partner not found");
    partner.status = status;
    return partner;
  }

  // Corporate Training Services
  async getCorporateTrainingServices(onlyActive = false): Promise<CorporateTrainingService[]> {
    return onlyActive ? this.corporateServices.filter((s) => s.isActive) : [...this.corporateServices];
  }

  async saveCorporateTrainingService(service: CorporateTrainingService): Promise<CorporateTrainingService> {
    const targetId = service.id || `corp-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const prepared: CorporateTrainingService = { ...service, id: targetId };
    const idx = this.corporateServices.findIndex((s) => s.id === targetId);
    if (idx >= 0) {
      this.corporateServices[idx] = prepared;
    } else {
      this.corporateServices.push(prepared);
    }
    return prepared;
  }

  async deleteCorporateTrainingService(id: string): Promise<boolean> {
    this.corporateServices = this.corporateServices.filter((s) => s.id !== id);
    return true;
  }

  async updateCorporateTrainingServiceStatus(id: string, isActive: boolean): Promise<CorporateTrainingService> {
    const service = this.corporateServices.find((s) => s.id === id);
    if (!service) throw new Error("Corporate training service not found");
    service.isActive = isActive;
    return service;
  }

  // Page Content
  async getPageContent(slug: string, onlyPublished = false): Promise<PageContent | null> {
    const page = this.pageContent.get(slug);
    if (!page) return null;
    if (onlyPublished && !page.isPublished) return null;
    return page;
  }

  async savePageContent(content: PageContent): Promise<PageContent> {
    this.pageContent.set(content.slug, content);
    return content;
  }

  // Enquiries
  async submitEnquiry(enquiry: Omit<LeadEnquiry, "id" | "submittedAt" | "status">): Promise<LeadEnquiry> {
    const newEnquiry: LeadEnquiry = {
      ...enquiry,
      id: `enq-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      submittedAt: new Date().toISOString(),
      status: "new",
    };
    this.enquiries.unshift(newEnquiry);
    return newEnquiry;
  }

  async getEnquiries(): Promise<LeadEnquiry[]> {
    return [...this.enquiries];
  }

  async updateEnquiryStatus(id: string, status: LeadEnquiry["status"]): Promise<LeadEnquiry> {
    const enquiry = this.enquiries.find((e) => e.id === id);
    if (!enquiry) throw new Error("Enquiry not found");
    enquiry.status = status;
    return enquiry;
  }

  // Newsletter
  async subscribeNewsletter(email: string): Promise<NewsletterSubscription> {
    const existing = this.subscribers.find((s) => s.email.toLowerCase() === email.toLowerCase());
    if (existing) return existing;
    const newSub: NewsletterSubscription = {
      id: `sub-${Date.now()}`,
      email,
      subscribedAt: new Date().toISOString(),
      isActive: true,
    };
    this.subscribers.push(newSub);
    return newSub;
  }
}
