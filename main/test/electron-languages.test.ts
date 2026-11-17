// 打包只留 en-US / zh-TW / zh-CN 三個 Chromium 語系(electronLanguages)。
// zh-TW / zh-CN 都要留:少了會讓 /^zh/ 系統語系判斷退回英文。
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8')

describe('electron-builder electronLanguages', () => {
  const yml = read('../electron-builder.yml')
  const line = /^electronLanguages:\s*\[([^\]]*)\]\s*$/m.exec(yml)
  const langs = (line?.[1] ?? '').split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)

  it('在頂層設定(win / mac 共用)', () => {
    expect(line).not.toBeNull()
  })

  it('剛好是 en-US / zh-TW / zh-CN', () => {
    expect([...langs].sort()).toEqual(['en-US', 'zh-CN', 'zh-TW'])
  })

  it('系統語系判斷仍是 /^zh/(改了判斷方式要重新評估要留哪些語系)', () => {
    expect(read('../src/main.ts')).toMatch(/\/\^zh\/i\.test\(app\.getLocale\(\)\)/)
    expect(read('../../renderer/src/web/Config.ts')).toMatch(/\/\^zh\/i\.test\(lang\)/)
  })
})
