import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type sql from "mssql";

import { SqlServerCmsRepository } from "../src/modules/cms/sqlserver-cms.repository";

// Mock SQL Request and ConnectionPool
class MockSqlRequest {
  public inputs: Record<string, unknown> = {};
  public handler: (query: string, inputs: Record<string, unknown>) => unknown;

  constructor(handler: (query: string, inputs: Record<string, unknown>) => unknown) {
    this.handler = handler;
  }

  input(name: string, _typeOrValue: unknown, value?: unknown): this {
    this.inputs[name] = value !== undefined ? value : _typeOrValue;
    return this;
  }

  async query<T = unknown>(command: string): Promise<{ recordset: T[]; rowsAffected: number[] }> {
    const res = this.handler(command, this.inputs);
    if (res instanceof Error) {
      throw res;
    }
    const r = (res ?? {}) as { recordset?: T[]; rowsAffected?: number[] };
    return {
      recordset: r.recordset ?? [],
      rowsAffected: r.rowsAffected ?? [1],
    };
  }
}

const createMockPool = (
  handler: (query: string, inputs: Record<string, unknown>) => unknown,
): sql.ConnectionPool => {
  return {
    request: () => new MockSqlRequest(handler),
  } as unknown as sql.ConnectionPool;
};

describe("SqlServerCmsRepository (unit with mock pool)", () => {
  it("manages announcement banners", async () => {
    let savedBody = "";
    const pool = createMockPool((query, inputs) => {
      if (query.includes("SELECT Body FROM dbo.NXA_WebsiteContent")) {
        return {
          recordset: [
            {
              Body: JSON.stringify([
                { id: "ban-1", text: "Admission Open", badgeText: "New", linkText: "Apply", linkUrl: "/apply", isActive: true, theme: "emerald" },
                { id: "ban-2", text: "Past Webinar", badgeText: "Archive", linkText: "Watch", linkUrl: "/watch", isActive: false, theme: "amber" },
              ]),
            },
          ],
        };
      }
      if (query.includes("MERGE dbo.NXA_WebsiteContent")) {
        savedBody = String(inputs.body);
        return { rowsAffected: [1] };
      }
      return {};
    });

    const repo = new SqlServerCmsRepository(async () => pool);
    const all = await repo.getBanners(false);
    assert.equal(all.length, 2);

    const activeOnly = await repo.getBanners(true);
    assert.equal(activeOnly.length, 1);
    assert.equal(activeOnly[0]?.id, "ban-1");

    await repo.saveBanners(all, "1");
    assert.ok(savedBody.includes("Admission Open"));
  });

  it("manages blog articles with publishing filter", async () => {
    const pool = createMockPool((query, inputs) => {
      if (query.includes("FROM dbo.NXA_BlogArticles")) {
        if (inputs.slug) {
          return {
            recordset: [
              {
                BlogArticleId: 101,
                Title: "Cloud Architecture Guide",
                Slug: inputs.slug,
                Summary: "Deep dive into AWS & Kubernetes",
                Body: JSON.stringify({ category: "Cloud", author: "Dev Team", tags: ["AWS", "DevOps"], readTime: "8 min" }),
                IsPublished: 1,
                PublishedAt: new Date().toISOString(),
                CreatedAt: new Date().toISOString(),
              },
            ],
          };
        }
        return {
          recordset: [
            {
              BlogArticleId: 101,
              Title: "Cloud Architecture Guide",
              Slug: "cloud-architecture-guide",
              Summary: "Deep dive into AWS & Kubernetes",
              Body: JSON.stringify({ category: "Cloud", author: "Dev Team", tags: ["AWS", "DevOps"], readTime: "8 min" }),
              IsPublished: 1,
              PublishedAt: new Date().toISOString(),
              CreatedAt: new Date().toISOString(),
            },
            {
              BlogArticleId: 102,
              Title: "Draft Article",
              Slug: "draft-article",
              Summary: "Unfinished draft",
              Body: JSON.stringify({ category: "AI", author: "Draft Author" }),
              IsPublished: 0,
              CreatedAt: new Date().toISOString(),
            },
          ],
        };
      }
      if (query.includes("INSERT INTO dbo.NXA_BlogArticles")) {
        return { recordset: [{ BlogArticleId: 103 }] };
      }
      return {};
    });

    const repo = new SqlServerCmsRepository(async () => pool);
    const articles = await repo.getArticles();
    assert.equal(articles.length, 2);

    const single = await repo.getArticleBySlug("cloud-architecture-guide");
    assert.ok(single);
    assert.equal(single.title, "Cloud Architecture Guide");
    assert.equal(single.category, "Cloud");

    const saved = await repo.saveArticle(
      {
        id: "",
        title: "New AI Post",
        slug: "new-ai-post",
        category: "AI",
        author: "AI Expert",
        authorRole: "Lead",
        authorAvatar: "",
        date: new Date().toISOString(),
        readTime: "4 min",
        excerpt: "AI summary",
        content: ["Paragraph 1"],
        tags: ["AI"],
        featuredImage: "",
        isPublished: true,
      },
      "1"
    );
    assert.equal(saved.id, "103");
  });

  it("manages FAQs ordered by display order", async () => {
    const pool = createMockPool((query) => {
      if (query.includes("FROM dbo.NXA_Faqs")) {
        return {
          recordset: [
            { FaqId: 1, Question: "What are the timings?", Answer: "Flexible morning and evening batches.", DisplayOrder: 1, IsPublished: 1 },
            { FaqId: 2, Question: "Do you offer placement guarantee?", Answer: "Yes, 100% placement assurance.", DisplayOrder: 2, IsPublished: 1 },
          ],
        };
      }
      return {};
    });

    const repo = new SqlServerCmsRepository(async () => pool);
    const faqs = await repo.getFaqs();
    assert.equal(faqs.length, 2);
    assert.equal(faqs[0]?.order, 1);
    assert.equal(faqs[1]?.question, "Do you offer placement guarantee?");
  });

  it("manages student testimonials and trainers", async () => {
    const pool = createMockPool((_query, inputs) => {
      if (inputs.slug === "testimonials_list") {
        return {
          recordset: [
            {
              Body: JSON.stringify([
                { id: "testi-1", studentName: "Rohan Sharma", companyName: "Amazon", packageCTC: "28 LPA", courseName: "Cloud DevOps", rating: 5, quote: "Great course", year: "2026", isPublished: true, previousRole: "Student", currentRole: "SDE" },
              ]),
            },
          ],
        };
      }
      if (inputs.slug === "trainers_list") {
        return {
          recordset: [
            {
              Body: JSON.stringify([
                { id: "trn-1", name: "Dr. Vikram Seth", role: "Principal Cloud Architect", specialization: "AWS & Kubernetes", experienceYears: 12, bio: "Veteran architect", qualifications: "Ph.D.", rating: 4.9, avatarUrl: "", formerCompanies: ["Google", "Microsoft"], linkedinUrl: "", coursesTaught: ["Cloud Architecture"], isActive: true },
              ]),
            },
          ],
        };
      }
      return {};
    });

    const repo = new SqlServerCmsRepository(async () => pool);
    const testimonials = await repo.getTestimonials();
    assert.equal(testimonials.length, 1);
    assert.equal(testimonials[0]?.studentName, "Rohan Sharma");

    const trainers = await repo.getTrainers();
    assert.equal(trainers.length, 1);
    assert.equal(trainers[0]?.name, "Dr. Vikram Seth");
  });

  it("manages college partnerships and institutional MOUs", async () => {
    const pool = createMockPool((query, _inputs) => {
      if (query.includes("SELECT CollegePartnerId")) {
        return {
          recordset: [
            {
              CollegePartnerId: 501,
              CollegeName: "VNR Vignana Jyothi Institute of Engineering",
              PartnershipType: "Full Placement MOU",
              Address: "Hyderabad",
              ContactName: "Dean Academics",
              ContactEmail: "dean@vnrvjiet.ac.in",
              ContactMobile: "9876543210",
              WebsiteUrl: "https://vnrvjiet.ac.in",
              PartnerStatus: "active",
              Notes: "Co-branded lab agreement",
              CreatedAt: new Date().toISOString(),
            },
          ],
        };
      }
      if (query.includes("INSERT INTO dbo.NXA_CollegePartners")) {
        return { recordset: [{ CollegePartnerId: 502 }] };
      }
      return {};
    });

    const repo = new SqlServerCmsRepository(async () => pool);
    const partners = await repo.getCollegePartners();
    assert.equal(partners.length, 1);
    assert.equal(partners[0]?.collegeName, "VNR Vignana Jyothi Institute of Engineering");

    const newPartner = await repo.saveCollegePartner(
      {
        id: "",
        collegeName: "CBIT Hyderabad",
        partnershipType: "Curriculum Alignment",
        location: "Hyderabad",
        status: "active",
      },
      "1"
    );
    assert.equal(newPartner.id, "502");
  });

  it("manages corporate training tracks and public enquiries", async () => {
    const pool = createMockPool((query, inputs) => {
      if (inputs.slug === "corporate_training_services") {
        return {
          recordset: [
            {
              Body: JSON.stringify([
                { id: "corp-1", title: "Enterprise DevOps Bootcamp", shortDescription: "Hands-on CI/CD and Terraform", fullDescription: "Comprehensive 40h bootcamp", topics: ["Docker", "Kubernetes", "GitLab CI"], targetAudience: "Engineers", deliveryMode: "Virtual", duration: "40 Hours", technologies: ["Docker", "K8s"], isActive: true, order: 1 },
              ]),
            },
          ],
        };
      }
      if (query.includes("INSERT INTO dbo.NXA_Enquiries")) {
        return {
          recordset: [{ EnquiryId: 888, CreatedAt: new Date().toISOString() }],
        };
      }
      if (query.includes("SELECT EnquiryId, EnquiryType")) {
        return {
          recordset: [
            {
              EnquiryId: 888,
              EnquiryType: "course_admission",
              FullName: "Sneha Reddy",
              Email: "sneha@example.com",
              Mobile: "9876543210",
              CollegeName: "GRIET",
              Message: "Interested in Cloud batch",
              EnquiryStatus: "new",
              CreatedAt: new Date().toISOString(),
            },
          ],
        };
      }
      return {};
    });

    const repo = new SqlServerCmsRepository(async () => pool);
    const corpServices = await repo.getCorporateTrainingServices();
    assert.equal(corpServices.length, 1);
    assert.equal(corpServices[0]?.title, "Enterprise DevOps Bootcamp");

    const submitted = await repo.submitEnquiry({
      type: "course_admission",
      name: "Sneha Reddy",
      email: "sneha@example.com",
      phone: "9876543210",
      collegeName: "GRIET",
      message: "Interested in Cloud batch",
    });
    assert.equal(submitted.id, "888");
    assert.equal(submitted.status, "new");

    const enquiries = await repo.getEnquiries();
    assert.equal(enquiries.length, 1);
    assert.equal(enquiries[0]?.name, "Sneha Reddy");
  });
});
