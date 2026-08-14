# `FindClusters` for 1D numeric lists — Implementation Plan

**Date**: 2026-08-09
**Author**: Michael Sollami
**Base**: `feat/nearest` @ `b487bc67` (PR #53 open)
**Research**: `thoughts/shared/research/2026-08-09-findclusters-foundations.md`
**Reference semantics**: measured against `wolframscript` (Wolfram 14, this machine)

**Scope**: all ten named `Method` values, all three count modes, 1D numeric lists.

---

## Two framing facts, both measured

### 1. Bit-compatibility with Mathematica is not achievable

I probed the real `FindClusters` rather than working from the documentation page:

```
FindClusters[{1,4,9,16,25,36},   3, Method->"Agglomerate"] -> {{36}, {1,4,9}, {16,25}}
FindClusters[{1,2,4,8,16,32,64}, 3, Method->"Agglomerate"] -> {{4,8,16}, {32,64}, {1,2}}
```

Single-linkage on gaps `3,5,7,9,11` must cut the two largest (`11`, `9`), giving
`{1,4,9,16},{25},{36}`. Mathematica cut `11` and `7`. Its own messages show why —
it auto-selects a distance function and **preprocesses the data**, which the docs
confirm but never specify:

```
FindClusters::fewerclust2: ... method Agglomerate and distance function HammingDistance ...
FindClusters::fewerclust2: ... method Agglomerate and distance function EuclideanDistance ...
```

Its `Automatic` count is likewise not a gap rule: `{1,4,9,16,25,36}` (linear gap
growth) splits 3 ways while `{1,2,4,8,16,32,64}` (geometric, far more extreme
gaps) gives 1. The docs attribute it to an unnamed "internal index".

**Consequence**: we implement the *textbook algorithm* for each method with our
own stated semantics, verified by our own acceptance table. No success criterion
in this plan is "matches Mathematica". Divergences are recorded as test rows.

### 2. There are three count modes, not two

The user's point about exact-`n` versus `UpTo[n]` is not a detail — Mathematica
treats them as **three distinct modes with three distinct error classes**, and
the capability matrix differs between them:

```
FindClusters[d, 5]        -> {{12,13},{2,3},{1,1},{10},{25}}       5 clusters, forced
FindClusters[d, UpTo[5]]  -> {{1,2,3,1},{12,13},{10},{25}}         4 clusters, fewer
FindClusters[d, 8]        -> 7 clusters + ::fewerclust + ::fewerclust2
FindClusters[d, UpTo[8]]  -> 7 clusters, silently

FindClusters[d, 3,       Method->"Spectral"] -> ::wrgmthdef,   unevaluated
FindClusters[d, UpTo[3], Method->"Spectral"] -> works
FindClusters[d, UpTo[4], Method->"DBSCAN"]   -> ::wrgmthbound, unevaluated
FindClusters[d,          Method->"KMeans"]   -> ::wrgmthundef, unevaluated
```

`Spectral` accepts a bounded count but rejects a fixed one. Note also that the
documentation bullets (screenshot) place `Spectral` in *neither* constraint list,
implying it accepts both — **the runtime disagrees with the docs, and the runtime
is authoritative**. The allowed-lists in the three messages are the ground truth.

---

## The count-mode × method matrix

Three modes:

| Mode | Surface | Meaning |
|---|---|---|
| **Automatic** | count omitted, or `Automatic` | the method decides how many |
| **Bounded** | `UpTo[n]` | at most `n`; **may be fewer** |
| **Fixed** | `n` | exactly `n`, capped only by the distinct-value count |

Capability, from the three messages' allowed-lists (✓ verified directly, · inferred
from an allowed-list):

| Method | Automatic | Bounded `UpTo[n]` | Fixed `n` |
|---|:---:|:---:|:---:|
| `"Agglomerate"` | ✓ | ✓ | ✓ |
| `"SpanningTree"` | · | · | · |
| `"KMeans"` | ✗ ✓ | ✓ | ✓ |
| `"KMedoids"` | ✗ · | · | · |
| `"Spectral"` | ✓ | ✓ | **✗ ✓** |
| `"DBSCAN"` | ✓ | **✗ ✓** | ✗ ✓ |
| `"GaussianMixture"` | · | ✗ · | ✗ · |
| `"JarvisPatrick"` | · | ✗ · | ✗ · |
| `"MeanShift"` | · | ✗ · | ✗ · |
| `"NeighborhoodContraction"` | · | ✗ · | ✗ · |

Message classes to mirror (we return unevaluated in every ✗ cell):

| Class | Fires when | Allowed-list |
|---|---|---|
| `wrgmthundef` | method needs a count, got Automatic | Agglomerate, DBSCAN, GaussianMixture, JarvisPatrick, MeanShift, NeighborhoodContraction, SpanningTree, Spectral |
| `wrgmthbound` | method rejects a bounded count | Agglomerate, KMeans, KMedoids, SpanningTree, Spectral |
| `wrgmthdef` | method rejects a fixed count | Agglomerate, KMeans, KMedoids, SpanningTree |

