(() => {
  const root = document.documentElement;
  let opener = null;
  const opened = () => document.querySelector('details.ex-hit[open], details.ex-hit-inline[open]');
  const closePanel = () => {
    const current = opened();
    if (!current) return;
    current.open = false;
    const target = opener ?? current.querySelector(':scope > summary');
    target?.focus();
    opener = null;
  };
  document.addEventListener('toggle', event => {
    const details = event.target;
    if (!(details instanceof HTMLDetailsElement) || !details.matches('.ex-hit, .ex-hit-inline') || !details.open) return;
    for (const other of document.querySelectorAll('details.ex-hit[open], details.ex-hit-inline[open]')) if (other !== details) other.open = false;
    opener = details.querySelector(':scope > summary');
  }, true);
  document.addEventListener('click', event => {
    const citation = event.target.closest('[data-poiesis-citation]');
    if (citation) {
      event.preventDefault();
      window.parent.postMessage({ type: 'poiesis:open-citation', citation: citation.dataset.poiesisCitation }, '*');
      return;
    }
    const image = event.target.closest('[data-poiesis-image]');
    if (image) {
      event.preventDefault();
      window.parent.postMessage({ type: 'poiesis:open-image', path: image.dataset.poiesisImage }, '*');
      return;
    }
    if (event.target.closest('.ex-close > summary')) {
      event.preventDefault();
      closePanel();
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && opened()) { event.preventDefault(); closePanel(); }
    const grip = event.target.closest('.ex-panel-grip');
    if (!grip || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const current = parseFloat(getComputedStyle(root).getPropertyValue('--ex-panel-w')) || Math.min(innerWidth * .46, 620);
    const delta = (event.key === 'ArrowLeft' ? 1 : -1) * (event.shiftKey ? 40 : 20);
    setWidth(current + delta);
  });
  function setWidth(width) {
    const max = Math.max(320, innerWidth * .7);
    const value = Math.min(max, Math.max(320, width));
    root.style.setProperty('--ex-panel-w', `${value}px`);
    for (const grip of document.querySelectorAll('.ex-panel-grip')) {
      grip.setAttribute('aria-valuenow', String(Math.round(value)));
      grip.setAttribute('aria-valuemax', String(Math.round(max)));
    }
  }
  let dragging = false;
  document.addEventListener('pointerdown', event => {
    const grip = event.target.closest('.ex-panel-grip');
    if (!grip) return;
    dragging = true;
    grip.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  document.addEventListener('pointermove', event => { if (dragging) setWidth(innerWidth - event.clientX); });
  document.addEventListener('pointerup', () => { dragging = false; });
  document.addEventListener('pointercancel', () => { dragging = false; });
  window.addEventListener('resize', () => {
    const current = parseFloat(getComputedStyle(root).getPropertyValue('--ex-panel-w'));
    if (Number.isFinite(current)) setWidth(current);
  });
  setWidth(Math.min(innerWidth * .46, 620));
})();
