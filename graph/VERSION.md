# Atlas Graph Version

Version: `0.7.0`

Atlas Graph uses SemVer. Version `0.7.0` is compatible with Atlas Core `0.6.0`
and Atlas Public Distribution `0.3.0`.

Version `0.7.0` adds mapped-repository projections, repository-overview return
navigation, repository-specific browser identity, capability-based source tabs,
movable navigation nodes, precomputed view-model support, and source-neutral
directed-flow, crossing, spacing, routing, and viewport corrections for
arbitrary repositories.

Instances with more than roughly 500 admitted source records may still require
tens of seconds for their first Architecture projection until the provider has
digest-keyed projection caching. This is a known provider boundary rather than
a Graph rendering limit.

Compatibility is contractual rather than version-number equality. Evidence v2
remains an Atlas Core protocol; Graph consumes provider projections and does not
own or version agent-facing Evidence packets.

Detailed changes are recorded in `CHANGELOG.md`. The active layout contract is
`GRAPH_LAYOUT_MODEL.md`; its literature and algorithm lineage are recorded in
`GRAPH_LAYOUT_REFERENCES.md`.
