# Atlas Repository-Local Instance Contract

An Atlas instance belongs to exactly one consumer repository. Atlas Core and
Atlas Graph product code are developed in their own repositories, but source
memory, catalog policy, indexes, Graph projections, sync identity, and
reconciliation decisions remain owned by the consumer.

## Bootstrap

From the downloaded Atlas distribution:

```bash
cd /path/to/atlas
scripts/atlas-init \
  --repo /path/to/consumer \
  --with-graph
```

The initializer creates three tracked files:

- `.atlas/atlas.instance.json` selects repository identity, bounded source
  inputs, optional repository adapter, generation mode/adapter, local index
  path, Graph entry room, and sync namespace/exchange path.
- `.atlas/atlas.install.json` pins Atlas and Graph versions and revisions.
- `.atlas/atlas.lock.json` records the exact installed files and package
  digests plus the frozen Evidence protocol, specification, release-record,
  implementation, compatibility identity, and reversible repository-
  integration receipt.

For AGENTS-compatible hosts, fresh initialization also creates or appends a
deterministic managed block in root `AGENTS.md`. Consumer instructions outside
the Atlas markers remain byte-for-byte owned by the repository. Pass
`--no-agent-instructions` to keep invocation policy entirely consumer-authored.

It also creates ignored `.atlas/runtime`, `.atlas/state`, and `.atlas/bin`
paths. The generated `.atlas/bin/atlas` shim contains only relative paths, so a
checkout can move and normal use does not depend on either product source
checkout.

The ignore rules live inside an Atlas marker block. Together with the managed
`AGENTS.md` block, that mutation is recorded in the installation lock so
uninstall can restore existing consumer files without claiming unmarked bytes.

## Default Adapter

Without a custom adapter, Atlas reads only the tracked instance source policy.
The scan is bounded, excludes Atlas and repository infrastructure, does not
follow symbolic links, and turns admitted files into digest-bearing,
searchable, non-navigable source evidence. Initialization accepts explicit
`--include` and repeatable `--extension` values only while creating the
instance; later source-policy changes belong in
`.atlas/atlas.instance.json`, so an update cannot silently broaden access.

Source evidence remains distinct from architecture. Before mapping, Graph may
show a truthful Source Inventory, but source files cannot be entered as rooms.
`.atlas/bin/atlas map` uses the existing Generation Provider binding to create
a cited Repository System Model v1. Only current, validated semantic
components become room entries; raw files remain retrieval evidence.

The repository authority stays non-enterable on the overview. Inside a
semantic-room projection it becomes a repository-overview return node, so it
can navigate back without becoming a room itself. Empty Sessions, Git Gate,
and Backlog sources remain unavailable and Graph omits their controls.

[`EVIDENCE_SOURCES_AND_MAPPING.md`](EVIDENCE_SOURCES_AND_MAPPING.md) defines the
complete source policy, scan and title rules, observable relationships, index
modes, Evidence v2 source checks, Source Inventory projection, mapping request,
model validation, and freshness behavior.

## Repository Adapter

An existing consumer may retain a richer catalog by configuring a relative
module in `adapter.module` and an exported builder name in
`adapter.exportName`:

```json
{
  "adapter": {
    "module": "scripts/repository-atlas-adapter.mjs",
    "exportName": "buildAtlasCatalog"
  }
}
```

The builder receives
`{ root, instance, paths, sourceCatalog, sourceEvidenceRooms }` and returns a
catalog, or an object containing `catalog`. `sourceCatalog` is Core's complete
bounded default catalog; `sourceEvidenceRooms` contains only its admitted,
non-navigable source records. Core composes any missing source records beside
the returned semantic catalog, deduplicates exact source paths, and rejects a
room-id collision that names a different source. A custom adapter can enrich
repository semantics without erasing the paths, digests, excerpts, and line
locators required by Evidence v2.

The module is consumer-owned and must not import the Atlas development
checkout. Retrieval stays behind the installed repository-provider contract.

A rich adapter may add a `metadata.evidence` object to a room. Supported
fields are a stable `kind`, an optional explicit `state`, and a comparable
`sourceDigest` plus `sourceDigestAlgorithm`. `conflicting`, `stale`, `missing`,
and `weak` declarations can only reduce trust; a declaration cannot upgrade a
missing, excluded, stale, or weakly matched source to strong evidence. Source
paths remain readable only when the instance `source.include` and
`source.exclude` policy admits them.

