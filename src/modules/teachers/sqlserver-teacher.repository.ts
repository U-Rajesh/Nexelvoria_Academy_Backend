import sql from "mssql";

import type { PaginatedResult, PaginationQuery } from "../../contracts/api.contract";
import type { EntityId } from "../../contracts/identifier.contract";
import type { UserStatus } from "../../contracts/user.contract";
import type { Course } from "../courses/course.types";
import {
  DuplicateRecordError,
  RecordNotFoundError,
} from "../../repositories/repository.errors";
import { getSqlServerPool } from "../../db/sqlserver.pool";
import type { TeacherRepository } from "./teacher.repository";
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
} from "./teacher.types";

interface TeacherRow {
  UserId: number | bigint | string;
  FullName: string;
  Email: string;
  MobileNumber: string;
  AccountStatus: string;
  AvatarUrl: string | null;
  UserCreatedAt: Date | string;
  TeacherProfileId: number | bigint | string | null;
  Specialization: string | null;
  ExperienceYears: number | string | null;
  Qualification: string | null;
  Bio: string | null;
  IsActive: boolean | number | null;
  AssignedCourseIds?: string | null;
  AssignedBatchIds?: string | null;
}

const mapRowToTeacher = (row: TeacherRow): Teacher => {
  const userId = String(row.UserId);
  const rawStatus = (row.AccountStatus ?? "active").toLowerCase();
  const status: UserStatus =
    rawStatus === "suspended" || rawStatus === "deactivated" ? rawStatus : "active";

  const assignedCourseIds = row.AssignedCourseIds
    ? row.AssignedCourseIds.split(",").map((id) => id.trim()).filter(Boolean)
    : [];

  const assignedBatchIds = row.AssignedBatchIds
    ? row.AssignedBatchIds.split(",").map((id) => id.trim()).filter(Boolean)
    : [];

  const teacher: Teacher = {
    id: userId,
    name: row.FullName ?? "",
    email: row.Email ?? "",
    mobile: row.MobileNumber ?? "",
    role: "teacher",
    status,
    createdAt:
      row.UserCreatedAt instanceof Date
        ? row.UserCreatedAt.toISOString()
        : String(row.UserCreatedAt),
    ...(row.AvatarUrl ? { avatarUrl: row.AvatarUrl } : {}),
    specialization: row.Specialization ?? "General",
    experienceYears: row.ExperienceYears ? Number(row.ExperienceYears) : 0,
    bio: row.Bio ?? "",
    qualifications: row.Qualification ?? "",
    assignedCourseIds,
    assignedBatchIds,
    rating: 4.8,
  };

  return teacher;
};

export class SqlServerTeacherRepository implements TeacherRepository {
  constructor(
    private readonly poolOrFactory:
      | sql.ConnectionPool
      | (() => Promise<sql.ConnectionPool>) = getSqlServerPool,
  ) {}

  private async getPool(): Promise<sql.ConnectionPool> {
    return typeof this.poolOrFactory === "function"
      ? await this.poolOrFactory()
      : this.poolOrFactory;
  }

  async findById(id: EntityId): Promise<Teacher | null> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("userId", sql.BigInt, id);

    const result = await req.query<TeacherRow>(`
      SELECT 
        u.UserId,
        u.FullName,
        u.Email,
        u.MobileNumber,
        u.AccountStatus,
        u.AvatarUrl,
        u.CreatedAt AS UserCreatedAt,
        tp.TeacherProfileId,
        tp.Specialization,
        tp.ExperienceYears,
        tp.Qualification,
        tp.Bio,
        tp.IsActive,
        (
          SELECT STRING_AGG(CAST(ta.CourseId AS VARCHAR(30)), ',')
          FROM dbo.NXA_TeacherAllocations ta
          WHERE ta.TeacherUserId = u.UserId AND ta.IsActive = 1
        ) AS AssignedCourseIds,
        (
          SELECT STRING_AGG(CAST(ta.BatchId AS VARCHAR(30)), ',')
          FROM dbo.NXA_TeacherAllocations ta
          WHERE ta.TeacherUserId = u.UserId AND ta.IsActive = 1 AND ta.BatchId IS NOT NULL
        ) AS AssignedBatchIds
      FROM dbo.NXA_Users u
      LEFT JOIN dbo.NXA_TeacherProfiles tp ON tp.UserId = u.UserId
      WHERE u.UserId = @userId
    `);

    if (result.recordset.length === 0 || !result.recordset[0]) {
      return null;
    }

