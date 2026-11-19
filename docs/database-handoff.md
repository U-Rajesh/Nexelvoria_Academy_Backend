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
| 2a | **Credentials** | Password hashes, failed attempts, lockout | **Yes** - see section 15 |
| 2b | **Sessions** | Server-side sessions + refresh-token rotation | **Yes** - see Step 6E |
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
   recommend deriving it. **Question Q-R1.** This also governs the
   `GET /students?courseId=` filter (`StudentFilter.courseId`), which today
   resolves against `enrolledCourseIds`; its long-term stored-versus-derived
   behaviour remains unresolved until Q-R1 is decided.
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
- Students filtered by `batchId` — **via a join to enrolments** (see below)
- Students sorted by `name`, `createdAt`, `passingYear` (see below)

**Student sorting and batch filter — `StudentRepository.findMany(filter, pagination, sort?)`**
*(added at backend Step 3, Task 3.1, approved by the backend lead)*

```ts
interface StudentSort {
  field: "name" | "createdAt" | "passingYear"; // STUDENT_SORT_FIELDS
  order: "asc" | "desc";
}
```

- **`field` is already validated** by the service against `STUDENT_SORT_FIELDS`
  (`src/modules/students/student.types.ts`). Still map each field to its column
  with a fixed lookup — never interpolate it into SQL.
- **Default when `sort` is omitted: `ORDER BY createdAt DESC, id ASC`** —
  newest registrations first. This default is approved and the backend relies
  on it; please implement exactly this rather than an adapter-chosen order.
- **Always append `id ASC` as the final tiebreaker, regardless of direction**
  (Q-I1), e.g. `ORDER BY name DESC, id ASC`.
- **`name` should sort case-insensitively.** The in-memory test fake compares
  lowercased values with `localeCompare`, which only *approximates* SQL Server's
  CI collation (Q17) — it is not an exact emulation; accent and locale ordering
  can differ. `createdAt` (ISO-8601 UTC) and `passingYear` (4-digit string)
  order correctly as text.
- **`filter.batchId` means "has an enrolment in that batch".** Batch membership
  lives on the enrolment, not the student, so this needs a join (or `EXISTS`)
  to enrolments on `(batchId, studentId)`. **Open:** should every enrolment
  status count (e.g. `cancelled`), or only some? Nothing specifies this yet; the
  fake currently counts any enrolment row.

**Courses**
- `slug` lookup — every public course page view
- Filter by `isPublished` (the public catalogue always filters on it)
- Filter by `category`, `level`, `status`
- Search over `title`, `shortDescription`, `technologies`
- Sort by `title`, `feeINR`, `durationWeeks`, `totalHours` (see below)

**Course sorting — `CourseRepository.findMany(filter, pagination, sort?)`**
*(added at backend Step 1b, approved by the backend lead)*

The third argument is **optional**, so callers that omit it are unaffected:

```ts
interface CourseSort {
  field: "title" | "feeINR" | "durationWeeks" | "totalHours"; // COURSE_SORT_FIELDS
  order: "asc" | "desc";
}
```

What the adapter can rely on, and what it must do:

- **`field` is already validated.** The service checks the client's `sortBy`
  against `COURSE_SORT_FIELDS` (`src/modules/courses/course.types.ts`) before
  calling the repository; anything else arrives as `sort === undefined`. Even
  so, **map each field to its column with a fixed lookup** — never interpolate
  the value into SQL.
- **Always append `id ASC` as the final tiebreaker, regardless of the sort
  direction**, e.g. `ORDER BY feeINR DESC, id ASC`. Courses often share a fee
  or duration, and without a unique last key `OFFSET/FETCH` can repeat or skip
  rows between pages (Q-I1). Ascending `id` on ties is also exactly what the
  in-memory test fake does, so tests and production agree.
- **When `sort` is omitted**, apply a deterministic default of your choosing,
  still ending in `id ASC`. The backend does not depend on what that default is.
- **`title` should sort case-insensitively.** The in-memory test fake compares
  lowercased titles with `localeCompare`, which only *approximates* SQL
  Server's default CI collation (Q17) — it is not an exact emulation (accent
  and locale ordering can differ). If you choose a case-sensitive collation
  for `title`, tell us so the fake can be adjusted.
