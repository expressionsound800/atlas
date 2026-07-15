/*
 * Generation Provider Contract owns the source-neutral handshake between an
 * Atlas Instance and either its current interactive agent or a configured
 * command adapter. It builds deterministic requests, validates provider
 * results against current source bytes, and writes accepted derived artifacts
 * only to ignored instance state. It does not select repository sources,
 * discover an agent host, store credentials, or rewrite durable knowledge.
 */

import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const ATLAS_GENERATION_REQUEST_SCHEMA = "multihead-atlas.generation_request.v1";
export const ATLAS_GENERATION_RESULT_SCHEMA = "multihead-atlas.generation_result.v1";
export const ATLAS_GENERATION_APPLIED_SCHEMA = "multihead-atlas.generation_applied.v1";
export const ATLAS_REPOSITORY_SYSTEM_MODEL_SCHEMA = "multihead-atlas.repository_system_model.v1";
export const ATLAS_GENERATION_MODES = Object.freeze(["current-agent", "command"]);
export const ATLAS_GENERATION_DATA_BOUNDARIES = Object.freeze(["interactive", "local", "remote"]);
export const ATLAS_GENERATION_TASK_KINDS = Object.freeze([
  "source-summary",
  "workspace-entry-summary",
  "room-specification",
  "route-explanation",
  "repository-system-model",
]);

const REMOTE_APPROVAL_ENV = "ATLAS_GENERATION_EXTERNAL_CONTEXT_APPROVED";
const REMOTE_APPROVAL_VALUE = "send-atlas-generation-context-to-configured-provider";
const MAX_SOURCE_COUNT = 8;
const MAX_ORIENTATION_SOURCE_COUNT = 24;
const MAX_SOURCE_BYTES = 262144;
const MAX_RESULT_TEXT = 12000;
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const ROOM_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,191}$/u;

/** Returns whether a value is a plain JSON object accepted by the wire contract. */
function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Rejects every field outside one explicit generation wire-object allowlist. */
function rejectUnexpectedKeys(value, allowed, field) {
  for (const key of Object.keys(value || {})) {
    if (!allowed.has(key)) throw new Error(`Atlas generation ${field} contains unexpected field ${key}`);
  }
}

/** Validates one required bounded text field without normalizing its internal content. */
function requiredText(value, field, maximum = MAX_RESULT_TEXT) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`Atlas generation requires ${field}`);
  if (text.length > maximum) throw new Error(`Atlas generation ${field} exceeds ${maximum} characters`);
  return text;
}

/** Validates one optional bounded text field while preserving an empty value. */
function optionalText(value, field, maximum = MAX_RESULT_TEXT) {
  const text = String(value ?? "").trim();
  if (text.length > maximum) throw new Error(`Atlas generation ${field} exceeds ${maximum} characters`);
  return text;
}

/** Validates a stable lowercase provider identifier used by configuration and results. */
function providerId(value, field = "provider id") {
  const id = requiredText(value, field, 128).toLowerCase();
  if (!PROVIDER_ID_PATTERN.test(id)) throw new Error(`Atlas generation ${field} must be a path-safe lowercase slug`);
  return id;
}

/** Validates a generated room identifier without accepting filesystem separators. */
function roomId(value) {
  const id = requiredText(value, "artifact.room.id", 192).toLowerCase();
  if (!ROOM_ID_PATTERN.test(id)) throw new Error("Atlas generation artifact.room.id is invalid");
  return id;
}

/** Validates one confidence score used to expose model uncertainty without accepting coercion. */
function confidence(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Atlas generation ${field} must be a number from 0 to 1`);
  }
  return value;
}

/** Normalizes a consumer-relative source path and rejects absolute or parent traversal. */
function relativePath(value, field) {
  const normalized = path.normalize(requiredText(value, field, 4096)).replace(/\\/gu, "/").replace(/^\.\//u, "");
  if (path.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Atlas generation ${field} must stay inside the consumer repository`);
  }
  return normalized;
}

/** Resolves a required child path without permitting aliases of or escapes from the repository root. */
function pathInside(root, relative, field) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  const relation = path.relative(resolvedRoot, resolved);
  if (!relation || relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error(`Atlas generation ${field} must name a child of the consumer repository`);
  }
  return resolved;
}

/** Orders JSON object keys recursively so request and artifact digests remain runtime-independent. */
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

/** Serializes one JSON value through the generation contract's canonical key order. */
export function canonicalAtlasGenerationJson(value) {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}

