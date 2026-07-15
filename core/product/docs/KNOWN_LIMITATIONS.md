# Atlas Known Limitations

Status: active

This document records current product limits that affect how a repository is
configured or experienced. It does not weaken Atlas's source, privacy,
installation, or verification contracts.

## Large Admitted Source Inventories

Atlas indexes every file admitted by an instance's tracked source policy. The
default bounded adapter stops at 512 admitted files. An instance may raise that
limit explicitly, but Atlas Graph does not yet cache mapped architecture
projections across requests.

When an instance exceeds roughly 500 admitted source records, the Repository
Provider may take tens of seconds to construct an Architecture overview or
semantic room even when the mapped architecture contains only a small number
of semantic components. A local stress run with 524 indexed records and about
37,000 index tokens measured approximately 43–54 seconds end to end for first
Graph views. Retrieval, Evidence, installation verification, and the mapped
repository system model remained available; the delay was confined to Graph
projection generation and delivery.

Until projection caching is implemented:

- keep the admitted source policy below 500 files when interactive Graph
  startup matters;
- narrow broad generated, vendored, fixture, archive, and data directories
  through the instance include/exclude policy;
- use Evidence and retrieval normally when Graph startup is slow;
- treat a raised `maxFiles` value as an explicit scale trade-off, not a free
  capacity increase.

The planned correction is a source-neutral projection cache keyed by the
current catalog, index, system-model, and presentation digests. It must retain
the same repository-owned truth and freshness checks rather than hiding stale
projections behind a time-based cache.
