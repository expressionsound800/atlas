/*
 * Architecture Atlas ranks provider-authored workspace entries and derives
 * source-neutral traversal candidates without owning architecture source truth.
 */
import { normalizeId } from "./graph-geometry.js";

export const ARCHITECTURE_ATLAS_SCHEMA = "multihead-memory-graph.architecture-atlas.v1";

/** Normalizes provider text while preserving an explicit fallback for missing labels. */
function compactText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

/** Returns provider arrays unchanged and converts every other input shape to empty. */
function listFrom(value) {
  return Array.isArray(value) ? value : [];
}

/** Normalizes an optional room or portal identifier without inventing an authority. */
function normalizeOptionalId(value) {
  return normalizeId(value) || "";
}

/** Deduplicates non-empty provider strings case-insensitively in their original order. */
function uniqueStrings(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = compactText(value);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

/** Normalizes and deduplicates room-entry identifiers while preserving first occurrence. */
function uniqueIds(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const id = normalizeOptionalId(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/** Converts provider scoring input to a finite value within the zero-to-one contract. */
function normalizeScore(value, fallback = 0.5) {
  const score = Number(value);
  if (!Number.isFinite(score)) return fallback;
  return Math.max(0, Math.min(1, score));
}

/** Resolves lexical, vector, and combined index signals across supported score record shapes. */
function externalIndexScoreParts(room = {}, indexScores = {}) {
  const empty = {
    indexSimilarity: 0,
    lexicalIndexSimilarity: 0,
    vectorSimilarity: 0,
    indexScoreSource: "",
  };
  if (!indexScores || typeof indexScores !== "object") return empty;
  const candidates = [
    room.id,
    room.sourceId,
    compactText(room.id).toLowerCase(),
    compactText(room.sourceId).toLowerCase(),
  ].filter(Boolean);
  for (const key of candidates) {
    const score = indexScores[key];
    if (typeof score === "number") {
      return {
        ...empty,
        indexSimilarity: normalizeScore(score, 0),
      };
    }
    if (score && typeof score === "object") {
      return {
        indexSimilarity: normalizeScore(score.score ?? score.normalizedScore ?? score.combinedScore, 0),
        lexicalIndexSimilarity: normalizeScore(score.lexical ?? score.lexicalNormalizedScore ?? 0, 0),
        vectorSimilarity: normalizeScore(score.vector ?? score.vectorScore ?? 0, 0),
        indexScoreSource: compactText(score.source || score.scoreSource || ""),
      };
    }
  }
  return empty;
}

/** Converts portal traversal cost to a positive finite value with unit fallback. */
function normalizeCost(value) {
  const cost = Number(value);
  return Number.isFinite(cost) && cost > 0 ? cost : 1;
}

/** Converts architecture prose into lowercase alphanumeric tokens for local ranking. */
function tokenizeText(value) {
  return compactText(value)
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

/** Builds a unique token set from multiple room, route, or query text fields. */
function tokenSet(values = []) {
  return new Set(values.flatMap((value) => tokenizeText(value)));
}

/** Computes query-token coverage within a candidate room's searchable token set. */
function intersectionRatio(queryTokens, targetTokens) {
  if (!queryTokens.size) return 0;
  let hits = 0;
  for (const token of queryTokens) {
    if (targetTokens.has(token)) hits += 1;
  }
  return hits / queryTokens.size;
}

/** Collects searchable task, repository, stem, facet, and matched-signal route context. */
function routeSignals(route = {}) {
  const facets = route.facets && typeof route.facets === "object"
    ? Object.entries(route.facets)
      .filter(([, enabled]) => enabled === true)
      .map(([key]) => key)
    : [];
  return uniqueStrings([
    route.taskKind,
    route.scope,
    route.familyObjective,
    ...listFrom(route.affectedRepos),
    ...listFrom(route.sourceAuthorities),
    ...listFrom(route.stems),
    ...facets,
    ...listFrom(route.matchedSignals),
  ]);
}

/** Normalizes one provider-authored architecture entry into the stable room model. */
function normalizeArchitectureRoom(room = {}, index = 0) {
  const sourceId = compactText(room.id, `room:${index + 1}`);
  const id = normalizeOptionalId(sourceId);
  const sourceRepos = uniqueStrings([
    ...listFrom(room.sourceRepos),
    ...listFrom(room.repos),
    room.repo,
    room.owner,
  ]);
  const answers = uniqueStrings([
    ...listFrom(room.answers),
    ...listFrom(room.questionFit),
    ...listFrom(room.questions),
  ]);
  const facets = uniqueStrings([
    ...listFrom(room.facets),
    room.viewpoint,
    room.owner,
    room.product,
    room.utility,
  ]);
  return {
    ...room,
    elementType: "architecture-room",
    id,
    sourceId,
    label: compactText(room.label, sourceId),
    owner: compactText(room.owner || room.product || room.utility),
    viewpoint: compactText(room.viewpoint || "overview"),
    summary: compactText(room.summary || room.description),
    generatedSummary: compactText(room.generatedSummary || room.llmSummary || ""),
    summaryStatus: compactText(room.summaryStatus || (room.generatedSummary || room.llmSummary ? "generated" : "provider-authored")),
    summaryUpdatedAt: compactText(room.summaryUpdatedAt || room.generatedAt || ""),
    summaryDigest: compactText(room.summaryDigest || room.digest || ""),
    sourceRepos,
    entryNodeIds: uniqueIds([...(listFrom(room.entryNodeIds)), ...(listFrom(room.entryNodes))]),
    exitNodeIds: uniqueIds([...(listFrom(room.exitNodeIds)), ...(listFrom(room.exitNodes))]),
    answers,
    facets,
    doNotExpand: room.doNotExpand === true,
    authorityScore: normalizeScore(room.authorityScore, 0.5),
    freshnessScore: normalizeScore(room.freshnessScore, 0.5),
    graphProjection: room.graphProjection && typeof room.graphProjection === "object" ? room.graphProjection : null,
    indexRefs: room.indexRefs && typeof room.indexRefs === "object" ? room.indexRefs : {},
    metadata: room.metadata && typeof room.metadata === "object" ? room.metadata : {},
  };
}

/** Normalizes one inter-room relationship into a costed directional portal record. */
function normalizeArchitecturePortal(portal = {}, index = 0) {
  const fromRoomId = normalizeOptionalId(portal.fromRoomId || portal.from || portal.sourceRoomId);
  const toRoomId = normalizeOptionalId(portal.toRoomId || portal.to || portal.targetRoomId);
  const sourceId = compactText(portal.id, `portal:${index + 1}:${fromRoomId}:${toRoomId}`);
  return {
    ...portal,
    elementType: "architecture-portal",
    id: normalizeOptionalId(sourceId),
    sourceId,
    fromRoomId,
    toRoomId,
    kind: compactText(portal.kind || portal.type || "related"),
    label: compactText(portal.label),
    exitNodeId: normalizeOptionalId(portal.exitNodeId || portal.exitNode),
    entryNodeId: normalizeOptionalId(portal.entryNodeId || portal.entryNode),
    bidirectional: portal.bidirectional === true,
    traversalCost: normalizeCost(portal.traversalCost ?? portal.cost),
    reason: compactText(portal.reason || portal.description),
    metadata: portal.metadata && typeof portal.metadata === "object" ? portal.metadata : {},
  };
}

/** Builds indexed room and portal maps while collecting structural errors and warnings. */
export function normalizeArchitectureAtlas(atlas = {}) {
  const diagnostics = {
    errors: [],
    warnings: [],
  };
  const rooms = listFrom(atlas.rooms).map(normalizeArchitectureRoom).filter((room) => room.id);
  const portals = listFrom(atlas.portals).map(normalizeArchitecturePortal).filter((portal) => portal.id);
  const roomById = new Map();
  const portalById = new Map();
  const portalsByRoomId = new Map();

  for (const room of rooms) {
    if (roomById.has(room.id)) {
      diagnostics.errors.push({ code: "duplicate-room-id", id: room.id });
      continue;
    }
    roomById.set(room.id, room);
    portalsByRoomId.set(room.id, []);
    if (!room.sourceRepos.length) diagnostics.warnings.push({ code: "room-missing-source-repos", roomId: room.id });
    if (!room.answers.length) diagnostics.warnings.push({ code: "room-missing-question-fit", roomId: room.id });
    if (!room.entryNodeIds.length) diagnostics.warnings.push({ code: "room-missing-entry-nodes", roomId: room.id });
    if (!room.exitNodeIds.length) diagnostics.warnings.push({ code: "room-missing-exit-nodes", roomId: room.id });
  }

  if (!rooms.length) diagnostics.errors.push({ code: "empty-atlas" });

  for (const portal of portals) {
    if (portalById.has(portal.id)) {
      diagnostics.errors.push({ code: "duplicate-portal-id", id: portal.id });
      continue;
    }
    portalById.set(portal.id, portal);
    if (!roomById.has(portal.fromRoomId)) {
      diagnostics.errors.push({ code: "missing-portal-source-room", portalId: portal.id, roomId: portal.fromRoomId });
    }
    if (!roomById.has(portal.toRoomId)) {
      diagnostics.errors.push({ code: "missing-portal-target-room", portalId: portal.id, roomId: portal.toRoomId });
    }
    if (roomById.has(portal.fromRoomId)) portalsByRoomId.get(portal.fromRoomId)?.push(portal);
    if (portal.bidirectional && roomById.has(portal.toRoomId)) portalsByRoomId.get(portal.toRoomId)?.push(portal);
  }

  if (rooms.length > 1) {
    for (const room of rooms) {
      const hasIncoming = portals.some((portal) => portal.toRoomId === room.id || (portal.bidirectional && portal.fromRoomId === room.id));
      const hasOutgoing = portals.some((portal) => portal.fromRoomId === room.id || (portal.bidirectional && portal.toRoomId === room.id));
      if (!hasIncoming && !hasOutgoing) diagnostics.warnings.push({ code: "orphan-room", roomId: room.id });
    }
  }

  return {
    schema: atlas.schema || ARCHITECTURE_ATLAS_SCHEMA,
    rooms,
    portals,
    roomById,
    portalById,
    portalsByRoomId,
    metadata: atlas.metadata && typeof atlas.metadata === "object" ? atlas.metadata : {},
    diagnostics,
    metrics: {
      rooms: rooms.length,
      portals: portals.length,
      errors: diagnostics.errors.length,
      warnings: diagnostics.warnings.length,
    },
  };
}

/** Returns structural diagnostics from the same normalization boundary used by Graph. */
export function validateArchitectureAtlas(atlas = {}) {
  return normalizeArchitectureAtlas(atlas).diagnostics;
}

/** Computes one explainable room score from query, route, index, authority, and freshness signals. */
export function scoreArchitectureRoom(room = {}, options = {}) {
  const explicitQueryTokens = tokenSet([options.query]);
  const queryTokens = explicitQueryTokens.size ? explicitQueryTokens : tokenSet(routeSignals(options.route));
  const roomTokens = tokenSet([
    room.id,
    room.label,
    room.owner,
    room.viewpoint,
    room.summary,
    room.generatedSummary,
    ...listFrom(room.sourceRepos),
    ...listFrom(room.answers),
    ...listFrom(room.facets),
  ]);
  const lexical = intersectionRatio(queryTokens, roomTokens);
  const routeRepos = tokenSet(listFrom(options.route?.affectedRepos));
  const roomRepos = tokenSet([room.owner, ...listFrom(room.sourceRepos)]);
  const repoOverlap = intersectionRatio(routeRepos, roomRepos);
  const routeFacetTokens = tokenSet([...(listFrom(options.route?.stems)), ...routeSignals(options.route)]);
  const roomFacetTokens = tokenSet([room.viewpoint, ...listFrom(room.facets), ...listFrom(room.answers)]);
  const facetOverlap = intersectionRatio(routeFacetTokens, roomFacetTokens);
  const indexParts = externalIndexScoreParts(room, options.indexScores);
  const indexSimilarity = indexParts.indexSimilarity;
  const authority = normalizeScore(room.authorityScore, 0.5);
  const freshness = normalizeScore(room.freshnessScore, 0.5);
  const score = (lexical * 0.35)
    + (repoOverlap * 0.2)
    + (facetOverlap * 0.15)
    + (indexSimilarity * 0.15)
    + (authority * 0.1)
    + (freshness * 0.05);
  return {
    roomId: room.id,
    score: Number(score.toFixed(4)),
    parts: {
      lexical: Number(lexical.toFixed(4)),
      repoOverlap: Number(repoOverlap.toFixed(4)),
      facetOverlap: Number(facetOverlap.toFixed(4)),
      indexSimilarity,
      lexicalIndexSimilarity: indexParts.lexicalIndexSimilarity,
      vectorSimilarity: indexParts.vectorSimilarity,
      indexScoreSource: indexParts.indexScoreSource,
      authority,
      freshness,
    },
  };
}

/** Ranks normalized rooms by explainable score with stable label tie-breaking. */
export function rankArchitectureRooms(atlas = {}, options = {}) {
  const model = atlas.roomById instanceof Map ? atlas : normalizeArchitectureAtlas(atlas);
  return model.rooms
    .map((room) => ({
      room,
      ...scoreArchitectureRoom(room, options),
    }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.room.label.localeCompare(right.room.label);
    });
}

/** Returns traversable neighbor steps and records when a bidirectional portal is reversed. */
function adjacentPortals(model, roomId) {
  const direct = model.portalsByRoomId.get(roomId) || [];
  return direct.map((portal) => {
    if (portal.fromRoomId === roomId) return { portal, toRoomId: portal.toRoomId, reversed: false };
    return { portal, toRoomId: portal.fromRoomId, reversed: true };
  });
}

/** Finds the lowest-cost deterministic portal path between two normalized rooms. */
export function findArchitectureRoomPath(atlas = {}, fromRoomId, toRoomId) {
  const model = atlas.roomById instanceof Map ? atlas : normalizeArchitectureAtlas(atlas);
  const from = normalizeOptionalId(fromRoomId);
  const to = normalizeOptionalId(toRoomId);
  if (!model.roomById.has(from) || !model.roomById.has(to)) {
    return { found: false, roomIds: [], portalIds: [], cost: Infinity };
  }
  if (from === to) return { found: true, roomIds: [from], portalIds: [], cost: 0 };

  const queue = [{ roomId: from, cost: 0, roomIds: [from], portalIds: [] }];
  const bestCost = new Map([[from, 0]]);
  while (queue.length) {
    queue.sort((left, right) => left.cost - right.cost || left.roomId.localeCompare(right.roomId));
    const current = queue.shift();
    if (!current) break;
    if (current.roomId === to) return { found: true, roomIds: current.roomIds, portalIds: current.portalIds, cost: current.cost };
    for (const step of adjacentPortals(model, current.roomId)) {
      const nextCost = current.cost + step.portal.traversalCost;
      const known = bestCost.get(step.toRoomId);
      if (known !== undefined && known <= nextCost) continue;
      bestCost.set(step.toRoomId, nextCost);
      queue.push({
        roomId: step.toRoomId,
        cost: nextCost,
        roomIds: [...current.roomIds, step.toRoomId],
        portalIds: [...current.portalIds, step.portal.id],
      });
    }
  }
  return { found: false, roomIds: [], portalIds: [], cost: Infinity };
}

/** Selects ranked room candidates after applying current-room traversal cost penalties. */
export function planArchitectureTraversal(atlas = {}, options = {}) {
  const model = normalizeArchitectureAtlas(atlas);
  const ranked = rankArchitectureRooms(model, options);
  const currentRoomId = normalizeOptionalId(options.currentRoomId);
  const candidates = ranked.slice(0, Math.max(1, Number(options.limit) || 3)).map((candidate) => {
    const path = currentRoomId
      ? findArchitectureRoomPath(model, currentRoomId, candidate.roomId)
      : { found: true, roomIds: [candidate.roomId], portalIds: [], cost: 0 };
    const traversalPenalty = path.found && Number.isFinite(path.cost) ? path.cost * 0.03 : 1;
    return {
      roomId: candidate.roomId,
      label: candidate.room.label,
      owner: candidate.room.owner,
      viewpoint: candidate.room.viewpoint,
      // Ranked candidates carry the provider's room-entry declaration so the
      // Router cannot turn retrieval relevance into navigation authority.
      metadata: {
        entryKind: compactText(candidate.room?.metadata?.entryKind || candidate.room?.entryKind),
        navigationKind: compactText(candidate.room?.metadata?.navigationKind || candidate.room?.navigationKind),
        roomGraphStatus: compactText(candidate.room?.metadata?.roomGraphStatus),
        roomGraphSourceModel: compactText(candidate.room?.metadata?.roomGraphSourceModel),
        roomGraphFreshnessStatus: compactText(
          candidate.room?.metadata?.roomGraphFreshnessStatus || candidate.room?.freshnessStatus,
        ),
        graphEndpoint: compactText(candidate.room?.metadata?.graphEndpoint || candidate.room?.graphEndpoint),
      },
      score: candidate.score,
      finalScore: Number((candidate.score - traversalPenalty).toFixed(4)),
      path,
      reason: candidate.parts,
    };
  }).sort((left, right) => {
    if (right.finalScore !== left.finalScore) return right.finalScore - left.finalScore;
    return left.label.localeCompare(right.label);
  });

  return {
    schema: "multihead-memory-graph.architecture-traversal.v1",
    query: compactText(options.query),
    routeKind: compactText(options.route?.taskKind),
    currentRoomId,
    selected: candidates[0] || null,
    candidates,
    diagnostics: model.diagnostics,
    metrics: model.metrics,
  };
}