/** Computes the lowercase SHA-256 identity used for requests, sources, and state targets. */
function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Validates one request source containing an admitted relative path, digest, and bounded text. */
function generationSource(value, index) {
  if (!isObject(value)) throw new Error(`Atlas generation sources[${index}] must be an object`);
  rejectUnexpectedKeys(value, new Set(["path", "digest", "content"]), `sources[${index}]`);
  const source = {
    path: relativePath(value.path, `sources[${index}].path`),
    digest: requiredText(value.digest, `sources[${index}].digest`, 64).toLowerCase(),
    content: String(value.content ?? ""),
  };
  if (!/^[a-f0-9]{64}$/u.test(source.digest)) throw new Error(`Atlas generation sources[${index}].digest must be SHA-256`);
  if (Buffer.byteLength(source.content, "utf8") > MAX_SOURCE_BYTES) {
    throw new Error(`Atlas generation sources[${index}].content exceeds the request byte limit`);
  }
  if (sha256(source.content) !== source.digest) throw new Error(`Atlas generation sources[${index}] digest does not match content`);
  return Object.freeze(source);
}

/** Validates the full admitted-inventory identity bound to a repository-learning request. */
function generationRepositoryInventory(value, required) {
  if (!required && value === undefined) return null;
  if (!isObject(value)) throw new Error("Atlas generation request.repositoryInventory must be an object");
  rejectUnexpectedKeys(value, new Set(["algorithm", "digest", "sourceCount"]), "request.repositoryInventory");
  const inventory = {
    algorithm: requiredText(value.algorithm, "request.repositoryInventory.algorithm", 64),
    digest: requiredText(value.digest, "request.repositoryInventory.digest", 64).toLowerCase(),
    sourceCount: Number(value.sourceCount),
  };
  if (inventory.algorithm !== "sha256-path-digest-v1" || !/^[a-f0-9]{64}$/u.test(inventory.digest)) {
    throw new Error("Atlas generation request.repositoryInventory identity is invalid");
  }
  if (!Number.isSafeInteger(inventory.sourceCount) || inventory.sourceCount < 1 || inventory.sourceCount > 10000) {
    throw new Error("Atlas generation request.repositoryInventory.sourceCount is invalid");
  }
  return Object.freeze(inventory);
}

/** Validates and freezes the selected generation mode, adapter identity, and data boundary. */
export function validateAtlasGenerationConfig(value = {}) {
  if (!isObject(value)) throw new Error("Atlas generation configuration must be an object");
  rejectUnexpectedKeys(value, new Set(["mode", "providerId", "adapterCommand", "dataBoundary"]), "configuration");
  const mode = requiredText(value.mode || "current-agent", "configuration.mode", 32);
  if (!ATLAS_GENERATION_MODES.includes(mode)) {
    throw new Error(`Atlas generation configuration.mode must be one of: ${ATLAS_GENERATION_MODES.join(", ")}`);
  }
  const adapterCommand = optionalText(value.adapterCommand, "configuration.adapterCommand", 4096);
  const dataBoundary = requiredText(
    value.dataBoundary || (mode === "current-agent" ? "interactive" : "local"),
    "configuration.dataBoundary",
    32,
  );
  if (!ATLAS_GENERATION_DATA_BOUNDARIES.includes(dataBoundary)) {
    throw new Error(`Atlas generation configuration.dataBoundary must be one of: ${ATLAS_GENERATION_DATA_BOUNDARIES.join(", ")}`);
  }
  if (mode === "current-agent" && (adapterCommand || dataBoundary !== "interactive")) {
    throw new Error("Atlas current-agent generation requires an empty adapterCommand and interactive dataBoundary");
  }
  if (mode === "command" && (!adapterCommand || dataBoundary === "interactive")) {
    throw new Error("Atlas command generation requires adapterCommand and a local or remote dataBoundary");
  }
  return Object.freeze({
    mode,
    providerId: providerId(value.providerId || (mode === "current-agent" ? "current-agent" : "command-adapter"), "configuration.providerId"),
    adapterCommand: mode === "command" ? relativePath(adapterCommand, "configuration.adapterCommand") : "",
    dataBoundary,
  });
}

/** Returns the conservative generation configuration installed into a new Atlas Instance. */
export function defaultAtlasGenerationConfig() {
  return validateAtlasGenerationConfig({
    mode: "current-agent",
    providerId: "current-agent",
    adapterCommand: "",
    dataBoundary: "interactive",
  });
}

