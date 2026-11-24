import sql from "mssql";

import type { PaginatedResult, PaginationQuery } from "../../contracts/api.contract";
import type { EntityId } from "../../contracts/identifier.contract";
import {
  DuplicateRecordError,
  RecordNotFoundError,
} from "../../repositories/repository.errors";
import { getSqlServerPool } from "../../db/sqlserver.pool";
import { writeEnrollmentStatusHistory } from "../../db/history-writers";
import { BatchFullError, type EnrollmentRepository } from "./enrollment.repository";
import {
  type CreateEnrollmentInput,
  type Enrollment,
  type EnrollmentFilter,
  type EnrollmentStatus,
  type EnrollmentType,
} from "./enrollment.types";

interface EnrollmentRow {
  EnrollmentId: number | bigint | string;
  EnrollmentNumber: string;
  StudentUserId: number | bigint | string;
  CourseId: number | bigint | string;
  BatchId: number | bigint | string | null;
  CoursePrice: number | string;
  DiscountAmount: number | string;
  FinalAmount: number | string;
  CurrencyCode: string;
  EnrollmentStatus: string;
  EnrollmentSource: string;
  ActivatedAt: Date | string | null;
  CompletedAt: Date | string | null;
  CreatedAt: Date | string;
  CompletedLessonIds?: string | null;
  BookmarkedLessonIds?: string | null;
}

const mapRowToEnrollment = (row: EnrollmentRow): Enrollment => {
  const rawStatus = (row.EnrollmentStatus ?? "pending_approval").toLowerCase();
  const status: EnrollmentStatus =
    rawStatus === "active" ||
    rawStatus === "approved_unpaid" ||
    rawStatus === "completed" ||
    rawStatus === "cancelled" ||
    rawStatus === "suspended"
      ? (rawStatus as EnrollmentStatus)
      : "pending_approval";

  const rawSource = (row.EnrollmentSource ?? "self").toLowerCase();
  const enrollmentType: EnrollmentType = rawSource === "admin" ? "admin" : "self";

  const completedLessonIds = row.CompletedLessonIds
    ? row.CompletedLessonIds.split(",").map((id) => id.trim()).filter(Boolean)
    : [];

  const bookmarkedLessonIds = row.BookmarkedLessonIds
    ? row.BookmarkedLessonIds.split(",").map((id) => id.trim()).filter(Boolean)
    : [];

  const enrollment: Enrollment = {
    id: String(row.EnrollmentId),
    studentId: String(row.StudentUserId),
    courseId: String(row.CourseId),
    ...(row.BatchId ? { batchId: String(row.BatchId) } : {}),
    enrollmentType,
    status,
    ...(row.FinalAmount !== null && row.FinalAmount !== undefined && Number.isFinite(Number(row.FinalAmount))
      ? { amountDueINR: Number(row.FinalAmount) }
      : {}),
    ...(row.DiscountAmount !== null && row.DiscountAmount !== undefined && Number.isFinite(Number(row.DiscountAmount))
      ? { discountAmountINR: Number(row.DiscountAmount) }
      : {}),
    enrolledAt: row.CreatedAt instanceof Date ? row.CreatedAt.toISOString() : String(row.CreatedAt),
    ...(row.CompletedAt
      ? {
          completedAt:
            row.CompletedAt instanceof Date
              ? row.CompletedAt.toISOString()
              : String(row.CompletedAt),
        }
      : {}),
    progressPercentage: 0,
    completedLessonIds,
    bookmarkedLessonIds,
  };

  return enrollment;
};

const BASE_ENROLLMENT_QUERY = `
  SELECT 
    e.EnrollmentId,
    e.EnrollmentNumber,
    e.StudentUserId,
    e.CourseId,
    e.BatchId,
    e.CoursePrice,
    e.DiscountAmount,
    e.FinalAmount,
    e.CurrencyCode,
    e.EnrollmentStatus,
    e.EnrollmentSource,
    e.ActivatedAt,
    e.CompletedAt,
    e.CreatedAt,
    (
      SELECT STRING_AGG(CAST(lp.LessonId AS VARCHAR(50)), ',')
      FROM dbo.NXA_LessonProgress lp
      WHERE lp.StudentUserId = e.StudentUserId AND lp.IsCompleted = 1
    ) AS CompletedLessonIds,
    (
      SELECT STRING_AGG(CAST(lb.LessonId AS VARCHAR(50)), ',')
      FROM dbo.NXA_LessonBookmarks lb
      WHERE lb.StudentUserId = e.StudentUserId
    ) AS BookmarkedLessonIds
  FROM dbo.NXA_Enrollments e
`;

