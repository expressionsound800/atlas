/*
 * Instance Contract owns the path-neutral binding between one consumer
 * repository and the installed Atlas product runtime. Consumer repositories
 * own source selection and durable memory; this module owns validated instance
 * configuration, bounded source discovery, default catalog generation, and
 * repository-local index/Graph projections. It does not select family routes,
 * discover sibling repositories, invoke Git, or write consumer memory.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  canonicalAtlasGenerationJson,
  defaultAtlasGenerationConfig,
  loadCurrentAtlasGenerationArtifacts,
  validateAtlasGenerationConfig,
} from "./generation-provider.mjs";
import { createAtlasRepositoryProvider } from "./repository-provider.mjs";

export const ATLAS_INSTANCE_SCHEMA = "multihead-atlas.instance.v1";
export const ATLAS_INSTANCE_CATALOG_SCHEMA = "multihead-atlas.instance_catalog.v1";
export const ATLAS_INSTANCE_GRAPH_SCHEMA = "multihead-atlas.instance_graph.v1";

const REPOSITORY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const DEFAULT_TEXT_EXTENSIONS = Object.freeze([".json", ".md", ".toml", ".txt", ".yaml", ".yml"]);
const REQUIRED_EXCLUDES = Object.freeze([
  ".atlas",
  ".git",
  "archive",
  "build",
  "certificates",
  "dist",
  "node_modules",
  "target",
]);
const OVERVIEW_DOCUMENTATION_LIMIT = 6;
const OVERVIEW_SOURCE_CLASS_LIMITS = Object.freeze({
  "source-module": 18,
  configuration: 4,
  "repository-source": 4,
});
const DRILLDOWN_DETAIL_LIMIT = 10;
const DRILLDOWN_DIRECT_RELATIONSHIP_LIMIT = 8;
const ORIENTATION_SOURCE_LIMIT = 24;
const ORIENTATION_BYTE_LIMIT = 224 * 1024;

/** Validates one required instance field and enforces its contract-specific length bound. */
function requiredText(value, field, maxLength = 4096) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`Atlas instance requires ${field}`);
  if (text.length > maxLength) throw new Error(`Atlas instance ${field} is too long`);
  return text;
}

/** Rejects configuration keys outside the explicit schema allowlist for one object. */
function rejectUnexpectedKeys(value, allowed, field) {
  for (const key of Object.keys(value || {})) {
    if (!allowed.has(key)) throw new Error(`Atlas instance ${field} contains unexpected field ${key}`);
  }
}

/** Normalizes and validates the repository identity used across catalog, Graph, and sync. */
function repositoryId(value) {
  const id = requiredText(value, "repositoryId", 128).toLowerCase();
  if (!REPOSITORY_ID_PATTERN.test(id)) {
    throw new Error("Atlas instance repositoryId must be a path-safe lowercase slug");
  }
  return id;
}

/** Converts a path-safe repository id into the instance name shown by Atlas and Graph. */
function repositoryDisplayLabel(value) {
  return String(value || "")
    .replace(/[-_.]+/gu, " ")
    .replace(/\b\p{L}/gu, (character) => character.toUpperCase())
    .trim();
}

/** Converts platform path separators to the portable representation stored in instance data. */
function posixPath(value) {
  return String(value || "").replace(/\\/gu, "/");
}

/** Validates a required consumer-relative path without permitting parent traversal or absolutes. */
function relativePath(value, field) {
  const normalized = posixPath(path.normalize(requiredText(value, field))).replace(/^\.\//u, "");
  if (path.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Atlas instance ${field} must stay inside the consumer repository`);
  }
  return normalized;
}

/** Validates an optional consumer-relative path while preserving an explicit empty setting. */
function optionalRelativePath(value, field) {
  const text = String(value || "").trim();
  return text ? relativePath(text, field) : "";
}

/** Normalizes, deduplicates, and sorts a configured list of consumer-relative paths. */
function uniqueRelativePaths(values, field) {
  if (!Array.isArray(values)) throw new Error(`Atlas instance ${field} must be an array`);
  return [...new Set(values.map((value, index) => relativePath(value, `${field}[${index}]`)))].sort();
}

/** Validates an integer resource bound against the instance schema's safe range. */
function boundedInteger(value, field, minimum, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`Atlas instance ${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

/** Resolves a strict child path and rejects the root itself or any escaping relation. */
function pathInside(root, relative, field) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  const relation = path.relative(resolvedRoot, resolved);
  if (!relation || relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error(`Atlas instance ${field} must name a child of the consumer repository`);
  }
  return resolved;
}

/** Normalizes the explicit lowercase extension allowlist used by bounded source discovery. */
function normalizedExtensions(values) {
  if (!Array.isArray(values) || !values.length) throw new Error("Atlas instance source.extensions must be a non-empty array");
  return [...new Set(values.map((value) => {
    const extension = requiredText(value, "source extension", 24).toLowerCase();
    if (!/^\.[a-z0-9]+$/u.test(extension)) throw new Error(`Atlas instance source extension is invalid: ${extension}`);
    return extension;
  }))].sort();
}

/** Builds the conservative repository-local instance configuration for a new consumer. */
export function defaultAtlasInstanceConfig(options = {}) {
  const id = repositoryId(options.repositoryId);
  return Object.freeze({
    schema: ATLAS_INSTANCE_SCHEMA,
    repositoryId: id,
    source: Object.freeze({
      include: Object.freeze(["AGENTS.md", "README.md", "docs", "memory"]),
      exclude: Object.freeze([...REQUIRED_EXCLUDES]),
      extensions: Object.freeze([...DEFAULT_TEXT_EXTENSIONS]),
      maxDepth: 6,
      maxFiles: 512,
      maxFileBytes: 131072,
    }),
    indexPath: ".atlas/state/architecture-atlas.sqlite",
    adapter: Object.freeze({ module: "", exportName: "buildAtlasCatalog" }),
    generation: defaultAtlasGenerationConfig(),
    graph: Object.freeze({ defaultRoom: id, providerCommand: "" }),
    sync: Object.freeze({
      namespace: "repository-memory-record",
      exchangePath: ".atlas/state/sync-exchange",
    }),
  });
}

/** Validates and freezes the complete consumer-owned Atlas instance configuration contract. */
export function validateAtlasInstanceConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Atlas instance configuration must be an object");
  }
  rejectUnexpectedKeys(value, new Set(["schema", "repositoryId", "source", "indexPath", "adapter", "generation", "graph", "sync"]), "configuration");
  if (value.schema !== ATLAS_INSTANCE_SCHEMA) {
    throw new Error(`Atlas instance schema must be ${ATLAS_INSTANCE_SCHEMA}`);
  }
  if (!value.source || typeof value.source !== "object" || Array.isArray(value.source)) {
    throw new Error("Atlas instance requires source configuration");
  }
  rejectUnexpectedKeys(value.source, new Set(["include", "exclude", "extensions", "maxDepth", "maxFiles", "maxFileBytes"]), "source configuration");
  const include = uniqueRelativePaths(value.source.include, "source.include");
  if (!include.length) throw new Error("Atlas instance source.include must not be empty");
  const exclude = [...new Set([
    ...REQUIRED_EXCLUDES,
    ...uniqueRelativePaths(value.source.exclude || [], "source.exclude"),
  ])].sort();
  const adapter = value.adapter || { module: "", exportName: "buildAtlasCatalog" };
  if (typeof adapter !== "object" || Array.isArray(adapter)) {
    throw new Error("Atlas instance adapter configuration must be an object");
  }
  rejectUnexpectedKeys(adapter, new Set(["module", "exportName"]), "adapter configuration");
  if (!value.graph || typeof value.graph !== "object" || Array.isArray(value.graph)) {
    throw new Error("Atlas instance requires graph configuration");
  }
  rejectUnexpectedKeys(value.graph, new Set(["defaultRoom", "providerCommand"]), "graph configuration");
  if (!value.sync || typeof value.sync !== "object" || Array.isArray(value.sync)) {
    throw new Error("Atlas instance requires sync configuration");
  }
  rejectUnexpectedKeys(value.sync, new Set(["namespace", "exchangePath"]), "sync configuration");
  return Object.freeze({
    schema: value.schema,
    repositoryId: repositoryId(value.repositoryId),
    source: Object.freeze({
      include: Object.freeze(include),
      exclude: Object.freeze(exclude),
      extensions: Object.freeze(normalizedExtensions(value.source.extensions || DEFAULT_TEXT_EXTENSIONS)),
      maxDepth: boundedInteger(value.source.maxDepth, "source.maxDepth", 0, 32),
      maxFiles: boundedInteger(value.source.maxFiles, "source.maxFiles", 1, 10000),
      maxFileBytes: boundedInteger(value.source.maxFileBytes, "source.maxFileBytes", 1024, 16 * 1024 * 1024),
    }),
    indexPath: relativePath(value.indexPath, "indexPath"),
    adapter: Object.freeze({
      module: optionalRelativePath(adapter.module, "adapter.module"),
      exportName: requiredText(adapter.exportName || "buildAtlasCatalog", "adapter.exportName", 128),
    }),
    generation: validateAtlasGenerationConfig(value.generation || defaultAtlasGenerationConfig()),
    graph: Object.freeze({
      defaultRoom: repositoryId(value.graph.defaultRoom),
      providerCommand: optionalRelativePath(value.graph.providerCommand, "graph.providerCommand"),
    }),
    sync: Object.freeze({
      namespace: requiredText(value.sync.namespace, "sync.namespace", 256),
      exchangePath: relativePath(value.sync.exchangePath, "sync.exchangePath"),
    }),
  });
}

/** Reads a tracked instance file and returns only its validated normalized representation. */
export function readAtlasInstanceConfig(instancePath) {
  const resolved = path.resolve(requiredText(instancePath, "instance path"));
  return validateAtlasInstanceConfig(JSON.parse(fs.readFileSync(resolved, "utf8")));
}

/**
 * Rewrites only the tracked generation binding through the complete instance
 * validator. Credentials remain outside the file and every other normalized
 * instance field retains its existing authority.
 */
export function writeAtlasInstanceGenerationConfig(options = {}) {
  const instancePath = path.resolve(requiredText(options.instancePath, "instance path"));
  const source = JSON.parse(fs.readFileSync(instancePath, "utf8"));
  const instance = validateAtlasInstanceConfig({ ...source, generation: options.generation });
  const staging = `${instancePath}.writing-${process.pid}`;
  fs.writeFileSync(staging, `${JSON.stringify(instance, null, 2)}\n`, "utf8");
  fs.renameSync(staging, instancePath);
  return instance;
}

/** Resolves runtime index and sync exchange paths from one validated repository instance. */
export function atlasInstancePaths(options = {}) {
  const root = path.resolve(requiredText(options.root, "root"));
  const instancePath = path.resolve(options.instancePath || path.join(root, ".atlas", "atlas.instance.json"));
  const instance = options.instance || readAtlasInstanceConfig(instancePath);
  const configuredExchange = String(options.exchangeRoot || process.env.ATLAS_SYNC_EXCHANGE_ROOT || "").trim();
  const exchangeRoot = configuredExchange
    ? path.resolve(configuredExchange)
    : pathInside(root, instance.sync.exchangePath, "sync.exchangePath");
  return Object.freeze({
    root,
    instancePath,
    indexPath: pathInside(root, instance.indexPath, "indexPath"),
    exchangeRoot,
  });
}

/** Checks whether a scanned path equals or descends from a configured exclusion prefix. */
function isExcluded(relative, excludes) {
  return excludes.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`));
}

/** Computes deterministic source and catalog identity digests from UTF-8 content. */
function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Normalizes source-derived prose into one bounded catalog-safe text value. */
function compact(value, maxLength = 900) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

/** Removes Markdown/HTML decoration and keeps the terminal breadcrumb segment as a room label. */
function normalizeMarkdownHeading(value) {
  const normalized = String(value)
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/<[^>]*>/gu, " ")
    .replace(/`+/gu, "")
    .replace(/:[a-z0-9_+-]+:/giu, " ")
    .replace(/[ \t]+#+[ \t]*$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  const breadcrumbs = normalized.split(/\s*→\s*/u).map((part) => part.trim()).filter(Boolean);
  return compact(breadcrumbs[breadcrumbs.length - 1] || normalized, 96);
}

/** Finds the first real ATX heading while excluding HTML comments and fenced examples. */
function firstMarkdownHeading(text) {
  const uncommented = String(text).replace(/<!--[\s\S]*?(?:-->|$)/gu, "");
  let fenceCharacter = "";
  for (const line of uncommented.split(/\r?\n/gu)) {
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/u)?.[1] || "";
    if (fence) {
      if (!fenceCharacter) fenceCharacter = fence[0];
      else if (fence[0] === fenceCharacter) fenceCharacter = "";
      continue;
    }
    if (fenceCharacter) continue;
    const heading = line.match(/^\s{0,3}#{1,6}[ \t]+(.+)$/u)?.[1] || "";
    if (heading) return normalizeMarkdownHeading(heading);
  }
  return "";
}

/** Derives Markdown room labels from visible headings and all other labels from the source filename. */
function titleFromPath(relative, text) {
  const heading = path.extname(relative).toLowerCase() === ".md" ? firstMarkdownHeading(text) : "";
  if (heading) return heading;
  return path.basename(relative, path.extname(relative)).replace(/[-_]+/gu, " ");
}

/**
 * Scans sources within configured resource bounds and never follows symbolic
 * links. Excluded paths are rejected before file reads so generated runtime,
 * credentials, archives, and configured consumer-private opt-outs cannot become index
 * input through a nested include directory.
 */
export function scanAtlasInstanceSources(options = {}) {
  const root = path.resolve(requiredText(options.root, "root"));
  const instance = options.instance || readAtlasInstanceConfig(options.instancePath || path.join(root, ".atlas", "atlas.instance.json"));
  const extensions = new Set(instance.source.extensions);
  const files = new Map();
  const diagnostics = [];

  /** Adds one eligible regular text file to the digest-bearing scan result. */
  const addFile = (absolute, relative) => {
    if (files.size >= instance.source.maxFiles) {
      throw new Error(`Atlas instance source scan exceeds maxFiles=${instance.source.maxFiles}`);
    }
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      diagnostics.push({ code: "symbolic-link-skipped", path: relative });
      return;
    }
    if (!stat.isFile() || !extensions.has(path.extname(relative).toLowerCase())) return;
    if (stat.size > instance.source.maxFileBytes) {
      diagnostics.push({ code: "oversize-file-skipped", path: relative, bytes: stat.size });
      return;
    }
    const text = fs.readFileSync(absolute, "utf8");
    files.set(relative, Object.freeze({
      path: relative,
      bytes: stat.size,
      digest: sha256(text),
      title: titleFromPath(relative, text),
      text,
    }));
  };

  /** Traverses an admitted source subtree without crossing depth or exclusion boundaries. */
  const visit = (absolute, depth) => {
    const relative = posixPath(path.relative(root, absolute));
    if (!relative || isExcluded(relative, instance.source.exclude)) return;
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      diagnostics.push({ code: "symbolic-link-skipped", path: relative });
      return;
    }
    if (stat.isFile()) {
      addFile(absolute, relative);
      return;
    }
    if (!stat.isDirectory() || depth >= instance.source.maxDepth) return;
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      visit(path.join(absolute, entry.name), depth + 1);
    }
  };

  for (const include of instance.source.include) {
    const absolute = pathInside(root, include, "source.include");
    if (!fs.existsSync(absolute)) {
      diagnostics.push({ code: "include-missing", path: include });
      continue;
    }
    visit(absolute, 0);
  }
  const rows = [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
  return Object.freeze({
    schema: "multihead-atlas.instance_source_scan.v1",
    repositoryId: instance.repositoryId,
    files: Object.freeze(rows),
    diagnostics: Object.freeze(diagnostics),
    metrics: Object.freeze({ files: rows.length, bytes: rows.reduce((total, file) => total + file.bytes, 0) }),
  });
}

