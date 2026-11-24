/*
  PROPOSED MIGRATION - NOT EXECUTED.
  Requires explicit approval and DBA review before running against
  NexelvoriaAcademyDB. Nothing in the application runs this file.

  Purpose
    ADM-007 / batch management: store the live-class meeting link per batch.
    NXA_Batches has no MeetingUrl column today (scripts/batch2-live-metadata.json),
    so the Admin batch screens currently show a notice instead of the field.

  Change
    Adds one NULLable column. No existing row or constraint is modified, and
    existing INSERT/UPDATE statements keep working because the column is
    nullable with no default.

  Idempotent: re-running is a no-op once the column exists.
*/
SET XACT_ABORT ON;
BEGIN TRANSACTION;

IF COL_LENGTH(N'dbo.NXA_Batches', N'MeetingUrl') IS NULL
BEGIN
    ALTER TABLE dbo.NXA_Batches
        ADD MeetingUrl NVARCHAR(500) NULL;
END;

COMMIT TRANSACTION;

/*
  Verification (read-only):
    SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'NXA_Batches' AND COLUMN_NAME = 'MeetingUrl';

  Rollback (only if no data has been written to the column yet):
    ALTER TABLE dbo.NXA_Batches DROP COLUMN MeetingUrl;

  Application follow-up after approval and execution:
    - sqlserver-admin.repository.ts: add b.MeetingUrl to batchSelect/mapBatchRow,
      and persist it in createBatch/updateBatch.
    - admin.validation.ts: optional https URL (max 500) on create/update batch.
    - Frontend AdminBatchListPage / AdminBatchDetailPage: restore the field in
      place of the current notice.
*/
