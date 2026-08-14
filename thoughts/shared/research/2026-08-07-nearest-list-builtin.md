---
date: 2026-08-07T10:15:41-04:00
researcher: Michael Sollami
git_commit: 03170b19c9a15b1a2b7a4e555656c8ab8d067e12
branch: perf/clip-packed
repository: mathilda
topic: "How list built-ins are implemented, and what it takes to add Nearest"
tags: [research, codebase, list-builtins, nearest, registration, numeric-comparison, testing, docs]
status: complete
last_updated: 2026-08-07
last_updated_by: Michael Sollami
---

# Research: Implementing a `Nearest` list built-in

**Date**: 2026-08-07T10:15:41-04:00
**Researcher**: Michael Sollami
**Git Commit**: `03170b19c9a15b1a2b7a4e555656c8ab8d067e12`
**Branch**: `perf/clip-packed`
**Repository**: mathilda

## Research Question

How are list built-in functions implemented, so that a `Nearest[list, x]`
built-in (the element of `list` closest to target `x`) can be added? Covering:
where list built-ins live and how one is registered and dispatched; how existing
built-ins compute numeric distance or compare magnitudes, and whether a
canonical absolute-difference helper exists; how they handle empty lists,
non-numeric elements, and ties; and the testing and documentation conventions.
Reference implementations: `Pick`, `SplitBy`, `Subsets`.

## Summary

**`Nearest` is genuinely unimplemented.** No `Nearest` appears anywhere in
`src/`, and a fresh binary returns `Names["Nearest*"]` → `{}`. The two hits in
`tools/numeric_coverage.py:190` and `tools/nd_fastpath_sweep.py:226` are
curated wish-lists of the Mathematica surface, not evidence of implementation.
(A first probe *appeared* to show the symbol existing; that was an artifact of
the probe itself interning `Nearest` before `Names` ran. Verified with an
isolated run.)

The four load-bearing findings:

1. **Adding the file is nearly free, but not entirely.** The top-level
   `makefile:303` globs `src/list/*.c`, so the main build picks up a new file
   automatically. `tests/CMakeLists.txt` does **not** glob — it enumerates all
   32 `src/list/*.c` paths by hand, and omitting the new one breaks every test
   binary at link time.

2. **There is no canonical distance helper. Do not go looking for one.**
   `EuclideanDistance`, `ManhattanDistance`, `abs_diff`, `expr_abs`, and
   `expr_to_double` do not exist. `Norm` exists but is vector/matrix-only. The
   composable primitives that *do* exist and are cross-module callable are
   `internal_subtract` and `internal_abs` (`src/internal.h:121`, `:83`), already
   chained exactly this way in `src/comparisons.c:313-314`.

3. **The ranking idiom already exists and should be copied, not reinvented.**
   `RankedMin`/`RankedMax` in `src/sort.c:890-957` solve a structurally
   identical problem — rank elements by a computed machine-double key, fall back
   to exact `expr_compare`, bail out when an element is not a real number. Its
   `ranked_numeric_key` / `RankedCtx` / `ranked_cmp` trio is the template.

4. **The comparison function you want is `expr_compare`, not `comparisons.c`.**
   The tolerant numeric comparator in `comparisons.c` is `static` and
   unreachable from another module. `expr_compare` (declared `expr.h:243`,
   defined `sort.c:297`) is what `Min`/`Max` actually call.

One incidental finding worth flagging: **`Pick`, `SplitBy`, and `Subsets` are
each undocumented in `docs/spec/builtins/`** — zero heading-level *and* zero
prose matches across the whole tree — despite `CLAUDE.md` requiring a docs entry
per built-in. The three reference implementations named in this research are
themselves out of compliance with the documentation rule. Match the *code*
conventions from them; take the *docs* conventions from `Split` instead.

## Detailed Findings

### Where list built-ins live and how one is registered

`src/list.c` no longer exists; the module was split into `src/list/`, one
built-in per file, with an umbrella header and a registration hub:

| File | Role |
|---|---|
| `src/list/list.h` | Umbrella header re-exporting every per-module header (`src/list/list.h:12-41`) |
| `src/list/list_init.c` | The single registration hub — `list_init()` (`src/list/list_init.c:4`) |
| `src/list/list_common.h` | Shared includes + small predicates (`src/list/list_common.h:1-44`) |
| `src/list/list_common.c` | `is_listq`, `is_infinity`, `is_real_numeric`, … (`src/list/list_common.c:1-50`) |
| `src/list/pick.c`, `splitby.c`, `subsets.c` | The three reference implementations |

