/*
 * Installation Contract owns repository-local, meta-repository-local, and
 * global Atlas runtime placement. The manifest owns intent, the lock records
 * exact installed revisions and digests, and generated runtime/state remain
 * outside durable memory authority.
 */

import crypto from "node:crypto";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readAtlasEvidenceRelease } from "./evidence-contract.mjs";

export const ATLAS_INSTALLATION_MANIFEST_SCHEMA = "multihead-atlas.installation_manifest.v1";
export const ATLAS_INSTALLATION_LOCK_SCHEMA = "multihead-atlas.installation_lock.v3";
export const ATLAS_DISTRIBUTION_PROVENANCE_SCHEMA = "multihead-atlas.public_components.v3";
export const ATLAS_INSTALLATION_SCOPES = Object.freeze([
  "repository",
  "meta-repository",
  "global",
]);

/** Lists the exact Atlas Core files copied into every consumer installation. */
export const ATLAS_RUNTIME_FILES = Object.freeze([
  "VERSION",
  "product/docs/EVIDENCE_V2.md",
  "product/agent-invocation-contract.mjs",
  "product/evidence-contract.mjs",
  "product/evidence-release.json",
  "product/generation-provider.mjs",
  "product/installation-contract.mjs",
  "product/instance-contract.mjs",
  "product/repository-provider.mjs",
  "product/retrieval-engine.mjs",
  "product/sync-protocol.mjs",
  "product/uninstall-contract.mjs",
  "scripts/atlas",
  "scripts/atlas-graph",
  "scripts/atlas-generation-mock",
  "scripts/atlas-generation-openai",
  "scripts/atlas-init",
  "scripts/atlas-provider",
  "scripts/atlas-sync",
  "scripts/atlas-uninstall",
]);

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REVISION_PATTERN = /^[a-f0-9]{40,64}$/u;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

/** Validates that one installation identity or path field contains non-empty text. */
function requiredText(value, field) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`Atlas installation requires ${field}`);
  return text;
}

/** Normalizes a manifest path while rejecting absolute or parent-escaping locations. */
function normalizedRelativePath(value, field) {
  const relative = path.normalize(requiredText(value, field));
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`Atlas installation ${field} must stay inside the installation root`);
  }
  return relative;
}

/** Resolves a required child path and rejects aliases of the installation root itself. */
function resolveInside(root, relative, field) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  const relation = path.relative(resolvedRoot, resolved);
  if (!relation || relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error(`Atlas installation ${field} must name a child of the installation root`);
  }
  return resolved;
}

/** Validates one provenance path without normalizing an escape or alternate separator. */
function provenanceRelativePath(value, field) {
  const relative = requiredText(value, field);
  const normalized = path.posix.normalize(relative);
  if (relative.includes("\0")) throw new Error(`Atlas distribution ${field} must not contain NUL`);
  if (relative.includes("\\") || path.posix.isAbsolute(relative) || normalized !== relative
    || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Atlas distribution ${field} must stay inside the distribution root`);
  }
  return relative;
}

/**
 * Resolves one distribution file while rejecting symbolic links in every
 * archive-owned path segment. Provenance hashing and runtime copying both call
 * this boundary so a recorded relative path cannot become an external read.
 */
function distributionRegularFile(root, relative, field) {
  const resolvedRoot = path.resolve(root);
  const rootStat = fs.lstatSync(resolvedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Atlas distribution root must be a regular directory, not a symbolic link");
  }
  let current = resolvedRoot;
  const segments = provenanceRelativePath(relative, field).split("/");
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      throw new Error(`Atlas distribution ${field} is missing: ${relative}`);
    }
    if (stat.isSymbolicLink()) throw new Error(`Atlas distribution ${field} contains a symbolic link: ${relative}`);
    const final = index === segments.length - 1;
    if ((!final && !stat.isDirectory()) || (final && !stat.isFile())) {
      throw new Error(`Atlas distribution ${field} must resolve to a regular file: ${relative}`);
    }
  }
  return current;
}

/** Validates one exact exported-file record before its bytes can become installation input. */
function distributionFileRecord(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Atlas distribution files[${index}] must be an object`);
  }
  const relative = provenanceRelativePath(value.path, `files[${index}].path`);
  const sha256 = String(value.sha256 || "").trim();
  const bytes = Number(value.bytes);
  const mode = String(value.mode || "").trim();
  if (!SHA256_PATTERN.test(sha256)) throw new Error(`Atlas distribution files[${index}].sha256 must be a SHA-256 digest`);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error(`Atlas distribution files[${index}].bytes must be a non-negative integer`);
  if (!["0644", "0755"].includes(mode)) throw new Error(`Atlas distribution files[${index}].mode must be 0644 or 0755`);
  return Object.freeze({ path: relative, sha256, bytes, mode });
}

