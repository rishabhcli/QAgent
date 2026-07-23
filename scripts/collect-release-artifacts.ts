import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';

const supportedExtensions = new Set(['.deb', '.dmg', '.exe', '.rpm', '.zip']);
const argumentsMap = new Map(
  process.argv.slice(2).map((argument) => {
    const [key, value] = argument.split('=', 2);
    return [key?.replace(/^--/, ''), value];
  })
);
const platform = requiredArgument('platform');
const arch = requiredArgument('arch');
if (!['darwin', 'win32', 'linux'].includes(platform)) {
  throw new Error(`Unsupported release platform: ${platform}`);
}
if (!['arm64', 'x64'].includes(arch)) throw new Error(`Unsupported release architecture: ${arch}`);
const root = resolve(import.meta.dirname, '..');
const sourceRoot = join(root, 'apps/desktop/out/make');
const destination = join(root, 'release', `${platform}-${arch}`);
const metadata = JSON.parse(
  await readFile(join(root, 'apps/desktop/generated/build-metadata.json'), 'utf8')
) as { signed: boolean; platform: string; arch: string };

if (metadata.platform !== platform || metadata.arch !== arch) {
  throw new Error('Build metadata does not match the requested release target');
}

const sourceFiles = (await walk(sourceRoot)).filter((path) =>
  supportedExtensions.has(extname(path).toLowerCase())
);
if (sourceFiles.length === 0) throw new Error(`No release artifacts found beneath ${sourceRoot}`);

await mkdir(destination, { recursive: true });
const manifest = [];
for (const source of sourceFiles) {
  const extension = extname(source);
  const stem = basename(source, extension).replaceAll(/[^a-zA-Z0-9._-]/g, '-');
  const unsignedMarker = metadata.signed ? '' : '-UNSIGNED';
  const filename = `${stem}-${platform}-${arch}${unsignedMarker}${extension}`;
  const target = join(destination, filename);
  await cp(source, target);
  const bytes = await readFile(target);
  manifest.push({
    filename,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    platform,
    arch,
    signed: metadata.signed,
  });
}

await writeFile(
  join(destination, `evidence-manifest-${platform}-${arch}.json`),
  `${JSON.stringify({ schemaVersion: 1, artifacts: manifest }, null, 2)}\n`,
  'utf8'
);
console.log(`Collected ${manifest.length} ${platform}/${arch} release artifacts.`);

function requiredArgument(name: string): string {
  const value = argumentsMap.get(name);
  if (!value) throw new Error(`Missing --${name}=...`);
  return value;
}

async function walk(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const candidate = join(path, entry.name);
    if (entry.isDirectory()) paths.push(...(await walk(candidate)));
    else if (entry.isFile() && (await stat(candidate)).size > 0) paths.push(candidate);
  }
  return paths;
}
