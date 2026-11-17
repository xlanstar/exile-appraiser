/**
 * macOS:查價熱鍵(按住 hold 鍵 + 主鍵,例如 Ctrl + D)送複製鍵時,**不送使用者還按著的 hold 鍵的放開**(2026-11-18)。
 *
 * 問題(macOS + CrossOver 實機 log):按 Ctrl + D 查價面板出現,手還按著 Ctrl 一動滑鼠面板就關掉
 * (`[tracker] 游標離開 41.8px > 40.0 → hide-exclusive-widget`,緊接著再按 Ctrl + D 也記到「少按 Ctrl」)。
 * 原因:APT 的 `pressKeysToCopyItemText` 在 Mac 上不過濾已按著的修飾鍵,一律送 Ctrl 按下 → C → **Ctrl 放開**
 * (libuiohook darwin `post_event.c` 送的鍵 flags 只取它自己的 post mask,不先送 Ctrl 按下,C 就不帶 Ctrl)。
 * 這個合成的 Ctrl 放開讓 libuiohook 的修飾鍵狀態(`process_modifier_changed`,也可能連同系統的 HID 狀態)變成「沒按 Ctrl」,
 * 之後 mousemove 的 `ctrlKey` 都是 false → `WidgetAreaTracker` 以為使用者沒按著 hold 鍵,游標一離開 40 px 就關面板。
 * Windows 不受影響:那裡已按著的修飾鍵本來就不送(SendInput 會套用實體按鍵狀態)。
 *
 * 做法(只在 darwin):
 * - 熱鍵觸發時 `begin(熱鍵的修飾鍵)`:持有一份 uiohook 掛鉤(看得到實體放開),先當成這些鍵都按著(全域熱鍵剛觸發)。
 * - 送複製鍵前 `copyKeyPlan`:修飾鍵照舊送按下(C 才帶 Ctrl),但使用者**到這時還按著**的不送放開,交給 `keep()` 記下。
 * - 使用者實體放開(掛鉤 keyup)→ 補送一次放開(此時實體已放開,無副作用;讓 libuiohook 的 post mask 歸零,之後送的鍵不會多帶 Ctrl)。
 * - 要送其他按鍵前(聊天指令、倉庫搜尋、正則貼上…)、程式結束、或保底 `HELD_KEYS_BACKSTOP_MS` 到了 → `flush()` 全部補送放開。
 * - 掛鉤沒在跑(start 失敗)→ 不知道實體狀態 → 照原本行為送放開(不冒卡住 Ctrl 的險)。
 *
 * 全部依賴可注入,`main/test/held-copy-keys.test.ts` 用假的送鍵 / 掛鉤 / 計時器,不送任何真實輸入。
 */

export type HeldModName = 'Ctrl' | 'Alt' | 'Shift' | 'Meta'

/** 保底:補送放開前最多等多久(使用者按著 hold 鍵把游標移進面板通常 1–2 秒;進到面板後 overlay 有焦點就不再看 hold 鍵) */
export const HELD_KEYS_BACKSTOP_MS = 10_000

export interface CopyKeyPlan {
  /** 依序送按下的鍵 */
  down: string[]
  /** 送完 C 後依序送放開的鍵 */
  up: string[]
  /** 送了按下、但不送放開(使用者還按著;只有 darwin) */
  keep: string[]
}

/**
 * 送「複製物品文字」組合鍵(`combo`,例如 `Ctrl + C` / `Ctrl + Alt + C`)的修飾鍵計畫(C 本身由呼叫端 keyTap)。
 * - 非 darwin:與 APT 相同 —— 已按著的修飾鍵(`pressedModKeys`)不送按下也不送放開。
 * - darwin:修飾鍵一律送按下;已按著且 `stillHeld` 為真的不送放開(`keep`)。
 */
export function copyKeyPlan (
  combo: string,
  pressedModKeys: readonly string[],
  platform: string,
  stillHeld: (key: string) => boolean = () => false
): CopyKeyPlan {
  const keys = combo.split(' + ').filter(key => key !== 'C')
  if (platform !== 'darwin') {
    const toggled = keys.filter(key => !pressedModKeys.includes(key))
    return { down: toggled, up: [...toggled].reverse(), keep: [] }
  }
  const keep = keys.filter(key => pressedModKeys.includes(key) && stillHeld(key))
  return { down: keys, up: keys.filter(key => !keep.includes(key)).reverse(), keep }
}

