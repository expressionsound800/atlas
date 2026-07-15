/*
 * Graph Semantic scores topology-only growth, conversion, bridge, and
 * convergence roles used by layout without importing provider categories.
 */
import {
  compareIds,
  normalizeId,
  normalizeKind,
} from "./graph-geometry.js";

const GRAPH_SEMANTIC_REACH_DEPTH = 4;
const GRAPH_SEMANTIC_CENTER_THRESHOLD = 0.42;

/** Returns semantic-model arrays unchanged and converts non-array provider values to empty. */
function listFrom(value) {
  return Array.isArray(value) ? value : [];
}

/** Converts a numeric semantic signal to the closed zero-to-one interval. */
function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

/** Normalizes one raw topology score against the maximum observed graph value. */
function normalizeScore(value, maxValue) {
  if (!Number.isFinite(Number(value)) || !Number.isFinite(Number(maxValue)) || maxValue <= 0) return 0;
  return clamp01(Number(value) / Number(maxValue));
}

/** Adds a weighted occurrence to a token or topology counter map. */
function mapIncrement(map, key, amount = 1) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + amount);
}

/** Returns graph identifiers in the shared deterministic comparison order. */
function sortedIds(values = []) {
  return [...values].sort(compareIds);
}

/** Maps normalized relationship kinds to their topology traversal influence. */
function edgeKindWeight(kind) {
  const normalized = normalizeKind(kind);
  if (normalized === "control") return 1.18;
  if (normalized === "timing") return 1.08;
  if (normalized === "binding") return 1;
  return 0.96;
}

/** Counts distinct non-empty topology values such as incoming relationship kinds. */
function uniqueCount(values = []) {
  return new Set(values.filter(Boolean)).size;
}

/** Converts a semantic metric to a finite number with neutral zero fallback. */
function finiteOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/** Builds normalized adjacency maps containing only valid non-self relationships. */
function buildSemanticGraph(nodes = [], edges = []) {
  const nodeList = listFrom(nodes)
    .map((node, index) => ({
      ...node,
      id: normalizeId(node?.id),
      graphOrder: Number.isFinite(Number(node?.graphOrder)) ? Number(node.graphOrder) : index,
    }))
    .filter((node) => node.id);
  const nodeById = new Map(nodeList.map((node) => [node.id, node]));
  const incoming = new Map(nodeList.map((node) => [node.id, []]));
  const outgoing = new Map(nodeList.map((node) => [node.id, []]));
  const edgeList = listFrom(edges)
    .map((edge, index) => ({
      ...edge,
      id: String(edge?.id || `semantic-edge:${index + 1}`).trim(),
      from: normalizeId(edge?.from),
      to: normalizeId(edge?.to),
      kind: normalizeKind(edge?.kind || "relationship"),
    }))
    .filter((edge) => edge.from && edge.to && edge.from !== edge.to
      && nodeById.has(edge.from) && nodeById.has(edge.to));

  for (const edge of edgeList) {
    outgoing.get(edge.from).push(edge);
    incoming.get(edge.to).push(edge);
  }

  for (const id of nodeById.keys()) {
    outgoing.get(id).sort((left, right) => compareIds(left.to, right.to) || compareIds(left.kind, right.kind));
    incoming.get(id).sort((left, right) => compareIds(left.from, right.from) || compareIds(left.kind, right.kind));
  }

  return {
    nodes: nodeList,
    edges: edgeList,
    nodeById,
    incoming,
    outgoing,
  };
}

/** Computes depth-decayed weighted reachability from one node through a directed adjacency map. */
function reachScore(startId, adjacency = new Map(), maxDepth = GRAPH_SEMANTIC_REACH_DEPTH) {
  const queue = [{ id: startId, depth: 0, weight: 1 }];
  const bestDepth = new Map([[startId, 0]]);
  let score = 0;

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const item = queue[cursor];
    if (item.depth >= maxDepth) continue;
    for (const edge of adjacency.get(item.id) || []) {
      const nextId = edge.to || edge.from;
      const nextDepth = item.depth + 1;
      if (bestDepth.has(nextId) && bestDepth.get(nextId) <= nextDepth) continue;
      bestDepth.set(nextId, nextDepth);
      const edgeWeight = edgeKindWeight(edge.kind);
      const decayed = edgeWeight / (nextDepth + 0.65);
      score += decayed;
      queue.push({ id: nextId, depth: nextDepth, weight: decayed });
    }
  }

  return {
    score,
    ids: [...bestDepth.keys()].filter((id) => id !== startId),
  };
}

