import type { ResultsAssertionResult } from './results-assertions';

export interface RenderedResultsFigures {
    html: string;
    assertions: ResultsAssertionResult[];
}

/** Data the application cannot draw; the message names the broken rule so the regeneration can fix exactly that. */
class FigureDataError extends Error { }
const fail = (reason: string): never => { throw new FigureDataError(reason); };

const text = (element: Element): string => (element.textContent ?? '').replace(/\s+/g, ' ').trim();
const escape = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const children = (element: Element, selector: string): Element[] =>
    Array.from(element.children).filter(child => child.matches(selector));
const length = (value: string): number => [...value].length;
const short = (value: string): boolean => value.length > 0 && length(value) <= 24;
/** Alt text describes the image rather than labelling an item, so it gets a longer limit. */
const altText = (value: string): boolean => value.trim().length > 0 && length(value) <= 80;
const INTERROGATIVE_START = /^(?:何|なぜ|どう|どの|どこ|いつ|誰)/;
const quote = (value: string): string => `「${length(value) > 40 ? `${[...value].slice(0, 40).join('')}…` : value}」`;
const tooLong = (what: string, value: string): string =>
    value ? `${what}は24字以内の短い句にしてください(現在${length(value)}字):${quote(value)}` : `${what}が空です。`;
const onlyAllowed = (figure: Element, allowed: string, names: string): void => {
    const extra = children(figure, `:not(${allowed})`)[0];
    if (extra) { fail(`<${extra.tagName.toLowerCase()}>は置けません。${names}だけを置いてください。`); }
};
const plainItem = (element: Element, where: string): string => {
    const value = text(element);
    if (element.children.length) { fail(`${where}の中に要素を入れず、文字だけにしてください:${quote(value)}`); }
    return value;
};
/** Why a caption or an option description is not one declarative sentence; undefined when it is. */
function sentenceProblem(value: string, max: number): string | undefined {
    const ends = (value.match(/[。！？!?]/g) ?? []).length;
    return !value ? '空です。1文で書いてください。'
        : length(value) > max ? `${max}字以内の1文にしてください(現在${length(value)}字):${quote(value)}`
        : INTERROGATIVE_START.test(value) ? `疑問詞で始めず、対象を主語にして述べてください:${quote(value)}`
        : ends > 1 ? `${ends}文あります。伝えることを1文にまとめてください:${quote(value)}`
        : ends === 0 || !/[。！？!?]$/.test(value) ? `句点(。)で終わる1文にしてください:${quote(value)}`
        : undefined;
}
const badge = (label: string): string => `<span class="poiesis-figure__badge">${label}</span>`;
const item = (value: string, label = ''): string =>
    `<span class="poiesis-figure__item">${escape(value)}${label ? badge(label) : ''}</span>`;
const fallbackItem = (node: Element): string => {
    const copy = node.cloneNode(true) as Element;
    copy.querySelectorAll('ul, ol').forEach(child => child.remove());
    const route = [node.getAttribute('data-from'), node.getAttribute('data-to')].filter(Boolean).join(' → ');
    return [node.getAttribute('data-option'), route, text(copy)].filter(Boolean).join('：');
};

function renderFlow(figure: Element): string {
    const columns = children(figure, 'ol');
    if (columns.length < 1 || columns.length > 2) { fail(`<ol>は1〜2列にしてください(現在${columns.length}列)。`); }
    onlyAllowed(figure, 'ol, figcaption', '<ol>と<figcaption>');
    let changed = 0;
    const rendered = columns.map((column, index) => {
        const where = columns.length === 2 ? `${index + 1}列目の<ol>` : '<ol>';
        const rows = children(column, 'li');
        const label = column.getAttribute('data-label') ?? '';
        if (rows.length < 2 || rows.length > 6) { fail(`${where}は2〜6項目にしてください(現在${rows.length}項目)。`); }
        onlyAllowed(column, 'li', `${where}の中には<li>`);
        if (columns.length === 2 && !label) { fail('2列のときは両方の<ol>にdata-labelを付けてください。'); }
        if (label && !short(label)) { fail(tooLong('data-label', label)); }
        const entries = rows.map(row => {
            const value = plainItem(row, '項目');
            if (!short(value)) { fail(tooLong('項目', value)); }
            const isChanged = row.hasAttribute('data-changed');
            if (isChanged) { changed++; }
            return `<li>${item(value, isChanged ? '変更' : '')}</li>`;
        });
        return `<div class="poiesis-figure__column">${label ? `<div class="poiesis-figure__label">${escape(label)}</div>` : ''}<ol class="poiesis-figure__flow">${entries.join('')}</ol></div>`;
    });
    if (changed === 0 || changed > 3) { fail(`変わった項目にdata-changedを1〜3件付けてください(現在${changed}件)。`); }
    return `<div class="poiesis-figure__columns">${rendered.join('')}</div>`;
}

