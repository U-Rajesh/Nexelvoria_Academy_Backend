# NEXELVORIA Academy — Open Questions and Unresolved Decisions

**Audience:** the backend lead (decision owner), the two backend developers,
and — for the database and frontend items — those teams.
**Status:** raised at Step 3. None of these is decided.
**Last updated:** 2026-11-17

Each question states what is actually unresolved, what it blocks, the options,
and a recommendation. **A recommendation is not a decision** — nothing here has
been implemented, and nothing should be until the lead rules on it.

Priority key: **P0** blocks the next step of backend work. **P1** blocks a
specific module. **P2** should be settled before launch.

| # | Question | Priority | Decision owner |
| --- | --- | --- | --- |
| Q1 | Identifier type in MS SQL Server | P0 | DB team + lead |
| Q2 | Business code generation | P1 | lead + business |
| Q3 | **Dual OTP (BR-001) vs SMS disabled (BR-014)** | **P0** | lead + business |
| Q4 | Eight business rules referenced but undefined | P0 | business / SRS owner |
| Q4a | **Lockout policy: permanent or timed** | P1 | lead + business |
| Q5 | Batch capacity limit | P1 | administration |
| Q6 | Refund eligibility window | P1 | finance + legal |
| Q7 | Placement guarantee terms | P2 | legal |
| Q8 | Three sources of truth for pass marks | P1 | academic board |
| Q9 | Frontend `ApiResponse.data` required vs optional | P1 | lead + frontend |
| Q10 | Which permission model actually authorises | P0 | lead |
| Q11 | File upload and storage strategy | P0 | lead + infra |
| Q12 | Razorpay integration ownership | P1 | lead + finance |
| Q13 | Token strategy and session registry | P0 | lead |
| Q14 | 2FA methods when SMS is off | P1 | lead |
| Q15 | Timezone handling for academic dates | P1 | lead |
| Q16 | `SystemConfig` vs `InstituteSettings` overlap | P1 | lead |
| Q17 | MS SQL collation, uniqueness and case sensitivity | P1 | DB team |
| Q18 | Notification category mismatch + delivery channels | P1 | lead + frontend |
| Q19 | Auto vs manual test scoring | P1 | academic + lead |
| Q20 | CMS defaults, trainer ownership, question bank | P2 | lead |
| Q21 | Soft delete vs hard delete | P1 | lead + DB team |
| Q22 | Audit log immutability and retention | P2 | lead + compliance |
| Q23 | `switchRole` — client-side role switching | P1 | lead |
| Q24 | Concurrent edit protection | P2 | lead |

---

## Q3 — Dual OTP versus disabled SMS **(the central conflict)**

> **RESOLVED — EMAIL ONLY (confirmed by the backend lead, 2026-11-18).**
>
> The contradiction below is real and was escalated rather than guessed at.
> The decision: **BR-014 stands and BR-001 is reduced to a single channel.**
> Email OTP is implemented; mobile OTP is **descoped**, not deferred-and-
> forgotten, and this entry is the record of that.
>
> What that means concretely:
>
> - `Student.isMobileVerified` stays `false` for every student. Nothing
>   verifies a mobile number, and no code pretends otherwise.
> - `deriveAccountState()` does not read `isMobileVerified`. If it did, every
>   student would be stuck at `pending_verification` for ever.
> - Only `/auth/otp/email/verify` and `/auth/otp/email/resend` exist.
>   `/auth/otp/mobile/verify`, `/auth/otp/mobile/resend` and
>   `/auth/otp/verify-dual` are **not mounted**, and the frontend's mock
>   implementations of them were deleted rather than left in place.
> - `OtpPurpose` is still a closed SET with one member, and the OTP
>   repository is keyed by it, so adding `"mobile_verification"` later is an
>   additive change: no stored row, index or port signature has to change.
>
> **To reverse this**, an SMS provider must be chosen and provisioned
> (including DLT template registration for Indian numbers), BR-014 must be
> formally overridden, and the three routes above must be mounted. The
> original requirement asked for mobile OTP, so reversing it is a scope
> decision for the lead, not an implementation detail.


