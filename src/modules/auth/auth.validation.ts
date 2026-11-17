import { z } from "zod";

/**
 * Validation schemas for the auth module.
 *
 * Step 6B adds the password policy only. Login, registration, OTP and reset
 * schemas arrive with their own steps.
 *
 * The password rules below MIRROR the frontend's `src/utils/validators.ts`
 * exactly - same thresholds, same messages - so a rejection reads the same
 * whether it came from the browser or the API. The frontend rules are a
 * convenience for the user; THESE are the control. A client can always skip
 * its own validation, so the backend never trusts that it ran.
 */

/**
 * Upper bound on password length.
 *
 * NOT a frontend rule - the frontend sets no maximum. It is a denial-of-service
 * guard: argon2 hashes whatever it is given, so an unbounded password lets one
 * request burn arbitrary CPU and memory. 128 characters is far above any real
 * passphrase while keeping the work bounded.
 *
 * Consequence to be aware of: a password longer than this is rejected by the
 * API even though the browser form would accept it. Flagged for the backend
 * lead; raise the number if that is not wanted.
 */
export const PASSWORD_MAX_LENGTH = 128;

/** Minimum length. Confirmed: frontend `z.string().min(8, ...)`. */
export const PASSWORD_MIN_LENGTH = 8;

/**
 * The password policy, as a zod schema.
 *
 * Every rule is confirmed against the frontend:
 *   min(8)            -> "Password must be at least 8 characters"
 *   /[A-Z]/           -> "Must contain at least one uppercase letter"
 *   /[a-z]/           -> "Must contain at least one lowercase letter"
 *   /[0-9]/           -> "Must contain at least one number"
 *   /[^A-Za-z0-9]/    -> "Must contain at least one special character"
 *
 * zod collects every failing check on a string rather than stopping at the
 * first, so a weak password reports all of its problems in one 422 - which is
 * what the frontend's strength indicator shows the user anyway.
 */
export const passwordPolicySchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`)
  .regex(/[A-Z]/, "Must contain at least one uppercase letter")
  .regex(/[a-z]/, "Must contain at least one lowercase letter")
  .regex(/[0-9]/, "Must contain at least one number")
  .regex(/[^A-Za-z0-9]/, "Must contain at least one special character");

/** A password that has passed the policy. */
export type PolicyCompliantPassword = z.infer<typeof passwordPolicySchema>;

/**
 * Indian mobile number, exactly as the frontend's registration schema
 * defines it: 10 digits beginning 6-9.
 *
 * Used to decide whether a login identifier is a mobile number or an email,
 * so the two must agree or a user who registered with a number could not log
 * in with it.
 */
export const MOBILE_PATTERN = /^[6-9]\d{9}$/;

/**
 * Login input.
 *
 * Mirrors the frontend's `loginSchema` in `src/utils/validators.ts`:
 * one identifier field accepting an email OR a 10-digit mobile number, a
 * password, and an optional "remember me".
 *
 * NOTE THE PASSWORD RULE: `min(1)` only. The password POLICY
 * (`passwordPolicySchema`) must NEVER be applied at login. Two reasons:
 *
 *  1. A user whose password predates a policy tightening must still be able
 *     to sign in - otherwise raising the policy locks existing users out.
 *  2. Rejecting a login for "password too short" tells an attacker the
 *     policy and that their guess was structurally wrong, which is free
 *     information. Policy belongs where a password is SET.
 */
export const loginSchema = z.object({
  identifier: z
    .string()
    .trim()
    .min(3, "Enter your registered email or 10-digit mobile number")
    .max(254, "Identifier is too long"),
  password: z.string().min(1, "Password is required").max(PASSWORD_MAX_LENGTH),
  rememberMe: z.boolean().optional(),
});

/** Validated login input. */
export type LoginInput = z.infer<typeof loginSchema>;

/**
 * Student self-registration input.
 *
 * Mirrors the frontend's `studentRegistrationSchema` field for field,
 * including its thresholds and messages, so a rejection reads the same
 * whether it came from the browser or the API.
 *
 * NOTE WHAT IS NOT HERE: no `role`. Registration is for students only -
 * teachers, admins and super-admins are created by staff - so the role is
 * fixed by the service and a `role` in the payload is ignored rather than
 * honoured. See `registration.service.ts`.
 */
export const registrationSchema = z
  .object({
    name: z.string().trim().min(3, "Full legal name must be at least 3 characters"),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .email("Please enter a valid email address")
      .max(254, "Email address is too long"),
    mobile: z
      .string()
      .trim()
      .regex(MOBILE_PATTERN, "Enter a valid 10-digit Indian mobile number"),

    // The full policy applies here, unlike at login: this is where a
    // password is SET.
    password: passwordPolicySchema,
    confirmPassword: z.string().min(1, "Please confirm your password"),

    // --- Admissions data (confirmed required by the frontend) -----------
    collegeName: z.string().trim().min(2, "College or university name is required"),
    degreeBranch: z
      .string()
      .trim()
      .min(2, "Degree and branch are required (e.g. B.Tech CSE)"),
    passingYear: z
      .string()
      .trim()
      .regex(/^(201\d|202\d|2030)$/, "Enter a valid graduation year (e.g. 2024, 2025, 2026)"),
    courseInterestedIn: z.string().trim().min(1, "Please select your target course track"),
    dateOfBirth: z.string().trim().min(1, "Date of birth is required"),
    gender: z.enum(["male", "female", "other"]),
    fullAddress: z
      .string()
      .trim()
      .min(8, "Please enter your complete postal address (at least 8 characters)"),
    guardianContact: z
      .string()
      .trim()
      .regex(MOBILE_PATTERN, "Enter a valid 10-digit guardian mobile number"),

    linkedInUrl: z
      .string()
      .trim()
      .url("Enter a valid LinkedIn profile URL (https://...)")
      .or(z.literal(""))
      .optional(),
    githubUrl: z
      .string()
      .trim()
      .url("Enter a valid GitHub portfolio URL (https://...)")
      .or(z.literal(""))
      .optional(),

    resumeFileName: z.string().optional(),
    resumeFileSize: z.string().optional(),

    termsAccepted: z.boolean().refine((value) => value === true, {
      message: "You must accept the terms and conditions to proceed with registration.",
    }),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

/** Validated registration input. */
export type RegistrationInput = z.infer<typeof registrationSchema>;
