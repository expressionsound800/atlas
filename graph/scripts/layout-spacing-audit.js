#!/usr/bin/env node

/*
 * Layout Spacing Audit measures grid, node, container, route, label, and
 * collapse invariants across deterministic topology fixtures.
 */
import { buildIllustrationGraphViewModel } from "../graph-layout.js";
import { GRAPH_ROUTE_GRID_CELL } from "../graph-grid.js";
import { graphNodeRect, graphVisibleContentBounds, normalizeId } from "../graph-geometry.js";
import { distributeGraphNodesWithinContainers } from "../graph-layout-containers.js";
import { applyContainerLocalFlowPlacement } from "../graph-layout-flow.js";
import {
  ATLAS_SOURCE_CATEGORIES,
  atlasGraphViewOptions,
  fetchAtlasGraphForCategory,
  fetchAtlasArchitectureRoomGraph,
  sessionGraph,
} from "../source-atlas.js";

const MANUAL_DROP_OPTICAL_TOLERANCE = GRAPH_ROUTE_GRID_CELL / 4;

/** Checks whether two audit rectangles retain horizontal or vertical route-grid clearance. */
function graphRectsRespectGap(left = {}, right = {}, gap = GRAPH_ROUTE_GRID_CELL) {
  return left.right + gap <= right.left
    || right.right + gap <= left.left
    || left.bottom + gap <= right.top
    || right.bottom + gap <= left.top;
}

/** Checks one spacing, routing, emphasis, or manual-layout invariant with fixture evidence. */
function assertCondition(condition, message, details = {}) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

/** Collects overlapping or under-spaced node pairs from one rendered projection. */
function spacingViolations(viewModel = {}, label = "projection") {
  const nodes = Array.isArray(viewModel.nodes) ? viewModel.nodes : [];
  const violations = [];
  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const left = nodes[leftIndex];
      const right = nodes[rightIndex];
      const leftRect = graphNodeRect(left);
      const rightRect = graphNodeRect(right);
      if (graphRectsRespectGap(leftRect, rightRect)) continue;
      violations.push({
        projection: label,
        left: left.id,
        right: right.id,
        leftRect,
        rightRect,
      });
    }
  }
  return violations;
}

/** Collects consecutive same-column nodes that fail the dense-band vertical breathing contract. */
function verticalBandSpacingViolations(nodes = [], gap = GRAPH_ROUTE_GRID_CELL) {
  const columns = new Map();
  for (const node of nodes) {
    const column = Number(node.x || 0);
    if (!columns.has(column)) columns.set(column, []);
    columns.get(column).push(node);
  }
  const violations = [];
  for (const [column, entries] of columns.entries()) {
    const ordered = entries.sort((left, right) => Number(left.y || 0) - Number(right.y || 0));
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      const previousRect = graphNodeRect(previous);
      const currentRect = graphNodeRect(current);
      const actualGap = currentRect.top - previousRect.bottom;
      if (actualGap >= gap) continue;
      violations.push({
        column,
        previous: previous.id,
        current: current.id,
        requiredGap: gap,
        actualGap,
      });
    }
  }
  return violations;
}

/** Computes a node's horizontal center for container stack and lane comparisons. */
function nodeCenterX(node = {}) {
  return Number(node.x || 0) + Number(node.width || 0) / 2;
}

/** Collects container child-order and vertical-rhythm failures from rendered geometry. */
function containerStackRhythmViolations(viewModel = {}, label = "projection") {
  const nodes = Array.isArray(viewModel.nodes) ? viewModel.nodes : [];
  const containers = Array.isArray(viewModel.containers) ? viewModel.containers : [];
  const nodeById = new Map();
  nodes.forEach((node) => {
    nodeById.set(String(node.id || "").trim().toUpperCase(), node);
    nodeById.set(String(node.sourceId || "").trim().toUpperCase(), node);
  });
  const rawTargetGap = GRAPH_ROUTE_GRID_CELL * 2;
  const violations = [];

  for (const container of containers) {
    const childNodes = (Array.isArray(container.nodeIds) ? container.nodeIds : [])
      .map((id) => nodeById.get(String(id || "").trim().toUpperCase()))
      .filter(Boolean)
      .sort((left, right) => Number(left.y || 0) - Number(right.y || 0));
    if (childNodes.length < 3) continue;
    const centerSpread = Math.max(...childNodes.map(nodeCenterX)) - Math.min(...childNodes.map(nodeCenterX));
    if (centerSpread > GRAPH_ROUTE_GRID_CELL * 1.5) continue;
    for (let index = 1; index < childNodes.length; index += 1) {
      const previous = childNodes[index - 1];
      const current = childNodes[index];
      const previousRect = graphNodeRect(previous);
      const currentRect = graphNodeRect(current);
      const previousHeight = previousRect.bottom - previousRect.top;
      const targetPitch = Math.round((previousHeight + rawTargetGap) / GRAPH_ROUTE_GRID_CELL) * GRAPH_ROUTE_GRID_CELL;
      const targetGap = targetPitch - previousHeight;
      const gap = currentRect.top - previousRect.bottom;
      if (Math.abs(gap - targetGap) <= 1) continue;
      violations.push({
        projection: label,
        container: container.id,
        previous: previous.id,
        current: current.id,
        gap,
        targetGap,
      });
    }
  }

  return violations;
}

/** Counts straight, elbowed, multi-elbow, and total route points for deterministic composition regression comparisons. */
function routeCharacterMetrics(viewModel = {}) {
  const edges = Array.isArray(viewModel.edges) ? viewModel.edges : [];
  const bends = edges.map((edge) => Math.max(0, Number(edge.routeBends || 0)));
  const crossings = edges.map((edge) => Math.max(0, Number(edge.routeCrossings || 0)));
  return {
    routeBudget: String(viewModel.routeBudget || ""),
    totalBends: bends.reduce((sum, value) => sum + value, 0),
    totalCrossings: crossings.reduce((sum, value) => sum + value, 0),
    maxEdgeCrossings: Math.max(0, ...crossings),
    straightEdges: bends.filter((value) => value === 0).length,
    elbowEdges: bends.filter((value) => value > 0).length,
    multiElbowEdges: bends.filter((value) => value > 1).length,
    routePoints: edges.reduce((sum, edge) => sum + Math.max(0, Number(edge.routePointCount || 0)), 0),
  };
}

/** Measures horizontal, vertical, and diagonal empty distance between two structural region rectangles. */
function structuralRegionSeparation(left = {}, right = {}) {
  const horizontal = Math.max(0, Number(left.left || 0) - Number(right.right || 0), Number(right.left || 0) - Number(left.right || 0));
  const vertical = Math.max(0, Number(left.top || 0) - Number(right.bottom || 0), Number(right.top || 0) - Number(left.bottom || 0));
  return { horizontal, vertical, gap: Math.hypot(horizontal, vertical) };
}

