import type { Request, Response } from "express";
import { ApiError } from "../../utils/api-error";
import { HttpStatus } from "../../utils/http-status";
import { sendSuccess } from "../../utils/send";
import type { CmsService } from "./cms.service";

const sendCreated = (res: Response, options: Parameters<typeof sendSuccess>[1]): void => {
  sendSuccess(res, { status: HttpStatus.CREATED, ...options });
};

const actorId = (req: Request): string => {
  const id = req.principal?.id;
  if (!id) {
    throw ApiError.unauthorized("Authentication required");
  }
  return id;
};

/**
 * POST creates (any id in the body is ignored); PUT /:id updates exactly the
 * record in the URL and refuses a body id that names a different record.
 */
const withRouteId = <T>(req: Request): T => {
  const body = req.body as Record<string, unknown>;
  const urlId = req.params.id as string | undefined;
  if (urlId === undefined) return { ...body, id: "" } as T;
  if (body.id !== undefined && body.id !== "" && String(body.id) !== urlId) {
    throw ApiError.validation([{ field: "id", message: "The id in the body does not match the id in the URL." }], "The id in the body does not match the id in the URL.");
  }
  return { ...body, id: urlId } as T;
};

export class CmsController {
  constructor(private readonly cmsService: CmsService) {}

  // --- Public Handlers ---

  getPublicBanners = async (_req: Request, res: Response): Promise<void> => {
    const banners = await this.cmsService.getPublicBanners();
    sendSuccess(res, { data: banners });
  };

  getPublicArticles = async (_req: Request, res: Response): Promise<void> => {
    const articles = await this.cmsService.getPublicArticles();
    sendSuccess(res, { data: articles });
  };

  getPublicArticleBySlug = async (req: Request, res: Response): Promise<void> => {
    const slug = req.params.slug as string;
    const article = await this.cmsService.getPublicArticleBySlug(slug);
    if (!article) {
      throw ApiError.notFound(`Article with slug '${slug}' not found`);
    }
    sendSuccess(res, { data: article });
  };

  getPublicFaqs = async (_req: Request, res: Response): Promise<void> => {
    const faqs = await this.cmsService.getPublicFaqs();
    sendSuccess(res, { data: faqs });
  };

  getPublicTestimonials = async (_req: Request, res: Response): Promise<void> => {
    const testimonials = await this.cmsService.getPublicTestimonials();
    sendSuccess(res, { data: testimonials });
  };

  getPublicTrainers = async (_req: Request, res: Response): Promise<void> => {
    const trainers = await this.cmsService.getPublicTrainers();
    sendSuccess(res, { data: trainers });
  };

  getPublicAchievements = async (_req: Request, res: Response): Promise<void> => {
    const achievements = await this.cmsService.getPublicAchievements();
    sendSuccess(res, { data: achievements });
  };

  getPublicCareers = async (_req: Request, res: Response): Promise<void> => {
    const careers = await this.cmsService.getPublicCareers();
    sendSuccess(res, { data: careers });
  };

  getPublicHiringPartners = async (_req: Request, res: Response): Promise<void> => {
    const partners = await this.cmsService.getPublicHiringPartners();
    sendSuccess(res, { data: partners });
  };

  getPublicCollegePartners = async (_req: Request, res: Response): Promise<void> => {
    const partners = await this.cmsService.getPublicCollegePartners();
    sendSuccess(res, { data: partners });
  };

  getPublicCorporateTrainingServices = async (_req: Request, res: Response): Promise<void> => {
    const services = await this.cmsService.getPublicCorporateTrainingServices();
    sendSuccess(res, { data: services });
  };

  getPublicPageContent = async (req: Request, res: Response): Promise<void> => {
    const slug = req.params.slug as string;
    const page = await this.cmsService.getPublicPageContent(slug);
    if (!page) {
      throw ApiError.notFound(`Page content for '${slug}' not found`);
    }
    sendSuccess(res, { data: page.content });
  };

