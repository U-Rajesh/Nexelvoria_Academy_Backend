# NEXELVORIA Academy — Shared API Contracts (v1)

**Audience:** the two backend developers (primary), plus the frontend developer
and the database team who both consume these contracts.
**Status:** Step 3 — design only. **No endpoint in this document is implemented.**
The only live endpoint is `GET /api/v1/health`.
**Last updated:** 2026-11-17

---

## 1. How to read this document

Every endpoint carries one of two markers. Keeping them apart matters: one is
a fact about the frontend, the other is our judgement.

| Marker | Meaning |
| --- | --- |
| **[C] Confirmed** | A method exists in the frontend today and needs a backend equivalent. The *need* is confirmed; the path and verb below are still our design. |
| **[P] Proposed** | No frontend method exists. We believe the backend needs it (token refresh, payment webhooks, server-side ordering). Requires the lead's approval. |

**Critical caveat, stated once and relied on throughout:** every frontend
service is currently **mock/localStorage-backed**. Not one of them calls a real
HTTP endpoint. `apiClient` is configured in `src/services/api.ts` with
`baseURL = VITE_API_URL || '/api/v1'`, but the service methods do not use it.
So:

- No URL path is dictated by existing frontend code. **Every path below is our proposal.**
- The frontend will need real wiring work to consume these endpoints. That is
  frontend scope, not ours, but it must be planned.
- Method *signatures* are strong evidence of required inputs and outputs, and
  are used that way here.

Where a request or response body corresponds to a frontend type, this document
**names the type instead of copying its fields**. The frontend's
`src/types/*.ts` stays the single source of truth; copying 70 fields of
`StudentProfile` into Markdown would be stale within a week.

---

## 2. Inventory — frontend surface to backend modules

Read from `src/services/`, `src/types/`, `src/routes/` and
`src/constants/businessRules.ts`.

| Frontend service | Methods | Maps to backend modules |
| --- | --- | --- |
| `authService` | 18 | auth |
| `studentService` | 22 | students, enrollments, attendance, assignments, assessments, placements, support, notifications |
| `teacherService` | 32 | teachers, courses, batches, attendance, assignments, assessments, placements, notifications |
| `courseService` | 3 | courses |
| `paymentService` | 3 | payments |
| `certificateService` | 2 | certificates |
| `adminService` | 61 | orchestration over 13 domain modules |
| `superAdminService` | 20 | super-admin, settings, rbac, payments (refunds) |
| `cmsService` | 88 | cms |
| **Total** | **249** | 18 modules |

249 service methods do **not** become 249 endpoints. They collapse because:

- `adminService` and `superAdminService` largely re-expose domain operations
  through a role lens. Per approved decision 4, these are **authorization
  surfaces**, not separate implementations: `adminService.getStudents()` and a
  student's own profile read both resolve to the `students` module with
  different role guards and filters.
- `cmsService` holds 12 pure sync/async duplicate pairs (`saveCollegePartner`
  and `saveCollegePartnerAsync` are the same operation).
- Many `get*` methods are a list and a by-id read of the same resource.
- `toggle*` methods become a `PATCH` on the resource, not a bespoke verb.

**Result: 238 endpoints across 18 modules** (237 proposed + the one built).
Counts per module in section 14.6.

---

## 3. Global conventions

### 3.1 Base path and versioning

All endpoints live under `/api/v1`. The version is applied once in
`src/routes/index.ts` and must never be repeated inside a module router.
A breaking change ships as `/api/v2` rather than mutating v1 in place.

### 3.2 Authentication

Bearer token in the `Authorization` header — confirmed by the frontend's
request interceptor, which reads `localStorage[nexelvoria_auth_token]` and sets
`Authorization: Bearer <token>`:

```
Authorization: Bearer <token>
```

The frontend's response interceptor already treats **401** as "unauthorized",
so the backend must use 401 for *authentication* failures only, and 403 for
*authorization* failures. Confusing the two will cause spurious logouts in the UI.

Token format (JWT vs opaque session token) is **unresolved** — see
open-questions Q13, which is blocking for the auth module.

### 3.3 Authorization and role inheritance

Role values are fixed by the frontend and must not be renamed:
`public`, `student`, `teacher`, `admin`, `super_admin`.

Authoritative from `src/routes/AppRoutes.tsx`:

| Frontend route group | Guard | Backend implication |
| --- | --- | --- |
| public pages | none | no auth |
| `/student/*` | `['student']` | student only |
| `/teacher/*` | `['teacher']` | teacher only |
| `/admin/*` | `['admin', 'super_admin']` | **`super_admin` inherits every admin endpoint** |
| `/super-admin/*` | `['super_admin']` | super_admin only |

That inheritance is a real finding, not an assumption: wherever this document
lists roles as `admin`, read it as `admin + super_admin`. `SUPER_ADMIN_ONLY`
marks the endpoints `admin` must **not** reach.

**The audit actor is never accepted from the request.** Mock services take an
`admin: { id, name }` argument; the real API derives the actor from the session.
A client-supplied actor id would be trivially forgeable and would corrupt the
audit trail the UI already renders.

### 3.4 Response envelope

Success — `data` omitted when there is no payload:

```json
{ "success": true, "message": "optional", "data": {} }
```

Failure — emitted only by `error.middleware.ts`:

```json
{
  "success": false,
  "message": "human readable",
  "error": "MACHINE_CODE",
  "details": [{ "field": "email", "message": "Invalid email address" }]
}
```

### 3.5 Compatibility review of the existing `ApiResponse` contract

Required by task item 6. The frontend declares:

```ts
export interface ApiResponse<T> {
  success: boolean;
  data: T;          // required
  message?: string;
  error?: string;
}
```

Three findings:

1. **`data` is required in the frontend, optional in ours.** Mutation endpoints
   with nothing to return (`logout`, `resend OTP`) would have to invent a
   payload to satisfy it. **Recommendation:** the frontend relaxes this to
   `data?: T`. Low-risk — it widens the type. Tracked as Q9.
2. **`error` is `string` in the frontend; we emit a closed set of codes.**
   Compatible as-is (our codes are strings). We now publish the set as
   `ApiErrorCode` so the frontend can narrow it when ready.
3. **`details[]` has no frontend counterpart.** Additive and ignorable, so no
   breakage — but the UI cannot show field-level errors until it reads the
   field. Worth passing to the frontend developer, since registration and the
   test engine both have multi-field forms that would benefit.

No change was made to the frontend. Our envelope stays a superset.

### 3.6 Pagination

Shape is fixed by the frontend's `PaginatedResult<T>` and must not be renamed:

```json
{ "items": [], "total": 25, "page": 1, "pageSize": 10, "totalPages": 3 }
```

Request contract for every collection endpoint (implemented in
`listQuerySchema`):

| Param | Type | Default | Rules |
| --- | --- | --- | --- |
| `page` | integer | `1` | >= 1 |
| `pageSize` | integer | `10` | 1–100; default matches `APP_CONFIG.defaultPageSize` |
| `sortBy` | string | — | checked against a per-module allow-list |
| `sortOrder` | `asc` \| `desc` | `asc` | anything else is 422 |
| `search` | string | — | 1–120 chars, free text |

`page` and `pageSize` are **coerced** from strings, since query values always
arrive as text. Out-of-range values are rejected with 422, not silently clamped
— a request for `pageSize=9999` is a client bug worth surfacing.

List endpoints always return the paginated envelope, **even when the frontend
mock returns a bare array.** The mocks hold tens of rows; production holds
thousands. Returning `Student[]` unpaginated is a design error we would pay for
later, so `data` is always `PaginatedResult<T>` for collections.

### 3.7 Filtering

- Filters are explicit, typed query params, never a generic query language:
  `GET /students?status=active&approvalStatus=pending&courseId=...`
- Each module declares its filterable fields by extending `listQuerySchema`.
  Unknown params are ignored, not errors (forward compatibility).
