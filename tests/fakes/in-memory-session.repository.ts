import type { EntityId, IsoDateTime } from "../../src/contracts/identifier.contract";
import type { SessionRepository } from "../../src/modules/auth/session.repository";
import type {
  ConsumedRefreshToken,
  CreateSessionInput,
  ListSessionsOptions,
  RefreshTokenLookup,
  RevokeAllForUserInput,
  RevokeSessionFamilyInput,
  RevokeSessionInput,
  RotateRefreshTokenInput,
  Session,
} from "../../src/modules/auth/session.types";
import { getSessionStatus, isSessionUsable } from "../../src/modules/auth/session.types";
import { SessionNotActiveError } from "../../src/modules/auth/session.errors";
import {
  OptimisticLockError,
  RecordNotFoundError,
} from "../../src/repositories/repository.errors";
import { InMemoryStore } from "./in-memory-store";

/**
 * TEST-ONLY in-memory `SessionRepository`.
 *
 * NOT a session store for production. Sessions here live in a Map in one
 * process: they vanish on restart and are invisible to any other instance,
 * which is exactly the opposite of what revocation requires. The guards that
 * keep it out of production are described in `in-memory-store.ts`; the
 * decisive one is that `tests/` is outside the build's `include`, so this
 * file is never emitted to `dist/`.
 *
 * Implementing the port with `implements` is itself a check: if the
 * interface gains a method, this stops compiling.
 */
export class InMemorySessionRepository implements SessionRepository {
  /** `Session` is keyed by `sessionId`, so it is adapted to the store's `id`. */
  private readonly store = new InMemoryStore<Session & { id: EntityId }>("session");

  /**
   * Refresh-token verifiers that have been rotated away, keyed by hash.
   *
   * Separate from the session rows because its lifetime and volume are
   * different: one session accumulates thousands of consumed hashes. A real
   * adapter would make this its own table.
   */
  private readonly consumed = new Map<string, ConsumedRefreshToken>();

  // --- test helpers ------------------------------------------------------

  reset(): void {
    this.store.reset();
    this.consumed.clear();
  }

  /** Number of retained consumed-token records. Test visibility only. */
  get consumedCount(): number {
    return this.consumed.size;
  }

  /** Inserts a fully formed session, bypassing create(). */
  seed(session: Session): Session {
    return this.strip(this.store.set({ ...session, id: session.sessionId }));
  }

  get count(): number {
    return this.store.size;
  }

  /** Drops the internal `id` mirror so callers see a clean `Session`. */
  private strip(row: Session & { id: EntityId }): Session {
    const { id: _id, ...session } = row;
    void _id;
    return session;
  }

  private save(session: Session): Session {
    return this.strip(this.store.set({ ...session, id: session.sessionId }));
  }

  private read(sessionId: EntityId): (Session & { id: EntityId }) | null {
    return this.store.get(sessionId);
  }

  // --- reads -------------------------------------------------------------

  async findBySessionId(sessionId: EntityId): Promise<Session | null> {
    const row = this.read(sessionId);

    // Returns revoked and expired rows too - see the port's read-state
    // convention. null means strictly "no such session".
    return row === null ? null : this.strip(row);
  }

  async findByRefreshTokenHash(refreshTokenHash: string): Promise<Session | null> {
    if (refreshTokenHash === "") {
      return null;
    }

    const row = this.store.find((s) => s.refreshTokenHash === refreshTokenHash);

    // Deliberately finds revoked rows: that is how a reused (already
    // rotated) refresh token is recognised rather than looking unknown.
    return row === null ? null : this.strip(row);
  }

  async resolveRefreshToken(refreshTokenHash: string): Promise<RefreshTokenLookup> {
    if (refreshTokenHash === "") {
      return { status: "unknown" };
    }

    const current = await this.findByRefreshTokenHash(refreshTokenHash);

    if (current !== null) {
      return { status: "active", session: current };
    }

    const consumed = this.consumed.get(refreshTokenHash);

    if (consumed !== undefined) {
      // Rotated away. Never usable again - it is returned only so the
      // caller can recognise the replay and revoke the family.
      return { status: "consumed", consumed: { ...consumed } };
    }

    return { status: "unknown" };
  }