/** uiohook keycode(左右兩顆)→ 修飾鍵名稱;不是修飾鍵回 undefined */
export function modNameOfKeycode (keycode: number, codes: Record<string, number>): HeldModName | undefined {
  for (const name of ['Ctrl', 'Alt', 'Shift', 'Meta'] as const) {
    if (keycode === codes[name] || keycode === codes[`${name}Right`]) return name
  }
  return undefined
}

export interface HeldCopyKeysDeps {
  /** 送一次修飾鍵放開(main = `uIOhook.keyToggle(UiohookKey[key], 'up')`) */
  postUp: (key: string) => void
  gate: { acquire: () => void, release: () => void, readonly isRunning: boolean }
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (t: unknown) => void
  log?: (msg: string) => void
  backstopMs?: number
}

export class HeldCopyKeys {
  /** 這次熱鍵的修飾鍵,目前判斷為實體按著的 */
  private physical = new Set<string>()
  /** 送了按下、還沒送放開的 */
  private pending = new Set<string>()
  private active = false
  private timer: unknown
  private readonly setT: (fn: () => void, ms: number) => unknown
  private readonly clearT: (t: unknown) => void
  private readonly log: (msg: string) => void

  constructor (private readonly deps: HeldCopyKeysDeps) {
    this.setT = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearT = deps.clearTimeout ?? ((t) => { clearTimeout(t as ReturnType<typeof setTimeout>) })
    this.log = deps.log ?? ((msg) => { console.log(msg) })
  }

  /** 送了按下、還沒送放開的鍵(診斷 / 測試) */
  get pendingKeys (): string[] { return [...this.pending] }
  get isActive (): boolean { return this.active }

  /** 查價熱鍵觸發:持有掛鉤以看到實體放開;熱鍵的修飾鍵此刻一定按著 */
  begin (mods: readonly string[]): void {
    if (!this.active) {
      this.active = true
      this.deps.gate.acquire()
    }
    this.clearBackstop()
    this.physical = new Set(mods)
  }

  /** 送複製鍵前:這個修飾鍵使用者是否還按著(掛鉤沒在跑 = 不知道 → false,照原本送放開) */
  isHeld (key: string): boolean {
    return this.active && this.deps.gate.isRunning && this.physical.has(key)
  }

  /** 送完複製鍵:記下沒送放開的鍵;沒有就結束這次 */
  keep (keys: readonly string[]): void {
    if (!this.active) return
    this.pending = new Set(keys)
    if (!this.pending.size) {
      this.end()
      return
    }
    this.log(`[shortcuts] macOS:${[...this.pending].join(' + ')} 還按著,等實體放開才送放開(查價面板靠它判斷 hold 鍵)`)
    this.clearBackstop()
    this.timer = this.setT(() => {
      this.timer = undefined
      this.flush('逾時')
    }, this.deps.backstopMs ?? HELD_KEYS_BACKSTOP_MS)
  }

  /** 送複製鍵前就放棄(剪貼簿準備失敗等) */
  cancel (): void {
    if (!this.pending.size) this.end()
  }

  /** 掛鉤看到修飾鍵放開(實體,或自己補送的) */
  onKeyUp (mod: HeldModName | undefined): void {
    if (!mod || !this.active) return
    this.physical.delete(mod)
    if (!this.pending.has(mod)) return
    this.pending.delete(mod)
    this.deps.postUp(mod)
    if (!this.pending.size) this.end()
  }

  /** 要送其他按鍵前 / 結束程式 / 逾時:補送全部放開 */
  flush (reason: string): void {
    if (this.pending.size) {
      const keys = [...this.pending].reverse()
      this.pending.clear()
      this.log(`[shortcuts] macOS:補送 ${keys.join(' + ')} 放開(${reason})`)
      for (const key of keys) this.deps.postUp(key)
    }
    if (this.active) this.end()
  }

  private end (): void {
    this.clearBackstop()
    this.physical.clear()
    if (!this.active) return
    this.active = false
    this.deps.gate.release()
  }

  private clearBackstop (): void {
    if (this.timer === undefined) return
    this.clearT(this.timer)
    this.timer = undefined
  }
}
