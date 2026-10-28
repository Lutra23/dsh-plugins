'use strict';
// 共享多模态读取：文本 / 文档提取 / 图片音视频 data URL，
// 输出标准 OpenAI content part（text + image_url），可被任意插件直接返回给 AI。

const fs = require('fs').promises;
const path = require('path');
const { detectEncoding, applyLineRangeToContent, formatFileSize, markdownFence, languageOf, numberLines, splitLines } = require('./text');
const { isBinaryExtension, readBinaryAsContent } = require('./binaryReader');

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov']);
const DOC_EXT = new Set(['.pdf', '.docx', '.xlsx', '.xls', '.csv']);

/** [DSH 移植补丁] 编码别名归一：探测结果 → Node ICU 认识的解码器名。 */
const DECODE_ALIASES = new Map([
    ['utf8', 'utf-8'], ['utf-8', 'utf-8'],
    ['utf16le', 'utf-16le'], ['utf-16le', 'utf-16le'],
    ['utf16be', 'utf-16be'], ['utf-16be', 'utf-16be'],
    ['gbk', 'gbk'], ['gb2312', 'gbk'], ['gb18030', 'gb18030'],
    ['big5', 'big5'], ['big5-hkscs', 'big5'],
    ['shift_jis', 'shift_jis'], ['shift-jis', 'shift_jis'], ['sjis', 'shift_jis'],
    ['euc-jp', 'euc-jp'], ['euc-kr', 'euc-kr'],
    ['iso-8859-1', 'windows-1252'], ['windows-1252', 'windows-1252'],
    ['ascii', 'utf-8'], ['us-ascii', 'utf-8'],
]);

/**
 * 按探测结果解码文本。
 * BOM 优先（UTF-8/UTF-16 各自带 BOM 时以 BOM 为准）；否则按 chardet 结果解码；
 * 解码器不可用或解码失败时保守回退 UTF-8 —— 宁可显示乱码，也不抛错阻断读取。
 */
function decodeByEncoding(buffer, info) {
    const raw = info && info.encoding ? String(info.encoding).toLowerCase() : 'utf-8';
    const strip = (name) => String(name || '').replace(/-/g, '').toLowerCase();
    const hasUtf8Bom = buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF;
    if (hasUtf8Bom) return buffer.toString('utf8', 3);
    if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
        return new TextDecoder('utf-16le').decode(buffer.subarray(2));
    }
    if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
        return new TextDecoder('utf-16be').decode(buffer.subarray(2));
    }
    const enc = DECODE_ALIASES.get(raw)
        || (/^utf-?16le$/.test(raw) ? 'utf-16le' : null)
        || (/^utf-?16be$/.test(raw) ? 'utf-16be' : null)
        || raw;
    if (enc === 'utf-8' || strip(enc) === 'utf8') return buffer.toString('utf8');
    try {
        return new TextDecoder(enc, { fatal: false }).decode(buffer);
    } catch (_e) {
        return buffer.toString('utf8');
    }
}

function mediaKind(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (IMAGE_EXT.has(ext)) return 'image';
    if (AUDIO_EXT.has(ext)) return 'audio';
    if (VIDEO_EXT.has(ext)) return 'video';
    if (DOC_EXT.has(ext)) return 'document';
    if (isBinaryExtension(ext)) return 'binary';
    return 'text';
}

function mimeOf(filePath, kind) {
    const ext = path.extname(filePath).toLowerCase().slice(1);
    if (kind === 'image') return `image/${ext === 'jpg' ? 'jpeg' : ext}`;
    if (kind === 'audio') return `audio/${ext === 'mp3' ? 'mpeg' : ext}`;
    return `video/${ext}`;
}

async function extractDocumentText(filePath, buffer) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.pdf') {
        const pdf = require('pdf-parse');
        return (await pdf(buffer)).text;
    }
    if (ext === '.docx') {
        const mammoth = require('mammoth');
        return (await mammoth.extractRawText({ buffer })).value;
    }
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    if (ext === '.csv') {
        const { Readable } = require('stream');
        await workbook.csv.read(Readable.from([buffer]));
    } else {
        await workbook.xlsx.load(buffer);
    }
    let out = '';
    workbook.eachSheet(sheet => {
        out += `--- Sheet: ${sheet.name} ---\n`;
        sheet.eachRow({ includeEmpty: true }, row => {
            out += row.values.slice(1).join('\t') + '\n';
        });
    });
    return out;
}

/**
 * 读取单个文件为原始结构（不做 markdown 渲染）。
 * @returns {Promise<{kind, fileName, size, lastModified, text?, dataUrl?, encodingInfo?, lines?}>}
 */
