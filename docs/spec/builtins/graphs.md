# Graphs

A graph subsystem modeled on the Wolfram Language's, implemented in
`src/graph/` (one builtin per translation unit, mirroring `src/linalg/`).
Graphs are ordinary `Expr` trees — there is **no new `EXPR_*` tag** — of the
canonical form

```
Graph[ List[v1, v2, ...], List[edge1, edge2, ...] ]
```

where each edge is `DirectedEdge[u, v]` or `UndirectedEdge[u, v]`. On
construction, `Rule`/`u -> v` is accepted as shorthand for `DirectedEdge`, and
`TwoWayRule`/`u <-> v` for `UndirectedEdge`. Vertices are arbitrary
expressions. Because graphs are plain expressions, generic tools (`Part`,
`Map`, `ReplaceAll`, …) work on them, and `AdjacencyMatrix[g]` returns a dense
`List`-of-`List`s consumable directly by `Det`, `Tr`, and `Eigenvalues`.

**MVP scope (locked):** simple graphs only — no parallel edges, no self-loops,
no edge tags, no multigraphs, no hypergraphs, and no edge/vertex weights.
`WeightedAdjacencyMatrix` and edge weights are a documented future extension.

**Auto-display.** A bare valid `Graph[...]` result renders itself as a
node-link diagram — the REPL owns display the same way it does for `Graphics`
and `Plot` (see `src/repl.c`). In the notebook it appears as a drawn graph
rather than the `Graph[<n vertices, m edges>]` summary; `InputForm[g]` and
`FullForm[g]` still print the literal constructor. The auto-rendered picture
uses the default (circular) layout and styling; use `GraphPlot`/`HighlightGraph`
for explicit layout and styling control.

## Graph
A graph value.
- `Graph[v, e]`: a graph with vertex list `v` and edge list `e`.
- `Graph[e]`: derives the vertex set from the edges, in first-appearance order
  (directed by default).

On construction the edge list is normalized and validated, producing the
canonical `Graph[List[verts], List[edges]]`:
- `u -> v` (`Rule`) and `DirectedEdge[u, v]` become `DirectedEdge[u, v]`.
- `u <-> v` (`TwoWayRule`) and `UndirectedEdge[u, v]` become
  `UndirectedEdge[u, v]`.

Malformed input is left unevaluated: self-loops, parallel/duplicate edges,
3-argument edges, or an edge endpoint absent from an explicit vertex list.
(Anti-parallel directed edges `u -> v` and `v -> u` are distinct and allowed.)

Printing: in standard output a graph shows a terse summary,
`Graph[<n vertices, m edges>]`. `InputForm` and `FullForm` print the literal
constructor, which round-trips through the parser.

```
Graph[{1,2,3,4}, {1->2, 2->3, 3->4, 4->1}]   (* Graph[<4 vertices, 4 edges>] *)
InputForm[Graph[{1,2}, {1<->2}]]              (* Graph[{1, 2}, {1 <-> 2}]      *)
```

## GraphQ
`GraphQ[g]` gives `True` if `g` is a valid graph, and `False` otherwise. A graph
is valid when it is the canonical `Graph[List, List]` with every edge a
2-argument `DirectedEdge`/`UndirectedEdge`, no self-loops, no parallel edges,
and every endpoint present in the vertex list.

```
GraphQ[Graph[{1,2}, {1->2}]]   (* True  *)
GraphQ[Graph[{1},   {1->1}]]   (* False -- self-loop *)
GraphQ[5]                      (* False *)
```

## Query / representation

All are thin readers over the canonical form and return unevaluated on a
non-graph argument.

- `VertexList[g]` — the vertices, in canonical order.
- `EdgeList[g]` — the edges (canonical `Directed`/`UndirectedEdge` form).
- `VertexCount[g]` / `EdgeCount[g]` — cardinalities.
- `AdjacencyList[g]` — `{neighbors(v1), …}` in vertex order;
  `AdjacencyList[g, v]` — neighbors of `v`. Directed edges contribute
  successors (`v -> u` makes `u` a neighbor of `v`); undirected edges go both
  ways.
- `VertexDegree[g]` / `VertexDegree[g, v]` — total degree (incident edges).
  `VertexInDegree` / `VertexOutDegree` give in-/out-degrees: a `DirectedEdge`
  adds to the source's out-degree and target's in-degree; an `UndirectedEdge`
  adds to both in- and out-degree of each endpoint.
