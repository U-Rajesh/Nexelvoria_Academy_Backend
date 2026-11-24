/*
  PROPOSAL ONLY - NOT EXECUTED, NOT YET APPROVED.
  Column names and types are suggestions for DBA review; adjust to the
  team's conventions before anything is run. Each block is independent.

  ---------------------------------------------------------------------------
  A. NXA_Courses presentation / SEO fields (ADM-005, public course details)
  ---------------------------------------------------------------------------
  Today the API rejects these fields with 422 UNSUPPORTED_FIELDS rather than
  silently dropping them (see UNPERSISTED_COURSE_FIELDS in course.types.ts).
*/
SET XACT_ABORT ON;
BEGIN TRANSACTION;

IF COL_LENGTH(N'dbo.NXA_Courses', N'Category') IS NULL
    ALTER TABLE dbo.NXA_Courses ADD Category NVARCHAR(100) NULL;
IF COL_LENGTH(N'dbo.NXA_Courses', N'ThumbnailUrl') IS NULL
    ALTER TABLE dbo.NXA_Courses ADD ThumbnailUrl NVARCHAR(500) NULL;
IF COL_LENGTH(N'dbo.NXA_Courses', N'TotalHours') IS NULL
    ALTER TABLE dbo.NXA_Courses ADD TotalHours INT NULL;
IF COL_LENGTH(N'dbo.NXA_Courses', N'TechnologiesJson') IS NULL
    ALTER TABLE dbo.NXA_Courses ADD TechnologiesJson NVARCHAR(MAX) NULL;      -- JSON array of strings
IF COL_LENGTH(N'dbo.NXA_Courses', N'PrerequisitesJson') IS NULL
    ALTER TABLE dbo.NXA_Courses ADD PrerequisitesJson NVARCHAR(MAX) NULL;     -- JSON array of strings
IF COL_LENGTH(N'dbo.NXA_Courses', N'LearningOutcomesJson') IS NULL
    ALTER TABLE dbo.NXA_Courses ADD LearningOutcomesJson NVARCHAR(MAX) NULL;  -- JSON array of strings
IF COL_LENGTH(N'dbo.NXA_Courses', N'EligibilityCriteria') IS NULL
    ALTER TABLE dbo.NXA_Courses ADD EligibilityCriteria NVARCHAR(1000) NULL;
IF COL_LENGTH(N'dbo.NXA_Courses', N'HasPlacementGuarantee') IS NULL
    ALTER TABLE dbo.NXA_Courses ADD HasPlacementGuarantee BIT NOT NULL
        CONSTRAINT DF_NXA_Courses_HasPlacementGuarantee DEFAULT (0);
IF COL_LENGTH(N'dbo.NXA_Courses', N'DiscountedPrice') IS NULL
    ALTER TABLE dbo.NXA_Courses ADD DiscountedPrice DECIMAL(12, 2) NULL;
IF COL_LENGTH(N'dbo.NXA_Courses', N'SyllabusPdfUrl') IS NULL
    ALTER TABLE dbo.NXA_Courses ADD SyllabusPdfUrl NVARCHAR(500) NULL;
IF COL_LENGTH(N'dbo.NXA_Courses', N'SeoTitle') IS NULL
    ALTER TABLE dbo.NXA_Courses ADD SeoTitle NVARCHAR(200) NULL;
IF COL_LENGTH(N'dbo.NXA_Courses', N'SeoDescription') IS NULL
    ALTER TABLE dbo.NXA_Courses ADD SeoDescription NVARCHAR(500) NULL;

COMMIT TRANSACTION;

/*
  ---------------------------------------------------------------------------
  B. NXA_EnrollmentOverrides decision columns (BR-007, Super Admin sign-off)
  ---------------------------------------------------------------------------
  BLOCKED on the verified table definition: the code relies only on
  EnrollmentOverrideId, EnrollmentId, OverrideType, Reason, ApprovedByUserId
  and CreatedAt. Until a decision column exists, override REJECTION returns
  422 OVERRIDE_REJECTION_UNSUPPORTED and the requesting admin is not shown.

  Suggested shape (to be confirmed against the real definition first):

    ALTER TABLE dbo.NXA_EnrollmentOverrides ADD
        RequestedByUserId BIGINT        NULL,   -- FK -> NXA_Users(UserId)
        DecisionStatus    VARCHAR(20)   NOT NULL
            CONSTRAINT DF_NXA_EnrollmentOverrides_DecisionStatus DEFAULT ('PENDING'),
        DecidedAt         DATETIME2(3)  NULL,
        DecisionRemarks   NVARCHAR(500) NULL;

    ALTER TABLE dbo.NXA_EnrollmentOverrides ADD CONSTRAINT
        CK_NXA_EnrollmentOverrides_DecisionStatus
        CHECK (DecisionStatus IN ('PENDING', 'APPROVED', 'REJECTED'));

    -- Backfill existing approvals (data change - needs separate approval):
    -- UPDATE dbo.NXA_EnrollmentOverrides
    --    SET DecisionStatus = 'APPROVED'
    --  WHERE ApprovedByUserId IS NOT NULL;

  ---------------------------------------------------------------------------
  C. NXA_Refunds decision remarks (optional)
  ---------------------------------------------------------------------------
  Remarks are currently kept in NXA_AuditLogs.NewValues only. If they should
  be on the refund record itself:

    ALTER TABLE dbo.NXA_Refunds ADD DecisionRemarks NVARCHAR(500) NULL,
                                    DecidedByUserId BIGINT NULL,
                                    DecidedAt DATETIME2(3) NULL;
*/
