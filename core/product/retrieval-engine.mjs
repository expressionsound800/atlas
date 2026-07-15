/*
 * Retrieval Engine owns Atlas' source-neutral SQLite indexing, lexical search,
 * deterministic vector search, freshness, and quality contracts. Callers must
 * provide a catalog and an absolute index path; this module does not discover
 * consumer repositories, routes, memory files, or workspace layout.
 */

import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_ARCHITECTURE_GENERATION_PROVIDER = "current-agent";
const ARCHITECTURE_VECTOR_INDEX_KIND = "sqlite-local-vector-index";
const ARCHITECTURE_VECTOR_MODEL = "multihead-local-hash-embedding-v1";
const ARCHITECTURE_VECTOR_DIMENSIONS = 96;

/** Normalizes arbitrary catalog text to one searchable line with an explicit fallback. */
function compactText(value, fallback = "") {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text || fallback;
}

/** Returns an array input unchanged and treats every other shape as empty. */
function listFrom(value) {
  return Array.isArray(value) ? value : [];
}

/** Deduplicates normalized non-empty strings while preserving their first-seen retrieval order. */
function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => compactText(value)).filter(Boolean))];
}

/** Computes a deterministic digest from the JSON representation of retrieval contract data. */
function sha256Json(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Validates and normalizes the caller-supplied absolute generated-index path. */
function requiredIndexPath(value) {
  const indexPath = compactText(value);
  if (!indexPath || !path.isAbsolute(indexPath)) {
    throw new Error("Atlas retrieval engine requires an absolute indexPath");
  }
  return path.normalize(indexPath);
}

/** Validates the minimum rooms-and-portals catalog shape required by the engine. */
function requiredCatalog(value) {
  if (!value || typeof value !== "object") throw new Error("Atlas retrieval engine requires catalog object");
  if (!Array.isArray(value.rooms) || !Array.isArray(value.portals)) {
    throw new Error("Atlas retrieval engine catalog requires rooms and portals arrays");
  }
  return value;
}

/** Computes the freshness identity from only catalog fields that affect retrieval output. */
function catalogDigest(catalog = {}) {
  return sha256Json({
    schema: catalog.schema,
    authority: catalog.authority,
    rooms: listFrom(catalog.rooms).map((room) => ({
      id: room.id,
      label: room.label,
      owner: room.owner,
      viewpoint: room.viewpoint,
      summary: room.summary,
      generatedSummary: room.generatedSummary,
      summaryStatus: room.summaryStatus,
      summarySource: room.summarySource,
      summaryDigest: room.summaryDigest,
      freshnessStatus: room.freshnessStatus,
      freshnessDigest: room.freshnessDigest,
      sourceRepos: room.sourceRepos,
      answers: room.answers,
      facets: room.facets,
      graphEndpoint: room.metadata?.graphEndpoint,
    })),
    portals: listFrom(catalog.portals).map((portal) => ({
      id: portal.id,
      fromRoomId: portal.fromRoomId,
      toRoomId: portal.toRoomId,
      label: portal.label,
      kind: portal.kind,
      traversalCost: portal.traversalCost,
      bidirectional: portal.bidirectional,
    })),
  });
}

/** Converts normalized text into lowercase searchable tokens longer than one character. */
function tokenizeText(value) {
  return compactText(value)
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 1);
}

/** Builds the field-weighted lexical token inventory used to index one room. */
function weightedTokens(room = {}) {
  const weights = new Map();
  /** Adds each tokenized field value to its accumulated room-specific lexical weight. */
  const add = (value, weight) => {
    for (const token of tokenizeText(value)) weights.set(token, (weights.get(token) || 0) + weight);
  };
  add(room.id, 1.5);
  add(room.label, 4);
  add(room.owner, 3);
  add(room.viewpoint, 2);
  add(room.summary, 2);
  add(room.generatedSummary, 3);
  for (const text of listFrom(room.answers)) add(text, 2);
  for (const text of listFrom(room.facets)) add(text, 1.5);
  for (const text of listFrom(room.sourceRepos)) add(text, 3);
  return [...weights.entries()].map(([token, weight]) => ({ token, weight }));
}

/** Joins every vector-relevant room field into deterministic source text for provenance. */
function vectorSourceText(room = {}) {
  return [
    room.id,
    room.label,
    room.owner,
    room.viewpoint,
    room.summary,
    room.generatedSummary,
    ...listFrom(room.answers),
    ...listFrom(room.facets),
    ...listFrom(room.sourceRepos),
    ...listFrom(room.childRoomIds),
  ].map((value) => compactText(value)).filter(Boolean).join("\n");
}

