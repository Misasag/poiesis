const countElement = document.getElementById('count');
function updateCount() {
  countElement.textContent = '1';
}
document.addEventListener('click', updateCount);
document.addEventListener('keydown', updateCount);
