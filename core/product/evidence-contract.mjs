/*
 * Evidence Contract turns repository-provider search rows into the bounded,
 * agent-facing packet used during normal Atlas retrieval. It may read only
 * files admitted by the instance source policy; catalog summaries and local
 * indexes remain navigation data rather than durable source authority.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const ATLAS_EVIDENCE_SCHEMA = "multihead-atlas.instance_evidence.v2";
export const ATLAS_EVIDENCE_RELEASE_SCHEMA = "multihead-atlas.evidence_protocol_release.v1";
export const ATLAS_EVIDENCE_CONTRACT = Object.freeze({
  schema: "multihead-atlas.instance_evidence_contract.v2",
  contractVersion: 2,
  states: Object.freeze(["strong", "weak", "stale", "missing", "conflicting"]),
  maxExcerptLines: 5,
  maxExcerptCharacters: 1000,
  sourceDigestAlgorithm: "sha256-utf8",
});

const EVIDENCE_STATES = new Set(ATLAS_EVIDENCE_CONTRACT.states);
const EVIDENCE_KIND_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

/** Normalizes untrusted display text to one bounded line for deterministic packets. */
function compact(value, maxLength = 900) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

/** Converts platform separators to portable path text without resolving repository authority. */
function posixPath(value) {
  return String(value || "").replace(/\\/gu, "/");
}

/** Returns bounded non-empty strings once each while preserving their first-seen order. */
function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => compact(value, 256)).filter(Boolean))];
}

/** Computes the content digest that binds specifications, sources, and complete evidence packets. */
function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Validates that a release-record field contains non-empty identifying text. */
function requiredReleaseText(value, field) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`Atlas Evidence release requires ${field}`);
  return text;
}

/**
 * The Evidence release record binds the normative specification to the Core
 * release that implements it. The specification path must remain inside this
 * product tree so an installed runtime and a public export verify the same
 * bytes even when product documents are grouped below `docs/`.
 */
