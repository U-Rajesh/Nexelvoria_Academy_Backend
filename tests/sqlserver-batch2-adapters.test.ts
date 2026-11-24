import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type sql from "mssql";

import { SqlServerStudentRepository } from "../src/modules/students/sqlserver-student.repository";
import { SqlServerCourseRepository } from "../src/modules/courses/sqlserver-course.repository";
import { SqlServerEnrollmentRepository } from "../src/modules/enrollments/sqlserver-enrollment.repository";
import { DuplicateRecordError, RecordInUseError, RecordNotFoundError, UnsupportedFieldsError } from "../src/repositories/repository.errors";

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
    transaction: () => ({
      begin: async () => handler("BEGIN TRAN", {}),
      commit: async () => handler("COMMIT", {}),
      rollback: async () => handler("ROLLBACK", {}),
      request: () => new MockSqlRequest(handler),
    }),
  } as unknown as sql.ConnectionPool;
};

describe("SqlServerStudentRepository (unit with mock pool)", () => {
  it("maps database row to Student entity correctly in findById", async () => {
    const mockRow = {
      UserId: 201,
      FullName: "Priya Nair",
      Email: "priya@nexelvoria.in",
      MobileNumber: "9123456780",
      AccountStatus: "active",
      EmailVerified: 1,
      MobileVerified: 0,
      UserCreatedAt: new Date("2026-02-01T10:00:00Z"),
      CollegeName: "IIT Madras",
      Degree: "B.Tech",
      Branch: "CSE",
      PassingYear: 2025,
      InterestedCourseId: 10,
      DateOfBirth: new Date("2002-05-10"),
      Gender: "female",
      AddressLine1: "Hostel 4",
      AddressLine2: null,
      City: "Chennai",
      State: "Tamil Nadu",
      Country: "India",
      PostalCode: "600036",
      GuardianName: "K. Nair",
      GuardianMobile: "9876543219",
      GuardianCountryCode: "+91",
      LinkedInUrl: "https://linkedin.com/in/priya",
      GitHubUrl: "https://github.com/priya",
      ResumeObjectKey: "resumes/priya.pdf",
      ApprovalStatus: "approved",
      ApprovedByUserId: 1,
      ApprovedAt: new Date("2026-02-02T10:00:00Z"),
      RejectionReason: null,
      EnrolledCourseIds: "10,12",
    };

    const pool = createMockPool(() => ({ recordset: [mockRow] }));
    const repo = new SqlServerStudentRepository(pool);

    const student = await repo.findById("201");
    assert.ok(student !== null);
    assert.equal(student.id, "201");
    assert.equal(student.name, "Priya Nair");
    assert.equal(student.email, "priya@nexelvoria.in");
    assert.equal(student.role, "student");
    assert.equal(student.collegeName, "IIT Madras");
    assert.equal(student.degreeBranch, "B.Tech - CSE");
    assert.equal(student.gender, "female");
    assert.equal(student.isEmailVerified, true);
    assert.equal(student.adminApprovalStatus, "approved");
    assert.deepEqual(student.enrolledCourseIds, ["10", "12"]);
  });

  it("returns null when student does not exist", async () => {
    const pool = createMockPool(() => ({ recordset: [] }));
    const repo = new SqlServerStudentRepository(pool);

    const student = await repo.findById("9999");
    assert.equal(student, null);
  });

  it("checks email existence case-insensitively", async () => {
    const pool = createMockPool((_q, inputs) => {
      assert.equal(inputs["email"], "test@nexelvoria.in");
      return { recordset: [{ cnt: 1 }] };
    });
    const repo = new SqlServerStudentRepository(pool);

    const exists = await repo.existsByEmail("TEST@NEXELVORIA.IN");
    assert.equal(exists, true);
  });

  it("marks verification channel confirmed", async () => {
    let updateExecuted = false;
    const pool = createMockPool((q, inputs) => {
      if (q.includes("UPDATE dbo.NXA_Users")) {
        updateExecuted = true;
        assert.equal(inputs["id"], "201");
        return { rowsAffected: [1] };
      }
      return {
        recordset: [
          {
            UserId: 201,
            FullName: "Priya Nair",
            Email: "priya@nexelvoria.in",
            MobileNumber: "9123456780",
            AccountStatus: "active",
            EmailVerified: 1,
            MobileVerified: 0,
            UserCreatedAt: new Date(),
            ApprovalStatus: "approved",
          },
        ],
      };
    });
    const repo = new SqlServerStudentRepository(pool);

    const student = await repo.markVerified("201", "email");
    assert.equal(updateExecuted, true);
    assert.equal(student.isEmailVerified, true);
  });

  it("clears lockout on student account", async () => {
    let cleared = false;
    const pool = createMockPool((q) => {
      if (q.includes("UPDATE dbo.NXA_Users")) {
        cleared = true;
        return { rowsAffected: [1] };
      }
      return {
        recordset: [
          {
            UserId: 201,
            FullName: "Priya Nair",
            Email: "priya@nexelvoria.in",
            MobileNumber: "9123456780",
            AccountStatus: "active",
            UserCreatedAt: new Date(),
            ApprovalStatus: "approved",
          },
        ],
      };
    });
    const repo = new SqlServerStudentRepository(pool);

    await repo.clearLockout("201");
    assert.equal(cleared, true);
  });
});

