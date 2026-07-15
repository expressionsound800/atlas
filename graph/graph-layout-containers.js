/*
 * Container Layout derives validated memberships, text reserves, container
 * dimensions, child distribution, and inter-group spacing from graph topology.
 */
import { GRAPH_ROUTE_GRID_CELL } from "./graph-grid.js";
import {
  clampNumber,
  graphNodeHeight,
  graphNodeRect,
  graphNodeWidth,
  normalizeId,
} from "./graph-geometry.js";
import {
  graphRectsRespectGap,
  isRootGraphNode,
  snapGraphCoordinateToGrid,
  snapGraphNodesToGrid,
  snapGraphRectOutToGrid,
} from "./graph-layout-grid.js";

const GRAPH_CONTAINER_PADDING_X = 34;
const GRAPH_CONTAINER_PADDING_TOP = 56;
const GRAPH_CONTAINER_PADDING_BOTTOM = 30;
const GRAPH_CONTAINER_NODE_GAP = GRAPH_ROUTE_GRID_CELL * 2;
const GRAPH_CONTAINER_OUTLIER_TARGET_GAP = GRAPH_ROUTE_GRID_CELL * 3;
const GRAPH_CONTAINER_OUTLIER_RATIO = 2;
const GRAPH_CONTAINER_COMPOSITION_MIN_NODES = 8;
const GRAPH_CONTAINER_COMPOSITION_MIN_ALIGNED_SHARE = 0.72;
const GRAPH_CONTAINER_COMPOSITION_MODEL = "staggered-flow-bands-v1";
const GRAPH_CONTAINER_FLOW_FIELD_MODEL = "container-local-hub-branch-fields-v2";
const GRAPH_CONTAINER_FLOW_FIELD_COMPOSITION_MODEL = "hub-branch-flow-fields-v2";
const GRAPH_CONTAINER_COMPOSITION_GAP_X = GRAPH_ROUTE_GRID_CELL * 3;
const GRAPH_CONTAINER_COMPOSITION_GAP_Y = GRAPH_ROUTE_GRID_CELL * 5;
const GRAPH_CONTAINER_RETURN_LANE_RESERVE_CELLS = 18;
const GRAPH_CONTAINER_FLOW_FIELD_GAP_CELLS = 3;

/** Computes the geometric center used to compare and separate container groups. */
function containerCenter(container = {}) {
  return {
    x: Number(container.x || 0) + Number(container.width || 0) / 2,
    y: Number(container.y || 0) + Number(container.height || 0) / 2,
  };
}

/** Measures empty horizontal, vertical, and diagonal distance between two container rectangles. */
function containerSeparation(left = {}, right = {}) {
  const horizontal = Math.max(0, left.x - (right.x + right.width), right.x - (left.x + left.width));
  const vertical = Math.max(0, left.y - (right.y + right.height), right.y - (left.y + left.height));
  return { horizontal, vertical, distance: Math.hypot(horizontal, vertical) };
}

/** Computes the median of a finite numeric list for source-neutral outlier comparison. */
function medianContainerGap(values = []) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Groups child nodes by one snapped axis so dense rectilinear arrangements can be measured without label semantics. */
function graphContainerAlignmentBands(nodes = [], axis = "y") {
  const bands = new Map();
  const orderedNodes = [...nodes].sort((left, right) => (
    Number(left?.[axis] || 0) - Number(right?.[axis] || 0)
    || String(left.id || "").localeCompare(String(right.id || ""))
  ));
  for (const node of orderedNodes) {
    const coordinate = snapGraphCoordinateToGrid(Number(node?.[axis] || 0));
    const matchingCoordinate = axis === "x"
      ? [...bands.keys()].find((candidate) => Math.abs(candidate - coordinate) <= GRAPH_ROUTE_GRID_CELL)
      : coordinate;
    const bandCoordinate = matchingCoordinate ?? coordinate;
    if (!bands.has(bandCoordinate)) bands.set(bandCoordinate, []);
    bands.get(bandCoordinate).push(node);
  }
  return [...bands.entries()]
    .map(([coordinate, entries]) => ({
      coordinate,
      entries: entries.sort((left, right) => (
        Number(left?.[axis === "x" ? "y" : "x"] || 0) - Number(right?.[axis === "x" ? "y" : "x"] || 0)
        || String(left.id || "").localeCompare(String(right.id || ""))
      )),
    }))
    .sort((left, right) => left.coordinate - right.coordinate);
}

