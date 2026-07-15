#!/usr/bin/env node

/*
 * Model Invariant Audit verifies neutral projection validation and rejects
 * category-specific semantics inside reusable graph-core modules.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildIllustrationGraphViewModel } from "../graph-layout.js";
import {
  GRAPH_MODEL_MIN_ELEMENT_GAP_CELLS,
  normalizeGraphModel,
  validateGraphModel,
} from "../graph-model.js";
import {
  buildPrecomputedGraphViewModel,
  buildProjectionWithPrecomputedGraphViewModel,
  stripGraphPrecomputedViewModel,
} from "../graph-precompute.js";
import { validateGraphViewModel } from "../graph-view-model.js";
import { normalizeId } from "../graph-geometry.js";
import {
  graphNodeRepositoryOverviewEligibility,
  graphNodeRoomEntryEligibility,
  graphProjectionRoomEntryTargetId,
} from "../graph-navigation.js";
import { atlasSourceCategoryAvailable } from "../source-atlas.js";

const CORE_FILES = Object.freeze([
  "graph-model.js",
  "graph-view-model.js",
  "graph-precompute.js",
  "graph-semantic.js",
  "graph-active-chain.js",
  "graph-container-routing.js",
  "graph-geometry.js",
  "graph-grid.js",
  "graph-layout.js",
  "graph-navigation.js",
  "graph-render.js",
  "graph-router.js",
]);

/** Verifies room navigation requires an explicit fresh semantic contract and rejects self-entry. */
function auditRoomNavigationContract() {
  const semanticRoom = {
    id: "semantic-room",
    metadata: {
      roomId: "SEMANTIC-ROOM",
      entryKind: "semantic-room",
      navigationKind: "room-entry",
      roomGraphStatus: "source-derived-room-available",
      roomGraphSourceModel: "provider-semantic-system-model.v1",
      roomGraphFreshnessStatus: "source-digest-current",
      graphEndpoint: "/api/architecture-graph?slice=SEMANTIC-ROOM",
    },
  };
  const available = graphNodeRoomEntryEligibility(semanticRoom);
  assertCondition(available.eligible && available.targetRoomId === "SEMANTIC-ROOM", "fresh semantic room should be navigable", available);

  const sourceEvidence = graphNodeRoomEntryEligibility({
    ...semanticRoom,
    metadata: {
      ...semanticRoom.metadata,
      entryKind: "source-evidence",
      drilldownCapable: "true",
      architectureDrilldownRoom: "true",
    },
  });
  assertCondition(!sourceEvidence.eligible && sourceEvidence.reason === "not-semantic-room", "source evidence must ignore legacy drilldown booleans", sourceEvidence);

  const structuralModel = graphNodeRoomEntryEligibility({
    ...semanticRoom,
    metadata: {
      ...semanticRoom.metadata,
      roomGraphSourceModel: "repository-source-scan",
    },
  });
  assertCondition(!structuralModel.eligible && structuralModel.reason === "non-semantic-source-model", "structural source scans must not become semantic rooms", structuralModel);

  const sourceInventoryModel = graphNodeRoomEntryEligibility({
    ...semanticRoom,
    metadata: {
      ...semanticRoom.metadata,
      roomGraphSourceModel: "multihead-atlas-source-inventory-v1",
    },
  });
  assertCondition(!sourceInventoryModel.eligible && sourceInventoryModel.reason === "non-semantic-source-model", "source inventory models must not become semantic rooms", sourceInventoryModel);

  const repositorySystemModel = graphNodeRoomEntryEligibility({
    ...semanticRoom,
    metadata: {
      ...semanticRoom.metadata,
      roomGraphSourceModel: "multihead-atlas-repository-system-model-v1",
    },
  });
  assertCondition(repositorySystemModel.eligible, "repository system models may declare semantic rooms", repositorySystemModel);

  const implicitNodeId = graphNodeRoomEntryEligibility({
    ...semanticRoom,
    metadata: {
      ...semanticRoom.metadata,
      roomId: "",
    },
  });
  assertCondition(!implicitNodeId.eligible && implicitNodeId.reason === "missing-room-id", "node identity must not substitute for provider room identity", implicitNodeId);

  const staleRoom = graphNodeRoomEntryEligibility({
    ...semanticRoom,
    metadata: {
      ...semanticRoom.metadata,
      roomGraphFreshnessStatus: "stale",
    },
  });
  assertCondition(!staleRoom.eligible && staleRoom.reason === "room-not-fresh", "stale semantic rooms must not expose entry", staleRoom);

  const currentRoom = graphNodeRoomEntryEligibility(semanticRoom, { currentRoomId: "semantic-room" });
  assertCondition(!currentRoom.eligible && currentRoom.reason === "current-room", "active room must not navigate to itself", currentRoom);

  const sourceRecord = {
    id: "source-record",
    metadata: {
      ...semanticRoom.metadata,
      roomId: "SOURCE-RECORD",
      entryKind: "source-evidence",
      navigationKind: "none",
      roomGraphSourceModel: "multihead-atlas-source-inventory-v1",
    },
  };
  const projection = {
    nodes: [sourceRecord, semanticRoom],
    metadata: {
      architectureAtlas: {
        plan: {
          candidates: [sourceRecord, semanticRoom],
        },
      },
    },
  };
  assertCondition(graphProjectionRoomEntryTargetId(projection, "SOURCE-RECORD") === "", "direct source-record routes must resolve to setup rather than room detail");
  assertCondition(graphProjectionRoomEntryTargetId(projection, "SEMANTIC-ROOM") === "SEMANTIC-ROOM", "direct semantic-room routes must resolve from the provider projection");
  assertCondition(graphProjectionRoomEntryTargetId(projection, "SEMANTIC-ROOM", { currentRoomId: "SEMANTIC-ROOM" }) === "", "projection navigation must reject the active room target");

  const repositoryAuthority = {
    id: "fixture-repository",
    metadata: {
      roomId: "fixture-repository",
      repositoryId: "fixture-repository",
      entryKind: "repository-authority",
      navigationKind: "repository-overview",
      repositoryOverviewStatus: "available",
      repositoryOverviewEndpoint: "/api/architecture-graph",
      roomGraphStatus: "unavailable",
      graphEndpoint: "",
    },
  };
  const overviewReturn = graphNodeRepositoryOverviewEligibility(repositoryAuthority, {
    currentRoomId: "semantic-room",
  });
  assertCondition(overviewReturn.eligible && overviewReturn.repositoryId === "FIXTURE-REPOSITORY", "room context should expose its repository authority as an overview return", overviewReturn);
  const authorityOnOverview = graphNodeRepositoryOverviewEligibility(repositoryAuthority, {
    currentRoomId: "",
  });
  assertCondition(!authorityOnOverview.eligible && authorityOnOverview.reason === "overview-already-active", "repository authority must remain inert on the overview", authorityOnOverview);
  const authorityWithRoomEndpoint = graphNodeRepositoryOverviewEligibility({
    ...repositoryAuthority,
    metadata: {
      ...repositoryAuthority.metadata,
      repositoryOverviewEndpoint: "/api/architecture-graph?slice=FIXTURE-REPOSITORY",
    },
  }, { currentRoomId: "semantic-room" });
  assertCondition(!authorityWithRoomEndpoint.eligible && authorityWithRoomEndpoint.reason === "invalid-repository-overview-endpoint", "repository overview return must not request an authority room", authorityWithRoomEndpoint);
}

