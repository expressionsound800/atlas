/*
 * Graph Render projects an assembled view model into DOM and SVG layers,
 * interaction attributes, labels, markers, containers, and selection states.
 */
import {
  edgeDisplayLabel,
  edgeLabelVisible,
  graphEdgeArrowGeometry,
  graphNodeExcluded,
  normalizeKind,
  normalizeTransportToken,
} from "./graph-geometry.js";
import {
  GRAPH_PRESENTATION_COMPACT,
  GRAPH_PRESENTATION_EXTENDED,
  normalizeGraphPresentationMode,
} from "./graph-view-state.js";
import {
  GRAPH_REPOSITORY_OVERVIEW_NAVIGATION_KIND,
  GRAPH_ROOM_NAVIGATION_KIND,
  graphNodeRepositoryOverviewEligibility,
  graphNodeRoomEntryEligibility,
} from "./graph-navigation.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const GRAPH_VISUAL_EMPHASIS = new Set([
  "past",
  "context",
  "current",
  "attention",
  "recent",
  "active",
  "resumable",
  "latest",
  "ongoing",
]);

/** Removes all existing rendered children before a complete deterministic Graph redraw. */
export function clearElement(element) {
  element.innerHTML = "";
}

/** Appends a styled text span only when the supplied visible value is non-empty. */
function appendText(parent, className, text) {
  const el = parent.ownerDocument.createElement("span");
  el.className = className;
  el.textContent = text;
  parent.appendChild(el);
  return el;
}

/** Appends a decorative icon span while keeping it outside the accessibility tree. */
function appendIcon(parent, className, text) {
  if (!text) return null;
  const el = parent.ownerDocument.createElement("span");
  el.className = `ui-icon ${className}`;
  el.textContent = text;
  el.setAttribute("aria-hidden", "true");
  parent.appendChild(el);
  return el;
}

/** Builds an accessible relationship description from endpoints, label, and edge kind. */
function edgeAccessibleLabel(edge = {}) {
  return edgeDisplayLabel(edge) || String(edge?.relationshipLabel || edge?.kind || "relationship").trim();
}

/** Selects the compact icon glyph that visually distinguishes an edge relationship kind. */
function edgeLabelIconText(edge = {}) {
  const kind = normalizeKind(edge?.kind);
  if (kind === "timing" || kind === "binding" || kind === "tempo") return "pace";
  if (kind === "control") return "laps";
  return "";
}

/** Normalizes a provider style token into a safe CSS modifier class suffix. */
function graphVisualStyleClass(value) {
  const style = String(value || "").trim().toLowerCase();
  return ["primary", "reference", "support", "return"].includes(style) ? `is-${style}` : "";
}

/** Converts a provider emphasis value to a finite non-negative rendered intensity. */
function graphVisualEmphasis(value) {
  const emphasis = String(value || "").trim().toLowerCase();
  return GRAPH_VISUAL_EMPHASIS.has(emphasis) ? emphasis : "";
}

/** Returns the readable memory or graph kind displayed in a node card. */
function graphNodeKindLabel(node = {}) {
  return String(node?.memoryKind || node?.kind || "node")
    .trim()
    .replace(/[_-]+/g, " ")
    .toUpperCase();
}

/** Collapses rendered metadata prose to one clean line for compact node surfaces. */
function compactText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

