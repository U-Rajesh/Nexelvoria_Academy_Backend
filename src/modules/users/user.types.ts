import type { EntityId, IsoDateTime } from "../../contracts/identifier.contract";
import type { UserRole, UserStatus } from "../../contracts/user.contract";

/**
 * The `users` domain: identity common to every person in the system.
 *
 * CONFIRMED - every field below is copied from the frontend's
 * `src/types/user.types.ts` (`User`). Nothing here is invented, and no
 * database column, key or table is implied: how this is stored is the
 * database team's decision (see docs/database-handoff.md).
 *
 * Student, teacher, admin and super-admin records all extend this shape in
 * the frontend. Whether that becomes one table or several is explicitly an
 * open question for the database team, not something these types decide.
 */
export interface User {
  id: EntityId;
  name: string;
  email: string;
  mobile: string;
  role: UserRole;
  status: UserStatus;
  avatarUrl?: string;
  createdAt: IsoDateTime;
}

/** Filters the user list endpoints need. Derived from the API contracts. */
export interface UserFilter {
  role?: UserRole;
  status?: UserStatus;
  /** Free-text across name, email and mobile. */
  search?: string;
}

/**
 * Fields required to create a user.
 *
 * `id` and `createdAt` are omitted because the persistence layer owns
 * them - a service must never invent an id.
 */
export type CreateUserInput = Omit<User, "id" | "createdAt">;

/** Mutable user fields. Role and status have their own explicit operations. */
export type UpdateUserInput = Partial<Pick<User, "name" | "mobile" | "avatarUrl">>;
