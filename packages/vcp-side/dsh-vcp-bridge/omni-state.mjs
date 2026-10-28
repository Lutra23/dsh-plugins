import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
    normalizeCapabilities,
    normalizeDshIdentityName,
    presetIdForAlias
} = require('./agent-contract.cjs');

export const OMNI_STATE_SCHEMA = 'dsh-vcp-omni-project';
export const OMNI_STATE_VERSION = 1;
export const MAX_VCP_SUBMISSIONS = 2;
export const MAX_SECOND_REVIEW_ROUNDS = 2;
export const MAX_FINAL_FIXES = 1;

const TASK_TERMINAL_STATUSES = new Set(['unit_passed', 'taken_over']);
const TASK_ACTIVE_STATUSES = new Set([
    'dispatched',
    'unit_review',
    'unit_rework',
    'takeover'
]);
const PROJECT_TERMINAL_STATUSES = new Set(['completed', 'blocked', 'cancelled']);

function clone(value) {
    return structuredClone(value);
}

function requireString(value, field, maxLength = 100_000) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new TypeError(`${field} must be a non-empty string.`);
    }
    const normalized = value.trim();
    if (normalized.length > maxLength) {
        throw new TypeError(`${field} is too long.`);
    }
    return normalized;
}

function optionalString(value, field, maxLength = 20_000) {
    if (value === undefined || value === null || value === '') return '';
    return requireString(value, field, maxLength);
}

function normalizeStringList(value, field, maxItems = 100) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new TypeError(`${field} must be an array.`);
    if (value.length > maxItems) throw new TypeError(`${field} contains too many items.`);
    return value.map((item, index) => requireString(item, `${field}[${index}]`, 4_000));
}

function normalizeFindingList(value, field) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new TypeError(`${field} must be an array.`);
    if (value.length > 100) throw new TypeError(`${field} contains too many items.`);
    return value.map((item, index) => {
        if (typeof item === 'string') return requireString(item, `${field}[${index}]`, 8_000);
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new TypeError(`${field}[${index}] must be a string or object.`);
        }
        return clone(item);
    });
}

function normalizeTaskId(raw) {
    const taskId = requireString(raw, 'taskId', 80);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(taskId)) {
        throw new TypeError(
            'taskId must start with an ASCII letter or digit and contain only letters, digits, ".", "_" or "-".'
        );
    }
    return taskId;
}

export function normalizeWorkspacePath(rawValue, field = 'path') {
    const raw = requireString(rawValue, field, 2_000)
        .replace(/\\/g, '/')
        .replace(/^\.\/+/, '')
        .replace(/\/+/g, '/');
    if (
        raw.startsWith('/')
        || /^[a-zA-Z]:\//.test(raw)
        || raw.split('/').some(part => part === '..' || part === '.')
        || raw.includes('*')
    ) {
        throw new TypeError(`${field} must be a workspace-relative path without traversal or wildcards.`);
    }
    return raw.replace(/\/+$/g, '');
}

function normalizeScope(rawValue) {
    const raw = requireString(rawValue, 'writeScope', 2_000)
        .replace(/\\/g, '/')
        .replace(/^\.\/+/, '')
        .replace(/\/+/g, '/');
    if (
        raw.startsWith('/')
        || /^[a-zA-Z]:\//.test(raw)
        || raw.split('/').some(part => part === '..' || part === '.')
    ) {
        throw new TypeError('writeScope must be workspace-relative without traversal.');
    }
    const wildcard = raw.match(/^(.*?)(?:\/(?:\*\*|\*))$/);
    if (wildcard) {
        const base = wildcard[1].replace(/\/+$/g, '');
        if (!base || base.includes('*')) {
            throw new TypeError('writeScope wildcard must follow a concrete path.');
        }
        return `${base}/**`;
    }
    if (raw.includes('*')) {
        throw new TypeError('writeScope only supports a trailing /* or /**.');
    }
    return raw.replace(/\/+$/g, '');
}

function scopeBase(scope) {
    return scope.endsWith('/**') ? scope.slice(0, -3) : scope;
}

export function scopesOverlap(left, right) {
    const leftBase = scopeBase(normalizeScope(left));
    const rightBase = scopeBase(normalizeScope(right));
    return leftBase === rightBase
        || leftBase.startsWith(`${rightBase}/`)
        || rightBase.startsWith(`${leftBase}/`);
}

