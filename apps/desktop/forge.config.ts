import type { ForgeConfig } from '@electron-forge/shared-types';
import { execFile } from 'node:child_process';
import { access, cp, mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const workspaceRoot = resolve(import.meta.dirname, '../..');
const desktopPackage = require('./package.json') as { version: string };
const weavePackage = require(join(dirname(require.resolve('weave')), '../package.json')) as {
  version: string;
};
const updateRepository = 'rishabhcli/QAgent';
const appVersion = desktopPackage.version;
const releaseTag = process.env.QAGENT_RELEASE_TAG?.trim() || null;
const releaseChannel = appVersion.includes('-') ? 'prerelease' : 'stable';
const sourceStatePromise = resolveSourceState();
const windowsSigning =
  process.env.QAGENT_WINDOWS_CERTIFICATE_FILE && process.env.QAGENT_WINDOWS_CERTIFICATE_PASSWORD
    ? {
        certificateFile: process.env.QAGENT_WINDOWS_CERTIFICATE_FILE,
        certificatePassword: process.env.QAGENT_WINDOWS_CERTIFICATE_PASSWORD,
      }
    : undefined;
const macSigning = process.env.QAGENT_MAC_SIGN_IDENTITY
  ? { identity: process.env.QAGENT_MAC_SIGN_IDENTITY }
  : undefined;
const macNotarization =
  macSigning &&
  process.env.APPLE_ID &&
  process.env.APPLE_APP_SPECIFIC_PASSWORD &&
  process.env.APPLE_TEAM_ID
    ? {
        appleId: process.env.APPLE_ID,
        appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
        teamId: process.env.APPLE_TEAM_ID,
      }
    : undefined;
const runtimeModuleSources = ['better-sqlite3', 'ajv', 'ajv-formats'].map((name) => ({
  name,
  source: dirname(require.resolve(`${name}/package.json`)),
}));

async function cleanMacPlist(buildPath: string): Promise<void> {
  const infoPlist = resolve(buildPath, '..', '..', 'Info.plist');
  await execFileAsync('plutil', [
    '-replace',
    'CFBundleDisplayName',
    '-string',
    'QAgent',
    infoPlist,
  ]);
  for (const key of [
    'NSAudioCaptureUsageDescription',
    'NSBluetoothAlwaysUsageDescription',
    'NSBluetoothPeripheralUsageDescription',
    'NSCameraUsageDescription',
    'NSMicrophoneUsageDescription',
  ]) {
    await execFileAsync('plutil', ['-remove', key, infoPlist]).catch(() => undefined);
  }
}

async function prepareMacDmgMaker(): Promise<void> {
  if (process.platform !== 'darwin') return;
  const pnpmStore = join(workspaceRoot, 'node_modules', '.pnpm');
  const pnpmEntries = await readdir(pnpmStore);
  const nativeMakerModules = [
    { name: 'macos-alias', output: 'volume.node' },
    { name: 'fs-xattr', output: 'xattr.node' },
  ];
  for (const module of nativeMakerModules) {
    const moduleRoots = new Set([dirname(require.resolve(`${module.name}/package.json`))]);
    for (const entry of pnpmEntries.filter((name) => name.startsWith(`${module.name}@`))) {
      const moduleRoot = join(pnpmStore, entry, 'node_modules', module.name);
      try {
        await access(join(moduleRoot, 'package.json'));
        moduleRoots.add(moduleRoot);
      } catch {
        // Ignore store entries that do not contain the package payload.
      }
    }
    for (const moduleRoot of moduleRoots) {
      try {
        await access(join(moduleRoot, 'build', 'Release', module.output));
        continue;
      } catch {
        // These legacy maker dependencies have binding.gyp files but no install scripts.
      }
      await execFileAsync(
        process.execPath,
        [require.resolve('@electron/node-gyp/bin/node-gyp.js'), 'rebuild', '--loglevel=error'],
        { cwd: moduleRoot }
      );
    }
  }
}

async function pruneNativePrebuilds(
  buildPath: string,
  platform: 'darwin' | 'linux' | 'win32',
  arch: 'arm64' | 'x64'
): Promise<void> {
  const prebuildDirectory = join(buildPath, 'node_modules', 'better-sqlite3', 'prebuilds');
  const targetPrebuild = `${platform}-${arch}.node`;
  const prebuilds = await readdir(prebuildDirectory);
  await Promise.all(
    prebuilds
      .filter((prebuild) => prebuild.endsWith('.node') && prebuild !== targetPrebuild)
      .map((prebuild) => unlink(join(prebuildDirectory, prebuild)))
  );
  await access(join(prebuildDirectory, targetPrebuild));
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: { unpack: '**/*.node' },
    appBundleId: 'dev.qagent.desktop',
    appCategoryType: 'public.app-category.developer-tools',
    executableName: 'QAgent',
    extraResource: ['./generated/build-metadata.json'],
    icon: './assets/icon',
    ignore: (file) => {
      if (!file) return false;
      const included = ['/.vite', '/dist'];
      return !included.some((path) => file === path || file.startsWith(`${path}/`));
    },
    extendInfo: {
      CFBundleDisplayName: 'QAgent',
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: false },
    },
    osxSign: macSigning,
    osxNotarize: macNotarization,
    windowsSign: windowsSigning,
    afterCopy: [
      (buildPath, _electronVersion, platform, _arch, callback) => {
        if (platform !== 'darwin') {
          callback();
          return;
        }
        void cleanMacPlist(buildPath).then(() => callback(), callback);
      },
    ],
  },
  rebuildConfig: {},
  hooks: {
    preMake: async () => prepareMacDmgMaker(),
    generateAssets: async (_forgeConfig, platform, arch) => {
      const source = await sourceStatePromise;
      const signed =
        (platform === 'darwin' && Boolean(macSigning)) ||
        (platform === 'win32' && Boolean(windowsSigning));
      const notarized = platform === 'darwin' && Boolean(macNotarization);
      const releaseTagMatches = releaseTag === `v${appVersion}`;
      const updateEnabled =
        process.env.QAGENT_ENABLE_AUTO_UPDATE === 'true' &&
        releaseTagMatches &&
        releaseChannel === 'stable' &&
        !source.sourceDirty &&
        platform === 'darwin' &&
        signed &&
        notarized;
      const directory = join(import.meta.dirname, 'generated');
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, 'build-metadata.json'),
        `${JSON.stringify({
          version: 3,
          appVersion,
          releaseTag,
          commitSha: source.commitSha,
          sourceDirty: source.sourceDirty,
          platform,
          arch,
          signed,
          notarized,
          releaseChannel,
          updateRepository,
          updateEnabled,
        })}\n`,
        'utf8'
      );
    },
    packageAfterPrune: async (_forgeConfig, buildPath, _electronVersion, platform, arch) => {
      for (const module of runtimeModuleSources) {
        await cp(module.source, join(buildPath, 'node_modules', module.name), {
          dereference: true,
          recursive: true,
        });
      }
      if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
        throw new Error(`Unsupported package platform for native prebuild pruning: ${platform}`);
      }
      if (arch !== 'arm64' && arch !== 'x64') {
        throw new Error(`Unsupported package architecture for native prebuild pruning: ${arch}`);
      }
      await pruneNativePrebuilds(buildPath, platform, arch);
      const weaveRuntime = join(buildPath, 'dist/weave-runtime.js');
      await access(weaveRuntime);
      const weaveModule = join(buildPath, 'node_modules', 'weave');
      await mkdir(weaveModule, { recursive: true });
      await writeFile(
        join(weaveModule, 'package.json'),
        JSON.stringify({ name: 'weave', version: weavePackage.version, main: 'index.js' }),
        'utf8'
      );
      await writeFile(
        join(weaveModule, 'index.js'),
        "module.exports = require('../../dist/weave-runtime.js');\n",
        'utf8'
      );
    },
    postPackage: async (_forgeConfig, result) => {
      if (result.platform !== 'darwin' || process.env.QAGENT_MAC_SIGN_IDENTITY) return;
      for (const outputPath of result.outputPaths) {
        const appPath = join(outputPath, 'QAgent.app');
        await execFileAsync('codesign', [
          '--force',
          '--deep',
          '--sign',
          '-',
          '--timestamp=none',
          appPath,
        ]);
      }
    },
  },
  makers: [
    new MakerSquirrel(
      {
        name: 'qagent',
        authors: 'QAgent contributors',
        description: 'Local-first autonomous QA for web applications',
        windowsSign: windowsSigning,
      },
      ['win32']
    ),
    new MakerDMG({ format: 'ULFO' }, ['darwin']),
    new MakerZIP({}, ['darwin', 'win32', 'linux']),
    new MakerDeb(
      {
        options: {
          name: 'qagent',
          productName: 'QAgent',
          bin: 'QAgent',
          maintainer: 'QAgent contributors',
          homepage: 'https://github.com/rishabhcli/QAgent',
          description: 'Local-first autonomous QA for web applications',
        },
      },
      ['linux']
    ),
    new MakerRpm(
      {
        options: {
          name: 'qagent',
          productName: 'QAgent',
          bin: 'QAgent',
          homepage: 'https://github.com/rishabhcli/QAgent',
          description: 'Local-first autonomous QA for web applications',
          license: 'AGPL-3.0',
        },
      },
      ['linux']
    ),
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main.ts', config: 'vite.main.config.ts', target: 'main' },
        { entry: 'src/preload.ts', config: 'vite.preload.config.ts', target: 'preload' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      // QAgent renders only its local application protocol, so encrypted browser cookies would
      // create an unnecessary Keychain dependency for unsigned macOS builds.
      [FuseV1Options.EnableCookieEncryption]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    }),
  ],
};