Dispatch is a plain name→function-pointer registration. `symtab.h:40` defines
`typedef Expr* (*BuiltinFunc)(Expr* res);` and `symtab.h:175` declares
`void symtab_add_builtin(const char* symbol_name, BuiltinFunc func);`.
`list_init()` is called from `core_init()` at `src/core.c:759`.

The registration triple, as done for `Pick` (`src/list/list_init.c:15-24`):

```c
symtab_add_builtin("Pick", builtin_pick);
symtab_get_def("Pick")->attributes |= ATTR_PROTECTED;
symtab_set_docstring("Pick",
    "Pick[expr, sel]\n\tPicks out the elements of expr for which the\n"
    "\tcorresponding element of sel is True.\n"
    ...);
```

Note the file is internally inconsistent about placement: `Pick`, `Subsets`,
`Riffle`, `Subdivide`, `Catenate`, `Gather`, `MinMax`, and
`DeleteDuplicatesBy` set attributes and docstring inline right after
`symtab_add_builtin`, while older entries (`Table`, `Range`, `Take`, …) defer
their attributes to a block at `src/list/list_init.c:134-173` and their
docstrings to the end. **The inline form is the newer convention** — every
built-in added recently uses it, and it is the one to follow.

#### Symbol interning

`src/sym_names.{h,c}` is three manually-maintained parallel lists, not an
X-macro: an `extern const char* SYM_Foo;` declaration, a `const char* SYM_Foo =
NULL;` definition, and a `SYM_Foo = intern_symbol("Foo");` assignment inside
`sym_names_init()` (`src/sym_names.c:847+`). All three must be kept in sync.

The convention: a `SYM_*` constant exists only for names compared by *pointer
identity* in C. A built-in's own name does **not** need one — `symtab_add_builtin`
takes a plain string. `SYM_Nearest` is therefore unnecessary. `SYM_DistanceFunction`
**is** needed if the `DistanceFunction -> f` option is supported, since option
parsing compares the option key by pointer.

### How existing built-ins compare magnitudes

#### `Min`/`Max` — the closest existing analogue

`src/list/minmax.c` does not implement its own ordering. It triages arguments
into three buckets:

- Packed/NDArray input delegates to `ndred_min`/`ndred_max`
  (`src/list/minmax.c:53`, `:188`).
- Elements passing `is_real_numeric` reduce pairwise via **`expr_compare`**
  (`src/list/minmax.c:126`, `:261`).
- Non-numeric arguments are carried through symbolically as `unique_args`,
  deduplicated only by structural `expr_eq` (`src/list/minmax.c:140`, `:275`).
  If anything remains undecided, the result is a simplified-but-unevaluated
  `Min[...]`, or `NULL` if nothing changed.

`Infinity`/`-Infinity` are special-cased directly (`src/list/minmax.c:135`,
`:246`, `:270`), and `Overflow[]` short-circuits (`:110`, `:245`).

`MinMax[list]` (`src/list/minmax.c:12-40`) is literally `{Min[list], Max[list]}`
— it deliberately does not reimplement anything, "keeping the numeric handling
in exactly one place." That is the design instinct to carry into `Nearest`.

#### `expr_compare` vs the `comparisons.c` comparator

Two different comparison regimes exist and they are not interchangeable:

| | `expr_compare` | `compare_numeric` |
|---|---|---|
| Declared | `expr.h:243` | nowhere — `static` |
| Defined | `sort.c:297` | `comparisons.c:100-169` |
| Callable cross-module | **yes** | **no** |
| Symbolic operands | total order (numbers sort before symbols, `sort.c:379-380`) | sets `*can_compare = false` |
| Float equality | exact | tolerant, `2^-46` relative zero band (`comparisons.c:157-168`) |
| NaN | — | IEEE-unordered special case (`:197-211`) |

`comparisons.h:1-19` exports only the built-in entry points
(`builtin_less`, `builtin_equal`, …) plus `comparisons_init`. There is no
exported numeric-compare helper. If tolerant `Less[]` semantics are genuinely
needed, the only route is constructing and evaluating a `Less[a, b]` expression.
For `Nearest`, `expr_compare` is the right and available choice.

#### Absolute difference: the composition to use

