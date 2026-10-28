// DSH 0.2.0-rc.2 Session.requestContext(): exact prepared-call context, no network.
export function measureContext(tokenMeter, session, args = {}) {
  if (!session) throw new Error('ctx_meter requires an owning agent session')
  const m = tokenMeter.measure(session)
  const header = session.requestHeader?.()?.config
  const context = session.requestContext?.()
  const sameRoute = !!context && (!header || (header.provider === context.provider && header.model === context.model))
  const valid = n => Number.isSafeInteger(n) && n > 0
  if (args.windowTokens !== undefined && !valid(args.windowTokens)) throw new Error('windowTokens 必须是有限正整数')
  const windowTokens = args.windowTokens ?? (sameRoute && valid(context.contextWindow) ? context.contextWindow : undefined)
  const totalTokens = Number.isFinite(m.totalTokens) ? Math.max(0, m.totalTokens) : 0
  return {
    totalTokens, baselineKind: m.baseline?.kind || 'none', baselineTokens: m.baseline?.tokens || 0,
    surfaceTokens: m.surfaceTokens || 0, surfaceDeltaTokens: m.surfaceDeltaTokens || 0, logRevision: m.logRevision || 0,
    modelId: header?.model || context?.model || '', providerId: header?.provider || context?.provider || '',
    capacityStatus: windowTokens === undefined ? 'unknown' : 'known',
    windowSource: args.windowTokens !== undefined ? 'explicit' : windowTokens !== undefined ? 'session-request-context' : 'unknown',
    ...(windowTokens === undefined ? {} : { windowTokens, usedPercent: Math.round(totalTokens / windowTokens * 1000) / 10,
      remainingTokens: Math.max(0, windowTokens-totalTokens), overWindowTokens: Math.max(0, totalTokens-windowTokens) })
  }
}
