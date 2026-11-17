import type { PaginatedResult, PaginationQuery } from "../contracts/api.contract";
import type { EntityId } from "../contracts/identifier.contract";

/**
 * Repository PORTS - interfaces only, no database code.
 *
 * The database is owned by a separate team. These interfaces are the
 * contract we hand them: our services are written against these types,
 * and whatever they build (Prisma, Knex, raw SQL, an HTTP data service)
 * becomes an adapter that implements them.
 *
 * Rules:
 *  - Nothing in this folder may import a driver or ORM.
 *  - No SQL, no connection handling, no transactions API yet.
 *  - A module may define a narrower port in its own
 *    `module.repository.ts` and ignore this generic one if CRUD
 *    does not fit its access pattern. This base is a convenience,
 *    not a mandate.
 */

/**
 * `EntityId` now lives in contracts/identifier.contract.ts so that one
 * definition is shared by modules and repositories alike. Re-exported
 * here for convenience.
 */
export type { EntityId };

/** Fields the persistence layer owns; services never set them by hand. */
export interface Timestamps {
  createdAt: string;
  updatedAt: string;
}

/** Read-side operations. */
export interface ReadRepository<TEntity, TFilter = unknown> {
  findById(id: EntityId): Promise<TEntity | null>;
  findMany(filter: TFilter, pagination: PaginationQuery): Promise<PaginatedResult<TEntity>>;
  exists(id: EntityId): Promise<boolean>;
}

/** Write-side operations. `TCreate`/`TUpdate` are the module's own DTOs. */
export interface WriteRepository<TEntity, TCreate, TUpdate> {
  create(input: TCreate): Promise<TEntity>;
  update(id: EntityId, input: TUpdate): Promise<TEntity>;
  delete(id: EntityId): Promise<void>;
}

/** Convenience composition for plain CRUD modules. */
export interface CrudRepository<TEntity, TCreate, TUpdate, TFilter = unknown>
  extends ReadRepository<TEntity, TFilter>,
    WriteRepository<TEntity, TCreate, TUpdate> {}