/** Binds repository learning freshness to every admitted source path and digest without embedding full source content. */
export function buildAtlasRepositoryInventory(scan) {
  const rows = scan.files.map((file) => [file.path, file.digest]);
  return Object.freeze({
    algorithm: "sha256-path-digest-v1",
    digest: sha256(JSON.stringify(rows)),
    sourceCount: rows.length,
  });
}

/** Derives a stable repository-scoped room identifier without exposing the source path. */
function roomIdForSource(repositoryIdValue, relative) {
  return `source-${sha256(`${repositoryIdValue}\0${relative}`).slice(0, 20)}`;
}

/** Classifies a scanned source by syntax family without assigning product-specific meaning. */
function sourceClassForPath(relative) {
  const extension = path.extname(relative).toLowerCase();
  if ([".md", ".txt"].includes(extension)) return "documentation";
  if ([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".rs", ".py", ".go", ".java", ".swift"].includes(extension)) {
    return "source-module";
  }
  if ([".json", ".toml", ".yaml", ".yml"].includes(extension)) return "configuration";
  return "repository-source";
}

/** Derives one stable structural group from at most two observed parent-directory segments. */
function sourceGroupForPath(repositoryIdValue, relative) {
  const directory = path.posix.dirname(posixPath(relative));
  const segments = directory === "." ? [] : directory.split("/").filter(Boolean);
  const groupPath = segments.length ? segments.slice(0, 2).join("/") : ".";
  const label = groupPath === "."
    ? "Repository Root"
    : groupPath.split("/").map((segment) => segment.replace(/[-_]+/gu, " ")).join(" / ");
  return Object.freeze({
    id: `source-group-${sha256(`${repositoryIdValue}\0${groupPath}`).slice(0, 16)}`,
    path: groupPath,
    label,
  });
}

/** Removes Python comments without treating hash characters inside quoted strings as comments. */
function stripPythonComment(line) {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "#") return line.slice(0, index);
  }
  return line;
}

