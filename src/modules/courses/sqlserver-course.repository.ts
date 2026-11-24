import sql from "mssql";

import type { PaginatedResult, PaginationQuery } from "../../contracts/api.contract";
import type { EntityId, Slug } from "../../contracts/identifier.contract";
import {
  DuplicateRecordError,
  RecordNotFoundError,
  RecordInUseError,
  UnsupportedFieldsError,
} from "../../repositories/repository.errors";
import { getSqlServerPool } from "../../db/sqlserver.pool";
import { writeAuditLog } from "../admin/sqlserver-admin.repository";
import type { CourseAudit, CourseAuditFor, CourseRepository } from "./course.repository";
import {
  PrerequisiteRuleError,
  assertNoCycle,
  assertNotSelf,
  planPrerequisiteChange,
  type PrerequisiteCourse,
} from "./course-prerequisites";
import {
  type Chapter,
  type Course,
  type CourseFilter,
  type CourseLevel,
  type CourseModule,
  type CourseSort,
  type CourseStatus,
  type CreateCourseInput,
  type Lesson,
  type LessonType,
  type UpdateCourseInput,
  UNPERSISTED_COURSE_FIELDS,
} from "./course.types";

/**
 * Writes a course-management audit row on the change's own transaction (SEC
 * audit logs), so the change and its audit commit or roll back together.
 */
const writeCourseAudit = async (tx: sql.Transaction, audit: CourseAudit | undefined, courseId: string): Promise<void> => {
  if (!audit) return;
  await writeAuditLog(tx.request(), { ...audit, moduleCode: "COURSE_MGMT", entityName: "Course", entityId: courseId });
};

/**
 * True when saving `next` would write exactly what is stored: same module,
 * chapter and lesson ids in the same order, and the same value for every
 * field the curriculum save writes. Anything uncertain (an item without an id,
 * a value the read path cannot show) counts as a change, so a real change is
 * never skipped.
 */
const sameCurriculum = (stored: CourseModule[], next: CourseModule[]): boolean => {
  const text = (v: string | null | undefined) => v ?? "";
  const at = (v: string | undefined) => (v ? new Date(v).getTime() : null);
  const sameId = (a: unknown, b: unknown) => a !== undefined && a !== null && a !== "" && String(a) === String(b);
  if (stored.length !== next.length) return false;
  return next.every((m, i) => {
    const sm = stored[i]!;
    if (!sameId(m.id, sm.id) || m.title !== sm.title || text(m.description) !== text(sm.description)) return false;
    const nc = m.chapters ?? [];
    const sc = sm.chapters ?? [];
    if (nc.length !== sc.length) return false;
    return nc.every((c, j) => {
      const so = sc[j]!;
      if (!sameId(c.id, so.id) || c.title !== so.title || text(c.description) !== text(so.description)) return false;
      const nl = c.lessons ?? [];
      const sl = so.lessons ?? [];
      if (nl.length !== sl.length) return false;
      return nl.every((l, k) => {
        const o = sl[k]!;
        return (
          sameId(l.id, o.id) &&
          l.title === o.title &&
          (l.lessonType ?? "reading") === (o.lessonType ?? "reading") &&
          (l.durationMinutes ?? 0) === (o.durationMinutes ?? 0) &&
          (l.videoUrl || null) === (o.videoUrl || null) &&
          (l.studyMaterialText ?? null) === (o.studyMaterialText ?? null) &&
          !!l.isFreePreview === !!o.isFreePreview &&
          (l.isDownloadRestricted === undefined || l.isDownloadRestricted === o.isDownloadRestricted) &&
          !!l.isSequentialUnlock === !!o.isSequentialUnlock &&
          at(l.publishAt) === at(o.publishAt)
        );
      });
    });
  });
};

/** SQL Server error number from an mssql error, if any. */
const sqlErrorNumber = (err: unknown): number | undefined => {
  const e = err as { number?: number; originalError?: { number?: number; info?: { number?: number } } } | null;
  return e?.number ?? e?.originalError?.number ?? e?.originalError?.info?.number;
};

/**
 * NXA_Lessons stores one external URL (ExternalUrl, used for the video link)
 * and the study text (ContentText). PDFs and extra links belong in
 * NXA_LearningMaterials, whose MaterialType values are not yet established,
 * so non-empty values for those are refused rather than silently dropped.
 */
