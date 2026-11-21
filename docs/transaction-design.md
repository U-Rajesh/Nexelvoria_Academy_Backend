# NEXELVORIA Academy — Transaction and Audit Design Proposal

**Status: PROPOSAL. Nothing here is implemented.**

Written at Phase 5 Stage 0, before any MS SQL Server adapter exists, so the
database team can react to a concrete shape rather than to an abstract
question. It answers open-questions **Q-X1** ("how should transactions be
expressed in the port?") and sets out how atomic approval and approval audit
history would work.

**No repository interface has been changed, and no schema is proposed.** The
approval audit table is approved *in principle* only; its columns wait on a
review of the database team's existing schema.

---

## 1. The problem, stated precisely

Three operations need to be atomic and currently are not.

| # | Operation | Writes | Today's failure mode |
| --- | --- | --- | --- |
| 1 | **Student registration** | user → credential → student profile | A failure after write 1 leaves an account that cannot log in and whose email and mobile are taken. The service reports `incomplete` / `profile_incomplete` and an operator must repair it |
| 2 | **Approval decision** | student row (+ audit record, once it exists) | `recordDecision` does read-then-write, so two admins deciding at once can both pass the `pending` check |
| 3 | **Email verification** | OTP challenge consume → student `isEmailVerified` | A failure between them spends the passcode without recording the verification. The student must request a new code |

Operation 1 is the one that blocks a production registration route. Operations
2 and 3 are narrower: both end in a recoverable state and neither corrupts
data, but both are avoidable.

`docs/database-handoff.md` §10 lists four more (attendance, payment →
enrolment, refund, curriculum replace) that are out of scope here.

---

## 2. Proposal for Q-X1 — a unit-of-work port

### 2.1 The shape

```ts
/** A transactional scope. Repositories resolved from it share one transaction. */
export interface UnitOfWork {
  readonly repositories: RepositoryRegistry;
}

export interface TransactionRunner {
  /**
   * Runs `work` inside one transaction.
   *
   * Commits when `work` returns. Rolls back if it throws, and rethrows.
   * The callback must use ONLY `uow.repositories` - a repository captured
   * from the container runs outside the transaction and silently defeats it.
   */
  withTransaction<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T>;
}
```

A service that needs atomicity takes `TransactionRunner` as a dependency, the
same way it takes repositories today:

```ts
export interface RegistrationServiceDeps {
  users: UserRepository;
  credentials: CredentialRepository;
  students: StudentRepository;
  /** Optional: when absent the service behaves exactly as it does now. */
  transactions?: TransactionRunner;
}
```

### 2.2 Why this shape rather than the alternatives

| Option | Verdict |
| --- | --- |
| **Unit-of-work callback** (above) | **Recommended.** Explicit — the transaction boundary is visible in the service, which is where the multi-entity business rule lives. Testable: the in-memory implementation runs the callback directly, so every existing unit test keeps working |
| **Coarse repository methods** (e.g. `registerStudentAtomically()`) | Rejected as the general answer. It pushes business sequencing into the adapter, so the rule exists twice — once in the service for the fakes, once in SQL. **Except** where a stored procedure already is that method: see §3 |
| **Ambient transaction via `AsyncLocalStorage`** | Rejected. Implicit, so whether a write is transactional depends on call-stack history rather than anything readable at the call site. Debugging a missing transaction becomes archaeology |

### 2.3 Why `transactions` is optional

Making it required would change every service constructor and every test in
one commit, for a capability that cannot be exercised until a database
exists. Optional means:

- today: absent, and the service runs exactly as it does now (946 tests
  unaffected);
- after Stage 1: supplied, and the same service becomes atomic.

The service's own code is a single branch:

```ts
const run = deps.transactions?.withTransaction ?? ((work) => work({ repositories: deps }));
```

**This is a deferred interface change, not an avoided one.** It must be
reviewed before Stage 2 begins.

### 2.4 Q-X2 — isolation level

Request: **`READ COMMITTED` with `READ_COMMITTED_SNAPSHOT ON`**. All three
operations above are short and key-addressed, so they need no stronger
guarantee; snapshot reads avoid readers blocking writers on the login and
verification hot paths. **To be confirmed by the database team**, since it is
a database-level setting with effects far beyond these three operations.

---

## 3. Atomic registration — the decision tree

Everything depends on one fact we do not have: **does
`dbo.USP_NXA_Register_Student` wrap all three inserts in one transaction?**

### Route A — the procedure is transactional

The whole transaction region in `registration.service.ts` collapses to a
single repository call. Consequences:

- `RegistrationFailureReason` values `incomplete` and `profile_incomplete`
  become **unreachable**. They stay in the type as documentation of the
  pre-SQL era, and their tests become assertions that they can no longer
  happen.
- The ordering rationale in the service header ("put the recoverable failure
  last") becomes moot.
- **No unit-of-work port is needed for registration.** It may still be needed
  for operations 2 and 3.
- The production route can be mounted as soon as the adapter passes
  conformance.

This is the better outcome, and it is why §16.4 of the handoff asks the
transaction question first.

### Route B — it is not transactional, or does not exist

We need the unit-of-work port from §2 and wrap the three writes:

```ts
await run(async (uow) => {
  const user = await uow.repositories.users.create({ ... });
  await uow.repositories.credentials.create({ userId: user.id, passwordHash });
  await uow.repositories.students.createForUser(user.id, profile);
  return user.id;
});
```

### 3.1 The identifier question is entangled with this

If the database generates ids (`BIGINT IDENTITY`), the user id does not exist
until the first insert returns, so the three writes **must** share a
transaction and the insert **must** return the generated id — `OUTPUT
INSERTED.id`. If ids are client-generated GUIDs, the service can mint one up
front and the coupling relaxes.

**We cannot design registration atomicity without an answer to Q1/Q-K1.**

---

## 4. Atomic approval decisions (approved: decision 7)

### 4.1 Replace read-then-write with a guarded update

Today: `findById` → check `adminApprovalStatus === "pending"` → write. Two
admins can both pass the check.

Proposed port behaviour — **decide only once, enforced in one statement**:

```
UPDATE students
   SET admin_approval_status = @status,
       admin_approval_remarks = @remarks,
       approved_at = @decidedAt
 OUTPUT INSERTED.*
 WHERE id = @id
   AND admin_approval_status = 'pending';
SELECT @@ROWCOUNT;
```

`@@ROWCOUNT = 0` with the row present means somebody decided first → the
service maps it to the existing **409**, unchanged from the client's view.
This needs no transaction and no interface change: `recordApprovalDecision`
already returns the updated student, so the adapter can simply refuse.

**Open question for the DB team:** is a `RecordNotFoundError` (no such
student) distinguishable from "not pending" in one round trip? We would
prefer a second statement over a second transaction.

### 4.2 The decision and its audit record in one transaction

Per decision 7, once the audit table exists the two writes become one unit:

```ts
await run(async (uow) => {
  const student = await uow.repositories.students.recordApprovalDecision(id, decision);
  await uow.repositories.approvalAudit.append({ ...decision, studentId: id });
  return student;
});
```

An approval with no audit row, or an audit row for a decision that did not
land, are both worse than a failed request.

---

## 5. Approval audit history (approved in principle; schema NOT finalised)

### 5.1 The gap this closes

`ApprovalDecision` **requires** `decidedByUserId`, but `Student` has no field
for it and nothing persists it. **After an approval today, who approved is
unrecoverable.** The entity also holds only the *latest* decision, so there
is no history.

This overlaps handoff **Q-F5** ("`decidedByUserId`, `overrideApprovedBy`,
`markedByUserId`, `revokedByUserId` — FK to users, or a denormalised
snapshot?").

### 5.2 What the audit record has to answer

Stated as requirements, not columns, because the schema is not ours to draw:

1. **Who** decided — recoverable even if that admin is later renamed,
   deactivated or deleted. That argues for a **snapshot** of name and role
   alongside the FK, which is the usual answer for audit data and is what
   Q-F5 proposes.
2. **What** was decided, **when**, and **why** (remarks).
3. **Which student**.
4. **Append-only.** A decision history that can be edited is not an audit
   trail. Whether that is enforced by permissions, a trigger or convention is
   the database team's call (handoff Q22 on immutability and retention).
5. **Ordered**, so "the current decision" is unambiguous.

### 5.3 What is deliberately NOT decided here

- Table and column names, types, keys, indexes — **await the schema review**.
- Whether this is a dedicated `approval_decisions` table or rows in a general
  audit log. api-contracts §15 describes a shared audit service that does not
  exist; if one is coming, this should probably be part of it rather than a
  second mechanism.
- **The new `ApprovalAuditRepository` port.** Sketched in §4.2 to show the
  transaction shape; **not added to `RepositoryRegistry`**, per the
  instruction not to change shared repository interfaces before the schema
  review.

---

## 6. `accountState` — settled and implemented

**Decision: derived, never persisted.** Implemented at Stage 0.

- `deriveAccountState()` computes it from `status`, `isEmailVerified` and
  `adminApprovalStatus`.
- `toStudentResponse()` now derives it instead of passing a stored value
  through, so a response can never be stale.
- The in-memory fake no longer writes it.
- **The database needs no `account_state` column.**

### 6.1 Two observable consequences, both intended

1. **A suspension is now reflected.** api-contracts §5 recorded an
   integration concern: the admin badge reads `accountState`, so it kept
   showing `approved` after a suspension. Deriving fixes that.
2. **A `deactivated` student carries no `accountState`.** The frontend's
   `AccountState` union has no `deactivated` member, so the derivation
   reports nothing rather than inventing the nearest-looking value. **This
   needs a frontend contract decision** — add a member, or accept that the
   badge is empty for deactivated accounts.

---

## 7. What the database team must answer before Stage 1

Ordered by how much they block us.

| ID | Question | Blocks |
| --- | --- | --- |
| **Q-M5** | The existing schema / DDL, or confirmation we design it | Everything — no table or column names exist |
| **Q-C1** | Direct `mssql` driver, procedures-only, or a data service | Whether adapters contain SQL at all |
| **Q1 / Q-K1** | Primary key type, and whether ids are client- or database-generated | Registration atomicity (§3.1) |
| **Q-X1** | Is the unit-of-work shape in §2 acceptable | Service interfaces |
| **§16.4** | `USP_NXA_Register_Student`: all seven questions, the transaction one first | Route A vs Route B (§3) |
| **Q-C5** | A development database | Nothing can be *tested*, so nothing can be *claimed* |
| **Q-F5** | Approval actor: FK, snapshot, or both | §5 |
| **Q-X2** | Isolation level | §2.4 |
| **Q-M1** | Migration ownership | Whether SQL lives in this repository |
| **Q17** | Collation, `NVARCHAR`, `DATETIMEOFFSET` | Email matching and ordering stability |
| **Q-U1** | Is email unique across roles or per role | Whether `users` is one table |

---

## 8. How an adapter will be judged

`tests/conformance/` holds an executable specification per port, written
against the interfaces only. `tests/conformance.test.ts` runs it against the
in-memory fakes today; a second runner will point the identical suites at the
SQL adapters.

The suites include `[concurrency]` cases for exactly the operations where a
`SELECT`-then-`UPDATE` adapter would pass every type check and still be
wrong:

- `otpChallenges.consume` — exactly one of several overlapping callers wins;
- `otpChallenges.incrementAttempts` — N overlapping increments total N;
- `credentials.recordFailedAttempt` — no undercounting, so the lockout trips;
- `credentials.resetFailedAttemptsIfAuthorized` — **a late success must not
  erase a lockout**;
- `sessions.rotateRefreshToken` — exactly one of two rotations succeeds;
- `sessions.revokeSession` — idempotent, and the first reason wins.

Against the fakes these verify the sequential half of each contract only; the
fakes never await inside a method, so nothing truly interleaves. They become
load-bearing against a real database. The suite was validated by binding it
to a deliberately broken adapter (unconditional `consume`, read-modify-write
increment): **6 of 21 OTP specs failed, including both concurrency cases.**
