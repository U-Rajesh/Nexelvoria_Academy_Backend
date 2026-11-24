import { CompanyInUseError, CmsRuleError, type CmsRepository } from "./cms.repository";
import { RecordNotFoundError } from "../../repositories/repository.errors";
import { ApiError } from "../../utils/api-error";
import { isEditablePageSlug } from "./cms.rules";
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

export interface CmsServiceDeps {
  cms: CmsRepository;
  /** PUB-006: real courses for trainer links (absent: links cannot be verified and are refused). */
  courses?: { findById(id: string): Promise<{ id: string; title: string; slug: string; status?: string | undefined; isPublished?: boolean | undefined } | null> } | undefined;
}

type CourseLink = { id: string; title: string; slug: string; published: boolean };

/** Repository errors become the API's 404 / 409 / 422 responses. */
async function mapped<T>(label: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof RecordNotFoundError) throw ApiError.notFound(`${label} not found`);
    if (err instanceof CompanyInUseError) throw ApiError.conflict(err.message, "COMPANY_IN_USE");
    if (err instanceof CmsRuleError) {
      if (err.status === 409) throw ApiError.conflict(err.message, err.code);
      throw ApiError.validation([{ field: "body", message: err.message }], err.message);
    }
    throw err;
  }
}

type Enquiry = Omit<LeadEnquiry, "id" | "submittedAt" | "status">;

export class CmsService {
  constructor(private readonly deps: CmsServiceDeps) {}

  // --- Public reads: published / active items only ---
  getPublicBanners = (): Promise<WebsiteBanner[]> => this.deps.cms.getBanners(true);
  getPublicArticles = (): Promise<BlogArticle[]> => this.deps.cms.getArticles(true);
  getPublicArticleBySlug = (slug: string): Promise<BlogArticle | null> => this.deps.cms.getArticleBySlug(slug, true);
  getPublicFaqs = (): Promise<FAQItem[]> => this.deps.cms.getFaqs(true);
  getPublicTestimonials = (): Promise<TestimonialItem[]> => this.deps.cms.getTestimonials(true);
  getPublicTrainers = async (): Promise<TrainerProfile[]> => {
    const trainers = await this.deps.cms.getTrainers(true);
    return Promise.all(trainers.map((t) => this.withCourses(t, true)));
  };

  /** Resolves `courseIds` to current course records; public views keep published courses only. */
  private async withCourses(t: TrainerProfile, publicView: boolean): Promise<TrainerProfile> {
    const { courseIds, ...rest } = t;
    if (!courseIds?.length || !this.deps.courses) return publicView ? rest : t;
    const links = (await Promise.all(courseIds.map((id) => this.lookupCourse(id)))).filter((c): c is CourseLink => c !== null);
    const shown = publicView ? links.filter((c) => c.published) : links;
    return {
      ...(publicView ? rest : t),
      coursesTaught: shown.map((c) => c.title),
      linkedCourses: shown.map(({ id, title, slug }) => ({ id, title, slug })),
    };
  }

  private async lookupCourse(id: string): Promise<CourseLink | null> {
    const c = await this.deps.courses!.findById(id).catch(() => null);
    if (!c) return null;
    const status = String(c.status ?? "").toLowerCase();
    return { id: String(c.id), title: c.title, slug: c.slug, published: c.isPublished === true && status !== "archived" && status !== "inactive" };
  }
  getPublicAchievements = (): Promise<AchievementItem[]> => this.deps.cms.getAchievements(true);
  getPublicCareers = (): Promise<CareerOpening[]> => this.deps.cms.getCareers(true);
  getPublicHiringPartners = (): Promise<HiringPartner[]> => this.deps.cms.getHiringPartners(true);
  getPublicCollegePartners = (): Promise<CollegePartner[]> => this.deps.cms.getCollegePartners(true);
  getPublicCorporateTrainingServices = (): Promise<CorporateTrainingService[]> => this.deps.cms.getCorporateTrainingServices(true);

  /** Only published singleton pages on the allowlist; collection rows are never served as pages. */
  async getPublicPageContent(slug: string): Promise<PageContent | null> {
    if (!isEditablePageSlug(slug)) return null;
    return this.deps.cms.getPageContent(slug, true);
  }

