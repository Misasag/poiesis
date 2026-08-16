const os = require('node:os');

const localHome = process.env.LENS_ELECTRON_GYP_HOME;
if (localHome) {
    os.homedir = () => localHome;
}

const localCache = process.env.LENS_ELECTRON_CACHE;
if (localCache) {
    const electronGet = require('@electron/get');
    const downloadArtifact = electronGet.downloadArtifact;
    electronGet.downloadArtifact = options => downloadArtifact({
        ...options,
        cacheRoot: options.cacheRoot ?? localCache
    });
}
