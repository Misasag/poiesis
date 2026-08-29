import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import { root } from './distribution-config.mjs';

export const defaultInstalledExe = process.env.POIESIS_INSTALLED_EXE
    ?? resolve(process.env.LOCALAPPDATA ?? '', 'Programs', 'Poiesis', 'Poiesis.exe');

export function startInstalledApp(executable, debugPort, environment = {}) {
    const appEnvironment = { ...process.env, ...environment };
    delete appEnvironment.THEIA_CONFIG_DIR;
    const processHandle = spawn(executable, [
        `--remote-debugging-port=${debugPort}`,
        '--disable-gpu'
    ], {
        cwd: dirname(executable),
        env: appEnvironment,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: false
    });
    processHandle.poiesisSpawnError = undefined;
    processHandle.on('error', error => {
        processHandle.poiesisSpawnError = error;
    });
    return processHandle;
}

export async function connectToPoiesis(processHandle, debugPort, timeoutMs) {
    const browserUrl = `http://127.0.0.1:${debugPort}`;
    await waitUntil(async () => {
        if (processHandle.poiesisSpawnError) {
            throw processHandle.poiesisSpawnError;
        }
        if (processHandle.exitCode !== null) {
            throw new Error(`Poiesis exited before CDP was ready with code ${processHandle.exitCode}.`);
        }
        try {
            const response = await fetch(`${browserUrl}/json/version`, { signal: AbortSignal.timeout(1_000) });
            return response.ok;
        } catch {
            return false;
        }
    }, timeoutMs, 'Timed out waiting for the installed Poiesis CDP endpoint.');

    const browser = await puppeteer.connect({ browserURL: browserUrl, defaultViewport: null });
    const page = await waitForPage(browser, timeoutMs);
    return { browser, page };
}

export async function waitForPage(browser, timeoutMs) {
    let found;
    await waitUntil(async () => {
        for (const page of await browser.pages()) {
            const title = await page.title().catch(() => '');
            if (title.includes('Poiesis')) {
                found = page;
                return true;
            }
        }
        return false;
    }, timeoutMs, 'Timed out waiting for a window title containing Poiesis.');
    return found;
}

export async function waitForText(filePath, expectedText, processHandle, timeoutMs) {
    await waitUntil(() => {
        if (existsSync(filePath) && readFileSync(filePath, 'utf8').includes(expectedText)) {
            return true;
        }
        if (processHandle?.exitCode !== null && processHandle?.exitCode !== undefined) {
            throw new Error(`Poiesis exited before the expected updater log entry with code ${processHandle.exitCode}.`);
        }
        return false;
    }, timeoutMs, `Timed out waiting for updater log entry: ${expectedText}`);
}

export async function waitUntil(predicate, timeoutMs, timeoutMessage, intervalMs = 250) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
        try {
            if (await predicate()) {
                return;
            }
        } catch (error) {
            lastError = error;
            break;
        }
        await delay(intervalMs);
    }
    throw lastError ?? new Error(timeoutMessage);
}

export async function waitForProcessExit(processHandle, timeoutMs) {
    if (processHandle.exitCode !== null) {
        return processHandle.exitCode;
    }
    return await new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
            cleanup();
            rejectPromise(new Error(`Process ${processHandle.pid} did not exit in time.`));
        }, timeoutMs);
        const onExit = code => {
            cleanup();
            resolvePromise(code);
        };
        const cleanup = () => {
            clearTimeout(timer);
            processHandle.off('exit', onExit);
        };
        processHandle.on('exit', onExit);
    });
}

export function captureProcessOutput(processHandle, outputPath) {
    let output = '';
    for (const stream of [processHandle.stdout, processHandle.stderr]) {
        stream?.on('data', chunk => {
            output = `${output}${chunk.toString('utf8')}`.slice(-100_000);
        });
    }
    return () => {
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, output, 'utf8');
    };
}

export function terminateProcessTree(processHandle) {
    if (!processHandle?.pid || processHandle.exitCode !== null) {
        return;
    }
    spawnSync('taskkill.exe', ['/PID', String(processHandle.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
    });
}

export async function readInstalledVersion(executable) {
    const resourcesDir = resolve(dirname(executable), 'resources');
    const unpackedPackage = resolve(resourcesDir, 'app', 'package.json');
    if (existsSync(unpackedPackage)) {
        return JSON.parse(readFileSync(unpackedPackage, 'utf8')).version;
    }

    const archivePath = resolve(resourcesDir, 'app.asar');
    if (!existsSync(archivePath)) {
        throw new Error(`Installed app package was not found below ${resourcesDir}.`);
    }
    const asar = await import('@electron/asar');
    const packageBuffer = asar.extractFile(archivePath, 'package.json');
    return JSON.parse(packageBuffer.toString('utf8')).version;
}

export async function recordSacEvidence(candidatePath, reason) {
    const evidencePath = resolve(root, '_codex', 'sac-code-integrity.txt');
    mkdirSync(dirname(evidencePath), { recursive: true });
    const args = [
        'qe',
        'Microsoft-Windows-CodeIntegrity/Operational',
        '/q:*[System[(EventID=3077 or EventID=3118)]]',
        '/c:5',
        '/rd:true',
        '/f:text'
    ];
    const result = spawnSync('wevtutil.exe', args, { encoding: null, windowsHide: true });
    const stdout = decodeWindowsText(result.stdout);
    const stderr = decodeWindowsText(result.stderr);
    const block = [
        `Timestamp: ${new Date().toISOString()}`,
        `Candidate: ${candidatePath}`,
        `Reason: ${reason}`,
        'Command: wevtutil qe Microsoft-Windows-CodeIntegrity/Operational /q:"*[System[(EventID=3077 or EventID=3118)]]" /c:5 /rd:true /f:text',
        `Exit code: ${result.status ?? 'spawn-error'}`,
        stdout,
        stderr,
        '',
        ''
    ].join('\n');
    appendFileSync(evidencePath, block, 'utf8');
    return evidencePath;
}

export function parseOptions(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (!argument.startsWith('--')) {
            options._ ??= [];
            options._.push(argument);
            continue;
        }
        const name = argument.slice(2);
        const value = argv[index + 1];
        if (!value || value.startsWith('--')) {
            options[name] = true;
        } else {
            options[name] = value;
            index += 1;
        }
    }
    return options;
}

export function ascii(value) {
    return String(value).replace(/[^\x20-\x7e\r\n\t]/g, character =>
        `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function decodeWindowsText(buffer) {
    if (!buffer?.length) {
        return '';
    }
    try {
        return new TextDecoder('shift_jis').decode(buffer);
    } catch {
        return buffer.toString('utf8');
    }
}

function delay(milliseconds) {
    return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
}
