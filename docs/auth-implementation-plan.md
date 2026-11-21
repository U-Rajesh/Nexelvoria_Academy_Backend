# NEXELVORIA Academy — Authentication & RBAC Implementation Plan

**Audience:** the backend lead (decision owner), Developer 1 who will implement
this, and Developer 2 as the consumer of the authorization middleware.
**Status:** Step 6A — **design only. No authentication code has been written.**
**Last updated:** 2026-11-17

---

## 1. How to read this document

| Marker | Meaning |
| --- | --- |
| **[C] Confirmed** | Exists in the completed frontend. Evidence is cited. The requirement is real. |
| **[P] Proposed** | Our recommendation. Nothing in the frontend decides it. **Requires your approval.** |
| **[?] Open** | Genuinely unresolved. Must not be guessed. |

Every **[C]** item cites its source file. Where the frontend is silent — password
hashing, token format, OTP expiry — the item is **[P]**, never presented as a
requirement. Business rules are not invented anywhere in this document.

**The frontend's auth service is a localStorage mock.** It accepts any password
of 8+ characters and treats `123456` as a valid OTP. It is evidence of *what
flows and shapes are required*, never of how security should work.

---

## 2. Confirmed requirements

### 2.1 Registration — [C]

Source: `src/utils/validators.ts` (`studentRegistrationSchema`),
`authService.registerStudent`, `RegisterPage.tsx`.

- **Students self-register. Teachers, admins and super-admins do not** — they are
  created by staff (`adminService.addTeacher`, `superAdminService.createAdmin`).
  So there is exactly one public registration path.
- **Password policy, exactly as the frontend enforces it:**
  minimum 8 characters, at least one uppercase, one lowercase, one digit, one
  non-alphanumeric. Confirmed twice — in the zod schema and in
  `PasswordStrengthIndicator.tsx`. **The backend must enforce the same rules**;
  client-side validation is a convenience, not a control.
- **Mobile format:** `^[6-9]\d{9}$` — a 10-digit Indian number. Used for both
  the student and `guardianContact`.
- `termsAccepted` must be `true` to proceed.
- **Confirmed response shape:** `registerStudent` is typed
  `ApiResponse<{ tempStudentId: string; email: string; mobile: string }>`, and
  `RegisterPage` navigates to
  `/verify-otp?studentId=${result.tempStudentId}&email=...&mobile=...`.

> **Correction to Step 3.** `docs/api-contracts.md` section 4 proposes
> `POST /auth/register` returning `{ studentId, otpChannels[] }`. The confirmed
> frontend shape is `{ tempStudentId, email, mobile }`. The contract document is
> wrong and should be amended — see decision **D2**.

### 2.2 Login — [C]

Source: `validators.ts` (`loginSchema`), `authService.login`, `LoginPage.tsx`,
`AuthContext.tsx`.

- **One identifier field accepting either email or mobile.** Email comparison is
  case-insensitive; mobile is exact.
- **`rememberMe` is an optional boolean on the login form.** It has no behaviour
  in the mock, but it is on the confirmed contract and must mean something —
  see **[?] O6**.
- Success returns `{ user, token }`; the frontend stores the token under
  `nexelvoria_auth_token` and sends `Authorization: Bearer <token>`
  (`services/api.ts` request interceptor).
- **The gate order is confirmed and must be reproduced**, because the UI renders a
  different screen per outcome:

| # | Condition | Outcome the UI expects |
| --- | --- | --- |
| 1 | identifier not found | invalid credentials |
| 2 | `accountState === "locked"` or `failedLoginAttempts >= 5` | locked |
| 3 | `accountState`/`status === "suspended"` | suspended |
| 4 | `accountState === "rejected"` or `adminApprovalStatus === "rejected"` | rejected, with `adminApprovalRemarks` |
| 5 | wrong password | increments counter; at 5 → locked |
| 6 | correct password | resets counter to 0 |
| 7 | `!isEmailVerified \|\| !isMobileVerified` | pending verification, **with the student id** |
| 8 | otherwise | success |

- **Non-student roles have no lockout and no verification gate** — only
  `status === "suspended" \| "deactivated"` blocks them.

**The login failure response carries structured fields our envelope does not
have.** `AuthContext.login` returns `{ success, error?, accountState?,
studentId? }`, and `LoginPage.tsx:80` branches on `result.accountState`, then
routes to `/verify-otp?studentId=...`. A human-readable `message` is not enough —
the UI needs machine-readable state. See decision **D1**.

### 2.3 Email and mobile OTP verification — [C]

Source: `validators.ts` (`dualOtpSchema`), `authService` (5 OTP methods),
`OTPVerificationPage.tsx`.

- **OTP is exactly 6 digits** — `z.string().length(6)`, for email, mobile, password
  reset and 2FA alike.
- Five confirmed operations: verify email, verify mobile, verify both at once,
  resend email, resend mobile.
- Both channels are verified independently (`isEmailVerified`,
  `isMobileVerified`), and `verifyDualOtp` submits both together.
- **OTP expiry, attempt limits and delivery are not specified anywhere in the
  frontend.** All **[P]** — section 7.

> **BR-001 requires a mobile OTP; BR-014 disables SMS.** This contradiction is
> `open-questions.md` **Q3** and it blocks this module. Section 10 restates it.

### 2.4 Password reset — [C]

Three steps, confirmed by `forgotPasswordIdentifierSchema`,
`forgotPasswordOtpSchema`, `resetPasswordSchema` and `ForgotPasswordPage`:

1. Submit identifier (email **or** mobile).
2. Verify a 6-digit OTP.
3. Set a new password — same policy as registration, with confirmation.

**A successful reset clears `failedLoginAttempts`** (`authService.ts:523`), which
makes password reset a confirmed self-service unlock path. The lockout message
says so explicitly: *"Please unlock via Forgot Password."*

### 2.5 Account lockout — [C]

- **Threshold is 5 consecutive failed attempts**, hardcoded in the frontend's
  messages and surfaced to the user as a countdown
  (*"Warning: N attempts remaining"*). So the **remaining-attempts count is part
  of the UX** and the backend must supply it.
- `SystemConfig.security.maxFailedLogins` makes the threshold configurable.
- Recovery: password reset (above) or `POST /students/:id/unlock` by an admin
  (`adminService.unlockStudentAccount`).
- **`StudentProfile.lockedUntil` exists but the mock never sets it**, so whether
  lockout is time-limited or permanent-until-reset is **[?] O4**.

### 2.6 Session management — [C]

`SessionItem` is a confirmed shape the UI renders: `id`, `device`, `browser`,
`os`, `ipAddress`, `location`, `lastActive`, `isCurrent`. Confirmed operations:
list own sessions, terminate one, terminate all others.

`LoginHistoryItem` is likewise confirmed: `timestamp`, `device`, `browser`,
`ipAddress`, `location`, `status` (`success | failed`), `failureReason?`. The
mock retains the **20 most recent** entries.

> **This is the fact that decides the token strategy.** A stateless JWT cannot be
> individually revoked, so *"terminate this session"* is impossible without
> server-side session state. Already recorded as `open-questions.md` **Q13**;
> section 6 proposes the resolution.

### 2.7 Two-factor authentication — [C] settings only

Confirmed: `TwoFactorSettings` (`enabled`, `method`:
`authenticator | sms | email`, `secretKey?`, `backupCodes?`,
`lastConfiguredAt?`), `authService.toggleTwoFactor`, a `StudentSecurityPage`,
`SystemConfig.security.enforceTwoFactor`, and a `twoFactorVerifySchema`.

**But there is no login-time 2FA challenge anywhere in the frontend.** I checked:
`twoFactorVerifySchema` is defined in `validators.ts` and **never imported**, and
`authService.login` never reads `twoFactorEnabled`. A user can switch 2FA on and
nothing ever asks for a code.

So 2FA is **half-specified**: the settings surface is confirmed, the enforcement
flow does not exist. Building the challenge means designing new frontend screens
— out of backend scope. **[?] O5.**

### 2.8 Account suspension — [C]

`UserStatus` = `active | pending | suspended | deactivated`; `AccountState`
adds `suspended`. Suspension blocks login for every role. Set by admins
(`updateStudentStatus`) and super-admins (`toggleAdminStatus`, which takes an
optional reason).

### 2.9 Not specified by the frontend — all [P]

Password hashing algorithm, token format and lifetimes, refresh tokens (the
frontend has **no** refresh concept), OTP generation/expiry/attempt limits,
session timeout enforcement, audit-log write points, and CSRF posture.

---

## 3. Proposed architecture — [P]

Follows the module conventions in `architecture.md`. Nothing here is built yet.

```
src/modules/auth/
  auth.routes.ts            route table + per-endpoint rate limiters
  auth.controller.ts        HTTP in/out only
  auth.service.ts           orchestration: login, register, reset, sessions
  auth.validation.ts        zod schemas MIRRORING the frontend's validators.ts
  auth.types.ts             module-internal types
  password.service.ts       hash + verify + policy (one place, swappable)
  token.service.ts          issue/verify access tokens, rotate refresh tokens
  otp.service.ts            generate, hash, verify, expire, throttle
  credential.repository.ts  PORT: password hashes (never a plaintext column)
  session.repository.ts     PORT: sessions + refresh tokens + login history
  otp.repository.ts         PORT: OTP challenges
src/middleware/
  authenticate.middleware.ts  NEW: verifies the token, populates req.user
```

Four deliberate choices:

1. **`authenticate` is a separate middleware from the existing `authorize`
   guards.** Step 4 already ships role guards that fail closed; this step only
   adds the thing that populates `req.user`. **The Step 4 middleware is not
   modified** — `requireAuth`, `requireRoles`, `requireAdmin` et al. keep working
   exactly as they do, and start passing once a token is present.
2. **Password, token and OTP logic live in their own services**, not inside
   `auth.service.ts`. Each is a security primitive with its own parameters and
   its own tests, and each is the kind of thing that gets swapped (argon2 → a
   successor, HS256 → RS256) without touching the login flow.
3. **Three repository ports, not one.** Credentials, sessions and OTPs have
   different lifetimes and access patterns — and credentials must be reachable
   from as little code as possible.
4. **`UserRepository` from Step 5 deliberately exposes no password field.** Auth
   reads hashes through `CredentialRepository` only, so no ordinary user query
   can accidentally select a hash into a response or a log.

---

## 4. Authentication flows

### 4.1 Registration → verification → approval

```
POST /auth/register                                    [C] flow
  validate (frontend's exact rules)
  reject duplicate email/mobile              -> 409 CONFLICT
  hash password                              -> credential record
  create user + student (status pending,
      accountState pending_verification,
      adminApprovalStatus pending)
  issue 2 OTP challenges (email, mobile)     -> [?] Q3: mobile may be email-only
  201 { tempStudentId, email, mobile }       [C] shape

POST /auth/otp/email/verify   | /auth/otp/mobile/verify | /auth/otp/verify-dual
  look up live challenge for (studentId, channel)
  check attempts, expiry, hash match
  mark channel verified
  when BOTH verified -> accountState = pending_approval
  200 StudentProfile                                    [C]

           ... admin approves (BR-002, students module, Developer 2) ...
           accountState -> approved;  login then succeeds
```

**Registration does not log the user in.** The frontend navigates to the OTP
page, and login explicitly rejects an unverified account (gate 7). Issuing a
session at registration would contradict that.

### 4.2 Login

```
POST /auth/login   (loginRateLimiter: 10 / 15 min, already written in Step 4)
  resolve identifier (email case-insensitive | mobile exact)
  ALWAYS verify the password hash            <- see 8.2 on enumeration
  on failure: increment counter, write failed login history
              at threshold -> lock account
              -> 401 { error: INVALID_CREDENTIALS, attemptsRemaining }
  on success: reset counter
  evaluate account state (locked/suspended/rejected/unverified)
              -> 403 with the state           <- decision D1
  create session + refresh token, write login history
  200 { user, accessToken, refreshToken, expiresIn }
```

### 4.3 Refresh — [P] entirely (no frontend counterpart)

```
POST /auth/refresh
  verify refresh token against the session store
  if already used  -> REUSE DETECTED: revoke the whole session family, 401
  rotate: issue a new refresh token, invalidate the old one
  200 { accessToken, refreshToken, expiresIn }
```

### 4.4 Logout and session revocation — [C]

```
POST   /auth/logout              revoke the current session only
DELETE /auth/sessions/:id        revoke one named session (must be the caller's)
DELETE /auth/sessions            revoke every session except the current one
GET    /auth/sessions            list own sessions, isCurrent flagged
GET    /auth/login-history       own history, most recent first
```