- `DirectedGraphQ[g]` — `True` iff `g` is a valid graph whose edges are all
  directed.
- `EmptyGraphQ[g]` — `True` iff `g` has no edges (edgeless, on any number of
  vertices). `O(1)`.
- `MixedGraphQ[g]` — `True` iff `g` has both a directed and an undirected edge; a
  purely directed, purely undirected, or edgeless graph is not mixed. `O(E)`.

```
VertexList[Graph[{1,2,3,4},{1->2,2->3,3->4,4->1}]]   (* {1, 2, 3, 4}        *)
EdgeCount[Graph[{1,2,3,4},{1->2,2->3,3->4,4->1}]]    (* 4                   *)
VertexDegree[Graph[{1,2,3},{1<->2,2<->3}]]           (* {1, 2, 1}           *)
AdjacencyList[Graph[{1,2,3},{1<->2,2<->3}], 2]       (* {1, 3}              *)
```

## Matrix views (linear-algebra interop)

- `KirchhoffMatrix[g]` — the graph Laplacian `L = D − A` (degree diagonal minus
  adjacency): `L[i][i] = deg(i)`, `L[i][j] = −1` for an edge `i→j`. Every row
  sums to 0. Being an ordinary matrix it feeds `Eigenvalues`/`Det` directly: the
  zero-eigenvalue multiplicity is the number of connected components, and any
  cofactor is the number of spanning trees (Matrix-Tree theorem).
- `AdjacencyMatrix[g]` — the dense 0/1 adjacency matrix (`n x n`, canonical
  vertex order), symmetric for undirected graphs. It is an ordinary matrix, so
  `Det`, `Tr`, `Eigenvalues`, etc. apply directly.
- `IncidenceMatrix[g]` — the `|V| x |E|` incidence matrix; undirected edges mark
  both endpoints with `1`, directed edges are oriented (`-1` tail, `+1` head).
- `AdjacencyGraph[m]` — the inverse of `AdjacencyMatrix`: builds a graph on
  vertices `1..n` from a 0/1 matrix (undirected if `m` is symmetric, else
  directed). `AdjacencyGraph[AdjacencyMatrix[g]]` reproduces `g`'s edges.
- `LineGraph[g]` — the line graph: vertices are `g`'s edges, adjacent when they
  share an endpoint (head-to-tail for directed graphs, which stay directed).
  `L(C_n) = C_n`, `L(K_4)` has 6 vertices and 12 edges. `O(E²)`.

```
AdjacencyMatrix[Graph[{1,2,3,4},{1->2,2->3,3->4,4->1}]]
    (* {{0,1,0,0},{0,0,1,0},{0,0,0,1},{1,0,0,0}} *)
Det[AdjacencyMatrix[Graph[{1,2,3,4},{1->2,2->3,3->4,4->1}]]]   (* -1 *)
```

*A future `WeightedAdjacencyMatrix` would carry edge weights instead of 0/1;
not implemented in the MVP.*

## Generators

Each builds a canonical graph (vertices `1..n`, undirected edges) via the
constructor path:

- `CompleteGraph[n]` — `K_n`, all `n(n-1)/2` edges.
- `CompleteGraph[{n1, n2, …}]` — the complete multipartite graph: parts of the
  given sizes with an edge between every pair in different parts.
  `CompleteGraph[{m, n}]` is complete bipartite `K_{m,n}`; `CompleteGraph[{2,2,2}]`
  is the octahedron.
- `CycleGraph[n]` — the cycle on `1..n`.
- `PathGraph[n]` — the path `1-2-...-n`; `PathGraph[{v1,...}]` uses the given
  vertices.
- `RandomGraph[{n, m}]` — a random undirected graph with `n` vertices and `m`
  distinct edges (uses the seeded system RNG, so `SeedRandom` makes it
  reproducible). Returns unevaluated if `m` exceeds `n(n-1)/2`.
- `StarGraph[n]` — the star `K_{1,n-1}`: a central vertex `1` joined to the
  `n-1` leaves `2..n`.
- `WheelGraph[n]` — a rim cycle on `1..n-1` plus a hub `n` joined to every rim
  vertex (`2(n-1)` edges; `W_4 = K_4`). Requires `n ≥ 4`.
- `GridGraph[{d1, d2, …}]` — the k-dimensional grid on a `d1 × d2 × …` lattice
  (cells adjacent when they differ by 1 in one coordinate). `GridGraph[{n}]` is a
  path; grids are bipartite.
