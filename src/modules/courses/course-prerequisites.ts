/**
 * Course prerequisites as the live schema models them: NXA_CoursePrerequisites
 * rows (CourseId, PrerequisiteCourseId), both foreign keys to NXA_Courses,
 * unique per pair. A prerequisite is therefore another course, not free text.
 *
 * Shared by the SQL Server adapter and the in-memory fake so both apply the
 * same structural rules: no self-dependency, only existing courses, no cycles.
 * Whether a student must complete a prerequisite before enrolling is NOT
 * decided; nothing here enforces it.
 */

export interface PrerequisiteCourse {
  courseId: string;
  courseCode?: string | undefined;
  title: string;
}

export type PrerequisiteRuleCode = "SELF_PREREQUISITE" | "UNKNOWN_PREREQUISITE_COURSE" | "CIRCULAR_PREREQUISITE";

/** A structurally invalid prerequisite set. Nothing was written. */
export class PrerequisiteRuleError extends Error {
  constructor(
    readonly code: PrerequisiteRuleCode,
    message: string,
    /** The offending course ids (for a cycle: the path back to the course). */
    readonly courseIds: string[],
  ) {
    super(message);
    this.name = "PrerequisiteRuleError";
  }
}

/** Throws when the course lists itself. */
export const assertNotSelf = (courseId: string, prerequisiteIds: readonly string[]): void => {
  if (prerequisiteIds.includes(courseId)) {
    throw new PrerequisiteRuleError("SELF_PREREQUISITE", "A course cannot be its own prerequisite.", [courseId]);
  }
};

/**
 * Returns the cycle that `courseId -> prerequisiteIds` would create, as the
 * path [courseId, ..., courseId], or null when there is none. `edges` are the
 * stored (course, prerequisite) pairs; the course's own stored edges are
 * replaced by `prerequisiteIds`.
 */
export const findPrerequisiteCycle = (
  courseId: string,
  prerequisiteIds: readonly string[],
  edges: ReadonlyArray<readonly [string, string]>,
): string[] | null => {
  const graph = new Map<string, string[]>();
  for (const [course, prereq] of edges) {
    if (course === courseId) continue;
    const list = graph.get(course) ?? [];
    list.push(prereq);
    graph.set(course, list);
  }
  graph.set(courseId, [...prerequisiteIds]);

  // Depth-first search from the course; reaching it again is a cycle.
  const visited = new Set<string>();
  const walk = (node: string, path: string[]): string[] | null => {
    for (const next of graph.get(node) ?? []) {
      if (next === courseId) return [...path, next];
      if (visited.has(next)) continue;
      visited.add(next);
      const found = walk(next, [...path, next]);
      if (found) return found;
    }
    return null;
  };
  return walk(courseId, [courseId]);
};

/** Throws CIRCULAR_PREREQUISITE when the change would create a cycle. */
export const assertNoCycle = (
  courseId: string,
  prerequisiteIds: readonly string[],
  edges: ReadonlyArray<readonly [string, string]>,
): void => {
  const cycle = findPrerequisiteCycle(courseId, prerequisiteIds, edges);
  if (cycle) {
    throw new PrerequisiteRuleError(
      "CIRCULAR_PREREQUISITE",
      `These prerequisites would create a circular chain: ${cycle.join(" -> ")}.`,
      cycle,
    );
  }
};

/** The rows to add and remove to go from `current` to `next` (set semantics). */
export const planPrerequisiteChange = (
  current: readonly string[],
  next: readonly string[],
): { toAdd: string[]; toRemove: string[] } => ({
  toAdd: next.filter((id) => !current.includes(id)),
  toRemove: current.filter((id) => !next.includes(id)),
});