async function readFileRaw(filePath, options = {}) {
    require('../../../../lib/operations.cjs').check(filePath);
    const { encoding = 'utf8', lines, maxFileSize = 20 * 1024 * 1024 } = options;
    const stats = await fs.stat(filePath);
    if (stats.isDirectory()) throw new Error(`'${filePath}' is a directory, not a file.`);
    if (stats.size > maxFileSize) {
        throw new Error(`File too large: ${formatFileSize(stats.size)} exceeds limit of ${formatFileSize(maxFileSize)}`);
    }
    const buffer = await fs.readFile(filePath);
    const kind = mediaKind(filePath);
    const base = {
        kind,
        fileName: path.basename(filePath),
        size: stats.size,
        sizeFormatted: formatFileSize(stats.size),
        lastModified: stats.mtime.toISOString(),
    };

    if (kind === 'image' || kind === 'audio' || kind === 'video') {
        return { ...base, dataUrl: `data:${mimeOf(filePath, kind)};base64,${buffer.toString('base64')}` };
    }

    let text;
    let encodingInfo = null;
    if (kind === 'document') {
        text = await extractDocumentText(filePath, buffer);
    } else {
        encodingInfo = detectEncoding(buffer);
        // [DSH 移植补丁] 上游此处恒用 options.encoding（默认 'utf8'）解码，
        // 使 detectEncoding 的结果仅作展示、不参与解码——GBK/Big5 等非 UTF-8 文件
        // 会被读成乱码，进而被 EditCode 转码写坏。这里改为真正按探测到的编码解码。
        text = decodeByEncoding(buffer, encodingInfo);
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    }
    const sliced = applyLineRangeToContent(text, lines);
    return { ...base, text: sliced.content, lines: sliced.lines, encodingInfo };
}

/**
 * 读取单个文件为 AI 友好的 content part 数组。
 * 文本以带语言标签的 fence 输出；withLineNumbers=true 时每行带 `N | ` 前缀。
 */
async function readFileAsContent(filePath, options = {}) {
    const kind = mediaKind(filePath);
    if (kind === 'binary') {
        const stats = await fs.stat(filePath);
        if (stats.size > (options.maxFileSize || 20 * 1024 * 1024)) {
            throw new Error(`File too large: ${formatFileSize(stats.size)} exceeds limit of ${formatFileSize(options.maxFileSize || 20 * 1024 * 1024)}`);
        }
        const buffer = await fs.readFile(filePath);
        return await readBinaryAsContent(filePath, buffer, { ...options, fileSizeBytes: stats.size });
    }

    const raw = await readFileRaw(filePath, options);
    const displayPath = options.displayPath || filePath;
    let header = `#### ${displayPath} (${raw.sizeFormatted})`;
    const parts = [];

    if (raw.dataUrl) {
        if (options.lines) header += `\n- 已跳过行范围：${raw.kind} 文件不支持 lines`;
        parts.push({ type: 'text', text: header });
        parts.push({ type: 'image_url', image_url: { url: raw.dataUrl } });
        return { parts, raw };
    }
    let body = raw.text;
    let startLine = 1;
    if (raw.lines) {
        header += `\n- 行范围：${raw.lines.actualStart}-${raw.lines.actualEnd}/${raw.lines.totalLines}`;
        startLine = Math.max(raw.lines.actualStart, 1);
    } else if (raw.kind === 'text') {
        header += `\n- 总行数：${splitLines(raw.text).lines.length}`;
    }
    if (options.withLineNumbers && raw.kind === 'text') {
        body = numberLines(raw.text === '' ? [] : raw.text.split('\n'), startLine);
    }
    parts.push({ type: 'text', text: `${header}\n\n${markdownFence(body, raw.kind === 'text' ? languageOf(filePath) : 'text')}` });
    return { parts, raw };
}

/**
 * 批量读取（多模态）。超出文件数或总字节上限的文件不读取，但列出清单供 AI 分批继续。
 * @param {Array<{absPath:string, displayPath?:string, lines?:string}>} files 每个文件可单独指定行范围
 */
async function readFilesAsContent(files, options = {}) {
    const { maxFiles = 20, maxTotalBytes = 30 * 1024 * 1024 } = options;
    const parts = [];
    const read = [];
    const skipped = [];
    const failed = [];
    let totalBytes = 0;

    for (const file of files) {
        const label = file.displayPath || file.absPath;
        if (read.length >= maxFiles) {
            skipped.push({ path: label, reason: `超出单批文件数上限 ${maxFiles}` });
            continue;
        }
        try {
            const stats = await fs.stat(file.absPath);
            if (totalBytes + stats.size > maxTotalBytes) {
                skipped.push({ path: label, reason: `超出单批总大小上限 ${formatFileSize(maxTotalBytes)}` });
                continue;
            }
            const { parts: fileParts, raw } = await readFileAsContent(file.absPath, {
                ...options,
                displayPath: label,
                lines: file.lines !== undefined && file.lines !== '' ? file.lines : options.lines,
            });
            totalBytes += raw.size;
            parts.push(...fileParts);
            read.push({ path: label, kind: raw.kind, size: raw.size });
        } catch (error) {
            failed.push({ path: label, error: error.message });
        }
    }

    const tail = [];
    if (skipped.length) {
        tail.push(`### 未读取（请分批继续）\n${skipped.map(s => `- ${s.path}：${s.reason}`).join('\n')}`);
    }
    if (failed.length) {
        tail.push(`### 读取失败\n${failed.map(f => `- ${f.path}：${f.error}`).join('\n')}`);
    }
    if (tail.length) parts.push({ type: 'text', text: tail.join('\n\n') });

    return { parts, read, skipped, failed, totalBytes };
}

module.exports = {
    mediaKind,
    readFileRaw,
    readFileAsContent,
    readFilesAsContent,
};