/** Measures how much of a container participates in repeated rows or columns rather than isolated placements. */
function graphContainerAlignedShare(bands = []) {
  const entryCount = bands.reduce((sum, band) => sum + band.entries.length, 0);
  if (!entryCount) return 0;
  const alignedCount = bands
    .filter((band) => band.entries.length >= 3)
    .reduce((sum, band) => sum + band.entries.length, 0);
  return alignedCount / entryCount;
}

/** Selects one internal backward-flow source whose return pressure dominates its total degree. */
function graphContainerReturnLaneId(columns = [], edges = []) {
  const columnByNodeId = new Map();
  const nodeById = new Map();
  columns.forEach((column, columnIndex) => {
    column.entries.forEach((node) => {
      const nodeId = normalizeId(node.id);
      columnByNodeId.set(nodeId, columnIndex);
      nodeById.set(nodeId, node);
    });
  });
  const returnPressure = new Map();
  for (const edge of Array.isArray(edges) ? edges : []) {
    const from = normalizeId(edge.from);
    const to = normalizeId(edge.to);
    const fromColumn = columnByNodeId.get(from);
    const toColumn = columnByNodeId.get(to);
    if (!Number.isFinite(fromColumn) || !Number.isFinite(toColumn) || fromColumn <= toColumn) continue;
    returnPressure.set(from, Number(returnPressure.get(from) || 0) + fromColumn - toColumn);
  }
  return [...returnPressure.entries()]
    .map(([id, pressure]) => {
      const node = nodeById.get(id) || {};
      const incoming = Number(node?.graphSemantic?.incomingDegree || 0);
      const outgoing = Number(node?.graphSemantic?.outgoingDegree || 0);
      const degree = incoming + outgoing;
      return {
        id,
        pressure,
        incoming,
        outgoing,
        degree,
        returnShare: degree > 0 ? pressure / degree : 0,
        centerScore: Number(node.semanticCenterScore || 0),
      };
    })
    .filter((candidate) => candidate.incoming > 0 && candidate.outgoing > 0)
    .sort((left, right) => (
      right.returnShare - left.returnShare
      || right.pressure - left.pressure
      || right.centerScore - left.centerScore
      || left.degree - right.degree
      || left.id.localeCompare(right.id)
    ))[0]?.id || "";
}

/** Returns the leading vertical reserve assigned only to the selected return-lane node. */
function graphContainerReturnLaneReserve(node = {}, returnLaneId = "") {
  return returnLaneId && normalizeId(node.id) === returnLaneId
    ? GRAPH_CONTAINER_RETURN_LANE_RESERVE_CELLS * GRAPH_ROUTE_GRID_CELL
    : 0;
}

/** Returns vertical gaps that place the selected return-flow node below its column's primary lanes. */
function graphContainerColumnVerticalGaps(entries = [], returnLaneId = "") {
  return entries.slice(1).map((node) => (
    GRAPH_CONTAINER_COMPOSITION_GAP_Y
    + graphContainerReturnLaneReserve(node, returnLaneId)
  ));
}

/** Verifies proposed child positions retain one route-grid cell around every sibling rectangle. */
function graphContainerChildrenRespectGap(nodes = []) {
  const rects = nodes.map((node) => ({ node, rect: graphNodeRect(node) }));
  for (let leftIndex = 0; leftIndex < rects.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < rects.length; rightIndex += 1) {
      const left = rects[leftIndex];
      const right = rects[rightIndex];
      const separated = left.rect.right + GRAPH_ROUTE_GRID_CELL <= right.rect.left
        || right.rect.right + GRAPH_ROUTE_GRID_CELL <= left.rect.left
        || left.rect.bottom + GRAPH_ROUTE_GRID_CELL <= right.rect.top
        || right.rect.bottom + GRAPH_ROUTE_GRID_CELL <= left.rect.top;
      if (!separated) return false;
    }
  }
  return true;
}

