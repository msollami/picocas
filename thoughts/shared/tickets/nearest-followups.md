# `Nearest` follow-ups (F1–F6)

**Filed**: 2026-08-07
**Parent plan**: `thoughts/shared/plans/2026-08-07-nearest-two-arg.md`
**Parent research**: `thoughts/shared/research/2026-08-07-nearest-list-builtin.md`

The two-argument `Nearest[list, x]` shipped 2026-08-07 (`src/list/nearest.c`).
These are the deliberately-excluded pieces of the Mathematica surface, each
scoped so it can land independently. Every one should carry an acceptance table
in the style of the parent plan — anything the table cannot check is not spec.

---

## F1 — `Nearest[list, x, n]`, the n-nearest form

Return the `n` elements closest to `x`, ascending by distance.

Notes for the implementer:
- This is where selection starts to pay. The current implementation is a
  two-pass linear min; for `n`-nearest, `ranked_select_idx`
  (`src/sort.c:938-957`) becomes the right tool — and here `ranked_cmp`'s
  original-index tiebreak (`src/sort.c:932`) is *correct*, because a strict
  order is exactly what quickselect needs. That is the opposite of the
  two-argument case, where the tiebreak had to be avoided.
- Mathematica returns *more* than `n` elements when there is a tie at the
  boundary. Decide that explicitly and put it in the table; it is the same class
  of question that row 1 of the parent plan settled.
- Row 17 of the parent acceptance table (`Nearest[{1, 5}, 3, 2]` unevaluated)
  changes when this lands. That row exists so the change is visible as a diff.

## F2 — `Nearest[list, x, {n, r}]` and `{All, r}`, the radius forms

Restrict to elements within radius `r`, optionally capped at `n`.

- The `LenStatus` three-valued decode in `src/list/subsets.c:69-73` is the
  pattern for "well-formed but selects nothing" (empty result) versus "not a
  spec at all" (unevaluated). A radius of 0, a negative radius, and a symbolic
  radius are three distinct cases.

## F3 — `Nearest[list -> vals, x]` and `Nearest[list -> Automatic, x]`

Return the *values* paired with the nearest keys, rather than the keys.

- `Automatic` yields the positions. Both need a length-agreement check between
  `list` and `vals`; `Pick`'s "structural disagreement is not an error, return
  unevaluated" contract (`src/list/pick.c:15-20`) is the precedent.

## F4 — `Nearest[list]`, the all-pairs form

Nearest neighbour of every element.

- Already classified quadratic-output in `tools/nd_fastpath_sweep.py:226`
  (`SKIP_EXPLOSIVE`), which is what that entry was anticipating — not the
  two-argument form that shipped.
- Naive is O(n²). Worth checking whether the sweep's skip should be narrowed to
  this form specifically once F1–F3 exist.

## F5 — `NearestTo[x]` operator form, and a packed/NDArray fast path

Two separable pieces, filed together because they share the dispatch question.

**Operator form**: `NearestTo[x][list]`. The pattern is
`maximal_minimal_by`'s `argc == 1` arm (`src/sort.c:667-675`), which builds a
`Function[Slot[1]]` wrapper.

**Buffer path**: today a *packed* list is materialised on the way in (correct
but not fast), and a *visible* `NDArray` stays unevaluated — parent acceptance
row 20.

> **The sweep will not tell you when this regresses or improves.** Resolved
> 2026-08-07, answering open question 3 of the parent plan: `"Nearest"` is in
> `SKIP_EXPLOSIVE` (`tools/nd_fastpath_sweep.py:226`), which filters heads out
> at the *discovery* phase of `gate_main` (`:691-692`), before any probe is
> generated. Verified by running `--gate-only --only Nearest,MinimalBy,Min`:
> it reported "discovering 24 shapes over 3 heads", and 24 = 12 `SHAPES` × **2**
> unskipped heads, so `Nearest` produced zero probes. The gate's silence about
> `Nearest` is exclusion, not verification, and adding it to `OFF_BUFFER` would
> be meaningless because the head is never measured. Anyone doing this work
> needs their own before/after timing; the standing gate is blind here.
>
> The `SKIP_EXPLOSIVE` entry predates the implementation and was aimed at the
> all-pairs form (F4), whose output really is quadratic. Narrowing it so the
> two-argument form becomes measurable is worth considering as part of this
> follow-up.

Giving `Nearest` a real buffer path means:
- the kernel itself,
- an entry in `src/pack.c`'s `AWARE` list (else `make check-packed-aware`
  fails),
- `make check-nd-surfaces` agreement across plain / packed / visible-NDArray,
- deleting `"Nearest"` from `OFF_BUFFER` in `tools/nd_fastpath_sweep.py` if it
  was added there.

Row 20 changes when this lands.

## F6 — `DistanceFunction -> f`, and the symbolic-real element path

Two changes to what counts as a distance.

**Option**: `Nearest[list, x, DistanceFunction -> f]` uses `f[element, x]`.
- Needs `SYM_DistanceFunction` in `src/sym_names.{h,c}` (three parallel sites:
  extern declaration, `NULL` definition, `intern_symbol` assignment inside
  `sym_names_init()`).
- Parse with the trailing-`Rule[]` scan template at
  `src/list/setops.c:382-400`, not the generic `options_builtin.c` machinery —
  that is the convention for a builtin reading its own option in C.
- Applying `f` follows `splitby_key` (`src/list/splitby.c:31-37`).

**Symbolic reals**: today `Nearest[{Pi, 4}, 3]` is unevaluated, because
`Abs[Pi - 3]` stays as `Abs[-3 + Pi]` and the gate rejects it (parent
acceptance row 15). `RankedMin`'s `ranked_numeric_key`
(`src/sort.c:898-914`) *does* handle this, by running the value through
`numericalize(e, numeric_machine_spec())`.

Adopting that here is a real behaviour change, not a widening:
- It introduces a machine-double comparison where the current code compares
  exact expressions, so it must not regress parent acceptance row 5
  (`Nearest[{1/3, 2/3}, 1/2]` → both). Keep the exact path when every distance
  is already `is_real_numeric` and use the double key only as a fallback —
  which is precisely what `ranked_select` does at `src/sort.c:976-986`.
- `Infinity` / `-Infinity` map to `±HUGE_VAL` there and would start working.
- Row 15 changes when this lands.
