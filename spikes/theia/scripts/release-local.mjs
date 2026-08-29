import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, resolve } from 'node:path';
import {
    distDir,
    distributionEnvironment,
    findNpmCli,
    readElectronPackage,
    root,
    windowsFeedDir,
    writeAsciiChildOutput
} from './distribution-config.mjs';

const previousVersion = readElectronPackage().version;
runNpm(['version', 'patch', '--workspace=@poiesis/theia-electron-app', '--no-git-tag-version']);
const version = readElectronPackage().version;
assertPatchIncrement(previousVersion, version);

console.log(`RELEASE_LOCAL_VERSION=${previousVersion}->${version}`);
runNpm(['run', 'build:electron']);
runNpm(['run', 'dist:win']);

const installer = resolve(distDir, `PoiesisSetup-${version}.exe`);
const latest = resolve(distDir, 'latest.yml');
for (const requiredPath of [installer, latest]) {
    if (!existsSync(requiredPath)) {
        throw new Error(`Required release artifact is missing: ${requiredPath}`);
    }
}

mkdirSync(windowsFeedDir, { recursive: true });
const artifacts = [installer, latest, `${installer}.blockmap`].filter(existsSync);
for (const source of artifacts) {
    const destination = resolve(windowsFeedDir, basename(source));
    copyFileSync(source, destination);
    console.log(`FEED_ARTIFACT=${destination} bytes=${statSync(destination).size}`);
}

console.log(`RELEASE_LOCAL_RESULT=ok version=${version}`);

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
        process.exit(result.status ?? 1);
    }
}

function assertPatchIncrement(before, after) {
    const oldParts = parseVersion(before);
    const newParts = parseVersion(after);
    const expected = [oldParts[0], oldParts[1], oldParts[2] + 1];
    if (newParts.some((part, index) => part !== expected[index])) {
        throw new Error(`Expected a patch increment from ${before}, got ${after}.`);
    }
}

function parseVersion(version) {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    if (!match) {
        throw new Error(`Version must be a plain semantic version: ${version}`);
    }
    return match.slice(1).map(Number);
}
