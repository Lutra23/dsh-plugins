import { watchFile, unwatchFile } from 'node:fs';
import {
    readSelectionState,
    readSelectionStateSync,
    resolveSelectionStatePath
} from './selection-state.mjs';
import { VcpMemoryCompanion } from './memory-companion.mjs';

const DEFAULT_BASE_URL = 'http://127.0.0.1:6005/api/plugins/DSHBridge';
const DEFAULT_MODEL_BASE_URL = 'http://127.0.0.1:6005/v1';
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MEMORY_WRITE_FOLDER = 'DSH工程档案';
const DEFAULT_MEMORY_READ_FOLDERS = ['DSH工程档案', '公共'];
const MAX_MEMORY_CONTENT_LENGTH = 100_000;
const CONFIGURATION_CONTRACT = {
    schema: 'dsh-vcp-plugin-configuration',
    schemaVersion: 2,
    modelRoute: {
        fullVcpProvider: 'vcptoolbox',
        fullVcpBaseUrl: DEFAULT_MODEL_BASE_URL,
        providerConfigEntry: 'llm-pi-ai',
        providerConfigMode: 'official-custom-model-api',
        providerSettingsPath: ['providers', 'vcptoolbox'],
        dshOnlyHeader: 'X-DSH-VCP-Origin',
        dshOnlyHeaderValue: '1',
        providerIsAuthoritative: true,
        modelLabelDoesNotDetermineRoute: true,
        reasoningEfforts: ['off', 'low', 'high', 'max'],
        defaultReasoningEffort: 'high'
    },
    verification: {
        providerConfigPath: 'agent-default-model.config.provider',
        providerExpected: 'vcptoolbox',
        baseUrlConfigPath: 'llm-pi-ai.config.providers.vcptoolbox.baseURL',
        baseUrlExpected: DEFAULT_MODEL_BASE_URL,
        liveProviderObservableByPlugin: false
    },
    requestCompatibility: {
        developerRoleSupportedByVcpUpstream: false,
        requiredConfigPath:
            'llm-pi-ai.config.providers.vcptoolbox.compat.supportsDeveloperRole',
        requiredValue: false
    },
    routeEffects: {
        vcptoolbox: {
            vcpChatPipeline: true,
            vcpAgentPlaceholderExpansion: true,
            vcpDiaryAndRag: true,
            vcpTextToolProcessing: true
        },
        directDshProvider: {
            vcpChatPipeline: false,
            vcpAgentPlaceholderExpansion: false,
            vcpDiaryAndRag: false,
            vcpTextToolProcessing: false,
            explicitVcpToolsRemainAvailable: true
        }
    },
    memoryTools: {
        explicitSearchTool: 'vcp_memory_search',
        safeCreateTool: 'vcp_dailynote_create',
        safeUpdateTool: 'vcp_dailynote_update',
        policyTool: 'vcp_memory_policy',
        diagnosticsTool: 'vcp_memory_diagnostics',
        bridge: '/api/plugins/DSHBridge',
        recallOwners: ['native', 'enhanced', 'hybrid'],
        defaultRecallOwner: 'native',
        passiveRecallIntegrated: true,
        passiveRecallBoundaries: ['user-message', 'todo'],
        optionalEnhancements: [
            'rerank',
            'association-groups',
            'intuition-cards',
            'cooldown',
            'circuit-breaker'
        ],
        folderAllowlistRequired: true,
        ownerDerivedFromSession: true
    },
    modes: [
        {
            id: 'vcp-compat',
            fullOnVcptoolbox: true,
            supportedOnDirectDshProvider: false,
            directProviderNote: 'Requires the VCP chat pipeline for text tool processing.'
        },
        {
            id: 'vcp-dual-stack',
            fullOnVcptoolbox: true,
            supportedOnDirectDshProvider: 'partial',
            directProviderNote: 'Typed VCP tools work; Agent identity, diary, and RAG do not load automatically.'
        },
        {
            id: 'vcp-omni',
            fullOnVcptoolbox: true,
            supportedOnDirectDshProvider: 'partial',
            directProviderNote: 'DSH orchestration works, but VCP Agent memory and placeholders require explicit prefetch or a VCP route.'
        },
        {
            id: 'vcp-deep-work',
            fullOnVcptoolbox: true,
            supportedOnDirectDshProvider: 'partial',
            directProviderNote: 'DSH engineering and typed VCP tools work; automatic VCP memory does not.'
        }
    ],
    presetUi: {
        preserveOfficialAndCustomPresets: true,
        hideInternalPrefixes: ['vcp-agent-'],
        blankSessionDefaultField: 'isDefault',
        genericFallbackLabelAllowed: false
    },
    optionalIntegrations: {
        allowedPreset: 'vcp-deep-work',
        redistributedByThisBundle: false,
        requireInstalledPackage: true,
        requirePeerRangeMatch: true,
        projectForge: {
            packageName: 'dsh-project-forge',
            hostRange: '>=0.2.1-rc'
        },
        forgeContext: {
            packageName: '@dsh-external/dsh-forge-context',
            hostRange: '>=0.2.0-rc.2 <0.3.0-0',
            cordisRange: '>=4.0.1 <5.0.0'
        }
    },
    installation: {
        defaultModifiesAgentRoster: false,
        optionalAgentAssetsSwitch: '-InstallVcpAssets',
        reverseStartApprovalRule: 'DSHReverseBridge:command:[=start]',
        reverseToolExposedThroughDshBridge: false
    }
};

export const name = '@local/dsh-vcp-bridge';
export const inject = ['tools', 'systemPrompt', 'approval', 'credentials'];

function parameterProperty(spec) {
    if (spec.type === 'json') {
        return {
            ...(spec.description ? { description: spec.description } : {})
        };
    }
    const property = { ...spec };
    delete property.required;
    if (property.type === 'array' && property.items) {
        property.items = parameterProperty(property.items);
    }
    if (property.type === 'object' && property.properties) {
        property.properties = Object.fromEntries(
            Object.entries(property.properties).map(([key, child]) => [
                key,
                parameterProperty(child)
            ])
        );
        const required = Object.entries(property.properties)
            .filter(([, child]) => child.required === true)
            .map(([key]) => key);
        if (required.length > 0) property.required = required;
        property.additionalProperties = property.additionalProperties ?? false;
    }
    return property;
}

function parametersToJsonSchema(parameters = {}) {
    const properties = {};
    const required = [];
    for (const [key, spec] of Object.entries(parameters)) {
        properties[key] = parameterProperty(spec);
        if (spec.required === true) required.push(key);
    }
    return {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false
    };
}

