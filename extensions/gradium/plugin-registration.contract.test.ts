import { describePluginRegistrationContract } from "allbot/plugin-sdk/plugin-test-contracts";

describePluginRegistrationContract({
  pluginId: "gradium",
  speechProviderIds: ["gradium"],
});
