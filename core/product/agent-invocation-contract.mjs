/*
 * Agent Invocation Contract owns Atlas's smallest portable agent-integration
 * surface: one deterministic managed block in the consumer repository's root
 * AGENTS.md. The block calls only the installed repository-local CLI and leaves
 * task routing, source authority, durable writes, and every instruction outside
 * its markers under consumer control. Later skills, plugins, or MCP adapters
 * must preserve this query/evidence boundary instead of reimplementing Atlas.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const ATLAS_AGENT_INVOCATION_SCHEMA = "multihead-atlas.agent_invocation.v1";
export const ATLAS_AGENT_INSTRUCTION_STATUS_SCHEMA = "multihead-atlas.agent_instruction_status.v1";
export const ATLAS_AGENT_INSTRUCTION_RESULT_SCHEMA = "multihead-atlas.agent_instruction_command_result.v1";
export const ATLAS_AGENT_INSTRUCTION_PATH = "AGENTS.md";
export const ATLAS_AGENT_INSTRUCTION_BEGIN = `<!-- atlas-agent-invocation:begin ${ATLAS_AGENT_INVOCATION_SCHEMA} -->`;
export const ATLAS_AGENT_INSTRUCTION_END = `<!-- atlas-agent-invocation:end ${ATLAS_AGENT_INVOCATION_SCHEMA} -->`;

export const ATLAS_AGENT_INVOCATION_CONTRACT = Object.freeze({
  schema: ATLAS_AGENT_INVOCATION_SCHEMA,
  hostCapability: "repository-agents-md",
  unsupportedHostBehavior: "use-explicit-installed-cli-or-replaceable-host-package",
  instructionPath: ATLAS_AGENT_INSTRUCTION_PATH,
  trigger: "after-consumer-task-route-before-broad-source-exploration",
  command: ".atlas/bin/atlas evidence <query>",
  diagnosticCommand: ".atlas/bin/atlas search <query>",
  verificationCommand: ".atlas/bin/atlas verify",
  generationStatusCommand: ".atlas/bin/atlas generation status",
  generationRequestCommand: ".atlas/bin/atlas generation request --kind <kind> --source <path>",
  generationApplyCommand: ".atlas/bin/atlas generation apply --artifact <path>",
  generationDefaultMode: "current-agent",
  generationHandshake: "request-current-agent-result-validate-apply",
  queryPolicy: "original-user-request-or-visible-bounded-derivation",
  evidenceSchema: "multihead-atlas.instance_evidence.v2",
  invalidInstallationBehavior: "fail-before-evidence-retrieval",
  sourceAuthority: "consumer-repository-files",
  observability: Object.freeze([
    "query",
    "evidence-state",
    "relative-source-locators",
    "packet-digest",
  ]),
  prohibitedSideEffects: Object.freeze([
    "durable-memory-write",
    "source-policy-change",
    "sync-publication",
    "remote-knowledge-transfer",
  ]),
});

/** Computes the stable content digest used to compare managed instruction blocks. */
function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Counts exact marker occurrences so malformed or duplicated managed blocks are rejected. */
function countOccurrences(value, token) {
  return String(value).split(token).length - 1;
}

/** Locates the sole complete Atlas marker pair and returns its replacement byte range. */
function instructionBlockRange(content) {
  const beginCount = countOccurrences(content, ATLAS_AGENT_INSTRUCTION_BEGIN);
  const endCount = countOccurrences(content, ATLAS_AGENT_INSTRUCTION_END);
  if (beginCount === 0 && endCount === 0) return null;
  if (beginCount !== 1 || endCount !== 1) {
    throw new Error("Atlas agent instructions require exactly one complete managed block");
  }
  const begin = content.indexOf(ATLAS_AGENT_INSTRUCTION_BEGIN);
  const end = content.indexOf(ATLAS_AGENT_INSTRUCTION_END);
  if (end < begin) throw new Error("Atlas agent instruction markers are out of order");
  return Object.freeze({ begin, end: end + ATLAS_AGENT_INSTRUCTION_END.length });
}

