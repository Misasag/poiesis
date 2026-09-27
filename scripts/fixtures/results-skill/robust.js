function save() { localStorage.setItem('count', '1'); }
const arrow = () => save();
const expression = function () { return localStorage.getItem('count'); };
const actions = { run() { arrow(); } };
class Counter {
  increment() { actions.run(); }
  save() { return expression(); }
}
const button = document.getElementById('button');
button.onclick = () => save();
function firstScope() { function duplicate() { return localStorage.getItem('first'); } duplicate(); }
function secondScope() { function duplicate() { return localStorage.getItem('second'); } duplicate(); }
function saveEach(items) { items.forEach(() => save()); }
setTimeout(() => expression(), 10);
