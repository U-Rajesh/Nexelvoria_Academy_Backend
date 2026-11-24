import type { EntityId, IsoDateTime } from "../../contracts/identifier.contract";

/**
 * One-time passcode challenges.
 *
 * ===========================================================================
 * EMAIL ONLY, BY DECISION - NOT BY OMISSION.
 *
 * open-questions **Q3** recorded a direct contradiction: BR-001 requires a
 * student to verify BOTH email and mobile, while BR-014 disables SMS at
 * launch. As specified, no student could ever finish registering.
 *
 * Resolved in favour of EMAIL ONLY: BR-014 stands, and the mobile number is
 * collected and stored but not verified by SMS. `Student.isMobileVerified`
 * therefore stays `false`, which is honest - nothing has verified it.
 *
 * `OtpPurpose` is still a closed SET rather than a single literal, and the
 * repository is keyed by it, so adding `"mobile_verification"` later is an
 * additive change: no stored row, index or signature has to change. That is
 * the whole reason the channel is modelled as data instead of being baked in.
 * ===========================================================================
 */

/**
 * What a challenge is for.
 *
 * A challenge issued for one purpose can never satisfy another - `verify`
 * matches on `(userId, purpose)` - so an email-verification code cannot be
 * replayed against, say, a future password reset.
 */
export const OTP_PURPOSES = [
  "email_verification",
  /** AUTH-006 forgot password: proves control of the account email before a reset. */
  "password_reset",
] as const;

export type OtpPurpose = (typeof OTP_PURPOSES)[number];

/**
 * A stored challenge.
 *
 * THE CODE ITSELF IS NOT IN THIS RECORD, and must never be added to it. Only
 * `codeHash` is persisted - see `hashOtpCode` in `otp.service.ts` for why a
 * keyed HMAC rather than a bare digest.
 */
export interface OtpChallenge {
  id: EntityId;
  userId: EntityId;
  purpose: OtpPurpose;

  /**
   * Keyed HMAC of the passcode. Safe to store; useless to an attacker who
   * holds the database but not the server's key.
   */
  codeHash: string;

  /**
   * Where the code was sent, recorded so a resend goes to the same place and
   * so an operator can audit delivery.
   *
   * SENSITIVE - it is a student's email address. Never log it in full; the
   * service logs only a masked form.
   */
  destination: string;

  /** After this instant the challenge is dead, verified or not. */
  expiresAt: IsoDateTime;

  /**
   * Failed verification attempts against THIS challenge.
   *
   * Counted on the row rather than per IP: the control protects one
   * account's code from being guessed, and an attacker rotating IPs must not
   * get a fresh allowance. 10^6 codes with a 5-attempt ceiling makes
   * guessing hopeless.
   */
  attempts: number;

  /**
   * Set once the code has been accepted. A consumed challenge is spent: it
   * can never verify again, which is what makes this one-TIME.
   */
  consumedAt?: IsoDateTime;

  createdAt: IsoDateTime;
}

/** What the service hands the repository to store a new challenge. */
export interface CreateOtpChallengeInput {
  userId: EntityId;
  purpose: OtpPurpose;
  codeHash: string;
  destination: string;
  expiresAt: IsoDateTime;

  /**
   * When the challenge was issued. SUPPLIED BY THE SERVICE, not defaulted by
   * the adapter.
   *
   * This is deliberate and load-bearing. The resend cooldown and the send
   * window are both measured from `createdAt`, while expiry is measured from
   * `expiresAt`. If the adapter stamped `createdAt` itself - say with
   * `GETUTCDATE()` - the two timestamps would come from DIFFERENT clocks,
   * and any skew between the database server and the application would make
   * the cooldown and the TTL disagree about when the challenge was issued.
   * One clock decides both.
   *
   * An adapter must therefore store this value as given and must NOT
   * substitute a database default.
   */
  createdAt: IsoDateTime;
}
