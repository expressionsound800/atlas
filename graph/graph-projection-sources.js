/*
 * Projection Sources adapt provider packets into the neutral graph projection
 * contract while keeping category-specific facts at the source boundary.
 */
import {
  normalizeId,
  normalizeKind,
} from "./graph-geometry.js";

/** Converts a machine relationship kind into a readable edge label. */
function labelFromRelationshipKind(kind) {
  return String(kind || "relationship").trim().replace(/[_-]+/g, " ");
}

/** Maps memory relationship vocabulary to the Graph edge-kind presentation contract. */
function graphEdgeKindFromMemoryRelationship(kind) {
  const relationshipKind = String(kind || "").trim().toLowerCase();
  if (relationshipKind === "routes_to") return "timing";
  if (relationshipKind === "answered_by"
    || relationshipKind === "checks"
    || relationshipKind === "guards"
    || relationshipKind === "requires"
    || relationshipKind === "authorizes"
  ) return "control";
  return "binding";
}

/** Selects line and arrow styling that distinguishes relationship semantics visually. */
function graphEdgeVisualStyleFromMemoryRelationship(kind) {
  const relationshipKind = String(kind || "").trim().toLowerCase();
  if (relationshipKind === "guards" || relationshipKind === "requires") return "support";
  if (relationshipKind === "reports_status_to" || relationshipKind === "projects_to") return "return";
  if (relationshipKind === "routes_to" || relationshipKind === "answered_by") return "reference";
  return "primary";
}

/** Derives a stable left, right, or neutral placement side from memory-node semantics. */
function graphSideForMemoryGraphNode(node = {}) {
  const configuredSide = String(node?.graphSide || "").trim().toLowerCase();
  if (["root", "left", "right", "radial"].includes(configuredSide)) return configuredSide;
  const id = String(node?.id || "").trim();
  const kind = String(node?.kind || "").trim().toLowerCase();
  if (id === "kernel" || kind === "kernel") return "root";
  if (kind === "stem") return "left";
  return "right";
}

/** Translates memory records into visible Graph nodes, containers, and relationship edges. */
export function graphProjectionSources(projection = null, options = {}) {
  const sourceProjection = projection && Array.isArray(projection.nodes) && Array.isArray(projection.edges)
    ? projection
    : { nodes: [], edges: [] };
  const placementById = options.placementById || {};
  const routeBudget = String(options.routeBudget || "").trim();
  const sourceContainers = Array.isArray(options.containers) ? options.containers : [];
  const containers = sourceContainers.map((container) => ({
    id: String(container.id || "").trim(),
    kind: normalizeKind(container.kind || "container"),
    label: String(container.label || "").trim(),
    role: String(container.role || "").trim(),
    description: String(container.description || "").trim(),
    collapsed: container.collapsed === true,
    renderAsNode: container.renderAsNode === true || container.collapsed === true,
    visualEmphasis: String(container.visualEmphasis || container?.metadata?.activityState || "").trim(),
    metadata: container.metadata && typeof container.metadata === "object" ? { ...container.metadata } : {},
    nodeIds: (Array.isArray(container.nodeIds) ? container.nodeIds : []).map(normalizeId),
  })).filter((container) =>
    container.nodeIds.some((nodeId) =>
      sourceProjection.nodes.some((node) => normalizeId(node.id) === nodeId)
    )
  ).map((container) => ({
    ...container,
    nodeIds: container.nodeIds.filter((nodeId) =>
      sourceProjection.nodes.some((node) => normalizeId(node.id) === nodeId)
    ),
  }));
  const collapsedContainerByChildId = new Map();
  for (const container of containers) {
    if (!container.renderAsNode) continue;
    for (const nodeId of container.nodeIds) {
      collapsedContainerByChildId.set(nodeId, normalizeId(container.id));
    }
  }
  const visibleContainers = containers.filter((container) => !container.renderAsNode);
  const sourceNodes = sourceProjection.nodes
    .filter((node) => !collapsedContainerByChildId.has(normalizeId(node.id)))
    .map((node, index) => {
    const placedNode = {
      ...node,
      ...(placementById[String(node.id || "").trim()] || {}),
    };
    const originalGraphSide = graphSideForMemoryGraphNode(placedNode);
    return {
      id: placedNode.id,
      memoryKind: placedNode.kind,
      label: placedNode.label,
      layer: placedNode.layer,
      source: placedNode.source,
      description: placedNode.description,
      metadata: placedNode.metadata && typeof placedNode.metadata === "object" ? { ...placedNode.metadata } : {},
      visualEmphasis: String(placedNode.visualEmphasis || "").trim(),
      graphSide: originalGraphSide,
      graphColumn: placedNode.graphColumn,
      graphLane: placedNode.graphLane,
      sourceHidden: true,
      selected: placedNode.id === "kernel",
      graphOrder: index,
    };
  });
  const containerNodes = containers
    .filter((container) => container.renderAsNode)
    .map((container, index) => ({
      id: container.id,
      memoryKind: container.kind || "container",
      kind: container.kind || "container",
      label: container.label,
      layer: container.role || container.kind || "container",
      source: "",
      description: container.description,
      metadata: {
        ...(container.metadata || {}),
        childCount: container.nodeIds.length,
        collapsedContainer: true,
      },
      visualEmphasis: container.visualEmphasis,
      graphSide: graphSideForMemoryGraphNode(container),
      graphColumn: container.graphColumn,
      graphLane: container.graphLane,
      sourceHidden: true,
      selected: false,
      graphOrder: sourceNodes.length + index,
      collapsedContainer: true,
    }));
  const nodes = [...sourceNodes, ...containerNodes];
  // Expanded containers are logical Graph endpoints even though they are not
  // rendered as node buttons. Keeping them in the endpoint set preserves
  // provider-authored authority-to-group and cross-container relationships.
  const elementIds = new Set([
    ...nodes.map((node) => normalizeId(node.id)),
    ...visibleContainers.map((container) => normalizeId(container.id)),
  ]);
  /** Resolves a collapsed child endpoint to its visible container representative when needed. */
  const edgeEndpoint = (id) => {
    const normalized = normalizeId(id);
    return collapsedContainerByChildId.get(normalized) || normalized;
  };
  const edges = sourceProjection.edges
    .map((edge) => ({
      ...edge,
      from: edgeEndpoint(edge.from),
      to: edgeEndpoint(edge.to),
    }))
    .filter((edge) => edge.from !== edge.to && elementIds.has(edge.from) && elementIds.has(edge.to))
    .map((edge, index) => ({
      id: String(edge.id || "").trim() || `memory-v2:${index + 1}:${edge.from}:${edge.to}:${edge.kind}`,
      kind: graphEdgeKindFromMemoryRelationship(edge.kind),
      from: edge.from,
      to: edge.to,
      label: String(edge.label || "").trim() || labelFromRelationshipKind(edge.kind),
      relationshipKind: String(edge.kind || "").trim().toLowerCase(),
      visualStyle: String(edge.visualStyle || "").trim() || graphEdgeVisualStyleFromMemoryRelationship(edge.kind),
      description: edge.description || "",
      minimizeNodeCollision: true,
      routeBudget,
    }));
  return { nodes, edges, containers: visibleContainers };
}