/** Extracts bounded local module, Python import, and Markdown reference specifiers. */
function localReferenceSpecifiers(file) {
  const extension = path.extname(file.path).toLowerCase();
  const references = [];
  const seen = new Set();
  /** Records one local reference once while preserving the syntax-derived relationship kind. */
  const add = (specifier, kind, label, resolver = "relative") => {
    const value = String(specifier || "").trim().replace(/^<|>$/gu, "").split(/[?#]/u)[0];
    if ((!value.startsWith(".") && resolver !== "python") || seen.has(`${kind}\0${resolver}\0${value}`)) return;
    seen.add(`${kind}\0${resolver}\0${value}`);
    references.push(Object.freeze({ specifier: value, kind, label, resolver }));
  };
  if ([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"].includes(extension)) {
    const pattern = /\b(?:import|export)\s+(?:[^"'`]*?\s+from\s*)?["']([^"']+)["']|\brequire\(\s*["']([^"']+)["']\s*\)|\bimport\(\s*["']([^"']+)["']\s*\)/gu;
    for (const match of file.text.matchAll(pattern)) add(match[1] || match[2] || match[3], "source_import", "imports");
  }
  if (extension === ".md") {
    const pattern = /!?\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+["'][^)]*)?\)/gu;
    for (const match of file.text.matchAll(pattern)) add(match[1], "source_link", "links");
  }
  if (extension === ".py") {
    const source = file.text.split(/\r?\n/gu).map(stripPythonComment).join("\n");
    const fromPattern = /(?:^|\n)\s*from\s+([.a-zA-Z_][.a-zA-Z0-9_]*)\s+import\s+([^\n]+)/gu;
    for (const match of source.matchAll(fromPattern)) {
      const moduleName = match[1];
      add(moduleName, "source_import", "imports", "python");
      const importedNames = match[2]
        .replace(/[()]/gu, " ")
        .split(",")
        .map((name) => name.trim().split(/\s+as\s+/u)[0])
        .filter((name) => /^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(name));
      for (const importedName of importedNames) {
        const separator = moduleName.endsWith(".") ? "" : ".";
        add(`${moduleName}${separator}${importedName}`, "source_import", "imports", "python");
      }
    }
    const importPattern = /(?:^|\n)\s*import\s+([^\n]+)/gu;
    for (const match of source.matchAll(importPattern)) {
      for (const clause of match[1].split(",")) {
        const moduleName = clause.trim().split(/\s+as\s+/u)[0];
        if (/^[a-zA-Z_][.a-zA-Z0-9_]*$/u.test(moduleName)) {
          add(moduleName, "source_import", "imports", "python");
        }
      }
    }
  }
  return references.slice(0, 12);
}

/** Resolves a relative source reference only when it names another admitted scan file. */
function resolveLocalReference(fromPath, specifier, admittedPaths, extensions) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier));
  if (!base || base === ".." || base.startsWith("../") || path.posix.isAbsolute(base)) return "";
  const candidates = [base];
  if (!path.posix.extname(base)) {
    for (const extension of extensions) candidates.push(`${base}${extension}`);
    for (const extension of extensions) candidates.push(path.posix.join(base, `index${extension}`));
  }
  return candidates.find((candidate) => candidate !== fromPath && admittedPaths.has(candidate)) || "";
}

/** Resolves relative and unambiguous package-qualified Python modules to admitted `.py` sources only. */
function resolvePythonReference(fromPath, specifier, admittedPaths) {
  const dots = specifier.match(/^\.+/u)?.[0].length || 0;
  const moduleName = specifier.slice(dots).replace(/\./gu, "/");
  /** Returns one admitted candidate only when the requested module identity is unambiguous. */
  const uniqueCandidate = (candidates) => {
    const admitted = [...new Set(candidates)]
      .filter((candidate) => candidate !== fromPath && admittedPaths.has(candidate));
    return admitted.length === 1 ? admitted[0] : "";
  };
  if (dots) {
    let packagePath = path.posix.dirname(fromPath);
    for (let level = 1; level < dots; level += 1) packagePath = path.posix.dirname(packagePath);
    const base = moduleName ? path.posix.join(packagePath, moduleName) : packagePath;
    return uniqueCandidate([`${base}.py`, path.posix.join(base, "__init__.py")]);
  }
  if (!moduleName) return "";

  // A repository-root module is an exact Python import target regardless of
  // whether another nested package happens to share its basename.
  const rootQualified = uniqueCandidate([`${moduleName}.py`, path.posix.join(moduleName, "__init__.py")]);
  if (rootQualified) return rootQualified;

  // Recognize a src-style current package only when __init__.py files establish
  // the package root and the absolute import names that same package. This
  // avoids guessing between unrelated vendor/source trees with matching names.
  let packageDirectory = path.posix.dirname(fromPath);
  let outermostPackage = "";
  while (packageDirectory && packageDirectory !== "." && admittedPaths.has(path.posix.join(packageDirectory, "__init__.py"))) {
    outermostPackage = packageDirectory;
    packageDirectory = path.posix.dirname(packageDirectory);
  }
  if (outermostPackage && moduleName.split("/")[0] === path.posix.basename(outermostPackage)) {
    const packageBase = path.posix.join(path.posix.dirname(outermostPackage), moduleName);
    const packageQualified = uniqueCandidate([`${packageBase}.py`, path.posix.join(packageBase, "__init__.py")]);
    if (packageQualified) return packageQualified;
  }

  const suffixMatches = [];
  for (const admitted of admittedPaths) {
    if (admitted === `${moduleName}.py`
      || admitted === path.posix.join(moduleName, "__init__.py")
      || admitted.endsWith(`/${moduleName}.py`)
      || admitted.endsWith(`/${moduleName}/__init__.py`)) {
      suffixMatches.push(admitted);
    }
  }
  return uniqueCandidate(suffixMatches);
}

/** Derives bounded deterministic source-to-source relationships from observed local references. */
function deriveAtlasInstanceSourceRelationships(scan) {
  const admittedPaths = new Set(scan.files.map((file) => file.path));
  const extensions = [...new Set(scan.files.map((file) => path.extname(file.path).toLowerCase()).filter(Boolean))].sort();
  const relationships = [];
  const seen = new Set();
  const limit = Math.min(256, Math.max(32, scan.files.length * 10));
  for (const file of scan.files) {
    for (const reference of localReferenceSpecifiers(file)) {
      const targetPath = reference.resolver === "python"
        ? resolvePythonReference(file.path, reference.specifier, admittedPaths)
        : resolveLocalReference(file.path, reference.specifier, admittedPaths, extensions);
      const key = `${file.path}\0${targetPath}\0${reference.kind}`;
      if (!targetPath || seen.has(key)) continue;
      seen.add(key);
      relationships.push(Object.freeze({
        fromPath: file.path,
        toPath: targetPath,
        kind: reference.kind,
        label: reference.label,
        specifier: reference.specifier,
      }));
      if (relationships.length >= limit) return Object.freeze(relationships);
    }
  }
  return Object.freeze(relationships);
}

/**
 * Selects a deterministic orientation packet from admitted sources. The score
 * favors declared entry documents, manifests, execution entry points, tests,
 * and locally connected modules while retaining strict source and byte caps.
 */
