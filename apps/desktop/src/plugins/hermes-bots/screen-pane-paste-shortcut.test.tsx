/**
 * Paste shortcut over the live screen (#135262). noVNC stops every keydown on its canvas,
 * preventDefault included, so Ctrl+V / Cmd+V never raised the `paste` event the clipboard bridge
 * listens for: the remote only got the key (macOS Cmd travels as Alt, so Cmd+V typed "v"). The
 * pane must take the shortcut before noVNC, push the local clipboard as ClientCutText, then press
 * Ctrl+V on the remote — and only while it holds the lease.
 */

import { fireEvent, render, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, type Mock, vi } from 'vitest'

import type { DisplayStatus } from './screen-connection'
import type * as ScreenConnection from './screen-connection'
import type { RosterRow } from './types'

interface FakeRfb {
  canvas: HTMLElement
  viewOnly: boolean
  clipboardPasteFrom: Mock
  sendKey: Mock
  reachedNoVnc: string[]
}

const rfbs = vi.hoisted(() => [] as FakeRfb[])

vi.mock('@hermes/plugin-sdk', async () => {
  const { useStore } = await import('@nanostores/react')
  const { onGatewayEvent } = await import('../../contrib/events')

  return {
    Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
      <button {...props}>{children}</button>
    ),
    Codicon: () => null,
    GlyphSpinner: () => null,
    Tip: ({ children }: { children: ReactNode }) => <>{children}</>,
    EmptyState: () => null,
    useValue: useStore,
    host: { onEvent: onGatewayEvent, retainProfile: async () => () => {} }
  }
})
vi.mock('./routing', () => {
  const route = { connectionId: 'host-a', mode: 'remote', profile: 'default', targetProfile: 'default' }

  return { botConnectionRoute: () => route, resolveBotConnectionRoute: () => ({ status: 'resolved', route }) }
})
vi.mock('./data', () => ({ botSelectionKey: (bot: RosterRow) => bot.name }))
vi.mock('./i18n', () => ({
  useBots: () => ({
    screen: {
      title: 'Screen',
      youControl: 'You control',
      handBack: 'Hand back',
      takeOver: 'Take over',
      reconnect: 'Reconnect',
      streamLost: 'Stream lost'
    }
  })
}))
vi.mock('./screen-connection', async importActual => ({
  ...(await importActual<typeof ScreenConnection>()),
  displayRequest: vi.fn(),
  resolveScreenWsUrl: vi.fn(async () => 'ws://localhost/api/display/ws'),
  isEventForBotScreen: () => false
}))
vi.mock('@novnc/novnc', () => ({
  default: class {
    viewOnly = true
    clipboardPasteFrom = vi.fn()
    sendKey = vi.fn()
    reachedNoVnc: string[] = []
    canvas: HTMLElement
    constructor(target: HTMLElement) {
      // Like noVNC: its keyboard listens on a canvas inside the target and stops every key event.
      this.canvas = target.ownerDocument.createElement('canvas')
      target.appendChild(this.canvas)

      for (const type of ['keydown', 'keyup'] as const) {
        this.canvas.addEventListener(type, event => {
          this.reachedNoVnc.push(`${type}:${event.code}`)
          event.preventDefault()
          event.stopPropagation()
        })
      }

      rfbs.push(this as never)
    }
    addEventListener(type: string, callback: (event: { detail?: unknown }) => void) {
      if (type === 'connect') {
        queueMicrotask(() => callback({}))
      }
    }
    disconnect() {}
    focus() {}
  }
}))

import { displayRequest } from './screen-connection'
import { BotScreenPane } from './screen-pane'
import { $screenState } from './screen-state'

const XK_CONTROL_L = 0xffe3
const XK_ALT_L = 0xffe9
const XK_V = 0x76

const bot: RosterRow = { name: 'default' }

// viewer_hash "e0f9a555d558" is sha256("this-viewer")[:12], which makes this viewer the lease holder.
const status: DisplayStatus = {
  profile: 'default',
  profile_key: '/home/hermes/.hermes',
  supported: true,
  installed: true,
  missing: [],
  running: true,
  pid: 42,
  display: ':20',
  socket: '/tmp/rfb.sock',
  geometry: '1440x900',
  install_command: null,
  lease: { holder: 'human', viewer_id: null, viewer_hash: 'e0f9a555d558', since: 1, reason: '', epoch: 1 }
}

let readClipboard: Mock