/** Measures each root region's nearest neighbor so isolated whitespace outliers are visible without penalizing normal gutters. */
function structuralWhitespaceMetrics(viewModel = {}) {
  const containers = Array.isArray(viewModel.containers) ? viewModel.containers : [];
  const nodes = Array.isArray(viewModel.nodes) ? viewModel.nodes : [];
  const nodeById = new Map(nodes.map((node) => [normalizeId(node.id), node]));
  const claimedNodeIds = new Set(containers.flatMap((container) => (
    Array.isArray(container.nodeIds) ? container.nodeIds.map(normalizeId) : []
  )));
  const regions = [
    ...containers
      .filter((container) => !normalizeId(container.parentId))
      .map((container) => ({
        id: container.id,
        sides: [...new Set((Array.isArray(container.nodeIds) ? container.nodeIds : [])
          .map((id) => String(nodeById.get(normalizeId(id))?.graphSide || ""))
          .filter(Boolean))].sort(),
        left: Number(container.x || 0),
        top: Number(container.y || 0),
        right: Number(container.x || 0) + Number(container.width || 0),
        bottom: Number(container.y || 0) + Number(container.height || 0),
      })),
    ...nodes
      .filter((node) => !claimedNodeIds.has(normalizeId(node.id)))
      .map((node) => ({ id: node.id, ...graphNodeRect(node) })),
  ];
  const nearestRegions = regions.map((region, index) => regions
    .filter((_, candidateIndex) => candidateIndex !== index)
    .map((candidate) => ({
      id: region.id,
      neighborId: candidate.id,
      ...structuralRegionSeparation(region, candidate),
    }))
    .sort((left, right) => left.gap - right.gap || String(left.neighborId).localeCompare(String(right.neighborId)))[0])
    .filter((entry) => Number.isFinite(entry?.gap));
  const nearestGaps = nearestRegions.map((entry) => entry.gap).sort((left, right) => left - right);
  const middle = Math.floor(nearestGaps.length / 2);
  const medianNearestGap = nearestGaps.length % 2
    ? nearestGaps[middle]
    : nearestGaps.length
      ? (nearestGaps[middle - 1] + nearestGaps[middle]) / 2
      : 0;
  const maxNearestGap = nearestGaps.at(-1) || 0;
  const outlier = nearestRegions
    .sort((left, right) => right.gap - left.gap || String(left.id).localeCompare(String(right.id)))[0] || {};
  return {
    regions: regions.length,
    medianNearestGap: Math.round(medianNearestGap),
    maxNearestGap: Math.round(maxNearestGap),
    outlierRatio: medianNearestGap > 0 ? Math.round((maxNearestGap / medianNearestGap) * 100) / 100 : 0,
    outlierRegion: String(outlier.id || ""),
    nearestRegion: String(outlier.neighborId || ""),
    outlierHorizontalGap: Math.round(Number(outlier.horizontal || 0)),
    outlierVerticalGap: Math.round(Number(outlier.vertical || 0)),
    outlierSides: regions.find((region) => region.id === outlier.id)?.sides || [],
    nearestSides: regions.find((region) => region.id === outlier.neighborId)?.sides || [],
  };
}

/** Returns per-container row, column, occupancy, and composition evidence for detecting matrix-layout regressions. */
function containerCompositionMetrics(viewModel = {}) {
  const nodes = Array.isArray(viewModel.nodes) ? viewModel.nodes : [];
  const containers = Array.isArray(viewModel.containers) ? viewModel.containers : [];
  const nodeById = new Map(nodes.map((node) => [normalizeId(node.id), node]));
  return containers
    .map((container) => {
      const childNodes = (Array.isArray(container.nodeIds) ? container.nodeIds : [])
        .map((id) => nodeById.get(normalizeId(id)))
        .filter(Boolean);
      if (childNodes.length < 8) return null;
      const rows = new Map();
      const columns = new Map();
      childNodes.forEach((node) => {
        const row = Math.round(Number(node.y || 0) / GRAPH_ROUTE_GRID_CELL);
        const column = Math.round(Number(node.x || 0) / GRAPH_ROUTE_GRID_CELL);
        rows.set(row, (rows.get(row) || 0) + 1);
        if (!columns.has(column)) columns.set(column, []);
        columns.get(column).push(node);
      });
      const columnCounts = [...columns.values()].map((entries) => entries.length);
      const flowNodes = childNodes.filter((node) => String(node.containerFlowModel || "").trim());
      const flowPotentials = flowNodes
        .map((node) => Number(node.containerFlowPotential))
        .filter(Number.isFinite);
      /** Returns the fraction of children participating in coordinate bands with at least three members. */
      const alignedShare = (groups) => groups
        .filter((count) => count >= 3)
        .reduce((sum, count) => sum + count, 0) / childNodes.length;
      return {
        container: container.id,
        nodes: childNodes.length,
        width: Math.round(Number(container.width || 0)),
        height: Math.round(Number(container.height || 0)),
        rows: rows.size,
        columns: columns.size,
        rowAlignedShare: Math.round(alignedShare([...rows.values()]) * 100) / 100,
        columnAlignedShare: Math.round(alignedShare(columnCounts) * 100) / 100,
        compositionModels: [...new Set(childNodes
          .map((node) => String(node.containerCompositionModel || ""))
          .filter(Boolean))].sort(),
        flowModels: [...new Set(flowNodes.map((node) => String(node.containerFlowModel)))].sort(),
        flowNodes: flowNodes.length,
        flowBands: [...new Set(flowNodes
          .map((node) => Number(node.containerFlowBand))
          .filter(Number.isFinite))].sort((left, right) => left - right),
        flowPotentialRange: flowPotentials.length
          ? [Math.min(...flowPotentials), Math.max(...flowPotentials)]
          : [],
        flowFields: [...new Set(flowNodes
          .map((node) => Number(node.containerFlowField))
          .filter((value) => Number.isFinite(value) && value >= 0))].sort((left, right) => left - right),
        flowHubIds: [...new Set(flowNodes
          .map((node) => String(node.containerFlowHubId || ""))
          .filter(Boolean))].sort(),
        flowBranchCount: Math.max(0, ...flowNodes.map((node) => Number(node.containerFlowBranchCount || 0))),
        flowMaxBandOccupancy: Math.max(
          0,
          ...flowNodes.map((node) => Number(node.containerFlowMaxBandOccupancy || 0)),
        ),
        topologyReservedNodes: childNodes
          .filter((node) => Number(node.containerTopologyReserve || 0) > 0)
          .map((node) => ({
            id: node.id,
            x: Math.round(Number(node.x || 0)),
            y: Math.round(Number(node.y || 0)),
            reserve: Math.round(Number(node.containerTopologyReserve || 0)),
          })),
      };
    })
    .filter(Boolean);
}

/** Builds a view model and verifies node clearance, grid alignment, and container rhythm. */
function assertSpacing(projection, options = {}, label = "projection") {
  const viewModel = buildIllustrationGraphViewModel({
    memoryGraph: projection,
    presentationMode: "compact",
    routeMode: "speed",
    ...options,
  });
  const violations = spacingViolations(viewModel, label);
  assertCondition(violations.length === 0, "view-model nodes must keep one grid cell of spacing", {
    label,
    violations,
  });
  const rhythmViolations = containerStackRhythmViolations(viewModel, label);
  assertCondition(rhythmViolations.length === 0, "vertical container stacks must keep a uniform two-cell rhythm", {
    label,
    violations: rhythmViolations,
  });
  const visibleBounds = graphVisibleContentBounds(viewModel);
  assertCondition(
    visibleBounds.left <= GRAPH_ROUTE_GRID_CELL / 2,
    "view-model must normalize visible content close to the left origin",
    { label, visibleBounds },
  );
  assertCondition(
    visibleBounds.top <= GRAPH_ROUTE_GRID_CELL / 2,
    "view-model must normalize visible content close to the top origin",
    { label, visibleBounds },
  );
  const trailingSpace = Number(viewModel.width || 0) - visibleBounds.right;
  assertCondition(
    trailingSpace <= GRAPH_ROUTE_GRID_CELL / 2,
    "view-model width must not preserve excessive empty cells after visible content",
    { label, trailingSpace, width: viewModel.width, visibleBounds },
  );
  return {
    label,
    nodes: viewModel.nodes.length,
    edges: viewModel.edges.length,
    containers: viewModel.containers.length,
    width: Number(viewModel.width || 0),
    height: Number(viewModel.height || 0),
    routing: routeCharacterMetrics(viewModel),
    whitespace: structuralWhitespaceMetrics(viewModel),
    composition: containerCompositionMetrics(viewModel),
  };
}