/** Renders the canonical agent guidance block that invokes only the installed Atlas CLI. */
export function renderAtlasAgentInstructionBlock() {
  return `${ATLAS_AGENT_INSTRUCTION_BEGIN}
## Atlas repository evidence

Follow this repository's own task route and instructions first. For non-trivial
repository work, before broad source exploration:

1. Run \`.atlas/bin/atlas evidence "<original user request>"\`. If a narrower
   derived query is necessary, state the query that is sent to Atlas.
2. Inspect the returned state and relative source locators, then open and verify
   the highest-ranking relevant repository files. Files remain authoritative;
   Atlas summaries and excerpts are navigation evidence.
3. For \`weak\`, \`stale\`, or \`missing\` evidence, retry with a bounded query
   and use \`.atlas/bin/atlas search "query"\` only for ranking diagnosis before
   a bounded direct source search. Use \`.atlas/bin/atlas verify\` to diagnose an
   invalid installation.
4. For \`conflicting\` evidence, stop the affected conclusion until the
   consumer's reconciliation workflow produces an explicit resolution.
5. Retrieval must not write durable memory, change source inclusion, publish
   sync records, or send repository knowledge to a remote service.

When the user asks Atlas to generate a summary, room specification,
workspace-entry summary, or route explanation:

1. Run \`.atlas/bin/atlas generation status\`. The default \`current-agent\`
   mode is an interactive request/result/apply handshake; Atlas does not call
   the open agent session by itself.
2. Create a bounded request with \`.atlas/bin/atlas generation request --kind
   <kind> --source <admitted-relative-path>\`. Read only the request sources and
   return the exact structured result schema and source digests it requires.
3. Save the result inside the repository and run \`.atlas/bin/atlas generation
   apply --artifact <relative-path>\`. Atlas rejects stale or mismatched source
   provenance and writes only ignored generated state.
4. A configured command adapter is a separate generation mode. Never add
   \`--allow-remote\` or send repository sources externally without the user's
   explicit approval for that invocation.
${ATLAS_AGENT_INSTRUCTION_END}`;
}

/** Verifies whether a consumer AGENTS file contains the current untampered Atlas block. */
export function inspectAtlasAgentInstructions(options = {}) {
  const root = path.resolve(String(options.root || "").trim());
  if (!String(options.root || "").trim()) throw new Error("Atlas agent instruction inspection requires root");
  const instructionPath = path.join(root, ATLAS_AGENT_INSTRUCTION_PATH);
  const expected = renderAtlasAgentInstructionBlock();
  const base = {
    schema: ATLAS_AGENT_INSTRUCTION_STATUS_SCHEMA,
    instructionPath: ATLAS_AGENT_INSTRUCTION_PATH,
    expectedDigest: sha256(expected),
  };
  if (!fs.existsSync(instructionPath)) {
    return Object.freeze({ ...base, status: "absent", actualDigest: "", managed: false });
  }
  if (fs.lstatSync(instructionPath).isSymbolicLink()) {
    return Object.freeze({ ...base, status: "invalid", actualDigest: "", managed: false, reason: "instruction-path-is-symbolic-link" });
  }
  const content = fs.readFileSync(instructionPath, "utf8");
  let range;
  try {
    range = instructionBlockRange(content);
  } catch (error) {
    return Object.freeze({ ...base, status: "invalid", actualDigest: "", managed: false, reason: error.message });
  }
  if (!range) return Object.freeze({ ...base, status: "absent", actualDigest: "", managed: false });
  const actual = content.slice(range.begin, range.end);
  return Object.freeze({
    ...base,
    status: actual === expected ? "current" : "stale",
    actualDigest: sha256(actual),
    managed: true,
  });
}

/**
 * Replaces only the bytes between the managed marker pair. Those markers are
 * the only mutation authority granted to Atlas, while all consumer-authored bytes before
 * and after it remain unchanged. Partial, duplicate, or reordered markers are
 * rejected instead of being normalized into a second instruction authority.
 */
export function mergeAtlasAgentInstructions(content = "") {
  const current = String(content);
  const expected = renderAtlasAgentInstructionBlock();
  const range = instructionBlockRange(current);
  if (range) {
    const merged = `${current.slice(0, range.begin)}${expected}${current.slice(range.end)}`;
    return Object.freeze({ content: merged, action: merged === current ? "unchanged" : "updated", mutation: null });
  }
  const separator = !current ? "" : current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  return Object.freeze({
    content: `${current}${separator}${expected}\n`,
    action: current ? "appended" : "created",
    mutation: Object.freeze({ insertedPrefix: separator, insertedSuffix: "\n" }),
  });
}

