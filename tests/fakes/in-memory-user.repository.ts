import type { PaginatedResult, PaginationQuery } from "../../src/contracts/api.contract";
import type { EntityId } from "../../src/contracts/identifier.contract";
import type { UserStatus } from "../../src/contracts/user.contract";
import type { UserRepository } from "../../src/modules/users/user.repository";
import type {
  CreateUserInput,
  UpdateUserInput,
  User,
  UserFilter,
} from "../../src/modules/users/user.types";
import { DuplicateRecordError } from "../../src/repositories/repository.errors";
import {
  InMemoryStore,
  containsIgnoreCase,
  equalsIgnoreCase,
  paginate,
} from "./in-memory-store";

/** TEST-ONLY in-memory `UserRepository`. See in-memory-store.ts. */
export class InMemoryUserRepository implements UserRepository {
  private readonly store = new InMemoryStore<User>("user");

  reset(): void {
    this.store.reset();
  }

  seed(user: User): User {
    return this.store.set(user);
  }

  get count(): number {
    return this.store.size;
  }

  async findById(id: EntityId): Promise<User | null> {
    return this.store.get(id);
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.store.find((u) => equalsIgnoreCase(u.email, email));
  }

  async findByMobile(mobile: string): Promise<User | null> {
    return this.store.find((u) => u.mobile === mobile);
  }

  async existsByEmail(email: string): Promise<boolean> {
    return (await this.findByEmail(email)) !== null;
  }

  async existsByMobile(mobile: string): Promise<boolean> {
    return (await this.findByMobile(mobile)) !== null;
  }

  async findMany(filter: UserFilter, pagination: PaginationQuery): Promise<PaginatedResult<User>> {
    const rows = this.store.filter((user) => {
      if (filter.role !== undefined && user.role !== filter.role) return false;
      if (filter.status !== undefined && user.status !== filter.status) return false;

      if (filter.search !== undefined) {
        const term = filter.search;
        const matches =
          containsIgnoreCase(user.name, term) ||
          containsIgnoreCase(user.email, term) ||
          containsIgnoreCase(user.mobile, term);

        if (!matches) return false;
      }

      return true;
    });

    return paginate(rows, pagination);
  }

  async create(input: CreateUserInput): Promise<User> {
    if (await this.existsByEmail(input.email)) {
      throw new DuplicateRecordError("user", "email", input.email);
    }

    if (await this.existsByMobile(input.mobile)) {
      throw new DuplicateRecordError("user", "mobile", input.mobile);
    }

    return this.store.set({
      ...input,
      id: this.store.nextId(),
      createdAt: new Date().toISOString(),
    });
  }

  async update(id: EntityId, input: UpdateUserInput): Promise<User> {
    const existing = this.store.getOrThrow(id);
    return this.store.set({ ...existing, ...input });
  }

  async setStatus(id: EntityId, status: UserStatus): Promise<User> {
    const existing = this.store.getOrThrow(id);
    return this.store.set({ ...existing, status });
  }
}
