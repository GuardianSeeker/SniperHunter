'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const dns = require('node:dns').promises;
const http = require('node:http');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { DatabaseSync } = require('node:sqlite');
const { Worker } = require('node:worker_threads');
const sea = require('node:sea');

/**
 * Load a backend module from disk in development or from embedded source in the packaged executable.
 * @param name Module filename included in the release asset manifest.
 * @returns The module exports.
 */
function loadServerModule(name) {
  if (!sea.isSea()) return require('./' + name);
  const module = { exports: {} };
  new Function('require', 'module', 'exports', Buffer.from(sea.getAsset(name)).toString('utf8'))(
    require,
    module,
    module.exports,
  );
  return module.exports;
}
const { newerVersion, releaseVersion, releaseAsset, prepareUpdate, startInstaller } =
  loadServerModule('updater.cjs');
const { rebuildPlayerCounts } = loadServerModule('player-cache.cjs');
const { readStatement, clearReadStatements, nextQueuedReplay, sqlResultRows } =
  loadServerModule('database-queries.cjs');
const { format } = require('node:util');
/** Worker entry source is embedded in release builds; eval allows the same worker bootstrap in SEA and development. */
const replayWorkSource = sea.isSea()
  ? Buffer.from(sea.getAsset('replay-work.cjs')).toString('utf8')
  : fs.readFileSync(path.join(__dirname, 'replay-work.cjs'), 'utf8');
/** Trusted worker helper sources, transferred as strings because SEA workers cannot require loose application files. */
const workerModules = Object.fromEntries(
  ['replay-import.cjs', 'map-timeline.cjs', 'player-cache.cjs'].map((name) => [
    name,
    sea.isSea()
      ? Buffer.from(sea.getAsset(name)).toString('utf8')
      : fs.readFileSync(path.join(__dirname, name), 'utf8'),
  ]),
);

/**
 * Run JSON decoding, replay import and timeline extraction on an isolated worker so HTTP requests stay responsive.
 * @param job Worker job describing the action, JSON path and match metadata.
 * @returns A promise resolving to the worker result or rejecting with the worker error.
 */
function runReplayWork(job) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(replayWorkSource, {
      eval: true,
      workerData: {
        job,
        databasePath,
        importSource: workerModules['replay-import.cjs'],
        mapSource: workerModules['map-timeline.cjs'],
        cacheSource: workerModules['player-cache.cjs'],
      },
    });
    let settled = false;
    /**
     * Settle the worker promise once, even if an error is followed by an exit event.
     * @param error Failure to reject with, or null on success.
     * @param result Worker result to resolve on success.
     * @returns Nothing; settles the enclosing promise.
     */
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(result);
    };
    worker.once('message', (message) => {
      if (message.error) {
        const error = new Error(message.error.message);
        error.code = message.error.code;
        finish(error);
      } else finish(null, message.result);
    });
    worker.once('error', (error) => finish(error));
    worker.once('exit', (code) => {
      if (!settled) finish(new Error(`Replay worker exited with code ${code}.`));
    });
  });
}
/** Bounded in-memory log ring shown in Settings; application logs are not persisted to AppData. */
const consoleEntries = [];
/** Monotonic sequence used by browser console polling to request only newer entries. */
let nextConsoleId = 0;
for (const [method, level] of [
  ['log', 'info'],
  ['info', 'info'],
  ['warn', 'warning'],
  ['error', 'error'],
]) {
  const original = console[method].bind(console);
  console[method] = (...args) => {
    consoleEntries.push({
      id: ++nextConsoleId,
      time: new Date().toISOString(),
      level,
      message: format(...args),
    });
    if (consoleEntries.length > 500) consoleEntries.shift();
    if (!sea.isSea()) original(...args);
  };
}
/** Version and repository URL baked into the executable at build time. */
const releaseConfig = JSON.parse(
  sea.isSea()
    ? Buffer.from(sea.getAsset('release-config.json')).toString('utf8')
    : fs.readFileSync(path.join(__dirname, '..', 'release-config.json'), 'utf8'),
);
/** Embedded Windows installer source; materialized only in the portable temporary update directory. */
const updaterScriptSource = sea.isSea()
  ? Buffer.from(sea.getAsset('updater.ps1')).toString('utf8')
  : fs.readFileSync(path.join(__dirname, 'updater.ps1'), 'utf8');

/** URL advertised to the browser, tray and secondary launches after the HTTP port is known. */
let appUrl = 'http://sniperhunter.localhost/';
let listenPort = 80;
/** Installation-specific IPC listener used to prevent duplicate program instances. */
let instanceServer = null;
let instanceReady = false;
/** Secondary launches waiting for the first instance to finish startup. */
const instanceSockets = new Set();
/** Maximum replay/database upload size in bytes (1 GiB); checked both before and during streaming. */
const MAX_UPLOAD = 1024 * 1024 * 1024;
/** Source checkout root in development; portable data paths below use the executable directory in releases. */
const root = path.resolve(__dirname, '..');
/** Angular browser output read from disk only during development. */
const webRoot = path.join(root, 'web', 'dist', 'web', 'browser');
/** Portable data root: beside the executable in production, repository root in development. */
const dataRoot = sea.isSea() ? path.dirname(process.execPath) : root;
/** Short-lived parser output and browser-upload staging directory; original replay files stay in place. */
const readerRoot = path.join(dataRoot, 'reader');
/** Number of operations holding the temporary reader directory open. */
let activeReaderUses = 0;

/**
 * Remove the temporary parser directory only when no reader currently owns it and it is empty.
 * @returns Nothing; pending files are left intact.
 */
function removeEmptyReaderRoot() {
  if (activeReaderUses) return;
  try {
    fs.rmdirSync(readerRoot);
  } catch {
    /* the directory contains a pending replay or reader output */
  }
}
/** Fortnite-owned replay directory; this is an input location, not application storage. */
const demoRoot = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'FortniteGame',
  'Saved',
  'Demos',
);
/** External cosmetic PNG directory; skins are intentionally excluded from the executable. */
const skinRoot = path.join(sea.isSea() ? dataRoot : path.join(root, 'release'), 'skins');
/** Single portable JSON file for settings, saved SQL, maps and update dismissal. */
const configPath = path.join(dataRoot, 'config.json');
/** Legacy single-map path used only by the one-time saved-map migration. */
const mapImagePath = path.join(dataRoot, 'map.png');
/** Portable image copies indexed by saved-map ID; calibrations live in config.json. */
const mapsRoot = path.join(dataRoot, 'maps');
/** Movement for the latest imported replay, kept in memory rather than the database. */
let latestMapTimeline = null;
/** Five-entry LRU of verified timelines keyed by game ID and replay file metadata. */
const restoredMapTimelines = new Map();
/** Shared in-flight parse promises keyed by game ID, preventing duplicate reparses. */
const pendingMapLoads = new Map();
/** Serializes restored-map parser work while allowing HTTP clients to keep browsing. */
let mapLoadTail = Promise.resolve();
/** Enables disk asset refresh and live reload only for an unpackaged development process. */
const devMode = process.env.SNIPER_HUNTER_DEV === '1' && !sea.isSea();
/** External C# parser executable; an environment override supports isolated development/testing. */
const parserExe =
  process.env.SNIPER_HUNTER_PARSER_EXE ||
  path.join(sea.isSea() ? path.dirname(process.execPath) : root, 'SniperHunterParser.exe');
const defaultDatabase = path.join(dataRoot, 'database.db');
/** Active SQLite path; normally adjacent to the executable, with an explicit test/development override. */
const databasePath = process.env.SNIPER_HUNTER_DATABASE || defaultDatabase;
/** Canonical platform group and oldest-to-newest order. Add future replay codes here; users do not edit this mapping. */
const defaultPlatformGroups = [
  { name: 'PC', codes: ['WIN'] },
  { name: 'PlayStation', codes: ['PSN', 'PS5'] },
  { name: 'Xbox', codes: ['XBL', 'XSX'] },
  { name: 'Switch', codes: ['SWT', 'SWT2'] },
  { name: 'Android', codes: ['AND'] },
  { name: 'iOS', codes: ['IOS'] },
];
/** Defaults merged with portable preferences; configured accounts affect comparisons, never replay ownership. */
const defaultSettings = {
  playerIds: [],
  sniperThreshold: 2,
  autoSwitchLastMatch: true,
  hideTrayIcon: false,
  openBrowserOnLaunch: true,
  downloadMissingSkins: true,
  backToTopSide: 'left',
  proxyEnabled: true,
  customCursorEnabled: true,
};

/**
 * Atomically replace portable config.json after writing a complete temporary file beside it.
 * @param value Complete configuration object to serialize.
 * @returns Nothing; throws if persistence fails.
 */
function writeConfig(value) {
  fs.mkdirSync(dataRoot, { recursive: true });
  const temporary = configPath + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, configPath);
}

/**
 * Load portable configuration, migrating legacy JSON files only after the combined config has been saved.
 * @returns The combined configuration object with required defaults.
 */
function loadConfig() {
  let value = {};
  if (fs.existsSync(configPath)) {
    value = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('config.json must contain an object.');
  }
  const legacy = {
    settings: 'settings.json',
    savedQueries: 'saved-queries.json',
    mapCalibration: 'map-calibration.json',
    dismissedUpdate: 'dismissed-update.json',
  };
  const removable = [];
  let changed = !fs.existsSync(configPath);
  for (const [key, name] of Object.entries(legacy)) {
    const file = path.join(dataRoot, name);
    if (!fs.existsSync(file)) continue;
    if (value[key] === undefined) {
      try {
        value[key] = JSON.parse(fs.readFileSync(file, 'utf8'));
        changed = true;
      } catch (error) {
        console.warn(`Could not migrate ${name}; leaving the file in place:`, error.message);
        continue;
      }
    }
    removable.push(file);
  }
  if (value.settings === undefined) {
    value.settings = defaultSettings;
    changed = true;
  }
  if (value.savedQueries === undefined) {
    value.savedQueries = [];
    changed = true;
  }
  if (value.dismissedUpdate === undefined) {
    value.dismissedUpdate = null;
    changed = true;
  }
  if (changed) writeConfig(value);
  for (const file of removable) fs.unlinkSync(file);
  return value;
}
let clientConfig = loadConfig();

/**
 * Persist a shallow configuration patch before publishing it to in-memory readers.
 * @param patch Top-level configuration properties to replace.
 * @returns Nothing; updates clientConfig only after a successful write.
 */
function updateConfig(patch) {
  const updated = { ...clientConfig, ...patch };
  writeConfig(updated);
  clientConfig = updated;
}

/**
 * Read the saved map list, tolerating older configurations without that property.
 * @returns The saved map records, or an empty array.
 */
function maps() {
  return Array.isArray(clientConfig.maps) ? clientConfig.maps : [];
}

/**
 * Resolve the persisted map selection against the current saved map list.
 * @returns The selected map record, or null.
 */
function selectedMap() {
  return maps().find((item) => item.id === clientConfig.selectedMapId) || null;
}

/**
 * Resolve the portable PNG path for a previously validated saved map ID.
 * @param map Saved map record containing its ID.
 * @returns Absolute image path beneath the maps directory.
 */
function mapFile(map) {
  return path.join(mapsRoot, `${map.id}.png`);
}

/**
 * Patch one saved map while retaining the remaining maps and their calibrations.
 * @param id Existing map ID.
 * @param patch Map fields to replace.
 * @returns The updated map, or null when its ID is absent.
 */
function updateMap(id, patch) {
  const items = maps();
  if (!items.some((item) => item.id === id)) return null;
  const updated = items.map((item) => (item.id === id ? { ...item, ...patch } : item));
  updateConfig({ maps: updated });
  return updated.find((item) => item.id === id);
}

/**
 * Convert the legacy single-map image and calibration into the saved-map collection once.
 * @returns Nothing; persists the migrated map and removes the old image after copying it.
 */
function migrateMaps() {
  if (Array.isArray(clientConfig.maps)) return;
  let items = [];
  let selectedMapId = null;
  if (fs.existsSync(mapImagePath)) {
    const id = require('node:crypto').randomUUID();
    fs.mkdirSync(mapsRoot, { recursive: true });
    fs.copyFileSync(mapImagePath, path.join(mapsRoot, `${id}.png`));
    const previous = clientConfig.mapCalibration;
    const calibrated = Array.isArray(previous?.anchors) && previous.anchors.length === 3;
    items = [
      {
        id,
        name: 'Original map',
        rotation: previous?.rotation || 0,
        calibration: calibrated
          ? { anchors: previous.anchors, timeOffsetMs: previous.timeOffsetMs || 0 }
          : null,
      },
    ];
    selectedMapId = id;
  }
  const { mapCalibration, ...other } = clientConfig;
  clientConfig = { ...other, maps: items, selectedMapId };
  writeConfig(clientConfig);
  if (items.length) fs.unlinkSync(mapImagePath);
}
migrateMaps();

/**
 * Validate settings and normalize account IDs without inferring replay ownership from those accounts.
 * @param value Candidate settings object received from config or HTTP.
 * @returns Validated settings with deduplicated IDs; throws for invalid fields.
 */
function normalizeSettings(value) {
  if (!value || typeof value !== 'object') throw new Error('Settings must be an object.');
  const ids = value.playerIds;
  if (
    !Array.isArray(ids) ||
    ids.length > 50 ||
    ids.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id))
  )
    throw new Error(
      'Enter up to 50 player IDs, one per line. IDs may contain letters, numbers, underscores and hyphens.',
    );
  const threshold = Number(value.sniperThreshold);
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 1000)
    throw new Error('Sniper threshold must be a whole number from 1 to 1000.');
  for (const key of [
    'autoSwitchLastMatch',
    'hideTrayIcon',
    'openBrowserOnLaunch',
    'downloadMissingSkins',
    'proxyEnabled',
    'customCursorEnabled',
  ])
    if (typeof value[key] !== 'boolean') throw new Error(`${key} must be on or off.`);
  const backToTopSide = value.backToTopSide ?? 'left';
  if (!['left', 'right'].includes(backToTopSide))
    throw new Error('Back to top button side must be left or right.');
  return {
    playerIds: [...new Set(ids.map((id) => (/^[0-9a-f]{32}$/i.test(id) ? id.toLowerCase() : id)))],
    sniperThreshold: threshold,
    autoSwitchLastMatch: value.autoSwitchLastMatch,
    hideTrayIcon: value.hideTrayIcon,
    openBrowserOnLaunch: value.openBrowserOnLaunch,
    downloadMissingSkins: value.downloadMissingSkins,
    backToTopSide,
    proxyEnabled: value.proxyEnabled,
    customCursorEnabled: value.customCursorEnabled,
  };
}

/**
 * Merge persisted settings with defaults and recover to defaults if validation fails.
 * @returns The normalized settings object.
 */
function loadSettings() {
  try {
    const saved = { ...defaultSettings, ...clientConfig.settings };
    return normalizeSettings(saved);
  } catch (error) {
    console.warn('Using default settings:', error.message);
    return { ...defaultSettings };
  }
}
let settings = loadSettings();
if (JSON.stringify(settings) !== JSON.stringify(clientConfig.settings)) updateConfig({ settings });

/**
 * Save validated settings and invalidate owner-dependent map caches when account IDs change.
 * @param value Complete candidate settings object.
 * @returns Nothing; updates settings after persistence succeeds.
 */
function writeSettings(value) {
  const normalized = normalizeSettings(value);
  updateConfig({ settings: normalized });
  if (JSON.stringify(normalized.playerIds) !== JSON.stringify(settings.playerIds)) {
    latestMapTimeline = null;
    restoredMapTimelines.clear();
  }
  settings = normalized;
}

/**
 * Build the owner predicate shared by encounter queries, using configured accounts only for comparisons.
 * @param column Trusted SQL column expression to compare.
 * @param matchAlias Trusted match-table alias used when no accounts are configured.
 * @returns A SQL predicate; identifiers must come from application code, never raw request text.
 */
function ownPlayerCondition(column, matchAlias = 's') {
  return settings.playerIds.length
    ? `${column} IN (${settings.playerIds.map((id) => `'${id}'`).join(',')})`
    : `(${column} = ${matchAlias}.owner AND LOWER(${matchAlias}.owner) <> 'null' AND ${matchAlias}.owner <> '')`;
}
/** Detected private IPv4 candidates. Multiple adapters may advertise addresses unreachable from a particular client. */
const lanAddresses = [
  ...new Set(
    Object.values(os.networkInterfaces())
      .flat()
      .filter(
        (address) =>
          address &&
          address.family === 'IPv4' &&
          !address.internal &&
          (/^10\./.test(address.address) ||
            /^192\.168\./.test(address.address) ||
            /^172\.(1[6-9]|2\d|3[01])\./.test(address.address)),
      )
      .map((address) => address.address),
  ),
];

/**
 * Format the detected private IPv4 addresses using the active listening port.
 * @returns Candidate LAN URLs; routing availability depends on the local network.
 */
function lanUrls() {
  return lanAddresses.map(
    (address) => `http://${address}${listenPort === 80 ? '' : `:${listenPort}`}/`,
  );
}
/** Recent watcher/import outcomes used to build progress-bar messages across all active tabs. */
const activity = {
  watcherError: null,
  activeBatchId: null,
  batchDoneAt: 0,
  detectedAt: 0,
  detectedName: '',
  addedAt: 0,
  addedName: '',
  addedSource: '',
  duplicateAt: 0,
  duplicateName: '',
  failedAt: 0,
  failedName: '',
  failedReason: '',
  failedSource: '',
};
/** Persisted retry marker for a watcher file Fortnite may still be writing. */
const REPLAY_WAITING_MESSAGE = 'Waiting for Fortnite to finish writing this replay.';
/** Persisted failure marker that allows a later file change to restart parsing. */
const REPLAY_CORRUPT_MESSAGE = 'Replay appears corrupted';
/** A zero-byte replay that remained unchanged long enough to be treated as corrupt. */
const REPLAY_EMPTY_MESSAGE = 'Replay file remained empty; it may be corrupt.';

/**
 * Identify a transient SQLite writer lock without treating it as replay corruption.
 * @param error Error reported by the Node SQLite connection or replay worker.
 * @returns Whether another database writer currently owns the lock.
 */
function isDatabaseBusy(error) {
  return (
    error?.errcode === 5 || /database is locked|SQLITE_BUSY/i.test(String(error?.message || error))
  );
}

/**
 * Parse the optional port override and reject unknown or repeated launch arguments.
 * @param args Command-line arguments after the script/executable name.
 * @returns A valid TCP port, defaulting to 80.
 */
