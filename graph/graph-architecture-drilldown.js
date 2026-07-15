/*
 * Architecture Drilldown validates provider route packets and maps eligible
 * room candidates into Graph navigation actions and trail presentation.
 */
import {
  normalizeSourceCategoryId,
} from "./graph-controller-utils.js";
import {
  GRAPH_REPOSITORY_OVERVIEW_NAVIGATION_KIND,
  GRAPH_ROOM_NAVIGATION_KIND,
  graphNodeRepositoryOverviewEligibility,
  graphNodeRoomEntryTargetId,
} from "./graph-navigation.js";

/**
 * Resolves the architecture action represented by one node in the active
 * projection. Semantic components enter another room; a projected repository
 * authority inside a room returns to the overview.
 */
export function supportedArchitectureNavigationForNode(node = {}, options = {}) {
  if (normalizeSourceCategoryId(options.sourceCategory) !== "architecture") return null;
  const roomId = graphNodeRoomEntryTargetId(node, {
    currentRoomId: options.architectureRoomId,
  });
  if (roomId) return Object.freeze({ kind: GRAPH_ROOM_NAVIGATION_KIND, roomId });
  const overview = graphNodeRepositoryOverviewEligibility(node, {
    currentRoomId: options.architectureRoomId,
  });
  return overview.eligible
    ? Object.freeze({
      kind: GRAPH_REPOSITORY_OVERVIEW_NAVIGATION_KIND,
      roomId: "",
      repositoryId: overview.repositoryId,
    })
    : null;
}

/** Resolves a provider-declared semantic room while rejecting evidence records and the active room. */
export function supportedArchitectureRoomIdForNode(node = {}, options = {}) {
  const navigation = supportedArchitectureNavigationForNode(node, options);
  return navigation?.kind === GRAPH_ROOM_NAVIGATION_KIND ? navigation.roomId : "";
}