/** Verifies optional shell tabs follow provider evidence instead of static category registration. */
function auditSourceCategoryAvailability() {
  assertCondition(
    !atlasSourceCategoryAvailable({ nodes: [], edges: [], containers: [], metadata: { status: "empty" } }),
    "empty provider projections must not expose a source tab",
  );
  assertCondition(
    !atlasSourceCategoryAvailable({ nodes: [{ id: "router" }], edges: [], metadata: { sourceAvailable: false } }),
    "an explicit unavailable capability must override decorative router nodes",
  );
  assertCondition(
    atlasSourceCategoryAvailable({ nodes: [{ id: "architecture" }], edges: [], metadata: {} }),
    "non-empty provider projections should remain compatible without new availability metadata",
  );
}

const FORBIDDEN_CORE_PATTERNS = Object.freeze([
  {
    id: "source-category-sessions",
    pattern: /\b(sessions?|workstreams?)\b/i,
  },
  {
    id: "source-category-retrieval",
    pattern: /\bretrieval\b/i,
  },
  {
    id: "source-category-git",
    pattern: /\b(git|git[-_ ]?gate)\b/i,
  },
  {
    id: "source-category-backlog",
    pattern: /\bbacklog\b/i,
  },
  {
    id: "source-category-architecture",
    pattern: /\barchitecture\b/i,
  },
  {
    id: "rooted-flow-one-off",
    pattern: /\brooted[-_ ]?(flow|columns?)\b/i,
  },
  {
    id: "group-distribution-one-off",
    pattern: /\bgroupDistribution\b/,
  },
  {
    id: "category-branch",
    pattern: /\bprojectionView\s*={2,3}\s*["'][^"']+["']/,
  },
]);