/** Verifies dense pre-positioned rows receive a safe deterministic stagger instead of remaining a matrix. */
function assertDenseContainerComposition() {
  const childNodes = Array.from({ length: 12 }, (_, index) => ({
    id: `dense-${index + 1}`,
    label: `Dense ${index + 1}`,
    kind: "memory",
    x: 96 + (index % 4) * 288,
    y: 96 + Math.floor(index / 4) * 160,
    width: 192,
    height: 48,
  }));
  const nodes = distributeGraphNodesWithinContainers(childNodes.map((node) => ({
    ...node,
    graphSemantic: node.id === "dense-6"
      ? { incomingDegree: 2, outgoingDegree: 1 }
      : { incomingDegree: 1, outgoingDegree: 0 },
  })), [{
    id: "container:dense-composition",
    nodeIds: childNodes.map((node) => node.id),
  }], [
    { id: "return-input-a", from: "dense-2", to: "dense-6" },
    { id: "return-input-b", from: "dense-10", to: "dense-6" },
    { id: "return-edge", from: "dense-6", to: "dense-1" },
  ]);
  const models = [...new Set(nodes.map((node) => node.containerCompositionModel).filter(Boolean))];
  assertCondition(
    models.length === 1 && models[0] === "staggered-flow-bands-v1",
    "dense rectilinear containers should receive the staggered flow-band composition",
    { models, nodes },
  );
  const originalColumns = new Set(childNodes.map((node) => node.x)).size;
  const originalRows = new Set(childNodes.map((node) => node.y)).size;
  const composedRows = new Set(nodes.map((node) => node.y)).size;
  assertCondition(
    composedRows > originalRows,
    "staggered flow bands should break repeated horizontal seams",
    { originalRows, composedRows, nodes },
  );
  const violations = spacingViolations({ nodes }, "generic:dense-container-composition");
  assertCondition(violations.length === 0, "staggered flow bands must preserve sibling clearance", { violations });
  const breathingGap = GRAPH_ROUTE_GRID_CELL * 4;
  const breathingViolations = verticalBandSpacingViolations(nodes, breathingGap);
  assertCondition(
    breathingViolations.length === 0,
    "staggered flow bands must reserve four clear route-grid cells vertically",
    { breathingGap, violations: breathingViolations },
  );
  const returnLaneNode = nodes.find((node) => node.id === "dense-6");
  const returnLaneColumn = nodes
    .filter((node) => Number(node.x || 0) === Number(returnLaneNode?.x || 0))
    .sort((left, right) => Number(left.y || 0) - Number(right.y || 0));
  const returnLaneIndex = returnLaneColumn.findIndex((node) => node.id === returnLaneNode?.id);
  const returnLaneNeighborGaps = [returnLaneColumn[returnLaneIndex - 1]]
    .filter(Boolean)
    .map((neighbor) => {
      const upper = Number(neighbor.y || 0) < Number(returnLaneNode.y || 0) ? neighbor : returnLaneNode;
      const lower = upper === returnLaneNode ? neighbor : returnLaneNode;
      return graphNodeRect(lower).top - graphNodeRect(upper).bottom;
    });
  const requiredReturnLaneGap = breathingGap + Number(returnLaneNode?.containerTopologyReserve || 0);
  assertCondition(
    returnLaneIndex === returnLaneColumn.length - 1
      && Number(returnLaneNode?.containerTopologyReserve || 0) === GRAPH_ROUTE_GRID_CELL * 18
      && returnLaneNeighborGaps.every((gap) => gap >= requiredReturnLaneGap),
    "backward-flow bridge nodes must receive one peripheral return lane",
    { returnLaneNode, returnLaneNeighborGaps, requiredReturnLaneGap },
  );
  return {
    label: "generic:dense-container-composition",
    nodes: nodes.length,
    originalColumns,
    originalRows,
    composedRows,
    model: models[0],
    returnLaneReserve: returnLaneNode.containerTopologyReserve,
    returnLaneNeighborGaps,
  };
}

/** Verifies gradient and crossing order derive only from relationships inside one canonical container. */
function assertContainerLocalFlowGradient() {
  const nodeIds = ["a1", "a2", "b1", "b2", "c1", "c2", "d1", "d2"];
  const internalEdges = [
    { from: "a1", to: "b2" },
    { from: "a2", to: "b1" },
    { from: "b2", to: "c1" },
    { from: "b1", to: "c2" },
    { from: "c1", to: "d2" },
    { from: "c2", to: "d1" },
  ];
  /** Builds fresh mutable entries so the isolation comparison cannot share layout evidence by reference. */
  const entries = () => nodeIds.map((id) => ({ node: { id, graphColumn: 2 } }));
  const localEntries = entries();
  const externalEntries = entries();
  const options = { containerId: "container:flow-fixture", side: "right" };
  assertCondition(
    applyContainerLocalFlowPlacement(localEntries, internalEdges, options),
    "dense container flow fixture should activate the local gradient",
  );
  assertCondition(
    applyContainerLocalFlowPlacement(externalEntries, [
      ...internalEdges,
      { from: "outside-source", to: "d1" },
      { from: "a1", to: "outside-receiver" },
    ], options),
    "cross-container relationships should not disable the local gradient",
  );
  /** Returns stable potential, band, order, column, and model evidence for the isolation comparison. */
  const evidence = (list) => Object.fromEntries(list.map(({ node }) => [node.id, {
    potential: node.containerFlowPotential,
    band: node.containerFlowBand,
    order: node.containerFlowOrder,
    column: node.graphColumn,
    model: node.containerFlowModel,
  }]));
  const localEvidence = evidence(localEntries);
  const externalEvidence = evidence(externalEntries);
  const cyclicEntries = entries();
  assertCondition(
    applyContainerLocalFlowPlacement(cyclicEntries, [
      ...internalEdges,
      { from: "d1", to: "b1" },
    ], options),
    "mixed relay nodes in a directed cycle should retain a solvable local gradient",
  );
  const cyclicEvidence = evidence(cyclicEntries);
  assertCondition(
    JSON.stringify(localEvidence) === JSON.stringify(externalEvidence),
    "cross-container relationships must not influence a container-local gradient",
    { localEvidence, externalEvidence },
  );
  assertCondition(
    localEvidence.a1.potential < localEvidence.d1.potential
      && localEvidence.a2.potential < localEvidence.d2.potential
      && localEvidence.a1.column < localEvidence.d1.column,
    "source nodes should precede receiver nodes along the local flow gradient",
    { localEvidence },
  );
  assertCondition(
    localEvidence.b2.order < localEvidence.b1.order,
    "barycentric ordering should align crossed targets with their source lanes",
    { localEvidence },
  );
  assertCondition(
    Object.values(localEvidence).every((entry) => entry.model === "container-local-trophic-gradient-v1"),
    "every participating node should expose the applied local flow model",
    { localEvidence },
  );
  assertCondition(
    Object.values(cyclicEvidence).every((entry) => Number.isFinite(entry.potential))
      && cyclicEvidence.b2.potential > cyclicEvidence.a1.potential
      && cyclicEvidence.b2.potential < cyclicEvidence.d1.potential,
    "cyclic mixed nodes should keep finite intermediate potential instead of forcing a false topological sort",
    { cyclicEvidence },
  );
  return {
    label: "generic:container-local-flow-gradient",
    nodes: nodeIds.length,
    bands: new Set(Object.values(localEvidence).map((entry) => entry.band)).size,
    sourcePotential: localEvidence.a1.potential,
    receiverPotential: localEvidence.d1.potential,
    cyclicRelayPotential: cyclicEvidence.b2.potential,
  };
}