/** Validates one reviewed or explicitly admitted development component identity. */
function distributionComponentRecord(value, id, allowDevelopment) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Atlas distribution components.${id} must be an object`);
  }
  const version = requiredText(value.version, `components.${id}.version`);
  const revision = String(value.revision || "").trim();
  if (!SEMVER_PATTERN.test(version)) throw new Error(`Atlas distribution components.${id}.version must be SemVer`);
  if (!REVISION_PATTERN.test(revision)) throw new Error(`Atlas distribution components.${id}.revision must be a Git object id`);
  const reviewState = String(value.reviewState || "").trim();
  if (reviewState !== "reviewed" && !(allowDevelopment && reviewState === "development")) {
    throw new Error(`Atlas distribution components.${id} must be reviewed unless the development override is explicit`);
  }
  return Object.freeze({ version, revision, reviewState });
}

/** Returns whether one provenance-recorded Graph path belongs in an installed runtime. */
function isGraphRuntimeFile(relative) {
  return relative === "index.html"
    || relative === "site.css"
    || relative === "package.json"
    || relative === "package-lock.json"
    || relative === "vite.config.js"
    || relative.endsWith(".js")
    || relative.startsWith("assets/")
    || relative.startsWith("public/");
}

/** Computes the raw SHA-256 digest used by public exported-file records. */
function publicFileDigest(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

/** Computes the path, digest, and mode-bound identity of the exported payload ledger. */
function publicPayloadTreeDigest(files) {
  const digest = crypto.createHash("sha256");
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    digest.update(file.path).update("\0").update(file.sha256).update("\0").update(file.mode).update("\n");
  }
  return digest.digest("hex");
}

/**
 * Reads the public distribution's root provenance authority and binds it to
 * the exact Core and Graph subtrees supplied to installation. Git remains the
 * source authority only when callers omit this explicit provenance path.
 */
export function readAtlasDistributionProvenance(options = {}) {
  const provenancePath = path.resolve(requiredText(options.provenancePath, "distribution provenance path"));
  if (path.basename(provenancePath) !== "ATLAS_COMPONENTS.json") {
    throw new Error("Atlas distribution provenance path must name ATLAS_COMPONENTS.json");
  }
  const distributionRoot = path.dirname(provenancePath);
  const atlasSource = path.resolve(requiredText(options.atlasSource, "atlasSource"));
  const graphSource = path.resolve(requiredText(options.graphSource, "graphSource"));
  if (atlasSource !== path.join(distributionRoot, "core") || graphSource !== path.join(distributionRoot, "graph")) {
    throw new Error("Atlas distribution provenance must bind the root core and graph subtrees");
  }
  distributionRegularFile(distributionRoot, "ATLAS_COMPONENTS.json", "provenance file");
  const value = JSON.parse(fs.readFileSync(provenancePath, "utf8"));
  if (value.schema !== ATLAS_DISTRIBUTION_PROVENANCE_SCHEMA) {
    throw new Error(`Atlas distribution provenance schema must be ${ATLAS_DISTRIBUTION_PROVENANCE_SCHEMA}`);
  }
  if (!Array.isArray(value.files) || !value.files.length) {
    throw new Error("Atlas distribution provenance must declare exported files");
  }
  const files = value.files.map(distributionFileRecord);
  const paths = files.map((record) => record.path);
  if (new Set(paths).size !== paths.length) throw new Error("Atlas distribution provenance contains duplicate file records");
  const caseFoldedPaths = paths.map((relative) => relative.normalize("NFC").toLowerCase());
  if (new Set(caseFoldedPaths).size !== caseFoldedPaths.length) {
    throw new Error("Atlas distribution provenance contains case-folded duplicate file records");
  }
  if (!SHA256_PATTERN.test(String(value.payloadTreeDigest || "")) || publicPayloadTreeDigest(files) !== value.payloadTreeDigest) {
    throw new Error("Atlas distribution payload tree digest does not match provenance file records");
  }
  for (const record of files) {
    const filePath = distributionRegularFile(distributionRoot, record.path, `file ${record.path}`);
    const stat = fs.statSync(filePath);
    const mode = (stat.mode & 0o111) ? "0755" : "0644";
    if (stat.size !== record.bytes) throw new Error(`Atlas distribution file size does not match provenance: ${record.path}`);
    if (mode !== record.mode) throw new Error(`Atlas distribution file mode does not match provenance: ${record.path}`);
    if (publicFileDigest(filePath) !== record.sha256) throw new Error(`Atlas distribution file digest does not match provenance: ${record.path}`);
  }

  const atlas = distributionComponentRecord(
    value.components?.["atlas-core"],
    "atlas-core",
    options.allowDevelopmentProvenance === true,
  );
  const graph = distributionComponentRecord(
    value.components?.["atlas-graph"],
    "atlas-graph",
    options.allowDevelopmentProvenance === true,
  );
  const recordPaths = new Set(paths);
  for (const relative of ATLAS_RUNTIME_FILES) {
    if (!recordPaths.has(`core/${relative}`)) {
      throw new Error(`Atlas distribution provenance omits Core runtime file: core/${relative}`);
    }
  }
  const graphFiles = paths
    .filter((relative) => relative.startsWith("graph/"))
    .map((relative) => relative.slice("graph/".length))
    .filter(isGraphRuntimeFile)
    .sort();
  for (const relative of ["index.html", "site.css", "package.json", "package-lock.json", "vite.config.js"]) {
    if (!graphFiles.includes(relative)) throw new Error(`Atlas distribution provenance omits Graph runtime file: graph/${relative}`);
  }

  const distributionVersion = requiredText(value.distribution?.version, "distribution version");
  if (!SEMVER_PATTERN.test(distributionVersion)) throw new Error("Atlas distribution version must be SemVer");
  const rootVersion = fs.readFileSync(distributionRegularFile(distributionRoot, "VERSION", "root VERSION"), "utf8").trim();
  const atlasVersion = fs.readFileSync(distributionRegularFile(distributionRoot, "core/VERSION", "Core VERSION"), "utf8").trim();
  const graphVersion = String(JSON.parse(fs.readFileSync(
    distributionRegularFile(distributionRoot, "graph/package.json", "Graph package"),
    "utf8",
  )).version || "").trim();
  if (rootVersion !== distributionVersion) throw new Error("Atlas distribution root VERSION does not match provenance");
  if (atlasVersion !== atlas.version) throw new Error("Atlas distribution Core version does not match provenance");
  if (graphVersion !== graph.version) throw new Error("Atlas distribution Graph version does not match provenance");

  return Object.freeze({
    schema: value.schema,
    path: provenancePath,
    distributionRoot,
    distribution: Object.freeze({ version: distributionVersion }),
    packages: Object.freeze({
      atlas: Object.freeze({ ...atlas, files: ATLAS_RUNTIME_FILES }),
      graph: Object.freeze({ ...graph, files: Object.freeze(graphFiles) }),
    }),
    files: Object.freeze(files),
  });
}

/** Validates one component's requested version and optional exact source revision. */
function packageIntent(value, field) {
  if (!value || typeof value !== "object") throw new Error(`Atlas installation requires packages.${field}`);
  return {
    version: requiredText(value.version, `packages.${field}.version`),
    revision: String(value.revision || "").trim(),
  };
}

/** Validates installation scope, non-overlapping paths, and both component intents. */
export function validateAtlasInstallationManifest(value) {
  if (!value || typeof value !== "object") throw new Error("Atlas installation manifest must be an object");
  if (value.schema !== ATLAS_INSTALLATION_MANIFEST_SCHEMA) {
    throw new Error(`Atlas installation manifest schema must be ${ATLAS_INSTALLATION_MANIFEST_SCHEMA}`);
  }
  const scope = requiredText(value.scope, "scope");
  if (!ATLAS_INSTALLATION_SCOPES.includes(scope)) {
    throw new Error(`Atlas installation scope must be one of: ${ATLAS_INSTALLATION_SCOPES.join(", ")}`);
  }
  const runtimePath = normalizedRelativePath(value.runtimePath, "runtimePath");
  const statePath = normalizedRelativePath(value.statePath, "statePath");
  if (runtimePath === statePath || runtimePath.startsWith(`${statePath}${path.sep}`) || statePath.startsWith(`${runtimePath}${path.sep}`)) {
    throw new Error("Atlas installation runtimePath and statePath must not overlap");
  }
  return Object.freeze({
    schema: value.schema,
    installationId: requiredText(value.installationId, "installationId"),
    scope,
    runtimePath,
    statePath,
    packages: Object.freeze({
      atlas: Object.freeze(packageIntent(value.packages?.atlas, "atlas")),
      graph: Object.freeze(packageIntent(value.packages?.graph, "graph")),
    }),
  });
}

/** Reads an installation manifest from disk and returns its normalized contract form. */
export function readAtlasInstallationManifest(manifestPath) {
  const resolved = path.resolve(requiredText(manifestPath, "manifest path"));
  return validateAtlasInstallationManifest(JSON.parse(fs.readFileSync(resolved, "utf8")));
}

/** Reads the exact Git commit used as one component's installation source revision. */
function sourceRevision(sourceRoot) {
  const result = childProcess.spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: sourceRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(`Atlas installation source is not a Git checkout: ${sourceRoot}`);
  return result.stdout.trim();
}

/** Detects tracked or untracked changes limited to the files copied into a package. */
function sourceChanges(sourceRoot, files) {
  const result = childProcess.spawnSync("git", ["status", "--porcelain", "--", ...files], {
    cwd: sourceRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(`Atlas installation could not inspect source state: ${sourceRoot}`);
  return result.stdout.trim();
}

/** Reads the declared component version from Core's VERSION or Graph's package metadata. */
function sourceVersion(sourceRoot, packageName) {
  if (packageName === "atlas") return fs.readFileSync(path.join(sourceRoot, "VERSION"), "utf8").trim();
  return JSON.parse(fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8")).version;
}

/**
 * Selects the tracked Graph runtime and retains missing tracked candidates so
 * an intentional development deletion still participates in source-state
 * admission without being copied into the replacement runtime.
 */
function graphRuntimeSelection(sourceRoot) {
  const result = childProcess.spawnSync("git", ["ls-files", "-z"], {
    cwd: sourceRoot,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(`Memory Graph source is not a Git checkout: ${sourceRoot}`);
  const candidates = result.stdout.toString("utf8").split("\0").filter(Boolean).filter((relative) =>
    relative === "index.html"
      || relative === "site.css"
      || relative === "package.json"
      || relative === "package-lock.json"
      || relative === "vite.config.js"
      || relative.endsWith(".js")
      || relative.startsWith("assets/")
      || relative.startsWith("public/"));
  const files = candidates.filter((relative) => fs.existsSync(path.join(sourceRoot, relative)));
  return { candidates, files };
}

/** Copies the reviewed runtime allowlist while rejecting absent, linked, or non-file sources. */
function copyFiles(sourceRoot, targetRoot, files, options = {}) {
  for (const relative of files) {
    const distributionPath = options.distributionRoot ? `${options.distributionPrefix}/${relative}` : "";
    const source = options.distributionRoot
      ? distributionRegularFile(options.distributionRoot, distributionPath, `runtime file ${distributionPath}`)
      : path.resolve(sourceRoot, relative);
    const target = path.resolve(targetRoot, relative);
    if (!fs.existsSync(source) || !fs.lstatSync(source).isFile()) {
      throw new Error(`Atlas installation source file is missing: ${source}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (options.distributionRecords) {
      const record = options.distributionRecords.get(distributionPath);
      const bytes = fs.readFileSync(source);
      if (!record || bytes.length !== record.bytes
        || crypto.createHash("sha256").update(bytes).digest("hex") !== record.sha256) {
        throw new Error(`Atlas distribution runtime file changed during installation: ${distributionPath}`);
      }
      fs.writeFileSync(target, bytes);
      fs.chmodSync(target, Number.parseInt(record.mode, 8));
    } else {
      fs.copyFileSync(source, target);
    }
  }
}

