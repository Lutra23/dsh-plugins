# DSH/VCP Omni plugin bundle

The new-session screen is split into two independent controls:

```text
[Agent 预设 ▾] [VCP 智能体 ▾]
```

The Agent preset menu preserves healthy built-in and user-defined DSH presets.
It renders stable groups in this order: official built-ins, the four VCP
compositions, `project-forge`, then other user-defined presets:

- `vcp-compat`: keeps all DSH tools and separates raw VCP text-tool turns from
  DSH native tool calls.
- `vcp-dual-stack`: keeps all DSH tools and exposes VCP through typed
  `vcp_tool_list` and `vcp_tool_call` tools.
- `vcp-omni`: DSH leads planning, dispatch, review, integration, takeover, and
  final verification; suitable VCP Agents execute scoped domain tasks.
- `vcp-deep-work`: retains DSH engineering and VCP bridge capabilities while
  applying a structure-first, evidence-driven engineering workflow.

## Model route and configuration contract

The DSH provider is authoritative. Complete automatic VCP integration requires
the session model to use provider id `vcptoolbox` with base URL
`http://127.0.0.1:6005/v1`. A label such as `VCPModelAuto` does not prove that
VCP is in the request path; the same label may be configured under another DSH
provider.

The VCP route is created through the official **Settings → Models → Add model
provider → Custom model API** flow. It is stored as a user profile under the
existing official `llm-pi-ai` plugin at `providers.vcptoolbox`; this bundle does
not inject or register another provider adapter. The official page therefore
retains its normal Edit and Delete actions. Official DeepSeek, DeepSeek Account,
model variants, and their reasoning metadata remain owned by DSH.

The recommended VCP profile advertises `off`, `low`, `high`, and `max` reasoning
efforts, with `high` as the route default. It also declares
`compat.supportsDeveloperRole=false`, `compat.maxTokensField=max_tokens`, and
`headers.X-DSH-VCP-Origin=1`. These are advanced official `llm-pi-ai` fields;
the page’s primary form creates the profile, while its documented advanced
configuration adds the VCP compatibility switches.

With `vcptoolbox`, VCP expands Agent placeholders, loads Agent diaries and RAG,
runs message preprocessing, and processes VCP text-tool requests. With a direct
DSH provider, DSH native tools and explicit VCP tools still work, but the main
session does not automatically receive VCP Agent identity, diary, RAG,
placeholder expansion, or text-tool processing.

Mode behavior on a direct DSH provider:

- `vcp-compat` is unsupported because it depends on VCP text-tool processing.
- `vcp-dual-stack` and `vcp-deep-work` are partial: typed `vcp_tool_call` still
  works, but automatic VCP memory does not.
- `vcp-omni` is partial: DSH orchestration still works, but VCP memory must be
  prefetched explicitly or supplied by a delegated `vcp_agent_run`.
- `vcp_agent_run` and `vcp_agent_ask` remain available in every mode because
  they make explicit VCP requests.

The plugin exposes the read-only native tool
`vcp_configuration_contract`. It returns the provider rule, route effects, mode
matrix, preset-coexistence rule, and installation boundary. Its runtime metadata
reports the plugin's configured VCP base URL and API-key variable, but it
explicitly does not claim to observe the live DSH provider. Inspect the active
DSH provider separately before changing configuration. Its `bridgeMode` is an
internal lane name, not the visible preset: Omni uses the `dual` bridge and the
tool reports `visiblePresetObservableByPlugin=false`.

People and agents should read `docs/operations/CONFIGURATION_GUIDE.md` and
`docs/contracts/configuration-contract.json` in the portable kit. Agents working inside
the project must also follow the root `AGENTS.md`.

The separate VCP Agent picker reads the live `agent_map.json` snapshot. It does
not add one top-level rule item per Agent. Selecting `溟月`, `Nova`, `Kerr`, or
another Agent writes the pending identity to:

```text
$DSH_HOME/vcp-agent-selection.json
```

