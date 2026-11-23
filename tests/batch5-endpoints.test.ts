import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app";
import { startServer, type TestServer } from "./helpers/server";
import { createTestHarness, type TestHarness } from "./fakes";
import { issueAccessToken } from "../src/modules/auth/token.service";
import { createAuthenticate } from "../src/middleware/authenticate.middleware";

describe("Batch 5: Public CMS & Communication Endpoints Integration", () => {
  let harness: TestHarness;
  let server: TestServer;

  let adminToken: string;
  let superAdminToken: string;
  let teacherToken: string;
  let studentToken: string;

  beforeEach(async () => {
    harness = createTestHarness();

    // Create session helper
    let mobileSeq = 10;
    const makeToken = async (userId: string, role: any) => {
      mobileSeq++;
      const user = await harness.users.create({
        name: `${role} User`,
        email: `${role}-${userId}-${mobileSeq}@test.local`,
        mobile: `98765432${mobileSeq}`,
        role,
        status: "active",
      });
      const session = await harness.sessions.create({
        userId: user.id,
        refreshTokenHash: Buffer.alloc(64, 1).toString("hex"),
        ipAddress: "127.0.0.1",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
      return issueAccessToken({
        userId: user.id,
        role,
        sessionId: session.sessionId,
      }).token;
    };

    adminToken = await makeToken("admin-1", "admin");
    superAdminToken = await makeToken("super-1", "super_admin");
    teacherToken = await makeToken("teacher-1", "teacher");
    studentToken = await makeToken("student-1", "student");

    const authenticate = createAuthenticate({
      sessions: () => harness.sessions,
    });

    const app = createApp({
      container: harness.container,
      authenticate,
    });
    server = await startServer(app);
  });

  afterEach(async () => {
    await server.close();
  });

  describe("Public Content Access (Anonymous Read)", () => {
    it("retrieves only active banners for public visitors", async () => {
      harness.cms.banners = [
        { id: "b1", text: "New Batch Starting", badgeText: "Admissions", linkText: "Join", linkUrl: "/apply", isActive: true, theme: "emerald" },
        { id: "b2", text: "Archived Event", badgeText: "Old", linkText: "View", linkUrl: "/old", isActive: false, theme: "amber" },
      ];

      const res = await server.get("/api/v1/public/banners");
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.equal(body.success, true);
      assert.equal(body.data.length, 1);
      assert.equal(body.data[0].id, "b1");
    });

    it("retrieves published blogs and allows slug lookup", async () => {
      harness.cms.articles = [
        {
          id: "art-pub",
          title: "Kubernetes in Production",
          slug: "k8s-prod",
          category: "DevOps",
          author: "Alex",
          authorRole: "SRE",
          authorAvatar: "",
          date: new Date().toISOString(),
          readTime: "6 min",
          excerpt: "Best practices",
          content: ["Para 1"],
          tags: ["K8s"],
          featuredImage: "",
          isPublished: true,
        },
        {
          id: "art-draft",
          title: "Secret Unreleased Tech",
          slug: "secret-tech",
          category: "Research",
          author: "Secret",
          authorRole: "Writer",
          authorAvatar: "",
          date: new Date().toISOString(),
          readTime: "2 min",
          excerpt: "Draft excerpt",
          content: ["Draft content"],
          tags: [],
          featuredImage: "",
          isPublished: false,
        },
      ];

      // List returns only published
      const listRes = await server.get("/api/v1/public/blogs");
      assert.equal(listRes.status, 200);
      const listBody = (await listRes.json()) as any;
      assert.equal(listBody.data.length, 1);
      assert.equal(listBody.data[0].slug, "k8s-prod");

      // Published slug returns 200
      const detailRes = await server.get("/api/v1/public/blogs/k8s-prod");
      assert.equal(detailRes.status, 200);
      const detailBody = (await detailRes.json()) as any;
      assert.equal(detailBody.data.title, "Kubernetes in Production");

      // Draft slug returns 404
      const draftRes = await server.get("/api/v1/public/blogs/secret-tech");
      assert.equal(draftRes.status, 404);
    });

    it("retrieves FAQs, Testimonials, Trainers, and Achievements", async () => {
      harness.cms.faqs = [
        { id: "f1", category: "Admissions", question: "How to apply?", answer: "Online portal", order: 1, isActive: true },
        { id: "f2", category: "General", question: "Hidden FAQ", answer: "Secret", order: 2, isActive: false },
      ];
      harness.cms.testimonials = [
        { id: "t1", studentName: "Priya", companyName: "Google", packageCTC: "42 LPA", courseName: "Full Stack", rating: 5, quote: "Amazing", year: "2026", isPublished: true, previousRole: "Student", currentRole: "SWE", avatarUrl: "/avatar1.png" },
        { id: "t2", studentName: "Draft Student", companyName: "TBD", packageCTC: "10 LPA", courseName: "Java", rating: 4, quote: "Draft", year: "2026", isPublished: false, previousRole: "Student", currentRole: "SDE", avatarUrl: "/avatar2.png" },
      ];
      harness.cms.trainers = [
        { id: "tr1", name: "Sunil Rao", role: "Trainer", specialization: "AWS", experienceYears: 10, bio: "Bio", qualifications: "M.Tech", rating: 4.8, avatarUrl: "", formerCompanies: ["AWS"], linkedinUrl: "", coursesTaught: ["AWS"], isActive: true },
      ];

      const faqRes = await server.get("/api/v1/public/faqs");
      assert.equal(faqRes.status, 200);
      assert.equal(((await faqRes.json()) as any).data.length, 1);

      const testRes = await server.get("/api/v1/public/testimonials");
      assert.equal(testRes.status, 200);
      assert.equal(((await testRes.json()) as any).data.length, 1);

      const trainerRes = await server.get("/api/v1/public/trainers");
      assert.equal(trainerRes.status, 200);
      assert.equal(((await trainerRes.json()) as any).data.length, 1);
    });

    it("allows public visitors to submit lead enquiries and newsletter subscriptions", async () => {
      const enqRes = await server.post("/api/v1/public/enquiries", {
        type: "course_admission",
        name: "Arun Kumar",
        email: "arun@example.com",
        phone: "+91 9876543210",
        courseOfInterest: "Full Stack Development",
        message: "Looking for upcoming weekend batch",
      });
      assert.equal(enqRes.status, 201);
      const enqBody = (await enqRes.json()) as any;
      assert.equal(enqBody.success, true);
      assert.equal(enqBody.data.status, "new");
      assert.equal(enqBody.data.name, "Arun Kumar");

      const newsRes = await server.post("/api/v1/public/newsletter/subscribe", {
        email: "student.newsletter@example.com",
      });
      assert.equal(newsRes.status, 201);
      const newsBody = (await newsRes.json()) as any;
      assert.equal(newsBody.success, true);
      assert.equal(newsBody.data.email, "student.newsletter@example.com");
    });
  });

  describe("Admin CMS Security and RBAC Authorization Gates", () => {
    it("rejects unauthenticated requests on /admin/cms routes with 401", async () => {
      const res = await server.get("/api/v1/admin/cms/banners");
      assert.equal(res.status, 401);
    });

    it("rejects student callers on /admin/cms routes with 403", async () => {
      const res = await server.get("/api/v1/admin/cms/banners", {
        headers: { authorization: `Bearer ${studentToken}` },
      });
      assert.equal(res.status, 403);
    });

    it("rejects teacher callers on /admin/cms routes with 403", async () => {
      const res = await server.get("/api/v1/admin/cms/banners", {
        headers: { authorization: `Bearer ${teacherToken}` },
      });
      assert.equal(res.status, 403);
    });

    it("allows admin callers on /admin/cms routes with 200", async () => {
      const res = await server.get("/api/v1/admin/cms/banners", {
        headers: { authorization: `Bearer ${adminToken}` },
      });
      assert.equal(res.status, 200);
    });

    it("allows super_admin callers on /admin/cms routes through role inheritance with 200", async () => {
      const res = await server.get("/api/v1/admin/cms/banners", {
        headers: { authorization: `Bearer ${superAdminToken}` },
      });
      assert.equal(res.status, 200);
    });
  });

  describe("Cross-Portal Synchronization Workflows", () => {
    it("reflects blog article lifecycle (create draft -> publish -> delete) across public and admin portals", async () => {
      // 1. Admin creates a draft blog
      const createRes = await server.post(
        "/api/v1/admin/cms/blogs",
        {
          title: "Next.js 15 Full Guide",
          slug: "nextjs-15-guide",
          category: "Web Development",
          author: "Frontend Lead",
          excerpt: "Everything you need to know about Next 15",
          content: ["Section 1: Server Components"],
          tags: ["Next.js", "React"],
          isPublished: false,
        },
        { headers: { authorization: `Bearer ${adminToken}` } }
      );
      assert.equal(createRes.status, 200);
      const created = ((await createRes.json()) as any).data;
      assert.equal(created.isPublished, false);

      // 2. Verify public endpoint DOES NOT show draft
      const pubList1 = await server.get("/api/v1/public/blogs");
      assert.equal(((await pubList1.json()) as any).data.length, 0);

      const pubDetail1 = await server.get("/api/v1/public/blogs/nextjs-15-guide");
      assert.equal(pubDetail1.status, 404);

      // 3. Admin publishes the article
      const updateRes = await server.put(
        `/api/v1/admin/cms/blogs/${created.id}`,
        {
          ...created,
          isPublished: true,
        },
        { headers: { authorization: `Bearer ${adminToken}` } }
      );
      assert.equal(updateRes.status, 200);

      // 4. Verify public endpoint IMMEDIATELY reflects published article
      const pubList2 = await server.get("/api/v1/public/blogs");
      const pubList2Data = ((await pubList2.json()) as any).data;
      assert.equal(pubList2Data.length, 1);
      assert.equal(pubList2Data[0].slug, "nextjs-15-guide");

      const pubDetail2 = await server.get("/api/v1/public/blogs/nextjs-15-guide");
      assert.equal(pubDetail2.status, 200);
      assert.equal(((await pubDetail2.json()) as any).data.title, "Next.js 15 Full Guide");

      // 5. Admin deletes the article
      const delRes = await server.delete(`/api/v1/admin/cms/blogs/${created.id}`, {
        headers: { authorization: `Bearer ${adminToken}` },
      });
      assert.equal(delRes.status, 200);

      // 6. Verify public endpoint reflects deletion immediately
      const pubList3 = await server.get("/api/v1/public/blogs");
      assert.equal(((await pubList3.json()) as any).data.length, 0);
    });

    it("synchronizes lead enquiry submission from public to admin review and status transition", async () => {
      // 1. Public visitor submits an enquiry
      const submitRes = await server.post("/api/v1/public/enquiries", {
        type: "college_mou",
        name: "Principal Rao",
        email: "principal@enggcollege.edu",
        phone: "+91 9988776655",
        collegeName: "Telangana Engineering College",
        message: "Interested in setting up a campus center of excellence",
      });
      assert.equal(submitRes.status, 201);
      const enqId = ((await submitRes.json()) as any).data.id;

      // 2. Admin retrieves enquiries list
      const listRes = await server.get("/api/v1/admin/cms/enquiries", {
        headers: { authorization: `Bearer ${adminToken}` },
      });
      assert.equal(listRes.status, 200);
      const listData = ((await listRes.json()) as any).data;
      assert.equal(listData.length, 1);
      assert.equal(listData[0].id, enqId);
      assert.equal(listData[0].status, "new");

      // 3. Admin transitions status to 'contacted'
      const patchRes = await server.patch(
        `/api/v1/admin/cms/enquiries/${enqId}/status`,
        { status: "contacted" },
        { headers: { authorization: `Bearer ${adminToken}` } }
      );
      assert.equal(patchRes.status, 200);
      assert.equal(((await patchRes.json()) as any).data.status, "contacted");
    });

    it("manages college partnerships and page content configuration", async () => {
      // 1. Admin creates a college partner
      const createPartnerRes = await server.post(
        "/api/v1/admin/cms/college-partners",
        {
          collegeName: "JNTU Hyderabad",
          partnershipType: "Full Academic MOU",
          location: "Kukatpally, Hyderabad",
          status: "active",
        },
        { headers: { authorization: `Bearer ${adminToken}` } }
      );
      assert.equal(createPartnerRes.status, 200);

      // 2. Verify public endpoint reflects partnership
      const pubColleges = await server.get("/api/v1/public/college-partnerships");
      assert.equal(pubColleges.status, 200);
      const pubCollegesData = ((await pubColleges.json()) as any).data;
      assert.equal(pubCollegesData.length, 1);
      assert.equal(pubCollegesData[0].collegeName, "JNTU Hyderabad");

      // 3. Admin saves homepage CMS content
      const saveContentRes = await server.put(
        "/api/v1/admin/cms/content/homepage",
        {
          title: "Homepage CMS Configuration",
          content: {
            hero: { titleHighlight: "Industry-Ready Software Engineers" },
            stats: [{ label: "Placement Rate", value: "98%" }],
          },
          isPublished: true,
        },
        { headers: { authorization: `Bearer ${adminToken}` } }
      );
      assert.equal(saveContentRes.status, 200);

      // 4. Public reads homepage content
      const pubContentRes = await server.get("/api/v1/public/content/homepage");
      assert.equal(pubContentRes.status, 200);
      const pubContent = ((await pubContentRes.json()) as any).data;
      assert.equal(pubContent.hero.titleHighlight, "Industry-Ready Software Engineers");
    });
  });
});