export function fileCoveredByScopes(filePath, scopes) {
    const normalizedFile = normalizeWorkspacePath(filePath, 'changedFiles[]');
    return scopes.some(scope => {
        const base = scopeBase(scope);
        return normalizedFile === base || normalizedFile.startsWith(`${base}/`);
    });
}

function findTask(state, rawTaskId) {
    const taskId = normalizeTaskId(rawTaskId);
    const task = state.tasks.find(candidate => candidate.id === taskId);
    if (!task) throw new TypeError(`Unknown taskId "${taskId}".`);
    return task;
}

function assertDistinctReviewer(state, contextId, task = null) {
    const reviewerContextId = requireString(contextId, 'reviewerContextId', 200);
    if (state.reviewerContextIds.includes(reviewerContextId)) {
        throw new TypeError('Each review must use a fresh context; reviewerContextId was already used.');
    }
    if (task && task.executorContextId === reviewerContextId) {
        throw new TypeError('Unit review must use a context different from the executing VCP Agent.');
    }
    return reviewerContextId;
}

function assertTaskDependenciesComplete(state, task) {
    for (const dependencyId of task.dependencies) {
        const dependency = state.tasks.find(candidate => candidate.id === dependencyId);
        if (!dependency || !TASK_TERMINAL_STATUSES.has(dependency.status)) {
            throw new TypeError(
                `Task "${task.id}" cannot run before dependency "${dependencyId}" passes review.`
            );
        }
    }
}

function assertDispatchDoesNotConflict(state, task) {
    for (const other of state.tasks) {
        if (other.id === task.id || !TASK_ACTIVE_STATUSES.has(other.status)) continue;
        if (other.agentName === task.agentName) {
            throw new TypeError(
                `VCP Agent "${task.agentName}" already has active task "${other.id}".`
            );
        }
        for (const scope of task.writeScopes) {
            for (const otherScope of other.writeScopes) {
                if (scopesOverlap(scope, otherScope)) {
                    throw new TypeError(
                        `Task "${task.id}" write scope "${scope}" overlaps active task `
                        + `"${other.id}" scope "${otherScope}".`
                    );
                }
            }
        }
    }
}

function appendHistory(state, type, detail) {
    state.history.push({
        at: new Date().toISOString(),
        type,
        detail
    });
    if (state.history.length > 500) state.history.splice(0, state.history.length - 500);
}

function allTasksTerminal(state) {
    return state.tasks.length > 0
        && state.tasks.every(task => TASK_TERMINAL_STATUSES.has(task.status));
}

function phaseAfterTaskPass(state) {
    if (allTasksTerminal(state)) return 'INTEGRATION';
    if (state.tasks.some(task => (
        task.status === 'dispatched'
        || task.status === 'unit_rework'
        || task.status === 'takeover'
    ))) {
        return 'EXECUTING';
    }
    if (state.tasks.some(task => task.status === 'unit_review')) {
        return 'UNIT_REVIEW';
    }
    if (state.tasks.some(task => task.status === 'planned')) {
        return 'DISPATCHING';
    }
    return 'INTEGRATION';
}

function assertProjectActive(state) {
    if (PROJECT_TERMINAL_STATUSES.has(state.status)) {
        throw new TypeError(`Project "${state.projectId}" is ${state.status}.`);
    }
}

function validateDependencyGraph(tasks) {
    const byId = new Map(tasks.map(task => [task.id, task]));
    const visiting = new Set();
    const visited = new Set();

    const visit = task => {
        if (visiting.has(task.id)) {
            throw new TypeError(`Task dependency cycle detected at "${task.id}".`);
        }
        if (visited.has(task.id)) return;
        visiting.add(task.id);
        for (const dependencyId of task.dependencies) {
            const dependency = byId.get(dependencyId);
            if (!dependency) {
                throw new TypeError(`Task "${task.id}" references missing dependency "${dependencyId}".`);
            }
            visit(dependency);
        }
        visiting.delete(task.id);
        visited.add(task.id);
    };

    for (const task of tasks) visit(task);
}