Listed first because it is the one the brief singled out, and because it blocks
the auth module entirely.

**The contradiction, in the frontend's own constants:**

```ts
// BR-001: Students must verify both email and mobile OTP
DUAL_OTP_REQUIRED: true,

// BR-014: SMS disabled at launch
SMS_SERVICE_ENABLED: false,
```

BR-001 requires a mobile OTP. BR-014 removes the only channel that can deliver
one. **As specified, no student can ever complete registration.** This is not a
gap in our understanding — the two rules are mutually exclusive, and the
frontend commits to both.

Corroborating evidence that both are real intentions, not a typo:

- `StudentProfile` carries **both** `isEmailVerified` and `isMobileVerified`.
- `authService` implements `verifyEmailOtp`, `verifyMobileOtp`, `verifyDualOtp`,
  `resendEmailOtp` **and** `resendMobileOtp` — five methods presuming two channels.
- `AccountState` includes `pending_verification` as a distinct state.
- `SystemConfig.emailSms` has `isSmsEnabled`, `smsProvider`, `smsApiKeyMasked`
  — SMS is built for, just switched off.
- `InstituteSettings.isSmsEnabled` is commented `// false as per BR-014`.
- `APP_CONFIG` has a `whatsappNumber`, hinting a third channel was considered.

**Options**

| Option | What it means | Cost | Risk |
| --- | --- | --- | --- |
| **A. Email-only at launch** | Verify email; store mobile unverified. `isMobileVerified = false` until SMS is enabled. | Low | BR-001 formally unmet; mobile numbers unverified in the data |
| **B. Both OTPs, mobile delivered by email** | Issue two codes, send both to email. | Low | Verifies nothing about the mobile number — security theatre, and arguably worse than A because the data *claims* verification |
| **C. Enable SMS** | Overturn BR-014, integrate a provider (MSG91/Twilio) | Provider cost, DLT registration for India, procurement time | Schedule risk; needs a budget decision |
| **D. WhatsApp OTP** | Use WhatsApp Business API instead of SMS | Medium-high | Meta approval process; BR-014 says nothing about it |
| **E. Admin approval substitutes** | Email OTP + manual admin verification of the mobile (BR-002 approval already exists) | Low | Manual load on admins; weak at scale |

**Recommendation: A for launch, with the backend built for B/C from day one.**

Concretely: implement a channel-agnostic OTP service with
`channel: "email" | "mobile"`, drive it from `SystemConfig.emailSms.isSmsEnabled`,
and have `/auth/otp/verify-dual` require only the enabled channels. Then
enabling SMS later is a configuration change, not a rewrite. Option A is
preferred over B because B records a verification that did not happen —
`isMobileVerified = true` would be a lie in the database, and someone will
later rely on it.

**What the decision must specify:**

1. Can a student register with an unverified mobile? (Yes under A.)
2. Does `verifyDualOtp` stay in the API, requiring only email for now?
3. Does BR-001 get formally amended in the SRS, or waived with a dated note?
4. Who owns re-enabling SMS, and is DLT registration already in progress?

Until this is answered, **the auth module cannot be built**, and auth gates
almost everything else. This is the critical path.

---

## Q1 — Identifier type in MS SQL Server 2025 (P0)

Now that the database is confirmed as MS SQL Server 2025, the key strategy
needs settling. The frontend types every id as `string`, so whatever is chosen
must serialise to a string.

| Option | Pros | Cons |
| --- | --- | --- |
| `UNIQUEIDENTIFIER` (GUID) | Generatable before insert; no cross-table collisions; safe to expose | 16 bytes; random GUIDs fragment clustered indexes badly |
| `UNIQUEIDENTIFIER` + `NEWSEQUENTIALID()` | Keeps GUID benefits, sequential so indexes behave | Only as a column default, not client-generated |
| `INT`/`BIGINT IDENTITY` | Compact, fast joins, best index behaviour | Enumerable in URLs; needs stringifying for the wire |
| `BIGINT IDENTITY` + public `UNIQUEIDENTIFIER` | Fast internally, opaque externally | Two keys per table, more complexity |