Ownership rule: a caller may only act on **their own** sessions. The session id
comes from the path, so the service must confirm it belongs to `req.user.id`
before revoking — otherwise one user can log another out.

### 4.5 Password reset — [C]

```
POST /auth/password/forgot             (passwordResetRateLimiter: 5 / hour)
  ALWAYS respond 200 with the same body   <- do not confirm whether an account exists
  if found: issue a reset OTP

POST /auth/password/reset-otp/verify   (otpVerifyRateLimiter: 5 / 15 min)
  verify -> issue a short-lived, single-use reset grant   [P]

POST /auth/password/reset
  require the grant (NOT just "the OTP was verified once")
  enforce the password policy
  update the hash
  clear failedLoginAttempts        [C] authService.ts:523
  REVOKE EVERY SESSION             [P] a reset means the account may be compromised
```

**Step 3 of the mock takes only `identifier` + new password, with nothing tying it
to the verified OTP.** On a real API that means anyone who knows an email address
can reset the password. Hence the single-use grant — this is **[P] but strongly
recommended**, and it is a genuine vulnerability in the mock's shape rather than a
preference.

---

## 5. JWT and session strategy — [P]

**Recommendation: short-lived JWT access token + opaque, rotating refresh token
backed by a server-side session table.**

This is driven by a confirmed requirement, not fashion: §2.6 requires listing and
terminating individual sessions, which a purely stateless token cannot do.

| Token | Format | Lifetime | Stored where |
| --- | --- | --- | --- |
| Access | JWT, HS256 | **15 minutes** | client memory / `localStorage` (frontend already does this) |
| Refresh | opaque 256-bit random, **hash stored** | **7 days**, or **30 days** with `rememberMe` | server session row + client |

**Access token claims (proposed):** `sub` (user id), `role`, `sid` (session id),
`iat`, `exp`, `iss`, `aud`. Deliberately **no** email, name or permissions —
claims are a cache, and a stale permission in a token is a privilege bug.

**Why 15 minutes:** it bounds the damage of a stolen access token while keeping
revocation cheap. The alternative — checking the session store on every request —
is correct but puts a database read on every call; a short expiry gets most of the
benefit. The cost is explicit: **a revoked session's access token stays valid for
up to 15 minutes.** If that is unacceptable for staff roles, the fix is a session
check on sensitive endpoints, and you should tell us which ones.

**Rotation with reuse detection:** each refresh consumes its token and issues a
new one. If an already-used token is presented, the entire session family is
revoked — that is the standard signal of a stolen refresh token.

**Secrets:** `JWT_SECRET` (min 32 bytes) via `env.ts`, which must **refuse to
start** without it in production, exactly as `CORS_ORIGINS` already does. HS256 is
sufficient for a single service; RS256 only matters when a third party must verify
tokens, which is not the case.

**`rememberMe` → refresh lifetime only.** Access tokens stay at 15 minutes
regardless. **[?] O6** — confirm this is the intended meaning.

**Storage posture:** the frontend already keeps the token in `localStorage`, which
is readable by any XSS on the origin. httpOnly cookies would be stronger but
require CSRF protection and frontend changes. **Recommendation: keep
`localStorage` for now** (it is already built, and our CSP is `default-src 'none'`
which limits script injection), and treat the cookie migration as a separate
decision — **D4**.

---

## 6. OTP verification design — [P]

Nothing about OTP mechanics is specified by the frontend beyond the 6-digit
length, so all of this needs your approval.

| Parameter | Proposed | Reasoning |
| --- | --- | --- |
| Length | **6 digits** | **[C]** — fixed by `z.string().length(6)` |
| Generation | `crypto.randomInt(0, 1_000_000)`, zero-padded | CSPRNG. `Math.random()` is predictable and must never be used |
| Storage | **hashed** (SHA-256 is adequate for a 10-minute 6-digit secret) | a leaked table must not reveal live codes |
| Expiry | **10 minutes** | long enough for email delivery, short enough to limit brute force |
| Max verify attempts | **5 per challenge**, then invalidate | 6 digits is 1,000,000 combinations; attempts are the real control |
| Resend cooldown | **60 seconds** | the UI has a resend button |
| Resends per challenge | **5**, then require restarting the flow | prevents using us to spam an inbox |
| Concurrency | issuing a new OTP invalidates the previous one for that channel | avoids multiple live codes |
| Single use | consumed on success | — |

**Rate limiting is already written** (Step 4, `rate-limit.middleware.ts`):
`otpVerifyRateLimiter` 5/15min, `otpResendRateLimiter` 5/hour. Those are
**IP-keyed** and therefore insufficient alone — an attacker with many IPs spreads
the load. **The per-challenge attempt counter above is the real defence**, and the
two must be used together.

**Never log an OTP.** Step 4's `redact()` already strips keys matching `otp`, but
the OTP must also never appear in a URL or a message string.

**Development delivery:** with SMS disabled and SMTP possibly unconfigured, there
must be a way to test. **Proposal:** in `NODE_ENV=development` only, log the OTP
through the existing logger at debug level. **Never a fixed code like the mock's
`123456`, and never outside development** — a backdoor code that ships is a total
authentication bypass. Needs approval — **D5**.

---

## 7. RBAC permission model

### 7.1 Confirmed — [C]

Role values are fixed: `public`, `student`, `teacher`, `admin`, `super_admin`.
Already encoded in `src/contracts/user.contract.ts`.

Inheritance, from `AppRoutes.tsx`:

| Surface | Allowed roles |
| --- | --- |
| public pages | none required |
| `/student/*` | `student` |
| `/teacher/*` | `teacher` |
| `/admin/*` | **`admin` + `super_admin`** |
| `/super-admin/*` | `super_admin` only |

**The Step 4 middleware already implements exactly this** and is not being
changed: `requireStudent`, `requireTeacher`, `requireAdmin` (both admin roles),
`requireSuperAdmin` (super-admin only). 70 of the existing tests cover it,
including both directions of the inheritance.

### 7.2 Role responsibilities — [C], from the endpoint inventory

| Role | Owns |
| --- | --- |
| `public` | catalogue, CMS pages, certificate verification, enquiry submission, register/login |
| `student` | own profile, enrolments, progress, attendance, assignments, tests, payments, certificates, placements, tickets, notifications, own sessions |
| `teacher` | **allocated** courses/batches only: attendance, materials, assignments, assessments, doubts, mock-interview feedback |
| `admin` | student approvals, enrolments, courses, batches, teachers, payments, discounts, certificates, placements, CMS, support, reports, activity logs |
| `super_admin` | everything admin, **plus** admin accounts, system config, refund approval (BR-006), financial overrides, audit logs, global roles |

### 7.3 Resource ownership — the layer roles cannot express

Role tier alone is insufficient. Three ownership rules must be enforced
**server-side, from the session, never from the request**:

1. **A student may only reach their own records.** `/students/me`,
   `/enrollments/me` etc. derive the id from `req.user.id`. This is why
   `api-contracts.md` gives `/me` its own path rather than
   `/students/:id` — it removes the chance of an id mix-up entirely.
2. **A teacher may only reach batches allocated to them.** Step 5 defines the
   primitive: `TeacherRepository.isAllocatedToBatch(teacherId, batchId)`. Every
   teacher-scoped endpoint must consult it. **This is the single most important
   authorization rule on the teacher surface** and it is not something a role
   guard can do.
3. **A ticket, session or submission belongs to its creator.** A student may read
   and reply to their own ticket only.

**Proposed middleware — [P]:** a `requireOwnership` helper is *not* recommended as
a generic middleware, because ownership is domain knowledge (what makes a batch
"yours" differs from what makes a ticket "yours"). Ownership belongs in each
module's **service**, which already has the repository it needs. A generic
middleware would need every repository and would couple the modules together.

### 7.4 The permission model question — [?] Q10, blocking

Three models coexist in the frontend and are not reconciled: the fixed `UserRole`
union (used by every route guard), `AdminProfile.permissions: string[]`
(`manage_students`, `manage_courses`, `manage_payments`), and `GlobalRole` with
runtime-created roles and `isSystemRole`.

**Recommendation (unchanged from Step 3): the hybrid.**

- **Role gates the surface** — already built, already tested, do not rebuild.
- **Permission gates the action** inside the admin surface, so one admin can
  manage students but not payments. `requirePermission("manage_payments")` as a
  second middleware after `requireAdmin`.
- **`super_admin` implicitly holds every permission** — it is the only role the
  frontend never restricts.
- **Ownership is enforced in services** (§7.3).

This is the only option consistent with *both* the route guards and the
roles-permissions UI the frontend already renders.

**Step 4 deliberately did not implement permissions, and Step 6A should not
either.** A guessed permission model has to be unpicked from every route later.
What is needed first is a **canonical permission key list** — which is why
`api-contracts.md` proposes `GET /rbac/permissions`. **Decision D3.**

---

## 8. Security considerations

### 8.1 Password hashing — [P]

**Recommendation: argon2id.** Memory-hard, so it resists GPU cracking far better
than bcrypt, and it is the current OWASP first choice.

| Parameter | Proposed |
| --- | --- |
| Algorithm | argon2id |
| Memory | 19 MiB (`m=19456`) |
| Iterations | 2 |
| Parallelism | 1 |
| Salt | 16 bytes, per password, from the CSPRNG |

These are the OWASP minimum parameters; they should be re-measured on the actual
host so a hash takes roughly 100–300 ms. **bcrypt (cost 12) is an acceptable
fallback** if argon2's native build is a problem on the deployment target — worth
checking early, since it is a compiled dependency on Windows.

Rules that are not negotiable:
- **Store the algorithm and parameters with each hash** so they can be upgraded
  later without invalidating everyone's password.
- **Re-hash on successful login** when the stored parameters are below current
  policy.
- **Never log, return or include a hash in any API response.** `UserRepository`
  has no password field precisely so this cannot happen by accident.
- Compare with the library's own verify function (constant-time), never `===`.

### 8.2 Account enumeration — a real risk in the confirmed design

The confirmed gate order checks **locked / suspended / rejected before verifying
the password** (§2.2). An attacker who knows only an email address can therefore
learn that the account exists and what state it is in.

**Proposal:** verify the password **first**, then disclose state — so state is only
revealed to someone who already proved they hold the credentials. For a wrong
password, return an identical `INVALID_CREDENTIALS` response whether or not the
account exists.

This slightly changes the UX: a suspended user who types the wrong password sees
"invalid credentials" instead of "suspended". **The flows and screens are
unaffected** — only the ordering changes. Likewise `POST /auth/password/forgot`
must always answer 200 regardless of whether the account exists.

**This is a security-versus-UX trade-off and it is yours to make — D6.**

### 8.3 Timing attacks

If no user matches the identifier, still perform a dummy hash verification before
responding. Otherwise "user not found" returns in ~1 ms and "wrong password" in
~200 ms, which is a reliable account-existence oracle regardless of 8.2.

### 8.4 Audit logging — [C] requirement, [P] mechanism

`AuditLog` and `recordSystemAuditLog` are confirmed, and the UI renders an audit
trail with `result: SUCCESS | FAILURE | DENIED`. Auth events that must be
recorded: login success, login failure, lockout, logout, session termination,
password change, password reset, OTP verified/failed, 2FA toggled, suspension.

Already decided in `architecture.md`: audit writes go through a **shared service
called from domain services**, not middleware — only the service knows the
business meaning of what changed. The table is **append-only with no API write
path** (`open-questions.md` Q22).

**Never record the password, the OTP, or the token** — only the fact and the actor.

### 8.5 Lockout

Threshold 5 is **[C]**. Proposed mechanics: count only *consecutive* failures,
reset on success **[C]** and on password reset **[C]**, and record each failure in
login history **[C]**. Pair the account lockout with the IP-keyed
`loginRateLimiter` already written — account lockout alone lets an attacker lock
a known user out deliberately (a denial-of-service on that account), and IP limits
alone let a distributed attacker through.

**Lockout duration is [?] O4** — `lockedUntil` exists but is never set.

### 8.6 Known limitations carried from Step 4

- **Rate limit counters are per-process, in memory.** Two instances behind a load
  balancer double the effective limit. Login and OTP limits are exactly the ones
  that must not be weakened that way, so a shared store (Redis) becomes necessary
  before horizontal scaling.
- **`trust proxy` is hardcoded to 1.** If wrong, client IPs are wrong, and both
  rate limiting and login history become unreliable.
- **`localStorage` tokens are XSS-exposed** (§5).
- **No CSRF protection** — correct today, because bearer tokens in headers are not
  sent automatically. It becomes mandatory the moment cookies are adopted (D4).

