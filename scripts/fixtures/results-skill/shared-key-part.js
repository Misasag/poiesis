const panel = document.getElementById('panel');
function part(value) { return `shared:${value}`; }
function read(name) { return Number(localStorage.getItem(name) ?? 0); }
function display() { const name = part('x'); panel.textContent = String(read(name)); }
function write() { const name = part('x'); localStorage.setItem(name, String(read(name) + 1)); display(); }
document.getElementById('go').addEventListener('click', () => write());
window.addEventListener('focus', () => display());
