import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const spikeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const repositoryRoot = resolve(spikeRoot, '..', '..');
export const runtimeDir = resolve(spikeRoot, '.runtime');
export const hostDir = resolve(runtimeDir, 'vscodium');
export const hostExecutable = resolve(hostDir, 'VSCodium.exe');
export const portableDataDir = resolve(runtimeDir, 'portable-data');

export async function ensureRuntimeDirectories(profileName = 'user-data') {
    const userDataDir = resolve(runtimeDir, profileName);
    const extensionsDir = resolve(runtimeDir, 'extensions');
    await Promise.all([
        mkdir(userDataDir, { recursive: true }),
        mkdir(extensionsDir, { recursive: true }),
        mkdir(portableDataDir, { recursive: true })
    ]);
    return { userDataDir, extensionsDir };
}

export function assertHostExists() {
    if (!existsSync(hostExecutable)) {
        throw new Error('VSCodium host is missing. Run npm run download:host first.');
    }
}

export function hostArguments({ userDataDir, extensionsDir, debugPort } = {}) {
    const args = [
        `--user-data-dir=${userDataDir}`,
        `--extensions-dir=${extensionsDir}`,
        `--extensionDevelopmentPath=${spikeRoot}`,
        '--disable-workspace-trust',
        '--disable-updates',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--no-sandbox',
        '--skip-welcome',
        '--skip-release-notes',
        '--new-window'
    ];
    if (debugPort) {
        args.push(`--remote-debugging-port=${debugPort}`);
    }
    args.push(repositoryRoot);
    return args;
}

export function hostEnvironment(extra = {}) {
    return {
        ...process.env,
        VSCODE_PORTABLE: portableDataDir,
        ...extra
    };
}
