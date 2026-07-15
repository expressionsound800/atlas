/*
 * Graph View State normalizes viewport, focus, collapsed-container, route-mode,
 * and manual-position state independently from semantic graph data.
 */
import {
  clampNumber,
  graphVisibleContentBounds,
} from "./graph-geometry.js";

const FIT_PADDING = 40;
const GRAPH_FIT_MAX_ZOOM = 1.75;
const GRAPH_VIEW_MIN_ZOOM = 0.18;
const GRAPH_VIEW_MAX_ZOOM = 2;

export const GRAPH_PRESENTATION_COMPACT = "compact";
export const GRAPH_PRESENTATION_EXTENDED = "extended";

/** Normalizes persisted presentation mode to the supported inspect or overview values. */
export function normalizeGraphPresentationMode(mode) {
  return String(mode || "").trim().toLowerCase() === GRAPH_PRESENTATION_EXTENDED
    ? GRAPH_PRESENTATION_EXTENDED
    : GRAPH_PRESENTATION_COMPACT;
}

/** Computes the zoom and pan that fit a view model within the available viewport padding. */
export function graphFitViewportState(viewModel = {}, viewport = {}, options = {}) {
  const bounds = graphVisibleContentBounds(viewModel);
  const viewportWidth = Math.max(1, Number(viewport?.width || viewport?.clientWidth || 0));
  const viewportHeight = Math.max(1, Number(viewport?.height || viewport?.clientHeight || 0));
  const padding = Math.max(0, Number(options?.padding ?? FIT_PADDING) || 0);
  const maxZoom = clampNumber(
    Number(options?.maxZoom ?? GRAPH_FIT_MAX_ZOOM),
    GRAPH_VIEW_MIN_ZOOM,
    GRAPH_VIEW_MAX_ZOOM,
  );
  const availableWidth = Math.max(1, viewportWidth - padding * 2);
  const availableHeight = Math.max(1, viewportHeight - padding * 2);
  const fitMode = String(options?.fitMode || "contain").trim().toLowerCase();
  const fitRatio = fitMode === "cover"
    ? Math.max(availableWidth / bounds.width, availableHeight / bounds.height)
    : Math.min(availableWidth / bounds.width, availableHeight / bounds.height);
  const fitScale = Math.max(0.1, Number(options?.fitScale || 1));
  const nextZoom = clampNumber(
    fitRatio * fitScale,
    GRAPH_VIEW_MIN_ZOOM,
    maxZoom,
  );
  const centerX = ((bounds.left + bounds.right) / 2) * nextZoom;
  const centerY = ((bounds.top + bounds.bottom) / 2) * nextZoom;
  return {
    zoom: nextZoom,
    offsetX: Math.round(viewportWidth / 2 - centerX),
    offsetY: Math.round(viewportHeight / 2 - centerY),
  };
}
