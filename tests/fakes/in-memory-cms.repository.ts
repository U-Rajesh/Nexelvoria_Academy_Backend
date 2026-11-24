import { CompanyInUseError, CmsRuleError, CMS_COLLECTIONS, type CmsCollectionKey, type CmsRepository } from "../../src/modules/cms/cms.repository";
import { applyCollectionRules, describeChange, sortCollection, sortFaqs, type CmsAudit } from "../../src/modules/cms/cms.rules";
import { RecordNotFoundError } from "../../src/repositories/repository.errors";
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
} from "../../src/modules/cms/cms.types";

export interface FakeCmsAudit extends CmsAudit {
  actorUserId: string;
  moduleCode: "WEBSITE_CMS";
}

const isId = (id: string | undefined): id is string => typeof id === "string" && /^\d{1,19}$/.test(id);

/**
 * In-memory CMS store mirroring the SQL Server adapter: shared approved rules
 * (start hidden, ordering), an audit entry per real change, nothing written or
 * audited for a no-op, RecordNotFoundError for unknown ids, and atomic
 * change + audit (set `failAudit` to make the audit write fail: the change is
 * then not applied, like a rolled-back transaction).
 */
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
  callbacks: CallbackRequest[] = [];
  subscribers: NewsletterSubscription[] = [];

  audits: FakeCmsAudit[] = [];
  /** When true the audit write fails and the whole change is discarded. */
  failAudit = false;
  /** Company ids still referenced by jobs / placement records (delete is refused). */
  referencedCompanyIds = new Set<string>();

  private seq = 1000;
  private partnerSeq = 500;
  private nextId = (): string => String(++this.seq);

  /** Applies `apply` only after the audit entry was "written" (atomic). */
  private commit(userId: string, audit: CmsAudit, apply: () => void): void {
    if (this.failAudit) throw new Error("audit write failed");
    this.audits.push({ ...audit, actorUserId: userId, moduleCode: "WEBSITE_CMS" });
    apply();
  }

  private field<K extends CmsCollectionKey>(key: K): { id: string }[] {
    const map: Record<CmsCollectionKey, { id: string }[]> = {
      banners: this.banners,
      testimonials: this.testimonials,
      trainers: this.trainers,
      achievements: this.achievements,
      careers: this.careers,
      corporate: this.corporateServices,
    };
    return map[key];
  }

  private assign(key: CmsCollectionKey, items: { id: string }[]): void {
    const sorted = sortCollection(key, items);
    if (key === "banners") this.banners = sorted as WebsiteBanner[];
    else if (key === "testimonials") this.testimonials = sorted as TestimonialItem[];
    else if (key === "trainers") this.trainers = sorted as TrainerProfile[];
    else if (key === "achievements") this.achievements = sorted as AchievementItem[];
    else if (key === "careers") this.careers = sorted as CareerOpening[];
    else this.corporateServices = sorted as CorporateTrainingService[];
  }

  private saveItem<T extends { id: string }>(key: CmsCollectionKey, item: T, userId: string, prefix: string): T {
    const items = this.field(key) as T[];
    const idx = item.id ? items.findIndex((x) => x.id === item.id) : -1;
    if (item.id && idx === -1) throw new RecordNotFoundError(CMS_COLLECTIONS[key].entityName, item.id);
    const before = idx >= 0 ? items[idx] : undefined;
    const prepared = applyCollectionRules(key, { ...item, id: before ? item.id : `${prefix}-${this.nextId()}` }, before);
    const change = describeChange(CMS_COLLECTIONS[key].entityName, CMS_COLLECTIONS[key].visibilityField, before, prepared);
    if (!change) return before as T;
    this.commit(userId, change, () => this.assign(key, before ? items.map((x, i) => (i === idx ? prepared : x)) : [...items, prepared]));
    return prepared;
  }

  private deleteItem(key: CmsCollectionKey, id: string, userId: string): boolean {
    const items = this.field(key);
    if (!items.some((x) => x.id === id)) throw new RecordNotFoundError(CMS_COLLECTIONS[key].entityName, id);
    this.commit(userId, { action: "CMS_DELETE", entityName: CMS_COLLECTIONS[key].entityName, entityId: id }, () =>
      this.assign(key, items.filter((x) => x.id !== id)),
    );
    return true;
  }

  // Banners
  async getBanners(onlyActive = false): Promise<WebsiteBanner[]> {
    return onlyActive ? this.banners.filter((b) => b.isActive) : [...this.banners];
  }
  async saveBanners(banners: WebsiteBanner[], userId: string): Promise<WebsiteBanner[]> {
    const known = new Set(this.banners.map((b) => b.id));
    const unknown = banners.find((b) => b.id && !known.has(b.id));
    if (unknown) throw new RecordNotFoundError("Banner", unknown.id);
    const next = banners.map((b) => ({ ...b, id: b.id || `banner-${this.nextId()}` }));
    if (JSON.stringify(next) === JSON.stringify(this.banners)) return [...this.banners];
    this.commit(userId, { action: "CMS_UPDATE", entityName: "BannerSet", entityId: CMS_COLLECTIONS.banners.slug }, () => {
      this.banners = next;
    });
    return [...this.banners];
  }
  async deleteBanner(id: string, userId: string): Promise<boolean> {
    return this.deleteItem("banners", id, userId);
  }

  // Articles
  async getArticles(onlyPublished = false): Promise<BlogArticle[]> {
    return onlyPublished ? this.articles.filter((a) => a.isPublished) : [...this.articles];
  }
  async getArticleBySlug(slug: string, onlyPublished = false): Promise<BlogArticle | null> {
    const article = this.articles.find((a) => a.slug === slug);
    if (!article || (onlyPublished && !article.isPublished)) return null;
    return article;
  }
  async saveArticle(article: BlogArticle, userId: string): Promise<BlogArticle> {
    if (article.id && !isId(article.id)) throw new RecordNotFoundError("BlogArticle", article.id);
    if (this.articles.some((a) => a.slug === article.slug && a.id !== article.id)) {
      throw new CmsRuleError("SLUG_TAKEN", "Another article already uses this slug.", 409);
    }
    const idx = article.id ? this.articles.findIndex((a) => a.id === article.id) : -1;
    if (article.id && idx === -1) throw new RecordNotFoundError("BlogArticle", article.id);
    const before = idx >= 0 ? this.articles[idx] : undefined;
    const prepared: BlogArticle = { ...article, id: before ? article.id : this.nextId(), date: before?.date ?? new Date().toISOString() };
    const change = describeChange("BlogArticle", "isPublished", before && { ...before, date: undefined }, { ...prepared, date: undefined });
    if (!change) return before!;
    this.commit(userId, change, () => {
      if (before) this.articles[idx] = prepared;
      else this.articles.unshift(prepared);
    });
    return prepared;
  }
  async deleteArticle(id: string, userId: string): Promise<boolean> {
    if (!this.articles.some((a) => a.id === id)) throw new RecordNotFoundError("BlogArticle", id);
    this.commit(userId, { action: "CMS_DELETE", entityName: "BlogArticle", entityId: id }, () => {
      this.articles = this.articles.filter((a) => a.id !== id);
    });
    return true;
  }

  // FAQs (NXA_Faqs has no category column: category is not stored)
  async getFaqs(onlyActive = false): Promise<FAQItem[]> {
    return sortFaqs(onlyActive ? this.faqs.filter((f) => f.isActive) : [...this.faqs]);
  }
  async saveFaq(faq: FAQItem, userId: string): Promise<FAQItem> {
    if (faq.id && !isId(faq.id)) throw new RecordNotFoundError("Faq", faq.id);
    const idx = faq.id ? this.faqs.findIndex((f) => f.id === faq.id) : -1;
    if (faq.id && idx === -1) throw new RecordNotFoundError("Faq", faq.id);
    const before = idx >= 0 ? this.faqs[idx] : undefined;
    // Approved rule: a new FAQ starts hidden.
    const prepared: FAQItem = { ...faq, category: "", id: before ? faq.id : this.nextId(), ...(before ? {} : { isActive: false }) };
    const change = describeChange("Faq", "isActive", before, prepared);
    if (!change) return before!;
    this.commit(userId, change, () => {
      if (before) this.faqs[idx] = prepared;
      else this.faqs.push(prepared);
    });
    return prepared;
  }
  async deleteFaq(id: string, userId: string): Promise<boolean> {
    if (!this.faqs.some((f) => f.id === id)) throw new RecordNotFoundError("Faq", id);
    this.commit(userId, { action: "CMS_DELETE", entityName: "Faq", entityId: id }, () => {
      this.faqs = this.faqs.filter((f) => f.id !== id);
    });
    return true;
  }

  // JSON collections
  async getTestimonials(onlyPublished = false): Promise<TestimonialItem[]> {
    const all = sortCollection("testimonials", this.testimonials);
    return onlyPublished ? all.filter((t) => t.isPublished) : all;
  }
  async saveTestimonial(t: TestimonialItem, userId: string): Promise<TestimonialItem> {
    return this.saveItem("testimonials", t, userId, "testi");
  }
  async deleteTestimonial(id: string, userId: string): Promise<boolean> {
    return this.deleteItem("testimonials", id, userId);
  }

  async getTrainers(onlyActive = false): Promise<TrainerProfile[]> {
    const all = sortCollection("trainers", this.trainers);
    return onlyActive ? all.filter((t) => t.isActive) : all;
  }
  async saveTrainer(t: TrainerProfile, userId: string): Promise<TrainerProfile> {
    return this.saveItem("trainers", t, userId, "trn");
  }
  async deleteTrainer(id: string, userId: string): Promise<boolean> {
    return this.deleteItem("trainers", id, userId);
  }

  async getAchievements(onlyActive = false): Promise<AchievementItem[]> {
    const all = sortCollection("achievements", this.achievements);
    return onlyActive ? all.filter((a) => a.isActive) : all;
  }
  async saveAchievement(a: AchievementItem, userId: string): Promise<AchievementItem> {
    return this.saveItem("achievements", a, userId, "ach");
  }
  async deleteAchievement(id: string, userId: string): Promise<boolean> {
    return this.deleteItem("achievements", id, userId);
  }

  async getCareers(onlyActive = false): Promise<CareerOpening[]> {
    return onlyActive ? this.careers.filter((c) => c.isActive) : [...this.careers];
  }
  async saveCareer(c: CareerOpening, userId: string): Promise<CareerOpening> {
    return this.saveItem("careers", c, userId, "career");
  }
  async deleteCareer(id: string, userId: string): Promise<boolean> {
    return this.deleteItem("careers", id, userId);
  }

  async getCorporateTrainingServices(onlyActive = false): Promise<CorporateTrainingService[]> {
    const all = sortCollection("corporate", this.corporateServices);
    return onlyActive ? all.filter((s) => s.isActive) : all;
  }
  async saveCorporateTrainingService(s: CorporateTrainingService, userId: string): Promise<CorporateTrainingService> {
    return this.saveItem("corporate", s, userId, "corp");
  }
  async deleteCorporateTrainingService(id: string, userId: string): Promise<boolean> {
    return this.deleteItem("corporate", id, userId);
  }
  async updateCorporateTrainingServiceStatus(id: string, isActive: boolean, userId: string): Promise<CorporateTrainingService> {
    const current = this.corporateServices.find((s) => s.id === id);
    if (!current) throw new RecordNotFoundError("CorporateTrainingService", id);
    return this.saveItem("corporate", { ...current, isActive }, userId, "corp");
  }
  async reorderCorporateTrainingServices(ids: string[], userId: string): Promise<CorporateTrainingService[]> {
    const items = this.corporateServices;
    if (ids.length !== items.length || new Set(ids).size !== ids.length || ids.some((id) => !items.some((s) => s.id === id))) {
      throw new CmsRuleError("REORDER_MISMATCH", "The new order must list every service exactly once.");
    }
    const next = ids.map((id, i) => ({ ...items.find((s) => s.id === id)!, order: i + 1 }));
    if (next.every((s) => items.find((x) => x.id === s.id)!.order === s.order)) return sortCollection("corporate", items);
    this.commit(userId, { action: "CMS_REORDER", entityName: "CorporateTrainingService", entityId: CMS_COLLECTIONS.corporate.slug, newValues: { order: ids } }, () =>
      this.assign("corporate", next),
    );
    return [...this.corporateServices];
  }

  // Hiring partners (NXA_Companies fields only)
  async getHiringPartners(onlyActive = false): Promise<HiringPartner[]> {
    return onlyActive ? this.partners.filter((p) => p.isActive) : [...this.partners];
  }
  async saveHiringPartner(partner: HiringPartner, userId: string): Promise<HiringPartner> {
    if (partner.id && !isId(partner.id)) throw new RecordNotFoundError("hiring partner", partner.id);
    const idx = partner.id ? this.partners.findIndex((p) => p.id === partner.id) : -1;
    if (partner.id && idx === -1) throw new RecordNotFoundError("hiring partner", partner.id);
    const before = idx >= 0 ? this.partners[idx] : undefined;
    const prepared: HiringPartner = {
      id: before ? partner.id : String(++this.partnerSeq),
      name: partner.name,
      ...(partner.industry ? { industry: partner.industry } : {}),
      ...(partner.websiteUrl ? { websiteUrl: partner.websiteUrl } : {}),
      placementsCount: before?.placementsCount ?? 0,
      isActive: partner.isActive,
    };
    const change = describeChange("HiringPartner", "isActive", before, prepared);
    if (!change) return before!;
    this.commit(userId, change, () => {
      if (before) this.partners[idx] = prepared;
      else this.partners.push(prepared);
    });
    return prepared;
  }
  async deleteHiringPartner(id: string, userId: string): Promise<boolean> {
    if (!this.partners.some((p) => p.id === id)) throw new RecordNotFoundError("hiring partner", id);
    if (this.referencedCompanyIds.has(id)) throw new CompanyInUseError(id);
    this.commit(userId, { action: "CMS_DELETE", entityName: "HiringPartner", entityId: id }, () => {
      this.partners = this.partners.filter((p) => p.id !== id);
    });
    return true;
  }

  // College partners
  async getCollegePartners(onlyActive = false): Promise<CollegePartner[]> {
    return onlyActive ? this.collegePartners.filter((c) => c.status === "active") : [...this.collegePartners];
  }
  async getCollegePartnerById(id: string): Promise<CollegePartner | null> {
    return this.collegePartners.find((c) => c.id === id) || null;
  }
  async saveCollegePartner(partner: CollegePartner, userId: string): Promise<CollegePartner> {
    if (partner.id && !isId(partner.id)) throw new RecordNotFoundError("CollegePartner", partner.id);
    const idx = partner.id ? this.collegePartners.findIndex((c) => c.id === partner.id) : -1;
    if (partner.id && idx === -1) throw new RecordNotFoundError("CollegePartner", partner.id);
    const before = idx >= 0 ? this.collegePartners[idx] : undefined;
    const prepared: CollegePartner = { ...partner, id: before ? partner.id : this.nextId(), createdAt: before?.createdAt ?? new Date().toISOString() };
    const change = describeChange("CollegePartner", "status", before, prepared);
    if (!change) return before!;
    this.commit(userId, change, () => {
      if (before) this.collegePartners[idx] = prepared;
      else this.collegePartners.unshift(prepared);
    });
    return prepared;
  }
  async deleteCollegePartner(id: string, userId: string): Promise<boolean> {
    if (!this.collegePartners.some((c) => c.id === id)) throw new RecordNotFoundError("CollegePartner", id);
    this.commit(userId, { action: "CMS_DELETE", entityName: "CollegePartner", entityId: id }, () => {
      this.collegePartners = this.collegePartners.filter((c) => c.id !== id);
    });
    return true;
  }
  async updateCollegePartnerStatus(id: string, status: CollegePartner["status"], userId: string): Promise<CollegePartner> {
    const current = this.collegePartners.find((c) => c.id === id);
    if (!current) throw new RecordNotFoundError("CollegePartner", id);
    return this.saveCollegePartner({ ...current, status }, userId);
  }

  // Page content
  async getPageContent(slug: string, onlyPublished = false): Promise<PageContent | null> {
    const page = this.pageContent.get(slug);
    if (!page || (onlyPublished && !page.isPublished)) return null;
    return page;
  }
  async savePageContent(content: PageContent, userId: string): Promise<PageContent> {
    const before = this.pageContent.get(content.slug);
    const change = describeChange(
      "PageContent",
      "isPublished",
      before && { id: content.slug, title: before.title, content: before.content, isPublished: before.isPublished },
      { id: content.slug, title: content.title, content: content.content, isPublished: content.isPublished },
    );
    if (!change) return before!;
    const saved: PageContent = { ...content, updatedAt: new Date().toISOString(), updatedByUserId: userId };
    this.commit(userId, { ...change, oldValues: undefined }, () => this.pageContent.set(content.slug, saved));
    return saved;
  }

  // Enquiries and callbacks (public submissions are not audited: no actor)
  async submitEnquiry(enquiry: Omit<LeadEnquiry, "id" | "submittedAt" | "status">): Promise<LeadEnquiry> {
    const created: LeadEnquiry = { ...enquiry, id: this.nextId(), submittedAt: new Date().toISOString(), status: "new" };
    this.enquiries.unshift(created);
    return created;
  }
  async getEnquiries(): Promise<LeadEnquiry[]> {
    return [...this.enquiries];
  }
  async updateEnquiryStatus(id: string, status: LeadEnquiry["status"], userId: string): Promise<LeadEnquiry> {
    const enquiry = this.enquiries.find((e) => e.id === id);
    if (!enquiry) throw new RecordNotFoundError("Enquiry", id);
    if (enquiry.status === status) return enquiry;
    this.commit(userId, { action: "CMS_ENQUIRY_STATUS", entityName: "Enquiry", entityId: id, oldValues: { status: enquiry.status }, newValues: { status } }, () => {
      enquiry.status = status;
    });
    return enquiry;
  }
  async submitCallbackRequest(input: { name: string; phone: string; preferredTimeSlot?: string | undefined }): Promise<CallbackRequest> {
    const created: CallbackRequest = {
      id: this.nextId(),
      name: input.name,
      phone: input.phone,
      ...(input.preferredTimeSlot ? { preferredTimeSlot: input.preferredTimeSlot } : {}),
      requestedAt: new Date().toISOString(),
    };
    this.callbacks.unshift(created);
    return created;
  }
  async getCallbackRequests(): Promise<CallbackRequest[]> {
    return [...this.callbacks];
  }

  // Newsletter
  async subscribeNewsletter(email: string): Promise<NewsletterSubscription> {
    const existing = this.subscribers.find((s) => s.email.toLowerCase() === email.toLowerCase());
    if (existing) return existing;
    const sub: NewsletterSubscription = { id: `sub-${this.nextId()}`, email, subscribedAt: new Date().toISOString(), isActive: true };
    this.subscribers.push(sub);
    return sub;
  }
}
