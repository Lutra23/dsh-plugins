# dsh-lens — 内核透镜

把 `app.asar` 里的内核包变成四个可直读的工具。AST 索引器、code_searcher、
外部子进程都看不见归档内部——以前每次内核考古都要手写一遍 asar 头解析器
（2026-10-04 的 `_asar-research`、2026-10-26 的 `asarver`/`asartool` 系列，
全是同一件事的重复劳动）。这个插件把它固化成能力。

## 工具

| 工具 | 干什么 |
|---|---|
| `kernel_versions` | 全部 `@deepseek-ai/*` 包版本 + node/electron/chrome 运行时对账；可按子串过滤 |
| `kernel_list` | 列内核包内某目录的文件（目录在前、带大小） |
| `kernel_file` | 读内核包内单个文件，支持 `M-N` / `head:N` / `tail:N` / `N` 行号范围 |
| `kernel_grep` | 在内核源码里按字面量（默认）或正则搜索；限定单包或全作用域 |

包名接受全名（`@deepseek-ai/dsh-tools`）或短名（`dsh-tools`）。

## 边界

- **只读**：没有任何写副作用；asar 定位失败只让当次工具调用报错，不炸插件启动。
- **unpacked 条目**：归档里无 offset 的文件回落读 `app.asar.unpacked` 同路径镜像。
- **预算**：grep 单文件 ≤8MB、总量 ≤160MB（超出截断并明说）；file 回执 ≤200KB；list ≤300 条。
- asar 自动定位四级：`config.asarPath` > `DSH_LENS_ASAR` 环境变量 > Electron `resourcesPath` > execPath 同级。

## 自测

```bash
cd ~/.dsh/plugins/dsh-lens
DSH_LENS_ASAR="<DSH 安装目录>/resources/app.asar" node test/selftest.mjs
# 16 断言：版本对账 / 短名解析 / 行号三形态 / 坏参报错 / 真实符号命中 / 正则与字面量分叉
```

## 卸载

profile `package.json` 删 `dsh-lens` 依赖与 bundles 行，删
`node_modules/dsh-lens` junction，删本目录。无其他残留（storages 无写入）。
