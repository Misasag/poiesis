import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    cliRoleAvailability,
    cliRoleAvailabilityLabel
} = require('../agent-window/lib/common/cli-detection-lifecycle');

const foundReport = {
    detectedAt: '2026-09-05T00:00:00.000Z',
    platform: 'win32',
    detections: [{
        id: 'codex',
        name: 'Codex',
        status: 'found',
        path: 'C:\\Tools\\codex.exe',
        executableRoles: ['agent', 'results'],
        models: [],
        defaultModel: '',
        checkedLocations: []
    }]
};

const missingReport = {
    ...foundReport,
    detections: [{
        ...foundReport.detections[0],
        status: 'missing',
        path: undefined
    }]
};

assert.equal(cliRoleAvailability('pending', undefined, 'codex', 'agent'), 'pending');
assert.equal(cliRoleAvailability('pending', foundReport, 'codex', 'agent'), 'pending',
    'A stale found report must not replace an in-progress rescan.');
assert.equal(cliRoleAvailability('ready', missingReport, 'codex', 'agent'), 'missing');
assert.equal(cliRoleAvailability('ready', foundReport, 'codex', 'agent'), 'available');
assert.equal(cliRoleAvailability('error', foundReport, 'codex', 'agent'), 'error',
    'A stale found report must not replace a failed rescan.');
assert.equal(cliRoleAvailability('ready', foundReport, 'codex', 'results'), 'available');
assert.equal(cliRoleAvailability('ready', foundReport, 'gemini', 'agent'), 'missing');
assert.equal(cliRoleAvailabilityLabel('pending'), '検出中…');
assert.equal(cliRoleAvailabilityLabel('missing'), '未検出');
assert.equal(cliRoleAvailabilityLabel('error'), '検出に失敗');

console.log('CLI_DETECTION_LIFECYCLE_TEST=passed');