- `HypercubeGraph[k]` — the k-cube `Q_k`: `2^k` vertices adjacent when they
  differ in one bit (`k`-regular, bipartite; `Q_2 = C_4`).

```
EdgeCount[CompleteGraph[5]]      (* 10                        *)
EdgeList[CycleGraph[4]]          (* {1<->2, 2<->3, 3<->4, 4<->1} *)
VertexDegree[PathGraph[5]]       (* {1, 2, 2, 2, 1}           *)
```

## Search & computation

All are unweighted and build an integer-indexed adjacency on demand.

- `FindShortestPath[g, s, t]` — a shortest path from `s` to `t` as a vertex
  list (BFS; follows edge direction for directed graphs); `{}` if `t` is
  unreachable.
- `GraphDistance[g, s, t]` — the length of that path; `Infinity` if unreachable.
- `ConnectedComponents[g]` / `WeaklyConnectedComponents[g]` — components of the
  underlying undirected graph.
- `StronglyConnectedComponents[g]` — components following edge directions
  (Tarjan). For undirected graphs this coincides with the weak components.
- `FindSpanningTree[g]` — a spanning tree/forest as a graph (`VertexCount - 1`
  edges when connected); tree edges keep their original direction.
- `TransitiveClosure[g]` — adds an edge `u→v` whenever `v` is reachable from `u`
  (directed, `O(V·(V+E))`); for an undirected graph each connected component
  becomes a complete graph.
- `ConnectedGraphQ[g]` — `True` iff `g` is a single connected component.
- `BipartiteGraphQ[g]` — `True` iff the underlying undirected graph is
  2-colorable (no odd cycle). Single-BFS 2-coloring, `O(V+E)`; edge direction is
  ignored and an edgeless graph is vacuously bipartite.
- `EulerianGraphQ[g]` — `True` iff `g` has an Eulerian cycle: connected (on
  nonzero-degree vertices) with all even degrees for an undirected graph, or
  in-degree = out-degree everywhere for a directed one. `O(V+E)`; isolated
  vertices are ignored and an edgeless graph is vacuously Eulerian.
- `HamiltonianGraphQ[g]` — `True` iff `g` has a Hamiltonian cycle (a closed walk
  visiting every vertex once); the predicate companion to `FindHamiltonianCycle`
  and Hamiltonian counterpart of `EulerianGraphQ`. Depth-first backtracking with
  degree/size prunes; direction-aware. `C_n`/`K_n`/wheels are Hamiltonian, paths
  and stars are not.
- `FindEulerianCycle[g]` — an Eulerian cycle as a vertex list
  `{v0, v1, …, v0}` (a closed walk using every edge exactly once), or `{}` when
  none exists. Hierholzer's algorithm, `O(V+E)`: the walk is accepted only when
  it consumes all edges *and* returns to its start, so a graph with an Eulerian
  path but no cycle (e.g. `PathGraph[3]`) correctly yields `{}`. Works for
  directed (follows out-edges) and undirected graphs; agrees with
  `EulerianGraphQ` on whether a cycle exists.
- `FindHamiltonianCycle[g]` — a Hamiltonian cycle as a vertex list
  `{v0, …, v0}` (a closed walk visiting every vertex exactly once), or `{}` when
  none exists. Depth-first backtracking with visited-set pruning; cheap
  necessary-condition prunes (fewer than 3 vertices, or any vertex without an
  out- and in-neighbour) short-circuit impossible graphs. The search fixes the
  start at the first vertex — WLOG, since a Hamiltonian cycle passes through
  every vertex — so the result is deterministic. Follows arc direction on
  directed graphs; exponential in the worst case, but instant on the small
  graphs typical of a gallery.
- `FindHamiltonianPath[g]` — a Hamiltonian path as a vertex list
  `{v0, …, v_{n-1}}` (a walk visiting every vertex exactly once, not required to
  close), or `{}` when none exists. Depth-first backtracking; unlike a
  Hamiltonian *cycle*, a path's endpoints are free, so the search is retried from
  each start vertex. Follows arc direction on directed graphs; a `PathGraph` has a
  Hamiltonian path but no Hamiltonian cycle.
- `ClosenessCentrality[g]` — the list of closeness centralities
  `c_i = (r_i−1)² / ((n−1)·S_i)`, where `r_i` vertices are reachable from `i` at
  total distance `S_i` (`(n−1)/S_i` when connected, `0` when isolated). Exact
  rationals; `O(V·(V+E))` via a BFS per vertex; follows edge direction.
