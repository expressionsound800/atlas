/*
 * Graph Router computes deterministic orthogonal and compound edge paths from
 * geometry, occupancy, endpoint roles, and requested quality mode.
 */
import {
  buildGraphRouteGrid,
  addGraphRouteOccupancy,
  graphGridCellBlocked,
  graphGridCellCenter,
  graphGridCellCost,
  graphGridNearestOpenCell,
} from "./graph-grid.js";
import {
  clampNumber,
  graphAngleDegFromVector,
  graphNodeRect,
  graphNodeHeight,
  graphNodeShapeAdapterForNode,
  graphNodeWidth,
  graphSourceAnchor,
  graphTargetAnchor,
  graphVectorFromAngleDeg,
  normalizeKind,
} from "./graph-geometry.js";

const ROUTE_TURN_COST = 18;
const ROUTE_BACKTRACK_COST = 46;
const ROUTE_DIRECTION_CHANGE_EPSILON = 0.001;
const ROUTE_ENDPOINT_ESCAPE = 44;
const ROUTE_SEGMENT_EPSILON = 0.001;
const ROUTE_NODE_HIT_COST = 240000;
const ROUTE_CROSSING_COST = 42000;
const ROUTE_BEND_COST = 1600;
const ROUTE_APPROACH_ANGLE_COST = 42;
const ROUTE_GRID_FALLBACK_COST = 2200;
const ROUTE_SHARED_ENDPOINT_ALLOWANCE = 72;
const ROUTE_SURFACE_ALIGNMENT_COST = 2.5;
const ROUTE_SURFACE_SAMPLE_DEGREES = 60;
const ROUTE_QUALITY_VISIBILITY_SURFACE_PAIR_LIMIT = 8;
const ROUTE_VISIBILITY_SURFACE_PAIR_LIMIT = 2;
const ROUTE_VISIBILITY_ENDPOINT_CANDIDATE_LIMIT = 4;
const ROUTE_CROSSING_OUTLIER_REROUTE_LIMIT = 12;
const ROUTE_VISIBILITY_REROUTE_MIN_CROSSINGS = 1;
const ROUTE_QUALITY_REROUTE_VISIBILITY_SURFACE_PAIR_LIMIT = 4;
const ROUTE_QUALITY_REROUTE_GRID_SURFACE_PAIR_LIMIT = 1;
const ROUTE_QUALITY_REROUTE_ESCAPE_LIMIT = 2;
const ROUTE_QUALITY_REROUTE_ENDPOINT_CANDIDATE_LIMIT = 4;
const ROUTE_BOUNDED_VISIBILITY_SURFACE_PAIR_LIMIT = 2;
const ROUTE_BOUNDED_GRID_SURFACE_PAIR_LIMIT = 1;
const ROUTE_BOUNDED_INITIAL_ENDPOINT_CANDIDATE_LIMIT = 2;
const ROUTE_BOUNDED_ENDPOINT_CANDIDATE_LIMIT = 4;
const ROUTE_BOUNDED_ESCAPE_LIMIT = 2;
const ROUTE_BOUNDED_EXPANDED_ESCAPE_LIMIT = 4;
const ROUTE_GRID_SURFACE_PAIR_LIMIT = 2;
const ROUTE_ENDPOINT_RECT_TRIM = 10;
const ROUTE_CURVED_CORNER_RADIUS = 24;
const ROUTE_NODE_CLEARANCE = 8;

const ROUTE_DIRECTIONS = Object.freeze([
  { col: 1, row: 0, cost: 1 },
  { col: -1, row: 0, cost: 1 },
  { col: 0, row: 1, cost: 1 },
  { col: 0, row: -1, cost: 1 },
  { col: 1, row: 1, cost: Math.SQRT2 },
  { col: 1, row: -1, cost: Math.SQRT2 },
  { col: -1, row: 1, cost: Math.SQRT2 },
  { col: -1, row: -1, cost: Math.SQRT2 },
]);

/** Computes deterministic routing order from edge semantics, activity, and stable identity. */
function edgeRoutePriority(edge = {}) {
  const kind = normalizeKind(edge.kind);
  if (kind === "binding") return 0;
  if (kind === "control") return 1;
  if (kind === "timing") return 2;
  return 3;
}

/** Resolves the effective source endpoint after compound-container route proxy substitution. */
function routeEdgeSourceId(edge = {}) {
  return String(edge?.routeFrom || edge?.from || "").trim();
}

/** Resolves the effective target endpoint after compound-container route proxy substitution. */
function routeEdgeTargetId(edge = {}) {
  return String(edge?.routeTo || edge?.to || "").trim();
}

/** Computes center-to-center endpoint distance used to prioritize shorter constrained routes. */
function edgeRouteDistance(edge = {}, nodeById = new Map()) {
  const from = nodeById.get(routeEdgeSourceId(edge));
  const to = nodeById.get(routeEdgeTargetId(edge));
  if (!from || !to) return Infinity;
  const start = edge.sourceMarker || {
    x: Number(from.x || 0) + graphNodeWidth(from) / 2,
    y: Number(from.y || 0) + graphNodeHeight(from) / 2,
  };
  const end = edge.targetMarker || {
    x: Number(to.x || 0) + graphNodeWidth(to) / 2,
    y: Number(to.y || 0) + graphNodeHeight(to) / 2,
  };
  return Math.hypot(Number(end.x || 0) - Number(start.x || 0), Number(end.y || 0) - Number(start.y || 0));
}

/** Selects the per-edge path-search budget from explicit or mode-derived routing metadata. */
function edgeRouteBudget(edge = {}) {
  return String(edge?.routeBudget || "").trim().toLowerCase();
}

/** Orders edge routing by priority, geometric distance, and stable relationship identity. */
function compareRouteEntries(left, right, nodeById = new Map()) {
  return edgeRouteDistance(left.edge, nodeById) - edgeRouteDistance(right.edge, nodeById)
    || edgeRoutePriority(left.edge) - edgeRoutePriority(right.edge)
    || left.index - right.index;
}

/** Selects the midpoint of routed path length as the relationship label anchor. */
function edgeLabelAnchor(points = [], start = {}, end = {}) {
  if (!points.length) {
    return {
      x: Math.round((start.x + end.x) / 2),
      y: Math.round((start.y + end.y) / 2 - 12),
    };
  }
  const index = Math.floor(points.length / 2);
  return {
    x: Math.round(points[index].x),
    y: Math.round(points[index].y - 12),
  };
}

/** Maps an adjacent grid step to the router's four-direction movement index. */
function directionIndex(from, to) {
  const dc = Math.sign(to.col - from.col);
  const dr = Math.sign(to.row - from.row);
  return ROUTE_DIRECTIONS.findIndex((direction) => direction.col === dc && direction.row === dr);
}

/** Computes Manhattan distance for admissible A-star route-grid guidance. */
function heuristic(cell, goal) {
  return Math.hypot(goal.col - cell.col, goal.row - cell.row);
}

/** Reconstructs ordered grid cells by walking predecessor keys from goal to origin. */
function reconstructRoute(cameFrom, key) {
  const cells = [];
  let cursor = key;
  while (cursor) {
    const [col, row] = cursor.split(":").map(Number);
    cells.push({ col, row });
    cursor = cameFrom.get(cursor);
  }
  return cells.reverse();
}

/** Removes intermediate collinear grid cells while preserving every actual route turn. */
function simplifyCells(cells = []) {
  if (cells.length <= 2) return cells;
  const simplified = [cells[0]];
  let previousDirection = directionIndex(cells[0], cells[1]);
  for (let index = 1; index < cells.length - 1; index += 1) {
    const nextDirection = directionIndex(cells[index], cells[index + 1]);
    if (nextDirection !== previousDirection) {
      simplified.push(cells[index]);
      previousDirection = nextDirection;
    }
  }
  simplified.push(cells[cells.length - 1]);
  return simplified;
}

/** Orders A-star frontier entries by total cost, traveled cost, then stable cell identity. */
function compareRouteFrontierEntries(left, right) {
  return left.f - right.f || left.g - right.g || left.key.localeCompare(right.key);
}

/**
 * Stores the A-star frontier in a binary min-heap.
 *
 * Grid routing can enqueue most cells in a room many times as cheaper paths
 * are discovered. Keeping the frontier ordered on every extraction turns that
 * search into repeated whole-array sorts; the heap preserves the same stable
 * ordering while limiting insertion and extraction to logarithmic work.
 */
