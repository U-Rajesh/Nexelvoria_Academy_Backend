# NEXELVORIA Academy — Database Team Handoff

**Audience:** the database development team (primary), and the backend team as
the counterpart to these questions.
**Database:** Microsoft SQL Server 2025.
**Status:** Step 5 — repository interfaces defined. **The backend has no
database connection, no driver, no SQL and no migrations.**
**Last updated:** 2026-11-17

---

## 1. How to read this document

The backend defines **repository interfaces** (ports). Each is a plain
TypeScript interface with no SQL and no driver import, so it states *what the
application needs to read and write* without dictating *how it is stored*.

**Schema design is yours.** Nothing here specifies a table, column, primary
key or foreign key. Where this document mentions a relationship or a
constraint, it is describing a requirement the application has, or asking a
question — never prescribing a design.

Two markers are used throughout:

| Marker | Meaning |
| --- | --- |
| **[C] Confirmed** | The field or behaviour exists in the completed frontend. The requirement is real. |
| **[P] Proposed / Question** | Our inference or a question for you. Not settled. |

Where to look in the code:

```
src/repositories/base.repository.ts       generic read/write port shapes
src/repositories/repository.errors.ts     the error contract (see section 9)
src/modules/users/user.repository.ts      the five priority ports
src/modules/students/student.repository.ts
src/modules/teachers/teacher.repository.ts
src/modules/courses/course.repository.ts
src/modules/enrollments/enrollment.repository.ts
src/modules/*/*.types.ts                  the entity shapes the API returns
```

Full endpoint designs are in [api-contracts.md](api-contracts.md); unresolved
business rules are in [open-questions.md](open-questions.md).

---

## 2. Confirmed domain entities

Sixteen domains, derived from the frontend's `src/types/*.ts` and
`src/services/*.ts`. **Step 5 defines repository interfaces for the five
priority domains only**; the rest are listed so you can see the whole shape of
the system before designing the schema.

| # | Domain | Purpose | Interface defined? |
| --- | --- | --- | --- |
| 1 | **Users** | Identity shared by every person | **Yes** |
| 2 | **Students** | Learner profiles, admissions, approval | **Yes** |
| 3 | **Teachers** | Trainer profiles and batch allocation | **Yes** |
| 4 | **Courses** | Catalogue + curriculum tree | **Yes** |
| 5 | **Enrollments** | Student-to-course lifecycle and progress | **Yes** |
| 6 | Batches | Cohorts, schedule, meeting link | Not yet |
| 7 | Attendance | Sessions and per-student records | Not yet |
| 8 | Assignments | Assignments and submissions | Not yet |
| 9 | Assessments | Online tests, questions, attempts | Not yet |
| 10 | Payments | Transactions, coupons, refunds | Not yet |
| 11 | Certificates | Issue, revoke, public verification | Not yet |
| 12 | Placements | Jobs, applications, companies, mock interviews | Not yet |
| 13 | Support | Tickets and threaded messages | Not yet |
| 14 | Notifications | In-app notifications and broadcasts | Not yet |
| 15 | Settings | Institute settings and system config | Not yet |
| 16 | RBAC | Roles, permissions, custom roles | Not yet |

Plus two cross-cutting concerns: **audit logs** (every mutating staff action)
and **financial overrides** (super-admin fee waivers).

### 2.1 The five priority entities in detail

Fields below are **[C] confirmed** — each is copied from a frontend type.
Identifier type is `string` **on the wire** in every case (see section 4).

#### Users — `src/modules/users/user.types.ts`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | opaque |
| `name` | string | |
| `email` | string | unique, case-insensitive |
| `mobile` | string | unique; Indian numbers |
| `role` | enum | `public \| student \| teacher \| admin \| super_admin` — **fixed by the frontend, do not rename** |
| `status` | enum | `active \| pending \| suspended \| deactivated` |
| `avatarUrl` | string? | nullable |
| `createdAt` | ISO datetime | server-owned |

#### Students — `src/modules/students/student.types.ts`

