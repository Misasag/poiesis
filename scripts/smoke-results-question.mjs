import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = process.cwd();
const repositoryRoot = root;
const timeout = Number(process.env.THEIA_SMOKE_UI_TIMEOUT ?? 120_000);
const executablePath = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean).find(candidate => existsSync(candidate));
if (!executablePath) throw new Error('Chrome or Edge was not found.');

const runDirectory = resolve(root, '.run', `results-question-${Date.now()}`);
const browserProfile = resolve(runDirectory, 'browser-profile');
const emptyPlugins = resolve(runDirectory, 'empty-plugins');
const theiaConfig = resolve(runDirectory, 'theia-config');
const theiaCli = resolve(root, 'node_modules', '@theia', 'cli', 'bin', 'theia.js');
const storageKey = 'poiesis.results-question.sessions.v1';
const panelStorageKey = 'poiesis.results-qa-panel.sessions.v1';
const sessionStorageKey = 'poiesis:global:poiesis.agent-window.sessions.global.v1';
const migrationStorageKey = 'poiesis:global:poiesis.agent-window.sessions.migrated.v1';
const mockAnswerMarker = 'MOCK_RESULTS_ANSWER';
const mockAnswer = `${mockAnswerMarker}: docs/UX.md:12\n\n${Array.from({ length: 36 }, (_, index) =>
    `Verification detail ${index + 1} keeps the docked thread long enough to exercise its internal scrollbar.`).join(' ')}`;
const question = 'Which file changed?';
const taskId = 'results-question-smoke-task';
const sessionId = 'results-question-smoke-session';
const resultsHtml = '<!doctype html><html lang="en"><body><h1>Stored result document</h1><p>docs/UX.md changed.</p><div style="height:2400px"></div><p>Document end.</p></body></html>';