/** Renders one visual grouping surface with role, label, description, and collapse state. */
function renderContainer(parent, container) {
  const containerEl = parent.ownerDocument.createElement("section");
  const styleClass = graphVisualStyleClass(container.visualStyle);
  const visualEmphasis = graphVisualEmphasis(container.visualEmphasis || container?.metadata?.activityState);
  const currentObjective = compactText(container?.metadata?.currentObjective || container?.currentObjective);
  containerEl.className = "workspace-graph-container";
  if (container.kind) containerEl.classList.add(`is-${container.kind}`);
  if (styleClass) containerEl.classList.add(styleClass);
  if (visualEmphasis) {
    containerEl.classList.add(`is-emphasis-${visualEmphasis}`);
    containerEl.dataset.visualEmphasis = visualEmphasis;
  }
  containerEl.style.left = `${container.x}px`;
  containerEl.style.top = `${container.y}px`;
  containerEl.style.width = `${container.width}px`;
  containerEl.style.height = `${container.height}px`;
  containerEl.dataset.containerId = container.id;
  containerEl.dataset.containerCollapsible = "true";
  if (container.kind) containerEl.dataset.containerKind = container.kind;
  if (currentObjective) containerEl.dataset.currentObjective = currentObjective;
  containerEl.setAttribute("aria-label", `${container.label}: ${container.role || "graph container"}`);

  const headerEl = containerEl.ownerDocument.createElement("span");
  headerEl.className = "workspace-graph-container-header";
  appendText(headerEl, "workspace-graph-container-title", container.label);
  if (container.role) appendText(headerEl, "workspace-graph-container-role", container.role);
  const collapseButton = containerEl.ownerDocument.createElement("button");
  collapseButton.type = "button";
  collapseButton.className = "workspace-graph-container-toggle";
  collapseButton.dataset.containerAction = "collapse";
  collapseButton.dataset.containerId = container.id;
  collapseButton.setAttribute("aria-label", `Collapse ${container.label || "container"}`);
  collapseButton.textContent = "-";
  headerEl.appendChild(collapseButton);
  containerEl.appendChild(headerEl);

  if (container.description) {
    appendText(containerEl, "workspace-graph-container-description", container.description);
  }
  if (currentObjective) {
    appendText(containerEl, "workspace-graph-container-current", `Now: ${currentObjective}`);
  }
  parent.appendChild(containerEl);
}

/** Renders the neutral route grid without exposing routing cost or blockage helper colors. */
function renderGraphGrid(contentEl, routeGrid, viewModel = {}) {
  if (!routeGrid || !Number.isFinite(Number(routeGrid.cellSize))) return;
  const svgEl = contentEl.ownerDocument.createElementNS(SVG_NS, "svg");
  svgEl.classList.add("workspace-graph-grid");
  const width = Math.max(Number(viewModel.width) || 0, 1);
  const height = Math.max(Number(viewModel.height) || 0, 1);
  const drawLeft = Math.max(0, Number(routeGrid.left) || 0);
  const drawTop = Math.max(0, Number(routeGrid.top) || 0);
  const drawRight = Math.min(width, Number(routeGrid.right) || width);
  const drawBottom = Math.min(height, Number(routeGrid.bottom) || height);
  svgEl.setAttribute("width", String(width));
  svgEl.setAttribute("height", String(height));
  svgEl.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svgEl.setAttribute("aria-hidden", "true");

  const linePath = [];
  for (let col = 0; col <= routeGrid.cols; col += 1) {
    const x = routeGrid.left + col * routeGrid.cellSize;
    if (x < drawLeft || x > drawRight) continue;
    linePath.push(`M ${x} ${drawTop} L ${x} ${drawBottom}`);
  }
  for (let row = 0; row <= routeGrid.rows; row += 1) {
    const y = routeGrid.top + row * routeGrid.cellSize;
    if (y < drawTop || y > drawBottom) continue;
    linePath.push(`M ${drawLeft} ${y} L ${drawRight} ${y}`);
  }
  const lineEl = svgEl.ownerDocument.createElementNS(SVG_NS, "path");
  lineEl.classList.add("workspace-graph-grid-lines");
  lineEl.setAttribute("d", linePath.join(" "));
  svgEl.appendChild(lineEl);

  const boundsEl = svgEl.ownerDocument.createElementNS(SVG_NS, "rect");
  boundsEl.classList.add("workspace-graph-grid-bounds");
  boundsEl.setAttribute("x", String(drawLeft));
  boundsEl.setAttribute("y", String(drawTop));
  boundsEl.setAttribute("width", String(Math.max(0, drawRight - drawLeft)));
  boundsEl.setAttribute("height", String(Math.max(0, drawBottom - drawTop)));
  svgEl.appendChild(boundsEl);
  contentEl.appendChild(svgEl);
}

