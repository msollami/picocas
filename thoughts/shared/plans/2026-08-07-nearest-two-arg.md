# `Nearest[list, x]` (two-argument form) Implementation Plan

**Date**: 2026-08-07
**Author**: Michael Sollami
**Branch**: `perf/clip-packed`
**Base commit**: `03170b19c9a15b1a2b7a4e555656c8ab8d067e12`
**Research**: `thoughts/shared/research/2026-08-07-nearest-list-builtin.md`

## Overview

Add the two-argument `Nearest[list, x]` built-in: the element(s) of `list` at
minimum `Abs[element - x]`, returned as a `List` in original order, with **all
tied elements** returned. Nothing else.

## One correction to the brief, before anything else

The instruction was to *"reuse `ranked_cmp`'s existing original-index tiebreak
from `src/sort.c:890-957` rather than writing new tie logic."* That cannot be
done, for two reasons — the second is the substantive one:

1. `ranked_cmp`, `ranked_numeric_key`, and `RankedCtx` are all `static` in
   `sort.c` (`sort.c:898`, `:921`, `:923`) and none is exported by `sort.h`.

2. **`ranked_cmp`'s tiebreak does the opposite of what the acceptance rows
   require.** Its index comparison exists to make the order *strict* so the
   Hoare partition in `ranked_select_idx` terminates — `sort.c:932`:

   ```c
   return (i < j) ? -1 : 1;   /* stable: original position breaks value ties */
   ```

   It *breaks* ties, deliberately making two equal-distance elements unequal so
   that exactly one wins. Row 1 of the acceptance table requires the reverse:
   equal-distance elements must *both* survive. Building on `ranked_cmp` would
   return `{1}` for `Nearest[{1, 5, 10}, 3]`, failing the row that motivated the
   brief.

**The correct reuse target is `MinimalBy`** (`src/sort.c:663-716`), which is
already the collect-all-ties algorithm — two passes, `expr_compare` on evaluated
keys, original order falling out of the ascending index scan with no comparator
tiebreak involved:

```c
size_t best = 0;
for (size_t i = 1; i < n; i++) {
    int c = expr_compare(keys[i], keys[best]);
    if ((mode == 0 && c > 0) || (mode == 1 && c < 0)) best = i;
}

Expr** out = malloc(sizeof(Expr*) * n);
size_t nout = 0;
for (size_t i = 0; i < n; i++)
    if (expr_compare(keys[i], keys[best]) == 0)
        out[nout++] = expr_copy(coll->data.function.args[i]);
```

I verified against the built binary that this structure already produces both
required rows today:

```
MinimalBy[{1, 5, 10}, Abs[# - 3] &]   ->  {1, 5}
MinimalBy[{4},        Abs[# - 100} &] ->  {4}
```

So the intent behind the instruction — *don't write new tie logic* — is honoured
exactly, just against `MinimalBy` rather than `ranked_cmp`. Everything else in
the brief stands unchanged.

`ranked_numeric_key` is still the reference for the **non-numeric policy**
(bail rather than guess), which is the one place `MinimalBy` and `Nearest` must
differ — see the next section.

## Current State Analysis

`Nearest` is unimplemented. `Names["Nearest*"]` on a fresh binary returns `{}`.
The two source hits (`tools/numeric_coverage.py:190`,
`tools/nd_fastpath_sweep.py:226`) are curated wish-lists of the Mathematica
surface, not implementations.

### The one place `MinimalBy` is wrong for us

Measured against the binary:

```
MinimalBy[{1, a, 3}, Abs[# - 2] &]   ->  {1, 3}
```

`MinimalBy` **silently drops** the symbolic element: `expr_compare` orders
`Abs[-2 + a]` after all numbers (`sort.c:379-380` — numbers sort before
symbols), so it is never minimal and simply vanishes from the answer. That is a
plausible-looking wrong answer, and it is precisely what the brief's
"non-numeric elements return NULL" rule exists to prevent.

So: copy `MinimalBy`'s structure, add an explicit real-numeric gate that
`MinimalBy` does not have. This is the entire delta between the two functions.

### Distance: what `Abs[a - b]` actually evaluates to

Measured, and it is what makes exact tie detection work:

| Expression | Result | Consequence |
|---|---|---|
| `Abs[1 - 3]` | `2` | exact integer |
| `Abs[1/3 - 1/2]` | `1/6` | exact rational |
| `Abs[2/3 - 1/2]` | `1/6` | **ties exactly** with the above |
| `Abs[1 - 1.4]` | `0.4` | machine real |
| `Abs[(3 + 4 I) - 0]` | `5` | complex modulus, real result |
| `Abs[Pi - 3]` | `Abs[-3 + Pi]` | **stays symbolic** → gate fires |
| `Abs[a - 3]` | `Abs[-3 + a]` | **stays symbolic** → gate fires |

`Order[1/6, 1/6]` is `0`, confirming `expr_compare` detects the exact rational
tie. Gating on the **distance** rather than on the element is therefore both
simpler and stricter: one check covers a symbolic element, a symbolic target,
and a non-real complex, because all three yield a non-real-numeric distance.

### Key discoveries

- `is_real_numeric(Expr*)` is already exported for this exact purpose —
  `src/list/list_common.h:42`, defined `src/list/list_common.c:34-50`. It is
  what `ranked_select` uses for its own bail scan (`sort.c:976-978`).
- `internal_subtract` / `internal_abs` — `src/internal.h:121`, `:83`. The
  chaining precedent with `eval_and_free` is `src/comparisons.c:313-314`.
- `internal_call_impl` (`src/internal.c:189-211`) **consumes** the `args` array's
  `Expr*`s, and on a builtin returning `NULL` hands back the *unevaluated* node
  rather than `NULL`. So `internal_abs` never returns `NULL` — a symbolic input
  comes back as `Abs[...]`, which the gate then rejects. No null-check needed
  between the two calls.
- `RankedMin` gates its input with `if (!is_listq(list)) return NULL;`
  (`sort.c:1014`). Follow that: `Nearest[f[1, 5], 3]` stays unevaluated.
  (`MinimalBy` differs here — it accepts and preserves any head, measured:
  `MinimalBy[f[1, 5], Abs[# - 3] &]` → `f[1, 5]`.)
- Packed input is safe with no work: `Nearest` will not be on `pack.c`'s `AWARE`
  list, so the transparency gate materialises a packed `List` before the builtin
  sees it. Measured on the same non-AWARE path: `MinimalBy[Range[5], …]` → `{3}`.
- A *visible* `NDArray` is never materialised by the gate, and
  `ListQ[NDArray[…]]` is `False` — so the `is_listq` guard yields unevaluated
  rather than a wrong answer. Measured.

## Desired End State

`Nearest[list, x]` returns a `List` of every element of `list` at minimum
`Abs[element - x]`, in original order; returns `{}` for an empty list; returns
unevaluated (`NULL`) whenever any distance is not a real number, the input is
not a `List`, or the arity is not 2.

Verified by the acceptance table below passing in `tests/test_list.c`.

## Acceptance table

This is the specification. Every row is a literal `{input, expected}` entry in
`test_nearest()`. **Anything not in this table is not spec.**

### Required by the brief

| # | Input | Expected | Pins |
|---|---|---|---|
| 1 | `Nearest[{1, 5, 10}, 3]` | `{1, 5}` | **all tied elements**, not a single min |
| 2 | `Nearest[{4}, 100]` | `{4}` | single element, arbitrarily far |

### Ties and ordering

| # | Input | Expected | Pins |
|---|---|---|---|
| 3 | `Nearest[{5, 1, 10}, 3]` | `{5, 1}` | original order, not sorted — 5 precedes 1 |
| 4 | `Nearest[{-5, 5}, 0]` | `{-5, 5}` | symmetric tie about the target |
| 5 | `Nearest[{1/3, 2/3}, 1/2]` | `{1/3, 2/3}` | **exact** rational tie (both `1/6`) |
| 6 | `Nearest[{1, 1, 2}, 1]` | `{1, 1}` | duplicates are distinct by position |
| 7 | `Nearest[{2, 4, 6}, 4]` | `{4}` | exact hit, no tie |

### Unique nearest

| # | Input | Expected | Pins |
|---|---|---|---|
| 8 | `Nearest[{1, 2}, 1.4]` | `{1}` | machine-real target, `0.4` < `0.6` |
| 9 | `Nearest[{10, 20, 30}, 100]` | `{30}` | target past the end |
| 10 | `Nearest[{3 + 4 I, 1}, 0]` | `{1}` | complex modulus as distance (`5` vs `1`) |

### Empty and degenerate