- `LocalClusteringCoefficient[g]` — for each vertex, the fraction of its
  neighbour pairs that are themselves adjacent, `C_v = 2L_v/(d_v(d_v−1))` (and `0`
  when `deg(v) < 2`). Exact rationals in vertex order; a clique gives all `1`, a
  triangle-free graph (cycle, star, tree) all `0`. Edge direction is ignored
  (computed on the underlying undirected graph); `O(V·d_max²)`.
- `GlobalClusteringCoefficient[g]` — the graph transitivity: three times the
  number of triangles over the number of connected vertex triples,
  `Σ L_v / Σ C(d_v,2)` (`0` when there are no triples). Distinct from the mean of
  the local coefficients — it weights each vertex by how many triples it anchors.
  Exact rational; direction ignored; `O(V·d_max²)`.
- `MeanClusteringCoefficient[g]` — the average of the local clustering
  coefficients, `(1/n)Σ C_v` (every vertex counts equally, low-degree ones
  contributing `0`); equals `Mean[LocalClusteringCoefficient[g]]`. Exact rational,
  generally different from the global transitivity above.
- `DegreeCentrality[g]` — for each vertex, the number of incident edges: the
  ordinary degree for an undirected graph, in-degree + out-degree for a directed
  one. The simplest centrality; one pass over the edges (`O(V+E)`), exact
  integers in vertex order (agrees with `VertexDegree` on undirected graphs).
- `DegreeSequence[g]` — the vertex degrees (in-degree + out-degree for a directed
  graph) sorted in non-increasing order; `{3,3,3,3}` for `K₄`, `{4,1,1,1,1}` for a
  4-leaf star. `O(V+E+V log V)`, exact integers — a sorted permutation of
  `DegreeCentrality[g]`.
- `PageRankCentrality[g]` — the PageRank of each vertex (random surfer with
  damping `d = 17/20`), as an **exact rational** probability vector summing to 1.
  Rather than iterating to a float, it solves the defining linear system
  `(I − dM)π = (1−d)/n·1` (with `M` the column-stochastic transition matrix,
  dangling vertices teleporting uniformly) through the exact `LinearSolve`.
  Follows edge direction; regular and all-dangling graphs give the uniform `1/n`,
  a star's centre outranks its leaves. `O(V³)`.
- `KatzCentrality[g, α]` — the Katz centrality of each vertex with attenuation
  `α` (base weight `1`): a vertex is central if pointed to by central vertices,
  with a length-`k` walk discounted by `αᵏ`. Solves `(I − αAᵀ)x = 1` exactly via
  `LinearSolve`, so a rational `α` gives an exact rational vector. Uses in-edges
  (`Aᵀ`), so directed scores reflect who points at a vertex; `α = 0` gives all
  `1`. Left unevaluated for non-numeric `α` or a singular system. `O(V³)`.
- `BetweennessCentrality[g]` — for each vertex, the number of shortest paths
  through it, `Σ σ_sv·σ_vt/σ_st` (fractional when paths tie — every C₄ vertex is
  `1/2`). Undirected pairs are counted once; directed keeps the ordered sum.
  Exact rationals from all-pairs BFS path counts.
- `GraphDistanceMatrix[g]` — the matrix whose `(i, j)` entry is the shortest-path
  distance from vertex `i` to vertex `j` (`0` on the diagonal, `Infinity` when
  unreachable). One BFS per source over the direction-aware adjacency,
  `O(V·(V+E))`; symmetric for undirected graphs, generally asymmetric for
  directed ones. Row/column `i, j` agrees with `GraphDistance[g, i, j]`.
- `GraphReciprocity[g]` — the fraction of arcs whose reverse arc is also present,
  an exact rational in `[0, 1]`: `1` for any undirected graph (every edge is
  mutual), and for a directed graph the usual fraction of reciprocated edges
  (`{1->2, 2->1}` → `1`, a directed cycle → `0`). `0` when there are no edges.
  Modelled as a directed-arc matrix, `O(V²)`.
- `GraphDensity[g]` — the fraction of possible edges present, an exact rational
  in `[0, 1]`: `2m/(n(n−1))` for an undirected graph, `m/(n(n−1))` for a directed
  one (`1` for a complete graph, `0` for an empty one or fewer than two
  vertices). Reduced by the evaluator, so it prints as a clean integer/`Rational`.
