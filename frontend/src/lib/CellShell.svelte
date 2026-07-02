<!--
  CellShell.svelte
  Wraps any cell type. Provides:
    • Cell type picker (dropdown on the type badge)
    • 4-directional add buttons (↑ ↓ ← →) that appear on hover
    • Selection state (left accent bar)
    • Run / output area for code cells

  The `store` prop is the per-notebook store (createNotebook() instance).
  All mutation calls go through store.xxx() instead of the global notebook singleton.
-->
<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher, tick } from 'svelte';
  import { renderMarkdown } from './markdown';
  import { EditorView, keymap } from '@codemirror/view';
  import { EditorState, EditorSelection } from '@codemirror/state';
  import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
  import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
  import Output from './Output.svelte';
  import type { Cell, CellType, OutputItem } from './notebook';
  import { selectedCells, selectOnly, toggleSelect, rangeSelect, clearSelection } from './notebook';

  export let cell: Cell;
  export let rowId: string;
  export let cellIdx: number;
  /** Per-notebook store instance — use store.xxx() for all mutations. */
  export let store: any;
  /** Side-by-side input/output layout (toggled from the focused toolbar) */
  export let horizontal: boolean = false;

  // Draggable split ratio for horizontal layout (percent of width for input)
  let splitRatio = 50;
  let splitContainer: HTMLElement;
  let draggingSplit = false;

  function onSplitPointerDown(e: PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    draggingSplit = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onSplitPointerMove(e: PointerEvent) {
    if (!draggingSplit || !splitContainer) return;
    const rect = splitContainer.getBoundingClientRect();
    const x = e.clientX - rect.left;
    splitRatio = Math.max(15, Math.min(85, (x / rect.width) * 100));
  }
  function onSplitPointerUp() { draggingSplit = false; }

  const dispatch = createEventDispatcher<{
    run:       { id: string };
    change:    { id: string; source: string };
    addAbove:  { rowId: string };
    addBelow:  { rowId: string };
    addLeft:   { rowId: string; cellIdx: number };
    addRight:  { rowId: string; cellIdx: number };
    focusPrev: { id: string };
    focusNext: { id: string };
    register:  { id: string; fn: () => void };
  }>();

  $: selected = $selectedCells.has(cell.id);

  // ---- CodeMirror editor ----
  let editorContainer: HTMLElement;
  let view: EditorView;

  onMount(() => {
    if (cell.type !== 'code') return;
    initEditor();
  });

  function initEditor() {
    if (view) { view.destroy(); view = undefined as any; }
    view = new EditorView({
      state: EditorState.create({
        doc: cell.source,
        extensions: [
          history(),
          // Soft-wrap long input lines so they don't run off the page.
          EditorView.lineWrapping,
          syntaxHighlighting(defaultHighlightStyle),
          keymap.of([
            { key: 'Shift-Enter', run() { dispatch('run', { id: cell.id }); return true; } },
            { key: 'Mod-Enter',   run() { dispatch('run', { id: cell.id }); dispatch('addBelow', { rowId }); return true; } },
            { key: 'ArrowUp',     run(v) {
              const sel = v.state.selection.main;
              if (sel.head <= v.state.doc.lineAt(0).to) {
                dispatch('focusPrev', { id: cell.id }); return true;
              }
              return false;
            }},
            { key: 'ArrowDown',   run(v) {
              const sel = v.state.selection.main;
              const last = v.state.doc.lineAt(v.state.doc.length);
              if (sel.head >= last.from) {
                dispatch('focusNext', { id: cell.id }); return true;
              }
              return false;
            }},
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of(update => {
            if (update.docChanged)
              dispatch('change', { id: cell.id, source: view.state.doc.toString() });
          }),
          EditorView.theme({
            '&': { fontSize: '1rem', fontFamily: "'SF Mono','Fira Code','Cascadia Code',monospace", background: 'transparent' },
            '.cm-scroller': { overflow: 'auto', minHeight: '1.8em' },
            '.cm-content': { padding: '6px 8px', textAlign: 'left', caretColor: '#89b4fa' },
            '.cm-focused': { outline: 'none' },
            '.cm-line': { lineHeight: '1.6', textAlign: 'left' },
            '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#89b4fa !important', borderLeftWidth: '2px !important' },
            '.cm-selectionBackground': { background: 'rgba(137,180,250,0.2) !important' },
          }),
        ],
      }),
      parent: editorContainer,
    });

    dispatch('register', {
      id: cell.id,
      fn: () => {
        view.focus();
        const end = view.state.doc.length;
        view.dispatch({ selection: EditorSelection.cursor(end) });
      },
    });
  }

  onDestroy(() => view?.destroy());

  $: if (view && view.state.doc.toString() !== cell.source) {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: cell.source } });
  }

  // ---- Type picker ----
  let showTypePicker = false;
  const TYPES: { id: CellType; label: string; icon: string; desc: string }[] = [
    { id: 'code',       icon: '▶',  label: 'Code',       desc: 'Evaluate Mathilda expressions' },
    { id: 'text',       icon: 'T',  label: 'Text',       desc: 'Prose / markdown' },
    { id: 'section',    icon: '#',  label: 'Section',    desc: 'H1 heading' },
    { id: 'subsection', icon: '##', label: 'Subsection', desc: 'H2 heading' },
  ];

  function setType(t: CellType) {
    showTypePicker = false;
    // Use the store prop instead of the global notebook singleton
    store.setCellType(cell.id, t);
    if (t === 'code') {
      setTimeout(initEditor, 10);
    }
  }

  // ---- Selection ----
  function onBodyClick(_e: MouseEvent) { clearSelection(); }
  function onHeaderClick(e: MouseEvent) {
    e.stopPropagation();
    if (e.shiftKey) rangeSelect(cell.id);
    else if (e.metaKey || e.ctrlKey) toggleSelect(cell.id);
    else selectOnly(cell.id);
  }

  // ---- Inline text editing (non-code) ----
  function onTextInput(e: Event) {
    dispatch('change', { id: cell.id, source: (e.target as HTMLElement).innerText });
  }

  // Markdown render state for text cells (Shift+Enter renders; click edits).
  let rendered = false;

  async function editProse() {
    rendered = false;
    await tick();
    if (proseEl) { proseEl.innerText = cell.source; proseEl.focus(); }
  }

  // Arrow navigation for contenteditable cells (section/subsection/text), plus
  // Shift+Enter to render a text cell's markdown. Dispatches focusPrev/focusNext
  // so the notebook can show the insertion cursor.
  function onProseKeydown(e: KeyboardEvent) {
    // Shift+Enter renders the markdown of a text cell and advances to the next
    // insertion point, mirroring how running a code cell moves on.
    if (e.key === 'Enter' && e.shiftKey && cell.type === 'text') {
      e.preventDefault();
      dispatch('change', { id: cell.id, source: (proseEl?.innerText ?? cell.source) });
      rendered = true;
      dispatch('focusNext', { id: cell.id });
      return;
    }

    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;

    // Section/subsection headings are always single-line → navigate immediately.
    if (cell.type === 'section' || cell.type === 'subsection') {
      e.preventDefault();
      dispatch(e.key === 'ArrowUp' ? 'focusPrev' : 'focusNext', { id: cell.id });
      return;
    }

    // Text cells: let the browser attempt the caret move, then check on the
    // next frame whether it actually moved *to another line*. If it didn't
    // (already on the first/last visual line — including empty trailing lines
    // where the caret rect is unavailable), navigate to the adjacent insertion
    // point. This is robust to contenteditable's block/<br> structure, which
    // defeats offset- and rect-based heuristics on blank lines.
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return;

    const beforeNode = sel.focusNode;
    const beforeOffset = sel.focusOffset;
    const caretTop = (): number | null => {
      const s = window.getSelection();
      if (!s || s.rangeCount === 0) return null;
      const r = s.getRangeAt(0).getBoundingClientRect();
      return (r.top === 0 && r.bottom === 0 && r.left === 0) ? null : r.top;
    };
    const beforeTop = caretTop();
    const key = e.key;

    requestAnimationFrame(() => {
      const s = window.getSelection();
      if (!s) return;
      const sameCaret = s.focusNode === beforeNode && s.focusOffset === beforeOffset;
      const afterTop = caretTop();
      // Same line = caret didn't move to a new node/offset, OR it stayed on the
      // same visual row (top unchanged — e.g. jumped to the row's end/start).
      const sameLine = sameCaret
        || (beforeTop !== null && afterTop !== null && Math.abs(afterTop - beforeTop) < 1);
      if (sameLine) dispatch(key === 'ArrowUp' ? 'focusPrev' : 'focusNext', { id: cell.id });
    });
  }

  // Focus ref + contenteditable state management
  let proseEl: HTMLElement;
  let _lastCellId = '';

  // Only update the DOM when the CELL IDENTITY changes (loading a new file),
  // not on every store update caused by the user typing.
  // If we update on every cell.source change, Svelte overwrites the user's
  // typed content, causing the duplication bug.
  $: if (proseEl && cell.id !== _lastCellId) {
    proseEl.innerText = cell.source;
    _lastCellId = cell.id;
    // Register focus fn once the element exists. If the cell is currently
    // showing rendered markdown, focusing it re-enters edit mode.
    dispatch('register', {
      id: cell.id,
      fn: () => { if (rendered) editProse(); else proseEl?.focus(); },
    });
  }
