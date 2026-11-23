import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type sql from "mssql";

import { SqlServerTeacherRepository } from "../src/modules/teachers/sqlserver-teacher.repository";

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
  const pool = {
    request: () => new MockSqlRequest(handler),
    transaction: () => ({
      begin: async () => {},
      commit: async () => {},
      rollback: async () => {},
      request: () => new MockSqlRequest(handler),
    }),
  } as unknown as sql.ConnectionPool;
  return pool;
};

describe("SqlServerTeacherRepository (unit with mock pool)", () => {
  it("maps database row to Teacher entity in findById", async () => {
    const mockRow = {
      TeacherProfileId: 101,
      UserId: 501,
      FullName: "Dr. Vikram Rao",
      Email: "vikram.rao@nexelvoria.in",
      MobileNumber: "9876543210",
      EmployeeCode: "EMP-2026-001",
      Specialization: "Distributed Systems & Cloud Architecture",
      ExperienceYears: 12,
      Qualification: "Ph.D. in Computer Science",
      Bio: "Senior Faculty & Solutions Architect",
      IsActive: true,
      AssignedCourseIds: "10,20",
    };

    const pool = createMockPool(() => ({ recordset: [mockRow] }));
    const repo = new SqlServerTeacherRepository(pool);

    const profile = await repo.findById("501");
    assert.ok(profile !== null);
    assert.equal(profile.id, "501");
    assert.equal(profile.name, "Dr. Vikram Rao");
    assert.equal(profile.email, "vikram.rao@nexelvoria.in");
    assert.equal(profile.specialization, "Distributed Systems & Cloud Architecture");
    assert.equal(profile.experienceYears, 12);
    assert.deepEqual(profile.assignedCourseIds, ["10", "20"]);
  });

  it("returns null when teacher profile does not exist", async () => {
    const pool = createMockPool(() => ({ recordset: [] }));
    const repo = new SqlServerTeacherRepository(pool);

    const profile = await repo.findById("9999");
    assert.equal(profile, null);
  });

  it("updates teacher profile correctly", async () => {
    let capturedInputs: Record<string, unknown> = {};
    const mockRow = {
      TeacherProfileId: 101,
      UserId: 501,
      FullName: "Dr. Vikram Rao",
      Email: "vikram.rao@nexelvoria.in",
      MobileNumber: "9876543210",
      EmployeeCode: "EMP-2026-001",
      Specialization: "AI & Distributed Systems",
      ExperienceYears: 14,
      Qualification: "Ph.D. in Computer Science",
      Bio: "Updated Bio",
      IsActive: true,
      AssignedCourseIds: "10",
    };

    const pool = createMockPool((q, inputs) => {
      if (q.includes("UPDATE")) {
        capturedInputs = inputs;
      }
      return { recordset: [mockRow] };
    });
    const repo = new SqlServerTeacherRepository(pool);

    const updated = await repo.update("501", {
      specialization: "AI & Distributed Systems",
      experienceYears: 14,
      bio: "Updated Bio",
    });

    assert.equal(capturedInputs.specialization ?? capturedInputs.spec, "AI & Distributed Systems");
    assert.equal(capturedInputs.experienceYears ?? capturedInputs.exp, 14);
    assert.equal(capturedInputs.bio, "Updated Bio");
    assert.equal(updated.specialization, "AI & Distributed Systems");
    assert.equal(updated.experienceYears, 14);
  });

  it("retrieves assigned courses for teacher", async () => {
    const mockRows = [
      {
        CourseId: 1,
        CourseSlug: "full-stack-java",
        CourseName: "Full Stack Java Developer",
        Category: "Software Development",
        DeliveryMode: "Online",
        TotalDurationWeeks: 16,
        Level: "Intermediate",
      },
      {
        CourseId: 2,
        CourseSlug: "python-ai",
        CourseName: "Python & AI Engineering",
        Category: "Data Science",
        DeliveryMode: "Hybrid",
        TotalDurationWeeks: 20,
        Level: "Advanced",
      },
    ];

    const pool = createMockPool(() => ({ recordset: mockRows }));
    const repo = new SqlServerTeacherRepository(pool);

    const courses = await repo.findAssignedCourses("501");
    assert.equal(courses.length, 2);
    assert.equal(courses[0]!.id, "1");
    assert.equal(courses[0]!.title, "Full Stack Java Developer");
    assert.equal(courses[1]!.slug, "python-ai");
  });

  it("retrieves assigned batches for teacher", async () => {
    const mockRows = [
      {
        BatchId: 10,
        BatchCode: "BAT-JAVA-01",
        BatchName: "Morning Java Cohort",
        CourseId: 1,
        CourseName: "Full Stack Java",
        StartDate: new Date("2026-03-01"),
        EndDate: new Date("2026-07-01"),
        ScheduleTiming: "09:00 AM - 11:00 AM IST",
        BatchStatus: "ongoing",
        MaxCapacity: 40,
        CurrentEnrollments: 25,
        MeetingUrl: "https://meet.google.com/test-room",
      },
    ];

    const pool = createMockPool(() => ({ recordset: mockRows }));
    const repo = new SqlServerTeacherRepository(pool);

    const batches = await repo.findAssignedBatches("501");
    assert.equal(batches.length, 1);
    assert.equal(batches[0]!.id, "10");
    assert.equal(batches[0]!.batchCode, "BAT-JAVA-01");
    assert.equal(batches[0]!.batchName, "Morning Java Cohort");
  });

  it("checks batch allocation authorization correctly", async () => {
    const pool = createMockPool((_q, inputs) => {
      const teacherId = inputs.teacherId ?? inputs.teacherUserIdParam;
      const batchId = inputs.batchId ?? inputs.batchIdParam;
      if (Number(batchId) === 10 && Number(teacherId) === 501) {
        return { recordset: [{ cnt: 1, TeacherAllocationId: 1 }] };
      }
      return { recordset: [{ cnt: 0 }] };
    });
    const repo = new SqlServerTeacherRepository(pool);

    const isAllocated = await repo.isAllocatedToBatch("501", "10");
    const notAllocated = await repo.isAllocatedToBatch("501", "99");

    assert.equal(isAllocated, true);
    assert.equal(notAllocated, false);
  });

  it("records attendance matrix atomically", async () => {
    const pool = createMockPool((cmd) => {
      if (cmd.includes("INSERT INTO dbo.NXA_ClassSessions")) {
        return { recordset: [{ ClassSessionId: 888 }] };
      }
      return { recordset: [] };
    });
    const repo = new SqlServerTeacherRepository(pool);

    const result = await repo.recordAttendanceSession(
      "501",
      {
        batchId: "10",
        courseId: "1",
        sessionTitle: "Spring Cloud Gateway",
      },
      [
        { studentUserId: "301", status: "present" },
        { studentUserId: "302", status: "absent", remarks: "Medical" },
      ],
    );

    assert.equal(result.id, "888");
    assert.equal(result.batchId, "10");
    assert.equal(result.sessionTitle, "Spring Cloud Gateway");
  });

  it("retrieves student personal attendance logs and computes percentages", async () => {
    const mockRows = [
      {
        AttendanceRecordId: 1,
        ClassSessionId: 101,
        StudentUserId: 301,
        AttendanceStatus: "present",
        Remarks: null,
        MarkedAt: new Date("2026-11-10"),
        MarkedByUserId: 501,
      },
      {
        AttendanceRecordId: 2,
        ClassSessionId: 102,
        StudentUserId: 301,
        AttendanceStatus: "absent",
        Remarks: "Fever",
        MarkedAt: new Date("2026-11-11"),
        MarkedByUserId: 501,
      },
    ];

    const pool = createMockPool(() => ({ recordset: mockRows }));
    const repo = new SqlServerTeacherRepository(pool);

    const records = await repo.findStudentAttendance("301");
    assert.equal(records.length, 2);
    assert.equal(records[0]!.status, "present");
    assert.equal(records[1]!.status, "absent");
    assert.equal(records[1]!.remarks, "Fever");
  });

  it("creates and retrieves coursework assignments", async () => {
    const mockAssignmentRow = {
      AssignmentId: 55,
      CourseId: 1,
      BatchId: 10,
      LessonId: null,
      Title: "Kafka Distributed Sagas",
      Instructions: "Implement an idempotent Kafka consumer",
      MaximumMarks: 50,
      DueAt: new Date("2026-12-01"),
      AllowLateSubmission: true,
      Status: "published",
      CreatedByTeacherUserId: 501,
      CreatedAt: new Date("2026-11-22"),
    };

    const pool = createMockPool(() => {
      return { recordset: [mockAssignmentRow] };
    });
    const repo = new SqlServerTeacherRepository(pool);

    const created = await repo.createAssignment("501", {
      courseId: "1",
      batchId: "10",
      title: "Kafka Distributed Sagas",
      instructions: "Implement an idempotent Kafka consumer",
      maximumMarks: 50,
      dueAt: "2026-12-01T23:59:59Z",
      allowLateSubmission: true,
    });

    assert.equal(created.id, "55");
    assert.equal(created.title, "Kafka Distributed Sagas");
    assert.equal(created.maximumMarks, 50);

    const list = await repo.findAssignments("501", "10", "1");
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, "55");
  });

  it("handles student assignment submissions and faculty evaluation", async () => {
    const mockSubmission = {
      AssignmentSubmissionId: 77,
      AssignmentId: 55,
      StudentUserId: 301,
      SubmissionVersion: 1,
      SubmissionType: "github",
      GitHubUrl: "https://github.com/student/kafka-saga",
      TextContent: null,
      ObjectKey: null,
      SubmissionStatus: "submitted",
      SubmittedAt: new Date("2026-11-22"),
      MarksAwarded: 48,
      Feedback: "Excellent transactional outbox pattern implementation.",
      EvaluatedAt: new Date("2026-11-22"),
    };

    const pool = createMockPool(() => ({ recordset: [mockSubmission] }));
    const repo = new SqlServerTeacherRepository(pool);

    const submission = await repo.submitAssignment({
      assignmentId: "55",
      studentUserId: "301",
      submissionType: "github",
      githubUrl: "https://github.com/student/kafka-saga",
    });

    assert.equal(submission.id, "77");
    assert.equal(submission.assignmentId, "55");
    assert.equal(submission.status, "submitted");

    // Evaluation
    const evaluated = await repo.evaluateSubmission(
      "77",
      "501",
      48,
      "Excellent transactional outbox pattern implementation.",
    );

    assert.equal(evaluated.marksAwarded, 48);
    assert.equal(evaluated.feedback, "Excellent transactional outbox pattern implementation.");
  });

  it("manages study materials upload, retrieval, and deletion", async () => {
    const mockMaterialRow = {
      LearningMaterialId: 91,
      LessonId: 1,
      MaterialName: "Docker & Kubernetes Architecture",
      MaterialType: "pdf",
      StorageProvider: "azure-blob",
      ObjectKey: "materials/k8s-arch.pdf",
      ExternalUrl: null,
      FileSizeBytes: 1048576,
      MimeType: "application/pdf",
      VersionNumber: 1,
      UploadedByUserId: 501,
      CreatedAt: new Date("2026-11-22"),
    };

    const pool = createMockPool((cmd) => {
      if (cmd.includes("DELETE FROM dbo.NXA_LearningMaterials")) {
        return { recordset: [], rowsAffected: [1] };
      }
      return { recordset: [mockMaterialRow] };
    });
    const repo = new SqlServerTeacherRepository(pool);

    const created = await repo.createMaterial({
      lessonId: "1",
      materialName: "Docker & Kubernetes Architecture",
      materialType: "pdf",
      fileSizeBytes: 1048576,
      mimeType: "application/pdf",
      uploadedByUserId: "501",
    });

    assert.equal(created.id, "91");
    assert.equal(created.materialName, "Docker & Kubernetes Architecture");

    const materials = await repo.findMaterials("1");
    assert.equal(materials.length, 1);
    assert.equal(materials[0]!.materialType, "pdf");

    const deleted = await repo.deleteMaterial("91");
    assert.equal(deleted, true);
  });

  it("manages student doubts and instructor replies", async () => {
    const mockDoubtRow = {
      LessonDoubtId: 44,
      LessonId: 10,
      StudentUserId: 301,
      StudentName: "Aarav Patel",
      DoubtText: "How does max.poll.interval.ms affect consumer rebalance?",
      Status: "open",
      CreatedAt: new Date("2026-11-22"),
      ResolvedAt: null,
      RepliesJson: JSON.stringify([]),
    };

    const pool = createMockPool(() => ({ recordset: [mockDoubtRow] }));
    const repo = new SqlServerTeacherRepository(pool);

    const doubt = await repo.createDoubt({
      lessonId: "10",
      studentUserId: "301",
      doubtText: "How does max.poll.interval.ms affect consumer rebalance?",
    });

    assert.equal(doubt.id, "44");
    assert.equal(doubt.status, "open");

    const replied = await repo.replyDoubt(
      "44",
      "If processing exceeds max.poll.interval.ms, consumer coordinator triggers rebalance.",
    );

    assert.equal(replied.status, "resolved");
  });

  it("records LMS lesson progress correctly", async () => {
    const pool = createMockPool(() => ({
      recordset: [
        {
          LessonProgressId: 1,
          StudentUserId: 301,
          LessonId: 10,
          IsCompleted: true,
          ProgressPercent: 100,
        },
      ],
    }));
    const repo = new SqlServerTeacherRepository(pool);

    const progress = await repo.recordLessonProgress("301", "10", true, 100);

    assert.equal(progress.isCompleted, true);
    assert.equal(progress.progressPercent, 100);
  });

  it("manages online assessments and test attempts", async () => {
    const mockTestRow = {
      TestId: 12,
      CourseId: 1,
      BatchId: 10,
      CreatedByTeacherUserId: 501,
      Title: "Enterprise Spring Boot Assessment",
      Instructions: "50 Multiple choice and coding questions",
      DurationMinutes: 90,
      MaximumMarks: 100,
      PassingMarks: 60,
      StartsAt: new Date("2026-11-22"),
      EndsAt: new Date("2026-11-29"),
      MaxAttempts: 2,
      Status: "active",
      CreatedAt: new Date("2026-11-22"),
    };

    const mockAttemptRow = {
      TestAttemptId: 601,
      TestId: 12,
      StudentUserId: 301,
      StudentName: "Aarav Patel",
      AttemptNumber: 1,
      TotalMarks: 82,
      AttemptStatus: "evaluated",
      StartedAt: new Date("2026-11-22T10:00:00Z"),
      SubmittedAt: new Date("2026-11-22T11:25:00Z"),
      EvaluatedAt: new Date("2026-11-22T11:25:00Z"),
    };

    const pool = createMockPool((cmd) => {
      if (cmd.includes("dbo.NXA_TestAttempts")) {
        return { recordset: [mockAttemptRow] };
      }
      return { recordset: [mockTestRow] };
    });
    const repo = new SqlServerTeacherRepository(pool);

    const test = await repo.createTest({
      courseId: "1",
      batchId: "10",
      createdByTeacherUserId: "501",
      title: "Enterprise Spring Boot Assessment",
      instructions: "50 Multiple choice and coding questions",
      durationMinutes: 90,
      maximumMarks: 100,
      passingMarks: 60,
      startsAt: "2026-11-22T00:00:00Z",
      endsAt: "2026-11-29T23:59:59Z",
      maxAttempts: 2,
    });

    assert.equal(test.id, "12");
    assert.equal(test.title, "Enterprise Spring Boot Assessment");
    assert.equal(test.passingMarks, 60);

    const tests = await repo.findTests("501", "10", "1");
    assert.equal(tests.length, 1);
    assert.equal(tests[0]!.id, "12");

    const attempts = await repo.findTestAttempts("12", "301");
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.id, "601");
    assert.equal(attempts[0]!.totalMarks, 82);
  });
});
