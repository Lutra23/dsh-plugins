import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { watchFile, unwatchFile } from 'node:fs';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defineLocalTool } from './index.mjs';
import {
    readSelectionState,
    readSelectionStateSync,
    resolveSelectionStatePath
} from './selection-state.mjs';
import {
    OmniProjectStore,
    applyProjectEvent,
    cancelProjectState,
    createProjectState,
    planProjectState,
    projectNextActions
} from './omni-state.mjs';

const require = createRequire(import.meta.url);
const {
    AGENT_SYNC_SCHEMA,
    AGENT_SYNC_SCHEMA_VERSION,
    normalizeDshIdentityName
} = require('./agent-contract.cjs');

export const name = '@local/dsh-vcp-omni';
export const inject = ['tools', 'systemPrompt', 'credentials'];

const DEFAULT_BASE_URL = 'http://127.0.0.1:6005/v1';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

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

function normalizeBaseUrl(value) {
    return (typeof value === 'string' && value.trim()
        ? value.trim()
        : DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function vcpApiUrl(baseUrl, apiPath) {
    return `${new URL(baseUrl).origin}${apiPath}`;
}

function defaultStateDirectory() {
    return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'omni-runs');
}

function makeProjectId() {
    const timestamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    return `omni-${timestamp}-${randomUUID().slice(0, 8)}`;
}

async function resolveApiKey(ctx, apiKeyEnv) {
    try {
        const credential = await ctx.credentials.resolve(apiKeyEnv);
        if (credential?.value) return credential.value;
    } catch {
        // Environment fallback keeps local development usable.
    }
    return process.env[apiKeyEnv] || '';
}

async function requestVcpJson(ctx, config, exec, url, options = {}) {
    const apiKey = await resolveApiKey(ctx, config.apiKeyEnv);
    if (!apiKey) {
        throw new Error(`VCP API key "${config.apiKeyEnv}" is unavailable.`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(
        () => controller.abort(new Error('VCP request timed out.')),
        config.requestTimeoutMs
    );
    const signal = exec.signal
        ? AbortSignal.any([exec.signal, controller.signal])
        : controller.signal;
    try {
        const response = await config.fetchImpl(url, {
            ...options,
            headers: {
                Authorization: `Bearer ${apiKey}`,
                Accept: 'application/json',
                'X-VCP-Client': 'dsh-omni',
                ...(options.body ? { 'Content-Type': 'application/json' } : {}),
                ...(options.headers || {})
            },
            signal
        });
        const bodyText = await response.text();
        let body;
        try {
            body = bodyText ? JSON.parse(bodyText) : null;
        } catch {
            body = bodyText;
        }
        if (!response.ok) {
            throw new Error(
                `VCP returned HTTP ${response.status}: `
                + `${typeof body === 'string' ? body : JSON.stringify(body)}`.slice(0, 4_000)
            );
        }
        return body;
    } finally {
        clearTimeout(timeout);
    }
}

function readAgentCatalog(snapshot) {
    if (!snapshot || snapshot.schema !== AGENT_SYNC_SCHEMA) {
        throw new Error('VCP Agent snapshot has an unexpected schema.');
    }
    if (snapshot.schemaVersion !== AGENT_SYNC_SCHEMA_VERSION) {
        throw new Error(`Unsupported VCP Agent snapshot version ${snapshot.schemaVersion}.`);
    }
    if (!Array.isArray(snapshot.agents) || snapshot.agents.length === 0) {
        throw new Error('VCP Agent snapshot does not contain any usable Agent.');
    }
    return snapshot.agents
        .filter(agent => typeof agent.alias === 'string')
        .map(agent => ({
            alias: agent.alias,
            presetId: agent.presetId,
            capabilities: Array.isArray(agent.capabilities) ? agent.capabilities : [],
            memoryIdentity: agent.memoryIdentity || null
        }));
}

function stateSummary(state) {
    return {
        projectId: state.projectId,
        goal: state.goal,
        identityName: state.identityName,
        status: state.status,
        phase: state.phase,
        workspaceRoot: state.workspaceRoot,
        planStored: Boolean(state.plan),
        agentCatalogRevision: state.agentCatalogRevision,
        agents: state.agentCatalog,
        tasks: state.tasks.map(task => ({
            id: task.id,
            title: task.title,
            agentName: task.agentName,
            agentPresetId: task.agentPresetId,
            assignmentReason: task.assignmentReason,
            writeScopes: task.writeScopes,
            dependencies: task.dependencies,
            status: task.status,
            attempts: task.attempts,
            takeoverRequired: task.status === 'takeover'
        })),
        integration: state.integration,
        secondReview: state.secondReview,
        finalReview: state.finalReview,
        blockedReason: state.blockedReason || null,
        cancelReason: state.cancelReason || null,
        updatedAt: state.updatedAt,
        nextActions: projectNextActions(state),
        processHistory: state.history.slice(-100)
    };
}

export function buildPolicy(identityName) {
    return `## 互补全能模式（DSH 主控）

你的 DSH 自有身份是 "${identityName}"。该身份使用 VCP 记忆系统，但不进入
\`agent_map.json\`、VCPToolBox Agent 名单或 AgentAssistant 协作名单。

DSH 自有日记记忆：
{{${identityName}日记本::Last6::BM25+}}

DSH 自有知识记忆：
{{${identityName}的知识日记本::Last4::BM25+}}

### 固定职责

- DSH Lead：理解用户目标、检查工作区、起草完整计划、选择 VCP Agent、维护
  \`omni_*\` 项目状态、处理用户指令与最终交付。
- VCP Agent：只执行分给它的任务，提交前必须完成自审。
- DSH Unit Reviewer：使用全新上下文，只审一个任务；不得与执行者共享上下文。
- DSH Integrator：使用全新上下文整合所有已通过一审或由 DSH 接管的结果。
- DSH Second Reviewer：使用全新上下文审查整合结果。
- DSH Final Reviewer：使用全新上下文，独立核对用户原始目标、验收条件和最终结果。

### 必须遵守的执行顺序

1. 先读代码和证据，形成可执行计划，并先向用户简要呈现计划；除非存在会改变
   目标、授权或外部状态的用户选择，否则不等待额外确认。用 \`omni_run\` 创建
   项目，再调用 \`omni_plan\` 固化计划、任务、唯一负责人、依赖、写入范围和
   验收标准，并记录每个 Agent 的能力匹配理由，然后继续执行。
2. 使用 DSH 原生 \`subagent\` 工具，通过 \`agent_preset\` 选择任务中的
   \`agentPresetId\` 分发给 VCP Agent。每个子任务必须自包含，并明确要求执行者
   先自审，再返回结构化 \`result\`。
3. 每次 dispatch 后，用真实子 Agent id 调用 \`omni_event(type="dispatch")\`；
   VCP Agent 返回后，自审通过才调用 \`omni_event(type="submit")\`。返工时如果
   使用新的 DSH 子 Agent 上下文，继续传入新的 \`executorContextId\`，确保后续
   审核与当前执行上下文分离。
4. 每个提交必须由新的 DSH Unit Reviewer 子 Agent 审阅实际文件、测试和证据；
   审核角色使用 \`vcp-dual-stack\` 预设，用其真实子 Agent id 调用
   \`omni_event(type="unit_review")\`。执行者不能自批。
5. 一审失败时，把 findings 和 requiredChanges 打回原 VCP Agent 修改。每个任务
   最多提交两次；第二次一审仍失败时状态机会要求 DSH 接管。接管后必须记录修改、
   验证和原因，再调用 \`omni_event(type="takeover_complete")\`。
6. 所有任务通过一审或完成 DSH 接管后，由新的 DSH Integrator 整合。冲突处理、
   跨任务验证和必要的 DSH 工具调用由使用 \`vcp-dual-stack\` 的整合者完成，再用
   真实子 Agent id 调用 \`omni_event(type="integrate")\`。
7. 新的 \`vcp-dual-stack\` DSH Second Reviewer 审查整合结果。失败时，必须把可归属的问题通过
   \`reworkTasks\` 退回原 VCP Agent，重新执行自审、提交和 DSH 一审；已无提交
   次数或已由 DSH 接管的任务继续由 DSH 修正。最多两轮，通过后进入独立终审。
8. 独立的 \`vcp-dual-stack\` DSH Final Reviewer 只依据用户原始目标、计划、
   验收条件和最终证据判断。终审
   失败允许 DSH 做一次最终修正；第二次终审仍失败则项目必须 BLOCKED。
9. 完成后输出最终结果、文件/测试证据、各任务负责人、返工与接管记录、二审和
   终审结论。\`omni_status\` 的状态是流程事实，不得绕过或伪造。

### 冲突与工具边界

- 同一文件或目录范围不得由两个活跃任务并行修改。不同任务存在写入冲突时必须
  串行化或重新拆分范围。
- 不得把不存在的 VCP Agent 写入计划。Agent 列表和能力标签以 \`omni_run\`
  捕获的 catalog revision 为准；运行中新增 Agent 只用于以后的新项目。
- DSH 原生工具负责工程、文件、Shell、搜索、验证和子 Agent 调度。
- VCP 工具在双栈模式下统一使用 \`vcp_tool_call\`，不要在同一轮输出 VCP
  \`TOOL_REQUEST\` 文本。
- VCPChat 只是可选特殊渲染器。Loom、游戏、图表、动画或交互预览可用时使用；
  不可用、未启动或渲染失败时保留结构化数据与文字摘要，不得影响核心任务继续、
  审核或完成状态。`;
}

export async function apply(ctx, rawConfig = {}) {
    const identityName = normalizeDshIdentityName(rawConfig.identityName || 'DSH主控');
    const config = {
        identityName,
        stateDirectory: path.resolve(rawConfig.stateDirectory || defaultStateDirectory()),
        baseUrl: normalizeBaseUrl(rawConfig.baseUrl),
        apiKeyEnv: rawConfig.apiKeyEnv || 'VCPTOOLBOX_API_KEY',
        requestTimeoutMs: Number.isInteger(rawConfig.requestTimeoutMs)
            ? Math.max(1_000, rawConfig.requestTimeoutMs)
            : DEFAULT_REQUEST_TIMEOUT_MS,
        selectionStatePath: resolveSelectionStatePath(rawConfig.selectionStatePath),
        fetchImpl: rawConfig.fetchImpl || globalThis.fetch
    };
    if (typeof config.fetchImpl !== 'function') {
        throw new Error('互补全能模式 requires the Fetch API.');
    }
    const snapshotUrl = rawConfig.snapshotUrl
        || vcpApiUrl(config.baseUrl, '/api/plugins/DSHAgentSync/snapshot');
    const identityUrl = rawConfig.identityUrl
        || vcpApiUrl(config.baseUrl, '/api/plugins/DSHAgentSync/identity/ensure');
    const store = new OmniProjectStore(config.stateDirectory);
    let defaultAgent = '';
    let defaultAgentLocked = false;
    let defaultAgentDisposer = null;

    function applyDefaultAgent(alias) {
        if (defaultAgentLocked) return;
        const selectedAgent = typeof alias === 'string' ? alias.trim() : '';
        if (selectedAgent === defaultAgent && defaultAgentDisposer) return;
        defaultAgentDisposer?.();
        defaultAgent = selectedAgent;
        defaultAgentDisposer = ctx.systemPrompt.section({
            name: 'vcp:omni-default-agent',
            order: 20,
            interpolate: false,
            text: defaultAgent
                ? `## 默认 VCP 执行 Agent

当前新会话选择的默认执行 Agent 是 "${defaultAgent}"。能力标签匹配时应优先考虑它，但仍须按任务依赖、写入范围和能力证据最终分配；明显不匹配时选择更合适的 Agent，并记录原因。`
                : `## 默认 VCP 执行 Agent

当前没有固定默认执行 Agent。按任务能力、依赖和写入范围自动匹配；不得引用 catalog 之外或不存在的 Agent。`
        });
    }

    try {
        applyDefaultAgent(
            readSelectionStateSync(config.selectionStatePath).selectedAgent
        );
    } catch (error) {
        ctx.logger?.warn?.(`Omni default VCP Agent could not be read: ${error.message}`);
        applyDefaultAgent('');
    }

    const selectionListener = () => {
        if (defaultAgentLocked) return;
        readSelectionState(config.selectionStatePath)
            .then(state => applyDefaultAgent(state.selectedAgent))
            .catch(error => {
                ctx.logger?.warn?.(`Omni default VCP Agent refresh failed: ${error.message}`);
            });
    };
    watchFile(config.selectionStatePath, {
        interval: 1_000,
        persistent: false
    }, selectionListener);
    ctx.effect?.(() => () => {
        unwatchFile(config.selectionStatePath, selectionListener);
        defaultAgentDisposer?.();
    }, 'omni-controller: selected default VCP Agent');

    ctx.on?.('agent/pre-step', async (_event, next) => {
        defaultAgentLocked = true;
        return next();
    });

    async function loadAgentCatalog(exec) {
        return readAgentCatalog(await requestVcpJson(
            ctx,
            config,
            exec,
            snapshotUrl
        ));
    }

    async function ensureIdentity(name, exec) {
        const normalizedName = normalizeDshIdentityName(name);
        return requestVcpJson(ctx, config, exec, identityUrl, {
            method: 'POST',
            body: JSON.stringify({ name: normalizedName })
        });
    }

    ctx.systemPrompt.section({
        name: 'vcp:omni-mode',
        order: 20,
        interpolate: false,
        text: buildPolicy(config.identityName)
    });

    ctx.tools.register(defineLocalTool({
        name: 'omni_run',
        description: 'Initialize a 互补全能 project, bind the DSH-owned diary identity, capture the current VCP Agent catalog, and enter PLANNING. Call omni_plan after drafting the plan.',
        parameters: {
            goal: {
                type: 'string',
                required: true,
                description: 'The user original goal and all non-negotiable acceptance requirements.'
            },
            workspace_root: {
                type: 'string',
                description: 'Absolute workspace root. Defaults to the current DSH process working directory.'
            },
            identity_name: {
                type: 'string',
                description: `Optional identity assertion. It must equal the preset-owned diary name ${config.identityName}; use another preset to create a different long-lived DSH identity.`
            },
            project_id: {
                type: 'string',
                description: 'Optional stable project id; omit to generate one.'
            }
        },
        output: jsonOutput('Initialized omni project, captured VCP Agent catalog, and next actions.'),
        async execute(args, exec) {
            const projectId = args.project_id?.trim() || makeProjectId();
            const selectedIdentity = normalizeDshIdentityName(
                args.identity_name?.trim() || config.identityName
            );
            if (selectedIdentity !== config.identityName) {
                throw new TypeError(
                    `This 互补全能 preset owns the identity "${config.identityName}". `
                    + 'A different custom DSH identity must use its own configured preset.'
                );
            }
            const workspaceRoot = path.resolve(args.workspace_root?.trim() || process.cwd());
            const workspaceInfo = await stat(workspaceRoot);
            if (!workspaceInfo.isDirectory()) {
                throw new TypeError(`workspace_root is not a directory: ${workspaceRoot}`);
            }
            const [snapshot, identity] = await Promise.all([
                requestVcpJson(
                    ctx,
                    config,
                    exec,
                    snapshotUrl
                ),
                ensureIdentity(selectedIdentity, exec)
            ]);
            const agents = readAgentCatalog(snapshot);
            const state = createProjectState({
                projectId,
                goal: args.goal,
                identityName: selectedIdentity,
                workspaceRoot,
                agentCatalog: agents,
                agentCatalogRevision: snapshot.revision
            });
            await store.create(state);
            return {
                ...stateSummary(state),
                identity,
                executionPolicy: {
                    vcpSubmissionsPerTask: state.limits.vcpSubmissions,
                    secondReviewRounds: state.limits.secondReviewRounds,
                    finalFixes: state.limits.finalFixes,
                    vcpChatRequired: false
                }
            };
        },
        presentCall: args => ({
            card: 'generic',
            title: `Start 互补全能 project: ${(args.goal || '').slice(0, 80)}`,
            kind: 'execute'
        })
    }));

    ctx.tools.register(defineLocalTool({
        name: 'omni_plan',
        description: 'Store the DSH-authored plan and task assignments. Every task must name a captured VCP Agent and declare write scopes, dependencies, deliverables, and acceptance criteria.',
        parameters: {
            project_id: {
                type: 'string',
                required: true,
                description: 'Project id returned by omni_run.'
            },
            plan: {
                type: 'string',
                required: true,
                description: 'Complete implementation plan in Markdown.'
            },
            tasks: {
                type: 'json',
                required: true,
                description: 'Array of tasks: {id,title,description,agentName,assignmentReason,writeScopes,dependencies,deliverables,acceptanceCriteria}.'
            }
        },
        output: jsonOutput('Stored plan and dispatch-ready task graph.'),
        async execute(args) {
            const state = await store.update(args.project_id, current =>
                planProjectState(current, {
                    plan: args.plan,
                    tasks: args.tasks
                })
            );
            return stateSummary(state);
        },
        presentCall: args => ({
            card: 'generic',
            title: `Plan omni project ${args.project_id}`,
            kind: 'execute'
        })
    }));

    ctx.tools.register(defineLocalTool({
        name: 'omni_event',
        description: 'Record one validated omni workflow event. Supported event.type values: dispatch, submit, unit_review, takeover_complete, integrate, second_review, final_review, final_fix, block. A submit event may update executorContextId after a fresh rework context. A failed second_review should include reworkTasks with taskId, findings, and requiredChanges so issues return to their original VCP Agent.',
        parameters: {
            project_id: {
                type: 'string',
                required: true,
                description: 'Project id.'
            },
            event: {
                type: 'json',
                required: true,
                description: [
                    'Typed event object with real DSH subagent context ids and review evidence.',
                    'submit requires {type,taskId,executorContextId?,result:{taskId,agentName,summary,changedFiles,artifacts,tests,risks,selfReview:{verdict:"pass",findings:[]}}}.',
                    'dispatch requires {type:"dispatch",taskId,executorContextId};',
                    'unit_review requires {type,taskId,reviewerContextId,verdict:"pass"|"rework",findings,requiredChanges};',
                    'takeover_complete requires {type,taskId,summary,changedFiles,verification};',
                    'integrate requires {type:"integrate",integrationContextId,summary,artifacts,changedFiles,verification};',
                    'second_review adds {reviewerContextId,verdict,findings,requiredChanges,reworkTasks?};',
                    'final_review uses {reviewerContextId,verdict,findings,requiredChanges}.',
                    'Use a fresh reviewer/integrator context for each review/integration round.'
                ].join(' ')
            }
        },
        output: jsonOutput('Updated project state and next actions.'),
        async execute(args) {
            const state = await store.update(args.project_id, current =>
                applyProjectEvent(current, args.event)
            );
            return stateSummary(state);
        },
        presentCall: args => ({
            card: 'generic',
            title: `Record ${args.event?.type || 'omni'} event`,
            kind: 'execute'
        })
    }));

    ctx.tools.register(defineLocalTool({
        name: 'omni_status',
        description: 'Read the durable project state, task ownership, attempts, review phases, blockers, and exact next actions.',
        parameters: {
            project_id: {
                type: 'string',
                required: true,
                description: 'Project id.'
            }
        },
        output: jsonOutput('Current omni project status.'),
        isConcurrencySafe: () => true,
        async execute(args) {
            return stateSummary(await store.read(args.project_id));
        },
        presentCall: args => ({
            card: 'generic',
            title: `Inspect omni project ${args.project_id}`,
            kind: 'read'
        })
    }));

    ctx.tools.register(defineLocalTool({
        name: 'omni_cancel',
        description: 'Cancel an omni project and preserve its state for audit. Running child agents must then be stopped by the DSH lead.',
        parameters: {
            project_id: {
                type: 'string',
                required: true,
                description: 'Project id.'
            },
            reason: {
                type: 'string',
                required: true,
                description: 'Why the project is cancelled.'
            }
        },
        output: jsonOutput('Cancelled project state.'),
        async execute(args) {
            const state = await store.update(args.project_id, current =>
                cancelProjectState(current, args.reason)
            );
            return stateSummary(state);
        },
        presentCall: args => ({
            card: 'generic',
            title: `Cancel omni project ${args.project_id}`,
            kind: 'execute'
        })
    }));

    ctx.tools.register(defineLocalTool({
        name: 'omni_identity',
        description: 'Ensure the configured or supplied DSH-owned identity has its own VCP diary and knowledge diary, without adding it to VCP Agent or AA rosters.',
        parameters: {
            name: {
                type: 'string',
                description: `Must equal the preset-owned identity ${config.identityName}.`
            }
        },
        output: jsonOutput('DSH-owned identity and memory references.'),
        async execute(args, exec) {
            const selectedIdentity = normalizeDshIdentityName(
                args.name?.trim() || config.identityName
            );
            if (selectedIdentity !== config.identityName) {
                throw new TypeError(
                    `This preset owns "${config.identityName}", not "${selectedIdentity}".`
                );
            }
            return ensureIdentity(selectedIdentity, exec);
        },
        presentCall: args => ({
            card: 'generic',
            title: `Ensure DSH identity ${args.name || config.identityName}`,
            kind: 'execute'
        })
    }));
}
