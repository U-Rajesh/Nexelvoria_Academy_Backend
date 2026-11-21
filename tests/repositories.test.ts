import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import type { PaginationQuery } from "../src/contracts/api.contract";
import type {
  CreateStudentInput,
  StudentProfileInput,
} from "../src/modules/students/student.types";
import type { CreateUserInput } from "../src/modules/users/user.types";
import type { CreateCourseInput } from "../src/modules/courses/course.types";
import {
  DuplicateRecordError,
  RecordNotFoundError,
  RepositoryError,
} from "../src/repositories/repository.errors";
import {
  InMemoryStudentRepository,
  createTestHarness,
  type TestHarness,
} from "./fakes";

const PAGE: PaginationQuery = { page: 1, pageSize: 10 };

const studentInput = (overrides: Partial<CreateStudentInput> = {}): CreateStudentInput => ({
  name: "Ananya Rao",
  email: "ananya@test.local",
  mobile: "9000000001",
  status: "pending",
  collegeName: "Nexelvoria Institute",
  degreeBranch: "CSE",
  passingYear: "2026",
  courseInterestedIn: "Java Full Stack",
  dateOfBirth: "2004-05-10",
  gender: "female",
  fullAddress: "Hyderabad",
  ...overrides,
});

/**
 * The ADMISSIONS half only - no identity. `createForUser` reads the name,
 * email, mobile and status from the user row instead, which is the whole
 * point of the type.
 */
const studentProfile = (overrides: Partial<StudentProfileInput> = {}): StudentProfileInput => ({
  collegeName: "Nexelvoria Institute",
  degreeBranch: "CSE",
  passingYear: "2026",
  courseInterestedIn: "Java Full Stack",
  dateOfBirth: "2004-05-10",
  gender: "female",
  fullAddress: "Hyderabad",
  ...overrides,
});

const courseInput = (overrides: Partial<CreateCourseInput> = {}): CreateCourseInput => ({
  slug: "java-full-stack",
  title: "Java Full Stack",
  shortDescription: "Short",
  longDescription: "Long",
  thumbnailUrl: "https://cdn.test/thumb.png",
  durationWeeks: 24,
  totalHours: 320,
  feeINR: 75000,
  level: "Beginner",
  category: "Software Development",
  technologies: ["Java", "Spring Boot", "React"],
  hasPlacementGuarantee: true,
  prerequisites: [],
  learningOutcomes: ["Build APIs"],
  ...overrides,
});

