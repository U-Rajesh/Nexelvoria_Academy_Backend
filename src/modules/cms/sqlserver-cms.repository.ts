import { randomUUID } from "node:crypto";
import sql from "mssql";
import { getSqlServerPool } from "../../db/sqlserver.pool";
import { CompanyInUseError, CmsRuleError, CMS_COLLECTIONS, type CmsCollectionKey, type CmsRepository } from "./cms.repository";
import { RecordNotFoundError } from "../../repositories/repository.errors";
import { writeAuditLog } from "../admin/sqlserver-admin.repository";
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
import { applyCollectionRules, describeChange, sortCollection, type CmsAudit } from "./cms.rules";

/** BIGINT identity / NXA_Users id. A non-numeric actor is recorded as NULL, never as a made-up user. */
const isId = (id: string | undefined | null): id is string => typeof id === "string" && /^\d{1,19}$/.test(id);
const actorOrNull = (userId: string): string | null => (isId(userId) ? userId : null);

const MODULE = "WEBSITE_CMS";

/** Runs one CMS change and its audit row in a single transaction. */
type Tx = sql.Transaction;

export class SqlServerCmsRepository implements CmsRepository {
  constructor(private readonly getPool: () => Promise<sql.ConnectionPool> = getSqlServerPool) {}

  private async inTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    const pool = await this.getPool();
    const tx = pool.transaction();
    await tx.begin();
    try {
      const result = await work(tx);
      await tx.commit();
      return result;
    } catch (err) {
      try {
        await tx.rollback();
      } catch {
        // the original error is the one worth reporting
      }
      throw err;
    }
  }

  private async audit(tx: Tx, userId: string, a: CmsAudit): Promise<void> {
    await writeAuditLog(tx.request(), {
      actorUserId: userId,
      actionType: a.action,
      moduleCode: MODULE,
      entityName: a.entityName,
      entityId: a.entityId,
      ...(a.oldValues === undefined ? {} : { oldValues: JSON.stringify(a.oldValues) }),
      ...(a.newValues === undefined ? {} : { newValues: JSON.stringify(a.newValues) }),
    });
  }

  // ------------------------------------------------------------------------
  // JSON collections stored in NXA_WebsiteContent (one row per collection).
  // Reads are plain; every write locks the row (UPDLOCK, HOLDLOCK) so two
  // concurrent saves cannot overwrite each other, then writes body + audit
  // in one transaction. An unchanged collection writes nothing.
  // ------------------------------------------------------------------------
  private async readCollection<T>(key: CmsCollectionKey): Promise<T[]> {
    const pool = await this.getPool();
    const result = await pool.request().input("slug", sql.VarChar(200), CMS_COLLECTIONS[key].slug).query(`SELECT Body FROM dbo.NXA_WebsiteContent WHERE Slug = @slug`);
    return parseList<T>(result.recordset[0]?.Body);
  }

  private async mutateCollection<T extends { id: string }, R>(
    key: CmsCollectionKey,
    userId: string,
    mutate: (items: T[]) => { items: T[]; result: R; audit: CmsAudit } | { noop: true; result: R },
  ): Promise<R> {
    const c = CMS_COLLECTIONS[key];
    return this.inTransaction(async (tx) => {
      const cur = await tx
        .request()
        .input("slug", sql.VarChar(200), c.slug)
        .query(`SELECT Body FROM dbo.NXA_WebsiteContent WITH (UPDLOCK, HOLDLOCK) WHERE Slug = @slug`);
      const exists = cur.recordset.length > 0;
      const outcome = mutate(parseList<T>(cur.recordset[0]?.Body));
      if ("noop" in outcome) return outcome.result;
      const req = tx
        .request()
        .input("slug", sql.VarChar(200), c.slug)
        .input("title", sql.NVarChar(250), c.title)
        .input("body", sql.NVarChar(sql.MAX), JSON.stringify(sortCollection(key, outcome.items)))
        .input("contentType", sql.VarChar(40), c.contentType)
        .input("userId", sql.BigInt, actorOrNull(userId));
      if (exists) {
        await req.query(`UPDATE dbo.NXA_WebsiteContent SET Body = @body, UpdatedAt = SYSUTCDATETIME(), UpdatedByUserId = @userId WHERE Slug = @slug`);
      } else {
        // The collection row itself is published; item visibility lives on each item.
        await req.query(`
          INSERT INTO dbo.NXA_WebsiteContent (ContentType, Slug, Title, Body, IsPublished, PublishedAt, CreatedAt, CreatedByUserId)
          VALUES (@contentType, @slug, @title, @body, 1, SYSUTCDATETIME(), SYSUTCDATETIME(), @userId)
        `);
      }
      await this.audit(tx, userId, outcome.audit);
      return outcome.result;
    });
  }

  /** Create (no or unknown id) or update one item of a collection, applying the approved rules. */
  private saveItem<T extends { id: string }>(key: CmsCollectionKey, item: T, userId: string, newIdPrefix: string): Promise<T> {
    return this.mutateCollection<T, T>(key, userId, (items) => {
      const idx = item.id ? items.findIndex((x) => x.id === item.id) : -1;
      if (item.id && idx === -1) throw new RecordNotFoundError(CMS_COLLECTIONS[key].entityName, item.id);
      const before = idx >= 0 ? items[idx] : undefined;
      const prepared = applyCollectionRules(key, { ...item, id: before ? item.id : `${newIdPrefix}-${randomUUID()}` }, before) as T;
      const change = describeChange(CMS_COLLECTIONS[key].entityName, CMS_COLLECTIONS[key].visibilityField, before, prepared);
      if (!change) return { noop: true, result: before as T };
      const next = before ? items.map((x, i) => (i === idx ? prepared : x)) : [...items, prepared];
      return { items: next, result: prepared, audit: change };
    });
  }

  private deleteItem<T extends { id: string }>(key: CmsCollectionKey, id: string, userId: string): Promise<boolean> {
    return this.mutateCollection<T, boolean>(key, userId, (items) => {
      const found = items.find((x) => x.id === id);
      if (!found) throw new RecordNotFoundError(CMS_COLLECTIONS[key].entityName, id);
      return {
        items: items.filter((x) => x.id !== id),
        result: true,
        audit: { action: "CMS_DELETE", entityName: CMS_COLLECTIONS[key].entityName, entityId: id, oldValues: summarize(found) },
      };
    });
  }

  // --- Banners (announcement bars; NXA_WebsiteBanners needs an image object key and file storage is absent) ---
  async getBanners(onlyActive = false): Promise<WebsiteBanner[]> {
    const items = await this.readCollection<WebsiteBanner>("banners");
    return onlyActive ? items.filter((b) => b.isActive) : items;
  }

  async saveBanners(banners: WebsiteBanner[], userId: string): Promise<WebsiteBanner[]> {
    return this.mutateCollection<WebsiteBanner, WebsiteBanner[]>("banners", userId, (items) => {
      const known = new Set(items.map((b) => b.id));
      const unknown = banners.find((b) => b.id && !known.has(b.id));
      if (unknown) throw new RecordNotFoundError("Banner", unknown.id);
      const next = banners.map((b) => ({ ...b, id: b.id || `banner-${randomUUID()}` }));
      if (JSON.stringify(next) === JSON.stringify(items)) return { noop: true, result: items };
      const ids = (list: WebsiteBanner[]) => new Set(list.map((b) => b.id));
      const after = ids(next);
      return {
        items: next,
        result: next,
        audit: {
          action: "CMS_UPDATE",
          entityName: "BannerSet",
          entityId: CMS_COLLECTIONS.banners.slug,
          newValues: {
            created: next.filter((b) => !known.has(b.id)).map((b) => b.id),
            removed: [...known].filter((id) => !after.has(id)),
            active: next.filter((b) => b.isActive).map((b) => b.id),
          },
        },
      };
    });
  }

  async deleteBanner(id: string, userId: string): Promise<boolean> {
    return this.deleteItem<WebsiteBanner>("banners", id, userId);
  }

  // --- Testimonials / Trainers / Achievements / Careers / Corporate services ---
  async getTestimonials(onlyPublished = false): Promise<TestimonialItem[]> {
    const items = sortCollection("testimonials", await this.readCollection<TestimonialItem>("testimonials"));
    return onlyPublished ? items.filter((t) => t.isPublished) : items;
  }
  async saveTestimonial(t: TestimonialItem, userId: string): Promise<TestimonialItem> {
    return this.saveItem("testimonials", t, userId, "testi");
  }
  async deleteTestimonial(id: string, userId: string): Promise<boolean> {
    return this.deleteItem<TestimonialItem>("testimonials", id, userId);
  }

  async getTrainers(onlyActive = false): Promise<TrainerProfile[]> {
    const items = sortCollection("trainers", await this.readCollection<TrainerProfile>("trainers"));
    return onlyActive ? items.filter((t) => t.isActive) : items;
  }
  async saveTrainer(t: TrainerProfile, userId: string): Promise<TrainerProfile> {
    return this.saveItem("trainers", t, userId, "trn");
  }
  async deleteTrainer(id: string, userId: string): Promise<boolean> {
    return this.deleteItem<TrainerProfile>("trainers", id, userId);
  }

  async getAchievements(onlyActive = false): Promise<AchievementItem[]> {
    const items = sortCollection("achievements", await this.readCollection<AchievementItem>("achievements"));
    return onlyActive ? items.filter((a) => a.isActive) : items;
  }
  async saveAchievement(a: AchievementItem, userId: string): Promise<AchievementItem> {
    return this.saveItem("achievements", a, userId, "ach");
  }
  async deleteAchievement(id: string, userId: string): Promise<boolean> {
    return this.deleteItem<AchievementItem>("achievements", id, userId);
  }

  async getCareers(onlyActive = false): Promise<CareerOpening[]> {
    const items = await this.readCollection<CareerOpening>("careers");
    return onlyActive ? items.filter((c) => c.isActive) : items;
  }
  async saveCareer(c: CareerOpening, userId: string): Promise<CareerOpening> {
    return this.saveItem("careers", c, userId, "career");
  }
  async deleteCareer(id: string, userId: string): Promise<boolean> {
    return this.deleteItem<CareerOpening>("careers", id, userId);
  }

  async getCorporateTrainingServices(onlyActive = false): Promise<CorporateTrainingService[]> {
    const items = sortCollection("corporate", await this.readCollection<CorporateTrainingService>("corporate"));
    return onlyActive ? items.filter((s) => s.isActive) : items;
  }
  async saveCorporateTrainingService(s: CorporateTrainingService, userId: string): Promise<CorporateTrainingService> {
    return this.saveItem("corporate", s, userId, "corp");
  }
  async deleteCorporateTrainingService(id: string, userId: string): Promise<boolean> {
    return this.deleteItem<CorporateTrainingService>("corporate", id, userId);
  }
  async updateCorporateTrainingServiceStatus(id: string, isActive: boolean, userId: string): Promise<CorporateTrainingService> {
    const current = (await this.readCollection<CorporateTrainingService>("corporate")).find((s) => s.id === id);
    if (!current) throw new RecordNotFoundError("CorporateTrainingService", id);
    return this.saveItem("corporate", { ...current, isActive }, userId, "corp");
  }
  async reorderCorporateTrainingServices(ids: string[], userId: string): Promise<CorporateTrainingService[]> {
    return this.mutateCollection<CorporateTrainingService, CorporateTrainingService[]>("corporate", userId, (items) => {
      if (ids.length !== items.length || new Set(ids).size !== ids.length || ids.some((id) => !items.find((s) => s.id === id))) {
        throw new CmsRuleError("REORDER_MISMATCH", "The new order must list every service exactly once.");
      }
      const next = ids.map((id, i) => ({ ...items.find((s) => s.id === id)!, order: i + 1 }));
      if (next.every((s) => items.find((x) => x.id === s.id)!.order === s.order)) return { noop: true, result: sortCollection("corporate", items) };
      return { items: next, result: next, audit: { action: "CMS_REORDER", entityName: "CorporateTrainingService", entityId: CMS_COLLECTIONS.corporate.slug, newValues: { order: ids } } };
    });
  }

  // --- Blog articles (NXA_BlogArticles) ---
  private static readonly ARTICLE_SELECT = `SELECT BlogArticleId, Title, Slug, Summary, Body, IsPublished, PublishedAt, CreatedAt FROM dbo.NXA_BlogArticles`;

  async getArticles(onlyPublished = false): Promise<BlogArticle[]> {
    const pool = await this.getPool();
    const result = await pool.request().query(`${SqlServerCmsRepository.ARTICLE_SELECT}${onlyPublished ? " WHERE IsPublished = 1" : ""} ORDER BY CreatedAt DESC, BlogArticleId DESC`);
    return (result.recordset || []).map(toArticle);
  }

  async getArticleBySlug(slug: string, onlyPublished = false): Promise<BlogArticle | null> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("slug", sql.VarChar(200), slug)
      .query(`${SqlServerCmsRepository.ARTICLE_SELECT} WHERE Slug = @slug${onlyPublished ? " AND IsPublished = 1" : ""}`);
    return result.recordset[0] ? toArticle(result.recordset[0]) : null;
  }

  async saveArticle(article: BlogArticle, userId: string): Promise<BlogArticle> {
    if (article.id && !isId(article.id)) throw new RecordNotFoundError("BlogArticle", article.id);
    const body = JSON.stringify({
      category: article.category, author: article.author, authorRole: article.authorRole, authorAvatar: article.authorAvatar,
      readTime: article.readTime, content: article.content, tags: article.tags, featuredImage: article.featuredImage, order: article.order,
    });
    const id = await this.inTransaction(async (tx) => {
      const dup = await tx
        .request()
        .input("slug", sql.VarChar(200), article.slug)
        .input("id", sql.BigInt, article.id || null)
        .query(`SELECT TOP 1 1 AS x FROM dbo.NXA_BlogArticles WITH (UPDLOCK, HOLDLOCK) WHERE Slug = @slug AND (@id IS NULL OR BlogArticleId <> @id)`);
      if (dup.recordset.length > 0) throw new CmsRuleError("SLUG_TAKEN", "Another article already uses this slug.", 409);

      if (article.id) {
        const cur = await tx.request().input("id", sql.BigInt, article.id).query(`${SqlServerCmsRepository.ARTICLE_SELECT} WITH (UPDLOCK, HOLDLOCK) WHERE BlogArticleId = @id`);
        if (!cur.recordset[0]) throw new RecordNotFoundError("BlogArticle", article.id);
        const before = toArticle(cur.recordset[0]);
        const change = describeChange("BlogArticle", "isPublished", { ...before, date: undefined }, { ...article, id: before.id, date: undefined });
        if (!change) return article.id;
        // PublishedAt marks the first publication; a draft keeps it NULL.
        await tx
          .request()
          .input("id", sql.BigInt, article.id)
          .input("title", sql.NVarChar(250), article.title)
          .input("slug", sql.VarChar(200), article.slug)
          .input("summary", sql.NVarChar(1000), article.excerpt)
          .input("body", sql.NVarChar(sql.MAX), body)
          .input("isPublished", sql.Bit, article.isPublished ? 1 : 0)
          .query(`
            UPDATE dbo.NXA_BlogArticles
            SET Title = @title, Slug = @slug, Summary = @summary, Body = @body, IsPublished = @isPublished,
                PublishedAt = CASE WHEN @isPublished = 1 AND PublishedAt IS NULL THEN SYSUTCDATETIME() ELSE PublishedAt END
            WHERE BlogArticleId = @id
          `);
        await this.audit(tx, userId, change);
        return article.id;
      }
      const ins = await tx
        .request()
        .input("title", sql.NVarChar(250), article.title)
        .input("slug", sql.VarChar(200), article.slug)
        .input("summary", sql.NVarChar(1000), article.excerpt)
        .input("body", sql.NVarChar(sql.MAX), body)
        .input("authorUserId", sql.BigInt, actorOrNull(userId))
        .input("isPublished", sql.Bit, article.isPublished ? 1 : 0)
        .query(`
          INSERT INTO dbo.NXA_BlogArticles (Title, Slug, Summary, Body, AuthorUserId, IsPublished, PublishedAt, CreatedAt)
          OUTPUT INSERTED.BlogArticleId
          VALUES (@title, @slug, @summary, @body, @authorUserId, @isPublished, CASE WHEN @isPublished = 1 THEN SYSUTCDATETIME() ELSE NULL END, SYSUTCDATETIME())
        `);
      const newId = String(ins.recordset[0].BlogArticleId);
      await this.audit(tx, userId, { action: "CMS_CREATE", entityName: "BlogArticle", entityId: newId, newValues: { slug: article.slug, title: article.title, isPublished: article.isPublished } });
      return newId;
    });
    const saved = await this.getArticleById(id);
    if (!saved) throw new RecordNotFoundError("BlogArticle", id);
    return saved;
  }

  private async getArticleById(id: string): Promise<BlogArticle | null> {
    const pool = await this.getPool();
    const r = await pool.request().input("id", sql.BigInt, id).query(`${SqlServerCmsRepository.ARTICLE_SELECT} WHERE BlogArticleId = @id`);
    return r.recordset[0] ? toArticle(r.recordset[0]) : null;
  }

  async deleteArticle(id: string, userId: string): Promise<boolean> {
    if (!isId(id)) throw new RecordNotFoundError("BlogArticle", id);
    return this.inTransaction(async (tx) => {
      const del = await tx.request().input("id", sql.BigInt, id).query(`DELETE FROM dbo.NXA_BlogArticles OUTPUT DELETED.Slug, DELETED.Title WHERE BlogArticleId = @id`);
      const row = del.recordset[0];
      if (!row) throw new RecordNotFoundError("BlogArticle", id);
      await this.audit(tx, userId, { action: "CMS_DELETE", entityName: "BlogArticle", entityId: id, oldValues: { slug: row.Slug, title: row.Title } });
      return true;
    });
  }

  // --- FAQs (NXA_Faqs has no category column: category is not stored) ---
  async getFaqs(onlyActive = false): Promise<FAQItem[]> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .query(`SELECT FaqId, Question, Answer, DisplayOrder, IsPublished FROM dbo.NXA_Faqs${onlyActive ? " WHERE IsPublished = 1" : ""} ORDER BY DisplayOrder ASC, Question ASC, FaqId ASC`);
    return (result.recordset || []).map(toFaq);
  }

  async saveFaq(faq: FAQItem, userId: string): Promise<FAQItem> {
    if (faq.id && !isId(faq.id)) throw new RecordNotFoundError("Faq", faq.id);
    const id = await this.inTransaction(async (tx) => {
      if (faq.id) {
        const cur = await tx.request().input("id", sql.BigInt, faq.id).query(`SELECT FaqId, Question, Answer, DisplayOrder, IsPublished FROM dbo.NXA_Faqs WITH (UPDLOCK, HOLDLOCK) WHERE FaqId = @id`);
        if (!cur.recordset[0]) throw new RecordNotFoundError("Faq", faq.id);
        const before = toFaq(cur.recordset[0]);
        const change = describeChange("Faq", "isActive", { ...before, category: undefined }, { ...faq, id: before.id, category: undefined });
        if (!change) return faq.id;
        await tx
          .request()
          .input("id", sql.BigInt, faq.id)
          .input("question", sql.NVarChar(500), faq.question)
          .input("answer", sql.NVarChar(sql.MAX), faq.answer)
          .input("order", sql.Int, faq.order)
          .input("isPublished", sql.Bit, faq.isActive ? 1 : 0)
          .query(`UPDATE dbo.NXA_Faqs SET Question = @question, Answer = @answer, DisplayOrder = @order, IsPublished = @isPublished WHERE FaqId = @id`);
        await this.audit(tx, userId, change);
        return faq.id;
      }
      // Approved rule: a new FAQ starts hidden.
      const ins = await tx
        .request()
        .input("question", sql.NVarChar(500), faq.question)
        .input("answer", sql.NVarChar(sql.MAX), faq.answer)
        .input("order", sql.Int, faq.order)
        .query(`INSERT INTO dbo.NXA_Faqs (Question, Answer, DisplayOrder, IsPublished) OUTPUT INSERTED.FaqId VALUES (@question, @answer, @order, 0)`);
      const newId = String(ins.recordset[0].FaqId);
      await this.audit(tx, userId, { action: "CMS_CREATE", entityName: "Faq", entityId: newId, newValues: { question: faq.question, isActive: false } });
      return newId;
    });
    const pool = await this.getPool();
    const r = await pool.request().input("id", sql.BigInt, id).query(`SELECT FaqId, Question, Answer, DisplayOrder, IsPublished FROM dbo.NXA_Faqs WHERE FaqId = @id`);
    if (!r.recordset[0]) throw new RecordNotFoundError("Faq", id);
    return toFaq(r.recordset[0]);
  }

  async deleteFaq(id: string, userId: string): Promise<boolean> {
    if (!isId(id)) throw new RecordNotFoundError("Faq", id);
    return this.inTransaction(async (tx) => {
      const del = await tx.request().input("id", sql.BigInt, id).query(`DELETE FROM dbo.NXA_Faqs OUTPUT DELETED.Question WHERE FaqId = @id`);
      if (!del.recordset[0]) throw new RecordNotFoundError("Faq", id);
      await this.audit(tx, userId, { action: "CMS_DELETE", entityName: "Faq", entityId: id, oldValues: { question: del.recordset[0].Question } });
      return true;
    });
  }

  // --- Hiring partners (NXA_Companies; no logo / featured / order columns) ---
  private static readonly PARTNER_SELECT = `
    SELECT c.CompanyId, c.CompanyName, c.Industry, c.WebsiteUrl, c.IsActive,
           (SELECT COUNT(1) FROM dbo.NXA_PlacementRecords p WHERE p.CompanyId = c.CompanyId) AS PlacementsCount
    FROM dbo.NXA_Companies c
  `;

  private static toPartner(row: { CompanyId: number | bigint; CompanyName: string; Industry: string | null; WebsiteUrl: string | null; IsActive: boolean; PlacementsCount: number | null }): HiringPartner {
    return {
      id: String(row.CompanyId),
      name: row.CompanyName,
      ...(row.Industry ? { industry: row.Industry } : {}),
      ...(row.WebsiteUrl ? { websiteUrl: row.WebsiteUrl } : {}),
      placementsCount: Number(row.PlacementsCount ?? 0),
      isActive: Boolean(row.IsActive),
    };
  }

  async getHiringPartners(onlyActive = false): Promise<HiringPartner[]> {
    const pool = await this.getPool();
    const result = await pool.request().query(`${SqlServerCmsRepository.PARTNER_SELECT}${onlyActive ? " WHERE c.IsActive = 1" : ""} ORDER BY c.CompanyName ASC`);
    return (result.recordset || []).map((row) => SqlServerCmsRepository.toPartner(row));
  }

  private async getHiringPartnerById(id: string): Promise<HiringPartner | null> {
    const pool = await this.getPool();
    const result = await pool.request().input("id", sql.BigInt, id).query(`${SqlServerCmsRepository.PARTNER_SELECT} WHERE c.CompanyId = @id`);
    const row = result.recordset[0];
    return row ? SqlServerCmsRepository.toPartner(row) : null;
  }

  /**
   * Stores only what NXA_Companies holds: name, industry, website and active
   * flag. A non-numeric id is refused (never treated as "create").
   */
  async saveHiringPartner(partner: HiringPartner, userId: string): Promise<HiringPartner> {
    if (partner.id && !isId(partner.id)) throw new RecordNotFoundError("hiring partner", partner.id);
    const id = await this.inTransaction(async (tx) => {
      if (partner.id) {
        const cur = await tx.request().input("id", sql.BigInt, partner.id).query(`SELECT CompanyName, Industry, WebsiteUrl, IsActive FROM dbo.NXA_Companies WITH (UPDLOCK, HOLDLOCK) WHERE CompanyId = @id`);
        const row = cur.recordset[0];
        if (!row) throw new RecordNotFoundError("hiring partner", partner.id);
        const before = { name: row.CompanyName, industry: row.Industry ?? undefined, websiteUrl: row.WebsiteUrl ?? undefined, isActive: Boolean(row.IsActive) };
        const after = { name: partner.name, industry: partner.industry, websiteUrl: partner.websiteUrl, isActive: partner.isActive };
        const change = describeChange("HiringPartner", "isActive", { id: partner.id, ...before }, { id: partner.id, ...after });
        if (!change) return partner.id;
        await tx
          .request()
          .input("id", sql.BigInt, partner.id)
          .input("name", sql.NVarChar(200), partner.name)
          .input("industry", sql.NVarChar(120), partner.industry ?? null)
          .input("websiteUrl", sql.NVarChar(500), partner.websiteUrl ?? null)
          .input("isActive", sql.Bit, partner.isActive ? 1 : 0)
          .query(`UPDATE dbo.NXA_Companies SET CompanyName = @name, Industry = @industry, WebsiteUrl = @websiteUrl, IsActive = @isActive WHERE CompanyId = @id`);
        await this.audit(tx, userId, change);
        return partner.id;
      }
      const ins = await tx
        .request()
        .input("name", sql.NVarChar(200), partner.name)
        .input("industry", sql.NVarChar(120), partner.industry ?? null)
        .input("websiteUrl", sql.NVarChar(500), partner.websiteUrl ?? null)
        .input("isActive", sql.Bit, partner.isActive ? 1 : 0)
        .query(`INSERT INTO dbo.NXA_Companies (CompanyName, Industry, WebsiteUrl, IsActive, CreatedAt) OUTPUT INSERTED.CompanyId VALUES (@name, @industry, @websiteUrl, @isActive, SYSUTCDATETIME())`);
      const newId = String(ins.recordset[0].CompanyId);
      await this.audit(tx, userId, { action: "CMS_CREATE", entityName: "HiringPartner", entityId: newId, newValues: { name: partner.name, isActive: partner.isActive } });
      return newId;
    });
    const saved = await this.getHiringPartnerById(id);
    if (!saved) throw new RecordNotFoundError("hiring partner", id);
    return saved;
  }

  async deleteHiringPartner(id: string, userId: string): Promise<boolean> {
    if (!isId(id)) throw new RecordNotFoundError("hiring partner", id);
    try {
      return await this.inTransaction(async (tx) => {
        const del = await tx.request().input("id", sql.BigInt, id).query(`DELETE FROM dbo.NXA_Companies OUTPUT DELETED.CompanyName WHERE CompanyId = @id`);
        if (!del.recordset[0]) throw new RecordNotFoundError("hiring partner", id);
        await this.audit(tx, userId, { action: "CMS_DELETE", entityName: "HiringPartner", entityId: id, oldValues: { name: del.recordset[0].CompanyName } });
        return true;
      });
    } catch (err) {
      const e = err as { number?: number; originalError?: { info?: { number?: number } } };
      // Jobs, placement records or feedback still reference the company.
      if ((e?.number ?? e?.originalError?.info?.number) === 547) throw new CompanyInUseError(id);
      throw err;
    }
  }

  // --- College partners (NXA_CollegePartners) ---
  private static readonly COLLEGE_SELECT = `SELECT CollegePartnerId, CollegeName, PartnershipType, Address, ContactName, ContactEmail, ContactMobile, WebsiteUrl, PartnerStatus, Notes, CreatedAt FROM dbo.NXA_CollegePartners`;

  async getCollegePartners(onlyActive = false): Promise<CollegePartner[]> {
    const pool = await this.getPool();
    const result = await pool.request().query(`${SqlServerCmsRepository.COLLEGE_SELECT}${onlyActive ? " WHERE PartnerStatus = 'active'" : ""} ORDER BY CreatedAt DESC, CollegePartnerId DESC`);
    return (result.recordset || []).map(toCollege);
  }

  async getCollegePartnerById(id: string): Promise<CollegePartner | null> {
    if (!isId(id)) return null;
    const pool = await this.getPool();
    const result = await pool.request().input("id", sql.BigInt, id).query(`${SqlServerCmsRepository.COLLEGE_SELECT} WHERE CollegePartnerId = @id`);
    return result.recordset[0] ? toCollege(result.recordset[0]) : null;
  }

  async saveCollegePartner(partner: CollegePartner, userId: string): Promise<CollegePartner> {
    if (partner.id && !isId(partner.id)) throw new RecordNotFoundError("CollegePartner", partner.id);
    const bind = (r: sql.Request) =>
      r
        .input("collegeName", sql.NVarChar(200), partner.collegeName)
        .input("partnershipType", sql.VarChar(40), partner.partnershipType || null)
        .input("address", sql.NVarChar(700), partner.location || null)
        .input("contactName", sql.NVarChar(150), partner.contactPerson || null)
        .input("contactEmail", sql.NVarChar(254), partner.contactEmail || null)
        .input("contactMobile", sql.VarChar(25), partner.contactMobile || null)
        .input("websiteUrl", sql.NVarChar(500), partner.websiteUrl || null)
        .input("partnerStatus", sql.VarChar(20), partner.status)
        .input("notes", sql.NVarChar(1000), partner.notes || null);
    const id = await this.inTransaction(async (tx) => {
      if (partner.id) {
        const cur = await tx.request().input("id", sql.BigInt, partner.id).query(`${SqlServerCmsRepository.COLLEGE_SELECT} WITH (UPDLOCK, HOLDLOCK) WHERE CollegePartnerId = @id`);
        if (!cur.recordset[0]) throw new RecordNotFoundError("CollegePartner", partner.id);
        const before = toCollege(cur.recordset[0]);
        const change = describeChange("CollegePartner", "status", { ...before, createdAt: undefined }, { ...partner, createdAt: undefined });
        if (!change) return partner.id;
        await bind(tx.request().input("id", sql.BigInt, partner.id)).query(`
          UPDATE dbo.NXA_CollegePartners
          SET CollegeName = @collegeName, PartnershipType = @partnershipType, Address = @address, ContactName = @contactName,
              ContactEmail = @contactEmail, ContactMobile = @contactMobile, WebsiteUrl = @websiteUrl, PartnerStatus = @partnerStatus,
              Notes = @notes, UpdatedAt = SYSUTCDATETIME()
          WHERE CollegePartnerId = @id
        `);
        await this.audit(tx, userId, change);
        return partner.id;
      }
      const ins = await bind(tx.request().input("createdByUserId", sql.BigInt, actorOrNull(userId))).query(`
        INSERT INTO dbo.NXA_CollegePartners (CollegeName, PartnershipType, Address, ContactName, ContactEmail, ContactMobile, WebsiteUrl, PartnerStatus, Notes, CreatedAt, CreatedByUserId)
        OUTPUT INSERTED.CollegePartnerId
        VALUES (@collegeName, @partnershipType, @address, @contactName, @contactEmail, @contactMobile, @websiteUrl, @partnerStatus, @notes, SYSUTCDATETIME(), @createdByUserId)
      `);
      const newId = String(ins.recordset[0].CollegePartnerId);
      await this.audit(tx, userId, { action: "CMS_CREATE", entityName: "CollegePartner", entityId: newId, newValues: { collegeName: partner.collegeName, status: partner.status } });
      return newId;
    });
    const saved = await this.getCollegePartnerById(id);
    if (!saved) throw new RecordNotFoundError("CollegePartner", id);
    return saved;
  }

  async deleteCollegePartner(id: string, userId: string): Promise<boolean> {
    if (!isId(id)) throw new RecordNotFoundError("CollegePartner", id);
    return this.inTransaction(async (tx) => {
      const del = await tx.request().input("id", sql.BigInt, id).query(`DELETE FROM dbo.NXA_CollegePartners OUTPUT DELETED.CollegeName WHERE CollegePartnerId = @id`);
      if (!del.recordset[0]) throw new RecordNotFoundError("CollegePartner", id);
      await this.audit(tx, userId, { action: "CMS_DELETE", entityName: "CollegePartner", entityId: id, oldValues: { collegeName: del.recordset[0].CollegeName } });
      return true;
    });
  }

  async updateCollegePartnerStatus(id: string, status: "active" | "inactive" | "mou_in_progress", userId: string): Promise<CollegePartner> {
    const current = await this.getCollegePartnerById(id);
    if (!current) throw new RecordNotFoundError("CollegePartner", id);
    return this.saveCollegePartner({ ...current, status }, userId);
  }

  // --- Page content (singleton configs; NXA_WebsiteContent rows of ContentType 'page') ---
  async getPageContent(slug: string, onlyPublished = false): Promise<PageContent | null> {
    const pool = await this.getPool();
    // Collection rows (testimonials_list, ...) are never readable as pages: they hold hidden items.
    const result = await pool
      .request()
      .input("slug", sql.VarChar(200), slug)
      .query(`SELECT Slug, Title, Body, IsPublished, UpdatedAt, UpdatedByUserId FROM dbo.NXA_WebsiteContent WHERE Slug = @slug AND ContentType = 'page'${onlyPublished ? " AND IsPublished = 1" : ""}`);
    return result.recordset[0] ? toPage(result.recordset[0]) : null;
  }

  async savePageContent(content: PageContent, userId: string): Promise<PageContent> {
    await this.inTransaction(async (tx) => {
      const cur = await tx
        .request()
        .input("slug", sql.VarChar(200), content.slug)
        .query(`SELECT Slug, Title, Body, IsPublished, ContentType, UpdatedAt, UpdatedByUserId FROM dbo.NXA_WebsiteContent WITH (UPDLOCK, HOLDLOCK) WHERE Slug = @slug`);
      const row = cur.recordset[0];
      if (row && row.ContentType !== "page") throw new CmsRuleError("NOT_A_PAGE", "This slug is not editable page content.");
      const req = tx
        .request()
        .input("slug", sql.VarChar(200), content.slug)
        .input("title", sql.NVarChar(250), content.title)
        .input("body", sql.NVarChar(sql.MAX), JSON.stringify(content.content))
        .input("isPublished", sql.Bit, content.isPublished ? 1 : 0)
        .input("userId", sql.BigInt, actorOrNull(userId));
      if (row) {
        const before = toPage(row);
        const change = describeChange("PageContent", "isPublished", { id: content.slug, title: before.title, content: before.content, isPublished: before.isPublished }, { id: content.slug, title: content.title, content: content.content, isPublished: content.isPublished });
        if (!change) return;
        await req.query(`
          UPDATE dbo.NXA_WebsiteContent
          SET Title = @title, Body = @body, IsPublished = @isPublished, UpdatedAt = SYSUTCDATETIME(), UpdatedByUserId = @userId,
              PublishedAt = CASE WHEN @isPublished = 1 AND PublishedAt IS NULL THEN SYSUTCDATETIME() ELSE PublishedAt END
          WHERE Slug = @slug
        `);
        // Large page bodies are summarised by changed keys, not copied into the audit log.
        await this.audit(tx, userId, { ...change, oldValues: undefined, newValues: { changedKeys: changedKeys(before.content, content.content), isPublished: content.isPublished } });
        return;
      }
      await req.query(`
        INSERT INTO dbo.NXA_WebsiteContent (ContentType, Slug, Title, Body, IsPublished, PublishedAt, CreatedAt, CreatedByUserId)
        VALUES ('page', @slug, @title, @body, @isPublished, CASE WHEN @isPublished = 1 THEN SYSUTCDATETIME() ELSE NULL END, SYSUTCDATETIME(), @userId)
      `);
      await this.audit(tx, userId, { action: "CMS_CREATE", entityName: "PageContent", entityId: content.slug, newValues: { title: content.title, isPublished: content.isPublished } });
    });
    const saved = await this.getPageContent(content.slug);
    if (!saved) throw new RecordNotFoundError("PageContent", content.slug);
    return saved;
  }

  // --- Enquiries (NXA_Enquiries) and callback requests (NXA_CallbackRequests) ---
  async submitEnquiry(enquiry: Omit<LeadEnquiry, "id" | "submittedAt" | "status">): Promise<LeadEnquiry> {
    const pool = await this.getPool();
    // A course is linked only when the client sent a real course id (FK to NXA_Courses).
    const courseId = isId(enquiry.courseOfInterest) ? enquiry.courseOfInterest : null;
    // NXA_Enquiries has no course-name or time-slot column: they are kept in the message instead of being lost.
    const message = [
      enquiry.message,
      enquiry.courseOfInterest && !courseId ? `Course of interest: ${enquiry.courseOfInterest}` : null,
      enquiry.preferredTimeSlot ? `Preferred time: ${enquiry.preferredTimeSlot}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    const ins = await pool
      .request()
      .input("enquiryType", sql.VarChar(40), enquiry.type)
      .input("enquirySource", sql.VarChar(40), "Public Website")
      .input("fullName", sql.NVarChar(150), enquiry.name)
      .input("email", sql.NVarChar(254), enquiry.email || null)
      .input("mobile", sql.VarChar(25), enquiry.phone || null)
      .input("collegeName", sql.NVarChar(200), enquiry.collegeName || enquiry.organization || enquiry.companyName || null)
      .input("courseId", sql.BigInt, courseId)
      .input("message", sql.NVarChar(sql.MAX), message || null)
      .query(`
        INSERT INTO dbo.NXA_Enquiries (EnquiryType, EnquirySource, FullName, Email, Mobile, CollegeName, InterestedCourseId, Message, EnquiryStatus, CreatedAt)
        OUTPUT INSERTED.EnquiryId, INSERTED.CreatedAt
        SELECT @enquiryType, @enquirySource, @fullName, @email, @mobile, @collegeName,
               (SELECT CourseId FROM dbo.NXA_Courses WHERE CourseId = @courseId), @message, 'new', SYSUTCDATETIME()
      `);
    const row = ins.recordset[0];
    return { ...enquiry, id: String(row.EnquiryId), submittedAt: new Date(row.CreatedAt).toISOString(), status: "new" };
  }

  async submitCallbackRequest(input: { name: string; phone: string; preferredTimeSlot?: string | undefined }): Promise<CallbackRequest> {
    const pool = await this.getPool();
    // RequestStatus is omitted: its table default applies (allowed values are not visible).
    const ins = await pool
      .request()
      .input("fullName", sql.NVarChar(150), input.name)
      .input("mobile", sql.VarChar(25), input.phone)
      .input("preferredTime", sql.NVarChar(100), input.preferredTimeSlot || null)
      .query(`
        INSERT INTO dbo.NXA_CallbackRequests (FullName, Mobile, PreferredTime, CreatedAt)
        OUTPUT INSERTED.CallbackRequestId, INSERTED.RequestStatus, INSERTED.CreatedAt
        VALUES (@fullName, @mobile, @preferredTime, SYSUTCDATETIME())
      `);
    return toCallback({ ...ins.recordset[0], FullName: input.name, Mobile: input.phone, PreferredTime: input.preferredTimeSlot ?? null });
  }

  async getCallbackRequests(): Promise<CallbackRequest[]> {
    const pool = await this.getPool();
    const r = await pool.request().query(`SELECT CallbackRequestId, FullName, Mobile, PreferredTime, RequestStatus, CreatedAt FROM dbo.NXA_CallbackRequests ORDER BY CreatedAt DESC, CallbackRequestId DESC`);
    return r.recordset.map(toCallback);
  }

  async getEnquiries(): Promise<LeadEnquiry[]> {
    const pool = await this.getPool();
    const result = await pool.request().query(`
      SELECT EnquiryId, EnquiryType, FullName, Email, Mobile, CollegeName, InterestedCourseId, Message, EnquiryStatus, CreatedAt
      FROM dbo.NXA_Enquiries ORDER BY CreatedAt DESC, EnquiryId DESC
    `);
    return (result.recordset || []).map(toEnquiry);
  }

  async updateEnquiryStatus(id: string, status: LeadEnquiry["status"], userId: string): Promise<LeadEnquiry> {
    if (!isId(id)) throw new RecordNotFoundError("Enquiry", id);
    await this.inTransaction(async (tx) => {
      const cur = await tx.request().input("id", sql.BigInt, id).query(`SELECT EnquiryStatus FROM dbo.NXA_Enquiries WITH (UPDLOCK, HOLDLOCK) WHERE EnquiryId = @id`);
      const row = cur.recordset[0];
      if (!row) throw new RecordNotFoundError("Enquiry", id);
      if (String(row.EnquiryStatus ?? "").toLowerCase() === status) return;
      await tx.request().input("id", sql.BigInt, id).input("status", sql.VarChar(20), status).query(`UPDATE dbo.NXA_Enquiries SET EnquiryStatus = @status WHERE EnquiryId = @id`);
      await this.audit(tx, userId, { action: "CMS_ENQUIRY_STATUS", entityName: "Enquiry", entityId: id, oldValues: { status: row.EnquiryStatus }, newValues: { status } });
    });
    const pool = await this.getPool();
    const r = await pool.request().input("id", sql.BigInt, id).query(`SELECT EnquiryId, EnquiryType, FullName, Email, Mobile, CollegeName, InterestedCourseId, Message, EnquiryStatus, CreatedAt FROM dbo.NXA_Enquiries WHERE EnquiryId = @id`);
    if (!r.recordset[0]) throw new RecordNotFoundError("Enquiry", id);
    return toEnquiry(r.recordset[0]);
  }

  // --- Newsletter (public, no actor) ---
  async subscribeNewsletter(email: string): Promise<NewsletterSubscription> {
    const slug = "newsletter_subscribers";
    return this.inTransaction(async (tx) => {
      const cur = await tx.request().input("slug", sql.VarChar(200), slug).query(`SELECT Body FROM dbo.NXA_WebsiteContent WITH (UPDLOCK, HOLDLOCK) WHERE Slug = @slug`);
      const subscribers = parseList<NewsletterSubscription>(cur.recordset[0]?.Body);
      const existing = subscribers.find((s) => s.email.toLowerCase() === email.toLowerCase());
      if (existing) return existing;
      const sub: NewsletterSubscription = { id: `sub-${randomUUID()}`, email, subscribedAt: new Date().toISOString(), isActive: true };
      const req = tx
        .request()
        .input("slug", sql.VarChar(200), slug)
        .input("title", sql.NVarChar(250), "Newsletter Subscribers")
        .input("body", sql.NVarChar(sql.MAX), JSON.stringify([...subscribers, sub]));
      if (cur.recordset.length > 0) {
        await req.query(`UPDATE dbo.NXA_WebsiteContent SET Body = @body, UpdatedAt = SYSUTCDATETIME() WHERE Slug = @slug`);
      } else {
        // Subscriber list is not public content: stored unpublished, no fabricated creator.
        await req.query(`INSERT INTO dbo.NXA_WebsiteContent (ContentType, Slug, Title, Body, IsPublished, CreatedAt) VALUES ('newsletter', @slug, @title, @body, 0, SYSUTCDATETIME())`);
      }
      return sub;
    });
  }
}

// ---------------------------------------------------------------- mappers
/* eslint-disable @typescript-eslint/no-explicit-any */
function parseList<T>(body: string | null | undefined): T[] {
  if (!body) return [];
  try {
    const parsed = JSON.parse(body);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function summarize(item: Record<string, any>): Record<string, unknown> {
  const keys = ["title", "name", "studentName", "question", "collegeName", "text"];
  return Object.fromEntries(keys.filter((k) => item[k] !== undefined).map((k) => [k, item[k]]));
}

function changedKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

function toArticle(row: any): BlogArticle {
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
    date: new Date(row.PublishedAt ?? row.CreatedAt).toISOString(),
    category: extra.category || "",
    author: extra.author || "",
    authorRole: extra.authorRole || "",
    authorAvatar: extra.authorAvatar || "",
    readTime: extra.readTime || "",
    content: Array.isArray(extra.content) ? extra.content : [],
    tags: Array.isArray(extra.tags) ? extra.tags : [],
    featuredImage: extra.featuredImage || "",
    ...(extra.order === undefined ? {} : { order: extra.order }),
  };
}

function toFaq(row: any): FAQItem {
  // NXA_Faqs has no category column; the category is not stored.
  return { id: String(row.FaqId), category: "", question: row.Question, answer: row.Answer, order: Number(row.DisplayOrder ?? 0), isActive: Boolean(row.IsPublished) };
}

function toCollege(row: any): CollegePartner {
  return {
    id: String(row.CollegePartnerId),
    collegeName: row.CollegeName,
    partnershipType: row.PartnershipType ?? "",
    ...(row.Address ? { location: row.Address } : {}),
    ...(row.ContactName ? { contactPerson: row.ContactName } : {}),
    ...(row.ContactEmail ? { contactEmail: row.ContactEmail } : {}),
    ...(row.ContactMobile ? { contactMobile: row.ContactMobile } : {}),
    ...(row.WebsiteUrl ? { websiteUrl: row.WebsiteUrl } : {}),
    status: String(row.PartnerStatus ?? "").toLowerCase() as CollegePartner["status"],
    ...(row.Notes ? { notes: row.Notes } : {}),
    createdAt: new Date(row.CreatedAt).toISOString(),
  };
}

function toPage(row: any): PageContent {
  let content: Record<string, unknown> = {};
  try {
    content = JSON.parse(row.Body);
  } catch {
    content = {};
  }
  return {
    slug: row.Slug,
    title: row.Title,
    content,
    isPublished: Boolean(row.IsPublished),
    ...(row.UpdatedAt ? { updatedAt: new Date(row.UpdatedAt).toISOString() } : {}),
    ...(row.UpdatedByUserId != null ? { updatedByUserId: String(row.UpdatedByUserId) } : {}),
  };
}

function toEnquiry(row: any): LeadEnquiry {
  return {
    id: String(row.EnquiryId),
    type: (row.EnquiryType || "general") as LeadEnquiry["type"],
    name: row.FullName,
    ...(row.Email ? { email: row.Email } : {}),
    phone: row.Mobile || "",
    ...(row.CollegeName ? { collegeName: row.CollegeName } : {}),
    ...(row.InterestedCourseId != null ? { courseOfInterest: String(row.InterestedCourseId) } : {}),
    ...(row.Message ? { message: row.Message } : {}),
    submittedAt: new Date(row.CreatedAt).toISOString(),
    status: String(row.EnquiryStatus ?? "").toLowerCase() as LeadEnquiry["status"],
  };
}

function toCallback(row: any): CallbackRequest {
  return {
    id: String(row.CallbackRequestId),
    name: row.FullName,
    phone: row.Mobile,
    ...(row.PreferredTime ? { preferredTimeSlot: row.PreferredTime } : {}),
    ...(row.RequestStatus != null ? { status: String(row.RequestStatus).toLowerCase() } : {}),
    requestedAt: new Date(row.CreatedAt).toISOString(),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
