import sql from "mssql";
import { getSqlServerPool } from "../../db/sqlserver.pool";
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

export class SqlServerCmsRepository implements CmsRepository {
  constructor(private readonly getPool: () => Promise<sql.ConnectionPool> = getSqlServerPool) {}

  // --- Banners ---
  async getBanners(onlyActive = false): Promise<WebsiteBanner[]> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("slug", sql.VarChar(200), "website_banners")
      .query(`
        SELECT Body FROM dbo.NXA_WebsiteContent
        WHERE Slug = @slug
      `);

    if (!result.recordset || result.recordset.length === 0) {
      return [];
    }

    try {
      const banners: WebsiteBanner[] = JSON.parse(result.recordset[0].Body);
      return onlyActive ? banners.filter((b) => b.isActive) : banners;
    } catch {
      return [];
    }
  }

  async saveBanners(banners: WebsiteBanner[], userId: string): Promise<WebsiteBanner[]> {
    const pool = await this.getPool();
    const bodyJson = JSON.stringify(banners);

    await pool
      .request()
      .input("slug", sql.VarChar(200), "website_banners")
      .input("title", sql.NVarChar(250), "Website Announcement Banners")
      .input("body", sql.NVarChar(sql.MAX), bodyJson)
      .input("contentType", sql.VarChar(40), "banners")
      .input("userId", sql.BigInt, Number(userId) || 1)
      .query(`
        MERGE dbo.NXA_WebsiteContent AS target
        USING (SELECT @slug AS Slug) AS source
        ON (target.Slug = source.Slug)
        WHEN MATCHED THEN
          UPDATE SET Title = @title, Body = @body, UpdatedAt = SYSUTCDATETIME(), UpdatedByUserId = @userId
        WHEN NOT MATCHED THEN
          INSERT (ContentType, Slug, Title, Body, IsPublished, PublishedAt, CreatedAt, CreatedByUserId)
          VALUES (@contentType, @slug, @title, @body, 1, SYSUTCDATETIME(), SYSUTCDATETIME(), @userId);
      `);

    return banners;
  }

  async deleteBanner(id: string, userId: string): Promise<boolean> {
    const banners = await this.getBanners();
    const filtered = banners.filter((b) => b.id !== id);
    await this.saveBanners(filtered, userId);
    return true;
  }

  // --- Articles (Blogs) ---
  async getArticles(onlyPublished = false): Promise<BlogArticle[]> {
    const pool = await this.getPool();
    let query = `
      SELECT BlogArticleId, Title, Slug, Summary, Body, IsPublished, PublishedAt, CreatedAt
      FROM dbo.NXA_BlogArticles
    `;
    if (onlyPublished) {
      query += ` WHERE IsPublished = 1`;
    }
    query += ` ORDER BY CreatedAt DESC`;

    const result = await pool.request().query(query);
    return (result.recordset || []).map((row) => {
      let extra: Record<string, any> = {};
      try {
        extra = JSON.parse(row.Body);
      } catch {
        extra = { content: [row.Body] };
      }

      return {
        id: String(row.BlogArticleId),
        title: row.Title,
        slug: row.Slug,
        excerpt: row.Summary || "",
        isPublished: Boolean(row.IsPublished),
        date: row.PublishedAt ? new Date(row.PublishedAt).toISOString() : new Date(row.CreatedAt).toISOString(),
        category: extra.category || "General",
        author: extra.author || "Editorial Team",
        authorRole: extra.authorRole || "Contributing Author",
        authorAvatar: extra.authorAvatar || "",
        readTime: extra.readTime || "5 min read",
        content: Array.isArray(extra.content) ? extra.content : [row.Body],
        tags: Array.isArray(extra.tags) ? extra.tags : [],
        featuredImage: extra.featuredImage || "",
        order: extra.order,
      };
    });
  }

  async getArticleBySlug(slug: string, onlyPublished = false): Promise<BlogArticle | null> {
    const pool = await this.getPool();
    let query = `
      SELECT BlogArticleId, Title, Slug, Summary, Body, IsPublished, PublishedAt, CreatedAt
      FROM dbo.NXA_BlogArticles
      WHERE Slug = @slug
    `;
    if (onlyPublished) {
      query += ` AND IsPublished = 1`;
    }

    const result = await pool.request().input("slug", sql.VarChar(200), slug).query(query);
    if (!result.recordset || result.recordset.length === 0) return null;

    const row = result.recordset[0];
    let extra: Record<string, any> = {};
    try {
      extra = JSON.parse(row.Body);
    } catch {
      extra = { content: [row.Body] };
    }

    return {
      id: String(row.BlogArticleId),
      title: row.Title,
      slug: row.Slug,
      excerpt: row.Summary || "",
      isPublished: Boolean(row.IsPublished),
      date: row.PublishedAt ? new Date(row.PublishedAt).toISOString() : new Date(row.CreatedAt).toISOString(),
      category: extra.category || "General",
      author: extra.author || "Editorial Team",
      authorRole: extra.authorRole || "Contributing Author",
      authorAvatar: extra.authorAvatar || "",
      readTime: extra.readTime || "5 min read",
      content: Array.isArray(extra.content) ? extra.content : [row.Body],
      tags: Array.isArray(extra.tags) ? extra.tags : [],
      featuredImage: extra.featuredImage || "",
      order: extra.order,
    };
  }

  async saveArticle(article: BlogArticle, userId: string): Promise<BlogArticle> {
    const pool = await this.getPool();
    const extra = {
      category: article.category,
      author: article.author,
      authorRole: article.authorRole,
      authorAvatar: article.authorAvatar,
      readTime: article.readTime,
      content: article.content,
      tags: article.tags,
      featuredImage: article.featuredImage,
      order: article.order,
    };
    const bodyJson = JSON.stringify(extra);

    if (article.id && !isNaN(Number(article.id))) {
      await pool
        .request()
        .input("id", sql.BigInt, Number(article.id))
        .input("title", sql.NVarChar(250), article.title)
        .input("slug", sql.VarChar(200), article.slug)
        .input("summary", sql.NVarChar(1000), article.excerpt)
        .input("body", sql.NVarChar(sql.MAX), bodyJson)
        .input("isPublished", sql.Bit, article.isPublished ? 1 : 0)
        .query(`
          UPDATE dbo.NXA_BlogArticles
          SET Title = @title, Slug = @slug, Summary = @summary, Body = @body, IsPublished = @isPublished
          WHERE BlogArticleId = @id
        `);
      return article;
    }

    const insertResult = await pool
      .request()
      .input("title", sql.NVarChar(250), article.title)
      .input("slug", sql.VarChar(200), article.slug)
      .input("summary", sql.NVarChar(1000), article.excerpt)
      .input("body", sql.NVarChar(sql.MAX), bodyJson)
      .input("authorUserId", sql.BigInt, Number(userId) || 1)
      .input("isPublished", sql.Bit, article.isPublished ? 1 : 0)
      .query(`
        INSERT INTO dbo.NXA_BlogArticles (Title, Slug, Summary, Body, AuthorUserId, IsPublished, PublishedAt, CreatedAt)
        OUTPUT INSERTED.BlogArticleId
        VALUES (@title, @slug, @summary, @body, @authorUserId, @isPublished, SYSUTCDATETIME(), SYSUTCDATETIME())
      `);

    const newId = String(insertResult.recordset[0].BlogArticleId);
    return { ...article, id: newId };
  }

  async deleteArticle(id: string): Promise<boolean> {
    const pool = await this.getPool();
    await pool
      .request()
      .input("id", sql.BigInt, Number(id) || 0)
      .query(`DELETE FROM dbo.NXA_BlogArticles WHERE BlogArticleId = @id`);
    return true;
  }

  // --- FAQs ---
  async getFaqs(onlyActive = false): Promise<FAQItem[]> {
    const pool = await this.getPool();
    let query = `
      SELECT FaqId, Question, Answer, DisplayOrder, IsPublished
      FROM dbo.NXA_Faqs
    `;
    if (onlyActive) {
      query += ` WHERE IsPublished = 1`;
    }
    query += ` ORDER BY DisplayOrder ASC`;

    const result = await pool.request().query(query);
    return (result.recordset || []).map((row) => ({
      id: String(row.FaqId),
      category: "General",
      question: row.Question,
      answer: row.Answer,
      order: row.DisplayOrder || 1,
      isActive: Boolean(row.IsPublished),
    }));
  }

  async saveFaq(faq: FAQItem): Promise<FAQItem> {
    const pool = await this.getPool();
    if (faq.id && !isNaN(Number(faq.id))) {
      await pool
        .request()
        .input("id", sql.BigInt, Number(faq.id))
        .input("question", sql.NVarChar(500), faq.question)
        .input("answer", sql.NVarChar(sql.MAX), faq.answer)
        .input("order", sql.Int, faq.order)
        .input("isPublished", sql.Bit, faq.isActive ? 1 : 0)
        .query(`
          UPDATE dbo.NXA_Faqs
          SET Question = @question, Answer = @answer, DisplayOrder = @order, IsPublished = @isPublished
          WHERE FaqId = @id
        `);
      return faq;
    }

    const insertResult = await pool
      .request()
      .input("question", sql.NVarChar(500), faq.question)
      .input("answer", sql.NVarChar(sql.MAX), faq.answer)
      .input("order", sql.Int, faq.order)
      .input("isPublished", sql.Bit, faq.isActive ? 1 : 0)
      .query(`
        INSERT INTO dbo.NXA_Faqs (Question, Answer, DisplayOrder, IsPublished)
        OUTPUT INSERTED.FaqId
        VALUES (@question, @answer, @order, @isPublished)
      `);

    const newId = String(insertResult.recordset[0].FaqId);
    return { ...faq, id: newId };
  }

  async deleteFaq(id: string): Promise<boolean> {
    const pool = await this.getPool();
    await pool
      .request()
      .input("id", sql.BigInt, Number(id) || 0)
      .query(`DELETE FROM dbo.NXA_Faqs WHERE FaqId = @id`);
    return true;
  }

  // --- Testimonials ---
  async getTestimonials(onlyPublished = false): Promise<TestimonialItem[]> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("slug", sql.VarChar(200), "testimonials_list")
      .query(`SELECT Body FROM dbo.NXA_WebsiteContent WHERE Slug = @slug`);

    if (!result.recordset || result.recordset.length === 0) return [];
    try {
      const items: TestimonialItem[] = JSON.parse(result.recordset[0].Body);
      return onlyPublished ? items.filter((t) => t.isPublished) : items;
    } catch {
      return [];
    }
  }

  async saveTestimonial(testimonial: TestimonialItem, userId: string): Promise<TestimonialItem> {
    const items = await this.getTestimonials();
    const targetId = testimonial.id || `testi-${Date.now()}`;
    const prepared: TestimonialItem = { ...testimonial, id: targetId };

    const idx = items.findIndex((t) => t.id === targetId);
    if (idx >= 0) {
      items[idx] = prepared;
    } else {
      items.unshift(prepared);
    }

    const pool = await this.getPool();
    await pool
      .request()
      .input("slug", sql.VarChar(200), "testimonials_list")
      .input("title", sql.NVarChar(250), "Student Placement Testimonials")
      .input("body", sql.NVarChar(sql.MAX), JSON.stringify(items))
      .input("contentType", sql.VarChar(40), "testimonials")
      .input("userId", sql.BigInt, Number(userId) || 1)
      .query(`
        MERGE dbo.NXA_WebsiteContent AS target
        USING (SELECT @slug AS Slug) AS source
        ON (target.Slug = source.Slug)
        WHEN MATCHED THEN
          UPDATE SET Title = @title, Body = @body, UpdatedAt = SYSUTCDATETIME(), UpdatedByUserId = @userId
        WHEN NOT MATCHED THEN
          INSERT (ContentType, Slug, Title, Body, IsPublished, PublishedAt, CreatedAt, CreatedByUserId)
          VALUES (@contentType, @slug, @title, @body, 1, SYSUTCDATETIME(), SYSUTCDATETIME(), @userId);
      `);

    return prepared;
  }

  async deleteTestimonial(id: string, userId: string): Promise<boolean> {
    const items = await this.getTestimonials();
    const filtered = items.filter((t) => t.id !== id);
    const pool = await this.getPool();
    await pool
      .request()
      .input("slug", sql.VarChar(200), "testimonials_list")
      .input("body", sql.NVarChar(sql.MAX), JSON.stringify(filtered))
      .input("userId", sql.BigInt, Number(userId) || 1)
      .query(`
        UPDATE dbo.NXA_WebsiteContent
        SET Body = @body, UpdatedAt = SYSUTCDATETIME(), UpdatedByUserId = @userId
        WHERE Slug = @slug
      `);
    return true;
  }

  // --- Trainers & Mentors ---
  async getTrainers(onlyActive = false): Promise<TrainerProfile[]> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("slug", sql.VarChar(200), "trainers_list")
      .query(`SELECT Body FROM dbo.NXA_WebsiteContent WHERE Slug = @slug`);

    if (!result.recordset || result.recordset.length === 0) return [];
    try {
      const trainers: TrainerProfile[] = JSON.parse(result.recordset[0].Body);
      return onlyActive ? trainers.filter((t) => t.isActive) : trainers;
    } catch {
      return [];
    }
  }

  async saveTrainer(trainer: TrainerProfile, userId: string): Promise<TrainerProfile> {
    const items = await this.getTrainers();
    const targetId = trainer.id || `trn-${Date.now()}`;
    const prepared: TrainerProfile = { ...trainer, id: targetId };

    const idx = items.findIndex((t) => t.id === targetId);
    if (idx >= 0) {
      items[idx] = prepared;
    } else {
      items.unshift(prepared);
    }

    const pool = await this.getPool();
    await pool
      .request()
      .input("slug", sql.VarChar(200), "trainers_list")
      .input("title", sql.NVarChar(250), "Industry Trainers and Mentors")
      .input("body", sql.NVarChar(sql.MAX), JSON.stringify(items))
      .input("contentType", sql.VarChar(40), "trainers")
      .input("userId", sql.BigInt, Number(userId) || 1)
      .query(`
        MERGE dbo.NXA_WebsiteContent AS target
        USING (SELECT @slug AS Slug) AS source
        ON (target.Slug = source.Slug)
        WHEN MATCHED THEN
          UPDATE SET Title = @title, Body = @body, UpdatedAt = SYSUTCDATETIME(), UpdatedByUserId = @userId
        WHEN NOT MATCHED THEN
          INSERT (ContentType, Slug, Title, Body, IsPublished, PublishedAt, CreatedAt, CreatedByUserId)
          VALUES (@contentType, @slug, @title, @body, 1, SYSUTCDATETIME(), SYSUTCDATETIME(), @userId);
      `);

    return prepared;
  }

  async deleteTrainer(id: string, userId: string): Promise<boolean> {
    const items = await this.getTrainers();
    const filtered = items.filter((t) => t.id !== id);
    const pool = await this.getPool();
    await pool
      .request()
      .input("slug", sql.VarChar(200), "trainers_list")
      .input("body", sql.NVarChar(sql.MAX), JSON.stringify(filtered))
      .input("userId", sql.BigInt, Number(userId) || 1)
      .query(`
        UPDATE dbo.NXA_WebsiteContent
        SET Body = @body, UpdatedAt = SYSUTCDATETIME(), UpdatedByUserId = @userId
        WHERE Slug = @slug
      `);
    return true;
  }

  // --- Achievements ---
  async getAchievements(onlyActive = false): Promise<AchievementItem[]> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("slug", sql.VarChar(200), "achievements_list")
      .query(`SELECT Body FROM dbo.NXA_WebsiteContent WHERE Slug = @slug`);

    if (!result.recordset || result.recordset.length === 0) return [];
    try {
      const items: AchievementItem[] = JSON.parse(result.recordset[0].Body);
      return onlyActive ? items.filter((a) => a.isActive) : items;
    } catch {
      return [];
    }
  }

  async saveAchievement(achievement: AchievementItem, userId: string): Promise<AchievementItem> {
    const items = await this.getAchievements();
    const targetId = achievement.id || `ach-${Date.now()}`;
    const prepared: AchievementItem = { ...achievement, id: targetId };

    const idx = items.findIndex((a) => a.id === targetId);
    if (idx >= 0) {
      items[idx] = prepared;
    } else {
      items.unshift(prepared);
    }

    const pool = await this.getPool();
    await pool
      .request()
      .input("slug", sql.VarChar(200), "achievements_list")
      .input("title", sql.NVarChar(250), "Student Hackathon & Career Achievements")
      .input("body", sql.NVarChar(sql.MAX), JSON.stringify(items))
      .input("contentType", sql.VarChar(40), "achievements")
      .input("userId", sql.BigInt, Number(userId) || 1)
      .query(`
        MERGE dbo.NXA_WebsiteContent AS target
        USING (SELECT @slug AS Slug) AS source
        ON (target.Slug = source.Slug)
        WHEN MATCHED THEN
          UPDATE SET Title = @title, Body = @body, UpdatedAt = SYSUTCDATETIME(), UpdatedByUserId = @userId
        WHEN NOT MATCHED THEN
          INSERT (ContentType, Slug, Title, Body, IsPublished, PublishedAt, CreatedAt, CreatedByUserId)
          VALUES (@contentType, @slug, @title, @body, 1, SYSUTCDATETIME(), SYSUTCDATETIME(), @userId);
      `);

    return prepared;
  }

  async deleteAchievement(id: string, userId: string): Promise<boolean> {
    const items = await this.getAchievements();
    const filtered = items.filter((a) => a.id !== id);
    const pool = await this.getPool();
    await pool
      .request()
      .input("slug", sql.VarChar(200), "achievements_list")
      .input("body", sql.NVarChar(sql.MAX), JSON.stringify(filtered))
      .input("userId", sql.BigInt, Number(userId) || 1)
      .query(`
        UPDATE dbo.NXA_WebsiteContent
        SET Body = @body, UpdatedAt = SYSUTCDATETIME(), UpdatedByUserId = @userId
        WHERE Slug = @slug
      `);
    return true;
  }

  // --- Careers ---
  async getCareers(onlyActive = false): Promise<CareerOpening[]> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("slug", sql.VarChar(200), "careers_list")
      .query(`SELECT Body FROM dbo.NXA_WebsiteContent WHERE Slug = @slug`);

    if (!result.recordset || result.recordset.length === 0) return [];
    try {
      const items: CareerOpening[] = JSON.parse(result.recordset[0].Body);
      return onlyActive ? items.filter((c) => c.isActive) : items;
    } catch {
      return [];
    }
  }

  async saveCareer(career: CareerOpening, userId: string): Promise<CareerOpening> {
    const items = await this.getCareers();
    const targetId = career.id || `car-${Date.now()}`;
    const prepared: CareerOpening = { ...career, id: targetId };

    const idx = items.findIndex((c) => c.id === targetId);
    if (idx >= 0) {
      items[idx] = prepared;
    } else {
      items.unshift(prepared);
    }

    const pool = await this.getPool();
    await pool
      .request()
      .input("slug", sql.VarChar(200), "careers_list")
      .input("title", sql.NVarChar(250), "Internal Academy Career Openings")
      .input("body", sql.NVarChar(sql.MAX), JSON.stringify(items))
      .input("contentType", sql.VarChar(40), "careers")
      .input("userId", sql.BigInt, Number(userId) || 1)
      .query(`
        MERGE dbo.NXA_WebsiteContent AS target
        USING (SELECT @slug AS Slug) AS source
        ON (target.Slug = source.Slug)
        WHEN MATCHED THEN
          UPDATE SET Title = @title, Body = @body, UpdatedAt = SYSUTCDATETIME(), UpdatedByUserId = @userId
        WHEN NOT MATCHED THEN
          INSERT (ContentType, Slug, Title, Body, IsPublished, PublishedAt, CreatedAt, CreatedByUserId)
          VALUES (@contentType, @slug, @title, @body, 1, SYSUTCDATETIME(), SYSUTCDATETIME(), @userId);
      `);

    return prepared;
  }

  async deleteCareer(id: string, userId: string): Promise<boolean> {
    const items = await this.getCareers();
    const filtered = items.filter((c) => c.id !== id);
    const pool = await this.getPool();
    await pool
      .request()
      .input("slug", sql.VarChar(200), "careers_list")
      .input("body", sql.NVarChar(sql.MAX), JSON.stringify(filtered))
      .input("userId", sql.BigInt, Number(userId) || 1)
      .query(`
        UPDATE dbo.NXA_WebsiteContent
        SET Body = @body, UpdatedAt = SYSUTCDATETIME(), UpdatedByUserId = @userId
        WHERE Slug = @slug
      `);
    return true;
  }

  // --- Hiring Partners ---
  async getHiringPartners(onlyActive = false): Promise<HiringPartner[]> {
    const pool = await this.getPool();
    let query = `
      SELECT CompanyId, CompanyName, Industry, LogoUrl, IsActive, CreatedAt
      FROM dbo.NXA_Companies
    `;
    if (onlyActive) {
      query += ` WHERE IsActive = 1`;
    }
    query += ` ORDER BY CompanyName ASC`;

    const result = await pool.request().query(query);
    return (result.recordset || []).map((row) => ({
      id: String(row.CompanyId),
      name: row.CompanyName,
      logoUrl: row.LogoUrl || "",
      industry: row.Industry || "Technology",
      placementsCount: 15,
      isFeatured: true,
      isActive: Boolean(row.IsActive),
    }));
  }

  async saveHiringPartner(partner: HiringPartner): Promise<HiringPartner> {
    const pool = await this.getPool();
    if (partner.id && !isNaN(Number(partner.id))) {
      await pool
        .request()
        .input("id", sql.BigInt, Number(partner.id))
        .input("name", sql.NVarChar(150), partner.name)
        .input("industry", sql.NVarChar(100), partner.industry)
        .input("logoUrl", sql.NVarChar(500), partner.logoUrl)
        .input("isActive", sql.Bit, partner.isActive ? 1 : 0)
        .query(`
          UPDATE dbo.NXA_Companies
          SET CompanyName = @name, Industry = @industry, LogoUrl = @logoUrl, IsActive = @isActive
          WHERE CompanyId = @id
        `);
      return partner;
    }

    const insertResult = await pool
      .request()
      .input("name", sql.NVarChar(150), partner.name)
      .input("industry", sql.NVarChar(100), partner.industry)
      .input("logoUrl", sql.NVarChar(500), partner.logoUrl)
      .input("isActive", sql.Bit, partner.isActive ? 1 : 0)
      .query(`
        INSERT INTO dbo.NXA_Companies (CompanyName, Industry, LogoUrl, IsActive, CreatedAt)
        OUTPUT INSERTED.CompanyId
        VALUES (@name, @industry, @logoUrl, @isActive, SYSUTCDATETIME())
      `);

    const newId = String(insertResult.recordset[0].CompanyId);
    return { ...partner, id: newId };
  }

  async deleteHiringPartner(id: string): Promise<boolean> {
    const pool = await this.getPool();
    await pool
      .request()
      .input("id", sql.BigInt, Number(id) || 0)
      .query(`DELETE FROM dbo.NXA_Companies WHERE CompanyId = @id`);
    return true;
  }

  // --- College Partners ---
  async getCollegePartners(onlyActive = false): Promise<CollegePartner[]> {
    const pool = await this.getPool();
    let query = `
      SELECT CollegePartnerId, CollegeName, PartnershipType, Address, ContactName, ContactEmail, ContactMobile, WebsiteUrl, PartnerStatus, Notes, CreatedAt
      FROM dbo.NXA_CollegePartners
    `;
    if (onlyActive) {
      query += ` WHERE PartnerStatus = 'active'`;
    }
    query += ` ORDER BY CreatedAt DESC`;

    const result = await pool.request().query(query);
    return (result.recordset || []).map((row) => ({
      id: String(row.CollegePartnerId),
      collegeName: row.CollegeName,
      partnershipType: row.PartnershipType || "Academic MOU",
      location: row.Address,
      contactPerson: row.ContactName,
      contactEmail: row.ContactEmail,
      contactMobile: row.ContactMobile,
      websiteUrl: row.WebsiteUrl,
      status: (row.PartnerStatus || "active") as any,
      notes: row.Notes,
      createdAt: row.CreatedAt ? new Date(row.CreatedAt).toISOString() : new Date().toISOString(),
    }));
  }

  async getCollegePartnerById(id: string): Promise<CollegePartner | null> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("id", sql.BigInt, Number(id) || 0)
      .query(`
        SELECT CollegePartnerId, CollegeName, PartnershipType, Address, ContactName, ContactEmail, ContactMobile, WebsiteUrl, PartnerStatus, Notes, CreatedAt
        FROM dbo.NXA_CollegePartners
        WHERE CollegePartnerId = @id
      `);

    if (!result.recordset || result.recordset.length === 0) return null;
    const row = result.recordset[0];
    return {
      id: String(row.CollegePartnerId),
      collegeName: row.CollegeName,
      partnershipType: row.PartnershipType || "Academic MOU",
      location: row.Address,
      contactPerson: row.ContactName,
      contactEmail: row.ContactEmail,
      contactMobile: row.ContactMobile,
      websiteUrl: row.WebsiteUrl,
      status: (row.PartnerStatus || "active") as any,
      notes: row.Notes,
      createdAt: row.CreatedAt ? new Date(row.CreatedAt).toISOString() : new Date().toISOString(),
    };
  }

  async saveCollegePartner(partner: CollegePartner, userId: string): Promise<CollegePartner> {
    const pool = await this.getPool();
    if (partner.id && !isNaN(Number(partner.id))) {
      await pool
        .request()
        .input("id", sql.BigInt, Number(partner.id))
        .input("collegeName", sql.NVarChar(200), partner.collegeName)
        .input("partnershipType", sql.VarChar(40), partner.partnershipType || "Academic MOU")
        .input("address", sql.NVarChar(700), partner.location || "")
        .input("contactName", sql.NVarChar(150), partner.contactPerson || "")
        .input("contactEmail", sql.NVarChar(254), partner.contactEmail || "")
        .input("contactMobile", sql.VarChar(25), partner.contactMobile || "")
        .input("websiteUrl", sql.NVarChar(500), partner.websiteUrl || "")
        .input("partnerStatus", sql.VarChar(20), partner.status || "active")
        .input("notes", sql.NVarChar(1000), partner.notes || "")
        .query(`
          UPDATE dbo.NXA_CollegePartners
          SET CollegeName = @collegeName, PartnershipType = @partnershipType, Address = @address,
              ContactName = @contactName, ContactEmail = @contactEmail, ContactMobile = @contactMobile,
              WebsiteUrl = @websiteUrl, PartnerStatus = @partnerStatus, Notes = @notes, UpdatedAt = SYSUTCDATETIME()
          WHERE CollegePartnerId = @id
        `);
      return partner;
    }

    const insertResult = await pool
      .request()
      .input("collegeName", sql.NVarChar(200), partner.collegeName)
      .input("partnershipType", sql.VarChar(40), partner.partnershipType || "Academic MOU")
      .input("address", sql.NVarChar(700), partner.location || "")
      .input("contactName", sql.NVarChar(150), partner.contactPerson || "")
      .input("contactEmail", sql.NVarChar(254), partner.contactEmail || "")
      .input("contactMobile", sql.VarChar(25), partner.contactMobile || "")
      .input("websiteUrl", sql.NVarChar(500), partner.websiteUrl || "")
      .input("partnerStatus", sql.VarChar(20), partner.status || "active")
      .input("notes", sql.NVarChar(1000), partner.notes || "")
      .input("createdByUserId", sql.BigInt, Number(userId) || 1)
      .query(`
        INSERT INTO dbo.NXA_CollegePartners (CollegeName, PartnershipType, Address, ContactName, ContactEmail, ContactMobile, WebsiteUrl, PartnerStatus, Notes, CreatedAt, CreatedByUserId)
        OUTPUT INSERTED.CollegePartnerId
        VALUES (@collegeName, @partnershipType, @address, @contactName, @contactEmail, @contactMobile, @websiteUrl, @partnerStatus, @notes, SYSUTCDATETIME(), @createdByUserId)
      `);

    const newId = String(insertResult.recordset[0].CollegePartnerId);
    return { ...partner, id: newId };
  }

  async deleteCollegePartner(id: string): Promise<boolean> {
    const pool = await this.getPool();
    await pool
      .request()
      .input("id", sql.BigInt, Number(id) || 0)
      .query(`DELETE FROM dbo.NXA_CollegePartners WHERE CollegePartnerId = @id`);
    return true;
  }

  async updateCollegePartnerStatus(id: string, status: 'active' | 'inactive' | 'mou_in_progress'): Promise<CollegePartner> {
    const pool = await this.getPool();
    await pool
      .request()
      .input("id", sql.BigInt, Number(id) || 0)
      .input("status", sql.VarChar(20), status)
      .query(`
        UPDATE dbo.NXA_CollegePartners
        SET PartnerStatus = @status, UpdatedAt = SYSUTCDATETIME()
        WHERE CollegePartnerId = @id
      `);

    const updated = await this.getCollegePartnerById(id);
    if (!updated) throw new Error("College partner not found");
    return updated;
  }

  // --- Corporate Training Services ---
  async getCorporateTrainingServices(onlyActive = false): Promise<CorporateTrainingService[]> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("slug", sql.VarChar(200), "corporate_training_services")
      .query(`SELECT Body FROM dbo.NXA_WebsiteContent WHERE Slug = @slug`);

    if (!result.recordset || result.recordset.length === 0) return [];
    try {
      const services: CorporateTrainingService[] = JSON.parse(result.recordset[0].Body);
      return onlyActive ? services.filter((s) => s.isActive) : services;
    } catch {
      return [];
    }
  }

  async saveCorporateTrainingService(service: CorporateTrainingService, userId: string): Promise<CorporateTrainingService> {
    const services = await this.getCorporateTrainingServices();
    const targetId = service.id || `corp-${Date.now()}`;
    const prepared: CorporateTrainingService = { ...service, id: targetId };

    const idx = services.findIndex((s) => s.id === targetId);
    if (idx >= 0) {
      services[idx] = prepared;
    } else {
      services.push(prepared);
    }

    const pool = await this.getPool();
    await pool
      .request()
      .input("slug", sql.VarChar(200), "corporate_training_services")
      .input("title", sql.NVarChar(250), "Corporate Training Enterprise Tracks")
      .input("body", sql.NVarChar(sql.MAX), JSON.stringify(services))
      .input("contentType", sql.VarChar(40), "corporate")
      .input("userId", sql.BigInt, Number(userId) || 1)
      .query(`
        MERGE dbo.NXA_WebsiteContent AS target
        USING (SELECT @slug AS Slug) AS source
        ON (target.Slug = source.Slug)
        WHEN MATCHED THEN
          UPDATE SET Title = @title, Body = @body, UpdatedAt = SYSUTCDATETIME(), UpdatedByUserId = @userId
        WHEN NOT MATCHED THEN
          INSERT (ContentType, Slug, Title, Body, IsPublished, PublishedAt, CreatedAt, CreatedByUserId)
          VALUES (@contentType, @slug, @title, @body, 1, SYSUTCDATETIME(), SYSUTCDATETIME(), @userId);
      `);

    return prepared;
  }

  async deleteCorporateTrainingService(id: string, userId: string): Promise<boolean> {
    const services = await this.getCorporateTrainingServices();
    const filtered = services.filter((s) => s.id !== id);
    const pool = await this.getPool();
    await pool
      .request()
      .input("slug", sql.VarChar(200), "corporate_training_services")
      .input("body", sql.NVarChar(sql.MAX), JSON.stringify(filtered))
      .input("userId", sql.BigInt, Number(userId) || 1)
      .query(`
        UPDATE dbo.NXA_WebsiteContent
        SET Body = @body, UpdatedAt = SYSUTCDATETIME(), UpdatedByUserId = @userId
        WHERE Slug = @slug
      `);
    return true;
  }

  async updateCorporateTrainingServiceStatus(id: string, isActive: boolean, userId: string): Promise<CorporateTrainingService> {
    const services = await this.getCorporateTrainingServices();
    const idx = services.findIndex((s) => s.id === id);
    if (idx === -1) throw new Error("Corporate training service not found");
    const target = services[idx];
    if (!target) throw new Error("Corporate training service not found");
    target.isActive = isActive;
    await this.saveCorporateTrainingService(target, userId);
    return target;
  }

  // --- Page Content Configuration ---
  async getPageContent(slug: string, onlyPublished = false): Promise<PageContent | null> {
    const pool = await this.getPool();
    let query = `
      SELECT Slug, Title, Body, IsPublished, UpdatedAt, UpdatedByUserId
      FROM dbo.NXA_WebsiteContent
      WHERE Slug = @slug
    `;
    if (onlyPublished) {
      query += ` AND IsPublished = 1`;
    }

    const result = await pool.request().input("slug", sql.VarChar(200), slug).query(query);
    if (!result.recordset || result.recordset.length === 0) return null;

    const row = result.recordset[0];
    let contentObj: Record<string, unknown> = {};
    try {
      contentObj = JSON.parse(row.Body);
    } catch {
      contentObj = { raw: row.Body };
    }

    return {
      slug: row.Slug,
      title: row.Title,
      content: contentObj,
      isPublished: Boolean(row.IsPublished),
      updatedAt: row.UpdatedAt ? new Date(row.UpdatedAt).toISOString() : undefined,
      updatedByUserId: row.UpdatedByUserId ? String(row.UpdatedByUserId) : undefined,
    };
  }

  async savePageContent(content: PageContent, userId: string): Promise<PageContent> {
    const pool = await this.getPool();
    const bodyJson = JSON.stringify(content.content);

    await pool
      .request()
      .input("slug", sql.VarChar(200), content.slug)
      .input("title", sql.NVarChar(250), content.title)
      .input("body", sql.NVarChar(sql.MAX), bodyJson)
      .input("contentType", sql.VarChar(40), "page")
      .input("isPublished", sql.Bit, content.isPublished ? 1 : 0)
      .input("userId", sql.BigInt, Number(userId) || 1)
      .query(`
        MERGE dbo.NXA_WebsiteContent AS target
        USING (SELECT @slug AS Slug) AS source
        ON (target.Slug = source.Slug)
        WHEN MATCHED THEN
          UPDATE SET Title = @title, Body = @body, IsPublished = @isPublished, UpdatedAt = SYSUTCDATETIME(), UpdatedByUserId = @userId
        WHEN NOT MATCHED THEN
          INSERT (ContentType, Slug, Title, Body, IsPublished, PublishedAt, CreatedAt, CreatedByUserId)
          VALUES (@contentType, @slug, @title, @body, @isPublished, SYSUTCDATETIME(), SYSUTCDATETIME(), @userId);
      `);

    return content;
  }

  // --- Enquiries ---
  async submitEnquiry(enquiry: Omit<LeadEnquiry, "id" | "submittedAt" | "status">): Promise<LeadEnquiry> {
    const pool = await this.getPool();
    const insertResult = await pool
      .request()
      .input("enquiryType", sql.VarChar(40), enquiry.type)
      .input("enquirySource", sql.VarChar(40), "Public Website")
      .input("fullName", sql.NVarChar(150), enquiry.name)
      .input("email", sql.NVarChar(254), enquiry.email || null)
      .input("mobile", sql.VarChar(25), enquiry.phone)
      .input("collegeName", sql.NVarChar(200), enquiry.collegeName || enquiry.organization || null)
      .input("message", sql.NVarChar(sql.MAX), enquiry.message || null)
      .input("enquiryStatus", sql.VarChar(20), "new")
      .query(`
        INSERT INTO dbo.NXA_Enquiries (EnquiryType, EnquirySource, FullName, Email, Mobile, CollegeName, Message, EnquiryStatus, CreatedAt)
        OUTPUT INSERTED.EnquiryId, INSERTED.CreatedAt
        VALUES (@enquiryType, @enquirySource, @fullName, @email, @mobile, @collegeName, @message, @enquiryStatus, SYSUTCDATETIME())
      `);

    const row = insertResult.recordset[0];
    return {
      ...enquiry,
      id: String(row.EnquiryId),
      submittedAt: new Date(row.CreatedAt).toISOString(),
      status: "new",
    };
  }

  async getEnquiries(): Promise<LeadEnquiry[]> {
    const pool = await this.getPool();
    const result = await pool.request().query(`
      SELECT EnquiryId, EnquiryType, FullName, Email, Mobile, CollegeName, Message, EnquiryStatus, CreatedAt
      FROM dbo.NXA_Enquiries
      ORDER BY CreatedAt DESC
    `);

    return (result.recordset || []).map((row) => ({
      id: String(row.EnquiryId),
      type: (row.EnquiryType || "general") as any,
      name: row.FullName,
      email: row.Email || undefined,
      phone: row.Mobile || "",
      collegeName: row.CollegeName || undefined,
      message: row.Message || undefined,
      submittedAt: row.CreatedAt ? new Date(row.CreatedAt).toISOString() : new Date().toISOString(),
      status: (row.EnquiryStatus || "new") as any,
    }));
  }

  async updateEnquiryStatus(id: string, status: LeadEnquiry["status"]): Promise<LeadEnquiry> {
    const pool = await this.getPool();
    await pool
      .request()
      .input("id", sql.BigInt, Number(id) || 0)
      .input("status", sql.VarChar(20), status)
      .query(`
        UPDATE dbo.NXA_Enquiries
        SET EnquiryStatus = @status
        WHERE EnquiryId = @id
      `);

    const enquiries = await this.getEnquiries();
    const found = enquiries.find((e) => e.id === id);
    if (!found) throw new Error("Enquiry not found");
    return found;
  }

  // --- Newsletter ---
  async subscribeNewsletter(email: string): Promise<NewsletterSubscription> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("slug", sql.VarChar(200), "newsletter_subscribers")
      .query(`SELECT Body FROM dbo.NXA_WebsiteContent WHERE Slug = @slug`);

    let subscribers: NewsletterSubscription[] = [];
    if (result.recordset && result.recordset.length > 0) {
      try {
        subscribers = JSON.parse(result.recordset[0].Body);
      } catch {
        subscribers = [];
      }
    }

    const existing = subscribers.find((s) => s.email.toLowerCase() === email.toLowerCase());
    if (existing) {
      return existing;
    }

    const newSub: NewsletterSubscription = {
      id: `sub-${Date.now()}`,
      email,
      subscribedAt: new Date().toISOString(),
      isActive: true,
    };

    subscribers.push(newSub);
    await pool
      .request()
      .input("slug", sql.VarChar(200), "newsletter_subscribers")
      .input("title", sql.NVarChar(250), "Newsletter Subscribers")
      .input("body", sql.NVarChar(sql.MAX), JSON.stringify(subscribers))
      .input("contentType", sql.VarChar(40), "newsletter")
      .input("userId", sql.BigInt, 1)
      .query(`
        MERGE dbo.NXA_WebsiteContent AS target
        USING (SELECT @slug AS Slug) AS source
        ON (target.Slug = source.Slug)
        WHEN MATCHED THEN
          UPDATE SET Title = @title, Body = @body, UpdatedAt = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN
          INSERT (ContentType, Slug, Title, Body, IsPublished, PublishedAt, CreatedAt, CreatedByUserId)
          VALUES (@contentType, @slug, @title, @body, 1, SYSUTCDATETIME(), SYSUTCDATETIME(), @userId);
      `);

    return newSub;
  }
}
