# dsh-forge-context 0.0.9 安装说明

给收到 `dsh-external-dsh-forge-context-0.0.9.tgz` 的人看。

## 它是什么

DSH 的**上下文压缩后端替换件**：接管 `compaction-basic`，由 Agent 写语义摘要，插件负责版本、范围、保护、收益和落盘校验。它不是独立生效的插件；必须在 preset 里替换压缩后端。

## 前提

- DSH 内核 `>=0.2.1-rc.2 <0.3.0-0`。
- `dsh-project-forge` 宿主需支持 `supersededOpenIssues`（当前为 `0.4.1-local.5` 或更高）。旧宿主使用 `additionalProperties:false`，会在入口整条拒收带该字段的摘要；不要只升级本插件。
- profile 目录是 pnpm 结构，安装前备份 `package.json` 与 preset。

## 安装

```bash
cd ~/.dsh/profiles/<你的profile>
pnpm add file:/绝对路径/dsh-external-dsh-forge-context-0.0.9.tgz
```

确认版本：

```bash
node -e "console.log(require('@dsh-external/dsh-forge-context/package.json').version)"
# 应输出 0.0.9
```

## 接管压缩

在 preset 中找到 `compaction-basic`，只改 `name`：

```yaml
- id: compaction-basic                            # id 保持不变
  name: '@dsh-external/dsh-forge-context'         # 只换这一行
```

同时关闭 `tool-result-pruner`，避免它和 forge-context 争夺工具结果节点：

```yaml
- id: tool-result-pruner
  name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
  disabled: true
```

所有实际使用的 preset（standard / ptc / minimal / cordis / nova-forge 等）都要改，或只改你正在用的那份。

## 验证

重启 DSH 后，在包安装目录运行：

```bash
cd node_modules/@dsh-external/dsh-forge-context
node check.cjs
node verify-dist.cjs
```

两者都应 exit 0。`check.cjs` 会先核对包版本为 0.0.9，再检查旧回归与 0.0.7/0.0.8/0.0.9 的新功能探针。

然后在会话里确认 `forge_context` 工具存在，并调用 `forge_context status`。1M 窗口下应看到：

```text
limit 500000 · remind 300000 · autoTidy 350000 · preferTidy 400000 · stop 500000
targetLow 150000 · targetHigh 200000
```

`remind` 若是 250000，说明跑的还是 0.0.5 或旧代码，回到安装/preset 步骤检查。

## 回滚

```bash
cd ~/.dsh/profiles/<你的profile>
pnpm remove @dsh-external/dsh-forge-context
```

把 preset 的 `name` 恢复为 `@deepseek-ai/dsh-compaction-basic`，去掉 `tool-result-pruner` 的 `disabled: true`，重启。历史不会丢：被压缩节点仍在会话日志，只是不在 surface 上。
