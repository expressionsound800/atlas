# Graph Layout Model

This document defines the current V3 layout model. It is intentionally
source-neutral: no category gets its own layout pass or correction fixture.
`GRAPH_LAYOUT_REFERENCES.md` records the model's literature, implementation
influences, and retained Temporal River compatibility lineage; this file
remains the normative behavior contract.

## Elements

The layout engine operates on normalized graph model elements:

- `container`: owns child elements and may also be routed to.
- `node`: terminal visual entity.
- `edge`: directed relationship between any two elements.

Containers are not overlays. They are first-class layout elements with a measured
box, children, reserved text area, and optional collapsed node representation.

## Invariants

- All geometry is measured in grid cells.
- Every sibling pair has at least one empty grid cell between their boxes.
- Container label, role, and description space is reserved before child layout.
- Children must not overlap their container text area.
- Routing starts only after element placement is final.
- Routing does not repair node/container placement.
- Semantic cluster bands are measured and packed per visual column; the largest
  cluster must not impose its footprint on unrelated rows or columns.
- Post-placement whitespace correction may move only a statistically isolated
  container group, must preserve its internal arrangement, and must retain the
  route-grid collision gap around every other group.
- Performance degradation is based on element count, edge count, and their
  combined routing workload, never source category names.
- Source adapters provide topology, metadata, and containment. They must not
  encode layout decisions such as side, lane, column, or center priority for
  active graph categories.
- Directed-flow gradients are scoped to canonical containers. Only edges whose
  two endpoints belong to the same container may influence that container's
  potential bands or crossing order; room-wide and cross-container edges may
  not distort its internal composition.
- A topology-dominant hub may split only its own container-local neighborhood
  into ordered branch fields. The room root may contribute topology evidence,
  but its semantic anchor is not reassigned by the field solver.
- Branch subcolumns remain inside half of one primary flow band. They may break
  a rigid seam but cannot replace the source-to-receiver gradient.

## Pipeline

If the projection contains a validated precomputed `viewModel`, the frontend
normalizes selection/focus/presentation state and renders it directly. Otherwise
it uses the local deterministic fallback pipeline:

Precomputed packets are presentation-mode specific. A compact packet must not be
used for extended rendering because card dimensions and connector surfaces are
different. Providers can send a single matching `viewModel` or a `viewModels`
map keyed by presentation mode.

1. Normalize projection into the graph model and validate invariants.
2. Measure each node and container in grid cells.
3. Compute topology-only semantic weights:
   - growth-source score from outbound degree, directed reachability, relation
     diversity, and skip-gram-style context affinity
   - convergence score from inbound degree, reverse reachability, relation
     diversity, and context affinity
   - bridge/conversion score from combined inbound/outbound pressure
4. Build the containment tree and choose visible elements:
   - expanded container: draw container plus children
   - collapsed container: draw container as a node
   - child edges incident to collapsed children route through the collapsed
     container node
5. Place root elements with a generic semantic packer:
   - prefer the strongest conversion hub as the composition center
   - place strongest growth sources as composition-origin centers
   - distribute independent containers around semantic centers
   - fall back to balanced columns when radial placement would waste space
   - pack variable-height clusters independently in each visual column, with a
     deliberate lane-unit gutter rather than the largest cluster's footprint
6. Place children inside each container after reserving text and metadata
   space. For dense containers, solve generalized trophic potential
   `Lh = in_degree - out_degree` on each connected component of the induced
   internal graph. Quantize the normalized source-to-receiver potential into
   at most four local columns, then use deterministic forward/reverse
   barycentric sweeps to order nodes vertically inside those columns. Cycles
   remain valid because the potential is a least-squares graph quantity rather
   than a topological sort. Disconnected components are solved independently,
   and cross-container relationships are excluded. Multi-column containers
   otherwise keep topology-derived depth instead of
   collapsing every child into a two-column role matrix. When at least 72% of
   eight or more children form repeated semantic columns, split only overfull
   columns at the square-root occupancy bound and offset neighboring columns by
   one grid cell. Dense flow-band placement adds three route-grid cells between
   horizontal node positions and five between vertical positions. The larger
   vertical pitch keeps at least four clear cells between rendered node and
   connector envelopes without over-expanding the horizontal composition. This
   produces staggered flow bands without random jitter, room names, or
   hand-authored coordinates. When one node dominates the local degree and
   covers a substantial share of the container, remove it temporarily to
   discover hub-neighbor branches, order those branches from incoming to
   outgoing evidence, and pack them into at most four load-balanced vertical
   fields around a reserved hub corridor. Apply a bounded deterministic
   subcolumn phase to sibling branches so the field is a two-dimensional fan,
   while retaining the primary flow-band order. When an internal relationship travels backward
   across semantic columns, the strongest source with both incoming and
   outgoing pressure becomes the container's return-lane node. That node moves
   to the end of its existing column and receives eighteen additional vertical
   route cells before it. The backward relationship can then use the container
   periphery without spreading every hub or changing horizontal composition.