**Recommendation:** `BIGINT IDENTITY` as the clustered primary key, with the API
returning it as a string. If ids must be non-enumerable in URLs (a fair concern
for `/students/:studentId`), add the GUID surrogate. Avoid a random
`UNIQUEIDENTIFIER` clustered key — on SQL Server that is a known page-split
problem that will bite once tables grow.

**The backend needs only one commitment: ids are opaque strings on the wire.**
`EntityId` already encodes that, so module work is not blocked — but the DB team
should confirm before writing repository adapters.

---

## Q2 — Business code generation (P1)

The frontend displays human-facing codes the backend must produce:
`certificateNumber` (`NEX-2026-FSD-0042`), `ticketNumber` (`TKT-1082`),
`batchCode` (`JFS-2026-B1`), `courseCode` (`CRS-JFS-101`), `receiptNumber`,
`orderId`.

Unresolved: the exact format and segment meanings (is `FSD` a course
abbreviation? who assigns it?); whether counters reset annually; whether gaps
are acceptable; and whether codes must be strictly sequential — which matters
because **receipt numbers are often required to be gapless for audit**, and that
rules out casual approaches under concurrency.

**Recommendation:** define each format explicitly, and generate sequential
segments in the database (a sequence or an atomic counter table), not in
application code — two Node processes will otherwise race and issue duplicates.
Confirm with finance whether receipt numbers must be gapless.

---

## Q4 — Eight business rules referenced but never defined (P0)

`businessRules.ts` claims to map "BR-001 through BR-018" but defines only ten:
001, 002, 003, 005, 006, 010, 011, 013, 014, 015.

**Missing: BR-004, BR-007, BR-008, BR-009, BR-012, BR-016, BR-017, BR-018.**

This is not speculation — **BR-012 is actively referenced in the code**:
`TestAttempt.retakeOverrideByAdmin?: boolean; // BR-012`. So at least one
undefined rule already has an implementation obligation.

We need SRS v1.0 section-by-section for the eight missing rules before building
the modules they touch. Likely candidates, judging by gaps in the type model:
assignment late submission, attendance correction limits, session/account
lockout policy, data retention.

**Recommendation:** obtain the SRS and reconcile all 18 against the code.
**Do not infer these rules** — guessing a compliance rule is worse than being
blocked by it.

---

## Q10 — Which permission model actually authorises? (P0)

Three models coexist in the frontend and they are not reconciled:

1. `UserRole` — a fixed union of five values, used by every route guard.
2. `AdminProfile.permissions: string[]` — per-admin grants
   (`'manage_students'`, `'manage_courses'`, `'manage_payments'`).
3. `GlobalRole` — custom roles with `slug`, `permissions[]`, `isSystemRole`,
   `userCount`, created at runtime by super admins.

The route guards use only model 1. But `adminService.getRolesPermissions()`
returns `Record<string, string[]>`, and `superAdminService` can create entirely
new roles — which model 1 cannot represent, since `UserRole` is a closed union.

**This decides the shape of the authorization middleware**, which nearly every
endpoint depends on. Getting it wrong means rewriting every route guard.

| Option | Consequence |
| --- | --- |
| **A. Role-only** | Simple; `requireRole('admin')`. Makes the roles-permissions UI and `GlobalRole` decorative. |
| **B. Permission-only** | `requirePermission('manage_students')`; roles become permission bundles. Most flexible, most work, and the frontend's five hardcoded role guards still need mapping. |
| **C. Hybrid** | Role gates the surface (`/admin/*`), permissions gate the action. Matches what the frontend actually implements. |

**Recommendation: C.** Role for coarse access, permission for fine-grained
actions, with `super_admin` implicitly holding all permissions. It is the only
option consistent with both the route guards and the permissions UI. Needs a
canonical permission key list (hence the proposed `GET /rbac/permissions`).

---

## Q11 — File upload and storage (P0)

Confirmed upload needs across the frontend: student résumés
(`resumeUrl`, `resumeFileName`, `resumeFileSize`, `resumeDataUrl`), study
materials (with an `onProgress` callback, so large files), recorded class videos,
assignment submissions (file + zip), certificates, CMS media assets and banners,
offer letters, course thumbnails and syllabus PDFs.

