/*
 * Layout Positioning assigns topology-driven layers, semantic centers, lanes,
 * and component offsets without accepting provider-authored coordinates.
 */
import { graphNodeContainerMembership } from "./graph-container-routing.js";
import {
  NODE_MIN_WIDTH,
  ORIGIN_X,
  ORIGIN_Y,
  clampNumber,
  compareGraphNodes,
  compareIds,
  graphAngleDegForGraphSide,
  graphNodeHeight,
  graphNodeWidth,
  graphVectorFromAngleDeg,
  normalizeId,
  normalizeKind,
} from "./graph-geometry.js";
import {
  graphSemanticScoreForNode,
} from "./graph-semantic.js";
import { applyContainerLocalFlowPlacement } from "./graph-layout-flow.js";
import {
  isRootGraphNode,
  normalizeGraphNodeOrigin,
  rebalanceBranchNodeVerticalSpread,
  separateOverlappingGraphNodes,
} from "./graph-layout-grid.js";

const RIVER_MIN_COLUMN_GAP = 58;
const RIVER_LANE_GAP = 92;
const SEMANTIC_CLUSTER_MIN_BAND = 2.2;
const SEMANTIC_CLUSTER_ENTRY_PITCH = 0.82;
const SEMANTIC_CLUSTER_GUTTER = 0.8;
const SEMANTIC_CLUSTER_COLUMN_STEP = 1;
const SEMANTIC_DENSE_CONTAINER_MIN_ENTRIES = 8;