describe("SqlServerCourseRepository (unit with mock pool)", () => {
  it("maps course row and curriculum correctly in findById", async () => {
    const mockCourse = {
      CourseId: 10,
      CourseCode: "FS-PYTHON",
      CourseName: "Full Stack Python Development",
      CourseLevel: "Beginner",
      Description: "Comprehensive Full Stack Python",
      ShortDescription: "Learn Python, Django, React",
      DurationValue: 16,
      DurationUnit: "WEEKS",
      ListPrice: 25000,
      CurrencyCode: "INR",
      IsPreviewEnabled: 1,
      Status: "PUBLISHED",
      CreatedAt: new Date("2026-01-01T00:00:00Z"),
      UpdatedAt: null,
    };

    const mockCurriculum = [
      {
        ModuleId: 101,
        CourseId: 10,
        ModuleTitle: "Python Fundamentals",
        ModuleDescription: "Basics of Python",
        ModuleSequence: 1,
        ChapterId: 201,
        ChapterTitle: "Variables and Data Types",
        ChapterDescription: "Syntax overview",
        ChapterSequence: 1,
        LessonId: 301,
        LessonTitle: "Installing Python",
        LessonType: "video",
        DurationMinutes: 15,
        ExternalUrl: "https://video.nexelvoria.in/py1",
        IsPreview: 1,
        IsDownloadAllowed: 0,
        LessonSequence: 1,
      },
    ];

    const pool = createMockPool((q) => {
      if (q.includes("FROM dbo.NXA_CourseModules")) {
        return { recordset: mockCurriculum };
      }
      return { recordset: [mockCourse] };
    });
    const repo = new SqlServerCourseRepository(pool);

    const course = await repo.findById("10");
    assert.ok(course !== null);
    assert.equal(course.id, "10");
    assert.equal(course.slug, "fs-python");
    assert.equal(course.title, "Full Stack Python Development");
    assert.equal(course.isPublished, true);
    assert.equal(course.feeINR, 25000);
    assert.equal(course.modules.length, 1);
    assert.equal(course.modules[0]?.chapters.length, 1);
    assert.equal(course.modules[0]?.chapters[0]?.lessons.length, 1);
    assert.equal(course.modules[0]?.chapters[0]?.lessons[0]?.isFreePreview, true);
  });

  it("finds a single lesson by course and lesson id", async () => {
    const mockCourse = {
      CourseId: 10,
      CourseCode: "FS-PYTHON",
      CourseName: "Full Stack Python Development",
      Status: "PUBLISHED",
      ListPrice: 25000,
      DurationValue: 12,
    };
    const mockCurriculum = [
      {
        ModuleId: 101,
        CourseId: 10,
        ModuleTitle: "Module 1",
        ModuleSequence: 1,
        ChapterId: 201,
        ChapterTitle: "Chapter 1",
        ChapterSequence: 1,
        LessonId: 301,
        LessonTitle: "Preview Lesson",
        LessonType: "video",
        IsPreview: 1,
        LessonSequence: 1,
      },
    ];

    const pool = createMockPool((q) => {
      if (q.includes("FROM dbo.NXA_CourseModules")) {
        return { recordset: mockCurriculum };
      }
      return { recordset: [mockCourse] };
    });
    const repo = new SqlServerCourseRepository(pool);

    const found = await repo.findLessonById("10", "301");
    assert.ok(found !== null);
    assert.equal(found.lesson.id, "301");
    assert.equal(found.lesson.title, "Preview Lesson");
  });

  it("throws DuplicateRecordError on duplicate slug creation", async () => {
    const pool = createMockPool(() => {
      const err = new Error("Violation of UNIQUE KEY constraint");
      (err as unknown as { number: number }).number = 2627;
      throw err;
    });
    const repo = new SqlServerCourseRepository(pool);

    await assert.rejects(
      () =>
        repo.create({
          slug: "fs-python",
          title: "Full Stack Python",
          shortDescription: "Short",
          longDescription: "Long",
          durationWeeks: 12,
          feeINR: 20000,
          level: "Beginner",
        }),
      DuplicateRecordError,
    );
  });

  it("refuses fields NXA_Courses cannot store instead of silently dropping them", async () => {
    let wrote = false;
    const pool = createMockPool(() => {
      wrote = true;
      return { recordset: [] };
    });
    const repo = new SqlServerCourseRepository(pool);
    await assert.rejects(
      () =>
        repo.create({
          slug: "fs-python",
          title: "Full Stack Python",
          shortDescription: "Short",
          longDescription: "Long",
          durationWeeks: 12,
          feeINR: 20000,
          level: "Beginner",
          category: "Data & AI",
          technologies: ["Python"],
        }),
      (err: Error & { fields?: string[] }) =>
        err instanceof UnsupportedFieldsError && err.fields?.join(",") === "category,technologies",
    );
    await assert.rejects(() => repo.update("10", { totalHours: 90 }), UnsupportedFieldsError);
    await assert.rejects(() => repo.update("10", { courseCode: "NEW-CODE" }), UnsupportedFieldsError);
    assert.equal(wrote, false, "nothing reaches the database");
  });

  describe("curriculum save keeps ids stable", () => {
    const course = { CourseId: 10, CourseCode: "FS", CourseName: "FS", Status: "DRAFT", ListPrice: 1, DurationValue: 12 };
    const storedIds = [
      { ModuleId: 101, ChapterId: 201, LessonId: 301 },
      { ModuleId: 101, ChapterId: 201, LessonId: 302 },
    ];
    const tree = (lessons: { id: string; title: string; videoUrl?: string; pdfUrl?: string }[]) => [
      {
        id: "101", courseId: "10", title: "M1", description: "", order: 1,
        chapters: [{
          id: "201", moduleId: "101", title: "C1", order: 1,
          lessons: lessons.map((l, i) => ({ chapterId: "201", durationMinutes: 10, isFreePreview: false, order: i + 1, ...l })),
        }],
      },
    ];

    it("updates kept lessons in place, inserts new ones and deletes removed ones in one transaction", async () => {
      const log: string[] = [];
      let lessonUpdateInputs: Record<string, unknown> = {};
      const pool = createMockPool((q, inputs) => {
        if (["BEGIN TRAN", "COMMIT", "ROLLBACK"].includes(q)) {
          log.push(q);
          return { recordset: [] };
        }
        if (q.includes("FROM dbo.NXA_CourseVersions")) return { recordset: [{ CourseVersionId: 9, IsCurrent: true }] };
        if (q.includes("WITH (UPDLOCK, HOLDLOCK)")) return { recordset: storedIds };
        if (q.includes("UPDATE dbo.NXA_Lessons")) {
          log.push(`update-lesson:${inputs["id"]}`);
          lessonUpdateInputs = { ...inputs };
          return { recordset: [] };
        }
        if (q.includes("INSERT INTO dbo.NXA_Lessons")) {
          log.push("insert-lesson");
          return { recordset: [] };
        }
        if (q.includes("DELETE FROM dbo.NXA_Lessons")) {
          log.push(`delete-lesson:${inputs["id"]}`);
          return { recordset: [] };
        }
        if (q.includes("DELETE")) {
          log.push("delete-other");
          return { recordset: [] };
        }
        if (q.includes("FROM dbo.NXA_CourseModules")) return { recordset: [] };
        return { recordset: [course] };
      });
      const repo = new SqlServerCourseRepository(pool);

      await repo.replaceCurriculum(
        "10",
        tree([
          { id: "301", title: "Kept lesson", videoUrl: "https://video.example/1" },
          { id: "client-new-1", title: "New lesson" },
        ]),
      );

      assert.ok(log.includes("update-lesson:301"), "lesson 301 keeps its id");
      assert.equal(lessonUpdateInputs["url"], "https://video.example/1", "video URL is saved");
      assert.ok(log.includes("insert-lesson"));
      assert.ok(log.includes("delete-lesson:302"), "the removed lesson is deleted");
      assert.ok(!log.includes("delete-other"), "the kept module and chapter are not deleted");
      assert.equal(log[0], "BEGIN TRAN");
      assert.ok(log.includes("COMMIT"));
    });

    it("rolls back and reports in-use when a removed lesson still has linked records", async () => {
      const log: string[] = [];
      const pool = createMockPool((q) => {
        if (["BEGIN TRAN", "COMMIT", "ROLLBACK"].includes(q)) {
          log.push(q);
          return { recordset: [] };
        }
        if (q.includes("FROM dbo.NXA_CourseVersions")) return { recordset: [{ CourseVersionId: 9, IsCurrent: true }] };
        if (q.includes("WITH (UPDLOCK, HOLDLOCK)")) return { recordset: storedIds };
        if (q.includes("DELETE FROM dbo.NXA_Lessons")) {
          const fk = new Error("The DELETE statement conflicted with the REFERENCE constraint");
          (fk as unknown as { number: number }).number = 547;
          return fk;
        }
        if (q.includes("FROM dbo.NXA_CourseModules")) return { recordset: [] };
        return { recordset: [course] };
      });
      await assert.rejects(
        () => new SqlServerCourseRepository(pool).replaceCurriculum("10", tree([{ id: "301", title: "Kept" }])),
        RecordInUseError,
      );
      assert.ok(log.includes("ROLLBACK"));
      assert.ok(!log.includes("COMMIT"));
    });

    it("refuses lesson content the table cannot store", async () => {
      const pool = createMockPool(() => ({ recordset: [course] }));
      await assert.rejects(
        () => new SqlServerCourseRepository(pool).replaceCurriculum("10", tree([{ id: "301", title: "L", pdfUrl: "https://x/y.pdf" }])),
        UnsupportedFieldsError,
      );
    });
  });

  it("persists duration on update and never changes the free-preview flag when publishing", async () => {
    const course = {
      CourseId: 10, CourseCode: "FS-PYTHON", CourseName: "FS", Status: "DRAFT", ListPrice: 1,
      DurationValue: 12, DurationUnit: "WEEKS", IsPreviewEnabled: 1,
    };
    const writes: { q: string; inputs: Record<string, unknown> }[] = [];
    const pool = createMockPool((q, inputs) => {
      if (q.includes("UPDATE dbo.NXA_Courses")) {
        writes.push({ q, inputs: { ...inputs } });
        return { recordset: [], rowsAffected: [1] };
      }
      if (q.includes("FROM dbo.NXA_CourseModules")) return { recordset: [] };
      return { recordset: [course] };
    });
    const repo = new SqlServerCourseRepository(pool);

    await repo.update("10", { durationWeeks: 20 });
    assert.match(writes[0]!.q, /DurationValue = @durationVal/);
    assert.equal(writes[0]!.inputs["durationVal"], 20);

    await repo.setPublished("10", true);
    await repo.setStatus("10", "Archived");
    for (const w of writes.slice(1)) {
      assert.doesNotMatch(w.q, /IsPreviewEnabled/, "publication must not toggle the preview switch");
    }
  });
});

