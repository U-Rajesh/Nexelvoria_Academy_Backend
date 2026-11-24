# Admin and Super Admin CRD completion tracker

Scope: the 153 applicable Admin / Super Admin requirements from the read-only recount (2026-11-24), one row per requirement, duplicates merged as in that recount. Student-only and teacher-only requirements are excluded; N/A (not counted): PAY-014, COM-005, CFG domain, CFG SMS, CFG language, encrypted communications, BR-014.

FULL means backend, frontend, validation, authorization, required audit and tests are implemented and verified. **All verification uses mocked SQL and in-memory fakes; nothing is verified against the live database.**

Group: **A** ready, **B** partially ready, **C** waiting for a business decision, **D** external / DBA blocked. FULL rows have no group.

Last updated: Batch 3 Item 11A (approved Group C decisions D1, D2, D4, D6, D7, D9, D15; D11 held at its DBA gate).

## Totals

| Status | Count |
|---|---:|
| FULL | 94 |
| PARTIAL | 29 |
| NOT IMPLEMENTED | 9 |
| BLOCKED | 21 |
| **Total** | **153** |

FULL = 94 / 153 = **61.4%**.

**Grouping note (Item 10B):** the Item 10A report labelled two PARTIAL groups "Super Admin and Admin (11)" and "Website content and security (6)"; the rows themselves were right: 9 Super Admin / Admin rows (SA-03, ADM-001, 009, 010, 011, 012, 013, 014, 015) and 8 website / security rows (PUB-005, 006, 007, 012, 014, 019, 023 and SEC audit-log coverage). The PARTIAL total (36 at that point) and the 153 were unaffected.

**Count correction made at Item 10:** the per-item tallies of Items 8 and 9 mapped several IDs to the wrong starting status (REP-006 and REP-007 were already BLOCKED and ADM-015 already PARTIAL; SA-04 reached FULL in Item 8 but was not counted; the CFG institute profile was already FULL; the CFG time-zone item went from FULL to BLOCKED; domain, SMS and language are N/A; PUB-019 went from NOT IMPLEMENTED to PARTIAL in Item 7). Rebuilt row by row, the true baseline before Item 10 was 73 / 42 / 16 / 22, not 74 / 35 / 16 / 28.

## Super Admin

| ID | Status | Group | Evidence / remaining work |
|---|---|---|---|
| SA-01 Full system access | FULL | | Admin guards admit `admin` and `super_admin` |
| SA-02 Manage Admin accounts | FULL | | `/super-admin/admins` CRUD, status, reset password; live screen |
| SA-03 System configuration | PARTIAL | D | Read-only environment config, SMTP test, maintenance mode, integration status (Item 9). Editing platform config needs encrypted secret storage (key management) |
| SA-04 Access all reports | FULL | | Item 8: every report, financial summary, CSV/XLSX/PDF exports, audited (`tests/reports-and-exports.test.ts`) |
| SA-05 Roles and permissions (BR-018) | BLOCKED | C | Permission catalog and model undecided |
| SA-06 Review audit logs | FULL | | `/super-admin/audit-logs`; live |

## Admin (ADM)

| ID | Status | Group | Evidence / remaining work |
|---|---|---|---|
| ADM-001 Dashboard | FULL | | Item 11A (D15): cohort placement rate (students with an enrollment COMPLETED in the period ÷ those of them with a placement record; distinct students; EmploymentStatus not used) for the financial year on the dashboard and for any chosen period (`GET /admin/dashboard/placement-rate`); system alerts = pending approvals + pending refunds + pending overrides, with a breakdown (`tests/placement-rate-11a.test.ts`). Live KPIs and charts from Item 8 |
| ADM-002 Search students | FULL | | |
| ADM-003 Create students | FULL | | |
| ADM-004 Approve / reject / suspend | FULL | | Status changes audited (Item 6) |
| ADM-005 Enroll students | FULL | | |
| ADM-006 Courses | FULL | | Item 10A: the course read no longer invents thumbnail, category or total hours (`tests/gap-closure-10a.test.ts`); course writes audited. Note: a NULL DurationValue / CourseLevel on a row created outside the app still reads as 12 weeks / Beginner; the Admin API always writes both |
| ADM-007 Batches | FULL | | |
| ADM-008 Allocate teachers | FULL | | |
| ADM-009 Payments | PARTIAL | D | Manual verify / reject needs the allowed `VerificationStatus` values; online checkout not integrated (Q12) |
| ADM-010 Discounts and scholarships | PARTIAL | D | Scholarship awards need `ApprovalStatus` values |
| ADM-011 Attendance and assessments | PARTIAL | C | Depends on ATT-007, ATT-010, ASM-011, ASM-012 |
| ADM-012 Placements | PARTIAL | D | Depends on PLC-006/007/008 status values and PLC-003/015 eligibility |
| ADM-013 Notifications | PARTIAL | C/D | In-app send, broadcast and full history done; templates (COM-001), delivery tracking (COM-006) and email delivery pending |
| ADM-014 Website content | PARTIAL | D | CMS backend-first and audited (Item 7); media library needs file storage |
| ADM-015 Reports per permissions | PARTIAL | C | Live, role-limited reports (Item 8); permission-level access waits on BR-018 |
| ADM-016 Activity logs | FULL | | |
| Teacher management | FULL | | Item 6 |

