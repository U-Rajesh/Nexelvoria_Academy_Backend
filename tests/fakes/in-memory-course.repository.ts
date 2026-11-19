import type { PaginatedResult, PaginationQuery } from "../../src/contracts/api.contract";
import type { EntityId, Slug } from "../../src/contracts/identifier.contract";
import type { CourseRepository } from "../../src/modules/courses/course.repository";
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
 * Strings compare case-insensitively, approximating SQL Server's default
 * CI collation (open-questions Q17). Ties are broken EXPLICITLY by `id ASC`,
 * numeric-aware and regardless of direction (database-handoff Q-I1) - not
 * by insertion order, which matches id order only when rows happen to be
 * inserted in id order.
 */
const compareCourses = (a: Course, b: Course, sort: CourseSort): number => {
  const left = a[sort.field];
  const right = b[sort.field];

  const result =
    typeof left === "string" && typeof right === "string"
      ? left.toLowerCase().localeCompare(right.toLowerCase())
      : Number(left) - Number(right);

  const directed = sort.order === "desc" ? -result : result;

  return directed !== 0 ? directed : a.id.localeCompare(b.id, undefined, { numeric: true });
};

/** TEST-ONLY in-memory `CourseRepository`. See in-memory-store.ts. */
export class InMemoryCourseRepository implements CourseRepository {
  private readonly store = new InMemoryStore<Course>("course");

  reset(): void {
    this.store.reset();
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

  async create(input: CreateCourseInput): Promise<Course> {
    if (await this.existsBySlug(input.slug)) {
      throw new DuplicateRecordError("course", "slug", input.slug);
    }

    return this.store.set({
      ...input,
      id: this.store.nextId(),
      modules: [],
      isPublished: false,
      status: "Draft",
    });
  }

  async update(id: EntityId, input: UpdateCourseInput): Promise<Course> {
    const existing = this.store.getOrThrow(id);
    return this.store.set({ ...existing, ...input });
  }

  async replaceCurriculum(id: EntityId, modules: CourseModule[]): Promise<Course> {
    const existing = this.store.getOrThrow(id);

    // A full replace, matching the port contract - not a merge.
    return this.store.set({ ...existing, modules: structuredClone(modules) });
  }

  async setPublication(
    id: EntityId,
    change: { status: CourseStatus; isPublished: boolean },
  ): Promise<Course> {
    const existing = this.store.getOrThrow(id);

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
