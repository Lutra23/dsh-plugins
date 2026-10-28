# dsh-chat-rewind

DSH Web GUI 的会话回溯插件：在聊天记录每轮尾部加"重新生成 / 编辑重发 /
撤回到此"三个按钮，官方 fork API 驱动，不触碰源会话日志。

## 语义（重要）

"回溯"是**分叉（fork）**，不是改写历史：

- 点击后以「该轮 turn/start 之前」为边界，fork 出一个**新会话**（自动
  切换过去），原会话与日志原封不动，可随时回看。
- 已产生的**外部副作用不回滚**：文件改动、git 提交、已发送的工程任务
  都保持原样，回溯只回滚对话上下文。
- **重新生成** = fork + 把该轮**原始提问文本**原样重发进新会话。它会
  整轮重跑（含工具调用），工具可能重复执行并产生新的副作用——不是只
  重跑最后一条回复。
- 编辑重发 = fork + 把编辑后的文本作为新用户消息发进新会话。
- 重新生成/编辑重发当前只搬运**文本**：原提问里的图片、文件附件不会
  自动带入；纯图片/附件轮次会拒绝执行并提示。
- 回溯成功后，**源会话自动归档**（会话列表保持干净；旧会话在归档区可
  随时找回，行为可逆）。归档失败不影响回溯本身。

## 与压缩（compaction）的兼容性

- compaction 事务（start→summary→checkpoint→end）完整发生在 open turn
  内部；本插件的所有边界都取在 **turn 边缘**（目标轮 turn/start 的前一
  个事件），永不落入事务中间，fork 出的子会话重放必然拿到完整事务。
- fork 继承完整事件流：压缩 checkpoint、被遮蔽区间在新会话中原样重放，
  遮蔽语义正确延续。auto-tidy 类宿主运行时状态是 per-session 的，子会
  话从零初始化，无跨会话污染。
- 撤回点早于压缩点时，新会话保留摘要（而非解开压缩）——这是压缩语义
  的正确延续，不是 bug。

## 技术

- 浏览器半（client.js）注册官方 `conversation.chat.turnTail` 槽位（每轮
  尾部渲染，props 携带 {turn, seq}）；`conversation.chat.assistant-actions`
  仅覆盖带 assistant 回复的轮，turnTail 覆盖面更全且当前无占用者。
- 轮上下文（该轮 user 原文 / 边界 / 完成态）通过官方 `remote.session.page`
  冷读反查（不激活 Agent）。
- 仅使用官方 remote：page / fork / prompt / selectModel /
  workspace.archiveSession；宿主半为空壳。

## 安装（本机 profile 手动注册配方）

见 `~/.dsh/skills/dsh-plugin-ops`：profile `package.json` 加 `link:` 依赖 →
`node_modules/@local/dsh-chat-rewind` junction 指向本目录 → 重启 App。
（`dsh plugin --profile desktop add link:<本目录>` 会自动登记 bundles。）