Extends Users. Adds: `collegeName`, `degreeBranch`, `passingYear`,
`courseInterestedIn`, `dateOfBirth`, `gender` (`male|female|other`),
`fullAddress`, `guardianContact?`, `resumeUrl?`, `resumeFileName?`,
`resumeFileSize?`, `linkedInUrl?`, `githubUrl?`, `isEmailVerified`,
`isMobileVerified`, `adminApprovalStatus` (`pending|approved|rejected`),
`adminApprovalRemarks?`, `approvedAt?`, `accountState?`
(`pending_verification|pending_approval|approved|rejected|suspended|locked`),
`enrolledCourseIds`.

#### Teachers — `src/modules/teachers/teacher.types.ts`

Extends Users. Adds: `specialization`, `experienceYears`, `bio`,
`qualifications`, `assignedCourseIds`, `assignedBatchIds`, `rating`.

#### Courses — `src/modules/courses/course.types.ts`

`id`, `slug` (unique), `courseCode?`, `title`, `shortDescription`,
`longDescription`, `thumbnailUrl`, `durationWeeks`, `totalHours`, `feeINR`,
`discountedFeeINR?`, `level`, `category`, `technologies[]`, `modules[]`,
`isPublished`, `status?`, `hasPlacementGuarantee`, `prerequisites[]`,
`learningOutcomes[]`, `eligibilityCriteria?`, `syllabusPdfUrl?`.

Nested four levels deep: **Course → CourseModule → Chapter → Lesson**.

#### Enrollments — `src/modules/enrollments/enrollment.types.ts`

`id`, `studentId`, `courseId`, `batchId?`, `enrollmentType?` (`self|admin`),
`status`, `enrolledAt`, `completedAt?`, `progressPercentage`,
`completedLessonIds[]`, `bookmarkedLessonIds[]`, `isAuthorizedFreeAccess?`,
`overrideReason?`, `overrideApprovedBy?`.

`status` is `pending_approval | approved_unpaid | active | completed |
cancelled | suspended`. **This field gates content access**, not just display:
`approved_unpaid` means preview-only (BR-003), `active` means full access.

---

## 3. Known entity relationships

**[C] Confirmed** from the frontend data model. How you implement them is yours.

```
User ──1:1── Student      (a student is a user)
User ──1:1── Teacher      (a teacher is a user)

Student ──1:N── Enrollment ──N:1── Course
Enrollment ──N:1── Batch   (optional — batch may be unassigned)

Course ──1:N── CourseModule ──1:N── Chapter ──1:N── Lesson
Course ──1:N── Batch

Teacher ──N:M── Batch      (via allocation, carrying courseId too)
Teacher ──N:M── Course     (via the same allocation)

Enrollment ──N:M── Lesson  (completed lessons)
Enrollment ──N:M── Lesson  (bookmarked lessons)
```

### 3.1 Three places the frontend shape differs from a normalised schema

These are the modelling decisions we flag rather than decide:

1. **`Student.enrolledCourseIds` is an array on the student**, but the same
   information exists in the enrolment relationship. Should the API derive it
   from enrolments (one source of truth) or is it stored separately? We
   recommend deriving it. **Question Q-R1.**
2. **`Teacher.assignedCourseIds` / `assignedBatchIds` are two parallel arrays**,
   but an allocation is really a `(teacher, course, batch)` triple — which two
   separate arrays cannot express. We modelled the triple as
   `TeacherAllocation`. **Question Q-R2.**
3. **The curriculum tree is four levels of nested objects.** Four tables, or
   JSON in one column? See **Q-S4**.

---

## 4. Primary keys — to confirm

**Q-K1 — What is the primary key type?** The only hard backend requirement is
that an id **serialises to a JSON string**, because every frontend type declares
ids as `string`.

| Option | Pros | Cons |
| --- | --- | --- |
| `BIGINT IDENTITY` | compact, fast joins, ideal clustered index | enumerable if exposed in URLs; needs stringifying |
| `UNIQUEIDENTIFIER` + `NEWSEQUENTIALID()` | opaque, sequential so the index behaves | 16 bytes; only a column default, not client-generated |
| `UNIQUEIDENTIFIER` with random GUIDs | client-generatable, globally unique | **avoid as a clustered key** — random inserts cause page splits and index fragmentation |
| `BIGINT` PK + `UNIQUEIDENTIFIER` public id | fast internally, opaque externally | two keys per table |

