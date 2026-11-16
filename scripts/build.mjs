import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { rcedit } from 'rcedit';
import { paths, ensureAngularDependencies } from './workspace.mjs';

/** Source and output locations; user data in release is deliberately preserved. */
const { root, web, angularCli } = paths;
const output = path.join(root, 'release');
const scratch = path.join(root, 'work');
const browser = path.join(web, 'dist', 'web', 'browser');
const blob = path.join(scratch, 'sniper-hunter.blob');
const config = path.join(scratch, 'sea-config.json');
const exe = path.join(output, 'SniperHunter.exe');

/**
 * Ensure Angular tooling is present and build the production browser application.
 * @returns Nothing; throws when Angular reports a failed build.
 */
function buildFrontend() {
  ensureAngularDependencies('Angular dependencies are missing. Run npm ci --prefix web first.');
  const build = spawnSync(process.execPath, [angularCli, 'build'], { cwd: web, stdio: 'inherit' });
  if (build.status !== 0) throw new Error('Angular build failed.');
}

/**
 * Collect browser and backend resources required by the Node single-executable build.
 * @returns Asset-key to absolute-file-path mapping, excluding portable skin images.
 */
function collectEmbeddedAssets() {
  const assets = {};

  /**
   * Walk the browser build recursively, retaining each non-skin asset under its URL-relative key.
   * @param dir Directory currently being traversed.
   * @returns Nothing; populates the enclosing asset manifest.
   */
  function collect(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) collect(file);
      else {
        const key = path.relative(browser, file).replaceAll('\\', '/');
        if (!key.startsWith('assets/skins/')) assets[key] = file;
      }
    }
  }

  collect(browser);
  assets['release-config.json'] = path.join(root, 'release-config.json');
  assets['tray.ps1'] = path.join(root, 'server', 'tray.ps1');
  assets['replay-import.cjs'] = path.join(root, 'server', 'replay-import.cjs');
  assets['map-timeline.cjs'] = path.join(root, 'server', 'map-timeline.cjs');
  assets['player-cache.cjs'] = path.join(root, 'server', 'player-cache.cjs');
  assets['database-queries.cjs'] = path.join(root, 'server', 'database-queries.cjs');
  assets['replay-work.cjs'] = path.join(root, 'server', 'replay-work.cjs');
  assets['updater.cjs'] = path.join(root, 'server', 'updater.cjs');
  assets['updater.ps1'] = path.join(root, 'server', 'updater.ps1');
  if (!assets['index.html']) throw new Error('Angular index.html is missing.');

  return assets;
}

/**
 * Create release/work folders while preserving user data and removing obsolete generated tray files.
 * @returns Nothing.
 */
function prepareOutputFolders() {
  fs.mkdirSync(output, { recursive: true });
  // Older releases wrote tray resources beside the executable. They are embedded now.
  for (const name of ['tray.ico', 'tray.ps1']) fs.rmSync(path.join(output, name), { force: true });
  const skinOutput = path.join(output, 'skins');
  fs.mkdirSync(skinOutput, { recursive: true });
  console.log(
    `Release skins: ${fs.readdirSync(skinOutput).filter((name) => name.toLowerCase().endsWith('.png')).length} icons (kept outside the executable).`,
  );
  fs.mkdirSync(scratch, { recursive: true });
}

/**
 * Write the Node SEA configuration and generate the application/resource blob.
 * @param assets Asset manifest produced by collectEmbeddedAssets.
 * @returns Nothing; throws if Node cannot generate the blob.
 */
function writeSeaBlob(assets) {
  fs.writeFileSync(
    config,
    JSON.stringify(
      {
        main: path.join(root, 'server', 'index.cjs'),
        output: blob,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
        assets,
      },
      null,
      2,
    ),
  );

  const prepare = spawnSync(process.execPath, ['--experimental-sea-config', config], {
    stdio: 'inherit',
  });
  if (prepare.status !== 0) throw new Error('Node executable preparation failed.');
}

/**
 * Change the validated PE console subsystem to GUI so launching the app does not create a terminal.
 * @param exe Built Windows executable to patch in place.
 * @returns Nothing; closes the file even if header validation fails.
 */
function useWindowsGuiSubsystem(exe) {
  const handle = fs.openSync(exe, 'r+');
  try {
    const header = Buffer.alloc(4);
    fs.readSync(handle, header, 0, 4, 0x3c);
    const peOffset = header.readUInt32LE(0);
    fs.readSync(handle, header, 0, 4, peOffset);
    if (header.toString('ascii') !== 'PE\0\0')
      throw new Error('Built executable has no PE header.');
    const subsystemOffset = peOffset + 24 + 68;
    const subsystem = Buffer.alloc(2);
    fs.readSync(handle, subsystem, 0, 2, subsystemOffset);
    if (subsystem.readUInt16LE(0) !== 3)
      throw new Error('Built executable is not a Windows console program.');
    subsystem.writeUInt16LE(2);
    fs.writeSync(handle, subsystem, 0, 2, subsystemOffset);
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * Copy the Node runtime, apply Windows resources, inject the SEA blob and hide the console subsystem.
 * @returns A promise resolving after the executable is complete.
 */
async function assembleExecutable() {
  fs.copyFileSync(process.execPath, exe);
  await rcedit(exe, {
    'requested-execution-level': 'asInvoker',
    icon: path.join(web, 'public', 'assets', 'icon.ico'),
    'version-string': { ProductName: 'Sniper Hunter', FileDescription: 'Sniper Hunter' },
  });
  const postject = path.join(root, 'node_modules', 'postject', 'dist', 'cli.js');
  const inject = spawnSync(
    process.execPath,
    [
      postject,
      exe,
      'NODE_SEA_BLOB',
      blob,
      '--sentinel-fuse',
      'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    ],
    { stdio: 'inherit' },
  );
  if (inject.status !== 0) throw new Error('Node executable injection failed.');

  useWindowsGuiSubsystem(exe);
}

/**
 * Run the Windows release build in dependency order without changing portable user data.
 * @returns A promise resolving after the release executable has been written.
 */
async function buildRelease() {
  if (process.platform !== 'win32')
    throw new Error('The release executable must be built on Windows.');
  buildFrontend();
  const assets = collectEmbeddedAssets();
  prepareOutputFolders();
  writeSeaBlob(assets);
  await assembleExecutable();
  console.log(`Built ${exe}`);
}

await buildRelease();
