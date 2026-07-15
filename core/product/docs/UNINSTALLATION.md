# Atlas Uninstallation Contract

Atlas uninstallation removes one installed Atlas Instance without acquiring
authority over the consumer repository that owns it. The normal repository-
local guarantee is:

> When a repository had no Atlas installation before initialization and no
> sync history was created, installing and uninstalling Atlas restores the
> repository's original file tree exactly.

This is a lifecycle contract, not a generic recursive cleanup command. Atlas
plans the complete removal first, rejects ambiguous ownership before mutation,
and never invokes Git.

## Command Surface

Preview the exact plan:

```bash
.atlas/bin/atlas uninstall --dry-run
```

Run the safe interactive removal:

```bash
.atlas/bin/atlas uninstall
```

Automation must grant confirmation explicitly:

```bash
.atlas/bin/atlas uninstall --yes --json
```

If the installed shim or runtime is incomplete, run the same contract from an
Atlas Product or Public Distribution checkout:

```bash
scripts/atlas-uninstall --repo /path/to/consumer --yes
```

The second invocation after a successful removal returns `already-absent`.

## Ownership Map

The safe default removes:

- the manifest-owned Atlas Core and Atlas Graph runtime, including local Graph
  dependencies;
- `.atlas/bin/` and rebuildable `.atlas/state/` indexes, caches, generated
  summaries, projections, and logs;
- `.atlas/atlas.instance.json`, `.atlas/atlas.install.json`, and
  `.atlas/atlas.lock.json`;
- the marker-owned Atlas region in root `AGENTS.md`;
- the marker-owned Atlas region in root `.gitignore`;
- the `.atlas/` directory after every owned child has been removed and no
  unknown entry remains.

It always preserves:

- durable consumer source roots such as `memory/`, `docs/`, and source code;
- consumer-owned adapters, provider commands, task routes, and generated
  artifacts deliberately saved outside Atlas Instance State;
- every byte outside Atlas-managed `AGENTS.md` and `.gitignore` markers;
- Git history, branches, tags, remotes, staging state, and configuration;
- environment credentials, which Atlas does not persist;
- configured sync exchanges outside the installation removal paths.

There is deliberately no `--delete-memory`, `--delete-sources`, or generic
`--force` option. Atlas Data belongs to the consumer even when Atlas helped
index, summarize, or navigate it.

## Reversible Repository Integrations

Fresh initialization writes a managed `.gitignore` block rather than loose
ignore lines. The current installation lock records the insertion delimiter,
whether Atlas created the file, and the prior content digest for both the
ignore block and optional `AGENTS.md` block. Uninstall uses that receipt to
remove only Atlas-inserted bytes and to delete a file only when Atlas created
the complete file.

Existing installations created before the receipt contract may contain loose
Atlas ignore rules or a managed agent block without insertion provenance.
Uninstall removes recognized marker-owned content conservatively and leaves
unmarked lines or adjacent consumer whitespace untouched. Updating such an
installation creates a receipt for the newly managed ignore region without
claiming ownership of legacy unmarked rules.

## Sync-History Safeguard

The default sync exchange currently lives at
`.atlas/state/sync-exchange`. Immutable revisions in that directory may be the
only local copy of unresolved multi-machine history. When the exchange is
non-empty and lies inside a planned removal path, uninstall stops before
changing any file.

After reviewing the plan, a consumer may explicitly discard that exchange:

```bash
.atlas/bin/atlas uninstall --delete-sync-exchange --yes
```

The flag grants deletion authority only to the configured exchange already
inside Atlas-owned runtime/state. It does not authorize deletion of an
external exchange. A configured exchange outside removal state, including one
selected through `ATLAS_SYNC_EXCHANGE_ROOT`, is preserved and reported.

## Refusal And Recovery

Uninstall rejects:

- a symbolic-link `.atlas` control root;
- malformed or duplicated managed markers;
- any custom runtime/state path, even when it matches the installation lock;
- a non-empty local sync exchange without the explicit deletion flag;
- unknown top-level content under `.atlas/`.

Unknown `.atlas` content is reported rather than guessed away. The user may
move or remove that exact content and rerun the command. A standard repository-
local installation with a missing lock can still be removed from the Product
or Public Distribution recovery command because the canonical
`.atlas/runtime` and `.atlas/state` ownership boundary is fixed. Custom paths
remain fail-closed because a package digest cannot prove that every other byte
in a shared custom directory belongs to Atlas. The plan reports the paths for
manual review; there is no force flag that turns this ambiguity into deletion
authority.

The plan completes all refusal checks before any mutation. A blocked command
therefore leaves the repository unchanged. If an operating-system failure
interrupts an accepted removal, the distribution-side command can be run again
and applies the same idempotent path and marker rules.

## Contract Coverage

`scripts/atlas-uninstall-contract-test` creates arbitrary consumer
repositories in a caller-authorized technical space and proves:

- exact install/uninstall tree restoration with existing consumer
  `AGENTS.md` and `.gitignore` content;
- installed-command preview and self-removal;
- no mutation when local sync history blocks removal;
- explicit local sync-exchange deletion;
- preservation of an external exchange;
- refusal to delete unknown `.atlas` content;
- recovery after the standard installation lock is missing;
- refusal to remove custom runtime/state paths automatically, including paths
  that contain a matching verified Atlas payload;
- idempotent `already-absent` behavior.
