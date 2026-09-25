import type { ResultsAssertionResult } from './results-assertions';

export interface RenderedResultsFigures {
    html: string;
    assertions: ResultsAssertionResult[];
}

const text = (element: Element): string => (element.textContent ?? '').replace(/\s+/g, ' ').trim();
const escape = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const children = (element: Element, selector: string): Element[] =>
    Array.from(element.children).filter(child => child.matches(selector));
const short = (value: string): boolean => value.length > 0 && [...value].length <= 24;
/** Alt text describes the image rather than labelling an item, so it gets a longer limit. */
const altText = (value: string): boolean => value.trim().length > 0 && [...value].length <= 80;
const INTERROGATIVE_START = /^(?:何|なぜ|どう|どの|どこ|いつ|誰)/;
const sentence = (value: string, max = 60): boolean => value.length > 0 && [...value].length <= max
    && !INTERROGATIVE_START.test(value)
    && (value.match(/[。！？!?]/g) ?? []).length === 1 && /[。！？!?]$/.test(value);
const badge = (label: string): string => `<span class="poiesis-figure__badge">${label}</span>`;
const item = (value: string, label = ''): string =>
    `<span class="poiesis-figure__item">${escape(value)}${label ? badge(label) : ''}</span>`;
const fallbackItem = (node: Element): string => {
    const copy = node.cloneNode(true) as Element;
    copy.querySelectorAll('ul, ol').forEach(child => child.remove());
    const route = [node.getAttribute('data-from'), node.getAttribute('data-to')].filter(Boolean).join(' → ');
    return [node.getAttribute('data-option'), route, text(copy)].filter(Boolean).join('：');
};

function renderFlow(figure: Element): string | undefined {
    const columns = children(figure, 'ol');
    if (columns.length < 1 || columns.length > 2 || children(figure, ':not(ol):not(figcaption)').length) { return undefined; }
    let changed = 0;
    const rendered = columns.map(column => {
        const rows = children(column, 'li');
        const label = column.getAttribute('data-label');
        if (rows.length < 2 || rows.length > 6 || children(column, ':not(li)').length
            || columns.length === 2 && !short(label ?? '') || label && !short(label)) { return undefined; }
        const entries = rows.map(row => {
            if (!short(text(row)) || row.children.length) { return undefined; }
            const isChanged = row.hasAttribute('data-changed');
            if (isChanged) { changed++; }
            return `<li>${item(text(row), isChanged ? '変更' : '')}</li>`;
        });
        if (entries.some(entry => !entry)) { return undefined; }
        return `<div class="poiesis-figure__column">${label ? `<div class="poiesis-figure__label">${escape(label)}</div>` : ''}<ol class="poiesis-figure__flow">${entries.join('')}</ol></div>`;
    });
    return rendered.some(column => !column) || changed > 3 || changed === 0
        ? undefined : `<div class="poiesis-figure__columns">${rendered.join('')}</div>`;
}

function renderStates(figure: Element): string | undefined {
    const list = children(figure, 'ul');
    if (list.length !== 1 || children(figure, ':not(ul):not(figcaption)').length) { return undefined; }
    const rows = children(list[0], 'li');
    if (rows.length < 1 || rows.length > 8 || children(list[0], ':not(li)').length) { return undefined; }
    let changed = 0;
    const rendered = rows.map(row => {
        const from = row.getAttribute('data-from') ?? '';
        const to = row.getAttribute('data-to') ?? '';
        const condition = text(row);
        if (!short(from) || !short(to) || [...condition].length > 24 || row.children.length) { return undefined; }
        const isChanged = row.hasAttribute('data-changed');
        if (isChanged) { changed++; }
        return `<li class="poiesis-figure__transition"><div class="poiesis-figure__state-line">${item(from)}<span class="poiesis-figure__arrow" aria-hidden="true">→</span>${item(to, isChanged ? '変更' : '')}</div>${condition ? `<span class="poiesis-figure__condition">${escape(condition)}</span>` : ''}</li>`;
    });
    return changed > 3 || rendered.some(row => !row) ? undefined
        : `<ul class="poiesis-figure__states">${rendered.join('')}</ul>`;
}

