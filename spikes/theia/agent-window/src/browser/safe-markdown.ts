import DOMPurify = require('@theia/core/shared/dompurify');
import markdownit = require('@theia/core/shared/markdown-it');
import { FileUri } from '@theia/core/lib/common/file-uri';
import URI from '@theia/core/lib/common/uri';

export const POIESIS_FILE_LINK_ATTRIBUTE = 'data-poiesis-file-uri';
export const POIESIS_EXTERNAL_LINK_ATTRIBUTE = 'data-poiesis-external-uri';

const markdown = markdownit({
    breaks: true,
    html: false,
    linkify: false,
    typographer: false
});

const bareFilePathPattern = /(?<![A-Za-z0-9_@()+./\\-])(?:[A-Za-z]:[\\/](?:[^\\/\s<>:"|?*]+[\\/])*[^\\/\s<>:"|?*]+\.[A-Za-z0-9]{1,16}|(?:\.{1,2}[\\/])?(?:(?:[A-Za-z0-9_@()+.-]+)[\\/])+(?:[A-Za-z0-9_@()+.-]+)\.[A-Za-z0-9]{1,16}|(?:[A-Za-z0-9_@()+.-]+)\.[A-Za-z0-9]{1,16})(?![A-Za-z0-9_@()+./\\-])/g;

export function renderSafeMarkdown(content: string, workspaceUri: string | undefined): string {
    const workspace = workspaceUri ? new URI(workspaceUri).normalizePath() : undefined;
    const host = document.createElement('div');
    // markdown-it escapes all source HTML because html is deliberately disabled.
    host.innerHTML = markdown.render(content || '…');
    prepareMarkdownLinks(host, workspace);
    linkBareWorkspacePaths(host, workspace);
    return DOMPurify.sanitize(host.innerHTML, {
        ALLOWED_TAGS: ['a', 'blockquote', 'br', 'code', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'li', 'ol', 'p', 'pre', 'strong', 'ul'],
        ALLOWED_ATTR: ['href', 'title', 'rel', POIESIS_FILE_LINK_ATTRIBUTE, POIESIS_EXTERNAL_LINK_ATTRIBUTE],
        ALLOW_DATA_ATTR: false
    });
}

function prepareMarkdownLinks(host: HTMLElement, workspace: URI | undefined): void {
    for (const anchor of Array.from(host.querySelectorAll('a'))) {
        const href = anchor.getAttribute('href') ?? '';
        if (isHttpHref(href)) {
            anchor.setAttribute(POIESIS_EXTERNAL_LINK_ATTRIBUTE, href);
            anchor.setAttribute('rel', 'noopener noreferrer');
            anchor.setAttribute('title', href);
            continue;
        }
        const fileUri = resolveWorkspaceFile(href, workspace);
        if (fileUri) {
            anchor.setAttribute('href', '#');
            anchor.setAttribute(POIESIS_FILE_LINK_ATTRIBUTE, encodeURIComponent(fileUri.toString()));
            anchor.setAttribute('title', fileUri.path.fsPath());
            continue;
        }
        replaceWithCode(anchor, decodedHref(href));
    }
}

function linkBareWorkspacePaths(host: HTMLElement, workspace: URI | undefined): void {
    const textNodes: Text[] = [];
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let current: Node | null;
    while ((current = walker.nextNode())) {
        const parent = current.parentElement;
        if (current instanceof Text && parent && !parent.closest('a, code, pre')) {
            textNodes.push(current);
        }
    }
    for (const textNode of textNodes) {
        const text = textNode.data;
        const matches = [...text.matchAll(bareFilePathPattern)];
        if (!matches.length) {
            continue;
        }
        const fragment = document.createDocumentFragment();
        let offset = 0;
        for (const match of matches) {
            const index = match.index ?? 0;
            const rawPath = match[0];
            fragment.append(text.slice(offset, index));
            const code = document.createElement('code');
            code.textContent = rawPath;
            const fileUri = resolveWorkspaceFile(rawPath, workspace);
            if (fileUri) {
                const anchor = document.createElement('a');
                anchor.href = '#';
                anchor.setAttribute(POIESIS_FILE_LINK_ATTRIBUTE, encodeURIComponent(fileUri.toString()));
                anchor.title = fileUri.path.fsPath();
                anchor.append(code);
                fragment.append(anchor);
            } else {
                fragment.append(code);
            }
            offset = index + rawPath.length;
        }
        fragment.append(text.slice(offset));
        textNode.replaceWith(fragment);
    }
}

function resolveWorkspaceFile(rawHref: string, workspace: URI | undefined): URI | undefined {
    if (!workspace || !rawHref || rawHref === '#') {
        return undefined;
    }
    let decoded: string;
    try {
        decoded = decodeURIComponent(rawHref).trim();
    } catch {
        return undefined;
    }
    let candidate: URI;
    if (/^[A-Za-z]:[\\/]/.test(decoded)) {
        candidate = FileUri.create(decoded);
    } else if (/^file:/i.test(decoded)) {
        candidate = new URI(decoded);
    } else if (decoded.startsWith('/')) {
        candidate = FileUri.create(decoded);
    } else if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(decoded)) {
        return undefined;
    } else {
        candidate = workspace.resolve(decoded.replaceAll('\\', '/'));
    }
    candidate = candidate.withQuery('').withFragment('').normalizePath();
    return workspace.isEqualOrParent(candidate, false) ? candidate : undefined;
}

function replaceWithCode(anchor: HTMLAnchorElement, content = anchor.textContent ?? ''): void {
    const code = document.createElement('code');
    code.textContent = content;
    anchor.replaceWith(code);
}

function decodedHref(href: string): string {
    try {
        return decodeURIComponent(href);
    } catch {
        return href;
    }
}

function isHttpHref(href: string): boolean {
    return /^https?:\/\//i.test(href);
}