/** Validates one source-bounded deterministic request and recomputes its identity. */
export function validateAtlasGenerationRequest(value) {
  if (!isObject(value)) throw new Error("Atlas generation request must be an object");
  rejectUnexpectedKeys(value, new Set(["schema", "requestDigest", "repositoryId", "task", "sources", "repositoryInventory", "output", "privacy"]), "request");
  if (value.schema !== ATLAS_GENERATION_REQUEST_SCHEMA) {
    throw new Error(`Atlas generation request schema must be ${ATLAS_GENERATION_REQUEST_SCHEMA}`);
  }
  if (!isObject(value.task)) throw new Error("Atlas generation request requires task");
  rejectUnexpectedKeys(value.task, new Set(["kind", "instruction"]), "request.task");
  const kind = requiredText(value.task.kind, "request.task.kind", 64);
  if (!ATLAS_GENERATION_TASK_KINDS.includes(kind)) {
    throw new Error(`Atlas generation request.task.kind must be one of: ${ATLAS_GENERATION_TASK_KINDS.join(", ")}`);
  }
  const sourceLimit = kind === "repository-system-model" ? MAX_ORIENTATION_SOURCE_COUNT : MAX_SOURCE_COUNT;
  if (!Array.isArray(value.sources) || !value.sources.length || value.sources.length > sourceLimit) {
    throw new Error(`Atlas generation request requires 1-${sourceLimit} sources for ${kind}`);
  }
  const sources = value.sources.map(generationSource).sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(sources.map((source) => source.path)).size !== sources.length) {
    throw new Error("Atlas generation request source paths must be unique");
  }
  const sourceBytes = sources.reduce((total, source) => total + Buffer.byteLength(source.content, "utf8"), 0);
  if (sourceBytes > MAX_SOURCE_BYTES) throw new Error(`Atlas generation request sources exceed ${MAX_SOURCE_BYTES} bytes`);
  if (kind === "source-summary" && sources.length !== 1) {
    throw new Error("Atlas source-summary generation requires exactly one source");
  }
  const repositoryInventory = generationRepositoryInventory(value.repositoryInventory, kind === "repository-system-model");
  if (kind !== "repository-system-model" && repositoryInventory) {
    throw new Error("Atlas generation request.repositoryInventory is only valid for repository-system-model");
  }
  const body = {
    schema: ATLAS_GENERATION_REQUEST_SCHEMA,
    repositoryId: providerId(value.repositoryId, "request.repositoryId"),
    task: {
      kind,
      instruction: optionalText(value.task.instruction, "request.task.instruction", 4000),
    },
    sources,
    ...(repositoryInventory ? { repositoryInventory } : {}),
    output: {
      schema: requiredText(value.output?.schema, "request.output.schema", 128),
    },
    privacy: {
      containsConsumerSource: value.privacy?.containsConsumerSource === true,
      remoteProcessing: requiredText(value.privacy?.remoteProcessing, "request.privacy.remoteProcessing", 64),
    },
  };
  if (body.output.schema !== ATLAS_GENERATION_RESULT_SCHEMA) throw new Error("Atlas generation request output schema is invalid");
  if (!body.privacy.containsConsumerSource || body.privacy.remoteProcessing !== "requires-explicit-consumer-approval") {
    throw new Error("Atlas generation request privacy contract is invalid");
  }
  const requestDigest = sha256(canonicalAtlasGenerationJson(body));
  if (requiredText(value.requestDigest, "request.requestDigest", 64).toLowerCase() !== requestDigest) {
    throw new Error("Atlas generation request digest does not match its canonical payload");
  }
  return Object.freeze({ ...body, requestDigest });
}

/** Builds one deterministic request from already-admitted source rows selected by the Atlas Instance. */
export function buildAtlasGenerationRequest(options = {}) {
  const sources = (options.sources || []).map((source) => ({
    path: source.path,
    digest: source.digest || sha256(String(source.content ?? source.text ?? "")),
    content: String(source.content ?? source.text ?? ""),
  })).sort((left, right) => String(left.path).localeCompare(String(right.path)));
  const body = {
    schema: ATLAS_GENERATION_REQUEST_SCHEMA,
    repositoryId: options.repositoryId,
    task: { kind: options.kind, instruction: String(options.instruction || "") },
    sources,
    ...(options.repositoryInventory ? { repositoryInventory: options.repositoryInventory } : {}),
    output: { schema: ATLAS_GENERATION_RESULT_SCHEMA },
    privacy: {
      containsConsumerSource: true,
      remoteProcessing: "requires-explicit-consumer-approval",
    },
  };
  return validateAtlasGenerationRequest({
    ...body,
    requestDigest: sha256(canonicalAtlasGenerationJson(body)),
  });
}