export function selectAtlasRepositoryOrientationSources(options = {}) {
  const scan = options.scan || scanAtlasInstanceSources(options);
  const relationships = deriveAtlasInstanceSourceRelationships(scan);
  const degrees = new Map();
  for (const relationship of relationships) {
    degrees.set(relationship.fromPath, (degrees.get(relationship.fromPath) || 0) + 1);
    degrees.set(relationship.toPath, (degrees.get(relationship.toPath) || 0) + 1);
  }
  const manifestNames = new Set(["cargo.toml", "go.mod", "package.json", "pyproject.toml", "pom.xml", "build.gradle", "composer.json"]);
  const entryNames = new Set(["main", "index", "app", "cli", "server", "__main__", "lib", "mod"]);
  /** Assigns one source-neutral orientation score without inferring repository semantics. */
  const score = (file) => {
    const lowerPath = file.path.toLowerCase();
    const basename = path.posix.basename(lowerPath);
    const stem = path.posix.basename(lowerPath, path.posix.extname(lowerPath));
    let value = (degrees.get(file.path) || 0) * 40;
    if (basename === "readme.md") value += 1200;
    if (/(^|\/)(architecture|design|overview)([._-]|\/|$)/u.test(lowerPath)) value += 1050;
    if (manifestNames.has(basename)) value += 1000;
    if (entryNames.has(stem)) value += 800;
    if (/(^|\/)(test|tests|spec|specs)(\/|$)/u.test(lowerPath)) value += 500;
    if ([".md", ".txt"].includes(path.posix.extname(lowerPath))) value += 300;
    value += Math.max(0, 100 - file.path.split("/").length * 10);
    return value;
  };
  const ranked = [...scan.files].sort((left, right) => score(right) - score(left) || left.path.localeCompare(right.path));
  const sources = [];
  const selectedPaths = new Set();
  let bytes = 0;
  /** Adds one ranked category within its reserved cap and the shared content budget. */
  const select = (candidates, maximum) => {
    let added = 0;
    for (const file of candidates) {
      if (added >= maximum || sources.length >= ORIENTATION_SOURCE_LIMIT) break;
      if (selectedPaths.has(file.path)) continue;
      const sourceBytes = Buffer.byteLength(file.text, "utf8");
      if (bytes + sourceBytes > ORIENTATION_BYTE_LIMIT) continue;
      sources.push(file);
      selectedPaths.add(file.path);
      bytes += sourceBytes;
      added += 1;
    }
  };
  /** Returns true when an admitted path is structurally located in a test/spec subtree. */
  const isTest = (file) => /(^|\/)(test|tests|spec|specs)(\/|$)/u.test(file.path.toLowerCase());
  /** Returns true when an admitted source uses one of the default prose extensions. */
  const isDocumentation = (file) => [".md", ".txt"].includes(path.posix.extname(file.path).toLowerCase());
  /** Returns true when an admitted source basename is a recognized build/package manifest. */
  const isManifest = (file) => manifestNames.has(path.posix.basename(file.path).toLowerCase());
  /** Returns true when an admitted source stem is a conventional execution or library entry point. */
  const isEntrypoint = (file) => entryNames.has(path.posix.basename(file.path, path.posix.extname(file.path)).toLowerCase());
  /** Returns true for executable source modules outside structurally identified test subtrees. */
  const isProduction = (file) => sourceClassForPath(file.path) === "source-module" && !isTest(file);
  /** Groups production evidence by its observed package/directory, without assigning a semantic role. */
  const productionGroup = (file) => path.posix.dirname(file.path);
  const productionGroups = new Map();
  for (const file of ranked.filter(isProduction)) {
    const group = productionGroup(file);
    const groupFiles = productionGroups.get(group) || [];
    groupFiles.push(file);
    productionGroups.set(group, groupFiles);
  }
  const groupLeaders = [...productionGroups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([_group, files]) => files[0])
    .sort((left, right) => score(right) - score(left) || left.path.localeCompare(right.path));
  const roundRobinProduction = [];
  const longestGroup = Math.max(0, ...[...productionGroups.values()].map((files) => files.length));
  for (let offset = 1; offset < longestGroup; offset += 1) {
    for (const [_group, files] of [...productionGroups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      if (files[offset]) roundRobinProduction.push(files[offset]);
    }
  }
  /** Adds ranked production candidates only until the packet reaches the requested production quota. */
  const selectProductionToQuota = (candidates, quota) => {
    const remaining = Math.max(0, quota - sources.filter(isProduction).length);
    if (remaining) select(candidates, remaining);
  };
  select(ranked.filter(isManifest), 3);
  select(ranked.filter(isDocumentation), 4);
  select(ranked.filter((file) => isEntrypoint(file) && !isTest(file)), 4);
  selectProductionToQuota(groupLeaders, 14);
  selectProductionToQuota(roundRobinProduction, 14);
  selectProductionToQuota(ranked.filter(isProduction), 14);
  select(ranked.filter(isTest), 3);
  select(ranked.filter(isProduction), ORIENTATION_SOURCE_LIMIT);
  for (const file of ranked) {
    if (sources.length >= ORIENTATION_SOURCE_LIMIT) break;
    if (selectedPaths.has(file.path)
      || (isTest(file) && sources.filter(isTest).length >= 4)
      || (isDocumentation(file) && sources.filter(isDocumentation).length >= 6)) continue;
    const sourceBytes = Buffer.byteLength(file.text, "utf8");
    if (bytes + sourceBytes > ORIENTATION_BYTE_LIMIT) continue;
    sources.push(file);
    selectedPaths.add(file.path);
    bytes += sourceBytes;
  }
  if (!sources.length && ranked.length) sources.push(ranked[0]);
  return Object.freeze({
    schema: "multihead-atlas.repository_orientation.v1",
    repositoryId: scan.repositoryId,
    selectionPolicy: "entry-documents-manifests-entrypoints-tests-connectivity-v1",
    repositoryInventory: buildAtlasRepositoryInventory(scan),
    sources: Object.freeze(sources),
    sourcePaths: Object.freeze(sources.map((source) => source.path)),
    metrics: Object.freeze({
      admittedSources: scan.files.length,
      selectedSources: sources.length,
      selectedBytes: sources.reduce((total, source) => total + Buffer.byteLength(source.text, "utf8"), 0),
      observedLocalRelationships: relationships.length,
      selectedProductionModules: sources.filter(isProduction).length,
      selectedProductionGroups: new Set(sources.filter(isProduction).map(productionGroup)).size,
      selectedTests: sources.filter(isTest).length,
    }),
  });
}

/**
 * Builds one retrieval record with explicit Graph navigation semantics. Source
 * evidence stays searchable but cannot become an architecture room unless a
 * validated repository-system-model owns that semantic target.
 */
function room(options) {
  const generated = String(options.generatedSummary || "").trim();
  const navigationKind = options.navigationKind || "none";
  const graphAvailable = navigationKind === "room-entry";
  const sourceModel = options.roomGraphSourceModel || "multihead-atlas-source-inventory-v1";
  return Object.freeze({
    id: options.id,
    label: options.label,
    owner: options.owner,
    viewpoint: options.viewpoint,
    summary: options.summary,
    generatedSummary: generated || options.summary,
    summaryStatus: generated ? "generated" : "source-derived",
    summarySource: generated ? options.generationProvider : "multihead-atlas-default-repository-adapter",
    summaryUpdatedAt: "",
    summaryDigest: generated ? sha256(generated) : options.digest,
    freshnessStatus: "source-digest-current",
    freshnessDigest: options.freshnessDigest || options.digest,
    sourceRepos: Object.freeze([options.owner]),
    facets: Object.freeze(options.facets),
    answers: Object.freeze(options.answers),
    authorityScore: options.authorityScore,
    freshnessScore: 1,
    indexRefs: Object.freeze({
      lexical: `atlas_instance_summary:${options.id}`,
      vector: `atlas_instance_vector:${options.id}`,
    }),
    vectorStatus: "indexed",
    metadata: Object.freeze({
      graphEndpoint: graphAvailable ? `/api/architecture-graph?slice=${encodeURIComponent(options.id.toUpperCase())}` : "",
      entryKind: options.entryKind || "source-evidence",
      navigationKind,
      roomGraphStatus: graphAvailable ? "available" : "unavailable",
      roomGraphSourceModel: sourceModel,
      roomGraphFreshnessStatus: graphAvailable ? "source-digest-current" : "",
      ...(options.metadata || {}),
    }),
  });
}

/**
 * Builds one catalog containing raw source evidence and, when current, the
 * separately learned semantic model. Raw files never receive semantic-room
 * navigation; the system model is the sole default-adapter authority for
 * architecture rooms and directed architecture relationships.
 */
export function buildAtlasInstanceCatalog(options = {}) {
  const root = path.resolve(requiredText(options.root, "root"));
  const instance = options.instance || readAtlasInstanceConfig(options.instancePath || path.join(root, ".atlas", "atlas.instance.json"));
  const scan = scanAtlasInstanceSources({ root, instance });
  const repositoryInventory = buildAtlasRepositoryInventory(scan);
  const generation = loadCurrentAtlasGenerationArtifacts({ root, repositoryInventory });
  const workspaceSummary = generation.artifacts.find(({ result }) => result.artifact.kind === "workspace-entry-summary");
  const sourceSummaries = new Map(generation.artifacts
    .filter(({ result }) => result.artifact.kind === "source-summary")
    .map(({ result }) => [result.artifact.sources[0].path, result]));
  const specifications = generation.artifacts.filter(({ result }) => result.artifact.kind === "room-specification");
  const learned = generation.artifacts.find(({ result }) => result.artifact.kind === "repository-system-model") || null;
  const learnedModel = learned?.result.artifact.systemModel || null;
  const learnedSourceModel = learnedModel ? "multihead-atlas-repository-system-model-v1" : "multihead-atlas-source-inventory-v1";
  const learnedModelDigest = learnedModel ? sha256(canonicalAtlasGenerationJson(learnedModel)) : "";
  const sourceDigest = sha256(JSON.stringify(scan.files.map((file) => [file.path, file.digest])));
  const rootRoom = room({
    id: instance.repositoryId,
    label: learnedModel
      ? repositoryDisplayLabel(instance.repositoryId)
      : `${repositoryDisplayLabel(instance.repositoryId)} · Source Inventory`,
    owner: instance.repositoryId,
    viewpoint: learnedModel
      ? "learned source-backed repository system model under consumer repository authority"
      : "bounded repository source inventory awaiting a learned semantic model",
    summary: learnedModel
      ? learnedModel.repository.purpose
      : `${instance.repositoryId} exposes ${scan.files.length} bounded source-evidence records. Run atlas map before treating the Graph projection as repository architecture.`,
    generatedSummary: learned?.result.artifact.summary || workspaceSummary?.result.artifact.summary || "",
    generationProvider: learned?.result.provider.id || workspaceSummary?.result.provider.id || "",
    digest: sourceDigest,
    facets: ["repository", "atlas-instance", "memory", "retrieval", "graph", "sync"],
    answers: ["where this repository owns Atlas memory", "which installed Atlas instance serves this repository"],
    authorityScore: 1,
    entryKind: "repository-authority",
    navigationKind: "none",
    roomGraphSourceModel: learnedSourceModel,
    metadata: {
      workspacePath: ".",
      sourcePath: "",
      evidence: { kind: "repository-aggregate" },
      repositorySystemModelStatus: learnedModel ? "current" : "missing",
      repositorySystemModelConfidence: learnedModel?.repository.confidence ?? 0,
    },
  });
  const sourceRooms = scan.files.map((file) => {
    const generated = sourceSummaries.get(file.path);
    const sourceGroup = sourceGroupForPath(instance.repositoryId, file.path);
    return room({
      id: roomIdForSource(instance.repositoryId, file.path),
      label: file.title,
      owner: instance.repositoryId,
      viewpoint: `repository source record at ${file.path}`,
      summary: compact(`${file.title}. ${file.path}. ${file.text}`),
      generatedSummary: generated?.artifact.summary || "",
      generationProvider: generated?.provider.id || "",
      digest: file.digest,
      facets: ["repository-source", path.extname(file.path).slice(1) || "text"],
      answers: [`what ${file.path} records`, `where ${file.title} lives`],
      authorityScore: 0.8,
      entryKind: "source-evidence",
      navigationKind: "none",
      roomGraphSourceModel: "multihead-atlas-source-inventory-v1",
      metadata: {
        workspacePath: file.path,
        sourcePath: file.path,
        sourceRecordKind: "repository-source",
        sourceClass: sourceClassForPath(file.path),
        sourceGroup,
        evidence: {
          kind: "repository-source",
          sourceDigest: file.digest,
          sourceDigestAlgorithm: "sha256-utf8",
        },
      },
    });
  });
  const sourceRoomIdByPath = new Map(sourceRooms.map((sourceRoom) => [sourceRoom.metadata.sourcePath, sourceRoom.id]));
  const sourceRelationships = deriveAtlasInstanceSourceRelationships(scan);
  const occupiedRoomIds = new Set([rootRoom.id, ...sourceRooms.map(({ id }) => id)]);
  const specificationDiagnostics = [];
  const specificationRooms = specifications.flatMap(({ result }) => {
    const source = result.artifact.sources[0];
    const generatedRoomId = result.artifact.room.id;
    if (occupiedRoomIds.has(generatedRoomId)) {
      specificationDiagnostics.push(Object.freeze({
        code: "generation-room-id-conflict",
        roomId: generatedRoomId,
        path: source.path,
      }));
      return [];
    }
    // Reserve each admitted id as we iterate so two current artifacts cannot
    // silently produce duplicate catalog rooms even if their filenames differ.
    occupiedRoomIds.add(generatedRoomId);
    return [room({
      id: result.artifact.room.id,
      label: result.artifact.room.label,
      owner: instance.repositoryId,
      viewpoint: result.artifact.room.viewpoint,
      summary: result.artifact.summary,
      generatedSummary: result.artifact.summary,
      generationProvider: result.provider.id,
      digest: sha256(JSON.stringify(result.artifact)),
      freshnessDigest: source.digest,
      facets: result.artifact.room.facets,
      answers: result.artifact.room.answers,
      authorityScore: 0.75,
      entryKind: "source-evidence",
      navigationKind: "none",
      roomGraphSourceModel: "multihead-atlas-source-inventory-v1",
      metadata: {
        workspacePath: source.path,
        sourcePath: source.path,
        generationTask: "room-specification",
        evidence: {
          kind: "generation-source",
          sourceDigest: source.digest,
          sourceDigestAlgorithm: "sha256-utf8",
        },
      },
    })];
  });
  for (const component of learnedModel?.components || []) {
    if (occupiedRoomIds.has(component.id)) {
      throw new Error(`Atlas repository-system-model semantic room id conflicts with repository evidence: ${component.id}`);
    }
    occupiedRoomIds.add(component.id);
  }
  const semanticRooms = (learnedModel?.components || []).map((component) => {
    const primaryEvidence = component.evidence[0];
    const componentDigest = sha256(JSON.stringify(component));
    return room({
      id: component.id,
      label: component.label,
      owner: instance.repositoryId,
      viewpoint: component.viewpoint,
      summary: component.responsibility,
      generatedSummary: component.responsibility,
      generationProvider: learned.result.provider.id,
      digest: componentDigest,
      freshnessDigest: primaryEvidence.digest,
      facets: component.facets,
      answers: component.answers,
      authorityScore: Math.max(0.5, component.confidence),
      entryKind: "semantic-room",
      navigationKind: "room-entry",
      roomGraphSourceModel: learnedSourceModel,
      metadata: {
        workspacePath: primaryEvidence.path,
        sourcePath: primaryEvidence.path,
        semanticRegion: component.region,
        semanticConfidence: component.confidence,
        semanticEvidence: component.evidence,
        repositorySystemModelDigest: learnedModelDigest,
        repositorySystemModelResultDigest: learned.resultDigest,
        repositorySystemModelRequestDigest: learned.request.requestDigest,
        evidence: {
          kind: "repository-system-model",
          sourceDigest: primaryEvidence.digest,
          sourceDigestAlgorithm: "sha256-utf8",
        },
      },
    });
  });
  const semanticRoomPortals = semanticRooms.map((semanticRoom) => Object.freeze({
    id: `${instance.repositoryId}:opens_room:${semanticRoom.id}`,
    fromRoomId: instance.repositoryId,
    toRoomId: semanticRoom.id,
    label: "opens room",
    kind: "opens_room",
    traversalCost: 1,
    bidirectional: false,
    reason: `${instance.repositoryId} opens learned semantic room ${semanticRoom.label}`,
    metadata: Object.freeze({
      semanticKind: "component-entry",
      region: semanticRoom.metadata.semanticRegion,
      confidence: semanticRoom.metadata.semanticConfidence,
      evidence: semanticRoom.metadata.semanticEvidence,
    }),
  }));
  const semanticRelationshipPortals = (learnedModel?.relationships || []).map((relationship) => Object.freeze({
    id: `semantic-relationship:${relationship.id}`,
    fromRoomId: relationship.from,
    toRoomId: relationship.to,
    label: relationship.label,
    kind: "semantic_relationship",
    traversalCost: 1,
    bidirectional: false,
    reason: relationship.description,
    metadata: Object.freeze({
      semanticKind: relationship.kind,
      relationshipKind: relationship.kind,
      confidence: relationship.confidence,
      evidence: relationship.evidence,
    }),
  }));
  const semanticFlowPortals = (learnedModel?.flows || []).flatMap((flow) => flow.steps.slice(1).map((step, index) => Object.freeze({
    id: `semantic-flow:${flow.id}:${index}`,
    fromRoomId: flow.steps[index].componentId,
    toRoomId: step.componentId,
    label: flow.label,
    kind: "semantic_flow",
    traversalCost: 1,
    bidirectional: false,
    reason: `${flow.description} ${step.action}`,
    metadata: Object.freeze({
      semanticKind: "directed-flow",
      flowId: flow.id,
      step: index + 1,
      action: step.action,
      confidence: flow.confidence,
      evidence: flow.evidence,
    }),
  })));
  const relationshipPortals = sourceRelationships.map((relationship) => {
    const fromRoomId = sourceRoomIdByPath.get(relationship.fromPath);
    const toRoomId = sourceRoomIdByPath.get(relationship.toPath);
    return Object.freeze({
      id: `${fromRoomId}:${relationship.kind}:${toRoomId}`,
      fromRoomId,
      toRoomId,
      label: relationship.label,
      kind: relationship.kind,
      traversalCost: 1,
      bidirectional: false,
      reason: `${relationship.fromPath} ${relationship.label} ${relationship.toPath}`,
      metadata: Object.freeze({
        fromPath: relationship.fromPath,
        toPath: relationship.toPath,
        specifier: relationship.specifier,
      }),
    });
  });
  const portals = [
    ...semanticRoomPortals,
    ...semanticRelationshipPortals,
    ...semanticFlowPortals,
    ...relationshipPortals,
  ];
  return Object.freeze({
    schema: ATLAS_INSTANCE_CATALOG_SCHEMA,
    authority: instance.repositoryId,
    generatedAt: new Date().toISOString(),
    rooms: Object.freeze([rootRoom, ...semanticRooms, ...sourceRooms, ...specificationRooms]),
    portals: Object.freeze(portals),
    metadata: Object.freeze({
      repositoryId: instance.repositoryId,
      sourceModel: learnedSourceModel,
      projectionKind: learnedModel ? "semantic-architecture" : "source-inventory",
      sourceFiles: scan.files.length,
      sourceBytes: scan.metrics.bytes,
      sourceGroups: new Set(sourceRooms.map((sourceRoom) => sourceRoom.metadata.sourceGroup.id)).size,
      sourceRelationships: sourceRelationships.length,
      semanticRooms: semanticRooms.length,
      semanticRelationships: semanticRelationshipPortals.length,
      semanticFlows: learnedModel?.flows.length || 0,
      repositorySystemModelStatus: learnedModel ? "current" : "missing",
      repositorySystemModelSchema: learnedModel?.schema || "",
      repositorySystemModelDigest: learnedModelDigest,
      repositorySystemModelResultDigest: learned?.resultDigest || "",
      repositorySystemModelRequestDigest: learned?.request.requestDigest || "",
      repositoryInventoryDigest: repositoryInventory.digest,
      repositorySystemModelUnknowns: learnedModel?.unknowns.length || 0,
      generationProvider: instance.generation.providerId,
      generationArtifacts: generation.artifacts.length,
      diagnostics: Object.freeze([
        ...scan.diagnostics,
        ...generation.diagnostics,
        ...specificationDiagnostics,
        ...(!learnedModel ? [Object.freeze({
          code: "repository-system-model-missing",
          reason: "Graph is a source inventory until atlas map applies a fresh repository-system-model artifact",
        })] : []),
      ]),
    }),
  });
}

/** Returns the repository-source rows whose paths and digests came from Core's bounded scan. */
function catalogSourceEvidenceRooms(catalog = {}) {
  return (catalog.rooms || []).filter((room) =>
    room.metadata?.entryKind === "source-evidence"
      && Boolean(String(room.metadata?.sourcePath || "").trim())
  );
}

/**
 * Preserves Core-derived source evidence beside a consumer's richer catalog.
 * Equal source paths are already represented and remain consumer-owned. A room
 * id that names a different source is ambiguous and fails instead of silently
 * discarding either authority.
 */
function composeConsumerCatalogWithSourceEvidence(catalog, sourceCatalog) {
  const rooms = [...(catalog.rooms || [])];
  const roomById = new Map(rooms.map((room) => [String(room.id || "").toLowerCase(), room]));
  const representedSourcePaths = new Set(rooms
    .map((room) => String(room.metadata?.sourcePath || "").trim())
    .filter(Boolean));
  for (const sourceRoom of catalogSourceEvidenceRooms(sourceCatalog)) {
    const sourcePath = String(sourceRoom.metadata.sourcePath).trim();
    if (representedSourcePaths.has(sourcePath)) continue;
    const existing = roomById.get(String(sourceRoom.id || "").toLowerCase());
    if (existing) {
      const existingSourcePath = String(existing.metadata?.sourcePath || "").trim();
      throw new Error(
        `Atlas consumer catalog room id conflicts with source evidence: ${sourceRoom.id} (${existingSourcePath || "no source"} != ${sourcePath})`,
      );
    }
    rooms.push(sourceRoom);
    roomById.set(String(sourceRoom.id || "").toLowerCase(), sourceRoom);
    representedSourcePaths.add(sourcePath);
  }
  return Object.freeze({
    ...catalog,
    rooms: Object.freeze(rooms),
  });
}

/**
 * Creates the repository provider after an optional consumer adapter replaces
 * semantic catalog construction. Core always composes its bounded, non-
 * navigable source-evidence rows back into that catalog, so consumer semantics
 * cannot erase real repository citations, locators, or source digests.
 * Retrieval remains bound by the installed repository-provider contract, and
 * Graph provider selection remains a separate explicit instance setting.
 */
export async function createAtlasInstanceProvider(options = {}) {
  const root = path.resolve(requiredText(options.root, "root"));
  const instancePath = options.instancePath || path.join(root, ".atlas", "atlas.instance.json");
  const instance = options.instance || readAtlasInstanceConfig(instancePath);
  const paths = atlasInstancePaths({ root, instancePath, instance, exchangeRoot: options.exchangeRoot });
  let catalog = options.catalog;
  if (!catalog && instance.adapter.module) {
    const sourceCatalog = buildAtlasInstanceCatalog({ root, instance });
    const sourceEvidenceRooms = sourceCatalog.rooms.filter((room) =>
      room.metadata?.entryKind === "source-evidence"
        && Boolean(String(room.metadata?.sourcePath || "").trim())
    );
    const adapterPath = pathInside(root, instance.adapter.module, "adapter.module");
    const adapter = await import(pathToFileURL(adapterPath).href);
    const builder = adapter[instance.adapter.exportName];
    if (typeof builder !== "function") {
      throw new Error(`Atlas instance adapter must export ${instance.adapter.exportName}: ${instance.adapter.module}`);
    }
    const result = await builder({ root, instance, paths, sourceCatalog, sourceEvidenceRooms });
    catalog = composeConsumerCatalogWithSourceEvidence(result?.catalog || result, sourceCatalog);
  }
  if (!catalog) catalog = buildAtlasInstanceCatalog({ root, instance });
  if (String(catalog.authority || "").trim().toLowerCase() !== instance.repositoryId) {
    throw new Error("Atlas instance catalog authority must match repositoryId");
  }
  const provider = createAtlasRepositoryProvider({
    repositoryId: instance.repositoryId,
    catalog,
    indexPath: paths.indexPath,
    generationProvider: options.generationProvider
      || instance.generation.providerId
      || catalog.metadata?.generationProvider
      || catalog.metadata?.sourceModel
      || "multihead-atlas-default-repository-adapter",
  });
  return Object.freeze({ instance, paths, catalog, provider });
}

/** Returns only source-to-source portals that carry observed repository evidence. */
function sourceRelationshipPortals(catalog) {
  return catalog.portals.filter((portal) => portal.kind === "source_import" || portal.kind === "source_link");
}

/** Returns model-owned portals that connect validated semantic-room endpoints. */
function semanticRelationshipPortals(catalog) {
  return catalog.portals.filter((portal) => portal.kind === "semantic_relationship" || portal.kind === "semantic_flow");
}

/** Returns true when one relative Graph endpoint explicitly targets the candidate room id. */
function graphEndpointTargetsRoom(candidate) {
  const endpoint = String(candidate?.metadata?.graphEndpoint || "").trim();
  if (!endpoint.startsWith("/api/architecture-graph?")) return false;
  try {
    const parsed = new URL(endpoint, "http://atlas-instance.invalid");
    return parsed.origin === "http://atlas-instance.invalid"
      && parsed.pathname === "/api/architecture-graph"
      && String(parsed.searchParams.get("slice") || "").toLowerCase() === String(candidate.id || "").toLowerCase();
  } catch {
    return false;
  }
}

/** Returns true only when the declared source model is explicit and semantic rather than structural inventory. */
function hasSemanticSourceModel(candidate) {
  const sourceModel = String(candidate?.metadata?.roomGraphSourceModel || "").trim();
  return Boolean(sourceModel) && !/(?:source[-_. ]?inventory|structural)/iu.test(sourceModel);
}

/** Returns true only when the complete explicit metadata contract grants architecture navigation. */
function isSemanticRoom(candidate) {
  return candidate?.metadata?.entryKind === "semantic-room"
    && candidate?.metadata?.navigationKind === "room-entry"
    && candidate?.metadata?.roomGraphStatus === "available"
    && hasSemanticSourceModel(candidate)
    && candidate?.metadata?.roomGraphFreshnessStatus === "source-digest-current"
    && graphEndpointTargetsRoom(candidate);
}

/** Returns fail-closed navigation metadata, clearing every incomplete adapter semantic-room claim. */
function strictNavigationMetadata(candidate, catalog) {
  const semantic = isSemanticRoom(candidate);
  const declaredEntryKind = String(candidate?.metadata?.entryKind || "source-evidence");
  return Object.freeze({
    semantic,
    entryKind: semantic ? "semantic-room" : (declaredEntryKind === "semantic-room" ? "source-evidence" : declaredEntryKind),
    navigationKind: semantic ? "room-entry" : "none",
    roomGraphStatus: semantic ? "available" : "unavailable",
    roomGraphSourceModel: semantic
      ? candidate.metadata.roomGraphSourceModel
      : (candidate?.metadata?.roomGraphSourceModel || catalog.metadata?.sourceModel || "multihead-atlas-source-inventory-v1"),
    roomGraphFreshnessStatus: semantic ? "source-digest-current" : "",
    graphEndpoint: semantic ? candidate.metadata.graphEndpoint : "",
  });
}

/** Counts observed source relationships for deterministic overview prominence ranking. */
function sourceRelationshipDegrees(catalog) {
  const degrees = new Map();
  for (const portal of sourceRelationshipPortals(catalog)) {
    degrees.set(portal.fromRoomId, (degrees.get(portal.fromRoomId) || 0) + 1);
    degrees.set(portal.toRoomId, (degrees.get(portal.toRoomId) || 0) + 1);
  }
  return degrees;
}

/** Orders source rooms by observed connectivity, then by shallow stable repository path. */
function compareSourceProminence(degrees) {
  return (left, right) => {
    const degreeDifference = (degrees.get(right.id) || 0) - (degrees.get(left.id) || 0);
    if (degreeDifference) return degreeDifference;
    const leftPath = String(left.metadata?.sourcePath || left.id);
    const rightPath = String(right.metadata?.sourcePath || right.id);
    const depthDifference = leftPath.split("/").length - rightPath.split("/").length;
    if (depthDifference) return depthDifference;
    const lengthDifference = leftPath.length - rightPath.length;
    return lengthDifference || leftPath.localeCompare(rightPath);
  };
}

/**
 * Selects a bounded overview without discarding catalog or retrieval truth.
 * Code/configuration remain grouped by observed path, while documentation is
 * ranked once across the repository for a single secondary visual region.
 */
function overviewRooms(catalog, authority) {
  const degrees = sourceRelationshipDegrees(catalog);
  const compare = compareSourceProminence(degrees);
  const selectedIds = new Set([authority.id]);
  const documentation = [];
  const grouped = new Map();
  const ungrouped = [];
  for (const candidate of catalog.rooms) {
    if (candidate.id === authority.id) continue;
    const sourceClass = String(candidate.metadata?.sourceClass || "");
    if (sourceClass === "documentation") {
      documentation.push(candidate);
      continue;
    }
    const groupId = String(candidate.metadata?.sourceGroup?.id || "");
    if (!groupId) {
      ungrouped.push(candidate);
      continue;
    }
    const byClass = grouped.get(groupId) || new Map();
    const rows = byClass.get(sourceClass || "repository-source") || [];
    rows.push(candidate);
    byClass.set(sourceClass || "repository-source", rows);
    grouped.set(groupId, byClass);
  }
  documentation.sort(compare).slice(0, OVERVIEW_DOCUMENTATION_LIMIT).forEach((candidate) => selectedIds.add(candidate.id));
  for (const byClass of grouped.values()) {
    for (const [sourceClass, candidates] of byClass.entries()) {
      const limit = OVERVIEW_SOURCE_CLASS_LIMITS[sourceClass] || OVERVIEW_SOURCE_CLASS_LIMITS["repository-source"];
      candidates.sort(compare).slice(0, limit).forEach((candidate) => selectedIds.add(candidate.id));
    }
  }
  ungrouped.sort(compare).slice(0, DRILLDOWN_DETAIL_LIMIT).forEach((candidate) => selectedIds.add(candidate.id));
  return catalog.rooms.filter((candidate) => selectedIds.has(candidate.id));
}

/**
 * Selects one source-room context around direct observed relationships, then
 * fills the remaining bounded budget with prominent same-path siblings.
 */
function drilldownRooms(catalog, selected, authority) {
  const degrees = sourceRelationshipDegrees(catalog);
  const compare = compareSourceProminence(degrees);
  const relatedIds = new Set([authority.id, selected.id]);
  const direct = [];
  for (const portal of sourceRelationshipPortals(catalog)) {
    if (portal.fromRoomId !== selected.id && portal.toRoomId !== selected.id) continue;
    const neighborId = portal.fromRoomId === selected.id ? portal.toRoomId : portal.fromRoomId;
    const neighbor = catalog.rooms.find((candidate) => candidate.id === neighborId);
    if (neighbor && !direct.some((candidate) => candidate.id === neighbor.id)) direct.push(neighbor);
  }
  direct.sort(compare)
    .slice(0, DRILLDOWN_DIRECT_RELATIONSHIP_LIMIT)
    .forEach((candidate) => relatedIds.add(candidate.id));
  const selectedGroupId = String(selected.metadata?.sourceGroup?.id || "");
  if (selectedGroupId && relatedIds.size - 1 < DRILLDOWN_DETAIL_LIMIT) {
    catalog.rooms
      .filter((candidate) => String(candidate.metadata?.sourceGroup?.id || "") === selectedGroupId)
      .filter((candidate) => !relatedIds.has(candidate.id))
      .sort(compare)
      .slice(0, DRILLDOWN_DETAIL_LIMIT - (relatedIds.size - 1))
      .forEach((candidate) => relatedIds.add(candidate.id));
  }
  return catalog.rooms.filter((candidate) => relatedIds.has(candidate.id));
}

/** Selects model-owned neighbors and bounded same-region context for one semantic drilldown. */
function semanticDrilldownRooms(catalog, selected, authority) {
  const selectedIds = new Set([authority.id, selected.id]);
  for (const portal of semanticRelationshipPortals(catalog)) {
    if (portal.fromRoomId === selected.id) selectedIds.add(portal.toRoomId);
    if (portal.toRoomId === selected.id) selectedIds.add(portal.fromRoomId);
  }
  const region = String(selected.metadata?.semanticRegion || "");
  if (region && selectedIds.size < 14) {
    catalog.rooms
      .filter((candidate) => isSemanticRoom(candidate) && candidate.metadata?.semanticRegion === region)
      .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id))
      .slice(0, 14 - selectedIds.size)
      .forEach((candidate) => selectedIds.add(candidate.id));
  }
  return catalog.rooms.filter((candidate) => selectedIds.has(candidate.id));
}

