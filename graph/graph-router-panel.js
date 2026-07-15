/*
 * Router Panel renders provider health, selection detail, Architecture trails,
 * ranked candidates, and host-owned source actions beside the graph.
 */
import {
  compactText,
  compactValue,
  createButton,
  isPlainObject,
} from "./graph-controller-utils.js";

/** Appends labeled router facts while omitting rows whose values are absent. */
function appendRouterDetailList(parent, rows = []) {
  const visibleRows = rows
    .map(([term, detail]) => [String(term || "").trim(), String(detail || "").trim()])
    .filter(([term, detail]) => term && detail);
  if (!visibleRows.length) return;
  const listEl = document.createElement("dl");
  listEl.className = "graph-status-details";
  visibleRows.forEach(([term, detail]) => {
    const termEl = document.createElement("dt");
    termEl.textContent = term;
    const detailEl = document.createElement("dd");
    detailEl.textContent = detail;
    listEl.append(termEl, detailEl);
  });
  parent.appendChild(listEl);
}

/** Appends context navigation controls for the current node or edge selection. */
function appendRouterActionRow(parent, actions = []) {
  const visibleActions = actions.filter(Boolean);
  if (!visibleActions.length) return null;
  const rowEl = document.createElement("div");
  rowEl.className = "graph-router-actions";
  const leftEl = document.createElement("div");
  leftEl.className = "graph-router-actions-left";
  const rightEl = document.createElement("div");
  rightEl.className = "graph-router-actions-right";
  visibleActions.forEach((action) => {
    const button = createButton("graph-router-action", action.label || "Open");
    if (action.href) {
      button.dataset.documentHref = action.href;
      button.dataset.documentLabel = action.label || "Open";
    }
    if (action.action) button.dataset.routerAction = action.action;
    if (action.context) button.dataset.routerActionContext = action.context;
    if (action.roomId) button.dataset.architectureRoomId = action.roomId;
    if (action.routeRank) button.dataset.atlasRouteRank = String(action.routeRank);
    (action.placement === "left" ? leftEl : rightEl).appendChild(button);
  });
  if (leftEl.childElementCount) rowEl.appendChild(leftEl);
  if (rightEl.childElementCount) rowEl.appendChild(rightEl);
  parent.appendChild(rowEl);
  return rowEl;
}

/** Derives the most specific navigable source or Atlas-room link for a selected node. */
function routerContextHrefForNode(node = {}) {
  const query = compactValue([
    node?.label,
    node?.memoryKind || node?.kind,
    node?.layer,
    node?.description,
  ].filter(Boolean).join(" "), "memory");
  const params = new URLSearchParams({ query });
  const source = compactValue(node?.source);
  if (source) params.set("source", source);
  return `/api/router-packet?${params.toString()}`;
}

/** Derives a source-document link for a selected relationship when metadata permits it. */
function routerContextHrefForEdge(edge = {}) {
  const query = compactValue([
    edge?.from,
    edge?.relationshipLabel || edge?.label || edge?.kind,
    edge?.to,
  ].filter(Boolean).join(" "), "memory");
  return `/api/router-packet?query=${encodeURIComponent(query)}`;
}

/** Builds context actions for the active node or edge without duplicating unsupported navigation. */
function selectedRouterActions(
  selectedNode,
  selectedEdge,
  supportedArchitectureRoomIdForNode,
  supportedArchitectureNavigationForNode,
) {
  if (!selectedNode && !selectedEdge) {
    return [];
  }
  if (selectedEdge) {
    return [
      { label: "Deselect", action: "clear-selection", placement: "left" },
      { label: "Context", href: routerContextHrefForEdge(selectedEdge), placement: "right" },
    ].filter(Boolean);
  }
  const source = compactValue(selectedNode?.source);
  const sourceIsFile = Boolean(source
    && !/^\/?api\//i.test(source)
    && (/[/.]/.test(source) || /\.[A-Za-z0-9]+$/.test(source)));
  const architectureRoomId = typeof supportedArchitectureRoomIdForNode === "function"
    ? supportedArchitectureRoomIdForNode(selectedNode)
    : "";
  const architectureNavigation = typeof supportedArchitectureNavigationForNode === "function"
    ? supportedArchitectureNavigationForNode(selectedNode)
    : null;
  return [
    { label: "Deselect", action: "clear-selection", placement: "left" },
    architectureRoomId
      ? { label: "Enter Room", action: "enter-architecture-room", roomId: architectureRoomId, placement: "right" }
      : null,
    architectureNavigation?.kind === "repository-overview"
      ? { label: `Back to ${compactValue(selectedNode?.label, "Repository")}`, action: "exit-architecture-room", placement: "right" }
      : null,
    { label: "Context", href: routerContextHrefForNode(selectedNode), placement: "right" },
    sourceIsFile
      ? { label: "Source", href: `/api/source?path=${encodeURIComponent(source)}`, placement: "right" }
      : null,
  ].filter(Boolean);
}

