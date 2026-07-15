#!/usr/bin/env node

/*
 * Architecture Atlas Audit verifies source-neutral ranking, room eligibility,
 * provider packet traversal, and stable Architecture candidate ordering.
 */
import {
  findArchitectureRoomPath,
  normalizeArchitectureAtlas,
  planArchitectureTraversal,
  rankArchitectureRooms,
  validateArchitectureAtlas,
} from "../architecture-atlas.js";

/** Checks one Atlas normalization, ranking, path, or traversal invariant with diagnostic context. */
function assertCondition(condition, message, details = {}) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

/** Builds a connected source-neutral room fixture with deliberate costs and ranking signals. */
function buildFixtureAtlas() {
  return {
    schema: "audit",
    rooms: [
      {
        id: "repository-root",
        label: "Example Repository",
        owner: "repository-root",
        viewpoint: "registry",
        summary: "Repository manifest, package registry, task entry, and component coordination boundary.",
        sourceRepos: ["repository-root"],
        entryNodeIds: ["manifest.json"],
        exitNodeIds: ["registered-components"],
        answers: ["where repository setup begins"],
        facets: ["repository-setup", "workspace-registry"],
        authorityScore: 1,
        freshnessScore: 0.95,
      },
      {
        id: "runtime-core",
        label: "Runtime Core",
        owner: "runtime-core",
        viewpoint: "engine",
        summary: "Shared deterministic runtime engine and domain behavior repository.",
        sourceRepos: ["runtime-core"],
        entryNodeIds: ["runtime-core"],
        exitNodeIds: ["runtime-core"],
        answers: ["where deterministic runtime and domain behavior live"],
        facets: ["repository-setup", "engine"],
        authorityScore: 0.9,
        freshnessScore: 0.9,
      },
      {
        id: "client-app",
        label: "Client App",
        owner: "client-app",
        viewpoint: "desktop-host",
        summary: "Desktop and web application host repository.",
        sourceRepos: ["client-app"],
        entryNodeIds: ["client-app"],
        exitNodeIds: ["client-app"],
        answers: ["where desktop and visible app host work live"],
        facets: ["repository-setup", "desktop-host"],
        authorityScore: 0.9,
        freshnessScore: 0.9,
      },
      {
        id: "knowledge-provider",
        label: "Knowledge Provider",
        owner: "knowledge-provider",
        viewpoint: "atlas-rag-provider",
        summary: "Local retrieval and projection source authority.",
        sourceRepos: ["knowledge-provider"],
        entryNodeIds: ["knowledge-provider"],
        exitNodeIds: ["knowledge-provider"],
        answers: ["where memory truth and provider endpoints live"],
        facets: ["repository-setup", "memory", "provider"],
        authorityScore: 0.9,
        freshnessScore: 0.9,
      },
      {
        id: "graph-viewer",
        label: "Graph Viewer",
        owner: "graph-viewer",
        viewpoint: "memory-graph-lens",
        summary: "Standalone transferable graph lens for memory and architecture projections.",
        sourceRepos: ["graph-viewer"],
        entryNodeIds: ["graph-viewer"],
        exitNodeIds: ["graph-viewer"],
        answers: ["where graph visualization behavior lives"],
        facets: ["repository-setup", "graph", "visual-lens"],
        authorityScore: 0.9,
        freshnessScore: 0.9,
      },
      {
        id: "support-tools",
        label: "Support Tools",
        owner: "support-tools",
        viewpoint: "artifact-container",
        summary: "Support container for utilities, archives, experiments, and loose artifacts.",
        sourceRepos: ["support-tools"],
        entryNodeIds: ["support-tools"],
        exitNodeIds: ["support-tools"],
        answers: ["where artifact support work lives"],
        facets: ["repository-setup", "artifact-container"],
        authorityScore: 0.8,
        freshnessScore: 0.8,
      },
    ],
    portals: [
      {
        id: "workspace-registers-engine",
        fromRoomId: "repository-root",
        toRoomId: "runtime-core",
        kind: "registers_project_repo",
        label: "registered project repo",
        traversalCost: 1,
        bidirectional: true,
      },
      {
        id: "workspace-registers-desktop",
        fromRoomId: "repository-root",
        toRoomId: "client-app",
        kind: "registers_project_repo",
        label: "registered project repo",
        traversalCost: 1,
        bidirectional: true,
      },
      {
        id: "workspace-registers-atlas",
        fromRoomId: "repository-root",
        toRoomId: "knowledge-provider",
        kind: "registers_project_repo",
        label: "registered project repo",
        traversalCost: 1,
        bidirectional: true,
      },
      {
        id: "workspace-registers-memory-graph",
        fromRoomId: "repository-root",
        toRoomId: "graph-viewer",
        kind: "registers_project_repo",
        label: "registered project repo",
        traversalCost: 1,
        bidirectional: true,
      },
      {
        id: "workspace-registers-artifacts",
        fromRoomId: "repository-root",
        toRoomId: "support-tools",
        kind: "registers_container",
        label: "registered artifact container",
        traversalCost: 1,
        bidirectional: true,
      },
      {
        id: "desktop-uses-engine",
        fromRoomId: "client-app",
        toRoomId: "runtime-core",
        kind: "uses_runtime_engine",
        label: "uses engine",
        traversalCost: 1,
        bidirectional: false,
      },
      {
        id: "atlas-feeds-memory-graph",
        fromRoomId: "knowledge-provider",
        toRoomId: "graph-viewer",
        kind: "provides_projection_source",
        label: "provides graph projections",
        traversalCost: 1,
        bidirectional: true,
      },
    ],
  };
}