| # | Input | Expected | Pins |
|---|---|---|---|
| 11 | `Nearest[{}, 3]` | `{}` | empty in, empty out |
| 12 | `Nearest[{}, a]` | `{}` | empty short-circuits before the gate |

### Unevaluated — the gate

| # | Input | Expected | Pins |
|---|---|---|---|
| 13 | `Nearest[{1, a, 3}, 2]` | `Nearest[{1, a, 3}, 2]` | **symbolic element → NULL** (where `MinimalBy` gives `{1, 3}`) |
| 14 | `Nearest[{1, 2, 3}, a]` | `Nearest[{1, 2, 3}, a]` | symbolic target |
| 15 | `Nearest[{Pi, 4}, 3]` | `Nearest[{Pi, 4}, 3]` | symbolic *real* — `Abs[-3 + Pi]` is not a real atom |
| 16 | `Nearest[{1, 5, 10}]` | `Nearest[{1, 5, 10}]` | arity 1 |
| 17 | `Nearest[{1, 5}, 3, 2]` | `Nearest[{1, 5}, 3, 2]` | arity 3 — the follow-up form, explicitly inert here |
| 18 | `Nearest[3, 1]` | `Nearest[3, 1]` | atom input |
| 19 | `Nearest[f[1, 5], 3]` | `Nearest[f[1, 5], 3]` | non-`List` head (follows `RankedMin`, not `MinimalBy`) |
| 20 | `Nearest[NDArray[{1., 5., 10.}], 3.]` | `Nearest[NDArray[{1.0, 5.0, 10.0}], 3.0]` | visible NDArray — unevaluated, never a wrong answer |

### Packed input and attributes

| # | Input | Expected | Pins |
|---|---|---|---|
| 21 | `Nearest[Range[5], 3]` | `{3}` | packed input materialises via the transparency gate |
| 22 | `Attributes[Nearest]` | `{Protected}` | |

### Row 15 and row 20 are deliberate scope boundaries

Row 15 pins that a symbolic real (`Pi`, `Sqrt[2]`) is **rejected**, not
numericalized. `ranked_numeric_key` *does* numericalize such elements
(`sort.c:906`), so this is stricter than RankedMin's full behaviour while
matching its bail-on-indefinite *policy*. Making `Pi` work means replicating the
`numericalize` path, which is a behaviour change with its own edge cases —
filed as follow-up F6 rather than smuggled in. Row 15 exists so that change is
visible as a table diff when someone makes it.

Row 20 pins the visible-NDArray surface as inert. Per `SPEC.md §9`, the
transparency gate never touches a visible NDArray, so the `is_listq` guard is
the only thing standing between us and a silently truncated answer. Filed as
follow-up F5.

## What We're NOT Doing

Explicitly out of scope; each filed as a follow-up in Phase 4:

- **F1** — `Nearest[list, x, n]`, the n-nearest form.
- **F2** — `Nearest[list, x, {n, r}]` and `{All, r}`, the radius forms.
- **F3** — `Nearest[list -> vals, x]` and `Nearest[list -> Automatic, x]`, the
  rule forms.
- **F4** — `Nearest[list]`, the all-pairs form (already flagged
  quadratic-output at `tools/nd_fastpath_sweep.py:226`).
- **F5** — `NearestTo[x]` operator form, and a visible-NDArray / packed-buffer
  fast path (with the matching `pack.c` `AWARE` entry).
- **F6** — `DistanceFunction -> f` option, and the symbolic-real
  (`numericalize`) element path from row 15.

Also not doing: no new distance helper (`expr_distance`, `abs_diff`, …); no
change to `MinimalBy`, `RankedMin`, `sort.c`, or `expr_compare`; no
`SYM_Nearest` constant (unnecessary — `symtab_add_builtin` takes a plain string,
and no other C module needs to recognise the head by pointer).

## Implementation Approach

`MinimalBy`'s two-pass structure, with the key function fixed to
`Abs[element - x]` and a real-numeric gate on each distance. Single pass to
build distances (bailing on the first non-real), one pass to find the minimum,
one pass to collect everything equal to it.

O(n) distance evaluations, O(n) comparisons, O(n) peak extra memory for the
distance vector. No sort, no quickselect — the n-nearest follow-up (F1) is where
selection becomes worth it.

---

## Phase 1: The built-in and its wiring

### Changes Required

#### 1. New file: `src/list/nearest.h`

