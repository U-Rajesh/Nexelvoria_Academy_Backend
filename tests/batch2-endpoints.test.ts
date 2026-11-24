import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app";
import { issueAccessToken } from "../src/modules/auth/token.service";
import { createAuthenticate } from "../src/middleware/authenticate.middleware";
import { createTestHarness, type TestHarness } from "./fakes";
import { json, startServer, type TestServer } from "./helpers/server";

describe("Batch 2 Endpoints Integration", () => {
  let harness: TestHarness;
  let server: TestServer;
  let studentUserId: string;
  let courseId: string;

  before(async () => {
    harness = createTestHarness();

    // Seed test users & students
    const user = await harness.users.create({
      name: "Rohan Sharma",
      email: "rohan@test.local",
      mobile: "9876543210",
      role: "student",
      status: "active",
    });

    await harness.students.createForUser(user.id, {
      collegeName: "JNTU Hyderabad",
      degreeBranch: "B.Tech - CSE",
      passingYear: "2025",
      courseInterestedIn: "Full Stack Development",
      dateOfBirth: "2003-05-15",
      gender: "male",
      fullAddress: "Plot 42, Hitec City, Hyderabad",
      linkedInUrl: "https://linkedin.com/in/rohansharma",
      githubUrl: "https://github.com/rohansharma",
    });

    studentUserId = user.id;

    // Seed course
    const createdCourse = await harness.courses.create({
      slug: "full-stack-python",
      title: "Full Stack Python",
      shortDescription: "Complete Python track",
      longDescription: "Learn Python, Django, React",
      thumbnailUrl: "/thumb.png",
      durationWeeks: 12,
      totalHours: 120,
      feeINR: 25000,
      level: "Beginner",
      category: "Software Development",
      technologies: ["Python", "Django", "React"],
      hasPlacementGuarantee: false,
      prerequisites: [],
      learningOutcomes: [],
    });

    courseId = createdCourse.id;

    await harness.courses.setPublication(courseId, {
      status: "Published",
      isPublished: true,
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

  const getStudentToken = async (userId?: string) => {
    const id = userId ?? studentUserId;
    const session = await harness.sessions.create({
      userId: id,
      refreshTokenHash: Buffer.alloc(64, 1).toString("hex"),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });

    const { token } = issueAccessToken({
      userId: id,
      role: "student",
      sessionId: session.sessionId,
    });

    return token;
  };

  describe("GET /api/v1/students/me", () => {
    it("returns 401 when anonymous", async () => {
      const res = await server.get("/api/v1/students/me");
      assert.equal(res.status, 401);
    });

    it("returns 200 and student profile for authenticated student", async () => {
      const token = await getStudentToken();
      const res = await server.get("/api/v1/students/me", {
        headers: { Authorization: `Bearer ${token}` },
      });

      assert.equal(res.status, 200);
      const body = await json(res);
      assert.equal(body["success"], true);
      const data = body["data"] as Record<string, unknown>;
      assert.equal(data["id"], studentUserId);
      assert.equal(data["collegeName"], "JNTU Hyderabad");
      assert.equal(data["role"], "student");
      assert.equal(data["passwordHash"], undefined);
    });
  });

  describe("PUT /api/v1/students/me", () => {
    it("returns 401 when anonymous", async () => {
      const res = await fetch(`${server.url}/api/v1/students/me`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collegeName: "New College" }),
      });
      assert.equal(res.status, 401);
    });

    it("updates student profile fields successfully", async () => {
      const token = await getStudentToken();
      const res = await fetch(`${server.url}/api/v1/students/me`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          collegeName: "BITS Pilani Hyderabad",
          fullAddress: "Campus Hostels, BITS Hyderabad",
          githubUrl: "https://github.com/rohan-updated",
        }),
      });

      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body["success"], true);
      const data = body["data"] as Record<string, unknown>;
      assert.equal(data["collegeName"], "BITS Pilani Hyderabad");
      assert.equal(data["fullAddress"], "Campus Hostels, BITS Hyderabad");
      assert.equal(data["githubUrl"], "https://github.com/rohan-updated");
    });
  });

  describe("Public Course Catalogue", () => {
    it("GET /api/v1/courses returns published courses without authentication", async () => {
      const res = await server.get("/api/v1/courses");
      assert.equal(res.status, 200);
      const body = await json(res);
      assert.equal(body["success"], true);
      const data = body["data"] as Record<string, unknown>;
      const items = data["items"] as unknown[];
      assert.ok(items.length >= 1);
    });

    it("GET /api/v1/courses/:slug returns course details", async () => {
      const res = await server.get("/api/v1/courses/full-stack-python");
      assert.equal(res.status, 200);
      const body = await json(res);
      assert.equal(body["success"], true);
      const course = body["data"] as Record<string, unknown>;
      assert.equal(course["title"], "Full Stack Python");
      assert.equal(course["feeINR"], 25000);
    });
  });

  describe("Enrollment APIs", () => {
    it("POST /api/v1/enrollments creates enrollment request", async () => {
      const token = await getStudentToken();
      const res = await fetch(`${server.url}/api/v1/enrollments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          courseId,
        }),
      });

      assert.equal(res.status, 201);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body["success"], true);
      const enrollment = body["data"] as Record<string, unknown>;
      assert.equal(enrollment["courseId"], courseId);
      assert.equal(enrollment["studentId"], studentUserId);
    });

    it("POST /api/v1/enrollments rejects duplicate enrollment with 409", async () => {
      const token = await getStudentToken();
      const res = await fetch(`${server.url}/api/v1/enrollments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          courseId,
        }),
      });

      assert.equal(res.status, 409);
    });

    it("GET /api/v1/enrollments/me returns student's enrollments enriched with course info", async () => {
      const token = await getStudentToken();
      const res = await server.get("/api/v1/enrollments/me", {
        headers: { Authorization: `Bearer ${token}` },
      });

      assert.equal(res.status, 200);
      const body = await json(res);
      assert.equal(body["success"], true);
      const list = body["data"] as Array<{ enrollment: Record<string, unknown>; courseTitle: string }>;
      assert.ok(list.length >= 1);
      assert.equal(list[0]?.courseTitle, "Full Stack Python");
    });
  });
});
