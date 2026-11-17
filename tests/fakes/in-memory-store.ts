import type { PaginatedResult, PaginationQuery } from "../../src/contracts/api.contract";
import { toPaginatedResult } from "../../src/contracts/api.contract";
import type { EntityId } from "../../src/contracts/identifier.contract";
import { RecordNotFoundError } from "../../src/repositories/repository.errors";

/**
 * Shared machinery for the in-memory repository fakes.
 *
 * ============================ TEST ONLY ============================
 * These fakes exist so services can be tested before the MS SQL Server
 * adapters exist. They are NOT a database and must never serve traffic.
 *
 * Three independent guards keep them out of production:
 *
 *  1. LOCATION - they live in `tests/`, which `tsconfig.json` does not
 *     include. `npm run build` compiles `src/` only, so these files are
 *     never emitted to `dist/` and cannot be imported by the built app.
 *     This is the real guarantee; the other two are defence in depth.
 *  2. WIRING - `createProductionContainer()` registers nothing. A fake
 *     only becomes reachable if a test passes it to `createContainer()`.
 *  3. RUNTIME - the constructor below throws if NODE_ENV=production.
 * ===================================================================
 */

/** Fails loudly if a fake is ever constructed in a production process. */
export const assertNotProduction = (name: string): void => {
  if (process.env["NODE_ENV"] === "production") {
    throw new Error(
      `${name} is a test-only in-memory fake and must never run in production. ` +
        "Register a real MS SQL Server adapter instead.",
    );
  }
};

/**
 * A tiny keyed store with deterministic ids.
 *
 * Shared by the five fakes to avoid writing the same Map handling five
 * times. Deliberately minimal - it is not an abstraction over the
 * repository ports, just a container the fakes happen to use.
 */
export class InMemoryStore<T extends { id: EntityId }> {
  private readonly rows = new Map<EntityId, T>();
  private sequence = 0;

  constructor(private readonly entityName: string) {
    assertNotProduction(`InMemoryStore(${entityName})`);
  }

  /**
   * Sequential, prefixed ids ("student-1", "student-2").
   *
   * Deterministic on purpose: a test can assert against a known id, which
   * a UUID would make impossible. Real ids are the database's business
   * (see handoff Q1).
   */
  nextId(): EntityId {
    this.sequence += 1;
    return `${this.entityName}-${this.sequence}`;
  }

  /**
   * Returns a deep-ish copy, so a caller mutating the returned object
   * cannot corrupt the store. A real database hands back a detached row
   * and the fake must behave the same, or tests would pass against the
   * fake and fail against SQL Server.
   */
  get(id: EntityId): T | null {
    const row = this.rows.get(id);
    return row === undefined ? null : structuredClone(row);
  }

  /** Like `get`, but throws for write paths against a missing record. */
  getOrThrow(id: EntityId): T {
    const row = this.get(id);

    if (row === null) {
      throw new RecordNotFoundError(this.entityName, id);
    }

    return row;
  }

  set(row: T): T {
    this.rows.set(row.id, structuredClone(row));
    return structuredClone(row);
  }

  delete(id: EntityId): void {
    if (!this.rows.has(id)) {
      throw new RecordNotFoundError(this.entityName, id);
    }

    this.rows.delete(id);
  }

  has(id: EntityId): boolean {
    return this.rows.has(id);
  }

  /** All rows, detached, in insertion order. */
  all(): T[] {
    return [...this.rows.values()].map((row) => structuredClone(row));
  }

  find(predicate: (row: T) => boolean): T | null {
    return this.all().find(predicate) ?? null;
  }

  filter(predicate: (row: T) => boolean): T[] {
    return this.all().filter(predicate);
  }

  get size(): number {
    return this.rows.size;
  }

  /** Clears every row and resets the id sequence. Used between tests. */
  reset(): void {
    this.rows.clear();
    this.sequence = 0;
  }
}

/** Applies a PaginationQuery to an in-memory array. */
export const paginate = <T>(rows: T[], pagination: PaginationQuery): PaginatedResult<T> => {
  const start = (pagination.page - 1) * pagination.pageSize;
  const page = rows.slice(start, start + pagination.pageSize);

  return toPaginatedResult(page, rows.length, pagination);
};

/** Case-insensitive comparison, matching how the adapters must treat email. */
export const equalsIgnoreCase = (a: string, b: string): boolean =>
  a.toLowerCase() === b.toLowerCase();

/** Case-insensitive "contains", for the fakes' `search` filters. */
export const containsIgnoreCase = (haystack: string, needle: string): boolean =>
  haystack.toLowerCase().includes(needle.toLowerCase());
