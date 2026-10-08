/**
 * Paste shortcut over the Bot Screen (#135262).
 *
 * noVNC stops every keydown on its canvas, preventDefault included, which cancels the browser's own
 * paste: Ctrl+V / Cmd+V never raise the `paste` event the clipboard bridge listens for, and the
 * remote only receives the key (macOS Cmd travels as Alt, so Cmd+V typed "v"). The pane takes the
 * shortcut first, in the capture phase: it pushes the local clipboard as ClientCutText, then presses
 * Ctrl+V on the remote so the screen pastes it. Only an explicit shortcut reads the clipboard.
 */

const XK_CONTROL_L = 0xffe3
const XK_V = 0x0076
/** What noVNC holds on the remote for a macOS Cmd key (keyboard.js remaps Super_L→Alt_L, Super_R→Super_L). */
const MAC_CMD_KEYSYM: Readonly<Record<string, number>> = { MetaLeft: 0xffe9, MetaRight: 0xffeb }

export interface PasteClient {
  viewOnly: boolean
  sendKey: (keysym: number, code: string, down: boolean) => void
}

/** noVNC's own `browser.isMac()` test: whether it remaps Cmd, which is what the key dance depends on. */
const novncRemapsCmd = (): boolean => typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)

/** Ctrl+V, or Cmd+V where noVNC treats the host as macOS. Shift/Alt variants stay with noVNC. */
export function isPasteShortcut(event: KeyboardEvent): boolean {
  return (
    event.code === 'KeyV' &&
    !event.altKey &&
    !event.shiftKey &&
    (event.ctrlKey || (event.metaKey && novncRemapsCmd()))
  )
}

/**
 * Press Ctrl+V on the remote with nothing else held, given the keys the user still holds (*held*, by
 * `KeyboardEvent.code`): lift the Cmd keysym noVNC is holding, add Ctrl only when the user's own Ctrl
 * is no longer down, and restore both so noVNC's later releases still match.
 */
export function pressRemotePaste(client: PasteClient, held: ReadonlySet<string>): void {
  const cmd = novncRemapsCmd() ? Object.keys(MAC_CMD_KEYSYM).filter(code => held.has(code)) : []
  const ctrlHeld = held.has('ControlLeft') || held.has('ControlRight')

  for (const code of cmd) {
    client.sendKey(MAC_CMD_KEYSYM[code], code, false)
  }

  if (!ctrlHeld) {
    client.sendKey(XK_CONTROL_L, 'ControlLeft', true)
  }

  client.sendKey(XK_V, 'KeyV', true)
  client.sendKey(XK_V, 'KeyV', false)

  if (!ctrlHeld) {
    client.sendKey(XK_CONTROL_L, 'ControlLeft', false)
  }

  for (const code of cmd) {
    client.sendKey(MAC_CMD_KEYSYM[code], code, true)
  }
}

/**
 * Take the paste shortcut on *target* (an ancestor of noVNC's canvas) before noVNC sees it: the
 * keydown and its keyup are swallowed, *push* gets the local clipboard, then the remote is pressed.
 * Returns the unbind. Watch-only viewers are left alone and never read the clipboard.
 */
export function bindPasteShortcut(
  target: HTMLElement,
  client: PasteClient,
  push: (text: string) => void,
  readClipboard: () => Promise<string>
): () => void {
  const held = new Set<string>()
  const swallowed = new Set<string>()

  const onKeyDown = (event: KeyboardEvent) => {
    held.add(event.code)

    if (client.viewOnly || !isPasteShortcut(event)) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    swallowed.add(event.code)
    void readClipboard()
      .catch(() => '')
      .then(text => {
        if (client.viewOnly) {
          return
        }

        if (text) {
          push(text)
        }

        pressRemotePaste(client, held)
      })
  }

  const onKeyUp = (event: KeyboardEvent) => {
    held.delete(event.code)

    if (swallowed.delete(event.code)) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  // noVNC releases every key it holds when the canvas loses focus; forget ours with it.
  const onFocusOut = () => {
    held.clear()
    swallowed.clear()
  }

  target.addEventListener('keydown', onKeyDown, true)
  target.addEventListener('keyup', onKeyUp, true)
  target.addEventListener('focusout', onFocusOut, true)

  return () => {
    target.removeEventListener('keydown', onKeyDown, true)
    target.removeEventListener('keyup', onKeyUp, true)
    target.removeEventListener('focusout', onFocusOut, true)
  }
}
