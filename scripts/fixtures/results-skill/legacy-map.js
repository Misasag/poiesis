const output = document.getElementById('output');
function increase(value) { return value + 1; }
function show(value) { output.textContent = String(increase(value)); }
show(1);