  /** A callback request goes to NXA_CallbackRequests; every other enquiry to NXA_Enquiries. */
  async submitPublicEnquiry(enquiry: Enquiry): Promise<LeadEnquiry | CallbackRequest> {
    if (enquiry.type === "callback") {
      return this.deps.cms.submitCallbackRequest({ name: enquiry.name, phone: enquiry.phone, preferredTimeSlot: enquiry.preferredTimeSlot });
    }
    return this.deps.cms.submitEnquiry(enquiry);
  }

  subscribePublicNewsletter = (email: string): Promise<NewsletterSubscription> => this.deps.cms.subscribeNewsletter(email);

  // --- Admin: full read (including hidden / draft) and audited writes ---
  getAllBanners = (): Promise<WebsiteBanner[]> => this.deps.cms.getBanners(false);
  saveBanners = (banners: WebsiteBanner[], userId: string) => mapped("Banner", () => this.deps.cms.saveBanners(banners, userId));
  deleteBanner = (id: string, userId: string) => mapped("Banner", () => this.deps.cms.deleteBanner(id, userId));

  getAllArticles = (): Promise<BlogArticle[]> => this.deps.cms.getArticles(false);
  getArticleBySlug = (slug: string): Promise<BlogArticle | null> => this.deps.cms.getArticleBySlug(slug, false);
  saveArticle = (article: BlogArticle, userId: string) => mapped("Blog article", () => this.deps.cms.saveArticle(article, userId));
  deleteArticle = (id: string, userId: string) => mapped("Blog article", () => this.deps.cms.deleteArticle(id, userId));

  getAllFaqs = (): Promise<FAQItem[]> => this.deps.cms.getFaqs(false);
  saveFaq = (faq: FAQItem, userId: string) => mapped("FAQ", () => this.deps.cms.saveFaq(faq, userId));
  deleteFaq = (id: string, userId: string) => mapped("FAQ", () => this.deps.cms.deleteFaq(id, userId));

  getAllTestimonials = (): Promise<TestimonialItem[]> => this.deps.cms.getTestimonials(false);
  saveTestimonial = (t: TestimonialItem, userId: string) => mapped("Testimonial", () => this.deps.cms.saveTestimonial(t, userId));
  deleteTestimonial = (id: string, userId: string) => mapped("Testimonial", () => this.deps.cms.deleteTestimonial(id, userId));

  getAllTrainers = async (): Promise<TrainerProfile[]> => {
    const trainers = await this.deps.cms.getTrainers(false);
    return Promise.all(trainers.map((t) => this.withCourses(t, false)));
  };

  /** PUB-006: every linked course must exist; the displayed titles are derived from the linked courses. */
  saveTrainer = async (t: TrainerProfile, userId: string) => {
    const ids = [...new Set(t.courseIds ?? [])];
    let titles: string[] = [];
    if (ids.length) {
      if (!this.deps.courses) throw ApiError.serviceUnavailable("Courses cannot be checked right now; trainer course links were not saved.");
      const found = await Promise.all(ids.map((id) => this.lookupCourse(id)));
      const missing = ids.filter((_, i) => found[i] === null);
      if (missing.length) {
        throw ApiError.validation([{ field: "courseIds", message: `Unknown course id(s): ${missing.join(", ")}` }], "A linked course does not exist.");
      }
      titles = (found as CourseLink[]).map((c) => c.title);
    }
    // The stored profile keeps ids only; titles are derived (free text is no longer the link).
    const { linkedCourses: _ignored, ...profile } = t;
    const saved = await mapped("Trainer profile", () => this.deps.cms.saveTrainer({ ...profile, courseIds: ids, coursesTaught: titles }, userId));
    return this.withCourses(saved, false);
  };
  deleteTrainer = (id: string, userId: string) => mapped("Trainer profile", () => this.deps.cms.deleteTrainer(id, userId));

