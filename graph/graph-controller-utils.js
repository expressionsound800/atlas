/*
 * Controller Utilities provide storage, hash-route, zoom, and selection
 * helpers used by the Graph controller without owning application state.
 */
import {
  GRAPH_ROUTE_MODE_SPEED,
} from "./graph-layout.js";
import {
  ATLAS_SOURCE_CATEGORIES,
} from "./source-atlas.js";

export const GRAPH_INITIAL_FIT_PADDING = 80;
export const GRAPH_FIT_MAX_ZOOM = 1.03;
export const GRAPH_LENS_STORAGE_KEY = "multihead-memory-graph.lens-state.v2";
export const GRAPH_DEFAULT_SOURCE_CATEGORY = "architecture";
export const GRAPH_NO_SELECTION_NODE_ID = "__NO_SELECTION__";

const GRAPH_ZOOM_STEPS = Object.freeze([
  0.18,
  0.22,
  0.26,
  0.3,
  0.35,
  0.4,
  0.45,
  0.5,
  0.56,
  0.63,
  0.71,
  0.8,
  0.9,
  1,
  1.1,
  1.22,
  1.35,
  1.5,
  1.67,
  1.85,
  2,
]);

const SOURCE_CATEGORY_HASH_ALIASES = Object.freeze({
  sessions: "workstreams",
  workstreams: "workstreams",
  git: "git",
  "git-gate": "git",
  gitgate: "git",
  backlog: "backlog",
  architecture: "architecture",
  arch: "architecture",
});

/** Normalizes controller node identities to the uppercase selection and hash convention. */
export function normalizeNodeId(value) {
  return String(value || "").trim().toUpperCase();
}

/** Resolves source-category aliases and falls back to the supported architecture lens. */
export function normalizeSourceCategoryId(value) {
  const categoryId = SOURCE_CATEGORY_HASH_ALIASES[String(value || "").trim().toLowerCase()]
    || String(value || "").trim().toLowerCase();
  return ATLAS_SOURCE_CATEGORIES.some((category) => category.id === categoryId)
    ? categoryId
    : GRAPH_DEFAULT_SOURCE_CATEGORY;
}