/** Verifies one topology-dominant hub creates balanced vertical branch fields without widening its horizontal gradient. */
function assertDominantHubFlowFields() {
  const nodeIds = [
    "hub",
    "inbound-1", "inbound-2", "inbound-3", "inbound-4", "inbound-5", "inbound-6",
    "outbound-1", "outbound-2", "outbound-3", "outbound-4",
    "relay-in-1", "relay-in-2", "relay-out-1", "relay-out-2",
  ];
  const internalEdges = [
    { from: "relay-in-1", to: "inbound-1" },
    { from: "relay-in-2", to: "inbound-2" },
    ...Array.from({ length: 6 }, (_, index) => ({ from: `inbound-${index + 1}`, to: "hub" })),
    ...Array.from({ length: 4 }, (_, index) => ({ from: "hub", to: `outbound-${index + 1}` })),
    { from: "outbound-1", to: "relay-out-1" },
    { from: "outbound-2", to: "relay-out-2" },
  ];
  const entries = nodeIds.map((id) => ({ node: { id, graphColumn: 2 } }));
  assertCondition(
    applyContainerLocalFlowPlacement(entries, internalEdges, {
      containerId: "container:hub-fields",
      side: "right",
    }),
    "dominant-hub fixture should activate container-local flow placement",
  );
  const fieldNodes = entries.map(({ node }, index) => ({
    ...node,
    x: Number(node.graphColumn || 1) * 384,
    y: 128 + (index % 4) * 96,
    width: 192,
    height: 48,
  }));
  const originalXById = new Map(fieldNodes.map((node) => [node.id, node.x]));
  const composed = distributeGraphNodesWithinContainers(fieldNodes, [{
    id: "container:hub-fields",
    nodeIds,
  }], internalEdges);
  const hub = composed.find((node) => node.id === "hub");
  const branches = composed.filter((node) => node.id !== "hub");
  const fields = [...new Set(branches.map((node) => Number(node.containerFlowField)))]
    .sort((left, right) => left - right);
  const fieldBiases = fields.map((field) => ({
    field,
    bias: branches.find((node) => Number(node.containerFlowField) === field)?.containerFlowFieldBias,
    centerY: branches
      .filter((node) => Number(node.containerFlowField) === field)
      .reduce((sum, node, _, nodes) => sum + Number(node.y || 0) / nodes.length, 0),
  }));
  assertCondition(
    composed.every((node) => node.containerFlowModel === "container-local-hub-branch-fields-v2"),
    "every dominant-hub child should expose the v2 flow-field model",
    { composed },
  );
  assertCondition(
    fields.length === 4
      && Number(hub?.containerFlowHubDegree || 0) === 10
      && Number(hub?.containerFlowBranchCount || 0) === 10,
    "hub degree should produce four bounded fields from ten local branches",
    { hub, fields },
  );
  assertCondition(
    fieldBiases.every((entry, index) => index === 0 || entry.bias >= fieldBiases[index - 1].bias)
      && fieldBiases.every((entry, index) => index === 0 || entry.centerY > fieldBiases[index - 1].centerY),
    "branch fields should follow the incoming-to-outgoing topology gradient from top to bottom",
    { fieldBiases },
  );
  assertCondition(
    composed.every((node) => (
      Math.abs(Number(node.x || 0) - Number(originalXById.get(node.id) || 0)) <= GRAPH_ROUTE_GRID_CELL / 2
    )),
    "flow-field composition must preserve primary horizontal bands within grid-snapping tolerance",
    { originalXById: Object.fromEntries(originalXById), composed },
  );
  assertCondition(
    composed.every((node) => node.containerCompositionModel === "hub-branch-flow-fields-v2"),
    "dense container composition should preserve rather than restack v2 fields",
    { composed },
  );
  const breathingGap = GRAPH_ROUTE_GRID_CELL * 3;
  const breathingViolations = verticalBandSpacingViolations(composed, breathingGap);
  assertCondition(
    breathingViolations.length === 0,
    "same-band nodes in hub branch fields must retain three clear route-grid cells vertically",
    { breathingGap, violations: breathingViolations },
  );
  assertCondition(
    spacingViolations({ nodes: composed }, "generic:dominant-hub-flow-fields").length === 0,
    "hub branch fields must retain sibling clearance",
    { composed },
  );
  const disconnectedIds = ["hub", "near-1", "near-2", "near-3", "near-4", "near-5", "remote-1", "remote-2"];
  const disconnectedEntries = disconnectedIds.map((id) => ({ node: { id, graphColumn: 2 } }));
  const disconnectedEdges = [
    ...Array.from({ length: 5 }, (_, index) => ({ from: `near-${index + 1}`, to: "hub" })),
    { from: "remote-1", to: "remote-2" },
  ];
  assertCondition(
    applyContainerLocalFlowPlacement(disconnectedEntries, disconnectedEdges, {
      containerId: "container:disconnected-hub",
      side: "right",
    })
      && disconnectedEntries.every(({ node }) => node.containerFlowModel === "container-local-trophic-gradient-v1"),
    "a disconnected component must retain the v1 gradient rather than receive a false hub branch",
    { disconnectedEntries },
  );
  const fieldColumnOffsets = [...new Set(branches
    .map((node) => Number(node.containerFlowFieldColumnOffset))
    .filter(Number.isFinite))].sort((left, right) => left - right);
  const branchColumnOffsets = [...new Set(branches
    .map((node) => Number(node.containerFlowBranchColumnOffset))
    .filter(Number.isFinite))].sort((left, right) => left - right);
  assertCondition(
    fieldColumnOffsets.length >= 3
      && branchColumnOffsets.length >= 3
      && Math.max(...fieldColumnOffsets.map(Math.abs)) < 0.5
      && Math.max(...branchColumnOffsets.map(Math.abs)) <= 0.18,
    "branch fields should use bounded sibling subcolumns without crossing adjacent flow bands",
    { fieldColumnOffsets, branchColumnOffsets },
  );
  return {
    label: "generic:dominant-hub-flow-fields",
    nodes: composed.length,
    hubDegree: hub.containerFlowHubDegree,
    hubCoverage: hub.containerFlowHubCoverage,
    branches: hub.containerFlowBranchCount,
    fields: fields.length,
    fieldBiases,
    fieldColumnOffsets,
    branchColumnOffsets,
    disconnectedFallback: "container-local-trophic-gradient-v1",
    model: hub.containerFlowModel,
    compositionModel: hub.containerCompositionModel,
  };
}

/** Builds a dense single-column fixture that exercises deterministic overlap separation. */
function crowdedColumnProjection() {
  return {
    schema: "layout-spacing-audit",
    view: "generic-column",
    nodes: [
      { id: "root", label: "Root", kind: "kernel", graphSide: "root" },
      { id: "node-a", label: "Node A", kind: "memory", graphSide: "right", graphColumn: 1, graphLane: 0 },
      { id: "node-b", label: "Node B", kind: "memory", graphSide: "right", graphColumn: 1, graphLane: 0.08 },
      { id: "node-c", label: "Node C", kind: "memory", graphSide: "right", graphColumn: 1, graphLane: 0.16 },
      { id: "node-d", label: "Node D", kind: "memory", graphSide: "left", graphColumn: 1, graphLane: 0 },
      { id: "node-e", label: "Node E", kind: "memory", graphSide: "left", graphColumn: 1, graphLane: 0.08 },
    ],
    edges: [
      { from: "root", to: "node-a", kind: "relationship" },
      { from: "root", to: "node-b", kind: "relationship" },
      { from: "root", to: "node-c", kind: "relationship" },
      { from: "root", to: "node-d", kind: "relationship" },
      { from: "root", to: "node-e", kind: "relationship" },
    ],
  };
}

