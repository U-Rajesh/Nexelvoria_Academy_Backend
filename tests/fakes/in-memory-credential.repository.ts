import type { EntityId } from "../../src/contracts/identifier.contract";
import type { CredentialRepository } from "../../src/modules/auth/credential.repository";
import type {
  ChangePasswordInput,
  ConditionalResetInput,
  ConditionalResetResult,
  CreateCredentialInput,
  CredentialLockoutState,
  CredentialRecord,
  RecordFailedAttemptInput,
  RehashPasswordInput,
  ResetPasswordInput,
} from "../../src/modules/auth/credential.types";
import { isCredentialLocked, toLockoutState } from "../../src/modules/auth/credential.types";
import {
  DuplicateRecordError,
  OptimisticLockError,
  RecordNotFoundError,
} from "../../src/repositories/repository.errors";
import { assertNotProduction } from "./in-memory-store";

/**
 * TEST-ONLY in-memory `CredentialRepository`.
 *
 * NOT a credential store. Hashes here live in a process-local Map and vanish
 * on restart. The guards that keep it out of production are described in
 * `in-memory-store.ts`; the decisive one is that `tests/` is outside the
 * build's `include`, so this file is never emitted to `dist/`.
 *
 * Keyed by `userId` directly rather than through `InMemoryStore`, because a
 * credential has no surrogate id of its own and the atomic mutations below
 * need their own handling.
 *
 * Implementing the port with `implements` is itself a check: if the
 * interface gains a method, this stops compiling.
 */
export class InMemoryCredentialRepository implements CredentialRepository {
  private readonly rows = new Map<EntityId, CredentialRecord>();

  constructor() {
    assertNotProduction("InMemoryCredentialRepository");
  }

  // --- test helpers ------------------------------------------------------

  reset(): void {
    this.rows.clear();
  }

  /** Inserts a fully formed record, bypassing create(). */
  seed(record: CredentialRecord): CredentialRecord {
    this.rows.set(record.userId, { ...record });
    return { ...record };
  }

  get count(): number {
    return this.rows.size;
  }

  /** Detached copy, as a real database row would be. */
  private read(userId: EntityId): CredentialRecord | null {
    const row = this.rows.get(userId);
    return row === undefined ? null : { ...row };
  }

  private readOrThrow(userId: EntityId): CredentialRecord {
    const row = this.read(userId);

    if (row === null) {
      throw new RecordNotFoundError("credential", userId);
    }

    return row;
  }

  private save(record: CredentialRecord): CredentialRecord {
    const stored: CredentialRecord = { ...record, updatedAt: new Date().toISOString() };
    this.rows.set(stored.userId, stored);
    return { ...stored };
  }

  /**
   * Compare-and-set guard shared by `changePassword` and `rehashPassword`.
   *
   * A real adapter performs this inside the same conditional UPDATE; the
   * single-threaded Map makes check-then-write equivalent here.
   */
  private readForCompareAndSet(userId: EntityId, expectedCurrentHash: string): CredentialRecord {
    const existing = this.readOrThrow(userId);

    if (existing.passwordHash !== expectedCurrentHash) {
      throw new OptimisticLockError("credential", userId);
    }

    return existing;
  }

  /** Strips the lockout fields. Used by the paths that clear a lockout. */
  private withoutLockout(
    record: CredentialRecord,
  ): Omit<CredentialRecord, "lockedUntil" | "lastFailedLoginAt"> {
    const { lockedUntil: _lockedUntil, lastFailedLoginAt: _last, ...rest } = record;
    void _lockedUntil;
    void _last;
    return rest;
  }

  // --- ordinary reads and writes ----------------------------------------

  async findByUserId(userId: EntityId): Promise<CredentialRecord | null> {
    return this.read(userId);
  }

