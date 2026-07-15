/*
 * Graph Geometry defines node dimensions, boundary anchors, connector markers,
 * path sampling, collision bounds, and visible-content measurement primitives.
 */
const NODE_BASE_CHROME_WIDTH = 40;
const NODE_RECORD_CHROME_WIDTH = 16;
const NODE_LABEL_PADDING_COMPENSATION = 12;
const NODE_LABEL_MEASURE_FONT = '500 16px "Roboto Flex Local", "Roboto Local", sans-serif';
const NODE_EXTENDED_CONNECTOR_EDGE_INSET = 1.5;
const NODE_CONNECTOR_EDGE_INSET = 2;
const NODE_CONNECTOR_INBOUND_BORDER_INSET = 0.25;
const NODE_CONNECTOR_OUTBOUND_BORDER_INSET = 1.5;
const EDGE_LABEL_COMPRESSION_MAX_DX = 128;
const EDGE_LABEL_COMPRESSION_MAX_DY = 72;
const EDGE_FIT_BOUNDS_PADDING = 12;
const GRAPH_ARROW_TIP_BIAS = -1;
const GRAPH_NODE_PRESENTATION_EXTENDED = "extended";

export const GRAPH_NODE_GRID_UNIT = 32;
export const NODE_MIN_WIDTH = GRAPH_NODE_GRID_UNIT * 4;
export const NODE_MAX_WIDTH = GRAPH_NODE_GRID_UNIT * 8;
export const NODE_LABEL_MIN_WIDTH = 56;
export const NODE_LABEL_MAX_WIDTH = 180;
export const NODE_HEIGHT = GRAPH_NODE_GRID_UNIT;
export const NODE_EXTENDED_WIDTH = GRAPH_NODE_GRID_UNIT * 8;
export const NODE_EXTENDED_MIN_HEIGHT = GRAPH_NODE_GRID_UNIT * 3;
export const EDGE_LABEL_WIDTH = 92;
export const EDGE_LABEL_HEIGHT = 18;
export const EDGE_PATH_BOUNDS_PADDING = 72;
export const ORIGIN_X = 48;
export const ORIGIN_Y = 64;
export const GRAPH_NODE_SHAPE_CAPSULE = "capsule";
export const GRAPH_NODE_SHAPE_CARD = "card";
export const GRAPH_PORT_LEFT = "left";
export const GRAPH_PORT_RIGHT = "right";
export const GRAPH_PORT_TOP = "top";
export const GRAPH_PORT_BOTTOM = "bottom";

/** Converts a screen-space angle in degrees to a normalized Graph direction vector. */
export function graphVectorFromAngleDeg(angleDeg) {
  const angle = Number.isFinite(Number(angleDeg)) ? Number(angleDeg) : 0;
  const radians = (angle * Math.PI) / 180;
  return normalizeVector({ x: Math.cos(radians), y: Math.sin(radians) });
}

/** Converts a direction vector to the normalized zero-through-360 Graph angle convention. */
export function graphAngleDegFromVector(vector = {}) {
  const normalized = normalizeVector(vector, { x: 1, y: 0 });
  const angle = (Math.atan2(normalized.y, normalized.x) * 180) / Math.PI;
  return Math.round((((angle % 360) + 360) % 360) * 10) / 10;
}

/** Maps a semantic graph side to its canonical outward direction angle. */
export function graphAngleDegForGraphSide(side) {
  const normalized = String(side || "").trim().toLowerCase();
  if (normalized === GRAPH_PORT_LEFT) return 180;
  if (normalized === GRAPH_PORT_TOP) return 270;
  if (normalized === GRAPH_PORT_BOTTOM) return 90;
  return 0;
}

/** Normalizes Graph identities to trimmed uppercase values for cross-provider comparison. */
export function normalizeId(value) {
  return String(value || "").trim().toUpperCase();
}

/** Normalizes semantic kind tokens to lowercase hyphenated CSS-safe values. */
export function normalizeKind(value) {
  return String(value || "").trim().toLowerCase();
}

/** Normalizes transport-state vocabulary to the supported idle, playing, and recording tokens. */
export function normalizeTransportToken(token) {
  const safe = String(token || "").trim().toUpperCase();
  return ["PLAYING", "PAUSED", "PENDING", "EXCLUDED", "AUDITING", "STOPPED"].includes(safe)
    ? safe
    : "";
}

/** Normalizes record-state vocabulary to the persisted, pending, conflict, or empty contract. */
function normalizeRecordStateToken(value) {
  const token = String(value || "")
    .trim()
    .replace(/[\s-]+/g, "_")
    .toUpperCase();
  if (token === "RECORDING") return "RECORDING";
  if (token === "ARMED" || token === "REC_ARMED") return "ARMED";
  if (token === "OFF" || token === "REC_OFF") return "OFF";
  return "";
}

/** Maps a normalized record state to the compact node indicator glyph. */
function recordStateIndicatorText(token) {
  const safe = normalizeRecordStateToken(token);
  if (safe === "RECORDING") return "play_circle";
  if (safe === "ARMED") return "not_started";
  return "";
}

/** Splits identifier text into numeric and lexical parts for human-natural ordering. */
function naturalSortKey(value) {
  const text = normalizeId(value);
  const match = /^([A-Z]+)(\d+)$/.exec(text);
  if (!match) return [text, 0];
  return [match[1], Number.parseInt(match[2], 10)];
}

/** Compares identifiers by natural numeric segments before stable normalized text fallback. */
export function compareIds(left, right) {
  const leftKey = naturalSortKey(left);
  const rightKey = naturalSortKey(right);
  if (leftKey[0] !== rightKey[0]) return leftKey[0] < rightKey[0] ? -1 : 1;
  if (leftKey[1] !== rightKey[1]) return leftKey[1] - rightKey[1];
  return normalizeId(left).localeCompare(normalizeId(right));
}

/** Maps node kind to its stable ordering band within equal layout coordinates. */
function graphKindOrder(kind) {
  return normalizeKind(kind) === "clock" ? 0 : 1;
}

/** Orders nodes by explicit graph order, semantic kind band, label, and identity. */
export function compareGraphNodes(left, right) {
  return graphKindOrder(left?.kind) - graphKindOrder(right?.kind)
    || compareIds(left?.id, right?.id);
}

/** Clamps a numeric value to inclusive geometry bounds after finite conversion. */
export function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Rounds a node extent upward to the shared grid within presentation limits. */
function ceilToGraphGrid(value, min, max) {
  const bounded = clampNumber(Number(value) || min, min, max);
  return clampNumber(Math.ceil(bounded / GRAPH_NODE_GRID_UNIT) * GRAPH_NODE_GRID_UNIT, min, max);
}