/** Checks one model, precompute, or source-neutrality invariant with structured evidence. */
function assertCondition(condition, message, details = {}) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

/** Returns diagnostic codes in stable order for exact fixture comparisons. */
function sortedCodes(errors) {
  return errors.map((error) => error.code).sort();
}

/** Checks whether a diagnostic collection contains one required invariant code. */
function hasCode(errors, code) {
  return errors.some((error) => error.code === code);
}

/** Verifies a valid generic projection normalizes without importing product-specific semantics. */
function auditValidGenericModel() {
  const ids = {
    entry: normalizeId("entry-node"),
    containerA: normalizeId("container-a"),
    containerB: normalizeId("container-b"),
    childA: normalizeId("child-node-a"),
    childB: normalizeId("child-node-b"),
  };
  const projection = {
    schema: "audit",
    view: "generic",
    authority: "model audit",
    nodes: [
      {
        id: "entry-node",
        label: "Entry Node",
        kind: "root",
        gridWidthCells: 4,
        gridHeightCells: 1,
      },
      {
        id: "child-node-a",
        label: "Child Node A",
        parentId: "container-a",
        gridWidthCells: 3,
        gridHeightCells: 1,
      },
      {
        id: "child-node-b",
        label: "Child Node B",
        gridWidthCells: 3,
        gridHeightCells: 1,
      },
    ],
    containers: [
      {
        id: "container-a",
        label: "Container A",
        description: "Owns one node and one nested container.",
        childIds: ["child-node-a", "container-b"],
        gridWidthCells: 12,
        gridHeightCells: 8,
      },
      {
        id: "container-b",
        label: "Container B",
        nodeIds: ["child-node-b"],
        collapsed: true,
        gridWidthCells: 8,
        gridHeightCells: 6,
      },
    ],
    edges: [
      {
        id: "edge-entry-container",
        from: "entry-node",
        to: "container-a",
        kind: "relationship",
      },
      {
        id: "edge-container-node",
        from: "container-a",
        to: "child-node-b",
        kind: "relationship",
      },
    ],
  };

  const model = normalizeGraphModel(projection);
  assertCondition(model.diagnostics.errors.length === 0, "valid generic model should not report errors", {
    errors: model.diagnostics.errors,
  });
  assertCondition(model.metrics.nodes === 3, "model should preserve node count", model.metrics);
  assertCondition(model.metrics.containers === 2, "model should preserve container count", model.metrics);
  assertCondition(model.metrics.elements === 5, "nodes and containers should both be elements", model.metrics);
  assertCondition(model.containersById.get(ids.containerB)?.renderAsNode === true, "collapsed containers should render as nodes");
  assertCondition(model.parentById.get(ids.childA) === ids.containerA, "explicit node parent should be preserved");
  assertCondition(model.parentById.get(ids.containerB) === ids.containerA, "nested container parent should be derived from childIds");
  assertCondition(model.parentById.get(ids.childB) === ids.containerB, "nodeIds alias should derive containment");
  assertCondition(model.childrenByContainerId.get(ids.containerA)?.includes(ids.containerB), "container childIds should allow nested containers");
  assertCondition(model.elementById.has(ids.containerA), "container endpoints should be routable elements");
  assertCondition(model.edges.every((edge) => model.elementById.has(edge.from) && model.elementById.has(edge.to)), "edge endpoints should resolve to elements");
  assertCondition(GRAPH_MODEL_MIN_ELEMENT_GAP_CELLS >= 1, "model must reserve at least one grid cell between sibling elements", {
    minElementGapCells: GRAPH_MODEL_MIN_ELEMENT_GAP_CELLS,
  });
}