function renderStates(figure: Element): string {
    const list = children(figure, 'ul');
    if (list.length !== 1) { fail(`<ul>を1つだけ置いてください(現在${list.length}個)。`); }
    onlyAllowed(figure, 'ul, figcaption', '<ul>と<figcaption>');
    const rows = children(list[0], 'li');
    if (rows.length < 1 || rows.length > 8) { fail(`項目は1〜8件にしてください(現在${rows.length}件)。`); }
    onlyAllowed(list[0], 'li', '<ul>の中には<li>');
    let changed = 0;
    const rendered = rows.map(row => {
        const from = row.getAttribute('data-from') ?? '';
        const to = row.getAttribute('data-to') ?? '';
        const condition = plainItem(row, '項目');
        if (!from || !to) { fail(`各<li>にdata-fromとdata-toを付けてください:${quote(condition || from || to)}`); }
        if (!short(from)) { fail(tooLong('data-from', from)); }
        if (!short(to)) { fail(tooLong('data-to', to)); }
        if (length(condition) > 24) { fail(tooLong('移る条件', condition)); }
        const isChanged = row.hasAttribute('data-changed');
        if (isChanged) { changed++; }
        return `<li class="poiesis-figure__transition"><div class="poiesis-figure__state-line">${item(from)}<span class="poiesis-figure__arrow" aria-hidden="true">→</span>${item(to, isChanged ? '変更' : '')}</div>${condition ? `<span class="poiesis-figure__condition">${escape(condition)}</span>` : ''}</li>`;
    });
    if (changed > 3) { fail(`data-changedは3件までにしてください(現在${changed}件)。`); }
    return `<ul class="poiesis-figure__states">${rendered.join('')}</ul>`;
}

function renderTree(figure: Element): string {
    const roots = children(figure, 'ul');
    if (roots.length !== 1) { fail(`<ul>を1つだけ置いてください(現在${roots.length}個)。`); }
    onlyAllowed(figure, 'ul, figcaption', '<ul>と<figcaption>');
    let count = 0;
    let changed = 0;
    const renderList = (list: Element, depth: number): string => {
        if (depth > 3) { fail('入れ子は3段までにしてください。'); }
        onlyAllowed(list, 'li', '<ul>の中には<li>');
        const nodes = children(list, 'li');
        if (!nodes.length) { fail('空の<ul>があります。'); }
        const rendered = nodes.map(node => {
            count++;
            const value = Array.from(node.childNodes).filter(part => part.nodeType === 3)
                .map(part => part.textContent ?? '').join('').replace(/\s+/g, ' ').trim();
            const nested = children(node, 'ul');
            const change = node.getAttribute('data-change');
            if (!short(value)) { fail(tooLong('項目', value)); }
            if (nested.length > 1) { fail(`1つの項目に置ける<ul>は1つだけです:${quote(value)}`); }
            onlyAllowed(node, 'ul', `項目${quote(value)}の中には文字と<ul>`);
            if (change && !['added', 'removed', 'changed'].includes(change)) {
                fail(`data-changeはadded・removed・changedのどれかにしてください(現在${quote(change)})。`);
            }
            if (change) { changed++; }
            const branch = nested.length ? renderList(nested[0], depth + 1) : '';
            const label = change === 'added' ? '追加' : change === 'removed' ? '削除' : change === 'changed' ? '変更' : '';
            return `<li>${item(value, label)}${branch}</li>`;
        });
        return `<ul class="poiesis-figure__tree">${rendered.join('')}</ul>`;
    };
    const html = renderList(roots[0], 1);
    if (count > 12) { fail(`項目は合計12件までにしてください(現在${count}件)。`); }
    if (changed === 0) { fail('added・removed・changedのdata-changeを1件以上付けてください。'); }
    return html;
}