- `search` is a per-module decision about which columns it spans; it must be
  documented per endpoint, because "search" over the wrong columns is a
  performance trap on MS SQL Server without the right indexes.

### 3.8 Sorting

`sortBy` arrives as an arbitrary string, so **every module must pass it through
`resolveSortField(requested, ALLOWED)`** before it reaches the data layer.
Verified behaviour: `?sortBy=name;DROP TABLE Students--` falls back to the
module default rather than propagating. This is mandatory, not advisory — it is
the boundary that keeps a client string out of an `ORDER BY` clause.

### 3.9 Dates and times

| Concern | Rule |
| --- | --- |
| Wire format | ISO-8601, UTC, `Z`-suffixed: `2026-11-17T07:30:00.000Z` (`IsoDateTime`) |
| Date-only fields | `YYYY-MM-DD` (`IsoDate`) — e.g. `AttendanceSession.sessionDate` |
| Storage | UTC always |
| Display timezone | `Asia/Kolkata`, per `APP_CONFIG.timezone` — a **frontend** concern |
| Never | local-time strings without an offset, or epoch numbers |

Caution for the academic domain: attendance, class schedules and test windows
are reasoned about by staff in IST. A session marked late evening IST can land
on the next UTC day. Attendance keys off `sessionDate` (`IsoDate`) rather than a
timestamp specifically to avoid that off-by-one-day bug. See Q15.

### 3.10 Identifiers

- Every id is a **string** on the wire; the frontend types require it.
- Path params use the entity name: `/students/:studentId`, not `/students/:id`,
  so nested paths stay readable.
- **Business codes are distinct from primary keys** and both are returned:
  `certificateNumber` (`NEX-2026-FSD-0042`), `ticketNumber` (`TKT-1082`),
  `batchCode` (`JFS-2026-B1`), `courseCode` (`CRS-JFS-101`), `receiptNumber`,
  `orderId`. Generation rules are unresolved — Q2.
- Public course URLs use `slug`, not id: `GET /courses/:slug`, matching the
  frontend route `/courses/:courseSlug`.
- MS SQL Server representation is the database team's call, but it must
  serialise to a string — Q1.

### 3.11 HTTP status codes

| Status | Used for |
| --- | --- |
| 200 | successful read, update, or an action with a body |
| 201 | resource created — `Location` header where meaningful |
| 204 | successful delete with no body |
| 400 | malformed request that is not a field-validation failure |
| 401 | missing, invalid or expired credentials (**authentication**) |
| 403 | authenticated but not permitted (**authorization**), incl. business-rule denial such as BR-013 |
| 404 | resource does not exist, or the caller may not know it exists |
| 409 | conflict — duplicate email, duplicate coupon code, batch at capacity |
| 422 | field-level validation failure, with `details[]` |
| 429 | rate limited — OTP resend, login attempts |
| 500 | unexpected server fault; message hidden in production |
| 503 | dependency unavailable (payment gateway, mail) |

Deliberate choices worth knowing: **404 not 403** when revealing existence
itself leaks information (a student probing `/students/:id` for other students).
**409 not 422** for uniqueness conflicts, since the field was well-formed and
only lost a race.

### 3.12 Error codes

Published as `ApiErrorCode` in `src/contracts/api.contract.ts`:
`VALIDATION_ERROR`, `BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`,
`ROUTE_NOT_FOUND`, `CONFLICT`, `TOO_MANY_REQUESTS`, `INTERNAL_SERVER_ERROR`.

Domain codes are added to that union when their module is built — e.g.
`OTP_EXPIRED`, `ACCOUNT_LOCKED`, `BATCH_FULL`, `PLACEMENT_ACCESS_DENIED`,
`ATTENDANCE_ALREADY_MARKED`. They are never invented ad hoc inside a service,
because the frontend branches on them.

---

## 4. Module: `auth`

Owning module: `auth`. Source: `authService` (18 methods).

| # | Method | Path | Purpose | Auth | Roles | Mark |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | POST | `/auth/login` | Authenticate, return token + user — **implemented, dev only; see 4.2** | No | public | [C] |
| 2 | POST | `/auth/register` | Student self-registration — **see 4.1** | No | public | [C] |
| 3 | POST | `/auth/otp/email/verify` | Verify email OTP — **implemented, dev only; see 4.3** | No | public | [C] |
| 4 | POST | `/auth/otp/mobile/verify` | ~~Verify mobile OTP~~ — **DESCOPED (Q3)** | No | public | [C] |
| 5 | POST | `/auth/otp/verify-dual` | ~~Verify both OTPs (BR-001)~~ — **DESCOPED (Q3)** | No | public | [C] |
| 6 | POST | `/auth/otp/email/resend` | Resend email OTP — **implemented, dev only; see 4.3** | No | public | [C] |
| 7 | POST | `/auth/otp/mobile/resend` | ~~Resend mobile OTP~~ — **DESCOPED (Q3)** | No | public | [C] |
| 8 | POST | `/auth/password/forgot` | Start reset by email or mobile | No | public | [C] |
| 9 | POST | `/auth/password/reset-otp/verify` | Verify reset OTP | No | public | [C] |
| 10 | POST | `/auth/password/reset` | Set new password using reset grant | No | public | [C] |
| 11 | POST | `/auth/password/change` | Change own password | Yes | all authenticated | [C] |
| 12 | GET | `/auth/me` | Current user from token | Yes | all authenticated | [C] |
| 13 | POST | `/auth/logout` | Invalidate current session | Yes | all authenticated | [C] |
| 14 | GET | `/auth/sessions` | List own active sessions | Yes | all authenticated | [C] |
| 15 | DELETE | `/auth/sessions/:sessionId` | Terminate one session | Yes | all authenticated | [C] |
| 16 | DELETE | `/auth/sessions` | Terminate all others | Yes | all authenticated | [C] |
| 17 | GET | `/auth/login-history` | Own login history | Yes | all authenticated | [C] |
| 18 | PUT | `/auth/two-factor` | Enable/disable 2FA | Yes | all authenticated | [C] |
| 19 | POST | `/auth/refresh` | Exchange refresh token | No (refresh token) | public | **[P]** |

### Key request and response shapes

```
POST /auth/login
  body:     { identifier: string, password: string }
            ("identifier" is email or mobile — the frontend login accepts both)
  200:      { success, data: { token, refreshToken?, user: User } }
  401:      UNAUTHORIZED        — bad credentials
  403:      ACCOUNT_LOCKED      — failedLoginAttempts exceeded (see security config)
  403:      ACCOUNT_PENDING     — email/mobile unverified, or awaiting admin approval
  429:      TOO_MANY_REQUESTS

POST /auth/register                       — see 4.1: LOCAL DEVELOPMENT ONLY today
  body:     StudentRegistrationFormData (frontend form type), minus
            `resumeDataUrl` — file storage is unresolved (Q11), so the field is
            accepted and DISCARDED, never persisted. A real upload would also
            exceed BODY_LIMIT (1mb) and be rejected with 413.
  201:      { success, data: { tempStudentId, email, mobile }, message }
  409:      CONFLICT            — email or mobile already registered
  422:      VALIDATION_ERROR    — details[] carries the field-level issues
  413:      PAYLOAD_TOO_LARGE   — body over BODY_LIMIT
  429:      TOO_MANY_REQUESTS   — 5 per IP per 15 minutes
  503:      SERVICE_UNAVAILABLE — a repository was unreachable; nothing written
  500:      INTERNAL_SERVER_ERROR — partial state was created; see 4.1

POST /auth/otp/verify-dual
  body:     { studentId, emailOtp: string, mobileOtp: string }
  200:      { success, data: StudentProfile }
  403:      OTP_EXPIRED | OTP_INVALID
  429:      TOO_MANY_REQUESTS
```

### 4.1 `POST /auth/register` — implementation status