/** Computes a path-bound digest so identical bytes at different package paths remain distinct. */
function fileDigest(root, relative) {
  return crypto.createHash("sha256").update(relative).update("\0").update(fs.readFileSync(path.join(root, relative))).digest("hex");
}

/** Computes one order-independent package digest from sorted path-bound file digests. */
function packageDigest(root, files) {
  const digest = crypto.createHash("sha256");
  for (const relative of [...files].sort()) digest.update(fileDigest(root, relative));
  return digest.digest("hex");
}

/** Computes the raw content digest used for the frozen Evidence implementation file. */
function rawFileDigest(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

/** Parses stable three-part SemVer into numeric components for compatibility comparison. */
function semverTuple(value, field) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(String(value || ""));
  if (!match) throw new Error(`Atlas installation ${field} must be stable SemVer`);
  return match.slice(1).map(Number);
}

/** Compares stable SemVer values and returns whether the installed Core meets the minimum. */
function semverAtLeast(actual, minimum) {
  const left = semverTuple(actual, "Atlas Core version");
  const right = semverTuple(minimum, "Evidence minimum Atlas Core version");
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return true;
}

/**
 * Records Evidence protocol identity separately from the Atlas package
 * digest so agents can compare schema compatibility without inferring it from
 * the Core SemVer. The exact implementation remains covered by both digests.
 */
