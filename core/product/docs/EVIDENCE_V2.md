# Atlas Evidence v2 Protocol

Status: frozen

Introduced by: Atlas Core 0.3.0

Implementation: `product/evidence-contract.mjs`

## Purpose And Authority

Evidence v2 is the deterministic agent-facing handoff from Atlas retrieval to
source verification. It returns ranked navigation evidence; it does not turn
catalog summaries, generated indexes, or excerpts into durable source
authority. The consumer repository remains the source authority.

The packet schema is `multihead-atlas.instance_evidence.v2`. The embedded
contract schema is `multihead-atlas.instance_evidence_contract.v2`, with
`contractVersion` equal to `2`.

## Packet Contract

A packet contains:

- its schema and frozen contract identity;
- execution status and overall evidence state;
- repository identity and the visible bounded query;
- provider, catalog, adapter, and index identity without machine-local roots;
- ranked evidence items;
- result, state, source-hint, excerpt, and top-result metrics;
- sorted diagnostics; and
- a SHA-256 packet digest over every preceding packet field.

Generated timestamps, absolute repository roots, index paths, remote URLs, and
excluded-source details are not packet fields. Identical admitted inputs must
produce identical packet bytes and digest.

## Evidence Item Contract

Each evidence item contains a room identity, supported kind, state, bounded
label and summary, source record, optional relative locator and excerpt,
freshness record, inspectable match/score reasons, and diagnostics.

Source locators are repository-relative. Excerpts contain no more than five
lines and 1,000 characters. Source and packet digests use SHA-256 over UTF-8
content. Symlinks, paths outside the repository, excluded paths, files outside
the configured include/depth/extension/size policy, and absolute source paths
are not readable evidence.

## States

The supported states are `strong`, `weak`, `stale`, `missing`, and
`conflicting`.

- `strong` means an admitted source is available, content-current, and has a
  sufficiently strong inspectable match.
- `weak` means evidence exists but its match, kind, or freshness cannot support
  a strong conclusion.
- `stale` means the current source bytes disagree with the indexed or declared
  freshness boundary.
- `missing` means no usable evidence exists, or the requested source is absent
  or not authorized by the instance source policy.
- `conflicting` means competing durable records require explicit
  reconciliation before the affected conclusion can proceed.

Overall state precedence is conflicting, stale, strong, missing, then weak.
Agents may retry weak, stale, or missing evidence through the installed Atlas
path, but must stop the affected conclusion on conflicting evidence.

## Compatibility

Evidence v2 first ships with Atlas Core 0.3.0. Atlas Graph is optional and does
not consume this packet. The minimal agent-invocation contract
`multihead-atlas.agent_invocation.v1` requires this packet schema.

Optional additions remain compatible only when an existing v2 consumer can
ignore them without changing interpretation. A change to required fields,
state semantics or precedence, source privacy, freshness, digest construction,
determinism, or agent stop/retry meaning requires a new Evidence schema major.

## Git Boundary

Evidence v2 is released by Atlas Core rather than an independent Git
repository. The rationale and the conditions that would trigger a separate
component or repository boundary are canonical in `product/docs/VERSIONING.md` and
machine-readable in `product/evidence-release.json`.
