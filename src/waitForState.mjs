export async function waitForState(state, select, { signal, timeoutMs = 1800000 } = {}) {
  signal?.throwIfAborted()
  const watch = await state.watch()
  let timer
  let onAbort
  try {
    return await new Promise((resolve, reject) => {
      const update = value => {
        try {
          const result = select(value)
          if (result !== undefined) resolve(result)
        }
        catch (error) { reject(error) }
      }
      onAbort = () => reject(signal.reason)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
      if (timeoutMs !== null) timer = setTimeout(() => resolve(null), timeoutMs)
      update(watch.value)
      watch.start(call => { if (call.kind === 'value') update(call.value) })
      watch.closed.then(end => {
        if (end.kind !== 'stopped') reject(new Error('State watch closed'))
      })
    })
  }
  finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    await watch.stop()
  }
}
