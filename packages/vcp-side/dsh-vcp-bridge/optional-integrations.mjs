const PROJECT_FORGE_PACKAGE = 'dsh-project-forge';
const FORGE_CONTEXT_PACKAGE = '@dsh-external/dsh-forge-context';

const OPTIONAL_INTEGRATIONS = Object.freeze({
    projectForge: Object.freeze({
        id: 'project-forge',
        displayName: 'Project Forge',
        packageName: PROJECT_FORGE_PACKAGE,
        hostRange: '>=0.2.1-rc',
        cordisRange: '',
        license: 'MIT'
    }),
    forgeContext: Object.freeze({
        id: 'forge-context',
        displayName: 'Forge Context',
        packageName: FORGE_CONTEXT_PACKAGE,
        hostRange: '>=0.2.0-rc.2 <0.3.0-0',
        cordisRange: '>=4.0.1 <5.0.0',
        license: 'MIT'
    })
});

function parseVersion(value) {
    const match = String(value || '')
        .trim()
        .match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u);
    if (!match) return null;
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        prerelease: match[4] ? match[4].split('.') : []
    };
}

function comparePrerelease(left, right) {
    if (left.length === 0 && right.length === 0) return 0;
    if (left.length === 0) return 1;
    if (right.length === 0) return -1;
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index++) {
        const a = left[index];
        const b = right[index];
        if (a === undefined) return -1;
        if (b === undefined) return 1;
        if (a === b) continue;
        const aNumber = /^\d+$/u.test(a);
        const bNumber = /^\d+$/u.test(b);
        if (aNumber && bNumber) return Number(a) - Number(b);
        if (aNumber !== bNumber) return aNumber ? -1 : 1;
        return a.localeCompare(b);
    }
    return 0;
}

export function compareVersions(leftValue, rightValue) {
    const left = parseVersion(leftValue);
    const right = parseVersion(rightValue);
    if (!left || !right) {
        throw new Error(
            `Unsupported semantic version comparison: ${leftValue} / ${rightValue}`
        );
    }
    for (const key of ['major', 'minor', 'patch']) {
        if (left[key] !== right[key]) return left[key] - right[key];
    }
    return comparePrerelease(left.prerelease, right.prerelease);
}

function compareWithOperator(version, comparator) {
    const match = String(comparator || '')
        .trim()
        .match(/^(>=|<=|>|<|=)?\s*(.+)$/u);
    if (!match) return false;
    const operator = match[1] || '=';
    const target = match[2];
    const comparison = compareVersions(version, target);
    switch (operator) {
        case '>':
            return comparison > 0;
        case '>=':
            return comparison >= 0;
        case '<':
            return comparison < 0;
        case '<=':
            return comparison <= 0;
        case '=':
            return comparison === 0;
        default:
            return false;
    }
}

export function satisfiesVersionRange(version, range) {
    if (!range) return true;
    if (!version || !parseVersion(version)) return false;
    return String(range)
        .split('||')
        .some(alternative =>
            alternative
                .trim()
                .split(/\s+/u)
                .filter(Boolean)
                .every(comparator => compareWithOperator(version, comparator))
        );
}

export function representativeVersionFromRange(range) {
    const match = String(range || '').match(
        /(?:~|\^|>=|=)?\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/u
    );
    return match?.[1] || '';
}

function integrationRecord(raw = {}) {
    return {
        installed: raw.installed === true,
        enabled: raw.enabled !== false,
        version:
            typeof raw.version === 'string'
                ? raw.version.trim()
                : '',
        reason:
            typeof raw.reason === 'string'
                ? raw.reason.trim()
                : ''
    };
}

/**
 * Evaluate optional external integrations without importing their code.
 * @param {object} input - package versions, host versions, and explicit opt-outs.
 * @returns {{projectForge: object, forgeContext: object}}
 */