function defineLocalTool(options) {
    return {
        name: options.name,
        description: options.description,
        parameters: parametersToJsonSchema(options.parameters),
        output: {
            schema: options.output.schema,
            render: options.output.render
        },
        execute: options.execute,
        ...(options.isConcurrencySafe
            ? { isConcurrencySafe: options.isConcurrencySafe }
            : {}),
        ...(options.presentCall ? { presentCall: options.presentCall } : {})
    };
}

const MODE_PROMPTS = {
    compat: `## VCP compatibility lane

DSH native tools remain enabled for workspace engineering, files, shell, planning, goals, skills, jobs, and DSH subagents. Do not disable or ignore them.

For VCP integrations other than AgentAssistant:
1. Call \`vcp_tool_list\` to discover the exact VCP tool and read its command contract.
2. Execute VCP-native tools with a VCP \`<<<[TOOL_REQUEST]>>>\` block only in an assistant response that contains no native \`tool_calls\`.
3. If DSH must call a native tool too, finish the native tool round first, wait for its result, and use the next assistant turn for the VCP text request.
4. Never place VCP text tool blocks and DSH native tool calls in the same assistant message. This separation prevents malformed \`assistant(tool_calls) -> tool\` histories.

Use \`vcp_agent_list\` and \`vcp_agent_ask\` for AgentAssistant (AA) collaboration. VCPChat is an auxiliary renderer for tools that explicitly require Loom, game, chart, animation, or interactive preview surfaces; it is not the main agent frontend.`,
    dual: `## DSH/VCP dual-stack lane

DSH remains the primary agent and keeps every native tool: files, search, shell, planning, goals, jobs, skills, workflow, DSH subagents, and Agent Teams when enabled.

VCP tools use the typed native bridge:
1. Call \`vcp_tool_list\` before using an unfamiliar VCP tool; pass \`tool_name\` for its detailed command contract.
2. Execute VCP work with \`vcp_tool_call\`. Never emit VCP \`<<<[TOOL_REQUEST]>>>\` text in this mode.
3. Use \`vcp_agent_list\` and \`vcp_agent_ask\` for AgentAssistant (AA) collaboration.
4. VCPChat is an auxiliary renderer only for tools that explicitly require Loom, game, chart, animation, or interactive preview surfaces.

For a self-contained delegated task where the VCP Agent can choose and execute
its own VCP tools, use \`vcp_agent_run\`. This keeps the ordinary VCP chat
pipeline and agent prompt expansion, but returns only a final report to DSH.
Intermediate VCP tool calls and VCP-native approvals are not unified into DSH.

Approval is unified: the bridge asks DSH once only when VCP policy requires approval, then VCP performs its final policy and tool checks. Do not ask the user a second time or attempt to bypass a denied approval.`
    ,
    deep: `## Deep engineering lane

DSH remains the primary engineering agent and keeps every native tool. Use the same typed native VCP bridge as DSH/VCP dual-stack mode: never emit VCP text tool blocks.

Work from verified structure before editing:
1. Read adjacent contracts and identify the canonical owner of the behavior.
2. Prefer symbol/reference-aware navigation and reversible, minimal edits.
3. Keep one writer per file or scope; serialize overlapping changes.
4. Preserve exact evidence, test output, and rollback boundaries.
5. Before declaring completion, verify the production-shaped path and report uncovered risk.

When this lane is paired with a VCP Agent, that Agent supplies domain identity and memory. The lane supplies disciplined engineering workflow and both tool ecosystems.`
};

const MODEL_ROUTE_PROMPT = `## DSH model route and VCP memory

The DSH provider is authoritative. Complete automatic VCP integration requires the
session model to use provider \`vcptoolbox\` with base URL
\`http://127.0.0.1:6005/v1\`. A model label such as \`VCPModelAuto\` does not prove
that the request uses VCP; the same label can exist under another DSH provider.

Under \`vcptoolbox\`, VCP expands Agent placeholders, loads Agent diaries and RAG,
runs message preprocessing, and processes VCP text-tool requests. With a direct
DSH provider, DSH native tools and explicit VCP tools remain available, but VCP
Agent persona, diary, RAG, placeholder expansion, and VCP text-tool processing do
not happen automatically. Never claim that a direct DSH model has full VCP memory.

Before changing \`agent-default-model.provider\`, changing the \`vcptoolbox\`
provider configuration, diagnosing missing VCP memory, or stating which mode is
compatible, call \`vcp_configuration_contract\`. The tool reports the supported
contract and plugin configuration, not the live DSH provider; inspect the active
DSH provider and base URL separately.`;

function agentIdentityText(agentAlias, source) {
    const sourceLine = source === 'picker'
        ? 'This identity was selected through the DSH VCP Agent picker for the current new session.'
        : 'This identity is owned by a dedicated VCP execution preset.';
    return `{{${agentAlias}}}

## Same VCP identity

You are the same VCP Agent as "${agentAlias}". ${sourceLine}
The VCP-expanded identity above is authoritative. Use the diaries, knowledge indices,
memory retrieval, persona, and tool guidance defined by that VCP Agent prompt. Do not
create a separate DSH-only memory namespace or substitute a different agent persona.`;
}

function normalizeAgentAlias(value) {
    if (typeof value !== 'string') return null;
    const alias = value.trim();
    if (!alias || alias.length > 100) return null;
    if (!/^[a-zA-Z0-9_:@#%&^+\-\u2e80-\u2fff\u3040-\u9fff]+$/.test(alias)) {
        return null;
    }
    return alias;
}

function normalizeMemoryFolder(value) {
    if (typeof value !== 'string') return null;
    const folder = value.normalize('NFC').trim();
    if (!folder || folder.length > 100 || folder === '.' || folder === '..') {
        return null;
    }
    if (/[\u0000-\u001f<>:"/\\|?*]/u.test(folder) || /[. ]$/u.test(folder)) {
        return null;
    }
    return folder;
}

function normalizeMemoryFolderList(value) {
    const rawValues = Array.isArray(value)
        ? value
        : typeof value === 'string'
            ? value.split(/[,\n;|，；]/u)
            : [];
    return [...new Set(
        rawValues
            .map(normalizeMemoryFolder)
            .filter(Boolean)
    )];
}

function normalizeMemoryFileName(value) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value !== 'string') {
        throw new Error('fileName must be a string.');
    }
    const fileName = value.normalize('NFC').trim();
    if (!fileName || fileName.length > 80) {
        throw new Error('fileName must contain 1-80 characters.');
    }
    if (/[\u0000-\u001f<>:"/\\|?*]/u.test(fileName) || /[. ]$/u.test(fileName)) {
        throw new Error('fileName contains characters that are unsafe for a diary file name.');
    }
    return fileName;
}

function normalizeMemoryDate(value) {
    const date = typeof value === 'string' ? value.trim() : '';
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
        throw new Error('date must use YYYY-MM-DD.');
    }
    const parsed = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
        throw new Error('date is not a valid calendar date.');
    }
    return date;
}

