import type { EntityId, IsoDateTime } from "../../src/contracts/identifier.contract";
import type { OtpChallengeRepository } from "../../src/modules/auth/otp.repository";
import type {
  CreateOtpChallengeInput,
  OtpChallenge,
  OtpPurpose,
} from "../../src/modules/auth/otp.types";
import { InMemoryStore } from "./in-memory-store";

/**
 * TEST-ONLY in-memory `OtpChallengeRepository`.
 *
 * See `in-memory-store.ts` for the three guards that keep the fakes out of
 * production. This one honours the ATOMICITY CONTRACTS the port declares,
 * because the service's correctness depends on them:
 *
 *  - `incrementAttempts` increments the stored row rather than writing a
 *    value the caller computed.
 *  - `consume` is conditional on `consumedAt` being unset and reports
 *    whether this call did the write.
 *
 * A fake that ignored those would let the one-time-use and attempt-ceiling
 * tests pass here and fail against SQL Server, which is the one thing a fake
 * must never do.
 */
export class InMemoryOtpChallengeRepository implements OtpChallengeRepository {
  private readonly store = new InMemoryStore<OtpChallenge>("otp");

  /** Challenges in insertion order. For assertions. */
  all(): OtpChallenge[] {
    return this.store.all();
  }

  reset(): void {
    this.store.reset();
  }

  /**
   * Seeds a challenge directly, bypassing the service.
   *
   * Lets a test construct states that are awkward to reach through `issue`,
   * such as an already-expired challenge or one at its attempt ceiling.
   */
  seed(challenge: Omit<OtpChallenge, "id"> & { id?: EntityId }): OtpChallenge {
    const id = challenge.id ?? this.store.nextId();

    return this.store.set({ ...challenge, id });
  }

  async create(input: CreateOtpChallengeInput): Promise<OtpChallenge> {
    return this.store.set({
      id: this.store.nextId(),
      userId: input.userId,
      purpose: input.purpose,
      codeHash: input.codeHash,
      destination: input.destination,
      expiresAt: input.expiresAt,
      attempts: 0,
      // Stored as given, never defaulted here - the service owns this clock
      // (see CreateOtpChallengeInput). A real adapter must do the same.
      createdAt: input.createdAt,
    });
  }

  /**
   * Newest UNCONSUMED challenge for the pair, expired ones included - the
   * service needs to distinguish "expired" from "none".
   *
   * "Newest" is resolved by insertion order rather than `createdAt`, because
   * tests seed several challenges inside the same millisecond and a
   * timestamp comparison would be a coin toss. A real adapter orders by
   * `createdAt DESC, id DESC` for the same reason.
   */
  async findActiveByUser(
    userId: EntityId,
    purpose: OtpPurpose,
  ): Promise<OtpChallenge | null> {
    const matches = this.store.filter(
      (row) =>
        row.userId === userId && row.purpose === purpose && row.consumedAt === undefined,
    );

    return matches.length === 0 ? null : (matches[matches.length - 1] ?? null);
  }

  async findLatestByUser(
    userId: EntityId,
    purpose: OtpPurpose,
  ): Promise<OtpChallenge | null> {
    const matches = this.store.filter(
      (row) => row.userId === userId && row.purpose === purpose,
    );

    return matches.length === 0 ? null : (matches[matches.length - 1] ?? null);
  }

  /** Atomic in effect: reads and writes without yielding to the event loop. */
  async incrementAttempts(id: EntityId): Promise<OtpChallenge> {
    const existing = this.store.getOrThrow(id);

    return this.store.set({ ...existing, attempts: existing.attempts + 1 });
  }

  /** Conditional write. Returns false when already consumed. */
  async consume(id: EntityId, consumedAt: IsoDateTime): Promise<boolean> {
    const existing = this.store.getOrThrow(id);

    if (existing.consumedAt !== undefined) {
      return false;
    }

    this.store.set({ ...existing, consumedAt });

    return true;
  }

  async countIssuedSince(
    userId: EntityId,
    purpose: OtpPurpose,
    since: IsoDateTime,
  ): Promise<number> {
    const threshold = new Date(since).getTime();

    return this.store.filter(
      (row) =>
        row.userId === userId &&
        row.purpose === purpose &&
        new Date(row.createdAt).getTime() >= threshold,
    ).length;
  }

  async purgeExpiredBefore(instant: IsoDateTime): Promise<number> {
    const threshold = new Date(instant).getTime();
    const doomed = this.store.filter(
      (row) => new Date(row.expiresAt).getTime() < threshold,
    );

    for (const row of doomed) {
      this.store.delete(row.id);
    }

    return doomed.length;
  }
}
