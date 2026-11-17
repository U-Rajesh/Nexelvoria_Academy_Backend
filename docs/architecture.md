# NEXELVORIA Academy — Backend Architecture

**Audience:** the two backend developers on this project.
**Status:** Step 2 — shared foundation only. No feature modules are implemented yet.
**Last updated:** 2026-11-17

This document is the contract between us. If you are about to write code that
disagrees with it, change the document first (via the backend lead) rather
than quietly diverging.

---

## 1. Scope and ground rules

- Backend only. We never edit the frontend repository.
- The **database is Microsoft SQL Server 2025, owned by a separate team.** No
  driver, no ORM, no SQL, no connection string lives in this repository yet. We
  code against repository *interfaces* and let them supply the implementation
  later. SQL-Server-specific decisions still pending (identifier type,
  collation, date types, pagination strategy) are tracked in
  [open-questions.md](open-questions.md) Q1 and Q17.
- Authentication and business logic are **not** implemented yet. The seams for
  them exist (`req.user`, `AuthenticatedUser`, `validate()`); the logic does not.

---

## 2. Technology baseline

| Concern | Choice | Notes |
| --- | --- | --- |
| Runtime | Node.js 24 | `engines.node >= 20` |
| Framework | Express 5 | Native async error handling — see section 10 |
| Language | TypeScript 7, `strict` | Plus extra safety flags, see section 10 |
| Module system | CommonJS | Deliberate — see section 10 |
| Validation | zod 4 | Same major version as the frontend |
| Dev runner | tsx | `npm run dev` watches and restarts |

Runtime dependencies are only: `express`, `cors`, `helmet`, `dotenv`, `zod`.
Adding another runtime dependency is a decision for the backend lead.

---

## 3. Folder structure

```
src/
  config/        Environment + configuration. No business logic.
  contracts/     Shared types every module may import. The common vocabulary.
  middleware/    Cross-cutting Express handlers (validation, errors, later auth).
  modules/       Feature modules. ALL business logic lives here.
  repositories/  Repository PORTS (interfaces). The seam to the database team.
  routes/        The single mount point that assembles module routers.
  utils/         Small, dependency-free helpers (errors, logger, responses).
  app.ts         Builds and configures the Express app. Does not listen.
  server.ts      Starts the HTTP server, handles signals and shutdown.
docs/
  architecture.md     This file — structure, layers, conventions.
  api-contracts.md    Endpoint designs, conventions, role matrix (Step 3).
  open-questions.md   Unresolved decisions blocking implementation (Step 3).
  database-handoff.md Entities, constraints and questions for the DB team (Step 5).
```

## Dependency injection (Step 5)

Services depend on repository **interfaces**, never on a concrete database
class. Wiring happens in `src/container/container.ts` — about 100 lines of
hand-rolled DI, deliberately not a library (tsyringe/Inversify/Nest DI would
buy decorators and reflection metadata we do not need for one kind of
dependency).

A service takes the ports it needs and **never imports the container**:

```ts
export const createStudentService = (deps: {
  students: StudentRepository;
  enrollments: EnrollmentRepository;
}) => ({ /* ... */ });
```

The route layer resolves and passes them down:

```ts
router.use("/students", createStudentRoutes({
  students: container.repositories.students,
}));
```

That keeps the container at the edge. **A service that imports the container
becomes untestable without it** — the exact coupling this design prevents.

Repositories are built **lazily and memoised per container**: no adapter exists
yet, so eager construction would stop the app booting. Resolving an
unregistered repository throws `RepositoryNotConfiguredError` with a precise
message, rather than returning a stub that silently does nothing.

`createProductionContainer()` registers **nothing** today. The app boots and
serves `/api/v1/health`; touching a repository fails loudly. When the database
team delivers adapters, that one function is the only file that changes.

### Repository ports

Interfaces live with their module (`src/modules/<m>/<m>.repository.ts`), and
`src/repositories/` holds the generic shapes plus the error contract. No port
may import a driver or contain SQL. Adapters must translate driver errors into
`RecordNotFoundError` / `DuplicateRecordError` — nothing above the adapter
should know that SQL Server reports a duplicate as error 2601/2627.

Convention: **single reads return `null`** when absent (a normal result);
**writes against a missing id throw**.

### In-memory fakes are test-only

They live in `tests/fakes/`, which `tsconfig.json` does not include — so
`npm run build` cannot emit them and the built app cannot import them. That
structural fact is the real guarantee; a runtime `NODE_ENV=production` guard
and the empty production container are defence in depth. **Never register a
fake outside a test.**