- `feeINR` is the list price. Sorting by the discounted price is not
  supported.
- Index suggestion only, your call: composite indexes such as
  `(isPublished, <sortColumn>, id)` cover the public catalogue, which always
  filters on `isPublished`.

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

---

## 15. Authentication credentials (added at Step 6G)

A new repository port: `src/modules/auth/credential.repository.ts`, with its
record shape in `credential.types.ts`. **Interface only — no SQL, no adapter,
no connection.** Questions for you are tagged **Q-CR***.

### 15.1 How credentials relate to users and sessions

```
User    --1:1--  Credential              password hash + lockout state
User    --1:N--  Session                 one per device/login
Session --1:N--  ConsumedRefreshToken    rotation history (Step 6E)
```

- **A credential belongs to exactly one user** and is keyed by the user id.
  It holds no email, name, role or status — those live on the user, and
  duplicating them would create a second source of truth and a second place
  to enumerate accounts.
- **`UserRepository` deliberately exposes no password field.** The credential
  port is the only path to a hash, so an ordinary user query cannot select
  one into an API response or a log line.
- **Credentials and sessions are independent**, but two flows couple them: a
  password change must revoke every session, and a suspension or role change
  must too. **Neither is atomic today** — see Q-CR6.
- **Login reads both**: resolve the identifier to a user
  (`UserRepository.findByEmail` / `findByMobile`), then fetch that user's
  credential by id. There is intentionally **no credential lookup by email**.

### 15.2 The record we need stored

Field names are the application's; storage names are yours.

| Field | Purpose | Source |
| --- | --- | --- |
| `userId` | owner, and the natural key | — |
| `passwordHash` | argon2id PHC string | Step 6B |
| `passwordUpdatedAt` | when the password was last set | **confirmed** (`StudentProfile.lastPasswordChange`) |
| `failedLoginAttempts` | consecutive failures, reset on success | **confirmed** |
| `lockedUntil` | lockout expiry, if any | **confirmed** field, unconfirmed semantics (O4) |
| `lastFailedLoginAt` | time of the latest failure | **proposed** |
| `createdAt` / `updatedAt` | audit | — |

**No separate algorithm, parameter or salt columns.** The PHC string
(`$argon2id$v=19$m=47104,t=2,p=1$<salt>$<digest>`) already carries all three,
which is what lets us raise the cost parameters later and upgrade each hash on
its owner's next successful login without a schema change.

### 15.3 Questions for the database team

**Q-CR1 — Own table, or columns on the user table?** We assume a separate
`credentials` table with `user_id` as both primary and foreign key (1:1). The
separation is what keeps hashes out of ordinary user queries. If you would
rather put the columns on the user row, say so — it works, but then **every**
`SELECT *` on a user carries the hash, and we would want explicit column lists
everywhere.

**Q-CR2 — Hash column type and collation.** Argon2id PHC strings at our
parameters are ~100 characters, but length varies with parameters and salt.
Please size generously (e.g. `VARCHAR(255)`) and use a **non-Unicode,
case-SENSITIVE, accent-sensitive** collation: the hash is ASCII base64, and a
case-insensitive comparison would make two different hashes compare equal.
This matters because `updatePasswordHash` compares on the hash (Q-CR4).

**Q-CR3 — `recordFailedAttempt` must be ONE atomic statement.**
**SUPERSEDED in part by section 15.5** - the `locked_until` CASE expression
below was removed when timed lockout was dropped. The atomicity requirement
stands. Original text kept for context:

```sql
UPDATE credentials
   SET failed_login_attempts = failed_login_attempts + 1,
       last_failed_login_at  = SYSUTCDATETIME(),
       locked_until = CASE
           WHEN failed_login_attempts + 1 >= @threshold AND locked_until IS NULL
           THEN @lockUntil ELSE locked_until END
 OUTPUT inserted.failed_login_attempts, inserted.locked_until
 WHERE user_id = @userId;
```

