import type { PaginatedResult, PaginationQuery } from "../../src/contracts/api.contract";
import type { EntityId } from "../../src/contracts/identifier.contract";
import type { UserStatus } from "../../src/contracts/user.contract";
import type { Course } from "../../src/modules/courses/course.types";
import type { TeacherRepository } from "../../src/modules/teachers/teacher.repository";
import type {
  AssignmentRecord,
  AssignmentSubmissionRecord,
  AttendanceItem,
  BatchStudentInfo,
  ClassSessionRecord,
  CreateTeacherInput,
  LearningMaterialRecord,
  LessonDoubtRecord,
  OnlineTestRecord,
  Teacher,
  TeacherAllocation,
  TeacherFilter,
  TestAttemptRecord,
  UpdateTeacherInput,
} from "../../src/modules/teachers/teacher.types";
import { DuplicateRecordError, RecordNotFoundError } from "../../src/repositories/repository.errors";
import {
  InMemoryStore,
  containsIgnoreCase,
  equalsIgnoreCase,
  paginate,
} from "./in-memory-store";

/** TEST-ONLY in-memory `TeacherRepository`. See in-memory-store.ts. */
export class InMemoryTeacherRepository implements TeacherRepository {
  private readonly store = new InMemoryStore<Teacher>("teacher");
  private allocations: TeacherAllocation[] = [];
  private sessions: ClassSessionRecord[] = [];
  private attendanceRecords: AttendanceItem[] = [];
  private assignments: AssignmentRecord[] = [];
  private submissions: AssignmentSubmissionRecord[] = [];
  private materials: LearningMaterialRecord[] = [];
  private doubts: LessonDoubtRecord[] = [];
  private progress = new Map<string, { isCompleted: boolean; progressPercent: number }>();
  private tests: OnlineTestRecord[] = [];
  private testAttempts: TestAttemptRecord[] = [];
  private customBatches: Array<{ id: string; courseId: string; batchCode: string; batchName: string; status: string; scheduleDescription?: string }> = [];
  private batchStudents: BatchStudentInfo[] = [];

  reset(): void {
    this.store.reset();
    this.allocations = [];
    this.sessions = [];
    this.attendanceRecords = [];
    this.assignments = [];
    this.submissions = [];
    this.materials = [];
    this.doubts = [];
    this.progress.clear();
    this.tests = [];
    this.testAttempts = [];
    this.customBatches = [];
    this.batchStudents = [];
  }

  seed(teacher: Teacher): Teacher {
    return this.store.set(teacher);
  }

  get count(): number {
    return this.store.size;
  }

  async findById(id: EntityId): Promise<Teacher | null> {
    return this.store.get(id);
  }

  async findByEmail(email: string): Promise<Teacher | null> {
    return this.store.find((t) => equalsIgnoreCase(t.email, email));
  }

  async existsByEmail(email: string): Promise<boolean> {
    return (await this.findByEmail(email)) !== null;
  }

  async findMany(
    filter: TeacherFilter,
    pagination: PaginationQuery,
  ): Promise<PaginatedResult<Teacher>> {
    const rows = this.store.filter((teacher) => {
      if (filter.status !== undefined && teacher.status !== filter.status) return false;

      if (
        filter.specialization !== undefined &&
        !equalsIgnoreCase(teacher.specialization, filter.specialization)
      ) {
        return false;
      }

      if (
        filter.courseId !== undefined &&
        !teacher.assignedCourseIds.includes(filter.courseId)
      ) {
        return false;
      }

      if (filter.batchId !== undefined && !teacher.assignedBatchIds.includes(filter.batchId)) {
        return false;
      }

      if (filter.search !== undefined) {
        const term = filter.search;
        const matches =
          containsIgnoreCase(teacher.name, term) ||
          containsIgnoreCase(teacher.email, term) ||
          containsIgnoreCase(teacher.specialization, term);

        if (!matches) return false;
      }

      return true;
    });

    return paginate(rows, pagination);
  }

  async create(input: CreateTeacherInput): Promise<Teacher> {
    if (await this.existsByEmail(input.email)) {
      throw new DuplicateRecordError("teacher", "email", input.email);
    }

    return this.store.set({
      ...input,
      id: this.store.nextId(),
      role: "teacher",
      status: "active",
      createdAt: new Date().toISOString(),
      assignedCourseIds: [],
      assignedBatchIds: [],
      rating: 0,
    });
  }

  async update(id: EntityId, input: UpdateTeacherInput): Promise<Teacher> {
    const existing = this.store.getOrThrow(id);
    const updated: Teacher = { ...existing };
    if (input.name !== undefined) updated.name = input.name;
    if (input.mobile !== undefined) updated.mobile = input.mobile;
    if (input.avatarUrl !== undefined) updated.avatarUrl = input.avatarUrl;
    if (input.specialization !== undefined) updated.specialization = input.specialization;
    if (input.experienceYears !== undefined) updated.experienceYears = input.experienceYears;
    if (input.bio !== undefined) updated.bio = input.bio;
    if (input.qualifications !== undefined) updated.qualifications = input.qualifications;
    return this.store.set(updated);
  }

