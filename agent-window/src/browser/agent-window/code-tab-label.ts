function normalizeFilePath(filePath: string): string {
    return filePath.replace(/\\/g, '/').replace(/\/+$/, '');
}

function pathSegments(filePath: string): string[] {
    return normalizeFilePath(filePath).split('/').filter(Boolean);
}

export function codeTabLabel(filePath: string, openFilePaths: readonly string[]): string {
    const segments = pathSegments(filePath);
    const fileName = segments.at(-1) || filePath;
    const normalizedPath = segments.join('/').toLowerCase();
    const duplicates = openFilePaths
        .map(candidate => pathSegments(candidate))
        .filter(candidate => candidate.at(-1)?.toLowerCase() === fileName.toLowerCase());
    if (duplicates.length < 2) {
        return fileName;
    }

    const parents = segments.slice(0, -1);
    for (let depth = 1; depth <= parents.length; depth++) {
        const context = parents.slice(-depth).join('/');
        const distinct = duplicates.every(candidate => {
            if (candidate.join('/').toLowerCase() === normalizedPath) {
                return true;
            }
            return candidate.slice(0, -1).slice(-depth).join('/').toLowerCase() !== context.toLowerCase();
        });
        if (distinct) {
            return `${fileName} — ${context}`;
        }
    }

    return `${fileName} — ${parents.join('/') || '.'}`;
}
