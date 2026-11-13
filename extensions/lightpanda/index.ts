import { definePluginEntry } from "allbot/plugin-sdk/plugin-entry";
import { createLightpandaWebFetchProvider } from "./src/lightpanda-fetch-provider.js";

export default definePluginEntry({
  id: "lightpanda",
  name: "Lightpanda Plugin",
  description: "Bundled Lightpanda page fetching. Renders pages to markdown with no API key.",
  register(api) {
    api.registerWebFetchProvider(createLightpandaWebFetchProvider());
  },
});
