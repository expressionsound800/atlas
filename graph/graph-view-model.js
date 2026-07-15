/*
 * Graph View Model validates precomputed geometry packets and reconstructs the
 * normalized rendered model consumed directly by the DOM/SVG renderer.
 */
import { graphActiveChain } from "./graph-active-chain.js";
import {
  EDGE_LABEL_HEIGHT,
  EDGE_LABEL_WIDTH,
  edgeLabelVisible,
  graphNodeHeight,
  graphNodeWidth,
  graphPathBounds,
  graphVisibleContentBounds,
  normalizeId,
  normalizeKind,
} from "./graph-geometry.js";
import { normalizeGraphPresentationMode } from "./graph-view-state.js";

export const GRAPH_VIEW_MODEL_SCHEMA = "multihead-memory-graph.view-model.v1";

/** Converts view-model geometry input to a finite number with explicit fallback. */
function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** Converts a view-model extent to a strictly positive finite number. */
function positiveNumber(value, fallback = 1) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/** Checks whether raw rendered geometry contains finite coordinates and positive extents. */
function hasValidBox(value = {}) {
  const x = Number(value?.x);
  const y = Number(value?.y);
  const width = Number(value?.width);
  const height = Number(value?.height);
  return Number.isFinite(x)
    && Number.isFinite(y)
    && Number.isFinite(width)
    && width > 0
    && Number.isFinite(height)
    && height > 0;
}

/** Normalizes rendered labels and metadata while preserving a caller-defined fallback. */
function compactText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

/** Resolves a view model's declared presentation mode from current or legacy placement. */
function viewModelPresentationMode(viewModel = {}) {
  const mode = compactText(viewModel.presentationMode || viewModel?.viewState?.presentationMode);
  return mode ? normalizeGraphPresentationMode(mode) : "";
}

/** Checks whether precomputed geometry is compatible with the requested presentation mode. */
function viewModelMatchesPresentationMode(viewModel, presentationMode = "") {
  if (!viewModel || typeof viewModel !== "object") return false;
  const packetMode = viewModelPresentationMode(viewModel);
  if (!packetMode) return true;
  return packetMode === normalizeGraphPresentationMode(presentationMode);
}

