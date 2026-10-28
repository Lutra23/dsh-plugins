# dsh-vcp-tools · VCP 桥接工具包（DSH 宿主插件）

把 VCPToolBox 的五个工具固化为 DSH 常驻工具（desktop / web profile 通用）：

| 工具 | VCP 插件 | 通路 |
|---|---|---|
| `doubao_search` | DoubaoSearch | **双路**：vcpHome 下插件文件存在 → stdio 直连本地插件（无需 VCP 服务器）；否则 → admin_api 桥（远端 VCP 侧用自己的 Key 执行） |
| `lightmemo` | LightMemo | admin_api 桥（hybridservice 进程内插件，只能走桥） |
| `dailynote_write` | DailyNote + DailyNoteManager | admin_api 桥（写侧：create 新建 / update 修订 / organize 合并归档；`writeFolders` 白名单限定落库，署名溟月） |
| `dailynote_read` | DailyNoteManager + DailyNoteSearcher | admin_api 桥（读侧：list 目录 / read 原文 / search 全文 / associate 联想；`readFolders` 白名单，update 的先读配套） |
| `chrome_bridge` | ChromeBridge | admin_api 桥（操作 **VCP 所在机器** 的托管 Chrome——远端模式下语义变为“远端浏览器”） |

## 配置（profile patch `config:`）与环境变量

端点与凭证不硬编码，解析优先级（user/pass 两半独立，各取最靠前层）：

**profile patch config > 环境变量 > `vcpHome` 下 config.env > 默认 `http://127.0.0.1:6005`**

| config 键 | 环境变量 | 默认 | 作用 |
|---|---|---|---|
| vcpHost / vcpPort | `VCP_HOST` / `VCP_PORT` | 127.0.0.1 / 6005 | admin_api 端点（本地或远端） |
| vcpHome | `VCP_HOME` | '' | VCPToolBox 根目录：config.env 凭证兜底、doubao stdio 插件路径、子进程 cwd（目录不存在时 cwd 回退系统临时目录） |
| writeFolders | —（仅 patch config） | `DSH工程档案,溟月的知识` | 日记**写**白名单（逗号/中文逗号/分号/竖线分隔）：create/update/organize 只允许落这些库；别名归一（"溟月"→"溟月的知识"）；配空 = fail-closed 拒绝一切写入 |
| readFolders | —（仅 patch config） | `DSH工程档案,溟月的知识,Nova,小绝,Kerr,Kerr的知识,公共,已整理` | 日记**读**白名单：dailynote_read 的 list/read/search/associate 范围，越界项被忽略 |
| adminUser / adminPass | `VCP_ADMIN_USER` / `VCP_ADMIN_PASSWORD` | '' / '' | Basic 凭证（明文进 patch yml 有泄露风险，优先环境变量） |

doubao Key（仅 stdio 直连需要）：调用参数 `api_key` > `vcpHome/Plugin/DoubaoSearch/config.env` 的 `WEB_SEARCH_API_KEY` > 子进程继承的 `WEB_SEARCH_API_KEY` 环境变量。桥模式下 Key 由远端 VCP 侧解析，本地无需配置。

本机配置示例（profile `cordis.patch.yml`）：

```yaml
- id: vcp-tools
  name: '@dsh-external/dsh-vcp-tools'
  config:
    vcpHome: 'D:\YourPath\VCPToolBox'
```

## 安装

1. profile `package.json`：`dependencies` 加 `"@dsh-external/dsh-vcp-tools": "link:<本目录绝对路径>"`，`dsh.profile.bundles` 数组加 `"@dsh-external/dsh-vcp-tools"`。
2. profile 目录 `pnpm install`。
3. **重启 App**（宿主插件组装期装载，不热重载）。

## 分发硬依赖（接收方 VCP 侧）

- 桥路由 `routes/admin/pluginExecute.js`——VCPToolBox **自建资产**，非官方自带；重建方法见 VCPToolBox `docs/DSH_PLUGIN_BRIDGE.md` §6.1（挂载一行 + 重启 VCP）。doubao 桥模式 / lightmemo / dailynote_write / dailynote_read / chrome_bridge 都依赖它。
- 对应插件在 VCP 侧启用（DoubaoSearch 需配 `WEB_SEARCH_API_KEY`，LightMemo 需知识库已建索引；dailynote_write 需 DailyNote + DailyNoteManager，dailynote_read 需 DailyNoteManager + DailyNoteSearcher——searcher 是 Rust 二进制，随插件目录分发）。
- 安全注意：Basic 凭证明文 HTTP 传输，仅适合本机回环或可信内网；跨公网远端务必套 TLS 反代或隧道。

## 测试与验证

- `node test/selftest.mjs` —— 离线 23 断言（工具注册×5 / 端点注入 / 凭证三层 / cwd 兜底 / doubao 双路判定与嵌套错误 / dailynote create 载荷 / chrome 参数透传 / 写读白名单拒绝零子进程 / 别名归一 / 空名单 fail-closed / update 去 maid 载荷 / 预检三级拦截 / 越库告警 / fuzzyDiff 回显 / organize 越界拒绝 / list 紧凑行 / search 白名单过滤）。2026-10-10 PASS 23 / FAIL 0。
- `node test/livecheck.mjs` —— 真桥端到端（需 VCP 6005 在跑、VCP_HOME 或桌面默认路径）：只读模式验读侧四动作与双侧白名单；`--mutations` 额外验真写——update 同内容自替换**前后 sha256 必须逐字节不变**、create 探针删后复查（防 VCP 后台回写复活）。2026-10-10 PASS 10 / FAIL 0（含真写）。
- 桥协议实证：DoubaoSearch 经 `/admin_api/plugins/DoubaoSearch/execute` 真跑通（HTTP 200，真实搜索结果，2026-10-04）；dailynote 双侧经同路由真跑通（2026-10-10）。
- 改 `lib/index.js` 后需重启 App 生效。

## update 语义要点（与 VCP 对齐的坑）

- **update 只传 folder、不传 maid**：VCP 侧 owner 守卫（`isFolderMatchAllowedByOwner`）下，带 maid 会把目标库踢出优先队列、退化成全库顺序扫描，跨库误改风险反而更大。
- **预检三级判定**（默认先读后写，`force:true` 跳过）：url 精读逐字/脱水命中 → 库内搜索逐字或脱水归一命中（与 VCP `dehydrate` 同语义）→ 多命中必拦（VCP 只改扫描到的第一篇）；通道故障返回 unverified 并**默认拒绝**。
- **事后复核**：update 成功后用回执 `folder/fileName` 复核实际落库，越出写白名单即报越库改写告警并给反向回滚指引。

## 回滚

- 本插件：`lib/index.js.bak-20261004-223330`。
- desktop patch：`cordis.patch.yml.bak-20261004-224800`；web patch 同名备份。
