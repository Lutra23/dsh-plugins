# ProjectForge AST Indexer Runtime

此目录原本存放 `projectforge_indexer` 的预编译运行时。**二进制不随仓库分发**
（体积 + 许可），改由 GitHub Releases 提供：

<https://github.com/Lutra23/dsh-plugins/releases>

目录约定（与 `indexerClient.js` 的 `resolveDefaultBinaryPath` 一致）：

```text
bin/
├── win32-x64/
│   └── projectforge_indexer.exe
├── win32-arm64/
│   └── projectforge_indexer.exe
├── darwin-x64/ | darwin-arm64/ | linux-x64/ | linux-arm64/
│   └── projectforge_indexer
```

放置优先级：

1. `$DSH_PROJECTFORGE_BIN/projectforge_indexer[.exe]`
2. 本目录（`<包目录>/vendor/VCPDistributedServer/Plugin/ProjectForge/bin/<platform>-<arch>/`）
3. `~/.dsh/projectforge/bin/projectforge_indexer[.exe]`

缺失时插件不会崩：符号索引退回正则启发式，`status()` 会报熔断原因。
构建脚本在上游 crate `rust_projectforge_indexer/build-runtime.js`（本仓库不含 crate 源）。