**Our recommendation:** `BIGINT IDENTITY` as the clustered PK, returned as a
string. If ids must be non-guessable in URLs — a fair concern for
`GET /students/:studentId` — add the GUID surrogate as the public identifier.

**Q-K2 — Does the API ever need to know an id before insert?** Our ports assume
not: `create()` returns the row with its id, and no service invents one. Please
confirm, since `NEWSEQUENTIALID()` would preclude pre-generation anyway.

**Q-K3 — Business codes.** Separate from primary keys, and the frontend already
displays them: `certificateNumber` (`NEX-2026-FSD-0042`), `ticketNumber`
(`TKT-1082`), `batchCode` (`JFS-2026-B1`), `courseCode` (`CRS-JFS-101`),
`receiptNumber`, `orderId`. Questions: who generates them, do counters reset
annually, and **must receipt numbers be gapless** for audit? If so they need a
database sequence or an atomic counter — two Node processes will otherwise race
and issue duplicates. We recommend generating sequential segments in the
database, not in application code.

---

## 5. Foreign keys — to confirm

**Q-F1 — Which relationships get enforced foreign keys?** We assume all of the
confirmed relationships in section 3, but it is your call.

**Q-F2 — Delete behaviour.** The application never hard-deletes a student,
teacher, course or batch — it changes status instead. So `ON DELETE CASCADE`
should rarely be needed. But several CMS and catalogue entities *do* have
delete operations (see Q-D1). What cascade behaviour do you intend?

**Q-F3 — `Enrollment.batchId` is optional.** A student can be enrolled before
being assigned a batch. Nullable FK — confirmed acceptable?

**Q-F4 — Can a student re-enrol on a course after cancelling?** Our
`EnrollmentRepository.findByStudentAndCourse()` returns **at most one** row, and
`create()` throws `DuplicateRecordError` on a second. That implies a unique
constraint on `(studentId, courseId)`. **If re-enrolment after cancellation is a
real requirement, that constraint is wrong and our port needs changing** — please
tell us, because it affects the interface, not just the schema.

**Q-F5 — `overrideApprovedBy` and approval actors.** Several entities reference
the acting staff member (`decidedByUserId`, `overrideApprovedBy`,
`markedByUserId`, `revokedByUserId`). FK to the users table, or a denormalised
snapshot of name+role? Audit records usually want the snapshot so history
survives a renamed or deleted user.

---

## 6. Data types and nullability — questions

**Q-T1 — Unicode.** Student and teacher names, addresses and course content
need `NVARCHAR`, not `VARCHAR`. Confirming explicitly because it is easy to miss
and painful to change later.

**Q-T2 — Money.** `feeINR`, `discountedFeeINR`, `amountINR`, `finalAmountINR`,
`discountAppliedINR`. The frontend treats these as whole rupees. Our strong
preference is an exact type — `DECIMAL(12,2)` or an integer of paise — and
**never `FLOAT`/`REAL`**, which cannot represent currency exactly. Which do you
intend, and are amounts stored in rupees or paise? The payment gateway works in
paise.

**Q-T3 — Dates and times.** The API uses ISO-8601 UTC on the wire. Our
recommendation is `DATETIMEOFFSET` for timestamps and `DATE` for date-only
fields. The distinction matters: `AttendanceSession.sessionDate` is a calendar
date with no time, and a 9pm IST class falls on the *next* UTC day — storing it
as a timestamp invites an off-by-one-day bug in attendance percentages, which
feed certificate eligibility (BR-011). See open-questions Q15.

**Q-T4 — Percentages.** `progressPercentage`, `attendancePercentage`,
`examScorePercentage`, `rating`. Integer or decimal? Is
`progressPercentage` stored or computed from `completedLessonIds` against the
curriculum? We lean to computed, since a stored copy will drift.

**Q-T5 — Arrays of scalars.** `technologies[]`, `prerequisites[]`,
`learningOutcomes[]`, `completedLessonIds[]`, `bookmarkedLessonIds[]`,
`permissions[]`. SQL Server has no array type. Child table, JSON column, or
delimited string? Child tables for anything queried or joined
(`completedLessonIds`), JSON is defensible for display-only lists
(`learningOutcomes`).

