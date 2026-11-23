import { getSqlServerPool } from "../src/db/sqlserver.pool";

async function main() {
  console.log("=== SQL SERVER LIVE READ-ONLY SCHEMA AUDIT ===");
  const pool = await getSqlServerPool();

  try {
    // 1. All deployed tables matching NXA_%
    const tablesRes = await pool.request().query<{ TABLE_NAME: string }>(`
      SELECT TABLE_NAME
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME LIKE 'NXA_%'
      ORDER BY TABLE_NAME
    `);
    const deployedTables = tablesRes.recordset.map((r) => r.TABLE_NAME);
    console.log(`\n[1] Deployed Tables (${deployedTables.length} found):`);
    for (const t of deployedTables) {
      console.log(`  - dbo.${t}`);
    }

    // 2. All deployed stored procedures matching usp_NXA_% or %NXA%
    const spRes = await pool.request().query<{ ROUTINE_NAME: string }>(`
      SELECT ROUTINE_NAME
      FROM INFORMATION_SCHEMA.ROUTINES
      WHERE ROUTINE_SCHEMA = 'dbo' AND ROUTINE_TYPE = 'PROCEDURE'
      ORDER BY ROUTINE_NAME
    `);
    const deployedSPs = spRes.recordset.map((r) => r.ROUTINE_NAME);
    console.log(`\n[2] Deployed Stored Procedures (${deployedSPs.length} found):`);
    for (const sp of deployedSPs) {
      console.log(`  - dbo.${sp}`);
    }

    // 3. User roles check in database (read-only)
    try {
      const rolesRes = await pool.request().query<{ RoleName: string }>(`
        SELECT RoleName FROM dbo.NXA_Roles ORDER BY RoleName
      `);
      console.log(`\n[3] Deployed Roles in dbo.NXA_Roles (${rolesRes.recordset.length} found):`);
      for (const r of rolesRes.recordset) {
        console.log(`  - ${r.RoleName}`);
      }
    } catch (e: any) {
      console.log(`\n[3] Role inspection notice: ${e.message}`);
    }

    // 4. Session / Auth columns check
    const sessionCols = await pool.request().query<{ COLUMN_NAME: string; DATA_TYPE: string }>(`
      SELECT COLUMN_NAME, DATA_TYPE
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'NXA_UserSessions'
      ORDER BY ORDINAL_POSITION
    `);
    console.log(`\n[4] Columns in dbo.NXA_UserSessions (${sessionCols.recordset.length} found):`);
    for (const c of sessionCols.recordset) {
      console.log(`  - ${c.COLUMN_NAME} (${c.DATA_TYPE})`);
    }

  } catch (err) {
    console.error("SQL Audit Error:", err);
  } finally {
    await pool.close();
    console.log("\n=== AUDIT COMPLETED ===");
  }
}

void main();
