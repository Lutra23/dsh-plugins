import { createRequire } from 'node:module';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { isValidVcpAlias } = require('./agent-contract.cjs');

export const SELECTION_STATE_VERSION = 1;

export function defaultDshHome() {
    return resolve(process.env.DSH_HOME || join(os.homedir(), '.dsh'));
}

export function resolveSelectionStatePath(rawPath = '') {
    return resolve(
        typeof rawPath === 'string' && rawPath.trim()
            ? rawPath.trim()
            : join(defaultDshHome(), 'vcp-agent-selection.json')
    );
}

function normalizeState(value) {
    const selectedAgent = typeof value?.selectedAgent === 'string'
        && isValidVcpAlias(value.selectedAgent)
        ? value.selectedAgent
        : '';
    return {
        version: SELECTION_STATE_VERSION,
        selectedAgent,
        updatedAt: typeof value?.updatedAt === 'string' ? value.updatedAt : null
    };
}

export async function readSelectionState(filePath) {
    try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        return normalizeState(parsed);
    } catch (error) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError) {
            return normalizeState(null);
        }
        throw error;
    }
}

export function readSelectionStateSync(filePath) {
    try {
        return normalizeState(JSON.parse(readFileSync(filePath, 'utf8')));
    } catch (error) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError) {
            return normalizeState(null);
        }
        throw error;
    }
}

export async function writeSelectionState(filePath, rawAlias) {
    const alias = typeof rawAlias === 'string' ? rawAlias.trim() : '';
    if (alias && !isValidVcpAlias(alias)) {
        throw new TypeError('Invalid VCP Agent alias.');
    }

    const state = {
        version: SELECTION_STATE_VERSION,
        selectedAgent: alias,
        updatedAt: new Date().toISOString()
    };
    await mkdir(dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, filePath);
    return state;
}