Current contents:

```
src/
  config/env.ts                       validated env access
  config/cors.ts                      CORS allow-list policy (unit testable)
  config/security.ts                  Helmet options for a JSON API
  contracts/api.contract.ts           response envelope, pagination, error codes
  contracts/user.contract.ts          roles, statuses, audit actor, role groups
  contracts/identifier.contract.ts    EntityId, business codes, date aliases
  contracts/express.contract.ts       Request augmentation
  middleware/request-context.middleware.ts  request id (must be first)
  middleware/request-logger.middleware.ts   one structured line per request
  middleware/authorize.middleware.ts  role guards — fail closed
  middleware/rate-limit.middleware.ts general + per-endpoint limiters
  middleware/validate.middleware.ts   zod validation + pagination/list schemas
  middleware/not-found.middleware.ts  404 into the error pipeline
  middleware/error.middleware.ts      the ONLY place errors become responses
  modules/health/                     reference module — copy this shape
  repositories/base.repository.ts     generic repository ports
  routes/index.ts                     the route registry
  utils/api-error.ts                  ApiError — the only error we throw
  utils/http-status.ts                status code constants
  utils/logger.ts                     logging seam (structured, redacting)
  utils/redact.ts                     strips secrets before logging
  utils/send.ts                       sendSuccess / sendPaginated
tests/
  app.test.ts                         real app: health, 404, headers, limits
  authorize.test.ts                   role guards and inheritance
  validation.test.ts                  body/query/params validation
  security.test.ts                    CORS, rate limits, sanitization, redaction
  helpers/server.ts                   ephemeral-port test server
```

## 3.1 Security middleware (Step 4)

Middleware order in `app.ts` is load-bearing and must not be reshuffled:

```
requestContext -> requestLogger -> helmet -> cors -> rateLimit
  -> body parsers -> routes -> 404 -> errorHandler
```

- **`requestContext` is first** so any later failure is traceable. It echoes
  `X-Request-Id`, honouring an inbound one only if it matches
  `[A-Za-z0-9._-]{8,128}` — an unvalidated header would allow log injection.
- **Rate limiting sits before the body parsers**, so a flood is rejected
  without paying to parse its payload.
- **`errorHandler` is last** and remains the only place a failure becomes JSON.

### Authorization — fail closed

`authorize.middleware.ts` provides `requireAuth`, `requireRoles(...)` and the
four tier guards (`requireStudent`, `requireTeacher`, `requireAdmin`,
`requireSuperAdmin`). Authentication does **not** exist yet, so `req.user` is
always undefined and **every guard denies with 401 today**. That is intended.

Two rules that must never be relaxed:

1. **Identity comes only from `req.user`**, set only by the (future) auth
   middleware. A role or id in a body, query or header is ignored — there are
   tests asserting exactly that.
2. **401 = not authenticated, 403 = wrong role.** The frontend interceptor
   treats 401 as a session problem, so returning 401 for a role mismatch would
   log the user out instead of showing a permission error.

Fine-grained permissions are deliberately **not** implemented pending
[open-questions.md](open-questions.md) Q10.

### Logging

Call `logger.*`, never `console.*`. Every logged object passes through
`redact()`, which replaces values under keys matching password/token/otp/
secret/authorization/card patterns. The request logger records **metadata
only** — never bodies, headers or query values — and takes the path from
`req.originalUrl`, because Express rewrites `req.url` during router dispatch.

## 3.2 Testing

Node's built-in test runner via tsx — **no test dependencies**:

```
npm test          # tsx --env-file=.env.test --test "tests/*.test.ts"
npm run test:watch
npm run verify    # typecheck + build + test
```

`npm run typecheck` runs **two** projects: `tsconfig.json` (src, the build) and
`tsconfig.test.json` (src + tests, noEmit). The second was added in Step 5
because the build config includes only `src/**/*.ts`, which meant test files
were never type-checked at all. `npm run build` still compiles `src/` alone.

`.env.test` sets `NODE_ENV=test`, which drops the logger to errors only so
output stays readable. Tests start the app on port 0 (an ephemeral port), so
they never collide with the dev server or each other.

**Guarded routes used by tests live in the test files, never in `src`.** The
application exposes no test, debug or bypass endpoints in any environment.
Where a test needs an identity, it injects one with a local `asRole()` helper
that exists only in the test file.