export class SqlServerEnrollmentRepository implements EnrollmentRepository {
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

  async findById(id: EntityId): Promise<Enrollment | null> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("id", sql.BigInt, id);

    const result = await req.query<EnrollmentRow>(`
      ${BASE_ENROLLMENT_QUERY}
      WHERE e.EnrollmentId = @id
    `);

    if (result.recordset.length === 0 || !result.recordset[0]) {
      return null;
    }

    return mapRowToEnrollment(result.recordset[0]);
  }

  async findByStudentAndCourse(
    studentId: EntityId,
    courseId: EntityId,
  ): Promise<Enrollment | null> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("studentId", sql.BigInt, studentId);
    req.input("courseId", sql.BigInt, courseId);

    const result = await req.query<EnrollmentRow>(`
      ${BASE_ENROLLMENT_QUERY}
      WHERE e.StudentUserId = @studentId AND e.CourseId = @courseId
    `);

    if (result.recordset.length === 0 || !result.recordset[0]) {
      return null;
    }

    return mapRowToEnrollment(result.recordset[0]);
  }

  async findByStudent(studentId: EntityId): Promise<Enrollment[]> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("studentId", sql.BigInt, studentId);

    const result = await req.query<EnrollmentRow>(`
      ${BASE_ENROLLMENT_QUERY}
      WHERE e.StudentUserId = @studentId
      ORDER BY e.CreatedAt DESC
    `);

    return result.recordset.map(mapRowToEnrollment);
  }

  async findMany(
    filter: EnrollmentFilter,
    pagination: PaginationQuery,
  ): Promise<PaginatedResult<Enrollment>> {
    const pool = await this.getPool();
    const req = pool.request();
    const conditions: string[] = ["1 = 1"];

    if (filter.studentId) {
      req.input("studentId", sql.BigInt, filter.studentId);
      conditions.push("e.StudentUserId = @studentId");
    }

    if (filter.courseId) {
      req.input("courseId", sql.BigInt, filter.courseId);
      conditions.push("e.CourseId = @courseId");
    }

    if (filter.batchId) {
      req.input("batchId", sql.BigInt, filter.batchId);
      conditions.push("e.BatchId = @batchId");
    }

    if (filter.status) {
      req.input("status", sql.VarChar(25), filter.status.toUpperCase());
      conditions.push("UPPER(e.EnrollmentStatus) = @status");
    }

    const whereClause = conditions.join(" AND ");

    const countResult = await req.query<{ total: number }>(`
      SELECT COUNT(1) AS total
      FROM dbo.NXA_Enrollments e
      WHERE ${whereClause}
    `);
    const total = countResult.recordset[0]?.total ?? 0;

    const page = Math.max(1, pagination.page);
    const pageSize = Math.max(1, pagination.pageSize);
    const offset = (page - 1) * pageSize;

    req.input("offset", sql.Int, offset);
    req.input("limit", sql.Int, pageSize);

    const rowsResult = await req.query<EnrollmentRow>(`
      ${BASE_ENROLLMENT_QUERY}
      WHERE ${whereClause}
      ORDER BY e.CreatedAt DESC, e.EnrollmentId ASC
      OFFSET @offset ROWS
      FETCH NEXT @limit ROWS ONLY
    `);

    const items = rowsResult.recordset.map(mapRowToEnrollment);
    const totalPages = Math.ceil(total / pageSize);

    return {
      items,
      total,
      page,
      pageSize,
      totalPages,
    };
  }

  async create(input: CreateEnrollmentInput): Promise<Enrollment> {
    const pool = await this.getPool();
    const existing = await this.findByStudentAndCourse(input.studentId, input.courseId);
    if (existing) {
      throw new DuplicateRecordError("enrollment", "courseId", input.courseId);
    }

    const enrollmentNum = `ENR-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    // Fetch course price
    const courseReq = pool.request();
    courseReq.input("cId", sql.BigInt, input.courseId);
    const courseRes = await courseReq.query<{ ListPrice: number | string }>(`
      SELECT ListPrice FROM dbo.NXA_Courses WHERE CourseId = @cId
    `);
    const price = Number(courseRes.recordset[0]?.ListPrice ?? 0);

    const tx = pool.transaction();
    await tx.begin();
    let id: string;
    try {
      if (input.enforceBatchCapacity && input.batchId) {
        // D6: the batch row is locked until commit, so two concurrent
        // enrollments into the same batch are serialized and cannot both take
        // the last place. Counted exactly as the batch's CurrentEnrollments
        // (every status except CANCELLED). NULL capacity = no limit.
        const b = await tx
          .request()
          .input("batchId", sql.BigInt, input.batchId)
          .query<{ Capacity: number | null }>(`SELECT Capacity FROM dbo.NXA_Batches WITH (UPDLOCK, HOLDLOCK) WHERE BatchId = @batchId`);
        const capacity = b.recordset[0]?.Capacity;
        if (capacity !== null && capacity !== undefined) {
          const c = await tx
            .request()
            .input("batchId", sql.BigInt, input.batchId)
            .query<{ cnt: number }>(`
              SELECT COUNT(1) AS cnt FROM dbo.NXA_Enrollments WITH (UPDLOCK, HOLDLOCK)
              WHERE BatchId = @batchId AND UPPER(EnrollmentStatus) <> 'CANCELLED'
            `);
          if (Number(c.recordset[0]?.cnt ?? 0) >= Number(capacity)) throw new BatchFullError(String(input.batchId), Number(capacity));
        }
      }

      const req = tx.request();
      req.input("num", sql.VarChar(40), enrollmentNum);
      req.input("studentId", sql.BigInt, input.studentId);
      req.input("courseId", sql.BigInt, input.courseId);
      req.input("batchId", sql.BigInt, input.batchId ?? null);
      req.input("status", sql.VarChar(25), (input.status ?? "PENDING_APPROVAL").toUpperCase());
      req.input("source", sql.VarChar(20), (input.enrollmentType ?? "SELF").toUpperCase());
      req.input("price", sql.Decimal(12, 2), price);
      req.input("final", sql.Decimal(12, 2), price);

      const result = await req.query<{ EnrollmentId: number | bigint }>(`
        INSERT INTO dbo.NXA_Enrollments (
          EnrollmentNumber,
          StudentUserId,
          CourseId,
          BatchId,
          CoursePrice,
          DiscountAmount,
          FinalAmount,
          CurrencyCode,
          EnrollmentStatus,
          EnrollmentSource,
          CreatedAt
        )
        OUTPUT inserted.EnrollmentId
        VALUES (
          @num,
          @studentId,
          @courseId,
          @batchId,
          @price,
          0,
          @final,
          'INR',
          @status,
          @source,
          SYSUTCDATETIME()
        )
      `);
      id = String(result.recordset[0]?.EnrollmentId);
      await tx.commit();
    } catch (err: unknown) {
      try {
        await tx.rollback();
      } catch {
        // already rolled back
      }
      if (err instanceof Error && "number" in err) {
        const sqlNum = (err as { number: number }).number;
        if (sqlNum === 2601 || sqlNum === 2627) {
          throw new DuplicateRecordError("enrollment", "courseId", input.courseId);
        }
      }
      throw err;
    }

    const created = await this.findById(id);
    if (!created) {
      throw new Error("Failed to reload created enrollment");
    }
    return created;
  }

  async setStatus(
    id: EntityId,
    status: EnrollmentStatus,
    history?: { changedByUserId: string | null; reason?: string | undefined },
  ): Promise<Enrollment> {
    if (!/^\d{1,19}$/.test(String(id))) throw new RecordNotFoundError("enrollment", id);
    const pool = await this.getPool();
    const tx = pool.transaction();
    await tx.begin();
    try {
      const cur = tx.request();
      cur.input("id", sql.BigInt, id);
      const before = await cur.query<{ EnrollmentStatus: string }>(
        `SELECT EnrollmentStatus FROM dbo.NXA_Enrollments WITH (UPDLOCK, HOLDLOCK) WHERE EnrollmentId = @id`,
      );
      const row = before.recordset[0];
      if (!row) throw new RecordNotFoundError("enrollment", id);
      const newStatus = status.toUpperCase();

      // A no-op change writes neither the row nor a history record.
      if ((row.EnrollmentStatus ?? "").toUpperCase() !== newStatus) {
        const req = tx.request();
        req.input("id", sql.BigInt, id);
        req.input("status", sql.VarChar(25), newStatus);
        await req.query(`
          UPDATE dbo.NXA_Enrollments
          SET EnrollmentStatus = @status,
              ActivatedAt = CASE WHEN @status = 'ACTIVE' AND ActivatedAt IS NULL THEN SYSUTCDATETIME() ELSE ActivatedAt END,
              CompletedAt = CASE WHEN @status = 'COMPLETED' AND CompletedAt IS NULL THEN SYSUTCDATETIME() ELSE CompletedAt END,
              UpdatedAt = SYSUTCDATETIME()
          WHERE EnrollmentId = @id
        `);
        await writeEnrollmentStatusHistory(tx.request(), {
          enrollmentId: String(id),
          oldStatus: row.EnrollmentStatus,
          newStatus,
          changedByUserId: history?.changedByUserId ?? null,
          reason: history?.reason,
        });
      }

      await tx.commit();
    } catch (err) {
      try {
        await tx.rollback();
      } catch {
        // the original error is the one worth reporting
      }
      throw err;
    }

    const updated = await this.findById(id);
    if (!updated) {
      throw new RecordNotFoundError("enrollment", id);
    }
    return updated;
  }

  async markLessonCompleted(
    id: EntityId,
    lessonId: EntityId,
    progressPercentage: number,
  ): Promise<Enrollment> {
    const pool = await this.getPool();
    const enrollment = await this.findById(id);
    if (!enrollment) {
      throw new RecordNotFoundError("enrollment", id);
    }

    const req = pool.request();
    req.input("studentId", sql.BigInt, enrollment.studentId);
    req.input("lessonId", sql.BigInt, lessonId);
    req.input("pct", sql.Decimal(5, 2), progressPercentage);

    await req.query(`
      IF EXISTS (SELECT 1 FROM dbo.NXA_LessonProgress WHERE StudentUserId = @studentId AND LessonId = @lessonId)
      BEGIN
        UPDATE dbo.NXA_LessonProgress
        SET IsCompleted = 1, ProgressPercent = @pct, CompletedAt = SYSUTCDATETIME(), LastAccessedAt = SYSUTCDATETIME()
        WHERE StudentUserId = @studentId AND LessonId = @lessonId
      END
      ELSE
      BEGIN
        INSERT INTO dbo.NXA_LessonProgress (StudentUserId, LessonId, IsCompleted, ProgressPercent, FirstAccessedAt, LastAccessedAt, CompletedAt)
        VALUES (@studentId, @lessonId, 1, @pct, SYSUTCDATETIME(), SYSUTCDATETIME(), SYSUTCDATETIME())
      END
    `);

    const updated = await this.findById(id);
    return { ...updated!, progressPercentage };
  }

  async addBookmark(id: EntityId, lessonId: EntityId): Promise<Enrollment> {
    const pool = await this.getPool();
    const enrollment = await this.findById(id);
    if (!enrollment) {
      throw new RecordNotFoundError("enrollment", id);
    }

    const req = pool.request();
    req.input("studentId", sql.BigInt, enrollment.studentId);
    req.input("lessonId", sql.BigInt, lessonId);

    await req.query(`
      IF NOT EXISTS (SELECT 1 FROM dbo.NXA_LessonBookmarks WHERE StudentUserId = @studentId AND LessonId = @lessonId)
      BEGIN
        INSERT INTO dbo.NXA_LessonBookmarks (StudentUserId, LessonId, CreatedAt)
        VALUES (@studentId, @lessonId, SYSUTCDATETIME())
      END
    `);

    return (await this.findById(id))!;
  }

  async removeBookmark(id: EntityId, lessonId: EntityId): Promise<Enrollment> {
    const pool = await this.getPool();
    const enrollment = await this.findById(id);
    if (!enrollment) {
      throw new RecordNotFoundError("enrollment", id);
    }

    const req = pool.request();
    req.input("studentId", sql.BigInt, enrollment.studentId);
    req.input("lessonId", sql.BigInt, lessonId);

    await req.query(`
      DELETE FROM dbo.NXA_LessonBookmarks
      WHERE StudentUserId = @studentId AND LessonId = @lessonId
    `);

    return (await this.findById(id))!;
  }

  async countActiveByBatch(batchId: EntityId): Promise<number> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("batchId", sql.BigInt, batchId);

    const result = await req.query<{ cnt: number }>(`
      SELECT COUNT(1) AS cnt
      FROM dbo.NXA_Enrollments
      WHERE BatchId = @batchId AND (EnrollmentStatus = 'ACTIVE' OR EnrollmentStatus = 'APPROVED_UNPAID')
    `);

    return result.recordset[0]?.cnt ?? 0;
  }
}