class RouteFrontier {
  /** Builds an ordered frontier by inserting each seed through the heap comparator. */
  constructor(entries = []) {
    this.entries = [];
    entries.forEach((entry) => this.push(entry));
  }

  /** Returns the number of route candidates still available in the heap. */
  get length() {
    return this.entries.length;
  }

  /** Adds one route candidate and restores min-heap ordering from its insertion point. */
  push(entry) {
    const entries = this.entries;
    entries.push(entry);
    let index = entries.length - 1;
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (compareRouteFrontierEntries(entries[parentIndex], entry) <= 0) break;
      entries[index] = entries[parentIndex];
      index = parentIndex;
    }
    entries[index] = entry;
  }

  /** Removes the minimum-cost route candidate and restores heap ordering downward. */
  shift() {
    const entries = this.entries;
    if (!entries.length) return undefined;
    const root = entries[0];
    const tail = entries.pop();
    if (!entries.length) return root;
    let index = 0;
    while (true) {
      const leftIndex = index * 2 + 1;
      if (leftIndex >= entries.length) break;
      const rightIndex = leftIndex + 1;
      const childIndex = rightIndex < entries.length
        && compareRouteFrontierEntries(entries[rightIndex], entries[leftIndex]) < 0
        ? rightIndex
        : leftIndex;
      if (compareRouteFrontierEntries(entries[childIndex], tail) >= 0) break;
      entries[index] = entries[childIndex];
      index = childIndex;
    }
    entries[index] = tail;
    return root;
  }
}

/** Finds a bounded lowest-cost grid path with obstacle, turn, and occupancy penalties. */
function routeAStar(grid, startCell, goalCell, allowedRects = []) {
  const startKey = `${startCell.col}:${startCell.row}`;
  const goalKey = `${goalCell.col}:${goalCell.row}`;
  const open = new RouteFrontier([{
    key: startKey,
    cell: startCell,
    g: 0,
    f: heuristic(startCell, goalCell),
    direction: -1,
  }]);
  const cameFrom = new Map();
  const bestCost = new Map([[startKey, 0]]);
  const bestDirection = new Map([[startKey, -1]]);
  const closed = new Set();

  while (open.length) {
    const current = open.shift();
    if (!current || closed.has(current.key)) continue;
    if (current.key === goalKey) return reconstructRoute(cameFrom, current.key);
    closed.add(current.key);

    for (const direction of ROUTE_DIRECTIONS) {
      const next = {
        col: current.cell.col + direction.col,
        row: current.cell.row + direction.row,
      };
      if (next.col < 0 || next.row < 0 || next.col >= grid.cols || next.row >= grid.rows) continue;
      if (graphGridCellBlocked(grid, next, allowedRects)) continue;
      if (Math.abs(direction.col) && Math.abs(direction.row)) {
        const horizontal = { col: current.cell.col + direction.col, row: current.cell.row };
        const vertical = { col: current.cell.col, row: current.cell.row + direction.row };
        if (graphGridCellBlocked(grid, horizontal, allowedRects)
          || graphGridCellBlocked(grid, vertical, allowedRects)) {
          continue;
        }
      }
      const nextDirection = directionIndex(current.cell, next);
      const previousDirection = bestDirection.get(current.key) ?? current.direction;
      const turnCost = previousDirection >= 0 && previousDirection !== nextDirection
        ? ROUTE_TURN_COST
        : 0;
      const reverseCost = previousDirection >= 0
        && ROUTE_DIRECTIONS[previousDirection]
        && ROUTE_DIRECTIONS[previousDirection].col === -direction.col
        && ROUTE_DIRECTIONS[previousDirection].row === -direction.row
          ? ROUTE_BACKTRACK_COST
          : 0;
      const nextKey = `${next.col}:${next.row}`;
      const traversalCost = direction.cost * grid.cellSize
        + graphGridCellCost(grid, next)
        + turnCost
        + reverseCost;
      const candidateCost = current.g + traversalCost;
      if (candidateCost + ROUTE_DIRECTION_CHANGE_EPSILON >= (bestCost.get(nextKey) ?? Infinity)) continue;
      cameFrom.set(nextKey, current.key);
      bestCost.set(nextKey, candidateCost);
      bestDirection.set(nextKey, nextDirection);
      open.push({
        key: nextKey,
        cell: next,
        g: candidateCost,
        f: candidateCost + heuristic(next, goalCell) * grid.cellSize,
        direction: nextDirection,
      });
    }
  }

  return [startCell, goalCell];
}

/** Deduplicates consecutive route points and removes redundant collinear interior points. */
function compactRoutePoints(points = []) {
  const compacted = [];
  for (const point of points) {
    if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) continue;
    const normalized = { x: Number(point.x), y: Number(point.y) };
    const previous = compacted[compacted.length - 1];
    if (previous && Math.hypot(previous.x - normalized.x, previous.y - normalized.y) < 3) continue;
    compacted.push(normalized);
  }
  return compacted;
}

/** Translates one route point along a normalized direction by the supplied distance. */
function offsetPoint(point = {}, vector = {}, distance = 0) {
  return {
    x: Number(point.x || 0) + Number(vector.x || 0) * distance,
    y: Number(point.y || 0) + Number(vector.y || 0) * distance,
  };
}

/** Normalizes a finite route direction and uses a safe unit fallback for zero magnitude. */
function normalizeRouteVector(vector = {}, fallback = { x: 1, y: 0 }) {
  const length = Math.hypot(Number(vector.x || 0), Number(vector.y || 0));
  if (length < 0.001) return fallback;
  return {
    x: Number(vector.x || 0) / length,
    y: Number(vector.y || 0) / length,
  };
}

/** Computes the smallest absolute angular difference across the circular zero-degree boundary. */
function routeCircularAngleDelta(left, right) {
  const delta = Math.abs((((Number(left) - Number(right)) % 360) + 540) % 360 - 180);
  return Number.isFinite(delta) ? delta : 0;
}

/** Maps an endpoint direction angle to its nearest rectangular surface side. */
function routeSideForAngleDeg(angleDeg) {
  const angle = ((Number(angleDeg) % 360) + 360) % 360;
  if (angle >= 45 && angle < 135) return "bottom";
  if (angle >= 135 && angle < 225) return "left";
  if (angle >= 225 && angle < 315) return "top";
  return "right";
}

/** Computes the center point of a routed node's effective geometry box. */
function routeNodeCenter(node = {}) {
  return {
    x: Number(node.x || 0) + graphNodeWidth(node) / 2,
    y: Number(node.y || 0) + graphNodeHeight(node) / 2,
  };
}

/** Checks whether provider metadata supplied a finite non-zero endpoint direction vector. */
function edgeHasExplicitRouteVector(edge = {}) {
  const visualFlowDirection = String(edge?.visualFlowDirection || "").trim().toLowerCase();
  return ["left", "right", "up", "down"].includes(visualFlowDirection)
    || Number.isFinite(Number(edge?.angleDeg));
}

/** Derives the preferred endpoint exit direction from explicit metadata or peer geometry. */
function routeEndpointIdealVector(edge = {}, node = {}, connectedNode = {}, endpointRole = "source") {
  if (edgeHasExplicitRouteVector(edge)) {
    const marker = endpointRole === "source" ? edge.sourceMarker : edge.targetMarker;
    return normalizeRouteVector(marker?.vector, endpointRole === "source" ? { x: 1, y: 0 } : { x: -1, y: 0 });
  }
  const center = routeNodeCenter(node);
  const connectedCenter = routeNodeCenter(connectedNode);
  return normalizeRouteVector({
    x: connectedCenter.x - center.x,
    y: connectedCenter.y - center.y,
  }, endpointRole === "source" ? { x: 1, y: 0 } : { x: -1, y: 0 });
}

