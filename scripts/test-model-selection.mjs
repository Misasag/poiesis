import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    beginCustomModelDraft,
    filterModelPickerProviders,
    modelEffortIsUnsupported,
    modelPickerPlacement,
    modelPickerProviders,
    modelSupportedEfforts,
    validateCustomModelDraft
} = require('../agent-window/lib/browser/model-picker-state.js');
const { cliRoleAvailability } = require('../agent-window/lib/common/cli-detection-lifecycle.js');

const report = {
    detectedAt: '2026-09-06T00:00:00.000Z',
    platform: 'win32',
    detections: [
        {
            id: 'codex', name: 'Codex', status: 'found', path: 'C:\\Tools\\codex.exe',
            executableRoles: ['agent', 'results'], models: [{ id: '', label: '既定' }], defaultModel: '', checkedLocations: []
        },
        {
            id: 'claude', name: 'Claude Code', status: 'found', path: 'C:\\Tools\\claude.exe',
            executableRoles: ['agent', 'results'], models: [{ id: '', label: '既定' }, { id: 'sonnet', label: 'sonnet' }],
            defaultModel: '', checkedLocations: []
        },
        {
            id: 'grok', name: 'Grok', status: 'missing', executableRoles: ['agent', 'results'],
            models: [{ id: '', label: '既定' }], defaultModel: '', checkedLocations: []
        },
        {
            id: 'gemini', name: 'Gemini CLI', status: 'found', path: 'C:\\Tools\\gemini.exe', executableRoles: [],
            models: [{ id: '', label: '既定' }], defaultModel: '', checkedLocations: []
        }
    ]
};
const catalogs = {
    codex: {
        providerId: 'codex', source: 'live', fetchedAt: '2026-09-06T00:00:01.000Z',
        models: [
            { id: '', label: '既定' },
            {
                id: 'gpt-6-astra', label: 'GPT-6-Astra',
                supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
            },
            { id: 'gpt-5.5', label: 'GPT-5.5', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'] }
        ]
    }
};

const customSelection = { providerId: 'codex', model: 'private-preview-model', effort: 'max' };
const providers = modelPickerProviders(
    'ready', report, catalogs, 'agent', customSelection.providerId, customSelection.model
);
assert.deepEqual(providers.map(provider => provider.id), ['codex', 'claude'],
    'Missing and detected-but-unsupported providers must not be selectable.');
assert.equal(providers[0].choices[0].id, customSelection.model,
    'A saved custom model must remain visible after a live catalog refresh.');
assert.equal(providers[0].choices[0].custom, true);
assert.ok(providers.every(provider => provider.choices.some(choice => choice.id === '')),
    'Every selectable provider must expose the actual CLI-configured default choice.');
assert.equal(cliRoleAvailability('ready', {
    ...report,
    detections: report.detections.map(detection => detection.id === 'gemini'
        ? { ...detection, status: 'missing', path: undefined }
        : detection)
}, 'gemini', 'agent'), 'unsupported',
'An unavailable provider with no runtime adapter must remain unsupported, not look installable.');

const searched = filterModelPickerProviders(providers, 'all', 'astra');
assert.deepEqual(searched.flatMap(provider => provider.choices.map(choice => choice.id)), ['gpt-6-astra']);
assert.deepEqual(filterModelPickerProviders(providers, 'claude', '').map(provider => provider.id), ['claude']);

assert.deepEqual(
    modelSupportedEfforts('codex', 'gpt-6-astra', providers),
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    'GPT-6 must not present minimal and must present max/ultra.'
);
assert.deepEqual(modelSupportedEfforts('codex', 'gpt-5.5', providers), ['low', 'medium', 'high', 'xhigh']);
assert.ok(modelSupportedEfforts('codex', customSelection.model, providers).includes('minimal'),
    'Unknown custom models keep the backend-safe provider effort escape hatch.');
assert.equal(modelEffortIsUnsupported('codex', 'gpt-6-astra', 'minimal', providers), true,
    'A preserved effort excluded by explicit metadata must be surfaced as unsupported.');
assert.equal(modelEffortIsUnsupported('codex', 'gpt-6-astra', 'ultra', providers), false);
assert.equal(modelEffortIsUnsupported('codex', customSelection.model, 'minimal', providers), false,
    'Unknown custom models must not be rejected without model metadata.');
assert.equal(modelEffortIsUnsupported('codex', '', 'minimal', providers), false,
    'The CLI-configured default must not be rejected without model metadata.');
const preservedUnsupportedSelection = { providerId: 'codex', model: 'gpt-6-astra', effort: 'minimal' };
modelPickerProviders(
    'ready', report, catalogs, 'agent', preservedUnsupportedSelection.providerId, preservedUnsupportedSelection.model
);
assert.deepEqual(preservedUnsupportedSelection, { providerId: 'codex', model: 'gpt-6-astra', effort: 'minimal' },
    'A catalog refresh must preserve a saved unsupported effort for explicit user correction.');

const openedDraft = beginCustomModelDraft(providers, customSelection.providerId, customSelection.model);
assert.deepEqual(openedDraft, { providerId: 'codex', value: customSelection.model });
assert.deepEqual(
    beginCustomModelDraft(providers, customSelection.providerId, customSelection.model, '  query-model  '),
    { providerId: 'codex', value: 'query-model' },
    'A no-match Enter path must preserve the search query in the custom draft.'
);
const editedDraft = { ...openedDraft, value: '  replacement-model  ' };
assert.deepEqual(customSelection, { providerId: 'codex', model: 'private-preview-model', effort: 'max' },
    'Opening and editing a custom draft must not mutate the saved selection.');
assert.deepEqual(validateCustomModelDraft(editedDraft), { model: 'replacement-model' });
assert.equal(validateCustomModelDraft({ providerId: 'codex', value: '   ' }).error, 'モデルIDを入力してください。');
assert.equal(validateCustomModelDraft({ providerId: 'codex', value: 'x'.repeat(161) }).error, 'モデルIDは160文字以内で入力してください。');

const refreshedProviders = modelPickerProviders(
    'ready', report,
    { codex: { ...catalogs.codex, models: [{ id: '', label: '既定' }, { id: 'new-model', label: 'New Model' }] } },
    'agent', customSelection.providerId, customSelection.model
);
assert.equal(refreshedProviders[0].choices[0].id, customSelection.model);
assert.equal(customSelection.effort, 'max', 'Catalog refresh must not rewrite a saved per-model effort.');

const tallPlacement = modelPickerPlacement({ left: 590, top: 520, bottom: 552 }, 1024, 600);
assert.equal(tallPlacement.maxHeight, 506);
assert.equal(tallPlacement.bottom, 86);
const shortPlacement = modelPickerPlacement({ left: 390, top: 180, bottom: 212 }, 800, 400);
assert.equal(shortPlacement.maxHeight, 174);
assert.equal(shortPlacement.top, 218);
assert.ok(shortPlacement.maxHeight <= 400 - shortPlacement.top - 8,
    'Short-viewport placement must never claim more height than is actually available.');

console.log('MODEL_SELECTION_TEST=passed');
