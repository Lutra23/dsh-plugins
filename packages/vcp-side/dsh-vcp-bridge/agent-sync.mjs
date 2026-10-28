import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { watch } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { evaluateOptionalIntegrations } from './optional-integrations.mjs';
import { buildPresetDefinitions } from './preset-templates.mjs';
import {
    readSelectionState,
    resolveSelectionStatePath,
    writeSelectionState
} from './selection-state.mjs';

const require = createRequire(import.meta.url);
const {
    AGENT_SYNC_SCHEMA,
    AGENT_SYNC_SCHEMA_VERSION,
    createVcpMemoryIdentity,
    extractAgentDescription,
    isValidVcpAlias,
    normalizeAgentDescription,
    normalizeCapabilities,
    presetIdForAlias,
    resolveAgentPromptPath,
    stableHash
} = require('./agent-contract.cjs');
const {
    readDescriptionMap
} = require('./agent-snapshot.cjs');

export { isValidVcpAlias, presetIdForAlias };

export const name = '@local/dsh-vcp-agent-sync';
export const inject = ['agentPresets', 'credentials'];

const DEFAULT_SNAPSHOT_URL = 'http://127.0.0.1:6005/api/plugins/DSHAgentSync/snapshot';
const DEFAULT_API_KEY_ENV = 'VCPTOOLBOX_API_KEY';
const DEFAULT_SNAPSHOT_TIMEOUT_MS = 5_000;