async function currentCommitSha(): Promise<string> {
  const result = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot });
  const sha = result.stdout.trim();
  if (!/^[a-f0-9]{40}$/i.test(sha)) throw new Error('Could not resolve the release commit SHA');
  return sha.toLowerCase();
}

async function resolveSourceState(): Promise<{ commitSha: string; sourceDirty: boolean }> {
  const commitSha = await currentCommitSha();
  const status = await execFileAsync('git', ['status', '--porcelain=v1', '--'], {
    cwd: workspaceRoot,
  });
  const sourceDirty = status.stdout.trim().length > 0;
  if (!releaseTag) return { commitSha, sourceDirty };
  if (releaseTag !== `v${appVersion}`) {
    throw new Error(`Release tag ${releaseTag} does not match application version ${appVersion}`);
  }
  if (sourceDirty) throw new Error('Release metadata cannot be generated from a dirty source tree');
  const tagged = await execFileAsync(
    'git',
    ['rev-parse', '--verify', `refs/tags/${releaseTag}^{commit}`],
    { cwd: workspaceRoot }
  ).catch(() => null);
  const tagCommitSha = tagged?.stdout.trim().toLowerCase();
  if (!tagCommitSha || tagCommitSha !== commitSha) {
    throw new Error(`Release tag ${releaseTag} does not resolve to the checked-out commit`);
  }
  return { commitSha, sourceDirty };
}

export default config;
