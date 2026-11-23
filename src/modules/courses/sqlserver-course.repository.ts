import sql from "mssql";

import type { PaginatedResult, PaginationQuery } from "../../contracts/api.contract";
import type { EntityId, Slug } from "../../contracts/identifier.contract";
import {
  DuplicateRecordError,
  RecordNotFoundError,
} from "../../repositories/repository.errors";
import { getSqlServerPool } from "../../db/sqlserver.pool";
import type { CourseRepository } from "./course.repository";
import {
  type Chapter,
  type Course,
  type CourseCategory,
  type CourseFilter,
  type CourseLevel,
  type CourseModule,
  type CourseSort,
  type CourseStatus,
  type CreateCourseInput,
  type Lesson,
  type LessonType,
  type UpdateCourseInput,
} from "./course.types";

interface CourseRow {
  CourseId: number | bigint | string;
  CourseCode: string;
  CourseName: string;
  CourseLevel: string | null;
  Description: string | null;
  ShortDescription: string | null;
  DurationValue: number | null;
  DurationUnit: string | null;
  ListPrice: number | string;
  CurrencyCode: string;
  IsPreviewEnabled: boolean | number;
  Status: string;
  CreatedAt: Date | string;
  UpdatedAt: Date | string | null;
}

interface CurriculumRow {
  ModuleId: number | bigint | string;
  CourseId: number | bigint | string;
  ModuleTitle: string;
  ModuleDescription: string | null;
  ModuleSequence: number;
  ChapterId: number | bigint | string | null;
  ChapterTitle: string | null;
  ChapterDescription: string | null;
  ChapterSequence: number | null;
  LessonId: number | bigint | string | null;
  LessonTitle: string | null;
  LessonType: string | null;
  DurationMinutes: number | null;
  ExternalUrl: string | null;
  IsPreview: boolean | number | null;
  IsDownloadAllowed: boolean | number | null;
  LessonSequence: number | null;
}

const mapRowToCourse = (row: CourseRow, modules: CourseModule[] = []): Course => {
  const rawStatus = row.Status ?? "DRAFT";
  const status: CourseStatus =
    rawStatus.toUpperCase() === "PUBLISHED"
      ? "Published"
      : rawStatus.toUpperCase() === "ACTIVE"
        ? "Active"
        : rawStatus.toUpperCase() === "ARCHIVED"
          ? "Archived"
          : rawStatus.toUpperCase() === "INACTIVE"
            ? "Inactive"
            : "Draft";

  const isPublished = status === "Published" || status === "Active";
  const durationVal = row.DurationValue ?? 12;
  const durationWeeks =
    row.DurationUnit?.toUpperCase() === "MONTHS" ? durationVal * 4 : durationVal;

  const rawLevel = (row.CourseLevel ?? "Beginner").toLowerCase();
  const level: CourseLevel =
    rawLevel === "advanced"
      ? "Advanced"
      : rawLevel === "intermediate"
        ? "Intermediate"
        : "Beginner";

  const slug = row.CourseCode.toLowerCase();
  const course: Course = {
    id: String(row.CourseId),
    slug,
    courseCode: row.CourseCode,
    title: row.CourseName,
    shortDescription: row.ShortDescription ?? "",
    longDescription: row.Description ?? "",
    thumbnailUrl: `/images/courses/${slug}.png`,
    durationWeeks,
    totalHours: durationWeeks * 10,
    feeINR: Math.round(Number(row.ListPrice ?? 0)),
    level,
    category: "Software Development" as CourseCategory,
    technologies: [],
    modules,
    isPublished,
    status,
    hasPlacementGuarantee: false,
    prerequisites: [],
    learningOutcomes: [],
  };

  return course;
};

export class SqlServerCourseRepository implements CourseRepository {
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