function renderCompare(figure: Element): string {
    const columns = children(figure, 'div');
    if (columns.length !== 2) { fail(`data-labelを付けた<div>をちょうど2つ置いてください(現在${columns.length}個)。`); }
    onlyAllowed(figure, 'div, figcaption', '<div>と<figcaption>');
    const rendered = columns.map((column, index) => {
        const where = `${index + 1}つ目の<div>`;
        const label = column.getAttribute('data-label') ?? '';
        if (!label) { fail(`${where}にdata-labelを付けてください。`); }
        if (!short(label)) { fail(tooLong('data-label', label)); }
        const images = children(column, 'img');
        const lines = (column.textContent ?? '').trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        const value = lines.join('\n');
        if (images.length > 1) { fail(`${where}の画像は1枚にしてください(現在${images.length}枚)。`); }
        onlyAllowed(column, 'img', `${where}の中には画像1枚か短い文字`);
        if (images.length) {
            // The media step resolves either attribute, so keep whichever the AI used.
            const source = images[0].getAttribute('data-poiesis-image') ? 'data-poiesis-image' : 'src';
            const path = images[0].getAttribute(source) ?? '';
            const alt = images[0].getAttribute('alt') ?? '';
            if (value) { fail(`${where}に画像と文字を一緒に置かないでください。画像の説明はaltに書いてください。`); }
            if (!path) { fail(`${where}の画像にsrcで入力にある画像のパスを指定してください。`); }
            if (!altText(alt)) {
                fail(alt.trim() ? `画像のaltは80字以内にしてください(現在${length(alt)}字)。` : `${where}の画像にaltで内容の説明を付けてください。`);
            }
            return `<div class="poiesis-figure__column"><div class="poiesis-figure__label">${escape(label)}</div><img ${source}="${escape(path)}" alt="${escape(alt)}"></div>`;
        }
        if (lines.length < 1 || lines.length > 3) { fail(`${where}の文字は1〜3行にしてください(現在${lines.length}行)。`); }
        const long = lines.find(line => !short(line));
        if (long) { fail(tooLong('比べる値', long)); }
        return `<div class="poiesis-figure__column"><div class="poiesis-figure__label">${escape(label)}</div><span class="poiesis-figure__value">${escape(value)}</span></div>`;
    });
    return `<div class="poiesis-figure__columns poiesis-figure__compare">${rendered.join('')}</div>`;
}

/** Option descriptions are prose, so a style problem is reported without discarding a card the app can draw. */
function renderDecision(section: Element, styleProblems: string[]): string {
    const headings = children(section, 'h3');
    const lists = children(section, 'ul');
    if (headings.length !== 1) { fail(`<h3>を1つだけ置いてください(現在${headings.length}個)。`); }
    if (lists.length !== 1) { fail(`<ul>を1つだけ置いてください(現在${lists.length}個)。`); }
    onlyAllowed(section, 'h3, ul', '<h3>と<ul>');
    const subject = text(headings[0]);
    if (!short(subject)) { fail(tooLong('<h3>の決める対象', subject)); }
    onlyAllowed(lists[0], 'li', '<ul>の中には<li>');
    const choices = children(lists[0], 'li');
    if (choices.length < 2 || choices.length > 4) { fail(`選択肢は2〜4件にしてください(現在${choices.length}件)。`); }
    let recommended = 0;
    const rendered = choices.map(choice => {
        const option = choice.getAttribute('data-option') ?? '';
        if (!option) { fail('すべての<li>にdata-optionで選択肢の短い句を付けてください。'); }
        if (!short(option)) { fail(tooLong('data-option', option)); }
        const description = plainItem(choice, `選択肢${quote(option)}`);
        const problem = sentenceProblem(description, 120);
        if (problem) { styleProblems.push(`選択肢${quote(option)}の説明: ${problem}`); }
        if (choice.hasAttribute('data-recommended')) { recommended++; }
        return `<li><strong>${escape(option)}</strong>${choice.hasAttribute('data-recommended') ? badge('推奨') : ''}<p>${escape(description)}</p></li>`;
    });
    if (recommended > 1) { fail(`data-recommendedは1件までにしてください(現在${recommended}件)。`); }
    return `${badge('判断待ち')}<h3>${escape(subject)}</h3><ul>${rendered.join('')}</ul>`;
}

const RENDERERS: Record<string, (figure: Element) => string> = { flow: renderFlow, states: renderStates, tree: renderTree, compare: renderCompare };
const KIND_NAMES: Record<string, string> = { flow: '流れ', states: '状態の移り変わり', tree: '構成', compare: '対比' };

/**
 * Convert shallow AI data into application-owned markup without retaining AI attributes or nested HTML.
 * Data the app cannot draw falls back to a visible plain list; a caption or description that only breaks the
 * writing rules is still drawn, and both cases record a failed check that names the exact rule for the retry.
 */
