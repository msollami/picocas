// rubberband.ts — Svelte action adding macOS-style elastic overscroll to a
// scroll container. WebKit doesn't bounce inner overflow:auto elements, so when
// a wheel gesture pushes past the top or bottom we stretch the element by a
// damped, capped offset and let it spring back.
//
// The stretch is driven by an rAF loop where the "target" decays every frame.
// That is the key to not getting stuck: trackpad momentum keeps emitting wheel
// events with a long, slow tail, and a fixed post-gesture timer would hold the
// stretch open for that whole tail. Instead each frame pulls the target back
// toward zero, so the moment the push weakens (finger lifted, momentum fading)
// the element snaps back promptly.

interface Opts {
  // Only engage when focus is inside the node (matches the canvas rule that a
  // card scrolls natively only while one of its cells is focused; otherwise the
  // wheel pans the canvas and must not be intercepted).
  requireFocus?: boolean;
}

export function rubberband(node: HTMLElement, opts: Opts = {}) {
  const MAX = 80;            // px cap on the stretch
  const PUSH = 0.18;         // how much a wheel delta feeds the stretch
  const TARGET_DECAY = 0.72; // per-frame pull of target → 0 (momentum can't hold)
  const EASE = 0.30;         // per-frame ease of offset → target

  let offset = 0;
  let target = 0;
  let raf = 0;

  function frame() {
    target *= TARGET_DECAY;
    if (Math.abs(target) < 0.4) target = 0;
    offset += (target - offset) * EASE;
    if (target === 0 && Math.abs(offset) < 0.3) {
      offset = 0;
      node.style.transform = '';
      raf = 0;
      return;
    }
    node.style.transform = `translateY(${offset.toFixed(2)}px)`;
    raf = requestAnimationFrame(frame);
  }

  function onWheel(e: WheelEvent) {
    if (opts.requireFocus &&
        !(document.activeElement && node.contains(document.activeElement))) {
      return; // let the canvas handle this wheel (pan)
    }
    const atTop = node.scrollTop <= 0;
    const atBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
    const dy = e.deltaY;
    const overscrolling = (atTop && dy < 0) || (atBottom && dy > 0);
    if (!overscrolling) return; // in range → native scroll; any offset eases out via rAF

    e.preventDefault();
    e.stopPropagation();
    target = Math.max(-MAX, Math.min(MAX, target - dy * PUSH));
    if (!raf) raf = requestAnimationFrame(frame);
  }

  node.addEventListener('wheel', onWheel, { passive: false });
  return {
    destroy() {
      node.removeEventListener('wheel', onWheel);
      if (raf) cancelAnimationFrame(raf);
    },
  };
}