describe("SqlServerEnrollmentRepository (unit with mock pool)", () => {
  it("maps enrollment row correctly in findById", async () => {
    const mockRow = {
      EnrollmentId: 501,
      EnrollmentNumber: "ENR-2026-001",
      StudentUserId: 201,
      CourseId: 10,
      BatchId: 301,
      CoursePrice: 25000,
      DiscountAmount: 0,
      FinalAmount: 25000,
      CurrencyCode: "INR",
      EnrollmentStatus: "ACTIVE",
      EnrollmentSource: "SELF",
      ActivatedAt: new Date("2026-02-05T00:00:00Z"),
      CompletedAt: null,
      CreatedAt: new Date("2026-02-01T00:00:00Z"),
      CompletedLessonIds: "301,302",
      BookmarkedLessonIds: "305",
    };

    const pool = createMockPool(() => ({ recordset: [mockRow] }));
    const repo = new SqlServerEnrollmentRepository(pool);

    const enrollment = await repo.findById("501");
    assert.ok(enrollment !== null);
    assert.equal(enrollment.id, "501");
    assert.equal(enrollment.studentId, "201");
    assert.equal(enrollment.courseId, "10");
    assert.equal(enrollment.batchId, "301");
    assert.equal(enrollment.status, "active");
    assert.deepEqual(enrollment.completedLessonIds, ["301", "302"]);
    assert.deepEqual(enrollment.bookmarkedLessonIds, ["305"]);
  });

  it("counts active students for a batch", async () => {
    const pool = createMockPool((_q, inputs) => {
      assert.equal(inputs["batchId"], "301");
      return { recordset: [{ cnt: 24 }] };
    });
    const repo = new SqlServerEnrollmentRepository(pool);

    const count = await repo.countActiveByBatch("301");
    assert.equal(count, 24);
  });

  it("throws RecordNotFoundError on status update for missing enrollment", async () => {
    const pool = createMockPool(() => ({ rowsAffected: [0] }));
    const repo = new SqlServerEnrollmentRepository(pool);

    await assert.rejects(() => repo.setStatus("9999", "active"), RecordNotFoundError);
  });
});