export function readAtlasEvidenceRelease(options = {}) {
  const productRoot = path.resolve(options.productRoot || import.meta.dirname);
  const recordPath = path.join(productRoot, "evidence-release.json");
  const recordStat = fs.lstatSync(recordPath);
  if (!recordStat.isFile() || recordStat.isSymbolicLink()) {
    throw new Error("Atlas Evidence release record must be a regular file");
  }
  const raw = fs.readFileSync(recordPath);
  const record = JSON.parse(raw.toString("utf8"));
  if (record.schema !== ATLAS_EVIDENCE_RELEASE_SCHEMA) {
    throw new Error(`Atlas Evidence release schema must be ${ATLAS_EVIDENCE_RELEASE_SCHEMA}`);
  }
  if (record.protocolSchema !== ATLAS_EVIDENCE_SCHEMA) {
    throw new Error(`Atlas Evidence release protocol schema must be ${ATLAS_EVIDENCE_SCHEMA}`);
  }
  if (record.contractSchema !== ATLAS_EVIDENCE_CONTRACT.schema
    || record.contractVersion !== ATLAS_EVIDENCE_CONTRACT.contractVersion) {
    throw new Error("Atlas Evidence release contract identity does not match the implementation");
  }
  if (record.status !== "frozen") throw new Error("Atlas Evidence release status must be frozen");

  const specificationPath = requiredReleaseText(record.specification?.path, "specification.path");
  if (path.isAbsolute(specificationPath)
    || path.normalize(specificationPath) !== specificationPath
    || specificationPath === ".."
    || specificationPath.startsWith(`..${path.sep}`)) {
    throw new Error("Atlas Evidence specification path must stay inside the product directory");
  }
  if (record.specification?.digestAlgorithm !== "sha256") {
    throw new Error("Atlas Evidence specification digest algorithm must be sha256");
  }
  const expectedSpecificationDigest = requiredReleaseText(
    record.specification?.sha256,
    "specification.sha256",
  ).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(expectedSpecificationDigest)) {
    throw new Error("Atlas Evidence specification digest must be a SHA-256 digest");
  }
  const resolvedSpecification = path.resolve(productRoot, specificationPath);
  const relation = path.relative(productRoot, resolvedSpecification);
  if (!relation || relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error("Atlas Evidence specification must be a child of the product directory");
  }
  const specificationStat = fs.lstatSync(resolvedSpecification);
  if (!specificationStat.isFile() || specificationStat.isSymbolicLink()) {
    throw new Error("Atlas Evidence specification must be a regular file");
  }
  const actualSpecificationDigest = sha256(fs.readFileSync(resolvedSpecification));
  if (actualSpecificationDigest !== expectedSpecificationDigest) {
    throw new Error("Atlas Evidence specification digest does not match the frozen release record");
  }

  const atlasCore = record.compatibility?.atlasCore || {};
  if (!/^\d+\.\d+\.\d+$/u.test(requiredReleaseText(atlasCore.introducedIn, "compatibility.atlasCore.introducedIn"))) {
    throw new Error("Atlas Evidence Atlas Core compatibility must use SemVer");
  }
  if (atlasCore.implementationBoundary !== "atlas-core") {
    throw new Error("Atlas Evidence compatibility must identify its Atlas Core implementation boundary");
  }
  if (record.compatibility?.atlasGraph?.required !== false) {
    throw new Error("Atlas Evidence must not make Atlas Graph a required compatibility dependency");
  }
  if (record.compatibility?.agentInvocation?.evidenceSchema !== ATLAS_EVIDENCE_SCHEMA) {
    throw new Error("Atlas agent invocation compatibility must name the Evidence v2 schema");
  }
  if (record.gitBoundary?.independent !== false
    || record.gitBoundary?.authority !== "atlas-core-release"
    || !requiredReleaseText(record.gitBoundary?.reason, "gitBoundary.reason")) {
    throw new Error("Atlas Evidence must declare its Atlas Core Git boundary and rationale");
  }
  if (!Array.isArray(record.gitBoundary?.revisitTriggers) || record.gitBoundary.revisitTriggers.length < 4) {
    throw new Error("Atlas Evidence Git boundary must declare its independent-release revisit triggers");
  }

  return Object.freeze({
    ...record,
    specification: Object.freeze({
      ...record.specification,
      sha256: expectedSpecificationDigest,
    }),
    recordDigest: sha256(raw),
  });
}

export const ATLAS_EVIDENCE_RELEASE = readAtlasEvidenceRelease();
export const ATLAS_EVIDENCE_PACKET_CONTRACT = Object.freeze({
  ...ATLAS_EVIDENCE_CONTRACT,
  release: Object.freeze({
    schema: ATLAS_EVIDENCE_RELEASE.schema,
    status: ATLAS_EVIDENCE_RELEASE.status,
    specificationDigest: ATLAS_EVIDENCE_RELEASE.specification.sha256,
    releaseRecordDigest: ATLAS_EVIDENCE_RELEASE.recordDigest,
    atlasCoreIntroducedIn: ATLAS_EVIDENCE_RELEASE.compatibility.atlasCore.introducedIn,
    atlasGraphRequired: ATLAS_EVIDENCE_RELEASE.compatibility.atlasGraph.required,
    agentInvocationContract: ATLAS_EVIDENCE_RELEASE.compatibility.agentInvocation.contract,
  }),
});

/** Converts a finite metric to the contract's stable four-decimal representation. */
function rounded(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Number(number.toFixed(4)) : 0;
}

/** Redacts the absolute repository root and bounds text before exposing provider data. */
function safeText(value, root, maxLength = 900) {
  const normalizedRoot = posixPath(path.resolve(root));
  return compact(posixPath(value).split(normalizedRoot).join("[repository]"), maxLength);
}

/** Checks whether a normalized relative path equals or descends from an admitted prefix. */
function isWithin(relative, prefix) {
  return relative === prefix || relative.startsWith(`${prefix}/`);
}

/**
 * Validates a catalog source pointer against the tracked instance's bounded
 * source policy. A pointer is readable only when the tracked instance would
 * admit the same path during its bounded source scan. Rejected pointers are
 * not echoed back because an excluded or absolute path is itself private
 * repository metadata.
 */
