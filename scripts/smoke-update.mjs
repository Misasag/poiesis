import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import {
    ascii,
    captureProcessOutput,
    connectToPoiesis,
    defaultInstalledExe,
    parseOptions,
    readInstalledVersion,
    recordSacEvidence,
    startInstalledApp,
    terminateProcessTree,
    waitForProcessExit,
    waitForText,
    waitUntil
} from './installed-smoke-utils.mjs';
import {
    distDir,
    distributionEnvironment,
    findNpmCli,
    readElectronPackage,
    root,
    scriptsDir,
    updateFeedUrl,
    writeAsciiChildOutput
} from './distribution-config.mjs';

const options = parseOptions(process.argv.slice(2));
const sourceVersion = readElectronPackage().version;
const installer = resolve(options.installer || resolve(distDir, `PoiesisSetup-${sourceVersion}.exe`));
const executable = resolve(options.exe || defaultInstalledExe);
const debugPort = Number(options.port || process.env.POIESIS_UPDATE_DEBUG_PORT || 43829);
const startupTimeout = Number(options['startup-timeout'] || 120_000);
const downloadTimeout = Number(options['download-timeout'] || 300_000);
const installTimeout = Number(options['install-timeout'] || 180_000);
const runtimeDir = resolve(root, '.electron-runtime', 'update-smoke');
const updaterLog = resolve(runtimeDir, 'updater.log');
mkdirSync(runtimeDir, { recursive: true });
if (existsSync(updaterLog)) {
    rmSync(updaterLog);
}

let appProcess;
let updateServer;
let browser;
let versionB;
let saveAppOutput = () => undefined;
let saveServerOutput = () => undefined;

try {
    if (!existsSync(installer)) {
        throw new Error(`Version A installer does not exist: ${installer}`);
    }
    const versionA = installerVersion(installer);
    if (versionA !== sourceVersion) {
        throw new Error(`Version A installer ${versionA} does not match the source version ${sourceVersion}.`);
    }

    console.log(`SMOKE_UPDATE_INSTALL_A=${versionA}`);
    runInstaller(installer);
    await waitUntil(() => hasInstalledVersion(executable, versionA),
        installTimeout, `Version A was not installed at ${executable}.`, 1_000);

    console.log(`SMOKE_UPDATE_RELEASE_FROM=${sourceVersion}`);
    runNpm(['run', 'release:local']);
    versionB = readElectronPackage().version;
    assertPatchIncrement(versionA, versionB);

    updateServer = spawn(process.execPath, [resolve(scriptsDir, 'serve-updates.mjs')], {
        cwd: root,
        env: distributionEnvironment(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });
    let updateServerSpawnError;
    updateServer.on('error', error => {
        updateServerSpawnError = error;
    });
    saveServerOutput = captureProcessOutput(updateServer, resolve(runtimeDir, 'server.log'));
    await waitUntil(async () => {
        if (updateServerSpawnError) {
            throw updateServerSpawnError;
        }
        if (updateServer.exitCode !== null) {
            throw new Error(`Update server exited with code ${updateServer.exitCode}.`);
        }
        try {
            const response = await fetch(`${updateFeedUrl}/latest.yml`, { signal: AbortSignal.timeout(1_000) });
            return response.ok;
        } catch {
            return false;
        }
    }, 30_000, 'Update server did not become ready.');

    console.log(`SMOKE_UPDATE_FEED_READY=${updateFeedUrl}`);
    appProcess = startInstalledApp(executable, debugPort, { POIESIS_UPDATER_LOG: updaterLog });
    saveAppOutput = captureProcessOutput(appProcess, resolve(runtimeDir, 'app.log'));
    const connected = await connectToPoiesis(appProcess, debugPort, startupTimeout);
    browser = connected.browser;
    const title = await connected.page.title();
    if (!title.includes('Poiesis')) {
        throw new Error(`Expected title to contain Poiesis, got ${title}.`);
    }

    await waitForText(updaterLog, `POIESIS_UPDATE_DOWNLOADED version=${versionB}`, appProcess, downloadTimeout);
    console.log(`SMOKE_UPDATE_DOWNLOADED=${versionB}`);
    await browser.close();
    browser = undefined;
    await waitForProcessExit(appProcess, 30_000);

    await waitUntil(() => hasInstalledVersion(executable, versionB),
        installTimeout, `Installed version did not change to ${versionB}.`, 1_000);
    console.log(`SMOKE_UPDATE_INSTALLED_VERSION=${versionB}`);
    console.log(`SMOKE_UPDATE_RESULT=ok from=${versionA} to=${versionB}`);
} catch (error) {
    const candidates = [installer, executable];
    if (versionB) {
        candidates.push(resolve(distDir, `PoiesisSetup-${versionB}.exe`));
    }
    const evidencePath = await recordSacEvidence(candidates.join(' | '), error instanceof Error ? error.message : String(error));
    console.error(`SMOKE_UPDATE_RESULT=failed evidence=${ascii(evidencePath)}`);
    console.error(`SMOKE_UPDATE_ERROR=${ascii(error instanceof Error ? error.message : String(error))}`);
    process.exitCode = 1;
} finally {
    await browser?.disconnect().catch(() => undefined);
    saveAppOutput();
    saveServerOutput();
    terminateProcessTree(appProcess);
    if (updateServer && updateServer.exitCode === null) {
        updateServer.kill('SIGTERM');
        await waitForProcessExit(updateServer, 5_000).catch(() => terminateProcessTree(updateServer));
    }
}

function runInstaller(installerPath) {
    const result = spawnSync(installerPath, ['/S'], {
        cwd: dirname(installerPath),
        env: process.env,
        stdio: 'ignore',
        windowsHide: true
    });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`Silent installer exited with code ${result.status}.`);
    }
}

function runNpm(args) {
    const result = spawnSync(process.execPath, [findNpmCli(), ...args], {
        cwd: root,
        env: distributionEnvironment(),
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    writeAsciiChildOutput(result);
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`npm command exited with code ${result.status}.`);
    }
}

function installerVersion(installerPath) {
    const match = /PoiesisSetup-(\d+\.\d+\.\d+)\.exe$/i.exec(installerPath);
    if (!match) {
        throw new Error(`Installer name must contain a semantic version: ${installerPath}`);
    }
    return match[1];
}

function assertPatchIncrement(before, after) {
    const oldParts = before.split('.').map(Number);
    const newParts = after.split('.').map(Number);
    if (oldParts.length !== 3 || newParts.length !== 3 ||
        newParts[0] !== oldParts[0] || newParts[1] !== oldParts[1] || newParts[2] !== oldParts[2] + 1) {
        throw new Error(`Expected version B to be patch+1 from ${before}, got ${after}.`);
    }
}

async function hasInstalledVersion(executablePath, expectedVersion) {
    if (!existsSync(executablePath)) {
        return false;
    }
    try {
        return await readInstalledVersion(executablePath) === expectedVersion;
    } catch {
        return false;
    }
}