  submitPublicEnquiry = async (req: Request, res: Response): Promise<void> => {
    const enquiry = await this.cmsService.submitPublicEnquiry(req.body);
    const message = req.body.type === "callback" ? "Callback request received. Our team will call you back." : "Enquiry submitted successfully";
    sendCreated(res, { data: enquiry, message });
  };

  subscribePublicNewsletter = async (req: Request, res: Response): Promise<void> => {
    const sub = await this.cmsService.subscribePublicNewsletter(req.body.email);
    sendCreated(res, { data: sub, message: "Subscribed to newsletter successfully" });
  };

  // --- Admin Handlers ---

  getAllBanners = async (_req: Request, res: Response): Promise<void> => {
    const banners = await this.cmsService.getAllBanners();
    sendSuccess(res, { data: banners });
  };

  saveBanners = async (req: Request, res: Response): Promise<void> => {
    const banners = await this.cmsService.saveBanners(req.body.banners, actorId(req));
    sendSuccess(res, { data: banners, message: "Banners updated successfully" });
  };

  deleteBanner = async (req: Request, res: Response): Promise<void> => {
    await this.cmsService.deleteBanner(req.params.id as string, actorId(req));
    sendSuccess(res, { data: true, message: "Banner deleted successfully" });
  };

  getAllArticles = async (_req: Request, res: Response): Promise<void> => {
    const articles = await this.cmsService.getAllArticles();
    sendSuccess(res, { data: articles });
  };

  getArticleBySlug = async (req: Request, res: Response): Promise<void> => {
    const slug = req.params.slug as string;
    const article = await this.cmsService.getArticleBySlug(slug);
    if (!article) {
      throw ApiError.notFound(`Article with slug '${slug}' not found`);
    }
    sendSuccess(res, { data: article });
  };

  saveArticle = async (req: Request, res: Response): Promise<void> => {
    const article = await this.cmsService.saveArticle(withRouteId(req), actorId(req));
    sendSuccess(res, { data: article, message: "Blog article saved successfully" });
  };

  deleteArticle = async (req: Request, res: Response): Promise<void> => {
    await this.cmsService.deleteArticle(req.params.id as string, actorId(req));
    sendSuccess(res, { data: true, message: "Article deleted successfully" });
  };

  getAllFaqs = async (_req: Request, res: Response): Promise<void> => {
    const faqs = await this.cmsService.getAllFaqs();
    sendSuccess(res, { data: faqs });
  };

  saveFaq = async (req: Request, res: Response): Promise<void> => {
    const faq = await this.cmsService.saveFaq(withRouteId(req), actorId(req));
    sendSuccess(res, { data: faq, message: "FAQ saved successfully" });
  };

  deleteFaq = async (req: Request, res: Response): Promise<void> => {
    await this.cmsService.deleteFaq(req.params.id as string, actorId(req));
    sendSuccess(res, { data: true, message: "FAQ deleted successfully" });
  };

  getAllTestimonials = async (_req: Request, res: Response): Promise<void> => {
    const testimonials = await this.cmsService.getAllTestimonials();
    sendSuccess(res, { data: testimonials });
  };

  saveTestimonial = async (req: Request, res: Response): Promise<void> => {
    const testimonial = await this.cmsService.saveTestimonial(withRouteId(req), actorId(req));
    sendSuccess(res, { data: testimonial, message: "Testimonial saved successfully" });
  };

  deleteTestimonial = async (req: Request, res: Response): Promise<void> => {
    await this.cmsService.deleteTestimonial(req.params.id as string, actorId(req));
    sendSuccess(res, { data: true, message: "Testimonial deleted successfully" });
  };

  getAllTrainers = async (_req: Request, res: Response): Promise<void> => {
    const trainers = await this.cmsService.getAllTrainers();
    sendSuccess(res, { data: trainers });
  };

