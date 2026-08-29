import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
    builderCacheDir,
    distributionEnvironment,
    electronApp,
    npmCacheDir,
    root,
    writeAsciiChildOutput
} from './distribution-config.mjs';

mkdirSync(builderCacheDir, { recursive: true });
mkdirSync(npmCacheDir, { recursive: true });

const builderCli = resolve(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
const result = spawnSync(process.execPath, [
    builderCli,
    '--win',
    'nsis',
    '--publish',
    'never',
    '--config',
    'electron-builder.yml'
], {
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