/** Reverses incoming adjacency so upstream reach can use the same traversal algorithm. */
function reverseEdgesByNode(incoming = new Map()) {
  const reverse = new Map();
  for (const [id, edges] of incoming.entries()) {
    reverse.set(id, edges.map((edge) => ({
      ...edge,
      to: edge.from,
      from: edge.to,
    })));
  }
  return reverse;
}

/** Derives the source-neutral semantic kind token used in structural contexts. */
function nodeKindToken(node = {}) {
  return normalizeKind(node?.memoryKind || node?.kind || "node") || "node";
}

/** Adds one weighted local topology feature to a node's skip-gram context. */
function addContext(contexts, nodeId, token, weight = 1) {
  if (!contexts.has(nodeId)) contexts.set(nodeId, new Map());
  mapIncrement(contexts.get(nodeId), token, weight);
}

/** Builds first- and second-hop directional relation contexts for every graph node. */
function buildSkipGramContexts(graph) {
  const contexts = new Map(graph.nodes.map((node) => [node.id, new Map()]));

  for (const node of graph.nodes) {
    const nodeId = node.id;
    for (const edge of graph.outgoing.get(nodeId) || []) {
      const target = graph.nodeById.get(edge.to);
      addContext(contexts, nodeId, `out:${edge.kind}:${nodeKindToken(target)}`, edgeKindWeight(edge.kind));
      addContext(contexts, nodeId, `target:${edge.to}`, 0.6);
      for (const nextEdge of graph.outgoing.get(edge.to) || []) {
        const terminal = graph.nodeById.get(nextEdge.to);
        addContext(contexts, nodeId, `out2:${edge.kind}>${nextEdge.kind}:${nodeKindToken(terminal)}`, 0.45);
      }
    }
    for (const edge of graph.incoming.get(nodeId) || []) {
      const source = graph.nodeById.get(edge.from);
      addContext(contexts, nodeId, `in:${edge.kind}:${nodeKindToken(source)}`, edgeKindWeight(edge.kind));
      addContext(contexts, nodeId, `source:${edge.from}`, 0.6);
      for (const previousEdge of graph.incoming.get(edge.from) || []) {
        const origin = graph.nodeById.get(previousEdge.from);
        addContext(contexts, nodeId, `in2:${previousEdge.kind}>${edge.kind}:${nodeKindToken(origin)}`, 0.45);
      }
    }
  }

  return contexts;
}

/** Applies inverse document frequency so rare topology contexts contribute more affinity. */
function weightedContextVectors(contexts = new Map()) {
  const documentFrequency = new Map();
  for (const vector of contexts.values()) {
    for (const token of vector.keys()) mapIncrement(documentFrequency, token, 1);
  }
  const count = Math.max(1, contexts.size);
  const weighted = new Map();
  for (const [id, vector] of contexts.entries()) {
    const next = new Map();
    for (const [token, value] of vector.entries()) {
      const idf = Math.log(1 + count / (1 + (documentFrequency.get(token) || 0)));
      next.set(token, value * idf);
    }
    weighted.set(id, next);
  }
  return weighted;
}

/** Computes cosine similarity between sparse weighted topology-context vectors. */
function cosineSimilarity(left = new Map(), right = new Map()) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (const value of left.values()) leftNorm += value * value;
  for (const value of right.values()) rightNorm += value * value;
  if (leftNorm <= 0 || rightNorm <= 0) return 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  for (const [token, value] of small.entries()) dot += value * (large.get(token) || 0);
  return dot / Math.sqrt(leftNorm * rightNorm);
}

