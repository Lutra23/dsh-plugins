/**
 * dsh-emoji · 浏览器半加载自检。
 *
 * 浏览器半的失败模式是静默的：模块加载器拿不到它，设置页就只是少一项，
 * 控制台未必有线索，重启后很容易被误当成「设置页还没做」。
 * 所以在重启 App 之前，先用一个 mock 的 window.__ModuleLoader__ 走一遍真实
 * 加载路径：
 *
 *   client.js 被求值 → __ModuleLoader__.load 收到 {id, factory}
 *   → factory(require) 执行 → exports 暴露 apply / inject
 *   → apply(ctx) 真的注册 settings.section → 组件能被 React 渲染出预期文案
 *
 * 顺带锁住一条设计约束：factory 只允许 require("react")。一旦有人往里加
 * dsh-client-ui-primitives 之类的宿主包，这个用例会失败，从而拦住「悄悄
 * 引入会随内核升级漂移的客户端契约」这件事。
 *
 * 用法：node test/client.mjs
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const react = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

const results = []
let failed = 0

/** 记一条断言。 */
function check(label, ok, detail) {
  results.push({ label, ok, detail })
  if (!ok) failed += 1
}

/** 等值断言。 */
function eq(label, actual, expected) {
  const ok = actual === expected
  check(label, ok, ok ? '' : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

// ── 1. 装一个 mock 的模块加载器，然后真跑 client.js
let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition
    },
  },
}

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
vm.runInThisContext(source, { filename: 'lib/client.js' })

check('client.js 调用了 __ModuleLoader__.load', captured !== null)
eq('模块 id 与包名一致', captured && captured.id, '@dsh-external/dsh-emoji')
eq('load 收到 factory', typeof (captured && captured.factory), 'function')

// ── 2. factory 只许 require("react")：守住「不引入宿主客户端契约」这条线
const requiredModules = []
const clientModule = captured.factory((name) => {
  requiredModules.push(name)
  if (name === 'react') return react
  throw new Error('client.js 不该 require：' + name)
})

eq('factory 只 require 了 react', requiredModules.join(','), 'react')
eq('导出 apply', typeof clientModule.apply, 'function')
eq('导出 inject', (clientModule.inject || []).join(','), 'slots,locale')

// ── 3. apply 必须真的注册 settings.section 与 shell.overlay 两个区块
const registered = []
const injectTargets = []
const effects = []
const disposers = []
const unregistered = []
const ctx = {
  slots: {
    inject(name, callback) {
      injectTargets.push(name)
      return callback()
    },
    register(definition, component) {
      registered.push({ definition, component })
      return () => {
        unregistered.push(definition.id)
      }
    },
  },
  effect(callback, label) {
    effects.push(label)
    // 真实宿主在挂载时执行回调，只为取它**返回**的 disposer，并不会调用它。
    const dispose = callback()
    disposers.push(dispose)
    return dispose
  },
  locale: { bind: () => () => '' },
}

clientModule.apply(ctx)

eq('slots.inject 的目标集合', injectTargets.join(','), 'settings.section,shell.overlay')
eq('注册了两个区块', registered.length, 2)
const sectionEntry = registered.find((r) => r.definition && r.definition.id === 'emoji')
const overlayEntry = registered.find((r) => r.definition && r.definition.id === 'emoji-shortcuts')
check('settings 区块存在', sectionEntry !== undefined)
check('overlay 区块存在', overlayEntry !== undefined)
eq('settings slot 名', sectionEntry && sectionEntry.definition.name, 'settings.section')
eq('区块 order 是数字', typeof (sectionEntry && sectionEntry.definition.order), 'number')
const sectionLabel = sectionEntry && sectionEntry.definition.label
eq('区块 label 返回中文名', typeof sectionLabel === 'function' ? sectionLabel() : sectionLabel, '表情包')
eq('区块组件是函数', typeof (sectionEntry && sectionEntry.component), 'function')
eq('overlay slot 名', overlayEntry && overlayEntry.definition.name, 'shell.overlay')
eq('overlay order 是数字', typeof (overlayEntry && overlayEntry.definition.order), 'number')
eq('overlay 组件是函数', typeof (overlayEntry && overlayEntry.component), 'function')
check('apply 用 effect 挂了 disposer', effects.length === 1, effects.join(','))
// 真机事故的最小复现：effect 回调若在内部直接执行拆卸，挂载瞬间两个注册
// 就被自己拆掉——GUI 上表现为设置页与速记一起消失，且控制台未必有线索。
check('挂载时不得自拆任何注册', unregistered.length === 0, unregistered.join(','))
eq('effect 回调返回的是函数（而不是自己动手）', typeof disposers[0], 'function')
if (typeof disposers[0] === 'function') disposers[0]()
eq('teardown 拆掉两个注册', [...unregistered].sort().join(','), 'emoji,emoji-shortcuts')