export function createProjectState({
    projectId,
    goal,
    identityName,
    workspaceRoot,
    agentCatalog,
    agentCatalogRevision
}) {
    const normalizedProjectId = requireString(projectId, 'projectId', 100);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(normalizedProjectId)) {
        throw new TypeError('projectId contains unsupported characters.');
    }
    const normalizedGoal = requireString(goal, 'goal', 100_000);
    const normalizedIdentityName = normalizeDshIdentityName(identityName);
    const normalizedWorkspaceRoot = requireString(workspaceRoot, 'workspaceRoot', 2_000);
    if (!Array.isArray(agentCatalog) || agentCatalog.length === 0) {
        throw new TypeError('agentCatalog must contain at least one VCP Agent.');
    }

    const seenAliases = new Set();
    const normalizedCatalog = agentCatalog.map((agent, index) => {
        const alias = requireString(agent?.alias, `agentCatalog[${index}].alias`, 100);
        if (seenAliases.has(alias)) {
            throw new TypeError(`Duplicate VCP Agent alias "${alias}" in catalog.`);
        }
        seenAliases.add(alias);
        return {
            alias,
            presetId: presetIdForAlias(alias),
            capabilities: normalizeCapabilities(agent.capabilities)
        };
    }).sort((left, right) => left.alias.localeCompare(right.alias, 'zh-CN'));

    const now = new Date().toISOString();
    return {
        schema: OMNI_STATE_SCHEMA,
        schemaVersion: OMNI_STATE_VERSION,
        projectId: normalizedProjectId,
        goal: normalizedGoal,
        identityName: normalizedIdentityName,
        workspaceRoot: normalizedWorkspaceRoot,
        status: 'planning',
        phase: 'PLANNING',
        plan: '',
        tasks: [],
        agentCatalog: normalizedCatalog,
        agentCatalogRevision: optionalString(agentCatalogRevision, 'agentCatalogRevision', 200),
        limits: {
            vcpSubmissions: MAX_VCP_SUBMISSIONS,
            secondReviewRounds: MAX_SECOND_REVIEW_ROUNDS,
            finalFixes: MAX_FINAL_FIXES
        },
        integration: {
            rounds: 0,
            contextIds: [],
            latest: null
        },
        secondReview: {
            failures: 0,
            reviewerContextIds: [],
            latest: null
        },
        finalReview: {
            failures: 0,
            fixesUsed: 0,
            fixContextIds: [],
            latestReview: null,
            latestFix: null
        },
        reviewerContextIds: [],
        history: [],
        createdAt: now,
        updatedAt: now
    };
}

export function planProjectState(state, { plan, tasks }) {
    assertProjectActive(state);
    if (state.phase !== 'PLANNING') {
        throw new TypeError(`Project planning is no longer available in phase ${state.phase}.`);
    }
    const normalizedPlan = requireString(plan, 'plan', 500_000);
    if (!Array.isArray(tasks) || tasks.length === 0) {
        throw new TypeError('tasks must contain at least one task.');
    }
    if (tasks.length > 100) throw new TypeError('A project can contain at most 100 tasks.');

    const catalogByAlias = new Map(state.agentCatalog.map(agent => [agent.alias, agent]));
    const seenIds = new Set();
    const nextTasks = tasks.map((candidate, index) => {
        const id = normalizeTaskId(candidate?.id);
        if (seenIds.has(id)) throw new TypeError(`Duplicate task id "${id}".`);
        seenIds.add(id);
        const agentName = requireString(candidate.agentName, `tasks[${index}].agentName`, 100);
        const catalogAgent = catalogByAlias.get(agentName);
        if (!catalogAgent) {
            throw new TypeError(
                `Task "${id}" names VCP Agent "${agentName}", which is not in the captured catalog.`
            );
        }
        const writeScopes = [...new Set(
            (candidate.writeScopes || []).map(normalizeScope)
        )];
        const dependencies = [...new Set(
            (candidate.dependencies || []).map(normalizeTaskId)
        )];
        if (dependencies.includes(id)) throw new TypeError(`Task "${id}" cannot depend on itself.`);

        return {
            id,
            title: requireString(candidate.title, `tasks[${index}].title`, 500),
            description: requireString(candidate.description, `tasks[${index}].description`, 100_000),
            agentName,
            agentPresetId: catalogAgent.presetId,
            capabilities: catalogAgent.capabilities,
            assignmentReason: optionalString(
                candidate.assignmentReason,
                `tasks[${index}].assignmentReason`,
                10_000
            ),
            writeScopes,
            dependencies,
            deliverables: normalizeStringList(
                candidate.deliverables,
                `tasks[${index}].deliverables`
            ),
            acceptanceCriteria: normalizeStringList(
                candidate.acceptanceCriteria,
                `tasks[${index}].acceptanceCriteria`
            ),
            status: 'planned',
            attempts: 0,
            executorContextId: null,
            reviewerContextId: null,
            submissions: [],
            findings: [],
            requiredChanges: [],
            takeover: null
        };
    });

    validateDependencyGraph(nextTasks);
    state.plan = normalizedPlan;
    state.tasks = nextTasks;
    state.status = 'running';
    state.phase = 'DISPATCHING';
    state.updatedAt = new Date().toISOString();
    appendHistory(state, 'plan', {
        taskCount: nextTasks.length,
        agents: [...new Set(nextTasks.map(task => task.agentName))]
    });
    return state;
}

