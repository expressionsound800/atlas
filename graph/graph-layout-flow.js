/*
 * Container Flow Layout derives a source-to-receiver gradient and crossing-aware
 * lane order from relationships owned by one canonical container. Room-wide and
 * cross-container relationships are deliberately outside this local contract.
 */
import { compareIds, normalizeId } from "./graph-geometry.js";

const CONTAINER_FLOW_MODEL = "container-local-trophic-gradient-v1";
const CONTAINER_FLOW_FIELD_MODEL = "container-local-hub-branch-fields-v2";
const CONTAINER_FLOW_MIN_NODES = 8;
const CONTAINER_FLOW_MAX_BANDS = 4;
const CONTAINER_FLOW_SWEEPS = 4;
const CONTAINER_FLOW_EPSILON = 1e-9;
const CONTAINER_FLOW_HUB_MIN_COVERAGE = 0.38;
const CONTAINER_FLOW_HUB_MIN_DOMINANCE = 1.55;
const CONTAINER_FLOW_MAX_FIELDS = 4;
const CONTAINER_FLOW_FIELD_GUTTER = 1.5;
const CONTAINER_FLOW_HUB_CORRIDOR = 2.5;

/** Builds a deterministic node-id list and filters relationships to the induced container subgraph. */
function containerFlowGraph(entries = [], edges = []) {
  const nodeIds = [...new Set(entries
    .map((entry) => normalizeId(entry?.node?.id))
    .filter(Boolean))]
    .sort(compareIds);
  const nodeIdSet = new Set(nodeIds);
  const internalEdges = [];
  const seenEdges = new Set();
  for (const edge of Array.isArray(edges) ? edges : []) {
    const from = normalizeId(edge?.from);
    const to = normalizeId(edge?.to);
    if (!nodeIdSet.has(from) || !nodeIdSet.has(to) || from === to) continue;
    const edgeKey = `${from}->${to}`;
    if (seenEdges.has(edgeKey)) continue;
    seenEdges.add(edgeKey);
    internalEdges.push({ from, to });
  }
  internalEdges.sort((left, right) => compareIds(left.from, right.from) || compareIds(left.to, right.to));
  return { nodeIds, internalEdges };
}

/** Finds undirected components so each singular flow system can be anchored and solved independently. */
function containerFlowComponents(nodeIds = [], internalEdges = []) {
  const adjacency = new Map(nodeIds.map((id) => [id, new Set()]));
  internalEdges.forEach(({ from, to }) => {
    adjacency.get(from)?.add(to);
    adjacency.get(to)?.add(from);
  });
  const visited = new Set();
  const components = [];
  for (const startId of nodeIds) {
    if (visited.has(startId)) continue;
    const component = [];
    const queue = [startId];
    visited.add(startId);
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const id = queue[cursor];
      component.push(id);
      for (const neighborId of [...(adjacency.get(id) || [])].sort(compareIds)) {
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);
        queue.push(neighborId);
      }
    }
    components.push(component.sort(compareIds));
  }
  return components;
}

/** Computes one linear-system solution with stable pivot selection and returns null when the container matrix is singular. */
function solveContainerFlowSystem(matrix = [], vector = []) {
  const size = vector.length;
  if (!size) return [];
  const rows = matrix.map((row, index) => [...row, Number(vector[index] || 0)]);
  for (let column = 0; column < size; column += 1) {
    let pivotRow = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivotRow][column])) pivotRow = row;
    }
    if (Math.abs(rows[pivotRow][column]) <= CONTAINER_FLOW_EPSILON) return null;
    if (pivotRow !== column) [rows[column], rows[pivotRow]] = [rows[pivotRow], rows[column]];
    const pivot = rows[column][column];
    for (let entry = column; entry <= size; entry += 1) rows[column][entry] /= pivot;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = rows[row][column];
      if (Math.abs(factor) <= CONTAINER_FLOW_EPSILON) continue;
      for (let entry = column; entry <= size; entry += 1) {
        rows[row][entry] -= factor * rows[column][entry];
      }
    }
  }
  return rows.map((row) => row[size]);
}

