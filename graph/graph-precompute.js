/*
 * Graph Precompute builds validated backend-ready view-model packets so hosts
 * can avoid repeating quality layout work in the browser.
 */
import {
  GRAPH_ROUTE_MODE_QUALITY,
  buildIllustrationGraphViewModel,
  normalizeGraphRouteMode,
} from "./graph-layout.js";
import {
  GRAPH_VIEW_MODEL_SCHEMA,
  normalizeGraphViewModel,
  validateGraphViewModel,
} from "./graph-view-model.js";
import { normalizeGraphPresentationMode } from "./graph-view-state.js";

const GRAPH_PRECOMPUTE_PRODUCER = "multihead-memory-graph";

/** Checks whether precomputed metadata has an object shape safe for shallow composition. */
function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Removes recursively embedded precomputed view models from a copied projection fragment. */
function stripNestedViewModel(value = {}) {
  if (!isPlainObject(value)) return value;
  const next = { ...value };
  delete next.viewModel;
  return Object.keys(next).length ? next : undefined;
}

/** Returns a projection copy without any prior precomputed view-model authority. */
export function stripGraphPrecomputedViewModel(projection = {}) {
  if (!isPlainObject(projection)) return { nodes: [], edges: [] };
  const next = { ...projection };
  delete next.viewModel;
  delete next.viewModels;
  delete next.precomputedViewModel;
  const geometry = stripNestedViewModel(next.geometry);
  const layout = stripNestedViewModel(next.layout);
  if (geometry) next.geometry = geometry;
  else delete next.geometry;
  if (layout) next.layout = layout;
  else delete next.layout;
  return next;
}

/** Builds provenance and timing metadata for one generated precomputed view model. */
function precomputeMetadata(viewModel = {}, options = {}) {
  return {
    ...(isPlainObject(viewModel.metadata) ? viewModel.metadata : {}),
    ...(isPlainObject(options.metadata) ? options.metadata : {}),
    producer: GRAPH_PRECOMPUTE_PRODUCER,
    routeMode: normalizeGraphRouteMode(options.routeMode),
  };
}

/** Builds and validates a presentation-specific view model suitable for provider-side caching. */
export function buildPrecomputedGraphViewModel(projection = {}, options = {}) {
  const presentationMode = normalizeGraphPresentationMode(options.presentationMode);
  const routeMode = normalizeGraphRouteMode(options.routeMode || GRAPH_ROUTE_MODE_QUALITY);
  const sourceProjection = stripGraphPrecomputedViewModel(projection);
  const localViewModel = buildIllustrationGraphViewModel({
    ...options,
    memoryGraph: sourceProjection,
    presentationMode,
    routeMode,
    selectedNodeId: "",
    precomputedViewModel: null,
  });
  const packet = normalizeGraphViewModel({
    ...localViewModel,
    schema: GRAPH_VIEW_MODEL_SCHEMA,
    source: "precomputed",
    presentationMode,
    metadata: precomputeMetadata(localViewModel, { ...options, routeMode }),
  }, {
    presentationMode,
    selectedNodeId: "",
    routeBudget: localViewModel.routeBudget || routeMode,
  });
  const validation = validateGraphViewModel(packet);
  if (options.validate !== false && !validation.valid) {
    const error = new Error("precomputed graph view model failed validation");
    error.details = validation;
    throw error;
  }
  return packet;
}

/** Attaches a freshly built view model to a projection without mutating provider source data. */
export function buildProjectionWithPrecomputedGraphViewModel(projection = {}, options = {}) {
  const sourceProjection = stripGraphPrecomputedViewModel(projection);
  const viewModel = buildPrecomputedGraphViewModel(sourceProjection, options);
  return {
    ...sourceProjection,
    viewModel,
    metadata: {
      ...(isPlainObject(sourceProjection.metadata) ? sourceProjection.metadata : {}),
      precomputedViewModel: {
        schema: GRAPH_VIEW_MODEL_SCHEMA,
        presentationMode: viewModel.presentationMode,
        producer: GRAPH_PRECOMPUTE_PRODUCER,
      },
    },
  };
}
