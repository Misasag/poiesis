import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const executablePath = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean).find(candidate => existsSync(candidate));
if (!executablePath) {
    throw new Error('Chrome or Edge was not found.');
}

const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    defaultViewport: { width: 1500, height: 850, deviceScaleFactor: 1 },
    args: ['--disable-gpu', '--no-first-run', '--no-sandbox']
});

try {
    const page = await browser.newPage();
    page.setDefaultTimeout(180_000);
    await page.goto('http://127.0.0.1:3000', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.poiesis-agent-window__new-agent-empty');

    const exampleCount = await page.$$eval('.poiesis-agent-window__example-prompts button', buttons => buttons.length);
    assert(exampleCount === 3, `Expected three example prompts, got ${exampleCount}.`);
    await page.click('.poiesis-agent-window__example-prompts button');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Agent へのメッセージ');
    const example = await page.$eval('[aria-label="Agent へのメッセージ"]', input => ({
        value: input.value,
        focused: document.activeElement === input
    }));
    assert(example.value === 'READMEに導入手順のセクションを追加して', 'The example prompt did not fill the composer.');
    assert(example.focused, 'The example prompt did not focus the composer.');

    await page.click('[aria-label="設定"]');
    await page.waitForSelector('.poiesis-settings-modal');
    await page.evaluate(() => {
        const button = [...document.querySelectorAll('.poiesis-settings-modal button')]
            .find(candidate => candidate.textContent?.includes('一覧を開く'));
        button?.click();
    });
    await page.waitForSelector('.poiesis-shortcuts');
    const shortcutText = await page.$eval('.poiesis-shortcuts', element => element.textContent ?? '');
    for (const expected of ['Agentへ送信', 'Resultsへ質問を送信', 'Codeでファイルを保存', 'CodeでTerminalを開閉', 'Esc']) {
        assert(shortcutText.includes(expected), `Shortcut overlay is missing ${expected}.`);
    }
    await page.keyboard.press('Escape');
    await page.waitForSelector('.poiesis-shortcuts', { hidden: true });
    assert(await page.$('.poiesis-settings-modal'), 'Esc should close the shortcut overlay before Settings.');

    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    const motion = await page.$eval('.poiesis-settings-modal__text-button', element => ({
        transitionDuration: getComputedStyle(element).transitionDuration,
        animationDuration: getComputedStyle(element).animationDuration
    }));
    assert(motion.transitionDuration.split(',').every(value => value.trim() === '0s'), `Reduced motion transition remains ${motion.transitionDuration}.`);
    assert(motion.animationDuration === '0s', `Reduced motion animation remains ${motion.animationDuration}.`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.poiesis-settings-modal', { hidden: true });

    await page.click('.poiesis-agent-window__rail-action[title="カスタマイズ"]');
    await page.waitForSelector('.poiesis-customize-modal');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.poiesis-customize-modal', { hidden: true });

    await page.click('[aria-label="フォルダーを開いてリポジトリを選択または追加"]');
    await page.waitForSelector('.poiesis-agent-window__workspace-picker');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.poiesis-agent-window__workspace-picker', { hidden: true });

    const controlBorder = await page.$eval('.poiesis-agent-window__composer', element => getComputedStyle(element).borderColor);
    assert(controlBorder === 'rgb(112, 114, 107)', `Composer control border is ${controlBorder}.`);

    await page.evaluate(() => {
        const now = new Date().toISOString();
        const taskId = 'round10-results-task';
        const rawFailure = "error: the argument '--sandbox <SANDBOX_MODE>' cannot be used here. Usage: codex exec [OPTIONS]. Codex exited with code 2. 実行に失敗しました。";
        localStorage.setItem('poiesis:global:poiesis.agent-window.sessions.global.v1', JSON.stringify({
            version: 1,
            selectedSessionId: 'round10-session',
            railWidth: 258,
            railCollapsed: false,
            sessions: [{
                id: 'round10-session',
                createdAt: Date.now() - 60_000,
                updatedAt: Date.now(),
                workspaceUri: 'file:///C:/Users/owner/github/poiesis',
                branch: 'main',
                runTarget: 'local',
                title: 'Round 10 verification',
                hasUserMessage: true,
                lastTaskStatus: 'completed',
                unreadTaskCompletion: false,
                pinned: false,
                archived: false,
                activeTab: 'results',
                agentDraft: '',
                messages: [{ id: 'legacy-cli-error', role: 'agent', content: rawFailure, complete: true }],
                selectedResultsTaskId: taskId,
                resultsDrafts: [],
                tasks: [{
                    id: taskId,
                    sessionId: 'round10-session',
                    title: 'Round 10の成果を確認',
                    request: 'Round 10の表示を確認する',
                    status: 'completed',
                    startedAt: now,
                    endedAt: now,
                    baseline: { kind: 'workspace-snapshot', capturedAt: now },
                    changeSet: {
                        source: 'task-diff',
                        diff: 'diff --git a/docs/UX.md b/docs/UX.md\\n+Round 10 verification',
                        files: ['docs/UX.md'],
                        capturedAt: now
                    }
                }],
                resultsDocuments: [{
                    taskId,
                    status: 'ready',
                    html: '<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>html,body{min-height:100%;margin:0;background:#f1efe8;color:#262721}main{padding:32px}</style></head><body><main><h1>Round 10の成果</h1><p>変更ファイルは docs/UX.md です。</p></main></body></html>'
                }]
            }]
        }));
        localStorage.setItem('poiesis:global:poiesis.agent-window.sessions.migrated.v1', 'true');
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.poiesis-results__document');
    await page.click('#poiesis-agent-tab');
    await page.waitForSelector('.poiesis-agent-window__message-error');
    const migratedError = await page.$eval('.poiesis-agent-window__message-error', element => ({
        summary: element.querySelector('strong')?.textContent ?? '',
        details: element.querySelector('pre')?.textContent ?? ''
    }));
    assert(migratedError.summary.includes('起動オプション'), 'Legacy CLI error did not receive the designed summary.');
    assert(migratedError.details.includes('Usage: codex'), 'Legacy CLI raw details were not preserved.');
    await page.click('#poiesis-results-tab');
    await page.waitForSelector('.poiesis-results__document');

    await askResults(page, 'この成果の見出しは何ですか？短く答えてください。', 1);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.poiesis-results__qa-entry');
    assert(await page.$$eval('.poiesis-results__qa-entry', entries => entries.length) === 1, 'The first Q&A did not survive reload.');
    await askResults(page, '変更ファイル名は何ですか？短く答えてください。', 2);

    await page.setViewport({ width: 1100, height: 700, deviceScaleFactor: 1 });
    const resized = await page.evaluate(() => ({
        rail: document.querySelector('.poiesis-agent-window__rail')?.getBoundingClientRect().width ?? 0,
        root: document.querySelector('.poiesis-agent-window__content')?.getBoundingClientRect().width ?? 0,
        viewport: innerWidth
    }));
    assert(resized.rail > 0, 'The rail collapsed after browser resize.');
    assert(Math.abs(resized.root - resized.viewport) < 2, 'The app root no longer fills the resized viewport.');

    console.log(`ROUND10_BROWSER_SMOKE=${JSON.stringify({
        examplePrompts: exampleCount,
        reducedMotion: motion,
        controlBorder,
        legacyErrorSummary: migratedError.summary,
        questionHistory: 2,
        resized
    })}`);
} finally {
    await browser.close();
}

async function askResults(page, question, expectedCount) {
    await page.waitForSelector('[aria-label="表示中の成果について質問"]:not([disabled])');
    await page.type('[aria-label="表示中の成果について質問"]', question);
    await page.click('[aria-label="Results 内へ送信"]');
    await page.waitForFunction(count => document.querySelectorAll('.poiesis-results__qa-entry').length === count, {}, expectedCount);
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}
