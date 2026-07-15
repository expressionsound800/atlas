# Graph Layout References And Lineage

This file records the literature and internal design lineage behind the Graph
layout model. It is an attribution and reasoning record, not a second runtime
contract. `GRAPH_LAYOUT_MODEL.md` remains the normative behavior contract.

## Container-Local Directed Flow

The dense-container foundation is `container-local-trophic-gradient-v1`. It
applies only inside a canonical container with at least eight eligible nodes.
The implementation constructs the container-induced directed graph, solves
generalized trophic potential on each connected component, quantizes the
normalized result into two to four bounded flow bands, and uses deterministic
forward/reverse barycentric sweeps to order nodes within those bands. Room-wide
and cross-container edges do not influence the local gradient.

`container-local-hub-branch-fields-v2` extends that foundation only when local
topology identifies one dominant high-degree hub. The solver removes the hub
for branch discovery, assigns each remaining node to its nearest hub-neighbor
branch, orders branches from mostly incoming to mostly outgoing, and packs the
ordered branches into at most four load-balanced fields. Fields receive
separate vertical lanes around a reserved hub corridor. Sibling branches also
receive deterministic subcolumn phases, bounded to less than half of one flow
band, so a high-degree neighborhood forms a two-dimensional fan instead of a
single vertical seam. The semantic room root participates in local topology
but remains horizontally anchored.

The model draws on three complementary sources:

- R. S. MacKay, S. Johnson, and B. Sansom, “How directed is a directed
  network?”, *Royal Society Open Science* 7 (2020), DOI
  [`10.1098/rsos.201138`](https://doi.org/10.1098/rsos.201138). The generalized
  trophic-level formulation supplies a continuous source-to-receiver potential
  for arbitrary directed graphs, including graphs with cycles.
- E. R. Gansner, E. Koutsofios, S. C. North, and K.-P. Vo, “A Technique for
  Drawing Directed Graphs”, *IEEE Transactions on Software Engineering* 19
  (1993), [official Graphviz paper](https://graphviz.org/documentation/TSE93.pdf).
  Its separation of rank assignment, within-rank ordering, local crossing
  reduction, coordinate assignment, and routing informs the Graph pipeline's
  phase boundaries.
- Eclipse Layout Kernel, [ELK Layered algorithm
  reference](https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-layered.html).
  Its explicit cycle-handling, layering, crossing-minimization, node-placement,
  and edge-routing stages reinforce the decision to keep directional placement
  separate from final route construction. ELK's explicit treatment of
  high-degree nodes also supports isolating hub-neighborhood composition from
  ordinary band placement rather than globally increasing every gap.
- D. Holten, “Hierarchical Edge Bundles: Visualization of Adjacency Relations
  in Hierarchical Data”, *IEEE Transactions on Visualization and Computer
  Graphics* 12 (2006), DOI
  [`10.1109/TVCG.2006.147`](https://doi.org/10.1109/TVCG.2006.147). This is a
  reference for a possible later edge-hierarchy boundary, not code or behavior
  implemented by the current node-placement slice.

These are conceptual and mathematical influences. No third-party source code
is copied into Atlas Graph. The product-specific adaptations are the canonical
container scope, the dense-node threshold, the bounded band and field counts,
dominant-hub evidence, stable-id tie-breaking, deterministic sweep count,
bounded branch subcolumns, and compatibility with the existing Graph
measurement and routing pipeline.

## Temporal River Lineage

The earlier internal layout path named **Temporal River** remains in
`graph-layout-positioning.js` as `temporalRiverGraphLayout()`. It originated in
the first standalone Graph layout and was later extracted from the original
monolithic layout module without changing its underlying model. This runtime
symbol, rather than an inaccessible source-history identifier, is the durable
reference for the retained implementation.

Temporal River assigns causal-depth columns, measures extra horizontal space
from crossing and join pressure, and positions each node around a
parent-weighted lane. Relationship kinds contribute different depth/alignment
weights, and left/right branches reflect the resulting stream around the root
reference. The name describes this internal composition metaphor.

The conceptual inspiration record includes A. G. Hunt, B. Ghanbarian, and B.
Faybishenko, “A model of temporal and spatial river network evolution with
climatic inputs”, *Frontiers in Water* 5 (2023), DOI
[`10.3389/frwa.2023.1174570`](https://doi.org/10.3389/frwa.2023.1174570). Its
treatment of river networks as structures that evolve across time and space
informed the Temporal River name and composition metaphor. The paper is not
the source of the layout algorithm, and Atlas Graph does not implement its
scientific model, equations, or source code.

Temporal River is preserved, but it is not the active dense Atlas Product room
algorithm. The current semantic placement path assigns explicit graph columns;
those projections use explicit side placement and, for dense canonical
containers, the container-local trophic-gradient model. Temporal River remains
a compatibility fallback for supported branch projections that do not provide
or derive explicit columns, and for direct internal callers of that fallback.
It should be removed only after an audit proves that no supported projection
depends on the non-explicit-column path.

## Design Boundary

The layout model preserves these boundaries:

1. Directional gradients are local to each canonical container, never the
   entire room.
2. Dense containers use generalized trophic potential plus deterministic
   crossing-aware lane order; dominant local hubs additionally use bounded
   branch fields and sibling subcolumns.
3. Sparse containers retain the established placement path.
4. Routing consumes final placement; it does not define semantic order.
5. Temporal River remains an explicit compatibility fallback, not a competing
   dense-layout authority.
6. Layout behavior stays source-neutral: repository names, room ids, labels,
   and hand-authored room-specific coordinates cannot select or tune it.
7. Node placement does not pretend that dozens of truthful relationships are
   fewer edges. Ordered edge hierarchy or bundling is a separate future slice
   with its own interaction, traceability, and accessibility contract.

Revisit these boundaries only with generic collision/crossing evidence across
multiple repositories, a supported-projection compatibility failure, or a
measured public-distribution performance regression.
