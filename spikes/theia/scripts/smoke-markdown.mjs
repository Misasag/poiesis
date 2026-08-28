import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const executablePath = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean).find(existsSync);
if (!executablePath) throw new Error('Chrome or Edge was not found.');

const url = process.env.THEIA_SMOKE_UI_URL ?? 'http://127.0.0.1:3000';
const profile = resolve(process.cwd(), '.run', `markdown-smoke-${Date.now()}`);
const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    userDataDir: profile,
    defaultViewport: { width: 1280, height: 720 },
    args: ['--no-sandbox', '--disable-gpu', '--no-first-run']
});

try {
    const page = await browser.newPage();
    page.setDefaultTimeout(120_000);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.poiesis-agent-window__content:not(.poiesis-agent-window__content--initializing)');
    await installMarkdownFixture(page);

    const agent = await page.evaluate(() => {
        const userMessage = document.querySelector('.poiesis-agent-window__user-message');
        const agentMessage = document.querySelector('.poiesis-agent-window__message');
        const markdown = agentMessage?.querySelector('.poiesis-markdown');
        const fileLink = markdown?.querySelector('a[data-poiesis-file-uri]');
        const externalLink = markdown?.querySelector('a[data-poiesis-external-uri]');
        return {
            userStayedPlain: !userMessage?.querySelector('.poiesis-markdown, a, strong')
                && userMessage?.textContent?.includes('[user-link](SCRATCH-DEMO.md)'),
            fileLinkText: fileLink?.textContent,
            fileUri: fileLink?.getAttribute('data-poiesis-file-uri')
                ? decodeURIComponent(fileLink.getAttribute('data-poiesis-file-uri'))
                : undefined,
            fileLinkCount: markdown?.querySelectorAll('a[data-poiesis-file-uri]').length ?? 0,
            externalUri: externalLink?.getAttribute('data-poiesis-external-uri'),
            fenceText: markdown?.querySelector('pre code')?.textContent,
            hasList: Boolean(markdown?.querySelector('ul > li')),
            hasBold: Boolean(markdown?.querySelector('strong')),
            javascriptAnchorCount: markdown?.querySelectorAll('a[href^="javascript:"]').length ?? -1,
            rawImageCount: markdown?.querySelectorAll('img').length ?? -1,
            outsideIsCode: [...(markdown?.querySelectorAll('code') ?? [])]
                .some(element => element.textContent === 'C:\\Windows\\system32\\drivers\\etc\\hosts')
        };
    });
    assert(agent.userStayedPlain, `User markdown was unexpectedly rendered: ${JSON.stringify(agent)}`);
    assert(agent.fileLinkText === 'SCRATCH-DEMO.md' && agent.fileUri?.endsWith('/SCRATCH-DEMO.md')
        && agent.fileLinkCount === 2,
        `Workspace file link was not prepared: ${JSON.stringify(agent)}`);
    assert(agent.externalUri === 'https://example.com/', `HTTP link was not preserved safely: ${JSON.stringify(agent)}`);
    assert(agent.fenceText?.includes('# fenced heading') && agent.hasList && agent.hasBold,
        `Assistant markdown structure was not rendered: ${JSON.stringify(agent)}`);
    assert(agent.javascriptAnchorCount === 0 && agent.rawImageCount === 0 && agent.outsideIsCode,
        `Unsafe or outside-workspace content was interactive: ${JSON.stringify(agent)}`);

    await page.click('#poiesis-results-tab');
    await page.waitForSelector('.poiesis-results__qa-history .poiesis-markdown');
    const results = await page.evaluate(() => ({
        bold: document.querySelector('.poiesis-results__qa-history .poiesis-markdown strong')?.textContent,
        fileUri: document.querySelector('.poiesis-results__qa-history a[data-poiesis-file-uri]')
            ?.getAttribute('data-poiesis-file-uri')
            ? decodeURIComponent(document.querySelector('.poiesis-results__qa-history a[data-poiesis-file-uri]')
                .getAttribute('data-poiesis-file-uri'))
            : undefined
    }));
    assert(results.bold === 'Results answer' && results.fileUri?.endsWith('/SCRATCH-DEMO.md'),
        `Results Q&A markdown was not rendered: ${JSON.stringify(results)}`);

    await page.click('#poiesis-agent-tab');
    await page.click('.poiesis-agent-window__message a[data-poiesis-file-uri]');
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__content')?.getAttribute('data-mode') === 'code');
    await page.waitForFunction(() => [...document.querySelectorAll('.poiesis-agent-window__code-editor-tab-name')]
        .some(element => element.textContent?.trim() === 'SCRATCH-DEMO.md'));
    const opened = await page.evaluate(() => ({
        mode: document.querySelector('.poiesis-agent-window__content')?.getAttribute('data-mode'),
        tabs: [...document.querySelectorAll('.poiesis-agent-window__code-editor-tab-name')]
            .map(element => element.textContent?.trim())
    }));
    console.log(`MARKDOWN_SMOKE_RESULT=${JSON.stringify({ agent, results, opened }, null, 2)}`);
} finally {
    await browser.close();
}