function parsePort(args) {
  let port = 80;
  let specified = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--no-browser') continue;
    if (argument === '-port' || argument === '--port') {
      if (specified || index + 1 >= args.length)
        throw new Error('Use -port followed by a number from 1 to 65535.');
      const value = args[++index];
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)
        throw new Error('Use -port followed by a number from 1 to 65535.');
      port = Number(value);
      specified = true;
      continue;
    }
    throw new Error(`Unknown launch parameter: ${argument}`);
  }
  return port;
}

/**
 * Open a URL through the Windows default-browser association without retaining a child console.
 * @param url URL to open.
 * @returns Nothing; starts a detached browser launcher.
 */
function openBrowser(url) {
  const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  browser.unref();
}

/**
 * Reply to waiting secondary launches once this instance has a usable listening URL.
 * @returns Nothing; ends pending IPC sockets with the app URL.
 */
function sendInstanceUrl() {
  if (!instanceReady) return;
  for (const socket of instanceSockets) socket.end(`${appUrl}\n`);
}

/**
 * Claim the installation-specific Windows named pipe or discover the already-running instance.
 * @returns A promise containing the existing instance URL, or null when this process owns the instance.
 */
async function claimInstance() {
  if (process.platform !== 'win32') return null;
  const key = require('node:crypto')
    .createHash('sha256')
    .update(dataRoot.toLowerCase())
    .digest('hex')
    .slice(0, 32);
  const pipe = `\\\\.\\pipe\\sniperhunter-${key}`;
  const server = net.createServer((socket) => {
    instanceSockets.add(socket);
    socket.on('close', () => instanceSockets.delete(socket));
    socket.on('error', () => instanceSockets.delete(socket));
    sendInstanceUrl();
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(pipe, resolve);
    });
    instanceServer = server;
    return null;
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
  }
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe);
    let answer = '';
    socket.setTimeout(30000, () =>
      socket.destroy(new Error('The running Sniper Hunter instance did not respond.')),
    );
    socket.on('data', (chunk) => {
      answer += chunk.toString('utf8');
    });
    socket.once('error', reject);
    socket.once('end', () => {
      try {
        const url = new URL(answer.trim());
        if (
          url.protocol !== 'http:' ||
          !['sniperhunter.localhost', 'localhost'].includes(url.hostname)
        )
          throw new Error('The running instance returned an invalid URL.');
        resolve(url.href);
      } catch (error) {
        reject(error);
      }
    });
  });
}

/**
 * Report a startup failure to both the captured console and a Windows message box.
 * @param message User-facing error text.
 * @returns Nothing.
 */
function showError(message) {
  console.error(message);
  if (process.platform === 'win32') {
    spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show($env:SNIPER_HUNTER_ERROR, 'Sniper Hunter') | Out-Null",
      ],
      { windowsHide: true, env: { ...process.env, SNIPER_HUNTER_ERROR: message } },
    );
  }
}

/**
 * Check whether the current Windows token has administrator privileges.
 * @returns True only when the Windows role check succeeds.
 */
function checkAdministrator() {
  if (process.platform !== 'win32') return false;
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  return result.status === 0 && result.stdout.trim().toLowerCase() === 'true';
}

/**
 * Find the .NET 10 core runtime required by the external parser, distinguishing it from ASP.NET alone.
 * @returns An installation result and, on failure, an actionable message.
 */
function checkDotnet10() {
  const candidates = [
    ...new Set(
      [
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'dotnet', 'dotnet.exe'),
        process.env.DOTNET_ROOT && path.join(process.env.DOTNET_ROOT, 'dotnet.exe'),
        'dotnet',
      ].filter(Boolean),
    ),
  ];
  const available = [];
  for (const command of candidates) {
    const result = spawnSync(command, ['--list-runtimes'], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) continue;
    available.push(result.stdout);
    if (/^Microsoft\.NETCore\.App\s+10\./m.test(result.stdout)) return { installed: true };
  }
  const aspNetInstalled = available.some((output) =>
    /^Microsoft\.AspNetCore\.App\s+10\./m.test(output),
  );
  return {
    installed: false,
    message: aspNetInstalled
      ? 'ASP.NET Core Runtime 10 is installed, but .NET Runtime 10 (Microsoft.NETCore.App) is missing. Install .NET Runtime 10 x64, then restart the terminal.'
      : '.NET Runtime 10 (Microsoft.NETCore.App) was not found. Install .NET Runtime 10 x64, then restart the terminal.',
  };
}

/**
 * Prefer sniperhunter.localhost, but use localhost when its hosts entry cannot be configured.
 * @returns The safe loopback hostname to advertise and open in the browser.
 */
async function ensureHostname() {
  const hostsPath = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'drivers',
    'etc',
    'hosts',
  );
  let lines = [];
  try {
    lines = fs.readFileSync(hostsPath, 'utf8').split(/\r?\n/);
  } catch (error) {
    console.warn('Could not inspect the hosts file; using localhost.', error);
    return 'localhost';
  }
  const mappings = lines
    .map((line) => line.split('#', 1)[0].trim().split(/\s+/))
    .filter((parts) =>
      parts.slice(1).some((alias) => alias.toLowerCase() === 'sniperhunter.localhost'),
    );
  if (mappings.some((parts) => !['127.0.0.1', '::1'].includes(parts[0]))) {
    console.warn('sniperhunter.localhost points outside this computer; using localhost.');
    return 'localhost';
  }
  let addresses = [];
  try {
    addresses = await dns.lookup('sniperhunter.localhost', { all: true });
  } catch {
    /* try hosts fallback */
  }
  if (
    addresses.length &&
    addresses.every((item) => item.address === '127.0.0.1' || item.address === '::1') &&
    addresses.some((item) => item.address === '127.0.0.1')
  )
    return 'sniperhunter.localhost';
  if (addresses.some((item) => item.address !== '127.0.0.1' && item.address !== '::1')) {
    console.warn('sniperhunter.localhost resolves outside this computer; using localhost.');
    return 'localhost';
  }
  if (checkAdministrator() && !mappings.some((parts) => parts[0] === '127.0.0.1')) {
    try {
      fs.appendFileSync(hostsPath, '\r\n127.0.0.1 sniperhunter.localhost # Sniper Hunter\r\n');
      addresses = await dns.lookup('sniperhunter.localhost', { all: true });
      if (addresses.some((item) => item.address === '127.0.0.1')) return 'sniperhunter.localhost';
    } catch (error) {
      console.warn('Could not configure sniperhunter.localhost; using localhost.', error);
    }
  }
  console.warn('sniperhunter.localhost is unavailable; using localhost without elevation.');
  return 'localhost';
}

/**
 * Load embedded release resources or the complete development browser build, excluding external skins.
 * @returns A map from URL paths to asset buffers.
 */
function loadAssets() {
  const assets = new Map();
  if (sea.isSea()) {
    for (const key of sea.getAssetKeys()) assets.set('/' + key, Buffer.from(sea.getAsset(key)));
  } else {
    if (!fs.existsSync(path.join(webRoot, 'index.html')))
      throw new Error('Angular build missing. Run npm run build first.');

    /**
     * Collect browser assets recursively into the enclosing asset map.
     * @param dir Current browser-build directory.
     * @returns Nothing; adds non-skin files to assets.
     */
    function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(absolute);
        else {
          const key = '/' + path.relative(webRoot, absolute).replaceAll('\\', '/');
          if (!key.startsWith('/assets/skins/')) assets.set(key, fs.readFileSync(absolute));
        }
      }
    }
    walk(webRoot);
  }
  if (!assets.has('/index.html')) throw new Error('Angular index.html is missing.');
  return assets;
}

/**
 * Check that every required application table and column can be read before opening the database for writes.
 * @param file Database file to inspect read-only.
 * @returns Nothing; throws if required schema or table reads fail.
 */
function validateExistingDatabase(file) {
  /** Required legacy application tables and columns; auxiliary cache tables are recreated separately. */
  const expected = {
    GameEliminations: ['id', 'gameID', 'time', 'killerID', 'killedID', 'knocked', 'weapon'],
    GamePlayers: ['id', 'playerID', 'gameID', 'isBot', 'team', 'kills', 'placement'],
    GameStats: [
      'gameID',
      'owner',
      'timestamp',
      'replayName',
      'mode',
      'bots',
      'players',
      'duration',
      'placement',
      'kills',
      'assists',
      'accuracy',
      'damageDealt',
      'damageTaken',
      'distanceTravelled',
    ],
    Players: ['playerID', 'username', 'isBot', 'platform', 'skin', 'snipes'],
  };
  const existing = new DatabaseSync(file, { readOnly: true });
  try {
    for (const [table, columns] of Object.entries(expected)) {
      const actual = new Set(
        existing
          .prepare(`PRAGMA table_info("${table}")`)
          .all()
          .map((row) => row.name),
      );
      for (const column of columns)
        if (!actual.has(column)) throw new Error(`${table}.${column} is missing.`);
      existing.prepare(`SELECT 1 FROM "${table}" LIMIT 1`).get();
    }
  } finally {
    existing.close();
  }
}

/**
 * Ask through the native Windows prompt whether an unusable database may be replaced.
 * @param reason Validation failure to explain to the user.
 * @returns True only when the user chooses to start fresh.
 */
function offerFreshDatabase(reason) {
  const prompt = `The Sniper Hunter database is corrupted or is missing required tables or columns.\n\n${reason}\n\nStart with a fresh blank database? The current database will be moved to a .corrupt backup beside it.`;
  const answer = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show($env:SNIPER_HUNTER_DATABASE_ERROR, 'Sniper Hunter database recovery', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Warning)",
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, SNIPER_HUNTER_DATABASE_ERROR: prompt },
    },
  );
  return answer.status === 0 && answer.stdout.trim() === 'Yes';
}

/**
 * Move an unusable database and its SQLite sidecars to timestamped backup paths.
 * @param file Database file being replaced after explicit user confirmation.
 * @returns Nothing; preserves the original files under backup names.
 */
function backupCorruptDatabase(file) {
  const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.renameSync(file, backup);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(file + suffix)) fs.renameSync(file + suffix, backup + suffix);
  }
  console.warn(`Invalid database moved to ${backup}`);
}

/**
 * Open the portable database, create required tables/indexes and migrate compatible legacy structures.
 * @returns The initialized writable SQLite connection.
 */
