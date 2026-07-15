/*
 * Uninstall Contract owns Atlas's repository-local removal plan and the
 * managed .gitignore integration installed beside an Atlas Instance. It
 * removes only paths proven to belong to the installation, preserves durable
 * consumer sources and external exchanges, and rejects ambiguous cleanup
 * before mutation. CLI wrappers must call this contract rather than deriving
 * a broader deletion surface independently.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  inspectAtlasAgentInstructions,
  removeAtlasAgentInstructions,
} from "./agent-invocation-contract.mjs";
import {
  ATLAS_INSTALLATION_LOCK_SCHEMA,
  readAtlasInstallationManifest,
} from "./installation-contract.mjs";
import { readAtlasInstanceConfig } from "./instance-contract.mjs";

export const ATLAS_REPOSITORY_INTEGRATION_SCHEMA = "multihead-atlas.repository_integration.v1";
export const ATLAS_UNINSTALL_PLAN_SCHEMA = "multihead-atlas.uninstall_plan.v1";
export const ATLAS_UNINSTALL_RESULT_SCHEMA = "multihead-atlas.uninstall_result.v1";
export const ATLAS_IGNORE_BEGIN = `# atlas-ignore:begin ${ATLAS_REPOSITORY_INTEGRATION_SCHEMA}`;
export const ATLAS_IGNORE_END = `# atlas-ignore:end ${ATLAS_REPOSITORY_INTEGRATION_SCHEMA}`;
export const ATLAS_IGNORE_RULES = Object.freeze([".atlas/bin/", ".atlas/runtime/", ".atlas/state/"]);

/** Computes the receipt digest used to recognize unchanged consumer integration bytes. */
function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Counts exact marker occurrences so partial or duplicated managed regions are rejected. */
function countOccurrences(value, token) {
  return String(value).split(token).length - 1;
}

/** Locates one complete managed marker pair and returns its byte range. */
function managedRange(content, beginMarker, endMarker, label) {
  const beginCount = countOccurrences(content, beginMarker);
  const endCount = countOccurrences(content, endMarker);
  if (beginCount === 0 && endCount === 0) return null;
  if (beginCount !== 1 || endCount !== 1) throw new Error(`${label} requires exactly one complete managed block`);
  const begin = content.indexOf(beginMarker);
  const end = content.indexOf(endMarker);
  if (end < begin) throw new Error(`${label} markers are out of order`);
  return Object.freeze({ begin, end: end + endMarker.length });
}

/** Renders the complete ignore-rule region whose markers grant Atlas removal authority. */
export function renderAtlasIgnoreBlock() {
  return `${ATLAS_IGNORE_BEGIN}\n${ATLAS_IGNORE_RULES.join("\n")}\n${ATLAS_IGNORE_END}`;
}

/** Merges one canonical ignore region while preserving every consumer byte outside its markers. */
export function mergeAtlasIgnoreRules(content = "") {
  const current = String(content);
  const expected = renderAtlasIgnoreBlock();
  const range = managedRange(current, ATLAS_IGNORE_BEGIN, ATLAS_IGNORE_END, "Atlas ignore rules");
  if (range) {
    const merged = `${current.slice(0, range.begin)}${expected}${current.slice(range.end)}`;
    return Object.freeze({ content: merged, action: merged === current ? "unchanged" : "updated", mutation: null });
  }
  const separator = !current ? "" : current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  return Object.freeze({
    content: `${current}${separator}${expected}\n`,
    action: current ? "appended" : "created",
    mutation: Object.freeze({ insertedPrefix: separator, insertedSuffix: "\n" }),
  });
}

/** Installs the managed ignore region atomically and returns its reversible mutation receipt. */
export function installAtlasIgnoreRules(options = {}) {
  const rootText = String(options.root || "").trim();
  if (!rootText) throw new Error("Atlas ignore-rule installation requires root");
  const root = path.resolve(rootText);
  const ignorePath = path.join(root, ".gitignore");
  const existed = fs.existsSync(ignorePath);
  if (existed && fs.lstatSync(ignorePath).isSymbolicLink()) throw new Error("Atlas ignore rules refuse a symbolic-link .gitignore");
  const current = existed ? fs.readFileSync(ignorePath, "utf8") : "";
  const merged = mergeAtlasIgnoreRules(current);
  if (merged.action !== "unchanged") {
    const staging = `${ignorePath}.writing-${process.pid}`;
    fs.writeFileSync(staging, merged.content, "utf8");
    fs.renameSync(staging, ignorePath);
  }
  return Object.freeze({
    status: "current",
    action: merged.action,
    path: ".gitignore",
    mutation: merged.mutation ? Object.freeze({
      path: ".gitignore",
      createdFile: !existed,
      insertedPrefix: merged.mutation.insertedPrefix,
      insertedSuffix: merged.mutation.insertedSuffix,
      previousDigest: sha256(current),
    }) : null,
  });
}

