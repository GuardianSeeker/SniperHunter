import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { paths, ensureAngularDependencies } from './workspace.mjs';

/** Shared CLI paths; the backend serves Angular's generated files in watch mode. */
const { root, web, angularCli } = paths;

/**
 * Build once before starting the server, then run Angular watch and the backend as paired child processes.
 * @returns Nothing; child processes keep the development session alive.
 */
function startDevelopment() {
  ensureAngularDependencies('Run npm install and npm ci --prefix web first.');
  const initial = spawnSync(
    process.execPath,
    [angularCli, 'build', '--configuration', 'development'],
    { cwd: web, stdio: 'inherit' },
  );
  if (initial.status !== 0) throw new Error('Initial Angular build failed.');

  const watcher = spawn(
    process.execPath,
    [angularCli, 'build', '--watch', '--configuration', 'development'],
    { cwd: web, stdio: 'inherit' },
  );
  const server = spawn(
    process.execPath,
    [path.join(root, 'server', 'index.cjs'), ...process.argv.slice(2)],
    {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, SNIPER_HUNTER_DEV: '1' },
    },
  );

  let stopping = false;

  /**
   * Shut down both development children once when either exits or the terminal is interrupted.
   * @param code Exit code to propagate from the initiating signal/process.
   * @returns Nothing; marks shutdown and terminates both children.
   */
  function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    watcher.kill();
    server.kill();
    process.exitCode = code;
  }
  process.on('SIGINT', () => stop(130));
  process.on('SIGTERM', () => stop(143));
  watcher.on('exit', (code) => stop(code || 1));
  server.on('exit', (code) => stop(code || 1));
  watcher.on('error', (error) => {
    console.error(error);
    stop(1);
  });
  server.on('error', (error) => {
    console.error(error);
    stop(1);
  });
}

startDevelopment();