export function renderResultsFigures(html: string): RenderedResultsFigures {
    if (!/\sdata-poiesis-(?:figure|decision)(?=[\s=>/])/i.test(html)) {
        return { html, assertions: [] };
    }
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const assertions: ResultsAssertionResult[] = [];
    // Plain <figure> elements (for example a captioned image) are ordinary HTML and stay untouched.
    const nodes = Array.from(doc.querySelectorAll('figure[data-poiesis-figure], section[data-poiesis-decision]'));
    if (!nodes.length) {
        return { html, assertions: [] };
    }
    let figureOrdinal = 0;
    let decisionOrdinal = 0;
    for (const node of nodes) {
        const isDecision = node.matches('section');
        const kind = node.getAttribute('data-poiesis-figure') ?? '';
        const name = isDecision ? `${++decisionOrdinal}枚目の判断待ちのカード`
            : `${++figureOrdinal}枚目の図(${KIND_NAMES[kind] ?? '種類が不明'})`;
        const captions = children(node, 'figcaption');
        const caption = captions.map(text).filter(Boolean).join(' ');
        const styleProblems: string[] = [];
        let body: string | undefined;
        let reason = '';
        try {
            if (isDecision) {
                body = renderDecision(node, styleProblems);
            } else {
                const render = RENDERERS[kind] ?? fail(`data-poiesis-figureはflow・states・tree・compareのどれかにしてください(現在${quote(kind)})。`);
                if (figureOrdinal > 4) { fail('図は4枚までです。'); }
                body = render(node);
                const problem = captions.length > 1 ? `<figcaption>は1つにしてください(現在${captions.length}個)。`
                    : !caption ? '<figcaption>がありません。図が示す結果を1文で書いてください。'
                    : sentenceProblem(caption, 60);
                if (problem) { styleProblems.push(`キャプション: ${problem}`); }
            }
        } catch (error) {
            if (!(error instanceof FigureDataError)) { throw error; }
            reason = error.message;
        }
        const replacement = doc.createElement(isDecision ? 'section' : 'figure');
        replacement.className = isDecision ? 'poiesis-decision' : 'poiesis-figure';
        replacement.setAttribute(body !== undefined
            ? isDecision ? 'data-poiesis-decision-rendered' : 'data-poiesis-figure-rendered'
            : isDecision ? 'data-poiesis-decision-error' : 'data-poiesis-figure-error', kind || 'decision');
        const figcaption = caption ? `<figcaption>${escape(caption)}</figcaption>` : '';
        if (body !== undefined) {
            replacement.innerHTML = body + (isDecision ? '' : figcaption);
        } else {
            const safe = node.cloneNode(true) as Element;
            safe.querySelectorAll('script, style, svg, figcaption').forEach(child => child.remove());
            const values = Array.from(safe.querySelectorAll('li')).map(fallbackItem).filter(Boolean);
            if (!values.length) {
                values.push(...children(safe, 'div').map(column => [column.getAttribute('data-label'),
                    text(column) || column.querySelector('img')?.getAttribute('alt')].filter(Boolean).join('：')).filter(Boolean));
            }
            if (!values.length) { values.push(text(safe) || '図の内容を読み取れませんでした'); }
            replacement.innerHTML = `<p class="poiesis-figure__error">図を表示できませんでした</p><ul>${values.map(value => `<li>${escape(value)}</li>`).join('')}</ul>${isDecision ? '' : figcaption}`;
        }
        node.replaceWith(replacement);
        assertions.push(body === undefined
            ? { source: 'app', text: isDecision ? '判断待ちのカードが表示できる' : '図の部品が表示できる', status: 'fail',
                evidence: `${name}を描けませんでした。${reason}` }
            : styleProblems.length
                ? { source: 'app', text: isDecision ? '判断待ちの選択肢の説明が1文になっている' : '図のキャプションが1文で結果を述べる', status: 'fail',
                    evidence: `${name}は表示しましたが、次を直してください。${styleProblems.join(' ')}` }
                : { source: 'app', text: isDecision ? '判断待ちのカードが表示できる' : '図の部品が表示できる', status: 'pass',
                    evidence: '図の書式を確認しました。' });
    }
    const figureCount = nodes.filter(node => node.matches('figure')).length;
    if (figureCount > 4) {
        assertions.push({ source: 'app', text: '図は4枚以内に収まる', status: 'fail',
            evidence: `図は1〜4枚にしてください。現在${figureCount}枚です。` });
    }
    return { html: '<!doctype html>\n' + doc.documentElement.outerHTML, assertions };
}