  async listSessionsForUser(
    userId: EntityId,
    options: ListSessionsOptions = {},
  ): Promise<Session[]> {
    const now = new Date();

    return this.store
      .filter((session) => {
        if (session.userId !== userId) {
          return false;
        }

        const revoked = session.revokedAt !== undefined;
        const expired = !revoked && !isSessionUsable(session, now);

        if (revoked && options.includeRevoked !== true) return false;
        if (expired && options.includeExpired !== true) return false;

        return true;
      })
      .map((row) => this.strip(row))
      .sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt));
  }

  // --- writes ------------------------------------------------------------

  async create(input: CreateSessionInput): Promise<Session> {
    const sessionId = this.store.nextId();
    const now = new Date().toISOString();

    const session: Session = {
      sessionId,
      userId: input.userId,
      refreshTokenHash: input.refreshTokenHash,
      // A fresh login starts its own family.
      familyId: input.familyId ?? sessionId,
      createdAt: now,
      lastActiveAt: now,
      expiresAt: input.expiresAt,
      ...(input.device === undefined ? {} : { device: input.device }),
      ...(input.browser === undefined ? {} : { browser: input.browser }),
      ...(input.os === undefined ? {} : { os: input.os }),
      ...(input.ipAddress === undefined ? {} : { ipAddress: input.ipAddress }),
      ...(input.location === undefined ? {} : { location: input.location }),
    };

    return this.save(session);
  }

  async rotateRefreshToken(input: RotateRefreshTokenInput): Promise<Session> {
    const row = this.read(input.sessionId);

    if (row === null) {
      throw new RecordNotFoundError("session", input.sessionId);
    }

    const session = this.strip(row);

    // Checked BEFORE any write, so rotation can never reactivate a dead
    // session: without this, a future `expiresAt` would silently resurrect
    // an expired one, and a revoked one would have its expiry extended.
    const status = getSessionStatus(session);

    if (status !== "active") {
      throw new SessionNotActiveError(input.sessionId, status, session.revocationReason);
    }

    // Compare-and-set. A real adapter does this in one conditional UPDATE
    // inside a transaction with the consumed-token insert; here the
    // single-threaded Map makes check-then-write equivalent.
    if (session.refreshTokenHash !== input.expectedCurrentHash) {
      throw new OptimisticLockError("session", input.sessionId);
    }

    // Record the hash being retired BEFORE replacing it, so a replay of the
    // old token is recognisable rather than looking unknown.
    this.consumed.set(session.refreshTokenHash, {
      refreshTokenHash: session.refreshTokenHash,
      sessionId: session.sessionId,
      familyId: session.familyId,
      userId: session.userId,
      consumedAt: new Date().toISOString(),
      // Retain only as long as the retired token could otherwise have been
      // presented; past its own expiry it would be rejected anyway.
      purgeAfter: session.expiresAt,
    });

    return this.save({
      ...session,
      refreshTokenHash: input.newRefreshTokenHash,
      lastActiveAt: new Date().toISOString(),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    });
  }

  async purgeConsumedRefreshTokens(before: string): Promise<number> {
    const cutoff = Date.parse(before);
    let removed = 0;

    for (const [hash, record] of this.consumed) {
      if (Date.parse(record.purgeAfter) <= cutoff) {
        this.consumed.delete(hash);
        removed += 1;
      }
    }

    return removed;
  }

  async updateLastActiveAt(sessionId: EntityId, lastActiveAt: IsoDateTime): Promise<void> {
    const row = this.read(sessionId);

    // Best-effort: unknown, revoked and expired sessions are silently
    // skipped, because this is an informational timestamp and not an
    // authorization decision - it must never fail a request.
    if (row === null || !isSessionUsable(this.strip(row))) {
      return;
    }

    this.save({ ...this.strip(row), lastActiveAt });
  }

  async revokeSession(input: RevokeSessionInput): Promise<Session> {
    const row = this.read(input.sessionId);

    // Cross-user isolation: the row must match BOTH ids. A session id
    // belonging to another user is indistinguishable from one that does not
    // exist, so nothing is leaked either.
    if (row === null || row.userId !== input.userId) {
      throw new RecordNotFoundError("session", input.sessionId);
    }

    const session = this.strip(row);

    // Idempotent, and the FIRST reason wins: a later logout must not
    // overwrite token_reuse_detected, which is the security-relevant fact.
    if (session.revokedAt !== undefined) {
      return session;
    }

    return this.save({
      ...session,
      revokedAt: new Date().toISOString(),
      revocationReason: input.reason,
    });
  }

  async revokeAllForUser(input: RevokeAllForUserInput): Promise<number> {
    const targets = this.store.filter(
      (session) =>
        session.userId === input.userId &&
        session.revokedAt === undefined &&
        session.sessionId !== input.exceptSessionId,
    );

    const revokedAt = new Date().toISOString();

    for (const row of targets) {
      this.save({ ...this.strip(row), revokedAt, revocationReason: input.reason });
    }

    // Counts only sessions this call newly revoked.
    return targets.length;
  }

  async revokeSessionFamily(input: RevokeSessionFamilyInput): Promise<number> {
    const targets = this.store.filter(
      (session) => session.familyId === input.familyId && session.revokedAt === undefined,
    );

    const revokedAt = new Date().toISOString();

    for (const row of targets) {
      this.save({ ...this.strip(row), revokedAt, revocationReason: input.reason });
    }

    return targets.length;
  }
}
