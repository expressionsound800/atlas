/*
 * Graph Grid owns the discrete routing field, occupancy bookkeeping, neighbor
 * expansion, and path reconstruction used by deterministic edge routing.
 */
import {
  ORIGIN_X,
  ORIGIN_Y,
  clampNumber,
  graphNodeRect,
} from "./graph-geometry.js";

export const GRAPH_ROUTE_GRID_CELL = 32;

/** Converts finite container geometry into the rectangle shape used by route occupancy. */
function rectFromContainer(container = {}) {
  const x = Number(container.x);
  const y = Number(container.y);
  const width = Number(container.width);
  const height = Number(container.height);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return {
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
  };
}

/** Expands an obstacle rectangle uniformly to reserve routing clearance around it. */
function expandRect(rect, amount) {
  return {
    left: rect.left - amount,
    top: rect.top - amount,
    right: rect.right + amount,
    bottom: rect.bottom + amount,
  };
}

/** Checks strict area intersection between two axis-aligned routing rectangles. */
function rectIntersects(left, right) {
  return left.left < right.right
    && left.right > right.left
    && left.top < right.bottom
    && left.bottom > right.top;
}

/** Checks whether a point lies within an axis-aligned rectangle including its boundary. */
function rectContainsPoint(rect, point) {
  return point.x >= rect.left
    && point.x <= rect.right
    && point.y >= rect.top
    && point.y <= rect.bottom;
}

/** Converts one grid coordinate into its exact world-space cell rectangle. */
function cellRect(grid, col, row) {
  const left = grid.left + col * grid.cellSize;
  const top = grid.top + row * grid.cellSize;
  return {
    left,
    top,
    right: left + grid.cellSize,
    bottom: top + grid.cellSize,
  };
}

/** Maps a grid column and row to the flat occupancy-array index. */
function cellIndex(grid, col, row) {
  return row * grid.cols + col;
}

/** Applies blocking and traversal cost to every route-grid cell intersecting a rectangle. */
function markRect(grid, rect, options = {}) {
  if (!rect) return;
  const startCol = clampNumber(Math.floor((rect.left - grid.left) / grid.cellSize), 0, grid.cols - 1);
  const endCol = clampNumber(Math.floor((rect.right - grid.left) / grid.cellSize), 0, grid.cols - 1);
  const startRow = clampNumber(Math.floor((rect.top - grid.top) / grid.cellSize), 0, grid.rows - 1);
  const endRow = clampNumber(Math.floor((rect.bottom - grid.top) / grid.cellSize), 0, grid.rows - 1);
  for (let row = startRow; row <= endRow; row += 1) {
    for (let col = startCol; col <= endCol; col += 1) {
      if (!rectIntersects(rect, cellRect(grid, col, row))) continue;
      const index = cellIndex(grid, col, row);
      if (options.blocked) grid.blocked[index] = 1;
      if (Number.isFinite(Number(options.cost))) {
        grid.cost[index] += Number(options.cost);
      }
    }
  }
}

/** Builds a padded discrete route field with node obstacles and graded container clearance. */
export function buildGraphRouteGrid(nodes = [], containers = [], options = {}) {
  const cellSize = Math.max(12, Number(options.cellSize) || GRAPH_ROUTE_GRID_CELL);
  const nodeRects = (Array.isArray(nodes) ? nodes : [])
    .filter(Boolean)
    .map((node) => ({ id: node.id, rect: graphNodeRect(node) }));
  const containerRects = (Array.isArray(containers) ? containers : [])
    .map((container) => ({ id: container.id, rect: rectFromContainer(container) }))
    .filter((entry) => entry.rect);
  const allRects = [
    ...nodeRects.map((entry) => entry.rect),
    ...containerRects.map((entry) => entry.rect),
  ];
  const bounds = allRects.reduce((current, rect) => ({
    left: Math.min(current.left, rect.left),
    top: Math.min(current.top, rect.top),
    right: Math.max(current.right, rect.right),
    bottom: Math.max(current.bottom, rect.bottom),
  }), {
    left: ORIGIN_X,
    top: ORIGIN_Y,
    right: ORIGIN_X + 720,
    bottom: ORIGIN_Y + 420,
  });
  const padding = Math.max(96, Number(options.padding) || 160);
  const left = Math.floor(Math.max(0, bounds.left - padding) / cellSize) * cellSize;
  const top = Math.floor(Math.max(0, bounds.top - padding) / cellSize) * cellSize;
  const right = Math.ceil((bounds.right + padding) / cellSize) * cellSize;
  const bottom = Math.ceil((bounds.bottom + padding) / cellSize) * cellSize;
  const cols = Math.max(1, Math.ceil((right - left) / cellSize));
  const rows = Math.max(1, Math.ceil((bottom - top) / cellSize));
  const grid = {
    cellSize,
    left,
    top,
    right,
    bottom,
    cols,
    rows,
    cost: new Float64Array(cols * rows),
    blocked: new Uint8Array(cols * rows),
    nodeRects,
    containerRects,
  };

  for (const { rect } of containerRects) {
    markRect(grid, {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.top + Math.min(96, Math.max(58, (rect.bottom - rect.top) * 0.22)),
    }, { cost: 22 });
    markRect(grid, expandRect(rect, 8), { cost: 3 });
  }

  for (const { rect } of nodeRects) {
    markRect(grid, expandRect(rect, 10), { blocked: true });
    markRect(grid, expandRect(rect, 46), { cost: 18 });
    markRect(grid, expandRect(rect, 82), { cost: 5 });
  }

  return grid;
}

