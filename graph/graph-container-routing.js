/*
 * Container Routing resolves membership and promotes visual edge endpoints to
 * collapsed or boundary containers without rewriting logical relationships.
 */
import { GRAPH_ROUTE_GRID_CELL } from "./graph-grid.js";
import {
  GRAPH_NODE_SHAPE_CARD,
  compareIds,
  normalizeId,
} from "./graph-geometry.js";

/** Builds canonical child-to-container membership without allowing later containers to steal ownership. */
export function graphNodeContainerMembership(containers = []) {
  const membership = new Map();
  for (const container of Array.isArray(containers) ? containers : []) {
    const containerId = normalizeId(container?.id);
    if (!containerId) continue;
    for (const id of Array.isArray(container.nodeIds) ? container.nodeIds : []) {
      const nodeId = normalizeId(id);
      if (!nodeId || membership.has(nodeId)) continue;
      membership.set(nodeId, containerId);
    }
  }
  return membership;
}

/** Computes how many reachable children qualify a node as a compound-edge representative. */
function graphContainerRepresentativeThreshold(childCount) {
  const count = Math.max(0, Number(childCount) || 0);
  return Math.max(2, Math.ceil(Math.max(0, count - 1) * 0.55));
}

/** Derives the hidden routing proxy identifier reserved for one visible container. */
function graphContainerRouteProxyId(containerId = "") {
  return normalizeId(`container-route:${containerId}`);
}

/** Builds a zero-size hidden node that anchors edges crossing a compound container boundary. */
function graphContainerRouteProxyNode(container = {}) {
  return {
    id: graphContainerRouteProxyId(container.id),
    kind: "container_route_proxy",
    memoryKind: "container",
    label: String(container.label || container.id || "Container").trim(),
    source: String(container.id || "").trim(),
    description: String(container.description || "").trim(),
    x: Number(container.x || 0),
    y: Number(container.y || 0),
    width: Math.max(GRAPH_ROUTE_GRID_CELL, Number(container.width || 0)),
    height: Math.max(GRAPH_ROUTE_GRID_CELL, Number(container.height || 0)),
    shapeKind: GRAPH_NODE_SHAPE_CARD,
    routeProxy: true,
    sourceHidden: true,
  };
}

/** Counts container children reachable from one candidate representative through internal edges. */
function graphReachableChildCount(startId = "", adjacency = new Map(), childIds = new Set()) {
  const normalizedStart = normalizeId(startId);
  if (!normalizedStart || !childIds.has(normalizedStart)) return 0;
  const visited = new Set([normalizedStart]);
  const queue = [normalizedStart];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    for (const next of adjacency.get(current) || []) {
      if (!childIds.has(next) || visited.has(next)) continue;
      visited.add(next);
      queue.push(next);
    }
  }
  return Math.max(0, visited.size - 1);
}

/** Builds forward and reverse reach counts for every child inside one container. */
function graphContainerInternalReach(container = {}, edges = []) {
  const childIds = new Set((Array.isArray(container.nodeIds) ? container.nodeIds : [])
    .map(normalizeId)
    .filter(Boolean));
  const forward = new Map([...childIds].map((id) => [id, []]));
  const reverse = new Map([...childIds].map((id) => [id, []]));
  for (const edge of Array.isArray(edges) ? edges : []) {
    const from = normalizeId(edge?.from);
    const to = normalizeId(edge?.to);
    if (!childIds.has(from) || !childIds.has(to) || from === to) continue;
    forward.get(from).push(to);
    reverse.get(to).push(from);
  }
  for (const list of forward.values()) list.sort(compareIds);
  for (const list of reverse.values()) list.sort(compareIds);
  return { childIds, forward, reverse };
}

/** Selects entry and exit representatives from internal reach while preserving explicit hints. */
function graphContainerRepresentatives(container = {}, edges = []) {
  const reach = graphContainerInternalReach(container, edges);
  const threshold = graphContainerRepresentativeThreshold(reach.childIds.size);
  const entries = new Set();
  const exits = new Set();
  if (reach.childIds.size < 3) return { entries, exits };
  for (const id of [...reach.childIds].sort(compareIds)) {
    if (graphReachableChildCount(id, reach.forward, reach.childIds) >= threshold) entries.add(id);
    if (graphReachableChildCount(id, reach.reverse, reach.childIds) >= threshold) exits.add(id);
  }
  return { entries, exits };
}

