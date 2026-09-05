import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { childCliEnvironment, spawnHiddenCli } from '../agent-window/lib/node/hidden-process.js';

const fixtureRoot = await mkdtemp(join(tmpdir(), 'poiesis-hidden-process-env-'));
const workspace = join(fixtureRoot, 'workspace');
const isolatedLocalAppData = join(fixtureRoot, 'local-app-data');

try {
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, '.npmrc'), 'cache=.npm-cache\nregistry=https://registry.npmjs.org/\n', 'utf8');

    const source = {
        ...process.env,
        LOCALAPPDATA: isolatedLocalAppData,
        NPM_CONFIG_CACHE: '.npm-cache',
        Npm_Config_Cache: 'second-relative-cache',
        NPM_CONFIG_REGISTRY: 'https://registry.example.invalid/',
        NPM_CONFIG_USERCONFIG: join(fixtureRoot, 'unchanged-user-config')
    };
    const redirected = childCliEnvironment(source, workspace);
    const cacheKeys = Object.keys(redirected).filter(key => key.toLocaleLowerCase() === 'npm_config_cache');
    assert.deepEqual(cacheKeys, ['npm_config_cache'],
        'Case-insensitive npm cache environment names must be normalized to one value.');
    assert(isAbsolute(redirected.npm_config_cache));
    assert.equal(isWithin(workspace, redirected.npm_config_cache), false,
        'A relative npm cache must be redirected outside the child working directory.');
    assert.equal(redirected.NPM_CONFIG_REGISTRY, source.NPM_CONFIG_REGISTRY,
        'Registry configuration must pass through unchanged.');
    assert.equal(redirected.NPM_CONFIG_USERCONFIG, source.NPM_CONFIG_USERCONFIG,
        'User configuration selection must pass through unchanged.');

    const suitableCache = join(fixtureRoot, 'explicit-outside-cache');
    const preserved = childCliEnvironment({ ...source, NPM_CONFIG_CACHE: suitableCache }, workspace);
    assert.equal(preserved.npm_config_cache, resolve(suitableCache),
        'A suitable absolute cache outside the Workspace should be preserved.');
    const redirectedInside = childCliEnvironment({
        ...source,
        NPM_CONFIG_CACHE: join(workspace, '.npm-cache')
    }, workspace);
    assert.equal(isWithin(workspace, redirectedInside.npm_config_cache), false,
        'An absolute cache inside the Workspace must also be redirected.');

    const npxCli = findNpxCli();
    await installLocalCacheProbe(workspace);
    const childSource = { ...process.env, LOCALAPPDATA: isolatedLocalAppData };
    for (const key of Object.keys(childSource)) {
        if (key.toLocaleLowerCase() === 'npm_config_cache') {
            delete childSource[key];
        }
    }
    const expectedChildCache = childCliEnvironment(childSource, workspace).npm_config_cache;
    const result = await runHiddenChild(npxCli, workspace, childSource);
    assert.equal(result.code, 0, `Local npx probe failed: ${result.stderr}`);
    const probe = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(probe.cache, expectedChildCache,
        'The CLI child and its local npx tool must inherit the external absolute cache.');
    assert.equal(isWithin(workspace, probe.cache), false);
    assert.equal(existsSync(join(workspace, '.npm-cache')), false,
        'The fixture .npmrc must not relocate child runtime cache into the Workspace.');

    console.log('HIDDEN_PROCESS_ENV_TEST=passed');
} finally {
    await rm(fixtureRoot, { recursive: true, force: true });
}

function findNpxCli() {
    const candidates = [
        process.env.npm_execpath && join(dirname(process.env.npm_execpath), 'npx-cli.js'),
        join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js')
    ].filter(Boolean);
    const candidate = candidates.find(path => existsSync(path));
    if (!candidate) {
        throw new Error('The local npm npx entry point was not found.');
    }
    return candidate;
}

async function installLocalCacheProbe(targetWorkspace) {
    const packageDirectory = join(targetWorkspace, 'node_modules', 'cache-probe');
    const binDirectory = join(targetWorkspace, 'node_modules', '.bin');
    await mkdir(packageDirectory, { recursive: true });
    await mkdir(binDirectory, { recursive: true });
    await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({
        name: 'cache-probe',
        version: '1.0.0',
        bin: { 'cache-probe': 'probe.cjs' }
    }), 'utf8');
    await writeFile(
        join(packageDirectory, 'probe.cjs'),
        "process.stdout.write(JSON.stringify({ cache: process.env.npm_config_cache }));\n",
        'utf8'
    );
    if (process.platform === 'win32') {
        await writeFile(
            join(binDirectory, 'cache-probe.cmd'),
            '@ECHO off\r\nnode "%~dp0\\..\\cache-probe\\probe.cjs"\r\n',
            'utf8'
        );
    } else {
        const executable = join(binDirectory, 'cache-probe');
        await writeFile(executable, '#!/usr/bin/env node\nrequire("../cache-probe/probe.cjs");\n', 'utf8');
        await chmod(executable, 0o755);
    }
}

function runHiddenChild(npxCli, cwd, env) {
    return new Promise((resolvePromise, reject) => {
        const child = spawnHiddenCli('grok', process.execPath, [npxCli, '--no-install', 'cache-probe'], { cwd, env });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
        child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
        child.once('error', reject);
        child.once('close', code => resolvePromise({ code, stdout, stderr }));
    });
}

function isWithin(parent, candidate) {
    const relativePath = relative(resolve(parent), resolve(candidate));
    return relativePath === '' || relativePath !== '..'
        && !relativePath.startsWith(`..${sep}`)
        && !isAbsolute(relativePath);
}