Confirmed absent: `EuclideanDistance`, `ManhattanDistance`, `abs_diff`,
`expr_abs`, `numeric_abs`, `expr_to_double`. `Norm` exists
(`src/linalg/linalg.c:24`, reusable as `internal_norm`, `src/internal.h:47`) but
is a vector/matrix norm, not a two-point distance. `Chop` (`src/core.c:293`) and
`Clip` (`src/core.c:295`) are unrelated.

What exists and is reusable:

```c
Expr* internal_abs(Expr** args, size_t count);       /* src/internal.h:83  */
Expr* internal_subtract(Expr** args, size_t count);  /* src/internal.h:121 */
static inline Expr* eval_and_free(Expr* e);          /* src/eval.h:129     */
```

The precedent for chaining them is `src/comparisons.c:313-314`, computing `a - b`
for the `Equal` zero-test fallback:

```c
Expr* diff = eval_and_free(
    internal_subtract((Expr*[]){ expr_copy(a), expr_copy(b) }, 2));
```

`Abs[Subtract[candidate, x]]` per candidate is the composition. There is no
single call that returns a distance as a `double`.

#### Coercing an expression to a machine double

There is no exported `expr_to_double`. `numericalize(const Expr* e, NumericSpec
spec)` (`numeric.h:139`) is the workhorse, returning a fresh numeric `Expr*`;
callers then read `->data.real`. Every module needing a raw double writes the
same four-line pattern locally — `comparisons.c:24-67` and `sort.c:898-914` are
two independent file-static instances of it.

#### The `RankedMin`/`RankedMax` template

`src/sort.c:890-957` is the structurally closest existing code and worth reading
in full before writing `Nearest`. Three pieces:

`ranked_numeric_key` (`sort.c:898-914`) — a machine-double key per element:

```c
static bool ranked_numeric_key(Expr* e, double* out) {
    if (is_infinity(e)) { *out = HUGE_VAL; return true; }
    if (is_minus_infinity(e)) { *out = -HUGE_VAL; return true; }
    Expr* nv = is_real_numeric(e) ? NULL : numericalize(e, numeric_machine_spec());
    Expr* v = nv ? nv : e;
    bool ok = false;
    if (is_real_numeric(v)) {
        Expr* re; Expr* im;
        *out = is_complex(v, &re, &im) ? get_numeric_value(re) : get_numeric_value(v);
        ok = true;
    }
    if (nv) expr_free(nv);
    return ok;
}
```

Its `false` return is documented as "the signal that RankedMin has no definite
result and must stay unevaluated" — directly reusable policy for a `Nearest`
handed a free symbol.

`RankedCtx` + `ranked_cmp` (`sort.c:921-933`) — dual-path comparator: the
double-key path when keys are available, exact `expr_compare` otherwise, with
**original index as the stable tiebreak**:

```c
return (i < j) ? -1 : 1;   /* stable: original position breaks value ties */
```

That is the existing answer to the tie question, and it matches Mathematica's
`Nearest`, which returns all tied elements in original order.

`ranked_select_idx` (`sort.c:938-957`) — O(m)-average quickselect with an
explicit `size_t` underflow guard. For `Nearest` returning a single element a
linear min-scan is simpler and adequate; the quickselect matters only if an
`n`-nearest form is added.

### Edge-case conventions, read off the reference implementations

The governing rule is the ownership contract in `SPEC.md §4`: a built-in takes
ownership of `res`, returns a fresh `Expr*` on success, or `NULL` to leave the
call unevaluated — and must **not** free `res` in the `NULL` case.

**Arity and type guards come first, and always return `NULL`.** All three
reference files open the same way:

```c
if (res->type != EXPR_FUNCTION) return NULL;
size_t argc = res->data.function.arg_count;
if (argc < 2 || argc > 3) return NULL;              /* pick.c:83-85    */
```
```c
if (list->type != EXPR_FUNCTION) return NULL;       /* atoms have no elements */
                                                    /* splitby.c:91, subsets.c:226 */
```

**Empty lists are handled, not rejected — and the answer is head-preserving.**
`splitby_level` yields an empty expression for `n == 0`, so `SplitBy[{}, f]` is
`{}` (`splitby.c:50`). `Subsets[{}]` is `{{}}`. `Min[]` is `Infinity`
(`minmax.c:45`); `Max[]` is `-Infinity` (`minmax.c:180`). For `Nearest`, an
empty list has no nearest element, so `{}` is the natural answer — Mathematica
agrees.

