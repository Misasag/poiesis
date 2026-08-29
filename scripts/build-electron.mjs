import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptsDir, '..');
const electronApp = resolve(root, 'electron-app');
const preload = resolve(scriptsDir, 'local-electron-homedir.cjs').replaceAll('\\', '/');
const nodeOptions = [
    process.env.NODE_OPTIONS,
    '--max-old-space-size=4096',
    `--require=${preload}`
].filter(Boolean).join(' ');
const environment = {
    ...process.env,
    electron_config_cache: resolve(root, '.electron-cache'),
    POIESIS_ELECTRON_CACHE: resolve(root, '.electron-cache'),
    POIESIS_ELECTRON_GYP_HOME: resolve(root, '.electron-home'),
    NODE_OPTIONS: nodeOptions
};

run(resolve(scriptsDir, 'run-electron-rebuild.mjs'), []);
run(resolve(root, 'node_modules/@theia/cli/bin/theia.js'), ['build', '--mode', 'development']);

function run(script, args) {
    const result = spawnSync(process.execPath, [script, ...args], {
        cwd: electronApp,
        env: environment,
        stdio: 'inherit'
    });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}
