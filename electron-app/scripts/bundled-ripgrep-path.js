// @ts-check
const path = require('path');

/**
 * Child processes cannot execute a binary through Electron's virtual app.asar
 * path. electron-builder places native binaries beside it in app.asar.unpacked.
 *
 * @param {string} bundledPath
 * @returns {string}
 */
function resolveBundledRipgrepPath(bundledPath) {
    const archiveSegment = `${path.sep}app.asar${path.sep}`;
    if (!bundledPath.includes(archiveSegment)) {
        return bundledPath;
    }
    return bundledPath.replace(archiveSegment, `${path.sep}app.asar.unpacked${path.sep}`);
}

const rgPath = resolveBundledRipgrepPath(path.join(
    __dirname,
    'native',
    process.platform === 'win32' ? 'rg.exe' : 'rg'
));

module.exports = {
    rgPath,
    resolveBundledRipgrepPath
};