/** Parses the active source category from path-style or query-style hash routes. */
export function sourceCategoryFromHash(hash = "") {
  const raw = String(hash || "").replace(/^#/, "").trim();
  if (!raw) return "";
  if (raw.includes("=")) {
    const params = new URLSearchParams(raw.replace(/^\?/, ""));
    return SOURCE_CATEGORY_HASH_ALIASES[String(params.get("category") || params.get("source") || "").toLowerCase()] || "";
  }
  const [categoryPart] = decodeURIComponent(raw).replace(/^\/+/, "").split(/[/?]/);
  return SOURCE_CATEGORY_HASH_ALIASES[String(categoryPart || "").toLowerCase()] || "";
}

/** Extracts an architecture room identifier only from supported architecture hash routes. */
export function architectureRoomIdFromHash(hash = "") {
  const raw = String(hash || "").replace(/^#/, "").trim();
  if (!raw) return "";
  if (raw.includes("=")) {
    const params = new URLSearchParams(raw.replace(/^\?/, ""));
    const category = SOURCE_CATEGORY_HASH_ALIASES[String(params.get("category") || params.get("source") || "").toLowerCase()] || "";
    return category === "architecture" ? normalizeNodeId(params.get("room") || params.get("roomId") || params.get("slice") || "") : "";
  }
  const parts = decodeURIComponent(raw).replace(/^\/+/, "").split(/[/?]/).filter(Boolean);
  const category = SOURCE_CATEGORY_HASH_ALIASES[String(parts[0] || "").toLowerCase()] || "";
  if (category !== "architecture") return "";
  const roomIndex = parts.findIndex((part) => ["room", "rooms", "slice", "slices"].includes(String(part || "").toLowerCase()));
  if (roomIndex < 0 || roomIndex >= parts.length - 1) return "";
  return normalizeNodeId(parts[roomIndex + 1]);
}

/** Reads one browser search parameter without assuming a window in non-browser audits. */
export function searchParamValue(name) {
  if (typeof window === "undefined" || !window.location) return "";
  return new URLSearchParams(window.location.search).get(name) || "";
}

/** Parses common textual boolean forms while preserving the caller's fallback for ambiguity. */
export function optionEnabled(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

/** Builds the canonical hash route for a normalized Graph source category. */
export function hashForSourceCategory(categoryId) {
  if (categoryId === "workstreams") return "#sessions";
  return `#${categoryId}`;
}

/** Builds a portable architecture-room hash or the architecture overview route. */
export function hashForArchitectureRoom(roomId) {
  const normalizedRoomId = normalizeNodeId(roomId);
  return normalizedRoomId ? `#architecture/room/${encodeURIComponent(normalizedRoomId)}` : "#architecture";
}

/** Normalizes edge selection identity without changing provider-defined case or punctuation. */
export function normalizeEdgeId(value) {
  return String(value || "").trim();
}

/** Checks whether persisted controller state is an object rather than an array or primitive. */
export function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Converts numeric controller input to a finite value or an explicit null sentinel. */
export function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Normalizes a scalar display value while preserving an explicit empty-value fallback. */
export function compactValue(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

/** Collapses and bounds controller-facing prose for buttons, panels, and accessible labels. */
export function compactText(value, maxLength = 260) {
  const text = compactValue(value).replace(/\s+/g, " ");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

/** Reads optional persisted lens state and safely ignores absent or malformed browser storage. */
export function readStoredGraphLensState(storageKey = GRAPH_LENS_STORAGE_KEY) {
  if (typeof window === "undefined" || !window.localStorage) return {};
  try {
    const raw = window.localStorage.getItem(storageKey);
    return raw ? JSON.parse(raw) : {};
  } catch (_error) {
    return {};
  }
}

/** Writes optional lens preferences without making browser storage required for operation. */
export function writeStoredGraphLensState(storageKey = GRAPH_LENS_STORAGE_KEY, value = {}) {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(value));
  } catch (_error) {
    // Persistence is optional for embedded hosts.
  }
}

/** Validates persisted zoom and offsets as one complete finite viewport record. */
export function normalizeViewportState(value = {}) {
  if (!isPlainObject(value)) return null;
  const zoom = finiteNumber(value.zoom);
  const offsetX = finiteNumber(value.offsetX);
  const offsetY = finiteNumber(value.offsetY);
  if (zoom === null || offsetX === null || offsetY === null) return null;
  return {
    zoom,
    offsetX,
    offsetY,
  };
}

/** Validates a persisted floating-panel position as finite left and top coordinates. */
export function normalizePanelPosition(value = {}) {
  if (!isPlainObject(value)) return null;
  const left = finiteNumber(value.left);
  const top = finiteNumber(value.top);
  if (left === null || top === null) return null;
  return { left, top };
}

/** Creates an accessible button and applies only concrete boolean or scalar attributes. */
export function createButton(className, text, attributes = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = text;
  Object.entries(attributes).forEach(([name, value]) => {
    if (value === false || value === null || value === undefined) return;
    if (value === true) {
      button.setAttribute(name, "");
    } else {
      button.setAttribute(name, String(value));
    }
  });
  return button;
}

/** Selects the next discrete zoom level in the requested direction within supported limits. */
export function nextZoomStep(value, direction) {
  const current = Number(value) || 1;
  if (direction > 0) {
    return GRAPH_ZOOM_STEPS.find((step) => step > current + 0.001) || GRAPH_ZOOM_STEPS.at(-1);
  }
  return [...GRAPH_ZOOM_STEPS].reverse().find((step) => step < current - 0.001) || GRAPH_ZOOM_STEPS[0];
}

/** Returns the compact user-facing label for quality or speed routing mode. */
export function routeModeLabel(routeMode) {
  return routeMode === GRAPH_ROUTE_MODE_SPEED ? "prefer speed" : "quality";
}

/** Invokes a direct callback and emits the equivalent bubbling Graph custom event. */
export function invokeGraphCallback(callback, payload, root, eventName) {
  if (typeof callback === "function") callback(payload);
  if (root && typeof CustomEvent !== "undefined") {
    root.dispatchEvent(new CustomEvent(eventName, {
      detail: payload,
      bubbles: true,
    }));
  }
}

/** Resolves explicit controller selection before falling back to a view-model selected node. */
export function viewModelSelectedNode(viewModel = {}, selectedNodeId = "") {
  const normalizedSelectedId = normalizeNodeId(selectedNodeId);
  return (Array.isArray(viewModel.nodes) ? viewModel.nodes : []).find((node) =>
    normalizeNodeId(node.id) === normalizedSelectedId
  ) || (Array.isArray(viewModel.nodes) ? viewModel.nodes : []).find((node) => node.selected === true) || null;
}

/** Resolves an explicit edge selection against the current normalized view model. */
export function viewModelSelectedEdge(viewModel = {}, selectedEdgeId = "") {
  const normalizedSelectedId = normalizeEdgeId(selectedEdgeId);
  if (!normalizedSelectedId) return null;
  return (Array.isArray(viewModel.edges) ? viewModel.edges : []).find((edge) =>
    normalizeEdgeId(edge.id) === normalizedSelectedId
  ) || null;
}
