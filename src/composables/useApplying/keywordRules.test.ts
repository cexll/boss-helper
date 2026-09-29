import { describe, expect, test } from 'bun:test'

import type { KeywordFieldConfig } from '@/types/formData'

import {
  EMPTY_KEYWORD_VIEW,
  isKeywordFieldConfig,
  isKeywordFieldUsable,
  keywordCandidates,
  keywordFieldToRule,
  keywordFieldView,
  keywordUsabilityHint,
  mergeCandidate,
} from './keywordRules'

/** 合法关键词字段（jobTitle / jobContent 的形状）；覆盖项按测试意图构造。 */
function keywordField(over: Partial<KeywordFieldConfig> = {}): KeywordFieldConfig {
  return {
    include: true,
    value: [],
    options: [],
    enable: false,
    groups: { includeWords: [], excludeWords: [], includeMode: 'any' },
    ...over,
  }
}

describe('keywordFieldToRule：新关键词组字段 -> 新引擎规则（读 groups 新键）', () => {
  test('返回包含词 / 排除词 / 任一全部', () => {
    const field = keywordField({
      groups: { includeWords: ['Java', '前端'], excludeWords: ['外包'], includeMode: 'all' },
    })

    expect(keywordFieldToRule(field)).toEqual({
      includeWords: ['Java', '前端'],
      excludeWords: ['外包'],
      includeMode: 'all',
    })
  })

  test('groups 缺失（未迁移旧存储）按 t3 迁移口径读出，不在本模块重复迁移', () => {
    const legacy = keywordField({ include: false, value: ['外包'] })
    delete (legacy as Partial<KeywordFieldConfig>).groups

    expect(keywordFieldToRule(legacy)).toEqual({
      includeWords: [],
      excludeWords: ['外包'],
      includeMode: 'any',
    })
  })
})

describe('isKeywordFieldUsable：空规则与同词冲突不可用（AC-003）', () => {
  test('两组皆空：不可用', () => {
    expect(isKeywordFieldUsable(keywordField())).toBe(false)
  })

  test('仅空白词：不可用（按 trim 后判定）', () => {
    expect(
      isKeywordFieldUsable(
        keywordField({
          groups: { includeWords: ['  '], excludeWords: ['\t'], includeMode: 'any' },
        }),
      ),
    ).toBe(false)
  })

  test('同词既在包含组又在排除组：不可用', () => {
    const field = keywordField({
      groups: { includeWords: ['外包'], excludeWords: ['外包'], includeMode: 'any' },
    })

    expect(isKeywordFieldUsable(field)).toBe(false)
  })

  test('包含/排除各有词但无交集：可用', () => {
    const field = keywordField({
      groups: { includeWords: ['Java'], excludeWords: ['外包'], includeMode: 'any' },
    })

    expect(isKeywordFieldUsable(field)).toBe(true)
  })

  test('仅排除组有效：可用（排除-only 规则不需要包含组）', () => {
    const field = keywordField({
      groups: { includeWords: [], excludeWords: ['外包'], includeMode: 'any' },
    })

    expect(isKeywordFieldUsable(field)).toBe(true)
  })

  test('可用性与 enable 当前值无关：未启用但规则有效即可用', () => {
    expect(
      isKeywordFieldUsable(
        keywordField({
          enable: false,
          groups: { includeWords: ['Java'], excludeWords: [], includeMode: 'any' },
        }),
      ),
    ).toBe(true)
  })
})

describe('keywordUsabilityHint：启用开关不可用时提示问题所在', () => {
  test('空规则：空规则不能启用', () => {
    expect(keywordUsabilityHint(keywordField())).toBe('空规则不能启用')
  })

  test('规则有效：无提示', () => {
    expect(
      keywordUsabilityHint(
        keywordField({
          groups: { includeWords: ['Java'], excludeWords: [], includeMode: 'any' },
        }),
      ),
    ).toBe('')
  })

  test('冲突：提示列出同名词', () => {
    const field = keywordField({
      groups: { includeWords: ['外包', '销售'], excludeWords: ['销售'], includeMode: 'any' },
    })

    expect(keywordUsabilityHint(field)).toBe('包含与排除含同一词：销售')
  })

  test('多个冲突词按排除组顺序顿号连接', () => {
    const field = keywordField({
      groups: {
        includeWords: ['外包', '销售'],
        excludeWords: ['销售', '外包'],
        includeMode: 'any',
      },
    })

    expect(keywordUsabilityHint(field)).toBe('包含与排除含同一词：销售、外包')
  })
})

