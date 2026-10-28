'use strict';

const { readFile, stat } = require('node:fs/promises');
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

async function pathIsFile(filePath) {
    try {
        return (await stat(filePath)).isFile();
    } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
        throw error;
    }
}

async function readCapabilityMap(capabilityMapPath) {
    if (!capabilityMapPath || !(await pathIsFile(capabilityMapPath))) {
        return {};
    }

    const parsed = JSON.parse(await readFile(capabilityMapPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new TypeError('agent_capabilities.json must contain an object keyed by Agent alias.');
    }

    const capabilities = {};
    for (const [alias, values] of Object.entries(parsed)) {
        if (!isValidVcpAlias(alias)) continue;
        capabilities[alias] = normalizeCapabilities(values);
    }
    return capabilities;
}

async function readDescriptionMap(descriptionMapPath) {
    if (!descriptionMapPath || !(await pathIsFile(descriptionMapPath))) {
        return {};
    }

    const parsed = JSON.parse(await readFile(descriptionMapPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new TypeError('agent_descriptions.json must contain an object keyed by Agent alias.');
    }

    const descriptions = {};
    for (const [alias, value] of Object.entries(parsed)) {
        if (!isValidVcpAlias(alias)) continue;
        const description = normalizeAgentDescription(value);
        if (description) descriptions[alias] = description;
    }
    return descriptions;
}

function previousCapabilityMap(previousCapabilities) {
    if (previousCapabilities instanceof Map) {
        return Object.fromEntries(previousCapabilities);
    }
    if (!previousCapabilities || typeof previousCapabilities !== 'object') return {};

    return Object.fromEntries(
        Object.entries(previousCapabilities)
            .filter(([alias]) => isValidVcpAlias(alias))
            .map(([alias, values]) => [alias, normalizeCapabilities(values)])
    );
}

function previousDescriptionMap(previousDescriptions) {
    if (previousDescriptions instanceof Map) {
        return Object.fromEntries(previousDescriptions);
    }
    if (!previousDescriptions || typeof previousDescriptions !== 'object') return {};

    return Object.fromEntries(
        Object.entries(previousDescriptions)
            .filter(([alias]) => isValidVcpAlias(alias))
            .map(([alias, value]) => [alias, normalizeAgentDescription(value)])
            .filter(([, value]) => Boolean(value))
    );
}

async function readAgentMap(agentMapPath) {
    let parsed;
    try {
        parsed = JSON.parse(await readFile(agentMapPath, 'utf8'));
    } catch (error) {
        const wrapped = new Error(
            error.code === 'ENOENT'
                ? 'agent_map.json is missing.'
                : `agent_map.json could not be parsed: ${error.message}`
        );
        wrapped.code = 'AGENT_MAP_INVALID';
        wrapped.cause = error;
        throw wrapped;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        const error = new TypeError('agent_map.json must contain an object keyed by Agent alias.');
        error.code = 'AGENT_MAP_INVALID';
        throw error;
    }
    return parsed;
}

function diagnostic(code, message, alias = null, fileName = null) {
    return {
        code,
        message,
        ...(alias ? { alias } : {}),
        ...(fileName ? { fileName } : {})
    };
}

async function buildAgentSnapshot({
    agentMapPath,
    agentDirectory,
    capabilityMapPath = '',
    descriptionMapPath = '',
    previousCapabilities = {},
    previousDescriptions = {},
    presetPrefix = 'vcp-agent'
}) {
    const mapping = await readAgentMap(agentMapPath);
    const diagnostics = [];
    let capabilities = {};
    let descriptions = {};
    let degraded = false;

    try {
        capabilities = await readCapabilityMap(capabilityMapPath);
    } catch (error) {
        degraded = true;
        capabilities = previousCapabilityMap(previousCapabilities);
        diagnostics.push(diagnostic(
            'CAPABILITIES_INVALID',
            `agent_capabilities.json could not be read; retaining the last valid capability labels: ${error.message}`
        ));
    }

    try {
        descriptions = await readDescriptionMap(descriptionMapPath);
    } catch (error) {
        degraded = true;
        descriptions = previousDescriptionMap(previousDescriptions);
        diagnostics.push(diagnostic(
            'DESCRIPTIONS_INVALID',
            `agent_descriptions.json could not be read; retaining the last valid descriptions: ${error.message}`
        ));
    }

    const agents = [];
    const usedPresetIds = new Set();
    for (const [alias, relativeFile] of Object.entries(mapping)) {
        if (!isValidVcpAlias(alias)) {
            diagnostics.push(diagnostic(
                'INVALID_ALIAS',
                'Agent alias is outside the VCP placeholder-safe naming grammar.',
                alias
            ));
            continue;
        }
        if (typeof relativeFile !== 'string' || !relativeFile.trim()) {
            diagnostics.push(diagnostic(
                'INVALID_PROMPT_PATH',
                'Agent prompt mapping must be a non-empty relative path.',
                alias
            ));
            continue;
        }

        let resolved;
        try {
            resolved = resolveAgentPromptPath(agentDirectory, relativeFile);
        } catch (error) {
            diagnostics.push(diagnostic(
                'UNSAFE_PROMPT_PATH',
                error.message,
                alias,
                relativeFile
            ));
            continue;
        }

        let promptInfo;
        let promptText;
        try {
            promptInfo = await stat(resolved.promptPath);
            if (!promptInfo.isFile()) throw new Error('Mapped prompt is not a file.');
            promptText = await readFile(resolved.promptPath, 'utf8');
        } catch (error) {
            diagnostics.push(diagnostic(
                'PROMPT_UNAVAILABLE',
                error.code === 'ENOENT'
                    ? 'Mapped Agent prompt file does not exist.'
                    : `Mapped Agent prompt file could not be read: ${error.message}`,
                alias,
                resolved.fileName
            ));
            continue;
        }

        let presetId = presetIdForAlias(alias, presetPrefix);
        if (usedPresetIds.has(presetId)) {
            presetId = `${presetId}-${stableHash(`${alias}:${resolved.fileName}`)}`;
        }
        usedPresetIds.add(presetId);

        const derivedDescription = extractAgentDescription(promptText, alias);
        const description = descriptions[alias] || derivedDescription.description;
        agents.push({
            alias,
            presetId,
            fileName: resolved.fileName,
            affiliation: 'VCP',
            promptSha256: stableHash(promptText, 64),
            promptUpdatedAt: promptInfo.mtime.toISOString(),
            description,
            descriptionSource: descriptions[alias] ? 'override' : derivedDescription.source,
            capabilities: normalizeCapabilities(capabilities[alias]),
            memoryIdentity: createVcpMemoryIdentity(alias)
        });
    }

    agents.sort((left, right) => left.alias.localeCompare(right.alias, 'zh-CN'));
    const revision = stableHash(JSON.stringify(agents), 16);

    return {
        schema: AGENT_SYNC_SCHEMA,
        schemaVersion: AGENT_SYNC_SCHEMA_VERSION,
        revision,
        generatedAt: new Date().toISOString(),
        stale: false,
        degraded,
        agentCount: agents.length,
        agents,
        diagnostics,
        identityContract: {
            vcpAgent: {
                kind: 'vcp-agent',
                memoryBook: 'VCP Agent alias',
                promptSource: 'agent_map.json',
                promptPlaceholder: '{{alias}}'
            },
            dshOwned: {
                kind: 'dsh-owned',
                memoryBook: 'DSH identity name',
                joinVcpAgentMap: false,
                joinAgentAssistant: false
            }
        }
    };
}

function staleSnapshot(previous, error) {
    const reason = {
        code: error?.code || 'SNAPSHOT_REFRESH_FAILED',
        message: error?.message || 'Agent snapshot refresh failed.'
    };

    if (!previous) {
        return {
            schema: AGENT_SYNC_SCHEMA,
            schemaVersion: AGENT_SYNC_SCHEMA_VERSION,
            revision: 'unavailable',
            generatedAt: new Date().toISOString(),
            stale: true,
            degraded: true,
            agentCount: 0,
            agents: [],
            diagnostics: [diagnostic(reason.code, reason.message)],
            identityContract: {
                vcpAgent: {
                    kind: 'vcp-agent',
                    memoryBook: 'VCP Agent alias',
                    promptSource: 'agent_map.json',
                    promptPlaceholder: '{{alias}}'
                },
                dshOwned: {
                    kind: 'dsh-owned',
                    memoryBook: 'DSH identity name',
                    joinVcpAgentMap: false,
                    joinAgentAssistant: false
                }
            }
        };
    }

    return {
        ...previous,
        generatedAt: new Date().toISOString(),
        stale: true,
        degraded: true,
        diagnostics: [
            ...(Array.isArray(previous.diagnostics)
                ? previous.diagnostics.filter(item => item.code !== reason.code)
                : []),
            diagnostic(reason.code, reason.message)
        ]
    };
}

module.exports = {
    buildAgentSnapshot,
    readCapabilityMap,
    readDescriptionMap,
    staleSnapshot
};
