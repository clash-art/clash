import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

export default withMermaid(defineConfig({
  title: "Clash Developer Docs",
  description:
    "Model cards, providers, executable plugins, and SDKs for the Clash local-first video production platform.",
  lang: "en-US",
  lastUpdated: true,
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Plugin System", link: "/plugins/overview" },
      { text: "SDKs", link: "/sdk/overview" },
      { text: "Reference", link: "/reference/cli" },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "Guide",
          items: [
            { text: "Getting Started", link: "/guide/getting-started" },
            { text: "Architecture", link: "/guide/architecture" },
            {
              text: "Durable Run Protocol",
              link: "/guide/durable-run-protocol",
            },
            { text: "Asset System", link: "/guide/asset-system" },
            { text: "Build Architecture", link: "/guide/build-architecture" },
            {
              text: "Model Cards, Providers & Bindings",
              link: "/guide/model-cards",
            },
            {
              text: "Tutorial: Add a Model or Provider",
              link: "/guide/add-model-provider",
            },
            { text: "Local ASR & Transcripts", link: "/guide/local-asr" },
            {
              text: "Director Stage for Beginners",
              link: "/guide/director-stage-for-beginners",
            },
            {
              text: "Reusable Generator Code · Director",
              link: "/guide/reusable-plugin-content",
            },
            { text: "What a Test May Assert", link: "/guide/testing-rules" },
          ],
        },
      ],
      "/plugins/": [
        {
          text: "Executable Plugins",
          items: [
            { text: "Overview", link: "/plugins/overview" },
            { text: "Authoring Workflow", link: "/plugins/authoring" },
            { text: "Identity", link: "/plugins/identity" },
            { text: "Manifest & Artifacts", link: "/plugins/manifest" },
            { text: "Choosing a Strategy", link: "/plugins/strategies" },
            { text: "Waiting for a Provider", link: "/plugins/waiting" },
            { text: "Provider Auth", link: "/plugins/plugin-provider-auth" },
            { text: "Host-scoped SDK Context", link: "/plugins/sdk-context" },
            { text: "Contract Tests", link: "/plugins/contract-tests" },
            {
              text: "Traffic Record & Replay",
              link: "/plugins/traffic-replay",
            },
          ],
        },
      ],
      "/sdk/": [
        {
          text: "SDKs",
          items: [
            { text: "Overview", link: "/sdk/overview" },
            { text: "@clash/sdk", link: "/sdk/clash-sdk" },
            { text: "Python SDK", link: "/sdk/python-sdk" },
            { text: "@clash/action-sdk", link: "/sdk/action-sdk" },
            { text: "MCP Server", link: "/sdk/mcp" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "Reference",
          items: [
            { text: "CLI", link: "/reference/cli" },
            {
              text: "Local API & Host Discovery",
              link: "/reference/local-api",
            },
            { text: "Environment Variables", link: "/reference/environment" },
          ],
        },
      ],
    },
    outline: { level: [2, 3] },
    search: { provider: "local" },
  },
}));