const rejectUnpersistedLessonFields = (modules: CourseModule[]): void => {
  const fields = new Set<string>();
  for (const m of modules) {
    for (const c of m.chapters ?? []) {
      for (const l of c.lessons ?? []) {
        if (l.pdfUrl) fields.add("lessons.pdfUrl");
        if (l.externalLinks && l.externalLinks.length > 0) fields.add("lessons.externalLinks");
      }
    }
  }
  if (fields.size > 0) throw new UnsupportedFieldsError("lesson", [...fields]);
};

/** Refuses fields NXA_Courses cannot store, rather than dropping them silently. */
const rejectUnpersistedFields = (input: object): void => {
  const present = UNPERSISTED_COURSE_FIELDS.filter(
    (f) => (input as Record<string, unknown>)[f] !== undefined,
  );
  if (present.length > 0) throw new UnsupportedFieldsError("course", present);
};

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
  ContentText: string | null;
  IsPreview: boolean | number | null;
  IsDownloadAllowed: boolean | number | null;
  LessonSequence: number | null;
  IsSequentialUnlock?: boolean | number | null;
  PublishAt?: Date | string | null;
  LessonStatus?: string | null;
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
    durationWeeks,
    feeINR: Math.round(Number(row.ListPrice ?? 0)),
    level,
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
        l.ContentText,
        l.IsPreview,
        l.IsDownloadAllowed,
        l.IsSequentialUnlock,
        l.PublishAt,
        l.Status AS LessonStatus,
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
            ...(r.ContentText ? { studyMaterialText: r.ContentText } : {}),
            isFreePreview: Boolean(r.IsPreview),
            isDownloadRestricted: !Boolean(r.IsDownloadAllowed),
            ...(r.IsSequentialUnlock ? { isSequentialUnlock: true } : {}),
            ...(r.PublishAt ? { publishAt: new Date(r.PublishAt).toISOString() } : {}),
            ...(r.LessonStatus ? { isPublished: String(r.LessonStatus).toUpperCase() === "PUBLISHED" } : {}),
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

  async create(input: CreateCourseInput, audit?: CourseAuditFor<{ courseCode: string }>): Promise<Course> {
    rejectUnpersistedFields(input);
    const pool = await this.getPool();
    const code = (input.courseCode ?? input.slug).trim().toUpperCase();
    const duplicate = (err: unknown): unknown => {
      const sqlNum = sqlErrorNumber(err);
      return sqlNum === 2601 || sqlNum === 2627 ? new DuplicateRecordError("course", "courseCode", code) : err;
    };
    const tx = pool.transaction();
    try {
      await tx.begin();
    } catch (err) {
      throw duplicate(err);
    }
    let id = "";
    try {
      const req = tx.request();
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
        id = String(result.recordset[0]?.CourseId);
      } catch (err: unknown) {
        throw duplicate(err);
      }

      await writeCourseAudit(tx, audit?.({ courseCode: code }), id);
      await tx.commit();
    } catch (err) {
      try {
        await tx.rollback();
      } catch {
        // already rolled back
      }
      throw duplicate(err);
    }

    const created = await this.findById(id);
    if (!created) {
      throw new Error("Failed to reload created course");
    }
    return created;
  }

  async update(id: EntityId, input: UpdateCourseInput, audit?: CourseAudit): Promise<Course> {
    rejectUnpersistedFields(input);
    if (input.courseCode !== undefined) {
      // CourseCode is also the public slug; changing it would break links.
      throw new UnsupportedFieldsError("course", ["courseCode"]);
    }
    const pool = await this.getPool();
    const existing = await this.findById(id);
    if (!existing) {
      throw new RecordNotFoundError("course", id);
    }

    const next = {
      title: input.title ?? existing.title,
      shortDescription: input.shortDescription ?? existing.shortDescription,
      longDescription: input.longDescription ?? existing.longDescription,
      feeINR: input.feeINR ?? existing.feeINR,
      level: input.level ?? existing.level,
      durationWeeks: input.durationWeeks ?? existing.durationWeeks,
    };
    // A patch that changes no stored column writes nothing and is not audited.
    if (
      next.title === existing.title &&
      next.shortDescription === existing.shortDescription &&
      next.longDescription === existing.longDescription &&
      Number(next.feeINR) === Number(existing.feeINR) &&
      next.level === existing.level &&
      Number(next.durationWeeks) === Number(existing.durationWeeks)
    ) {
      return existing;
    }

    const tx = pool.transaction();
    await tx.begin();
    try {
      const req = tx.request();
      req.input("id", sql.BigInt, id);
      req.input("name", sql.NVarChar(200), next.title);
      req.input("shortDesc", sql.NVarChar(1000), next.shortDescription);
      req.input("desc", sql.NVarChar(sql.MAX), next.longDescription);
      req.input("price", sql.Decimal(12, 2), next.feeINR);
      req.input("level", sql.VarChar(30), next.level);
      req.input("durationVal", sql.Int, next.durationWeeks);

      const result = await req.query(`
        UPDATE dbo.NXA_Courses
        SET CourseName = @name,
            ShortDescription = @shortDesc,
            Description = @desc,
            ListPrice = @price,
            CourseLevel = @level,
            DurationValue = @durationVal,
            DurationUnit = 'WEEKS',
            UpdatedAt = SYSUTCDATETIME()
        WHERE CourseId = @id AND DeletedAt IS NULL
      `);
      if ((result.rowsAffected[0] ?? 0) === 0) throw new RecordNotFoundError("course", id);
      await writeCourseAudit(tx, audit, String(id));
      await tx.commit();
    } catch (err) {
      try {
        await tx.rollback();
      } catch {
        // already rolled back
      }
      throw err;
    }

    const updated = await this.findById(id);
    if (!updated) {
      throw new RecordNotFoundError("course", id);
    }
    return updated;
  }

  /**
   * Saves the curriculum tree WITHOUT regenerating ids.
   *
   * Items whose id already belongs to this course are updated in place (so
   * lesson ids referenced by progress, doubts, bookmarks and materials stay
   * valid); items without such an id are inserted; stored items missing from
   * the tree are deleted. All in one transaction. A delete blocked by a
   * foreign key (e.g. a lesson with student progress) rolls everything back
   * and surfaces as RecordInUseError.
   *
   * Live-schema rules:
   *  - NXA_CourseModules is unique on (CourseVersionId, SequenceNumber) with no
   *    filter, so modules must belong to a course version (NULL versions would
   *    collide across courses). Approved decision: modules are attached to the
   *    course's current version (IsCurrent = 1); a course with no version gets
   *    VersionNumber 1 (IsCurrent = 1) created in the same transaction.
   *  - Modules, chapters and lessons are unique on their parent + SequenceNumber,
   *    so stored rows are first parked on unique negative sequence numbers and
   *    then given their final 1..n order: a reorder cannot collide midway.
   *  - Lesson study text is NXA_Lessons.ContentText.
   */
  async replaceCurriculum(id: EntityId, modules: CourseModule[], audit?: CourseAudit): Promise<Course> {
    rejectUnpersistedLessonFields(modules);
    if (!/^\d{1,19}$/.test(String(id))) throw new RecordNotFoundError("course", id);
    const pool = await this.getPool();
    const existing = await this.findById(id);
    if (!existing) {
      throw new RecordNotFoundError("course", id);
    }
    // Saving the stored tree again (including lesson unlock / publish-date
    // settings) changes nothing: no write and no audit entry.
    if (sameCurriculum(existing.modules, modules)) {
      return existing;
    }

    const tx = pool.transaction();
    await tx.begin();

    try {
      // 1. The course version the modules belong to.
      const vReq = tx.request();
      vReq.input("courseId", sql.BigInt, id);
      const versions = await vReq.query<{ CourseVersionId: number | bigint; IsCurrent: boolean | number }>(`
        SELECT CourseVersionId, IsCurrent
        FROM dbo.NXA_CourseVersions WITH (UPDLOCK, HOLDLOCK)
        WHERE CourseId = @courseId
      `);
      const current = versions.recordset.filter((v) => Boolean(v.IsCurrent));
      if (current.length > 1) {
        throw new RecordInUseError("curriculum", "the course has more than one current version; resolve that before saving the curriculum");
      }
      if (current.length === 0 && versions.recordset.length > 0) {
        throw new RecordInUseError("curriculum", "the course has versions but none is marked current; resolve that before saving the curriculum");
      }
      let versionId: string;
      if (current[0]) {
        versionId = String(current[0].CourseVersionId);
      } else {
        const nv = tx.request();
        nv.input("courseId", sql.BigInt, id);
        const created = await nv.query<{ CourseVersionId: number | bigint }>(`
          INSERT INTO dbo.NXA_CourseVersions (CourseId, VersionNumber, IsCurrent, CreatedAt)
          OUTPUT inserted.CourseVersionId
          VALUES (@courseId, 1, 1, SYSUTCDATETIME())
        `);
        versionId = String(created.recordset[0]?.CourseVersionId);
      }

      // 2. What is stored for this course (locked).
      const idsReq = tx.request();
      idsReq.input("courseId", sql.BigInt, id);
      const stored = await idsReq.query<{ ModuleId: number | bigint; ChapterId: number | bigint | null; LessonId: number | bigint | null }>(`
        SELECT m.ModuleId, c.ChapterId, l.LessonId
        FROM dbo.NXA_CourseModules m WITH (UPDLOCK, HOLDLOCK)
        LEFT JOIN dbo.NXA_Chapters c ON c.ModuleId = m.ModuleId
        LEFT JOIN dbo.NXA_Lessons l ON l.ChapterId = c.ChapterId
        WHERE m.CourseId = @courseId
      `);
      const storedModules = new Set<string>();
      const storedChapters = new Set<string>();
      const storedLessons = new Set<string>();
      for (const r of stored.recordset) {
        storedModules.add(String(r.ModuleId));
        if (r.ChapterId !== null) storedChapters.add(String(r.ChapterId));
        if (r.LessonId !== null) storedLessons.add(String(r.LessonId));
      }

      // 3. Park stored rows on unique negative sequence numbers (and move
      //    modules onto the current version) so the final ordering cannot
      //    collide with a not-yet-updated sibling.
      if (storedModules.size > 0) {
        const park = tx.request();
        park.input("courseId", sql.BigInt, id);
        park.input("versionId", sql.BigInt, versionId);
        await park.query(`
          WITH l AS (
            SELECT les.SequenceNumber, ROW_NUMBER() OVER (ORDER BY les.LessonId) AS rn
            FROM dbo.NXA_Lessons les
            JOIN dbo.NXA_Chapters ch ON ch.ChapterId = les.ChapterId
            JOIN dbo.NXA_CourseModules mo ON mo.ModuleId = ch.ModuleId
            WHERE mo.CourseId = @courseId
          )
          UPDATE l SET SequenceNumber = -rn;

          WITH c AS (
            SELECT ch.SequenceNumber, ROW_NUMBER() OVER (ORDER BY ch.ChapterId) AS rn
            FROM dbo.NXA_Chapters ch
            JOIN dbo.NXA_CourseModules mo ON mo.ModuleId = ch.ModuleId
            WHERE mo.CourseId = @courseId
          )
          UPDATE c SET SequenceNumber = -rn;

          WITH m AS (
            SELECT mo.SequenceNumber, mo.CourseVersionId, ROW_NUMBER() OVER (ORDER BY mo.ModuleId) AS rn
            FROM dbo.NXA_CourseModules mo
            WHERE mo.CourseId = @courseId
          )
          UPDATE m SET SequenceNumber = -rn, CourseVersionId = @versionId;
        `);
      }

      const keptModules = new Set<string>();
      const keptChapters = new Set<string>();
      const keptLessons = new Set<string>();

      // 4. Write the tree in order.
      let modSeq = 1;
      for (const m of modules) {
        const mReq = tx.request();
        mReq.input("courseId", sql.BigInt, id);
        mReq.input("versionId", sql.BigInt, versionId);
        mReq.input("title", sql.NVarChar(200), m.title);
        mReq.input("desc", sql.NVarChar(1000), m.description ?? "");
        mReq.input("seq", sql.Int, modSeq++);
        let moduleId: string;
        if (storedModules.has(String(m.id))) {
          moduleId = String(m.id);
          mReq.input("id", sql.BigInt, moduleId);
          await mReq.query(`
            UPDATE dbo.NXA_CourseModules
            SET ModuleTitle = @title, ModuleDescription = @desc, SequenceNumber = @seq, CourseVersionId = @versionId
            WHERE ModuleId = @id AND CourseId = @courseId
          `);
        } else {
          const r = await mReq.query<{ ModuleId: number | bigint }>(`
            INSERT INTO dbo.NXA_CourseModules (CourseId, CourseVersionId, ModuleTitle, ModuleDescription, SequenceNumber, IsPublished, CreatedAt)
            OUTPUT inserted.ModuleId
            VALUES (@courseId, @versionId, @title, @desc, @seq, 1, SYSUTCDATETIME())
          `);
          moduleId = String(r.recordset[0]?.ModuleId);
        }
        keptModules.add(moduleId);

        let chapSeq = 1;
        for (const c of m.chapters ?? []) {
          const cReq = tx.request();
          cReq.input("moduleId", sql.BigInt, moduleId);
          cReq.input("title", sql.NVarChar(200), c.title);
          cReq.input("desc", sql.NVarChar(1000), c.description ?? "");
          cReq.input("seq", sql.Int, chapSeq++);
          let chapterId: string;
          if (storedChapters.has(String(c.id))) {
            chapterId = String(c.id);
            cReq.input("id", sql.BigInt, chapterId);
            // A chapter may move between modules of the same course.
            await cReq.query(`
              UPDATE dbo.NXA_Chapters
              SET ModuleId = @moduleId, ChapterTitle = @title, Description = @desc, SequenceNumber = @seq
              WHERE ChapterId = @id
            `);
          } else {
            const r = await cReq.query<{ ChapterId: number | bigint }>(`
              INSERT INTO dbo.NXA_Chapters (ModuleId, ChapterTitle, Description, SequenceNumber, CreatedAt)
              OUTPUT inserted.ChapterId
              VALUES (@moduleId, @title, @desc, @seq, SYSUTCDATETIME())
            `);
            chapterId = String(r.recordset[0]?.ChapterId);
          }
          keptChapters.add(chapterId);

          let lesSeq = 1;
          for (const l of c.lessons ?? []) {
            const lReq = tx.request();
            lReq.input("chapterId", sql.BigInt, chapterId);
            lReq.input("title", sql.NVarChar(200), l.title);
            lReq.input("type", sql.VarChar(30), l.lessonType ?? "reading");
            lReq.input("dur", sql.Int, l.durationMinutes ?? 0);
            lReq.input("url", sql.NVarChar(1000), l.videoUrl ? l.videoUrl : null);
            lReq.input("content", sql.NVarChar(sql.MAX), l.studyMaterialText ?? null);
            lReq.input("preview", sql.Bit, l.isFreePreview ? 1 : 0);
            lReq.input("seq", sql.Int, lesSeq++);
            // LMS-006: download permission; unspecified keeps the stored value.
            lReq.input("download", sql.Bit, l.isDownloadRestricted === undefined ? null : l.isDownloadRestricted ? 0 : 1);
            // LMS-004 / LMS-005: sequential unlock and scheduled availability.
            lReq.input("sequential", sql.Bit, l.isSequentialUnlock ? 1 : 0);
            lReq.input("publishAt", sql.DateTime2, l.publishAt ? new Date(l.publishAt) : null);
            if (storedLessons.has(String(l.id))) {
              keptLessons.add(String(l.id));
              lReq.input("id", sql.BigInt, String(l.id));
              await lReq.query(`
                UPDATE dbo.NXA_Lessons
                SET ChapterId = @chapterId, LessonTitle = @title, LessonType = @type, DurationMinutes = @dur,
                    ExternalUrl = @url, ContentText = @content, IsPreview = @preview, SequenceNumber = @seq,
                    IsDownloadAllowed = COALESCE(@download, IsDownloadAllowed), IsSequentialUnlock = @sequential,
                    PublishAt = @publishAt, UpdatedAt = SYSUTCDATETIME()
                WHERE LessonId = @id
              `);
            } else {
              await lReq.query(`
                INSERT INTO dbo.NXA_Lessons (
                  ChapterId, LessonTitle, LessonType, DurationMinutes, ExternalUrl, ContentText, IsPreview,
                  IsDownloadAllowed, IsSequentialUnlock, PublishAt, SequenceNumber, Status, CreatedAt
                )
                VALUES (
                  @chapterId, @title, @type, @dur, @url, @content, @preview,
                  COALESCE(@download, 0), @sequential, @publishAt, @seq, 'PUBLISHED', SYSUTCDATETIME()
                )
              `);
            }
          }
        }
      }

      // 5. Remove what the tree no longer contains, children first.
      const drop = async (table: string, column: string, ids: string[]) => {
        for (const did of ids) {
          const dReq = tx.request();
          dReq.input("id", sql.BigInt, did);
          await dReq.query(`DELETE FROM dbo.${table} WHERE ${column} = @id`);
        }
      };
      try {
        await drop("NXA_Lessons", "LessonId", [...storedLessons].filter((x) => !keptLessons.has(x)));
        await drop("NXA_Chapters", "ChapterId", [...storedChapters].filter((x) => !keptChapters.has(x)));
        await drop("NXA_CourseModules", "ModuleId", [...storedModules].filter((x) => !keptModules.has(x)));
      } catch (err) {
        if (sqlErrorNumber(err) === 547) {
          throw new RecordInUseError(
            "curriculum",
            "a removed module, chapter or lesson still has student activity or materials linked to it",
          );
        }
        throw err;
      }

      await writeCourseAudit(tx, audit, String(id));
      await tx.commit();
    } catch (err) {
      try {
        await tx.rollback();
      } catch {
        // already rolled back
      }
      throw err;
    }

    const updated = await this.findById(id);
    if (!updated) {
      throw new RecordNotFoundError("course", id);
    }
    return updated;
  }

  async setPublication(
    id: EntityId,
    change: { status: CourseStatus; isPublished: boolean },
    audit?: CourseAudit,
  ): Promise<Course> {
    const pool = await this.getPool();
    const tx = pool.transaction();
    await tx.begin();
    try {
      const req = tx.request();
      req.input("id", sql.BigInt, id);
      req.input("status", sql.VarChar(20), change.status.toUpperCase());

      // Publication is carried by Status. IsPreviewEnabled is the separate
      // "free preview before payment" switch (CRS-009) and is not touched here.
      // Only a real change updates the row; the same status is not audited.
      const result = await req.query(`
        UPDATE dbo.NXA_Courses
        SET Status = @status,
            UpdatedAt = SYSUTCDATETIME()
        WHERE CourseId = @id AND DeletedAt IS NULL AND UPPER(ISNULL(Status, '')) <> @status
      `);

      if ((result.rowsAffected[0] ?? 0) === 0) {
        const exists = await tx
          .request()
          .input("id", sql.BigInt, id)
          .query(`SELECT CourseId FROM dbo.NXA_Courses WHERE CourseId = @id AND DeletedAt IS NULL`);
        if (exists.recordset.length === 0) throw new RecordNotFoundError("course", id);
      } else {
        await writeCourseAudit(tx, audit, String(id));
      }
      await tx.commit();
    } catch (err) {
      try {
        await tx.rollback();
      } catch {
        // already rolled back
      }
      throw err;
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
  // --- Prerequisites (NXA_CoursePrerequisites) -------------------------------

  private async readPrerequisites(
    request: sql.Request,
    courseId: string,
  ): Promise<PrerequisiteCourse[]> {
    request.input("pCourseId", sql.BigInt, courseId);
    const rows = await request.query<{ CourseId: number | bigint; CourseCode: string; CourseName: string }>(`
      SELECT c.CourseId, c.CourseCode, c.CourseName
      FROM dbo.NXA_CoursePrerequisites p
      JOIN dbo.NXA_Courses c ON c.CourseId = p.PrerequisiteCourseId
      WHERE p.CourseId = @pCourseId
      ORDER BY c.CourseName ASC, c.CourseId ASC
    `);
    return rows.recordset.map((r) => ({ courseId: String(r.CourseId), courseCode: r.CourseCode, title: r.CourseName }));
  }

  async findPrerequisites(courseId: EntityId): Promise<PrerequisiteCourse[]> {
    if (!/^\d{1,19}$/.test(String(courseId))) throw new RecordNotFoundError("course", courseId);
    const pool = await this.getPool();
    const exists = await pool
      .request()
      .input("id", sql.BigInt, courseId)
      .query(`SELECT CourseId FROM dbo.NXA_Courses WHERE CourseId = @id AND DeletedAt IS NULL`);
    if (exists.recordset.length === 0) throw new RecordNotFoundError("course", courseId);
    return this.readPrerequisites(pool.request(), String(courseId));
  }

  /**
   * Replaces the prerequisite set in one transaction: validates the course,
   * every prerequisite course (exists, not deleted, not the course itself)
   * and that no circular chain results; then removes dropped links and adds
   * new ones. An unchanged set writes nothing.
   */
  async replacePrerequisites(
    courseId: EntityId,
    prerequisiteCourseIds: string[],
    audit?: CourseAuditFor<PrerequisiteCourse[]>,
  ): Promise<{ prerequisites: PrerequisiteCourse[]; changed: boolean }> {
    const id = String(courseId);
    if (!/^\d{1,19}$/.test(id)) throw new RecordNotFoundError("course", id);
    const wanted = [...new Set(prerequisiteCourseIds.map(String))];
    assertNotSelf(id, wanted);
    const nonNumeric = wanted.filter((p) => !/^\d{1,19}$/.test(p));
    if (nonNumeric.length > 0) {
      throw new PrerequisiteRuleError("UNKNOWN_PREREQUISITE_COURSE", "Some prerequisite courses do not exist.", nonNumeric);
    }

    const pool = await this.getPool();
    const tx = pool.transaction();
    await tx.begin();
    let changed = false;
    try {
      const cReq = tx.request();
      cReq.input("id", sql.BigInt, id);
      const course = await cReq.query(`SELECT CourseId FROM dbo.NXA_Courses WHERE CourseId = @id AND DeletedAt IS NULL`);
      if (course.recordset.length === 0) throw new RecordNotFoundError("course", id);

      if (wanted.length > 0) {
        const eReq = tx.request();
        const names = wanted.map((p, i) => {
          eReq.input(`p${i}`, sql.BigInt, p);
          return `@p${i}`;
        });
        const found = await eReq.query<{ CourseId: number | bigint }>(
          `SELECT CourseId FROM dbo.NXA_Courses WHERE DeletedAt IS NULL AND CourseId IN (${names.join(", ")})`,
        );
        const foundIds = new Set(found.recordset.map((r) => String(r.CourseId)));
        const missing = wanted.filter((p) => !foundIds.has(p));
        if (missing.length > 0) {
          throw new PrerequisiteRuleError("UNKNOWN_PREREQUISITE_COURSE", "Some prerequisite courses do not exist.", missing);
        }
      }

      // All stored links, locked, for the cycle check and the diff.
      const all = await tx.request().query<{ CourseId: number | bigint; PrerequisiteCourseId: number | bigint }>(`
        SELECT CourseId, PrerequisiteCourseId FROM dbo.NXA_CoursePrerequisites WITH (UPDLOCK, HOLDLOCK)
      `);
      const edges = all.recordset.map((r) => [String(r.CourseId), String(r.PrerequisiteCourseId)] as const);
      assertNoCycle(id, wanted, edges);

      const current = edges.filter(([c]) => c === id).map(([, p]) => p);
      const { toAdd, toRemove } = planPrerequisiteChange(current, wanted);
      changed = toAdd.length > 0 || toRemove.length > 0;

      for (const p of toRemove) {
        const d = tx.request();
        d.input("courseId", sql.BigInt, id);
        d.input("prereqId", sql.BigInt, p);
        await d.query(`DELETE FROM dbo.NXA_CoursePrerequisites WHERE CourseId = @courseId AND PrerequisiteCourseId = @prereqId`);
      }
      for (const p of toAdd) {
        const a = tx.request();
        a.input("courseId", sql.BigInt, id);
        a.input("prereqId", sql.BigInt, p);
        await a.query(`INSERT INTO dbo.NXA_CoursePrerequisites (CourseId, PrerequisiteCourseId) VALUES (@courseId, @prereqId)`);
      }

      // Audited only when the set changed, in the same transaction, with the
      // saved set as this transaction sees it.
      if (changed && audit) {
        await writeCourseAudit(tx, audit(await this.readPrerequisites(tx.request(), id)), id);
      }
      await tx.commit();
    } catch (err) {
      try {
        await tx.rollback();
      } catch {
        // already rolled back
      }
      throw err;
    }

    const pool2 = await this.getPool();
    return { prerequisites: await this.readPrerequisites(pool2.request(), id), changed };
  }
}