/** Renders the bounded source-document preview or its explicit unavailable diagnostic. */
function renderRouterDocumentViewer(routerDocument = {}) {
  const viewerEl = document.createElement("aside");
  viewerEl.className = "graph-router-document";
  viewerEl.classList.toggle("is-open", routerDocument.open === true);
  if (!routerDocument.open) return viewerEl;

  const headerEl = document.createElement("header");
  headerEl.className = "graph-router-document-header";
  const titleEl = document.createElement("h3");
  titleEl.textContent = routerDocument.title || "Document";
  const closeButton = createButton("graph-info-close", "close", { "aria-label": "Close document" });
  closeButton.dataset.routerAction = "close-document";
  headerEl.append(titleEl, closeButton);

  const bodyEl = document.createElement("pre");
  bodyEl.className = "graph-router-document-body";
  if (routerDocument.status === "loading") {
    bodyEl.textContent = "Loading...";
  } else if (routerDocument.error) {
    bodyEl.textContent = `Unable to load document: ${routerDocument.error}`;
  } else {
    bodyEl.textContent = routerDocument.text || "No document content returned.";
  }
  viewerEl.append(headerEl, bodyEl);
  return viewerEl;
}

/** Appends inspected node or edge metadata and its available context actions. */
function appendSelectedRouterBody(bodyEl, selectedNode, selectedEdge) {
  const sectionEl = document.createElement("section");
  sectionEl.className = "graph-status-selected";
  const titleEl = document.createElement("h3");
  const bodyTextEl = document.createElement("p");
  bodyTextEl.className = "graph-status-selected-body";

  if (selectedNode) {
    titleEl.textContent = selectedNode.label || selectedNode.id || "Selected node";
    bodyTextEl.textContent = compactText(
      selectedNode.description || selectedNode.summary || selectedNode.label || "Selected memory graph node.",
    );
    const nodeMetadata = selectedNode.metadata?.nodeMetadata || {};
    const providerWhy = compactText(
      selectedNode.metadata?.providerWhy
      || nodeMetadata?.why?.decisionUse
      || nodeMetadata?.why?.inclusion,
    );
    const evidenceText = (Array.isArray(nodeMetadata?.evidence) ? nodeMetadata.evidence : [])
      .map((item) => compactText(item?.claim))
      .filter(Boolean)
      .slice(0, 2)
      .join("; ");
    sectionEl.append(titleEl, bodyTextEl);
    appendRouterDetailList(sectionEl, [
      ["kind", selectedNode.memoryKind || selectedNode.kind],
      ["layer", selectedNode.layer],
      ["status", selectedNode.metadata?.status || selectedNode.status],
      ["operations", selectedNode.metadata?.operationCountText],
      ["source", selectedNode.source],
      ["summary source", selectedNode.metadata?.summarySource],
      ["summary generated", selectedNode.metadata?.summaryGeneratedAt],
      ["semantic role", selectedNode.semanticRole],
      ["provider why", providerWhy],
      ["evidence", evidenceText],
      ["topology why", selectedNode.semanticJustification],
    ]);
  } else if (selectedEdge) {
    const edgeLabel = selectedEdge.relationshipLabel || selectedEdge.label || selectedEdge.kind || "relationship";
    titleEl.textContent = [selectedEdge.from, selectedEdge.to].filter(Boolean).join(" -> ") || "Selected path";
    bodyTextEl.textContent = compactText(`${selectedEdge.description || edgeLabel}.`);
    sectionEl.append(titleEl, bodyTextEl);
    appendRouterDetailList(sectionEl, [
      ["kind", selectedEdge.kind],
      ["relationship", edgeLabel],
      ["from", selectedEdge.from],
      ["to", selectedEdge.to],
    ]);
  }

  bodyEl.appendChild(sectionEl);
}

