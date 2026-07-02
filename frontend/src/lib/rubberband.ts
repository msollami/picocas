// rubberband.ts — Svelte action adding macOS-style elastic overscroll to a
// scroll container. WebKit doesn't bounce inner overflow:auto elements, so when
// a wheel gesture pushes past the top or bottom we translate the element by a
// damped, capped offset and spring it back when the gesture stops.

interface Opts {
  // Only engage when focus is inside the node (matches the canvas's rule that a
  // card scrolls natively only while one of its cells is focused; otherwise the
  // wheel pans the canvas and must not be intercepted).
  requireFocus?: boolean;
}

export function rubberband(node: HTMLElement, opts: Opts = {}) {
  const MAX = 90;      // px cap on the stretch
  const DAMP = 0.26;   // resistance — smaller = stiffer
  let offset = 0;
  let releaseTimer: ReturnType<typeof setTimeout> | null = null;

  function release() {
    if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null; }
    if (offset === 0) return;
    offset = 0;
    node.style.transition = 'transform 0.34s cubic-bezier(0.22, 1, 0.36, 1)';
    node.style.transform = 'translateY(0)';
  }

  function onWheel(e: WheelEvent) {
    if (opts.requireFocus &&
        !(document.activeElement && node.contains(document.activeElement))) {
      return; // let the canvas handle this wheel (pan)
    }
    const atTop = node.scrollTop <= 0;
    const atBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
    const dy = e.deltaY;
    const pushUp = atTop && dy < 0;
    const pushDown = atBottom && dy > 0;

    if (!pushUp && !pushDown) { release(); return; }  // in-range → native scroll

    // Overscrolling: resist and stretch instead of scrolling/panning.
    e.preventDefault();
    e.stopPropagation();
    if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null; }
    offset = Math.max(-MAX, Math.min(MAX, offset - dy * DAMP));
    node.style.transition = 'none';
    node.style.transform = `translateY(${offset}px)`;
    releaseTimer = setTimeout(release, 110);   // spring back shortly after gesture ends
  }

  node.addEventListener('wheel', onWheel, { passive: false });
  return {
    destroy() {
      node.removeEventListener('wheel', onWheel);
      if (releaseTimer) clearTimeout(releaseTimer);
    },
  };
}