function lockEvidenceContract(atlasRuntime, atlasVersion) {
  const release = readAtlasEvidenceRelease({ productRoot: path.join(atlasRuntime, "product") });
  const introducedIn = release.compatibility.atlasCore.introducedIn;
  if (!semverAtLeast(atlasVersion, introducedIn)) {
    throw new Error(`Atlas Core ${atlasVersion} predates frozen Evidence v2 compatibility ${introducedIn}`);
  }
  return {
    protocolSchema: release.protocolSchema,
    contractSchema: release.contractSchema,
    contractVersion: release.contractVersion,
    status: release.status,
    specificationDigest: release.specification.sha256,
    releaseRecordDigest: release.recordDigest,
    implementationDigest: rawFileDigest(path.join(atlasRuntime, "product", "evidence-contract.mjs")),
    atlasCore: {
      installedVersion: atlasVersion,
      introducedIn,
    },
    compatibility: release.compatibility,
  };
}

/** Verifies source intent and builds the immutable version, revision, and digest package lock. */
function lockPackage(sourceRoot, runtimeRoot, intent, files, packageName, distributionPackage = null) {
  const version = sourceVersion(sourceRoot, packageName);
  const revision = distributionPackage?.revision || sourceRevision(sourceRoot);
  if (version !== intent.version) {
    throw new Error(`${packageName} source version ${version} does not match manifest version ${intent.version}`);
  }
  if ((distributionPackage || intent.revision) && revision !== intent.revision) {
    throw new Error(`${packageName} source revision ${revision} does not match manifest revision ${intent.revision}`);
  }
  return {
    version,
    revision,
    digest: packageDigest(runtimeRoot, files),
    fileCount: files.length,
    files: [...files].sort(),
  };
}

