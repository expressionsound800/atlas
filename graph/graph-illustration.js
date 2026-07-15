/*
 * Graph Illustration coordinates the embeddable controller, source selection,
 * view-state persistence, layout application, rendering, and standalone shell.
 */
import {
  GRAPH_ROUTE_MODE_QUALITY,
  GRAPH_ROUTE_MODE_SPEED,
  buildIllustrationGraphViewModel,
  normalizeGraphRouteMode,
} from "./graph-layout.js";
import { snapGraphCoordinateToGrid } from "./graph-layout-grid.js";
import {
  supportedArchitectureNavigationForNode as supportedArchitectureNavigationForGraphNode,
  supportedArchitectureRoomIdForNode as supportedArchitectureRoomIdForGraphNode,
} from "./graph-architecture-drilldown.js";
import { graphProjectionRoomEntryTargetId } from "./graph-navigation.js";
import {
  clearElement,
  renderGraphContent,
} from "./graph-render.js";
import { renderGraphStatusPanel } from "./graph-router-panel.js";
import {
  GRAPH_PRESENTATION_COMPACT,
  GRAPH_PRESENTATION_EXTENDED,
  graphFitViewportState,
  normalizeGraphPresentationMode,
} from "./graph-view-state.js";
import {
  MEMORY_GRAPH_UTILITY_VERSION,
  MEMORY_GRAPH_UTILITY_VERSION_LABEL,
} from "./graph-version.js";
import {
  ATLAS_SOURCE_CATEGORIES,
  atlasGraphViewOptions,
  atlasSourceCategoryAvailable,
  fetchAtlasGraphForCategory,
  fetchAtlasRouterHealth,
} from "./source-atlas.js";
import { graphActiveChain } from "./graph-active-chain.js";
import {
  GRAPH_DEFAULT_SOURCE_CATEGORY,
  GRAPH_FIT_MAX_ZOOM,
  GRAPH_INITIAL_FIT_PADDING,
  GRAPH_NO_SELECTION_NODE_ID,
  architectureRoomIdFromHash,
  compactText,
  compactValue,
  createButton,
  hashForArchitectureRoom,
  hashForSourceCategory,
  invokeGraphCallback,
  isPlainObject,
  nextZoomStep,
  normalizeEdgeId,
  normalizeNodeId,
  normalizePanelPosition,
  normalizeSourceCategoryId,
  normalizeViewportState,
  optionEnabled,
  readStoredGraphLensState,
  routeModeLabel,
  searchParamValue,
  sourceCategoryFromHash,
  viewModelSelectedEdge,
  viewModelSelectedNode,
  writeStoredGraphLensState,
} from "./graph-controller-utils.js";

const GRAPH_VIEWPORT_MIN_ZOOM = 0.18;
const GRAPH_VIEWPORT_MAX_ZOOM = 2;
const GRAPH_WHEEL_ZOOM_SENSITIVITY = 0.0018;
const GRAPH_WHEEL_LINE_PX = 16;
// Above this combined node/edge/container count, early node visibility outweighs a second DOM pass.
const GRAPH_LAYERED_RENDER_COMPLEXITY_THRESHOLD = 64;

/** Normalizes persisted collapse overrides into category- and room-scoped boolean maps. */
function normalizeContainerCollapseByCategory(value = {}) {
  if (!isPlainObject(value)) return {};
  return Object.entries(value).reduce((buckets, [bucketKey, bucket]) => {
    const key = compactValue(bucketKey);
    if (!key || !isPlainObject(bucket)) return buckets;
    const entries = Object.entries(bucket).reduce((next, [containerId, collapsed]) => {
      const id = normalizeNodeId(containerId);
      if (!id || typeof collapsed !== "boolean") return next;
      next[id] = collapsed;
      return next;
    }, {});
    if (Object.keys(entries).length) buckets[key] = entries;
    return buckets;
  }, {});
}