/** Computes normalized generalized trophic potential for one connected component and returns neutral values when direction is indeterminate. */
function containerComponentPotentials(componentIds = [], internalEdges = []) {
  if (componentIds.length < 2) return new Map(componentIds.map((id) => [id, 0.5]));
  const indexById = new Map(componentIds.map((id, index) => [id, index]));
  const size = componentIds.length;
  const laplacian = Array.from({ length: size }, () => Array(size).fill(0));
  const imbalance = Array(size).fill(0);
  let edgeCount = 0;
  for (const { from, to } of internalEdges) {
    const fromIndex = indexById.get(from);
    const toIndex = indexById.get(to);
    if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) continue;
    edgeCount += 1;
    laplacian[fromIndex][fromIndex] += 1;
    laplacian[toIndex][toIndex] += 1;
    laplacian[fromIndex][toIndex] -= 1;
    laplacian[toIndex][fromIndex] -= 1;
    imbalance[fromIndex] -= 1;
    imbalance[toIndex] += 1;
  }
  if (!edgeCount) return new Map(componentIds.map((id) => [id, 0.5]));

  // Fixing the first stable node at zero removes the additive degree of freedom;
  // normalization below makes the arbitrary anchor invisible to composition.
  const reducedMatrix = laplacian.slice(1).map((row) => row.slice(1));
  const reducedVector = imbalance.slice(1);
  const reducedSolution = solveContainerFlowSystem(reducedMatrix, reducedVector);
  if (!reducedSolution) return new Map(componentIds.map((id) => [id, 0.5]));
  const values = [0, ...reducedSolution];
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const range = maximum - minimum;
  if (range <= CONTAINER_FLOW_EPSILON) return new Map(componentIds.map((id) => [id, 0.5]));
  return new Map(componentIds.map((id, index) => [id, (values[index] - minimum) / range]));
}

/** Derives normalized source-to-receiver potentials independently for every induced container component. */
function containerFlowPotentials(nodeIds = [], internalEdges = []) {
  const potentials = new Map();
  for (const componentIds of containerFlowComponents(nodeIds, internalEdges)) {
    const componentIdSet = new Set(componentIds);
    const componentEdges = internalEdges.filter(({ from, to }) => (
      componentIdSet.has(from) && componentIdSet.has(to)
    ));
    for (const [id, potential] of containerComponentPotentials(componentIds, componentEdges)) {
      potentials.set(id, potential);
    }
  }
  return potentials;
}

/** Maps a normalized potential to a bounded band whose horizontal direction follows the container side. */
function containerFlowBandColumn(potential = 0.5, bandCount = 1, side = "right") {
  const band = Math.max(0, Math.min(bandCount - 1, Math.round(potential * (bandCount - 1))));
  return {
    band,
    column: side === "left" ? bandCount - band : band + 1,
  };
}

/** Builds undirected internal neighbors used only for barycentric crossing minimization within flow bands. */
function containerFlowNeighbors(nodeIds = [], internalEdges = []) {
  const neighbors = new Map(nodeIds.map((id) => [id, new Set()]));
  internalEdges.forEach(({ from, to }) => {
    neighbors.get(from)?.add(to);
    neighbors.get(to)?.add(from);
  });
  return neighbors;
}

