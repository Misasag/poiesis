/**
 * Use the same managed-Windows webpack path as the browser spike. Native
 * esbuild cannot read this workspace in the test sandbox.
 */
// @ts-check
const configs = require('./gen-webpack.config.js');
const nodeConfig = require('./gen-webpack.node.config.js');

for (const config of configs) {
    config.parallelism = 2;
}
nodeConfig.config.parallelism = 2;

// The optional native certificate helper requires Visual Studio Spectre
// libraries on this machine. Electron falls back to Node/Electron CA handling.
nodeConfig.config.resolve = nodeConfig.config.resolve || {};
nodeConfig.config.resolve.alias = {
    ...(nodeConfig.config.resolve.alias || {}),
    '@vscode/windows-ca-certs': false
};

module.exports = [
    ...configs,
    nodeConfig.config
];