/** Mounts the complete interactive Graph controller, renderer, provider loading, and persistence surface. */
export function mountGraphIllustration(root, options = {}) {
  if (!root) return null;
  clearElement(root);
  root.classList.add("workspace-graph-root", "website-graph-illustration");
  root.dataset.graphUtilityVersion = MEMORY_GRAPH_UTILITY_VERSION;

  const storedState = readStoredGraphLensState(options?.storageKey);
  const devControlsEnabled = optionEnabled(options?.showDevControls)
    || optionEnabled(root.dataset.graphDevControls)
    || optionEnabled(searchParamValue("devControls"))
    || optionEnabled(searchParamValue("dev"));
  const refreshControlEnabled = optionEnabled(options?.showRefreshControl, devControlsEnabled);
  const routeModeConfig = options?.routeMode
    || root.dataset.graphRouteMode
    || searchParamValue("routeMode")
    || (devControlsEnabled ? storedState?.routeMode : GRAPH_ROUTE_MODE_QUALITY);
  const onSelectionChange = options?.onSelectionChange;
  const onEdgeSelectionChange = options?.onEdgeSelectionChange;
  const onViewportChange = options?.onViewportChange;
  const onLayoutChange = options?.onLayoutChange;

  const sourceControlsEl = document.createElement("div");
  sourceControlsEl.className = "graph-source-toggle";
  sourceControlsEl.setAttribute("role", "group");
  sourceControlsEl.setAttribute("aria-label", "Graph source category");
  sourceControlsEl.hidden = true;
  const sourceButtons = new Map();
  for (const category of ATLAS_SOURCE_CATEGORIES) {
    const button = createButton("graph-source-toggle-button", category.label, {
      "data-source-category": category.id,
    });
    button.hidden = true;
    sourceButtons.set(category.id, button);
    sourceControlsEl.appendChild(button);
  }

  const controlsEl = document.createElement("div");
  controlsEl.className = "graph-presentation-toggle";

  const compactButton = createButton("graph-presentation-toggle-button", "Compact", {
    "data-presentation-mode": GRAPH_PRESENTATION_COMPACT,
  });
  const extendedButton = createButton("graph-presentation-toggle-button", "Extended", {
    "data-presentation-mode": GRAPH_PRESENTATION_EXTENDED,
  });
  controlsEl.append(compactButton, extendedButton);

  const shellEl = document.createElement("div");
  shellEl.className = "workspace-graph-shell";
  const canvasEl = document.createElement("div");
  canvasEl.className = "workspace-graph-canvas";
  const stageEl = document.createElement("div");
  stageEl.className = "workspace-graph-content-stage";
  const contentEl = document.createElement("div");
  contentEl.className = "workspace-graph-content";

  const surfaceToolbarEl = document.createElement("div");
  surfaceToolbarEl.className = "graph-surface-toolbar";
  surfaceToolbarEl.setAttribute("aria-label", "Graph surface controls");
  const fitButton = createButton("graph-surface-tool", "Fit", { "data-graph-action": "fit" });
  const zoomOutButton = createButton("graph-surface-tool", "-", { "data-graph-action": "zoom-out", "aria-label": "Zoom out" });
  const zoomInButton = createButton("graph-surface-tool", "+", { "data-graph-action": "zoom-in", "aria-label": "Zoom in" });
  const focusButton = createButton("graph-surface-tool", "Focus: Off", { "data-graph-action": "focus" });
  const arrangeButton = createButton("graph-surface-tool", "Arrange", { "data-graph-action": "arrange" });
  const refreshButton = refreshControlEnabled
    ? createButton("graph-surface-tool", "Refresh", { "data-graph-action": "refresh" })
    : null;
  const speedButton = devControlsEnabled
    ? createButton("graph-surface-tool", "Speed", {
      "data-graph-action": "speed",
      "aria-label": "Prefer speed",
    })
    : null;
  surfaceToolbarEl.append(
    fitButton,
    zoomOutButton,
    zoomInButton,
    focusButton,
    arrangeButton,
    ...[refreshButton, speedButton].filter(Boolean),
  );

  const infoEl = document.createElement("aside");
  infoEl.className = "graph-info-overlay graph-floating-panel";
  infoEl.setAttribute("aria-label", "Graph info panel");
  infoEl.hidden = true;

  const statusPanelEl = document.createElement("aside");
  statusPanelEl.className = "graph-status-panel graph-floating-panel";
  statusPanelEl.setAttribute("aria-label", "Router health");
  statusPanelEl.hidden = true;

  stageEl.appendChild(contentEl);
  canvasEl.appendChild(stageEl);
  shellEl.appendChild(canvasEl);
  root.append(sourceControlsEl, controlsEl, shellEl, surfaceToolbarEl, statusPanelEl, infoEl);

  const initialHashCategory = typeof window !== "undefined" ? sourceCategoryFromHash(window.location.hash) : "";
  const initialHashArchitectureRoomId = initialHashCategory === "architecture" && typeof window !== "undefined"
    ? architectureRoomIdFromHash(window.location.hash)
    : "";
  let activeSourceCategory = normalizeSourceCategoryId(
    options?.sourceCategory
      || initialHashCategory
      || storedState?.sourceCategory,
  );
  let activeArchitectureRoomId = normalizeNodeId(
    options?.currentArchitectureRoom
      || options?.architectureRoomId
      || (activeSourceCategory === "architecture" ? initialHashArchitectureRoomId : "")
      || (!initialHashCategory && activeSourceCategory === "architecture" ? storedState?.architectureRoomId : "")
      || "",
  );
  let activePresentationMode = normalizeGraphPresentationMode(options?.presentationMode || storedState?.presentationMode);
  let activeRouteMode = normalizeGraphRouteMode(routeModeConfig);
  let selectedNodeId = normalizeNodeId(
    Object.prototype.hasOwnProperty.call(options, "selectedNodeId")
      ? options.selectedNodeId
      : GRAPH_NO_SELECTION_NODE_ID,
  );
  let selectedEdgeId = normalizeEdgeId(
    Object.prototype.hasOwnProperty.call(options, "selectedEdgeId")
      ? options.selectedEdgeId
      : "",
  );
  let activeViewModel = null;
  let activeViewModelSignature = "";
  let viewport = normalizeViewportState(options?.viewport || storedState?.viewport);
  let viewportMode = viewport ? "manual" : "fit";
  let infoOpen = false;
  let focusModeActive = Boolean(options?.focusModeActive || storedState?.focusModeActive);
  let liveMemoryGraph = null;
  let pendingArchitectureRoomAuthorization = "";
  let liveProjectionRevision = 0;
  let liveProjectionStatus = "waiting for Atlas source";
  let liveProjectionError = "";
  let liveProjectionRequestId = 0;
  let layoutRevision = 0;
  let graphLayout = isPlainObject(options?.graphLayout)
    ? options.graphLayout
    : isPlainObject(storedState?.graphLayout)
      ? storedState.graphLayout
      : {};
  let containerCollapseByCategory = normalizeContainerCollapseByCategory(
    isPlainObject(options?.containerCollapseByCategory)
      ? options.containerCollapseByCategory
      : storedState?.containerCollapseByCategory,
  );
  let panelDragState = null;
  let panelPosition = normalizePanelPosition(options?.panelPosition || storedState?.panelPosition);
  let statusPanelDragState = null;
  let statusPanelOpen = options?.statusPanelOpen !== false && storedState?.statusPanelOpen !== false;
  let statusPanelPosition = normalizePanelPosition(options?.statusPanelPosition || storedState?.statusPanelPosition);
  let routerHealth = null;
  let routerHealthStatus = "loading";
  let routerHealthError = "";
  let routerHealthRequestId = 0;
  let routerDocument = {
    open: false,
    title: "",
    href: "",
    status: "idle",
    text: "",
    error: "",
  };
  let routerDocumentRequestId = 0;
  let nodeDragState = null;
  let viewportPanState = null;
  let viewportPersistTimer = 0;
  let pendingArchitectureNavigationSelectionTimer = 0;
  let suppressNextClickNodeId = "";
  let suppressNextCanvasClick = false;
  let resizeObserver = null;
  let activeRenderFrame = null;
  const viewModelCache = new Map();
  const liveProjectionCache = new Map();
  const sourceAvailabilityById = new Map(
    ATLAS_SOURCE_CATEGORIES.map((category) => [category.id, "unknown"]),
  );
  let sourceAvailabilityScanStatus = "idle";
  let sourceAvailabilityScanPromise = null;
  const managesDocumentTitle = options?.manageDocumentTitle !== false
    && root.id === "graph-illustration-root";

  /** Converts provider repository identity into the instance name used by the browser shell. */
  const repositoryTitleLabel = (projection = {}) => {
    const metadata = isPlainObject(projection?.metadata) ? projection.metadata : {};
    const authority = compactValue(projection?.authority);
    const raw = compactValue(
      metadata.repositoryLabel
        || metadata.repositoryId
        || (authority.toLowerCase() === "atlas" ? "" : authority),
    );
    if (!raw) return "";
    const words = raw.replace(/[-_.]+/g, " ").replace(/\s+/g, " ").trim();
    return words.replace(/\b\p{L}/gu, (character) => character.toUpperCase());
  };

  /** Keeps a standalone Graph page named after the repository whose Atlas instance it renders. */
  const syncDocumentTitle = (projection = {}) => {
    if (!managesDocumentTitle || typeof document === "undefined") return;
    const repositoryLabel = repositoryTitleLabel(projection);
    if (repositoryLabel) document.title = `${repositoryLabel} Atlas`;
  };

  /** Returns the metadata record for the controller's active source category. */
  const currentSourceCategory = () =>
    ATLAS_SOURCE_CATEGORIES.find((category) => category.id === activeSourceCategory)
    || ATLAS_SOURCE_CATEGORIES.find((category) => category.id === GRAPH_DEFAULT_SOURCE_CATEGORY)
    || ATLAS_SOURCE_CATEGORIES[0];

  /** Builds the persistence key separating architecture overview and individual room layouts. */
  const currentGraphLayoutKey = () => activeSourceCategory === "architecture" && activeArchitectureRoomId
    ? `architecture:${activeArchitectureRoomId}`
    : activeSourceCategory;

  /** Builds the in-memory cache key for one category and optional architecture room. */
  const projectionCacheKeyFor = (categoryId = activeSourceCategory, architectureRoomId = activeArchitectureRoomId) => {
    const sourceCategory = normalizeSourceCategoryId(categoryId);
    const roomId = sourceCategory === "architecture" ? normalizeNodeId(architectureRoomId || "") : "";
    return sourceCategory === "architecture" && roomId ? `architecture:${roomId}` : sourceCategory;
  };

  /** Returns the last fetched projection for one exact category and room identity. */
  const cachedProjectionFor = (categoryId = activeSourceCategory, architectureRoomId = activeArchitectureRoomId) =>
    liveProjectionCache.get(projectionCacheKeyFor(categoryId, architectureRoomId)) || null;

  /** Records a valid projection under its exact source-category and room cache key. */
  const rememberProjection = (projection, categoryId = activeSourceCategory, architectureRoomId = activeArchitectureRoomId) => {
    if (!projection || !Array.isArray(projection.nodes) || !Array.isArray(projection.edges)) return;
    const sourceCategory = normalizeSourceCategoryId(categoryId);
    liveProjectionCache.set(projectionCacheKeyFor(sourceCategory, architectureRoomId), projection);
    sourceAvailabilityById.set(
      sourceCategory,
      atlasSourceCategoryAvailable(projection) ? "available" : "unavailable",
    );
    if (sourceCategory === "architecture") syncDocumentTitle(projection);
  };

  /** Checks whether a provider response explicitly reports an unavailable requested room. */
  const projectionUnavailableForArchitectureRoom = (projection, categoryId, architectureRoomId) => {
    if (normalizeSourceCategoryId(categoryId) !== "architecture" || !normalizeNodeId(architectureRoomId)) return false;
    const mode = compactValue(projection?.metadata?.architectureProjectionMode).toLowerCase();
    if (mode === "unavailable") return true;
    return Array.isArray(projection?.nodes)
      && Array.isArray(projection?.edges)
      && projection.nodes.length === 0
      && projection.edges.length === 0;
  };

  /** Fetches one category/room projection through the injected or default Atlas provider boundary. */
  const fetchLiveProjectionFor = async (categoryId, architectureRoomId = "", fetchOptions = {}) => {
    const sourceCategory = normalizeSourceCategoryId(categoryId);
    const category = ATLAS_SOURCE_CATEGORIES.find((candidate) => candidate.id === sourceCategory)
      || currentSourceCategory();
    if (typeof options?.provider === "function") {
      return options.provider({
        sourceCategory,
        category,
        presentationMode: activePresentationMode,
        currentArchitectureRoom: architectureRoomId,
        capabilityProbe: fetchOptions.capabilityProbe === true,
      });
    }
    return fetchAtlasGraphForCategory(sourceCategory, {
      presentationMode: activePresentationMode,
      currentArchitectureRoom: architectureRoomId,
      precompute: fetchOptions.precompute,
    });
  };

  /** Replaces a matching room hash with setup after provider navigation validation fails. */
  const replaceRejectedArchitectureRoomHash = (roomId) => {
    if (typeof window === "undefined") return;
    const hashCategory = sourceCategoryFromHash(window.location.hash);
    const hashRoomId = architectureRoomIdFromHash(window.location.hash);
    if (hashCategory === "architecture" && hashRoomId === normalizeNodeId(roomId)) {
      window.history.replaceState(null, "", hashForSourceCategory("architecture"));
    }
  };

  /** Returns the persisted manual node-position bucket for the active graph identity. */
  const currentGraphLayoutBucket = () => {
    const buckets = isPlainObject(graphLayout?.nodePositionsByCategory)
      ? graphLayout.nodePositionsByCategory
      : {};
    const bucket = buckets[currentGraphLayoutKey()];
    return isPlainObject(bucket) ? bucket : {};
  };

  /** Checks whether the active graph has any persisted manual node coordinates. */
  const graphHasManualLayout = () => Object.keys(currentGraphLayoutBucket()).length > 0;

  /** Returns the persisted container-collapse bucket for the active graph identity. */
  const currentContainerCollapseBucket = () => {
    const bucket = containerCollapseByCategory[currentGraphLayoutKey()];
    return isPlainObject(bucket) ? bucket : {};
  };

  /** Checks whether the active graph has explicit container expansion or collapse choices. */
  const graphHasContainerCollapseOverrides = () => Object.keys(currentContainerCollapseBucket()).length > 0;

  /** Resolves provider-authored presentation and route options for the active projection. */
  const activeAtlasGraphViewOptions = () => {
    const viewOptions = atlasGraphViewOptions(liveMemoryGraph);
    const bucket = currentContainerCollapseBucket();
    if (!Object.keys(bucket).length) return viewOptions;
    const containers = (Array.isArray(viewOptions.containers) ? viewOptions.containers : [])
      .map((container) => {
        const containerId = normalizeNodeId(container?.id);
        if (!containerId || !Object.prototype.hasOwnProperty.call(bucket, containerId)) return container;
        const collapsed = bucket[containerId] === true;
        return {
          ...container,
          collapsed,
          renderAsNode: collapsed,
        };
      });
    return { ...viewOptions, containers };
  };

  /**
   * Selects bounded routing for interactive geometry overrides. Manual moves
   * and container collapse both invalidate provider-precomputed geometry; they
   * must not re-enter the slower quality route search on the input event path.
   */
  const effectiveRouteMode = () => graphHasManualLayout() || graphHasContainerCollapseOverrides()
    ? GRAPH_ROUTE_MODE_SPEED
    : activeRouteMode;

  /** Merges and writes controller preferences without discarding other persisted lens fields. */
  const persistGraphLensState = (patch = {}) => {
    writeStoredGraphLensState(options?.storageKey, {
      sourceCategory: activeSourceCategory,
      architectureRoomId: activeArchitectureRoomId,
      presentationMode: activePresentationMode,
      routeMode: activeRouteMode,
      selectedNodeId,
      selectedEdgeId,
      viewport,
      viewportMode,
      infoOpen,
      focusModeActive,
      graphLayout,
      containerCollapseByCategory,
      panelPosition,
      statusPanelOpen,
      statusPanelPosition,
      ...patch,
    });
  };

  /** Persists the active category's zoom and pan offsets after viewport interaction settles. */
  const persistViewport = () => {
    persistGraphLensState();
    invokeGraphCallback(onViewportChange, {
      sourceCategory: activeSourceCategory,
      viewport,
      viewportMode,
    }, root, "memory-graph-viewport-change");
  };

  /** Persists current graph node positions and container-collapse overrides by graph identity. */
  const persistLayout = () => {
    persistGraphLensState();
    invokeGraphCallback(onLayoutChange, {
      sourceCategory: activeSourceCategory,
      architectureRoomId: activeArchitectureRoomId,
      graphLayout,
      nodePositions: currentGraphLayoutBucket(),
    }, root, "memory-graph-layout-change");
  };

  /** Serializes render-relevant controller state to detect when full view-model rebuilding is necessary. */
  const currentSignature = () => JSON.stringify({
    sourceCategory: activeSourceCategory,
    architectureRoomId: activeArchitectureRoomId,
    presentationMode: activePresentationMode,
    routeMode: effectiveRouteMode(),
    liveProjectionRevision,
    layoutRevision,
    containerCollapse: JSON.stringify(currentContainerCollapseBucket()),
  });

  /** Cancels any scheduled complete redraw before a newer controller state supersedes it. */
  const cancelDeferredRender = () => {
    if (!activeRenderFrame) return;
    if (activeRenderFrame.raf && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(activeRenderFrame.raf);
    }
    if (activeRenderFrame.timeout) {
      clearTimeout(activeRenderFrame.timeout);
    }
    activeRenderFrame = null;
  };

  /** Merges render options and injects the active room id used to reject self-navigation markers. */
  const graphRenderOptions = (options = {}) => ({
    ...options,
    currentRoomId: normalizeNodeId(
      activeArchitectureRoomId || liveMemoryGraph?.metadata?.currentArchitectureRoomId || "",
    ),
  });

  /** Schedules low-priority container and marker layers after fast primary rendering. */
  const scheduleCompleteRender = (viewModel) => {
    cancelDeferredRender();
    const frame = { raf: 0, timeout: 0, done: false };
    /** Runs the deferred complete render only if its frame and view model remain current. */
    const callback = () => {
      if (frame.done) return;
      frame.done = true;
      if (frame.timeout) clearTimeout(frame.timeout);
      if (frame.raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame.raf);
      if (activeRenderFrame === frame) activeRenderFrame = null;
      if (viewModel !== activeViewModel) return;
      renderGraphContent(contentEl, viewModel, graphRenderOptions({
        layerMode: "complete",
      }));
      syncActiveSelectionClasses();
    };
    if (typeof requestAnimationFrame === "function") {
      frame.raf = requestAnimationFrame(callback);
    }
    frame.timeout = setTimeout(callback, 80);
    activeRenderFrame = frame;
  };

  /** Counts DOM-bearing model elements to choose one-pass or layered rendering. */
  const graphRenderComplexity = (viewModel) => [
    viewModel?.nodes,
    viewModel?.edges,
    viewModel?.containers,
  ].reduce((total, collection) => total + (Array.isArray(collection) ? collection.length : 0), 0);

  /** Renders small projections once and reserves layered rendering for heavy graphs. */
  const renderActiveViewModel = (viewModel) => {
    if (viewModel?.empty) {
      cancelDeferredRender();
      renderGraphContent(contentEl, viewModel, graphRenderOptions({ layerMode: "complete" }));
      return;
    }
    if (graphRenderComplexity(viewModel) <= GRAPH_LAYERED_RENDER_COMPLEXITY_THRESHOLD) {
      cancelDeferredRender();
      renderGraphContent(contentEl, viewModel, graphRenderOptions({ layerMode: "complete" }));
      return;
    }
    renderGraphContent(contentEl, viewModel, graphRenderOptions({
      layerMode: "stable",
      layers: ["grid", "containers", "nodes"],
    }));
    scheduleCompleteRender(viewModel);
  };

  /** Reuses a matching view model or rebuilds it from active projection and controller state. */
  const ensureViewModel = () => {
    const signature = currentSignature();
    if (signature === activeViewModelSignature && activeViewModel) return activeViewModel;
    activeViewModelSignature = signature;
    if (!viewModelCache.has(signature)) {
      viewModelCache.set(signature, buildIllustrationGraphViewModel({
        presentationMode: activePresentationMode,
        selectedNodeId: GRAPH_NO_SELECTION_NODE_ID,
        memoryGraph: liveMemoryGraph,
        routeMode: effectiveRouteMode(),
        nodePositions: currentGraphLayoutBucket(),
        disablePrecomputed: graphHasContainerCollapseOverrides(),
        ...activeAtlasGraphViewOptions(),
      }));
    }
    activeViewModel = viewModelCache.get(signature);
    applySelectionStateToActiveViewModel();
    renderActiveViewModel(activeViewModel);
    return activeViewModel;
  };

  /** Synchronizes source-category controls, accessible labels, and active selection state. */
  const syncSourceControls = () => {
    root.dataset.sourceCategory = activeSourceCategory;
    root.dataset.architectureProjectionMode = activeSourceCategory === "architecture"
      ? compactValue(liveMemoryGraph?.metadata?.architectureProjectionMode, "repository-setup")
      : "";
    root.dataset.architectureRoomId = activeSourceCategory === "architecture"
      ? activeArchitectureRoomId
      : "";
    root.dataset.architectureProjectionSource = activeSourceCategory === "architecture"
      ? compactValue(liveMemoryGraph?.metadata?.architectureProjectionSource)
      : "";
    const availableCategories = ATLAS_SOURCE_CATEGORIES
      .filter((category) => sourceAvailabilityById.get(category.id) === "available")
      .map((category) => category.id);
    root.dataset.availableSourceCategories = availableCategories.join(",");
    root.dataset.sourceCategoryAvailability = sourceAvailabilityScanStatus;
    for (const [categoryId, button] of sourceButtons.entries()) {
      const pressed = categoryId === activeSourceCategory;
      button.hidden = sourceAvailabilityById.get(categoryId) !== "available";
      button.classList.toggle("is-active", pressed);
      button.setAttribute("aria-pressed", pressed ? "true" : "false");
    }
    // One source has no meaningful source-selection choice, so the shell omits
    // the entire segmented control instead of leaving one decorative tab.
    sourceControlsEl.hidden = availableCategories.length <= 1;
  };

  /** Synchronizes overview and inspect controls with the active presentation mode. */
  const syncPresentationControls = () => {
    root.dataset.graphPresentationMode = activePresentationMode;
    for (const button of [compactButton, extendedButton]) {
      const pressed = button.dataset.presentationMode === activePresentationMode;
      button.classList.toggle("is-active", pressed);
      button.setAttribute("aria-pressed", pressed ? "true" : "false");
    }
  };

  /** Applies selected-edge classes to SVG paths, labels, and arrowheads without rerouting. */
  const syncSelectedEdgeClass = () => {
    const normalizedEdgeId = normalizeEdgeId(selectedEdgeId);
    contentEl.querySelectorAll("[data-edge-id]").forEach((edgeEl) => {
      edgeEl.classList.toggle("is-selected", Boolean(normalizedEdgeId && edgeEl.dataset.edgeId === normalizedEdgeId));
    });
  };

  /** Returns the normalized node identity currently selected by the controller. */
  const selectedNodeKey = () => {
    const normalized = normalizeNodeId(selectedNodeId);
    return normalized && normalized !== GRAPH_NO_SELECTION_NODE_ID ? normalized : "";
  };

  /** Recomputes selected and active-chain flags directly on current nodes, edges, and markers. */
  const applySelectionStateToActiveViewModel = () => {
    if (!activeViewModel || !Array.isArray(activeViewModel.nodes)) return activeViewModel;
    const normalizedSelectedNodeId = selectedNodeKey();
    const selectedNodes = activeViewModel.nodes.map((node) => ({
      ...node,
      selected: Boolean(normalizedSelectedNodeId && normalizeNodeId(node.id) === normalizedSelectedNodeId),
    }));
    const activeChain = graphActiveChain(selectedNodes, activeViewModel.edges || []);
    const activeEdgeIds = activeChain.activeEdgeIds;
    activeViewModel.nodes = selectedNodes.map((node) => ({
      ...node,
      activeChain: activeChain.activeNodeIds.has(normalizeNodeId(node.id)),
      connectionMarkers: (Array.isArray(node.connectionMarkers) ? node.connectionMarkers : []).map((marker) => ({
        ...marker,
        activeChain: activeEdgeIds.has(normalizeEdgeId(marker.edgeId)),
      })),
    }));
    activeViewModel.edges = (Array.isArray(activeViewModel.edges) ? activeViewModel.edges : []).map((edge) => {
      const active = activeEdgeIds.has(normalizeEdgeId(edge.id));
      const transportStateText = active
        ? "PLAYING"
        : String(edge.transportStateText || "") === "PLAYING"
          ? ""
          : edge.transportStateText;
      return {
        ...edge,
        activeChain: active,
        transportStateText,
      };
    });
    return activeViewModel;
  };

  /** Synchronizes DOM selection, active-chain, signal-flow, and focus classes from the view model. */
  const syncActiveSelectionClasses = () => {
    if (!activeViewModel) {
      syncSelectedEdgeClass();
      return;
    }
    const normalizedSelectedNodeId = selectedNodeKey();
    const normalizedSelectedEdgeId = normalizeEdgeId(selectedEdgeId);
    const activeNodeIds = new Set((Array.isArray(activeViewModel.nodes) ? activeViewModel.nodes : [])
      .filter((node) => node.activeChain === true)
      .map((node) => normalizeNodeId(node.id)));
    const activeEdgeIds = new Set((Array.isArray(activeViewModel.edges) ? activeViewModel.edges : [])
      .filter((edge) => edge.activeChain === true)
      .map((edge) => normalizeEdgeId(edge.id)));

    contentEl.querySelectorAll(".workspace-graph-node").forEach((nodeEl) => {
      const nodeId = normalizeNodeId(nodeEl.dataset.nodeId);
      nodeEl.classList.toggle("is-selected", Boolean(normalizedSelectedNodeId && nodeId === normalizedSelectedNodeId));
      nodeEl.classList.toggle("is-active-chain", activeNodeIds.has(nodeId));
    });
    contentEl.querySelectorAll("[data-edge-id]").forEach((edgeEl) => {
      const edgeId = normalizeEdgeId(edgeEl.dataset.edgeId);
      const active = activeEdgeIds.has(edgeId);
      edgeEl.classList.toggle("is-active-chain", active);
      edgeEl.classList.toggle("is-selected", Boolean(normalizedSelectedEdgeId && edgeId === normalizedSelectedEdgeId));
      if (active) {
        edgeEl.dataset.transportState = "PLAYING";
      } else if (edgeEl.dataset.transportState === "PLAYING") {
        delete edgeEl.dataset.transportState;
      }
    });
  };

  /** Updates selection-dependent DOM and panels without rebuilding geometry or route paths. */
  const applyFastSelectionState = () => {
    if (!activeViewModel) {
      ensureViewModel();
    } else {
      applySelectionStateToActiveViewModel();
    }
    syncActiveSelectionClasses();
    syncSurfaceControls();
    updateStatusPanel();
    updateInfoOverlay();
  };

  /** Removes trailing toolbar divider styling from the last visible action control. */
  const syncSurfaceToolbarDividers = () => {
    const tools = [...surfaceToolbarEl.querySelectorAll(".graph-surface-tool")];
    const visibleTools = tools.filter((button) => !button.hidden);
    const lastVisibleTool = visibleTools[visibleTools.length - 1] || null;
    tools.forEach((button) => {
      button.classList.toggle("is-last-visible", button === lastVisibleTool);
    });
  };

  /** Synchronizes toolbar visibility, disablement, labels, and focus state across Graph modes. */
  const syncSurfaceControls = () => {
    const selectedNode = activeViewModel ? viewModelSelectedNode(activeViewModel, selectedNodeId) : null;
    if (!selectedNode) focusModeActive = false;
    const focusAvailable = Boolean(selectedNode);
    const signalFlowAvailable = focusAvailable && (activeViewModel?.edges || []).some((edge) => edge.activeChain === true);
    root.classList.toggle("is-focus-mode", focusAvailable && focusModeActive);
    root.classList.toggle("has-signal-flow", signalFlowAvailable);
    root.dataset.graphFocusMode = focusAvailable && focusModeActive ? "chain" : "all";
    root.dataset.graphSignalFlow = signalFlowAvailable ? "selected" : "none";
    focusButton.hidden = !focusAvailable;
    focusButton.disabled = !focusAvailable;
    focusButton.textContent = focusModeActive ? "Focus: On" : "Focus: Off";
    focusButton.classList.toggle("is-active", focusAvailable && focusModeActive);
    focusButton.setAttribute("aria-pressed", focusAvailable && focusModeActive ? "true" : "false");
    arrangeButton.hidden = !graphHasManualLayout();
    if (refreshButton) {
      refreshButton.disabled = liveProjectionStatus === "loading";
      refreshButton.classList.toggle("is-active", liveProjectionStatus === "loading");
    }
    if (speedButton) {
      speedButton.classList.toggle("is-active", activeRouteMode === GRAPH_ROUTE_MODE_SPEED);
      speedButton.setAttribute("aria-pressed", activeRouteMode === GRAPH_ROUTE_MODE_SPEED ? "true" : "false");
    }
    syncSurfaceToolbarDividers();
  };

  /** Applies the persisted information-overlay position while clamping it inside the viewport. */
  const applyPanelPosition = () => {
    if (!panelPosition) {
      infoEl.style.left = "";
      infoEl.style.top = "";
      infoEl.style.right = "";
      infoEl.style.bottom = "";
      return;
    }
    infoEl.style.left = `${Math.max(0, Math.round(panelPosition.left))}px`;
    infoEl.style.top = `${Math.max(0, Math.round(panelPosition.top))}px`;
    infoEl.style.right = "auto";
    infoEl.style.bottom = "auto";
  };

  /** Applies the persisted status-panel position while keeping its header reachable. */
  const applyStatusPanelPosition = () => {
    if (!statusPanelPosition) {
      statusPanelEl.style.left = "";
      statusPanelEl.style.top = "";
      statusPanelEl.style.right = "";
      statusPanelEl.style.bottom = "";
      return;
    }
    statusPanelEl.style.left = `${Math.max(0, Math.round(statusPanelPosition.left))}px`;
    statusPanelEl.style.top = `${Math.max(0, Math.round(statusPanelPosition.top))}px`;
    statusPanelEl.style.right = "auto";
    statusPanelEl.style.bottom = "auto";
  };

  /** Appends non-empty label-value rows to the illustration information overlay. */
  const appendRouterDetailList = (parent, rows = []) => {
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
  };

  /** Returns architecture Atlas metadata only when the active category owns it. */
  const architectureAtlasPacket = () => {
    const packet = liveMemoryGraph?.metadata?.architectureAtlas;
    return isPlainObject(packet) ? packet : null;
  };

  /** Resolves the current architecture Atlas status from projection or nested metadata. */
  const architectureAtlasStatus = () => compactValue(
    liveMemoryGraph?.metadata?.architectureAtlasStatus,
    architectureAtlasPacket() ? "live" : "unavailable",
  );

  /** Returns the provider's current architecture Atlas error text when present. */
  const architectureAtlasError = () => compactValue(liveMemoryGraph?.metadata?.architectureAtlasError);

  /** Checks whether Atlas routing status belongs on the current architecture surface. */
  const architectureAtlasIsRelevant = () =>
    activeSourceCategory === "architecture" || Boolean(architectureAtlasPacket()) || Boolean(architectureAtlasError());

  /** Resolves whether architecture is showing repository setup, room detail, or another mode. */
  const architectureProjectionMode = () => compactValue(
    liveMemoryGraph?.metadata?.architectureProjectionMode,
    activeArchitectureRoomId ? "room" : "repository-setup",
  );

  /** Resolves the active architecture room identity from controller and projection metadata. */
  const currentArchitectureRoomId = () => normalizeNodeId(
    activeArchitectureRoomId
      || liveMemoryGraph?.metadata?.currentArchitectureRoomId
      || "",
  );

  /** Resolves a drilldown room from one node within the current projection boundary. */
  const supportedArchitectureRoomIdForNode = (node = {}) => {
    return supportedArchitectureRoomIdForGraphNode(node, {
      sourceCategory: activeSourceCategory,
      architectureRoomId: currentArchitectureRoomId(),
    });
  };

  /** Resolves room entry or repository-overview return from the active projection only. */
  const supportedArchitectureNavigationForNode = (node = {}) => {
    return supportedArchitectureNavigationForGraphNode(node, {
      sourceCategory: activeSourceCategory,
      architectureRoomId: currentArchitectureRoomId(),
    });
  };

  /**
   * Validates one rendered Router request against current provider authority at
   * click time. Ranked actions must resolve to a live Atlas candidate and
   * selection actions to the selected semantic-room node; copied or stale DOM
   * data returns no room id, preserving provider ownership of navigation.
   */
  const validatedRouterActionRoomId = (actionButton) => {
    const requestedRoomId = normalizeNodeId(actionButton?.dataset?.architectureRoomId);
    if (!requestedRoomId) return "";
    const context = compactValue(actionButton?.dataset?.routerActionContext);
    if (context === "atlas-route-candidate") {
      const candidates = Array.isArray(architectureAtlasPacket()?.plan?.candidates)
        ? architectureAtlasPacket().plan.candidates
        : [];
      const candidate = candidates.find((item) =>
        normalizeNodeId(item?.roomId) === requestedRoomId
      );
      return supportedArchitectureRoomIdForNode(candidate) === requestedRoomId
        ? requestedRoomId
        : "";
    }
    const selectedNode = activeViewModel
      ? viewModelSelectedNode(activeViewModel, selectedNodeId)
      : null;
    return supportedArchitectureRoomIdForNode(selectedNode) === requestedRoomId
      ? requestedRoomId
      : "";
  };

  /** Re-renders selection, Atlas route, and router health state in the floating status panel. */
  const updateStatusPanel = () => {
    const selectedNode = activeViewModel ? viewModelSelectedNode(activeViewModel, selectedNodeId) : null;
    const selectedEdge = !selectedNode && activeViewModel ? viewModelSelectedEdge(activeViewModel, selectedEdgeId) : null;
    renderGraphStatusPanel({
      statusPanelEl,
      statusPanelOpen,
      routerDocument,
      routerHealth,
      routerHealthStatus,
      routerHealthError,
      selectedNode,
      selectedEdge,
      architecture: {
        relevant: architectureAtlasIsRelevant(),
        packet: architectureAtlasPacket(),
        status: architectureAtlasStatus(),
        error: architectureAtlasError(),
        projectionMode: architectureProjectionMode(),
        roomId: currentArchitectureRoomId(),
        supportedArchitectureRoomIdForNode,
        supportedArchitectureNavigationForNode,
      },
      supportedArchitectureRoomIdForNode,
      supportedArchitectureNavigationForNode,
    });
    applyStatusPanelPosition();
  };

  /** Rebuilds the compact source, selection, routing, and viewport information overlay. */
  const updateInfoOverlay = () => {
    if (!infoOpen || !activeViewModel) {
      infoEl.hidden = true;
      return;
    }
    const selectedNode = viewModelSelectedNode(activeViewModel, selectedNodeId);
    const selectedRows = selectedNode
      ? [
        ["selected", selectedNode.label],
        ["kind", selectedNode.memoryKind || selectedNode.kind],
        ["layer", selectedNode.layer],
        ["source", selectedNode.source],
      ]
      : [["selected", "none"]];
    infoEl.hidden = false;
    infoEl.replaceChildren();

    const titleEl = document.createElement("h2");
    titleEl.textContent = MEMORY_GRAPH_UTILITY_VERSION_LABEL;
    const closeButton = createButton("graph-info-close", "close", { "aria-label": "Close info" });
    const headerEl = document.createElement("header");
    headerEl.className = "graph-info-header";
    headerEl.dataset.panelDragHandle = "true";
    headerEl.append(titleEl, closeButton);

    const bodyEl = document.createElement("dl");
    bodyEl.className = "graph-info-list";
    [
      ["source category", currentSourceCategory()?.label || activeSourceCategory],
      ["source", currentSourceCategory()?.endpoint || ""],
      ["routing", activeViewModel.routeBudget === "preview"
        ? `${routeModeLabel(effectiveRouteMode())} / preview`
        : routeModeLabel(effectiveRouteMode())],
      ["projection", liveProjectionError ? `${liveProjectionStatus}: ${liveProjectionError}` : liveProjectionStatus],
      liveMemoryGraph?.authority
        ? ["authority", liveMemoryGraph.authority]
        : null,
      liveMemoryGraph?.view
        ? ["view", liveMemoryGraph.view]
        : null,
      ["presentation", activePresentationMode],
      ["nodes", activeViewModel.nodes.length],
      ["edges", activeViewModel.edges.length],
      ["containers", activeViewModel.containers.length],
      ["zoom", `${Math.round((viewport?.zoom || 1) * 100)}%`],
      selectedEdgeId ? ["selected edge", selectedEdgeId] : null,
      ...selectedRows,
    ].filter(Boolean).forEach(([term, detail]) => {
      if (detail === undefined || detail === null || detail === "") return;
      const termEl = document.createElement("dt");
      termEl.textContent = String(term);
      const detailEl = document.createElement("dd");
      detailEl.textContent = String(detail);
      bodyEl.append(termEl, detailEl);
    });

    infoEl.append(headerEl, bodyEl);
    applyPanelPosition();
    closeButton.addEventListener("click", () => {
      infoOpen = false;
      syncSurfaceControls();
      updateInfoOverlay();
      persistGraphLensState();
    }, { once: true });
  };

  /** Computes and stores a fit-to-content viewport for the supplied or active view model. */
  const fitViewport = (viewModel = activeViewModel) => {
    const rect = canvasEl.getBoundingClientRect();
    return graphFitViewportState(viewModel, rect, {
      padding: GRAPH_INITIAL_FIT_PADDING,
      maxZoom: GRAPH_FIT_MAX_ZOOM,
    });
  };

  /** Applies viewport transforms and updates the DOM evidence consumed by controls and audits. */
  const applyViewport = (settings = {}) => {
    const viewModel = ensureViewModel();
    const rect = canvasEl.getBoundingClientRect();
    contentEl.style.width = `${viewModel.width}px`;
    contentEl.style.height = `${viewModel.height}px`;
    if (!viewport || viewportMode === "fit") viewport = fitViewport(viewModel);
    const zoom = Math.max(0.001, Number(viewport?.zoom) || 1);
    const offsetX = Number(viewport?.offsetX) || 0;
    const offsetY = Number(viewport?.offsetY) || 0;
    const stageWidth = Math.max(
      1,
      rect.width || 0,
      viewModel.width * zoom,
    );
    const stageHeight = Math.max(
      1,
      rect.height || 0,
      viewModel.height * zoom,
    );
    stageEl.style.width = `${Math.ceil(stageWidth)}px`;
    stageEl.style.height = `${Math.ceil(stageHeight)}px`;
    stageEl.dataset.viewportPadLeft = "0";
    stageEl.dataset.viewportPadTop = "0";
    root.dataset.graphViewportMode = viewportMode;
    root.dataset.graphViewportZoom = String(Math.round(zoom * 1000) / 1000);
    root.dataset.graphViewportOffsetX = String(Math.round(offsetX));
    root.dataset.graphViewportOffsetY = String(Math.round(offsetY));
    root.dataset.graphRouteMode = effectiveRouteMode();
    root.dataset.graphRouteBudget = String(viewModel?.routeBudget || "");
    contentEl.style.left = "0px";
    contentEl.style.top = "0px";
    contentEl.style.transform = `translate(${viewport.offsetX}px, ${viewport.offsetY}px) scale(${viewport.zoom})`;
    syncSourceControls();
    syncPresentationControls();
    syncSurfaceControls();
    if (settings?.updatePanels !== false) {
      updateStatusPanel();
      updateInfoOverlay();
    }
  };

  /** Fits the active graph to the canvas and records a user-requested viewport state. */
  const fitGraph = () => {
    viewportMode = "fit";
    viewport = fitViewport(ensureViewModel());
    applyViewport();
    persistViewport();
  };

  /** Moves to the next discrete zoom step around the canvas center. */
  const zoomGraph = (direction) => {
    const viewModel = ensureViewModel();
    if (!viewport) viewport = fitViewport(viewModel);
    const rect = canvasEl.getBoundingClientRect();
    const currentZoom = Number(viewport.zoom) || 1;
    const nextZoom = nextZoomStep(currentZoom, direction);
    const centerX = (rect.width / 2 - viewport.offsetX) / currentZoom;
    const centerY = (rect.height / 2 - viewport.offsetY) / currentZoom;
    viewport = {
      zoom: nextZoom,
      offsetX: Math.round(rect.width / 2 - centerX * nextZoom),
      offsetY: Math.round(rect.height / 2 - centerY * nextZoom),
    };
    viewportMode = "manual";
    applyViewport();
    persistViewport();
  };

  /** Centers the viewport on the currently selected visible node without changing zoom. */
  const centerSelectedNode = () => {
    const viewModel = ensureViewModel();
    const node = viewModelSelectedNode(viewModel, selectedNodeId);
    if (!node) return;
    if (!viewport) viewport = fitViewport(viewModel);
    const rect = canvasEl.getBoundingClientRect();
    const zoom = Number(viewport.zoom) || 1;
    const centerX = Number(node.x || 0) + Number(node.width || 0) / 2;
    const centerY = Number(node.y || 0) + Number(node.height || 0) / 2;
    viewport = {
      zoom,
      offsetX: Math.round(rect.width / 2 - centerX * zoom),
      offsetY: Math.round(rect.height / 2 - centerY * zoom),
    };
    viewportMode = "manual";
    applyViewport();
    persistViewport();
  };

  /** Clamps interactive zoom to the controller's minimum and maximum whiteboard limits. */
  const clampViewportZoom = (value) => Math.min(
    GRAPH_VIEWPORT_MAX_ZOOM,
    Math.max(GRAPH_VIEWPORT_MIN_ZOOM, Number(value) || 1),
  );

  /** Converts wheel delta units to consistent pixels across browser line and page modes. */
  const wheelDeltaPixels = (event) => {
    const unit = event.deltaMode === 1
      ? GRAPH_WHEEL_LINE_PX
      : event.deltaMode === 2
        ? Math.max(1, Number(canvasEl.getBoundingClientRect().height || window.innerHeight || 1))
        : 1;
    return {
      x: Number(event.deltaX || 0) * unit,
      y: Number(event.deltaY || 0) * unit,
    };
  };

  /** Debounces viewport persistence during continuous pan and zoom interaction. */
  const scheduleViewportPersist = () => {
    if (viewportPersistTimer) clearTimeout(viewportPersistTimer);
    viewportPersistTimer = setTimeout(() => {
      viewportPersistTimer = 0;
      updateStatusPanel();
      updateInfoOverlay();
      persistViewport();
    }, 140);
  };

  /** Cancels pending debounce work and immediately writes the final viewport state. */
  const flushViewportPersist = () => {
    if (viewportPersistTimer) {
      clearTimeout(viewportPersistTimer);
      viewportPersistTimer = 0;
    }
    updateStatusPanel();
    updateInfoOverlay();
    persistViewport();
  };

  /** Zooms around a client coordinate while keeping its graph-space point stationary. */
  const zoomViewportAtClientPoint = (clientX, clientY, nextZoom) => {
    const viewModel = ensureViewModel();
    if (!viewport) viewport = fitViewport(viewModel);
    const rect = canvasEl.getBoundingClientRect();
    const currentZoom = clampViewportZoom(viewport.zoom);
    const zoom = clampViewportZoom(nextZoom);
    const localX = Number(clientX) - rect.left;
    const localY = Number(clientY) - rect.top;
    const graphX = (localX - Number(viewport.offsetX || 0)) / currentZoom;
    const graphY = (localY - Number(viewport.offsetY || 0)) / currentZoom;
    viewport = {
      zoom,
      offsetX: Math.round(localX - graphX * zoom),
      offsetY: Math.round(localY - graphY * zoom),
    };
    viewportMode = "manual";
    applyViewport({ updatePanels: false });
    scheduleViewportPersist();
  };

  /** Translates the viewport by finite client-space deltas and schedules persistence. */
  const panViewportBy = (deltaX, deltaY) => {
    if (!viewport) viewport = fitViewport(ensureViewModel());
    viewport = {
      zoom: clampViewportZoom(viewport.zoom),
      offsetX: Math.round(Number(viewport.offsetX || 0) + Number(deltaX || 0)),
      offsetY: Math.round(Number(viewport.offsetY || 0) + Number(deltaY || 0)),
    };
    viewportMode = "manual";
    applyViewport({ updatePanels: false });
    scheduleViewportPersist();
  };

  /** Routes wheel gestures to graph-owned pan or modifier-assisted cursor zoom. */
  const handleCanvasWheel = (event) => {
    event.preventDefault();
    const delta = wheelDeltaPixels(event);
    if (event.ctrlKey || event.metaKey) {
      const currentZoom = clampViewportZoom(viewport?.zoom || fitViewport(ensureViewModel()).zoom);
      const nextZoom = currentZoom * Math.exp(-delta.y * GRAPH_WHEEL_ZOOM_SENSITIVITY);
      zoomViewportAtClientPoint(event.clientX, event.clientY, nextZoom);
      return;
    }
    const panX = event.shiftKey && Math.abs(delta.x) < 0.1 ? delta.y : delta.x;
    const panY = event.shiftKey && Math.abs(delta.x) < 0.1 ? 0 : delta.y;
    panViewportBy(-panX, -panY);
  };

  /** Checks whether an interactive child control should block canvas drag panning. */
  const viewportPanBlocked = (event) =>
    event.target?.closest?.(".workspace-graph-node, [data-edge-id], button, a, input, textarea, select, .graph-floating-panel");

  /** Requests pointer capture when supported and tolerates browser-specific rejection. */
  const safeSetPointerCapture = (element, pointerId) => {
    try {
      element?.setPointerCapture?.(pointerId);
    } catch (_error) {
      // Synthetic audit events are not always active pointers.
    }
  };

  /** Releases owned pointer capture when supported and tolerates stale pointer state. */
  const safeReleasePointerCapture = (element, pointerId) => {
    try {
      element?.releasePointerCapture?.(pointerId);
    } catch (_error) {
      // Pointer capture may already be released by the browser.
    }
  };

  /** Starts canvas panning from a primary pointer outside interactive child controls. */
  const beginViewportPan = (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    if (viewportPanBlocked(event)) return;
    if (!viewport) viewport = fitViewport(ensureViewModel());
    viewportPanState = {
      pointerId: event.pointerId,
      startClientX: Number(event.clientX),
      startClientY: Number(event.clientY),
      startOffsetX: Number(viewport.offsetX || 0),
      startOffsetY: Number(viewport.offsetY || 0),
      moved: false,
    };
    root.classList.add("is-viewport-panning");
    safeSetPointerCapture(canvasEl, event.pointerId);
    event.preventDefault();
  };

  /** Applies incremental pointer movement to the active canvas-pan viewport state. */
  const updateViewportPan = (event) => {
    if (!viewportPanState || event.pointerId !== viewportPanState.pointerId) return;
    const deltaX = Number(event.clientX) - viewportPanState.startClientX;
    const deltaY = Number(event.clientY) - viewportPanState.startClientY;
    if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) viewportPanState.moved = true;
    viewport = {
      zoom: clampViewportZoom(viewport?.zoom || 1),
      offsetX: Math.round(viewportPanState.startOffsetX + deltaX),
      offsetY: Math.round(viewportPanState.startOffsetY + deltaY),
    };
    viewportMode = "manual";
    applyViewport({ updatePanels: false });
  };

  /** Ends canvas panning, releases capture, and persists the final offsets. */
  const endViewportPan = (event) => {
    if (!viewportPanState || event.pointerId !== viewportPanState.pointerId) return;
    suppressNextCanvasClick = viewportPanState.moved;
    viewportPanState = null;
    root.classList.remove("is-viewport-panning");
    safeReleasePointerCapture(canvasEl, event.pointerId);
    flushViewportPersist();
  };

  /** Toggles active-chain focus mode while preserving the current node or edge selection. */
  const toggleFocusMode = () => {
    const selectedNode = viewModelSelectedNode(ensureViewModel(), selectedNodeId);
    if (!selectedNode) return;
    focusModeActive = !focusModeActive;
    syncSurfaceControls();
    updateStatusPanel();
    persistGraphLensState();
  };

  /** Clears manual layout for the active graph and rebuilds provider-derived geometry. */
  const arrangeGraph = () => {
    if (!graphHasManualLayout()) return;
    const buckets = isPlainObject(graphLayout?.nodePositionsByCategory)
      ? { ...graphLayout.nodePositionsByCategory }
      : {};
    delete buckets[currentGraphLayoutKey()];
    graphLayout = {
      ...graphLayout,
      nodePositionsByCategory: buckets,
    };
    layoutRevision += 1;
    viewModelCache.clear();
    activeViewModel = null;
    activeViewModelSignature = "";
    viewportMode = "fit";
    viewport = null;
    applyViewport();
    persistLayout();
    persistViewport();
  };

  /** Persists one container collapse override and rebuilds the active projection geometry. */
  const setContainerCollapsed = (containerId, collapsed) => {
    const normalizedContainerId = normalizeNodeId(containerId);
    if (!normalizedContainerId) return;
    const key = currentGraphLayoutKey();
    const sourceContainer = (Array.isArray(atlasGraphViewOptions(liveMemoryGraph).containers)
      ? atlasGraphViewOptions(liveMemoryGraph).containers
      : [])
      .find((container) => normalizeNodeId(container?.id) === normalizedContainerId);
    const defaultCollapsed = sourceContainer?.collapsed === true || sourceContainer?.renderAsNode === true;
    const bucket = {
      ...currentContainerCollapseBucket(),
    };
    if ((collapsed === true) === defaultCollapsed) {
      delete bucket[normalizedContainerId];
    } else {
      bucket[normalizedContainerId] = collapsed === true;
    }
    const nextCollapseByCategory = { ...containerCollapseByCategory };
    if (Object.keys(bucket).length) {
      nextCollapseByCategory[key] = bucket;
    } else {
      delete nextCollapseByCategory[key];
    }
    containerCollapseByCategory = nextCollapseByCategory;
    selectedNodeId = GRAPH_NO_SELECTION_NODE_ID;
    selectedEdgeId = "";
    focusModeActive = false;
    routerDocument = { ...routerDocument, open: false };
    layoutRevision += 1;
    viewModelCache.clear();
    activeViewModel = null;
    activeViewModelSignature = "";
    viewportMode = "fit";
    viewport = null;
    applyViewport();
    persistGraphLensState();
  };

  /** Loads, caches, validates, and applies the current category or architecture-room projection. */
  const loadLiveProjection = async ({ force = false } = {}) => {
    if (!force && liveMemoryGraph) return;
    const requestId = liveProjectionRequestId + 1;
    liveProjectionRequestId = requestId;
    const requestCategory = activeSourceCategory;
    const requestArchitectureRoomId = activeArchitectureRoomId;
    const requestProjectionKey = projectionCacheKeyFor(requestCategory, requestArchitectureRoomId);
    liveProjectionStatus = "loading";
    liveProjectionError = "";
    syncPresentationControls();
    syncSurfaceControls();
    updateInfoOverlay();
    try {
      const authorizedByCurrentProjection = requestArchitectureRoomId
        && pendingArchitectureRoomAuthorization === requestArchitectureRoomId;
      if (
        requestCategory === "architecture"
        && requestArchitectureRoomId
        && !authorizedByCurrentProjection
      ) {
        const setupProjection = cachedProjectionFor("architecture", "")
          || await fetchLiveProjectionFor("architecture", "");
        if (requestId !== liveProjectionRequestId) return;
        rememberProjection(setupProjection, "architecture", "");
        const approvedTarget = graphProjectionRoomEntryTargetId(
          setupProjection,
          requestArchitectureRoomId,
        );
        if (!approvedTarget) {
          activeArchitectureRoomId = "";
          pendingArchitectureRoomAuthorization = "";
          liveMemoryGraph = setupProjection;
          liveProjectionStatus = "repository setup/source inventory fallback";
          liveProjectionError = "";
          liveProjectionRevision += 1;
          activeViewModelSignature = "";
          viewportMode = "fit";
          viewport = null;
          replaceRejectedArchitectureRoomHash(requestArchitectureRoomId);
          persistGraphLensState();
          applyViewport();
          return;
        }
      }
      pendingArchitectureRoomAuthorization = "";
      const projection = await fetchLiveProjectionFor(requestCategory, requestArchitectureRoomId);
      if (requestId !== liveProjectionRequestId) return;
      if (projectionUnavailableForArchitectureRoom(projection, requestCategory, requestArchitectureRoomId)) {
        throw new Error(compactValue(
          projection?.metadata?.architectureAtlasError,
          `architecture room ${requestArchitectureRoomId} unavailable`,
        ));
      }
      liveMemoryGraph = projection;
      rememberProjection(projection, requestCategory, requestArchitectureRoomId);
      liveProjectionStatus = "live";
      liveProjectionError = "";
      liveProjectionRevision += 1;
      activeViewModelSignature = "";
      viewportMode = "fit";
      viewport = null;
      applyViewport();
    } catch (error) {
      if (requestId !== liveProjectionRequestId) return;
      liveProjectionError = String(error?.message || error || "unknown fetch error");
      const sameKeyFallback = liveProjectionCache.get(requestProjectionKey) || null;
      const rootArchitectureFallback = requestCategory === "architecture" && requestArchitectureRoomId
        ? cachedProjectionFor("architecture", "")
        : null;
      const fallbackProjection = sameKeyFallback || rootArchitectureFallback || null;
      if (fallbackProjection) {
        if (rootArchitectureFallback && !sameKeyFallback) {
          activeArchitectureRoomId = "";
          if (typeof window !== "undefined") {
            const hashCategory = sourceCategoryFromHash(window.location.hash);
            const hashRoomId = architectureRoomIdFromHash(window.location.hash);
            if (hashCategory === "architecture" && hashRoomId === requestArchitectureRoomId) {
              window.history.replaceState(null, "", hashForSourceCategory("architecture"));
            }
          }
        }
        liveMemoryGraph = fallbackProjection;
        liveProjectionStatus = rootArchitectureFallback && !sameKeyFallback
          ? "cached repository setup fallback"
          : "cached live fallback";
        liveProjectionRevision += 1;
        activeViewModelSignature = "";
        viewportMode = "fit";
        viewport = null;
        persistGraphLensState();
        applyViewport();
        return;
      }
      if (requestCategory === "architecture" && requestArchitectureRoomId) {
        activeArchitectureRoomId = "";
        liveMemoryGraph = null;
        liveProjectionStatus = "room unavailable; loading repository setup";
        liveProjectionRevision += 1;
        activeViewModelSignature = "";
        viewportMode = "fit";
        viewport = null;
        if (typeof window !== "undefined") {
          const hashCategory = sourceCategoryFromHash(window.location.hash);
          const hashRoomId = architectureRoomIdFromHash(window.location.hash);
          if (hashCategory === "architecture" && hashRoomId === requestArchitectureRoomId) {
            window.history.replaceState(null, "", hashForSourceCategory("architecture"));
          }
        }
        persistGraphLensState();
        applyViewport();
        void loadLiveProjection({ force: true });
        return;
      }
      liveProjectionStatus = liveMemoryGraph ? "cached live fallback" : "Atlas source unavailable";
      if (!liveMemoryGraph) {
        activeViewModelSignature = "";
        viewportMode = "fit";
        viewport = null;
        applyViewport();
      } else {
        syncSurfaceControls();
        updateInfoOverlay();
      }
    }
  };

  /** Fetches router health once per refresh cycle and updates panel diagnostics. */
  const loadRouterHealth = async ({ force = false } = {}) => {
    if (!force && routerHealth) return;
    const requestId = routerHealthRequestId + 1;
    routerHealthRequestId = requestId;
    routerHealthStatus = "loading";
    routerHealthError = "";
    updateStatusPanel();
    try {
      const payload = typeof options?.routerHealthProvider === "function"
        ? await options.routerHealthProvider()
        : await fetchAtlasRouterHealth();
      if (requestId !== routerHealthRequestId) return;
      routerHealth = payload;
      routerHealthStatus = "live";
      routerHealthError = "";
      updateStatusPanel();
    } catch (error) {
      if (requestId !== routerHealthRequestId) return;
      routerHealthStatus = "unavailable";
      routerHealthError = String(error?.message || error || "unknown router health error");
      updateStatusPanel();
    }
  };

  /** Clears the active source-document viewer and restores standard panel content. */
  const closeRouterDocument = () => {
    routerDocument = {
      open: false,
      title: "",
      href: "",
      status: "idle",
      text: "",
      error: "",
    };
    updateStatusPanel();
    persistGraphLensState();
  };

  /** Fetches and displays a bounded router document while preserving source navigation context. */
  const openRouterDocument = async (label, href) => {
    const safeHref = compactValue(href);
    if (!safeHref) return;
    const requestId = routerDocumentRequestId + 1;
    routerDocumentRequestId = requestId;
    routerDocument = {
      open: true,
      title: compactValue(label, "Document"),
      href: safeHref,
      status: "loading",
      text: "",
      error: "",
    };
    if (!statusPanelOpen) statusPanelOpen = true;
    updateStatusPanel();
    persistGraphLensState();
    try {
      const response = await fetch(safeHref, { cache: "no-store" });
      const text = await response.text();
      if (requestId !== routerDocumentRequestId) return;
      routerDocument = {
        ...routerDocument,
        status: response.ok ? "loaded" : "error",
        text: response.ok ? text : "",
        error: response.ok ? "" : `HTTP ${response.status}: ${compactText(text, 160)}`,
      };
      updateStatusPanel();
    } catch (error) {
      if (requestId !== routerDocumentRequestId) return;
      routerDocument = {
        ...routerDocument,
        status: "error",
        error: String(error?.message || error || "unknown fetch error"),
      };
      updateStatusPanel();
    }
  };

  /** Changes overview or inspect presentation, persists it, and rebuilds node geometry. */
  const setPresentationMode = (mode) => {
    const nextMode = normalizeGraphPresentationMode(mode);
    if (nextMode === activePresentationMode) return;
    activePresentationMode = nextMode;
    activeViewModelSignature = "";
    viewportMode = "fit";
    viewport = null;
    applyViewport();
    persistGraphLensState();
    void loadLiveProjection();
  };

  /** Selects one node, clears edge selection, and applies fast chain and panel updates. */
  const selectNode = (nodeId) => {
    const normalizedNodeId = normalizeNodeId(nodeId);
    if (!normalizedNodeId) return;
    const nodeChanged = normalizedNodeId !== selectedNodeId;
    const edgeChanged = Boolean(selectedEdgeId);
    if (!nodeChanged && !edgeChanged) return;
    selectedNodeId = normalizedNodeId;
    selectedEdgeId = "";
    routerDocument = { ...routerDocument, open: false };
    applyFastSelectionState();
    const node = viewModelSelectedNode(activeViewModel, selectedNodeId);
    invokeGraphCallback(onSelectionChange, {
      sourceCategory: activeSourceCategory,
      nodeId: selectedNodeId,
      node,
      viewModel: activeViewModel,
    }, root, "memory-graph-selection-change");
    if (edgeChanged) {
      invokeGraphCallback(onEdgeSelectionChange, {
        sourceCategory: activeSourceCategory,
        edgeId: "",
        edge: null,
        from: "",
        to: "",
        viewModel: activeViewModel,
      }, root, "memory-graph-edge-selection-change");
    }
    persistGraphLensState();
  };

  /** Selects one relationship, clears node selection, and applies fast chain and panel updates. */
  const selectEdge = (edgeId) => {
    const nextEdgeId = normalizeEdgeId(edgeId);
    if (!nextEdgeId || nextEdgeId === selectedEdgeId) return;
    const hadNodeSelection = selectedNodeId !== GRAPH_NO_SELECTION_NODE_ID;
    selectedNodeId = GRAPH_NO_SELECTION_NODE_ID;
    focusModeActive = false;
    selectedEdgeId = nextEdgeId;
    routerDocument = { ...routerDocument, open: false };
    applyFastSelectionState();
    const edge = (Array.isArray(activeViewModel?.edges) ? activeViewModel.edges : [])
      .find((candidate) => String(candidate?.id || "") === selectedEdgeId) || null;
    if (hadNodeSelection) {
      invokeGraphCallback(onSelectionChange, {
        sourceCategory: activeSourceCategory,
        nodeId: "",
        node: null,
        viewModel: activeViewModel,
      }, root, "memory-graph-selection-change");
    }
    invokeGraphCallback(onEdgeSelectionChange, {
      sourceCategory: activeSourceCategory,
      edgeId: selectedEdgeId,
      edge,
      from: edge?.from || "",
      to: edge?.to || "",
      viewModel: activeViewModel,
    }, root, "memory-graph-edge-selection-change");
    persistGraphLensState();
  };

  /** Clears node, edge, and focus state and optionally notifies the embedding host. */
  const clearGraphSelection = ({ notify = true } = {}) => {
    const hadSelection = selectedNodeId !== GRAPH_NO_SELECTION_NODE_ID || Boolean(selectedEdgeId);
    if (!hadSelection) return;
    selectedNodeId = GRAPH_NO_SELECTION_NODE_ID;
    selectedEdgeId = "";
    focusModeActive = false;
    routerDocument = { ...routerDocument, open: false };
    applyFastSelectionState();
    if (notify) {
      invokeGraphCallback(onSelectionChange, {
        sourceCategory: activeSourceCategory,
        nodeId: "",
        node: null,
        viewModel: activeViewModel,
      }, root, "memory-graph-selection-change");
      invokeGraphCallback(onEdgeSelectionChange, {
        sourceCategory: activeSourceCategory,
        edgeId: "",
        edge: null,
        from: "",
        to: "",
        viewModel: activeViewModel,
      }, root, "memory-graph-edge-selection-change");
    }
    persistGraphLensState();
  };

  /** Changes quality or speed routing and rebuilds geometry when manual layout permits it. */
  const setRouteMode = (mode) => {
    const nextMode = normalizeGraphRouteMode(mode);
    if (nextMode === activeRouteMode) return;
    activeRouteMode = nextMode;
    viewModelCache.clear();
    activeViewModel = null;
    activeViewModelSignature = "";
    viewportMode = "fit";
    viewport = null;
    applyViewport();
    persistGraphLensState();
  };

  /** Switches provider category, room, cached state, hash route, and visible controls coherently. */
  const setSourceCategory = (categoryId, settings = {}) => {
    const nextCategory = normalizeSourceCategoryId(categoryId);
    let nextArchitectureRoomId = nextCategory === "architecture"
      ? normalizeNodeId(settings.architectureRoomId || "")
      : "";
    let rejectedArchitectureRoomId = "";
    if (
      nextArchitectureRoomId
      && nextArchitectureRoomId !== activeArchitectureRoomId
      && liveMemoryGraph
    ) {
      const approvedTarget = graphProjectionRoomEntryTargetId(
        liveMemoryGraph,
        nextArchitectureRoomId,
      );
      if (approvedTarget) {
        pendingArchitectureRoomAuthorization = approvedTarget;
      } else {
        // Programmatic and hash callers cannot bypass the provider contract;
        // an unrecognized target resolves to the safe setup/inventory surface.
        rejectedArchitectureRoomId = nextArchitectureRoomId;
        nextArchitectureRoomId = "";
        pendingArchitectureRoomAuthorization = "";
      }
    } else if (!nextArchitectureRoomId) {
      pendingArchitectureRoomAuthorization = "";
    }
    const nextHash = nextArchitectureRoomId
      ? hashForArchitectureRoom(nextArchitectureRoomId)
      : hashForSourceCategory(nextCategory);
    if (rejectedArchitectureRoomId) {
      // Hashchange handling suppresses ordinary hash writes to avoid recursion,
      // so a rejected target must still replace its stale address explicitly.
      replaceRejectedArchitectureRoomHash(rejectedArchitectureRoomId);
    }
    if (nextCategory === activeSourceCategory && nextArchitectureRoomId === activeArchitectureRoomId) {
      if (settings.updateHash !== false && typeof window !== "undefined") {
        if (window.location.hash !== nextHash) window.location.hash = nextHash;
      }
      return;
    }
    activeSourceCategory = nextCategory;
    activeArchitectureRoomId = nextArchitectureRoomId;
    selectedNodeId = GRAPH_NO_SELECTION_NODE_ID;
    selectedEdgeId = "";
    focusModeActive = false;
    routerDocument = { ...routerDocument, open: false };
    liveMemoryGraph = cachedProjectionFor(nextCategory, nextArchitectureRoomId);
    liveProjectionRevision += 1;
    liveProjectionStatus = liveMemoryGraph ? "cached while loading" : "waiting for Atlas source";
    liveProjectionError = "";
    viewModelCache.clear();
    activeViewModel = null;
    activeViewModelSignature = "";
    viewportMode = "fit";
    viewport = null;
    applyViewport();
    persistGraphLensState();
    if (settings.updateHash !== false && typeof window !== "undefined") {
      if (window.location.hash !== nextHash) window.location.hash = nextHash;
    }
    void loadLiveProjection({ force: true });
  };

  /** Fetches uncached category roots without precompute, records availability, and leaves empty sources hidden. */
  const discoverSourceAvailability = () => {
    if (sourceAvailabilityScanPromise) return sourceAvailabilityScanPromise;
    sourceAvailabilityScanStatus = "loading";
    syncSourceControls();
    sourceAvailabilityScanPromise = (async () => {
      await Promise.all(ATLAS_SOURCE_CATEGORIES.map(async (category) => {
        const cached = cachedProjectionFor(category.id, "");
        if (cached) {
          rememberProjection(cached, category.id, "");
          return;
        }
        try {
          const projection = await fetchLiveProjectionFor(category.id, "", {
            capabilityProbe: true,
            precompute: false,
          });
          rememberProjection(projection, category.id, "");
        } catch (_error) {
          sourceAvailabilityById.set(category.id, "unavailable");
        }
      }));
      sourceAvailabilityScanStatus = "ready";
      syncSourceControls();
      if (sourceAvailabilityById.get(activeSourceCategory) !== "available") {
        const fallbackCategory = sourceAvailabilityById.get("architecture") === "available"
          ? "architecture"
          : ATLAS_SOURCE_CATEGORIES.find(
            (category) => sourceAvailabilityById.get(category.id) === "available",
          )?.id;
        if (fallbackCategory) setSourceCategory(fallbackCategory);
      }
      return new Map(sourceAvailabilityById);
    })();
    return sourceAvailabilityScanPromise;
  };

  /** Synchronizes controller category and room state after external browser hash navigation. */
  const handleSourceHashChange = () => {
    if (typeof window === "undefined") return;
    const category = sourceCategoryFromHash(window.location.hash);
    const architectureRoomId = architectureRoomIdFromHash(window.location.hash);
    if (!category) {
      setSourceCategory(GRAPH_DEFAULT_SOURCE_CATEGORY, { updateHash: false, architectureRoomId: "" });
      return;
    }
    setSourceCategory(category, { updateHash: false, architectureRoomId });
  };

  /** Converts client pointer coordinates into graph space under current zoom and pan. */
  const graphPointFromPointer = (event) => {
    const rect = contentEl.getBoundingClientRect();
    const zoom = Math.max(0.001, Number(viewport?.zoom) || 1);
    return {
      x: (Number(event.clientX) - rect.left) / zoom,
      y: (Number(event.clientY) - rect.top) / zoom,
    };
  };

  /** Stores one snapped manual node position and updates only affected geometry and persistence. */
  const setManualNodePosition = (nodeId, position) => {
    const normalizedNodeId = normalizeNodeId(nodeId);
    if (!normalizedNodeId) return;
    const normalizationOffset = activeViewModel?.normalizationOffset || {};
    const buckets = isPlainObject(graphLayout?.nodePositionsByCategory)
      ? { ...graphLayout.nodePositionsByCategory }
      : {};
    const layoutKey = currentGraphLayoutKey();
    // Snap in rendered graph space before restoring the world offset. Snapping
    // the stored world coordinate later would shift a visible drop whenever
    // labels or route bounds give the normalized origin a non-grid remainder.
    const snappedPosition = {
      x: snapGraphCoordinateToGrid(position.x),
      y: snapGraphCoordinateToGrid(position.y),
    };
    buckets[layoutKey] = {
      ...(isPlainObject(buckets[layoutKey]) ? buckets[layoutKey] : {}),
      [normalizedNodeId]: {
        x: Math.round(snappedPosition.x + (Number(normalizationOffset.x) || 0)),
        y: Math.round(snappedPosition.y + (Number(normalizationOffset.y) || 0)),
      },
    };
    graphLayout = {
      ...graphLayout,
      nodePositionsByCategory: buckets,
    };
    layoutRevision += 1;
    viewModelCache.clear();
    activeViewModel = null;
    activeViewModelSignature = "";
    applyViewport();
  };

  /** Starts node dragging while optionally preserving native click and double-click synthesis. */
  const beginNodeDrag = (event, nodeEl, { preserveCompatibilityMouseEvents = false } = {}) => {
    if (event.button !== undefined && event.button !== 0) return;
    const nodeId = normalizeNodeId(nodeEl?.dataset?.nodeId);
    const node = (Array.isArray(activeViewModel?.nodes) ? activeViewModel.nodes : [])
      .find((candidate) => normalizeNodeId(candidate?.id) === nodeId);
    if (!node) return;
    const point = graphPointFromPointer(event);
    nodeDragState = {
      pointerId: event.pointerId,
      nodeId,
      nodeEl,
      startPointerX: point.x,
      startPointerY: point.y,
      startNodeX: Number(node.x || 0),
      startNodeY: Number(node.y || 0),
      nextNodeX: Number(node.x || 0),
      nextNodeY: Number(node.y || 0),
      moved: false,
    };
    root.classList.add("is-node-dragging");
    safeSetPointerCapture(nodeEl, event.pointerId);
    // Room and overview nodes own both drag and double-click gestures. Their
    // pointerdown must remain uncancelled so browsers still synthesize the
    // compatibility mouse events that deliver the native `dblclick` contract.
    if (!preserveCompatibilityMouseEvents) event.preventDefault();
  };

  /** Updates the dragged node and connected-edge previews without rebuilding the full graph. */
  const updateNodeDrag = (event) => {
    if (!nodeDragState || event.pointerId !== nodeDragState.pointerId) return;
    const point = graphPointFromPointer(event);
    const nextX = nodeDragState.startNodeX + point.x - nodeDragState.startPointerX;
    const nextY = nodeDragState.startNodeY + point.y - nodeDragState.startPointerY;
    if (Math.abs(nextX - nodeDragState.startNodeX) > 2 || Math.abs(nextY - nodeDragState.startNodeY) > 2) {
      nodeDragState.moved = true;
    }
    nodeDragState.nextNodeX = nextX;
    nodeDragState.nextNodeY = nextY;
    if (nodeDragState.nodeEl) {
      nodeDragState.nodeEl.style.transform = `translate(${Math.round(nextX - nodeDragState.startNodeX)}px, ${Math.round(nextY - nodeDragState.startNodeY)}px)`;
      nodeDragState.nodeEl.classList.add("is-drag-preview");
    }
  };

  /** Commits a dragged node's snapped manual position and restores complete route geometry. */
  const endNodeDrag = (event) => {
    if (!nodeDragState || event.pointerId !== nodeDragState.pointerId) return;
    const finalDragState = nodeDragState;
    safeReleasePointerCapture(finalDragState.nodeEl, event.pointerId);
    if (finalDragState.moved) {
      suppressNextClickNodeId = finalDragState.nodeId;
      setManualNodePosition(finalDragState.nodeId, {
        x: finalDragState.nextNodeX,
        y: finalDragState.nextNodeY,
      });
      persistLayout();
    }
    if (finalDragState.nodeEl) {
      finalDragState.nodeEl.style.transform = "";
      finalDragState.nodeEl.classList.remove("is-drag-preview");
    }
    nodeDragState = null;
    root.classList.remove("is-node-dragging");
  };

  /** Starts information-overlay dragging from its header with pointer capture. */
  const beginPanelDrag = (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    if (event.target?.closest?.("button, a")) return;
    const handle = event.target?.closest?.("[data-panel-drag-handle]");
    if (!handle || infoEl.hidden) return;
    const rect = infoEl.getBoundingClientRect();
    panelDragState = {
      pointerId: event.pointerId,
      startClientX: Number(event.clientX),
      startClientY: Number(event.clientY),
      startLeft: rect.left,
      startTop: rect.top,
    };
    infoEl.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };

  /** Moves the information overlay within viewport bounds during an active pointer drag. */
  const updatePanelDrag = (event) => {
    if (!panelDragState || event.pointerId !== panelDragState.pointerId) return;
    panelPosition = {
      left: panelDragState.startLeft + Number(event.clientX) - panelDragState.startClientX,
      top: panelDragState.startTop + Number(event.clientY) - panelDragState.startClientY,
    };
    applyPanelPosition();
  };

  /** Ends information-overlay dragging and persists its final bounded position. */
  const endPanelDrag = (event) => {
    if (!panelDragState || event.pointerId !== panelDragState.pointerId) return;
    panelDragState = null;
    persistGraphLensState();
  };

  /** Starts status-panel dragging from its header while excluding interactive controls. */
  const beginStatusPanelDrag = (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    if (event.target?.closest?.("button, a")) return;
    const handle = event.target?.closest?.("[data-status-panel-drag-handle]");
    if (!handle || statusPanelEl.hidden) return;
    const rect = statusPanelEl.getBoundingClientRect();
    statusPanelDragState = {
      pointerId: event.pointerId,
      startClientX: Number(event.clientX),
      startClientY: Number(event.clientY),
      startLeft: rect.left,
      startTop: rect.top,
    };
    statusPanelEl.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };

  /** Moves the status panel within reachable viewport bounds during pointer drag. */
  const updateStatusPanelDrag = (event) => {
    if (!statusPanelDragState || event.pointerId !== statusPanelDragState.pointerId) return;
    statusPanelPosition = {
      left: statusPanelDragState.startLeft + Number(event.clientX) - statusPanelDragState.startClientX,
      top: statusPanelDragState.startTop + Number(event.clientY) - statusPanelDragState.startClientY,
    };
    applyStatusPanelPosition();
  };

  /** Ends status-panel dragging and persists its final bounded position. */
  const endStatusPanelDrag = (event) => {
    if (!statusPanelDragState || event.pointerId !== statusPanelDragState.pointerId) return;
    statusPanelDragState = null;
    persistGraphLensState();
  };

  sourceControlsEl.addEventListener("click", (event) => {
    const button = event.target?.closest?.("[data-source-category]");
    if (!button) return;
    event.preventDefault();
    setSourceCategory(button.dataset.sourceCategory);
  });
  compactButton.addEventListener("click", () => setPresentationMode(GRAPH_PRESENTATION_COMPACT));
  extendedButton.addEventListener("click", () => setPresentationMode(GRAPH_PRESENTATION_EXTENDED));
  fitButton.addEventListener("click", fitGraph);
  zoomOutButton.addEventListener("click", () => zoomGraph(-1));
  zoomInButton.addEventListener("click", () => zoomGraph(1));
  focusButton.addEventListener("click", toggleFocusMode);
  arrangeButton.addEventListener("click", arrangeGraph);
  if (refreshButton) {
    refreshButton.addEventListener("click", () => {
      viewModelCache.clear();
      void loadLiveProjection({ force: true });
      void loadRouterHealth({ force: true });
    });
  }
  if (speedButton) {
    speedButton.addEventListener("click", () => {
      setRouteMode(activeRouteMode === GRAPH_ROUTE_MODE_SPEED
        ? GRAPH_ROUTE_MODE_QUALITY
        : GRAPH_ROUTE_MODE_SPEED);
    });
  }
  infoEl.addEventListener("pointerdown", beginPanelDrag);
  infoEl.addEventListener("pointermove", updatePanelDrag);
  infoEl.addEventListener("pointerup", endPanelDrag);
  infoEl.addEventListener("pointercancel", endPanelDrag);
  statusPanelEl.addEventListener("pointerdown", beginStatusPanelDrag);
  statusPanelEl.addEventListener("pointermove", updateStatusPanelDrag);
  statusPanelEl.addEventListener("pointerup", endStatusPanelDrag);
  statusPanelEl.addEventListener("pointercancel", endStatusPanelDrag);
  statusPanelEl.addEventListener("click", (event) => {
    const actionButton = event.target?.closest?.("[data-router-action], [data-document-href]");
    if (!actionButton) return;
    event.preventDefault();
    event.stopPropagation();
    const action = actionButton.dataset.routerAction || "";
    if (action === "toggle-status-panel") {
      statusPanelOpen = !statusPanelOpen;
      updateStatusPanel();
      persistGraphLensState();
      return;
    }
    if (action === "clear-selection") {
      clearGraphSelection();
      return;
    }
    if (action === "close-document") {
      closeRouterDocument();
      return;
    }
    if (action === "enter-architecture-room") {
      const roomId = validatedRouterActionRoomId(actionButton);
      // Action execution revalidates the live provider object; copied or stale
      // DOM attributes never become room-entry authority.
      if (roomId && roomId !== currentArchitectureRoomId()) {
        setSourceCategory("architecture", { architectureRoomId: roomId });
      }
      return;
    }
    if (action === "exit-architecture-room") {
      setSourceCategory("architecture", { architectureRoomId: "" });
      return;
    }
    if (actionButton.dataset.documentHref) {
      void openRouterDocument(actionButton.dataset.documentLabel || actionButton.textContent, actionButton.dataset.documentHref);
    }
  });
  if (typeof window !== "undefined") {
    window.addEventListener("hashchange", handleSourceHashChange);
  }
  canvasEl.addEventListener("wheel", handleCanvasWheel, { passive: false });
  canvasEl.addEventListener("pointerdown", beginViewportPan);
  canvasEl.addEventListener("pointermove", updateViewportPan);
  canvasEl.addEventListener("pointerup", endViewportPan);
  canvasEl.addEventListener("pointercancel", endViewportPan);
  contentEl.addEventListener("pointerdown", (event) => {
    if (event.target?.closest?.("[data-container-action]")) return;
    const nodeEl = event.target?.closest?.(".workspace-graph-node");
    if (!nodeEl) return;
    beginNodeDrag(event, nodeEl, {
      preserveCompatibilityMouseEvents: Boolean(nodeEl.dataset.graphNavigationKind),
    });
  });
  contentEl.addEventListener("pointermove", updateNodeDrag);
  contentEl.addEventListener("pointerup", endNodeDrag);
  contentEl.addEventListener("pointercancel", endNodeDrag);
  contentEl.addEventListener("click", (event) => {
    const containerActionEl = event.target?.closest?.("[data-container-action][data-container-id]");
    if (containerActionEl) {
      event.preventDefault();
      event.stopPropagation();
      const action = containerActionEl.dataset.containerAction;
      if (action === "collapse" || action === "expand") {
        setContainerCollapsed(containerActionEl.dataset.containerId, action === "collapse");
      }
      return;
    }
    const edgeEl = event.target?.closest?.("[data-edge-id]");
    if (edgeEl && !edgeEl.classList.contains("workspace-graph-node-connector")) {
      event.preventDefault();
      event.stopPropagation();
      selectEdge(edgeEl.dataset.edgeId);
      return;
    }
    const nodeEl = event.target?.closest?.(".workspace-graph-node");
    if (!nodeEl) {
      if (suppressNextCanvasClick) {
        suppressNextCanvasClick = false;
        return;
      }
      clearGraphSelection();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const normalizedNodeId = normalizeNodeId(nodeEl.dataset.nodeId);
    if (suppressNextClickNodeId && suppressNextClickNodeId === normalizedNodeId) {
      suppressNextClickNodeId = "";
      return;
    }
    if (nodeEl.dataset.graphNavigationKind) {
      // A navigation node must remain mounted between the two native clicks.
      // Defer its ordinary selection briefly so a double-click can navigate
      // without the first click replacing the event target during rerender.
      if (pendingArchitectureNavigationSelectionTimer) clearTimeout(pendingArchitectureNavigationSelectionTimer);
      pendingArchitectureNavigationSelectionTimer = window.setTimeout(() => {
        pendingArchitectureNavigationSelectionTimer = 0;
        selectNode(nodeEl.dataset.nodeId);
      }, 220);
      return;
    }
    selectNode(nodeEl.dataset.nodeId);
  });
  /**
   * navigateArchitectureOnDoubleClick revalidates the rendered node against
   * the live projection, then loads its semantic room or clears the active
   * room when the node declares a repository-overview return.
   */
  const navigateArchitectureOnDoubleClick = (event) => {
    const nodeEl = event.target?.closest?.(".workspace-graph-node[data-graph-navigation-kind]");
    if (!nodeEl || !activeViewModel) return;
    const node = viewModelSelectedNode(activeViewModel, nodeEl.dataset.nodeId);
    const navigation = supportedArchitectureNavigationForNode(node);
    if (!navigation) return;
    if (pendingArchitectureNavigationSelectionTimer) {
      clearTimeout(pendingArchitectureNavigationSelectionTimer);
      pendingArchitectureNavigationSelectionTimer = 0;
    }
    event.preventDefault();
    event.stopPropagation();
    setSourceCategory("architecture", {
      architectureRoomId: navigation.kind === "room-entry" ? navigation.roomId : "",
    });
  };
  contentEl.addEventListener("dblclick", navigateArchitectureOnDoubleClick);

  const controller = {
    /** Applies a host-supplied projection, source identity, room context, and optional selection. */
    applyProjection(projection, projectionOptions = {}) {
      liveMemoryGraph = projection && Array.isArray(projection.nodes) && Array.isArray(projection.edges)
        ? projection
        : { nodes: [], edges: [] };
      rememberProjection(liveMemoryGraph);
      liveProjectionStatus = String(projectionOptions.status || "host projection");
      liveProjectionError = "";
      liveProjectionRevision += 1;
      viewModelCache.clear();
      activeViewModel = null;
      activeViewModelSignature = "";
      if (projectionOptions.fit !== false) {
        viewportMode = "fit";
        viewport = null;
      }
      applyViewport();
      return ensureViewModel();
    },
    /** Adapts a legacy workspace view-model call to the canonical projection application boundary. */
    applyWorkspaceVm(projection, projectionOptions = {}) {
      return this.applyProjection(projection, projectionOptions);
    },
    /** Returns the current normalized renderer view model without exposing controller mutation. */
    currentViewModel() {
      return ensureViewModel();
    },
    /** Selects and centers one host-requested entity in the active Graph surface. */
    revealEntity(nodeId) {
      selectNode(nodeId);
      centerSelectedNode();
    },
    /** Switches the public controller API to one normalized provider source category. */
    selectSource(sourceCategory) {
      setSourceCategory(sourceCategory);
    },
    /** Clears active selection through the public controller API and notifies the host. */
    clearSelection() {
      clearGraphSelection();
    },
    /** Forces provider projection and router-health refresh through the public controller API. */
    refresh() {
      viewModelCache.clear();
      return loadLiveProjection({ force: true });
    },
    /** Exposes container collapse control through the mounted illustration's public API. */
    setContainerCollapsed(containerId, collapsed) {
      setContainerCollapsed(containerId, collapsed);
      return ensureViewModel();
    },
    /** Removes listeners, timers, pointer state, and mounted Graph DOM owned by this controller. */
    destroy() {
      cancelDeferredRender();
      if (viewportPersistTimer) clearTimeout(viewportPersistTimer);
      if (pendingArchitectureNavigationSelectionTimer) clearTimeout(pendingArchitectureNavigationSelectionTimer);
      resizeObserver?.disconnect?.();
      window.removeEventListener("resize", applyViewport);
      window.removeEventListener("hashchange", handleSourceHashChange);
      canvasEl.removeEventListener("wheel", handleCanvasWheel);
      canvasEl.removeEventListener("pointerdown", beginViewportPan);
      canvasEl.removeEventListener("pointermove", updateViewportPan);
      canvasEl.removeEventListener("pointerup", endViewportPan);
      canvasEl.removeEventListener("pointercancel", endViewportPan);
    },
  };

  if (!liveMemoryGraph) {
    void loadLiveProjection({ force: true });
  } else {
    applyViewport();
    void loadLiveProjection();
  }
  void discoverSourceAvailability();
  void loadRouterHealth({ force: true });
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(applyViewport);
    resizeObserver.observe(root);
  } else {
    window.addEventListener("resize", applyViewport);
  }
  return controller;
}

const defaultGraphRoot = document.getElementById("graph-illustration-root");
if (defaultGraphRoot) {
  mountGraphIllustration(defaultGraphRoot);
}
