/*
 * Repository Provider owns the stable product boundary between Atlas retrieval
 * code and repository-owned memory. Consumers inject repository identity,
 * catalog, and index path; this module does not discover consumer sources or
 * fall back to process-local workspace defaults.
 */

import path from "node:path";
import {
  architectureAtlasIndexStatus,
  architectureLexicalRetrievalQuality,
  architectureRetrievalContract,
  architectureVectorRetrievalQuality,
  ensureArchitectureAtlasIndex,
  rebuildArchitectureAtlasIndex,
  searchArchitectureAtlasIndex,
} from "./retrieval-engine.mjs";

export const ATLAS_REPOSITORY_PROVIDER_CONTRACT = Object.freeze({
  schema: "multihead-atlas.repository_provider_contract.v1",
  contractVersion: 1,
  baselineVersion: "0.2.0",
  requiredInputs: ["repositoryId", "catalog", "indexPath"],
  sourceAuthority: "consumer-repository",
  indexAuthority: "consumer-repository-local-generated-output",
});

/** Validates one required repository-provider identity or query text field. */
function requiredText(value, field) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`Atlas repository provider requires ${field}`);
  return text;
}

/** Validates the minimum repository catalog shape required by every retrieval operation. */
function validatedCatalog(value) {
  if (!value || typeof value !== "object") {
    throw new Error("Atlas repository provider requires catalog object");
  }
  if (!String(value.schema || "").trim()) {
    throw new Error("Atlas repository provider catalog requires schema");
  }
  if (!String(value.authority || "").trim()) {
    throw new Error("Atlas repository provider catalog requires authority");
  }
  if (!Array.isArray(value.rooms) || !Array.isArray(value.portals)) {
    throw new Error("Atlas repository provider catalog requires rooms and portals arrays");
  }
  return value;
}

/** Normalizes the explicitly supplied absolute path for machine-local generated index state. */
function validatedIndexPath(value) {
  const indexPath = requiredText(value, "indexPath");
  if (!path.isAbsolute(indexPath)) {
    throw new Error("Atlas repository provider indexPath must be absolute");
  }
  return path.normalize(indexPath);
}

/**
 * Binds the reusable Atlas index/search implementation to one repository-owned
 * catalog and one machine-local index. Every delegated call supplies both
 * values so no ambient provider defaults can become repository authority.
 */
export function createAtlasRepositoryProvider(options = {}) {
  const repositoryId = requiredText(options.repositoryId, "repositoryId");
  const catalog = validatedCatalog(options.catalog);
  const indexPath = validatedIndexPath(options.indexPath);
  const generationProvider = requiredText(
    options.generationProvider || `${repositoryId}-atlas-catalog`,
    "generationProvider",
  );

  /** Returns the immutable repository bindings supplied to index lifecycle operations. */
  const boundOptions = () => ({ catalog, indexPath, generationProvider });
  const provider = {
    schema: "multihead-atlas.repository_provider_instance.v1",
    contract: ATLAS_REPOSITORY_PROVIDER_CONTRACT,
    repositoryId,
    indexPath,
    /** Describes provider identity, authority, catalog cardinality, and local index binding. */
    describe() {
      return {
        schema: this.schema,
        contract: this.contract,
        repositoryId,
        catalogSchema: catalog.schema,
        catalogAuthority: catalog.authority,
        roomCount: catalog.rooms.length,
        portalCount: catalog.portals.length,
        indexPath,
        generationProvider,
      };
    },
    /** Rebuilds the repository-local index from the provider's bound catalog authority. */
    rebuild() {
      return rebuildArchitectureAtlasIndex(boundOptions());
    },
    /** Ensures the local index exists and matches the current bound catalog digest. */
    ensure() {
      return ensureArchitectureAtlasIndex(boundOptions());
    },
    /** Reports index existence, schema, freshness, and vector coverage without modifying state. */
    status() {
      return architectureAtlasIndexStatus(boundOptions());
    },
    /** Runs bounded hybrid retrieval against the provider's explicit machine-local index. */
    search(options = {}) {
      const query = requiredText(options.query, "search query");
      const requestedLimit = Number(options.limit || 8);
      const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.floor(requestedLimit)) : 8;
      return searchArchitectureAtlasIndex({ query, limit, indexPath });
    },
    /** Computes lexical fixture quality for the repository catalog and current index. */
    lexicalQuality() {
      return architectureLexicalRetrievalQuality(boundOptions());
    },
    /** Computes deterministic vector fixture quality for the bound repository catalog. */
    vectorQuality() {
      return architectureVectorRetrievalQuality(boundOptions());
    },
    /** Builds the observable retrieval contract from route, catalog, index, and provider facts. */
    retrievalContract(options = {}) {
      const index = options.index || provider.status();
      return architectureRetrievalContract({
        route: options.route,
        catalog,
        index,
        generationProvider,
      });
    },
  };
  return Object.freeze(provider);
}