/** Verifies duplicate identities, cycles, and missing endpoints produce stable diagnostics. */
function auditInvalidModels() {
  const duplicate = validateGraphModel({
    nodes: [{ id: "same-id" }],
    containers: [{ id: "same-id" }],
    edges: [],
  });
  assertCondition(hasCode(duplicate.errors, "duplicate-element-id"), "duplicate node/container ids should fail", {
    errors: sortedCodes(duplicate.errors),
  });

  const missingChild = validateGraphModel({
    nodes: [{ id: "node-a" }],
    containers: [{ id: "container-a", childIds: ["missing-node"] }],
    edges: [],
  });
  assertCondition(hasCode(missingChild.errors, "missing-container-child"), "missing container child should fail", {
    errors: sortedCodes(missingChild.errors),
  });

  const missingEndpoint = validateGraphModel({
    nodes: [{ id: "node-a" }],
    containers: [],
    edges: [{ from: "node-a", to: "missing-node" }],
  });
  assertCondition(hasCode(missingEndpoint.errors, "missing-edge-target"), "missing edge target should fail", {
    errors: sortedCodes(missingEndpoint.errors),
  });

  const cycle = validateGraphModel({
    nodes: [],
    containers: [
      { id: "container-a", childIds: ["container-b"] },
      { id: "container-b", childIds: ["container-a"] },
    ],
    edges: [],
  });
  assertCondition(hasCode(cycle.errors, "container-cycle"), "container cycles should fail", {
    errors: sortedCodes(cycle.errors),
  });

  const multipleParents = validateGraphModel({
    nodes: [{ id: "node-a", parentId: "container-a" }],
    containers: [
      { id: "container-a" },
      { id: "container-b", childIds: ["node-a"] },
    ],
    edges: [],
  });
  assertCondition(hasCode(multipleParents.errors, "multiple-parents"), "multiple parent ownership should fail", {
    errors: sortedCodes(multipleParents.errors),
  });
}