`Agglomerate` and `SpanningTree` are the only methods in all three modes.

### Our exact-`n` vs `UpTo[n]` semantics

Mathematica's `UpTo[n]` runs its internal index over candidate counts bounded by
`n` — `UpTo[4]` on the canonical data gives **4** even though `Automatic` gives
3, so it is not `min(automatic, n)`. Not reproducible. Ours is defined cleanly:

- **Fixed `n`** — produce exactly `n` clusters. Cap at the number of distinct
  values (`n=8` over 7 distinct values yields 7). `n <= 0` or non-integer →
  unevaluated.
- **Bounded `UpTo[n]`** — run the method's own Automatic count determination,
  then **cap** at `n`. If the natural count is ≤ `n`, return it unchanged;
  otherwise reduce to exactly `n` by the method's own coarsening rule (for the
  gap family: cut only the `n-1` largest gaps).
- **Automatic** — the method's own rule (§ "Our Automatic count").

So on the canonical data, where our Automatic gives 3:
`FindClusters[d, 4]` → **4**, `FindClusters[d, UpTo[4]]` → **3**,
`FindClusters[d, UpTo[2]]` → **2**. That contrast is three acceptance rows.

---

## Task graph

Twenty-one tasks, six waves. Two architectural decisions create the parallelism:

- **T4's `fc_emit_clusters(assign[], k)`** — every method produces only a
  per-element assignment array, so result construction and both OOM unwinds are
  written once and the ten algorithms never touch them.
- **T6's sorted-neighbourhood kernel** — eps-window, k-NN window and kernel
  density on the sorted array, shared by the five density-family methods, which
  otherwise would each re-derive it.

```
WAVE A  (3 parallel, no deps)
  T1 promote numeric comparator to list_common
  T2 symbols (DistanceFunction, CriterionFunction, PerformanceGoal, suboptions)
  T3 skeleton + registration + build wiring

WAVE B  (2 parallel)
  T4 decode / numeric gate / sorted order / fc_emit_clusters      [T1, T3]
  T5 option parser + 3-mode count decode + 10x3 matrix            [T2, T3]

WAVE B2 (2 parallel)
  T6 sorted-neighbourhood kernel: eps window, kNN, KDE            [T4]
  T7 count-selection helper: Automatic rule + fixed/bounded caps  [T4]

WAVE C  (the fan-out — 9 tracks)
  T8  Agglomerate == SpanningTree        [T4, T5, T7]
  T9  KMeans                             [T4, T5, T7]
  T10 KMedoids                           [T9]            <- sequence, shares Lloyd loop
  T11 DBSCAN                             [T6, T7]
  T12 MeanShift                          [T6, T7]
  T13 NeighborhoodContraction            [T12]           <- sequence, shares mode merge
  T14 JarvisPatrick                      [T6, T7]
  T15 GaussianMixture                    [T4, T5, T7]
  T16 Spectral                           [T6, T7, linalg eigen]
  T17 Method -> Automatic selection      [T8..T16 enum only; body last]

WAVE D
  T18 acceptance table  [incremental: rows land with each Wave C task]
  T19 docs + changelog  [T8..T17 final semantics]

WAVE E
  T20 gates, leaks, fastpath ratchet decision   [everything]
  T21 PerformanceGoal / CriterionFunction wiring (optional)  [T17]
```

### Dependency table

| Task | Depends on | Blocks | Parallel with | Size |
|---|---|---|---|---|
| T1 comparator promotion | — | T4, all methods | T2, T3 | S |
| T2 symbols | — | T5 | T1, T3 | XS |
| T3 skeleton + wiring | — | T4, T5 | T1, T2 | S |
| T4 decode/gate/emit | T1, T3 | T6, T7, methods | T5 | M |
| T5 options + matrix | T2, T3 | all methods | T4 | M |
| T6 neighbourhood kernel | T4 | T11, T12, T14, T16 | T7 | M |
| T7 count selection | T4 | all methods | T6 | S |
| T8 Agglomerate/SpanningTree | T4, T5, T7 | T18, T19 | T9, T11, T12, T14, T15, T16 | M |
| T9 KMeans | T4, T5, T7 | T10 | T8, T11, T12, T14, T15, T16 | M |
| T10 KMedoids | T9 | T18 | T8, T11–T16 | S |
| T11 DBSCAN | T6, T7 | T18 | T8, T9, T12, T14, T15, T16 | M |
| T12 MeanShift | T6, T7 | T13 | T8, T9, T11, T14, T15, T16 | M |
| T13 NeighborhoodContraction | T12 | T18 | T8–T11, T14–T16 | S |
| T14 JarvisPatrick | T6, T7 | T18 | T8–T13, T15, T16 | M |
| T15 GaussianMixture | T4, T5, T7 | T18 | T8–T14, T16 | L |
| T16 Spectral | T6, T7, linalg | T18 | T8–T15 | L |
| T17 Automatic method selection | T8–T16 | T18, T19 | — | S |
| T18 acceptance table | T8–T17 (incrementally) | T20 | T19 | L |
| T19 docs + changelog | T8–T17 | T20 | T18 | M |
| T20 gates + leaks | all | — | — | S |
| T21 PerformanceGoal/Criterion | T17 | — | — | S |