7. Derive remaining local flow vectors from edges, not source category:
   - root-to-child flows grow outward from the parent
   - chains preserve their vector when possible
   - branches fan out by available space and collision pressure
8. Resolve sibling spacing and container spacing globally. A final
   source-neutral outlier check may pull a container whose nearest gap exceeds
   twice the room median toward a three-cell breathing gap, but only when that
   translation remains collision-safe.
9. Promote visual route endpoints when topology proves a container boundary is
   the better endpoint:
   - logical edge endpoints stay unchanged
   - a child can represent container entry when it reaches most siblings inside
     that container
   - a child can represent container exit when most siblings can reach it
   - promoted endpoints route to hidden container-boundary proxy elements
10. Route edges against the finalized grid.
11. Render stable grid/container/node layers, then complete edge/label/marker
    layers.
12. Apply viewport, zoom, fit, focus, selection, and overlays after geometry
    exists.

## Container Routing

Containers are routable elements, not only visual backgrounds. Boundary-crossing
edges may route to a container when the graph topology identifies the child node
as a representative entry or exit for that container. This is calculated from
directed reachability inside the container and applies to any dataset. It is not
allowed to key off category names, labels, or provider-specific fixtures.

The rendered edge still exposes its logical `from` and `to`. Optional `routeFrom`
and `routeTo` describe the visual endpoints used by the router.

## Interaction Degradation

Manual node movement is a layout override, not a new graph source. Pointer drag
uses transform-only preview. On drop, the graph rebuilds the edited layout with
the speed budget; that budget uses bounded routing for ordinary projections and
preview routing when combined node/edge workload exceeds the synchronous-search
limit. A later full quality pass may be scheduled separately. This keeps live
editing responsive without introducing category-specific route shortcuts.

Room-entry and repository-overview nodes follow this same override contract.
Navigation metadata describes what a double-click does; it never removes the
node from manual layout. Their pointer sequence preserves native compatibility
mouse events so dragging and double-click navigation remain distinct gestures
on Safari and Chromium.

Initial dense projections use a visibility budget before they reach the much
larger preview threshold. Visibility routing retains endpoint surfaces,
one-bend paths, local obstacle detours, and outer rails, but skips route-grid
search. After visibility routing, up to twelve of the highest-crossing edges
with at least one measured crossing may receive a bounded reroute attempt. This
outlier batch preserves the large-graph fast path instead of restoring collision
search for every edge. Bounded routing widens endpoint and escape candidates
only when its first candidate still has obstacle, crossing, or approach-angle
defects.

## Known Large-Inventory Boundary

Graph layout cost is bounded after a projection arrives, but the Repository
Provider still derives mapped Architecture projections from the complete
admitted inventory on each request. Above roughly 500 admitted source records,
first overview and semantic-room views may therefore take tens of seconds even
when the rendered graph contains only a handful of semantic components. This is
a provider-projection cache limit, not permission to omit source truth from the
catalog or index. The Atlas Core Known Limitations guide records the user
workaround and the required digest-keyed cache boundary.

## Compatibility Boundary

The implementation retains compatibility concepts named
`graphSide`, `graphColumn`, and `graphLane` because imported projections and
older experiments used them. For active provider categories, those values are
derived inside the graph lens from semantic scoring and topology; they must not
be sent by the provider as category-specific layout decisions.

New work must not add category-specific correction passes. If a dataset exposes
bad spacing, bad centering, or bad route choices, fix the generic model:
measurement, semantic scoring, packing, container routing, connector selection,
route budgeting, or viewport fitting.

## Lifecycle And Emphasis

Visual emphasis is a model output, not a CSS guess. Provider adapters may
classify domain state such as session activity, but graph rendering only sees
generic emphasis tokens:

- `current`
- `attention`
- `context`
- `past`

Containers may carry lifecycle tokens such as `active`, `resumable`,
`attention`, `recent`, and `past`. The renderer exposes those tokens through
classes and `data-visual-emphasis` for reusable browser audits.