/** Computes each node's mean affinity to its four closest structural peers. */
function semanticAffinityById(weightedContexts = new Map()) {
  const ids = sortedIds(weightedContexts.keys());
  const topById = new Map(ids.map((id) => [id, []]));
  for (let leftIndex = 0; leftIndex < ids.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < ids.length; rightIndex += 1) {
      const leftId = ids[leftIndex];
      const rightId = ids[rightIndex];
      const similarity = cosineSimilarity(weightedContexts.get(leftId), weightedContexts.get(rightId));
      if (similarity <= 0) continue;
      topById.get(leftId).push(similarity);
      topById.get(rightId).push(similarity);
    }
  }

  const affinity = new Map();
  for (const [id, values] of topById.entries()) {
    const topValues = values.sort((left, right) => right - left).slice(0, 4);
    const score = topValues.length
      ? topValues.reduce((sum, value) => sum + value, 0) / topValues.length
      : 0;
    affinity.set(id, score);
  }
  return affinity;
}

/** Builds unnormalized growth, convergence, and bridge scores from topology and context. */
function rawScoresForGraph(graph) {
  const reverseOutgoing = reverseEdgesByNode(graph.incoming);
  const contexts = buildSkipGramContexts(graph);
  const affinity = semanticAffinityById(weightedContextVectors(contexts));
  const raw = new Map();

  for (const node of graph.nodes) {
    const outgoingEdges = graph.outgoing.get(node.id) || [];
    const incomingEdges = graph.incoming.get(node.id) || [];
    const outgoingReach = reachScore(node.id, graph.outgoing);
    const incomingReach = reachScore(node.id, reverseOutgoing);
    const outgoingDiversity = uniqueCount(outgoingEdges.map((edge) => edge.kind));
    const incomingDiversity = uniqueCount(incomingEdges.map((edge) => edge.kind));
    const outgoingPressure = Math.min(1, outgoingEdges.length / 2);
    const incomingPressure = Math.min(1, incomingEdges.length / 2);
    const sourceRaw = outgoingEdges.length * 1.2
      + outgoingReach.score * 0.62 * Math.max(0.35, outgoingPressure)
      + outgoingDiversity * 0.35
      + finiteOrZero(affinity.get(node.id)) * 0.32;
    const convergenceRaw = incomingEdges.length * 1.38
      + incomingReach.score * 0.52 * incomingPressure
      + incomingDiversity * 0.35
      + finiteOrZero(affinity.get(node.id)) * 0.28;
    const branchPressure = Math.min(1, Math.max(0.18, (incomingEdges.length + outgoingEdges.length - 1) / 4));
    const bridgeRaw = Math.sqrt(Math.max(0, incomingEdges.length * outgoingEdges.length)) * 1.15 * branchPressure
      + Math.min(outgoingReach.ids.length, incomingReach.ids.length) * 0.28
      + finiteOrZero(affinity.get(node.id)) * 0.35;

    raw.set(node.id, {
      id: node.id,
      outgoingDegree: outgoingEdges.length,
      incomingDegree: incomingEdges.length,
      outgoingReach: outgoingReach.score,
      incomingReach: incomingReach.score,
      outgoingReachCount: outgoingReach.ids.length,
      incomingReachCount: incomingReach.ids.length,
      outgoingDiversity,
      incomingDiversity,
      semanticAffinity: finiteOrZero(affinity.get(node.id)),
      sourceRaw,
      convergenceRaw,
      bridgeRaw,
    });
  }

  return raw;
}

/** Classifies normalized topology scores into growth, convergence, bridge, hub, or peripheral roles. */
function graphSemanticRole(score = {}) {
  const sourceScore = finiteOrZero(score.sourceScore);
  const convergenceScore = finiteOrZero(score.convergenceScore);
  const bridgeScore = finiteOrZero(score.bridgeScore);
  const hasBranchingPressure = finiteOrZero(score.incomingDegree) + finiteOrZero(score.outgoingDegree) >= 3;
  if (bridgeScore >= GRAPH_SEMANTIC_CENTER_THRESHOLD
    && sourceScore >= GRAPH_SEMANTIC_CENTER_THRESHOLD
    && convergenceScore >= GRAPH_SEMANTIC_CENTER_THRESHOLD * 1.2) return "conversion-hub";
  if (sourceScore >= GRAPH_SEMANTIC_CENTER_THRESHOLD && sourceScore >= convergenceScore * 1.08) return "growth-source";
  if (convergenceScore >= GRAPH_SEMANTIC_CENTER_THRESHOLD
    && convergenceScore >= sourceScore * 1.02
    && finiteOrZero(score.incomingDegree) >= 2) return "convergence";
  if (bridgeScore >= GRAPH_SEMANTIC_CENTER_THRESHOLD && hasBranchingPressure) return "bridge";
  return "peripheral";
}