/** Orders nodes inside potential bands with deterministic alternating barycentric sweeps while preserving stable-id tie breaks. */
function containerFlowBandOrders(nodeIds = [], bandById = new Map(), internalEdges = []) {
  const bands = new Map();
  nodeIds.forEach((id) => {
    const band = Number(bandById.get(id) || 0);
    if (!bands.has(band)) bands.set(band, []);
    bands.get(band).push(id);
  });
  for (const ids of bands.values()) ids.sort(compareIds);
  const sortedBands = [...bands.keys()].sort((left, right) => left - right);
  const neighbors = containerFlowNeighbors(nodeIds, internalEdges);

  /** Returns current lane positions across all bands before one barycentric sweep. */
  const currentPositions = () => {
    const positions = new Map();
    for (const band of sortedBands) {
      (bands.get(band) || []).forEach((id, index) => positions.set(id, index));
    }
    return positions;
  };

  for (let sweep = 0; sweep < CONTAINER_FLOW_SWEEPS; sweep += 1) {
    const forward = sweep % 2 === 0;
    const traversal = forward ? sortedBands : [...sortedBands].reverse();
    for (const band of traversal) {
      const positions = currentPositions();
      const adjacentBand = band + (forward ? -1 : 1);
      const entries = bands.get(band) || [];
      entries.sort((leftId, rightId) => {
        /** Computes the mean lane of neighbors in the already-visited adjacent flow band. */
        const barycenter = (id) => {
          const adjacentPositions = [...(neighbors.get(id) || [])]
            .filter((neighborId) => bandById.get(neighborId) === adjacentBand)
            .map((neighborId) => positions.get(neighborId))
            .filter(Number.isFinite);
          if (!adjacentPositions.length) return positions.get(id) ?? Number.POSITIVE_INFINITY;
          return adjacentPositions.reduce((sum, value) => sum + value, 0) / adjacentPositions.length;
        };
        const delta = barycenter(leftId) - barycenter(rightId);
        return Math.abs(delta) > CONTAINER_FLOW_EPSILON ? delta : compareIds(leftId, rightId);
      });
    }
  }
  return bands;
}

/** Selects a source-neutral high-degree hub only when its local coverage and dominance justify a separate field layout. */
function containerFlowDominantHub(nodeIds = [], internalEdges = []) {
  const neighbors = containerFlowNeighbors(nodeIds, internalEdges);
  const incoming = new Map(nodeIds.map((id) => [id, 0]));
  const outgoing = new Map(nodeIds.map((id) => [id, 0]));
  internalEdges.forEach(({ from, to }) => {
    outgoing.set(from, Number(outgoing.get(from) || 0) + 1);
    incoming.set(to, Number(incoming.get(to) || 0) + 1);
  });
  const averageDegree = nodeIds.length
    ? [...neighbors.values()].reduce((sum, entries) => sum + entries.size, 0) / nodeIds.length
    : 0;
  const minimumDegree = Math.max(4, Math.ceil(Math.sqrt(nodeIds.length)));
  const candidate = nodeIds
    .map((id) => ({
      id,
      degree: neighbors.get(id)?.size || 0,
      incoming: Number(incoming.get(id) || 0),
      outgoing: Number(outgoing.get(id) || 0),
    }))
    .sort((left, right) => right.degree - left.degree || compareIds(left.id, right.id))[0];
  if (!candidate || candidate.degree < minimumDegree) return null;
  const coverage = candidate.degree / Math.max(1, nodeIds.length - 1);
  const dominance = averageDegree > 0 ? candidate.degree / averageDegree : 0;
  if (coverage < CONTAINER_FLOW_HUB_MIN_COVERAGE || dominance < CONTAINER_FLOW_HUB_MIN_DOMINANCE) {
    return null;
  }
  return {
    ...candidate,
    coverage,
    dominance,
    neighborIds: [...(neighbors.get(candidate.id) || [])].sort(compareIds),
  };
}

/** Computes undirected hop distances after removing the dominant hub so each node can join its nearest hub branch. */
function containerFlowDistancesFromSeed(seedId = "", adjacency = new Map(), hubId = "") {
  const distances = new Map([[seedId, 0]]);
  const queue = [seedId];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const id = queue[cursor];
    const distance = Number(distances.get(id) || 0);
    for (const neighborId of [...(adjacency.get(id) || [])].sort(compareIds)) {
      if (neighborId === hubId || distances.has(neighborId)) continue;
      distances.set(neighborId, distance + 1);
      queue.push(neighborId);
    }
  }
  return distances;
}

