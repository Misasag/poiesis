import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { resolveResultsImages } = require('../agent-window/lib/node/results-images.js');
const constants = require('../agent-window/lib/common/results-images.js');
const root = await mkdtemp(join(tmpdir(), 'poiesis-results-images-'));
const workspace = join(root, 'workspace');
await mkdir(workspace);
const uri = pathToFileURL(workspace).href;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG1sAAAAASUVORK5CYII=', 'base64');
let browser;
try {
    await writeFile(join(workspace, 'shot.png'), png);
    await writeFile(join(root, 'outside.png'), png);
    await mkdir(join(root, 'outside'));
    await writeFile(join(root, 'outside/secret.png'), png);
    await symlink(join(root, 'outside'), join(workspace, 'escape'), 'junction');
    await writeFile(join(workspace, 'fake.png'), '<html>not an image</html>', 'utf8');
    await writeFile(join(workspace, 'text.txt'), png);
    await writeFile(join(workspace, 'vector.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="30" height="30"/></svg>', 'utf8');
    const valid = await resolveResultsImages(uri, ['shot.png', 'vector.svg']);
    assert.equal(valid.images.length, 2);
    assert.equal(valid.diagnostics.length, 0);
    for (const path of ['../outside.png', '..\\outside.png', 'escape/secret.png', join(root, 'outside.png'),
        'https://example.org/a.png', 'file:///a.png', '%2e%2e/outside.png', 'shot.png:secret', 'missing.png', 'fake.png', 'text.txt']) {
        const result = await resolveResultsImages(uri, [path]);
        assert.equal(result.images.length, 0, path); assert.equal(result.diagnostics.length, 1, path);
    }
    const large = Buffer.alloc(constants.RESULTS_IMAGE_MAX_BYTES + 1); png.copy(large);
    await writeFile(join(workspace, 'large.png'), large);
    assert.equal((await resolveResultsImages(uri, ['large.png'])).images.length, 0);
    const names = Array.from({ length: 5 }, (_, index) => `cap-${index}.png`);
    for (const name of names) await writeFile(join(workspace, name), large.subarray(0, constants.RESULTS_IMAGE_MAX_BYTES));
    const capped = await resolveResultsImages(uri, names);
    assert.equal(capped.images.length, 4); assert.equal(capped.diagnostics.length, 1);
    assert.equal((await resolveResultsImages(uri, Array.from({ length: 41 }, (_, index) => `${index}.png`))).diagnostics.length, 41);
    for (const [name, bytes] of [['photo.jpg', [255, 216, 255, 0]], ['anim.gif', Buffer.from('GIF89a')], ['picture.webp', Buffer.from('RIFF1234WEBP')]]) {
        await writeFile(join(workspace, name), Buffer.from(bytes));
        assert.equal((await resolveResultsImages(uri, [name])).images.length, 1, name);
    }

    const executablePath = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(path => path && existsSync(path));
    browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.addScriptTag({ path: resolve('node_modules/dompurify/dist/purify.js') });
    const code = await readFile('agent-window/lib/browser/results-rich-content.js', 'utf8');
    const trustedScript = await readFile('agent-window/skills/poiesis-results/assets/document.js', 'utf8');
    const declared = JSON.parse(await readFile('agent-window/skills/poiesis-results/trusted-scripts.json', 'utf8'));
    const hashScript = script => createHash('sha256').update(script.replace(/\r\n?/g, '\n')).digest('base64');
    assert(declared.sha256.includes(hashScript(trustedScript)));
    for (const tag of ['v0.4.0', 'v0.4.1']) {
        const prior = spawnSync('git', ['show', `${tag}:agent-window/skills/poiesis-results/assets/document.js`],
            { encoding: 'utf8', windowsHide: true, shell: false });
        assert.equal(prior.status, 0, prior.stderr);
        assert(declared.sha256.includes(hashScript(prior.stdout)), `${tag} document script remains trusted`);
    }
    const typography = require('../agent-window/lib/browser/typography.js');
    await page.evaluate(({ code, typography, declared }) => {
        window.rich = {};
        new Function('require', 'exports', code)(name => name.includes('dompurify') ? window.DOMPurify
            : name.includes('trusted-scripts.json') ? declared : typography, window.rich);
    }, { code, typography, declared });
    const result = await page.evaluate(() => {
        const original = '<html lang="ja"><head><style>h1 { color:red; }</style></head><body onload="bad()"><h1>自由な見出し</h1><img src="data:image/png;base64,aA==" onclick="bad()"><button id="b">操作</button><script>document.getElementById("b").addEventListener("click",()=>parent.postMessage({type:"fixture-click"},"*"));</script><iframe src="https://bad/"></iframe></body></html>';
        const html = window.rich.resultsFrameHtml(original, 'dark');
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const gate = new window.rich.ResultsFrameRetryGate();
        const retries = [gate.take('document-1', true), gate.take('document-1', false), gate.take('document-1', false), gate.take('document-2', false)];
        return { html, script: doc.querySelectorAll('script').length, handlers: doc.querySelectorAll('[onload],[onclick]').length,
            frame: !!doc.querySelector('iframe'), theme: doc.documentElement.dataset.theme, language: doc.documentElement.lang,
            heading: doc.querySelector('h1').textContent, style: window.rich.RESULTS_RICH_STYLE,
            policy: doc.head.firstElementChild.content, retries };
    });
    assert.equal(result.script, 1); assert.equal(result.handlers, 0); assert.equal(result.frame, false);
    assert.equal(result.theme, 'dark'); assert.equal(result.language, 'ja'); assert.equal(result.heading, '自由な見出し');
    assert.deepEqual(result.retries, [false, true, false, true]);
    assert.equal(result.policy, await page.evaluate(() => window.rich.RESULTS_FRAME_CSP));
    assert(result.policy.includes("script-src 'sha256-") && !result.policy.includes("'unsafe-inline'", result.policy.indexOf('script-src')));
    for (const selector of [...result.style.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:^|})\s*([^{}]+)\{/g)].map(match => match[1].trim())) {
        assert(selector.split(',').every(part => /^:root(?:\[data-theme="dark"\])?$|^::-webkit-scrollbar(?:-[a-z]+)?(?::hover)?$/.test(part.trim())), selector);
    }
    await page.evaluate(html => {
        window.messages = [];
        window.addEventListener('message', event => window.messages.push(event.data));
        const frame = document.createElement('iframe'); frame.sandbox = 'allow-scripts'; frame.srcdoc = html; document.body.append(frame);
    }, result.html);
    const frame = await (await page.waitForSelector('iframe')).contentFrame();
    await frame.waitForSelector('#b'); await frame.click('#b');
    assert.deepEqual(await page.evaluate(() => window.messages), [], 'Untrusted inline script must not execute');
    const trustedHtml = await page.evaluate(script => window.rich.resultsFrameHtml(
        `<html><body><details class="ex-hit"><summary>説明</summary><a data-poiesis-citation="a.ts:1">引用</a>`
        + `<img data-poiesis-image="shot.png" src="data:image/png;base64,aA=="></details>`
        + `<div class="ex-panel-grip" tabindex="0"></div><script>${script}</script></body></html>`, 'light'), trustedScript);
    await page.evaluate(html => {
        const frame = document.createElement('iframe'); frame.sandbox = 'allow-scripts'; frame.srcdoc = html; document.body.append(frame);
    }, trustedHtml);
    const trustedFrame = await (await page.$$('iframe'))[1].contentFrame();
    await trustedFrame.waitForSelector('summary');
    await trustedFrame.click('summary');
    assert.equal(await trustedFrame.$eval('details', node => node.open), true);
    await trustedFrame.click('[data-poiesis-citation]');
    await page.waitForFunction(() => window.messages.some(message => message.type === 'poiesis:open-citation'));
    await trustedFrame.click('[data-poiesis-image]');
    await page.waitForFunction(() => window.messages.some(message => message.type === 'poiesis:open-image'));
    assert(Number(await trustedFrame.$eval('.ex-panel-grip', node => node.getAttribute('aria-valuenow'))) >= 320);
    const gateChecks = await page.evaluate(() => {
        const gate = new window.rich.ResultsFrameMessageGate();
        const element = document.querySelectorAll('iframe')[1];
        const message = origin => new MessageEvent('message', { origin, source: element.contentWindow });
        const before = gate.accept(element, message('null'));
        gate.loaded(element);
        const wrongOrigin = gate.accept(element, message('https://example.invalid'));
        const accepted = Array.from({ length: 20 }, () => gate.accept(element, message('null')));
        const overLimit = gate.accept(element, message('null'));
        gate.loaded(element);
        const afterNavigation = gate.accept(element, message('null'));
        element.srcdoc += '<!-- refreshed document -->';
        gate.loaded(element);
        const afterRefresh = gate.accept(element, message('null'));
        return { before, wrongOrigin, accepted, overLimit, afterNavigation, afterRefresh };
    });
    assert.equal(gateChecks.before, false);
    assert.equal(gateChecks.wrongOrigin, false);
    assert(gateChecks.accepted.every(Boolean));
    assert.equal(gateChecks.overLimit, false);
    assert.equal(gateChecks.afterNavigation, false);
    assert.equal(gateChecks.afterRefresh, true);
    const movedFrame = await page.evaluate(async () => {
        const gate = new window.rich.ResultsFrameMessageGate();
        const element = document.createElement('iframe');
        element.sandbox = 'allow-scripts';
        element.srcdoc = '<p>original</p>';
        document.body.append(element);
        await new Promise(resolveLoad => element.addEventListener('load', resolveLoad, { once: true }));
        gate.loaded(element);
        let accepted = false;
        const received = new Promise(resolveMessage => window.addEventListener('message', event => {
            if (event.data?.type !== 'moved-frame') return;
            accepted = gate.accept(element, event);
            resolveMessage();
        }, { once: true }));
        element.removeAttribute('srcdoc');
        element.src = 'data:text/html,<script>parent.postMessage({type:"moved-frame"},"*")</script>';
        await new Promise(resolveLoad => element.addEventListener('load', resolveLoad, { once: true }));
        gate.loaded(element);
        await received;
        return { accepted, frameLoads: 2 };
    });
    assert.equal(movedFrame.accepted, false, 'Messages from a navigated opaque frame are rejected');
    assert.equal(await frame.evaluate(() => { try { localStorage.setItem('probe', '1'); return false; } catch { return true; } }), true);
    assert.equal(await frame.evaluate(async () => { try { await fetch('https://example.com'); return false; } catch { return true; } }), true);
    for (const allowExternalResources of [false, true]) {
        const html = await page.evaluate(allow => window.rich.resultsFrameHtml(
            '<html><head><meta http-equiv="Content-Security-Policy" content="default-src *">'
            + '<link rel="stylesheet" href="https://results-fixture.invalid/style.css">'
            + '<style>@import "https://results-fixture.invalid/import.css";</style></head><body>'
            + '<h1 id="external">External resources</h1><p id="imported">Imported style</p>'
            + '<img id="external-image" src="https://results-fixture.invalid/image.png" onerror="bad()">'
            + '<script src="https://results-fixture.invalid/evil.js"></script>'
            + '<script>window.untrustedInlineRan = true</script>'
            + '<a href="javascript:bad()">Unsafe link</a></body></html>', 'light', allow), allowExternalResources);
        const externalPage = await browser.newPage();
        const requests = [];
        await externalPage.setRequestInterception(true);
        externalPage.on('request', request => {
            requests.push(request.url());
            void request.respond(request.url().endsWith('.png')
                ? { status: 200, contentType: 'image/png', body: png }
                : { status: 200, contentType: 'text/css', body: '#external { color: rgb(12, 34, 56); } #imported { background-color: rgb(65, 43, 21); }' });
        });
        await externalPage.evaluate(html => {
            const frame = document.createElement('iframe'); frame.sandbox = 'allow-scripts'; frame.srcdoc = html; document.body.append(frame);
        }, html);
        const resourceFrame = await (await externalPage.waitForSelector('iframe')).contentFrame();
        await resourceFrame.waitForSelector('#external');
        await resourceFrame.waitForFunction(() => document.readyState === 'complete');
        const resources = await resourceFrame.evaluate(() => ({
            policies: Array.from(document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]'), meta => meta.content),
            imageWidth: document.querySelector('#external-image').naturalWidth,
            color: getComputedStyle(document.querySelector('#external')).color,
            imported: getComputedStyle(document.querySelector('#imported')).backgroundColor,
            handlers: document.querySelectorAll('[onerror]').length,
            unsafeLink: document.querySelector('a').hasAttribute('href'),
            untrustedInlineRan: window.untrustedInlineRan === true,
            opaque: (() => { try { localStorage.setItem('probe', '1'); return false; } catch { return true; } })()
        }));
        assert.equal(resources.policies.length, 1, 'CSP is mandatory in both resource settings');
        assert(resources.policies[0].includes('connect-src \'none\'; form-action \'none\''));
        assert(resources.policies[0].includes('script-src \'sha256-'));
        assert.equal(resources.handlers, 0); assert.equal(resources.unsafeLink, false); assert.equal(resources.opaque, true);
        assert.equal(resources.untrustedInlineRan, false);
        assert.equal(await resourceFrame.evaluate(async () => {
            try { await fetch('https://results-fixture.invalid/connect'); return true; } catch { return false; }
        }), false, 'connect-src blocks requests in both resource settings');
        assert.equal(resources.imageWidth > 0, allowExternalResources, 'The external image follows the setting');
        assert.equal(resources.color === 'rgb(12, 34, 56)', allowExternalResources, 'The linked stylesheet follows the setting');
        assert.equal(resources.imported === 'rgb(65, 43, 21)', allowExternalResources, 'The imported stylesheet follows the setting');
        assert.deepEqual(requests.sort(), allowExternalResources ? [
            'https://results-fixture.invalid/image.png', 'https://results-fixture.invalid/import.css', 'https://results-fixture.invalid/style.css'
        ] : [], 'Disabled external resources must not reach the network');
        await externalPage.close();
    }
    console.log('RESULTS_RICH_CONTENT_TEST=passed');
} finally {
    if (browser) await browser.close();
    await rm(root, { recursive: true, force: true });
}