function memoryResultFolder(result) {
    const candidates = [
        result?.result?.folder,
        result?.folder,
        result?.data?.folder
    ];
    return candidates.find(value => typeof value === 'string' && value.trim()) || null;
}

function normalizeTimeout(value) {
    const timeout = Number(value);
    return Number.isInteger(timeout) && timeout >= 1_000 ? timeout : DEFAULT_TIMEOUT_MS;
}

function normalizeBaseUrl(value) {
    const baseUrl = typeof value === 'string' && value.trim()
        ? value.trim()
        : DEFAULT_BASE_URL;
    return baseUrl.replace(/\/+$/, '');
}

function normalizeModelBaseUrl(value) {
    const baseUrl = typeof value === 'string' && value.trim()
        ? value.trim()
        : DEFAULT_MODEL_BASE_URL;
    return baseUrl.replace(/\/+$/, '');
}

function errorText(status, body) {
    const text = typeof body === 'string'
        ? body
        : JSON.stringify(body);
    return `VCP API returned HTTP ${status}: ${text.slice(0, 4_000)}`;
}

async function resolveVcpApiKey(ctx, config) {
    const apiKeyEnv = config.apiKeyEnv || 'VCPTOOLBOX_API_KEY';
    const storedCredential = await ctx.credentials.resolve(apiKeyEnv);
    const apiKey = storedCredential?.value || process.env[apiKeyEnv];
    if (!apiKey) {
        throw new Error(
            `VCP bridge cannot find ${apiKeyEnv}. Configure the same VCPToolBox API key used by the provider.`
        );
    }
    return apiKey;
}

async function fetchVcp(ctx, config, exec, path, options = {}) {
    const apiKey = await resolveVcpApiKey(ctx, config);
    const timeoutMs = normalizeTimeout(config.requestTimeoutMs);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('VCP request timed out.')), timeoutMs);
    const signal = exec.signal
        ? AbortSignal.any([exec.signal, controller.signal])
        : controller.signal;

    try {
        const response = await config.fetchImpl(`${normalizeBaseUrl(config.baseUrl)}${path}`, {
            ...options,
            headers: {
                Authorization: `Bearer ${apiKey}`,
                Accept: 'application/json',
                'X-VCP-Client': 'dsh-bridge',
                ...(options.headers || {})
            },
            signal
        });
        const bodyText = await response.text();
        let body = bodyText;
        try {
            body = bodyText ? JSON.parse(bodyText) : null;
        } catch (_) {
            // Keep non-JSON diagnostics readable.
        }
        if (!response.ok) throw new Error(errorText(response.status, body));
        return body;
    } finally {
        clearTimeout(timeout);
    }
}

function chatCompletionText(body) {
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter(part => part?.type === 'text' && typeof part.text === 'string')
            .map(part => part.text)
            .join('\n');
    }
    return '';
}

function summarizeVcpProtocol(text) {
    const raw = typeof text === 'string' ? text : '';
    const toolRuns = [];
    const resultPattern = /工具名称:\s*([^\n]+)[\s\S]{0,240}?执行状态:\s*([^\n]+)/g;
    let match;
    while ((match = resultPattern.exec(raw)) !== null) {
        toolRuns.push({
            toolName: match[1].trim(),
            status: match[2].trim()
        });
    }

    const finalText = raw
        .replace(/<<<\[TOOL_REQUEST\]>>>[\s\S]*?<<<\[END_TOOL_REQUEST\]>>>/g, '')
        .replace(
            /<<<\[ROLE_DIVIDE_(USER|SYSTEM|ASSISTANT)\]>>>[\s\S]*?<<<\[END_ROLE_DIVIDE_\1\]>>>/g,
            ''
        )
        .replace(/\[本轮工具调用摘要:\][\s\S]*?\[本轮工具调用摘要结束\]/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    return {
        finalText,
        toolRuns,
        protocolText: raw.length > 20_000 ? raw.slice(0, 20_000) : raw
    };
}

async function runVcpAgent(ctx, config, args, exec) {
    const agentName = normalizeAgentAlias(args.agent_name);
    if (!agentName) throw new Error('agent_name must be a valid VCP Agent alias.');
    const task = typeof args.task === 'string' ? args.task.trim() : '';
    if (!task) throw new Error('task is required.');
    const context = typeof args.context === 'string' ? args.context.trim() : '';
    if (task.length + context.length > 120_000) {
        throw new Error('task plus context is too large; split the work into smaller tasks.');
    }

    const apiKey = await resolveVcpApiKey(ctx, config);
    const timeoutMs = normalizeTimeout(config.requestTimeoutMs);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('VCP Agent request timed out.')), timeoutMs);
    const signal = exec.signal
        ? AbortSignal.any([exec.signal, controller.signal])
        : controller.signal;
    const model = typeof args.model === 'string' && args.model.trim()
        ? args.model.trim()
        : 'VCPModelAuto';
    const systemPrompt = `{{${agentName}}}

## Detached DSH task

You are the same VCP Agent as "${agentName}". This task was delegated by DSH.
Use the persona, memory, tools, and command contracts exposed by your VCP Agent
prompt. Work autonomously until the task is complete. Before returning, verify
the result where possible. Return a concise final report with summary, evidence,
changed files or artifacts, tests, and remaining risks. Intermediate VCP tool
activity is not separately exposed to DSH, so do not claim checks you did not
perform.`;
    const userPrompt = context
        ? `## Context\n\n${context}\n\n## Task\n\n${task}`
        : task;

    try {
        const response = await config.fetchImpl(
            `${normalizeModelBaseUrl(config.modelBaseUrl)}/chat/completions`,
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    'X-VCP-Client': 'dsh-autonomous-agent'
                },
                body: JSON.stringify({
                    model,
                    stream: false,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt }
                    ]
                }),
                signal
            }
        );
        const bodyText = await response.text();
        let body = bodyText;
        try {
            body = bodyText ? JSON.parse(bodyText) : null;
        } catch (_) {
            // Keep non-JSON diagnostics readable.
        }
        if (!response.ok) throw new Error(errorText(response.status, body));
        const agentText = chatCompletionText(body);
        const protocol = summarizeVcpProtocol(agentText);
        return {
            executionMode: 'vcp-autonomous-agent',
            agentName,
            model: body?.model || model,
            resultText: protocol.finalText || agentText,
            toolTrace: protocol.toolRuns,
            rawProtocolText: protocol.protocolText,
            finishReason: body?.choices?.[0]?.finish_reason || null,
            usage: body?.usage || null,
            toolsObservedByDSH: false,
            toolTraceBestEffort: protocol.toolRuns.length > 0,
            approvalMode: 'vcp-native',
            note: 'VCP executed this task through its normal chat pipeline. DSH received a cleaned final report plus best-effort protocol-derived tool trace, not typed tool events.'
        };
    } finally {
        clearTimeout(timeout);
    }
}

