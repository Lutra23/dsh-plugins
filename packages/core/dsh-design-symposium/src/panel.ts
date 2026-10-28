/**
 * The live discussion page (P2 可视化).
 *
 * A single self-contained HTML document served by the plugin's own route. It
 * polls the sibling `/live` endpoint and renders the run as a group chat: one
 * bubble per speech, pending questions pinned at the bottom.
 *
 * Why HTML instead of a client-half slot: the panel must look like a chat and
 * stay readable at any window width, and a client half would bind it to the
 * host's component tree and build pipeline. A standalone page has no version
 * skew, no slot API to break, and its whole visual contract lives in this file.
 *
 * @module dsh-design-symposium/panel
 */

/** Route namespace shared with the host half. */
export const ROUTE_PREFIX = '/api/plugins/dsh-design-symposium';

/** One sage's fixed accent colour, keyed by seat id. */
const SEAT_COLORS: Record<string, string> = {
  pragma: '#22d3ee',
  purist: '#a78bfa',
  adversary: '#fb7185',
  scribe: '#fbbf24',
};

/**
 * Colour for a seat, stable across runs.
 * @param id - seat id.
 * @param index - fallback position when the id is unknown.
 * @returns a CSS colour.
 */
function seatColor(id: string, index: number): string {
  const known = SEAT_COLORS[id];
  if (known !== undefined) return known;
  const palette = ['#22d3ee', '#a78bfa', '#fb7185', '#fbbf24', '#34d399', '#60a5fa'];
  return palette[index % palette.length] ?? '#93c5fd';
}

/**
 * Render the whole page.
 * @param seats - configured seats, in speaking order, for colour assignment.
 * @returns the HTML document.
 */