/** Checks that one complete dense container carries the same dominant-hub field contract from semantic placement. */
function graphContainerUsesFlowFields(nodes = []) {
  const fieldNodes = nodes.filter((node) => (
    node.containerFlowModel === GRAPH_CONTAINER_FLOW_FIELD_MODEL
    && Number.isFinite(Number(node.containerFlowFieldLane))
    && Number(node.containerFlowFieldCount || 0) >= 2
  ));
  return fieldNodes.length >= GRAPH_CONTAINER_COMPOSITION_MIN_NODES
    && fieldNodes.length / Math.max(1, nodes.length) >= GRAPH_CONTAINER_COMPOSITION_MIN_ALIGNED_SHARE;
}

/** Preserves horizontal flow bands while expanding dominant-hub branch fields on a route-grid vertical rhythm. */
function composeFlowFieldGraphContainerChildren(childNodes = []) {
  if (!graphContainerUsesFlowFields(childNodes)) return null;
  if (childNodes.every((node) => (
    node.containerCompositionModel === GRAPH_CONTAINER_FLOW_FIELD_COMPOSITION_MODEL
  ))) {
    return childNodes;
  }
  const fieldNodes = childNodes.filter((node) => (
    node.containerFlowModel === GRAPH_CONTAINER_FLOW_FIELD_MODEL
    && Number.isFinite(Number(node.containerFlowFieldLane))
  ));
  const childRects = childNodes.map(graphNodeRect);
  const originalCenterY = (
    Math.min(...childRects.map((rect) => rect.top))
    + Math.max(...childRects.map((rect) => rect.bottom))
  ) / 2;
  const maximumHeight = Math.max(...fieldNodes.map(graphNodeHeight));
  const fieldPitch = Math.ceil((
    maximumHeight + GRAPH_CONTAINER_FLOW_FIELD_GAP_CELLS * GRAPH_ROUTE_GRID_CELL
  ) / GRAPH_ROUTE_GRID_CELL) * GRAPH_ROUTE_GRID_CELL;
  const fieldNodeIds = new Set(fieldNodes.map((node) => normalizeId(node.id)));
  const relativeNodes = childNodes.map((node) => ({
    ...node,
    x: snapGraphCoordinateToGrid(Number(node.x || 0)),
    // The room root is not part of side-local flow solving. It stays in the
    // center corridor while participating branch nodes take their signed lanes.
    y: fieldNodeIds.has(normalizeId(node.id))
      ? originalCenterY + Number(node.containerFlowFieldLane || 0) * fieldPitch - graphNodeHeight(node) / 2
      : Number(node.y || 0),
    containerCompositionModel: GRAPH_CONTAINER_FLOW_FIELD_COMPOSITION_MODEL,
    containerTopologyReserve: 0,
  }));
  const verticalOffset = Math.max(0, -Math.min(...relativeNodes.map((node) => graphNodeRect(node).top)));
  const composed = relativeNodes.map((node) => ({
    ...node,
    y: snapGraphCoordinateToGrid(Number(node.y || 0) + verticalOffset),
  }));
  return graphContainerChildrenRespectGap(composed) ? composed : null;
}

/** Returns zero for the first column and alternating one-cell offsets for every later semantic column. */
function graphContainerStagger(index = 0) {
  if (index === 0) return 0;
  return (index % 2 ? 1 : -1) * GRAPH_ROUTE_GRID_CELL;
}