```c
#ifndef NEAREST_H
#define NEAREST_H

#include "expr.h"

Expr* builtin_nearest(Expr* res);

#endif /* NEAREST_H */
```

#### 2. New file: `src/list/nearest.c`

Header comment follows the house style of `pick.c:1-20` / `splitby.c:1-25`:
state the semantics, state what distinguishes it from its neighbours, state the
cost. Then:

```c
#include "list_common.h"
#include "internal.h"
#include "nearest.h"

/* Abs[e - x], fully evaluated. Caller owns the result.
 *
 * internal_call_impl consumes the argument array and, when the builtin declines,
 * returns the UNEVALUATED node rather than NULL -- so a symbolic operand comes
 * back as Abs[...], which nearest_collect's is_real_numeric gate then rejects.
 * Neither call can return NULL, so neither needs a null check. Composition and
 * the eval_and_free wrapping follow comparisons.c:313-314. */
static Expr* nearest_distance(Expr* e, Expr* x) {
    Expr* sub_args[2] = { expr_copy(e), expr_copy(x) };
    Expr* diff = eval_and_free(internal_subtract(sub_args, 2));
    Expr* abs_args[1] = { diff };            /* internal_abs takes ownership */
    return eval_and_free(internal_abs(abs_args, 1));
}

Expr* builtin_nearest(Expr* res) {
    if (res->type != EXPR_FUNCTION || res->data.function.arg_count != 2) return NULL;

    Expr* list = res->data.function.args[0];
    Expr* x    = res->data.function.args[1];

    /* A visible NDArray is not a List and is never materialised by the
     * transparency gate, so it lands here and stays unevaluated rather than
     * being silently truncated. A PACKED list has already been materialised on
     * the way in, because Nearest is not on pack.c's AWARE list. */
    if (!is_listq(list)) return NULL;

    size_t n = list->data.function.arg_count;
    Expr** elem = list->data.function.args;

    /* Empty in, empty out -- before the gate, so Nearest[{}, a] is {} and not
     * unevaluated. Matches MaximalBy (sort.c:684). */
    if (n == 0) return expr_new_function(expr_new_symbol(SYM_List), NULL, 0);

    Expr** dist = malloc(sizeof(Expr*) * n);
    if (!dist) return NULL;

    /* One pass to build distances. A distance that is not a real number means
     * there is no definite answer -- bail, freeing what we built. This is the
     * one place Nearest differs from MinimalBy, which would silently drop the
     * offending element and return a plausible wrong answer. Gating on the
     * DISTANCE rather than the element covers a symbolic element, a symbolic
     * target, and a non-real complex in a single check. */
    for (size_t i = 0; i < n; i++) {
        dist[i] = nearest_distance(elem[i], x);
        if (!dist[i] || !is_real_numeric(dist[i])) {
            for (size_t j = 0; j <= i; j++) expr_free(dist[j]);
            free(dist);
            return NULL;
        }
    }

    /* Two passes, exactly as MinimalBy (sort.c:698-708): find the minimum, then
     * collect every element whose distance equals it. Ascending index order in
     * the collect pass is what preserves input order among ties -- no
     * comparator tiebreak is involved, and none should be: ranked_cmp's index
     * tiebreak exists to make ties IMPOSSIBLE, which is the opposite need. */
    size_t best = 0;
    for (size_t i = 1; i < n; i++)
        if (expr_compare(dist[i], dist[best]) < 0) best = i;

    Expr** out = malloc(sizeof(Expr*) * n);
    if (!out) {
        for (size_t i = 0; i < n; i++) expr_free(dist[i]);
        free(dist);
        return NULL;
    }

    size_t nout = 0;
    for (size_t i = 0; i < n; i++)
        if (expr_compare(dist[i], dist[best]) == 0)
            out[nout++] = expr_copy(elem[i]);

    for (size_t i = 0; i < n; i++) expr_free(dist[i]);
    free(dist);

    /* The wrapper is always List, even though the input head is always List
     * here -- stated explicitly because the n-nearest follow-up keeps it. */
    Expr* result = expr_new_function(expr_new_symbol(SYM_List), out, nout);
    free(out);
    return result;
}
```

#### 3. `src/list/list.h`

Add to the include block (`src/list/list.h:12-41`), after `#include "minmax.h"`:

```c
#include "nearest.h"
```

#### 4. `src/list/list_init.c`