/** Validates one reversible managed-text receipt without accepting arbitrary target paths. */
function managedTextReceipt(value, expectedPath, field) {
  if (!value) return null;
  if (typeof value !== "object" || Array.isArray(value) || value.path !== expectedPath) {
    throw new Error(`Atlas repository integration ${field} is invalid`);
  }
  const insertedPrefix = String(value.insertedPrefix ?? "");
  const insertedSuffix = String(value.insertedSuffix ?? "");
  const previousDigest = String(value.previousDigest || "");
  if (!/^\n{0,2}$/u.test(insertedPrefix) || insertedSuffix !== "\n" || !/^[a-f0-9]{64}$/u.test(previousDigest)) {
    throw new Error(`Atlas repository integration ${field} receipt is invalid`);
  }
  return Object.freeze({
    path: expectedPath,
    createdFile: value.createdFile === true,
    insertedPrefix,
    insertedSuffix,
    previousDigest,
  });
}

/** Validates the lock-owned receipt that lets uninstall reverse only Atlas-inserted bytes. */
export function validateAtlasRepositoryIntegration(value) {
  if (!value) return null;
  if (typeof value !== "object" || Array.isArray(value) || value.schema !== ATLAS_REPOSITORY_INTEGRATION_SCHEMA) {
    throw new Error(`Atlas repository integration schema must be ${ATLAS_REPOSITORY_INTEGRATION_SCHEMA}`);
  }
  return Object.freeze({
    schema: value.schema,
    agentInstructions: managedTextReceipt(value.agentInstructions, "AGENTS.md", "agentInstructions"),
    ignoreRules: managedTextReceipt(value.ignoreRules, ".gitignore", "ignoreRules"),
  });
}

/** Reads an optional integration receipt from an installation lock, including legacy locks with no receipt. */
export function readAtlasRepositoryIntegration(lockPath) {
  const resolved = path.resolve(String(lockPath || ""));
  if (!String(lockPath || "").trim() || !fs.existsSync(resolved)) return null;
  const lock = JSON.parse(fs.readFileSync(resolved, "utf8"));
  return validateAtlasRepositoryIntegration(lock.repositoryIntegration || null);
}