/** Builds a dense container fixture that exercises text reserve and child distribution. */
function crowdedContainerProjection() {
  return {
    schema: "layout-spacing-audit",
    view: "generic-container",
    nodes: [
      { id: "source", label: "Source", kind: "kernel", graphSide: "root" },
      { id: "group-a", label: "Group A", kind: "memory", graphSide: "right", graphColumn: 1, graphLane: 0 },
      { id: "group-b", label: "Group B", kind: "memory", graphSide: "right", graphColumn: 1, graphLane: 0.1 },
      { id: "group-c", label: "Group C", kind: "memory", graphSide: "right", graphColumn: 1, graphLane: 0.2 },
      { id: "group-d", label: "Group D", kind: "memory", graphSide: "right", graphColumn: 1, graphLane: 0.3 },
    ],
    edges: [
      { from: "source", to: "group-a", kind: "relationship" },
      { from: "group-a", to: "group-b", kind: "relationship" },
      { from: "group-b", to: "group-c", kind: "relationship" },
      { from: "group-c", to: "group-d", kind: "relationship" },
    ],
    containers: [
      {
        id: "container:group",
        kind: "container",
        label: "Crowded Generic Group",
        role: "audit",
        description: "Long enough description to reserve text space before child nodes are arranged.",
        nodeIds: ["group-a", "group-b", "group-c", "group-d"],
      },
    ],
  };
}

/** Builds a fixture where two containers claim one node to test canonical first ownership. */
function duplicateContainerMembershipProjection() {
  return {
    schema: "layout-spacing-audit",
    view: "duplicate-container-membership",
    nodes: [
      { id: "root", label: "Root", kind: "kernel", graphSide: "root" },
      { id: "shared", label: "Shared Node", kind: "memory", graphSide: "right", graphColumn: 1, graphLane: 0 },
      { id: "first-only", label: "First Only", kind: "memory", graphSide: "right", graphColumn: 1, graphLane: 1 },
      { id: "second-only", label: "Second Only", kind: "memory", graphSide: "right", graphColumn: 2, graphLane: 1 },
    ],
    edges: [
      { from: "root", to: "shared", kind: "relationship" },
      { from: "shared", to: "first-only", kind: "relationship" },
      { from: "shared", to: "second-only", kind: "relationship" },
    ],
    containers: [
      {
        id: "container:first",
        kind: "container",
        label: "First Owner",
        role: "audit",
        description: "First declared container owns the shared node.",
        nodeIds: ["shared", "first-only"],
      },
      {
        id: "container:second",
        kind: "container",
        label: "Second Owner",
        role: "audit",
        description: "Second declared container must not stretch around the shared node.",
        nodeIds: ["shared", "second-only"],
      },
    ],
  };
}

/** Builds a routed fixture with one node positioned by persisted manual coordinates. */
function manualOverrideProjection() {
  return {
    schema: "layout-spacing-audit",
    view: "manual-overrides",
    nodes: [
      { id: "source", label: "Source", kind: "kernel", graphSide: "root" },
      { id: "manual-a", label: "Manual A", kind: "memory", graphSide: "right", graphColumn: 1, graphLane: 0 },
      { id: "manual-b", label: "Manual B", kind: "memory", graphSide: "right", graphColumn: 1, graphLane: 1 },
    ],
    edges: [
      { from: "source", to: "manual-a", kind: "relationship" },
      { from: "manual-a", to: "manual-b", kind: "relationship" },
    ],
  };
}

/** Verifies duplicate membership keeps the node in exactly one canonical container. */
function assertDuplicateContainerMembership() {
  const projection = duplicateContainerMembershipProjection();
  const viewModel = buildIllustrationGraphViewModel({
    memoryGraph: projection,
    presentationMode: "compact",
    routeMode: "speed",
  });
  const firstContainer = viewModel.containers.find((container) => normalizeId(container.id) === normalizeId("container:first"));
  const secondContainer = viewModel.containers.find((container) => normalizeId(container.id) === normalizeId("container:second"));
  assertCondition(
    firstContainer?.nodeIds?.includes(normalizeId("shared")),
    "first declared container should keep the duplicate child",
    { firstContainer },
  );
  assertCondition(
    !secondContainer?.nodeIds?.includes(normalizeId("shared")),
    "later containers must not keep duplicate child ownership",
    { secondContainer },
  );
  const bounds = graphVisibleContentBounds(viewModel);
  assertCondition(
    bounds.width <= GRAPH_ROUTE_GRID_CELL * 28 && bounds.height <= GRAPH_ROUTE_GRID_CELL * 22,
    "duplicate container membership must not inflate room composition bounds",
    { bounds, width: viewModel.width, height: viewModel.height },
  );
  return {
    label: "generic:duplicate-container-membership",
    nodes: viewModel.nodes.length,
    edges: viewModel.edges.length,
    containers: viewModel.containers.length,
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  };
}

/** Builds a container-boundary fixture that requires representative compound-edge routing. */
function compoundContainerRoutingProjection() {
  return {
    schema: "layout-spacing-audit",
    view: "generic-compound-routing",
    nodes: [
      { id: "source", label: "Source", kind: "kernel", graphSide: "root" },
      { id: "group-entry", label: "Group Entry", kind: "memory", graphSide: "right", graphColumn: 1, graphLane: 0 },
      { id: "group-a", label: "Group A", kind: "memory", graphSide: "right", graphColumn: 1, graphLane: 1 },
      { id: "group-b", label: "Group B", kind: "memory", graphSide: "right", graphColumn: 1, graphLane: 2 },
      { id: "group-c", label: "Group C", kind: "memory", graphSide: "right", graphColumn: 1, graphLane: 3 },
    ],
    edges: [
      { from: "source", to: "group-entry", kind: "observes_group" },
      { from: "group-entry", to: "group-a", kind: "decision_flow" },
      { from: "group-a", to: "group-b", kind: "decision_flow" },
      { from: "group-b", to: "group-c", kind: "decision_flow" },
    ],
    containers: [
      {
        id: "container:group",
        kind: "container",
        label: "Generic Routed Group",
        role: "audit",
        description: "Boundary-crossing edges route to the container when topology proves a representative entry.",
        nodeIds: ["group-entry", "group-a", "group-b", "group-c"],
      },
    ],
  };
}

/** Builds a provider-shaped fixture whose authority addresses an expanded source-group container directly. */
function directContainerEndpointProjection() {
  return {
    schema: "layout-spacing-audit",
    view: "generic-direct-container-endpoint",
    nodes: [
      { id: "repository", label: "Repository", kind: "architecture_project_repo", graphSide: "root" },
      { id: "source-a", label: "Source A", kind: "architecture_source", graphSide: "right", graphColumn: 1, graphLane: 0 },
      { id: "source-b", label: "Source B", kind: "architecture_source", graphSide: "right", graphColumn: 1, graphLane: 1 },
    ],
    edges: [
      { from: "repository", to: "container:source-group", kind: "contains_source_group" },
      { from: "source-a", to: "source-b", kind: "source_import" },
    ],
    containers: [
      {
        id: "container:source-group",
        kind: "architecture_source_group",
        label: "lib/core",
        role: "repository source group",
        description: "A provider-owned structural group remains a logical relationship endpoint while expanded.",
        nodeIds: ["source-a", "source-b"],
      },
    ],
  };
}