**Partial results are never returned.** `Pick`'s header comment is explicit
(`pick.c:15-20`): a mismatch found arbitrarily deep aborts the whole call rather
than yielding a partially picked result. The `bool* ok` out-parameter threaded
through `pick_rec` exists solely to enforce this, and the unwind frees every
already-kept element (`pick.c:67-69`).

**"Well-formed but selects nothing" is distinguished from "not a spec at all."**
`Subsets` encodes this as a three-valued enum (`subsets.c:69-73`):

```c
typedef enum {
    LEN_OK,     /* a usable subset length was read into *out */
    LEN_NONE,   /* a well-formed but negative length: selects no subsets */
    LEN_BAD     /* not a length at all: leave the expression unevaluated */
} LenStatus;
```

`LEN_NONE` produces an empty result; `LEN_BAD` returns `NULL`. Worth mirroring
if `Nearest` grows a count argument.

**The head comes from the input, never invented.** `Pick[f[a,b,c], {True,
False, True}]` is `f[a, c]` (`pick.c:12-13, 76-77`); `Subsets[f[a,b]]` gives
`f[]`-headed sublists under a `List` wrapper (`subsets.c:17-19, 270`). For
`Nearest`, the returned wrapper should be `List` and the elements copied
verbatim.

**Non-numeric elements: the `Min`/`Max` precedent is to stay symbolic;
the `RankedMin` precedent is to bail.** These differ, and the choice is a real
design decision. `Min` carries symbolic arguments through and returns a
partially-simplified unevaluated form; `RankedMin` returns `NULL` the moment
`ranked_numeric_key` fails. `RankedMin`'s policy is simpler and better matches
`Nearest`, where a partially-ordered answer is meaningless.

**Memory discipline.** All three files use the same shapes: a `malloc`'d
`Expr**` scratch vector sized to the upper bound, filled with `expr_copy`, handed
to `expr_new_function`, then the *vector* freed (not its contents) —
`pick.c:76-78`, `splitby.c:79-81`, `subsets.c:291-292`. `Subsets` additionally
carries a growable `SubsetBuf` with a `subsets_buf_free` unwind path
(`subsets.c:38-63`), used on every failure exit.

### Options handling (`DistanceFunction -> f`)

`src/options_builtin.c` implements the generic `Options[]`/`SetOptions[]`/
`OptionValue[]` machinery used with `OptionsPattern[]` on a rule LHS. That is
*not* the pattern list built-ins use. Every C built-in that reads its own option
hand-rolls a scan of trailing `Rule[...]` arguments. The template, from the same
directory (`src/list/setops.c:382-400`, `builtin_union`):

```c
Expr* same_test = NULL;
size_t last_arg = res->data.function.arg_count;
for (size_t i = 0; i < res->data.function.arg_count; i++) {
    Expr* arg = res->data.function.args[i];
    if (arg->type == EXPR_FUNCTION && arg->data.function.head->type == EXPR_SYMBOL &&
        arg->data.function.head->data.symbol.name == SYM_Rule &&
        arg->data.function.arg_count == 2 &&
        arg->data.function.args[0]->type == EXPR_SYMBOL &&
        arg->data.function.args[0]->data.symbol.name == SYM_SameTest) {
        same_test = arg->data.function.args[1];
        if (i < last_arg) last_arg = i;
    }
}
if (last_arg == 0) return NULL;
```

`last_arg` marks how many leading arguments are positional once trailing options
are stripped. The same shape repeats at `src/list/matrixq.c:144`, `:280`,
`src/list/accumulate.c:27`, `src/calculus/integrate.c:444`, and elsewhere. No
shared helper exists — each site re-implements the scan.

Applying a user-supplied distance function follows `splitby_key`
(`splitby.c:31-37`), the canonical "call a function on an element" idiom:

```c
static Expr* splitby_key(Expr* f, Expr* e) {
    Expr* args[1] = { expr_copy(e) };
    Expr* call = expr_new_function(expr_copy(f), args, 1);
    Expr* key = evaluate(call);
    expr_free(call);
    return key;
}
```

### Testing conventions

Tests live in `tests/test_list.c` — a single multi-built-in file covering `Pick`,
`SplitBy`, `Subsets`, `Riffle`, `Subdivide`, `Min`, `Max`, `Gather`, and more.
The right move for `Nearest` is to **add `test_nearest()` there and register it
in `main()`** — no CMake change, since `list_tests` already compiles that file.

