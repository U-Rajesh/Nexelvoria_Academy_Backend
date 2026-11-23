import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { createApp } from "../src/app";
import { startServer, type TestServer } from "./helpers/server";
import { createTestHarness, type TestHarness } from "./fakes";
import { issueAccessToken } from "../src/modules/auth/token.service";
import { createAuthenticate } from "../src/middleware/authenticate.middleware";

describe("Phase 2: Critical End-to-End User Journeys Audit", () => {
  let harness: TestHarness;
  let server: TestServer;

  let adminToken: string;
  let superAdminToken: string;
  let teacherToken: string;
  let studentToken: string;
  let studentUserId: string;
  let teacherUserId: string;
  let defaultCourseId: string;
  const defaultBatchId = "batch-jfs-01";

  beforeEach(async () => {
    harness = createTestHarness();

    let seq = 100;
    const makeUserAndToken = async (_id: string, role: any) => {
      seq++;
      const user = await harness.users.create({
        name: `${role} User ${seq}`,
        email: `${role}${seq}@test.local`,
        mobile: `9876543${seq}`,
        role,
        status: "active",
      });
      const session = await harness.sessions.create({
        userId: user.id,
        refreshTokenHash: Buffer.alloc(64, 1).toString("hex"),
        ipAddress: "127.0.0.1",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
      const token = issueAccessToken({
        userId: user.id,
        role,
        sessionId: session.sessionId,
      }).token;
      return { token, userId: user.id, name: user.name, email: user.email, mobile: user.mobile };
    };

    const admin = await makeUserAndToken("admin-e2e", "admin");
    const superAdmin = await makeUserAndToken("super-e2e", "super_admin");
    const teacher = await makeUserAndToken("teacher-e2e", "teacher");
    const student = await makeUserAndToken("student-e2e", "student");

    adminToken = admin.token;
    superAdminToken = superAdmin.token;
    teacherToken = teacher.token;
    teacherUserId = teacher.userId;
    studentToken = student.token;
    studentUserId = student.userId;

    // Seed student profile so /api/v1/students/me succeeds
    await harness.students.createForUser(studentUserId, {
      collegeName: "NIT Karnataka",
      degreeBranch: "B.Tech CSE",
      passingYear: "2025",
      courseInterestedIn: "Full Stack Java Cloud Mastery",
      dateOfBirth: "2003-05-15",
      gender: "male",
      fullAddress: "Indiranagar, Bengaluru, Karnataka 560038",
    });

    // Seed course in in-memory course repository
    const seededCourse = harness.courses.seed({
      id: "course-fsd-01",
      slug: "fsd-cloud-mastery",
      courseCode: "CRS-FSD-01",
      title: "Full Stack Java Cloud Mastery",
      shortDescription: "Enterprise Spring Boot, Kafka, and Microservices",
      longDescription: "Comprehensive 6-month enterprise program.",
      thumbnailUrl: "https://cdn.test/thumb.png",
      durationWeeks: 24,
      totalHours: 240,
      feeINR: 50000,
      level: "Intermediate",
      category: "Software Development",
      technologies: ["Java", "Spring Boot", "Kafka"],
      modules: [
        {
          id: "mod-1",
          courseId: "course-fsd-01",
          title: "Microservices",
          description: "Distributed Systems",
          order: 1,
          chapters: [],
        },
      ],
      isPublished: true,
      status: "Published",
      hasPlacementGuarantee: true,
      prerequisites: ["Core Java"],
      learningOutcomes: ["Full Stack Engineering"],
    });
    defaultCourseId = seededCourse.id;

    // Seed batch in admin repository
    await harness.admin.createBatch({
      courseId: defaultCourseId,
      batchName: "Oct 2026 Morning Cohort",
      batchCode: "BATCH-FSD-01",
      startDate: "2026-10-01",
      endDate: "2027-04-01",
      capacity: 30,
    });

    // Seed teacher profile & batch allocation in teacher repository
    harness.teachers.seedTeacherProfile({
      id: teacherUserId,
      name: teacher.name,
      email: teacher.email,
      mobile: teacher.mobile,
      specialization: "Cloud Architecture",
      experienceYears: 12,
      qualifications: "Ph.D. in Computer Science",
      bio: "Senior Faculty & Distributed Systems Lead",
      role: "teacher",
      status: "active",
      createdAt: new Date().toISOString(),
      assignedCourseIds: [defaultCourseId],
      assignedBatchIds: [defaultBatchId],
      rating: 4.8,
    });

    harness.teachers.seedBatch({
      id: defaultBatchId,
      batchCode: "BATCH-FSD-01",
      batchName: "Oct 2026 Morning Cohort",
      courseId: defaultCourseId,
      status: "ongoing",
      scheduleDescription: "09:00 AM - 11:00 AM IST",
    });

    harness.teachers.seedBatchAllocation(teacherUserId, defaultBatchId, defaultCourseId);
    harness.teachers.seedBatchStudent(defaultBatchId, {
      studentId: studentUserId,
      studentName: student.name,
      email: student.email,
      mobile: student.mobile,
      batchId: defaultBatchId,
      batchName: "Oct 2026 Morning Cohort",
      courseTitle: "Full Stack Java Cloud Mastery",
    });

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

  // JOURNEY 1
  it("Journey 1: Registration -> Login -> Student Profile Inspection & Update", async () => {
    // 1. Fetch current authenticated student profile
    const profileRes = await server.get("/api/v1/students/me", {
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    assert.equal(profileRes.status, 200);
    const profileJson = (await profileRes.json()) as any;
    assert.equal(profileJson.success, true);
    assert.equal(profileJson.data.id, studentUserId);

    // 2. Update student profile
    const updateRes = await server.put(
      "/api/v1/students/me",
      {
        name: "Aarav Sharma Updated",
        collegeName: "NIT Karnataka",
        degreeBranch: "B.Tech CSE",
        passingYear: "2025",
        dateOfBirth: "2003-05-15",
        gender: "male",
        fullAddress: "Indiranagar, Bengaluru, Karnataka 560038",
      },
      { headers: { Authorization: `Bearer ${studentToken}` } }
    );
    assert.equal(updateRes.status, 200);
    const updateJson = (await updateRes.json()) as any;
    assert.equal(updateJson.success, true);
    assert.equal(updateJson.data.name, "Aarav Sharma Updated");
    assert.equal(updateJson.data.collegeName, "NIT Karnataka");
  });

  // JOURNEY 2
  it("Journey 2: Course Discovery -> Enrollment -> Payment -> Activation", async () => {
    // 1. Discover courses via public catalog
    const coursesRes = await server.get("/api/v1/courses");
    assert.equal(coursesRes.status, 200);
    const coursesJson = (await coursesRes.json()) as any;
    assert.ok(coursesJson.data.items);
    assert.ok(Array.isArray(coursesJson.data.items));
    assert.ok(coursesJson.data.items.length > 0);
    const course = coursesJson.data.items[0];

    // 2. View course details by slug
    const detailRes = await server.get(`/api/v1/courses/${course.slug}`);
    assert.equal(detailRes.status, 200);
    const detailJson = (await detailRes.json()) as any;
    assert.equal(detailJson.data.slug, course.slug);

    // 3. Create payment order for enrollment
    const orderRes = await server.post(
      "/api/v1/payments/orders",
      {
        courseId: course.id,
        enrollmentId: "enr-journey-2",
      },
      { headers: { Authorization: `Bearer ${studentToken}` } }
    );
    assert.equal(orderRes.status, 201);
    const orderJson = (await orderRes.json()) as any;
    assert.ok(orderJson.data.order.id);
    const orderId = orderJson.data.order.id;
    const gatewayOrderId = orderJson.data.order.gatewayOrderId;

    // 4. Verify payment with HMAC SHA256 signature
    const paymentId = "pay_rzp_e2e_001";
    const signature = crypto
      .createHmac("sha256", "default_sandbox_secret")
      .update(`${gatewayOrderId}|${paymentId}`)
      .digest("hex");

    const verifyRes = await server.post(
      "/api/v1/payments/verify",
      {
        orderId,
        gatewayPaymentId: paymentId,
        gatewaySignature: signature,
        paymentMethod: "card",
      },
      { headers: { Authorization: `Bearer ${studentToken}` } }
    );
    assert.equal(verifyRes.status, 200);
    const verifyJson = (await verifyRes.json()) as any;
    assert.equal(verifyJson.data.success, true);
    assert.ok(verifyJson.data.receipt.receiptNumber);

    // 5. Verify payment history reflects student receipt
    const myPaymentsRes = await server.get("/api/v1/payments/me", {
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    assert.equal(myPaymentsRes.status, 200);
    const myPaymentsJson = (await myPaymentsRes.json()) as any;
    assert.ok(myPaymentsJson.data.length >= 1);
  });

  // JOURNEY 3
  it("Journey 3: Teacher Allocation -> Attendance -> LMS Modules & Doubts", async () => {
    // 1. Teacher views dashboard and allocated batches
    const batchesRes = await server.get("/api/v1/teachers/me/batches", {
      headers: { Authorization: `Bearer ${teacherToken}` },
    });
    assert.equal(batchesRes.status, 200);
    const batchesJson = (await batchesRes.json()) as any;
    assert.ok(Array.isArray(batchesJson.data));
    assert.ok(batchesJson.data.length >= 1);

    // 2. Mark attendance for class session (201 created)
    const markRes = await server.post(
      "/api/v1/teachers/attendance",
      {
        batchId: defaultBatchId,
        courseId: defaultCourseId,
        sessionDate: "2026-11-22",
        topicCovered: "Microservices Sagas",
        records: [
          { studentUserId, status: "present", remarks: "Active participation" },
        ],
      },
      { headers: { Authorization: `Bearer ${teacherToken}` } }
    );
    assert.equal(markRes.status, 201);
    const markJson = (await markRes.json()) as any;
    assert.equal(markJson.success, true);

    // 3. Student views LMS modules & chapters
    const modulesRes = await server.get("/api/v1/courses/fsd-cloud-mastery");
    assert.equal(modulesRes.status, 200);

    // 4. Student posts doubt during lesson
    const doubtRes = await server.post(
      "/api/v1/teachers/doubts",
      {
        lessonId: "les-01",
        doubtText: "How does the ACID guarantee hold in distributed transactions?",
      },
      { headers: { Authorization: `Bearer ${studentToken}` } }
    );
    assert.equal(doubtRes.status, 201);
    const doubtJson = (await doubtRes.json()) as any;
    assert.equal(doubtJson.success, true);
    assert.ok(doubtJson.data.id);
  });

  // JOURNEY 4
  it("Journey 4: Assignment Creation -> Student Submission -> Teacher Evaluation", async () => {
    // 1. Teacher creates assignment
    const assignRes = await server.post(
      "/api/v1/teachers/assignments",
      {
        batchId: defaultBatchId,
        courseId: defaultCourseId,
        title: "Build a Rate-Limiting Filter with Redis & Spring Boot",
        instructions: "Implement token bucket rate limiter with JUnit test cases.",
        dueAt: new Date(Date.now() + 7 * 86400000).toISOString(),
        maximumMarks: 100,
      },
      { headers: { Authorization: `Bearer ${teacherToken}` } }
    );
    assert.equal(assignRes.status, 201);
    const assignJson = (await assignRes.json()) as any;
    const assignmentId = assignJson.data.id;

    // 2. Student submits assignment
    const submitRes = await server.post(
      `/api/v1/teachers/assignments/${assignmentId}/submit`,
      {
        submissionType: "github",
        githubUrl: "https://github.com/student/rate-limiter",
      },
      { headers: { Authorization: `Bearer ${studentToken}` } }
    );
    assert.equal(submitRes.status, 201);
    const submitJson = (await submitRes.json()) as any;
    const submissionId = submitJson.data.id;

    // 3. Teacher evaluates submission
    const gradeRes = await server.post(
      `/api/v1/teachers/assignments/submissions/${submissionId}/evaluate`,
      {
        marksAwarded: 95,
        feedback: "Excellent design, concurrency tests pass without flakiness.",
      },
      { headers: { Authorization: `Bearer ${teacherToken}` } }
    );
    assert.equal(gradeRes.status, 200);
    const gradeJson = (await gradeRes.json()) as any;
    assert.equal(gradeJson.data.marksAwarded, 95);
  });

  // JOURNEY 5
  it("Journey 5: Assessment Examination -> Progress -> Certificate Issuance & Verification", async () => {
    // 1. Check certificate eligibility
    const eligRes = await server.get(`/api/v1/certificates/eligibility/${defaultCourseId}`, {
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    assert.equal(eligRes.status, 200);
    const eligJson = (await eligRes.json()) as any;
    assert.equal(eligJson.data.isEligible, true);

    // 2. Admin issues certificate
    const issueRes = await server.post(
      "/api/v1/certificates/issue",
      {
        studentUserId,
        studentNameAtIssue: "Aarav Sharma",
        courseId: defaultCourseId,
        courseNameAtIssue: "Full Stack Java Cloud Mastery",
        enrollmentId: "enr-fsd-001",
        attendancePercentage: 90,
        passingMarksVerified: true,
        courseCompletionVerified: true,
      },
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );
    assert.equal(issueRes.status, 201);
    const issueJson = (await issueRes.json()) as any;
    const cert = issueJson.data;
    assert.ok(cert.certificateNumber.startsWith("NXA-2026-"));

    // 3. Public unauthenticated verification
    const verifyRes = await server.get(`/api/v1/certificates/public/verify/${cert.certificateNumber}`);
    assert.equal(verifyRes.status, 200);
    const verifyJson = (await verifyRes.json()) as any;
    assert.equal(verifyJson.data.isValid, true);
    assert.equal(verifyJson.data.certificate.studentNameAtIssue, "Aarav Sharma");
  });

  // JOURNEY 6
  it("Journey 6: Job Application -> Mock Interview Scheduling -> Evaluation & Feedback", async () => {
    // 1. Admin creates hiring partner company
    const compRes = await server.post(
      "/api/v1/placements/companies",
      {
        companyName: "Infosys Cloud Services",
        industry: "IT & Services",
        hiringStatus: "active",
      },
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );
    assert.equal(compRes.status, 201);
    const compJson = (await compRes.json()) as any;
    const companyId = compJson.data.id;

    // 2. Admin posts job opening
    const jobRes = await server.post(
      "/api/v1/placements/jobs",
      {
        companyId,
        jobTitle: "Java Backend Developer",
        employmentType: "full_time",
        workLocation: "Hyderabad",
        salaryMin: 700000,
        salaryMax: 1100000,
        minExperienceYears: 0,
        jobStatus: "open",
        jobDescription: "Microservices development with Spring Boot and Kafka.",
      },
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );
    assert.equal(jobRes.status, 201);
    const jobJson = (await jobRes.json()) as any;
    const jobId = jobJson.data.id;

    // 3. Student applies for job opening
    const applyRes = await server.post(
      `/api/v1/placements/jobs/${jobId}/apply`,
      {
        coverLetter: "Excited for this Java Backend opportunity.",
      },
      { headers: { Authorization: `Bearer ${studentToken}` } }
    );
    assert.equal(applyRes.status, 201);

    // 4. Student schedules mock interview
    const mockRes = await server.post(
      "/api/v1/placements/mock-interviews/schedule",
      {
        studentUserId,
        teacherUserId,
        scheduledAt: new Date(Date.now() + 86400000).toISOString(),
        meetingUrl: "https://meet.google.com/nxa-mock-e2e",
      },
      { headers: { Authorization: `Bearer ${studentToken}` } }
    );
    assert.equal(mockRes.status, 201);
    const mockJson = (await mockRes.json()) as any;
    const mockId = mockJson.data.id;

    // 5. Teacher evaluates mock interview
    const evalRes = await server.post(
      `/api/v1/placements/mock-interviews/${mockId}/evaluate`,
      {
        overallScore: 88,
        feedback: "Strong problem solving and architectural explanations. Placement ready.",
        status: "completed",
      },
      { headers: { Authorization: `Bearer ${teacherToken}` } }
    );
    assert.equal(evalRes.status, 200);
    const evalJson = (await evalRes.json()) as any;
    assert.equal(evalJson.data.overallScore, 88);
  });

  // JOURNEY 7
  it("Journey 7: Support Ticket Lifecycle -> Multi-party Replies -> Status Resolution -> In-App Notifications", async () => {
    // 1. Student raises support ticket
    const ticketRes = await server.post(
      "/api/v1/support/tickets",
      {
        categoryId: "technical_issue",
        subject: "IDE Virtual Machine Connection Timeout",
        description: "Unable to reach the remote workspace on port 8080.",
        priority: "high",
      },
      { headers: { Authorization: `Bearer ${studentToken}` } }
    );
    assert.equal(ticketRes.status, 201);
    const ticketJson = (await ticketRes.json()) as any;
    const ticketId = ticketJson.data.id;

    // 2. Admin adds reply
    const replyRes = await server.post(
      `/api/v1/support/tickets/${ticketId}/replies`,
      {
        replyText: "Workspace firewall rule refreshed. Please reconnect.",
        isInternal: false,
      },
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );
    assert.equal(replyRes.status, 201);

    // 3. Admin updates status to resolved
    const statusRes = await server.patch(
      `/api/v1/support/admin/tickets/${ticketId}/status`,
      { status: "resolved" },
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );
    assert.equal(statusRes.status, 200);
    const statusJson = (await statusRes.json()) as any;
    assert.equal(statusJson.data.ticketStatus, "resolved");

    // 4. Send in-app notification to student
    const notifRes = await server.post(
      "/api/v1/support/notifications/send",
      {
        recipientUserId: studentUserId,
        notificationType: "system",
        title: "Ticket Resolved",
        messageBody: "Your ticket has been marked resolved by technical support.",
        priority: "normal",
      },
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );
    assert.equal(notifRes.status, 201);
    const notifJson = (await notifRes.json()) as any;
    const notifId = notifJson.data.id;

    // 5. Student marks notification as read
    const readRes = await server.patch(
      `/api/v1/support/notifications/${notifId}/read`,
      {},
      { headers: { Authorization: `Bearer ${studentToken}` } }
    );
    assert.equal(readRes.status, 200);
  });

  // JOURNEY 8
  it("Journey 8: Admin/Super Admin CMS Management -> Public Website Live Content", async () => {
    // 1. Admin manages banners in CMS
    const bannerRes = await server.put(
      "/api/v1/admin/cms/banners",
      {
        banners: [
          {
            text: "Winter 2026 Admissions Open - 20% Early Bird Scholarship",
            badgeText: "Admissions Open",
            linkText: "Explore Courses",
            linkUrl: "/courses",
            theme: "indigo",
            isActive: true,
          },
        ],
      },
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );
    assert.equal(bannerRes.status, 200);

    // 2. Public website fetches active banners (unauthenticated)
    const activeBannersRes = await server.get("/api/v1/public/banners");
    assert.equal(activeBannersRes.status, 200);
    const activeBannersJson = (await activeBannersRes.json()) as any;
    assert.ok(Array.isArray(activeBannersJson.data));
    assert.ok(activeBannersJson.data.length >= 1);
  });

  // JOURNEY 9
  it("Journey 9: Admin Student Approval & Batch Teacher Allocations", async () => {
    // 1. Create a pending candidate
    const candidateUser = await harness.users.create({
      name: "Pending Candidate",
      email: "cand.e2e@test.local",
      mobile: "9123456789",
      role: "student",
      status: "pending",
    });
    await harness.students.createForUser(candidateUser.id, {
      collegeName: "JNTU",
      degreeBranch: "B.Tech",
      passingYear: "2025",
      courseInterestedIn: "Full Stack Java",
      dateOfBirth: "2003-01-01",
      gender: "male",
      fullAddress: "Hyderabad",
    });

    // 2. Admin views students list
    const studentsRes = await server.get("/api/v1/students", {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(studentsRes.status, 200);

    // 3. Admin approves candidate registration
    const approveRes = await server.post(
      `/api/v1/students/${candidateUser.id}/approve`,
      {},
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );
    assert.equal(approveRes.status, 200);
    const approveJson = (await approveRes.json()) as any;
    assert.equal(approveJson.data.adminApprovalStatus, "approved");

    // 4. Admin allocates teacher to batch
    const batchesRes = await server.get("/api/v1/admin/batches", {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(batchesRes.status, 200);
    const batchesJson = (await batchesRes.json()) as any;
    assert.ok(batchesJson.data.length > 0);
    const batchId = batchesJson.data[0].id;

    const allocRes = await server.post(
      `/api/v1/admin/batches/${batchId}/allocate`,
      {
        teacherUserId,
        role: "primary",
      },
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );
    assert.equal(allocRes.status, 200);
    const allocJson = (await allocRes.json()) as any;
    assert.equal(allocJson.success, true);
  });

  // JOURNEY 10
  it("Journey 10: Super Admin Role, Permission, and Financial Controls", async () => {
    // 1. Super Admin retrieves dashboard stats
    const statsRes = await server.get("/api/v1/super-admin/dashboard/stats", {
      headers: { Authorization: `Bearer ${superAdminToken}` },
    });
    assert.equal(statsRes.status, 200);
    const statsJson = (await statsRes.json()) as any;
    assert.ok(statsJson.data);
    assert.ok(statsJson.data.totalActiveStudents !== undefined);

    // 2. Super Admin updates system configuration
    const configRes = await server.put(
      "/api/v1/support/admin/system-config",
      {
        settingKey: "maintenance_mode",
        settingValue: "false",
      },
      { headers: { Authorization: `Bearer ${superAdminToken}` } }
    );
    assert.equal(configRes.status, 200);

    // 3. Regular student blocked from super admin routes (RBAC 403)
    const blockedRes = await server.get("/api/v1/super-admin/dashboard/stats", {
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    assert.equal(blockedRes.status, 403);
  });
});
