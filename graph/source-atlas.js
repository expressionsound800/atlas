/*
 * Atlas Source Adapters fetch and normalize provider-owned Sessions, Git Gate,
 * Architecture catalog, room, route, and precomputed projection packets.
 */
import { graphNodeRoomEntryEligibility } from "./graph-navigation.js";

export const ATLAS_ARCHITECTURE_GRAPH_ENDPOINT = "/api/architecture-graph";
export const ATLAS_ARCHITECTURE_ROOM_GRAPH_ENDPOINT = "/api/architecture-graph";
export const ATLAS_ARCHITECTURE_ROUTE_ENDPOINT = "/api/architecture-route?query=architecture";
export const ATLAS_ARCHITECTURE_SLICES_ENDPOINT = "/api/architecture-slices?query=architecture";
export const ATLAS_WORKSTREAMS_ENDPOINT = "/api/workstreams";
export const ATLAS_GIT_GATE_GRAPH_ENDPOINT = "/api/git-gate-graph";
export const ATLAS_BACKLOG_GRAPH_ENDPOINT = "/api/backlog-graph";
export const ATLAS_ROUTER_HEALTH_ENDPOINT = "/api/router-health";

const GENERIC_REPOSITORY_SOURCE_MODELS = new Set([
  "multihead-atlas-default-repository-adapter",
  "consumer-repository-catalog",
  "multihead-atlas-source-inventory-v1",
  "multihead-atlas-repository-system-model-v1",
]);

export const ATLAS_SOURCE_CATEGORIES = Object.freeze([
  {
    id: "workstreams",
    label: "Sessions",
    mode: "workstreams",
    view: "workstreams",
    endpoint: ATLAS_WORKSTREAMS_ENDPOINT,
  },
  {
    id: "git",
    label: "Git Gate",
    mode: "git-gate-graph",
    view: "git-gate",
    endpoint: ATLAS_GIT_GATE_GRAPH_ENDPOINT,
  },
  {
    id: "backlog",
    label: "Backlog",
    mode: "backlog-graph",
    view: "backlog",
    endpoint: ATLAS_BACKLOG_GRAPH_ENDPOINT,
  },
  {
    id: "architecture",
    label: "Architecture",
    mode: "architecture-graph",
    view: "architecture",
    endpoint: ATLAS_ARCHITECTURE_GRAPH_ENDPOINT,
    atlasEndpoint: ATLAS_ARCHITECTURE_ROUTE_ENDPOINT,
    slicesEndpoint: ATLAS_ARCHITECTURE_SLICES_ENDPOINT,
    roomGraphEndpoint: ATLAS_ARCHITECTURE_ROOM_GRAPH_ENDPOINT,
  },
]);

const SESSION_ACTIVE_WINDOW_HOURS = 12;
const SESSION_RESUME_WINDOW_HOURS = 48;
const SESSION_RECENT_WINDOW_HOURS = 72;

/** Derives presentation and routing options carried by one provider projection. */
export function atlasGraphViewOptions(projection = {}) {
  return {
    containers: Array.isArray(projection?.containers) ? projection.containers : [],
    placementById: {},
  };
}

/** Returns true for an explicitly enabled source or a non-empty packet not marked empty or unavailable. */
export function atlasSourceCategoryAvailable(projection = {}) {
  const metadata = projection?.metadata && typeof projection.metadata === "object"
    ? projection.metadata
    : {};
  if (metadata.sourceAvailable === true) return true;
  if (metadata.sourceAvailable === false) return false;
  const status = compactValue(metadata.status || metadata.architectureProjectionMode).toLowerCase();
  if (["empty", "unavailable"].includes(status)) return false;
  return listFrom(projection?.nodes).length > 0
    || listFrom(projection?.edges).length > 0
    || listFrom(projection?.containers).length > 0;
}