/** Verifies precomputed geometry validation, selection overlay, and presentation-mode compatibility. */
function auditPrecomputedViewModel() {
  const valid = validateGraphViewModel({
    schema: "audit-precomputed-view-model",
    presentationMode: "compact",
    nodes: [
      {
        id: "origin",
        label: "Origin",
        kind: "node",
        x: 0,
        y: 0,
        width: 128,
        height: 32,
      },
      {
        id: "target",
        label: "Target",
        kind: "node",
        x: 192,
        y: 64,
        width: 128,
        height: 32,
      },
    ],
    containers: [
      {
        id: "container-a",
        label: "Container A",
        x: 160,
        y: 32,
        width: 192,
        height: 128,
      },
    ],
    edges: [
      {
        id: "edge-origin-target",
        from: "origin",
        to: "target",
        kind: "relationship",
        path: "M 128 16 C 156 16 164 80 192 80",
      },
    ],
  });
  assertCondition(valid.valid === true, "precomputed view model should accept complete rendered geometry", {
    errors: valid.errors,
  });
  assertCondition(valid.metrics.nodes === 2, "precomputed view model should preserve node count", valid.metrics);
  assertCondition(valid.metrics.containers === 1, "precomputed view model should preserve container count", valid.metrics);

  const invalid = validateGraphViewModel({
    nodes: [
      { id: "origin", label: "Origin", x: 0, y: 0, width: 128, height: 32 },
      { id: "target", label: "Target", x: 192, y: 64, width: 128, height: 32 },
    ],
    edges: [
      {
        id: "edge-origin-target",
        from: "origin",
        to: "target",
        kind: "relationship",
      },
    ],
  });
  assertCondition(hasCode(invalid.errors, "missing-edge-path"), "precomputed routed edges should require a rendered path", {
    errors: sortedCodes(invalid.errors),
  });

  const invalidBox = validateGraphViewModel({
    nodes: [
      { id: "origin", label: "Origin", x: 0, y: 0, width: 128 },
    ],
    edges: [],
  });
  assertCondition(hasCode(invalidBox.errors, "invalid-node-box"), "precomputed nodes should require explicit measured boxes", {
    errors: sortedCodes(invalidBox.errors),
  });

  const built = buildIllustrationGraphViewModel({
    selectedNodeId: "target",
    presentationMode: "compact",
    memoryGraph: {
      nodes: [{ id: "ignored-local-node", label: "Ignored", kind: "node" }],
      edges: [],
      viewModel: {
        presentationMode: "compact",
        nodes: [
          { id: "origin", label: "Origin", kind: "node", x: 320, y: 96, width: 128, height: 32 },
          { id: "target", label: "Target", kind: "node", x: 512, y: 96, width: 128, height: 32 },
        ],
        edges: [
          {
            id: "edge-origin-target",
            from: "origin",
            to: "target",
            kind: "relationship",
            path: "M 448 112 C 472 112 488 112 512 112",
          },
        ],
      },
    },
  });
  assertCondition(built.precomputed === true, "builder should preserve precomputed geometry marker");
  assertCondition(built.nodes.length === 2, "builder should use precomputed nodes instead of local source nodes", {
    nodes: built.nodes.map((node) => node.id),
  });
  assertCondition(built.nodes.some((node) => node.id === normalizeId("target") && node.selected === true), "builder should apply frontend selection to precomputed nodes");

  const sourceProjection = {
    schema: "audit-precompute-producer",
    view: "generic",
    nodes: [
      { id: "root", label: "Root", kind: "kernel" },
      { id: "target", label: "Target", kind: "memory" },
    ],
    edges: [
      { from: "root", to: "target", kind: "relationship" },
    ],
  };
  const packet = buildPrecomputedGraphViewModel(sourceProjection, {
    presentationMode: "compact",
    routeMode: "quality",
  });
  const packetValidation = validateGraphViewModel(packet);
  assertCondition(packetValidation.valid === true, "precompute producer should emit a valid view-model packet", {
    errors: packetValidation.errors,
  });
  assertCondition(packet.schema === "multihead-memory-graph.view-model.v1", "precompute producer should stamp the view-model schema", {
    schema: packet.schema,
  });
  assertCondition(packet.presentationMode === "compact", "precompute producer should stamp the packet presentation mode", {
    presentationMode: packet.presentationMode,
  });
  assertCondition(packet.nodes.every((node) => node.selected !== true && node.activeChain !== true), "precompute producer should not bake frontend selection/focus state");

  const wrappedProjection = buildProjectionWithPrecomputedGraphViewModel(sourceProjection, {
    presentationMode: "compact",
    routeMode: "quality",
  });
  const compactBuilt = buildIllustrationGraphViewModel({
    memoryGraph: wrappedProjection,
    presentationMode: "compact",
  });
  assertCondition(compactBuilt.precomputed === true, "builder should consume matching precomputed packet");
  assertCondition(compactBuilt.nodes.length === packet.nodes.length, "matching precomputed packet should preserve produced node count", {
    produced: packet.nodes.length,
    consumed: compactBuilt.nodes.length,
  });

  const extendedBuilt = buildIllustrationGraphViewModel({
    memoryGraph: wrappedProjection,
    presentationMode: "extended",
  });
  assertCondition(extendedBuilt.precomputed !== true, "builder should fall back to local layout when packet presentation mode differs");

  const stripped = stripGraphPrecomputedViewModel(wrappedProjection);
  assertCondition(!stripped.viewModel && !stripped.viewModels && !stripped.precomputedViewModel, "strip helper should remove top-level precomputed packets");
}

/** Scans exported core modules for prohibited provider-specific vocabulary and dependencies. */
async function auditCoreSourceNeutrality() {
  const findings = [];
  for (const file of CORE_FILES) {
    const absolutePath = resolve(file);
    const source = await readFile(absolutePath, "utf8");
    const lines = source.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const rule of FORBIDDEN_CORE_PATTERNS) {
        if (!rule.pattern.test(line)) continue;
        findings.push({
          file,
          line: index + 1,
          rule: rule.id,
          text: line.trim(),
        });
      }
    });
  }

  assertCondition(findings.length === 0, "graph-core files must stay source-category neutral", {
    findings,
  });
}

/** Runs generic model, invalid fixture, precompute, and source-neutrality contract checks. */
async function main() {
  auditValidGenericModel();
  auditInvalidModels();
  auditPrecomputedViewModel();
  auditRoomNavigationContract();
  auditSourceCategoryAvailability();
  await auditCoreSourceNeutrality();

  console.log(JSON.stringify({
    ok: true,
    audits: [
      "valid-generic-model",
      "invalid-model-diagnostics",
      "precomputed-view-model",
      "room-navigation-contract",
      "source-category-availability",
      "core-source-neutrality",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    message: error.message,
    details: error.details || null,
  }, null, 2));
  process.exit(1);
});