---

## 9. Database dependencies

No SQL, no schema, no connection. These are the **information needs** for the
database team, in the same spirit as `database-handoff.md`. They are additions to
that document, pending your approval of this plan.

### 9.1 What authentication needs to store

| Concern | Information required | Notes |
| --- | --- | --- |
| **Credentials** | user reference, password hash, algorithm + parameters, last-changed timestamp | **separate from the user record**, so ordinary queries cannot select a hash. `StudentProfile.lastPasswordChange` is confirmed |
| **Sessions / refresh tokens** | user reference, refresh-token **hash**, device, browser, os, ip, location, created, last-active, expires, revoked | fields are **[C]** from `SessionItem`. Never store a refresh token in plaintext |
| **OTP challenges** | subject reference, channel (email/mobile/reset/2fa), code **hash**, expiry, attempt count, resend count, consumed flag | all **[P]** except the 6-digit length |
| **Login history** | user reference, timestamp, device, browser, ip, location, status, failure reason | **[C]** from `LoginHistoryItem`; mock keeps 20 most recent |
| **Lockout state** | consecutive failure count, locked-until | `failedLoginAttempts` and `lockedUntil` are **[C]** fields |
| **2FA** | enabled, method, secret, backup codes, last configured | **[C]** shape; secret and backup codes must be encrypted at rest, not merely hashed, since TOTP verification needs the original |
| **Password reset grants** | subject, grant hash, expiry, single-use flag | **[P]**, from §4.5 |
| **Permissions** | role → permission keys; custom roles | **[C]** shape, **[?]** model (Q10) |

### 9.2 Questions to add to the handoff

- **Q-A1** Is email unique across all roles, or per role? Already Q-U1 in the
  handoff; **auth makes it blocking**, because login resolves an identifier to
  exactly one account. If one person can be both teacher and student with one
  email, login is ambiguous and the token needs multiple roles.
  **Decided 2026-11-20 (Q-U1):** email globally unique and case-insensitive, one
  role per account — login stays unambiguous (database-handoff.md §17.3).
- **Q-A2** Retention for login history (mock keeps 20) and for expired sessions
  and consumed OTPs. Who purges them, and how often?
- **Q-A3** Index requirements: `email` and `mobile` lookups run on **every**
  login; refresh-token hash lookup runs on every refresh; `(subject, channel,
  consumed)` runs on every OTP verify. All are hot paths.
- **Q-A4** Can authentication run in a transaction spanning user + credential +
  session creation? Registration touches three concerns at once — this is the
  unit-of-work question (handoff Q-X1) with a concrete first case.
- **Q-A5** Are 2FA secrets and backup codes acceptable as encrypted columns, and
  if so which key management — Always Encrypted, or application-level with a key
  from the secret store?
- **Q-A6** Clock skew: token `exp` and OTP expiry depend on the app and database
  agreeing on time. Is the database UTC?

**No credentials are requested or stored anywhere in this repository.**

---

## 10. Open questions

Blocking items from `open-questions.md`, plus what this review newly found.

### Carried forward — still blocking

| ID | Question | Why it blocks |
| --- | --- | --- |
| **Q3** | **Dual OTP (BR-001) vs SMS disabled (BR-014)** | As specified, **no student can complete registration**. The whole registration path depends on the answer. Recommendation unchanged: email-only at launch, with a channel-agnostic OTP service driven by `isSmsEnabled`, so enabling SMS later is configuration rather than a rewrite. Do **not** deliver a "mobile" OTP by email — that would set `isMobileVerified = true` for a number nobody verified |
| **Q10** | Which permission model authorises | Decides whether `requirePermission` exists at all (§7.4) |
| **Q13** | Token strategy | §5 proposes the resolution; needs ratifying |
| **Q14** | 2FA methods with SMS off | TOTP + email proposed; SMS hidden while disabled |
| **Q23** | `switchRole` lets a client change its own role | **DECIDED 2026-11-20 (Q-U1): demo-only.** It cannot change a backend role, one account has one role, and no endpoint will be added |

### New, found in this review

| ID | Finding |
| --- | --- |
| **O1** | **The login failure response needs `accountState`, and `studentId` when verification is pending.** `LoginPage.tsx` branches on it. Our envelope has no such field → **D1** |
| **O2** | **Confirmed register response is `{ tempStudentId, email, mobile }`**, not the `{ studentId, otpChannels }` proposed in Step 3 → **D2** |
| **O3** | **The remaining-attempts count is part of the UX** (*"N attempts remaining"*). Disclosing it also tells an attacker exactly how far they can go. Include it, or use a generic message? |
| **O4** | **Lockout duration is undefined.** `lockedUntil` exists but is never set. Permanent until reset/admin unlock, or auto-expiring after N minutes? |
| **O5** | **2FA has no login challenge.** Settings exist; `twoFactorVerifySchema` is defined and never used. Is login-time 2FA in scope? It needs new frontend screens |
| **O6** | **`rememberMe` has no defined behaviour.** Proposed: refresh lifetime 7 → 30 days, access token unchanged |
| **O7** | **`SystemConfig.security.passwordExpiryDays` and `requireSpecialChars` exist.** Is password expiry actually enforced? And may runtime config *weaken* the confirmed password policy? Our position: config may tighten, never loosen — same principle as Q8 |
| **O8** | **Password reset step 3 is not bound to the verified OTP** in the mock. §4.5 proposes a single-use grant. Without it, knowing an email is enough to reset a password |
| **O9** | **Session timeout.** `SystemConfig.security.sessionTimeoutMinutes` is confirmed as config. Is it idle timeout or absolute? It interacts with the refresh lifetime |

---

## 11. Decisions requiring backend lead approval

Nothing below has been implemented. **Each needs your explicit decision**, and
D1/D2 are contract changes I will not make unilaterally.

| ID | Decision | Recommendation | Impact |
| --- | --- | --- | --- |
| **D1** | How login conveys account state | Distinct `error` codes (`ACCOUNT_LOCKED`, `ACCOUNT_SUSPENDED`, `ACCOUNT_REJECTED`, `PENDING_VERIFICATION`, `INVALID_CREDENTIALS`) **plus** a `data` object carrying `{ accountState, studentId? }` on the failure. Note the frontend's `ApiResponse<T>` already declares `data` as required, so putting it there is *more* compatible than top-level extras | **Contract change** to `ApiFailure` (additive: optional `data`). Small frontend change to read codes |
| **D2** | Fix the register response in `api-contracts.md` | Amend to the confirmed `{ tempStudentId, email, mobile }`. The frontend is the source of truth here, not my Step 3 proposal | Doc correction only |
| **D3** | Implement permissions now, or role tiers only | **Role tiers only for now.** Defer `requirePermission` until Q10 and a canonical permission key list exist | Blocks nothing; avoids rework |
| **D4** | Token storage: `localStorage` or httpOnly cookie | **Keep `localStorage`** (already built; our CSP is `default-src 'none'`). Revisit as a separate decision — cookies need CSRF protection and frontend work | Security posture |
| **D5** | Dev OTP delivery | Log the OTP at debug level **in development only**. **Never a fixed code, never outside development** | Testability |
| **D6** | Enumeration vs UX in the login gate | **Verify the password before disclosing account state.** Flows and screens unchanged; only the ordering differs | §8.2 |
| **D7** | Dependencies to install | `argon2` (or `bcrypt`), `jsonwebtoken` + `@types/jsonwebtoken`. **Nothing has been installed.** argon2 is a native build — worth testing on the deploy target early | 2–3 runtime deps |
| **D8** | `JWT_SECRET` handling | Add to `env.ts` and **refuse to start in production without it**, mirroring `CORS_ORIGINS`. Add to `.env.example` as a placeholder — **never a real secret** | Config change, needs your go-ahead |
| **D9** | Access token lifetime | 15 minutes, refresh 7 days / 30 with `rememberMe`. Accept that a revoked session's access token lives up to 15 minutes, or name the endpoints that need a per-request session check | §5 |

---

## 12. Recommended implementation sequence

Each step ends green — typecheck, build and tests — before the next begins.
**None of this starts without your approval, and Q3 gates step 4 onward.**

| # | Step | Depends on |
| --- | --- | --- |
| 1 | **Config + deps:** `JWT_SECRET` and token lifetimes in `env.ts`; install the hashing and JWT libraries | D7, D8 |
| 2 | **`password.service.ts`:** hash, verify, policy check mirroring the frontend rules, needs-rehash. Fully unit-testable with no database | D7 |
| 3 | **`token.service.ts`:** issue/verify access tokens, generate/hash refresh tokens. Unit-testable | D9 |
| 4 | **Repository ports:** `credential`, `session`, `otp` — interfaces only, plus in-memory fakes in `tests/fakes/`, exactly as Step 5 | Step 5 pattern |
| 5 | **`authenticate.middleware.ts`:** verify the bearer token, populate `req.user`. **The Step 4 role guards then start passing with no change to them.** Test both: valid token admits, bad/expired/missing denies | 3, 4 |
| 6 | **Login + logout + `/auth/me`** over the fakes. First end-to-end auth flow | 2–5, D1, D6 |
| 7 | **Sessions:** list, terminate one, terminate others, login history | 6 |
| 8 | **Refresh + rotation** with reuse detection | 6 |
| 9 | **`otp.service.ts` + registration + verification** — **requires Q3 answered** | Q3, D5 |
| 10 | **Password reset** with the single-use grant | 9, O8 |
| 11 | **Lockout + audit-log write points** | 6, O4 |
| 12 | **RBAC permissions** — only if D3 says yes and Q10 is answered | Q10 |

**Steps 1–3 are unblocked by every open question** and are safe to start the
moment you approve D7/D8/D9. Steps 9–10 cannot start until Q3 is resolved.

**2FA (O5) is deliberately absent from this sequence.** Without a login
challenge in the frontend there is nothing to integrate with, and building one
means designing new screens — a separate scope decision.

---

## 13. What this step did and did not do

**Did:** reviewed the backend and the frontend's auth surface; separated
confirmed requirements from proposals with citations; designed the flows, token
strategy, OTP mechanics and RBAC model; identified the database needs; recorded
nine new open questions and nine decisions.

**Did not:** write any authentication code, install any dependency, modify any
existing module or middleware, change any API contract, touch Developer 2's
modules (courses, students, teachers, batches, enrollments), connect to SQL
Server, or perform any git operation.

The existing authorization middleware from Step 4 is **unchanged** and still
fails closed. All 124 tests still pass.

---

## 14. Session validation — REQUIRED, NOT YET IMPLEMENTED

Added at Step 6D. Read this before assuming any part of session security works.

### 14.1 What authentication actually proves today

`authenticate` verifies the token's signature, algorithm, expiry, issuer and
audience, then attaches `req.principal` from the `sub`, `role` and `sid`
claims. That proves exactly one thing:

> **This token was issued by us, to this user, with this role, and has not
> yet expired.**

It does **not** prove the session is still live, and it cannot, because there
is no session store. Step 5 defined repository ports; no adapter exists, and
no session repository has been written at all.

### 14.2 What is therefore NOT working

Stated plainly so nobody builds on a false assumption:

| Capability | Status |
| --- | --- |
| Logout | **Service implemented at Step 6J** (logout, logout-everywhere, list, terminate) and verified end to end against the fake. **No endpoint**, and no persistent adapter - see section 20 |
| Session revocation | **Logic implemented at Step 6F** (`authenticate` validates `sid` on every request) but **not functional in production**: there is still NO persistent adapter, so protected routes return 503. See §15 and §16 |
| "Terminate this session" | **Service implemented at Step 6J**; no endpoint |
| "Terminate all other sessions" | **Partially**: `logoutEverywhere` revokes ALL sessions including the current one. Sparing the current session is supported by the port (`exceptSessionId`) but is not yet exposed as a service operation - see section 20 |
| Immediate effect of suspension | **No.** A suspended user keeps access until their token expires |
| Immediate effect of a role change | **No.** The old role stays valid until expiry |
| Refresh token rotation | **Service implemented at Step 6I** (rotation, reuse detection, family revocation) but **no endpoint and no persistent adapter** - see section 19 |

**Current exposure:** a stolen access token is usable until `exp` — up to 15
minutes — and nothing can stop it. That is the accepted cost of the
15-minute lifetime chosen in §5, *provided* revocation exists for the refresh
token. It does not yet.

### 14.3 What must be added, and where

Three pieces, in dependency order:

**1. A session repository port** — **DONE at Step 6E**:
`src/modules/auth/session.repository.ts` (interface only) with
`src/modules/auth/session.types.ts` and a test fake at
`tests/fakes/in-memory-session.repository.ts`. Registered in the DI
registry as `sessions`, and **deliberately not registered in the production
container** — no MS SQL Server adapter exists. The delivered surface:

```
findBySessionId(sid)                -> session | null
findByRefreshTokenHash(hash)        -> session | null
create(session)                     -> session
touch(sid, lastActiveAt)            -> void
revoke(sid)                         -> void
revokeAllForUser(userId, exceptSid) -> void
revokeFamily(sid)                   -> void   // refresh-token reuse detected
```

A session row carries: user id, refresh-token **hash**, device, browser, os,
ip, location, created, last-active, expires, revoked — the fields
`SessionItem` already confirms (§9.1).

**2. Session validation inside `authenticate`** — after the token verifies,
look up `claims.sid` and reject when the session is missing, revoked or
expired.

> **DECIDED by the backend lead at Step 6E: validate the session on EVERY
> authenticated request** (option A) once persistent session storage exists.
> Revocation latency is zero; the cost is one indexed read per authenticated
> request.

| Option | Revocation latency | Cost | Status |
| --- | --- | --- | --- |
| **A.** Check the session on every authenticated request | immediate | one indexed read per request | **CHOSEN** |
| **B.** Trust the access token for its 15 minutes; check only on refresh | up to 15 min | no extra read | not chosen |
| **C.** Hybrid: check on sensitive routes only | immediate where it matters | targeted reads | not chosen |

`authenticate` is the single place the check belongs — which is why
`sessionId` is already on `req.principal`.

#### The agreed validation rules (option A)

To be implemented once a session adapter exists. Order matters, and every
step fails closed.

```
1. verify the access token                      (implemented, Step 6D)
2. sessions.findBySessionId(claims.sid)
3. no such session               -> 401   never existed, or purged
4. session.revokedAt is set      -> 401   logged out / suspended / reuse
5. session past expiresAt        -> 401
6. session.userId !== claims.sub -> 401 + log as a security event
                                          (should be impossible)
7. otherwise -> set req.principal, then
   sessions.updateLastActiveAt(sid, now)  best-effort, never blocking
```

Implementation notes that matter:

- **All five rejections return the same generic 401** (`UNAUTHENTICATED`).
  Telling a client "revoked" versus "expired" versus "unknown" is an oracle;
  the distinction belongs in the server log. The one exception stays
  `TOKEN_EXPIRED`, which concerns the *token* rather than the session and is
  the client's signal to refresh.
- **The lookup must be indexed on session id** — it is on the hot path of
  every authenticated request. Raised as **Q-A3** in
  docs/database-handoff.md.
- **`updateLastActiveAt` must never fail a request.** It is informational; a
  failed write is logged and ignored.
- **Suspension and role change revoke sessions** rather than being re-checked
  per request:
  `revokeAllForUser({ userId, reason: "account_suspended" | "role_changed" })`.
  That keeps the per-request cost at one session read instead of also
  re-reading the user, and leaves an auditable record. The owning modules
  (students, super-admin) call it when they change status or role — a
  cross-module coordination point.
- **Password change and reset revoke every session** (`password_changed`),
  per §4.5.

**3. Role-change handling.** The role is read from the token, so a
demotion — admin to student, or a suspension — does not take effect until
expiry. Options:

- Revoke the user's sessions whenever their role or status changes, forcing
  re-authentication. **Recommended**: it is explicit, it is auditable, and
  role changes are rare.
- Or re-read the role per request, which makes the `role` claim redundant and
  adds a read to every call.

Note this interacts with `SystemConfig.security.sessionTimeoutMinutes`
(confirmed config, open question **O9**: idle timeout or absolute?) — a
session row is also where an idle timeout would be enforced.

### 14.4 Until then

Treat every authenticated route as "valid token = valid session". Do not
describe logout as working, do not build a frontend logout that implies
server-side revocation, and do not ship authenticated write endpoints that
depend on revocation for safety.

---

## 15. Session repository — what is implemented, and what is not

Added after the Step 6E security review. This section exists because the
previous wording let a reader believe reuse detection worked when it did not.
It separates four things that must not be confused.

### 15.1 Two defects found in review, and their root causes

**Defect 1 — reuse detection was impossible.** `rotateRefreshToken` replaced
`Session.refreshTokenHash` in place, so the previous hash vanished from the
store. `findByRefreshTokenHash(oldHash)` then returned `null`, which is
exactly what an never-issued token returns. The port's documentation claimed
a replayed token could be recognised; it could not. The documented reasoning
was true only for a *revoked session* (whose current hash is retained) and was
wrongly generalised to *rotation*.

**Fix:** every rotation now records the retired hash as a
`ConsumedRefreshToken` (session, family, owner, timestamps), and
`resolveRefreshToken` returns `active | consumed | unknown`.

**Defect 2 — rotation ignored session state.** It checked existence and the
expected hash, but not whether the session was active. A revoked or expired
session could therefore be rotated, and because rotation also writes
`expiresAt`, passing a future value silently resurrected a dead session.

**Fix:** the active check runs *before any write* and throws the new
`SessionNotActiveError`. Rotation can no longer clear `revokedAt` or extend
`expiresAt` on a dead session.

### 15.2 Implemented repository behaviour (interface + test fake)

| Behaviour | State |
| --- | --- |
| Session create / lookup by id | defined and tested |
| Lookup by CURRENT refresh-token hash | defined and tested |
| `resolveRefreshToken` → active / consumed / unknown | defined and tested |
| Rotation records the retired hash as consumed | defined and tested |
| Rotation rejects unknown → `RecordNotFoundError` | defined and tested |
| Rotation rejects revoked/expired → `SessionNotActiveError` | defined and tested |
| Rotation rejects a stale hash → `OptimisticLockError` | defined and tested |
| Rotation cannot clear revocation or extend a dead session | defined and tested |
| Revoke one / all-for-user / family, with `exceptSessionId` | defined and tested |
| Cross-user isolation on revoke and list | defined and tested |
| `purgeConsumedRefreshTokens` | defined and tested |
| Raw refresh tokens never stored | asserted by tests |

### 15.3 Test-only behaviour — NOT production

Everything above is verified against `tests/fakes/in-memory-session.repository.ts`,
which is an in-process `Map`. It is **not** a session store:

- Sessions and consumed history vanish on restart.
- They are invisible to any other process or instance.
- `tests/` is outside the build's `include`, so the fake is never emitted to
  `dist/`, and `createProductionContainer()` registers **no** `sessions`
  adapter. Resolving one in production throws
  `RepositoryNotConfiguredError`.

Its single-threaded Map also makes check-then-write *look* atomic. **A real
adapter must not rely on that** — see §15.5.

### 15.4 Future refresh-service responsibilities — NOT implemented

There is no refresh service, no refresh endpoint and no logout endpoint. When
one is built it must:

1. Hash the presented token and call `resolveRefreshToken`.
2. `unknown` → generic 401. Nothing else.
3. `consumed` → **treat as theft**: issue nothing,
   `revokeSessionFamily({ familyId, reason: "token_reuse_detected" })`,
   write an audit entry against `consumed.userId`, return a generic 401.
   Never tell the client that reuse was detected.
4. `active` → check `isSessionUsable`; if not, generic 401.
5. Rotate inside the repository. An `OptimisticLockError` means the hash was
   already consumed by a concurrent request, so apply step 3's response.
6. Issue a new access token, return the new refresh token **in the body**,
   never in a URL.

**Known trade-off:** a legitimate double-submit (a retry, two tabs) is
indistinguishable from a replay and will revoke the family, logging the user
out. That follows the OAuth 2.0 Security BCP and favours safety. The usual
mitigation is a short grace window in which re-presenting the just-consumed
token returns the *same* newly issued pair instead of revoking. **Not
implemented, and a decision for the backend lead.**

### 15.5 Future MS SQL Server atomicity requirements

For the database team; also recorded in `docs/database-handoff.md`.

- **Rotation is one atomic unit:** verify active, compare the stored hash,
  write the new hash, insert the consumed record. In SQL that is a single
  conditional `UPDATE ... WHERE session_id = @id AND refresh_token_hash =
  @expected AND revoked_at IS NULL AND expires_at > SYSUTCDATETIME()`, with
  the consumed insert in the same transaction. **Never SELECT-then-UPDATE** —
  two concurrent refreshes would both read the same hash and both write,
  leaving two live refresh tokens and making reuse detection meaningless.
- Zero rows affected must be distinguished into "no such session",
  "not active" and "hash mismatch" so the correct typed error is thrown.
- **Indexes on the hot paths:** session id (every authenticated request once
  §14 validation lands), current refresh-token hash, consumed-token hash, and
  `purge_after` for the cleanup sweep.
- **The consumed table is the largest in this area.** With a 15-minute access
  token and a 30-day remembered refresh lifetime, one session can rotate
  ~2,900 times. It needs a scheduled purge
  (`purgeConsumedRefreshTokens(now)`, hourly is ample); **who owns that
  schedule is an open deployment question.**
- Purging is safe at any time: a purged record degrades a token from
  `consumed` to `unknown`, which still denies access. Detection is lost,
  access is never granted.

### 15.6 Not available in production — unchanged

Logout, session revocation, "terminate this session", "terminate all
others", refresh rotation and reuse detection are **all non-functional in
production**. Step 6E delivers an interface, typed errors and a test fake.
There is no adapter, nothing is persisted, and `authenticate` still does not
validate `sid` (§14 describes the agreed rules; they are not implemented).

---

## 16. Session validation integration (Step 6F)

The §14.3 rules are now implemented in `authenticate`. **A cryptographically
valid access token no longer authenticates a request on its own.**

### 16.1 What is implemented

`createAuthenticate({ sessions })` applies these checks in order, each
failing closed:

| # | Check | Failure |
| --- | --- | --- |
| 1 | bearer credential present | 401 `UNAUTHENTICATED` |
| 2 | token verifies (signature, algorithm, expiry, issuer, audience, role) | 401 `UNAUTHENTICATED`, or `TOKEN_EXPIRED` |
| 3 | session repository resolvable | **503** `SERVICE_UNAVAILABLE` |
| 4 | session exists (`findBySessionId`) | 401 `UNAUTHENTICATED` |
| 5 | session neither revoked nor expired | 401 `UNAUTHENTICATED` |
| 6 | `session.userId === claims.sub` | 401 + logged at **error** |
| 7 | attach `req.principal`, record activity (best effort) | — |

Every session-level rejection returns the **same** generic 401. Session
state, revocation reason and session ids are logged for operators and never
returned - telling a client "revoked" versus "expired" versus "unknown" is an
oracle.

Step 2 short-circuits before the repository is touched, so a malformed token
costs no database read.

### 16.2 Dependency injection

`sessions` is a **resolver** (`() => SessionRepository`), not an instance.
The container resolves lazily and throws `RepositoryNotConfiguredError` while
no adapter exists, so taking an instance would make `createApp()` throw at
startup and take the public health endpoint down with it.

Resolving per request gives all three properties we need at once:

- public routes keep working;
- the app still boots with no session adapter;
- protected routes **fail closed with 503** rather than bypassing validation.

Wiring a protected module router is one line:

```ts
const authenticate = createAuthenticate({
  sessions: () => container.repositories.sessions,
});
router.use("/students", authenticate, requireAdmin, studentRoutes);
```

`authenticate` is deliberately **not** mounted globally, and no protected
route exists yet.

### 16.3 Role and account-state limitations — IMPORTANT

**The role in the token is trusted for the token's lifetime.** `authenticate`
does **not** re-read the user, so:

| Change | Takes effect |
| --- | --- |
| Session revoked / logout | **immediately**, next request |
| Password changed (revokes sessions) | **immediately** |
| Refresh-token reuse (revokes family) | **immediately** |
| **Role change** (e.g. admin → student) | **only when sessions are revoked, or at token expiry (≤15 min)** |
| **Account suspension / deactivation** | **only when sessions are revoked, or at token expiry (≤15 min)** |
| **User deleted** | **not detected at all** |

`UserRepository` exists as a port with `role` and `status`, so a per-request
identity check is *possible in principle*. It was deliberately **not** added:

1. It has no adapter either, so it would fail closed in production exactly
   as the session lookup does - no extra safety today.
2. It doubles the per-request read cost, and §14.3 already chose the cheaper
   design: **revoke sessions when role or status changes.**
3. Adding it would make the `role` claim redundant and change the token
   design, which is not this step's scope.