## Sign-in and accounts (AUTH)

| ID | Status | Group | Evidence / remaining work |
|---|---|---|---|
| AUTH-004 Admin approval | FULL | | |
| AUTH-005 Login | FULL | | |
| AUTH-006 Forgot password | FULL | | Item 6 (SMTP live delivery unverified) |
| AUTH-007 Change password | FULL | | Item 6 |
| AUTH-008 Login history | FULL | | Item 6 |
| AUTH-009 Active sessions | FULL | | Item 6 |
| AUTH-010 End a session remotely | FULL | | Item 6 |
| AUTH-011 Suspension | FULL | | |
| AUTH-012 Lockout | FULL | | Lockout policy (Q4a) affects CFG user settings, not this item |
| AUTH-013 Two-factor sign-in | BLOCKED | D | Policy approved (D11: mandatory email OTP for Admin and Super Admin). Held at its dependency gate, not implemented: the DBA must confirm `NXA_OtpRecords.OtpPurpose` accepts `staff_sign_in` (no restrictive CHECK); live SMTP must be verified before it can be production-ready |
| AUTH-014 Auth activity recorded | FULL | | Item 6 |

## Courses (CRS)

| ID | Status | Group | Evidence / remaining work |
|---|---|---|---|
| CRS-006 Enrollment records | FULL | | |
| CRS-007 Schedules | FULL | | |
| CRS-008 Syllabus | PARTIAL | D | Syllabus PDF needs file storage |
| CRS-011 Batch student lists | FULL | | |
| CRS-012 Status management | FULL | | |

## Learning content (LMS)

| ID | Status | Group | Evidence / remaining work |
|---|---|---|---|
| LMS-001 Manage content | PARTIAL | D | Materials blocked (MaterialType values, storage) |
| LMS-002 Videos | PARTIAL | D | Uploads need file storage; links work |
| LMS-004 Sequential unlocking | FULL | | Item 10B: Admin sets "unlock in sequence" per lesson (`NXA_Lessons.IsSequentialUnlock`, syllabus editor); the server refuses a lesson (403 LESSON_LOCKED) until the previous lesson in course order is completed (`NXA_LessonProgress.IsCompleted`) on open, progress, materials and doubts; student viewer shows the server's state (`tests/lesson-availability.test.ts`) |
| LMS-005 Publication dates | FULL | | Item 10B: Admin sets "available from" (`NXA_Lessons.PublishAt`, an absolute instant, no time-zone rule); before it the server refuses the lesson (403 LESSON_NOT_YET_AVAILABLE) and the public outline hides its preview; only PUBLISHED lessons are part of the course (`tests/lesson-availability.test.ts`) |
| LMS-006 Download permissions | FULL | | |
| PDF / study materials / links | BLOCKED | D | `MaterialType` values unconfirmed; storage |
| Prerequisites | FULL | | Item 11A (D4): self-enrollment refused (422 PREREQUISITES_NOT_MET, missing courses listed) unless every prerequisite has a COMPLETED enrollment; Admin enrollment requires a `prerequisiteOverrideReason`, recorded in the enrollment's audit row in the same transaction; Admin enrollment form asks for it (`tests/enrollment-gates-11a.test.ts`). Prerequisites listed publicly since Item 10B |
| Content versioning | PARTIAL | C | Current version only; versioning rules undecided |

## Payments (PAY)

