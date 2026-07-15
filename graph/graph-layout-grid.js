/*
 * Layout Grid normalizes origins, snaps positions, applies manual overrides,
 * and preserves grid-aligned spacing for the final Graph view model.
 */
import { GRAPH_ROUTE_GRID_CELL } from "./graph-grid.js";
import {
  ORIGIN_X,
  ORIGIN_Y,
  clampNumber,
  compareGraphNodes,
  graphNodeHeight,
  graphNodeRect,
  normalizeId,
} from "./graph-geometry.js";

/** Checks whether a node belongs to the central root lane rather than a branch lane. */
export function isRootGraphNode(node) {
  return node?.graphRole === "root" || /^C\d+$/.test(String(node?.id || ""));
}

/** Computes deterministic collision priority from root status, side, coordinates, and source order. */
function graphNodeGapPriority(node = {}, index = 0) {
  if (isRootGraphNode(node)) return -100000;
  if (node.positionSource === "manual-layout") return -50000;
  return Number(node.graphOrder ?? index);
}

/** Checks whether two vertically overlapping rectangles violate required horizontal separation. */
function graphRectsConflictHorizontally(left = {}, right = {}, gap = GRAPH_ROUTE_GRID_CELL) {
  return !(left.right + gap <= right.left || right.right + gap <= left.left);
}

/** Orders positioned nodes by collision priority before deterministic gap repair. */
function graphNodeGapSort(left, right) {
  const priorityDelta = graphNodeGapPriority(left.node, left.index) - graphNodeGapPriority(right.node, right.index);
  if (priorityDelta !== 0) return priorityDelta;
  const leftRect = graphNodeRect(left.node);
  const rightRect = graphNodeRect(right.node);
  return leftRect.top - rightRect.top
    || leftRect.left - rightRect.left
    || compareGraphNodes(left.node, right.node)
    || left.index - right.index;
}

/** Reads either edge-form or box-form geometry into the shared collision-edge contract. */
function graphCollisionRectEdges(rect = {}) {
  const left = Number.isFinite(Number(rect.left)) ? Number(rect.left) : Number(rect.x || 0);
  const top = Number.isFinite(Number(rect.top)) ? Number(rect.top) : Number(rect.y || 0);
  const right = Number.isFinite(Number(rect.right))
    ? Number(rect.right)
    : left + Number(rect.width || 0);
  const bottom = Number.isFinite(Number(rect.bottom))
    ? Number(rect.bottom)
    : top + Number(rect.height || 0);
  return { left, top, right, bottom };
}

/** Verifies that two node or container rectangles satisfy horizontal or vertical routing clearance. */
export function graphRectsRespectGap(left = {}, right = {}, gap = GRAPH_ROUTE_GRID_CELL) {
  const leftEdges = graphCollisionRectEdges(left);
  const rightEdges = graphCollisionRectEdges(right);
  return leftEdges.right + gap <= rightEdges.left
    || rightEdges.right + gap <= leftEdges.left
    || leftEdges.bottom + gap <= rightEdges.top
    || rightEdges.bottom + gap <= leftEdges.top;
}

/** Moves lower-priority nodes until all rectangles retain one route-grid cell of clearance. */
export function separateOverlappingGraphNodes(nodes) {
  const positioned = nodes.map((node) => ({ ...node }));
  const ordered = positioned
    .map((node, index) => ({ node, index }))
    .sort(graphNodeGapSort);
  const placed = [];

  for (const entry of ordered) {
    const node = entry.node;
    let moved = true;
    let guard = 0;
    while (moved && guard < positioned.length + 1) {
      moved = false;
      guard += 1;
      for (const placedNode of placed) {
        const nodeRect = graphNodeRect(node);
        const placedRect = graphNodeRect(placedNode);
        if (graphRectsRespectGap(nodeRect, placedRect, GRAPH_ROUTE_GRID_CELL)) continue;
        if (!graphRectsConflictHorizontally(nodeRect, placedRect, GRAPH_ROUTE_GRID_CELL)) continue;
        const nextY = snapGraphCoordinateUpToGrid(placedRect.bottom + GRAPH_ROUTE_GRID_CELL);
        if (nextY > Number(node.y || 0)) {
          node.y = nextY;
          moved = true;
          break;
        }
      }
    }
    placed.push(node);
  }
  return positioned;
}

/** Recenters branch lanes when their aggregate vertical span drifts from the root lane. */
export function rebalanceBranchNodeVerticalSpread(nodes) {
  const positioned = nodes.map((node) => ({ ...node }));
  const rootNodes = positioned.filter(isRootGraphNode);
  const branchNodes = positioned.filter((node) => !isRootGraphNode(node));
  if (!rootNodes.length || !branchNodes.length) return positioned;

  const rootCenterY = rootNodes.reduce((sum, node) => (
    sum + Number(node.y || 0) + graphNodeHeight(node) / 2
  ), 0) / rootNodes.length;
  const branchTop = branchNodes.reduce((min, node) => Math.min(min, Number(node.y || 0)), Infinity);
  const branchBottom = branchNodes.reduce((max, node) => (
    Math.max(max, Number(node.y || 0) + graphNodeHeight(node))
  ), -Infinity);
  if (!Number.isFinite(branchTop) || !Number.isFinite(branchBottom)) return positioned;

  const branchCenterY = (branchTop + branchBottom) / 2;
  const shiftY = clampNumber(Math.round(rootCenterY - branchCenterY), -220, 220);
  if (Math.abs(shiftY) < 8) return positioned;

  return positioned.map((node) => (
    isRootGraphNode(node)
      ? node
      : { ...node, y: Math.round(Number(node.y || 0) + shiftY) }
  ));
}

