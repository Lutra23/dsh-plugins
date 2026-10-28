import {
    activeOptionalIntegrationIds,
    applyDeepWorkIntegrations
} from './optional-integrations.mjs';

const PLAN_MODE_SECTION = `You are in plan mode. Stay in plan mode until the user approves your plan through exit_plan_mode or switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.

Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.

The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed only to keep the request shape stable. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.

Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.

Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.

When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.`;

function standardToolRows({
    mode,
    agentAlias,
    bridgeUrl,
    allowedAgentPresetIds,
    omni,
    memoryIdentityName = 'DSH主控',
    memoryReadFolders = '',
    memoryWriteFolders = '',
    memoryToolsEnabled = true,
    memoryOwner = 'native',
    passiveRecallBoundaries = '',
    passiveRecallFolders = '',
    passiveRecallRoots = 'dailynote',
    passiveRecallLimit,
    passiveRecallCandidateLimit,
    passiveRecallBudgetChars,
    passiveRecallMinScore,
    passiveRecallCooldownMs,
    passiveRecallFailureThreshold,
    passiveRecallCircuitCooldownMs,
    memoryRerankMode = 'lexical',
    rerankUrl = '',
    rerankModel = '',
    rerankApiKeyEnv = '',
    rerankTimeoutMs,
    memoryAssociationGroups = {},
    intuitionCardPrefix = '直觉卡',
    externalIntegrations = {},
    selectionStatePath = '',
    useSelectedAgent = true
}) {
    const rows = [
        {
            id: 'persona',
            name: '@deepseek-ai/dsh-persona',
            config: {
                prefix: agentAlias
                    ? 'You are a VCP Agent. The authoritative VCP identity, tools, and diary memory are provided below.'
                    : 'You are a coding agent powered by the {{model}} model. DSH is the primary agent and VCPToolBox is the memory, plugin, and agent orchestration backend.'
            }
        },
        {
            id: 'agent-instructions',
            name: '@deepseek-ai/dsh-agent-instructions',
            config: { maxBytes: 65536 }
        },
        { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
        {
            id: 'tool-bash',
            name: '@deepseek-ai/dsh-tool-bash',
            disabled: process.platform === 'win32'
        },
        {
            id: 'tool-pwsh',
            name: '@deepseek-ai/dsh-tool-pwsh',
            disabled: process.platform !== 'win32'
        },
        { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
        {
            id: 'tool-fs-search',
            name: '@deepseek-ai/dsh-tool-fs-search',
            config: { sampleOverCapGlobResults: false }
        },
        { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
        { id: 'tool-schedule', name: '@deepseek-ai/dsh-tool-schedule' },
        { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
        { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
        { id: 'command-goal', name: '@deepseek-ai/dsh-command-goal' },
        { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },
        {
            id: 'planning',
            name: 'cordis:group',
            group: true,
            isolate: { planMode: true },
            config: [{
                id: 'plan-mode',
                name: '@deepseek-ai/dsh-plan-mode',
                config: { section: PLAN_MODE_SECTION }
            }]
        },
        {
            id: 'compaction',
            name: 'cordis:group',
            group: true,
            isolate: { compaction: true, toolResultPruner: true },
            config: [
                { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
                { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
                {
                    id: 'tool-result-pruner',
                    name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
                    config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 }
                }
            ]
        },
        {
            id: 'delegation',
            name: 'cordis:group',
            group: true,
            isolate: { workflowEngine: true },
            config: [
                {
                    id: 'tool-subagent-control',
                    name: '@deepseek-ai/dsh-tool-subagent-control'
                },
                {
                    id: 'tool-subagent-list-agents',
                    name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'
                },
                {
                    id: 'tool-subagent',
                    name: '@deepseek-ai/dsh-tool-subagent',
                    config: {
                        provider: 'spawn',
                        toolName: 'subagent',
                        modelSelectionSettings: true,
                        allowedAgentPresets: allowedAgentPresetIds
                    }
                },
                {
                    id: 'tool-subagent-fork',
                    name: '@deepseek-ai/dsh-tool-subagent',
                    config: {
                        provider: 'fork',
                        toolName: 'subagent_fork'
                    }
                },
                {
                    id: 'workflow-ptc',
                    name: '@deepseek-ai/dsh-workflow-ptc',
                    config: { provider: 'spawn' }
                },
                { id: 'tool-workflow', name: '@deepseek-ai/dsh-tool-workflow' }
            ]
        },
        { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
        {
            id: 'tool-todo',
            name: '@deepseek-ai/dsh-tool-todo',
            config: { allowParallelInProgress: true }
        },
        {
            id: 'tool-web',
            name: '@deepseek-ai/dsh-tool-web',
            config: { fetch: true, searchTimeoutMs: 60000 }
        },
        { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
        ...(omni ? [{
            id: 'omni-controller',
            name: omni.controllerUrl,
            config: {
                identityName: omni.identityName,
                stateDirectory: omni.stateDirectory,
                selectionStatePath,
                baseUrl: 'http://127.0.0.1:6005/v1',
                apiKeyEnv: 'VCPTOOLBOX_API_KEY'
            }
        }] : []),
        {
            id: 'vcp-bridge',
            name: bridgeUrl,
            config: {
                mode,
                ...(agentAlias ? { agentAlias } : {}),
                selectionStatePath,
                useSelectedAgent,
                baseUrl: 'http://127.0.0.1:6005/api/plugins/DSHBridge',
                modelBaseUrl: 'http://127.0.0.1:6005/v1',
                apiKeyEnv: 'VCPTOOLBOX_API_KEY',
                memoryIdentityName,
                memoryReadFolders,
                memoryWriteFolders,
                memoryToolsEnabled,
                memoryOwner,
                passiveRecallBoundaries,
                passiveRecallFolders,
                passiveRecallRoots,
                passiveRecallLimit,
                passiveRecallCandidateLimit,
                passiveRecallBudgetChars,
                passiveRecallMinScore,
                passiveRecallCooldownMs,
                passiveRecallFailureThreshold,
                passiveRecallCircuitCooldownMs,
                memoryRerankMode,
                rerankUrl,
                rerankModel,
                rerankApiKeyEnv,
                rerankTimeoutMs,
                memoryAssociationGroups,
                intuitionCardPrefix,
                externalIntegrations,
                requestTimeoutMs: 1800000
            }
        }
    ];
    return rows;
}

export function buildPresetDefinitions({
    bridgeUrl,
    agents,
    genericCompatId = 'vcp-compat',
    genericDualId = 'vcp-dual-stack',
    genericOmniId = 'vcp-omni',
    genericDeepId = 'vcp-deep-work',
    omniIdentityName = 'DSH主控',
    omniStateDirectory = '',
    memoryReadFolders = '',
    memoryWriteFolders = '',
    memoryToolsEnabled = true,
    memoryOwner = 'native',
    passiveRecallBoundaries = '',
    passiveRecallFolders = '',
    passiveRecallRoots = 'dailynote',
    passiveRecallLimit,
    passiveRecallCandidateLimit,
    passiveRecallBudgetChars,
    passiveRecallMinScore,
    passiveRecallCooldownMs,
    passiveRecallFailureThreshold,
    passiveRecallCircuitCooldownMs,
    memoryRerankMode = 'lexical',
    rerankUrl = '',
    rerankModel = '',
    rerankApiKeyEnv = '',
    rerankTimeoutMs,
    memoryAssociationGroups = {},
    intuitionCardPrefix = '直觉卡',
    deepWorkIntegrations = {},
    selectionStatePath = '',
    omniControllerUrl = new URL('./omni-controller.mjs', import.meta.url).href
}) {
    const agentDefinitions = agents.map((agent, index) => {
        const capabilities = Array.isArray(agent.capabilities) && agent.capabilities.length > 0
            ? `能力标签：${agent.capabilities.join('、')}。`
            : '能力标签：未标注。';
        const agentDescription = typeof agent.description === 'string' && agent.description.trim()
            ? agent.description.trim()
            : capabilities;
        const affiliation = String(agent.affiliation || 'VCP').toUpperCase() === 'DSH'
            ? 'DSH'
            : 'VCP';
        const description = `${affiliation} · ${agentDescription}`;
        return {
            id: agent.presetId,
            name: agent.alias,
            description,
            affiliation,
            order: 100 + index,
            agentAlias: agent.alias
        };
    });

    const allowedAgentPresetIds = [
        genericCompatId,
        genericDualId,
        genericOmniId,
        genericDeepId,
        ...agents.map(agent => agent.presetId)
    ];
    const commonMemoryConfig = {
        memoryOwner,
        passiveRecallBoundaries,
        passiveRecallFolders,
        passiveRecallRoots,
        passiveRecallLimit,
        passiveRecallCandidateLimit,
        passiveRecallBudgetChars,
        passiveRecallMinScore,
        passiveRecallCooldownMs,
        passiveRecallFailureThreshold,
        passiveRecallCircuitCooldownMs,
        memoryRerankMode,
        rerankUrl,
        rerankModel,
        rerankApiKeyEnv,
        rerankTimeoutMs,
        memoryAssociationGroups,
        intuitionCardPrefix
    };
    const deepWorkRows = applyDeepWorkIntegrations(
        standardToolRows({
            mode: 'deep',
            bridgeUrl,
            allowedAgentPresetIds,
            memoryIdentityName: omniIdentityName,
            memoryReadFolders,
            memoryWriteFolders,
            memoryToolsEnabled,
            ...commonMemoryConfig,
            externalIntegrations: deepWorkIntegrations,
            selectionStatePath
        }),
        deepWorkIntegrations
    );
    const externalIntegrationIds =
        activeOptionalIntegrationIds(deepWorkIntegrations);

    return [
        {
            id: genericCompatId,
            name: 'VCP 兼容模式',
            description: '必须使用 vcptoolbox provider；保留 DSH 原生工具，VCP 文本工具与 DSH 工具分轮执行，VCPChat 仅作为可选特殊渲染层。',
            order: 1.1,
            plugins: standardToolRows({
                mode: 'compat',
                bridgeUrl,
                allowedAgentPresetIds,
                memoryIdentityName: omniIdentityName,
                memoryReadFolders,
                memoryWriteFolders,
                memoryToolsEnabled,
                ...commonMemoryConfig,
                selectionStatePath
            })
        },
        {
            id: genericDualId,
            name: 'DSH/VCP 双栈模式',
            description: '保留全部 DSH 原生工具，并用通用原生桥统一调用 VCP；完整 VCP 人设、日记与 RAG 需使用 vcptoolbox provider。DSH 直连模型仅保留显式 VCP 工具。',
            order: 1.2,
            plugins: standardToolRows({
                mode: 'dual',
                bridgeUrl,
                allowedAgentPresetIds,
                memoryIdentityName: omniIdentityName,
                memoryReadFolders,
                memoryWriteFolders,
                memoryToolsEnabled,
                ...commonMemoryConfig,
                selectionStatePath
            })
        },
        {
            id: genericOmniId,
            name: `互补全能模式 · ${omniIdentityName}`,
            description: `DSH 主控负责规划、分发、审核、整合和兜底；完整 VCP 人设、日记与 RAG 需使用 vcptoolbox provider。DSH 自有身份“${omniIdentityName}”不进入 VCP Agent 或 AA 名单。`,
            order: 1.3,
            plugins: standardToolRows({
                mode: 'dual',
                bridgeUrl,
                allowedAgentPresetIds: allowedAgentPresetIds.filter(
                    id => id !== genericOmniId
                ),
                memoryIdentityName: omniIdentityName,
                memoryReadFolders,
                memoryWriteFolders,
                memoryToolsEnabled,
                ...commonMemoryConfig,
                selectionStatePath,
                useSelectedAgent: false,
                omni: {
                    controllerUrl: omniControllerUrl,
                    identityName: omniIdentityName,
                    stateDirectory: omniStateDirectory
                }
            })
        },
        {
            id: genericDeepId,
            name: '深度工程模式',
            description: `保留 DSH 深度工程工具与 VCP 全量桥接；完整 VCP 人设、日记与 RAG 需使用 vcptoolbox provider，DSH 直连模型仅保留显式 VCP 工具。${
                externalIntegrationIds.length > 0
                    ? ` 已启用兼容扩展：${externalIntegrationIds.join('、')}。`
                    : ''
            }`,
            order: 1.4,
            plugins: deepWorkRows
        },
        ...agentDefinitions.map(agentDefinition => ({
            id: agentDefinition.id,
            name: agentDefinition.name,
            description: agentDefinition.description,
            order: agentDefinition.order,
            plugins: standardToolRows({
                mode: 'dual',
                agentAlias: agentDefinition.agentAlias,
                bridgeUrl,
                allowedAgentPresetIds,
                memoryIdentityName: omniIdentityName,
                memoryReadFolders,
                memoryWriteFolders,
                memoryToolsEnabled,
                ...commonMemoryConfig,
                selectionStatePath,
                useSelectedAgent: false
            })
        }))
    ];
}

export { PLAN_MODE_SECTION, standardToolRows };
