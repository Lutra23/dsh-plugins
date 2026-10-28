'use strict';
// 移植桩：ProjectForgeService 以 `require('../../../modules/services/workspaceIndex')` 读取
// DEFAULT_IGNORED_DIRS（AST 扫描与 FindSymbol 的忽略目录唯一来源）。
// VCPChat 主进程版含 Electron / 文件监视依赖，DSH 侧不需要，故此处只保留同一份忽略表。

// 默认忽略的目录名（大小写不敏感）。与 VCPChat modules/services/workspaceIndex.js 保持一致。
const DEFAULT_IGNORED_DIRS = new Set([
    '.git', '.svn', '.hg',
    'node_modules', 'bower_components', 'jspm_packages', '.pnpm-store', '.yarn',
    '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.nox', '.hypothesis', '.ipynb_checkpoints',
    '.venv', 'venv', 'env', '.env', 'virtualenv', '.conda',
    '.next', '.nuxt', '.svelte-kit', '.angular', '.parcel-cache', '.turbo', '.vercel', '.cache', '.gradle',
    'dist', 'build', 'out', 'target', 'coverage', '.nyc_output',
    '.idea', '.vs', '.vscode-test',
]);
const DEFAULT_IGNORED_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);
const DEFAULT_IGNORED_FILE_EXTENSIONS = new Set(['.pyc', '.pyo', '.class', '.o', '.obj']);

module.exports = {
    DEFAULT_IGNORED_DIRS,
    DEFAULT_IGNORED_FILES,
    DEFAULT_IGNORED_FILE_EXTENSIONS,
};
