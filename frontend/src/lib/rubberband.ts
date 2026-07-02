// rubberband.ts — Svelte action adding macOS-style elastic overscroll to a
// scroll container. WebKit doesn't bounce inner overflow:auto elements.
//
// Two things matter for this to feel right:
//   1. We translate the container's INNER content (its first element child),
//      NOT the container itself — translating the container drags its scrollbar
//      away from the top/bottom.
//   2. Trackpad momentum keeps firing overscroll wheel events for ~1s after the
//      fingers lift. If every one fed the stretch it would stay stuck open. So
//      we only feed the stretch for a short window after the gesture starts;
//      past that the rAF spring (whose target decays each frame) wins and it
//      snaps back even while momentum is still arriving.

interface Opts {
  requireFocus?: boolean; // engage only when focus is inside (see Canvas rule)
}

export function rubberband(node: HTMLElement, opts: Opts = {}) {
  const MAX = 72;            // px cap on the stretch
  const PUSH = 0.16;         // how much a wheel delta feeds the stretch
  const TARGET_DECAY = 0.55; // per-frame pull of target → 0
  const EASE = 0.35;         // per-frame ease of offset → target
  const HOLD_MS = 140;       // only feed the stretch this long after it starts

  const inner = () => node.firstElementChild as HTMLElement | null;
  let offset = 0;
  let target = 0;
  let raf = 0;
  let startedAt = 0;

  function frame() {
    target *= TARGET_DECAY;
    if (Math.abs(target) < 0.4) target = 0;
    offset += (target - offset) * EASE;
    const el = inner();
    if (target === 0 && Math.abs(offset) < 0.3) {
      offset = 0;
      if (el) el.style.transform = '';
      raf = 0;
      return;
    }
    if (el) el.style.transform = `translateY(${offset.toFixed(2)}px)`;
    raf = requestAnimationFrame(frame);
  }

  function onWheel(e: WheelEvent) {
    if (opts.requireFocus &&
        !(document.activeElement && node.contains(document.activeElement))) {
      return; // let the canvas handle this wheel (pan)
    }
    // Not actually scrollable (e.g. this card in full-screen mode, where the
    // outer .focused-view is the scroller) → don't hijack the wheel.
    if (node.scrollHeight <= node.clientHeight + 1) return;
    const atTop = node.scrollTop <= 0;
    const atBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
    const dy = e.deltaY;
    const overscrolling = (atTop && dy < 0) || (atBottom && dy > 0);
    if (!overscrolling) { startedAt = 0; return; } // in range → native scroll

    e.preventDefault();
    e.stopPropagation();
    const now = performance.now();
    if (!startedAt || (!raf && target === 0 && offset === 0)) startedAt = now;
    // Only stretch during the initial active push; ignore the momentum tail.
    if (now - startedAt < HOLD_MS) {
      target = Math.max(-MAX, Math.min(MAX, target - dy * PUSH));
    }
    if (!raf) raf = requestAnimationFrame(frame);
  }

  node.addEventListener('wheel', onWheel, { passive: false });
  return {
    destroy() {
      node.removeEventListener('wheel', onWheel);
      if (raf) cancelAnimationFrame(raf);
      const el = inner();
      if (el) el.style.transform = '';
    },
  };
}