### Critical path

`T1 → T4 → T7 → T8 → T18 → T20`. Everything else has slack. **T15 (GaussianMixture)
and T16 (Spectral) are the two large tasks and are not on the critical path** —
start them early in Wave C so their length is absorbed by the other tracks.

### Two places where maximum parallelism is the wrong call

- **T10 after T9.** KMedoids reuses the KMeans assign/update skeleton, changing
  only the centre computation (medoid rather than mean). Parallel costs more
  total work and leaves two near-identical loops to reconcile.
- **T13 after T12.** NeighborhoodContraction and MeanShift both shift points
  toward density maxima and then merge coincident modes; the merge step is
  identical.

### Cut lines, if scope must shrink

In order of what to drop first, each removable without touching the others:
T16 Spectral → T15 GaussianMixture → T14 JarvisPatrick → T13 → T12 → T10.
Never cut T1, T4, T5, T7 — those are foundation and everything compiles against
them. Minimum shippable: T1–T8, T17–T20 (Agglomerate/SpanningTree in all three
count modes, correct matrix behaviour for the rest via honest declines).

---

## Current state

`FindClusters` does not exist; `Names["FindClusters*"]` is empty.

Verified present on `feat/nearest`:
- Numeric comparator (`nearest_sign`, `nearest_cmp`, `nearest_is_real_number`) —
  correct, but **all three `static`** in `src/list/nearest.c`; `nearest.h` exports
  only `builtin_nearest`. This is T1.
- `internal_sort` (`internal.h:132`), `builtin_ordering` (`sort.h`, public),
  `internal_subtract`, `internal_mean`, `internal_total`.
- Eigen machinery under `src/linalg/` (`eigen.c`, `eigen_direct.c`) for T16.
- `SYM_Method`, `SYM_Automatic`, `SYM_UpTo` exist (`sym_names.h:349, 57, 554`);
  `SYM_DistanceFunction`, `SYM_CriterionFunction`, `SYM_PerformanceGoal` do not.
- `findmin.c:194-270` — the multi-option-parser model.
- `Abs` declines on bigint-component rationals (`complex.c:418-421`). **A sorted
  1D pass never needs `Abs`** — gaps between sorted neighbours are non-negative
  by construction — so this landmine is avoided, not inherited.

---

## Our semantics, stated

**Distance.** `|a − b|` on the line, as a signed difference plus a sign read —
never via `Abs`.

**Cluster ordering.** By first occurrence of any member in the input.
Mathematica's is unstable (`Automatic` and `n=3` disagree on the same input);
first-occurrence matches `Gather`'s documented convention.

**Element ordering within a cluster.** Input order.

**`n` is capped, never exceeded.** With fewer distinct values than `n`, fewer
clusters come back. We do this silently (Mathematica emits `::fewerclust`).

**Our Automatic count.** Cut every sorted-adjacent gap strictly greater than
`FC_GAP_FACTOR × median gap`, with `FC_GAP_FACTOR = 3`; if none qualifies, one
cluster. Deterministic, scale-invariant, O(n log n). Reproduces Mathematica on
`{1,2,10,12,3,1,13,25}` → 3, `{1,2,3,100,101,102}` → 2,
`{1,2,3,20,21,22,500}` → 3, `{1..8}` → 1, `{7,7,7,7}` → 1. **Diverges** on
`{1,4,9,16,25,36}` (ours 1, theirs 3) and `{5,6}` (ours 1, theirs 2) — both get
acceptance rows.

> `FC_GAP_FACTOR` is a heuristic fitted to the probed cases, not a recovered
> internal index. One named constant at the top of the file, so the rows that
> change when it is tuned are obvious.

Methods with their own natural count (DBSCAN, MeanShift, NeighborhoodContraction,
JarvisPatrick, GaussianMixture) use **their own** determination in Automatic mode,
not the gap rule.

---

## Phase 1 — Wave A: foundations (T1, T2, T3 parallel)

### T1 — Promote the numeric comparator

**Files**: `src/list/nearest.c`, `src/list/list_common.{c,h}`

| From (`nearest.c`, static) | To (`list_common.c`, exported) |
|---|---|
| `nearest_is_real_number` | `list_real_number_q(Expr*)` |
| `nearest_sign` | `list_numeric_sign(Expr*, bool* ok)` |
| `nearest_cmp` | `list_numeric_cmp(Expr*, Expr*, bool* ok)` |

