import sql from "mssql";
import { loadSqlServerConfig } from "../src/config/sqlserver";

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
    const tables = ["NXA_Users", "NXA_Roles", "NXA_StudentProfiles", "NXA_Courses", "NXA_CourseModules", "NXA_Chapters", "NXA_Lessons", "NXA_Batches", "NXA_Enrollments"];
    console.log("=== ROW COUNTS IN SQL SERVER ===");
    for (const t of tables) {
      const query = "SELECT COUNT(*) as cnt FROM dbo." + t;
      const res = await pool.request().query<{ cnt: number }>(query);
      console.log("  dbo." + t + ": " + (res.recordset[0]?.cnt ?? 0) + " rows");
    }
  } catch (err) {
    console.error("Count check error:", err);
  } finally {
    await pool.close();
  }
}

void run();