**The consequence must be understood: the revocation-on-change behaviour is
NOT implemented either.** The modules that change role and status (students,
super-admin) do not exist, so nothing calls `revokeAllForUser` today. Until
they do, a suspended or demoted user keeps their access for up to 15 minutes.

**This is a hard dependency for whoever builds those modules**: every write
that changes a user's `role` or `status` must call
`revokeAllForUser({ userId, reason: "role_changed" | "account_suspended" })`
in the same unit of work. Owner: the modules' authors (students is
Developer 2's; super-admin is mine). Recorded as a cross-module coordination
point.

### 16.4 Performance

One indexed session read per authenticated request, plus one
`updateLastActiveAt` write. The write is best-effort and never fails or
delays a request (tested).

Two items for the database team, already raised as **Q-A3**: the session-id
lookup is now on the hot path of every authenticated request and must be
indexed; and `updateLastActiveAt` is a write on every authenticated request,
so if contention shows up the usual mitigations are to throttle it (update
at most once per minute per session) or move it to a queue. Neither is
implemented.

### 16.5 Database outages and fail-closed behaviour

An unresolvable repository and a throwing lookup both return **503
`SERVICE_UNAVAILABLE`**, not 401, and both deny access.

Rationale: a 401 asserts "your credentials are not valid", which is false
during an outage and invites clients to discard good tokens and stampede the
login endpoint - which also needs the database. A 503 says "we cannot answer
right now" and is retryable. The underlying error is logged and never
returned (tested: no host names, driver text or account names reach the
client).

**This is a decision the backend lead may wish to flip.** If 401 everywhere
is preferred for uniformity, it is a two-line change in
`authenticate.middleware.ts`. Access is denied either way.

### 16.6 Still NOT production-ready

Unchanged and worth repeating: there is **no persistent session adapter**.
Every behaviour above is verified against an in-memory fake that lives in
`tests/`, is excluded from the build, and is not registered in the
production container. In production today, any protected route would return
503 for every request.

Authentication cannot be described as production-ready until a session
adapter exists, and until the role/status revocation hooks in §16.3 are
wired up.

---

## 17. Credential repository (Step 6G, with security corrections)

`src/modules/auth/credential.repository.ts` — interface only. No adapter, so
nothing persists.

### 17.1 Three password write paths — do not merge them

| Method | Authorization | CAS | Stamps `passwordUpdatedAt` | Clears lockout |
| --- | --- | --- | --- | --- |
| `changePassword` | knows the current password | **required** | yes | yes |
| `rehashPassword` | just verified the password | **required** | **no** | **no** |
| `resetPassword` | single-use OTP reset grant | no | yes | yes |

**Why `rehashPassword` requires compare-and-set.** A rehash runs right after a
successful verification, so the caller knows exactly which hash it is
replacing. The first version of this port allowed an unconditional write, which
meant a rehash could land after a concurrent password change and **reinstate
the old password over the new one**. Caught in review; now impossible. On a
CAS failure the correct response is to ABANDON the upgrade, never to retry.

**Why a rehash must not stamp `passwordUpdatedAt`.** It stores the same
password under stronger parameters. Stamping it would make every user look as
though they had just changed their password, corrupting password-age reporting
and any expiry policy built on it (O7).

**Why `resetPassword` has no CAS, and why that is not a weakness.** The user
cannot know their current hash — that is the premise of a reset. Authorization
comes from a single-use, short-lived reset grant issued after OTP verification
(§4.5 / O8). **The repository cannot verify that grant, so the service must**,
and it is a separate method precisely so the requirement is visible at every
call site rather than hidden in an optional field. Calling it without a grant
is a full account takeover.

### 17.2 Lockout policy as implemented

**Counter-based and permanent until explicitly cleared.** Locked when
`failedLoginAttempts >= threshold`; cleared only by `resetPassword` or
`clearLockout`. No automatic time-based unlock, and nothing sets `lockedUntil`.

The timed-lockout option was **removed**, not merely unused: accepting a lock
duration while also treating the counter as a lock signal meant an elapsed
timestamp never actually unlocked anything. One rule, no contradiction. See
open question **Q4a** for the decision that is still outstanding — and note
that choosing a timed lockout requires deciding what happens to the counter
when the timer expires.

`lockedUntil` stays on the record (confirmed frontend field, schema should
carry it) and a FUTURE value is still honoured so a later policy can switch it
on. An ELAPSED value never unlocks a credential.

### 17.3 Credential exposure — a hard rule

A `CredentialRecord` never leaves the authentication layer: not an API DTO,
never returned from a controller, never in an error, never logged.

Four layers of enforcement, all tested:

1. `UserRepository` exposes no password field, so ordinary user queries cannot
   select a hash.
2. **`toCredentialSecurityView()`** is the only credential shape allowed out,
   and it is *structurally* hash-free — `passwordHash` is not in the type, so a
   controller cannot leak one by forgetting to strip a field. It carries what
   the confirmed admin screen `GET /students/:studentId/security` needs.
3. `redact()` replaces any value under a key matching `/pass(word)?/` or
   `/credential/`, covering `passwordHash` and a nested credential object. Last
   line of defence, not permission to log one.
4. Repository errors carry entity, user id and field name — never a hash.
   Asserted across every failing path.

### 17.4 Still not functional

No adapter exists, so nothing persists. The production container registers no
`credentials`, and resolving it throws. Login, registration, password change
and reset remain unimplemented; this step defines only the contract they will
use.

---

## 18. Login service (Step 6H, with security hardening)

`src/modules/auth/login.service.ts`. No HTTP endpoint exists; the service
returns a typed result.

### 18.1 Time-of-check / time-of-use: what is guaranteed

An argon2id verification takes ~120ms. In that window, and during the writes
that follow, the password can change, the credential can be locked by
concurrent failures, the account can be suspended or deactivated, and the role
can change. The snapshot read before verification is **not** authoritative by
the time a token is minted.

**Implemented now:**

| Guarantee | How |
| --- | --- |
| No session from a stale password verification | The gate accepts only a stored hash that still represents the verified password |
| No login after a concurrent suspension or deactivation | Fresh `users.findById` at both gates |
| No login after a concurrent lockout | Fresh `credentials.findByUserId`, re-checked with `isCredentialLocked` |
| JWT carries the currently authorized role | Minted from the FINAL gate's read, not the initial snapshot |
| No session left behind after a detected conflict | The session created moments earlier is revoked |
| Uncertain state never grants access | Any failed re-read returns `authentication_unavailable` |

Two gates run: once **before** creating a session (so a doomed session is never
created) and once **after** (the authoritative check, immediately before the
token is minted). Cost: four extra single-row reads per login. Login is not a
hot path, and they are trivial beside one argon2 hash.

### 18.2 Why a re-read is not sufficient on its own — and why this is sound

A re-read narrows the window from ~120ms to microseconds but cannot close it. A
change committing between the final read and the token being returned is still
possible, and **no single-repository atomic operation could fix it**, because
the condition spans `users`, `credentials` and `sessions`. That is why no new
repository method was added: one would not help without a transaction.

The window closes from the other direction instead. Every state change that
matters is already required to revoke the user's sessions (§16.3):

- change commits **before** the post-create gate → the gate sees it and we
  revoke our own session;
- change commits **after** our session row exists → that change's revocation
  sweep includes our session.

Together these cover the whole window, **provided the status/role write and the
revocation happen in one unit of work**. They cannot today, so one narrow
interleaving remains: the status write commits after our final read while the
revocation sweep already ran before our insert.

**That residual gap closes only with Q-X1 / Q-CR6 transactions.** It is bounded
by the 15-minute access-token lifetime and by Step 6F session validation, which
re-checks the session on every authenticated request.

### 18.3 Transaction boundaries still required

| Flow | Needs one transaction | Today |
| --- | --- | --- |
| suspension / role change | `users.setStatus` + `sessions.revokeAllForUser` | sequential; the ordering above depends on it |
| password change / reset | `credentials.*` + `sessions.revokeAllForUser` | sequential |
| login | credential read + user read + session insert | two gates, no transaction |
| registration | `users.create` + `credentials.create` | sequential |

### 18.4 Public versus internal authentication errors

`LoginResult` failures carry **only** `{ outcome, reason }`. The reason is an
**internal** vocabulary for the caller to map; it is not a response body.

**`attemptsRemaining` was removed from the result.** It was present for a known
user with a wrong password and absent for an unknown user — a difference that
becomes an account-existence oracle the moment a controller serialises the
result. Known and unknown users now produce **byte-identical** failures
(asserted by test). Lockout progress is logged server-side instead.

Required mapping when the endpoint is built:

| Internal reason | Suggested public response |
| --- | --- |
| `invalid_credentials` | 401, generic |
| `account_locked`, `account_pending`, `account_suspended`, `account_deactivated` | 401 or 403 — **decision D1**; each is only reachable with a correct password |
| `password_changed_concurrently` | 401, generic (never explain) |
| `authentication_unavailable` | 503 |

**UX trade-off to decide (D1).** The confirmed frontend shows
*"Warning: N attempts remaining"*. Restoring it means either (a) returning the
count only after a correct password — useless, since the login then succeeds;
(b) returning it for wrong passwords and accepting the enumeration signal; or
(c) returning a count for unknown identifiers too, which means fabricating a
number. **Recommendation: drop the counter** and keep the generic message. If
the counter is wanted, (b) is the honest option and the enumeration cost should
be accepted explicitly.

### 18.5 Lockout and concurrency behaviour

- Five consecutive failures lock the credential; the counter is incremented by
  one atomic statement, so parallel guesses cannot defeat it.
- A **correct password does not unlock**. Recovery is a verified password reset
  or an administrator unlock (**Q4a** still open).
- The counter reset is **atomic and conditional** (`resetFailedAttemptsIfAuthorized`).
  **Superseded §18.8:** the earlier wording here described a re-read-based
  mitigation, which was insufficient — an unconditional reset erased the
  lockout before any re-read could observe it. The guard now lives in the
  write itself.
- A **failed attempt that cannot be recorded** is logged at error level; the
  login still fails, but the lockout may under-count. Operators need to see it.

### 18.6 Rehash handling

Every rehash failure — a lost compare-and-set, a timeout, a dropped
connection — leaves the stored hash **uncertain**, and a timeout may even have
committed. The error type is therefore **not** used to decide the login.

Instead the gate accepts either of two hashes: the one verified, or the upgrade
just written. That resolves all four cases precisely:

| Situation | Stored hash | Outcome |
| --- | --- | --- |
| Rehash succeeded | our upgrade | login proceeds |
| Rehash did not land | the original | login proceeds, upgrade retried next time |
| Timeout that actually committed | our upgrade | login proceeds |
| Someone else changed the password | neither | **refused** |

A database timeout is never assumed to mean the original hash is still current.

### 18.7 Remaining business decisions

- **D1** — how login conveys state, and whether to restore the attempt counter.
- **D4** — refresh-token transport. **Blocking any login endpoint.**
- **Q4a** — lockout policy: permanent (implemented) or timed.
- **Q-X1 / Q-CR6** — transactions, which close the residual TOCTOU gap.
- **Student gates** — `isEmailVerified`, `isMobileVerified` and
  `adminApprovalStatus` live on `Student`, not `User`, so they are **not**
  checked. `User.status === "pending"` covers the coarse case. Either the
  students module maintains `User.status` (keeps auth decoupled, preferred) or
  the login service takes `StudentRepository` (couples the modules). Needs a
  decision.

### 18.8 The lockout-erasure defect, and the atomic conditional reset

Found in review of the first 6H hardening pass. The most serious defect in
the login path so far, because it defeated the lockout entirely.

**The race.** `resetFailedAttempts` was an ordinary, unconditional write.
With the counter at four:

```
1. a correct-password login starts verifying        (~120ms of argon2)
2. a concurrent FIFTH failure lands  -> counter 5 -> LOCKED
3. the successful login resets the counter to 0     -> LOCK ERASED
4. both authorization gates re-read -> counter 0 -> nothing looks wrong
```

**Why the two re-reads could not catch it.** They were added in the first
hardening pass to detect concurrent state changes, and they do - but here the
login *destroyed the evidence before reading it*. No number of re-reads can
detect a lock that has already been erased. The guard had to move into the
write itself.

**Worse, the test for this scenario hid it.** It forced
`resetFailedAttempts` to throw, so the reset never ran and the lock survived
for the wrong reason. The test passed while the production path was broken.
It now exercises the real reset, with the concurrent failure injected
immediately before it.

#### The contract

`resetFailedAttempts(userId)` is **replaced** by:

```ts
resetFailedAttemptsIfAuthorized(input: {
  userId: EntityId;
  threshold: number;
  acceptableHashes: readonly string[];
}): Promise<ConditionalResetResult>
```