    return mapRowToTeacher(result.recordset[0]);
  }

  async findByEmail(email: string): Promise<Teacher | null> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("email", sql.NVarChar(255), email.trim().toLowerCase());

    const result = await req.query<TeacherRow>(`
      SELECT 
        u.UserId,
        u.FullName,
        u.Email,
        u.MobileNumber,
        u.AccountStatus,
        u.AvatarUrl,
        u.CreatedAt AS UserCreatedAt,
        tp.TeacherProfileId,
        tp.Specialization,
        tp.ExperienceYears,
        tp.Qualification,
        tp.Bio,
        tp.IsActive,
        (
          SELECT STRING_AGG(CAST(ta.CourseId AS VARCHAR(30)), ',')
          FROM dbo.NXA_TeacherAllocations ta
          WHERE ta.TeacherUserId = u.UserId AND ta.IsActive = 1
        ) AS AssignedCourseIds,
        (
          SELECT STRING_AGG(CAST(ta.BatchId AS VARCHAR(30)), ',')
          FROM dbo.NXA_TeacherAllocations ta
          WHERE ta.TeacherUserId = u.UserId AND ta.IsActive = 1 AND ta.BatchId IS NOT NULL
        ) AS AssignedBatchIds
      FROM dbo.NXA_Users u
      LEFT JOIN dbo.NXA_TeacherProfiles tp ON tp.UserId = u.UserId
      WHERE LOWER(u.Email) = @email
    `);

    if (result.recordset.length === 0 || !result.recordset[0]) {
      return null;
    }

    return mapRowToTeacher(result.recordset[0]);
  }

  async existsByEmail(email: string): Promise<boolean> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("email", sql.NVarChar(255), email.trim().toLowerCase());

    const result = await req.query<{ cnt: number }>(`
      SELECT COUNT(1) AS cnt
      FROM dbo.NXA_Users
      WHERE LOWER(Email) = @email
    `);

    return (result.recordset[0]?.cnt ?? 0) > 0;
  }

  async findMany(
    filter: TeacherFilter,
    pagination: PaginationQuery,
  ): Promise<PaginatedResult<Teacher>> {
    const pool = await this.getPool();
    const req = pool.request();
    const conditions: string[] = ["u.Role = 'teacher'"];

    if (filter.status) {
      req.input("status", sql.VarChar(20), filter.status.toUpperCase());
      conditions.push("UPPER(u.AccountStatus) = @status");
    }

    if (filter.specialization) {
      req.input("spec", sql.NVarChar(200), `%${filter.specialization}%`);
      conditions.push("tp.Specialization LIKE @spec");
    }

    if (filter.search && filter.search.trim() !== "") {
      req.input("search", sql.NVarChar(150), `%${filter.search.trim()}%`);
      conditions.push("(u.FullName LIKE @search OR u.Email LIKE @search OR tp.Specialization LIKE @search)");
    }

    const whereClause = conditions.join(" AND ");
    const countResult = await req.query<{ total: number }>(`
      SELECT COUNT(1) AS total
      FROM dbo.NXA_Users u
      LEFT JOIN dbo.NXA_TeacherProfiles tp ON tp.UserId = u.UserId
      WHERE ${whereClause}
    `);
    const total = countResult.recordset[0]?.total ?? 0;

    const page = Math.max(1, pagination.page);
    const pageSize = Math.max(1, pagination.pageSize);
    const offset = (page - 1) * pageSize;

    req.input("offset", sql.Int, offset);
    req.input("limit", sql.Int, pageSize);

    const rowsResult = await req.query<TeacherRow>(`
      SELECT 
        u.UserId,
        u.FullName,
        u.Email,
        u.MobileNumber,
        u.AccountStatus,
        u.AvatarUrl,
        u.CreatedAt AS UserCreatedAt,
        tp.TeacherProfileId,
        tp.Specialization,
        tp.ExperienceYears,
        tp.Qualification,
        tp.Bio,
        tp.IsActive,
        (
          SELECT STRING_AGG(CAST(ta.CourseId AS VARCHAR(30)), ',')
          FROM dbo.NXA_TeacherAllocations ta
          WHERE ta.TeacherUserId = u.UserId AND ta.IsActive = 1
        ) AS AssignedCourseIds,
        (
          SELECT STRING_AGG(CAST(ta.BatchId AS VARCHAR(30)), ',')
          FROM dbo.NXA_TeacherAllocations ta
          WHERE ta.TeacherUserId = u.UserId AND ta.IsActive = 1 AND ta.BatchId IS NOT NULL
        ) AS AssignedBatchIds
      FROM dbo.NXA_Users u
      LEFT JOIN dbo.NXA_TeacherProfiles tp ON tp.UserId = u.UserId
      WHERE ${whereClause}
      ORDER BY u.UserId ASC
      OFFSET @offset ROWS
      FETCH NEXT @limit ROWS ONLY
    `);

    const items = rowsResult.recordset.map(mapRowToTeacher);
    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async create(input: CreateTeacherInput): Promise<Teacher> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("name", sql.NVarChar(200), input.name.trim());
    req.input("email", sql.NVarChar(255), input.email.trim().toLowerCase());
    req.input("mobile", sql.VarChar(20), input.mobile.trim());
    req.input("spec", sql.NVarChar(200), input.specialization ?? "General");
    req.input("exp", sql.Decimal(4, 1), input.experienceYears ?? 0);
    req.input("qual", sql.NVarChar(200), input.qualifications ?? "");
    req.input("bio", sql.NVarChar(sql.MAX), input.bio ?? "");

    try {
      const tx = pool.transaction();
      await tx.begin();
      try {
        const uReq = tx.request();
        uReq.input("name", sql.NVarChar(200), input.name.trim());
        uReq.input("email", sql.NVarChar(255), input.email.trim().toLowerCase());
        uReq.input("mobile", sql.VarChar(20), input.mobile.trim());

        const uRes = await uReq.query<{ UserId: number | bigint }>(`
          INSERT INTO dbo.NXA_Users (FullName, Email, MobileNumber, Role, AccountStatus, CreatedAt)
          OUTPUT inserted.UserId
          VALUES (@name, @email, @mobile, 'teacher', 'active', SYSUTCDATETIME())
        `);
        const userId = uRes.recordset[0]?.UserId;

        const tpReq = tx.request();
        tpReq.input("userId", sql.BigInt, userId);
        tpReq.input("spec", sql.NVarChar(200), input.specialization ?? "General");
        tpReq.input("exp", sql.Decimal(4, 1), input.experienceYears ?? 0);
        tpReq.input("qual", sql.NVarChar(200), input.qualifications ?? "");
        tpReq.input("bio", sql.NVarChar(sql.MAX), input.bio ?? "");

        await tpReq.query(`
          INSERT INTO dbo.NXA_TeacherProfiles (UserId, Specialization, ExperienceYears, Qualification, Bio, IsActive, CreatedAt)
          VALUES (@userId, @spec, @exp, @qual, @bio, 1, SYSUTCDATETIME())
        `);

        await tx.commit();
        const created = await this.findById(String(userId));
        if (!created) throw new Error("Failed to load created teacher");
        return created;
      } catch (err) {
        await tx.rollback();
        throw err;
      }
    } catch (err: unknown) {
      if (err instanceof Error && "number" in err) {
        const sqlNum = (err as { number: number }).number;
        if (sqlNum === 2601 || sqlNum === 2627) {
          throw new DuplicateRecordError("teacher", "email", input.email);
        }
      }
      throw err;
    }
  }

  async update(id: EntityId, input: UpdateTeacherInput): Promise<Teacher> {
    const existing = await this.findById(id);
    if (!existing) throw new RecordNotFoundError("teacher", id);

    const pool = await this.getPool();
    const req = pool.request();
    req.input("userId", sql.BigInt, id);
    req.input("spec", sql.NVarChar(200), input.specialization ?? existing.specialization);
    req.input("specialization", sql.NVarChar(200), input.specialization ?? existing.specialization);
    req.input("exp", sql.Decimal(4, 1), input.experienceYears ?? existing.experienceYears);
    req.input("experienceYears", sql.Decimal(4, 1), input.experienceYears ?? existing.experienceYears);
    req.input("qual", sql.NVarChar(200), input.qualifications ?? existing.qualifications);
    req.input("bio", sql.NVarChar(sql.MAX), input.bio ?? existing.bio);

    await req.query(`
      UPDATE dbo.NXA_TeacherProfiles
      SET Specialization = @spec,
          ExperienceYears = @exp,
          Qualification = @qual,
          Bio = @bio,
          UpdatedAt = SYSUTCDATETIME()
      WHERE UserId = @userId
    `);

    const updated = await this.findById(id);
    if (!updated) throw new RecordNotFoundError("teacher", id);
    return updated;
  }

  async setStatus(id: EntityId, status: UserStatus): Promise<Teacher> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("userId", sql.BigInt, id);
    req.input("status", sql.VarChar(20), status.toUpperCase());

    const result = await req.query(`
      UPDATE dbo.NXA_Users
      SET AccountStatus = @status,
          UpdatedAt = SYSUTCDATETIME()
      WHERE UserId = @userId
    `);

    if (result.rowsAffected[0] === 0) {
      throw new RecordNotFoundError("teacher", id);
    }

    const updated = await this.findById(id);
    if (!updated) throw new RecordNotFoundError("teacher", id);
    return updated;
  }

  async addAllocation(allocation: TeacherAllocation): Promise<Teacher> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("teacherId", sql.BigInt, allocation.teacherId);
    req.input("courseId", sql.BigInt, allocation.courseId);
    req.input("batchId", sql.BigInt, allocation.batchId);

    try {
      await req.query(`
        INSERT INTO dbo.NXA_TeacherAllocations (TeacherUserId, CourseId, BatchId, IsActive, AllocatedAt)
        VALUES (@teacherId, @courseId, @batchId, 1, SYSUTCDATETIME())
      `);
    } catch (err: unknown) {
      if (err instanceof Error && "number" in err) {
        const sqlNum = (err as { number: number }).number;
        if (sqlNum === 2601 || sqlNum === 2627) {
          throw new DuplicateRecordError("teacherAllocation", "batchId", allocation.batchId);
        }
      }
      throw err;
    }

    const updated = await this.findById(allocation.teacherId);
    if (!updated) throw new RecordNotFoundError("teacher", allocation.teacherId);
    return updated;
  }

  async removeAllocation(teacherId: EntityId, batchId: EntityId): Promise<Teacher> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("teacherId", sql.BigInt, teacherId);
    req.input("batchId", sql.BigInt, batchId);

    await req.query(`
      UPDATE dbo.NXA_TeacherAllocations
      SET IsActive = 0
      WHERE TeacherUserId = @teacherId AND BatchId = @batchId
    `);

    const updated = await this.findById(teacherId);
    if (!updated) throw new RecordNotFoundError("teacher", teacherId);
    return updated;
  }

  async findAllocations(teacherId: EntityId): Promise<TeacherAllocation[]> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("teacherId", sql.BigInt, teacherId);

    const result = await req.query<{ CourseId: number | bigint; BatchId: number | bigint }>(`
      SELECT CourseId, BatchId
      FROM dbo.NXA_TeacherAllocations
      WHERE TeacherUserId = @teacherId AND IsActive = 1
    `);

    return result.recordset.map((r) => ({
      teacherId,
      courseId: String(r.CourseId),
      batchId: String(r.BatchId),
    }));
  }

  async isAllocatedToBatch(teacherId: EntityId, batchId: EntityId): Promise<boolean> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("teacherId", sql.BigInt, teacherId);
    req.input("batchId", sql.BigInt, batchId);

    const result = await req.query<{ cnt: number }>(`
      SELECT COUNT(1) AS cnt
      FROM dbo.NXA_TeacherAllocations
      WHERE TeacherUserId = @teacherId AND BatchId = @batchId AND IsActive = 1
    `);

    return (result.recordset[0]?.cnt ?? 0) > 0;
  }

  async findByBatch(batchId: EntityId): Promise<Teacher[]> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("batchId", sql.BigInt, batchId);

    const result = await req.query<{ TeacherUserId: number | bigint }>(`
      SELECT TeacherUserId
      FROM dbo.NXA_TeacherAllocations
      WHERE BatchId = @batchId AND IsActive = 1
    `);

    const teachers: Teacher[] = [];
    for (const r of result.recordset) {
      const t = await this.findById(String(r.TeacherUserId));
      if (t) teachers.push(t);
    }
    return teachers;
  }

  // --- Extended Batch 3 Learning Management & Operations ------------------

  async findAssignedCourses(teacherId: EntityId): Promise<Course[]> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("teacherId", sql.BigInt, teacherId);

    const result = await req.query<{
      CourseId: number | bigint;
      CourseCode: string;
      CourseName: string;
      CourseLevel: string | null;
      ShortDescription: string | null;
      Description: string | null;
      ListPrice: number | string;
      DurationValue: number | null;
      Status: string;
    }>(`
      SELECT DISTINCT
        c.CourseId,
        c.CourseCode,
        c.CourseName,
        c.CourseLevel,
        c.ShortDescription,
        c.Description,
        c.ListPrice,
        c.DurationValue,
        c.Status
      FROM dbo.NXA_Courses c
      INNER JOIN dbo.NXA_TeacherAllocations ta ON ta.CourseId = c.CourseId
      WHERE ta.TeacherUserId = @teacherId AND ta.IsActive = 1 AND c.DeletedAt IS NULL
    `);

    return result.recordset.map((r) => {
      const courseCode = r.CourseCode ?? (r as any).CourseSlug ?? (r as any).CourseName ?? "course";
      const slug = String(courseCode).toLowerCase().replace(/\s+/g, "-");
      const durationWeeks = r.DurationValue ?? 12;
      return {
        id: String(r.CourseId),
        slug,
        courseCode: String(courseCode),
        title: r.CourseName,
        shortDescription: r.ShortDescription ?? "",
        longDescription: r.Description ?? "",
        thumbnailUrl: `/images/courses/${slug}.png`,
        durationWeeks,
        totalHours: durationWeeks * 10,
        feeINR: Math.round(Number(r.ListPrice ?? 0)),
        level: (r.CourseLevel as any) ?? "Beginner",
        category: "Software Development",
        technologies: [],
        modules: [],
        isPublished: r.Status === "PUBLISHED" || r.Status === "ACTIVE",
        status: (r.Status as any) ?? "Published",
        hasPlacementGuarantee: false,
        prerequisites: [],
        learningOutcomes: [],
      };
    });
  }

  async findAssignedBatches(
    teacherId: EntityId,
  ): Promise<Array<{ id: string; courseId: string; batchCode: string; batchName: string; status: string; scheduleDescription?: string }>> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("teacherId", sql.BigInt, teacherId);

    const result = await req.query<{
      BatchId: number | bigint;
      CourseId: number | bigint;
      BatchCode: string;
      BatchName: string;
      Status: string;
      ScheduleDescription: string | null;
    }>(`
      SELECT DISTINCT
        b.BatchId,
        b.CourseId,
        b.BatchCode,
        b.BatchName,
        b.Status,
        b.ScheduleDescription
      FROM dbo.NXA_Batches b
      INNER JOIN dbo.NXA_TeacherAllocations ta ON ta.BatchId = b.BatchId
      WHERE ta.TeacherUserId = @teacherId AND ta.IsActive = 1
    `);

    return result.recordset.map((r) => ({
      id: String(r.BatchId),
      courseId: String(r.CourseId),
      batchCode: r.BatchCode,
      batchName: r.BatchName,
      status: r.Status,
      ...(r.ScheduleDescription ? { scheduleDescription: r.ScheduleDescription } : {}),
    }));
  }

  async findBatchStudents(teacherId: EntityId, batchId: EntityId): Promise<BatchStudentInfo[]> {
    const isAllocated = await this.isAllocatedToBatch(teacherId, batchId);
    if (!isAllocated) return [];

    const pool = await this.getPool();
    const req = pool.request();
    req.input("batchId", sql.BigInt, batchId);

    const result = await req.query<{
      UserId: number | bigint;
      FullName: string;
      Email: string;
      MobileNumber: string;
      BatchId: number | bigint;
      BatchName: string;
      CourseName: string;
    }>(`
      SELECT 
        u.UserId,
        u.FullName,
        u.Email,
        u.MobileNumber,
        b.BatchId,
        b.BatchName,
        c.CourseName
      FROM dbo.NXA_Enrollments e
      INNER JOIN dbo.NXA_Users u ON u.UserId = e.StudentUserId
      INNER JOIN dbo.NXA_Batches b ON b.BatchId = e.BatchId
      INNER JOIN dbo.NXA_Courses c ON c.CourseId = e.CourseId
      WHERE e.BatchId = @batchId AND e.EnrollmentStatus IN ('active', 'completed')
    `);

    return result.recordset.map((r) => ({
      studentId: String(r.UserId),
      studentName: r.FullName,
      email: r.Email,
      mobile: r.MobileNumber,
      batchId: String(r.BatchId),
      batchName: r.BatchName,
      courseTitle: r.CourseName,
    }));
  }

  async findAllAuthorizedStudents(teacherId: EntityId): Promise<BatchStudentInfo[]> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("teacherId", sql.BigInt, teacherId);

    const result = await req.query<{
      UserId: number | bigint;
      FullName: string;
      Email: string;
      MobileNumber: string;
      BatchId: number | bigint;
      BatchName: string;
      CourseName: string;
    }>(`
      SELECT DISTINCT
        u.UserId,
        u.FullName,
        u.Email,
        u.MobileNumber,
        b.BatchId,
        b.BatchName,
        c.CourseName
      FROM dbo.NXA_Enrollments e
      INNER JOIN dbo.NXA_TeacherAllocations ta ON ta.BatchId = e.BatchId
      INNER JOIN dbo.NXA_Users u ON u.UserId = e.StudentUserId
      INNER JOIN dbo.NXA_Batches b ON b.BatchId = e.BatchId
      INNER JOIN dbo.NXA_Courses c ON c.CourseId = e.CourseId
      WHERE ta.TeacherUserId = @teacherId AND ta.IsActive = 1
        AND e.EnrollmentStatus IN ('active', 'completed')
    `);

    return result.recordset.map((r) => ({
      studentId: String(r.UserId),
      studentName: r.FullName,
      email: r.Email,
      mobile: r.MobileNumber,
      batchId: String(r.BatchId),
      batchName: r.BatchName,
      courseTitle: r.CourseName,
    }));
  }

  async recordAttendanceSession(
    teacherId: EntityId,
    session: { batchId: string; courseId?: string; sessionTitle: string; startsAt?: string; endsAt?: string },
    records: Array<{ studentUserId: string; status: "present" | "absent" | "late" | "excused"; remarks?: string }>,
  ): Promise<ClassSessionRecord> {
    const pool = await this.getPool();
    const tx = pool.transaction();
    await tx.begin();

    try {
      // 1. Get CourseId from batch if not provided
      let courseId = session.courseId;
      if (!courseId) {
        const bReq = tx.request();
        bReq.input("bId", sql.BigInt, session.batchId);
        const bRes = await bReq.query<{ CourseId: number | bigint }>(
          `SELECT CourseId FROM dbo.NXA_Batches WHERE BatchId = @bId`
        );
        courseId = bRes.recordset[0]?.CourseId ? String(bRes.recordset[0].CourseId) : "1";
      }

      const sReq = tx.request();
      sReq.input("batchId", sql.BigInt, session.batchId);
      sReq.input("courseId", sql.BigInt, courseId);
      sReq.input("teacherId", sql.BigInt, teacherId);
      sReq.input("title", sql.NVarChar(200), session.sessionTitle);
      sReq.input("startsAt", sql.DateTime2, session.startsAt ? new Date(session.startsAt) : new Date());
      sReq.input("endsAt", sql.DateTime2, session.endsAt ? new Date(session.endsAt) : new Date(Date.now() + 3600000));

      const sRes = await sReq.query<{ ClassSessionId: number | bigint }>(`
        INSERT INTO dbo.NXA_ClassSessions (
          BatchId,
          CourseId,
          TeacherUserId,
          SessionTitle,
          StartsAt,
          EndsAt,
          SessionStatus,
          CreatedAt
        )
        OUTPUT inserted.ClassSessionId
        VALUES (
          @batchId,
          @courseId,
          @teacherId,
          @title,
          @startsAt,
          @endsAt,
          'COMPLETED',
          SYSUTCDATETIME()
        )
      `);
      const sessionId = String(sRes.recordset[0]?.ClassSessionId);

      for (const rec of records) {
        const rReq = tx.request();
        rReq.input("sessionId", sql.BigInt, sessionId);
        rReq.input("studentId", sql.BigInt, rec.studentUserId);
        rReq.input("status", sql.VarChar(10), rec.status.toUpperCase());
        rReq.input("markedBy", sql.BigInt, teacherId);
        rReq.input("remarks", sql.NVarChar(500), rec.remarks ?? null);

        await rReq.query(`
          INSERT INTO dbo.NXA_AttendanceRecords (
            ClassSessionId,
            StudentUserId,
            AttendanceStatus,
            MarkedByUserId,
            Remarks,
            MarkedAt
          )
          VALUES (
            @sessionId,
            @studentId,
            @status,
            @markedBy,
            @remarks,
            SYSUTCDATETIME()
          )
        `);
      }

      await tx.commit();

      return {
        id: sessionId,
        batchId: session.batchId,
        courseId,
        teacherUserId: teacherId,
        sessionTitle: session.sessionTitle,
        startsAt: session.startsAt ?? new Date().toISOString(),
        endsAt: session.endsAt ?? new Date().toISOString(),
        status: "COMPLETED",
        createdAt: new Date().toISOString(),
      };
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }

  async findAttendanceHistory(
    teacherId: EntityId,
    batchId?: EntityId,
  ): Promise<Array<{ session: ClassSessionRecord; records: AttendanceItem[] }>> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("teacherId", sql.BigInt, teacherId);

    const bFilter = batchId ? "AND cs.BatchId = @batchId" : "";
    if (batchId) req.input("batchId", sql.BigInt, batchId);

    const result = await req.query<{
      ClassSessionId: number | bigint;
      BatchId: number | bigint;
      CourseId: number | bigint;
      TeacherUserId: number | bigint;
      SessionTitle: string;
      StartsAt: Date;
      EndsAt: Date;
      MeetingUrl: string | null;
      SessionStatus: string;
      CreatedAt: Date;
      AttendanceRecordId: number | bigint | null;
      StudentUserId: number | bigint | null;
      AttendanceStatus: string | null;
      Remarks: string | null;
      MarkedAt: Date | null;
    }>(`
      SELECT 
        cs.ClassSessionId,
        cs.BatchId,
        cs.CourseId,
        cs.TeacherUserId,
        cs.SessionTitle,
        cs.StartsAt,
        cs.EndsAt,
        cs.MeetingUrl,
        cs.SessionStatus,
        cs.CreatedAt,
        ar.AttendanceRecordId,
        ar.StudentUserId,
        ar.AttendanceStatus,
        ar.Remarks,
        ar.MarkedAt
      FROM dbo.NXA_ClassSessions cs
      LEFT JOIN dbo.NXA_AttendanceRecords ar ON ar.ClassSessionId = cs.ClassSessionId
      WHERE cs.TeacherUserId = @teacherId ${bFilter}
      ORDER BY cs.StartsAt DESC
    `);

    const sessionMap = new Map<string, { session: ClassSessionRecord; records: AttendanceItem[] }>();

    for (const r of result.recordset) {
      const sId = String(r.ClassSessionId);
      if (!sessionMap.has(sId)) {
        sessionMap.set(sId, {
          session: {
            id: sId,
            batchId: String(r.BatchId),
            courseId: String(r.CourseId),
            teacherUserId: String(r.TeacherUserId),
            sessionTitle: r.SessionTitle,
            startsAt: r.StartsAt.toISOString(),
            endsAt: r.EndsAt.toISOString(),
            ...(r.MeetingUrl ? { meetingUrl: r.MeetingUrl } : {}),
            status: r.SessionStatus,
            createdAt: r.CreatedAt.toISOString(),
          },
          records: [],
        });
      }

      if (r.AttendanceRecordId) {
        const rawStatus = (r.AttendanceStatus ?? "present").toLowerCase();
        const status: "present" | "absent" | "late" | "excused" =
          rawStatus === "absent" || rawStatus === "late" || rawStatus === "excused"
            ? rawStatus
            : "present";

        sessionMap.get(sId)!.records.push({
          id: String(r.AttendanceRecordId),
          classSessionId: sId,
          studentUserId: String(r.StudentUserId),
          status,
          ...(r.Remarks ? { remarks: r.Remarks } : {}),
          markedAt: r.MarkedAt?.toISOString() ?? new Date().toISOString(),
          markedByUserId: teacherId,
        });
      }
    }

    return Array.from(sessionMap.values());
  }

  async findStudentAttendance(studentUserId: EntityId): Promise<AttendanceItem[]> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("studentId", sql.BigInt, studentUserId);

    const result = await req.query<{
      AttendanceRecordId: number | bigint;
      ClassSessionId: number | bigint;
      StudentUserId: number | bigint;
      AttendanceStatus: string;
      Remarks: string | null;
      MarkedAt: Date;
      MarkedByUserId: number | bigint;
    }>(`
      SELECT *
      FROM dbo.NXA_AttendanceRecords
      WHERE StudentUserId = @studentId
      ORDER BY MarkedAt DESC
    `);

    return result.recordset.map((r) => {
      const rawStatus = (r.AttendanceStatus ?? "present").toLowerCase();
      const status: "present" | "absent" | "late" | "excused" =
        rawStatus === "absent" || rawStatus === "late" || rawStatus === "excused"
          ? rawStatus
          : "present";

      return {
        id: String(r.AttendanceRecordId),
        classSessionId: String(r.ClassSessionId),
        studentUserId: String(r.StudentUserId),
        status,
        ...(r.Remarks ? { remarks: r.Remarks } : {}),
        markedAt: r.MarkedAt.toISOString(),
        markedByUserId: String(r.MarkedByUserId),
      };
    });
  }

  async findAssignments(
    teacherId?: EntityId,
    batchId?: EntityId,
    courseId?: EntityId,
  ): Promise<AssignmentRecord[]> {
    const pool = await this.getPool();
    const req = pool.request();
    const conditions: string[] = ["1=1"];

    if (teacherId) {
      req.input("teacherId", sql.BigInt, teacherId);
      conditions.push("CreatedByTeacherUserId = @teacherId");
    }
    if (batchId) {
      req.input("batchId", sql.BigInt, batchId);
      conditions.push("BatchId = @batchId");
    }
    if (courseId) {
      req.input("courseId", sql.BigInt, courseId);
      conditions.push("CourseId = @courseId");
    }

    const result = await req.query<{
      AssignmentId: number | bigint;
      CourseId: number | bigint;
      BatchId: number | bigint | null;
      LessonId: number | bigint | null;
      Title: string;
      Instructions: string | null;
      MaximumMarks: number;
      DueAt: Date | null;
      AllowLateSubmission: boolean;
      Status: string;
      CreatedByTeacherUserId: number | bigint;
      CreatedAt: Date;
    }>(`
      SELECT *
      FROM dbo.NXA_Assignments
      WHERE ${conditions.join(" AND ")}
      ORDER BY CreatedAt DESC
    `);

    return result.recordset.map((r) => ({
      id: String(r.AssignmentId),
      courseId: String(r.CourseId),
      ...(r.BatchId ? { batchId: String(r.BatchId) } : {}),
      ...(r.LessonId ? { lessonId: String(r.LessonId) } : {}),
      title: r.Title,
      ...(r.Instructions ? { instructions: r.Instructions } : {}),
      maximumMarks: Number(r.MaximumMarks),
      ...(r.DueAt ? { dueAt: r.DueAt.toISOString() } : {}),
      allowLateSubmission: Boolean(r.AllowLateSubmission),
      status: r.Status,
      createdByTeacherUserId: String(r.CreatedByTeacherUserId),
      createdAt: r.CreatedAt.toISOString(),
    }));
  }

  async createAssignment(
    teacherId: EntityId,
    assignment: Partial<AssignmentRecord>,
  ): Promise<AssignmentRecord> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("courseId", sql.BigInt, assignment.courseId ?? "1");
    req.input("batchId", sql.BigInt, assignment.batchId ?? null);
    req.input("lessonId", sql.BigInt, assignment.lessonId ?? null);
    req.input("title", sql.NVarChar(200), assignment.title ?? "Assignment");
    req.input("instructions", sql.NVarChar(sql.MAX), assignment.instructions ?? null);
    req.input("marks", sql.Decimal(6, 2), assignment.maximumMarks ?? 100);
    req.input("dueAt", sql.DateTime2, assignment.dueAt ? new Date(assignment.dueAt) : null);
    req.input("late", sql.Bit, assignment.allowLateSubmission ? 1 : 0);
    req.input("teacherId", sql.BigInt, teacherId);

    const result = await req.query<{ AssignmentId: number | bigint }>(`
      INSERT INTO dbo.NXA_Assignments (
        CourseId,
        BatchId,
        LessonId,
        Title,
        Instructions,
        MaximumMarks,
        DueAt,
        AllowLateSubmission,
        Status,
        CreatedByTeacherUserId,
        CreatedAt
      )
      OUTPUT inserted.AssignmentId
      VALUES (
        @courseId,
        @batchId,
        @lessonId,
        @title,
        @instructions,
        @marks,
        @dueAt,
        @late,
        'PUBLISHED',
        @teacherId,
        SYSUTCDATETIME()
      )
    `);

    const id = String(result.recordset[0]?.AssignmentId);
    return {
      id,
      courseId: assignment.courseId ?? "1",
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
  }

  async submitAssignment(
    submission: Partial<AssignmentSubmissionRecord>,
  ): Promise<AssignmentSubmissionRecord> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("assignmentId", sql.BigInt, submission.assignmentId);
    req.input("studentId", sql.BigInt, submission.studentUserId);
    req.input("type", sql.VarChar(20), submission.submissionType ?? "github");
    req.input("githubUrl", sql.NVarChar(500), submission.githubUrl ?? null);
    req.input("text", sql.NVarChar(sql.MAX), submission.textContent ?? null);
    req.input("key", sql.NVarChar(700), submission.objectKey ?? null);

    const result = await req.query<{ AssignmentSubmissionId: number | bigint }>(`
      INSERT INTO dbo.NXA_AssignmentSubmissions (
        AssignmentId,
        StudentUserId,
        SubmissionVersion,
        SubmissionType,
        GitHubUrl,
        TextContent,
        ObjectKey,
        SubmissionStatus,
        SubmittedAt
      )
      OUTPUT inserted.AssignmentSubmissionId
      VALUES (
        @assignmentId,
        @studentId,
        1,
        @type,
        @githubUrl,
        @text,
        @key,
        'SUBMITTED',
        SYSUTCDATETIME()
      )
    `);

    const id = String(result.recordset[0]?.AssignmentSubmissionId);
    return {
      id,
      assignmentId: submission.assignmentId!,
      studentUserId: submission.studentUserId!,
      submissionType: submission.submissionType ?? "github",
      ...(submission.githubUrl ? { githubUrl: submission.githubUrl } : {}),
      ...(submission.textContent ? { textContent: submission.textContent } : {}),
      ...(submission.objectKey ? { objectKey: submission.objectKey } : {}),
      status: "submitted",
      submittedAt: new Date().toISOString(),
    };
  }

  async evaluateSubmission(
    submissionId: EntityId,
    evaluatorUserId: EntityId,
    marks: number,
    feedback?: string,
  ): Promise<AssignmentSubmissionRecord> {
    const pool = await this.getPool();
    const tx = pool.transaction();
    await tx.begin();

    try {
      const eReq = tx.request();
      eReq.input("subId", sql.BigInt, submissionId);
      eReq.input("evaluatorId", sql.BigInt, evaluatorUserId);
      eReq.input("marks", sql.Decimal(6, 2), marks);
      eReq.input("feedback", sql.NVarChar(sql.MAX), feedback ?? null);

      await eReq.query(`
        INSERT INTO dbo.NXA_EvaluationRecords (
          AssessmentType,
          AssignmentSubmissionId,
          EvaluatedByUserId,
          MarksAwarded,
          Feedback,
          EvaluationVersion,
          EvaluatedAt
        )
        VALUES (
          'assignment',
          @subId,
          @evaluatorId,
          @marks,
          @feedback,
          1,
          SYSUTCDATETIME()
        );

        UPDATE dbo.NXA_AssignmentSubmissions
        SET SubmissionStatus = 'EVALUATED'
        WHERE AssignmentSubmissionId = @subId;
      `);

      await tx.commit();

      return {
        id: submissionId,
        assignmentId: "1",
        studentUserId: "1",
        submissionType: "github",
        status: "evaluated",
        submittedAt: new Date().toISOString(),
        marksAwarded: marks,
        ...(feedback ? { feedback } : {}),
        evaluatedAt: new Date().toISOString(),
      };
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }

  async findMaterials(lessonId: EntityId): Promise<LearningMaterialRecord[]> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("lessonId", sql.BigInt, lessonId);

    const result = await req.query<{
      LearningMaterialId: number | bigint;
      LessonId: number | bigint;
      MaterialName: string;
      MaterialType: string;
      ExternalUrl: string | null;
      FileSizeBytes: number | bigint | null;
      MimeType: string | null;
      UploadedByUserId: number | bigint | null;
      CreatedAt: Date;
    }>(`
      SELECT *
      FROM dbo.NXA_LearningMaterials
      WHERE LessonId = @lessonId
      ORDER BY CreatedAt DESC
    `);

    return result.recordset.map((r) => ({
      id: String(r.LearningMaterialId),
      lessonId: String(r.LessonId),
      materialName: r.MaterialName,
      materialType: r.MaterialType,
      ...(r.ExternalUrl ? { externalUrl: r.ExternalUrl } : {}),
      ...(r.FileSizeBytes ? { fileSizeBytes: Number(r.FileSizeBytes) } : {}),
      ...(r.MimeType ? { mimeType: r.MimeType } : {}),
      ...(r.UploadedByUserId ? { uploadedByUserId: String(r.UploadedByUserId) } : {}),
      createdAt: r.CreatedAt.toISOString(),
    }));
  }

  async createMaterial(
    material: Partial<LearningMaterialRecord>,
  ): Promise<LearningMaterialRecord> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("lessonId", sql.BigInt, material.lessonId);
    req.input("name", sql.NVarChar(200), material.materialName ?? "Material");
    req.input("type", sql.VarChar(30), material.materialType ?? "pdf");
    req.input("url", sql.NVarChar(1000), material.externalUrl ?? null);
    req.input("size", sql.BigInt, material.fileSizeBytes ?? null);
    req.input("mime", sql.VarChar(150), material.mimeType ?? null);
    req.input("uploadedBy", sql.BigInt, material.uploadedByUserId ?? null);

    const result = await req.query<{ LearningMaterialId: number | bigint }>(`
      INSERT INTO dbo.NXA_LearningMaterials (
        LessonId,
        MaterialName,
        MaterialType,
        StorageProvider,
        ExternalUrl,
        FileSizeBytes,
        MimeType,
        VersionNumber,
        UploadedByUserId,
        CreatedAt
      )
      OUTPUT inserted.LearningMaterialId
      VALUES (
        @lessonId,
        @name,
        @type,
        's3',
        @url,
        @size,
        @mime,
        1,
        @uploadedBy,
        SYSUTCDATETIME()
      )
    `);

    const id = String(result.recordset[0]?.LearningMaterialId);
    return {
      id,
      lessonId: material.lessonId!,
      materialName: material.materialName ?? "Material",
      materialType: material.materialType ?? "pdf",
      ...(material.externalUrl ? { externalUrl: material.externalUrl } : {}),
      ...(material.fileSizeBytes ? { fileSizeBytes: material.fileSizeBytes } : {}),
      ...(material.mimeType ? { mimeType: material.mimeType } : {}),
      ...(material.uploadedByUserId ? { uploadedByUserId: material.uploadedByUserId } : {}),
      createdAt: new Date().toISOString(),
    };
  }

  async deleteMaterial(materialId: EntityId): Promise<boolean> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("id", sql.BigInt, materialId);

    const result = await req.query(`
      DELETE FROM dbo.NXA_LearningMaterials WHERE LearningMaterialId = @id
    `);

    return (result.rowsAffected[0] ?? 0) > 0;
  }

  async findDoubts(_courseId?: EntityId, lessonId?: EntityId): Promise<LessonDoubtRecord[]> {
    const pool = await this.getPool();
    const req = pool.request();
    const conditions: string[] = ["1=1"];

    if (lessonId) {
      req.input("lessonId", sql.BigInt, lessonId);
      conditions.push("d.LessonId = @lessonId");
    }

    const result = await req.query<{
      LessonDoubtId: number | bigint;
      LessonId: number | bigint;
      StudentUserId: number | bigint;
      DoubtText: string;
      Status: string;
      CreatedAt: Date;
      ResolvedAt: Date | null;
    }>(`
      SELECT d.*
      FROM dbo.NXA_LessonDoubts d
      WHERE ${conditions.join(" AND ")}
      ORDER BY d.CreatedAt DESC
    `);

    return result.recordset.map((r) => ({
      id: String(r.LessonDoubtId),
      lessonId: String(r.LessonId),
      studentUserId: String(r.StudentUserId),
      doubtText: r.DoubtText,
      status: (r.Status ?? "open").toLowerCase(),
      createdAt: r.CreatedAt.toISOString(),
      ...(r.ResolvedAt ? { resolvedAt: r.ResolvedAt.toISOString() } : {}),
    }));
  }

  async createDoubt(doubt: Partial<LessonDoubtRecord>): Promise<LessonDoubtRecord> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("lessonId", sql.BigInt, doubt.lessonId);
    req.input("studentId", sql.BigInt, doubt.studentUserId);
    req.input("text", sql.NVarChar(sql.MAX), doubt.doubtText);

    const result = await req.query<{ LessonDoubtId: number | bigint }>(`
      INSERT INTO dbo.NXA_LessonDoubts (LessonId, StudentUserId, DoubtText, Status, CreatedAt)
      OUTPUT inserted.LessonDoubtId
      VALUES (@lessonId, @studentId, @text, 'OPEN', SYSUTCDATETIME())
    `);

    const id = String(result.recordset[0]?.LessonDoubtId);
    return {
      id,
      lessonId: doubt.lessonId!,
      studentUserId: doubt.studentUserId!,
      doubtText: doubt.doubtText!,
      status: "open",
      createdAt: new Date().toISOString(),
    };
  }

  async replyDoubt(doubtId: EntityId, replyText: string): Promise<LessonDoubtRecord> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("id", sql.BigInt, doubtId);

    await req.query(`
      UPDATE dbo.NXA_LessonDoubts
      SET Status = 'RESOLVED', ResolvedAt = SYSUTCDATETIME()
      WHERE LessonDoubtId = @id
    `);

    return {
      id: doubtId,
      lessonId: "1",
      studentUserId: "1",
      doubtText: "Question",
      replyText,
      status: "resolved",
      createdAt: new Date().toISOString(),
      resolvedAt: new Date().toISOString(),
    };
  }

  async recordLessonProgress(
    studentUserId: EntityId,
    lessonId: EntityId,
    isCompleted: boolean,
    progressPercent: number,
  ): Promise<{ isCompleted: boolean; progressPercent: number }> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("studentId", sql.BigInt, studentUserId);
    req.input("lessonId", sql.BigInt, lessonId);
    req.input("completed", sql.Bit, isCompleted ? 1 : 0);
    req.input("pct", sql.Decimal(5, 2), progressPercent);

    await req.query(`
      MERGE dbo.NXA_LessonProgress AS target
      USING (SELECT @studentId AS StudentUserId, @lessonId AS LessonId) AS src
      ON (target.StudentUserId = src.StudentUserId AND target.LessonId = src.LessonId)
      WHEN MATCHED THEN
        UPDATE SET 
          IsCompleted = @completed,
          ProgressPercent = @pct,
          LastAccessedAt = SYSUTCDATETIME(),
          CompletedAt = CASE WHEN @completed = 1 THEN SYSUTCDATETIME() ELSE target.CompletedAt END
      WHEN NOT MATCHED THEN
        INSERT (StudentUserId, LessonId, IsCompleted, ProgressPercent, FirstAccessedAt, LastAccessedAt, CompletedAt)
        VALUES (src.StudentUserId, src.LessonId, @completed, @pct, SYSUTCDATETIME(), SYSUTCDATETIME(), CASE WHEN @completed = 1 THEN SYSUTCDATETIME() ELSE NULL END);
    `);

    return { isCompleted, progressPercent };
  }

  async findTests(
    teacherId?: EntityId,
    batchId?: EntityId,
    courseId?: EntityId,
  ): Promise<OnlineTestRecord[]> {
    const pool = await this.getPool();
    const req = pool.request();
    const conditions: string[] = ["1=1"];

    if (teacherId) {
      req.input("teacherId", sql.BigInt, teacherId);
      conditions.push("CreatedByTeacherUserId = @teacherId");
    }
    if (batchId) {
      req.input("batchId", sql.BigInt, batchId);
      conditions.push("BatchId = @batchId");
    }
    if (courseId) {
      req.input("courseId", sql.BigInt, courseId);
      conditions.push("CourseId = @courseId");
    }

    const result = await req.query<{
      TestId: number | bigint;
      CourseId: number | bigint;
      BatchId: number | bigint | null;
      CreatedByTeacherUserId: number | bigint;
      Title: string;
      Instructions: string | null;
      DurationMinutes: number;
      MaximumMarks: number;
      PassingMarks: number | null;
      StartsAt: Date | null;
      EndsAt: Date | null;
      MaxAttempts: number;
      Status: string;
      CreatedAt: Date;
    }>(`
      SELECT *
      FROM dbo.NXA_Tests
      WHERE ${conditions.join(" AND ")}
      ORDER BY CreatedAt DESC
    `);

    return result.recordset.map((r) => ({
      id: String(r.TestId),
      courseId: String(r.CourseId),
      ...(r.BatchId ? { batchId: String(r.BatchId) } : {}),
      title: r.Title,
      ...(r.Instructions ? { instructions: r.Instructions } : {}),
      durationMinutes: r.DurationMinutes,
      maximumMarks: Number(r.MaximumMarks),
      ...(r.PassingMarks ? { passingMarks: Number(r.PassingMarks) } : {}),
      ...(r.StartsAt ? { startsAt: r.StartsAt.toISOString() } : {}),
      ...(r.EndsAt ? { endsAt: r.EndsAt.toISOString() } : {}),
      maxAttempts: r.MaxAttempts,
      status: r.Status,
      createdByTeacherUserId: String(r.CreatedByTeacherUserId),
      createdAt: r.CreatedAt.toISOString(),
    }));
  }

  async createTest(test: Partial<OnlineTestRecord>): Promise<OnlineTestRecord> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("courseId", sql.BigInt, test.courseId ?? "1");
    req.input("batchId", sql.BigInt, test.batchId ?? null);
    req.input("teacherId", sql.BigInt, test.createdByTeacherUserId ?? "1");
    req.input("title", sql.NVarChar(200), test.title ?? "Test");
    req.input("instructions", sql.NVarChar(sql.MAX), test.instructions ?? null);
    req.input("dur", sql.Int, test.durationMinutes ?? 60);
    req.input("marks", sql.Decimal(6, 2), test.maximumMarks ?? 100);
    req.input("pass", sql.Decimal(6, 2), test.passingMarks ?? null);
    req.input("starts", sql.DateTime2, test.startsAt ? new Date(test.startsAt) : null);
    req.input("ends", sql.DateTime2, test.endsAt ? new Date(test.endsAt) : null);
    req.input("maxAtt", sql.Int, test.maxAttempts ?? 1);

    const result = await req.query<{ TestId: number | bigint }>(`
      INSERT INTO dbo.NXA_Tests (
        CourseId,
        BatchId,
        CreatedByTeacherUserId,
        Title,
        Instructions,
        DurationMinutes,
        MaximumMarks,
        PassingMarks,
        StartsAt,
        EndsAt,
        MaxAttempts,
        Status,
        CreatedAt
      )
      OUTPUT inserted.TestId
      VALUES (
        @courseId,
        @batchId,
        @teacherId,
        @title,
        @instructions,
        @dur,
        @marks,
        @pass,
        @starts,
        @ends,
        @maxAtt,
        'PUBLISHED',
        SYSUTCDATETIME()
      )
    `);

    const id = String(result.recordset[0]?.TestId);
    return {
      id,
      courseId: test.courseId ?? "1",
      ...(test.batchId ? { batchId: test.batchId } : {}),
      title: test.title ?? "Test",
      ...(test.instructions ? { instructions: test.instructions } : {}),
      durationMinutes: test.durationMinutes ?? 60,
      maximumMarks: test.maximumMarks ?? 100,
      ...(test.passingMarks ? { passingMarks: test.passingMarks } : {}),
      ...(test.startsAt ? { startsAt: test.startsAt } : {}),
      ...(test.endsAt ? { endsAt: test.endsAt } : {}),
      maxAttempts: test.maxAttempts ?? 1,
      status: "PUBLISHED",
      createdByTeacherUserId: test.createdByTeacherUserId ?? "1",
      createdAt: new Date().toISOString(),
    };
  }

  async findTestAttempts(testId?: EntityId, studentUserId?: EntityId): Promise<TestAttemptRecord[]> {
    const pool = await this.getPool();
    const req = pool.request();
    const conditions: string[] = ["1=1"];

    if (testId) {
      req.input("testId", sql.BigInt, testId);
      conditions.push("TestId = @testId");
    }
    if (studentUserId) {
      req.input("studentId", sql.BigInt, studentUserId);
      conditions.push("StudentUserId = @studentId");
    }

    const result = await req.query<{
      TestAttemptId: number | bigint;
      TestId: number | bigint;
      StudentUserId: number | bigint;
      AttemptNumber: number;
      TotalMarks: number | null;
      AttemptStatus: string;
      StartedAt: Date;
      SubmittedAt: Date | null;
      EvaluatedAt: Date | null;
    }>(`
      SELECT *
      FROM dbo.NXA_TestAttempts
      WHERE ${conditions.join(" AND ")}
      ORDER BY StartedAt DESC
    `);

    return result.recordset.map((r) => ({
      id: String(r.TestAttemptId),
      testId: String(r.TestId),
      studentUserId: String(r.StudentUserId),
      attemptNumber: r.AttemptNumber,
      ...(r.TotalMarks !== null ? { totalMarks: Number(r.TotalMarks) } : {}),
      status: r.AttemptStatus,
      startedAt: r.StartedAt.toISOString(),
      ...(r.SubmittedAt ? { submittedAt: r.SubmittedAt.toISOString() } : {}),
      ...(r.EvaluatedAt ? { evaluatedAt: r.EvaluatedAt.toISOString() } : {}),
    }));
  }
}