Unresolved: storage target (local disk / Azure Blob / AWS S3 — Azure is the
natural pairing with SQL Server), direct-to-storage presigned uploads versus
proxying through the API, size and MIME limits per type, virus scanning for
student-supplied files, and access control for private files (a résumé must not
be publicly addressable).

Note `resumeDataUrl` suggests the mock base64-encodes files into localStorage.
**That must not carry over** — base64 in a database column will wreck both
payload sizes and SQL Server performance.

**Recommendation:** object storage (Azure Blob) with presigned direct upload,
the API storing only metadata and a key. Private files served through
short-lived signed URLs. Decide before `students`, `assignments` or `cms` are
built, since all three need it.

---

## Q13 — Token strategy and session registry (P0)

The frontend stores a bearer token in `localStorage` and expects:
`getActiveSessions`, `terminateSession`, `terminateOtherSessions`,
`getLoginHistory`, plus `SessionItem` with device, browser, OS, IP, location and
`isCurrent`.

**A stateless JWT cannot satisfy "terminate this session"** — that is the crux.
Server-side session state, or at minimum a revocation list, is required.

| Option | Fits requirements? |
| --- | --- |
| Stateless JWT only | No — cannot revoke a single session |
| JWT + server session registry | Yes — registry powers listing and revocation |
| Opaque token + server sessions | Yes, simplest to reason about; a lookup per request |
| Short JWT + refresh rotation | Yes, with a revocable refresh-token store |

**Recommendation:** short-lived access token plus a server-side session
registry keyed by refresh token — satisfying session listing, individual
termination and `SystemConfig.security.sessionTimeoutMinutes`. Also decide:
`localStorage` versus httpOnly cookie (the frontend already does
`localStorage`, which is XSS-exposed but already built), and whether
device/IP/location capture needs a geo-IP provider.

---

## Q4a — Lockout policy: permanent or timed? (P1, raised to blocking at Step 6G)

**This is the final form of O4**, and it now blocks the login service.

The credential repository (Step 6G) implements **counter-based permanent
lockout**: a credential is locked once `failedLoginAttempts >= threshold` and
stays locked until a password reset or an administrator unlock clears the
counter. There is no automatic time-based unlock.

**Why the timed option was removed rather than kept alongside it.** The first
implementation accepted a lock duration AND treated the counter at the
threshold as locked. Those two rules contradict each other: once the timestamp
elapsed, the counter was still at the threshold, so a "timed" lockout could
never actually expire. Keeping both would have meant either a lockout that
silently never expires, or silently adding an automatic unlock that weakens the
confirmed frontend behaviour. Neither is acceptable by default, so the timed
half was dropped and the single confirmed rule kept.

**Evidence for the implemented behaviour:** the frontend's lockout messages say
"Please reset your password" and "unlock via Forgot Password", it never
populates `lockedUntil`, and `authService` clears the counter on a successful
reset. So permanent-until-reset is what the completed UI describes.

**The decision needed:**

| Option | Consequence |
| --- | --- |
| **A. Permanent until reset or admin unlock** (implemented) | Matches the confirmed UI. A user locked out at 2am must reset their password or wait for an admin. Higher support load. |
| **B. Timed lockout** (e.g. 15 or 30 minutes) | Better UX for the honest forgetful user. **Requires deciding what happens to the counter when the timer expires** - reset it to 0, or leave it and lock again on the next failure? That decision is the contradiction above, and it must be made explicitly. |
| **C. Both** - timed lockout with escalation | Most forgiving and most complex; needs a policy table. |

**Recommendation: A for launch**, because it is what the frontend already tells
users, and revisit once there is real support data. If B is chosen, the counter
must be reset when the timer expires, and `lockedUntil` becomes the single
source of truth rather than a second one.

`lockedUntil` remains in the record and should remain in the schema either way;
under option A it is permanently NULL.

---

## Q5 — Batch capacity (P1)

`Batch.maxCapacity` is optional, `SystemConfig.academic.maxBatchCapacity` is
global, and the SRS says
`BATCH_CAPACITY_PENDING: 'Batch capacity limits pending administrative confirmation'`.

