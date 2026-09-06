import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const browserUrl = option('--cdp') ?? option('--browser-url');
const workspaceArg = option('--workspace');
const timeout = Number(process.env.THEIA_SMOKE_UI_TIMEOUT ?? 180_000);
if (!browserUrl || !workspaceArg) {
    throw new Error('Usage: node scripts/smoke-code-task-review.mjs --cdp <browser-url> --workspace <disposable-workspace>');
}

const workspace = resolve(workspaceArg);
const reviewFile = resolve(workspace, 'src', 'todo.js');
if (!existsSync(reviewFile)) {
    throw new Error(`The disposable workspace does not contain src/todo.js: ${workspace}`);
}
const original = readFileSync(reviewFile, 'utf8');
const runDirectory = resolve(process.cwd(), '.run', `code-task-review-${Date.now()}`);
const screenshotPath = resolve(runDirectory, 'code-task-review.png');
const failureScreenshotPath = resolve(runDirectory, 'failure.png');
mkdirSync(runDirectory, { recursive: true });

const firstSaved = `${original.trimEnd()}\n\nexport const savedTaskOne = 'first saved state';\n`;
const secondSaved = `${firstSaved.trimEnd()}\nexport const savedTaskTwo = 'second saved state';\n`;
const laterWorkingTree = `${secondSaved.trimEnd()}\nexport const laterWorkingTree = 'not part of either task';\n`;

