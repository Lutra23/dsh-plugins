'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const AGENT_SYNC_SCHEMA = 'vcp-agent-sync';
const AGENT_SYNC_SCHEMA_VERSION = 1;
const MAX_VCP_ALIAS_LENGTH = 100;
const MAX_DSH_IDENTITY_LENGTH = 80;
const MAX_AGENT_DESCRIPTION_LENGTH = 120;
const VCP_ALIAS_PATTERN = /^[a-zA-Z0-9_:@#%&^+\-\u2e80-\u2fff\u3040-\u9fff]+$/u;
const CAPABILITY_PATTERN = /^[\p{L}\p{N}_.:+-]{1,40}$/u;
const WINDOWS_RESERVED_NAME_PATTERN = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const DESCRIPTION_PLACEHOLDER_PATTERN = /\{\{[\s\S]*?\}\}|\[\[[\s\S]*?\]\]|<<<[\s\S]*?>>>/gu;
const DESCRIPTION_LABEL_PATTERN = /^(?:>\s*)?(?:\*\*)?\s*(?:当前)?(?:角色定位|角色设定|角色定义|角色身份|身份定位|核心身份|身份|定位)\s*(?:\*\*)?\s*[：:]\s*(?:\*\*)?\s*(.+)$/u;
const DESCRIPTION_HEADING_PATTERN = /^(?:#{1,6}\s*|\d+[.、]\s*)?(?:\*\*)?\s*(?:你是谁|角色定义|角色设定|核心身份与使命|核心身份|身份定位|定位)\s*(?:\*\*)?\s*$/u;
const IDENTITY_CUE_PATTERN = /(?:从现在开始[，,]\s*)?(?:你是|你是一名|你是一位|你叫|你名叫|你作为)/u;

function stableHash(value, length = 8) {
    return crypto
        .createHash('sha256')
        .update(String(value), 'utf8')
        .digest('hex')
        .slice(0, length);
}

function isValidVcpAlias(alias) {
    return typeof alias === 'string'
        && alias.length > 0
        && alias.length <= MAX_VCP_ALIAS_LENGTH
        && VCP_ALIAS_PATTERN.test(alias);
}

function presetIdForAlias(alias, prefix = 'vcp-agent') {
    if (!isValidVcpAlias(alias)) {
        throw new TypeError('Invalid VCP Agent alias.');
    }
    const ascii = alias
        .normalize('NFKD')
        .replace(/[^\x00-\x7F]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return `${prefix}-${ascii || `agent-${stableHash(alias)}`}`;
}

function normalizeCapabilityTag(value) {
    if (typeof value !== 'string') return null;
    const tag = value.normalize('NFC').trim().toLowerCase();
    return CAPABILITY_PATTERN.test(tag) ? tag : null;
}

function normalizeCapabilities(values) {
    if (!Array.isArray(values)) return [];
    return [...new Set(
        values
            .map(normalizeCapabilityTag)
            .filter(Boolean)
    )].sort((left, right) => left.localeCompare(right));
}

function truncateAgentDescription(value, maxLength = MAX_AGENT_DESCRIPTION_LENGTH) {
    const characters = Array.from(value);
    if (characters.length <= maxLength) return value;

    const limit = Math.max(1, maxLength - 1);
    let clipped = characters.slice(0, limit).join('').trim();
    const sentenceEnd = Math.max(
        clipped.lastIndexOf('。'),
        clipped.lastIndexOf('！'),
        clipped.lastIndexOf('？'),
        clipped.lastIndexOf('!'),
        clipped.lastIndexOf('?')
    );
    if (sentenceEnd >= Math.floor(maxLength * 0.45)) {
        return clipped.slice(0, sentenceEnd + 1);
    }
    clipped = clipped.replace(/[，,、；;：:\s]+$/u, '');
    return `${clipped}…`;
}

function normalizeAgentDescription(value, maxLength = MAX_AGENT_DESCRIPTION_LENGTH) {
    if (typeof value !== 'string') return null;
    const normalized = value
        .normalize('NFC')
        .replace(/\r?\n/gu, ' ')
        .replace(DESCRIPTION_PLACEHOLDER_PATTERN, ' ')
        .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
        .replace(/\*\*|__|`/gu, '')
        .replace(/^(?:[-*+>]\s+)+/u, '')
        .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .replace(/^["“”'‘’]+|["“”'‘’]+$/gu, '')
        .trim();
    if (!normalized) return null;
    return truncateAgentDescription(normalized, maxLength);
}

function firstSentence(value) {
    const characters = Array.from(value);
    let result = '';
    for (const character of characters) {
        result += character;
        if (/[。！？!?]/u.test(character)) break;
    }
    return result.trim();
}

function normalizeIdentitySentence(value, alias) {
    let sentence = firstSentence(value)
        .replace(/^\d+[.、]\s*/u, '')
        .replace(/^(?:\*\*)?\s*/, '')
        .trim();
    const escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

    sentence = sentence
        .replace(
            new RegExp(`^从现在开始[，,]\\s*你叫\\s*${escapedAlias}\\s*[，,]\\s*`, 'u'),
            `${alias}，`
        )
        .replace(
            new RegExp(`^从现在开始[，,]\\s*你是\\s*${escapedAlias}\\s*[，,]\\s*`, 'u'),
            `${alias}，`
        )
        .replace(
            new RegExp(`^你叫\\s*${escapedAlias}\\s*[，,]\\s*`, 'u'),
            `${alias}，`
        )
        .replace(
            new RegExp(`^你是\\s*${escapedAlias}\\s*[，,]\\s*`, 'u'),
            `${alias}，`
        )
        .replace(/^从现在开始[，,]\s*你是/u, '')
        .replace(/^从现在开始[，,]\s*/u, '')
        .replace(/^你是/u, '')
        .replace(/^你是一名/u, '一名')
        .replace(/^你是一位/u, '一位')
        .trim();

    return normalizeAgentDescription(sentence);
}

function isSkippableDescriptionLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return true;
    if (DESCRIPTION_PLACEHOLDER_PATTERN.test(trimmed)) {
        DESCRIPTION_PLACEHOLDER_PATTERN.lastIndex = 0;
        return true;
    }
    DESCRIPTION_PLACEHOLDER_PATTERN.lastIndex = 0;
    return /^(?:#{1,6}\s|\|.*\||```|~~~|---+$|===+$)/u.test(trimmed)
        || /^(?:VCP\s*)?(?:元思考|系统提示|工具说明|记忆检索|日记本|每日日记|RAG|上下文变量|运行时变量|可用工具)\s*[：:]/iu.test(trimmed)
        || /^(?:[A-Z][A-Z0-9_ -]{2,}|Role|Context|Memory|RAG|Tools?)\s*[：:]/u.test(trimmed);
}

function extractAgentDescription(promptText, alias) {
    if (typeof promptText !== 'string' || !isValidVcpAlias(alias)) {
        return {
            description: `通过 VCPToolBox 使用专用提示词、记忆与工具能力。`,
            source: 'default'
        };
    }

    const lines = promptText.replace(/\r\n?/gu, '\n').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
        const trimmed = lines[index].trim();
        if (!trimmed || DESCRIPTION_PLACEHOLDER_PATTERN.test(trimmed)) {
            DESCRIPTION_PLACEHOLDER_PATTERN.lastIndex = 0;
            continue;
        }
        DESCRIPTION_PLACEHOLDER_PATTERN.lastIndex = 0;

        const labeled = trimmed.match(DESCRIPTION_LABEL_PATTERN);
        if (labeled) {
            const description = normalizeIdentitySentence(labeled[1], alias);
            if (description) return { description, source: 'prompt' };
        }

        if (DESCRIPTION_HEADING_PATTERN.test(trimmed)) {
            for (let next = index + 1; next < Math.min(lines.length, index + 8); next += 1) {
                const candidate = lines[next].trim();
                if (!candidate) continue;
                if (/^#{1,6}\s/u.test(candidate) || DESCRIPTION_HEADING_PATTERN.test(candidate)) {
                    break;
                }
                if (isSkippableDescriptionLine(candidate)) continue;
                const cueMatch = candidate.match(IDENTITY_CUE_PATTERN);
                const source = cueMatch ? candidate.slice(cueMatch.index) : candidate;
                const description = normalizeIdentitySentence(source, alias);
                if (description) return { description, source: 'prompt' };
            }
        }

        if (isSkippableDescriptionLine(trimmed)) continue;
        const cueMatch = trimmed.match(IDENTITY_CUE_PATTERN);
        if (cueMatch) {
            const description = normalizeIdentitySentence(trimmed.slice(cueMatch.index), alias);
            if (description) return { description, source: 'prompt' };
        }
        const escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
        if (
            new RegExp(
                `^${escapedAlias}(?:\\s|，|,|是|：|:|——|-)`,
                'u'
            ).test(trimmed)
        ) {
            const description = normalizeIdentitySentence(trimmed, alias);
            if (description) return { description, source: 'prompt' };
        }
    }

    return {
        description: `通过 VCPToolBox 使用专用提示词、记忆与工具能力。`,
        source: 'default'
    };
}

function resolveAgentPromptPath(agentDirectory, relativeFile) {
    if (typeof relativeFile !== 'string' || !relativeFile.trim()) {
        throw new TypeError('Agent prompt path must be a non-empty relative path.');
    }

    const suppliedPath = relativeFile.trim();
    if (suppliedPath.includes('\0') || path.isAbsolute(suppliedPath)) {
        throw new TypeError('Agent prompt path must remain inside the Agent directory.');
    }

    const root = path.resolve(agentDirectory);
    const target = path.resolve(root, suppliedPath);
    const relative = path.relative(root, target);
    if (
        relative === ''
        || relative === '..'
        || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)
    ) {
        throw new TypeError('Agent prompt path must remain inside the Agent directory.');
    }

    return {
        fileName: relative.split(path.sep).join('/'),
        promptPath: target
    };
}

function normalizeDshIdentityName(rawName) {
    if (typeof rawName !== 'string') {
        throw new TypeError('DSH identity name must be a string.');
    }

    const name = rawName.normalize('NFC').trim();
    if (!name || name.length > MAX_DSH_IDENTITY_LENGTH) {
        throw new TypeError(`DSH identity name must contain 1-${MAX_DSH_IDENTITY_LENGTH} characters.`);
    }
    if (name === '.' || name === '..') {
        throw new TypeError('DSH identity name cannot be "." or "..".');
    }
    if (/[\u0000-\u001f<>:"/\\|?*[\]{}]/u.test(name)) {
        throw new TypeError('DSH identity name contains characters that are invalid in a Windows path.');
    }
    if (/[. ]$/u.test(name)) {
        throw new TypeError('DSH identity name cannot end with a dot or space.');
    }
    if (WINDOWS_RESERVED_NAME_PATTERN.test(name)) {
        throw new TypeError('DSH identity name is reserved by Windows.');
    }

    return name;
}

function createVcpMemoryIdentity(alias) {
    if (!isValidVcpAlias(alias)) {
        throw new TypeError('Invalid VCP Agent alias.');
    }
    return {
        kind: 'vcp-agent',
        name: alias,
        memoryBook: alias,
        source: 'agent_map',
        promptPlaceholder: `{{${alias}}}`
    };
}

function createDshMemoryIdentity(rawName) {
    const name = normalizeDshIdentityName(rawName);
    return {
        kind: 'dsh-owned',
        name,
        memoryBook: name,
        source: 'dsh',
        joinVcpAgentMap: false,
        joinAgentAssistant: false
    };
}

module.exports = {
    AGENT_SYNC_SCHEMA,
    AGENT_SYNC_SCHEMA_VERSION,
    MAX_DSH_IDENTITY_LENGTH,
    MAX_VCP_ALIAS_LENGTH,
    createDshMemoryIdentity,
    createVcpMemoryIdentity,
    extractAgentDescription,
    isValidVcpAlias,
    MAX_AGENT_DESCRIPTION_LENGTH,
    normalizeCapabilities,
    normalizeCapabilityTag,
    normalizeAgentDescription,
    normalizeDshIdentityName,
    presetIdForAlias,
    resolveAgentPromptPath,
    stableHash
};