function applyDispatchEvent(state, event) {
    const task = findTask(state, event.taskId);
    if (task.status !== 'planned') {
        throw new TypeError(`Task "${task.id}" cannot be dispatched from status ${task.status}.`);
    }
    assertTaskDependenciesComplete(state, task);
    assertDispatchDoesNotConflict(state, task);
    task.executorContextId = requireString(event.executorContextId, 'executorContextId', 200);
    task.status = 'dispatched';
    state.phase = 'EXECUTING';
    state.updatedAt = new Date().toISOString();
    appendHistory(state, 'dispatch', {
        taskId: task.id,
        agentName: task.agentName,
        executorContextId: task.executorContextId,
        writeScopes: task.writeScopes
    });
    return state;
}

function applySubmitEvent(state, event) {
    const task = findTask(state, event.taskId);
    if (!['dispatched', 'unit_rework'].includes(task.status)) {
        throw new TypeError(`Task "${task.id}" cannot submit from status ${task.status}.`);
    }
    if (task.attempts >= state.limits.vcpSubmissions) {
        throw new TypeError(`Task "${task.id}" already reached the VCP submission limit.`);
    }
    const result = event.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw new TypeError('result must be a structured object.');
    }
    if (result.taskId !== undefined && normalizeTaskId(result.taskId) !== task.id) {
        throw new TypeError('result.taskId does not match the submitting task.');
    }
    if (result.agentName !== undefined && result.agentName !== task.agentName) {
        throw new TypeError('result.agentName does not match the assigned VCP Agent.');
    }
    if (result.selfReview?.verdict !== 'pass') {
        throw new TypeError('A VCP submission must pass the assigned Agent self-review first.');
    }
    if (event.executorContextId !== undefined) {
        task.executorContextId = requireString(
            event.executorContextId,
            'executorContextId',
            200
        );
    }

    const changedFiles = normalizeStringList(result.changedFiles, 'result.changedFiles', 500)
        .map(file => normalizeWorkspacePath(file, 'result.changedFiles[]'));
    for (const file of changedFiles) {
        if (!fileCoveredByScopes(file, task.writeScopes)) {
            throw new TypeError(
                `Task "${task.id}" changed "${file}" outside its assigned write scope.`
            );
        }
    }

    task.attempts += 1;
    task.submissions.push({
        attempt: task.attempts,
        submittedAt: new Date().toISOString(),
        executorContextId: task.executorContextId,
        result: clone(result),
        changedFiles
    });
    task.status = 'unit_review';
    task.reviewerContextId = null;
    task.findings = [];
    task.requiredChanges = [];
    state.phase = 'UNIT_REVIEW';
    state.updatedAt = new Date().toISOString();
    appendHistory(state, 'submit', {
        taskId: task.id,
        agentName: task.agentName,
        attempt: task.attempts,
        changedFiles
    });
    return state;
}