mkdirSync(emptyPlugins, { recursive: true });
const port = await freePort();
const uiUrl = `http://127.0.0.1:${port}`;
const serverProcess = spawn(process.execPath, [
    theiaCli,
    'start',
    '..',
    `--plugins=local-dir:${emptyPlugins.replaceAll('\\', '/')}`,
    '--hostname', '127.0.0.1',
    '--port', String(port)
], {
    cwd: resolve(root, 'browser-app'),
    env: {
        ...process.env,
        THEIA_CONFIG_DIR: theiaConfig,
        POIESIS_DISABLE_CLI_DETECTION: '1',
        POIESIS_RESULTS_QUESTION_MOCK_REPLY: mockAnswer,
        POIESIS_RESULTS_QUESTION_MOCK_DELAY_MS: '900'
    },
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
for (const stream of [serverProcess.stdout, serverProcess.stderr]) {
    stream?.on('data', chunk => {
        serverLog = `${serverLog}${chunk.toString()}`.slice(-30_000);
    });
}

let browser;
let stage = 'startup';
try {
    await waitForServer(uiUrl, serverProcess, timeout);
    browser = await puppeteer.launch({
        executablePath,
        headless: true,
        userDataDir: browserProfile,
        defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
        args: ['--disable-gpu', '--no-first-run', '--no-sandbox']
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(timeout);
    await page.goto(uiUrl, { waitUntil: 'domcontentloaded', timeout });
    await waitForApp(page);

    const now = new Date().toISOString();
    await page.evaluate(fixture => {
        localStorage.setItem(fixture.sessionStorageKey, JSON.stringify({
            version: 1,
            selectedSessionId: fixture.sessionId,
            railWidth: 258,
            railCollapsed: false,
            sessions: [{
                id: fixture.sessionId,
                createdAt: Date.now() - 60_000,
                updatedAt: Date.now(),
                workspaceUri: fixture.workspaceUri,
                branch: 'main',
                runTarget: 'local',
                title: 'Results question smoke',
                hasUserMessage: true,
                lastTaskStatus: 'completed',
                unreadTaskCompletion: false,
                pinned: false,
                archived: false,
                activeTab: 'results',
                agentDraft: '',
                messages: [{ id: 'seed-user', role: 'user', content: 'Create the stored result.', complete: true }],
                selectedResultsTaskId: fixture.taskId,
                resultsDrafts: [],
                tasks: [{
                    id: fixture.taskId,
                    sessionId: fixture.sessionId,
                    title: 'Stored result task with a deliberately long Application-owned title for responsive header verification',
                    request: 'Update docs/UX.md',
                    status: 'completed',
                    startedAt: fixture.now,
                    endedAt: fixture.now,
                    appliedSkills: {
                        agent: ['workspace-review-checklist', 'responsive-results-layout-guidance', 'verification-evidence-policy'],
                        results: []
                    },
                    baseline: { kind: 'workspace-snapshot', capturedAt: fixture.now },
                    changeSet: {
                        source: 'task-diff',
                        diff: 'diff --git a/docs/UX.md b/docs/UX.md\n+Results question smoke',
                        files: ['docs/UX.md'],
                        capturedAt: fixture.now
                    }
                }],
                resultsDocuments: [{ taskId: fixture.taskId, status: 'ready', html: fixture.resultsHtml }]
            }]
        }));
        localStorage.setItem(fixture.migrationStorageKey, 'true');
    }, {
        sessionStorageKey,
        migrationStorageKey,
        sessionId,
        taskId,
        workspaceUri: pathToFileURL(repositoryRoot).toString(),
        now,
        resultsHtml
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForApp(page);
    await page.waitForSelector('.poiesis-results__document');
    const documentBefore = await page.$eval('.poiesis-results__document', frame => frame.getAttribute('srcdoc'));
    assert(!await page.$('.poiesis-results__qa-panel'), 'The zero-question panel header must be hidden.');

    let frame = await resultsFrame(page);
    await frame.evaluate(() => window.scrollTo(0, 720));
    await frame.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(resolveFrame)));
    const documentScrollBefore = await frame.evaluate(() => window.scrollY);
    assert(documentScrollBefore > 0, `The Results document did not scroll: ${documentScrollBefore}`);

    await page.type('[aria-label="表示中の成果について質問"]', question);
    await page.click('[aria-label="Results 内へ送信"]');
    await page.waitForSelector('.poiesis-results__qa-panel.expanded .poiesis-results__qa-entry.sending', { visible: true });
    const sending = await page.evaluate(() => ({
        visible: Boolean(document.querySelector('.poiesis-results__qa-entry.sending')),
        expanded: document.querySelector('.poiesis-results__qa-toggle')?.getAttribute('aria-expanded') === 'true',
        questionVisible: document.querySelector('.poiesis-results__qa-entry.sending')?.textContent?.includes('Which file changed?') === true,
        sendDisabled: document.querySelector('[aria-label="Results 内へ送信"]')?.disabled === true,
        composerDisabled: document.querySelector('[aria-label="表示中の成果について質問"]')?.disabled === true
    }));
    assert(sending.visible && sending.expanded && sending.questionVisible && sending.sendDisabled && sending.composerDisabled,
        `Sending state was incomplete: ${JSON.stringify(sending)}`);
    frame = await resultsFrame(page);
    const documentScrollAfterSend = await frame.evaluate(() => window.scrollY);
    assert(documentScrollAfterSend === documentScrollBefore,
        `Document scroll moved on send: ${documentScrollBefore} -> ${documentScrollAfterSend}`);

    await page.click('[aria-label="質問パネルをたたむ"]');
    await page.waitForSelector('.poiesis-results__qa-panel.collapsed [aria-expanded="false"]');
    assert(!await page.$('.poiesis-results__qa-history'), 'The pending thread body did not collapse.');

    stage = 'answer-arrival';
    await page.waitForSelector('.poiesis-results__qa-entry:not(.failed)');
    await page.waitForFunction(expected => document.querySelector('.poiesis-results__qa-entry:not(.failed)')?.textContent?.includes(expected), {}, mockAnswerMarker);
    await page.waitForSelector('.poiesis-results__qa-panel.expanded [aria-expanded="true"]');
    const answered = await page.evaluate(expected => ({
        visible: document.querySelector('.poiesis-results__qa-entry:not(.failed)')?.textContent?.includes(expected) === true,
        oldNoticeAbsent: !document.querySelector('.poiesis-results__answer'),
        panelCount: document.querySelector('.poiesis-results__qa-toggle-title strong')?.textContent?.trim(),
        internalOverflow: (() => {
            const body = document.querySelector('.poiesis-results__qa-history');
            return body instanceof HTMLElement && body.scrollHeight > body.clientHeight;
        })()
    }), mockAnswerMarker);
    assert(answered.visible && answered.oldNoticeAbsent && answered.panelCount === '質問 1件' && answered.internalOverflow,
        `The completed answer was not contained by the docked panel: ${JSON.stringify(answered)}`);
    frame = await resultsFrame(page);
    const documentScrollAfterAnswer = await frame.evaluate(() => window.scrollY);
    assert(documentScrollAfterAnswer === documentScrollBefore,
        `Document scroll moved on answer: ${documentScrollBefore} -> ${documentScrollAfterAnswer}`);

    await page.click('[aria-label="質問パネルをたたむ"]');
    await page.waitForSelector('.poiesis-results__qa-panel.collapsed [aria-expanded="false"]');
    assert(!await page.$('.poiesis-results__qa-history'), 'The completed thread body did not collapse.');
    stage = 'manual-reopen';
    await page.click('[aria-label="質問パネルを展開"]');
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    const reopenState = await page.evaluate((key, expectedSession) => {
        const storageEntry = Object.keys(localStorage).find(candidate => candidate.endsWith(`:${key}`));
        const stored = storageEntry ? JSON.parse(localStorage.getItem(storageEntry) ?? '{}') : {};
        return {
            panelClass: document.querySelector('.poiesis-results__qa-panel')?.className,
            expanded: document.querySelector('.poiesis-results__qa-toggle')?.getAttribute('aria-expanded'),
            entryCount: document.querySelectorAll('.poiesis-results__qa-entry').length,
            stored: stored.sessions?.[expectedSession]
        };
    }, panelStorageKey, sessionId);
    assert(reopenState.expanded === 'true', `Panel did not reopen: ${JSON.stringify(reopenState)}`);
    await page.waitForSelector('.poiesis-results__qa-panel.expanded .poiesis-results__qa-entry:not(.failed)');
    const reopened = await page.$eval('.poiesis-results__qa-entry:not(.failed)', (entry, expected) =>
        entry.textContent?.includes(expected) === true, mockAnswerMarker);
    assert(reopened, 'The answer was missing after the panel was reopened.');

    await page.waitForFunction((key, expectedSession, expectedTask, expectedAnswer) => {
        const storageEntry = Object.keys(localStorage).find(candidate => candidate.endsWith(`:${key}`));
        if (!storageEntry) return false;
        const state = JSON.parse(localStorage.getItem(storageEntry) ?? '{}');
        return state.sessions?.[expectedSession]?.[expectedTask]?.[0]?.answer === expectedAnswer;
    }, {}, storageKey, sessionId, taskId, mockAnswer);

    await page.waitForFunction((key, expectedSession, expectedTask) => {
        const storageEntry = Object.keys(localStorage).find(candidate => candidate.endsWith(`:${key}`));
        if (!storageEntry) return false;
        const state = JSON.parse(localStorage.getItem(storageEntry) ?? '{}');
        return state.sessions?.[expectedSession]?.selectedTaskId === expectedTask
            && state.sessions?.[expectedSession]?.expandedTaskIds?.includes(expectedTask);
    }, {}, panelStorageKey, sessionId, taskId);

    const persisted = await page.evaluate((key, expectedSession, expectedTask) => {
        const storageEntry = Object.keys(localStorage).find(candidate => candidate.endsWith(`:${key}`));
        const state = storageEntry ? JSON.parse(localStorage.getItem(storageEntry) ?? '{}') : {};
        return {
            storageEntry,
            history: state.sessions?.[expectedSession]?.[expectedTask] ?? []
        };
    }, storageKey, sessionId, taskId);
    assert(persisted.storageEntry?.startsWith('theia:'), `History did not use Theia StorageService: ${persisted.storageEntry}`);
    assert(persisted.history.length === 1, `Unexpected persisted history: ${JSON.stringify(persisted.history)}`);

    const panelPersisted = await page.evaluate((key, expectedSession) => {
        const storageEntry = Object.keys(localStorage).find(candidate => candidate.endsWith(`:${key}`));
        const state = storageEntry ? JSON.parse(localStorage.getItem(storageEntry) ?? '{}') : {};
        return { storageEntry, state: state.sessions?.[expectedSession] };
    }, panelStorageKey, sessionId);
    assert(panelPersisted.storageEntry?.startsWith('theia:')
        && panelPersisted.state?.selectedTaskId === taskId
        && panelPersisted.state?.expandedTaskIds?.includes(taskId),
    `Panel state did not use Theia StorageService: ${JSON.stringify(panelPersisted)}`);

    await page.click('.poiesis-results__qa-history a[data-poiesis-file-uri]');
    stage = 'citation-jump';
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__content')?.getAttribute('data-mode') === 'code');
    await page.waitForFunction(() => [...document.querySelectorAll('.poiesis-agent-window__code-editor-host .line-numbers.active-line-number')]
        .some(line => line.textContent?.trim() === '12'));
    await page.click('.poiesis-agent-window__code-control');
    stage = 'code-return';
    await page.waitForSelector('.poiesis-results__qa-panel.expanded');

    await page.evaluate((key, expectedTask) => {
        const state = JSON.parse(localStorage.getItem(key) ?? '{}');
        for (const session of state.sessions ?? []) {
            for (const task of session.tasks ?? []) {
                if (task.id === expectedTask) delete task.resultsQuestions;
            }
        }
        localStorage.setItem(key, JSON.stringify(state));
    }, sessionStorageKey, taskId);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForApp(page);
    stage = 'restart-restore';
    await page.waitForSelector('.poiesis-results__qa-panel.expanded .poiesis-results__qa-entry:not(.failed)');
    const restored = await page.evaluate(expectedAnswer => ({
        count: document.querySelectorAll('.poiesis-results__qa-entry:not(.failed)').length,
        answerVisible: document.querySelector('.poiesis-results__qa-entry:not(.failed)')?.textContent?.includes(expectedAnswer) === true,
        expanded: document.querySelector('.poiesis-results__qa-toggle')?.getAttribute('aria-expanded') === 'true',
        documentHtml: document.querySelector('.poiesis-results__document')?.getAttribute('srcdoc')
    }), mockAnswerMarker);
    assert(restored.count === 1 && restored.answerVisible && restored.expanded,
        `History and panel state were not restored: ${JSON.stringify(restored)}`);
    assert(documentBefore === restored.documentHtml
        && restored.documentHtml?.includes('<h1>Stored result document</h1>'),
    'Results Skill HTML was modified by the question flow.');

    const expandedBaseline = await assertTaskRailLayout(page, 'expanded-baseline', false, 1);
    await page.click('[aria-label="要件レールを折りたたむ"]');
    await page.waitForSelector('.poiesis-results[data-task-rail-collapsed="true"] .poiesis-results__task-switcher[data-collapsed="true"]');
    const collapsedBaseline = await assertTaskRailLayout(page, 'collapsed-baseline', true, 1);
    assert(collapsedBaseline.canvasWidth >= expandedBaseline.canvasWidth + 100,
        `The Results canvas did not gain the task rail width: ${JSON.stringify({ expandedBaseline, collapsedBaseline })}`);
    await page.waitForFunction(key => {
        const storageEntry = Object.keys(localStorage).find(candidate => candidate.endsWith(`:${key}`));
        const state = storageEntry ? JSON.parse(localStorage.getItem(storageEntry) ?? '{}') : {};
        return state.taskRailCollapsed === true;
    }, {}, panelStorageKey);

    const collapsedLayouts = [];
    for (const size of [{ width: 1280, height: 720 }, { width: 1400, height: 800 }]) {
        await page.setViewport({ ...size, deviceScaleFactor: 1 });
        const label = `collapsed-${size.width}x${size.height}`;
        collapsedLayouts.push({
            ...await assertDockedLayout(page, label),
            ...await assertTaskRailLayout(page, label, true, 1)
        });
    }
    const collapsedMaximized = await maximizeAndAssert(page);
    collapsedLayouts.push({
        ...collapsedMaximized.layout,
        ...await assertTaskRailLayout(page, 'collapsed-maximized', true, 1)
    });

    await page.evaluate((key, newTaskId) => {
        const state = JSON.parse(localStorage.getItem(key) ?? '{}');
        const session = state.sessions?.[0];
        const source = session?.tasks?.[0];
        if (!session || !source) throw new Error('The stored smoke Task was unavailable.');
        session.tasks.push({
            ...source,
            id: newTaskId,
            title: 'Updated task while rail collapsed',
            request: 'Verify collapsed task count updates.',
            status: 'failed',
            failure: { summary: 'Expected smoke fixture failure.' },
            resultsDocument: undefined
        });
        localStorage.setItem(key, JSON.stringify(state));
    }, sessionStorageKey, 'results-question-smoke-task-updated');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForApp(page);
    stage = 'task-rail-collapsed-restore';
    await page.waitForSelector('.poiesis-results[data-task-rail-collapsed="true"] .poiesis-results__task-switcher[data-collapsed="true"]');
    const restoredCollapsedRail = await assertTaskRailLayout(page, 'collapsed-after-restart-and-task-update', true, 1);

    await page.click('[aria-label="要件レールを展開"]');
    await page.waitForSelector('.poiesis-results[data-task-rail-collapsed="false"] .poiesis-results__task-list');
    const expandedAfterRestore = await assertTaskRailLayout(page, 'expanded-after-restore', false, 1);
    const cumulativeTaskCount = await page.$eval(
        '.poiesis-results__requirement-card.active .poiesis-results__requirement-select small',
        node => node.textContent?.replace(/\s+/g, ' ').trim() ?? ''
    );
    assert(cumulativeTaskCount.includes('タスク 2件'),
        `The cumulative Requirement did not retain both Tasks: ${cumulativeTaskCount}`);
    assert(restoredCollapsedRail.canvasWidth >= expandedAfterRestore.canvasWidth + 100,
        `The expanded task rail did not reclaim its width: ${JSON.stringify({ restoredCollapsedRail, expandedAfterRestore })}`);
    await page.waitForFunction(key => {
        const storageEntry = Object.keys(localStorage).find(candidate => candidate.endsWith(`:${key}`));
        const state = storageEntry ? JSON.parse(localStorage.getItem(storageEntry) ?? '{}') : {};
        return state.taskRailCollapsed === false;
    }, {}, panelStorageKey);

    const expandedLayouts = [];
    for (const size of [{ width: 1280, height: 720 }, { width: 1400, height: 800 }]) {
        await page.setViewport({ ...size, deviceScaleFactor: 1 });
        const label = `expanded-${size.width}x${size.height}`;
        expandedLayouts.push({
            ...await assertDockedLayout(page, label),
            ...await assertTaskRailLayout(page, label, false, 1)
        });
    }
    const maximized = await maximizeAndAssert(page);
    expandedLayouts.push({
        ...maximized.layout,
        ...await assertTaskRailLayout(page, 'expanded-maximized', false, 1)
    });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForApp(page);
    stage = 'task-rail-expanded-restore';
    await page.waitForSelector('.poiesis-results[data-task-rail-collapsed="false"] .poiesis-results__task-list');
    const restoredExpandedRail = await assertTaskRailLayout(page, 'expanded-after-restart', false, 1);

    await page.click('#poiesis-agent-tab');
    await page.waitForSelector('.poiesis-agent-window__agent');
    const agentIsolation = await page.evaluate((expectedQuestion, expectedAnswer) => {
        const text = document.querySelector('.poiesis-agent-window__messages')?.textContent ?? '';
        return {
            messageCount: document.querySelectorAll('[aria-label="あなたのメッセージ"], [aria-label="Agent のメッセージ"]').length,
            containsQuestion: text.includes(expectedQuestion),
            containsAnswer: text.includes(expectedAnswer)
        };
    }, question, mockAnswer);
    assert(agentIsolation.messageCount === 1 && !agentIsolation.containsQuestion && !agentIsolation.containsAnswer,
        `Results thread leaked into Agent conversation: ${JSON.stringify(agentIsolation)}`);

    console.log(`RESULTS_QUESTION_SMOKE_RESULT=${JSON.stringify({
        provider: 'mock',
        sendingVisible: sending.visible,
        answerVisible: answered.visible,
        documentScrollStable: documentScrollBefore === documentScrollAfterSend
            && documentScrollBefore === documentScrollAfterAnswer,
        collapsedAndReopened: reopened,
        theiaStorage: true,
        panelStateRestored: restored.expanded,
        restoredQuestions: restored.count,
        citationLine: 12,
        taskRailCanvasGain: collapsedBaseline.canvasWidth - expandedBaseline.canvasWidth,
        taskRailCollapsedRestored: restoredCollapsedRail.collapsed,
        taskRailExpandedRestored: !restoredExpandedRail.collapsed,
        taskCountAfterUpdate: restoredCollapsedRail.taskCount,
        resizeLayouts: { collapsed: collapsedLayouts, expanded: expandedLayouts },
        nativeMaximize: maximized.nativeMaximize,
        agentMessageCount: agentIsolation.messageCount,
        skillHtmlUnchanged: true
    })}`);
} catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${stage}: ${ascii(detail)}\nServer log (ASCII):\n${ascii(serverLog)}`);
} finally {
    if (browser) await browser.close().catch(() => undefined);
    stopProcessTree(serverProcess);
    rmSync(runDirectory, { recursive: true, force: true });
}

async function resultsFrame(page) {
    const handle = await page.$('.poiesis-results__document');
    const frame = await handle?.contentFrame();
    if (!frame) throw new Error('The Results document frame was not attached.');
    return frame;
}

async function assertDockedLayout(page, label) {
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    const snapshot = await page.evaluate(currentLabel => {
        const bounds = selector => {
            const element = document.querySelector(selector);
            if (!(element instanceof HTMLElement)) return undefined;
            const rect = element.getBoundingClientRect();
            return {
                left: Math.round(rect.left),
                top: Math.round(rect.top),
                right: Math.round(rect.right),
                bottom: Math.round(rect.bottom),
                width: Math.round(rect.width),
                height: Math.round(rect.height)
            };
        };
        const history = document.querySelector('.poiesis-results__qa-history');
        const header = document.querySelector('.poiesis-results__fixed-header');
        const title = header?.querySelector('.poiesis-results__fixed-title');
        const titleHeading = title?.querySelector('h1');
        const meta = header?.querySelector('.poiesis-results__fixed-meta');
        const badges = meta?.querySelector('.poiesis-results__badges');
        const rowCount = elements => new Set([...elements].map(element => Math.round(element.getBoundingClientRect().top))).size;
        return {
            label: currentLabel,
            viewport: { width: innerWidth, height: innerHeight },
            main: bounds('.poiesis-results__main'),
            canvas: bounds('.poiesis-results__canvas'),
            panel: bounds('.poiesis-results__qa-panel'),
            composer: bounds('.poiesis-results__composer'),
            header: bounds('.poiesis-results__fixed-header'),
            title: bounds('.poiesis-results__fixed-title'),
            headerStyle: titleHeading instanceof HTMLElement ? {
                lineClamp: getComputedStyle(titleHeading).webkitLineClamp,
                metaWrap: meta instanceof HTMLElement ? getComputedStyle(meta).flexWrap : undefined,
                badgeWrap: badges instanceof HTMLElement ? getComputedStyle(badges).flexWrap : undefined,
                metaRows: meta instanceof HTMLElement ? rowCount(meta.children) : 0,
                badgeRows: badges instanceof HTMLElement ? rowCount(badges.children) : 0,
                appliedSkillsTitle: [...badges?.children ?? []]
                    .find(element => element.textContent?.includes('適用 Skills:'))?.getAttribute('title')
            } : undefined,
            historyOverflow: history instanceof HTMLElement && history.scrollHeight > history.clientHeight,
            expanded: document.querySelector('.poiesis-results__qa-toggle')?.getAttribute('aria-expanded') === 'true'
        };
    }, label);
    assert(snapshot.main && snapshot.canvas && snapshot.panel && snapshot.composer && snapshot.header && snapshot.title && snapshot.headerStyle,
        `Docked layout is incomplete at ${label}: ${JSON.stringify(snapshot)}`);
    assert(snapshot.title.width >= snapshot.header.width * 0.45,
        `The Results title used less than 45 percent at ${label}: ${JSON.stringify(snapshot)}`);
    assert(snapshot.headerStyle.lineClamp === '2'
        && snapshot.headerStyle.metaWrap === 'wrap'
        && snapshot.headerStyle.badgeWrap === 'wrap'
        && snapshot.headerStyle.appliedSkillsTitle?.includes('verification-evidence-policy'),
    `The responsive Results header contract is incomplete at ${label}: ${JSON.stringify(snapshot)}`);
    if (snapshot.viewport.width <= 1400) {
        assert(snapshot.headerStyle.metaRows >= 2,
            `The Results metadata did not wrap at ${label}: ${JSON.stringify(snapshot)}`);
    }
    assert(snapshot.expanded, `The panel collapsed unexpectedly at ${label}.`);
    assert(snapshot.canvas.bottom <= snapshot.panel.top + 1,
        `The panel overlaps the Results canvas at ${label}: ${JSON.stringify(snapshot)}`);
    assert(snapshot.panel.bottom <= snapshot.composer.top + 1,
        `The panel is not docked above the composer at ${label}: ${JSON.stringify(snapshot)}`);
    assert(snapshot.panel.left >= snapshot.main.left && snapshot.panel.right <= snapshot.main.right,
        `The panel escaped the Results column at ${label}: ${JSON.stringify(snapshot)}`);
    assert(snapshot.composer.left >= snapshot.main.left && snapshot.composer.right <= snapshot.main.right
        && snapshot.composer.bottom <= snapshot.main.bottom + 1,
    `The composer escaped the Results column at ${label}: ${JSON.stringify(snapshot)}`);
    assert(snapshot.panel.height <= snapshot.main.height * 0.4 + 2,
        `The panel exceeded 40 percent at ${label}: ${JSON.stringify(snapshot)}`);
    assert(snapshot.historyOverflow, `The panel did not keep the long thread internally scrollable at ${label}.`);
    return {
        label,
        viewport: snapshot.viewport,
        panelHeight: snapshot.panel.height,
        mainHeight: snapshot.main.height,
        historyOverflow: snapshot.historyOverflow,
        titleWidthRatio: Number((snapshot.title.width / snapshot.header.width).toFixed(3)),
        metaRows: snapshot.headerStyle.metaRows,
        badgeRows: snapshot.headerStyle.badgeRows
    };
}

async function assertTaskRailLayout(page, label, expectedCollapsed, expectedCount) {
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    const snapshot = await page.evaluate(currentLabel => {
        const rect = selector => {
            const element = document.querySelector(selector);
            if (!(element instanceof HTMLElement)) return undefined;
            const bounds = element.getBoundingClientRect();
            return {
                left: Math.round(bounds.left),
                right: Math.round(bounds.right),
                width: Math.round(bounds.width)
            };
        };
        const results = document.querySelector('.poiesis-results');
        const rail = document.querySelector('.poiesis-results__task-switcher');
        const count = document.querySelector('.poiesis-results__task-count');
        return {
            label: currentLabel,
            collapsed: results?.getAttribute('data-task-rail-collapsed') === 'true'
                && rail?.getAttribute('data-collapsed') === 'true',
            results: rect('.poiesis-results'),
            main: rect('.poiesis-results__main'),
            canvas: rect('.poiesis-results__canvas'),
            panel: rect('.poiesis-results__qa-panel'),
            composer: rect('.poiesis-results__composer'),
            rail: rect('.poiesis-results__task-switcher'),
            taskCount: Number(count?.textContent?.trim()),
            collapseButton: Boolean(document.querySelector('[aria-label="要件レールを折りたたむ"]')),
            expandButton: Boolean(document.querySelector('[aria-label="要件レールを展開"]')),
            horizontalOverflow: document.documentElement.scrollWidth > innerWidth
        };
    }, label);
    assert(snapshot.results && snapshot.main && snapshot.canvas && snapshot.panel && snapshot.composer && snapshot.rail,
        `The Results task rail layout is incomplete at ${label}: ${JSON.stringify(snapshot)}`);
    assert(snapshot.collapsed === expectedCollapsed,
        `The Results task rail state is wrong at ${label}: ${JSON.stringify(snapshot)}`);
    assert(snapshot.taskCount === expectedCount,
        `The Results task badge is wrong at ${label}: ${JSON.stringify(snapshot)}`);
    assert(expectedCollapsed ? snapshot.expandButton && !snapshot.collapseButton : snapshot.collapseButton && !snapshot.expandButton,
        `The Results task rail toggle is wrong at ${label}: ${JSON.stringify(snapshot)}`);
    assert(expectedCollapsed ? snapshot.rail.width >= 40 && snapshot.rail.width <= 44 : snapshot.rail.width >= 190,
        `The Results task rail width is wrong at ${label}: ${JSON.stringify(snapshot)}`);
    assert(snapshot.main.right <= snapshot.rail.left + 1
        && snapshot.canvas.right <= snapshot.main.right
        && snapshot.panel.right <= snapshot.main.right
        && snapshot.composer.right <= snapshot.main.right,
    `Results content escaped its responsive column at ${label}: ${JSON.stringify(snapshot)}`);
    assert(!snapshot.horizontalOverflow,
        `The Results layout overflowed horizontally at ${label}: ${JSON.stringify(snapshot)}`);
    return {
        label,
        collapsed: snapshot.collapsed,
        taskCount: snapshot.taskCount,
        railWidth: snapshot.rail.width,
        canvasWidth: snapshot.canvas.width,
        composerWidth: snapshot.composer.width,
        panelWidth: snapshot.panel.width
    };
}

async function maximizeAndAssert(page) {
    const client = await page.createCDPSession();
    let nativeMaximize = false;
    try {
        const { windowId } = await client.send('Browser.getWindowForTarget');
        await client.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });
        nativeMaximize = true;
    } catch {
        // Headless Chromium may not expose a native window, so viewport emulation remains the layout oracle.
    } finally {
        await client.detach();
    }
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    return { nativeMaximize, layout: await assertDockedLayout(page, 'maximized') };
}

async function freePort() {
    return new Promise((resolvePort, rejectPort) => {
        const probe = createServer();
        probe.once('error', rejectPort);
        probe.listen(0, '127.0.0.1', () => {
            const address = probe.address();
            const selected = typeof address === 'object' && address ? address.port : undefined;
            probe.close(error => error || selected === undefined ? rejectPort(error ?? new Error('No free port.')) : resolvePort(selected));
        });
    });
}

async function waitForServer(url, child, waitTimeout) {
    const deadline = Date.now() + waitTimeout;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Theia exited with code ${child.exitCode}.`);
        try {
            const response = await fetch(url);
            if (response.ok) return;
        } catch {
            // The server is still starting.
        }
        await new Promise(resolveDelay => setTimeout(resolveDelay, 200));
    }
    throw new Error('Timed out waiting for the Theia browser application.');
}

async function waitForApp(page) {
    await page.waitForSelector('#poiesis-window-host .poiesis-agent-window__content:not(.poiesis-agent-window__content--initializing)');
}

function stopProcessTree(child) {
    if (child.exitCode !== null || child.pid === undefined) return;
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.kill();
    if (process.platform === 'win32') {
        spawnSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            shell: false,
            stdio: 'ignore'
        });
    }
    child.unref();
}

function ascii(value) {
    return value.replace(/[^\x20-\x7E\r\n\t]/g, '?');
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}