/** Splits ordered hub branches into a bounded number of contiguous, load-balanced vertical fields. */
function containerFlowPackBranches(branches = []) {
  const fieldCount = Math.min(
    CONTAINER_FLOW_MAX_FIELDS,
    branches.length,
    Math.max(2, Math.ceil(Math.sqrt(branches.length))),
  );
  const fields = [];
  let cursor = 0;
  for (let fieldIndex = 0; fieldIndex < fieldCount; fieldIndex += 1) {
    const remainingFields = fieldCount - fieldIndex;
    const remainingNodes = branches
      .slice(cursor)
      .reduce((sum, branch) => sum + branch.nodeIds.length, 0);
    const targetNodes = remainingNodes / remainingFields;
    const fieldBranches = [];
    let fieldNodes = 0;
    while (cursor < branches.length) {
      const branch = branches[cursor];
      const mustLeave = remainingFields - 1;
      const canStop = fieldBranches.length > 0 && branches.length - cursor > mustLeave;
      const crossesDirectionBoundary = fieldBranches.length > 0
        && Math.sign(Number(fieldBranches[0].bias || 0)) !== Math.sign(Number(branch.bias || 0));
      const addingIsWorse = Math.abs(fieldNodes - targetNodes)
        <= Math.abs(fieldNodes + branch.nodeIds.length - targetNodes);
      if (canStop && (crossesDirectionBoundary || addingIsWorse)) break;
      fieldBranches.push(branch);
      fieldNodes += branch.nodeIds.length;
      cursor += 1;
      if (branches.length - cursor === mustLeave) break;
    }
    fields.push({
      index: fieldIndex,
      branches: fieldBranches,
      nodeIds: fieldBranches.flatMap((branch) => branch.nodeIds),
      bias: fieldNodes
        ? fieldBranches.reduce((sum, branch) => sum + branch.bias * branch.nodeIds.length, 0) / fieldNodes
        : 0,
    });
  }
  return fields;
}

/** Finds the split that balances field footprints above and below the hub while preserving branch-gradient order. */
function containerFlowFieldSplit(fields = []) {
  let best = { index: 1, imbalance: Number.POSITIVE_INFINITY };
  for (let index = 1; index < fields.length; index += 1) {
    const upper = fields.slice(0, index).reduce((sum, field) => sum + field.span, 0)
      + CONTAINER_FLOW_FIELD_GUTTER * Math.max(0, index - 1);
    const lower = fields.slice(index).reduce((sum, field) => sum + field.span, 0)
      + CONTAINER_FLOW_FIELD_GUTTER * Math.max(0, fields.length - index - 1);
    const imbalance = Math.abs(upper - lower);
    if (imbalance < best.imbalance - CONTAINER_FLOW_EPSILON) best = { index, imbalance };
  }
  return best.index;
}

/** Returns the field's small alternating phase while reserving most of the horizontal budget for branch-level staggering. */
function containerFlowFieldColumnOffset(fieldIndex = -1, fieldCount = 0) {
  if (fieldIndex < 0 || fieldCount < 2) return 0;
  const center = (fieldCount - 1) / 2;
  const maximumDistance = Math.max(1, center);
  const centerWeight = 1 - Math.abs(fieldIndex - center) / maximumDistance;
  const amplitude = 0.14 + centerWeight * 0.06;
  return (fieldIndex % 2 === 0 ? -1 : 1) * amplitude;
}

/** Assigns sibling branches a bounded horizontal phase so one hub neighborhood forms a two-dimensional fan instead of a seam. */
function containerFlowBranchColumnOffset(nodeField = {}) {
  const branchCount = Number(nodeField.branchCount || 0);
  const branchIndex = Number(nodeField.branchIndex || 0);
  if (branchCount < 2) return 0;
  const normalized = (branchIndex / (branchCount - 1)) * 2 - 1;
  const direction = Number(nodeField.field || 0) % 2 === 0 ? 1 : -1;
  return normalized * 0.18 * direction;
}