function applyUnitReviewEvent(state, event) {
    const task = findTask(state, event.taskId);
    if (task.status !== 'unit_review') {
        throw new TypeError(`Task "${task.id}" is not awaiting unit review.`);
    }
    const reviewerContextId = assertDistinctReviewer(state, event.reviewerContextId, task);
    state.reviewerContextIds.push(reviewerContextId);
    task.reviewerContextId = reviewerContextId;
    task.findings = normalizeFindingList(event.findings, 'findings');
    task.requiredChanges = normalizeStringList(event.requiredChanges, 'requiredChanges');

    const verdict = requireString(event.verdict, 'verdict', 20).toLowerCase();
    if (!['pass', 'rework'].includes(verdict)) {
        throw new TypeError('unit_review verdict must be "pass" or "rework".');
    }

    if (verdict === 'pass') {
        task.status = 'unit_passed';
        state.phase = phaseAfterTaskPass(state);
    } else if (task.attempts >= state.limits.vcpSubmissions) {
        task.status = 'takeover';
        task.takeover = {
            required: true,
            triggeredAt: new Date().toISOString(),
            reason: 'VCP Agent failed two unit reviews; DSH must take over this task.',
            findings: clone(task.findings),
            requiredChanges: clone(task.requiredChanges)
        };
        state.phase = 'EXECUTING';
    } else {
        task.status = 'unit_rework';
        state.phase = 'EXECUTING';
    }
    state.updatedAt = new Date().toISOString();
    appendHistory(state, 'unit_review', {
        taskId: task.id,
        reviewerContextId,
        verdict,
        taskStatus: task.status
    });
    return state;
}

function applyTakeoverCompleteEvent(state, event) {
    const task = findTask(state, event.taskId);
    if (task.status !== 'takeover') {
        throw new TypeError(`Task "${task.id}" is not awaiting DSH takeover.`);
    }
    const summary = requireString(event.summary, 'summary', 100_000);
    const changedFiles = normalizeStringList(event.changedFiles, 'changedFiles', 500)
        .map(file => normalizeWorkspacePath(file, 'changedFiles[]'));
    task.takeover = {
        ...task.takeover,
        completedAt: new Date().toISOString(),
        summary,
        changedFiles,
        verification: normalizeStringList(event.verification, 'verification')
    };
    task.status = 'taken_over';
    state.phase = phaseAfterTaskPass(state);
    state.updatedAt = new Date().toISOString();
    appendHistory(state, 'takeover_complete', {
        taskId: task.id,
        changedFiles
    });
    return state;
}

function applyIntegrateEvent(state, event) {
    if (!allTasksTerminal(state)) {
        throw new TypeError('Integration requires every task to pass unit review or DSH takeover.');
    }
    if (state.integration.rounds >= state.limits.secondReviewRounds) {
        throw new TypeError('The integration/second-review correction limit has been reached.');
    }
    const integrationContextId = requireString(
        event.integrationContextId,
        'integrationContextId',
        200
    );
    if (state.integration.latest?.integrationContextId === integrationContextId) {
        throw new TypeError('A fresh DSH integration context is required after a failed second review.');
    }
    if (state.integration.contextIds.includes(integrationContextId)) {
        throw new TypeError('Each DSH integration round must use a fresh context.');
    }
    if (state.reviewerContextIds.includes(integrationContextId)) {
        throw new TypeError('A review context cannot also be used for integration.');
    }
    state.integration.contextIds.push(integrationContextId);
    state.integration.rounds += 1;
    state.integration.latest = {
        round: state.integration.rounds,
        integratedAt: new Date().toISOString(),
        integrationContextId,
        summary: requireString(event.summary, 'summary', 200_000),
        artifacts: normalizeStringList(event.artifacts, 'artifacts', 500),
        changedFiles: normalizeStringList(event.changedFiles, 'changedFiles', 500)
            .map(file => normalizeWorkspacePath(file, 'changedFiles[]')),
        verification: normalizeStringList(event.verification, 'verification', 200)
    };
    state.phase = 'SECOND_REVIEW';
    state.updatedAt = new Date().toISOString();
    appendHistory(state, 'integrate', {
        round: state.integration.rounds,
        integrationContextId
    });
    return state;
}

