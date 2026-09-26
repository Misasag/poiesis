import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const executablePath = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(path => path && existsSync(path));
assert(executablePath, 'Chrome or Edge is required for DOM rendering tests.');
const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
try {
    const page = await browser.newPage();
    const code = await readFile('agent-window/lib/browser/results-figures.js', 'utf8');
    const results = await page.evaluate(source => {
        const exports = {};
        new Function('exports', source)(exports);
        const render = html => exports.renderResultsFigures(`<html><body>${html}</body></html>`);
        const caption = '<figcaption>表示を更新しました。</figcaption>';
        const samples = [
            `<figure data-poiesis-figure="flow"><ol data-label="前"><li>開始</li><li>終了</li></ol><ol data-label="後"><li>開始</li><li data-changed>通知</li></ol>${caption}</figure>`,
            `<figure data-poiesis-figure="states"><ul><li data-from="作業中" data-to="休憩中" data-changed>25分たったとき</li></ul>${caption}</figure>`,
            `<figure data-poiesis-figure="tree"><ul><li>画面<ul><li data-change="added">表示</li></ul></li></ul>${caption}</figure>`,
            `<figure data-poiesis-figure="compare"><div data-label="前"><img src="before.png" alt="前の表示"></div><div data-label="後"><img src="after.png" alt="後の表示"></div>${caption}</figure>`,
            '<section data-poiesis-decision><h3>開始ボタンの文字</h3><ul><li data-option="今の太さ" data-recommended>読みやすくなります。</li><li data-option="細くする">再調整が要ります。</li></ul></section>'
        ];
        const invalid = [
            `<figure data-poiesis-figure="flow"><ol><li>開始</li><li>${'長'.repeat(25)}</li></ol>${caption}</figure>`,
            `<figure data-poiesis-figure="states"><ul><li data-from="作業中">終了</li></ul>${caption}</figure>`,
            `<figure data-poiesis-figure="unknown"><ul><li>項目</li></ul>${caption}</figure>`,
            '<section data-poiesis-decision><h3>選択</h3><ul><li data-option="一つ">一文です。</li></ul></section>',
            `<figure data-poiesis-figure="flow"><script>bad()</script><ol><li>開始</li><li>終了</li></ol>${caption}</figure>`,
            Array.from({ length: 5 }, () => samplesFlow()).join(''),
            `<figure data-poiesis-figure="flow"><ol><li>開始</li><li>終了</li></ol><figcaption>回数を数えます。</figcaption></figure>`
        ];
        function samplesFlow() { return `<figure data-poiesis-figure="flow"><ol><li>開始</li><li data-changed>終了</li></ol>${caption}</figure>`; }
        // Drawable data whose caption or option description only breaks the writing rules: drawn, and the check fails.
        // The compare and flow cases are the shapes a real Results AI returned (two sentences, a caption without 。).
        const styleOnly = [
            '<figure data-poiesis-figure="tree"><ul><li data-change="added">表示</li></ul></figure>',
            `<figure data-poiesis-figure="compare"><div data-label="変更前"><img src="shots/before.png" alt="回数の表示がないタイマー画面"></div><div data-label="変更後"><img src="shots/after.png" alt="今日の作業回数が大きく出たタイマー画面"></div><figcaption>同じ条件で撮影した変更前後です。タイマーの下に回数の表示が増えました。</figcaption></figure>`,
            `<figure data-poiesis-figure="flow"><ol data-label="変更前"><li>25分の作業完了</li><li>履歴に保存</li></ol><ol data-label="変更後"><li>25分の作業完了</li><li>履歴に保存</li><li data-changed>今日の分を数えて表示</li></ol><figcaption>作業完了から回数表示までの流れ</figcaption></figure>`,
            '<section data-poiesis-decision><h3>回数の大きさ</h3><ul><li data-option="このまま" data-recommended>今の大きさを使います。変更はありません。</li><li data-option="大きくする">数字が目立ちます。</li></ul></section>'
        ];
        const polluted = render(`<figure data-poiesis-figure="flow" class="evil" style="color:red" onclick="bad()"><ol><li class="evil" style="color:red" onmouseover="bad()">開始</li><li data-changed>終了</li></ol>${caption}</figure>`);
        const pollutedAll = samples.map(sample => render(sample
            .replace(/<(figure|section)\b/, '<$1 class="evil" style="color:red" onclick="bad()"')
            .replace(/<(ol|ul|li|div|img|h3)\b/, '<$1 class="evil" style="color:red" onmouseover="bad()"')));
        const plainHtml = '<figure><img src="shot.png" alt="画面"><figcaption>画面です。</figcaption></figure>';
        const plain = render(plainHtml);
        const captions = ['この画面で回数を数えます。', 'いくつかの表示を足しました。', 'つねに残るようにしました。', 'なぜ変えたかを示します。', 'どう動くかを示します。']
            .map(text => render(`<figure data-poiesis-figure="tree"><ul><li data-change="added">表示</li></ul><figcaption>${text}</figcaption></figure>`).assertions[0].status);
        const dataImage = render(`<figure data-poiesis-figure="compare"><div data-label="前"><img data-poiesis-image="before.png" alt="前の表示"></div><div data-label="後"><img data-poiesis-image="after.png" alt="${'説明'.repeat(30)}"></div>${caption}</figure>`);
        return { valid: samples.map(render), invalid: invalid.map(render), styleOnly: styleOnly.map(render), polluted, pollutedAll, plain, plainHtml, captions, dataImage };
    }, code);
    for (const [index, result] of results.valid.entries()) {
        assert(result.assertions.every(assertion => assertion.status === 'pass'), `valid sample ${index}`);
        assert(result.html.includes(index === 4 ? 'poiesis-decision' : 'poiesis-figure'), `rendered sample ${index}`);
    }
    assert(results.valid[3].html.includes('src="before.png"'), 'Compare image path must remain resolvable.');
    assert(results.valid[0].html.includes('変更') && results.valid[2].html.includes('追加'));
    assert(results.valid[4].html.includes('判断待ち') && results.valid[4].html.includes('推奨'));
    for (const [index, result] of results.invalid.entries()) {
        assert(result.assertions.some(assertion => assertion.status === 'fail'), `invalid sample ${index}`);
        assert(result.html.includes('図を表示できませんでした') && result.html.includes('<ul>'), `fallback ${index}`);
        assert(!result.html.includes('bad()'), 'Script contents must not reach fallback text.');
    }
    const failedEvidence = result => result.assertions.find(assertion => assertion.status === 'fail').evidence;
    // The retry receives the exact rule and the offending text, not a generic checklist.
    assert.match(failedEvidence(results.invalid[0]), /^1枚目の図\(流れ\)を描けませんでした。項目は24字以内の短い句にしてください\(現在25字\)/);
    assert.match(failedEvidence(results.invalid[1]), /data-fromとdata-toを付けてください:「終了」/);
    assert.match(failedEvidence(results.invalid[2]), /種類が不明.*flow・states・tree・compareのどれか.*「unknown」/);
    assert.match(failedEvidence(results.invalid[3]), /^1枚目の判断待ちのカードを描けませんでした。選択肢は2〜4件にしてください\(現在1件\)/);
    assert.match(failedEvidence(results.invalid[4]), /<script>は置けません。<ol>と<figcaption>だけ/);
    assert.match(failedEvidence(results.invalid[5]), /^5枚目の図\(流れ\)を描けませんでした。図は4枚までです。/);
    assert.match(failedEvidence(results.invalid[6]), /data-changedを1〜3件付けてください\(現在0件\)/);
    assert(results.invalid[0].html.includes('<figcaption>表示を更新しました。</figcaption>'), 'A figure that falls back keeps its caption.');
    for (const [index, result] of results.styleOnly.entries()) {
        assert.equal(result.assertions.length, 1, `style sample ${index} records one check`);
        assert.equal(result.assertions[0].status, 'fail', `style sample ${index} fails its check`);
        assert(!result.html.includes('図を表示できませんでした'), `style sample ${index} is still drawn`);
        assert(/data-poiesis-(?:figure|decision)-rendered/.test(result.html), `style sample ${index} counts as a drawn part`);
    }
    assert.equal(results.styleOnly[0].assertions[0].text, '図のキャプションが1文で結果を述べる');
    assert.match(results.styleOnly[0].assertions[0].evidence, /<figcaption>がありません/);
    assert(results.styleOnly[1].html.includes('src="shots/before.png"') && results.styleOnly[1].html.includes('src="shots/after.png"'),
        'A caption problem must not drop the before and after images.');
    assert.match(results.styleOnly[1].assertions[0].evidence, /^1枚目の図\(対比\)は表示しましたが、次を直してください。キャプション: 2文あります。/);
    assert.match(results.styleOnly[2].assertions[0].evidence, /句点\(。\)で終わる1文にしてください:「作業完了から回数表示までの流れ」/);
    assert(results.styleOnly[2].html.includes('<figcaption>作業完了から回数表示までの流れ</figcaption>'));
    assert.equal(results.styleOnly[3].assertions[0].text, '判断待ちの選択肢の説明が1文になっている');
    assert.match(results.styleOnly[3].assertions[0].evidence, /選択肢「このまま」の説明: 2文あります。/);
    assert(results.polluted.assertions.every(assertion => assertion.status === 'pass'));
    assert(!/evil|onclick|onmouseover|color:red/.test(results.polluted.html), 'AI attributes must be removed.');
    for (const [index, result] of results.pollutedAll.entries()) {
        assert(result.assertions.every(assertion => assertion.status === 'pass'), `polluted sample ${index}`);
        assert(!/evil|onclick|onmouseover|color:red/.test(result.html), `AI attributes in sample ${index}`);
    }
    assert.equal(results.plain.assertions.length, 0, 'A plain figure is ordinary HTML and records no figure check.');
    assert(results.plain.html.includes('src="shot.png"') && results.plain.html.includes('画面です。')
        && !results.plain.html.includes('図を表示できませんでした'), 'A plain captioned image must stay untouched.');
    assert.deepEqual(results.captions, ['pass', 'pass', 'pass', 'fail', 'fail'],
        'Only captions that start with an interrogative word fail; words that merely share a first character pass.');
    assert(results.dataImage.assertions.every(assertion => assertion.status === 'pass'), 'Compare accepts data-poiesis-image and a descriptive alt.');
    assert(results.dataImage.html.includes('data-poiesis-image="before.png"'), 'Compare keeps the image attribute the media step resolves.');
    const styleSource = await readFile('agent-window/src/browser/results-rich-content.ts', 'utf8');
    const style = styleSource.match(/export const RESULTS_RICH_STYLE = `([\s\S]*?)`;/)?.[1];
    assert(style, 'Application figure style must exist.');
    await page.setViewport({ width: 480, height: 700 });
    await page.setContent(results.valid[0].html.replace('</head>', `<style>${style}</style></head>`));
    const light = await page.evaluate(() => ({ width: document.documentElement.scrollWidth,
        foreground: getComputedStyle(document.body).color, background: getComputedStyle(document.body).backgroundColor,
        columns: getComputedStyle(document.querySelector('.poiesis-figure__columns')).gridTemplateColumns }));
    assert(light.width <= 480, 'Figure must fit a 480px Results frame.');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    const dark = await page.evaluate(() => ({ foreground: getComputedStyle(document.body).color,
        background: getComputedStyle(document.body).backgroundColor }));
    assert.notEqual(dark.foreground, dark.background, 'Dark foreground and background must differ.');
    assert.notEqual(light.foreground, dark.foreground, 'Theme foreground must change.');
    console.log('RESULTS_FIGURES_TEST=passed');
} finally {
    await browser.close();
}