  async create(input: CreateCredentialInput): Promise<CredentialRecord> {
    if (this.rows.has(input.userId)) {
      throw new DuplicateRecordError("credential", "userId", input.userId);
    }

    const now = new Date().toISOString();

    return this.save({
      userId: input.userId,
      passwordHash: input.passwordHash,
      passwordUpdatedAt: now,
      failedLoginAttempts: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  async resetFailedAttemptsIfAuthorized(
    input: ConditionalResetInput,
  ): Promise<ConditionalResetResult> {
    // Read the STORED object, not a copy, and evaluate the guard and the
    // write in one synchronous block with no await between them. That is
    // what models the single guarded UPDATE the port requires: a
    // check-then-await-then-write would reintroduce exactly the race this
    // operation exists to close.
    const existing = this.rows.get(input.userId);

    if (existing === undefined) {
      return { status: "not_found" };
    }

    if (isCredentialLocked(existing, input.threshold)) {
      // Nothing is written: the lockout survives, because a correct
      // password must never unlock an account.
      return { status: "locked", credential: { ...existing } };
    }

    if (!input.acceptableHashes.includes(existing.passwordHash)) {
      // The verification is stale; the counter is left alone.
      return { status: "password_changed" };
    }

    existing.failedLoginAttempts = 0;
    existing.updatedAt = new Date().toISOString();

    // `lockedUntil` is deliberately untouched - clearing a lockout is
    // `clearLockout`, an audited administrative action.
    return { status: "reset", credential: { ...existing } };
  }

  async clearLockout(userId: EntityId): Promise<CredentialRecord> {
    const existing = this.readOrThrow(userId);

    // Idempotent: unlocking an unlocked credential succeeds.
    return this.save({ ...this.withoutLockout(existing), failedLoginAttempts: 0 });
  }

  // --- the three password write paths ------------------------------------

  async changePassword(input: ChangePasswordInput): Promise<CredentialRecord> {
    const existing = this.readForCompareAndSet(input.userId, input.expectedCurrentHash);

    // Hash, timestamp, counter and lockout move as ONE unit.
    return this.save({
      ...this.withoutLockout(existing),
      passwordHash: input.newPasswordHash,
      passwordUpdatedAt: new Date().toISOString(),
      failedLoginAttempts: 0,
    });
  }

  async rehashPassword(input: RehashPasswordInput): Promise<CredentialRecord> {
    const existing = this.readForCompareAndSet(input.userId, input.expectedCurrentHash);

    // ONLY the hash changes. `passwordUpdatedAt` is untouched because the
    // password did not change - stamping it would corrupt password-age
    // reporting - and lockout state is untouched for the same reason.
    return this.save({ ...existing, passwordHash: input.newPasswordHash });
  }

  async resetPassword(input: ResetPasswordInput): Promise<CredentialRecord> {
    // No compare-and-set: the user cannot know their current hash. The
    // SERVICE must hold a single-use reset grant before calling this.
    const existing = this.readOrThrow(input.userId);

    return this.save({
      ...this.withoutLockout(existing),
      passwordHash: input.newPasswordHash,
      passwordUpdatedAt: new Date().toISOString(),
      failedLoginAttempts: 0,
    });
  }

  // --- atomic counter ----------------------------------------------------

  async recordFailedAttempt(input: RecordFailedAttemptInput): Promise<CredentialLockoutState> {
    const existing = this.rows.get(input.userId);

    if (existing === undefined) {
      throw new RecordNotFoundError("credential", input.userId);
    }

    const now = new Date();

    // Mutated in place, in one synchronous step, against the STORED object
    // rather than a copy. That is what makes this behave like the single
    // atomic UPDATE the port requires: concurrent callers cannot interleave
    // a read and a write and lose increments. Reading into a local, awaiting,
    // then writing back would silently defeat the lockout.
    existing.failedLoginAttempts += 1;
    existing.lastFailedLoginAt = now.toISOString();
    existing.updatedAt = now.toISOString();

    // Nothing sets `lockedUntil`. Lockout is counter-based and permanent
    // until an explicit unlock - see the policy note in credential.types.ts
    // and open question O4. Timed lockout was removed because it could never
    // actually expire while the counter stayed at the threshold.

    return toLockoutState(existing, input.threshold, now);
  }
}
