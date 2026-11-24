import { Router, type RequestHandler } from "express";
import { requireAdmin } from "../../middleware/authorize.middleware";
import { validate } from "../../middleware/validate.middleware";
import { createRateLimiter } from "../../middleware/rate-limit.middleware";
import { CmsController } from "./cms.controller";
import { createCmsService, type CmsServiceDeps } from "./cms.service";
import type { CmsRepository } from "./cms.repository";
import {
  saveBannersSchema,
  blogArticleSchema,
  faqItemSchema,
  testimonialItemSchema,
  achievementItemSchema,
  trainerProfileSchema,
  careerOpeningSchema,
  hiringPartnerSchema,
  hiringPartnerIdParamsSchema,
  collegePartnerSchema,
  updateCollegePartnerStatusSchema,
  corporateTrainingServiceSchema,
  leadEnquirySchema,
  updateEnquiryStatusSchema,
  pageContentSchema,
  newsletterSubscriptionSchema,
  numericIdParamsSchema,
  itemIdParamsSchema,
  corporateServiceStatusSchema,
  reorderCorporateServicesSchema,
  pageSlugParamsSchema,
} from "./cms.validation";

export interface PublicCmsRoutesOptions {
  cms: CmsRepository;
  /** PUB-006: course records for trainer links. */
  courses?: CmsServiceDeps["courses"];
  /** Limits anonymous submissions (enquiries, callbacks, newsletter). Defaults to 10 per IP per 15 minutes. */
  submissionLimiter?: RequestHandler;
}

export const createPublicCmsRoutes = (options: PublicCmsRoutesOptions): Router => {
  const service = createCmsService(options);
  const controller = new CmsController(service);
  const router = Router();

  router.get("/banners", controller.getPublicBanners);
  router.get("/blogs", controller.getPublicArticles);
  router.get("/blogs/:slug", controller.getPublicArticleBySlug);
  router.get("/faqs", controller.getPublicFaqs);
  router.get("/testimonials", controller.getPublicTestimonials);
  router.get("/trainers", controller.getPublicTrainers);
  router.get("/achievements", controller.getPublicAchievements);
  router.get("/careers", controller.getPublicCareers);
  router.get("/partners", controller.getPublicHiringPartners);
  router.get("/college-partnerships", controller.getPublicCollegePartners);
  router.get("/corporate-training", controller.getPublicCorporateTrainingServices);
  router.get("/content/:slug", validate({ params: pageSlugParamsSchema }), controller.getPublicPageContent);

  // Anonymous submissions are rate limited per IP: they write rows and could be used to flood the Admin lead list.
  const limiter =
    options.submissionLimiter ??
    createRateLimiter({ windowMs: 15 * 60 * 1000, limit: 10, message: "Too many submissions. Please try again later." });
  router.post("/enquiries", limiter, validate({ body: leadEnquirySchema }), controller.submitPublicEnquiry);
  router.post("/newsletter/subscribe", limiter, validate({ body: newsletterSubscriptionSchema }), controller.subscribePublicNewsletter);

  return router;
};

export interface AdminCmsRoutesOptions {
  cms: CmsRepository;
  /** PUB-006: course records for trainer links. */
  courses?: CmsServiceDeps["courses"];
  authenticate?: RequestHandler;
}

