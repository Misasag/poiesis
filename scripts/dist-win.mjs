import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
    builderCacheDir,
    distributionEnvironment,
    electronApp,
    npmCacheDir,
    root,
    updateFeedUrl,
    writeAsciiChildOutput
} from './distribution-config.mjs';

mkdirSync(builderCacheDir, { recursive: true });
mkdirSync(npmCacheDir, { recursive: true });

const useLocalFeed = process.argv.slice(2).includes('--local-feed');
const builderCli = resolve(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
const builderArgs = [
    builderCli,
    '--win',
    'nsis',
    '--publish',
    'never',
    '--config',
    'electron-builder.yml'
];

if (useLocalFeed) {
    builderArgs.push(
        '--config.win.publish.provider=generic',
        `--config.win.publish.url=${updateFeedUrl}`,
        '--config.win.publish.useMultipleRangeRequest=false'
    );
}

console.log(useLocalFeed
    ? `DIST_WIN_PUBLISH_CONFIG=generic url=${updateFeedUrl}`
    : 'DIST_WIN_PUBLISH_CONFIG=github owner=Misasag repo=poiesis');

const result = spawnSync(process.execPath, builderArgs, {
    cwd: electronApp,
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

console.log('DIST_WIN_RESULT=ok');
