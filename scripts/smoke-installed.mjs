import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    ascii,
    captureProcessOutput,
    connectToPoiesis,
    defaultInstalledExe,
    parseOptions,
    recordSacEvidence,
    startInstalledApp,
    terminateProcessTree,
    waitForProcessExit
} from './installed-smoke-utils.mjs';
import { root } from './distribution-config.mjs';

const options = parseOptions(process.argv.slice(2));
const executable = resolve(options.exe || options._?.[0] || defaultInstalledExe);
const debugPort = Number(options.port || process.env.POIESIS_INSTALLED_DEBUG_PORT || 43828);
const timeoutMs = Number(options.timeout || process.env.POIESIS_INSTALLED_TIMEOUT || 120_000);
const runtimeDir = resolve(root, '.electron-runtime', 'installed-smoke');
mkdirSync(runtimeDir, { recursive: true });

if (!existsSync(executable)) {
    console.error(`SMOKE_INSTALLED_ERROR=missing-executable path=${ascii(executable)}`);
    process.exit(1);
}

const appProcess = startInstalledApp(executable, debugPort);
const saveOutput = captureProcessOutput(appProcess, resolve(runtimeDir, 'app.log'));
let browser;

try {
    const connected = await connectToPoiesis(appProcess, debugPort, timeoutMs);
    browser = connected.browser;
    const title = await connected.page.title();
    if (!title.includes('Poiesis')) {
        throw new Error(`Expected title to contain Poiesis, got ${title}.`);
    }
    console.log(`SMOKE_INSTALLED_TITLE=${ascii(title)}`);
    await browser.close();
    browser = undefined;
    await waitForProcessExit(appProcess, 30_000);
    console.log(`SMOKE_INSTALLED_RESULT=ok executable=${ascii(executable)}`);
} catch (error) {
    const evidencePath = await recordSacEvidence(executable, error instanceof Error ? error.message : String(error));
    console.error(`SMOKE_INSTALLED_RESULT=failed evidence=${ascii(evidencePath)}`);
    console.error(`SMOKE_INSTALLED_ERROR=${ascii(error instanceof Error ? error.message : String(error))}`);
    process.exitCode = 1;
} finally {
    await browser?.disconnect().catch(() => undefined);
    saveOutput();
    terminateProcessTree(appProcess);
}