/** Repositions qualifying columnar children into bounded, collision-safe semantic columns with alternating vertical phases. */
function composeDenseGraphContainerChildren(childNodes = [], edges = []) {
  if (childNodes.length < GRAPH_CONTAINER_COMPOSITION_MIN_NODES) return childNodes;
  if (childNodes.some((node) => node.containerCompositionModel === GRAPH_CONTAINER_COMPOSITION_MODEL)) {
    return childNodes;
  }
  const semanticColumns = graphContainerAlignmentBands(childNodes, "x");
  if (semanticColumns.length < 3) return childNodes;
  if (graphContainerAlignedShare(semanticColumns) < GRAPH_CONTAINER_COMPOSITION_MIN_ALIGNED_SHARE) return childNodes;
  const maxEntriesPerColumn = Math.max(3, Math.ceil(Math.sqrt(childNodes.length)));
  const columns = semanticColumns.flatMap((column) => {
    const splitColumns = [];
    for (let index = 0; index < column.entries.length; index += maxEntriesPerColumn) {
      splitColumns.push({
        ...column,
        entries: column.entries.slice(index, index + maxEntriesPerColumn),
      });
    }
    return splitColumns;
  });

  const childRects = childNodes.map(graphNodeRect);
  const centerX = (
    Math.min(...childRects.map((rect) => rect.left))
    + Math.max(...childRects.map((rect) => rect.right))
  ) / 2;
  const centerY = (
    Math.min(...childRects.map((rect) => rect.top))
    + Math.max(...childRects.map((rect) => rect.bottom))
  ) / 2;
  const returnLaneId = graphContainerReturnLaneId(columns, edges);
  const layoutColumns = columns.map((column) => ({
    ...column,
    entries: column.entries.some((node) => normalizeId(node.id) === returnLaneId)
      ? [
        ...column.entries.filter((node) => normalizeId(node.id) !== returnLaneId),
        ...column.entries.filter((node) => normalizeId(node.id) === returnLaneId),
      ]
      : column.entries,
  }));
  const columnWidths = layoutColumns.map((column) => Math.max(...column.entries.map(graphNodeWidth)));
  const composedWidth = columnWidths.reduce((sum, width) => sum + width, 0)
    + GRAPH_CONTAINER_COMPOSITION_GAP_X * Math.max(0, layoutColumns.length - 1);
  let nextX = snapGraphCoordinateToGrid(centerX - composedWidth / 2);
  const composed = layoutColumns.flatMap((column, columnIndex) => {
    const verticalGaps = graphContainerColumnVerticalGaps(column.entries, returnLaneId);
    // Center the ordinary column rhythm, then spend the topology reserve only
    // below it. Re-centering the exceptional gap would move every primary-lane
    // node and dilute the clearing effect that the peripheral lane is for.
    const primaryColumnHeight = column.entries.reduce((sum, node) => sum + graphNodeHeight(node), 0)
      + GRAPH_CONTAINER_COMPOSITION_GAP_Y * Math.max(0, column.entries.length - 1);
    let nextY = snapGraphCoordinateToGrid(
      centerY - primaryColumnHeight / 2 + graphContainerStagger(columnIndex),
    );
    const columnX = nextX;
    nextX = snapGraphCoordinateToGrid(nextX + columnWidths[columnIndex] + GRAPH_CONTAINER_COMPOSITION_GAP_X);
    return column.entries.map((node, entryIndex) => {
      const positioned = {
        ...node,
        x: columnX,
        y: nextY,
        containerCompositionModel: GRAPH_CONTAINER_COMPOSITION_MODEL,
        containerTopologyReserve: graphContainerReturnLaneReserve(node, returnLaneId),
      };
      nextY = snapGraphCoordinateToGrid(
        nextY + graphNodeHeight(node) + Number(verticalGaps[entryIndex] || 0),
      );
      return positioned;
    });
  });
  return graphContainerChildrenRespectGap(composed) ? composed : childNodes;
}

/** Derives one grid-snapped translation that reduces only the dominant empty axis toward the breathing target. */
function containerOutlierDelta(container = {}, neighbor = {}, separation = {}) {
  if (separation.vertical >= separation.horizontal && separation.vertical > GRAPH_CONTAINER_OUTLIER_TARGET_GAP) {
    const amount = Math.floor((separation.vertical - GRAPH_CONTAINER_OUTLIER_TARGET_GAP) / GRAPH_ROUTE_GRID_CELL)
      * GRAPH_ROUTE_GRID_CELL;
    return container.y + container.height <= neighbor.y ? { x: 0, y: amount } : { x: 0, y: -amount };
  }
  if (separation.horizontal > GRAPH_CONTAINER_OUTLIER_TARGET_GAP) {
    const amount = Math.floor((separation.horizontal - GRAPH_CONTAINER_OUTLIER_TARGET_GAP) / GRAPH_ROUTE_GRID_CELL)
      * GRAPH_ROUTE_GRID_CELL;
    return container.x + container.width <= neighbor.x ? { x: amount, y: 0 } : { x: -amount, y: 0 };
  }
  return { x: 0, y: 0 };
}

