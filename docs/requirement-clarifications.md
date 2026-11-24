# Requirement Clarifications and Deviations

Formal record of approved clarifications of, and deviations from, the
Nexelvoria Academy SRS v1.0 (Approved Requirements Baseline, 4 November 2026).
Each entry quotes the affected requirements verbatim, states the decision, and
lists where the code enforces it. An entry changes only when the business owner
approves a new decision.

---

## CL-001 — Mobile OTP verification deferred at launch

| | |
| --- | --- |
| **Status** | Approved by the business owner |
| **Type** | Deviation (BR-001, AUTH-003, acceptance criterion 1) and clarification (workflow steps 2–4) |
| **Related decision** | [open-questions.md Q3](open-questions.md#q3--dual-otp-versus-disabled-sms-the-central-conflict) (retained; this entry formalises it) |

### Affected requirements (verbatim, SRS v1.0)

- **BR-001** (§4): "Students must verify both email and mobile OTP."
- **BR-014** (§4): "SMS is disabled at launch."
- **AUTH-002** (§3.2): "Support email OTP verification."
- **AUTH-003** (§3.2): "Support mobile OTP verification."
- **§3.2 workflow, steps 2–4**: "2. Student verifies email and mobile OTP. 3. Student receives limited account access. 4. Admin reviews and approves or rejects the account."
- **§5.4 Security**: "Email and mobile verification."
- **§12 Acceptance criterion 1**: "Students can register and verify email and mobile numbers."
- **§3.13 / §8**: "SMS capability supported technically but disabled at launch." / "SMS: Technically supported, disabled at launch."

### Why a decision was needed

The SRS names no non-SMS channel for a mobile OTP (WhatsApp Business API is
listed only for "Notifications and communication", provider TBD). With
BR-014 in force, BR-001 could not be met at launch, and requiring mobile
verification before approval would have blocked every approval and, through
BR-002, every payment.

### Decision

1. Mobile OTP verification is **deferred at launch**.
2. Email OTP verification remains **mandatory for all students**, including
   Admin-created students.
3. **BR-014 is unchanged**: SMS is disabled at launch.
4. Mobile numbers are still **collected and stored**, and are **never marked
   verified** without actual verification.
5. Admin approval is required **after email verification and before payment**.
6. Verified but unapproved students receive **limited account access**, as in
   the SRS registration workflow (step 3).
7. Unverified students **cannot proceed to approval**.
8. Paid enrollment activation requires **successful backend payment
   verification**.
9. Authorized free enrollment follows the **approved free-access override
   rules** (BR-004, BR-007, BR-017).
10. No SMS or WhatsApp OTP integration is introduced by this change.

### Deviation recorded

- **BR-001** is met for the email channel only at launch.
- **AUTH-003** is not provided at launch.
- **Acceptance criterion 1** is accepted at launch with the mobile-number
  verification part deferred.

### Where the code enforces it

| Decision | Enforcement |
| --- | --- |
| 2, 7 | `src/modules/students/student.service.ts` approval gate: 422 `EMAIL_NOT_VERIFIED`; mobile not required |
| 2 | `POST /admin/students` issues the email OTP; response reports mobile as `deferred` (`MOBILE_OTP_DEFERRED_REASON`, `src/modules/admin/admin.service.ts`) |
| 4 | Only `verification.service.ts` marks a channel verified, and only `"email"`; `OTP_PURPOSES` is `["email_verification"]` |
| 5 | Admin enrollment requires an approved student (`createEnrollment`, BR-002) |
| — | Reinstating a suspended or deactivated student (`setStudentStatus` → `active`) requires approval and a verified email (422 `STUDENT_NOT_APPROVED` / `STUDENT_NOT_VERIFIED`) |
| 8 | Enrollment becomes ACTIVE only via gateway payment verification, an admin-recorded manual payment of the full amount (transactional, audited), or a free-access override. The admin status endpoint can only *resume* a suspended, previously activated enrollment (422 `ACTIVATION_REQUIRES_PAYMENT` otherwise) |
| 9 | Free-access override: full fee waived, mandatory reason, ACTIVE enrollment and audit record in one transaction |
| 6 | See decisions 6a and 6b below |

### Decision 6a — Limited access before approval (approved)

A student with a verified email whose Admin approval is pending **may**: sign in;
view their own profile and approval status; view their own enrollment list and
payment history; view and receive their own notifications; view and create
their own support tickets.

They **must not**: create payment orders or make payments; access protected
learning content; apply for placements or jobs; access certificates; access or
modify another student's data.

### Decision 6b — Approval replaces account activation (approved)

Admin approval lets the student proceed without a separate activation action.
After approval the student can sign in, select courses and initiate payment.
Paid enrollment becomes ACTIVE only after successful backend payment
verification; free enrollment only through the approved free-access override.
Learning content stays protected until the corresponding enrollment is ACTIVE.
Suspended and deactivated accounts stay blocked regardless of approval.

### How 6a and 6b are enforced (backend)

| Layer | Enforcement |
| --- | --- |
| Access tier | `src/modules/students/student-access.ts` `decideStudentAccess`: `limited` (verified, approval pending), `approved` (verified, approved), or blocked (suspended, deactivated, rejected, unverified, no profile). The same function drives sign-in, token refresh and every request |
| Per request | `authenticate` reads the tier from the database on every student request, so approval, rejection and suspension take effect immediately; blocked students get 403 `ACCOUNT_NOT_PERMITTED` |
| Deny by default | Every `requireAuth` / `requireRoles` guard refuses a `limited` student (403 `STUDENT_APPROVAL_PENDING`) unless the route opts in. Opted in: `GET /students/me`, `GET /enrollments/me`, `GET /payments/me`, `POST /support/tickets`, `GET /support/tickets/my`, `GET /support/tickets/:id`, `POST /support/tickets/:id/replies`, `GET /support/notifications/my`, `PATCH /support/notifications/:id/read`, `POST /support/notifications/read-all`. Ticket and notification ownership is enforced in the service/repository |
| Sign-in | `login.service.ts`: students admitted by tier; no `active` status needed after approval |
| Payments | Order only for the student's OWN enrollment in `APPROVED_UNPAID`, priced from the enrollment's amount due (no hard-coded fallback); verification and receipts only for the paying student; activation after verified payment is now wired (was not) and failures are logged, not swallowed |
| Learning content (CRS-010) | Teachers-module student endpoints (assignments, materials, doubts, tests, submissions, lesson progress) are limited to courses/batches with an ACTIVE enrollment; lessons are checked against the enrolled course; doubts lists show only the student's own. The module's shared guard now authorizes as well as authenticates (it previously only authenticated) |
| Placements (BR-013) | Apply, own applications, own mock interviews, interview questions, and self-scheduling require at least one ACTIVE enrollment (403 `PLACEMENT_NOT_ELIGIBLE`); a student may schedule only their own mock interview |
| Dashboards | "Active students" now counts approved, not-suspended/deactivated students |
| Tests | `tests/student-access.test.ts` (real resolver, direct API requests for limited, approved and blocked students) plus updated suites |

### Findings from the student-endpoint review, and their resolution

| # | Endpoint | Decision | Status |
| --- | --- | --- | --- |
| 1 | `GET /certificates/eligibility/:courseId`, `POST /certificates/issue` | Do not invent BR-011 rules; keep blocked pending Q8 and verified data sources | **Blocked**: both return 503 `CERTIFICATE_ELIGIBILITY_UNAVAILABLE` (previously answered "eligible" from defaults). Existing certificates can still be listed, verified publicly and revoked; the Admin page no longer issues certificates locally |
| 2 | `GET /placements/records` | No public exposure of student data without an approved requirement | **Done**: Admin / Super Admin only (401 anonymous, 403 other roles) |
| 3 | `POST /enrollments` (self-enrollment) | Validate batch/course relationship and open status with existing structures | **Done**: batch read from NXA_Batches via the admin repository; 404 unknown batch, 422 `BATCH_COURSE_MISMATCH`, 422 `BATCH_CLOSED` (completed/cancelled); fails closed if no batch lookup is wired |
| 4 | `POST /payments/orders` | Never simulate the gateway | **Done; payment remains unavailable**: a `PaymentGateway` port is required to create an order; none is wired, so the endpoint returns 503 `PAYMENT_GATEWAY_UNAVAILABLE` after all access/ownership/state checks and stores nothing. The frontend no longer fabricates payment ids or signatures. Unblocking needs the Razorpay adapter and credentials |
| 5 | `POST /payments/verify`, `POST /payments/webhook` | Sandbox overrides never accepted on deployed environments | **Done**: the fixed test secret and both override signatures are honoured only when `NODE_ENV=test` (the automated suite); on development, staging and production there is no default secret and overrides are ordinary wrong signatures. Signature comparison is constant-time |
| 6 | Payment receipts | Real values only | **Done**: student name from the user record and course title from the enrollment's course, resolved before anything is written; if unavailable, verification is refused (503 `RECEIPT_DETAILS_UNAVAILABLE`) and nothing is recorded. Receipt numbers use the real year and a random suffix |
| 7 | Coupon at order time | No stacking on an Admin-applied discount | **Done**: 422 `COUPON_NOT_STACKABLE` when the enrollment's `DiscountAmount` is greater than zero; orders charge the enrollment's amount due |

### Reversal

To provide mobile verification later: approve a delivery channel (SMS under a
BR-014 change, or another channel), add `"mobile_verification"` to
`OTP_PURPOSES`, mount the mobile OTP routes, and re-add mobile verification to
the approval gate. Existing students would then need a migration plan for their
unverified numbers.

---

## Group C business decisions (consolidated register, Batch 3 after Item 10D)

The consolidated Group C register (18 decisions, D1–D18) was presented to the
business owner after Item 10D. Only the decisions marked **Approved** below
are business rules. Every other D-number remains a recommendation, not a
decision, and nothing may be implemented from it. Related open questions are
annotated in [open-questions.md](open-questions.md).

| Decision | Status | Related |
| --- | --- | --- |
| D1 Pass-mark and attendance-minimum precedence | **Approved** | Q8, BR-011 |
| D2 Attendance percentage formula | **Approved** | BR-010, BR-011 |
| D3 Test scoring, attempts and retakes | Open (not approved) | Q19, BR-012 |
| D4 Course prerequisite enforcement | **Approved** | — |
| D5 Content versioning | Open (not approved) | — |
| D6 Batch capacity | **Approved** | Q5 |
| D7 Lockout policy | **Approved** | Q4a |
| D8 Time zone | Open (not approved) | Q15 |
| D9 Academic and course settings | **Approved** (revised proposal, after "modify") | Q16 |
| D10 Permission model | Open (not approved) | Q10, BR-018 |
| D11 Two-factor authentication | **Approved** | Q14 |
| D12 Refund eligibility | Open (not approved) | Q6, BR-006 |
| D13 GST | Open (not approved) | — |
| D14 Retention, export and deletion | Open (not approved) | BR-016, Q21, Q22 |
| D15 Placement rate and system alerts | **Approved** | — |
| D16 Placement eligibility vocabulary | Open (not approved) | — |
| D17 Placement guarantee and packages | Open (not approved) | Q7 |
| D18 Notification channels and categories | Open (not approved) | Q18, BR-014 |

### D1 — Pass-mark and attendance-minimum precedence (approved)

1. The BR-011 thresholds are **minimum floors**: 75% attendance and 60%
   examination score.
2. Settings or course-specific overrides may **increase** these thresholds
   but must **never lower** them.
3. A test's own pass percentage governs that test.

### D2 — Attendance percentage formula (approved)

1. Attendance percentage = Present ÷ marked sessions held for the student's
   batch × 100.
2. **Leave counts as not attended.**
3. Only the approved BR-010 vocabulary is used: Present, Absent and Leave.

### D4 — Course prerequisite enforcement (approved)

1. Self-enrollment requires a **completed** enrollment in every prerequisite
   course.
2. An Admin may override this restriction only with a **mandatory reason**.
3. The override is **audited**.

### D6 — Batch capacity (approved)

1. The existing batch capacity is a **hard self-enrollment limit**.
2. A full batch returns a conflict response.
3. An Admin override requires an **audited reason**.
4. No waitlist.
5. No capacity values are invented and existing batch records are not
   modified.

### D7 — Lockout policy (approved)

1. A lockout remains until a **password reset or Admin unlock** (no timed
   unlock). This confirms option A of Q4a.
2. The Super Admin can configure the **failed-attempt threshold between 3 and
   10**.
3. Changes to this setting are **audited**.

### D11 — Two-factor authentication (approved)

1. **Mandatory email OTP** as the second sign-in factor for **Admin and Super
   Admin**.
2. The existing OTP service is reused where possible.
3. No TOTP or encryption-key infrastructure is introduced in this batch.

### D15 — Placement rate and system alerts (approved)

1. Placement rate = distinct students with a placement record ÷ students with
   a completed enrollment, for the selected period.
2. System alerts represent open action queues, including pending approvals,
   refunds and overrides.
3. Public placement figures require **Admin review before publication**.

### D9 — Academic and course settings (approved, revised)

The owner chose "modify"; the revised proposal below was then approved:

- **Academic settings:** minimum attendance threshold 75% and minimum
  examination threshold 60%; configurable, but may be increased and never
  reduced below these floors (consistent with D1).
- **Course settings:** default sequential lesson unlocking and default
  download permission for newly created lessons.
- **Test attempts:** excluded from D9; deferred until D3 is approved.

Course defaults apply only when a lesson is created; existing lessons are never changed when a default changes.