function applySecondReviewEvent(state, event) {
    if (state.phase !== 'SECOND_REVIEW' || !state.integration.latest) {
        throw new TypeError('There is no integrated result awaiting the DSH second review.');
    }
    const reviewerContextId = assertDistinctReviewer(state, event.reviewerContextId);
    if (state.integration.contextIds.includes(reviewerContextId)) {
        throw new TypeError('DSH second review must use a context different from integration.');
    }
    state.reviewerContextIds.push(reviewerContextId);
    state.secondReview.reviewerContextIds.push(reviewerContextId);
    const verdict = requireString(event.verdict, 'verdict', 20).toLowerCase();
    if (!['pass', 'rework'].includes(verdict)) {
        throw new TypeError('second_review verdict must be "pass" or "rework".');
    }
    state.secondReview.latest = {
        reviewedAt: new Date().toISOString(),
        reviewerContextId,
        verdict,
        findings: normalizeFindingList(event.findings, 'findings'),
        requiredChanges: normalizeStringList(event.requiredChanges, 'requiredChanges'),
        reworkTasks: []
    };

    if (verdict === 'pass') {
        state.phase = 'FINAL_REVIEW';
    } else {
        state.secondReview.failures += 1;
        if (state.secondReview.failures >= state.limits.secondReviewRounds) {
            state.status = 'blocked';
            state.phase = 'BLOCKED';
            state.blockedReason = 'DSH second review failed twice after integration.';
        } else {
            const reworkRequests = event.reworkTasks === undefined
                ? []
                : event.reworkTasks;
            if (!Array.isArray(reworkRequests)) {
                throw new TypeError('reworkTasks must be an array.');
            }
            for (const request of reworkRequests) {
                const task = findTask(state, request?.taskId);
                if (!TASK_TERMINAL_STATUSES.has(task.status)) {
                    throw new TypeError(
                        `Second-review rework target "${task.id}" is not in a terminal task state.`
                    );
                }
                const requiredChanges = normalizeStringList(
                    request.requiredChanges,
                    'reworkTasks[].requiredChanges'
                );
                if (requiredChanges.length === 0) {
                    throw new TypeError(
                        `Second-review rework for "${task.id}" requires at least one required change.`
                    );
                }
                const findings = normalizeFindingList(
                    request.findings,
                    'reworkTasks[].findings'
                );
                const rework = {
                    triggeredAt: new Date().toISOString(),
                    sourceReviewerContextId: reviewerContextId,
                    requiredChanges,
                    findings
                };
                task.integrationRework = [
                    ...(task.integrationRework || []),
                    rework
                ];
                task.findings = findings;
                task.requiredChanges = requiredChanges;
                if (task.status === 'taken_over') {
                    task.status = 'takeover';
                    task.takeover = {
                        required: true,
                        triggeredAt: new Date().toISOString(),
                        reason: 'DSH second review found a remaining issue in a task already owned by DSH.',
                        findings,
                        requiredChanges
                    };
                } else if (task.attempts >= state.limits.vcpSubmissions) {
                    task.status = 'takeover';
                    task.takeover = {
                        required: true,
                        triggeredAt: new Date().toISOString(),
                        reason: 'DSH second review requested another VCP rework, but the submission limit was already reached.',
                        findings,
                        requiredChanges
                    };
                } else {
                    task.status = 'unit_rework';
                }
                state.secondReview.latest.reworkTasks.push({
                    taskId: task.id,
                    agentName: task.agentName,
                    resultingTaskStatus: task.status,
                    requiredChanges
                });
            }
            state.phase = state.secondReview.latest.reworkTasks.length > 0
                ? 'EXECUTING'
                : 'INTEGRATION';
        }
    }
    state.updatedAt = new Date().toISOString();
    appendHistory(state, 'second_review', {
        reviewerContextId,
        verdict,
        failures: state.secondReview.failures,
        phase: state.phase,
        reworkTasks: state.secondReview.latest.reworkTasks
    });
    return state;
}

