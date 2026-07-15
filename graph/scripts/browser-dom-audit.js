#!/usr/bin/env node

/*
 * Browser DOM Audit verifies rendered Graph theme, interaction, persistence,
 * selection, metadata, and release-fixture behavior through the documented CDP
 * path. When explicitly requested, the same validated browser state is written
 * as a PNG to a caller-owned registered technical-space path.
 */
import fs from "node:fs";
import path from "node:path";

const CDP_PORT = Number(process.env.MH_CDP_PORT || 9227);
const GRAPH_URL = String(process.env.MH_GRAPH_AUDIT_URL || "http://127.0.0.1:8911/#sessions");
const EXPECTED_CATEGORY = String(process.env.MH_GRAPH_EXPECTED_CATEGORY || "workstreams").trim().toLowerCase();
const EXPECTED_TITLE = String(process.env.MH_GRAPH_EXPECTED_TITLE || "").trim();
const EXPECTED_SOURCE_CATEGORIES = String(process.env.MH_GRAPH_EXPECTED_SOURCE_CATEGORIES || "")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean)
  .sort();
const EXPECTED_ARCHITECTURE_MODE = String(process.env.MH_GRAPH_EXPECTED_ARCHITECTURE_MODE || "repository-setup").trim().toLowerCase();
const EXPECTED_ARCHITECTURE_ROOM = String(process.env.MH_GRAPH_EXPECTED_ARCHITECTURE_ROOM || "").trim().toUpperCase();
const SELECT_NODE_ID = String(process.env.MH_GRAPH_SELECT_NODE_ID || "").trim().toUpperCase();
const EXPECT_ENTER_ROOM_ACTION = process.env.MH_GRAPH_EXPECT_ENTER_ROOM_ACTION === "1";
const EXPECT_SIGNAL_FLOW_FOCUS = process.env.MH_GRAPH_EXPECT_SIGNAL_FLOW_FOCUS === "1";
const EXPECT_SIGNAL_FLOW_HIGHLIGHT = process.env.MH_GRAPH_EXPECT_SIGNAL_FLOW_HIGHLIGHT === "1" || EXPECT_SIGNAL_FLOW_FOCUS;
const EXPECT_WHITEBOARD_VIEWPORT = process.env.MH_GRAPH_EXPECT_WHITEBOARD_VIEWPORT === "1";
const EXPECT_ARCHITECTURE_ROOM_FALLBACK = process.env.MH_GRAPH_EXPECT_ARCHITECTURE_ROOM_FALLBACK === "1";
const EXPECT_ARCHITECTURE_ROOM_BACK_RESET = process.env.MH_GRAPH_EXPECT_ARCHITECTURE_ROOM_BACK_RESET === "1";
const EXPECT_REPOSITORY_OVERVIEW_NODE_RETURN = process.env.MH_GRAPH_EXPECT_REPOSITORY_OVERVIEW_NODE_RETURN === "1";
const EXPECT_NAVIGATION_NODE_DRAG = process.env.MH_GRAPH_EXPECT_NAVIGATION_NODE_DRAG === "1";
const EXPECT_ROUTE_CANDIDATE_SWITCH_ROOM = String(process.env.MH_GRAPH_EXPECT_ROUTE_CANDIDATE_SWITCH_ROOM || "")
  .trim()
  .toUpperCase();
const EXPECT_CONTAINER_COLLAPSE = process.env.MH_GRAPH_EXPECT_CONTAINER_COLLAPSE === "1";
const TIMEOUT_MS = Number(process.env.MH_GRAPH_AUDIT_TIMEOUT_MS || 15000);
const MAX_GRAPH_LOAD_MS = Number(process.env.MH_GRAPH_MAX_LOAD_MS || 0);
const MAX_SELECT_LATENCY_MS = Number(process.env.MH_GRAPH_MAX_SELECT_LATENCY_MS || 0);
const MAX_COLLAPSE_LATENCY_MS = Number(process.env.MH_GRAPH_MAX_COLLAPSE_LATENCY_MS || 0);
const MAX_EXPAND_LATENCY_MS = Number(process.env.MH_GRAPH_MAX_EXPAND_LATENCY_MS || 0);
const MAX_CONTENT_WIDTH = Number(process.env.MH_GRAPH_MAX_CONTENT_WIDTH || 0);
const MAX_CONTENT_HEIGHT = Number(process.env.MH_GRAPH_MAX_CONTENT_HEIGHT || 0);
const MIN_FIT_ZOOM = Number(process.env.MH_GRAPH_MIN_FIT_ZOOM || 0);
const SCREENSHOT_PATH = String(process.env.MH_GRAPH_SCREENSHOT_PATH || "").trim();
const SCREENSHOT_WIDTH = Math.max(800, Number(process.env.MH_GRAPH_SCREENSHOT_WIDTH || 1800));
const SCREENSHOT_HEIGHT = Math.max(600, Number(process.env.MH_GRAPH_SCREENSHOT_HEIGHT || 1200));
const SCREENSHOT_COLLAPSE_ROUTER = process.env.MH_GRAPH_SCREENSHOT_COLLAPSE_ROUTER === "1";
const POLL_MS = 25;

/** Reports one browser-contract failure as JSON and terminates the audit immediately. */
function fail(message, details = {}) {
  console.error(JSON.stringify({ ok: false, message, details }, null, 2));
  process.exit(1);
}

/** Fetches one CDP discovery response and rejects non-success HTTP statuses. */
async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

/** Reuses the exact Graph browser target or opens it through the configured CDP endpoint. */
async function ensureTarget() {
  const listUrl = `http://127.0.0.1:${CDP_PORT}/json/list`;
  let tabs;
  try {
    tabs = await fetchJson(listUrl);
  } catch (error) {
    fail(`CDP endpoint unavailable on port ${CDP_PORT}`, {
      error: String(error?.message || error),
      hint: "Start a debug-enabled browser, then rerun with MH_CDP_PORT=<port>.",
    });
  }
  const existing = tabs.find((tab) => String(tab.url || "") === GRAPH_URL);
  if (existing?.webSocketDebuggerUrl) return existing;
  const targetUrl = `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(GRAPH_URL)}`;
  try {
    return await fetchJson(targetUrl, { method: "PUT" });
  } catch (error) {
    fail("could not open graph page in CDP browser", {
      url: GRAPH_URL,
      error: String(error?.message || error),
    });
  }
}

/** Creates a request-correlated CDP WebSocket client with bounded connection and command timeouts. */
function connect(webSocketUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    let nextId = 1;
    const pending = new Map();
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("CDP connection timeout"));
    }, TIMEOUT_MS);

    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve({
        /** Sends one CDP method and returns the response matched by its generated request id. */
        send(method, params = {}) {
          const id = nextId;
          nextId += 1;
          socket.send(JSON.stringify({ id, method, params }));
          return new Promise((sendResolve, sendReject) => {
            const sendTimeout = setTimeout(() => {
              pending.delete(id);
              sendReject(new Error(`CDP timeout: ${method}`));
            }, TIMEOUT_MS);
            pending.set(id, {
              /** Resolves the pending CDP command after clearing its individual timeout. */
              resolve(result) {
                clearTimeout(sendTimeout);
                sendResolve(result);
              },
              /** Rejects the pending CDP command after clearing its individual timeout. */
              reject(error) {
                clearTimeout(sendTimeout);
                sendReject(error);
              },
            });
          });
        },
        /** Closes the audit's CDP WebSocket after all browser assertions finish. */
        close() {
          socket.close();
        },
      });
    }, { once: true });

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const handler = pending.get(message.id);
      if (!handler) return;
      pending.delete(message.id);
      if (message.error) {
        handler.reject(new Error(message.error.message || "CDP error"));
      } else {
        handler.resolve(message.result);
      }
    });

    socket.addEventListener("error", reject, { once: true });
  });
}

/** Evaluates one promise-aware browser expression and returns its value-by-copy result. */
async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result?.exceptionDetails) {
    fail("browser evaluation failed", result.exceptionDetails);
  }
  return result?.result?.value;
}