function sourcePolicy(instance, value) {
  const raw = posixPath(value).trim();
  if (!raw) return { status: "not-applicable", path: "" };
  if (raw.startsWith("/") || /^[a-z]:\//iu.test(raw)) return { status: "not-authorized", path: "" };
  const relative = path.posix.normalize(raw.replace(/^\.\//u, ""));
  if (!relative || relative === "." || relative === ".." || relative.startsWith("../")) {
    return { status: "not-authorized", path: "" };
  }
  if (instance.source.exclude.some((prefix) => isWithin(relative, posixPath(prefix)))) {
    return { status: "not-authorized", path: "" };
  }
  const matchingIncludes = instance.source.include.filter((prefix) => isWithin(relative, posixPath(prefix)));
  if (!matchingIncludes.length) {
    return { status: "not-authorized", path: "" };
  }
  const minimumDepth = Math.min(...matchingIncludes.map((prefix) => {
    const prefixParts = posixPath(prefix).split("/").filter(Boolean);
    const relativeParts = relative.split("/").filter(Boolean);
    return Math.max(0, relativeParts.length - prefixParts.length);
  }));
  if (minimumDepth > instance.source.maxDepth) return { status: "not-authorized", path: "" };
  if (!instance.source.extensions.includes(path.posix.extname(relative).toLowerCase())) {
    return { status: "not-authorized", path: "" };
  }
  return { status: "authorized", path: relative };
}

/** Reads an authorized regular file without following symbolic links or exceeding size limits. */
function readAuthorizedSource(root, instance, policy) {
  if (policy.status !== "authorized") return undefined;
  let current = path.resolve(root);
  for (const segment of policy.path.split("/")) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) return undefined;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) return undefined;
  }
  const stat = fs.lstatSync(current);
  if (!stat.isFile() || stat.size > instance.source.maxFileBytes) return undefined;
  const text = fs.readFileSync(current, "utf8");
  return Object.freeze({
    path: policy.path,
    bytes: stat.size,
    digest: sha256(text),
    text,
  });
}

/** Selects a bounded source excerpt around the strongest lexical match and redacts root paths. */
function excerptForSource(file, tokens, root) {
  if (!file) return null;
  const lines = String(file.text || "").split(/\r?\n/gu);
  const normalizedTokens = uniqueStrings(tokens.map((token) => String(token || "").toLowerCase()));
  const candidates = lines.map((line, index) => {
    const lower = line.toLowerCase();
    const matchedTokens = normalizedTokens.filter((token) => lower.includes(token));
    return { index, matchedTokens, nonEmpty: Boolean(line.trim()) };
  });
  const matched = candidates
    .filter((candidate) => candidate.matchedTokens.length)
    .sort((left, right) => right.matchedTokens.length - left.matchedTokens.length || left.index - right.index)[0];
  const firstNonEmpty = candidates.find((candidate) => candidate.nonEmpty);
  const anchor = matched?.index ?? firstNonEmpty?.index;
  if (anchor === undefined) return null;
  const requestedLines = matched ? ATLAS_EVIDENCE_CONTRACT.maxExcerptLines : 3;
  let start = Math.max(0, anchor - (matched ? 2 : 0));
  let end = Math.min(lines.length, start + requestedLines);
  start = Math.max(0, end - requestedLines);
  const selected = lines.slice(start, end);
  let lineTruncated = false;
  const boundedLines = selected.map((line) => {
    if (line.length <= 240) return line;
    lineTruncated = true;
    return `${line.slice(0, 237).trimEnd()}...`;
  });
  const normalizedRoot = posixPath(path.resolve(root));
  const redactedText = posixPath(boundedLines.join("\n")).split(normalizedRoot).join("[repository]").trim();
  const characterTruncated = redactedText.length > ATLAS_EVIDENCE_CONTRACT.maxExcerptCharacters;
  const text = characterTruncated
    ? `${redactedText.slice(0, ATLAS_EVIDENCE_CONTRACT.maxExcerptCharacters - 3).trimEnd()}...`
    : redactedText;
  const selectedLower = selected.join("\n").toLowerCase();
  return {
    startLine: start + 1,
    endLine: end,
    text,
    matchedTokens: normalizedTokens.filter((token) => selectedLower.includes(token)),
    truncated: lineTruncated || characterTruncated || start > 0 || end < lines.length,
  };
}