/** Renders one routed SVG relationship path with style, selection, and accessibility metadata. */
function renderEdge(svgEl, edge) {
  const edgeKind = normalizeKind(edge.kind);
  const styleClass = graphVisualStyleClass(edge.visualStyle);
  const isDisabled = edge.enabled === false;
  const transportStateText = normalizeTransportToken(edge.transportStateText);
  if (edge?.terminal === true) return;
  const pathEl = svgEl.ownerDocument.createElementNS(SVG_NS, "path");
  pathEl.classList.add("workspace-graph-edge");
  if (edgeKind) pathEl.classList.add(`is-${edgeKind}`);
  if (styleClass) pathEl.classList.add(styleClass);
  pathEl.classList.toggle("is-disabled", isDisabled);
  pathEl.classList.toggle("is-active-chain", edge.activeChain === true);
  pathEl.setAttribute("d", edge.path);
  pathEl.setAttribute("fill", "none");
  pathEl.setAttribute("aria-label", `${edge.from} to ${edge.to}: ${edgeAccessibleLabel(edge)}`);
  pathEl.dataset.edgeId = edge.id;
  pathEl.dataset.edgeKind = edgeKind;
  if (edge.relationshipKind) pathEl.dataset.relationshipKind = edge.relationshipKind;
  if (edge.visualStyle) pathEl.dataset.visualStyle = edge.visualStyle;
  pathEl.dataset.from = edge.from;
  pathEl.dataset.to = edge.to;
  if (edge.routeFrom) pathEl.dataset.routeFrom = edge.routeFrom;
  if (edge.routeTo) pathEl.dataset.routeTo = edge.routeTo;
  if (edge.compoundSourceContainerId) pathEl.dataset.compoundSourceContainerId = edge.compoundSourceContainerId;
  if (edge.compoundTargetContainerId) pathEl.dataset.compoundTargetContainerId = edge.compoundTargetContainerId;
  if (transportStateText) pathEl.dataset.transportState = transportStateText;
  svgEl.appendChild(pathEl);
}

/** Renders the target arrowhead using the edge's computed endpoint marker geometry. */
function renderEdgeArrow(parent, edge) {
  const geometry = graphEdgeArrowGeometry(edge);
  if (!geometry) return;
  const arrowEl = parent.ownerDocument.createElementNS(SVG_NS, "path");
  arrowEl.classList.add("workspace-graph-edge-arrowhead");
  const edgeKind = normalizeKind(edge.kind);
  const styleClass = graphVisualStyleClass(edge.visualStyle);
  const transportStateText = normalizeTransportToken(edge.transportStateText);
  if (edgeKind) arrowEl.classList.add(`is-${edgeKind}`);
  if (styleClass) arrowEl.classList.add(styleClass);
  arrowEl.classList.toggle("is-disabled", edge.enabled === false);
  arrowEl.classList.toggle("is-active-chain", edge.activeChain === true);
  arrowEl.setAttribute("d", geometry.path);
  arrowEl.dataset.edgeId = edge.id;
  arrowEl.dataset.edgeKind = edgeKind;
  if (edge.relationshipKind) arrowEl.dataset.relationshipKind = edge.relationshipKind;
  if (edge.visualStyle) arrowEl.dataset.visualStyle = edge.visualStyle;
  arrowEl.dataset.from = edge.from;
  arrowEl.dataset.to = edge.to;
  if (edge.routeFrom) arrowEl.dataset.routeFrom = edge.routeFrom;
  if (edge.routeTo) arrowEl.dataset.routeTo = edge.routeTo;
  if (edge.compoundSourceContainerId) arrowEl.dataset.compoundSourceContainerId = edge.compoundSourceContainerId;
  if (edge.compoundTargetContainerId) arrowEl.dataset.compoundTargetContainerId = edge.compoundTargetContainerId;
  if (transportStateText) arrowEl.dataset.transportState = transportStateText;
  arrowEl.setAttribute("aria-hidden", "true");
  parent.appendChild(arrowEl);
}

/** Renders a positioned relationship label control for selectable non-terminal edges. */
function renderEdgeLabel(parent, edge) {
  if (!edgeLabelVisible(edge)) return;
  const label = edgeDisplayLabel(edge);
  const button = parent.ownerDocument.createElement("button");
  button.type = "button";
  button.className = "workspace-graph-edge-label";
  const edgeKind = normalizeKind(edge.kind);
  const styleClass = graphVisualStyleClass(edge.visualStyle);
  if (edgeKind) button.classList.add(`is-${edgeKind}`);
  if (styleClass) button.classList.add(styleClass);
  button.classList.toggle("is-disabled", edge.enabled === false);
  button.classList.toggle("is-active-chain", edge.activeChain === true);
  button.style.left = `${Math.max(0, edge.labelX)}px`;
  button.style.top = `${Math.max(0, edge.labelY)}px`;
  button.dataset.edgeId = edge.id;
  button.dataset.edgeKind = edgeKind;
  if (edge.relationshipKind) button.dataset.relationshipKind = edge.relationshipKind;
  if (edge.visualStyle) button.dataset.visualStyle = edge.visualStyle;
  button.dataset.from = edge.from;
  button.dataset.to = edge.to;
  if (edge.routeFrom) button.dataset.routeFrom = edge.routeFrom;
  if (edge.routeTo) button.dataset.routeTo = edge.routeTo;
  if (edge.compoundSourceContainerId) button.dataset.compoundSourceContainerId = edge.compoundSourceContainerId;
  if (edge.compoundTargetContainerId) button.dataset.compoundTargetContainerId = edge.compoundTargetContainerId;
  appendIcon(button, "workspace-graph-edge-label-icon", edgeLabelIconText(edge));
  appendText(button, "workspace-graph-edge-label-text", label);
  parent.appendChild(button);
}

