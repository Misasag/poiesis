(() => {
  const root = document.documentElement;
  let opener = null;
  const opened = () => document.querySelector('details.ex-hit[open], details.ex-hit-inline[open]');
  const closePanel = (current = opened()) => {
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
    if (event.target.closest('.ex-close > summary, .ex-panel-close')) {
      event.preventDefault();
      closePanel(event.target.closest('details.ex-hit, details.ex-hit-inline'));
      return;
    }
    const part = event.target.closest('.ex-view-card[data-part]');
    if (part && !event.target.closest('a,.ex-view-judgment,.ex-view-source')) selectPart(part.dataset.part);
  });
  function selectPart(id) {
    const selected = document.querySelector('.ex-view-card.ex-related')?.dataset.part === id;
    for (const part of document.querySelectorAll('.ex-view-card[data-part]'))
      part.classList.toggle('ex-related', !selected && part.dataset.part === id);
    for (const view of document.querySelectorAll('.ex-view[data-storage-part]'))
      view.classList.toggle('ex-view-visible', !selected && view.dataset.storagePart === id);
  }
  document.addEventListener('keydown', event => {
    const part = event.target.closest('.ex-view-card[data-part]');
    if (part && !event.target.closest('.ex-view-judgment,.ex-view-source') && ['Enter', ' '].includes(event.key)) { event.preventDefault(); selectPart(part.dataset.part); return; }
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
    queueViewLinks();
  }
  let linkFrame = 0;
  function queueViewLinks() {
    if (linkFrame) return;
    linkFrame = requestAnimationFrame(() => { linkFrame = 0; layoutViewLinks(); });
  }
  function layoutViewLinks() {
    for (const host of document.querySelectorAll('.ex-view-structure')) {
      const svg = host.querySelector('.ex-view-link-layer');
      const gap = host.querySelector('.ex-view-link-gap');
      if (!svg || !gap) continue;
      const hostBox = host.getBoundingClientRect();
      const gapBox = gap.getBoundingClientRect();
      const gapTop = gapBox.top - hostBox.top;
      const gapHeight = gapBox.height;
      svg.setAttribute('viewBox', `0 0 ${hostBox.width} ${hostBox.height}`);
      for (const link of svg.querySelectorAll('.ex-view-link')) {
        const from = [...host.querySelectorAll('.ex-view-card[data-part]')]
          .find(card => card.dataset.part === link.dataset.from);
        const to = [...host.querySelectorAll('.ex-view-card[data-part]')]
          .find(card => card.dataset.part === link.dataset.to);
        if (!from || !to) { link.hidden = true; continue; }
        const first = from.getBoundingClientRect(), last = to.getBoundingClientRect();
        const call = link.dataset.verb === '呼ぶ';
        const startX = first.left - hostBox.left + first.width * .5;
        const startY = first.bottom - hostBox.top + 2;
        const endX = last.left - hostBox.left + last.width * (call ? .27 : .73);
        const endY = last.top - hostBox.top - 7;
        const trackY = gapTop + gapHeight * (call ? .31 : .72);
        link.querySelector('path').setAttribute('d', `M ${startX} ${startY} V ${trackY} H ${endX} V ${endY}`);
        const label = link.querySelector('text');
        const labelX = (startX + endX) / 2;
        label.setAttribute('x', labelX);
        label.setAttribute('y', trackY);
        const bounds = label.getBBox();
        const plate = link.querySelector('rect');
        plate.setAttribute('x', bounds.x - 6);
        plate.setAttribute('y', bounds.y - 3);
        plate.setAttribute('width', bounds.width + 12);
        plate.setAttribute('height', bounds.height + 6);
      }
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
  for (const host of document.querySelectorAll('.ex-view-structure')) new ResizeObserver(queueViewLinks).observe(host);
  for (const image of document.querySelectorAll('.ex-view-structure img')) image.addEventListener('load', queueViewLinks);
  setWidth(Math.min(innerWidth * .46, 620));
  queueViewLinks();
})();
