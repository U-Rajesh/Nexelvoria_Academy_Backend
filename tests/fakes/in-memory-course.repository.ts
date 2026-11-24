import type { PaginatedResult, PaginationQuery } from "../../src/contracts/api.contract";
import type { EntityId, Slug } from "../../src/contracts/identifier.contract";
import type { AuditEntry } from "../../src/contracts/audit.contract";
import type { CourseAudit, CourseAuditFor, CourseRepository } from "../../src/modules/courses/course.repository";
import {
  PrerequisiteRuleError,
  assertNoCycle,
  assertNotSelf,
  planPrerequisiteChange,
  type PrerequisiteCourse,
} from "../../src/modules/courses/course-prerequisites";
import type {
  Course,
  CourseFilter,
  CourseModule,
  CourseSort,
  CourseStatus,
  CreateCourseInput,
  Lesson,
  UpdateCourseInput,
} from "../../src/modules/courses/course.types";
import { DuplicateRecordError } from "../../src/repositories/repository.errors";
import {
  InMemoryStore,
  containsIgnoreCase,
  equalsIgnoreCase,
  paginate,
} from "./in-memory-store";

/**
 * Orders two courses by an allow-listed field.
 *
 * Strings compare case-insensitively, mirroring SQL Server's default
 * CI collation (open-questions Q17). `Array.prototype.sort` is stable, so
 * ties keep insertion order - the fake's equivalent of the id tiebreaker a
 * real adapter must append (database-handoff Q-I1).
 */
const compareCourses = (a: Course, b: Course, sort: CourseSort): number => {
  const left = a[sort.field];
  const right = b[sort.field];

  const result =
    typeof left === "string" && typeof right === "string"
      ? left.toLowerCase().localeCompare(right.toLowerCase())
      : Number(left) - Number(right);

  return sort.order === "desc" ? -result : result;
};

/** TEST-ONLY in-memory `CourseRepository`. See in-memory-store.ts. */
export class InMemoryCourseRepository implements CourseRepository {
  private readonly store = new InMemoryStore<Course>("course");

  /**
   * Where audit entries go (the harness points it at the admin fake's audit
   * log, as NXA_AuditLogs). The fake writes the audit BEFORE applying the
   * change, so a failed audit leaves nothing changed - like the SQL transaction.
   */
  auditSink?: (entry: AuditEntry) => Promise<unknown>;
  /** Test hook: the course audit write fails. */
  failAudit = false;

  private async audit(entry: CourseAudit | undefined, courseId: string): Promise<void> {
    if (!entry) return;
    if (this.failAudit) throw new Error("audit write failed");
    await this.auditSink?.({ ...entry, moduleCode: "COURSE_MGMT", entityName: "Course", entityId: courseId });
  }

  reset(): void {
    this.store.reset();
    this.prerequisiteLinks.clear();
    this.failAudit = false;
  }

  seed(course: Course): Course {
    return this.store.set(course);
  }

  get count(): number {
    return this.store.size;
  }

  async findById(id: EntityId): Promise<Course | null> {
    return this.store.get(id);
  }

  async findBySlug(slug: Slug): Promise<Course | null> {
    return this.store.find((c) => equalsIgnoreCase(c.slug, slug));
  }

  async existsBySlug(slug: Slug): Promise<boolean> {
    return (await this.findBySlug(slug)) !== null;
  }

  async findMany(
    filter: CourseFilter,
    pagination: PaginationQuery,
    sort?: CourseSort,
  ): Promise<PaginatedResult<Course>> {
    const rows = this.store.filter((course) => {
      // The public catalogue sets publishedOnly; drafts must never leak.
      if (filter.publishedOnly === true && !course.isPublished) return false;

      if (filter.category !== undefined && course.category !== filter.category) return false;
      if (filter.level !== undefined && course.level !== filter.level) return false;
      if (filter.status !== undefined && course.status !== filter.status) return false;

      if (
        filter.hasPlacementGuarantee !== undefined &&
        course.hasPlacementGuarantee !== filter.hasPlacementGuarantee
      ) {
        return false;
      }

      if (filter.search !== undefined) {
        const term = filter.search;
        const matches =
          containsIgnoreCase(course.title, term) ||
          containsIgnoreCase(course.shortDescription, term) ||
          course.technologies.some((tech) => containsIgnoreCase(tech, term));

        if (!matches) return false;
      }

      return true;
    });

    // No sort: insertion order, unchanged from before `sort` existed, so
    // existing callers and tests behave exactly as they did.
    if (sort !== undefined) {
      rows.sort((a, b) => compareCourses(a, b, sort));
    }

    return paginate(rows, pagination);
  }