Inside `list_init()`, after the `MinMax` block (`src/list/list_init.c:85-89`).
Uses the modern inline convention — registration, attributes, docstring together:

```c
symtab_add_builtin("Nearest", builtin_nearest);
symtab_get_def("Nearest")->attributes |= ATTR_PROTECTED;
symtab_set_docstring("Nearest",
    "Nearest[list, x]\n\tGives the element of list closest to x, as a list.\n"
    "\tAll elements tied at the minimum distance Abs[element - x] are\n"
    "\treturned, in their original order; an empty list gives {}.\n"
    "\tReturns unevaluated unless every distance is a real number, so a\n"
    "\tsymbolic element or target leaves the expression unchanged rather\n"
    "\tthan dropping it from the result.");
```

#### 5. `tests/CMakeLists.txt`

**Required** — this list is enumerated, not globbed. Add to `COMMON_SRC`
alongside the other `src/list` entries (`tests/CMakeLists.txt:341-372`):

```cmake
    ../src/list/nearest.c
```

Omitting this breaks every test binary at link, since all of them link the
shared `mathilda_common` OBJECT library (`tests/CMakeLists.txt:750`).

No top-level `makefile` change: `makefile:303` globs `src/list/*.c`.

### Success Criteria

#### Automated Verification
- [ ] Main build is clean: `make -j$(sysctl -n hw.ncpu)`
- [ ] No new warnings under the project's strict flags (see Phase 4 for the
      glibc gate)
- [ ] Test suite builds: `cd tests/build && cmake .. && make -j`
- [ ] `Nearest` is registered: `Names["Nearest*"]` gives `{Nearest}` on a fresh
      binary (contrast: `{}` before this change)

#### Manual Verification
- [ ] `Nearest[{1, 5, 10}, 3]` gives `{1, 5}` at the REPL

---

## Phase 2: Acceptance table

### Changes Required

#### `tests/test_list.c`

Add `test_nearest()` using the `assert_eval_eq` style — the newer of the two
harness conventions, as used by `test_riffle` (`tests/test_list.c:877-916`) and
`test_subdivide`. Every row of the acceptance table above becomes one table
entry, with the section comments carried over so the intent survives:

```c
void test_nearest() {
    struct {
        const char* input;
        const char* expected;
    } tests[] = {
        /* ALL tied elements are returned, not a single minimum. Both 1 and 5
         * sit at distance 2 from 3. This is the row the whole design turns on:
         * a quickselect-style tiebreak would answer {1}. */
        {"Nearest[{1, 5, 10}, 3]", "{1, 5}"},
        {"Nearest[{4}, 100]", "{4}"},

        /* Ties come back in INPUT order, not sorted order. */
        {"Nearest[{5, 1, 10}, 3]", "{5, 1}"},
        {"Nearest[{-5, 5}, 0]", "{-5, 5}"},
        /* Exact rational tie: both distances are exactly 1/6, and expr_compare
         * sees them as equal. A float-keyed comparison could miss this. */
        {"Nearest[{1/3, 2/3}, 1/2]", "{1/3, 2/3}"},
        /* Duplicates are distinct by position, as in Subsets. */
        {"Nearest[{1, 1, 2}, 1]", "{1, 1}"},
        {"Nearest[{2, 4, 6}, 4]", "{4}"},

        /* Unique nearest. */
        {"Nearest[{1, 2}, 1.4]", "{1}"},
        {"Nearest[{10, 20, 30}, 100]", "{30}"},
        /* Abs of a complex difference is its modulus, so the complex case
         * falls out of the composition: 5 versus 1. */
        {"Nearest[{3 + 4 I, 1}, 0]", "{1}"},

        /* Empty in, empty out -- checked before the numeric gate, so a
         * symbolic target on an empty list is still {}. */
        {"Nearest[{}, 3]", "{}"},
        {"Nearest[{}, a]", "{}"},

        /* THE GATE. A non-real distance means no definite answer, so the whole
         * call stays unevaluated. Note MinimalBy[{1, a, 3}, Abs[# - 2] &] gives
         * {1, 3} -- it drops the symbolic element and answers anyway. That
         * plausible wrong answer is what this row exists to prevent. */
        {"Nearest[{1, a, 3}, 2]", "Nearest[{1, a, 3}, 2]"},
        {"Nearest[{1, 2, 3}, a]", "Nearest[{1, 2, 3}, a]"},
        /* A symbolic REAL is rejected too: Abs[Pi - 3] stays as Abs[-3 + Pi].
         * Numericalizing it (as RankedMin's ranked_numeric_key would) is a
         * deliberate follow-up, not current behaviour. */
        {"Nearest[{Pi, 4}, 3]", "Nearest[{Pi, 4}, 3]"},

        /* Arity. The 3-argument n-nearest form is a follow-up and is inert. */
        {"Nearest[{1, 5, 10}]", "Nearest[{1, 5, 10}]"},
        {"Nearest[{1, 5}, 3, 2]", "Nearest[{1, 5}, 3, 2]"},
        {"Nearest[3, 1]", "Nearest[3, 1]"},
        /* Non-List head follows RankedMin (sort.c:1014), not MinimalBy, which
         * accepts and preserves any head. */
        {"Nearest[f[1, 5], 3]", "Nearest[f[1, 5], 3]"},
        /* A visible NDArray is never materialised by the transparency gate, so
         * is_listq is the only guard against a silently truncated answer.
         * Unevaluated is the correct conservative result. */
        {"Nearest[NDArray[{1., 5., 10.}], 3.]",
         "Nearest[NDArray[{1.0, 5.0, 10.0}], 3.0]"},

        /* A PACKED list, by contrast, is materialised on the way in because
         * Nearest is not on pack.c's AWARE list. */
        {"Nearest[Range[5], 3]", "{3}"},

        {"Attributes[Nearest]", "{Protected}"},
    };

    for (int i = 0; i < (int)(sizeof(tests) / sizeof(tests[0])); i++) {
        assert_eval_eq(tests[i].input, tests[i].expected, 0);
    }
}
```