Unresolved: is there a hard cap; per-batch or global; can an admin override it;
does hitting it block self-enrolment only, or admin enrolment too; and is there
a waitlist? Until decided, **enrolment has no capacity gate** and
`409 BATCH_FULL` cannot be implemented.

**Recommendation:** global default in `SystemConfig`, per-batch override,
enforced for student self-enrolment and overridable by an admin with an audit
entry. Confirm whether a waitlist is in scope — if it is, it is a new domain
concept, not a flag.

---

## Q6 — Refund eligibility window (P1)

`REFUND_WINDOW_DAYS_PENDING: 'Refund eligibility window pending policy confirmation'`.
BR-006 settles *who* approves (super admin only) but not *when* a refund is
permissible, nor whether partial refunds exist (`RefundRequest.amountINR` is
free-form, implying they might), nor whether course progress affects
eligibility.

**Recommendation:** a configurable window in days from payment date, plus an
explicit decision on partial refunds. Needs finance and legal, and should align
with the public `/refund-policy` page the frontend already serves.

---

## Q7 — Placement guarantee terms (P2)

`Course.hasPlacementGuarantee: boolean` is already shown in the UI, but
`PLACEMENT_GUARANTEE_TERMS_PENDING: 'Placement guarantee legal agreement pending execution'`.

Displaying a guarantee with unexecuted terms is a **legal exposure**, not a
backend problem — flagged because the API exposes the flag. Unresolved: what the
guarantee entails, eligibility, and remedy on failure. No backend work depends
on it beyond returning the boolean.

---

## Q8 — Three sources of truth for pass marks (P1)

Three places define passing criteria, and they can disagree:

1. `BUSINESS_RULES.MIN_EXAM_SCORE_FOR_CERTIFICATE = 60` (BR-011)
2. `OnlineTest.passingPercentage` — per test, "default 60%"
3. `SystemConfig.academic.passPercentage` — global, runtime-editable

Plus `COURSE_PASSING_MARKS_OVERRIDE_PENDING` — course-level overrides are
pending academic board review, which would make a fourth.

The real question: **may runtime configuration override a business rule?** If
`SystemConfig` drops `passPercentage` to 40, is BR-011 violated or redefined?
The same applies to `minAttendancePercentage` versus BR-011's 75%.

**Recommendation:** establish precedence explicitly — a per-test
`passingPercentage` governs that test, while certificate eligibility uses BR-011
constants that config **cannot** weaken (config may tighten, not loosen). Record
the decision; it affects `assessments` and `certificates`.

---

## Q9 — `ApiResponse.data`: required or optional? (P1)

Frontend declares `data: T` as required; our envelope omits `data` when there is
no payload (`logout`, OTP resend, delete). Fully detailed in
`docs/api-contracts.md` section 3.5.

**Recommendation:** the frontend relaxes to `data?: T`. It widens the type, so
no existing frontend code breaks. The alternative — inventing payloads purely to
satisfy a type — adds noise to every mutation endpoint. Needs the frontend
developer's agreement since it is their file; we have not touched it.

---

## Q12 — Razorpay integration ownership (P1)

`processRazorpayPayment` currently fabricates a transaction client-side. A real
integration needs server-side order creation, signature verification, a webhook
receiver with HMAC validation, idempotent webhook handling, and refund API
calls (BR-006 approval must actually move money).

Unresolved: who holds the Razorpay account and keys; test versus live
credentials for development; whether refunds go through the API or are handled
manually in the Razorpay dashboard; and reconciliation
(`SystemConfig.paymentGateway.autoReconcile` exists).

**Recommendation:** backend owns all gateway interaction; the frontend only
opens checkout with a server-created `orderId`. **Never trust a client-reported
payment result** — see `api-contracts.md` section 13.1. Needs test keys before
the `payments` module can be built.

---

## Q14 — 2FA methods when SMS is disabled (P1)

`TwoFactorSettings.method` allows `authenticator | sms | email`, and
`SystemConfig.security.enforceTwoFactor` exists. But BR-014 disables SMS, so
that method is unavailable — the same conflict as Q3 in a second place.

