/*
 * The Vite configuration binds the standalone Graph development server to an
 * explicitly supplied Atlas provider while keeping production source neutral.
 * An installed launcher may supply a response identity that lets Atlas prove
 * the served lens belongs to its exact package and provider binding.
 */
const atlasProxyTarget = process.env.MH_ATLAS_BASE_URL || "http://127.0.0.1:8765";
const atlasGraphRuntimeIdentity = process.env.MH_ATLAS_GRAPH_RUNTIME_IDENTITY || "";
const atlasGraphRuntimeHeaders = atlasGraphRuntimeIdentity
  ? { "X-Atlas-Graph-Runtime-Identity": atlasGraphRuntimeIdentity }
  : {};

export default {
  server: {
    host: "127.0.0.1",
    port: 8910,
    strictPort: false,
    headers: atlasGraphRuntimeHeaders,
    proxy: {
      "/api": atlasProxyTarget,
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 8911,
    strictPort: false,
    headers: atlasGraphRuntimeHeaders,
    proxy: {
      "/api": atlasProxyTarget,
    },
  },
};
