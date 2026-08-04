import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { temporaryDirectory } from '../helpers.js';

const execFileAsync = promisify(execFile);
const appVersion = '0.2.0-beta.1';
const releaseTag = `v${appVersion}`;

describe('release artifact finalization', () => {
  it('verifies every target and emits flat deterministic checksums', async () => {
    const release = await releaseFixture();

    await finalize(release);
    const firstChecksums = await readFile(join(release, 'SHA256SUMS.txt'), 'utf8');
    await finalize(release);
    const secondChecksums = await readFile(join(release, 'SHA256SUMS.txt'), 'utf8');

    expect(secondChecksums).toBe(firstChecksums);
    const checksumLines = firstChecksums.trim().split('\n');
    expect(checksumLines).toHaveLength(9);
    expect(checksumLines.every((line) => !line.includes('artifacts/'))).toBe(true);
    const checksumNames = checksumLines.map((line) => line.slice(line.indexOf('  ') + 2));
    expect(checksumNames).toEqual([...checksumNames].sort());
    await expect(readFile(join(release, 'RELEASE_TRUST.md'), 'utf8')).resolves.toContain(
      'These packages are not production-signed.'
    );
    expect(
      JSON.parse(await readFile(join(release, 'release-evidence.json'), 'utf8'))
    ).toMatchObject({
      schemaVersion: 2,
      appVersion,
      releaseTag,
      commitSha: await commitSha(),
      releaseChannel: 'prerelease',
      targets: expect.arrayContaining([
        expect.objectContaining({ platform: 'darwin', arch: 'arm64', signed: false }),
        expect.objectContaining({ platform: 'linux', arch: 'x64', updateEnabled: false }),
      ]),
      artifacts: expect.arrayContaining([
        expect.objectContaining({
          filename: `QAgent-${appVersion}-win32-x64-UNSIGNED.exe`,
          platform: 'win32',
        }),
      ]),
    });
  });

  it('rejects an artifact changed after platform collection', async () => {
    const release = await releaseFixture();
    await writeFile(
      join(release, 'artifacts', 'linux-x64', `QAgent-${appVersion}-linux-x64-UNSIGNED.zip`),
      'tampered'
    );

    await expect(finalize(release)).rejects.toThrow(/size changed|checksum changed/i);
  });

  it('rejects update metadata for an unsigned prerelease', async () => {
    const release = await releaseFixture();
    const manifestPath = join(
      release,
      'artifacts',
      'win32-x64',
      'evidence-manifest-win32-x64.json'
    );
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      build: { updateEnabled: boolean };
      artifacts: Array<{ updateEnabled: boolean }>;
    };
    manifest.build.updateEnabled = true;
    for (const artifact of manifest.artifacts) artifact.updateEnabled = true;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    await expect(finalize(release)).rejects.toThrow(/cannot enable updates/i);
  });
});

async function releaseFixture(): Promise<string> {
  const release = await temporaryDirectory('qagent-release-evidence-');
  const artifactsRoot = join(release, 'artifacts');
  const sha = await commitSha();
  for (const [platform, arch, extensions] of [
    ['darwin', 'arm64', ['.dmg', '.zip']],
    ['darwin', 'x64', ['.dmg', '.zip']],
    ['win32', 'x64', ['.exe', '.zip']],
    ['linux', 'x64', ['.deb', '.rpm', '.zip']],
  ] as const) {
    const directory = join(artifactsRoot, `${platform}-${arch}`);
    await mkdir(directory, { recursive: true });
    const build = {
      version: 3,
      appVersion,
      releaseTag,
      commitSha: sha,
      sourceDirty: false,
      platform,
      arch,
      signed: false,
      notarized: false,
      releaseChannel: 'prerelease',
      updateRepository: 'rishabhcli/QAgent',
      updateEnabled: false,
    } as const;
    const artifactBuild = {
      appVersion: build.appVersion,
      releaseTag: build.releaseTag,
      commitSha: build.commitSha,
      sourceDirty: build.sourceDirty,
      platform: build.platform,
      arch: build.arch,
      signed: build.signed,
      notarized: build.notarized,
      releaseChannel: build.releaseChannel,
      updateRepository: build.updateRepository,
      updateEnabled: build.updateEnabled,
    };
    const artifacts = [];
    for (const extension of extensions) {
      const filename = `QAgent-${appVersion}-${platform}-${arch}-UNSIGNED${extension}`;
      const bytes = Buffer.from(`${platform}/${arch}/${extension}`);
      await writeFile(join(directory, filename), bytes);
      artifacts.push({
        filename,
        source: `maker/${platform}/${arch}/${filename}`,
        bytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        ...artifactBuild,
      });
    }
    await writeFile(
      join(directory, `evidence-manifest-${platform}-${arch}.json`),
      `${JSON.stringify({ schemaVersion: 3, build, artifacts }, null, 2)}\n`
    );
  }
  return release;
}

async function commitSha(): Promise<string> {
  const result = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: resolve('.') });
  return result.stdout.trim().toLowerCase();
}

async function finalize(release: string): Promise<void> {
  await execFileAsync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    [
      'exec',
      'tsx',
      resolve('scripts/finalize-release.ts'),
      `--artifacts=${join(release, 'artifacts')}`,
      `--output=${release}`,
      `--tag=${releaseTag}`,
    ],
    { cwd: resolve('.'), maxBuffer: 1024 * 1024 }
  );
}
