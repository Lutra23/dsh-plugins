# 二进制附件（GitHub Releases）

仓库只放源码与脚本，预编译二进制走 [Releases](https://github.com/Lutra23/dsh-plugins/releases)。
当前提供：

| 附件 | 用于 | 平台 | SHA-256 |
|---|---|---|---|
| `CodeSearcher.exe` | `code_searcher` 工具（project-forge） | win32-x64 | `4755e6c1a537355cda706e6cd6f3cf640e7f545dfadb592e690ebdd27cc8457e` |
| `projectforge_indexer-win32-x64.exe` | AST 符号索引 sidecar（project-forge） | win32-x64 | `5887246606fad5abe81a5c48978e5b5bb387fa0dd978801ef5dc595df051abe4` |

## 放置位置

`dsh-project-forge` 按以下优先级查找（环境变量最优先）：

1. `$DSH_PROJECTFORGE_BIN/CodeSearcher.exe`、`$DSH_PROJECTFORGE_BIN/projectforge_indexer.exe`
2. 包内：`tools/CodeSearcher.exe`、
   `vendor/VCPDistributedServer/Plugin/ProjectForge/bin/<platform>-<arch>/projectforge_indexer[.exe]`
3. `~/.dsh/projectforge/bin/`

推荐：下载后统一放进 `~/.dsh/projectforge/bin/`，或设：

```powershell
$env:DSH_PROJECTFORGE_BIN = "$env:USERPROFILE\.dsh\projectforge\bin"
```

## 缺失时的行为

- `code_searcher`：报错文案会直接指出二进制缺失与下载位置。
- AST 索引：不抛错，`project_forge` 的 `Outline`/`FindSymbol` 退回正则启发式；
  `project_forge command:"Version"` 或引擎日志可见熔断原因。

## 为什么不在仓库里

1. `projectforge_indexer` 的源 crate 声明 **CC-BY-NC-SA-4.0（禁商用）**，
   二进制与源码分开分发更清楚（详见 [NOTICE.md](../NOTICE.md)）。
2. 21 MB 的二进制会让 clone 与 CI 变慢；Release 附件按需下载。

## 校验

下载后核对：

```bash
sha256sum CodeSearcher.exe projectforge_indexer-win32-x64.exe
```

构建方法：上游 crate 的 `rust_projectforge_indexer/build-runtime.js`（本仓库不含 crate 源）。
