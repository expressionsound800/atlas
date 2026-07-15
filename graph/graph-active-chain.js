/*
 * Active Chain derives the selected node's visible signal-flow neighborhood
 * and marker state without changing the logical graph projection.
 */
import {
  normalizeId,
  normalizeKind,
} from "./graph-geometry.js";

/** Computes deterministic traversal priority from an edge's kind, style, and stable identity. */
function graphActiveChainPriority(edge = {}) {
  const kind = normalizeKind(edge.kind);
  if (kind === "control") return 0;
  if (kind === "binding") return 1;
  if (kind === "timing") return 2;
  return 3;
}

/** Orders candidate signal edges by semantic priority and stable edge identity. */
function sortedGraphActiveEdges(edges = []) {
  return [...edges].sort((left, right) => {
    const priorityDelta = graphActiveChainPriority(left) - graphActiveChainPriority(right);
    if (priorityDelta !== 0) return priorityDelta;
    return String(left.id || "").localeCompare(String(right.id || ""));
  });
}

/** Builds the bidirectional highlighted signal chain around the current node or edge selection. */
export function graphActiveChain(nodes = [], edges = []) {
  const nodeIds = new Set((Array.isArray(nodes) ? nodes : []).map((node) => normalizeId(node?.id)).filter(Boolean));
  const focusedNode = (Array.isArray(nodes) ? nodes : []).find((node) => node?.selected === true) || null;
  const focusedId = normalizeId(focusedNode?.id);
  const activeNodeIds = new Set(focusedId ? [focusedId] : []);
  const activeEdgeIds = new Set();
  if (!focusedId) return { activeNodeIds, activeEdgeIds };

  const chainEdges = (Array.isArray(edges) ? edges : []).filter((edge) => {
    const edgeId = String(edge?.id || "");
    const from = normalizeId(edge?.from);
    const to = normalizeId(edge?.to);
    return edgeId
      && edge?.enabled !== false
      && edge?.terminal !== true
      && normalizeKind(edge?.kind) !== "tempo"
      && nodeIds.has(from)
      && nodeIds.has(to);
  });
  const incoming = new Map();
  const outgoing = new Map();
  chainEdges.forEach((edge) => {
    const from = normalizeId(edge.from);
    const to = normalizeId(edge.to);
    if (!outgoing.has(from)) outgoing.set(from, []);
    if (!incoming.has(to)) incoming.set(to, []);
    outgoing.get(from).push(edge);
    incoming.get(to).push(edge);
  });

  /** Adds one traversed edge and its endpoints without duplicating chain membership. */
  const addEdge = (edge) => {
    if (!edge) return false;
    const edgeId = String(edge.id || "");
    if (!edgeId || activeEdgeIds.has(edgeId)) return false;
    activeEdgeIds.add(edgeId);
    activeNodeIds.add(normalizeId(edge.from));
    activeNodeIds.add(normalizeId(edge.to));
    return true;
  };
  /** Traverses prioritized outgoing edges until the active signal chain reaches a leaf. */
  const walkForward = (startId) => {
    const visited = new Set();
    const queue = [normalizeId(startId)];
    while (queue.length) {
      const cursor = queue.shift();
      if (!cursor || visited.has(cursor)) continue;
      visited.add(cursor);
      for (const edge of sortedGraphActiveEdges(outgoing.get(cursor) || [])) {
        addEdge(edge);
        const next = normalizeId(edge.to);
        if (next && !visited.has(next)) queue.push(next);
      }
    }
  };
  /** Traverses prioritized incoming edges to expose the active signal chain's upstream origin. */
  const walkBackward = (startId) => {
    const visited = new Set();
    const queue = [normalizeId(startId)];
    while (queue.length) {
      const cursor = queue.shift();
      if (!cursor || visited.has(cursor)) continue;
      visited.add(cursor);
      for (const edge of sortedGraphActiveEdges(incoming.get(cursor) || [])) {
        addEdge(edge);
        const previous = normalizeId(edge.from);
        if (previous && !visited.has(previous)) queue.push(previous);
      }
    }
  };

  walkBackward(focusedId);
  walkForward(focusedId);

  return { activeNodeIds, activeEdgeIds };
}