Register in `main()` (`tests/test_list.c:965-1022`), next to the other
list-op entries:

```c
TEST(test_nearest);
```

### Success Criteria

#### Automated Verification
- [ ] `cd tests/build && make list_tests && ./list_tests` exits 0 and prints
      `All list tests passed!`
- [ ] All 22 acceptance rows pass
- [ ] No regression in the rest of the suite: every other `*_tests` binary still
      passes
- [ ] Clean under valgrind: `valgrind --leak-check=full --error-exitcode=1
      ./list_tests` — no leaks and no invalid reads. This matters specifically
      because the gate's early-return path frees a partially built `dist` vector
      (row 13 exercises it) and the `out` allocation-failure path is otherwise
      untested.

#### Manual Verification
- [ ] Row 20's expected string matches the printer's actual NDArray rendering
      (`1.0` vs `1.`). If the printer disagrees, fix the *expected* string —
      do not change the printer.

**Pause here for confirmation before Phase 3.**

---

## Phase 3: Documentation

### Changes Required

#### 1. `docs/spec/builtins/lists-and-iteration.md`

Add a `## Nearest` section matching the `Tuples` format in the same file
(`docs/spec/builtins/lists-and-iteration.md:29-42`) and borrowing the
"how this differs from its neighbour" bullet from `Split`
(`docs/spec/builtins/structural-manipulation.md:382-384`):

````markdown
## Nearest
Gives the element of a list closest to a target value.
- `Nearest[list, x]`: gives the element of `list` closest to `x`, as a list.

**Features**:
- `Protected`.
- Distance is `Abs[element - x]`, so a complex element uses its modulus.
- **All** elements tied at the minimum distance are returned, in their original
  order: `Nearest[{1, 5, 10}, 3]` gives `{1, 5}`, not `{1}`.
