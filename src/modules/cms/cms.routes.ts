import { Router, type RequestHandler } from "express";
import { requireAdmin } from "../../middleware/authorize.middleware";
import { validate } from "../../middleware/validate.middleware";
import { CmsController } from "./cms.controller";
import { createCmsService } from "./cms.service";
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
  collegePartnerSchema,
  updateCollegePartnerStatusSchema,
  corporateTrainingServiceSchema,
  leadEnquirySchema,
  updateEnquiryStatusSchema,
  pageContentSchema,
  newsletterSubscriptionSchema,
} from "./cms.validation";

export interface PublicCmsRoutesOptions {
  cms: CmsRepository;
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
  router.get("/content/:slug", controller.getPublicPageContent);

  router.post("/enquiries", validate({ body: leadEnquirySchema }), controller.submitPublicEnquiry);
  router.post("/newsletter/subscribe", validate({ body: newsletterSubscriptionSchema }), controller.subscribePublicNewsletter);

  return router;
};

export interface AdminCmsRoutesOptions {
  cms: CmsRepository;
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
  router.delete("/banners/:id", ...guards, controller.deleteBanner);

  // Blogs
  router.get("/blogs", ...guards, controller.getAllArticles);
  router.get("/blogs/:slug", ...guards, controller.getArticleBySlug);
  router.post("/blogs", ...guards, validate({ body: blogArticleSchema }), controller.saveArticle);
  router.put("/blogs/:id", ...guards, validate({ body: blogArticleSchema }), controller.saveArticle);
  router.delete("/blogs/:id", ...guards, controller.deleteArticle);

  // FAQs
  router.get("/faqs", ...guards, controller.getAllFaqs);
  router.post("/faqs", ...guards, validate({ body: faqItemSchema }), controller.saveFaq);
  router.put("/faqs/:id", ...guards, validate({ body: faqItemSchema }), controller.saveFaq);
  router.delete("/faqs/:id", ...guards, controller.deleteFaq);

  // Testimonials
  router.get("/testimonials", ...guards, controller.getAllTestimonials);
  router.post("/testimonials", ...guards, validate({ body: testimonialItemSchema }), controller.saveTestimonial);
  router.put("/testimonials/:id", ...guards, validate({ body: testimonialItemSchema }), controller.saveTestimonial);
  router.delete("/testimonials/:id", ...guards, controller.deleteTestimonial);

  // Trainers & Mentors
  router.get("/trainers", ...guards, controller.getAllTrainers);
  router.post("/trainers", ...guards, validate({ body: trainerProfileSchema }), controller.saveTrainer);
  router.put("/trainers/:id", ...guards, validate({ body: trainerProfileSchema }), controller.saveTrainer);
  router.delete("/trainers/:id", ...guards, controller.deleteTrainer);

  // Achievements
  router.get("/achievements", ...guards, controller.getAllAchievements);
  router.post("/achievements", ...guards, validate({ body: achievementItemSchema }), controller.saveAchievement);
  router.put("/achievements/:id", ...guards, validate({ body: achievementItemSchema }), controller.saveAchievement);
  router.delete("/achievements/:id", ...guards, controller.deleteAchievement);

  // Careers
  router.get("/careers", ...guards, controller.getAllCareers);
  router.post("/careers", ...guards, validate({ body: careerOpeningSchema }), controller.saveCareer);
  router.put("/careers/:id", ...guards, validate({ body: careerOpeningSchema }), controller.saveCareer);
  router.delete("/careers/:id", ...guards, controller.deleteCareer);

  // Hiring Partners
  router.get("/partners", ...guards, controller.getAllHiringPartners);
  router.post("/partners", ...guards, validate({ body: hiringPartnerSchema }), controller.saveHiringPartner);
  router.put("/partners/:id", ...guards, validate({ body: hiringPartnerSchema }), controller.saveHiringPartner);
  router.delete("/partners/:id", ...guards, controller.deleteHiringPartner);

  // College Partners
  router.get("/college-partners", ...guards, controller.getAllCollegePartners);
  router.get("/college-partners/:id", ...guards, controller.getCollegePartnerById);
  router.post("/college-partners", ...guards, validate({ body: collegePartnerSchema }), controller.saveCollegePartner);
  router.put("/college-partners/:id", ...guards, validate({ body: collegePartnerSchema }), controller.saveCollegePartner);
  router.delete("/college-partners/:id", ...guards, controller.deleteCollegePartner);
  router.patch("/college-partners/:id/status", ...guards, validate({ body: updateCollegePartnerStatusSchema }), controller.updateCollegePartnerStatus);

  // Corporate Training Services
  router.get("/corporate-training", ...guards, controller.getAllCorporateTrainingServices);
  router.post("/corporate-training/services", ...guards, validate({ body: corporateTrainingServiceSchema }), controller.saveCorporateTrainingService);
  router.put("/corporate-training/services/:id", ...guards, validate({ body: corporateTrainingServiceSchema }), controller.saveCorporateTrainingService);
  router.delete("/corporate-training/services/:id", ...guards, controller.deleteCorporateTrainingService);
  router.patch("/corporate-training/services/:id/status", ...guards, controller.updateCorporateTrainingServiceStatus);

  // Page Content
  router.get("/content/:slug", ...guards, controller.getPageContent);
  router.put("/content/:slug", ...guards, validate({ body: pageContentSchema }), controller.savePageContent);

  // Enquiries
  router.get("/enquiries", ...guards, controller.getAllEnquiries);
  router.patch("/enquiries/:id/status", ...guards, validate({ body: updateEnquiryStatusSchema }), controller.updateEnquiryStatus);

  return router;
};