  private async loadCurriculumForCourse(
    pool: sql.ConnectionPool,
    courseId: string,
  ): Promise<CourseModule[]> {
    const req = pool.request();
    req.input("courseId", sql.BigInt, courseId);

    const rows = await req.query<CurriculumRow>(`
      SELECT 
        m.ModuleId,
        m.CourseId,
        m.ModuleTitle,
        m.ModuleDescription,
        m.SequenceNumber AS ModuleSequence,
        c.ChapterId,
        c.ChapterTitle,
        c.Description AS ChapterDescription,
        c.SequenceNumber AS ChapterSequence,
        l.LessonId,
        l.LessonTitle,
        l.LessonType,
        l.DurationMinutes,
        l.ExternalUrl,
        l.IsPreview,
        l.IsDownloadAllowed,
        l.SequenceNumber AS LessonSequence
      FROM dbo.NXA_CourseModules m
      LEFT JOIN dbo.NXA_Chapters c ON c.ModuleId = m.ModuleId
      LEFT JOIN dbo.NXA_Lessons l ON l.ChapterId = c.ChapterId
      WHERE m.CourseId = @courseId
      ORDER BY m.SequenceNumber ASC, c.SequenceNumber ASC, l.SequenceNumber ASC
    `);

    const moduleMap = new Map<string, CourseModule>();
    const chapterMap = new Map<string, Chapter>();

    for (const r of rows.recordset) {
      const modId = String(r.ModuleId);
      if (!moduleMap.has(modId)) {
        moduleMap.set(modId, {
          id: modId,
          courseId,
          title: r.ModuleTitle,
          description: r.ModuleDescription ?? "",
          order: r.ModuleSequence,
          chapters: [],
        });
      }

      if (r.ChapterId !== null && r.ChapterId !== undefined) {
        const chapId = String(r.ChapterId);
        if (!chapterMap.has(chapId)) {
          const chap: Chapter = {
            id: chapId,
            moduleId: modId,
            title: r.ChapterTitle ?? "",
            ...(r.ChapterDescription ? { description: r.ChapterDescription } : {}),
            order: r.ChapterSequence ?? 0,
            lessons: [],
          };
          chapterMap.set(chapId, chap);
          moduleMap.get(modId)!.chapters.push(chap);
        }

        if (r.LessonId !== null && r.LessonId !== undefined) {
          const rawLessonType = (r.LessonType ?? "reading").toLowerCase();
          const lessonType: LessonType =
            rawLessonType === "video" ||
            rawLessonType === "pdf" ||
            rawLessonType === "assignment" ||
            rawLessonType === "quiz"
              ? (rawLessonType as LessonType)
              : "reading";

          const lesson: Lesson = {
            id: String(r.LessonId),
            chapterId: chapId,
            title: r.LessonTitle ?? "",
            durationMinutes: r.DurationMinutes ?? 10,
            lessonType,
            ...(r.ExternalUrl ? { videoUrl: r.ExternalUrl } : {}),
            isFreePreview: Boolean(r.IsPreview),
            isDownloadRestricted: !Boolean(r.IsDownloadAllowed),
            order: r.LessonSequence ?? 0,
          };
          chapterMap.get(chapId)!.lessons.push(lesson);
        }
      }
    }

    return Array.from(moduleMap.values());
  }

  async findById(id: EntityId): Promise<Course | null> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("id", sql.BigInt, id);

    const result = await req.query<CourseRow>(`
      SELECT *
      FROM dbo.NXA_Courses
      WHERE CourseId = @id AND DeletedAt IS NULL
    `);

    if (result.recordset.length === 0 || !result.recordset[0]) {
      return null;
    }