function promptHash(text) {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function readCapabilityMap(capabilityMapPath) {
    if (!capabilityMapPath) return {};
    try {
        const parsed = JSON.parse(await readFile(capabilityMapPath, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new TypeError('agent_capabilities.json must contain an object.');
        }
        return Object.fromEntries(
            Object.entries(parsed)
                .filter(([alias]) => isValidVcpAlias(alias))
                .map(([alias, values]) => [alias, normalizeCapabilities(values)])
        );
    } catch (error) {
        if (error.code === 'ENOENT') return {};
        throw error;
    }
}

function catalogRevision(agents) {
    return stableHash(JSON.stringify(agents), 16);
}

async function resolveOptionalIntegrations(config, rawConfig) {
    return evaluateOptionalIntegrations({
        hostVersion: config.hostVersion,
        cordisVersion: config.cordisVersion,
        projectForge: {
            installed: Boolean(config.projectForgeVersion),
            enabled: rawConfig.enableProjectForge !== false,
            version: config.projectForgeVersion
        },
        forgeContext: {
            installed: Boolean(config.forgeContextVersion),
            enabled: rawConfig.enableForgeContext !== false,
            version: config.forgeContextVersion
        }
    });
}

async function readLocalAgentCatalog(
    agentMapPath,
    agentDirectory,
    presetPrefix = 'vcp-agent',
    capabilityMapPath = '',
    descriptionMapPath = '',
    previousDescriptions = {}
) {
    const mapText = await readFile(agentMapPath, 'utf8');
    const mapping = JSON.parse(mapText);
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
        throw new Error('agent_map.json must contain a mapping of alias to prompt file.');
    }

    let capabilities = {};
    let descriptions = {};
    const diagnostics = [];
    try {
        capabilities = await readCapabilityMap(capabilityMapPath);
    } catch (error) {
        diagnostics.push({
            code: 'CAPABILITIES_INVALID',
            message: `agent_capabilities.json could not be read: ${error.message}`
        });
    }
    try {
        descriptions = await readDescriptionMap(descriptionMapPath);
    } catch (error) {
        descriptions = Object.fromEntries(
            Object.entries(previousDescriptions || {})
                .map(([alias, value]) => [alias, normalizeAgentDescription(value)])
                .filter(([alias, value]) => isValidVcpAlias(alias) && Boolean(value))
        );
        diagnostics.push({
            code: 'DESCRIPTIONS_INVALID',
            message: `agent_descriptions.json could not be read; retaining the last valid descriptions: ${error.message}`
        });
    }

    const usedIds = new Set();
    const agents = [];
    for (const [alias, relativeFile] of Object.entries(mapping)) {
        if (!isValidVcpAlias(alias)) {
            diagnostics.push({
                code: 'INVALID_ALIAS',
                alias,
                message: 'Agent alias is outside the VCP placeholder-safe naming grammar.'
            });
            continue;
        }
        if (typeof relativeFile !== 'string' || !relativeFile.trim()) {
            diagnostics.push({
                code: 'INVALID_PROMPT_PATH',
                alias,
                message: 'Agent prompt mapping must be a non-empty relative path.'
            });
            continue;
        }

        let resolved;
        try {
            resolved = resolveAgentPromptPath(agentDirectory, relativeFile);
        } catch (error) {
            diagnostics.push({
                code: 'UNSAFE_PROMPT_PATH',
                alias,
                fileName: relativeFile,
                message: error.message
            });
            continue;
        }

        try {
            const info = await stat(resolved.promptPath);
            if (!info.isFile()) throw new Error('Mapped prompt is not a file.');
        } catch (error) {
            diagnostics.push({
                code: 'PROMPT_UNAVAILABLE',
                alias,
                fileName: resolved.fileName,
                message: error.message
            });
            continue;
        }

        const promptText = await readFile(resolved.promptPath, 'utf8');
        const derivedDescription = extractAgentDescription(promptText, alias);
        let presetId = presetIdForAlias(alias, presetPrefix);
        if (usedIds.has(presetId)) {
            presetId = `${presetId}-${stableHash(`${alias}:${resolved.fileName}`)}`;
        }
        usedIds.add(presetId);
        agents.push({
            alias,
            fileName: resolved.fileName,
            affiliation: 'VCP',
            promptPath: resolved.promptPath,
            promptSha256: promptHash(promptText),
            presetId,
            description: descriptions[alias] || derivedDescription.description,
            descriptionSource: descriptions[alias] ? 'override' : derivedDescription.source,
            capabilities: normalizeCapabilities(capabilities[alias]),
            memoryIdentity: createVcpMemoryIdentity(alias)
        });
    }

    agents.sort((left, right) =>
        left.alias.localeCompare(right.alias, 'zh-CN')
    );

    return {
        agents,
        revision: catalogRevision(agents),
        source: 'local-files',
        stale: false,
        diagnostics
    };
}

export async function readVcpAgentCatalog(
    agentMapPath,
    agentDirectory,
    presetPrefix = 'vcp-agent',
    capabilityMapPath = '',
    descriptionMapPath = '',
    previousDescriptions = {}
) {
    return (await readLocalAgentCatalog(
        agentMapPath,
        agentDirectory,
        presetPrefix,
        capabilityMapPath,
        descriptionMapPath,
        previousDescriptions
    )).agents;
}

function validateRemoteSnapshot(snapshot, presetPrefix) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        throw new TypeError('VCP Agent snapshot must be a JSON object.');
    }
    if (snapshot.schema !== AGENT_SYNC_SCHEMA) {
        throw new TypeError(`Unexpected VCP Agent snapshot schema: ${snapshot.schema || 'missing'}.`);
    }
    if (snapshot.schemaVersion !== AGENT_SYNC_SCHEMA_VERSION) {
        throw new TypeError(
            `Unsupported VCP Agent snapshot version: ${snapshot.schemaVersion}.`
        );
    }
    if (!Array.isArray(snapshot.agents)) {
        throw new TypeError('VCP Agent snapshot agents must be an array.');
    }

    const aliases = new Set();
    const usedIds = new Set();
    const agents = [];
    for (const candidate of snapshot.agents) {
        const alias = candidate?.alias;
        if (!isValidVcpAlias(alias) || aliases.has(alias)) continue;
        aliases.add(alias);

        let presetId = presetIdForAlias(alias, presetPrefix);
        if (usedIds.has(presetId)) {
            presetId = `${presetId}-${stableHash(alias)}`;
        }
        usedIds.add(presetId);
        const aliasDefault = extractAgentDescription('', alias);
        const description = normalizeAgentDescription(candidate.description)
            || aliasDefault.description;
        const descriptionSource = ['override', 'prompt', 'default'].includes(
            candidate.descriptionSource
        )
            ? candidate.descriptionSource
            : 'default';
        agents.push({
            alias,
            fileName: typeof candidate.fileName === 'string' ? candidate.fileName : '',
            affiliation: String(candidate.affiliation || 'VCP').toUpperCase() === 'DSH'
                ? 'DSH'
                : 'VCP',
            promptSha256: typeof candidate.promptSha256 === 'string'
                ? candidate.promptSha256.slice(0, 64)
                : '',
            presetId,
            description,
            descriptionSource,
            capabilities: normalizeCapabilities(candidate.capabilities),
            memoryIdentity: createVcpMemoryIdentity(alias)
        });
    }

    agents.sort((left, right) =>
        left.alias.localeCompare(right.alias, 'zh-CN')
    );
    return {
        agents,
        revision: typeof snapshot.revision === 'string' && snapshot.revision
            ? snapshot.revision.slice(0, 128)
            : catalogRevision(agents),
        source: 'vcp-snapshot',
        stale: snapshot.stale === true,
        diagnostics: Array.isArray(snapshot.diagnostics) ? snapshot.diagnostics : []
    };
}

