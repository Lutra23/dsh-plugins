/**
 * dsh-local-search · 把 VCP 的 LocalSearchController（本地文件秒搜 / Everything）移植为 DSH 常驻工具。
 *
 * 传输选型 —— 这里故意没走 dsh-code-tools 的「stdio 桥接原版插件进程」路子，理由三条实证：
 *   1. 本工具的全部价值就是毫秒级。桥接要先 spawn 一个 node，再 spawnSync 插件进程，
 *      在 Windows 上平白多 200-400ms；而 Everything 热查询端到端实测只有 56ms —— 桥接会让
 *      「秒搜」名实不符。
 *   2. code-tools 选桥接的核心理由是「凭证/代理实时读 VCP 侧原位文件」，而原插件零凭证、
 *      纯 40 行 HTTP，这条理由在这里不存在。
 *   3. VCP 两份副本的端口配置自相矛盾：VCPToolBox 侧没有 .env → 代码里硬编码默认 8025（本机
 *      无人监听），VCPDistributedServer 侧 .env 指 80（本机活着）。桥接哪一份都不确定。
 * 代价是这段适配逻辑住在本包里；换来的是不依赖 VCPToolBox 目录存在、可独立装卸与回退。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DEFAULT_MAX_RESULTS, HARD_MAX_RESULTS, diagnose, formatResults, search } from './everything.js'

const TOOL_DESCRIPTION = [
  '本地文件秒搜（Everything 引擎；移植自 VCP LocalSearchController）：在整台电脑的 NTFS 索引上做毫秒级文件搜索，',
  '跨全部本地盘，返回文件路径 + 大小 + 修改时间。',
  '',
  '何时用：要找「这台机器上某个文件到底在哪」——不确定在哪个盘或哪层目录、按文件名或扩展名捞文件、',
  '按大小/日期筛文件时。结果路径可直接交给 ReadCode / project_forge 读内容。',
  '何时不用：在已知范围内按【文件内容】检索 → code_searcher；列已知目录 → pwsh 的 Get-ChildItem。',
  '',
  'query 用 Everything 语法：空格=AND，`|`=OR，`!`=NOT；常用 `ext:mp4`、`path:D:\\videos\\`、',
  '`size:>1gb`、`dm:thisyear`、`folder:`、`*.mp4`、`"完整短语"`。裸关键词默认只匹配文件名，不含路径。',
  '',
  '前提：Everything 需在运行且「工具→选项→HTTP服务器」已启用。端口自动读 Everything.ini 的 http_server_port，',
  '连接被拒时会重读自愈；也可用环境变量 DSH_EVERYTHING_PORT 钉死。',
].join('\n')

export default {
  name: 'local-search',
  inject: ['tools'],
  apply(ctx) {
    ctx.tools.register(defineTool({
      name: 'everything_search',
      description: TOOL_DESCRIPTION,
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: '搜索关键词，Everything 语法。裸词默认匹配文件名；`path:` 限定目录，`ext:` 限定扩展名，`size:>1gb` / `dm:today` 过滤，空格为 AND、`|` 为 OR、`!` 为 NOT。空关键词会命中全盘，会被拒绝。',
        },
        maxResults: {
          type: 'integer',
          description: '本工具返回的最大条数，默认 ' + DEFAULT_MAX_RESULTS + '，上限 ' + HARD_MAX_RESULTS + '。返回里同时给出真实命中总数（可能远大于此值）。',
        },
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: value }] },
      },
      async execute(args) {
        const a = args || {}
        const query = String(a.query === undefined || a.query === null ? '' : a.query).trim()
        if (!query) {
          return '**错误**: 缺少 query。Everything 语法示例：`ext:mp4 path:D:\\videos`、`*.pdf size:>10mb`、`"完整短语"`。'
        }
        try {
          const { total, rows } = await search(query, { maxResults: a.maxResults })
          return formatResults(query, total, rows)
        } catch (e) {
          return diagnose(e)
        }
      },
    }))
  },
}