/** Maps a world-space point to the nearest in-bounds containing route-grid cell. */
export function graphGridPointToCell(grid, point = {}) {
  return {
    col: clampNumber(Math.floor((Number(point.x || 0) - grid.left) / grid.cellSize), 0, grid.cols - 1),
    row: clampNumber(Math.floor((Number(point.y || 0) - grid.top) / grid.cellSize), 0, grid.rows - 1),
  };
}

/** Computes the rounded world-space center of one route-grid cell. */
export function graphGridCellCenter(grid, cell = {}) {
  return {
    x: Math.round(grid.left + (Number(cell.col || 0) + 0.5) * grid.cellSize),
    y: Math.round(grid.top + (Number(cell.row || 0) + 0.5) * grid.cellSize),
  };
}

/** Returns the flat occupancy-array index for a route-grid cell object. */
export function graphGridCellIndex(grid, cell = {}) {
  return cellIndex(grid, Number(cell.col || 0), Number(cell.row || 0));
}

/** Checks cell blockage while allowing endpoints inside their own source or target rectangles. */
export function graphGridCellBlocked(grid, cell = {}, allowedRects = []) {
  const index = graphGridCellIndex(grid, cell);
  if (!grid.blocked[index]) return false;
  const center = graphGridCellCenter(grid, cell);
  return !(Array.isArray(allowedRects) ? allowedRects : []).some((rect) => rectContainsPoint(rect, center));
}

/** Finds the closest traversable cell around a blocked endpoint using expanding square rings. */
export function graphGridNearestOpenCell(grid, point = {}, allowedRects = []) {
  const origin = graphGridPointToCell(grid, point);
  if (!graphGridCellBlocked(grid, origin, allowedRects)) return origin;
  const maxRadius = Math.max(grid.cols, grid.rows);
  for (let radius = 1; radius <= maxRadius; radius += 1) {
    let best = null;
    let bestDistance = Infinity;
    for (let row = origin.row - radius; row <= origin.row + radius; row += 1) {
      for (let col = origin.col - radius; col <= origin.col + radius; col += 1) {
        if (col < 0 || row < 0 || col >= grid.cols || row >= grid.rows) continue;
        if (Math.abs(col - origin.col) !== radius && Math.abs(row - origin.row) !== radius) continue;
        const cell = { col, row };
        if (graphGridCellBlocked(grid, cell, allowedRects)) continue;
        const center = graphGridCellCenter(grid, cell);
        const distance = Math.hypot(center.x - point.x, center.y - point.y);
        if (distance < bestDistance) {
          best = cell;
          bestDistance = distance;
        }
      }
    }
    if (best) return best;
  }
  return origin;
}

/** Returns the accumulated soft traversal penalty assigned to one route-grid cell. */
export function graphGridCellCost(grid, cell = {}) {
  return grid.cost[graphGridCellIndex(grid, cell)] || 0;
}

/** Adds a routed polyline's cells and interpolated segments as soft future-route occupancy. */
export function addGraphRouteOccupancy(grid, points = []) {
  const routePoints = (Array.isArray(points) ? points : [])
    .map((point) => ({ x: Number(point?.x), y: Number(point?.y) }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  /** Marks the route cell around one sampled polyline point with crossing-avoidance cost. */
  const markPoint = (point) => {
    const cell = graphGridPointToCell(grid, point);
    markRect(grid, expandRect(cellRect(grid, cell.col, cell.row), grid.cellSize * 0.85), { cost: 34 });
  };
  routePoints.forEach(markPoint);
  for (let index = 1; index < routePoints.length; index += 1) {
    const start = routePoints[index - 1];
    const end = routePoints[index];
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    const steps = Math.max(1, Math.ceil(distance / Math.max(6, grid.cellSize / 2)));
    for (let step = 1; step < steps; step += 1) {
      const t = step / steps;
      markPoint({
        x: start.x + (end.x - start.x) * t,
        y: start.y + (end.y - start.y) * t,
      });
    }
  }
}