**Q-T6 — Nullability.** Every `?` field in the TypeScript types is optional on
the wire. Please confirm these map to `NULL`-able columns, and tell us any
column you intend as `NOT NULL` with a default so we can mark it required in
the entity types.

**Q-T7 — Enum storage.** Roles, statuses, categories, levels. Lookup tables, or
`VARCHAR` with a `CHECK` constraint? Either is fine, but **the stored values must
match the frontend strings exactly** — including `super_admin` with an
underscore, and course categories with spaces and an ampersand
(`"Data & AI"`, `"Cloud & DevOps"`).

**Q-T8 — Free-text sizes.** `longDescription`, `bio`, `jobDescription`,
`instructions`, ticket messages. Any `NVARCHAR(MAX)` columns we should avoid
selecting in list queries? If so, tell us and we will split list projections
from detail projections in the ports.

---

## 7. Unique constraints

Derived from the behaviour our repository ports already promise. Each
corresponds to a `409 CONFLICT` the API must return, so these are
**application requirements**, not suggestions:

| Entity | Unique on | Confidence | Notes |
| --- | --- | --- | --- |
| Users / Students / Teachers | `email` | **[C]** | case-insensitive; registration conflict |
| Users / Students | `mobile` | **[C]** | login accepts mobile, so it must identify one person |
| Courses | `slug` | **[C]** | public URL `/courses/:courseSlug` |
| Courses | `courseCode` | **[P]** | if assigned, presumably unique — confirm |
| Batches | `batchCode` | **[P]** | likely unique |
| Enrollments | `(studentId, courseId)` | **[P]** | see **Q-F4** — blocks re-enrolment |
| Teacher allocation | `(teacherId, batchId)` | **[P]** | our port rejects duplicates |
| Attendance | `(batchId, sessionDate)` | **[P]** | **important:** without it, a double submit silently doubles session counts and changes attendance percentages, altering BR-011 certificate eligibility |
| Certificates | `certificateNumber` | **[C]** | public verification key |
| Support tickets | `ticketNumber` | **[C]** | shown to users |
| Payments | `receiptNumber`, `orderId` | **[C]** | financial records |
| Coupons | `code` | **[C]** | case-insensitive lookup |

**Q-U1 — Is email unique across all roles, or per role?** Can one person be both
a teacher and a student with the same email address? This affects whether users
is one table or several, and it interacts with open-questions Q23 (multi-role
users).

**Q-U2 — Case-insensitive uniqueness.** SQL Server's default collation
(`SQL_Latin1_General_CP1_CI_AS`) is case-insensitive, which happens to be what
we want for email. **We will normalise email and slug to lowercase in the
application anyway**, so behaviour does not silently depend on collation. Please
confirm the collation you are using, and whether any column needs a
case-*sensitive* one.

---

## 8. Index requirements

These come from the actual query patterns in our ports — not guesses. Listed as
the **lookups the application performs**, for you to index as you see fit.

**Users / Students / Teachers**
- `email` lookup (login, duplicate check) — every login does this
- `mobile` lookup (login accepts either)
- Students filtered by `status`, `adminApprovalStatus`, `passingYear`
- Student free-text search over `name`, `email`, `mobile`, `collegeName`

**Courses**
- `slug` lookup — every public course page view
- Filter by `isPublished` (the public catalogue always filters on it)
- Filter by `category`, `level`, `status`
- Search over `title`, `shortDescription`, `technologies`

**Enrollments**
- `(studentId, courseId)` — the uniqueness check *and* the access-control
  lookup on the content path, so it is on the hot path
- `studentId` — the student's own dashboard
- `(batchId, status)` — active-enrolment count for batch capacity

**Teacher allocations**
- `(teacherId, batchId)` — `isAllocatedToBatch()`, **called on every
  teacher-scoped request**, so it must be a single indexed lookup

**Q-I1 — Pagination strategy.** Every list endpoint returns
`{ items, total, page, pageSize, totalPages }`, which needs a row count plus a
page. `OFFSET/FETCH NEXT` requires a **deterministic `ORDER BY`** — without a
unique tiebreaker column, rows can repeat or vanish between pages. Please
ensure ordering is stable. Deep offsets degrade on large tables; if that
becomes a problem we can move to keyset pagination, and our
`PaginatedResult` contract does not prevent it.

