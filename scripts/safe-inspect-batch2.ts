import sql from "mssql";
import { loadSqlServerConfig } from "../src/config/sqlserver";

interface ColumnInfo {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  DATA_TYPE: string;
  IS_NULLABLE: string;
  CHARACTER_MAXIMUM_LENGTH: number | null;
  COLUMN_DEFAULT: string | null;
}

interface RoutineInfo {
  ROUTINE_SCHEMA: string;
  ROUTINE_NAME: string;
  ROUTINE_TYPE: string;
}

interface ParameterInfo {
  SPECIFIC_NAME: string;
  PARAMETER_NAME: string;
  DATA_TYPE: string;
  PARAMETER_MODE: string;
}

async function run() {
  const config = loadSqlServerConfig();
  const pool = new sql.ConnectionPool({
    server: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    connectionTimeout: 10000,
    requestTimeout: 10000,
    options: {
      encrypt: config.encrypt,
      trustServerCertificate: config.trustServerCertificate,
      enableArithAbort: true,
    },
  });

  try {
    await pool.connect();
    console.log("Connected to SQL Server successfully.");

    // 1. Inspect relevant tables & columns
    const targetTables = [
      "NXA_StudentProfiles",
      "NXA_Courses",
      "NXA_CourseVersions",
      "NXA_CourseModules",
      "NXA_Chapters",
      "NXA_Lessons",
      "NXA_Batches",
      "NXA_Enrollments",
    ];

    const tablesList = targetTables.map((t) => `'${t}'`).join(",");

    const colResult = await pool.request().query<ColumnInfo>(`
      SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH, COLUMN_DEFAULT
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = 'dbo'
        AND TABLE_NAME IN (${tablesList})
      ORDER BY TABLE_NAME, ORDINAL_POSITION
    `);

    console.log("\n=== VERIFIED TABLES IN INFORMATION_SCHEMA ===");
    const foundTables = new Set(colResult.recordset.map((r) => r.TABLE_NAME));
    for (const t of targetTables) {
      if (foundTables.has(t)) {
        console.log(`  [EXISTS] dbo.${t}`);
      } else {
        console.log(`  [MISSING] dbo.${t}`);
      }
    }

    // 2. Check Stored Procedures
    const spResult = await pool.request().query<RoutineInfo>(`
      SELECT ROUTINE_SCHEMA, ROUTINE_NAME, ROUTINE_TYPE
      FROM INFORMATION_SCHEMA.ROUTINES
      WHERE ROUTINE_SCHEMA = 'dbo'
      ORDER BY ROUTINE_NAME
    `);

    console.log("\n=== STORED PROCEDURES DEPLOYED IN DATABASE ===");
    console.log(`Total routines found: ${spResult.recordset.length}`);
    for (const r of spResult.recordset) {
      console.log(`  ${r.ROUTINE_TYPE}: ${r.ROUTINE_SCHEMA}.${r.ROUTINE_NAME}`);
    }

    // 3. Stored procedure parameters for any deployed critical SPs
    const paramResult = await pool.request().query<ParameterInfo>(`
      SELECT SPECIFIC_NAME, PARAMETER_NAME, DATA_TYPE, PARAMETER_MODE
      FROM INFORMATION_SCHEMA.PARAMETERS
      WHERE SPECIFIC_SCHEMA = 'dbo'
      ORDER BY SPECIFIC_NAME, ORDINAL_POSITION
    `);

    console.log("\n=== PARAMETERS FOR DEPLOYED ROUTINES ===");
    for (const p of paramResult.recordset) {
      console.log(`  ${p.SPECIFIC_NAME}: ${p.PARAMETER_NAME} (${p.DATA_TYPE}, ${p.PARAMETER_MODE})`);
    }

    // 4. Summarize columns for existing target tables
    console.log("\n=== COLUMNS FOR EXISTING BATCH 2 TABLES ===");
    for (const t of targetTables) {
      const cols = colResult.recordset.filter((c) => c.TABLE_NAME === t);
      if (cols.length > 0) {
        console.log(`\nTable dbo.${t} (${cols.length} columns):`);
        for (const c of cols) {
          const len = c.CHARACTER_MAXIMUM_LENGTH ? `(${c.CHARACTER_MAXIMUM_LENGTH})` : "";
          const def = c.COLUMN_DEFAULT ? ` DEFAULT ${c.COLUMN_DEFAULT}` : "";
          const nul = c.IS_NULLABLE === "YES" ? "NULL" : "NOT NULL";
          console.log(`  - ${c.COLUMN_NAME}: ${c.DATA_TYPE}${len} ${nul}${def}`);
        }
      }
    }
  } catch (err) {
    console.error("Inspection error:", err);
  } finally {
    await pool.close();
    console.log("\nConnection pool closed cleanly.");
  }
}

void run();