/** Derives the installation lock path beside its tracked manifest authority. */
function lockPathForManifest(manifestPath) {
  return path.join(path.dirname(path.resolve(manifestPath)), "atlas.lock.json");
}

/** Writes formatted JSON through a same-directory staging file for atomic replacement. */
function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const staging = `${filePath}.writing-${process.pid}`;
  fs.writeFileSync(staging, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(staging, filePath);
}

/** Returns whether one PID still owns a process, including permission-denied signal probes. */
function processOwnsStaging(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** Removes only abandoned PID-addressed staging siblings owned by this runtime path. */
function removeAbandonedRuntimeStaging(runtimeRoot) {
  const parent = path.dirname(runtimeRoot);
  const prefix = `${path.basename(runtimeRoot)}.installing-`;
  if (!fs.existsSync(parent)) return;
  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const pidText = entry.name.slice(prefix.length);
    if (!/^\d+$/u.test(pidText)) continue;
    const pid = Number(pidText);
    if (pid === process.pid || processOwnsStaging(pid)) continue;
    fs.rmSync(path.join(parent, entry.name), { recursive: true, force: true });
  }
}

/**
 * installAtlasRuntime copies only product runtime files into a consumer-owned
 * path. It never copies Atlas memory, indexes, family bindings, or Git data.
 */