Unresolved: which methods at launch; whether 2FA is optional or enforced per
role; backup code generation and storage; and whether `enforceTwoFactor`
applies to all roles or staff only.

**Recommendation:** TOTP authenticator plus email at launch, SMS hidden while
disabled. Enforce for `admin` and `super_admin`, optional for students.

---

## Q15 — Timezone handling for academic dates (P1)

`APP_CONFIG.timezone = 'Asia/Kolkata'` and `SystemConfig.institute.timezone` is
configurable. Storage is UTC (see conventions), but several decisions follow
from IST being the operating timezone:

- `AttendanceSession.sessionDate` is a date with no time — in which timezone is
  "today"? A 9pm IST class is already tomorrow in UTC, so a naive
  `new Date().toISOString().slice(0,10)` server-side **records attendance against
  the wrong day**. This is a concrete bug waiting to happen.
- Test windows (`startsAt`/`endsAt`) and assignment `dueDate` — is a deadline
  23:59 IST?
- `Batch.scheduleTiming` is free text (`"Mon-Fri 7:30 AM - 9:30 AM IST"`) while
  `startTime`/`endTime`/`timezone` are separate optional fields. Which is
  authoritative?

**Recommendation:** store UTC, but compute all academic "day" boundaries in the
institute timezone server-side. Treat deadlines as IST end-of-day. Make the
structured schedule fields authoritative and the display string derived.

---

## Q16 — `SystemConfig` versus `InstituteSettings` (P1)

Two overlapping writable config objects:
`InstituteSettings` (admin-editable, via `adminService`) and `SystemConfig`
(super-admin-only, far larger). Both contain institute name, support email,
support phone, WhatsApp number, address, timezone, GST number and minimum
attendance percentage.

Two writable sources for one value **will** drift, and the UI gives different
roles different editors.

**Recommendation:** `SystemConfig` is the single store; `InstituteSettings`
becomes a read/write projection of `SystemConfig.institute` + `academic`,
restricted to the fields admins may change. One source of truth, two views.

---

## Q17 — MS SQL collation, uniqueness and case sensitivity (P1)

SQL Server defaults to a **case-insensitive** collation
(`SQL_Latin1_General_CP1_CI_AS`). That has direct API consequences the DB team
should confirm:

- **Email uniqueness:** case-insensitive is what we want
  (`Raj@x.com` = `raj@x.com`) — but the API should normalise to lowercase on
  write regardless, rather than depend on collation.
- **Slugs and coupon codes:** `GET /courses/:slug` and coupon validation. Is
  `JAVA-FULLSTACK` the same slug as `java-fullstack`? Under CI collation, yes.
  We likely want slugs normalised lowercase, and coupon codes
  case-insensitive on lookup.
- **Sorting:** accent and case sensitivity affect `ORDER BY name`, so pagination
  ordering must be stable (always include a tiebreaker column, or rows can
  repeat or vanish across pages).
- **Unicode:** student names need `NVARCHAR`, not `VARCHAR`.
- **Date types:** `DATETIME2` versus `DATETIMEOFFSET`. Given Q15,
  `DATETIMEOFFSET` for timestamps and `DATE` for `sessionDate` is the safer pair.
- **Pagination:** `OFFSET/FETCH NEXT` requires a deterministic `ORDER BY`; deep
  offsets degrade, so high page numbers on large tables need keyset pagination
  later. Our `PaginatedResult` contract does not prevent that change.

**Recommendation:** normalise emails/slugs/codes in the application layer so
behaviour does not silently depend on collation. Ask the DB team to confirm
collation, `NVARCHAR` usage and date types.

---

## Q18 — Notification categories and delivery channels (P1)

**A confirmed contradiction inside the frontend**, not an ambiguity:

- `InAppNotification.category`: `announcement | assignment | exam | payment | placement | system`
- `sendBroadcastNotification` category: `academic | exam | placement | general | fee`

Only `exam` and `placement` appear in both. The backend cannot satisfy both sets
with one enum, so one must win — and the frontend will need a small change
either way.

