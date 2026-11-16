'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Readable, Transform } = require('node:stream');

/**
 * Parse dotted numeric release versions without treating them as floating-point numbers.
 * @param value Version text such as 4.01 or 4.11.
 * @returns Numeric version segments, or null for invalid text.
 */
function versionParts(value) {
  const normalized = String(value || '').replace(/^v/i, '');
  return /^\d+(?:\.\d+)*$/.test(normalized) ? normalized.split('.').map(Number) : null;
}

/**
 * Compare dotted version segments, treating missing trailing segments as zero.
 * @param latest Candidate release version.
 * @param current Installed version.
 * @returns Whether the candidate is newer.
 */
function newerVersion(latest, current) {
  const left = versionParts(latest);
  const right = versionParts(current);
  if (!left || !right) return false;
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    if ((left[index] || 0) !== (right[index] || 0)) return (left[index] || 0) > (right[index] || 0);
  }
  return false;
}

/**
 * Extract the numeric version from the release title, falling back to its tag.
 * @param release GitHub release metadata.
 * @returns The version string or null when no supported version is present.
 */
function releaseVersion(release) {
  const title = /^Sniper Hunter (\d+(?:\.\d+)*)$/i.exec(String(release.name || '').trim());
  if (title) return title[1];
  const tag = String(release.tag_name || '').replace(/^v/i, '');
  return versionParts(tag) ? tag : null;
}

/**
 * Select the expected release ZIP and validate that its download URL belongs to the configured GitHub repository.
 * @param release GitHub release metadata.
 * @param version Expected release version.
 * @param owner Configured GitHub owner.
 * @param repository Configured repository name.
 * @returns The matching asset descriptor, or null.
 */
function releaseAsset(release, version, owner, repository) {
  const filename = `SniperHunter-${version}.zip`;
  const asset = Array.isArray(release.assets)
    ? release.assets.find((item) => item.name === filename && item.state === 'uploaded')
    : null;
  if (!asset) return null;
  const url = new URL(asset.browser_download_url);
  const prefix = `/${owner}/${repository}/releases/download/`;
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    !url.pathname.startsWith(prefix) ||
    !url.pathname.endsWith(`/${filename}`)
  )
    throw new Error('GitHub returned an unexpected release asset URL.');
  return {
    url: url.href,
    name: filename,
    size: Number(asset.size) || 0,
    digest: String(asset.digest || ''),
  };
}

/**
 * Stream the release ZIP to disk while enforcing size, redirect-origin and optional SHA-256 checks.
 * @param asset Validated GitHub ZIP asset.
 * @param destination Absolute destination ZIP path.
 * @param onProgress Progress callback receiving downloaded bytes and expected total bytes.
 * @returns A promise resolving when the complete file has been written.
 */
async function downloadAsset(asset, destination, onProgress = () => {}) {
  /** Hard limit for release ZIP downloads (2 GiB), independent of the server-advertised asset length. */
  const maxBytes = 2 * 1024 * 1024 * 1024;
  if (asset.size > maxBytes) throw new Error('The release archive is too large.');
  const response = await fetch(asset.url, {
    headers: { 'User-Agent': 'SniperHunter-Updater', Accept: 'application/octet-stream' },
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!response.ok || !response.body)
    throw new Error(`Release download returned ${response.status}.`);
  const finalUrl = new URL(response.url);
  if (
    finalUrl.protocol !== 'https:' ||
    !(finalUrl.hostname === 'github.com' || finalUrl.hostname.endsWith('.githubusercontent.com'))
  )
    throw new Error('The release download redirected outside GitHub.');
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  await pipeline(
    Readable.fromWeb(response.body),
    new Transform({
      /**
       * Report download progress while forwarding each response chunk to the ZIP file.
       * @param chunk Downloaded buffer.
       * @param encoding Stream encoding metadata.
       * @param callback Node transform callback.
       * @returns Nothing; passes the buffer onward.
       */
      transform(chunk, encoding, callback) {
        bytes += chunk.length;
        if (bytes > maxBytes || (asset.size && bytes > asset.size))
          return callback(new Error('Release download exceeded its expected size.'));
        hash.update(chunk);
        onProgress({ bytes, total: asset.size });
        callback(null, chunk);
      },
    }),
    fs.createWriteStream(destination, { flags: 'wx' }),
  );
  if (asset.size && bytes !== asset.size) throw new Error('Release download was incomplete.');
  if (
    /^sha256:[a-f0-9]{64}$/i.test(asset.digest) &&
    hash.digest('hex').toLowerCase() !== asset.digest.slice(7).toLowerCase()
  )
    throw new Error('Release download failed its SHA-256 check.');
}

/**
 * Run a hidden PowerShell script and collect its stdout/stderr for validation or an actionable error.
 * @param script Absolute script file path.
 * @param args Arguments passed after the script path.
 * @param options Optional child-process spawn overrides.
 * @returns A promise resolving to trimmed process output, rejecting on nonzero exit.
 */
function runPowerShell(script, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-File',
        script,
        ...args,
      ],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...options,
      },
    );
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0
        ? resolve(output.trim())
        : reject(new Error(output.trim() || `Updater exited with code ${code}.`)),
    );
  });
}

