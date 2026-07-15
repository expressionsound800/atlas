/*
 * Graph Layout orchestrates projection normalization, placement, container
 * layout, routing, and final source-neutral view-model assembly.
 */
import {
  graphNodeDimensionsForPresentation,
  normalizeId,
  normalizeKind,
} from "./graph-geometry.js";
import {
  alignGraphNodesToRouteGrid,
  applyGraphNodePositionOverrides,
  normalizedGraphNodePositionOverrides,
} from "./graph-layout-grid.js";
import {
  canonicalGraphContainers,
  compactGraphContainerGroupOutliers,
  distributeGraphNodesWithinContainers,
  separateGraphContainerGroups,
} from "./graph-layout-containers.js";
import {
  applyGraphSemanticPlacement,
  graphNodeUsesRadialGrowth,
  positionBranchNodes,
} from "./graph-layout-positioning.js";
import { graphProjectionSources } from "./graph-projection-sources.js";
import {
  computeGraphSemanticModel,
} from "./graph-semantic.js";
import { normalizeGraphPresentationMode } from "./graph-view-state.js";
import {
  graphPrecomputedViewModelFromProjection,
  normalizeGraphViewModel,
} from "./graph-view-model.js";
import { finalizeIllustrationGraphViewModel } from "./graph-view-model-assembly.js";

const GRAPH_ILLUSTRATION_BASE_ZOOM = 1;
export const GRAPH_ROUTE_MODE_QUALITY = "quality";
export const GRAPH_ROUTE_MODE_SPEED = "speed";
const GRAPH_ROUTE_BUDGET_PREVIEW = "preview";
const GRAPH_ROUTE_BUDGET_VISIBILITY = "visibility";
const GRAPH_BOUNDED_ROUTE_NODE_LIMIT = 18;
const GRAPH_BOUNDED_ROUTE_EDGE_LIMIT = 20;
const GRAPH_PREVIEW_ROUTE_NODE_LIMIT = 54;
const GRAPH_PREVIEW_ROUTE_EDGE_LIMIT = 48;
const GRAPH_PREVIEW_ROUTE_WORK_LIMIT = 1200;

export { graphProjectionSources };

/** Normalizes route mode to the supported quality or speed routing contract. */
export function normalizeGraphRouteMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return mode === GRAPH_ROUTE_MODE_SPEED ? GRAPH_ROUTE_MODE_SPEED : GRAPH_ROUTE_MODE_QUALITY;
}

/** Selects interaction preview, fast visibility, bounded, or quality routing from source-neutral graph workload. */
function graphRouteBudgetForProjection(routeMode, projection = {}) {
  const nodeCount = Array.isArray(projection?.nodes) ? projection.nodes.length : 0;
  const edgeCount = Array.isArray(projection?.edges) ? projection.edges.length : 0;
  const routeWork = nodeCount * edgeCount;
  if (nodeCount > GRAPH_PREVIEW_ROUTE_NODE_LIMIT
    || edgeCount > GRAPH_PREVIEW_ROUTE_EDGE_LIMIT) {
    return GRAPH_ROUTE_BUDGET_PREVIEW;
  }
  if (routeWork > GRAPH_PREVIEW_ROUTE_WORK_LIMIT) return GRAPH_ROUTE_BUDGET_VISIBILITY;
  if (nodeCount > GRAPH_BOUNDED_ROUTE_NODE_LIMIT
    && edgeCount > GRAPH_BOUNDED_ROUTE_EDGE_LIMIT) {
    return "bounded";
  }
  return routeMode === GRAPH_ROUTE_MODE_SPEED ? "bounded" : GRAPH_ROUTE_MODE_QUALITY;
}

const MEMORY_GRAPH_LAYOUT = Object.freeze({
  anchorX: 840,
  anchorY: 600,
  rootColumnGap: 260,
  branchColumnGap: 330,
  branchLaneGap: 118,
  riverColumnGap: 350,
  riverLaneGap: 112,
});