Two harness styles coexist; both are idiomatic. `test_pick`
(`tests/test_list.c:447-498`) uses the manual form — a `{input, expected}` string
table, then `parse_expression` → `evaluate` → `expr_to_string` → `strcmp`, with
`ASSERT(0)` on mismatch and explicit frees. `test_splitby`, `test_subsets`,
`test_riffle`, and `test_subdivide` use the shared helper
`assert_eval_eq(input, expected, is_fullform)` (`tests/test_utils.h:18-30`),
which does the same internally. **The helper form is preferable for new tests.**

Registration is one line in `main()` (`tests/test_list.c:965-1022`), after the
process-wide `symtab_init(); core_init(); trig_init();`. `TEST(name)` is
`tests/test_utils.h:52`.

Note `tests/test_utils.h:54-57`: plain libc `assert()` is stripped under
`-DNDEBUG` in Release builds. New test bodies should use the `ASSERT` /
`ASSERT_STR_EQ` / `ASSERT_MSG` macros (`tests/test_utils.h:74-99`), which
`exit(1)` unconditionally. (`assert_eval_eq` internally uses `assert` and is a
known accepted exception.)

Edge cases are covered as ordinary table rows, and the expected-string-equals-
input-string idiom is how unevaluated return is asserted:

```c
{"Pick[{}, {}]", "{}"},                                     /* empty      :456 */
{"Pick[a, {True}]", "Pick[a, {True}]"},                     /* atom       :479 */
{"Pick[{a, b}, sel]", "Pick[{a, b}, sel]"},                 /* symbolic   :480 */
{"SplitBy[{1, 2}]", "SplitBy[{1, 2}]"},                     /* arity      :661 */
{"Attributes[Pick]", "{Protected}"},                        /* attributes :482 */
```

`Subsets` also demonstrates a performance assertion — the test passing at all is
the claim (`tests/test_list.c:860-862`):

```c
/* PERFORMANCE: the 3-argument form must generate lazily. A 40-element
 * list has 2^40 subsets; materializing them would never finish, so
 * this returning promptly is itself the assertion. */
{"Subsets[Range[40], All, 5]", "{{}, {1}, {2}, {3}, {4}}"},
```

There is no `.m` regression suite for list built-ins. The one `.m` corpus,
`tests/fullsimplify_corpus.m`, is a data file driven by a C runner and is
specific to `FullSimplify`.

### Documentation conventions

- **Category file**: `docs/spec/builtins/lists-and-iteration.md`, per the index
  row at `Mathilda_spec.md:47`.
- **Changelog**: today is Friday 2026-08-07, inside the ISO week beginning
  Monday **2026-08-03**. `docs/spec/changelog/2026-08-03.md` **already exists** —
  append a `## Feature: Nearest (2026-08-07)` section rather than creating a file.
- **`Mathilda_spec.md` changelog table**: the row for `2026-08-03 → 2026-08-09`
  **already exists** at `Mathilda_spec.md:83`. No new row needed.

