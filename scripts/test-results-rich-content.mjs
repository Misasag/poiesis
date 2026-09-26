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
    const detailsLayout = await page.evaluate(() => {
        document.documentElement.dataset.theme = 'dark';
        const base = document.createElement('style');
        base.textContent = `${window.rich.RESULTS_RICH_STYLE}\n* { box-sizing: border-box; } table, pre { max-width: 100%; overflow-x: auto; }`;
        document.head.append(base);
        document.body.innerHTML = '<details open><summary>確認</summary><pre>長いコードの表示</pre><table><tbody><tr><td>表の内容</td></tr></tbody></table></details>';
        const details = document.querySelector('details');
        const summary = details.querySelector('summary');
        const read = () => {
            const frame = details.getBoundingClientRect();
            const children = [...details.querySelectorAll('pre, table')].map(node => node.getBoundingClientRect());
            const detailStyle = getComputedStyle(details);
            const summaryStyle = getComputedStyle(summary);
            return {
                paddingLeft: detailStyle.paddingLeft, paddingRight: detailStyle.paddingRight,
                borderTop: detailStyle.borderTopWidth, borderRadius: detailStyle.borderTopLeftRadius,
                marginTop: detailStyle.marginTop, marginBottom: detailStyle.marginBottom,
                summaryWeight: summaryStyle.fontWeight, summaryMargin: summaryStyle.marginBottom,
                marker: getComputedStyle(summary, '::before').content,
                childrenInside: children.every(child => child.left >= frame.left + 16 && child.right <= frame.right - 16)
            };
        };
        const baseline = read();
        const generated = document.createElement('style');
        generated.textContent = 'details { border-top: 1px solid red; border-radius: 0; margin: 0; padding: 12px 0; } details > summary { font-weight: 400; margin-bottom: 0; } details > summary::before { content: ""; }';
        document.head.append(generated);
        const withGeneratedStyle = read();
        const scrollbar = getComputedStyle(document.body, '::-webkit-scrollbar');
        const thumb = getComputedStyle(document.body, '::-webkit-scrollbar-thumb');
        return { baseline, withGeneratedStyle, scrollbarWidth: scrollbar.width, thumbBorder: thumb.borderLeftWidth,
            trackBackground: getComputedStyle(document.body, '::-webkit-scrollbar-track').backgroundColor,
            thumbColor: thumb.backgroundColor,
            scrollbarColor: getComputedStyle(document.body).scrollbarColor,
            scrollbarWidthMode: getComputedStyle(document.body).scrollbarWidth };
    });
    assert.deepEqual(detailsLayout.withGeneratedStyle, detailsLayout.baseline);
    assert.equal(detailsLayout.baseline.paddingLeft, '16px');
    assert.equal(detailsLayout.baseline.paddingRight, '16px');
    assert.equal(detailsLayout.baseline.borderTop, '1px');
    assert.equal(detailsLayout.baseline.borderRadius, '8px');
    assert.equal(detailsLayout.baseline.marginTop, '16px');
    assert.equal(detailsLayout.baseline.marginBottom, '16px');
    assert.equal(detailsLayout.baseline.summaryWeight, '600');
    assert.equal(detailsLayout.baseline.summaryMargin, '12px');
    assert.equal(detailsLayout.baseline.childrenInside, true);
    // The track must carry the dark page color; a transparent track shows the light host frame.
    assert.equal(detailsLayout.trackBackground, 'rgb(36, 39, 34)');
    assert.equal(detailsLayout.scrollbarWidth, '10px');
    assert.equal(detailsLayout.thumbBorder, '3px');
    assert.notEqual(detailsLayout.thumbColor, 'rgba(0, 0, 0, 0)');
    assert.equal(detailsLayout.scrollbarColor, 'auto');
    assert.equal(detailsLayout.scrollbarWidthMode, 'auto');
    const appPage = await browser.newPage();
    await appPage.setContent('<div id="poiesis-window-host"><div class="poiesis-agent-window__content" style="--poiesis-chrome-text: #efeee9"><div class="scroll-surface" style="width: 100px; height: 100px; overflow: auto"><div style="height: 300px"></div></div></div></div>');
    await appPage.addStyleTag({ content: await readFile('agent-window/src/browser/style/components.css', 'utf8') });
    const appScrollbar = await appPage.evaluate(() => {
        const surface = document.querySelector('.scroll-surface');
        const read = () => ({
            width: getComputedStyle(surface, '::-webkit-scrollbar').width,
            border: getComputedStyle(surface, '::-webkit-scrollbar-thumb').borderLeftWidth,
            color: getComputedStyle(surface, '::-webkit-scrollbar-thumb').backgroundColor,
            standardColor: getComputedStyle(surface).scrollbarColor,
            standardWidth: getComputedStyle(surface).scrollbarWidth
        });
        const dark = read();
        document.documentElement.dataset.poiesisColorMode = 'light';
        document.querySelector('.poiesis-agent-window__content').style.setProperty('--poiesis-chrome-text', '#23241f');
        return { dark, light: read() };
    });
    for (const mode of [appScrollbar.dark, appScrollbar.light]) {
        assert.equal(mode.width, '10px');
        assert.equal(mode.border, '3px');
        assert.notEqual(mode.color, 'rgba(0, 0, 0, 0)');
        assert.equal(mode.standardColor, 'auto');
        assert.equal(mode.standardWidth, 'auto');
    }
    assert.notEqual(appScrollbar.dark.color, appScrollbar.light.color);
    await appPage.close();
    const prompt = await readFile('agent-window/src/node/results-generation-server.ts', 'utf8');
    for (const marker of ['1〜2文', '図の部品', 'data-poiesis-figure', '創作しない', '<details>', 'evidence[].image', 'data-poiesis-image']) assert.ok(prompt.includes(marker), marker);
    const figureStyle = await readFile('agent-window/src/browser/results-rich-content.ts', 'utf8');
    for (const marker of ['.poiesis-figure__columns', '.poiesis-figure__tree', '.poiesis-decision li',
        'var(--results-fg)', 'var(--results-muted)', 'var(--results-border)', 'var(--results-accent)', 'var(--results-bg)',
        '@media (max-width: 560px)']) assert.ok(figureStyle.includes(marker), marker);
    assert.match(figureStyle, /\.poiesis-figure[^\n]*!important/, 'App figure style must override generated CSS.');
    // Flat output (paragraph, figure, bare note, details directly in body) is gathered into one wrapper so every block
    // shares the reading layout's edges; a document that already has one wrapper is left as written.
    const wrapped = await page.evaluate(() => {
        const summarize = html => {
            const doc = new DOMParser().parseFromString(window.rich.wrapFlatResultsBody(html), 'text/html');
            return { children: Array.from(doc.body.children).map(child => child.localName),
                inMain: doc.querySelector('body > main')?.textContent.replace(/\s+/g, ' ').trim() ?? '' };
        };
        return {
            flat: summarize('<html><head><style>p{}</style></head><body><p>冒頭です。</p><figure class="poiesis-figure">図</figure>図の直後の注記です。<details><summary>根拠</summary>記録</details><style>b{}</style></body></html>'),
            single: summarize('<html><body><main><p>冒頭です。</p><p>次です。</p></main></body></html>'),
            bareText: summarize('<html><body>注記だけです。</body></html>'),
            paper: summarize('<html><body><div class="paper"><p>簡易表示</p></div><script>1</script></body></html>')
        };
    });
    assert.deepEqual(wrapped.flat.children, ['main', 'style'], 'Flat blocks move into one main; style stays outside.');
    assert.equal(wrapped.flat.inMain, '冒頭です。図図の直後の注記です。根拠記録', 'Bare text keeps its order inside the wrapper.');
    assert.deepEqual(wrapped.single.children, ['main'], 'A single wrapper is not wrapped again.');
    assert.deepEqual(wrapped.bareText.children, ['main'], 'Bare body text gets the wrapper padding.');
    assert.deepEqual(wrapped.paper.children, ['div', 'script'], 'The bundled template wrapper is left as written.');
    assert.match(figureStyle, /\.poiesis-figure__compare img \{[^}]*height: auto !important; max-height: clamp\(220px, 38vw, 400px\) !important;/,
        'Compare images keep their own aspect ratio up to the height cap, so the frame has no empty bands.');
    assert.match(figureStyle, /\.poiesis-figure__flow > li:not\(:last-child\)::after \{[^}]*left: 14px !important; transform: none !important;/,
        'Flow arrows sit under the left-aligned boxes they connect.');
    console.log('RESULTS_RICH_CONTENT_TEST: path confinement, signatures, budgets, decode, sanitizer, details, prompt passed');
} finally {
    await browser?.close();
    await rm(root, { recursive: true, force: true });
}
