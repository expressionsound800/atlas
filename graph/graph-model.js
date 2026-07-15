/*
 * Graph Model validates and normalizes source-neutral nodes, edges, containers,
 * metadata, and view state before layout or rendering consumes them.
 */
import { normalizeId, normalizeKind } from "./graph-geometry.js";
import { GRAPH_ROUTE_GRID_CELL } from "./graph-grid.js";

export const GRAPH_MODEL_GRID_CELL = GRAPH_ROUTE_GRID_CELL;
export const GRAPH_MODEL_MIN_ELEMENT_GAP_CELLS = 1;
export const GRAPH_MODEL_MIN_ELEMENT_GAP = GRAPH_MODEL_GRID_CELL * GRAPH_MODEL_MIN_ELEMENT_GAP_CELLS;

/** Normalizes model text and supplies a stable fallback for missing display values. */
function compactText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

/** Returns model arrays unchanged and treats all other provider shapes as empty. */
function listFrom(value) {
  return Array.isArray(value) ? value : [];
}

/** Normalizes an optional model identifier without creating a replacement identifier. */
function normalizeOptionalId(value) {
  const id = normalizeId(value);
  return id || "";
}

/** Normalizes and deduplicates referenced model identifiers in first-seen order. */
function uniqueIds(values = []) {
  const seen = new Set();
  const ids = [];
  for (const value of values) {
    const id = normalizeOptionalId(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** Converts a grid dimension to a positive whole-cell count or leaves it unspecified. */
function normalizeGridCellCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.ceil(count) : null;
}

/** Normalizes optional layout size hints into finite positive width and height fields. */
function normalizeElementBox(source = {}) {
  const explicitWidthCells = normalizeGridCellCount(source.gridWidthCells);
  const explicitHeightCells = normalizeGridCellCount(source.gridHeightCells);
  const width = Number(source.width);
  const height = Number(source.height);
  return {
    gridWidthCells: explicitWidthCells
      ?? (Number.isFinite(width) && width > 0 ? Math.ceil(width / GRAPH_MODEL_GRID_CELL) : null),
    gridHeightCells: explicitHeightCells
      ?? (Number.isFinite(height) && height > 0 ? Math.ceil(height / GRAPH_MODEL_GRID_CELL) : null),
    x: Number.isFinite(Number(source.x)) ? Number(source.x) : null,
    y: Number.isFinite(Number(source.y)) ? Number(source.y) : null,
    width: Number.isFinite(width) && width > 0 ? width : null,
    height: Number.isFinite(height) && height > 0 ? height : null,
  };
}

/** Collects explicit and legacy child references into one normalized container membership list. */
function normalizeContainerChildIds(container = {}) {
  return uniqueIds([
    ...listFrom(container.childIds),
    ...listFrom(container.children),
    ...listFrom(container.nodeIds),
    ...listFrom(container.containerIds),
  ]);
}

/** Normalizes one provider node into the source-neutral graph model contract. */
function normalizeModelNode(node = {}, index = 0) {
  const sourceId = compactText(node.id, `node:${index + 1}`);
  const id = normalizeOptionalId(sourceId);
  return {
    ...node,
    elementType: "node",
    id,
    sourceId,
    kind: normalizeKind(node.kind || "node"),
    label: compactText(node.label, sourceId),
    parentId: normalizeOptionalId(node.parentId || node.containerId),
    childIds: [],
    box: normalizeElementBox(node),
  };
}

/** Normalizes one visual container including grid, collapse, membership, and metadata fields. */
function normalizeModelContainer(container = {}, index = 0) {
  const sourceId = compactText(container.id, `container:${index + 1}`);
  const id = normalizeOptionalId(sourceId);
  const childIds = normalizeContainerChildIds(container);
  return {
    ...container,
    elementType: "container",
    id,
    sourceId,
    kind: normalizeKind(container.kind || "container"),
    label: compactText(container.label, sourceId),
    role: compactText(container.role),
    description: compactText(container.description),
    parentId: normalizeOptionalId(container.parentId || container.containerId),
    childIds,
    nodeIds: uniqueIds(container.nodeIds),
    containerIds: uniqueIds(container.containerIds),
    collapsed: container.collapsed === true,
    renderAsNode: container.renderAsNode === true || container.collapsed === true,
    box: normalizeElementBox(container),
  };
}

/** Normalizes one relationship edge and its routing, label, and semantic presentation hints. */
function normalizeModelEdge(edge = {}, index = 0) {
  const from = normalizeOptionalId(edge.from);
  const to = normalizeOptionalId(edge.to);
  return {
    ...edge,
    id: compactText(edge.id, `edge:${index + 1}:${from}:${to}:${edge.kind || "relationship"}`),
    from,
    to,
    kind: normalizeKind(edge.kind || "relationship"),
    label: compactText(edge.label),
    description: compactText(edge.description),
  };
}

/** Records one canonical container parent and diagnoses conflicting duplicate membership. */
function addParent(parentById, childId, parentId, diagnostics) {
  if (!childId || !parentId) return;
  const existingParentId = parentById.get(childId);
  if (existingParentId && existingParentId !== parentId) {
    diagnostics.errors.push({
      code: "multiple-parents",
      id: childId,
      parentIds: [existingParentId, parentId],
    });
    return;
  }
  parentById.set(childId, parentId);
}

/** Traverses nested container membership and reports recursion cycles exactly once. */
function visitContainer(containerId, containersById, stack, visited, diagnostics) {
  if (visited.has(containerId)) return;
  if (stack.includes(containerId)) {
    diagnostics.errors.push({
      code: "container-cycle",
      id: containerId,
      cycle: [...stack.slice(stack.indexOf(containerId)), containerId],
    });
    return;
  }
  const container = containersById.get(containerId);
  if (!container) return;
  const nextStack = [...stack, containerId];
  for (const childId of container.childIds) {
    if (containersById.has(childId)) visitContainer(childId, containersById, nextStack, visited, diagnostics);
  }
  visited.add(containerId);
}

/** Builds indexed nodes, edges, containers, memberships, and diagnostics from a raw projection. */
export function normalizeGraphModel(projection = {}) {
  const diagnostics = {
    errors: [],
    warnings: [],
  };
  const nodes = listFrom(projection.nodes).map(normalizeModelNode).filter((node) => node.id);
  const containers = listFrom(projection.containers).map(normalizeModelContainer).filter((container) => container.id);
  const edges = listFrom(projection.edges).map(normalizeModelEdge).filter((edge) => edge.from && edge.to);
  const elements = [...nodes, ...containers];
  const elementById = new Map();
  const nodesById = new Map();
  const containersById = new Map();
  const parentById = new Map();
  const childrenByContainerId = new Map();

  for (const element of elements) {
    if (elementById.has(element.id)) {
      diagnostics.errors.push({
        code: "duplicate-element-id",
        id: element.id,
        elementTypes: [elementById.get(element.id)?.elementType, element.elementType],
      });
      continue;
    }
    elementById.set(element.id, element);
    if (element.elementType === "node") nodesById.set(element.id, element);
    if (element.elementType === "container") containersById.set(element.id, element);
  }

  for (const element of elements) {
    if (element.parentId) addParent(parentById, element.id, element.parentId, diagnostics);
  }

  for (const container of containers) {
    const children = [];
    for (const childId of container.childIds) {
      if (childId === container.id) {
        diagnostics.errors.push({ code: "container-self-child", id: container.id });
        continue;
      }
      if (!elementById.has(childId)) {
        diagnostics.errors.push({
          code: "missing-container-child",
          containerId: container.id,
          childId,
        });
        continue;
      }
      addParent(parentById, childId, container.id, diagnostics);
      children.push(childId);
    }
    childrenByContainerId.set(container.id, children);
  }

  for (const edge of edges) {
    if (!elementById.has(edge.from)) {
      diagnostics.errors.push({ code: "missing-edge-source", edgeId: edge.id, endpointId: edge.from });
    }
    if (!elementById.has(edge.to)) {
      diagnostics.errors.push({ code: "missing-edge-target", edgeId: edge.id, endpointId: edge.to });
    }
  }

  const visitedContainers = new Set();
  for (const container of containers) {
    visitContainer(container.id, containersById, [], visitedContainers, diagnostics);
  }

  const rootElementIds = elements
    .map((element) => element.id)
    .filter((id) => !parentById.has(id));
  const rootContainerIds = containers
    .map((container) => container.id)
    .filter((id) => !parentById.has(id));

  return {
    schema: compactText(projection.schema),
    view: compactText(projection.view),
    authority: compactText(projection.authority),
    nodes,
    containers,
    edges,
    elements,
    elementById,
    nodesById,
    containersById,
    parentById,
    childrenByContainerId,
    rootElementIds,
    rootContainerIds,
    diagnostics,
    metrics: {
      nodes: nodes.length,
      containers: containers.length,
      edges: edges.length,
      elements: elements.length,
      rootElements: rootElementIds.length,
      rootContainers: rootContainerIds.length,
    },
  };
}

/** Returns model diagnostics from the same normalization pass used by layout and rendering. */
export function validateGraphModel(projection = {}) {
  const model = normalizeGraphModel(projection);
  return {
    valid: model.diagnostics.errors.length === 0,
    errors: model.diagnostics.errors,
    warnings: model.diagnostics.warnings,
    metrics: model.metrics,
  };
}
