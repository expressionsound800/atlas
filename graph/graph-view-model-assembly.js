/*
 * View Model Assembly combines positioned nodes, containers, routed edges,
 * active-chain markers, normalized content, and final surface dimensions.
 */
import { graphActiveChain } from "./graph-active-chain.js";
import {
  resolveCompoundEdgeRouting,
} from "./graph-container-routing.js";
import {
  EDGE_LABEL_HEIGHT,
  EDGE_LABEL_WIDTH,
  applyGraphConnectionMarkers,
  edgeLabelVisible,
  graphNodeHeight,
  graphNodeWidth,
  graphPathBounds,
  graphVisibleContentBounds,
  normalizeId,
  resolveEdgeLabelCollisions,
  resolveNodeRepeatLabelCollisions,
} from "./graph-geometry.js";
import {
  GRAPH_ROUTE_GRID_CELL,
  buildGraphRouteGrid,
} from "./graph-grid.js";
import { layoutGraphContainers } from "./graph-layout-containers.js";
import { resolveGridRoutedEdgeGeometries } from "./graph-router.js";

const GRAPH_ILLUSTRATION_BASE_ZOOM = 1;
const GRAPH_ROUTE_MODE_QUALITY = "quality";
const GRAPH_ROUTE_GRID_TARGET_CELLS = 18000;
const GRAPH_ROUTE_GRID_MAX_CELL_SIZE = GRAPH_ROUTE_GRID_CELL * 3;
const GRAPH_ROUTE_GRID_SNAPSHOT_MIN_COST = 18;

/** Builds a route grid whose padding expands only when obstacle density requires it. */
function buildAdaptiveGraphRouteGrid(nodes = [], containers = []) {
  const fineGrid = buildGraphRouteGrid(nodes, containers);
  const fineCellCount = fineGrid.cols * fineGrid.rows;
  if (fineCellCount <= GRAPH_ROUTE_GRID_TARGET_CELLS) return fineGrid;
  const scale = Math.max(2, Math.ceil(Math.sqrt(fineCellCount / GRAPH_ROUTE_GRID_TARGET_CELLS)));
  const cellSize = Math.min(GRAPH_ROUTE_GRID_MAX_CELL_SIZE, GRAPH_ROUTE_GRID_CELL * scale);
  if (cellSize <= fineGrid.cellSize) return fineGrid;
  return buildGraphRouteGrid(nodes, containers, { cellSize });
}

/** Converts a requested route budget into a grid-size-aware search limit. */
function routeBudgetForAdaptiveGrid(routeBudget = "", grid = {}) {
  const budget = String(routeBudget || "");
  if (budget === GRAPH_ROUTE_MODE_QUALITY && Number(grid?.cellSize || GRAPH_ROUTE_GRID_CELL) > GRAPH_ROUTE_GRID_CELL) {
    return "bounded";
  }
  return budget;
}

/** Serializes route-grid geometry and occupancy without exposing mutable internal collections. */
function graphRouteGridSnapshot(grid) {
  if (!grid || !Number.isFinite(Number(grid.cellSize))) return null;
  const cells = [];
  for (let row = 0; row < grid.rows; row += 1) {
    for (let col = 0; col < grid.cols; col += 1) {
      const index = row * grid.cols + col;
      const blocked = grid.blocked[index] === 1;
      const cost = grid.cost[index] || 0;
      if (!blocked && cost < GRAPH_ROUTE_GRID_SNAPSHOT_MIN_COST) continue;
      cells.push({
        x: grid.left + col * grid.cellSize,
        y: grid.top + row * grid.cellSize,
        width: grid.cellSize,
        height: grid.cellSize,
        blocked,
        cost: Math.round(cost),
      });
    }
  }
  return {
    left: grid.left,
    top: grid.top,
    right: grid.right,
    bottom: grid.bottom,
    cols: grid.cols,
    rows: grid.rows,
    cellSize: grid.cellSize,
    cells,
  };
}

