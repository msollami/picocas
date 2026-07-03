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
- `ClosenessCentrality[g]` — the list of closeness centralities
  `c_i = (r_i−1)² / ((n−1)·S_i)`, where `r_i` vertices are reachable from `i` at
  total distance `S_i` (`(n−1)/S_i` when connected, `0` when isolated). Exact
  rationals; `O(V·(V+E))` via a BFS per vertex; follows edge direction.
- `VertexEccentricity[g, v]` — the greatest shortest-path distance from `v` to
  any vertex (`Infinity` if some vertex is unreachable); `VertexEccentricity[g]`
  gives the list for all vertices.
- `GraphDiameter[g]` / `GraphRadius[g]` — the max / min vertex eccentricity
  (`Infinity` when not strongly connected / when no vertex reaches all others).
- `GraphCenter[g]` — the vertices whose eccentricity equals the graph radius.
  These derive from a BFS per vertex (`O(V·(V+E))`) and follow edge direction on
  directed graphs.
- `AcyclicGraphQ[g]` — `True` iff `g` has no cycle: a DAG for a directed graph, a
  forest for an undirected one. `O(V+E)` (Kahn's algorithm for the directed
  case, `E = V − #components` for the undirected case).
- `TopologicalSort[g]` — a vertex ordering in which every edge points forward
  (Kahn's algorithm), or `$Failed` if `g` is not a directed acyclic graph
  (undirected edges act as 2-cycles, so they give `$Failed`).
- `GraphComplement[g]` — the graph on the same vertices whose edges are exactly
  the non-edges of `g`; edgeless → complete graph, complete → edgeless, and
  applying it twice restores `g`. Directed graphs stay directed (`O(V²)`).
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
