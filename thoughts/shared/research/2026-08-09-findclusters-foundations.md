---
date: 2026-08-09T00:00:00-04:00
researcher: Michael Sollami
git_commit: b487bc67
branch: feat/nearest
repository: mathilda
topic: "Foundations a FindClusters[list] builtin must stand on, as of the PR 53 rebase"
tags: [research, codebase, findclusters, nearest, numeric-comparison, nested-lists, registration, verification]
status: complete
last_updated: 2026-08-09
last_updated_by: Michael Sollami
---

# Research: foundations for a `FindClusters` builtin (1D numeric lists)

**Date**: 2026-08-09
**Researcher**: Michael Sollami
**Git commit**: `b487bc67` — *Nearest[list, x]: the closest element(s), with all ties returned*
**Branch**: `feat/nearest` (rebased onto `origin/main` `4ca795d4`; PR #53 open against `stblake/mathilda`)
**Working tree**: clean across `src/`, `tests/`, `docs/`

## Research question

Document everything a `FindClusters[list]` plan needs, as the code exists today:
the numeric comparison machinery from the `Nearest` work and how another builtin
would call it; registration and dispatch; nested-list construction and freeing;
how each numeric type flows through comparison; the `builtin_abs` landmine; the
stay-unevaluated pattern; existing primitives whose result shape clustering
should model; and where the verification harness lives.

## Summary — the five findings that shape the plan

1. **The Nearest numeric machinery is not callable. All four helpers are
   `static`.** `nearest.h` exports exactly one symbol, `builtin_nearest`.
   `FindClusters` cannot call `nearest_sign`, `nearest_cmp`, or
   `nearest_is_real_number` as the tree stands. **This is the first decision the
   plan must make** — promote them to a shared header, or duplicate them. See
   §1.3 for the recommendation.

2. **`expr_compare` must not be used to compare numeric values**, and the reason
   is not stylistic. It is wrong in both directions and each direction is a
   silent wrong answer. This is the bug that shipped in `Nearest` and was caught
   in review. §1.1.

3. **`Abs` is a landmine for exact rationals.** `builtin_abs` falls through to
   `return NULL` for any `Rational` with a bigint component (`src/complex.c:418-421`);
   `Sign` and `expr_numeric_sign` have the same gap. `Nearest` inherits it and
   declines on `Nearest[{1/10^25, 1}, 0]`. **A clustering function that computes
   gaps via `Abs` inherits it too** — and it does not have to. §4.

4. **There is no single nested-result convention to copy.** Six surveyed
   builtins split three ways on head preservation and four ways on empty input.
   The plan must *pick* and state which precedent it follows. §3.

5. **Only one check target will see a new builtin automatically**:
   `check-fastpath-sweep`, which discovers heads by trial from `Names["*"]`.
   Unlike `Nearest` (excluded via `SKIP_EXPLOSIVE`), a linear-output
   `FindClusters` **will** be discovered and gated, and will fail the ratchet
   unless given a fast path or added to `OFF_BUFFER`. §6.3.

---

## 1. The numeric comparison machinery

### 1.1 What `Nearest` replaced, and why — `sort.c:372-377`

`expr_compare` (declared `src/expr.h:243`, defined `src/sort.c:297`) is a
*canonical total order* for sorting and dedup, not a numeric comparison. Its
numeric-atom block ends:

```c
        double va = get_numeric_value(a);
        double vb = get_numeric_value(b);
        if (va < vb) return -1;
        if (va > vb) return 1;
        if (a->type != b->type) return (int)a->type - (int)b->type;   /* sort.c:376 */
        return 0;
```

Two independent defects for value comparison, each a silent wrong answer:

- **Equal values compare non-zero** (`sort.c:376`). The type-enum tiebreak means
  distances `1` (`EXPR_INTEGER`) and `1.0` (`EXPR_REAL`) are *not* equal.
  `Nearest[{0, 2.0}, 1]` answered `{0}` instead of `{0, 2.0}` — a tied element
  silently dropped from the one function whose contract was to return them all.
- **Unequal values compare zero** (`sort.c:372-374`). For atoms not both
  integer-like it compares `get_numeric_value()` **doubles**, so two exact
  rationals differing below double resolution tie.
  `Nearest[{1/3, 1/3 + 1/10^18}, 0]` returned both.

The integer-like path above it *is* exact (`mpz_cmp` via `expr_to_mpz`,
`sort.c:365-371`), so the trap only springs on mixed or non-integer types —
which is exactly why a same-type-only test table missed it.

**For the plan**: any gap/distance/threshold comparison in `FindClusters` must
not go through `expr_compare`. `Sort`-ing the input first is fine —
`expr_compare` is correct *as an ordering* — but the cluster-boundary decision
is a value comparison and needs the machinery below.

### 1.2 What replaced it — `src/list/nearest.c:62-146`

Three helpers, all file-static:

| Helper | Line | Contract |
|---|---|---|
| `nearest_is_real_number(Expr*)` | `nearest.c:69-77` | bigint-aware real gate; `bool` |
| `nearest_sign(Expr*, bool* ok)` | `nearest.c:86-114` | −1/0/+1, `*ok=false` if unreadable |
| `nearest_cmp(Expr*, Expr*, bool* ok)` | `nearest.c:131-146` | −1/0/+1 by numeric value |

`nearest_cmp` is the load-bearing one. Two same-type fast paths (INTEGER/INTEGER,
REAL/REAL) avoid allocating; everything else subtracts and reads the sign:

```c
    Expr* sub_args[2] = { expr_copy(a), expr_copy(b) };
    Expr* diff = eval_and_free(internal_subtract(sub_args, 2));
    int s = nearest_sign(diff, ok);
    expr_free(diff);
    return s;
```

Subtraction is exact where it must be and inexact only where the input already
was: `1 - 1.0` is `0.0` (a genuine tie), `1/3 - (1/3 + 1/10^18)` is the exact
`Rational[-1, 10^18]`. Verified against the binary.

The `bool* ok` out-parameter is the point of `nearest_sign` and is not
cosmetic. `expr_numeric_sign` (`src/arithmetic.c:273-294`) returns a bare `0`
for *both* "genuinely zero" and "I do not recognise this", and recognises
neither `MPFR` nor a bigint-component `Rational` — so substituting it would
silently report a **tie** for values it could not read. For a clustering
function, an unreadable comparison reported as "equal" merges two clusters that
should be separate.

### 1.3 How another builtin would call it — it currently cannot

Verified on disk:

```
src/list/nearest.c:55   static Expr* nearest_distance(...)
src/list/nearest.c:69   static bool  nearest_is_real_number(...)
src/list/nearest.c:86   static int   nearest_sign(...)
src/list/nearest.c:131  static int   nearest_cmp(...)
src/list/nearest.c:148  Expr* builtin_nearest(Expr* res)     <- the only non-static
```

and `src/list/nearest.h` declares only `Expr* builtin_nearest(Expr* res);`.

**Three options, with the trade-off stated:**

**(a) Promote to `list_common.{h,c}` — recommended.** That file is already the
shared home for exactly this kind of predicate (`is_listq`, `is_infinity`,
`is_real_numeric`, `make_minus_infinity` — `src/list/list_common.h:30-42`), and
every `src/list/*.c` module includes it. Moving `nearest_is_real_number`,
`nearest_sign`, and `nearest_cmp` there under neutral names (e.g.
`list_real_number_q`, `list_numeric_sign`, `list_numeric_cmp`) makes them
callable with no new include and no duplication. Cost: it touches `nearest.c`,
which is in an open unreviewed PR — either fold it into #53 or land it as a
follow-up refactor first.

**(b) Duplicate into `find_clusters.c`.** Zero risk to #53, but forks a subtle
comparator whose bug history is documented above. The `bool* ok` discipline and
the bigint-rational recursion are precisely the details that get dropped in a
copy. Not recommended.

**(c) Export from `nearest.h` as-is.** Works, but puts general numeric helpers
behind a header named for one builtin, and every future caller then includes
`nearest.h` to compare two numbers.

Note the same problem exists one level down: `is_atomic_numeric` and
`get_numeric_value` are both **`static` in `sort.c`** (`sort.c:50-58`,
`sort.c:76-86`), which is why `nearest.c` could not reuse them either. The
pattern of "the right helper exists but is file-static" is recurring here and
worth solving once.

---

## 2. Registration and dispatch

### 2.1 Where `Nearest` wires in

| Concern | Location |
|---|---|
| Implementation | `src/list/nearest.c:148` — `Expr* builtin_nearest(Expr* res)` |
| Public declaration | `src/list/nearest.h` (one symbol) |
| Umbrella include | `src/list/list.h:38` — `#include "nearest.h"` |
| Registration + attributes + docstring | `src/list/list_init.c:90-98` |
| Init call site | `src/core.c:759` — `list_init();` |
| Main build | `makefile:303` globs `src/list/*.c` — **no edit needed** |
| Test build | `tests/CMakeLists.txt:341-373` — **enumerated, edit required** |

The registration triple, verbatim (`src/list/list_init.c:90-98`):

```c
symtab_add_builtin("Nearest", builtin_nearest);
symtab_get_def("Nearest")->attributes |= ATTR_PROTECTED;
symtab_set_docstring("Nearest",
    "Nearest[list, x]\n\tGives the element of list closest to x, as a list.\n"
    ...);
```

### 2.2 Name, arity, and the evaluation hook

- **Name → function** is a plain string registration:
  `typedef Expr* (*BuiltinFunc)(Expr* res);` (`src/symtab.h:40`) and
  `void symtab_add_builtin(const char* symbol_name, BuiltinFunc func);`
  (`src/symtab.h:175`). No `SYM_*` constant is needed for a builtin's own name —
  `SYM_Nearest` was deliberately **not** added. A `SYM_*` constant is only
  required when some *other* C code compares a head by pointer identity, or for
  an option key parsed from a trailing `Rule[]`.
- **Arity is not declarative.** There is no arity table; the builtin checks
  `res->data.function.arg_count` itself and returns `NULL` on a shape it does not
  handle (`nearest.c:149`). `FindClusters[list]` and a future
  `FindClusters[list, n]` are one function with an internal branch.
- **Evaluation hook**: by the time the builtin runs, the evaluator has already
  evaluated the head and arguments (no `Hold*` attribute on `Nearest`), applied
  `Listable`/`Flat`/`Orderless` if set, and will free `res` if the builtin
  returns non-`NULL`. Full order at `SPEC.md §3.5`.

### 2.3 What a new builtin must add — checklist

1. `src/list/find_clusters.{c,h}` — header declares only `Expr* builtin_find_clusters(Expr* res);`
2. `#include "find_clusters.h"` in `src/list/list.h`
3. In `list_init()` (`src/list/list_init.c`): `symtab_add_builtin`, `|= ATTR_PROTECTED`, `symtab_set_docstring`
4. **`../src/list/find_clusters.c` into `tests/CMakeLists.txt` COMMON_SRC (lines 341-373)** — this list is enumerated, not globbed; omitting it breaks every test binary at link, since all 405 link the shared `mathilda_common` OBJECT library (`tests/CMakeLists.txt:750`)
5. `SYM_*` constant only if an option key (`DistanceFunction`, `Method`) is parsed
6. No `makefile` change

---

## 3. Nested-list results: construction, freeing, and which precedent to follow

### 3.1 The common idiom

Every surveyed builtin builds bottom-up:

```c
Expr** vec = malloc(sizeof(Expr*) * n);   /* or (n ? n : 1) to dodge malloc(0) */
size_t k = 0;
for (...) vec[k++] = /* owned Expr*: expr_copy(borrowed), or an adopted pointer */;
Expr* wrapped = expr_new_function(head_expr, vec, k);
free(vec);        /* the VECTOR only — children are now owned by `wrapped` */
```

`free(vec)` is correct because `expr_new_function` allocates its own storage and
`memcpy`s the pointer array into it (`src/expr.c:235-250`); it does not adopt the
caller's array. The `Expr*` children *are* adopted.

### 3.2 The three head conventions — pick one deliberately

| Convention | Builtins | Reference |
|---|---|---|
| Preserve input head at **every** level | `Split`, `SplitBy`, `Partition`, `Union`/`Intersection`/`Complement` | `split.c:46,52`; `splitby.c:43,79`; `partition.c:60,64` |
| Preserve on inner, force `List` on outer | `Subsets` | `subsets.c:270` vs `:291` |
| Force `List` at **every** level | `Gather`/`GatherBy`, `Tally` | `assoc.c:85-87,956`; `setops.c:835,842` |

`Nearest` forces `List` (`nearest.c:214`). For `FindClusters`, the
`Gather`/`Tally` convention (always `List`) is the closest match and the easiest
to state in a test row.

### 3.3 The four empty-input conventions

| Builtin | `{}` in | Atom in |
|---|---|---|
| `Split` | `expr_copy(list)` → `{}` | `expr_copy` (returns the atom) |
| `SplitBy` | `{}` with input head | `NULL` |
| `Gather`/`GatherBy` | `{}` | `NULL` unless `List`/`Association` |
| `Partition` | `{}` under input head; bad spec returns **whole input** | `expr_copy` |
| `Tally` | fresh `List[]` → `{}` | fresh `List[]` |
| `Nearest` | `{}` (`nearest.c:166`) | `NULL` (`nearest.c:159`) |

No surveyed builtin returns `{{}}` for empty input. `Nearest`'s pair —
`{}` for an empty list, `NULL` for a non-`List` — is the cleanest precedent and
is already test-pinned.

### 3.4 Fixed vector vs growable buffer

Two sub-idioms, and the choice depends on whether the cluster count is known
before the pass:

- **Fixed, pre-sized** — used when a worst-case bound is known. `Split` sizes
  the outer vector at `count` (every element its own run, `split.c:15`);
  `Partition` computes `num_sublists` analytically (`partition.c:40-49`).
  **A sorted-gap clustering pass has exactly this property** (at most `n`
  clusters), so a single `malloc(sizeof(Expr*) * n)` suffices — no `realloc`.
- **Growable** — `SubsetBuf` struct with doubling `realloc` and a
  `subsets_buf_free` unwind (`subsets.c:38-63`), or the parallel-array variant
  in `assoc_gather_core` where each group starts at capacity 4 and doubles
  (`assoc.c:916-919, 938-944`). Needed only when the count is genuinely unknown.

### 3.5 The memory conventions that kept leaked bytes at zero

Measured on `Nearest`: **0 leaked bytes at both 200 and 20 000 iterations**
across the success, gate-bail, mixed-type-tie and decline paths (macOS `leaks`,
differential — volume must not scale with iteration count).

The rules that produced that:

1. **Every early return frees everything built so far.** The gate bail
   (`nearest.c:176-178`) frees `dist[0..i]` *inclusive* — `dist[i]` is assigned
   before the test, so slot `i` is initialised (possibly `NULL`, which
   `expr_free` early-returns on, `expr.c:558`).
2. **The allocating comparator frees its own temporary.** `nearest_cmp`
   allocates a difference per call on the slow path and frees it before
   returning (`nearest.c:144`). With 2n−1 comparisons this is the highest-traffic
   allocation site in the function; the 20 000-iteration run exists to exercise it.
3. **An undecidable comparison unwinds the partially built output.**
   `nearest.c:206-210` frees `out[0..nout)` before declining.
4. **The OOM path at result construction** (`nearest.c:214-220`) — the fix from
   review finding #4. `expr_new_function` returning `NULL` adopts *nothing*, so
   both the `nout` element copies **and the head symbol** leak unless freed:

```c
Expr* head = expr_new_symbol(SYM_List);
Expr* result = expr_new_function(head, out, nout);
if (!result) {                       /* OOM: expr_new_function took nothing */
    for (size_t i = 0; i < nout; i++) expr_free(out[i]);
    expr_free(head);
}
free(out);
return result;
```

   Note the head must be held in a named local to be freeable — the common
   inline `expr_new_function(expr_new_symbol(SYM_List), ...)` form has no way to
   release it on failure. **A nested result has one of these per level**, so
   `FindClusters` needs the same discipline at both the inner-cluster and outer
   wrap. `subsets_buf_free` (`subsets.c:58-63`) is the reusable shape when the
   unwind gets more than a few lines.

---

## 4. Numeric type flow, and the `builtin_abs` landmine

### 4.1 The types

`ExprType` declaration order (`src/expr.h:19-31`) — order matters because
`expr_compare` tiebreaks on it:

```
EXPR_INTEGER, EXPR_REAL, EXPR_SYMBOL, EXPR_STRING, EXPR_FUNCTION,
EXPR_BIGINT, EXPR_NDARRAY, EXPR_COMPILED [, EXPR_MPFR if USE_MPFR]
```

Payloads: `data.integer` (`int64_t`), `data.real` (`double`), `data.bigint`
(`mpz_t`), `data.mpfr` (`mpfr_t`, carries its own precision).
**`Rational` and `Complex` are not types** — both are `EXPR_FUNCTION` with heads
`Rational`/`Complex` and `arg_count == 2`. A `Rational`'s components may
themselves be `EXPR_INTEGER` **or** `EXPR_BIGINT`.

### 4.2 The int64-only vs bigint-aware predicate split

This split is the root of the whole family of bugs in this area:

| Predicate | Declared | Bigint-component `Rational`? |
|---|---|---|
| `is_rational(e, &n, &d)` | `arithmetic.h:16` | **No** — requires both components `EXPR_INTEGER` (`arithmetic.c:109-110`) |
| `is_rational_like(e)` | `arithmetic.h:22` | **Yes** — via `expr_is_integer_like` |
| `is_real_numeric(e)` | `list_common.h:42` | **No** — routes through `is_rational` |
| `is_atomic_numeric(e)` | `sort.c:50` (**static**) | **No** — same route |
| `expr_numeric_sign(e)` | `arithmetic.h:38` | **No**, and fails *silently* as `0` |
| `stats_is_real_numeric(e)` | `stats/stats_common.h:23` | **Yes** — evaluates `NumericQ`, but two evaluator round-trips per call |
| `nearest_is_real_number(e)` | `nearest.c:69` (**static**) | **Yes** — uses `is_rational_like` |

### 4.3 The `Abs` gap — a landmine to route around, not to fix

`builtin_abs` (`src/complex.c:314-422`) tries `EXPR_BIGINT`, `EXPR_INTEGER`,
`EXPR_REAL`, `EXPR_MPFR`, `is_complex`, and finally:

```c
418	    if (is_rational(arg, &n, &d)) {
419	        return make_rational(n < 0 ? -n : n, d);
420	    }
421	    return NULL;
```

Line 418 uses the **int64-only** `is_rational`. For `Abs[1/10^25]` the argument
is `Rational[1, BigInt]`, every branch misses, and it falls to `return NULL` —
so the call stays unevaluated. `builtin_sign` has the identical gap at
`src/complex.c:455`. Measured:

```
Abs[1/1000]   -> 1/1000            Abs[10^25]  -> 10000000000000000000000000
Abs[1/10^25]  -> Abs[1/10^25]      Sign[1/10^25] -> Sign[1/10^25]
```

**Consequence already in the tree**: `nearest_distance` calls `internal_abs`, so
`Nearest[{1/10^25, 1}, 0]` declines. That is pinned by acceptance row 22 with a
comment, precisely so the row flips if `builtin_abs` is ever fixed.

**For `FindClusters`, this is avoidable rather than inherited.** A 1D clustering
pass needs *gaps between sorted neighbours*, and after sorting, `next - current`
is non-negative by construction — **there is no need to call `Abs` at all**.
Computing the gap with `internal_subtract` alone and comparing it against a
threshold with a `nearest_cmp`-style value comparison sidesteps the landmine
entirely, and `FindClusters[{1/10^25, 2/10^25, 1}]` would work where
`Nearest` cannot. This is a genuine design advantage worth taking deliberately,
and worth an acceptance row that would fail if someone later "simplifies" the
gap to `Abs[b - a]`.

If a magnitude genuinely is needed elsewhere: no bigint-aware `Abs` helper
exists. `make_rational` (`arithmetic.c:34-53`) is int64-only with no bigint
counterpart. The only vetted pattern is read-the-sign-then-negate via
`nearest_sign` + `internal_times(-1, x)`.

### 4.4 Exact arithmetic helpers callable cross-module

```c
Expr* internal_subtract(Expr** args, size_t count);   /* internal.h:121 */
Expr* internal_abs     (Expr** args, size_t count);   /* internal.h:83  */
Expr* internal_times   (Expr** args, size_t count);   /* internal.h:119 */
Expr* internal_plus    (Expr** args, size_t count);   /* internal.h:118 */
void  expr_to_mpz(const Expr* e, mpz_t out);          /* expr.h:315, mpz_init's out */
Expr* numericalize(const Expr* e, NumericSpec spec);  /* numeric.h:139 */
static inline Expr* eval_and_free(Expr* e);           /* eval.h:129 */
```

`internal_call_impl` ownership (`src/internal.c:189-211`), which the plan must
respect: it **consumes** the `args` array into a new node, and when the builtin
declines it returns **the unevaluated node, never `NULL`**. So
`internal_subtract` cannot yield `NULL`, and its result must always be freed —
but may be an unevaluated `Subtract[...]`/`Plus[...]` that the numeric gate then
rejects.

MPFR helpers (`numeric.h:147-232`, all `USE_MPFR`-gated): `numeric_mpfr_sub`,
`get_approx_mpfr`, `numeric_combined_bits`. Not needed if comparison goes
through `internal_subtract` + a sign reader, which already handles `EXPR_MPFR`.

---

## 5. The stay-unevaluated pattern for symbolic elements

Three guards, in order (`nearest.c:149-180`), each returning `NULL`:

```c
if (res->type != EXPR_FUNCTION || res->data.function.arg_count != 2) return NULL;  /* arity  */
if (!is_listq(list)) return NULL;                                                  /* shape  */
/* ... then, per element: */
if (!nearest_is_real_number(dist[i])) { /* free everything built */ return NULL; } /* numeric */
```

`NULL` means "I cannot evaluate this"; the evaluator retains ownership of `res`
and the expression prints back unchanged. The builtin must **not** free `res`.

Three properties worth carrying over:

1. **Gate the derived value, not the element.** `Nearest` gates the *distance*,
   which catches a symbolic element, a symbolic target, and a non-real complex
   in one check. For `FindClusters` the analogue is gating each *gap*, though
   gating elements directly is also defensible since there is no second operand
   — the plan should state which and pin it with a row.
2. **Decline rather than drop.** This is the deliberate divergence from
   `MinimalBy`, which answers `{1, 3}` for `MinimalBy[{1, a, 3}, Abs[# - 2] &]` —
   silently omitting the symbolic element because `expr_compare` orders symbols
   after all numbers (`sort.c:379-380`). A plausible wrong answer is worse than
   no answer. For clustering the stakes are the same: a dropped element changes
   the partition.
3. **Undecidable comparison also declines.** The `bool ok` thread through the
   two comparison passes (`nearest.c:185-210`) means an unreadable comparison
   aborts the call instead of being treated as a tie.

Empty input is checked **before** the numeric gate (`nearest.c:164-166`), so
`Nearest[{}, a]` is `{}` and not unevaluated. Pinned by rows 17-18.

---

## 6. The verification harness

### 6.1 The acceptance table

`test_nearest()` — `tests/test_list.c:965-1063`, **29 rows**, registered as
`TEST(test_nearest);` at `tests/test_list.c:1119`. Uses
`assert_eval_eq(input, expected, is_fullform)` (`tests/test_utils.h:18-30`);
all rows pass `0` for plain `expr_to_string`.

> Correction to an earlier claim: I stated "30 acceptance rows" in the commit
> message and PR body for #53. The actual count is 29 (enumerated). The PR body
> has been corrected; the commit message still reads 30.

Setup is process-wide in `main()` — `symtab_init(); core_init(); trig_init();`
(`tests/test_list.c:1066-1069`). No per-test teardown.

Structure worth copying: rows grouped by intent with a comment per group, and
**boundary rows that pin known limitations** so they flip visibly when the
limitation is lifted (rows 21 and 22 — `Pi` and the bigint rational).

Note `tests/test_utils.h:54-57`: plain libc `assert()` is stripped under
`-DNDEBUG`; use `ASSERT`/`ASSERT_STR_EQ` (`test_utils.h:74-99`) in new bodies.
`assert_eval_eq` internally uses `assert` and is the accepted exception.

### 6.2 Check targets and whether each sees a new builtin

| Target | makefile | Script | Sees a new fast-path-less list builtin? |
|---|---|---|---|
| `check-c99` | `:413` | `tools/check_c99_portability.py` | **Yes** — static scan of all `src/` |
| `check-packed-aware` | `:429` | `tools/check_packed_aware.py` | No — diffs *existing* NDArray dispatch sites against `pack.c`'s `AWARE` |
| `check-array-exactness` | `:441` | `tools/check_array_exactness.py` | No — 342 curated probes |
| `check-nd-surfaces` | `:460` | `tools/nd_surface_audit.py --survival` | No — curated probes |
| `check-compile-coverage` | `:477` | `tools/compile_coverage.py` | No — scoped to heads with a registered ND kernel |
| `check-fastpath-sweep` | `:503` | `tools/nd_fastpath_sweep.py --gate-only` | **Yes** — discovers by trial from `Names["*"]` |

`check-c99` detects three classes: POSIX `<math.h>` constants without an
`#ifndef` fallback; POSIX functions without a feature-test macro *before the
first include*; and `long long` vs `int64_t` checked-int family mixing outside
`src/compile/`. **`isnan` needs no guard** — it is genuine C99, is absent from
the checker's `FUNCTIONS` table (`:123-155`), and `nearest.c:45` uses it with
only `#include <math.h>`. Same applies to `isinf`, `fabs`, `sqrt`.

### 6.3 The one gate that will actually fire — and why `FindClusters` differs from `Nearest`

`SKIP_EXPLOSIVE` (`tools/nd_fastpath_sweep.py:223-262`) filters heads out at the
**discovery** phase of `gate_main` (`:692`):

```python
all_probes = [(h, sid, tmpl % h) for h in cand for sid, tmpl, _ in SHAPES
              if h not in SKIP_EXPLOSIVE]
```

`"Nearest"` is a member (`:226`), so it produces zero probes and the sweep never
measures it — its silence about `Nearest` is *exclusion, not verification*.

**`FindClusters` will not get that exemption for free.** `SKIP_EXPLOSIVE` is for
quadratic-or-worse output; a clustering function whose total output element count
equals its input is linear, so it **will** be discovered in Phase 1, probed in
the gate pass, and — with no buffer fast path — reported as a head outside the
`OFF_BUFFER` ratchet (`:608`), failing `make check-fastpath-sweep`.

The plan needs a decision rule fixed in advance:
- give it a packed fast path and add it to `pack.c`'s `AWARE`, **or**
- add `"FindClusters"` to `OFF_BUFFER` to record the known gap, **or**
- if the implementation is internally quadratic (an all-pairs distance matrix),
  add it to `SKIP_EXPLOSIVE` instead, following the `Nearest` precedent.

### 6.4 Docs

- Category page: `docs/spec/builtins/lists-and-iteration.md`; the `## Nearest`
  section is lines **355-387** and is the last section. Format: one-line summary,
  signature bullets, `**Features**:` list opening with attributes, then a fenced
  ` ```mathematica ` block of `In[n]:=`/`Out[n]=` pairs.
- Changelog: `docs/spec/changelog/2026-08-03.md`. Today is Sunday 2026-08-09,
  still inside the ISO week beginning Monday 2026-08-03, so **that file is
  correct and already exists** — append, do not create. Sections are
  append-ordered (newest last), not strictly date-sorted.
- `Mathilda_spec.md`: **no change**. `Nearest` has no row there; the category
  row at `:47` already covers lists-and-iteration, and the week's changelog row
  at `:83` already exists.
- Verify any cross-reference anchor before using it. `## Abs` does **not** exist
  anywhere under `docs/spec/builtins/` — a link to it would be dead (this was
  caught and removed during the `Nearest` work).

### 6.5 Leak checking

No `valgrind` make target exists; `SPEC.md §9`'s valgrind line is documentation
only. valgrind is unavailable on this Apple Silicon machine, so `Nearest` used
macOS `leaks` **differentially** — the same script at two iteration counts, with
the requirement that leaked bytes not scale:

```bash
export MallocStackLogging=1
leaks --atExit -- ./Mathilda -file leak_lo.m   # N=200
leaks --atExit -- ./Mathilda -file leak_hi.m   # N=20000
# both must report "0 leaks for 0 total leaked bytes"
```

A single at-exit run is not sufficient — it is noisy against pre-existing
allocations. The script must exercise **every** path, especially the decline
paths, since those hold the partially-built unwinds.

`tests/bench_assoc.c` is the only checked-in performance/scaling gate and is
Association-specific; there is no equivalent for `src/list/`.

### 6.6 Pre-existing failures — do not attribute these to new work

Each was proven pre-existing by stashing the `Nearest` change and re-running:

- `flint_bridge_tests` — link error on `_flint_cyclotomic_gcd`; the test build's
  FLINT detection is off while `test_flint_bridge.c` references `#ifdef USE_FLINT`
  symbols unconditionally.
- `core_tests` — SIGABRT in `test_quotient`.
- `vandermondematrix_tests` — SIGABRT in `test_determinant_symbolic`.
- `factorlist_tests` — sign-normalisation mismatch in multivariate factoring.
- `make check-compile-coverage` — red on `DesignMatrix`, `Fit`,
  `InterpolatingPolynomial`, `Interpolation` (ratchet backlog).

A practical note: the full 405-binary suite cannot be run serially inside a
10-minute budget, and `integrate_risch_transcendental_tests` hangs. The
`Nearest` work used a 17-binary blast-radius subset (list/array/sort/packing)
with a per-test timeout implemented via a background `kill` — `perl -e 'alarm N; exec'`
does **not** work here.

---

## Code references

- `src/list/nearest.c:62-146` — the numeric machinery (all `static`)
- `src/list/nearest.c:119-130` — the comment explaining why `expr_compare` is wrong
- `src/list/nearest.c:164-180` — empty-before-gate, and the gate unwind
- `src/list/nearest.c:206-220` — decline unwind and the OOM fix
- `src/sort.c:372-377` — the double fallback and type-enum tiebreak
- `src/sort.c:50-58`, `:76-86` — `is_atomic_numeric`, `get_numeric_value` (static)
- `src/sort.c:663-716` — `maximal_minimal_by`, the collect-all-ties template
- `src/sort.c:379-380` — symbols order after numbers (why `MinimalBy` drops them)
- `src/arithmetic.c:90-137` — `is_rational` vs `is_rational_like`
- `src/arithmetic.c:273-294` — `expr_numeric_sign` and its silent `0`
- `src/complex.c:418-421`, `:455` — the `Abs` / `Sign` bigint-rational gap
- `src/internal.c:189-211` — `internal_call_impl` ownership
- `src/expr.c:235-250` — `expr_new_function` copies the args array
- `src/expr.c:558` — `expr_free(NULL)` early-returns
- `src/list/list_common.h:30-42` — the shared-helper home
- `src/list/split.c:15,42-53`; `src/list/splitby.c:40-82` — run construction
- `src/assoc.c:906-959` — `assoc_gather_core`, growable groups
- `src/list/partition.c:40-66` — analytic sizing, recursive nesting
- `src/list/setops.c:830-843` — `Tally`'s `{elem, count}` pairs
- `src/list/subsets.c:38-63` — `SubsetBuf` growable buffer + unwind
- `src/list/list_init.c:90-98` — registration triple
- `tests/test_list.c:965-1063`, `:1119` — acceptance table and registration
- `tests/CMakeLists.txt:341-373` — enumerated list sources
- `tools/nd_fastpath_sweep.py:223-262`, `:608`, `:692` — SKIP_EXPLOSIVE, OFF_BUFFER, filter point

## Architecture insights

**The recurring failure is a helper that is right but unreachable.**
`is_atomic_numeric` and `get_numeric_value` are static in `sort.c`;
`compare_numeric` is static in `comparisons.c`; now `nearest_sign` and
`nearest_cmp` are static in `nearest.c`. Each time, the next caller either
reaches for a public helper with subtly wrong semantics (`expr_compare`,
`expr_numeric_sign`) or re-implements. `FindClusters` is the second caller for
this exact comparator, which makes promoting it to `list_common` the change that
stops the pattern rather than extending it.

**Two comparison regimes exist and the type system does not distinguish them.**
`expr_compare` is a canonical order; `compare_numeric` is a numeric predicate.
Both take two `Expr*` and return an int. Nothing prevents using the wrong one —
that is exactly the bug that shipped in `Nearest` and passed 22 tests. The
defence is a test row with mixed exact/inexact values; nothing else catches it.

**Silent-zero is the dangerous failure mode.** `expr_numeric_sign` returning `0`
for "unrecognised" is indistinguishable from "equal". For `Nearest` that meant a
false tie; for `FindClusters` it means a false merge. The `bool* ok`
out-parameter is the cheap structural fix and should be preserved in anything
promoted to shared code.

**Ratchets, not assertions.** `OFF_BUFFER` and `BASELINE` carry the known
backlog so a gate fails only on *newly* regressed heads (`SPEC.md §9`). A new
builtin joins one of those lists or gets a fast path — those are the only two
honest options.

## Related research

- `thoughts/shared/research/2026-08-07-nearest-list-builtin.md` — the pre-implementation survey
- `thoughts/shared/plans/2026-08-07-nearest-two-arg.md` — the approved plan, incl. the acceptance-table method
- `thoughts/shared/tickets/nearest-followups.md` — F1–F6, incl. the sweep-blindness note

## Open questions for the plan to resolve

1. **Where do the numeric helpers live?** Promote to `list_common` (recommended),
   duplicate, or export from `nearest.h`. Affects whether #53 is amended.
2. **What defines a cluster boundary?** A fixed gap threshold, a multiple of the
   mean gap, an explicit `FindClusters[list, n]` count, or Mathematica's
   automatic method. This determines whether the pass is single-shot or
   iterative, and whether the output count is bounded by `n` up front.
3. **Does the input get sorted, and does output order follow input or sorted
   order?** Mathematica's `FindClusters` preserves original element order within
   clusters. Sorting internally while emitting in input order needs an index
   permutation — `Ordering` (`sort.c:1132`) exists and is public.
4. **Gate elements or gaps?** §5 argues gaps for `Nearest`; for a single-argument
   `FindClusters` gating elements is simpler and equally strict.
5. **The `check-fastpath-sweep` decision** (§6.3), fixed before implementation.
6. **Empty and singleton conventions**: `FindClusters[{}]` → `{}` or `{{}}`?
   `FindClusters[{5}]` → `{{5}}`. §3.3 shows no universal rule, so both need rows.