| ID | Status | Group | Evidence / remaining work |
|---|---|---|---|
| PAY-006 Transaction history | FULL | | |
| PAY-008 Manual payment | FULL | | |
| PAY-009 Discounts, coupons, scholarships | PARTIAL | D | Checkout coupon redemption (`RedemptionStatus` values); scholarship awards (`ApprovalStatus`) |
| PAY-010 Free-access overrides | FULL | | |
| PAY-011 Refunds | PARTIAL | C/D | Refund requests need the eligibility rule (Q6); gateway refund needs Razorpay |
| PAY-012 Super Admin approves refunds | FULL | | |
| PAY-013 Financial audit history | FULL | | |

## Attendance (ATT)

| ID | Status | Group | Evidence / remaining work |
|---|---|---|---|
| ATT-001 Admin schedules classes | FULL | | |
| ATT-002 Admin marks attendance | FULL | | |
| ATT-005 Admin corrects attendance | FULL | | |
| ATT-007 Configurable minimum attendance | FULL | | Item 11A (D1, D2): Super Admin setting 75-100 (BR-011 floor; a stored lower value never applies), audited; students below it are flagged in the Admin attendance summary and the Attendance Summary report; compared unrounded (`tests/academic-settings-11a.test.ts`). Certificate eligibility (CER) still blocked separately |
| ATT-009 Changes audited | FULL | | |
| ATT-010 Attendance reports | FULL | | Item 11A (D2): one shared formula (Present ÷ marked sessions × 100; Leave not attended; unmarked sessions not counted; null when nothing is marked; one decimal shown) in the Admin attendance summary (new per-student panel) and a new Attendance Summary report with CSV / Excel / PDF exports (period filters the sessions aggregated) (`tests/academic-settings-11a.test.ts`) |

## Assessments (ASM)

| ID | Status | Group | Evidence / remaining work |
|---|---|---|---|
| ASM-005 Admin evaluates work | FULL | | |
| ASM-011 Admin overrides retakes | PARTIAL | C/D | Override recorded (`NXA_RetakeAuthorizations`). It cannot be consumed: there is no server-side test-attempt flow at all (the student test engine runs on browser data); building one needs the scoring decision (Q19) and the `AttemptStatus` values (DBA) |
| ASM-012 Submission and evaluation history | FULL | | Item 10B: every evaluation (Admin and teacher) is a new version under lock, audited, marks range-checked, teacher allocation enforced; `GET /admin/academics/assignment-submissions/:id/evaluations` + history in the Admin assignment view (`tests/gap-closure-10b.test.ts`) |

## Certificates (CER)

| ID | Status | Group | Evidence / remaining work |
|---|---|---|---|
| CER-001 | BLOCKED | C/D | Pass marks (Q8), template row, `CertificateTemplateId` |
| CER-002 | BLOCKED | C/D | Same |
| CER-003 | BLOCKED | C/D | Same |
| CER-005 | BLOCKED | C/D | Same |
| CER-010 | BLOCKED | C/D | Same |
| CER-004 Multiple templates | NOT IMPLEMENTED | D | Templates need file storage (`TemplateObjectKey`) |
| CER-006 QR verification | NOT IMPLEMENTED | D | No certificate can be issued until CER-001 is unblocked; public verification itself is done (minimal payload, Item 10A) |
| CER-008 Revocation | FULL | | |
| CER-009 Reissue and revocation history | PARTIAL | D | Reissue needs issuing (blocked) |

## Placements (PLC)

| ID | Status | Group | Evidence / remaining work |
|---|---|---|---|
| PLC-001 | FULL | | Item 5 |
| PLC-002 | FULL | | Item 5; public listing limited to open jobs (Item 10A) |
| PLC-005 | FULL | | Item 5 |
| PLC-009 | FULL | | Item 5 |
| PLC-010 | FULL | | Item 5 |
| PLC-011 | FULL | | Item 5 |
| PLC-012 | FULL | | Item 5 |
| PLC-013 | FULL | | Item 5 |
| PLC-006 Interview rounds | PARTIAL | D | `RoundStatus` values |
| PLC-007 Offer letters | PARTIAL | D | Offer letter file (storage); `OfferStatus` values |
| PLC-008 Placement records | PARTIAL | D | `EmploymentStatus` values |
| PLC-003 Eligibility | BLOCKED | C | Criterion types / operators not approved |
| PLC-015 Eligibility | BLOCKED | C | Same |
| Placement packages | BLOCKED | C/D | `PackageType` codes and guarantee terms (Q7) |

## Notifications (COM)