/** Translates every coordinate pair in a rendered SVG path by the layout-origin delta. */
function graphTranslatePath(path = "", deltaX = 0, deltaY = 0) {
  const tokens = String(path || "").match(/[a-zA-Z]|[-+]?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
  let coordinateIndex = 0;
  return tokens.map((token) => {
    if (/^[a-zA-Z]$/.test(token)) {
      coordinateIndex = 0;
      return token;
    }
    const value = Number(token);
    if (!Number.isFinite(value)) return token;
    const translated = value + (coordinateIndex % 2 === 0 ? deltaX : deltaY);
    coordinateIndex += 1;
    return String(Math.round(translated * 10) / 10);
  }).join(" ");
}

/** Translates route-grid bounds while preserving cell counts, occupancy, and cost metadata. */
function graphTranslateRouteGrid(routeGrid, deltaX = 0, deltaY = 0) {
  if (!routeGrid) return routeGrid;
  return {
    ...routeGrid,
    left: Number(routeGrid.left || 0) + deltaX,
    top: Number(routeGrid.top || 0) + deltaY,
    right: Number(routeGrid.right || 0) + deltaX,
    bottom: Number(routeGrid.bottom || 0) + deltaY,
    cells: (Array.isArray(routeGrid.cells) ? routeGrid.cells : []).map((cell) => ({
      ...cell,
      x: Number(cell.x || 0) + deltaX,
      y: Number(cell.y || 0) + deltaY,
    })),
  };
}

/** Translates nodes, edge markers, containers, and route grid through one shared geometry delta. */
function graphTranslateViewModelGeometry({ nodes = [], edges = [], containers = [], routeGrid = null }, deltaX = 0, deltaY = 0) {
  return {
    nodes: nodes.map((node) => ({
      ...node,
      x: Number(node.x || 0) + deltaX,
      y: Number(node.y || 0) + deltaY,
      connectionMarkers: Array.isArray(node.connectionMarkers)
        ? node.connectionMarkers.map((marker) => ({
          ...marker,
          x: Number(marker.x || 0) + deltaX,
          y: Number(marker.y || 0) + deltaY,
        }))
        : node.connectionMarkers,
    })),
    edges: edges.map((edge) => ({
      ...edge,
      path: graphTranslatePath(edge.path, deltaX, deltaY),
      labelX: Number(edge.labelX || 0) + deltaX,
      labelY: Number(edge.labelY || 0) + deltaY,
      routePoints: Array.isArray(edge.routePoints)
        ? edge.routePoints.map((point) => ({
          ...point,
          x: Number(point.x || 0) + deltaX,
          y: Number(point.y || 0) + deltaY,
        }))
        : edge.routePoints,
    })),
    containers: containers.map((container) => ({
      ...container,
      x: Number(container.x || 0) + deltaX,
      y: Number(container.y || 0) + deltaY,
    })),
    routeGrid: graphTranslateRouteGrid(routeGrid, deltaX, deltaY),
  };
}

/** Finalizes routing, active-chain emphasis, origin normalization, and display extents for rendering. */
export function finalizeIllustrationGraphViewModel(nodes, edges, viewState = {}, containers = []) {
  const initialGraphContainers = layoutGraphContainers(containers, nodes);
  const compoundRouting = resolveCompoundEdgeRouting(nodes, edges, initialGraphContainers, containers);
  const markerNodes = [...nodes, ...compoundRouting.routeNodes];
  const markedAll = applyGraphConnectionMarkers(markerNodes, compoundRouting.edges);
  const markedNodes = markedAll.nodes.filter((node) => node.routeProxy !== true);
  const routeNodes = markedAll.nodes.filter((node) => node.routeProxy === true);
  const nodeById = new Map(markedAll.nodes.map((node) => [node.id, node]));
  const routeGridModel = buildAdaptiveGraphRouteGrid(markedNodes, initialGraphContainers);
  const effectiveRouteBudget = routeBudgetForAdaptiveGrid(viewState.routeBudget, routeGridModel);
  const routedSourceEdges = markedAll.edges.map((edge) => ({
    ...edge,
    routeBudget: effectiveRouteBudget,
  }));
  const routeGrid = graphRouteGridSnapshot(routeGridModel);
  const routedGraphEdges = resolveEdgeLabelCollisions(
    resolveGridRoutedEdgeGeometries(routedSourceEdges, nodeById, markedNodes, initialGraphContainers, {
      grid: routeGridModel,
      gridOptions: { cellSize: routeGridModel.cellSize },
    }),
    markedNodes,
  );
  const activeChain = graphActiveChain(markedNodes, routedGraphEdges);
  const graphEdges = routedGraphEdges.map((edge) => ({
    ...edge,
    activeChain: activeChain.activeEdgeIds.has(String(edge.id || "")),
    transportStateText: activeChain.activeEdgeIds.has(String(edge.id || "")) ? "PLAYING" : "",
  }));
  const activeMarkerNodes = [
    ...markedNodes.map((node) => ({
      ...node,
      activeChain: activeChain.activeNodeIds.has(normalizeId(node.id)),
    })),
    ...routeNodes,
  ];
  const activeMarkedAll = applyGraphConnectionMarkers(activeMarkerNodes, graphEdges);
  const activeMarkedNodes = activeMarkedAll.nodes.filter((node) => node.routeProxy !== true);
  const graphNodes = resolveNodeRepeatLabelCollisions(activeMarkedNodes, graphEdges);
  const graphContainers = layoutGraphContainers(containers, graphNodes);
  const initialContentBounds = graphVisibleContentBounds({
    nodes: graphNodes,
    edges: graphEdges,
    containers: graphContainers,
  });
  const normalizedGeometry = graphTranslateViewModelGeometry(
    {
      nodes: graphNodes,
      edges: graphEdges,
      containers: graphContainers,
      routeGrid,
    },
    -initialContentBounds.left,
    -initialContentBounds.top,
  );
  const normalizedNodes = normalizedGeometry.nodes;
  const normalizedEdges = normalizedGeometry.edges;
  const normalizedContainers = normalizedGeometry.containers;
  const normalizedRouteGrid = normalizedGeometry.routeGrid;
  const maxNodeX = normalizedNodes.reduce((max, node) => Math.max(max, node.x + graphNodeWidth(node)), 0);
  const maxNodeY = normalizedNodes.reduce((max, node) => Math.max(max, node.y + graphNodeHeight(node)), 0);
  const maxContainerX = normalizedContainers.reduce((max, container) => (
    Math.max(max, Number(container.x || 0) + Number(container.width || 0))
  ), 0);
  const maxContainerY = normalizedContainers.reduce((max, container) => (
    Math.max(max, Number(container.y || 0) + Number(container.height || 0))
  ), 0);
  const edgePathBounds = normalizedEdges
    .map((edge) => graphPathBounds(edge.path))
    .filter(Boolean);
  const maxEdgePathX = edgePathBounds.reduce((max, bounds) => (
    Math.max(max, bounds.maxX)
  ), 0);
  const maxEdgePathY = edgePathBounds.reduce((max, bounds) => (
    Math.max(max, bounds.maxY)
  ), 0);
  const maxEdgeX = normalizedEdges.reduce((max, edge) => (
    edgeLabelVisible(edge) ? Math.max(max, edge.labelX + EDGE_LABEL_WIDTH / 2) : max
  ), 0);
  const maxEdgeY = normalizedEdges.reduce((max, edge) => (
    edgeLabelVisible(edge) ? Math.max(max, edge.labelY + EDGE_LABEL_HEIGHT / 2) : max
  ), 0);
  const contentBounds = graphVisibleContentBounds({
    nodes: normalizedNodes,
    edges: normalizedEdges,
    containers: normalizedContainers,
  });
  const displayRight = Math.max(
    contentBounds.right,
    maxNodeX,
    maxContainerX,
    maxEdgeX,
    maxEdgePathX,
  );
  const displayBottom = Math.max(
    contentBounds.bottom,
    maxNodeY,
    maxContainerY,
    maxEdgeY,
    maxEdgePathY,
  );

  return {
    containers: normalizedContainers,
    routeGrid: normalizedRouteGrid,
    nodes: normalizedNodes,
    edges: normalizedEdges,
    contentBounds,
    normalizationOffset: {
      x: initialContentBounds.left,
      y: initialContentBounds.top,
    },
    anchor: viewState.anchor || {},
    zoom: Number(viewState.zoom) || GRAPH_ILLUSTRATION_BASE_ZOOM,
    routeBudget: effectiveRouteBudget,
    width: Math.max(1, Math.ceil(displayRight)),
    height: Math.max(1, Math.ceil(displayBottom)),
    empty: markedNodes.length === 0,
  };
}
