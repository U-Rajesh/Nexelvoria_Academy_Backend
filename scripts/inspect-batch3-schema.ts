import { getSqlServerPool } from "../src/db/sqlserver.pool";

async function run() {
  const pool = await getSqlServerPool();
  const tables = [
    "NXA_TeacherProfiles",
    "NXA_TeacherAllocations",
    "NXA_Batches",
    "NXA_ClassSessions",
    "NXA_AttendanceRecords",
    "NXA_Assignments",
    "NXA_AssignmentSubmissions",
    "NXA_LearningMaterials",
    "NXA_LessonProgress",
    "NXA_LessonDoubts",
    "NXA_Tests",
    "NXA_TestAttempts",
  ];

  try {
    for (const table of tables) {
      const res = await pool.request().query<{
        COLUMN_NAME: string;
        DATA_TYPE: string;
        CHARACTER_MAXIMUM_LENGTH: number | null;
        IS_NULLABLE: string;
      }>(`
        SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = '${table}'
        ORDER BY ORDINAL_POSITION
      `);
      console.log(`\nTable dbo.${table} (${res.recordset.length} columns):`);
      for (const col of res.recordset) {
        const len = col.CHARACTER_MAXIMUM_LENGTH ? `(${col.CHARACTER_MAXIMUM_LENGTH})` : "";
        console.log(`  - ${col.COLUMN_NAME}: ${col.DATA_TYPE}${len} ${col.IS_NULLABLE === "YES" ? "NULL" : "NOT NULL"}`);
      }
    }
  } catch (err) {
    console.error("Schema inspection error:", err);
  } finally {
    await pool.close();
  }
}

void run();
