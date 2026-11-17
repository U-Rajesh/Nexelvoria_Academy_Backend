import type { PaginatedResult, PaginationQuery } from "../../contracts/api.contract";
import type { EntityId } from "../../contracts/identifier.contract";
import type { UserStatus } from "../../contracts/user.contract";
import type {
  CreateUserInput,
  UpdateUserInput,
  User,
  UserFilter,
} from "./user.types";

/**
 * The `users` repository PORT.
 *
 * An interface only. It contains no SQL, no driver import and no MS SQL
 * Server concept, so the same port can be satisfied by raw mssql, an ORM,
 * or the in-memory fake the tests use.
 *
 * Conventions every adapter must follow:
 *  - Single reads return `null` when the record is absent.
 *  - Writes against a missing id throw `RecordNotFoundError`.
 *  - Uniqueness violations throw `DuplicateRecordError`, never a driver error.
 *  - Email lookups are case-insensitive, and the adapter is responsible for
 *    that regardless of the server collation (see handoff Q "collation").
 *
 * This port does NOT expose passwords, tokens or OTPs. Credential storage
 * is part of authentication, which is not designed yet (open-questions
 * Q3/Q13), so adding it now would be guessing.
 */
export interface UserRepository {
  /** Returns the user, or null when no user has that id. */
  findById(id: EntityId): Promise<User | null>;

  /** Case-insensitive email lookup. Used for login and duplicate checks. */
  findByEmail(email: string): Promise<User | null>;

  /** Mobile lookup. The frontend allows login by email OR mobile. */
  findByMobile(mobile: string): Promise<User | null>;

  /** Cheap existence check for registration conflicts (409). */
  existsByEmail(email: string): Promise<boolean>;

  /** Cheap existence check for registration conflicts (409). */
  existsByMobile(mobile: string): Promise<boolean>;

  /** Paginated, filtered list for the admin user surfaces. */
  findMany(filter: UserFilter, pagination: PaginationQuery): Promise<PaginatedResult<User>>;

  /** Creates a user. Throws DuplicateRecordError on email/mobile conflict. */
  create(input: CreateUserInput): Promise<User>;

  /** Patches mutable fields. Throws RecordNotFoundError when absent. */
  update(id: EntityId, input: UpdateUserInput): Promise<User>;

  /**
   * Changes account status. Separate from `update` because it is an
   * audited administrative action, not an ordinary profile edit.
   */
  setStatus(id: EntityId, status: UserStatus): Promise<User>;
}