Bodies unchanged — correct and leak-free. `nearest.c` keeps `nearest_distance`
and calls the promoted names. `list_common.c` gains `#include "internal.h"` and
`<math.h>`. **Carry the comments across verbatim**, especially the two recording
bug history: why `expr_compare` is wrong in both directions, and why `bool* ok`
exists rather than `expr_numeric_sign`'s silent `0`.

Pure refactor, zero behaviour change — which the 29 existing `Nearest` rows prove.

### T2 — Symbols

`src/sym_names.{h,c}`, three sites each: `SYM_DistanceFunction`,
`SYM_CriterionFunction`, `SYM_PerformanceGoal`, `SYM_NeighborhoodRadius`,
`SYM_MinPoints`. `SYM_FindClusters` is **not** needed.

### T3 — Skeleton, registration, wiring

New `src/list/find_clusters.{c,h}`; header declares only
`Expr* builtin_find_clusters(Expr* res);`. Edits: `src/list/list.h` include;
`src/list/list_init.c` registration triple (`symtab_add_builtin`,
`|= ATTR_PROTECTED`, `symtab_set_docstring`); **`tests/CMakeLists.txt:341-373`**
add `../src/list/find_clusters.c` (enumerated, not globbed — omitting it breaks
all 405 test binaries at link). No `makefile` change.

### Wave A criteria

- [ ] `make -j` clean, no new warnings under `-Werror=unused-function`
- [ ] `./list_tests` — 29 `Nearest` rows pass unchanged (proves T1 neutral)
- [ ] `Names["FindClusters*"]` → `{FindClusters}`; `Attributes` → `{Protected}`
- [ ] `python3 tools/check_c99_portability.py` exits 0

---

## Phase 2 — Wave B: the spine (T4, T5 parallel)

### T4 — Decode, gate, order, and `fc_emit_clusters`

