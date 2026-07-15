# Atlas Installation Contract

Atlas installations are scoped to one repository, one meta-repository, or an
explicit global root. Repository-local is the default.

The consumer tracks `.atlas/atlas.instance.json`,
`.atlas/atlas.install.json`, and `.atlas/atlas.lock.json`. Installed product
code lives under the manifest's `runtimePath`; command shims, SQLite indexes,
caches, logs, and projections are local generated data. See `INSTANCE.md` for
the repository-local bootstrap and command contract.

Fresh repository initialization also installs the deterministic Atlas managed
block in root `AGENTS.md` unless the consumer passes
`--no-agent-instructions`. This tracked instruction is consumer-visible and
calls only the relative installed CLI. Runtime updates preserve it unless the
consumer explicitly requests `--refresh-agent-instructions`.

Initialization also writes a marker-owned `.gitignore` region for generated
runtime, state, and command paths. The installation lock records reversible
mutation receipts for that region and the optional `AGENTS.md` region so a
fresh uninstall can restore pre-install consumer bytes exactly.

The installed Atlas runtime also includes `sync-protocol.mjs` and
`scripts/atlas-sync`. A consumer may point the command at a separate tracked
exchange root, but the installation manifest does not make that exchange root
or its Git remote global memory authority. See `SYNC.md`.

It also includes `generation-provider.mjs`, the deterministic command-adapter
mock, and the OpenAI adapter. New instances select the current-agent handshake;
API credentials are never installation inputs and are not recorded in the
manifest or lock. See `GENERATION_PROVIDERS.md`.

An abridged manifest:

```json
{
  "installationId": "example-repository",
  "scope": "repository",
  "runtimePath": ".atlas/runtime",
  "statePath": ".atlas/state",
  "packages": {
    "atlas": { "version": "0.6.0" },
    "graph": { "version": "0.6.3" }
  }
}
```

`packages.*.revision` may additionally pin the required Git commit. On first
installation the lock records exact revisions, content digests, and installed
files. Later installs reject source files that do not match their committed
revision unless the explicit development override is supplied.

The installation lock also records the frozen Evidence protocol schema,
contract version, specification SHA-256,
release-record SHA-256, exact implementation SHA-256, Atlas Core compatibility,
optional Graph relationship, and the reversible repository-integration
receipt. Evidence inherits the Core Git boundary; the separate lock record
exists for protocol negotiation and audit, not for a third package authority.
See `VERSIONING.md`.

[`INSTANCE.md`](INSTANCE.md) owns repository-local bootstrap, initial source
policy, installed command use, explicit update, and instance authority.
[`EVIDENCE_SOURCES_AND_MAPPING.md`](EVIDENCE_SOURCES_AND_MAPPING.md) owns the
complete source-admission and indexing behavior. This installation contract
defines what the initializer records and installs rather than repeating those
operator workflows.

## Graph Dependency Lifecycle

`--with-graph` is an explicit request to make the installed Graph runtime
launchable. It installs the Graph package dependencies under the consumer's
repository-local Atlas runtime with `npm ci --ignore-scripts`. Atlas does not
require a global Vite installation and does not use implicit package
`postinstall` mutation. `node_modules` is rebuildable local runtime state; it
is neither product source nor installation-lock authority.

Runtime update replaces the installed product tree atomically. If the previous
installation was Graph-ready, update must restore its local Graph dependencies
after replacement even when the caller does not repeat `--with-graph`.
Explicit `--with-graph` continues to enable Graph for an installation that did
not have it. Production acceptance requires the installed `verify`, Evidence
v2, and Graph smoke paths to pass both immediately after initialization and
again after update.

Verify without mutating the installation:

```bash
cd /path/to/consumer
.atlas/bin/atlas verify
```

Run the installed Graph lens against a repository-owned provider:

```bash
node /path/to/consumer/.atlas/runtime/atlas/scripts/atlas-graph \
  --root /path/to/consumer \
  --provider-command scripts/repository-atlas-provider \
  --room REPOSITORY-ID \
  --open
```

The launcher verifies the manifest and lock, starts the configured consumer
provider, then starts a Graph process bound to that provider. It never treats
an occupied, health-compatible local port as instance identity. After choosing
a free port, the launcher also requires the Graph response to echo an identity
derived from the consumer installation ID, exact locked Graph package digest,
and selected provider URL. A missing or different response identity is never
accepted as the launched runtime. The provider owns catalog, memory, graph
projections, and generated state; the installed runtime does not discover
those sources.

Source checkout paths are machine inputs. They never enter the manifest or
lock. A global installation may share a launcher or product cache, but it does
not become repository memory, route, catalog, or index authority.

## Uninstallation Lifecycle

Repository-local installations expose a previewable removal plan through the
installed command. Removal is limited to lock-identified runtime, rebuildable
state, control files, and marker-owned integrations; durable sources and
external exchanges remain consumer-owned. [`UNINSTALLATION.md`](UNINSTALLATION.md)
defines the command, sync-history refusal, recovery path, and exact ownership
rules.