/** Builds and normalizes a deterministic signed hash vector from weighted lexical tokens. */
function vectorFromWeightedTokens(tokens = [], dimensions = ARCHITECTURE_VECTOR_DIMENSIONS) {
  const vector = Array.from({ length: dimensions }, () => 0);
  for (const row of tokens) {
    const token = compactText(row.token);
    if (!token) continue;
    const digest = crypto.createHash("sha256").update(token).digest();
    const slot = digest.readUInt32BE(0) % dimensions;
    const sign = digest.readUInt8(4) % 2 === 0 ? 1 : -1;
    vector[slot] += sign * Number(row.weight || 1);
  }
  const magnitude = Math.hypot(...vector);
  if (!Number.isFinite(magnitude) || magnitude <= 0) return { vector, magnitude: 0 };
  return { vector: vector.map((value) => Number((value / magnitude).toFixed(6))), magnitude };
}

/** Builds one indexed room vector together with model, digest, and freshness provenance. */
function architectureVectorForRoom(room = {}) {
  const sourceText = vectorSourceText(room);
  const sourceDigest = sha256Json({
    model: ARCHITECTURE_VECTOR_MODEL,
    dimensions: ARCHITECTURE_VECTOR_DIMENSIONS,
    sourceText,
    summaryDigest: room.summaryDigest,
    freshnessDigest: room.freshnessDigest,
  });
  const { vector, magnitude } = vectorFromWeightedTokens(weightedTokens(room));
  return {
    elementId: room.id,
    vectorRef: room.indexRefs?.vector || `architecture_vector:${room.id}`,
    vectorModel: ARCHITECTURE_VECTOR_MODEL,
    dimensions: ARCHITECTURE_VECTOR_DIMENSIONS,
    sourceDigest,
    freshnessDigest: room.freshnessDigest || room.summaryDigest || sourceDigest,
    vector,
    magnitude,
    sourceText,
  };
}

/** Builds a unit-weight deterministic vector for a user's normalized search query. */
function architectureVectorForQuery(query = "") {
  const weights = new Map();
  for (const token of tokenizeText(query)) weights.set(token, (weights.get(token) || 0) + 1);
  return vectorFromWeightedTokens([...weights.entries()].map(([token, weight]) => ({ token, weight }))).vector;
}

/** Computes bounded non-negative cosine similarity for two local embedding vectors. */
function cosineSimilarity(left = [], right = []) {
  const count = Math.min(left.length, right.length);
  if (!count) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < count; index += 1) {
    const leftValue = Number(left[index] || 0);
    const rightValue = Number(right[index] || 0);
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude <= 0 || rightMagnitude <= 0) return 0;
  return Number(Math.max(0, Math.min(1, dot / Math.sqrt(leftMagnitude * rightMagnitude))).toFixed(4));
}

/** Opens the caller-authorized SQLite index without discovering or substituting another path. */
function openIndex(indexPath) {
  return new DatabaseSync(indexPath);
}

/** Adds a missing schema column so older disposable indexes migrate during normal access. */
function ensureIndexColumn(db, tableName, columnName, columnDefinition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!columns.some((column) => column.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnDefinition}`);
  }
}

/** Creates current metadata, summary, token, and vector tables and applies additive migrations. */
function createIndexSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS architecture_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS architecture_summary (
      id TEXT PRIMARY KEY,
      element_type TEXT NOT NULL,
      label TEXT NOT NULL,
      owner TEXT NOT NULL,
      viewpoint TEXT NOT NULL,
      summary TEXT NOT NULL,
      generated_summary TEXT NOT NULL,
      summary_status TEXT NOT NULL,
      summary_source TEXT NOT NULL DEFAULT '',
      summary_updated_at TEXT NOT NULL,
      summary_digest TEXT NOT NULL,
      freshness_status TEXT NOT NULL DEFAULT '',
      freshness_digest TEXT NOT NULL DEFAULT '',
      lexical_ref TEXT NOT NULL DEFAULT '',
      vector_ref TEXT NOT NULL DEFAULT '',
      vector_status TEXT NOT NULL DEFAULT 'not-indexed',
      graph_endpoint TEXT NOT NULL,
      source_repos_json TEXT NOT NULL,
      facets_json TEXT NOT NULL,
      answers_json TEXT NOT NULL,
      source_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS architecture_token (
      element_id TEXT NOT NULL,
      token TEXT NOT NULL,
      weight REAL NOT NULL,
      PRIMARY KEY (element_id, token)
    );
    CREATE INDEX IF NOT EXISTS architecture_token_lookup ON architecture_token(token, weight DESC, element_id);
    CREATE TABLE IF NOT EXISTS architecture_vector (
      element_id TEXT PRIMARY KEY,
      vector_ref TEXT NOT NULL,
      vector_model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      source_digest TEXT NOT NULL,
      freshness_digest TEXT NOT NULL,
      vector_json TEXT NOT NULL,
      magnitude REAL NOT NULL,
      source_text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS architecture_vector_model_lookup ON architecture_vector(vector_model, dimensions, element_id);
  `);
  ensureIndexColumn(db, "architecture_summary", "summary_source", "summary_source TEXT NOT NULL DEFAULT ''");
  ensureIndexColumn(db, "architecture_summary", "freshness_status", "freshness_status TEXT NOT NULL DEFAULT ''");
  ensureIndexColumn(db, "architecture_summary", "freshness_digest", "freshness_digest TEXT NOT NULL DEFAULT ''");
  ensureIndexColumn(db, "architecture_summary", "lexical_ref", "lexical_ref TEXT NOT NULL DEFAULT ''");
  ensureIndexColumn(db, "architecture_summary", "vector_ref", "vector_ref TEXT NOT NULL DEFAULT ''");
  ensureIndexColumn(db, "architecture_summary", "vector_status", "vector_status TEXT NOT NULL DEFAULT 'not-indexed'");
}