| ID | Status | Group | Evidence / remaining work |
|---|---|---|---|
| COM-002 In-app notifications | FULL | | |
| COM-007 Broadcasts | FULL | | |
| COM-003 Email | PARTIAL | D | OTP / reset email only; SMTP not verified live |
| COM-008 Notification history | FULL | | Item 10A: `GET /support/admin/notifications` (all recipients, filters, paging) + Admin panel (`tests/gap-closure-10a.test.ts`) |
| COM-001 Templates | NOT IMPLEMENTED | C | `NXA_NotificationTemplates.Channel` vocabulary undecided (Q18); no sender uses templates |
| COM-006 Delivery status | NOT IMPLEMENTED | C/D | Channels (Q18) and real delivery providers |
| COM-010 Student-to-Admin messaging | FULL | | Item 10B: `/support/messages/*` on `NXA_Messages`; student <-> active Admin / Super Admin only; own conversations only; read state; staff sends audited without message text; Admin, Super Admin and student Messages pages (`tests/gap-closure-10b.test.ts`). Text only: attachments need file storage |
| COM-004 WhatsApp | BLOCKED | D | Provider not chosen |

## Support (SUP)

| ID | Status | Group | Evidence / remaining work |
|---|---|---|---|
| SUP-003 Manage tickets | FULL | | |
| SUP-004 Respond | FULL | | |
| SUP-005 Ticket history | FULL | | Item 10A: `GET /support/admin/tickets/:id/history` + history in the ticket view |
| SUP-006 Categories and statuses | FULL | | Item 10A: category create / rename / activate / deactivate, audited, no-op aware, duplicate names refused |

## Reports (REP)

| ID | Status | Group | Evidence / remaining work |
|---|---|---|---|
| REP-001 Dashboard charts | FULL | | Item 8 |
| REP-002 Custom reports | FULL | | Item 8 |
| REP-003 Excel export | FULL | | Item 8 |
| REP-004 CSV export | FULL | | Item 8 |
| REP-005 PDF export | FULL | | Item 8 |
| REP-006 Scheduled email reports | BLOCKED | D | Hidden CHECKs on `NXA_ScheduledReports`, scheduler, SMTP |
| REP-007 Permission-based reports | BLOCKED | C | BR-018 |
| REP-008 Financial reports | FULL | | Item 8 |

## Institute settings (CFG, as grouped in the recount)

| Setting | Status | Group | Evidence / remaining work |
|---|---|---|---|
| Institute profile | FULL | | Validated, audited, institute name on exports (Item 9) |
| Time zone | BLOCKED | C | Fixed to IST; configurability waits on Q15 (writes refused) |
| Payment settings | PARTIAL | D | Gateway status shown honestly; checkout integration (Q12) |
| Tax settings | PARTIAL | C | GSTIN validated; GST rate / calculation rules undecided |
| Email settings | PARTIAL | D | Environment SMTP + real test email; provider unconfirmed; in-app editing needs encrypted secrets |
| Branding | NOT IMPLEMENTED | D | Logo needs file storage (text branding lives in the CMS) |
| Academic settings | FULL | | Item 11A (D9): minimum attendance (75-100, applied, see ATT-007) and minimum examination score (60-100, BR-011 floor; saved and validated, labelled "saved, not yet applied" because its consumers - server-side test scoring and certificate eligibility - are tracked under ASM-011 / CER and still blocked); Super Admin only, audited (`tests/academic-settings-11a.test.ts`) |
| Course settings | FULL | | Item 11A (D9): Admin defaults for new lessons (unlock in sequence, downloads allowed), audited; applied only to lessons created after the change and only to fields the editor leaves unset (server) and as the starting value of a new lesson (syllabus editor); existing lessons never change (`tests/academic-settings-11a.test.ts`) |
| Batch settings | FULL | | Item 11A (D6): `NXA_Batches.Capacity` (per batch, already editable) is a hard self-enrollment limit (409 BATCH_FULL), checked under a batch-row lock in the insert transaction so concurrent requests cannot exceed it; NULL = no limit; counted as the batch's CurrentEnrollments (all but cancelled); Admin override needs a `capacityOverrideReason`, audited with the enrollment. No global default and no waitlist (not approved) (`tests/enrollment-gates-11a.test.ts`) |
| Notification settings | NOT IMPLEMENTED | C | Q18 channels |
| User settings | FULL | | Item 11A (D7): Super Admin sets failed sign-ins before lockout (3-10; 5 until saved), audited; lock decided when a failure is recorded (stored `IsLocked`), so lowering or raising the threshold never locks or unlocks anyone retroactively; lock lasts until password reset or Admin unlock; System Config shows the value in force (`tests/lockout-threshold-11a.test.ts`) |
| Examination settings | NOT IMPLEMENTED | C | The 60% examination floor is an Academic setting (Item 11A, D9). Test-attempt settings are deferred until D3 (Q19 scoring, attempts, retakes) is approved |
| Placement settings | BLOCKED | C | Eligibility vocabulary |
| Maintenance mode | FULL | | Enforced 503 guard, Super Admin only, audited (Item 9) |
| Integrations | PARTIAL | D | Status only; configuring needs encryption-key management |
| Backups | BLOCKED | D | No backup infrastructure / scheduler; `BackupStatus` CHECK hidden |
| Data import | BLOCKED | D | Uploads need file storage |
| Certificate settings | BLOCKED | C/D | Templates and pass marks |
| WhatsApp settings | BLOCKED | D | Provider |