**This is a security requirement, not a performance one.** A
SELECT-then-UPDATE loses increments under concurrency: ten parallel guesses
all read 0, all write 1, and a 5-attempt limit becomes unlimited. We have a
test that fails on exactly that mistake. The `OUTPUT` clause avoids a second
read on the login hot path, since the API must tell the user how many attempts
remain.

**Q-CR4 — password writes need a conditional update.**
**SUPERSEDED by section 15.5** - `updatePasswordHash` was split into
`changePassword`, `rehashPassword` and `resetPassword`, and the rehash now
REQUIRES compare-and-set. Original text kept for context: For a password
*change* the caller supplies the hash it verified, and the write must be
guarded in the same statement (`WHERE user_id = @id AND password_hash =
@expected`) so it cannot land on a credential a concurrent request already
replaced. Zero rows affected must be distinguishable into "no such credential"
and "hash mismatch" so the correct typed error is thrown. For a *reset*
(forgot password) no expected hash exists and the update is unconditional —
both modes are intentional.

**Q-CR5 — Is the threshold policy or data?** We pass it in per call, because
it is 5 in the confirmed frontend and configurable through
`SystemConfig.security.maxFailedLogins`. We are **not** asking you to store it
per user. Please confirm that is acceptable.

**Q-CR6 — Cross-repository atomicity (the big one).** Three flows span tables
with nothing making them atomic:

| Flow | Touches |
| --- | --- |
| registration | `users` + `credentials` |
| password change / reset | `credentials` + `sessions` (revoke all) |
| suspension / role change | `users` + `sessions` (revoke all) |

This is **Q-X1** restated with concrete cases. Until a unit of work exists we
order the calls to fail safe (create the user before the credential; update
the hash before revoking sessions) and handle partial failure in the service.
**We need your view on how transactions should be expressed** — we lean to a
`withTransaction(tx => ...)` unit of work with repositories resolved from `tx`.

**Q-CR7 — Indexes.** Lookup is always by `user_id`, which is the primary key,
so no secondary index is needed for reads. If you later want "accounts locked
right now" or "passwords older than N days" reporting, those would need
indexes on `locked_until` and `password_updated_at` — tell us if such queries
are expected, and we will not assume them.

**Q-CR8 — Retention.** When a user is deleted, is their credential row deleted
or retained? Note the application has **no** delete operation on users (status
changes are used instead — see §5), so we do not currently need a credential
delete either, and the port deliberately has no `delete` method.

**Q-CR9 — Unconfirmed lockout semantics (O4).** `lockedUntil` exists in the
frontend but is never set, and the lockout messages say "reset your password
to unlock". We therefore support **both**: a duration (expiring lockout) and
no duration (locked until a password reset or an admin unlock). **The policy
decision is still open** and belongs to the business, not to you — flagged so
you are aware the column may be perpetually NULL.

### 15.4 What we guarantee from the application side

- A plaintext password never reaches this port. The service hashes first with
  argon2id (`password.service.ts`), which enforces the policy, so a
  non-compliant password cannot be stored.
- A hash is never returned by an API, logged, or included in an error.
- Failed-attempt counting and lockout live in one place, so they cannot drift
  between login, reset and admin unlock.

### 15.5 Security corrections after review (Step 6G, second pass)

Two defects were found reviewing the first version of this port. Both changed
the interface, so the SQL requirements below supersede §15.3 where they differ.

**Correction 1 — a password rehash must be a compare-and-set.**

The first version allowed an unconditional `updatePasswordHash`, documented as
acceptable for both a reset and a `needsRehash` upgrade. That was wrong for the
upgrade: a rehash happens immediately after a successful verification, so the
caller *does* know the current hash. Writing unconditionally meant a rehash
could land after a concurrent password change and **reinstate the old password
over the new one** — a credential rollback.

The single method is now three, because they differ in both authorization and
side effects:

| Method | Authorization | Compare-and-set | Stamps `password_updated_at` | Clears lockout |
| --- | --- | --- | --- | --- |
| `changePassword` | knows the current password | **required** | yes | yes |
| `rehashPassword` | just verified the password | **required** | **no** | **no** |
| `resetPassword` | single-use OTP reset grant | no | yes | yes |

