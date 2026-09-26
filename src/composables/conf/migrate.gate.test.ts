import { describe, expect, test } from 'bun:test'

import { evaluateKeywordRule } from '../useApplying/keywordMatch'
import {
  keywordConflictWords,
  keywordGroupEnabled,
  keywordRuleOf,
  migrateKeywordGroups,
} from './migrate'
import type { KeywordFieldLike } from './migrate'

/**
 * 关键词组门控与归一的纯函数单测（评审 F-002 / F-004 / F-005）。
 * 期望值来自 spec.md FR-002（空规则与冲突词修正前不能启用）、FR-006（旧包含语义即
 * 「任一满足」，故损坏的 includeMode 回退 any）与 defaultFormData，不出自实现。
 */

const legacyField = (over: Partial<KeywordFieldLike>): KeywordFieldLike => ({
  include: true,
  value: [],
  options: [],
  enable: false,
  ...over,
})

const conflictedField = (includeWords: string[], excludeWords: string[]): KeywordFieldLike =>
  legacyField({
    enable: true,
    groups: { includeWords, excludeWords, includeMode: 'any' },
  })

describe('enable 门控的冲突分支（FR-002：同一词同时在两组，修正前不能启用）', () => {
  test('同词在两组且 enable=true：keywordGroupEnabled 返回 false（不止步于空规则检查）', () => {
    const field = conflictedField(['外包'], ['外包'])
    expect(keywordConflictWords(field.groups!)).toEqual(['外包'])
    expect(keywordGroupEnabled(field)).toBe(false)
  })

  test('冲突按 trim 后词比较（「 外包 」与「外包」视为同词）', () => {
    expect(keywordGroupEnabled(conflictedField([' 外包 '], ['外包']))).toBe(false)
  })

  test('无冲突且含有效词：门控仍返回 true（冲突分支不得把正常配置一起关掉）', () => {
    expect(keywordGroupEnabled(conflictedField(['Java'], ['外包']))).toBe(true)
    expect(keywordGroupEnabled(conflictedField(['外包'], ['外包', '销售']))).toBe(false)
  })
})

describe('keywordRuleOf 的 includeMode 回退（FR-006 旧包含语义 = 任一满足）', () => {
  test('损坏/未知的 includeMode 一律回退 any（存储值不在候选内时不沿用原值）', () => {
    for (const bad of ['both', 'ANY', 123, null, true, undefined, '']) {
      const rule = keywordRuleOf(
        legacyField({
          groups: { includeWords: ['Java'], excludeWords: [], includeMode: bad as never },
        }),
      )
      expect({ includeMode: bad, resolved: rule.includeMode }).toEqual({
        includeMode: bad,
        resolved: 'any',
      })
    }
  })

  test('合法值原样保留：all 不被回退成 any', () => {
    const rule = keywordRuleOf(
      legacyField({ groups: { includeWords: ['Java'], excludeWords: [], includeMode: 'all' } }),
    )
    expect(rule.includeMode).toBe('all')
  })
})

describe('损坏的 groups 形状在迁移时归一（评审 F-005：流水线不接收会抛错的规则）', () => {
  test('groups 为 {}：归一为良构空组，旧键保留，门控判 false（不按旧 value 覆盖已存在的组）', () => {
    const out = migrateKeywordGroups(
      legacyField({ value: ['外包'], enable: true, groups: {} as never }),
    )
    expect(out.groups).toEqual({ includeWords: [], excludeWords: [], includeMode: 'any' })
    expect(out.value).toEqual(['外包']) // 旧键原样保留，不删除用户数据
    expect(out.include).toBe(true)
    expect(keywordGroupEnabled(out)).toBe(false)
  })

  test('词表缺失或非数组：归一为空数组；includeMode 缺失：归一为 any', () => {
    const out = migrateKeywordGroups(
      legacyField({
        groups: { includeWords: null, excludeWords: '外包', includeMode: undefined } as never,
      }),
    )
    expect(out.groups).toEqual({ includeWords: [], excludeWords: [], includeMode: 'any' })
  })

  test('词表含非字符串元素：过滤掉非法元素，合法词保留', () => {
    const out = migrateKeywordGroups(
      legacyField({
        groups: {
          includeWords: ['Java', 42],
          excludeWords: ['外包', null],
          includeMode: 'all',
        } as never,
      }),
    )
    expect(out.groups).toEqual({
      includeWords: ['Java'],
      excludeWords: ['外包'],
      includeMode: 'all',
    })
  })

  test('groups 为数组等非 plain 对象形状：视为缺失，按旧 include/value 推导', () => {
    const out = migrateKeywordGroups(
      legacyField({ include: false, value: ['外包'], groups: [] as never }),
    )
    expect(out.groups).toEqual({ includeWords: [], excludeWords: ['外包'], includeMode: 'any' })
  })

  test('归一后的组可直接求值：损坏 groups 不再抛 TypeError（空规则 fail-closed 为 missing）', () => {
    const rule = keywordRuleOf(legacyField({ enable: true, groups: {} as never }))
    expect(evaluateKeywordRule('外包岗位', rule)).toEqual({ skip: true, reason: 'missing' })
  })

  test('良构 groups 原样保留：归一不得改写已迁移配置（幂等前提）', () => {
    const migrated = legacyField({
      groups: { includeWords: ['新词'], excludeWords: [], includeMode: 'all' },
    })
    const out = migrateKeywordGroups(migrated)
    expect(out.groups).toEqual({ includeWords: ['新词'], excludeWords: [], includeMode: 'all' })
    expect(migrateKeywordGroups(out)).toEqual(out)
  })
})