- `FindClique[g]` — a largest clique (a set of pairwise-adjacent vertices) as a
  list containing one vertex list (`{{1, 2, 3, 4}}` for `K₄`), or `{}` when `g`
  has no vertices. A max-clique specialisation of Bron–Kerbosch: grow a clique
  over candidates adjacent to all of it, pruning the branch when the remaining
  candidates cannot beat the best clique found. Exponential worst case but fast
  on real graphs; direction ignored; deterministic (first maximum kept).
- `FindIndependentVertexSet[g]` — a largest independent vertex set (pairwise
  non-adjacent) as a list containing one vertex list, or `{}` when `g` has no
  vertices. Computed as a maximum clique of the complement — the same
  branch-and-bound search run over the non-adjacency. A star returns its leaves,
  a complete graph a singleton; direction ignored, deterministic.
- `FindVertexCover[g]` — a minimum vertex cover (a smallest set of vertices
  touching every edge) as a flat vertex list, or `{}` when `g` has no edges. By
  the Gallai identity it is the complement of a maximum independent set, so it
  reuses that search and returns the vertices outside the set (`|cover| +
  |independent set| = n`). A star's cover is its centre, `K_n`'s is `n−1`
  vertices; direction ignored, deterministic.
- `VertexEccentricity[g, v]` — the greatest shortest-path distance from `v` to
  any vertex (`Infinity` if some vertex is unreachable); `VertexEccentricity[g]`
  gives the list for all vertices.
- `GraphDiameter[g]` / `GraphRadius[g]` — the max / min vertex eccentricity
  (`Infinity` when not strongly connected / when no vertex reaches all others).
- `GraphCenter[g]` — the vertices whose eccentricity equals the graph radius.
  These derive from a BFS per vertex (`O(V·(V+E))`) and follow edge direction on
  directed graphs.
- `CompleteGraphQ[g]` — `True` iff every pair of distinct vertices is adjacent
  (the underlying undirected graph is `K_n`); `O(V²)`. `K_n` and a triangle are
  complete, a `K_n` missing an edge is not, a graph with ≤ 1 vertex vacuously so.
- `RegularGraphQ[g]` — `True` iff every vertex has the same degree (equal
  in-degrees and equal out-degrees for a directed graph); `O(V)`. A cycle is
  2-regular, `K_n` is `(n−1)`-regular, `K_{3,3}` is 3-regular, an edgeless graph
  0-regular; paths, stars, and wheels are not. A graph with ≤ 1 vertex is
  vacuously regular.
- `PathGraphQ[g]` — `True` iff `g` is a path graph: a tree with maximum degree
  `≤ 2` (connected, `n−1` edges, no branching or cycle). `O(V²)`; direction
  ignored. A single vertex/edge and `PathGraph[n]` qualify; cycles, stars,
  branches, and disconnected graphs do not.
- `TreeGraphQ[g]` — `True` iff `g` is a tree: connected with no cycles, i.e.
  connected on the underlying undirected graph with exactly `n−1` distinct edges
  (`n ≥ 1`). One BFS plus an edge count, `O(V²)`; a single vertex is a tree, the
  empty graph and any disconnected or edgeless multi-vertex graph is not.
- `AcyclicGraphQ[g]` — `True` iff `g` has no cycle: a DAG for a directed graph, a
  forest for an undirected one. `O(V+E)` (Kahn's algorithm for the directed
  case, `E = V − #components` for the undirected case).