/** Builds first-owner child membership so nested or duplicate declarations remain deterministic. */
function containerNodeOwnership(containers = []) {
  const ownership = new Map();
  for (const container of Array.isArray(containers) ? containers : []) {
    for (const id of Array.isArray(container.nodeIds) ? container.nodeIds : []) {
      const nodeId = normalizeId(id);
      ownership.set(nodeId, (ownership.get(nodeId) || 0) + 1);
    }
  }
  return ownership;
}

/** Filters duplicate container membership and returns canonical child lists in source order. */
export function canonicalGraphContainers(containers = []) {
  const claimedNodeIds = new Set();
  return (Array.isArray(containers) ? containers : []).map((container) => {
    const nodeIds = [];
    for (const id of Array.isArray(container.nodeIds) ? container.nodeIds : []) {
      const nodeId = normalizeId(id);
      if (!nodeId || claimedNodeIds.has(nodeId)) continue;
      claimedNodeIds.add(nodeId);
      nodeIds.push(nodeId);
    }
    return {
      ...container,
      nodeIds,
    };
  });
}

/** Translates only nodes canonically owned by one container group by the supplied delta. */
function moveContainerGroupNodes(nodesById, container = {}, ownership = new Map(), delta = {}) {
  let moved = false;
  for (const id of Array.isArray(container.nodeIds) ? container.nodeIds : []) {
    const nodeId = normalizeId(id);
    if ((ownership.get(nodeId) || 0) !== 1) continue;
    const node = nodesById.get(nodeId);
    if (!node) continue;
    nodesById.set(nodeId, {
      ...node,
      x: snapGraphCoordinateToGrid(Number(node.x || 0) + Number(delta.x || 0)),
      y: snapGraphCoordinateToGrid(Number(node.y || 0) + Number(delta.y || 0)),
    });
    moved = true;
  }
  return moved;
}

/** Moves colliding container groups apart while preserving each group's internal arrangement. */
export function separateGraphContainerGroups(nodes = [], containers = []) {
  if (!Array.isArray(nodes) || !nodes.length || !Array.isArray(containers) || containers.length < 2) {
    return nodes;
  }
  const ownership = containerNodeOwnership(containers);
  let positioned = snapGraphNodesToGrid(nodes);

  for (let pass = 0; pass < 8; pass += 1) {
    const calculatedContainers = layoutGraphContainers(containers, positioned);
    let moved = false;
    for (let leftIndex = 0; leftIndex < calculatedContainers.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < calculatedContainers.length; rightIndex += 1) {
        const left = calculatedContainers[leftIndex];
        const right = calculatedContainers[rightIndex];
        if (graphRectsRespectGap(left, right)) continue;

        const leftCenter = containerCenter(left);
        const rightCenter = containerCenter(right);
        const horizontalPush = leftCenter.x <= rightCenter.x
          ? left.x + left.width + GRAPH_ROUTE_GRID_CELL - right.x
          : right.x + right.width + GRAPH_ROUTE_GRID_CELL - left.x;
        const verticalPush = leftCenter.y <= rightCenter.y
          ? left.y + left.height + GRAPH_ROUTE_GRID_CELL - right.y
          : right.y + right.height + GRAPH_ROUTE_GRID_CELL - left.y;
        const moveOnY = verticalPush <= horizontalPush;
        const moveTarget = moveOnY
          ? leftCenter.y <= rightCenter.y ? right : left
          : leftCenter.x <= rightCenter.x ? right : left;
        const delta = moveOnY
          ? { x: 0, y: Math.ceil(verticalPush / GRAPH_ROUTE_GRID_CELL) * GRAPH_ROUTE_GRID_CELL }
          : { x: Math.ceil(horizontalPush / GRAPH_ROUTE_GRID_CELL) * GRAPH_ROUTE_GRID_CELL, y: 0 };
        const nodesById = new Map(positioned.map((node) => [normalizeId(node.id), node]));
        if (moveContainerGroupNodes(nodesById, moveTarget, ownership, delta)) {
          positioned = snapGraphNodesToGrid(positioned.map((node) => nodesById.get(normalizeId(node.id)) || node));
          moved = true;
        }
      }
    }
    if (!moved) break;
  }

  return positioned;
}

