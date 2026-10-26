/* Keep camera information below the watermark, including letterboxed full screen. */
(() => {
  'use strict';
  const container = document.querySelector('.skycam-container');
  const stage = document.getElementById('skycamImageStage');
  const labels = document.querySelector('.skycam-labels');
  if (!container || !stage || !labels) return;
  function positionLabels() {
    const outer = container.getBoundingClientRect(), box = stage.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const frame = stage.querySelector('.skycam-frame.is-active') || stage.querySelector('img');
    const focus = container.classList.contains('skycam-focus-mode') || document.fullscreenElement === container;
    const ratio = frame?.naturalWidth && frame?.naturalHeight ? frame.naturalWidth / frame.naturalHeight : 4 / 3;
    const height = focus ? Math.min(box.height, box.width / ratio) : box.height;
    const width = focus ? height * ratio : box.width;
    const inset = width < 400 ? 7 : 10;
    const x = (box.width - width) / 2;
    const y = (box.height - height) / 2;
    labels.style.setProperty('--skycam-label-top', (box.top - outer.top + y + Math.max(32, height * .14)) + 'px');
    labels.style.setProperty('--skycam-label-left', (box.left - outer.left + x + inset) + 'px');
    labels.style.setProperty('--skycam-label-right', (outer.right - box.right + x + inset) + 'px');
  }
  new ResizeObserver(positionLabels).observe(stage);
  new MutationObserver(positionLabels).observe(container, { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(positionLabels).observe(stage, { subtree: true, attributes: true, attributeFilter: ['class'] });
  for (const frame of stage.querySelectorAll('img')) frame.addEventListener('load', positionLabels);
  document.addEventListener('fullscreenchange', positionLabels);
  positionLabels();
})();