let browser;
let page;
try {
    browser = await puppeteer.connect({ browserURL: browserUrl, defaultViewport: null });
    const pages = await browser.pages();
    page = pages.find(candidate => candidate.url() !== 'about:blank' && !candidate.url().startsWith('devtools://'));
    if (!page) throw new Error('The running Poiesis page was not found.');
    page.setDefaultTimeout(timeout);
    await page.waitForSelector('.poiesis-agent-window__content:not(.poiesis-agent-window__content--initializing)');
    const workspaceName = await page.evaluate(() => {
        const container = window.theia.container;
        const key = [...container._bindingDictionary._map.keys()]
            .find(candidate => typeof candidate === 'function' && candidate.name === 'AgentWindowWidget');
        return container.get(key).sessions.workspaceFolderName();
    });
    assert(workspaceName.toLocaleLowerCase() === basename(workspace).toLocaleLowerCase(),
        `The app workspace is ${workspaceName}; expected ${basename(workspace)}.`);

    const baselineOne = await captureSnapshot(page);
    writeFileSync(reviewFile, firstSaved, 'utf8');
    const endOne = await captureSnapshot(page);
    const changesOne = await captureChanges(page, baselineOne, endOne);
    writeFileSync(reviewFile, secondSaved, 'utf8');
    const endTwo = await captureSnapshot(page);
    const changesTwo = await captureChanges(page, endOne, endTwo);
    writeFileSync(reviewFile, laterWorkingTree, 'utf8');

    await page.evaluate(({ first, second, baselineOneId, endOneId, endTwoId }) => {
        const container = window.theia.container;
        const key = [...container._bindingDictionary._map.keys()]
            .find(candidate => typeof candidate === 'function' && candidate.name === 'AgentWindowWidget');
        const widget = container.get(key);
        const session = widget.sessions.selectedSession();
        if (!session) throw new Error('A selected Agent conversation is required.');
        const workspaceUri = widget.sessions.workspaceRoot()?.resource.toString();
        const now = Date.now();
        const makeTask = (id, title, startedAt, endedAt, baselineSnapshotId, endSnapshotId, capture) => ({
            id,
            sessionId: session.id,
            requirementId: 'code-review-smoke',
            title,
            request: title,
            requirementChoice: 'default',
            workspaceUri,
            status: 'completed',
            startedAt,
            endedAt,
            completionSummary: `${title}を完了しました。`,
            outcomeKind: 'result',
            baseline: { kind: 'workspace-snapshot', capturedAt: startedAt },
            baselineSnapshotId,
            endSnapshotId,
            changeSet: { ...capture, capturedAt: endedAt }
        });
        const taskOne = makeTask(
            `task-code-review-one-${now}`,
            '最初の保存済み変更',
            new Date(now - 20_000).toISOString(),
            new Date(now - 15_000).toISOString(),
            baselineOneId,
            endOneId,
            first
        );
        const taskTwo = makeTask(
            `task-code-review-two-${now}`,
            '次の保存済み変更',
            new Date(now - 10_000).toISOString(),
            new Date(now - 5_000).toISOString(),
            endOneId,
            endTwoId,
            second
        );
        widget.taskService.restore([taskOne, taskTwo]);
        session.hasUserMessage = true;
        session.title = '保存済み変更の確認';
        session.activeTab = 'agent';
        session.taskIds = [...new Set([...session.taskIds, taskOne.id, taskTwo.id])];
        session.messages = [
            { id: `user-one-${now}`, role: 'user', content: taskOne.request, complete: true },
            { id: `agent-one-${now}`, role: 'agent', content: taskOne.completionSummary, complete: true, taskId: taskOne.id },
            { id: `user-two-${now}`, role: 'user', content: taskTwo.request, complete: true },
            { id: `agent-two-${now}`, role: 'agent', content: taskTwo.completionSummary, complete: true, taskId: taskTwo.id }
        ];
        widget.sessions.persistWindowState();
        widget.update();
    }, {
        first: changesOne,
        second: changesTwo,
        baselineOneId: baselineOne,
        endOneId: endOne,
        endTwoId: endTwo
    });

    await page.waitForFunction(() => document.querySelectorAll('.poiesis-agent-window__diffstat-chip').length === 2);
    await page.focus('.poiesis-agent-window__composer textarea');
    await page.keyboard.type('往復後も残る下書き');
    let chips = await page.$$('.poiesis-agent-window__diffstat-chip');
    await chips[0].click();
    await page.waitForSelector('.poiesis-agent-window__code-change-scope button.active');
    assert(await textOf(page, '.poiesis-agent-window__code-change-scope button.active') === 'このタスク',
        'The completed Task did not enter the saved-change scope.');
    await page.waitForSelector('.poiesis-agent-window__code-task-file[aria-current="true"]');
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__code-editor-tab.active .poiesis-agent-window__code-editor-tab-name')
        ?.textContent?.includes('最初の保存済み変更'));
    const firstHistorical = await readActiveEditor(page);
    assert(!firstHistorical.original.includes('savedTaskOne'), 'The first Task diff did not use its saved before content.');
    assert(firstHistorical.modified.includes('savedTaskOne'), 'The first Task diff did not use its saved after content.');
    assert(!firstHistorical.modified.includes('savedTaskTwo'), 'The first Task diff included the later Task.');
    await clickText(page, '.poiesis-agent-window__code-control', 'Agent');
    await page.waitForSelector('.poiesis-agent-window__composer textarea');
    chips = await page.$$('.poiesis-agent-window__diffstat-chip');
    await chips[1].click();
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__code-editor-tab.active .poiesis-agent-window__code-editor-tab-name')
        ?.textContent?.includes('次の保存済み変更'));
    const historical = await readActiveEditor(page);
    assert(historical.original.includes('savedTaskOne'), 'The second Task diff did not use its saved before content.');
    assert(historical.modified.includes('savedTaskTwo'), 'The second Task diff did not use its saved after content.');
    assert(!historical.modified.includes('laterWorkingTree'), 'The historical after side silently used the current working file.');
    assert(historical.originalUri.startsWith('poiesis-task-review:'), 'The diff original is not the read-only Task resource.');
    assert(historical.modifiedUri.startsWith('poiesis-task-review:'), 'The diff modified side is not the read-only Task resource.');

    await clickText(page, '.poiesis-agent-window__code-change-scope button', 'ワークスペース');
    await page.waitForSelector('.poiesis-agent-window__code-sidebar-host #scm-view');
    assert(await page.$('.poiesis-agent-window__code-editor-tab-name'), 'Switching scope discarded the open historical diff.');
    await clickText(page, '.poiesis-agent-window__code-change-scope button', 'このタスク');
    await page.waitForSelector('.poiesis-agent-window__code-task-file[aria-current="true"]');
    await page.click('.poiesis-agent-window__code-task-changes li.selected .poiesis-agent-window__code-task-file-current');
    await page.waitForFunction(() => {
        const container = window.theia.container;
        const key = [...container._bindingDictionary._map.keys()]
            .find(candidate => typeof candidate === 'function' && candidate.name === 'AgentWindowWidget');
        return container.get(key).codePart.activeCodeCenterWidget?.editor.uri.scheme === 'file';
    });
    const current = await readActiveEditor(page);
    assert(current.value.includes('laterWorkingTree'), 'Opening the current file did not show the later working-tree edit.');

    await clickText(page, '.poiesis-agent-window__code-control', 'Agent');
    await page.waitForSelector('.poiesis-agent-window__composer textarea');
    assert(await page.$eval('.poiesis-agent-window__composer textarea', element => element.value) === '往復後も残る下書き',
        'The originating Agent draft was lost across Task review.');
    assert((await page.$$eval('.poiesis-agent-window__diffstat-chip', elements => elements.length)) === 2,
        'The originating conversation was not restored.');

    await page.screenshot({ path: screenshotPath, fullPage: false });
    console.log(`CODE_TASK_REVIEW_SMOKE_RESULT=${JSON.stringify({
        workspace,
        historicalTab: historical.label,
        currentTab: current.label,
        screenshotPath
    })}`);
} catch (error) {
    await page?.screenshot({ path: failureScreenshotPath, fullPage: false }).catch(() => undefined);
    console.error(`CODE_TASK_REVIEW_SMOKE_FAILURE_SCREENSHOT=${failureScreenshotPath}`);
    throw error;
} finally {
    writeFileSync(reviewFile, original, 'utf8');
    browser?.disconnect();
}

