/*
  READ-ONLY metadata query for dbo.NXA_EnrollmentOverrides (and dbo.NXA_Refunds,
  whose decision columns the Super Admin workflows also depend on).
  SELECT statements and catalog views only; nothing is created or changed.

  Purpose: confirm the real definition BEFORE any override-rejection
  migration is drafted (docs/proposed-migrations/002 block B is a suggestion
  only and must be revised against this output).
*/
SET NOCOUNT ON;

/* 1. Columns. */
SELECT
  OBJECT_NAME(c.object_id) AS table_name,
  c.column_id,
  c.name AS column_name,
  ty.name AS data_type,
  CASE WHEN ty.name IN ('nvarchar', 'nchar') AND c.max_length > 0 THEN c.max_length / 2 ELSE c.max_length END AS max_length,
  c.precision,
  c.scale,
  c.is_nullable,
  c.is_identity,
  dc.definition AS default_definition
FROM sys.columns c
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
WHERE c.object_id IN (OBJECT_ID('dbo.NXA_EnrollmentOverrides'), OBJECT_ID('dbo.NXA_Refunds'))
ORDER BY table_name, c.column_id;

/* 2. Primary key, unique constraints and indexes. */
SELECT OBJECT_NAME(i.object_id) AS table_name, i.name AS index_name, i.type_desc,
       i.is_primary_key, i.is_unique,
       STRING_AGG(c.name, ', ') WITHIN GROUP (ORDER BY ic.key_ordinal) AS key_columns,
       i.filter_definition
FROM sys.indexes i
JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE i.object_id IN (OBJECT_ID('dbo.NXA_EnrollmentOverrides'), OBJECT_ID('dbo.NXA_Refunds'))
GROUP BY i.object_id, i.name, i.type_desc, i.is_primary_key, i.is_unique, i.filter_definition
ORDER BY table_name, index_name;

/* 3. Foreign keys from and to both tables. */
SELECT fk.name AS fk_name,
       OBJECT_NAME(fk.parent_object_id) AS from_table, pc.name AS from_column,
       OBJECT_NAME(fk.referenced_object_id) AS to_table, rc.name AS to_column,
       fk.delete_referential_action_desc AS on_delete
FROM sys.foreign_keys fk
JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
WHERE fk.parent_object_id IN (OBJECT_ID('dbo.NXA_EnrollmentOverrides'), OBJECT_ID('dbo.NXA_Refunds'))
   OR fk.referenced_object_id IN (OBJECT_ID('dbo.NXA_EnrollmentOverrides'), OBJECT_ID('dbo.NXA_Refunds'))
ORDER BY from_table, fk_name;

/* 4. CHECK constraints (allowed OverrideType / RefundStatus values). */
SELECT OBJECT_NAME(cc.parent_object_id) AS table_name, cc.name, cc.definition
FROM sys.check_constraints cc
WHERE cc.parent_object_id IN (OBJECT_ID('dbo.NXA_EnrollmentOverrides'), OBJECT_ID('dbo.NXA_Refunds'))
ORDER BY table_name, cc.name;

/* 5. Value distributions (counts only, no personal data). */
SELECT 'NXA_EnrollmentOverrides' AS table_name, OverrideType AS value,
       CASE WHEN ApprovedByUserId IS NULL THEN 'undecided' ELSE 'approved' END AS decision,
       COUNT(*) AS row_count
FROM dbo.NXA_EnrollmentOverrides
GROUP BY OverrideType, CASE WHEN ApprovedByUserId IS NULL THEN 'undecided' ELSE 'approved' END;

SELECT 'NXA_Refunds' AS table_name, RefundStatus AS value, COUNT(*) AS row_count
FROM dbo.NXA_Refunds
GROUP BY RefundStatus;

/* 6. Code that writes these tables (procedures, triggers, views). */
SELECT o.type_desc, o.name
FROM sys.objects o
JOIN sys.sql_modules m ON m.object_id = o.object_id
WHERE m.definition LIKE '%NXA_EnrollmentOverrides%' OR m.definition LIKE '%NXA_Refunds%'
ORDER BY o.type_desc, o.name;