Also unresolved: which events trigger email
(`SystemConfig.notifications` has `emailOnAdmission`, `emailOnPayment`,
`emailOnExamResult`, `smsOnClassReminder`, `pushAnnouncements`);
`smsOnClassReminder` is dead while BR-014 holds; `pushAnnouncements` implies web
push, which nothing else in the codebase supports; and
`InAppNotification.targetRole` (`student|teacher|admin|all`) versus
`sendBroadcastNotification.targetGroup` (`all|students|teachers|string`) is a
second mismatch in the same feature.

**Recommendation:** adopt the `InAppNotification.category` set as canonical
(it is the stored shape) and have the frontend's broadcast form map onto it.
Confirm whether web push is in scope — if not, remove `pushAnnouncements`.

---

## Q19 — Auto versus manual test scoring (P1)

`QuestionType` spans `mcq`, `multiple_select`, `true_false`, `short_answer`,
`coding`. The first three auto-score; the last two cannot.

Unresolved: whether a test mixing both types shows a partial score immediately
or nothing until evaluated (`TestAttempt.status` has `submitted` then
`evaluated`, implying partial); how `coding` is evaluated — is a code execution
sandbox in scope, or does a teacher read it; multiple-select partial credit; and
negative marking.

**Recommendation:** auto-score objective questions on submit, mark the attempt
`submitted` while open answers await a teacher, and only set `isPassed` once
`evaluated`. **Assume no code execution sandbox** unless stated — that is a
large piece of infrastructure, not a feature.

---

## Q20 — CMS defaults, trainer ownership, question bank (P2)

1. **Ten `reset*` methods** restore config to "default". Is a default a
   hardcoded seed shipped with the code, or the last published version? Affects
   whether defaults live in code or in the database.
2. **Trainer profiles exist twice:** `cmsService.getTrainers()` (public marketing
   profiles) and `TeacherProfile` (operational records). Are they the same
   people? If so, one must derive from the other or they will disagree publicly.
3. **`InterviewQuestion`** is a fully specified type with model answers and
   rubrics, but **no service method and no UI**. Is a question bank planned? No
   endpoint is proposed for it.
4. **SEO config** (`PageSEO`, `SEOConfig`) implies server-rendered meta tags,
   but the frontend is a client-rendered Vite SPA — so crawler-visible SEO may
   need SSR or prerendering, which is an architecture question beyond this API.

---

## Q21 — Soft delete versus hard delete (P1)

Several `delete*` methods exist: `deleteDiscount`, `deleteStudyMaterial`,
`deleteRecordedClass`, `deleteArticle`, `deleteFAQ`, `deleteTestimonial`,
`deleteAchievement`, `deleteTrainer`, `deleteCareer`, `deleteCollegePartner`,
`deleteCorporateTrainingService`, `deleteMediaAsset`.

Unresolved: do these remove rows or set a flag? It matters because deleting a
coupon that past transactions reference would break payment history, and
deleting study material a student has consumed breaks progress records. Note
there is **no** delete for students, teachers, courses or batches — those use
status changes instead, which is a sound existing pattern.

**Recommendation:** soft delete (`isDeleted` + `deletedAt` + `deletedBy`) for
anything referenced by historical records, hard delete only for genuinely
standalone CMS content. Confirm with the DB team, since it shapes every table
and every query filter.

---

## Q22 — Audit log immutability and retention (P2)

`AuditLog` and `recordSystemAuditLog` show an audit trail is required, and the
UI renders it. Unresolved: retention period; whether entries are immutable
(they should be — append-only, no update or delete path); whether reads are
super-admin-only or admin-visible (the frontend has both
`/admin/activity-logs` and `/super-admin/audit-logs`, suggesting two scopes);
and whether failed authorization attempts are logged (`result: 'DENIED'`
implies yes).

**Recommendation:** append-only table, no API write path, no delete path.
`admin` sees its own scope; `super_admin` sees everything. Confirm retention
with whoever owns compliance.

---

## Q23 — `switchRole` — client-side role switching (P1)

`authService.switchRole(role: UserRole): User | null` changes the current user's
role **client-side**, and `AuthContext` exposes it.