```ts
type ConditionalResetResult =
  | { status: "reset"; credential: CredentialRecord }
  | { status: "locked"; credential: CredentialRecord }   // NOT written
  | { status: "password_changed" }                        // NOT written
  | { status: "not_found" };
```

The guard, all evaluated with the write:

1. a credential exists;
2. it is NOT locked (counter below `threshold`, no future `lockedUntil`);
3. the stored hash is one of `acceptableHashes`.

On any failed condition **nothing is written**, so a lockout survives. A
correct password still never unlocks an account (policy Q4a).

`acceptableHashes` is normally one value - the hash read before verification -
and TWO when the same login also upgraded the hash. Accepting both is what
keeps an uncertain rehash safe, and it is why the reset is ordered *after* the
rehash.

The old method was removed rather than kept, because its unconditional
semantics are precisely the defect; leaving it would be a footgun. The
compiler found all eight call sites.

#### Required SQL Server semantics

One guarded UPDATE. **Never SELECT-then-UPDATE:**

```sql
UPDATE credentials
   SET failed_login_attempts = 0
 OUTPUT inserted.*
 WHERE user_id = @userId
   AND failed_login_attempts < @threshold
   AND (locked_until IS NULL OR locked_until <= SYSUTCDATETIME())
   AND password_hash IN (@hash1, @hash2);
```

A row in `OUTPUT` means `reset`. Zero rows affected means the guard failed,
and only **then** may the adapter issue a single `SELECT` to classify the
refusal as `locked`, `password_changed` or `not_found`. That read **reports**;
it does not decide. The decision was already made atomically by the `WHERE`
clause, and the login is refused either way - so this is not read-then-write.

`locked_until` is deliberately left untouched: clearing a lockout is
`clearLockout`, an audited administrative action.

#### Login service handling

| Outcome | Login |
| --- | --- |
| `reset` | proceeds |
| `locked` | refused `account_locked` - the lock survived |
| `password_changed` | refused `password_changed_concurrently` |
| `not_found` | refused `invalid_credentials` |
| throws | refused `authentication_unavailable` |

**A behaviour change worth noting:** a reset that *throws* now refuses the
login. Previously it was logged and the login continued. A throw leaves both
the counter and the lock state unknown, and the lead's instruction is to
prefer fail-closed where credential state cannot be established safely. The
cost is that a transient write failure denies an otherwise valid login.

### 18.9 Remaining windows: which writes can still erase a lockout?

Every ordinary write to a credential was re-examined.

| Operation | Can it erase a lockout? | Why that is correct |
| --- | --- | --- |
| `resetFailedAttemptsIfAuthorized` | **No** | guarded; refuses when locked |
| `clearLockout` | **Yes, by design** | it IS the administrator unlock - audited, and the confirmed recovery path |
| `resetPassword` | **Yes, by design** | a verified password reset is the confirmed self-service unlock path; authorization is the single-use OTP grant (O8) |
| `changePassword` | **Yes, by design** | the user proved the current password; guarded by compare-and-set |
| `rehashPassword` | **No** | touches only the hash; leaves the counter and lockout alone |
| `recordFailedAttempt` | **No** | only increments; never clears |
| `create` | **No** | a new credential has no lockout to erase |

So exactly three operations clear a lockout, and each is a deliberate,
authorized unlock path rather than a side effect. **The dangerous case - an
incidental clear on the success path - is closed.**

#### What is guaranteed within ONE credential repository

- The counter cannot lose increments under concurrency (atomic increment).
- A lockout cannot be erased by the login success path (guarded reset).
- A password write cannot land on a credential someone else already changed
  (compare-and-set on `changePassword` and `rehashPassword`).

#### What still requires cross-repository transactions

**Two authorization re-reads do NOT make login atomic, and this document
does not claim they do.** The remaining gap is unchanged from §18.2: a
`users` status or role change can commit between the final gate and the token
being returned. That spans `users`, `credentials` and `sessions`, so no
single-repository operation can fix it - which is why none was added here.

It is mitigated, not eliminated: the change's own `revokeAllForUser` sweep
catches a session created before it, the post-create gate catches a change
committed before it, Step 6F validates the session on every authenticated
request, and the access token lives only 15 minutes. **Full closure needs
Q-X1 / Q-CR6 transactions.**

### 18.10 Business decisions still outstanding

- **Q4a** - lockout policy: permanent (implemented) or timed.
- **D1** - how login conveys state; whether to restore the attempt counter.
- **D4** - refresh-token transport. **Blocking any login endpoint.**
- **Q-X1 / Q-CR6** - transactions, for the residual TOCTOU window.
- **Student gates** - `isEmailVerified`, `isMobileVerified` and
  `adminApprovalStatus` live on `Student`, not `User`, and are not checked.
- **New:** is denying a login on a transient reset-write failure acceptable,
  or should it degrade to allowing the login with an elevated counter? Current
  behaviour is fail-closed.

---

## 19. Refresh service (Step 6I)

`src/modules/auth/refresh.service.ts`. Application service only — no HTTP
endpoint, and deliberately no opinion on transport (**D4**).

### 19.1 A refresh token is not a JWT

32 bytes of CSPRNG output, base64url encoded. It carries no claims, is never
parsed and is never verified cryptographically. It is meaningful only as a
lookup key against the stored session, which is exactly what makes revocation
possible. The service validates only its **shape** (`[A-Za-z0-9_-]{43}`)
before any I/O, so a junk value costs no database work.

### 19.2 Lifecycle

```
1 validate shape                         -> invalid_refresh_token
2 hash + resolveRefreshToken
    consumed -> REUSE: revoke family     -> token_reuse_detected
    unknown                              -> invalid_refresh_token
3 session usable? (revoked / expired)    -> invalid_refresh_token
4 gate one: re-read user                 -> user_not_authorized
5 rotate (compare-and-set)
    lost CAS -> REUSE: revoke family     -> token_reuse_detected
    not active                           -> invalid_refresh_token
    other error -> discard session       -> refresh_unavailable
6 gate two: re-read user (authoritative) -> discard session, user_not_authorized
7 sign access token with the CURRENT role
8 return the new pair
```

Gates 4 and 6 mirror the hardened login flow: the first avoids consuming a
token for a refresh that cannot succeed, the second sits as close to signing
as possible.

### 19.3 Atomic rotation

`sessions.rotateRefreshToken` is a compare-and-set on the presented hash. The
adapter must install the new hash **and** write the consumed-token record in
one atomic statement (§15.5) — never read-then-write. The service never
performs its own read-modify-write of the token.

Rotation preserves `sessionId` and `familyId`: the session continues, and only
the refresh token changes.

### 19.4 Reuse detection

Two paths reach the same conclusion:

- `resolveRefreshToken` returns **consumed** — an already-rotated token was
  presented;
- `rotateRefreshToken` throws **OptimisticLockError** — the hash was current
  when resolved but had been consumed by the time we wrote.

Both mean "this token is no longer current", and both trigger
`revokeSessionFamily({ reason: "token_reuse_detected" })`. Nothing is issued,
and no replacement session is created. The request is refused even if the
revocation itself fails — a failed revocation is an operator problem, never a
reason to issue tokens.

**Concurrency: exactly one refresh can win.** With two simultaneous requests
holding the same token, one rotates and the other hits one of the two paths
above. Verified with real parallel calls and with a deterministic lost-CAS
injection.

**The legitimate loser is logged out, and that is deliberate.** A client that
double-submits — a retry, two tabs, a flaky network — is indistinguishable
from an attacker replaying a stolen token, so the family is revoked and the
user must sign in again. This follows the OAuth 2.0 Security BCP and favours
safety over convenience.

The standard mitigation, if this proves disruptive, is a short grace window in
which re-presenting the just-consumed token returns the **same** newly issued
pair rather than revoking. It is **not implemented**, and it is a decision for
the backend lead, not a default to assume.

### 19.5 User authorization

The service re-reads the user itself rather than trusting that sessions were
revoked when the account changed. That coordination is required (§16.3) but is
**not implemented anywhere** — the modules that change status and role do not
exist — so without this a suspended account would keep minting access tokens
for as long as its refresh token lived.

Checked at both gates: the user exists, the status is **exactly `active`**,
and the **current** role is used for the new JWT.

The status check is an **allow-list**, which matters: the first version
listed the blocked statuses, so any status added to `UserStatus` later -
"archived", "locked" - would have been permitted by default. It now fails
closed. The login service had the identical fail-open pattern and was
corrected in the same change. A role change made since the session began is picked up, in either
direction. Nothing is read from the client: the user id comes from the stored
session, and the role from the user record.

### 19.6 Failure handling and cleanup

| Stage | Failure | Behaviour |
| --- | --- | --- |
| Shape | malformed | refuse, no I/O |
| Token lookup | throws | refuse, `refresh_unavailable` |
| User lookup | throws | refuse; nothing consumed |
| Pre-gate | unauthorized | refuse; **token NOT consumed** |
| Rotation | lost CAS | revoke family, refuse |
| Rotation | session not active | refuse; nothing to clean |
| Rotation | other / timeout | **discard the session**, refuse |
| Post-gate | unauthorized | **discard the session**, refuse |
| Signing | throws | **discard the session**, refuse |
| Cleanup revoke | throws | still refuse |

"Discard" means `revokeSession({ reason: "issuance_failed" })` — the session
only, never the family: an internal fault is not evidence of theft, and
revoking the family would log the user out of every device over a server
error.

#### What is guaranteed, and what depends on a repository write succeeding

The earlier wording here said *"No usable rotated token is ever left
behind."* **That was an overclaim** and is corrected below. Revocation is a
repository write, and a write can fail.

**Guaranteed unconditionally — independent of any repository success:**

- On any failure the service returns **no access token and no refresh
  token**. The rotated token's plaintext is never returned, so **nobody can
  present it**, whatever happens to the cleanup.
- The previous token is consumed by the rotation itself, atomically.
- No replacement session is ever created on a failure path.

**Guaranteed only if the cleanup write commits:**

- that the session row is actually revoked;
- that it disappears from the user's active session list;
- for reuse detection, that the rest of the family is revoked.

**Reported, never assumed.** Every failure result carries a `cleanup` field —
`not_required`, `committed` or `failed`. `committed` is returned only after
the write succeeded or a confirmation read proved it landed; anything else is
`failed`. The service never claims a revocation it could not establish.

Cleanup uses the idempotency the port already documents: one attempt, a
confirmation read on error (a read *after* an unconditional write, so not a
read-then-write sequence), then one retry, then `failed`.

#### Operational risk when cleanup fails

The two cases differ sharply in severity, and conflating them would be a
mistake:

| Failed cleanup | Residual risk | Severity |
| --- | --- | --- |
| `revokeSession` after a post-rotation failure | A session row stays listed as active, holding a refresh hash whose plaintext **nobody received**. It cannot be refreshed by anyone and no access token was issued, so it is unusable — but it clutters the user's session list until it expires. | **Hygiene.** Not an access-control hole. |
| `revokeSessionFamily` after reuse detection | **The response to suspected token theft did not take effect.** Sessions in the family remain usable until they expire, so whichever holder is the attacker keeps access. | **Security incident.** Needs alerting and manual revocation. |

The second case logs at `error` with an explicit `SECURITY:` prefix naming
the user and family, precisely so it can be alerted on. **An operator must
act**: revoke the family manually.

#### Future production requirement

In-process retry handles a transient blip and nothing more. If the database
is unreachable, the revocation is simply lost. Guaranteeing it needs
durability the current contracts do not provide:

- a **transactional outbox** — record the revocation intent in the same
  transaction as the triggering work, with a worker draining it until it
  succeeds; or
- a **durable job queue** with retry and a dead-letter path; or
- performing the revocation **inside the database** (the rotation statement
  itself could mark the family on a reuse condition), which removes the
  cross-process gap entirely.

All three require the unit-of-work contract (**Q-X1 / Q-CR6**) or database
support. Until one exists, **failed revocation is a real residual risk** and
the `SECURITY:` log line is the compensating control. Recorded as a future
production requirement.

An **uncertain** rotation (a timeout that may have committed) is also resolved
by discarding the session. That converts an ambiguous state into a
deterministic one and avoids the client's next refresh appearing as token
theft in the audit trail. The cost is one forced re-authentication — and if
that discard fails, the hygiene case above applies.

#### Contract change required for this, and why

`SESSION_REVOCATION_REASONS` gained one additive member, **`issuance_failed`**.
Without it the only approximate fit was `admin_terminated`, which would record
an internal fault as an administrative action — a lie in the audit trail, in
the very field that exists to explain a revocation. The login service's
orphan-cleanup path was switched to it in the same change (one line); it had
the same mislabelling.

