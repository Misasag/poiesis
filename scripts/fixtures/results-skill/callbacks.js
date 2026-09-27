function b() {}
function save() { localStorage.setItem('count', '1'); }
function a() { setTimeout(() => b(), 10); }
function each(items) { items.forEach(item => b(item)); }
function later(p, value) {
  p.then(() => localStorage.setItem('k', value));
  setTimeout(save, 10);
}
function watch() { new MutationObserver(() => b()); }
new Promise(resolve => b());
