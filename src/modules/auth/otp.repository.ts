import type { EntityId, IsoDateTime } from "../../contracts/identifier.contract";
import type { CreateOtpChallengeInput, OtpChallenge, OtpPurpose } from "./otp.types";

/**
 * The `otpChallenges` repository PORT.
 *
 * An interface only - no SQL, no driver, no MS SQL Server concept - so the
 * same port is satisfied by an mssql adapter or the in-memory fake the tests
 * use. Follows the conventions in `docs/database-handoff.md` section 9:
 * single reads return `null` when absent, writes against a missing id throw
 * `RecordNotFoundError`, and adapters never leak driver errors.
 *
 * WHAT THIS PORT DELIBERATELY DOES NOT EXPOSE:
 *
 *  - No "find by code" lookup. Verification reads the ACTIVE challenge for a
 *    user and compares hashes in the service. A query keyed by the code
 *    would need the plaintext at the database boundary, which is exactly
 *    what must never happen, and would make a timing-safe comparison
 *    impossible.
 *  - No delete. A spent challenge is marked consumed, not removed, so the
 *    attempt history survives for audit. Expired rows are a retention
 *    concern for the database team (see `purgeExpiredBefore`).
 */
export interface OtpChallengeRepository {
  /** Stores a new challenge. `attempts` starts at 0, `consumedAt` unset. */
  create(input: CreateOtpChallengeInput): Promise<OtpChallenge>;

  /**
   * The one challenge a verification should be checked against: the newest
   * unconsumed challenge for this user and purpose, expired or not.
   *
   * EXPIRED ROWS ARE RETURNED ON PURPOSE. The service must be able to tell
   * "your code has expired" apart from "you have no code", because the two
   * need different user actions - request a new one versus start again. A
   * repository that filtered by expiry would collapse that distinction.
   *
   * Returns `null` when the user has no unconsumed challenge at all.
   */
  findActiveByUser(userId: EntityId, purpose: OtpPurpose): Promise<OtpChallenge | null>;

  /**
   * Records one failed verification attempt and returns the updated row.
   *
   * MUST be atomic (a single `UPDATE ... SET attempts = attempts + 1`), not
   * a read-modify-write: two concurrent guesses that each read `attempts: 4`
   * and both write `5` would hand an attacker an extra try. The returned
   * `attempts` is what the service enforces its ceiling against, so it has
   * to be the post-increment value the database actually committed.
   */
  incrementAttempts(id: EntityId): Promise<OtpChallenge>;

  /**
   * Marks the challenge consumed, so it can never verify again.
   *
   * MUST be conditional on the row not already being consumed, and the
   * adapter must report whether IT performed the write:
   *   - `true`  - this call consumed the challenge; the caller may proceed.
   *   - `false` - it was already consumed by a concurrent request; the
   *               caller must NOT treat its verification as successful.
   *
   * That boolean is the whole concurrency control for one-time use. With a
   * plain unconditional update, two requests presenting the same valid code
   * would both succeed. In SQL Server this is
   * `UPDATE ... SET consumedAt = @now WHERE id = @id AND consumedAt IS NULL`
   * returning `@@ROWCOUNT`.
   */
  consume(id: EntityId, consumedAt: IsoDateTime): Promise<boolean>;

  /**
   * How many challenges were issued to this user for this purpose since the
   * given instant. Backs the resend window limit.
   *
   * Counts EVERY issued challenge, including consumed and expired ones: the
   * control exists to stop a mailbox being flooded, and a delivered message
   * costs the same whether or not its code was ever used.
   */
  countIssuedSince(
    userId: EntityId,
    purpose: OtpPurpose,
    since: IsoDateTime,
  ): Promise<number>;

  /**
   * The newest challenge for this user and purpose regardless of state,
   * used to enforce the resend COOLDOWN.
   *
   * Distinct from `findActiveByUser`: after a successful verification the
   * latest challenge is consumed, and a cooldown must still be honoured
   * against it.
   */
  findLatestByUser(userId: EntityId, purpose: OtpPurpose): Promise<OtpChallenge | null>;

  /**
   * Deletes challenges that expired before the given instant, returning the
   * number removed.
   *
   * Hygiene, not correctness - nothing in the flow depends on it. Exposed so
   * retention is an explicit, reviewable operation rather than an
   * undocumented SQL Agent job. Retention period is a database-team
   * decision; see handoff Q22 on audit retention.
   */
  purgeExpiredBefore(instant: IsoDateTime): Promise<number>;
}
