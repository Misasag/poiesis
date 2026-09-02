import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { diffTextLines } = require(resolve(root, 'agent-window/lib/browser/text-diff.js'));
const compact = input => diffTextLines(input.before, input.after)
    .map(line => `${line.kind}:${line.text}`);

assert.deepEqual(compact({ before: 'a\nb', after: 'a\nx\nb' }), [
    'unchanged:a', 'added:x', 'unchanged:b'
]);
assert.deepEqual(compact({ before: 'a\nx\nb', after: 'a\nb' }), [
    'unchanged:a', 'removed:x', 'unchanged:b'
]);
assert.deepEqual(compact({ before: 'a\nold\nb', after: 'a\nnew\nb' }), [
    'unchanged:a', 'removed:old', 'added:new', 'unchanged:b'
]);
assert.deepEqual(compact({ before: 'a\nb', after: 'a\nb' }), [
    'unchanged:a', 'unchanged:b'
]);
assert.deepEqual(
    compact({ before: 'a\r\nold\r\nb', after: 'a\r\nnew\r\nb' }),
    compact({ before: 'a\nold\nb', after: 'a\nnew\nb' })
);

console.log('text-diff tests passed');
