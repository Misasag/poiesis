/**
 * Use the same managed-Windows webpack path as the browser spike. Native
 * esbuild cannot read this workspace in the test sandbox.
 */
// @ts-check
const path = require('path');
const webpack = require('webpack');
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

// Theia copies ripgrep to lib/backend/native and generates a module that points
// at that location. In an asar package the executable is unpacked, so make both
// workspace search and Quick Open resolve the real filesystem path.
nodeConfig.config.plugins.push(new webpack.NormalModuleReplacementPlugin(
    /native-webpack-plugin[\\/]ripgrep\.js$/,
    path.resolve(__dirname, 'scripts', 'bundled-ripgrep-path.js')
));

module.exports = [
    ...configs,
    nodeConfig.config
];
