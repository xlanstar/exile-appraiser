// 2026-11-18 macOS:查價熱鍵送複製鍵時不送使用者還按著的 hold 鍵放開(held-copy-keys.ts)。
// 全部用假的送鍵 / 掛鉤 / 計時器,不送任何真實輸入。
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { copyKeyPlan, HeldCopyKeys, HELD_KEYS_BACKSTOP_MS, modNameOfKeycode } from '../src/held-copy-keys'

const CODES = { Ctrl: 29, CtrlRight: 3613, Alt: 56, AltRight: 3640, Shift: 42, ShiftRight: 54, Meta: 3675, MetaRight: 3676, C: 46, D: 32 }

describe('copyKeyPlan', () => {
  it('Windows:與 APT 相同,已按著的修飾鍵不送', () => {
    expect(copyKeyPlan('Ctrl + C', ['Ctrl'], 'win32', () => true)).toEqual({ down: [], up: [], keep: [] })
    expect(copyKeyPlan('Ctrl + C', [], 'win32')).toEqual({ down: ['Ctrl'], up: ['Ctrl'], keep: [] })
    expect(copyKeyPlan('Ctrl + Alt + C', ['Ctrl'], 'win32')).toEqual({ down: ['Alt'], up: ['Alt'], keep: [] })
    expect(copyKeyPlan('Ctrl + Alt + C', [], 'linux')).toEqual({ down: ['Ctrl', 'Alt'], up: ['Alt', 'Ctrl'], keep: [] })
  })

  it('macOS:修飾鍵一律送按下,還按著的 hold 鍵不送放開', () => {
    expect(copyKeyPlan('Ctrl + C', ['Ctrl'], 'darwin', () => true)).toEqual({ down: ['Ctrl'], up: [], keep: ['Ctrl'] })
    expect(copyKeyPlan('Ctrl + Alt + C', ['Ctrl'], 'darwin', () => true)).toEqual({ down: ['Ctrl', 'Alt'], up: ['Alt'], keep: ['Ctrl'] })
  })

  it('macOS:已放開 / 不知道實體狀態 = 原本行為(送放開,不冒卡住的險)', () => {
    expect(copyKeyPlan('Ctrl + C', ['Ctrl'], 'darwin', () => false)).toEqual({ down: ['Ctrl'], up: ['Ctrl'], keep: [] })
    expect(copyKeyPlan('Ctrl + C', ['Ctrl'], 'darwin')).toEqual({ down: ['Ctrl'], up: ['Ctrl'], keep: [] })
    // 鎖定查價(keepModKeys false)沒有按著的鍵
    expect(copyKeyPlan('Ctrl + C', [], 'darwin', () => true)).toEqual({ down: ['Ctrl'], up: ['Ctrl'], keep: [] })
  })
})

describe('modNameOfKeycode', () => {
  it('左右兩顆都對到同一個名稱', () => {
    expect(modNameOfKeycode(CODES.Ctrl, CODES)).toBe('Ctrl')
    expect(modNameOfKeycode(CODES.CtrlRight, CODES)).toBe('Ctrl')
    expect(modNameOfKeycode(CODES.AltRight, CODES)).toBe('Alt')
    expect(modNameOfKeycode(CODES.ShiftRight, CODES)).toBe('Shift')
    expect(modNameOfKeycode(CODES.Meta, CODES)).toBe('Meta')
    expect(modNameOfKeycode(CODES.D, CODES)).toBeUndefined()
  })
})

function setup (running = true) {
  const posts: string[] = []
  const gate = { holders: 0, isRunning: running, acquire: vi.fn(() => { gate.holders++ }), release: vi.fn(() => { gate.holders-- }) }
  let timerFn: (() => void) | undefined
  const held = new HeldCopyKeys({
    postUp: (k) => { posts.push(k) },
    gate,
    setTimeout: (fn, ms) => { expect(ms).toBe(HELD_KEYS_BACKSTOP_MS); timerFn = fn; return 1 },
    clearTimeout: () => { timerFn = undefined },
    log: () => {}
  })
  /** 模擬 Shortcuts 的一次 Ctrl + D:begin → (中間可能放開)→ 依計畫送鍵 → keep */
  const copy = (releasedBeforePost = false) => {
    held.begin(['Ctrl'])
    if (releasedBeforePost) held.onKeyUp('Ctrl')
    const plan = copyKeyPlan('Ctrl + C', ['Ctrl'], 'darwin', (k) => held.isHeld(k))
    held.keep(plan.keep)
    return plan
  }
  return { held, gate, posts, copy, fireTimer: () => { timerFn?.() }, hasTimer: () => timerFn !== undefined }
}