The entry format, per `Tuples` in the target file
(`docs/spec/builtins/lists-and-iteration.md:29-42`) and `Split` in
`docs/spec/builtins/structural-manipulation.md:373-392`: a `## Name` heading,
one-line description, bulleted call signatures in backticks, a `**Features**:`
list opening with the attributes, then a fenced ```` ```mathematica ```` block of
`In[n]:=` / `Out[n]=` pairs. Cross-references use
`` [`OtherFn`](file.md#anchor) ``.

`Split`'s entry is the better model for `Nearest` than `Tuples`, because it
demonstrates the "how this differs from its near neighbour" bullet:

```
382:- Only *adjacent* elements are grouped. To collect equal elements from anywhere
383:  in the list, use [`Gather`](data-structures.md#gather):
384:  `Split[{a, b, a}]` gives `{{a}, {b}, {a}}` where `Gather` gives `{{a, a}, {b}}`.
```

### Build and gate impact

**Main build**: no action. `makefile:303` globs `$(wildcard $(SRC_DIR)/list/*.c)`,
and `-I./src/list` is already on `CFLAGS` (`makefile:56`).

**Test build**: action required. `tests/CMakeLists.txt` enumerates all 32
`src/list/*.c` paths individually in `COMMON_SRC` (`tests/CMakeLists.txt:341-372`).
Omitting `../src/list/nearest.c` breaks every test binary at link time, since all
of them link the shared `mathilda_common` OBJECT library
(`tests/CMakeLists.txt:750`).

**Static/curated gates — no action.** `make check-packed-aware` diffs NDArray
dispatch sites in source against `src/pack.c`'s `AWARE` list; a `Nearest` with no
buffer dispatch is invisible to it. `make check-array-exactness` and `make
check-nd-surfaces` run fixed curated probe sets that do not include `Nearest`.
`make check-compile-coverage` scopes to heads registering an ndarray kernel.

**`make check-fastpath-sweep` — the one that will see it.** The sweep enumerates
`Names["*"]` and discovers call shapes by trial, so it will find `Nearest` the
moment it is registered and the binary is rebuilt. If it measures the head as
both expensive per element and indifferent to whether its input was packed, it
fails as a newly-off-buffer head. Two remedies: give `Nearest` a real packed
fast path (and then add it to `AWARE` in `src/pack.c`), or add `"Nearest"` to the
`OFF_BUFFER` set at `tools/nd_fastpath_sweep.py:608` to acknowledge the gap.

Note that `Nearest` already appears in `SKIP_EXPLOSIVE`
(`tools/nd_fastpath_sweep.py:226`), listed under "Output quadratic or worse in
the input length" — that classification anticipates the all-pairs `Nearest[list]`
form, not `Nearest[list, x]`. Whether that skip pre-empts the `OFF_BUFFER`
question cannot be determined until the sweep runs against a real implementation.

## Code References

- `src/list/list_init.c:4` — `list_init()`, the registration hub
- `src/list/list_init.c:15-24` — `Pick` registration triple (the modern inline convention)
- `src/list/list.h:12-41` — umbrella header include block
- `src/list/list_common.h:42` — `is_real_numeric`, the numeric-element predicate
- `src/list/pick.c:15-20` — the "never a partial result" contract, stated
- `src/list/pick.c:37-80` — `bool* ok` error threading with unwind
- `src/list/splitby.c:31-37` — `splitby_key`, the canonical apply-a-function idiom
- `src/list/splitby.c:50` — empty-input handling yielding `{}`
- `src/list/subsets.c:69-73` — `LenStatus`, the three-valued spec decode
- `src/list/subsets.c:38-63` — `SubsetBuf` growable buffer + unwind
- `src/list/minmax.c:126`, `:261` — `expr_compare` as the magnitude comparator
- `src/list/minmax.c:45`, `:180` — `Min[]`/`Max[]` empty-input answers
- `src/list/setops.c:382-400` — the trailing-`Rule[]` option-scan template
- `src/sort.c:297` — `expr_compare` definition (declared `expr.h:243`)
- `src/sort.c:898-914` — `ranked_numeric_key`, the machine-double key helper
- `src/sort.c:921-933` — `RankedCtx`/`ranked_cmp`, dual-path compare + stable tiebreak
- `src/sort.c:938-957` — `ranked_select_idx` quickselect
- `src/comparisons.c:100-169` — `compare_numeric` (static, not reusable)
- `src/comparisons.c:313-314` — the `internal_subtract` + `eval_and_free` precedent
- `src/internal.h:83`, `:121` — `internal_abs`, `internal_subtract`
- `src/eval.h:129` — `eval_and_free`
- `src/numeric.h:139` — `numericalize`
- `src/symtab.h:40`, `:175` — `BuiltinFunc` typedef, `symtab_add_builtin`
- `src/core.c:759` — `list_init()` call site
- `src/sym_names.c:847+` — `sym_names_init()`
- `tests/test_list.c:447-498` — `test_pick`, the manual harness style
- `tests/test_list.c:877-916` — `test_riffle`, the `assert_eval_eq` style
- `tests/test_list.c:965-1022` — `main()` and `TEST()` registration
- `tests/test_utils.h:18-30` — `assert_eval_eq`
- `tests/test_utils.h:54-57`, `:74-99` — the `NDEBUG` warning and `ASSERT` macros
- `tests/CMakeLists.txt:341-372` — the enumerated `src/list/*.c` block
- `tests/CMakeLists.txt:802-803` — `list_tests` target
- `makefile:303` — `SRC` wildcard
- `docs/spec/builtins/lists-and-iteration.md:29-42` — `Tuples` entry format
- `docs/spec/builtins/structural-manipulation.md:373-392` — `Split` entry format
- `Mathilda_spec.md:47`, `:83` — category index row, current-week changelog row
- `tools/nd_fastpath_sweep.py:226`, `:608` — `SKIP_EXPLOSIVE`, `OFF_BUFFER`

## Architecture Insights

**One built-in per file, one registration hub.** The `src/list.c` monolith was
split into `src/list/` with a `list_common.h` that reproduces the old file's
include set, so each module needs only that header plus its own. New built-ins
follow the split, not the monolith.

**Ownership is the load-bearing invariant.** The `NULL`-means-unevaluated
convention doubles as the error channel: every guard failure, unsupported spec,
and allocation failure funnels to the same `return NULL`, and the evaluator's
retained ownership of `res` makes that safe. `Pick`'s `bool* ok` thread exists
because recursion cannot express that with a return value alone.

**Two comparison regimes, deliberately separated.** `expr_compare` is a *total
order* used for sorting and canonicalization — symbols are simply "greater" than
numbers. `comparisons.c`'s `compare_numeric` is a *partial* numeric predicate
that reports "cannot decide" and applies float tolerance. Keeping the latter
`static` is the enforcement mechanism: a module reaching for tolerant comparison
must go through `Less[]` evaluation and inherit its unevaluated-on-symbolic
semantics rather than silently getting a different answer.

**Composition over new primitives.** The absence of a distance helper is
consistent: `MinMax` composes `Min` and `Max` rather than reimplementing; the
`Equal` zero-test composes `Subtract` and `Abs`. A new `expr_distance` primitive
would cut against this. `Abs[Subtract[a, b]]` via the `internal_*` wrappers is
the idiomatic construction.

**Gates are ratchets, not assertions.** `OFF_BUFFER` and `BASELINE` carry the
known backlog so a check fails only on *newly* regressed heads. `SPEC.md §9`
states the reasoning outright: "A gate that fails on its whole standing backlog
from the day it lands stops being read within a week."

**The docs rule is not currently self-enforcing.** `Pick`, `SplitBy`, and
`Subsets` all carry complete file-header comments and thorough `symtab_set_docstring`
text, yet none appears in `docs/spec/builtins/`. The in-code documentation
discipline held; the external-docs step silently did not. Nothing in the build
or the check suite catches this — the only gate is the `CLAUDE.md` instruction.

## Historical Context (from thoughts/)

`thoughts/` contains only `.gitkeep` placeholders under `shared/research/`,
`shared/plans/`, `shared/handoffs/`, and `shared/tickets/`. No prior notes on
`Nearest` or nearest-neighbour work exist. This is the first document in the
directory.

## Related Research

None — this is the first research document in `thoughts/shared/research/`.

## Open Questions

1. **Which non-numeric policy?** `Min`'s carry-symbolics-through versus
   `RankedMin`'s return-`NULL`. `RankedMin`'s is recommended, but it is a real
   semantic choice and Mathematica's own behaviour with a `DistanceFunction`
   over symbolic elements should be checked before committing.

2. **Scope of the first implementation.** Mathematica's `Nearest` surface is
   large: `Nearest[list, x]`, `Nearest[list, x, n]`, `Nearest[list, x, {n, r}]`,
   `Nearest[list -> vals, x]`, `Nearest[list]` (all-pairs, the form that earned
   the `SKIP_EXPLOSIVE` entry), and `NearestTo[x]` as an operator form. Only
   `Nearest[list, x]` was asked for; the `LenStatus`-style decode in
   `subsets.c` is the pattern if the `n` argument is added later.

3. **Does the fast-path sweep's `SKIP_EXPLOSIVE` entry pre-empt `OFF_BUFFER`?**
   `Nearest` is already listed as explosive-output, which may exclude it from the
   timing half entirely. Resolvable only by running `make check-fastpath-sweep`
   against a built implementation.

4. **Should the `Pick`/`SplitBy`/`Subsets` docs gap be closed alongside?**
   Out of scope for a `Nearest` change, but the three built-ins being used as
   reference implementations are themselves undocumented, and a `Nearest` entry
   in `lists-and-iteration.md` will want to cross-reference at least `Min`/`Max`
   and possibly `Position`.

5. **Ties.** `ranked_cmp`'s stable-index tiebreak returns tied elements in
   original order, matching Mathematica. But Mathematica's `Nearest[{1, 3}, 2]`
   returns **both** `{1, 3}` — a plain min-scan returning one element would
   differ. Whether to return all tied elements determines whether the
   implementation is a single-pass min or a two-pass (find min distance, then
   collect all equal to it).
