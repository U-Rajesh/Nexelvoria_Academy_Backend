import type { EntityId } from "../contracts/identifier.contract";

/**
 * Errors a repository adapter may throw.
 *
 * These are DOMAIN errors, deliberately free of HTTP concepts: a
 * repository must not know what a status code is. The service layer
 * catches these and maps them to an `ApiError`, which keeps the
 * persistence layer swappable and the HTTP mapping in one place.
 *
 * Mapping the service layer should apply:
 *   RecordNotFoundError  -> ApiError.notFound()   (404)
 *   DuplicateRecordError -> ApiError.conflict()   (409)
 *   OptimisticLockError  -> ApiError.conflict()   (409)
 */

/** Base type so a service can catch every repository failure at once. */
export abstract class RepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace(this, new.target);
  }
}

/**
 * A write targeted a record that does not exist.
 *
 * Convention, applied consistently by every adapter:
 *  - READS of a single record return `null` when absent. Absence is a
 *    normal result a caller must handle, not an exception.
 *  - WRITES (update/delete/state change) against a missing id throw this,
 *    because the caller asserted the record exists and was wrong.
 */
export class RecordNotFoundError extends RepositoryError {
  constructor(
    readonly entity: string,
    readonly id: EntityId,
  ) {
    super(`${entity} not found: ${id}`);
  }
}

/**
 * A write violated a uniqueness contract (e.g. duplicate email).
 *
 * Adapters must throw this rather than leaking a driver-specific error:
 * MS SQL Server reports a unique index violation as error 2601/2627, and
 * nothing above the adapter should ever have to know that.
 */
export class DuplicateRecordError extends RepositoryError {
  constructor(
    readonly entity: string,
    readonly field: string,
    readonly value: string,
  ) {
    super(`${entity} already exists with ${field}: ${value}`);
  }
}

/**
 * The write includes fields the store has no column for (a schema gap).
 *
 * Thrown instead of silently dropping the values, so a caller is never told a
 * change was saved when it was not.
 */
export class UnsupportedFieldsError extends RepositoryError {
  constructor(
    readonly entity: string,
    readonly fields: readonly string[],
  ) {
    super(`${entity} cannot store: ${fields.join(", ")}`);
  }
}

/**
 * A delete was refused because other records still reference the row
 * (SQL Server error 547, FK violation) - e.g. a lesson with student progress.
 */
export class RecordInUseError extends RepositoryError {
  constructor(
    readonly entity: string,
    readonly detail: string,
  ) {
    super(`${entity} is still referenced: ${detail}`);
  }
}

/**
 * A write lost an optimistic-concurrency check.
 *
 * Reserved for the aggregates identified in open-questions Q24 (course
 * curriculum, system config, CMS singletons) where two editors can
 * silently overwrite each other. Not used until that decision is made.
 */
export class OptimisticLockError extends RepositoryError {
  constructor(
    readonly entity: string,
    readonly id: EntityId,
  ) {
    super(`${entity} was modified by someone else: ${id}`);
  }
}