---

## 4. Layer responsibilities

Each layer may only talk to the layer below it. **Never skip a layer, and
never call upwards.**

```
HTTP -> Routes -> Controller -> Service -> Repository -> (database, later)
```

### Routes — `module.routes.ts`

Declares paths, HTTP verbs, and the middleware chain for the module. Maps a
path to a controller method.

- **Does:** declare `router.post("/", validate(schema), controller.create)`.
- **Never:** contain logic, touch `req.body`, or repeat the `/api/v1` prefix
  (the parent applies it).

### Controllers — `module.controller.ts`

The HTTP adapter. Exactly three jobs: read input off the request, call one
service method, send the response.

- **Does:** `const dto = req.body; const r = await service.x(dto); sendSuccess(res, { data: r });`
- **Never:** contain business rules, call a repository directly, or build
  error responses by hand. To fail, `throw new ApiError(...)`.
- A controller should be boring and roughly five lines per handler. If it grows
  a conditional about *domain* rules, that rule belongs in the service.

### Services — `module.service.ts`

Where the business lives: the SRS rules (BR-001 to BR-018), orchestration,
authorisation decisions beyond "is this role allowed in", and composition of
several repositories.

- **Does:** enforce rules, throw `ApiError`, call repository ports.
- **Never:** import `express`, or touch `req`/`res`. A service must be callable
  from a job, a CLI, or a test with no HTTP involved. **This is the rule that
  keeps the codebase testable — do not break it.**

### Repositories — `module.repository.ts`

Data access **interfaces** (ports). Our half of the contract with the database
team. Defines *what* we need to read and write, never *how* it is stored.

- **Does:** `export interface StudentRepository { findById(id): Promise<Student | null> }`
- **Never:** import a driver or ORM; contain SQL; appear in a controller.
- The generic `CrudRepository` in `repositories/base.repository.ts` is a
  convenience. If plain CRUD does not fit your access pattern, define a
  narrower port instead — do not contort the domain to fit the base.

### Middleware — `src/middleware/`

Cross-cutting concerns that apply to many modules: validation, error
handling, and later authentication, authorisation and rate limiting.

- Something used by **one** module is not middleware — keep it in that module.
- Order matters and is fixed in `app.ts`; the error handler is always last.

### Contracts — `src/contracts/`

The shared vocabulary: the response envelope, pagination, roles, and the
Express `Request` augmentation. These types are imported across module
boundaries, so changing one affects everyone — treat edits here as API
changes and raise them with the lead.

A type used by only one module belongs in that module's `module.types.ts`,
**not** here. Keep `contracts/` small.

### Configuration — `src/config/`

Reads, validates and freezes environment input. Every other file imports from
`config/env`; **nobody else reads `process.env` directly.** An invalid or
missing variable must fail loudly at startup, not surprise us at request time.

### Utils — `src/utils/`

Small, generic, dependency-free helpers. If a "util" knows about students or
payments, it is domain logic and belongs in a module.

---

## 5. Request lifecycle

A request to `POST /api/v1/students`:

```
1.  HTTP arrives at server.ts (the listening socket)
2.  helmet()                   security headers
3.  cors()                     cross-origin policy
4.  express.json()             body parsed (1mb cap)
5.  /api/v1 router             routes/index.ts dispatches to the module
6.  module.routes.ts           matches the path + verb
7.  validate(schema)           422 immediately if input is malformed
                               body -> req.body, params -> req.params,
                               query -> req.validatedQuery
8.  controller                 reads input, calls the service
9.  service                    enforces business rules; may throw ApiError
10. repository (port)          data access — unimplemented until the DB lands
11. controller                 sendSuccess(res, { data })
```

Failure paths:

- **No route matched** -> `notFoundHandler` -> `ApiError.notFound` -> error handler -> `404`.
- **Invalid input** -> `validate()` -> `ApiError.validation` -> error handler -> `422` with `details[]`.
- **Business rule violated** -> service throws `ApiError` -> error handler -> that status.
- **Unexpected bug** -> error handler -> `500`, generic message, full detail logged
  server-side only. Verified: internal messages are hidden when `NODE_ENV=production`.

Because Express 5 forwards rejected promises to the error handler, an `async`
controller can simply `throw`. **Do not write `try/catch` just to call
`next(err)`, and do not add an `asyncHandler` wrapper — we verified Express 5
does this natively.**

### Response envelope

