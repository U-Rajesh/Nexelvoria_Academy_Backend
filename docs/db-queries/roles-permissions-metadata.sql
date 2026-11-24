/*
  READ-ONLY metadata query: roles, role-permission mappings and permission catalog.
  Target: NexelvoriaAcademyDB (SQL Server). Contains only SELECT statements and
  catalog views; it creates, alters and writes nothing. Run it as a login with
  VIEW DEFINITION and SELECT on dbo.

  Output: 9 result sets, numbered below. Please return all of them (CSV or
  grid export) - see "What to send back" at the end.
*/
SET NOCOUNT ON;

/* Candidate tables: anything named like a role, permission, privilege, right
   or access table, plus the user-role link. Matching is by name so that
   tables we do not yet know about are still found. */
IF OBJECT_ID('tempdb..#rbac_tables') IS NOT NULL DROP TABLE #rbac_tables;

SELECT t.object_id, s.name AS schema_name, t.name AS table_name
INTO #rbac_tables
FROM sys.tables t
JOIN sys.schemas s ON s.schema_id = t.schema_id
WHERE t.is_ms_shipped = 0
  AND (
        t.name LIKE '%Role%'
     OR t.name LIKE '%Permission%'
     OR t.name LIKE '%Privilege%'
     OR t.name LIKE '%Right%'
     OR t.name LIKE '%Access%'
     OR t.name LIKE '%Capabilit%'
     OR t.name LIKE '%Scope%'
  );

/* 1. Candidate tables with row counts. */
SELECT r.schema_name, r.table_name, SUM(p.rows) AS row_count
FROM #rbac_tables r
JOIN sys.partitions p ON p.object_id = r.object_id AND p.index_id IN (0, 1)
GROUP BY r.schema_name, r.table_name
ORDER BY r.table_name;

/* 2. Columns: type, length, nullability, identity, computed, default. */
SELECT
  r.table_name,
  c.column_id,
  c.name AS column_name,
  ty.name AS data_type,
  CASE
    WHEN ty.name IN ('nvarchar', 'nchar') AND c.max_length > 0 THEN c.max_length / 2
    ELSE c.max_length
  END AS max_length,
  c.precision,
  c.scale,
  c.is_nullable,
  c.is_identity,
  c.is_computed,
  dc.definition AS default_definition
FROM #rbac_tables r
JOIN sys.columns c ON c.object_id = r.object_id
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
ORDER BY r.table_name, c.column_id;

/* 3. Primary keys and unique constraints / unique indexes. */
SELECT
  r.table_name,
  i.name AS index_name,
  CASE WHEN i.is_primary_key = 1 THEN 'PRIMARY KEY'
       WHEN i.is_unique_constraint = 1 THEN 'UNIQUE CONSTRAINT'
       ELSE 'UNIQUE INDEX' END AS kind,
  STRING_AGG(c.name, ', ') WITHIN GROUP (ORDER BY ic.key_ordinal) AS key_columns,
  i.filter_definition
FROM #rbac_tables r
JOIN sys.indexes i ON i.object_id = r.object_id AND i.is_unique = 1
JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
GROUP BY r.table_name, i.name, i.is_primary_key, i.is_unique_constraint, i.filter_definition
ORDER BY r.table_name, kind;

/* 4. Foreign keys in BOTH directions (from and to the candidate tables),
      so links to NXA_Users and from any mapping table are visible. */
SELECT
  fk.name AS fk_name,
  OBJECT_NAME(fk.parent_object_id) AS from_table,
  pc.name AS from_column,
  OBJECT_NAME(fk.referenced_object_id) AS to_table,
  rc.name AS to_column,
  fk.delete_referential_action_desc AS on_delete,
  fk.update_referential_action_desc AS on_update,
  fk.is_disabled
FROM sys.foreign_keys fk
JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
WHERE fk.parent_object_id IN (SELECT object_id FROM #rbac_tables)
   OR fk.referenced_object_id IN (SELECT object_id FROM #rbac_tables)
ORDER BY from_table, fk_name, fkc.constraint_column_id;

/* 5. CHECK constraints (allowed values for codes, statuses, scopes). */
SELECT r.table_name, cc.name AS constraint_name, COL_NAME(cc.parent_object_id, cc.parent_column_id) AS column_name,
       cc.definition, cc.is_disabled
FROM #rbac_tables r
JOIN sys.check_constraints cc ON cc.parent_object_id = r.object_id
ORDER BY r.table_name, cc.name;

/* 6. Existing role codes. */
SELECT * FROM dbo.NXA_Roles ORDER BY 1;

/* 7. Role assignment counts per role (no user identities). */
SELECT ro.RoleCode, COUNT(ur.UserId) AS assigned_users
FROM dbo.NXA_Roles ro
LEFT JOIN dbo.NXA_UserRoles ur ON ur.RoleId = ro.RoleId
GROUP BY ro.RoleCode
ORDER BY ro.RoleCode;

/* 8. Contents of every OTHER candidate table (permission catalog and
      role-permission mappings), at most 1000 rows each. NXA_Roles and
      NXA_UserRoles are excluded: 6 and 7 cover them without exposing which
      user holds which role. One result set per table, preceded by its name. */
DECLARE @schema sysname, @table sysname, @sql nvarchar(max);
DECLARE rbac_cursor CURSOR LOCAL FAST_FORWARD FOR
  SELECT schema_name, table_name FROM #rbac_tables
  WHERE table_name NOT IN ('NXA_Roles', 'NXA_UserRoles')
  ORDER BY table_name;
OPEN rbac_cursor;
FETCH NEXT FROM rbac_cursor INTO @schema, @table;
WHILE @@FETCH_STATUS = 0
BEGIN
  SELECT @table AS table_contents_follow;
  SET @sql = N'SELECT TOP (1000) * FROM ' + QUOTENAME(@schema) + N'.' + QUOTENAME(@table) + N' ORDER BY 1;';
  EXEC sys.sp_executesql @sql;
  FETCH NEXT FROM rbac_cursor INTO @schema, @table;
END;
CLOSE rbac_cursor;
DEALLOCATE rbac_cursor;

/* 9. Views, procedures and functions that mention permissions or roles -
      shows how the application is expected to resolve them. */
SELECT o.type_desc, SCHEMA_NAME(o.schema_id) AS schema_name, o.name AS object_name
FROM sys.objects o
JOIN sys.sql_modules m ON m.object_id = o.object_id
WHERE o.is_ms_shipped = 0
  AND (m.definition LIKE '%Permission%' OR m.definition LIKE '%NXA_Roles%' OR m.definition LIKE '%NXA_UserRoles%')
ORDER BY o.type_desc, o.name;

DROP TABLE #rbac_tables;

/*
  What to send back:
    - Result sets 1-7 and 9 in full.
    - Result set 8 in full (permission and mapping tables). If a table holds
      anything sensitive, send its column list and code values only.
  Plus, from the business side (not in the database):
    - Is the catalog in the database the complete approved permission list,
      or is there a separate approved document? If separate, please share it.
    - Should permissions attach to roles only, or also to individual admin
      accounts (AdminProfile.permissions exists in the frontend)?
    - Which role codes are in scope for assignment by the Super Admin
      (e.g. may a Super Admin create new role codes, or only edit mappings)?
*/