beforeEach(() => {
  $screenState.set({})
  rfbs.length = 0
  vi.mocked(displayRequest)
    .mockReset()
    .mockResolvedValue({ ...status, ticket: 'test-ticket', viewer_id: 'this-viewer' })
  vi.stubGlobal(
    'WebSocket',
    class {
      binaryType = ''
      addEventListener() {}
      close() {}
    }
  )
  readClipboard = vi.fn().mockResolvedValue('copied on this computer')
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = { readClipboard }
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

async function liveScreen(viewOnly = false): Promise<FakeRfb> {
  render(<BotScreenPane bot={bot} />)
  await waitFor(() => expect(rfbs).toHaveLength(1))
  await waitFor(() => expect(rfbs[0].viewOnly).toBe(viewOnly))

  return rfbs[0]
}

it('Ctrl+V pushes the local clipboard, then pastes it on the remote instead of handing noVNC a bare V', async () => {
  const rfb = await liveScreen()

  fireEvent.keyDown(rfb.canvas, { code: 'ControlLeft', key: 'Control', ctrlKey: true })
  fireEvent.keyDown(rfb.canvas, { code: 'KeyV', key: 'v', ctrlKey: true })
  fireEvent.keyUp(rfb.canvas, { code: 'KeyV', key: 'v', ctrlKey: true })

  await waitFor(() => expect(rfb.sendKey).toHaveBeenCalledTimes(2))
  expect(rfb.clipboardPasteFrom).toHaveBeenCalledWith('copied on this computer')
  // The remote still holds Ctrl from noVNC, so V alone makes Ctrl+V, after the cut text arrives.
  expect(rfb.sendKey.mock.calls).toEqual([
    [XK_V, 'KeyV', true],
    [XK_V, 'KeyV', false]
  ])
  expect(rfb.clipboardPasteFrom.mock.invocationCallOrder[0]).toBeLessThan(rfb.sendKey.mock.invocationCallOrder[0])
  expect(rfb.reachedNoVnc).toEqual(['keydown:ControlLeft'])
})

it('macOS Cmd+V becomes Ctrl+V on the remote rather than the Alt+V noVNC would send', async () => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
  const rfb = await liveScreen()

  fireEvent.keyDown(rfb.canvas, { code: 'MetaLeft', key: 'Meta', metaKey: true })
  fireEvent.keyDown(rfb.canvas, { code: 'KeyV', key: 'v', metaKey: true })

  await waitFor(() => expect(rfb.sendKey).toHaveBeenCalledTimes(6))
  expect(rfb.clipboardPasteFrom).toHaveBeenCalledWith('copied on this computer')
  // noVNC holds Cmd as Alt_L on the remote: lift it around a clean Ctrl+V, then restore it.
  expect(rfb.sendKey.mock.calls).toEqual([
    [XK_ALT_L, 'MetaLeft', false],
    [XK_CONTROL_L, 'ControlLeft', true],
    [XK_V, 'KeyV', true],
    [XK_V, 'KeyV', false],
    [XK_CONTROL_L, 'ControlLeft', false],
    [XK_ALT_L, 'MetaLeft', true]
  ])
  expect(rfb.reachedNoVnc).toEqual(['keydown:MetaLeft'])
})

it('pastes again without re-pushing an unchanged clipboard, so a copy made on the screen survives', async () => {
  const rfb = await liveScreen()

  fireEvent.keyDown(rfb.canvas, { code: 'ControlLeft', key: 'Control', ctrlKey: true })

  for (let i = 0; i < 2; i += 1) {
    fireEvent.keyDown(rfb.canvas, { code: 'KeyV', key: 'v', ctrlKey: true })
    fireEvent.keyUp(rfb.canvas, { code: 'KeyV', key: 'v', ctrlKey: true })
    await waitFor(() => expect(rfb.sendKey).toHaveBeenCalledTimes(2 * (i + 1)))
  }

  expect(rfb.clipboardPasteFrom).toHaveBeenCalledTimes(1)
})

it('leaves the shortcut to noVNC and never reads the clipboard while only watching', async () => {
  vi.mocked(displayRequest).mockResolvedValue({
    ...status,
    lease: { ...status.lease, viewer_hash: 'someone-else' },
    ticket: 'test-ticket',
    viewer_id: 'this-viewer'
  })
  const rfb = await liveScreen(true)

  fireEvent.keyDown(rfb.canvas, { code: 'KeyV', key: 'v', ctrlKey: true })

  expect(rfb.reachedNoVnc).toEqual(['keydown:KeyV'])
  expect(readClipboard).not.toHaveBeenCalled()
  expect(rfb.clipboardPasteFrom).not.toHaveBeenCalled()
})