Success (`data` omitted when there is no payload):

```json
{ "success": true, "message": "optional", "data": {} }
```

Failure (produced *only* by the error middleware):

```json
{
  "success": false,
  "message": "human readable",
  "error": "MACHINE_CODE",
  "details": [{ "field": "email", "message": "Invalid email address" }]
}
```

Lists always use the paginated shape, built with `toPaginatedResult()`:

```json
{ "items": [], "total": 25, "page": 1, "pageSize": 10, "totalPages": 3 }
```

> These shapes mirror `ApiResponse<T>` and `PaginatedResult<T>` in the
> frontend's `src/types/common.types.ts`. Renaming a key here breaks the UI.
> **Known mismatch:** the frontend declares `data: T` as required while we omit
> it for payload-free endpoints. The frontend should relax it to `data?: T`.
> Flagged with the lead; not changed unilaterally.

---

## 6. Module anatomy

Every feature module is a folder under `src/modules/<module>/` with up to six
files. **Create only the files the module actually needs** — an empty file is
noise, not architecture.

| File | Responsibility | Required? |
| --- | --- | --- |
| `module.routes.ts` | paths, verbs, middleware chain | yes |
| `module.controller.ts` | HTTP in/out | yes |
| `module.service.ts` | business logic | yes |
| `module.repository.ts` | data access port (interface) | when it persists data |
| `module.validation.ts` | zod schemas + inferred DTO types | when it accepts input |
| `module.types.ts` | types internal to the module | when it has its own types |

`src/modules/health/` is the live reference. It has no repository or
validation file because it persists nothing and takes no input — that is the
intended use of the table above, not an oversight.

### Naming

- Folders: `kebab-case` (`super-admin`).
- Files: `kebab-case` with the role suffix (`student.service.ts`).
- Exported objects: `camelCase` (`studentService`, `studentController`).
- Types and interfaces: `PascalCase`. zod schemas: `camelCase` + `Schema`.
- Wire values follow the frontend exactly — note the role is `super_admin`
  (underscore) even though the folder is `super-admin`.

---

## 7. Module boundaries

The rules that stop this becoming a tangle:

1. **A module may not import another module's internals.** No
   `import { studentService } from "../students/student.service"` inside
   `payments`.
2. **If module A needs something from module B,** either (a) B exposes it in
   its own public surface and the lead approves the dependency, or (b) the
   shared piece moves into `contracts/`. Decide this in review, not alone.
3. **Shared types go in `contracts/`, shared behaviour in `utils/` or
   `middleware/`.** Nothing is shared by reaching sideways into a module.
4. **No circular imports.** The layering in section 4 prevents them if followed.
5. `modules/` may import from `contracts/`, `utils/`, `middleware/`,
   `repositories/`, `config/`. Those five may **never** import from `modules/`.

---

## 8. Import conventions

- **Relative paths only.** No `@/` aliases: a CommonJS build would need an
  extra runtime resolver (`tsc-alias` or `module-alias`) to rewrite them, and
  that is complexity we have not earned. Depth stays shallow because modules
  are flat.
- **No barrel `index.ts` re-export files** (except `routes/index.ts`, which is
  a registry, not a barrel). Import from the concrete file:
  `import { ApiError } from "../../utils/api-error";`
  Barrels invite circular imports and, more practically, they are a file that
  *every* developer edits — which is exactly how two people create merge
  conflicts on unrelated work.
- **No file extensions** in relative imports (`"./health.service"`). This is
  correct for our CommonJS setup; under ESM it would need `.js`.
- Import order: node builtins, then external packages, then internal
  (`contracts`, `config`, `utils`, `middleware`), then module-local. Use
  `import type` for type-only imports.

---

## 9. Adding a new module

Worked example for `students`:

1. `mkdir src/modules/students`
2. Write `student.types.ts` — the domain shapes.
3. Write `student.repository.ts` — the port: what you need from the database.
   Hand this to the database team; do not implement it.
4. Write `student.validation.ts` — zod schemas, and export inferred DTOs:
   ```ts
   export const createStudentSchema = z.object({
     name: z.string().min(2),
     email: z.string().email(),
   });
   export type CreateStudentDto = z.infer<typeof createStudentSchema>;
   ```
5. Write `student.service.ts` — the rules. Takes the repository port as a
   parameter or module-level dependency. Throws `ApiError`. No `express`.
