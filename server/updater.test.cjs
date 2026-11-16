'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { newerVersion, releaseVersion, releaseAsset } = require('./updater.cjs');

test('release title and numeric segments identify the matching ZIP', () => {
  const release = {
    name: 'Sniper Hunter 4.01',
    tag_name: 'v4.01',
    assets: [
      {
        name: 'SniperHunter-4.01.zip',
        state: 'uploaded',
        size: 123,
        browser_download_url:
          'https://github.com/Guardian-Seeker/SniperHunter/releases/download/v4.01/SniperHunter-4.01.zip',
      },
    ],
  };
  assert.equal(releaseVersion(release), '4.01');
  assert.equal(newerVersion('4.01', '4.0'), true);
  assert.equal(newerVersion('4.11', '4.01'), true);
  assert.equal(newerVersion('4.0', '4.01'), false);
  assert.equal(
    releaseAsset(release, '4.01', 'Guardian-Seeker', 'SniperHunter').name,
    'SniperHunter-4.01.zip',
  );
});

test(
  'ZIP installation replaces program files while preserving local data',
  { skip: process.platform !== 'win32' },
  () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'sniperhunter-updater-test-'));
    /**
     * Execute the installer fixture’s PowerShell command synchronously for assertions.
     * @param args PowerShell process arguments.
     * @returns The completed process result used by the test.
     */
    const run = (args) => {
      const result = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ...args],
        { encoding: 'utf8' },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result.stdout.trim();
    };
    try {
      const payload = path.join(fixture, 'payload');
      const target = path.join(fixture, 'target');
      const updateRoot = path.join(target, '.sniperhunter-update-fixture');
      const stage = path.join(updateRoot, 'stage');
      const archive = path.join(updateRoot, 'SniperHunter-4.0.zip');
      fs.mkdirSync(path.join(payload, 'skins'), { recursive: true });
      fs.mkdirSync(updateRoot, { recursive: true });
      fs.writeFileSync(path.join(payload, 'SniperHunter.exe'), 'new program');
      fs.writeFileSync(path.join(payload, 'SniperHunterParser.exe'), 'new parser');
      fs.writeFileSync(path.join(payload, 'skins', 'sniper.png'), 'new skin');
      fs.writeFileSync(path.join(target, 'SniperHunter.exe'), 'old program');
      fs.writeFileSync(path.join(target, 'SniperHunterParser.exe'), 'old parser');
      fs.writeFileSync(path.join(target, 'database.db'), 'local database');
      fs.writeFileSync(path.join(target, 'config.json'), 'local settings');
      const packScript = path.join(fixture, 'pack.ps1');
      fs.writeFileSync(
        packScript,
        'param([string]$Source,[string]$Archive)\nCompress-Archive -Path (Join-Path $Source "*") -DestinationPath $Archive -Force\n',
      );
      run([packScript, '-Source', payload, '-Archive', archive]);
      const helper = path.join(__dirname, 'updater.ps1');
      const packageRoot = run([
        helper,
        '-Mode',
        'Prepare',
        '-ArchivePath',
        archive,
        '-StagePath',
        stage,
      ]);
      assert.equal(packageRoot, stage);
      run([
        helper,
        '-Mode',
        'Install',
        '-PackageRoot',
        packageRoot,
        '-TargetPath',
        target,
        '-UpdatePath',
        updateRoot,
        '-ParentPid',
        '999999',
        '-SkipLaunch',
      ]);
      assert.equal(fs.readFileSync(path.join(target, 'SniperHunter.exe'), 'utf8'), 'new program');
      assert.equal(
        fs.readFileSync(path.join(target, 'SniperHunterParser.exe'), 'utf8'),
        'new parser',
      );
      assert.equal(fs.readFileSync(path.join(target, 'database.db'), 'utf8'), 'local database');
      assert.equal(fs.readFileSync(path.join(target, 'config.json'), 'utf8'), 'local settings');
      assert.equal(fs.existsSync(archive), false);
    } finally {
      const safeRoot = fs.realpathSync(os.tmpdir()) + path.sep;
      if (
        !path.resolve(fixture).startsWith(safeRoot) ||
        !path.basename(fixture).startsWith('sniperhunter-updater-test-')
      )
        throw new Error('Updater test cleanup path is outside the temporary folder.');
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  },
);

test(
  'background installer survives the server process exiting',
  { skip: process.platform !== 'win32' },
  async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'sniperhunter-updater-test-'));
    try {
      const target = path.join(fixture, 'target');
      const updateRoot = path.join(target, '.sniperhunter-update-fixture');
      const packageRoot = path.join(updateRoot, 'stage');
      fs.mkdirSync(packageRoot, { recursive: true });
      fs.writeFileSync(path.join(packageRoot, 'SniperHunter.exe'), 'updated');
      fs.writeFileSync(path.join(packageRoot, 'SniperHunterParser.exe'), 'updated parser');
      fs.writeFileSync(path.join(target, 'SniperHunter.exe'), 'old');
      const script = path.join(updateRoot, 'updater.ps1');
      fs.copyFileSync(path.join(__dirname, 'updater.ps1'), script);
      const code =
        `require(${JSON.stringify(path.join(__dirname, 'updater.cjs'))}).startInstaller(` +
        `${JSON.stringify({ updateRoot, packageRoot, script })}, ${JSON.stringify(target)}, 80, { skipLaunch: true })` +
        `.then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });`;
      const launcher = spawnSync(process.execPath, ['-e', code], {
        encoding: 'utf8',
        timeout: 10000,
      });
      assert.equal(launcher.status, 0, launcher.stderr || launcher.stdout);
      for (
        let attempt = 0;
        attempt < 100 &&
        fs.readFileSync(path.join(target, 'SniperHunter.exe'), 'utf8') !== 'updated';
        attempt++
      )
        await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(fs.readFileSync(path.join(target, 'SniperHunter.exe'), 'utf8'), 'updated');
    } finally {
      const safeRoot = fs.realpathSync(os.tmpdir()) + path.sep;
      if (
        !path.resolve(fixture).startsWith(safeRoot) ||
        !path.basename(fixture).startsWith('sniperhunter-updater-test-')
      )
        throw new Error('Updater test cleanup path is outside the temporary folder.');
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  },
);
