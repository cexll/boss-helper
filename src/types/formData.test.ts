import { describe, expect, test } from 'bun:test'

import { defaultFormData } from '@/composables/conf/info'
import type { FormData } from '@/types/formData'
import { canEnableJev } from '@/types/formData'
import deepmerge from '@/utils/deepmerge'

/**
 * AC-006 / FR-010：密钥或目标方向为空时 Jev 不能启用。
 * 期望值来自验收标准原文（缺一不能启用），不由实现反推。
 */
describe('canEnableJev：密钥与目标方向缺一不能启用（AC-006）', () => {
  test('密钥为空：不能启用', () => {
    expect(canEnableJev({ apiKey: '', targetDirection: '前端开发' })).toBe(false)
  })

  test('密钥只有空白字符：不能启用', () => {
    expect(canEnableJev({ apiKey: '   ', targetDirection: '前端开发' })).toBe(false)
  })

  test('目标方向为空：不能启用', () => {
    expect(canEnableJev({ apiKey: 'sk-test', targetDirection: '' })).toBe(false)
  })

  test('目标方向只有空白字符：不能启用', () => {
    expect(canEnableJev({ apiKey: 'sk-test', targetDirection: '\n\t ' })).toBe(false)
  })

  test('两者都为空：不能启用', () => {
    expect(canEnableJev({ apiKey: '', targetDirection: '' })).toBe(false)
  })

  test('密钥与目标方向都非空：可以启用', () => {
    expect(canEnableJev({ apiKey: 'sk-test', targetDirection: '前端开发' })).toBe(true)
  })
})

/**
 * 「旧配置加载后 Jev 默认关闭」：默认值承载关闭状态（FR-006 口径），
 * 存量配置（无 jev 键）经 deepmerge 补齐默认值后仍为关闭。
 */
describe('Jev 默认关闭（旧配置加载后）', () => {
  test('defaultFormData.jev 默认关闭且目标方向为空', () => {
    expect(defaultFormData.jev).toEqual({ enable: false, targetDirection: '' })
  })

  test('存量配置没有 jev 键：合并默认值后 Jev 仍关闭', () => {
    const legacy = {
      version: '20260926',
      jobTitle: { include: true, value: [], options: [], enable: false },
    }
    const merged = deepmerge<FormData>(defaultFormData, legacy)
    expect(merged.jev?.enable).toBe(false)
    expect(merged.jev?.targetDirection).toBe('')
  })

  test('存量配置已带 jev：保留用户已有的启用状态与目标方向', () => {
    const stored = {
      version: '20260926',
      jev: { enable: true, targetDirection: '前端开发' },
    }
    const merged = deepmerge<FormData>(defaultFormData, stored)
    expect(merged.jev).toEqual({ enable: true, targetDirection: '前端开发' })
  })
})