  saveTrainer = async (req: Request, res: Response): Promise<void> => {
    const trainer = await this.cmsService.saveTrainer(withRouteId(req), actorId(req));
    sendSuccess(res, { data: trainer, message: "Trainer profile saved successfully" });
  };

  deleteTrainer = async (req: Request, res: Response): Promise<void> => {
    await this.cmsService.deleteTrainer(req.params.id as string, actorId(req));
    sendSuccess(res, { data: true, message: "Trainer profile deleted successfully" });
  };

  getAllAchievements = async (_req: Request, res: Response): Promise<void> => {
    const achievements = await this.cmsService.getAllAchievements();
    sendSuccess(res, { data: achievements });
  };

  saveAchievement = async (req: Request, res: Response): Promise<void> => {
    const achievement = await this.cmsService.saveAchievement(withRouteId(req), actorId(req));
    sendSuccess(res, { data: achievement, message: "Achievement saved successfully" });
  };

  deleteAchievement = async (req: Request, res: Response): Promise<void> => {
    await this.cmsService.deleteAchievement(req.params.id as string, actorId(req));
    sendSuccess(res, { data: true, message: "Achievement deleted successfully" });
  };

  getAllCareers = async (_req: Request, res: Response): Promise<void> => {
    const careers = await this.cmsService.getAllCareers();
    sendSuccess(res, { data: careers });
  };

  saveCareer = async (req: Request, res: Response): Promise<void> => {
    const career = await this.cmsService.saveCareer(withRouteId(req), actorId(req));
    sendSuccess(res, { data: career, message: "Career opening saved successfully" });
  };

  deleteCareer = async (req: Request, res: Response): Promise<void> => {
    await this.cmsService.deleteCareer(req.params.id as string, actorId(req));
    sendSuccess(res, { data: true, message: "Career opening deleted successfully" });
  };

  getAllHiringPartners = async (_req: Request, res: Response): Promise<void> => {
    const partners = await this.cmsService.getAllHiringPartners();
    sendSuccess(res, { data: partners });
  };

  /** Says plainly which supplied fields could not be stored (no database column). */
  private partnerSavedMessage(body: Record<string, unknown>): string {
    const notStored = ["logoUrl", "placementsCount", "isFeatured", "displayOrder"].filter(
      (k) => body[k] !== undefined && body[k] !== "",
    );
    return notStored.length
      ? `Hiring partner saved. Not stored (the database has no column for them): ${notStored.join(", ")}.`
      : "Hiring partner saved successfully";
  }

  /** POST /partners: always creates a new company; any id in the body is ignored. */
  createHiringPartner = async (req: Request, res: Response): Promise<void> => {
    const partner = await this.cmsService.createHiringPartner(req.body, actorId(req));
    sendSuccess(res, { data: partner, message: this.partnerSavedMessage(req.body as Record<string, unknown>) });
  };

  /** PUT /partners/:id: updates only the existing company with that numeric id. */
  updateHiringPartner = async (req: Request, res: Response): Promise<void> => {
    const id = req.params.id as string;
    const bodyId = (req.body as { id?: unknown }).id;
    if (bodyId !== undefined && bodyId !== "" && String(bodyId) !== id) {
      throw ApiError.validation(
        [{ field: "id", message: "The company id in the body does not match the id in the URL." }],
        "The company id in the body does not match the id in the URL.",
      );
    }
    const partner = await this.cmsService.updateHiringPartner(id, req.body, actorId(req));
    sendSuccess(res, { data: partner, message: this.partnerSavedMessage(req.body as Record<string, unknown>) });
  };

  deleteHiringPartner = async (req: Request, res: Response): Promise<void> => {
    await this.cmsService.deleteHiringPartner(req.params.id as string, actorId(req));
    sendSuccess(res, { data: true, message: "Hiring partner deleted successfully" });
  };

  getAllCollegePartners = async (_req: Request, res: Response): Promise<void> => {
    const partners = await this.cmsService.getAllCollegePartners();
    sendSuccess(res, { data: partners });
  };

