import type { ForgeConfig } from '@electron-forge/shared-types';
import { execFile } from 'node:child_process';
import { access, cp, mkdir, readdir, writeFile } from 'node:fs/promises';
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
  const workspaceRoot = resolve(import.meta.dirname, '../..');
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
    osxSign: process.env.QAGENT_MAC_SIGN_IDENTITY
      ? { identity: process.env.QAGENT_MAC_SIGN_IDENTITY }
      : undefined,
    osxNotarize:
      process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID
        ? {
            appleId: process.env.APPLE_ID,
            appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
            teamId: process.env.APPLE_TEAM_ID,
          }
        : undefined,
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
      const signed =
        (platform === 'darwin' && Boolean(process.env.QAGENT_MAC_SIGN_IDENTITY)) ||
        (platform === 'win32' &&
          Boolean(
            process.env.QAGENT_WINDOWS_CERTIFICATE_FILE &&
            process.env.QAGENT_WINDOWS_CERTIFICATE_PASSWORD
          ));
      const directory = join(import.meta.dirname, 'generated');
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, 'build-metadata.json'),
        `${JSON.stringify({ version: 1, platform, arch, signed, updateEnabled: signed })}\n`
      );
    },
    packageAfterPrune: async (_forgeConfig, buildPath) => {
      for (const module of runtimeModuleSources) {
        await cp(module.source, join(buildPath, 'node_modules', module.name), {
          dereference: true,
          recursive: true,
        });
      }
      const weaveModule = join(buildPath, 'node_modules', 'weave');
      await mkdir(weaveModule, { recursive: true });
      await writeFile(
        join(weaveModule, 'package.json'),
        JSON.stringify({ name: 'weave', version: '0.16.3', main: 'index.js' })
      );
      await writeFile(
        join(weaveModule, 'index.js'),
        "module.exports = require('../../dist/weave-runtime.js');\n"
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
        certificateFile: process.env.QAGENT_WINDOWS_CERTIFICATE_FILE,
        certificatePassword: process.env.QAGENT_WINDOWS_CERTIFICATE_PASSWORD,
      },
      ['win32']
    ),
    new MakerDMG({ format: 'ULFO' }, ['darwin']),
    new MakerZIP({}, ['darwin', 'win32', 'linux']),
    new MakerDeb(
      {
        options: {
          maintainer: 'QAgent contributors',
          homepage: 'https://github.com/rishabhcli/QAgent',
        },
      },
      ['linux']
    ),
    new MakerRpm({ options: { homepage: 'https://github.com/rishabhcli/QAgent' } }, ['linux']),
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
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    }),
  ],
};

export default config;
