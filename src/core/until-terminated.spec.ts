import { afterEach, describe, expect, it, vi } from 'vitest'
import { untilTerminated } from './until-terminated'

describe('untilTerminated', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('waits for termination and removes both signal listeners afterward', async () => {
    const handlers = new Map<NodeJS.Signals, NodeJS.SignalsListener>()
    const once = vi.spyOn(process, 'once').mockImplementation((signal, handler) => {
      handlers.set(signal as NodeJS.Signals, handler as NodeJS.SignalsListener)
      return process
    })
    const off = vi.spyOn(process, 'off').mockReturnValue(process)

    const terminated = untilTerminated()
    const terminate = handlers.get('SIGTERM')

    expect(once).toHaveBeenCalledWith('SIGINT', expect.any(Function))
    expect(once).toHaveBeenCalledWith('SIGTERM', expect.any(Function))
    expect(terminate).toBeDefined()

    terminate?.('SIGTERM')
    await terminated

    const registeredHandler = handlers.get('SIGINT')
    expect(off).toHaveBeenCalledWith('SIGINT', registeredHandler)
    expect(off).toHaveBeenCalledWith('SIGTERM', registeredHandler)
  })
})
