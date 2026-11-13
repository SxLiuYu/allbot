import { definePluginEntry } from "allbot/plugin-sdk/plugin-entry";
import { createArgoWebSearchProvider } from "./src/argo-search-provider.js";

export default definePluginEntry({
  id: "argo",
  name: "Argo Search Plugin",
  description:
    "Bundled Argo web search. Aggregates hundreds of sources with no API key required.",
  register(api) {
    api.registerWebSearchProvider(createArgoWebSearchProvider());
  },
});
