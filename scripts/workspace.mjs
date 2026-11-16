import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/** Repository paths shared by the development and Windows release commands. */
export const paths = {
  root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
};
paths.web = path.join(paths.root, 'web');
paths.angularCli = path.join(paths.web, 'node_modules', '@angular', 'cli', 'bin', 'ng.js');

/**
 * Install locked Angular dependencies only when the local CLI is missing.
 * @param {string} missingMessage Instructions to show when npm cannot be located.
 * @returns {void} Throws when installation is unavailable or unsuccessful.
 */
export function ensureAngularDependencies(missingMessage) {
  if (fs.existsSync(paths.angularCli)) return;
  if (!process.env.npm_execpath) throw new Error(missingMessage);
  const install = spawnSync(
    process.execPath,
    [process.env.npm_execpath, 'ci', '--prefix', paths.web],
    {
      cwd: paths.root,
      stdio: 'inherit',
    },
  );
  if (install.status !== 0) throw new Error('Angular dependency installation failed.');
}
