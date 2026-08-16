import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptsDir, '..');
const electronApp = resolve(root, 'electron-app');
const preload = resolve(scriptsDir, 'local-electron-homedir.cjs').replaceAll('\\', '/');
const nodeOptions = [process.env.NODE_OPTIONS, `--require=${preload}`].filter(Boolean).join(' ');

const result = spawnSync(process.execPath, [
    resolve(root, 'node_modules/@theia/cli/bin/theia.js'),
    'rebuild:electron',
    '--cacheRoot',
    root
], {
    cwd: electronApp,
    env: {
        ...process.env,
        electron_config_cache: resolve(root, '.electron-cache'),
        LENS_ELECTRON_CACHE: resolve(root, '.electron-cache'),
        LENS_ELECTRON_GYP_HOME: resolve(root, '.electron-home'),
        NODE_OPTIONS: nodeOptions
    },
    stdio: 'inherit'
});

if (result.error) {
    throw result.error;
}
process.exitCode = result.status ?? 1;