describe('mergeCandidate：显式选中候选词只并入词表（FR-005）', () => {
  test('候选词追加到既有词之后，既有顺序不变', () => {
    expect(mergeCandidate(['Java'], ['前端', 'Vue'])).toEqual(['Java', '前端', 'Vue'])
  })

  test('已在词表中的候选不重复并入', () => {
    expect(mergeCandidate(['Java'], ['Java', '前端'])).toEqual(['Java', '前端'])
  })

  test('空白候选被忽略', () => {
    expect(mergeCandidate(['Java'], ['  ', '', '\t', '前端'])).toEqual(['Java', '前端'])
  })

  test('不翻转任一/全部与启用：返回值只是词表，字段其余键原样', () => {
    const field = keywordField({
      enable: false,
      groups: { includeWords: ['Java'], excludeWords: [], includeMode: 'all' },
    })

    const words = mergeCandidate(field.groups.includeWords, ['前端'])

    expect(words).toEqual(['Java', '前端'])
    expect(field.groups.includeMode).toBe('all')
    expect(field.enable).toBe(false)
  })

  test('原数组不被就地修改（返回新词表）', () => {
    const existing = ['Java']

    expect(mergeCandidate(existing, ['前端'])).not.toBe(existing)
    expect(existing).toEqual(['Java'])
  })

  test('空候选列表：返回词表副本', () => {
    expect(mergeCandidate(['Java'], [])).toEqual(['Java'])
  })
})

describe('keywordCandidates：候选词只来自用过的关键词（FR-005）', () => {
  test('候选词 = 用过的关键词（options 旧键 ∪ 两组当前词），去空白去重', () => {
    const field = keywordField({
      options: ['外包', ' 上门 '],
      groups: { includeWords: ['Java', '外包'], excludeWords: ['销售'], includeMode: 'any' },
    })

    expect(keywordCandidates(field)).toEqual(['外包', '上门', 'Java', '销售'])
  })

  test('没有用过的词：候选为空（不提供任何预设词库）', () => {
    expect(keywordCandidates(keywordField())).toEqual([])
  })

  test('两组合计空白：候选为空', () => {
    const field = keywordField({
      options: ['  '],
      groups: { includeWords: ['\t'], excludeWords: [], includeMode: 'any' },
    })

    expect(keywordCandidates(field)).toEqual([])
  })
})

describe('isKeywordFieldConfig：新旧字段分流的门控', () => {
  test('带 groups 的关键词字段（jobTitle / jobContent）走新 UI', () => {
    expect(isKeywordFieldConfig(keywordField())).toBe(true)
  })

  test('旧单列表字段（company / hrPosition / jobAddress）不误入新 UI', () => {
    expect(
      isKeywordFieldConfig({ include: true, value: [], options: ['经理'], enable: false }),
    ).toBe(false)
  })

  test('groups 形状损坏不误入新 UI', () => {
    expect(isKeywordFieldConfig(undefined)).toBe(false)
    expect(isKeywordFieldConfig(null)).toBe(false)
    expect(isKeywordFieldConfig({ groups: [] })).toBe(false)
  })
})

describe('keywordFieldView：设置页视图快照（模板只消费计算属性）', () => {
  test('空规则字段：不可用 + 空规则提示 + 无候选', () => {
    expect(keywordFieldView(keywordField())).toEqual({
      candidates: [],
      usable: false,
      hint: '空规则不能启用',
    })
  })

  test('冲突字段：不可用 + 冲突提示', () => {
    expect(
      keywordFieldView(
        keywordField({
          groups: { includeWords: ['外包'], excludeWords: ['外包'], includeMode: 'any' },
        }),
      ),
    ).toEqual({ candidates: ['外包'], usable: false, hint: '包含与排除含同一词：外包' })
  })

  test('有效字段：可用 + 无提示', () => {
    expect(
      keywordFieldView(
        keywordField({
          groups: { includeWords: ['Java'], excludeWords: [], includeMode: 'all' },
        }),
      ),
    ).toEqual({ candidates: ['Java'], usable: true, hint: '' })
  })

  test('EMPTY_KEYWORD_VIEW 是空视图哨兵', () => {
    expect(EMPTY_KEYWORD_VIEW).toEqual({ candidates: [], usable: false, hint: '' })
  })
})
