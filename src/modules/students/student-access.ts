import type { EntityId } from "../../contracts/identifier.contract";
import type { UserStatus } from "../../contracts/user.contract";
import type { StudentRepository } from "./student.repository";
import type { AdminApprovalStatus } from "./student.types";

/**
 * What a signed-in STUDENT may do (requirement clarification CL-001, decisions
 * 6a and 6b). One function decides it, and sign-in, token refresh and every
 * authenticated request all use it, so they cannot disagree.
 *
 *  - "limited":  email verified, Admin approval pending. May sign in and use
 *                only explicitly allowlisted endpoints (own profile, approval
 *                status, enrollment list, payment history, notifications and
 *                support tickets). Everything else is refused.
 *  - "approved": email verified and approved by an Admin. Full student
 *                endpoints, still subject to each endpoint's own ownership,
 *                enrollment and eligibility checks (e.g. learning content
 *                needs an ACTIVE enrollment; placements need BR-013).
 *                Approval replaces the former separate account activation.
 *  - "blocked":  may not sign in or use any endpoint.
 */
export type StudentAccessTier = "limited" | "approved";

export type StudentBlockReason =
  /** Suspended or deactivated by staff - blocked regardless of approval. */
  | "suspended"
  | "deactivated"
  /** BR-001 (CL-001): the email OTP has not been verified. */
  | "email_unverified"
  /** Admin rejected the registration. */
  | "rejected"
  /** No student profile for this account, or an unknown state. Fail closed. */
  | "no_profile";

export type StudentAccessDecision =
  | { allowed: true; tier: StudentAccessTier }
  | { allowed: false; reason: StudentBlockReason };

export interface StudentAccessFacts {
  status: UserStatus;
  student: { adminApprovalStatus: AdminApprovalStatus; isEmailVerified: boolean } | null;
}

export const decideStudentAccess = (facts: StudentAccessFacts): StudentAccessDecision => {
  if (facts.status === "suspended") return { allowed: false, reason: "suspended" };
  if (facts.status === "deactivated") return { allowed: false, reason: "deactivated" };
  // Only the two statuses a student account can legitimately be in.
  if (facts.status !== "pending" && facts.status !== "active") return { allowed: false, reason: "no_profile" };
  if (facts.student === null) return { allowed: false, reason: "no_profile" };
  if (!facts.student.isEmailVerified) return { allowed: false, reason: "email_unverified" };

  switch (facts.student.adminApprovalStatus) {
    case "approved":
      return { allowed: true, tier: "approved" };
    case "pending":
      return { allowed: true, tier: "limited" };
    case "rejected":
      return { allowed: false, reason: "rejected" };
    default:
      return { allowed: false, reason: "no_profile" };
  }
};

/** Per-request resolver used by `authenticate` for student principals. */
export type StudentAccessResolver = (userId: EntityId) => Promise<StudentAccessDecision>;

/**
 * Builds the resolver from the student repository. The student record carries
 * the account status as well as approval and verification, so one read
 * answers the question.
 */
export const createStudentAccessResolver =
  (students: () => StudentRepository): StudentAccessResolver =>
  async (userId) => {
    const student = await students().findById(userId);
    if (student === null) return { allowed: false, reason: "no_profile" };
    return decideStudentAccess({
      status: student.status,
      student: { adminApprovalStatus: student.adminApprovalStatus, isEmailVerified: student.isEmailVerified },
    });
  };