`rehashPassword` not stamping `password_updated_at` matters for you: it stores
the **same** password under stronger parameters. Stamping it would make every
user look as though they had just changed their password, corrupting password
age reporting and any expiry policy built on it (O7).

`resetPassword` has no compare-and-set because the user cannot know their
current hash — that is the premise of a reset. Its authorization is enforced in
the application service, which must hold a valid single-use reset grant.

**SQL requirement.** `changePassword` and `rehashPassword` must both be
conditional updates in a single statement:

```sql
UPDATE credentials
   SET password_hash = @newHash
       -- changePassword only; rehashPassword MUST NOT touch these:
       , password_updated_at   = SYSUTCDATETIME()
       , failed_login_attempts = 0
       , locked_until          = NULL
 WHERE user_id = @userId
   AND password_hash = @expectedHash;
```

Zero rows affected must be distinguished into "no such credential"
(`RecordNotFoundError`) and "hash mismatch" (`OptimisticLockError`) — a second
`SELECT` on `user_id` is the usual way. The application treats a mismatch on a
rehash as "abandon the upgrade", never as "retry".

**Correction 2 — timed lockout removed; lockout is counter-based.**

The first version accepted a `lockDurationMinutes` and set `locked_until`, while
also treating `failed_login_attempts >= threshold` as locked. Those rules
contradict: once `locked_until` elapsed the counter was still at the threshold,
so a "timed" lockout **never actually expired**.

Rather than silently add an automatic unlock — which would weaken the confirmed
frontend behaviour — the timed half was removed. The implemented policy is now
one rule:

> A credential is locked when `failed_login_attempts >= threshold`, and stays
> locked until the counter is explicitly cleared by a password reset or an
> administrator unlock. There is **no** automatic time-based unlock.

This matches the confirmed frontend, whose lockout message tells the user to
"unlock via Forgot Password" and which never populates `lockedUntil`.

**What this means for the schema.** Please still include `locked_until`
(`DATETIMEOFFSET NULL`): it is a confirmed frontend field and the final policy
is open. **Be aware it will be permanently NULL** under the current
implementation — nothing writes it. The application honours a *future* value if
some later policy sets one, but an *elapsed* value never unlocks a credential,
because the counter governs.

This supersedes **Q-CR3**: `recordFailedAttempt` no longer needs the `CASE`
expression for `locked_until`. It is now simply:

```sql
UPDATE credentials
   SET failed_login_attempts = failed_login_attempts + 1,
       last_failed_login_at  = SYSUTCDATETIME()
 OUTPUT inserted.failed_login_attempts, inserted.locked_until
 WHERE user_id = @userId;
```

Still one atomic statement, for the same security reason: a
SELECT-then-UPDATE loses increments under concurrent guessing and turns a
5-attempt limit into an unlimited one.

**Q-CR9 is now the blocking policy question** and is for the backend lead and
the business, not for you: permanent lockout until reset (implemented), or a
timed lockout? Choosing timed also requires deciding what happens to the
counter when the timer expires — which is precisely the contradiction that was
removed.

### 15.6 Credential record exposure — a hard rule

A `CredentialRecord` **must never leave the authentication layer**. It is not an
API DTO. It is never returned from a controller, never placed in a response
body, never put in an error, and never logged.

Enforcement in the application:

- `UserRepository` exposes no password field, so ordinary user queries cannot
  select a hash.
- `toCredentialSecurityView()` is the only credential shape allowed out. It is
  **structurally incapable** of carrying a hash, because `passwordHash` is not
  in its type — a controller cannot leak one by forgetting to strip a field. It
  carries what the confirmed admin screen (`GET /students/:studentId/security`)
  needs: lockout state, attempt count and password age.
- `redact()` replaces any value under a key matching `/pass(word)?/` or
  `/credential/` before it reaches a log, which covers `passwordHash` and a
  nested `credential` object. That is a last line of defence, not permission.
- Repository errors carry the entity name, the user id and the field name —
  never a hash value. Asserted by test across every failing path.

**Implication for you:** if you add views, stored procedures or audit triggers
over this table, do not project `password_hash` into anything the application
reads for display, and do not write it into an audit table. If an audit trail of
password changes is wanted, record the **fact and the timestamp**, never the
value or the hash.