**CORRECTED RESPONSE SHAPE (decision D2).** This document previously proposed
`{ studentId, otpChannels[] }`. The confirmed shape is
`{ tempStudentId, email, mobile }`, taken from the frontend, which is the
source of truth: `authService.registerStudent` is typed
`ApiResponse<{ tempStudentId, email, mobile }>` and `RegisterPage` navigates to
`/verify-otp?studentId=${result.tempStudentId}`. Amended per D2.

**IMPLEMENTED FOR LOCAL DEVELOPMENT ONLY. NOT PRODUCTION-READY.**

| | Local development | Production |
| --- | --- | --- |
| Route mounted | yes, by `dev/server.dev.ts` | **no** — `src/routes/index.ts` mounts no `/auth` |
| Storage | in-memory fakes, one process | none — no MS SQL Server adapter exists |
| Atomicity | **none** — three sequential writes | blocked on **Q-X1** |
| Entry point | `npm run dev:integration` | `npm start` (no registration endpoint) |

What is real in the local implementation: the validation schema (mirrors the
frontend field for field), argon2id hashing, the `role: "student"` and
`status: "pending"` the service fixes server-side, the shared
`Student.id === User.id` key (Q25 option A), the 409 uniqueness guard, the
standard error envelope, and every security layer `createApp()` installs.

What is NOT implemented, and must not be inferred from a 201:

- **No OTP.** No challenge is issued and no OTP endpoint exists (**Q3**
  unresolved: BR-001 wants dual OTP, BR-014 disables SMS). The account is left
  `pending` with both verification flags `false`, which is correct whichever
  way Q3 resolves. The 201 `message` deliberately does NOT promise an OTP step.
- **No login.** `POST /auth/login` is unmounted, so a registered account cannot
  yet sign in.
- **No resume storage** (**Q11**). Only `resumeFileName` and `resumeFileSize`
  are kept; `resumeDataUrl` is discarded.
- **No transaction.** The service writes the user, the credential and the
  student profile in three independent calls. A failure after the first leaves
  partial state that an operator must repair: the response is a generic 500 and
  the precise condition (`incomplete` vs `profile_incomplete`) is recorded in
  the log, never sent to the client.

**THE PRODUCTION BLOCKER.** Those three writes must become one atomic unit
before any production route is mounted — either
`dbo.USP_NXA_Register_Student`, if it wraps all three inserts in one
transaction, or the unit-of-work port of **Q-X1**. Until then four guards keep
this out of production: `dev/` is outside `tsconfig.json`'s `include` so it is
never built into `dist/`; `createProductionContainer()` registers no
repositories; the in-memory fakes throw under `NODE_ENV=production`; and
`dev/guard.dev.ts` refuses to load in a production process.

**Known and accepted:** a 409 that names the colliding field confirms an
address is registered, which is account enumeration. Kept because it is the
confirmed contract and the behaviour the frontend already has — see
auth-implementation-plan section 8.2. Changing it is a contract decision.

### Notes

- **Login returns the user object**, so the frontend's `AuthContext` can
  populate without a second round trip.
- **Account state gates login.** `AccountState` distinguishes
  `pending_verification` from `pending_approval`; the UI shows different
  screens, so these must be distinguishable error codes, not one generic 403.
- **`getCurrentUser()` and `switchRole()` are client-side in the mock.**
  `/auth/me` replaces the former. `switchRole` has **no backend equivalent** and
  is deliberately absent — a client that can change its own role is an
  authorization hole. Flagged as Q23; do not implement it without a decision.
- Dependencies: `students` (registration creates a student), `settings`
  (`security.maxFailedLogins`, `sessionTimeoutMinutes`), `notifications` (OTP
  and welcome mail).
- **Blocked by Q3** (dual OTP vs SMS disabled) and **Q13** (token strategy).

---

### 4.2 Login — implementation status

**Implemented at the Student Login integration, LOCAL DEVELOPMENT ONLY**,
behind the same four guards as 4.1.

```
POST /auth/login
  body:  { identifier: string, password: string, rememberMe?: boolean }
  200:   { success, data: { token, expiresIn, user }, message }
  401:   UNAUTHORIZED                   - wrong password OR unknown identifier
  403:   ACCOUNT_PENDING                - pending, reason indeterminate
  403:   ACCOUNT_PENDING_VERIFICATION   - + verificationTicket
  403:   ACCOUNT_PENDING_APPROVAL       - email verified, awaiting BR-002
  403:   ACCOUNT_LOCKED                 - consecutive failed sign-ins
  403:   ACCOUNT_SUSPENDED / ACCOUNT_DEACTIVATED
  422:   VALIDATION_ERROR
  429:   TOO_MANY_REQUESTS              - 10 per IP per 15 minutes
  503:   SERVICE_UNAVAILABLE
```

**THE 401 IS DELIBERATELY INDISTINGUISHABLE.** A wrong password and an
unknown identifier return the same body. Account state is reported ONLY after
a correct password, which is why those codes are safe: anyone who sees one
already knows the password, so they already know the account exists.

**Six new members of `API_ERROR_CODES`.** The closed set gained
`ACCOUNT_PENDING`, `ACCOUNT_PENDING_VERIFICATION`,
`ACCOUNT_PENDING_APPROVAL`, `ACCOUNT_LOCKED`, `ACCOUNT_SUSPENDED` and
`ACCOUNT_DEACTIVATED`. The UI renders a different screen per state and must
branch on a code, never on prose.

**`ACCOUNT_PENDING` is the indeterminate case, and never a guess.** `pending`
means either "verify your email" or "wait for an admin", and only the student
record distinguishes them. When that record is unavailable, missing, or the
lookup fails, the generic code is returned — reporting
`ACCOUNT_PENDING_APPROVAL` instead would tell a student to wait for something
that is never coming.

**NO REFRESH TOKEN IS RETURNED.** `login.service.ts` forbids it until decision
**D4** settles transport: the frontend keeps its access token in
`localStorage`, and a long-lived refresh token in the same place is a
materially worse exposure. `refreshToken?` is optional in the table above, so
omitting it is compliant — but `/auth/refresh` cannot work until D4 lands, and
a session therefore ends when the access token expires.

#### Verification tickets

`ACCOUNT_PENDING_VERIFICATION` carries a **`verificationTicket`** on the
failure envelope — the only domain-specific field on it, so a student with the
right password but an unverified email can go straight to the OTP screen.

It is opaque, expires in **15 minutes**, and is separated from an access token
three ways: a **different signing key** (HKDF from `JWT_SECRET` under its own
label), a **different audience** (`<JWT_AUDIENCE>:email-verification`), and an
explicit **`purpose` claim**. It also carries neither `sid` nor `role`, so
`verifyAccessToken` refuses it twice over. **A ticket cannot authenticate
anything**, and an access token is not accepted as a ticket.

The OTP endpoints in 4.3 take `{ ticket, otp }` and `{ ticket }`. **They no
longer accept `studentId`**, so no internal identifier travels in a body or a
URL.

#### Registration payload — TRANSITIONAL

`POST /auth/register` now returns **four** fields:

```
201: { success, data: { tempStudentId, verificationTicket, email, mobile }, message }
```

`tempStudentId` is **retained for compatibility and deprecated**. It is a real
internal identifier and must never be placed in a URL; the frontend no longer
uses it for anything. `verificationTicket` is what a client carries forward.

---

### 4.3 Email verification — implementation status

**Implemented at Phase 3, LOCAL DEVELOPMENT ONLY**, alongside `/auth/register`
and behind the same four guards described in 4.1.