/** Orchestrates semantic placement, grid alignment, containers, routing, and final view-model assembly. */
export function buildIllustrationGraphViewModel(options = {}) {
  const presentationMode = normalizeGraphPresentationMode(options?.presentationMode);
  const selectedNodeId = normalizeId(options?.selectedNodeId);
  const routeMode = normalizeGraphRouteMode(options?.routeMode);
  const routeBudget = graphRouteBudgetForProjection(routeMode, options?.memoryGraph);
  const hasNodePositionOverrides = normalizedGraphNodePositionOverrides(options?.nodePositions).size > 0;
  const precomputedViewModel = options?.disablePrecomputed === true
    ? null
    : options?.precomputedViewModel
      || graphPrecomputedViewModelFromProjection(options?.memoryGraph, { presentationMode });
  const projectionHasRawGraph = Array.isArray(options?.memoryGraph?.nodes)
    && Array.isArray(options?.memoryGraph?.edges);
  if (precomputedViewModel && (!hasNodePositionOverrides || !projectionHasRawGraph)) {
    return normalizeGraphViewModel(precomputedViewModel, {
      presentationMode,
      selectedNodeId,
      routeBudget: "precomputed",
      nodePositions: options?.nodePositions,
    });
  }
  const { nodes: projectionNodes, edges: projectionEdges, containers: projectionContainers = [] } = graphProjectionSources(options?.memoryGraph, {
    containers: Array.isArray(options?.containers) ? options.containers : options?.memoryGraph?.containers,
    placementById: options?.placementById,
    routeBudget,
  });
  const layoutContainers = canonicalGraphContainers(projectionContainers);
  const sourceNodes = projectionNodes.map((node) => {
    const normalizedId = normalizeId(node.id);
    const dimensions = graphNodeDimensionsForPresentation(node, presentationMode);
    return {
      ...node,
      id: normalizedId,
      sourceId: node.id,
      kind: normalizeKind(node.memoryKind || "memory"),
      presentationMode,
      selected: selectedNodeId ? normalizedId === selectedNodeId : false,
      transportEnabled: true,
      ...dimensions,
    };
  });
  const layoutEdges = projectionEdges.map((edge) => ({
    ...edge,
    id: String(edge.id || "").trim(),
    from: normalizeId(edge.from),
    to: normalizeId(edge.to),
    kind: normalizeKind(edge.kind),
    relationshipLabel: String(edge.label || edge.kind || "relationship").trim(),
    enabled: edge.enabled !== false,
  }));
  const semanticModel = computeGraphSemanticModel(sourceNodes, layoutEdges);
  const semanticNodes = applyGraphSemanticPlacement(sourceNodes, layoutEdges, semanticModel, layoutContainers);
  const rootNodes = semanticNodes.filter((node) => node.graphSide === "root");
  const leftNodes = semanticNodes.filter((node) => node.graphSide === "left");
  const rightNodes = semanticNodes.filter((node) => node.graphSide === "right");
  const radialNodes = semanticNodes.filter(graphNodeUsesRadialGrowth);
  const positionedNodes = positionBranchNodes(
    semanticNodes,
    rootNodes,
    leftNodes,
    rightNodes,
    radialNodes,
    MEMORY_GRAPH_LAYOUT,
    layoutEdges,
  );
  const containerDistributedNodes = distributeGraphNodesWithinContainers(
    positionedNodes,
    layoutContainers,
    layoutEdges,
  );
  const gridAlignedNodes = alignGraphNodesToRouteGrid(containerDistributedNodes);
  const spacedGroupNodes = separateGraphContainerGroups(gridAlignedNodes, layoutContainers);
  const manualLayoutNodes = applyGraphNodePositionOverrides(spacedGroupNodes, options?.nodePositions);
  const finalGridAlignedNodes = alignGraphNodesToRouteGrid(manualLayoutNodes);
  const finalSpacedGroupNodes = separateGraphContainerGroups(finalGridAlignedNodes, layoutContainers);
  const finalContainerDistributedNodes = distributeGraphNodesWithinContainers(
    finalSpacedGroupNodes,
    layoutContainers,
    layoutEdges,
  );
  const finalContainerGridNodes = alignGraphNodesToRouteGrid(finalContainerDistributedNodes);
  const finalLayoutNodes = alignGraphNodesToRouteGrid(
    separateGraphContainerGroups(finalContainerGridNodes, layoutContainers),
  );
  const compactedLayoutNodes = compactGraphContainerGroupOutliers(finalLayoutNodes, layoutContainers);
  const finalManualLayoutNodes = applyGraphNodePositionOverrides(compactedLayoutNodes, options?.nodePositions);
  return finalizeIllustrationGraphViewModel(finalManualLayoutNodes, layoutEdges, {
    anchor: {
      x: MEMORY_GRAPH_LAYOUT.anchorX,
      y: MEMORY_GRAPH_LAYOUT.anchorY,
    },
    zoom: GRAPH_ILLUSTRATION_BASE_ZOOM,
    routeBudget,
  }, layoutContainers);
}
