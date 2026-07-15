/*
 * Graph Navigation validates provider-declared room-entry contracts before
 * renderers or controllers expose navigation affordances. It classifies only
 * source-neutral contract fields and never promotes source evidence into a room.
 */

export const GRAPH_SEMANTIC_ROOM_ENTRY_KIND = "semantic-room";
export const GRAPH_ROOM_NAVIGATION_KIND = "room-entry";
export const GRAPH_REPOSITORY_AUTHORITY_ENTRY_KIND = "repository-authority";
export const GRAPH_REPOSITORY_OVERVIEW_NAVIGATION_KIND = "repository-overview";

const AVAILABLE_SEMANTIC_ROOM_STATUSES = new Set([
  "available",
  "semantic-room-available",
  "source-derived-room-available",
  "source-derived-topology-available",
]);
const FRESH_ROOM_STATUSES = new Set([
  "current",
  "fresh",
  "source-digest-current",
  "source-validated",
]);
const STRUCTURAL_SOURCE_MODELS = new Set([
  "consumer-repository-catalog",
  "multihead-atlas-default-repository-adapter",
  "multihead-atlas-source-inventory-v1",
  "repository-source-scan",
]);

/** Normalizes provider contract tokens for exact source-neutral comparisons. */
function compactToken(value) {
  return String(value ?? "").trim().toLowerCase();
}

/** Normalizes room identities to the controller's case-insensitive route convention. */
function normalizedRoomId(value) {
  return String(value ?? "").trim().toUpperCase();
}

/** Returns object metadata without allowing primitive provider values into navigation checks. */
function nodeMetadata(node = {}) {
  return node?.metadata && typeof node.metadata === "object" ? node.metadata : {};
}

/** Reads one navigation field from metadata first and its node-level compatibility alias second. */
function navigationField(node = {}, field = "") {
  const metadata = nodeMetadata(node);
  return metadata[field] ?? node?.[field] ?? "";
}

/**
 * Validates one provider-declared room entry and returns a stable denial reason.
 * Source records fail unless the provider explicitly classifies them as a fresh,
 * available semantic room backed by a non-structural model and graph endpoint.
 */
export function graphNodeRoomEntryEligibility(node = {}, options = {}) {
  const targetRoomId = normalizedRoomId(
    navigationField(node, "roomId"),
  );
  const currentRoomId = normalizedRoomId(options.currentRoomId);
  const entryKind = compactToken(navigationField(node, "entryKind"));
  const navigationKind = compactToken(navigationField(node, "navigationKind"));
  const roomGraphStatus = compactToken(navigationField(node, "roomGraphStatus"));
  const roomGraphSourceModel = compactToken(navigationField(node, "roomGraphSourceModel"));
  const roomGraphFreshnessStatus = compactToken(
    navigationField(node, "roomGraphFreshnessStatus")
      || navigationField(node, "freshnessStatus"),
  );
  const graphEndpoint = String(navigationField(node, "graphEndpoint") ?? "").trim();

  let reason = "available-semantic-room";
  if (!targetRoomId) reason = "missing-room-id";
  else if (currentRoomId && targetRoomId === currentRoomId) reason = "current-room";
  else if (entryKind !== GRAPH_SEMANTIC_ROOM_ENTRY_KIND) reason = "not-semantic-room";
  else if (navigationKind !== GRAPH_ROOM_NAVIGATION_KIND) reason = "navigation-not-declared";
  else if (!AVAILABLE_SEMANTIC_ROOM_STATUSES.has(roomGraphStatus)) reason = "room-unavailable";
  else if (!roomGraphSourceModel || STRUCTURAL_SOURCE_MODELS.has(roomGraphSourceModel)) reason = "non-semantic-source-model";
  else if (!FRESH_ROOM_STATUSES.has(roomGraphFreshnessStatus)) reason = "room-not-fresh";
  else if (!graphEndpoint) reason = "missing-graph-endpoint";

  return Object.freeze({
    eligible: reason === "available-semantic-room",
    reason,
    targetRoomId,
    currentRoomId,
    entryKind,
    navigationKind,
    roomGraphStatus,
    roomGraphSourceModel,
    roomGraphFreshnessStatus,
    graphEndpoint,
  });
}

/** Resolves the room target only when the complete provider navigation contract is valid. */
export function graphNodeRoomEntryTargetId(node = {}, options = {}) {
  const eligibility = graphNodeRoomEntryEligibility(node, options);
  return eligibility.eligible ? eligibility.targetRoomId : "";
}

/**
 * Validates an authority node that returns from a semantic room to its owning
 * repository overview. The provider must declare this on the room projection;
 * an authority rendered on the overview remains inert.
 */
export function graphNodeRepositoryOverviewEligibility(node = {}, options = {}) {
  const repositoryId = normalizedRoomId(navigationField(node, "repositoryId"));
  const roomId = normalizedRoomId(navigationField(node, "roomId"));
  const currentRoomId = normalizedRoomId(options.currentRoomId);
  const entryKind = compactToken(navigationField(node, "entryKind"));
  const navigationKind = compactToken(navigationField(node, "navigationKind"));
  const repositoryOverviewStatus = compactToken(navigationField(node, "repositoryOverviewStatus"));
  const repositoryOverviewEndpoint = String(
    navigationField(node, "repositoryOverviewEndpoint") ?? "",
  ).trim();

  let reason = "available-repository-overview";
  if (!currentRoomId || currentRoomId === repositoryId) reason = "overview-already-active";
  else if (!repositoryId) reason = "missing-repository-id";
  else if (!roomId || roomId !== repositoryId) reason = "authority-id-mismatch";
  else if (entryKind !== GRAPH_REPOSITORY_AUTHORITY_ENTRY_KIND) reason = "not-repository-authority";
  else if (navigationKind !== GRAPH_REPOSITORY_OVERVIEW_NAVIGATION_KIND) reason = "overview-navigation-not-declared";
  else if (repositoryOverviewStatus !== "available") reason = "repository-overview-unavailable";
  else if (!/^\/api\/[a-z0-9-]+$/u.test(repositoryOverviewEndpoint)) reason = "invalid-repository-overview-endpoint";

  return Object.freeze({
    eligible: reason === "available-repository-overview",
    reason,
    repositoryId,
    roomId,
    currentRoomId,
    entryKind,
    navigationKind,
    repositoryOverviewStatus,
    repositoryOverviewEndpoint,
  });
}

/** Resolves a requested room only when a current projection declares an eligible matching target. */
export function graphProjectionRoomEntryTargetId(projection = {}, requestedRoomId = "", options = {}) {
  const requested = normalizedRoomId(requestedRoomId);
  if (!requested) return "";
  const nodes = Array.isArray(projection?.nodes) ? projection.nodes : [];
  const candidates = Array.isArray(projection?.metadata?.architectureAtlas?.plan?.candidates)
    ? projection.metadata.architectureAtlas.plan.candidates
    : [];
  for (const candidate of [...nodes, ...candidates]) {
    const target = graphNodeRoomEntryTargetId(candidate, options);
    if (target === requested) return target;
  }
  return "";
}
