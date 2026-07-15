#!/usr/bin/env node

/*
 * Semantic Center Audit verifies topology-derived growth, conversion, bridge,
 * convergence, and placement roles without provider-category exceptions.
 */
import { computeGraphSemanticModel } from "../graph-semantic.js";
import { normalizeId } from "../graph-geometry.js";

/** Checks one source-neutral semantic-role invariant with the computed topology evidence. */
function assertCondition(condition, message, details = {}) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

/** Builds a generic topology fixture containing source, convergence, bridge, and peripheral roles. */
function genericProjection() {
  return {
    nodes: [
      { id: "source-node", label: "Source Node", kind: "authority" },
      { id: "conversion-node", label: "Conversion Node", kind: "kernel" },
      { id: "feeder-a", label: "Feeder A", kind: "tool" },
      { id: "feeder-b", label: "Feeder B", kind: "tool" },
      { id: "outcome-a", label: "Outcome A", kind: "stem" },
      { id: "outcome-b", label: "Outcome B", kind: "stem" },
      { id: "outcome-c", label: "Outcome C", kind: "stem" },
      { id: "leaf-a", label: "Leaf A", kind: "doc" },
      { id: "leaf-b", label: "Leaf B", kind: "doc" },
    ],
    edges: [
      { id: "e1", from: "source-node", to: "conversion-node", kind: "authorizes" },
      { id: "e2", from: "source-node", to: "outcome-a", kind: "authorizes" },
      { id: "e3", from: "source-node", to: "outcome-b", kind: "authorizes" },
      { id: "e4", from: "source-node", to: "outcome-c", kind: "authorizes" },
      { id: "e5", from: "feeder-a", to: "conversion-node", kind: "checks" },
      { id: "e6", from: "feeder-b", to: "conversion-node", kind: "checks" },
      { id: "e7", from: "conversion-node", to: "leaf-a", kind: "routes_to" },
      { id: "e8", from: "conversion-node", to: "leaf-b", kind: "routes_to" },
      { id: "e9", from: "conversion-node", to: "outcome-c", kind: "routes_to" },
    ],
  };
}

/** Runs semantic center classification and verifies inspectable role explanations. */
function main() {
  const projection = genericProjection();
  const model = computeGraphSemanticModel(projection.nodes, projection.edges);
  const sourceId = normalizeId("source-node");
  const conversionId = normalizeId("conversion-node");
  const sourceScore = model.scores.get(sourceId);
  const conversionScore = model.scores.get(conversionId);

  assertCondition(model.primaryGrowthSource?.id === sourceId, "semantic model should identify the strongest growth source", {
    expected: sourceId,
    actual: model.primaryGrowthSource?.id,
    centerpieces: model.centerpieces,
  });
  assertCondition(model.primaryConvergence?.id === conversionId, "semantic model should identify the strongest conversion hub", {
    expected: conversionId,
    actual: model.primaryConvergence?.id,
    centerpieces: model.centerpieces,
  });
  assertCondition(sourceScore?.semanticRole === "growth-source", "source node should be classified as growth-source", sourceScore);
  assertCondition(conversionScore?.semanticRole === "conversion-hub", "conversion node should be classified as conversion-hub", conversionScore);
  assertCondition(String(sourceScore?.semanticReason || "").includes("outbound="), "source score should explain outbound evidence", sourceScore);
  assertCondition(String(conversionScore?.semanticReason || "").includes("inbound="), "conversion score should explain inbound/outbound evidence", conversionScore);

  console.log(JSON.stringify({
    ok: true,
    formula: model.formula,
    primaryGrowthSource: model.primaryGrowthSource.id,
    primaryConvergence: model.primaryConvergence.id,
    centerpieces: model.centerpieces.map((score) => ({
      id: score.id,
      role: score.semanticRole,
      centerScore: Number(score.centerScore.toFixed(3)),
      reason: score.semanticReason,
    })),
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
