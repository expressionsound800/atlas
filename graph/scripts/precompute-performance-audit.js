#!/usr/bin/env node

/*
 * Precompute Performance Audit compares local quality-layout cost with
 * validated provider-precomputed view-model consumption across fixed fixtures.
 */
import { performance } from "node:perf_hooks";
import { buildIllustrationGraphViewModel } from "../graph-layout.js";
import { buildProjectionWithPrecomputedGraphViewModel } from "../graph-precompute.js";
import { validateGraphViewModel } from "../graph-view-model.js";

const DEFAULT_ITERATIONS = 18;
const DEFAULT_MIN_SPEEDUP = 1.4;

/** Reads one positive precompute benchmark option from equals-prefixed CLI syntax. */
function numberOption(name, fallback) {
  const arg = process.argv.find((value) => value.startsWith(`--${name}=`));
  const raw = arg ? arg.split("=").slice(1).join("=").trim() : process.env[`MH_${name.toUpperCase().replace(/-/g, "_")}`];
  const number = Number(raw);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/** Checks one precomputed-view equivalence or latency budget with structured measurements. */
function assertCondition(condition, message, details = {}) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

/** Computes the median precompute duration from a sorted copy of samples. */
function median(values = []) {
  const sorted = [...values].sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/** Rounds reported precompute timings to stable human-readable precision. */
function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

/** Measures repeated view-model construction and summarizes distribution percentiles. */
function benchmark(fn, iterations) {
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  return {
    min: Math.min(...samples),
    median: median(samples),
    max: Math.max(...samples),
    samples,
  };
}

/** Builds a representative multi-branch projection for precompute performance comparison. */
function performanceProjection() {
  const nodes = [
    {
      id: "origin",
      label: "Origin",
      kind: "kernel",
      description: "Synthetic source node for backend precompute performance audit.",
    },
  ];
  const edges = [];
  const containers = [];

  for (let group = 0; group < 6; group += 1) {
    const containerNodeIds = [];
    let previousId = "origin";
    for (let index = 0; index < 10; index += 1) {
      const id = `group-${group}-node-${index}`;
      nodes.push({
        id,
        label: `Group ${group + 1} Node ${index + 1}`,
        kind: index % 3 === 0 ? "authority" : "memory",
        description: `Synthetic node ${index + 1} in group ${group + 1}.`,
      });
      containerNodeIds.push(id);
      edges.push({
        from: previousId,
        to: id,
        kind: index % 2 === 0 ? "decision_flow" : "session_context",
      });
      if (index > 1) {
        edges.push({
          from: `group-${group}-node-${index - 2}`,
          to: id,
          kind: "relationship",
        });
      }
      previousId = id;
    }
    containers.push({
      id: `container:performance:${group}`,
      kind: "container",
      label: `Performance Group ${group + 1}`,
      role: "audit",
      description: "Dense enough to exercise measurement, placement, routing, and label handling.",
      nodeIds: containerNodeIds,
    });
  }

  for (let group = 0; group < 5; group += 1) {
    edges.push({
      from: `group-${group}-node-9`,
      to: `group-${group + 1}-node-0`,
      kind: "cross_group",
    });
    edges.push({
      from: `group-${group + 1}-node-3`,
      to: `group-${group}-node-6`,
      kind: "checks",
    });
  }

  return {
    schema: "precompute-performance-audit",
    view: "generic-performance",
    nodes,
    edges,
    containers,
  };
}

/** Extracts geometry and identity facts used to compare local and precomputed results. */
function viewModelSummary(viewModel = {}) {
  return {
    nodes: Array.isArray(viewModel.nodes) ? viewModel.nodes.length : 0,
    edges: Array.isArray(viewModel.edges) ? viewModel.edges.length : 0,
    containers: Array.isArray(viewModel.containers) ? viewModel.containers.length : 0,
    width: Math.round(Number(viewModel.width || 0)),
    height: Math.round(Number(viewModel.height || 0)),
    precomputed: viewModel.precomputed === true,
  };
}

/** Runs local-versus-precomputed equivalence checks and enforces configured latency budgets. */
function main() {
  const iterations = Math.max(4, Math.floor(numberOption("iterations", DEFAULT_ITERATIONS)));
  const minSpeedup = numberOption("min-speedup", DEFAULT_MIN_SPEEDUP);
  const projection = performanceProjection();

  const localOptions = {
    memoryGraph: projection,
    presentationMode: "compact",
    routeMode: "quality",
  };

  const precomputeStart = performance.now();
  const projectionWithPacket = buildProjectionWithPrecomputedGraphViewModel(projection, {
    presentationMode: "compact",
    routeMode: "quality",
  });
  const precomputeMs = performance.now() - precomputeStart;
  const packetValidation = validateGraphViewModel(projectionWithPacket.viewModel);
  assertCondition(packetValidation.valid, "precomputed packet must validate before benchmarking", {
    validation: packetValidation,
  });

  const precomputedOptions = {
    memoryGraph: projectionWithPacket,
    presentationMode: "compact",
    routeMode: "quality",
  };

  buildIllustrationGraphViewModel(localOptions);
  buildIllustrationGraphViewModel(precomputedOptions);

  const local = benchmark(() => buildIllustrationGraphViewModel(localOptions), iterations);
  const precomputed = benchmark(() => buildIllustrationGraphViewModel(precomputedOptions), iterations);
  const localViewModel = buildIllustrationGraphViewModel(localOptions);
  const precomputedViewModel = buildIllustrationGraphViewModel(precomputedOptions);
  const speedup = local.median / Math.max(0.001, precomputed.median);

  assertCondition(precomputedViewModel.precomputed === true, "precomputed benchmark path must consume packet");
  assertCondition(speedup >= minSpeedup, "precomputed packet consumption must be materially faster than local layout", {
    minSpeedup,
    speedup: round(speedup),
    localMedianMs: round(local.median),
    precomputedMedianMs: round(precomputed.median),
  });

  console.log(JSON.stringify({
    ok: true,
    iterations,
    minSpeedup,
    speedup: round(speedup),
    precomputeMs: round(precomputeMs),
    local: {
      minMs: round(local.min),
      medianMs: round(local.median),
      maxMs: round(local.max),
    },
    precomputed: {
      minMs: round(precomputed.min),
      medianMs: round(precomputed.median),
      maxMs: round(precomputed.max),
    },
    localViewModel: viewModelSummary(localViewModel),
    precomputedViewModel: viewModelSummary(precomputedViewModel),
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    message: error.message,
    details: error.details || null,
  }, null, 2));
  process.exit(1);
}
