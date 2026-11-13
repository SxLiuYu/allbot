import { resolveCorrectionUserId } from "../cognitive/correction/userid.js";
import {
  consumeEvolutionDecision,
  consumeSkillDeleteConfirmation,
} from "../cognitive/evolution/approval-store.js";
import { tasksEnabled } from "../cognitive/tasks/service.js";
import type { AllBotConfig } from "../config/config.js";
import { callGateway } from "../gateway/call.js";
import { getActiveRuntimeWebToolsMetadata } from "../secrets/runtime.js";
import { ownerTasksEnabled } from "../tasks/owner/config.js";
import { canRegisterOwnerTaskWriteTools } from "../tasks/owner/session-policy.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import type { GatewayMessageChannel } from "../utils/message-channel.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "./agent-scope.js";
import { resolveAllBotPluginToolsForOptions } from "./allbot-plugin-tools.js";
import {
  collectPresentAllBotTools,
  isUpdatePlanToolEnabledForAllBotTools,
} from "./allbot-tools.registration.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import type { SpawnedToolContext } from "./spawned-context.js";
import type { ToolFsPolicy } from "./tool-fs-policy.js";
import { createAgentsListTool } from "./tools/agents-list-tool.js";
import { createCanvasTool } from "./tools/canvas-tool.js";
import { createCognitiveFeedbackTool } from "./tools/cognitive-feedback-tool.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createContextShowTool } from "./tools/context-show-tool.js";
import { createCorrectionReportTool } from "./tools/correction-report-tool.js";
import { createCronTool } from "./tools/cron-tool.js";
import { createDialogueListTool } from "./tools/dialogue-list-tool.js";
import { createEvolutionArchiveTool } from "./tools/evolution-archive-tool.js";
import { createEvolutionDeleteTool } from "./tools/evolution-delete-tool.js";
import { createEvolutionPatchTool } from "./tools/evolution-patch-tool.js";
import { createEvolutionSuggestTool } from "./tools/evolution-suggest-tool.js";
import { createGatewayTool } from "./tools/gateway-tool.js";
import { createImageGenerateTool } from "./tools/image-generate-tool.js";
import { createImageTool } from "./tools/image-tool.js";
import { createMcpConfigTool } from "./tools/mcp-config-tool.js";
import { createMessageTool } from "./tools/message-tool.js";
import { createMusicGenerateTool } from "./tools/music-generate-tool.js";
import { createNodesTool } from "./tools/nodes-tool.js";
import {
  createOwnerTaskAcceptTool,
  createOwnerTaskCancelTool,
  createOwnerTaskGetTool,
  createOwnerTaskListTool,
  createOwnerTaskRejectTool,
} from "./tools/owner-task-tool.js";
import { createPdfTool } from "./tools/pdf-tool.js";
import { createSessionStatusTool } from "./tools/session-status-tool.js";
import { createSessionTranscriptTool } from "./tools/session-transcript-tool.js";
import { createSessionsHistoryTool } from "./tools/sessions-history-tool.js";
import { createSessionsListTool } from "./tools/sessions-list-tool.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";
import { createSessionsYieldTool } from "./tools/sessions-yield-tool.js";
import { createSwitchSoulTool } from "./tools/soul-preset-tool.js";
import { createSubagentsTool } from "./tools/subagents-tool.js";
import {
  createTaskStatusTool,
  createTaskStepReportTool,
  createTaskTool,
} from "./tools/task-tool.js";
import { createTtsTool } from "./tools/tts-tool.js";
import { createUpdatePlanTool } from "./tools/update-plan-tool.js";
import { createVideoGenerateTool } from "./tools/video-generate-tool.js";
import { createWebFetchTool, createWebSearchTool } from "./tools/web-tools.js";
import { resolveWorkspaceRoot } from "./workspace-dir.js";

type AllBotToolsDeps = {
  callGateway: typeof callGateway;
  config?: AllBotConfig;
};

const defaultAllBotToolsDeps: AllBotToolsDeps = {
  callGateway,
};

let allBotToolsDeps: AllBotToolsDeps = defaultAllBotToolsDeps;