    const modules = await this.loadCurriculumForCourse(pool, id);
    return mapRowToCourse(result.recordset[0], modules);
  }

  async findBySlug(slug: Slug): Promise<Course | null> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("slug", sql.VarChar(40), slug.trim().toUpperCase());

    // Matches CourseCode (case-insensitive) or CourseId if numeric
    const isNum = /^\d+$/.test(slug.trim());
    const query = isNum
      ? `SELECT * FROM dbo.NXA_Courses WHERE (UPPER(CourseCode) = @slug OR CourseId = ${slug.trim()}) AND DeletedAt IS NULL`
      : `SELECT * FROM dbo.NXA_Courses WHERE UPPER(CourseCode) = @slug AND DeletedAt IS NULL`;

    const result = await req.query<CourseRow>(query);

    if (result.recordset.length === 0 || !result.recordset[0]) {
      return null;
    }

    const row = result.recordset[0];
    const modules = await this.loadCurriculumForCourse(pool, String(row.CourseId));
    return mapRowToCourse(row, modules);
  }

  async existsBySlug(slug: Slug): Promise<boolean> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("slug", sql.VarChar(40), slug.trim().toUpperCase());

    const result = await req.query<{ cnt: number }>(`
      SELECT COUNT(1) AS cnt
      FROM dbo.NXA_Courses
      WHERE UPPER(CourseCode) = @slug AND DeletedAt IS NULL
    `);

    return (result.recordset[0]?.cnt ?? 0) > 0;
  }

  async findMany(
    filter: CourseFilter,
    pagination: PaginationQuery,
    sort?: CourseSort,
  ): Promise<PaginatedResult<Course>> {
    const pool = await this.getPool();
    const req = pool.request();
    const conditions: string[] = ["DeletedAt IS NULL"];

    if (filter.publishedOnly) {
      conditions.push("(Status = 'PUBLISHED' OR Status = 'ACTIVE')");
    } else if (filter.status) {
      req.input("status", sql.VarChar(20), filter.status.toUpperCase());
      conditions.push("UPPER(Status) = @status");
    }

    if (filter.level) {
      req.input("level", sql.VarChar(30), filter.level);
      conditions.push("CourseLevel = @level");
    }

    if (filter.search && filter.search.trim() !== "") {
      req.input("search", sql.NVarChar(150), `%${filter.search.trim()}%`);
      conditions.push("(CourseName LIKE @search OR ShortDescription LIKE @search)");
    }

    const whereClause = conditions.join(" AND ");

    // Sorting
    const sortField = sort?.field ?? "title";
    const sortOrder = (sort?.order ?? "asc").toUpperCase();
    const colMap: Record<string, string> = {
      title: "CourseName",
      feeINR: "ListPrice",
      durationWeeks: "DurationValue",
      totalHours: "DurationValue",
    };
    const col = colMap[sortField] ?? "CourseName";
    const orderClause = `ORDER BY ${col} ${sortOrder === "DESC" ? "DESC" : "ASC"}, CourseId ASC`;

    // Count
    const countResult = await req.query<{ total: number }>(`
      SELECT COUNT(1) AS total
      FROM dbo.NXA_Courses
      WHERE ${whereClause}
    `);
    const total = countResult.recordset[0]?.total ?? 0;

    const page = Math.max(1, pagination.page);
    const pageSize = Math.max(1, pagination.pageSize);
    const offset = (page - 1) * pageSize;

    req.input("offset", sql.Int, offset);
    req.input("limit", sql.Int, pageSize);

    const rowsResult = await req.query<CourseRow>(`
      SELECT *
      FROM dbo.NXA_Courses
      WHERE ${whereClause}
      ${orderClause}
      OFFSET @offset ROWS
      FETCH NEXT @limit ROWS ONLY
    `);

    const items = rowsResult.recordset.map((r) => mapRowToCourse(r, []));
    const totalPages = Math.ceil(total / pageSize);

    return {
      items,
      total,
      page,
      pageSize,
      totalPages,
    };
  }

  async create(input: CreateCourseInput): Promise<Course> {
    const pool = await this.getPool();
    const req = pool.request();
    const code = (input.courseCode ?? input.slug).trim().toUpperCase();
    req.input("code", sql.VarChar(40), code);
    req.input("name", sql.NVarChar(200), input.title.trim());
    req.input("level", sql.VarChar(30), input.level ?? "Beginner");
    req.input("shortDesc", sql.NVarChar(1000), input.shortDescription ?? "");
    req.input("desc", sql.NVarChar(sql.MAX), input.longDescription ?? "");
    req.input("price", sql.Decimal(12, 2), input.feeINR ?? 0);
    req.input("durationVal", sql.Int, input.durationWeeks ?? 12);
    req.input("status", sql.VarChar(20), "DRAFT");

    try {
      const result = await req.query<{ CourseId: number | bigint }>(`
        INSERT INTO dbo.NXA_Courses (
          CourseCode,
          CourseName,
          CourseLevel,
          ShortDescription,
          Description,
          ListPrice,
          DurationValue,
          DurationUnit,
          Status,
          CreatedAt
        )
        OUTPUT inserted.CourseId
        VALUES (
          @code,
          @name,
          @level,
          @shortDesc,
          @desc,
          @price,
          @durationVal,
          'WEEKS',
          @status,
          SYSUTCDATETIME()
        )
      `);

      const id = String(result.recordset[0]?.CourseId);
      const created = await this.findById(id);
      if (!created) {
        throw new Error("Failed to reload created course");
      }
      return created;
    } catch (err: unknown) {
      if (err instanceof Error && "number" in err) {
        const sqlNum = (err as { number: number }).number;
        if (sqlNum === 2601 || sqlNum === 2627) {
          throw new DuplicateRecordError("course", "courseCode", code);
        }
      }
      throw err;
    }
  }

  async update(id: EntityId, input: UpdateCourseInput): Promise<Course> {
    const pool = await this.getPool();
    const existing = await this.findById(id);
    if (!existing) {
      throw new RecordNotFoundError("course", id);
    }

    const req = pool.request();
    req.input("id", sql.BigInt, id);
    req.input("name", sql.NVarChar(200), input.title ?? existing.title);
    req.input("shortDesc", sql.NVarChar(1000), input.shortDescription ?? existing.shortDescription);
    req.input("desc", sql.NVarChar(sql.MAX), input.longDescription ?? existing.longDescription);
    req.input("price", sql.Decimal(12, 2), input.feeINR ?? existing.feeINR);
    req.input("level", sql.VarChar(30), input.level ?? existing.level);

    await req.query(`
      UPDATE dbo.NXA_Courses
      SET CourseName = @name,
          ShortDescription = @shortDesc,
          Description = @desc,
          ListPrice = @price,
          CourseLevel = @level,
          UpdatedAt = SYSUTCDATETIME()
      WHERE CourseId = @id
    `);

    const updated = await this.findById(id);
    if (!updated) {
      throw new RecordNotFoundError("course", id);
    }
    return updated;
  }

  async replaceCurriculum(id: EntityId, modules: CourseModule[]): Promise<Course> {
    const pool = await this.getPool();
    const existing = await this.findById(id);
    if (!existing) {
      throw new RecordNotFoundError("course", id);
    }

    const tx = pool.transaction();
    await tx.begin();

    try {
      // 1. Delete existing lessons, chapters, modules for this course
      const delReq = tx.request();
      delReq.input("courseId", sql.BigInt, id);
      await delReq.query(`
        DELETE l FROM dbo.NXA_Lessons l
        INNER JOIN dbo.NXA_Chapters c ON c.ChapterId = l.ChapterId
        INNER JOIN dbo.NXA_CourseModules m ON m.ModuleId = c.ModuleId
        WHERE m.CourseId = @courseId;

        DELETE c FROM dbo.NXA_Chapters c
        INNER JOIN dbo.NXA_CourseModules m ON m.ModuleId = c.ModuleId
        WHERE m.CourseId = @courseId;

        DELETE FROM dbo.NXA_CourseModules WHERE CourseId = @courseId;
      `);

      // 2. Insert new modules, chapters, lessons
      let modSeq = 1;
      for (const m of modules) {
        const modReq = tx.request();
        modReq.input("courseId", sql.BigInt, id);
        modReq.input("title", sql.NVarChar(200), m.title);
        modReq.input("desc", sql.NVarChar(1000), m.description ?? "");
        modReq.input("seq", sql.Int, modSeq++);

        const modRes = await modReq.query<{ ModuleId: number | bigint }>(`
          INSERT INTO dbo.NXA_CourseModules (CourseId, ModuleTitle, ModuleDescription, SequenceNumber, IsPublished, CreatedAt)
          OUTPUT inserted.ModuleId
          VALUES (@courseId, @title, @desc, @seq, 1, SYSUTCDATETIME())
        `);
        const modId = modRes.recordset[0]?.ModuleId;

        let chapSeq = 1;
        for (const c of m.chapters ?? []) {
          const chapReq = tx.request();
          chapReq.input("moduleId", sql.BigInt, modId);
          chapReq.input("title", sql.NVarChar(200), c.title);
          chapReq.input("desc", sql.NVarChar(1000), c.description ?? "");
          chapReq.input("seq", sql.Int, chapSeq++);

          const chapRes = await chapReq.query<{ ChapterId: number | bigint }>(`
            INSERT INTO dbo.NXA_Chapters (ModuleId, ChapterTitle, Description, SequenceNumber, CreatedAt)
            OUTPUT inserted.ChapterId
            VALUES (@moduleId, @title, @desc, @seq, SYSUTCDATETIME())
          `);
          const chapId = chapRes.recordset[0]?.ChapterId;

          let lesSeq = 1;
          for (const l of c.lessons ?? []) {
            const lesReq = tx.request();
            lesReq.input("chapterId", sql.BigInt, chapId);
            lesReq.input("title", sql.NVarChar(200), l.title);
            lesReq.input("type", sql.VarChar(30), l.lessonType ?? "reading");
            lesReq.input("dur", sql.Int, l.durationMinutes ?? 10);
            lesReq.input("preview", sql.Bit, l.isFreePreview ? 1 : 0);
            lesReq.input("seq", sql.Int, lesSeq++);

            await lesReq.query(`
              INSERT INTO dbo.NXA_Lessons (ChapterId, LessonTitle, LessonType, DurationMinutes, IsPreview, IsDownloadAllowed, IsSequentialUnlock, SequenceNumber, Status, CreatedAt)
              VALUES (@chapterId, @title, @type, @dur, @preview, 0, 0, @seq, 'PUBLISHED', SYSUTCDATETIME())
            `);
          }
        }
      }

      await tx.commit();
      const updated = await this.findById(id);
      if (!updated) {
        throw new RecordNotFoundError("course", id);
      }
      return updated;
    } catch (err) {
      try {
        await tx.rollback();
      } catch {
        // ignore
      }
      throw err;
    }
  }

  async setPublication(
    id: EntityId,
    change: { status: CourseStatus; isPublished: boolean },
  ): Promise<Course> {
    const pool = await this.getPool();
    const req = pool.request();
    req.input("id", sql.BigInt, id);
    req.input("status", sql.VarChar(20), change.status.toUpperCase());
    req.input("preview", sql.Bit, change.isPublished ? 1 : 0);

    const result = await req.query(`
      UPDATE dbo.NXA_Courses
      SET Status = @status,
          IsPreviewEnabled = @preview,
          UpdatedAt = SYSUTCDATETIME()
      WHERE CourseId = @id AND DeletedAt IS NULL
    `);

    if (result.rowsAffected[0] === 0) {
      throw new RecordNotFoundError("course", id);
    }

    const updated = await this.findById(id);
    if (!updated) {
      throw new RecordNotFoundError("course", id);
    }
    return updated;
  }

  async setStatus(id: EntityId, status: CourseStatus): Promise<Course> {
    return this.setPublication(id, {
      status,
      isPublished: status === "Published" || status === "Active",
    });
  }

  async setPublished(id: EntityId, isPublished: boolean): Promise<Course> {
    return this.setPublication(id, {
      status: isPublished ? "Published" : "Draft",
      isPublished,
    });
  }

  async findLessonById(
    courseId: EntityId,
    lessonId: EntityId,
  ): Promise<{ lesson: Lesson } | null> {
    const course = await this.findById(courseId);
    if (!course) return null;
    for (const mod of course.modules) {
      for (const chap of mod.chapters) {
        for (const les of chap.lessons) {
          if (les.id === lessonId) {
            return { lesson: les };
          }
        }
      }
    }
    return null;
  }
}