---

## 16. Student Registration and email verification (added at Phase 3)

Phase 3 completed the registration and email-verification flow **against the
in-memory fakes**. Everything below is what we need from you to run the same
flow against MS SQL Server. Nothing here is implemented yet, and we have
**invented no stored procedure signature, schema or connection string**.

### 16.1 What the application now does

- Registers a student: creates a `User`, a credential (argon2id hash) and a
  `Student` profile — still **three sequential writes, no transaction** (Q-X1).
- Issues a six-digit email passcode, stores only a **keyed HMAC-SHA256** of
  it, and enforces a 10-minute expiry, a 5-attempt ceiling, a 60-second
  resend cooldown and 5 sends per 15 minutes.
- On success marks `Student.isEmailVerified = true`. `accountState` is
  **derived, not stored** — see `src/modules/students/account-state.ts`. You
  do **not** need an `accountState` column.
- Mobile OTP is **descoped** (Q3 resolved email-only). No mobile verification
  table or column is required beyond the existing `isMobileVerified` flag,
  which stays `false`.

### 16.2 NEW TABLE REQUIRED — OTP challenges

Backs `OtpChallengeRepository` (`src/modules/auth/otp.repository.ts`). We
describe the **fields and behaviour the port needs**; the table name, exact
types, keys and indexes are yours to choose.

| Field | Purpose | Notes |
| --- | --- | --- |
| id | primary key | Same identifier decision as Q1 |
| userId | owner | FK to the users table |
| purpose | what the code is for | Today one value, `email_verification`. Keep it a column, not a flag — a second purpose must not need a schema change |
| codeHash | the stored secret | **64-character lowercase hex** (HMAC-SHA256). Never the code itself |
| destination | the address it was sent to | A student's email address, so **personal data** — include it in whatever retention and access rules apply |
| expiresAt | expiry instant | UTC |
| attempts | failed verification count | Integer, default 0 |
| consumedAt | when it was spent | **Nullable.** NULL means "still live" |
| createdAt | when it was issued | See the clock rule in 16.3 |

**Index requests.** The two hot paths are: the newest unconsumed challenge
for a `(userId, purpose)` pair, and a count of challenges for a
`(userId, purpose)` pair since an instant. Please index for those; we do not
prescribe the form.

### 16.3 THREE CONTRACTS THE ADAPTER MUST HONOUR

These are correctness requirements, not preferences. The in-memory fake
implements all three, so a SQL adapter that does not will pass our unit tests
and then fail in production — the one thing a fake must never allow.

1. **incrementAttempts must be a single atomic statement** — an
   `UPDATE ... SET attempts = attempts + 1` returning the **post-increment**
   value. A read-modify-write lets two concurrent guesses both read 4 and
   both write 5, handing an attacker a free extra attempt past the ceiling.

2. **consume must be conditional and must report whether it wrote.**

       UPDATE <table> SET consumedAt = @now
       WHERE id = @id AND consumedAt IS NULL;
       SELECT @@ROWCOUNT;

   A `@@ROWCOUNT` of 0 is how we detect that a concurrent request already
   consumed the challenge. **That boolean is the entire one-time-use
   guarantee.** With an unconditional update, two requests presenting the
   same valid code would both succeed and the caller would apply its side
   effect twice.

3. **createdAt is supplied by the application — do not default it.** Expiry
   is measured from `expiresAt`, and the cooldown and send window from
   `createdAt`. If the adapter stamped `createdAt` with `GETUTCDATE()` the
   two timestamps would come from different clocks, and any skew between the
   database and application servers would make the cooldown and the TTL
   disagree about when the challenge was issued. One clock must decide both.

Also, per section 9: a unique-constraint violation must surface as
`DuplicateRecordError`, a write against a missing id as
`RecordNotFoundError`, and **no driver error may escape the adapter**.

### 16.4 WHAT WE NEED FOR dbo.USP_NXA_Register_Student

We have been told this procedure may exist. **We do not have its definition
and have assumed nothing about it.** Before writing the adapter we need, in
writing:

1. **Does it exist?** If not, say so and we will use parameterised queries
   against the agreed schema instead.
2. **The full parameter list** — name, SQL type, length or precision,
   nullability and default for every parameter.
3. **What it returns** — a result set (with column names and types), output
   parameters, or a return code. We need the **new user id** back, because
   the API response carries it as `tempStudentId` and the student profile is
   keyed by it.
4. **THE TRANSACTION QUESTION, which matters most of all:** does it insert
   the user, the credential **and** the student profile inside a **single
   transaction**?
   - **If yes**, our three-write problem (Q-X1) disappears: the transaction
     region in `registration.service.ts` collapses into one repository call,
     the partial-state outcomes (`incomplete`, `profile_incomplete`) become
     unreachable, and **the production registration route can be mounted.**
   - **If no**, we need the unit-of-work port of Q-X1 instead, and that
     changes our repository interfaces — so we must know before building
     adapters, not after.
5. **How it reports a duplicate email or mobile** — a specific return code, a
   `RAISERROR`/`THROW` with a known number, or a native unique-index
   violation (2601/2627). We must map it to `DuplicateRecordError` to produce
   the agreed 409, and we will not guess which.
6. **Whether it hashes the password. It must not.** Hashing is argon2id in
   the application (`password.service.ts`); the procedure must accept the
   already-hashed value as an opaque string. Please confirm it attempts no
   hashing of its own.
7. **Whether it sets `status`.** Registration must produce
   `status = 'pending'` — BR-001 verification and BR-002 approval both
   precede activation. Confirm whether the procedure fixes this itself or
   expects it as a parameter.

**The same seven questions apply to any other procedure you intend to be the
only interface.** The six named in earlier discussion —
`USP_NXA_Generate_OTP`, `USP_NXA_Revoke_Session`, `USP_NXA_Create_Teacher`,
`USP_NXA_Update_Student_Status`, `USP_NXA_Update_Student_Profile` and
`USP_NXA_Create_Course` — **appear nowhere in this repository and we hold no
definitions for them.** If they exist, please send them; if they do not, we
will assume parameterised queries.

### 16.5 CONNECTION DETAILS WE NEED (and how to send them)

No driver is installed and the repository holds no credentials. We read
configuration only through `src/config/env.ts`. The variables we expect to
add, once you confirm the access method:

| Variable | Meaning | Secret? |
| --- | --- | --- |
| `SQLSERVER_HOST` | hostname or instance | No |
| `SQLSERVER_PORT` | default 1433 | No |
| `SQLSERVER_DATABASE` | database name | No |
| `SQLSERVER_USER` | login, if SQL authentication | No |
| `SQLSERVER_PASSWORD` | password, if SQL authentication | **YES** |
| `SQLSERVER_ENCRYPT` | `true` in any shared environment | No |
| `SQLSERVER_TRUST_SERVER_CERT` | development only, if the certificate is untrusted | No |
| `SQLSERVER_POOL_MAX` | pool size per application instance | No |

Still open from sections 11 and 12, and needed before we write a line of
adapter code: **Q-C1** access method (direct `mssql` driver,
procedures-only, or a data service in front), **Q-C2** procedures versus
parameterised queries, **Q-C3** authentication (SQL, Windows/AD, or Entra ID
managed identity — we prefer managed identity, which removes the one secret
above entirely), **Q-C4** pool sizing, **Q-C5** separate dev/test/prod
databases (**we need a development instance before any of this is
testable**), **Q-C7** TLS, and **Q-M1–M5** migration ownership.

**Please do not send credentials by email or chat.** Use the agreed secret
store. Nothing in this repository contains or will contain a username,
password or connection string.

### 16.6 What stays blocked until the above arrives

- The **production** `/auth/register`, `/auth/otp/email/verify` and
  `/auth/otp/email/resend` routes. All three exist today only in the
  development harness (`dev/`), which is excluded from the build.
- `createProductionContainer()` still registers **no** repositories, so the
  production application has no registration, verification or OTP storage at
  all.
- Student Registration **cannot be called complete**: it has never run
  against a real database, and the passcode is written to the application log
  rather than emailed, because no mail provider is configured either.