export function renderPanelHtml(
  seats: readonly { id: string; name: string }[],
  initialState?: Record<string, unknown>,
  autoRefreshSeconds?: number,
): string {
  const colors = Object.fromEntries(seats.map((seat, index) => [seat.id, seatColor(seat.id, index)]));
  const seatMeta = seats.map((seat) => ({ id: seat.id, name: seat.name, color: colors[seat.id] ?? '#93c5fd' }));
  // Server-side first paint: the page opens with the run already on screen
  // instead of a blank frame waiting for the first poll to come back.
  const boot = initialState === undefined ? 'null' : JSON.stringify(initialState);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${autoRefreshSeconds === undefined ? '' : `<meta http-equiv="refresh" content="${autoRefreshSeconds}">`}
<title>研讨现场</title>
<style>
:root{
  --bg:#0b0f14; --bg-soft:#111823; --line:rgba(148,163,184,.14);
  --ink:#e6edf3; --ink-dim:#94a3b8; --ink-faint:#64748b;
  --ok:#34d399; --warn:#fbbf24; --bad:#fb7185; --accent:#38bdf8;
  --r-sm:8px; --r-md:14px; --r-lg:20px;
  --step-1:13px; --step-2:14px; --step-3:16px; --step-4:20px;
}
*{box-sizing:border-box}
html,body{height:100%}
body{
  margin:0; background:
    radial-gradient(1100px 620px at 12% -10%, rgba(56,189,248,.10), transparent 60%),
    radial-gradient(900px 520px at 100% 0%, rgba(167,139,250,.08), transparent 55%),
    var(--bg);
  color:var(--ink); font:var(--step-2)/1.65 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;
  display:flex; flex-direction:column;
}
header{
  position:sticky; top:0; z-index:9; backdrop-filter:blur(14px);
  background:rgba(11,15,20,.72); border-bottom:1px solid var(--line);
  padding:14px 22px; display:flex; align-items:center; gap:14px;
}
.brand{font-size:var(--step-4); font-weight:650; letter-spacing:.2px}
.brand small{display:block; font-size:var(--step-1); font-weight:400; color:var(--ink-faint); letter-spacing:0}
.badge{
  margin-left:auto; display:inline-flex; align-items:center; gap:8px;
  padding:6px 13px; border-radius:999px; border:1px solid var(--line);
  background:rgba(148,163,184,.07); font-size:var(--step-1); color:var(--ink-dim);
}
.dot{width:8px;height:8px;border-radius:50%;background:var(--ink-faint)}
.dot.live{background:var(--ok); box-shadow:0 0 0 0 rgba(52,211,153,.55); animation:pulse 1.8s infinite}
.dot.wait{background:var(--warn)}
.dot.done{background:var(--accent)}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(52,211,153,.5)}70%{box-shadow:0 0 0 9px rgba(52,211,153,0)}100%{box-shadow:0 0 0 0 rgba(52,211,153,0)}}
.topics{padding:18px 22px 6px}
.topics h1{margin:0 0 6px; font-size:var(--step-3); font-weight:620; line-height:1.45}
.topics p{margin:0; color:var(--ink-faint); font-size:var(--step-1)}
main{flex:1; overflow-y:auto; padding:10px 22px 120px; scroll-behavior:smooth}
.stream{display:flex; flex-direction:column; gap:16px; max-width:900px; margin:0 auto}
.round{display:flex; align-items:center; gap:12px; margin:14px 0 2px; color:var(--ink-faint); font-size:var(--step-1)}
.round::before,.round::after{content:""; height:1px; flex:1; background:var(--line)}
.msg{display:grid; grid-template-columns:34px 1fr; gap:12px; align-items:start}
.avatar{
  width:34px;height:34px;border-radius:50%; display:grid; place-items:center;
  font-size:var(--step-1); font-weight:700; color:#0b0f14;
  border:1px solid rgba(255,255,255,.16);
}
.body{min-width:0}
.meta{display:flex; align-items:baseline; gap:9px; margin-bottom:5px; flex-wrap:wrap}
.who{font-weight:620; font-size:var(--step-2)}
.model{color:var(--ink-faint); font-size:11px; font-family:ui-monospace,"SFMono-Regular",Menlo,monospace}
.time{color:var(--ink-faint); font-size:11px; margin-left:auto}
.bubble{
  background:linear-gradient(180deg,rgba(148,163,184,.09),rgba(148,163,184,.045));
  border:1px solid var(--line); border-radius:var(--r-md);
  border-top-left-radius:var(--r-sm);
  padding:13px 16px; white-space:pre-wrap; word-break:break-word;
  font-size:var(--step-2); line-height:1.75;
}
.bubble.empty{color:var(--ink-faint); font-style:italic; border-style:dashed}
.chips{display:flex; flex-wrap:wrap; gap:6px; margin-top:8px}
.chip{
  font-size:11px; padding:3px 9px; border-radius:999px;
  border:1px solid var(--line); background:rgba(148,163,184,.08); color:var(--ink-dim);
}
.chip.yes{color:var(--ok); border-color:rgba(52,211,153,.35); background:rgba(52,211,153,.10)}
.chip.mid{color:var(--warn); border-color:rgba(251,191,36,.35); background:rgba(251,191,36,.10)}
.chip.no{color:var(--bad); border-color:rgba(251,113,133,.35); background:rgba(251,113,133,.10)}
footer{
  border-top:1px solid var(--line); background:rgba(11,15,20,.82); backdrop-filter:blur(14px);
  padding:12px 22px; max-height:38vh; overflow-y:auto;
}
.pend{max-width:900px;margin:0 auto;display:flex;flex-direction:column;gap:8px}
.pend h2{margin:0 0 2px;font-size:var(--step-1);color:var(--warn);font-weight:620;letter-spacing:.3px}
.pend .q{display:flex;gap:10px;align-items:baseline;font-size:var(--step-1);color:var(--ink-dim)}
.pend .q b{color:var(--warn);font-family:ui-monospace,Menlo,monospace}
.empty-state{max-width:900px;margin:8vh auto;text-align:center;color:var(--ink-faint)}
.empty-state strong{display:block;color:var(--ink-dim);font-size:var(--step-3);margin-bottom:6px}
</style>
</head>
<body>
<header>
  <div class="brand">研讨现场<small>dsh-design-symposium</small></div>
  <div class="badge"><span class="dot" id="dot"></span><span id="state">连接中…</span></div>