/**
 * Download and stage an update under the installation directory, validating extracted executable content before shutdown.
 * @param asset Update asset/version metadata.
 * @param target Absolute installation directory containing the executable.
 * @param scriptSource Embedded installer script source.
 * @param onProgress Progress callback for the status bar.
 * @returns A promise containing the staged installer information.
 */
async function prepareUpdate(asset, target, scriptSource, onProgress = () => {}) {
  const updateRoot = path.join(target, `.sniperhunter-update-${crypto.randomUUID()}`);
  const archive = path.join(updateRoot, asset.name);
  const stage = path.join(updateRoot, 'stage');
  const script = path.join(updateRoot, 'updater.ps1');
  fs.mkdirSync(updateRoot);
  fs.writeFileSync(script, scriptSource);
  try {
    await downloadAsset(asset, archive, onProgress);
    onProgress({ phase: 'extracting', bytes: asset.size, total: asset.size });
    const packageRoot = await runPowerShell(script, [
      '-Mode',
      'Prepare',
      '-ArchivePath',
      archive,
      '-StagePath',
      stage,
    ]);
    if (!(packageRoot === stage || packageRoot.startsWith(`${stage}${path.sep}`)))
      throw new Error('The release archive has an invalid folder layout.');
    return { updateRoot, packageRoot, script };
  } catch (error) {
    fs.rmSync(updateRoot, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Start an independent Windows installer and wait for its ready marker before allowing shutdown.
 * @param prepared Staged update paths returned by prepareUpdate.
 * @param target Installation directory to update.
 * @param port Listening port to preserve on relaunch.
 * @param options Optional parentPid and skipLaunch overrides used by tests.
 * @returns A promise resolving only when the installer acknowledges startup; rejects on timeout.
 */
async function startInstaller(prepared, target, port, options = {}) {
  const marker = path.join(prepared.updateRoot, 'helper-started.flag');
  // Start-Process creates an independent Windows process. A Node child with detached:true
  // exited without running PowerShell on the release test machine; a regular child was
  // terminated when its Node parent exited.
  const launcher =
    `$ErrorActionPreference = 'Stop'\n` +
    `$arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $env:SH_UPDATE_SCRIPT + ` +
    `'" -Mode Install -PackageRoot "' + $env:SH_UPDATE_PACKAGE + ` +
    `'" -TargetPath "' + $env:SH_UPDATE_TARGET + ` +
    `'" -UpdatePath "' + $env:SH_UPDATE_ROOT + ` +
    `'" -ParentPid ' + $env:SH_UPDATE_PARENT + ' -Port ' + $env:SH_UPDATE_PORT + $env:SH_UPDATE_TEST\n` +
    `$child = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WindowStyle Hidden -PassThru\n` +
    `Write-Output $child.Id`;
  const encoded = Buffer.from(launcher, 'utf16le').toString('base64');
  const env = {
    ...process.env,
    SH_UPDATE_SCRIPT: prepared.script,
    SH_UPDATE_PACKAGE: prepared.packageRoot,
    SH_UPDATE_TARGET: target,
    SH_UPDATE_ROOT: prepared.updateRoot,
    SH_UPDATE_PARENT: String(options.parentPid ?? process.pid),
    SH_UPDATE_PORT: String(port),
    SH_UPDATE_TEST: options.skipLaunch ? ' -SkipLaunch' : '',
  };
  const launched = await new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      {
        windowsHide: true,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    let errors = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      errors += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0
        ? resolve(output.trim())
        : reject(
            new Error(errors.trim() || output.trim() || 'The update helper could not launch.'),
          ),
    );
  });
  const helperPid = Number(launched);
  if (!Number.isInteger(helperPid) || helperPid <= 0)
    throw new Error(`The update helper did not return a process ID: ${launched || '(empty)'}`);
  for (let attempt = 0; attempt < 80; attempt++) {
    if (fs.existsSync(marker)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    process.kill(helperPid);
  } catch {
    /* the helper already stopped */
  }
  throw new Error(
    'The update helper did not start within eight seconds. Sniper Hunter remains open.',
  );
}

module.exports = { newerVersion, releaseVersion, releaseAsset, prepareUpdate, startInstaller };