/** Estimates one character's proportional label width for non-browser geometry calculation. */
function graphNodeLabelCharacterWidth(char) {
  if (!char) return 0;
  if (/\s/.test(char)) return 3.5;
  if (/[ijlI.,:;!|'`]/.test(char)) return 4.1;
  if (/[frt]/.test(char)) return 5.2;
  if (/[MW@#%&]/.test(char)) return 9;
  if (/[A-Z0-9]/.test(char)) return 7.3;
  if (/[\u0080-\uFFFF]/.test(char)) return 12;
  return 6.9;
}

let graphNodeLabelMeasureContext = null;
let graphNodeLabelMeasureUnavailable = false;

/** Measures node label width through browser canvas when a rendering context is available. */
function graphNodeLabelMeasuredWidth(labelText) {
  if (graphNodeLabelMeasureUnavailable) return null;
  try {
    if (!graphNodeLabelMeasureContext) {
      graphNodeLabelMeasureContext = document.createElement("canvas")?.getContext?.("2d") || null;
    }
    if (!graphNodeLabelMeasureContext) {
      graphNodeLabelMeasureUnavailable = true;
      return null;
    }
    graphNodeLabelMeasureContext.font = NODE_LABEL_MEASURE_FONT;
    const metrics = graphNodeLabelMeasureContext.measureText(String(labelText || ""));
    const width = Number(metrics?.width);
    return Number.isFinite(width) && width > 0 ? Math.ceil(width) : null;
  } catch (_error) {
    graphNodeLabelMeasureUnavailable = true;
    return null;
  }
}

/** Estimates full label width from character classes when browser measurement is unavailable. */
function graphNodeLabelFallbackWidth(labelText) {
  return Math.ceil(
    Array.from(String(labelText || "")).reduce(
      (width, char) => width + graphNodeLabelCharacterWidth(char),
      0,
    ),
  );
}

/** Selects measured or estimated label width and adds the standard text safety allowance. */
export function graphNodeLabelWidthEstimate(labelText) {
  const measuredWidth = graphNodeLabelMeasuredWidth(labelText);
  const textWidth = measuredWidth ?? graphNodeLabelFallbackWidth(labelText);
  return Math.ceil(textWidth + NODE_LABEL_PADDING_COMPENSATION);
}

/** Computes the compact node width required to contain its label and metadata affordances. */
export function graphNodeWidthForLabel(node = {}) {
  const labelText = String(node?.label || node?.id || "").trim();
  const rawLabelWidth = graphNodeLabelWidthEstimate(labelText);
  const hasRecordIcon = Boolean(recordStateIndicatorText(normalizeRecordStateToken(node?.recordStateText)));
  const chromeWidth = NODE_BASE_CHROME_WIDTH + (hasRecordIcon ? NODE_RECORD_CHROME_WIDTH : 0);
  const labelWidth = clampNumber(rawLabelWidth, NODE_LABEL_MIN_WIDTH, NODE_MAX_WIDTH - chromeWidth);
  return {
    width: clampNumber(chromeWidth + labelWidth, NODE_MIN_WIDTH, NODE_MAX_WIDTH),
    labelWidth: clampNumber(labelWidth, NODE_LABEL_MIN_WIDTH, NODE_LABEL_MAX_WIDTH),
  };
}

/** Maps overview or inspect presentation mode to capsule or card node geometry. */
function graphNodeShapeKindForPresentation(presentationMode) {
  return String(presentationMode || "").trim().toLowerCase() === GRAPH_NODE_PRESENTATION_EXTENDED
    ? GRAPH_NODE_SHAPE_CARD
    : GRAPH_NODE_SHAPE_CAPSULE;
}

/** Resolves explicit node shape before deriving it from the active presentation mode. */
function graphNodeShapeKindForNode(node = {}) {
  const shapeKind = String(node?.shapeKind || "").trim().toLowerCase();
  if (shapeKind === GRAPH_NODE_SHAPE_CARD || shapeKind === GRAPH_NODE_SHAPE_CAPSULE) return shapeKind;
  return graphNodeShapeKindForPresentation(node?.presentationMode);
}

/** Computes bounded capsule dimensions from label width and compact metadata indicators. */
function compactNodeDimensions(node = {}) {
  const dimensions = graphNodeWidthForLabel(node);
  const width = ceilToGraphGrid(dimensions.width, NODE_MIN_WIDTH, NODE_MAX_WIDTH);
  return {
    width,
    height: NODE_HEIGHT,
    labelWidth: clampNumber(
      dimensions.labelWidth,
      NODE_LABEL_MIN_WIDTH,
      Math.min(NODE_LABEL_MAX_WIDTH, width - NODE_BASE_CHROME_WIDTH),
    ),
  };
}

/** Computes card dimensions from label, detail lines, semantic evidence, and source metadata. */
function extendedNodeDimensions(node = {}) {
  const titleWidth = graphNodeLabelWidthEstimate(node?.label);
  const sourceWidth = graphNodeLabelWidthEstimate(node?.source);
  const width = ceilToGraphGrid(
    Math.max(NODE_EXTENDED_WIDTH, titleWidth + 42, sourceWidth + 32),
    NODE_EXTENDED_WIDTH,
    GRAPH_NODE_GRID_UNIT * 10,
  );
  return {
    width,
    height: NODE_EXTENDED_MIN_HEIGHT,
    labelWidth: width - 28,
  };
}

const GRAPH_NODE_SHAPE_DIMENSIONS = Object.freeze({
  [GRAPH_NODE_SHAPE_CAPSULE]: {
    defaultWidth: NODE_MIN_WIDTH,
    defaultHeight: NODE_HEIGHT,
    dimensions: compactNodeDimensions,
  },
  [GRAPH_NODE_SHAPE_CARD]: {
    defaultWidth: NODE_EXTENDED_WIDTH,
    defaultHeight: NODE_EXTENDED_MIN_HEIGHT,
    dimensions: extendedNodeDimensions,
  },
});

/** Selects capsule or card dimensions from the node's resolved presentation shape. */
function graphNodeShapeDimensions(node = {}) {
  return GRAPH_NODE_SHAPE_DIMENSIONS[graphNodeShapeKindForNode(node)]
    || GRAPH_NODE_SHAPE_DIMENSIONS[GRAPH_NODE_SHAPE_CAPSULE];
}

/** Computes node dimensions after applying an explicit presentation-mode override. */
export function graphNodeDimensionsForPresentation(node = {}, presentationMode) {
  const shapeKind = graphNodeShapeKindForPresentation(presentationMode);
  return {
    shapeKind,
    ...GRAPH_NODE_SHAPE_DIMENSIONS[shapeKind].dimensions(node),
  };
}

/** Returns explicit finite width or derives the active node shape width. */
export function graphNodeWidth(node = {}) {
  const dimensions = graphNodeShapeDimensions(node);
  return Math.max(1, Number(node?.width) || dimensions.defaultWidth);
}

/** Returns explicit finite height or derives the active node shape height. */
export function graphNodeHeight(node = {}) {
  const dimensions = graphNodeShapeDimensions(node);
  return Math.max(1, Number(node?.height) || dimensions.defaultHeight);
}

/** Derives a marker's control, timing, binding, or relationship role from edge semantics. */
function graphConnectionRole(edge = {}) {
  return normalizeKind(edge?.kind) === "control" ? "control" : "timing";
}

/** Maps connection roles to their deterministic marker stacking priority. */
function graphConnectionRoleOrder(role) {
  return role === "timing" ? 0 : 1;
}

/** Orders markers by connection role, angle, peer identity, and stable edge identity. */
function compareGraphConnectionMarkers(left, right) {
  const legacyOrder = graphConnectionRoleOrder(left.role) - graphConnectionRoleOrder(right.role)
    || compareIds(left.connectedId, right.connectedId)
    || String(left.edgeId || "").localeCompare(String(right.edgeId || ""));
  if (left?.legacySideRouting === true && right?.legacySideRouting === true) return legacyOrder;
  return Number(left.angleDeg || 0) - Number(right.angleDeg || 0)
    || legacyOrder;
}

/** Resolves whether a connection marker depicts inbound or outbound flow at one endpoint. */
function graphVisualMarkerDirection(edge = {}, endpointRole = "source") {
  const visualFlowDirection = String(edge?.visualFlowDirection || "").trim().toLowerCase();
  if (visualFlowDirection === "left") {
    return endpointRole === "source" ? "inbound" : "outbound";
  }
  return endpointRole === "source" ? "outbound" : "inbound";
}

/** Normalizes explicit port-side metadata to the four supported rectangular sides. */
function normalizeGraphPortSide(side, fallback = GRAPH_PORT_RIGHT) {
  const normalized = String(side || "").trim().toLowerCase();
  return [GRAPH_PORT_LEFT, GRAPH_PORT_RIGHT, GRAPH_PORT_TOP, GRAPH_PORT_BOTTOM].includes(normalized)
    ? normalized
    : fallback;
}

/** Maps an arbitrary connection angle to its closest rectangular marker side. */
function graphSideForAngleDeg(angleDeg) {
  const angle = ((Number(angleDeg) % 360) + 360) % 360;
  if (angle >= 45 && angle < 135) return GRAPH_PORT_BOTTOM;
  if (angle >= 135 && angle < 225) return GRAPH_PORT_LEFT;
  if (angle >= 225 && angle < 315) return GRAPH_PORT_TOP;
  return GRAPH_PORT_RIGHT;
}

/** Resolves endpoint flow vector from explicit directional metadata when available. */
function graphVectorForFlowDirection(edge = {}, endpointRole = "source") {
  const visualFlowDirection = String(edge?.visualFlowDirection || "").trim().toLowerCase();
  let sourceVector = { x: 1, y: 0 };
  if (visualFlowDirection === "left") {
    sourceVector = { x: -1, y: 0 };
  } else if (visualFlowDirection === "up") {
    sourceVector = { x: 0, y: -1 };
  } else if (visualFlowDirection === "down") {
    sourceVector = { x: 0, y: 1 };
  } else if (Number.isFinite(Number(edge?.angleDeg))) {
    sourceVector = graphVectorFromAngleDeg(edge.angleDeg);
  }
  return endpointRole === "source"
    ? normalizeVector(sourceVector)
    : normalizeVector({ x: -sourceVector.x, y: -sourceVector.y });
}

/** Checks whether an edge supplies a usable source or target flow vector. */
function graphEdgeHasExplicitFlowVector(edge = {}) {
  const visualFlowDirection = String(edge?.visualFlowDirection || "").trim().toLowerCase();
  return ["left", "right", "up", "down"].includes(visualFlowDirection)
    || Number.isFinite(Number(edge?.angleDeg));
}

/** Checks whether an edge keeps provider-authored straight-line direction authority. */
function graphEdgeUsesOriginalLineGeometry(edge = {}) {
  const visualFlowDirection = String(edge?.visualFlowDirection || "").trim().toLowerCase();
  return visualFlowDirection === "left"
    || visualFlowDirection === "right";
}

/** Computes the world-space center of a node's active shape dimensions. */
function graphNodeCenter(node = {}) {
  return {
    x: Number(node?.x || 0) + graphNodeWidth(node) / 2,
    y: Number(node?.y || 0) + graphNodeHeight(node) / 2,
  };
}

/** Derives the outward endpoint direction from flow metadata or connected-node geometry. */
function graphEndpointVector(node = {}, connectedNode = null, edge = {}, endpointRole = "source") {
  if (graphEdgeHasExplicitFlowVector(edge)) {
    return graphVectorForFlowDirection(edge, endpointRole);
  }
  if (connectedNode) {
    const nodeCenter = graphNodeCenter(node);
    const connectedCenter = graphNodeCenter(connectedNode);
    const vector = {
      x: connectedCenter.x - nodeCenter.x,
      y: connectedCenter.y - nodeCenter.y,
    };
    return normalizeVector(vector, graphVectorForFlowDirection(edge, endpointRole));
  }
  return graphVectorForFlowDirection(edge, endpointRole);
}

/** Maps a normalized rectangular port side to its outward unit vector. */
function graphVectorForPortSide(side) {
  const normalized = normalizeGraphPortSide(side);
  if (normalized === GRAPH_PORT_LEFT) return { x: -1, y: 0 };
  if (normalized === GRAPH_PORT_TOP) return { x: 0, y: -1 };
  if (normalized === GRAPH_PORT_BOTTOM) return { x: 0, y: 1 };
  return { x: 1, y: 0 };
}

/** Returns the two neighboring sides considered when the ideal marker side is crowded. */
function graphAdjacentPortSides(side) {
  const normalized = normalizeGraphPortSide(side);
  if (normalized === GRAPH_PORT_TOP) return [GRAPH_PORT_TOP, GRAPH_PORT_RIGHT, GRAPH_PORT_LEFT, GRAPH_PORT_BOTTOM];
  if (normalized === GRAPH_PORT_BOTTOM) return [GRAPH_PORT_BOTTOM, GRAPH_PORT_RIGHT, GRAPH_PORT_LEFT, GRAPH_PORT_TOP];
  if (normalized === GRAPH_PORT_LEFT) return [GRAPH_PORT_LEFT, GRAPH_PORT_TOP, GRAPH_PORT_BOTTOM, GRAPH_PORT_RIGHT];
  return [GRAPH_PORT_RIGHT, GRAPH_PORT_TOP, GRAPH_PORT_BOTTOM, GRAPH_PORT_LEFT];
}

/** Checks whether a geometry point lies inside an axis-aligned node rectangle. */
function graphPointInRect(point = {}, rect = {}) {
  return point.x >= rect.left
    && point.x <= rect.right
    && point.y >= rect.top
    && point.y <= rect.bottom;
}

/** Computes clockwise, counterclockwise, or collinear orientation for marker collision geometry. */
function graphSegmentOrientation(a, b, c) {
  const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (Math.abs(value) < 0.001) return 0;
  return value > 0 ? 1 : 2;
}

/** Checks whether a collinear marker point lies on an inclusive connection segment. */
function graphPointOnSegment(a, b, c) {
  return b.x <= Math.max(a.x, c.x) + 0.001
    && b.x >= Math.min(a.x, c.x) - 0.001
    && b.y <= Math.max(a.y, c.y) + 0.001
    && b.y >= Math.min(a.y, c.y) - 0.001;
}

/** Checks general and collinear intersection between two connection line segments. */
function graphSegmentsIntersect(a, b, c, d) {
  const o1 = graphSegmentOrientation(a, b, c);
  const o2 = graphSegmentOrientation(a, b, d);
  const o3 = graphSegmentOrientation(c, d, a);
  const o4 = graphSegmentOrientation(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && graphPointOnSegment(a, c, b))
    || (o2 === 0 && graphPointOnSegment(a, d, b))
    || (o3 === 0 && graphPointOnSegment(c, a, d))
    || (o4 === 0 && graphPointOnSegment(c, b, d));
}

/** Checks whether a proposed marker ray crosses a node obstacle rectangle. */
function graphSegmentIntersectsRect(start = {}, end = {}, rect = {}) {
  if (graphPointInRect(start, rect) || graphPointInRect(end, rect)) return true;
  const minX = Math.min(start.x, end.x);
  const maxX = Math.max(start.x, end.x);
  const minY = Math.min(start.y, end.y);
  const maxY = Math.max(start.y, end.y);
  if (maxX < rect.left || minX > rect.right || maxY < rect.top || minY > rect.bottom) return false;
  return [
    [{ x: rect.left, y: rect.top }, { x: rect.right, y: rect.top }],
    [{ x: rect.right, y: rect.top }, { x: rect.right, y: rect.bottom }],
    [{ x: rect.right, y: rect.bottom }, { x: rect.left, y: rect.bottom }],
    [{ x: rect.left, y: rect.bottom }, { x: rect.left, y: rect.top }],
  ].some(([edgeStart, edgeEnd]) => graphSegmentsIntersect(start, end, edgeStart, edgeEnd));
}

/** Counts other node obstacles crossed by a connection ray leaving one candidate side. */
function graphMarkerSideCollisionCount(node, connectedNode, side, nodeById = new Map()) {
  if (!connectedNode) return 0;
  const localPoint = graphNodeMarkerLocalPoint(node, { side }, 0, 1);
  const start = {
    x: Number(node.x || 0) + localPoint.localX,
    y: Number(node.y || 0) + localPoint.localY,
  };
  const end = graphNodeCenter(connectedNode);
  let collisions = 0;
  for (const candidate of nodeById.values()) {
    if (!candidate || candidate.id === node.id || candidate.id === connectedNode.id) continue;
    if (graphSegmentIntersectsRect(start, end, graphNodeRect(candidate))) collisions += 1;
  }
  return collisions;
}

/** Selects the least-obstructed endpoint vector while respecting explicit flow direction first. */
function graphBestConnectionVector(node, connectedNode, edge, endpointRole, nodeById = new Map()) {
  const naturalVector = graphEndpointVector(node, connectedNode, edge, endpointRole);
  if (graphEdgeHasExplicitFlowVector(edge) || !connectedNode) return naturalVector;
  const naturalSide = graphSideForAngleDeg(graphAngleDegFromVector(naturalVector));
  let selected = {
    side: naturalSide,
    vector: naturalVector,
    score: Infinity,
  };
  for (const side of graphAdjacentPortSides(naturalSide)) {
    const sideVector = graphVectorForPortSide(side);
    const alignmentPenalty = (1 - graphVectorDot(naturalVector, sideVector)) * 18;
    const collisionPenalty = graphMarkerSideCollisionCount(node, connectedNode, side, nodeById) * 15;
    const score = collisionPenalty + alignmentPenalty + graphMarkerSideOrder(side) * 0.01;
    if (score < selected.score) {
      selected = { side, vector: sideVector, score };
    }
  }
  return selected.vector;
}

/** Builds one endpoint marker record with role, direction, peer, angle, side, and collision evidence. */
function graphConnectionMarkerForEdge(node, edge, endpointRole, connectedNode = null, nodeById = new Map()) {
  const edgeId = String(edge?.id || "").trim();
  if (!node?.id || !edgeId) return null;
  const surfaceAngle = endpointRole === "source"
    ? Number(edge?.sourceSurfaceAngleDeg)
    : Number(edge?.targetSurfaceAngleDeg);
  const vector = Number.isFinite(surfaceAngle)
    ? graphVectorFromAngleDeg(surfaceAngle)
    : graphBestConnectionVector(node, connectedNode, edge, endpointRole, nodeById);
  const direction = graphEdgeHasExplicitFlowVector(edge)
    ? graphVisualMarkerDirection(edge, endpointRole)
    : endpointRole === "source" ? "outbound" : "inbound";
  const angleDeg = graphAngleDegFromVector(vector);
  const side = graphSideForAngleDeg(angleDeg);
  const visualFlowDirection = String(edge?.visualFlowDirection || "").trim().toLowerCase();
  const role = graphConnectionRole(edge);
  const kind = normalizeKind(edge?.kind) || role;
  const connectedId = endpointRole === "source"
    ? normalizeId(edge?.routeTo || edge?.to)
    : normalizeId(edge?.routeFrom || edge?.from);
  return {
    id: `${node.id}:${endpointRole}:${Math.round(angleDeg)}:${direction}:${role}:${edgeId}`,
    edgeId,
    endpointRole,
    direction,
    side,
    angleDeg,
    vector,
    legacySideRouting: graphEdgeUsesOriginalLineGeometry(edge),
    role,
    kind,
    connectedId,
    activeChain: edge?.activeChain === true,
    transportStateText: normalizeTransportToken(edge?.transportStateText),
    surfaceLocalX: endpointRole === "source" ? edge?.sourceSurfaceLocalX : edge?.targetSurfaceLocalX,
    surfaceLocalY: endpointRole === "source" ? edge?.sourceSurfaceLocalY : edge?.targetSurfaceLocalY,
  };
}

/** Computes capsule boundary X at one local Y for a horizontal outward direction. */
function graphCapsuleBoundaryX(node, direction, localY) {
  const width = graphNodeWidth(node);
  const height = graphNodeHeight(node);
  const radius = height / 2;
  const centerY = radius;
  const clampedY = clampNumber(Number(localY) || centerY, NODE_CONNECTOR_EDGE_INSET, height - NODE_CONNECTOR_EDGE_INSET);
  const deltaY = Math.abs(clampedY - centerY);
  const capInset = radius - Math.sqrt(Math.max(0, radius * radius - deltaY * deltaY));
  if (direction === "inbound") return capInset + NODE_CONNECTOR_INBOUND_BORDER_INSET;
  return width - capInset - NODE_CONNECTOR_OUTBOUND_BORDER_INSET;
}

/** Selects the connector inset needed to keep marker symbols visually inside node shapes. */
function graphConnectorInsetForDirection(direction) {
  return direction === "inbound"
    ? NODE_CONNECTOR_INBOUND_BORDER_INSET
    : NODE_CONNECTOR_OUTBOUND_BORDER_INSET;
}

/** Computes the perpendicular tangent used to separate markers sharing a boundary region. */
function graphTangentForVector(vector = {}) {
  const normalized = normalizeVector(vector);
  return { x: -normalized.y, y: normalized.x };
}

/** Clamps a local marker point to the active node shape's rectangular extent. */
function graphClampLocalPoint(node, point = {}) {
  return {
    localX: clampNumber(Number(point.localX) || 0, 0, graphNodeWidth(node)),
    localY: clampNumber(Number(point.localY) || 0, 0, graphNodeHeight(node)),
  };
}

/** Moves a shape-boundary point inward and sideways for visually separated marker placement. */
function graphOffsetBoundaryPoint(node, point, vector, inset, tangentOffset = 0) {
  const normalized = normalizeVector(vector);
  const tangent = graphTangentForVector(normalized);
  return graphClampLocalPoint(node, {
    localX: point.localX - normalized.x * inset + tangent.x * tangentOffset,
    localY: point.localY - normalized.y * inset + tangent.y * tangentOffset,
  });
}

/** Finds the ray intersection with a capsule boundary across straight and rounded regions. */
function graphCapsuleBoundaryPoint(node, vector = {}) {
  const width = graphNodeWidth(node);
  const height = graphNodeHeight(node);
  const radius = height / 2;
  const halfWidth = width / 2;
  const center = { x: halfWidth, y: radius };
  const normalized = normalizeVector(vector);
  const bodyHalfWidth = Math.max(0, halfWidth - radius);
  const candidates = [];

  if (Math.abs(normalized.y) > 0.0001) {
    const localY = normalized.y < 0 ? 0 : height;
    const t = (localY - center.y) / normalized.y;
    const localX = center.x + normalized.x * t;
    if (t > 0 && localX >= center.x - bodyHalfWidth && localX <= center.x + bodyHalfWidth) {
      candidates.push({ t, localX, localY });
    }
  }

  const capCenterX = center.x + (normalized.x < 0 ? -bodyHalfWidth : bodyHalfWidth);
  const capCenter = { x: capCenterX, y: center.y };
  const originToCap = {
    x: capCenter.x - center.x,
    y: capCenter.y - center.y,
  };
  const projection = normalized.x * originToCap.x + normalized.y * originToCap.y;
  const discriminant = projection * projection
    - (originToCap.x * originToCap.x + originToCap.y * originToCap.y - radius * radius);
  if (discriminant >= 0) {
    const t = projection + Math.sqrt(discriminant);
    if (t > 0) {
      candidates.push({
        t,
        localX: center.x + normalized.x * t,
        localY: center.y + normalized.y * t,
      });
    }
  }

  const selected = candidates
    .filter((candidate) => Number.isFinite(candidate.t))
    .sort((left, right) => left.t - right.t)[0] || {
      localX: normalized.x < 0 ? 0 : width,
      localY: center.y,
    };
  return graphClampLocalPoint(node, selected);
}

/** Finds the ray intersection with a rectangular card boundary from its center. */
function graphCardBoundaryPoint(node, vector = {}) {
  const width = graphNodeWidth(node);
  const height = graphNodeHeight(node);
  const normalized = normalizeVector(vector);
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const tx = Math.abs(normalized.x) > 0.0001 ? halfWidth / Math.abs(normalized.x) : Infinity;
  const ty = Math.abs(normalized.y) > 0.0001 ? halfHeight / Math.abs(normalized.y) : Infinity;
  const t = Math.min(tx, ty);
  return graphClampLocalPoint(node, {
    localX: halfWidth + normalized.x * t,
    localY: halfHeight + normalized.y * t,
  });
}

const GRAPH_NODE_SHAPE_ANCHORS = Object.freeze({
  [GRAPH_NODE_SHAPE_CAPSULE]: {
    boundaryX: graphCapsuleBoundaryX,
    /** Computes a capsule-local connector anchor with inset and tangent slot separation. */
    anchorLocalPoint(node, vector, options = {}) {
      return graphOffsetBoundaryPoint(
        node,
        graphCapsuleBoundaryPoint(node, vector),
        vector,
        graphConnectorInsetForDirection(options.direction),
        Number(options.tangentOffset) || 0,
      );
    },
  },
  [GRAPH_NODE_SHAPE_CARD]: {
    /** Returns the card's left or right local boundary for a horizontal direction. */
    boundaryX(node, direction) {
      const width = graphNodeWidth(node);
      return direction === "inbound"
        ? NODE_EXTENDED_CONNECTOR_EDGE_INSET
        : width - NODE_EXTENDED_CONNECTOR_EDGE_INSET;
    },
    /** Computes a card-local connector anchor with inset and tangent slot separation. */
    anchorLocalPoint(node, vector, options = {}) {
      return graphOffsetBoundaryPoint(
        node,
        graphCardBoundaryPoint(node, vector),
        vector,
        NODE_EXTENDED_CONNECTOR_EDGE_INSET,
        Number(options.tangentOffset) || 0,
      );
    },
  },
});

/** Selects the capsule or card boundary adapter for one rendered node. */
function graphNodeShapeAnchorAdapter(node = {}) {
  return GRAPH_NODE_SHAPE_ANCHORS[graphNodeShapeKindForNode(node)]
    || GRAPH_NODE_SHAPE_ANCHORS[GRAPH_NODE_SHAPE_CAPSULE];
}

/** Delegates horizontal boundary lookup to the active node shape adapter. */
function graphNodeBoundaryX(node, direction, localY) {
  return graphNodeShapeAnchorAdapter(node).boundaryX(node, direction, localY);
}

/** Distributes multiple legacy side markers vertically within safe node padding. */
function graphNodeMarkerLocalY(node, index, count) {
  const height = graphNodeHeight(node);
  const minY = Math.min(height / 2, NODE_CONNECTOR_EDGE_INSET + 4);
  const maxY = Math.max(minY, height - minY);
  if (count <= 1) return height / 2;
  return minY + (maxY - minY) * ((index + 1) / (count + 1));
}

/** Maps marker slot order to a centered safe ratio along one node side. */
function graphNodeSideSlotRatio(index = 0, count = 1) {
  return count <= 1 ? 0.5 : (index + 1) / (count + 1);
}

/** Computes an evenly spaced safe marker point on one capsule side. */
function graphCapsuleSideSlotLocalPoint(node, side, index = 0, count = 1) {
  const width = graphNodeWidth(node);
  const height = graphNodeHeight(node);
  const radius = height / 2;
  const ratio = graphNodeSideSlotRatio(index, count);
  if (side === GRAPH_PORT_TOP || side === GRAPH_PORT_BOTTOM) {
    const minX = Math.min(width / 2, radius + 8);
    const maxX = Math.max(minX, width - minX);
    return {
      localX: minX + (maxX - minX) * ratio,
      localY: side === GRAPH_PORT_TOP
        ? NODE_CONNECTOR_EDGE_INSET
        : height - NODE_CONNECTOR_EDGE_INSET,
    };
  }
  const localY = graphNodeMarkerLocalY(node, index, count);
  const centerY = height / 2;
  const deltaY = Math.abs(localY - centerY);
  const capInset = radius - Math.sqrt(Math.max(0, radius * radius - deltaY * deltaY));
  return {
    localX: side === GRAPH_PORT_LEFT
      ? capInset + NODE_CONNECTOR_INBOUND_BORDER_INSET
      : width - capInset - NODE_CONNECTOR_OUTBOUND_BORDER_INSET,
    localY,
  };
}

/** Computes an evenly spaced safe marker point on one rectangular card side. */
function graphCardSideSlotLocalPoint(node, side, index = 0, count = 1) {
  const width = graphNodeWidth(node);
  const height = graphNodeHeight(node);
  const ratio = graphNodeSideSlotRatio(index, count);
  if (side === GRAPH_PORT_TOP || side === GRAPH_PORT_BOTTOM) {
    const minX = Math.min(width / 2, 14);
    const maxX = Math.max(minX, width - minX);
    return {
      localX: minX + (maxX - minX) * ratio,
      localY: side === GRAPH_PORT_TOP
        ? NODE_EXTENDED_CONNECTOR_EDGE_INSET
        : height - NODE_EXTENDED_CONNECTOR_EDGE_INSET,
    };
  }
  const minY = Math.min(height / 2, 14);
  const maxY = Math.max(minY, height - minY);
  return {
    localX: side === GRAPH_PORT_LEFT
      ? NODE_EXTENDED_CONNECTOR_EDGE_INSET
      : width - NODE_EXTENDED_CONNECTOR_EDGE_INSET,
    localY: minY + (maxY - minY) * ratio,
  };
}

/** Selects capsule or card side-slot geometry for one ordered connection marker. */
function graphNodeMarkerLocalPoint(node, marker, sideIndex = 0, sideCount = 1) {
  if (Number.isFinite(Number(marker?.surfaceLocalX)) && Number.isFinite(Number(marker?.surfaceLocalY))) {
    return graphClampLocalPoint(node, {
      localX: Number(marker.surfaceLocalX),
      localY: Number(marker.surfaceLocalY),
    });
  }
  const side = normalizeGraphPortSide(marker?.side, graphSideForAngleDeg(marker?.angleDeg || 0));
  if (graphNodeShapeKindForNode(node) === GRAPH_NODE_SHAPE_CARD) {
    return graphCardSideSlotLocalPoint(node, side, sideIndex, sideCount);
  }
  return graphCapsuleSideSlotLocalPoint(node, side, sideIndex, sideCount);
}

/** Converts a node-local marker position to world coordinates with outward port direction. */
function graphNodePortAnchor(node = {}, vector = { x: 1, y: 0 }, localPoint = {}) {
  const normalizedVector = normalizeVector(vector);
  const fallbackPoint = graphNodeShapeAnchorAdapter(node).anchorLocalPoint(node, normalizedVector, {
    direction: "outbound",
  });
  const localX = Number.isFinite(Number(localPoint?.localX))
    ? clampNumber(Number(localPoint.localX), 0, graphNodeWidth(node))
    : fallbackPoint.localX;
  const localY = Number.isFinite(Number(localPoint?.localY))
    ? clampNumber(Number(localPoint.localY), 0, graphNodeHeight(node))
    : fallbackPoint.localY;
  const angleDeg = graphAngleDegFromVector(normalizedVector);
  return {
    x: Number(node?.x || 0) + localX,
    y: Number(node?.y || 0) + localY,
    side: graphSideForAngleDeg(angleDeg),
    angleDeg,
    vector: normalizedVector,
  };
}

/** Returns the public shape adapter exposing dimensions, anchors, and port coordinates. */
export function graphNodeShapeAdapterForNode(node = {}) {
  const dimensions = graphNodeShapeDimensions(node);
  const anchors = graphNodeShapeAnchorAdapter(node);
  const resolvedDimensions = dimensions.dimensions(node);
  return {
    shapeKind: graphNodeShapeKindForNode(node),
    dimensions: resolvedDimensions,
    measure: dimensions.dimensions,
    defaultWidth: dimensions.defaultWidth,
    defaultHeight: dimensions.defaultHeight,
    width: () => graphNodeWidth(node),
    height: () => graphNodeHeight(node),
    markerLocalY: (index, count) => graphNodeMarkerLocalY(node, index, count),
    markerLocalPoint: (vector, options = {}) => anchors.anchorLocalPoint(node, vector, options),
    boundaryX: (direction, localY) => anchors.boundaryX(node, direction, localY),
    portAnchor: (vector, localPoint = {}) => graphNodePortAnchor(node, vector, localPoint),
  };
}

/** Buckets marker angles so near-identical endpoint directions share a placement group. */
function graphMarkerAngleGroupKey(marker = {}) {
  return String(Math.round(Number(marker.angleDeg || 0) / 16));
}

/** Maps marker side to deterministic clockwise placement ordering. */
function graphMarkerSideOrder(side) {
  if (side === GRAPH_PORT_TOP) return 0;
  if (side === GRAPH_PORT_RIGHT) return 1;
  if (side === GRAPH_PORT_BOTTOM) return 2;
  if (side === GRAPH_PORT_LEFT) return 3;
  return 4;
}

/** Computes peer-relative ordering along the marker side's varying coordinate axis. */
function graphConnectionSlotAxisValue(marker = {}, nodeById = new Map()) {
  const connectedNode = nodeById.get(marker.connectedId);
  if (!connectedNode) return Number(marker.angleDeg || 0);
  const center = graphNodeCenter(connectedNode);
  const side = normalizeGraphPortSide(marker.side, graphSideForAngleDeg(marker.angleDeg || 0));
  return side === GRAPH_PORT_TOP || side === GRAPH_PORT_BOTTOM
    ? center.x
    : center.y;
}

/** Orders same-side markers by peer geometry, role priority, angle, and edge identity. */
function compareGraphConnectionSlotMarkers(left, right, nodeById = new Map()) {
  const leftSide = normalizeGraphPortSide(left.side, graphSideForAngleDeg(left.angleDeg || 0));
  const rightSide = normalizeGraphPortSide(right.side, graphSideForAngleDeg(right.angleDeg || 0));
  const sideDelta = graphMarkerSideOrder(leftSide) - graphMarkerSideOrder(rightSide);
  if (sideDelta !== 0) return sideDelta;
  const axisDelta = graphConnectionSlotAxisValue(left, nodeById) - graphConnectionSlotAxisValue(right, nodeById);
  if (Math.abs(axisDelta) > 0.001) return axisDelta;
  return graphConnectionRoleOrder(left.role) - graphConnectionRoleOrder(right.role)
    || compareIds(left.connectedId, right.connectedId)
    || String(left.edgeId || "").localeCompare(String(right.edgeId || ""));
}

/** Builds, groups, slots, and anchors every connection marker belonging to one node. */
function graphConnectionMarkersForNode(node, edges = [], nodeById = new Map()) {
  const markers = [];
  for (const edge of Array.isArray(edges) ? edges : []) {
    const logicalFrom = normalizeId(edge?.from);
    const logicalTo = normalizeId(edge?.to);
    const routeFrom = normalizeId(edge?.routeFrom || edge?.from);
    const routeTo = normalizeId(edge?.routeTo || edge?.to);
    if (logicalFrom === node.id && routeFrom === node.id) {
      const marker = graphConnectionMarkerForEdge(
        node,
        edge,
        "source",
        nodeById.get(routeTo) || nodeById.get(logicalTo) || null,
        nodeById,
      );
      if (marker) markers.push(marker);
    }
    if (logicalTo === node.id && routeTo === node.id) {
      const marker = graphConnectionMarkerForEdge(
        node,
        edge,
        "target",
        nodeById.get(routeFrom) || nodeById.get(logicalFrom) || null,
        nodeById,
      );
      if (marker) markers.push(marker);
    }
    if (routeFrom === node.id && logicalFrom !== node.id) {
      const marker = graphConnectionMarkerForEdge(
        node,
        edge,
        "source",
        nodeById.get(routeTo) || nodeById.get(logicalTo) || null,
        nodeById,
      );
      if (marker) markers.push(marker);
    }
    if (routeTo === node.id && logicalTo !== node.id) {
      const marker = graphConnectionMarkerForEdge(
        node,
        edge,
        "target",
        nodeById.get(routeFrom) || nodeById.get(logicalFrom) || null,
        nodeById,
      );
      if (marker) markers.push(marker);
    }
  }

  const sortedMarkers = markers.sort((left, right) => compareGraphConnectionSlotMarkers(left, right, nodeById));
  const sideGroups = new Map();
  sortedMarkers.forEach((marker) => {
    const side = normalizeGraphPortSide(marker.side, graphSideForAngleDeg(marker.angleDeg || 0));
    if (!sideGroups.has(side)) sideGroups.set(side, []);
    sideGroups.get(side).push(marker);
  });
  return sortedMarkers.map((marker, index) => {
    const side = normalizeGraphPortSide(marker.side, graphSideForAngleDeg(marker.angleDeg || 0));
    const sideGroup = sideGroups.get(side) || [marker];
    const sideIndex = sideGroup.indexOf(marker);
    const markerWithOffset = { ...marker, side, sideIndex, sideCount: sideGroup.length };
    const { localX, localY } = graphNodeMarkerLocalPoint(
      node,
      markerWithOffset,
      sideIndex,
      sideGroup.length,
    );
    return {
      ...markerWithOffset,
      index,
      count: sortedMarkers.length,
      localX,
      localY,
      x: node.x + localX,
      y: node.y + localY,
    };
  });
}

/** Applies node connection markers and propagates their computed anchors back to routed edges. */
export function applyGraphConnectionMarkers(nodes = [], edges = []) {
  const markerByEdgeEndpoint = new Map();
  const sourceEdges = Array.isArray(edges) ? edges : [];
  const nodeById = new Map((Array.isArray(nodes) ? nodes : []).map((node) => [normalizeId(node?.id), node]));
  const markedNodes = (Array.isArray(nodes) ? nodes : []).map((node) => {
    const connectionMarkers = graphConnectionMarkersForNode(node, sourceEdges, nodeById);
    connectionMarkers.forEach((marker) => {
      markerByEdgeEndpoint.set(`${marker.edgeId}:${marker.endpointRole}`, marker);
    });
    return {
      ...node,
      emitsTiming: connectionMarkers.some((marker) =>
        marker.direction === "outbound" && marker.role === "timing"
      ),
      connectionMarkers,
    };
  });
  const markedEdges = sourceEdges.map((edge) => ({
    ...edge,
    sourceMarker: markerByEdgeEndpoint.get(`${edge.id}:source`) || null,
    targetMarker: markerByEdgeEndpoint.get(`${edge.id}:target`) || null,
  }));
  return { nodes: markedNodes, edges: markedEdges };
}

/** Checks strict area overlap between two axis-aligned Graph rectangles. */
export function graphRectIntersects(left, right) {
  return left.left < right.right
    && left.right > right.left
    && left.top < right.bottom
    && left.bottom > right.top;
}

/** Estimates relationship label width and height from visible text and icon presence. */
function graphEdgeLabelSize(edge = {}) {
  const kind = normalizeKind(edge?.kind);
  if (kind === "tempo" || kind === "timing") {
    return { width: 42, height: 14 };
  }
  if (kind === "control") {
    return { width: 36, height: 14 };
  }
  return { width: EDGE_LABEL_WIDTH, height: EDGE_LABEL_HEIGHT };
}

/** Builds the centered collision rectangle for one visible edge label. */
function graphEdgeLabelRect(labelX, labelY, edge = {}) {
  const size = graphEdgeLabelSize(edge);
  return {
    left: labelX - size.width / 2,
    top: labelY - size.height / 2,
    right: labelX + size.width / 2,
    bottom: labelY + size.height / 2,
  };
}

/** Builds the world-space rectangle occupied by one node's active dimensions. */
export function graphNodeRect(node) {
  const repeatTopAllowance = String(node?.repeatLabel || "").trim() ? 24 : 4;
  return {
    left: node.x - 4,
    top: node.y - repeatTopAllowance,
    right: node.x + graphNodeWidth(node) + 4,
    bottom: node.y + graphNodeHeight(node) + 4,
  };
}

/** Resolves the readable relationship label from explicit label or edge kind. */
export function edgeDisplayLabel(edge = {}) {
  return String(edge?.label || "").trim();
}

/** Checks whether an edge should render a label outside compact terminal geometry. */
export function edgeLabelVisible(edge = {}) {
  return edgeDisplayLabel(edge) !== "" && edge?.labelHidden !== true;
}

/** Builds the grouping key used to stagger labels sharing one endpoint pair. */
function edgeLabelCompressionKey(edge = {}) {
  const kind = normalizeKind(edge?.kind);
  const label = edgeDisplayLabel(edge);
  if (kind !== "timing" || !label) return "";
  return `${kind}:${label}`;
}

/** Checks whether a label is too close to an already placed parallel-edge anchor. */
function edgeLabelIsNearCompressedAnchor(edge, anchors = []) {
  const key = edgeLabelCompressionKey(edge);
  if (!key) return false;
  const baseX = Number(edge?.labelX) || 0;
  const baseY = Number(edge?.labelY) || 0;
  return anchors.some((anchor) =>
    anchor.key === key
    && Math.abs(baseX - anchor.x) <= EDGE_LABEL_COMPRESSION_MAX_DX
    && Math.abs(baseY - anchor.y) <= EDGE_LABEL_COMPRESSION_MAX_DY
  );
}

/** Repositions visible edge labels to avoid nodes, prior labels, and compressed parallel anchors. */
export function resolveEdgeLabelCollisions(edges, nodes) {
  const nodeRects = (Array.isArray(nodes) ? nodes : []).map((node) => ({
    id: node?.id,
    rect: graphNodeRect(node),
  }));
  const placedRects = [];
  const compressedLabelAnchors = [];
  const candidateOffsets = [
    [0, 0],
    [0, -26],
    [0, 26],
    [42, 0],
    [-42, 0],
    [42, -26],
    [-42, -26],
    [42, 26],
    [-42, 26],
    [0, -52],
    [0, 52],
    [84, 0],
    [-84, 0],
  ];

  const sourceEdges = Array.isArray(edges) ? edges : [];
  const placedEdges = new Array(sourceEdges.length);
  /** Maps edge kind to deterministic label placement priority under collision pressure. */
  const labelPriority = (kind) => {
    if (kind === "control") return 0;
    if (kind === "timing") return 1;
    return 2;
  };
  const placementOrder = sourceEdges
    .map((edge, index) => ({ edge, index }))
    .sort((left, right) => (
      labelPriority(normalizeKind(left.edge?.kind)) - labelPriority(normalizeKind(right.edge?.kind))
      || String(left.edge?.id || "").localeCompare(String(right.edge?.id || ""))
    ));

  for (const { edge, index } of placementOrder) {
    if (!edgeLabelVisible(edge)) {
      placedEdges[index] = edge;
      continue;
    }
    const compressionKey = edgeLabelCompressionKey(edge);
    if (edgeLabelIsNearCompressedAnchor(edge, compressedLabelAnchors)) {
      placedEdges[index] = {
        ...edge,
        labelHidden: true,
        labelCompressionKey: compressionKey,
      };
      continue;
    }
    const baseX = Number(edge?.labelX) || 0;
    const baseY = Number(edge?.labelY) || 0;
    let selected = { x: baseX, y: baseY };
    for (const [offsetX, offsetY] of candidateOffsets) {
      const candidate = {
        x: Math.max(ORIGIN_X / 2, Math.round(baseX + offsetX)),
        y: Math.max(ORIGIN_Y / 2, Math.round(baseY + offsetY)),
      };
      const rect = graphEdgeLabelRect(candidate.x, candidate.y, edge);
      const hitsNode = nodeRects.some((nodeRect) => {
        if (edge?.terminal === true && nodeRect.id === edge.from) return false;
        return graphRectIntersects(rect, nodeRect.rect);
      });
      const hitsLabel = placedRects.some((labelRect) => graphRectIntersects(rect, labelRect));
      if (!hitsNode && !hitsLabel) {
        selected = candidate;
        placedRects.push(rect);
        placedEdges[index] = {
          ...edge,
          labelX: selected.x,
          labelY: selected.y,
        };
        if (compressionKey) {
          compressedLabelAnchors.push({
            key: compressionKey,
            x: selected.x,
            y: selected.y,
          });
        }
        break;
      }
    }
    if (!placedEdges[index]) {
      placedRects.push(graphEdgeLabelRect(selected.x, selected.y, edge));
      placedEdges[index] = edge;
      if (compressionKey) {
        compressedLabelAnchors.push({
          key: compressionKey,
          x: selected.x,
          y: selected.y,
        });
      }
    }
  }
  return placedEdges;
}

/** Builds the optional repeat-count badge rectangle for node-label collision checks. */
function graphNodeRepeatLabelRect(node) {
  const label = String(node?.repeatLabel || "").trim();
  if (!label) return null;
  const centerX = Number(node?.x || 0) + graphNodeWidth(node) / 2;
  const top = Number(node?.y || 0) - 20;
  return {
    left: centerX - 16,
    top,
    right: centerX + 16,
    bottom: top + 12,
  };
}

/** Hides or relocates repeat badges that collide with nodes or relationship labels. */
export function resolveNodeRepeatLabelCollisions(nodes, edges) {
  const placedRects = (Array.isArray(edges) ? edges : [])
    .filter(edgeLabelVisible)
    .map((edge) => graphEdgeLabelRect(Number(edge?.labelX) || 0, Number(edge?.labelY) || 0, edge));
  return (Array.isArray(nodes) ? nodes : []).map((node) => {
    const repeatRect = graphNodeRepeatLabelRect(node);
    if (!repeatRect) return node;
    const hasCollision = placedRects.some((rect) => graphRectIntersects(repeatRect, rect));
    if (hasCollision) {
      return {
        ...node,
        repeatLabelHidden: true,
      };
    }
    placedRects.push(repeatRect);
    return node;
  });
}

/** Normalizes an arbitrary geometry vector with a safe direction fallback. */
function normalizeVector(vector, fallback = { x: 1, y: 0 }) {
  const length = Math.hypot(vector?.x || 0, vector?.y || 0);
  if (length < 0.001) return fallback;
  return {
    x: vector.x / length,
    y: vector.y / length,
  };
}

/** Parses object or angle direction metadata into a normalized geometry vector. */
function graphDirectionVector(value, fallback = { x: 1, y: 0 }) {
  if (value && typeof value === "object") return normalizeVector(value, fallback);
  if (value === -1 || value === 1) return { x: value, y: 0 };
  return normalizeVector(fallback, { x: 1, y: 0 });
}

/** Computes the dot product used to compare route tangent alignment. */
function graphVectorDot(left, right) {
  return (left?.x || 0) * (right?.x || 0) + (left?.y || 0) * (right?.y || 0);
}

/** Builds a smooth cubic SVG route through points while respecting endpoint tangents. */
export function graphRouteThroughPoints(points, startVector, endVector) {
  const routePoints = points
    .map((point) => ({ x: Number(point?.x), y: Number(point?.y) }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (routePoints.length < 2) return "";
  const tangents = routePoints.map((point, index) => {
    if (index === 0) return graphDirectionVector(startVector, { x: 1, y: 0 });
    if (index === routePoints.length - 1) return graphDirectionVector(endVector, { x: 1, y: 0 });
    return normalizeVector(
      {
        x: routePoints[index + 1].x - routePoints[index - 1].x,
        y: routePoints[index + 1].y - routePoints[index - 1].y,
      },
      normalizeVector({
        x: routePoints[index].x - routePoints[index - 1].x,
        y: routePoints[index].y - routePoints[index - 1].y,
      }),
    );
  });
  const segments = [`M ${routePoints[0].x} ${routePoints[0].y}`];
  for (let index = 0; index < routePoints.length - 1; index += 1) {
    const start = routePoints[index];
    const end = routePoints[index + 1];
    const distance = Math.max(1, Math.hypot(end.x - start.x, end.y - start.y));
    const handle = Math.min(140, Math.max(34, distance * 0.34));
    const startTangent = tangents[index];
    const endTangent = tangents[index + 1];
    segments.push([
      "C",
      Math.round(start.x + startTangent.x * handle),
      Math.round(start.y + startTangent.y * handle),
      Math.round(end.x - endTangent.x * handle),
      Math.round(end.y - endTangent.y * handle),
      Math.round(end.x),
      Math.round(end.y),
    ].join(" "));
  }
  return segments.join(" ");
}

/** Evaluates one cubic Bézier segment at normalized parameter t. */
function graphCubicPoint(start, controlA, controlB, end, t) {
  const inverse = 1 - t;
  return {
    x: inverse ** 3 * start.x
      + 3 * inverse ** 2 * t * controlA.x
      + 3 * inverse * t ** 2 * controlB.x
      + t ** 3 * end.x,
    y: inverse ** 3 * start.y
      + 3 * inverse ** 2 * t * controlA.y
      + 3 * inverse * t ** 2 * controlB.y
      + t ** 3 * end.y,
  };
}

/** Samples move, line, and cubic SVG path commands into inspectable world-space points. */
export function sampledGraphPathPoints(pathValue) {
  const tokens = String(pathValue || "").match(/[MCL]|-?\d+(?:\.\d+)?/g) || [];
  const points = [];
  let index = 0;
  let cursor = null;
  /** Reads the next finite coordinate pair from the tokenized SVG path stream. */
  const readPoint = () => {
    const x = Number.parseFloat(tokens[index]);
    const y = Number.parseFloat(tokens[index + 1]);
    index += 2;
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  };
  while (index < tokens.length) {
    const command = tokens[index];
    index += 1;
    if (command === "M") {
      cursor = readPoint();
      if (cursor) points.push(cursor);
      continue;
    }
    if (command === "L" && cursor) {
      const end = readPoint();
      if (!end) continue;
      for (let step = 1; step <= 32; step += 1) {
        const t = step / 32;
        points.push({
          x: cursor.x + (end.x - cursor.x) * t,
          y: cursor.y + (end.y - cursor.y) * t,
        });
      }
      cursor = end;
      continue;
    }
    if (command === "C" && cursor) {
      const controlA = readPoint();
      const controlB = readPoint();
      const end = readPoint();
      if (!controlA || !controlB || !end) continue;
      for (let step = 1; step <= 48; step += 1) {
        points.push(graphCubicPoint(cursor, controlA, controlB, end, step / 48));
      }
      cursor = end;
    }
  }
  return points;
}

/** Computes the axis-aligned bounds of a sampled Graph SVG path. */
export function graphPathBounds(pathValue) {
  const values = String(pathValue || "").match(/-?\d+(?:\.\d+)?/g) || [];
  const points = [];
  for (let index = 0; index < values.length - 1; index += 2) {
    const x = Number.parseFloat(values[index]);
    const y = Number.parseFloat(values[index + 1]);
    if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y });
  }
  if (!points.length) return null;
  return points.reduce((bounds, point) => ({
    minX: Math.min(bounds.minX, point.x),
    minY: Math.min(bounds.minY, point.y),
    maxX: Math.max(bounds.maxX, point.x),
    maxY: Math.max(bounds.maxY, point.y),
  }), {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  });
}

/** Computes how far a path extends into the reserved negative-coordinate field. */
function graphPathFieldPenalty(pathValue) {
  const bounds = graphPathBounds(pathValue);
  if (!bounds) return 0;
  const fieldMinX = ORIGIN_X / 2;
  const fieldMinY = ORIGIN_Y / 2;
  return Math.max(0, fieldMinX - bounds.minX) * 80
    + Math.max(0, fieldMinY - bounds.minY) * 80;
}

/** Computes a small deterministic unsigned hash for repeatable geometry jitter and tie-breaking. */
function graphStableHash(value) {
  const text = String(value || "");
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash;
}

/** Resolves the source connection anchor from marker geometry, route metadata, or shape boundary. */
export function graphSourceAnchor(edge = {}, node = {}) {
  const marker = edge?.sourceMarker;
  if (marker && Number.isFinite(marker.x) && Number.isFinite(marker.y)) {
    const vector = normalizeVector(marker.vector, graphVectorForFlowDirection(edge, "source"));
    const angleDeg = Number.isFinite(Number(marker.angleDeg))
      ? Number(marker.angleDeg)
      : graphAngleDegFromVector(vector);
    return {
      x: marker.x,
      y: marker.y,
      side: graphSideForAngleDeg(angleDeg),
      angleDeg,
      vector,
      exitVector: vector,
      exitDirection: vector.x || 1,
    };
  }
  const vector = graphVectorForFlowDirection(edge, "source");
  const anchor = graphNodePortAnchor(node, vector);
  return {
    ...anchor,
    exitVector: anchor.vector,
    exitDirection: anchor.vector.x || 1,
  };
}

/** Resolves the target connection anchor from marker geometry, route metadata, or shape boundary. */
export function graphTargetAnchor(edge = {}, node = {}) {
  const marker = edge?.targetMarker;
  if (marker && Number.isFinite(marker.x) && Number.isFinite(marker.y)) {
    const vector = normalizeVector(marker.vector, graphVectorForFlowDirection(edge, "target"));
    const angleDeg = Number.isFinite(Number(marker.angleDeg))
      ? Number(marker.angleDeg)
      : graphAngleDegFromVector(vector);
    const enterVector = normalizeVector({ x: -vector.x, y: -vector.y }, graphVectorForFlowDirection(edge, "source"));
    return {
      x: marker.x,
      y: marker.y,
      side: graphSideForAngleDeg(angleDeg),
      angleDeg,
      vector,
      enterVector,
      enterDirection: enterVector.x || 1,
    };
  }
  const vector = graphVectorForFlowDirection(edge, "target");
  const anchor = graphNodePortAnchor(node, vector);
  const enterVector = normalizeVector({ x: -anchor.vector.x, y: -anchor.vector.y }, graphVectorForFlowDirection(edge, "source"));
  return {
    ...anchor,
    enterVector,
    enterDirection: enterVector.x || 1,
  };
}

/** Computes arrowhead triangle points from the final route tangent and target marker. */
export function graphEdgeArrowGeometry(edge = {}) {
  if (edge?.terminal === true) return null;
  const points = sampledGraphPathPoints(edge.path);
  if (points.length < 2) return null;
  const tip = points[points.length - 1];
  let previous = points[points.length - 2];
  for (let index = points.length - 2; index >= 0; index -= 1) {
    const candidate = points[index];
    if (Math.hypot(tip.x - candidate.x, tip.y - candidate.y) >= 6) {
      previous = candidate;
      break;
    }
  }
  const direction = normalizeVector(
    { x: tip.x - previous.x, y: tip.y - previous.y },
    { x: 1, y: 0 },
  );
  const normal = { x: -direction.y, y: direction.x };
  const length = 8;
  const halfWidth = 4.4;
  const biasedTip = {
    x: tip.x + direction.x * GRAPH_ARROW_TIP_BIAS,
    y: tip.y + direction.y * GRAPH_ARROW_TIP_BIAS,
  };
  const base = {
    x: biasedTip.x - direction.x * length,
    y: biasedTip.y - direction.y * length,
  };
  const left = {
    x: base.x + normal.x * halfWidth,
    y: base.y + normal.y * halfWidth,
  };
  const right = {
    x: base.x - normal.x * halfWidth,
    y: base.y - normal.y * halfWidth,
  };
  return {
    path: [
      `M ${Math.round(biasedTip.x * 10) / 10} ${Math.round(biasedTip.y * 10) / 10}`,
      `L ${Math.round(left.x * 10) / 10} ${Math.round(left.y * 10) / 10}`,
      `L ${Math.round(right.x * 10) / 10} ${Math.round(right.y * 10) / 10}`,
      "Z",
    ].join(" "),
  };
}

/** Expands accumulated content bounds with one additional finite rectangle or point extent. */
function expandedBounds(bounds, left, top, right, bottom) {
  const values = [left, top, right, bottom].map((value) => Number(value));
  if (!values.every(Number.isFinite)) return bounds;
  const [safeLeft, safeTop, safeRight, safeBottom] = values;
  if (safeRight < safeLeft || safeBottom < safeTop) return bounds;
  if (!bounds) {
    return {
      left: safeLeft,
      top: safeTop,
      right: safeRight,
      bottom: safeBottom,
    };
  }
  return {
    left: Math.min(bounds.left, safeLeft),
    top: Math.min(bounds.top, safeTop),
    right: Math.max(bounds.right, safeRight),
    bottom: Math.max(bounds.bottom, safeBottom),
  };
}

/** Computes visible content bounds across non-proxy nodes, containers, paths, labels, and arrows. */
export function graphVisibleContentBounds(viewModel = {}) {
  const nodes = Array.isArray(viewModel?.nodes) ? viewModel.nodes : [];
  const edges = Array.isArray(viewModel?.edges) ? viewModel.edges : [];
  const containers = Array.isArray(viewModel?.containers) ? viewModel.containers : [];
  let bounds = null;
  for (const container of containers) {
    const x = Number(container?.x);
    const y = Number(container?.y);
    const width = Number(container?.width);
    const height = Number(container?.height);
    bounds = expandedBounds(bounds, x, y, x + width, y + height);
  }
  for (const node of nodes) {
    const x = Number(node?.x);
    const y = Number(node?.y);
    const width = graphNodeWidth(node);
    const height = graphNodeHeight(node);
    bounds = expandedBounds(bounds, x, y, x + width, y + height);
    for (const marker of Array.isArray(node?.connectionMarkers) ? node.connectionMarkers : []) {
      const markerX = Number(marker?.x);
      const markerY = Number(marker?.y);
      bounds = expandedBounds(
        bounds,
        markerX - EDGE_FIT_BOUNDS_PADDING,
        markerY - EDGE_FIT_BOUNDS_PADDING,
        markerX + EDGE_FIT_BOUNDS_PADDING,
        markerY + EDGE_FIT_BOUNDS_PADDING,
      );
    }
  }
  for (const edge of edges) {
    const edgeBounds = graphPathBounds(edge?.path);
    if (edgeBounds) {
      bounds = expandedBounds(
        bounds,
        edgeBounds.minX - EDGE_FIT_BOUNDS_PADDING,
        edgeBounds.minY - EDGE_FIT_BOUNDS_PADDING,
        edgeBounds.maxX + EDGE_FIT_BOUNDS_PADDING,
        edgeBounds.maxY + EDGE_FIT_BOUNDS_PADDING,
      );
    }
    if (edgeLabelVisible(edge)) {
      bounds = expandedBounds(
        bounds,
        Number(edge.labelX) - EDGE_LABEL_WIDTH / 2,
        Number(edge.labelY) - EDGE_LABEL_HEIGHT / 2,
        Number(edge.labelX) + EDGE_LABEL_WIDTH / 2,
        Number(edge.labelY) + EDGE_LABEL_HEIGHT / 2,
      );
    }
  }
  const resolved = bounds || { left: 0, top: 0, right: 1, bottom: 1 };
  return {
    ...resolved,
    width: Math.max(1, resolved.right - resolved.left),
    height: Math.max(1, resolved.bottom - resolved.top),
  };
}

/** Checks whether a hidden routing proxy should be excluded from visible content geometry. */
export function graphNodeExcluded(node = {}) {
  return node?.transportEnabled === false || normalizeTransportToken(node?.transportStateText) === "EXCLUDED";
}
