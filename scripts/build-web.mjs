import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const stagingRoot = join(root, '.flowstacks', 'web');
const outputRoot = join(root, 'dist');
const excludedAtRoot = new Set([
  '.flowstacks',
  '.git',
  '.next',
  'app/api',
  'cdk.out',
  'dist',
  'infra',
  'node_modules',
  'src/app/api',
]);

function shouldCopy(source) {
  const relative = source.slice(root.length + 1).replaceAll('\\', '/');
  if (!relative) return true;
  return ![...excludedAtRoot].some(
    (excluded) => relative === excluded || relative.startsWith(`${excluded}/`),
  );
}

await rm(stagingRoot, { recursive: true, force: true });
await rm(outputRoot, { recursive: true, force: true });
await mkdir(stagingRoot, { recursive: true });
for (const entry of await readdir(root)) {
  const source = join(root, entry);
  if (shouldCopy(source))
    await cp(source, join(stagingRoot, entry), { recursive: true, filter: shouldCopy });
}

try {
  await new Promise((resolveBuild, rejectBuild) => {
    const next = join(root, 'node_modules', 'next', 'dist', 'bin', 'next');
    const child = spawn(process.execPath, [next, 'build', stagingRoot], {
      cwd: root,
      env: {
        ...process.env,
        FLOWSTACKS_STATIC_BUILD: 'true',
        NEXT_TELEMETRY_DISABLED: '1',
      },
      stdio: 'inherit',
    });
    child.once('error', rejectBuild);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveBuild();
      else rejectBuild(new Error(`Next.js static build failed (${signal ?? code})`));
    });
  });
  await cp(join(stagingRoot, 'out'), outputRoot, { recursive: true });
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
}
