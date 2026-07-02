// rubberband.ts — Svelte action adding a brief, smooth macOS-style elastic
// overscroll to a scroll container (WebKit doesn't bounce inner overflow:auto
// elements).
//
// Lessons baked in:
//   • Translate the container's INNER content (first element child), not the
//     container — translating the container drags its scrollbar off the edge.
//   • Promote that inner element to its own compositor layer while animating
//     (will-change: transform), or translating a tall content block repaints
//     every frame and looks jittery.
//   • Fire exactly ONE bounce per gesture. Trackpad momentum keeps firing
//     overscroll events for ~1s; letting each (re)start a bounce produces a
//     train of little bounces. We stretch once, hold briefly, ease back, and
//     ignore further overscroll until settled and a real pause has occurred.

interface Opts {
  requireFocus?: boolean; // engage only when focus is inside (see Canvas rule)
}

export function rubberband(node: HTMLElement, opts: Opts = {}) {
  const MAX = 60;            // px cap on the stretch
  const IMPULSE = 0.5;       // stretch per unit of the triggering wheel delta
  const HOLD_MS = 70;        // hold at full stretch before releasing
  const EASE = 0.3;          // per-frame ease toward the current target
  const GESTURE_GAP = 200;   // ms of overscroll quiet needed to allow a new bounce

  const inner = () => node.firstElementChild as HTMLElement | null;
  let offset = 0;
  let target = 0;
  let raf = 0;
  let releaseAt = 0;
  let lastOverscrollTs = -1e9;

  function frame(now: number) {
    if (now >= releaseAt) target = 0;   // release phase
    offset += (target - offset) * EASE;
    const el = inner();
    if (target === 0 && Math.abs(offset) < 0.4) {
      offset = 0;
      if (el) { el.style.transform = ''; el.style.willChange = ''; }
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
    if (node.scrollHeight <= node.clientHeight + 1) return; // not scrollable

    const atTop = node.scrollTop <= 0;
    const atBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
    const dy = e.deltaY;
    const overscrolling = (atTop && dy < 0) || (atBottom && dy > 0);
    if (!overscrolling) return; // in range → native scroll

    e.preventDefault();   // swallow at the edge so the page doesn't jerk
    e.stopPropagation();

    const now = performance.now();
    const gap = now - lastOverscrollTs;
    lastOverscrollTs = now;

    // One smooth bounce per fresh gesture; momentum-tail events are ignored.
    if (gap > GESTURE_GAP && raf === 0 && Math.abs(offset) < 0.4) {
      target = Math.max(-MAX, Math.min(MAX, -dy * IMPULSE));
      releaseAt = now + HOLD_MS;
      const el = inner();
      if (el) el.style.willChange = 'transform';
      raf = requestAnimationFrame(frame);
    }
  }

  node.addEventListener('wheel', onWheel, { passive: false });
  return {
    destroy() {
      node.removeEventListener('wheel', onWheel);
      if (raf) cancelAnimationFrame(raf);
      const el = inner();
      if (el) { el.style.transform = ''; el.style.willChange = ''; }
    },
  };
}