async function captureSnapshot(page) {
    const capture = await page.evaluate(async () => {
        const container = window.theia.container;
        const key = [...container._bindingDictionary._map.keys()]
            .find(candidate => typeof candidate === 'function' && candidate.name === 'AgentWindowWidget');
        const widget = container.get(key);
        return widget.agentRuntimeServer.captureGitSnapshot({
            workspacePath: widget.sessions.workspaceRoot()?.resource.path.fsPath()
        });
    });
    if (capture.source !== 'git-snapshot' || !capture.snapshotId) {
        throw new Error(`Could not capture smoke snapshot: ${JSON.stringify(capture)}`);
    }
    return capture.snapshotId;
}

async function captureChanges(page, fromSnapshotId, toSnapshotId) {
    const capture = await page.evaluate(({ from, to }) => {
        const container = window.theia.container;
        const key = [...container._bindingDictionary._map.keys()]
            .find(candidate => typeof candidate === 'function' && candidate.name === 'AgentWindowWidget');
        return container.get(key).agentRuntimeServer.captureGitChangeSetBetween({
            fromSnapshotId: from,
            toSnapshotId: to,
            paths: ['src/todo.js']
        });
    }, { from: fromSnapshotId, to: toSnapshotId });
    if (capture.source !== 'task-diff' || capture.files.length !== 1 || capture.files[0] !== 'src/todo.js') {
        throw new Error(`Could not capture the expected smoke change: ${JSON.stringify(capture)}`);
    }
    return capture;
}

async function readActiveEditor(page) {
    return page.evaluate(() => {
        const container = window.theia.container;
        const key = [...container._bindingDictionary._map.keys()]
            .find(candidate => typeof candidate === 'function' && candidate.name === 'AgentWindowWidget');
        const editor = container.get(key).codePart.activeCodeCenterWidget?.editor;
        const control = editor?.getControl();
        const originalEditor = editor?.diffEditor?.getOriginalEditor?.();
        const modifiedEditor = editor?.diffEditor?.getModifiedEditor?.();
        return {
            label: document.querySelector('.poiesis-agent-window__code-editor-tab.active .poiesis-agent-window__code-editor-tab-name')?.textContent ?? '',
            value: control?.getModel?.()?.getValue?.() ?? '',
            original: originalEditor?.getModel()?.getValue() ?? '',
            modified: modifiedEditor?.getModel()?.getValue() ?? '',
            originalUri: originalEditor?.getModel()?.uri.toString() ?? '',
            modifiedUri: modifiedEditor?.getModel()?.uri.toString() ?? ''
        };
    });
}

async function textOf(page, selector) {
    return page.$eval(selector, element => element.textContent?.trim() ?? '');
}

async function clickText(page, selector, text) {
    await page.waitForFunction(({ currentSelector, currentText }) => [...document.querySelectorAll(currentSelector)]
        .some(element => element.textContent?.trim() === currentText), {}, { currentSelector: selector, currentText: text });
    await page.evaluate(({ currentSelector, currentText }) => {
        const element = [...document.querySelectorAll(currentSelector)]
            .find(candidate => candidate.textContent?.trim() === currentText);
        if (!(element instanceof HTMLElement)) throw new Error(`${currentText} was not clickable.`);
        element.click();
    }, { currentSelector: selector, currentText: text });
}

function option(name) {
    const index = process.argv.indexOf(name);
    return index === -1 ? undefined : process.argv[index + 1];
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}
