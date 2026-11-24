import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { createApp } from "../src/app";
import { startServer, type TestServer } from "./helpers/server";
import { createTestHarness, type TestHarness } from "./fakes";
import { issueAccessToken } from "../src/modules/auth/token.service";
import { createAuthenticate } from "../src/middleware/authenticate.middleware";
import { seedEnrollment } from "./helpers/learning-access";

describe("Batch 6: Payments, Certificates, Placements, Support Endpoints Integration", () => {
  let harness: TestHarness;
  let server: TestServer;

  let adminToken: string;
  let superAdminToken: string;
  let teacherToken: string;
  let studentToken: string;
  let studentUserId: string;
  let teacherUserId: string;

  beforeEach(async () => {
    harness = createTestHarness();

    let mobileSeq = 20;
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
      return {
        token: issueAccessToken({
          userId: user.id,
          role,
          sessionId: session.sessionId,
        }).token,
        userId: user.id,
      };
    };

    const admin = await makeToken("admin-1", "admin");
    const superAdmin = await makeToken("super-1", "super_admin");
    const teacher = await makeToken("teacher-1", "teacher");
    const student = await makeToken("student-1", "student");

    adminToken = admin.token;
    superAdminToken = superAdmin.token;
    teacherToken = teacher.token;
    studentToken = student.token;
    studentUserId = student.userId;
    teacherUserId = teacher.userId;

    const authenticate = createAuthenticate({
      studentAccess: null,
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

  describe("Payments & Finance", () => {
    it("creates payment order, validates discount coupon, verifies payment with HMAC signature", async () => {
      // 1. Create a coupon discount
      const createCouponRes = await server.post(
        "/api/v1/payments/admin/discounts",
        {
          code: "NXA2026",
          description: "Nexelvoria 20% discount",
          discountType: "percentage",
          value: 20,
          isActive: true,
        },
        { headers: { Authorization: `Bearer ${adminToken}` } }
      );
      assert.equal(createCouponRes.status, 201);

      // 2. Validate coupon
      const valCouponRes = await server.get(
        "/api/v1/payments/discounts/validate?code=NXA2026&grossAmountINR=50000",
        { headers: { Authorization: `Bearer ${studentToken}` } }
      );
      assert.equal(valCouponRes.status, 200);
      const valCouponJson = (await valCouponRes.json()) as any;
      assert.equal(valCouponJson.data.valid, true);
      assert.equal(valCouponJson.data.discountAmountINR, 10000);
      assert.equal(valCouponJson.data.finalAmountINR, 40000);

      // 3. Create payment order - for the student's OWN enrollment awaiting payment (BR-002).
      const course = await harness.courses.create({
        slug: "payment-flow-course",
        title: "Payment Flow Course",
        shortDescription: "x",
        longDescription: "x",
        durationWeeks: 4,
        feeINR: 50000,
        level: "Beginner",
        prerequisites: [],
        learningOutcomes: [],
      });
      const enrollment = await seedEnrollment(harness, studentUserId, course.id, { status: "approved_unpaid" });

      const notMine = await server.post(
        "/api/v1/payments/orders",
        { courseId: course.id, enrollmentId: "no-such-enrollment" },
        { headers: { Authorization: `Bearer ${studentToken}` } }
      );
      assert.equal(notMine.status, 404, "only the student's own enrollment can be paid");

      // No Razorpay integration is wired: the order is refused, never simulated,
      // and nothing is stored.
      const createOrderRes = await server.post(
        "/api/v1/payments/orders",
        {
          courseId: course.id,
          enrollmentId: enrollment.id,
          couponCode: "NXA2026",
        },
        { headers: { Authorization: `Bearer ${studentToken}` } }
      );
      assert.equal(createOrderRes.status, 503);
      assert.match(JSON.stringify(await createOrderRes.json()), /PAYMENT_GATEWAY_UNAVAILABLE/);

      // A gateway order as the (future) Razorpay adapter would have created it.
      const seededOrder = await harness.payments.createPaymentOrder({
        studentUserId,
        enrollmentId: enrollment.id,
        gatewayName: "razorpay",
        gatewayOrderId: "order_gw_test_001",
        orderReference: "ORD-TEST-001",
        amount: 40000,
        currencyCode: "INR",
        orderStatus: "created",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
      const orderId = seededOrder.id;
      const gatewayOrderId = seededOrder.gatewayOrderId;

      // 4. Verify payment with valid signature
      const secret = "default_sandbox_secret";
      const paymentId = "pay_rzp_mock123";
      const signature = crypto.createHmac("sha256", secret).update(`${gatewayOrderId}|${paymentId}`).digest("hex");

      const verifyRes = await server.post(
        "/api/v1/payments/verify",
        {
          orderId,
          gatewayPaymentId: paymentId,
          gatewaySignature: signature,
          paymentMethod: "upi",
        },
        { headers: { Authorization: `Bearer ${studentToken}` } }
      );
      assert.equal(verifyRes.status, 200);
      const verifyJson = (await verifyRes.json()) as any;
      assert.equal(verifyJson.data.success, true);
      assert.ok(verifyJson.data.receipt.receiptNumber);

      // Receipt details are the real student and course, never placeholders.
      const studentRecord = await harness.users.findById(studentUserId);
      assert.equal(verifyJson.data.receipt.studentName, studentRecord?.name);
      assert.equal(verifyJson.data.receipt.courseTitle, "Payment Flow Course");
      assert.doesNotMatch(JSON.stringify(verifyJson.data.receipt), /Enrolled Student|Academy Course/);

      // BR-004: verified payment activates the enrollment (previously never wired).
      assert.equal((await harness.enrollments.findById(enrollment.id))?.status, "active");

      // A paid enrollment cannot be ordered again.
      const again = await server.post(
        "/api/v1/payments/orders",
        { courseId: course.id, enrollmentId: enrollment.id },
        { headers: { Authorization: `Bearer ${studentToken}` } }
      );
      assert.equal(again.status, 409);

      // 5. Check payment history
      const historyRes = await server.get("/api/v1/payments/me", {
        headers: { Authorization: `Bearer ${studentToken}` },
      });
      assert.equal(historyRes.status, 200);
      const historyJson = (await historyRes.json()) as any;
      assert.equal(historyJson.data.length, 1);
      assert.equal(historyJson.data[0].gatewayPaymentId, paymentId);
    });

    it("enforces idempotency on payment webhooks", async () => {
      const webhookPayload = {
        event: "payment.captured",
        event_id: "evt_webhook_test_101",
        payload: {
          payment: {
            entity: {
              id: "pay_rzp_webhook1",
              order_id: "order_rzp_webhook1",
              amount: 2500000,
            },
          },
        },
      };

      const rawPayload = JSON.stringify(webhookPayload);
      const signature = crypto
        .createHmac("sha256", "default_sandbox_secret")
        .update(rawPayload)
        .digest("hex");

      // First webhook call
      const res1 = await server.post("/api/v1/payments/webhook", webhookPayload, {
        headers: { "x-razorpay-signature": signature },
      });
      assert.equal(res1.status, 200);
      const json1 = (await res1.json()) as any;
      assert.equal(json1.data.status, "processed");

      // Duplicate webhook call with same event_id
      const res2 = await server.post("/api/v1/payments/webhook", webhookPayload, {
        headers: { "x-razorpay-signature": signature },
      });
      assert.equal(res2.status, 200);
      const json2 = (await res2.json()) as any;
      assert.equal(json2.data.status, "duplicate");
    });

    it("blocks student from manual payment entry (RBAC 403)", async () => {
      const res = await server.post(
        "/api/v1/payments/admin/manual",
        {
          studentUserId,
          enrollmentId: "enr-1",
          amount: 15000,
          paymentMode: "cash",
          referenceNumber: "CASH-REC-001",
        },
        { headers: { Authorization: `Bearer ${studentToken}` } }
      );
      assert.equal(res.status, 403);
    });

    it("allows admin to record and view manual payments", async () => {
      harness.payments.manualPaymentTargets.set("enr-1", { studentUserId, status: "approved_unpaid", finalAmount: 20000 });
      const res = await server.post(
        "/api/v1/payments/admin/manual",
        {
          studentUserId,
          enrollmentId: "enr-1",
          amount: 20000,
          paymentMode: "bank_transfer",
          referenceNumber: "NEFT-123456",
        },
        { headers: { Authorization: `Bearer ${adminToken}` } }
      );
      assert.equal(res.status, 201);
      const json = (await res.json()) as any;
      assert.equal(json.data.amount, 20000);
      assert.equal(json.data.verificationStatus, "verified");

      const listRes = await server.get("/api/v1/payments/admin/manual", {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.equal(listRes.status, 200);
      const listJson = (await listRes.json()) as any;
      assert.equal(listJson.data.length, 1);

      // Activated atomically and audited (BR-017).
      assert.equal(harness.payments.manualPaymentTargets.get("enr-1")?.status, "active");
      assert.equal(harness.payments.manualPaymentAudit.at(-1)?.enrollmentId, "enr-1");
    });

    it("refuses a manual payment for the wrong student, a partial amount or a paid enrollment", async () => {
      harness.payments.manualPaymentTargets.set("enr-2", { studentUserId, status: "approved_unpaid", finalAmount: 30000 });
      const post = (body: Record<string, unknown>) =>
        server.post(
          "/api/v1/payments/admin/manual",
          { studentUserId, enrollmentId: "enr-2", amount: 30000, paymentMode: "cash", referenceNumber: "CASH-77", ...body },
          { headers: { Authorization: `Bearer ${adminToken}` } },
        );

      assert.equal((await post({ studentUserId: "someone-else" })).status, 422);
      assert.equal((await post({ amount: 10000 })).status, 422, "no installments (BR-005)");
      assert.equal((await post({ enrollmentId: "missing" })).status, 404);
      assert.equal(harness.payments.manualPaymentTargets.get("enr-2")?.status, "approved_unpaid", "nothing activated");

      assert.equal((await post({})).status, 201);
      assert.equal((await post({ referenceNumber: "CASH-78" })).status, 409, "already paid");
    });
  });

  describe("Certificates", () => {
    it("blocks eligibility and issuing (Q8), while existing certificates stay viewable, verifiable and revocable", async () => {
      // 1. Eligibility is not invented: blocked pending Q8 and verified data.
      const eligRes = await server.get("/api/v1/certificates/eligibility/course-1", {
        headers: { Authorization: `Bearer ${studentToken}` },
      });
      assert.equal(eligRes.status, 503);
      assert.match(JSON.stringify(await eligRes.json()), /CERTIFICATE_ELIGIBILITY_UNAVAILABLE/);

      // 2. Issuing is blocked too, even with attested figures.
      const issueRes = await server.post(
        "/api/v1/certificates/issue",
        {
          studentUserId,
          studentNameAtIssue: "Priya Patel",
          courseId: "course-1",
          courseNameAtIssue: "Full Stack Java Cloud Mastery",
          enrollmentId: "enr-1",
          attendancePercentage: 88,
          passingMarksVerified: true,
          courseCompletionVerified: true,
        },
        { headers: { Authorization: `Bearer ${adminToken}` } }
      );
      assert.equal(issueRes.status, 503);
      assert.equal((await harness.certificates.getCertificatesByStudentId(studentUserId)).length, 0, "nothing issued");

      // An existing certificate (issued before the block) remains usable.
      const cert = await harness.certificates.issueCertificate({
        studentUserId,
        studentNameAtIssue: "Priya Patel",
        courseId: "course-1",
        courseNameAtIssue: "Full Stack Java Cloud Mastery",
        enrollmentId: "enr-1",
        certificateNumber: "NXA-2026-EXIST01",
        verificationToken: "token-exist-01",
        attendancePercentage: 88,
        passingMarksVerified: true,
        courseCompletionVerified: true,
        certificateStatus: "valid",
        issuedByUserId: "admin-1",
        pdfUrl: "/api/v1/certificates/download/NXA-2026-EXIST01",
      });

      // 3. Student views their certificates
      const myRes = await server.get("/api/v1/certificates/my", {
        headers: { Authorization: `Bearer ${studentToken}` },
      });
      assert.equal(myRes.status, 200);
      const myJson = (await myRes.json()) as any;
      assert.equal(myJson.data.length, 1);
      assert.equal(myJson.data[0].certificateNumber, cert.certificateNumber);

      // 4. Public verification (unauthenticated)
      const pubRes = await server.get(`/api/v1/certificates/public/verify/${cert.certificateNumber}`);
      assert.equal(pubRes.status, 200);
      const pubJson = (await pubRes.json()) as any;
      assert.equal(pubJson.data.isValid, true);
      assert.equal(pubJson.data.certificate.studentNameAtIssue, "Priya Patel");

      // 5. Admin revokes certificate
      const revokeRes = await server.post(
        `/api/v1/certificates/${cert.id}/revoke`,
        {
          reason: "Academic misconduct discovered post-graduation",
        },
        { headers: { Authorization: `Bearer ${adminToken}` } }
      );
      assert.equal(revokeRes.status, 200);
      const revokeJson = (await revokeRes.json()) as any;
      assert.equal(revokeJson.data.certificateStatus, "revoked");

      // 6. Public verification of revoked certificate returns isValid: false
      const pubRevokeRes = await server.get(`/api/v1/certificates/public/verify/${cert.certificateNumber}`);
      assert.equal(pubRevokeRes.status, 200);
      const pubRevokeJson = (await pubRevokeRes.json()) as any;
      assert.equal(pubRevokeJson.data.isValid, false);
      assert.ok(pubRevokeJson.data.message.includes("revoked"));
    });
  });

  describe("Placements & Career Services", () => {
    it("manages hiring companies, job openings, applications, and mock interview scoring", async () => {
      // 1. Admin creates company
      const compRes = await server.post(
        "/api/v1/placements/companies",
        {
          companyName: "Google Cloud Partner Inc",
          industry: "Software & Cloud",
          hiringStatus: "active",
        },
        { headers: { Authorization: `Bearer ${adminToken}` } }
      );
      assert.equal(compRes.status, 201);
      const compJson = (await compRes.json()) as any;
      const companyId = compJson.data.id;

      // 2. Admin creates job opening
      const jobRes = await server.post(
        "/api/v1/placements/jobs",
        {
          companyId,
          jobTitle: "Associate Cloud Engineer",
          employmentType: "full_time",
          workLocation: "Bangalore / Hybrid",
          salaryMin: 800000,
          salaryMax: 1200000,
          minExperienceYears: 0,
          jobStatus: "open",
          jobDescription: "Looking for dynamic graduates with Node.js and SQL skills.",
        },
        { headers: { Authorization: `Bearer ${adminToken}` } }
      );
      assert.equal(jobRes.status, 201);
      const jobJson = (await jobRes.json()) as any;
      const jobId = jobJson.data.id;

      // 3. BR-013: no ACTIVE enrollment -> the placement portal is closed.
      const enrolledStudentId = studentUserId;
      const activeEnrollments = (await harness.enrollments.findByStudent(enrolledStudentId)).filter((e) => e.status === "active");
      if (activeEnrollments.length === 0) {
        const refused = await server.post(
          `/api/v1/placements/jobs/${jobId}/apply`,
          { coverLetter: "Excited to apply for this role!" },
          { headers: { Authorization: `Bearer ${studentToken}` } }
        );
        assert.equal(refused.status, 403);
        assert.match(JSON.stringify(await refused.json()), /PLACEMENT_NOT_ELIGIBLE/);
        await seedEnrollment(harness, enrolledStudentId, "placement-course", { status: "active" });
      }

      // Student applies for job
      const applyRes = await server.post(
        `/api/v1/placements/jobs/${jobId}/apply`,
        {
          resumeObjectKey: "resumes/student_1_cv.pdf",
          coverLetter: "Excited to apply for this role!",
        },
        { headers: { Authorization: `Bearer ${studentToken}` } }
      );
      assert.equal(applyRes.status, 201);

      // 4. Student sees their applications
      const myAppsRes = await server.get("/api/v1/placements/applications/my", {
        headers: { Authorization: `Bearer ${studentToken}` },
      });
      assert.equal(myAppsRes.status, 200);
      const myAppsJson = (await myAppsRes.json()) as any;
      assert.equal(myAppsJson.data.length, 1);
      assert.equal(myAppsJson.data[0].jobId, jobId);

      // 5. Schedule mock interview
      const mockRes = await server.post(
        "/api/v1/placements/mock-interviews/schedule",
        {
          studentUserId,
          teacherUserId,
          scheduledAt: new Date(Date.now() + 86400000).toISOString(),
          meetingUrl: "https://meet.google.com/abc-defg-hij",
        },
        { headers: { Authorization: `Bearer ${studentToken}` } }
      );
      assert.equal(mockRes.status, 201);
      const mockJson = (await mockRes.json()) as any;
      const mockId = mockJson.data.id;

      // 6. Teacher evaluates mock interview
      const evalRes = await server.post(
        `/api/v1/placements/mock-interviews/${mockId}/evaluate`,
        {
          overallScore: 92,
          feedback: "Strong grasp of SQL indexing and system architecture. Recommended for Tier-1 hiring.",
          status: "completed",
        },
        { headers: { Authorization: `Bearer ${teacherToken}` } }
      );
      assert.equal(evalRes.status, 200);
      const evalJson = (await evalRes.json()) as any;
      assert.equal(evalJson.data.overallScore, 92);
      assert.equal(evalJson.data.interviewStatus, "completed");

      // 7. Student checks interview feedback
      const myMockRes = await server.get("/api/v1/placements/mock-interviews/my", {
        headers: { Authorization: `Bearer ${studentToken}` },
      });
      assert.equal(myMockRes.status, 200);
      const myMockJson = (await myMockRes.json()) as any;
      assert.equal(myMockJson.data[0].overallScore, 92);
    });
  });

  describe("Support & Operations", () => {
    it("manages support ticket lifecycle, replies, notifications, and system settings", async () => {
      // NXA_SupportTicketCategories / NXA_InstituteSettings rows the flow relies on.
      harness.support.categories.push({ id: "7", name: "Technical", isActive: true });
      harness.support.settings.push({ id: "1", settingKey: "maintenance_mode", settingValue: "true", valueType: "boolean", isSecret: false, updatedAt: new Date().toISOString() });
      // 1. Student creates support ticket
      const createTicketRes = await server.post(
        "/api/v1/support/tickets",
        {
          categoryId: "7",
          subject: "Module 4 Exercise Query",
          description: "Having difficulty running the Docker container for the database.",
          priority: "high",
        },
        { headers: { Authorization: `Bearer ${studentToken}` } }
      );
      assert.equal(createTicketRes.status, 201);
      const ticketJson = (await createTicketRes.json()) as any;
      const ticketId = ticketJson.data.id;
      assert.ok(ticketJson.data.ticketNumber.startsWith("TCK-"));

      // 2. Admin replies to ticket
      const adminReplyRes = await server.post(
        `/api/v1/support/tickets/${ticketId}/replies`,
        {
          replyText: "Please ensure port 1433 is not bound by a local service.",
          isInternal: false,
        },
        { headers: { Authorization: `Bearer ${adminToken}` } }
      );
      assert.equal(adminReplyRes.status, 201);

      // 3. Admin updates ticket status to resolved
      const statusRes = await server.patch(
        `/api/v1/support/admin/tickets/${ticketId}/status`,
        {
          status: "resolved",
        },
        { headers: { Authorization: `Bearer ${adminToken}` } }
      );
      assert.equal(statusRes.status, 200);
      const statusJson = (await statusRes.json()) as any;
      assert.equal(statusJson.data.ticketStatus, "resolved");

      // 4. Send notification to student
      const sendNotifRes = await server.post(
        "/api/v1/support/notifications/send",
        {
          recipientUserId: studentUserId,
          notificationType: "system",
          title: "Ticket Update",
          messageBody: "Your ticket has been marked resolved.",
          priority: "normal",
        },
        { headers: { Authorization: `Bearer ${adminToken}` } }
      );
      assert.equal(sendNotifRes.status, 201);
      const notifJson = (await sendNotifRes.json()) as any;
      const notifId = notifJson.data.id;

      // 5. Student marks notification as read
      const readRes = await server.patch(
        `/api/v1/support/notifications/${notifId}/read`,
        {},
        { headers: { Authorization: `Bearer ${studentToken}` } }
      );
      assert.equal(readRes.status, 200);

      // 6. Super Admin updates system config
      const setRes = await server.put(
        "/api/v1/support/admin/system-config",
        {
          settingKey: "maintenance_mode",
          settingValue: "false",
        },
        { headers: { Authorization: `Bearer ${superAdminToken}` } }
      );
      assert.equal(setRes.status, 200);
      const setJson = (await setRes.json()) as any;
      assert.equal(setJson.data.settingValue, "false");
    });
  });
});
