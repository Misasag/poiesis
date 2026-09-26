import DOMPurify = require('@theia/core/shared/dompurify');
import type { ResultsImageResolution } from '../common/results-images';
import { RESULTS_IMAGES_MAX_COUNT, RESULTS_IMAGES_MAX_BYTES } from '../common/results-images';
import type { ResultsAssertionResult } from './results-assertions';

const diagramTags = new Set(['svg', 'g', 'defs', 'marker', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'title', 'desc', 'clippath', 'lineargradient', 'radialgradient', 'stop', 'use']);

/** DOM-based sanitization happens before the application adds its own script bridge. */
export function sanitizeResultsHtml(html: string): string {
    const clean = DOMPurify.sanitize(html, {
        WHOLE_DOCUMENT: true, USE_PROFILES: { html: true, svg: true }, ADD_TAGS: ['use'],
        FORBID_TAGS: ['script', 'foreignObject', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'input', 'textarea', 'select', 'video', 'audio', 'source'],
        FORBID_ATTR: ['srcdoc', 'srcset', 'autofocus', 'formaction', 'action', 'ping']
    });
    const doc = new DOMParser().parseFromString(clean, 'text/html');
    for (const node of Array.from(doc.querySelectorAll('svg, svg *'))) {
        if (!diagramTags.has(node.localName.toLowerCase())) { node.remove(); continue; }
        for (const attribute of Array.from(node.attributes)) {
            const name = attribute.name.toLowerCase();
            const value = attribute.value.trim();
            if ((name === 'href' || name === 'xlink:href') && !/^#[\w.-]+$/.test(value)
                || /[\\@]/.test(value) || /url\s*\(/i.test(value) && !/^url\(#[\w.-]+\)$/.test(value)) {
                node.removeAttribute(attribute.name);
            }
        }
    }
    return '<!doctype html>\n' + doc.documentElement.outerHTML;
}

const LAYOUT_NEUTRAL_TAGS = new Set(['script', 'style', 'template']);

/**
 * The reading layout pads one content wrapper in <body>. Flat output puts paragraphs, figures and details directly
 * in <body>, so each block took the wrapper padding and their left edges disagreed; gather them into one <main>.
 */
export function wrapFlatResultsBody(html: string): string {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const neutral = (node: ChildNode): boolean => node.nodeType === Node.ELEMENT_NODE && LAYOUT_NEUTRAL_TAGS.has((node as Element).localName)
        || node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.TEXT_NODE
        || node.nodeType === Node.TEXT_NODE && !node.textContent?.trim();
    const blocks = Array.from(doc.body.childNodes).filter(node => !neutral(node));
    if (blocks.length === 0 || blocks.length === 1 && blocks[0].nodeType === Node.ELEMENT_NODE) {
        return html;
    }
    const main = doc.createElement('main');
    main.append(...Array.from(doc.body.childNodes).filter(node => !neutral(node) || node.nodeType === Node.TEXT_NODE));
    doc.body.prepend(main);
    return '<!doctype html>\n' + doc.documentElement.outerHTML;
}

export interface PreparedResults {
    html: string;
    images: Map<string, string>;
    diagnostics: string[];
    assertions: ResultsAssertionResult[];
}

export async function prepareResultsContent(
    html: string,
    workspaceUri: string,
    resolveImages: (workspaceUri: string, paths: string[]) => Promise<ResultsImageResolution>,
    evidencePaths: string[] = []
): Promise<PreparedResults> {
    const sanitized = sanitizeResultsHtml(html);
    const doc = new DOMParser().parseFromString(sanitized, 'text/html');
    const nodes = Array.from(doc.querySelectorAll('img'));
    const paths = nodes.map(node => node.getAttribute('data-poiesis-image') ?? node.getAttribute('src') ?? '');
    const diagnostics: string[] = [];
    const images = new Map<string, string>();
    const unique = [...new Set([...paths, ...evidencePaths])];
    let resolved: ResultsImageResolution = { images: [], diagnostics: [] };
    if (unique.length) {
        try { resolved = await resolveImages(workspaceUri, unique); }
        catch { diagnostics.push('画像を読み込めませんでした。'); }
    }
    diagnostics.push(...resolved.diagnostics);
    for (const entry of resolved.images.slice(0, RESULTS_IMAGES_MAX_COUNT)) {
        if (!unique.includes(entry.path)) { continue; }
        let source = entry.dataUrl;
        if (source.startsWith('data:image/svg+xml;base64,')) {
            const text = new TextDecoder().decode(Uint8Array.from(atob(source.split(',')[1]), char => char.charCodeAt(0)));
            const svgDoc = new DOMParser().parseFromString(sanitizeResultsHtml(text), 'text/html');
            const svg = svgDoc.querySelector('svg');
            if (!svg) { diagnostics.push(`画像を省略しました: ${entry.path}`); continue; }
            source = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.outerHTML)}`;
        }
        if (await decodesImage(source)) { images.set(entry.path, source); }
        else { diagnostics.push(`画像を省略しました: ${entry.path}（画像を表示できません）`); }
    }
    let embeddedBytes = 0;
    let renderedImages = 0;
    nodes.forEach((node, index) => {
        const path = paths[index];
        const source = images.get(path);
        const payload = source?.slice(source.indexOf(',') + 1) ?? '';
        const bytes = source?.includes(';base64,') ? atob(payload).length : new TextEncoder().encode(decodeURIComponent(payload)).length;
        if (!source || index >= RESULTS_IMAGES_MAX_COUNT || embeddedBytes + bytes > RESULTS_IMAGES_MAX_BYTES) {
            node.remove();
            diagnostics.push(`本文の画像を省略しました: ${path.slice(0, 160)}`);
            return;
        }
        embeddedBytes += bytes;
        renderedImages++;
        node.setAttribute('src', source);
        node.setAttribute('data-poiesis-image', path);
        node.setAttribute('tabindex', '0');
        node.setAttribute('role', 'button');
        node.setAttribute('aria-label', `${node.getAttribute('alt') || '画像'}を拡大`);
        node.setAttribute('loading', 'lazy');
    });
    const assertions: ResultsAssertionResult[] = [];
    if (nodes.length) {
        assertions.push({ source: 'app', text: '本文の画像をすべて表示できる',
            status: renderedImages === paths.length ? 'pass' : 'fail',
            evidence: `${renderedImages}/${paths.length}件の画像を確認しました。` });
    }
    if (/<svg[\s>]/i.test(html)) {
        // Inspect the original DOM as well: removal must be visible to the retry policy.
        const original = new DOMParser().parseFromString(html, 'text/html');
        const before = Array.from(original.querySelectorAll('svg')).map(svg => svg.outerHTML).join('');
        const after = Array.from(doc.querySelectorAll('svg')).map(svg => svg.outerHTML).join('');
        assertions.push({ source: 'app', text: '図に安全でない内容が含まれない', status: before === after ? 'pass' : 'fail',
            evidence: before === after ? '図の安全性を確認しました。' : '図の安全でない内容を除去しました。' });
        if (before !== after) { diagnostics.push('図の安全でない内容を除去しました。'); }
    }
    return { html: '<!doctype html>\n' + doc.documentElement.outerHTML, images, diagnostics, assertions };
}

function decodesImage(source: string): Promise<boolean> {
    return new Promise(resolve => {
        const image = new Image();
        const finish = (valid: boolean): void => { clearTimeout(timer); image.onload = image.onerror = null; resolve(valid); };
        const timer = setTimeout(() => finish(false), 5000);
        image.onload = () => finish(image.naturalWidth > 0 && image.naturalHeight > 0 && image.naturalWidth * image.naturalHeight <= 40_000_000);
        image.onerror = () => finish(false);
        image.src = source;
    });
}

export const RESULTS_RICH_STYLE = `
:root { --results-bg: #f1efe8; --results-fg: #262721; --results-muted: #61645c; --results-border: #d6d3c9; --results-accent: #386e63; --results-scrollbar-opacity: 22%; --results-scrollbar-hover-opacity: 40%; color-scheme: light; }
:root[data-theme="dark"] { --results-bg: #242722; --results-fg: #eceee8; --results-muted: #b5b9af; --results-border: #50574b; --results-accent: #91cdb9; --results-scrollbar-opacity: 18%; --results-scrollbar-hover-opacity: 35%; color-scheme: dark; }
body { background: var(--results-bg); color: var(--results-fg); }
svg { color: var(--results-fg); height: auto; }
svg text { fill: currentColor; }
img[data-poiesis-image] { cursor: zoom-in; height: auto; border-radius: 8px; }
figcaption { color: var(--results-muted); font-size: .9em; }
.poiesis-figure, .poiesis-decision { display: block !important; min-width: 0 !important; max-width: 100% !important; padding: 14px !important; margin: 16px 0 !important; border: 1px solid var(--results-border) !important; border-radius: 12px !important; background: var(--results-bg) !important; color: var(--results-fg) !important; overflow-wrap: anywhere !important; }
.poiesis-figure *, .poiesis-decision * { box-sizing: border-box !important; font-family: inherit !important; color: inherit !important; }
.poiesis-figure__columns { display: grid !important; grid-template-columns: repeat(2, minmax(0, 1fr)) !important; gap: 12px !important; min-width: 0 !important; }
.poiesis-figure__columns:has(> :only-child) { grid-template-columns: minmax(0, 1fr) !important; }
.poiesis-figure__column { min-width: 0 !important; }
.poiesis-figure__label { display: inline-block !important; margin: 0 0 9px !important; padding: 2px 8px !important; border: 1px solid var(--results-border) !important; border-radius: 999px !important; font-size: 12px !important; color: var(--results-muted) !important; }
.poiesis-figure__flow, .poiesis-figure__states, .poiesis-figure__tree, .poiesis-decision ul { list-style: none !important; margin: 0 !important; padding: 0 !important; }
.poiesis-figure__flow > li { position: relative !important; margin: 0 0 22px !important; padding: 0 !important; list-style: none !important; }
.poiesis-figure__flow > li:not(:last-child)::after { content: '↓' !important; position: absolute !important; inset-block-start: 100% !important; left: 14px !important; transform: none !important; line-height: 22px !important; color: var(--results-muted) !important; }
.poiesis-figure__flow > li:last-child { margin-bottom: 0 !important; }
.poiesis-figure__item { display: inline-flex !important; align-items: center !important; flex-wrap: wrap !important; gap: 5px !important; min-width: 0 !important; max-width: 100% !important; padding: 8px 10px !important; border: 1px solid var(--results-border) !important; border-radius: 9px !important; background: var(--results-bg) !important; overflow-wrap: anywhere !important; }
.poiesis-figure__item:has(.poiesis-figure__badge) { border-color: var(--results-accent) !important; }
.poiesis-figure__badge { display: inline-block !important; padding: 2px 6px !important; border: 1px solid var(--results-accent) !important; border-radius: 5px !important; color: var(--results-accent) !important; font-size: 11px !important; font-weight: 700 !important; line-height: 1.3 !important; white-space: nowrap !important; }
.poiesis-figure__states > li { margin: 0 0 10px !important; padding: 0 !important; }
.poiesis-figure__state-line { display: flex !important; flex-wrap: wrap !important; align-items: center !important; gap: 7px !important; }
.poiesis-figure__arrow { color: var(--results-accent) !important; font-weight: 700 !important; }
.poiesis-figure__condition { display: block !important; margin-left: 10px !important; font-size: 12px !important; color: var(--results-muted) !important; }
.poiesis-figure__tree { border-left: 1px solid var(--results-border) !important; margin-left: 12px !important; padding-left: 12px !important; }
.poiesis-figure__tree > li { position: relative !important; margin: 0 0 8px !important; padding: 0 !important; list-style: none !important; }
.poiesis-figure__tree > li::before { content: '' !important; position: absolute !important; width: 10px !important; left: -12px !important; top: 18px !important; border-top: 1px solid var(--results-border) !important; }
.poiesis-figure__compare img { display: block !important; width: 100% !important; height: auto !important; max-height: clamp(220px, 38vw, 400px) !important; object-fit: contain !important; border-radius: 6px !important; border: 1px solid var(--results-border) !important; background: var(--results-bg) !important; }
.poiesis-figure__value { display: block !important; padding: 12px !important; border: 1px solid var(--results-border) !important; border-radius: 8px !important; white-space: pre-wrap !important; }
.poiesis-figure figcaption { display: block !important; margin-top: 12px !important; font-size: 13px !important; color: var(--results-muted) !important; }
.poiesis-figure__error { margin: 0 0 8px !important; color: var(--results-fg) !important; font-weight: 700 !important; }
.poiesis-figure > ul { margin: 0 !important; padding-left: 20px !important; }
.poiesis-decision h3 { margin: 8px 0 12px !important; color: var(--results-fg) !important; }
.poiesis-decision li { margin: 0 0 10px !important; padding: 10px !important; border: 1px solid var(--results-border) !important; border-radius: 8px !important; list-style: none !important; }
.poiesis-decision li:has(.poiesis-figure__badge) { border-color: var(--results-accent) !important; }
.poiesis-decision li strong { margin-right: 8px !important; }
.poiesis-decision li p { margin: 4px 0 0 !important; color: var(--results-muted) !important; }
@media (max-width: 560px) { .poiesis-figure__columns { grid-template-columns: minmax(0, 1fr) !important; } }
details { border: 1px solid var(--results-border) !important; border-radius: 8px !important; margin-block: 16px !important; padding: 12px 16px !important; break-inside: avoid; }
details > summary { cursor: pointer !important; font-weight: 600 !important; list-style: none !important; margin-bottom: 0 !important; }
details > summary::-webkit-details-marker { display: none !important; }
details > summary::marker { content: '' !important; }
details > summary::before { content: '›' !important; display: inline-block !important; margin-right: 10px !important; transition: transform .12s !important; }
details[open] > summary::before { transform: rotate(90deg) !important; }
details[open] > summary { margin-bottom: 12px !important; }
details > :not(summary) { content-visibility: auto; overflow-wrap: anywhere; }
summary:focus-visible, img:focus-visible { outline: 2px solid var(--results-accent); outline-offset: 4px; }
::-webkit-scrollbar { width: 10px !important; height: 10px !important; }
/* Paint the track with the page color: a transparent track shows the host frame element behind the iframe. */
::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: var(--results-bg) !important; }
::-webkit-scrollbar-button { display: none !important; width: 0 !important; height: 0 !important; }
::-webkit-scrollbar-thumb { border: 3px solid transparent !important; border-radius: 999px !important; background: color-mix(in srgb, var(--results-fg) var(--results-scrollbar-opacity), transparent) padding-box !important; }
::-webkit-scrollbar-thumb:hover { border-width: 2px !important; background: color-mix(in srgb, var(--results-fg) var(--results-scrollbar-hover-opacity), transparent) padding-box !important; }
@media print { details { break-inside: auto; } details::details-content { display: block; content-visibility: visible; } details > :not(summary) { content-visibility: visible; } }
`;