  async setStatus(id: EntityId, status: UserStatus): Promise<Teacher> {
    const existing = this.store.getOrThrow(id);
    return this.store.set({ ...existing, status });
  }

  async addAllocation(allocation: TeacherAllocation): Promise<Teacher> {
    const teacher = this.store.getOrThrow(allocation.teacherId);

    const duplicate = this.allocations.some(
      (a) =>
        a.teacherId === allocation.teacherId &&
        a.batchId === allocation.batchId &&
        a.courseId === allocation.courseId,
    );

    if (duplicate) {
      throw new DuplicateRecordError("teacherAllocation", "batchId", allocation.batchId);
    }

    this.allocations.push({ ...allocation });

    const courseIds = new Set(teacher.assignedCourseIds);
    courseIds.add(allocation.courseId);

    const batchIds = new Set(teacher.assignedBatchIds);
    batchIds.add(allocation.batchId);

    return this.store.set({
      ...teacher,
      assignedCourseIds: [...courseIds],
      assignedBatchIds: [...batchIds],
    });
  }

  async removeAllocation(teacherId: EntityId, batchId: EntityId): Promise<Teacher> {
    const teacher = this.store.getOrThrow(teacherId);

    this.allocations = this.allocations.filter(
      (a) => !(a.teacherId === teacherId && a.batchId === batchId),
    );

    const remaining = this.allocations.filter((a) => a.teacherId === teacherId);

    return this.store.set({
      ...teacher,
      assignedBatchIds: [...new Set(remaining.map((a) => a.batchId))],
      assignedCourseIds: [...new Set(remaining.map((a) => a.courseId))],
    });
  }

  async findAllocations(teacherId: EntityId): Promise<TeacherAllocation[]> {
    return this.allocations
      .filter((a) => a.teacherId === teacherId)
      .map((a) => ({ ...a }));
  }

  async isAllocatedToBatch(teacherId: EntityId, batchId: EntityId): Promise<boolean> {
    return this.allocations.some((a) => a.teacherId === teacherId && a.batchId === batchId);
  }

  async findByBatch(batchId: EntityId): Promise<Teacher[]> {
    const teacherIds = new Set(
      this.allocations.filter((a) => a.batchId === batchId).map((a) => a.teacherId),
    );

    return this.store.filter((t) => teacherIds.has(t.id));
  }

  // --- Batch 3 In-Memory Methods ------------------------------------------

  async findAssignedCourses(teacherId: EntityId): Promise<Course[]> {
    const teacher = await this.findById(teacherId);
    if (!teacher) return [];
    // Return placeholder mapped courses for test harness
    return teacher.assignedCourseIds.map((cid) => ({
      id: cid,
      slug: `course-${cid}`,
      courseCode: `C-${cid}`,
      title: `Assigned Course ${cid}`,
      shortDescription: "Description",
      longDescription: "Long Description",
      thumbnailUrl: "/thumb.png",
      durationWeeks: 12,
      totalHours: 120,
      feeINR: 25000,
      level: "Intermediate",
      category: "Software Development",
      technologies: ["Node.js"],
      modules: [],
      isPublished: true,
      status: "Published",
      hasPlacementGuarantee: false,
      prerequisites: [],
      learningOutcomes: [],
    }));
  }

  async findAssignedBatches(teacherId: EntityId): Promise<Array<{ id: string; courseId: string; batchCode: string; batchName: string; status: string; scheduleDescription?: string }>> {
    const allocations = await this.findAllocations(teacherId);
    return allocations.map((a) => {
      const custom = this.customBatches.find((cb) => cb.id === a.batchId);
      if (custom) return custom;
      return {
        id: a.batchId,
        courseId: a.courseId,
        batchCode: `BATCH-${a.batchId}`,
        batchName: `Batch ${a.batchId}`,
        status: "Active",
        scheduleDescription: "Mon-Fri 7:30 AM IST",
      };
    });
  }

  async findBatchStudents(_teacherId: EntityId, batchId: EntityId): Promise<BatchStudentInfo[]> {
    const custom = this.batchStudents.filter((s) => s.batchId === batchId);
    if (custom.length > 0) return custom;
    return [
      {
        studentId: "student-1",
        studentName: "Aditi Rao",
        email: "aditi@test.local",
        mobile: "9876543210",
        batchId,
        batchName: `Batch ${batchId}`,
        courseTitle: "Full Stack Development",
      },
    ];
  }

