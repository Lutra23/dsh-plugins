window.__ModuleLoader__.load({
    id: '@local/dsh-vcp-bridge',
    factory(require) {
        const React = require('react');
        const h = React.createElement;
        const RULE_IDS = [
            'vcp-compat',
            'vcp-dual-stack',
            'vcp-omni',
            'vcp-deep-work'
        ];
        const RULE_LABELS = {
            'vcp-compat': 'VCP 兼容模式',
            'vcp-dual-stack': 'DSH/VCP 双栈模式',
            'vcp-omni': '互补全能模式',
            'vcp-deep-work': '深度工程模式'
        };
        const BUILTIN_PRESET_IDS = [
            'standard',
            'ptc',
            'minimal',
            'cordis'
        ];
        const POST_VCP_PRESET_IDS = [
            'project-forge'
        ];
        const BUILTIN_PRESET_LABELS = {
            standard: '标准模式',
            ptc: 'PTC 模式',
            minimal: '极简模式',
            cordis: '创造模式'
        };
        const BUILTIN_PRESET_DESCRIPTIONS = {
            standard: '日常代码、文件和信息任务。',
            ptc: '适合批量调用工具后整理和汇总结果。',
            minimal: '只保留终端与图像读取等基础能力。',
            cordis: '通过对话创建 DSH 插件或自定义预设。'
        };
        const SETTINGS_NAMESPACE = 'vcp-agent-sync';
        const STYLE_PREFIX = 'dsh-vcp-agent-picker-styles';
        const STYLE_ID = `${STYLE_PREFIX}-v3`;

        function installStyles() {
            for (const existing of document.querySelectorAll(
                `style[data-plugin-css^="${STYLE_PREFIX}"]`
            )) {
                existing.remove();
            }
            // Keep every selector plugin-owned. The official model popover,
            // DeepSeek branding, and role=menu surfaces must remain untouched.
            const style = document.createElement('style');
            style.dataset.pluginCss = STYLE_ID;
            style.textContent = `
                .dsh-vcp-picker-row {
                    display: flex;
                    align-items: center;
                    gap: 2px;
                    min-width: 0;
                    max-width: min(100%, 460px);
                }
                .dsh-vcp-picker {
                    position: relative;
                    min-width: 0;
                }
                .dsh-vcp-chip {
                    border: 0;
                    border-radius: var(--dsw-radius-sm);
                    min-width: 0;
                    max-width: 230px;
                    min-height: 28px;
                    padding: 0 8px;
                    color: var(--dsw-alias-label-primary);
                    background: transparent;
                    display: inline-flex;
                    align-items: center;
                    gap: 4px;
                    font: inherit;
                    font-size: 13px;
                    font-weight: 500;
                    line-height: 20px;
                    white-space: nowrap;
                    cursor: pointer;
                }
                .dsh-vcp-chip:hover,
                .dsh-vcp-chip[aria-expanded=true] {
                    background: var(--dsw-alias-interactive-bg-hover);
                }
                .dsh-vcp-chip:focus-visible {
                    outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
                    outline-offset: 1px;
                }
                .dsh-vcp-chip-label {
                    min-width: 0;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .dsh-vcp-chip-meta,
                .dsh-vcp-chip-icon {
                    flex: none;
                    color: var(--dsw-alias-label-tertiary);
                }
                .dsh-vcp-menu {
                    position: absolute;
                    z-index: 40;
                    top: calc(100% + 6px);
                    left: 0;
                    width: min(300px, calc(100vw - 24px));
                    max-height: 360px;
                    overflow: auto;
                    padding: 6px;
                    border: 1px solid var(--dsw-alias-border-l2);
                    border-radius: var(--dsw-radius-lg);
                    background: #393a3e !important;
                    background-image: none !important;
                    opacity: 1 !important;
                    backdrop-filter: none !important;
                    box-shadow: 0 6px 18px rgb(0 0 0 / 24%) !important;
                }
                .dsh-vcp-menu[data-agent-menu=true] {
                    left: auto;
                    right: 0;
                }
                .dsh-vcp-menu-title {
                    padding: 6px 8px 4px;
                    color: var(--dsw-alias-label-caption);
                    font-size: 12px;
                    line-height: 16px;
                }
                .dsh-vcp-menu-item {
                    width: 100%;
                    border: 0;
                    border-radius: var(--dsw-radius-md);
                    padding: 7px 8px;
                    color: var(--dsw-alias-label-primary);
                    background: transparent;
                    display: flex;
                    align-items: flex-start;
                    justify-content: space-between;
                    gap: 8px;
                    text-align: left;
                    cursor: pointer;
                }
                .dsh-vcp-menu-item:hover,
                .dsh-vcp-menu-item[data-selected=true] {
                    background: var(--dsw-alias-interactive-bg-hover);
                }
                .dsh-vcp-menu-item-copy {
                    min-width: 0;
                }
                .dsh-vcp-menu-item-label {
                    display: block;
                    font-size: 13px;
                    font-weight: 500;
                    line-height: 20px;
                }
                .dsh-vcp-menu-item-desc {
                    display: block;
                    margin-top: 1px;
                    color: var(--dsw-alias-label-caption);
                    font-size: 12px;
                    line-height: 16px;
                }
                .dsh-vcp-menu-check {
                    flex: none;
                    color: var(--dsw-alias-state-business-primary);
                    line-height: 20px;
                }
                .dsh-vcp-error {
                    padding: 6px 8px;
                    color: var(--dsw-alias-state-error-primary);
                    font-size: 12px;
                    line-height: 17px;
                }
                @media (max-width: 760px) {
                    .dsh-vcp-picker-row {
                        max-width: min(100%, 300px);
                    }
                    .dsh-vcp-chip {
                        max-width: 145px;
                    }
                }
            `;
            document.head.appendChild(style);
        }

        function unwrapRemoteResult(result) {
            if (
                result
                && typeof result === 'object'
                && typeof result.ok === 'boolean'
                && Object.prototype.hasOwnProperty.call(result, 'value')
            ) {
                if (!result.ok) {
                    throw new Error(result.error?.message || 'DSH remote call failed.');
                }
                return result.value;
            }
            return result;
        }

        function useSessionPreset(ctx, sessionId, stagedRuleId) {
            const read = () => {
                if (!sessionId) return stagedRuleId || null;
                return ctx.sessions.list.getSnapshot()
                    .byId?.[sessionId]
                    ?.projectionValues
                    ?.agentPreset || null;
            };
            return React.useSyncExternalStore(
                callback => ctx.sessions.list.subscribe(callback),
                read,
                read
            );
        }

        function MenuItem({ selected, label, description, onClick }) {
            return h('button', {
                type: 'button',
                className: 'dsh-vcp-menu-item',
                'data-selected': selected === true,
                onClick
            },
            h('span', { className: 'dsh-vcp-menu-item-copy' },
                h('span', { className: 'dsh-vcp-menu-item-label' }, label),
                description
                    ? h('span', { className: 'dsh-vcp-menu-item-desc' }, description)
                    : null
            ),
            selected
                ? h('span', { className: 'dsh-vcp-menu-check', 'aria-hidden': true }, '✓')
                : null);
        }

        function groupRulePresets(presets) {
            const byId = new Map(presets.map(preset => [preset.id, preset]));
            const ordered = ids => ids
                .filter(id => byId.has(id))
                .map(id => byId.get(id));
            const reserved = new Set([
                ...BUILTIN_PRESET_IDS,
                ...RULE_IDS,
                ...POST_VCP_PRESET_IDS
            ]);

            return {
                builtin: ordered(BUILTIN_PRESET_IDS),
                vcp: ordered(RULE_IDS),
                postVcp: ordered(POST_VCP_PRESET_IDS),
                custom: presets.filter(preset => !reserved.has(preset.id)),
            };
        }

        function CombinedPicker({ sessionId, ctx }) {
            const [openMenu, setOpenMenu] = React.useState(null);
            const [presets, setPresets] = React.useState([]);
            const [agentState, setAgentState] = React.useState({
                selectedAgent: '',
                revision: undefined
            });
            const [stagedRuleId, setStagedRuleId] = React.useState('');
            const [error, setError] = React.useState('');
            const [busy, setBusy] = React.useState(false);
            const [connectionReady, setConnectionReady] = React.useState(
                Boolean(ctx.connection.generation.getSnapshot())
            );
            const stagedApplied = React.useRef('');
            const currentPresetId = useSessionPreset(ctx, sessionId, stagedRuleId);

            const loadPresets = React.useCallback(async () => {
                if (!ctx.connection.generation.getSnapshot()) {
                    setPresets([]);
                    return;
                }
                try {
                    const result = unwrapRemoteResult(
                        await ctx.remote.agentPresets.list()
                    );
                    if (Array.isArray(result?.presets)) {
                        setPresets(result.presets);
                    } else {
                        setPresets([]);
                        setError('DSH Agent preset registry returned an unexpected response.');
                    }
                } catch (loadError) {
                    setError(loadError?.message || String(loadError));
                }
            }, [ctx]);

            const loadAgents = React.useCallback(async () => {
                if (!ctx.connection.generation.getSnapshot()) {
                    setAgentState({ selectedAgent: '', revision: undefined });
                    return;
                }
                try {
                    const result = unwrapRemoteResult(
                        await ctx.remote.settings.describe()
                    );
                    const namespace = (result?.namespaces || [])
                        .find(item => item.ns === SETTINGS_NAMESPACE);
                    if (!namespace) {
                        throw new Error(
                            `DSH settings namespace "${SETTINGS_NAMESPACE}" is unavailable.`
                        );
                    }
                    setAgentState({
                        selectedAgent: namespace.value?.selectedAgent || '',
                        revision: namespace.revision
                    });
                } catch (loadError) {
                    setError(loadError?.message || String(loadError));
                }
            }, []);

            React.useEffect(() => {
                installStyles();
                void loadPresets();
                void loadAgents();
            }, [loadPresets, loadAgents]);

            React.useEffect(() => {
                const refreshConnection = () => {
                    const ready = Boolean(ctx.connection.generation.getSnapshot());
                    setConnectionReady(ready);
                    if (ready) {
                        void loadPresets();
                        void loadAgents();
                    }
                };
                const unsubscribe = ctx.connection.generation.subscribe(refreshConnection);
                refreshConnection();
                return unsubscribe;
            }, [ctx, loadPresets, loadAgents]);

            React.useEffect(() => {
                if (
                    !sessionId
                    || !stagedRuleId
                    || stagedApplied.current === `${sessionId}:${stagedRuleId}`
                ) return;
                stagedApplied.current = `${sessionId}:${stagedRuleId}`;
                setBusy(true);
                void (async () => {
                    try {
                        unwrapRemoteResult(
                            await ctx.remote.agentPresets.select(sessionId, stagedRuleId)
                        );
                    } catch (selectError) {
                        stagedApplied.current = '';
                        setError(selectError?.message || String(selectError));
                    } finally {
                        setBusy(false);
                    }
                })();
            }, [ctx, sessionId, stagedRuleId]);

            React.useEffect(() => {
                if (!openMenu) return undefined;
                const close = event => {
                    if (event.type === 'keydown' && event.key !== 'Escape') return;
                    if (event.type === 'pointerdown' && event.target?.closest?.('.dsh-vcp-picker')) {
                        return;
                    }
                    setOpenMenu(null);
                };
                window.addEventListener('pointerdown', close);
                window.addEventListener('keydown', close);
                return () => {
                    window.removeEventListener('pointerdown', close);
                    window.removeEventListener('keydown', close);
                };
            }, [openMenu]);

            const allRuleOptions = React.useMemo(() => {
                return presets.filter(preset =>
                    preset?.id
                    && preset.broken === undefined
                    && !String(preset.id).startsWith('vcp-agent-')
                );
            }, [presets]);
            const ruleGroups = React.useMemo(
                () => groupRulePresets(allRuleOptions),
                [allRuleOptions]
            );

            const agentOptions = React.useMemo(() => {
                return presets
                    .filter(preset => String(preset.id).startsWith('vcp-agent-'))
                    .map(preset => ({
                        alias: preset.name,
                        presetId: preset.id,
                        description: preset.description || '',
                        affiliation: preset.affiliation
                            || (/^(DSH|VCP)\s*·/u.exec(preset.description || '')?.[1] || 'VCP')
                    }));
            }, [presets]);

            const defaultPreset = presets.find(preset => preset.isDefault === true);
            const effectivePresetId = currentPresetId || defaultPreset?.id || '';
            const currentRule = presets.find(preset => preset.id === effectivePresetId);
            const ruleLabel = currentRule?.name
                || BUILTIN_PRESET_LABELS[effectivePresetId]
                || RULE_LABELS[effectivePresetId]
                || effectivePresetId
                || '加载预设…';
            const agentLabel = agentState.selectedAgent || '自动匹配';
            const ruleDescription = preset =>
                preset.description
                || BUILTIN_PRESET_DESCRIPTIONS[preset.id]
                || (RULE_IDS.includes(preset.id) ? 'VCP 组合模式' : '');

            async function chooseRule(preset) {
                setError('');
                setOpenMenu(null);
                if (!sessionId) {
                    setStagedRuleId(preset.id);
                    return;
                }
                setBusy(true);
                try {
                    unwrapRemoteResult(
                        await ctx.remote.agentPresets.select(sessionId, preset.id)
                    );
                } catch (selectError) {
                    setError(selectError?.message || String(selectError));
                } finally {
                    setBusy(false);
                }
            }

            async function chooseAgent(alias) {
                setError('');
                setOpenMenu(null);
                setBusy(true);
                try {
                    const result = unwrapRemoteResult(
                        await ctx.remote.settings.update(
                            SETTINGS_NAMESPACE,
                            { selectedAgent: alias },
                            agentState.revision
                        )
                    );
                    setAgentState({
                        selectedAgent: result?.value?.selectedAgent || alias,
                        revision: result?.revision ?? agentState.revision
                    });
                } catch (writeError) {
                    setError(writeError?.message || String(writeError));
                } finally {
                    setBusy(false);
                }
            }

            const chip = (kind, icon, label, meta) => h('button', {
                type: 'button',
                className: 'dsh-vcp-chip',
                'aria-haspopup': 'menu',
                'aria-expanded': openMenu === kind,
                disabled: busy,
                onClick: event => {
                    event.stopPropagation();
                    setError('');
                    setOpenMenu(current => current === kind ? null : kind);
                    if (kind === 'rule') void loadPresets();
                    else void loadAgents();
                }
            },
            h('span', { className: 'dsh-vcp-chip-icon', 'aria-hidden': true }, icon),
            h('span', { className: 'dsh-vcp-chip-label' }, label),
            h('span', { className: 'dsh-vcp-chip-meta', 'aria-hidden': true }, meta || '⌄'));

            return h('div', { className: 'dsh-vcp-picker-row' },
                h('div', { className: 'dsh-vcp-picker' },
                    chip('rule', '◈', ruleLabel),
                    openMenu === 'rule'
                        ? h('div', { className: 'dsh-vcp-menu', role: 'menu' },
                            h('div', { className: 'dsh-vcp-menu-title' }, '官方内置'),
                            ruleGroups.builtin.map(preset => h(MenuItem, {
                                key: preset.id,
                                selected: preset.id === effectivePresetId,
                                label: preset.name
                                    || BUILTIN_PRESET_LABELS[preset.id]
                                    || preset.id,
                                description: ruleDescription(preset),
                                onClick: () => void chooseRule(preset)
                            })),
                            ruleGroups.vcp.length > 0
                                ? h('div', { className: 'dsh-vcp-menu-title' }, 'VCP 组合模式')
                                : null,
                            ruleGroups.vcp.map(preset => h(MenuItem, {
                                key: preset.id,
                                selected: preset.id === effectivePresetId,
                                label: preset.name || RULE_LABELS[preset.id] || preset.id,
                                description: ruleDescription(preset),
                                onClick: () => void chooseRule(preset)
                            })),
                            ruleGroups.postVcp.length > 0
                                ? h('div', { className: 'dsh-vcp-menu-title' }, '扩展模式')
                                : null,
                            ruleGroups.postVcp.map(preset => h(MenuItem, {
                                key: preset.id,
                                selected: preset.id === effectivePresetId,
                                label: preset.name || preset.id,
                                description: ruleDescription(preset),
                                onClick: () => void chooseRule(preset)
                            })),
                            ruleGroups.custom.length > 0
                                ? h('div', { className: 'dsh-vcp-menu-title' }, '其他自定义')
                                : null,
                            ruleGroups.custom.map(preset => h(MenuItem, {
                                key: preset.id,
                                selected: preset.id === effectivePresetId,
                                label: preset.name || preset.id,
                                description: ruleDescription(preset),
                                onClick: () => void chooseRule(preset)
                            })),
                            allRuleOptions.length === 0
                                ? h('div', { className: 'dsh-vcp-error' },
                                    !connectionReady
                                        ? 'DSH Host 正在连接，预设列表稍后自动刷新。'
                                        : presets.length === 0
                                            ? '预设列表为空；请确认 DSH/VCP 插件已启动并完成同步。'
                                            : `没有可用预设；已收到 ${presets.length} 项：${presets.map(preset => preset.id).slice(0, 8).join(', ')}`)
                                : null,
                            error ? h('div', { className: 'dsh-vcp-error' }, error) : null
                        )
                        : null
                ),
                h('div', { className: 'dsh-vcp-picker' },
                    chip('agent', '◎', agentLabel),
                    openMenu === 'agent'
                        ? h('div', {
                            className: 'dsh-vcp-menu',
                            role: 'menu',
                            'data-agent-menu': 'true'
                        },
                        h('div', { className: 'dsh-vcp-menu-title' }, 'DSH 智能体'),
                        h(MenuItem, {
                            selected: !agentState.selectedAgent,
                            label: '自动匹配 / 不绑定',
                            description: 'DSH · 互补全能模式由 DSH 自动选择；其他模式保持 DSH 原生身份。',
                            onClick: () => void chooseAgent('')
                        }),
                        agentOptions.some(agent => agent.affiliation === 'DSH')
                            ? agentOptions
                                .filter(agent => agent.affiliation === 'DSH')
                                .map(agent => h(MenuItem, {
                                    key: agent.alias,
                                    selected: agent.alias === agentState.selectedAgent,
                                    label: agent.alias,
                                    description: agent.description
                                        || 'DSH · 使用 DSH 自有身份与 VCP 记忆检索能力。',
                                    onClick: () => void chooseAgent(agent.alias)
                                }))
                            : null,
                        h('div', { className: 'dsh-vcp-menu-title' }, 'VCP 智能体'),
                        agentOptions
                            .filter(agent => agent.affiliation !== 'DSH')
                            .map(agent => h(MenuItem, {
                            key: agent.alias,
                            selected: agent.alias === agentState.selectedAgent,
                            label: agent.alias,
                            description: agent.description
                                || 'VCP · 通过 VCPToolBox 使用专用提示词、记忆与工具能力。',
                            onClick: () => void chooseAgent(agent.alias)
                        })),
                        error ? h('div', { className: 'dsh-vcp-error' }, error) : null
                        )
                        : null
                )
            );
        }

        return {
            inject: [
                'slots',
                'remote',
                'remote.agentPresets',
                'remote.settings',
                'sessions',
                'connection'
            ],
            apply(ctx) {
                installStyles();
                ctx.slots.inject('conversation.hero.agentPreset', () =>
                    ctx.slots.register({
                        name: 'conversation.hero.agentPreset',
                        priority: -10
                    }, props => h(CombinedPicker, { ...props, ctx }))
                );
            }
        };
    }
});
