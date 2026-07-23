import { homedir } from 'node:os';
import { basename, isAbsolute, relative, resolve } from 'node:path';

const SECRET_SEGMENTS = new Set([
  '.env',
  '.git',
  '.npmrc',
  '.pypirc',
  'credentials.json',
  'secrets.json',
]);

export function resolveQAgentHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.QAGENT_HOME ?? resolve(homedir(), '.qagent'));
}

export function assertPathContained(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(root, candidate);
  const child = relative(resolvedRoot, resolvedCandidate);
  if (child === '..' || child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error(`Path escapes the trusted project: ${candidate}`);
  }
  return resolvedCandidate;
}

export function isSensitivePath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  const segments = normalized.split('/').filter(Boolean);
  return segments.some((segment) => {
    const lower = segment.toLowerCase();
    return (
      SECRET_SEGMENTS.has(lower) ||
      lower.startsWith('.env.') ||
      lower.endsWith('.pem') ||
      lower.endsWith('.key') ||
      lower.endsWith('.p12') ||
      lower.endsWith('.pfx')
    );
  });
}

export function isSafeRelativePath(path: string): boolean {
  return !isAbsolute(path) && path !== '..' && !path.replaceAll('\\', '/').startsWith('../');
}

export function projectDisplayName(path: string): string {
  return basename(resolve(path));
}