1. **Shape guard** — `is_listq`; else `NULL`. Empty list → `NULL` (matches
   Mathematica's `::mlmpty`).
2. **Numeric gate** — every element `list_real_number_q`. One symbolic element
   declines the whole call. (Mathematica clusters symbolics as nominal; we are
   numeric-only — documented divergence.)
3. **Sorted index permutation** — sort `0..n-1` by value with
   `list_numeric_cmp`, original index as stable tiebreak. **Not `expr_compare`** —
   that is the `Nearest` bug. Undecidable comparison → decline.
4. **`fc_emit_clusters`** — the interface that makes Wave C parallel:

```c
/* Build {{...}, {...}} from a per-element cluster assignment.
 *
 * assign[i] is the cluster id of input element i in 0..k-1. Clusters come out
 * ordered by FIRST OCCURRENCE in the input, elements within a cluster in input
 * order -- both fall out of two ascending passes, no comparator, no sort.
 *
 * Every method produces an assignment array and calls this, so result
 * construction and its two OOM unwinds are written exactly once. */
static Expr* fc_emit_clusters(Expr** elem, size_t n, const size_t* assign, size_t k);
```

Pass one counts per cluster and records first-occurrence order; pass two fills.
Sizes exact after pass one → **fixed pre-sized vectors**, no growable buffer
(`split.c:15` idiom). Head is `SYM_List` at both levels (`Gather`/`Tally`
convention). **Two OOM unwinds**, inner and outer, each holding the head in a
named local so it can be freed — the `nearest.c:214-220` fix applied twice.

### T5 — Option parser, count-mode decode, and the matrix

Model: `findmin.c:194-270`.

```c
typedef enum { FC_AGGLOMERATE, FC_SPANNINGTREE, FC_KMEANS, FC_KMEDOIDS,
               FC_DBSCAN, FC_GAUSSIANMIXTURE, FC_JARVISPATRICK, FC_MEANSHIFT,
               FC_NEIGHBORHOODCONTRACTION, FC_SPECTRAL,
               FC_METHOD_AUTOMATIC } FcMethod;

typedef enum { FC_COUNT_AUTOMATIC, FC_COUNT_BOUNDED, FC_COUNT_FIXED } FcCountMode;
typedef struct { FcCountMode mode; size_t n; } FcCount;
```

Count decode, following `subsets.c:69-73`'s three-valued status pattern:
absent / `Automatic` → `FC_COUNT_AUTOMATIC`; `UpTo[n]` with `n >= 1` →
`FC_COUNT_BOUNDED`; positive integer → `FC_COUNT_FIXED`; anything else → `NULL`.

**The 10×3 matrix is a static table checked before any method runs**, returning
`NULL` for a ✗ cell:

```c
/* [method][mode] : Automatic, Bounded, Fixed */
static const bool FC_ALLOWED[10][3] = {
    /* Agglomerate             */ { true,  true,  true  },
    /* SpanningTree            */ { true,  true,  true  },
    /* KMeans                  */ { false, true,  true  },
    /* KMedoids                */ { false, true,  true  },
    /* Spectral                */ { true,  true,  false },
    /* DBSCAN                  */ { true,  false, false },
    /* GaussianMixture         */ { true,  false, false },
    /* JarvisPatrick           */ { true,  false, false },
    /* MeanShift               */ { true,  false, false },
    /* NeighborhoodContraction */ { true,  false, false },
};
```

`DistanceFunction` in 1D: accept `Automatic`, `EuclideanDistance`,
`ManhattanDistance`, `SquaredEuclideanDistance`. **All are monotone transforms of
`|a−b|` on a line, so all four give identical partitions for every
distance-ranking method**; only `KMeans`, whose objective *is* squared Euclidean,
is defined by the choice. State this equivalence in the docs so accepting four
names is not mistaken for four implementations. Any other value → `NULL`.

Method suboptions via `Method -> {name, opt -> v}`: `"NeighborhoodRadius"` (T11,
T12, T13), `"MinPoints"` (T11), `"NeighborCount"` (T14).

### Wave B criteria

- [ ] `FindClusters[{}]`, `[5]`, `[{1,a,3}]`, `[{{1,2},{3,4}}]` unevaluated
- [ ] Every ✗ cell of the matrix returns unevaluated; every ✓ cell reaches a method
- [ ] `FindClusters[{1,2,3}, 0]`, `[{1,2,3}, -1]`, `[{1,2,3}, x]`, `[{1,2,3}, UpTo[0]]` unevaluated

---

## Phase 3 — Wave B2: shared machinery (T6, T7 parallel)

### T6 — Sorted-neighbourhood kernel

Everything the density family needs, computed once on the sorted array:

- `fc_eps_window(vals, n, i, eps, &lo, &hi)` — the contiguous index range within
  `eps` of point `i`. Two-pointer over the whole array is O(n), not O(n log n)
  per point.
- `fc_knn_window(vals, n, i, k, &lo, &hi)` — the `k` nearest neighbours of `i`;
  in 1D they are contiguous around `i`, found by expanding whichever side is
  closer. O(k).
- `fc_kde(vals, n, x, bandwidth)` — Gaussian kernel density at `x`.
- `fc_median_gap(vals, n)` — shared default scale for eps and bandwidth.

Every one of these is O(n) or O(k) **because the array is sorted** — the same
operations in general dimension are the expensive part of these algorithms. This
is why all five density methods are tractable here.

### T7 — Count selection

```c
/* Reduce a method's natural cluster count to what the count mode requires.
 *   FC_COUNT_AUTOMATIC : natural, unchanged
 *   FC_COUNT_BOUNDED   : min(natural, n)
 *   FC_COUNT_FIXED     : exactly n, capped at the distinct-value count
 * Returns the target count; the caller's coarsen/refine step reaches it. */
static size_t fc_target_count(size_t natural, FcCount spec, size_t n_distinct);
```

Plus `fc_automatic_gap_count(gaps, n, FC_GAP_FACTOR)` implementing the median-gap
rule for the gap family.

---

## Phase 4 — Wave C: the ten methods

Each Wave C task writes one function of one signature and nothing else:

```c
/* Fill assign[0..n-1] with ids 0..*k-1 over the sorted permutation.
 * Return false to decline the whole call. */
static bool fc_method_X(const double* vals, const size_t* order, size_t n,
                        FcCount spec, const FcOpts* o, size_t* assign, size_t* k);
```

### T8 — `"Agglomerate"` ≡ `"SpanningTree"` (all three modes)

**One code path for both names — a proven equivalence, not a shortcut.**
Single-linkage clustering equals cutting the largest MST edges, and in 1D the MST
of points on a line *is* the sorted adjacency chain. Confirmed empirically: the
two methods agree on every probe, with and without a count.

- Automatic → cut gaps `> FC_GAP_FACTOR × median gap`
- Fixed `n` → cut the `n-1` largest gaps (stable: earlier gap wins a tie)
- Bounded `UpTo[n]` → the Automatic cut set, truncated to its `n-1` largest

O(n log n). No `Abs`.

### T9 — `"KMeans"` (Bounded, Fixed)

1D Lloyd. **Deterministic quantile init** — centroid `j` starts at sorted position
`⌊(j + ½)·n/k⌋` — so no `RandomSeeding` and results are reproducible run to run.
Because points and centroids are both sorted, assignment is a merge walk:
O(n + k) per iteration, not O(nk). Iterate to a fixed point or 100 iterations.
Machine doubles are correct here — KMeans minimises squared Euclidean distance
and its centre is a mean, so the result is inexact by definition.

### T10 — `"KMedoids"` (Bounded, Fixed) — *after T9*

Same skeleton; the centre is the medoid rather than the mean. In 1D the
cost-minimising medoid of a contiguous run is its median element, so the update
is an O(1) index lookup per cluster after the sort.

### T11 — `"DBSCAN"` (Automatic only)

Suboptions `"NeighborhoodRadius"` (eps, default `FC_GAP_FACTOR × median gap` —
the same constant as T8, deliberately, so simple data agrees and there is one
tunable) and `"MinPoints"` (default 2 in 1D). Core points via `fc_eps_window`,
then a single left-to-right sweep joins overlapping cores. Noise points become
**singleton clusters** rather than being dropped, so no input element vanishes —
pinned by a row.

### T12 — `"MeanShift"` (Automatic only)

Each point climbs the kernel density estimate to a mode; points converging to the
same mode (within a merge tolerance) form a cluster. `fc_kde` from T6; bandwidth
defaults to the median gap. Iteration cap 100.

### T13 — `"NeighborhoodContraction"` (Automatic only) — *after T12*

Iteratively replace each point by the mean of its `NeighborhoodRadius`
neighbourhood, contracting toward density maxima, then merge coincident points.
Shares T12's mode-merging step exactly; only the update rule differs.

### T14 — `"JarvisPatrick"` (Automatic only)

Shared-nearest-neighbour: build k-NN lists with `fc_knn_window`
(`"NeighborCount"`, default 5, capped at `n-1`), then join two points when they
are in each other's k-NN list and share at least `t` neighbours (default
`⌈k/2⌉`). Union-find over the joins.