/** Rewrites cross-container endpoints through representatives or hidden proxies for stable routing. */
export function resolveCompoundEdgeRouting(nodes = [], edges = [], layoutContainers = [], sourceContainers = []) {
  const nodeIds = new Set((Array.isArray(nodes) ? nodes : []).map((node) => normalizeId(node?.id)).filter(Boolean));
  const containerById = new Map((Array.isArray(layoutContainers) ? layoutContainers : [])
    .map((container) => [normalizeId(container?.id), container]));
  const sourceContainerById = new Map((Array.isArray(sourceContainers) ? sourceContainers : [])
    .map((container) => [normalizeId(container?.id), container]));
  const membership = graphNodeContainerMembership(sourceContainers);
  const routeNodes = [];
  const proxyIdByContainerId = new Map();
  const representativeByContainerId = new Map();

  /** Creates each hidden container routing proxy once and returns its stable identifier. */
  const ensureProxy = (containerId) => {
    const normalizedContainerId = normalizeId(containerId);
    if (!normalizedContainerId) return "";
    if (proxyIdByContainerId.has(normalizedContainerId)) return proxyIdByContainerId.get(normalizedContainerId);
    const layoutContainer = containerById.get(normalizedContainerId);
    if (!layoutContainer) return "";
    const proxyId = graphContainerRouteProxyId(layoutContainer.id);
    proxyIdByContainerId.set(normalizedContainerId, proxyId);
    routeNodes.push(graphContainerRouteProxyNode(layoutContainer));
    return proxyId;
  };

  for (const [containerId, container] of sourceContainerById.entries()) {
    const representative = graphContainerRepresentatives(container, edges);
    if (representative.entries.size || representative.exits.size) {
      representativeByContainerId.set(containerId, representative);
    }
  }

  const routedEdges = (Array.isArray(edges) ? edges : []).map((edge) => {
    const from = normalizeId(edge?.from);
    const to = normalizeId(edge?.to);
    const fromIsNode = nodeIds.has(from);
    const toIsNode = nodeIds.has(to);
    const fromIsContainer = containerById.has(from);
    const toIsContainer = containerById.has(to);
    if ((!fromIsNode && !fromIsContainer) || (!toIsNode && !toIsContainer) || from === to) return edge;
    const fromContainerId = membership.get(from) || "";
    const toContainerId = membership.get(to) || "";
    let routeFrom = normalizeId(edge?.routeFrom || edge?.from);
    let routeTo = normalizeId(edge?.routeTo || edge?.to);
    const annotations = {};

    // A provider may address an expanded container directly. The logical edge
    // retains that container id while geometry uses the same hidden boundary
    // proxy used for topology-promoted compound relationships.
    if (fromIsContainer) {
      const proxyId = ensureProxy(from);
      if (proxyId) {
        routeFrom = proxyId;
        annotations.compoundSourceContainerId = from;
      }
    }
    if (toIsContainer) {
      const proxyId = ensureProxy(to);
      if (proxyId) {
        routeTo = proxyId;
        annotations.compoundTargetContainerId = to;
      }
    }

    if (fromIsNode && fromContainerId && fromContainerId !== toContainerId) {
      const representatives = representativeByContainerId.get(fromContainerId);
      if (representatives?.exits?.has(from)) {
        const proxyId = ensureProxy(fromContainerId);
        if (proxyId) {
          routeFrom = proxyId;
          annotations.compoundSourceContainerId = fromContainerId;
          annotations.compoundSourceNodeId = from;
        }
      }
    }

    if (toIsNode && toContainerId && fromContainerId !== toContainerId) {
      const representatives = representativeByContainerId.get(toContainerId);
      if (representatives?.entries?.has(to)) {
        const proxyId = ensureProxy(toContainerId);
        if (proxyId) {
          routeTo = proxyId;
          annotations.compoundTargetContainerId = toContainerId;
          annotations.compoundTargetNodeId = to;
        }
      }
    }

    if (routeFrom === normalizeId(edge?.from) && routeTo === normalizeId(edge?.to)) return edge;
    return {
      ...edge,
      routeFrom,
      routeTo,
      routeEndpointModel: "container-boundary",
      ...annotations,
    };
  });

  return { edges: routedEdges, routeNodes };
}