export const createAdminCmsRoutes = (options: AdminCmsRoutesOptions): Router => {
  const service = createCmsService(options);
  const controller = new CmsController(service);
  const router = Router();

  const guards: RequestHandler[] =
    options.authenticate === undefined
      ? [requireAdmin]
      : [options.authenticate, requireAdmin];

  // Banners
  router.get("/banners", ...guards, controller.getAllBanners);
  router.put("/banners", ...guards, validate({ body: saveBannersSchema }), controller.saveBanners);
  router.delete("/banners/:id", ...guards, validate({ params: itemIdParamsSchema }), controller.deleteBanner);

  // Blogs
  router.get("/blogs", ...guards, controller.getAllArticles);
  router.get("/blogs/:slug", ...guards, controller.getArticleBySlug);
  router.post("/blogs", ...guards, validate({ body: blogArticleSchema }), controller.saveArticle);
  router.put("/blogs/:id", ...guards, validate({ params: numericIdParamsSchema, body: blogArticleSchema }), controller.saveArticle);
  router.delete("/blogs/:id", ...guards, validate({ params: numericIdParamsSchema }), controller.deleteArticle);

  // FAQs
  router.get("/faqs", ...guards, controller.getAllFaqs);
  router.post("/faqs", ...guards, validate({ body: faqItemSchema }), controller.saveFaq);
  router.put("/faqs/:id", ...guards, validate({ params: numericIdParamsSchema, body: faqItemSchema }), controller.saveFaq);
  router.delete("/faqs/:id", ...guards, validate({ params: numericIdParamsSchema }), controller.deleteFaq);

  // Testimonials
  router.get("/testimonials", ...guards, controller.getAllTestimonials);
  router.post("/testimonials", ...guards, validate({ body: testimonialItemSchema }), controller.saveTestimonial);
  router.put("/testimonials/:id", ...guards, validate({ params: itemIdParamsSchema, body: testimonialItemSchema }), controller.saveTestimonial);
  router.delete("/testimonials/:id", ...guards, validate({ params: itemIdParamsSchema }), controller.deleteTestimonial);

  // Trainers & Mentors
  router.get("/trainers", ...guards, controller.getAllTrainers);
  router.post("/trainers", ...guards, validate({ body: trainerProfileSchema }), controller.saveTrainer);
  router.put("/trainers/:id", ...guards, validate({ params: itemIdParamsSchema, body: trainerProfileSchema }), controller.saveTrainer);
  router.delete("/trainers/:id", ...guards, validate({ params: itemIdParamsSchema }), controller.deleteTrainer);

  // Achievements
  router.get("/achievements", ...guards, controller.getAllAchievements);
  router.post("/achievements", ...guards, validate({ body: achievementItemSchema }), controller.saveAchievement);
  router.put("/achievements/:id", ...guards, validate({ params: itemIdParamsSchema, body: achievementItemSchema }), controller.saveAchievement);
  router.delete("/achievements/:id", ...guards, validate({ params: itemIdParamsSchema }), controller.deleteAchievement);

  // Careers
  router.get("/careers", ...guards, controller.getAllCareers);
  router.post("/careers", ...guards, validate({ body: careerOpeningSchema }), controller.saveCareer);
  router.put("/careers/:id", ...guards, validate({ params: itemIdParamsSchema, body: careerOpeningSchema }), controller.saveCareer);
  router.delete("/careers/:id", ...guards, validate({ params: itemIdParamsSchema }), controller.deleteCareer);

  // Hiring Partners
  router.get("/partners", ...guards, controller.getAllHiringPartners);
  // POST always creates; PUT updates only the existing numeric company id in the URL.
  router.post("/partners", ...guards, validate({ body: hiringPartnerSchema }), controller.createHiringPartner);
  router.put(
    "/partners/:id",
    ...guards,
    validate({ params: hiringPartnerIdParamsSchema, body: hiringPartnerSchema }),
    controller.updateHiringPartner,
  );
  router.delete("/partners/:id", ...guards, validate({ params: numericIdParamsSchema }), controller.deleteHiringPartner);

  // College Partners
  router.get("/college-partners", ...guards, controller.getAllCollegePartners);
  router.get("/college-partners/:id", ...guards, validate({ params: numericIdParamsSchema }), controller.getCollegePartnerById);
  router.post("/college-partners", ...guards, validate({ body: collegePartnerSchema }), controller.saveCollegePartner);
  router.put("/college-partners/:id", ...guards, validate({ params: numericIdParamsSchema, body: collegePartnerSchema }), controller.saveCollegePartner);
  router.delete("/college-partners/:id", ...guards, validate({ params: numericIdParamsSchema }), controller.deleteCollegePartner);
  router.patch("/college-partners/:id/status", ...guards, validate({ params: numericIdParamsSchema, body: updateCollegePartnerStatusSchema }), controller.updateCollegePartnerStatus);

  // Corporate Training Services
  router.get("/corporate-training", ...guards, controller.getAllCorporateTrainingServices);
  router.post("/corporate-training/services", ...guards, validate({ body: corporateTrainingServiceSchema }), controller.saveCorporateTrainingService);
  router.put("/corporate-training/services/:id", ...guards, validate({ params: itemIdParamsSchema, body: corporateTrainingServiceSchema }), controller.saveCorporateTrainingService);
  router.delete("/corporate-training/services/:id", ...guards, validate({ params: itemIdParamsSchema }), controller.deleteCorporateTrainingService);
  router.patch(
    "/corporate-training/services/:id/status",
    ...guards,
    validate({ params: itemIdParamsSchema, body: corporateServiceStatusSchema }),
    controller.updateCorporateTrainingServiceStatus,
  );
  router.put("/corporate-training/order", ...guards, validate({ body: reorderCorporateServicesSchema }), controller.reorderCorporateTrainingServices);

  // Page Content
  // Only the singleton page/config slugs on the allowlist (cms.rules.ts); collection rows are refused.
  router.get("/content/:slug", ...guards, validate({ params: pageSlugParamsSchema }), controller.getPageContent);
  router.put("/content/:slug", ...guards, validate({ params: pageSlugParamsSchema, body: pageContentSchema }), controller.savePageContent);

  // Enquiries
  router.get("/enquiries", ...guards, controller.getAllEnquiries);
  router.patch("/enquiries/:id/status", ...guards, validate({ params: numericIdParamsSchema, body: updateEnquiryStatusSchema }), controller.updateEnquiryStatus);

  // Callback requests: read-only (NXA_CallbackRequests.RequestStatus values are not confirmed).
  router.get("/callbacks", ...guards, controller.getAllCallbackRequests);

  return router;
};