### T15 — `"GaussianMixture"` (Automatic only) — *large*

1D EM over `k` Gaussians with a variational/BIC penalty selecting `k` from
`1..k_max` (`k_max = min(10, n_distinct)`). Deterministic quantile init as in T9.
Assign each point to its highest-responsibility component. Components that
collapse (weight below a floor, or variance below a floor) are pruned — which is
what makes Mathematica return a single cluster on the canonical data.

Guard the variance floor explicitly: identical points give zero variance and a
singular Gaussian, and `{7,7,7,7}` must not divide by zero.

### T16 — `"Spectral"` (Automatic, Bounded) — *large*

Gaussian similarity matrix, normalised Laplacian, eigenvectors via the existing
`src/linalg/` eigen path, then cluster the leading eigenvector coordinates with
T9's KMeans. Count from the eigengap heuristic in Automatic mode, capped in
Bounded mode. **Rejects Fixed mode** per the matrix.

Note honestly in the file header: in 1D a Gaussian-similarity graph is nearly a
path graph, so its Fiedler vector largely recovers the sorted order, and spectral
clustering degenerates toward the gap cuts of T8. It is implemented as specified,
but on 1D data it is not expected to be interestingly different from `Agglomerate`
— an acceptance row pins whatever it does rather than asserting a difference.

O(n²) memory for the similarity matrix — **cap `n` and decline above it**
(suggest 2000), rather than allocating 8 GB for a 10⁵ list. That cap is a row.

### T17 — `Method -> Automatic`

Selects by count mode, using only methods valid in that mode:

| Mode | Choice | Why |
|---|---|---|
| Automatic | `Agglomerate` | valid in all modes, deterministic, no tunable beyond `FC_GAP_FACTOR` |
| Bounded | `Agglomerate` | same |
| Fixed | `Agglomerate` | same |

Deliberately *not* a criterion-driven search over methods — that is Mathematica's
unpublished internal index, and pretending to reproduce it is what this plan
avoids. Documented as "Automatic currently means Agglomerate"; T21 can make it
criterion-driven later.

### Wave C criteria

- [ ] `FindClusters[{1,2,10,12,3,1,13,25}]` → `{{1, 2, 3, 1}, {10, 12, 13}, {25}}`
- [ ] `Agglomerate` and `SpanningTree` produce **identical** output on every row
- [ ] Fixed/Bounded contrast holds: `[d, 4]` → 4 clusters, `[d, UpTo[4]]` → 3
- [ ] Every method returns a partition of the input — no element lost, none duplicated
- [ ] Every ✓ cell of the matrix produces a result; every ✗ cell unevaluated
- [ ] `{7,7,7,7}` does not divide by zero in T15; `Spectral` declines above its cap
- [ ] Build clean; `./list_tests` green

**Manual**
- [ ] 10⁵-element list per method returns in reasonable time (no accidental O(n²)
      outside T16, which is capped)

---

## Phase 5 — Wave D: acceptance table and docs

### T18 — `test_find_clusters()` in `tests/test_list.c`

Written incrementally; each Wave C task adds its rows. Uses `assert_eval_eq`
(`test_utils.h:18-30`), registered with `TEST(test_find_clusters);`.

**Every expected value must be pasted from the built binary, never
hand-predicted.** That discipline is exactly what the `Nearest` table lacked on
its mixed-type rows, and it cost a high-severity bug.

Row groups (~75 rows):

**Count modes — the contrast the user asked for**