/** Builds ranked node-surface anchors and outward vectors for one relationship endpoint. */
function routeEndpointSurfaceCandidates(edge = {}, node = {}, connectedNode = {}, endpointRole = "source") {
  const adapter = graphNodeShapeAdapterForNode(node);
  const direction = endpointRole === "source" ? "outbound" : "inbound";
  const idealVector = routeEndpointIdealVector(edge, node, connectedNode, endpointRole);
  const idealAngle = graphAngleDegFromVector(idealVector);
  const angleOffsets = [0, -10, 10, -22, 22, -38, 38, -62, 62, -92, 92, 180];
  const angles = [
    ...Array.from({ length: Math.ceil(360 / ROUTE_SURFACE_SAMPLE_DEGREES) }, (_item, index) =>
      index * ROUTE_SURFACE_SAMPLE_DEGREES),
    ...angleOffsets.map((offset) => idealAngle + offset),
    0,
    90,
    180,
    270,
  ];
  const candidates = [];
  const seen = new Set();
  for (const angle of angles) {
    const normalizedAngle = (((angle % 360) + 360) % 360);
    const vector = graphVectorFromAngleDeg(normalizedAngle);
    const localPoint = adapter.markerLocalPoint(vector, { direction });
    const key = `${Math.round(localPoint.localX)}:${Math.round(localPoint.localY)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const angleDelta = routeCircularAngleDelta(normalizedAngle, idealAngle);
    candidates.push({
      x: Number(node.x || 0) + localPoint.localX,
      y: Number(node.y || 0) + localPoint.localY,
      localX: localPoint.localX,
      localY: localPoint.localY,
      side: routeSideForAngleDeg(normalizedAngle),
      angleDeg: normalizedAngle,
      vector,
      exitVector: vector,
      enterVector: { x: -vector.x, y: -vector.y },
      surfacePenalty: angleDelta * ROUTE_SURFACE_ALIGNMENT_COST,
      angleDelta,
    });
  }
  return candidates.sort((left, right) => (
    left.surfacePenalty - right.surfacePenalty
    || left.side.localeCompare(right.side)
    || left.x - right.x
    || left.y - right.y
  ));
}

/** Builds progressively farther open-grid escape points along an endpoint's outward direction. */
function routeEndpointEscapeCandidates(grid, anchor = {}, vector = {}) {
  const primary = normalizeRouteVector(vector);
  const tangent = { x: -primary.y, y: primary.x };
  const distances = [ROUTE_ENDPOINT_ESCAPE, ROUTE_ENDPOINT_ESCAPE + 28, ROUTE_ENDPOINT_ESCAPE + 58];
  const offsets = [0, grid.cellSize, -grid.cellSize, grid.cellSize * 2, -grid.cellSize * 2];
  const candidates = [];
  const seen = new Set();
  for (const distance of distances) {
    for (const offset of offsets) {
      const rawPoint = {
        x: Number(anchor.x || 0) + primary.x * distance + tangent.x * offset,
        y: Number(anchor.y || 0) + primary.y * distance + tangent.y * offset,
      };
      const cell = graphGridNearestOpenCell(grid, rawPoint, []);
      const point = graphGridCellCenter(grid, cell);
      const key = `${Math.round(point.x)}:${Math.round(point.y)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(point);
    }
  }
  return candidates.length ? candidates : [offsetPoint(anchor, primary, ROUTE_ENDPOINT_ESCAPE)];
}

/** Builds direct world-space escape points for visibility routing without a route grid. */
function routeEndpointRawEscapeCandidates(anchor = {}, vector = {}) {
  const primary = normalizeRouteVector(vector);
  const tangent = { x: -primary.y, y: primary.x };
  return [
    offsetPoint(anchor, primary, ROUTE_ENDPOINT_ESCAPE),
    {
      x: Number(anchor.x || 0) + primary.x * ROUTE_ENDPOINT_ESCAPE + tangent.x * 28,
      y: Number(anchor.y || 0) + primary.y * ROUTE_ENDPOINT_ESCAPE + tangent.y * 28,
    },
    {
      x: Number(anchor.x || 0) + primary.x * ROUTE_ENDPOINT_ESCAPE - tangent.x * 28,
      y: Number(anchor.y || 0) + primary.y * ROUTE_ENDPOINT_ESCAPE - tangent.y * 28,
    },
  ];
}

/** Routes between endpoint escapes on the grid and restores exact surface anchor points. */
function gridRoutePoints(grid, start, end, startEscape, endEscape) {
  const startCell = graphGridNearestOpenCell(grid, startEscape, []);
  const goalCell = graphGridNearestOpenCell(grid, endEscape, []);
  const routeCells = simplifyCells(routeAStar(grid, startCell, goalCell, []));
  let waypointPoints = routeCells
    .map((cell) => graphGridCellCenter(grid, cell))
    .filter((point) => Math.hypot(point.x - startEscape.x, point.y - startEscape.y) > grid.cellSize * 0.45
      && Math.hypot(point.x - endEscape.x, point.y - endEscape.y) > grid.cellSize * 0.45);
  if (!waypointPoints.length && routeCells.length) {
    waypointPoints = [graphGridCellCenter(grid, routeCells[Math.floor(routeCells.length / 2)])];
  }
  return compactRoutePoints([start, startEscape, ...waypointPoints, endEscape, end]);
}

