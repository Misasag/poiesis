import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const root = process.cwd();
const fixture = process.env.POIESIS_SMOKE_FIXTURE
    ? resolve(process.env.POIESIS_SMOKE_FIXTURE)
    : resolve(root, 'docs', 'UX.md');
const original = readFileSync(fixture, 'utf8');
const marker = '<!-- Poiesis restored New Chat smoke -->';
if (original.includes(marker)) throw new Error('Restored New Chat fixture contains a marker from an interrupted run.');
const browserPath = [process.env.CHROME_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']
    .filter(Boolean).find(existsSync);
if (!browserPath) throw new Error('Chrome or Edge was not found.');
const profile = resolve(process.cwd(), '.run', `restored-new-chat-${Date.now()}`);
const url = process.env.THEIA_SMOKE_UI_URL ?? 'http://127.0.0.1:3000';
const timeout = Number(process.env.THEIA_SMOKE_UI_TIMEOUT ?? 240_000);
const expectPreSpawnFailure = process.env.POIESIS_EXPECT_PRESPAWN_FAILURE === '1';
const knownProviders = ['codex', 'claude', 'grok'];
const provider = knownProviders.includes(process.env.POIESIS_SMOKE_PROVIDER) ? process.env.POIESIS_SMOKE_PROVIDER : 'codex';
const resultsProvider = knownProviders.includes(process.env.POIESIS_SMOKE_RESULTS_PROVIDER)
    ? process.env.POIESIS_SMOKE_RESULTS_PROVIDER
    : provider;
const agentModel = process.env.POIESIS_SMOKE_AGENT_MODEL?.trim() ?? '';
const resultsModel = process.env.POIESIS_SMOKE_RESULTS_MODEL?.trim() ?? '';
const verifyModelArgs = process.env.POIESIS_VERIFY_MODEL_ARGS === '1';
const useComposerPill = process.env.POIESIS_SMOKE_USE_COMPOSER_PILL === '1';
let browser;
let resultsModelArgs;
const pillChecks = {};

try {
    browser = await puppeteer.launch({
        executablePath: browserPath,
        headless: true,
        userDataDir: profile,
        protocolTimeout: 300_000,
        defaultViewport: { width: 1500, height: 850 },
        args: ['--no-sandbox', '--disable-gpu', '--no-first-run']
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(timeout);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#poiesis-window-host .poiesis-agent-window__content:not(.poiesis-agent-window__content--initializing)');
    const now = Date.now();
    await page.evaluate(timestamp => {
        const currentState = JSON.parse(localStorage.getItem('poiesis:global:poiesis.agent-window.sessions.global.v1') ?? '{}');
        const workspaceUri = currentState.sessions?.find(session => typeof session.workspaceUri === 'string')?.workspaceUri;
        if (!workspaceUri) throw new Error('The current workspace URI was not persisted before the restored-state fixture was installed.');
        const taskId = 'restored-new-chat-seed-task';
        localStorage.setItem('poiesis:global:poiesis.agent-window.sessions.global.v1', JSON.stringify({
            version: 1,
            selectedSessionId: 'restored-new-chat-seed-session',
            railWidth: 258,
            railCollapsed: false,
            sessions: [{
                id: 'restored-new-chat-seed-session',
                createdAt: timestamp - 60_000,
                updatedAt: timestamp - 1_000,
                workspaceUri,
                branch: 'main',
                runTarget: 'local',
                title: '復元済みセッション',
                hasUserMessage: true,
                lastTaskStatus: 'completed',
                pinned: false,
                archived: false,
                activeTab: 'results',
                agentDraft: '',
                messages: [{ id: 'restored-user', role: 'user', content: '復元用の完了タスク', complete: true }],
                selectedResultsTaskId: taskId,
                resultsDrafts: [],
                tasks: [{
                    id: taskId,
                    sessionId: 'retired-provider-session',
                    title: '復元用の完了タスク',
                    request: '復元用の完了タスク',
                    status: 'completed',
                    startedAt: new Date(timestamp - 30_000).toISOString(),
                    endedAt: new Date(timestamp - 20_000).toISOString(),
                    baseline: { kind: 'workspace-snapshot', capturedAt: new Date(timestamp - 30_000).toISOString() },
                    changeSet: {
                        source: 'task-diff',
                        diff: 'diff --git a/docs/UX.md b/docs/UX.md\n+復元済みResults',
                        files: ['docs/UX.md'],
                        capturedAt: new Date(timestamp - 20_000).toISOString()
                    }
                }],
                resultsDocuments: [{
                    taskId,
                    status: 'ready',
                    html: '<!doctype html><html lang="ja"><body><h1>復元済みResults</h1></body></html>'
                }]
            }]
        }));
        localStorage.setItem('poiesis:global:poiesis.agent-window.sessions.migrated.v1', 'true');
    }, now);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#poiesis-window-host .poiesis-agent-window__content:not(.poiesis-agent-window__content--initializing)');
    await page.waitForSelector('.poiesis-results__document');
    if (useComposerPill) {
        pillChecks.resultsInitial = await selectComposerRole(page, 'results', resultsProvider, resultsModel);
        await clickText(page, '.poiesis-agent-window__tabs button', 'Agent');
        pillChecks.agentRestoredSession = await selectComposerRole(page, 'agent', provider, agentModel);
        pillChecks.customModel = await verifyComposerCustomModel(page, 'agent', provider, agentModel);
        pillChecks.settingsRoundTrip = await assertSettingsRoleSelections(page, provider, agentModel, resultsProvider, resultsModel);
    } else if (provider !== 'codex' || resultsProvider !== 'codex' || agentModel || resultsModel) {
        await page.click('.poiesis-agent-window__rail-footer button[aria-label="設定"]');
        await page.waitForSelector('.poiesis-settings-modal');
        for (const [role, selectedProvider, selectedModel] of [
            ['agent', provider, agentModel],
            ['results', resultsProvider, resultsModel]
        ]) {
            const selector = `input[name="poiesis-${role}-cli"][value="${selectedProvider}"]`;
            await page.waitForFunction(currentSelector => !document.querySelector(currentSelector)?.disabled, {}, selector);
            await page.$eval(selector, input => input.click());
            await page.waitForFunction(currentSelector => document.querySelector(currentSelector)?.checked, {}, selector);
            if (selectedModel) {
                const modelSelector = `[aria-label="${role === 'agent' ? 'Agent' : 'Results'} の AI モデル"]`;
                await page.click(modelSelector);
                await page.waitForSelector('.poiesis-select__listbox');
                const optionExists = await page.evaluate(model => [...document.querySelectorAll('.poiesis-select__option')]
                    .some(option => option.dataset.value === model), selectedModel);
                if (optionExists) {
                    await choosePoiesisSelectOption(page, modelSelector, selectedModel, true);
                } else {
                    await choosePoiesisSelectOption(page, modelSelector, '__custom__', true);
                    const customSelector = `[aria-label="${role === 'agent' ? 'Agent' : 'Results'} の AI カスタムモデルID"]`;
                    await page.type(customSelector, selectedModel);
                }
            }
        }
        await page.click('.poiesis-settings-modal__header button[aria-label="設定を閉じる"]');
        await page.waitForFunction(() => !document.querySelector('.poiesis-settings-modal'));
    }
    await clickText(page, '.poiesis-agent-window__tabs button', 'Agent');
    await clickText(page, '.poiesis-agent-window__rail-action', '新しいチャット');
    await page.waitForSelector('.poiesis-agent-window__new-agent-empty');
    if (useComposerPill) {
        pillChecks.newAgent = await composerPillSnapshot(page, 'agent');
        await page.setViewport({ width: 1024, height: 600, deviceScaleFactor: 1 });
        pillChecks.minimumWindow = await assertComposerPopoverUnclipped(page, 'agent');
        await page.setViewport({ width: 1500, height: 850, deviceScaleFactor: 1 });
    }

    const prompt = `docs/UX.md の末尾に ${marker} を1行追加してください。このファイル以外は変更せず、コミットしないでください。`;
    await fill(page, prompt);
    const agentModelArgsPromise = verifyModelArgs && agentModel
        ? waitForProcessModelArg(provider, provider === 'codex' ? '-m' : '--model', agentModel, timeout)
        : Promise.resolve(undefined);
    await page.focus('[aria-label="Agent へのメッセージ"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.poiesis-agent-window__task-state');
    await page.waitForFunction(() => !document.querySelector('.poiesis-agent-window__task-state'));
    const agentModelArgs = await agentModelArgsPromise;
    if (useComposerPill) {
        pillChecks.ongoingAgent = await composerPillSnapshot(page, 'agent');
    }

    const agentState = await page.evaluate(() => ({
        title: document.querySelector('.poiesis-agent-window__context > strong')?.textContent?.trim(),
        error: document.querySelector('.poiesis-agent-window__message-error strong')?.textContent?.trim(),
        errorDetails: document.querySelector('.poiesis-agent-window__message-error details pre')?.textContent?.trim(),
        messageCount: document.querySelectorAll('[aria-label="Agent のメッセージ"]').length,
        messages: [...document.querySelectorAll('[aria-label="Agent のメッセージ"]')]
            .map(node => node.textContent?.trim()),
        storedTitles: (() => {
            const state = JSON.parse(localStorage.getItem('poiesis:global:poiesis.agent-window.sessions.global.v1') ?? '{}');
            return state.sessions?.map(session => session.title) ?? [];
        })()
    }));
    assert(agentState.title?.startsWith('docs/UX.md の末尾に'), 'New Chat did not become a named user session.');
    assert(agentState.storedTitles.includes(agentState.title), 'First user message was not flushed to global storage.');

    if (!expectPreSpawnFailure) {
        await fill(page, 'キャンセル動作の確認です。ファイルを変更せず、作業を始めてください。');
        await page.focus('[aria-label="Agent へのメッセージ"]');
        await page.keyboard.press('Enter');
        await page.waitForSelector('.poiesis-agent-window__task-state');
        await new Promise(resolve => setTimeout(resolve, 750));
        await clickText(page, '.poiesis-agent-window__task-state button', 'キャンセル');
        await page.waitForFunction(() => !document.querySelector('.poiesis-agent-window__task-state'));
    }

    await clickText(page, '.poiesis-agent-window__tabs button', 'Results');
    const expectedTaskCount = expectPreSpawnFailure ? 1 : 2;
    await page.waitForFunction(count => document.querySelectorAll('.poiesis-results__task-select').length === count, {}, expectedTaskCount);
    const taskLabels = await page.$$eval('.poiesis-results__task-select', nodes => nodes.map(node => node.textContent?.trim()));
    const taskLabel = taskLabels.find(label => expectPreSpawnFailure ? label?.includes('失敗') : label?.includes('完了'));
    if (expectPreSpawnFailure) {
        assert(agentState.error === 'Codex を開始できませんでした。', `Designed pre-spawn error is missing: ${agentState.error}`);
        assert(agentState.errorDetails?.includes('Agent pre-spawn failure requested by test hook.'), 'Raw pre-spawn details are missing from the disclosure.');
        assert(taskLabel?.includes('失敗'), `Pre-spawn failure task is missing: ${taskLabel}`);
        assert(readFileSync(fixture, 'utf8') === original, 'Pre-spawn failure changed the workspace fixture.');
    } else {
        assert(!agentState.error, `Real provider task failed: ${agentState.error}\n${agentState.errorDetails ?? ''}\n${agentState.messages.join('\n')}`);
        assert(taskLabel?.includes('完了'), `Completed task is missing: ${taskLabel}`);
        assert(taskLabels.some(label => label?.includes('キャンセル')), `Cancelled task is missing: ${taskLabels.join(' | ')}`);
        assert(readFileSync(fixture, 'utf8').includes(marker), 'Selected provider did not edit the fixture.');
        await page.evaluate(() => {
            const completed = [...document.querySelectorAll('.poiesis-results__task-select')]
                .find(node => node.textContent?.includes('完了'));
            if (!(completed instanceof HTMLElement)) throw new Error('The completed task tab was not found.');
            completed.click();
        });
        await page.waitForSelector('.poiesis-results__document');
        if (useComposerPill) {
            pillChecks.resultsComposer = await composerPillSnapshot(page, 'results');
        }

        await page.type('[aria-label="表示中の成果について質問"]', 'この成果で変更したファイル名だけを答えてください。');
        const resultsModelArgsPromise = verifyModelArgs && resultsModel
            ? waitForProcessModelArg(resultsProvider, resultsProvider === 'codex' ? '-m' : '--model', resultsModel, timeout)
            : Promise.resolve(undefined);
        await page.click('[aria-label="Results 内へ送信"]');
        await page.waitForSelector('.poiesis-results__qa-entry.sending');
        await page.waitForFunction(() => Boolean(
            !document.querySelector('.poiesis-results__qa-entry.sending')
            && document.querySelector('.poiesis-results__qa-entry')
        ));
        const failure = await page.$eval('.poiesis-results__qa-entry.failed', node => node.textContent?.trim()).catch(() => undefined);
        assert(!failure, `Results question failed: ${failure}`);
        assert(await page.$('.poiesis-results__qa-entry:not(.failed)'), 'Results answer was not added to Q&A history.');
        resultsModelArgs = await resultsModelArgsPromise;

        await clickText(page, '.poiesis-agent-window__code-control', 'Code');
        await page.waitForSelector('.poiesis-agent-window__code');
        await page.click('[aria-label="Source Control"]');
        await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__code-sidebar')?.textContent?.includes('UX.md'));
        await clickText(page, '.poiesis-agent-window__code-control', 'Code');
        await page.waitForSelector('.poiesis-results__document');
        assert(await page.$('.poiesis-results__qa-entry:not(.failed)'), 'Results answer was lost after returning from Code.');
        await clickText(page, '.poiesis-agent-window__tabs button', 'Agent');
        const messageCountAfterResultsQuestion = await page.$$eval('[aria-label="Agent のメッセージ"]', nodes => nodes.length);
        assert(messageCountAfterResultsQuestion === agentState.messageCount + 1,
            'Results question leaked into Agent conversation or the cancelled run was not retained.');
        await clickText(page, '.poiesis-agent-window__tabs button', 'Results');
        await page.waitForSelector('.poiesis-results__document');
        assert(await page.$('.poiesis-results__qa-entry:not(.failed)'), 'Results answer was lost after Agent/Results switching.');
    }

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.poiesis-agent-window__session-title');
    const restored = await page.evaluate(expectedTitle => ({
        titles: [...document.querySelectorAll('.poiesis-agent-window__session-title')].map(node => node.textContent?.trim()),
        taskLabel: document.querySelector('.poiesis-results__task-select[aria-selected="true"]')?.textContent?.trim()
            ?? document.querySelector('.poiesis-results__task-select')?.textContent?.trim(),
        questionHistoryCount: document.querySelectorAll('.poiesis-results__qa-entry').length
    }), agentState.title);
    assert(restored.titles.includes(agentState.title), 'New Chat session disappeared after reload.');
    assert(expectPreSpawnFailure ? restored.taskLabel?.includes('失敗') : restored.taskLabel?.includes('完了'),
        `Task state disappeared after reload: ${restored.taskLabel}`);
    if (!expectPreSpawnFailure) {
        assert(restored.questionHistoryCount === 1, 'Results Q&A history disappeared after reload.');
    }
    if (useComposerPill && !expectPreSpawnFailure) {
        pillChecks.restoredResults = await composerPillSnapshot(page, 'results');
        await clickText(page, '.poiesis-agent-window__tabs button', 'Agent');
        pillChecks.restoredAgent = await composerPillSnapshot(page, 'agent');
        assert(pillChecks.restoredAgent.value === `provider:${provider}:${encodeURIComponent(agentModel)}`,
            `Agent composer pill selection did not persist: ${JSON.stringify(pillChecks.restoredAgent)}`);
        assert(pillChecks.restoredResults.value === `provider:${resultsProvider}:${encodeURIComponent(resultsModel)}`,
            `Results composer pill selection did not persist: ${JSON.stringify(pillChecks.restoredResults)}`);
    }
    console.log(`RESTORED_NEW_CHAT_SMOKE_RESULT=${JSON.stringify({
        provider,
        agentModel,
        resultsProvider,
        resultsModel,
        modelArgs: { agent: agentModelArgs, results: resultsModelArgs },
        pillChecks,
        expectPreSpawnFailure,
        agentState,
        taskLabel,
        restored
    }, null, 2)}`);
} finally {
    if (browser) await browser.close().catch(() => undefined);
    writeFileSync(fixture, original, 'utf8');
}

async function selectComposerRole(page, role, selectedProvider, selectedModel) {
    const roleLabel = role === 'agent' ? 'Agent' : 'Results';
    const triggerSelector = `[data-ai-role="${role}"] [aria-label="${roleLabel} の AI とモデル"]`;
    const modelValue = `provider:${selectedProvider}:${encodeURIComponent(selectedModel)}`;
    await page.waitForSelector(triggerSelector);
    await page.click(triggerSelector);
    await page.waitForSelector('.poiesis-ai-role-pill__popover');
    const exactOption = await page.evaluate(value => [...document.querySelectorAll('.poiesis-select__option')]
        .some(option => option.dataset.value === value && option.getAttribute('aria-disabled') !== 'true'), modelValue);
    if (exactOption) {
        await choosePoiesisSelectOption(page, triggerSelector, modelValue, true);
    } else {
        const customValue = `provider:${selectedProvider}:${encodeURIComponent('__custom__')}`;
        await choosePoiesisSelectOption(page, triggerSelector, customValue, true);
        const customSelector = `[aria-label="${roleLabel} の AI カスタムモデルID"]`;
        await page.waitForSelector(customSelector);
        await page.type(customSelector, selectedModel);
        await page.keyboard.press('Escape');
    }
    return composerPillSnapshot(page, role);
}

async function composerPillSnapshot(page, role) {
    const roleLabel = role === 'agent' ? 'Agent' : 'Results';
    return page.$eval(`[data-ai-role="${role}"]`, (pill, label) => {
        const trigger = pill.querySelector(`[aria-label="${label} の AI とモデル"]`);
        const bounds = pill.getBoundingClientRect();
        return {
            value: trigger?.getAttribute('data-value'),
            text: trigger?.textContent?.trim(),
            warning: pill.classList.contains('warning'),
            bounds: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom }
        };
    }, roleLabel);
}

async function verifyComposerCustomModel(page, role, providerId, restoreModel) {
    const roleLabel = role === 'agent' ? 'Agent' : 'Results';
    const triggerSelector = `[data-ai-role="${role}"] [aria-label="${roleLabel} の AI とモデル"]`;
    const customValue = `provider:${providerId}:${encodeURIComponent('__custom__')}`;
    await page.click(triggerSelector);
    await page.waitForSelector('.poiesis-ai-role-pill__popover');
    await choosePoiesisSelectOption(page, triggerSelector, customValue, true);
    const customInput = `[aria-label="${roleLabel} の AI カスタムモデルID"]`;
    await page.waitForSelector(customInput);
    await page.type(customInput, 'round20-custom-model');
    const custom = await composerPillSnapshot(page, role);
    assert(custom.value === customValue && custom.text?.includes('round20-custom-model'),
        `Custom composer model was not reflected in the pill: ${JSON.stringify(custom)}`);
    await page.keyboard.press('Escape');
    const restored = await selectComposerRole(page, role, providerId, restoreModel);
    return { custom, restored };
}

async function assertSettingsRoleSelections(page, agentProvider, agentModelId, resultsProviderId, resultsModelId) {
    await page.click('.poiesis-agent-window__rail-footer button[aria-label="設定"]');
    await page.waitForSelector('.poiesis-settings-modal');
    for (const [role, providerId, modelId] of [
        ['agent', agentProvider, agentModelId],
        ['results', resultsProviderId, resultsModelId]
    ]) {
        const providerSelector = `input[name="poiesis-${role}-cli"][value="${providerId}"]`;
        assert(await page.$eval(providerSelector, input => input.checked),
            `${role} composer selection was not reflected in Settings provider.`);
        const roleLabel = role === 'agent' ? 'Agent' : 'Results';
        const modelSelector = `[aria-label="${roleLabel} の AI モデル"]`;
        assert(await page.$eval(modelSelector, (trigger, expected) => trigger.dataset.value === expected, modelId),
            `${role} composer selection was not reflected in Settings model.`);
    }
    let settingsToPill;
    if (agentProvider === 'claude') {
        const alternateModel = agentModelId === 'sonnet' ? 'haiku' : 'sonnet';
        await choosePoiesisSelectOption(page, '[aria-label="Agent の AI モデル"]', alternateModel);
        await page.click('.poiesis-settings-modal__header button[aria-label="設定を閉じる"]');
        await page.waitForFunction(() => !document.querySelector('.poiesis-settings-modal'));
        settingsToPill = await composerPillSnapshot(page, 'agent');
        assert(settingsToPill.value === `provider:${agentProvider}:${alternateModel}`,
            `Settings model change was not reflected in the composer pill: ${JSON.stringify(settingsToPill)}`);
        await page.click('.poiesis-agent-window__rail-footer button[aria-label="設定"]');
        await page.waitForSelector('.poiesis-settings-modal');
        await choosePoiesisSelectOption(page, '[aria-label="Agent の AI モデル"]', agentModelId);
    }
    await page.click('.poiesis-settings-modal__header button[aria-label="設定を閉じる"]');
    await page.waitForFunction(() => !document.querySelector('.poiesis-settings-modal'));
    const restored = await composerPillSnapshot(page, 'agent');
    assert(restored.value === `provider:${agentProvider}:${encodeURIComponent(agentModelId)}`,
        `Settings did not restore the composer selection: ${JSON.stringify(restored)}`);
    return { settingsToPill, restored };
}

async function assertComposerPopoverUnclipped(page, role) {
    const roleLabel = role === 'agent' ? 'Agent' : 'Results';
    const triggerSelector = `[data-ai-role="${role}"] [aria-label="${roleLabel} の AI とモデル"]`;
    await page.focus(triggerSelector);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.poiesis-ai-role-pill__popover');
    const snapshot = await page.$eval('.poiesis-ai-role-pill__popover', popover => {
        const rect = popover.getBoundingClientRect();
        const trigger = document.querySelector(`[data-ai-role="${popover.getAttribute('aria-label')?.startsWith('Results') ? 'results' : 'agent'}"] .poiesis-select__trigger`);
        const composer = document.querySelector('.poiesis-agent-window__composer')?.getBoundingClientRect();
        const clippedComposerItems = [...document.querySelectorAll('.poiesis-agent-window__new-agent-context > *, .poiesis-agent-window__composer-footer > *')]
            .filter(element => {
                const bounds = element.getBoundingClientRect();
                return bounds.width > 0 && composer && (bounds.left < composer.left - 1 || bounds.right > composer.right + 1);
            })
            .map(element => ({ className: element.className, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right }));
        return {
            viewport: { width: innerWidth, height: innerHeight },
            bounds: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
            expanded: trigger?.getAttribute('aria-expanded'),
            clippedComposerItems
        };
    });
    assert(snapshot.bounds.left >= 0 && snapshot.bounds.top >= 0
        && snapshot.bounds.right <= snapshot.viewport.width && snapshot.bounds.bottom <= snapshot.viewport.height,
    `Composer AI popover clipped at 1024x600: ${JSON.stringify(snapshot)}`);
    assert(snapshot.clippedComposerItems.length === 0,
        `Composer pill row clipped at 1024x600: ${JSON.stringify(snapshot)}`);
    await page.keyboard.press('ArrowDown');
    const activeDescendant = await page.$eval(triggerSelector, trigger => trigger.getAttribute('aria-activedescendant'));
    assert(activeDescendant, 'Composer AI popover keyboard navigation did not set an active option.');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.poiesis-ai-role-pill__popover'));
    assert(await page.$eval(triggerSelector, trigger => document.activeElement === trigger && trigger.getAttribute('aria-expanded') === 'false'),
        'Composer AI popover did not return focus to its trigger after Escape.');
    return { ...snapshot, keyboard: true, focusReturned: true };
}

async function fill(page, value) {
    await page.focus('[aria-label="Agent へのメッセージ"]');
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(value, { delay: 1 });
    await page.waitForFunction(() => !document.querySelector('[aria-label="Agent へ送信"]')?.disabled);
}

async function clickText(page, selector, text) {
    await page.evaluate(({ selector, text }) => {
        const node = [...document.querySelectorAll(selector)].find(candidate => candidate.textContent?.trim() === text);
        if (!(node instanceof HTMLElement)) throw new Error(`${text} was not found.`);
        node.click();
    }, { selector, text });
}

async function choosePoiesisSelectOption(page, triggerSelector, value, alreadyOpen = false) {
    if (!alreadyOpen) {
        await page.click(triggerSelector);
        await page.waitForSelector('.poiesis-select__listbox');
    }
    const selected = await page.evaluate(nextValue => {
        const option = [...document.querySelectorAll('.poiesis-select__option')]
            .find(candidate => candidate.dataset.value === nextValue);
        if (!(option instanceof HTMLElement)) return false;
        option.click();
        return true;
    }, value);
    assert(selected, `Model option was not found: ${value}`);
    await page.waitForFunction((selector, nextValue) => document.querySelector(selector)?.dataset.value === nextValue,
        {}, triggerSelector, value);
}

async function waitForProcessModelArg(providerId, flag, model, waitTimeout) {
    if (!/^[a-z0-9.-]+$/i.test(providerId) || !/^-{1,2}[a-z]+$/i.test(flag) || !/^[a-z0-9.-]+$/i.test(model)) {
        throw new Error(`Unsafe provider/model argument for process verification: ${providerId} ${flag} ${model}`);
    }
    const startedAfter = new Date(Date.now() - 1_000).toISOString();
    const deadline = Date.now() + waitTimeout;
    while (Date.now() < deadline) {
        const command = [
            `$provider='${providerId.toLocaleLowerCase()}'`,
            `$flag='${flag}'`,
            `$model='${model}'`,
            `$startedAfter=[DateTime]::Parse('${startedAfter}')`,
            "$found=Get-CimInstance Win32_Process | Where-Object { $line=$_.CommandLine; $_.ProcessId -ne $PID -and $_.CreationDate -ge $startedAfter -and $line -and $line.ToLower().Contains($provider) -and $line.Contains($flag) -and $line.Contains($model) } | Select-Object -First 1",
            "if ($found) { 'FOUND' }"
        ].join('; ');
        const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            command], {
            encoding: 'utf8',
            windowsHide: true
        });
        if (result.status === 0 && result.stdout.trim() === 'FOUND') {
            return { provider: providerId, flag, model, observed: true };
        }
        await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
    }
    throw new Error(`Did not observe ${providerId} ${flag} ${model} in a live process command line.`);
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}