/** Formats a finite Atlas ranking signal to a compact three-decimal display. */
function formatAtlasScore(value) {
  const score = Number(value);
  return Number.isFinite(score) ? String(Number(score.toFixed(3))) : "";
}

/** Builds room-id labels from current selection, traversal candidates, and selected paths. */
function architectureRoomLabelMap(plan = {}, selectedRoom = {}) {
  const labels = new Map();
  const candidates = Array.isArray(plan.candidates) ? plan.candidates : [];
  for (const candidate of candidates) {
    const roomId = compactValue(candidate?.roomId).toUpperCase();
    const label = compactValue(candidate?.label || roomId);
    if (roomId && label) labels.set(roomId, label);
  }
  const selectedRoomId = compactValue(selectedRoom?.id).toUpperCase();
  if (selectedRoomId) labels.set(selectedRoomId, compactValue(selectedRoom?.label || selectedRoomId));
  return labels;
}

/** Translates a room path into a readable ordered trail with current-room marking. */
function architectureRouteTrail(path = {}, labels = new Map(), fallbackLabel = "", roomMode = false) {
  const roomIds = Array.isArray(path?.roomIds) ? path.roomIds : [];
  const trail = roomIds
    .map((roomId) => compactValue(labels.get(compactValue(roomId).toUpperCase()) || roomId))
    .filter(Boolean);
  if (!trail.length && fallbackLabel) trail.push(fallbackLabel);
  return roomMode ? ["Architecture Setup", ...trail] : trail;
}

/** Builds a readable explanation from ranking signals, traversal cost, and candidate ownership. */
function architectureCandidateReason(candidate = {}) {
  const reason = isPlainObject(candidate.reason) ? candidate.reason : {};
  const parts = [
    ["route", candidate.finalScore ?? candidate.score],
    ["lexical", reason.lexical],
    ["repo", reason.repoOverlap],
    ["facet", reason.facetOverlap],
    ["index", reason.indexSimilarity],
    ["vector", reason.vectorSimilarity],
    ["authority", reason.authority],
    ["freshness", reason.freshness],
  ]
    .map(([label, value]) => {
      const score = formatAtlasScore(value);
      return score ? `${label} ${score}` : "";
    })
    .filter(Boolean);
  const path = isPlainObject(candidate.path) ? candidate.path : {};
  const pathState = path.found === false ? "no path from current room" : "";
  return [pathState, ...parts].filter(Boolean).join(" - ");
}

/** Appends the current architecture traversal trail as an ordered visual sequence. */
function appendArchitectureRouteTrail(sectionEl, trail = []) {
  const visibleTrail = trail.filter(Boolean);
  if (!visibleTrail.length) return;
  sectionEl.dataset.atlasRouteTrail = visibleTrail.join(" -> ");

  const trailEl = document.createElement("div");
  trailEl.className = "graph-atlas-route-trail";
  const labelEl = document.createElement("strong");
  labelEl.textContent = "Route Trail";
  const pathEl = document.createElement("span");
  pathEl.textContent = visibleTrail.join(" -> ");
  trailEl.append(labelEl, pathEl);
  sectionEl.appendChild(trailEl);
}