/** Reads the stored catalog freshness digest or returns empty when no index exists. */
function readIndexDigest(indexPath) {
  if (!existsSync(indexPath)) return "";
  const db = openIndex(indexPath);
  try {
    createIndexSchema(db);
    return compactText(db.prepare("SELECT value FROM architecture_metadata WHERE key = ?").get("catalogDigest")?.value);
  } finally {
    db.close();
  }
}

/** Rebuilds all lexical and vector rows transactionally from the supplied repository catalog. */
export async function rebuildArchitectureAtlasIndex(options = {}) {
  const indexPath = requiredIndexPath(options.indexPath);
  const catalog = requiredCatalog(options.catalog);
  await mkdir(path.dirname(indexPath), { recursive: true });
  const digest = catalogDigest(catalog);
  const db = openIndex(indexPath);
  try {
    createIndexSchema(db);
    db.exec("BEGIN");
    try {
      db.exec("DELETE FROM architecture_metadata");
      db.exec("DELETE FROM architecture_token");
      db.exec("DELETE FROM architecture_vector");
      db.exec("DELETE FROM architecture_summary");
      const insertSummary = db.prepare(`
        INSERT INTO architecture_summary (
          id, element_type, label, owner, viewpoint, summary, generated_summary,
          summary_status, summary_source, summary_updated_at, summary_digest,
          freshness_status, freshness_digest, lexical_ref, vector_ref,
          vector_status, graph_endpoint, source_repos_json, facets_json,
          answers_json, source_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertToken = db.prepare("INSERT INTO architecture_token (element_id, token, weight) VALUES (?, ?, ?)");
      const insertVector = db.prepare(`
        INSERT INTO architecture_vector (
          element_id, vector_ref, vector_model, dimensions, source_digest,
          freshness_digest, vector_json, magnitude, source_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const room of catalog.rooms) {
        const vectorRow = architectureVectorForRoom(room);
        insertSummary.run(
          room.id, "architecture-room", room.label, room.owner, room.viewpoint,
          room.summary, room.generatedSummary || room.summary,
          room.summaryStatus || "provider-authored", room.summarySource || "provider-authored-fallback",
          room.summaryUpdatedAt || catalog.generatedAt, room.summaryDigest || "",
          room.freshnessStatus || "source-digest-current", room.freshnessDigest || room.summaryDigest || "",
          room.indexRefs?.lexical || `architecture_summary:${room.id}`, vectorRow.vectorRef, "indexed",
          room.metadata?.graphEndpoint || "", JSON.stringify(listFrom(room.sourceRepos)),
          JSON.stringify(listFrom(room.facets)), JSON.stringify(listFrom(room.answers)), JSON.stringify(room),
        );
        for (const token of weightedTokens(room)) insertToken.run(room.id, token.token, Number(token.weight.toFixed(3)));
        insertVector.run(
          vectorRow.elementId, vectorRow.vectorRef, vectorRow.vectorModel, vectorRow.dimensions,
          vectorRow.sourceDigest, vectorRow.freshnessDigest, JSON.stringify(vectorRow.vector),
          Number(vectorRow.magnitude.toFixed(6)), vectorRow.sourceText,
        );
      }
      const insertMetadata = db.prepare("INSERT INTO architecture_metadata (key, value) VALUES (?, ?)");
      for (const [key, value] of Object.entries({
        schema: "multihead-atlas.architecture_atlas_index.v1",
        catalogDigest: digest,
        generatedAt: catalog.generatedAt,
        vectorIndexed: "true",
        indexKind: "sqlite-token-index",
        summaryContract: "provider-owned-summary-freshness-v1",
        lexicalIndexKind: "sqlite-token-index",
        vectorIndexKind: ARCHITECTURE_VECTOR_INDEX_KIND,
        vectorModel: ARCHITECTURE_VECTOR_MODEL,
        vectorDimensions: String(ARCHITECTURE_VECTOR_DIMENSIONS),
        vectorStatus: "indexed",
      })) insertMetadata.run(key, value);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
  return {
    schema: "multihead-atlas.architecture_atlas_index.v1",
    status: "ready",
    indexPath,
    digest,
    generatedAt: catalog.generatedAt,
    indexKind: "sqlite-token-index",
    summaryContract: "provider-owned-summary-freshness-v1",
    lexicalIndexKind: "sqlite-token-index",
    vectorIndexKind: ARCHITECTURE_VECTOR_INDEX_KIND,
    vectorModel: ARCHITECTURE_VECTOR_MODEL,
    vectorDimensions: ARCHITECTURE_VECTOR_DIMENSIONS,
    vectorStatus: "indexed",
    vectorIndexed: true,
    metrics: {
      rooms: catalog.rooms.length,
      portals: catalog.portals.length,
      tokens: catalog.rooms.reduce((total, room) => total + weightedTokens(room).length, 0),
      generatedSummaries: catalog.rooms.filter((room) => room.summaryStatus === "generated").length,
      providerAuthoredSummaries: catalog.rooms.filter((room) => room.summaryStatus !== "generated").length,
      freshnessDigests: catalog.rooms.filter((room) => room.freshnessStatus === "source-digest-current" && room.freshnessDigest).length,
      vectorReady: catalog.rooms.length,
      vectorMissing: 0,
      vectorFreshnessDigests: catalog.rooms.length,
      vectorDimensions: ARCHITECTURE_VECTOR_DIMENSIONS,
    },
  };
}

/** Reuses a digest-current index and rebuilds only when catalog identity has changed. */
export async function ensureArchitectureAtlasIndex(options = {}) {
  const indexPath = requiredIndexPath(options.indexPath);
  const catalog = requiredCatalog(options.catalog);
  if (readIndexDigest(indexPath) === catalogDigest(catalog)) {
    return architectureAtlasIndexStatus({ indexPath, catalog, status: "ready" });
  }
  return rebuildArchitectureAtlasIndex({ ...options, catalog, indexPath });
}

/** Reports index schema, freshness metadata, and lexical/vector coverage without rebuilding. */
export function architectureAtlasIndexStatus(options = {}) {
  const indexPath = requiredIndexPath(options.indexPath);
  const catalog = requiredCatalog(options.catalog);
  if (!existsSync(indexPath)) {
    return {
      schema: "multihead-atlas.architecture_atlas_index.v1",
      status: "missing",
      indexPath,
      digest: "",
      generatedAt: "",
      indexKind: "sqlite-token-index",
      summaryContract: "provider-owned-summary-freshness-v1",
      lexicalIndexKind: "sqlite-token-index",
      vectorIndexKind: ARCHITECTURE_VECTOR_INDEX_KIND,
      vectorModel: ARCHITECTURE_VECTOR_MODEL,
      vectorDimensions: ARCHITECTURE_VECTOR_DIMENSIONS,
      vectorStatus: "missing",
      vectorIndexed: false,
      metrics: {
        rooms: 0, portals: catalog.portals.length, tokens: 0, generatedSummaries: 0,
        providerAuthoredSummaries: 0, freshnessDigests: 0, vectorReady: 0,
        vectorMissing: 0, vectorFreshnessDigests: 0, vectorDimensions: ARCHITECTURE_VECTOR_DIMENSIONS,
      },
    };
  }
  const db = openIndex(indexPath);
  try {
    createIndexSchema(db);
    const metadata = Object.fromEntries(db.prepare("SELECT key, value FROM architecture_metadata").all().map((row) => [row.key, row.value]));
    const summaryRow = db.prepare(`
      SELECT COUNT(*) AS rooms,
        SUM(CASE WHEN summary_status = 'generated' THEN 1 ELSE 0 END) AS generatedSummaries,
        SUM(CASE WHEN summary_status != 'generated' THEN 1 ELSE 0 END) AS providerAuthoredSummaries,
        SUM(CASE WHEN freshness_status = 'source-digest-current' AND freshness_digest != '' THEN 1 ELSE 0 END) AS freshnessDigests,
        SUM(CASE WHEN vector_status = 'indexed' THEN 1 ELSE 0 END) AS vectorReady,
        SUM(CASE WHEN vector_status != 'indexed' THEN 1 ELSE 0 END) AS vectorMissing
      FROM architecture_summary
    `).get();
    const tokenRow = db.prepare("SELECT COUNT(*) AS tokens FROM architecture_token").get();
    const vectorRow = db.prepare(`
      SELECT COUNT(*) AS vectorRows,
        SUM(CASE WHEN vector_model != '' THEN 1 ELSE 0 END) AS vectorModelRows,
        SUM(CASE WHEN dimensions = ? THEN 1 ELSE 0 END) AS vectorDimensionRows,
        SUM(CASE WHEN source_digest != '' AND freshness_digest != '' THEN 1 ELSE 0 END) AS vectorFreshnessDigests
      FROM architecture_vector
    `).get(ARCHITECTURE_VECTOR_DIMENSIONS);
    return {
      schema: metadata.schema || "multihead-atlas.architecture_atlas_index.v1",
      status: options.status || "ready",
      indexPath,
      digest: metadata.catalogDigest || "",
      generatedAt: metadata.generatedAt || "",
      indexKind: metadata.indexKind || "sqlite-token-index",
      summaryContract: metadata.summaryContract || "provider-owned-summary-freshness-v1",
      lexicalIndexKind: metadata.lexicalIndexKind || "sqlite-token-index",
      vectorIndexKind: metadata.vectorIndexKind || ARCHITECTURE_VECTOR_INDEX_KIND,
      vectorModel: metadata.vectorModel || ARCHITECTURE_VECTOR_MODEL,
      vectorDimensions: Number(metadata.vectorDimensions || ARCHITECTURE_VECTOR_DIMENSIONS),
      vectorStatus: metadata.vectorStatus || (metadata.vectorIndexed === "true" ? "indexed" : "not-indexed"),
      vectorIndexed: metadata.vectorIndexed === "true" && Number(vectorRow?.vectorRows || 0) >= Number(summaryRow?.rooms || 0),
      metrics: {
        rooms: Number(summaryRow?.rooms || 0),
        portals: catalog.portals.length,
        tokens: Number(tokenRow?.tokens || 0),
        generatedSummaries: Number(summaryRow?.generatedSummaries || 0),
        providerAuthoredSummaries: Number(summaryRow?.providerAuthoredSummaries || 0),
        freshnessDigests: Number(summaryRow?.freshnessDigests || 0),
        vectorReady: Number(vectorRow?.vectorRows || 0),
        vectorMissing: Math.max(0, Number(summaryRow?.rooms || 0) - Number(vectorRow?.vectorRows || 0)),
        vectorFreshnessDigests: Number(vectorRow?.vectorFreshnessDigests || 0),
        vectorModelRows: Number(vectorRow?.vectorModelRows || 0),
        vectorDimensionRows: Number(vectorRow?.vectorDimensionRows || 0),
        vectorDimensions: Number(metadata.vectorDimensions || ARCHITECTURE_VECTOR_DIMENSIONS),
      },
    };
  } finally {
    db.close();
  }
}

/** Converts one lexical score to a stable zero-to-one value using the result maximum. */
function normalizeSearchScore(score, maxScore) {
  if (!Number.isFinite(score) || !Number.isFinite(maxScore) || maxScore <= 0) return 0;
  return Number(Math.min(1, score / maxScore).toFixed(4));
}

/** Runs deterministic hybrid lexical/vector ranking and returns privacy-neutral room metadata. */
export function searchArchitectureAtlasIndex(options = {}) {
  const indexPath = requiredIndexPath(options.indexPath);
  const query = compactText(options.query);
  const normalizedQuery = query.toLowerCase();
  const limit = Math.max(1, Number(options.limit || 5));
  const tokens = uniqueStrings(tokenizeText(query));
  if (!tokens.length || !existsSync(indexPath)) {
    return { schema: "multihead-atlas.architecture_atlas_search.v1", query, status: existsSync(indexPath) ? "empty-query" : "index-missing", tokens, results: [] };
  }
  const db = openIndex(indexPath);
  try {
    createIndexSchema(db);
    const lexicalById = new Map();
    const placeholders = tokens.map(() => "?").join(", ");
    for (const row of db.prepare(`
      SELECT element_id AS id, token, weight FROM architecture_token
      WHERE token IN (${placeholders}) ORDER BY element_id ASC, token ASC
    `).all(...tokens)) {
      const current = lexicalById.get(row.id) || { lexicalScore: 0, matchedTokenValues: [] };
      current.lexicalScore += Number(row.weight || 0);
      current.matchedTokenValues.push(row.token);
      lexicalById.set(row.id, current);
    }
    const maxLexicalScore = Math.max(0, ...[...lexicalById.values()].map((row) => row.lexicalScore));
    const queryVector = architectureVectorForQuery(query);
    const rows = db.prepare(`
      SELECT s.id, s.label, s.owner, s.viewpoint, s.summary,
        s.generated_summary AS generatedSummary, s.summary_status AS summaryStatus,
        s.summary_source AS summarySource, s.summary_updated_at AS summaryUpdatedAt,
        s.summary_digest AS summaryDigest, s.freshness_status AS freshnessStatus,
        s.freshness_digest AS freshnessDigest, s.lexical_ref AS lexicalRef,
        s.vector_ref AS vectorRef, s.vector_status AS vectorStatus,
        s.graph_endpoint AS graphEndpoint, s.source_repos_json AS sourceReposJson,
        s.facets_json AS facetsJson, s.answers_json AS answersJson,
        v.vector_ref AS storedVectorRef, v.vector_model AS vectorModel,
        v.dimensions AS vectorDimensions, v.source_digest AS vectorSourceDigest,
        v.freshness_digest AS vectorFreshnessDigest, v.vector_json AS vectorJson
      FROM architecture_summary s LEFT JOIN architecture_vector v ON v.element_id = s.id
      ORDER BY s.label ASC, s.id ASC
    `).all();
    const scoredRows = rows.map((row) => {
      const lexical = lexicalById.get(row.id) || { lexicalScore: 0, matchedTokenValues: [] };
      let vector = [];
      try { vector = JSON.parse(row.vectorJson || "[]"); } catch { vector = []; }
      const lexicalNormalizedScore = normalizeSearchScore(lexical.lexicalScore, maxLexicalScore);
      const vectorScore = row.vectorStatus === "indexed" ? cosineSimilarity(queryVector, vector) : 0;
      const combinedScore = row.vectorStatus === "indexed"
        ? Number(((lexicalNormalizedScore * 0.55) + (vectorScore * 0.45)).toFixed(4))
        : lexicalNormalizedScore;
      return {
        ...row,
        ...lexical,
        matchedTokens: lexical.matchedTokenValues.length,
        exactRoomIdMatch: normalizedQuery.includes(String(row.id || "").toLowerCase()),
        lexicalNormalizedScore,
        vectorScore,
        combinedScore,
      };
    }).sort((left, right) => {
      // Explicit stable room ids are navigation authority. Fuzzy label and
      // summary scores only order candidates when no exact id is present.
      if (left.exactRoomIdMatch !== right.exactRoomIdMatch) return left.exactRoomIdMatch ? -1 : 1;
      return right.combinedScore - left.combinedScore
      || right.vectorScore - left.vectorScore
      || right.lexicalScore - left.lexicalScore
      || left.label.localeCompare(right.label)
      || left.id.localeCompare(right.id);
    }).slice(0, limit);
    return {
      schema: "multihead-atlas.architecture_atlas_search.v1",
      query,
      status: "pass",
      tokens,
      scoring: {
        lexicalWeight: 0.55,
        vectorWeight: 0.45,
        vectorIndexKind: ARCHITECTURE_VECTOR_INDEX_KIND,
        vectorModel: ARCHITECTURE_VECTOR_MODEL,
        vectorDimensions: ARCHITECTURE_VECTOR_DIMENSIONS,
      },
      results: scoredRows.map((row) => ({
        id: row.id, label: row.label, owner: row.owner, viewpoint: row.viewpoint,
        summary: row.summary, generatedSummary: row.generatedSummary,
        summaryStatus: row.summaryStatus, summarySource: row.summarySource,
        summaryUpdatedAt: row.summaryUpdatedAt, summaryDigest: row.summaryDigest,
        freshnessStatus: row.freshnessStatus, freshnessDigest: row.freshnessDigest,
        indexRefs: { lexical: row.lexicalRef, vector: row.vectorRef || row.storedVectorRef },
        vectorStatus: row.vectorStatus, vectorIndexKind: ARCHITECTURE_VECTOR_INDEX_KIND,
        vectorModel: row.vectorModel || ARCHITECTURE_VECTOR_MODEL,
        vectorDimensions: Number(row.vectorDimensions || ARCHITECTURE_VECTOR_DIMENSIONS),
        vectorSourceDigest: row.vectorSourceDigest || "", vectorFreshnessDigest: row.vectorFreshnessDigest || "",
        graphEndpoint: row.graphEndpoint, sourceRepos: JSON.parse(row.sourceReposJson || "[]"),
        facets: JSON.parse(row.facetsJson || "[]"), answers: JSON.parse(row.answersJson || "[]"),
        exactRoomIdMatch: row.exactRoomIdMatch,
        lexicalScore: Number(Number(row.lexicalScore || 0).toFixed(4)),
        lexicalNormalizedScore: Number(row.lexicalNormalizedScore || 0),
        vectorScore: Number(row.vectorScore || 0), normalizedScore: Number(row.combinedScore || 0),
        combinedScore: Number(row.combinedScore || 0),
        scoreSource: row.vectorStatus === "indexed" ? "sqlite-token-vector-index" : "sqlite-token-index",
        matchedTokens: Number(row.matchedTokens || 0),
        matchedTokenValues: uniqueStrings(row.matchedTokenValues || []).sort(),
      })),
    };
  } finally {
    db.close();
  }
}

/** Derives the stable label-and-id query used to measure per-room retrieval quality. */
function lexicalQualityQuery(room = {}) {
  return uniqueStrings([compactText(room.label), compactText(room.id)]).join(" ");
}

/** Measures whether every catalog room is returned within the required lexical top-three rank. */
export function architectureLexicalRetrievalQuality(options = {}) {
  const catalog = requiredCatalog(options.catalog);
  const indexPath = requiredIndexPath(options.indexPath);
  const limit = Math.max(3, Number(options.limit || 5));
  const checks = catalog.rooms.map((room) => {
    const query = lexicalQualityQuery(room);
    const search = searchArchitectureAtlasIndex({ query, limit, indexPath });
    const resultIds = listFrom(search.results).map((result) => result.id);
    const rank = resultIds.indexOf(room.id) + 1;
    return {
      roomId: room.id, label: room.label, query,
      status: rank > 0 && rank <= 3 ? "pass" : "miss", rank,
      topResultId: resultIds[0] || "",
      matchedTokens: Number(search.results?.[0]?.matchedTokens || 0),
      normalizedScore: Number(search.results?.[0]?.normalizedScore || 0),
    };
  });
  const top1Hits = checks.filter((check) => check.rank === 1).length;
  const topKHits = checks.filter((check) => check.rank > 0 && check.rank <= 3).length;
  const misses = checks.filter((check) => check.rank < 1);
  const outsideTopK = checks.filter((check) => check.rank > 3);
  const roomCount = checks.length;
  const pass = existsSync(indexPath) && roomCount > 0 && misses.length === 0 && outsideTopK.length === 0;
  return {
    schema: "multihead-atlas.architecture_lexical_retrieval_quality.v1",
    status: pass ? "pass" : (existsSync(indexPath) ? "fail" : "index-missing"),
    indexPath, queryBasis: "room-label-and-id", requiredTopK: 3,
    rooms: roomCount, queries: checks.length, top1Hits, topKHits,
    misses: misses.length, outsideTopK: outsideTopK.length,
    top1Coverage: roomCount ? Number((top1Hits / roomCount).toFixed(4)) : 0,
    topKCoverage: roomCount ? Number((topKHits / roomCount).toFixed(4)) : 0,
    sampleFailures: [...misses, ...outsideTopK].slice(0, 5),
  };
}

/** Measures vector readiness and top-three room recovery across the complete supplied catalog. */
export function architectureVectorRetrievalQuality(options = {}) {
  const catalog = requiredCatalog(options.catalog);
  const indexPath = requiredIndexPath(options.indexPath);
  const limit = Math.max(3, Number(options.limit || 5));
  const indexStatus = architectureAtlasIndexStatus({ catalog, indexPath });
  const checks = catalog.rooms.map((room) => {
    const query = lexicalQualityQuery(room);
    const search = searchArchitectureAtlasIndex({ query, limit, indexPath });
    const resultIds = listFrom(search.results).map((result) => result.id);
    const result = listFrom(search.results).find((row) => row.id === room.id) || null;
    const rank = resultIds.indexOf(room.id) + 1;
    return {
      roomId: room.id, label: room.label, query,
      status: rank > 0 && rank <= 3 && Number(result?.vectorScore || 0) > 0 ? "pass" : "miss",
      rank, topResultId: resultIds[0] || "", vectorScore: Number(result?.vectorScore || 0),
      combinedScore: Number(result?.combinedScore || result?.normalizedScore || 0),
      vectorStatus: compactText(result?.vectorStatus),
    };
  });
  const top1Hits = checks.filter((check) => check.rank === 1).length;
  const topKHits = checks.filter((check) => check.rank > 0 && check.rank <= 3).length;
  const misses = checks.filter((check) => check.status !== "pass");
  const roomCount = checks.length;
  const pass = existsSync(indexPath) && indexStatus.vectorIndexed === true
    && Number(indexStatus.metrics?.vectorReady || 0) >= roomCount && roomCount > 0 && misses.length === 0;
  return {
    schema: "multihead-atlas.architecture_vector_retrieval_quality.v1",
    status: pass ? "pass" : (existsSync(indexPath) ? "fail" : "index-missing"),
    indexPath, queryBasis: "room-label-and-id",
    vectorIndexKind: indexStatus.vectorIndexKind || ARCHITECTURE_VECTOR_INDEX_KIND,
    vectorModel: indexStatus.vectorModel || ARCHITECTURE_VECTOR_MODEL,
    vectorDimensions: Number(indexStatus.vectorDimensions || ARCHITECTURE_VECTOR_DIMENSIONS),
    requiredTopK: 3, rooms: roomCount, queries: checks.length,
    top1Hits, topKHits, misses: misses.length,
    top1Coverage: roomCount ? Number((top1Hits / roomCount).toFixed(4)) : 0,
    topKCoverage: roomCount ? Number((topKHits / roomCount).toFixed(4)) : 0,
    sampleFailures: misses.slice(0, 5),
  };
}

/** Describes the configured generation provider, required capabilities, and disabled fallback policy. */
export function architectureGenerationProviderContract(options = {}) {
  const configuredProvider = compactText(
    options.provider || process.env.MEMORY_ATLAS_LLM_PROVIDER
      || process.env.MEMORY_RAG_LLM_PROVIDER || DEFAULT_ARCHITECTURE_GENERATION_PROVIDER,
  ).toLowerCase();
  const configured = Boolean(configuredProvider) && !["off", "none", "disabled"].includes(configuredProvider);
  const interactiveDefault = configuredProvider === DEFAULT_ARCHITECTURE_GENERATION_PROVIDER
    || configuredProvider === "codex-agent";
  return {
    required: true,
    status: configured ? (interactiveDefault ? "interactive-default" : "configured") : "missing-provider",
    provider: configured ? configuredProvider : "unconfigured",
    layer: "generation-provider",
    requiredCapabilities: [
      "source-derived-room-spec-generation", "workspace-entry-summary-generation",
      "node-source-summary-generation", "route-explanation-generation",
      "freshness-digest-invalidation", "inspectable-confidence-and-provenance",
    ],
    outputContract: "source-derived slice spec with provenance, diagnostics, confidence, and freshness",
    executionMode: interactiveDefault ? "current-agent-handshake" : "command-adapter",
    fallbackPolicy: "repository-source-scan-only when provider is disabled; do not synthesize higher-level rooms without a source-derived provider artifact",
  };
}

/** Builds the observable end-to-end retrieval capability contract and its current gaps. */
export function architectureRetrievalContract({ route, catalog, index, generationProvider } = {}) {
  const checkedCatalog = requiredCatalog(catalog);
  const indexStatus = index || architectureAtlasIndexStatus({ catalog: checkedCatalog, indexPath: index?.indexPath });
  const lexicalQuality = architectureLexicalRetrievalQuality({ catalog: checkedCatalog, indexPath: indexStatus.indexPath });
  const vectorQuality = architectureVectorRetrievalQuality({ catalog: checkedCatalog, indexPath: indexStatus.indexPath });
  const generation = architectureGenerationProviderContract(generationProvider);
  return {
    mode: indexStatus.status === "ready" ? "sqlite-token-index" : "catalog",
    indexed: indexStatus.status === "ready",
    vectorIndexed: indexStatus.vectorIndexed === true,
    generationProvider: generation,
    generatedSummaries: {
      required: true,
      status: indexStatus.metrics?.generatedSummaries > 0 ? "ready" : "provider-authored-fallback",
      available: indexStatus.metrics?.generatedSummaries || 0,
      providerAuthoredFallbacks: indexStatus.metrics?.providerAuthoredSummaries || 0,
    },
    summaryFreshness: {
      required: true,
      status: indexStatus.metrics?.rooms > 0 && indexStatus.metrics?.freshnessDigests >= indexStatus.metrics?.rooms ? "digest-current" : "missing-digests",
      digestCount: indexStatus.metrics?.freshnessDigests || 0,
      summaryCount: indexStatus.metrics?.rooms || 0,
      contract: indexStatus.summaryContract || "provider-owned-summary-freshness-v1",
    },
    lexicalIndex: {
      required: true,
      status: indexStatus.status === "ready" && Number(indexStatus.metrics?.tokens || 0) > 0 ? "ready" : "missing",
      kind: indexStatus.lexicalIndexKind || indexStatus.indexKind || "sqlite-token-index",
      tokenCount: Number(indexStatus.metrics?.tokens || 0),
      qualityStatus: lexicalQuality.status,
      top1Coverage: lexicalQuality.top1Coverage,
      topKCoverage: lexicalQuality.topKCoverage,
    },
    lexicalRetrievalQuality: lexicalQuality,
    vectorIndex: {
      required: true,
      status: indexStatus.vectorIndexed === true ? "ready" : "missing",
      vectorStatus: indexStatus.vectorStatus || "not-indexed",
      kind: indexStatus.vectorIndexKind || ARCHITECTURE_VECTOR_INDEX_KIND,
      model: indexStatus.vectorModel || ARCHITECTURE_VECTOR_MODEL,
      dimensions: Number(indexStatus.vectorDimensions || ARCHITECTURE_VECTOR_DIMENSIONS),
      indexedRows: Number(indexStatus.metrics?.vectorReady || 0),
      missingRows: Number(indexStatus.metrics?.vectorMissing || 0),
      freshnessDigests: Number(indexStatus.metrics?.vectorFreshnessDigests || 0),
      qualityStatus: vectorQuality.status,
      top1Coverage: vectorQuality.top1Coverage,
      topKCoverage: vectorQuality.topKCoverage,
    },
    vectorRetrievalQuality: vectorQuality,
    activeLayers: [
      "repository-task-route", "workspace-entry-catalog", "sqlite-token-index",
      "sqlite-local-vector-index", "summary-freshness-digest",
      "typed-workspace-relationships", "source-registry",
    ],
    requiredLayers: [
      "generated-workspace-entry-summaries", "generated-node-summaries",
      "generation-provider", "vector-index", "inspectable-ranking",
    ],
    capabilityGaps: [
      ...(generation.status === "missing-provider" ? ["generation-provider"] : []),
      ...(indexStatus.metrics?.generatedSummaries > 0 ? [] : ["generated-workspace-entry-summaries"]),
      ...(indexStatus.vectorIndexed ? [] : ["vector-index"]),
    ],
    rankingParts: [
      "route/task match", "workspace entry summary fit", "sqlite lexical score",
      "sqlite vector similarity", "source repo/facet overlap", "authority/freshness",
      "workspace relationship traversal cost",
    ],
    routeStatus: route ? "pass" : "route-missing",
    index: indexStatus,
  };
}