/** Pulls only statistically isolated container groups toward a three-cell gap when the translation stays collision-safe. */
export function compactGraphContainerGroupOutliers(nodes = [], containers = []) {
  if (!Array.isArray(nodes) || !nodes.length || !Array.isArray(containers) || containers.length < 3) {
    return nodes;
  }
  const ownership = containerNodeOwnership(containers);
  let positioned = snapGraphNodesToGrid(nodes);
  for (let pass = 0; pass < 3; pass += 1) {
    const calculatedContainers = layoutGraphContainers(containers, positioned);
    const nearest = calculatedContainers.map((container, index) => calculatedContainers
      .filter((_, candidateIndex) => candidateIndex !== index)
      .map((candidate) => ({
        container,
        neighbor: candidate,
        ...containerSeparation(container, candidate),
      }))
      .sort((left, right) => left.distance - right.distance || String(left.neighbor.id).localeCompare(String(right.neighbor.id)))[0])
      .filter(Boolean);
    const medianGap = medianContainerGap(nearest.map((entry) => entry.distance));
    const threshold = Math.max(GRAPH_CONTAINER_OUTLIER_TARGET_GAP, medianGap * GRAPH_CONTAINER_OUTLIER_RATIO);
    const outlier = nearest
      .filter((entry) => entry.distance > threshold)
      .sort((left, right) => right.distance - left.distance || String(left.container.id).localeCompare(String(right.container.id)))[0];
    if (!outlier) break;
    const delta = containerOutlierDelta(outlier.container, outlier.neighbor, outlier);
    if (!delta.x && !delta.y) break;
    const proposed = {
      ...outlier.container,
      x: outlier.container.x + delta.x,
      y: outlier.container.y + delta.y,
    };
    const collisionSafe = calculatedContainers.every((container) => (
      container.id === outlier.container.id || graphRectsRespectGap(proposed, container)
    ));
    if (!collisionSafe) break;
    const nodesById = new Map(positioned.map((node) => [normalizeId(node.id), node]));
    if (!moveContainerGroupNodes(nodesById, outlier.container, ownership, delta)) break;
    positioned = snapGraphNodesToGrid(positioned.map((node) => nodesById.get(normalizeId(node.id)) || node));
  }
  return positioned;
}

/** Computes header and description height reserved above a container's child-node content. */
function graphContainerTextReserve(container = {}, contentWidth = 280) {
  const textBlocks = [
    String(container.description || "").trim(),
    String(container?.metadata?.currentObjective || container?.currentObjective || "").trim(),
  ].filter(Boolean);
  if (!textBlocks.length) return GRAPH_CONTAINER_PADDING_TOP;
  const usableWidth = clampNumber(Number(contentWidth) || 280, 180, 420);
  const charsPerLine = Math.max(24, Math.floor(usableWidth / 6.1));
  const textLines = textBlocks.reduce((sum, text) => (
    sum + Math.max(1, Math.ceil(text.length / charsPerLine))
  ), 0);
  const textHeight = 13 + 16 + 8 + textLines * 13 + (textBlocks.length - 1) * 4 + 10;
  return clampNumber(textHeight, GRAPH_CONTAINER_PADDING_TOP, 132);
}