  getCollegePartnerById = async (req: Request, res: Response): Promise<void> => {
    const partner = await this.cmsService.getCollegePartnerById(req.params.id as string);
    if (!partner) {
      throw ApiError.notFound("College partner not found");
    }
    sendSuccess(res, { data: partner });
  };

  saveCollegePartner = async (req: Request, res: Response): Promise<void> => {
    const partner = await this.cmsService.saveCollegePartner(withRouteId(req), actorId(req));
    sendSuccess(res, { data: partner, message: "College partner saved successfully" });
  };

  deleteCollegePartner = async (req: Request, res: Response): Promise<void> => {
    await this.cmsService.deleteCollegePartner(req.params.id as string, actorId(req));
    sendSuccess(res, { data: true, message: "College partner deleted successfully" });
  };

  updateCollegePartnerStatus = async (req: Request, res: Response): Promise<void> => {
    const partner = await this.cmsService.updateCollegePartnerStatus(
      req.params.id as string,
      req.body.status,
      actorId(req)
    );
    sendSuccess(res, { data: partner, message: "College partner status updated" });
  };

  getAllCorporateTrainingServices = async (_req: Request, res: Response): Promise<void> => {
    const services = await this.cmsService.getAllCorporateTrainingServices();
    sendSuccess(res, { data: services });
  };

  saveCorporateTrainingService = async (req: Request, res: Response): Promise<void> => {
    const service = await this.cmsService.saveCorporateTrainingService(withRouteId(req), actorId(req));
    sendSuccess(res, { data: service, message: "Corporate training service saved successfully" });
  };

  deleteCorporateTrainingService = async (req: Request, res: Response): Promise<void> => {
    await this.cmsService.deleteCorporateTrainingService(req.params.id as string, actorId(req));
    sendSuccess(res, { data: true, message: "Corporate training service deleted successfully" });
  };

  reorderCorporateTrainingServices = async (req: Request, res: Response): Promise<void> => {
    const services = await this.cmsService.reorderCorporateTrainingServices(req.body.ids, actorId(req));
    sendSuccess(res, { data: services, message: "Corporate training services reordered" });
  };

  updateCorporateTrainingServiceStatus = async (req: Request, res: Response): Promise<void> => {
    const service = await this.cmsService.updateCorporateTrainingServiceStatus(
      req.params.id as string,
      req.body.isActive,
      actorId(req)
    );
    sendSuccess(res, { data: service, message: "Corporate training service status updated" });
  };

  getPageContent = async (req: Request, res: Response): Promise<void> => {
    const slug = req.params.slug as string;
    const page = await this.cmsService.getPageContent(slug);
    if (!page) {
      throw ApiError.notFound(`Page content for '${slug}' not found`);
    }
    sendSuccess(res, { data: page });
  };

  savePageContent = async (req: Request, res: Response): Promise<void> => {
    const slug = req.params.slug as string;
    const page = await this.cmsService.savePageContent(
      {
        slug,
        title: req.body.title,
        content: req.body.content,
        isPublished: req.body.isPublished ?? true,
      },
      actorId(req)
    );
    sendSuccess(res, { data: page, message: `Page content for '${slug}' saved successfully` });
  };

  getAllEnquiries = async (_req: Request, res: Response): Promise<void> => {
    const enquiries = await this.cmsService.getAllEnquiries();
    sendSuccess(res, { data: enquiries });
  };

  getAllCallbackRequests = async (_req: Request, res: Response): Promise<void> => {
    sendSuccess(res, { data: await this.cmsService.getAllCallbackRequests() });
  };

  updateEnquiryStatus = async (req: Request, res: Response): Promise<void> => {
    const enquiry = await this.cmsService.updateEnquiryStatus(
      req.params.id as string,
      req.body.status,
      actorId(req)
    );
    sendSuccess(res, { data: enquiry, message: "Enquiry status updated successfully" });
  };
}
