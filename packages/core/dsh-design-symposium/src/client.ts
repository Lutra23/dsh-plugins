/**
 * dsh-design-symposium — client half (browser bundle).
 *
 * Boot contract (verified against the kernel, 2026-10-28): the Loader's combo
 * scripts are ordinary <script> tags, so this file must ship as a factory-CJS
 * registration — `scripts/build.mjs` wraps the esbuild CJS body into
 * `window.__ModuleLoader__.load({ id, factory })`. Never emit ESM here: a
 * top-level `export` in the shipped bundle kills the whole GUI at parse time
 * (renderer.recovery has no fallback for a bundle that cannot parse).
 *
 * Minimal static tab first: declare the two services through cordis `inject`
 * (activation waits for them), register the tab kind and the pane slot,
 * nothing else. Reads stay defensive, so a profile without the right bar
 * loads the plugin with no tab instead of failing boot.
 */

declare const require: (id: string) => any;

/** Tab implementation id; also the slot key the body registers under. */
const TAB_ID = 'dsh-design-symposium';

/** Tab kind this plugin owns. */
const KIND = 'symposium-panel';

/** Where the page lives, relative to the app origin. */
const PANEL_PATH = '/api/plugins/dsh-design-symposium/panel';

/** Services this client half needs before `apply` runs (cordis fiber inject). */
export const inject = ['sidebarRightTabs', 'slots'];

/** The smallest slice of the tab registry this file needs. */
interface TabRegistry {
  register(options: {
    id: string;
    kind: string;
    title: (address: string) => string;
    keepMounted?: boolean;
    /** Entry boxes on the right-bar guide page; each opens this tab type. */
    guide?: {
      id: string;
      order?: number;
      title: () => string;
      description: () => string;
    }[];
  }): () => void;
}

/** The smallest slice of the slot service this file needs. */
interface SlotService {
  inject(name: string, fn: () => unknown): void;
  register(options: { name: string; key: string }, component: unknown): () => void;
}

/** The smallest slice of the client context this file needs. */
interface ClientContext {
  effect?(factory: () => unknown, label?: string): unknown;
  sidebarRightTabs?: TabRegistry;
  slots?: SlotService;
}

/**
 * Mount the panel tab.
 * @param ctx - the client root context.
 */
export function apply(ctx: ClientContext): void {
  const tabs = ctx.sidebarRightTabs;
  const slots = ctx.slots;
  if (tabs === undefined || slots === undefined || ctx.effect === undefined) {
    // No right bar in this profile: keep the rest of the plugin working.
    return;
  }

  // 1) Declare the tab kind. The disposer rides the plugin's lifecycle.
  ctx.effect(() => tabs.register({
    id: TAB_ID,
    kind: KIND,
    title: () => '研讨现场',
    keepMounted: true,
    guide: [{
      id: 'open',
      order: 55,
      title: () => '研讨现场',
      description: () => '查看贤者研讨的实时发言；暂停求证时在这里看问题。',
    }],
  }), 'symposium: panel tab kind');

  // 2) The tab body: the page, framed. `key` matches the registered id.
  ctx.effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register({
    name: 'sidebar.right.pane.tab',
    key: TAB_ID,
  }, PanelFrame)), 'symposium: panel tab body');
}

/**
 * The framed page. React arrives through the Loader's `require` at render
 * time (react is a platform-seed module), so a renderer change cannot break
 * boot — the failure would surface only when this tab renders, and even then
 * as a plain placeholder instead of a throw inside a slot.
 * @returns the iframe element.
 */
function PanelFrame(): unknown {
  let React: { createElement?: (type: string, props: unknown) => unknown };
  try {
    React = require('react');
  } catch {
    return null;
  }
  if (React === undefined || typeof React.createElement !== 'function') return null;
  return React.createElement('iframe', {
    src: PANEL_PATH,
    title: '研讨现场',
    style: {
      width: '100%',
      height: '100%',
      border: '0',
      display: 'block',
      background: '#0b0f14',
    },
  });
}