/** Appends ranked room candidates while exposing actions only for provider-approved semantic rooms. */
function appendArchitectureRouteCandidates(
  sectionEl,
  plan = {},
  selectedRoom = {},
  roomMode = false,
  supportedArchitectureRoomIdForNode = null,
) {
  const candidates = (Array.isArray(plan.candidates) ? plan.candidates : [])
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => compactValue(candidate?.roomId));
  if (!candidates.length) return;

  const currentRoomId = compactValue(selectedRoom?.id || plan.selected?.roomId).toUpperCase();
  const selectedRoomId = compactValue(plan.selected?.roomId || selectedRoom?.id).toUpperCase();
  const labels = architectureRoomLabelMap(plan, selectedRoom);

  sectionEl.dataset.atlasCandidateCount = String(candidates.length);

  const listSectionEl = document.createElement("div");
  listSectionEl.className = "graph-atlas-route-candidates";
  listSectionEl.dataset.atlasRouteCandidates = "true";

  const titleEl = document.createElement("strong");
  titleEl.className = "graph-atlas-route-candidates-title";
  titleEl.textContent = "Ranked Rooms";
  listSectionEl.appendChild(titleEl);

  const listEl = document.createElement("ol");
  listEl.className = "graph-atlas-route-candidate-list";
  candidates.slice(0, 5).forEach(({ candidate, index }) => {
    const roomId = compactValue(candidate.roomId).toUpperCase();
    const navigableRoomId = typeof supportedArchitectureRoomIdForNode === "function"
      ? supportedArchitectureRoomIdForNode(candidate)
      : "";
    const label = compactValue(candidate.label || labels.get(roomId) || roomId);
    const score = formatAtlasScore(candidate.finalScore ?? candidate.score);
    const trail = architectureRouteTrail(candidate.path, labels, label, roomMode);
    const itemEl = document.createElement("li");
    itemEl.className = "graph-atlas-route-candidate";
    itemEl.classList.toggle("is-selected", roomId === selectedRoomId);
    itemEl.dataset.atlasRouteCandidateRoom = roomId;
    itemEl.dataset.atlasRouteCandidateSelected = roomId === selectedRoomId ? "true" : "false";
    itemEl.dataset.atlasRouteCandidateRank = String(index + 1);

    const headerEl = document.createElement("div");
    headerEl.className = "graph-atlas-route-candidate-header";
    const labelEl = document.createElement("span");
    labelEl.textContent = label;
    const scoreEl = document.createElement("span");
    scoreEl.textContent = score ? `score ${score}` : "score n/a";
    headerEl.append(labelEl, scoreEl);

    const detailEl = document.createElement("p");
    detailEl.textContent = [
      trail.length ? `trail ${trail.join(" -> ")}` : "",
      architectureCandidateReason(candidate),
    ].filter(Boolean).join(" - ");

    itemEl.append(headerEl, detailEl);
    if (navigableRoomId && navigableRoomId !== currentRoomId) {
      appendRouterActionRow(itemEl, [
        {
          label: "Open Room",
          action: "enter-architecture-room",
          context: "atlas-route-candidate",
          routeRank: index + 1,
          roomId: navigableRoomId,
          placement: "right",
        },
      ]);
    }
    listEl.appendChild(itemEl);
  });

  listSectionEl.appendChild(listEl);
  sectionEl.appendChild(listSectionEl);
}

/** Translates Atlas retrieval internals into the mechanism an operator can understand. */
function atlasRetrievalDescription(retrieval = {}) {
  const lexical = isPlainObject(retrieval.lexicalIndex) ? retrieval.lexicalIndex : {};
  const vector = isPlainObject(retrieval.vectorIndex) ? retrieval.vectorIndex : {};
  if (compactValue(retrieval.mode) === "catalog") return "repository catalog scan · no local index";
  if (compactValue(lexical.status) === "ready" && compactValue(vector.status) === "ready") {
    return "SQLite lexical index + local vector index";
  }
  if (compactValue(lexical.status) === "ready") return "SQLite lexical index";
  return compactValue(retrieval.mode);
}

