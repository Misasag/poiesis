/**
 * Keep Theia's generated browser and backend configurations unchanged while
 * selecting webpack. Native esbuild cannot read workspace files in the
 * managed Windows sandbox used for this spike.
 */
// @ts-check
const configs = require('./gen-webpack.config.js');
const nodeConfig = require('./gen-webpack.node.config.js');

// @vscode/proxy-agent treats this native certificate helper as optional. It
// requires Visual Studio Spectre libraries when rebuilt for Node 24, so keep
// the optional fallback disabled and use Node's standard CA handling.
nodeConfig.config.resolve = nodeConfig.config.resolve || {};
nodeConfig.config.resolve.alias = {
    ...(nodeConfig.config.resolve.alias || {}),
    '@vscode/windows-ca-certs': false
};

module.exports = [
    ...configs,
    nodeConfig.config
];