For compatibility, dual-stack, and deep-work rules, the selected Agent becomes
the session's VCP identity and memory owner. For Omni, `DSH主控` keeps the lead
identity and the selected Agent is the preferred default executor; the planner
may still choose a better specialist.

Existing sessions freeze the identity after their first turn. Internal
`vcp-agent-*` execution profiles remain registered for task-scoped DSH
subagents, but the visible preset menu filters them out.

When a blank session has no staged selection, the chip displays the roster row
marked `isDefault`, including the official localized name such as
`创造模式`. It no longer falls back to the generic `规则模式`.

## Install as a DSH bundle

Run:

```powershell
pwsh -File .\Install-DshBundle.ps1
```

The installer detects `DSH_HOME` and `VCP_HOME`, links this package into the
selected DSH profile, adds it to `dsh.profile.bundles`, removes the legacy
hard-coded bridge block, and writes a profile override containing the resolved
VCP path. It creates timestamped backups and runs `pnpm install
--prefer-offline`. Add `-Offline` only on machines whose pnpm metadata cache is
known complete.

Restart DSH after installation. `DSH_HOME` defaults to `~/.dsh`; the desktop
profile is used by default. Use `-ProfileName` and `-VcpHome` when installing on
another machine or profile.

Copies of the DSH profile and package paths do not need to match this development
machine. The package contains no `D:/AI-XG` or user-home constants.

## Agent sync

VCP plugin `DSHAgentSync` serves a read-only, versioned snapshot:

```text
GET /api/plugins/DSHAgentSync/snapshot
GET /api/plugins/DSHAgentSync/events
POST /api/plugins/DSHAgentSync/identity/ensure
```

All endpoints use the normal VCP Bearer authentication. The DSH sync plugin
loads the snapshot when VCPToolBox is available and falls back to the local
`agent_map.json` + `Agent/` files when it is not. Polling remains enabled as a
recovery path, so DSH can start before VCPToolBox.

The sync is live:

- adding an alias to `agent_map.json` and its mapped prompt file adds it to the
  VCP Agent picker and internal execution-profile roster;
- the snapshot derives a short, single-line introduction from the mapped
  prompt's identity fields (`身份`, `定位`, role headings, `你是…`, or
  `你叫…`), so new Agents need no DSH-side edit;
- editing the mapped prompt changes the identity used on the next VCP request;
- removing the mapping or prompt removes the DSH preset;
- an interrupted or malformed edit retains the last valid preset catalog.

The plugin emits DSH's `settings/document-updated` refresh signal for the
`agent-preset-registry` namespace after a roster change. The picker updates in
the running application without restarting DSH.

Production profiles set `deferStartupSync: true`. DSH activation completes
first, then the plugin registers dynamic modes and VCP Agent profiles. The
bundle deliberately has no private `Config` schema and validates raw config in
`apply()`; it never loads Schemastery or other internals from the profile's
dependency graph.

Malformed `agent_map.json` or an interrupted editor save never clears the last
valid VCP Agent presets. The snapshot keeps the previous revision and marks it
`stale: true` until the files become readable again.

Optional capability labels live in `agent_capabilities.json`:

```json
{
  "Kerr": ["coding", "git", "powershell", "architecture"],
  "Nova": ["general", "research", "memory"]
}
```

Start from `agent_capabilities.json.example`; the real file is optional.
Labels are exposed in the snapshot and in the VCP Agent picker.
Paths in `agent_map.json` are constrained to the `Agent/` directory.

The Agent picker groups DSH-owned identities and VCP Agents separately. Every
visible description starts with its affiliation, for example
`VCP · Kerr，是 VCP 系统的专职编程 Agent。` or
`DSH · 使用 DSH 自有身份与 VCP 记忆检索能力。`

An optional `agent_descriptions.json` in the VCP root overrides automatic
extraction without changing the Agent prompt:

```json
{
  "Kerr": "负责编码、架构、PowerShell 与 DSH/VCP 工程实施。",
  "Nova": "负责通用分析、研究、记忆整理与协作任务。"
}
```

Descriptions are capped at 120 characters, stripped of VCP placeholders and
line breaks, and never copy the full prompt into DSH. If the optional file is
malformed, `DSHAgentSync` retains the last valid descriptions and reports
`DESCRIPTIONS_INVALID`; it does not hide or rename Agents.

## VCP-side plugins

The portable kit installs three VCP plugins:

- `DSHAgentSync`: Agent catalog, capabilities, diary identity, and snapshot/SSE
  endpoints.
- `DSHBridge`: tool catalog, Agent catalog, renderer capability detection,
  approval preflight, and plugin execution at
  `/api/plugins/DSHBridge`.
- `DSHReverseBridge`: a VCP tool whose every `start` requires VCP's native
  `DSHReverseBridge:command:[=start]` approval rule.

Neither plugin edits `agent_map.json`, AgentAssistant, or another plugin's
roster. They use VCP's normal Bearer authentication and `hasApiRoutes`
extension point.

The DSH model provider intentionally remains on the VCPToolBox route, so
`VCPModelAuto` and the complete VCP chat pipeline remain available. This mode
still relies on the narrow VCP compatibility seams for native `tool_calls`
atomicity and one-time trusted approval grants. The portable archive includes a
separate compatibility installer that checks these seams and modifies them only
when `-CompatibilityMode Apply` or `VcpCompatibility.ps1 -Apply` is requested.

## Safe memory tools

Dual-stack, Omni, deep-work, and dynamic VCP Agent presets register:

- `vcp_memory_policy`: active owner plus allowed read/write folders;
- `vcp_memory_search`: explicit `DailyNoteSearcher` text or BM25 search;
- `vcp_dailynote_create`: `DailyNote` creation with a session-derived owner;
- `vcp_dailynote_update`: unique preflight, post-write verification, and a
  preflighted reverse update when verification fails;
- `vcp_memory_diagnostics`: read-only policy, Rerank, cooldown, circuit, and
  latest-recall diagnostics.

These tools call the existing `/api/plugins/DSHBridge` path and therefore use the
same DSH approval ticket as `vcp_tool_call`. They do not use the community
package's `/admin_api/plugins/*/execute` route.

Write access defaults to `DSH工程档案`, the active VCP Agent, its knowledge
book, `DSH主控`, and `DSH主控的知识`. Additional folders can be configured with
comma-separated `memoryReadFolders` and `memoryWriteFolders`. Path traversal,
slashes, Windows-invalid characters, trailing dots, and trailing spaces are
rejected.

`memoryOwner` defaults to `native`, where VCP native RAG is the sole passive
memory owner. Configuring `enhanced` enables opt-in user-message and/or Todo
boundary recall through read-only bridge calls. `hybrid` also suppresses notes
whose recognizable prefix is already present in the current model messages.
Recall applies a character budget, minimum score, per-session cooldown, and a
circuit breaker after repeated failures. Recalled diary text is marked as
untrusted evidence.

`memoryRerankMode` accepts `off`, `lexical`, `http`, or `auto`; HTTP failures
fall back to lexical ranking. Association groups and the configured intuition
card prefix only adjust ranking.

## Optional Forge integrations

Deep-work can mount already-installed Project Forge and Forge Context packages
when their documented DSH/Cordis ranges match. Project Forge adds its protocol
and string replace editor. Forge Context replaces the deep-work compaction
engine and disables the duplicate tool-result pruner. The installer records
public package versions in profile configuration; runtime code consumes that
configuration without scanning the profile's `node_modules`.

The bundle does not redistribute either package and never imports its private
implementation. Missing or incompatible packages leave the DSH standard
compaction path unchanged.

## Autonomous VCP Agent execution