/** Installs or refreshes the managed block atomically while preserving all consumer-authored instructions. */
export function installAtlasAgentInstructions(options = {}) {
  const rootValue = String(options.root || "").trim();
  if (!rootValue) throw new Error("Atlas agent instruction installation requires root");
  const root = path.resolve(rootValue);
  const instructionPath = path.join(root, ATLAS_AGENT_INSTRUCTION_PATH);
  const existed = fs.existsSync(instructionPath);
  if (existed && fs.lstatSync(instructionPath).isSymbolicLink()) {
    throw new Error("Atlas agent instructions refuse a symbolic-link AGENTS.md");
  }
  const current = existed ? fs.readFileSync(instructionPath, "utf8") : "";
  const merged = mergeAtlasAgentInstructions(current);
  if (merged.action !== "unchanged") {
    fs.mkdirSync(root, { recursive: true });
    const staging = `${instructionPath}.writing-${process.pid}`;
    fs.writeFileSync(staging, merged.content, "utf8");
    fs.renameSync(staging, instructionPath);
  }
  const inspected = inspectAtlasAgentInstructions({ root });
  if (inspected.status !== "current") throw new Error(`Atlas agent instructions did not verify: ${inspected.status}`);
  return Object.freeze({
    ...inspected,
    action: merged.action,
    mutation: merged.mutation ? Object.freeze({
      path: ATLAS_AGENT_INSTRUCTION_PATH,
      createdFile: !existed,
      insertedPrefix: merged.mutation.insertedPrefix,
      insertedSuffix: merged.mutation.insertedSuffix,
      previousDigest: sha256(current),
    }) : null,
  });
}

/**
 * Removes only the Atlas marker-owned instruction bytes. A recorded insertion
 * delimiter restores a fresh installation exactly; legacy blocks without a
 * receipt are removed conservatively without claiming adjacent whitespace.
 */
export function removeAtlasAgentInstructions(options = {}) {
  const rootValue = String(options.root || "").trim();
  if (!rootValue) throw new Error("Atlas agent instruction removal requires root");
  const instructionPath = path.join(path.resolve(rootValue), ATLAS_AGENT_INSTRUCTION_PATH);
  if (!fs.existsSync(instructionPath)) return Object.freeze({ status: "absent", action: "unchanged" });
  if (fs.lstatSync(instructionPath).isSymbolicLink()) {
    throw new Error("Atlas agent instructions refuse a symbolic-link AGENTS.md");
  }
  const content = fs.readFileSync(instructionPath, "utf8");
  const range = instructionBlockRange(content);
  if (!range) return Object.freeze({ status: "absent", action: "unchanged" });
  const receipt = options.receipt || null;
  let begin = range.begin;
  let end = range.end;
  if (receipt?.insertedPrefix && content.slice(begin - receipt.insertedPrefix.length, begin) === receipt.insertedPrefix) {
    begin -= receipt.insertedPrefix.length;
  }
  if (receipt?.insertedSuffix && content.slice(end, end + receipt.insertedSuffix.length) === receipt.insertedSuffix) {
    end += receipt.insertedSuffix.length;
  }
  const remaining = `${content.slice(0, begin)}${content.slice(end)}`;
  const markerOnlyLegacyFile = !receipt && content === `${renderAtlasAgentInstructionBlock()}\n`;
  if ((receipt?.createdFile && !remaining) || markerOnlyLegacyFile) {
    fs.rmSync(instructionPath);
    return Object.freeze({ status: "removed", action: "deleted-file", restoredDigest: sha256(remaining) });
  }
  const staging = `${instructionPath}.writing-${process.pid}`;
  fs.writeFileSync(staging, remaining, "utf8");
  fs.renameSync(staging, instructionPath);
  return Object.freeze({
    status: "removed",
    action: "removed-managed-block",
    restoredDigest: sha256(remaining),
    matchesPreviousDigest: receipt ? sha256(remaining) === receipt.previousDigest : null,
  });
}
