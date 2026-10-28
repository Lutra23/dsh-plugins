# 第三方与许可分层

根仓库以 MIT 发布。下列条目有独立来源或额外限制，分发前请逐项确认。

## 衍生改造件（forks/）

| 包 | 上游 | 上游许可 | 本仓库改动 |
|---|---|---|---|
| `dsh-token-optimizer` | `@zoria-lind/dsh-token-optimizer` | MIT | toolTrim / 压缩驱动 / 输出阶梯；调试日志路径改临时目录（不再写 `D:` 盘） |
| `dsh-chat-rewind` | `JochenYang/dsh-rewind-plugin` | MIT | 早期本地版；上游 0.4.x 已覆盖，保留作历史对照，不建议新装 |

## 内核内嵌件

| 包 | 条目 | 说明 |
|---|---|---|
| `dsh-project-forge` | `vendor/VCPDistributedServer/**` | VCPChat 原版逐字副本，许可随上游 |
| `dsh-project-forge` | `tools/CodeSearcher.exe`、`vendor/**/projectforge_indexer.exe` | 预编译 Rust 索引器；**源 crate 声明 CC-BY-NC-SA-4.0（禁商用）**。商用需自行替换或取得授权 |
| `dsh-design-symposium` | `src/` 与 `lib/` | fork 自 `HSM266/dsh-roundtable-harness` v0.3.14（MIT），按 VCP MagiAgent 立场辩论改造 |

## VCP 侧

| 件 | 来源 | 说明 |
|---|---|---|
| `LightMemoAssoc` | VCPToolBox 生态 | 本地改良版（只读 WAL 快照读，适配 VCP 1.6.0 原生迁移）；上游许可随 VCPToolBox |
| `dsh-vcp-bridge` | 本仓库 | 与 `dsh-vcp-omni-kit` 同源，含 PowerShell 安装器 |

## 资产

- `dsh-emoji` 不随包分发图片资产，用户自行导入。
- 各包 `test/` 内的示例路径（`C:\Users\me`、`D:\videos` 等）仅为夹具，不指向任何真实机器。