**Q-I2 — Is `total` expensive?** We currently require an exact total for
`totalPages`. If a `COUNT(*)` over a large filtered set proves costly, tell us
and we will discuss an approximate or omitted total with the frontend.

**Q-I3 — Full-text search.** Several endpoints accept a `search` term across
multiple columns. `LIKE '%term%'` cannot use a normal index. Do you want SQL
Server Full-Text Search for these? If not, we should narrow what `search`
covers rather than ship a table scan.

---

## 9. Error contract — what adapters must throw

**This is a requirement on the adapter implementation, not a question.** Our
services catch these and map them to HTTP responses. See
`src/repositories/repository.errors.ts`.

| Situation | Adapter must | Becomes |
| --- | --- | --- |
| Single read, record absent | return `null` | 404, or a domain-specific message |
| Write against a missing id | throw `RecordNotFoundError` | 404 |
| Unique constraint violated | throw `DuplicateRecordError` | 409 |
| Optimistic concurrency lost | throw `OptimisticLockError` | 409 |

**Adapters must not leak driver errors.** SQL Server reports a unique index
violation as error **2601/2627**; nothing above the adapter should ever have to
know that. Translate it at the boundary.

---

## 10. Transaction requirements

Operations that **must be atomic**. Each is a case where a partial write leaves
the system in a state the business rules cannot describe:

1. **Attendance session** — the session header and every student record are one
   unit. A half-marked register corrupts the percentages behind BR-011
   certificate eligibility.
2. **Payment success → enrolment activation** — recording a transaction and
   moving the enrolment to `active` must not come apart. A paid student with an
   inactive enrolment, or the reverse, is a support incident either way.
3. **Refund approval** (BR-006) — the refund decision, transaction status and
   any enrolment change are one unit.
4. **Student registration** — creating the user and the student profile, if they
   end up in separate tables.
5. **Teacher allocation** — the allocation row and any denormalised arrays.
6. **Certificate issue** — the certificate plus the eligibility snapshot
   (attendance % and exam % as they were at issue time).
7. **Curriculum replace** — the whole `CourseModule[]` tree swaps atomically.

**Q-X1 — How should transactions be expressed in the port?** Our interfaces
currently have **no transaction API** — deliberately, because the right shape
depends on your adapter. Options:

- **Unit-of-work:** a service calls `withTransaction(async (tx) => ...)` and
  repositories are resolved from `tx`.
- **Coarse repository methods:** the adapter wraps multi-step work internally
  (e.g. one `recordPaymentAndActivate()` method).
- **Ambient transaction:** scoped implicitly via `AsyncLocalStorage`.

We lean to **unit-of-work** — explicit, testable, and it keeps multi-entity
business rules in the service layer where they belong. This is the single
biggest open item in the port design and we would like your input before
defining it.

**Q-X2 — Isolation level.** Default `READ COMMITTED`, or do you intend
`SNAPSHOT`/`READ_COMMITTED_SNAPSHOT` to reduce reader-writer blocking? Relevant
because several reads are on request hot paths.

---

## 11. Database connection requirements

**Nothing is implemented. No driver is installed and the backend holds no
credentials.** When we do connect, these are the things we will need agreed:

**Q-C1 — Access method.** Direct connection from the Node backend using the
`mssql` driver (our assumption), or do you intend stored procedures as the only
interface, or a data service in front of the database?

**Q-C2 — Stored procedures vs parameterised queries.** If you require stored
procedures, say so now: it changes how adapters are written, though **not** the
repository interfaces — which is precisely why the ports exist.

**Q-C3 — Authentication.** SQL Server authentication, Windows/AD integrated, or
Entra ID (managed identity)? Managed identity is preferable since it avoids a
stored password entirely.

**Q-C4 — Connection pooling.** Expected pool size per application instance, and
how many instances you are provisioning for.

**Q-C5 — Environments.** Separate dev, test and production databases? The
backend needs a **development** instance and, ideally, a disposable test one.
Right now we test against in-memory fakes, which cannot catch SQL-level issues
such as constraint violations or collation surprises.

**Q-C6 — Secret delivery.** Credentials will be read from environment variables
via `src/config/env.ts` and must never be committed. **Please do not send
credentials by email or chat** — use the agreed secret store. Nothing in this
repository contains or will contain a username, password or connection string.