| Input | Expected |
|---|---|
| `FindClusters[{1,2,10,12,3,1,13,25}]` | `{{1, 2, 3, 1}, {10, 12, 13}, {25}}` |
| `FindClusters[{1,2,10,12,3,1,13,25}, 4]` | exactly 4 clusters |
| `FindClusters[{1,2,10,12,3,1,13,25}, UpTo[4]]` | 3 clusters — **fewer than 4** |
| `FindClusters[{1,2,10,12,3,1,13,25}, UpTo[2]]` | 2 clusters — capped below natural |
| `FindClusters[{1,2,3}, 5]` | `{{1}, {2}, {3}}` — capped at distinct count |
| `FindClusters[{1,2,3}, UpTo[5]]` | 1 cluster — natural, silently under the bound |
| `FindClusters[{7,7,7,7}, 3]` | `{{7, 7, 7, 7}}` — one distinct value |
| `FindClusters[{1,2,3}, 1]` | `{{1, 2, 3}}` |
| `FindClusters[{1,2,3}, 0]` / `-1` / `x` / `UpTo[0]` | unevaluated |

**The 10×3 matrix** — 30 rows, one per cell: ✓ cells produce a partition, ✗ cells
unevaluated. This is the largest group and the one that fails if the matrix table
is ever edited carelessly.

**Method dispatch**

| Input | Expected |
|---|---|
| `Method->"SpanningTree"` on canonical | **identical to `Method->"Agglomerate"`** |
| each of the ten names, in a valid mode | a partition of the input |
| `Method->"Nonsense"` | unevaluated |
| `Method->{"DBSCAN", "NeighborhoodRadius"->2}` | suboption honoured |

**Documented divergences from Mathematica** — pinned so they surface as diffs

| Input | Ours | Mathematica |
|---|---|---|
| `FindClusters[{1,4,9,16,25,36}]` | `{{1, 4, 9, 16, 25, 36}}` | `{{36},{1,4,9,16},{25}}` |
| `FindClusters[{5,6}]` | `{{5, 6}}` | `{{5},{6}}` |
| `FindClusters[{1,a,3}, 2]` | unevaluated | `{{a},{1,3}}` |
| `FindClusters[d, UpTo[4]]` | 3 clusters | 4 clusters |

**Exact arithmetic — the `Abs`-free payoff**

| Input | Expected |
|---|---|
| `FindClusters[{1/3, 2/3, 10, 31/3}, 2]` | `{{1/3, 2/3}, {10, 31/3}}` |
| `FindClusters[{1/10^25, 2/10^25, 1}, 2]` | works — **`Nearest` cannot**, it routes through `Abs` (`complex.c:418-421`). Fails if anyone rewrites a gap as `Abs[b-a]`. |
| `FindClusters[{1, 2.0, 10, 11.0}, 2]` | `{{1, 2.0}, {10, 11.0}}` |

**Order contract** — fail if anyone sorts the output

| Input | Expected |
|---|---|
| `FindClusters[{10, 1, 11, 2}]` | `{{10, 11}, {1, 2}}` — first occurrence is 10 |
| `FindClusters[{3, 1, 2}, 1]` | `{{3, 1, 2}}` — input order within cluster |

**Shape, degenerate, attributes**: `{}` unevaluated; `5`, `f[1,2,3]`,
`{{1,2},{3,4}}`, `NDArray[...]` unevaluated; `Range[10]` (packed) works;
`{5}` → `{{5}}`; `Attributes[FindClusters]` → `{Protected}`.

**Invariant rows** worth adding as a loop rather than a table: for every method
in a valid mode, `Sort[Flatten[FindClusters[d, ...]]] === Sort[d]` — no element
lost or duplicated. One assertion catching a whole class of bugs across ten
implementations.

### T19 — Docs and changelog

- `docs/spec/builtins/lists-and-iteration.md` — `## FindClusters` after
  `## Nearest` (ends line 387). Must state: the three count modes and the
  exact/bounded distinction; the full 10×3 matrix; our `Automatic` rule and its
  constant; that `Agglomerate` ≡ `SpanningTree` in 1D; that the four accepted
  `DistanceFunction` values coincide in 1D; the ordering contract; the `Spectral`
  size cap; and that we do **not** reproduce Mathematica's output in general.
- `docs/spec/changelog/` — today 2026-08-09 (Sun) is in the ISO week of Monday
  **2026-08-03**, so `2026-08-03.md` is correct and exists — append. If the work
  lands after Sunday, create `2026-08-10.md` with the `# Changelog: week of …`
  heading **and** add a row to `Mathilda_spec.md`'s table (`:83` is last).
- `Mathilda_spec.md`: no change if it lands this week — the category row (`:47`)
  covers it.
- Verify every anchor before linking. `## Abs` does not exist under
  `docs/spec/builtins/` (this bit the `Nearest` docs).

---

## Phase 6 — Wave E: gates and leaks (T20)

**Portability**: `python3 tools/check_c99_portability.py`. `isnan`, `fabs`,
`sqrt`, `exp`, `log` are C99 — no feature-test macro. **`M_PI` is not** — T15's
Gaussian needs it, so add the guarded fallback right after `#include <math.h>`,
matching `src/trig.c`:

```c
#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif
```

