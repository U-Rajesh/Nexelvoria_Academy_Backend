import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app";
import { issueAccessToken } from "../src/modules/auth/token.service";
import { createAuthenticate } from "../src/middleware/authenticate.middleware";
import { createTestHarness, type TestHarness } from "./fakes";
import { json, startServer, type TestServer } from "./helpers/server";
import { seedEnrollment, seedLessons } from "./helpers/learning-access";

describe("Batch 3: Teacher & Learning Management Endpoints Integration", () => {
  let harness: TestHarness;
  let server: TestServer;
  let teacherUserId: string;
  let studentUserId: string;
  let courseId: string;
  let batchId: string;

  before(async () => {
    harness = createTestHarness();

    // 1. Seed Teacher User
    const teacherUser = await harness.users.create({
      name: "Dr. Vikram Rao",
      email: "vikram.rao@nexelvoria.in",
      mobile: "9876543210",
      role: "teacher",
      status: "active",
    });
    teacherUserId = teacherUser.id;

    // Seed teacher profile in in-memory teacher repository
    harness.teachers.seedTeacherProfile({
      id: teacherUserId,
      name: teacherUser.name,
      email: teacherUser.email,
      mobile: teacherUser.mobile,
      specialization: "Cloud Architecture",
      experienceYears: 12,
      qualifications: "Ph.D. in Computer Science",
      bio: "Senior Faculty & Distributed Systems Lead",
      role: "teacher",
      status: "active",
      createdAt: new Date().toISOString(),
      assignedCourseIds: [],
      assignedBatchIds: [],
      rating: 4.8,
    });

    // 2. Seed Student User
    const studentUser = await harness.users.create({
      name: "Rohan Sharma",
      email: "rohan@test.local",
      mobile: "9876543211",
      role: "student",
      status: "active",
    });
    studentUserId = studentUser.id;

    await harness.students.createForUser(studentUserId, {
      collegeName: "JNTU Hyderabad",
      degreeBranch: "B.Tech - CSE",
      passingYear: "2025",
      courseInterestedIn: "Full Stack Java",
      dateOfBirth: "2003-05-15",
      gender: "male",
      fullAddress: "Plot 42, Hitec City, Hyderabad",
    });

    // 3. Seed Course & Batch
    const createdCourse = await harness.courses.create({
      slug: "full-stack-java",
      title: "Full Stack Java Enterprise",
      shortDescription: "Complete enterprise Java track",
      longDescription: "Learn Spring Boot, Kafka, Microservices",
      thumbnailUrl: "/thumb.png",
      durationWeeks: 16,
      totalHours: 160,
      feeINR: 35000,
      level: "Intermediate",
      category: "Software Development",
      technologies: ["Java", "Spring Boot", "Kafka"],
      hasPlacementGuarantee: true,
      prerequisites: [],
      learningOutcomes: [],
    });
    courseId = createdCourse.id;

    batchId = "batch-java-01";
    harness.teachers.seedBatch({
      id: batchId,
      batchCode: "BAT-JAVA-01",
      batchName: "Oct 2026 Morning Cohort",
      courseId,
      status: "ongoing",
      scheduleDescription: "09:00 AM - 11:00 AM IST",
    });

    harness.teachers.seedBatchAllocation(teacherUserId, batchId, courseId);

    // CRS-010: the student studies through an ACTIVE enrollment in this batch,
    // and the lesson used below belongs to the course.
    await seedLessons(harness, courseId, ["les-kafka-01"]);
    await seedEnrollment(harness, studentUserId, courseId, { batchId });
    harness.teachers.seedBatchStudent(batchId, {
      studentId: studentUserId,
      studentName: studentUser.name,
      email: studentUser.email,
      mobile: studentUser.mobile,
      batchId,
      batchName: "Oct 2026 Morning Cohort",
      courseTitle: "Full Stack Java Enterprise",
    });

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

  after(async () => {
    await server.close();
  });

  const getTeacherToken = async (userId: string = teacherUserId) => {
    const session = await harness.sessions.create({
      userId,
      refreshTokenHash: Buffer.alloc(64, 1).toString("hex"),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });

    const { token } = issueAccessToken({
      userId,
      role: "teacher",
      sessionId: session.sessionId,
    });

    return token;
  };

  const getStudentToken = async (userId: string = studentUserId) => {
    const session = await harness.sessions.create({
      userId,
      refreshTokenHash: Buffer.alloc(64, 2).toString("hex"),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });

    const { token } = issueAccessToken({
      userId,
      role: "student",
      sessionId: session.sessionId,
    });

    return token;
  };

  describe("Security and Role Authorization", () => {
    it("rejects unauthenticated requests with 401", async () => {
      const res = await server.get("/api/v1/teachers/me");
      assert.equal(res.status, 401);
    });

    it("rejects students attempting to access teacher-only routes with 403", async () => {
      const token = await getStudentToken();
      const res = await server.get("/api/v1/teachers/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 403);
    });

    it("rejects teachers attempting to access student-only routes with 403", async () => {
      const token = await getTeacherToken();
      const res = await server.get("/api/v1/teachers/attendance/my", {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 403);
    });
  });

  describe("Teacher Profile Endpoints", () => {
    it("retrieves authenticated teacher profile with 200", async () => {
      const token = await getTeacherToken();
      const res = await server.get("/api/v1/teachers/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);

      const body = await json(res);
      assert.equal(body["success"], true);
      const data = body["data"] as Record<string, unknown>;
      assert.equal(data["name"], "Dr. Vikram Rao");
      assert.equal(data["specialization"], "Cloud Architecture");
    });

    it("updates teacher profile with 200", async () => {
      const token = await getTeacherToken();
      const res = await server.put(
        "/api/v1/teachers/me",
        {
          specialization: "Advanced Distributed Systems",
          experienceYears: 13,
          bio: "Senior Distinguished Faculty",
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
      );
      assert.equal(res.status, 200);

      const body = await json(res);
      assert.equal(body["success"], true);
      const data = body["data"] as Record<string, unknown>;
      assert.equal(data["specialization"], "Advanced Distributed Systems");
      assert.equal(data["experienceYears"], 13);
    });
  });

  describe("Allocated Batches & Cohorts", () => {
    it("lists teacher assigned courses with 200", async () => {
      const token = await getTeacherToken();
      const res = await server.get("/api/v1/teachers/me/courses", {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);

      const body = await json(res);
      assert.equal(body["success"], true);
      assert.ok(Array.isArray(body["data"]));
    });

    it("lists teacher assigned cohorts with 200", async () => {
      const token = await getTeacherToken();
      const res = await server.get("/api/v1/teachers/me/batches", {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);

      const body = await json(res);
      assert.equal(body["success"], true);
      const list = body["data"] as Array<{ id: string; batchName: string }>;
      assert.equal(list.length, 1);
      assert.equal(list[0]?.id, batchId);
    });

    it("lists students enrolled in an allocated cohort with 200", async () => {
      const token = await getTeacherToken();
      const res = await server.get(`/api/v1/teachers/me/batches/${batchId}/students`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);

      const body = await json(res);
      assert.equal(body["success"], true);
      const list = body["data"] as Array<{ studentId: string; studentName: string }>;
      assert.equal(list.length, 1);
      assert.equal(list[0]?.studentId, studentUserId);
    });
  });

  describe("Attendance Management", () => {
    it("rejects attendance recording if teacher is not allocated to the batch with 403", async () => {
      const token = await getTeacherToken();
      const res = await server.post(
        "/api/v1/teachers/attendance",
        {
          batchId: "unallocated-batch-99",
          courseId,
          sessionDate: "2026-11-22",
          topicCovered: "Kafka Event-Driven Sagas",
          entries: [{ studentId: studentUserId, studentName: "Rohan Sharma", status: "present" }],
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
      );
      assert.equal(res.status, 403);
    });

    it("records attendance matrix with 201 for allocated batch", async () => {
      const token = await getTeacherToken();
      const res = await server.post(
        "/api/v1/teachers/attendance",
        {
          batchId,
          courseId,
          sessionDate: "2026-11-22",
          topicCovered: "Kafka Event-Driven Sagas",
          entries: [{ studentId: studentUserId, studentName: "Rohan Sharma", status: "present" }],
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
      );
      assert.equal(res.status, 201);

      const body = await json(res);
      assert.equal(body["success"], true);
      const data = body["data"] as Record<string, unknown>;
      assert.equal(data["sessionTitle"], "Kafka Event-Driven Sagas");
    });

    it("lists attendance session history for teacher with 200", async () => {
      const token = await getTeacherToken();
      const res = await server.get(`/api/v1/teachers/attendance/history?batchId=${batchId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);

      const body = await json(res);
      assert.equal(body["success"], true);
      const list = body["data"] as unknown[];
      assert.ok(list.length >= 1);
    });

    it("returns attendance summary and logs for authenticated student with 200", async () => {
      const token = await getStudentToken();
      const res = await server.get("/api/v1/teachers/attendance/my", {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);

      const body = await json(res);
      assert.equal(body["success"], true);
      const data = body["data"] as Record<string, unknown>;
      assert.equal(data["total"], 1);
      assert.equal(data["present"], 1);
      assert.equal(data["percentage"], 100);
    });
  });

  describe("Coursework & Assignments Lifecycle", () => {
    let createdAssignmentId: string;
    let createdSubmissionId: string;

    it("creates a new assignment with 201", async () => {
      const token = await getTeacherToken();
      const res = await server.post(
        "/api/v1/teachers/assignments",
        {
          courseId,
          batchId,
          title: "Microservices Resiliency Assignment",
          instructions: "Build a Resilience4j circuit breaker with fallback mechanism",
          maximumMarks: 50,
          dueAt: "2026-12-15T23:59:59Z",
          allowLateSubmission: true,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
      );
      assert.equal(res.status, 201);

      const body = await json(res);
      assert.equal(body["success"], true);
      const data = body["data"] as Record<string, unknown>;
      assert.ok(data["id"]);
      createdAssignmentId = String(data["id"]);
    });

    it("allows student to submit assignment with 201", async () => {
      const token = await getStudentToken();
      const res = await server.post(
        `/api/v1/teachers/assignments/${createdAssignmentId}/submit`,
        {
          submissionType: "github",
          githubUrl: "https://github.com/rohan/resilience4j-lab",
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
      );
      assert.equal(res.status, 201);

      const body = await json(res);
      assert.equal(body["success"], true);
      const data = body["data"] as Record<string, unknown>;
      assert.ok(data["status"] === "SUBMITTED" || data["status"] === "submitted");
      createdSubmissionId = String(data["id"]);
    });

    it("allows teacher to evaluate student submission with 200", async () => {
      const token = await getTeacherToken();
      const targetSubId = createdSubmissionId ?? "sub-1";
      const res = await server.post(
        `/api/v1/teachers/assignments/submissions/${targetSubId}/evaluate`,
        {
          marksAwarded: 47,
          feedback: "Great implementation of circuit breaker states and test coverage.",
          assessmentType: "assignment",
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
      );
      assert.equal(res.status, 200);

      const body = await json(res);
      assert.equal(body["success"], true);
      const data = body["data"] as Record<string, unknown>;
      assert.equal(data["marksAwarded"], 47);
    });
  });

  describe("Study Materials Management", () => {
    let createdMaterialId: string;

    it("uploads study material with 201", async () => {
      const token = await getTeacherToken();
      const res = await server.post(
        "/api/v1/teachers/materials",
        {
          lessonId: "les-kafka-01",
          materialName: "Microservices Architecture Blueprint",
          materialType: "pdf",
          externalUrl: "https://example.com/docs/blueprint.pdf",
          fileSizeBytes: 204800,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
      );
      assert.equal(res.status, 201);

      const body = await json(res);
      assert.equal(body["success"], true);
      const data = body["data"] as Record<string, unknown>;
      assert.ok(data["id"]);
      createdMaterialId = String(data["id"]);
    });

    it("lists study materials with 200", async () => {
      const token = await getStudentToken();
      const res = await server.get("/api/v1/teachers/materials?lessonId=les-kafka-01", {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);

      const body = await json(res);
      assert.equal(body["success"], true);
      const list = body["data"] as unknown[];
      assert.ok(list.length >= 1);
    });

    it("allows teacher to delete study material with 200", async () => {
      const token = await getTeacherToken();
      const res = await server.delete(`/api/v1/teachers/materials/${createdMaterialId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);

      const body = await json(res);
      assert.equal(body["success"], true);
      const data = body["data"] as Record<string, unknown>;
      assert.equal(data["success"], true);
    });
  });

  describe("Doubts & Discussion Forum", () => {
    let createdDoubtId: string;

    it("allows student to post doubt with 201", async () => {
      const token = await getStudentToken();
      const res = await server.post(
        "/api/v1/teachers/doubts",
        {
          lessonId: "les-kafka-01",
          doubtText: "What causes consumer group rebalances during lengthy database batch transactions?",
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
      );
      assert.equal(res.status, 201);

      const body = await json(res);
      assert.equal(body["success"], true);
      const data = body["data"] as Record<string, unknown>;
      assert.ok(data["id"]);
      assert.ok(data["status"] === "OPEN" || data["status"] === "open");
      createdDoubtId = String(data["id"]);
    });

    it("allows teacher to reply to doubt with 200", async () => {
      const token = await getTeacherToken();
      const res = await server.post(
        `/api/v1/teachers/doubts/${createdDoubtId}/reply`,
        {
          replyText: "Check max.poll.interval.ms and ensure heartbeat thread is not starved.",
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
      );
      assert.equal(res.status, 200);

      const body = await json(res);
      assert.equal(body["success"], true);
      const data = body["data"] as Record<string, unknown>;
      assert.ok(
        data["status"] === "RESOLVED" ||
          data["status"] === "resolved" ||
          data["status"] === "ANSWERED" ||
          data["status"] === "answered",
      );
      assert.equal(data["replyText"], "Check max.poll.interval.ms and ensure heartbeat thread is not starved.");
    });
  });

  describe("LMS Lesson Progress Tracking", () => {
    it("records student lesson progress with 200", async () => {
      const token = await getStudentToken();
      const res = await server.post(
        "/api/v1/teachers/lms/lessons/les-kafka-01/progress",
        {
          isCompleted: true,
          progressPercent: 100,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
      );
      assert.equal(res.status, 200);

      const body = await json(res);
      assert.equal(body["success"], true);
      const data = body["data"] as Record<string, unknown>;
      assert.equal(data["isCompleted"], true);
      assert.equal(data["progressPercent"], 100);
    });
  });

  describe("Assessments & Tests", () => {
    it("creates an online test with 201", async () => {
      const token = await getTeacherToken();
      const res = await server.post(
        "/api/v1/teachers/tests",
        {
          courseId,
          batchId,
          title: "Microservices Midterm Assessment",
          instructions: "Comprehensive assessment covering event streaming and containerization",
          durationMinutes: 90,
          maximumMarks: 100,
          passingMarks: 60,
          startsAt: "2026-11-20T00:00:00Z",
          endsAt: "2026-11-30T23:59:59Z",
          maxAttempts: 2,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
      );
      assert.equal(res.status, 201);

      const body = await json(res);
      assert.equal(body["success"], true);
      const data = body["data"] as Record<string, unknown>;
      assert.ok(data["id"]);
    });

    it("retrieves tests with 200", async () => {
      const token = await getStudentToken();
      const res = await server.get(`/api/v1/teachers/tests?courseId=${courseId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);

      const body = await json(res);
      assert.equal(body["success"], true);
      const list = body["data"] as unknown[];
      assert.ok(list.length >= 1);
    });
  });
});