function openDatabase() {
  if (fs.existsSync(databasePath)) {
    try {
      validateExistingDatabase(databasePath);
    } catch (error) {
      if (!offerFreshDatabase(error.message))
        throw new Error(
          `Database is corrupted or incomplete: ${error.message} A fresh database was not created.`,
        );
      backupCorruptDatabase(databasePath);
    }
  }
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS GameEliminations (id INTEGER PRIMARY KEY AUTOINCREMENT, gameID VARCHAR(255) NOT NULL, time INTEGER NOT NULL, killerID VARCHAR(255) NOT NULL, killedID VARCHAR(255) NOT NULL, knocked TINYINT(1) NOT NULL, weapon VARCHAR(255) NOT NULL);
    CREATE TABLE IF NOT EXISTS GamePlayers (id INTEGER PRIMARY KEY AUTOINCREMENT, playerID VARCHAR(255) NOT NULL, gameID VARCHAR(255) NOT NULL, isBot TINYINT(1) NOT NULL, team INTEGER NOT NULL, kills INTEGER NOT NULL DEFAULT 0, placement INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS GameStats (gameID VARCHAR(255) NOT NULL UNIQUE PRIMARY KEY, owner VARCHAR(255) NOT NULL, timestamp DATETIME NOT NULL UNIQUE, replayName VARCHAR(255) NOT NULL, mode VARCHAR(255) NOT NULL, bots INTEGER NOT NULL, players INTEGER NOT NULL, duration INTEGER DEFAULT -1, placement INTEGER NOT NULL, kills INTEGER DEFAULT -1, assists INTEGER DEFAULT 0, accuracy DOUBLE PRECISION DEFAULT -1, damageDealt INTEGER DEFAULT -1, damageTaken INTEGER DEFAULT -1, distanceTravelled DOUBLE PRECISION DEFAULT -1);
    CREATE TABLE IF NOT EXISTS Players (playerID VARCHAR(255) NOT NULL UNIQUE PRIMARY KEY, username VARCHAR(255) NOT NULL, isBot VARCHAR(255) NOT NULL, platform VARCHAR(255), skin VARCHAR(255), snipes INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS ReplayImports (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, addedAt TEXT NOT NULL,
      size INTEGER NOT NULL, error TEXT, batchID TEXT, source TEXT NOT NULL DEFAULT 'upload', sourcePath TEXT);
    CREATE TABLE IF NOT EXISTS ReplayBatches (id TEXT PRIMARY KEY, total INTEGER NOT NULL, addedAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS PlayerCounts (playerID TEXT PRIMARY KEY, games INTEGER NOT NULL, kills INTEGER NOT NULL, isBot INTEGER NOT NULL,
      username TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL DEFAULT '', platformCode TEXT NOT NULL DEFAULT '',
      skin TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'Other', isAI INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS PlayerPlatformCounts (category TEXT NOT NULL, code TEXT NOT NULL, players INTEGER NOT NULL,
      PRIMARY KEY (category, code));
    CREATE TABLE IF NOT EXISTS PlayerCacheMeta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
    CREATE VIRTUAL TABLE IF NOT EXISTS PlayerSearch USING fts5(playerID, username, platform, skin, tokenize='trigram', content='', columnsize=0);
    CREATE INDEX IF NOT EXISTS IX_GamePlayers_gameID ON GamePlayers (gameID);
    CREATE INDEX IF NOT EXISTS IX_GamePlayers_playerID_gameID ON GamePlayers (playerID, gameID);
    CREATE INDEX IF NOT EXISTS IX_GameEliminations_gameID ON GameEliminations (gameID);
    CREATE INDEX IF NOT EXISTS IX_GameEliminations_killedID ON GameEliminations (killedID);
    CREATE INDEX IF NOT EXISTS IX_GameEliminations_killerID ON GameEliminations (killerID);
  `);
  // The older composite indexes repeated long game IDs for every elimination.
  // The profile and match queries filter by one ID; the smaller indexes cover that lookup.
  let compacted = false;
  for (const name of [
    'IX_GameEliminations_gameID_time',
    'IX_GameEliminations_killedID_gameID',
    'IX_GameEliminations_killerID_gameID',
  ]) {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name)) {
      db.exec(`DROP INDEX ${name}`);
      compacted = true;
    }
  }
  const searchSql =
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'PlayerSearch'").get()
      ?.sql || '';
  if (!/content\s*=\s*''/i.test(searchSql) || !/columnsize\s*=\s*0/i.test(searchSql)) {
    db.exec('DROP TABLE PlayerSearch');
    db.exec(
      "CREATE VIRTUAL TABLE PlayerSearch USING fts5(playerID, username, platform, skin, tokenize='trigram', content='', columnsize=0)",
    );
    db.prepare("DELETE FROM PlayerCacheMeta WHERE key = 'sourceRows'").run();
    compacted = true;
  }
  const replayColumns = new Set(
    db
      .prepare('PRAGMA table_info(ReplayImports)')
      .all()
      .map((row) => row.name),
  );
  for (const [name, type] of [
    ['error', 'TEXT'],
    ['batchID', 'TEXT'],
    ['source', "TEXT NOT NULL DEFAULT 'upload'"],
    ['sourcePath', 'TEXT'],
  ])
    if (!replayColumns.has(name)) db.exec(`ALTER TABLE ReplayImports ADD COLUMN ${name} ${type}`);
  const columns = new Set(
    db
      .prepare('PRAGMA table_info(PlayerCounts)')
      .all()
      .map((row) => row.name),
  );
  for (const [name, type, fallback] of [
    ['username', 'TEXT', "''"],
    ['platform', 'TEXT', "''"],
    ['platformCode', 'TEXT', "''"],
    ['skin', 'TEXT', "''"],
    ['category', 'TEXT', "'Other'"],
    ['isAI', 'INTEGER', '0'],
  ])
    if (!columns.has(name))
      db.exec(`ALTER TABLE PlayerCounts ADD COLUMN ${name} ${type} NOT NULL DEFAULT ${fallback}`);
  db.exec(`
    CREATE INDEX IF NOT EXISTS IX_PlayerCounts_games ON PlayerCounts (games DESC, playerID DESC);
    CREATE INDEX IF NOT EXISTS IX_PlayerCounts_username ON PlayerCounts (username COLLATE NOCASE, playerID);
    CREATE INDEX IF NOT EXISTS IX_PlayerCounts_skin ON PlayerCounts (skin COLLATE NOCASE, playerID);
    CREATE INDEX IF NOT EXISTS IX_PlayerCounts_category_games ON PlayerCounts (category, games DESC, playerID DESC);
    CREATE INDEX IF NOT EXISTS IX_PlayerCounts_platformCode ON PlayerCounts (platformCode, games DESC, playerID DESC);
  `);
  const sourceRows = db.prepare('SELECT COUNT(*) AS total FROM GamePlayers').get().total;
  const sourcePlayers = db.prepare('SELECT COUNT(*) AS total FROM Players').get().total;
  if (
    db.prepare("SELECT value FROM PlayerCacheMeta WHERE key = 'sourceRows'").get()?.value !==
      sourceRows ||
    db.prepare("SELECT value FROM PlayerCacheMeta WHERE key = 'sourcePlayers'").get()?.value !==
      sourcePlayers
  )
    rebuildPlayerCounts(db);
  // Reclaim the dropped index and duplicate search-table pages once, during migration.
  if (compacted) db.exec('VACUUM');
  return db;
}

/**
 * Create a serial, deduplicated skin-download queue shared by startup scans and replay imports.
 * @param db Connection used to enumerate skins already referenced by players.
 * @returns Queue and scan operations that retain their own pending-download state.
 */
function createSkinSync(db) {
  fs.mkdirSync(skinRoot, { recursive: true });
  const pending = [];
  const seen = new Set();
  let running = false;
  /**
   * Accept only safe cosmetic IDs and exclude the bundled fallback images from API downloads.
   * @param id Candidate skin ID.
   * @returns True when it identifies a downloadable skin.
   */
  const validId = (id) =>
    typeof id === 'string' &&
    /^[A-Za-z0-9_-]{1,128}$/.test(id) &&
    !['epic', 'sniper'].includes(id.toLowerCase());
  /**
   * Resolve a validated skin ID inside the portable skin folder.
   * @param id Validated cosmetic ID.
   * @returns Absolute PNG path.
   */
  const skinFile = (id) => path.join(skinRoot, `${id}.png`);

  /**
   * Download a missing cosmetic icon once, saving it beside the executable and logging recoverable failures.
   * @param id Validated cosmetic ID.
   * @returns A promise that completes after the download attempt.
   */
  async function download(id) {
    const info = await fetch(`https://fortnite-api.com/v2/cosmetics/br/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!info.ok) throw new Error(`cosmetic lookup returned ${info.status}`);
    const icon = (await info.json()).data?.images?.smallIcon;
    if (typeof icon !== 'string') throw new Error('cosmetic has no small icon');
    const iconUrl = new URL(icon);
    if (iconUrl.protocol !== 'https:' || iconUrl.hostname !== 'fortnite-api.com')
      throw new Error('cosmetic icon URL is not on fortnite-api.com');
    const response = await fetch(iconUrl, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`icon download returned ${response.status}`);
    if (Number(response.headers.get('content-length')) > 2 * 1024 * 1024)
      throw new Error('cosmetic icon exceeds 2 MB');
    const body = Buffer.from(await response.arrayBuffer());
    if (
      body.length > 2 * 1024 * 1024 ||
      body.length < 8 ||
      !body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new Error('cosmetic icon is not a PNG under 2 MB');
    const temporary = skinFile(id) + '.tmp';
    try {
      fs.writeFileSync(temporary, body);
      fs.renameSync(temporary, skinFile(id));
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    console.log(`Downloaded missing skin: ${id}`);
  }

  /**
   * Consume ready work sequentially while guarding against overlapping queue drains.
   * @returns A promise that resolves when the queue is empty or no more work is ready.
   */
  async function drain() {
    if (running) return;
    running = true;
    try {
      while (pending.length) {
        const id = pending.shift();
        try {
          await download(id);
        } catch (error) {
          console.warn(`Could not download skin ${id}: ${error.message}`);
        }
      }
    } finally {
      running = false;
    }
  }

  /**
   * Schedule a missing skin only when downloads are enabled and it is not already present or queued.
   * @param id Candidate cosmetic ID from replay/database data.
   * @returns Nothing; wakes the serial downloader if needed.
   */
  function queue(id) {
    if (
      !settings.downloadMissingSkins ||
      !validId(id) ||
      fs.existsSync(skinFile(id)) ||
      seen.has(id)
    )
      return;
    seen.add(id);
    pending.push(id);
    void drain();
  }

  /**
   * Queue distinct missing skins directly from the database cursor.
   * @returns Nothing; avoids materializing the full player table.
   */
  function scanDatabase() {
    for (const row of db
      .prepare("SELECT DISTINCT skin FROM Players WHERE skin IS NOT NULL AND TRIM(skin) <> ''")
      .iterate())
      queue(row.skin);
  }

  /**
   * Find cosmetic identifiers in a decoded replay and enqueue missing icons.
   * @param value Decoded replay object to traverse.
   * @returns Nothing; submits unique valid skin IDs.
   */
  function scanReplay(value) {
    if (Array.isArray(value.PlayerData)) {
      for (const player of value.PlayerData) queue(player?.Cosmetics?.Character);
      return;
    }
    const stack = [value];
    while (stack.length) {
      const current = stack.pop();
      if (!current || typeof current !== 'object') continue;
      if (Array.isArray(current)) {
        for (const item of current) stack.push(item);
        continue;
      }
      if (current.Character && typeof current.Character === 'object') queue(current.Character.name);
      for (const [key, nested] of Object.entries(current)) {
        if (key === 'skin' && typeof nested === 'string') queue(nested);
        else if (nested && typeof nested === 'object') stack.push(nested);
      }
    }
  }

  return { queue, scanDatabase, scanReplay, skinFile };
}

/**
 * Send an HTTP JSON response with explicit UTF-8 content type and content length.
 * @param res HTTP response to finish.
 * @param status HTTP status code.
 * @param value JSON-serializable response body.
 * @returns Nothing; ends the response.
 */
function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/**
 * Recognize loopback and private IPv4 peers, including IPv4-mapped IPv6 addresses.
 * @param address Remote socket address, or an empty string when unavailable.
 * @returns Whether the peer is on a local/private address.
 */
function isPrivateClient(address = '') {
  const ip = address.replace(/^::ffff:/i, '');
  return (
    ip === '::1' ||
    /^127\./.test(ip) ||
    /^10\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^169\.254\./.test(ip)
  );
}

/**
 * Fetch GitHub release metadata and compare its numeric version with the baked-in version.
 * @returns A promise containing update availability, configuration state and any recoverable error.
 */
async function checkForUpdate() {
  const base = String(releaseConfig.githubRepositoryUrl || '')
    .trim()
    .replace(/\/$/, '');
  const currentVersion = String(releaseConfig.version || '4.0');
  if (!base) return { currentVersion, configured: false, update: null };
  try {
    const repository = new URL(base);
    const segments = repository.pathname.split('/').filter(Boolean);
    if (
      repository.protocol !== 'https:' ||
      repository.hostname !== 'github.com' ||
      segments.length !== 2
    )
      throw new Error(
        'githubRepositoryUrl must be a GitHub repository URL, such as https://github.com/owner/repo.',
      );
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(segments[0])}/${encodeURIComponent(segments[1])}/releases/latest`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `SniperHunter/${currentVersion}`,
        },
        signal: AbortSignal.timeout(10000),
      },
    );
    if (response.status === 404) return { currentVersion, configured: true, update: null };
    if (!response.ok) throw new Error(`GitHub release check returned ${response.status}.`);
    const latest = await response.json();
    const version = releaseVersion(latest);
    if (!version || !newerVersion(version, currentVersion))
      return { currentVersion, configured: true, update: null };
    const page = new URL(latest.html_url);
    if (
      page.protocol !== 'https:' ||
      page.hostname !== 'github.com' ||
      !page.pathname.startsWith(`/${segments[0]}/${segments[1]}/releases/`)
    )
      throw new Error('GitHub returned an unexpected release URL.');
    const dismissed = clientConfig.dismissedUpdate?.version || '';
    return {
      currentVersion,
      configured: true,
      dismissed: dismissed === version,
      update: {
        version,
        url: page.href,
        notes: String(latest.body || '').slice(0, 30000),
        asset: releaseAsset(latest, version, segments[0], segments[1]),
      },
    };
  } catch (error) {
    console.warn('Update check failed:', error.message);
    return { currentVersion, configured: true, update: null, error: error.message };
  }
}

/**
 * Read a bounded JSON request body before parsing it.
 * @param req Incoming HTTP request stream.
 * @returns A promise resolving to parsed JSON; rejects oversized or invalid bodies.
 */
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('Request exceeds 1 MB.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Read saved SQL snippets from portable configuration.
 * @returns The saved-query array, or an empty array for older config files.
 */
function savedQueries() {
  const value = clientConfig.savedQueries;
  return Array.isArray(value) ? value : [];
}

/**
 * Persist the full saved-query collection in the shared configuration file.
 * @param value Replacement list of named SQL queries.
 * @returns Nothing.
 */
function writeSavedQueries(value) {
  updateConfig({ savedQueries: value });
}

/**
 * Assemble match players, teams, repeat opponents and chronologically ordered eliminations.
 * @param db Open database connection.
 * @param match GameStats row for the requested match.
 * @returns Match detail payload, or null if no match was supplied.
 */
function matchDetails(db, match) {
  const platforms = readStatement(
    db,
    `
    SELECT COALESCE(NULLIF(TRIM(p.platform), ''), 'Unknown') AS platform, COUNT(*) AS players
    FROM GamePlayers AS gp
    LEFT JOIN Players AS p ON p.playerID = gp.playerID
    WHERE gp.gameID = ? AND gp.isBot = 0
    GROUP BY COALESCE(NULLIF(TRIM(p.platform), ''), 'Unknown')
    ORDER BY players DESC, platform
  `,
  ).all(match.gameID);
  const eliminations = readStatement(
    db,
    `
    SELECT e.id, CAST(e.time AS INTEGER) AS time, e.killerID, e.killedID, e.knocked, e.weapon,
      COALESCE(NULLIF(k.username, ''), e.killerID) AS killerName,
      COALESCE(NULLIF(v.username, ''), e.killedID) AS killedName,
      k.skin AS killerSkin, v.skin AS killedSkin,
      k.platform AS killerPlatform, v.platform AS killedPlatform,
      CASE WHEN LOWER(e.killerID) = 'bot' THEN 1
        ELSE COALESCE(kg.isBot, CAST(k.isBot AS INTEGER), 0) END AS killerBot,
      CASE WHEN LOWER(e.killedID) = 'bot' THEN 1
        ELSE COALESCE(vg.isBot, CAST(v.isBot AS INTEGER), 0) END AS killedBot
    FROM GameEliminations AS e
    LEFT JOIN Players AS k ON k.playerID = e.killerID
    LEFT JOIN Players AS v ON v.playerID = e.killedID
    LEFT JOIN GamePlayers AS kg ON kg.gameID = e.gameID AND kg.playerID = e.killerID
    LEFT JOIN GamePlayers AS vg ON vg.gameID = e.gameID AND vg.playerID = e.killedID
    WHERE e.gameID = ?
    ORDER BY CAST(e.time AS INTEGER), e.id
  `,
  ).all(match.gameID);
  const deaths = new Map(
    readStatement(
      db,
      `SELECT killedID, COUNT(*) AS deaths FROM GameEliminations
    WHERE gameID = ? AND CAST(knocked AS INTEGER) = 0 GROUP BY killedID`,
    )
      .all(match.gameID)
      .map((row) => [row.killedID, row.deaths]),
  );
  const members = readStatement(
    db,
    `
    SELECT gp.team, gp.placement, gp.kills, gp.playerID, gp.isBot,
      COALESCE(NULLIF(p.username, ''), gp.playerID) AS username,
      p.skin, p.platform, COALESCE(c.games, 0) AS games
    FROM GamePlayers AS gp LEFT JOIN Players AS p ON p.playerID = gp.playerID
    LEFT JOIN PlayerCounts AS c ON c.playerID = gp.playerID
    WHERE gp.gameID = ? ORDER BY gp.team, gp.kills DESC, username
  `,
  ).all(match.gameID);
  const byTeam = new Map();
  for (const member of members) {
    if (!byTeam.has(member.team))
      byTeam.set(member.team, {
        team: member.team,
        placement: member.placement,
        kills: 0,
        deaths: 0,
        members: [],
      });
    const team = byTeam.get(member.team);
    member.deaths = deaths.get(member.playerID) || 0;
    team.placement = Math.min(team.placement, member.placement);
    team.kills += member.kills;
    team.deaths += member.deaths;
    team.members.push(member);
  }
  const ownIds = settings.playerIds.length ? settings.playerIds : [match.owner];
  const snipers = members
    .filter(
      (member) =>
        Number(member.isBot) === 0 &&
        !ownIds.includes(member.playerID) &&
        member.games >= settings.sniperThreshold,
    )
    .sort((a, b) => b.games - a.games || a.username.localeCompare(b.username));
  return { match, platforms, eliminations, teams: [...byTeam.values()], snipers };
}

/**
 * Normalize a search value and escape SQL LIKE wildcard characters.
 * @param value Raw search value.
 * @returns An escaped search string suitable for a bound LIKE parameter.
 */
function searchTerm(value) {
  return `%${String(value || '')
    .slice(0, 100)
    .replace(/[\\%_]/g, '\\$&')}%`;
}

/**
 * Choose a fixed SQL direction for game lists and replay neighbors.
 * @param {URL} requestUrl Parsed URL containing the optional direction filter.
 * @returns {'ASC'|'DESC'} Safe SQL keyword, defaulting to newest first.
 */
function gameDirection(requestUrl) {
  return requestUrl.searchParams.get('direction') === 'asc' ? 'ASC' : 'DESC';
}

/**
 * Build shared search/date/placement/kind predicates with bound values for match list and metric queries.
 * @param requestUrl Parsed request URL containing filter parameters.
 * @param prefix Trusted SQL alias prefix for match columns.
 * @param options skipPlacement/skipKind flags for callers that supply those predicates themselves.
 * @returns A WHERE clause and ordered bindings, or an error when a filter is invalid.
 */
function matchFilters(requestUrl, prefix = '', options = {}) {
  const query = (requestUrl.searchParams.get('q') || '').slice(0, 100);
  const after = requestUrl.searchParams.get('after') || '';
  const before = requestUrl.searchParams.get('before') || '';
  const placement = requestUrl.searchParams.get('placement') || '';
  const kind = requestUrl.searchParams.get('kind') || '';
  if (
    (after && !Number.isFinite(Date.parse(after))) ||
    (before && !Number.isFinite(Date.parse(before))) ||
    (after && before && after >= before)
  )
    return { error: 'Choose a valid date range.' };
  if (placement && !/^\d{1,5}$/.test(placement))
    return { error: 'Placement must be a whole number.' };
  if (kind && !['creative', 'noncreative', 'won'].includes(kind))
    return { error: 'Invalid game filter.' };
  const clauses = [];
  const args = [];
  if (query) {
    const pattern = searchTerm(query);
    clauses.push(`(${prefix}gameID LIKE ? ESCAPE '\\' OR ${prefix}replayName LIKE ? ESCAPE '\\'
      OR ${prefix}mode LIKE ? ESCAPE '\\')`);
    args.push(pattern, pattern, pattern);
  }
  if (after) {
    clauses.push(`${prefix}timestamp >= ?`);
    args.push(after);
  }
  if (before) {
    clauses.push(`${prefix}timestamp < ?`);
    args.push(before);
  }
  if (placement && !options.skipPlacement) {
    clauses.push(`${prefix}placement = ?`);
    args.push(Number(placement));
  }
  if (kind && !options.skipKind) {
    clauses.push(
      kind === 'creative'
        ? `LOWER(${prefix}mode) LIKE '%creative%'`
        : kind === 'noncreative'
          ? `LOWER(${prefix}mode) NOT LIKE '%creative%'`
          : `${prefix}placement = 1`,
    );
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', args };
}

/**
 * Extend match filters with player membership and selected encounter-event predicates.
 * @param requestUrl URL containing game and encounter filters.
 * @param playerID Player account ID whose shared matches are requested.
 * @returns The combined conditions and bindings for profile queries.
 */
function playerGameFilters(requestUrl, playerID) {
  const filters = matchFilters(requestUrl, 's.', { skipPlacement: true });
  if (filters.error) return filters;
  const event = requestUrl.searchParams.get('event') || 'all';
  if (!['all', 'you', 'them', 'trolled'].includes(event)) return { error: 'Invalid event filter.' };
  const placement = requestUrl.searchParams.get('placement');
  const placementValue = placement ? Number(placement) : null;
  const extra = filters.where ? ` AND ${filters.where.slice(6)}` : '';
  const teammates = `EXISTS (SELECT 1 FROM GamePlayers ownerGp
    JOIN GamePlayers targetGp ON targetGp.gameID = ownerGp.gameID AND targetGp.team = ownerGp.team
    WHERE ownerGp.gameID = e.gameID AND ${ownPlayerCondition('ownerGp.playerID')}
      AND targetGp.playerID = ? AND ownerGp.team > 0)`;
  const eventFilter =
    event === 'all'
      ? ''
      : ` AND s.gameID IN (SELECT e.gameID FROM GameEliminations e
    JOIN GameStats eventStats ON eventStats.gameID = e.gameID
    WHERE e.${event === 'you' ? 'killedID' : 'killerID'} = ?
      AND ${event === 'you' ? ownPlayerCondition('e.killerID', 'eventStats') : ownPlayerCondition('e.killedID', 'eventStats')}
      AND ${event === 'trolled' ? teammates : `NOT ${teammates}`})`;
  return {
    where: `gp.playerID = ?${extra}${placementValue === null ? '' : ' AND gp.placement = ?'}${event !== 'all' && settings.playerIds.includes(playerID) ? ' AND 0' : eventFilter}`,
    args: [
      playerID,
      ...filters.args,
      ...(placementValue === null ? [] : [placementValue]),
      ...(event === 'all' || settings.playerIds.includes(playerID) ? [] : [playerID, playerID]),
    ],
  };
}

/**
 * Import only compatible columns from another SQLite database inside a transaction.
 * @param db Writable destination connection.
 * @param source Source database path to attach for import.
 * @returns Import counts; throws and rolls back when schema compatibility checks fail.
 */
function importDatabase(db, source) {
  const incoming = new DatabaseSync(source, { readOnly: true });
  const tables = ['Players', 'GameStats', 'GamePlayers', 'GameEliminations'];
  /**
   * Quote a validated SQLite identifier, escaping embedded double quotes.
   * @param name Table or column identifier.
   * @returns A double-quoted SQL identifier.
   */
  const quote = (name) => `"${name.replaceAll('"', '""')}"`;
  let added = 0;
  try {
    for (const table of tables) {
      if (
        !incoming
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(table)
      )
        throw new Error(`Incoming database is missing ${table}.`);
    }
    const columns = Object.fromEntries(
      tables.map((table) => {
        const current = db.prepare(`PRAGMA table_info(${quote(table)})`).all();
        const incomingNames = new Set(
          incoming
            .prepare(`PRAGMA table_info(${quote(table)})`)
            .all()
            .map((row) => row.name),
        );
        const shared = current
          .filter(
            (row) =>
              incomingNames.has(row.name) &&
              !(table !== 'Players' && table !== 'GameStats' && row.name === 'id'),
          )
          .map((row) => row.name);
        const fill = current.filter(
          (row) =>
            !incomingNames.has(row.name) &&
            row.notnull &&
            row.dflt_value === null &&
            !(table !== 'Players' && table !== 'GameStats' && row.name === 'id'),
        );
        return [table, { shared, fill }];
      }),
    );
    for (const required of ['gameID', 'replayName', 'timestamp'])
      if (!columns.GameStats.shared.includes(required))
        throw new Error(`Incoming GameStats has no ${required} column.`);
    if (!columns.Players.shared.includes('playerID'))
      throw new Error('Incoming Players has no playerID column.');
    for (const table of ['GamePlayers', 'GameEliminations'])
      if (!columns[table].shared.includes('gameID'))
        throw new Error(`Incoming ${table} has no gameID column.`);
    db.exec('BEGIN IMMEDIATE');
    try {
      const exists = db.prepare('SELECT 1 FROM GameStats WHERE gameID = ?');
      const newIdSet = new Set();
      for (const { gameID } of incoming.prepare('SELECT gameID FROM GameStats').iterate()) {
        if (!exists.get(gameID)) newIdSet.add(gameID);
      }
      const addedIds = new Set();
      for (const table of tables) {
        const { shared, fill } = columns[table];
        const names = [...shared, ...fill.map((row) => row.name)];
        const insert = db.prepare(
          `INSERT OR IGNORE INTO ${quote(table)} (${names.map(quote).join(',')}) VALUES (${names.map(() => '?').join(',')})`,
        );
        const select = incoming.prepare(
          `SELECT ${shared.map(quote).join(',')} FROM ${quote(table)}`,
        );
        for (const row of select.iterate()) {
          if (table === 'GameStats' || table === 'GamePlayers' || table === 'GameEliminations') {
            if (!(table === 'GameStats' ? newIdSet : addedIds).has(row.gameID)) continue;
          }
          const result = insert.run(
            ...shared.map((name) => row[name]),
            ...fill.map((column) => (/INT|REAL|DOUBLE|FLOAT|NUMERIC/i.test(column.type) ? 0 : '')),
          );
          if (table === 'GameStats' && result.changes) {
            added++;
            addedIds.add(row.gameID);
          }
        }
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return added;
  } finally {
    incoming.close();
  }
}

/**
 * Own serial parser jobs, watcher retries and isolated map reloads; no two jobs share replay.json concurrently.
 * @param db Writable database connection for queue bookkeeping.
 * @param skinSync Skin-download service used after successful imports.
 * @returns Queue controls for startup, enqueueing and waking changed watcher files.
 */
function createReaderQueue(db, skinSync) {
  const sharedOutput = path.join(readerRoot, 'replay.json');
  if (fs.existsSync(sharedOutput)) fs.unlinkSync(sharedOutput);
  removeEmptyReaderRoot();
  let busy = false;
  const watcherRetryAt = new Map();
  const watcherAttempts = new Map();
  const databaseRetryAttempts = new Map();
  const loggedInProgress = new Set();

  /**
   * Retry a short-lived SQLite writer lock without losing a completed parser result.
   * @param operation Synchronous database update to repeat after a transient lock.
   * @returns The operation result after the lock clears.
   */
  async function retryDatabaseBusy(operation) {
    for (let attempt = 1; ; attempt++) {
      try {
        return operation();
      } catch (error) {
        if (!isDatabaseBusy(error) || attempt >= 5) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    }
  }
  /**
   * Recognize parser errors caused by an encrypted, locked or incomplete live replay.
   * @param message Parser error text.
   * @returns Whether the watcher should retry rather than immediately fail the replay.
   */
  const unfinishedReplay = (message) =>
    /being used by another process|marked encrypted but not yet marked as completed|replay.*in.progress/i.test(
      message,
    );

  /**
   * Run the external parser with a ten-second timeout and classify its output/exit status.
   * @param input Replay path to read without moving the source file.
   * @param outputDirectory Optional isolated output directory; defaults to the queue reader directory.
   * @returns A promise resolving after the parser exits successfully.
   */
  async function runReader(input, outputDirectory = readerRoot) {
    activeReaderUses++;
    try {
      fs.mkdirSync(outputDirectory, { recursive: true });
      await new Promise((resolve, reject) => {
        const child = spawn(parserExe, [input], {
          cwd: outputDirectory,
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => {
          stderr = (stderr + chunk.toString()).slice(-4096);
        });
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          child.kill();
        }, 10000);
        child.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once('close', (code) => {
          clearTimeout(timeout);
          if (timedOut)
            return reject(new Error('SniperHunterParser.exe exceeded the 10-second replay limit.'));
          if (code === 0) resolve();
          else {
            const detail = stderr.trim();
            if (
              /ActiveGameplayModifier/.test(detail) &&
              /does not have a default constructor/.test(detail)
            ) {
              console.error('External replay reader failure:', detail);
              reject(
                new Error(
                  'SniperHunterParser.exe cannot initialize ActiveGameplayModifier: the reader library needs a public parameterless constructor for this type. See replay/SniperHunterParser.cs and rebuild the external parser.',
                ),
              );
            } else reject(new Error(detail || `SniperHunterParser.exe exited with code ${code}.`));
          }
        });
      });
    } finally {
      activeReaderUses--;
      removeEmptyReaderRoot();
    }
  }

  /**
   * Reparse one existing replay into an isolated temporary folder and extract map data off the HTTP thread.
   * @param input Existing replay file path.
   * @param gameID Expected game ID to verify against the decoded replay.
   * @returns A promise resolving to the verified timeline; temporary outputs are removed afterward.
   */
  async function loadMap(input, gameID) {
    const directory = path.join(readerRoot, `map-${require('node:crypto').randomUUID()}`);
    try {
      await runReader(input, directory);
      const output = path.join(directory, 'replay.json');
      if (!fs.existsSync(output)) throw new Error('Reader did not write replay.json.');
      return await runReplayWork({
        action: 'map',
        jsonPath: output,
        input,
        gameID,
        ownerIds: settings.playerIds,
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
      removeEmptyReaderRoot();
    }
  }

  /**
   * Publish a completed queue item, clear watcher retries and schedule missing skins only for new matches.
   * @param next ReplayImports queue row.
   * @param result Worker result with import outcome, timeline, skins and warning.
   * @returns Nothing; updates database status and shared activity.
   */
  function recordImported(next, result) {
    const { imported: importedReplay, timeline, skinIds, warning } = result;
    db.prepare('UPDATE ReplayImports SET status = ? WHERE id = ?').run(
      importedReplay.duplicate ? 'duplicate' : 'decoded',
      next.id,
    );
    if (warning) console.warn(warning);
    watcherRetryAt.delete(next.id);
    watcherAttempts.delete(next.id);
    databaseRetryAttempts.delete(next.id);
    loggedInProgress.delete(next.id);
    if (importedReplay.duplicate) {
      activity.duplicateAt = Date.now();
      activity.duplicateName = next.name;
    } else {
      if (timeline) latestMapTimeline = timeline;
      activity.addedAt = Date.now();
      activity.addedName = next.name;
      activity.addedSource = next.source;
      console.log(`Replay added: ${next.name} (${importedReplay.gameID})`);
      try {
        for (const id of skinIds) skinSync.queue(id);
      } catch (error) {
        console.warn('Skin scan failed:', error);
      }
    }
  }

  /**
   * Retry incomplete watcher files with backoff, or record a final parse failure after corruption checks.
   * @param next ReplayImports queue row.
   * @param input Source replay path used to check modification time.
   * @param error Parser or worker error.
   * @param readerFailed Whether the external reader itself failed before producing JSON.
   * @returns Nothing; updates retry state and queue status.
   */
  function recordImportFailure(next, input, error, readerFailed) {
    let reason = String(error.message || error);
    if (next.source === 'watcher' && isDatabaseBusy(error)) {
      const attempts = (databaseRetryAttempts.get(next.id) || 0) + 1;
      if (attempts <= 5) {
        db.prepare(
          "UPDATE ReplayImports SET status = 'awaiting-reader', error = ? WHERE id = ?",
        ).run('Waiting for the database to become available.', next.id);
        databaseRetryAttempts.set(next.id, attempts);
        watcherRetryAt.set(next.id, Date.now() + Math.min(30000, attempts * 5000));
        console.warn(`Database busy while importing ${next.name}; retry ${attempts}/5 queued.`);
        return;
      }
    }
    try {
      if (fs.statSync(input).size === 0) reason = REPLAY_EMPTY_MESSAGE;
    } catch {
      /* Preserve the parser error when the source has disappeared. */
    }
    const attempts = (watcherAttempts.get(next.id) || 0) + 1;
    let quietFor = 0;
    try {
      quietFor = Date.now() - Math.max(fs.statSync(input).mtimeMs, Date.parse(next.addedAt));
    } catch {
      /* Missing files and other non-reader failures are reported immediately. */
    }
    const likelyCorrupt = attempts >= 3 && quietFor >= 30000;
    if (next.source === 'watcher' && readerFailed && fs.existsSync(input) && !likelyCorrupt) {
      db.prepare("UPDATE ReplayImports SET status = 'awaiting-reader', error = ? WHERE id = ?").run(
        REPLAY_WAITING_MESSAGE,
        next.id,
      );
      watcherAttempts.set(next.id, attempts);
      watcherRetryAt.set(next.id, Date.now() + Math.max(2000, 30000 - quietFor));
      if (!loggedInProgress.has(next.id)) {
        loggedInProgress.add(next.id);
        console.log(`Replay ${next.name} is still in progress; retrying after Fortnite finishes.`);
      }
    } else {
      const finalReason =
        next.source === 'watcher' && readerFailed && likelyCorrupt
          ? REPLAY_CORRUPT_MESSAGE
          : reason;
      db.prepare("UPDATE ReplayImports SET status = 'failed', error = ? WHERE id = ?").run(
        finalReason.slice(0, 1000),
        next.id,
      );
      watcherRetryAt.delete(next.id);
      watcherAttempts.delete(next.id);
      databaseRetryAttempts.delete(next.id);
      loggedInProgress.delete(next.id);
      console.error(`Replay ${next.id} failed:`, finalReason);
      activity.failedAt = Date.now();
      activity.failedName = next.name;
      activity.failedReason = finalReason;
      activity.failedSource = next.source;
    }
  }

  /**
   * Remove parser output and temporary browser uploads without touching user-selected or Fortnite replay files.
   * @param next Queue row identifying the input source.
   * @param input Resolved input path.
   * @returns Nothing; logs cleanup failures without masking the parse result.
   */
  function cleanupInput(next, input) {
    try {
      if (fs.existsSync(sharedOutput)) fs.unlinkSync(sharedOutput);
    } catch (error) {
      console.warn('Could not remove replay.json:', error);
    }
    if (next.source === 'upload') {
      try {
        if (fs.existsSync(input)) fs.unlinkSync(input);
      } catch (error) {
        console.warn('Could not remove temporary replay:', error);
      }
    }
    removeEmptyReaderRoot();
  }

  /**
   * Process one queue item through parser, worker import, outcome reporting and guaranteed temporary-file cleanup.
   * @param next Queued ReplayImports row.
   * @returns A promise completing after the item is imported, deferred or failed.
   */
  async function processQueuedReplay(next) {
    const input =
      next.source === 'watcher'
        ? path.join(demoRoot, next.name)
        : next.source === 'local'
          ? next.sourcePath
          : path.join(readerRoot, next.id + '.replay');
    db.prepare("UPDATE ReplayImports SET status = 'processing', error = NULL WHERE id = ?").run(
      next.id,
    );

    let readerFailed = false;
    try {
      if (fs.existsSync(sharedOutput)) fs.unlinkSync(sharedOutput);
      if (!fs.existsSync(input)) throw new Error('Replay file is missing.');
      readerFailed = true;
      await runReader(input);
      readerFailed = false;
      if (!fs.existsSync(sharedOutput)) throw new Error('Reader did not write replay.json.');
      const result = await runReplayWork({
        action: 'import',
        jsonPath: sharedOutput,
        name: next.name,
        ownerIds: settings.playerIds,
      });
      await retryDatabaseBusy(() => recordImported(next, result));
    } catch (error) {
      await retryDatabaseBusy(() => recordImportFailure(next, input, error, readerFailed));
    } finally {
      cleanupInput(next, input);
    }
  }

  /**
   * Consume ready work sequentially while guarding against overlapping queue drains.
   * @returns A promise that resolves when the queue is empty or no more work is ready.
   */
  async function drain() {
    if (busy || !fs.existsSync(parserExe)) return;
    busy = true;
    try {
      while (fs.existsSync(parserExe)) {
        const next = nextQueuedReplay(db, watcherRetryAt);
        if (!next) break;
        await processQueuedReplay(next);
      }
    } finally {
      busy = false;
    }
  }

  return {
    loadMap,
    enqueue: () => {
      void drain().catch((error) => console.error('Replay queue failed:', error));
    },
    resetWatcher: (id) => {
      watcherAttempts.delete(id);
      watcherRetryAt.delete(id);
      databaseRetryAttempts.delete(id);
      loggedInProgress.delete(id);
    },
    start: () => {
      db.exec("UPDATE ReplayImports SET status = 'awaiting-reader' WHERE status = 'processing'");
      for (const entry of db
        .prepare(
          "SELECT id, error FROM ReplayImports WHERE source = 'watcher' AND status = 'failed'",
        )
        .all())
        if (unfinishedReplay(entry.error || '') || isDatabaseBusy(entry.error || ''))
          db.prepare(
            "UPDATE ReplayImports SET status = 'awaiting-reader', error = NULL WHERE id = ?",
          ).run(entry.id);
      setInterval(() => {
        void drain().catch((error) => console.error('Replay queue failed:', error));
      }, 5000).unref();
      void drain().catch((error) => console.error('Replay queue failed:', error));
    },
  };
}

/**
 * Stream a browser upload into temporary storage and enqueue it with optional bulk-import accounting.
 * @param req Incoming upload stream.
 * @param res HTTP response.
 * @param db Writable database connection.
 * @param enqueue Callback that wakes the parser queue.
 * @param skinSync Skin synchronization service retained by the upload API contract.
 * @returns A promise completing after upload acceptance or an error response.
 */
async function addReplay(req, res, db, enqueue, skinSync) {
  if (!fs.existsSync(parserExe))
    return json(res, 503, { error: 'SniperHunterParser.exe is not available.' });
  const name = decodeURIComponent(req.headers['x-replay-name'] || '');
  const batchID = req.headers['x-replay-batch'] || null;
  const batchTotal = Number(req.headers['x-replay-batch-total']);
  if (
    batchID &&
    (!/^[a-f0-9-]{36}$/i.test(batchID) ||
      !Number.isInteger(batchTotal) ||
      batchTotal < 1 ||
      batchTotal > 1000)
  )
    return json(res, 400, { error: 'Invalid replay batch.' });
  const extension = path.extname(name).toLowerCase();
  if (extension !== '.replay') return json(res, 400, { error: 'Choose a .replay file.' });
  if (Number(req.headers['content-length']) > MAX_UPLOAD)
    return json(res, 413, { error: 'Replay file exceeds 1 GB.' });
  const id = require('node:crypto').randomUUID().replaceAll('-', '');
  const target = path.join(readerRoot, id + extension);
  let size = 0;
  activeReaderUses++;
  try {
    fs.mkdirSync(readerRoot, { recursive: true });
    await pipeline(
      req,
      new Transform({
        /**
         * Count streamed bytes and stop an upload as soon as it exceeds the permitted size.
         * @param chunk Next buffer from the upload stream.
         * @param encoding Stream-provided encoding; buffers pass through unchanged.
         * @param callback Node transform callback receiving an optional error and the original buffer.
         * @returns Nothing; forwards the chunk through the callback.
         */
        transform(chunk, encoding, callback) {
          size += chunk.length;
          callback(size > MAX_UPLOAD ? new Error('Replay file exceeds 1 GB.') : null, chunk);
        },
      }),
      fs.createWriteStream(target, { flags: 'wx' }),
    );
    if (size === 0) throw new Error('The file is empty.');
    const entry = {
      id,
      name: path.basename(name),
      status: 'awaiting-reader',
      addedAt: new Date().toISOString(),
      size,
      batchID,
    };
    if (batchID) {
      db.prepare('INSERT OR IGNORE INTO ReplayBatches (id, total, addedAt) VALUES (?, ?, ?)').run(
        batchID,
        batchTotal,
        entry.addedAt,
      );
      activity.activeBatchId = batchID;
      activity.batchDoneAt = 0;
    }
    db.prepare(
      'INSERT INTO ReplayImports (id, name, status, addedAt, size, batchID, source) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(entry.id, entry.name, entry.status, entry.addedAt, entry.size, batchID, 'upload');
    json(res, 201, entry);
    enqueue();
  } catch (error) {
    try {
      fs.unlinkSync(target);
    } catch {
      /* upload may have failed before creation */
    }
    if (batchID) {
      const addedAt = new Date().toISOString();
      db.prepare('INSERT OR IGNORE INTO ReplayBatches (id, total, addedAt) VALUES (?, ?, ?)').run(
        batchID,
        batchTotal,
        addedAt,
      );
      db.prepare(
        'INSERT OR IGNORE INTO ReplayImports (id, name, status, addedAt, size, error, batchID, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        id,
        path.basename(name),
        'failed',
        addedAt,
        size,
        String(error.message || error).slice(0, 1000),
        batchID,
        'upload',
      );
      activity.activeBatchId = batchID;
    }
    if (!res.headersSent && !res.destroyed)
      json(res, 400, { error: error.message || 'Could not add replay.' });
  } finally {
    activeReaderUses--;
    removeEmptyReaderRoot();
  }
}

/**
 * Open the native replay picker at Fortnite Demos on each invocation.
 * @returns A promise containing selected replay paths, or an empty list when cancelled.
 */
async function chooseLocalReplays() {
  const script = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$dialog = [System.Windows.Forms.OpenFileDialog]::new()
$dialog.InitialDirectory = $env:SNIPER_HUNTER_DEMOS
$dialog.Filter = 'Fortnite replay files (*.replay)|*.replay'
$dialog.Multiselect = $true
$dialog.CheckFileExists = $true
$dialog.RestoreDirectory = $false
try {
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject @($dialog.FileNames) -Compress))
  } else { [Console]::Out.WriteLine('[]') }
} finally { $dialog.Dispose() }`;
  return await new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-Command', script],
      {
        windowsHide: true,
        env: { ...process.env, SNIPER_HUNTER_DEMOS: demoRoot },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0)
        return reject(new Error(stderr.trim() || 'Could not open the replay picker.'));
      try {
        resolve(JSON.parse(stdout.trim() || '[]'));
      } catch {
        reject(new Error('The replay picker returned an invalid selection.'));
      }
    });
  });
}

/**
 * Watch Fortnite Demos for the newest replay and wake queued retries when file metadata changes.
 * @param enqueue Callback that wakes the parser queue.
 * @param resetWatcher Callback that forgets failed checks after Fortnite writes again.
 * @returns Nothing; installs the filesystem watcher and lightweight rescan timer.
 */
function startDemoWatcher(enqueue, resetWatcher) {
  if (!fs.existsSync(demoRoot) || !fs.statSync(demoRoot).isDirectory()) {
    activity.watcherError = 'Fortnite demo folder not found. File watcher was not enabled.';
    console.warn(`${activity.watcherError} (${demoRoot})`);
    return;
  }
  const known = new Set(
    fs.readdirSync(demoRoot).filter((name) => name.toLowerCase().endsWith('.replay')),
  );
  // A short timeout keeps filesystem events responsive while the replay worker
  // refreshes its player cache in a separate write transaction.
  const watcherDb = new DatabaseSync(databasePath);
  watcherDb.exec('PRAGMA busy_timeout = 100');
  process.once('exit', () => watcherDb.close());
  const observed = new Map();
  const readStatus = watcherDb.prepare('SELECT status FROM ReplayImports WHERE id = ?');
  const loggedBusy = new Set();
  activity.watcherError = null;

  /**
   * Retain watcher state when SQLite is temporarily locked and log only its first occurrence.
   * @param name Replay filename whose database update needs another attempt.
   * @returns Nothing; the three-second scan will retry the unchanged observation.
   */
  function deferDatabaseWrite(name) {
    if (loggedBusy.has(name)) return;
    loggedBusy.add(name);
    console.warn(`Database busy while watching ${name}; the file will be checked again.`);
  }

  /**
   * Record a watcher error and stop monitoring a file that cannot be inspected.
   * @param state In-memory metadata for the watched replay.
   * @param error Filesystem or validation error.
   * @returns Nothing; preserves the error for the progress bar.
   */
  function failWatchedFile(state, error) {
    if (isDatabaseBusy(error)) {
      deferDatabaseWrite(state.name);
      return;
    }
    const reason = String(error.message || error);
    try {
      watcherDb
        .prepare("UPDATE ReplayImports SET status = 'failed', error = ? WHERE id = ?")
        .run(reason.slice(0, 1000), state.id);
    } catch (writeError) {
      if (!isDatabaseBusy(writeError)) throw writeError;
      deferDatabaseWrite(state.name);
      return;
    }
    clearTimeout(state.timer);
    observed.delete(state.name);
    activity.failedAt = Date.now();
    activity.failedName = state.name;
    activity.failedReason = reason;
    activity.failedSource = 'watcher';
    console.warn(`Could not import watched replay ${state.name}:`, error);
  }

  /**
   * Probe an early write after one second, or a stagnant file after 30 seconds.
   * @param state In-memory metadata for the watched replay.
   * @param early Whether the latest write arrived before the normal match interval.
   * @returns Nothing; schedules one candidate for the serial parser queue.
   */
  function scheduleProbe(state, early = false) {
    clearTimeout(state.timer);
    const quietUntil = Math.max(state.firstSeenAt, state.modifiedAt) + 30000;
    state.timer = setTimeout(
      () => {
        state.timer = null;
        try {
          const stats = fs.statSync(path.join(demoRoot, state.name));
          if (!stats.isFile() || stats.size > MAX_UPLOAD)
            throw new Error('Replay is not a supported file.');
          if (stats.size !== state.size || stats.mtimeMs !== state.modifiedAt) {
            observeWrite(state, stats);
            return;
          }
          if (!early && Date.now() < quietUntil) {
            scheduleProbe(state);
            return;
          }
          const status = readStatus.get(state.id)?.status;
          if (!['watching', 'awaiting-reader'].includes(status)) return;
          watcherDb
            .prepare(
              "UPDATE ReplayImports SET status = 'awaiting-reader', error = NULL, size = ? WHERE id = ?",
            )
            .run(stats.size, state.id);
          enqueue();
        } catch (error) {
          if (isDatabaseBusy(error)) {
            deferDatabaseWrite(state.name);
            state.timer = setTimeout(() => scheduleProbe(state, early), 1000);
            state.timer.unref();
          } else failWatchedFile(state, error);
        }
      },
      Math.max(0, (early ? Date.now() + 1000 : quietUntil) - Date.now()),
    );
    state.timer.unref();
  }

  /**
   * Reset failed parser checks after any size or timestamp change and choose the next probe.
   * @param state In-memory metadata for the watched replay.
   * @param stats Current replay file metadata.
   * @returns Nothing; regular writes defer parsing while early writes prompt a check.
   */
  function observeWrite(state, stats) {
    if (stats.size === state.size && stats.mtimeMs === state.modifiedAt) return;
    const interval = stats.mtimeMs - state.modifiedAt;
    const early = state.size > 0 && interval > 0 && interval < 19000;
    const status = readStatus.get(state.id)?.status;
    if (status === 'decoded' || status === 'duplicate') {
      clearTimeout(state.timer);
      observed.delete(state.name);
      return;
    }
    if (status !== 'processing')
      watcherDb
        .prepare(
          "UPDATE ReplayImports SET status = 'watching', error = NULL, size = ? WHERE id = ?",
        )
        .run(stats.size, state.id);
    state.size = stats.size;
    state.modifiedAt = stats.mtimeMs;
    resetWatcher(state.id);
    loggedBusy.delete(state.name);
    if (activity.failedSource === 'watcher' && activity.failedName === state.name)
      activity.failedAt = 0;
    scheduleProbe(state, early);
  }

  /**
   * Add a newly created replay without parsing its incomplete initial contents.
   * @param name Replay filename reported by the folder watcher.
   * @param existing Whether this file existed before application startup.
   * @returns Nothing; starts a 30-second quiet-period timer.
   */
  function schedule(name, existing = false) {
    if (!name.toLowerCase().endsWith('.replay') || known.has(name)) return;
    const stats = fs.statSync(path.join(demoRoot, name));
    if (!stats.isFile() || stats.size > MAX_UPLOAD) return;
    const firstSeenAt = existing
      ? Math.min(Date.now(), stats.birthtimeMs || stats.mtimeMs)
      : Date.now();
    const state = {
      id: require('node:crypto').randomUUID().replaceAll('-', ''),
      name,
      size: stats.size,
      modifiedAt: stats.mtimeMs,
      firstSeenAt,
      timer: null,
    };
    activity.detectedAt = firstSeenAt;
    activity.detectedName = name;
    watcherDb
      .prepare(
        'INSERT INTO ReplayImports (id, name, status, addedAt, size, source) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(state.id, name, 'watching', new Date(firstSeenAt).toISOString(), stats.size, 'watcher');
    known.add(name);
    loggedBusy.delete(name);
    observed.set(name, state);
    scheduleProbe(state);
  }

  /**
   * Inspect new and tracked replay files after a directory event or fallback scan.
   * @param changedName Optional filename reported by fs.watch.
   * @returns Nothing; schedules probes only for changed files.
   */
  function scan(changedName) {
    try {
      const names = fs
        .readdirSync(demoRoot)
        .filter((name) => name.toLowerCase().endsWith('.replay'));
      const present = new Set(names);
      for (const name of known) if (!present.has(name)) known.delete(name);
      const newcomers = names
        .filter((name) => !known.has(name))
        .map((name) => {
          try {
            return { name, modified: fs.statSync(path.join(demoRoot, name)).mtimeMs };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => a.modified - b.modified || a.name.localeCompare(b.name));
      for (const { name } of newcomers) {
        try {
          schedule(name);
        } catch (error) {
          if (isDatabaseBusy(error)) deferDatabaseWrite(name);
          else console.warn(`Could not watch new replay ${name}:`, error);
        }
      }
      for (const state of observed.values()) {
        if (changedName && state.name !== changedName) continue;
        if (!present.has(state.name)) {
          failWatchedFile(state, new Error('Replay file is missing.'));
          continue;
        }
        try {
          const stats = fs.statSync(path.join(demoRoot, state.name));
          if (!stats.isFile() || stats.size > MAX_UPLOAD)
            throw new Error('Replay is not a supported file.');
          observeWrite(state, stats);
        } catch (error) {
          if (isDatabaseBusy(error)) deferDatabaseWrite(state.name);
          else failWatchedFile(state, error);
        }
      }
    } catch (error) {
      activity.watcherError = 'Fortnite demo folder is unavailable. File watcher was disabled.';
      console.warn(activity.watcherError, error);
      watcher.close();
      clearInterval(scanTimer);
    }
  }

  const watcher = fs.watch(demoRoot, (_event, filename) => scan(filename?.toString()));
  watcher.on('error', (error) => {
    activity.watcherError = 'Fortnite demo folder watcher failed.';
    console.warn(activity.watcherError, error);
  });
  const scanTimer = setInterval(scan, 3000);
  scanTimer.unref();
  for (const entry of watcherDb
    .prepare(
      "SELECT id, name, status, error, size, addedAt FROM ReplayImports WHERE source = 'watcher' AND (status IN ('watching', 'awaiting-reader', 'processing') OR (status = 'failed' AND error = ?)) ORDER BY addedAt",
    )
    .all(REPLAY_CORRUPT_MESSAGE)) {
    if (!known.has(entry.name)) continue;
    try {
      const stats = fs.statSync(path.join(demoRoot, entry.name));
      const state = {
        id: entry.id,
        name: entry.name,
        size: stats.size,
        modifiedAt: stats.mtimeMs,
        firstSeenAt: Date.parse(entry.addedAt) || Date.now(),
        timer: null,
      };
      observed.set(entry.name, state);
      if (entry.status === 'failed' && stats.size !== entry.size) {
        watcherDb
          .prepare(
            "UPDATE ReplayImports SET status = 'watching', error = NULL, size = ? WHERE id = ?",
          )
          .run(stats.size, entry.id);
        scheduleProbe(state);
      } else if (entry.status === 'watching') scheduleProbe(state);
    } catch {
      /* A missing startup replay is reported by its queued parser attempt. */
    }
  }
  // A match can already be underway when the program starts. Recover recent
  // existing files that have no match or pending watcher import, including a
  // just-finished replay followed immediately by the next match.
  const hasMatch = watcherDb.prepare('SELECT 1 FROM GameStats WHERE replayName = ? LIMIT 1');
  const hasPending = watcherDb.prepare(
    "SELECT 1 FROM ReplayImports WHERE source = 'watcher' AND name = ? AND (status IN ('watching', 'awaiting-reader', 'processing') OR (status = 'failed' AND error LIKE '%database is locked%')) LIMIT 1",
  );
  const recentFiles = [...known]
    .map((name) => {
      try {
        return { name, stats: fs.statSync(path.join(demoRoot, name)) };
      } catch {
        return null;
      }
    })
    .filter((file) => file && file.stats.mtimeMs >= Date.now() - 5 * 60 * 1000)
    .sort((a, b) => a.stats.mtimeMs - b.stats.mtimeMs);
  for (const { name } of recentFiles) {
    if (observed.has(name)) continue;
    try {
      if (hasMatch.get(name) || hasPending.get(name)) continue;
      known.delete(name);
      schedule(name, true);
    } catch (error) {
      if (isDatabaseBusy(error)) {
        known.delete(name);
        deferDatabaseWrite(name);
      } else console.warn(`Could not resume recent replay ${name}:`, error);
    }
  }
  console.log(`Watching Fortnite demos: ${demoRoot}`);
  return watcher;
}

/**
 * Combine upload counts and watcher activity into the progress-bar state shown by every client.
 * @param db Open database connection.
 * @returns A status payload with message, progress and last-added metadata.
 */
function replayStatus(db) {
  if (!activity.activeBatchId) {
    const pending = readStatement(
      db,
      `SELECT batchID FROM ReplayImports
      WHERE batchID IS NOT NULL AND status IN ('awaiting-reader', 'processing')
      ORDER BY addedAt, rowid LIMIT 1`,
    ).get();
    if (pending) {
      activity.activeBatchId = pending.batchID;
      activity.batchDoneAt = 0;
    }
  }
  if (activity.activeBatchId) {
    const batch = readStatement(db, 'SELECT total FROM ReplayBatches WHERE id = ?').get(
      activity.activeBatchId,
    );
    if (batch) {
      const counts = readStatement(
        db,
        `SELECT status, COUNT(*) AS count FROM ReplayImports WHERE batchID = ? GROUP BY status`,
      ).all(activity.activeBatchId);
      /**
       * Read the batch count for a particular import state.
       * @param status ReplayImports status to count.
       * @returns The number of rows in that state, defaulting to zero.
       */
      const get = (status) => counts.find((row) => row.status === status)?.count || 0;
      const done = get('decoded') + get('duplicate') + get('failed');
      const added = get('decoded');
      const duplicates = get('duplicate');
      const failed = get('failed');
      if (done >= batch.total && !activity.batchDoneAt) activity.batchDoneAt = Date.now();
      if (done < batch.total || Date.now() - activity.batchDoneAt < 10000)
        return {
          kind: 'batch',
          message: `${done.toLocaleString()}/${batch.total.toLocaleString()} replays processed · ${added.toLocaleString()} replays added${duplicates ? ` · ${duplicates.toLocaleString()} already added` : ''}${failed ? ` · ${failed.toLocaleString()} failed to parse` : ''}`,
          progress: Math.min(100, (done * 100) / batch.total),
          batchID: activity.activeBatchId,
        };
      activity.activeBatchId = null;
    }
  }
  const watched = readStatement(
    db,
    "SELECT name, addedAt FROM ReplayImports WHERE source = 'watcher' AND status IN ('watching', 'awaiting-reader', 'processing') ORDER BY addedAt DESC LIMIT 1",
  ).get();
  const now = Date.now();
  const latestWatchedFailure =
    activity.failedSource === 'watcher' &&
    activity.failedAt > 0 &&
    !watched &&
    activity.failedAt >= Math.max(activity.detectedAt, activity.addedAt, activity.duplicateAt);
  const recentFailure =
    now - activity.failedAt < 10000 &&
    activity.failedAt >= activity.detectedAt &&
    (!watched || watched.name === activity.failedName);
  if (latestWatchedFailure || recentFailure)
    return {
      kind: 'error',
      message:
        activity.failedReason === REPLAY_CORRUPT_MESSAGE
          ? REPLAY_CORRUPT_MESSAGE
          : `Replay failed: ${activity.failedName} — ${activity.failedReason}`,
      progress: 0,
    };
  if (
    now - activity.duplicateAt < (watched ? 3000 : 10000) &&
    activity.duplicateAt > activity.addedAt
  )
    return {
      kind: 'warning',
      message: `Replay already added: ${activity.duplicateName}`,
      progress: 100,
    };
  if (now - activity.addedAt < (watched ? 1500 : 5000))
    return { kind: 'added', message: `New replay added: ${activity.addedName}`, progress: 100 };
  if (watched)
    return {
      kind: 'processing',
      message: `New replay in progress: ${watched.name}`,
      progress: 50,
      startedAt: Date.parse(watched.addedAt),
    };
  const processing = readStatement(
    db,
    "SELECT name FROM ReplayImports WHERE status = 'processing' LIMIT 1",
  ).get();
  if (processing)
    return { kind: 'processing', message: `Replay in progress: ${processing.name}`, progress: 35 };
  if (now - activity.detectedAt < 10000)
    return {
      kind: 'detected',
      message: `New replay in progress: ${activity.detectedName}`,
      progress: 50,
    };
  if (activity.watcherError)
    return { kind: 'warning', message: activity.watcherError, progress: 0 };
  return { kind: 'idle', message: '', progress: 0 };
}

/**
 * Stream a legacy database upload, import compatible rows, and remove the temporary upload afterward.
 * @param req Incoming database upload.
 * @param res HTTP response.
 * @param db Destination SQLite connection.
 * @param skinSync Skin service to scan imported cosmetic IDs.
 * @returns A promise completing after import or an error response.
 */
async function uploadDatabase(req, res, db, skinSync) {
  if (Number(req.headers['content-length']) > MAX_UPLOAD)
    return json(res, 413, { error: 'Database exceeds 1 GB.' });
  const temporary = path.join(dataRoot, `import-${require('node:crypto').randomUUID()}.db`);
  let size = 0;
  try {
    await pipeline(
      req,
      new Transform({
        /**
         * Count streamed bytes and stop an upload as soon as it exceeds the permitted size.
         * @param chunk Next buffer from the upload stream.
         * @param encoding Stream-provided encoding; buffers pass through unchanged.
         * @param callback Node transform callback receiving an optional error and the original buffer.
         * @returns Nothing; forwards the chunk through the callback.
         */
        transform(chunk, encoding, callback) {
          size += chunk.length;
          callback(size > MAX_UPLOAD ? new Error('Database exceeds 1 GB.') : null, chunk);
        },
      }),
      fs.createWriteStream(temporary, { flags: 'wx' }),
    );
    const header = Buffer.alloc(16);
    const handle = fs.openSync(temporary, 'r');
    try {
      fs.readSync(handle, header, 0, 16, 0);
    } finally {
      fs.closeSync(handle);
    }
    if (!header.equals(Buffer.from('SQLite format 3\0')))
      throw new Error('Choose a SQLite database.db file.');
    const imported = importDatabase(db, temporary);
    rebuildPlayerCounts(db);
    skinSync.scanDatabase();
    json(res, 200, { imported });
  } catch (error) {
    if (!res.headersSent) json(res, 400, { error: error.message || 'Could not import database.' });
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

/**
 * Serve embedded assets or current development files with the correct MIME type and caching policy.
 * @param res HTTP response.
 * @param key Normalized asset URL path.
 * @param assets In-memory release asset map.
 * @param devMode Whether development files should be checked on disk.
 * @returns Nothing; ends the response.
 */
function serveAsset(res, key, assets, devMode) {
  let body = assets.get(key);
  if (devMode && key === '/index.html') {
    body = Buffer.from(
      body
        .toString('utf8')
        .replace(
          '</body>',
          "<script>new EventSource('/__dev/events').addEventListener('reload', () => location.reload());</script></body>",
        ),
    );
  }
  const type = key.endsWith('.html')
    ? 'text/html; charset=utf-8'
    : key.endsWith('.js')
      ? 'text/javascript; charset=utf-8'
      : key.endsWith('.css')
        ? 'text/css; charset=utf-8'
        : key.endsWith('.svg')
          ? 'image/svg+xml'
          : key.endsWith('.png')
            ? 'image/png'
            : key.endsWith('.ico')
              ? 'image/x-icon'
              : 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length });
  res.end(body);
}

/**
 * Start the hidden PowerShell tray host using embedded resources and observe its exit request.
 * @param assets Embedded/browser asset map containing the icon and tray script.
 * @param onClose Application shutdown callback.
 * @returns The tray child process, or null when unsupported.
 */
function startTrayIcon(assets, onClose) {
  if (process.platform !== 'win32') return null;
  const icon = assets.get('/assets/icon.ico');
  if (!icon) {
    console.warn('Tray icon asset is missing.');
    return null;
  }
  const script = sea.isSea()
    ? Buffer.from(sea.getAsset('tray.ps1')).toString('utf8')
    : fs.readFileSync(path.join(root, 'server', 'tray.ps1'), 'utf8');
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', script],
    {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SNIPER_HUNTER_TRAY_ICON_B64: icon.toString('base64'),
        SNIPER_HUNTER_TRAY_URL: appUrl,
      },
    },
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
    if (output.includes('CLOSE')) onClose();
    output = output.slice(-32);
  });
  child.stderr.on('data', (chunk) => console.warn('Tray icon:', chunk.toString().trim()));
  child.on('error', (error) => console.warn('Tray icon could not start:', error.message));
  return child;
}

/**
 * Handle requests that load and cache verified replay timelines.
 * @param context Validated HTTP request context.
 * @param state Shared server dependencies and lifecycle state.
 * @returns A promise resolving to true when handled, otherwise false.
 */
async function handleMovementRequests(context, state) {
  const { req, res, pathname } = context;
  const { db, loadMap } = state;
  const mapMatch = /^\/api\/map\/matches\/([^/]+)$/.exec(pathname);
  if (mapMatch && req.method === 'GET') {
    const gameID = decodeURIComponent(mapMatch[1]);
    const match = readStatement(db, 'SELECT replayName FROM GameStats WHERE gameID = ?').get(
      gameID,
    );
    if (!match) {
      json(res, 404, { error: 'Match not found.' });
      return true;
    }
    if (latestMapTimeline?.gameID === gameID) {
      json(res, 200, latestMapTimeline);
      return true;
    }
    const replayName = match.replayName;
    if (
      typeof replayName !== 'string' ||
      path.basename(replayName) !== replayName ||
      path.extname(replayName).toLowerCase() !== '.replay'
    ) {
      json(res, 404, {
        code: 'replay_missing',
        error: 'The matching replay file is not in Fortnite Demos.',
      });
      return true;
    }
    const input = path.join(demoRoot, replayName);
    let file;
    try {
      file = fs.statSync(input);
      const actual = fs.realpathSync(input);
      const demos = fs.realpathSync(demoRoot);
      if (
        !file.isFile() ||
        file.size > MAX_UPLOAD ||
        !actual.toLowerCase().startsWith((demos + path.sep).toLowerCase())
      )
        throw new Error('Replay is unavailable.');
    } catch {
      json(res, 404, {
        code: 'replay_missing',
        error: 'The matching replay file is not in Fortnite Demos.',
      });
      return true;
    }
    if (!fs.existsSync(parserExe)) {
      json(res, 503, { code: 'reader_missing', error: 'SniperHunterParser.exe is not available.' });
      return true;
    }
    const cached = restoredMapTimelines.get(gameID);
    if (cached?.modified === file.mtimeMs && cached.size === file.size) {
      restoredMapTimelines.delete(gameID);
      restoredMapTimelines.set(gameID, cached);
      json(res, 200, cached.timeline);
      return true;
    }
    let pending = pendingMapLoads.get(gameID);
    if (!pending) {
      pending = mapLoadTail.then(() => loadMap(input, gameID));
      mapLoadTail = pending.catch(() => {});
      pendingMapLoads.set(gameID, pending);
      void pending.finally(() => pendingMapLoads.delete(gameID)).catch(() => {});
    }
    try {
      const timeline = await pending;
      restoredMapTimelines.delete(gameID);
      restoredMapTimelines.set(gameID, { modified: file.mtimeMs, size: file.size, timeline });
      if (restoredMapTimelines.size > 5)
        restoredMapTimelines.delete(restoredMapTimelines.keys().next().value);
      json(res, 200, timeline);
      return true;
    } catch (error) {
      console.warn(`Map movement could not be loaded for ${gameID}:`, error);
      json(res, error.code === 'replay_mismatch' ? 409 : 422, {
        code: error.code || 'replay_failed',
        error: error.message || 'Could not read replay movement.',
      });
      return true;
    }
  }
  if (pathname === '/api/map/latest' && req.method === 'GET') {
    const newest = readStatement(
      db,
      'SELECT gameID FROM GameStats ORDER BY timestamp DESC LIMIT 1',
    ).get();
    json(res, 200, latestMapTimeline?.gameID === newest?.gameID ? latestMapTimeline : null);
    return true;
  }

  return false;
}

/**
 * Handle requests that list, upload, rename, select and delete saved maps.
 * @param context Validated HTTP request context.
 * @param state Shared server dependencies and lifecycle state.
 * @returns A promise resolving to true when handled, otherwise false.
 */
async function handleSavedMapRequests(context, state) {
  const { req, res, requestUrl, pathname } = context;

  if (pathname === '/api/maps' && req.method === 'GET') {
    json(res, 200, {
      maps: maps().map(({ id, name, calibration }) => ({
        id,
        name,
        calibrated: Array.isArray(calibration?.anchors) && calibration.anchors.length === 3,
      })),
      selectedMapId: selectedMap()?.id || null,
    });
    return true;
  }
  if (pathname === '/api/maps' && req.method === 'POST') {
    const name = String(requestUrl.searchParams.get('name') || '').trim();
    if (!name || name.length > 80) {
      json(res, 400, { error: 'Give the map a name up to 80 characters.' });
      return true;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 25 * 1024 * 1024) throw new Error('Map image exceeds 25 MB.');
      chunks.push(chunk);
    }
    const image = Buffer.concat(chunks);
    if (
      image.length < 24 ||
      !image.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
      image.toString('ascii', 12, 16) !== 'IHDR' ||
      image.readUInt32BE(16) < 256 ||
      image.readUInt32BE(20) < 256 ||
      image.readUInt32BE(16) > 8192 ||
      image.readUInt32BE(20) > 8192
    ) {
      json(res, 400, { error: 'Upload a PNG map between 256 and 8192 pixels on each side.' });
      return true;
    }
    const id = require('node:crypto').randomUUID();
    fs.mkdirSync(mapsRoot, { recursive: true });
    fs.writeFileSync(mapFile({ id }), image);
    const created = { id, name, rotation: 0, calibration: null };
    updateConfig({ maps: [...maps(), created], selectedMapId: id });
    json(res, 201, { map: { id, name }, selectedMapId: id });
    return true;
  }
  const mapEntry = /^\/api\/maps\/([a-f0-9-]{36})(?:\/(select))?$/.exec(pathname);
  if (mapEntry && req.method === 'POST' && mapEntry[2] === 'select') {
    if (!maps().some((item) => item.id === mapEntry[1])) {
      json(res, 404, { error: 'Map not found.' });
      return true;
    }
    updateConfig({ selectedMapId: mapEntry[1] });
    json(res, 200, { selectedMapId: mapEntry[1] });
    return true;
  }
  if (mapEntry && req.method === 'PATCH' && !mapEntry[2]) {
    const value = await readJson(req);
    const name = String(value.name || '').trim();
    if (!name || name.length > 80) {
      json(res, 400, { error: 'Give the map a name up to 80 characters.' });
      return true;
    }
    const updated = updateMap(mapEntry[1], { name });
    updated
      ? json(res, 200, { id: updated.id, name: updated.name })
      : json(res, 404, { error: 'Map not found.' });
    return true;
  }
  if (mapEntry && req.method === 'DELETE' && !mapEntry[2]) {
    const items = maps();
    const index = items.findIndex((item) => item.id === mapEntry[1]);
    if (index < 0) {
      json(res, 404, { error: 'Map not found.' });
      return true;
    }
    const remaining = items.filter((item) => item.id !== mapEntry[1]);
    const selectedMapId =
      selectedMap()?.id === mapEntry[1]
        ? remaining[Math.min(index, remaining.length - 1)]?.id || null
        : selectedMap()?.id || null;
    updateConfig({ maps: remaining, selectedMapId });
    fs.unlinkSync(mapFile(items[index]));
    json(res, 200, { selectedMapId });
    return true;
  }

  return false;
}

/**
 * Handle requests that serve selected map artwork and persist rotation/calibration.
 * @param context Validated HTTP request context.
 * @param state Shared server dependencies and lifecycle state.
 * @returns A promise resolving to true when handled, otherwise false.
 */
async function handleCalibrationRequests(context, state) {
  const { req, res, pathname } = context;

  if (pathname === '/api/map/image' && (req.method === 'GET' || req.method === 'HEAD')) {
    const map = selectedMap();
    if (!map || !fs.existsSync(mapFile(map))) {
      json(res, 404, { error: 'No map image has been selected.' });
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(mapFile(map)).pipe(res);
    return true;
  }
  if (pathname === '/api/map/calibration' && req.method === 'GET') {
    const map = selectedMap();
    json(
      res,
      200,
      map
        ? {
            anchors: map.calibration?.anchors || [],
            rotation: map.rotation || 0,
            timeOffsetMs: map.calibration?.timeOffsetMs || 0,
            saved: !!map.calibration,
          }
        : null,
    );
    return true;
  }
  if (pathname === '/api/map/calibration' && req.method === 'DELETE') {
    const map = selectedMap();
    if (!map) {
      json(res, 404, { error: 'Select a map first.' });
      return true;
    }
    updateMap(map.id, { calibration: null });
    json(res, 200, { deleted: true });
    return true;
  }
  if (pathname === '/api/map/rotation' && req.method === 'POST') {
    const map = selectedMap();
    if (!map) {
      json(res, 404, { error: 'Select a map first.' });
      return true;
    }
    const value = await readJson(req);
    if (![0, 90, 180, 270].includes(value?.rotation)) {
      json(res, 400, { error: 'Invalid rotation.' });
      return true;
    }
    updateMap(map.id, { rotation: value.rotation });
    json(res, 200, { rotation: value.rotation });
    return true;
  }
  if (pathname === '/api/map/calibration' && req.method === 'POST') {
    const map = selectedMap();
    if (!map || !fs.existsSync(mapFile(map))) {
      json(res, 400, { error: 'Select a map first.' });
      return true;
    }
    const value = await readJson(req);
    if (
      !Array.isArray(value?.anchors) ||
      value.anchors.length !== 3 ||
      ![0, 90, 180, 270].includes(value.rotation ?? 0) ||
      !Number.isFinite(value.timeOffsetMs ?? 0) ||
      value.anchors.some(
        (anchor) =>
          !['x', 'y', 'u', 'v'].every((key) => Number.isFinite(anchor[key])) ||
          anchor.u < 0 ||
          anchor.u > 1 ||
          anchor.v < 0 ||
          anchor.v > 1,
      )
    ) {
      json(res, 400, { error: 'Map anchors or rotation are invalid.' });
      return true;
    }
    const [a, b, c] = value.anchors;
    const determinant = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
    if (Math.abs(determinant) < 1000) {
      json(res, 400, { error: 'Choose three locations that are spread across the map.' });
      return true;
    }
    updateMap(map.id, {
      rotation: value.rotation ?? 0,
      calibration: { anchors: value.anchors, timeOffsetMs: value.timeOffsetMs ?? 0 },
    });
    json(res, 200, {
      anchors: value.anchors,
      rotation: value.rotation ?? 0,
      timeOffsetMs: value.timeOffsetMs ?? 0,
    });
    return true;
  }

  return false;
}

/**
 * Handle HTTP endpoints for runtime status, local settings and shutdown.
 * @param context Validated request context with request/response and parsed URL.
 * @param state Shared server dependencies and mutable lifecycle state.
 * @returns A promise resolving to true when a response was handled, otherwise false.
 */
async function handleRuntimeRequests(context, state) {
  const { req, res, requestUrl, pathname } = context;
  const { db, onSettingsChanged, onShutdown } = state;
  if (pathname === '/api/status' && req.method === 'GET') {
    json(res, 200, {
      ...(state.updateInstalling
        ? {
            ...state.updateProgress,
            message: state.updateRestartAt
              ? Date.now() < state.updateRestartAt
                ? `Restarting in ${Math.ceil((state.updateRestartAt - Date.now()) / 1000)}s`
                : 'Restarting'
              : 'Updating...',
          }
        : replayStatus(db)),
      addedAt: activity.addedAt,
      addedSource: activity.addedSource || '',
      autoSwitchLastMatch: settings.autoSwitchLastMatch,
      backToTopSide: settings.backToTopSide,
      customCursorEnabled: settings.customCursorEnabled,
    });
    return true;
  }
  if (pathname === '/api/console' && req.method === 'GET') {
    const after = Number(requestUrl.searchParams.get('after')) || 0;
    json(res, 200, { entries: consoleEntries.filter((entry) => entry.id > after) });
    return true;
  }
  if (pathname === '/api/config' && req.method === 'GET') {
    json(res, 200, {
      version: releaseConfig.version,
      githubRepositoryUrl: releaseConfig.githubRepositoryUrl,
    });
    return true;
  }
  if (pathname === '/api/shutdown' && req.method === 'POST') {
    json(res, 200, { closing: true });
    setTimeout(onShutdown, 150).unref();
    return true;
  }
  if (pathname === '/api/settings' && req.method === 'GET') {
    const suggestions = readStatement(
      db,
      `SELECT s.owner AS playerID, COALESCE(NULLIF(p.username, ''), s.owner) AS username,
          COUNT(*) AS games FROM GameStats s LEFT JOIN Players p ON p.playerID = s.owner
          WHERE s.owner <> '' AND LOWER(s.owner) <> 'null' GROUP BY s.owner
          HAVING COUNT(*) >= 2 ORDER BY games DESC`,
    ).all();
    const player = readStatement(
      db,
      `SELECT COALESCE(NULLIF(username, ''), playerID) AS username FROM Players WHERE playerID = ?`,
    );
    const ownerProfiles = settings.playerIds.map((playerID) => ({
      playerID,
      username: player.get(playerID)?.username || playerID,
    }));
    json(res, 200, {
      settings,
      localUrl: appUrl,
      lanUrls: lanUrls(),
      ownerProfiles,
      suggestedPlayerIds: suggestions,
    });
    return true;
  }
  if (pathname === '/api/settings' && req.method === 'POST') {
    try {
      writeSettings(await readJson(req));
      onSettingsChanged();
      const player = readStatement(
        db,
        `SELECT COALESCE(NULLIF(username, ''), playerID) AS username FROM Players WHERE playerID = ?`,
      );
      const ownerProfiles = settings.playerIds.map((playerID) => ({
        playerID,
        username: player.get(playerID)?.username || playerID,
      }));
      json(res, 200, { settings, ownerProfiles });
      return true;
    } catch (error) {
      json(res, 400, { error: error.message || 'Could not save settings.' });
      return true;
    }
  }

  return false;
}

/**
 * Handle HTTP endpoints for update discovery, dismissal and installation.
 * @param context Validated request context with request/response and parsed URL.
 * @param state Shared server dependencies and mutable lifecycle state.
 * @returns A promise resolving to true when a response was handled, otherwise false.
 */
async function handleUpdateRequests(context, state) {
  const { req, res, requestUrl, pathname } = context;
  const { devMode, onShutdown } = state;
  if (pathname === '/api/update' && req.method === 'GET') {
    if (requestUrl.searchParams.get('refresh') === '1') state.updateCheck = checkForUpdate();
    json(res, 200, await state.updateCheck);
    return true;
  }
  if (pathname === '/api/update/dismiss' && req.method === 'POST') {
    const state = await state.updateCheck;
    const value = await readJson(req);
    if (!state.update || value.version !== state.update.version) {
      json(res, 400, { error: 'No matching update to dismiss.' });
      return true;
    }
    updateConfig({ dismissedUpdate: { version: state.update.version } });
    json(res, 200, { dismissed: state.update.version });
    return true;
  }
  if (pathname === '/api/update/install' && req.method === 'POST') {
    if (devMode || !sea.isSea()) {
      json(res, 409, { error: 'Automatic installation is available in the release EXE.' });
      return true;
    }
    if (state.updateInstalling) {
      json(res, 409, { error: 'An update is already being installed.' });
      return true;
    }
    const value = await readJson(req);
    const state = await state.updateCheck;
    if (!state.update || value.version !== state.update.version) {
      json(res, 409, { error: 'Check for updates again before installing.' });
      return true;
    }
    if (!state.update.asset) {
      json(res, 404, {
        error: `This release has no SniperHunter-${state.update.version}.zip asset.`,
      });
      return true;
    }
    state.updateInstalling = true;
    state.updateRestartAt = 0;
    state.updateProgress = { kind: 'updating', message: 'Updating...', progress: 0 };
    try {
      console.log(`Downloading Sniper Hunter ${state.update.version}...`);
      const prepared = await prepareUpdate(
        state.update.asset,
        dataRoot,
        updaterScriptSource,
        (progress) => {
          if (progress.phase === 'extracting') {
            state.updateProgress = { kind: 'updating', message: 'Updating...', progress: 95 };
            return;
          }
          const fraction = progress.total ? progress.bytes / progress.total : 0;
          state.updateProgress = {
            kind: 'updating',
            progress: Math.min(90, Math.max(0, fraction * 90)),
            message: 'Updating...',
          };
        },
      );
      await startInstaller(prepared, dataRoot, listenPort);
      state.updateRestartAt = Date.now() + 3000;
      state.updateProgress = { kind: 'updating', message: 'Restarting in 3s', progress: 95 };
      console.log(`Installing Sniper Hunter ${state.update.version}; restarting the program.`);
      json(res, 202, {
        restarting: true,
        version: state.update.version,
        restartInMs: state.updateRestartAt - Date.now(),
      });
      setTimeout(onShutdown, Math.max(0, state.updateRestartAt - Date.now())).unref();
      return true;
    } catch (error) {
      state.updateInstalling = false;
      state.updateRestartAt = 0;
      console.error('Update installation failed:', error);
      json(res, 500, { error: error.message || 'Could not install the update.' });
      return true;
    }
  }

  return false;
}

/**
 * Handle HTTP endpoints for schema inspection, saved queries and custom SQL execution.
 * @param context Validated request context with request/response and parsed URL.
 * @param state Shared server dependencies and mutable lifecycle state.
 * @returns A promise resolving to true when a response was handled, otherwise false.
 */
async function handleSqlRequests(context, state) {
  const { req, res, pathname } = context;
  const { db } = state;
  if (pathname === '/api/sql/schema' && req.method === 'GET') {
    const names = readStatement(
      db,
      `SELECT name FROM sqlite_master WHERE type = 'table'
          AND name NOT GLOB 'sqlite_*' AND name NOT GLOB 'PlayerSearch_*'
          AND name NOT IN ('PlayerSearch', 'PlayerCounts', 'PlayerPlatformCounts', 'PlayerCacheMeta',
            'ReplayBatches', 'ReplayImports') ORDER BY name`,
    ).all();
    const tables = names.map(({ name }) => {
      const quoted = `"${name.replaceAll('"', '""')}"`;
      const columns = db
        .prepare(`PRAGMA table_info(${quoted})`)
        .all()
        .map(({ name, type, notnull, pk }) => ({
          name,
          type,
          required: !!notnull,
          primaryKey: !!pk,
        }));
      let rows = 0;
      try {
        rows = readStatement(db, `SELECT COUNT(*) AS rows FROM ${quoted}`).get().rows;
      } catch {
        /* virtual table may be unavailable */
      }
      return { name, rows, columns };
    });
    json(res, 200, tables);
    return true;
  }
  if (pathname === '/api/sql' && req.method === 'POST') {
    try {
      const { sql } = await readJson(req);
      if (typeof sql !== 'string' || !sql.trim()) {
        json(res, 400, { error: 'Enter a SQL statement.' });
        return true;
      }
      let remaining = sql.trim();
      let output = { columns: [], rows: [], message: 'Statement executed.' };
      while (remaining) {
        const statement = db.prepare(remaining);
        const columns = statement.columns().map((column) => column.name);
        if (columns.length) {
          const rows = sqlResultRows(statement);
          output = {
            columns,
            rows,
            message: `${rows.length} row${rows.length === 1 ? '' : 's'} returned.`,
          };
        } else {
          const result = statement.run();
          output = {
            columns: [],
            rows: [],
            message: `Statement executed. ${result.changes} row${result.changes === 1 ? '' : 's'} changed.`,
          };
        }
        remaining = remaining.slice(statement.sourceSQL.length).trim();
        if (
          remaining &&
          !/\S/.test(remaining.replace(/--[^\r\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, ''))
        )
          break;
      }
      json(res, 200, output);
      return true;
    } catch (error) {
      json(res, 400, { error: error.message || 'Invalid SQL.' });
      return true;
    } finally {
      clearReadStatements(db);
    }
  }
  if (pathname === '/api/sql/saved' && req.method === 'GET') {
    json(res, 200, savedQueries());
    return true;
  }
  if (pathname === '/api/sql/saved' && req.method === 'POST') {
    try {
      const { name, sql } = await readJson(req);
      if (
        typeof name !== 'string' ||
        !name.trim() ||
        name.length > 100 ||
        typeof sql !== 'string' ||
        !sql.trim()
      ) {
        json(res, 400, { error: 'Enter a name and SQL statement.' });
        return true;
      }
      const entry = { id: require('node:crypto').randomUUID(), name: name.trim(), sql };
      writeSavedQueries([...savedQueries(), entry]);
      json(res, 201, entry);
      return true;
    } catch (error) {
      json(res, 400, { error: error.message || 'Could not save query.' });
      return true;
    }
  }
  const savedQueryPath = /^\/api\/sql\/saved\/([a-f0-9-]{36})$/.exec(pathname);
  if (savedQueryPath && req.method === 'DELETE') {
    const entries = savedQueries();
    writeSavedQueries(entries.filter((entry) => entry.id !== savedQueryPath[1]));
    json(res, 200, { deleted: savedQueryPath[1] });
    return true;
  }

  return false;
}

/**
 * Handle HTTP endpoints for development live-reload event streams.
 * @param context Validated request context with request/response and parsed URL.
 * @param state Shared server dependencies and mutable lifecycle state.
 * @returns A promise resolving to true when a response was handled, otherwise false.
 */
async function handleDevEvents(context, state) {
  const { req, res, pathname } = context;
  const { devMode, reloadClients } = state;
  if (devMode && pathname === '/__dev/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    reloadClients.add(res);
    req.on('close', () => reloadClients.delete(res));
    return true;
  }

  return false;
}

/**
 * Handle HTTP endpoints for match lists, metrics, details and filtered neighbors.
 * @param context Validated request context with request/response and parsed URL.
 * @param state Shared server dependencies and mutable lifecycle state.
 * @returns A promise resolving to true when a response was handled, otherwise false.
 */
async function handleMatchRequests(context, state) {
  const { req, res, requestUrl, pathname } = context;
  const { db, skinSync } = state;
  if (pathname === '/api/matches/latest' && req.method === 'GET') {
    const match = readStatement(
      db,
      'SELECT * FROM GameStats ORDER BY timestamp DESC LIMIT 1',
    ).get();
    json(
      res,
      200,
      match ? matchDetails(db, match) : { match: null, platforms: [], eliminations: [], teams: [] },
    );
    return true;
  }
  if (pathname === '/api/matches/metrics' && req.method === 'GET') {
    const filters = matchFilters(requestUrl, '', { skipKind: true });
    if (filters.error) {
      json(res, 400, { error: filters.error });
      return true;
    }
    const row = readStatement(
      db,
      `SELECT COUNT(*) AS games, ROUND(AVG(NULLIF(placement, 0)), 2) AS averagePlacement,
          COALESCE(SUM(players), 0) AS realPlayers, COALESCE(SUM(bots), 0) AS bots,
          COALESCE(SUM(CASE WHEN LOWER(mode) LIKE '%creative%' THEN 1 ELSE 0 END), 0) AS creativeGames,
          COALESCE(SUM(CASE WHEN LOWER(mode) NOT LIKE '%creative%' THEN 1 ELSE 0 END), 0) AS nonCreativeGames,
          COALESCE(SUM(CASE WHEN distanceTravelled > 0 THEN distanceTravelled ELSE 0 END), 0) AS distanceTravelled,
          COALESCE(SUM(CASE WHEN duration > 0 THEN duration ELSE 0 END), 0) AS timePlayed,
          COALESCE(SUM(CASE WHEN placement = 1 THEN 1 ELSE 0 END), 0) AS gamesWon,
          COALESCE(SUM(CASE WHEN placement > 1 THEN 1 ELSE 0 END), 0) AS losses,
          COALESCE(SUM(CASE WHEN kills > 0 THEN kills ELSE 0 END), 0) AS totalKills
          FROM GameStats ${filters.where}`,
    ).get(...filters.args);
    const timeFilters = matchFilters(requestUrl);
    const timePlayed = requestUrl.searchParams.has('kind')
      ? readStatement(
          db,
          `SELECT COALESCE(SUM(CASE WHEN duration > 0 THEN duration ELSE 0 END), 0) AS timePlayed
              FROM GameStats ${timeFilters.where}`,
        ).get(...timeFilters.args).timePlayed
      : row.timePlayed;
    const total = row.realPlayers + row.bots;
    json(res, 200, {
      ...row,
      timePlayed,
      realPercent: total ? (row.realPlayers * 100) / total : 0,
      creativePercent: row.games ? (row.creativeGames * 100) / row.games : 0,
      nonCreativePercent: row.games ? (row.nonCreativeGames * 100) / row.games : 0,
      kd: row.losses ? row.totalKills / row.losses : null,
      winPercent: row.nonCreativeGames ? (row.gamesWon * 100) / row.nonCreativeGames : 0,
    });
    return true;
  }
  if (pathname === '/api/matches' && req.method === 'GET') {
    const pageText = requestUrl.searchParams.get('page') || '1';
    if (!/^\d+$/.test(pageText) || Number(pageText) < 1 || Number(pageText) > 100000) {
      json(res, 400, { error: 'Page must be a positive number.' });
      return true;
    }
    const page = Number(pageText);
    const pageSize = 25;
    const filters = matchFilters(requestUrl);
    if (filters.error) {
      json(res, 400, { error: filters.error });
      return true;
    }
    const matches = readStatement(
      db,
      `
          SELECT gameID, timestamp, replayName, mode, placement
          FROM GameStats ${filters.where} ORDER BY timestamp ${gameDirection(requestUrl)}, gameID ${gameDirection(requestUrl)} LIMIT ? OFFSET ?
        `,
    ).all(...filters.args, pageSize, (page - 1) * pageSize);
    const total = readStatement(db, `SELECT COUNT(*) AS total FROM GameStats ${filters.where}`).get(
      ...filters.args,
    ).total;
    json(res, 200, { games: matches, total, page, pageSize });
    return true;
  }
  const neighborsPath = /^\/api\/matches\/([^/]+)\/neighbors$/.exec(pathname);
  if (neighborsPath && req.method === 'GET') {
    const context = requestUrl.searchParams.get('from') || 'games';
    if (!['games', 'player'].includes(context)) {
      json(res, 400, { error: 'Invalid replay list context.' });
      return true;
    }
    let source, args;
    if (context === 'player') {
      const playerID = requestUrl.searchParams.get('player') || '';
      if (!playerID || playerID.length > 255) {
        json(res, 400, { error: 'Player ID is required.' });
        return true;
      }
      const filters = playerGameFilters(requestUrl, playerID);
      if (filters.error) {
        json(res, 400, { error: filters.error });
        return true;
      }
      source = `SELECT s.gameID, s.timestamp FROM GamePlayers gp JOIN GameStats s ON s.gameID = gp.gameID WHERE ${filters.where}`;
      args = filters.args;
    } else {
      const filters = matchFilters(requestUrl);
      if (filters.error) {
        json(res, 400, { error: filters.error });
        return true;
      }
      source = `SELECT gameID, timestamp FROM GameStats ${filters.where}`;
      args = filters.args;
    }
    const neighbor = readStatement(
      db,
      `WITH eligible AS (${source}), ordered AS (
          SELECT gameID, LAG(gameID) OVER (ORDER BY timestamp ${gameDirection(requestUrl)}, gameID ${gameDirection(requestUrl)}) AS newer,
            LEAD(gameID) OVER (ORDER BY timestamp ${gameDirection(requestUrl)}, gameID ${gameDirection(requestUrl)}) AS older FROM eligible)
          SELECT newer, older FROM ordered WHERE gameID = ?`,
    ).get(...args, decodeURIComponent(neighborsPath[1]));
    json(res, 200, neighbor || { newer: null, older: null });
    return true;
  }
  const matchPath = /^\/api\/matches\/([^/]+)$/.exec(pathname);
  if (matchPath && req.method === 'GET') {
    const match = readStatement(db, 'SELECT * FROM GameStats WHERE gameID = ?').get(
      decodeURIComponent(matchPath[1]),
    );
    match ? json(res, 200, matchDetails(db, match)) : json(res, 404, { error: 'Match not found.' });
    return true;
  }
  if (matchPath && req.method === 'DELETE') {
    const id = decodeURIComponent(matchPath[1]);
    if (!readStatement(db, 'SELECT 1 FROM GameStats WHERE gameID = ?').get(id)) {
      json(res, 404, { error: 'Match not found.' });
      return true;
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM GameEliminations WHERE gameID = ?').run(id);
      db.prepare('DELETE FROM GamePlayers WHERE gameID = ?').run(id);
      db.prepare('DELETE FROM GameStats WHERE gameID = ?').run(id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    rebuildPlayerCounts(db);
    json(res, 200, { deleted: id });
    return true;
  }
  if (pathname === '/api/databases/import' && req.method === 'POST') {
    await uploadDatabase(req, res, db, skinSync);
    return true;
  }

  return false;
}

/**
 * Handle HTTP endpoints for platform-group player totals.
 * @param context Validated request context with request/response and parsed URL.
 * @param state Shared server dependencies and mutable lifecycle state.
 * @returns A promise resolving to true when a response was handled, otherwise false.
 */
async function handlePlatformMetrics(context, state) {
  const { req, res, pathname } = context;
  const { db } = state;
  if (pathname === '/api/players/metrics' && req.method === 'GET') {
    const rows = readStatement(
      db,
      'SELECT category, code, players FROM PlayerPlatformCounts',
    ).all();
    const total = rows.reduce((sum, row) => sum + row.players, 0);
    const groups = new Map();
    const configured = new Map(
      defaultPlatformGroups.flatMap((group) => group.codes.map((code) => [code, group.name])),
    );
    for (const row of rows) {
      const code = String(row.code || '').toUpperCase();
      const category =
        !code || code === 'NULL'
          ? row.category === 'AI'
            ? 'AI'
            : 'Unknown'
          : configured.get(code) || code;
      if (!groups.has(category))
        groups.set(category, {
          key: category,
          label: category === 'AI' ? 'Bots / AI' : category,
          players: 0,
          percent: 0,
          variants: [],
        });
      const group = groups.get(category);
      group.players += row.players;
      if (code && code !== 'NULL' && category !== 'AI')
        group.variants.push({ code, players: row.players });
    }
    for (const group of groups.values()) {
      group.percent = total ? (group.players * 100) / total : 0;
      const order = defaultPlatformGroups.find((item) => item.name === group.key)?.codes || [];
      group.variants.sort(
        (a, b) => order.indexOf(a.code) - order.indexOf(b.code) || a.code.localeCompare(b.code),
      );
    }
    json(res, 200, {
      total,
      platforms: [...groups.values()].sort((a, b) => b.players - a.players),
    });
    return true;
  }

  return false;
}

/**
 * Handle HTTP endpoints for paged, sorted and filtered player search.
 * @param context Validated request context with request/response and parsed URL.
 * @param state Shared server dependencies and mutable lifecycle state.
 * @returns A promise resolving to true when a response was handled, otherwise false.
 */
async function handlePlayerDirectory(context, state) {
  const { req, res, requestUrl, pathname } = context;
  const { db } = state;
  if (pathname === '/api/players' && req.method === 'GET') {
    let query = (requestUrl.searchParams.get('q') || '').trim().slice(0, 100);
    const usernameOnly = query.startsWith('"') || query.startsWith("'");
    if (usernameOnly) {
      const quote = query[0];
      query = query.slice(1);
      if (query.endsWith(quote)) query = query.slice(0, -1);
    }
    const sort = requestUrl.searchParams.get('sort') || 'games';
    const direction = requestUrl.searchParams.get('direction') === 'asc' ? 'ASC' : 'DESC';
    const column = { username: 'username', id: 'playerID', games: 'games', skin: 'skin' }[sort];
    if (!column) {
      json(res, 400, { error: 'Invalid sort.' });
      return true;
    }
    const platform = requestUrl.searchParams.get('platform') || '';
    const platformGroup = defaultPlatformGroups.find((group) => group.name === platform);
    if (
      platform &&
      platform !== 'AI' &&
      platform !== 'Unknown' &&
      !platformGroup &&
      !/^[A-Za-z0-9]{2,8}$/.test(platform)
    ) {
      json(res, 400, { error: 'Invalid platform filter.' });
      return true;
    }
    const clauses = [];
    const args = [];
    if (query.length >= 3) {
      clauses.push('c.rowid IN (SELECT rowid FROM PlayerSearch WHERE PlayerSearch MATCH ?)');
      const phrase = `"${query.replaceAll('"', '""')}"`;
      args.push(usernameOnly ? `username : ${phrase}` : phrase);
    } else if (query) {
      const pattern = searchTerm(query);
      if (usernameOnly) {
        clauses.push("c.username LIKE ? ESCAPE '\\'");
        args.push(pattern);
      } else {
        clauses.push(`(c.username LIKE ? ESCAPE '\\' OR c.playerID LIKE ? ESCAPE '\\'
              OR c.platform LIKE ? ESCAPE '\\' OR c.skin LIKE ? ESCAPE '\\')`);
        args.push(pattern, pattern, pattern, pattern);
      }
    }
    if (requestUrl.searchParams.get('showAI') === '0') clauses.push('c.isAI = 0');
    if (platform) {
      if (platform === 'AI') clauses.push('c.isAI = 1');
      else if (platform === 'Unknown')
        clauses.push("c.isAI = 0 AND c.platformCode IN ('', 'NULL')");
      else if (platformGroup) {
        clauses.push(`c.platformCode IN (${platformGroup.codes.map(() => '?').join(', ')})`);
        args.push(...platformGroup.codes);
      } else {
        clauses.push('c.platformCode = ?');
        args.push(platform.toUpperCase());
      }
    }
    const order = `c.${column}${column === 'username' || column === 'skin' ? ' COLLATE NOCASE' : ''}`;
    const rawCursor = requestUrl.searchParams.get('cursor');
    if (rawCursor) {
      try {
        if (rawCursor.length > 1024) throw new Error('long cursor');
        const cursor = JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8'));
        if (
          typeof cursor.id !== 'string' ||
          (column === 'games' ? typeof cursor.value !== 'number' : typeof cursor.value !== 'string')
        )
          throw new Error('invalid cursor');
        const compare = direction === 'ASC' ? '>' : '<';
        clauses.push(`(${order} ${compare} ? OR (${order} = ? AND c.playerID ${compare} ?))`);
        args.push(cursor.value, cursor.value, cursor.id);
      } catch {
        json(res, 400, { error: 'Invalid player cursor.' });
        return true;
      }
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = readStatement(
      db,
      `SELECT c.playerID, c.username, c.platform, c.platformCode, c.skin,
          c.category, c.isAI, c.games FROM PlayerCounts c ${where}
          ORDER BY ${order} ${direction}, c.playerID ${direction} LIMIT 61`,
    ).all(...args);
    const players = result.slice(0, 60);
    const last = players.at(-1);
    const nextCursor =
      result.length > 60 && last
        ? Buffer.from(JSON.stringify({ value: last[column], id: last.playerID })).toString(
            'base64url',
          )
        : null;
    json(res, 200, { players, nextCursor });
    return true;
  }

  return false;
}

/**
 * Handle HTTP endpoints for profile summaries and shared-game encounter filters.
 * @param context Validated request context with request/response and parsed URL.
 * @param state Shared server dependencies and mutable lifecycle state.
 * @returns A promise resolving to true when a response was handled, otherwise false.
 */
async function handlePlayerProfile(context, state) {
  const { req, res, requestUrl, pathname } = context;
  const { db } = state;
  const playerPath = /^\/api\/players\/([^/]+)$/.exec(pathname);
  if (playerPath && req.method === 'GET') {
    const id = decodeURIComponent(playerPath[1]);
    const player = readStatement(
      db,
      `SELECT c.playerID, c.username, c.platform, c.skin, c.isAI, c.games
          FROM PlayerCounts c
          WHERE c.playerID = ?`,
    ).get(id);
    player ? json(res, 200, player) : json(res, 404, { error: 'Player not found.' });
    return true;
  }
  const playerSummary = /^\/api\/players\/([^/]+)\/summary$/.exec(pathname);
  if (playerSummary && req.method === 'GET') {
    const id = decodeURIComponent(playerSummary[1]);
    const filters = matchFilters(requestUrl, 's.', { skipPlacement: true });
    if (filters.error) {
      json(res, 400, { error: filters.error });
      return true;
    }
    const placement = requestUrl.searchParams.get('placement');
    const placementValue = placement ? Number(placement) : null;
    const extra = filters.where ? ` AND ${filters.where.slice(6)}` : '';
    const teammates = `EXISTS (SELECT 1 FROM GamePlayers ownerGp
          JOIN GamePlayers targetGp ON targetGp.gameID = ownerGp.gameID AND targetGp.team = ownerGp.team
          WHERE ownerGp.gameID = e.gameID AND ${ownPlayerCondition('ownerGp.playerID')}
            AND targetGp.playerID = ? AND ownerGp.team > 0)`;
    const games = readStatement(
      db,
      `SELECT COUNT(DISTINCT gp.gameID) AS games
          FROM GamePlayers gp JOIN GameStats s ON s.gameID = gp.gameID
          WHERE gp.playerID = ?${extra}${placementValue === null ? '' : ' AND gp.placement = ?'}`,
    ).get(id, ...filters.args, ...(placementValue === null ? [] : [placementValue])).games;
    if (settings.playerIds.includes(id)) {
      json(res, 200, {
        games,
        youEliminated: 0,
        youKnocked: 0,
        eliminatedYou: 0,
        knockedYou: 0,
        trolledYou: 0,
        trolledKnocked: 0,
      });
      return true;
    }
    const placementExtra =
      placementValue === null
        ? ''
        : ` AND EXISTS (SELECT 1 FROM GamePlayers placementGp
          WHERE placementGp.gameID = e.gameID AND placementGp.playerID = ? AND placementGp.placement = ?)`;
    /**
     * Build an EXISTS predicate for a player encounter in the enclosing profile query.
     * @param column Trusted elimination participant column.
     * @param condition Trusted event/team condition appended to the query.
     * @returns A correlated SQL EXISTS expression with player bindings supplied by the caller.
     */
    const encounter = (column, condition) =>
      readStatement(
        db,
        `WITH encounters AS MATERIALIZED (
          SELECT CAST(e.knocked AS INTEGER) AS knocked, ${teammates} AS sameTeam
          FROM GameEliminations e JOIN GameStats s ON s.gameID = e.gameID
          WHERE e.${column} = ? AND ${condition}${extra}${placementExtra}
        ) SELECT
          COALESCE(SUM(sameTeam = 0 AND knocked = 0), 0) AS eliminated,
          COALESCE(SUM(sameTeam = 0 AND knocked != 0), 0) AS knocked,
          COALESCE(SUM(sameTeam = 1 AND knocked = 0), 0) AS teamEliminated,
          COALESCE(SUM(sameTeam = 1 AND knocked != 0), 0) AS teamKnocked
          FROM encounters`,
      ).get(id, id, ...filters.args, ...(placementValue === null ? [] : [id, placementValue]));
    const you = encounter('killedID', ownPlayerCondition('e.killerID'));
    const them = encounter('killerID', ownPlayerCondition('e.killedID'));
    json(res, 200, {
      games,
      youEliminated: you.eliminated,
      youKnocked: you.knocked,
      eliminatedYou: them.eliminated,
      knockedYou: them.knocked,
      trolledYou: them.teamEliminated,
      trolledKnocked: them.teamKnocked,
    });
    return true;
  }
  const playerGames = /^\/api\/players\/([^/]+)\/games$/.exec(pathname);
  if (playerGames && req.method === 'GET') {
    const page = Number(requestUrl.searchParams.get('page') || 1);
    if (!Number.isInteger(page) || page < 1 || page > 100000) {
      json(res, 400, { error: 'Invalid page.' });
      return true;
    }
    const id = decodeURIComponent(playerGames[1]);
    const filters = playerGameFilters(requestUrl, id);
    if (filters.error) {
      json(res, 400, { error: filters.error });
      return true;
    }
    const games = readStatement(
      db,
      `SELECT s.gameID, s.replayName, s.timestamp, s.mode,
          gp.placement, gp.kills FROM GamePlayers gp JOIN GameStats s ON s.gameID = gp.gameID
          WHERE ${filters.where} ORDER BY s.timestamp ${gameDirection(requestUrl)}, s.gameID ${gameDirection(requestUrl)} LIMIT 25 OFFSET ?`,
    ).all(...filters.args, (page - 1) * 25);
    json(res, 200, { games, hasMore: games.length === 25 });
    return true;
  }

  return false;
}

/**
 * Handle HTTP endpoints for manual replay selection, uploads and batch status.
 * @param context Validated request context with request/response and parsed URL.
 * @param state Shared server dependencies and mutable lifecycle state.
 * @returns A promise resolving to true when a response was handled, otherwise false.
 */
async function handleReplayRequests(context, state) {
  const { req, res, pathname, host } = context;
  const { db, enqueue, skinSync } = state;
  if (pathname === '/api/replays' && req.method === 'GET') {
    const rows = readStatement(
      db,
      'SELECT id, name, status, addedAt, size, error, source FROM ReplayImports ORDER BY addedAt DESC',
    ).all();
    json(res, 200, rows);
    return true;
  }
  if (pathname === '/api/replays/pick-local' && req.method === 'POST') {
    if (process.platform !== 'win32' || host !== new URL(appUrl).host || !fs.existsSync(demoRoot)) {
      json(res, 409, { error: 'The Fortnite Demos folder is unavailable for the local picker.' });
      return true;
    }
    if (!fs.existsSync(parserExe)) {
      json(res, 503, { error: 'SniperHunterParser.exe is not available.' });
      return true;
    }
    const selected = await chooseLocalReplays();
    if (!Array.isArray(selected) || selected.length > 1000) {
      json(res, 400, { error: 'Invalid replay selection.' });
      return true;
    }
    const files = selected.filter(
      (file) =>
        typeof file === 'string' &&
        path.extname(file).toLowerCase() === '.replay' &&
        fs.existsSync(file) &&
        fs.statSync(file).isFile() &&
        fs.statSync(file).size <= MAX_UPLOAD,
    );
    if (!files.length) {
      json(res, 200, { total: 0 });
      return true;
    }
    const batchID = require('node:crypto').randomUUID();
    const addedAt = new Date().toISOString();
    db.prepare('INSERT INTO ReplayBatches (id, total, addedAt) VALUES (?, ?, ?)').run(
      batchID,
      files.length,
      addedAt,
    );
    const insert =
      db.prepare(`INSERT INTO ReplayImports (id, name, status, addedAt, size, batchID, source, sourcePath)
          VALUES (?, ?, 'awaiting-reader', ?, ?, ?, 'local', ?)`);
    for (const file of files)
      insert.run(
        require('node:crypto').randomUUID().replaceAll('-', ''),
        path.basename(file),
        addedAt,
        fs.statSync(file).size,
        batchID,
        file,
      );
    activity.activeBatchId = batchID;
    activity.batchDoneAt = 0;
    enqueue();
    json(res, 200, { total: files.length, batchID });
    return true;
  }
  if (pathname === '/api/replays' && req.method === 'POST') {
    await addReplay(req, res, db, enqueue, skinSync);
    return true;
  }
  const batchPath = /^\/api\/replays\/batches\/([a-f0-9-]{36})$/.exec(pathname);
  if (batchPath && req.method === 'GET') {
    const batch = readStatement(db, 'SELECT total FROM ReplayBatches WHERE id = ?').get(
      batchPath[1],
    );
    if (!batch) {
      json(res, 404, { error: 'Replay batch not found.' });
      return true;
    }
    const entries = readStatement(
      db,
      'SELECT name, status, error FROM ReplayImports WHERE batchID = ? ORDER BY addedAt, rowid',
    ).all(batchPath[1]);
    json(res, 200, {
      total: batch.total,
      added: entries.filter((row) => row.status === 'decoded').length,
      duplicates: entries.filter((row) => row.status === 'duplicate').length,
      parsed: entries.filter((row) => row.status === 'decoded' || row.status === 'duplicate')
        .length,
      failed: entries.filter((row) => row.status === 'failed').length,
      errors: entries
        .filter((row) => row.status === 'failed')
        .map((row) => ({
          name: row.name,
          message: row.error || 'Reader could not parse replay.',
        })),
    });
    return true;
  }
  const entryMatch = /^\/api\/replays\/([a-f0-9]{32})$/.exec(pathname);
  if (entryMatch && req.method === 'GET') {
    const entry = readStatement(
      db,
      'SELECT id, name, status, addedAt, size, error, source FROM ReplayImports WHERE id = ?',
    ).get(entryMatch[1]);
    entry ? json(res, 200, entry) : json(res, 404, { error: 'Replay not found.' });
    return true;
  }

  return false;
}

/**
 * Handle HTTP endpoints for skin images, browser assets and Angular route fallbacks.
 * @param context Validated request context with request/response and parsed URL.
 * @param state Shared server dependencies and mutable lifecycle state.
 * @returns A promise resolving to true when a response was handled, otherwise false.
 */
async function handleAssetRequests(context, state) {
  const { req, res, pathname } = context;
  const { assets, devMode, skinSync } = state;
  if (pathname.startsWith('/api/')) {
    json(res, 404, { error: 'Not found.' });
    return true;
  }
  if (req.method !== 'GET') {
    json(res, 405, { error: 'Method not allowed.' });
    return true;
  }
  // Angular briefly removes dist/browser while its watch build replaces it.
  // Keep serving the previous complete build until the replacement is ready.
  let currentAssets = assets;
  if (devMode) {
    try {
      state.lastCompleteAssets = loadAssets();
    } catch {
      /* build in progress */
    }
    currentAssets = state.lastCompleteAssets;
  }
  const skinMatch = /^\/assets\/skins\/([A-Za-z0-9_-]{1,128})\.png$/.exec(pathname);
  if (skinMatch) {
    const file = skinSync.skinFile(skinMatch[1]);
    if (fs.existsSync(file)) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': fs.statSync(file).size });
      fs.createReadStream(file).pipe(res);
      return true;
    }
    json(res, 404, { error: 'Skin icon not found.' });
    return true;
  }
  const key = currentAssets.has(pathname) ? pathname : '/index.html';
  serveAsset(res, key, currentAssets, devMode);
  return true;
  return false;
}

/**
 * Dependencies supplied by startup; grouping them avoids a fragile positional argument list.
 * @typedef {object} ServerOptions
 * @property {import('node:sqlite').DatabaseSync} db Active application database.
 * @property {Map<string, Buffer>} assets Embedded or initially loaded browser assets.
 * @property {boolean} devMode Whether asset refresh and live reload are enabled.
 * @property {Set<import('node:http').ServerResponse>} reloadClients Live-reload SSE subscribers.
 * @property {function(): void} enqueue Wake the serial parser queue.
 * @property {function(string, string): Promise<object>} loadMap Parse a replay path for an expected game ID.
 * @property {object} skinSync Missing-skin queue and database scanning operations.
 * @property {Promise<object>} initialUpdateCheck Startup release-check result.
 * @property {function(): void} onSettingsChanged Apply preferences affecting background services.
 * @property {function(): void} onShutdown Close the server, tray and instance endpoint.
 */

/**
 * Validated request information passed to feature handlers after access checks.
 * @typedef {object} RequestContext
 * @property {import('node:http').IncomingMessage} req Request stream and headers.
 * @property {import('node:http').ServerResponse} res Response owned by the first matching handler.
 * @property {URL} requestUrl Parsed URL with query parameters.
 * @property {string} pathname Route path without its query string.
 * @property {string} host Lowercase request hostname used by local-only operations.
 */

/**
 * Create the HTTP application with shared services and dispatch requests to feature-specific handlers.
 * @param {ServerOptions} options Database, assets, queue controls and lifecycle callbacks.
 * @returns {import('node:http').Server} Unbound HTTP server; main owns listening and shutdown.
 */
function createServer(options) {
  const { assets } = options;
  const state = {
    ...options,
    updateCheck: options.initialUpdateCheck,
    updateInstalling: false,
    updateRestartAt: 0,
    updateProgress: { kind: 'updating', message: 'Updating...', progress: 0 },
    lastCompleteAssets: assets,
  };
  /** Hostnames considered local for mutation access; external hosts can use the read-only proxy view. */
  const allowedHosts = new Set([
    new URL(appUrl).host,
    `localhost${listenPort === 80 ? '' : `:${listenPort}`}`,
    `sniperhunter.localhost${listenPort === 80 ? '' : `:${listenPort}`}`,
    ...lanUrls().map((url) => new URL(url).host),
  ]);
  /** Ordered route groups. Each returns true only after it owns the response; assets are the final fallback. */
  const handlers = [
    handleMovementRequests,
    handleSavedMapRequests,
    handleCalibrationRequests,
    handleRuntimeRequests,
    handleUpdateRequests,
    handleSqlRequests,
    handleDevEvents,
    handleMatchRequests,
    handlePlatformMetrics,
    handlePlayerDirectory,
    handlePlayerProfile,
    handleReplayRequests,
    handleAssetRequests,
  ];
  return http.createServer((req, res) => {
    (async () => {
      const host = (req.headers.host || '').toLowerCase();
      if (!/^[a-z0-9.-]+(?::\d{1,5})?$/.test(host))
        return json(res, 421, { error: 'Invalid host.' });
      const forwarded = [
        'forwarded',
        'x-forwarded-for',
        'x-forwarded-host',
        'x-forwarded-proto',
        'x-real-ip',
      ].some((header) => req.headers[header] !== undefined);
      const readOnly =
        !allowedHosts.has(host) || forwarded || !isPrivateClient(req.socket.remoteAddress);
      if (readOnly && !settings.proxyEnabled) {
        res.writeHead(403, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        const icon = assets.get('/assets/icon.ico')?.toString('base64') || '';
        res.end(
          `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sniper Hunter by Guardian Seeker</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#18191a;color:#f5f6f7;font:1rem system-ui,sans-serif}.blocked{text-align:center}.emblem{position:relative;width:113px;height:113px;margin:auto;display:grid;place-items:center}.emblem img{width:94px;height:94px}.emblem:before{content:"";position:absolute;inset:10px;border:14px solid transparent;border-left-color:#8d021f;border-right-color:#8d021f;border-radius:50%;animation:spin 1.25s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}p{margin:1.1rem 0 0}</style></head><body><main class="blocked"><div class="emblem"><img src="data:image/x-icon;base64,${icon}" alt="Sniper Hunter"></div><p>Proxy views have been disabled.</p></main></body></html>`,
        );
        return;
      }
      if (
        !readOnly &&
        !['GET', 'HEAD'].includes(req.method) &&
        req.headers.origin !== `http://${host}`
      )
        return json(res, 403, { error: 'Invalid origin.' });
      const requestUrl = new URL(req.url, appUrl);
      const pathname = requestUrl.pathname;
      if (pathname === '/api/access' && req.method === 'GET') return json(res, 200, { readOnly });
      if (
        readOnly &&
        pathname.startsWith('/api/') &&
        !(
          (req.method === 'GET' &&
            (pathname === '/api/status' ||
              pathname === '/api/config' ||
              pathname === '/api/maps' ||
              pathname.startsWith('/api/matches') ||
              pathname.startsWith('/api/players') ||
              pathname.startsWith('/api/map/'))) ||
          (req.method === 'HEAD' && pathname === '/api/map/image')
        )
      )
        return json(res, 403, { error: 'This public view is read-only.' });

      const context = { req, res, requestUrl, pathname, host };
      for (const handler of handlers) {
        if (await handler(context, state)) return;
      }
    })().catch((error) => {
      console.error(error);
      if (!res.headersSent) json(res, 500, { error: 'Server error.' });
      else res.destroy();
    });
  });
}

/**
 * Validate prerequisites, claim the instance, start services and listen before opening the browser.
 * @returns A promise resolving once startup is complete; failures reach the top-level error prompt.
 */
async function main() {
  const launchArgs = process.argv.slice(2);
  listenPort = parsePort(launchArgs);
  const portSpecified = launchArgs.includes('-port') || launchArgs.includes('--port');
  const runningUrl = await claimInstance();
  if (runningUrl) {
    if (!process.argv.includes('--no-browser')) openBrowser(runningUrl);
    return;
  }
  const runtime = checkDotnet10();
  if (!runtime.installed) throw new Error(runtime.message);
  const hostname = await ensureHostname();
  appUrl = `http://${hostname}${listenPort === 80 ? '' : `:${listenPort}`}/`;
  const assets = loadAssets();
  const db = openDatabase();
  const skinSync = createSkinSync(db);
  const readerQueue = createReaderQueue(db, skinSync);
  const reloadClients = new Set();
  if (devMode) {
    /**
     * Fingerprint generated development files to detect completed Angular rebuilds.
     * @returns A comparable build stamp, or null while output is unavailable.
     */
    const buildStamp = () => {
      try {
        return ['index.html', 'main.js', 'styles.css']
          .map((name) => {
            const file = fs.statSync(path.join(webRoot, name));
            return `${file.mtimeMs}:${file.size}`;
          })
          .join('|');
      } catch {
        return null;
      }
    };
    let lastBuild = buildStamp();
    let candidate = null;
    let candidateAt = 0;
    setInterval(() => {
      const next = buildStamp();
      if (!next || next === lastBuild) return;
      if (next !== candidate) {
        candidate = next;
        candidateAt = Date.now();
        return;
      }
      if (Date.now() - candidateAt < 700) return;
      lastBuild = next;
      for (const client of reloadClients) client.write('event: reload\ndata: updated\n\n');
    }, 350).unref();
  }
  const updateCheck = checkForUpdate();
  const updateErrorLog = path.join(dataRoot, 'update-error.log');
  if (fs.existsSync(updateErrorLog)) {
    try {
      console.error('Previous update failed:', fs.readFileSync(updateErrorLog, 'utf8'));
      fs.unlinkSync(updateErrorLog);
    } catch (error) {
      console.error('Could not read update error log:', error);
    }
  }
  let server;
  let trayChild = null;
  /**
   * Stop the HTTP server, IPC endpoint and tray before exiting the process.
   * @returns Nothing; schedules process termination.
   */
  const closeApp = () => {
    trayChild?.kill();
    instanceServer?.close();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    server.closeAllConnections?.();
    setTimeout(() => process.exit(0), 2000).unref();
  };
  /**
   * Apply the current tray-visibility setting without starting duplicate tray hosts.
   * @returns Nothing; creates or stops the tray child as needed.
   */
  const updateTray = () => {
    if (settings.hideTrayIcon) {
      trayChild?.kill();
      trayChild = null;
    } else if (!trayChild || trayChild.exitCode !== null)
      trayChild = startTrayIcon(assets, closeApp);
  };
  const serverOptions = {
    db,
    assets,
    devMode,
    reloadClients,
    enqueue: readerQueue.enqueue,
    loadMap: readerQueue.loadMap,
    skinSync,
    initialUpdateCheck: updateCheck,
    onSettingsChanged: updateTray,
    onShutdown: closeApp,
  };
  /**
   * Create a server with host permissions for the selected port and start listening.
   * @param port TCP port to bind on all local interfaces.
   * @returns A promise that resolves when the listener is ready.
   */
  async function listenOn(port) {
    server = createServer(serverOptions);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '0.0.0.0', resolve);
    });
  }
  try {
    await listenOn(listenPort);
  } catch (error) {
    if (
      portSpecified ||
      listenPort !== 80 ||
      !['EADDRINUSE', 'EACCES', 'EPERM'].includes(error.code)
    )
      throw error;
    console.warn(`Port 80 is unavailable (${error.code}); trying port 8008.`);
    listenPort = 8008;
    appUrl = `http://${hostname}:8008/`;
    await listenOn(listenPort);
  }
  instanceReady = true;
  sendInstanceUrl();
  updateTray();
  process.once('exit', () => trayChild?.kill());
  try {
    startDemoWatcher(readerQueue.enqueue, readerQueue.resetWatcher);
  } catch (error) {
    activity.watcherError = 'Fortnite demo folder watcher could not start.';
    console.warn(activity.watcherError, error);
  }
  readerQueue.start();
  skinSync.scanDatabase();
  setInterval(() => skinSync.scanDatabase(), 60 * 1000).unref();
  console.log(`Sniper Hunter: ${appUrl}`);
  console.log(`Database: ${databasePath}`);
  if (settings.openBrowserOnLaunch && !process.argv.includes('--no-browser')) {
    openBrowser(appUrl);
  }
}

main().catch((error) => {
  for (const socket of instanceSockets) socket.destroy();
  instanceServer?.close();
  showError(
    error.code === 'EADDRINUSE'
      ? `Port ${listenPort} is already in use. Sniper Hunter could not start.`
      : `Sniper Hunter could not start: ${error.message}`,
  );
  process.exitCode = 1;
});