/** Appends Atlas room identity, summary, source evidence, route trail, and candidate details. */
function appendArchitectureAtlasBody(bodyEl, architecture = {}) {
  if (!architecture.relevant) return;
  const packet = architecture.packet;
  const sectionEl = document.createElement("section");
  sectionEl.className = "graph-status-selected graph-atlas-status";
  sectionEl.dataset.atlasStatus = architecture.status || "";

  const roomMode = architecture.projectionMode === "room";
  const titleEl = document.createElement("h3");
  titleEl.textContent = roomMode ? "Architecture Room" : "Repository Setup";
  const bodyTextEl = document.createElement("p");
  bodyTextEl.className = "graph-status-selected-body";

  if (!packet) {
    bodyTextEl.textContent = architecture.error
      ? `Atlas route unavailable: ${architecture.error}`
      : "Atlas route is not loaded for this projection.";
    sectionEl.append(titleEl, bodyTextEl);
    bodyEl.appendChild(sectionEl);
    return;
  }

  const retrieval = isPlainObject(packet.retrieval) ? packet.retrieval : {};
  const plan = isPlainObject(packet.plan) ? packet.plan : {};
  const selected = isPlainObject(plan.selected) ? plan.selected : {};
  const selectedRoom = isPlainObject(packet.selectedRoom) ? packet.selectedRoom : {};
  const searchResults = Array.isArray(packet.search?.results) ? packet.search.results : [];
  const topSearch = searchResults[0] || {};
  const index = isPlainObject(retrieval.index) ? retrieval.index : {};
  const metrics = isPlainObject(index.metrics) ? index.metrics : {};
  const generatedSummaries = isPlainObject(retrieval.generatedSummaries) ? retrieval.generatedSummaries : {};
  const routePath = Array.isArray(selected?.path?.roomIds) ? selected.path.roomIds : [];
  const capabilityGaps = Array.isArray(retrieval.capabilityGaps) ? retrieval.capabilityGaps : [];
  const selectedLabel = compactValue(selectedRoom.label || selected.label || selected.roomId, "No selected room");
  const indexSimilarity = formatAtlasScore(selected?.reason?.indexSimilarity);
  const trailLabels = architectureRoomLabelMap(plan, selectedRoom);
  const routeTrail = architectureRouteTrail(selected?.path, trailLabels, selectedLabel, roomMode);

  sectionEl.dataset.atlasRetrievalMode = compactValue(retrieval.mode);
  sectionEl.dataset.atlasSelectedRoom = selectedLabel;
  sectionEl.dataset.atlasIndexSimilarity = indexSimilarity;

  bodyTextEl.textContent = compactText(
    `${selectedLabel}. ${selectedRoom.summary || selectedRoom.generatedSummary || "Selected by route, index, and room scores."}`,
    220,
  );
  sectionEl.append(titleEl, bodyTextEl);
  appendRouterDetailList(sectionEl, [
    roomMode ? ["room", architecture.roomId] : null,
    ["retrieval", atlasRetrievalDescription(retrieval)],
    ["index", metrics.rooms || metrics.tokens
      ? `${index.status || "index"} · ${Number(metrics.rooms || 0)} entries · ${Number(metrics.tokens || 0)} tokens`
      : index.status],
    ["summaries", generatedSummaries.status
      ? `${generatedSummaries.status} · ${Number(generatedSummaries.available || 0)} generated · ${Number(generatedSummaries.providerAuthoredFallbacks || 0)} fallback`
      : ""],
    ["selected entry", selectedLabel],
    ["route score", formatAtlasScore(selected.finalScore ?? selected.score)],
    ["index similarity", indexSimilarity],
    ["top index hit", topSearch.label
      ? `${topSearch.label} · ${formatAtlasScore(topSearch.normalizedScore)}`
      : ""],
    ["route", routePath.length ? routePath.join(" -> ") : ""],
    ["capability gaps", capabilityGaps.join(", ")],
    ["graph endpoint", packet.graphEndpoint],
  ].filter(Boolean));
  appendArchitectureRouteTrail(sectionEl, routeTrail);
  appendArchitectureRouteCandidates(
    sectionEl,
    plan,
    selectedRoom,
    roomMode,
    architecture.supportedArchitectureRoomIdForNode,
  );
  if (roomMode) {
    appendRouterActionRow(sectionEl, [
      { label: "Back to Setup", action: "exit-architecture-room", placement: "left" },
    ]);
  }
  bodyEl.appendChild(sectionEl);
}

/** Appends route-gate health counts, failures, warnings, and fetch diagnostics. */
function appendRouterHealthBody(bodyEl, summary, status, routerHealth = {}, routerHealthError = "") {
  const summaryEl = document.createElement("div");
  summaryEl.className = "graph-status-summary";
  summaryEl.textContent = routerHealthError
    ? `Router health unavailable: ${routerHealthError}`
    : `${status.charAt(0).toUpperCase()}${status.slice(1)} · ${Number(summary.missing || 0)} missing · ${Number(summary.attention || 0)} attention`;
  bodyEl.appendChild(summaryEl);

  const gates = Array.isArray(routerHealth?.gates) ? routerHealth.gates : [];
  const visibleGates = gates.filter((gate) => gate?.status && gate.status !== "passed");
  if (visibleGates.length) {
    const listEl = document.createElement("ul");
    listEl.className = "graph-status-gates";
    visibleGates.forEach((gate) => {
      const itemEl = document.createElement("li");
      itemEl.className = "graph-status-gate";
      itemEl.dataset.status = String(gate.status || "");
      const title = document.createElement("strong");
      title.textContent = `${gate.title || gate.id || "Gate"} · ${gate.status}`;
      const detail = document.createElement("span");
      detail.textContent = gate.stateSummary || "";
      itemEl.append(title, detail);
      listEl.appendChild(itemEl);
    });
    bodyEl.appendChild(listEl);
  }
}