/** Validates the result artifact's exact source provenance against its request. */
function resultSources(value, request) {
  if (!Array.isArray(value) || value.length !== request.sources.length) {
    throw new Error("Atlas generation artifact.sources must exactly cover request sources");
  }
  const sources = value.map((source, index) => {
    if (!isObject(source)) throw new Error(`Atlas generation artifact.sources[${index}] must be an object`);
    rejectUnexpectedKeys(source, new Set(["path", "digest"]), `artifact.sources[${index}]`);
    return {
      path: relativePath(source.path, `artifact.sources[${index}].path`),
      digest: requiredText(source.digest, `artifact.sources[${index}].digest`, 64).toLowerCase(),
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const expected = request.sources.map(({ path: sourcePath, digest }) => ({ path: sourcePath, digest }));
  if (canonicalAtlasGenerationJson(sources) !== canonicalAtlasGenerationJson(expected)) {
    throw new Error("Atlas generation artifact source provenance does not match the request");
  }
  return Object.freeze(sources.map(Object.freeze));
}

/** Validates the room-specification shape shared by every result for strict adapter schemas. */
function resultRoom(value, required) {
  if (!isObject(value)) throw new Error("Atlas generation artifact.room must be an object");
  rejectUnexpectedKeys(value, new Set(["id", "label", "viewpoint", "facets", "answers"]), "artifact.room");
  const result = {
    id: optionalText(value.id, "artifact.room.id", 192),
    label: optionalText(value.label, "artifact.room.label", 160),
    viewpoint: optionalText(value.viewpoint, "artifact.room.viewpoint", 1000),
    facets: Array.isArray(value.facets) ? value.facets.map((item, index) => requiredText(item, `artifact.room.facets[${index}]`, 80)) : [],
    answers: Array.isArray(value.answers) ? value.answers.map((item, index) => requiredText(item, `artifact.room.answers[${index}]`, 240)) : [],
  };
  if (required) {
    result.id = roomId(result.id);
    result.label = requiredText(result.label, "artifact.room.label", 160);
    result.viewpoint = requiredText(result.viewpoint, "artifact.room.viewpoint", 1000);
    if (!result.facets.length || !result.answers.length) {
      throw new Error("Atlas room-specification requires facets and answers");
    }
  }
  return Object.freeze({ ...result, facets: Object.freeze(result.facets), answers: Object.freeze(result.answers) });
}

/**
 * Validates one evidence citation against the exact orientation packet. Model
 * claims cannot cite repository files that Atlas did not place in the bounded
 * request, and they cannot alter a selected source digest.
 */
function modelEvidence(value, request, field) {
  if (!Array.isArray(value) || !value.length || value.length > 16) {
    throw new Error(`Atlas generation ${field} requires 1-16 evidence citations`);
  }
  const requested = new Map(request.sources.map((source) => [source.path, source.digest]));
  const citations = value.map((citation, index) => {
    if (!isObject(citation)) throw new Error(`Atlas generation ${field}[${index}] must be an object`);
    rejectUnexpectedKeys(citation, new Set(["path", "digest"]), `${field}[${index}]`);
    const sourcePath = relativePath(citation.path, `${field}[${index}].path`);
    const digest = requiredText(citation.digest, `${field}[${index}].digest`, 64).toLowerCase();
    if (requested.get(sourcePath) !== digest) {
      throw new Error(`Atlas generation ${field}[${index}] must cite an exact request source path and digest`);
    }
    return Object.freeze({ path: sourcePath, digest });
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(citations.map((citation) => citation.path)).size !== citations.length) {
    throw new Error(`Atlas generation ${field} source paths must be unique`);
  }
  return Object.freeze(citations);
}

/** Normalizes a semantic label for exact file-stem pseudo-room rejection. */
function semanticLabelKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}

/** Validates one bounded list of unique non-empty strings. */
function modelTextList(value, field, limits = {}) {
  const maximumItems = Number(limits.maximumItems || 12);
  const maximumText = Number(limits.maximumText || 240);
  if (!Array.isArray(value) || value.length < Number(limits.minimumItems || 0) || value.length > maximumItems) {
    throw new Error(`Atlas generation ${field} has an invalid item count`);
  }
  const rows = value.map((item, index) => requiredText(item, `${field}[${index}]`, maximumText));
  if (new Set(rows).size !== rows.length) throw new Error(`Atlas generation ${field} values must be unique`);
  return Object.freeze(rows);
}

/**
 * Validates the learned repository model as a claim graph rather than a list
 * of filenames. Every purpose, component, relationship, flow, and unknown is
 * source-cited; endpoints are checked after component identity is frozen.
 */
function resultRepositorySystemModel(value, request) {
  if (!isObject(value)) throw new Error("Atlas generation artifact.systemModel must be an object");
  rejectUnexpectedKeys(value, new Set(["schema", "repository", "components", "relationships", "flows", "unknowns"]), "artifact.systemModel");
  if (value.schema !== ATLAS_REPOSITORY_SYSTEM_MODEL_SCHEMA) {
    throw new Error(`Atlas generation artifact.systemModel.schema must be ${ATLAS_REPOSITORY_SYSTEM_MODEL_SCHEMA}`);
  }
  if (!isObject(value.repository)) throw new Error("Atlas generation artifact.systemModel.repository must be an object");
  rejectUnexpectedKeys(value.repository, new Set(["purpose", "nonGoals", "evidence", "confidence"]), "artifact.systemModel.repository");
  const repository = Object.freeze({
    purpose: requiredText(value.repository.purpose, "artifact.systemModel.repository.purpose", 2000),
    nonGoals: modelTextList(value.repository.nonGoals || [], "artifact.systemModel.repository.nonGoals", { maximumItems: 12, maximumText: 400 }),
    evidence: modelEvidence(value.repository.evidence, request, "artifact.systemModel.repository.evidence"),
    confidence: confidence(value.repository.confidence, "artifact.systemModel.repository.confidence"),
  });
  if (!Array.isArray(value.components) || !value.components.length || value.components.length > 48) {
    throw new Error("Atlas generation artifact.systemModel.components requires 1-48 semantic components");
  }
  const sourceStemKeys = new Set(request.sources.map((source) => semanticLabelKey(path.posix.basename(source.path, path.posix.extname(source.path)))));
  const components = value.components.map((component, index) => {
    const field = `artifact.systemModel.components[${index}]`;
    if (!isObject(component)) throw new Error(`Atlas generation ${field} must be an object`);
    rejectUnexpectedKeys(component, new Set(["id", "label", "responsibility", "viewpoint", "region", "facets", "answers", "evidence", "confidence"]), field);
    const id = roomId(component.id);
    const label = requiredText(component.label, `${field}.label`, 160);
    const citations = modelEvidence(component.evidence, request, `${field}.evidence`);
    if (citations.length === 1 && (sourceStemKeys.has(semanticLabelKey(label)) || sourceStemKeys.has(semanticLabelKey(id)))) {
      throw new Error(`Atlas generation ${field} repeats its sole evidence filename instead of naming a semantic responsibility`);
    }
    return Object.freeze({
      id,
      label,
      responsibility: requiredText(component.responsibility, `${field}.responsibility`, 2000),
      viewpoint: requiredText(component.viewpoint, `${field}.viewpoint`, 1000),
      region: optionalText(component.region, `${field}.region`, 160),
      facets: modelTextList(component.facets, `${field}.facets`, { minimumItems: 1, maximumItems: 12, maximumText: 80 }),
      answers: modelTextList(component.answers, `${field}.answers`, { minimumItems: 1, maximumItems: 12, maximumText: 240 }),
      evidence: citations,
      confidence: confidence(component.confidence, `${field}.confidence`),
    });
  });
  const componentIds = new Set(components.map((component) => component.id));
  if (componentIds.size !== components.length) throw new Error("Atlas generation semantic component ids must be unique");
  if (componentIds.has(request.repositoryId)) throw new Error("Atlas generation semantic component cannot replace the repository authority room");
  if (!Array.isArray(value.relationships) || value.relationships.length > 128) {
    throw new Error("Atlas generation artifact.systemModel.relationships must contain at most 128 rows");
  }
  const relationships = value.relationships.map((relationship, index) => {
    const field = `artifact.systemModel.relationships[${index}]`;
    if (!isObject(relationship)) throw new Error(`Atlas generation ${field} must be an object`);
    rejectUnexpectedKeys(relationship, new Set(["id", "from", "to", "kind", "label", "description", "evidence", "confidence"]), field);
    const from = roomId(relationship.from);
    const to = roomId(relationship.to);
    if (!componentIds.has(from) || !componentIds.has(to) || from === to) {
      throw new Error(`Atlas generation ${field} must name two distinct semantic component endpoints`);
    }
    return Object.freeze({
      id: roomId(relationship.id),
      from,
      to,
      kind: providerId(relationship.kind, `${field}.kind`),
      label: requiredText(relationship.label, `${field}.label`, 160),
      description: requiredText(relationship.description, `${field}.description`, 1000),
      evidence: modelEvidence(relationship.evidence, request, `${field}.evidence`),
      confidence: confidence(relationship.confidence, `${field}.confidence`),
    });
  });
  if (new Set(relationships.map((relationship) => relationship.id)).size !== relationships.length) {
    throw new Error("Atlas generation semantic relationship ids must be unique");
  }
  if (!Array.isArray(value.flows) || value.flows.length > 32) {
    throw new Error("Atlas generation artifact.systemModel.flows must contain at most 32 rows");
  }
  const flows = value.flows.map((flow, index) => {
    const field = `artifact.systemModel.flows[${index}]`;
    if (!isObject(flow)) throw new Error(`Atlas generation ${field} must be an object`);
    rejectUnexpectedKeys(flow, new Set(["id", "label", "description", "steps", "evidence", "confidence"]), field);
    if (!Array.isArray(flow.steps) || flow.steps.length < 2 || flow.steps.length > 16) {
      throw new Error(`Atlas generation ${field}.steps requires 2-16 directed steps`);
    }
    const steps = flow.steps.map((step, stepIndex) => {
      if (!isObject(step)) throw new Error(`Atlas generation ${field}.steps[${stepIndex}] must be an object`);
      rejectUnexpectedKeys(step, new Set(["componentId", "action"]), `${field}.steps[${stepIndex}]`);
      const componentId = roomId(step.componentId);
      if (!componentIds.has(componentId)) throw new Error(`Atlas generation ${field}.steps[${stepIndex}] names an unknown component`);
      return Object.freeze({ componentId, action: requiredText(step.action, `${field}.steps[${stepIndex}].action`, 240) });
    });
    if (steps.some((step, stepIndex) => stepIndex > 0 && step.componentId === steps[stepIndex - 1].componentId)) {
      throw new Error(`Atlas generation ${field}.steps cannot repeat one component consecutively`);
    }
    return Object.freeze({
      id: roomId(flow.id),
      label: requiredText(flow.label, `${field}.label`, 160),
      description: requiredText(flow.description, `${field}.description`, 1000),
      steps: Object.freeze(steps),
      evidence: modelEvidence(flow.evidence, request, `${field}.evidence`),
      confidence: confidence(flow.confidence, `${field}.confidence`),
    });
  });
  if (new Set(flows.map((flow) => flow.id)).size !== flows.length) throw new Error("Atlas generation semantic flow ids must be unique");
  if (!Array.isArray(value.unknowns) || value.unknowns.length > 32) {
    throw new Error("Atlas generation artifact.systemModel.unknowns must contain at most 32 rows");
  }
  const unknowns = value.unknowns.map((unknown, index) => {
    const field = `artifact.systemModel.unknowns[${index}]`;
    if (!isObject(unknown)) throw new Error(`Atlas generation ${field} must be an object`);
    rejectUnexpectedKeys(unknown, new Set(["id", "description", "evidence", "confidence"]), field);
    return Object.freeze({
      id: roomId(unknown.id),
      description: requiredText(unknown.description, `${field}.description`, 1000),
      evidence: modelEvidence(unknown.evidence, request, `${field}.evidence`),
      confidence: confidence(unknown.confidence, `${field}.confidence`),
    });
  });
  if (new Set(unknowns.map((unknown) => unknown.id)).size !== unknowns.length) {
    throw new Error("Atlas generation semantic unknown ids must be unique");
  }
  return Object.freeze({
    schema: ATLAS_REPOSITORY_SYSTEM_MODEL_SCHEMA,
    repository,
    components: Object.freeze(components),
    relationships: Object.freeze(relationships),
    flows: Object.freeze(flows),
    unknowns: Object.freeze(unknowns),
  });
}

/** Validates one provider result against the request and selected execution mode. */
export function validateAtlasGenerationResult(options = {}) {
  const request = validateAtlasGenerationRequest(options.request);
  const value = options.result;
  if (!isObject(value)) throw new Error("Atlas generation result must be an object");
  rejectUnexpectedKeys(value, new Set(["schema", "requestDigest", "provider", "artifact"]), "result");
  if (value.schema !== ATLAS_GENERATION_RESULT_SCHEMA) {
    throw new Error(`Atlas generation result schema must be ${ATLAS_GENERATION_RESULT_SCHEMA}`);
  }
  if (value.requestDigest !== request.requestDigest) throw new Error("Atlas generation result requestDigest does not match the request");
  if (!isObject(value.provider)) throw new Error("Atlas generation result requires provider");
  rejectUnexpectedKeys(value.provider, new Set(["id", "mode", "model"]), "result.provider");
  const mode = requiredText(value.provider.mode, "result.provider.mode", 32);
  if (!ATLAS_GENERATION_MODES.includes(mode)) throw new Error("Atlas generation result provider.mode is invalid");
  const provider = Object.freeze({
    id: providerId(value.provider.id, "result.provider.id"),
    mode,
    model: optionalText(value.provider.model, "result.provider.model", 160),
  });
  if (options.expectedMode && provider.mode !== options.expectedMode) {
    throw new Error(`Atlas generation result provider.mode must be ${options.expectedMode}`);
  }
  if (options.expectedProviderId && provider.id !== options.expectedProviderId) {
    throw new Error(`Atlas generation result provider.id must be ${options.expectedProviderId}`);
  }
  if (!isObject(value.artifact)) throw new Error("Atlas generation result requires artifact");
  rejectUnexpectedKeys(value.artifact, new Set(["kind", "title", "summary", "room", "sources", "systemModel"]), "result.artifact");
  const kind = requiredText(value.artifact.kind, "artifact.kind", 64);
  if (kind !== request.task.kind) throw new Error("Atlas generation artifact.kind must match request.task.kind");
  const systemModel = kind === "repository-system-model"
    ? resultRepositorySystemModel(value.artifact.systemModel, request)
    : null;
  if (kind !== "repository-system-model" && value.artifact.systemModel !== undefined) {
    throw new Error("Atlas generation artifact.systemModel is only valid for repository-system-model");
  }
  const artifact = Object.freeze({
    kind,
    title: requiredText(value.artifact.title, "artifact.title", 240),
    summary: requiredText(value.artifact.summary, "artifact.summary", MAX_RESULT_TEXT),
    room: resultRoom(value.artifact.room, kind === "room-specification"),
    sources: resultSources(value.artifact.sources, request),
    ...(systemModel ? { systemModel } : {}),
  });
  if (kind === "room-specification" && artifact.room.id === request.repositoryId) {
    throw new Error("Atlas generation room-specification cannot replace the repository authority room");
  }
  return Object.freeze({
    schema: ATLAS_GENERATION_RESULT_SCHEMA,
    requestDigest: request.requestDigest,
    provider,
    artifact,
  });
}

/** Returns repository-local request, accepted-result, and current-artifact state directories. */
export function atlasGenerationStatePaths(root) {
  const stateRoot = pathInside(path.resolve(root), ".atlas/state/generation", "state root");
  return Object.freeze({
    stateRoot,
    requestsRoot: path.join(stateRoot, "requests"),
    acceptedRoot: path.join(stateRoot, "accepted"),
    currentRoot: path.join(stateRoot, "current"),
  });
}

/** Writes formatted JSON by atomically replacing a same-directory staging file. */
function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const staging = `${filePath}.writing-${process.pid}`;
  fs.writeFileSync(staging, canonicalAtlasGenerationJson(value), "utf8");
  fs.renameSync(staging, filePath);
}

/** Persists one validated request in ignored instance state for the current-agent handshake. */
export function storeAtlasGenerationRequest(options = {}) {
  const root = path.resolve(options.root);
  const request = validateAtlasGenerationRequest(options.request);
  const paths = atlasGenerationStatePaths(root);
  const requestPath = path.join(paths.requestsRoot, `${request.requestDigest}.json`);
  writeJsonAtomic(requestPath, request);
  return Object.freeze({ request, path: path.relative(root, requestPath).replace(/\\/gu, "/") });
}

/** Reads a request from ignored state by its validated lowercase digest identity. */
export function readAtlasGenerationRequest(options = {}) {
  const digest = requiredText(options.requestDigest, "request digest", 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error("Atlas generation request digest must be SHA-256");
  const requestPath = path.join(atlasGenerationStatePaths(options.root).requestsRoot, `${digest}.json`);
  if (!fs.existsSync(requestPath)) throw new Error(`Atlas generation request is not stored: ${digest}`);
  return validateAtlasGenerationRequest(JSON.parse(fs.readFileSync(requestPath, "utf8")));
}

/** Rejects a stored request when any admitted source path or digest has changed since creation. */
export function assertAtlasGenerationRequestCurrent(options = {}) {
  const root = path.resolve(options.root);
  const request = validateAtlasGenerationRequest(options.request);
  for (const source of request.sources) {
    const sourcePath = pathInside(root, source.path, `source ${source.path}`);
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      throw new Error(`Atlas generation source is missing: ${source.path}`);
    }
    if (sha256(fs.readFileSync(sourcePath)) !== source.digest) {
      throw new Error(`Atlas generation source is stale: ${source.path}`);
    }
  }
  if (request.task.kind === "repository-system-model") {
    const currentInventory = generationRepositoryInventory(options.repositoryInventory, true);
    if (canonicalAtlasGenerationJson(currentInventory) !== canonicalAtlasGenerationJson(request.repositoryInventory)) {
      throw new Error("Atlas generation repository inventory is stale");
    }
  }
  return request;
}

/** Derives the single current-artifact slot replaced by an explicit successful apply. */
function currentArtifactName(result) {
  if (result.artifact.kind === "source-summary") {
    return `source-summary-${sha256(result.artifact.sources[0].path).slice(0, 20)}.json`;
  }
  if (result.artifact.kind === "workspace-entry-summary") return "workspace-entry-summary.json";
  if (result.artifact.kind === "room-specification") return `room-specification-${result.artifact.room.id}.json`;
  if (result.artifact.kind === "repository-system-model") return "repository-system-model.json";
  return `route-explanation-${sha256(result.artifact.sources.map((source) => source.path).join("\0")).slice(0, 20)}.json`;
}

/** Applies one validated result to ignored state without mutating durable repository sources. */
export function applyAtlasGenerationResult(options = {}) {
  const root = path.resolve(options.root);
  const request = assertAtlasGenerationRequestCurrent({
    root,
    request: options.request,
    repositoryInventory: options.repositoryInventory,
  });
  const result = validateAtlasGenerationResult({
    request,
    result: options.result,
    expectedMode: options.expectedMode,
    expectedProviderId: options.expectedProviderId,
  });
  const resultDigest = sha256(canonicalAtlasGenerationJson(result));
  const applied = Object.freeze({
    schema: ATLAS_GENERATION_APPLIED_SCHEMA,
    request,
    result,
    resultDigest,
  });
  const paths = atlasGenerationStatePaths(root);
  // One request may receive divergent valid judgments on different machines.
  // Preserve each accepted result independently while the current slot remains
  // the explicit last-applied local choice.
  const acceptedPath = path.join(paths.acceptedRoot, `${request.requestDigest}-${resultDigest}.json`);
  const currentPath = path.join(paths.currentRoot, currentArtifactName(result));
  writeJsonAtomic(acceptedPath, applied);
  writeJsonAtomic(currentPath, applied);
  return Object.freeze({
    applied,
    resultDigest,
    acceptedPath: path.relative(root, acceptedPath).replace(/\\/gu, "/"),
    currentPath: path.relative(root, currentPath).replace(/\\/gu, "/"),
  });
}

/** Reads current generated artifacts, quarantining invalid or stale ignored state as diagnostics. */
export function loadCurrentAtlasGenerationArtifacts(options = {}) {
  const root = path.resolve(options.root);
  const currentRoot = atlasGenerationStatePaths(root).currentRoot;
  const artifacts = [];
  const diagnostics = [];
  if (!fs.existsSync(currentRoot)) return Object.freeze({ artifacts: Object.freeze([]), diagnostics: Object.freeze([]) });
  for (const name of fs.readdirSync(currentRoot).filter((entry) => entry.endsWith(".json")).sort()) {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(currentRoot, name), "utf8"));
      if (value.schema !== ATLAS_GENERATION_APPLIED_SCHEMA) throw new Error("applied schema is invalid");
      const request = assertAtlasGenerationRequestCurrent({
        root,
        request: value.request,
        repositoryInventory: options.repositoryInventory,
      });
      const result = validateAtlasGenerationResult({ request, result: value.result });
      const resultDigest = sha256(canonicalAtlasGenerationJson(result));
      if (value.resultDigest && value.resultDigest !== resultDigest) {
        throw new Error("applied result digest does not match the validated result");
      }
      artifacts.push(Object.freeze({ request, result, resultDigest }));
    } catch (error) {
      diagnostics.push(Object.freeze({
        code: "generation-artifact-quarantined",
        path: `.atlas/state/generation/current/${name}`,
        reason: String(error?.message || error),
      }));
    }
  }
  return Object.freeze({ artifacts: Object.freeze(artifacts), diagnostics: Object.freeze(diagnostics) });
}

