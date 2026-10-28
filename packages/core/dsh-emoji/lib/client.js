/**
 * dsh-emoji · 浏览器半。
 *
 * 在「设置 → 表情包」注册一块 settings.section 面板：导入图片、画廊预览、
 * 按名筛选、宽度档位、扫描目录、删除、清缓存。
 *
 * 设计取向：本文件只 require("react")，不 require 任何 dsh-client-ui-primitives。
 * 官方 section 组件收到的 props 形态（t / renderSlot / useTabs / hooks）属于
 * 客户端内部契约，会随内核版本漂移；而这块面板要展示的数据全部来自自家
 * /api/dsh-emoji/* 路由，自己取数即可。少一个宿主契约，就少一处会静默失效的接缝。
 *
 * API 路径全部 document-relative（不带前导斜杠）：GUI 以 base href="./" 服务，
 * 根绝对路径会逃出子路径部署。
 */
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-emoji',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = require('react')
    var h = react.createElement

    /** 路由字面量，与宿主 lib/routes.js 的 ROUTES 对应（此处为 document-relative）。 */
    var API = {
      list: 'api/dsh-emoji/list',
      packs: 'api/dsh-emoji/packs',
      packSwitch: 'api/dsh-emoji/pack-switch',
      image: 'api/dsh-emoji/image',
      importFiles: 'api/dsh-emoji/import',
      scan: 'api/dsh-emoji/scan',
      remove: 'api/dsh-emoji/delete',
      config: 'api/dsh-emoji/config',
      clearCache: 'api/dsh-emoji/clear-cache',
    }

    /** 发一个 JSON 请求，非 2xx 时抛出宿主给的文案。 */
    async function request(path, options) {
      var opts = options || {}
      var init = { method: opts.method || 'GET', headers: {} }
      if (opts.body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(opts.body)
      }
      var response = await fetch(path, init)
      var text = await response.text()
      var parsed
      try {
        parsed = text === '' ? {} : JSON.parse(text)
      } catch {
        parsed = { error: text.slice(0, 300) }
      }
      if (!response.ok) throw new Error(parsed.error || 'HTTP ' + String(response.status))
      return parsed
    }

    /** 把 File 读成不含 data URL 前缀的 base64。 */
    function readAsBase64(file) {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader()
        reader.onload = function () {
          var result = String(reader.result || '')
          var comma = result.indexOf(',')
          resolve(comma >= 0 ? result.slice(comma + 1) : '')
        }
        reader.onerror = function () {
          reject(new Error('读取文件失败：' + file.name))
        }
        reader.readAsDataURL(file)
      })
    }

    /** 字节数说成人话。 */
    function humanBytes(bytes) {
      if (typeof bytes !== 'number' || !isFinite(bytes)) return '-'
      if (bytes < 1024) return String(bytes) + 'B'
      if (bytes < 1024 * 1024) return String(Math.round(bytes / 1024)) + 'KB'
      return (bytes / 1024 / 1024).toFixed(1) + 'MB'
    }

    /** 组装一张表情包的预览地址（走宿主缩放端点，避免画廊里加载原图）。 */
    function previewUrl(name, width) {
      return API.image + '?name=' + encodeURIComponent(name) + '&w=' + String(width)
    }

    /** 样式：优先用 DSH 主题变量，取不到时回落到中性值。 */
    var C = {
      page: { display: 'block', font: 'inherit', color: 'inherit' },
      row: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
      field: {
        padding: '6px 10px',
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        border: '1px solid var(--dsw-alias-border-secondary, #d0d0d0)',
        background: 'var(--dsw-alias-bg-primary, transparent)',
        color: 'inherit',
        font: 'inherit',
        boxSizing: 'border-box',
      },
      button: {
        padding: '6px 14px',
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        border: '1px solid var(--dsw-alias-border-secondary, #d0d0d0)',
        background: 'var(--dsw-alias-bg-secondary, transparent)',
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
      },
      deleteButton: {
        padding: '4px 10px',
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        border: '1px solid var(--dsw-alias-border-secondary, #d0d0d0)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, #888)',
        font: 'inherit',
        fontSize: '12px',
        cursor: 'pointer',
        width: '100%',
      },
      hint: { color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: '12px', lineHeight: 1.6 },
      grid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
        gap: '12px',
        marginTop: '12px',
      },
      card: {
        border: '1px solid var(--dsw-alias-border-secondary, #e0e0e0)',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        padding: '8px',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        minWidth: 0,
      },
      thumb: {
        height: '96px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        background: 'var(--dsw-alias-bg-secondary, rgba(128,128,128,0.06))',
        borderRadius: 'var(--dsw-radius-sm, 6px)',
      },
      cardTitle: {
        fontWeight: 600,
        margin: 0,
        fontSize: '14px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      sectionTitle: { fontWeight: 600, margin: '20px 0 8px', fontSize: '14px' },
      error: { color: 'var(--dsw-alias-state-error-primary, #d33)', fontSize: '13px', lineHeight: 1.6 },
      ok: { color: 'var(--dsw-alias-state-success-primary, #2a7)', fontSize: '13px', lineHeight: 1.6 },
    }

    /** 单张表情包卡片。 */
    function EmojiCard(props) {
      var item = props.item
      var failedState = react.useState(false)
      var failed = failedState[0]
      var setFailed = failedState[1]
      var dims = item.width && item.height ? String(item.width) + '×' + String(item.height) : '尺寸未知'
      var meta = dims + ' · ' + humanBytes(item.bytes) + ' · ' + item.format + (item.scalable ? '' : ' · 不可缩放')

      return h(
        'div',
        { style: C.card },
        h(
          'div',
          { style: C.thumb },
          failed
            ? h('span', { style: C.hint }, '预览失败')
            : h('img', {
                src: previewUrl(item.name, props.previewWidth),
                alt: item.name,
                loading: 'lazy',
                onError: function () {
                  setFailed(true)
                },
                style: { maxWidth: '100%', maxHeight: '92px', objectFit: 'contain' },
              }),
        ),
        h('p', { style: C.cardTitle, title: item.name }, item.name),
        h('p', { style: C.hint }, meta),
        h(
          'button',
          {
            type: 'button',
            style: C.deleteButton,
            disabled: props.busy,
            onClick: function () {
              props.onDelete(item)
            },
          },
          '删除',
        ),
      )
    }

    /**
     * 设置页的表情包面板。全部状态都在这里，取数走自家路由，
     * 不依赖宿主注入的 hooks。
     */
    function EmojiSection() {
      var dataState = react.useState(null)
      var data = dataState[0]
      var setData = dataState[1]

      var errorState = react.useState('')
      var error = errorState[0]
      var setError = errorState[1]

      var noticeState = react.useState('')
      var notice = noticeState[0]
      var setNotice = noticeState[1]

      var busyState = react.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]

      var filterState = react.useState('')
      var filter = filterState[0]
      var setFilter = filterState[1]

      var widthsState = react.useState('')
      var widthsText = widthsState[0]
      var setWidthsText = widthsState[1]

      var scanState = react.useState('')
      var scanText = scanState[0]
      var setScanText = scanState[1]

      var previewState = react.useState(150)
      var previewWidth = previewState[0]
      var setPreviewWidth = previewState[1]

      var fileRef = react.useRef(null)

      /** 拉一次列表，并同步两个可编辑字段的初值。 */
      var load = react.useCallback(function () {
        setError('')
        return request(API.list)
          .then(function (payload) {
            setData(payload)
            setWidthsText((payload.widths || []).join(', '))
            setScanText((payload.scanDirs || []).join('\n'))
            return payload
          })
          .catch(function (e) {
            setError(String((e && e.message) || e))
            return undefined
          })
      }, [])

      react.useEffect(function () {
        load()
      }, [load])

      /** 用列表回执就地更新画廊，省一次往返。 */
      var applyItems = function (result) {
        setData(function (previous) {
          return previous ? Object.assign({}, previous, { items: result.items, count: result.count }) : previous
        })
      }

      /** 包一层忙碌标记，避免重复点击。 */
      var run = function (task) {
        if (busy) return Promise.resolve()
        setBusy(true)
        setError('')
        setNotice('')
        return task()
          .then(function (message) {
            if (message) setNotice(message)
          })
          .catch(function (e) {
            setError(String((e && e.message) || e))
          })
          .finally(function () {
            setBusy(false)
          })
      }

      /** 导入用户选中的文件。 */
      var onPickFiles = function (event) {
        var files = Array.prototype.slice.call((event.target && event.target.files) || [])
        if (files.length === 0) return
        run(function () {
          return Promise.all(
            files.map(function (file) {
              return readAsBase64(file).then(function (dataBase64) {
                return { name: file.name, dataBase64: dataBase64 }
              })
            }),
          )
            .then(function (payload) {
              return request(API.importFiles, { method: 'POST', body: { files: payload } })
            })
            .then(function (result) {
              applyItems(result)
              if ((result.errors || []).length > 0) {
                setError(
                  '有 ' + String(result.errors.length) + ' 个文件未导入：' +
                    result.errors
                      .map(function (item) {
                        return item.name + '（' + item.error + '）'
                      })
                      .join('；'),
                )
              }
              return '已导入 ' + String((result.imported || []).length) + ' 张'
            })
        }).finally(function () {
          if (fileRef.current) fileRef.current.value = ''
        })
      }

      /** 按配置的扫描目录批量导入（幂等：库内已有的跳过）。 */
      var onScan = function () {
        run(function () {
          return request(API.scan, { method: 'POST', body: {} }).then(function (result) {
            applyItems(result)
            if ((result.errors || []).length > 0) {
              setError(
                result.errors
                  .map(function (item) {
                    return item.name + '：' + item.error
                  })
                  .join('；'),
              )
            }
            return (
              '扫描完成：新增 ' + String((result.imported || []).length) +
              ' 张，已存在跳过 ' + String(result.skipped || 0) + ' 张'
            )
          })
        })
      }

      /** 保存宽度档位与扫描目录。 */
      var onSaveConfig = function () {
        var widths = widthsText
          .split(/[,，\s]+/)
          .map(function (part) {
            return Number(part)
          })
          .filter(function (n) {
            return isFinite(n) && n >= 4 && n <= 2048
          })
        var dirs = scanText
          .split(/\r?\n+/)
          .map(function (line) {
            return line.trim()
          })
          .filter(function (line) {
            return line !== ''
          })
        if (widths.length === 0) {
          setError('宽度档位至少要填一个 4-2048 之间的整数。')
          return
        }
        run(function () {
          return request(API.config, { method: 'POST', body: { widths: widths, scanDirs: dirs } }).then(function (result) {
            setData(function (previous) {
              return previous
                ? Object.assign({}, previous, { widths: result.widths, scanDirs: result.scanDirs })
                : previous
            })
            setWidthsText((result.widths || []).join(', '))
            setScanText((result.scanDirs || []).join('\n'))
            return '设置已保存'
          })
        })
      }

      /** 删除一张（进 .trash，可人工捞回）。 */
      var onDelete = function (item) {
        run(function () {
          return request(API.remove, { method: 'POST', body: { name: item.name } }).then(function (result) {
            applyItems(result)
            return '已删除「' + item.name + '」（原图已移入库内 .trash，可人工找回）'
          })
        })
      }

      /** 清空缩放缓存（只动 cache/，不碰原图）。 */
      var onClearCache = function () {
        run(function () {
          return request(API.clearCache, { method: 'POST', body: {} }).then(function (result) {
            return '已清理 ' + String(result.removed || 0) + ' 个缩放缓存文件（原图未受影响）'
          })
        })
      }

      /**
       * 切换表情包套。
       * 切换只在配置里改一个指针，不动任何图片；回执与 list 同形，直接套用即可。
       * 另外广播一个事件：速记渲染器自带名单缓存（60 秒轮询），不听这一声
       * 就得等最多一分钟才换脸。
       */
      var onSwitchPack = function (id) {
        if (typeof id !== 'string' || id === '' || (data && id === data.activePack)) return
        run(function () {
          return request(API.packSwitch, { method: 'POST', body: { id: id } }).then(function (result) {
            setData(result)
            window.dispatchEvent(new CustomEvent('dsh-emoji:pack-changed'))
            return '已切到「' + String(result.activePackName || id) + '」，共 ' + String(result.count || 0) + ' 张'
          })
        })
      }

      var items = (data && data.items) || []
      var packs = (data && data.packs) || []
      var activePack = (data && data.activePack) || ''
      var keyword = filter.trim().toLowerCase()
      var shown =
        keyword === ''
          ? items
          : items.filter(function (item) {
              return item.name.toLowerCase().indexOf(keyword) >= 0
            })

      return h(
        'div',
        { style: C.page },

        h(
          'p',
          { style: C.hint },
          data
            ? '「' + String(data.activePackName || activePack || '默认') + '」已收录 ' + String(items.length) +
              ' 个表情包，库目录 ' + String(data.imagesDir || data.home)
            : '正在读取表情包库…',
        ),

        h(
          'div',
          { style: Object.assign({}, C.row, { marginTop: '10px' }) },
          h('span', { style: C.hint }, '表情包套'),
          h(
            'select',
            {
              value: activePack,
              disabled: busy || packs.length <= 1,
              onChange: function (event) {
                onSwitchPack(event.target.value)
              },
              style: Object.assign({}, C.field, { flex: '0 1 260px' }),
            },
            packs.map(function (pack) {
              return h('option', { key: pack.id, value: pack.id }, pack.name + '（' + String(pack.count) + ' 张）')
            }),
          ),
          h(
            'span',
            { style: C.hint },
            '每套各自完整躺在 packs/ 下，切换只改指针、不动图片：画廊、速记与 Agent 侧立即跟着换。',
          ),
        ),

        h(
          'div',
          { style: Object.assign({}, C.row, { marginTop: '10px' }) },
          h('input', {
            ref: fileRef,
            type: 'file',
            accept: 'image/png,image/jpeg,image/gif,image/bmp,image/webp',
            multiple: true,
            style: { display: 'none' },
            onChange: onPickFiles,
          }),
          h(
            'button',
            {
              type: 'button',
              style: C.button,
              disabled: busy,
              onClick: function () {
                if (fileRef.current) fileRef.current.click()
              },
            },
            '导入图片',
          ),
          h('button', { type: 'button', style: C.button, disabled: busy, onClick: onScan }, '重新扫描'),
          h('button', { type: 'button', style: C.button, disabled: busy, onClick: onClearCache }, '清空缩放缓存'),
        ),

        h(
          'div',
          { style: Object.assign({}, C.row, { marginTop: '10px' }) },
          h('input', {
            type: 'text',
            placeholder: '按名字筛选',
            value: filter,
            onChange: function (event) {
              setFilter(event.target.value)
            },
            style: Object.assign({}, C.field, { flex: '1 1 200px' }),
          }),
          h('span', { style: C.hint }, '预览宽度'),
          h('input', {
            type: 'number',
            min: 4,
            max: 2048,
            value: String(previewWidth),
            onChange: function (event) {
              setPreviewWidth(Number(event.target.value) || 150)
            },
            style: Object.assign({}, C.field, { width: '90px' }),
          }),
        ),

        h('h3', { style: C.sectionTitle }, '尺寸档位与扫描目录'),
        h(
          'p',
          { style: C.hint },
          '宽度档位是给 Agent 的推荐值——图片端点接受任意 4-2048 的宽度，按需缩放并落缓存，不预生成文件。',
        ),

        h(
          'div',
          { style: Object.assign({}, C.row, { marginTop: '8px' }) },
          h('span', { style: C.hint }, '宽度档位'),
          h('input', {
            type: 'text',
            value: widthsText,
            onChange: function (event) {
              setWidthsText(event.target.value)
            },
            placeholder: '20, 28, 40, 150',
            style: Object.assign({}, C.field, { flex: '1 1 220px' }),
          }),
        ),

        h(
          'div',
          { style: Object.assign({}, C.row, { marginTop: '8px', alignItems: 'flex-start' }) },
          h('span', { style: Object.assign({}, C.hint, { paddingTop: '8px' }) }, '扫描目录'),
          h('textarea', {
            value: scanText,
            onChange: function (event) {
              setScanText(event.target.value)
            },
            placeholder: '每行一个目录，例如 C:\\Users\\me\\Pictures\\emoji',
            rows: 3,
            style: Object.assign({}, C.field, { flex: '1 1 320px', resize: 'vertical' }),
          }),
          h('button', { type: 'button', style: C.button, disabled: busy, onClick: onSaveConfig }, '应用'),
        ),

        error !== '' ? h('p', { style: Object.assign({}, C.error, { marginTop: '10px' }) }, error) : null,
        notice !== '' ? h('p', { style: Object.assign({}, C.ok, { marginTop: '10px' }) }, notice) : null,

        items.length === 0
          ? h(
              'p',
              { style: Object.assign({}, C.hint, { marginTop: '16px' }) },
              '还没有表情包。点「导入图片」挑几张，或把图片放进库目录后点「重新扫描」。',
            )
          : h(
              'div',
              { style: C.grid },
              shown.map(function (item) {
                return h(EmojiCard, {
                  key: item.file,
                  item: item,
                  previewWidth: previewWidth,
                  busy: busy,
                  onDelete: onDelete,
                })
              }),
            ),
      )
    }

    // ---------------- :名字: 速记渲染 ----------------
    // 正文里写 `:思考:`（默认宽）或 `:思考@40:`（指定宽），渲染成 <img>。
    // 名字对着活库（api/dsh-emoji/list，每分钟刷新）精确匹配；库里没有的
    // 写法原样保留——没被替换本身就是可见的失败信号，不猜、不静默。
    // 注入的是真实 DOM <img>，不走 markdown 渲染管线，因此不受宿主
    // imageSource 只放行 http/https 的约束，src 用 document-relative 即可。
    // 结构性安全：只动文本节点（跳过 pre/code/script/style/textarea 与
    // contenteditable 祖先）；扫过的文本节点记入 WeakSet，React 换了节点
    // 对象就自然重扫；DOM 攒到安静 400ms 或最多 2.5s 就冲一次——用泵而不是防抖，
    // 因为页面上任何常驻动画/计时器都会把防抖的定时器无限重置、令其永不执行。

    var SHORTCUT_KILL_SWITCH = 'dsh.emoji.shorthand'
    var SHORTCUT_DEFAULT_WIDTH = 150
    var SHORTCUT_QUIET_MS = 400
    var SHORTCUT_MAX_WAIT_MS = 2500
    var SHORTCUT_PUMP_MS = 200
    var SHORTCUT_REFRESH_MS = 60000
    var SHORTCUT_SKIP_TAGS = { SCRIPT: 1, STYLE: 1, PRE: 1, CODE: 1, TEXTAREA: 1 }
    var SHORTCUT_TOKEN_RE = /:([^:\s][^:]*?):/g

    /** 已扫过的文本节点。WeakSet 不挡 GC；React 替换节点对象即自动重扫。 */
    var seenTextNodes = new WeakSet()

    /**
     * 解析 `名字` / `名字@宽` 写法。
     * @param {string} raw 冒号之间截出的原文
     * @param {Set<string>} names 库内名字集合（来自 list 端点，已规范化）
     * @param {number} defaultWidth 无 @宽 后缀时的宽度
     * @returns {name, width} 或 null（库中无此名，调用方保持原文）
     */
    function resolveShorthand(raw, names, defaultWidth) {
      if (names.has(raw)) return { name: raw, width: defaultWidth }
      var m = /^(.*)@(\d{1,4})$/.exec(raw)
      if (m !== null && names.has(m[1])) {
        var w = Math.round(Number(m[2]))
        // 宽度与宿主 parseWidth 同界：4..2048；越界按未命中处理，保持原文。
        if (w >= 4 && w <= 2048) return { name: m[1], width: w }
      }
      return null
    }

    /** 速记开关：localStorage 记 off 即整体停用（改完刷新页面生效）。 */
    function shortcutEnabled() {
      try {
        return localStorage.getItem(SHORTCUT_KILL_SWITCH) !== 'off'
      } catch {
        return true
      }
    }

    /** 对单个文本节点做替换：命中的 token 拆成 [文本, img, 文本…]。 */
    function replaceInTextNode(node, state) {
      var text = node.nodeValue
      if (text === null || text.indexOf(':') < 0) return
      var parent = node.parentElement
      if (parent === null) return
      SHORTCUT_TOKEN_RE.lastIndex = 0
      var match
      var hits = null
      while ((match = SHORTCUT_TOKEN_RE.exec(text)) !== null) {
        var hit = resolveShorthand(match[1], state.names, SHORTCUT_DEFAULT_WIDTH)
        if (hit !== null) {
          if (hits === null) hits = []
          hits.push({ start: match.index, end: match.index + match[0].length, hit: hit })
        }
      }
      seenTextNodes.add(node)
      if (hits === null) return
      var frag = document.createDocumentFragment()
      var cursor = 0
      for (var i = 0; i < hits.length; i++) {
        var token = hits[i]
        if (token.start > cursor) {
          frag.appendChild(document.createTextNode(text.slice(cursor, token.start)))
        }
        var img = document.createElement('img')
        img.className = 'dsh-emoji-shortcut'
        img.alt = token.hit.name
        img.title = token.hit.name
        img.width = token.hit.width
        img.style.height = 'auto'
        img.style.verticalAlign = 'middle'
        img.src = API.image + '?name=' + encodeURIComponent(token.hit.name) + '&w=' + String(token.hit.width)
        frag.appendChild(img)
        cursor = token.end
      }
      if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)))
      parent.replaceChild(frag, node)
    }

    /**
     * 扫描一个根（元素或文本节点）子树里的全部文本节点。
     *
     * 必须**先收集、后修改**：TreeWalker 遍历的是活 DOM，一旦在遍历途中
     * 用 replaceChild 把当前节点摘下来，遍历器就停在原地——症状是整棵子树
     * 只替换了第一处、其余静默漏掉（实测：五个用例只中一个，且不报错）。
     */
    function scanRoot(root, state, force) {
      if (typeof document === 'undefined' || document.createTreeWalker === undefined) return
      if (root.nodeType === 1 && SHORTCUT_SKIP_TAGS[root.tagName] !== undefined) return
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) {
          var value = n.nodeValue
          if (value === null || value.indexOf(':') < 0) return NodeFilter.FILTER_REJECT
          var p = n.parentElement
          while (p !== null) {
            if (SHORTCUT_SKIP_TAGS[p.tagName] !== undefined || p.isContentEditable) return NodeFilter.FILTER_REJECT
            p = p.parentElement
          }
          return NodeFilter.FILTER_ACCEPT
        },
      })
      var targets = []
      var node
      while ((node = walker.nextNode()) !== null) {
        if (!force && seenTextNodes.has(node)) continue
        targets.push(node)
      }
      for (var i = 0; i < targets.length; i++) {
        try {
          replaceInTextNode(targets[i], state)
        } catch {
          /* 单节点失败不拖累整轮 */
        }
      }
    }

    /** 挂在 shell.overlay 上的空渲染组件：唯一职责是启停扫描器。 */
    function Shortcuts() {
      react.useEffect(function () {
        if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return undefined
        if (!shortcutEnabled()) return undefined
        var state = { names: new Set() }
        var alive = true
        var pending = []
        var pendingSince = 0
        var lastMutationAt = 0

        /** 攒根：只登记，不动手。 */
        function schedule(root, force) {
          pending.push({ root: root, force: force === true })
          lastMutationAt = Date.now()
          if (pendingSince === 0) pendingSince = lastMutationAt
        }

        /** 冲一次：去重后逐根扫描。 */
        function flush() {
          if (!alive) {
            pending = []
            return
          }
          if (pending.length === 0) return
          pendingSince = 0
          var uniq = []
          var marks = new Set()
          var forceAll = false
          for (var i = 0; i < pending.length; i++) {
            var entry = pending[i]
            if (marks.has(entry.root)) {
              if (entry.force) forceAll = true
              continue
            }
            marks.add(entry.root)
            uniq.push(entry.root)
            if (entry.force) forceAll = true
          }
          pending = []
          for (var k = 0; k < uniq.length; k++) {
            try {
              scanRoot(uniq[k], state, forceAll)
            } catch {
              /* 整根失败不中断其余根 */
            }
          }
        }

        // 泵：安静够久就冲，攒太久也冲。
        //
        // 这里**不能**用「每次变更重置定时器」的防抖写法：页面上只要有常驻动画、
        // 计时器或状态轮播在动 DOM，定时器就会被无限重置，flush 永不执行。
        // 实测（test/shortcut-browser/?noise=1，干扰源每 100ms 变更一次）：
        // 5 秒后一张图都没替换且不报错——正是 GUI 里「什么都没有」的成因。
        var pump = setInterval(function () {
          if (!alive || pending.length === 0) return
          var now = Date.now()
          if (now - lastMutationAt >= SHORTCUT_QUIET_MS || now - pendingSince >= SHORTCUT_MAX_WAIT_MS) flush()
        }, SHORTCUT_PUMP_MS)

        async function refresh() {
          try {
            var data = await request(API.list)
            if (!alive || !Array.isArray(data.items)) return
            state.names = new Set(
              data.items.map(function (item) {
                return item.name
              }),
            )
          } catch {
            /* 名单拉不到就先不渲染，下一轮再试 */
          }
        }

        async function boot() {
          await refresh()
          if (!alive) return
          schedule(document.body, false)
        }
        boot()
        var refreshTimer = setInterval(function () {
          refresh().then(function () {
            if (alive) schedule(document.body, true)
          })
        }, SHORTCUT_REFRESH_MS)

        // 设置页切包后广播：名单立即换，不必等下一次轮询。
        var onPackChanged = function () {
          refresh().then(function () {
            if (alive) schedule(document.body, true)
          })
        }
        window.addEventListener('dsh-emoji:pack-changed', onPackChanged)

        var observer = new MutationObserver(function (records) {
          for (var i = 0; i < records.length; i++) {
            var record = records[i]
            for (var j = 0; j < record.addedNodes.length; j++) {
              schedule(record.addedNodes[j], false)
            }
            if (record.type === 'characterData' && record.target !== null) {
              // 原地改写的文本节点可能已扫过，必须强制重扫其所在元素。
              schedule(record.target.parentElement === null ? record.target : record.target.parentElement, true)
            }
          }
        })
        observer.observe(document.body, { childList: true, subtree: true, characterData: true })

        return function () {
          alive = false
          clearInterval(pump)
          clearInterval(refreshTimer)
          window.removeEventListener('dsh-emoji:pack-changed', onPackChanged)
          observer.disconnect()
        }
      }, [])
      return null
    }

    /** 本插件需要的客户端服务。 */
    var inject = ['slots', 'locale']

    /**
     * 挂载「设置 → 表情包」区块。
     * @param ctx - 浏览器插件上下文。
     */
    function apply(ctx) {
      var unregister = ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: 'emoji',
            order: 40,
            label: function () {
              return '表情包'
            },
          },
          EmojiSection,
        )
      })
      var unregisterShortcuts = ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'emoji-shortcuts',
            order: 950,
            label: function () {
              return '表情包速记'
            },
          },
          Shortcuts,
        )
      })
      if (typeof ctx.effect === 'function') {
        // ctx.effect 的语义是「回调**返回** teardown」，宿主在挂载时就会执行这个
        // 回调去取 disposer。若在这里直接调用拆卸，注册会在挂载瞬间被自己拆掉——
        // 外观上就是设置页与速记一起消失，且不报错。
        ctx.effect(function () {
          return function () {
            unregister()
            unregisterShortcuts()
          }
        }, 'dsh-emoji: settings section + shell overlay')
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.EmojiSection = EmojiSection
    exports.Shortcuts = Shortcuts
    exports.resolveShorthand = resolveShorthand
    return module.exports
  },
})
