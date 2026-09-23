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
        executableRoles: ['agent', 'results', 'judge'],
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
assert.equal(cliRoleAvailability('ready', {
    ...foundReport,
    detections: [{
        id: 'gemini', name: 'Gemini CLI', status: 'missing', executableRoles: [],
        models: [], defaultModel: '', checkedLocations: []
    }]
}, 'gemini', 'agent'), 'unsupported',
'A detected-or-missing CLI without a runtime adapter must not be presented as installable.');
assert.equal(cliRoleAvailabilityLabel('pending'), '検出中…');
assert.equal(cliRoleAvailabilityLabel('missing'), '未検出');
assert.equal(cliRoleAvailabilityLabel('error'), '検出に失敗');

const { knownCliDefinitions } = require('../agent-window/lib/node/known-cli-registry.js');
const { resolveKnownCliInvocation } = require('../agent-window/lib/node/hidden-process.js');
const piDefinition = knownCliDefinitions().find(definition => definition.id === 'pi');
assert.deepEqual(piDefinition.executableRoles, ['agent', 'results', 'judge']);
if (process.platform === 'win32') {
    const { existsSync } = require('node:fs');
    const shim = piDefinition.wellKnownLocations.find(location => location.endsWith('pi.cmd') && existsSync(location));
    if (shim) {
        const resolved = resolveKnownCliInvocation('pi', shim, ['--version']);
        assert(resolved.executable.endsWith('node.exe'));
        assert(resolved.args[0].endsWith('pi-coding-agent\\dist\\bundle\\cli.js'));
        assert.equal(resolved.args[1], '--version');
    }
}
console.log('CLI_DETECTION_LIFECYCLE_TEST=passed');

for (const [phase, report, expected] of [['pending', foundReport, 'pending'], ['error', foundReport, 'error'], ['ready', missingReport, 'missing'], ['ready', foundReport, 'available']]) {
    assert.equal(cliRoleAvailability(phase, report, 'codex', 'judge'), expected);
}
assert.equal(cliRoleAvailability('ready', { ...foundReport, detections: [{ ...foundReport.detections[0], executableRoles: ['agent', 'results'] }] }, 'codex', 'judge'), 'unsupported');