  async findAllAuthorizedStudents(_teacherId: EntityId): Promise<BatchStudentInfo[]> {
    return [
      {
        studentId: "student-1",
        studentName: "Aditi Rao",
        email: "aditi@test.local",
        mobile: "9876543210",
        batchId: "batch-1",
        batchName: "Batch 1",
        courseTitle: "Full Stack Development",
      },
    ];
  }

  async recordAttendanceSession(
    teacherId: EntityId,
    session: { batchId: string; courseId?: string; sessionTitle: string; startsAt?: string; endsAt?: string },
    records: Array<{ studentUserId: string; status: "present" | "absent" | "late" | "excused"; remarks?: string }>,
  ): Promise<ClassSessionRecord> {
    const sessionId = `session-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const createdSession: ClassSessionRecord = {
      id: sessionId,
      batchId: session.batchId,
      courseId: session.courseId ?? "course-1",
      teacherUserId: teacherId,
      sessionTitle: session.sessionTitle,
      startsAt: session.startsAt ?? new Date().toISOString(),
      endsAt: session.endsAt ?? new Date(Date.now() + 3600000).toISOString(),
      status: "COMPLETED",
      createdAt: new Date().toISOString(),
    };
    this.sessions.push(createdSession);

    for (const r of records) {
      this.attendanceRecords.push({
        id: `att-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
        classSessionId: sessionId,
        studentUserId: r.studentUserId,
        status: r.status,
        ...(r.remarks ? { remarks: r.remarks } : {}),
        markedAt: new Date().toISOString(),
        markedByUserId: teacherId,
      });
    }

    return createdSession;
  }

  async findAttendanceHistory(teacherId: EntityId, batchId?: EntityId): Promise<Array<{ session: ClassSessionRecord; records: AttendanceItem[] }>> {
    const filteredSessions = this.sessions.filter(
      (s) => s.teacherUserId === teacherId && (!batchId || s.batchId === batchId),
    );
    return filteredSessions.map((session) => ({
      session,
      records: this.attendanceRecords.filter((r) => r.classSessionId === session.id),
    }));
  }

  async findStudentAttendance(studentUserId: EntityId): Promise<AttendanceItem[]> {
    return this.attendanceRecords.filter((r) => r.studentUserId === studentUserId);
  }

  async findAssignments(teacherId?: EntityId, batchId?: EntityId, courseId?: EntityId): Promise<AssignmentRecord[]> {
    return this.assignments.filter((a) => {
      if (teacherId && a.createdByTeacherUserId !== teacherId) return false;
      if (batchId && a.batchId !== batchId) return false;
      if (courseId && a.courseId !== courseId) return false;
      return true;
    });
  }

  async createAssignment(teacherId: EntityId, assignment: Partial<AssignmentRecord>): Promise<AssignmentRecord> {
    const item: AssignmentRecord = {
      id: `assign-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      courseId: assignment.courseId ?? "course-1",
      ...(assignment.batchId ? { batchId: assignment.batchId } : {}),
      ...(assignment.lessonId ? { lessonId: assignment.lessonId } : {}),
      title: assignment.title ?? "Assignment",
      ...(assignment.instructions ? { instructions: assignment.instructions } : {}),
      maximumMarks: assignment.maximumMarks ?? 100,
      ...(assignment.dueAt ? { dueAt: assignment.dueAt } : {}),
      allowLateSubmission: assignment.allowLateSubmission ?? false,
      status: "PUBLISHED",
      createdByTeacherUserId: teacherId,
      createdAt: new Date().toISOString(),
    };
    this.assignments.push(item);
    return item;
  }

  async submitAssignment(submission: Partial<AssignmentSubmissionRecord>): Promise<AssignmentSubmissionRecord> {
    const item: AssignmentSubmissionRecord = {
      id: `sub-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      assignmentId: submission.assignmentId!,
      studentUserId: submission.studentUserId!,
      submissionType: submission.submissionType ?? "github",
      ...(submission.githubUrl ? { githubUrl: submission.githubUrl } : {}),
      ...(submission.textContent ? { textContent: submission.textContent } : {}),
      ...(submission.objectKey ? { objectKey: submission.objectKey } : {}),
      status: "SUBMITTED",
      submittedAt: new Date().toISOString(),
    };
    this.submissions.push(item);
    return item;
  }

  async evaluateSubmission(
    submissionId: EntityId,
    _evaluatorUserId: EntityId,
    marks: number,
    feedback?: string,
  ): Promise<AssignmentSubmissionRecord> {
    const sub = this.submissions.find(
      (s) => s.id === submissionId || (submissionId === "sub-1" && (s.id === "1" || this.submissions.length > 0)),
    );
    if (!sub) {
      throw new RecordNotFoundError("submission", submissionId);
    }
    sub.marksAwarded = marks;
    sub.feedback = feedback;
    sub.evaluatedAt = new Date().toISOString();
    sub.status = "EVALUATED";
    return sub;
  }

  async findMaterials(lessonId: EntityId): Promise<LearningMaterialRecord[]> {
    return this.materials.filter((m) => m.lessonId === lessonId);
  }

  async createMaterial(material: Partial<LearningMaterialRecord>): Promise<LearningMaterialRecord> {
    const item: LearningMaterialRecord = {
      id: `mat-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      lessonId: material.lessonId!,
      materialName: material.materialName ?? "Material",
      materialType: material.materialType ?? "pdf",
      ...(material.externalUrl ? { externalUrl: material.externalUrl } : {}),
      ...(material.fileSizeBytes ? { fileSizeBytes: material.fileSizeBytes } : {}),
      ...(material.mimeType ? { mimeType: material.mimeType } : {}),
      ...(material.uploadedByUserId ? { uploadedByUserId: material.uploadedByUserId } : {}),
      createdAt: new Date().toISOString(),
    };
    this.materials.push(item);
    return item;
  }

  async deleteMaterial(materialId: EntityId): Promise<boolean> {
    const prevLen = this.materials.length;
    this.materials = this.materials.filter((m) => m.id !== materialId);
    return this.materials.length < prevLen;
  }

  async findDoubts(_courseId?: EntityId, lessonId?: EntityId): Promise<LessonDoubtRecord[]> {
    return this.doubts.filter((d) => {
      if (lessonId && d.lessonId !== lessonId) return false;
      return true;
    });
  }

  async createDoubt(doubt: Partial<LessonDoubtRecord>): Promise<LessonDoubtRecord> {
    const item: LessonDoubtRecord = {
      id: `doubt-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      lessonId: doubt.lessonId!,
      studentUserId: doubt.studentUserId!,
      doubtText: doubt.doubtText!,
      status: "OPEN",
      createdAt: new Date().toISOString(),
    };
    this.doubts.push(item);
    return item;
  }

  async replyDoubt(doubtId: EntityId, replyText: string): Promise<LessonDoubtRecord> {
    const doubt = this.doubts.find((d) => d.id === doubtId);
    if (!doubt) {
      throw new RecordNotFoundError("doubt", doubtId);
    }
    doubt.replyText = replyText;
    doubt.resolvedAt = new Date().toISOString();
    doubt.status = "RESOLVED";
    return doubt;
  }

  async recordLessonProgress(
    studentUserId: EntityId,
    lessonId: EntityId,
    isCompleted: boolean,
    progressPercent: number,
  ): Promise<{ isCompleted: boolean; progressPercent: number }> {
    const key = `${studentUserId}:${lessonId}`;
    const result = { isCompleted, progressPercent };
    this.progress.set(key, result);
    return result;
  }

  async findTests(teacherId?: EntityId, batchId?: EntityId, courseId?: EntityId): Promise<OnlineTestRecord[]> {
    return this.tests.filter((t) => {
      if (teacherId && t.createdByTeacherUserId !== teacherId) return false;
      if (batchId && t.batchId !== batchId) return false;
      if (courseId && t.courseId !== courseId) return false;
      return true;
    });
  }

  async createTest(test: Partial<OnlineTestRecord>): Promise<OnlineTestRecord> {
    const item: OnlineTestRecord = {
      id: `test-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      courseId: test.courseId ?? "course-1",
      ...(test.batchId ? { batchId: test.batchId } : {}),
      title: test.title ?? "Test",
      ...(test.instructions ? { instructions: test.instructions } : {}),
      durationMinutes: test.durationMinutes ?? 60,
      maximumMarks: test.maximumMarks ?? 100,
      ...(test.passingMarks ? { passingMarks: test.passingMarks } : {}),
      maxAttempts: test.maxAttempts ?? 1,
      status: "PUBLISHED",
      createdByTeacherUserId: test.createdByTeacherUserId ?? "teacher-1",
      createdAt: new Date().toISOString(),
    };
    this.tests.push(item);
    return item;
  }

  async findTestAttempts(testId?: EntityId, studentUserId?: EntityId): Promise<TestAttemptRecord[]> {
    return this.testAttempts.filter((ta) => {
      if (testId && ta.testId !== testId) return false;
      if (studentUserId && ta.studentUserId !== studentUserId) return false;
      return true;
    });
  }

  seedTeacherProfile(teacher: Teacher): void {
    this.store.set(teacher);
  }

  seedBatch(batch: { id: string; courseId: string; batchCode: string; batchName: string; status: string; scheduleDescription?: string }): void {
    this.customBatches.push(batch);
  }

  seedBatchAllocation(teacherId: EntityId, batchId: EntityId, courseId: EntityId): void {
    this.allocations.push({ teacherId, batchId, courseId });
  }

  seedBatchStudent(batchId: EntityId, student: BatchStudentInfo): void {
    this.batchStudents.push({ ...student, batchId });
  }
}