/** Renders one interactive node card including markers, semantic evidence, and source details. */
function renderNode(parent, node, options = {}) {
  const button = parent.ownerDocument.createElement("button");
  const presentationMode = normalizeGraphPresentationMode(node?.presentationMode);
  // Marker visibility uses the same contracts as controller navigation. A raw
  // provider boolean cannot turn evidence into a room or an authority into a
  // repository-overview return.
  const roomEntry = graphNodeRoomEntryEligibility(node, {
    currentRoomId: options.currentRoomId,
  });
  const overviewReturn = graphNodeRepositoryOverviewEligibility(node, {
    currentRoomId: options.currentRoomId,
  });
  const drilldownCapable = roomEntry.eligible;
  const overviewReturnCapable = overviewReturn.eligible;
  const graphNavigationKind = drilldownCapable
    ? GRAPH_ROOM_NAVIGATION_KIND
    : overviewReturnCapable
      ? GRAPH_REPOSITORY_OVERVIEW_NAVIGATION_KIND
      : "";
  const graphNavigationCapable = Boolean(graphNavigationKind);
  const collapsedContainer = node?.collapsedContainer === true || node?.metadata?.collapsedContainer === true;
  button.type = "button";
  button.className = "workspace-graph-node workspace-entity-item";
  button.classList.add(`is-${node.kind}`);
  button.classList.toggle("is-extended", presentationMode === GRAPH_PRESENTATION_EXTENDED);
  button.classList.toggle("is-compact", presentationMode === GRAPH_PRESENTATION_COMPACT);
  button.classList.toggle("is-timing-source", Boolean(node.emitsTiming));
  button.classList.toggle("is-selected", node.selected === true);
  button.classList.toggle("is-active-chain", node.activeChain === true);
  button.classList.toggle("is-excluded", graphNodeExcluded(node));
  button.classList.toggle("has-drilldown", drilldownCapable);
  button.classList.toggle("has-graph-navigation", graphNavigationCapable);
  button.classList.toggle("is-collapsed-container", collapsedContainer);
  const visualEmphasis = graphVisualEmphasis(node?.visualEmphasis);
  if (visualEmphasis) {
    button.classList.add(`is-emphasis-${visualEmphasis}`);
    button.dataset.visualEmphasis = visualEmphasis;
  }
  button.dataset.nodeKind = node.kind;
  if (node.memoryKind) button.dataset.memoryKind = node.memoryKind;
  button.dataset.nodeType = node.kind;
  button.dataset.nodeId = node.id;
  if (roomEntry.entryKind) button.dataset.entryKind = roomEntry.entryKind;
  if (roomEntry.navigationKind) button.dataset.navigationKind = roomEntry.navigationKind;
  if (roomEntry.targetRoomId) button.dataset.roomTargetId = roomEntry.targetRoomId;
  if (roomEntry.roomGraphStatus) button.dataset.roomGraphStatus = roomEntry.roomGraphStatus;
  if (roomEntry.roomGraphSourceModel) button.dataset.roomGraphSourceModel = roomEntry.roomGraphSourceModel;
  if (roomEntry.roomGraphFreshnessStatus) button.dataset.roomGraphFreshnessStatus = roomEntry.roomGraphFreshnessStatus;
  if (roomEntry.graphEndpoint) button.dataset.roomGraphEndpoint = roomEntry.graphEndpoint;
  button.dataset.roomEntryReason = roomEntry.reason;
  button.dataset.repositoryOverviewReason = overviewReturn.reason;
  if (graphNavigationKind) button.dataset.graphNavigationKind = graphNavigationKind;
  if (overviewReturnCapable) {
    button.dataset.overviewReturnCapable = "true";
    button.dataset.repositoryId = overviewReturn.repositoryId;
    button.dataset.repositoryOverviewStatus = overviewReturn.repositoryOverviewStatus;
    button.dataset.repositoryOverviewEndpoint = overviewReturn.repositoryOverviewEndpoint;
  }
  if (collapsedContainer) {
    button.dataset.collapsedContainer = "true";
    button.dataset.containerAction = "expand";
    button.dataset.containerId = node.id;
  }
  if (node.semanticRole) button.dataset.semanticRole = node.semanticRole;
  if (node.semanticJustification) button.dataset.semanticJustification = node.semanticJustification;
  if (drilldownCapable) button.dataset.drilldownCapable = "true";
  const currentObjective = compactText(node?.metadata?.currentObjective || node?.currentObjective);
  if (currentObjective) button.dataset.currentObjective = currentObjective;
  if (Number.isFinite(Number(node.semanticCenterScore))) {
    button.dataset.semanticCenterScore = String(Math.round(Number(node.semanticCenterScore) * 1000) / 1000);
  }
  if (node.transportStateText) button.dataset.transportState = node.transportStateText;
  button.style.left = `${node.x}px`;
  button.style.top = `${node.y}px`;
  button.style.width = `${node.width}px`;
  button.style.height = `${node.height}px`;
  const navigationLabel = drilldownCapable
    ? " opens room"
    : overviewReturnCapable
      ? " returns to repository overview"
      : "";
  button.setAttribute("aria-label", `${node.kind} ${node.label}${navigationLabel}`);
  if (node.semanticJustification) button.title = node.semanticJustification;
  button.tabIndex = -1;
  if (String(node?.repeatLabel || "").trim() && node.repeatLabelHidden !== true) {
    appendText(button, "workspace-graph-node-repeat-label", node.repeatLabel);
  }
  if (presentationMode === GRAPH_PRESENTATION_EXTENDED) {
    const cardEl = button.ownerDocument.createElement("span");
    cardEl.className = "workspace-graph-node-card";
    // A provider may suppress its internal classifier when the learned label
    // and summary already state the component's repository-specific meaning.
    if (node?.metadata?.kindLabelHidden !== true && node?.metadata?.kindLabelHidden !== "true") {
      appendText(cardEl, "workspace-graph-node-kicker", graphNodeKindLabel(node));
    }
    appendText(cardEl, "workspace-graph-node-title", node.label);
    appendText(cardEl, "workspace-graph-node-meta", String(node.layer || "").trim());
    if (node.sourceHidden !== true) {
      appendText(cardEl, "workspace-graph-node-source", String(node.source || "").trim());
    }
    appendText(cardEl, "workspace-graph-node-summary", String(node.description || "").trim());
    if (currentObjective) {
      appendText(cardEl, "workspace-graph-node-current", `Now: ${currentObjective}`);
    }
    button.appendChild(cardEl);
  } else if (node.labelHidden !== true) {
    const labelEl = appendText(
      button,
      "workspace-cell-tab-title workspace-entity-label workspace-graph-node-label",
      node.label,
    );
    if (node.labelWidth) labelEl.style.maxInlineSize = `${node.labelWidth}px`;
  }
  if (graphNavigationCapable) {
    const markerEl = button.ownerDocument.createElement("span");
    markerEl.className = "workspace-graph-node-drilldown-marker";
    markerEl.setAttribute("aria-hidden", "true");
    markerEl.title = drilldownCapable ? "Open room" : "Back to repository overview";
    button.appendChild(markerEl);
  }
  if (collapsedContainer) {
    const markerEl = button.ownerDocument.createElement("span");
    markerEl.className = "workspace-graph-container-expand-marker";
    markerEl.setAttribute("aria-hidden", "true");
    markerEl.title = "Expand container";
    button.appendChild(markerEl);
  }
  (Array.isArray(node.connectionMarkers) ? node.connectionMarkers : []).forEach((marker) => {
    const markerEl = button.ownerDocument.createElement("span");
    markerEl.className = "workspace-graph-node-connector";
    markerEl.classList.add(`is-${marker.direction}`, `is-${marker.role}`);
    if (marker.side) markerEl.classList.add(`is-${marker.side}`);
    if (marker.kind) markerEl.classList.add(`is-${marker.kind}`);
    markerEl.classList.toggle("is-active-chain", marker.activeChain === true);
    markerEl.style.left = `${marker.localX}px`;
    markerEl.style.top = `${marker.localY}px`;
    markerEl.dataset.connectionDirection = marker.direction;
    if (marker.side) markerEl.dataset.connectionSide = marker.side;
    markerEl.dataset.connectionRole = marker.role;
    markerEl.dataset.connectionKind = marker.kind || marker.role;
    markerEl.dataset.edgeId = marker.edgeId;
    if (marker.transportStateText) markerEl.dataset.transportState = marker.transportStateText;
    markerEl.setAttribute("aria-hidden", "true");
    button.appendChild(markerEl);
  });
  parent.appendChild(button);
}