**Packed-array gates**: `check-packed-aware`, `check-array-exactness`,
`check-nd-surfaces`, `check-compile-coverage` are blind to a head with no ND
dispatch and no curated probe. Run to confirm, not to discover.

**`check-fastpath-sweep` — the one that will fire.** Unlike `Nearest` (excluded
via `SKIP_EXPLOSIVE`, `nd_fastpath_sweep.py:226`, filtered at discovery `:692`),
`FindClusters` has linear output and a single list argument, so it **will** be
discovered and gated. Decision rule, fixed now:

- silent → nothing to do
- reports `FindClusters` off-buffer → **add `"FindClusters"` to `OFF_BUFFER`
  (`:608`) in this diff**, file the fast path as a follow-up. Do not build one
  here.
- if T16's similarity matrix makes a probe quadratic → add to `SKIP_EXPLOSIVE`
  instead, following the `Nearest` precedent

**Leaks** — differential; valgrind is unavailable on Apple Silicon and a single
at-exit run is noisy:

```bash
export MallocStackLogging=1
leaks --atExit -- ./Mathilda -file fc_leak_lo.m   # N=200
leaks --atExit -- ./Mathilda -file fc_leak_hi.m   # N=20000
# both must report 0 leaks / 0 total leaked bytes
```

The script must exercise **every method and every decline path** — the ✗ matrix
cells, bad specs, symbolic input, the `Spectral` cap. Decline paths hold the
partially built unwinds, and both OOM unwinds in `fc_emit_clusters` are
nested-result-specific.

**Regression**: the 17-binary blast-radius subset (list/array/sort/packing) with
a per-test timeout via background `kill` — `perl -e 'alarm N; exec'` does not
work here. The full 405-binary suite cannot run serially in budget and
`integrate_risch_transcendental_tests` hangs.

**Pre-existing failures — do not attribute to this work** (each proven by
stashing during the `Nearest` work): `flint_bridge_tests` (link, FLINT off),
`core_tests` (SIGABRT in `test_quotient`), `vandermondematrix_tests` (SIGABRT),
`factorlist_tests` (sign normalisation), and `check-compile-coverage` red on
`DesignMatrix`/`Fit`/`InterpolatingPolynomial`/`Interpolation`.

### T21 — `PerformanceGoal` / `CriterionFunction` (optional)

Both are accepted-and-parsed by T5 but do not change behaviour, which is only
honest if documented. If implemented: `PerformanceGoal -> "Speed"` caps iteration
counts and skips T16; `CriterionFunction` drives a real Automatic method search
across the ten. **Accepting an option that does nothing must be stated in the
docs**, not left implicit.

---

## Testing strategy

The acceptance table is the specification. Rows carrying disproportionate weight:

- **The Fixed/Bounded contrast** (`[d, 4]` → 4 vs `[d, UpTo[4]]` → 3) — the
  distinction this revision exists to get right.
- **The 30 matrix rows** — fail if the capability table is edited carelessly.
- **`Agglomerate` ≡ `SpanningTree`** — fails if they drift into two implementations.
- **The bigint-rational row** — fails if a gap is ever computed via `Abs`.
- **The partition invariant** across all ten methods — one assertion, whole bug class.
- **The two order rows** — fail if output is sorted.
- **The four divergence rows** — the honest record that we are not Mathematica.

Performance: one 10⁵-element timing spot-check per method to catch accidental
O(n²). Not a checked-in benchmark (`bench_assoc.c` is Association-only and there
is no list-op equivalent).

---

## Performance

All methods are O(n log n) dominated by the initial sort, **except** T16
(Spectral), which is O(n²) in memory and O(n³) in the eigensolve and is therefore
size-capped and declines above the cap. T6's sorted-array primitives are what
keep the density family linear — the same operations in general dimension are the
expensive part of those algorithms.

This is an interpreter-speed path, not a buffer path: the gate and comparator
allocate per element on the slow paths. Deliberate, and the reason T20 carries an
`OFF_BUFFER` decision rule rather than an assumption.

---

## References

- Research: `thoughts/shared/research/2026-08-09-findclusters-foundations.md`
- Comparator to promote: `src/list/nearest.c:62-146`
- Why not `expr_compare`: `src/sort.c:372-377`
- `Abs` landmine: `src/complex.c:418-421`
- Option-parser model: `src/findmin.c:194-270`
- Nested-result idioms: `src/list/split.c:15,42-53`; `src/assoc.c:906-959`
- OOM unwind: `src/list/nearest.c:214-220`
- Emit-order convention: `Gather`, `src/assoc.c:906-959`
- Eigen for T16: `src/linalg/eigen.c`, `eigen_direct.c`
- Registration: `src/list/list_init.c:90-98`
- Test harness: `tests/test_utils.h:18-30`; `tests/test_list.c:965-1063`
- Enumerated test sources: `tests/CMakeLists.txt:341-373`
- Sweep ratchet: `tools/nd_fastpath_sweep.py:226,608,692`
- `M_PI` guard precedent: `src/trig.c`