/** Renders the complete floating status panel for selection, Atlas routing, and router health. */
export function renderGraphStatusPanel(settings = {}) {
  const {
    statusPanelEl,
    statusPanelOpen,
    routerDocument = {},
    routerHealth = {},
    routerHealthStatus = "",
    routerHealthError = "",
    selectedNode = null,
    selectedEdge = null,
    architecture = {},
    supportedArchitectureRoomIdForNode = null,
    supportedArchitectureNavigationForNode = null,
  } = settings;
  if (!statusPanelEl) return;
  statusPanelEl.hidden = false;
  statusPanelEl.classList.toggle("is-collapsed", !statusPanelOpen);
  statusPanelEl.classList.toggle("has-document-viewer", routerDocument.open === true && statusPanelOpen);
  statusPanelEl.replaceChildren();

  const titleEl = document.createElement("h2");
  titleEl.textContent = "Router";
  const toggleButton = createButton(
    "graph-info-close",
    statusPanelOpen ? "collapse" : "open",
    { "aria-label": statusPanelOpen ? "Collapse router status" : "Open router status" },
  );
  toggleButton.dataset.routerAction = "toggle-status-panel";
  const headerEl = document.createElement("header");
  headerEl.className = "graph-info-header";
  headerEl.dataset.statusPanelDragHandle = "true";
  headerEl.append(titleEl, toggleButton);

  const summary = routerHealth?.summary || {};
  const status = routerHealthError
    ? "unavailable"
    : routerHealthStatus === "loading"
      ? "loading"
      : String(routerHealth?.status || "unknown");

  if (!statusPanelOpen) {
    const collapsedSummaryEl = document.createElement("div");
    collapsedSummaryEl.className = "graph-status-summary graph-status-summary-collapsed";
    if (selectedNode) {
      collapsedSummaryEl.textContent = `Selected · ${selectedNode.label || selectedNode.id}`;
    } else if (selectedEdge) {
      collapsedSummaryEl.textContent = `Path · ${selectedEdge.relationshipLabel || selectedEdge.label || selectedEdge.kind || selectedEdge.id}`;
    } else if (architecture.relevant && architecture.packet) {
      const packet = architecture.packet;
      const mode = compactValue(packet?.retrieval?.mode, "atlas");
      const selectedLabel = compactValue(packet?.selectedRoom?.label || packet?.plan?.selected?.label || packet?.plan?.selected?.roomId);
      collapsedSummaryEl.textContent = ["Atlas", mode, selectedLabel].filter(Boolean).join(" · ");
    } else {
      collapsedSummaryEl.textContent = routerHealthError
        ? "Router health unavailable"
        : `${Number(summary.missing || 0)} missing · ${Number(summary.attention || 0)} attention`;
    }
    statusPanelEl.append(headerEl, collapsedSummaryEl);
    return;
  }

  const bodyEl = document.createElement("div");
  bodyEl.className = "graph-status-body";
  if (selectedNode || selectedEdge) {
    appendSelectedRouterBody(bodyEl, selectedNode, selectedEdge);
  } else {
    if (architecture.relevant) appendArchitectureAtlasBody(bodyEl, architecture);
    appendRouterHealthBody(bodyEl, summary, status, routerHealth, routerHealthError);
  }

  const contentElForPanel = document.createElement("div");
  contentElForPanel.className = "graph-router-panel-content";
  contentElForPanel.append(bodyEl, renderRouterDocumentViewer(routerDocument));

  const footerEl = document.createElement("footer");
  footerEl.className = "graph-router-footer";
  appendRouterActionRow(footerEl, selectedRouterActions(
    selectedNode,
    selectedEdge,
    supportedArchitectureRoomIdForNode,
    supportedArchitectureNavigationForNode,
  ));
  footerEl.hidden = footerEl.childElementCount === 0;

  statusPanelEl.append(headerEl, contentElForPanel, footerEl);
}
