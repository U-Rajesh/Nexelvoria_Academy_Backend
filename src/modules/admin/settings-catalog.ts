/**
 * Institute settings catalog (CFG requirements). Every key lives in
 * NXA_InstituteSettings (SettingKey / SettingValue). A key is editable only
 * when saving it has a real effect or it is official institute information;
 * a key the application stores but never applies is listed as blocked with
 * the decision it waits on, and writes to it are refused instead of being
 * accepted and ignored.
 */
/**
 * applied: saving it has a real effect; profile: official institute
 * information; stored: an approved setting whose consumers are not available
 * yet (the note says which), saved and validated but changing nothing today;
 * blocked: writes are refused.
 */
export type SettingStatus = "applied" | "profile" | "stored" | "blocked";
export type SettingEditor = "admin" | "super_admin";

export interface SettingDefinition {
  key: string;
  label: string;
  group: "institute" | "academic" | "courses" | "payments" | "notifications" | "security" | "system";
  type: "text" | "email" | "phone" | "number" | "boolean";
  /** Inclusive range for number settings (approved floors, D1 / D7). */
  min?: number;
  max?: number;
  /** Value in force when the setting has never been saved. */
  defaultValue?: number | boolean;
  /** Lowest role that may change it (super admin may change everything an admin may). */
  editableBy: SettingEditor;
  status: SettingStatus;
  /** Where the value is used, or why it is blocked. */
  note: string;
}

export const SETTINGS_CATALOG: readonly SettingDefinition[] = [
  { key: "instituteName", label: "Institute name", group: "institute", type: "text", editableBy: "admin", status: "applied", note: "Printed on report exports (CSV, Excel, PDF)." },
  { key: "tagline", label: "Tagline", group: "institute", type: "text", editableBy: "admin", status: "profile", note: "Official institute profile." },
  { key: "supportEmail", label: "Support email", group: "institute", type: "email", editableBy: "admin", status: "profile", note: "Official institute profile. Public website contact details are edited in Website CMS > Contact." },
  { key: "supportPhone", label: "Support phone", group: "institute", type: "phone", editableBy: "admin", status: "profile", note: "Official institute profile." },
  { key: "whatsappNumber", label: "WhatsApp number", group: "institute", type: "phone", editableBy: "admin", status: "profile", note: "Contact number only; no WhatsApp messaging provider is configured." },
  { key: "address", label: "Address", group: "institute", type: "text", editableBy: "admin", status: "profile", note: "Official institute profile." },
  { key: "gstNumber", label: "GSTIN", group: "payments", type: "text", editableBy: "admin", status: "profile", note: "Validated GSTIN format. No GST rate or tax calculation rule is approved." },
  {
    key: "timezone",
    label: "Time zone",
    group: "system",
    type: "text",
    editableBy: "super_admin",
    status: "blocked",
    note: "Fixed to Asia/Kolkata: reporting periods and the financial year are computed in IST. Making it configurable waits on Q15 (time zone handling).",
  },
  {
    key: "minAttendancePercentage",
    label: "Minimum attendance %",
    group: "academic",
    type: "number",
    editableBy: "super_admin",
    status: "applied",
    min: 75,
    max: 100,
    defaultValue: 75,
    note: "Students below it are flagged in the attendance summary and the Attendance Summary report (D2 formula: Present ÷ marked sessions; Leave counts as not attended). BR-011's 75% is the floor: it can be raised, never lowered (D1).",
  },
  {
    key: "minExamPercentage",
    label: "Minimum examination score %",
    group: "academic",
    type: "number",
    editableBy: "super_admin",
    status: "stored",
    min: 60,
    max: 100,
    defaultValue: 60,
    note: "BR-011's 60% is the floor: it can be raised, never lowered (D1). Saved now; it takes effect with certificate eligibility and server-side test scoring, which are not available yet. A test's own pass mark still governs that test.",
  },
  {
    key: "defaultLessonSequentialUnlock",
    label: "New lessons unlock in sequence",
    group: "courses",
    type: "boolean",
    editableBy: "admin",
    status: "applied",
    defaultValue: false,
    note: "Starting value for lessons created after the change (D9). Existing lessons keep their own setting.",
  },
  {
    key: "defaultLessonDownloadAllowed",
    label: "New lessons allow downloads",
    group: "courses",
    type: "boolean",
    editableBy: "admin",
    status: "applied",
    defaultValue: false,
    note: "Starting value for lessons created after the change (D9). Existing lessons keep their own setting.",
  },
  {
    key: "maxFailedLoginAttempts",
    label: "Failed sign-ins before lockout",
    group: "security",
    type: "number",
    editableBy: "super_admin",
    status: "applied",
    min: 3,
    max: 10,
    defaultValue: 5,
    note: "An account locks when a failed sign-in brings its count to this number, and stays locked until a password reset or an Admin unlock (D7). Lowering it does not lock anyone retroactively.",
  },
  {
    key: "isSmsEnabled",
    label: "SMS enabled",
    group: "notifications",
    type: "boolean",
    editableBy: "super_admin",
    status: "blocked",
    note: "No SMS provider is configured; mobile OTP is deferred (CL-001).",
  },
  {
    key: "currencySymbol",
    label: "Currency symbol",
    group: "payments",
    type: "text",
    editableBy: "super_admin",
    status: "blocked",
    note: "Not applied: amounts are recorded and shown in INR. Waits on the currency rules for financial reporting.",
  },
  { key: "maintenanceMode", label: "Maintenance mode", group: "system", type: "boolean", editableBy: "super_admin", status: "applied", note: "When on, the API answers 503 to everyone except Super Admins; sign-in stays available." },
  { key: "maintenanceMessage", label: "Maintenance message", group: "system", type: "text", editableBy: "super_admin", status: "applied", note: "Shown to users while maintenance mode is on." },
];

export const BLOCKED_SETTING_KEYS = new Set(SETTINGS_CATALOG.filter((s) => s.status === "blocked").map((s) => s.key));

export const settingDefinition = (key: string): SettingDefinition | undefined => SETTINGS_CATALOG.find((s) => s.key === key);