export function installAtlasRuntime(options = {}) {
  const root = path.resolve(requiredText(options.root, "root"));
  const manifestPath = path.resolve(requiredText(options.manifestPath, "manifestPath"));
  const atlasSource = path.resolve(requiredText(options.atlasSource, "atlasSource"));
  const graphSource = path.resolve(requiredText(options.graphSource, "graphSource"));
  const manifest = readAtlasInstallationManifest(manifestPath);
  const runtimeRoot = resolveInside(root, manifest.runtimePath, "runtimePath");
  const stateRoot = resolveInside(root, manifest.statePath, "statePath");
  const stagingRoot = `${runtimeRoot}.installing-${process.pid}`;
  const atlasRuntime = path.join(stagingRoot, "atlas");
  const graphRuntime = path.join(stagingRoot, "graph");
  // Explicit public provenance replaces Git as source authority for downloaded
  // archives. The development path continues to inspect the source checkouts.
  const distribution = options.distributionProvenancePath
    ? readAtlasDistributionProvenance({
      provenancePath: options.distributionProvenancePath,
      atlasSource,
      graphSource,
      allowDevelopmentProvenance: options.allowSourceChanges === true,
    })
    : null;
  const graphSelection = distribution
    ? { candidates: distribution.packages.graph.files, files: distribution.packages.graph.files }
    : graphRuntimeSelection(graphSource);
  const graphFiles = graphSelection.files;
  const distributionRecords = distribution
    ? new Map(distribution.files.map((record) => [record.path, record]))
    : null;

  const atlasChanges = distribution ? "" : sourceChanges(atlasSource, ATLAS_RUNTIME_FILES);
  const graphChanges = distribution ? "" : sourceChanges(graphSource, graphSelection.candidates);
  if (!options.allowSourceChanges && (atlasChanges || graphChanges)) {
    throw new Error("Atlas installation sources must match committed revisions; commit product runtime files or pass the explicit development override");
  }

  removeAbandonedRuntimeStaging(runtimeRoot);
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  try {
    fs.mkdirSync(atlasRuntime, { recursive: true });
    fs.mkdirSync(graphRuntime, { recursive: true });
    copyFiles(atlasSource, atlasRuntime, ATLAS_RUNTIME_FILES, distribution ? {
      distributionRoot: distribution.distributionRoot,
      distributionPrefix: "core",
      distributionRecords,
    } : {});
    copyFiles(graphSource, graphRuntime, graphFiles, distribution ? {
      distributionRoot: distribution.distributionRoot,
      distributionPrefix: "graph",
      distributionRecords,
    } : {});

    const lock = {
      schema: ATLAS_INSTALLATION_LOCK_SCHEMA,
      installationId: manifest.installationId,
      scope: manifest.scope,
      runtimePath: manifest.runtimePath,
      statePath: manifest.statePath,
      packages: {
        atlas: lockPackage(
          atlasSource,
          atlasRuntime,
          manifest.packages.atlas,
          ATLAS_RUNTIME_FILES,
          "atlas",
          distribution?.packages.atlas,
        ),
        graph: lockPackage(
          graphSource,
          graphRuntime,
          manifest.packages.graph,
          graphFiles,
          "graph",
          distribution?.packages.graph,
        ),
      },
      contracts: {
        evidence: lockEvidenceContract(atlasRuntime, manifest.packages.atlas.version),
      },
      repositoryIntegration: null,
      sourceState: distribution
        ? ([distribution.packages.atlas, distribution.packages.graph].every((component) => component.reviewState === "reviewed")
          ? "reviewed-distribution"
          : "development-distribution")
        : (atlasChanges || graphChanges ? "development-override" : "committed"),
    };

    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    fs.renameSync(stagingRoot, runtimeRoot);
    fs.mkdirSync(stateRoot, { recursive: true });
    writeJsonAtomic(lockPathForManifest(manifestPath), lock);
    return { manifest, lock, runtimeRoot, stateRoot, lockPath: lockPathForManifest(manifestPath) };
  } catch (error) {
    // A rejected source revision or copy/lock failure must not leave a second
    // runtime-looking tree that later tools or humans could mistake for state.
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

/** Verifies installed files, package intent, digests, and the frozen Evidence contract lock. */
export function verifyAtlasInstallation(options = {}) {
  const root = path.resolve(requiredText(options.root, "root"));
  const manifestPath = path.resolve(requiredText(options.manifestPath, "manifestPath"));
  const manifest = readAtlasInstallationManifest(manifestPath);
  const lockPath = lockPathForManifest(manifestPath);
  if (!fs.existsSync(lockPath)) throw new Error(`Atlas installation lock is missing: ${lockPath}`);
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  if (lock.schema !== ATLAS_INSTALLATION_LOCK_SCHEMA) throw new Error("Atlas installation lock schema is invalid");
  if (lock.installationId !== manifest.installationId || lock.scope !== manifest.scope) {
    throw new Error("Atlas installation lock identity does not match manifest");
  }
  const runtimeRoot = resolveInside(root, manifest.runtimePath, "runtimePath");
  const failures = [];
  for (const packageName of ["atlas", "graph"]) {
    const packageLock = lock.packages?.[packageName];
    const packageIntentValue = manifest.packages[packageName];
    const packageRoot = path.join(runtimeRoot, packageName);
    const files = Array.isArray(packageLock?.files) ? packageLock.files : [];
    const missing = files.filter((relative) => !fs.existsSync(path.join(packageRoot, relative)));
    const digest = missing.length ? "" : packageDigest(packageRoot, files);
    const intentMismatch = packageLock?.version !== packageIntentValue.version
      || (packageIntentValue.revision && packageLock?.revision !== packageIntentValue.revision);
    if (missing.length || digest !== packageLock?.digest || intentMismatch) {
      failures.push({
        package: packageName,
        missing,
        expectedDigest: packageLock?.digest || "",
        actualDigest: digest,
        expectedVersion: packageIntentValue.version,
        actualVersion: packageLock?.version || "",
        expectedRevision: packageIntentValue.revision,
        actualRevision: packageLock?.revision || "",
      });
    }
  }
  try {
    const actualEvidence = lockEvidenceContract(
      path.join(runtimeRoot, "atlas"),
      manifest.packages.atlas.version,
    );
    if (JSON.stringify(actualEvidence) !== JSON.stringify(lock.contracts?.evidence || null)) {
      failures.push({
        package: "atlas-evidence",
        expectedContract: lock.contracts?.evidence || null,
        actualContract: actualEvidence,
      });
    }
  } catch (error) {
    failures.push({
      package: "atlas-evidence",
      error: String(error?.message || error),
    });
  }
  return {
    schema: "multihead-atlas.installation_verification.v1",
    status: failures.length ? "fail" : "pass",
    installationId: manifest.installationId,
    scope: manifest.scope,
    runtimeRoot,
    stateRoot: resolveInside(root, manifest.statePath, "statePath"),
    packages: lock.packages,
    contracts: lock.contracts,
    failures,
  };
}

/** Installs Graph's exact locked dependencies without allowing package lifecycle scripts. */
export function installGraphDependencies(runtimeRoot) {
  const graphRoot = path.join(path.resolve(runtimeRoot), "graph");
  const result = childProcess.spawnSync("npm", ["ci", "--ignore-scripts"], {
    cwd: graphRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(`Memory Graph dependency installation failed: ${result.stderr.trim()}`);
  return graphRoot;
}