/** Returns only the object-shaped Evidence metadata attached to a catalog room. */
function evidenceMetadata(room = {}) {
  const value = room.metadata?.evidence;
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** Derives a supported Evidence kind from declared metadata and the room's source role. */
function evidenceKind(room, hasSource) {
  const declared = compact(evidenceMetadata(room).kind, 64).toLowerCase();
  if (declared && EVIDENCE_KIND_PATTERN.test(declared)) return { kind: declared, supported: true };
  if (declared) return { kind: "unsupported", supported: false };
  if (hasSource) return { kind: "repository-source", supported: true };
  if (room.id === room.owner) return { kind: "repository-aggregate", supported: true };
  return { kind: "generated-navigation-summary", supported: true };
}

/** Compares live source and indexed digests to classify one result's freshness basis. */
function freshnessFor(room, result, file) {
  const metadata = evidenceMetadata(room);
  const sourceDigest = file?.digest || "";
  const indexedSourceDigest = compact(metadata.sourceDigest || room.metadata?.sourceDigest, 128);
  const sourceDigestAlgorithm = compact(
    metadata.sourceDigestAlgorithm || room.metadata?.sourceDigestAlgorithm,
    64,
  ).toLowerCase();
  const providerStatus = compact(result.freshnessStatus || room.freshnessStatus, 128) || "unreported";
  const providerDigest = compact(result.freshnessDigest || room.freshnessDigest, 128);

  if (!file) {
    return {
      state: "missing",
      status: providerStatus,
      digest: providerDigest,
      indexedSourceDigest,
      sourceDigest: "",
      basis: "source-unavailable",
    };
  }
  if (indexedSourceDigest) {
    if (sourceDigestAlgorithm && sourceDigestAlgorithm !== ATLAS_EVIDENCE_CONTRACT.sourceDigestAlgorithm) {
      return {
        state: "unverified",
        status: providerStatus,
        digest: providerDigest,
        indexedSourceDigest,
        sourceDigest,
        basis: "unsupported-source-digest-algorithm",
      };
    }
    return {
      state: indexedSourceDigest === sourceDigest ? "current" : "stale",
      status: providerStatus,
      digest: providerDigest,
      indexedSourceDigest,
      sourceDigest,
      basis: "content-digest-comparison",
    };
  }
  if (result.vectorFreshnessDigest && providerDigest && result.vectorFreshnessDigest !== providerDigest) {
    return {
      state: "stale",
      status: providerStatus,
      digest: providerDigest,
      indexedSourceDigest: result.vectorFreshnessDigest,
      sourceDigest,
      basis: "index-catalog-digest-mismatch",
    };
  }
  if (/stale|mismatch|outdated/iu.test(providerStatus)) {
    return {
      state: "stale",
      status: providerStatus,
      digest: providerDigest,
      indexedSourceDigest: "",
      sourceDigest,
      basis: "provider-reported-stale",
    };
  }
  if (providerStatus === "source-digest-current" && providerDigest) {
    return {
      state: "current",
      status: providerStatus,
      digest: providerDigest,
      indexedSourceDigest: "",
      sourceDigest,
      basis: "provider-asserted",
    };
  }
  return {
    state: "unverified",
    status: providerStatus,
    digest: providerDigest,
    indexedSourceDigest: "",
    sourceDigest,
    basis: "provider-freshness-unavailable",
  };
}

/** Builds the observable match reasons and normalized score breakdown for one result. */
function matchFor(search, result) {
  const matchedTokens = uniqueStrings(result.matchedTokenValues || []);
  const reasons = [];
  if (result.exactRoomIdMatch) reasons.push("exact-room-id");
  if (matchedTokens.length) reasons.push("lexical-token-match");
  if (Number(result.vectorScore || 0) > 0) reasons.push("vector-similarity");
  if (!reasons.length) reasons.push("stable-ranking-fallback");
  return {
    reasons,
    queryTokens: uniqueStrings(search.tokens || []),
    matchedTokens,
    score: {
      normalized: rounded(result.normalizedScore),
      lexical: rounded(result.lexicalScore),
      lexicalNormalized: rounded(result.lexicalNormalizedScore),
      vector: rounded(result.vectorScore),
      lexicalWeight: rounded(search.scoring?.lexicalWeight),
      vectorWeight: rounded(search.scoring?.vectorWeight),
      source: compact(result.scoreSource, 128),
    },
  };
}

/** Applies the frozen token-and-score threshold that distinguishes strong retrieval evidence. */
function strongMatch(result) {
  if (result.exactRoomIdMatch) return true;
  const matched = Number(result.matchedTokens || result.matchedTokenValues?.length || 0);
  const score = Number(result.normalizedScore || 0);
  return (matched >= 1 && score >= 0.35) || (matched >= 2 && score >= 0.2);
}

/** Resolves one item's final Evidence state with conflicts and stale sources taking precedence. */
function itemState({ room, result, source, freshness, kindSupported }) {
  const declaredState = compact(evidenceMetadata(room).state, 64).toLowerCase();
  if (declaredState === "conflicting") return "conflicting";
  if (declaredState === "stale" || freshness.state === "stale") return "stale";
  if (declaredState === "missing" || source.status === "missing" || source.status === "not-authorized") return "missing";
  if (declaredState === "weak" || !kindSupported) return "weak";
  if (declaredState && !EVIDENCE_STATES.has(declaredState)) return "weak";
  if (source.status !== "available" || freshness.state !== "current") return "weak";
  return strongMatch(result) ? "strong" : "weak";
}

/** Reduces item states to the packet state using the frozen severity precedence. */
function overallState(items) {
  if (!items.length) return "missing";
  if (items.some((item) => item.state === "conflicting")) return "conflicting";
  if (items.some((item) => item.state === "stale")) return "stale";
  if (items.some((item) => item.state === "strong")) return "strong";
  if (items.some((item) => item.state === "missing")) return "missing";
  return "weak";
}

/** Builds a privacy-bounded provider description without leaking absolute roots or index paths. */
function safeProvider(options) {
  const { root, instance, catalog, providerDescription = {}, index = {} } = options;
  const adapterModule = instance.adapter.module;
  return {
    contract: compact(providerDescription.contract?.schema, 128),
    repositoryId: instance.repositoryId,
    catalog: {
      schema: compact(catalog.schema, 128),
      authority: compact(catalog.authority, 128),
    },
    adapter: {
      kind: adapterModule ? "consumer-module" : "atlas-default",
      id: safeText(
        providerDescription.generationProvider
          || catalog.metadata?.generationProvider
          || catalog.metadata?.sourceModel
          || "multihead-atlas-default-repository-adapter",
        root,
        256,
      ),
      module: adapterModule,
      exportName: instance.adapter.exportName,
    },
    index: {
      digest: compact(index.digest, 128),
      kind: compact(index.indexKind, 128),
      vectorKind: compact(index.vectorIndexKind, 128),
      vectorModel: compact(index.vectorModel, 128),
    },
  };
}

/**
 * Builds one deterministic packet from already-ensured provider inputs. The
 * payload deliberately omits generated timestamps, absolute roots, and index
 * paths so identical repository content can reconcile across machines.
 */
export function buildAtlasEvidencePacket(options = {}) {
  const root = path.resolve(String(options.root || ""));
  const { instance, catalog, search } = options;
  if (!String(options.root || "").trim()) throw new Error("Atlas evidence requires root");
  if (!instance || !catalog || !search) throw new Error("Atlas evidence requires instance, catalog, and search");
  const rooms = new Map(catalog.rooms.map((room) => [room.id, room]));
  const diagnostics = [];

  const evidence = (search.results || []).map((result) => {
    const room = rooms.get(result.id) || {};
    const requestedSourcePath = room.metadata?.sourcePath || evidenceMetadata(room).sourcePath || "";
    const policy = sourcePolicy(instance, requestedSourcePath);
    const file = readAuthorizedSource(root, instance, policy);
    const sourceStatus = policy.status === "not-applicable"
      ? "not-applicable"
      : policy.status === "not-authorized"
        ? "not-authorized"
        : file
          ? "available"
          : "missing";
    const source = {
      status: sourceStatus,
      path: sourceStatus === "not-authorized" ? "" : policy.path,
      digest: file?.digest || "",
      digestAlgorithm: file ? ATLAS_EVIDENCE_CONTRACT.sourceDigestAlgorithm : "",
      sizeBytes: file?.bytes || 0,
    };
    const kind = evidenceKind(room, Boolean(requestedSourcePath));
    const match = matchFor(search, result);
    const freshness = sourceStatus === "not-authorized" ? {
      state: "missing",
      status: "unavailable",
      digest: "",
      indexedSourceDigest: "",
      sourceDigest: "",
      basis: "source-not-authorized",
    } : freshnessFor(room, result, file);
    const state = itemState({ room, result, source, freshness, kindSupported: kind.supported });
    const itemDiagnostics = [];
    if (sourceStatus === "not-authorized") itemDiagnostics.push("source-not-authorized");
    if (sourceStatus === "missing") itemDiagnostics.push("source-missing");
    if (!kind.supported) itemDiagnostics.push("unsupported-evidence-kind");
    const declaredState = compact(evidenceMetadata(room).state, 64).toLowerCase();
    if (declaredState && !EVIDENCE_STATES.has(declaredState)) itemDiagnostics.push("unsupported-evidence-state");
    if (freshness.state === "stale") itemDiagnostics.push("source-stale");
    if (freshness.state === "unverified") itemDiagnostics.push("freshness-unverified");
    for (const code of itemDiagnostics) diagnostics.push({ code, roomId: safeText(result.id, root, 256) });
    const redactCatalogText = sourceStatus === "not-authorized";
    const excerpt = sourceStatus === "available"
      ? excerptForSource(file, match.matchedTokens.length ? match.matchedTokens : match.queryTokens, root)
      : null;
    return {
      roomId: safeText(result.id, root, 256),
      kind: kind.kind,
      state,
      label: redactCatalogText ? "Source unavailable" : safeText(result.label, root, 256),
      summary: redactCatalogText ? "" : safeText(result.generatedSummary || result.summary, root, 900),
      source,
      locator: excerpt ? { path: source.path, startLine: excerpt.startLine, endLine: excerpt.endLine } : null,
      excerpt: excerpt ? {
        text: excerpt.text,
        matchedTokens: excerpt.matchedTokens,
        truncated: excerpt.truncated,
      } : null,
      freshness,
      match,
      diagnostics: itemDiagnostics,
    };
  });

  const stateCounts = Object.fromEntries(ATLAS_EVIDENCE_CONTRACT.states.map((state) => [
    state,
    evidence.filter((item) => item.state === state).length,
  ]));
  const sourceHints = evidence.filter((item) => item.source.path).length;
  const packet = {
    schema: ATLAS_EVIDENCE_SCHEMA,
    contract: ATLAS_EVIDENCE_PACKET_CONTRACT,
    status: search.status === "pass" ? "pass" : "fail",
    state: overallState(evidence),
    repositoryId: instance.repositoryId,
    query: safeText(search.query, root, 4096),
    provider: safeProvider(options),
    evidence,
    metrics: {
      results: evidence.length,
      states: stateCounts,
      sourceHints,
      sourceHintCoverage: evidence.length ? rounded(sourceHints / evidence.length) : 0,
      excerpts: evidence.filter((item) => item.excerpt).length,
      topResultState: evidence[0]?.state || "missing",
      topResultHasSource: Boolean(evidence[0]?.source.path),
    },
    diagnostics: diagnostics.sort((left, right) => left.roomId.localeCompare(right.roomId) || left.code.localeCompare(right.code)),
  };
  return Object.freeze({ ...packet, packetDigest: sha256(JSON.stringify(packet)) });
}