// ── 4. 组件要能被 React 真的渲染出来（SSR：useEffect 不跑，走的是初次挂载态）
const Section = sectionEntry.component
let html = ''
let renderError = ''
try {
  html = renderToStaticMarkup(react.createElement(Section))
} catch (error) {
  renderError = error instanceof Error ? error.message : String(error)
}
eq('组件渲染不抛错', renderError, '')
check('渲染出加载态文案', html.includes('正在读取表情包库'))
check('渲染出「导入图片」按钮', html.includes('导入图片'))
check('渲染出「重新扫描」按钮', html.includes('重新扫描'))
check('渲染出「清空缩放缓存」按钮', html.includes('清空缩放缓存'))
check('渲染出宽度档位输入区', html.includes('宽度档位'))
check('渲染出扫描目录输入区', html.includes('扫描目录'))
check('空库时给出引导文案', html.includes('还没有表情包'))
check(
  '控件带 type=button（避免在表单里意外提交）',
  (html.match(/type="button"/g) || []).length >= 3,
  `实际 ${(html.match(/type="button"/g) || []).length} 个`,
)

// ── 4b. overlay 组件 SSR 渲染为空：它只负责挂副作用，不产出任何 DOM
let overlayHtml = ''
let overlayError = ''
try {
  overlayHtml = renderToStaticMarkup(react.createElement(overlayEntry.component))
} catch (error) {
  overlayError = error instanceof Error ? error.message : String(error)
}
eq('overlay 组件渲染不抛错', overlayError, '')
eq('overlay 渲染为空', overlayHtml, '')

// ── 4c. resolveShorthand 纯函数：:名字: 语法的解析语义
const rs = clientModule.resolveShorthand
const names = new Set(['思考', '@_@', '完工撒花'])
eq('导出 resolveShorthand', typeof rs, 'function')
eq(
  '精确命中用默认宽',
  JSON.stringify(rs('思考', names, 150)),
  '{"name":"思考","width":150}',
)
eq(
  '@ 开头的名字全名优先命中',
  JSON.stringify(rs('@_@', names, 150)),
  '{"name":"@_@","width":150}',
)
eq(
  '@宽 后缀覆盖宽度',
  JSON.stringify(rs('思考@40', names, 150)),
  '{"name":"思考","width":40}',
)
eq(
  '带 @ 的名字同样支持宽度后缀',
  JSON.stringify(rs('@_@@40', names, 150)),
  '{"name":"@_@","width":40}',
)
eq('库里没有则未命中（保持原文）', rs('不存在', names, 150), null)
eq('宽度低于 4 未命中', rs('思考@2', names, 150), null)
eq('宽度高于 2048 未命中', rs('思考@9999', names, 150), null)

// ── 4d. 切包器：SSR 要渲染出下拉，源码要成对挂/摘广播监听
check('渲染出「表情包套」行', html.includes('表情包套'))
check('渲染出包下拉（空库时禁用）', /<select[^>]*disabled/.test(html))
check('无包时不渲染任何 option', !/<select[\s\S]*?<option/.test(html))
check('源码里挂了切包广播的监听', source.includes("window.addEventListener('dsh-emoji:pack-changed'"))
check('源码里摘了切包广播的监听', source.includes("window.removeEventListener('dsh-emoji:pack-changed'"))
check('切包走 pack-switch 端点', source.includes("packSwitch: 'api/dsh-emoji/pack-switch'"))
check(
  '切包广播的名字三处一致（派发 / 挂 / 摘）',
  (source.match(/dsh-emoji:pack-changed/g) || []).length >= 3,
  `实际 ${(source.match(/dsh-emoji:pack-changed/g) || []).length} 处`,
)

// ── 5. 每条 API 路径都必须是 document-relative（不带前导斜杠）
const apiLiterals = source.match(/'(api\/dsh-emoji\/[a-z-]+)'/g) || []
check('找到全部 API 字面量', apiLiterals.length >= 7, `实际 ${apiLiterals.length} 个`)
check(
  '所有 API 路径都不带前导斜杠',
  !/'\/api\/dsh-emoji/.test(source),
  '若带前导斜杠，子路径部署下请求会逃出 base href',
)

for (const item of results) {
  const mark = item.ok ? '  ok  ' : ' FAIL '
  console.log(`[${mark}] ${item.label}${item.detail ? ' — ' + item.detail : ''}`)
}
console.log('')
console.log(`浏览器半自检 ${results.length - failed}/${results.length} 通过`)
if (failed > 0) {
  console.error(`失败 ${failed} 项`)
  process.exit(1)
}