- An empty list gives `{}`.
- Returns unevaluated unless every distance is a real number. A symbolic element
  or target leaves the expression unchanged rather than being dropped from the
  result — unlike
  [`MinimalBy`](structural-manipulation.md#minimalby), which orders symbolic
  keys after all numbers and so silently omits them.

```mathematica
In[1]:= Nearest[{1, 5, 10}, 3]
Out[1]= {1, 5}

In[2]:= Nearest[{10, 20, 30}, 100]
Out[2]= {30}

In[3]:= Nearest[{1, a, 3}, 2]
Out[3]= Nearest[{1, a, 3}, 2]
```
````

Verify the `MinimalBy` cross-reference anchor resolves before committing; if
`MinimalBy` has no section in that file, drop the link and keep the prose.

#### 2. `docs/spec/changelog/2026-08-03.md`

Today (2026-08-07, Friday) is in the ISO week beginning Monday 2026-08-03. That
file **already exists** — append, do not create:

```markdown
## Feature: `Nearest[list, x]` (2026-08-07)

The two-argument `Nearest` gives the element(s) of `list` at minimum
`Abs[element - x]`, as a `List` in original order.

All tied elements are returned: `Nearest[{1, 5, 10}, 3]` is `{1, 5}`, not
`{1}`. The implementation follows `MinimalBy`'s two-pass shape
(`src/sort.c:663-716`) — find the minimum with `expr_compare`, then collect
every distance equal to it — rather than the `RankedMin` quickselect, whose
comparator carries an original-index tiebreak (`src/sort.c:932`) that exists to
make ties impossible and would therefore return a single element. Input order
among ties falls out of the ascending collect pass; no tie logic was written.

Distance composes the existing `internal_subtract` and `internal_abs`
(`src/internal.h:121`, `:83`) as `comparisons.c:313-314` already does; no
distance helper was added. Because `Abs` of a complex difference is its modulus,
`Nearest[{3 + 4 I, 1}, 0]` gives `{1}` with no extra code.

`Nearest` diverges from `MinimalBy` in one respect, deliberately: every distance
must be a real number, or the call stays unevaluated. `MinimalBy[{1, a, 3},
Abs[# - 2] &]` answers `{1, 3}`, dropping the symbolic element because
`expr_compare` orders symbols after all numbers — a plausible wrong answer.
Gating on the distance rather than the element covers a symbolic element, a
symbolic target, and a non-real complex in one check. A symbolic *real* such as
`Pi` is also rejected rather than numericalized; widening that to match
`ranked_numeric_key` is a follow-up.

Only the two-argument form lands here. The `n`-nearest, radius, rule, all-pairs,
and `NearestTo` operator forms, the `DistanceFunction` option, and a packed
fast path are filed separately. A visible `NDArray` argument stays unevaluated
rather than being silently truncated, since the transparency gate does not
materialise it.

New: `src/list/nearest.{c,h}`. Registered in `src/list/list_init.c` with
`Protected`. 22 acceptance rows in `tests/test_list.c::test_nearest`, valgrind
clean.
```

#### 3. `Mathilda_spec.md`

**No change.** The changelog row for `2026-08-03 → 2026-08-09` already exists
(`Mathilda_spec.md:83`), and `Nearest` falls under the existing
lists-and-iteration category row (`Mathilda_spec.md:47`).

### Success Criteria

#### Automated Verification
- [ ] `grep -c "^## Nearest" docs/spec/builtins/lists-and-iteration.md` is 1
- [ ] `grep -c "Nearest" docs/spec/changelog/2026-08-03.md` is non-zero
- [ ] No new file was created under `docs/spec/changelog/`

#### Manual Verification
- [ ] The `MinimalBy` cross-reference anchor resolves, or the link was dropped
- [ ] The three `In[]`/`Out[]` examples reproduce exactly at the REPL

---

## Phase 4: Portability, gates, follow-ups

### Changes Required

#### 1. Portability

`nearest.c` uses no POSIX symbols, no `<math.h>` constants, and no `int64_t`
arithmetic through `checked_int.h`, so it should pass untouched. Verify rather
than assume — this class of bug has shipped twice (issues #36, #37):

```bash
make check-c99
```

#### 2. Packed-array gates

Four of the five are blind to a head with no buffer dispatch and no curated
probe entry — expect no change from `check-packed-aware`,
`check-array-exactness`, `check-nd-surfaces`, `check-compile-coverage`. Run
them to confirm, not to discover.

`check-fastpath-sweep` is the one that discovers new heads by trial from
`Names["*"]`, so it *will* see `Nearest`. Note `Nearest` is already listed in
`SKIP_EXPLOSIVE` (`tools/nd_fastpath_sweep.py:226`) under "output quadratic or
worse" — a classification aimed at the all-pairs `Nearest[list]` form (F4), not
`Nearest[list, x]`. Whether that skip pre-empts the timing half cannot be known
until the sweep runs against a real implementation.

Decision rule, fixed in advance so the outcome is not argued after the fact:

- Sweep is silent about `Nearest` → nothing to do.
- Sweep reports `Nearest` as newly off-buffer → add `"Nearest"` to the
  `OFF_BUFFER` ratchet (`tools/nd_fastpath_sweep.py:608`) **in this diff**, and
  fold the buffer fast path into follow-up F5. Do **not** build a fast path
  here — that would exceed the agreed scope, and `OFF_BUFFER` exists precisely
  to record a known gap without blocking.

#### 3. File the follow-ups

Six issues, F1–F6 as listed under "What We're NOT Doing". Each should carry the
acceptance-row style used here, and F6 should reference row 15 as the row that
changes when the symbolic-real path lands.

### Success Criteria

#### Automated Verification
- [ ] `make check-c99` passes
- [ ] `make check-packed-aware` unchanged
- [ ] `make check-array-exactness` unchanged
- [ ] `make check-nd-surfaces` unchanged
- [ ] `make check-compile-coverage` unchanged
- [ ] `make check-fastpath-sweep` passes, or `"Nearest"` was added to
      `OFF_BUFFER` per the decision rule above
- [ ] Full test suite green: every `*_tests` binary in `tests/build`

#### Manual Verification
- [ ] Linux CI (`.github/workflows/build.yml`) compiles clean against glibc —
      the definitive portability check, since macOS exposes POSIX symbols that
      glibc hides
- [ ] Six follow-ups filed

---

## Testing Strategy

The acceptance table **is** the test suite; there is no second layer. Rows 1–12
cover behaviour, 13–20 cover the unevaluated gate, 21–22 cover the packed
surface and attributes.

Three rows carry disproportionate weight and should not be deleted or weakened
without an explicit decision:

- **Row 1** (`{1, 5}`) is the tie contract. It is the row that fails if anyone
  later "optimises" the two-pass scan into a quickselect.
- **Row 13** (`Nearest[{1, a, 3}, 2]` unevaluated) is the divergence from
  `MinimalBy`. It is the row that fails if the gate is dropped as redundant.
- **Row 5** (exact rational tie) is the row that fails if distances are ever
  compared as machine doubles instead of via `expr_compare`.

Valgrind is not optional for Phase 2: row 13 is the only exercise of the
partial-`dist`-vector free path, and that path is where a leak or double-free
would live.

No `.m` regression file — there is no such suite for list built-ins; the one
`.m` corpus (`tests/fullsimplify_corpus.m`) is `FullSimplify`-specific.

## Performance Considerations

O(n) distance evaluations, O(n) `expr_compare` calls, O(n) peak extra memory.
Each distance is two `internal_*` calls plus two `evaluate` passes, which
dominates — this is an interpreter-speed path, not a buffer path, and is
expected to be slower per element than `Min`.

That is acceptable for the two-argument form and is the honest state of things;
it is also why the `check-fastpath-sweep` outcome in Phase 4 has a decision rule
attached rather than an assumption. Anyone reaching for a packed fast path
should do it under F5, where the `pack.c` `AWARE` entry and the surface-agreement
question (`make check-nd-surfaces`) get considered together.

No caching, no precomputation, no early exit on an exact hit — an exact-hit
short-circuit would be wrong, since a later element can tie at distance 0
(row 6 is the shape of that case).

## Migration Notes

None. `Nearest` is a new symbol; nothing currently evaluates to it, and no
existing behaviour changes. The symbol does not even exist in the table before
this change (`Names["Nearest*"]` → `{}`), so no user code can be relying on the
current unevaluated form.

## References

- Research: `thoughts/shared/research/2026-08-07-nearest-list-builtin.md`
- Tie-collection template: `src/sort.c:663-716` (`maximal_minimal_by`)
- The tiebreak that must **not** be reused: `src/sort.c:921-933` (`ranked_cmp`)
- Bail-on-indefinite policy: `src/sort.c:898-914` (`ranked_numeric_key`),
  `src/sort.c:976-978` (`ranked_select`'s `is_real_numeric` scan)
- `is_listq` guard precedent: `src/sort.c:1014` (`builtin_ranked_min`)
- Distance composition precedent: `src/comparisons.c:313-314`
- Wrapper ownership: `src/internal.c:189-211` (`internal_call_impl`)
- Real-numeric predicate: `src/list/list_common.h:42`
- Registration convention: `src/list/list_init.c:15-24` (`Pick`)
- Test harness: `tests/test_utils.h:18-30`, `tests/test_list.c:877-916`
- Enumerated test sources: `tests/CMakeLists.txt:341-372`
- Docs formats: `docs/spec/builtins/lists-and-iteration.md:29-42` (`Tuples`),
  `docs/spec/builtins/structural-manipulation.md:373-392` (`Split`)
