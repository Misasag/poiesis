import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const scriptsDir = dirname(fileURLToPath(import.meta.url));
export const root = resolve(scriptsDir, '..');
export const electronApp = resolve(root, 'electron-app');
export const distDir = resolve(electronApp, 'dist');
export const feedRoot = resolve(root, '.dist-feed');
export const windowsFeedDir = resolve(feedRoot, 'win');
export const builderCacheDir = resolve(root, '.electron-builder-cache');
export const npmCacheDir = resolve(root, '.npm-cache');
export const updateFeedPort = 43827;
export const updateFeedUrl = `http://127.0.0.1:${updateFeedPort}/win`;

export function readElectronPackage() {
    return JSON.parse(readFileSync(resolve(electronApp, 'package.json'), 'utf8'));
}

export function findNpmCli() {
    const candidates = [
        process.env.npm_execpath,
        resolve(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        resolve(root, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    ].filter(Boolean);
    const npmCli = candidates.find(candidate => existsSync(candidate));
    if (!npmCli) {
        throw new Error('npm-cli.js was not found. Run this script through npm.');
    }
    return npmCli;
}

export function distributionEnvironment(overrides = {}) {
    return {
        ...process.env,
        ELECTRON_BUILDER_CACHE: builderCacheDir,
        npm_config_cache: npmCacheDir,
        CSC_IDENTITY_AUTO_DISCOVERY: 'false',
        ...overrides
    };
}

export function writeAsciiChildOutput(result) {
    if (result.stdout) {
        process.stdout.write(toAscii(result.stdout));
    }
    if (result.stderr) {
        process.stderr.write(toAscii(result.stderr));
    }
}

function toAscii(value) {
    return String(value).replace(/[^\x20-\x7e\r\n\t]/g, character =>
        `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