function applyFinalReviewEvent(state, event) {
    if (state.phase !== 'FINAL_REVIEW') {
        throw new TypeError(`Final review is unavailable in phase ${state.phase}.`);
    }
    const reviewerContextId = assertDistinctReviewer(state, event.reviewerContextId);
    if (state.integration.contextIds.includes(reviewerContextId)) {
        throw new TypeError('Final review must be independent from integration.');
    }
    if (state.finalReview.fixContextIds?.includes(reviewerContextId)) {
        throw new TypeError('The DSH final fixer cannot approve its own final correction.');
    }
    state.reviewerContextIds.push(reviewerContextId);
    const verdict = requireString(event.verdict, 'verdict', 20).toLowerCase();
    if (!['pass', 'rework'].includes(verdict)) {
        throw new TypeError('final_review verdict must be "pass" or "rework".');
    }
    const review = {
        reviewedAt: new Date().toISOString(),
        reviewerContextId,
        verdict,
        findings: normalizeFindingList(event.findings, 'findings'),
        requiredChanges: normalizeStringList(event.requiredChanges, 'requiredChanges')
    };
    state.finalReview.latestReview = review;

    if (verdict === 'pass') {
        state.status = 'completed';
        state.phase = 'COMPLETED';
        state.completedAt = new Date().toISOString();
    } else {
        state.finalReview.failures += 1;
        if (state.finalReview.fixesUsed < state.limits.finalFixes) {
            state.phase = 'FINAL_FIX';
        } else {
            state.status = 'blocked';
            state.phase = 'BLOCKED';
            state.blockedReason = 'Final review failed after the one permitted DSH final fix.';
        }
    }
    state.updatedAt = new Date().toISOString();
    appendHistory(state, 'final_review', {
        reviewerContextId,
        verdict,
        failures: state.finalReview.failures,
        phase: state.phase
    });
    return state;
}

function applyFinalFixEvent(state, event) {
    if (state.phase !== 'FINAL_FIX') {
        throw new TypeError(`Final fix is unavailable in phase ${state.phase}.`);
    }
    const contextId = requireString(event.contextId, 'contextId', 200);
    if (
        state.reviewerContextIds.includes(contextId)
        || state.integration.contextIds.includes(contextId)
    ) {
        throw new TypeError('The DSH final fixer must use a context independent from reviewers and integrators.');
    }
    if (state.finalReview.fixContextIds?.includes(contextId)) {
        throw new TypeError('The DSH final fix context was already used.');
    }
    state.finalReview.fixesUsed += 1;
    state.finalReview.fixContextIds = [
        ...(state.finalReview.fixContextIds || []),
        contextId
    ];
    state.finalReview.latestFix = {
        fixedAt: new Date().toISOString(),
        contextId,
        summary: requireString(event.summary, 'summary', 200_000),
        changedFiles: normalizeStringList(event.changedFiles, 'changedFiles', 500)
            .map(file => normalizeWorkspacePath(file, 'changedFiles[]')),
        verification: normalizeStringList(event.verification, 'verification', 200)
    };
    state.phase = 'FINAL_REVIEW';
    state.updatedAt = new Date().toISOString();
    appendHistory(state, 'final_fix', {
        contextId: state.finalReview.latestFix.contextId,
        fixesUsed: state.finalReview.fixesUsed
    });
    return state;
}

function applyBlockEvent(state, event) {
    if (PROJECT_TERMINAL_STATUSES.has(state.status)) {
        throw new TypeError(`Project is already ${state.status}.`);
    }
    state.status = 'blocked';
    state.phase = 'BLOCKED';
    state.blockedReason = requireString(event.reason, 'reason', 20_000);
    state.updatedAt = new Date().toISOString();
    appendHistory(state, 'block', {
        reason: state.blockedReason
    });
    return state;
}

export function applyProjectEvent(currentState, event) {
    const state = clone(currentState);
    assertProjectActive(state);
    const type = requireString(event?.type, 'event.type', 40).toLowerCase();
    switch (type) {
        case 'dispatch':
            return applyDispatchEvent(state, event);
        case 'submit':
            return applySubmitEvent(state, event);
        case 'unit_review':
            return applyUnitReviewEvent(state, event);
        case 'takeover_complete':
            return applyTakeoverCompleteEvent(state, event);
        case 'integrate':
            return applyIntegrateEvent(state, event);
        case 'second_review':
            return applySecondReviewEvent(state, event);
        case 'final_review':
            return applyFinalReviewEvent(state, event);
        case 'final_fix':
            return applyFinalFixEvent(state, event);
        case 'block':
            return applyBlockEvent(state, event);
        default:
            throw new TypeError(`Unknown omni event type "${type}".`);
    }
}

