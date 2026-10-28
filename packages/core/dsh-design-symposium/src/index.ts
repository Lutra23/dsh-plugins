/**
 * dsh-design-symposium — 设计研讨会插件：多席位立场研讨，主席收敛设计纪要。
 *
 * The plugin is a `bundle` row: the Harness loads this module, calls
 * {@link apply}, and everything registered here is disposed with the plugin's
 * fiber. There is deliberately no module-level mutable state.
 *
 * What it publishes:
 *   - the `symposium` Cordis service (ctx.symposium), consumed by the agent tools;
 *   - four agent tools (`symposium_start` / `symposium_status` /
 *     `symposium_report` / `symposium_config`);
 *   - one system-prompt section describing the capability and its boundaries.
 *
 * @module dsh-design-symposium
 */

import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { BOUNDARY_CLAUSE } from './symposium.js';
import { SymposiumEndpoints } from './service.js';
import { registerSymposiumRoutes, type RouteCarrier } from './routes.js';
import { registerSymposiumTools } from './tools.js';

/** Plugin name, also the Loader row id used by `cordis.patch.yml`. */
export const name = 'symposium';

/**
 * The plugin cannot do anything without the LLM service, and it must not
 * activate in a profile that has none.
 */
export const inject = ['llm'];

/** Composition-level knobs. Everything the *user* tunes lives in `symposium.json`. */
export interface Config {
  /** Register the three agent tools. */
  exposeTools: boolean;
  /** Contribute a system-prompt section describing the symposium and its roster. */
  injectPromptSection: boolean;
  /**
   * Order of that section. 0 is the deployment persona; 1 puts the symposium
   * notice immediately after it, which is the high-priority slot personas are
   * meant to occupy.
   */
  promptOrder: number;
}

/** Schema for the Loader row's `config`. */
export const Config: Schema<Config> = Schema.object({
  exposeTools: Schema.boolean().default(true)
    .description('是否注册 symposium_start / symposium_status / symposium_report / symposium_config 四个工具。'),
  injectPromptSection: Schema.boolean().default(true)
    .description('是否向 system prompt 注入研讨会说明与贤者立场摘要。'),
  promptOrder: Schema.number().default(1)
    .description('该 prompt 段落的位置；0 是部署人格，1 紧跟其后。'),
});

/**
 * The compliance statement the plugin logs at startup, as required for a
 * plugin that orchestrates model-to-model argument.
 */
export const COMPLIANCE_NOTICE = [
  '[symposium] 合规约束声明：',
  '  · 本插件只做多模型立场研讨，严禁生成或讨论任何敏感、违法、危害国家安全或破坏社会稳定的内容；',
  '  · 每次发言都按用户配置的词库与正则做一次敏感内容扫描，命中即替换为 [内容已过滤] 并记入异常记录；',
  '  · 命中次数超过阈值时立即终止研讨，并在纪要中标记终止原因；',
  '  · 每位贤者的 system prompt 都强制附加不可被对话覆盖的边界声明；',
  '  · Provider 与 API Key 全部沿用 DSH 自身的模型配置与凭据库，本插件不落盘任何密钥。',
].join('\n');

/** Cordis service key the operations are provided under. */
export const SERVICE_KEY = 'symposium';


/**
 * Build the system-prompt section text for the current configuration.
 * Personas are summarized, never injected verbatim: the agent does not speak
 * them, and a full persona dump would compete with the real prompt.
 * @param service - the operations object, read for the current roster.
 * @returns the section text, or `''` when there is no roster to announce.
 */
function promptSectionText(service: SymposiumEndpoints): string {
  const roster = service.rosterSnapshot();
  if (roster.length === 0) return '';
  const lines = [
    '## 设计研讨会（dsh-design-symposium）',
    '',
    '本机已启用设计研讨会能力。用户配置了以下贤者席位，可以用 `symposium_start` 让他们就同一议题多轮研讨：',
    ...roster.map((entry) =>
      `- ${entry.name}（${entry.provider}/${entry.model}）${entry.personaHint.length > 0 ? `：${entry.personaHint}` : ''}`),
    '',
    '规则：首轮盲评（各席独立意见书互不可见），第二轮起全员共享历史发言；每轮发言末尾输出立场声明（坚持/修正/让步）；'
    + '讨论结束后由主席把发言收敛为设计纪要（一致点 / 分歧 / 否决方案 / 建议决策 / 术语定名），输出 Markdown 纪要。'
    + '成本按 dsh-cost-meter 真实账本归因，无法归因者如实标注（无数据 ≠ 零成本）。',
    '调用方可在 symposium.json 或 start 参数中提供议题包（topic + background + materials 工程材料）。',
    '在用户明确要求发起研讨会之前，不要主动启动它。',
    '',
    BOUNDARY_CLAUSE,
  ];
  return lines.join('\n');
}

/**
 * Plugin entry point.
 * @param ctx - the owning context; every registration is disposed with it.
 * @param config - the validated Loader row configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  console.log(COMPLIANCE_NOTICE);

  const service = new SymposiumEndpoints(ctx, ctx.llm);
  ctx.provide(SERVICE_KEY, service);
  console.log(`[symposium] 服务已注册为 ctx.${SERVICE_KEY}`);

  if (config?.exposeTools !== false) {
    ctx.inject(['tools'], (toolCtx) => {
      const disposers = registerSymposiumTools(toolCtx, service, toolCtx.tools);
      toolCtx.effect(() => () => {
        for (const dispose of disposers.reverse()) dispose();
      }, 'symposium: tools');
      console.log('[symposium] 已注册工具 symposium_start / symposium_status / symposium_report / symposium_answer / symposium_config / symposium_journal');
    });
  }

  if (config?.injectPromptSection !== false) {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      promptCtx.systemPrompt.section({
        name: 'symposium:sages',
        order: Number.isFinite(config?.promptOrder) ? config.promptOrder : 1,
        text: () => promptSectionText(service),
      });
      console.log('[symposium] 已注入 system prompt 段落 symposium:sages');
    });
  }

  // The live panel rides the Connection carrier as a scoped dependency: a
  // profile without it still loads the plugin, only the page goes missing.
  ctx.inject(['connection'], (scope) => {
    const scoped = scope as { get?: (name: string) => unknown };
    const carrier = typeof scoped.get === 'function'
      ? scoped.get('connection') as { fetch?: RouteCarrier } | undefined
      : undefined;
    const fetch = carrier?.fetch;
    if (fetch === undefined) return;
    scope.effect(() => registerSymposiumRoutes(fetch, service), 'symposium: live routes');
    console.log('[symposium] 研讨现场页面已挂载：/api/plugins/dsh-design-symposium/panel');
  });

  // Read the roster once at startup so a broken document is reported in the log
  // rather than at the moment the user presses 开始讨论.
  const roster = service.rosterSnapshot();
  console.log(`[symposium] 已加载 ${roster.length} 位贤者：${roster.map((entry) => entry.name).join('、') || '（无，请在 symposium.json 配置）'}`);
  console.log(`[symposium] 配置文件 ${service.configPathSnapshot()}；人格镜像 ${service.personaDirSnapshot()}`);

  // P2 recovery: a paused discussion survives a restart, and a run whose file
  // still says `running` can only be one the process died inside.
  void service.recover().then((paused) => {
    if (paused !== undefined) {
      console.log(`[symposium] 有一场研讨在等待求证答案：${paused.pendingQuestions?.map((item) => item.qid).join('、') ?? ''}`);
    }
  }).catch((error: unknown) => {
    console.warn(`[symposium] 启动恢复失败：${(error as Error).message}`);
  });
}
