/**
 * dsh-chat-rewind — browser half.
 *
 * Adds per-turn rewind controls to the chat transcript by registering an
 * entry in the official `conversation.chat.turnTail` slot (rendered once per
 * turn tail with { turn, seq }).
 *
 * Semantics: "rewind" is a FORK, not a mutation. It calls the official
 * ctx.sessions.fork({ sessionId, atSeq, increaseTitle: true }) with the
 * boundary set to the last event BEFORE the target turn's turn/start, then
 * opens the child session. The source log is never touched: compaction
 * checkpoints, shadowed ranges, and per-session tidy state stay consistent.
 * The boundary always sits at a turn edge, which can never fall inside an
 * open compaction transaction (those live strictly inside an open turn).
 *
 * Edit-resend additionally replays the edited user text into the child via
 * remote.session.prompt.
 */
window.__ModuleLoader__.load({
  id: "@local/dsh-chat-rewind",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    const NS = "rewind";

    // Official icon primitives (resident in the browser module table — the
    // official locale and message-feedback packages require it bare). Kept
    // defensive: a missing icon must never take the whole plugin down; the
    // literal glyphs serve as fallback.
    let iconEdit = null;
    let iconClock = null;
    let iconRefresh = null;
    try {
      const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
      iconEdit = primitives?.IconEditOutlineRegular ?? null;
      iconClock = primitives?.IconClockOutlineRegular ?? null;
      iconRefresh = primitives?.IconRefreshOutlineRegular ?? null;
    } catch {
      // module table mismatch — fall back to literal glyphs
    }
    const zh = {
      "rewind.edit": "编辑重发",
      "rewind.rewind": "撤回到此",
      "rewind.editTitle": "编辑这一轮的提问并撤回之后的对话（在新对话中继续）",
      "rewind.rewindTitle": "丢弃这一轮之后的对话，从这里重新开始（新对话）",
      "rewind.regen": "重新生成",
      "rewind.regenTitle": "用这一轮的原始提问重新跑一遍，生成新的回答（新对话）",
      "rewind.regenConfirm": "将新开一个对话，用这一轮的原始提问重新生成回答。\n\n注意：这一轮会整轮重跑（含工具调用），工具可能重复执行并产生新的副作用；已产生的文件等改动不会回滚，原对话会归档。\n\n确定重新生成？",
      "rewind.regenEmpty": "这一轮没有可重发的文本（可能只有图片或附件），无法重新生成",
      "rewind.regenBusy": "重新生成中…",
      "rewind.dialog.title": "编辑消息并撤回后续对话",
      "rewind.dialog.hint": "将从这一轮之前分叉出新对话继续；已产生的文件等外部改动不受影响。",
      "rewind.dialog.resend": "重发到新对话",
      "rewind.dialog.rewindOnly": "仅撤回",
      "rewind.dialog.cancel": "取消",
      "rewind.dialog.placeholder": "这一轮没有可编辑的用户消息",
      "rewind.confirm": "将丢弃这一轮之后的对话，从新对话继续。已产生的文件等外部改动不受影响。\n\n确定撤回？",
      "rewind.busy": "撤回中…",
      "rewind.incomplete": "这一轮尚未完成，暂时不能撤回",
      "rewind.failed": "撤回失败",
      "rewind.dialog.model": "发送模型",
      "rewind.dialog.modelFollow": "跟随原对话",
      "rewind.dialog.modelFailed": "模型列表不可用",
      "rewind.dialog.effort": "推理强度",
      "rewind.dialog.effortDefault": "默认",
    };
    const en = {
      "rewind.edit": "Edit & resend",
      "rewind.rewind": "Rewind here",
      "rewind.editTitle": "Edit this turn's prompt and rewind the rest (continues in a new conversation)",
      "rewind.rewindTitle": "Discard everything after this turn and restart here (new conversation)",
      "rewind.regen": "Regenerate",
      "rewind.regenTitle": "Re-run this turn with its original prompt and generate a new answer (new conversation)",
      "rewind.regenConfirm": "A new conversation will start and re-run this turn with the original prompt.\n\nNote: the whole turn runs again (tool calls included), so tools may execute twice and produce fresh side effects; existing file changes are NOT rolled back, and the source conversation is archived.\n\nRegenerate now?",
      "rewind.regenEmpty": "This turn has no text to resend (image/attachment only), so it cannot be regenerated",
      "rewind.regenBusy": "Regenerating…",
      "rewind.dialog.title": "Edit message and rewind the rest",
      "rewind.dialog.hint": "Forks a new conversation from before this turn; external side effects (files etc.) are kept.",
      "rewind.dialog.resend": "Resend into new chat",
      "rewind.dialog.rewindOnly": "Rewind only",
      "rewind.dialog.cancel": "Cancel",
      "rewind.dialog.placeholder": "(no editable user message in this turn)",
      "rewind.confirm": "Discards the conversation after this turn and continues in a new chat. External side effects are kept.\n\nRewind now?",
      "rewind.busy": "Rewinding…",
      "rewind.incomplete": "This turn is not completed yet",
      "rewind.failed": "Rewind failed",
      "rewind.dialog.model": "Send with model",
      "rewind.dialog.modelFollow": "Follow original conversation",
      "rewind.dialog.modelFailed": "Model list unavailable",
      "rewind.dialog.effort": "Reasoning effort",
      "rewind.dialog.effortDefault": "Default",
    };

    /** Required services (verified against the official ui-chat package). */
    const inject = ["slots", "sessions", "uiWorkspace", "locale", "remote", "remote.session", "remote.workspace"];

    const MAX_PAGES = 8;
    const PAGE_MESSAGES = 24;

    function textOfContent(content) {
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content
          .filter((block) => block && block.type === "text" && typeof block.text === "string")
          .map((block) => block.text)
          .join("\n");
      }
      return "";
    }

    function userMessageText(event) {
      // user/message persists the message body bare; the wire event may wrap
      // it once more. Accept both shapes.
      const message = event?.data?.message ?? event?.data;
      return textOfContent(message?.content ?? message);
    }

    /**
     * Scan the accumulated event window for the target turn's rewind plan.
     * Returns null when the window does not reach the turn's turn/start.
     * The boundary (turn/start - 1) always sits at a turn edge — never inside
     * an open compaction transaction. A completed turn/end is NOT required:
     * an open turn forks with official synthetic closers.
     */
    function planFromEvents(events, turn, tailSeq) {
      // props.turn arrives as a Location object (observed [object Object]),
      // so the turn NUMBER is unreliable — tailSeq is the single source of
      // truth: the turn tail sits at the end of its own turn, whose
      // turn/start is the LAST one at/below tailSeq in the window.
      let turnStart = null;
      for (const event of events) {
        if (event.seq > tailSeq) break;
        if (event.type === "turn/start") turnStart = event;
      }
      if (turnStart === null) return null;
      let userText = "";
      for (const event of events) {
        if (event.seq <= turnStart.seq) continue;
        if (event.seq > tailSeq) break;
        // surfaceOp "append" excludes compaction checkpoints (those carry a
        // replace op). Skip text-less user messages (image/attachment only)
        // so a later text-bearing prompt can still be edited or regenerated.
        if (event.type === "user/message" && event.surfaceOp === "append") {
          const one = userMessageText(event);
          if (one.trim().length > 0) {
            userText = one;
            break;
          }
        }
      }
      // Boundary choice: the target turn's inbox queue splice sits BEFORE
      // its turn/start. Cutting at turn/start - 1 inherits that half-dead
      // queue entry into the child, whose agent delivers it AND the resent
      // text — observed as a duplicate message (child log seq 261/264/268/277).
      // Cut instead at the PREVIOUS turn's turn/end so the whole inter-turn
      // gap (queue splices included) is excluded; for the first turn fall
      // back to just before its first splice.
      let prevTurnEnd = null;
      let firstSpliceInTargetTurn = null;
      for (const event of events) {
        if (event.seq >= turnStart.seq) break;
        if (event.type === "turn/end") prevTurnEnd = event;
        if (event.type === "agent/inbox/spliced" && event.seq > (prevTurnEnd?.seq ?? -1)) {
          if (firstSpliceInTargetTurn === null) firstSpliceInTargetTurn = event;
        }
      }
      let boundarySeq;
      let windowComplete;
      if (prevTurnEnd !== null) {
        boundarySeq = prevTurnEnd.seq;
        windowComplete = true;
      } else if (firstSpliceInTargetTurn !== null) {
        boundarySeq = firstSpliceInTargetTurn.seq - 1;
        windowComplete = true;
      } else {
        boundarySeq = turnStart.seq - 1;
        // Without a turn/end or splice above turnStart we cannot tell an
        // empty first-turn gap from an un-paged earlier window.
        windowComplete = false;
      }
      return { boundarySeq, userText, windowComplete };
    }
    /** Cold-read the transcript backwards until the turn plan is complete. */
    async function rewindPlan(remote, sessionId, turn, tailSeq) {
      let beforeSeq;
      let lastFirstSeq;
      let accumulated = [];
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const request = {
          address: { kind: "session", sessionId },
          throughSeq: tailSeq,
          maxMessages: PAGE_MESSAGES,
          ...(beforeSeq === undefined ? {} : { beforeSeq }),
        };
        const carried = await remote.session.page(request);
        if (carried === null || carried === undefined || carried.ok === false) {
          const message = carried?.error?.message ?? String(carried?.error ?? "page failed");
          throw new Error(message);
        }
        const events = (carried.value?.records ?? [])
          .map((record) => record?.event)
          .filter(Boolean)
          .sort((a, b) => a.seq - b.seq);
        if (events.length === 0) break;
        // Pages may split a turn/start from its user message: match against
        // the accumulated window, not the single page.
        accumulated = events.concat(accumulated);
        const plan = planFromEvents(accumulated, turn, tailSeq);
        // Keep paging until the boundary evidence (previous turn/end or the
        // turn's first splice) entered the window, or the log head is reached.
        if (plan !== null && (plan.windowComplete || carried.value?.hasMore !== true)) return plan;
        const firstSeq = events[0].seq;
        if (carried.value?.hasMore !== true) break;
        // The seq-0 session header may lack a seq field; a repeated or
        // non-integer cursor means further paging cannot make progress.
        if (!Number.isInteger(firstSeq) || firstSeq === lastFirstSeq) break;
        lastFirstSeq = firstSeq;
        beforeSeq = firstSeq;
      }
      throw new Error(`turn not matched (turn=${turn}, tailSeq=${tailSeq})`);
    }
    /** fork → (optional model) → (optional prompt) → openSession. Never touches the source log. */
    async function executeRewind(ctx, sessionId, boundarySeq, resendText, modelChoice) {
      const childId = await ctx.sessions.fork({ sessionId, atSeq: boundarySeq, increaseTitle: true });
      if (modelChoice !== null && modelChoice !== undefined) {
        const carried = await ctx.remote.session.selectModel({
          sessionId: childId,
          provider: modelChoice.provider,
          model: modelChoice.model,
          ...(modelChoice.reasoningEffort === undefined ? {} : { reasoningEffort: modelChoice.reasoningEffort }),
        });
        if (carried !== null && carried !== undefined && carried.ok === false) {
          throw new Error(`selectModel failed (provider=${modelChoice.provider}, model=${modelChoice.model}): ${carried.error?.message ?? "unknown error"}`);
        }
      }
      if (typeof resendText === "string" && resendText.trim().length > 0) {
        const carried = await ctx.remote.session.prompt({
          requestId: crypto.randomUUID(),
          sessionId: childId,
          mode: "queue",
          content: [{ type: "text", text: resendText }],
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
        if (carried !== null && carried !== undefined && carried.ok === false) {
          throw new Error(carried.error?.message ?? "prompt failed");
        }
      }
      await ctx.uiWorkspace.openSession(childId);
      // Auto-archive the source session (approved default): the fork already
      // preserved everything, this just keeps the session list clean.
      // Non-fatal — the rewind itself has succeeded at this point.
      try {
        const carried = await ctx.remote.workspace.archiveSession({ sessionId, stopActivity: true });
        if (carried !== null && carried !== undefined && carried.ok === false) {
          console.error("[dsh-chat-rewind] auto-archive failed:", carried.error?.message ?? carried.error);
        }
      } catch (e) {
        console.error("[dsh-chat-rewind] auto-archive failed:", e);
      }
      return childId;
    }

    /* ------------------------------------------------------------------ */
    /* Styling: minimal inline styles on host CSS variables so the control */
    /* inherits the active theme (light/dark) without external CSS.        */
    /* ------------------------------------------------------------------ */

    const buttonStyle = {
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
      height: "24px",
      padding: "0 8px",
      border: "1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.35))",
      borderRadius: "var(--dsw-radius-sm, 6px)",
      background: "var(--dsw-alias-bg-panel, rgba(128,128,128,.08))",
      color: "var(--dsw-alias-label-secondary, inherit)",
      font: "inherit",
      fontSize: "12px",
      lineHeight: "20px",
      cursor: "pointer",
    };
    const buttonHoverStyle = {
      ...buttonStyle,
      background: "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.18))",
      color: "var(--dsw-alias-label-primary, inherit)",
    };
    const buttonDisabledStyle = {
      ...buttonStyle,
      opacity: ".4",
      cursor: "default",
    };
    const overlayStyle = {
      position: "fixed",
      inset: "0",
      zIndex: "90",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "rgba(0,0,0,.35)",
    };
    const dialogStyle = {
      display: "flex",
      flexDirection: "column",
      gap: "12px",
      width: "min(560px, calc(100vw - 48px))",
      maxHeight: "calc(100vh - 96px)",
      padding: "20px",
      border: "1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.35))",
      borderRadius: "var(--dsw-radius-panel, 12px)",
      background: "var(--dsw-alias-bg-panel, #fff)",
      color: "var(--dsw-alias-label-primary, inherit)",
      boxShadow: "0 16px 48px rgba(0,0,0,.24)",
    };
    const textareaStyle = {
      width: "100%",
      minHeight: "140px",
      maxHeight: "40vh",
      padding: "10px",
      border: "1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.35))",
      borderRadius: "var(--dsw-radius-sm, 6px)",
      background: "var(--dsw-alias-interactive-bg, transparent)",
      color: "var(--dsw-alias-label-primary, inherit)",
      font: "inherit",
      fontSize: "13px",
      lineHeight: "20px",
      resize: "vertical",
      boxSizing: "border-box",
    };
    const selectStyle = {
      padding: "4px 8px",
      border: "1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.35))",
      borderRadius: "var(--dsw-radius-sm, 6px)",
      background: "var(--dsw-alias-interactive-bg, transparent)",
      color: "var(--dsw-alias-label-primary, inherit)",
      font: "inherit",
      fontSize: "13px",
      lineHeight: "20px",
    };
    const primaryButtonStyle = {
      ...buttonHoverStyle,
      border: "1px solid var(--dsw-alias-state-business-primary, #247bbf)",
      background: "var(--dsw-alias-state-business-primary, #247bbf)",
      color: "var(--dsw-alias-label-invert, #fff)",
    };
    const hintStyle = {
      fontSize: "12px",
      lineHeight: "18px",
      color: "var(--dsw-alias-label-tertiary, rgba(128,128,128,.9))",
    };
    const titleStyle = {
      margin: "0",
      fontSize: "15px",
      fontWeight: "600",
    };
    const dialogRowStyle = {
      display: "flex",
      gap: "8px",
      justifyContent: "flex-end",
      flexWrap: "wrap",
    };
    const errorStyle = {
      ...hintStyle,
      color: "var(--dsw-alias-state-danger, #d54545)",
    };

    /* ------------------------------------------------------------------ */
    /* Edit dialog                                                         */
    /* ------------------------------------------------------------------ */

    function EditDialog({ plan, busy, error, t, catalogApi, onResend, onRewindOnly, onCancel }) {
      const [text, setText] = React.useState(plan.userText);
      // Model selection: flat option list built from the official modelCatalog.
      // null = loading, [] = unavailable, [...] = ready.
      const [options, setOptions] = React.useState(null);
      const [selectedIdx, setSelectedIdx] = React.useState(-1); // -1 = follow original
      const [effort, setEffort] = React.useState("");
      React.useEffect(() => {
        let alive = true;
        Promise.resolve()
          .then(() => catalogApi.catalog())
          .then((carried) => {
            if (!alive) return;
            const value = carried !== null && carried !== undefined && carried.ok === false ? null : carried?.value;
            const list = [];
            for (const group of value?.groups ?? []) {
              for (const model of group?.models ?? []) {
                // group.id IS the runtime provider id; model.id is the FULL
                // route model name (e.g. provider "newapi" serves model
                // "hun/deepseek-v4.1-flash" — verified against live
                // request/context logs). Never split on "/".
                list.push({
                  provider: group?.id ?? value?.default?.provider ?? "",
                  model: model.id,
                  name: model.name || model.id,
                  reasoning: model.reasoning ?? null,
                });
              }
            }
            setOptions(list);
          })
          .catch((e) => { console.error("[dsh-chat-rewind] modelCatalog failed", e); if (alive) setOptions([]); });
        return () => { alive = false; };
      }, [catalogApi]);
      const modelChoice = selectedIdx >= 0 && options !== null && selectedIdx < options.length
        ? {
            provider: options[selectedIdx].provider,
            model: options[selectedIdx].model,
            ...(effort.length > 0 ? { reasoningEffort: effort } : {}),
          }
        : null;
      const activeReasoning = selectedIdx >= 0 && options !== null && selectedIdx < options.length
        ? options[selectedIdx].reasoning
        : null;
      const disabled = busy;
      return h("div", { style: overlayStyle, onMouseDown: (e) => { if (e.target === e.currentTarget && !busy) onCancel(); } },
        h("div", { style: dialogStyle, role: "dialog", "aria-label": t("rewind.dialog.title"), "data-rewind-dialog": "1" },
          h("h3", { style: titleStyle }, t("rewind.dialog.title")),
          h("div", { style: hintStyle }, t("rewind.dialog.hint")),
          h("textarea", {
            style: textareaStyle,
            value: text,
            placeholder: plan.userText.length === 0 ? t("rewind.dialog.placeholder") : undefined,
            disabled,
            onChange: (e) => setText(e.target.value),
            autoFocus: true,
            "data-rewind-input": "1",
          }),
          options === null ? null : h("div", { style: { ...dialogRowStyle, justifyContent: "flex-start" }, "data-rewind-models": String(options.length) },
            h("label", { style: hintStyle }, `${t("rewind.dialog.model")}:`),
            h("select", {
              style: selectStyle,
              value: String(selectedIdx),
              disabled: disabled || options.length === 0,
              onChange: (e) => { setSelectedIdx(Number(e.target.value)); setEffort(""); },
            },
              options.length === 0
                ? h("option", { value: "-1" }, t("rewind.dialog.modelFailed"))
                : h("option", { value: "-1" }, t("rewind.dialog.modelFollow")),
              options.map((o, i) => h("option", { key: `${o.provider}/${o.model}`, value: String(i) }, o.name)),
            ),
            activeReasoning === null || activeReasoning === undefined ? null : h(React.Fragment, null,
              h("label", { style: hintStyle }, `${t("rewind.dialog.effort")}:`),
              h("select", {
                style: selectStyle,
                value: effort,
                disabled,
                onChange: (e) => setEffort(e.target.value),
              },
                h("option", { value: "" }, `${t("rewind.dialog.effortDefault")} (${activeReasoning.defaultEffort ?? "—"})`),
                (activeReasoning.efforts ?? []).map((one) => h("option", { key: one.id, value: one.id }, one.name || one.id)),
              ),
            ),
          ),
          error === null ? null : h("div", { style: errorStyle }, `${t("rewind.failed")}: ${error}`),
          h("div", { style: dialogRowStyle },
            h("button", { type: "button", style: disabled ? buttonDisabledStyle : buttonStyle, onClick: onCancel, disabled }, t("rewind.dialog.cancel")),
            h("button", { type: "button", style: disabled ? buttonDisabledStyle : buttonStyle, onClick: () => onRewindOnly(modelChoice), disabled }, t("rewind.dialog.rewindOnly")),
            h("button", { type: "button", style: disabled ? buttonDisabledStyle : primaryButtonStyle, onClick: () => onResend(text, modelChoice), disabled }, busy ? t("rewind.busy") : t("rewind.dialog.resend")),
          ),
        ),
      );
    }

    /* ------------------------------------------------------------------ */
    /* turnTail entry                                                      */
    /* ------------------------------------------------------------------ */

    function RewindControls({ turn, seq, rewindApi, t: tProp }) {
      const t = typeof tProp === "function" ? tProp : (key) => zh[key] ?? en[key] ?? key;
      const [dialog, setDialog] = React.useState(null); // null | {plan}
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [notice, setNotice] = React.useState(null); // transient inline notice

      const planAndThen = React.useCallback((mode) => {
        setError(null);
        setNotice(null);
        Promise.resolve()
          .then(() => rewindApi.plan(turn, seq))
          .then((plan) => {
            if (plan === null || plan === undefined) {
              setNotice(t("rewind.incomplete"));
              return;
            }
            if (mode === "edit") {
              setDialog({ plan });
              return;
            }
            if (mode === "regenerate") {
              // Regenerate = fork before this turn + resend the ORIGINAL user
              // text. An empty prompt would silently degrade into "rewind
              // only", so refuse before touching the session.
              const original = typeof plan.userText === "string" ? plan.userText : "";
              if (original.trim().length === 0) {
                setNotice(t("rewind.regenEmpty"));
                return;
              }
              if (!window.confirm(t("rewind.regenConfirm"))) return;
              setBusy(true);
              setNotice(t("rewind.regenBusy"));
              rewindApi.run(plan.boundarySeq, original)
                .then(() => setNotice(null))
                .catch((e) => { setNotice(null); setError(String(e?.message ?? e)); })
                .then(() => setBusy(false));
              return;
            }
            if (window.confirm(t("rewind.confirm"))) {
              setBusy(true);
              rewindApi.run(plan.boundarySeq, undefined)
                .catch((e) => { setError(String(e?.message ?? e)); setBusy(false); })
                .then(() => setBusy(false));
            }
          })
          .catch((e) => {
            console.error("[dsh-chat-rewind] plan failed", e);
            setError(String(e?.message ?? e));
          });
      }, [rewindApi, turn, seq, t]);

      const runFromDialog = React.useCallback((resendText, modelChoice) => {
        if (dialog === null) return;
        setBusy(true);
        setError(null);
        rewindApi.run(dialog.plan.boundarySeq, resendText, modelChoice)
          .then(() => { setDialog(null); setBusy(false); })
          .catch((e) => {
            console.error("[dsh-chat-rewind] rewind failed", e);
            setError(String(e?.message ?? e));
            setBusy(false);
          });
      }, [dialog, rewindApi]);

      const disabled = busy;
      const editGlyph = iconEdit === null ? "✎" : h(iconEdit, { size: 16 });
      const clockGlyph = iconClock === null ? "↩" : h(iconClock, { size: 16 });
      const refreshGlyph = iconRefresh === null ? "⟳" : h(iconRefresh, { size: 16 });
      return h(React.Fragment, null,
        h("div", { className: "dshr-tail-row", "data-rewind-controls": String(turn) },
          notice === null ? null : h("span", { className: "dshr-notice" }, notice),
          h("button", {
            type: "button",
            className: "dshr-icon-btn",
            title: t("rewind.regenTitle"),
            "aria-label": t("rewind.regenTitle"),
            disabled,
            onClick: () => planAndThen("regenerate"),
            "data-rewind-regenerate": String(turn),
          }, refreshGlyph),
          h("button", {
            type: "button",
            className: "dshr-icon-btn",
            title: t("rewind.editTitle"),
            "aria-label": t("rewind.editTitle"),
            disabled,
            onClick: () => planAndThen("edit"),
            "data-rewind-edit": String(turn),
          }, editGlyph),
          h("button", {
            type: "button",
            className: "dshr-icon-btn",
            title: t("rewind.rewindTitle"),
            "aria-label": t("rewind.rewindTitle"),
            disabled,
            onClick: () => planAndThen("rewind"),
            "data-rewind-only": String(turn),
          }, clockGlyph),
        ),
        error !== null && dialog === null
          ? h("div", { className: "dshr-error-row" },
              h("span", null, `${t("rewind.failed")}: ${error}`))
          : null,
        dialog !== null
          ? h(EditDialog, {
              plan: dialog.plan,
              busy,
              error,
              t,
              catalogApi: rewindApi,
              onResend: (text, modelChoice) => runFromDialog(text, modelChoice),
              onRewindOnly: (modelChoice) => runFromDialog("", modelChoice),
              onCancel: () => { if (!busy) { setDialog(null); setError(null); } },
            })
          : null,
      );
    }

    const TAIL_CSS = [
      ".dshr-tail-row{display:flex;gap:6px;margin-top:2px;justify-content:flex-start;align-items:center}",
      ".dshr-tail-row .dshr-notice{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.9))}",
      ".dshr-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.85));cursor:pointer;font-size:16px;line-height:1}",
      ".dshr-icon-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.18));color:var(--dsw-alias-label-primary,inherit)}",
      ".dshr-icon-btn:disabled{opacity:.4;cursor:default}",
      ".dshr-icon-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#247bbf));outline-offset:1px}",
      ".dshr-error-row{display:flex;margin-top:4px;justify-content:flex-start;font-size:12px;line-height:18px;color:var(--dsw-alias-state-danger,#d54545)}",
    ].join("\n");

    function ensureTailStyles() {
      const head = document.head;
      if (head === null || head === undefined) return;
      if (document.getElementById("dsh-chat-rewind-style") !== null) return;
      const style = document.createElement("style");
      style.id = "dsh-chat-rewind-style";
      style.textContent = TAIL_CSS;
      head.appendChild(style);
    }

    function apply(ctx) {
      ensureTailStyles();
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "chat-rewind: dictionaries");

      ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register({
        name: "conversation.chat.turnTail",
        id: "rewind",
        order: 5,
        locale: NS,
        inject: (sessionId) => ({
          rewindApi: {
            plan: (turn, tailSeq) => rewindPlan(ctx.remote, sessionId, turn, tailSeq),
            run: (boundarySeq, resendText, modelChoice) => executeRewind(ctx, sessionId, boundarySeq, resendText, modelChoice),
            catalog: () => ctx.remote.session.modelCatalog(),
          },
        }),
      }, RewindControls));
    }

    return { inject, apply };
  },
});