/** Selects the authority overview or one bounded authority-plus-detail projection for Graph. */
function selectedRooms(catalog, roomId) {
  const requested = String(roomId || catalog.authority).trim().toLowerCase();
  const selected = catalog.rooms.find((candidate) => candidate.id.toLowerCase() === requested);
  const authority = catalog.rooms.find((candidate) => candidate.id.toLowerCase() === String(catalog.authority).toLowerCase());
  if (!authority) throw new Error("Atlas instance graph catalog is missing its authority room");
  if (!selected) {
    const error = new Error(`Atlas instance room is not available: ${roomId}`);
    error.statusCode = 404;
    throw error;
  }
  if (selected.id.toLowerCase() === String(catalog.authority).toLowerCase()) {
    if (catalog.metadata?.repositorySystemModelStatus === "current") {
      return catalog.rooms.filter((candidate) => candidate.id === authority.id || isSemanticRoom(candidate));
    }
    return overviewRooms(catalog, authority);
  }
  if (!isSemanticRoom(selected)) {
    const error = new Error(`Atlas source evidence is not an architecture room: ${selected.id}`);
    error.statusCode = 404;
    throw error;
  }
  if (catalog.metadata?.repositorySystemModelStatus === "current") return semanticDrilldownRooms(catalog, selected, authority);
  return drilldownRooms(catalog, selected, authority);
}