function renderTree(figure: Element): string | undefined {
    const roots = children(figure, 'ul');
    if (roots.length !== 1 || children(figure, ':not(ul):not(figcaption)').length) { return undefined; }
    let count = 0;
    let changed = 0;
    const renderList = (list: Element, depth: number): string | undefined => {
        if (depth > 3 || children(list, ':not(li)').length) { return undefined; }
        const nodes = children(list, 'li');
        if (!nodes.length) { return undefined; }
        const rendered = nodes.map(node => {
            count++;
            const value = Array.from(node.childNodes).filter(part => part.nodeType === 3)
                .map(part => part.textContent ?? '').join('').replace(/\s+/g, ' ').trim();
            const nested = children(node, 'ul');
            const change = node.getAttribute('data-change');
            if (!short(value) || nested.length > 1 || children(node, ':not(ul)').length
                || change && !['added', 'removed', 'changed'].includes(change)) { return undefined; }
            if (change) { changed++; }
            const branch = nested.length ? renderList(nested[0], depth + 1) : '';
            if (branch === undefined) { return undefined; }
            const label = change === 'added' ? '追加' : change === 'removed' ? '削除' : change === 'changed' ? '変更' : '';
            return `<li>${item(value, label)}${branch}</li>`;
        });
        return rendered.some(node => !node) ? undefined : `<ul class="poiesis-figure__tree">${rendered.join('')}</ul>`;
    };
    const html = renderList(roots[0], 1);
    return html && count <= 12 && changed > 0 ? html : undefined;
}

function renderCompare(figure: Element): string | undefined {
    const columns = children(figure, 'div');
    if (columns.length !== 2 || children(figure, ':not(div):not(figcaption)').length) { return undefined; }
    const rendered = columns.map(column => {
        const label = column.getAttribute('data-label') ?? '';
        const images = children(column, 'img');
        const lines = (column.textContent ?? '').trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        const value = lines.join('\n');
        // The media step resolves either attribute, so keep whichever the AI used.
        const source = images[0]?.getAttribute('data-poiesis-image') ? 'data-poiesis-image' : 'src';
        const path = images[0]?.getAttribute(source) ?? '';
        if (!short(label) || images.length > 1 || children(column, ':not(img)').length
            || images.length && (value || !path || !altText(images[0].getAttribute('alt') ?? ''))
            || !images.length && (lines.length < 1 || lines.length > 3 || lines.some(line => !short(line)))) { return undefined; }
        const content = images.length ? `<img ${source}="${escape(path)}" alt="${escape(images[0].getAttribute('alt')!)}">`
            : `<span class="poiesis-figure__value">${escape(value)}</span>`;
        return `<div class="poiesis-figure__column"><div class="poiesis-figure__label">${escape(label)}</div>${content}</div>`;
    });
    return rendered.some(column => !column) ? undefined : `<div class="poiesis-figure__columns poiesis-figure__compare">${rendered.join('')}</div>`;
}

function renderDecision(section: Element): string | undefined {
    const headings = children(section, 'h3');
    const lists = children(section, 'ul');
    if (headings.length !== 1 || lists.length !== 1 || children(section, ':not(h3):not(ul)').length
        || !short(text(headings[0])) || children(lists[0], ':not(li)').length) { return undefined; }
    const choices = children(lists[0], 'li');
    if (choices.length < 2 || choices.length > 4) { return undefined; }
    let recommended = 0;
    const rendered = choices.map(choice => {
        const option = choice.getAttribute('data-option') ?? '';
        const description = text(choice);
        if (!short(option) || !sentence(description, 120) || choice.children.length) { return undefined; }
        if (choice.hasAttribute('data-recommended')) { recommended++; }
        return `<li><strong>${escape(option)}</strong>${choice.hasAttribute('data-recommended') ? badge('推奨') : ''}<p>${escape(description)}</p></li>`;
    });
    return recommended > 1 || rendered.some(choice => !choice) ? undefined
        : `${badge('判断待ち')}<h3>${escape(text(headings[0]))}</h3><ul>${rendered.join('')}</ul>`;
}

