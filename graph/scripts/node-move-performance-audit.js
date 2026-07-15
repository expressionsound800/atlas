#!/usr/bin/env node

/*
 * Node Move Performance Audit measures bounded rerouting and geometry updates
 * for manual node movement without rebuilding stable layout layers.
 */
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { GRAPH_ROUTE_GRID_CELL } from "../graph-grid.js";
import { GRAPH_ROUTE_MODE_SPEED, buildIllustrationGraphViewModel } from "../graph-layout.js";
import { buildProjectionWithPrecomputedGraphViewModel } from "../graph-precompute.js";
import { validateGraphViewModel } from "../graph-view-model.js";
import { normalizeId } from "../graph-geometry.js";

const SCHEMA = "multihead-memory-graph.node_move_performance_audit.v1";
const DEFAULT_ITERATIONS = 14;
const DEFAULT_SETTLED_MAX_MS = 250;
const DEFAULT_PRECOMPUTED_APPLY_MAX_MS = 12;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

/** Reads one positive numeric performance option from equals-prefixed CLI syntax. */
function numberOption(name, fallback) {
  const arg = process.argv.find((value) => value.startsWith(`--${name}=`));
  const envName = `MH_${name.toUpperCase().replace(/-/g, "_")}`;
  const raw = arg ? arg.split("=").slice(1).join("=").trim() : process.env[envName];
  const number = Number(raw);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/** Checks one node-move latency, geometry, or controller-source invariant with evidence. */
function assertCondition(condition, message, details = {}) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

/** Rounds benchmark values to stable report precision without changing raw measurements. */
function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

/** Computes the median duration from a sorted copy of benchmark samples. */
function median(values = []) {
  const sorted = [...values].sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/** Measures repeated execution and returns median, percentile, minimum, and maximum timings. */
function benchmark(fn, iterations) {
  const samples = [];
  let value;
  for (let index = 0; index < Math.max(2, iterations); index += 1) {
    const start = performance.now();
    value = fn();
    samples.push(performance.now() - start);
  }
  return {
    minMs: round(Math.min(...samples)),
    medianMs: round(median(samples)),
    maxMs: round(Math.max(...samples)),
    samples: samples.map((sample) => round(sample)),
    value,
  };
}

/** Rounds a dragged coordinate to the Graph route-grid cell boundary. */
function snap(value) {
  return Math.max(0, Math.round((Number(value) || 0) / GRAPH_ROUTE_GRID_CELL) * GRAPH_ROUTE_GRID_CELL);
}

/** Builds the routed fixture used to compare full layout against manual-position application. */
function nodeMoveProjection() {
  const nodes = [{
    id: "origin",
    label: "Origin",
    kind: "kernel",
    description: "Synthetic source node for node-move performance audit.",
  }];
  const edges = [];
  const containers = [];

  for (let group = 0; group < 4; group += 1) {
    const nodeIds = [];
    let previousId = "origin";
    for (let index = 0; index < 5; index += 1) {
      const id = `group-${group}-node-${index}`;
      nodes.push({
        id,
        label: `Move Group ${group + 1} Node ${index + 1}`,
        kind: index === 0 ? "authority" : "memory",
        description: `Synthetic node ${index + 1} in move group ${group + 1}.`,
      });
      nodeIds.push(id);
      edges.push({
        from: previousId,
        to: id,
        kind: index % 2 === 0 ? "decision_flow" : "relationship",
      });
      if (index > 1) {
        edges.push({
          from: `group-${group}-node-${index - 2}`,
          to: id,
          kind: "checks",
        });
      }
      previousId = id;
    }
    containers.push({
      id: `container:move:${group}`,
      kind: "container",
      label: `Move Group ${group + 1}`,
      role: "audit",
      description: "Dense enough to exercise bounded rerouting without entering preview-only routing.",
      nodeIds,
    });
  }

  for (let group = 0; group < 3; group += 1) {
    edges.push({
      from: `group-${group}-node-4`,
      to: `group-${group + 1}-node-0`,
      kind: "cross_group",
    });
    edges.push({
      from: `group-${group + 1}-node-2`,
      to: `group-${group}-node-3`,
      kind: "checks",
    });
  }

  return {
    schema: "node-move-performance-audit",
    view: "generic-node-move-performance",
    nodes,
    edges,
    containers,
  };
}

/** Extracts one controller arrow-function body for static forbidden-call inspection. */
function functionBody(source, name) {
  const pattern = new RegExp(`const ${name} = \\([^)]*\\) => \\{([\\s\\S]*?)\\n  \\};`);
  const match = source.match(pattern);
  assertCondition(Boolean(match), `expected ${name} function in graph-illustration.js`);
  return match[1];
}

/** Scans controller move handlers for forbidden full-layout and DOM-rebuild calls. */
function staticMoveContracts() {
  const source = readFileSync(resolve(REPO_ROOT, "graph-illustration.js"), "utf8");
  const updateBody = functionBody(source, "updateNodeDrag");
  const endBody = functionBody(source, "endNodeDrag");
  const setManualBody = functionBody(source, "setManualNodePosition");
  const renderBody = functionBody(source, "renderActiveViewModel");
  const forbiddenPreviewCalls = [
    "ensureViewModel",
    "buildIllustrationGraphViewModel",
    "renderGraphContent",
    "applyViewport",
    "setManualNodePosition",
    "persistLayout",
    "viewModelCache",
    "layoutRevision",
  ];
  const previewViolations = forbiddenPreviewCalls.filter((token) => updateBody.includes(token));
  assertCondition(previewViolations.length === 0, "drag preview must stay transform-only", {
    previewViolations,
  });
  assertCondition(
    /style\.transform/.test(updateBody) && /is-drag-preview/.test(updateBody),
    "drag preview must update only the node transform and preview class",
  );
  assertCondition(
    setManualBody.includes("viewModelCache.clear()")
      && setManualBody.includes("activeViewModel = null")
      && setManualBody.includes("applyViewport()"),
    "manual drop must invalidate stale view-model cache and apply the settled view immediately",
  );
  assertCondition(
    endBody.indexOf("setManualNodePosition") >= 0
      && endBody.indexOf("style.transform = \"\"") > endBody.indexOf("setManualNodePosition"),
    "drop must keep the preview transform until the settled position is applied",
  );
  assertCondition(
    /layerMode:\s*"stable"/.test(renderBody)
      && /layers:\s*\["grid",\s*"containers",\s*"nodes"\]/.test(renderBody)
      && /scheduleCompleteRender/.test(renderBody),
    "settled render must apply stable node layers before the complete edge/label pass",
  );
  assertCondition(
    renderBody.includes("graphRenderComplexity(viewModel) <= GRAPH_LAYERED_RENDER_COMPLEXITY_THRESHOLD")
      && /layerMode:\s*"complete"/.test(renderBody),
    "small projections must avoid a redundant layered DOM rebuild",
  );
  return {
    previewTransformOnly: true,
    dropClearsPreviewAfterSettle: true,
    settledCacheInvalidation: true,
    layeredStableRender: true,
    smallProjectionOnePass: true,
  };
}

/** Derives the snapped manual destination for one node from a measured layout baseline. */
function manualNodePosition(baseViewModel, nodeId, delta = {}) {
  const node = (Array.isArray(baseViewModel.nodes) ? baseViewModel.nodes : [])
    .find((candidate) => normalizeId(candidate?.id) === normalizeId(nodeId));
  assertCondition(Boolean(node), "expected movable node in base view model", { nodeId });
  const target = {
    x: snap(Number(node.x || 0) + Number(delta.x || 0)),
    y: snap(Number(node.y || 0) + Number(delta.y || 0)),
  };
  const stored = {
    x: target.x + Number(baseViewModel.normalizationOffset?.x || 0),
    y: target.y + Number(baseViewModel.normalizationOffset?.y || 0),
  };
  return { node, target, stored };
}

/** Verifies moved-node coordinates, manual authority, unaffected peers, and bounded routing output. */
function assertMovedViewModel(viewModel, nodeId, target) {
  const manualNode = (Array.isArray(viewModel.nodes) ? viewModel.nodes : [])
    .find((node) => normalizeId(node?.id) === normalizeId(nodeId));
  assertCondition(manualNode?.positionSource === "manual-layout", "moved node must remain manual-layout sourced", {
    nodeId,
    manualNode,
  });
  assertCondition(
    Math.abs(Number(manualNode.x) - target.x) <= 1
      && Math.abs(Number(manualNode.y) - target.y) <= 1,
    "settled reroute must retain the rendered drop position",
    {
      target,
      actual: manualNode ? { x: manualNode.x, y: manualNode.y } : null,
    },
  );
  const routeBudgets = [...new Set((Array.isArray(viewModel.edges) ? viewModel.edges : [])
    .map((edge) => String(edge.routeBudget || ""))
    .filter(Boolean))]
    .sort();
  assertCondition(routeBudgets.length === 1 && routeBudgets[0] === "bounded", "manual node move must use bounded reroute budget", {
    routeBudgets,
  });
  return {
    node: manualNode.id,
    x: manualNode.x,
    y: manualNode.y,
    routeBudget: routeBudgets[0],
  };
}

/** Runs node-move equivalence and performance budgets against local and precomputed geometry. */
function main() {
  const iterations = Math.max(4, Math.floor(numberOption("iterations", DEFAULT_ITERATIONS)));
  const settledMaxMs = numberOption("settled-max-ms", DEFAULT_SETTLED_MAX_MS);
  const precomputedApplyMaxMs = numberOption("precomputed-apply-max-ms", DEFAULT_PRECOMPUTED_APPLY_MAX_MS);
  const projection = nodeMoveProjection();
  const moveNodeId = "group-2-node-2";
  const baseOptions = {
    memoryGraph: projection,
    presentationMode: "compact",
    routeMode: GRAPH_ROUTE_MODE_SPEED,
  };
  const baseViewModel = buildIllustrationGraphViewModel(baseOptions);
  const { target, stored } = manualNodePosition(baseViewModel, moveNodeId, {
    x: GRAPH_ROUTE_GRID_CELL * 3,
    y: GRAPH_ROUTE_GRID_CELL * 2,
  });
  const nodePositions = { [moveNodeId]: stored };
  const movedOptions = {
    ...baseOptions,
    nodePositions,
  };

  const precomputeStart = performance.now();
  const projectionWithPacket = buildProjectionWithPrecomputedGraphViewModel(projection, {
    presentationMode: "compact",
    routeMode: GRAPH_ROUTE_MODE_SPEED,
  });
  const precomputeMs = performance.now() - precomputeStart;
  const packetValidation = validateGraphViewModel(projectionWithPacket.viewModel);
  assertCondition(packetValidation.valid, "precomputed node-move packet must validate", {
    validation: packetValidation,
  });
  const precomputedOptions = {
    memoryGraph: projectionWithPacket,
    presentationMode: "compact",
    routeMode: GRAPH_ROUTE_MODE_SPEED,
  };
  const precomputedMovedOptions = {
    ...precomputedOptions,
    nodePositions,
  };

  const contracts = staticMoveContracts();
  buildIllustrationGraphViewModel(movedOptions);
  buildIllustrationGraphViewModel(precomputedOptions);
  buildIllustrationGraphViewModel(precomputedMovedOptions);

  const rawSettled = benchmark(() => buildIllustrationGraphViewModel(movedOptions), iterations);
  const precomputedApply = benchmark(() => buildIllustrationGraphViewModel(precomputedOptions), iterations);
  const precomputedWithManualReroute = benchmark(
    () => buildIllustrationGraphViewModel(precomputedMovedOptions),
    iterations,
  );

  assertCondition(rawSettled.medianMs <= settledMaxMs, "raw settled node-move reroute exceeded budget", {
    settledMaxMs,
    rawSettled,
  });
  assertCondition(
    precomputedWithManualReroute.medianMs <= settledMaxMs,
    "precomputed projection with manual move exceeded settled reroute budget",
    {
      settledMaxMs,
      precomputedWithManualReroute,
    },
  );
  assertCondition(precomputedApply.medianMs <= precomputedApplyMaxMs, "precomputed no-move apply exceeded budget", {
    precomputedApplyMaxMs,
    precomputedApply,
  });
  assertCondition(precomputedApply.value.precomputed === true, "no-move precomputed projection must consume packet");
  assertCondition(
    precomputedWithManualReroute.value.precomputed !== true,
    "manual node move must bypass stale precomputed geometry when raw graph is available",
  );
  const rawSettledNode = assertMovedViewModel(rawSettled.value, moveNodeId, target);
  const precomputedSettledNode = assertMovedViewModel(precomputedWithManualReroute.value, moveNodeId, target);

  console.log(JSON.stringify({
    ok: true,
    schema: SCHEMA,
    iterations,
    thresholds: {
      settledMaxMs,
      precomputedApplyMaxMs,
    },
    contracts,
    projection: {
      nodes: projection.nodes.length,
      edges: projection.edges.length,
      containers: projection.containers.length,
    },
    move: {
      nodeId: normalizeId(moveNodeId),
      target,
      stored,
      rawSettledNode,
      precomputedSettledNode,
    },
    timings: {
      precomputeMs: round(precomputeMs),
      rawSettled: {
        minMs: rawSettled.minMs,
        medianMs: rawSettled.medianMs,
        maxMs: rawSettled.maxMs,
      },
      precomputedApply: {
        minMs: precomputedApply.minMs,
        medianMs: precomputedApply.medianMs,
        maxMs: precomputedApply.maxMs,
      },
      precomputedWithManualReroute: {
        minMs: precomputedWithManualReroute.minMs,
        medianMs: precomputedWithManualReroute.medianMs,
        maxMs: precomputedWithManualReroute.maxMs,
      },
    },
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    schema: SCHEMA,
    message: error.message,
    details: error.details || null,
  }, null, 2));
  process.exit(1);
}
