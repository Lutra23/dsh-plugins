//#region Host half
/**
 * dsh-chat-rewind host half. Pure UI plugin: this empty apply exists so the
 * plugin appears in the host cordis.yml / Loader; the browser half ships via
 * exports["./client"], discovered through the package.json `dsh.client`
 * declaration.
 *
 * All rewind work runs in the browser against official remotes only:
 *   - remote.session.page   — cold-read transcript pages (plan computation)
 *   - ctx.sessions.fork     — official fork API (never mutates the source log)
 *   - remote.session.prompt — replay the edited user text into the child
 *   - ctx.uiWorkspace.openSession — switch the GUI to the child session
 */
function apply() {}
//#endregion
export { apply };
