import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

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
    await page.evaluate(({ code, constants }) => {
        window.rich = {};
        new Function('require', 'exports', code)(name => name.includes('dompurify') ? window.DOMPurify : constants, window.rich);
    }, { code, constants });
    const result = await page.evaluate(async images => {
        const unsafe = '<html><body><h2>図</h2><svg viewBox="0 0 100 40"><script>alert(1)</script><foreignObject><p>bad</p></foreignObject><use href="https://bad/x.svg#x"/><rect onclick="bad()" width="40" height="20"/><animate attributeName="href" values="https://bad"/></svg><img src="shot.png"><img src="missing.png"><details><summary>確認の詳細</summary><pre>exit 0</pre></details></body></html>';
        const resolver = async () => ({ images, diagnostics: ['missing image'] });
        const prepared = await window.rich.prepareResultsContent(unsafe, 'file:///workspace', resolver);
        const dom = new DOMParser().parseFromString(prepared.html, 'text/html');
        const safe = window.rich.sanitizeResultsHtml('<svg><defs><marker id="arrow"><path d="M0 0 L4 2"/></marker></defs><path marker-end="url(#arrow)"/><use href="#arrow"/><use href="&#104;ttps://bad"/><rect style="fill:url(https://bad)"/></svg>');
        const bad = await window.rich.prepareResultsContent('<img src="broken.png">', '', async () => ({ images: [{ path: 'broken.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }], diagnostics: [] }));
        const noMedia = await window.rich.prepareResultsContent('<h2>要点</h2>', '', async () => { throw Error('must not fetch'); });
        const safeDiagram = await window.rich.prepareResultsContent('<svg viewBox="0 0 100 40"><rect width="90" height="30" fill="var(--results-bg)"/><text x="10" y="20">確認</text></svg>', '', resolver);
        const svgImage = await window.rich.prepareResultsContent('<img data-poiesis-image="vector.svg">', '', resolver);
        const theme = window.rich.RESULTS_RICH_STYLE;
        return { sanitized: !dom.querySelector('script, foreignObject, animate, [onclick], [href^="https"]'),
            imageCount: dom.querySelectorAll('img').length, data: dom.querySelector('img')?.src.startsWith('data:image/png'),
            details: Boolean(dom.querySelector('details > summary')), statuses: prepared.assertions.map(a => a.status),
            safe, broken: bad.assertions[0].status, emptyAssertions: noMedia.assertions.length,
            safeDiagram: safeDiagram.assertions[0].status,
            svgImage: svgImage.images.size, style: ['summary::before', 'summary:focus-visible', 'content-visibility', '@media print', '--results-fg', 'data-theme="dark"'].every(text => theme.includes(text)) };
    }, valid.images);
    assert.equal(result.sanitized, true); assert.equal(result.imageCount, 1); assert.equal(result.data, true);
    assert.equal(result.details, true); assert.deepEqual(result.statuses, ['fail', 'fail']);
    assert.ok(result.safe.includes('href="#arrow"')); assert.ok(result.safe.includes('url(#arrow)')); assert.ok(!result.safe.includes('https'));
    assert.equal(result.broken, 'fail'); assert.equal(result.emptyAssertions, 0); assert.equal(result.svgImage, 1); assert.equal(result.style, true);
    assert.equal(result.safeDiagram, 'pass');
    const prompt = await readFile('agent-window/src/node/results-generation-server.ts', 'utf8');
    for (const marker of ['2〜4文', '12ノード以下', '変更前', '変更後', '創作しない', '<details><summary>', 'evidence[].image', 'data-poiesis-image']) assert.ok(prompt.includes(marker), marker);
    console.log('RESULTS_RICH_CONTENT_TEST: path confinement, signatures, budgets, decode, sanitizer, details, prompt passed');
} finally {
    await browser?.close();
    await rm(root, { recursive: true, force: true });
}