/** Verifies that the valid fixture normalizes without structural errors or identity drift. */
function auditValidAtlas() {
  const model = normalizeArchitectureAtlas(buildFixtureAtlas());
  assertCondition(model.diagnostics.errors.length === 0, "valid atlas should not report errors", {
    errors: model.diagnostics.errors,
  });
  assertCondition(model.metrics.rooms === 6, "atlas should preserve workspace entry count", model.metrics);
  assertCondition(model.metrics.portals === 7, "atlas should preserve workspace relationship count", model.metrics);
  assertCondition(model.portalsByRoomId.get("REPOSITORY-ROOT")?.length >= 5, "repository entry should expose registered components");
}

/** Verifies duplicate rooms and missing portal endpoints remain explicit model errors. */
function auditInvalidAtlas() {
  const diagnostics = validateArchitectureAtlas({
    rooms: [{ id: "room-a", label: "Room A" }],
    portals: [{ id: "broken", fromRoomId: "room-a", toRoomId: "missing-room" }],
  });
  assertCondition(
    diagnostics.errors.some((error) => error.code === "missing-portal-target-room"),
    "missing portal target room should fail",
    diagnostics,
  );

  const orphanDiagnostics = validateArchitectureAtlas({
    rooms: [
      { id: "room-a", sourceRepos: ["a"], answers: ["a"], entryNodeIds: ["a"], exitNodeIds: ["a"] },
      { id: "room-b", sourceRepos: ["b"], answers: ["b"], entryNodeIds: ["b"], exitNodeIds: ["b"] },
    ],
    portals: [],
  });
  assertCondition(
    orphanDiagnostics.warnings.some((warning) => warning.code === "orphan-room"),
    "unconnected rooms should warn because rooms must be connected, not isolated diagrams",
    orphanDiagnostics,
  );
}

/** Verifies route and query evidence rank the intended architecture room first. */
function auditRoomRanking() {
  const route = {
    taskKind: "architecture-room-navigation",
    affectedRepos: ["client-app", "runtime-core"],
    sourceAuthorities: ["repository-root", "knowledge-provider", "graph-viewer"],
    stems: ["graph", "memory-system", "validation-authority"],
    facets: { graph: true, memory: true },
    matchedSignals: ["architecture-rooms"],
  };
  const ranked = rankArchitectureRooms(buildFixtureAtlas(), {
    query: "desktop app host repository",
    route,
  });
  assertCondition(ranked[0]?.roomId === "CLIENT-APP", "client app should rank first for desktop host query", {
    top: ranked.slice(0, 3).map((item) => ({ roomId: item.roomId, score: item.score })),
  });
}

/** Verifies structured lexical and vector score parts survive ranking explanation output. */
function auditStructuredIndexScoreParts() {
  const ranked = rankArchitectureRooms(buildFixtureAtlas(), {
    query: "semantic graph route",
    indexScores: {
      "graph-viewer": {
        score: 0.95,
        lexical: 0.7,
        vector: 0.82,
        source: "sqlite-token-vector-index",
      },
    },
  });
  const memoryGraph = ranked.find((item) => item.roomId === "GRAPH-VIEWER");
  assertCondition(memoryGraph?.parts?.indexSimilarity === 0.95, "combined index score should be preserved", memoryGraph);
  assertCondition(memoryGraph?.parts?.lexicalIndexSimilarity === 0.7, "lexical index score part should be preserved", memoryGraph);
  assertCondition(memoryGraph?.parts?.vectorSimilarity === 0.82, "vector index score part should be preserved", memoryGraph);
  assertCondition(memoryGraph?.parts?.indexScoreSource === "sqlite-token-vector-index", "index score source should be preserved", memoryGraph);
}

/** Verifies deterministic lowest-cost portal traversal across the fixture room graph. */
function auditRoomPath() {
  const model = normalizeArchitectureAtlas(buildFixtureAtlas());
  const path = findArchitectureRoomPath(model, "client-app", "runtime-core");
  assertCondition(path.found === true, "repo relationship path should be found through typed portals", path);
  assertCondition(
    path.roomIds.join(">") === "CLIENT-APP>RUNTIME-CORE",
    "desktop-to-engine path should use the explicit runtime-engine relationship",
    path,
  );
  assertCondition(path.portalIds.length === 1, "repo path should expose the direct relationship portal id", path);
}

/** Verifies ranked traversal candidates include explainable route penalties and selected room. */
function auditTraversalPlan() {
  const plan = planArchitectureTraversal(buildFixtureAtlas(), {
    query: "graph visualization lens repository",
    currentRoomId: "repository-root",
    route: {
      taskKind: "architecture-room-navigation",
      affectedRepos: ["graph-viewer", "knowledge-provider"],
      sourceAuthorities: ["repository-root", "graph-viewer"],
      stems: ["graph"],
      facets: { graph: true, memory: true },
    },
  });
  assertCondition(plan.selected?.roomId === "GRAPH-VIEWER", "graph lens query should land in graph viewer", plan);
  assertCondition(plan.selected?.path?.found === true, "selected room should include a traversable path", plan.selected);
  assertCondition(plan.selected?.path?.roomIds?.length === 2, "selected path should stay short", plan.selected);
}

const audits = [
  ["valid-atlas", auditValidAtlas],
  ["invalid-atlas-diagnostics", auditInvalidAtlas],
  ["room-ranking", auditRoomRanking],
  ["structured-index-score-parts", auditStructuredIndexScoreParts],
  ["room-path", auditRoomPath],
  ["traversal-plan", auditTraversalPlan],
];

const completed = [];
try {
  for (const [name, audit] of audits) {
    audit();
    completed.push(name);
  }
  console.log(JSON.stringify({ ok: true, audits: completed }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    completed,
    error: error.message,
    details: error.details || {},
  }, null, 2));
  process.exit(1);
}