/** Derives vertically separated branch fields around one dominant hub without changing the primary horizontal flow bands. */
function containerFlowHubFieldLayout(nodeIds = [], internalEdges = [], context = {}) {
  const hub = containerFlowDominantHub(nodeIds, internalEdges);
  if (!hub) return null;
  const adjacency = containerFlowNeighbors(nodeIds, internalEdges);
  const distancesBySeed = new Map(hub.neighborIds.map((seedId) => [
    seedId,
    containerFlowDistancesFromSeed(seedId, adjacency, hub.id),
  ]));
  const branchBySeed = new Map(hub.neighborIds.map((seedId) => [seedId, []]));
  let hasUnreachableNode = false;
  for (const id of nodeIds) {
    if (id === hub.id) continue;
    const nearestSeed = hub.neighborIds
      .map((candidateId) => ({
        id: candidateId,
        distance: distancesBySeed.get(candidateId)?.get(id) ?? Number.POSITIVE_INFINITY,
      }))
      .sort((left, right) => left.distance - right.distance || compareIds(left.id, right.id))[0];
    if (!nearestSeed || !Number.isFinite(nearestSeed.distance)) {
      hasUnreachableNode = true;
      continue;
    }
    branchBySeed.get(nearestSeed.id)?.push(id);
  }
  // A disconnected component has no honest hub branch. Keep the v1 local
  // gradient instead of assigning it to a visually convenient false branch.
  if (hasUnreachableNode) return null;
  const edgeDirectionBySeed = new Map(hub.neighborIds.map((seedId) => [seedId, 0]));
  internalEdges.forEach(({ from, to }) => {
    if (to === hub.id && edgeDirectionBySeed.has(from)) edgeDirectionBySeed.set(from, -1);
    if (from === hub.id && edgeDirectionBySeed.has(to)) edgeDirectionBySeed.set(to, 1);
  });
  const hubPotential = Number(context.potentials?.get(hub.id) || 0);
  const branches = hub.neighborIds
    .map((seedId) => {
      const branchNodeIds = (branchBySeed.get(seedId) || []).sort((left, right) => (
        Number(context.bandById?.get(left) || 0) - Number(context.bandById?.get(right) || 0)
        || Number(context.orderById?.get(left) || 0) - Number(context.orderById?.get(right) || 0)
        || compareIds(left, right)
      ));
      const potentialBias = branchNodeIds.length
        ? branchNodeIds.reduce((sum, id) => sum + Number(context.potentials?.get(id) || 0) - hubPotential, 0)
          / branchNodeIds.length
        : 0;
      const directBias = Number(edgeDirectionBySeed.get(seedId) || 0);
      return {
        seedId,
        nodeIds: branchNodeIds,
        bias: directBias || potentialBias,
        potentialBias,
        firstBand: Math.min(...branchNodeIds.map((id) => Number(context.bandById?.get(id) || 0))),
        firstOrder: Math.min(...branchNodeIds.map((id) => Number(context.orderById?.get(id) || 0))),
      };
    })
    .filter((branch) => branch.nodeIds.length)
    .sort((left, right) => (
      left.bias - right.bias
      || left.potentialBias - right.potentialBias
      || left.firstBand - right.firstBand
      || left.firstOrder - right.firstOrder
      || compareIds(left.seedId, right.seedId)
    ));
  if (branches.length < 2) return null;

  const fields = containerFlowPackBranches(branches).map((field) => {
    const nodesByBand = new Map();
    field.nodeIds.forEach((id) => {
      const band = Number(context.bandById?.get(id) || 0);
      if (!nodesByBand.has(band)) nodesByBand.set(band, []);
      nodesByBand.get(band).push(id);
    });
    for (const ids of nodesByBand.values()) {
      ids.sort((left, right) => (
        Number(context.orderById?.get(left) || 0) - Number(context.orderById?.get(right) || 0)
        || compareIds(left, right)
      ));
    }
    return {
      ...field,
      nodesByBand,
      span: Math.max(1, ...[...nodesByBand.values()].map((ids) => ids.length)),
    };
  });
  const splitIndex = containerFlowFieldSplit(fields);
  let upperCursor = -CONTAINER_FLOW_HUB_CORRIDOR / 2;
  for (let index = splitIndex - 1; index >= 0; index -= 1) {
    const field = fields[index];
    field.center = upperCursor - field.span / 2;
    upperCursor -= field.span + CONTAINER_FLOW_FIELD_GUTTER;
  }
  let lowerCursor = CONTAINER_FLOW_HUB_CORRIDOR / 2;
  for (let index = splitIndex; index < fields.length; index += 1) {
    const field = fields[index];
    field.center = lowerCursor + field.span / 2;
    lowerCursor += field.span + CONTAINER_FLOW_FIELD_GUTTER;
  }

  const nodeFields = new Map([[hub.id, {
    field: -1,
    lane: 0,
    bias: 0,
    seedId: hub.id,
    branchIndex: -1,
    branchCount: 0,
  }]]);
  fields.forEach((field) => {
    for (const ids of field.nodesByBand.values()) {
      ids.forEach((id, index) => {
        const branchIndex = field.branches.findIndex((candidate) => candidate.nodeIds.includes(id));
        const branch = field.branches[branchIndex];
        nodeFields.set(id, {
          field: field.index,
          lane: field.center + index - (ids.length - 1) / 2,
          bias: field.bias,
          seedId: branch?.seedId || "",
          branchIndex,
          branchCount: field.branches.length,
        });
      });
    }
  });
  return {
    hub,
    branches,
    fields,
    nodeFields,
    maxBandOccupancy: Math.max(...fields.map((field) => field.span)),
  };
}