/** Redistributes owned child nodes vertically beneath container text with stable spacing. */
export function distributeGraphNodesWithinContainers(nodes = [], containers = [], edges = []) {
  if (!Array.isArray(nodes) || !nodes.length || !Array.isArray(containers) || !containers.length) {
    return nodes;
  }
  const adjustedById = new Map(nodes.map((node) => [normalizeId(node.id), { ...node }]));
  const membershipCount = new Map();
  containers.forEach((container) => {
    (Array.isArray(container.nodeIds) ? container.nodeIds : []).forEach((id) => {
      const nodeId = normalizeId(id);
      membershipCount.set(nodeId, (membershipCount.get(nodeId) || 0) + 1);
    });
  });

  containers.forEach((container) => {
    const childNodes = (Array.isArray(container.nodeIds) ? container.nodeIds : [])
      .map((id) => adjustedById.get(normalizeId(id)))
      .filter((node) => node && !isRootGraphNode(node) && membershipCount.get(normalizeId(node.id)) === 1)
      .sort((left, right) => Number(left.y || 0) - Number(right.y || 0));
    if (childNodes.length < 2) return;
    if (graphContainerUsesFlowFields(childNodes)) return;

    const childRects = childNodes.map(graphNodeRect);
    const childCentersX = childRects.map((rect) => (rect.left + rect.right) / 2);
    const childCenterSpreadX = Math.max(...childCentersX) - Math.min(...childCentersX);
    if (childCenterSpreadX > GRAPH_ROUTE_GRID_CELL * 1.5) return;
    const childTop = Math.min(...childRects.map((rect) => rect.top));
    const childBottom = Math.max(...childRects.map((rect) => rect.bottom));
    const childCenterY = (childTop + childBottom) / 2;
    const childHeightTotal = childNodes.reduce((sum, node) => sum + graphNodeHeight(node), 0);
    const targetGap = GRAPH_CONTAINER_NODE_GAP;
    const targetBandHeight = childHeightTotal + targetGap * (childNodes.length - 1);
    const currentBandHeight = childBottom - childTop;
    if (Math.abs(currentBandHeight - targetBandHeight) < 18) return;

    let nextY = snapGraphCoordinateToGrid(childCenterY - targetBandHeight / 2);
    childNodes.forEach((node) => {
      const positionedNode = adjustedById.get(normalizeId(node.id));
      if (!positionedNode) return;
      positionedNode.y = nextY;
      nextY += graphNodeHeight(positionedNode) + targetGap;
    });
  });

  containers.forEach((container) => {
    const childNodes = (Array.isArray(container.nodeIds) ? container.nodeIds : [])
      .map((id) => adjustedById.get(normalizeId(id)))
      .filter((node) => node && membershipCount.get(normalizeId(node.id)) === 1);
    const composedNodes = composeFlowFieldGraphContainerChildren(childNodes)
      || composeDenseGraphContainerChildren(childNodes, edges);
    composedNodes.forEach((node) => adjustedById.set(normalizeId(node.id), node));
  });

  return nodes.map((node) => adjustedById.get(normalizeId(node.id)) || node);
}

/** Derives a padded container rectangle from the extents of its visible owned children. */
function graphContainerRectFromNodes(container = {}, nodesById = new Map()) {
  const childRects = (Array.isArray(container.nodeIds) ? container.nodeIds : [])
    .map((id) => nodesById.get(normalizeId(id)))
    .filter(Boolean)
    .map(graphNodeRect);
  if (!childRects.length) return null;
  const bounds = childRects.reduce((current, rect) => ({
    left: Math.min(current.left, rect.left),
    top: Math.min(current.top, rect.top),
    right: Math.max(current.right, rect.right),
    bottom: Math.max(current.bottom, rect.bottom),
  }), {
    left: Infinity,
    top: Infinity,
    right: -Infinity,
    bottom: -Infinity,
  });
  const contentWidth = Math.round(bounds.right - bounds.left + GRAPH_CONTAINER_PADDING_X * 2 - 30);
  const topPadding = graphContainerTextReserve(container, contentWidth);
  return {
    ...snapGraphRectOutToGrid({
      x: bounds.left - GRAPH_CONTAINER_PADDING_X,
      y: bounds.top - topPadding,
      width: bounds.right - bounds.left + GRAPH_CONTAINER_PADDING_X * 2,
      height: bounds.bottom - bounds.top + topPadding + GRAPH_CONTAINER_PADDING_BOTTOM,
    }),
  };
}

/** Builds final container rectangles after child distribution and canonical membership resolution. */
export function layoutGraphContainers(containers = [], nodes = []) {
  const nodesById = new Map(nodes.map((node) => [normalizeId(node.id), node]));
  return (Array.isArray(containers) ? containers : [])
    .map((container, index) => {
      const rect = graphContainerRectFromNodes(container, nodesById);
      if (!rect) return null;
      return {
        ...container,
        ...rect,
        order: index,
      };
    })
    .filter(Boolean);
}