## Website content (PUB)

| ID | Status | Group | Evidence / remaining work |
|---|---|---|---|
| PUB-005 Placement info | FULL | | Item 11A (D15): the CMS home statistics editor shows the computed placement figures (rate, placed / completed, financial year) for Admin review; a figure reaches the public site only when the Admin applies it and saves the page through the existing audited CMS save |
| PUB-006 Trainer profiles | FULL | | Item 10B: trainer profiles link to real courses (`courseIds`, verified on save); titles derived from the courses; public profiles show published linked courses only; Admin course picker (`tests/gap-closure-10b.test.ts`) |
| PUB-007 College partnerships | PARTIAL | D | Description / logo / MoU columns missing |
| PUB-008 Corporate training | FULL | | Item 7 |
| PUB-009 Testimonials | FULL | | Item 7 |
| PUB-010 Achievements | FULL | | Item 7 |
| PUB-012 FAQs | PARTIAL | D | No FAQ category column |
| PUB-013 Blog | FULL | | Item 7 |
| PUB-014 Careers | PARTIAL | D | Resume upload needs storage |
| PUB-018 Enquiry forms | FULL | | Item 7 |
| PUB-019 Callback requests | PARTIAL | D | Stored and listed; `RequestStatus` values hidden |
| PUB-022 Banners | FULL | | Item 7 |
| PUB-023 CMS | PARTIAL | D | Media library needs file storage |

## Security (section 5.4)

| ID | Status | Group | Evidence / remaining work |
|---|---|---|---|
| JWT | FULL | | |
| Role-based access | FULL | | |
| Password hashing | FULL | | |
| API authorization | FULL | | Item 10A: public jobs limited to open ones (drafts 404, status filter ignored); public certificate verification returns only printed facts |
| Audit logs (recording) | FULL | | Every Admin / Super Admin data mutation writes its audit row in the SAME SQL Server transaction as the change: an audit failure rolls the change back and fails the request, a business failure writes no audit, a no-op writes neither, refused callers change nothing. Item 10C: Admin accounts, batches, teacher allocation, account unlock, teacher create (`tests/admin-audit-transactions.test.ts`). Item 10D: course create / update / status / publish / unpublish, curriculum (modules, chapters, lessons incl. sequential unlock and publish dates), prerequisites; student approve / reject / status (`tests/course-student-audit-transactions.test.ts`). Other modules were already transactional (Items 6-10B). Outside this requirement and unchanged: self-service account security events (own password change / reset, ending own sessions; `account.service.ts`) and the SMTP test-email record (an external send with no data change). Verified with mock pools and in-memory fakes only |
| Data export and deletion | NOT IMPLEMENTED | C | Retention / deletion policy (BR-016) |
| Secure file storage | BLOCKED | D | No S3 |

## Business rules (BR)

| ID | Status | Group | Evidence / remaining work |
|---|---|---|---|
| BR-002 | FULL | | |
| BR-004 | FULL | | |
| BR-005 | FULL | | |
| BR-007 | FULL | | |
| BR-015 | FULL | | |
| BR-017 | FULL | | |
| BR-010 Present / Absent / Leave | FULL | | Item 10A: the teacher portal accepts only present / absent / leave (it previously rejected the `leave` its own UI sends and read stored LEAVE back as present) |
| BR-016 Data retention | NOT IMPLEMENTED | C | Policy undecided |

## Group A / B work remaining (next batches)

1. No Group A / B item remains open. AUTH-013 (D11 approved) waits on the DBA confirmation of `NXA_OtpRecords.OtpPurpose = 'staff_sign_in'` and on verified SMTP. Everything else open needs a decision, DBA values or an external service (see Groups C / D above).