  getAllAchievements = (): Promise<AchievementItem[]> => this.deps.cms.getAchievements(false);
  saveAchievement = (a: AchievementItem, userId: string) => mapped("Achievement", () => this.deps.cms.saveAchievement(a, userId));
  deleteAchievement = (id: string, userId: string) => mapped("Achievement", () => this.deps.cms.deleteAchievement(id, userId));

  getAllCareers = (): Promise<CareerOpening[]> => this.deps.cms.getCareers(false);
  saveCareer = (c: CareerOpening, userId: string) => mapped("Career opening", () => this.deps.cms.saveCareer(c, userId));
  deleteCareer = (id: string, userId: string) => mapped("Career opening", () => this.deps.cms.deleteCareer(id, userId));

  getAllHiringPartners = (): Promise<HiringPartner[]> => this.deps.cms.getHiringPartners(false);
  /** Always creates: an id supplied by the client is never used. */
  createHiringPartner = (partner: HiringPartner, userId: string) => mapped("Hiring partner", () => this.deps.cms.saveHiringPartner({ ...partner, id: "" }, userId));
  /** Updates only the existing company with this id (numeric, validated by the route). */
  updateHiringPartner = (id: string, partner: HiringPartner, userId: string) => mapped("Hiring partner", () => this.deps.cms.saveHiringPartner({ ...partner, id }, userId));
  deleteHiringPartner = (id: string, userId: string) => mapped("Hiring partner", () => this.deps.cms.deleteHiringPartner(id, userId));

  getAllCollegePartners = (): Promise<CollegePartner[]> => this.deps.cms.getCollegePartners(false);
  getCollegePartnerById = (id: string): Promise<CollegePartner | null> => this.deps.cms.getCollegePartnerById(id);
  saveCollegePartner = (p: CollegePartner, userId: string) => mapped("College partner", () => this.deps.cms.saveCollegePartner(p, userId));
  deleteCollegePartner = (id: string, userId: string) => mapped("College partner", () => this.deps.cms.deleteCollegePartner(id, userId));
  updateCollegePartnerStatus = (id: string, status: CollegePartner["status"], userId: string) =>
    mapped("College partner", () => this.deps.cms.updateCollegePartnerStatus(id, status, userId));

  getAllCorporateTrainingServices = (): Promise<CorporateTrainingService[]> => this.deps.cms.getCorporateTrainingServices(false);
  saveCorporateTrainingService = (s: CorporateTrainingService, userId: string) =>
    mapped("Corporate training service", () => this.deps.cms.saveCorporateTrainingService(s, userId));
  deleteCorporateTrainingService = (id: string, userId: string) =>
    mapped("Corporate training service", () => this.deps.cms.deleteCorporateTrainingService(id, userId));
  updateCorporateTrainingServiceStatus = (id: string, isActive: boolean, userId: string) =>
    mapped("Corporate training service", () => this.deps.cms.updateCorporateTrainingServiceStatus(id, isActive, userId));
  reorderCorporateTrainingServices = (ids: string[], userId: string) =>
    mapped("Corporate training service", () => this.deps.cms.reorderCorporateTrainingServices(ids, userId));

  private assertEditableSlug(slug: string): void {
    if (!isEditablePageSlug(slug)) throw ApiError.notFound(`Page content '${slug}' is not editable here`);
  }

  async getPageContent(slug: string): Promise<PageContent | null> {
    this.assertEditableSlug(slug);
    return this.deps.cms.getPageContent(slug, false);
  }

  async savePageContent(content: PageContent, userId: string): Promise<PageContent> {
    this.assertEditableSlug(content.slug);
    return mapped("Page content", () => this.deps.cms.savePageContent(content, userId));
  }

  getAllEnquiries = (): Promise<LeadEnquiry[]> => this.deps.cms.getEnquiries();
  updateEnquiryStatus = (id: string, status: LeadEnquiry["status"], userId: string) => mapped("Enquiry", () => this.deps.cms.updateEnquiryStatus(id, status, userId));
  getAllCallbackRequests = (): Promise<CallbackRequest[]> => this.deps.cms.getCallbackRequests();
}

export const createCmsService = (deps: CmsServiceDeps): CmsService => new CmsService(deps);