/** Writes the latest reversible integration receipt into the installation lock after repository mutations succeed. */
export function writeAtlasRepositoryIntegration(options = {}) {
  const lockPath = path.resolve(String(options.lockPath || ""));
  if (!String(options.lockPath || "").trim() || !fs.existsSync(lockPath)) {
    throw new Error("Atlas repository integration requires an existing installation lock");
  }
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  if (lock.schema !== ATLAS_INSTALLATION_LOCK_SCHEMA) throw new Error("Atlas repository integration requires the current installation lock schema");
  const previous = validateAtlasRepositoryIntegration(options.previous || lock.repositoryIntegration || null);
  const integration = validateAtlasRepositoryIntegration({
    schema: ATLAS_REPOSITORY_INTEGRATION_SCHEMA,
    agentInstructions: options.agentInstructions?.mutation || previous?.agentInstructions || null,
    ignoreRules: options.ignoreRules?.mutation || previous?.ignoreRules || null,
  });
  lock.repositoryIntegration = integration;
  const staging = `${lockPath}.writing-${process.pid}`;
  fs.writeFileSync(staging, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  fs.renameSync(staging, lockPath);
  return integration;
}

/** Reports managed ignore-region status without interpreting unmarked consumer rules as Atlas-owned. */
export function inspectAtlasIgnoreRules(options = {}) {
  const root = path.resolve(String(options.root || ""));
  if (!String(options.root || "").trim()) throw new Error("Atlas ignore-rule inspection requires root");
  const ignorePath = path.join(root, ".gitignore");
  if (!fs.existsSync(ignorePath)) return Object.freeze({ status: "absent", managed: false, path: ".gitignore" });
  if (fs.lstatSync(ignorePath).isSymbolicLink()) return Object.freeze({ status: "invalid", managed: false, path: ".gitignore", reason: "ignore-path-is-symbolic-link" });
  const content = fs.readFileSync(ignorePath, "utf8");
  try {
    const range = managedRange(content, ATLAS_IGNORE_BEGIN, ATLAS_IGNORE_END, "Atlas ignore rules");
    if (!range) return Object.freeze({ status: "absent", managed: false, path: ".gitignore" });
    const actual = content.slice(range.begin, range.end);
    return Object.freeze({
      status: actual === renderAtlasIgnoreBlock() ? "current" : "stale",
      managed: true,
      path: ".gitignore",
      actualDigest: sha256(actual),
    });
  } catch (error) {
    return Object.freeze({ status: "invalid", managed: false, path: ".gitignore", reason: error.message });
  }
}

/** Removes one marker-owned text region and restores its recorded insertion delimiter when still present. */
function removeManagedText(options = {}) {
  const filePath = path.resolve(options.filePath);
  if (!fs.existsSync(filePath)) return Object.freeze({ status: "absent", action: "unchanged" });
  if (fs.lstatSync(filePath).isSymbolicLink()) throw new Error(`${options.label} refuses a symbolic-link target`);
  const content = fs.readFileSync(filePath, "utf8");
  const range = managedRange(content, options.beginMarker, options.endMarker, options.label);
  if (!range) return Object.freeze({ status: "absent", action: "unchanged" });
  const receipt = options.receipt || null;
  let begin = range.begin;
  let end = range.end;
  if (receipt?.insertedPrefix && content.slice(begin - receipt.insertedPrefix.length, begin) === receipt.insertedPrefix) {
    begin -= receipt.insertedPrefix.length;
  }
  if (receipt?.insertedSuffix && content.slice(end, end + receipt.insertedSuffix.length) === receipt.insertedSuffix) {
    end += receipt.insertedSuffix.length;
  }
  const remaining = `${content.slice(0, begin)}${content.slice(end)}`;
  const markerOnlyLegacyFile = !receipt && content === `${options.beginMarker}\n${ATLAS_IGNORE_RULES.join("\n")}\n${options.endMarker}\n`;
  if ((receipt?.createdFile && !remaining) || markerOnlyLegacyFile) {
    fs.rmSync(filePath);
    return Object.freeze({ status: "removed", action: "deleted-file", restoredDigest: sha256(remaining) });
  }
  const staging = `${filePath}.writing-${process.pid}`;
  fs.writeFileSync(staging, remaining, "utf8");
  fs.renameSync(staging, filePath);
  return Object.freeze({
    status: "removed",
    action: "removed-managed-block",
    restoredDigest: sha256(remaining),
    matchesPreviousDigest: receipt ? sha256(remaining) === receipt.previousDigest : null,
  });
}

/** Removes only the marker-owned ignore region and leaves every unmarked rule untouched. */
export function removeAtlasIgnoreRules(options = {}) {
  const root = path.resolve(String(options.root || ""));
  if (!String(options.root || "").trim()) throw new Error("Atlas ignore-rule removal requires root");
  return removeManagedText({
    filePath: path.join(root, ".gitignore"),
    label: "Atlas ignore rules",
    beginMarker: ATLAS_IGNORE_BEGIN,
    endMarker: ATLAS_IGNORE_END,
    receipt: options.receipt || null,
  });
}

/** Resolves a manifest-owned child path and rejects root aliases or parent escapes. */
function ownedChild(root, relative, field) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, String(relative || ""));
  const relation = path.relative(resolvedRoot, resolved);
  if (!relation || relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error(`Atlas uninstall ${field} must stay inside the repository root`);
  }
  return resolved;
}

/** Reports whether one candidate equals or descends from an Atlas-owned removal root. */
function pathContains(parent, candidate) {
  const relation = path.relative(path.resolve(parent), path.resolve(candidate));
  return !relation || (relation !== ".." && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation));
}

/** Converts one absolute consumer path into stable slash-separated repository output. */
function displayPath(root, absolute) {
  return path.relative(path.resolve(root), path.resolve(absolute)).replaceAll(path.sep, "/") || ".";
}

/** Counts all entries below one exchange root without following symbolic links. */
function countTreeEntries(root) {
  if (!fs.existsSync(root)) return 0;
  const status = fs.lstatSync(root);
  if (!status.isDirectory() || status.isSymbolicLink()) return 1;
  let count = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    count += 1;
    if (entry.isDirectory() && !entry.isSymbolicLink()) count += countTreeEntries(path.join(root, entry.name));
  }
  return count;
}

/** Returns unique existing removal targets with descendants collapsed under their owning parent. */
function compactRemovalPaths(paths) {
  const ordered = [...new Set(paths.map((value) => path.resolve(value)))]
    .filter((value) => fs.existsSync(value))
    .sort((left, right) => left.length - right.length || left.localeCompare(right));
  return ordered.filter((candidate, index) => !ordered.slice(0, index).some((parent) => pathContains(parent, candidate)));
}