/** Normalizes provider scalar text while retaining an explicit fallback for absent values. */
function compactValue(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

/** Returns provider arrays unchanged and treats non-array payload shapes as empty. */
function listFrom(value) {
  return Array.isArray(value) ? value : [];
}

/** Collapses and bounds provider prose before it enters Graph labels or descriptions. */
function compactText(value, maxLength = 220) {
  const text = compactValue(value).replace(/\s+/g, " ");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

/** Checks phrase equality after case, whitespace, and terminal punctuation normalization. */
function samePhrase(left, right) {
  const normalizedLeft = compactValue(left).replace(/\s+/g, " ").toLowerCase();
  const normalizedRight = compactValue(right).replace(/\s+/g, " ").toLowerCase();
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

/** Builds one normalized source node with provider provenance and visual metadata. */
function sourceNode(id, label, kind, options = {}) {
  return {
    id,
    label: compactValue(label, id),
    kind,
    layer: options.layer || kind,
    description: options.description || "",
    source: options.source || "",
    ...(options.extra || {}),
  };
}

/** Builds one normalized provider relationship with readable and visual style metadata. */
function sourceEdge(from, to, kind, options = {}) {
  return {
    from,
    to,
    kind,
    description: options.description || "",
    ...(options.extra || {}),
  };
}

/** Normalizes one objective history entry from string or structured monitor payload form. */
function objectiveStep(value, capturedAt = "") {
  if (value && typeof value === "object") {
    return {
      label: compactText(value.label || "", 64),
      text: compactText(value.text || value.summary || value.label || "", 220),
      capturedAt: value.capturedAt || capturedAt || "",
    };
  }
  return {
    label: "",
    text: compactText(value || "", 220),
    capturedAt: capturedAt || "",
  };
}

/** Derives a concise objective-step label from the first meaningful sentence fragment. */
function objectiveStepLabel(text, fallback = "Objective") {
  const clean = compactValue(text);
  const lower = clean.toLowerCase();
  if (!clean) return fallback;
  if (lower.includes("observed sessions") && (lower.includes("sessions source") || lower.includes("workstreams"))) {
    return "Observed sessions source";
  }
  if (lower.includes("graph spacing") || lower.includes("connectors")) return "Graph geometry";
  return compactText(clean.replace(/[.;:].*$/, ""), 56);
}

/** Builds a chronological deduplicated objective trail from current and historical session data. */
function objectiveTrail(stream) {
  const decisionSteps = Array.isArray(stream?.decisionSteps)
    ? stream.decisionSteps
      .map((item) => objectiveStep(item, stream?.summaryGeneratedAt || stream?.updatedAt || ""))
      .filter((step) => step.text)
      .slice(0, 8)
    : [];
  if (decisionSteps.length) {
    return {
      entry: "",
      current: "",
      mutations: decisionSteps,
      changed: true,
      generated: true,
      steps: decisionSteps,
    };
  }
  const entryStep = objectiveStep(
    stream?.entryObjective || stream?.summary || stream?.title || "",
    stream?.entryCapturedAt || stream?.updatedAt || "",
  );
  const currentStep = objectiveStep(
    stream?.currentObjective || stream?.summary || "",
    stream?.currentCapturedAt || stream?.updatedAt || "",
  );
  const mutations = Array.isArray(stream?.objectiveMutations)
    ? stream.objectiveMutations
      .map((item) => objectiveStep(item, stream?.currentCapturedAt || stream?.updatedAt || ""))
      .filter((step) => step.text)
      .slice(0, 3)
    : [];
  const currentIsDifferent = currentStep.text && !samePhrase(currentStep.text, entryStep.text);
  return {
    entry: entryStep.text,
    current: currentStep.text,
    mutations,
    changed: Boolean(entryStep.text && currentIsDifferent) || mutations.length > 0,
    steps: [
      entryStep,
      ...mutations,
      currentIsDifferent ? currentStep : null,
    ].filter((step) => step?.text),
  };
}

/** Checks whether a monitor row explicitly carries a workstream identity in its payload. */
function explicitPayloadWorkstream(stream) {
  if (!stream || typeof stream !== "object") return false;
  if (stream.id === "primary-current") return false;
  if (stream.kind === "source objective") return false;
  if (stream.title === "memory/CURRENT.md") return false;
  return true;
}

/** Derives a readable session label from payload identity, title, or stable sequence fallback. */
function sessionLabel(stream, index) {
  return compactValue(stream?.title, compactValue(stream?.id, `observed:${index + 1}`));
}

/** Resolves the most specific source locator recorded for one observed session. */
function sessionSource(stream) {
  return compactValue(stream?.sourcePath || stream?.file || stream?.context || stream?.source || "");
}

/** Builds a bounded source-derived session summary when no provider summary is available. */
function generatedSessionSummary(session = {}) {
  const generated = session?.generatedSummary && typeof session.generatedSummary === "object"
    ? session.generatedSummary
    : {};
  return {
    summary: compactValue(generated.summary || ""),
    source: compactValue(session?.summarySource || generated.source || ""),
    generatedAt: compactValue(session?.summaryGeneratedAt || generated.generatedAt || ""),
  };
}

/** Builds ordered decision-step evidence from explicit session objectives and recent events. */
function generatedSessionDecisionSteps(session = {}) {
  const decisions = Array.isArray(session?.generatedSummary?.decisions)
    ? session.generatedSummary.decisions
    : [];
  return decisions
    .map((decision, index) => {
      if (!decision || typeof decision !== "object") return objectiveStep(decision, "");
      const text = compactText(decision.text || decision.summary || decision.label || "", 220);
      if (!text) return null;
      return {
        label: compactText(decision.label || `Decision ${index + 1}`, 64),
        text,
        capturedAt: decision.capturedAt || decision.generatedAt || "",
      };
    })
    .filter(Boolean);
}

/** Selects the latest non-empty decision step as the session's generated current focus. */
function sessionGeneratedCurrentStep(decisionSteps = []) {
  return Array.isArray(decisionSteps) && decisionSteps.length
    ? decisionSteps[decisionSteps.length - 1]
    : null;
}

/** Resolves current objective from explicit payload fields before source-derived decision evidence. */
function sessionCurrentObjective(session = {}, decisionSteps = [], fallback = "") {
  const currentStep = sessionGeneratedCurrentStep(decisionSteps);
  return compactValue(
    session?.currentGoal
      || session?.currentObjective
      || currentStep?.text
      || fallback,
  );
}

/** Converts an optional session timestamp to milliseconds or the neutral zero sentinel. */
function sessionTimestampMs(value) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? time : null;
}

/** Selects the newest meaningful activity timestamp across monitor and payload fields. */
function sessionActivityTime(stream = {}) {
  const times = [
    stream?.latestUserAt,
    stream?.observedAt,
    stream?.updatedAt,
    stream?.summaryGeneratedAt,
    stream?.startedAt,
  ]
    .map(sessionTimestampMs)
    .filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}

/** Computes whole hours since the session's latest recorded activity timestamp. */
function sessionHoursSinceActivity(stream = {}, nowMs = Date.now()) {
  const activityTime = sessionActivityTime(stream);
  if (!Number.isFinite(activityTime)) return Infinity;
  return Math.max(0, (Number(nowMs) - activityTime) / (60 * 60 * 1000));
}

/** Normalizes session status text to lowercase activity-classification input. */
function normalizedSessionStatus(value = "") {
  return compactValue(value).toLowerCase().replace(/[_-]+/g, " ");
}

/** Checks explicit terminal flags and status vocabulary for a closed observed session. */
function sessionIsClosed(stream = {}) {
  const status = normalizedSessionStatus(sessionStatusText(stream));
  return ["completed", "complete", "archived", "closed", "done"].includes(status)
    || Boolean(stream?.completedAt)
    || stream?.archived === true;
}

/** Checks explicit blockers, errors, and attention status without inferring from age alone. */
function sessionNeedsAttention(stream = {}) {
  const status = normalizedSessionStatus(stream?.memoryImpact?.status || stream?.attentionStatus || "");
  return ["suggested", "unscanned", "blocking", "attention", "needs review"].includes(status);
}

/** Classifies one session as active, attention, resumable, stale, or closed from evidence. */
function classifySessionActivity(stream = {}, nowMs = Date.now()) {
  const status = normalizedSessionStatus(sessionStatusText(stream));
  const explicitLive = ["active", "ongoing", "running", "in progress", "current"].includes(status);
  const closed = sessionIsClosed(stream);
  const hoursSinceActivity = sessionHoursSinceActivity(stream, nowMs);

  if (!closed && explicitLive && hoursSinceActivity <= SESSION_ACTIVE_WINDOW_HOURS) return "active";
  if (!closed && hoursSinceActivity <= SESSION_RESUME_WINDOW_HOURS) return "resumable";
  if (sessionNeedsAttention(stream)) return "attention";
  if (hoursSinceActivity <= SESSION_RECENT_WINDOW_HOURS) return "recent";
  if (!closed && explicitLive) return "resumable";
  return "past";
}

/** Maps terminal session states to past, attention, or neutral node emphasis. */
function terminalVisualEmphasisForSession(activityState = "") {
  if (activityState === "active" || activityState === "resumable") return "current";
  if (activityState === "attention") return "attention";
  if (activityState === "recent") return "context";
  return "past";
}

/** Maps non-terminal surrounding sessions to attention, context, or past emphasis. */
function contextVisualEmphasisForSession(activityState = "") {
  if (activityState === "active" || activityState === "resumable" || activityState === "attention") {
    return "context";
  }
  return "past";
}

/** Normalizes monitor data into one source-derived session record with activity and objective evidence. */
function normalizeObservedSession(session, index) {
  const sessionId = compactValue(session?.id, `session-${index + 1}`);
  const title = compactValue(session?.title, `Observed session ${index + 1}`);
  const generated = generatedSessionSummary(session);
  const decisionSteps = generatedSessionDecisionSteps(session);
  const summary = compactValue(generated.summary || session?.summary || title);
  const currentStep = sessionGeneratedCurrentStep(decisionSteps);
  const currentObjective = sessionCurrentObjective(session, decisionSteps, summary);
  return {
    id: `session-${sessionId}`,
    title,
    kind: "observed session",
    summary,
    summarySource: generated.source,
    summaryGeneratedAt: generated.generatedAt,
    sourcePath: session?.file || session?.source || "",
    context: session?.source || "",
    source: session?.source || "",
    status: session?.status || "",
    liveStatus: session?.liveStatus || session?.status || "",
    cwdLabel: session?.cwdLabel || "",
    startedAt: session?.startedAt || "",
    observedAt: session?.observedAt || "",
    latestUserAt: session?.latestUserAt || "",
    completedAt: session?.completedAt || "",
    archived: session?.archived === true,
    updatedAt: session?.latestUserAt || session?.observedAt || session?.updatedAt || session?.startedAt || "",
    entryObjective: session?.initialGoal || session?.goal || summary || title,
    currentObjective,
    currentObjectiveLabel: compactValue(currentStep?.label || "Current point"),
    objectiveMutations: decisionSteps,
    decisionSteps,
    latestUserMessage: session?.latestUserMessage || "",
    lastAgentMessage: session?.lastAgentMessage || "",
    branchSignalText: session?.branchSignalText || "",
    toolCallCount: Number(session?.toolCallCount || 0),
    memoryImpact: session?.memoryImpact || {},
  };
}

/** Selects the most relevant normalized sessions while preserving attention and current work. */
function visibleSessions(monitor, limit = 6) {
  const observed = Array.isArray(monitor?.observedSessions)
    ? monitor.observedSessions.slice(0, limit).map(normalizeObservedSession)
    : [];
  if (observed.length) return observed;
  return Array.isArray(monitor?.workstreams?.items)
    ? monitor.workstreams.items.filter(explicitPayloadWorkstream).slice(0, limit)
    : [];
}

/** Builds compact status and activity-age text for a session node or container. */
function sessionStatusText(stream = {}) {
  return compactValue(stream?.liveStatus || stream?.status || stream?.recencyLabel || "session");
}

/** Computes the visible operation count from explicit counters and event evidence. */
function sessionOperationCount(stream = {}) {
  const count = Number(stream?.toolCallCount || stream?.operationCount || 0);
  return Number.isFinite(count) && count > 0 ? Math.round(count) : 0;
}

/** Formats the operation count using singular or plural session surface wording. */
function sessionOperationLabel(stream = {}) {
  const count = sessionOperationCount(stream);
  return count ? `${count} operations` : "";
}

/** Maps session activity state to the container lifecycle role used by rendering. */
function sessionContainerRole(stream = {}) {
  return [sessionStatusText(stream), sessionOperationLabel(stream)].filter(Boolean).join(" · ");
}

/** Builds the workstream projection with session containers, objective steps, gates, and emphasis. */
export function sessionGraph(monitor, options = {}) {
  const nodes = [];
  const edges = [];
  const containers = [];
  const streams = visibleSessions(monitor);
  const optionNowMs = Number(options?.nowMs);
  const nowMs = Number.isFinite(optionNowMs) ? optionNowMs : Date.now();

  nodes.push(sourceNode("sessions:router", "Observed Sessions", "session_router", {
    layer: "sessions source",
    description: "Operational concurrency and handoff evidence from Atlas workstreams after repository task routing; not task focus or Architecture truth.",
    source: ATLAS_WORKSTREAMS_ENDPOINT,
    extra: {
      metadata: {
        surfaceRole: compactValue(monitor?.surface?.role || "operational-concurrency-evidence"),
        decisionBoundary: compactValue(monitor?.surface?.decisionBoundary || "after-task-routing"),
        usefulFor: listFrom(monitor?.surface?.usefulFor),
        notAuthorityFor: listFrom(monitor?.surface?.notAuthorityFor),
      },
    },
  }));

  for (const [index, stream] of streams.entries()) {
    const streamId = compactValue(stream?.id, `stream-${index + 1}`);
    const id = `workstream:${streamId}`;
    const trail = objectiveTrail(stream);
    const source = sessionSource(stream);
    const operationCount = sessionOperationCount(stream);
    const operationLabel = sessionOperationLabel(stream);
    const activityState = classifySessionActivity(stream, nowMs);
    const containerNodeIds = [id];
    const sessionNodes = [];
    const sessionNode = sourceNode(id, sessionLabel(stream, index), "session", {
      layer: "session route",
      description: stream?.summary || trail.current || trail.entry || stream?.next || "",
      source,
      extra: {
        metadata: {
          source,
          cwdLabel: compactValue(stream?.cwdLabel || ""),
          operationCount,
          operationCountText: operationLabel,
          status: sessionStatusText(stream),
          toolCallCount: operationCount,
          summary: compactValue(stream?.summary || ""),
          currentObjective: compactValue(stream?.currentObjective || ""),
          currentObjectiveLabel: compactValue(stream?.currentObjectiveLabel || ""),
          summarySource: compactValue(stream?.summarySource || ""),
          summaryGeneratedAt: compactValue(stream?.summaryGeneratedAt || ""),
          activityState,
        },
      },
    });
    nodes.push(sessionNode);
    sessionNodes.push(sessionNode);
    edges.push(sourceEdge("sessions:router", id, "observes_session", {
      description: "Observed session contributes operational concurrency and handoff context after route selection.",
    }));

    let previousId = id;
    let gateIndex = 0;
    /** Adds one deduplicated decision-gate node and its causal edge to the session trail. */
    const addGate = (suffix, label, description, layer = "decision gate") => {
      const gateId = `${id}:${suffix}`;
      const gateNode = sourceNode(gateId, label, "decision_gate", {
        layer,
        description,
        source,
      });
      nodes.push(gateNode);
      sessionNodes.push(gateNode);
      containerNodeIds.push(gateId);
      edges.push(sourceEdge(previousId, gateId, "decision_flow", {
        description: `Session decision path reaches ${label}.`,
      }));
      previousId = gateId;
      gateIndex += 1;
      return gateId;
    };

    if (trail.entry) {
      addGate("entry", objectiveStepLabel(trail.entry), trail.entry, "objective trail");
    }

    for (const [mutationIndex, mutation] of trail.mutations.entries()) {
      addGate(
        `mutation-${mutationIndex + 1}`,
        mutation.label || objectiveStepLabel(mutation.text, "Objective change"),
        mutation.text,
        "objective trail",
      );
    }

    if (trail.changed && trail.current && !samePhrase(trail.current, trail.entry)) {
      addGate("current", objectiveStepLabel(trail.current), trail.current, "objective trail");
    }

    const latestSignal = trail.generated
      ? ""
      : compactText(stream?.latestUserMessage || stream?.branchSignalText || stream?.next || "", 180);
    if (latestSignal) addGate("latest-user-signal", "Latest User Signal", latestSignal, "routing signal");

    const memoryImpact = stream?.memoryImpact || {};
    if (memoryImpact.label || memoryImpact.status) {
      addGate("memory-impact", memoryImpact.label || memoryImpact.status, memoryImpact.reason || memoryImpact.status || "", "memory gate");
    }

    const terminalNode = sessionNodes[sessionNodes.length - 1] || sessionNode;
    const currentObjectiveText = compactValue(
      memoryImpact?.reason
        ? `${memoryImpact.label || memoryImpact.status || "Memory state"}: ${memoryImpact.reason}`
        : "",
    ) || compactValue(stream?.currentObjective || terminalNode?.description || trail.current || trail.entry || "");
    const currentObjectiveLabel = compactValue(
      memoryImpact?.label || stream?.currentObjectiveLabel || terminalNode?.label || "Current point",
    );
    if (sessionNode.metadata && typeof sessionNode.metadata === "object") {
      sessionNode.metadata.currentObjective = currentObjectiveText;
      sessionNode.metadata.currentObjectiveLabel = currentObjectiveLabel;
      sessionNode.metadata.currentNodeId = terminalNode?.id || "";
      sessionNode.metadata.currentNodeLabel = terminalNode?.label || "";
      sessionNode.metadata.activityState = activityState;
    }
    const terminalEmphasis = terminalVisualEmphasisForSession(activityState);
    const contextEmphasis = contextVisualEmphasisForSession(activityState);
    sessionNodes.forEach((node) => {
      node.visualEmphasis = node === terminalNode ? terminalEmphasis : contextEmphasis;
      if (node.metadata && typeof node.metadata === "object") {
        node.metadata.activityState = activityState;
      }
    });

    containers.push({
      id: `container:${id}`,
      kind: "session_group",
      label: sessionLabel(stream, index),
      role: sessionContainerRole(stream),
      description: compactText(stream?.summary || trail.current || trail.entry || "", 160),
      visualEmphasis: activityState,
      nodeIds: containerNodeIds,
      metadata: {
        source,
        cwdLabel: compactValue(stream?.cwdLabel || stream?.area || stream?.source || stream?.context || ""),
        operationCount,
        operationCountText: operationLabel,
        status: sessionStatusText(stream),
        toolCallCount: operationCount,
        summary: compactValue(stream?.summary || ""),
        currentObjective: currentObjectiveText,
        currentObjectiveLabel,
        currentNodeId: terminalNode?.id || "",
        currentNodeLabel: terminalNode?.label || "",
        summarySource: compactValue(stream?.summarySource || ""),
        summaryGeneratedAt: compactValue(stream?.summaryGeneratedAt || ""),
        activityState,
      },
    });
  }

  return {
    schema: "multihead-atlas.memory_graph.v2.sessions",
    authority: "atlas",
    view: "workstreams",
    surface: monitor?.surface || {
      role: "operational-concurrency-evidence",
      decisionBoundary: "after-task-routing",
    },
    nodes,
    edges,
    containers,
    metadata: {
      sourceAvailable: streams.length > 0,
    },
  };
}

/** Reads a Node environment setting without assuming process exists in the browser. */
function nodeEnvValue(name) {
  return typeof process !== "undefined" && process?.env ? compactValue(process.env[name]) : "";
}

/** Extracts the origin from an absolute endpoint and ignores relative or malformed input. */
function baseUrlFromEndpoint(endpoint = "") {
  try {
    const url = new URL(String(endpoint || ""));
    return `${url.protocol}//${url.host}`;
  } catch (_error) {
    return "";
  }
}

/** Resolves Atlas provider origin from explicit options, browser injection, or Node environment. */
function atlasBaseUrl(options = {}) {
  return compactValue(
    options.baseUrl
      || options.atlasBaseUrl
      || baseUrlFromEndpoint(options.endpoint)
      || nodeEnvValue("MH_MEMORY_GRAPH_BASE_URL")
      || nodeEnvValue("ATLAS_BASE_URL")
      || nodeEnvValue("MH_ATLAS_BASE_URL"),
  );
}

/** Resolves a provider endpoint against the configured Atlas origin when it is relative. */
function fetchEndpoint(endpoint, options = {}) {
  const rawEndpoint = String(endpoint || "");
  if (/^https?:\/\//i.test(rawEndpoint)) return rawEndpoint;
  if (typeof window !== "undefined") return rawEndpoint;
  const baseUrl = atlasBaseUrl(options) || "http://127.0.0.1:8765";
  return new URL(rawEndpoint, baseUrl).href;
}

/** Fetches provider JSON and reports non-success status with endpoint context. */
async function fetchJson(endpoint, options = {}) {
  const response = await fetch(fetchEndpoint(endpoint, options), { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** Adds the requested precompute flag to an endpoint without discarding existing query parameters. */
function endpointWithPrecompute(endpoint, options = {}) {
  if (options.precompute === false) return endpoint;
  const presentationMode = String(options.presentationMode || "").trim().toLowerCase();
  if (presentationMode !== "compact" && presentationMode !== "extended") return endpoint;
  const url = new URL(String(endpoint || ""), "http://atlas-graph.local");
  if (!url.searchParams.has("precompute")) url.searchParams.set("precompute", presentationMode);
  if (!url.searchParams.has("presentationMode")) url.searchParams.set("presentationMode", presentationMode);
  if (/^https?:\/\//i.test(String(endpoint || ""))) return url.href;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Validates that a provider response contains node and edge arrays required by Graph. */
function assertProjectionPayload(projection) {
  if (!projection || !Array.isArray(projection.nodes) || !Array.isArray(projection.edges)) {
    throw new Error("invalid projection payload");
  }
  return projection;
}

/** Fetches and validates a Graph projection from one explicit provider endpoint. */
export async function fetchAtlasProjection(options = {}) {
  const endpoint = compactValue(options.endpoint);
  if (!endpoint) throw new Error("Atlas projection endpoint is required");
  const precomputedEndpoint = endpointWithPrecompute(endpoint, options);
  if (precomputedEndpoint !== endpoint) {
    try {
      return assertProjectionPayload(await fetchJson(precomputedEndpoint, options));
    } catch (error) {
      if (options.requirePrecompute === true) throw error;
    }
  }
  return assertProjectionPayload(await fetchJson(endpoint, options));
}

/** Builds the architecture route endpoint with query and current-room context. */
function architectureRouteEndpoint(options = {}) {
  const explicitEndpoint = compactValue(options.architectureRouteEndpoint || options.atlasEndpoint || "");
  if (explicitEndpoint) return explicitEndpoint;
  const query = compactValue(options.architectureQuery || "architecture");
  const currentRoom = compactValue(options.currentArchitectureRoom || "");
  const params = new URLSearchParams({ query });
  if (currentRoom) params.set("currentRoom", currentRoom);
  return `/api/architecture-route?${params.toString()}`;
}

/** Fetches the provider-authored architecture ranking and traversal plan. */
export async function fetchAtlasArchitectureRoute(options = {}) {
  return fetchJson(architectureRouteEndpoint(options), options);
}

/** Builds the architecture slices endpoint with the active retrieval query. */
function architectureSlicesEndpoint(options = {}) {
  const explicitEndpoint = compactValue(options.architectureSlicesEndpoint || options.slicesEndpoint || "");
  if (explicitEndpoint) return explicitEndpoint;
  const query = compactValue(options.architectureQuery || "architecture");
  const params = new URLSearchParams({ query });
  return `/api/architecture-slices?${params.toString()}`;
}

/** Fetches provider room and portal slices used to build repository setup. */
export async function fetchAtlasArchitectureSlices(options = {}) {
  return fetchJson(architectureSlicesEndpoint(options), options);
}

/** Builds the selected room's Graph endpoint while preserving provider-specific query parameters. */
function architectureRoomGraphEndpoint(options = {}) {
  const explicitEndpoint = compactValue(options.architectureRoomGraphEndpoint || options.roomGraphEndpoint || "");
  if (explicitEndpoint) {
    const roomId = compactValue(options.currentArchitectureRoom || options.roomId || options.sliceId || "");
    if (!roomId) return explicitEndpoint;
    const url = new URL(explicitEndpoint, "http://atlas-graph.local");
    if (!url.searchParams.has("slice")) url.searchParams.set("slice", roomId);
    if (!url.searchParams.has("query")) url.searchParams.set("query", compactValue(options.architectureQuery || "architecture"));
    if (/^https?:\/\//i.test(explicitEndpoint)) return url.href;
    return `${url.pathname}${url.search}${url.hash}`;
  }
  const roomId = compactValue(options.currentArchitectureRoom || options.roomId || options.sliceId || "");
  if (!roomId) return "";
  const query = compactValue(options.architectureQuery || "architecture");
  const params = new URLSearchParams({ query, slice: roomId });
  return `/api/architecture-graph?${params.toString()}`;
}

/** Fetches and validates the detailed Graph projection for one architecture room. */
export async function fetchAtlasArchitectureRoomGraph(options = {}) {
  const endpoint = architectureRoomGraphEndpoint(options);
  if (!endpoint) throw new Error("architecture room graph endpoint requires a room id");
  return fetchAtlasProjection({
    endpoint,
    presentationMode: options.presentationMode,
    precompute: options.precompute,
    requirePrecompute: options.requirePrecompute,
    baseUrl: atlasBaseUrl(options),
  });
}

/** Extracts the repository identity prefix from a normalized Git-gate node identifier. */
function gitRepoBaseId(nodeId = "") {
  const match = String(nodeId || "").match(/^(git:repo:[^:]+)/);
  return match ? match[1] : "";
}

/** Assigns a stable Git workflow column from node kind and gate semantics. */
function gitGateNodeColumn(node = {}) {
  const kind = String(node?.kind || "").trim().toLowerCase();
  if (kind === "git_repo") return 1;
  if (kind === "git_expected_ref") return 2;
  if (kind === "git_current_ref") return 3;
  if (kind === "git_head") return 4;
  return Math.max(1, Number(node?.rank || 2));
}

/** Normalizes Git-gate nodes into repository lanes, containers, and explicit workflow placement. */
export function normalizeGitGateGraph(projection = {}) {
  const sourceNodes = Array.isArray(projection?.nodes) ? projection.nodes : [];
  const repoNodes = sourceNodes
    .filter((node) => String(node?.kind || "").trim().toLowerCase() === "git_repo")
    .sort((left, right) => Number(left.order || 0) - Number(right.order || 0)
      || String(left.id || "").localeCompare(String(right.id || "")));
  const repoLaneById = new Map(repoNodes.map((node, index) => [String(node.id || ""), index * 1.45]));
  const repoLabelById = new Map(repoNodes.map((node) => [String(node.id || ""), String(node.label || node.id || "")]));
  const nodes = sourceNodes.map((node) => {
    const nodeId = String(node?.id || "");
    const baseRepoId = gitRepoBaseId(nodeId);
    if (nodeId === "git-gate:family") {
      return {
        ...node,
        graphSide: "root",
        graphLane: 0,
      };
    }
    return {
      ...node,
      graphSide: "right",
      graphColumn: gitGateNodeColumn(node),
      graphLane: repoLaneById.get(baseRepoId) ?? Number(node?.order || 0) / 10,
    };
  });
  const containers = repoNodes.map((repoNode) => {
    const repoId = String(repoNode.id || "");
    const nodeIds = sourceNodes
      .map((node) => String(node?.id || ""))
      .filter((nodeId) => nodeId === repoId || gitRepoBaseId(nodeId) === repoId);
    return {
      id: `container:${repoId}`,
      kind: "git_repo_group",
      label: repoLabelById.get(repoId) || repoId,
      role: compactValue(repoNode.status || repoNode.activity || "git repo"),
      description: compactText(repoNode.description || "", 160),
      nodeIds,
    };
  });
  return {
    ...projection,
    nodes,
    containers,
  };
}

/** Fetches monitor data and builds the source-derived workstreams projection. */
export async function sessionsProvider(options = {}) {
  const endpoint = options.endpoint || ATLAS_WORKSTREAMS_ENDPOINT;
  const precomputedEndpoint = endpointWithPrecompute(endpoint, options);
  if (precomputedEndpoint !== endpoint) {
    try {
      return assertProjectionPayload(await fetchJson(precomputedEndpoint, options));
    } catch (error) {
      if (options.requirePrecompute === true) throw error;
    }
  }
  const monitor = await fetchJson(endpoint, options);
  return sessionGraph(monitor);
}

/** Fetches and normalizes the provider's Git-gate projection for Graph rendering. */
export async function gitGateProvider(options = {}) {
  const projection = await fetchAtlasProjection({
    endpoint: options.endpoint || ATLAS_GIT_GATE_GRAPH_ENDPOINT,
    presentationMode: options.presentationMode,
    precompute: options.precompute,
    requirePrecompute: options.requirePrecompute,
    baseUrl: atlasBaseUrl(options),
  });
  return projection?.viewModel ? projection : normalizeGitGateGraph(projection);
}

/** Fetches the provider's backlog projection with optional precomputed geometry. */
export async function backlogProvider(options = {}) {
  return fetchAtlasProjection({
    endpoint: options.endpoint || ATLAS_BACKLOG_GRAPH_ENDPOINT,
    presentationMode: options.presentationMode,
    precompute: options.precompute,
    requirePrecompute: options.requirePrecompute,
    baseUrl: atlasBaseUrl(options),
  });
}

/** Indexes room ranking candidates by normalized identifier for setup-node evidence. */
function architectureRoomScoreById(routePayload = {}) {
  const scores = new Map();
  const candidates = Array.isArray(routePayload?.plan?.candidates) ? routePayload.plan.candidates : [];
  for (const candidate of candidates) {
    const id = compactValue(candidate?.roomId).toUpperCase();
    if (!id) continue;
    scores.set(id, candidate);
  }
  return scores;
}

const ARCHITECTURE_ENTRYPOINT_EXCLUDED_SECTIONS = new Set([
  "artifact_spaces",
  "generated_regions",
  "generated_rooms",
  "utility_scripts",
  "experiments",
]);

/** Checks whether a room has explicit Graph entry nodes and can appear in repository setup. */
function architectureEntrypointRoom(room = {}) {
  const section = compactValue(room?.metadata?.workspaceSection).toLowerCase();
  return !ARCHITECTURE_ENTRYPOINT_EXCLUDED_SECTIONS.has(section);
}

/** Normalizes the provider room identity used by architecture setup and drilldown. */
function architectureRoomId(room = {}) {
  return compactValue(room?.id).toUpperCase();
}

/** Selects portals whose source and target both belong to visible entrypoint rooms. */
function architectureEntrypointPortals(portals = [], roomIds = new Set()) {
  return portals.filter((portal) => {
    const from = compactValue(portal?.fromRoomId).toUpperCase();
    const to = compactValue(portal?.toRoomId).toUpperCase();
    return roomIds.has(from) && roomIds.has(to);
  });
}

/** Maps room ownership metadata to a readable repository, product, or workspace node kind. */
function architectureWorkspaceNodeKind(room = {}) {
  const section = compactValue(room?.metadata?.workspaceSection).toLowerCase();
  if (section === "family") return "architecture_repository_root";
  if (section === "project_repos") return "architecture_project_repo";
  if (section === "generated_regions") return "architecture_generated_region";
  if (section === "generated_rooms") return "architecture_generated_room";
  if (section === "containers") return "architecture_container";
  if (section === "artifact_spaces") return "architecture_artifact_space";
  if (section === "utility_scripts") return "architecture_utility";
  return "architecture_workspace_entry";
}

/** Derives the concise repository-setup label from room identity and ownership metadata. */
function architectureWorkspaceProjectionLabel(room = {}) {
  const kind = compactValue(room?.metadata?.workspaceKind || room?.viewpoint);
  const section = compactValue(room?.metadata?.workspaceSection);
  return compactValue(kind || section || "workspace entry");
}

/** Groups architecture entrypoint nodes into labeled repository-setup sections. */
function architectureRepositorySetupContainers(roomNodes = [], roomEdges = [], selectedRoom = {}) {
  /** Selects visible room nodes whose normalized setup section belongs to one section family. */
  const bySection = (sections = []) => roomNodes
    .filter((node) => sections.includes(compactValue(node?.metadata?.workspaceSection)))
    .map((node) => node.id);
  const repositoryNodeIds = bySection(["family", "project_repos"]);
  const artifactNodeIds = roomNodes
    .filter((node) => {
      const section = compactValue(node?.metadata?.workspaceSection);
      return ["containers", "artifact_spaces", "utility_scripts"].includes(section);
    })
    .map((node) => node.id);
  const generatedRegionNodeIds = bySection(["generated_regions"]);
  const generatedRoomNodeIds = bySection(["generated_rooms"]);
  return [
    {
      id: "container:repositories",
      kind: "architecture_repository_group",
      label: "Repositories",
      role: "registered source repositories",
      description: compactText(
        "Repository entrypoints admitted by the provider for architecture traversal.",
        180,
      ),
      nodeIds: repositoryNodeIds,
      metadata: {
        currentObjective: selectedRoom?.label
          ? `Repository setup entry: ${selectedRoom.label}`
          : "",
        entryCount: repositoryNodeIds.length,
        relationshipCount: roomEdges.length,
      },
    },
    {
      id: "container:generated-regions",
      kind: "architecture_region_group",
      label: "Generated Regions",
      role: "source-derived traversal regions",
      description: compactText(
        "Provider-generated traversal regions derived from source authority before per-repository drilldown.",
        180,
      ),
      nodeIds: generatedRegionNodeIds,
      metadata: {
        currentObjective: "Generated traversal regions bridge repository entrypoints and source-derived rooms.",
        entryCount: generatedRegionNodeIds.length,
        relationshipCount: roomEdges.filter((edge) =>
          generatedRegionNodeIds.includes(edge.from) || generatedRegionNodeIds.includes(edge.to)
        ).length,
      },
    },
    {
      id: "container:generated-rooms",
      kind: "architecture_room_group",
      label: "Generated Rooms",
      role: "source-derived generated drilldowns",
      description: compactText(
        "Provider-generated source-derived rooms that drill below a topology region without pretending to be repositories.",
        180,
      ),
      nodeIds: generatedRoomNodeIds,
      metadata: {
        currentObjective: "Generated drilldown rooms remain provider-owned and source-derived before graph rendering.",
        entryCount: generatedRoomNodeIds.length,
        relationshipCount: roomEdges.filter((edge) =>
          generatedRoomNodeIds.includes(edge.from) || generatedRoomNodeIds.includes(edge.to)
        ).length,
      },
    },
    {
      id: "container:artifacts",
      kind: "architecture_artifact_group",
      label: "Artifacts",
      role: "registered artifact repositories",
      description: compactText(
        "Registered artifacts repo containing utilities, experiments, and generated codebase archives.",
        180,
      ),
      nodeIds: artifactNodeIds,
      metadata: {
        currentObjective: "Artifact repo structure: utilities, experiments, archives, and archive production.",
        entryCount: artifactNodeIds.length,
        relationshipCount: roomEdges.filter((edge) =>
          artifactNodeIds.includes(edge.from) || artifactNodeIds.includes(edge.to)
        ).length,
      },
    },
  ].filter((container) => container.nodeIds.length > 0);
}

/** Builds the repository setup projection from ranked rooms, portals, and source evidence. */
function architectureRoomGraphProjection(routePayload = {}, slicesPayload = {}) {
  const rooms = (Array.isArray(slicesPayload?.atlas?.rooms) ? slicesPayload.atlas.rooms : [])
    .filter(architectureEntrypointRoom);
  const entrypointRoomIds = new Set(rooms.map((room) => architectureRoomId(room)).filter(Boolean));
  const portals = architectureEntrypointPortals(
    Array.isArray(slicesPayload?.atlas?.portals) ? slicesPayload.atlas.portals : [],
    entrypointRoomIds,
  );
  const selectedRoomId = compactValue(
    routePayload?.selectedRoom?.id || routePayload?.plan?.selected?.roomId,
  ).toUpperCase();
  const routeRoomIds = new Set(
    (Array.isArray(routePayload?.plan?.selected?.path?.roomIds) ? routePayload.plan.selected.path.roomIds : [])
      .map((roomId) => compactValue(roomId).toUpperCase())
      .filter(Boolean),
  );
  const scoreById = architectureRoomScoreById(routePayload);
  const roomNodes = rooms.map((room) => {
    const roomId = compactValue(room?.id).toUpperCase();
    const score = scoreById.get(roomId);
    const isSelected = Boolean(selectedRoomId && roomId === selectedRoomId);
    const inSelectedPath = routeRoomIds.has(roomId);
    const graphEndpoint = compactValue(room?.metadata?.graphEndpoint || room?.graphEndpoint || "");
    const metadata = {
      owner: compactValue(room?.owner),
      viewpoint: compactValue(room?.viewpoint),
      roomId,
      entryKind: compactValue(room?.metadata?.entryKind || room?.entryKind),
      navigationKind: compactValue(room?.metadata?.navigationKind || room?.navigationKind),
      workspaceSection: compactValue(room?.metadata?.workspaceSection),
      workspaceKind: compactValue(room?.metadata?.workspaceKind),
      workspacePath: compactValue(room?.metadata?.workspacePath),
      workspaceGitRoot: compactValue(room?.metadata?.workspaceGitRoot),
      workspaceDurability: compactValue(room?.metadata?.workspaceDurability),
      workspacePolicy: compactValue(room?.metadata?.workspacePolicy),
      roomGraphStatus: compactValue(room?.metadata?.roomGraphStatus),
      roomGraphSourceModel: compactValue(room?.metadata?.roomGraphSourceModel),
      roomGraphFreshnessStatus: compactValue(
        room?.metadata?.roomGraphFreshnessStatus || room?.freshnessStatus,
      ),
      sourceRepos: Array.isArray(room?.sourceRepos) ? room.sourceRepos.join(", ") : "",
      summaryStatus: compactValue(room?.summaryStatus),
      summaryUpdatedAt: compactValue(room?.summaryUpdatedAt),
      authorityScore: Number(room?.authorityScore || 0),
      freshnessScore: Number(room?.freshnessScore || 0),
      roomScore: Number(score?.finalScore ?? score?.score ?? 0),
      indexSimilarity: Number(score?.reason?.indexSimilarity || 0),
      lexicalIndexSimilarity: Number(score?.reason?.lexicalIndexSimilarity || 0),
      vectorSimilarity: Number(score?.reason?.vectorSimilarity || 0),
      indexScoreSource: compactValue(score?.reason?.indexScoreSource || ""),
      answers: Array.isArray(room?.answers) ? room.answers.join("; ") : "",
      graphEndpoint,
      selectedRoom: isSelected ? "true" : "",
    };
    const roomEntry = graphNodeRoomEntryEligibility({ id: roomId, metadata });
    return sourceNode(roomId, room?.label || roomId, architectureWorkspaceNodeKind(room), {
      layer: architectureWorkspaceProjectionLabel(room),
      description: compactValue(room?.generatedSummary || room?.summary || ""),
      source: graphEndpoint,
      extra: {
        drilldownCapable: roomEntry.eligible,
        visualEmphasis: isSelected ? "current" : inSelectedPath || score ? "context" : "past",
        metadata: {
          ...metadata,
          drilldownCapable: roomEntry.eligible ? "true" : "",
        },
      },
    });
  });
  const roomIds = new Set(roomNodes.map((node) => node.id));
  const roomEdges = portals
    .map((portal) => {
      const from = compactValue(portal?.fromRoomId).toUpperCase();
      const to = compactValue(portal?.toRoomId).toUpperCase();
      if (!roomIds.has(from) || !roomIds.has(to)) return null;
      return sourceEdge(from, to, portal?.kind || "architecture_portal", {
        description: compactValue(portal?.reason || portal?.label || portal?.kind || "Architecture room portal."),
        extra: {
          id: compactValue(portal?.id, `${from}:${to}`),
          label: compactValue(portal?.label || portal?.kind || "portal"),
          visualStyle: "primary",
          metadata: {
            traversalCost: Number(portal?.traversalCost || 1),
            bidirectional: portal?.bidirectional === true,
          },
        },
      });
    })
    .filter(Boolean);
  const selectedRoom = routePayload?.selectedRoom || roomNodes.find((node) => node.id === selectedRoomId) || {};
  return {
    schema: "multihead-memory-graph.architecture_rooms_projection.v1",
    authority: slicesPayload?.authority || routePayload?.authority || "atlas",
    view: "architecture",
    nodes: roomNodes,
    edges: roomEdges,
    containers: architectureRepositorySetupContainers(roomNodes, roomEdges, selectedRoom),
    metadata: {
      architectureAtlas: routePayload,
      architectureSlices: {
        schema: slicesPayload?.schema,
        generatedAt: slicesPayload?.generatedAt,
        metrics: slicesPayload?.atlas?.metrics,
      },
      architectureAtlasStatus: "live",
      architectureProjectionMode: "repository-setup",
      architectureProjectionSource: compactValue(slicesPayload?.atlas?.metadata?.sourceModel),
    },
  };
}

/** Checks whether slices belong to Atlas Core's source-neutral repository adapter. */
function genericRepositorySlices(slicesPayload = {}) {
  return GENERIC_REPOSITORY_SOURCE_MODELS.has(compactValue(slicesPayload?.atlas?.metadata?.sourceModel));
}

/** Fetches overview or room-detail architecture data and returns its Graph-ready projection. */
export async function architectureProvider(options = {}) {
  try {
    if (compactValue(options.currentArchitectureRoom)) {
      return await fetchAtlasArchitectureRoomGraph(options);
    }
    const [atlasRoute, atlasSlices] = await Promise.all([
      fetchAtlasArchitectureRoute(options),
      fetchAtlasArchitectureSlices(options),
    ]);
    if (genericRepositorySlices(atlasSlices)) {
      return fetchAtlasArchitectureRoomGraph({
        ...options,
        currentArchitectureRoom: compactValue(atlasSlices?.atlas?.authority),
      });
    }
    return architectureRoomGraphProjection(atlasRoute, atlasSlices);
  } catch (error) {
    return {
      schema: "multihead-memory-graph.architecture_unavailable.v1",
      authority: "atlas",
      view: "architecture",
      nodes: [],
      edges: [],
      containers: [],
      metadata: {
        sourceAvailable: false,
        architectureAtlasStatus: "unavailable",
        architectureAtlasError: String(error?.message || error),
        architectureProjectionMode: "unavailable",
        architectureProjectionSource: "atlas-required",
      },
    };
  }
}

/** Fetches provider router health for the Graph status panel. */
export async function fetchAtlasRouterHealth(options = {}) {
  return fetchJson(options.endpoint || ATLAS_ROUTER_HEALTH_ENDPOINT, options);
}

/** Dispatches the selected source category to its explicit provider adapter. */
export async function fetchAtlasGraphForCategory(categoryId, options = {}) {
  const id = String(categoryId || "").trim().toLowerCase();
  if (id === "workstreams") return sessionsProvider(options);
  if (id === "git") return gitGateProvider(options);
  if (id === "backlog") return backlogProvider(options);
  if (id === "architecture") {
    const baseUrl = atlasBaseUrl(options);
    return architectureProvider({
      endpoint: options.endpoint || ATLAS_ARCHITECTURE_GRAPH_ENDPOINT,
      atlasEndpoint: options.atlasEndpoint || options.architectureRouteEndpoint,
      slicesEndpoint: options.slicesEndpoint || options.architectureSlicesEndpoint,
      roomGraphEndpoint: options.roomGraphEndpoint || options.architectureRoomGraphEndpoint,
      architectureQuery: options.architectureQuery,
      currentArchitectureRoom: options.currentArchitectureRoom,
      presentationMode: options.presentationMode,
      precompute: options.precompute,
      requirePrecompute: options.requirePrecompute,
      baseUrl,
    });
  }
  throw new Error(`unsupported Atlas graph category: ${id || "(empty)"}`);
}