/** Maps source extension and adapter metadata to a source-neutral Graph node kind. */
function graphNodeKind(candidate, catalog) {
  if (candidate.id === catalog.authority) return "authority";
  if (isSemanticRoom(candidate)) return "architecture_component";
  const sourceClass = String(candidate.metadata?.sourceClass || "");
  if (sourceClass === "source-module") return "code";
  if (sourceClass === "configuration") return "config";
  return "doc";
}

/**
 * Returns the visual group used by one room. Repository overview places all
 * documentation in one secondary region; drilldowns preserve path context.
 */
function graphProjectionGroup(candidate, overview, repositoryIdValue) {
  if (overview && candidate.metadata?.sourceClass === "documentation") {
    return Object.freeze({
      id: `source-role-${sha256(`${repositoryIdValue}\0documentation`).slice(0, 16)}`,
      path: "documentation",
      label: "Documentation",
      role: "secondary documentation",
      secondary: true,
    });
  }
  return candidate.metadata?.sourceGroup || null;
}

/** Builds first-class Graph containers with visible and total source counts kept distinct. */
function graphSourceGroupContainers(rooms, catalog, overview) {
  const groups = new Map();
  const totals = new Map();
  for (const candidate of catalog.rooms) {
    const group = graphProjectionGroup(candidate, overview, catalog.authority);
    if (!group?.id) continue;
    const current = totals.get(group.id) || { count: 0 };
    current.count += 1;
    totals.set(group.id, current);
  }
  for (const candidate of rooms) {
    const group = graphProjectionGroup(candidate, overview, catalog.authority);
    if (!group?.id) continue;
    const current = groups.get(group.id) || { ...group, nodeIds: [], classes: new Set() };
    current.nodeIds.push(candidate.id);
    current.classes.add(String(candidate.metadata?.sourceClass || "repository-source"));
    groups.set(group.id, current);
  }
  return [...groups.values()].sort((left, right) => left.path.localeCompare(right.path)).map((group) => {
    const total = totals.get(group.id) || { count: group.nodeIds.length };
    const visible = group.nodeIds.length;
    const location = group.secondary ? "across the repository" : `under ${group.path}`;
    return {
      id: `container:${group.id}`,
      kind: "architecture_source_group",
      label: group.label,
      role: group.role || (group.classes.size === 1 ? [...group.classes][0].replace(/-/gu, " ") : "mixed repository sources"),
      description: `${visible} of ${total.count} admitted source ${total.count === 1 ? "file" : "files"} shown ${location}.`,
      nodeIds: group.nodeIds,
      metadata: {
        sourceGroupId: group.id,
        sourceGroupPath: group.path,
        sourceCount: total.count,
        visibleSourceCount: visible,
        hiddenSourceCount: Math.max(0, total.count - visible),
        secondary: group.secondary ? "true" : "",
      },
    };
  });
}

