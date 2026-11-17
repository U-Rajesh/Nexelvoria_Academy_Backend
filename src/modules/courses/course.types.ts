import type { EntityId, Slug } from "../../contracts/identifier.contract";

/**
 * The `courses` domain, including the curriculum tree.
 *
 * CONFIRMED - every field is copied from the frontend's
 * `src/types/course.types.ts`. The four-level nesting
 * (Course > CourseModule > Chapter > Lesson) is the frontend's existing
 * model, not a new design.
 *
 * How that tree is stored - four tables, or JSON in one column - is
 * explicitly the database team's decision and a question in the handoff
 * document. These types describe the API shape only.
 */

export type LessonType = "video" | "reading" | "pdf" | "assignment" | "quiz";

export interface ExternalLink {
  title: string;
  url: string;
}

export interface Lesson {
  id: EntityId;
  chapterId: EntityId;
  title: string;
  durationMinutes: number;
  lessonType?: LessonType;
  videoUrl?: string;
  pdfUrl?: string;
  studyMaterialText?: string;
  externalLinks?: ExternalLink[];
  /** Accessible before payment (BR-003). */
  isFreePreview: boolean;
  order: number;
  isLocked?: boolean;
  /** Download permission control. */
  isDownloadRestricted?: boolean;
}

export interface Chapter {
  id: EntityId;
  moduleId: EntityId;
  title: string;
  description?: string;
  order: number;
  lessons: Lesson[];
}

export interface CourseModule {
  id: EntityId;
  courseId: EntityId;
  title: string;
  description: string;
  order: number;
  chapters: Chapter[];
}

export type CourseStatus = "Draft" | "Published" | "Active" | "Inactive" | "Archived";

export type CourseLevel = "Beginner" | "Intermediate" | "Advanced";

export type CourseCategory =
  | "Software Development"
  | "Data & AI"
  | "Cloud & DevOps"
  | "Cybersecurity"
  | "Testing";

export interface Course {
  id: EntityId;
  slug: Slug;
  courseCode?: string;
  title: string;
  shortDescription: string;
  longDescription: string;
  thumbnailUrl: string;
  durationWeeks: number;
  totalHours: number;
  /** Fee in whole INR. Never a float - see handoff on money types. */
  feeINR: number;
  discountedFeeINR?: number;
  level: CourseLevel;
  category: CourseCategory;
  technologies: string[];
  modules: CourseModule[];
  isPublished: boolean;
  status?: CourseStatus;
  /** Terms are legally unexecuted - open-questions Q7. */
  hasPlacementGuarantee: boolean;
  prerequisites: string[];
  learningOutcomes: string[];
  eligibilityCriteria?: string[];
  syllabusPdfUrl?: string;
}

/** Filters for the public catalogue and the management list. */
export interface CourseFilter {
  category?: CourseCategory;
  level?: CourseLevel;
  status?: CourseStatus;
  /**
   * Restricts to published courses. The public catalogue MUST set this -
   * see api-contracts section 7 on keeping draft content out of the
   * anonymous endpoint.
   */
  publishedOnly?: boolean;
  hasPlacementGuarantee?: boolean;
  /** Free-text across title, shortDescription and technologies. */
  search?: string;
}

/** Fields accepted when creating a course. Curriculum is set separately. */
export type CreateCourseInput = Omit<Course, "id" | "modules" | "isPublished" | "status">;

/** Patchable course metadata. Curriculum has its own replace operation. */
export type UpdateCourseInput = Partial<Omit<Course, "id" | "modules" | "slug">>;