`graph.providerCommand` may name a relative consumer-owned HTTP provider when
the default source-inventory or mapped system-model projection is not
sufficient. The command must serve the installed Graph provider endpoints on
loopback using the `ATLAS_PROVIDER_PORT` environment variable.

## Generation Provider

Generation is independent from the Repository Provider. The Repository
Provider indexes and retrieves consumer knowledge. The Generation Provider
produces source-backed summaries, specifications, and explanations through the
shared contract in `GENERATION_PROVIDERS.md`.

Fresh instances use `generation.mode: current-agent`. Atlas writes a request;
the user's active Codex, Claude, or other agent writes a structured result;
Atlas validates and applies it. A local or hosted model integration is a
consumer-selected `command` adapter. Remote adapters require an explicit grant
on every invocation, and credentials remain outside tracked instance files.
`atlas map` uses this same binding; it does not create another provider,
model, credential, or durable-source authority.

## Local Command

After bootstrap, normal operation uses only the instance command:

```bash
.atlas/bin/atlas verify
.atlas/bin/atlas index
.atlas/bin/atlas search "query"
.atlas/bin/atlas evidence "query"
.atlas/bin/atlas agent-instructions
.atlas/bin/atlas map
.atlas/bin/atlas generation status
.atlas/bin/atlas generation request --kind source-summary --source docs/ARCHITECTURE.md
.atlas/bin/atlas graph --open
.atlas/bin/atlas sync status
.atlas/bin/atlas uninstall --dry-run
```

Sync writes immutable revision objects to the instance exchange path, or to
the explicit `ATLAS_SYNC_EXCHANGE_ROOT`. Concurrent claims remain conflicts
until a reviewed merge revision names every conflicting head as a parent.
Atlas does not invoke Git or publish private memory.

## Explicit Product Update

Instances do not follow product source checkouts automatically. Update from a
newer downloaded Atlas distribution explicitly:

```bash
cd /path/to/new-atlas-distribution
scripts/atlas-init \
  --repo /path/to/consumer \
  --update
```

The update preserves `atlas.instance.json`, refreshes the manifest and lock,
reinstalls Graph dependencies, regenerates the relative command shim, and
verifies the resulting runtime. It reports the root `AGENTS.md` managed-block
status but does not rewrite consumer instructions. Pass
`--refresh-agent-instructions` to update only the Atlas managed region
explicitly. Each repository can update independently.

## Explicit Uninstall

Uninstall is bound to this repository just like every other installed command:

```bash
.atlas/bin/atlas uninstall
```

Atlas first plans every removal and preservation decision. It removes the
runtime, command shim, rebuildable state, tracked Atlas control files, and
marker-owned repository integrations. It does not delete declared source
roots, consumer adapters, Git state, credentials, or an external sync
exchange. A non-empty exchange inside `.atlas/state` stops before mutation
unless `--delete-sync-exchange` is supplied explicitly. The recovery command
and exact round-trip guarantee are defined in `UNINSTALLATION.md`.

## Contract Test

`scripts/atlas-instance-contract-test` creates two arbitrary repositories,
bootstraps both instances, proves installed search/evidence/Graph operation,
moves one checkout to a different absolute path, disables development-checkout
fallbacks, creates concurrent sync heads, and resolves them with a reviewed
merge revision. Its work root must come from a registered technical space.

`scripts/atlas-evidence-contract-test` separately proves the frozen v2 schema,
specification/release digests and tamper rejection, deterministic
ordering/digest, all five evidence states, bounded excerpts,
fixed-corpus top-result usefulness and source-hint coverage, and zero leakage
of excluded source bytes, excluded paths, absolute repository roots, or the
machine-local index path.

`scripts/atlas-agent-invocation-contract-test` creates fresh repositories with
and without existing `AGENTS.md` files and proves deterministic discovery,
consumer-instruction preservation, idempotency, stale-block detection,
explicit refresh and opt-out, two-repository isolation, moved-checkout use,
offline Evidence v2 parity, and invalid-marker rejection.

`scripts/atlas-uninstall-contract-test` proves exact arbitrary-repository
round trips, installed self-removal, sync-history refusal, external-exchange
preservation, unknown-content refusal, standard-layout recovery, and
idempotency.