/** Convert shallow AI data into application-owned markup without retaining AI attributes or nested HTML. */
export function renderResultsFigures(html: string): RenderedResultsFigures {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const assertions: ResultsAssertionResult[] = [];
    // Plain <figure> elements (for example a captioned image) are ordinary HTML and stay untouched.
    const nodes = Array.from(doc.querySelectorAll('figure[data-poiesis-figure], section[data-poiesis-decision]'));
    if (!nodes.length) {
        return { html, assertions: [] };
    }
    let figureOrdinal = 0;
    for (const node of nodes) {
        const isDecision = node.matches('section');
        if (!isDecision) { figureOrdinal++; }
        const kind = node.getAttribute('data-poiesis-figure') ?? '';
        const captions = children(node, 'figcaption');
        const caption = captions.length === 1 ? text(captions[0]) : '';
        const body = isDecision ? renderDecision(node) : captions.length === 1 && sentence(caption)
            ? ({ flow: renderFlow, states: renderStates, tree: renderTree, compare: renderCompare } as Record<string, (node: Element) => string | undefined>)[kind]?.(node)
            : undefined;
        const valid = Boolean(body) && (isDecision || figureOrdinal <= 4);
        const replacement = doc.createElement(isDecision ? 'section' : 'figure');
        replacement.className = isDecision ? 'poiesis-decision' : 'poiesis-figure';
        replacement.setAttribute(valid
            ? isDecision ? 'data-poiesis-decision-rendered' : 'data-poiesis-figure-rendered'
            : isDecision ? 'data-poiesis-decision-error' : 'data-poiesis-figure-error', kind || 'decision');
        if (valid) {
            replacement.innerHTML = body + (isDecision ? '' : `<figcaption>${escape(caption)}</figcaption>`);
        } else {
            const safe = node.cloneNode(true) as Element;
            safe.querySelectorAll('script, style, svg').forEach(child => child.remove());
            const values = Array.from(safe.querySelectorAll('li')).map(fallbackItem).filter(Boolean);
            if (!values.length) {
                values.push(...children(safe, 'div').map(column => [column.getAttribute('data-label'),
                    text(column) || column.querySelector('img')?.getAttribute('alt')].filter(Boolean).join('：')).filter(Boolean));
            }
            if (!values.length) { values.push(text(safe) || '図の内容を読み取れませんでした'); }
            replacement.innerHTML = `<p class="poiesis-figure__error">図を表示できませんでした</p><ul>${values.map(value => `<li>${escape(value)}</li>`).join('')}</ul>`;
        }
        node.replaceWith(replacement);
        assertions.push({ source: 'app', text: isDecision ? '判断待ちのカードが表示できる' : '図の部品が表示できる',
            status: valid ? 'pass' : 'fail', evidence: valid ? '図の書式を確認しました。'
                : `図の書式を確認してください。${isDecision ? '選択肢は2〜4件、対象と各選択肢を短い句、説明を1文にしてください。' : '種類、項目数、必須属性、24字以内の項目、60字以内で1文のキャプションを確認してください。'}` });
    }
    const figureCount = nodes.filter(node => node.matches('figure')).length;
    if (figureCount > 4) {
        assertions.push({ source: 'app', text: '図は4枚以内に収まる', status: 'fail',
            evidence: `図は1〜4枚にしてください。現在${figureCount}枚です。` });
    }
    return { html: '<!doctype html>\n' + doc.documentElement.outerHTML, assertions };
}