/** Serializes compact route points as a straight-segment SVG path. */
function graphSegmentRouteThroughPoints(points = []) {
  const routePoints = points
    .map((point) => ({ x: Number(point?.x), y: Number(point?.y) }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (routePoints.length < 2) return "";
  return routePoints.map((point, index) => (
    `${index === 0 ? "M" : "L"} ${Math.round(point.x)} ${Math.round(point.y)}`
  )).join(" ");
}

/** Rounds route coordinates to stable integer pixels for deterministic SVG output. */
function roundedPoint(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

/** Computes a point a fixed distance backward from a segment's target endpoint. */
function pointAlongSegment(from, to, distanceFromTo) {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  if (distance < ROUTE_SEGMENT_EPSILON) return { x: to.x, y: to.y };
  const ratio = clampNumber(distanceFromTo / distance, 0, 1);
  return {
    x: from.x + (to.x - from.x) * ratio,
    y: from.y + (to.y - from.y) * ratio,
  };
}

/** Checks whether a route corner is effectively collinear and needs no curve. */
function routeCornerIsStraight(previous, corner, next) {
  const incoming = { x: corner.x - previous.x, y: corner.y - previous.y };
  const outgoing = { x: next.x - corner.x, y: next.y - corner.y };
  const incomingLength = Math.hypot(incoming.x, incoming.y);
  const outgoingLength = Math.hypot(outgoing.x, outgoing.y);
  if (incomingLength < ROUTE_SEGMENT_EPSILON || outgoingLength < ROUTE_SEGMENT_EPSILON) return true;
  const cross = incoming.x * outgoing.y - incoming.y * outgoing.x;
  const dot = incoming.x * outgoing.x + incoming.y * outgoing.y;
  return Math.abs(cross) < ROUTE_SEGMENT_EPSILON && dot > 0;
}

/** Converts a quadratic corner control into the two cubic controls required by SVG. */
function cubicControlFromQuadratic(start, control, end) {
  return {
    controlA: {
      x: start.x + (control.x - start.x) * (2 / 3),
      y: start.y + (control.y - start.y) * (2 / 3),
    },
    controlB: {
      x: end.x + (control.x - end.x) * (2 / 3),
      y: end.y + (control.y - end.y) * (2 / 3),
    },
  };
}

/** Serializes route points as a rounded-corner cubic SVG path without moving endpoints. */
function graphCurvedRouteThroughPoints(points = []) {
  const routePoints = points
    .map((point) => ({ x: Number(point?.x), y: Number(point?.y) }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (routePoints.length < 2) return "";
  if (routePoints.length < 3) return graphSegmentRouteThroughPoints(routePoints);

  const commands = [`M ${roundedPoint(routePoints[0].x)} ${roundedPoint(routePoints[0].y)}`];
  for (let index = 1; index < routePoints.length - 1; index += 1) {
    const previous = routePoints[index - 1];
    const corner = routePoints[index];
    const next = routePoints[index + 1];
    const incomingLength = Math.hypot(corner.x - previous.x, corner.y - previous.y);
    const outgoingLength = Math.hypot(next.x - corner.x, next.y - corner.y);
    const radius = Math.min(
      ROUTE_CURVED_CORNER_RADIUS,
      incomingLength * 0.45,
      outgoingLength * 0.45,
    );
    if (radius < 4 || routeCornerIsStraight(previous, corner, next)) {
      commands.push(`L ${roundedPoint(corner.x)} ${roundedPoint(corner.y)}`);
      continue;
    }

    const beforeCorner = pointAlongSegment(corner, previous, radius);
    const afterCorner = pointAlongSegment(corner, next, radius);
    const { controlA, controlB } = cubicControlFromQuadratic(beforeCorner, corner, afterCorner);
    commands.push(`L ${roundedPoint(beforeCorner.x)} ${roundedPoint(beforeCorner.y)}`);
    commands.push([
      "C",
      roundedPoint(controlA.x),
      roundedPoint(controlA.y),
      roundedPoint(controlB.x),
      roundedPoint(controlB.y),
      roundedPoint(afterCorner.x),
      roundedPoint(afterCorner.y),
    ].join(" "));
  }
  const last = routePoints[routePoints.length - 1];
  commands.push(`L ${roundedPoint(last.x)} ${roundedPoint(last.y)}`);
  return commands.join(" ");
}

/** Computes total Euclidean length across consecutive routed polyline segments. */
function routeLength(points = []) {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    length += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
  }
  return length;
}

/** Counts non-collinear interior turns remaining after deterministic route-point compaction. */
function routeBendCount(points = []) {
  let bends = 0;
  let previous = null;
  for (let index = 1; index < points.length; index += 1) {
    const direction = {
      x: Math.sign(points[index].x - points[index - 1].x),
      y: Math.sign(points[index].y - points[index - 1].y),
    };
    if (previous && (previous.x !== direction.x || previous.y !== direction.y)) bends += 1;
    previous = direction;
  }
  return bends;
}

/** Computes the angular difference between two finite route direction vectors. */
function routeVectorAngleDelta(left = {}, right = {}) {
  const leftVector = normalizeRouteVector(left);
  const rightVector = normalizeRouteVector(right);
  const dot = leftVector.x * rightVector.x + leftVector.y * rightVector.y;
  return Math.acos(clampNumber(dot, -1, 1)) * 180 / Math.PI;
}

/** Computes endpoint direction mismatch penalties for a candidate routed polyline. */
function routeApproachAnglePenalty(points = [], start = {}, end = {}) {
  if (points.length < 2) return 0;
  const first = points[0];
  const second = points[1];
  const beforeEnd = points[points.length - 2];
  const last = points[points.length - 1];
  const sourceAngle = routeVectorAngleDelta(
    { x: second.x - first.x, y: second.y - first.y },
    start.exitVector || start.vector,
  );
  const targetAngle = routeVectorAngleDelta(
    { x: last.x - beforeEnd.x, y: last.y - beforeEnd.y },
    end.enterVector || { x: -(end.vector?.x || 0), y: -(end.vector?.y || 0) },
  );
  return Math.max(sourceAngle, targetAngle);
}

/** Builds a padded visual obstacle rectangle from a node's effective display geometry. */
function visualNodeRect(node = {}, padding = 0) {
  const safePadding = Math.max(0, Number(padding) || 0);
  return {
    left: Number(node.x || 0) - safePadding,
    top: Number(node.y || 0) - safePadding,
    right: Number(node.x || 0) + graphNodeWidth(node) + safePadding,
    bottom: Number(node.y || 0) + graphNodeHeight(node) + safePadding,
  };
}

/** Checks whether a route point lies inside an obstacle rectangle including its boundary. */
function pointInRect(point = {}, rect = {}) {
  return point.x >= rect.left - ROUTE_SEGMENT_EPSILON
    && point.x <= rect.right + ROUTE_SEGMENT_EPSILON
    && point.y >= rect.top - ROUTE_SEGMENT_EPSILON
    && point.y <= rect.bottom + ROUTE_SEGMENT_EPSILON;
}

/** Checks whether a route segment crosses or terminates inside an obstacle rectangle. */
function segmentIntersectsRect(start = {}, end = {}, rect = {}) {
  if (pointInRect(start, rect) || pointInRect(end, rect)) return true;
  const minX = Math.min(start.x, end.x);
  const maxX = Math.max(start.x, end.x);
  const minY = Math.min(start.y, end.y);
  const maxY = Math.max(start.y, end.y);
  if (maxX < rect.left || minX > rect.right || maxY < rect.top || minY > rect.bottom) return false;
  const edges = [
    [{ x: rect.left, y: rect.top }, { x: rect.right, y: rect.top }],
    [{ x: rect.right, y: rect.top }, { x: rect.right, y: rect.bottom }],
    [{ x: rect.right, y: rect.bottom }, { x: rect.left, y: rect.bottom }],
    [{ x: rect.left, y: rect.bottom }, { x: rect.left, y: rect.top }],
  ];
  return edges.some(([edgeStart, edgeEnd]) => segmentsIntersect(start, end, edgeStart, edgeEnd));
}

/** Trims a segment away from its endpoints before obstacle-intersection testing. */
function trimSegmentEndpoint(start = {}, end = {}, startTrim = 0, endTrim = 0) {
  const dx = Number(end.x || 0) - Number(start.x || 0);
  const dy = Number(end.y || 0) - Number(start.y || 0);
  const length = Math.hypot(dx, dy);
  if (length < ROUTE_SEGMENT_EPSILON) return { start, end };
  const safeStartTrim = clampNumber(Number(startTrim) || 0, 0, Math.max(0, length / 2 - 0.001));
  const safeEndTrim = clampNumber(Number(endTrim) || 0, 0, Math.max(0, length / 2 - 0.001));
  return {
    start: {
      x: Number(start.x || 0) + (dx / length) * safeStartTrim,
      y: Number(start.y || 0) + (dy / length) * safeStartTrim,
    },
    end: {
      x: Number(end.x || 0) - (dx / length) * safeEndTrim,
      y: Number(end.y || 0) - (dy / length) * safeEndTrim,
    },
  };
}

/** Computes clockwise, counterclockwise, or collinear orientation for three route points. */
function orientation(a, b, c) {
  const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (Math.abs(value) < ROUTE_SEGMENT_EPSILON) return 0;
  return value > 0 ? 1 : 2;
}

/** Checks whether a collinear point lies within the inclusive bounds of a segment. */
function onSegment(a, b, c) {
  return b.x <= Math.max(a.x, c.x) + ROUTE_SEGMENT_EPSILON
    && b.x >= Math.min(a.x, c.x) - ROUTE_SEGMENT_EPSILON
    && b.y <= Math.max(a.y, c.y) + ROUTE_SEGMENT_EPSILON
    && b.y >= Math.min(a.y, c.y) - ROUTE_SEGMENT_EPSILON;
}

/** Checks general and collinear intersection between two route line segments. */
function segmentsIntersect(a, b, c, d) {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && onSegment(a, c, b))
    || (o2 === 0 && onSegment(a, d, b))
    || (o3 === 0 && onSegment(c, a, d))
    || (o4 === 0 && onSegment(c, b, d));
}

/** Collects blocking-node hits and endpoint clearance problems for one candidate route. */
function routeNodeDiagnostics(edge = {}, points = [], nodes = []) {
  let sourceHits = 0;
  let targetHits = 0;
  let nodeHits = 0;
  const sourceId = routeEdgeSourceId(edge);
  const targetId = routeEdgeTargetId(edge);
  for (const node of nodes) {
    if (node?.routeProxy === true) continue;
    const rect = visualNodeRect(
      node,
      node.id === sourceId || node.id === targetId ? 0 : ROUTE_NODE_CLEARANCE,
    );
    for (let index = 1; index < points.length; index += 1) {
      let segmentStart = points[index - 1];
      let segmentEnd = points[index];
      if (node.id === sourceId && index === 1) {
        ({ start: segmentStart, end: segmentEnd } = trimSegmentEndpoint(
          segmentStart,
          segmentEnd,
          ROUTE_ENDPOINT_RECT_TRIM,
          0,
        ));
      }
      if (node.id === targetId && index === points.length - 1) {
        ({ start: segmentStart, end: segmentEnd } = trimSegmentEndpoint(
          segmentStart,
          segmentEnd,
          0,
          ROUTE_ENDPOINT_RECT_TRIM,
        ));
      }
      if (!segmentIntersectsRect(segmentStart, segmentEnd, rect)) continue;
      if (node.id === sourceId) {
        sourceHits += 1;
      } else if (node.id === targetId) {
        targetHits += 1;
      } else {
        nodeHits += 1;
      }
      break;
    }
  }
  return { sourceHits, targetHits, nodeHits };
}

/** Returns consecutive routed segment pairs from a completed edge geometry record. */
function routeSegmentPairs(edge = {}) {
  const points = Array.isArray(edge.routePoints) ? edge.routePoints : [];
  const pairs = [];
  for (let index = 1; index < points.length; index += 1) {
    pairs.push([points[index - 1], points[index]]);
  }
  return pairs;
}

/** Converts a point sequence into consecutive segment records for crossing analysis. */
function routePointPairs(points = []) {
  const pairs = [];
  for (let index = 1; index < points.length; index += 1) {
    pairs.push([points[index - 1], points[index]]);
  }
  return pairs;
}

/** Checks whether two edges share any normalized source or target endpoint. */
function sharedEndpoint(left = {}, right = {}) {
  const leftFrom = routeEdgeSourceId(left);
  const leftTo = routeEdgeTargetId(left);
  const rightFrom = routeEdgeSourceId(right);
  const rightTo = routeEdgeTargetId(right);
  return leftFrom === rightFrom
    || leftFrom === rightTo
    || leftTo === rightFrom
    || leftTo === rightTo;
}

/** Checks whether two segments meet only at one identical endpoint coordinate. */
function segmentTouchingSamePoint(a, b, c, d) {
  return [a, b].some((leftPoint) =>
    [c, d].some((rightPoint) =>
      Math.hypot(leftPoint.x - rightPoint.x, leftPoint.y - rightPoint.y) <= ROUTE_SHARED_ENDPOINT_ALLOWANCE
    )
  );
}

/** Counts non-shared geometric crossings and records them on each routed edge. */
function annotateRouteCrossings(edges = []) {
  return edges.map((edge, index) => {
    let crossings = 0;
    const pairs = routeSegmentPairs(edge);
    for (let otherIndex = 0; otherIndex < edges.length; otherIndex += 1) {
      if (otherIndex === index) continue;
      const other = edges[otherIndex];
      for (const [start, end] of pairs) {
        for (const [otherStart, otherEnd] of routeSegmentPairs(other)) {
          if (!segmentsIntersect(start, end, otherStart, otherEnd)) continue;
          if (sharedEndpoint(edge, other) && segmentTouchingSamePoint(start, end, otherStart, otherEnd)) continue;
          crossings += 1;
        }
      }
    }
    return {
      ...edge,
      routeCrossings: Math.floor(crossings / 2),
    };
  });
}

/** Counts candidate segment crossings against already accepted non-adjacent routes. */
function routeCrossingsWithPrior(edge = {}, points = [], priorRoutes = []) {
  let crossings = 0;
  for (const prior of priorRoutes) {
    for (const [start, end] of routePointPairs(points)) {
      for (const [otherStart, otherEnd] of routePointPairs(prior.points || [])) {
        if (!segmentsIntersect(start, end, otherStart, otherEnd)) continue;
        if (sharedEndpoint(edge, prior.edge) && segmentTouchingSamePoint(start, end, otherStart, otherEnd)) continue;
        crossings += 1;
      }
    }
  }
  return crossings;
}

/** Computes congestion cost from prior routes using the same endpoint neighborhood. */
function routeEndpointCrowdingCost(edge = {}, start = {}, end = {}, priorRoutes = []) {
  let cost = 0;
  const currentEndpoints = [
    { nodeId: routeEdgeSourceId(edge), point: start },
    { nodeId: routeEdgeTargetId(edge), point: end },
  ];
  for (const prior of priorRoutes) {
    const priorEndpoints = [
      { nodeId: routeEdgeSourceId(prior.edge), point: prior.sourcePoint },
      { nodeId: routeEdgeTargetId(prior.edge), point: prior.targetPoint },
    ];
    for (const current of currentEndpoints) {
      for (const previous of priorEndpoints) {
        if (!current.nodeId || current.nodeId !== previous.nodeId || !previous.point) continue;
        const distance = Math.hypot(current.point.x - previous.point.x, current.point.y - previous.point.y);
        if (distance < 8) {
          cost += 6000;
        } else if (distance < 16) {
          cost += (16 - distance) * 180;
        }
      }
    }
  }
  return cost;
}

/** Builds horizontal-first and vertical-first orthogonal candidates between two anchors. */
function oneBendRouteCandidates(start = {}, end = {}) {
  return [
    [start, { x: end.x, y: start.y }, end],
    [start, { x: start.x, y: end.y }, end],
  ];
}

/** Computes padded outer bounds enclosing every visible routing obstacle node. */
function routeBoundsForNodes(nodes = []) {
  return (Array.isArray(nodes) ? nodes : []).reduce((bounds, node) => {
    const rect = visualNodeRect(node);
    return {
      left: Math.min(bounds.left, rect.left),
      top: Math.min(bounds.top, rect.top),
      right: Math.max(bounds.right, rect.right),
      bottom: Math.max(bounds.bottom, rect.bottom),
    };
  }, {
    left: Infinity,
    top: Infinity,
    right: -Infinity,
    bottom: -Infinity,
  });
}

/** Builds detour candidates along outer graph rails for heavily obstructed relationships. */
function outerRailRouteCandidates(start = {}, end = {}, nodes = []) {
  const bounds = routeBoundsForNodes(nodes);
  const fallbackLeft = Math.min(start.x || 0, end.x || 0) - 180;
  const fallbackRight = Math.max(start.x || 0, end.x || 0) + 180;
  const fallbackTop = Math.min(start.y || 0, end.y || 0) - 180;
  const fallbackBottom = Math.max(start.y || 0, end.y || 0) + 180;
  const leftRail = Number.isFinite(bounds.left) ? bounds.left - 112 : fallbackLeft;
  const rightRail = Number.isFinite(bounds.right) ? bounds.right + 112 : fallbackRight;
  const topRail = Number.isFinite(bounds.top) ? bounds.top - 112 : fallbackTop;
  const bottomRail = Number.isFinite(bounds.bottom) ? bounds.bottom + 112 : fallbackBottom;
  const localLeftRail = Math.min(start.x || 0, end.x || 0) - 112;
  const localRightRail = Math.max(start.x || 0, end.x || 0) + 112;
  const localTopRail = Math.min(start.y || 0, end.y || 0) - 112;
  const localBottomRail = Math.max(start.y || 0, end.y || 0) + 112;
  const xRails = [...new Set([localRightRail, localLeftRail, rightRail, leftRail].map(Math.round))];
  const yRails = [...new Set([localBottomRail, localTopRail, bottomRail, topRail].map(Math.round))];
  const candidates = [];
  for (const railX of xRails) {
    candidates.push([start, { x: railX, y: start.y }, { x: railX, y: end.y }, end]);
  }
  for (const railY of yRails) {
    candidates.push([start, { x: start.x, y: railY }, { x: end.x, y: railY }, end]);
  }
  return candidates;
}

/** Builds local detours around obstacle rectangles intersecting the direct endpoint segment. */
function localObstacleDetourCandidates(edge = {}, start = {}, end = {}, nodes = []) {
  const candidates = [];
  const directSegment = [start, end];
  const sourceId = routeEdgeSourceId(edge);
  const targetId = routeEdgeTargetId(edge);
  const blockers = (Array.isArray(nodes) ? nodes : [])
    .filter((node) => node && node.id !== sourceId && node.id !== targetId && node.routeProxy !== true)
    .map((node) => ({ node, rect: visualNodeRect(node) }))
    .filter(({ rect }) => segmentIntersectsRect(directSegment[0], directSegment[1], rect));
  for (const { rect } of blockers) {
    const padding = 42;
    const leftRail = rect.left - padding;
    const rightRail = rect.right + padding;
    const topRail = rect.top - padding;
    const bottomRail = rect.bottom + padding;
    candidates.push([start, { x: leftRail, y: start.y }, { x: leftRail, y: end.y }, end]);
    candidates.push([start, { x: rightRail, y: start.y }, { x: rightRail, y: end.y }, end]);
    candidates.push([start, { x: start.x, y: topRail }, { x: end.x, y: topRail }, end]);
    candidates.push([start, { x: start.x, y: bottomRail }, { x: end.x, y: bottomRail }, end]);
    candidates.push([start, { x: rightRail, y: start.y }, { x: rightRail, y: bottomRail }, { x: end.x, y: bottomRail }, end]);
    candidates.push([start, { x: leftRail, y: start.y }, { x: leftRail, y: bottomRail }, { x: end.x, y: bottomRail }, end]);
    candidates.push([start, { x: rightRail, y: start.y }, { x: rightRail, y: topRail }, { x: end.x, y: topRail }, end]);
    candidates.push([start, { x: leftRail, y: start.y }, { x: leftRail, y: topRail }, { x: end.x, y: topRail }, end]);
  }
  return candidates;
}

/** Collects simple visibility candidates first and adds obstacle/rail escapes only for compromised pairs. */
function visibilityRouteCandidates(edge = {}, start = {}, end = {}, nodes = [], options = {}) {
  const startEscapes = routeEndpointRawEscapeCandidates(start, start.exitVector || start.vector);
  const endEscapes = routeEndpointRawEscapeCandidates(
    end,
    end.vector || { x: -(end.enterVector?.x || 0), y: -(end.enterVector?.y || 0) },
  );
  const candidates = [
    [start, end],
    ...oneBendRouteCandidates(start, end),
  ];
  if (options.includeDetours === true) {
    candidates.push(
      ...localObstacleDetourCandidates(edge, start, end, nodes),
      ...outerRailRouteCandidates(start, end, nodes),
    );
    for (const startEscape of startEscapes) {
      candidates.push([start, startEscape, end]);
      for (const endEscape of endEscapes) {
        candidates.push([start, startEscape, endEscape, end]);
        candidates.push([start, startEscape, { x: endEscape.x, y: startEscape.y }, endEscape, end]);
        candidates.push([start, startEscape, { x: startEscape.x, y: endEscape.y }, endEscape, end]);
      }
    }
  }
  return candidates.map(compactRoutePoints).filter((points) => points.length >= 2);
}

/** Scores length, bends, obstacles, crossings, endpoint angles, crowding, and detour cost. */
function scoreRouteCandidate(edge, points, diagnostics, start, end, priorRoutes, extraCost = 0) {
  const crossings = routeCrossingsWithPrior(edge, points, priorRoutes);
  const bends = routeBendCount(points);
  const length = routeLength(points);
  const approachAngle = routeApproachAnglePenalty(points, start, end);
  const surfaceCost = Number(start.surfacePenalty || 0)
    + Number(end.surfacePenalty || 0)
    + routeEndpointCrowdingCost(edge, start, end, priorRoutes);
  return {
    crossings,
    bends,
    length,
    approachAngle,
    surfaceCost,
    score: diagnostics.sourceHits * ROUTE_NODE_HIT_COST
      + diagnostics.targetHits * ROUTE_NODE_HIT_COST
      + diagnostics.nodeHits * ROUTE_NODE_HIT_COST
      + crossings * ROUTE_CROSSING_COST
      + bends * ROUTE_BEND_COST
      + approachAngle * ROUTE_APPROACH_ANGLE_COST
      + surfaceCost
      + length
      + extraCost,
  };
}

/** Compares complete route scores with deterministic path-text tie-breaking. */
function routeScoreBetter(left = null, right = null) {
  if (!right) return true;
  if (!left) return false;
  return left.score.score < right.score.score;
}

/** Builds diagnostics and a comparable score for one compact candidate point sequence. */
function scoredRouteCandidate(edge, points, start, end, nodes, priorRoutes, extraCost = 0) {
  const path = graphCurvedRouteThroughPoints(points);
  if (!path) return null;
  const diagnostics = routeNodeDiagnostics(edge, points, nodes);
  const score = scoreRouteCandidate(edge, points, diagnostics, start, end, priorRoutes, extraCost);
  return { points, path, diagnostics, score, start, end };
}

/** Checks whether the chosen route still needs the route-grid search allowed by its budget. */
function routeNeedsGridRefinement(edge = {}, candidate = null) {
  const routeBudget = String(edge?.routeBudget || "").trim().toLowerCase();
  if (routeBudget === "visibility") return false;
  if (!candidate) return true;
  if (routeBudget === "bounded") {
    return Number(candidate.diagnostics?.sourceHits || 0) > 0
      || Number(candidate.diagnostics?.targetHits || 0) > 0
      || Number(candidate.diagnostics?.nodeHits || 0) > 0;
  }
  if (routeBudget === "quality") {
    return Number(candidate.diagnostics?.sourceHits || 0) > 0
      || Number(candidate.diagnostics?.targetHits || 0) > 0
      || Number(candidate.diagnostics?.nodeHits || 0) > 0;
  }
  if (routeBudget === "quality-reroute") {
    return Number(candidate.diagnostics?.sourceHits || 0) > 0
      || Number(candidate.diagnostics?.targetHits || 0) > 0
      || Number(candidate.diagnostics?.nodeHits || 0) > 0
      || Number(candidate.score?.crossings || 0) > 0;
  }
  return Number(candidate.diagnostics?.sourceHits || 0) > 0
    || Number(candidate.diagnostics?.targetHits || 0) > 0
    || Number(candidate.diagnostics?.nodeHits || 0) > 0
    || Number(candidate.score?.crossings || 0) > 0
    || Number(candidate.score?.approachAngle || 0) > 8;
}

/** Checks whether narrow endpoint exploration left a visibly compromised route candidate. */
function routeCandidateNeedsSurfaceExpansion(candidate = null) {
  if (!candidate) return true;
  return Number(candidate.diagnostics?.sourceHits || 0) > 0
    || Number(candidate.diagnostics?.targetHits || 0) > 0
    || Number(candidate.diagnostics?.nodeHits || 0) > 0
    || Number(candidate.score?.crossings || 0) > 0
    || Number(candidate.score?.approachAngle || 0) > 8;
}

/** Selects initial and maximum endpoint breadth plus visibility and grid budgets for one route. */
function routeSurfacePairLimits(edge = {}) {
  if (edgeRouteBudget(edge) === "quality-reroute") {
    return {
      initialEndpointCandidateLimit: ROUTE_QUALITY_REROUTE_ENDPOINT_CANDIDATE_LIMIT,
      endpointCandidateLimit: ROUTE_QUALITY_REROUTE_ENDPOINT_CANDIDATE_LIMIT,
      visibilitySurfacePairLimit: ROUTE_QUALITY_REROUTE_VISIBILITY_SURFACE_PAIR_LIMIT,
      gridSurfacePairLimit: ROUTE_QUALITY_REROUTE_GRID_SURFACE_PAIR_LIMIT,
    };
  }
  if (edgeRouteBudget(edge) === "visibility") {
    return {
      initialEndpointCandidateLimit: ROUTE_VISIBILITY_ENDPOINT_CANDIDATE_LIMIT,
      endpointCandidateLimit: ROUTE_VISIBILITY_ENDPOINT_CANDIDATE_LIMIT,
      visibilitySurfacePairLimit: ROUTE_VISIBILITY_SURFACE_PAIR_LIMIT,
      gridSurfacePairLimit: 0,
    };
  }
  if (edgeRouteBudget(edge) === "bounded") {
    return {
      initialEndpointCandidateLimit: ROUTE_BOUNDED_INITIAL_ENDPOINT_CANDIDATE_LIMIT,
      endpointCandidateLimit: ROUTE_BOUNDED_ENDPOINT_CANDIDATE_LIMIT,
      visibilitySurfacePairLimit: ROUTE_VISIBILITY_SURFACE_PAIR_LIMIT,
      gridSurfacePairLimit: ROUTE_BOUNDED_GRID_SURFACE_PAIR_LIMIT,
    };
  }
  return {
    initialEndpointCandidateLimit: Infinity,
    endpointCandidateLimit: Infinity,
    visibilitySurfacePairLimit: ROUTE_QUALITY_VISIBILITY_SURFACE_PAIR_LIMIT,
    gridSurfacePairLimit: ROUTE_GRID_SURFACE_PAIR_LIMIT,
  };
}

/** Ranks endpoint surface pairs by their cheapest direct or one-bend preflight route. */
function rankedRouteSurfacePairs(edge, sourceCandidates, targetCandidates, nodes, priorRoutes, candidateLimit) {
  const limitedSourceCandidates = Number.isFinite(candidateLimit)
    ? sourceCandidates.slice(0, candidateLimit)
    : sourceCandidates;
  const limitedTargetCandidates = Number.isFinite(candidateLimit)
    ? targetCandidates.slice(0, candidateLimit)
    : targetCandidates;
  const surfacePairs = [];
  for (const start of limitedSourceCandidates) {
    for (const end of limitedTargetCandidates) {
      const preflight = preflightSurfacePair(edge, start, end, nodes, priorRoutes);
      if (preflight) surfacePairs.push({ start, end, score: preflight.score.score });
    }
  }
  return surfacePairs.sort((left, right) => left.score - right.score
    || left.start.angleDeg - right.start.angleDeg
    || left.end.angleDeg - right.end.angleDeg);
}

/** Evaluates full visibility routes for the best-ranked endpoint pairs and returns the best candidate. */
function bestVisibilityRoute(edge, surfacePairs, pairLimit, nodes, priorRoutes, selected = null) {
  let best = selected;
  surfacePairs.slice(0, pairLimit).forEach(({ start, end }) => {
    const preflight = preflightSurfacePair(edge, start, end, nodes, priorRoutes);
    const includeDetours = edgeRouteBudget(edge) !== "visibility"
      || routeCandidateNeedsSurfaceExpansion(preflight);
    for (const points of visibilityRouteCandidates(edge, start, end, nodes, { includeDetours })) {
      const candidate = scoredRouteCandidate(edge, points, start, end, nodes, priorRoutes);
      if (candidate && routeScoreBetter(candidate, best)) best = candidate;
    }
  });
  return best;
}

/** Expands bounded route-grid endpoint escapes only while obstacle hits remain unresolved. */
function routeEscapeCandidateLimits(edge = {}) {
  const routeBudget = edgeRouteBudget(edge);
  if (routeBudget === "quality-reroute") return [ROUTE_QUALITY_REROUTE_ESCAPE_LIMIT];
  if (routeBudget === "bounded") return [ROUTE_BOUNDED_ESCAPE_LIMIT, ROUTE_BOUNDED_EXPANDED_ESCAPE_LIMIT];
  return [Infinity];
}

/** Scores the simplest visibility candidates for one source-target surface pair before grid search. */
function preflightSurfacePair(edge, start, end, nodes, priorRoutes) {
  let selected = null;
  const preflightRoutes = [
    [start, end],
    ...oneBendRouteCandidates(start, end),
  ];
  for (const points of preflightRoutes.map(compactRoutePoints)) {
    const candidate = scoredRouteCandidate(edge, points, start, end, nodes, priorRoutes);
    if (candidate && routeScoreBetter(candidate, selected)) selected = candidate;
  }
  return selected;
}

/** Selects endpoint surfaces and produces the best bounded visibility or grid-routed edge geometry. */
function routeEdgeGeometry(edge, nodeById, grid, priorRoutes = []) {
  const routeFrom = routeEdgeSourceId(edge);
  const routeTo = routeEdgeTargetId(edge);
  const from = nodeById.get(routeFrom);
  const to = nodeById.get(routeTo);
  if (!from || !to) return null;
  if (routeFrom === routeTo) return null;
  if (edgeRouteBudget(edge) === "preview") {
    return previewRouteEdgeGeometry(edge, from, to, nodeById, priorRoutes);
  }
  const nodes = [...nodeById.values()];
  const sourceCandidates = routeEndpointSurfaceCandidates(edge, from, to, "source");
  const targetCandidates = routeEndpointSurfaceCandidates(edge, to, from, "target");
  let selected = null;
  const routeLimits = routeSurfacePairLimits(edge);
  let surfacePairs = rankedRouteSurfacePairs(
    edge,
    sourceCandidates,
    targetCandidates,
    nodes,
    priorRoutes,
    routeLimits.initialEndpointCandidateLimit,
  );
  const initialPairLimit = edgeRouteBudget(edge) === "bounded"
    ? ROUTE_BOUNDED_VISIBILITY_SURFACE_PAIR_LIMIT
    : routeLimits.visibilitySurfacePairLimit;
  selected = bestVisibilityRoute(edge, surfacePairs, initialPairLimit, nodes, priorRoutes, selected);
  if (routeLimits.endpointCandidateLimit > routeLimits.initialEndpointCandidateLimit
    && routeCandidateNeedsSurfaceExpansion(selected)) {
    surfacePairs = rankedRouteSurfacePairs(
      edge,
      sourceCandidates,
      targetCandidates,
      nodes,
      priorRoutes,
      routeLimits.endpointCandidateLimit,
    );
    selected = bestVisibilityRoute(
      edge,
      surfacePairs,
      routeLimits.visibilitySurfacePairLimit,
      nodes,
      priorRoutes,
      selected,
    );
  }

  if (routeNeedsGridRefinement(edge, selected)) {
    surfacePairs
      .sort((left, right) => left.score - right.score
        || left.start.angleDeg - right.start.angleDeg
        || left.end.angleDeg - right.end.angleDeg)
      .slice(0, routeLimits.gridSurfacePairLimit)
      .forEach(({ start, end }) => {
        const allStartCandidates = routeEndpointEscapeCandidates(grid, start, start.exitVector || start.vector);
        const allEndCandidates = routeEndpointEscapeCandidates(
          grid,
          end,
          end.vector || { x: -(end.enterVector?.x || 0), y: -(end.enterVector?.y || 0) },
        );
        const visitedEscapePairs = new Set();
        for (const escapeLimit of routeEscapeCandidateLimits(edge)) {
          const startCandidates = allStartCandidates.slice(0, escapeLimit);
          const endCandidates = allEndCandidates.slice(0, escapeLimit);
          for (const startEscape of startCandidates) {
            for (const endEscape of endCandidates) {
              const escapeKey = `${startEscape.col}:${startEscape.row}->${endEscape.col}:${endEscape.row}`;
              if (visitedEscapePairs.has(escapeKey)) continue;
              visitedEscapePairs.add(escapeKey);
              const points = gridRoutePoints(grid, start, end, startEscape, endEscape);
              const candidate = scoredRouteCandidate(
                edge,
                points,
                start,
                end,
                nodes,
                priorRoutes,
                ROUTE_GRID_FALLBACK_COST,
              );
              if (candidate && routeScoreBetter(candidate, selected)) selected = candidate;
            }
          }
          if (!routeCandidateNeedsSurfaceExpansion(selected)) break;
        }
      });
  }
  if (!selected) return null;
  const {
    points,
    path,
    diagnostics,
    start,
    end,
  } = selected;
  const label = edgeLabelAnchor(points.slice(1, -1), start, end);
  addGraphRouteOccupancy(grid, points);
  return {
    path,
    labelX: label.x,
    labelY: label.y,
    routeModel: edgeRouteBudget(edge) === "visibility"
      ? "visibility-curved-segments"
      : "grid-a-star-segments",
    routeFrom,
    routeTo,
    routeRenderer: "curved-polyline",
    routePointCount: points.length,
    routeLength: Math.round(routeLength(points)),
    routeBends: routeBendCount(points),
    routeCandidateScore: Math.round(selected.score.score),
    routePriorCrossings: selected.score.crossings,
    routeApproachAngle: Math.round(selected.score.approachAngle),
    routeSurfaceCost: Math.round(selected.score.surfaceCost),
    routeGridCellSize: grid.cellSize,
    routeSourceNodeHits: diagnostics.sourceHits,
    routeTargetNodeHits: diagnostics.targetHits,
    routeNodeHits: diagnostics.nodeHits,
    sourceSurfaceAngleDeg: Math.round(start.angleDeg * 10) / 10,
    sourceSurfaceLocalX: Math.round(start.localX * 10) / 10,
    sourceSurfaceLocalY: Math.round(start.localY * 10) / 10,
    targetSurfaceAngleDeg: Math.round(end.angleDeg * 10) / 10,
    targetSurfaceLocalX: Math.round(end.localX * 10) / 10,
    targetSurfaceLocalY: Math.round(end.localY * 10) / 10,
    routePoints: points.map((point) => ({
      x: Math.round(point.x),
      y: Math.round(point.y),
    })),
  };
}

/** Builds a fast drag-preview route without mutating occupancy or running full quality refinement. */
function previewRouteEdgeGeometry(edge, from, to, nodeById = new Map(), priorRoutes = []) {
  const nodes = [...nodeById.values()];
  const start = routeEndpointSurfaceCandidates(edge, from, to, "source")[0];
  const end = routeEndpointSurfaceCandidates(edge, to, from, "target")[0];
  if (!start || !end) return null;
  let selected = null;
  for (const points of oneBendRouteCandidates(start, end).map(compactRoutePoints)) {
    const candidate = scoredRouteCandidate(edge, points, start, end, nodes, priorRoutes);
    if (candidate && routeScoreBetter(candidate, selected)) selected = candidate;
  }
  if (!selected) {
    selected = scoredRouteCandidate(edge, [start, {
      x: Math.round((start.x + end.x) / 2),
      y: Math.round((start.y + end.y) / 2),
    }, end], start, end, nodes, priorRoutes);
  }
  if (!selected) return null;
  const label = edgeLabelAnchor(selected.points.slice(1, -1), start, end);
  return {
    path: selected.path,
    labelX: label.x,
    labelY: label.y,
    routeModel: "preview-curved-segments",
    routeFrom: routeEdgeSourceId(edge),
    routeTo: routeEdgeTargetId(edge),
    routeRenderer: "curved-polyline",
    routePointCount: selected.points.length,
    routeLength: Math.round(routeLength(selected.points)),
    routeBends: routeBendCount(selected.points),
    routeCandidateScore: Math.round(selected.score.score),
    routePriorCrossings: selected.score.crossings,
    routeApproachAngle: Math.round(selected.score.approachAngle),
    routeSurfaceCost: Math.round(selected.score.surfaceCost),
    routeSourceNodeHits: selected.diagnostics.sourceHits,
    routeTargetNodeHits: selected.diagnostics.targetHits,
    routeNodeHits: selected.diagnostics.nodeHits,
    sourceSurfaceAngleDeg: Math.round(start.angleDeg * 10) / 10,
    sourceSurfaceLocalX: Math.round(start.localX * 10) / 10,
    sourceSurfaceLocalY: Math.round(start.localY * 10) / 10,
    targetSurfaceAngleDeg: Math.round(end.angleDeg * 10) / 10,
    targetSurfaceLocalX: Math.round(end.localX * 10) / 10,
    targetSurfaceLocalY: Math.round(end.localY * 10) / 10,
    routePoints: selected.points.map((point) => ({
      x: Math.round(point.x),
      y: Math.round(point.y),
    })),
  };
}

/** Builds visible self-loop geometry when an edge begins and ends at the same node. */
function fallbackLoopGeometry(edge, nodeById) {
  const from = nodeById.get(routeEdgeSourceId(edge));
  if (!from) return null;
  const start = graphSourceAnchor(edge, from);
  const end = graphTargetAnchor(edge, from);
  const width = graphNodeWidth(from);
  const loopX = from.x + width + 56;
  const loopTop = from.y - 38;
  const loopPoints = [
    start,
    { x: loopX, y: start.y },
    { x: loopX, y: loopTop },
    { x: from.x + width / 2, y: loopTop },
    { x: from.x - 28, y: loopTop },
    { x: from.x - 28, y: end.y },
    end,
  ];
  return {
    path: graphCurvedRouteThroughPoints(loopPoints),
    labelX: Math.round((from.x + width / 2 + loopX) / 2),
    labelY: loopTop - 8,
    routeModel: "grid-loop-fallback",
    routeFrom: routeEdgeSourceId(edge),
    routeTo: routeEdgeTargetId(edge),
    routeRenderer: "curved-polyline",
    routePoints: loopPoints.map((point) => ({
      x: Math.round(point.x),
      y: Math.round(point.y),
    })),
  };
}

/** Extracts the immutable point and endpoint facts needed by subsequent route scoring. */
function routePriorRecord(edge = {}) {
  const routePoints = Array.isArray(edge.routePoints) ? edge.routePoints : [];
  return {
    edge,
    points: routePoints,
    sourcePoint: routePoints[0] || null,
    targetPoint: routePoints[routePoints.length - 1] || null,
  };
}

/** Counts every node and endpoint obstacle diagnostic recorded on a routed edge. */
function routeHitTotal(edge = {}) {
  return Number(edge.routeSourceNodeHits || 0)
    + Number(edge.routeTargetNodeHits || 0)
    + Number(edge.routeNodeHits || 0);
}

/** Compares rerouted and current geometry across hits, crossings, score, bends, and length. */
function routeRerouteImprovesQuality(current = {}, candidate = {}) {
  const currentHits = routeHitTotal(current);
  const candidateHits = routeHitTotal(candidate);
  if (candidateHits > currentHits) return false;
  const currentCrossings = Number(current.routeCrossings || current.routePriorCrossings || 0);
  const candidateCrossings = Number(candidate.routePriorCrossings || 0);
  if (candidateCrossings < currentCrossings) return true;
  if (candidateCrossings > currentCrossings) return false;
  const currentApproach = Number(current.routeApproachAngle || 0);
  const candidateApproach = Number(candidate.routeApproachAngle || 0);
  if (candidateApproach < currentApproach - 4) return true;
  if (candidateApproach > currentApproach + 4) return false;
  return Number(candidate.routeLength || Infinity) < Number(current.routeLength || Infinity) * 0.95;
}

/** Re-routes a bounded set of severe crossing outliers without restoring full quality work for a dense projection. */
function improveCrossingOutlierRoute(routedEdges = [], nodeById = new Map(), nodes = [], containers = [], options = {}) {
  const annotatedEdges = annotateRouteCrossings(routedEdges);
  const crossingCandidates = annotatedEdges
    .filter((edge) => (
      edgeRouteBudget(edge) === "quality" && Number(edge.routeCrossings || 0) > 0
    ) || (
      edgeRouteBudget(edge) === "visibility"
      && Number(edge.routeCrossings || 0) >= ROUTE_VISIBILITY_REROUTE_MIN_CROSSINGS
    ))
    .sort((left, right) => Number(right.routeCrossings || 0) - Number(left.routeCrossings || 0)
      || Number(right.routeLength || 0) - Number(left.routeLength || 0)
      || String(left.id || "").localeCompare(String(right.id || "")))
    .slice(0, ROUTE_CROSSING_OUTLIER_REROUTE_LIMIT);
  if (!crossingCandidates.length) return annotatedEdges;

  const improvedById = new Map(annotatedEdges.map((edge, index) => [String(edge.id || index), edge]));
  for (const edge of crossingCandidates) {
    const edgeKey = String(edge.id || "");
    const priorRoutes = [...improvedById.entries()]
      .filter(([key]) => key !== edgeKey)
      .map(([, priorEdge]) => routePriorRecord(priorEdge));
    const qualityGrid = buildGraphRouteGrid(nodes, containers, options.gridOptions);
    priorRoutes.forEach((prior) => addGraphRouteOccupancy(qualityGrid, prior.points || []));
    const geometry = routeEdgeGeometry({
      ...edge,
      routeBudget: "quality-reroute",
    }, nodeById, qualityGrid, priorRoutes);
    if (!geometry) continue;
    const candidate = {
      ...edge,
      ...geometry,
      routeBudget: edgeRouteBudget(edge),
    };
    if (routeRerouteImprovesQuality(edge, candidate)) {
      improvedById.set(edgeKey, candidate);
    }
  }

  return annotateRouteCrossings(annotatedEdges.map((edge, index) =>
    improvedById.get(String(edge.id || index)) || edge
  ));
}

/** Routes all edges in deterministic order, tracks occupancy, and annotates final crossings. */
export function resolveGridRoutedEdgeGeometries(edges = [], nodeById = new Map(), nodes = [], containers = [], options = {}) {
  const grid = options.grid || buildGraphRouteGrid(nodes, containers, options.gridOptions);
  const entries = (Array.isArray(edges) ? edges : [])
    .map((edge, index) => ({ edge, index }))
    .sort((left, right) => compareRouteEntries(left, right, nodeById));
  const routedById = new Map();
  const priorRoutes = [];
  for (const entry of entries) {
    const edgeKey = String(entry.edge.id || entry.index);
    const geometry = routeEdgeSourceId(entry.edge) === routeEdgeTargetId(entry.edge)
      ? fallbackLoopGeometry(entry.edge, nodeById)
      : routeEdgeGeometry(entry.edge, nodeById, grid, priorRoutes);
    if (!geometry) continue;
    const routedEdge = {
      ...entry.edge,
      ...geometry,
    };
    routedById.set(edgeKey, routedEdge);
    priorRoutes.push(routePriorRecord(routedEdge));
  }
  const routedEdges = (Array.isArray(edges) ? edges : [])
    .map((edge, index) => routedById.get(String(edge.id || index)))
    .filter(Boolean);
  return routedEdges.some((edge) => ["quality", "visibility"].includes(edgeRouteBudget(edge)))
    ? improveCrossingOutlierRoute(routedEdges, nodeById, nodes, containers, options)
    : annotateRouteCrossings(routedEdges);
}