- `TopologicalSort[g]` — a vertex ordering in which every edge points forward
  (Kahn's algorithm), or `$Failed` if `g` is not a directed acyclic graph
  (undirected edges act as 2-cycles, so they give `$Failed`).
- `ChromaticPolynomial[g, k]` — the chromatic polynomial: the number of proper
  `k`-colourings of `g`. A symbolic `k` gives the polynomial (`k(k−1)(k−2)` for a
  triangle), a numeric `k` the colouring count. Computed from the Whitney
  subgraph expansion `Σ_{S⊆E}(−1)^{|S|} k^{c(S)}` (integer coefficients by
  component count), assembled and reduced through the evaluator so both forms
  share one path. Exponential in the edge count (2^{|E|}), so it is left
  unevaluated beyond a modest edge bound; direction ignored. Useful for the
  chromatic number: the least `k` with `ChromaticPolynomial[g, k] > 0` (an odd
  cycle gives `0` at `k = 2`, a bipartite graph a positive value).
- `ChromaticNumber[g]` — the least number of colours for a proper colouring.
  Tries `k = 1, 2, …` and tests k-colourability by backtracking (each vertex
  takes a colour clashing with no coloured neighbour), with a symmetry cut
  (a vertex opens at most one new colour) and early stop at the first feasible
  `k`. Works for any edge count (unlike the polynomial); direction ignored.
  Bipartite → `2`, odd cycle / triangle → `3`, `K_n` → `n`, edgeless → `1`.
- `FindCycle[g]` — a cycle in `g` as a list containing one cycle, that cycle
  being a list of its edges (`{{1<->2, 2<->3, 3<->1}}`), or `{}` if `g` is
  acyclic. DFS back-edge detection, `O(V+E)`: a directed cycle needs an on-stack
  target, an undirected one a visited non-parent neighbour. Returns the first
  cycle found (deterministic, not necessarily shortest); edges follow arc
  direction and mirror the graph's edge kind.
- `GraphProduct[g1, g2, type]` — a product graph on the vertex pairs `V1 × V2`
  (`{a, b}` labels), undirected, for `type` one of `"Cartesian"` (`a1=a2 & b1~b2`
  or `b1=b2 & a1~a2`), `"Tensor"` (`a1~a2 & b1~b2`), `"Strong"` (Cartesian ∪
  Tensor), or `"Lexicographic"` (`a1~a2`, or `a1=a2 & b1~b2`). `O((n1·n2)²)`.
  `P₂ □ P₂ = C₄`, `C₄ □ K₂` is the 3-regular cube, `K₂ ⊠ K₂ = K₄`. Left
  unevaluated for an unknown type.
- `GraphUnion[g1, g2]` — the graph whose vertex set is the union of the two
  vertex sets and whose edge set is the union of the two edge sets, matched by
  vertex identity. Vertices from `g1` keep their order, new ones from `g2` are
  appended; duplicate and (for undirected) symmetric edges are collapsed, while
  directed edges stay distinct from their reverse. Returns a canonical `Graph`.
- `GraphJoin[g1, g2]` — the graph join: the disjoint union of `g1` and `g2`
  (vertices relabelled `1..n1+n2`, `g1`'s block first) plus an undirected edge
  from every `g1` vertex to every `g2` vertex. `m1 + m2 + n1·n2` edges; `K₁ ⋈ K₁`
  is an edge, `P₂ ⋈ K₁` a triangle, `Kₘ ⋈ Kₙ = K₍ₘ₊ₙ₎`. Returns a canonical
  `Graph`.
- `GraphIntersection[g1, g2]` — the graph with the vertices common to both and
  the edges present in both (same edge-equality rules as `GraphUnion`). Identical
  graphs intersect to themselves, disjoint graphs to the empty graph; returns a
  canonical `Graph`.
- `GraphDifference[g1, g2]` — the graph on `g1`'s vertices with the edges of `g1`
  that are not in `g2` (same edge-equality rules). `K₄ − C₄` leaves the two
  diagonals; `g − g` is edgeless on `g`'s vertices; `g` minus a disjoint graph is
  `g`. Returns a canonical `Graph`.
- `ReverseGraph[g]` — `g` with every directed edge reversed (`a→b` becomes `b→a`)
  and undirected edges unchanged; the transpose graph. Swaps in- and out-degree,
  is an involution (`ReverseGraph[ReverseGraph[g]] === g`), and is the identity on
  undirected graphs. `O(V+E)`, returns a canonical `Graph`.
- `IndexGraph[g]` / `IndexGraph[g, k]` — `g` with its vertices renamed to
  consecutive integers from `1` (or from `k`), in current order, edges remapped
  and kinds preserved. Normalises arbitrary labels (symbols, strings, expressions)
  to canonical integer indexing; `O(V+E)`, returns a canonical `Graph`.
- `GraphComplement[g]` — the graph on the same vertices whose edges are exactly
  the non-edges of `g`; edgeless → complete graph, complete → edgeless, and
  applying it twice restores `g`. Directed graphs stay directed (`O(V²)`).
- `VertexContract[g, {v1, v2, …}]` — merges the listed vertices into one (the
  first), redirecting every incident edge to the representative, deleting the
  resulting self-loops, and collapsing parallel edges. Contracting an edge's two
  endpoints realises edge contraction (a triangle becomes a single edge);
  contracting all vertices gives a single isolated vertex. Direction-aware,
  returns a canonical `Graph`.
- `GraphPower[g, k]` — the k-th power: the graph on the same vertices that joins
  two vertices whenever `g` has a path of length `≤ k` between them (no
  self-loops). A depth-limited BFS per source over the (direction-aware)
  adjacency, `O(V·(V+E))`; directed graphs stay directed. `k` must be a positive
  integer, else the call is left unevaluated. `PathGraph[4]³` and `CycleGraph[5]²`
  are complete; `k = 1` returns `g` unchanged.
- `KCoreComponents[g, k]` — the connected components of the k-core of `g` (the
  maximal subgraph in which every vertex has degree `≥ k`), as a list of vertex
  lists. Found by repeatedly peeling any vertex whose degree drops below `k`
  until stable, `O(V+E)`, then splitting the survivors into components by BFS.
  Edge direction is ignored (the k-core is defined on the underlying undirected
  graph); components are ordered by least vertex index. `k` must be a
  non-negative integer, else the call is left unevaluated.
- `StronglyConnectedGraphQ[g]` — `True` iff every vertex is reachable from every
  other following edge directions. Two BFS from vertex 0 — one over out-edges,
  one over in-edges — each reaching all `n` vertices, `O(V+E)`. For an undirected
  graph this coincides with `ConnectedGraphQ`; a single vertex is strongly
  connected, the empty graph is not.
- `VertexConnectivity[g]` — the minimum number of vertices whose removal
  disconnects `g` (`n-1` for `K_n`, `0` if already disconnected). Exact
  brute-force over vertex subsets, intended for small graphs.
- `EdgeConnectivity[g]` — the minimum number of edges whose removal disconnects
  `g` (`n-1` for `K_n`, `2` for a cycle, `1` for a tree/bridge, `0` if already
  disconnected). Max-flow/min-cut (Edmonds–Karp, unit capacities): one source
  suffices for undirected graphs, all ordered pairs for directed.

```
FindShortestPath[Graph[{1,2,3,4},{1->2,2->3,3->4}], 1, 4]   (* {1, 2, 3, 4} *)
GraphDistance[Graph[{1,2,3,4},{1->2,2->3,3->4}], 4, 1]      (* Infinity     *)
StronglyConnectedComponents[Graph[{1,2,3},{1->2,2->3}]]     (* {{1},{2},{3}} *)
VertexConnectivity[CycleGraph[5]]                           (* 2            *)
```

## Visualization

`GraphPlot[g]` gives a `Graphics[...]` object drawing `g`: edges are `Line`s,
vertices are `Disk`s with a `Text` label, each preceded by an `RGBColor`
directive so the notebook Plotly serializer and the Raylib renderer both style
it with no special-casing (a window when `USE_GRAPHICS=1`, the text placeholder
otherwise). Directed edges are drawn as plain lines in the MVP (no arrowheads
yet). Because a bare `Graph` auto-displays, `GraphPlot` is only needed when you
want a non-default layout or styling.

```
Head[GraphPlot[CycleGraph[8]]]                 (* Graphics *)
Count[GraphPlot[CompleteGraph[6]], _Line, Infinity]   (* 15 edges *)
```

### Options

- `GraphLayout -> "name"` — vertex placement (see the layout table below).
- `VertexStyle -> color` / `EdgeStyle -> color` — a color for all vertices /
  edges. Accepts `RGBColor[...]`, `GrayLevel[...]`, or a named color
  (`Red`, `Blue`, `Orange`, …), which resolve to `RGBColor`.
- `VertexSize -> r` — the vertex `Disk` radius (default `0.08`); the notebook
  maps radius to marker size, so larger `r` yields bigger dots.
- `VertexLabels -> None` — suppress the text labels (default draws them).

```
GraphPlot[CompleteGraph[8], GraphLayout -> "SpringElectricalEmbedding"]
GraphPlot[CycleGraph[10], VertexStyle -> Orange, EdgeStyle -> GrayLevel[0.7]]
GraphPlot[PathGraph[6], GraphLayout -> "LinearEmbedding", VertexLabels -> None]
```

### Layouts (`GraphLayout`)

Coordinates are computed in `src/graph/layout.c` and normalized to the
`[-1, 1]` box. Every kernel is deterministic (no RNG), so notebooks reproduce
exactly. The full Wolfram-Language `GraphLayout` name list is accepted and
mapped onto the kernels below; an unrecognized name (or `None`) falls back to
circular.

| Kernel | Wolfram names served | Notes |
|--------|----------------------|-------|
| Circular | `"CircularEmbedding"` | default; vertices on a circle |
| Spring / force-directed | `"SpringElectricalEmbedding"`, `"SpringEmbedding"`, `"TutteEmbedding"`, `"PlanarEmbedding"` | Fruchterman–Reingold: edges as springs, vertices as charges |
| Gravity | `"GravityEmbedding"` | Fruchterman–Reingold plus a central gravity well that pulls high-degree hubs inward and compacts the drawing |
| High-dimensional | `"HighDimensionalEmbedding"`, `"SpectralEmbedding"` | pivot-MDS: coordinates are BFS distances to two far-apart pivots (lays the graph along its diameter) |
| Hyperbolic | `"HyperbolicSpringEmbedding"`, `"SphericalEmbedding"` | spring layout, then a radial warp crowding vertices toward a disk boundary (Poincaré-disk feel) |
| Spiral | `"SpiralEmbedding"`, `"DiscreteSpiralEmbedding"` | Archimedean spiral; good for paths |
| Linear | `"LinearEmbedding"` | vertices on a line |
| Grid | `"GridEmbedding"` | row-major square grid |
| Random | `"RandomEmbedding"` | deterministic pseudo-random |
| Star | `"StarEmbedding"` | highest-degree vertex centered, rest on a circle |
| Radial | `"RadialEmbedding"`, `"BalloonEmbedding"`, `"HyperbolicRadialEmbedding"` | concentric BFS shells from the highest-degree root |
| Layered | `"LayeredEmbedding"`, `"LayeredDigraphEmbedding"`, `"SymmetricLayeredEmbedding"` | stacked BFS layers |
| Bipartite | `"BipartiteEmbedding"`, `"MultipartiteEmbedding"`, `"CircularMultipartiteEmbedding"` | two columns from a BFS 2-coloring (approximated for the multipartite names) |

Edge-layout, packing, and rendering-order values (`"StraightLine"`,
`"HierarchicalEdgeBundling"`, `"LayeredTop"`, `"VertexFirst"`, …) are not
vertex layouts; they are accepted and ignored (circular fallback).

## HighlightGraph

`HighlightGraph[g, parts]` draws `g` with selected elements emphasized (accent
color) and everything else dimmed, returning a `Graphics` (so it auto-displays).
Each element of `parts` may be:

- a **vertex** — highlight that vertex;
- an **edge** — `u <-> v`, `u -> v`, or `DirectedEdge`/`UndirectedEdge[u, v]`
  (endpoints matched unordered);
- a **list of vertices** — treated as a *path*: its vertices and the edges
  joining consecutive vertices are highlighted.

It returns a `Graphics`, not a `Graph`: the canonical `Graph[List, List]` form
is locked to simple graphs with no annotations, so a highlight lives only in
the picture. `GraphLayout` may be given as a trailing option.

```
HighlightGraph[CycleGraph[6], {1, 2, 3}]                    (* 3 vertices *)
HighlightGraph[CompleteGraph[5], {1 <-> 2, 2 <-> 3}]        (* 2 edges    *)
HighlightGraph[g, {FindShortestPath[g, 1, 4]}]              (* a path     *)
```

## Graph3D

`Graph3D[v, e]` / `Graph3D[e]` builds a graph exactly like `Graph` — same edge
sugar (`u -> v`, `u <-> v`), same simple-graph validation — but the canonical
value has head `Graph3D` and **auto-displays as a 3D node-link diagram**: a
force-directed (Fruchterman–Reingold) layout in a cube, rendered as Plotly
`scatter3d` (edges as 3D lines, vertices as markers) that you can orbit and
zoom. `Graph3D[g]` converts an existing graph to 3D, and `Graph[g3d]` converts
back to 2D.

A `Graph3D` counts as a graph (`GraphQ` is `True`), so every query, matrix, and
algorithm builtin works on it directly.

```
Graph3D[{1, 2, 3, 4}, {1 <-> 2, 2 <-> 3, 3 <-> 4, 4 <-> 1}]   (* 3D diagram *)
Graph3D[CompleteGraph[6]]                                      (* wrap a graph *)
VertexCount[Graph3D[CompleteGraph[5]]]                         (* 5 *)
GraphQ[Graph3D[{1, 2}, {1 <-> 2}]]                             (* True *)
InputForm[Graph3D[{1, 2}, {1 <-> 2}]]     (* Graph3D[{1, 2}, {1 <-> 2}] *)
```

The default 3D layout is a spring embedding; `"SphericalEmbedding"` places
vertices on a sphere. (Rendering: `src/graph/render3d.c` emits `Graphics3D`,
serialized by `graphics3d_to_plotly_json` in `src/graphics/graphics_json.c`.)
