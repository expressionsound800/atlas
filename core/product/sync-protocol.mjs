/*
 * Sync Protocol owns Atlas' source-neutral multi-machine exchange model.
 * Consumer repositories own record selection and Git remotes; this module
 * owns stable identities, immutable revisions, causal reconciliation, and
 * conflict visibility without deriving machine identity from the host.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const ATLAS_SYNC_REVISION_SCHEMA = "multihead-atlas.sync_revision.v1";
export const ATLAS_SYNC_BUNDLE_SCHEMA = "multihead-atlas.sync_bundle.v1";
export const ATLAS_SYNC_RECONCILIATION_SCHEMA = "multihead-atlas.sync_reconciliation.v1";
export const ATLAS_SYNC_CONFLICT_SCHEMA = "multihead-atlas.sync_conflict.v1";

export const ATLAS_SYNC_PROTOCOL_CONTRACT = Object.freeze({
  schema: "multihead-atlas.sync_protocol_contract.v1",
  contractVersion: 1,
  identity: "repository-namespace-logical-key-sha256",
  machineProvenance: "consumer-configured-opaque-machine-id",
  transport: "append-only-content-addressed-files-for-git",
  merge: "causal-head-reduction-with-explicit-divergent-conflicts",
  timestampAuthority: "informational-only",
  automaticWinnerPolicy: "none-for-divergent-heads",
});

const REPOSITORY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,127}$/u;
const MACHINE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,127}$/u;
const RECORD_ID_PATTERN = /^atlas-record-[a-f0-9]{64}$/u;
const REVISION_ID_PATTERN = /^atlas-revision-[a-f0-9]{64}$/u;
const TRANSPORT_ROOT = path.join("atlas-sync", "v1", "repositories");

/** Validates required sync identity text and enforces its protocol-specific length limit. */
function requiredText(value, field, maxLength = 4096) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`Atlas sync requires ${field}`);
  if (text.length > maxLength) throw new Error(`Atlas sync ${field} is too long`);
  return text;
}

/** Normalizes and validates the repository namespace shared by all exchanged revisions. */
function validatedRepositoryId(value) {
  const repositoryId = requiredText(value, "repositoryId", 128).toLowerCase();
  if (!REPOSITORY_ID_PATTERN.test(repositoryId)) {
    throw new Error("Atlas sync repositoryId must be a path-safe lowercase slug");
  }
  return repositoryId;
}

/** Normalizes and validates the consumer-configured opaque machine provenance identifier. */
function validatedMachineId(value) {
  const machineId = requiredText(value, "machineId", 128).toLowerCase();
  if (!MACHINE_ID_PATTERN.test(machineId)) {
    throw new Error("Atlas sync machineId must be a configured path-safe opaque id");
  }
  return machineId;
}

/** Rejects revision fields outside the exact protocol schema for one nested object. */
function rejectUnexpectedKeys(value, allowed, field) {
  for (const key of Object.keys(value || {})) {
    if (!allowed.has(key)) throw new Error(`Atlas sync ${field} contains unexpected field ${key}`);
  }
}

/**
 * normalizeJsonValue is the hashing boundary. It rejects values JSON would
 * silently discard and sorts object keys while preserving array order.
 */