/** Applies an inspectable local flow gradient and lane order to one canonical dense container's entries. */
export function applyContainerLocalFlowPlacement(entries = [], edges = [], options = {}) {
  if (!Array.isArray(entries) || entries.length < CONTAINER_FLOW_MIN_NODES) return false;
  // A semantic room root stays outside branch placement, but it still belongs
  // to the container topology. Including it here allows a root hub to organize
  // its branches without reclassifying or moving the root itself.
  const topologyEntries = Array.isArray(options.topologyEntries)
    && options.topologyEntries.length >= entries.length
    ? options.topologyEntries
    : entries;
  const { nodeIds, internalEdges } = containerFlowGraph(topologyEntries, edges);
  if (internalEdges.length < 2) return false;
  const potentials = containerFlowPotentials(nodeIds, internalEdges);
  const bandCount = Math.max(2, Math.min(CONTAINER_FLOW_MAX_BANDS, Math.ceil(Math.sqrt(nodeIds.length))));
  const bandById = new Map();
  const columnById = new Map();
  for (const id of nodeIds) {
    const { band, column } = containerFlowBandColumn(potentials.get(id), bandCount, options.side);
    bandById.set(id, band);
    columnById.set(id, column);
  }
  if (new Set(bandById.values()).size < 2) return false;
  const orderedBands = containerFlowBandOrders(nodeIds, bandById, internalEdges);
  const orderById = new Map();
  for (const ids of orderedBands.values()) ids.forEach((id, index) => orderById.set(id, index));
  const fieldLayout = containerFlowHubFieldLayout(nodeIds, internalEdges, {
    potentials,
    bandById,
    orderById,
  });

  const entryById = new Map(entries.map((entry) => [normalizeId(entry?.node?.id), entry]));
  for (const id of nodeIds) {
    const entry = entryById.get(id);
    if (!entry) continue;
    const bandEntries = orderedBands.get(bandById.get(id)) || [];
    const nodeField = fieldLayout?.nodeFields.get(id);
    const fieldColumnOffset = fieldLayout
      ? containerFlowFieldColumnOffset(nodeField?.field, fieldLayout.fields.length)
      : 0;
    const branchColumnOffset = fieldLayout ? containerFlowBranchColumnOffset(nodeField) : 0;
    const columnOffset = fieldColumnOffset + branchColumnOffset;
    entry.node.graphColumn = Number(columnById.get(id) || 1) + columnOffset;
    entry.node.containerFlowModel = fieldLayout ? CONTAINER_FLOW_FIELD_MODEL : CONTAINER_FLOW_MODEL;
    entry.node.containerFlowContainerId = normalizeId(options.containerId);
    entry.node.containerFlowPotential = Math.round(Number(potentials.get(id) || 0) * 1000) / 1000;
    entry.node.containerFlowBand = bandById.get(id);
    entry.node.containerFlowOrder = orderById.get(id);
    entry.node.containerFlowLane = fieldLayout
      ? Number(nodeField?.lane || 0)
      : Number(orderById.get(id) || 0) - (bandEntries.length - 1) / 2;
    entry.node.containerFlowHubId = fieldLayout?.hub.id || "";
    entry.node.containerFlowHubDegree = Number(fieldLayout?.hub.degree || 0);
    entry.node.containerFlowHubCoverage = fieldLayout
      ? Math.round(fieldLayout.hub.coverage * 1000) / 1000
      : 0;
    entry.node.containerFlowHubDominance = fieldLayout
      ? Math.round(fieldLayout.hub.dominance * 1000) / 1000
      : 0;
    entry.node.containerFlowBranchCount = Number(fieldLayout?.branches.length || 0);
    entry.node.containerFlowFieldCount = Number(fieldLayout?.fields.length || 0);
    entry.node.containerFlowField = Number(nodeField?.field ?? -1);
    entry.node.containerFlowFieldLane = fieldLayout ? Number(nodeField?.lane || 0) : undefined;
    entry.node.containerFlowFieldBias = fieldLayout
      ? Math.round(Number(nodeField?.bias || 0) * 1000) / 1000
      : undefined;
    entry.node.containerFlowFieldColumnOffset = fieldLayout
      ? Math.round(columnOffset * 1000) / 1000
      : undefined;
    entry.node.containerFlowBranchSeedId = fieldLayout ? String(nodeField?.seedId || "") : "";
    entry.node.containerFlowBranchIndex = fieldLayout ? Number(nodeField?.branchIndex ?? -1) : undefined;
    entry.node.containerFlowBranchColumnOffset = fieldLayout
      ? Math.round(branchColumnOffset * 1000) / 1000
      : undefined;
    entry.node.containerFlowMaxBandOccupancy = Number(fieldLayout?.maxBandOccupancy || 0);
  }
  if (fieldLayout && !entryById.has(fieldLayout.hub.id)) {
    const topologyHubEntry = topologyEntries.find((entry) => (
      normalizeId(entry?.node?.id) === fieldLayout.hub.id
    ));
    if (topologyHubEntry?.node) {
      // The semantic root remains horizontally anchored, but carries the same
      // field identity so connector geometry and container composition can
      // recognize it as the local hub without reconstructing topology later.
      topologyHubEntry.node.containerFlowModel = CONTAINER_FLOW_FIELD_MODEL;
      topologyHubEntry.node.containerFlowContainerId = normalizeId(options.containerId);
      topologyHubEntry.node.containerFlowPotential = Math.round(
        Number(potentials.get(fieldLayout.hub.id) || 0) * 1000,
      ) / 1000;
      topologyHubEntry.node.containerFlowBand = bandById.get(fieldLayout.hub.id);
      topologyHubEntry.node.containerFlowOrder = orderById.get(fieldLayout.hub.id);
      topologyHubEntry.node.containerFlowLane = 0;
      topologyHubEntry.node.containerFlowHubId = fieldLayout.hub.id;
      topologyHubEntry.node.containerFlowHubDegree = fieldLayout.hub.degree;
      topologyHubEntry.node.containerFlowHubCoverage = Math.round(fieldLayout.hub.coverage * 1000) / 1000;
      topologyHubEntry.node.containerFlowHubDominance = Math.round(fieldLayout.hub.dominance * 1000) / 1000;
      topologyHubEntry.node.containerFlowBranchCount = fieldLayout.branches.length;
      topologyHubEntry.node.containerFlowFieldCount = fieldLayout.fields.length;
      topologyHubEntry.node.containerFlowField = -1;
      topologyHubEntry.node.containerFlowFieldLane = 0;
      topologyHubEntry.node.containerFlowFieldBias = 0;
      topologyHubEntry.node.containerFlowFieldColumnOffset = 0;
      topologyHubEntry.node.containerFlowBranchSeedId = fieldLayout.hub.id;
      topologyHubEntry.node.containerFlowBranchIndex = -1;
      topologyHubEntry.node.containerFlowBranchColumnOffset = 0;
      topologyHubEntry.node.containerFlowMaxBandOccupancy = fieldLayout.maxBandOccupancy;
    }
  }
  return true;
}