describe('HeldCopyKeys', () => {
  it('按著 Ctrl:不送放開;實體放開時補送一次並放掉掛鉤', () => {
    const t = setup()
    const plan = t.copy()
    expect(plan.up).toEqual([])
    expect(t.held.pendingKeys).toEqual(['Ctrl'])
    expect(t.gate.holders).toBe(1)
    expect(t.posts).toEqual([])
    // 游標移動時還按著:沒有任何補送(查價面板看得到 ctrlKey)
    t.held.onKeyUp('Alt')
    expect(t.posts).toEqual([])
    t.held.onKeyUp('Ctrl')
    expect(t.posts).toEqual(['Ctrl'])
    expect(t.held.pendingKeys).toEqual([])
    expect(t.gate.holders).toBe(0)
    expect(t.hasTimer()).toBe(false)
    // 自己補送的放開再回來一次:不再送
    t.held.onKeyUp('Ctrl')
    expect(t.posts).toEqual(['Ctrl'])
  })

  it('送複製鍵前就放開了:照原本送放開,不留任何鍵', () => {
    const t = setup()
    const plan = t.copy(true)
    expect(plan.up).toEqual(['Ctrl'])
    expect(t.held.pendingKeys).toEqual([])
    expect(t.gate.holders).toBe(0)
  })

  it('掛鉤沒在跑(start 失敗):不知道實體狀態 → 原本行為', () => {
    const t = setup(false)
    const plan = t.copy()
    expect(plan.up).toEqual(['Ctrl'])
    expect(t.gate.holders).toBe(0)
  })

  it('保底逾時:補送放開', () => {
    const t = setup()
    t.copy()
    t.fireTimer()
    expect(t.posts).toEqual(['Ctrl'])
    expect(t.gate.holders).toBe(0)
  })

  it('按著 Ctrl 連按兩次 D:不中途補送、只持有一份掛鉤', () => {
    const t = setup()
    t.copy()
    t.copy()
    expect(t.posts).toEqual([])
    expect(t.gate.holders).toBe(1)
    t.held.onKeyUp('Ctrl')
    expect(t.posts).toEqual(['Ctrl'])
    expect(t.gate.holders).toBe(0)
  })

  it('要送其他按鍵前 / 結束:flush 全部補送;沒有留著的鍵 = 什麼都不做', () => {
    const t = setup()
    t.held.flush('x')
    expect(t.posts).toEqual([])
    t.copy()
    t.held.flush('送其他按鍵前')
    expect(t.posts).toEqual(['Ctrl'])
    expect(t.gate.holders).toBe(0)
  })

  it('剪貼簿準備失敗(還沒送鍵)cancel:放掉掛鉤', () => {
    const t = setup()
    t.held.begin(['Ctrl'])
    t.held.cancel()
    expect(t.gate.holders).toBe(0)
    expect(t.posts).toEqual([])
  })
})

describe('接線守門', () => {
  const src = readFileSync(new URL('../src/Shortcuts.ts', import.meta.url), 'utf8')
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
  it('Shortcuts 依 copyKeyPlan 送鍵,只在 darwin 建 HeldCopyKeys', () => {
    expect(src).toMatch(/process\.platform === 'darwin'\s*\?\s*new HeldCopyKeys/)
    expect(src).toContain('copyKeyPlan(')
    expect(src).toContain('this.heldKeys?.keep(plan.keep)')
    expect(src).toContain("this.heldKeys?.flush('送其他按鍵前')")
    expect(src).toContain("uIOhook.on('keyup'")
  })
  it('正則貼上前與結束時補送放開', () => {
    expect(main).toContain("shortcuts.releaseHeldKeys('正則貼上前')")
    expect(main).toContain("shortcuts.releaseHeldKeys('結束程式')")
  })
})
