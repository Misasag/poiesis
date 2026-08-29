const path = require('node:path');

// Packaged plugins live outside app.asar so the backend/plugin host can read
// their manifests and entry points directly. Development keeps using the
// workspace-level plugins directory.
const isPackaged = Boolean(process.versions.electron) && !process.defaultApp;
const bundledPluginsDir = isPackaged
    ? path.join(process.resourcesPath, 'app', 'plugins')
    : path.resolve(__dirname, '..', '..', 'plugins');

process.env.THEIA_DEFAULT_PLUGINS = `local-dir:${bundledPluginsDir}`;

require('../lib/backend/electron-main.js');