/** Assigns causal depth columns and parent-weighted lanes for one directed branch stream. */
function temporalRiverGraphLayout(nodes, edges) {
  const nodeList = [...(Array.isArray(nodes) ? nodes : [])].sort(compareGraphNodes);
  const nodeById = new Map(nodeList.map((node) => [node.id, node]));
  const nodeIds = nodeList.map((node) => node.id);
  const incoming = new Map(nodeIds.map((id) => [id, []]));
  const seenPairs = new Set();

  for (const edge of Array.isArray(edges) ? edges : []) {
    const from = normalizeId(edge?.from);
    const to = normalizeId(edge?.to);
    if (!from || !to || from === to || !nodeById.has(from) || !nodeById.has(to)) continue;
    const pairKey = `${from}->${to}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);
    incoming.get(to).push({ from, kind: normalizeKind(edge?.kind) });
  }

  /** Maps relationship kind to its influence on causal depth and stream alignment. */
  const edgeWeight = (kind) => {
    if (kind === "timing") return 6;
    if (kind === "control") return 8;
    if (kind === "binding") return 2;
    return 1;
  };
  const depthById = new Map();
  /** Computes maximum parent depth with cycle protection and memoized node results. */
  function depthForNode(id, visiting = new Set()) {
    if (depthById.has(id)) return depthById.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const parentEdges = [...(incoming.get(id) || [])]
      .sort((left, right) => edgeWeight(right.kind) - edgeWeight(left.kind)
        || compareIds(left.from, right.from));
    if (!parentEdges.length) {
      depthById.set(id, 0);
      visiting.delete(id);
      return 0;
    }
    let depth = 0;
    for (const edge of parentEdges) {
      depth = Math.max(depth, depthForNode(edge.from, visiting) + 1);
    }
    visiting.delete(id);
    depthById.set(id, Math.min(nodeIds.length, depth));
    return depthById.get(id);
  }
  for (const id of nodeIds) depthForNode(id);

  const columns = new Map();
  for (const node of nodeList) {
    const depth = depthById.get(node.id) || 0;
    if (!columns.has(depth)) columns.set(depth, []);
    columns.get(depth).push(node);
  }

  const sortedDepths = [...columns.keys()].sort((left, right) => left - right);
  const columnMaxWidth = new Map(sortedDepths.map((depth) => [
    depth,
    Math.max(NODE_MIN_WIDTH, ...(columns.get(depth) || []).map(graphNodeWidth)),
  ]));
  const incomingEdges = [];
  for (const [to, parentEdges] of incoming.entries()) {
    const toDepth = depthById.get(to) || 0;
    for (const edge of parentEdges) {
      const fromDepth = depthById.get(edge.from) || 0;
      if (fromDepth >= toDepth) continue;
      incomingEdges.push({
        ...edge,
        to,
        fromDepth,
        toDepth,
      });
    }
  }
  /** Computes extra horizontal clearance from crossing, arrival, join, and column pressure. */
  const columnGapAfter = (depth, nextDepth) => {
    const crossingEdges = incomingEdges.filter((edge) =>
      edge.fromDepth <= depth && edge.toDepth >= nextDepth
    );
    const arrivals = incomingEdges.filter((edge) => edge.toDepth === nextDepth);
    const joinCount = (columns.get(nextDepth) || [])
      .filter((node) => (incoming.get(node.id) || []).length > 1)
      .length;
    const rightColumnSize = (columns.get(nextDepth) || []).length;
    const pressure = Math.max(0, crossingEdges.length - 3) * 8
      + Math.max(0, arrivals.length - 3) * 6
      + Math.max(0, rightColumnSize - 2) * 8
      + joinCount * 14;
    const skippedDepths = Math.max(0, nextDepth - depth - 1);
    return RIVER_MIN_COLUMN_GAP
      + clampNumber(pressure, 0, 84)
      + skippedDepths * RIVER_MIN_COLUMN_GAP;
  };
  const xByDepth = new Map();
  let nextColumnX = ORIGIN_X;
  sortedDepths.forEach((depth, index) => {
    xByDepth.set(depth, nextColumnX);
    const nextDepth = sortedDepths[index + 1];
    if (Number.isFinite(nextDepth)) {
      nextColumnX += columnMaxWidth.get(depth) + columnGapAfter(depth, nextDepth);
    }
  });

  const positions = new Map();
  for (const depth of sortedDepths) {
    const columnNodes = [...(columns.get(depth) || [])].sort((left, right) => {
      /** Computes the relationship-weighted parent lane used to order one column's nodes. */
      const streamCenter = (node) => {
        const parentEdges = incoming.get(node.id) || [];
        let weightedTotal = 0;
        let weightTotal = 0;
        for (const edge of parentEdges) {
          const parentPosition = positions.get(edge.from);
          if (!parentPosition) continue;
          const weight = edgeWeight(edge.kind);
          weightedTotal += parentPosition.y * weight;
          weightTotal += weight;
        }
        return weightTotal > 0 ? weightedTotal / weightTotal : Number.POSITIVE_INFINITY;
      };
      const leftStreamCenter = streamCenter(left);
      const rightStreamCenter = streamCenter(right);
      if (leftStreamCenter !== rightStreamCenter) return leftStreamCenter - rightStreamCenter;
      return compareGraphNodes(left, right);
    });

    let nextY = ORIGIN_Y;
    columnNodes.forEach((node, index) => {
      const parentEdges = incoming.get(node.id) || [];
      let weightedParentTotal = 0;
      let weightedParentWeight = 0;
      for (const edge of parentEdges) {
        const parentY = positions.get(edge.from)?.y;
        if (!Number.isFinite(parentY)) continue;
        const weight = edgeWeight(edge.kind);
        weightedParentTotal += parentY * weight;
        weightedParentWeight += weight;
      }
      const desiredY = weightedParentWeight > 0
        ? weightedParentTotal / weightedParentWeight
        : ORIGIN_Y + index * RIVER_LANE_GAP;
      const joinLaneOffset = parentEdges.length > 1 ? RIVER_LANE_GAP : 0;
      const y = Math.max(nextY, Math.round(desiredY + joinLaneOffset));
      positions.set(node.id, {
        x: xByDepth.get(depth) || ORIGIN_X,
        y,
      });
      nextY = y + RIVER_LANE_GAP;
    });
  }

  return positions;
}

/** Checks whether a node requests radial placement through side or explicit angle metadata. */
export function graphNodeUsesRadialGrowth(node = {}) {
  return node?.graphSide === "radial" || Number.isFinite(Number(node?.graphAngleDeg));
}

/** Checks whether semantic placement assigned a concrete branch column to a node. */
function graphNodeUsesExplicitColumnLayout(node = {}) {
  return Number.isFinite(Number(node?.graphColumn));
}

/** Resolves explicit node angle before deriving the default angle from graph side. */
function graphNodeAngleDeg(node = {}) {
  if (Number.isFinite(Number(node?.graphAngleDeg))) return Number(node.graphAngleDeg);
  return graphAngleDegForGraphSide(node?.graphSide);
}

/** Reads one finite layout tuning value while retaining the subsystem fallback. */
function graphLayoutNumber(layout = {}, key, fallback) {
  const number = Number(layout[key]);
  return Number.isFinite(number) ? number : fallback;
}

/** Builds deterministic forward or reverse adjacency limited to valid positioned nodes. */
function graphEdgeAdjacency(nodes = [], edges = [], reverse = false) {
  const nodeIds = new Set((Array.isArray(nodes) ? nodes : []).map((node) => normalizeId(node?.id)).filter(Boolean));
  const adjacency = new Map([...nodeIds].map((id) => [id, []]));
  for (const edge of Array.isArray(edges) ? edges : []) {
    const from = normalizeId(edge?.from);
    const to = normalizeId(edge?.to);
    if (!nodeIds.has(from) || !nodeIds.has(to) || from === to) continue;
    const sourceId = reverse ? to : from;
    const targetId = reverse ? from : to;
    adjacency.get(sourceId).push({
      from: sourceId,
      to: targetId,
      kind: normalizeKind(edge?.kind || "relationship"),
    });
  }
  for (const edgesForNode of adjacency.values()) {
    edgesForNode.sort((left, right) => compareIds(left.to, right.to) || compareIds(left.kind, right.kind));
  }
  return adjacency;
}

/** Computes unweighted hop distance from one or more semantic center nodes. */
function graphDistanceMap(startIds = [], adjacency = new Map()) {
  const distances = new Map();
  const queue = [];
  for (const id of sortedUniqueGraphIds(startIds)) {
    if (!adjacency.has(id)) continue;
    distances.set(id, 0);
    queue.push(id);
  }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const id = queue[cursor];
    const distance = distances.get(id) || 0;
    for (const edge of adjacency.get(id) || []) {
      if (distances.has(edge.to)) continue;
      distances.set(edge.to, distance + 1);
      queue.push(edge.to);
    }
  }
  return distances;
}

/** Normalizes, deduplicates, and sorts graph identifiers for stable placement decisions. */
function sortedUniqueGraphIds(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(normalizeId)
    .filter(Boolean))]
    .sort(compareIds);
}

/** Maps sequential cluster order to alternating lanes around the vertical center. */
function graphBalancedLane(index) {
  if (index <= 0) return 0;
  const offset = Math.ceil(index / 2);
  return index % 2 === 1 ? -offset : offset;
}

/** Maps semantic roles to deterministic cluster ordering around the convergence center. */
function graphSemanticRolePriority(role = "") {
  if (role === "conversion-hub") return 0;
  if (role === "growth-source") return 1;
  if (role === "convergence") return 2;
  if (role === "bridge") return 3;
  return 4;
}

/** Returns a recorded semantic hop distance or positive infinity when unreachable. */
function finiteDistance(map = new Map(), id = "") {
  const distance = map.get(normalizeId(id));
  return Number.isFinite(distance) ? distance : Infinity;
}

/** Selects root, source-side, or output-side placement from role scores and reachability. */
function graphSemanticPlacementSide(node = {}, score = {}, distances = {}) {
  const id = normalizeId(node.id);
  if (id && id === distances.primaryConvergenceId) return "root";
  if (distances.sourceCenterIds.has(id)) return "left";
  const fromConvergence = finiteDistance(distances.fromConvergence, id);
  const toConvergence = finiteDistance(distances.toConvergence, id);
  const fromSource = finiteDistance(distances.fromSource, id);
  const sourceScore = Number(score?.sourceScore) || 0;
  const convergenceScore = Number(score?.convergenceScore) || 0;

  if (Number.isFinite(toConvergence) && (!Number.isFinite(fromConvergence) || sourceScore >= convergenceScore)) {
    return "left";
  }
  if (Number.isFinite(fromConvergence)) return "right";
  if (Number.isFinite(fromSource) && sourceScore >= convergenceScore) return "left";
  return sourceScore > convergenceScore * 1.08 ? "left" : "right";
}

/** Selects a bounded branch column from hop distance to or from semantic convergence. */
function graphSemanticPlacementColumn(node = {}, side = "right", distances = {}) {
  const id = normalizeId(node.id);
  if (side === "root") return 0;
  if (side === "left") {
    const toConvergence = finiteDistance(distances.toConvergence, id);
    return Math.max(1, Math.min(4, Number.isFinite(toConvergence) ? toConvergence : 2));
  }
  const fromConvergence = finiteDistance(distances.fromConvergence, id);
  return Math.max(1, Math.min(4, Number.isFinite(fromConvergence) ? fromConvergence : 2));
}

/** Orders semantic clusters by role, center score, and stable normalized identifier. */
function graphSemanticClusterSort(left, right) {
  const roleDelta = graphSemanticRolePriority(left.role) - graphSemanticRolePriority(right.role);
  if (roleDelta !== 0) return roleDelta;
  const scoreDelta = Number(right.score || 0) - Number(left.score || 0);
  if (Math.abs(scoreDelta) > 0.0001) return scoreDelta;
  return compareIds(left.id, right.id);
}

/** Measures one semantic cluster's lane footprint from its entry count without borrowing another cluster's size. */
function graphSemanticClusterBand(cluster = {}) {
  return Math.max(
    SEMANTIC_CLUSTER_MIN_BAND,
    1.25 + (Array.isArray(cluster.entries) ? cluster.entries.length : 0) * SEMANTIC_CLUSTER_ENTRY_PITCH,
  );
}

/** Returns alternating signed lane centers whose neighboring band extents stay separated by the cluster gutter. */
function graphAlternatingClusterCenters(bands = []) {
  if (!bands.length) return [];
  const centers = [0];
  let upperExtent = Number(bands[0] || 0) / 2;
  let lowerExtent = upperExtent;
  for (let index = 1; index < bands.length; index += 1) {
    const halfBand = Number(bands[index] || 0) / 2;
    if (graphBalancedLane(index) < 0) {
      centers[index] = -(upperExtent + SEMANTIC_CLUSTER_GUTTER + halfBand);
      upperExtent += SEMANTIC_CLUSTER_GUTTER + halfBand * 2;
    } else {
      centers[index] = lowerExtent + SEMANTIC_CLUSTER_GUTTER + halfBand;
      lowerExtent += SEMANTIC_CLUSTER_GUTTER + halfBand * 2;
    }
  }
  return centers;
}

/** Centers variable-height cluster rows while preserving the same explicit gutter between adjacent row extents. */
function graphCenteredClusterRowCenters(rowBands = []) {
  const totalBand = rowBands.reduce((sum, band) => sum + Number(band || 0), 0)
    + Math.max(0, rowBands.length - 1) * SEMANTIC_CLUSTER_GUTTER;
  let cursor = -totalBand / 2;
  return rowBands.map((band) => {
    const numericBand = Number(band || 0);
    const center = cursor + numericBand / 2;
    cursor += numericBand + SEMANTIC_CLUSTER_GUTTER;
    return center;
  });
}

/** Returns per-cluster lane centers from independent column packs, preventing one column's height from spacing another. */
function graphColumnPackedClusterCenters(clusterBands = [], clusterColumns = 1) {
  const centers = [];
  for (let columnIndex = 0; columnIndex < clusterColumns; columnIndex += 1) {
    const clusterIndices = [];
    for (let clusterIndex = columnIndex; clusterIndex < clusterBands.length; clusterIndex += clusterColumns) {
      clusterIndices.push(clusterIndex);
    }
    const columnCenters = graphCenteredClusterRowCenters(
      clusterIndices.map((clusterIndex) => clusterBands[clusterIndex]),
    );
    clusterIndices.forEach((clusterIndex, rowIndex) => {
      centers[clusterIndex] = columnCenters[rowIndex];
    });
  }
  return centers;
}

/** Chooses a shared container side from aggregate source, convergence, and bridge pressure. */
function graphSemanticContainerSide(entries = [], primaryConvergenceId = "") {
  if (entries.some((entry) => normalizeId(entry.node.id) === primaryConvergenceId)) return "root";
  const totals = entries.reduce((sum, entry) => ({
    source: sum.source + Number(entry.node.graphSemantic?.sourceScore || 0),
    convergence: sum.convergence + Number(entry.node.graphSemantic?.convergenceScore || 0),
    bridge: sum.bridge + Number(entry.node.graphSemantic?.bridgeScore || 0),
  }), { source: 0, convergence: 0, bridge: 0 });
  if (totals.source >= totals.convergence * 1.04 && totals.source >= totals.bridge * 0.82) return "left";
  return "right";
}

/** Chooses a role-first column and preserves topology depth only when a dense container needs additional visual bands. */
function graphSemanticContainerColumn(node = {}, side = "right", preserveTopologyDepth = false) {
  const score = node.graphSemantic || {};
  const role = String(node.semanticRole || "");
  const topologyColumn = Math.max(1, Math.min(4, Number(node.graphColumn || 2)));
  if (side === "left") {
    if (role === "growth-source" || Number(score.sourceScore || 0) >= Number(score.convergenceScore || 0)) return 1;
    return preserveTopologyDepth ? Math.max(2, topologyColumn) : 2;
  }
  if (role === "conversion-hub" || role === "bridge") return 1;
  if (role === "growth-source" && Number(score.sourceScore || 0) > Number(score.convergenceScore || 0)) return 1;
  return preserveTopologyDepth ? Math.max(2, topologyColumn) : 2;
}

/** Applies topology-derived sides, columns, lanes, and inspectable role evidence to nodes. */
export function applyGraphSemanticPlacement(nodes = [], edges = [], semanticModel = {}, containers = []) {
  if (!Array.isArray(nodes) || !nodes.length) return nodes;
  const containerByNodeId = graphNodeContainerMembership(containers);
  const fallbackRootId = normalizeId(nodes.find(isRootGraphNode)?.id || nodes[0]?.id);
  const primaryConvergenceId = normalizeId(semanticModel.primaryConvergence?.id);
  const primaryGrowthSourceId = normalizeId(semanticModel.primaryGrowthSource?.id);
  const semanticRootId = primaryConvergenceId || primaryGrowthSourceId || fallbackRootId;
  const primarySourceScore = Number(semanticModel.primaryGrowthSource?.sourceScore) || 0;
  const sourceCenterIds = new Set(
    sortedUniqueGraphIds((semanticModel.centerpieces || [])
      .filter((score) => score.semanticRole === "growth-source"
        && Number(score.sourceScore || 0) >= Math.max(0.42, primarySourceScore * 0.78))
      .map((score) => score.id)
      .filter((id) => normalizeId(id) !== semanticRootId)),
  );
  if (primaryGrowthSourceId && primaryGrowthSourceId !== semanticRootId) {
    sourceCenterIds.add(primaryGrowthSourceId);
  }

  const outgoing = graphEdgeAdjacency(nodes, edges, false);
  const reverse = graphEdgeAdjacency(nodes, edges, true);
  const distances = {
    primaryConvergenceId: semanticRootId,
    sourceCenterIds,
    fromSource: graphDistanceMap([...sourceCenterIds], outgoing),
    fromConvergence: graphDistanceMap([semanticRootId], outgoing),
    toConvergence: graphDistanceMap([semanticRootId], reverse),
  };
  const nextNodes = nodes.map((node) => {
    const score = graphSemanticScoreForNode(semanticModel, node.id) || {};
    const semanticSide = graphSemanticPlacementSide(node, score, distances);
    const semanticColumn = graphSemanticPlacementColumn(node, semanticSide, distances);
    return {
      ...node,
      graphSemantic: score,
      semanticRole: score.semanticRole || "peripheral",
      semanticCenterScore: Number(score.centerScore) || 0,
      semanticJustification: score.semanticReason || "",
      graphSide: semanticSide,
      graphColumn: semanticColumn || undefined,
      graphLane: undefined,
      graphRole: semanticSide === "root" ? "root" : "branch",
    };
  });

  const nodeEntriesById = new Map(nextNodes.map((node, index) => [normalizeId(node.id), { node, index }]));
  for (const container of Array.isArray(containers) ? containers : []) {
    const topologyEntries = (Array.isArray(container.nodeIds) ? container.nodeIds : [])
      .map((id) => nodeEntriesById.get(normalizeId(id)))
      .filter(Boolean);
    const entries = topologyEntries.filter((entry) => entry.node.graphSide !== "root");
    if (entries.length < 2) continue;
    const containerSide = graphSemanticContainerSide(entries, primaryConvergenceId);
    if (containerSide === "root") continue;
    const preserveTopologyDepth = entries.length >= SEMANTIC_DENSE_CONTAINER_MIN_ENTRIES;
    entries.forEach((entry) => {
      entry.node.graphSide = containerSide;
      entry.node.graphColumn = graphSemanticContainerColumn(entry.node, containerSide, preserveTopologyDepth);
      entry.node.graphRole = "branch";
    });
    applyContainerLocalFlowPlacement(entries, edges, {
      containerId: container.id,
      side: containerSide,
      topologyEntries,
    });
  }

  const sideGroups = new Map();
  nextNodes.forEach((node, index) => {
    if (node.graphSide === "root") return;
    const key = node.graphSide || "right";
    if (!sideGroups.has(key)) sideGroups.set(key, []);
    sideGroups.get(key).push({ node, index });
  });

  for (const group of sideGroups.values()) {
    const clustersById = new Map();
    for (const entry of group) {
      const clusterId = containerByNodeId.get(normalizeId(entry.node.id)) || normalizeId(entry.node.id);
      if (!clustersById.has(clusterId)) {
        clustersById.set(clusterId, {
          id: clusterId,
          role: entry.node.semanticRole,
          score: Number(entry.node.semanticCenterScore || 0),
          entries: [],
        });
      }
      const cluster = clustersById.get(clusterId);
      cluster.entries.push(entry);
      if (Number(entry.node.semanticCenterScore || 0) > cluster.score) {
        cluster.score = Number(entry.node.semanticCenterScore || 0);
        cluster.role = entry.node.semanticRole;
      }
    }
    const clusters = [...clustersById.values()].sort(graphSemanticClusterSort);
    const clusterBands = clusters.map(graphSemanticClusterBand);
    const splitIntoColumns = clusters.length > 3;
    const clusterColumns = splitIntoColumns ? Math.ceil(Math.sqrt(clusters.length)) : 1;
    const clusterCenters = splitIntoColumns
      ? graphColumnPackedClusterCenters(clusterBands, clusterColumns)
      : graphAlternatingClusterCenters(clusterBands);
    clusters.forEach((cluster, clusterIndex) => {
      const clusterGridColumn = splitIntoColumns ? clusterIndex % clusterColumns : 0;
      const clusterCenter = clusterCenters[clusterIndex];
      cluster.entries.sort((left, right) => {
        const columnDelta = Number(left.node.graphColumn || 1) - Number(right.node.graphColumn || 1);
        if (columnDelta !== 0) return columnDelta;
        const scoreDelta = Number(right.node.semanticCenterScore || 0) - Number(left.node.semanticCenterScore || 0);
        if (Math.abs(scoreDelta) > 0.0001) return scoreDelta;
        return compareGraphNodes(left.node, right.node);
      });
      cluster.entries.forEach(({ node }, entryIndex) => {
        if (clusterGridColumn > 0) {
          node.graphColumn = Math.max(
            1,
            Number(node.graphColumn || 1) + clusterGridColumn * SEMANTIC_CLUSTER_COLUMN_STEP,
          );
        }
        const localFlowLane = Number(node.containerFlowLane);
        node.graphLane = clusterCenter + (Number.isFinite(localFlowLane)
          ? localFlowLane
          : graphBalancedLane(entryIndex)) * SEMANTIC_CLUSTER_ENTRY_PITCH;
      });
    });
  }

  return nextNodes;
}

/** Computes the aggregate root center used as the origin for radial child placement. */
function graphRootReferenceFromNodes(nodes, layout) {
  const rootNodes = (Array.isArray(nodes) ? nodes : []).filter(isRootGraphNode);
  if (!rootNodes.length) return { x: layout.anchorX, y: layout.anchorY };
  return rootNodes.reduce((sum, node) => ({
    x: sum.x + Number(node.x || 0) + graphNodeWidth(node) / 2,
    y: sum.y + Number(node.y || 0) + graphNodeHeight(node) / 2,
  }), { x: 0, y: 0 });
}

/** Positions radial nodes at angle-and-radius offsets around the computed root center. */
function positionRadialGrowthNodes(radialNodes, baseNodes, layout) {
  if (!radialNodes.length) return [];
  const rootReferenceTotal = graphRootReferenceFromNodes(baseNodes, layout);
  const rootCount = Math.max(1, baseNodes.filter(isRootGraphNode).length);
  const rootReference = {
    x: rootReferenceTotal.x / rootCount,
    y: rootReferenceTotal.y / rootCount,
  };
  return radialNodes.map((node) => {
    const vector = graphVectorFromAngleDeg(graphNodeAngleDeg(node));
    const radius = Math.max(1, Number(node?.graphRadius) || 220);
    const centerX = rootReference.x + vector.x * radius;
    const centerY = rootReference.y + vector.y * radius;
    return {
      ...node,
      x: Math.round(centerX - graphNodeWidth(node) / 2),
      y: Math.round(centerY - graphNodeHeight(node) / 2),
      positionSource: "radial-growth",
    };
  });
}

/** Positions root, explicit-column, temporal-stream, and radial nodes into one collision-free layout. */
export function positionBranchNodes(nodes, rootNodes, leftNodes, rightNodes, radialNodes, layout, layoutEdges) {
  const positionById = new Map();
  const rootGap = 44;
  const normalizedRootNodes = rootNodes.filter(Boolean);
  normalizedRootNodes.forEach((node, index) => {
    const rootWidth = graphNodeWidth(node);
    positionById.set(node.id, {
      x: Math.round(layout.anchorX - rootWidth / 2),
      y: Math.round(layout.anchorY + (index - (normalizedRootNodes.length - 1) / 2) * rootGap),
    });
  });
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const rootPositionAverage = normalizedRootNodes.reduce((sum, node) => {
    const position = positionById.get(node.id);
    return {
      x: sum.x + (position.x + graphNodeWidth(node) / 2),
      y: sum.y + position.y,
    };
  }, { x: 0, y: 0 });
  const rootReference = normalizedRootNodes.length
    ? {
      x: rootPositionAverage.x / normalizedRootNodes.length,
      y: rootPositionAverage.y / normalizedRootNodes.length,
    }
    : { x: layout.anchorX, y: layout.anchorY };

  /** Positions one branch side by reflecting its temporal river around the root reference. */
  const positionSide = (sideNodes, side) => {
    if (!sideNodes.length || !normalizedRootNodes.length) return;
    const xScale = graphLayoutNumber(layout, side === "left" ? "leftXScale" : "rightXScale", 1);
    const yScale = graphLayoutNumber(layout, side === "left" ? "leftYScale" : "rightYScale", 1);
    const yOffset = graphLayoutNumber(layout, side === "left" ? "leftYOffset" : "rightYOffset", 0);
    const sideNodeIds = new Set(sideNodes.map((node) => node.id));
    const rootNodeIds = new Set(normalizedRootNodes.map((node) => node.id));
    const sideEdges = layoutEdges.filter((edge) =>
      sideNodeIds.has(edge.to) && (rootNodeIds.has(edge.from) || sideNodeIds.has(edge.from))
    );
    const sideLayoutNodes = [...normalizedRootNodes, ...sideNodes].filter(Boolean);
    const sidePositions = temporalRiverGraphLayout(sideLayoutNodes, sideEdges);
    const sourceRootPositions = normalizedRootNodes
      .map((node) => {
        const position = sidePositions.get(node.id);
        if (!position) return null;
        return {
          x: position.x + graphNodeWidth(node) / 2,
          y: position.y,
        };
      })
      .filter(Boolean);
    const sourceReference = sourceRootPositions.length
      ? sourceRootPositions.reduce((sum, position) => ({
        x: sum.x + position.x,
        y: sum.y + position.y,
      }), { x: 0, y: 0 })
      : { x: ORIGIN_X, y: ORIGIN_Y };
    sourceReference.x /= Math.max(1, sourceRootPositions.length);
    sourceReference.y /= Math.max(1, sourceRootPositions.length);
    sideNodes.forEach((node) => {
      const positionedNode = nodeById.get(node.id);
      const position = sidePositions.get(node.id);
      if (!positionedNode || !position) return;
      const positionedNodeWidth = graphNodeWidth(positionedNode);
      const nodeCenterX = position.x + positionedNodeWidth / 2;
      const deltaX = nodeCenterX - sourceReference.x;
      const deltaY = position.y - sourceReference.y;
      const centerX = rootReference.x + (side === "left" ? -deltaX * xScale : deltaX * xScale);
      positionById.set(node.id, {
        x: Math.round(centerX - positionedNodeWidth / 2),
        y: Math.round(rootReference.y + deltaY * yScale + yOffset),
      });
    });
  };

  /** Positions one semantic side directly from explicit columns and balanced lane coordinates. */
  const positionExplicitSide = (sideNodes, side) => {
    if (!sideNodes.length || !normalizedRootNodes.length) return;
    const direction = side === "left" ? -1 : 1;
    const xScale = graphLayoutNumber(layout, side === "left" ? "leftXScale" : "rightXScale", 1);
    const yScale = graphLayoutNumber(layout, side === "left" ? "leftYScale" : "rightYScale", 1);
    const yOffset = graphLayoutNumber(layout, side === "left" ? "leftYOffset" : "rightYOffset", 0);
    const columnGap = side === "left" ? 330 : 318;
    const laneGap = 106;
    const lanes = sideNodes
      .map((node) => Number(node?.graphLane))
      .filter(Number.isFinite);
    const laneCenter = lanes.length
      ? (Math.min(...lanes) + Math.max(...lanes)) / 2
      : 0;
    sideNodes.forEach((node, index) => {
      const positionedNode = nodeById.get(node.id);
      if (!positionedNode) return;
      const column = Math.max(1, Number(positionedNode?.graphColumn) || 1);
      const lane = Number.isFinite(Number(positionedNode?.graphLane))
        ? Number(positionedNode.graphLane)
        : index;
      const positionedNodeWidth = graphNodeWidth(positionedNode);
      const centerX = rootReference.x + direction * column * columnGap * xScale;
      positionById.set(node.id, {
        x: Math.round(centerX - positionedNodeWidth / 2),
        y: Math.round(rootReference.y + (lane - laneCenter) * laneGap * yScale + yOffset),
      });
    });
  };

  if (leftNodes.some(graphNodeUsesExplicitColumnLayout)) {
    positionExplicitSide(leftNodes, "left");
  } else {
    positionSide(leftNodes, "left");
  }
  if (rightNodes.some(graphNodeUsesExplicitColumnLayout)) {
    positionExplicitSide(rightNodes, "right");
  } else {
    positionSide(rightNodes, "right");
  }

  const baselineNodes = nodes.filter((node) => !graphNodeUsesRadialGrowth(node));
  const positionedNodes = separateOverlappingGraphNodes(baselineNodes.map((node) => ({
    ...node,
    ...(positionById.get(node.id) || { x: ORIGIN_X, y: ORIGIN_Y }),
    positionSource: "branch-anchor",
  })));
  const baselinePositioned = normalizeGraphNodeOrigin(rebalanceBranchNodeVerticalSpread(positionedNodes));
  const allPositioned = [
    ...baselinePositioned,
    ...positionRadialGrowthNodes(radialNodes, baselinePositioned, layout),
  ];
  return normalizeGraphNodeOrigin(separateOverlappingGraphNodes(allPositioned));
}
