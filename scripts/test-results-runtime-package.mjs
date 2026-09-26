import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = await mkdtemp(join(tmpdir(), 'poiesis-runtime-license-'));
try {
    const directory = join(root, 'scripts', 'licenses', 'node');
    await mkdir(directory, { recursive: true });
    const source = resolve('scripts/licenses/node');
    const metadata = JSON.parse((await readFile(join(source, 'version.json'), 'utf8')).replace(/^\uFEFF/, ''));
    assert.equal(metadata.source, `https://raw.githubusercontent.com/nodejs/node/${metadata.version}/LICENSE`);
    const license = await readFile(join(source, 'LICENSE'));
    assert.equal(createHash('sha256').update(license.toString('utf8').replaceAll('\r\n', '\n'), 'utf8').digest('hex'), metadata.sha256);
    await copyFile(join(source, 'LICENSE'), join(directory, 'LICENSE'));
    const script = join(root, 'scripts', 'prepare-results-runtime.mjs');
    await copyFile(resolve('scripts/prepare-results-runtime.mjs'), script);
    for (const version of [process.version, 'v0.0.0']) {
        await writeFile(join(directory, 'version.json'), JSON.stringify({ ...metadata, version }), 'utf8');
        const run = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', shell: false, windowsHide: true });
        assert.equal(run.status, 0, run.stderr);
        assert.equal(run.stderr.includes('WARNING: Bundled Node'), version !== process.version);
        if (version !== process.version) assert(run.stderr.includes(process.version) && run.stderr.includes(version));
        const target = join(root, 'electron-app', 'lib', 'results-runtime');
        assert.deepEqual(await readFile(join(target, 'LICENSE')), license);
        assert.equal(JSON.parse(await readFile(join(target, 'license-version.json'), 'utf8')).version, version);
        const name = process.platform === 'win32' ? 'node.exe' : 'node';
        const digest = bytes => createHash('sha256').update(bytes).digest('hex');
        assert.equal(digest(await readFile(join(target, name))), digest(await readFile(process.execPath)));
    }
    console.log('RESULTS_RUNTIME_PACKAGE_TEST=passed (license copy, version match, mismatch warning without failure)');
} finally {
    await rm(root, { recursive: true, force: true });
}