/** Reads JSON when present and converts malformed consumer control files into a named plan blocker. */
function guardedRead(operation, blockers, code) {
  try {
    return operation();
  } catch (error) {
    blockers.push({ code, detail: String(error?.message || error) });
    return null;
  }
}

/** Builds the complete no-mutation uninstall plan, including every preservation or refusal reason. */
export function planAtlasUninstall(options = {}) {
  const rootText = String(options.root || "").trim();
  if (!rootText) throw new Error("Atlas uninstall requires root");
  const root = path.resolve(rootText);
  const atlasRoot = path.join(root, ".atlas");
  const blockers = [];
  const preserved = [];
  const removals = [];
  if (fs.existsSync(atlasRoot) && fs.lstatSync(atlasRoot).isSymbolicLink()) {
    blockers.push({ code: "atlas-root-symbolic-link", detail: ".atlas must not be a symbolic link" });
  }

  const manifestPath = path.join(atlasRoot, "atlas.install.json");
  const instancePath = path.join(atlasRoot, "atlas.instance.json");
  const lockPath = path.join(atlasRoot, "atlas.lock.json");
  const manifest = fs.existsSync(manifestPath)
    ? guardedRead(() => readAtlasInstallationManifest(manifestPath), blockers, "installation-manifest-invalid")
    : null;
  const instance = fs.existsSync(instancePath)
    ? guardedRead(() => readAtlasInstanceConfig(instancePath), blockers, "instance-config-invalid")
    : null;
  let lock = null;
  if (fs.existsSync(lockPath)) {
    lock = guardedRead(() => JSON.parse(fs.readFileSync(lockPath, "utf8")), blockers, "installation-lock-invalid-json");
    if (lock && ![ATLAS_INSTALLATION_LOCK_SCHEMA, "multihead-atlas.installation_lock.v2"].includes(lock.schema)) {
      blockers.push({ code: "installation-lock-schema-unsupported", detail: String(lock.schema || "missing schema") });
    }
  }
  const integration = lock
    ? guardedRead(() => validateAtlasRepositoryIntegration(lock.repositoryIntegration || null), blockers, "repository-integration-invalid")
    : null;

  let runtimeRoot = path.join(atlasRoot, "runtime");
  let stateRoot = path.join(atlasRoot, "state");
  if (manifest) {
    runtimeRoot = ownedChild(root, manifest.runtimePath, "runtimePath");
    stateRoot = ownedChild(root, manifest.statePath, "statePath");
    const standardLayout = manifest.runtimePath.replaceAll("\\", "/") === ".atlas/runtime"
      && manifest.statePath.replaceAll("\\", "/") === ".atlas/state";
    if (!standardLayout) {
      blockers.push({
        code: "custom-layout-requires-manual-removal",
        detail: "automatic uninstall owns only the canonical .atlas/runtime and .atlas/state layout; inspect custom paths before removing them manually",
      });
    }
  }
  const binRoot = path.join(atlasRoot, "bin");
  removals.push(runtimeRoot, stateRoot, binRoot, instancePath, manifestPath, lockPath);

  const exchangeRoot = instance
    ? ownedChild(root, instance.sync.exchangePath, "sync.exchangePath")
    : path.join(stateRoot, "sync-exchange");
  const environmentExchange = String(options.environmentExchange || process.env.ATLAS_SYNC_EXCHANGE_ROOT || "").trim();
  const exchanges = [{ root: exchangeRoot, authority: "instance-config" }];
  if (environmentExchange && path.resolve(environmentExchange) !== path.resolve(exchangeRoot)) {
    exchanges.push({ root: path.resolve(environmentExchange), authority: "environment" });
  }
  const exchangeStatus = exchanges.map((exchange) => {
    const entries = countTreeEntries(exchange.root);
    const insideRemovalState = [runtimeRoot, stateRoot, binRoot].some((owned) => pathContains(owned, exchange.root));
    if (insideRemovalState && entries > 0 && !options.deleteSyncExchange) {
      blockers.push({
        code: "sync-exchange-not-empty",
        detail: `${displayPath(root, exchange.root)} contains ${entries} entries; pass --delete-sync-exchange to discard it explicitly`,
      });
    } else if (!insideRemovalState && fs.existsSync(exchange.root)) {
      preserved.push({
        path: exchange.authority === "environment" ? path.resolve(exchange.root) : displayPath(root, exchange.root),
        reason: exchange.authority === "environment"
          ? "environment-selected-external-sync-exchange"
          : "configured-sync-exchange-outside-installation-state",
      });
    }
    return Object.freeze({
      path: displayPath(root, exchange.root),
      authority: exchange.authority,
      entries,
      insideRemovalState,
    });
  });

  const agentStatus = inspectAtlasAgentInstructions({ root });
  const ignoreStatus = inspectAtlasIgnoreRules({ root });
  if (agentStatus.status === "invalid") blockers.push({ code: "agent-instructions-invalid", detail: agentStatus.reason });
  if (ignoreStatus.status === "invalid") blockers.push({ code: "ignore-rules-invalid", detail: ignoreStatus.reason });

  if (fs.existsSync(atlasRoot) && !fs.lstatSync(atlasRoot).isSymbolicLink()) {
    const allowed = new Set(["atlas.instance.json", "atlas.install.json", "atlas.lock.json", "bin"]);
    for (const owned of [runtimeRoot, stateRoot]) {
      if (path.dirname(owned) === atlasRoot) allowed.add(path.basename(owned));
    }
    for (const entry of fs.readdirSync(atlasRoot)) {
      if (allowed.has(entry) || /^runtime\.installing-\d+$/u.test(entry) || /^atlas\..+\.writing-\d+$/u.test(entry)) continue;
      blockers.push({ code: "unknown-atlas-content", detail: `.atlas/${entry}` });
    }
    for (const entry of fs.readdirSync(atlasRoot)) {
      if (/^runtime\.installing-\d+$/u.test(entry) || /^atlas\..+\.writing-\d+$/u.test(entry)) removals.push(path.join(atlasRoot, entry));
    }
  }

  const removalPaths = compactRemovalPaths(removals);
  const hasManagedIntegration = agentStatus.managed || ignoreStatus.managed;
  const alreadyAbsent = !removalPaths.length && !hasManagedIntegration && !fs.existsSync(atlasRoot);
  return Object.freeze({
    schema: ATLAS_UNINSTALL_PLAN_SCHEMA,
    status: blockers.length ? "blocked" : alreadyAbsent ? "already-absent" : "ready",
    repositoryRoot: root,
    installationId: manifest?.installationId || instance?.repositoryId || "",
    removalPaths: Object.freeze(removalPaths.map((absolute) => displayPath(root, absolute))),
    integrations: Object.freeze({
      agentInstructions: agentStatus,
      ignoreRules: ignoreStatus,
      receipt: integration,
    }),
    sync: Object.freeze({
      exchangePath: displayPath(root, exchangeRoot),
      entries: exchangeStatus[0].entries,
      deletionAuthorized: options.deleteSyncExchange === true,
      insideRemovalState: exchangeStatus[0].insideRemovalState,
      exchanges: Object.freeze(exchangeStatus),
    }),
    preserved: Object.freeze(preserved),
    blockers: Object.freeze(blockers),
  });
}