function normalizeJsonValue(value, field = "value", seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Atlas sync ${field} contains a non-finite number`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") throw new Error(`Atlas sync ${field} must contain JSON values only`);
  if (seen.has(value)) throw new Error(`Atlas sync ${field} contains a cycle`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => normalizeJsonValue(item, `${field}[${index}]`, seen));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`Atlas sync ${field} must contain plain JSON objects only`);
    }
    const normalized = {};
    for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right))) {
      normalized[key] = normalizeJsonValue(value[key], `${field}.${key}`, seen);
    }
    return normalized;
  } finally {
    seen.delete(value);
  }
}

/** Serializes JSON-compatible data after recursive key ordering and value normalization. */
export function canonicalAtlasSyncJson(value) {
  return JSON.stringify(normalizeJsonValue(value));
}

/** Computes the cryptographic digest underlying record, revision, bundle, and conflict identities. */
function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Builds a typed content address from canonical protocol JSON and an identity prefix. */
function hashObject(prefix, value) {
  return `${prefix}${sha256(canonicalAtlasSyncJson(value))}`;
}

/** Validates the repository, namespace, and logical key that define one stable record. */
function validatedIdentity(options = {}) {
  const repositoryId = validatedRepositoryId(options.repositoryId);
  const namespace = requiredText(options.namespace, "namespace", 256);
  const logicalKey = requiredText(options.logicalKey, "logicalKey");
  return { repositoryId, namespace, logicalKey };
}

/** Derives the stable record identifier shared by revisions of one logical memory claim. */
export function createAtlasRecordId(options = {}) {
  const identity = validatedIdentity(options);
  return hashObject("atlas-record-", identity);
}

/** Validates, deduplicates, and sorts causal parent revision identifiers. */
function validatedParents(value = []) {
  if (!Array.isArray(value)) throw new Error("Atlas sync parents must be an array");
  const parents = value.map((parent) => requiredText(parent, "parent revision id", 80));
  for (const parent of parents) {
    if (!REVISION_ID_PATTERN.test(parent)) throw new Error(`Atlas sync parent revision id is invalid: ${parent}`);
  }
  if (new Set(parents).size !== parents.length) throw new Error("Atlas sync parents must be unique");
  return parents.sort((left, right) => left.localeCompare(right));
}

/** Validates the positive repository-wide sequence supplied by one configured machine. */
function validatedSequence(value) {
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("Atlas sync sequence must be a positive safe integer");
  }
  return sequence;
}

/** Validates an optional canonical UTC timestamp while keeping it informational only. */
function validatedAuthoredAt(value) {
  const authoredAt = String(value || "").trim();
  if (!authoredAt) return "";
  const parsed = new Date(authoredAt);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== authoredAt) {
    throw new Error("Atlas sync authoredAt must be an ISO-8601 UTC timestamp");
  }
  return authoredAt;
}

/** Builds canonical revision content after validating identity, operation, value, and provenance. */
function revisionCore(options = {}) {
  const identity = validatedIdentity(options);
  const recordId = createAtlasRecordId(identity);
  if (options.recordId && options.recordId !== recordId) {
    throw new Error("Atlas sync recordId does not match repositoryId, namespace, and logicalKey");
  }
  const operation = requiredText(options.operation || "upsert", "operation", 16);
  if (!new Set(["upsert", "delete"]).has(operation)) {
    throw new Error("Atlas sync operation must be upsert or delete");
  }
  const hasValue = Object.prototype.hasOwnProperty.call(options, "value");
  if (operation === "upsert" && !hasValue) throw new Error("Atlas sync upsert revision requires value");
  if (operation === "delete" && hasValue) throw new Error("Atlas sync delete revision must not contain value");
  const authoredAt = validatedAuthoredAt(options.authoredAt);
  const core = {
    schema: ATLAS_SYNC_REVISION_SCHEMA,
    repositoryId: identity.repositoryId,
    recordId,
    identity: {
      namespace: identity.namespace,
      logicalKey: identity.logicalKey,
    },
    parents: validatedParents(options.parents),
    operation,
    ...(operation === "upsert" ? { value: normalizeJsonValue(options.value) } : {}),
    provenance: {
      machineId: validatedMachineId(options.machineId),
      sequence: validatedSequence(options.sequence),
      ...(authoredAt ? { authoredAt } : {}),
    },
  };
  return normalizeJsonValue(core);
}

/** Creates an immutable content-addressed revision from normalized canonical core fields. */
export function createAtlasSyncRevision(options = {}) {
  const core = revisionCore(options);
  return Object.freeze({
    ...core,
    revisionId: hashObject("atlas-revision-", core),
  });
}

/** Validates complete revision structure and recomputes its record and content identities. */
export function validateAtlasSyncRevision(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Atlas sync revision must be an object");
  }
  rejectUnexpectedKeys(value, new Set([
    "schema", "repositoryId", "recordId", "revisionId", "identity",
    "parents", "operation", "value", "provenance",
  ]), "revision");
  if (value.schema !== ATLAS_SYNC_REVISION_SCHEMA) {
    throw new Error(`Atlas sync revision schema must be ${ATLAS_SYNC_REVISION_SCHEMA}`);
  }
  rejectUnexpectedKeys(value.identity, new Set(["namespace", "logicalKey"]), "revision identity");
  rejectUnexpectedKeys(value.provenance, new Set(["machineId", "sequence", "authoredAt"]), "revision provenance");
  const core = revisionCore({
    repositoryId: value.repositoryId,
    recordId: value.recordId,
    namespace: value.identity?.namespace,
    logicalKey: value.identity?.logicalKey,
    parents: value.parents,
    operation: value.operation,
    ...(Object.prototype.hasOwnProperty.call(value, "value") ? { value: value.value } : {}),
    machineId: value.provenance?.machineId,
    sequence: value.provenance?.sequence,
    authoredAt: value.provenance?.authoredAt,
  });
  const revisionId = requiredText(value.revisionId, "revisionId", 80);
  if (!REVISION_ID_PATTERN.test(revisionId) || revisionId !== hashObject("atlas-revision-", core)) {
    throw new Error("Atlas sync revisionId does not match canonical revision content");
  }
  if (core.parents.includes(revisionId)) throw new Error("Atlas sync revision cannot name itself as a parent");
  return Object.freeze({ ...core, revisionId });
}

/** Serializes one validated immutable revision as canonical newline-terminated JSON. */
export function serializeAtlasSyncRevision(value) {
  return `${canonicalAtlasSyncJson(validateAtlasSyncRevision(value))}\n`;
}

/** Parses serialized exchange JSON and returns a fully revalidated revision object. */
export function parseAtlasSyncRevision(text) {
  return validateAtlasSyncRevision(JSON.parse(requiredText(text, "revision JSON")));
}

/** Derives the repository- and record-scoped content-addressed transport path for a revision. */
export function atlasSyncRevisionRelativePath(value) {
  const revision = validateAtlasSyncRevision(value);
  return path.join(
    TRANSPORT_ROOT,
    revision.repositoryId,
    "records",
    revision.recordId,
    `${revision.revisionId}.json`,
  );
}

/** Resolves a transport child path without allowing exchange-root replacement or escape. */
function resolveInside(root, relativePath) {
  const resolvedRoot = path.resolve(requiredText(root, "exchangeRoot"));
  const resolved = path.resolve(resolvedRoot, relativePath);
  const relation = path.relative(resolvedRoot, resolved);
  if (!relation || relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error("Atlas sync revision path must stay inside exchangeRoot");
  }
  return resolved;
}

/**
 * Writes one immutable object. Repeating the same append is idempotent; a
 * different body at an existing content path is an integrity failure.
 */
export function writeAtlasSyncRevision(options = {}) {
  const revision = validateAtlasSyncRevision(options.revision);
  const relativePath = atlasSyncRevisionRelativePath(revision);
  const filePath = resolveInside(options.exchangeRoot, relativePath);
  const serialized = serializeAtlasSyncRevision(revision);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(filePath, serialized, { encoding: "utf8", flag: "wx" });
    return { status: "written", filePath, relativePath, revision };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (fs.readFileSync(filePath, "utf8") !== serialized) {
      throw new Error(`Atlas sync immutable revision path contains different content: ${relativePath}`);
    }
    return { status: "existing", filePath, relativePath, revision };
  }
}

/** Reads and validates every immutable revision beneath one repository exchange namespace. */
export function readAtlasSyncRevisions(options = {}) {
  const repositoryId = validatedRepositoryId(options.repositoryId);
  const repositoryRoot = resolveInside(options.exchangeRoot, path.join(TRANSPORT_ROOT, repositoryId, "records"));
  if (!fs.existsSync(repositoryRoot)) return [];
  const revisions = [];
  for (const recordEntry of fs.readdirSync(repositoryRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!recordEntry.isDirectory() || !RECORD_ID_PATTERN.test(recordEntry.name)) {
      throw new Error(`Atlas sync exchange contains invalid record entry: ${recordEntry.name}`);
    }
    const recordRoot = path.join(repositoryRoot, recordEntry.name);
    for (const revisionEntry of fs.readdirSync(recordRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!revisionEntry.isFile() || !/^atlas-revision-[a-f0-9]{64}\.json$/u.test(revisionEntry.name)) {
        throw new Error(`Atlas sync exchange contains invalid revision entry: ${revisionEntry.name}`);
      }
      const filePath = path.join(recordRoot, revisionEntry.name);
      if (fs.lstatSync(filePath).isSymbolicLink()) throw new Error("Atlas sync exchange revision must not be a symbolic link");
      const revision = parseAtlasSyncRevision(fs.readFileSync(filePath, "utf8"));
      if (revision.repositoryId !== repositoryId || revision.recordId !== recordEntry.name
        || `${revision.revisionId}.json` !== revisionEntry.name) {
        throw new Error(`Atlas sync revision content does not match its immutable path: ${filePath}`);
      }
      revisions.push(revision);
    }
  }
  return revisions.sort((left, right) => left.revisionId.localeCompare(right.revisionId));
}

/** Builds a deterministic transport bundle from validated revisions of one repository. */
export function createAtlasSyncBundle(options = {}) {
  const repositoryId = validatedRepositoryId(options.repositoryId);
  if (!Array.isArray(options.revisions)) throw new Error("Atlas sync bundle requires revisions array");
  const revisions = options.revisions.map(validateAtlasSyncRevision)
    .sort((left, right) => left.revisionId.localeCompare(right.revisionId));
  if (revisions.some((revision) => revision.repositoryId !== repositoryId)) {
    throw new Error("Atlas sync bundle revisions must belong to repositoryId");
  }
  const core = {
    schema: ATLAS_SYNC_BUNDLE_SCHEMA,
    repositoryId,
    revisionIds: revisions.map((revision) => revision.revisionId),
    revisions,
  };
  return Object.freeze({ ...core, bundleId: hashObject("atlas-bundle-", core) });
}

/** Builds a stable content-addressed conflict record from sorted causal evidence identifiers. */
function conflict({ repositoryId, recordId = "", kind, revisionIds = [], relatedIds = [], detail }) {
  const identity = {
    repositoryId,
    recordId,
    kind,
    revisionIds: [...new Set(revisionIds)].sort((left, right) => left.localeCompare(right)),
    relatedIds: [...new Set(relatedIds)].sort((left, right) => left.localeCompare(right)),
  };
  return {
    schema: ATLAS_SYNC_CONFLICT_SCHEMA,
    conflictId: hashObject("atlas-conflict-", identity),
    ...identity,
    detail,
  };
}

/** Serializes only active record state so causally distinct equivalent heads can be recognized. */
function revisionStateFingerprint(revision) {
  return canonicalAtlasSyncJson({
    operation: revision.operation,
    ...(revision.operation === "upsert" ? { value: revision.value } : {}),
  });
}

/** Detects a causal cycle among revisions belonging to one stable record. */
function recordCycle(recordRevisions) {
  const byId = new Map(recordRevisions.map((revision) => [revision.revisionId, revision]));
  const visiting = new Set();
  const visited = new Set();
  /** Traverses parent links with separate visiting and completed sets for cycle detection. */
  const visit = (revisionId) => {
    if (visiting.has(revisionId)) return true;
    if (visited.has(revisionId)) return false;
    visiting.add(revisionId);
    for (const parent of byId.get(revisionId)?.parents || []) {
      if (byId.has(parent) && visit(parent)) return true;
    }
    visiting.delete(revisionId);
    visited.add(revisionId);
    return false;
  };
  return [...byId.keys()].some(visit);
}

/**
 * Reconciles revisions through a pure causal reduction. It never orders divergent heads
 * by clock or machine id and never rewrites durable consumer memory.
 */
export function reconcileAtlasSyncRevisions(options = {}) {
  const repositoryId = validatedRepositoryId(options.repositoryId);
  if (!Array.isArray(options.revisions)) throw new Error("Atlas sync reconciliation requires revisions array");
  const revisionById = new Map();
  for (const raw of options.revisions) {
    const revision = validateAtlasSyncRevision(raw);
    if (revision.repositoryId !== repositoryId) {
      throw new Error(`Atlas sync revision ${revision.revisionId} belongs to another repository`);
    }
    const existing = revisionById.get(revision.revisionId);
    if (existing && canonicalAtlasSyncJson(existing) !== canonicalAtlasSyncJson(revision)) {
      throw new Error(`Atlas sync duplicate revision id has different content: ${revision.revisionId}`);
    }
    revisionById.set(revision.revisionId, revision);
  }
  const revisions = [...revisionById.values()].sort((left, right) => left.revisionId.localeCompare(right.revisionId));
  const conflicts = [];

  // A machine sequence is repository-wide. Reuse for different revisions is
  // visible because it usually means cloned or reset machine provenance.
  const provenanceSlots = new Map();
  for (const revision of revisions) {
    const slot = `${revision.provenance.machineId}:${revision.provenance.sequence}`;
    const ids = provenanceSlots.get(slot) || [];
    ids.push(revision.revisionId);
    provenanceSlots.set(slot, ids);
  }
  for (const [slot, ids] of [...provenanceSlots.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (new Set(ids).size > 1) {
      conflicts.push(conflict({
        repositoryId,
        kind: "machine-sequence-collision",
        revisionIds: ids,
        relatedIds: [slot],
        detail: "One configured machine id reused a repository-wide sequence for different revisions.",
      }));
    }
  }

  const byRecord = new Map();
  for (const revision of revisions) {
    const rows = byRecord.get(revision.recordId) || [];
    rows.push(revision);
    byRecord.set(revision.recordId, rows);
  }
  const records = [];
  for (const [recordId, recordRevisions] of [...byRecord.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const ids = new Set(recordRevisions.map((revision) => revision.revisionId));
    const referencedParents = new Set();
    const missingParents = [];
    const crossRecordParents = [];
    for (const revision of recordRevisions) {
      for (const parent of revision.parents) {
        if (ids.has(parent)) referencedParents.add(parent);
        else if (!revisionById.has(parent)) missingParents.push(parent);
        else crossRecordParents.push(parent);
      }
    }
    const heads = recordRevisions.filter((revision) => !referencedParents.has(revision.revisionId))
      .sort((left, right) => left.revisionId.localeCompare(right.revisionId));
    const recordConflicts = [];
    if (missingParents.length) {
      recordConflicts.push(conflict({
        repositoryId, recordId, kind: "missing-parent", revisionIds: heads.map((head) => head.revisionId),
        relatedIds: missingParents,
        detail: "At least one revision refers to a causal parent that is absent from the exchange.",
      }));
    }
    if (crossRecordParents.length) {
      recordConflicts.push(conflict({
        repositoryId, recordId, kind: "cross-record-parent", revisionIds: heads.map((head) => head.revisionId),
        relatedIds: crossRecordParents,
        detail: "At least one causal parent belongs to a different stable record.",
      }));
    }
    if (recordCycle(recordRevisions)) {
      recordConflicts.push(conflict({
        repositoryId, recordId, kind: "causal-cycle", revisionIds: recordRevisions.map((revision) => revision.revisionId),
        detail: "The record revision graph contains a causal cycle.",
      }));
    }

    const stateFingerprints = new Set(heads.map(revisionStateFingerprint));
    const observations = [];
    let resolvedRevision = heads.length === 1 ? heads[0] : null;
    if (heads.length > 1 && stateFingerprints.size === 1) {
      resolvedRevision = heads[0];
      observations.push({
        kind: "semantic-duplicate-heads",
        revisionIds: heads.map((head) => head.revisionId),
        canonicalRevisionId: resolvedRevision.revisionId,
      });
    } else if (heads.length > 1) {
      const operations = new Set(heads.map((head) => head.operation));
      recordConflicts.push(conflict({
        repositoryId,
        recordId,
        kind: operations.size > 1 ? "delete-update" : "divergent-active-claims",
        revisionIds: heads.map((head) => head.revisionId),
        detail: operations.size > 1
          ? "Concurrent delete and update heads require an explicit merge revision."
          : "Concurrent heads contain different active values and require an explicit merge revision.",
      }));
    }
    conflicts.push(...recordConflicts);
    const identity = recordRevisions[0].identity;
    records.push({
      recordId,
      identity,
      status: recordConflicts.length ? "conflict" : (observations.length ? "equivalent-heads" : "resolved"),
      revisionCount: recordRevisions.length,
      headRevisionIds: heads.map((head) => head.revisionId),
      machineIds: [...new Set(recordRevisions.map((revision) => revision.provenance.machineId))].sort((left, right) => left.localeCompare(right)),
      observations,
      resolution: resolvedRevision ? {
        revisionId: resolvedRevision.revisionId,
        operation: resolvedRevision.operation,
        ...(resolvedRevision.operation === "upsert" ? { value: resolvedRevision.value } : {}),
      } : null,
    });
  }

  conflicts.sort((left, right) => left.conflictId.localeCompare(right.conflictId));
  const status = conflicts.length ? "conflict" : "pass";
  return {
    schema: ATLAS_SYNC_RECONCILIATION_SCHEMA,
    contract: ATLAS_SYNC_PROTOCOL_CONTRACT,
    repositoryId,
    status,
    summary: {
      revisions: revisions.length,
      records: records.length,
      resolved: records.filter((record) => record.status === "resolved").length,
      equivalentHeads: records.filter((record) => record.status === "equivalent-heads").length,
      conflicts: conflicts.length,
      machines: new Set(revisions.map((revision) => revision.provenance.machineId)).size,
    },
    records,
    conflicts,
  };
}