```
POST /auth/otp/email/verify
  body:  { studentId: string, otp: string }   otp = exactly 6 digits
  200:   { success, data: { studentId, isEmailVerified, accountState?,
                            awaitingAdminApproval }, message }
  400:   BAD_REQUEST        - wrong code (message carries attempts remaining),
                              expired, or no outstanding code
  404:   NOT_FOUND          - unknown studentId
  409:   CONFLICT           - already verified
  422:   VALIDATION_ERROR   - malformed body (does NOT spend an attempt)
  429:   TOO_MANY_REQUESTS  - 5-attempt ceiling reached, or IP rate limit

POST /auth/otp/email/resend
  body:  { studentId: string }
  200:   { success, data: { sentTo, expiresAt, resendAvailableAt }, message }
         sentTo is MASKED ("a***v@example.com") - the endpoint is public and
         never echoes a full address
  404 / 409 as above
  429:   TOO_MANY_REQUESTS  - 60s cooldown, or 5 sends per 15 minutes
```

**THIS IS NOT A LOGIN, AND RETURNS NO TOKEN.** The frontend mock it replaced
returned the whole `StudentProfile` and `AuthContext` called `setUser()` with
it, so a six-digit code was enough to become that student without a password.
The real endpoint reports status only: a verified student must still sign in,
and `login` applies its own gates. No profile field is returned either.

**`accountState` is DERIVED, never stored** — see
`src/modules/students/account-state.ts`. `pending_approval` after a successful
verification; `rejected` and `suspended` outrank verification.

**Registration now issues a code as a side effect.** `POST /auth/register`
still returns **exactly** the three D2 fields — whether a code went out is
reported in `message`, not as a fourth field. A delivery failure still returns
**201**, because the account really was created; the message then says the
code could not be sent and to use resend.