async function installMarkdownFixture(page) {
    const now = Date.now();
    await page.evaluate(timestamp => {
        const key = 'poiesis:global:poiesis.agent-window.sessions.global.v1';
        const current = JSON.parse(localStorage.getItem(key) ?? '{}');
        const workspaceUri = current.sessions?.find(session => typeof session.workspaceUri === 'string')?.workspaceUri;
        if (!workspaceUri) throw new Error('The current workspace URI was not available for the markdown fixture.');
        const workspacePath = decodeURIComponent(new URL(workspaceUri).pathname)
            .replace(/^\/([A-Za-z]:)/, '$1')
            .replaceAll('/', '\\');
        const filePath = `${workspacePath}\\SCRATCH-DEMO.md`;
        const taskId = 'markdown-smoke-task';
        localStorage.setItem(key, JSON.stringify({
            version: 1,
            selectedSessionId: 'markdown-smoke-session',
            railWidth: 276,
            railCollapsed: false,
            sessions: [{
                id: 'markdown-smoke-session',
                createdAt: timestamp - 60_000,
                updatedAt: timestamp,
                workspaceUri,
                branch: 'main',
                runTarget: 'local',
                title: 'Markdown smoke',
                hasUserMessage: true,
                lastTaskStatus: 'completed',
                pinned: false,
                archived: false,
                activeTab: 'agent',
                agentDraft: '',
                messages: [
                    {
                        id: 'markdown-user',
                        role: 'user',
                        content: '[user-link](SCRATCH-DEMO.md) **must stay plain**',
                        complete: true
                    },
                    {
                        id: 'markdown-agent',
                        role: 'agent',
                        content: [
                            `[SCRATCH-DEMO.md](${filePath}) was created.`,
                            'Bare path: SCRATCH-DEMO.md',
                            '',
                            '**Summary** with `inline code`:',
                            '',
                            '- first item',
                            '- second item',
                            '',
                            '```markdown',
                            '# fenced heading',
                            '```',
                            '',
                            '[external](https://example.com/)',
                            '[outside](C:\\Windows\\system32\\drivers\\etc\\hosts)',
                            '[unsafe](javascript:alert(1))',
                            '<img src="https://example.com/raw.png">'
                        ].join('\n'),
                        complete: true,
                        taskId
                    }
                ],
                selectedResultsTaskId: taskId,
                resultsDrafts: [],
                tasks: [{
                    id: taskId,
                    sessionId: 'markdown-runtime-session',
                    title: 'Markdown smoke',
                    request: 'Markdown smoke',
                    status: 'completed',
                    startedAt: new Date(timestamp - 30_000).toISOString(),
                    endedAt: new Date(timestamp - 20_000).toISOString(),
                    baseline: { kind: 'workspace-snapshot', capturedAt: new Date(timestamp - 30_000).toISOString() },
                    changeSet: { source: 'empty', diff: '', files: [], capturedAt: new Date(timestamp - 20_000).toISOString() },
                    resultsQuestions: [{
                        question: 'What changed?',
                        answer: `**Results answer**: [SCRATCH-DEMO.md](${filePath})`,
                        timestamp: new Date(timestamp - 10_000).toISOString()
                    }]
                }],
                resultsDocuments: [{
                    taskId,
                    status: 'ready',
                    html: '<!doctype html><html lang="ja"><body><main><h1>Markdown smoke</h1></main></body></html>'
                }]
            }]
        }));
        localStorage.setItem('poiesis:global:poiesis.agent-window.sessions.migrated.v1', 'true');
    }, now);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.poiesis-agent-window__content:not(.poiesis-agent-window__content--initializing)');
    await page.waitForSelector('.poiesis-agent-window__message .poiesis-markdown');
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}