export function cancelProjectState(currentState, reason) {
    const state = clone(currentState);
    if (state.status === 'completed') {
        throw new TypeError('A completed project cannot be cancelled.');
    }
    if (state.status === 'cancelled') return state;
    state.status = 'cancelled';
    state.phase = 'CANCELLED';
    state.cancelReason = requireString(reason, 'reason', 20_000);
    state.updatedAt = new Date().toISOString();
    appendHistory(state, 'cancel', {
        reason: state.cancelReason
    });
    return state;
}

export function projectNextActions(state) {
    const taskList = status => state.tasks
        .filter(task => task.status === status)
        .map(task => task.id);
    switch (state.phase) {
        case 'PLANNING':
            return ['Draft the plan and call omni_plan with the assigned task list.'];
        case 'DISPATCHING': {
            const ready = state.tasks
                .filter(task => task.status === 'planned')
                .map(task => task.id);
            return ready.length > 0
                ? [`Dispatch ready tasks: ${ready.join(', ')}.`]
                : ['Wait for active task results.'];
        }
        case 'EXECUTING':
            return [
                `Continue or await executing tasks: ${taskList('dispatched').concat(taskList('unit_rework')).join(', ') || 'none'}.`,
                'Complete DSH takeover tasks before integration.'
            ];
        case 'UNIT_REVIEW':
            return [`Run a fresh DSH unit review for tasks: ${[...taskList('unit_review'), ...taskList('unit_rework')].join(', ')}.`];
        case 'INTEGRATION':
            return ['Spawn a fresh DSH integrator, then record the integrated result.'];
        case 'SECOND_REVIEW':
            return ['Run a fresh DSH second review over the integrated result.'];
        case 'FINAL_REVIEW':
            return ['Run an independent final reviewer that checks the original goal and integrated result.'];
        case 'FINAL_FIX':
            return ['DSH must make the final correction, then call final_fix.'];
        case 'COMPLETED':
            return ['Return the final result and process report.'];
        case 'BLOCKED':
            return ['Report the blocker and unresolved review findings.'];
        case 'CANCELLED':
            return ['Stop dispatching work and return cancellation details.'];
        default:
            return [];
    }
}

export class OmniProjectStore {
    constructor(stateDirectory) {
        if (typeof stateDirectory !== 'string' || !stateDirectory.trim()) {
            throw new TypeError('OmniProjectStore requires stateDirectory.');
        }
        this.stateDirectory = path.resolve(stateDirectory);
        this.queues = new Map();
    }

    projectPath(projectId) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(projectId || '')) {
            throw new TypeError('Invalid projectId.');
        }
        return path.join(this.stateDirectory, `${projectId}.json`);
    }

    async ensureDirectory() {
        await mkdir(this.stateDirectory, { recursive: true });
    }

    async atomicWrite(filePath, value) {
        await this.ensureDirectory();
        const tempPath = path.join(
            this.stateDirectory,
            `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
        );
        try {
            await writeFile(tempPath, JSON.stringify(value, null, 2), 'utf8');
            await rename(tempPath, filePath);
        } catch (error) {
            try {
                await unlink(tempPath);
            } catch {
                // Temp file was not created or cleanup already completed.
            }
            throw error;
        }
    }

    async create(state) {
        const operation = (this.queues.get(state.projectId) || Promise.resolve())
            .then(async () => {
                const filePath = this.projectPath(state.projectId);
                await this.ensureDirectory();
                try {
                    await readFile(filePath, 'utf8');
                    throw new TypeError(`Project "${state.projectId}" already exists.`);
                } catch (error) {
                    if (error.code !== 'ENOENT') throw error;
                }
                await this.atomicWrite(filePath, state);
                return clone(state);
            });
        this.queues.set(state.projectId, operation.catch(() => undefined));
        return operation;
    }

    async read(projectId) {
        const filePath = this.projectPath(projectId);
        try {
            return JSON.parse(await readFile(filePath, 'utf8'));
        } catch (error) {
            if (error.code === 'ENOENT') {
                throw new TypeError(`Unknown omni project "${projectId}".`);
            }
            throw error;
        }
    }

    async update(projectId, updater) {
        const operation = (this.queues.get(projectId) || Promise.resolve())
            .then(async () => {
                const current = await this.read(projectId);
                const next = await updater(clone(current));
                await this.atomicWrite(this.projectPath(projectId), next);
                return clone(next);
            });
        this.queues.set(projectId, operation.catch(() => undefined));
        return operation;
    }
}