/** Normalizes one finite polyline point and rejects unusable route coordinates. */
function normalizeViewModelPoint(point = {}) {
  const x = Number(point?.x);
  const y = Number(point?.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { ...point, x, y } : null;
}

/** Normalizes one connection marker and derives its current active-chain emphasis. */
function normalizeViewModelMarker(marker = {}, activeEdgeIds = new Set()) {
  const localX = Number(marker?.localX);
  const localY = Number(marker?.localY);
  const x = Number(marker?.x);
  const y = Number(marker?.y);
  if (!Number.isFinite(localX) || !Number.isFinite(localY)) return null;
  return {
    ...marker,
    edgeId: compactText(marker.edgeId),
    endpointRole: compactText(marker.endpointRole),
    direction: compactText(marker.direction, "outbound"),
    role: compactText(marker.role, "binding"),
    kind: normalizeKind(marker.kind || marker.role || "binding"),
    side: compactText(marker.side),
    localX,
    localY,
    x: Number.isFinite(x) ? x : null,
    y: Number.isFinite(y) ? y : null,
    activeChain: activeEdgeIds.has(compactText(marker.edgeId)),
  };
}

/** Normalizes one rendered node's identity, geometry, selection, metadata, and presentation mode. */
function normalizeViewModelNode(node = {}, options = {}) {
  const id = normalizeId(node.id);
  const selectedNodeId = normalizeId(options.selectedNodeId);
  return {
    ...node,
    id,
    sourceId: compactText(node.sourceId || node.id, id),
    kind: normalizeKind(node.kind || node.memoryKind || "node"),
    memoryKind: compactText(node.memoryKind || node.kind),
    label: compactText(node.label, id),
    layer: compactText(node.layer),
    source: compactText(node.source),
    description: compactText(node.description),
    presentationMode: normalizeGraphPresentationMode(options.presentationMode || node.presentationMode),
    selected: Boolean(selectedNodeId && id === selectedNodeId),
    x: finiteNumber(node.x),
    y: finiteNumber(node.y),
    width: positiveNumber(node.width || node.gridWidth),
    height: positiveNumber(node.height || node.gridHeight),
    labelWidth: Number.isFinite(Number(node.labelWidth)) ? Number(node.labelWidth) : node.labelWidth,
    metadata: node.metadata && typeof node.metadata === "object" ? { ...node.metadata } : {},
    connectionMarkers: Array.isArray(node.connectionMarkers) ? node.connectionMarkers : [],
  };
}

/** Validates manual view-model coordinates and indexes them by normalized node identity. */
function normalizedViewModelNodePositionOverrides(nodePositions = {}) {
  if (!nodePositions || typeof nodePositions !== "object") return new Map();
  return new Map(Object.entries(nodePositions).map(([id, position]) => [
    normalizeId(id),
    {
      x: finiteNumber(position?.x, NaN),
      y: finiteNumber(position?.y, NaN),
    },
  ]).filter(([id, position]) =>
    id && Number.isFinite(position.x) && Number.isFinite(position.y)
  ));
}

/** Applies valid manual coordinates while marking their layout authority for later inspection. */
function applyViewModelNodePositionOverrides(nodes = [], nodePositions = {}) {
  const overrides = normalizedViewModelNodePositionOverrides(nodePositions);
  if (!overrides.size) return nodes;
  return (Array.isArray(nodes) ? nodes : []).map((node) => {
    const override = overrides.get(normalizeId(node.id)) || overrides.get(normalizeId(node.sourceId));
    return override ? { ...node, ...override, positionSource: "manual-layout" } : node;
  });
}

/** Normalizes one rendered container's geometry, role, text, and metadata. */
function normalizeViewModelContainer(container = {}) {
  const id = normalizeId(container.id);
  return {
    ...container,
    id,
    kind: normalizeKind(container.kind || "container"),
    label: compactText(container.label, id),
    role: compactText(container.role),
    description: compactText(container.description),
    x: finiteNumber(container.x),
    y: finiteNumber(container.y),
    width: positiveNumber(container.width),
    height: positiveNumber(container.height),
    metadata: container.metadata && typeof container.metadata === "object" ? { ...container.metadata } : {},
  };
}

/** Normalizes one routed edge including endpoints, path points, labels, and signal state. */
function normalizeViewModelEdge(edge = {}, index = 0, activeEdgeIds = new Set()) {
  const from = normalizeId(edge.from);
  const to = normalizeId(edge.to);
  const id = compactText(edge.id, `edge:${index + 1}:${from}:${to}:${edge.kind || "relationship"}`);
  return {
    ...edge,
    id,
    from,
    to,
    routeFrom: normalizeId(edge.routeFrom || edge.from),
    routeTo: normalizeId(edge.routeTo || edge.to),
    kind: normalizeKind(edge.kind || "relationship"),
    label: compactText(edge.label),
    relationshipLabel: compactText(edge.relationshipLabel || edge.label || edge.kind),
    path: compactText(edge.path),
    labelX: finiteNumber(edge.labelX),
    labelY: finiteNumber(edge.labelY),
    routePoints: Array.isArray(edge.routePoints)
      ? edge.routePoints.map(normalizeViewModelPoint).filter(Boolean)
      : [],
    activeChain: activeEdgeIds.has(id),
    transportStateText: activeEdgeIds.has(id) ? "PLAYING" : compactText(edge.transportStateText),
  };
}

/** Normalizes an optional serialized route grid and every visible cell geometry record. */
function normalizeViewModelRouteGrid(routeGrid = null) {
  if (!routeGrid || typeof routeGrid !== "object") return null;
  const cellSize = Number(routeGrid.cellSize);
  if (!Number.isFinite(cellSize) || cellSize <= 0) return null;
  return {
    ...routeGrid,
    left: finiteNumber(routeGrid.left),
    top: finiteNumber(routeGrid.top),
    right: finiteNumber(routeGrid.right),
    bottom: finiteNumber(routeGrid.bottom),
    cols: Math.max(0, Math.floor(finiteNumber(routeGrid.cols))),
    rows: Math.max(0, Math.floor(finiteNumber(routeGrid.rows))),
    cellSize,
    cells: Array.isArray(routeGrid.cells)
      ? routeGrid.cells.map((cell) => ({
        ...cell,
        x: finiteNumber(cell.x),
        y: finiteNumber(cell.y),
        width: positiveNumber(cell.width, cellSize),
        height: positiveNumber(cell.height, cellSize),
        blocked: cell.blocked === true,
        cost: finiteNumber(cell.cost),
      }))
      : [],
  };
}

/** Computes display extents from visible nodes, labels, routed paths, containers, and fallbacks. */
function graphViewModelDisplaySize(nodes = [], edges = [], containers = [], fallback = {}) {
  const contentBounds = graphVisibleContentBounds({ nodes, edges, containers });
  const edgePathBounds = edges
    .map((edge) => graphPathBounds(edge.path))
    .filter(Boolean);
  const maxEdgePathX = edgePathBounds.reduce((max, bounds) => Math.max(max, bounds.maxX), 0);
  const maxEdgePathY = edgePathBounds.reduce((max, bounds) => Math.max(max, bounds.maxY), 0);
  const maxEdgeX = edges.reduce((max, edge) => (
    edgeLabelVisible(edge) ? Math.max(max, edge.labelX + EDGE_LABEL_WIDTH / 2) : max
  ), 0);
  const maxEdgeY = edges.reduce((max, edge) => (
    edgeLabelVisible(edge) ? Math.max(max, edge.labelY + EDGE_LABEL_HEIGHT / 2) : max
  ), 0);
  const maxNodeX = nodes.reduce((max, node) => Math.max(max, node.x + graphNodeWidth(node)), 0);
  const maxNodeY = nodes.reduce((max, node) => Math.max(max, node.y + graphNodeHeight(node)), 0);
  const maxContainerX = containers.reduce((max, container) => (
    Math.max(max, Number(container.x || 0) + Number(container.width || 0))
  ), 0);
  const maxContainerY = containers.reduce((max, container) => (
    Math.max(max, Number(container.y || 0) + Number(container.height || 0))
  ), 0);
  return {
    contentBounds,
    width: Math.max(
      1,
      Math.ceil(finiteNumber(fallback.width, 0)),
      Math.ceil(contentBounds.right),
      Math.ceil(maxNodeX),
      Math.ceil(maxContainerX),
      Math.ceil(maxEdgeX),
      Math.ceil(maxEdgePathX),
    ),
    height: Math.max(
      1,
      Math.ceil(finiteNumber(fallback.height, 0)),
      Math.ceil(contentBounds.bottom),
      Math.ceil(maxNodeY),
      Math.ceil(maxContainerY),
      Math.ceil(maxEdgeY),
      Math.ceil(maxEdgePathY),
    ),
  };
}

/** Selects compatible precomputed geometry across current and legacy projection locations. */
export function graphPrecomputedViewModelFromProjection(projection = {}, options = {}) {
  if (!projection || typeof projection !== "object") return null;
  const presentationMode = normalizeGraphPresentationMode(options.presentationMode);
  const viewModels = projection.viewModels && typeof projection.viewModels === "object"
    ? projection.viewModels
    : null;
  const requestedViewModel = viewModels?.[presentationMode] || viewModels?.[String(options.presentationMode || "").trim()];
  if (viewModelMatchesPresentationMode(requestedViewModel, presentationMode)) return requestedViewModel;
  if (projection.viewModel && viewModelMatchesPresentationMode(projection.viewModel, presentationMode)) {
    return projection.viewModel;
  }
  if (projection.precomputedViewModel && typeof projection.precomputedViewModel === "object") {
    return viewModelMatchesPresentationMode(projection.precomputedViewModel, presentationMode)
      ? projection.precomputedViewModel
      : null;
  }
  if (projection.geometry?.viewModel && typeof projection.geometry.viewModel === "object") {
    return viewModelMatchesPresentationMode(projection.geometry.viewModel, presentationMode)
      ? projection.geometry.viewModel
      : null;
  }
  if (projection.layout?.viewModel && typeof projection.layout.viewModel === "object") {
    return viewModelMatchesPresentationMode(projection.layout.viewModel, presentationMode)
      ? projection.layout.viewModel
      : null;
  }
  return null;
}

/** Builds the renderer-ready view model with active chains, manual overrides, and final extents. */
export function normalizeGraphViewModel(viewModel = {}, options = {}) {
  const selectedNodeId = normalizeId(options.selectedNodeId);
  const nodes = applyViewModelNodePositionOverrides((Array.isArray(viewModel.nodes) ? viewModel.nodes : [])
    .map((node) => normalizeViewModelNode(node, {
      selectedNodeId,
      presentationMode: options.presentationMode,
    }))
    .filter((node) => node.id), options.nodePositions);
  const baseEdges = (Array.isArray(viewModel.edges) ? viewModel.edges : [])
    .map((edge, index) => normalizeViewModelEdge(edge, index))
    .filter((edge) => edge.id && edge.from && edge.to);
  const activeChain = graphActiveChain(nodes, baseEdges);
  const activeEdges = baseEdges.map((edge, index) => normalizeViewModelEdge(edge, index, activeChain.activeEdgeIds));
  const activeNodes = nodes.map((node) => {
    const activeEdgeIds = activeChain.activeEdgeIds;
    const connectionMarkers = Array.isArray(node.connectionMarkers)
      ? node.connectionMarkers
        .map((marker) => normalizeViewModelMarker(marker, activeEdgeIds))
        .filter(Boolean)
      : [];
    return {
      ...node,
      activeChain: activeChain.activeNodeIds.has(normalizeId(node.id)),
      connectionMarkers,
    };
  });
  const containers = (Array.isArray(viewModel.containers) ? viewModel.containers : [])
    .map(normalizeViewModelContainer)
    .filter((container) => container.id);
  const { contentBounds, width, height } = graphViewModelDisplaySize(activeNodes, activeEdges, containers, viewModel);
  return {
    ...viewModel,
    schema: compactText(viewModel.schema, GRAPH_VIEW_MODEL_SCHEMA),
    precomputed: true,
    source: compactText(viewModel.source, "precomputed"),
    presentationMode: normalizeGraphPresentationMode(viewModel.presentationMode || options.presentationMode),
    nodes: activeNodes,
    edges: activeEdges,
    containers,
    routeGrid: normalizeViewModelRouteGrid(viewModel.routeGrid),
    contentBounds,
    normalizationOffset: viewModel.normalizationOffset && typeof viewModel.normalizationOffset === "object"
      ? { ...viewModel.normalizationOffset }
      : { x: 0, y: 0 },
    anchor: viewModel.anchor && typeof viewModel.anchor === "object" ? { ...viewModel.anchor } : {},
    zoom: positiveNumber(viewModel.zoom, 1),
    routeBudget: compactText(viewModel.routeBudget || options.routeBudget, "precomputed"),
    width,
    height,
    empty: activeNodes.length === 0,
  };
}

/** Validates unique identities, geometry boxes, routed endpoints, paths, and presentation metadata. */
export function validateGraphViewModel(viewModel = {}) {
  const errors = [];
  const warnings = [];
  if (!viewModel || typeof viewModel !== "object") {
    return {
      valid: false,
      errors: [{ code: "invalid-view-model", message: "view model must be an object" }],
      warnings,
      metrics: { nodes: 0, containers: 0, edges: 0 },
    };
  }

  const normalized = normalizeGraphViewModel(viewModel);
  const rawNodesById = new Map((Array.isArray(viewModel.nodes) ? viewModel.nodes : [])
    .map((node) => [normalizeId(node?.id), node]));
  const rawContainersById = new Map((Array.isArray(viewModel.containers) ? viewModel.containers : [])
    .map((container) => [normalizeId(container?.id), container]));
  const nodeIds = new Set();
  const containerIds = new Set();
  normalized.nodes.forEach((node) => {
    if (nodeIds.has(node.id)) errors.push({ code: "duplicate-node-id", id: node.id });
    nodeIds.add(node.id);
    if (!hasValidBox(rawNodesById.get(node.id))) {
      errors.push({ code: "invalid-node-box", id: node.id });
    }
  });
  normalized.containers.forEach((container) => {
    if (containerIds.has(container.id)) errors.push({ code: "duplicate-container-id", id: container.id });
    containerIds.add(container.id);
    if (!hasValidBox(rawContainersById.get(container.id))) {
      errors.push({ code: "invalid-container-box", id: container.id });
    }
  });
  normalized.edges.forEach((edge) => {
    if (!nodeIds.has(edge.from) && !containerIds.has(edge.from)) {
      errors.push({ code: "missing-edge-source", edgeId: edge.id, endpointId: edge.from });
    }
    if (!nodeIds.has(edge.to) && !containerIds.has(edge.to)) {
      errors.push({ code: "missing-edge-target", edgeId: edge.id, endpointId: edge.to });
    }
    if (edge.terminal !== true && !edge.path) {
      errors.push({ code: "missing-edge-path", edgeId: edge.id });
    }
  });
  if (!viewModelPresentationMode(viewModel)) warnings.push({ code: "missing-presentation-mode" });
  if (!normalized.routeGrid) warnings.push({ code: "missing-route-grid" });

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    metrics: {
      nodes: normalized.nodes.length,
      containers: normalized.containers.length,
      edges: normalized.edges.length,
      width: normalized.width,
      height: normalized.height,
    },
  };
}