async function resolveApiKey(ctx, apiKeyEnv) {
    try {
        const credential = await ctx.credentials.resolve(apiKeyEnv);
        if (credential?.value) return credential.value;
    } catch {
        // Environment fallback keeps local development and tests usable.
    }
    return process.env[apiKeyEnv] || '';
}

async function fetchRemoteCatalog(ctx, config, fetchImpl) {
    if (!config.snapshotUrl) return null;

    const apiKey = await resolveApiKey(ctx, config.apiKeyEnv);
    if (!apiKey) {
        throw new Error(`VCP Agent snapshot cannot find ${config.apiKeyEnv}.`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(
        () => controller.abort(new Error('VCP Agent snapshot request timed out.')),
        config.snapshotTimeoutMs
    );
    try {
        const response = await fetchImpl(config.snapshotUrl, {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                Accept: 'application/json',
                'X-VCP-Client': 'dsh-agent-sync'
            },
            signal: controller.signal
        });
        const body = await response.text();
        if (!response.ok) {
            throw new Error(`VCP Agent snapshot returned HTTP ${response.status}: ${body.slice(0, 1000)}`);
        }
        return validateRemoteSnapshot(JSON.parse(body), config.presetPrefix);
    } finally {
        clearTimeout(timeout);
    }
}

async function loadCatalog(ctx, config, fetchImpl, previousDescriptions = {}) {
    const remoteErrors = [];
    if (config.snapshotUrl) {
        try {
            const remote = await fetchRemoteCatalog(ctx, config, fetchImpl);
            if (remote) return remote;
        } catch (error) {
            remoteErrors.push(error.message);
        }
    }

    try {
        return await readLocalAgentCatalog(
            config.agentMapPath,
            config.agentDirectory,
            config.presetPrefix,
            config.capabilityMapPath,
            config.descriptionMapPath,
            previousDescriptions
        );
    } catch (error) {
        if (remoteErrors.length > 0) {
            const combined = new Error(
                `VCP snapshot unavailable (${remoteErrors.join('; ')}); local fallback failed: ${error.message}`
            );
            combined.code = 'CATALOG_UNAVAILABLE';
            throw combined;
        }
        throw error;
    }
}

function definitionFingerprint(definition) {
    return JSON.stringify(definition);
}

function logInfo(ctx, message) {
    if (typeof ctx.logger?.info === 'function') ctx.logger.info(message);
}

function logWarn(ctx, message) {
    if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(message);
}

function notifyPresetRosterChanged(ctx) {
    try {
        // DSH's preset picker refreshes when this settings namespace changes.
        // Dynamic registration has no separate client-facing notification.
        ctx.emit?.('settings/document-updated', 'agent-preset-registry');
    } catch (error) {
        logWarn(ctx, `VCP agent sync could not notify the DSH preset picker: ${error.message}`);
    }
}

export async function apply(ctx, rawConfig = {}) {
    const configuredVcpHome = typeof rawConfig.vcpHome === 'string'
        && rawConfig.vcpHome.trim()
        ? rawConfig.vcpHome.trim()
        : process.env.VCP_HOME || '';
    const vcpHome = configuredVcpHome ? resolve(configuredVcpHome) : '';
    const config = {
        vcpHome,
        agentMapPath: rawConfig.agentMapPath
            || (vcpHome ? join(vcpHome, 'agent_map.json') : ''),
        agentDirectory: rawConfig.agentDirectory
            || (vcpHome ? join(vcpHome, 'Agent') : ''),
        capabilityMapPath: rawConfig.capabilityMapPath
            || join(vcpHome, 'agent_capabilities.json'),
        descriptionMapPath: rawConfig.descriptionMapPath
            || join(vcpHome, 'agent_descriptions.json'),
        snapshotUrl: rawConfig.snapshotUrl === null
            ? ''
            : rawConfig.snapshotUrl || DEFAULT_SNAPSHOT_URL,
        apiKeyEnv: rawConfig.apiKeyEnv || DEFAULT_API_KEY_ENV,
        snapshotTimeoutMs: Number.isInteger(rawConfig.snapshotTimeoutMs)
            ? Math.max(1_000, rawConfig.snapshotTimeoutMs)
            : DEFAULT_SNAPSHOT_TIMEOUT_MS,
        bridgeUrl: rawConfig.bridgeUrl || new URL('./index.mjs', import.meta.url).href,
        presetPrefix: rawConfig.presetPrefix || 'vcp-agent',
        genericCompatId: rawConfig.genericCompatId || 'vcp-compat',
        genericDualId: rawConfig.genericDualId || 'vcp-dual-stack',
        genericOmniId: rawConfig.genericOmniId || 'vcp-omni',
        genericDeepId: rawConfig.genericDeepId || 'vcp-deep-work',
        omniIdentityName: rawConfig.omniIdentityName || 'DSH主控',
        memoryReadFolders: typeof rawConfig.memoryReadFolders === 'string'
            ? rawConfig.memoryReadFolders
            : '',
        memoryWriteFolders: typeof rawConfig.memoryWriteFolders === 'string'
            ? rawConfig.memoryWriteFolders
            : '',
        memoryToolsEnabled: rawConfig.memoryToolsEnabled !== false,
        memoryOwner: rawConfig.memoryOwner || 'native',
        passiveRecallBoundaries: rawConfig.passiveRecallBoundaries || '',
        passiveRecallFolders: rawConfig.passiveRecallFolders || '',
        passiveRecallRoots: rawConfig.passiveRecallRoots || 'dailynote',
        passiveRecallLimit: rawConfig.passiveRecallLimit,
        passiveRecallCandidateLimit:
            rawConfig.passiveRecallCandidateLimit,
        passiveRecallBudgetChars: rawConfig.passiveRecallBudgetChars,
        passiveRecallMinScore: rawConfig.passiveRecallMinScore,
        passiveRecallCooldownMs: rawConfig.passiveRecallCooldownMs,
        passiveRecallFailureThreshold:
            rawConfig.passiveRecallFailureThreshold,
        passiveRecallCircuitCooldownMs:
            rawConfig.passiveRecallCircuitCooldownMs,
        memoryRerankMode: rawConfig.memoryRerankMode || 'lexical',
        rerankUrl: rawConfig.rerankUrl || '',
        rerankModel: rawConfig.rerankModel || '',
        rerankApiKeyEnv: rawConfig.rerankApiKeyEnv || '',
        rerankTimeoutMs: rawConfig.rerankTimeoutMs,
        memoryAssociationGroups:
            rawConfig.memoryAssociationGroups || {},
        intuitionCardPrefix:
            rawConfig.intuitionCardPrefix || '直觉卡',
        hostVersion: rawConfig.hostVersion || '',
        cordisVersion: rawConfig.cordisVersion || '',
        projectForgeVersion: rawConfig.projectForgeVersion || '',
        forgeContextVersion: rawConfig.forgeContextVersion || '',
        enableProjectForge: rawConfig.enableProjectForge !== false,
        enableForgeContext: rawConfig.enableForgeContext !== false,
        deferStartupSync: rawConfig.deferStartupSync === true,
        omniStateDirectory: rawConfig.omniStateDirectory || '',
        omniControllerUrl: rawConfig.omniControllerUrl
            || new URL('./omni-controller.mjs', import.meta.url).href,
        selectionStatePath: resolveSelectionStatePath(rawConfig.selectionStatePath),
        watch: rawConfig.watch !== false,
        pollIntervalMs: Number.isInteger(rawConfig.pollIntervalMs)
            ? Math.max(0, rawConfig.pollIntervalMs)
            : 15_000
    };

    if (
        (!config.agentMapPath || !config.agentDirectory)
        && !config.snapshotUrl
    ) {
        throw new Error(
            'dsh-vcp-agent-sync requires snapshotUrl or local agentMapPath/agentDirectory.'
        );
    }
    const fetchImpl = rawConfig.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
        throw new Error('dsh-vcp-agent-sync requires the Fetch API.');
    }
    const optionalIntegrations = await resolveOptionalIntegrations(
        config,
        rawConfig
    );

    const registrations = new Map();
    let stopped = false;
    let syncQueue = Promise.resolve();
    let debounceTimer = null;
    const watchers = [];
    let pollTimer = null;
    let startupTimer = null;
    let lastCatalog = null;
    let lastGoodDescriptions = {};
    let selectionState = await readSelectionState(config.selectionStatePath);
    const selectedAgentConfig = rawConfig.selectedAgent;
    const readConfiguredSelectedAgent = () => {
        const value = selectedAgentConfig && typeof selectedAgentConfig.get === 'function'
            ? selectedAgentConfig.get()
            : selectedAgentConfig;
        return typeof value === 'string' ? value.trim() : '';
    };
    const configuredSelectedAgent = readConfiguredSelectedAgent();
    if (configuredSelectedAgent !== selectionState.selectedAgent) {
        selectionState = await writeSelectionState(
            config.selectionStatePath,
            configuredSelectedAgent
        );
    }
    const selectionConfigTimer = selectedAgentConfig
        && typeof selectedAgentConfig.get === 'function'
        ? setInterval(async () => {
            const selectedAgent = readConfiguredSelectedAgent();
            if (selectedAgent === selectionState.selectedAgent) return;
            try {
                selectionState = await writeSelectionState(
                    config.selectionStatePath,
                    selectedAgent
                );
            } catch (error) {
                logWarn(ctx, `VCP Agent selection config sync failed: ${error.message}`);
            }
        }, 500)
        : null;
    selectionConfigTimer?.unref?.();
    ctx.effect?.(() => () => {
        if (selectionConfigTimer) clearInterval(selectionConfigTimer);
    }, 'vcp-agent-sync: selection config watcher');
    const genericIds = new Set([
        config.genericCompatId,
        config.genericDualId,
        config.genericOmniId,
        config.genericDeepId
    ]);

    async function unregisterIds(ids) {
        for (const id of ids) {
            const registration = registrations.get(id);
            if (!registration) continue;
            registrations.delete(id);
            try {
                await registration.dispose();
            } catch (error) {
                logWarn(ctx, `VCP agent sync could not unregister ${id}: ${error.message}`);
            }
        }
    }

    async function registerDefinition(definition) {
        const previous = registrations.get(definition.id);
        if (previous) {
            registrations.delete(definition.id);
            try {
                await previous.dispose();
            } catch (error) {
                logWarn(ctx, `VCP agent sync could not refresh ${definition.id}: ${error.message}`);
            }
        }

        const dispose = await ctx.agentPresets.register(definition);
        registrations.set(definition.id, {
            dispose,
            fingerprint: definitionFingerprint(definition)
        });
    }

    function buildDefinitions(catalog) {
        return buildPresetDefinitions({
            bridgeUrl: config.bridgeUrl,
            agents: catalog?.agents || [],
            genericCompatId: config.genericCompatId,
            genericDualId: config.genericDualId,
            genericOmniId: config.genericOmniId,
            genericDeepId: config.genericDeepId,
            omniIdentityName: config.omniIdentityName,
            memoryReadFolders: config.memoryReadFolders,
            memoryWriteFolders: config.memoryWriteFolders,
            memoryToolsEnabled: config.memoryToolsEnabled,
            memoryOwner: config.memoryOwner,
            passiveRecallBoundaries: config.passiveRecallBoundaries,
            passiveRecallFolders: config.passiveRecallFolders,
            passiveRecallRoots: config.passiveRecallRoots,
            passiveRecallLimit: config.passiveRecallLimit,
            passiveRecallCandidateLimit:
                config.passiveRecallCandidateLimit,
            passiveRecallBudgetChars:
                config.passiveRecallBudgetChars,
            passiveRecallMinScore: config.passiveRecallMinScore,
            passiveRecallCooldownMs:
                config.passiveRecallCooldownMs,
            passiveRecallFailureThreshold:
                config.passiveRecallFailureThreshold,
            passiveRecallCircuitCooldownMs:
                config.passiveRecallCircuitCooldownMs,
            memoryRerankMode: config.memoryRerankMode,
            rerankUrl: config.rerankUrl,
            rerankModel: config.rerankModel,
            rerankApiKeyEnv: config.rerankApiKeyEnv,
            rerankTimeoutMs: config.rerankTimeoutMs,
            memoryAssociationGroups:
                config.memoryAssociationGroups,
            intuitionCardPrefix: config.intuitionCardPrefix,
            deepWorkIntegrations: optionalIntegrations,
            omniStateDirectory: config.omniStateDirectory,
            omniControllerUrl: config.omniControllerUrl,
            selectionStatePath: config.selectionStatePath
        });
    }

    async function ensureGenericModes(reason) {
        if ([...registrations.keys()].some(id => !genericIds.has(id))) {
            return;
        }

        const definitions = buildDefinitions({ agents: [] });
        for (const definition of definitions) {
            if (registrations.has(definition.id)) continue;
            try {
                await registerDefinition(definition);
            } catch (error) {
                logWarn(ctx, `VCP agent sync could not register ${definition.id}: ${error.message}`);
            }
        }
        logInfo(ctx, `VCP agent sync registered generic DSH modes (${reason}).`);
    }

    async function performSync(reason = 'manual') {
        if (stopped) return;

        let catalog;
        try {
            catalog = await loadCatalog(
                ctx,
                config,
                fetchImpl,
                lastGoodDescriptions
            );
        } catch (error) {
            logWarn(ctx, `VCP agent catalog unavailable; retaining the last valid presets: ${error.message}`);
            await ensureGenericModes('catalog-unavailable');
            return;
        }

        const existingAgentIds = [...registrations.keys()].filter(id => !genericIds.has(id));
        if (catalog.stale && catalog.agents.length === 0 && existingAgentIds.length > 0) {
            logWarn(ctx, 'VCP agent snapshot is stale and empty; retaining the last valid Agent presets.');
            lastCatalog = catalog;
            return;
        }

        const definitions = buildDefinitions(catalog);
        const nextIds = new Set(definitions.map(definition => definition.id));
        const previousIds = [...registrations.keys()].sort();
        await unregisterIds([...registrations.keys()].filter(id => !nextIds.has(id)));

        let registrationFailures = 0;
        for (const definition of definitions) {
            const fingerprint = definitionFingerprint(definition);
            const previous = registrations.get(definition.id);
            if (previous?.fingerprint === fingerprint) continue;
            try {
                await registerDefinition(definition);
            } catch (error) {
                registrationFailures += 1;
                logWarn(ctx, `VCP agent sync could not register ${definition.id}: ${error.message}`);
            }
        }

        const rosterChanged = catalog.revision !== lastCatalog?.revision
            || previousIds.join('\0') !== [...registrations.keys()].sort().join('\0');
        lastCatalog = catalog;
        if (!catalog.stale) {
            lastGoodDescriptions = Object.fromEntries(
                (catalog.agents || [])
                    .filter(agent => agent.description)
                    .map(agent => [agent.alias, agent.description])
            );
        }
        if (rosterChanged) notifyPresetRosterChanged(ctx);
        if (registrationFailures === 0) {
            logInfo(
                ctx,
                `VCP agent sync: ${catalog.agents.length} internal Agent execution profile(s) plus 4 rule modes `
                + `from ${catalog.source}, revision ${catalog.revision} (${reason}).`
            );
        }
    }

    function scheduleSync(reason) {
        if (stopped) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            syncQueue = syncQueue
                .then(() => performSync(reason))
                .catch(error => logWarn(ctx, `VCP agent sync failed: ${error.message}`));
        }, 250);
    }

    async function syncNow(reason = 'manual') {
        const operation = syncQueue.then(() => performSync(reason));
        syncQueue = operation.catch(() => undefined);
        await operation;
        return lastCatalog;
    }

    function watchDirectory(directory, label) {
        if (!config.watch) return;
        try {
            const watcher = watch(directory, { persistent: true }, () => scheduleSync(label));
            watcher.on('error', error => {
                logWarn(ctx, `VCP agent sync watcher failed for ${directory}: ${error.message}`);
            });
            watchers.push(watcher);
        } catch (error) {
            logWarn(ctx, `VCP agent sync cannot watch ${directory}: ${error.message}`);
        }
    }

    if (config.watch && config.agentMapPath) {
        watchDirectory(dirname(config.agentMapPath), 'agent-map-change');
    }
    if (config.watch && config.agentDirectory) {
        watchDirectory(config.agentDirectory, 'agent-file-change');
    }
    if (config.watch && config.capabilityMapPath) {
        watchDirectory(dirname(config.capabilityMapPath), 'capability-map-change');
    }
    if (config.watch && config.descriptionMapPath) {
        watchDirectory(dirname(config.descriptionMapPath), 'description-map-change');
    }
    if (config.pollIntervalMs > 0) {
        pollTimer = setInterval(() => scheduleSync('poll'), config.pollIntervalMs);
    }

    async function disposeRuntime() {
        stopped = true;
        if (debounceTimer) clearTimeout(debounceTimer);
        if (pollTimer) clearInterval(pollTimer);
        if (startupTimer) clearTimeout(startupTimer);
        for (const watcher of watchers) {
            try {
                watcher.close();
            } catch {
                // Already closed.
            }
        }
        await syncQueue;
        await unregisterIds([...registrations.keys()]);
    }

    if (config.deferStartupSync) {
        startupTimer = setTimeout(() => {
            startupTimer = null;
            scheduleSync('deferred-startup');
        }, 250);
        startupTimer.unref?.();
    } else {
        await syncNow('startup');
    }

    Object.defineProperties(disposeRuntime, {
        getState: {
            value() {
                return {
                    catalog: lastCatalog,
                    registeredIds: [...registrations.keys()]
                };
            }
        },
        syncNow: {
            value: syncNow
        }
    });

    // Cordis treats a plugin's return value as an effect. Returning this
    // function is therefore both the lifecycle disposer and a testable handle.
    return disposeRuntime;
}