  async create(input: CreateCourseInput, audit?: CourseAuditFor<{ courseCode: string }>): Promise<Course> {
    if (await this.existsBySlug(input.slug)) {
      throw new DuplicateRecordError("course", "slug", input.slug);
    }
    const id = this.store.nextId();
    await this.audit(audit?.({ courseCode: input.courseCode ?? input.slug }), id);

    // The fake can store the presentation fields the SQL table lacks; give the
    // now-optional ones neutral values when a caller omits them.
    return this.store.set({
      ...input,
      thumbnailUrl: input.thumbnailUrl ?? "",
      totalHours: input.totalHours ?? 0,
      category: input.category ?? "Software Development",
      technologies: input.technologies ?? [],
      hasPlacementGuarantee: input.hasPlacementGuarantee ?? false,
      prerequisites: input.prerequisites ?? [],
      learningOutcomes: input.learningOutcomes ?? [],
      id,
      modules: [],
      isPublished: false,
      status: "Draft",
    });
  }

  async update(id: EntityId, input: UpdateCourseInput, audit?: CourseAudit): Promise<Course> {
    const existing = this.store.getOrThrow(id);
    const changes = Object.entries(input).some(
      ([k, v]) => v !== undefined && JSON.stringify(v) !== JSON.stringify((existing as unknown as Record<string, unknown>)[k]),
    );
    if (!changes) return existing;
    await this.audit(audit, id);
    return this.store.set({ ...existing, ...input });
  }

  /** Stands in for NXA_CoursePrerequisites: course id -> prerequisite course ids. */
  readonly prerequisiteLinks = new Map<string, string[]>();

  async findPrerequisites(courseId: EntityId): Promise<PrerequisiteCourse[]> {
    this.store.getOrThrow(courseId);
    return (this.prerequisiteLinks.get(courseId) ?? [])
      .map((pid) => this.store.get(pid))
      .filter((c): c is Course => c !== null && c !== undefined)
      .map((c) => ({ courseId: c.id, courseCode: c.courseCode ?? c.slug, title: c.title }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  async replacePrerequisites(
    courseId: EntityId,
    prerequisiteCourseIds: string[],
    audit?: CourseAuditFor<PrerequisiteCourse[]>,
  ): Promise<{ prerequisites: PrerequisiteCourse[]; changed: boolean }> {
    // Mirrors the SQL adapter: same rules, same errors, no write for a no-op.
    this.store.getOrThrow(courseId);
    const wanted = [...new Set(prerequisiteCourseIds)];
    assertNotSelf(courseId, wanted);
    const missing = wanted.filter((p) => !this.store.get(p));
    if (missing.length > 0) {
      throw new PrerequisiteRuleError("UNKNOWN_PREREQUISITE_COURSE", "Some prerequisite courses do not exist.", missing);
    }
    const edges: Array<readonly [string, string]> = [];
    for (const [c, ps] of this.prerequisiteLinks) for (const p of ps) edges.push([c, p]);
    assertNoCycle(courseId, wanted, edges);
    const { toAdd, toRemove } = planPrerequisiteChange(this.prerequisiteLinks.get(courseId) ?? [], wanted);
    const changed = toAdd.length > 0 || toRemove.length > 0;
    if (changed) {
      const previous = this.prerequisiteLinks.get(courseId);
      this.prerequisiteLinks.set(courseId, wanted);
      try {
        if (audit) await this.audit(audit(await this.findPrerequisites(courseId)), courseId);
      } catch (err) {
        // Roll back, as the SQL transaction would.
        if (previous === undefined) this.prerequisiteLinks.delete(courseId);
        else this.prerequisiteLinks.set(courseId, previous);
        throw err;
      }
    }
    return { prerequisites: await this.findPrerequisites(courseId), changed };
  }

  async replaceCurriculum(id: EntityId, modules: CourseModule[], audit?: CourseAudit): Promise<Course> {
    const existing = this.store.getOrThrow(id);
    // The same tree again changes nothing: no write, no audit.
    if (JSON.stringify(existing.modules) === JSON.stringify(modules)) return existing;
    await this.audit(audit, id);

    // A full replace, matching the port contract - not a merge.
    return this.store.set({ ...existing, modules: structuredClone(modules) });
  }

  async setPublication(
    id: EntityId,
    change: { status: CourseStatus; isPublished: boolean },
    audit?: CourseAudit,
  ): Promise<Course> {
    const existing = this.store.getOrThrow(id);
    if (existing.status === change.status && existing.isPublished === change.isPublished) return existing;
    await this.audit(audit, id);

    // One store write carrying both fields - the fake's equivalent of the
    // single atomic UPDATE the port requires.
    return this.store.set({
      ...existing,
      status: change.status,
      isPublished: change.isPublished,
    });
  }

  async setStatus(id: EntityId, status: CourseStatus): Promise<Course> {
    const existing = this.store.getOrThrow(id);
    return this.store.set({ ...existing, status });
  }

  async setPublished(id: EntityId, isPublished: boolean): Promise<Course> {
    const existing = this.store.getOrThrow(id);
    return this.store.set({ ...existing, isPublished });
  }

  async findLessonById(
    courseId: EntityId,
    lessonId: EntityId,
  ): Promise<{ lesson: Lesson } | null> {
    const course = this.store.get(courseId);

    if (course === null) {
      return null;
    }

    for (const module of course.modules) {
      for (const chapter of module.chapters) {
        const lesson = chapter.lessons.find((l) => l.id === lessonId);

        if (lesson !== undefined) {
          return { lesson };
        }
      }
    }

    return null;
  }
}