/** Resolves the optional render-layer allowlist used by incremental DOM updates. */
function graphRenderLayerSet(options = {}) {
  const requested = Array.isArray(options.layers) ? options.layers : [];
  if (!requested.length) {
    return new Set(["grid", "containers", "edges", "labels", "nodes", "arrows"]);
  }
  return new Set(requested.map((layer) => String(layer || "").trim()).filter(Boolean));
}

/** Renders selected grid, container, edge, marker, label, and node layers from one view model. */
export function renderGraphContent(contentEl, viewModel, options = {}) {
  const layerSet = graphRenderLayerSet(options);
  clearElement(contentEl);
  contentEl.dataset.renderLayerMode = options.layerMode || "complete";
  contentEl.dataset.renderLayers = [...layerSet].join(",");
  if (viewModel.empty) {
    const emptyEl = contentEl.ownerDocument.createElement("div");
    emptyEl.className = "workspace-graph-empty";
    emptyEl.textContent = "NO PROJECT ENTITIES";
    contentEl.appendChild(emptyEl);
    return;
  }

  const containersEl = contentEl.ownerDocument.createElement("div");
  containersEl.className = "workspace-graph-containers";
  if (layerSet.has("grid")) renderGraphGrid(contentEl, viewModel.routeGrid, viewModel);
  if (layerSet.has("containers")) {
    for (const container of Array.isArray(viewModel.containers) ? viewModel.containers : []) {
      renderContainer(containersEl, container);
    }
  }
  contentEl.appendChild(containersEl);

  const svgEl = contentEl.ownerDocument.createElementNS(SVG_NS, "svg");
  svgEl.classList.add("workspace-graph-edges");
  svgEl.setAttribute("width", String(viewModel.width));
  svgEl.setAttribute("height", String(viewModel.height));
  svgEl.setAttribute("viewBox", `0 0 ${viewModel.width} ${viewModel.height}`);
  svgEl.setAttribute("aria-hidden", "true");
  if (layerSet.has("edges")) {
    for (const edge of viewModel.edges) renderEdge(svgEl, edge);
  }
  contentEl.appendChild(svgEl);

  const labelsEl = contentEl.ownerDocument.createElement("div");
  labelsEl.className = "workspace-graph-edge-labels";
  if (layerSet.has("labels")) {
    for (const edge of viewModel.edges) renderEdgeLabel(labelsEl, edge);
  }
  contentEl.appendChild(labelsEl);

  const nodesEl = contentEl.ownerDocument.createElement("div");
  nodesEl.className = "workspace-graph-nodes";
  if (layerSet.has("nodes")) {
    for (const node of viewModel.nodes) renderNode(nodesEl, node, options);
  }
  contentEl.appendChild(nodesEl);

  const arrowSvgEl = contentEl.ownerDocument.createElementNS(SVG_NS, "svg");
  arrowSvgEl.classList.add("workspace-graph-arrows");
  arrowSvgEl.setAttribute("width", String(viewModel.width));
  arrowSvgEl.setAttribute("height", String(viewModel.height));
  arrowSvgEl.setAttribute("viewBox", `0 0 ${viewModel.width} ${viewModel.height}`);
  arrowSvgEl.setAttribute("aria-hidden", "true");
  if (layerSet.has("arrows")) {
    for (const edge of viewModel.edges) renderEdgeArrow(arrowSvgEl, edge);
  }
  contentEl.appendChild(arrowSvgEl);
}
