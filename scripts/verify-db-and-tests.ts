import fs from 'fs';
import path from 'path';
import { getSqlServerPool } from '../src/db/sqlserver.pool';

async function verifyDbAndTests() {
  console.log('====================================================');
  console.log('AUDITING DATABASE DEPENDENCIES & AUTH PERSISTENCE');
  console.log('====================================================');

  try {
    const pool = await getSqlServerPool();
    console.log('Connected to SQL Server pool successfully!\n');

    // 1. Check NXA_Roles
    console.log('--- 1. NXA_Roles Records ---');
    try {
      const rolesRes = await pool.request().query('SELECT * FROM dbo.NXA_Roles');
      console.log(`Row count in dbo.NXA_Roles: ${rolesRes.recordset.length}`);
      console.log('Roles data:', rolesRes.recordset);
    } catch (e: any) {
      console.log('Error querying dbo.NXA_Roles:', e.message);
    }

    // 2. Check NXA_UserSessions columns
    console.log('\n--- 2. NXA_UserSessions Columns ---');
    try {
      const sessColRes = await pool.request().query(`
        SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'NXA_UserSessions'
        ORDER BY ORDINAL_POSITION
      `);
      console.log(`NXA_UserSessions columns (${sessColRes.recordset.length}):`);
      for (const col of sessColRes.recordset) {
        console.log(`  - ${col.COLUMN_NAME} (${col.DATA_TYPE}${col.CHARACTER_MAXIMUM_LENGTH ? '(' + col.CHARACTER_MAXIMUM_LENGTH + ')' : ''}, nullable: ${col.IS_NULLABLE})`);
      }
    } catch (e: any) {
      console.log('Error querying NXA_UserSessions columns:', e.message);
    }

    // 3. Check Stored Procedures for Auth/Users
    console.log('\n--- 3. Relevant Stored Procedures ---');
    try {
      const spRes = await pool.request().query(`
        SELECT ROUTINE_NAME
        FROM INFORMATION_SCHEMA.ROUTINES
        WHERE ROUTINE_SCHEMA = 'dbo' AND ROUTINE_TYPE = 'PROCEDURE'
          AND (ROUTINE_NAME LIKE '%User%' OR ROUTINE_NAME LIKE '%Auth%' OR ROUTINE_NAME LIKE '%Session%' OR ROUTINE_NAME LIKE '%Role%')
        ORDER BY ROUTINE_NAME
      `);
      console.log(`Found ${spRes.recordset.length} auth-related stored procedures:`);
      for (const sp of spRes.recordset) {
        console.log(`  - dbo.${sp.ROUTINE_NAME}`);
      }

      // Check parameters of critical procedures
      const spParams = await pool.request().query(`
        SELECT SPECIFIC_NAME, PARAMETER_NAME, DATA_TYPE, PARAMETER_MODE
        FROM INFORMATION_SCHEMA.PARAMETERS
        WHERE SPECIFIC_SCHEMA = 'dbo' AND SPECIFIC_NAME IN ('USP_NXA_RegisterUser', 'USP_NXA_ValidateUserCredentials')
        ORDER BY SPECIFIC_NAME, ORDINAL_POSITION
      `);
      console.log('\nParameters for critical procedures:');
      for (const p of spParams.recordset) {
        console.log(`  - ${p.SPECIFIC_NAME}: ${p.PARAMETER_NAME} (${p.DATA_TYPE}, ${p.PARAMETER_MODE})`);
      }
    } catch (e: any) {
      console.log('Error querying procedures:', e.message);
    }

    // 4. Check Current User Permissions
    console.log('\n--- 4. Database Permissions for Current User ---');
    try {
      const permRes = await pool.request().query(`
        SELECT permission_name, state_desc
        FROM fn_my_permissions(NULL, 'DATABASE')
        WHERE permission_name IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'EXECUTE', 'CREATE TABLE', 'ALTER')
      `);
      console.log('Current user effective database permissions:');
      for (const p of permRes.recordset) {
        console.log(`  - ${p.permission_name}: ${p.state_desc}`);
      }
    } catch (e: any) {
      console.log('Error querying permissions:', e.message);
    }
  } catch (err: any) {
    console.log('Failed to connect to SQL Server:', err.message);
  }

  // 5. Inspect tests/e2e-all-10-journeys.test.ts
  console.log('\n====================================================');
  console.log('AUDITING E2E TEST AUTHENTICITY (10 JOURNEYS)');
  console.log('====================================================');

  const testFilePath = path.resolve(__dirname, '../tests/e2e-all-10-journeys.test.ts');
  const testContent = fs.readFileSync(testFilePath, 'utf8');

  console.log('Test file lines:', testContent.split('\n').length);
  const usesTestHarness = testContent.includes('createTestHarness');
  const usesMssql = testContent.includes("from 'mssql'") || testContent.includes('sql.connect');
  const usesServer = testContent.includes('startServer');

  console.log(`Uses createTestHarness (in-memory fakes): ${usesTestHarness}`);
  console.log(`Connects to live mssql database: ${usesMssql}`);
  console.log(`Uses in-memory HTTP server helper: ${usesServer}`);

  const journeyMatches = testContent.match(/it\(['"`](Journey \d+:[^'"`]+)['"`]/g);
  if (journeyMatches) {
    console.log('\nDiscovered Journeys in test suite:');
    for (const j of journeyMatches) {
      console.log(`  * ${j}`);
    }
  }
}

verifyDbAndTests().catch(console.error);
