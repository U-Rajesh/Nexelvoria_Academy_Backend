import { CMS_COLLECTIONS, type CmsCollectionKey } from "./cms.repository";

/**
 * Approved CMS rules shared by the SQL Server repository and the in-memory fake:
 * - new testimonials, achievements and FAQs start hidden (publishing is a separate, audited step);
 * - testimonials are ordered by position, then student name;
 * - FAQs are ordered by position, then question (NXA_Faqs has no category column);
 * - achievements are ordered newest date first.
 */

export interface CmsAudit {
  action: string;
  entityName: string;
  entityId: string;
  oldValues?: Record<string, unknown> | undefined;
  newValues?: Record<string, unknown> | undefined;
}

/** Collections whose new items must start hidden, and the flag that hides them. */
const START_HIDDEN: Partial<Record<CmsCollectionKey, string>> = {
  testimonials: "isPublished",
  achievements: "isActive",
};

export function applyCollectionRules<T extends { id: string }>(key: CmsCollectionKey, item: T, before: T | undefined): T {
  const flag = START_HIDDEN[key];
  if (!before && flag) return { ...item, [flag]: false };
  return item;
}

const position = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number.MAX_SAFE_INTEGER);
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const time = (v: unknown): number => {
  const t = Date.parse(text(v));
  return Number.isNaN(t) ? 0 : t;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
export function sortCollection<T>(key: CmsCollectionKey, items: T[]): T[] {
  const list = [...items] as any[];
  switch (key) {
    case "testimonials":
      list.sort((a, b) => position(a.displayOrder) - position(b.displayOrder) || text(a.studentName).localeCompare(text(b.studentName)));
      break;
    case "achievements":
      list.sort((a, b) => time(b.date) - time(a.date));
      break;
    case "trainers":
      list.sort((a, b) => position(a.displayOrder) - position(b.displayOrder) || text(a.name).localeCompare(text(b.name)));
      break;
    case "corporate":
      list.sort((a, b) => position(a.order) - position(b.order) || text(a.title).localeCompare(text(b.title)));
      break;
    default:
      break;
  }
  return list as T[];
}

export function sortFaqs<T extends { order: number; question: string; id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.order - b.order || a.question.localeCompare(b.question) || a.id.localeCompare(b.id));
}

/** Drops undefined values so "absent" and "undefined" compare equal. */
const normalize = (v: unknown): Record<string, unknown> => (v ? JSON.parse(JSON.stringify(v)) : {});

/**
 * Compares the stored record with the requested one. Returns null when nothing
 * changes (no write, no audit). Otherwise returns the audit entry: CREATE,
 * a visibility-only change (PUBLISH/UNPUBLISH, SHOW/HIDE, ACTIVATE/DEACTIVATE,
 * STATUS) or UPDATE with only the changed fields.
 */
export function describeChange<A extends { id: string }>(entityName: string, visibilityField: string, before: object | undefined, after: A): CmsAudit | null {
  const a = normalize(after);
  delete a.id;
  if (!before) {
    return { action: "CMS_CREATE", entityName, entityId: after.id, newValues: pick(a, ["title", "name", "studentName", "question", "collegeName", "slug", visibilityField]) };
  }
  const b = normalize(before);
  delete b.id;
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  if (keys.length === 0) return null;
  const oldValues = Object.fromEntries(keys.map((k) => [k, b[k] ?? null]));
  const newValues = Object.fromEntries(keys.map((k) => [k, a[k] ?? null]));
  if (keys.length === 1 && keys[0] === visibilityField) {
    return { action: visibilityAction(visibilityField, a[visibilityField]), entityName, entityId: after.id, oldValues, newValues };
  }
  return { action: "CMS_UPDATE", entityName, entityId: after.id, oldValues, newValues };
}

function visibilityAction(field: string, value: unknown): string {
  if (field === "isPublished") return value ? "CMS_PUBLISH" : "CMS_UNPUBLISH";
  if (field === "status") return "CMS_STATUS_CHANGE";
  return value ? "CMS_ACTIVATE" : "CMS_DEACTIVATE";
}

function pick(o: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Singleton page/config slugs an Admin may edit through PUT /admin/cms/content/:slug. */
export const EDITABLE_PAGE_SLUGS = [
  "homepage",
  "about_us",
  "contact_info",
  "header_footer",
  "seo",
  "social_links",
  "hiring_partners_marquee",
  "college_partnerships_page",
  "corporate_training_page",
] as const;

export const isEditablePageSlug = (slug: string): boolean =>
  (EDITABLE_PAGE_SLUGS as readonly string[]).includes(slug) && !Object.values(CMS_COLLECTIONS).some((c) => c.slug === slug);
