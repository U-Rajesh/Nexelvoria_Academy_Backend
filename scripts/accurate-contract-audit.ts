import fs from 'fs';
import path from 'path';

interface RouteEntry {
  method: string;
  path: string;
  module: string;
}

const backendRoutes: RouteEntry[] = [];

function extractRoutesFromFile(filePath: string, mountPrefix: string, moduleName: string) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  const regex = /router\.(get|post|put|patch|delete)\s*\(\s*(['"`][^'"`]+['"`])/gs;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const method = match[1]!.toUpperCase();
    const routePath = match[2]!.replace(/['"`]/g, '');
    const fullPath = ('/api/v1' + mountPrefix + (routePath === '/' ? '' : routePath)).replace(/\/+/g, '/');
    backendRoutes.push({ method, path: fullPath, module: moduleName });
  }
}

const baseDir = path.resolve(__dirname, '../src/modules');

extractRoutesFromFile(path.join(baseDir, 'auth/auth.routes.ts'), '/auth', 'auth');
extractRoutesFromFile(path.join(baseDir, 'courses/course.routes.ts'), '/courses', 'courses');
extractRoutesFromFile(path.join(baseDir, 'students/student.routes.ts'), '/students', 'students');
extractRoutesFromFile(path.join(baseDir, 'enrollments/enrollment.routes.ts'), '/enrollments', 'enrollments');
extractRoutesFromFile(path.join(baseDir, 'teachers/teacher.routes.ts'), '/teachers', 'teachers');
extractRoutesFromFile(path.join(baseDir, 'payments/payment.routes.ts'), '/payments', 'payments');
extractRoutesFromFile(path.join(baseDir, 'certificates/certificate.routes.ts'), '/certificates', 'certificates');
extractRoutesFromFile(path.join(baseDir, 'placements/placement.routes.ts'), '/placements', 'placements');
extractRoutesFromFile(path.join(baseDir, 'support/support.routes.ts'), '/support', 'support');
extractRoutesFromFile(path.join(baseDir, 'health/health.routes.ts'), '', 'health');

const cmsFile = path.join(baseDir, 'cms/cms.routes.ts');
if (fs.existsSync(cmsFile)) {
  const cmsContent = fs.readFileSync(cmsFile, 'utf8');
  const publicCmsMatch = cmsContent.match(/export const createPublicCmsRoutes[\s\S]*?(?=export const createAdminCmsRoutes|$)/);
  if (publicCmsMatch && publicCmsMatch[0]) {
    const regex = /router\.(get|post|put|patch|delete)\s*\(\s*(['"`][^'"`]+['"`])/gs;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(publicCmsMatch[0])) !== null) {
      const fullPath = ('/api/v1/public' + (m[2]!.replace(/['"`]/g, '') === '/' ? '' : m[2]!.replace(/['"`]/g, ''))).replace(/\/+/g, '/');
      backendRoutes.push({ method: m[1]!.toUpperCase(), path: fullPath, module: 'cms-public' });
    }
  }
  const adminCmsMatch = cmsContent.match(/export const createAdminCmsRoutes[\s\S]*$/);
  if (adminCmsMatch && adminCmsMatch[0]) {
    const regex = /router\.(get|post|put|patch|delete)\s*\(\s*(['"`][^'"`]+['"`])/gs;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(adminCmsMatch[0])) !== null) {
      const fullPath = ('/api/v1/admin/cms' + (m[2]!.replace(/['"`]/g, '') === '/' ? '' : m[2]!.replace(/['"`]/g, ''))).replace(/\/+/g, '/');
      backendRoutes.push({ method: m[1]!.toUpperCase(), path: fullPath, module: 'cms-admin' });
    }
  }
}

const adminFile = path.join(baseDir, 'admin/admin.routes.ts');
if (fs.existsSync(adminFile)) {
  const adminContent = fs.readFileSync(adminFile, 'utf8');
  const adminMatch = adminContent.match(/export const createAdminRoutes[\s\S]*?(?=export const createSuperAdminRoutes|$)/);
  if (adminMatch && adminMatch[0]) {
    const regex = /router\.(get|post|put|patch|delete)\s*\(\s*(['"`][^'"`]+['"`])/gs;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(adminMatch[0])) !== null) {
      const fullPath = ('/api/v1/admin' + (m[2]!.replace(/['"`]/g, '') === '/' ? '' : m[2]!.replace(/['"`]/g, ''))).replace(/\/+/g, '/');
      backendRoutes.push({ method: m[1]!.toUpperCase(), path: fullPath, module: 'admin' });
    }
  }
  const superAdminMatch = adminContent.match(/export const createSuperAdminRoutes[\s\S]*$/);
  if (superAdminMatch && superAdminMatch[0]) {
    const regex = /router\.(get|post|put|patch|delete)\s*\(\s*(['"`][^'"`]+['"`])/gs;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(superAdminMatch[0])) !== null) {
      const fullPath = ('/api/v1/super-admin' + (m[2]!.replace(/['"`]/g, '') === '/' ? '' : m[2]!.replace(/['"`]/g, ''))).replace(/\/+/g, '/');
      backendRoutes.push({ method: m[1]!.toUpperCase(), path: fullPath, module: 'super-admin' });
    }
  }
}

interface FrontendCall {
  file: string;
  line: number;
  method: string;
  rawUrl: string;
  normalizedPath: string;
}

const frontendCalls: FrontendCall[] = [];
const servicesDir = path.resolve(__dirname, '../../Nexelvoria_Academy_Frontend/src/services');
if (fs.existsSync(servicesDir)) {
  const serviceFiles = fs.readdirSync(servicesDir).filter(f => f.endsWith('.ts'));

  for (const sFile of serviceFiles) {
    const content = fs.readFileSync(path.join(servicesDir, sFile), 'utf8');
    const lines = content.split('\n');

    lines.forEach((line, idx) => {
      const regex = /(?:apiClient|api|httpClient|http)\.(get|post|put|patch|delete)\s*(?:<[^>]*>)?\s*\(\s*(['"`][^'"`]+['"`])/g;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(line)) !== null) {
        const method = match[1]!.toUpperCase();
        const rawUrl = match[2]!.replace(/['"`]/g, '');
        const urlPath = rawUrl.split('?')[0] || '';

        let normalizedUrl = urlPath.replace(/\$\{[^}]+\}/g, ':param');
        if (!normalizedUrl.startsWith('/api/v1')) {
          normalizedUrl = '/api/v1' + (normalizedUrl.startsWith('/') ? normalizedUrl : '/' + normalizedUrl);
        }

        frontendCalls.push({
          file: sFile,
          line: idx + 1,
          method,
          rawUrl,
          normalizedPath: normalizedUrl.replace(/\/+/g, '/'),
        });
      }
    });
  }
}

console.log(`Backend routes: ${backendRoutes.length}, Frontend calls: ${frontendCalls.length}`);
