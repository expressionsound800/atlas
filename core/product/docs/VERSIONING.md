# Atlas Product Version Layers

Status: canonical

Atlas uses separate version identities for independently shipped components,
protocol compatibility, installed implementations, and the generated public
distribution. Matching numbers are not required between layers.

| Layer | Version authority | Compatibility boundary |
|---|---|---|
| Atlas Core | Atlas Core `VERSION` | One reviewed Core implementation and its public contracts |
| Atlas Graph | Atlas Graph `package.json` | One reviewed Graph implementation and its provider/browser contracts |
| Evidence protocol | [`evidence-release.json`](../evidence-release.json) and its cited specification digest | One packet schema major and its frozen interpretation |
| Atlas Installation | consumer `.atlas/atlas.install.json` and `.atlas/atlas.lock.json` | Exact installed Core/Graph versions, file digests, Evidence compatibility, and reversible repository integration |
| Atlas Public Distribution | root `VERSION` in the distribution repository | One reviewed solution composition with recorded component and protocol provenance |

## Layer Rules

- Atlas Core and Atlas Graph version independently. A release in one component
  does not require a matching number or a release in the other.
- The Evidence schema major identifies packet compatibility; its implementation
  ships with Atlas Core and is pinned by an exact specification digest.
- An Atlas Installation records what one repository received. Its lock is an
  integrity and compatibility receipt, not a replacement version for Core,
  Graph, or Evidence.
- Atlas Public Distribution versions the reviewed solution composition. It
  records component identities and never renames or redefines them.
- A published component or distribution version is immutable. Any payload,
  contract, or provenance correction receives a new version.
- An update must validate the incoming component contracts and then replace only
  Atlas-owned installation files. Repository sources, source policy, generated
  state, and sync history remain consumer-owned.

## Evidence Is A Versioned Protocol Inside Atlas Core

Evidence is the agent-facing retrieval protocol implemented by Atlas Core. Its
schema major changes only when a consumer must change how it interprets the
packet. Evidence v2 is frozen by [`EVIDENCE_V2.md`](EVIDENCE_V2.md);
[`evidence-release.json`](../evidence-release.json) records the specification
digest and compatibility boundary. Installation locks and public-distribution
provenance record the same identity plus the exact implementation digest.

The Evidence protocol does not have an independent Git repository or release
boundary. It is not independently installed, packaged, or
maintained, and its implementation cannot currently operate without Atlas
Core's provider, retrieval, instance, and installation contracts. A separate
Git boundary would duplicate the Core release commit without creating an
independent rollback or delivery surface.

Evidence receives an independent Git/component boundary only after a deliberate
taxonomy decision and when at least one of these conditions is true:

- another implementation consumes the Evidence specification without Atlas
  Core;
- Evidence is distributed as a separate package or SDK;
- Evidence and Atlas Core require independent release or rollback cadences;
- multiple agent integrations negotiate Evidence compatibility directly
  instead of through an installed Atlas Core version.

If one of those triggers occurs, register Evidence as a shared-repository
component or move it to a canonical repository before creating refs. Do not
retrofit or move the immutable Core release that originally carried it.

## Compatibility Rules

- Adding optional fields or clarifying documentation may remain within Evidence
  v2 when existing consumers retain the same interpretation.
- Changing required fields, state meanings, freshness semantics, privacy
  boundaries, digest rules, or agent stop/retry behavior requires Evidence v3.
- An implementation correction that preserves the frozen v2 semantics receives
  an Atlas Core patch release; it does not rename the protocol.
- Atlas Graph does not require Evidence packets. Graph consumes provider graph
  projections, so Evidence changes do not force a Graph version change unless
  the Graph contract or implementation also changes.
- Public Distribution versions never redefine component or protocol
  compatibility. They record the reviewed versions and digests they contain.

## Evidence v2 Release Boundary

Evidence v2 first shipped in Atlas Core `0.3.0`; that reviewed Core release is
its implementation boundary. [`evidence-release.json`](../evidence-release.json)
is the machine-readable compatibility record. Its specification digest must
match [`EVIDENCE_V2.md`](EVIDENCE_V2.md) before an installation, public
distribution, or contract test can pass.
