/**
 * dsh-universal-read · 把 VCP FileOperator 的只读三命令移植为 DSH 常驻工具。
 *
 * 只暴露 universal_read（读本地文件 / 从 URL 取文本 / 下载文件），其余 17 个命令不搬：
 * 写系列已被 project_forge 全覆盖且带账本回退；WriteEscapedFile / UpdateHistory / CreateCanvas
 * 是寄生在 VCP 宿主身上的死命令；SearchFiles 已被 everything_search 取代。
 *
 * 本包补的是「读任意文件」这个真缺口：nova-forge preset 刻意砍掉自带 read，
 * project_forge 只认白名单内路径 —— 白名单之外（比如 everything_search 刚搜出来的路径）
 * 读 PDF / docx / xlsx / GBK 文本，原生链路是断的。FileOperator 的解析器正好把它接上。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  REMOTE_TIMEOUT_MS,
  buildRequest,
  diagnose,
  parseEnvelope,
  runBridge,
  shapeOutput,
} from './universal.js'

const TOOL_DESCRIPTION = [
  '读任意文件的内容（移植自 VCP FileOperator 的只读部分；写操作请用 project_forge）。',
  '专门补两块原生链路的断层：① 白名单之外的任意绝对路径（everything_search 搜出的路径直接喂进来）；',
  '② 带格式提取的文件 —— PDF / Word(.docx) / 表格(.xlsx,.xls,.csv) 自动提纯文本并分页返回。',
  '',
  '何时用：要读一个文件的内容、且它不在 DSH 工作区白名单内（project_forge 够不着）；读 PDF 论文、Word 文档、Excel 表；',
  '从 URL 取一个文本/PDF/docx 的内容；把网上文件落盘。',
  '何时不用：文件在白名单内 → project_forge 的 ReadCode 更强（符号寻址、上下文、回退账本）；改写文件 → project_forge；',
  '按文件名找文件 → everything_search；按内容找代码 → code_searcher。',
  '',
  '参数二选一：filePath（本地绝对路径，相对路径会被拒绝）或 url（只允许 http/https）。',
  'lines 分页读大文件：`head:N` 开头 N 行、`tail:N` 末尾 N 行、`M-N` 第 M 到 N 行、单个数字读一行。',
  'mode=read（默认）取回文本；mode=download 只存文件、远小于读全文，返回落盘路径（下载完成后进程才退出，返回即完成）。',
  '',
  '护栏沿用 VCP 原版：读走 isPathAllowed 只读旁路；DownloadFile 的目标目录受 ALLOWED_DIRECTORIES 约束；',
  '单文件上限约 20MB（VCP 侧 MAX_FILE_SIZE）；返回文本超 4 万字符自动截断并指路分页。',
].join('\n')

export default {
  name: 'universal-read',
  inject: ['subprocess', 'tools'],
  apply(ctx) {
    let nodePathPromise = null
    function nodePath() {
      if (nodePathPromise) return nodePathPromise
      nodePathPromise = ctx.subprocess.resolveExecutable('node').catch((e) => {
        nodePathPromise = null
        throw e
      })
      return nodePathPromise
    }

    ctx.tools.register(defineTool({
      name: 'universal_read',
      description: TOOL_DESCRIPTION,
      parameters: {
        filePath: {
          type: 'string',
          description: '本地文件的绝对路径。与 url 二选一。相对路径会被拒绝（避免被原版解析到 VCPToolBox 根下误读）。',
        },
        url: {
          type: 'string',
          description: '网上文件的 http/https 地址。与 filePath 二选一。mode=read 取回文本并顺手存一份本地；mode=download 只存文件。',
        },
        lines: {
          type: 'string',
          description: '分页：`head:N` 开头N行 / `tail:N` 末尾N行 / `M-N` 第M到N行 / `N` 读单行。图片/音视频内容会忽略此参数。',
        },
        mode: {
          type: 'string',
          enum: ['read', 'download'],
          description: 'read（默认）：取回文本。download：只把文件存到本地，返回落盘路径；可再给 downloadDir（目录）/ fileName（改名）。',
        },
        downloadDir: {
          type: 'string',
          description: '仅 mode=download：落盘目录（绝对路径）。不给则用 VCP 侧默认。受 ALLOWED_DIRECTORIES 约束。',
        },
        fileName: {
          type: 'string',
          description: '仅 mode=download：落盘时改名（纯文件名，不能含路径）。重名自动加序号不覆盖。',
        },
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: value }] },
      },
      async execute(args) {
        const built = buildRequest(args || {})
        if (built.error) return '**错误**：' + built.error
        const timeoutMs = built.kind === 'read' ? 60000 : REMOTE_TIMEOUT_MS
        let text
        try {
          const node = await nodePath()
          text = await runBridge(
            (spec) => ctx.subprocess.spawn(spec),
            node,
            built.request,
            built.timeoutMs || timeoutMs,
            {}
          )
        } catch (e) {
          return diagnose(e)
        }
        let env
        try {
          env = parseEnvelope(text)
        } catch (e) {
          return diagnose(e)
        }
        const meta = { kind: built.kind, filePath: built.request.filePath, url: built.request.url }
        return shapeOutput(env, meta)
      },
    }))
  },
}