async function requestApprovalIfNeeded(ctx, config, toolName, toolArgs, exec) {
    const preflight = await fetchVcp(ctx, config, exec, '/tool/preflight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            tool_name: toolName,
            arguments: toolArgs
        })
    });

    if (!preflight?.requiresApproval) return null;

    const approvalPolicy = ctx.approval.effectivePolicy(exec.agent.session);
    if (approvalPolicy !== 'ask') {
        throw new Error(
            `VCP policy requires approval for "${toolName}", but the current DSH approval policy is "${approvalPolicy}". ` +
            'Switch to the "VCP Smart Approval" permission preset, or add a matching VCP whitelist rule.'
        );
    }

    const outcome = await ctx.approval.request({
        agent: exec.agent,
        toolName: `vcp:${toolName}`,
        callId: exec.callId,
        reason: `VCP tool "${toolName}" requires approval. Policy match: ${preflight.matchedRule || 'unspecified'}`
    });
    if (outcome !== 'allowed-once') {
        throw new Error(`VCP tool "${toolName}" was not approved (${outcome}).`);
    }
    if (!preflight.approvalTicket) {
        throw new Error(`VCP approval preflight for "${toolName}" did not return a ticket.`);
    }
    return preflight.approvalTicket;
}

async function executeVcpTool(ctx, config, toolName, toolArgs, exec) {
    if (!exec.agent) throw new Error('VCP tools require an owning DSH agent session.');
    const approvalTicket = await requestApprovalIfNeeded(
        ctx,
        config,
        toolName,
        toolArgs,
        exec
    );

    return fetchVcp(ctx, config, exec, '/tool', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(approvalTicket ? { 'X-VCP-Approval-Ticket': approvalTicket } : {})
        },
        body: JSON.stringify({
            tool_name: toolName,
            arguments: toolArgs
        })
    });
}

async function executeVcpReadTool(ctx, config, toolName, toolArgs, exec) {
    if (!exec.agent) {
        throw new Error('VCP passive memory reads require an owning DSH agent session.');
    }
    const preflight = await fetchVcp(ctx, config, exec, '/tool/preflight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            tool_name: toolName,
            arguments: toolArgs
        })
    });
    if (preflight?.requiresApproval) {
        throw new Error(
            `VCP passive memory read "${toolName}" requires approval; ` +
            'add a read-only whitelist rule before enabling passive recall.'
        );
    }
    return fetchVcp(ctx, config, exec, '/tool', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            tool_name: toolName,
            arguments: toolArgs
        })
    });
}

function jsonOutput(description) {
    return {
        schema: {
            type: 'object',
            additionalProperties: true,
            description
        },
        render: (_args, value) => [{
            type: 'text',
            text: JSON.stringify(value, null, 2)
        }]
    };
}

function buildAgentAssistantArgs(args) {
    const toolArgs = {};
    if (args.agent_name !== undefined && args.agent_name !== '') {
        toolArgs.agent_name = args.agent_name;
    }
    if (args.prompt !== undefined && args.prompt !== '') {
        toolArgs.prompt = args.prompt;
    }
    if (Array.isArray(args.inject_tools) && args.inject_tools.length > 0) {
        toolArgs.inject_tools = args.inject_tools.join(',');
    } else if (typeof args.inject_tools === 'string' && args.inject_tools.trim()) {
        toolArgs.inject_tools = args.inject_tools.trim();
    }
    if (args.timely_contact !== undefined && args.timely_contact !== '') {
        toolArgs.timely_contact = args.timely_contact;
    }
    if (args.task_delegation !== undefined) {
        toolArgs.task_delegation = String(args.task_delegation);
    }
    if (args.temporary_contact !== undefined) {
        toolArgs.temporary_contact = String(args.temporary_contact);
    }
    if (args.session_id !== undefined) toolArgs.session_id = args.session_id;
    if (args.query_delegation !== undefined) {
        toolArgs.query_delegation = args.query_delegation;
    }
    if (args.cancel_delegation !== undefined) {
        toolArgs.cancel_delegation = args.cancel_delegation;
    }
    if (args.maid !== undefined && args.maid !== '') {
        toolArgs.maid = args.maid;
    }
    if (args.river_context !== undefined) {
        toolArgs.river_context = args.river_context;
    }
    return toolArgs;
}

