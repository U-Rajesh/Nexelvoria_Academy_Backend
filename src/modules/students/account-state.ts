import type { AccountState, UserStatus } from "../../contracts/user.contract";
import type { AdminApprovalStatus } from "./student.types";

/**
 * Derives `AccountState` from the fields that are actually stored.
 *
 * ===========================================================================
 * WHY THIS IS DERIVED RATHER THAN STORED.
 *
 * `AccountState` is a view the frontend needs - it decides which screen a
 * student sees after signing in - but it is NOT an independent fact. Every
 * input to it is already persisted somewhere else: `User.status`,
 * `Student.isEmailVerified` and `Student.adminApprovalStatus`.
 *
 * Storing it as a fourth column would create a second source of truth that
 * can disagree with the first three. A student approved by an admin while a
 * stale `accountState` still said `pending_approval` would be shown the
 * wrong screen, and no amount of care at the write sites prevents that
 * permanently - it only postpones it.
 *
 * Deriving it also means `StudentRepository` needs NO new method. That was
 * a deliberate choice: the port is a shared interface, and adding
 * `setAccountState` would have changed the SQL adapter contract and the
 * database handoff document for a value the database does not need to keep.
 *
 * `Student.accountState` therefore stays optional in storage and is
 * populated by this function when a response is built.
 * ===========================================================================
 *
 * ===========================================================================
 * THE MAPPING IS NOW TOTAL for every stored combination.
 *
 * It was partial until `deactivated` was added to `ACCOUNT_STATES` at the
 * Student Login integration: before that, a deactivated account could only
 * be reported as `undefined`, so the admin badge was simply blank for those
 * students. Rather than map it to the nearest-looking value - showing
 * `suspended` for a deactivated account is a support incident - the union
 * gained the member it was missing.
 *
 * `undefined` therefore remains in the return type but is now unreachable
 * for the three facts below. It is kept so that adding a fourth
 * `AdminApprovalStatus` or `UserStatus` member surfaces as a visible gap
 * rather than a silently wrong state. `AccountState.locked` is still not
 * produced here: it belongs to lockout fields this function is not given.
 *
 * EMAIL ONLY. `isMobileVerified` is deliberately not an input: mobile OTP is
 * descoped (BR-014 disables SMS; see `otp.types.ts` on Q3), so requiring it
 * would leave every student stuck at `pending_verification` forever. If
 * mobile verification is ever implemented, add it to `VerificationFacts` and
 * to the `pending_verification` rule - and nowhere else.
 * ===========================================================================
 */

/** Everything the derivation is allowed to look at. */
export interface VerificationFacts {
  status: UserStatus;
  isEmailVerified: boolean;
  adminApprovalStatus: AdminApprovalStatus;
}

/**
 * The lifecycle state, or `undefined` when the stored facts do not describe
 * one of the six `AccountState` values.
 *
 * PRECEDENCE MATTERS and is tested. Read top to bottom:
 *
 *  1. `rejected`  - a rejection is a terminal decision by a human. It
 *     outranks everything, including verification: re-verifying an email
 *     must not quietly revive a rejected application.
 *  2. `suspended` - an active administrative action. It outranks approval
 *     for the same reason: suspending an approved student must take effect.
 *  3. `deactivated` - also an administrative action, and distinct from
 *     `suspended`: the two are different states in `UserStatus` and the UI
 *     shows different screens.
 *  4. `pending_verification` - nothing can progress until email is confirmed.
 *  5. `pending_approval` - verified, waiting on BR-002 admin approval.
 *  6. `approved` - an admin has approved the registration.
 *
 * `approved` does NOT require `status === "active"`, and that was a
 * correction. `AccountState` describes the REGISTRATION lifecycle, whereas
 * `UserStatus` describes whether the account may be used; BR-002 says
 * approval gates PAYMENT, and activation follows payment. Requiring
 * `active` here left an approved-but-not-yet-active student with no
 * nameable state at all, which is precisely the silence this function is
 * supposed to reserve for genuinely unmappable facts.
 */
export const deriveAccountState = (facts: VerificationFacts): AccountState | undefined => {
  if (facts.adminApprovalStatus === "rejected") {
    return "rejected";
  }

  if (facts.status === "suspended") {
    return "suspended";
  }

  if (facts.status === "deactivated") {
    return "deactivated";
  }

  if (!facts.isEmailVerified) {
    return "pending_verification";
  }

  if (facts.adminApprovalStatus === "pending") {
    return "pending_approval";
  }

  if (facts.adminApprovalStatus === "approved") {
    return "approved";
  }

  // Unreachable while AdminApprovalStatus has three members - every one is
  // handled above. Kept so adding a fourth is a visible `undefined` rather
  // than a silently wrong state.
  return undefined;
};