/** Executes one previously validated ready plan and removes the empty .atlas control root last. */
export function executeAtlasUninstall(plan) {
  if (!plan || plan.schema !== ATLAS_UNINSTALL_PLAN_SCHEMA || plan.status !== "ready") {
    throw new Error("Atlas uninstall execution requires a ready uninstall plan");
  }
  const root = path.resolve(plan.repositoryRoot);
  const atlasRoot = path.join(root, ".atlas");
  const receipt = plan.integrations.receipt;
  const agentInstructions = removeAtlasAgentInstructions({ root, receipt: receipt?.agentInstructions || null });
  const ignoreRules = removeAtlasIgnoreRules({ root, receipt: receipt?.ignoreRules || null });
  const removed = [];
  for (const relative of plan.removalPaths) {
    const absolute = ownedChild(root, relative, "removal path");
    if (!fs.existsSync(absolute)) continue;
    fs.rmSync(absolute, { recursive: true, force: true });
    removed.push(relative);
  }
  let atlasRootRemoved = false;
  if (fs.existsSync(atlasRoot) && !fs.lstatSync(atlasRoot).isSymbolicLink() && fs.readdirSync(atlasRoot).length === 0) {
    fs.rmdirSync(atlasRoot);
    atlasRootRemoved = true;
  }
  return Object.freeze({
    schema: ATLAS_UNINSTALL_RESULT_SCHEMA,
    status: "uninstalled",
    repositoryRoot: root,
    installationId: plan.installationId,
    removed: Object.freeze(removed),
    integrations: Object.freeze({ agentInstructions, ignoreRules }),
    atlasRootRemoved,
    preserved: plan.preserved,
  });
}
