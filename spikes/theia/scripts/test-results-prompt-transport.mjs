import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { spawnHiddenCli } = require('../agent-window/lib/node/hidden-process.js');
const input = 'x'.repeat(80_000);
const child = spawnHiddenCli('codex', process.execPath, [
    '-e',
    "let value='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>value+=chunk);process.stdin.on('end',()=>process.stdout.write(String(value.length)))"
], { input });

let stdout = '';
let stderr = '';
child.stdout.on('data', chunk => { stdout += chunk.toString(); });
child.stderr.on('data', chunk => { stderr += chunk.toString(); });
const exitCode = await new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('close', resolveExit);
});

assert.equal(exitCode, 0, stderr);
assert.equal(stdout, String(input.length));
assert.ok(child.spawnargs.every(argument => argument.length < 1_000), 'The Results prompt leaked into process arguments.');
console.log('RESULTS_PROMPT_TRANSPORT_TEST={"inputChars":80000,"transport":"stdin","argvBounded":true}');