If this is a development convenience for demoing dashboards, it must have **no
backend equivalent**: an endpoint letting a caller choose its own role is a
privilege-escalation hole. No endpoint is proposed for it.

If, instead, real users legitimately hold multiple roles (a teacher who is also
an admin), that is a genuine requirement and changes the token design — the
token would carry multiple roles with one active, and switching would need
server-side re-issue with verification.

**Recommendation:** confirm it is a mock-only convenience. If multi-role users
are real, raise it now — it affects Q10 and Q13, both P0.

---

## Q24 — Concurrent edit protection (P2)

`PUT /courses/:courseId/curriculum` replaces an entire `CourseModule[]` tree,
and `updateAssignedCourseCurriculum` lets a teacher do the same. Two staff
editing one curriculum means last-write-wins and silent data loss. The same
applies to `SystemConfig` and CMS singleton configs.

**Recommendation:** optimistic concurrency via a `rowversion`/`ETag` on
editable aggregates, returning `409 CONFLICT` on a stale write. SQL Server's
`ROWVERSION` type suits this directly. Low cost now, genuinely painful to
retrofit after data loss is reported.

---

## Q25 — How is a `User` linked to a `Student`? (P0, raised at Step 6K — BLOCKING)

**Raised by:** the registration service (Step 6K).

`StudentRepository.create(input: CreateStudentInput)` takes **no `userId`**,
and `CreateStudentInput` omits `id`. There is therefore no way to express
"this student row belongs to this user account".

Registration needs that link. It creates a `User` (which owns the email, the
mobile, the role and the status, and which login reads) and must also store
the admissions profile — college, degree, passing year, date of birth,
gender, address, guardian contact. With today's contract, writing both
produces two records with unrelated ids and nothing connecting them. The
student row would be invisible to `UserRepository.findByEmail`, so login
would never see it.

**Step 6K therefore does not write the student row at all** — it validates
every field and persists only the identity and the credential. An unlinked
orphan is worse than a documented gap. See auth-implementation-plan.md
§21.2 and §21.3.

**What needs deciding:**

1. **Does `Student.id` equal `User.id`, or is there a separate `userId`
   foreign key?** One-to-one shared primary key is simpler and makes the
   relationship unmissable; a separate key is more flexible if a person
   could ever hold two roles.
2. **Is the student row created at registration or at admin approval
   (BR-002)?** If at registration, the profile lands immediately and the row
   exists in a pre-approval state. If at approval, the admissions data has
   to live somewhere in between — which today there is nowhere to put.
3. **Is creating the user and the student one atomic operation?** If they
   must both exist or neither, this needs the unit of work from **Q-CR6 /
   Q-X1**, not two repository calls.

**Smallest change that unblocks registration:** add `userId: EntityId` to
`CreateStudentInput` and answer (2). That is a contract change in
**Developer 2's module**, so it needs the Backend Lead's approval and
coordination rather than a unilateral edit.

**Blocks:** storing any registered student's academic profile; the
registration HTTP endpoint; `students` module integration with auth.

---

## Summary — what blocks what

**P0, blocking the next step:**

- **Q3** (OTP vs SMS) and **Q13** (tokens) block the `auth` module, which gates
  almost every other endpoint.
- **Q10** (permission model) blocks the authorization middleware, and therefore
  every guarded route.
- **Q11** (file storage) blocks `students`, `assignments` and `cms`.
- **Q1** (identifiers) blocks repository adapters, though not service logic.
- **Q25** (user-to-student linkage) blocks storing a registered student's
  academic profile and the registration endpoint. Raised at Step 6K.
- **Q4** (undefined business rules) blocks any module touching a missing rule —
  at minimum `assessments` via BR-012.

**A possible Step 4 that is not blocked:** the shared authorization *scaffolding*
(role guard middleware against the confirmed `UserRole` values and the confirmed
`/admin/*` inheritance) can be built while Q10's finer permission layer is
pending, since the role tier is already authoritative from the frontend route
guards. Equally, `cms` is the least coupled module and depends only on Q11 and
Q20.

That is a recommendation for sequencing, not a decision — Step 4 awaits the
lead's direction.