export function apply(ctx, rawConfig = {}) {
    const config = {
        mode: ['compat', 'dual', 'deep'].includes(rawConfig.mode)
            ? rawConfig.mode
            : 'dual',
        baseUrl: normalizeBaseUrl(rawConfig.baseUrl),
        modelBaseUrl: normalizeModelBaseUrl(rawConfig.modelBaseUrl),
        apiKeyEnv: rawConfig.apiKeyEnv || 'VCPTOOLBOX_API_KEY',
        requestTimeoutMs: normalizeTimeout(rawConfig.requestTimeoutMs),
        fetchImpl: rawConfig.fetchImpl || globalThis.fetch,
        useSelectedAgent: rawConfig.useSelectedAgent !== false,
        selectionStatePath: resolveSelectionStatePath(rawConfig.selectionStatePath),
        memoryIdentityName: normalizeMemoryFolder(rawConfig.memoryIdentityName)
            || 'DSH主控',
        memoryReadFolders: normalizeMemoryFolderList(rawConfig.memoryReadFolders),
        memoryWriteFolders: normalizeMemoryFolderList(rawConfig.memoryWriteFolders),
        memoryToolsEnabled: rawConfig.memoryToolsEnabled !== false,
        memoryOwner: ['native', 'enhanced', 'hybrid'].includes(rawConfig.memoryOwner)
            ? rawConfig.memoryOwner
            : 'native',
        passiveRecallBoundaries: rawConfig.passiveRecallBoundaries || '',
        passiveRecallFolders: rawConfig.passiveRecallFolders || '',
        passiveRecallRoots: rawConfig.passiveRecallRoots || 'dailynote',
        passiveRecallLimit: rawConfig.passiveRecallLimit,
        passiveRecallCandidateLimit: rawConfig.passiveRecallCandidateLimit,
        passiveRecallBudgetChars: rawConfig.passiveRecallBudgetChars,
        passiveRecallMinScore: rawConfig.passiveRecallMinScore,
        passiveRecallCooldownMs: rawConfig.passiveRecallCooldownMs,
        passiveRecallFailureThreshold: rawConfig.passiveRecallFailureThreshold,
        passiveRecallCircuitCooldownMs:
            rawConfig.passiveRecallCircuitCooldownMs,
        memoryRerankMode: rawConfig.memoryRerankMode || 'lexical',
        rerankUrl: rawConfig.rerankUrl || '',
        rerankModel: rawConfig.rerankModel || '',
        rerankApiKeyEnv: rawConfig.rerankApiKeyEnv || '',
        rerankTimeoutMs: rawConfig.rerankTimeoutMs,
        memoryAssociationGroups: rawConfig.memoryAssociationGroups || {},
        intuitionCardPrefix: rawConfig.intuitionCardPrefix || '直觉卡',
        externalIntegrations:
            rawConfig.externalIntegrations
            && typeof rawConfig.externalIntegrations === 'object'
                ? rawConfig.externalIntegrations
                : {},
        rerankFetchImpl:
            rawConfig.rerankFetchImpl
            || rawConfig.fetchImpl
            || globalThis.fetch
    };
    if (typeof config.fetchImpl !== 'function') {
        throw new Error('DSH/VCP bridge requires the Fetch API.');
    }
    const agentAlias = normalizeAgentAlias(rawConfig.agentAlias);
    let activeAgentAlias = null;
    let identityDisposer = null;
    let identityLocked = false;

    function memoryPolicy() {
        const identities = [
            config.memoryIdentityName,
            activeAgentAlias
        ].filter(Boolean);
        const identityFolders = identities.flatMap(identity => [
            identity,
            `${identity}的知识`
        ]);
        const readFolders = [...new Set([
            ...DEFAULT_MEMORY_READ_FOLDERS,
            ...config.memoryReadFolders,
            ...identityFolders
        ])];
        const writeFolders = [...new Set([
            DEFAULT_MEMORY_WRITE_FOLDER,
            ...config.memoryWriteFolders,
            ...identityFolders
        ])];
        return {
            identity: activeAgentAlias || config.memoryIdentityName,
            activeAgentAlias: activeAgentAlias || null,
            readFolders,
            writeFolders,
            ownerSafe: true
        };
    }

    function requireMemoryFolder(folder, policy, access) {
        const normalized = normalizeMemoryFolder(folder);
        if (!normalized) throw new Error('folder must be a safe diary folder name.');
        const allowed = access === 'write'
            ? policy.writeFolders
            : policy.readFolders;
        if (!allowed.includes(normalized)) {
            throw new Error(
                `Diary folder "${normalized}" is not allowed for ${access}. `
                + `Allowed folders: ${allowed.join(', ')}`
            );
        }
        return normalized;
    }

    const memoryCompanion = config.memoryToolsEnabled
        ? new VcpMemoryCompanion({
            ctx,
            config,
            policyProvider: memoryPolicy,
            executeTool: (toolName, toolArgs, exec) =>
                executeVcpTool(ctx, config, toolName, toolArgs, exec),
            executeReadTool: (toolName, toolArgs, exec) =>
                executeVcpReadTool(ctx, config, toolName, toolArgs, exec),
            fetchImpl: config.rerankFetchImpl,
            logger: ctx.logger
        })
        : null;

    if (memoryCompanion) {
        ctx.on?.('session/event', (session, event) => {
            if (!session?.id) return;
            if (event?.type === 'todo/write') {
                memoryCompanion.rememberTodo(
                    session.id,
                    event.data?.todos || []
                );
            } else if (event?.type === 'turn/start') {
                memoryCompanion.forgetTodo(session.id);
            }
        });
    }

    function applyIdentity(alias, source) {
        if (identityLocked) return;
        const normalized = normalizeAgentAlias(alias);
        if (normalized === activeAgentAlias) return;
        identityDisposer?.();
        identityDisposer = null;
        activeAgentAlias = normalized;
        if (!normalized) return;
        identityDisposer = ctx.systemPrompt.section({
            name: 'vcp:agent-identity',
            order: 10,
            interpolate: false,
            text: agentIdentityText(normalized, source)
        });
    }

    if (agentAlias) {
        applyIdentity(agentAlias, 'preset');
    } else if (config.useSelectedAgent) {
        try {
            const initialState = readSelectionStateSync(config.selectionStatePath);
            applyIdentity(initialState.selectedAgent, 'picker');
        } catch (error) {
            ctx.logger?.warn?.(`VCP Agent selection could not be read: ${error.message}`);
        }

        const refreshSelectedAgent = async () => {
            try {
                const state = await readSelectionState(config.selectionStatePath);
                applyIdentity(state.selectedAgent, 'picker');
            } catch (error) {
                ctx.logger?.warn?.(`VCP Agent selection could not be read: ${error.message}`);
            }
        };
        const selectionListener = () => {
            void refreshSelectedAgent();
        };
        watchFile(config.selectionStatePath, {
            interval: 1_000,
            persistent: false
        }, selectionListener);
        ctx.effect(() => () => {
            unwatchFile(config.selectionStatePath, selectionListener);
            identityDisposer?.();
        }, 'vcp: selected Agent identity');
    }

    ctx.on?.('agent/pre-step', async (payload, next) => {
        identityLocked = true;
        const decision = await next();
        if (!memoryCompanion || !payload?.agent) return decision;
        const recall = await memoryCompanion.passiveRecall(
            {
                agent: payload.agent,
                messages: payload.messages,
                signal: payload.signal
            },
            decision
        );
        if (!recall) return decision;
        return {
            ...decision,
            messages: [...decision.messages, recall]
        };
    });

    ctx.systemPrompt.section({
        name: 'vcp:bridge-policy',
        order: 2910,
        interpolate: false,
        text: MODE_PROMPTS[config.mode]
    });

    ctx.systemPrompt.section({
        name: 'vcp:model-route-configuration',
        order: 2900,
        interpolate: false,
        text: MODEL_ROUTE_PROMPT
    });

    ctx.tools.register(defineLocalTool({
        name: 'vcp_configuration_contract',
        description: 'Return the authoritative DSH/VCP provider and mode compatibility contract. Call this before changing the model provider, diagnosing missing VCP memory or RAG, or claiming that all VCP capabilities are available. The plugin cannot observe the live DSH provider; inspect the active provider and base URL separately.',
        parameters: {},
        output: jsonOutput('The supported DSH/VCP configuration contract and this plugin instance configuration.'),
        isConcurrencySafe: () => true,
        execute() {
            return Promise.resolve({
                contract: CONFIGURATION_CONTRACT,
                runtime: {
                    bridgeMode: config.mode,
                    configuredModelBaseUrl: config.modelBaseUrl,
                    configuredApiKeyEnv: config.apiKeyEnv,
                    providerObservableByPlugin: false,
                    visiblePresetObservableByPlugin: false,
                    currentSessionProvider:
                        'not observable; inspect DSH provider configuration',
                    memory: memoryCompanion?.diagnostics() || {
                        memoryOwner: 'native',
                        passiveRecall: {
                            boundaries: []
                        }
                    },
                    optionalIntegrations: config.externalIntegrations
                }
            });
        },
        presentCall: () => ({
            card: 'generic',
            title: 'Inspect DSH/VCP model route contract',
            kind: 'read'
        })
    }));

    ctx.tools.register(defineLocalTool({
        name: 'vcp_tool_list',
        description: 'List or describe VCPToolBox tools and their exact command contracts. Use this before calling an unfamiliar VCP tool.',
        parameters: {
            query: {
                type: 'string',
                description: 'Optional case-insensitive text matched against tool names, descriptions, and commands.'
            },
            tool_name: {
                type: 'string',
                description: 'Optional exact VCP plugin name. Returns its command identifiers, descriptions, and examples.'
            },
            limit: {
                type: 'integer',
                description: 'Maximum compact results to return. Defaults to 40 and is capped by VCP at 200.'
            }
        },
        output: jsonOutput('VCP tool catalog or one detailed tool contract.'),
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const params = new URLSearchParams();
            if (args.query?.trim()) params.set('query', args.query.trim());
            if (args.tool_name?.trim()) params.set('tool_name', args.tool_name.trim());
            if (args.limit !== undefined) params.set('limit', String(args.limit));
            const suffix = params.size > 0 ? `?${params.toString()}` : '';
            return fetchVcp(ctx, config, exec, `/tools${suffix}`);
        },
        presentCall: args => ({
            card: 'generic',
            title: args.tool_name ? `Inspect VCP tool ${args.tool_name}` : 'List VCP tools',
            kind: 'read'
        })
    }));

    ctx.tools.register(defineLocalTool({
        name: 'vcp_agent_list',
        description: 'List VCP chat-agent aliases and AgentAssistant (AA) collaboration agents without exposing their system prompts.',
        parameters: {},
        output: jsonOutput('VCP chat aliases and AA collaboration agents.'),
        isConcurrencySafe: () => true,
        async execute(_args, exec) {
            return fetchVcp(ctx, config, exec, '/agents');
        },
        presentCall: () => ({
            card: 'generic',
            title: 'List VCP agents',
            kind: 'read'
        })
    }));

    if (agentAlias || config.useSelectedAgent) {
        ctx.tools.register(defineLocalTool({
            name: 'vcp_agent_self',
            description: 'Return the exact VCP Agent identity bound to this DSH preset and confirm that DSH and VCP use the same memory identity.',
            parameters: {},
            output: jsonOutput('The bound VCP Agent identity.'),
            isConcurrencySafe: () => true,
            execute() {
                return Promise.resolve({
                    agentName: activeAgentAlias || agentAlias || null,
                    bound: Boolean(activeAgentAlias || agentAlias),
                    sameMemoryIdentity: Boolean(activeAgentAlias || agentAlias),
                    memorySource: 'vcp-agent-prompt',
                    selectionStatePath: config.selectionStatePath
                });
            },
            presentCall: () => ({
                card: 'generic',
                title: `VCP identity: ${activeAgentAlias || agentAlias || 'unbound'}`,
                kind: 'read'
            })
        }));
    }

    ctx.tools.register(defineLocalTool({
        name: 'vcp_capabilities',
        description: 'Report core VCP capabilities and whether optional VCPChat renderer tools are currently available.',
        parameters: {},
        output: jsonOutput('VCP core and optional renderer capability status.'),
        isConcurrencySafe: () => true,
        async execute(_args, exec) {
            return fetchVcp(ctx, config, exec, '/capabilities');
        },
        presentCall: () => ({
            card: 'generic',
            title: 'Check VCP and VCPChat capabilities',
            kind: 'read'
        })
    }));

    if (config.mode === 'dual' || config.mode === 'deep') {
        ctx.tools.register(defineLocalTool({
            name: 'vcp_tool_call',
            description: 'Execute any enabled VCPToolBox plugin through the native DSH/VCP bridge using JSON arguments. Prefer this over VCP TOOL_REQUEST text in dual-stack mode.',
            parameters: {
                tool_name: {
                    type: 'string',
                    required: true,
                    description: 'Exact enabled VCP plugin name.'
                },
                arguments: {
                    type: 'json',
                    required: true,
                    description: 'JSON object containing the exact arguments accepted by the VCP plugin.'
                }
            },
            output: jsonOutput('The VCP plugin result.'),
            async execute(args, exec) {
                if (!args.arguments || typeof args.arguments !== 'object' || Array.isArray(args.arguments)) {
                    throw new Error('arguments must be a JSON object.');
                }
                return executeVcpTool(
                    ctx,
                    config,
                    args.tool_name,
                    args.arguments,
                    exec
                );
            },
            presentCall: args => ({
                card: 'generic',
                title: `Call VCP ${args.tool_name}`,
                kind: 'execute',
                rawInput: args.arguments
            })
        }));

        if (config.memoryToolsEnabled) {
            ctx.tools.register(defineLocalTool({
                name: 'vcp_memory_policy',
                description: 'Report the safe VCP diary folders available to this DSH session and the identity used for new diary entries.',
                parameters: {},
                output: jsonOutput('The active VCP memory identity and allowed read/write folders.'),
                isConcurrencySafe: () => true,
                execute() {
                    const diagnostics = memoryCompanion.diagnostics();
                    return Promise.resolve({
                        ...memoryPolicy(),
                        searchTool: 'DailyNoteSearcher',
                        writeTool: 'DailyNote',
                        bridge: '/api/plugins/DSHBridge',
                        memoryOwner: diagnostics.memoryOwner,
                        passiveRecall: diagnostics.passiveRecall,
                        rerank: diagnostics.rerank,
                        associationGroups:
                            diagnostics.associationGroups,
                        intuitionCardPrefix:
                            diagnostics.intuitionCardPrefix,
                        note: 'This policy does not replace or disable VCP native RAG or Agent prompt expansion.'
                    });
                },
                presentCall: () => ({
                    card: 'generic',
                    title: 'Inspect VCP memory folder policy',
                    kind: 'read'
                })
            }));

            ctx.tools.register(defineLocalTool({
                name: 'vcp_memory_search',
                description: 'Search one allowed VCP diary or knowledge folder through DailyNoteSearcher. This is an explicit memory lookup and does not enable passive recall.',
                parameters: {
                    query: {
                        type: 'string',
                        required: true,
                        description: 'Text, keyword phrase, or regular expression to search for.'
                    },
                    folder: {
                        type: 'string',
                        required: true,
                        description: 'Allowed diary or knowledge folder returned by vcp_memory_policy.'
                    },
                    root_path: {
                        type: 'string',
                        description: 'dailynote for diary memory or knowledge for the VCP knowledge corpus. Defaults to dailynote.'
                    },
                    mode: {
                        type: 'string',
                        description: 'text for literal/regex matching or bm25 for ranked recall. Defaults to text.'
                    },
                    limit: {
                        type: 'integer',
                        description: 'Maximum results, 1-50. Defaults to 10.'
                    },
                    rerank: {
                        type: 'boolean',
                        description:
                            'When true, return normalized candidates ranked by the configured off/lexical/http/auto policy.'
                    }
                },
                output: jsonOutput('VCP diary search results.'),
                async execute(args, exec) {
                    const query = typeof args.query === 'string' ? args.query.trim() : '';
                    if (!query || query.length > 500) {
                        throw new Error('query must contain 1-500 characters.');
                    }
                    const policy = memoryPolicy();
                    const folder = requireMemoryFolder(args.folder, policy, 'read');
                    const rootPath = args.root_path === 'knowledge' ? 'knowledge' : 'dailynote';
                    const mode = args.mode === 'bm25' ? 'bm25' : 'text';
                    const limit = Number.isInteger(args.limit)
                        ? Math.max(1, Math.min(50, args.limit))
                        : 10;
                    const toolArgs = {
                        command: 'SearchDailyNote',
                        query,
                        folder,
                        root_path: rootPath,
                        max_results: limit,
                        mode
                    };
                    if (mode === 'bm25') {
                        toolArgs.bm25_limit = limit;
                        toolArgs.bm25_search_mode = 'body';
                    } else {
                        toolArgs.is_regex = false;
                        toolArgs.context_lines = 2;
                    }
                    if (args.rerank === true) {
                        const ranked = await memoryCompanion.search({
                            query,
                            folders: [folder],
                            rootPaths: [rootPath],
                            mode,
                            limit,
                            rerank: config.memoryRerankMode,
                            exec,
                            allowApproval: true
                        });
                        return {
                            identity: policy.identity,
                            folder,
                            rootPath,
                            mode,
                            limit,
                            result: ranked.notes,
                            rerank: ranked.rerank,
                            failures: ranked.failures
                        };
                    }
                    const result = await executeVcpTool(
                        ctx,
                        config,
                        'DailyNoteSearcher',
                        toolArgs,
                        exec
                    );
                    return {
                        identity: policy.identity,
                        folder,
                        rootPath,
                        mode,
                        limit,
                        result
                    };
                },
                presentCall: args => ({
                    card: 'generic',
                    title: `Search VCP memory in ${args.folder || 'folder'}`,
                    kind: 'read'
                })
        }));

        ctx.tools.register(defineLocalTool({
                name: 'vcp_dailynote_create',
                description: 'Create one VCP diary entry in an allowed folder using the active VCP Agent or DSH identity as the owner. Approval follows the existing single DSH/VCP bridge path.',
                parameters: {
                    folder: {
                        type: 'string',
                        description: 'Allowed write folder from vcp_memory_policy. Defaults to the active Agent identity.'
                    },
                    date: {
                        type: 'string',
                        required: true,
                        description: 'Calendar date in YYYY-MM-DD.'
                    },
                    content: {
                        type: 'string',
                        required: true,
                        description: 'Diary body, up to 100000 characters.'
                    },
                    tag: {
                        type: 'string',
                        description: 'Optional comma-separated Tag line.'
                    },
                    file_name: {
                        type: 'string',
                        description: 'Optional safe file-name suffix.'
                    }
                },
                output: jsonOutput('The VCP DailyNote result and write verification.'),
                async execute(args, exec) {
                    const policy = memoryPolicy();
                    const defaultFolder = policy.activeAgentAlias || policy.identity;
                    const folder = requireMemoryFolder(
                        args.folder || defaultFolder,
                        policy,
                        'write'
                    );
                    const date = normalizeMemoryDate(args.date);
                    const content = typeof args.content === 'string' ? args.content.trim() : '';
                    if (!content || content.length > MAX_MEMORY_CONTENT_LENGTH) {
                        throw new Error(
                            `content must contain 1-${MAX_MEMORY_CONTENT_LENGTH} characters.`
                        );
                    }
                    const tag = typeof args.tag === 'string' ? args.tag.trim() : '';
                    if (tag.length > 2_000) {
                        throw new Error('tag must not exceed 2000 characters.');
                    }
                    const fileName = normalizeMemoryFileName(args.file_name);
                    const toolArgs = {
                        command: 'create',
                        folder,
                        maid: policy.identity,
                        Date: date,
                        Content: content
                    };
                    if (tag) toolArgs.Tag = tag;
                    if (fileName) toolArgs.fileName = fileName;
                    const result = await executeVcpTool(
                        ctx,
                        config,
                        'DailyNote',
                        toolArgs,
                        exec
                    );
                    const resolvedFolder = memoryResultFolder(result);
                    if (resolvedFolder && resolvedFolder !== folder) {
                        throw new Error(
                            `DailyNote resolved write folder "${resolvedFolder}" instead of "${folder}".`
                        );
                    }
                    return {
                        identity: policy.identity,
                        folder,
                        requestedFileSuffix: fileName || null,
                        writeVerification: resolvedFolder ? 'verified' : 'result-without-folder',
                        result
                    };
                },
                presentCall: args => ({
                    card: 'generic',
                    title: `Create VCP diary entry in ${args.folder || 'default folder'}`,
                    kind: 'execute',
                    rawInput: {
                        folder: args.folder,
                        date: args.date,
                        fileName: args.file_name
                    }
                })
            }));

            ctx.tools.register(defineLocalTool({
                name: 'vcp_dailynote_update',
                description: 'Update one unique VCP diary occurrence after a deterministic preflight search, verify the replacement, and automatically attempt a reverse update if verification fails.',
                parameters: {
                    folder: {
                        type: 'string',
                        required: true,
                        description: 'Allowed write folder from vcp_memory_policy.'
                    },
                    target: {
                        type: 'string',
                        required: true,
                        description:
                            'Exact existing text, at least 15 characters, occurring once in exactly one diary note.'
                    },
                    replacement: {
                        type: 'string',
                        required: true,
                        description:
                            'Replacement text, 1-100000 characters.'
                    }
                },
                output: jsonOutput(
                    'The DailyNote update result, post-write verification, and rollback outcome.'
                ),
                async execute(args, exec) {
                    const policy = memoryPolicy();
                    const folder = requireMemoryFolder(
                        args.folder,
                        policy,
                        'write'
                    );
                    return memoryCompanion.updateDiary({
                        folder,
                        target: args.target,
                        replacement: args.replacement,
                        exec
                    });
                },
                presentCall: args => ({
                    card: 'generic',
                    title: `Update VCP diary entry in ${args.folder || 'folder'}`,
                    kind: 'execute',
                    rawInput: {
                        folder: args.folder,
                        targetPreview:
                            typeof args.target === 'string'
                                ? args.target.slice(0, 120)
                                : ''
                    }
                })
            }));

            ctx.tools.register(defineLocalTool({
                name: 'vcp_memory_diagnostics',
                description: 'Report the opt-in VCP memory owner, passive recall boundaries, Rerank state, association groups, cooldowns, circuit breaker, and last recall without reading memory content.',
                parameters: {},
                output: jsonOutput(
                    'VCP companion-memory configuration and runtime diagnostics.'
                ),
                isConcurrencySafe: () => true,
                execute() {
                    return Promise.resolve(
                        memoryCompanion.diagnostics({
                            policy: memoryPolicy()
                        })
                    );
                },
                presentCall: () => ({
                    card: 'generic',
                    title: 'Inspect VCP companion-memory diagnostics',
                    kind: 'read'
                })
            }));
        }
    }

    ctx.tools.register(defineLocalTool({
        name: 'vcp_agent_ask',
        description: 'Use the full AgentAssistant (AA) collaboration channel: immediate contact, future call, asynchronous delegation, delegation query/cancel, temporary contact, River context, and temporary VCP tool injection.',
        parameters: {
            agent_name: {
                type: 'string',
                description: 'Exact AA agent name returned by vcp_agent_list. Required for a new contact; omit for delegation query/cancel.'
            },
            prompt: {
                type: 'string',
                description: 'Self-contained task or question. Required for a new contact; omit for delegation query/cancel.'
            },
            inject_tools: {
                type: 'array',
                description: 'Optional VCP tool names temporarily injected for this contact only.',
                items: { type: 'string' }
            },
            task_delegation: {
                type: 'boolean',
                description: 'Run an asynchronous AA delegation with heartbeat and completion reports.'
            },
            temporary_contact: {
                type: 'boolean',
                description: 'Do not retain this contact in the target agent history.'
            },
            timely_contact: {
                type: 'string',
                description: 'Optional AA future-call schedule accepted by VCP, such as a date/time or delay expression.'
            },
            session_id: {
                type: 'string',
                description: 'Optional AA conversation session identifier.'
            },
            query_delegation: {
                type: 'string',
                description: 'Optional existing AA delegation id to query.'
            },
            cancel_delegation: {
                type: 'string',
                description: 'Optional existing AA delegation id to cancel.'
            },
            maid: {
                type: 'string',
                description: 'Optional caller name recorded by AA.'
            },
            river_context: {
                type: 'json',
                description: 'Optional RiverMemo context forwarded to AA exactly as provided.'
            }
        },
        output: jsonOutput('The AgentAssistant response or delegation status.'),
        async execute(args, exec) {
            if (!args.query_delegation && !args.cancel_delegation) {
                if (!args.agent_name?.trim()) {
                    throw new Error('agent_name is required for a new AgentAssistant contact.');
                }
                if (!args.prompt?.trim()) {
                    throw new Error('prompt is required for a new AgentAssistant contact.');
                }
            }
            const toolArgs = buildAgentAssistantArgs(args);
            return executeVcpTool(ctx, config, 'AgentAssistant', toolArgs, exec);
        },
        presentCall: args => ({
            card: 'generic',
            title: args.query_delegation
                ? `Query AA delegation ${args.query_delegation}`
                : args.cancel_delegation
                    ? `Cancel AA delegation ${args.cancel_delegation}`
                    : args.timely_contact
                        ? `Schedule AA contact with ${args.agent_name}`
                        : `Ask VCP agent ${args.agent_name}`,
            kind: 'execute'
        })
    }));

    ctx.tools.register(defineLocalTool({
        name: 'vcp_agent_run',
        description: 'Delegate a self-contained task to a VCP Agent through the ordinary VCP /v1 chat pipeline. The VCP Agent can use its own VCP tools autonomously, but DSH receives only the final report, not individual tool calls or unified tool-level approvals.',
        parameters: {
            agent_name: {
                type: 'string',
                required: true,
                description: 'Exact VCP Agent alias from the live Agent snapshot.'
            },
            task: {
                type: 'string',
                required: true,
                description: 'Self-contained delegated task with expected result and verification requirements.'
            },
            context: {
                type: 'string',
                description: 'Optional bounded context, constraints, file scope, and prior findings.'
            },
            model: {
                type: 'string',
                description: 'Optional VCP model name. Defaults to VCPModelAuto.'
            }
        },
        output: jsonOutput('The detached VCP Agent final report and execution metadata.'),
        async execute(args, exec) {
            return runVcpAgent(ctx, config, args, exec);
        },
        presentCall: args => ({
            card: 'generic',
            title: `Run autonomous VCP Agent ${args.agent_name || ''}`.trim(),
            kind: 'execute'
        })
    }));
}

export { defineLocalTool, parametersToJsonSchema };