**Mobile and dual-OTP endpoints (#4, #5, #7) are NOT mounted.** Mobile OTP is
descoped: BR-014 disables SMS and open-questions **Q3** records the decision.
The frontend's mock implementations were deleted rather than left in place.

**Delivery is a logged passcode in development.** No mail provider is
configured, so `createLoggingOtpDelivery()` writes the code to the backend log
and refuses to be constructed under `NODE_ENV=production`.

---

## 5. Module: `students`

Owning module: `students`. Sources: `studentService`, `adminService` (student
operations).

| # | Method | Path | Purpose | Auth | Roles | Mark |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | GET | `/students` | List/search students | Yes | admin | [C] |
| 2 | POST | `/students` | Admin creates a student (optional direct enrolment) | Yes | admin | [C] |
| 3 | GET | `/students/:studentId` | Read one student | Yes | admin | [C] |
| 4 | PATCH | `/students/:studentId/status` | active / suspended / deactivated | Yes | admin | [C] |
| 5 | POST | `/students/:studentId/unlock` | Clear lockout after failed logins | Yes | admin | [C] |
| 6 | POST | `/students/:studentId/approve` | Approve registration (BR-002) | Yes | admin | [C] |
| 7 | POST | `/students/:studentId/reject` | Reject with mandatory remarks | Yes | admin | [C] |
| 8 | GET | `/students/me` | Own profile | Yes | student | [C] |
| 9 | PATCH | `/students/me` | Update own profile | Yes | student | [C] |
| 10 | POST | `/students/me/resume` | Upload résumé (multipart) | Yes | student | [C] |
| 11 | GET | `/students/me/dashboard` | Own dashboard aggregate | Yes | student | [C] |
| 12 | GET | `/students/:studentId/security` | Sessions, 2FA, lockout state | Yes | admin | [C] |

```
GET /students
  query:  page, pageSize, sortBy, sortOrder, search,
          status=active|pending|suspended|deactivated,
          approvalStatus=pending|approved|rejected,
          courseId, batchId, passingYear
  200:    { success, data: PaginatedResult<StudentProfile> }
  search spans: name, email, mobile, collegeName

POST /students/:studentId/reject
  body:   { remarks: string }     // mandatory — mock makes it required
  200:    { success, data: StudentProfile }
  409:    CONFLICT                — not in a rejectable state
```

### Notes

- **`/students?approvalStatus=pending` replaces a dedicated approvals endpoint**,
  even though the frontend has a separate approvals page. One collection, one
  filter — the page is a view, not a resource.
- **`/students/me` is a separate path from `/students/:studentId`** on purpose.
  It removes any chance of a student reaching another student's record by id,
  and it keeps the admin-only guard on the parameterised route simple.
- Approval is the BR-002 gate: a student cannot pay before `approved`. Enforced
  in `payments`, owned as state here.
- Résumé upload needs a storage decision — Q11.
- Dependencies: `enrollments` (direct enrolment on create), `auth` (lockout
  state), `admin` (audit log).
- **`PATCH /students/:studentId/status` (implemented, Task 3.2).** Body
  `{ "status": "active" | "suspended" | "deactivated" }`; `pending` and any
  other value is `422`; unknown student `404`; returns `StudentProfile`.
  **Writes `status` only — no `accountState` is stored** (approved D1,
  Option A).

  **UPDATED at Phase 5 Stage 0 — the integration concern below is resolved.**
  `accountState` is now **derived** from `status`, `isEmailVerified` and
  `adminApprovalStatus` when a response is built
  (`src/modules/students/account-state.ts`), not read from storage. Nothing
  persists it and the database needs no column.

  Consequences:
  - The admin list badge **now reflects a suspension immediately**. Previously
    it kept showing `approved`, because the stored value was never rewritten.
  - A response can no longer carry a stale `accountState`.
  - **A `deactivated` student now reports `accountState: "deactivated"`.**
    The member was added to the `AccountState` union on both sides during the
    Student Login integration; before that the derivation had to report
    nothing and the admin badge was blank for those students. The mapping is
    now total for every stored combination.
  - Precedence, which is tested: `rejected` and `suspended` outrank
    verification and approval; an unverified student reads
    `pending_verification` even once approved.

---

## 6. Module: `teachers`

| # | Method | Path | Purpose | Auth | Roles | Mark |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | GET | `/teachers` | List teachers | Yes | admin | [C] |
| 2 | POST | `/teachers` | Create teacher | Yes | admin | [C] |
| 3 | GET | `/teachers/:teacherId` | Read one | Yes | admin | [C] |
| 4 | PATCH | `/teachers/:teacherId` | Update teacher | Yes | admin | [C] |
| 5 | GET | `/teachers/me` | Own profile | Yes | teacher | [C] |
| 6 | PATCH | `/teachers/me` | Update own profile | Yes | teacher | [C] |
| 7 | POST | `/teachers/:teacherId/allocations` | Allocate to course + batch | Yes | admin | [C] |
| 8 | DELETE | `/teachers/:teacherId/allocations/:batchId` | Remove allocation | Yes | admin | [C] |
| 9 | GET | `/teachers/me/courses` | Assigned courses | Yes | teacher | [C] |
| 10 | GET | `/teachers/me/batches` | Assigned batches | Yes | teacher | [C] |
| 11 | GET | `/teachers/me/students` | Students across own batches | Yes | teacher | [C] |
| 12 | GET | `/teachers/me/dashboard` | Own dashboard aggregate | Yes | teacher | [C] |
| 13 | GET | `/teachers/public` | Public trainer profiles | No | public | [C] |

### Notes

- **Allocation is a sub-resource, not a flag.** `allocateTeacher(teacherId,
  courseId, batchId)` is a relationship with its own lifetime, so it gets
  `POST`/`DELETE` on a nested collection rather than a PATCH on the teacher.
- **`isCourseAssigned()` becomes authorization, not an endpoint.** The mock
  exposes it as a method; on the backend it is a guard the `courses` and
  `attendance` services apply. **This is the single most important
  authorization rule in the teacher surface:** a teacher may only read or
  mutate data for batches allocated to them. It must be enforced server-side on
  every teacher endpoint, never by trusting a `teacherId` from the client.
- `/teachers/public` overlaps CMS trainer profiles — Q20 asks which owns it.
- Dependencies: `batches`, `courses`, `rbac`.

---

## 7. Module: `courses`

| # | Method | Path | Purpose | Auth | Roles | Mark |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | GET | `/courses` | Public catalogue (published only) | No | public | [C] |
| 2 | GET | `/courses/:slug` | Course detail by slug | No | public | [C] |
| 3 | GET | `/courses/manage` | Full list incl. drafts | Yes | admin, teacher | [C] |
| 4 | GET | `/courses/manage/:courseId` | Read by id for editing | Yes | admin, teacher | [C] |
| 5 | POST | `/courses` | Create course | Yes | admin | [C] |
| 6 | PATCH | `/courses/:courseId` | Update metadata | Yes | admin, teacher* | [C] |
| 7 | PUT | `/courses/:courseId/curriculum` | Replace module/chapter/lesson tree | Yes | admin, teacher* | [C] |
| 8 | PATCH | `/courses/:courseId/status` | Draft/Published/Active/Inactive/Archived | Yes | admin | [C] |
| 9 | PATCH | `/courses/:courseId/publish` | Toggle `isPublished` | Yes | admin | [C] |

\* teacher only for courses allocated to them (`updateAssignedCourse`).

### Notes

- **Public and management reads are separate paths.** The public catalogue must
  never leak unpublished courses or internal fields, and `GET /courses/:slug`
  is anonymous. Overloading one path with a role-dependent response body is how
  draft content leaks.
- **Curriculum is `PUT`, not `PATCH`.** The frontend sends the whole
  `CourseModule[]` tree (`updateCourseCurriculum`), so this is a replacement.
  It needs optimistic concurrency — two admins editing one curriculum will
  silently overwrite each other otherwise. See Q24.
- `archiveCourse` is folded into `PATCH .../status` with `Archived`, rather
  than a separate verb.
- BR-003: `Lesson.isFreePreview` drives preview access for unpaid students.
  The course response must include it; enforcement lives in `enrollments`.
- `hasPlacementGuarantee` is surfaced but its terms are unexecuted — Q7.

---

## 8. Module: `batches`

| # | Method | Path | Purpose | Auth | Roles | Mark |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | GET | `/batches` | List batches | Yes | admin, teacher | [C] |
| 2 | GET | `/batches/:batchId` | Read one | Yes | admin, teacher | [C] |
| 3 | POST | `/batches` | Create batch | Yes | admin | [C] |
| 4 | PATCH | `/batches/:batchId` | Update batch | Yes | admin | [C] |
| 5 | PATCH | `/batches/:batchId/status` | upcoming/ongoing/completed/… | Yes | admin | [C] |
| 6 | PUT | `/batches/:batchId/meeting-url` | Set manual meeting link (BR-015) | Yes | admin, teacher* | [C] |
| 7 | GET | `/batches/:batchId/students` | Roster | Yes | admin, teacher* | [C] |
| 8 | GET | `/courses/:courseId/batches` | Batches open for a course | Yes | student, admin | [C] |

### Notes

- **Capacity is unenforceable today.** `maxCapacity` is optional and the SRS
  marks the limit as pending (`BATCH_CAPACITY_PENDING`). Until Q5 is answered we
  cannot return `409 BATCH_FULL`, which means enrolment has no capacity gate.
  This is a functional gap, not an oversight.
- BR-015: meeting URLs are manual. No Zoom/Meet API integration is in scope.
- `/courses/:courseId/batches` is owned by `batches` though nested under a
  course path — ownership follows the resource, not the URL prefix.

---

## 9. Module: `enrollments`

| # | Method | Path | Purpose | Auth | Roles | Mark |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | GET | `/enrollments` | List all enrolments | Yes | admin | [C] |
| 2 | POST | `/enrollments` | Admin enrols a student | Yes | admin | [C] |
| 3 | PATCH | `/enrollments/:enrollmentId/status` | Change lifecycle state | Yes | admin | [C] |
| 4 | POST | `/enrollments/requests` | Student requests self-enrolment | Yes | student | [C] |
| 5 | GET | `/enrollments/me` | Own enrolments + progress | Yes | student | [C] |
| 6 | POST | `/enrollments/me/lessons/:lessonId/complete` | Mark lesson complete | Yes | student | [C] |
| 7 | PUT | `/enrollments/me/lessons/:lessonId/bookmark` | Add bookmark | Yes | student | [C] |
| 8 | DELETE | `/enrollments/me/lessons/:lessonId/bookmark` | Remove bookmark | Yes | student | [C] |

### Notes

- **`toggleBookmarkLesson` becomes PUT + DELETE.** A toggle is not idempotent:
  a retried toggle flips twice. Explicit add/remove is safe to retry, which
  matters on mobile networks.
- **`EnrollmentStatus` is the backbone of access control.** `approved_unpaid`
  grants preview-only access (BR-003); `active` grants full access. The
  `courses`/LMS read path must consult this, so enrolment state is the gate for
  content delivery, not just a label.
- `isAuthorizedFreeAccess` grants full access without payment via a financial
  override — a cross-module rule (see section 15).
- Dependencies: `students` (must be `approved` first, BR-002), `payments`
  (activation), `courses`, `batches`.

---

## 10. Module: `attendance`

| # | Method | Path | Purpose | Auth | Roles | Mark |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | POST | `/attendance/sessions` | Record a session with all entries | Yes | teacher | [C] |
| 2 | GET | `/attendance/sessions` | List sessions | Yes | teacher*, admin | [C] |
| 3 | GET | `/attendance/sessions/:sessionId` | Read one session | Yes | teacher*, admin | [C] |
| 4 | PATCH | `/attendance/sessions/:sessionId/records/:studentId` | Correct one record, audited | Yes | admin | [C] |
| 5 | GET | `/attendance/me` | Own attendance + summary | Yes | student | [C] |
| 6 | GET | `/attendance/summary` | Batch-level summary | Yes | teacher*, admin | [C] |

```
POST /attendance/sessions
  body:  { batchId, courseId, sessionDate: IsoDate, topicCovered,
           entries: [{ studentId, status: "present"|"absent"|"leave", note? }] }
  201:   { success, data: AttendanceSession }
  403:   FORBIDDEN                    — batch not allocated to this teacher
  409:   ATTENDANCE_ALREADY_MARKED    — (batchId, sessionDate) already exists

PATCH /attendance/sessions/:sessionId/records/:studentId
  body:  { status, auditRemarks: string }   // remarks mandatory
```

### Notes

- **BR-010 is a closed set: `present` | `absent` | `leave`.** No other value is
  accepted. The whole session posts as one atomic write — a half-marked
  register corrupts the percentages that drive certificate eligibility.
- **`(batchId, sessionDate)` must be unique**, hence the 409. Without it, a
  double submit silently doubles a student's session count and quietly changes
  their attendance percentage — and therefore their BR-011 eligibility.
- **Corrections are audited, never silent.** `auditRemarks` is mandatory, and
  the session carries `lastModifiedByUserId` + `modificationAuditNote`.
- **`attendancePercentage` is derived, never stored as the source of truth.** It
  feeds BR-011 (>= 75%) and placement eligibility (BR-013).
- Dependencies: `batches`, `certificates` (eligibility), `placements`.

---

## 11. Module: `assignments`

| # | Method | Path | Purpose | Auth | Roles | Mark |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | GET | `/assignments` | List assignments | Yes | teacher*, admin | [C] |
| 2 | POST | `/assignments` | Create assignment | Yes | teacher | [C] |
| 3 | GET | `/assignments/:assignmentId` | Read one | Yes | teacher*, admin | [C] |
| 4 | PATCH | `/assignments/:assignmentId` | Update assignment | Yes | teacher* | [C] |
| 5 | GET | `/assignments/me` | Own assignments + submission state | Yes | student | [C] |
| 6 | POST | `/assignments/:assignmentId/submissions` | Submit work | Yes | student | [C] |
| 7 | GET | `/assignments/:assignmentId/submissions` | List submissions | Yes | teacher*, admin | [C] |
| 8 | PATCH | `/assignments/submissions/:submissionId/evaluation` | Grade + feedback | Yes | teacher* | [C] |

### Notes

- Submission methods are constrained by the assignment's
  `allowedSubmissionMethods` (`file_upload`, `text`, `zip_upload`,
  `github_link`) — a mismatch is 422, not a silent accept.
- File-bearing submissions need the storage decision in Q11; `github_link` and
  `text` are implementable without it.
- `status` is `submitted` | `graded` | `resubmit_required`, so re-submission
  after `resubmit_required` must be allowed — but late/duplicate submission
  policy is unspecified (Q4, grace period exists in `SystemConfig.academic`).

---

## 12. Module: `assessments`

| # | Method | Path | Purpose | Auth | Roles | Mark |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | GET | `/assessments/tests` | List tests | Yes | teacher*, admin | [C] |
| 2 | POST | `/assessments/tests` | Create test with questions | Yes | teacher | [C] |
| 3 | GET | `/assessments/tests/:testId` | Read test (full, with answers) | Yes | teacher*, admin | [C] |
| 4 | PATCH | `/assessments/tests/:testId` | Update test | Yes | teacher* | [C] |
| 5 | GET | `/assessments/tests/me` | Own available tests | Yes | student | [C] |
| 6 | GET | `/assessments/tests/:testId/paper` | Sanitised paper for attempt | Yes | student | **[P]** |
| 7 | POST | `/assessments/tests/:testId/attempts` | Start an attempt | Yes | student | [C] |
| 8 | PUT | `/assessments/attempts/:attemptId/submit` | Submit answers | Yes | student | [C] |
| 9 | GET | `/assessments/attempts` | List attempts | Yes | teacher*, admin | [C] |
| 10 | GET | `/assessments/attempts/me` | Own attempts + scores | Yes | student | [C] |
| 11 | PATCH | `/assessments/attempts/:attemptId/evaluation` | Manually grade open answers | Yes | teacher* | [C] |
| 12 | POST | `/assessments/attempts/:attemptId/retake/request` | Student requests retake | Yes | student | [C] |
| 13 | POST | `/assessments/attempts/:attemptId/retake/authorize` | Authorise retake | Yes | teacher, admin | [C] |
| 14 | POST | `/assessments/attempts/:attemptId/retake/reject` | Reject with reason | Yes | teacher, admin | [C] |

### Notes

- **Endpoint 6 is the most important [P] in this document.** `Question` carries
  `correctAnswers` and `explanation`. If the student's test engine fetches the
  test through endpoint 3, **the answer key ships to the browser** and the
  assessment is worthless. A separate sanitised projection — no
  `correctAnswers`, no `explanation` — is required. This is a design flaw we
  would inherit from the mock, where everything reads one localStorage blob.
- **Scoring is server-side only.** `submitTestAttempt` passes answers and the
  mock computes the score locally. The real API must score on the server;
  `totalScore` and `isPassed` from a client are not trustworthy.
- `mcq`, `multiple_select`, `true_false` auto-score. `short_answer` and `coding`
  need manual evaluation, so an attempt is `submitted` before `evaluated` —
  partial auto-scoring is required. Q19.
- Retakes have two authorisers: teacher (`authorizeTestRetake`) and admin with
  override (`retakeOverrideByAdmin`, BR-012 — a rule the frontend references but
  `businessRules.ts` does not define; see Q4).
- `passingPercentage` defaults to 60 per test, but `SystemConfig.academic.passPercentage`
  is global and course-level overrides are pending — three sources of truth, Q8.
- Dependencies: `certificates` (BR-011 exam score), `courses`, `batches`.

---

## 13. Modules: `payments`, `certificates`, `placements`, `support`, `notifications`

### 13.1 `payments`

| # | Method | Path | Purpose | Auth | Roles | Mark |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | POST | `/payments/coupons/validate` | Validate coupon for course + amount | Yes | student | [C] |
| 2 | POST | `/payments/orders` | Create gateway order server-side | Yes | student | **[P]** |
| 3 | POST | `/payments/orders/:orderId/verify` | Verify gateway signature | Yes | student | **[P]** |
| 4 | POST | `/payments/webhook` | Razorpay webhook receiver | No (HMAC) | public | **[P]** |
| 5 | GET | `/payments` | List all transactions | Yes | admin | [C] |
| 6 | GET | `/payments/me` | Own payment history | Yes | student | [C] |
| 7 | POST | `/payments/manual` | Record offline payment | Yes | admin | [C] |
| 8 | GET | `/payments/discounts` | List coupons | Yes | admin | [C] |
| 9 | POST | `/payments/discounts` | Create coupon | Yes | admin | [C] |
| 10 | PATCH | `/payments/discounts/:discountId` | Update / toggle active | Yes | admin | [C] |
| 11 | DELETE | `/payments/discounts/:discountId` | Delete coupon | Yes | admin | [C] |
| 12 | GET | `/payments/refunds` | List refund requests | Yes | admin, super_admin | [C] |
| 13 | POST | `/payments/refunds` | Raise a refund request | Yes | admin | [C] |
| 14 | POST | `/payments/refunds/:refundId/approve` | Approve (BR-006) | Yes | **super_admin only** | [C] |
| 15 | POST | `/payments/refunds/:refundId/reject` | Reject, reason mandatory | Yes | **super_admin only** | [C] |

**Notes — the highest-risk module.**

- **Endpoints 2–4 are mandatory, not optional.** The mock's
  `processRazorpayPayment` fabricates a transaction client-side. A real
  integration *must* create the order server-side, verify the signature, and
  reconcile via webhook. **Trusting a client-reported payment success would let
  anyone activate an enrolment for free.** This is the single largest gap
  between the mock and a shippable backend.
- **BR-005: no instalments.** Lump sum only; no partial-payment schedule.
- **BR-006: only `super_admin` approves refunds** — the one place `admin` is
  explicitly excluded from an otherwise admin-ish flow.
- **Amounts are integer INR (paise for the gateway), never floats.** Coupon
  maths must be server-side: `finalAmountINR` from a client is untrusted input.
- Refund *window* is unresolved (Q6) so eligibility cannot be enforced yet.
- Dependencies: `enrollments` (activation on success), `students` (BR-002
  approval gate), `notifications` (receipt), `settings` (gateway keys),
  `super-admin` (overrides).

### 13.2 `certificates`

| # | Method | Path | Purpose | Auth | Roles | Mark |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | GET | `/certificates` | List issued certificates | Yes | admin | [C] |
| 2 | POST | `/certificates` | Issue a certificate | Yes | admin | [C] |
| 3 | POST | `/certificates/:certificateId/revoke` | Revoke, reason mandatory | Yes | admin | [C] |
| 4 | GET | `/certificates/me` | Own certificates | Yes | student | [C] |
| 5 | GET | `/certificates/me/eligibility` | Eligibility breakdown for a course | Yes | student | [C] |
| 6 | GET | `/certificates/verify/:code` | **Public** verification by number/QR | No | public | [C] |

- **Endpoint 6 is deliberately anonymous** — it backs `/verify-certificate` and
  the QR code, so employers must reach it without an account. It must return a
  minimal projection (name, course, dates, valid/revoked) and **must be rate
  limited**: an open endpoint keyed by a guessable `NEX-2026-FSD-0042` pattern is
  an enumeration target.
- **BR-011: attendance >= 75% and exam >= 60%.** Server recomputes both at issue
  time; `CertificateEligibilityCheck.missingRequirements` is already rendered by
  the UI, so eligibility must be explained, not just denied.
- Issuing with explicit percentages (`issueCertificate`) lets an admin bypass
  BR-011. Whether that is intended is Q10.

### 13.3 `placements`

| # | Method | Path | Purpose | Auth | Roles | Mark |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | GET | `/placements/jobs` | Eligible openings (student) / all (admin) | Yes | student, admin | [C] |
| 2 | POST | `/placements/jobs` | Create opening | Yes | admin | [C] |
| 3 | GET | `/placements/jobs/:jobId` | Read opening | Yes | student, admin | [C] |
| 4 | PATCH | `/placements/jobs/:jobId` | Update / deactivate | Yes | admin | [C] |
| 5 | POST | `/placements/jobs/:jobId/applications` | Apply (BR-013) | Yes | student | [C] |
| 6 | GET | `/placements/applications` | All applications | Yes | admin | [C] |
| 7 | GET | `/placements/applications/me` | Own applications | Yes | student | [C] |
| 8 | PATCH | `/placements/applications/:applicationId/status` | Advance pipeline | Yes | admin | [C] |
| 9 | GET | `/placements/companies` | Hiring companies | Yes | student, admin | [C] |
| 10 | POST | `/placements/companies` | Add company | Yes | admin | [C] |
| 11 | PATCH | `/placements/companies/:companyId` | Update company | Yes | admin | [C] |
| 12 | GET | `/placements/mock-interviews` | List scheduled interviews | Yes | teacher*, admin | [C] |
| 13 | POST | `/placements/mock-interviews` | Schedule interview | Yes | admin | [C] |
| 14 | GET | `/placements/mock-interviews/me` | Own interviews | Yes | student | [C] |
| 15 | PUT | `/placements/mock-interviews/:interviewId/feedback` | Submit feedback report | Yes | teacher | [C] |

- **BR-013: placement access is restricted to paid/enrolled students.** Enforced
  on 1, 3, 5, 7, 14 — a `403 PLACEMENT_ACCESS_DENIED` for `approved_unpaid`.
- **Per-job eligibility is separate from BR-013**: `JobOpening.eligibilityCriteria`
  adds minimum attendance, minimum exam score, eligible courses and passing
  years. So endpoint 1 filters by *computed* student metrics, making it the most
  cross-module read in the system (attendance + assessments + enrollments).
- `InterviewQuestion` exists as a type with no service method — an unbuilt
  question bank. Not proposed as an endpoint; noted in Q20.

### 13.4 `support`

| # | Method | Path | Purpose | Auth | Roles | Mark |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | GET | `/support/tickets` | All tickets | Yes | admin | [C] |
| 2 | GET | `/support/tickets/me` | Own tickets | Yes | student | [C] |
| 3 | POST | `/support/tickets` | Raise a ticket | Yes | student | [C] |
| 4 | GET | `/support/tickets/:ticketId` | Thread with messages | Yes | student*, admin | [C] |
| 5 | POST | `/support/tickets/:ticketId/messages` | Reply | Yes | student*, admin | [C] |
| 6 | PATCH | `/support/tickets/:ticketId` | Status / priority / assignee | Yes | admin | [C] |

\* own ticket only. `TicketMessage.senderRole` includes `super_admin`, so staff
replies must carry the real role, derived from the session.

### 13.5 `notifications`

| # | Method | Path | Purpose | Auth | Roles | Mark |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | GET | `/notifications/me` | Own notifications | Yes | all authenticated | [C] |
| 2 | PATCH | `/notifications/:notificationId/read` | Mark one read | Yes | all authenticated | **[P]** |
| 3 | POST | `/notifications/me/read-all` | Mark all read | Yes | all authenticated | **[P]** |
| 4 | GET | `/notifications` | All notifications | Yes | admin | [C] |
| 5 | POST | `/notifications/broadcast` | Broadcast to a group | Yes | admin | [C] |

- `InAppNotification.isRead` exists but no mock method sets it — hence 2 and 3
  are [P]. Without them the flag can never change.
- **Category mismatch, confirmed:** `InAppNotification.category` allows
  `announcement | assignment | exam | payment | placement | system`, while
  `sendBroadcastNotification` sends `academic | exam | placement | general | fee`.
  These two sets disagree; the backend cannot satisfy both. See Q18.
- BR-014 (SMS disabled) means in-app + email only at launch.

---

## 14. Modules: `cms`, `settings`, `rbac`, `admin`, `super-admin`

### 14.1 `cms` — 88 methods, 65 endpoints

Rather than enumerate 65 near-identical rows, CMS follows two mechanical
patterns. Public reads are anonymous; all writes are `admin`.

**Pattern A — collection resources**

```
GET    /cms/{resource}              public, published items only       [C]
GET    /cms/manage/{resource}       admin, all items incl. unpublished [C]
POST   /cms/manage/{resource}       admin, create                      [C]
PATCH  /cms/manage/{resource}/:id   admin, update / toggle active      [C]
DELETE /cms/manage/{resource}/:id   admin, delete                      [C]
```

Resources: `banners`, `articles` (also `GET /cms/articles/:slug`), `faqs`,
`testimonials`, `achievements`, `trainers`, `careers`, `hiring-partners`,
`college-partners`, `corporate-training-services`, `media-assets`.

Two extras: `PATCH /cms/manage/{resource}/:id/status` (college partners,
corporate training services) and `PUT /cms/manage/corporate-training-services/reorder`
(explicit ordering).

**Pattern B — singleton configs**

```
GET  /cms/configs/:key          public read of page config            [C]
PUT  /cms/manage/configs/:key   admin replace                         [C]
POST /cms/manage/configs/:key/reset  admin restore defaults           [C]
```

Keys: `home`, `about-us`, `marquee`, `college-partnerships`,
`corporate-training`, `contact-info`, `social-links`, `header-footer`, `seo`.

**Enquiries** (public write, admin read):

```
POST  /cms/enquiries                       public submit (rate limited) [C]
GET   /cms/manage/enquiries                admin list                  [C]
PATCH /cms/manage/enquiries/:enquiryId     admin update status          [C]
```

**Exact CMS count** — not every resource needs all five verbs:

| Resource | Endpoints | Why |
| --- | --- | --- |
| banners, faqs, testimonials, achievements, trainers, careers, hiring-partners | 5 each = 35 | full Pattern A |
| articles | 6 | adds public `GET /cms/articles/:slug` |
| college-partners | 7 | adds `GET manage/:id` + `PATCH /:id/status` |
| corporate-training-services | 8 | adds `GET manage/:id`, `PATCH /:id/status`, `PUT /reorder` |
| media-assets | 3 | list, upload, delete only — no public read, no update |
| configs (9 keys, generic `:key`) | 3 | GET, PUT, POST reset |
| enquiries | 3 | public submit, admin list, admin update |
| **Total** | **65** | |

Notes:

- **A generic `:key` config endpoint is a deliberate trade-off.** Nine typed
  endpoints would be more type-safe; one keyed endpoint keeps the router small
  and matches a UI that edits each config as a blob. The key is validated
  against a closed enum, and each key gets its own zod schema — so the
  *payload* is still strictly typed.
- The 10 `reset*` methods become the `/reset` action. What "default" means
  (hardcoded seed vs last published) is Q20.
- `POST /cms/enquiries` is the only public write in the entire API. It needs
  rate limiting and spam protection.
- CMS is the largest module and the least coupled — ideal for parallel work by
  the second developer.

### 14.2 `settings`

| # | Method | Path | Purpose | Auth | Roles | Mark |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | GET | `/settings/institute` | Institute settings | Yes | admin | [C] |
| 2 | PUT | `/settings/institute` | Update institute settings | Yes | admin | [C] |
| 3 | GET | `/settings/system` | Full `SystemConfig` | Yes | **super_admin only** | [C] |
| 4 | PUT | `/settings/system` | Update `SystemConfig` | Yes | **super_admin only** | [C] |
| 5 | POST | `/settings/system/test-email` | Send a test email | Yes | **super_admin only** | [C] |
| 6 | GET | `/settings/public` | Name, support contacts, timezone | No | public | **[P]** |

- **Secrets must never leave the server in clear text.** `SystemConfig` already
  names fields `keySecretMasked`, `smtpPasswordMasked`, `smsApiKeyMasked` — the
  frontend expects masked values. `PUT` must treat an unchanged masked value as
  "no change" rather than writing the literal mask back over a real secret.
  That is an easy and damaging bug to introduce.
- `SystemConfig` overlaps `InstituteSettings` (name, support email, timezone,
  minimum attendance) and both are editable by different roles. Two writable
  sources for one value will drift — Q16.
- `SystemConfig.academic.minAttendancePercentage` and `passPercentage` duplicate
  BR-011's constants, so BR-011 is configurable at runtime. Whether config may
  override a business rule is Q8.

### 14.3 `rbac`

| # | Method | Path | Purpose | Auth | Roles | Mark |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | GET | `/rbac/roles` | Role to permissions map | Yes | admin | [C] |
| 2 | PUT | `/rbac/roles/:role/permissions` | Replace a role's permissions | Yes | admin | [C] |
| 3 | GET | `/rbac/global-roles` | Custom roles | Yes | **super_admin only** | [C] |
| 4 | POST | `/rbac/global-roles` | Create custom role | Yes | **super_admin only** | [C] |
| 5 | PUT | `/rbac/global-roles/:slug/permissions` | Update custom role | Yes | **super_admin only** | [C] |
| 6 | GET | `/rbac/permissions` | Catalogue of permission keys | Yes | admin | **[P]** |

- **Three competing permission models exist in the frontend:** the fixed
  `UserRole` union, `AdminProfile.permissions: string[]`, and
  `GlobalRole.permissions: string[]` with `isSystemRole`. Which one actually
  authorises a request is **Q10 — blocking for the auth middleware**, and
  therefore for most of the backend.
- Endpoint 6 is [P] because a permissions UI needs the valid key list, which no
  mock method provides.

### 14.4 `admin` — orchestration only

Per approved decision 4, this module holds no duplicated domain logic.

| # | Method | Path | Purpose | Auth | Roles | Mark |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | GET | `/admin/dashboard` | Cross-domain KPI aggregate | Yes | admin | [C] |
| 2 | GET | `/admin/activity-logs` | Audit log feed | Yes | admin | [C] |
| 3 | GET | `/admin/reports` | Parameterised report data | Yes | admin | [C] |
| 4 | GET | `/admin/financial-overrides` | Own requested overrides | Yes | admin | [C] |
| 5 | POST | `/admin/financial-overrides` | Request a fee override | Yes | admin | [C] |

Everything else `adminService` exposes is reached through the domain modules
with an admin guard and filters — `getStudents` is `GET /students`, not an
`/admin/students`. That is the whole point of decision 4: one implementation,
two audiences.

### 14.5 `super-admin`

| # | Method | Path | Purpose | Auth | Roles | Mark |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | GET | `/super-admin/dashboard` | Institute-wide KPIs | Yes | super_admin | [C] |
| 2 | GET | `/super-admin/admins` | List admins | Yes | super_admin | [C] |
| 3 | POST | `/super-admin/admins` | Create admin | Yes | super_admin | [C] |
| 4 | PATCH | `/super-admin/admins/:adminId` | Update admin | Yes | super_admin | [C] |
| 5 | PATCH | `/super-admin/admins/:adminId/status` | Activate / suspend | Yes | super_admin | [C] |
| 6 | POST | `/super-admin/admins/:adminId/reset-password` | Force reset | Yes | super_admin | [C] |
| 7 | GET | `/super-admin/audit-logs` | Full audit trail | Yes | super_admin | [C] |
| 8 | GET | `/super-admin/financial-overrides` | All override requests | Yes | super_admin | [C] |
| 9 | POST | `/super-admin/financial-overrides/:id/approve` | Approve override | Yes | super_admin | [C] |
| 10 | POST | `/super-admin/financial-overrides/:id/reject` | Reject, reason mandatory | Yes | super_admin | [C] |
| 11 | GET | `/super-admin/reports` | Institute-wide reports | Yes | super_admin | [C] |

- `recordSystemAuditLog` is **not** an endpoint. It is an internal service call;
  an API that lets a client write arbitrary audit entries would make the trail
  worthless.
- Approving a financial override sets `Enrollment.isAuthorizedFreeAccess`,
  granting course access without payment — a payments/enrollments coordination
  point (section 15).

### 14.6 Endpoint counts

| Module | Endpoints | of which [P] |
| --- | --- | --- |
| auth | 19 | 1 |
| students | 12 | 0 |
| teachers | 13 | 0 |
| courses | 9 | 0 |
| batches | 8 | 0 |
| enrollments | 8 | 0 |
| attendance | 6 | 0 |
| assignments | 8 | 0 |
| assessments | 14 | 1 |
| payments | 15 | 3 |
| certificates | 6 | 0 |
| placements | 15 | 0 |
| support | 6 | 0 |
| notifications | 5 | 2 |
| cms | 65 | 0 |
| settings | 6 | 1 |
| rbac | 6 | 1 |
| admin | 5 | 0 |
| super-admin | 11 | 0 |
| health (**built**) | 1 | 0 |
| **Total** | **238** | **9** |

So **237 proposed endpoints** plus the one already implemented. The nine [P]
endpoints are the ones with no frontend counterpart: `auth/refresh`,
`assessments/tests/:testId/paper`, three payment-gateway endpoints, two
notification read-state endpoints, `settings/public`, and `rbac/permissions`.

---

## 15. Business rules requiring cross-module coordination

These are the rules no single module can own. Each needs a decision about
*where* it is enforced before the modules are built, or it will be enforced
twice and inconsistently.

| Rule | Spans | Coordination required |
| --- | --- | --- |
| **BR-001** dual OTP | auth, notifications, settings | Both channels must verify before the account activates — but SMS is off (BR-014). **Blocking, Q3.** |
| **BR-002** approval before payment | students, enrollments, payments | `payments` must reject unless the student is `approved`. Owned by `students`, enforced in `payments`. |
| **BR-003** preview-only when unpaid | enrollments, courses | Content delivery consults `EnrollmentStatus` + `Lesson.isFreePreview`. Enforced in the course/LMS read path, state owned by `enrollments`. |
| **BR-005** no instalments | payments | Single-module, but constrains the enrolment activation path. |
| **BR-006** super-admin-only refunds | payments, super-admin | Only place `admin` is excluded from an admin-shaped flow. |
| **BR-011** certificate thresholds | certificates, attendance, assessments | Attendance % and exam % are computed in two other modules; `certificates` must read both and may not cache them. |
| **BR-012** admin retake override | assessments, admin | Referenced by the frontend, undefined in `businessRules.ts`. **Q4.** |
| **BR-013** placements for paid students | placements, enrollments, attendance, assessments | Per-job eligibility also needs attendance and exam metrics — the widest read in the system. |
| **BR-014** SMS disabled | notifications, auth, settings | Directly contradicts BR-001. **Blocking, Q3.** |
| **BR-015** manual meeting links | batches, teachers | No calendar integration; link is free text, so it must be URL-validated. |
| **Financial override** | super-admin, payments, enrollments | Approval grants free course access, bypassing payment. |
| **Audit trail** | every module | Every mutating staff action writes an `AuditLogEntry`. Cross-cutting: belongs in middleware or a shared service, **not** re-implemented per module. |
| **Suspended / deactivated students cannot log in** | students, auth | **Requirement for Developer 1 (auth), recorded at Task 3.2.** `students` sets `status` (`PATCH /students/:studentId/status`); the real login flow must **explicitly refuse both `suspended` and `deactivated`** students, checking `status` (which is what the status endpoint writes — `accountState` is not updated). Note the frontend mock's student login checks `suspended` but **not** `deactivated`, so the mock must not be copied as-is. |

**Recommended seam for the audit trail:** a shared service called from domain
services (not middleware), because only the service knows the business meaning
of what changed. Deciding this before module work starts avoids 18 divergent
implementations.

---

## 16. What this step did not do

- No controllers, services, routes or validation schemas for any module.
- No authentication or authorization implementation.
- No database access, and no schema design (the database team owns that;
  `src/repositories/` holds our ports).
- No frontend changes.
- No new dependencies.

Only `GET /api/v1/health` is implemented and verified.
