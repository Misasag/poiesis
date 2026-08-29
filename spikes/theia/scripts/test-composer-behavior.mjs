import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    formatTaskElapsedTime,
    shouldSubmitComposer
} = require('../agent-window/lib/browser/composer-behavior.js');

const enter = { key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13 };

assert.equal(shouldSubmitComposer(enter, 'Run this task'), true, 'Enter must submit non-empty text.');
assert.equal(shouldSubmitComposer(enter, '   \n\t'), false, 'Whitespace-only text must not submit.');
assert.equal(shouldSubmitComposer({ ...enter, shiftKey: true }, 'Line one'), false,
    'Shift+Enter must remain available for a newline.');
assert.equal(shouldSubmitComposer({ ...enter, isComposing: true }, 'Japanese input'), false,
    'An IME composition confirmation must not submit.');
assert.equal(shouldSubmitComposer({ ...enter, keyCode: 229 }, 'Japanese input'), false,
    'Legacy IME keyCode 229 must not submit.');
assert.equal(shouldSubmitComposer({ ...enter, key: 'a' }, 'Run this task'), false,
    'Non-Enter keys must not submit.');
assert.equal(formatTaskElapsedTime('2026-08-29T00:00:00.000Z', Date.parse('2026-08-29T00:02:14.000Z')), '2分14秒');

console.log('COMPOSER_BEHAVIOR_TEST=passed');