/** Builds optional conceptual regions declared by learned semantic components. */
function graphSemanticRegionContainers(rooms, catalog) {
  const regions = new Map();
  for (const candidate of rooms) {
    if (!isSemanticRoom(candidate) || candidate.id === catalog.authority) continue;
    const region = String(candidate.metadata?.semanticRegion || "").trim();
    if (!region) continue;
    const key = region.toLowerCase();
    const current = regions.get(key) || { label: region, nodeIds: [], componentLabels: [] };
    current.nodeIds.push(candidate.id);
    current.componentLabels.push(candidate.label);
    regions.set(key, current);
  }
  return [...regions.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, region]) => ({
    id: `container:semantic-region-${sha256(`${catalog.authority}\0${key}`).slice(0, 16)}`,
    kind: "architecture_semantic_region",
    label: region.label,
    role: "",
    description: region.componentLabels.join(" · "),
    nodeIds: region.nodeIds,
    metadata: {
      semanticRegion: region.label,
      semanticRoomCount: region.nodeIds.length,
      componentLabels: region.componentLabels,
    },
  }));
}

/** Translates selected catalog rooms and portals into the Atlas Graph projection schema. */
export function buildAtlasInstanceGraphProjection(options = {}) {
  const catalog = options.catalog;
  if (!catalog || !String(catalog.schema || "").trim() || !String(catalog.authority || "").trim()
    || !Array.isArray(catalog.rooms) || !Array.isArray(catalog.portals)) {
    throw new Error("Atlas instance graph requires a repository catalog");
  }
  const requestedRoom = catalog.rooms.find((candidate) =>
    candidate.id.toLowerCase() === String(options.roomId || catalog.authority).trim().toLowerCase()
  );
  const rooms = selectedRooms(catalog, options.roomId);
  const overview = requestedRoom?.id === catalog.authority;
  const learned = catalog.metadata?.repositorySystemModelStatus === "current";
  const ids = new Set(rooms.map((candidate) => candidate.id));
  const containers = learned
    ? graphSemanticRegionContainers(rooms, catalog)
    : graphSourceGroupContainers(rooms, catalog, overview);
  const groupedRoomIds = new Set(containers.flatMap((container) => container.nodeIds));
  const edges = catalog.portals
    .filter((portal) => ids.has(portal.fromRoomId) && ids.has(portal.toRoomId))
    .filter((portal) => learned || !(overview && portal.kind === "source_link"))
    .filter((portal) => learned
      || overview
      || !["source_import", "source_link"].includes(portal.kind)
      || portal.fromRoomId === requestedRoom?.id
      || portal.toRoomId === requestedRoom?.id)
    .filter((portal) => !learned
      || overview
      || !["semantic_relationship", "semantic_flow"].includes(portal.kind)
      || portal.fromRoomId === requestedRoom?.id
      || portal.toRoomId === requestedRoom?.id)
    .filter((portal) => !(portal.kind === "opens_room" && portal.fromRoomId === catalog.authority && groupedRoomIds.has(portal.toRoomId)))
    .map((portal) => ({
      id: portal.id,
      from: portal.fromRoomId,
      to: portal.toRoomId,
      kind: portal.kind,
      label: portal.label,
      description: portal.reason,
      metadata: portal.metadata || {},
    }));
  for (const container of containers) {
    const authorityLabel = rooms.find((candidate) => candidate.id === catalog.authority)?.label
      || repositoryDisplayLabel(catalog.authority);
    const componentLabels = Array.isArray(container.metadata?.componentLabels)
      ? container.metadata.componentLabels
      : [];
    edges.push({
      id: learned
        ? `${catalog.authority}:contains_semantic_region:${sha256(container.id).slice(0, 16)}`
        : `${catalog.authority}:contains_source_group:${container.metadata.sourceGroupId}`,
      from: catalog.authority,
      to: container.id,
      kind: learned ? "contains_semantic_region" : "contains_source_group",
      label: learned ? `organizes ${container.label}` : "contains source group",
      description: learned
        ? `${authorityLabel} organizes ${componentLabels.join(", ")} as ${container.label}.`
        : `${catalog.authority} contains ${container.metadata.sourceGroupPath}`,
    });
  }
  const nodes = rooms.map((candidate) => {
    const navigation = strictNavigationMetadata(candidate, catalog);
    const drilldownCapable = candidate.id !== catalog.authority && navigation.semantic;
    // Repository authority is inert in the overview, but the same authority
    // becomes the explicit route back when a component projection is active.
    // This state belongs to the projection context, never to the catalog room.
    const overviewReturnCapable = !overview && candidate.id === catalog.authority;
    return ({
    id: candidate.id,
    label: candidate.label,
    kind: graphNodeKind(candidate, catalog),
    drilldownCapable,
    overviewReturnCapable,
    description: candidate.summary,
    source: candidate.metadata?.sourcePath || "",
    metadata: {
      roomId: candidate.id,
      repositoryId: catalog.authority,
      sourcePath: candidate.metadata?.sourcePath || "",
      summaryDigest: candidate.summaryDigest,
      freshnessStatus: candidate.freshnessStatus,
      entryKind: navigation.entryKind,
      navigationKind: overviewReturnCapable ? "repository-overview" : navigation.navigationKind,
      drilldownCapable: drilldownCapable ? "true" : "",
      architectureDrilldownRoom: drilldownCapable ? "true" : "",
      overviewReturnCapable: overviewReturnCapable ? "true" : "",
      repositoryOverviewStatus: overviewReturnCapable ? "available" : "unavailable",
      repositoryOverviewEndpoint: overviewReturnCapable ? "/api/architecture-graph" : "",
      roomGraphStatus: navigation.roomGraphStatus,
      roomGraphSourceModel: navigation.roomGraphSourceModel,
      roomGraphFreshnessStatus: navigation.roomGraphFreshnessStatus,
      graphEndpoint: navigation.graphEndpoint,
      semanticRegion: candidate.metadata?.semanticRegion || "",
      kindLabelHidden: learned ? "true" : "",
      semanticConfidence: candidate.metadata?.semanticConfidence ?? "",
      semanticEvidence: candidate.metadata?.semanticEvidence || [],
      repositorySystemModelDigest: candidate.metadata?.repositorySystemModelDigest || "",
      repositorySystemModelResultDigest: candidate.metadata?.repositorySystemModelResultDigest || "",
      repositorySystemModelRequestDigest: candidate.metadata?.repositorySystemModelRequestDigest || "",
    },
  });
  });
  const availableSourceRooms = catalog.rooms.filter((candidate) => candidate.metadata?.entryKind === "source-evidence" && candidate.metadata?.sourcePath);
  const visibleSourceRooms = rooms.filter((candidate) => candidate.metadata?.entryKind === "source-evidence" && candidate.metadata?.sourcePath);
  const availableRelationships = sourceRelationshipPortals(catalog);
  const visibleRelationshipIds = new Set(edges
    .filter((edge) => edge.kind === "source_import" || edge.kind === "source_link")
    .map((edge) => edge.id));
  return {
    schema: ATLAS_INSTANCE_GRAPH_SCHEMA,
    view: "architecture",
    authority: catalog.authority,
    roomId: requestedRoom?.id || catalog.authority,
    nodes,
    edges,
    containers,
    metadata: {
      repositoryId: catalog.authority,
      // The installed instance title names the repository, not whichever
      // projection label happens to represent its overview authority node.
      repositoryLabel: repositoryDisplayLabel(catalog.authority),
      sourceAvailable: true,
      sourceModel: catalog.metadata?.sourceModel || "consumer-repository-catalog",
      architectureAtlas: options.route || null,
      architectureAtlasStatus: options.route ? "live" : "unavailable",
      architectureProjectionMode: learned
        ? (overview ? "repository-system-model" : "semantic-room")
        : "source-inventory",
      architectureProjectionPolicy: learned
        ? (overview ? "learned-semantic-overview-v1" : "learned-semantic-room-context-v1")
        : "bounded-source-inventory-v1",
      architectureProjectionSource: catalog.metadata?.sourceModel || "consumer-repository-catalog",
      currentArchitectureRoomId: overview ? "" : requestedRoom?.id || "",
      repositorySystemModelStatus: catalog.metadata?.repositorySystemModelStatus || "missing",
      repositorySystemModelDigest: catalog.metadata?.repositorySystemModelDigest || "",
      repositorySystemModelResultDigest: catalog.metadata?.repositorySystemModelResultDigest || "",
      repositorySystemModelRequestDigest: catalog.metadata?.repositorySystemModelRequestDigest || "",
      semanticRoomsAvailable: Number(catalog.metadata?.semanticRooms || 0),
      sourcePaths: rooms.map((candidate) => candidate.metadata?.sourcePath || "").filter(Boolean),
      sourceRoomsAvailable: availableSourceRooms.length,
      sourceRoomsVisible: visibleSourceRooms.length,
      sourceRoomsHidden: Math.max(0, availableSourceRooms.length - visibleSourceRooms.length),
      sourceRelationshipsAvailable: availableRelationships.length,
      sourceRelationshipsVisible: availableRelationships.filter((portal) => visibleRelationshipIds.has(portal.id)).length,
      sourceRelationshipsSuppressed: availableRelationships.filter((portal) => !visibleRelationshipIds.has(portal.id)).length,
      documentationLinksAvailable: availableRelationships.filter((portal) => portal.kind === "source_link").length,
      documentationLinksVisible: availableRelationships.filter((portal) => portal.kind === "source_link" && visibleRelationshipIds.has(portal.id)).length,
      diagnostics: { status: "pass", errors: [], warnings: catalog.metadata?.diagnostics || [] },
    },
  };
}