`vcp_agent_run` delegates a self-contained task to a selected VCP Agent through
the ordinary `/v1/chat/completions` pipeline. VCP expands `{{AgentAlias}}`,
provides the Agent's memory and tool guidance, and executes its VCP tool loop.
DSH receives the final report and backend model metadata.

This lane does not expose individual VCP tool calls or unify VCP-native approvals
into DSH. It is intended for opaque delegated tasks and compatibility fallback,
not for Omni's tool-level audit or strict write-scope enforcement.

## Optional reverse task bridge

`DSHReverseBridge` is the opposite direction and is deliberately asymmetric:

```text
VCP Agent -> VCP tool -> isolated DSH headless process -> structured report
```

It does not click or control the DSH GUI, attach to an existing DSH session, or
enable bidirectional recursion. There is no separate DSH enable switch:
`start` is authorized by VCP's native approval UI on every call. The installer
enables Tool Approval and merges the exact `start` rule while preserving other
approval configuration.

The plugin checks that approval is actually armed before spawning DSH. Missing
approval, disabled Tool Approval, an unavailable manager, or a whitelist that
bypasses the start rule fails closed. `status`, `list`, `capabilities`, and
`doctor` do not prompt.

Tasks run through `dsh --profile vcp-reverse --json`; the profile is created
from the shipped headless template only after an enabled task is first started.
The task bridge returns a durable `jobId` and supports `status`, `list`, and
`cancel`. Stored job records contain a prompt preview and SHA-256 rather than
the complete prompt.

## Portable kit

Build:

```powershell
# from the independent project root
pwsh -File .\tools\Build-PortableKit.ps1
```

The resulting archive contains:

```text
AGENTS.md
docs/STATUS.md
docs/operations/CONFIGURATION_GUIDE.md
docs/contracts/configuration-contract.json
dsh-plugin/
vcp-plugins/DSHAgentSync/
vcp-plugins/DSHBridge/
vcp-plugins/DSHReverseBridge/
vcp-assets/Agent/MingYue.txt
compatibility/VcpCompatibility.ps1
Install-PortableKit.ps1
Start-DshVcpSystem.ps1
tools/Build-PortableKit.ps1
packaging/origin-manifest.json
```

The build also writes a stable copy to
`artifacts/releases/dsh-vcp-omni-kit.zip`. Use the timestamped
archive for an audit trail and the stable path for distribution.

On another machine:

```powershell
pwsh -File .\Install-PortableKit.ps1 `
  -VcpHome "D:\Path\VCPToolBox" `
  -DshHome "$env:USERPROFILE\.dsh"
```

By default the installer only checks compatibility. To apply the three bounded
DSH-isolation seams:

```powershell
pwsh -File .\Install-PortableKit.ps1 `
  -VcpHome "D:\Path\VCPToolBox" `
  -DshHome "$env:USERPROFILE\.dsh" `
  -CompatibilityMode Apply