export function createAllBotTools(
  options?: {
    sandboxBrowserBridgeUrl?: string;
    allowHostBrowserControl?: boolean;
    agentSessionKey?: string;
    agentChannel?: GatewayMessageChannel;
    agentAccountId?: string;
    /** Delivery target (e.g. telegram:group:123:topic:456) for topic/thread routing. */
    agentTo?: string;
    /** Thread/topic identifier for routing replies to the originating thread. */
    agentThreadId?: string | number;
    agentDir?: string;
    sandboxRoot?: string;
    sandboxFsBridge?: SandboxFsBridge;
    fsPolicy?: ToolFsPolicy;
    sandboxed?: boolean;
    config?: AllBotConfig;
    pluginToolAllowlist?: string[];
    /** Current channel ID for auto-threading (Slack). */
    currentChannelId?: string;
    /** Current thread timestamp for auto-threading (Slack). */
    currentThreadTs?: string;
    /** Current inbound message id for action fallbacks (e.g. Telegram react). */
    currentMessageId?: string | number;
    /** Reply-to mode for Slack auto-threading. */
    replyToMode?: "off" | "first" | "all" | "batched";
    /** Mutable ref to track if a reply was sent (for "first" mode). */
    hasRepliedRef?: { value: boolean };
    /** If true, the model has native vision capability */
    modelHasVision?: boolean;
    /** Active model provider for provider-specific tool gating. */
    modelProvider?: string;
    /** If true, nodes action="invoke" can call media-returning commands directly. */
    allowMediaInvokeCommands?: boolean;
    /** Explicit agent ID override for cron/hook sessions. */
    requesterAgentIdOverride?: string;
    /** Require explicit message targets (no implicit last-route sends). */
    requireExplicitMessageTarget?: boolean;
    /** If true, omit the message tool from the tool list. */
    disableMessageTool?: boolean;
    /** If true, skip plugin tool resolution and return only shipped core tools. */
    disablePluginTools?: boolean;
    /** Trusted sender id from inbound context (not tool args). */
    requesterSenderId?: string | null;
    /** Whether the requesting sender is an owner. */
    senderIsOwner?: boolean;
    /** Ephemeral session UUID — regenerated on /new and /reset. */
    sessionId?: string;
    /**
     * Workspace directory to pass to spawned subagents for inheritance.
     * Defaults to workspaceDir. Use this to pass the actual agent workspace when the
     * session itself is running in a copied-workspace sandbox (`ro` or `none`) so
     * subagents inherit the real workspace path instead of the sandbox copy.
     */
    spawnWorkspaceDir?: string;
    /** Callback invoked when sessions_yield tool is called. */
    onYield?: (message: string) => Promise<void> | void;
    /** Allow plugin tools for this tool set to late-bind the gateway subagent. */
    allowGatewaySubagentBinding?: boolean;
  } & SpawnedToolContext,
): AnyAgentTool[] {
  const resolvedConfig = options?.config ?? allBotToolsDeps.config;
  const isRouterSession = canRegisterOwnerTaskWriteTools(options?.agentSessionKey);
  const sessionAgentId = resolveSessionAgentId({
    sessionKey: options?.agentSessionKey,
    config: resolvedConfig,
  });
  // Fall back to the session agent workspace so plugin loading stays workspace-stable
  // even when a caller forgets to thread workspaceDir explicitly.
  const inferredWorkspaceDir =
    options?.workspaceDir || !resolvedConfig
      ? undefined
      : resolveAgentWorkspaceDir(resolvedConfig, sessionAgentId);
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir ?? inferredWorkspaceDir);
  const spawnWorkspaceDir = resolveWorkspaceRoot(
    options?.spawnWorkspaceDir ?? options?.workspaceDir ?? inferredWorkspaceDir,
  );
  const deliveryContext = normalizeDeliveryContext({
    channel: options?.agentChannel,
    to: options?.agentTo,
    accountId: options?.agentAccountId,
    threadId: options?.agentThreadId,
  });
  const runtimeWebTools = getActiveRuntimeWebToolsMetadata();
  const sandbox =
    options?.sandboxRoot && options?.sandboxFsBridge
      ? { root: options.sandboxRoot, bridge: options.sandboxFsBridge }
      : undefined;
  const imageTool = options?.agentDir?.trim()
    ? createImageTool({
        config: options?.config,
        agentDir: options.agentDir,
        workspaceDir,
        sandbox,
        fsPolicy: options?.fsPolicy,
        modelHasVision: options?.modelHasVision,
      })
    : null;
  const imageGenerateTool = createImageGenerateTool({
    config: options?.config,
    agentDir: options?.agentDir,
    workspaceDir,
    sandbox,
    fsPolicy: options?.fsPolicy,
  });
  const videoGenerateTool = createVideoGenerateTool({
    config: options?.config,
    agentDir: options?.agentDir,
    agentSessionKey: options?.agentSessionKey,
    requesterOrigin: deliveryContext ?? undefined,
    workspaceDir,
    sandbox,
    fsPolicy: options?.fsPolicy,
  });
  const musicGenerateTool = createMusicGenerateTool({
    config: options?.config,
    agentDir: options?.agentDir,
    agentSessionKey: options?.agentSessionKey,
    requesterOrigin: deliveryContext ?? undefined,
    workspaceDir,
    sandbox,
    fsPolicy: options?.fsPolicy,
  });
  const pdfTool = options?.agentDir?.trim()
    ? createPdfTool({
        config: options?.config,
        agentDir: options.agentDir,
        workspaceDir,
        sandbox,
        fsPolicy: options?.fsPolicy,
      })
    : null;
  const webSearchTool = createWebSearchTool({
    config: options?.config,
    sandboxed: options?.sandboxed,
    runtimeWebSearch: runtimeWebTools?.search,
  });
  const webFetchTool = createWebFetchTool({
    config: options?.config,
    sandboxed: options?.sandboxed,
    runtimeWebFetch: runtimeWebTools?.fetch,
  });
  const messageTool = options?.disableMessageTool
    ? null
    : createMessageTool({
        agentAccountId: options?.agentAccountId,
        agentSessionKey: options?.agentSessionKey,
        sessionId: options?.sessionId,
        config: options?.config,
        currentChannelId: options?.currentChannelId,
        currentChannelProvider: options?.agentChannel,
        currentThreadTs: options?.currentThreadTs,
        currentMessageId: options?.currentMessageId,
        replyToMode: options?.replyToMode,
        hasRepliedRef: options?.hasRepliedRef,
        sandboxRoot: options?.sandboxRoot,
        requireExplicitTarget: options?.requireExplicitMessageTarget,
        requesterSenderId: options?.requesterSenderId ?? undefined,
      });
  const tools: AnyAgentTool[] = [
    createCanvasTool({ config: options?.config }),
    createNodesTool({
      agentSessionKey: options?.agentSessionKey,
      agentChannel: options?.agentChannel,
      agentAccountId: options?.agentAccountId,
      currentChannelId: options?.currentChannelId,
      currentThreadTs: options?.currentThreadTs,
      config: options?.config,
      modelHasVision: options?.modelHasVision,
      allowMediaInvokeCommands: options?.allowMediaInvokeCommands,
    }),
    createCronTool({
      agentSessionKey: options?.agentSessionKey,
    }),
    ...(messageTool ? [messageTool] : []),
    createTtsTool({
      agentChannel: options?.agentChannel,
      config: options?.config,
    }),
    ...collectPresentAllBotTools([imageGenerateTool, musicGenerateTool, videoGenerateTool]),
    createGatewayTool({
      agentSessionKey: options?.agentSessionKey,
      config: options?.config,
    }),
    createMcpConfigTool(),
    createAgentsListTool({
      agentSessionKey: options?.agentSessionKey,
      requesterAgentIdOverride: options?.requesterAgentIdOverride,
    }),
    ...(isUpdatePlanToolEnabledForAllBotTools(resolvedConfig, options?.modelProvider)
      ? [createUpdatePlanTool()]
      : []),
    createSessionsListTool({
      agentSessionKey: options?.agentSessionKey,
      sandboxed: options?.sandboxed,
      config: resolvedConfig,
      callGateway: allBotToolsDeps.callGateway,
    }),
    createSessionsHistoryTool({
      agentSessionKey: options?.agentSessionKey,
      sandboxed: options?.sandboxed,
      config: resolvedConfig,
      callGateway: allBotToolsDeps.callGateway,
    }),
    createSessionsSendTool({
      agentSessionKey: options?.agentSessionKey,
      agentChannel: options?.agentChannel,
      sandboxed: options?.sandboxed,
      config: resolvedConfig,
      callGateway: allBotToolsDeps.callGateway,
    }),
    createSessionsYieldTool({
      sessionId: options?.sessionId,
      onYield: options?.onYield,
    }),
    createSessionsSpawnTool({
      agentSessionKey: options?.agentSessionKey,
      agentChannel: options?.agentChannel,
      agentAccountId: options?.agentAccountId,
      agentTo: options?.agentTo,
      agentThreadId: options?.agentThreadId,
      agentGroupId: options?.agentGroupId,
      agentGroupChannel: options?.agentGroupChannel,
      agentGroupSpace: options?.agentGroupSpace,
      sandboxed: options?.sandboxed,
      requesterAgentIdOverride: options?.requesterAgentIdOverride,
      workspaceDir: spawnWorkspaceDir,
    }),
    createSubagentsTool({
      agentSessionKey: options?.agentSessionKey,
    }),
    createSessionStatusTool({
      agentSessionKey: options?.agentSessionKey,
      config: resolvedConfig,
      sandboxed: options?.sandboxed,
    }),
    createSessionTranscriptTool(),
    createDialogueListTool({ config: resolvedConfig }),
    ...collectPresentAllBotTools([
      createCognitiveFeedbackTool({
        config: resolvedConfig,
        sessionKey: options?.agentSessionKey,
        agentId: sessionAgentId,
      }),
      createEvolutionSuggestTool({
        config: resolvedConfig,
        sessionKey: options?.agentSessionKey,
        deliveryTo: options?.agentTo,
        // Approval comes from the host (Control UI / gateway RPC), never from
        // tool parameters. The grant is scoped to this agent+user and consumed
        // once, so a stale approval cannot authorise a later draft.
        getUserDecision: () => {
          const userId = resolveCorrectionUserId(options?.agentSessionKey, options?.agentTo);
          return userId ? consumeEvolutionDecision(sessionAgentId, userId) : undefined;
        },
      }),
      createEvolutionPatchTool({
        config: resolvedConfig,
        sessionKey: options?.agentSessionKey,
      }),
      createEvolutionDeleteTool({
        config: resolvedConfig,
        sessionKey: options?.agentSessionKey,
        getUserConfirmation: () => {
          const userId = resolveCorrectionUserId(options?.agentSessionKey, options?.agentTo);
          return userId ? consumeSkillDeleteConfirmation(sessionAgentId, userId) : undefined;
        },
      }),
      createEvolutionArchiveTool({
        config: resolvedConfig,
        sessionKey: options?.agentSessionKey,
      }),
      ...(resolvedConfig?.cognitive?.correction?.enabled !== false
        ? [
            createCorrectionReportTool({
              config: resolvedConfig,
              sessionKey: options?.agentSessionKey,
              deliveryTo: options?.agentTo,
              agentId: sessionAgentId,
            }),
          ]
        : []),
      ...(tasksEnabled(resolvedConfig)
        ? [
            createTaskTool({
              config: resolvedConfig,
              sessionKey: options?.agentSessionKey,
              deliveryTo: options?.agentTo,
              agentId: sessionAgentId,
            }),
            createTaskStatusTool({
              config: resolvedConfig,
              sessionKey: options?.agentSessionKey,
              deliveryTo: options?.agentTo,
              agentId: sessionAgentId,
            }),
            createTaskStepReportTool({
              sessionKey: options?.agentSessionKey,
              deliveryTo: options?.agentTo,
              agentId: sessionAgentId,
            }),
          ]
        : []),
      ...(ownerTasksEnabled(resolvedConfig)
        ? [
            createOwnerTaskListTool({
              config: resolvedConfig,
              sessionKey: options?.agentSessionKey,
              deliveryTo: options?.agentTo,
            }),
            createOwnerTaskGetTool({
              config: resolvedConfig,
              sessionKey: options?.agentSessionKey,
              deliveryTo: options?.agentTo,
            }),
            ...(isRouterSession
              ? [
                  createOwnerTaskAcceptTool({
                    config: resolvedConfig,
                    sessionKey: options?.agentSessionKey,
                    deliveryTo: options?.agentTo,
                  }),
                  createOwnerTaskRejectTool({
                    config: resolvedConfig,
                    sessionKey: options?.agentSessionKey,
                    deliveryTo: options?.agentTo,
                    callGateway: allBotToolsDeps.callGateway,
                  }),
                  createOwnerTaskCancelTool({
                    config: resolvedConfig,
                    sessionKey: options?.agentSessionKey,
                    deliveryTo: options?.agentTo,
                  }),
                ]
              : []),
          ]
        : []),
      createSwitchSoulTool({ agentId: sessionAgentId }),
      createContextShowTool({
        config: resolvedConfig,
        workspaceDir,
        sessionKey: options?.agentSessionKey,
        agentId: sessionAgentId,
      }),
    ]),
    ...collectPresentAllBotTools([webSearchTool, webFetchTool, imageTool, pdfTool]),
  ];

  if (options?.disablePluginTools) {
    return tools;
  }

  const wrappedPluginTools = resolveAllBotPluginToolsForOptions({
    options,
    resolvedConfig,
    existingToolNames: new Set(tools.map((tool) => tool.name)),
  });

  return [...tools, ...wrappedPluginTools];
}

export const __testing = {
  setDepsForTest(overrides?: Partial<AllBotToolsDeps>) {
    allBotToolsDeps = overrides
      ? {
          ...defaultAllBotToolsDeps,
          ...overrides,
        }
      : defaultAllBotToolsDeps;
  },
};