/** Builds a fixture where a collapsed container becomes one visible routing endpoint. */
function collapsedContainerProjection() {
  return {
    schema: "layout-spacing-audit",
    view: "generic-collapsed-container",
    nodes: [
      { id: "source", label: "Source", kind: "kernel", graphSide: "root" },
      { id: "inside-a", label: "Inside A", kind: "memory", graphSide: "right", graphColumn: 1, graphLane: 0 },
      { id: "inside-b", label: "Inside B", kind: "memory", graphSide: "right", graphColumn: 1, graphLane: 1 },
      { id: "outside", label: "Outside", kind: "memory", graphSide: "right", graphColumn: 2, graphLane: 0 },
    ],
    edges: [
      { from: "source", to: "inside-a", kind: "observes_group" },
      { from: "inside-b", to: "outside", kind: "decision_flow" },
      { from: "inside-a", to: "inside-b", kind: "decision_flow" },
    ],
    containers: [
      {
        id: "container:collapsed-group",
        kind: "container",
        label: "Collapsed Group",
        role: "audit",
        description: "Collapsed containers render as routable nodes.",
        collapsed: true,
        nodeIds: ["inside-a", "inside-b"],
      },
    ],
  };
}

/** Builds a branched timing chain used to test selection and active-path emphasis. */
function branchedSignalFlowProjection() {
  return {
    schema: "layout-spacing-audit",
    view: "generic-signal-flow",
    nodes: [
      { id: "router", label: "Router", kind: "kernel", graphSide: "root" },
      { id: "a-start", label: "A Start", kind: "memory", graphSide: "right", graphColumn: 1, graphLane: -1 },
      { id: "a-middle", label: "A Middle", kind: "memory", graphSide: "right", graphColumn: 2, graphLane: -1 },
      { id: "a-end", label: "A End", kind: "memory", graphSide: "right", graphColumn: 3, graphLane: -1 },
      { id: "b-start", label: "B Start", kind: "memory", graphSide: "right", graphColumn: 1, graphLane: 1 },
      { id: "b-end", label: "B End", kind: "memory", graphSide: "right", graphColumn: 2, graphLane: 1 },
    ],
    edges: [
      { from: "router", to: "a-start", kind: "signal_flow" },
      { from: "a-start", to: "a-middle", kind: "signal_flow" },
      { from: "a-middle", to: "a-end", kind: "signal_flow" },
      { from: "router", to: "b-start", kind: "signal_flow" },
      { from: "b-start", to: "b-end", kind: "signal_flow" },
    ],
  };
}

/** Formats an edge's endpoints into the stable key used by signal-flow assertions. */
function edgeKey(edge = {}) {
  return `${normalizeId(edge.from)}->${normalizeId(edge.to)}`;
}

/** Verifies selecting a node activates only its deterministic upstream and downstream chain. */
function assertSignalFlowSelection() {
  const viewModel = buildIllustrationGraphViewModel({
    memoryGraph: branchedSignalFlowProjection(),
    presentationMode: "compact",
    routeMode: "speed",
    selectedNodeId: "a-middle",
  });
  const activeEdges = new Set(viewModel.edges.filter((edge) => edge.activeChain).map(edgeKey));
  const activeNodes = new Set(viewModel.nodes.filter((node) => node.activeChain).map((node) => normalizeId(node.id)));
  const expectedEdges = ["ROUTER->A-START", "A-START->A-MIDDLE", "A-MIDDLE->A-END"];
  const blockedEdges = ["ROUTER->B-START", "B-START->B-END"];
  expectedEdges.forEach((key) => {
    assertCondition(activeEdges.has(key), "selected node should highlight complete upstream/downstream signal flow", {
      missing: key,
      activeEdges: [...activeEdges],
    });
  });
  blockedEdges.forEach((key) => {
    assertCondition(!activeEdges.has(key), "selected branch should not highlight sibling flow through shared router", {
      unexpected: key,
      activeEdges: [...activeEdges],
    });
  });
  ["ROUTER", "A-START", "A-MIDDLE", "A-END"].forEach((nodeId) => {
    assertCondition(activeNodes.has(nodeId), "selected signal flow should activate every node on the branch", {
      missing: nodeId,
      activeNodes: [...activeNodes],
    });
  });
  assertCondition(!activeNodes.has("B-START") && !activeNodes.has("B-END"), "sibling branch nodes should remain inactive", {
    activeNodes: [...activeNodes],
  });
  return {
    label: "generic:signal-flow-selection",
    nodes: viewModel.nodes.length,
    edges: viewModel.edges.length,
    activeEdges: activeEdges.size,
  };
}

/** Verifies an unselected view model has no selected nodes or active signal chain. */
function assertDefaultNoSelection() {
  const viewModel = buildIllustrationGraphViewModel({
    memoryGraph: branchedSignalFlowProjection(),
    presentationMode: "compact",
    routeMode: "speed",
  });
  const selectedNodes = viewModel.nodes.filter((node) => node.selected);
  const activeNodes = viewModel.nodes.filter((node) => node.activeChain);
  const activeEdges = viewModel.edges.filter((edge) => edge.activeChain);
  assertCondition(selectedNodes.length === 0, "default view model should not select a node", {
    selectedNodes: selectedNodes.map((node) => node.id),
  });
  assertCondition(activeNodes.length === 0 && activeEdges.length === 0, "default view model should not highlight a signal flow", {
    activeNodes: activeNodes.map((node) => node.id),
    activeEdges: activeEdges.map(edgeKey),
  });
  return {
    label: "generic:default-no-selection",
    nodes: viewModel.nodes.length,
    edges: viewModel.edges.length,
  };
}

/** Verifies manual node geometry uses bounded routing budgets and stable grid snapshots. */
function assertManualLayoutUsesBoundedRouting() {
  const viewModel = buildIllustrationGraphViewModel({
    memoryGraph: manualOverrideProjection(),
    presentationMode: "compact",
    routeMode: "speed",
    nodePositions: {
      "manual-a": { x: 640, y: 384 },
      "manual-b": { x: 640, y: 384 },
    },
  });
  const routeBudgets = [...new Set(viewModel.edges.map((edge) => String(edge.routeBudget || "")))].sort();
  assertCondition(routeBudgets.length === 1 && routeBudgets[0] === "bounded", "manual layout rerouting should use bounded route budget", {
    routeBudgets,
    edges: viewModel.edges.map((edge) => ({
      id: edge.id,
      routeBudget: edge.routeBudget,
      routeModel: edge.routeModel,
    })),
  });
  return {
    label: "generic:manual-layout-bounded-routing",
    nodes: viewModel.nodes.length,
    edges: viewModel.edges.length,
    routeBudget: routeBudgets[0],
  };
}

/** Verifies a dragged node retains its exact manual position after view-model rebuilding. */
function assertManualLayoutRetainsDroppedPosition() {
  const initialViewModel = buildIllustrationGraphViewModel({
    memoryGraph: manualOverrideProjection(),
    presentationMode: "compact",
    routeMode: "speed",
  });
  const targetPosition = { x: 640, y: 384 };
  const storedPosition = {
    x: targetPosition.x + Number(initialViewModel.normalizationOffset?.x || 0),
    y: targetPosition.y + Number(initialViewModel.normalizationOffset?.y || 0),
  };
  const viewModel = buildIllustrationGraphViewModel({
    memoryGraph: manualOverrideProjection(),
    presentationMode: "compact",
    routeMode: "speed",
    nodePositions: {
      "manual-a": storedPosition,
    },
  });
  const manualNode = viewModel.nodes.find((node) => node.id === normalizeId("manual-a"));
  // A settled reroute may change the fit envelope by a few edge-padding pixels;
  // the visible drop must stay within one quarter-cell and never jump a route cell.
  assertCondition(manualNode?.positionSource === "manual-layout", "manual layout should mark the moved node as user-positioned", {
    manualNode,
    storedPosition,
  });
  assertCondition(
    Math.abs(Number(manualNode?.x) - targetPosition.x) <= MANUAL_DROP_OPTICAL_TOLERANCE
      && Math.abs(Number(manualNode?.y) - targetPosition.y) <= MANUAL_DROP_OPTICAL_TOLERANCE,
    "manual layout should retain the rendered drop within optical snap tolerance",
    {
      targetPosition,
      storedPosition,
      actualPosition: manualNode ? { x: manualNode.x, y: manualNode.y } : null,
      normalizationOffset: initialViewModel.normalizationOffset,
      manualDropTolerance: MANUAL_DROP_OPTICAL_TOLERANCE,
    },
  );
  return {
    label: "generic:manual-layout-retains-drop",
    node: manualNode.id,
    x: manualNode.x,
    y: manualNode.y,
  };
}