```

The installer backs up replaced VCP plugins, links the DSH bundle into the
profile, and records the actual VCP path in the profile override. The VCP model
route and its DSH-only `X-DSH-VCP-Origin` header are configured through the
official Custom Model API/advanced profile instructions above, not injected by
the installer. It does not add an Agent to
`Agent/`, `agent_map.json`, or `agent_capabilities.json` unless
`-InstallVcpAssets` is explicitly requested. It is idempotent: rerunning it keeps
one DSH bundle entry, preserves unrelated profile settings, and creates a new
timestamped backup set.

On an otherwise unmodified VCP installation, the default check reports
`base-only`: the model route, Agent sync, DSH tools, unapproved VCP tools, and
optional renderer boundary still work, while protected-tool unified approval and
strict DSH `tool_calls` history protection require explicit compatibility apply.
Native VCP/VCPChat requests carry no `X-DSH-VCP-Origin` header and therefore
continue through the original VCP paths.

## Optional VCPChat renderer

VCPChat is not part of the core request path. DSH, VCPToolBox, Agent prompts,
memory, VCP tools, DSH tools, and AgentAssistant work when VCPChat is not
running. Renderer-only tools such as Loom, game, chart, and interactive preview
surfaces become available only while the corresponding VCPChat distributed node
is connected.

`vcp_capabilities` reports this boundary explicitly: its `core.available` value
is independent of VCPChat, while `optional.vcpChatRendering.requiredForCore` is
always `false`.

The project-root `Start-DshVcpSystem.ps1` starts VCPToolBox and DSH by default.
It checks the configured ports and delegates to VCPToolBox's own launcher only
when needed. Add `-WithVcpChat` only when a task needs VCPChat's special renderer.
`-NoUi` starts only the core backend services.

## Identity boundary

- A synced VCP Agent keeps the VCP alias as its memory book and uses
  `{{AgentAlias}}` as the prompt placeholder.
- A DSH-owned identity uses that identity name as its memory book and is
  explicitly excluded from both `agent_map.json` and the AgentAssistant roster.
- DSH identity names reject Windows-invalid characters, traversal-like names,
  placeholder-breaking characters, trailing dots/spaces, and reserved device names.
- `identity/ensure` creates `dailynote/<identity>` and
  `dailynote/<identity>的知识` through the existing DailyNote path. It does not
  edit `agent_map.json` or AgentAssistant configuration.

## Complementary omni mode

The `vcp-omni` preset mounts `omni-controller.mjs`. It adds a durable project
state machine and these native tools:

- `omni_run`: capture the original goal, DSH-owned identity, and VCP Agent
  catalog revision;
- `omni_plan`: store the DSH-authored plan, task owners, dependencies, write
  scopes, and acceptance criteria;
- `omni_event`: record typed dispatch, submission, unit-review, takeover,
  integration, second-review, final-review, final-fix, or block events;
- `omni_status`: read exact ownership, attempts, review results, blockers, and
  next actions;
- `omni_cancel`: cancel and retain an audit record;
- `omni_identity`: initialize the configured DSH-owned diary identity.

The state machine rejects overlapping active write scopes, unknown VCP Agents,
missing dependency completion, changed files outside a task's scope, reused
review contexts, a third VCP submission, and out-of-order review transitions.
After two failed unit reviews the task enters DSH takeover. Integration can
have at most two second-review rounds; final review allows one DSH final fix,
then the project becomes `BLOCKED`.

The DSH preset owns one long-lived identity name (`DSH主控` by default). Its
system prompt contains raw VCP diary placeholders, so VCP's RAG pipeline expands
`{{DSH主控日记本…}}` and `{{DSH主控的知识日记本…}}`. A different custom DSH
identity should use a separately configured omni preset so the prompt's memory
book name always matches the state's identity name.

Approval flow:

1. The bridge asks VCP whether a call requires manual approval.
2. If required, DSH presents one approval request.
3. The bridge sends a one-time, argument-bound ticket with the call.
4. VCP skips only its duplicate prompt, while retaining all tool existence, policy, safety, and final execution checks.

The DSH permission preset `VCP 智能审批` (`vcp-smart`) uses full file access plus one-time approvals. It is intended for VCP modes: ordinary calls allowed by VCP's whitelist do not prompt, while exceptional calls appear once in DSH.

The VCP endpoint base is `http://127.0.0.1:6005/v1` by default. Authentication resolves the existing `VCPTOOLBOX_API_KEY` through DSH's credential service, so the bridge reuses the same stored secret as the VCP model provider without copying it into configuration.

`vcp_agent_list` exposes VCP chat-agent aliases plus AgentAssistant collaboration agents. `vcp_agent_ask` supports immediate AA contact, Future Call scheduling, asynchronous delegation, delegation query/cancel, temporary contacts, River context, and temporary VCP tool injection.

The four public rule presets and internal VCP execution profiles coexist with
DSH Agent Teams and ordinary subagents. DSH owns engineering delegation and team
coordination; AA remains the VCP-side collaboration bus.
