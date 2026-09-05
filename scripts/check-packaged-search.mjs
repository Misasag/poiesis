import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const appDirectory = resolve(option('--app-dir') ?? 'electron-app/dist/win-unpacked');
const resourcesDirectory = basename(appDirectory).toLocaleLowerCase() === 'resources'
    ? appDirectory
    : join(appDirectory, 'resources');
const archivePath = join(resourcesDirectory, 'app.asar');
const executableName = process.platform === 'win32' ? 'rg.exe' : 'rg';
const unpackedRipgrepPath = join(
    resourcesDirectory,
    'app.asar.unpacked',
    'lib',
    'backend',
    'native',
    executableName
);

assert(existsSync(archivePath), `Packaged archive was not found: ${archivePath}`);
assert(existsSync(unpackedRipgrepPath), `Unpacked ripgrep was not found: ${unpackedRipgrepPath}`);

const archiveFiles = asar.listPackage(archivePath);
assert(archiveFiles.some(file => normalize(file).endsWith(`/lib/backend/native/${executableName}`)),
    `The archive metadata did not include lib/backend/native/${executableName}.`);
const backendJavaScript = archiveFiles.filter(file => /^\/lib\/backend\/[^/]+\.js$/.test(normalize(file)));
const resolverBundle = backendJavaScript.find(file => asar.extractFile(archivePath, file.replace(/^[/\\]/, ''))
    .toString('utf8').includes('app.asar.unpacked'));
assert(resolverBundle, 'The packaged backend did not contain the app.asar.unpacked ripgrep resolver.');

const fixtureRoot = mkdtempSync(join(tmpdir(), 'poiesis-packaged-search-'));
const marker = `PackagedSearch${Date.now()}`;
const fixtureFile = join(fixtureRoot, 'unopened-result.txt');
try {
    writeFileSync(fixtureFile, `${marker}\n`, 'utf8');
    const contentSearch = spawnSync(unpackedRipgrepPath, ['--line-number', marker, fixtureRoot], {
        encoding: 'utf8',
        windowsHide: true,
        shell: false
    });
    assert(contentSearch.status === 0,
        `Packaged ripgrep content search failed (${contentSearch.status}, ${contentSearch.error?.code ?? 'no spawn error'}): ${contentSearch.stderr}`);
    assert(contentSearch.stdout.includes('unopened-result.txt'), 'Packaged ripgrep did not find the unopened content fixture.');

    const fileSearch = spawnSync(unpackedRipgrepPath, ['--files', fixtureRoot], {
        encoding: 'utf8',
        windowsHide: true,
        shell: false
    });
    assert(fileSearch.status === 0,
        `Packaged ripgrep file discovery failed (${fileSearch.status}, ${fileSearch.error?.code ?? 'no spawn error'}): ${fileSearch.stderr}`);
    assert(fileSearch.stdout.includes('unopened-result.txt'), 'Packaged ripgrep did not discover the unopened file fixture.');

    console.log(`PACKAGED_SEARCH_CHECK_RESULT=${JSON.stringify({
        appDirectory,
        unpackedRipgrepPath,
        resolverBundle: normalize(resolverBundle),
        contentSearchExitCode: contentSearch.status,
        fileSearchExitCode: fileSearch.status
    })}`);
} finally {
    const temporaryRoot = resolve(tmpdir()) + sep;
    const resolvedFixture = resolve(fixtureRoot);
    if (resolvedFixture.startsWith(temporaryRoot) && basename(resolvedFixture).startsWith('poiesis-packaged-search-')) {
        rmSync(resolvedFixture, { recursive: true, force: true });
    }
}

function option(name) {
    const index = process.argv.indexOf(name);
    return index === -1 ? undefined : process.argv[index + 1];
}

function normalize(value) {
    return value.replaceAll('\\', '/');
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}