/** Polls until the expected category has a fully loaded Graph root and visible nodes. */
async function waitForGraph(cdp) {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastState = null;
  while (Date.now() < deadline) {
    const state = await evaluate(cdp, `(() => ({
      ready: document.readyState,
      url: location.href,
      root: Boolean(document.querySelector(".workspace-graph-root")),
      nodes: document.querySelectorAll(".workspace-graph-node").length,
      title: document.title,
      bodyClass: document.body?.className || "",
      rootClass: document.querySelector(".workspace-graph-root")?.className || "",
      rootText: document.querySelector(".workspace-graph-root")?.textContent?.replace(/\\s+/g, " ").trim().slice(0, 240) || "",
      sourceCategory: document.querySelector(".workspace-graph-root")?.dataset?.sourceCategory || "",
      sourceCategoryAvailability: document.querySelector(".workspace-graph-root")?.dataset?.sourceCategoryAvailability || "",
      availableSourceCategories: (document.querySelector(".workspace-graph-root")?.dataset?.availableSourceCategories || "")
        .split(",").filter(Boolean).sort(),
    }))()`);
    lastState = state;
    const sourceCategoriesReady = EXPECTED_SOURCE_CATEGORIES.length === 0
      || (state.sourceCategoryAvailability === "ready"
        && JSON.stringify(state.availableSourceCategories) === JSON.stringify(EXPECTED_SOURCE_CATEGORIES));
    if (
      state.ready === "complete"
      && state.url === GRAPH_URL
      && state.root
      && state.nodes > 0
      && state.sourceCategory === EXPECTED_CATEGORY
      && sourceCategoriesReady
    ) return state;
    if (
      EXPECT_ARCHITECTURE_ROOM_FALLBACK
      && state.ready === "complete"
      && state.root
      && state.nodes > 0
      && state.sourceCategory === EXPECTED_CATEGORY
      && sourceCategoriesReady
      && String(state.url || "").startsWith(GRAPH_URL.split("#")[0])
    ) return state;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  fail("graph DOM did not render before timeout", { url: GRAPH_URL, timeoutMs: TIMEOUT_MS, lastState });
}

/** Opens the Router panel when architecture assertions require its provider-owned route fields. */
async function ensureRouterPanelOpen(cdp) {
  const state = await evaluate(cdp, `(() => {
    const panel = document.querySelector(".graph-status-panel");
    if (!panel) return { ok: false, reason: "missing-router-panel" };
    if (!panel.classList.contains("is-collapsed")) return { ok: true, changed: false };
    const button = panel.querySelector("[data-router-action='toggle-status-panel']");
    if (!button) return { ok: false, reason: "missing-router-toggle" };
    button.click();
    return { ok: true, changed: true };
  })()`);
  if (!state?.ok) fail("architecture router panel could not be opened", state || {});
  if (!state.changed) return;
  await waitForCondition(
    cdp,
    `(() => {
      const panel = document.querySelector(".graph-status-panel");
      return {
        ok: Boolean(panel && !panel.classList.contains("is-collapsed")),
        className: panel?.className || "",
      };
    })()`,
    "expanded architecture Router panel",
  );
}

/** Polls a browser expression until it reports success or emits timeout evidence. */
async function waitForCondition(cdp, expression, label) {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastState = null;
  while (Date.now() < deadline) {
    lastState = await evaluate(cdp, expression);
    if (lastState?.ok === true) return lastState;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  fail(`${label} did not settle before timeout`, { timeoutMs: TIMEOUT_MS, lastState });
}

/**
 * Verifies a rejected room hash canonicalizes from settled repository setup.
 * The audit repeats the SOURCE-* hashchange after rendering so a same-state
 * controller path cannot retain a misleading URL while showing the safe setup;
 * URL, projection mode, and empty room identity must settle together.
 */
async function assertRejectedArchitectureRoomHashCanonicalization(cdp) {
  const rejectedHash = new URL(GRAPH_URL).hash;
  if (!/^#architecture\/(?:room|rooms|slice|slices)\//i.test(rejectedHash)) {
    fail("architecture fallback audit requires a rejected room hash URL", {
      graphUrl: GRAPH_URL,
      rejectedHash,
    });
  }
  await waitForCondition(
    cdp,
    `(() => {
      const root = document.querySelector(".workspace-graph-root");
      return {
        ok: root?.dataset?.architectureProjectionMode === ${JSON.stringify(EXPECTED_ARCHITECTURE_MODE)}
          && !root?.dataset?.architectureRoomId,
        url: location.href,
        mode: root?.dataset?.architectureProjectionMode || "",
        roomId: root?.dataset?.architectureRoomId || "",
      };
    })()`,
    "initial rejected architecture-room fallback",
  );
  await evaluate(cdp, `(() => {
    history.replaceState(null, "", "#architecture");
    location.hash = ${JSON.stringify(rejectedHash)};
    return { url: location.href };
  })()`);
  const startedAt = Date.now();
  const settled = await waitForCondition(
    cdp,
    `(() => {
      const root = document.querySelector(".workspace-graph-root");
      return {
        ok: location.hash === "#architecture"
          && root?.dataset?.architectureProjectionMode === ${JSON.stringify(EXPECTED_ARCHITECTURE_MODE)}
          && !root?.dataset?.architectureRoomId,
        url: location.href,
        hash: location.hash,
        mode: root?.dataset?.architectureProjectionMode || "",
        roomId: root?.dataset?.architectureRoomId || "",
      };
    })()`,
    "rejected architecture-room hash canonicalization",
  );
  return {
    latencyMs: Date.now() - startedAt,
    rejectedHash,
    canonicalUrl: settled.url,
  };
}

/** Selects one visible Graph node and measures the complete DOM and panel settling latency. */
async function selectGraphNode(cdp, nodeId) {
  if (!nodeId) return null;
  const encodedNodeId = JSON.stringify(nodeId);
  await waitForCondition(
    cdp,
    `(() => {
      const nodeId = ${encodedNodeId};
      const node = [...document.querySelectorAll(".workspace-graph-node")]
        .find((candidate) => String(candidate.dataset.nodeId || "").toUpperCase() === nodeId);
      return {
        ok: Boolean(node),
        nodeId,
        nodeCount: document.querySelectorAll(".workspace-graph-node").length,
      };
    })()`,
    `graph node ${nodeId}`,
  );
  const selection = await evaluate(cdp, `(async () => {
    const timeoutMs = ${JSON.stringify(TIMEOUT_MS)};
    const nodeId = ${encodedNodeId};
    /** Returns a short browser-side delay used between selection-state observations. */
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const node = [...document.querySelectorAll(".workspace-graph-node")]
      .find((candidate) => String(candidate.dataset.nodeId || "").toUpperCase() === nodeId);
    if (!node) return { ok: false, nodeId, message: "node not found" };
    const start = performance.now();
    node.click();
    let lastState = {};
    while (performance.now() - start < timeoutMs) {
      const nodeId = ${encodedNodeId};
      const selected = [...document.querySelectorAll(".workspace-graph-node.is-selected")]
        .map((node) => String(node.dataset.nodeId || "").toUpperCase());
      const actions = [...document.querySelectorAll(".graph-router-action")]
        .map((button) => button.dataset.routerAction || "");
      const statusPanel = document.querySelector(".graph-status-panel");
      const selectedPanel = document.querySelector(".graph-status-selected");
      const collapsedSummary = document.querySelector(".graph-status-summary-collapsed");
      const panelCollapsed = statusPanel?.classList.contains("is-collapsed") || false;
      const panelText = (selectedPanel || collapsedSummary)?.textContent?.replace(/\\s+/g, " ").trim() || "";
      const panelReady = panelCollapsed
        ? /Selected\\s*·/i.test(panelText)
        : Boolean(selectedPanel && panelText);
      const edgeCount = document.querySelectorAll(".workspace-graph-edge").length;
      lastState = {
        nodeId,
        selected,
        actions,
        panelCollapsed,
        panelReady,
        panelText,
        edgeCount,
      };
      if (selected.includes(nodeId) && panelReady) {
        return {
          ok: true,
          nodeId,
          latencyMs: Math.round((performance.now() - start) * 1000) / 1000,
          selected,
          actions,
          panelCollapsed,
          panelText,
          edgeCount,
        };
      }
      await wait(16);
    }
    return {
      ok: false,
      latencyMs: Math.round((performance.now() - start) * 1000) / 1000,
      ...lastState,
    };
  })()`);
  if (!selection?.ok) fail(`selected graph node ${nodeId} did not settle before timeout`, selection);
  if (MAX_SELECT_LATENCY_MS > 0 && Number(selection.latencyMs || 0) > MAX_SELECT_LATENCY_MS) {
    fail("graph node selection exceeded latency budget", {
      maxSelectLatencyMs: MAX_SELECT_LATENCY_MS,
      selection,
    });
  }
  return selection;
}

/** Verifies the final visible toolbar action does not retain an interior divider border. */
async function assertToolbarRightEdge(cdp) {
  await waitForCondition(
    cdp,
    `(() => {
      const visibleTools = [...document.querySelectorAll(".graph-surface-toolbar .graph-surface-tool")]
        .filter((button) => {
          const style = getComputedStyle(button);
          const rect = button.getBoundingClientRect();
          return style.display !== "none"
            && style.visibility !== "hidden"
            && rect.width > 0
            && rect.height > 0;
        });
      const lastVisible = visibleTools[visibleTools.length - 1] || null;
      const style = lastVisible ? getComputedStyle(lastVisible) : null;
      return {
        ok: Boolean(lastVisible) && parseFloat(style.borderRightWidth || "0") === 0,
        visibleActions: visibleTools.map((button) => button.dataset.graphAction || ""),
        lastVisibleAction: lastVisible?.dataset?.graphAction || "",
        borderRightWidth: style?.borderRightWidth || "",
        className: lastVisible?.className || "",
      };
    })()`,
    "graph toolbar right edge",
  );
}

/** Verifies selection highlights a multi-node chain while remaining distinct from active peers. */
async function assertSignalFlowHighlight(cdp, nodeId) {
  if (!nodeId) {
    fail("signal-flow highlight audit requires MH_GRAPH_SELECT_NODE_ID", {});
  }
  const encodedNodeId = JSON.stringify(nodeId);
  await waitForCondition(
    cdp,
    `(() => {
      const root = document.querySelector(".workspace-graph-root");
      const activeNodes = [...document.querySelectorAll(".workspace-graph-node.is-active-chain")]
        .map((node) => String(node.dataset.nodeId || "").toUpperCase());
      const activeEdges = [...document.querySelectorAll(".workspace-graph-edge.is-active-chain")]
        .map((edge) => edge.dataset.edgeId || "");
      const activeNode = document.querySelector(".workspace-graph-node.is-active-chain");
      const selectedNode = document.querySelector(".workspace-graph-node.is-selected");
      const activePeerNode = document.querySelector(".workspace-graph-node.is-active-chain:not(.is-selected)");
      const activeEdge = document.querySelector(".workspace-graph-edge.is-active-chain");
      const nodeStyle = activeNode ? getComputedStyle(activeNode) : null;
      const selectedStyle = selectedNode ? getComputedStyle(selectedNode) : null;
      const activePeerStyle = activePeerNode ? getComputedStyle(activePeerNode) : null;
      const edgeStyle = activeEdge ? getComputedStyle(activeEdge) : null;
      const selectedOutlineWidth = parseFloat(selectedStyle?.outlineWidth || "0") || 0;
      const activePeerBorderWidth = parseFloat(activePeerStyle?.borderWidth || "0") || 0;
      const selectedBorderWidth = parseFloat(selectedStyle?.borderWidth || "0") || 0;
      const selectedHasSingleBorder = Boolean(selectedStyle)
        && (selectedStyle.outlineStyle === "none" || selectedOutlineWidth === 0);
      const selectedDistinct = Boolean(selectedStyle && activePeerStyle)
        && selectedNode?.classList.contains("is-active-chain")
        && selectedHasSingleBorder
        && (
          selectedStyle.borderColor !== activePeerStyle.borderColor
          || selectedBorderWidth !== activePeerBorderWidth
          || selectedStyle.backgroundColor !== activePeerStyle.backgroundColor
        );
      return {
        ok: root?.classList.contains("has-signal-flow")
          && root?.dataset?.graphSignalFlow === "selected"
          && !root?.classList.contains("is-focus-mode")
          && activeNodes.includes(${encodedNodeId})
          && activeNodes.length >= 2
          && activeEdges.length >= 1
          && selectedDistinct
          && Boolean(nodeStyle?.backgroundColor)
          && Boolean(edgeStyle?.stroke),
        signalFlow: root?.dataset?.graphSignalFlow || "",
        focusMode: root?.classList.contains("is-focus-mode") || false,
        activeNodes,
        activeEdges,
        activeNodeBackground: nodeStyle?.backgroundColor || "",
        selectedNode: selectedNode?.dataset?.nodeId || "",
        selectedBorderColor: selectedStyle?.borderColor || "",
        selectedOutlineColor: selectedStyle?.outlineColor || "",
        selectedOutlineStyle: selectedStyle?.outlineStyle || "",
        selectedOutlineWidth: selectedStyle?.outlineWidth || "",
        selectedBorderWidth: selectedStyle?.borderWidth || "",
        selectedHasSingleBorder,
        activePeerNode: activePeerNode?.dataset?.nodeId || "",
        activePeerBorderColor: activePeerStyle?.borderColor || "",
        activePeerBorderWidth: activePeerStyle?.borderWidth || "",
        selectedDistinct,
        activeEdgeStroke: edgeStyle?.stroke || "",
      };
    })()`,
    `signal-flow highlight for ${nodeId}`,
  );
}

/** Verifies focus mode preserves the selected node's active signal-flow chain. */
async function assertSignalFlowFocus(cdp, nodeId) {
  await assertSignalFlowHighlight(cdp, nodeId);
  await evaluate(cdp, `(() => {
    const button = document.querySelector('[data-graph-action="focus"]');
    if (!button || button.hidden || button.disabled) return { ok: false };
    button.click();
    return { ok: true };
  })()`);
  const encodedNodeId = JSON.stringify(nodeId);
  await waitForCondition(
    cdp,
    `(() => {
      const root = document.querySelector(".workspace-graph-root");
      const activeNodes = [...document.querySelectorAll(".workspace-graph-node.is-active-chain")]
        .map((node) => String(node.dataset.nodeId || "").toUpperCase());
      const activeEdges = [...document.querySelectorAll(".workspace-graph-edge.is-active-chain")]
        .map((edge) => edge.dataset.edgeId || "");
      return {
        ok: root?.classList.contains("is-focus-mode")
          && activeNodes.includes(${encodedNodeId})
          && activeNodes.length >= 2
          && activeEdges.length >= 1,
        focusMode: root?.classList.contains("is-focus-mode") || false,
        activeNodes,
        activeEdges,
      };
    })()`,
    `signal-flow focus for ${nodeId}`,
  );
}

/** Verifies graph-owned wheel pan, pointer drag, and cursor-centered zoom without page scroll. */
async function assertWhiteboardViewport(cdp) {
  await waitForCondition(
    cdp,
    `(() => {
      const canvas = document.querySelector(".workspace-graph-canvas");
      const root = document.querySelector(".workspace-graph-root");
      return {
        ok: Boolean(canvas && root && Number.isFinite(Number(root.dataset.graphViewportZoom))),
        hasCanvas: Boolean(canvas),
        zoom: root?.dataset?.graphViewportZoom || "",
      };
    })()`,
    "whiteboard viewport ready",
  );
  const result = await evaluate(cdp, `(async () => {
    const root = document.querySelector(".workspace-graph-root");
    const canvas = document.querySelector(".workspace-graph-canvas");
    const style = getComputedStyle(canvas);
    /** Reads the browser-visible viewport transform and surrounding page scroll coordinates. */
    const state = () => ({
      zoom: Number(root.dataset.graphViewportZoom || 0),
      offsetX: Number(root.dataset.graphViewportOffsetX || 0),
      offsetY: Number(root.dataset.graphViewportOffsetY || 0),
      mode: root.dataset.graphViewportMode || "",
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    });
    /** Waits for one animation-frame-scale viewport interaction to settle in the DOM. */
    const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
    const rect = canvas.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const before = state();
    const panEvent = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: centerX,
      clientY: centerY,
      deltaX: 44,
      deltaY: 72,
      deltaMode: 0,
    });
    const panCanceled = !canvas.dispatchEvent(panEvent);
    await settle();
    const afterPan = state();
    const zoomEvent = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: centerX,
      clientY: centerY,
      deltaY: -120,
      deltaMode: 0,
      ctrlKey: true,
    });
    const zoomCanceled = !canvas.dispatchEvent(zoomEvent);
    await settle();
    const afterZoom = state();
    const PointerCtor = window.PointerEvent || window.MouseEvent;
    canvas.dispatchEvent(new PointerCtor("pointerdown", {
      bubbles: true,
      cancelable: true,
      pointerId: 91,
      button: 0,
      clientX: centerX,
      clientY: centerY,
    }));
    canvas.dispatchEvent(new PointerCtor("pointermove", {
      bubbles: true,
      cancelable: true,
      pointerId: 91,
      buttons: 1,
      clientX: centerX + 64,
      clientY: centerY + 36,
    }));
    canvas.dispatchEvent(new PointerCtor("pointerup", {
      bubbles: true,
      cancelable: true,
      pointerId: 91,
      button: 0,
      clientX: centerX + 64,
      clientY: centerY + 36,
    }));
    await settle();
    const afterDrag = state();
    return {
      ok: style.overflow === "hidden"
        && panCanceled
        && zoomCanceled
        && afterPan.mode === "manual"
        && (afterPan.offsetX !== before.offsetX || afterPan.offsetY !== before.offsetY)
        && afterPan.scrollX === before.scrollX
        && afterPan.scrollY === before.scrollY
        && afterZoom.zoom !== afterPan.zoom
        && afterDrag.offsetX !== afterZoom.offsetX
        && afterDrag.offsetY !== afterZoom.offsetY,
      overflow: style.overflow,
      panCanceled,
      zoomCanceled,
      before,
      afterPan,
      afterZoom,
      afterDrag,
    };
  })()`);
  if (!result?.ok) fail("whiteboard viewport interactions did not update graph-owned viewport", result);
}

/** Verifies the room back action restores architecture overview state and canonical hash. */
async function assertArchitectureRoomBackReset(cdp) {
  await evaluate(cdp, `(() => {
    const button = [...document.querySelectorAll(".graph-router-action")]
      .find((candidate) => candidate.dataset.routerAction === "exit-architecture-room");
    if (!button) return { ok: false };
    button.click();
    return { ok: true };
  })()`);
  await waitForCondition(
    cdp,
    `(() => {
      const root = document.querySelector(".workspace-graph-root");
      return {
        ok: root?.dataset?.sourceCategory === "architecture"
          && root?.dataset?.architectureRoomId === ""
          && root?.dataset?.architectureProjectionMode === "repository-setup"
          && document.querySelectorAll(".workspace-graph-node").length > 0
          && location.hash === "#architecture",
        url: location.href,
        hash: location.hash,
        sourceCategory: root?.dataset?.sourceCategory || "",
        architectureRoomId: root?.dataset?.architectureRoomId || "",
        architectureProjectionMode: root?.dataset?.architectureProjectionMode || "",
        nodeCount: document.querySelectorAll(".workspace-graph-node").length,
      };
    })()`,
    "architecture room back/reset",
  );
}

/** Verifies the contextual repository authority node returns to the canonical overview hash. */
async function assertRepositoryOverviewNodeReturn(cdp) {
  const target = await evaluate(cdp, `(() => {
    const node = document.querySelector(
      ".workspace-graph-node[data-overview-return-capable='true'][data-graph-navigation-kind='repository-overview']"
    );
    if (!node) return { ok: false, message: "missing repository overview return node" };
    node.dispatchEvent(new MouseEvent("dblclick", {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0,
      detail: 2,
    }));
    return { ok: true, repositoryId: node.dataset.repositoryId || "" };
  })()`);
  if (!target?.ok) fail("repository authority did not expose contextual overview navigation", target);
  await waitForCondition(
    cdp,
    `(() => {
      const root = document.querySelector(".workspace-graph-root");
      return {
        ok: root?.dataset?.sourceCategory === "architecture"
          && root?.dataset?.architectureRoomId === ""
          && document.querySelectorAll(".workspace-graph-node").length > 0
          && location.hash === "#architecture",
        hash: location.hash,
        architectureRoomId: root?.dataset?.architectureRoomId || "",
        architectureProjectionMode: root?.dataset?.architectureProjectionMode || "",
      };
    })()`,
    "repository overview node return",
  );
}

/** Verifies a route candidate action loads its room projection and canonical room hash. */
async function assertArchitectureRouteCandidateSwitch(cdp, roomId) {
  const encodedRoomId = JSON.stringify(roomId);
  await evaluate(cdp, `(() => {
    const roomId = ${encodedRoomId};
    const button = [...document.querySelectorAll(".graph-router-action")]
      .find((candidate) =>
        candidate.dataset.routerAction === "enter-architecture-room"
        && candidate.dataset.routerActionContext === "atlas-route-candidate"
        && String(candidate.dataset.architectureRoomId || "").toUpperCase() === roomId
      );
    if (!button) return { ok: false, roomId };
    button.click();
    return { ok: true, roomId };
  })()`);
  await waitForCondition(
    cdp,
    `(() => {
      const roomId = ${encodedRoomId};
      const root = document.querySelector(".workspace-graph-root");
      return {
        ok: root?.dataset?.sourceCategory === "architecture"
          && root?.dataset?.architectureProjectionMode === "room"
          && String(root?.dataset?.architectureRoomId || "").toUpperCase() === roomId
          && document.querySelectorAll(".workspace-graph-node").length > 0
          && location.hash === \`#architecture/room/\${roomId}\`,
        url: location.href,
        hash: location.hash,
        sourceCategory: root?.dataset?.sourceCategory || "",
        architectureRoomId: root?.dataset?.architectureRoomId || "",
        architectureProjectionMode: root?.dataset?.architectureProjectionMode || "",
        nodeCount: document.querySelectorAll(".workspace-graph-node").length,
      };
    })()`,
    "architecture route candidate switch",
  );
}

/** Verifies a pointer-reachable setup node handles the browser's bubbling dblclick contract. */
async function assertArchitectureNodeDoubleClick(cdp) {
  const target = await evaluate(cdp, `(() => {
    const nodes = [...document.querySelectorAll(
      ".workspace-graph-node[data-drilldown-capable='true'][data-node-id]"
    )];
    if (!nodes.length) return { ok: false, message: "missing drilldown-capable room node" };
    const observations = nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        node,
        hit,
        pointerReachable: Boolean(hit && (hit === node || node.contains(hit))),
        inViewport: x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight,
      };
    });
    const selected = observations.find((observation) => observation.pointerReachable);
    if (selected) {
      selected.node.dispatchEvent(new MouseEvent("dblclick", {
        bubbles: true,
        cancelable: true,
        view: window,
        button: 0,
        detail: 2,
      }));
    }
    return {
      ok: Boolean(selected),
      roomId: String(selected?.node?.dataset?.nodeId || "").toUpperCase(),
      candidates: observations.map((observation) => ({
        roomId: String(observation.node.dataset.nodeId || "").toUpperCase(),
        pointerReachable: observation.pointerReachable,
        inViewport: observation.inViewport,
        hitClass: observation.hit?.className || "",
      })),
    };
  })()`);
  if (!target?.ok || !target.roomId) fail("architecture room node is not pointer reachable", target);
  const encodedRoomId = JSON.stringify(target.roomId);
  await waitForCondition(
    cdp,
    `(() => {
      const roomId = ${encodedRoomId};
      const root = document.querySelector(".workspace-graph-root");
      return {
        ok: root?.dataset?.architectureProjectionMode === "room"
          && String(root?.dataset?.architectureRoomId || "").toUpperCase() === roomId
          && location.hash === \`#architecture/room/\${roomId}\`,
        hash: location.hash,
        architectureProjectionMode: root?.dataset?.architectureProjectionMode || "",
        architectureRoomId: root?.dataset?.architectureRoomId || "",
      };
    })()`,
    "architecture room node double-click",
  );
  await assertArchitectureRoomBackReset(cdp);
}

/** Verifies a room-capable node can be repositioned without consuming its navigation gesture. */
async function assertNavigationNodeDrag(cdp) {
  const result = await evaluate(cdp, `(async () => {
    const root = document.querySelector(".workspace-graph-root");
    const node = document.querySelector(
      ".workspace-graph-node[data-graph-navigation-kind][data-node-id]"
    );
    if (!root || !node) return { ok: false, message: "missing navigation node" };
    const nodeId = String(node.dataset.nodeId || "").toUpperCase();
    const layoutKey = root.dataset.sourceCategory === "architecture" && root.dataset.architectureRoomId
      ? "architecture:" + root.dataset.architectureRoomId
      : root.dataset.sourceCategory || "";
    /** Returns the chosen navigation node's persisted coordinate in the active graph layout bucket. */
    const storedPosition = () => {
      try {
        const state = JSON.parse(localStorage.getItem("multihead-memory-graph.lens-state.v2") || "{}");
        return state?.graphLayout?.nodePositionsByCategory?.[layoutKey]?.[nodeId] || null;
      } catch (_error) {
        return null;
      }
    };
    const beforePosition = storedPosition();
    const beforeHash = location.hash;
    const rect = node.getBoundingClientRect();
    const startX = rect.left + rect.width / 2;
    const startY = rect.top + rect.height / 2;
    const PointerCtor = window.PointerEvent || window.MouseEvent;
    const pointerDownAccepted = node.dispatchEvent(new PointerCtor("pointerdown", {
      bubbles: true,
      cancelable: true,
      pointerId: 117,
      button: 0,
      buttons: 1,
      clientX: startX,
      clientY: startY,
    }));
    node.dispatchEvent(new PointerCtor("pointermove", {
      bubbles: true,
      cancelable: true,
      pointerId: 117,
      button: 0,
      buttons: 1,
      clientX: startX + 80,
      clientY: startY + 60,
    }));
    node.dispatchEvent(new PointerCtor("pointerup", {
      bubbles: true,
      cancelable: true,
      pointerId: 117,
      button: 0,
      buttons: 0,
      clientX: startX + 80,
      clientY: startY + 60,
    }));
    await new Promise((resolve) => setTimeout(resolve, 180));
    const afterPosition = storedPosition();
    const arrangeButton = document.querySelector("[data-graph-action='arrange']");
    if (arrangeButton && !arrangeButton.hidden) arrangeButton.click();
    const restoredPosition = storedPosition();
    return {
      ok: pointerDownAccepted
        && location.hash === beforeHash
        && Boolean(afterPosition)
        && JSON.stringify(afterPosition) !== JSON.stringify(beforePosition)
        && restoredPosition === null,
      nodeId,
      navigationKind: node.dataset.graphNavigationKind || "",
      pointerDownAccepted,
      beforeHash,
      afterHash: location.hash,
      beforePosition,
      afterPosition,
      restoredPosition,
    };
  })()`);
  if (!result?.ok) {
    fail("navigation node drag did not persist and restore without entering or leaving a room", result);
  }
  return result;
}

/** Verifies collapse, persisted reload state, and collapsed-node expansion for one container. */
async function assertContainerCollapseFlow(cdp) {
  const timings = {};
  const setup = await evaluate(cdp, `(() => {
    const collapsedNode = document.querySelector(".workspace-graph-node[data-collapsed-container='true'][data-container-id]");
    if (collapsedNode) {
      collapsedNode.click();
      return { ok: true, expandedExisting: true };
    }
    return { ok: true, expandedExisting: false };
  })()`);
  if (!setup?.ok) fail("container collapse setup failed", setup);
  await waitForCondition(
    cdp,
    `(() => ({
      ok: Boolean(document.querySelector(".workspace-graph-container[data-container-id] [data-container-action='collapse']")),
      containerCount: document.querySelectorAll(".workspace-graph-container[data-container-id]").length,
      collapsedNodeCount: document.querySelectorAll(".workspace-graph-node[data-collapsed-container='true']").length,
    }))()`,
    "expanded container before collapse",
  );
  const collapseStartedAt = performance.now();
  const collapsed = await evaluate(cdp, `(() => {
    const containers = [...document.querySelectorAll(".workspace-graph-container[data-container-id]")];
    const attempted = [];
    for (const container of containers) {
      const button = container.querySelector("[data-container-action='collapse'][data-container-id]");
      if (!button) continue;
      const rect = button.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      const pointerReachable = Boolean(hit && (hit === button || button.contains(hit)));
      attempted.push({
        containerId: container.dataset.containerId || "",
        pointerReachable,
        hitClass: typeof hit?.className === "string" ? hit.className : "",
      });
      if (!pointerReachable) continue;
      button.click();
      return {
        ok: true,
        containerId: container.dataset.containerId || "",
        hitClass: typeof hit?.className === "string" ? hit.className : "",
        attempted,
      };
    }
    return {
      ok: false,
      message: containers.length ? "no pointer-reachable collapse control" : "missing collapse control",
      attempted,
    };
  })()`);
  if (!collapsed?.ok || !collapsed.containerId) fail("container collapse control unavailable", collapsed);
  const encodedContainerId = JSON.stringify(collapsed.containerId);
  const collapsedState = await waitForCondition(
    cdp,
    `(() => {
      const containerId = ${encodedContainerId};
      const normalizedContainerId = String(containerId || "").toUpperCase();
      const containerVisible = [...document.querySelectorAll(".workspace-graph-container[data-container-id]")]
        .some((container) => String(container.dataset.containerId || "").toUpperCase() === normalizedContainerId);
      const collapsedNode = [...document.querySelectorAll(".workspace-graph-node[data-collapsed-container='true'][data-container-id]")]
        .find((node) => String(node.dataset.containerId || "").toUpperCase() === normalizedContainerId);
      const content = document.querySelector(".workspace-graph-content");
      const renderComplete = content?.dataset?.renderLayerMode === "complete";
      return {
        ok: !containerVisible && Boolean(collapsedNode) && renderComplete,
        containerId,
        containerVisible,
        collapsedNodeText: collapsedNode?.textContent?.replace(/\\s+/g, " ").trim() || "",
        renderComplete,
        routeMode: document.querySelector(".workspace-graph-root")?.dataset?.graphRouteMode || "",
        routeBudget: document.querySelector(".workspace-graph-root")?.dataset?.graphRouteBudget || "",
      };
    })()`,
    "container collapsed to node",
  );
  timings.collapseMs = Math.round((performance.now() - collapseStartedAt) * 1000) / 1000;
  timings.collapsedRouteMode = collapsedState.routeMode || "";
  timings.collapsedRouteBudget = collapsedState.routeBudget || "";
  if (timings.collapsedRouteMode !== "speed"
    || !["bounded", "preview"].includes(timings.collapsedRouteBudget)) {
    fail("container collapse must use a workload-bounded interaction route budget", {
      timings,
      containerId: collapsed.containerId,
    });
  }
  if (MAX_COLLAPSE_LATENCY_MS > 0 && timings.collapseMs > MAX_COLLAPSE_LATENCY_MS) {
    fail("container collapse exceeded latency budget", {
      maxCollapseLatencyMs: MAX_COLLAPSE_LATENCY_MS,
      timings,
      containerId: collapsed.containerId,
    });
  }
  const persistedReloadStartedAt = performance.now();
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitForGraph(cdp);
  await waitForCondition(
    cdp,
    `(() => {
      const containerId = ${encodedContainerId};
      const normalizedContainerId = String(containerId || "").toUpperCase();
      const collapsedNode = [...document.querySelectorAll(".workspace-graph-node[data-collapsed-container='true'][data-container-id]")]
        .find((node) => String(node.dataset.containerId || "").toUpperCase() === normalizedContainerId);
      return {
        ok: Boolean(collapsedNode),
        containerId,
        collapsedNodeText: collapsedNode?.textContent?.replace(/\\s+/g, " ").trim() || "",
      };
    })()`,
    "container collapse persisted after reload",
  );
  timings.persistedReloadMs = Math.round((performance.now() - persistedReloadStartedAt) * 1000) / 1000;
  const expandStartedAt = performance.now();
  await evaluate(cdp, `(() => {
    const containerId = ${encodedContainerId};
    const normalizedContainerId = String(containerId || "").toUpperCase();
    const collapsedNode = [...document.querySelectorAll(".workspace-graph-node[data-collapsed-container='true'][data-container-id]")]
      .find((node) => String(node.dataset.containerId || "").toUpperCase() === normalizedContainerId);
    if (!collapsedNode) return { ok: false, containerId };
    collapsedNode.click();
    return { ok: true, containerId };
  })()`);
  await waitForCondition(
    cdp,
    `(() => {
      const containerId = ${encodedContainerId};
      const normalizedContainerId = String(containerId || "").toUpperCase();
      const containerVisible = [...document.querySelectorAll(".workspace-graph-container[data-container-id]")]
        .some((container) => String(container.dataset.containerId || "").toUpperCase() === normalizedContainerId);
      const collapsedNode = [...document.querySelectorAll(".workspace-graph-node[data-collapsed-container='true'][data-container-id]")]
        .find((node) => String(node.dataset.containerId || "").toUpperCase() === normalizedContainerId);
      const content = document.querySelector(".workspace-graph-content");
      const renderComplete = content?.dataset?.renderLayerMode === "complete";
      return {
        ok: containerVisible && !collapsedNode && renderComplete,
        containerId,
        containerVisible,
        collapsedNodePresent: Boolean(collapsedNode),
        renderComplete,
      };
    })()`,
    "container expanded from collapsed node",
  );
  timings.expandMs = Math.round((performance.now() - expandStartedAt) * 1000) / 1000;
  if (MAX_EXPAND_LATENCY_MS > 0 && timings.expandMs > MAX_EXPAND_LATENCY_MS) {
    fail("container expansion exceeded latency budget", {
      maxExpandLatencyMs: MAX_EXPAND_LATENCY_MS,
      timings,
      containerId: collapsed.containerId,
    });
  }
  return timings;
}

/** Builds the browser expression that inventories rendered geometry, emphasis, routing, and controls. */
function graphDomAuditExpression() {
  return `(() => {
    const root = document.querySelector(".workspace-graph-root");
    const canvas = document.querySelector(".workspace-graph-canvas");
    const content = document.querySelector(".workspace-graph-content");
    const contentRect = content?.getBoundingClientRect?.();
    const canvasRect = canvas?.getBoundingClientRect?.();
    const nodes = [...document.querySelectorAll(".workspace-graph-node")];
    const containers = [...document.querySelectorAll(".workspace-graph-container")];
    const edges = [...document.querySelectorAll(".workspace-graph-edge")];
    const currentish = nodes.filter((node) =>
      node.classList.contains("is-emphasis-current")
      || node.classList.contains("is-emphasis-attention")
      || node.classList.contains("is-emphasis-ongoing")
      || node.dataset.visualEmphasis === "current"
      || node.dataset.visualEmphasis === "attention"
      || node.dataset.visualEmphasis === "ongoing"
    );
    const context = nodes.filter((node) =>
      node.classList.contains("is-emphasis-context")
      || node.dataset.visualEmphasis === "context"
    );
    const past = nodes.filter((node) =>
      node.classList.contains("is-emphasis-past")
      || node.dataset.visualEmphasis === "past"
    );
    const selected = nodes.filter((node) => node.classList.contains("is-selected"));
    const selectedNode = selected[0] || null;
    const selectedNodeStyle = selectedNode ? getComputedStyle(selectedNode) : null;
    const drilldownCapableNodes = nodes.filter((node) => node.dataset.drilldownCapable === "true");
    const drilldownMarkerNodes = drilldownCapableNodes.filter((node) =>
      node.querySelector(".workspace-graph-node-drilldown-marker")
    );
    const sourceEvidenceNodes = nodes.filter((node) =>
      ["repository-source", "source-evidence"].includes(node.dataset.entryKind || "")
    );
    const sourceEvidenceUnexpectedDrilldownIds = sourceEvidenceNodes
      .filter((node) =>
        node.dataset.drilldownCapable === "true"
        || Boolean(node.querySelector(".workspace-graph-node-drilldown-marker"))
      )
      .map((node) => node.dataset.nodeId || "")
      .filter(Boolean);
    const availableRoomStatuses = new Set([
      "available",
      "semantic-room-available",
      "source-derived-room-available",
      "source-derived-topology-available",
    ]);
    const freshRoomStatuses = new Set(["current", "fresh", "source-digest-current", "source-validated"]);
    const structuralRoomModels = new Set([
      "consumer-repository-catalog",
      "multihead-atlas-default-repository-adapter",
      "multihead-atlas-source-inventory-v1",
      "repository-source-scan",
    ]);
    const roomEntryContractViolationIds = drilldownCapableNodes
      .filter((node) =>
        node.dataset.entryKind !== "semantic-room"
        || node.dataset.navigationKind !== "room-entry"
        || !node.dataset.roomTargetId
        || node.dataset.roomTargetId === (root?.dataset?.architectureRoomId || "").toUpperCase()
        || !availableRoomStatuses.has(node.dataset.roomGraphStatus || "")
        || !node.dataset.roomGraphSourceModel
        || structuralRoomModels.has(node.dataset.roomGraphSourceModel || "")
        || !freshRoomStatuses.has(node.dataset.roomGraphFreshnessStatus || "")
        || !node.dataset.roomGraphEndpoint
      )
      .map((node) => node.dataset.nodeId || "")
      .filter(Boolean);
    const repositoryOverviewReturnNodes = nodes.filter((node) =>
      node.dataset.overviewReturnCapable === "true"
    );
    const repositoryOverviewReturnMarkerNodes = repositoryOverviewReturnNodes.filter((node) =>
      node.querySelector(".workspace-graph-node-drilldown-marker")
    );
    const repositoryOverviewContractViolationIds = repositoryOverviewReturnNodes
      .filter((node) =>
        node.dataset.entryKind !== "repository-authority"
        || node.dataset.navigationKind !== "repository-overview"
        || node.dataset.graphNavigationKind !== "repository-overview"
        || !node.dataset.repositoryId
        || String(node.dataset.nodeId || "").toUpperCase() !== String(node.dataset.repositoryId || "").toUpperCase()
        || node.dataset.repositoryOverviewStatus !== "available"
        || node.dataset.repositoryOverviewEndpoint !== "/api/architecture-graph"
        || !root?.dataset?.architectureRoomId
      )
      .map((node) => node.dataset.nodeId || "")
      .filter(Boolean);
    const collapsedContainerNodes = nodes.filter((node) => node.dataset.collapsedContainer === "true");
    const containerCollapseControls = [...document.querySelectorAll(
      ".workspace-graph-container [data-container-action='collapse'][data-container-id]"
    )];
    const pointerReachableContainerCollapseControls = containerCollapseControls.filter((button) => {
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return Boolean(hit && (hit === button || button.contains(hit)));
    });
    const lifecycleContainers = containers
      .map((container) => ({
        id: container.dataset.containerId,
        visualEmphasis: container.dataset.visualEmphasis || "",
        currentObjective: container.dataset.currentObjective || "",
        text: container.textContent.replace(/\\s+/g, " ").trim(),
      }))
      .filter((container) =>
        ["active", "resumable", "attention"].includes(container.visualEmphasis)
        || /(active|running|ongoing|in progress|current)\\s*·\\s*\\d+ operations/i.test(container.text)
      );
    const currentStateContainer = lifecycleContainers.find((container) =>
      container.currentObjective && /Now:/i.test(container.text)
    );
    const visibleToolbarActions = [...document.querySelectorAll(".graph-surface-toolbar [data-graph-action]")]
      .filter((button) => {
        const style = getComputedStyle(button);
        const rect = button.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && style.opacity !== "0"
          && rect.width > 0
          && rect.height > 0;
      })
      .map((button) => button.dataset.graphAction || button.textContent.trim());
    const atlasPanel = document.querySelector("[data-atlas-retrieval-mode], [data-atlas-status]");
    const architectureRoomNodes = nodes.filter((node) =>
      node.dataset.nodeKind === "architecture_room"
      || node.dataset.memoryKind === "architecture_room"
      || node.classList.contains("is-architecture_room")
    );
    const architectureWorkspaceNodes = nodes.filter((node) =>
      [
        "architecture_repository_root",
        "architecture_project_repo",
        "architecture_generated_region",
        "architecture_container",
        "architecture_artifact_space",
        "architecture_utility",
        "architecture_workspace_entry",
      ].includes(node.dataset.nodeKind || node.dataset.memoryKind || "")
    );
    const architectureWorkspaceNodeIds = architectureWorkspaceNodes
      .map((node) => node.dataset.nodeId || "")
      .filter(Boolean);
    const architectureWorkspaceDrilldownMissingIds = architectureWorkspaceNodes
      .filter((node) =>
        node.dataset.drilldownCapable !== "true"
          || !node.querySelector(".workspace-graph-node-drilldown-marker")
      )
      .map((node) => node.dataset.nodeId || "")
      .filter(Boolean);
    const architectureRoomDetailNodes = nodes.filter((node) =>
      [
        "architecture_room_summary",
        "architecture_region",
        "architecture_slice_candidate",
        "architecture_source_repo",
        "architecture_entry_node",
        "architecture_exit_node",
        "architecture_portal_room",
        "architecture_component",
        "architecture_interface",
        "architecture_behavior",
        "architecture_state",
        "architecture_adapter",
        "architecture_drilldown_room",
      ]
        .includes(node.dataset.nodeKind || node.dataset.memoryKind || "")
    );
    const architectureAnswerNodes = nodes.filter((node) =>
      (node.dataset.nodeKind || node.dataset.memoryKind || "") === "architecture_answer"
    );
    const architectureElementNodes = nodes.filter((node) =>
      [
        "architecture_component",
        "architecture_interface",
        "architecture_behavior",
        "architecture_state",
        "architecture_adapter",
      ].includes(node.dataset.nodeKind || node.dataset.memoryKind || "")
    );
    const architectureElementNodeLabels = architectureElementNodes
      .map((node) => node.textContent.replace(/\\s+/g, " ").trim())
      .filter(Boolean);
    const architectureElementUnexpectedDrilldownIds = architectureElementNodes
      .filter((node) => node.dataset.drilldownCapable === "true")
      .map((node) => node.dataset.nodeId || "")
      .filter(Boolean);
    const architectureDrilldownNodes = nodes.filter((node) =>
      (node.dataset.nodeKind || node.dataset.memoryKind || "") === "architecture_drilldown_room"
    );
    const architectureDrilldownNodeLabels = architectureDrilldownNodes
      .map((node) => node.textContent.replace(/\\s+/g, " ").trim())
      .filter(Boolean);
    const architectureDrilldownNodeIds = architectureDrilldownNodes
      .map((node) => node.dataset.nodeId || "")
      .filter(Boolean);
    const architectureDrilldownMissingMarkerIds = architectureDrilldownNodes
      .filter((node) =>
        node.dataset.drilldownCapable !== "true"
          || !node.querySelector(".workspace-graph-node-drilldown-marker")
      )
      .map((node) => node.dataset.nodeId || "")
      .filter(Boolean);
    const routerActions = [...document.querySelectorAll(".graph-router-action")]
      .map((button) => ({
        action: button.dataset.routerAction || "",
        context: button.dataset.routerActionContext || "",
        roomId: button.dataset.architectureRoomId || "",
        routeRank: button.dataset.atlasRouteRank || "",
        text: button.textContent.replace(/\\s+/g, " ").trim(),
      }));
    const atlasRouteCandidates = [...document.querySelectorAll("[data-atlas-route-candidate-room]")]
      .map((candidate) => ({
        roomId: candidate.dataset.atlasRouteCandidateRoom || "",
        rank: Number(candidate.dataset.atlasRouteCandidateRank || 0),
        selected: candidate.dataset.atlasRouteCandidateSelected === "true",
        text: candidate.textContent.replace(/\\s+/g, " ").trim(),
      }));
    const atlasRouteCandidateActionRooms = routerActions
      .filter((action) =>
        action.action === "enter-architecture-room"
        && action.context === "atlas-route-candidate"
        && action.roomId
      )
      .map((action) => action.roomId);
    const sourceEvidenceRoomIds = new Set(sourceEvidenceNodes
      .map((node) => node.dataset.roomTargetId || "")
      .filter(Boolean));
    const sourceEvidenceEnterActionRoomIds = routerActions
      .filter((action) =>
        action.action === "enter-architecture-room"
        && sourceEvidenceRoomIds.has(String(action.roomId || "").toUpperCase())
      )
      .map((action) => action.roomId);
    const pastSample = past[0] || null;
    const pastStyle = pastSample ? getComputedStyle(pastSample) : null;
    const containerStateCounts = containers.reduce((counts, container) => {
      const state = container.dataset.visualEmphasis || "none";
      counts[state] = (counts[state] || 0) + 1;
      return counts;
    }, {});
    const containerIds = containers
      .map((container) => container.dataset.containerId || "")
      .filter(Boolean);
    const edgeStyleCounts = edges.reduce((counts, edge) => {
      const style = edge.dataset.visualStyle || [
        "reference",
        "support",
        "return",
        "primary",
      ].find((name) => edge.classList.contains(\`is-\${name}\`)) || "primary";
      counts[style] = (counts[style] || 0) + 1;
      return counts;
    }, {});
    const edgeKindCounts = edges.reduce((counts, edge) => {
      const kind = edge.dataset.edgeKind || "unknown";
      counts[kind] = (counts[kind] || 0) + 1;
      return counts;
    }, {});
    const relationshipKindCounts = edges.reduce((counts, edge) => {
      const kind = edge.dataset.relationshipKind || "unknown";
      counts[kind] = (counts[kind] || 0) + 1;
      return counts;
    }, {});
    const containerKindCounts = containers.reduce((counts, container) => {
      const kind = container.dataset.containerKind || "unknown";
      counts[kind] = (counts[kind] || 0) + 1;
      return counts;
    }, {});
    const compactNodeLabelRhythm = nodes
      .filter((node) => node.classList.contains("is-compact"))
      .map((node) => {
        const label = node.querySelector(".workspace-graph-node-label");
        const nodeRect = node.getBoundingClientRect();
        const labelRect = label?.getBoundingClientRect?.();
        return {
          nodeId: node.dataset.nodeId || "",
          centerDelta: labelRect
            ? Number(((labelRect.top + labelRect.height / 2) - (nodeRect.top + nodeRect.height / 2)).toFixed(3))
            : null,
        };
      })
      .filter((row) => Number.isFinite(row.centerDelta));
    const edgeLabelRhythm = [...document.querySelectorAll(".workspace-graph-edge-label")]
      .map((label) => {
        const text = label.querySelector(".workspace-graph-edge-label-text");
        const labelRect = label.getBoundingClientRect();
        const textRect = text?.getBoundingClientRect?.();
        return {
          text: text?.textContent?.trim?.() || "",
          centerDelta: textRect
            ? Number(((textRect.top + textRect.height / 2) - (labelRect.top + labelRect.height / 2)).toFixed(3))
            : null,
        };
      })
      .filter((row) => Number.isFinite(row.centerDelta));
    /** Measures rendered label-center drift after native flex centering. */
    const maxRhythmDeviation = (rows) => rows.reduce(
      (maximum, row) => Math.max(maximum, Math.abs(row.centerDelta)),
      0,
    );
    const documentElementStyle = getComputedStyle(document.documentElement);
    const bodyStyle = getComputedStyle(document.body);
    // Persisted manual coordinates are audit evidence for layout comparisons;
    // they do not become provider or semantic-layout authority.
    let storedLensState = {};
    try {
      storedLensState = JSON.parse(localStorage.getItem("multihead-memory-graph.lens-state.v2") || "{}");
    } catch (_error) {
      storedLensState = {};
    }
    const activeLayoutKey = root?.dataset?.sourceCategory === "architecture"
      && root?.dataset?.architectureRoomId
      ? \`architecture:\${root.dataset.architectureRoomId}\`
      : root?.dataset?.sourceCategory || "";
    const manualNodePositions = storedLensState?.graphLayout?.nodePositionsByCategory?.[activeLayoutKey] || {};
    return {
      url: location.href,
      pageTitle: document.title,
      themeId: document.documentElement.dataset.theme || "",
      routeGridHelperCellCount: document.querySelectorAll(".workspace-graph-grid-cell").length,
      pageViewport: {
        htmlOverflowX: documentElementStyle.overflowX,
        bodyOverflowX: bodyStyle.overflowX,
        horizontalScrollbarHeight: Math.max(0, window.innerHeight - document.documentElement.clientHeight),
        scrollX: window.scrollX,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      },
      labelVerticalRhythm: {
        compactNodeLabelCount: compactNodeLabelRhythm.length,
        edgeLabelCount: edgeLabelRhythm.length,
        maxCompactNodeDeviation: Number(maxRhythmDeviation(compactNodeLabelRhythm).toFixed(3)),
        maxEdgeLabelDeviation: Number(maxRhythmDeviation(edgeLabelRhythm).toFixed(3)),
        compactNodeSample: compactNodeLabelRhythm[0] || null,
        edgeLabelSample: edgeLabelRhythm[0] || null,
      },
      rootSourceCategory: root?.dataset?.sourceCategory || "",
      sourceCategoryAvailability: root?.dataset?.sourceCategoryAvailability || "",
      availableSourceCategories: (root?.dataset?.availableSourceCategories || "")
        .split(",").filter(Boolean).sort(),
      visibleSourceCategories: [...document.querySelectorAll(".graph-source-toggle [data-source-category]")]
        .filter((button) => {
          const group = button.closest(".graph-source-toggle");
          return !button.hidden && !(group && group.hidden);
        })
        .map((button) => button.dataset.sourceCategory || "")
        .filter(Boolean)
        .sort(),
      sourceToggleHidden: Boolean(document.querySelector(".graph-source-toggle")?.hidden),
      genericLearnedPhraseCount: containers.filter((container) =>
        /learned repository responsibility region|learned semantic rooms?/i.test(container.textContent || "")
      ).length,
      architectureProjectionMode: root?.dataset?.architectureProjectionMode || "",
      architectureProjectionSource: root?.dataset?.architectureProjectionSource || "",
      architectureRoomId: root?.dataset?.architectureRoomId || "",
      manualNodePositions,
      viewport: {
        mode: root?.dataset?.graphViewportMode || "",
        zoom: Number(root?.dataset?.graphViewportZoom || 0),
        offsetX: Number(root?.dataset?.graphViewportOffsetX || 0),
        offsetY: Number(root?.dataset?.graphViewportOffsetY || 0),
        contentWidth: Number.parseFloat(content?.style?.width || "0") || 0,
        contentHeight: Number.parseFloat(content?.style?.height || "0") || 0,
        renderedContentWidth: Math.round(contentRect?.width || 0),
        renderedContentHeight: Math.round(contentRect?.height || 0),
        canvasWidth: Math.round(canvasRect?.width || 0),
        canvasHeight: Math.round(canvasRect?.height || 0),
        renderLayerMode: content?.dataset?.renderLayerMode || "",
        renderLayers: content?.dataset?.renderLayers || "",
      },
      nodeCount: nodes.length,
      containerCount: containers.length,
      edgeCount: edges.length,
      edgeStyleCounts,
      edgeKindCounts,
      relationshipKindCounts,
      containerKindCounts,
      currentishCount: currentish.length,
      contextCount: context.length,
      pastCount: past.length,
      selectedCount: selected.length,
      selectedNodeStyle: selectedNodeStyle ? {
        nodeId: selectedNode.dataset.nodeId || "",
        borderColor: selectedNodeStyle.borderColor,
        borderWidth: selectedNodeStyle.borderWidth,
        backgroundColor: selectedNodeStyle.backgroundColor,
        outlineStyle: selectedNodeStyle.outlineStyle,
        outlineWidth: selectedNodeStyle.outlineWidth,
      } : null,
      drilldownCapableNodeCount: drilldownCapableNodes.length,
      drilldownMarkerNodeCount: drilldownMarkerNodes.length,
      drilldownCapableNodeIds: drilldownCapableNodes
        .map((node) => node.dataset.nodeId || "")
        .filter(Boolean),
      sourceEvidenceNodeCount: sourceEvidenceNodes.length,
      sourceEvidenceUnexpectedDrilldownIds,
      sourceEvidenceEnterActionRoomIds,
      roomEntryContractViolationIds,
      repositoryOverviewReturnNodeCount: repositoryOverviewReturnNodes.length,
      repositoryOverviewReturnMarkerNodeCount: repositoryOverviewReturnMarkerNodes.length,
      repositoryOverviewReturnNodeIds: repositoryOverviewReturnNodes
        .map((node) => node.dataset.nodeId || "")
        .filter(Boolean),
      repositoryOverviewContractViolationIds,
      collapsedContainerNodeCount: collapsedContainerNodes.length,
      collapsedContainerNodeIds: collapsedContainerNodes
        .map((node) => node.dataset.containerId || node.dataset.nodeId || "")
        .filter(Boolean),
      containerCollapseControlCount: containerCollapseControls.length,
      pointerReachableContainerCollapseControlCount: pointerReachableContainerCollapseControls.length,
      visibleToolbarActions,
      architectureRoomNodeCount: architectureRoomNodes.length,
      architectureWorkspaceNodeCount: architectureWorkspaceNodes.length,
      architectureWorkspaceNodeIds,
      architectureWorkspaceDrilldownMissingIds,
      architectureRoomDetailNodeCount: architectureRoomDetailNodes.length,
      architectureAnswerNodeCount: architectureAnswerNodes.length,
      architectureElementNodeCount: architectureElementNodes.length,
      architectureElementNodeLabels,
      architectureElementUnexpectedDrilldownIds,
      architectureDrilldownNodeCount: architectureDrilldownNodes.length,
      architectureDrilldownNodeLabels,
      architectureDrilldownNodeIds,
      architectureDrilldownMissingMarkerIds,
      routerActions,
      architectureAtlas: atlasPanel ? {
        status: atlasPanel.dataset.atlasStatus || "",
        retrievalMode: atlasPanel.dataset.atlasRetrievalMode || "",
        selectedRoom: atlasPanel.dataset.atlasSelectedRoom || "",
        indexSimilarity: atlasPanel.dataset.atlasIndexSimilarity || "",
        routeTrail: atlasPanel.dataset.atlasRouteTrail || "",
        candidateCount: Number(atlasPanel.dataset.atlasCandidateCount || 0),
        candidateRooms: atlasRouteCandidates.map((candidate) => candidate.roomId),
        candidateActionRooms: atlasRouteCandidateActionRooms,
        text: atlasPanel.textContent.replace(/\\s+/g, " ").trim(),
      } : null,
      atlasRouteCandidates,
      containerStateCounts,
      pastSample: pastSample ? {
        id: pastSample.dataset.nodeId,
        text: pastSample.textContent.replace(/\\s+/g, " ").trim(),
        backgroundColor: pastStyle.backgroundColor,
        borderColor: pastStyle.borderColor,
        opacity: pastStyle.opacity,
        filter: pastStyle.filter,
      } : null,
      currentish: currentish.map((node) => {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return {
          id: node.dataset.nodeId,
          text: node.textContent.replace(/\\s+/g, " ").trim(),
          visualEmphasis: node.dataset.visualEmphasis || "",
          className: node.className,
          backgroundColor: style.backgroundColor,
          borderColor: style.borderColor,
          opacity: style.opacity,
          filter: style.filter,
          outlineColor: style.outlineColor,
          outlineStyle: style.outlineStyle,
          zIndex: style.zIndex,
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      }),
      lifecycleContainers,
      containerIds,
      currentStateContainer,
    };
  })()`;
}

/** Resolves the optional PNG destination while rejecting relative and operating-system temp paths. */
function screenshotOutputPath() {
  if (!SCREENSHOT_PATH) return "";
  if (!path.isAbsolute(SCREENSHOT_PATH)) {
    fail("graph screenshot path must be absolute", { screenshotPath: SCREENSHOT_PATH });
  }
  const resolved = path.resolve(SCREENSHOT_PATH);
  if (resolved === "/tmp" || resolved.startsWith("/tmp/") || resolved === "/private/tmp" || resolved.startsWith("/private/tmp/")) {
    fail("graph screenshot path must use a registered workspace technical space", { screenshotPath: resolved });
  }
  return resolved;
}

/** Writes the settled post-audit viewport to the validated PNG destination and reports its byte size. */
async function captureRequestedScreenshot(cdp) {
  const outputPath = screenshotOutputPath();
  if (!outputPath) return null;
  if (SCREENSHOT_COLLAPSE_ROUTER) {
    const panelState = await evaluate(cdp, `(() => {
      const panel = document.querySelector(".graph-status-panel");
      if (!panel || panel.classList.contains("is-collapsed")) return { ok: true, changed: false };
      const button = panel.querySelector("[data-router-action='toggle-status-panel']");
      if (!button) return { ok: false, reason: "missing-router-toggle" };
      button.click();
      return { ok: true, changed: true };
    })()`);
    if (!panelState?.ok) fail("graph screenshot could not collapse the Router panel", panelState || {});
    if (panelState.changed) {
      await waitForCondition(
        cdp,
        `(() => {
          const panel = document.querySelector(".graph-status-panel");
          return { ok: Boolean(panel?.classList.contains("is-collapsed")), className: panel?.className || "" };
        })()`,
        "collapsed screenshot Router panel",
      );
    }
  }
  await evaluate(cdp, `(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return true;
  })()`);
  // Screenshot artifacts own an opaque paper surface at the capture boundary;
  // navigation can otherwise restore Chrome's transparent default background.
  await cdp.send("Emulation.setDefaultBackgroundColorOverride", {
    color: { r: 255, g: 255, b: 255, a: 1 },
  });
  const capture = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const bytes = Buffer.from(capture.data, "base64");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, bytes);
  return {
    path: outputPath,
    bytes: bytes.length,
    width: SCREENSHOT_WIDTH,
    height: SCREENSHOT_HEIGHT,
  };
}

/** Emits one successful audit report after persisting any explicitly requested screenshot. */
async function finishAudit(cdp, timings, audit) {
  const screenshot = await captureRequestedScreenshot(cdp);
  console.log(JSON.stringify({ ok: true, timings, audit, screenshot }, null, 2));
}

/** Runs the complete CDP-backed Graph DOM contract and reports measured rendering evidence. */
async function main() {
  const target = await ensureTarget();
  const cdp = await connect(target.webSocketDebuggerUrl);
  const timings = {};
  try {
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    if (SCREENSHOT_PATH) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: SCREENSHOT_WIDTH,
        height: SCREENSHOT_HEIGHT,
        deviceScaleFactor: 1,
        mobile: false,
      });
    }
    await cdp.send("Page.navigate", { url: "about:blank" });
    await waitForCondition(cdp, `(() => ({ ok: location.href === "about:blank", url: location.href }))()`, "blank navigation");
    const loadStart = Date.now();
    await cdp.send("Page.navigate", { url: GRAPH_URL });
    await waitForGraph(cdp);
    timings.graphLoadMs = Date.now() - loadStart;
    if (MAX_GRAPH_LOAD_MS > 0 && timings.graphLoadMs > MAX_GRAPH_LOAD_MS) {
      fail("graph load exceeded latency budget", {
        maxGraphLoadMs: MAX_GRAPH_LOAD_MS,
        timings,
        url: GRAPH_URL,
      });
    }
    if (EXPECT_ARCHITECTURE_ROOM_FALLBACK) {
      timings.architectureRoomFallback = await assertRejectedArchitectureRoomHashCanonicalization(cdp);
    }
    if (EXPECTED_CATEGORY === "architecture") await ensureRouterPanelOpen(cdp);
    await assertToolbarRightEdge(cdp);
    if (EXPECT_WHITEBOARD_VIEWPORT) await assertWhiteboardViewport(cdp);
    if (EXPECTED_CATEGORY === "architecture") {
      await waitForCondition(
        cdp,
        `(() => {
          const content = document.querySelector(".workspace-graph-content");
          const root = document.querySelector(".workspace-graph-root");
          return {
            ok: document.querySelectorAll(".workspace-graph-edge").length > 0,
            edgeCount: document.querySelectorAll(".workspace-graph-edge").length,
            renderLayerMode: content?.dataset?.renderLayerMode || "",
            renderLayers: content?.dataset?.renderLayers || "",
            sourceCategory: root?.dataset?.sourceCategory || "",
            architectureProjectionMode: root?.dataset?.architectureProjectionMode || "",
          };
        })()`,
        "architecture edge rendering",
      );
    }
    if (EXPECT_NAVIGATION_NODE_DRAG) {
      timings.navigationNodeDrag = await assertNavigationNodeDrag(cdp);
    }
    const selectionTiming = await selectGraphNode(cdp, SELECT_NODE_ID);
    if (selectionTiming) timings.selection = selectionTiming;
    if (EXPECT_SIGNAL_FLOW_HIGHLIGHT && !EXPECT_SIGNAL_FLOW_FOCUS) await assertSignalFlowHighlight(cdp, SELECT_NODE_ID);
    if (EXPECT_SIGNAL_FLOW_FOCUS) await assertSignalFlowFocus(cdp, SELECT_NODE_ID);
    if (EXPECT_CONTAINER_COLLAPSE) {
      timings.containerCollapse = await assertContainerCollapseFlow(cdp);
    }
    const audit = await evaluate(cdp, graphDomAuditExpression());
    if (audit.rootSourceCategory !== EXPECTED_CATEGORY) {
      fail("browser graph did not render the expected category", {
        expectedCategory: EXPECTED_CATEGORY,
        ...audit,
      });
    }
    if (EXPECTED_TITLE && audit.pageTitle !== EXPECTED_TITLE) {
      fail("browser title did not identify the installed Atlas instance", {
        expectedTitle: EXPECTED_TITLE,
        ...audit,
      });
    }
    if (
      EXPECTED_SOURCE_CATEGORIES.length
      && JSON.stringify(audit.availableSourceCategories) !== JSON.stringify(EXPECTED_SOURCE_CATEGORIES)
    ) {
      fail("source tabs did not match provider capabilities", {
        expectedSourceCategories: EXPECTED_SOURCE_CATEGORIES,
        ...audit,
      });
    }
    if (EXPECTED_SOURCE_CATEGORIES.length === 1 && !audit.sourceToggleHidden) {
      fail("single-source Atlas instances must omit the source tab control", audit);
    }
    if (audit.genericLearnedPhraseCount > 0) {
      fail("repository regions retained generic learned-model phrasing", audit);
    }
    if (!SELECT_NODE_ID && audit.selectedCount !== 0) {
      fail("browser graph should not select a node by default", audit);
    }
    if (SELECT_NODE_ID && audit.selectedCount !== 1) {
      fail("browser graph did not keep the requested node selected", {
        ...audit,
        selectedNodeId: SELECT_NODE_ID,
      });
    }
    if (SELECT_NODE_ID) {
      const selectedStyle = audit.selectedNodeStyle || {};
      const outlineWidth = Number.parseFloat(selectedStyle.outlineWidth || "0") || 0;
      const borderWidth = Number.parseFloat(selectedStyle.borderWidth || "0") || 0;
      if (selectedStyle.outlineStyle !== "none" && outlineWidth > 0) {
        fail("selected graph node must use one border and no outer outline", audit);
      }
      if (borderWidth < 2) {
        fail("selected graph node border is not visibly distinct", audit);
      }
    }
    if (audit.nodeCount < 1) {
      fail("browser graph rendered no nodes", audit);
    }
    if (audit.themeId !== "paper-lime") {
      fail("graph must render the single paper-lime theme", audit);
    }
    if (audit.routeGridHelperCellCount !== 0) {
      fail("graph must not render route-cost or blocked-cell helper coloring", audit);
    }
    if (
      audit.pageViewport?.htmlOverflowX !== "hidden"
      || audit.pageViewport?.bodyOverflowX !== "hidden"
      || Number(audit.pageViewport?.horizontalScrollbarHeight || 0) !== 0
      || Number(audit.pageViewport?.scrollX || 0) !== 0
    ) {
      fail("graph page must not expose a document-level horizontal scrollbar", audit);
    }
    // Rendered box centers own this cross-browser contract; the audit does not
    // reintroduce font-specific transforms as acceptable alignment evidence.
    if (Number(audit.labelVerticalRhythm?.maxCompactNodeDeviation || 0) > 0.5
      || Number(audit.labelVerticalRhythm?.maxEdgeLabelDeviation || 0) > 0.75
    ) {
      fail("compact node and edge labels must remain geometrically centered", audit);
    }
    if (
      audit.containerCollapseControlCount > 0
      && audit.pointerReachableContainerCollapseControlCount < 1
    ) {
      fail("rendered container collapse controls are not pointer reachable", audit);
    }
    if (MAX_CONTENT_WIDTH > 0 && Number(audit.viewport?.contentWidth || 0) > MAX_CONTENT_WIDTH) {
      fail("graph content width exceeded composition budget", {
        maxContentWidth: MAX_CONTENT_WIDTH,
        viewport: audit.viewport,
        url: GRAPH_URL,
      });
    }
    if (MAX_CONTENT_HEIGHT > 0 && Number(audit.viewport?.contentHeight || 0) > MAX_CONTENT_HEIGHT) {
      fail("graph content height exceeded composition budget", {
        maxContentHeight: MAX_CONTENT_HEIGHT,
        viewport: audit.viewport,
        url: GRAPH_URL,
      });
    }
    if (
      MIN_FIT_ZOOM > 0
      && audit.viewport?.mode === "fit"
      && Number(audit.viewport?.zoom || 0) < MIN_FIT_ZOOM
    ) {
      fail("graph fit zoom fell below composition budget", {
        minFitZoom: MIN_FIT_ZOOM,
        viewport: audit.viewport,
        url: GRAPH_URL,
      });
    }
    if (audit.visibleToolbarActions.includes("speed")) {
      fail("Speed must not be visible in the normal toolbar", audit);
    }
    if (audit.visibleToolbarActions.includes("refresh")) {
      fail("Refresh must not be visible in the normal toolbar", audit);
    }
    if (EXPECT_ARCHITECTURE_ROOM_FALLBACK) {
      if (audit.architectureProjectionMode !== EXPECTED_ARCHITECTURE_MODE || audit.architectureRoomId) {
        fail("architecture room fallback did not return to repository setup", audit);
      }
      if (!String(audit.url || "").endsWith("#architecture")) {
        fail("architecture room fallback did not normalize the URL back to the setup hash", audit);
      }
      await finishAudit(cdp, timings, audit);
      return;
    }
    if (EXPECTED_CATEGORY === "architecture") {
      const atlas = audit.architectureAtlas || {};
      const genericRepositoryProjection = [
        "multihead-atlas-default-repository-adapter",
        "consumer-repository-catalog",
        "multihead-atlas-source-inventory-v1",
      ].includes(audit.architectureProjectionSource);
      if (audit.sourceEvidenceUnexpectedDrilldownIds.length > 0) {
        fail("source evidence records must not expose room-entry markers", audit);
      }
      if (audit.sourceEvidenceEnterActionRoomIds.length > 0) {
        fail("source evidence records must not expose Enter Room actions", audit);
      }
      if (audit.roomEntryContractViolationIds.length > 0) {
        fail("navigable nodes must carry a fresh provider-declared semantic room contract and must not target the active room", audit);
      }
      if (audit.repositoryOverviewContractViolationIds.length > 0) {
        fail("repository overview return nodes must carry the contextual authority-navigation contract", audit);
      }
      if (audit.architectureProjectionSource === "multihead-atlas-repository-system-model-v1") {
        if (audit.architectureProjectionMode === "repository-system-model" && audit.repositoryOverviewReturnNodeCount !== 0) {
          fail("repository authority must remain inert on the repository overview", audit);
        }
        if (audit.architectureProjectionMode === "semantic-room"
          && (audit.repositoryOverviewReturnNodeCount !== 1 || audit.repositoryOverviewReturnMarkerNodeCount !== 1)) {
          fail("semantic room must expose exactly one repository authority return", audit);
        }
      }
      if (EXPECT_REPOSITORY_OVERVIEW_NODE_RETURN) {
        await assertRepositoryOverviewNodeReturn(cdp);
        await finishAudit(cdp, timings, audit);
        return;
      }
      if (!SELECT_NODE_ID && !audit.architectureAtlas) {
        fail("architecture graph did not expose repository setup state in the Router panel", audit);
      }
      if (audit.architectureProjectionMode !== EXPECTED_ARCHITECTURE_MODE) {
        fail("architecture graph did not render expected architecture mode", audit);
      }
      if (!SELECT_NODE_ID) {
        if (atlas.retrievalMode !== "sqlite-token-index") {
          fail("architecture panel did not expose sqlite-token-index retrieval", audit);
        }
        if (!atlas.selectedRoom) {
          fail("architecture panel did not expose the selected entry", audit);
        }
        if (!Number.isFinite(Number(atlas.indexSimilarity))) {
          fail("architecture panel did not expose a numeric index similarity", audit);
        }
        if (!atlas.routeTrail) {
          fail("architecture panel did not expose the selected route trail", audit);
        }
        if (Number(atlas.candidateCount || 0) < 2) {
          fail("architecture panel did not expose ranked route candidates", audit);
        }
        if (!Array.isArray(atlas.candidateActionRooms) || atlas.candidateActionRooms.length < 1) {
          fail("architecture panel did not expose provider-ranked room switch actions", audit);
        }
      }
      if (genericRepositoryProjection) {
        if (Number(audit.containerKindCounts?.architecture_source_group || 0) < 1) {
          fail("generic repository architecture did not render structural source groups", audit);
        }
        if (Number(audit.relationshipKindCounts?.contains_source_group || 0) < 1) {
          fail("generic repository architecture did not connect its authority to source groups", audit);
        }
        if (EXPECTED_ARCHITECTURE_MODE === "repository-setup") {
          if (audit.nodeCount < 2 || audit.sourceEvidenceNodeCount < 1) {
            fail("generic repository setup did not expose structural source evidence", audit);
          }
        } else if (EXPECTED_ARCHITECTURE_MODE === "room") {
          if (!audit.architectureRoomId || audit.nodeCount < 2) {
            fail("generic repository room did not retain authority and source context", audit);
          }
        }
        await finishAudit(cdp, timings, audit);
        return;
      }
      if (
        audit.architectureProjectionSource === "multihead-atlas-repository-system-model-v1"
        && EXPECTED_ARCHITECTURE_MODE === "repository-system-model"
      ) {
        if (Number(audit.containerKindCounts?.architecture_semantic_region || 0) < 1) {
          fail("learned repository architecture did not render its named semantic regions", audit);
        }
        if (Number(audit.relationshipKindCounts?.semantic_relationship || 0) < 1) {
          fail("learned repository architecture did not render its validated relationships", audit);
        }
        if (audit.drilldownCapableNodeCount !== audit.nodeCount - 1) {
          fail("learned repository overview must keep only its authority node non-navigable", audit);
        }
        await finishAudit(cdp, timings, audit);
        return;
      }
      if (
        audit.architectureProjectionSource === "multihead-atlas-repository-system-model-v1"
        && EXPECTED_ARCHITECTURE_MODE === "semantic-room"
      ) {
        if (!audit.architectureRoomId || (EXPECTED_ARCHITECTURE_ROOM
          && audit.architectureRoomId !== EXPECTED_ARCHITECTURE_ROOM)) {
          fail("learned repository room did not render the requested semantic responsibility", {
            ...audit,
            expectedArchitectureRoom: EXPECTED_ARCHITECTURE_ROOM,
          });
        }
        if (audit.repositoryOverviewReturnNodeCount !== 1) {
          fail("learned repository room did not retain one repository overview return", audit);
        }
        if (Number(audit.relationshipKindCounts?.semantic_relationship || 0) < 1) {
          fail("learned repository room did not retain its validated semantic relationships", audit);
        }
        await finishAudit(cdp, timings, audit);
        return;
      }
      if (EXPECTED_ARCHITECTURE_MODE === "room" && EXPECT_ARCHITECTURE_ROOM_BACK_RESET) {
        await assertArchitectureRoomBackReset(cdp);
        await finishAudit(cdp, timings, audit);
        return;
      }
      if (EXPECT_ROUTE_CANDIDATE_SWITCH_ROOM) {
        await assertArchitectureRouteCandidateSwitch(cdp, EXPECT_ROUTE_CANDIDATE_SWITCH_ROOM);
        await finishAudit(cdp, timings, audit);
        return;
      }
      if (EXPECTED_ARCHITECTURE_MODE === "room") {
        if (EXPECTED_ARCHITECTURE_ROOM && audit.architectureRoomId !== EXPECTED_ARCHITECTURE_ROOM) {
          fail("architecture room graph rendered the wrong room id", {
            ...audit,
            expectedArchitectureRoom: EXPECTED_ARCHITECTURE_ROOM,
          });
        }
        if (!atlas.routeTrail || !atlas.routeTrail.includes("Architecture Setup")) {
          fail("architecture room panel did not expose a readable setup-to-room trail", audit);
        }
        if (Number(atlas.candidateCount || 0) < 1) {
          fail("architecture room panel did not expose ranked route candidates", audit);
        }
        if (audit.architectureProjectionSource !== "provider-source-derived-slice") {
          fail("architecture room graph did not come from the provider source-derived slice", audit);
        }
        if (audit.architectureAnswerNodeCount > 0) {
          fail("architecture room graph must not render answer metadata as graph nodes", audit);
        }
        if (audit.architectureDrilldownMissingMarkerIds.length > 0) {
          fail("architecture drilldown room nodes must expose drilldown markers", audit);
        }
        if (audit.architectureElementUnexpectedDrilldownIds.length > 0) {
          fail("architecture element nodes must not expose drilldown markers", audit);
        }
        if (audit.architectureRoomDetailNodeCount < 6) {
          fail("architecture room graph did not render enough source-derived room detail", audit);
        }
        if (audit.containerCount < 2) {
          fail("architecture room graph did not render source-derived grouping containers", audit);
        }
        if ((audit.edgeStyleCounts.primary || 0) < 5) {
          fail("architecture room graph did not render direct primary source relationships", audit);
        }
        await finishAudit(cdp, timings, audit);
        return;
      }
      if (EXPECT_ENTER_ROOM_ACTION) {
        const matchingAction = audit.routerActions.find((action) =>
          action.action === "enter-architecture-room"
          && (!EXPECTED_ARCHITECTURE_ROOM || action.roomId === EXPECTED_ARCHITECTURE_ROOM)
        );
        if (!matchingAction) {
          fail("architecture repository setup did not expose the expected source-derived room action", {
            ...audit,
            expectedArchitectureRoom: EXPECTED_ARCHITECTURE_ROOM,
            selectedNodeId: SELECT_NODE_ID,
          });
        }
      }
      if (audit.architectureRoomNodeCount > 0) {
        fail("architecture repository setup must not render old room-navigator nodes", audit);
      }
      if (audit.architectureWorkspaceNodeCount < 1) {
        fail("architecture graph did not render registered repository setup nodes", audit);
      }
      if (audit.architectureWorkspaceDrilldownMissingIds.length > 0) {
        fail("architecture setup workspace nodes must expose drilldown markers", audit);
      }
      if (new Set(audit.architectureWorkspaceNodeIds).size !== audit.architectureWorkspaceNodeIds.length) {
        fail("architecture graph rendered duplicate repository setup entries", audit);
      }
      if (
        !SELECT_NODE_ID
        && audit.routerActions.some((action) =>
          action.action === "enter-architecture-room"
          && action.context !== "atlas-route-candidate"
        )
      ) {
        fail("architecture repository setup exposed room descent outside provider-ranked route candidates", audit);
      }
      if (audit.nodeCount > 24) {
        fail("architecture graph rendered too many nodes; expected repository setup, not a full architecture dump", audit);
      }
      if (audit.containerCount < 1) {
        fail("architecture graph did not render the repository setup container", audit);
      }
      if ((audit.edgeStyleCounts.support || 0) > 0 || (audit.edgeStyleCounts.reference || 0) > 0) {
        fail("architecture repository setup relationships must render as direct primary edges", audit);
      }
      if (!SELECT_NODE_ID && (!/Repository Setup/.test(atlas.text) || !/selected entry/i.test(atlas.text))) {
        fail("architecture repository setup panel is missing visible route/index details", audit);
      }
      if (!SELECT_NODE_ID) await assertArchitectureNodeDoubleClick(cdp);
      await finishAudit(cdp, timings, audit);
      return;
    }
    if (EXPECTED_CATEGORY !== "workstreams") {
      await finishAudit(cdp, timings, audit);
      return;
    }
    if (audit.currentishCount < 1) {
      fail("browser graph has no visible current or attention session node", audit);
    }
    if (!audit.lifecycleContainers.length) {
      fail("browser graph has no visible active/resumable/attention session container metadata", audit);
    }
    if (!audit.currentStateContainer) {
      fail("browser graph active session container does not expose current-state summary", audit);
    }
    const currentishStyle = audit.currentish[0] || {};
    const pastStyle = audit.pastSample || {};
    const opacityDelta = Number(currentishStyle.opacity || 0) - Number(pastStyle.opacity || 0);
    const hasVisibleCurrentDifference = Boolean(
      currentishStyle.backgroundColor !== pastStyle.backgroundColor
        || opacityDelta > 0.1
        || (currentishStyle.outlineStyle && currentishStyle.outlineStyle !== "none"),
    );
    if (!hasVisibleCurrentDifference) {
      fail("current or attention session emphasis is present in DOM but not visually distinguishable", audit);
    }
    await finishAudit(cdp, timings, audit);
  } finally {
    cdp.close();
  }
}

main().catch((error) => {
  fail("browser DOM audit failed", { error: String(error?.message || error) });
});