### 19.7 SQL Server requirements

Already specified in `docs/database-handoff.md` §15.5 and the session port;
restated because refresh is the operation that depends on them most:

- **Rotation is one atomic statement**: verify active, compare the stored hash,
  install the new hash, insert the consumed record — a single conditional
  `UPDATE` plus the insert in the same transaction, never
  SELECT-then-UPDATE. Two concurrent refreshes would otherwise both read the
  same hash and both write, leaving two live refresh tokens and making reuse
  detection meaningless.
- **Zero rows affected must be classified** into "no such session", "not
  active" and "hash mismatch" so the right typed error is thrown; the service
  branches on exactly those three.
- **Indexes** on the current refresh-token hash and on the consumed-token hash
  — both are read on every refresh.
- **The consumed-token table needs its scheduled purge** (`purgeAfter`), or it
  grows without bound: ~2,900 rotations per 30-day remembered session.

### 19.8 Remaining cross-repository race conditions

The service reads `users` and writes `sessions` with no unit of work between
them, so the §18.2 window applies here too: a status or role change can commit
between gate two and the token being returned.

Mitigated by the same four factors — the change's own revocation sweep, the
post-rotation gate, Step 6F per-request session validation, and the 15-minute
access-token lifetime. **Not eliminated.** Full closure needs Q-X1 / Q-CR6
transactions, and this document does not claim atomicity the repository
interfaces cannot provide.

One narrowing specific to refresh: because the service re-reads the user on
every refresh, a suspended account loses access within one refresh cycle even
if nothing ever revokes its sessions.

### 19.9 Transport remains undecided (D4)

The service returns the rotated refresh token to its caller and takes no
position on how it reaches the client. **No endpoint may expose it until D4 is
decided**: a response body puts a long-lived credential in `localStorage`
alongside the access token, where any XSS can read it; an httpOnly, Secure,
SameSite cookie is stronger but needs CSRF protection and frontend work.

A note for whoever implements the endpoint: `token_reuse_detected` must **not**
be distinguishable from `invalid_refresh_token` in the response. The internal
distinction exists for logging and auditing only — a client that can tell them
apart learns whether it holds something that was once valid.

---

## 20. Session management service (Step 6J)

`src/modules/auth/session.service.ts`. Application service only — no HTTP, no
status codes, no `ApiError`.

### 20.1 Interfaces

```ts
logout(principal)                          -> RevokeSessionOutcome
logoutEverywhere(principal)                -> LogoutAllResult
listMySessions(principal, pagination?)     -> ListSessionsResult
terminateSession(principal, targetId)      -> RevokeSessionOutcome
```

```ts
type RevokeSessionOutcome =
  | { outcome: "success" }       // revoked; idempotent
  | { outcome: "not_found" }     // unknown OR another user's - never distinguished
  | { outcome: "unavailable" };  // write failed or outcome unknown

type LogoutAllResult =
  | { outcome: "success";    summary: LogoutAllSummary }   // nothing known to remain
  | { outcome: "incomplete"; summary: LogoutAllSummary }   // some remain, or unknown
  | { outcome: "unavailable" };

interface LogoutAllSummary {
  sessionsRevoked: number | "unknown";
  remainingActive: number | "unknown";
}
```

### 20.2 Authorization rules

**Every identity value comes from the trusted principal.** `authenticate`
builds `AuthenticatedPrincipal` from a verified access token whose session was
validated against the store (Step 6F), so `userId` and the current
`sessionId` are server-derived. Nothing in this service reads a user id or
role from a request.

The **only** client-supplied value accepted anywhere is the target session id
of `terminateSession`, and it is never trusted — it is passed to a write that
matches on owner as well.

**Ownership is enforced in the write, not by a prior read.**
`revokeSession({ sessionId, userId, reason })` matches on both ids and throws
`RecordNotFoundError` when either fails to match. Consequences:

- there is **no read-then-write window** in which a session could change
  hands between an ownership check and the revocation;
- another user's session is **indistinguishable** from one that does not
  exist, so the operation cannot be used to probe for other people's session
  ids.

No contract change was needed for this step. Had ownership been checkable
only by reading first, that race would have had to be closed inside the port.

Neither logout nor termination needs the raw refresh token, and none of the
four operations returns an access or refresh token.

### 20.3 Session lifecycle, end to end

```
login            -> session created, refresh token issued
refresh          -> token rotated, session continues
listMySessions   -> safe projection, current session marked
terminateSession -> one session revoked (reason: logout)
logout           -> current session revoked (reason: logout)
logoutEverywhere -> all sessions revoked (reason: logout_all), current included
```

After logout, both credentials for that session are dead: a refresh with its
token is refused, and its access token is rejected by `authenticate` on the
next request even though the JWT itself is still cryptographically valid.
Verified end to end with the real login, refresh and middleware —
`login -> refresh -> logout -> refresh rejected` is a single test.

**Terminating the current session is permitted.** The confirmed frontend lists
it with `isCurrent` alongside the others, and refusing would mean the one
session a user can definitely prove they own is the one they cannot end. It is
equivalent to logout, which is why both record the same `logout` reason.

*A known limitation of that choice:* the audit trail cannot distinguish "the
user logged out of this device" from "the user remotely terminated this
device". A dedicated reason would fix it; none was added, because the brief
was to use an existing reason.

### 20.4 The safe projection

`Session` carries `refreshTokenHash` (a credential verifier) and `familyId`
(an internal rotation detail). Neither belongs in a response, so
`listMySessions` returns `SessionView`, which is **structurally incapable** of
carrying them — they are not in the type, so a controller cannot leak one by
forgetting to strip a field.

`SessionView` is `{ id, isCurrent, device?, browser?, os?, ipAddress?,
location?, createdAt, lastActiveAt }`, mirroring the frontend's confirmed
`SessionItem`. `isCurrent` is derived by comparing each row against the
principal's `sessionId`; it is never stored, because "current" is a property
of the request.

Tests assert the stored hash, the family id, consumed refresh tokens and
credential material are all absent from the output.

**Pagination** uses the existing `PaginatedResult` contract and is applied in
the service, not the repository: a user has a handful of devices, so slicing
here avoids widening the port for no benefit, and the shape the frontend
expects is unchanged. Input is normalised by `normalizePagination()` - see
§20.8 correction 1, which replaced an unsafe `Math.trunc`/`Math.max` pair
that let `NaN` reach the response.

### 20.5 Failure handling

| Situation | Result |
| --- | --- |
| Session unknown, or owned by someone else | `not_found` |
| Malformed target session id | `not_found`, no write attempted |
| Revoke write fails, confirmed still active | `unavailable` |
| Revoke write errors but actually landed | `success` (confirmed by reading) |
| Revoke fails once, retry succeeds | `success` |
| Listing read fails | `unavailable` |
| `revokeAllForUser` fails, sessions remain | `incomplete`, with the observed count |
| `revokeAllForUser` errors but all were revoked | `success`, count `"unknown"` |

Note the bulk operation is **not a barrier against concurrent logins** - see
§20.8 correction 2.
| Nothing can be established | `unavailable` |

**No success is reported for an unconfirmed write.** Revocation is idempotent
per the port, so the sequence is: attempt → on error, confirmation read → one
retry → give up. The confirmation read happens *after* an unconditional write
and gates nothing, so it is not a read-then-write sequence.

Failure results carry only `{ outcome }` — no internal error text, no host
names. Asserted by test.

### 20.6 Repository atomicity requirements

**`revokeSession` must match on `session_id` AND `user_id` in one statement.**
This is the ownership control. An adapter that reads the session, checks the
owner in application code and then writes would reintroduce a cross-user race
and must not be written that way.

```sql
UPDATE sessions
   SET revoked_at = SYSUTCDATETIME(), revocation_reason = @reason
 WHERE session_id = @sessionId
   AND user_id    = @userId
   AND revoked_at IS NULL;
```

Zero rows affected is ambiguous between "no such session for this user" and
"already revoked", so the adapter classifies it with a follow-up read scoped
to both ids — reporting only, never deciding.

**`revokeAllForUser` is NOT promised to be atomic across rows**, and this
service does not pretend otherwise: a failure mid-way can leave some sessions
revoked and others active, which is exactly why `logoutAll` establishes the
remaining count and can return `incomplete`. If the database can do it in one
statement, say so and the service can be simplified.

### 20.7 Remaining production limitations

- **Nothing persists.** No SQL adapter exists; every behaviour here is
  verified against the in-memory fake. "Logout works" means the logic is
  correct, not that it works in production.
- **No HTTP surface.** These are services; **D4** (refresh-token transport)
  still blocks the auth endpoints, and it remains **unresolved**.
- **A failed revocation is a real risk.** Retry plus confirmation handles a
  transient blip; an unreachable database loses the revocation, and the user
  stays signed in. Closing that needs the durability discussed in §19.6 —
  transactional outbox, durable queue, or in-database revocation — all of
  which require **Q-X1 / Q-CR6**.
- **`logoutEverywhere` can report `incomplete`**, which a future endpoint must
  handle rather than render as success.
- **Audit granularity**: user-initiated termination of another device records
  `logout`, same as a local logout (§20.3).

### 20.8 Security corrections after review (Step 6J, second pass)

Four defects found reviewing the first version. All are corrected; two
changed observable behaviour.

#### 1. Pagination could put `NaN` in a response

`Math.max(1, Math.trunc(value))` does not normalise `NaN` or `Infinity`:
`Math.trunc(NaN)` is `NaN` and `Math.max(1, NaN)` is `NaN`. A non-numeric
page size therefore reached the response as `pageSize: NaN` and
`totalPages: NaN`, both of which serialise to `null`. Unbounded page sizes
and page numbers large enough to break safe-integer arithmetic were also
accepted.

Replaced with `normalizePagination()` in `src/contracts/api.contract.ts` -
a shared contract helper, so every future service normalises identically.
Guaranteed for **any** input:

| Input | Result |
| --- | --- |
| `NaN`, `Infinity`, `-Infinity`, non-number | the default (`page` 1, `pageSize` `DEFAULT_PAGE_SIZE`) |
| `0`, negatives | `1` |
| fractions | truncated towards zero |
| above the maximum (finite) | clamped to `MAX_PAGE` / `MAX_PAGE_SIZE` |

`page` is bounded by the new `MAX_PAGE` (1,000,000) so `page * pageSize`
stays inside the safe-integer range - 1e6 x 100 is 1e8, well below
`Number.MAX_SAFE_INTEGER`.

**Infinity falls back rather than clamping, deliberately.**
`Number.isFinite(Infinity)` is false, so it is treated as garbage, not as a
request for the largest allowed page: `pageSize: Infinity` must not quietly
return 100 rows.

`MAX_PAGE_SIZE` is the existing shared bound, unchanged, and the
`PaginatedResult` response shape is untouched.

**Two layers, on purpose.** At the HTTP edge `paginationSchema`
(validate.middleware.ts) still **rejects** out-of-range input with 422 - a
client asking for `pageSize=9999` has a bug worth surfacing. Inside a
service the input may come from another service or a test, and the invariant
that matters is that a response can never contain `NaN`. So the edge
validates strictly and the service clamps defensively.

#### 2. `logoutEverywhere` claimed more than the repository promises

The result reported `remainingActive: 0`, and the previous text said "every
session is revoked". `revokeAllForUser`'s contract is only *"how many
sessions this call newly revoked"* - it revokes what was active **when it
ran** and is **not a barrier**. A concurrent login can create a valid
session a microsecond later, so `remainingActive: 0` asserted a current
state that was never established.

Corrected minimally: the field is now
`activeWhenLastChecked: number | "unknown" | "not_checked"`.

- **`"not_checked"`** on the clean path. The repository returning normally
  means it revoked everything active at that instant, and no extra read is
  taken - so nothing is claimed about *now*.
- **A number** only when the service actually looked, which it does after a
  failure.

`outcome: "success"` now means *"every session that was active when this ran
is revoked"*, **not** *"this user has no sessions"*.

A deterministic test proves the boundary: a login injected during the sweep
produces a session that survives, while the operation still reports
`success`. Closing that window would need a barrier the repository does not
provide - a per-user "sessions blocked until" marker that login also
consults, or a transaction spanning both (**Q-X1 / Q-CR6**). Neither exists,
so neither is claimed.

#### 3. Raw driver messages reached the logs