</script>

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
<div
  class="cell-shell"
  class:selected
  class:running={cell.status === 'running'}
  class:type-code={cell.type === 'code'}
  class:type-text={cell.type === 'text'}
  class:type-section={cell.type === 'section'}
  class:type-subsection={cell.type === 'subsection'}
  on:click={onBodyClick}
>

  <!-- Compact left gutter: run button for code, type badge for others -->
  <div class="cell-gutter" on:click|stopPropagation={onHeaderClick}>
    {#if cell.type === 'code'}
      <button
        class="run-btn"
        title="Run (Shift+Enter)"
        disabled={cell.status === 'running'}
        on:click|stopPropagation={() => dispatch('run', { id: cell.id })}
      >{#if cell.status === 'running'}<span class="spinner">●</span>{:else}▶{/if}</button>
      {#if cell.execIdx != null}
        <span class="exec-label">In[{cell.execIdx}]</span>
      {/if}
    {:else}
      <!-- Type badge for non-code cells: click to open type picker -->
      <div class="type-badge-wrap">
        <button class="type-badge" on:click|stopPropagation={() => showTypePicker = !showTypePicker} title="Change cell type">
          {TYPES.find(t => t.id === cell.type)?.icon ?? 'T'}
        </button>
        {#if showTypePicker}
          <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
          <div class="type-picker-row" on:click|stopPropagation>
            {#each TYPES as t}
              <button class="type-pill" class:active={cell.type === t.id} on:click={() => setType(t.id)} title={t.label}>
                {t.icon} {t.label}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>

  <!-- Cell content — clicking anywhere in the body focuses the editor -->
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div
    class="cell-content"
    class:cell-horizontal={horizontal && cell.type === 'code'}
    bind:this={splitContainer}
    on:click|stopPropagation={() => { if (cell.type === 'code' && view) view.focus(); }}
    on:pointermove={onSplitPointerMove}
    on:pointerup={onSplitPointerUp}
    on:pointercancel={onSplitPointerUp}
  >
    {#if cell.type === 'code'}
      <div
        class="input-pane"
        bind:this={editorContainer}
        style={horizontal ? `flex: 0 0 ${splitRatio}%; max-width: ${splitRatio}%` : ''}
      ></div>
      {#if horizontal && cell.output.length > 0}
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div
          class="split-handle"
          on:pointerdown={onSplitPointerDown}
        ></div>
      {/if}
      {#if cell.output.length > 0}
        <div class="output-pane">
          <Output items={cell.output} />
        </div>
      {/if}

    {:else if cell.type === 'text'}
      <!-- svelte-ignore a11y-click-events-have-key-events -->
      {#if rendered}
        <!-- Rendered markdown (Shift+Enter). Click to edit again. -->
        <div class="prose-rendered" on:click|stopPropagation={editProse}>
          {@html renderMarkdown(cell.source)}
        </div>
      {:else}
        <!-- Content set via JS ($: proseEl update) to avoid contenteditable doubling -->
        <div
          class="prose-cell"
          contenteditable="true"
          bind:this={proseEl}
          on:input={onTextInput}
          on:keydown={onProseKeydown}
          on:click|stopPropagation
        ></div>
      {/if}

    {:else if cell.type === 'section'}
      <!-- svelte-ignore a11y-click-events-have-key-events -->
      <h1
        class="heading-cell"
        contenteditable="true"
        bind:this={proseEl}
        on:input={onTextInput}
        on:keydown={onProseKeydown}
        on:click|stopPropagation
      ></h1>

    {:else if cell.type === 'subsection'}
      <!-- svelte-ignore a11y-click-events-have-key-events -->
      <h2
        class="heading-cell"
        contenteditable="true"
        bind:this={proseEl}
        on:input={onTextInput}
        on:keydown={onProseKeydown}
        on:click|stopPropagation
      ></h2>
    {/if}
  </div>

</div>

<!-- Close type picker when clicking outside -->
{#if showTypePicker}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div style="position:fixed;inset:0;z-index:199;" on:click={() => showTypePicker = false}></div>
{/if}

<style>
  /* ---- Shell ---- */
  /* ---- Cell shell: flex row with narrow left gutter ---- */
  .cell-shell {
    position: relative;
    display: flex;
    flex-direction: row;
    /* A left "spine" replaces the old full-width separator lines: transparent
       by default (so cells read as an airy stack separated by whitespace), a
       faint hairline on hover, and the accent color when the io pair is
       focused or selected — grouping input+output as one unit without stripes. */
    border-left: 2px solid transparent;
    border-radius: 3px;
    transition: border-color 0.15s, background 0.15s;
    /* Transparent at rest so cells and the gaps between them read identically
       (a translucent per-cell background produced faint stripes over the card).
       Only the interaction states below tint the cell. */
    background: transparent;
  }
  .cell-shell:hover         { border-left-color: var(--border, rgba(255,255,255,0.09)); }
  .cell-shell:focus-within  { border-left-color: var(--accent, #89b4fa); background: rgba(137,180,250,0.03); }
  .cell-shell.selected      { border-left-color: var(--accent, #89b4fa); background: rgba(137,180,250,0.09); }
  .cell-shell.running       { background: rgba(243,156,18,0.04); }

  /* ---- Left gutter: run button + exec label stacked, no wasted horizontal space ---- */
  .cell-gutter {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    padding: 6px 3px 6px 3px;
    width: 52px;
    flex-shrink: 0;
    cursor: pointer;
    user-select: none;
    gap: 2px;
    overflow: visible;
  }

  .exec-label {
    font-size: 0.55rem;
    color: var(--text-muted, #585b70);
    font-family: 'SF Mono', monospace;
    white-space: nowrap;
    writing-mode: horizontal-tb;
    line-height: 1;
    max-width: 100%;
  }

  .run-btn {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.75rem;
    color: var(--accent, #89b4fa);
    padding: 1px 3px;
    border-radius: 3px;
    line-height: 1;
    transition: background 0.1s;
  }
  .run-btn:hover:not(:disabled) { background: var(--accent-glow, rgba(137,180,250,0.12)); }
  .run-btn:disabled { opacity: 0.3; cursor: default; }

  .spinner { animation: pulse 0.9s ease-in-out infinite; display: inline-block; color: #f39c12; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }

  /* ---- Type badge / picker ---- */
  .type-badge-wrap { position: relative; }

  .type-badge {
    background: none;
    border: 1px solid var(--border, rgba(255,255,255,0.08));
    border-radius: 4px;
    font-size: 0.65rem;
    font-family: 'SF Mono', monospace;
    color: var(--text-muted, #585b70);
    padding: 1px 5px;
    cursor: pointer;
    line-height: 1.4;
    transition: border-color 0.1s, color 0.1s;
  }
  .type-badge:hover { border-color: var(--accent, #89b4fa); color: var(--accent, #89b4fa); }

  /* Compact horizontal type picker — appears as a pill row below the badge */
  .type-picker-row {
    position: absolute;
    top: calc(100% + 3px);
    left: 0;
    display: flex;
    gap: 3px;
    background: rgba(12, 15, 28, 0.96);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 7px;
    padding: 4px;
    z-index: 200;
    box-shadow: 0 6px 20px rgba(0,0,0,0.5);
    white-space: nowrap;
  }

  .type-pill {
    background: none;
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 5px;
    color: #6c7086;
    font-size: 0.72rem;
    font-family: 'SF Mono', monospace;
    padding: 2px 8px;
    cursor: pointer;
    transition: all 0.1s;
    white-space: nowrap;
  }
  .type-pill:hover  { border-color: var(--accent, #89b4fa); color: var(--accent, #89b4fa); }
  .type-pill.active { border-color: var(--accent, #89b4fa); color: var(--accent, #89b4fa); background: rgba(137,180,250,0.1); }

  /* ---- Cell content ---- */
  .cell-content { padding: 0; flex: 1; min-width: 0; }

  /* Horizontal (side-by-side) layout: input left, output right */
  .cell-horizontal {
    display: flex;
    flex-direction: row;
    align-items: stretch;   /* make all children fill the full cell height */
  }
  .input-pane  { flex: 1; min-width: 0; overflow: hidden; }
  .output-pane { flex: 1; min-width: 0; border-left: 1px solid var(--border, rgba(255,255,255,0.06)); }

  /* Draggable divider between input and output panes */
  .split-handle {
    flex: 0 0 12px;
    width: 12px;
    cursor: col-resize;
    background: transparent;
    position: relative;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  /* Thin visual bar centered in the handle */
  .split-handle::before {
    content: '';
    display: block;
    width: 2px;
    height: 48px;
    max-height: 80%;
    border-radius: 2px;
    background: rgba(255,255,255,0.18);
    transition: background 0.15s, height 0.15s;
  }
  .split-handle:hover::before, .split-handle:active::before {
    background: var(--accent, #89b4fa);
    height: 60px;
  }

  /* CodeMirror text colour — inherits from CSS var so light/dark both work */
  :global(.cm-editor .cm-content) { color: var(--text, #cdd6f4); caret-color: #89b4fa; }
  :global(.cm-editor .cm-line)    { color: var(--text, #cdd6f4); }
  /* Force cursor visible — CM6 theme !important can be unreliable in WebKit */
  :global(.cm-editor .cm-cursor)       { border-left: 2px solid #89b4fa !important; }
  :global(.cm-editor .cm-dropCursor)   { border-left: 2px solid #89b4fa !important; }
  :global(.cm-editor.cm-focused .cm-selectionBackground) { background: rgba(137,180,250,0.25) !important; }
  :global(.cm-editor .cm-cursor-primary) { border-left-color: #89b4fa !important; }

  /* prose / heading cells */
  .prose-cell {
    padding: 6px 8px;
    font-size: 0.95rem;
    color: var(--text, #cdd6f4);
    min-height: 2em;
    outline: none;
    line-height: 1.6;
    text-align: left;
    white-space: pre-wrap;
  }
  /* Rendered markdown view (Shift+Enter on a text cell). */
  .prose-rendered {
    padding: 6px 8px;
    font-size: 0.95rem;
    color: var(--text, #cdd6f4);
    min-height: 2em;
    line-height: 1.6;
    text-align: left;
    cursor: text;
  }
  /* Headings match the notebook's own section/subsection heading cells so a
   * `# Title` / `## Sub` in a text cell renders identically to a section /
   * subsection cell (see h1.heading-cell / h2.heading-cell below). */
  .prose-rendered :global(h1),
  .prose-rendered :global(h2),
  .prose-rendered :global(h3),
  .prose-rendered :global(h4) {
    margin: 0.5em 0 0.3em;
    font-weight: 700;
    line-height: 1.3;
    /* Use --text (the app toggles it for light/dark) rather than inheriting the
     * global h1/h2 color (--text-h), which the manual light toggle does not
     * override — that left rendered headings near-white on a light background. */
    color: var(--text, #cdd6f4);
  }
  .prose-rendered :global(h1) {
    font-size: 1.15rem;
    border-bottom: 1px solid rgba(255,255,255,0.08);
    padding-bottom: 0.3rem;
  }
  .prose-rendered :global(h2) { font-size: 1.0rem; }
  .prose-rendered :global(h3) { font-size: 0.95rem; opacity: 0.9; }
  .prose-rendered :global(h1:first-child),
  .prose-rendered :global(h2:first-child),
  .prose-rendered :global(h3:first-child) { margin-top: 0; }
  .prose-rendered :global(p) { margin: 0.35em 0; }
  .prose-rendered :global(ul),
  .prose-rendered :global(ol) { margin: 0.35em 0; padding-left: 1.4em; }
  .prose-rendered :global(li) { margin: 0.15em 0; }
  .prose-rendered :global(a) { color: var(--accent, #89b4fa); text-decoration: underline; }
  .prose-rendered :global(code) {
    font-family: 'SF Mono', ui-monospace, monospace;
    font-size: 0.88em;
    background: rgba(255,255,255,0.08);
    padding: 0.1em 0.35em;
    border-radius: 4px;
  }
  .prose-rendered :global(pre) {
    background: rgba(255,255,255,0.06);
    padding: 0.6em 0.8em;
    border-radius: 6px;
    overflow-x: auto;
    margin: 0.4em 0;
  }
  .prose-rendered :global(pre code) { background: none; padding: 0; }
  .prose-rendered :global(blockquote) {
    margin: 0.4em 0;
    padding-left: 0.8em;
    border-left: 3px solid rgba(255,255,255,0.18);
    color: var(--text-muted, #a6adc8);
  }
  .prose-rendered :global(hr) { border: none; border-top: 1px solid rgba(255,255,255,0.12); margin: 0.6em 0; }
  .prose-rendered :global(img) { max-width: 100%; border-radius: 6px; margin: 0.3em 0; }
  .prose-rendered :global(table) { border-collapse: collapse; margin: 0.5em 0; font-size: 0.9em; }
  .prose-rendered :global(th),
  .prose-rendered :global(td) { border: 1px solid rgba(255,255,255,0.15); padding: 4px 10px; text-align: left; }
  .prose-rendered :global(th) { background: rgba(255,255,255,0.06); font-weight: 700; }
  .prose-rendered :global(.md-math-display) { margin: 0.6em 0; overflow-x: auto; text-align: center; }
  .prose-rendered :global(.katex) { font-size: 1.05em; }
  .heading-cell {
    padding: 6px 8px;
    margin: 0;
    font-weight: 700;
    color: var(--text, #cdd6f4);
    outline: none;
    text-align: left;
    border: none;
    background: transparent;
    width: 100%;
  }
  h1.heading-cell { font-size: 1.15rem; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 0.3rem; }
  h2.heading-cell { font-size: 1.0rem; }

  .out-label {
    font-size: 0.58rem;
    color: var(--text-muted, #585b70);
    font-family: 'SF Mono', monospace;
    white-space: nowrap;
    line-height: 1;
  }
</style>
