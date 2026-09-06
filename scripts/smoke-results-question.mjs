import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import {
    DURABLE_RESULTS_QUESTION_KEY,
    DURABLE_SESSION_KEY,
    DURABLE_SESSION_MIGRATION_KEY,
    durableStatePath,
    durableValueExists,
    readDurableValue,
    updateDurableValue,
    waitForDurableValue,
    waitForDurableWritesToSettle,
    writeDurableValue
} from './poiesis-smoke-state.mjs';

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
const storageKey = DURABLE_RESULTS_QUESTION_KEY;
const panelStorageKey = 'poiesis.results-qa-panel.sessions.v1';
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
        POIESIS_RESULTS_QUESTION_MOCK_DELAY_MS: '5000'
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
    seedQuestionDurableState();
    await page.goto(uiUrl, { waitUntil: 'domcontentloaded', timeout });
    await waitForApp(page);
    await page.waitForSelector('.poiesis-results__document');
    const documentBefore = await page.$eval('.poiesis-results__document', frame => frame.getAttribute('srcdoc'));
    assert(!await page.$('.poiesis-results__question-panel'), 'Questions must not reserve space in the reading state.');
    assert(!await page.$('.poiesis-results__task-switcher'), 'The old permanent Results rail is still mounted.');

    let frame = await resultsFrame(page);
    await frame.evaluate(() => window.scrollTo(0, 720));
    await frame.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(resolveFrame)));
    const documentScrollBefore = await frame.evaluate(() => window.scrollY);
    assert(documentScrollBefore > 0, `The Results document did not scroll: ${documentScrollBefore}`);

    await page.click('#poiesis-results-question-trigger');
    await page.waitForSelector('.poiesis-results__question-panel [aria-label="表示中の成果について質問"]', { visible: true });
    assert(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === '表示中の成果について質問'),
        'Opening Questions did not focus the input.');
    await page.type('[aria-label="表示中の成果について質問"]', question);
    await page.click('[aria-label="Results 内へ送信"]');
    await page.waitForSelector('.poiesis-results__question-panel .poiesis-results__qa-entry.sending', { visible: true });
    const sending = await page.evaluate(() => ({
        visible: Boolean(document.querySelector('.poiesis-results__qa-entry.sending')),
        expanded: document.querySelector('#poiesis-results-question-trigger')?.getAttribute('aria-expanded') === 'true',
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

    await page.click('[aria-label="質問を閉じる"]');
    await page.waitForFunction(() => !document.querySelector('.poiesis-results__question-panel')
        && document.querySelector('#poiesis-results-question-trigger')?.getAttribute('aria-expanded') === 'false');
    assert(!await page.$('.poiesis-results__qa-history'), 'The pending thread body did not collapse.');
    assert(await page.evaluate(() => document.querySelector('#poiesis-results-question-trigger')?.getAttribute('data-pending') === 'true'),
        'Pending activity was not discoverable after Questions closed.');

    stage = 'pending-reopen-focus';
    await page.click('#poiesis-results-question-trigger');
    await page.waitForSelector('.poiesis-results__question-panel .poiesis-results__qa-entry.sending', { visible: true });
    await page.waitForFunction(() => document.querySelector('.poiesis-results__question-panel')?.contains(document.activeElement)
        && document.activeElement?.getAttribute('aria-label') === '質問を閉じる', { timeout: 2000 });
    const pendingReopen = await page.evaluate(() => {
        const panel = document.querySelector('.poiesis-results__question-panel');
        const input = panel?.querySelector('[aria-label="表示中の成果について質問"]');
        return {
            focusInside: panel?.contains(document.activeElement) === true,
            focusedLabel: document.activeElement?.getAttribute('aria-label'),
            inputDisabled: input instanceof HTMLTextAreaElement && input.disabled
        };
    });
    assert(pendingReopen.focusInside && pendingReopen.focusedLabel === '質問を閉じる' && pendingReopen.inputDisabled,
        `Pending Questions did not move focus to an enabled panel control: ${JSON.stringify(pendingReopen)}`);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.poiesis-results__question-panel')
        && document.activeElement?.id === 'poiesis-results-question-trigger');
    assert(await page.evaluate(() => document.querySelector('#poiesis-results-question-trigger')?.getAttribute('data-pending') === 'true'),
        'Pending activity was lost after closing Questions with Escape.');

    const outcomeNavigationEnabled = await page.$eval('.poiesis-results__outcome-trigger', button => !button.disabled);
    assert(outcomeNavigationEnabled, 'Outcome navigation was disabled while an answer was pending.');
    await page.click('.poiesis-results__outcome-trigger');
    await page.waitForSelector('#poiesis-results-navigator', { visible: true });

    stage = 'answer-arrival';
    await page.waitForFunction(() => document.querySelector('#poiesis-results-question-trigger')?.textContent?.includes('質問 1'));
    assert(!await page.$('.poiesis-results__question-panel'), 'A completed reply reopened Questions after the user closed it.');
    assert(await page.$('#poiesis-results-navigator'), 'Answer completion dismissed the unrelated outcome navigator.');
    await page.click('[aria-label="成果ナビゲーターを閉じる"]');
    await page.waitForFunction(() => !document.querySelector('#poiesis-results-navigator'));
    await page.click('#poiesis-results-question-trigger');
    await page.waitForSelector('.poiesis-results__qa-entry:not(.failed)');
    await page.waitForFunction(expected => document.querySelector('.poiesis-results__qa-entry:not(.failed)')?.textContent?.includes(expected), {}, mockAnswerMarker);
    const answered = await page.evaluate(expected => ({
        visible: document.querySelector('.poiesis-results__qa-entry:not(.failed)')?.textContent?.includes(expected) === true,
        oldNoticeAbsent: !document.querySelector('.poiesis-results__answer'),
        panelCount: document.querySelector('#poiesis-results-question-trigger')?.textContent?.trim(),
        internalOverflow: (() => {
            const body = document.querySelector('.poiesis-results__qa-history');
            return body instanceof HTMLElement && body.scrollHeight > body.clientHeight;
        })()
    }), mockAnswerMarker);
    assert(answered.visible && answered.oldNoticeAbsent && answered.panelCount === '質問 1' && answered.internalOverflow,
        `The completed answer was not contained by the question panel: ${JSON.stringify(answered)}`);
    frame = await resultsFrame(page);
    const documentScrollAfterAnswer = await frame.evaluate(() => window.scrollY);
    assert(documentScrollAfterAnswer === documentScrollBefore,
        `Document scroll moved on answer: ${documentScrollBefore} -> ${documentScrollAfterAnswer}`);

    await page.click('[aria-label="質問を閉じる"]');
    await page.waitForFunction(() => !document.querySelector('.poiesis-results__question-panel'));
    assert(!await page.$('.poiesis-results__qa-history'), 'The completed thread body did not collapse.');
    stage = 'manual-reopen';
    await page.click('#poiesis-results-question-trigger');
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    const reopenState = await page.evaluate((key, expectedSession) => {
        const storageEntry = Object.keys(localStorage).find(candidate => candidate.endsWith(`:${key}`));
        const stored = storageEntry ? JSON.parse(localStorage.getItem(storageEntry) ?? '{}') : {};
        return {
            panelClass: document.querySelector('.poiesis-results__question-panel')?.className,
            expanded: document.querySelector('#poiesis-results-question-trigger')?.getAttribute('aria-expanded'),
            entryCount: document.querySelectorAll('.poiesis-results__qa-entry').length,
            stored: stored.sessions?.[expectedSession]
        };
    }, panelStorageKey, sessionId);
    assert(reopenState.expanded === 'true', `Panel did not reopen: ${JSON.stringify(reopenState)}`);
    await page.waitForSelector('.poiesis-results__question-panel .poiesis-results__qa-entry:not(.failed)');
    const reopened = await page.$eval('.poiesis-results__qa-entry:not(.failed)', (entry, expected) =>
        entry.textContent?.includes(expected) === true, mockAnswerMarker);
    assert(reopened, 'The answer was missing after the panel was reopened.');

    await waitForDurableValue(theiaConfig, storageKey, state => {
        return state?.sessions?.[sessionId]?.[taskId]?.[0]?.answer === mockAnswer;
    }, timeout);

    await page.waitForFunction((key, expectedSession, expectedTask) => {
        const storageEntry = Object.keys(localStorage).find(candidate => candidate.endsWith(`:${key}`));
        if (!storageEntry) return false;
        const state = JSON.parse(localStorage.getItem(storageEntry) ?? '{}');
        return state.sessions?.[expectedSession]?.selectedTaskId === expectedTask
            && state.sessions?.[expectedSession]?.expandedTaskIds?.includes(expectedTask);
    }, {}, panelStorageKey, sessionId, taskId);

    const historyState = readDurableValue(theiaConfig, storageKey);
    const persisted = {
        storagePath: durableStatePath(theiaConfig, storageKey),
        history: historyState?.sessions?.[sessionId]?.[taskId] ?? []
    };
    assert(durableValueExists(theiaConfig, storageKey), `History was not persisted to the durable store: ${persisted.storagePath}`);
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
    await page.waitForSelector('.poiesis-results__question-panel');

    await replaceDurableFixtures(page, () => {
        updateDurableValue(theiaConfig, DURABLE_SESSION_KEY, state => {
            for (const session of state?.sessions ?? []) {
                for (const task of session.tasks ?? []) {
                    if (task.id === taskId) delete task.resultsQuestions;
                }
            }
            return state;
        });
    });
    stage = 'restart-restore';
    await page.waitForSelector('.poiesis-results__question-panel .poiesis-results__qa-entry:not(.failed)');
    const restored = await page.evaluate(expectedAnswer => ({
        count: document.querySelectorAll('.poiesis-results__qa-entry:not(.failed)').length,
        answerVisible: document.querySelector('.poiesis-results__qa-entry:not(.failed)')?.textContent?.includes(expectedAnswer) === true,
        expanded: document.querySelector('#poiesis-results-question-trigger')?.getAttribute('aria-expanded') === 'true',
        documentHtml: document.querySelector('.poiesis-results__document')?.getAttribute('srcdoc')
    }), mockAnswerMarker);
    assert(restored.count === 1 && restored.answerVisible && restored.expanded,
        `History and panel state were not restored: ${JSON.stringify(restored)}`);
    assert(documentBefore === restored.documentHtml
        && restored.documentHtml?.includes('<h1>Stored result document</h1>'),
    'Results Skill HTML was modified by the question flow.');

    await page.click('[aria-label="質問を閉じる"]');
    await page.waitForFunction(() => !document.querySelector('.poiesis-results__question-panel'));
    const readingLayouts = [];
    for (const size of [
        { width: 1280, height: 720 },
        { width: 1000, height: 760 },
        { width: 820, height: 700 }
    ]) {
        await page.setViewport({ ...size, deviceScaleFactor: 1 });
        readingLayouts.push(await assertReadingLayout(page, `${size.width}x${size.height}`));
    }
    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
    const readingBaseline = await assertReadingLayout(page, 'navigator-baseline');
    await page.evaluate(() => {
        window.__poiesisResultsFrameIdentity = document.querySelector('.poiesis-results__document');
    });
    frame = await resultsFrame(page);
    await frame.evaluate(() => window.scrollTo(0, 480));
    const navigatorScrollBefore = await frame.evaluate(() => window.scrollY);
    await page.click('.poiesis-results__outcome-trigger');
    await page.waitForSelector('#poiesis-results-navigator');
    const navigatorLayout = await assertNavigatorLayout(page, readingBaseline, 1);
    const stableWhileNavigatorOpen = await page.evaluate(() => window.__poiesisResultsFrameIdentity === document.querySelector('.poiesis-results__document'));
    frame = await resultsFrame(page);
    const navigatorScrollAfter = await frame.evaluate(() => window.scrollY);
    assert(stableWhileNavigatorOpen && navigatorScrollAfter === navigatorScrollBefore,
        `Opening the navigator replaced or scrolled the document: ${JSON.stringify({ stableWhileNavigatorOpen, navigatorScrollBefore, navigatorScrollAfter })}`);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#poiesis-results-navigator'));
    await page.waitForFunction(() => document.activeElement?.classList.contains('poiesis-results__outcome-trigger'));
    assert(await page.evaluate(() => document.activeElement?.classList.contains('poiesis-results__outcome-trigger')),
        'Closing the navigator did not return focus to its trigger.');

    const retainedDraft = 'Retain this draft while Questions is closed.';
    await page.click('#poiesis-results-question-trigger');
    await page.type('[aria-label="表示中の成果について質問"]', retainedDraft);
    await page.click('[aria-label="質問を閉じる"]');
    assert(await page.evaluate(() => document.querySelector('#poiesis-results-question-trigger')?.getAttribute('data-has-draft') === 'true'),
        'The closed Questions trigger did not expose the retained draft.');
    await page.click('#poiesis-results-question-trigger');
    assert(await page.$eval('[aria-label="表示中の成果について質問"]', input => input.value) === retainedDraft,
        'The question draft was lost after closing and reopening Questions.');
    await page.click('[aria-label="質問を閉じる"]');

    await replaceDurableFixtures(page, () => {
        updateDurableValue(theiaConfig, DURABLE_SESSION_KEY, state => {
            const session = state?.sessions?.[0];
            const source = session?.tasks?.[0];
            if (!session || !source) throw new Error('The stored smoke Task was unavailable.');
            session.tasks.push({
                ...source,
                id: 'results-question-smoke-task-updated',
                title: 'Updated task while rail collapsed',
                request: 'Verify collapsed task count updates.',
                status: 'failed',
                failure: { summary: 'Expected smoke fixture failure.' },
                resultsDocument: undefined
            });
            return state;
        });
    });
    stage = 'navigator-task-update';
    await page.waitForSelector('.poiesis-results__document');
    await page.click('.poiesis-results__outcome-trigger');
    await page.waitForSelector('#poiesis-results-navigator .poiesis-results__task-list');
    const cumulativeTaskCount = await page.$eval(
        '.poiesis-results__requirement-card.active .poiesis-results__requirement-select small',
        node => node.textContent?.replace(/\s+/g, ' ').trim() ?? ''
    );
    assert(cumulativeTaskCount.includes('タスク 2件'),
        `The cumulative Requirement did not retain both Tasks: ${cumulativeTaskCount}`);
    const updatedNavigator = await assertNavigatorLayout(page, await assertReadingLayout(page, 'updated-reading-under-overlay', true), 1);
    await page.click('[aria-label="成果ナビゲーターを閉じる"]');
    const maximized = await maximizeAndAssert(page);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForApp(page);
    stage = 'reading-state-after-restart';
    await page.waitForSelector('.poiesis-results__document');
    const restoredReadingLayout = await assertReadingLayout(page, 'reading-after-restart');

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
        durableHistoryStorage: true,
        panelStateRestored: restored.expanded,
        restoredQuestions: restored.count,
        citationLine: 12,
        navigatorPreservedDocument: stableWhileNavigatorOpen,
        navigatorOverlay: navigatorLayout,
        taskCountAfterUpdate: cumulativeTaskCount,
        retainedDraft: true,
        resizeLayouts: readingLayouts,
        updatedNavigator,
        restoredReadingLayout,
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

async function assertReadingLayout(page, label, allowAuxiliary = false) {
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    const snapshot = await page.evaluate((currentLabel, auxiliaryAllowed) => {
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
        const header = bounds('.poiesis-results__fixed-header');
        const title = bounds('.poiesis-results__fixed-title h1');
        const firstAction = bounds('.poiesis-results__toolbar-actions button');
        return {
            label: currentLabel,
            viewport: { width: innerWidth, height: innerHeight },
            results: bounds('.poiesis-results'),
            main: bounds('.poiesis-results__main'),
            canvas: bounds('.poiesis-results__canvas'),
            header,
            title,
            firstAction,
            frame: bounds('.poiesis-results__document'),
            hasPermanentTaskRail: Boolean(document.querySelector('.poiesis-results__task-switcher')),
            hasPermanentComposer: !auxiliaryAllowed && Boolean(document.querySelector('.poiesis-results__composer')),
            hasAuxiliary: Boolean(document.querySelector('.poiesis-results__auxiliary')),
            horizontalOverflow: document.documentElement.scrollWidth > innerWidth
        };
    }, label, allowAuxiliary);
    assert(snapshot.results && snapshot.main && snapshot.canvas && snapshot.header && snapshot.title && snapshot.firstAction && snapshot.frame,
        `The Results reading layout is incomplete at ${label}: ${JSON.stringify(snapshot)}`);
    assert(!snapshot.hasPermanentTaskRail && !snapshot.hasPermanentComposer,
        `Permanent Results chrome still reserves reading space at ${label}: ${JSON.stringify(snapshot)}`);
    assert(allowAuxiliary || !snapshot.hasAuxiliary,
        `An auxiliary panel remained open in the reading state at ${label}: ${JSON.stringify(snapshot)}`);
    assert(snapshot.main.width === snapshot.results.width
        && snapshot.canvas.width === snapshot.main.width
        && snapshot.frame.width >= snapshot.canvas.width - 2,
    `The document does not own the Results width at ${label}: ${JSON.stringify(snapshot)}`);
    assert(snapshot.header.height <= 52 && snapshot.frame.top <= snapshot.header.bottom + 1,
        `The compact document toolbar is not aligned at ${label}: ${JSON.stringify(snapshot)}`);
    assert(snapshot.title.right <= snapshot.firstAction.left - 4,
        `The title collides with toolbar actions at ${label}: ${JSON.stringify(snapshot)}`);
    if (snapshot.viewport.width === 1280 && snapshot.viewport.height === 720) {
        assert(snapshot.frame.height >= 540,
            `The 1280x720 document viewport is shorter than 540px: ${JSON.stringify(snapshot)}`);
    }
    assert(!snapshot.horizontalOverflow,
        `The Results reading layout overflowed horizontally at ${label}: ${JSON.stringify(snapshot)}`);
    return {
        label,
        viewport: snapshot.viewport,
        canvasWidth: snapshot.canvas.width,
        canvasHeight: snapshot.canvas.height,
        frameWidth: snapshot.frame.width,
        frameHeight: snapshot.frame.height,
        headerHeight: snapshot.header.height
    };
}

async function assertNavigatorLayout(page, readingBaseline, expectedCount) {
    await page.$eval('#poiesis-results-navigator', async element => {
        await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished));
    });
    const snapshot = await page.evaluate(() => {
        const element = document.querySelector('#poiesis-results-navigator');
        const canvas = document.querySelector('.poiesis-results__canvas');
        const results = document.querySelector('.poiesis-results');
        const rect = node => {
            const bounds = node?.getBoundingClientRect();
            return bounds && { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.width };
        };
        return {
            navigator: rect(element),
            canvas: rect(canvas),
            results: rect(results),
            cardCount: document.querySelectorAll('#poiesis-results-navigator .poiesis-results__requirement-card').length,
            expanded: document.querySelector('.poiesis-results__outcome-trigger')?.getAttribute('aria-expanded'),
            dialog: element?.getAttribute('role'),
            modal: element?.getAttribute('aria-modal'),
            horizontalOverflow: document.documentElement.scrollWidth > innerWidth
        };
    });
    assert(snapshot.navigator && snapshot.canvas && snapshot.results
        && snapshot.cardCount === expectedCount
        && snapshot.expanded === 'true'
        && snapshot.dialog === 'dialog'
        && snapshot.modal === 'true',
    `The outcome navigator contract is incomplete: ${JSON.stringify(snapshot)}`);
    assert(Math.round(snapshot.canvas.width) === readingBaseline.canvasWidth
        && snapshot.navigator.left >= snapshot.results.left
        && snapshot.navigator.right <= snapshot.results.right + 1
        && !snapshot.horizontalOverflow,
    `The outcome navigator changed or escaped the reading surface: ${JSON.stringify({ snapshot, readingBaseline })}`);
    return { width: Math.round(snapshot.navigator.width), cardCount: snapshot.cardCount };
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
        const metaItems = [...header?.querySelectorAll('.poiesis-results__status, time, .poiesis-results__diffstat, .poiesis-results__badges > span') ?? []];
        const rowCount = elements => new Set([...elements].map(element => {
            const rect = element.getBoundingClientRect();
            return Math.round(rect.top + rect.height / 2);
        })).size;
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
                metaRows: rowCount(metaItems),
                badgeRows: badges instanceof HTMLElement ? rowCount(badges.children) : 0,
                metaBounds: metaItems.map(element => {
                    const rect = element.getBoundingClientRect();
                    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
                }),
                appliedSkillsTitle: [...badges?.children ?? []]
                    .find(element => element.getAttribute('title')?.includes('verification-evidence-policy'))?.getAttribute('title')
            } : undefined,
            historyOverflow: history instanceof HTMLElement && history.scrollHeight > history.clientHeight,
            expanded: document.querySelector('.poiesis-results__qa-toggle')?.getAttribute('aria-expanded') === 'true'
        };
    }, label);
    assert(snapshot.main && snapshot.canvas && snapshot.panel && snapshot.composer && snapshot.header && snapshot.title && snapshot.headerStyle,
        `Docked layout is incomplete at ${label}: ${JSON.stringify(snapshot)}`);
    assert(snapshot.title.width >= snapshot.header.width * 0.45,
        `The Results title used less than 45 percent at ${label}: ${JSON.stringify(snapshot)}`);
    assert(snapshot.headerStyle.lineClamp === '1'
        && snapshot.headerStyle.appliedSkillsTitle?.includes('verification-evidence-policy')
        && snapshot.headerStyle.metaBounds.every(item => item.left >= snapshot.header.left - 1
            && item.right <= snapshot.header.right + 1
            && item.top >= snapshot.header.top - 1
            && item.bottom <= snapshot.header.bottom + 1),
    `The responsive Results header contract is incomplete at ${label}: ${JSON.stringify(snapshot)}`);
    if (snapshot.canvas.width > 700) {
        assert(snapshot.headerStyle.metaRows === 1 && snapshot.header.height <= 40,
            `The Results metadata did not retain a compact row at ${label}: ${JSON.stringify(snapshot)}`);
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
    return { nativeMaximize, layout: await assertReadingLayout(page, 'maximized') };
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

function seedQuestionDurableState() {
    const now = new Date().toISOString();
    writeDurableValue(theiaConfig, DURABLE_SESSION_KEY, {
        version: 1,
        selectedSessionId: sessionId,
        railWidth: 258,
        railCollapsed: false,
        sessions: [{
            id: sessionId,
            createdAt: Date.now() - 60_000,
            updatedAt: Date.now(),
            workspaceUri: pathToFileURL(repositoryRoot).toString(),
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
            selectedResultsTaskId: taskId,
            resultsDrafts: [],
            tasks: [{
                id: taskId,
                sessionId,
                title: 'Stored result task with a deliberately long Application-owned title for responsive header verification',
                request: 'Update docs/UX.md',
                status: 'completed',
                startedAt: now,
                endedAt: now,
                appliedSkills: {
                    agent: ['workspace-review-checklist', 'responsive-results-layout-guidance', 'verification-evidence-policy'],
                    results: []
                },
                baseline: { kind: 'workspace-snapshot', capturedAt: now },
                changeSet: {
                    source: 'task-diff',
                    diff: 'diff --git a/docs/UX.md b/docs/UX.md\n+Results question smoke',
                    files: ['docs/UX.md'],
                    capturedAt: now
                }
            }],
            resultsDocuments: [{ taskId, status: 'ready', html: resultsHtml }]
        }]
    });
    writeDurableValue(theiaConfig, DURABLE_SESSION_MIGRATION_KEY, true);
}

async function replaceDurableFixtures(page, mutate) {
    await page.goto('about:blank', { waitUntil: 'domcontentloaded' });
    await waitForDurableWritesToSettle(theiaConfig, timeout);
    mutate();
    await page.goto(uiUrl, { waitUntil: 'domcontentloaded', timeout });
    await waitForApp(page);
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
