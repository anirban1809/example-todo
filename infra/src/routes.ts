import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, sep } from 'node:path';
import ts from 'typescript';
import type { HttpMethod, ProjectConfig } from '@flowstacks/core';

export interface RouteParameter {
  gatewayName: string;
  routeName: string;
  catchAll: boolean;
}

export interface RouteFunction {
  id: string;
  sourceFile: string;
  method: HttpMethod;
  routePath: string;
  gatewayPaths: string[];
  parameters: RouteParameter[];
}

const routeFilePattern = /^route\.(?:ts|js|mts|mjs)$/;
const methods = new Set<HttpMethod>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function walk(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (routeFilePattern.test(entry.name)) files.push(path);
  }
  return files;
}

function exportedMethods(sourceFile: string): HttpMethod[] {
  const source = ts.createSourceFile(sourceFile, readFileSync(sourceFile, 'utf8'), ts.ScriptTarget.Latest, true);
  const found = new Set<HttpMethod>();
  const exported = (modifiers: ts.NodeArray<ts.ModifierLike> | undefined) =>
    modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && exported(statement.modifiers) && statement.name) {
      const name = statement.name.text as HttpMethod;
      if (methods.has(name)) found.add(name);
    }
    if (ts.isVariableStatement(statement) && exported(statement.modifiers)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          const name = declaration.name.text as HttpMethod;
          if (methods.has(name)) found.add(name);
        }
      }
    }
  }
  return [...found].sort();
}

function routeRoot(rootDirectory: string, framework: ProjectConfig['framework']): string | null {
  const candidates = framework === 'nextjs'
    ? [join(rootDirectory, 'app', 'api'), join(rootDirectory, 'src', 'app', 'api')]
    : [join(rootDirectory, 'api')];
  const existing = candidates.filter((candidate) => existsSync(candidate) && statSync(candidate).isDirectory());
  if (existing.length > 1) throw new Error('Use either app/api or src/app/api, not both');
  return existing[0] ?? null;
}

function routeShape(apiRoot: string, sourceFile: string) {
  const relativeDirectory = relative(apiRoot, dirname(sourceFile));
  const sourceSegments = relativeDirectory === '' ? [] : relativeDirectory.split(sep);
  if (sourceSegments.some((segment) => segment.startsWith('_'))) return null;
  const visibleSegments: string[] = [];
  const gatewaySegments: string[] = ['api'];
  const parameters: RouteParameter[] = [];
  let optionalCatchAll = false;
  for (const segment of sourceSegments) {
    if (/^\(.*\)$/.test(segment) || segment.startsWith('@')) continue;
    if (segment.includes('(') || segment.includes(')')) throw new Error(`Intercepting route segment ${segment} is not supported`);
    visibleSegments.push(segment);
    const optional = segment.match(/^\[\[\.\.\.(.+)\]\]$/);
    const catchAll = segment.match(/^\[\.\.\.(.+)\]$/);
    const dynamic = segment.match(/^\[(.+)\]$/);
    const match = optional ?? catchAll ?? dynamic;
    if (!match) {
      if (segment.includes('[') || segment.includes(']')) throw new Error(`Invalid route segment ${segment}`);
      gatewaySegments.push(segment);
      continue;
    }
    const routeName = match[1];
    const gatewayName = `p${parameters.length}`;
    const isCatchAll = Boolean(optional || catchAll);
    if (isCatchAll && segment !== sourceSegments.at(-1)) throw new Error(`Catch-all segment ${segment} must be final`);
    optionalCatchAll = Boolean(optional);
    parameters.push({ gatewayName, routeName, catchAll: isCatchAll });
    gatewaySegments.push(`{${gatewayName}${isCatchAll ? '+' : ''}}`);
  }
  const routePath = `/${['api', ...visibleSegments].join('/')}`;
  const gatewayPath = `/${gatewaySegments.join('/')}`;
  return {
    routePath,
    gatewayPaths: optionalCatchAll ? [`/${gatewaySegments.slice(0, -1).join('/')}`, gatewayPath] : [gatewayPath],
    parameters,
  };
}

export function discoverRouteFunctions(rootDirectory: string, framework: ProjectConfig['framework']): RouteFunction[] {
  const root = routeRoot(rootDirectory, framework);
  if (!root) return [];
  const functions = walk(root).flatMap((sourceFile) => {
    const shape = routeShape(root, sourceFile);
    if (!shape) return [];
    const exported = exportedMethods(sourceFile);
    if (!exported.length) throw new Error(`${sourceFile} exports no supported HTTP method`);
    return exported.map((method): RouteFunction => ({
      id: createHash('sha256').update(`${method} ${shape.routePath}`).digest('hex').slice(0, 12),
      sourceFile,
      method,
      ...shape,
    }));
  });
  const claimed = new Map<string, string>();
  for (const fn of functions) {
    for (const path of fn.gatewayPaths) {
      const key = `${fn.method} ${path}`;
      const owner = claimed.get(key);
      if (owner) throw new Error(`${owner} and ${fn.method} ${fn.routePath} both map to ${key}`);
      claimed.set(key, `${fn.method} ${fn.routePath}`);
    }
  }
  return functions.sort((left, right) => `${left.routePath} ${left.method}`.localeCompare(`${right.routePath} ${right.method}`));
}

function importPath(fromDirectory: string, file: string): string {
  let path = relative(fromDirectory, file).split(sep).join('/');
  path = path.slice(0, -extname(path).length);
  return path.startsWith('.') ? path : `./${path}`;
}

export function createRouteEntry(rootDirectory: string, fn: RouteFunction): string {
  const entry = join(rootDirectory, '.flowstacks', 'routes', `${fn.id}.ts`);
  mkdirSync(dirname(entry), { recursive: true });
  const entryDirectory = dirname(entry);
  const routeImport = importPath(entryDirectory, fn.sourceFile);
  const adapterImport = importPath(entryDirectory, join(rootDirectory, 'infra/src/route-adapter.ts'));
  const source = [
    `import * as route from ${JSON.stringify(routeImport)};`,
    `import { createRouteHandler } from ${JSON.stringify(adapterImport)};`,
    `export const handler = createRouteHandler(route, ${JSON.stringify({ method: fn.method, parameters: fn.parameters })});`,
    '',
  ].join('\n');
  let current = '';
  try { current = readFileSync(entry, 'utf8'); } catch { current = ''; }
  if (current !== source) writeFileSync(entry, source);
  return entry;
}
