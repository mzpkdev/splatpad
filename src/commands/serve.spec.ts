import { resolve } from 'node:path'
import {
  beforeEach,
  describe,
  describe as context,
  expect,
  it,
  vi,
} from 'vitest'

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  createServer: vi.fn(),
  createSiteConfig: vi.fn(() => ({ config: true })),
  listen: vi.fn(),
  printUrls: vi.fn(),
  terminal: { json: vi.fn(), log: vi.fn(), quiet: false, jsonMode: false },
}))

vi.mock('cmdore', () => ({
  defineArgument: vi.fn((value) => value),
  defineCommand: vi.fn((value) => value),
  defineOption: vi.fn((value) => value),
  effect: vi.fn((value) => value),
  terminal: mocks.terminal,
}))
vi.mock('vite', () => ({ createServer: mocks.createServer }))
vi.mock('../core/site-config', () => ({
  createSiteConfig: mocks.createSiteConfig,
}))

import { serve } from './serve'

describe('serve', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.terminal.quiet = false
    mocks.terminal.jsonMode = false
    mocks.createServer.mockResolvedValue({
      close: mocks.close,
      listen: mocks.listen,
      printUrls: mocks.printUrls,
      resolvedUrls: { local: ['http://localhost:4173/'], network: [] },
    })
  })

  it('listens with the requested site and network configuration', async () => {
    const waitForTermination = vi.fn().mockResolvedValue(undefined)
    const absoluteRoot = resolve(process.cwd(), 'fixtures/site')

    await serve('fixtures/site', '127.0.0.1', 4173, waitForTermination)

    expect(mocks.createSiteConfig).toHaveBeenCalledWith(absoluteRoot, {
      server: { host: '127.0.0.1', port: 4173 },
    })
    expect(mocks.listen).toHaveBeenCalledOnce()
    expect(mocks.printUrls).toHaveBeenCalledOnce()
    expect(waitForTermination).toHaveBeenCalledOnce()
    expect(mocks.close).toHaveBeenCalledOnce()
  })

  context('when terminal output is machine-readable', () => {
    it('reports server data without printing interactive URLs', async () => {
      mocks.terminal.jsonMode = true

      await serve('.', undefined, undefined, async () => undefined)

      expect(mocks.printUrls).not.toHaveBeenCalled()
      expect(mocks.terminal.json).toHaveBeenCalledWith({
        command: 'serve',
        root: process.cwd(),
        urls: { local: ['http://localhost:4173/'], network: [] },
      })
    })
  })

  context('when termination waiting fails', () => {
    it('closes the Vite server before propagating the failure', async () => {
      const failure = new Error('termination failed')

      await expect(
        serve('.', undefined, undefined, async () => Promise.reject(failure)),
      ).rejects.toBe(failure)
      expect(mocks.close).toHaveBeenCalledOnce()
    })
  })
})