/** Translates node coordinates so the complete layout begins at the graph origin. */
export function normalizeGraphNodeOrigin(nodes) {
  const positioned = Array.isArray(nodes) ? nodes : [];
  if (!positioned.length) return positioned;
  const bounds = positioned.reduce((current, node) => {
    const rect = graphNodeRect(node);
    return {
      left: Math.min(current.left, rect.left),
      top: Math.min(current.top, rect.top),
    };
  }, { left: Infinity, top: Infinity });
  const shiftX = Math.max(0, Math.round(ORIGIN_X - bounds.left));
  const shiftY = Math.max(0, Math.round(ORIGIN_Y - bounds.top));
  if (!shiftX && !shiftY) return positioned;
  return positioned.map((node) => ({
    ...node,
    x: Math.round(Number(node.x || 0) + shiftX),
    y: Math.round(Number(node.y || 0) + shiftY),
  }));
}

/** Rounds one coordinate to the nearest shared route-grid cell boundary. */
export function snapGraphCoordinateToGrid(value) {
  return Math.max(0, Math.round((Number(value) || 0) / GRAPH_ROUTE_GRID_CELL) * GRAPH_ROUTE_GRID_CELL);
}

/** Rounds one positive extent upward so it fully occupies whole route-grid cells. */
export function snapGraphCoordinateUpToGrid(value) {
  return Math.max(0, Math.ceil((Number(value) || 0) / GRAPH_ROUTE_GRID_CELL) * GRAPH_ROUTE_GRID_CELL);
}

/** Expands a rectangle outward to cell boundaries without reducing its occupied area. */
export function snapGraphRectOutToGrid(rect = {}) {
  const left = Math.floor((Number(rect.x) || 0) / GRAPH_ROUTE_GRID_CELL) * GRAPH_ROUTE_GRID_CELL;
  const top = Math.floor((Number(rect.y) || 0) / GRAPH_ROUTE_GRID_CELL) * GRAPH_ROUTE_GRID_CELL;
  const right = Math.ceil(((Number(rect.x) || 0) + (Number(rect.width) || 0)) / GRAPH_ROUTE_GRID_CELL)
    * GRAPH_ROUTE_GRID_CELL;
  const bottom = Math.ceil(((Number(rect.y) || 0) + (Number(rect.height) || 0)) / GRAPH_ROUTE_GRID_CELL)
    * GRAPH_ROUTE_GRID_CELL;
  return {
    x: Math.max(0, left),
    y: Math.max(0, top),
    width: Math.max(GRAPH_ROUTE_GRID_CELL, right - Math.max(0, left)),
    height: Math.max(GRAPH_ROUTE_GRID_CELL, bottom - Math.max(0, top)),
  };
}

/** Snaps every node origin and extent to the shared Graph routing grid. */
export function snapGraphNodesToGrid(nodes = []) {
  return (Array.isArray(nodes) ? nodes : []).map((node) => ({
    ...node,
    x: snapGraphCoordinateToGrid(node.x),
    y: snapGraphCoordinateToGrid(node.y),
  }));
}

/** Repeats snapping and overlap separation until node geometry stabilizes on the routing grid. */
export function alignGraphNodesToRouteGrid(nodes = []) {
  let positioned = snapGraphNodesToGrid(nodes);
  for (let pass = 0; pass < 4; pass += 1) {
    const separated = separateOverlappingGraphNodes(positioned);
    const snapped = snapGraphNodesToGrid(separated);
    const changed = snapped.some((node, index) =>
      node.x !== positioned[index]?.x || node.y !== positioned[index]?.y
    );
    positioned = snapped;
    if (!changed) break;
  }
  return positioned;
}

/** Validates exact persisted world coordinates and indexes them by normalized node identity. */
export function normalizedGraphNodePositionOverrides(nodePositions = {}) {
  if (!nodePositions || typeof nodePositions !== "object") return new Map();
  return new Map(Object.entries(nodePositions).map(([id, position]) => [
    normalizeId(id),
    {
      x: Math.max(0, Math.round(Number(position?.x) || 0)),
      y: Math.max(0, Math.round(Number(position?.y) || 0)),
    },
  ]).filter(([id, position]) =>
    id && Number.isFinite(position.x) && Number.isFinite(position.y)
  ));
}

/** Applies valid manual positions while leaving unmentioned layout nodes unchanged. */
export function applyGraphNodePositionOverrides(nodes = [], nodePositions = {}) {
  const overrides = normalizedGraphNodePositionOverrides(nodePositions);
  if (!overrides.size) return nodes;
  return (Array.isArray(nodes) ? nodes : []).map((node) => {
    const override = overrides.get(normalizeId(node.id)) || overrides.get(normalizeId(node.sourceId));
    return override ? { ...node, ...override, positionSource: "manual-layout" } : node;
  });
}