6. Write `student.controller.ts` — thin HTTP adapter using `sendSuccess`.
7. Write `student.routes.ts` — wire paths to controller methods with
   `validate({ body: createStudentSchema })`.
8. Mount it in `src/routes/index.ts` with one line:
   `apiV1Router.use("/students", studentRoutes);`
9. Run `npm run typecheck` and `npm run build`. Both must pass.
10. Update the table in section 11 if the module's scope shifted.

Reading validated input in a controller:

```ts
// body and params are written back onto the request and are safe to read:
const dto = req.body as CreateStudentDto;

// query lives on req.validatedQuery, NOT req.query — see section 10:
const { page, pageSize } = getPagination(req);
```

---

## 10. Decisions and rationale

Recorded so nobody has to re-litigate them, and so a future change is informed.

**CommonJS, not ESM.** Kept from Step 1 and unchanged. Relative imports need
no `.js` extension, which is the single biggest source of confusion in a
TypeScript ESM setup. Cost: no top-level `await` (confirmed — esbuild rejects
it in CJS output). We have not needed it; `server.ts` uses callbacks. If we
later need top-level `await` or an ESM-only dependency, switching is a
contained change: `"type": "module"` plus `.js` extensions on relative imports.

**TypeScript config unchanged from Step 1.** Still `strict` plus
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`,
`noUnusedLocals`, `noUnusedParameters`. `exactOptionalPropertyTypes` is why
`send.ts` and `error.middleware.ts` build their response objects
conditionally instead of assigning `undefined` — that is intentional, not
clumsy. Please do not "simplify" it back.

**zod for validation.** The frontend already depends on zod 4.6.7, so both
ends share one schema vocabulary and the same error semantics. It is also the
only sane way to satisfy the `module.validation.ts` convention. One runtime
dependency, no plugins.

**`req.validatedQuery` instead of `req.query`.** In Express 5 `req.query` is a
getter: assigning to it is *silently ignored* — we verified the write is
accepted but subsequent reads return `{}`. Writing validated query params back
there would have been a silent data-loss bug, so they go to
`req.validatedQuery` (declared in `contracts/express.contract.ts`).
`req.body` and `req.params` were verified safe to overwrite.

**No `asyncHandler` wrapper.** Express 5 forwards promise rejections to the
error handler natively. Verified with an async route that throws. The wrapper
every Express 4 tutorial tells you to write is dead weight here.

**One error exit.** Controllers and services never format a failure response.
They throw `ApiError`; `error.middleware.ts` is the only code that turns an
error into JSON. That is what keeps the envelope consistent and stops internal
messages leaking — verified hidden under `NODE_ENV=production`.

**`logger` instead of `console`.** A one-file seam so adopting pino or winston
later touches one file. Call `logger.*`, never `console.*`.

### What changed from Step 1

| Change | Why |
| --- | --- |
| `routes/health.route.ts` became `modules/health/` (4 files) | Health becomes the reference module so the conventions are demonstrated by working code rather than described in prose. Response is byte-identical. |
| Inline 404 + error handler removed from `app.ts` | Moved to `middleware/`; errors now share one formatter and one envelope. |
| `app.ts` additions | `trust proxy`, `x-powered-by` disabled, 1mb body cap. |
| `server.ts` uses `logger`; added `unhandledRejection` / `uncaughtException` | One logging seam; a process in an unknown state must stop serving traffic. |
| Added `zod` | Validation layer — see above. |

Unchanged: `tsconfig.json`, `config/env.ts`, the module system, all npm
scripts, and the `/api/v1/health` response body.

---

## 11. Planned feature modules

Derived from the frontend's `src/services/*` and `src/types/*`, which are
currently mock/localStorage-backed — so **no endpoint paths are fixed yet** and
we are free to design them.

| Module | Owns | Frontend source |
| --- | --- | --- |
| `auth` | login, dual OTP (BR-001), password reset, sessions, 2FA, role switch | `authService` |
| `students` | student profiles, approval workflow, dashboard | `studentService`, `adminService` |
| `teachers` | teacher profiles, allocation, materials, announcements, doubts | `teacherService` |
| `courses` | courses, curriculum, publish/archive, slugs | `courseService` |
| `batches` | batches, capacity, scheduling, meeting links (BR-015) | `adminService` |
| `enrollments` | enrolment requests, lifecycle, lesson progress | `studentService`, `adminService` |
| `attendance` | attendance records + corrections (BR-010) | `teacherService`, `adminService` |
| `assignments` | assignments, submissions, evaluation | both |
| `assessments` | online tests, attempts, retake authorisation | both |
| `payments` | Razorpay, coupons/discounts, refund requests (BR-005, BR-006) | `paymentService` |
| `certificates` | issue, revoke, public verification (BR-011) | `certificateService` |
| `cms` | public site content: banners, articles, FAQs, testimonials, trainers, careers, SEO, enquiries | `cmsService` (largest surface) |
| `admin` | admin-only aggregates: dashboard stats, activity logs | `adminService` |
| `super-admin` | admin accounts, system config, financial overrides, refund approval, audit logs | `superAdminService` |

### Additional domains — APPROVED at Step 3

These were raised at Step 2 and **approved by the backend lead**, so they are
now part of the plan:

| Module | Owns | Frontend source |
| --- | --- | --- |
| `placements` | job openings, applications, hiring companies, mock interviews (BR-013) | `studentService`, `teacherService`, `adminService` |
| `support` | tickets and threaded replies | `support.types.ts`, `studentService`, `adminService` |
| `notifications` | in-app notifications, broadcasts | `InAppNotification`, `adminService` |
| `settings` | institute settings, system config | `InstituteSettings`, `SystemConfig` |
| `rbac` | roles, permissions, global roles | `adminService`, `superAdminService` |

That makes **18 modules** (health plus 17 feature modules). Per-endpoint
designs are in [api-contracts.md](api-contracts.md).

### `admin` and `super-admin` are authorization surfaces — APPROVED

**Confirmed by the lead at Step 3:** admin and super-admin are authorization
roles and orchestration surfaces, **not** duplicate implementations of domain
logic. The reasoning that led to that decision is kept below.

Every other module in the table is a **domain**; these two are **roles**. The
frontend's `adminService` has roughly 60 methods that mostly operate on
students, courses, batches and payments — all of which are owned by other
modules.

If `admin` reimplements that logic we get two code paths for the same rule and
they will drift. The architecture assumes instead:

> Domain modules own their logic. Role-specific access is enforced by auth
> middleware on the route. `admin` and `super-admin` keep **only** what is
> genuinely theirs: cross-domain dashboard aggregation, admin account
> management, system configuration, financial overrides and audit logs.

So `GET /api/v1/students?status=pending` lives in `students` with an
admin-only guard — not as a separate admin endpoint. Confirm this before we
build the admin module, because it changes how much code `admin` contains.

---

## 12. Working as two developers

The architecture is designed so we rarely touch the same file.

**Own whole modules, not layers.** One of us takes `auth`, the other takes
`courses` — we do not split "you do controllers, I do services". A module is a
folder; two people in two folders cannot conflict.

**The shared files** are the only real conflict risk:

| File | Conflict risk | Protocol |
| --- | --- | --- |
| `routes/index.ts` | one line per module | Keep the list alphabetical and add your line in place. One-line additions merge cleanly. |
| `contracts/*` | high — everyone imports it | Agree the change with the lead **before** editing. Never reshape a contract to suit one module. |
| `middleware/*`, `utils/*` | medium | Adding a new file is free. Changing an existing one needs a heads-up — it affects both of us. |

**Agree contracts first.** Before either of us writes code for a module, the
types in `module.types.ts` and the port in `module.repository.ts` should be
agreed. Once the port exists, the other person can write against it before any
of it is implemented.

**Daily hygiene**

- `npm run typecheck` before every commit. It is fast; a red `main` blocks the
  other developer.
- Small, module-scoped commits: `feat(courses): add course creation endpoint`.
- Never commit `.env`. It is gitignored — keep it that way.
- Do not reformat or "tidy" a file you do not own. It turns a 3-line review
  into a 300-line one.

**Where the database team fits.** `src/repositories/` and each module's
`module.repository.ts` are the handover documents. We define the interface,
they implement it. Until then, services are written against the port and are
fully testable with a hand-written fake. **Do not block on the database
team** — and do not add a driver to this repository to unblock yourself.

---

## 13. Not implemented yet

Deliberate gaps, pending approval:

- Authentication and authorisation (the `req.user` seam exists; nothing fills it).
- Every feature module except `health`.
- Any database code, and the adapters implementing the ports.
- A test runner. Services are designed to be testable; nothing tests them yet.
- Request-id correlation and structured logging (the `logger` seam is ready).
- Rate limiting, CORS origin restriction (currently a wildcard — must be
  locked to the frontend origin before deployment), API docs.