**Q-C7 — TLS.** Is `encrypt=true` with a trusted certificate available, or will
dev need `trustServerCertificate`?

---

## 12. Migration ownership — questions

**Q-M1 — Who owns schema migrations?** Our assumption: **you do.** The backend
repository contains no migration tool and no SQL, and we would prefer to keep
it that way so there is one source of truth for the schema.

**Q-M2 — What tool?** Flyway, DbUp, SSDT / database project, EF Core
migrations, or hand-run scripts? We need to know what to expect in review, not
to run it.

**Q-M3 — How do we learn about schema changes?** A breaking change to a column
the API returns breaks the frontend. We would like: advance notice, a changelog
or versioned migration list we can read, and ideally a review step for changes
touching the entities in section 2.

**Q-M4 — Who seeds reference data?** Roles, permission keys, course categories,
institute settings defaults. If the database seeds them, the backend should not;
if not, we need to know what to create on first boot.

**Q-M5 — Is there an existing schema?** If any of this already exists, send it
and we will reconcile our entity types against it rather than the other way
round. **It is cheaper to change our TypeScript than your schema.**

---

## 13. Consolidated question list

Ordered by how much they block us.

### Blocking the repository adapters

| ID | Question | Section |
| --- | --- | --- |
| Q-K1 | Primary key type | 4 |
| Q-C1 | Direct driver, stored procedures, or data service | 11 |
| Q-X1 | How transactions are expressed in the port | 10 |
| Q-F4 | Can a student re-enrol after cancelling (changes our interface) | 5 |
| Q-M1 | Who owns migrations | 12 |
| Q-C5 | Is there a development database we can use | 11 |

### Blocking schema design (we must answer for you)

| ID | Question | Owner |
| --- | --- | --- |
| Q-R1 | Derive `enrolledCourseIds` from enrolments, or store it | backend — we recommend derive |
| Q-R2 | Teacher allocation as a `(teacher, course, batch)` triple | backend — we recommend yes |
| Q-S4 | Curriculum tree: four tables or JSON | joint decision |
| Q-U1 | Is email unique across roles or per role | backend + business |

### Needed before launch

| ID | Question | Section |
| --- | --- | --- |
| Q-T2 | Money type — exact, never FLOAT | 6 |
| Q-T3 | `DATETIMEOFFSET` + `DATE`, and the IST day-boundary issue | 6 |
| Q-U2 | Collation, and case-sensitivity expectations | 7 |
| Q-I1 | Stable ordering for `OFFSET/FETCH` pagination | 8 |
| Q-I3 | Full-text search, or narrow the `search` scope | 8 |
| Q-K3 | Business code generation, and gapless receipt numbers | 4 |
| Q-T5 | How scalar arrays are stored | 6 |
| Q-D1 | Soft delete vs hard delete (open-questions Q21) | — |

### Also worth your attention

`docs/open-questions.md` holds the business-side unknowns. Three touch the
schema directly: **Q11** (file storage — note `resumeDataUrl` is a base64
artefact of the frontend mock and **must not** be persisted as a column),
**Q21** (soft vs hard delete), **Q24** (optimistic concurrency, for which SQL
Server's `ROWVERSION` is a natural fit).

---

## 14. What the backend has done, and what it has not

**Done in Step 5**
- Repository interfaces for the five priority domains, free of SQL and drivers.
- An error contract for adapters (section 9).
- Dependency injection so an adapter can be registered in exactly one place
  (`createProductionContainer()` in `src/container/container.ts`).
- In-memory fakes, **for tests only**, so backend work is not blocked while the
  schema is designed.

**Deliberately not done**
- No database connection, driver, SQL, stored procedure or migration.
- No schema, no table, column, key or index definitions.
- No credentials anywhere in the repository.
- No interfaces for the eleven non-priority domains yet — they will follow the
  same pattern once these five are validated against a real schema.

**What we need from you to proceed:** answers to the six blocking questions in
section 13, and a development database. The interfaces can absorb most schema
decisions without changing — that is their purpose — but **Q-F4 and Q-X1 would
change the interfaces themselves**, so they matter most.