export function evaluateOptionalIntegrations(input = {}) {
    const hostVersion =
        typeof input.hostVersion === 'string'
            ? input.hostVersion.trim()
            : '';
    const cordisVersion =
        typeof input.cordisVersion === 'string'
            ? input.cordisVersion.trim()
            : '';
    const projectForge = integrationRecord(input.projectForge);
    const forgeContext = integrationRecord(input.forgeContext);

    function evaluate(record, definition) {
        const result = {
            ...definition,
            ...record,
            compatible: false,
            active: false
        };
        if (!record.installed) {
            result.reason = record.reason || 'package-not-installed';
            return result;
        }
        if (!record.enabled) {
            result.reason = record.reason || 'disabled-by-configuration';
            return result;
        }
        if (!record.version) {
            result.reason = record.reason || 'package-version-unknown';
            return result;
        }
        if (!satisfiesVersionRange(hostVersion, definition.hostRange)) {
            result.reason = record.reason
                || `host ${hostVersion || '(unknown)'} does not satisfy ${definition.hostRange}`;
            return result;
        }
        if (
            definition.cordisRange
            && !satisfiesVersionRange(cordisVersion, definition.cordisRange)
        ) {
            result.reason = record.reason
                || `cordis ${cordisVersion || '(unknown)'} does not satisfy ${definition.cordisRange}`;
            return result;
        }
        result.compatible = true;
        result.active = true;
        result.reason = record.reason || 'compatible-and-enabled';
        return result;
    }

    return {
        projectForge: evaluate(projectForge, OPTIONAL_INTEGRATIONS.projectForge),
        forgeContext: evaluate(forgeContext, OPTIONAL_INTEGRATIONS.forgeContext)
    };
}

function projectForgeRows() {
    return [
        {
            id: 'project-forge',
            name: 'dsh-project-forge',
            config: {
                protocol: true,
                recoveryProcedure: true,
                digest: true,
                repoStateInDigest: true,
                stewardFile: true,
                stewardFilePath: 'private/steward.md',
                injectOnCompaction: true,
                recoveryMinTurnStep: 1,
                guardLocalGit: true,
                guardCommitCheckpoint: true,
                guardLayoutCheckpoint: true,
                guardSecrets: true,
                guardConcurrentWrite: true
            }
        }
    ];
}

function replaceForgeContextCompaction(rows) {
    const compaction = rows.find(row => row.id === 'compaction');
    if (!compaction || !Array.isArray(compaction.config)) return false;
    const basic = compaction.config.find(row => row.id === 'compaction-basic');
    if (basic) {
        basic.id = 'forge-context';
        basic.name = FORGE_CONTEXT_PACKAGE;
        basic.config = {};
    } else if (!compaction.config.some(row => row.id === 'forge-context')) {
        compaction.config.unshift({
            id: 'forge-context',
            name: FORGE_CONTEXT_PACKAGE,
            config: {}
        });
    }
    const pruner = compaction.config.find(row => row.id === 'tool-result-pruner');
    if (pruner) pruner.disabled = true;
    return true;
}

/**
 * Add active external rows to the deep-engineering preset only.
 * @param {object[]} rows - deep-work plugin rows.
 * @param {object} integrations - evaluated integration status.
 * @returns {object[]} the same rows with bounded integration changes.
 */
export function applyDeepWorkIntegrations(rows, integrations = {}) {
    let changed = false;
    if (integrations.forgeContext?.active) {
        changed = replaceForgeContextCompaction(rows) || changed;
    }
    if (integrations.projectForge?.active) {
        rows.push(...projectForgeRows());
        changed = true;
    }
    if (
        changed
        && !rows.some(row => row.id === 'tool-str-replace-editor')
    ) {
        const fsRow = rows.find(row => row.id === 'tool-fs');
        const row = {
            id: 'tool-str-replace-editor',
            name: '@deepseek-ai/dsh-tool-str-replace-editor'
        };
        const index = fsRow ? rows.indexOf(fsRow) + 1 : rows.length;
        rows.splice(index, 0, row);
    }
    return rows;
}

export function activeOptionalIntegrationIds(integrations = {}) {
    return Object.values(integrations)
        .filter(integration => integration?.active === true)
        .map(integration => integration.id);
}

export { OPTIONAL_INTEGRATIONS };
