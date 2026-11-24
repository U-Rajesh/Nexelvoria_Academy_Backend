import type { CourseModule, Lesson } from "./course.types";

/**
 * LMS-004 / LMS-005: when an enrolled student may open a lesson.
 *
 * - Publication: only lessons stored as PUBLISHED are part of the course for
 *   students (the only Status value the application writes).
 * - Scheduling: `publishAt` is an absolute instant (stored UTC); before it the
 *   lesson is "scheduled". No time-zone rule is applied or invented.
 * - Sequential unlock: a lesson flagged `isSequentialUnlock` opens only when
 *   the lesson immediately before it in course order (module, chapter, lesson
 *   sequence) has been completed by the student (NXA_LessonProgress.IsCompleted).
 *   No other completion rule (score, time spent) is applied.
 */
export type LessonAccessState = "available" | "scheduled" | "locked";

export interface LessonAccess {
  lesson: Lesson;
  state: LessonAccessState;
  /** For "scheduled": when it opens. */
  availableAt?: string | undefined;
  /** For "locked": the lesson that must be completed first. */
  requiresLessonId?: string | undefined;
  requiresLessonTitle?: string | undefined;
  isCompleted: boolean;
}

/** Published lessons of a course in study order. */
export function orderedLessons(modules: CourseModule[]): Lesson[] {
  return [...modules]
    .sort((a, b) => a.order - b.order)
    .flatMap((m) => [...m.chapters].sort((a, b) => a.order - b.order).flatMap((c) => [...c.lessons].sort((a, b) => a.order - b.order)))
    .filter((l) => l.isPublished !== false);
}

export function evaluateLessonAccess(modules: CourseModule[], completedLessonIds: ReadonlySet<string>, now: Date = new Date()): LessonAccess[] {
  const lessons = orderedLessons(modules);
  return lessons.map((lesson, i) => {
    const isCompleted = completedLessonIds.has(String(lesson.id));
    if (lesson.publishAt && Date.parse(lesson.publishAt) > now.getTime()) {
      return { lesson, state: "scheduled", availableAt: lesson.publishAt, isCompleted };
    }
    const previous = lessons[i - 1];
    if (lesson.isSequentialUnlock && previous && !completedLessonIds.has(String(previous.id))) {
      return { lesson, state: "locked", requiresLessonId: String(previous.id), requiresLessonTitle: previous.title, isCompleted };
    }
    return { lesson, state: "available", isCompleted };
  });
}