/** Wraps the repository catalog in the minimal slices response consumed by Graph routing. */
export function buildAtlasInstanceSlices(catalog) {
  return {
    schema: "multihead-atlas.instance_slices.v1",
    status: "pass",
    atlas: {
      schema: catalog.schema,
      authority: catalog.authority,
      rooms: catalog.rooms,
      portals: catalog.portals,
      metadata: catalog.metadata || {},
    },
  };
}

/** Builds a deterministic repository room route response for Graph entry and navigation. */
export function buildAtlasInstanceRoute(catalog, options = {}) {
  const query = compact(options.query || "repository architecture", 240);
  const currentRoom = String(options.currentRoom || catalog.authority).trim().toLowerCase();
  const selectedRoom = catalog.rooms.find((candidate) => candidate.id.toLowerCase() === currentRoom)
    || catalog.rooms.find((candidate) => candidate.id === catalog.authority);
  const search = options.search && typeof options.search === "object"
    ? options.search
    : { schema: "multihead-atlas.architecture_atlas_search.v1", query, status: "not-run", results: [] };
  const searchById = new Map((Array.isArray(search.results) ? search.results : []).map((result) => [result.id, result]));
  const orderedRooms = [
    selectedRoom,
    ...catalog.rooms.filter((candidate) => candidate.id !== selectedRoom.id).sort((left, right) => {
      const semanticDifference = Number(isSemanticRoom(right)) - Number(isSemanticRoom(left));
      if (semanticDifference) return semanticDifference;
      const leftScore = Number(searchById.get(left.id)?.combinedScore || 0);
      const rightScore = Number(searchById.get(right.id)?.combinedScore || 0);
      return rightScore - leftScore || left.label.localeCompare(right.label) || left.id.localeCompare(right.id);
    }),
  ].filter(Boolean);
  /** Converts one catalog room into a Router candidate with its repository path and lexical/vector score evidence. */
  const candidateFor = (candidate) => {
    const result = searchById.get(candidate.id) || {};
    const score = candidate.id === selectedRoom.id ? Math.max(1, Number(result.combinedScore || 0)) : Number(result.combinedScore || 0);
    const navigation = strictNavigationMetadata(candidate, catalog);
    return {
      roomId: candidate.id,
      label: candidate.label,
      score,
      finalScore: score,
      entryKind: navigation.entryKind,
      navigationKind: navigation.navigationKind,
      roomGraphStatus: navigation.roomGraphStatus,
      roomGraphSourceModel: navigation.roomGraphSourceModel,
      roomGraphFreshnessStatus: navigation.roomGraphFreshnessStatus,
      graphEndpoint: navigation.graphEndpoint,
      path: { roomIds: candidate.id === catalog.authority ? [catalog.authority] : [catalog.authority, candidate.id] },
      reason: {
        indexSimilarity: Number(result.combinedScore || 0),
        lexicalIndexSimilarity: Number(result.lexicalNormalizedScore || 0),
        vectorSimilarity: Number(result.vectorScore || 0),
        indexScoreSource: result.scoreSource || "repository-catalog",
      },
    };
  };
  const candidates = orderedRooms.slice(0, 8).map(candidateFor);
  const selected = candidateFor(selectedRoom);
  return {
    schema: "multihead-atlas.instance_route.v1",
    status: "pass",
    query,
    currentRoom,
    authority: catalog.authority,
    selectedRoom,
    trail: selected.path.roomIds,
    search,
    retrieval: options.retrieval || { mode: "catalog", indexed: false, capabilityGaps: ["repository-index"] },
    plan: {
      selected,
      candidates,
    },
    candidates,
  };
}

/**
 * Writes a movable consumer CLI shim containing only paths relative to its own .atlas/bin
 * directory. Moving the consumer checkout therefore cannot retain the Atlas
 * development checkout or the original consumer absolute path as authority.
 */
export function writeAtlasInstanceCommandShim(options = {}) {
  const root = path.resolve(requiredText(options.root, "root"));
  const instancePath = path.resolve(options.instancePath || path.join(root, ".atlas", "atlas.instance.json"));
  const runtimePath = relativePath(options.runtimePath || ".atlas/runtime", "runtimePath");
  const binRoot = path.join(path.dirname(instancePath), "bin");
  const shimPath = path.join(binRoot, "atlas");
  const rootFromBin = posixPath(path.relative(binRoot, root));
  const commandFromBin = posixPath(path.relative(binRoot, path.join(root, runtimePath, "atlas", "scripts", "atlas")));
  const source = `#!/usr/bin/env node\n\nimport childProcess from "node:child_process";\nimport path from "node:path";\n\nconst root = path.resolve(import.meta.dirname, ${JSON.stringify(rootFromBin)});\nconst command = path.resolve(import.meta.dirname, ${JSON.stringify(commandFromBin)});\nconst result = childProcess.spawnSync(process.execPath, [command, ...process.argv.slice(2), "--root", root], { cwd: process.cwd(), env: process.env, stdio: "inherit" });\nif (result.error) throw result.error;\nprocess.exit(result.status ?? 1);\n`;
  fs.mkdirSync(binRoot, { recursive: true });
  fs.writeFileSync(shimPath, source, "utf8");
  fs.chmodSync(shimPath, 0o755);
  return shimPath;
}