describe("repository ports (verified through the in-memory adapters)", () => {
  let h: TestHarness;

  beforeEach(() => {
    // A fresh harness per test: the strongest form of isolation.
    h = createTestHarness();
  });

  describe("missing record handling", () => {
    it("findById returns null rather than throwing", async () => {
      assert.equal(await h.students.findById("nope"), null);
      assert.equal(await h.courses.findById("nope"), null);
      assert.equal(await h.enrollments.findById("nope"), null);
      assert.equal(await h.teachers.findById("nope"), null);
      assert.equal(await h.users.findById("nope"), null);
    });

    it("findByEmail / findBySlug return null when absent", async () => {
      assert.equal(await h.students.findByEmail("ghost@test.local"), null);
      assert.equal(await h.courses.findBySlug("no-such-course"), null);
    });

    it("writes against a missing id throw RecordNotFoundError", async () => {
      await assert.rejects(
        () => h.students.update("missing", { name: "X" }),
        RecordNotFoundError,
      );

      await assert.rejects(() => h.students.setStatus("missing", "active"), RecordNotFoundError);
      await assert.rejects(() => h.courses.setPublished("missing", true), RecordNotFoundError);
      await assert.rejects(
        () => h.courses.replaceCurriculum("missing", []),
        RecordNotFoundError,
      );
      await assert.rejects(
        () => h.enrollments.setStatus("missing", "active"),
        RecordNotFoundError,
      );
    });

    it("the error names the entity and the id", async () => {
      await assert.rejects(
        () => h.students.update("student-404", { name: "X" }),
        (err: unknown) => {
          assert.ok(err instanceof RecordNotFoundError);
          assert.equal(err.entity, "student");
          assert.equal(err.id, "student-404");
          return true;
        },
      );
    });

    it("lesson lookup returns null for a missing course or lesson", async () => {
      const course = await h.courses.create(courseInput());

      assert.equal(await h.courses.findLessonById("missing-course", "l1"), null);
      assert.equal(await h.courses.findLessonById(course.id, "missing-lesson"), null);
    });
  });

  describe("duplicate handling where the contract requires it", () => {
    it("rejects a duplicate student email (case-insensitive)", async () => {
      await h.students.create(studentInput());

      await assert.rejects(
        () => h.students.create(studentInput({ email: "ANANYA@TEST.LOCAL", mobile: "9000000002" })),
        (err: unknown) => {
          assert.ok(err instanceof DuplicateRecordError);
          assert.equal(err.entity, "student");
          assert.equal(err.field, "email");
          return true;
        },
      );
    });

    it("rejects a duplicate student mobile", async () => {
      await h.students.create(studentInput());

      await assert.rejects(
        () => h.students.create(studentInput({ email: "other@test.local" })),
        (err: unknown) => {
          assert.ok(err instanceof DuplicateRecordError);
          assert.equal(err.field, "mobile");
          return true;
        },
      );
    });

    it("rejects a duplicate course slug (case-insensitive)", async () => {
      await h.courses.create(courseInput());

      await assert.rejects(
        () => h.courses.create(courseInput({ slug: "JAVA-FULL-STACK" })),
        DuplicateRecordError,
      );
    });

    it("rejects a second enrolment for the same student and course", async () => {
      await h.enrollments.create({
        studentId: "student-1",
        courseId: "course-1",
        enrollmentType: "self",
        status: "pending_approval",
      });

      await assert.rejects(
        () =>
          h.enrollments.create({
            studentId: "student-1",
            courseId: "course-1",
            enrollmentType: "admin",
            status: "active",
          }),
        DuplicateRecordError,
      );
    });

    it("allows the same student on a different course", async () => {
      await h.enrollments.create({
        studentId: "student-1",
        courseId: "course-1",
        enrollmentType: "self",
        status: "active",
      });

      const second = await h.enrollments.create({
        studentId: "student-1",
        courseId: "course-2",
        enrollmentType: "self",
        status: "active",
      });

      assert.equal(second.courseId, "course-2");
    });

    it("rejects a duplicate teacher allocation to the same batch", async () => {
      const teacher = await h.teachers.create({
        name: "R Kumar",
        email: "r@test.local",
        mobile: "9111111111",
        specialization: "Java",
        experienceYears: 8,
        bio: "bio",
        qualifications: "MTech",
      });

      const allocation = { teacherId: teacher.id, courseId: "course-1", batchId: "batch-1" };

      await h.teachers.addAllocation(allocation);
      await assert.rejects(() => h.teachers.addAllocation(allocation), DuplicateRecordError);
    });
  });

  describe("students", () => {
    it("create applies server-owned defaults and never trusts the caller", async () => {
      const student = await h.students.create(studentInput());

      assert.equal(student.id, "student-1", "id is assigned by the store, not the caller");
      assert.equal(student.role, "student");
      assert.equal(student.isEmailVerified, false);
      assert.equal(student.isMobileVerified, false);
      assert.equal(student.adminApprovalStatus, "pending", "BR-002 starts pending");
      assert.deepEqual(student.enrolledCourseIds, []);
      assert.ok(student.createdAt);
    });

    it("records an approval decision with actor and timestamp", async () => {
      const student = await h.students.create(studentInput());

      const approved = await h.students.recordApprovalDecision(student.id, {
        status: "approved",
        decidedByUserId: "admin-1",
        decidedAt: "2026-11-17T08:00:00.000Z",
        remarks: "Documents verified",
      });

      assert.equal(approved.adminApprovalStatus, "approved");
      assert.equal(approved.adminApprovalRemarks, "Documents verified");
      assert.equal(approved.approvedAt, "2026-11-17T08:00:00.000Z");

      // `accountState` is NOT stored. It is derived from status +
      // isEmailVerified + adminApprovalStatus when a response is built
      // (`deriveAccountState`), so the repository must not invent one -
      // a stored copy would be a second source of truth, and the database
      // has no column for it (database-handoff 16.1).
      assert.equal(approved.accountState, undefined);
    });

    it("records a rejection", async () => {
      const student = await h.students.create(studentInput());

      const rejected = await h.students.recordApprovalDecision(student.id, {
        status: "rejected",
        decidedByUserId: "admin-1",
        decidedAt: "2026-11-17T08:00:00.000Z",
        remarks: "Incomplete documents",
      });

      assert.equal(rejected.adminApprovalStatus, "rejected");
      assert.equal(rejected.accountState, undefined, "accountState is derived, not stored");
    });

    it("marks each verification channel independently (BR-001)", async () => {
      const student = await h.students.create(studentInput());

      const afterEmail = await h.students.markVerified(student.id, "email");
      assert.equal(afterEmail.isEmailVerified, true);
      assert.equal(afterEmail.isMobileVerified, false, "mobile stays unverified");

      const afterMobile = await h.students.markVerified(student.id, "mobile");
      assert.equal(afterMobile.isEmailVerified, true);
      assert.equal(afterMobile.isMobileVerified, true);
    });

    it("filters by approval status, backing the approvals view", async () => {
      const a = await h.students.create(studentInput());
      await h.students.create(studentInput({ email: "b@test.local", mobile: "9000000002" }));

      await h.students.recordApprovalDecision(a.id, {
        status: "approved",
        decidedByUserId: "admin-1",
        decidedAt: "2026-11-17T08:00:00.000Z",
      });

      const pending = await h.students.findMany({ approvalStatus: "pending" }, PAGE);

      assert.equal(pending.total, 1);
      assert.equal(pending.items[0]?.email, "b@test.local");
    });

    it("searches across name, email, mobile and college", async () => {
      await h.students.create(studentInput({ name: "Ananya Rao" }));
      await h.students.create(
        studentInput({ name: "Bhavya Singh", email: "b@test.local", mobile: "9000000002" }),
      );

      assert.equal((await h.students.findMany({ search: "ananya" }, PAGE)).total, 1);
      assert.equal((await h.students.findMany({ search: "NEXELVORIA" }, PAGE)).total, 2);
      assert.equal((await h.students.findMany({ search: "zzz" }, PAGE)).total, 0);
    });

    it("returns the exact frontend pagination shape", async () => {
      for (let i = 0; i < 12; i += 1) {
        await h.students.create(
          studentInput({ email: `s${i}@test.local`, mobile: `900000${1000 + i}` }),
        );
      }

      const page1 = await h.students.findMany({}, { page: 1, pageSize: 5 });

      assert.deepEqual(Object.keys(page1).sort(), [
        "items",
        "page",
        "pageSize",
        "total",
        "totalPages",
      ]);
      assert.equal(page1.items.length, 5);
      assert.equal(page1.total, 12);
      assert.equal(page1.totalPages, 3);

      const page3 = await h.students.findMany({}, { page: 3, pageSize: 5 });
      assert.equal(page3.items.length, 2, "last page is partial");
    });

    it("hands back detached copies, as a real database would", async () => {
      const created = await h.students.create(studentInput());

      created.name = "MUTATED LOCALLY";

      const reloaded = await h.students.findById(created.id);
      assert.equal(reloaded?.name, "Ananya Rao", "store must not share references");
    });
  });

  describe("courses", () => {
    it("creates as an unpublished draft", async () => {
      const course = await h.courses.create(courseInput());

      assert.equal(course.isPublished, false, "never published on create");
      assert.equal(course.status, "Draft");
      assert.deepEqual(course.modules, []);
    });

    it("keeps drafts out of the public catalogue", async () => {
      const draft = await h.courses.create(courseInput());
      await h.courses.create(courseInput({ slug: "data-science", title: "Data Science" }));

      await h.courses.setPublished(draft.id, true);

      const publicList = await h.courses.findMany({ publishedOnly: true }, PAGE);
      const manageList = await h.courses.findMany({}, PAGE);

      assert.equal(publicList.total, 1, "only the published course is public");
      assert.equal(publicList.items[0]?.slug, "java-full-stack");
      assert.equal(manageList.total, 2, "management sees drafts too");
    });

    it("finds by slug case-insensitively", async () => {
      await h.courses.create(courseInput());

      assert.ok(await h.courses.findBySlug("JAVA-FULL-STACK"));
      assert.equal(await h.courses.existsBySlug("java-full-stack"), true);
    });

    it("replaces the curriculum wholesale and finds a nested lesson", async () => {
      const course = await h.courses.create(courseInput());

      await h.courses.replaceCurriculum(course.id, [
        {
          id: "m1",
          courseId: course.id,
          title: "Module 1",
          description: "d",
          order: 1,
          chapters: [
            {
              id: "ch1",
              moduleId: "m1",
              title: "Chapter 1",
              order: 1,
              lessons: [
                {
                  id: "l1",
                  chapterId: "ch1",
                  title: "Intro",
                  durationMinutes: 20,
                  isFreePreview: true,
                  order: 1,
                },
              ],
            },
          ],
        },
      ]);

      const found = await h.courses.findLessonById(course.id, "l1");

      assert.equal(found?.lesson.title, "Intro");
      assert.equal(found?.lesson.isFreePreview, true, "BR-003 preview flag is readable");

      // A second replace discards the first tree entirely.
      const emptied = await h.courses.replaceCurriculum(course.id, []);
      assert.deepEqual(emptied.modules, []);
      assert.equal(await h.courses.findLessonById(course.id, "l1"), null);
    });

    it("filters by category and level", async () => {
      await h.courses.create(courseInput());
      await h.courses.create(
        courseInput({ slug: "aws", title: "AWS", category: "Cloud & DevOps", level: "Advanced" }),
      );

      assert.equal((await h.courses.findMany({ category: "Cloud & DevOps" }, PAGE)).total, 1);
      assert.equal((await h.courses.findMany({ level: "Beginner" }, PAGE)).total, 1);
    });

    it("searches technologies as well as text", async () => {
      await h.courses.create(courseInput());

      assert.equal((await h.courses.findMany({ search: "spring" }, PAGE)).total, 1);
    });
  });

  describe("enrollments", () => {
    it("starts with zero progress and no lessons", async () => {
      const enrollment = await h.enrollments.create({
        studentId: "student-1",
        courseId: "course-1",
        enrollmentType: "self",
        status: "pending_approval",
      });

      assert.equal(enrollment.progressPercentage, 0);
      assert.deepEqual(enrollment.completedLessonIds, []);
      assert.deepEqual(enrollment.bookmarkedLessonIds, []);
    });

    it("marking a lesson complete is idempotent", async () => {
      const e = await h.enrollments.create({
        studentId: "student-1",
        courseId: "course-1",
        enrollmentType: "self",
        status: "active",
      });

      await h.enrollments.markLessonCompleted(e.id, "l1", 25);
      const twice = await h.enrollments.markLessonCompleted(e.id, "l1", 25);

      assert.deepEqual(twice.completedLessonIds, ["l1"], "a retry must not double-count");
      assert.equal(twice.progressPercentage, 25);
    });

    it("adds and removes bookmarks idempotently", async () => {
      const e = await h.enrollments.create({
        studentId: "student-1",
        courseId: "course-1",
        enrollmentType: "self",
        status: "active",
      });

      await h.enrollments.addBookmark(e.id, "l1");
      const added = await h.enrollments.addBookmark(e.id, "l1");
      assert.deepEqual(added.bookmarkedLessonIds, ["l1"]);

      await h.enrollments.removeBookmark(e.id, "l1");
      const removedAgain = await h.enrollments.removeBookmark(e.id, "l1");
      assert.deepEqual(removedAgain.bookmarkedLessonIds, [], "removing twice is a no-op");
    });

    it("stamps completedAt when moving to completed", async () => {
      const e = await h.enrollments.create({
        studentId: "student-1",
        courseId: "course-1",
        enrollmentType: "self",
        status: "active",
      });

      const completed = await h.enrollments.setStatus(e.id, "completed");

      assert.equal(completed.status, "completed");
      assert.ok(completed.completedAt);
    });

    it("finds the enrolment that decides preview-vs-full access (BR-003)", async () => {
      await h.enrollments.create({
        studentId: "student-1",
        courseId: "course-1",
        enrollmentType: "self",
        status: "approved_unpaid",
      });

      const found = await h.enrollments.findByStudentAndCourse("student-1", "course-1");

      assert.equal(found?.status, "approved_unpaid", "unpaid means preview only");
      assert.equal(await h.enrollments.findByStudentAndCourse("student-9", "course-1"), null);
    });

    it("counts only active enrolments per batch (for the Q5 capacity check)", async () => {
      await h.enrollments.create({
        studentId: "student-1",
        courseId: "course-1",
        batchId: "batch-1",
        enrollmentType: "self",
        status: "active",
      });
      await h.enrollments.create({
        studentId: "student-2",
        courseId: "course-1",
        batchId: "batch-1",
        enrollmentType: "self",
        status: "cancelled",
      });
      await h.enrollments.create({
        studentId: "student-3",
        courseId: "course-1",
        batchId: "batch-2",
        enrollmentType: "self",
        status: "active",
      });

      assert.equal(await h.enrollments.countActiveByBatch("batch-1"), 1);
      assert.equal(await h.enrollments.countActiveByBatch("batch-2"), 1);
      assert.equal(await h.enrollments.countActiveByBatch("batch-9"), 0);
    });
  });

  describe("teachers", () => {
    it("allocation drives the authorization primitive", async () => {
      const teacher = await h.teachers.create({
        name: "R Kumar",
        email: "r@test.local",
        mobile: "9111111111",
        specialization: "Java",
        experienceYears: 8,
        bio: "bio",
        qualifications: "MTech",
      });

      assert.equal(
        await h.teachers.isAllocatedToBatch(teacher.id, "batch-1"),
        false,
        "no allocation means no access — fail closed",
      );

      await h.teachers.addAllocation({
        teacherId: teacher.id,
        courseId: "course-1",
        batchId: "batch-1",
      });

      assert.equal(await h.teachers.isAllocatedToBatch(teacher.id, "batch-1"), true);
      assert.equal(
        await h.teachers.isAllocatedToBatch(teacher.id, "batch-2"),
        false,
        "allocation is per batch, not blanket",
      );
      assert.equal(
        await h.teachers.isAllocatedToBatch("teacher-999", "batch-1"),
        false,
        "an unknown teacher is never allocated",
      );
    });

    it("keeps the denormalised arrays consistent with allocations", async () => {
      const teacher = await h.teachers.create({
        name: "R Kumar",
        email: "r@test.local",
        mobile: "9111111111",
        specialization: "Java",
        experienceYears: 8,
        bio: "bio",
        qualifications: "MTech",
      });

      const allocated = await h.teachers.addAllocation({
        teacherId: teacher.id,
        courseId: "course-1",
        batchId: "batch-1",
      });

      assert.deepEqual(allocated.assignedCourseIds, ["course-1"]);
      assert.deepEqual(allocated.assignedBatchIds, ["batch-1"]);

      const removed = await h.teachers.removeAllocation(teacher.id, "batch-1");

      assert.deepEqual(removed.assignedBatchIds, []);
      assert.deepEqual(removed.assignedCourseIds, []);
      assert.equal(await h.teachers.isAllocatedToBatch(teacher.id, "batch-1"), false);
    });

    it("finds teachers by batch", async () => {
      const a = await h.teachers.create({
        name: "A",
        email: "a@test.local",
        mobile: "1",
        specialization: "Java",
        experienceYears: 5,
        bio: "b",
        qualifications: "q",
      });
      const b = await h.teachers.create({
        name: "B",
        email: "b@test.local",
        mobile: "2",
        specialization: "React",
        experienceYears: 3,
        bio: "b",
        qualifications: "q",
      });

      await h.teachers.addAllocation({ teacherId: a.id, courseId: "c1", batchId: "batch-1" });
      await h.teachers.addAllocation({ teacherId: b.id, courseId: "c1", batchId: "batch-2" });

      const batch1 = await h.teachers.findByBatch("batch-1");

      assert.equal(batch1.length, 1);
      assert.equal(batch1[0]?.id, a.id);
      assert.deepEqual(await h.teachers.findByBatch("batch-9"), []);
    });

    it("allocating to a missing teacher throws", async () => {
      await assert.rejects(
        () => h.teachers.addAllocation({ teacherId: "ghost", courseId: "c", batchId: "b" }),
        RecordNotFoundError,
      );
    });
  });

  describe("users", () => {
    it("finds by email case-insensitively and by mobile", async () => {
      await h.users.create({
        name: "Admin One",
        email: "Admin@test.local",
        mobile: "9222222222",
        role: "admin",
        status: "active",
      });

      assert.ok(await h.users.findByEmail("admin@test.local"));
      assert.ok(await h.users.findByMobile("9222222222"));
      assert.equal(await h.users.existsByEmail("ADMIN@TEST.LOCAL"), true);
      assert.equal(await h.users.existsByMobile("0000000000"), false);
    });

    it("filters by role, matching the frontend role values", async () => {
      await h.users.create({
        name: "S",
        email: "s@test.local",
        mobile: "1",
        role: "student",
        status: "active",
      });
      await h.users.create({
        name: "SA",
        email: "sa@test.local",
        mobile: "2",
        role: "super_admin",
        status: "active",
      });

      const superAdmins = await h.users.findMany({ role: "super_admin" }, PAGE);

      assert.equal(superAdmins.total, 1);
      assert.equal(superAdmins.items[0]?.role, "super_admin");
    });

    it("setStatus changes only the status", async () => {
      const user = await h.users.create({
        name: "S",
        email: "s@test.local",
        mobile: "1",
        role: "student",
        status: "active",
      });

      const suspended = await h.users.setStatus(user.id, "suspended");

      assert.equal(suspended.status, "suspended");
      assert.equal(suspended.name, "S");
    });
  });

  /**
   * Step 6K-1 - the registration path.
   *
   * `createForUser` creates the PROFILE half of a student for a user that
   * already exists, under that user's OWN id. The shared key is what links
   * the identity login resolves to the admissions data, so it is the first
   * thing asserted here.
   */
  describe("students - createForUser (Step 6K-1)", () => {
    const newUser = (overrides: Partial<CreateUserInput> = {}) =>
      h.users.create({
        name: "Ananya Rao",
        email: "ananya@test.local",
        mobile: "9000000001",
        role: "student",
        status: "pending",
        ...overrides,
      });

    it("uses the user's id as the student id - the shared-key invariant", async () => {
      const user = await newUser();
      const student = await h.students.createForUser(user.id, studentProfile());

      assert.equal(student.id, user.id, "Student.id must equal User.id");
      assert.equal(student.id, "user-1");
    });

    it("does NOT generate a second id", async () => {
      const user = await newUser();
      await h.students.createForUser(user.id, studentProfile());

      // The student store's own sequence was never advanced, so nothing is
      // keyed "student-1" and the only row answers to the user's id.
      assert.equal(await h.students.findById("student-1"), null);
      assert.ok(await h.students.findById(user.id));
      assert.equal(h.students.count, 1);

      // Proof the sequence is untouched: a later `create` still gets -1.
      const standalone = await h.students.create(
        studentInput({ email: "other@test.local", mobile: "9000000002" }),
      );
      assert.equal(standalone.id, "student-1");
    });

    it("copies identity from the user row, not from the profile input", async () => {
      const user = await newUser({
        name: "Priya Nair",
        email: "priya@test.local",
        mobile: "9123456780",
        status: "active",
      });

      const student = await h.students.createForUser(user.id, studentProfile());

      assert.equal(student.name, "Priya Nair");
      assert.equal(student.email, "priya@test.local");
      assert.equal(student.mobile, "9123456780");
      assert.equal(student.status, "active");
      assert.equal(student.createdAt, user.createdAt);
    });

    it("applies the server-owned defaults, exactly as create() does", async () => {
      const user = await newUser();
      const student = await h.students.createForUser(user.id, studentProfile());

      assert.equal(student.role, "student");
      assert.equal(student.isEmailVerified, false, "BR-001 starts unverified");
      assert.equal(student.isMobileVerified, false, "BR-001 starts unverified");
      assert.equal(student.adminApprovalStatus, "pending", "BR-002 starts pending");
      assert.deepEqual(student.enrolledCourseIds, []);
    });

    it("leaves accountState unset rather than inventing one", async () => {
      const user = await newUser();
      const student = await h.students.createForUser(user.id, studentProfile());

      // The status / adminApprovalStatus -> accountState mapping is not a
      // confirmed business rule, so no value is fabricated here. The field
      // is optional on `Student`, so absent is valid.
      assert.equal("accountState" in student, false);
      assert.equal(student.accountState, undefined);
    });

    it("persists every admissions field supplied", async () => {
      const user = await newUser();
      const profile = studentProfile({
        collegeName: "IIT Hyderabad",
        degreeBranch: "ECE",
        passingYear: "2025",
        courseInterestedIn: "Data Science",
        dateOfBirth: "2003-01-02",
        gender: "male",
        fullAddress: "12 Road, Hyderabad 500001",
        guardianContact: "9876543210",
        linkedInUrl: "https://linkedin.com/in/example",
        githubUrl: "https://github.com/example",
      });

      const student = await h.students.createForUser(user.id, profile);
      const stored = student as unknown as Record<string, unknown>;

      for (const [field, value] of Object.entries(profile)) {
        assert.equal(stored[field], value, `${field} must be persisted`);
      }
    });

    it("omits optional fields that were not supplied", async () => {
      const user = await newUser();
      const student = await h.students.createForUser(user.id, studentProfile());

      // Absent, not present-and-undefined - the discipline
      // `exactOptionalPropertyTypes` exists to enforce.
      for (const field of [
        "guardianContact",
        "resumeUrl",
        "resumeFileName",
        "resumeFileSize",
        "linkedInUrl",
        "githubUrl",
        "avatarUrl",
      ]) {
        assert.equal(field in student, false, `${field} must be absent`);
      }
    });

    it("throws RecordNotFoundError when the user does not exist", async () => {
      await assert.rejects(
        () => h.students.createForUser("user-404", studentProfile()),
        (err: unknown) => {
          assert.ok(err instanceof RecordNotFoundError);
          assert.equal(err.entity, "user");
          assert.equal(err.id, "user-404");
          return true;
        },
      );

      assert.equal(h.students.count, 0, "nothing was written");
    });

    it("throws DuplicateRecordError on a second profile for the same user", async () => {
      const user = await newUser();
      await h.students.createForUser(user.id, studentProfile());

      await assert.rejects(
        () => h.students.createForUser(user.id, studentProfile({ collegeName: "Other" })),
        (err: unknown) => {
          assert.ok(err instanceof DuplicateRecordError);
          assert.equal(err.entity, "student");
          assert.equal(err.field, "userId");
          return true;
        },
      );

      // The first profile is intact - the refused write changed nothing.
      assert.equal(h.students.count, 1);
      assert.equal((await h.students.findById(user.id))?.collegeName, "Nexelvoria Institute");
    });

    it("does NOT silently convert a non-student user into a student", async () => {
      const roles = ["teacher", "admin", "super_admin", "public"] as const;

      for (const [index, role] of roles.entries()) {
        const user = await newUser({
          role,
          email: `${role}@test.local`,
          mobile: `900000010${index}`,
        });

        await assert.rejects(
          () => h.students.createForUser(user.id, studentProfile()),
          (err: unknown) => {
            assert.ok(err instanceof Error);
            // A programming error, NOT a RepositoryError: those subtypes
            // carry an agreed HTTP mapping (404 / 409) and this is neither.
            assert.equal(
              err instanceof RepositoryError,
              false,
              "a role mismatch is not a repository condition",
            );
            assert.match(err.message, /not "student"/);
            return true;
          },
        );

        assert.equal(
          await h.students.findById(user.id),
          null,
          `no profile may be written for a ${role} user`,
        );
      }

      assert.equal(h.students.count, 0);
    });

    it("does not re-check the email the user row already holds", async () => {
      // The user owns the email and mobile uniqueness. Re-checking it here
      // would throw a duplicate on the identifiers registration has just
      // reserved for this very person.
      const user = await newUser();
      const student = await h.students.createForUser(user.id, studentProfile());

      assert.equal(student.email, user.email);
      assert.equal(student.mobile, user.mobile);
    });

    it("is visible to findById, findByEmail and findMany", async () => {
      const user = await newUser();
      await h.students.createForUser(user.id, studentProfile());

      assert.equal((await h.students.findById(user.id))?.id, user.id);
      assert.equal((await h.students.findByEmail("ANANYA@TEST.LOCAL"))?.id, user.id);

      const page = await h.students.findMany({}, PAGE);
      assert.equal(page.total, 1);
      assert.equal(page.items[0]?.id, user.id);
    });

    it("fails loudly when no user source is wired", async () => {
      const standalone = new InMemoryStudentRepository();

      await assert.rejects(
        () => standalone.createForUser("user-1", studentProfile()),
        /needs a user source/,
      );
    });

    it("leaves create() behaviour unchanged", async () => {
      const student = await h.students.create(studentInput());

      assert.equal(student.id, "student-1", "create still mints its own id");
      assert.equal(student.role, "student");
      assert.equal(student.adminApprovalStatus, "pending");

      // create() still owns its uniqueness checks.
      await assert.rejects(
        () => h.students.create(studentInput({ mobile: "9000000003" })),
        DuplicateRecordError,
      );
    });
  });
});