/** Formats a compact inspectable explanation for the chosen semantic role and signals. */
function semanticReason(score = {}) {
  const role = score.semanticRole;
  if (role === "growth-source") {
    return `source=${score.sourceScore.toFixed(3)} from outbound=${score.outgoingDegree}, reach=${score.outgoingReachCount}, context=${score.semanticAffinity.toFixed(3)}`;
  }
  if (role === "convergence") {
    return `convergence=${score.convergenceScore.toFixed(3)} from inbound=${score.incomingDegree}, reverseReach=${score.incomingReachCount}, context=${score.semanticAffinity.toFixed(3)}`;
  }
  if (role === "bridge") {
    return `bridge=${score.bridgeScore.toFixed(3)} from inbound=${score.incomingDegree}, outbound=${score.outgoingDegree}, context=${score.semanticAffinity.toFixed(3)}`;
  }
  if (role === "conversion-hub") {
    return `hub=${score.bridgeScore.toFixed(3)} from source=${score.sourceScore.toFixed(3)}, convergence=${score.convergenceScore.toFixed(3)}, inbound=${score.incomingDegree}, outbound=${score.outgoingDegree}`;
  }
  return `peripheral center=${score.centerScore.toFixed(3)}`;
}

/** Computes normalized semantic roles and selects the graph's principal topology centerpieces. */
export function computeGraphSemanticModel(nodes = [], edges = []) {
  const graph = buildSemanticGraph(nodes, edges);
  const rawScores = rawScoresForGraph(graph);
  const maxSource = Math.max(0, ...[...rawScores.values()].map((score) => score.sourceRaw));
  const maxConvergence = Math.max(0, ...[...rawScores.values()].map((score) => score.convergenceRaw));
  const maxBridge = Math.max(0, ...[...rawScores.values()].map((score) => score.bridgeRaw));
  const scores = new Map();

  for (const raw of rawScores.values()) {
    const score = {
      ...raw,
      sourceScore: normalizeScore(raw.sourceRaw, maxSource),
      convergenceScore: normalizeScore(raw.convergenceRaw, maxConvergence),
      bridgeScore: normalizeScore(raw.bridgeRaw, maxBridge),
    };
    score.rawCenterScore = Math.max(score.sourceScore, score.convergenceScore, score.bridgeScore);
    score.semanticRole = graphSemanticRole(score);
    score.centerScore = score.semanticRole === "peripheral"
      ? Math.min(score.rawCenterScore, GRAPH_SEMANTIC_CENTER_THRESHOLD * 0.86)
      : score.rawCenterScore;
    score.semanticReason = semanticReason(score);
    scores.set(score.id, score);
  }

  const centerpieces = [...scores.values()]
    .filter((score) => score.centerScore >= GRAPH_SEMANTIC_CENTER_THRESHOLD)
    .sort((left, right) => right.centerScore - left.centerScore || compareIds(left.id, right.id));

  const primaryGrowthSource = centerpieces.find((score) => score.semanticRole === "growth-source") || null;
  const primaryConvergence = centerpieces.find((score) => score.semanticRole === "conversion-hub")
    || centerpieces.find((score) => score.semanticRole === "convergence")
    || centerpieces.find((score) => score.semanticRole === "bridge")
    || null;

  return {
    scores,
    centerpieces,
    primaryGrowthSource,
    primaryConvergence,
    formula: "normalized(degree + decayed reachability + relation diversity + skip-gram context affinity)",
  };
}

/** Returns one normalized node semantic score from a previously computed model. */
export function graphSemanticScoreForNode(model = {}, nodeId = "") {
  return model?.scores?.get(normalizeId(nodeId)) || null;
}