Three `logger.error` calls logged `err.message`. Database exceptions
routinely embed secrets in their text - `"Login failed for user 'sa' with
password '...' on server db-prod-01"`, connection strings, hosts, ports.
`redact()` cannot help: it replaces values under sensitive **keys**, and an
exception message is free text under an innocent key.

Added `describeError()` to `src/utils/redact.ts`, which keeps only the
error's **class name** and discards the message. A thrown non-Error is never
stringified either, because the value itself could be a credential.

Operational context is preserved through the caller's own structured
fields - user id, operation, attempt number - which is enough to correlate
an incident with the database's own logs, where the detail already lives in
a place trusted with it.

Tests inject an exception stuffed with a password, a host name, a port and a
connection string, and assert none of it reaches the log.

**A related observation worth knowing:** `redact()`'s pattern includes
`/session/`, so **`sessionId` is itself redacted in log lines**. That is
stricter than necessary - a session id is not a credential on its own - but
it is left as-is rather than loosening a security pattern for convenience.
Diagnosis relies on `userId`, the operation name and the error class. If
support needs session ids in logs, narrowing the pattern is a deliberate
decision for the backend lead, not a quiet change.

#### 4. The projection was correct but unproven

`toSessionView` already builds its result by **explicit assignment** rather
than spreading the source row, so it was a runtime allow-list and not merely
a TypeScript claim. That had no test, which is the gap that mattered: the
interface alone would not stop an adapter that over-selects columns.

Now proven. A test seeds a stored session carrying `refreshTokenHash`,
`passwordHash`, `internalNote`, `connectionString` and a prototype-shaped
key, then asserts the serialised output contains the agreed six keys and
none of the injected values. A second test asserts optional fields are
**omitted** rather than emitted as `undefined`.

### 20.9 Remaining production risks (updated)

- **Nothing persists.** No SQL adapter; all behaviour is verified against the
  in-memory fake.
- **`logoutEverywhere` is not a barrier** (correction 2). A concurrent login
  survives it. Needs a database-level marker or a transaction.
- **A failed revocation is a real risk.** Retry plus confirmation handles a
  transient blip; an unreachable database loses the revocation and the user
  stays signed in. Needs the durability from §19.6.
- **`logoutEverywhere` can report `incomplete`**, which a future endpoint
  must surface rather than render as success.
- **Session ids are redacted from logs** by the shared policy (correction 3),
  which reduces traceability.
- **The same raw-message logging pattern still exists in `login.service.ts`,
  `refresh.service.ts` and `password.service.ts`.** Only `session.service.ts`
  was in scope here. Applying `describeError()` across them is a small,
  mechanical follow-up and is **recommended**, but was not done unasked.
- **D4 refresh-token transport remains unresolved** and blocks every auth
  endpoint.

## 21. Registration service (Step 6K)

Application service only. No HTTP endpoint, no SQL Server, no frontend
change. `src/modules/auth/registration.service.ts`.

### 21.1 What registration does

`register(input: unknown): Promise<RegistrationResult>` — five steps:

| # | Step | Guarantee |
| --- | --- | --- |
| 1 | `registrationSchema.safeParse` | nothing unvalidated proceeds; issues name fields, never values |
| 2 | fast-path `existsByEmail` / `existsByMobile` | **convenience only** — not the guard |
| 3 | `hashPassword` | policy enforced a second time; argon2id at the shipped parameters |
| 4 | `users.create` | **the authoritative uniqueness guard**; role and status are fixed here |
| 5 | `credentials.create` | the account becomes usable |

The success payload is exactly `{ tempStudentId, email, mobile }` — no hash,
no token, no internal field. That shape is the frontend's, not a proposal:
`registerStudent` is typed `ApiResponse<{ tempStudentId, email, mobile }>`
and `RegisterPage` navigates to `/verify-otp?studentId=${tempStudentId}`.
This **corrects** docs/api-contracts.md, which had proposed
`{ studentId, otpChannels }` (decision **D2**).

Failure reasons are internal; a controller maps them:

| Reason | Meaning |
| --- | --- |
| `validation_failed` | carries `FieldIssue[]` |
| `email_taken` / `mobile_taken` | the identifier is registered |
| `incomplete` | **user created, credential not** — see §21.3 |
| `registration_unavailable` | a repository failed before anything was written |

### 21.2 Confirmed contract

Taken from the existing frontend schema and the confirmed contracts, not
invented here.

- **Role.** Public registration creates **students only**. `role: "student"`
  is **hardcoded at the `create` call** and no `role` field exists in the
  schema, so a `role` in the payload is both stripped by Zod and ignored by
  the service. Teacher, admin and super-admin accounts are created by staff
  through a different, authenticated flow (BR-010), which this step does not
  build. Tested against `admin`, `super_admin`, `teacher` and `public`.
- **Required fields.** `name`, `email`, `mobile`, `password`,
  `confirmPassword`, `collegeName`, `degreeBranch`, `passingYear`,
  `courseInterestedIn`, `dateOfBirth`, `gender`, `fullAddress`,
  `guardianContact`, `termsAccepted`. Optional: `linkedInUrl`, `githubUrl`,
  `resumeFileName`, `resumeFileSize`.
- **Uniqueness.** Email **and** mobile are each unique across all users.
  Email is lowercased and trimmed by the schema, so uniqueness never depends
  on database collation.
- **Password policy.** Unchanged and shared: ≥8 and ≤128 characters, with an
  uppercase, a lowercase, a digit and a special character
  (`passwordPolicySchema`). One case per rule is tested.
- **Initial status.** `pending`. BR-001 verification and BR-002 admin
  approval both precede activation, and `login` already refuses a `pending`
  account — proven by a test that registers, then attempts a login with the
  *correct* password and asserts `account_pending`.

**`resumeDataUrl` is deliberately not accepted.** The frontend builds a
base64 data URL for preview. Accepting it would mean either persisting an
unbounded base64 blob in a user row or silently discarding a field the
caller believes was saved. Not accepting it makes the gap visible at the
contract boundary. File upload is **Q11** and unresolved.

### 21.3 Two things registration deliberately does not do

**1. It issues no OTP.** No OTP service exists and **Q3** is unresolved:
BR-001 requires both an email and a mobile OTP while BR-014 disables SMS.
Leaving the account at `pending` is correct whichever way Q3 resolves.
**Registration is therefore incomplete as a user journey** — an account can
be created but not yet verified, so nobody can reach `active` through
self-service. That is a gap in the flow, not a defect in this service.

**2. It does not persist the admissions profile.** *(SUPERSEDED — kept for
context. Since Step 6K-2 the profile IS persisted through
`StudentRepository.createForUser`, keyed by the user's own id; that
shared-key model was ratified as Q25 on 2026-11-20 — see open-questions Q25 and
database-handoff.md §17.4. Registration is still not atomic; a failed
profile write is reported as the recoverable `profile_incomplete`.)*
College, degree, passing
year, date of birth, gender, address and guardian contact are fully
validated and then **not written anywhere.**

This is the step's blocker, and it is a contract gap, not an oversight.
`StudentRepository.create(input: CreateStudentInput)` takes **no `userId`**,
and `CreateStudentInput` omits `id`. The in-memory fake assigns
`id: this.store.nextId()` from a store entirely separate from the user store
(`InMemoryStore<Student>("student")` vs `InMemoryStore<User>("user")`), so
writing both records today produces:

- a `User` with id `user-1`, which `findByEmail` and therefore login can see;
- a `Student` with id `student-1`, linked to nothing.

An unlinked orphan is worse than a documented gap, so the write is withheld.
**The smallest fix is a `userId` on `CreateStudentInput`** plus a decision on
whether the student row is created at registration or at approval. That is a
contract change touching Developer 2's module, so it is **not made here** —
it needs Backend Lead approval and coordination. Until then a registered
student has an identity and a credential but no academic profile.

### 21.4 No atomic user + credential creation

Two repositories, no unit of work (**Q-CR6 / Q-X1**). No transaction is
invented. The order is chosen to fail **safe**:

```
1. users.create        <- takes the email and mobile, atomically
2. credentials.create
```

If step 2 fails, the user exists with **no credential and cannot log in** —
`login` treats a missing credential identically to a wrong password, so the
failure mode is closed, not open. Both halves are tested: the partial record
exists, and a login against it returns `invalid_credentials` with no session
created.

**The cost is real and is not glossed over.** The email and mobile are now
held by an unusable record, so the person cannot simply register again — a
test asserts the retry returns `email_taken`. Cleanup is **impossible** with
today's contracts: `UserRepository` has no delete, by deliberate design.
So the service returns `incomplete` and logs a loud, explicit error naming
the orphaned `userId`. **An operator must intervene.**

The smallest fixes are a unit of work spanning both repositories, or a
narrow operation to discard an unverified user. Neither is added unasked.

### 21.5 Why the fast-path check is not the guard

Step 2 reads `existsByEmail` / `existsByMobile`; step 4 relies on
`users.create` throwing `DuplicateRecordError`. The read exists only to
avoid paying ~120 ms for an argon2 hash on an obvious duplicate. Between
that read and the write another registration can land, so **the atomic
`create` is the guard** — `DuplicateRecordError.field` is mapped to
`mobile_taken` or `email_taken`.

Proven directly: a test overrides both `exists*` methods to answer "free"
and asserts the duplicate is still refused.

**A test-fake defect was found and fixed while proving this.**
`InMemoryUserRepository.create` used `await this.existsByEmail(...)` before
inserting. Each `await` is a microtask boundary, so two concurrent creates
could both observe the identifier as free and both insert — a race a SQL
UNIQUE index cannot have. The checks and the insert are now one synchronous
block, which is what the port actually promises. Without the fix the
concurrency test would have passed or failed depending on microtask
ordering. `InMemoryCredentialRepository.create` was already atomic.

Concurrency tests: two and three simultaneous registrations of the same
payload each yield exactly **one** user and **one** credential, with the
losers reporting a conflict.

### 21.6 Logging hardening (Part 3)

Thirteen log sites across `login.service.ts` (6), `refresh.service.ts` (6)
and `password.service.ts` (1) logged
``reason: `${err.name}: ${err.message}` ``. A database exception routinely
embeds secrets in its *text* — `"Login failed for user 'sa' with password
'...' on server db-prod-01"`, connection strings, hosts, ports — and
`redact()` cannot help, because it replaces values under sensitive **keys**
while an exception message is free text under an innocent one.

All thirteen now log `errorType: describeError(err)` — the error's **class
name** only. Operational context is preserved through the callers' own
structured fields (`userId`, the operation, the attempt number), which is
enough to correlate an incident with the database's own logs, where the
detail already lives somewhere trusted with it.

`token.service.ts:178` reads `err.message.toLowerCase()` and is **correct as
it stands**: it maps *jsonwebtoken's* own message to our
`AccessTokenRejection` vocabulary, and only that enum value is ever logged.
The message itself never reaches a log line. Verified, not assumed.

**A defect was found while testing this.** Login steps 2–3 — `resolveUser`
and the first `credentials.findByUserId` — were **not** wrapped in
`try/catch`, although every other repository call in the method was. A
database fault there threw straight out of `login()`, which:

1. broke the documented fail-closed contract
   (`authentication_unavailable`), and
2. **handed the raw driver exception to the error middleware** — the exact
   message this part exists to keep out of logs and responses.

Both reads are now guarded and return `authentication_unavailable`. The log
line carries **no** identifier: the failing read is what establishes who the
caller is, so there is no trusted id to log, and the submitted identifier is
unvalidated input (and, for an email, personal data). Every other repository
call in `login.service.ts`, `refresh.service.ts` and `session.service.ts`
was re-audited and is guarded.

Tests inject an exception stuffed with a login name, a password, a host, a
port and a full connection string into the credential lookup, the
failed-attempt counter, the guarded reset, session creation, the rehash, the
token lookup, the rotation, the user re-read and the cleanup revocation, and
assert that none of it reaches a log line while the error class still does.
Further tests assert no submitted password, stored hash, presented refresh
token, newly issued token, or even a token *hash* is ever logged.

### 21.7 Remaining production limitations

- **The journey is incomplete without OTP (Q3).** An account can be created
  but not verified, so no self-registered user can reach `active`.
- **No academic profile is stored** (§21.2) until `CreateStudentInput`
  carries a `userId` — a contract change needing approval and coordination
  with Developer 2.
- **User + credential creation is not atomic** (§21.4). A credential failure
  leaves an unusable record holding the email and mobile, with no contract
  to remove it.
- **Nothing persists.** No SQL adapter; all behaviour is verified against
  the in-memory fakes.
- **No registration endpoint exists**, and none should be added before D4
  (refresh-token transport) and Q3 are resolved.