/** Verifies manual coordinates override compatible precomputed geometry without full relayout. */
function assertPrecomputedProjectionHonorsManualLayout() {
  const projection = manualOverrideProjection();
  const precomputedViewModel = buildIllustrationGraphViewModel({
    memoryGraph: projection,
    presentationMode: "compact",
    routeMode: "speed",
  });
  const targetPosition = { x: 672, y: 416 };
  const storedPosition = {
    x: targetPosition.x + Number(precomputedViewModel.normalizationOffset?.x || 0),
    y: targetPosition.y + Number(precomputedViewModel.normalizationOffset?.y || 0),
  };
  const viewModel = buildIllustrationGraphViewModel({
    memoryGraph: {
      ...projection,
      viewModel: precomputedViewModel,
    },
    presentationMode: "compact",
    routeMode: "speed",
    nodePositions: {
      "manual-a": storedPosition,
    },
  });
  const manualNode = viewModel.nodes.find((node) => node.id === normalizeId("manual-a"));
  assertCondition(viewModel.precomputed !== true, "manual layout should bypass precomputed geometry when raw projection data is available", {
    precomputed: viewModel.precomputed,
  });
  assertCondition(
    Math.abs(Number(manualNode?.x) - targetPosition.x) <= MANUAL_DROP_OPTICAL_TOLERANCE
      && Math.abs(Number(manualNode?.y) - targetPosition.y) <= MANUAL_DROP_OPTICAL_TOLERANCE,
    "precomputed projections with raw data should retain manual drops within optical snap tolerance",
    {
      targetPosition,
      storedPosition,
      actualPosition: manualNode ? { x: manualNode.x, y: manualNode.y } : null,
      manualDropTolerance: MANUAL_DROP_OPTICAL_TOLERANCE,
    },
  );
  return {
    label: "generic:precomputed-manual-layout",
    node: manualNode.id,
    x: manualNode.x,
    y: manualNode.y,
  };
}

/** Verifies session nodes and containers expose current, attention, context, and past emphasis. */
function assertSessionVisualEmphasis() {
  const projection = sessionGraph({
    observedSessions: [
      {
        id: "older",
        title: "Older session",
        status: "completed",
        startedAt: "2026-06-24T10:00:00Z",
        completedAt: "2026-06-24T12:00:00Z",
        toolCallCount: 12,
        generatedSummary: {
          summary: "Older session summary.",
          decisions: [
            { label: "Older first decision", text: "Older session first generated decision." },
            { label: "Older final decision", text: "Older session final generated decision." },
          ],
        },
      },
      {
        id: "newer",
        title: "Newer session",
        status: "active",
        startedAt: "2026-06-26T10:00:00Z",
        latestUserAt: "2026-06-26T11:30:00Z",
        toolCallCount: 34,
        generatedSummary: {
          summary: "Newer session summary.",
          decisions: [
            { label: "Newer first decision", text: "Newer session first generated decision." },
            { label: "Newer final decision", text: "Newer session final generated decision." },
          ],
        },
      },
      {
        id: "attention",
        title: "Attention session",
        status: "completed",
        startedAt: "2026-06-20T10:00:00Z",
        completedAt: "2026-06-20T11:00:00Z",
        toolCallCount: 8,
        memoryImpact: {
          label: "memory update not scanned",
          status: "unscanned",
          reason: "Memory update needs review.",
        },
        generatedSummary: {
          summary: "Attention session summary.",
          decisions: [
            { label: "Attention decision", text: "Attention session generated decision." },
          ],
        },
      },
    ],
  }, { nowMs: Date.parse("2026-06-26T12:00:00Z") });
  const viewModel = buildIllustrationGraphViewModel({
    memoryGraph: projection,
    presentationMode: "compact",
    routeMode: "speed",
  });
  const emphasizedNodes = viewModel.nodes.filter((node) => String(node.visualEmphasis || "").trim());
  const currentNodes = emphasizedNodes.filter((node) => node.visualEmphasis === "current");
  const attentionNodes = emphasizedNodes.filter((node) => node.visualEmphasis === "attention");
  const contextNodes = emphasizedNodes.filter((node) => node.visualEmphasis === "context");
  const pastNodes = emphasizedNodes.filter((node) => node.visualEmphasis === "past");
  assertCondition(currentNodes.length === 1, "active sessions should expose one current terminal signal point", {
    currentNodes: currentNodes.map((node) => node.id),
    emphasizedNodes: emphasizedNodes.map((node) => [node.id, node.visualEmphasis]),
  });
  assertCondition(
    currentNodes[0].id === normalizeId("workstream:session-newer:mutation-2"),
    "current session emphasis should land on the active terminal generated decision",
    { currentNode: currentNodes[0] },
  );
  assertCondition(attentionNodes.length === 1, "attention sessions should expose one attention terminal signal point", {
    attentionNodes: attentionNodes.map((node) => node.id),
    emphasizedNodes: emphasizedNodes.map((node) => [node.id, node.visualEmphasis]),
  });
  assertCondition(
    attentionNodes[0].id === normalizeId("workstream:session-attention:memory-impact"),
    "attention emphasis should land on the memory-impact terminal point",
    { attentionNode: attentionNodes[0] },
  );
  assertCondition(contextNodes.length >= 2, "active or attention session context nodes should remain visible as context", {
    contextNodes: contextNodes.map((node) => node.id),
    emphasizedNodes: emphasizedNodes.map((node) => [node.id, node.visualEmphasis]),
  });
  assertCondition(pastNodes.length >= 1, "closed sessions without recent attention should remain past", {
    pastNodes: pastNodes.map((node) => node.id),
    emphasizedNodes: emphasizedNodes.map((node) => [node.id, node.visualEmphasis]),
  });
  const sessionContainer = viewModel.containers.find((container) => container.id === "container:workstream:session-newer");
  assertCondition(
    String(sessionContainer?.role || "").includes("34 operations"),
    "session container metadata should expose operation count",
    { role: sessionContainer?.role },
  );
  assertCondition(
    String(sessionContainer?.metadata?.currentObjective || "").includes("Newer session final generated decision"),
    "session container metadata should expose the generated current point",
    { metadata: sessionContainer?.metadata },
  );
  assertCondition(
    sessionContainer?.visualEmphasis === "active" && sessionContainer?.metadata?.activityState === "active",
    "active session container should preserve lifecycle emphasis",
    { container: sessionContainer },
  );
  const attentionContainer = viewModel.containers.find((container) =>
    container.id === "container:workstream:session-attention"
  );
  assertCondition(
    attentionContainer?.visualEmphasis === "attention" && attentionContainer?.metadata?.activityState === "attention",
    "attention session container should preserve lifecycle emphasis",
    { container: attentionContainer },
  );
  return {
    label: "generic:sessions-lifecycle-emphasis",
    nodes: viewModel.nodes.length,
    current: currentNodes[0].id,
    attention: attentionNodes[0].id,
    context: contextNodes.length,
    past: pastNodes.length,
  };
}