</header>
<div class="topics"><h1 id="topic">等待议题…</h1><p id="sub"></p></div>
<main><div class="stream" id="stream"><div class="empty-state"><strong>还没有发言</strong>发起研讨后这里会实时出现每位贤者的发言</div></div></main>
<footer id="footer" style="display:none"><div class="pend" id="pend"></div></footer>
<script>
const SEATS = ${JSON.stringify(seatMeta)};
const BOOT = ${boot};
const byId = Object.fromEntries(SEATS.map(function (s) { return [s.id, s]; }));
const DOT = { running: 'live', 'awaiting-verification': 'wait', done: 'done', stopped: 'wait', failed: 'wait' };
const STATE_TEXT = { running: '研讨中', 'awaiting-verification': '等待求证', done: '已结束', stopped: '已停止', failed: '失败', idle: '空闲' };
let lastCount = -1;
let firstPaint = true;
let timer = null;

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}
function render(data) {
  const dot = document.getElementById('dot');
  const state = document.getElementById('state');
  dot.className = 'dot ' + (DOT[data.status] || '');
  state.textContent = (STATE_TEXT[data.status] || data.status) +
    (data.rounds ? ' · 第 ' + data.rounds + '/' + data.plannedRounds + ' 轮' : '');
  document.getElementById('topic').textContent = data.topic || '（无议题）';
  const sub = [];
  if (data.speeches && data.speeches.length) sub.push('发言 ' + data.speeches.length + ' 条');
  if (data.startedAt) sub.push('开始于 ' + new Date(data.startedAt).toLocaleTimeString('zh-CN'));
  document.getElementById('sub').textContent = sub.join(' · ');

  const stream = document.getElementById('stream');
  const list = data.speeches || [];
  if (list.length === 0) return;
  if (lastCount === list.length) return;
  lastCount = list.length;

  let html = '';
  let round = 0;
  for (const speech of list) {
    if (speech.round !== round) {
      round = speech.round;
      html += '<div class="round">第 ' + round + ' 轮</div>';
    }
    const seat = byId[speech.participantId] || { name: speech.name, color: '#93c5fd' };
    const initial = (seat.name || '贤').slice(0, 1);
    const empty = !speech.text || speech.status !== 'ok';
    const bubble = empty
      ? '<div class="bubble empty">' + esc(speech.note || '（本轮没有有效发言）') + '</div>'
      : '<div class="bubble">' + esc(speech.text) + '</div>';
    html += '<div class="msg">' +
      '<div class="avatar" style="background:' + seat.color + '">' + esc(initial) + '</div>' +
      '<div class="body"><div class="meta"><span class="who">' + esc(seat.name) + '</span>' +
      '<span class="model">' + esc(speech.model) + '</span>' +
      '<span class="time">' + (speech.usage ? speech.usage.outputTokens + ' tok' : '') + '</span></div>' +
      bubble + '</div></div>';
  }
  stream.innerHTML = html;
  // The first paint starts at the top so the agenda and round 1 are readable;
  // only later updates follow the tail like a chat.
  if (!firstPaint) {
    const main = document.querySelector('main');
    main.scrollTop = main.scrollHeight;
  }
  firstPaint = false;

  const pending = data.pendingQuestions || [];
  const footer = document.getElementById('footer');
  if (pending.length === 0) {
    footer.style.display = 'none';
  } else {
    footer.style.display = 'block';
    document.getElementById('pend').innerHTML = '<h2>等待主人求证（' + pending.length + '）</h2>' +
      pending.map(function (q) {
        const seat = byId[q.sageId] || { name: q.sageName };
        return '<div class="q"><b>' + esc(q.qid) + '</b><span>' + esc(seat.name) + '：' + esc(q.text) + '</span></div>';
      }).join('');
  }
}
async function tick() {
  try {
    const res = await fetch('${ROUTE_PREFIX}/live', { cache: 'no-store' });
    if (res.ok) render(await res.json());
  } catch (err) { /* the next tick retries */ }
}
if (BOOT) { try { render(BOOT); } catch (err) { /* first paint is best-effort */ } }
tick();
timer = setInterval(tick, 2000);
window.addEventListener('beforeunload', function () { if (timer) clearInterval(timer); });
</script>
</body>
</html>`;
}