/** Runs one local executable adapter without a shell and validates its stdout result. */
export function runAtlasGenerationAdapter(options = {}) {
  const root = path.resolve(options.root);
  const request = assertAtlasGenerationRequestCurrent({
    root,
    request: options.request,
    repositoryInventory: options.repositoryInventory,
  });
  const generation = validateAtlasGenerationConfig(options.generation);
  if (generation.mode !== "command") throw new Error("Atlas generation run requires command mode");
  if (generation.dataBoundary === "remote" && options.allowRemote !== true) {
    throw new Error("Atlas remote generation requires the explicit --allow-remote grant for this invocation");
  }
  const adapterPath = pathInside(root, generation.adapterCommand, "configuration.adapterCommand");
  if (!fs.existsSync(adapterPath) || !fs.statSync(adapterPath).isFile()) {
    throw new Error(`Atlas generation adapter command is missing: ${generation.adapterCommand}`);
  }
  const env = { ...process.env, ...(options.env || {}) };
  env.ATLAS_GENERATION_PROVIDER_ID = generation.providerId;
  env.ATLAS_GENERATION_DATA_BOUNDARY = generation.dataBoundary;
  if (generation.dataBoundary === "remote" && options.allowRemote === true) {
    env[REMOTE_APPROVAL_ENV] = REMOTE_APPROVAL_VALUE;
  }
  const result = childProcess.spawnSync(adapterPath, [], {
    cwd: root,
    env,
    input: canonicalAtlasGenerationJson(request),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: Number(options.timeoutMs || 120000),
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Atlas generation adapter failed (${result.status}): ${String(result.stderr || "").trim().slice(0, 2000)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Atlas generation adapter returned invalid JSON: ${error.message}`);
  }
  return validateAtlasGenerationResult({
    request,
    result: parsed,
    expectedMode: "command",
    expectedProviderId: generation.providerId,
  });
}

/** Describes one instance's configured execution mode without invoking an agent or adapter. */
export function atlasGenerationStatus(options = {}) {
  const root = path.resolve(options.root);
  const generation = validateAtlasGenerationConfig(options.generation);
  const current = loadCurrentAtlasGenerationArtifacts({ root, repositoryInventory: options.repositoryInventory });
  const adapterAvailable = generation.mode === "current-agent"
    || fs.existsSync(pathInside(root, generation.adapterCommand, "configuration.adapterCommand"));
  return Object.freeze({
    schema: "multihead-atlas.generation_status.v1",
    status: adapterAvailable ? "pass" : "attention",
    mode: generation.mode,
    providerId: generation.providerId,
    dataBoundary: generation.dataBoundary,
    adapterCommand: generation.adapterCommand,
    adapterAvailable,
    handshake: generation.mode === "current-agent" ? "request-agent-result-apply" : "request-command-result-apply",
    acceptedCurrentArtifacts: current.artifacts.length,
    quarantinedArtifacts: current.diagnostics.length,
    diagnostics: current.diagnostics,
  });
}

export const ATLAS_GENERATION_REMOTE_APPROVAL = Object.freeze({
  environment: REMOTE_APPROVAL_ENV,
  value: REMOTE_APPROVAL_VALUE,
});