/** Verifies cross-container edges use internal representatives and remain outside child obstacles. */
function assertCompoundContainerRouting() {
  const viewModel = buildIllustrationGraphViewModel({
    memoryGraph: compoundContainerRoutingProjection(),
    presentationMode: "compact",
    routeMode: "speed",
  });
  const compoundEdge = viewModel.edges.find((edge) => edge.relationshipKind === "observes_group");
  assertCondition(Boolean(compoundEdge), "compound routing projection should render the boundary edge");
  assertCondition(compoundEdge.to === normalizeId("group-entry"), "compound routing must preserve logical target node", {
    edge: compoundEdge,
  });
  assertCondition(
    compoundEdge.routeTo === normalizeId("container-route:container:group"),
    "boundary edge should route to representative container boundary",
    { edge: compoundEdge },
  );
  assertCondition(
    compoundEdge.compoundTargetContainerId === normalizeId("container:group"),
    "boundary edge should annotate the target container",
    { edge: compoundEdge },
  );
  assertCondition(
    viewModel.nodes.every((node) => node.routeProxy !== true),
    "container route proxies must not be visible graph nodes",
  );
  return {
    label: "generic:compound-routing",
    nodes: viewModel.nodes.length,
    edges: viewModel.edges.length,
    containers: viewModel.containers.length,
    routedTo: compoundEdge.routeTo,
  };
}

/** Verifies provider-authored edges to expanded containers survive as logical edges routed through hidden proxies. */
function assertDirectContainerEndpointRouting() {
  const viewModel = buildIllustrationGraphViewModel({
    memoryGraph: directContainerEndpointProjection(),
    presentationMode: "compact",
    routeMode: "speed",
  });
  const groupEdge = viewModel.edges.find((edge) => edge.relationshipKind === "contains_source_group");
  assertCondition(Boolean(groupEdge), "direct expanded-container relationship should survive projection and routing");
  assertCondition(groupEdge.to === normalizeId("container:source-group"), "direct container edge must preserve its logical target", {
    edge: groupEdge,
  });
  assertCondition(
    groupEdge.routeTo === normalizeId("container-route:container:source-group"),
    "direct container edge should route through the hidden container boundary proxy",
    { edge: groupEdge },
  );
  assertCondition(
    groupEdge.compoundTargetContainerId === normalizeId("container:source-group"),
    "direct container edge should expose its compound target container",
    { edge: groupEdge },
  );
  return {
    label: "generic:direct-container-endpoint",
    nodes: viewModel.nodes.length,
    edges: viewModel.edges.length,
    containers: viewModel.containers.length,
    routedTo: groupEdge.routeTo,
  };
}

/** Verifies collapsed containers replace hidden children and receive all external relationships. */
function assertCollapsedContainerRouting() {
  const viewModel = buildIllustrationGraphViewModel({
    memoryGraph: collapsedContainerProjection(),
    presentationMode: "compact",
    routeMode: "speed",
  });
  const nodeIds = new Set(viewModel.nodes.map((node) => normalizeId(node.id)));
  assertCondition(nodeIds.has(normalizeId("container:collapsed-group")), "collapsed container should render as a node", {
    nodeIds: [...nodeIds],
  });
  assertCondition(!nodeIds.has(normalizeId("inside-a")) && !nodeIds.has(normalizeId("inside-b")), "collapsed container children should not render as separate nodes", {
    nodeIds: [...nodeIds],
  });
  assertCondition(viewModel.containers.every((container) => normalizeId(container.id) !== normalizeId("container:collapsed-group")), "collapsed container should not also render as a container box", {
    containers: viewModel.containers.map((container) => container.id),
  });
  const edgeKeys = viewModel.edges.map(edgeKey);
  assertCondition(edgeKeys.includes("SOURCE->CONTAINER:COLLAPSED-GROUP"), "incoming child edge should route to collapsed container node", {
    edgeKeys,
  });
  assertCondition(edgeKeys.includes("CONTAINER:COLLAPSED-GROUP->OUTSIDE"), "outgoing child edge should route from collapsed container node", {
    edgeKeys,
  });
  assertCondition(!edgeKeys.some((key) => key.includes("INSIDE-A") || key.includes("INSIDE-B")), "collapsed internal child ids should not leak into rendered edges", {
    edgeKeys,
  });
  return {
    label: "generic:collapsed-container-routing",
    nodes: viewModel.nodes.length,
    edges: viewModel.edges.length,
    containers: viewModel.containers.length,
  };
}

/** Resolves a provider endpoint against the configured Atlas base URL for live checks. */
function absoluteEndpoint(path) {
  const base = String(process.env.ATLAS_BASE_URL || "http://127.0.0.1:8765").replace(/\/$/, "");
  return `${base}${path}`;
}

/** Fetches configured live categories and records their spacing and routing audit results. */
async function liveProjectionReport() {
  const categoryArg = process.argv.find((arg) => arg.startsWith("--category="));
  const selectedCategory = categoryArg ? categoryArg.split("=").slice(1).join("=").trim() : "";
  const liveCategories = ATLAS_SOURCE_CATEGORIES.map((category) => [category.id, category.endpoint]);
  const entries = selectedCategory
    ? liveCategories.filter(([category]) => category === selectedCategory)
    : liveCategories;
  assertCondition(entries.length > 0, "unknown live category", {
    selectedCategory,
    categories: ATLAS_SOURCE_CATEGORIES.map((category) => category.id),
  });
  const reports = [];
  for (const [category, path] of entries) {
    const projection = await fetchAtlasGraphForCategory(category, {
      endpoint: absoluteEndpoint(path),
    });
    reports.push(assertSpacing(projection, atlasGraphViewOptions(projection), `live:${category}`));
  }
  return reports;
}

/** Fetches requested provider-owned Architecture rooms and audits them through the local Graph pipeline. */
async function liveArchitectureRoomReport() {
  const roomArg = process.argv.find((arg) => arg.startsWith("--architecture-rooms="));
  const roomIds = String(roomArg?.split("=").slice(1).join("=") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const reports = [];
  for (const roomId of roomIds) {
    const projection = await fetchAtlasArchitectureRoomGraph({
      currentArchitectureRoom: roomId,
      precompute: false,
      baseUrl: String(process.env.ATLAS_BASE_URL || "http://127.0.0.1:8765"),
    });
    reports.push(assertSpacing(projection, atlasGraphViewOptions(projection), `live:architecture:${roomId}`));
  }
  return reports;
}

/** Runs all deterministic fixtures plus optional live projection spacing checks. */
async function main() {
  const reports = [
    assertSpacing(crowdedColumnProjection(), {}, "generic:crowded-column"),
    assertSpacing(crowdedContainerProjection(), {}, "generic:crowded-container"),
    assertDenseContainerComposition(),
    assertContainerLocalFlowGradient(),
    assertDominantHubFlowFields(),
    assertDuplicateContainerMembership(),
    assertSpacing(manualOverrideProjection(), {
      nodePositions: {
        "manual-a": { x: 640, y: 384 },
        "manual-b": { x: 832, y: 512 },
      },
    }, "generic:manual-overrides"),
    assertDefaultNoSelection(),
    assertManualLayoutUsesBoundedRouting(),
    assertManualLayoutRetainsDroppedPosition(),
    assertPrecomputedProjectionHonorsManualLayout(),
    assertSignalFlowSelection(),
    assertSessionVisualEmphasis(),
    assertCompoundContainerRouting(),
    assertDirectContainerEndpointRouting(),
    assertCollapsedContainerRouting(),
  ];

  if (process.argv.includes("--live")) {
    reports.push(...await liveProjectionReport());
  }
  if (process.argv.some((arg) => arg.startsWith("--architecture-rooms="))) {
    reports.push(...await liveArchitectureRoomReport());
  }

  console.log(JSON.stringify({
    ok: true,
    minGap: GRAPH_ROUTE_GRID_CELL,
    projections: reports,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    message: error.message,
    details: error.details || null,
  }, null, 2));
  process.exit(1);
});
