// Node 24 resolves an explicitly supplied test directory through index.js.
// Keep this shim dependency-free; all test implementation is Node ESM.
Promise.all([
  import('./adapters.test.mjs'),
  import('./core.test.mjs'),
  import('./v11-core.test.mjs'),
  import('./v12-core.test.mjs'),
  import('./v13-core.test.mjs'),
  import('./v14-core.test.mjs'),
  import('./v15-cost.test.mjs'),
  import('./v16-local-usage.test.mjs'),
  import('./v17-project-poiesis.test.mjs'),
  import('./v18-nested.test.mjs'),
  import('./bench.test.mjs'),
  import('./dogfood.test.mjs'),
  import('./packaging.test.mjs')
]).catch(error => { console.error(error); process.exitCode = 1; });
