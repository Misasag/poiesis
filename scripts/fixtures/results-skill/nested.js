function outer() {
  function inner() {
    localStorage.setItem('k', 'v');
  }
  inner();
}
outer();
