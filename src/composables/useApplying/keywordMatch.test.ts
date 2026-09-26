import { expect, test } from 'bun:test'

import { decideJobContentKeyword, decideJobTitleKeyword } from './keywordMatch'

/**
 * 刻画迁移前 handles.ts 中 jobTitle / jobContent 处理器的既有行为（t3 迁移的 oracle）。
 * 期望值来源：conf/info.ts 的用户文档（例子 [外包,上门,销售,驾照]：排除『外包岗位』，
 * 不排除『不是外包』|『销售系统』）、mission brief 记录的现行规则与优先级，
 * 以及否定窗口 `(?<!(不|无).{0,5})` 的字面语义——而非迁移后实现。
 */

test('岗位名包含模式：命中关键词即放行（关键词忽略大小写）', () => {
  expect(decideJobTitleKeyword('高级java工程师', { include: true, value: ['Java'] })).toEqual({
    skip: false,
  })
})

test('岗位名包含模式：无任何命中时跳过为缺少关键词', () => {
  expect(
    decideJobTitleKeyword('后端开发工程师', { include: true, value: ['前端', '架构'] }),
  ).toEqual({ skip: true, reason: 'missing' })
})

test('岗位名排除模式：命中时按列表顺序报告首个命中关键词', () => {
  expect(
    decideJobTitleKeyword('java外包专员', { include: false, value: ['外包', 'java'] }),
  ).toEqual({
    skip: true,
    reason: 'excluded',
    keyword: '外包',
  })
})

test('岗位名排除模式：无命中时放行', () => {
  expect(decideJobTitleKeyword('自研产品专员', { include: false, value: ['外包'] })).toEqual({
    skip: false,
  })
})

test('岗位名匹配不做文本侧小写：文本按调用方给定的原样比较', () => {
  // 现状：处理传入小写文本。文本未小写时不命中——锁定模块契约，行为不得改变。
  expect(decideJobTitleKeyword('Java工程师', { include: true, value: ['java'] })).toEqual({
    skip: true,
    reason: 'missing',
  })
})

test('岗位名空关键词恒命中：现状没有空串保护', () => {
  expect(decideJobTitleKeyword('任何岗位名', { include: false, value: [''] })).toEqual({
    skip: true,
    reason: 'excluded',
    keyword: '',
  })
})

test('岗位名空关键词列表：包含模式跳过为缺少关键词，排除模式放行', () => {
  expect(decideJobTitleKeyword('前端工程师', { include: true, value: [] })).toEqual({
    skip: true,
    reason: 'missing',
  })
  expect(decideJobTitleKeyword('前端工程师', { include: false, value: [] })).toEqual({
    skip: false,
  })
})

test('工作内容包含模式：命中即放行', () => {
  expect(decideJobContentKeyword('负责vue项目开发', { include: true, value: ['Vue'] })).toEqual({
    skip: false,
  })
})

test('工作内容包含模式：无命中时跳过为缺少关键词', () => {
  expect(decideJobContentKeyword('负责后端运维', { include: true, value: ['Vue'] })).toEqual({
    skip: true,
    reason: 'missing',
  })
})

test('工作内容排除模式：命中时报告原样关键词', () => {
  expect(decideJobContentKeyword('长期外包岗位', { include: false, value: ['外包'] })).toEqual({
    skip: true,
    reason: 'excluded',
    keyword: '外包',
  })
})

test('工作内容排除模式：无命中时放行', () => {
  expect(decideJobContentKeyword('自研产品研发', { include: false, value: ['外包'] })).toEqual({
    skip: false,
  })
})

test('工作内容跳过空关键词：命中报告的是有效关键词', () => {
  // 若空串不被跳过，正则会先命中空串并把 '' 报为关键词。
  expect(decideJobContentKeyword('长期外包岗位', { include: false, value: ['', '外包'] })).toEqual({
    skip: true,
    reason: 'excluded',
    keyword: '外包',
  })
  expect(decideJobContentKeyword('长期外包岗位', { include: false, value: [''] })).toEqual({
    skip: false,
  })
})

test('工作内容否定词『不』在窗口内不算命中（conf/info.ts 文档例：不是外包）', () => {
  expect(decideJobContentKeyword('不是外包', { include: false, value: ['外包'] })).toEqual({
    skip: false,
  })
  expect(decideJobContentKeyword('不需要 外包', { include: false, value: ['外包'] })).toEqual({
    skip: false,
  })
})

test('工作内容否定词『无』在窗口内不算命中（conf/info.ts 文档例：无需）', () => {
  expect(decideJobContentKeyword('无外包', { include: false, value: ['外包'] })).toEqual({
    skip: false,
  })
  expect(decideJobContentKeyword('无需外包经验', { include: false, value: ['外包'] })).toEqual({
    skip: false,
  })
})

test('工作内容否定窗口边界：否定词距关键词 6 字仍屏蔽，7 字起命中', () => {
  // (?<!(不|无).{0,5}) ⇒ 否定词位于关键词前 1..6 个字符时屏蔽（总距离 ≤6）。
  expect(decideJobContentKeyword('无甲甲甲甲甲外包', { include: false, value: ['外包'] })).toEqual({
    skip: false,
  })
  expect(
    decideJobContentKeyword('无甲甲甲甲甲甲外包', { include: false, value: ['外包'] }),
  ).toEqual({
    skip: true,
    reason: 'excluded',
    keyword: '外包',
  })
})

test('工作内容后缀屏蔽表：系统/软件/工具/服务 阻止命中（conf/info.ts 文档例：销售系统）', () => {
  for (const suffix of ['系统', '软件', '工具', '服务']) {
    expect(decideJobContentKeyword(`销售${suffix}`, { include: false, value: ['销售'] })).toEqual({
      skip: false,
    })
  }
})

test('工作内容后缀不在屏蔽表时照常命中', () => {
  expect(decideJobContentKeyword('销售平台运营', { include: false, value: ['销售'] })).toEqual({
    skip: true,
    reason: 'excluded',
    keyword: '销售',
  })
})

test('工作内容空文本保护：null/undefined 一律视为未命中，不抛错', () => {
  expect(decideJobContentKeyword(null, { include: false, value: ['外包'] })).toEqual({
    skip: false,
  })
  expect(decideJobContentKeyword(undefined, { include: false, value: ['外包'] })).toEqual({
    skip: false,
  })
  expect(decideJobContentKeyword(null, { include: true, value: ['外包'] })).toEqual({
    skip: true,
    reason: 'missing',
  })
})

test('非法正则关键词在任意文本下抛错，包括 null（构造正则先于空文本保护）', () => {
  expect(() =>
    decideJobContentKeyword('技术栈 c++ 相关', { include: false, value: ['c++'] }),
  ).toThrow()
  expect(() => decideJobContentKeyword(null, { include: false, value: ['c++'] })).toThrow()
})

import { evaluateKeywordRule, isKeywordRuleEmpty } from './keywordMatch'
import type { KeywordRule } from './keywordMatch'

// ————————————————————————————————————————————————————————————————————————————
// t1 新关键词引擎：包含组（任一/全部）+ 排除组 + 英文完整词/版本号/技术名称。
// 期望值来源：spec.md AC-001/AC-002 与 CONTEXT.md 权威口径，逐字取自已确认的规格例句，
// 而非实现本身。
// ————————————————————————————————————————————————————————————————————————————

const rule = (over: Partial<KeywordRule>): KeywordRule => ({
  includeWords: [],
  excludeWords: [],
  includeMode: 'any',
  ...over,
})

test('包含组与排除组并存：包含 Java、排除「外包」时「JavaScript 外包」被拒绝（AC-001 首例）', () => {
  expect(
    evaluateKeywordRule(
      'JavaScript 外包',
      rule({ includeWords: ['Java'], excludeWords: ['外包'] }),
    ),
  ).toEqual({ skip: true, reason: 'excluded', keyword: '外包' })
})

test('包含组与排除组并存：包含 Java、排除「外包」时「Java 开发」通过（AC-001 第二例）', () => {
  expect(
    evaluateKeywordRule('Java 开发', rule({ includeWords: ['Java'], excludeWords: ['外包'] })),
  ).toEqual({ skip: false })
})

test('版本号：Java 命中「Java8 开发」（AC-001 第三例）', () => {
  expect(
    evaluateKeywordRule('Java8 开发', rule({ includeWords: ['Java'], excludeWords: ['外包'] })),
  ).toEqual({ skip: false })
})

test('完整词：Java 不命中「JavaScript 开发」（后接字母视为另一个词）', () => {
  expect(evaluateKeywordRule('JavaScript 开发', rule({ includeWords: ['Java'] }))).toEqual({
    skip: true,
    reason: 'missing',
  })
})

test('版本号：Vue 命中「Vue3 前端工程师」', () => {
  expect(evaluateKeywordRule('Vue3 前端工程师', rule({ includeWords: ['Vue'] }))).toEqual({
    skip: false,
  })
})

test('完整词：Vue 不命中「Vuex 前端工程师」（后接字母视为另一个词）', () => {
  expect(evaluateKeywordRule('Vuex 前端工程师', rule({ includeWords: ['Vue'] }))).toEqual({
    skip: true,
    reason: 'missing',
  })
})

test('完整词：Java 不命中「xxJava工程师」（前接字母粘连为同一个词）', () => {
  expect(evaluateKeywordRule('xxJava工程师', rule({ includeWords: ['Java'] }))).toEqual({
    skip: true,
    reason: 'missing',
  })
})

test('英文匹配忽略大小写：包含 java 命中「JAVA 后端开发」', () => {
  expect(evaluateKeywordRule('JAVA 后端开发', rule({ includeWords: ['java'] }))).toEqual({
    skip: false,
  })
})

test('技术名称：C 不命中「C++ 开发」（+ 属于同一 token）', () => {
  expect(evaluateKeywordRule('C++ 开发', rule({ includeWords: ['C'] }))).toEqual({
    skip: true,
    reason: 'missing',
  })
})

test('技术名称：C 不命中「C# 开发」（# 属于同一 token）', () => {
  expect(evaluateKeywordRule('C# 开发', rule({ includeWords: ['C'] }))).toEqual({
    skip: true,
    reason: 'missing',
  })
})

test('技术名称：C++ 命中「C++ 开发工程师」', () => {
  expect(evaluateKeywordRule('C++ 开发工程师', rule({ includeWords: ['C++'] }))).toEqual({
    skip: false,
  })
})

test('技术名称：C# 命中「C# 工程师」', () => {
  expect(evaluateKeywordRule('C# 工程师', rule({ includeWords: ['C#'] }))).toEqual({
    skip: false,
  })
})

test('技术名称：.NET 命中「.NET 后端工程师」（前导点属于同一 token）', () => {
  expect(evaluateKeywordRule('.NET 后端工程师', rule({ includeWords: ['.NET'] }))).toEqual({
    skip: false,
  })
})

test('技术名称：.NET 不命中「NET 开发」（缺前导点即另一个词）', () => {
  expect(evaluateKeywordRule('NET 开发', rule({ includeWords: ['.NET'] }))).toEqual({
    skip: true,
    reason: 'missing',
  })
})

test('完整词：Java 命中「资深Java工程师」（中文边界不粘连英文词）', () => {
  expect(evaluateKeywordRule('资深Java工程师', rule({ includeWords: ['Java'] }))).toEqual({
    skip: false,
  })
})

test('中文包含匹配：包含「开发」命中「后端开发工程师」', () => {
  expect(evaluateKeywordRule('后端开发工程师', rule({ includeWords: ['开发'] }))).toEqual({
    skip: false,
  })
})

test('中文包含匹配：包含「工程师」命中「Java 高级工程师」', () => {
  expect(evaluateKeywordRule('Java 高级工程师', rule({ includeWords: ['工程师'] }))).toEqual({
    skip: false,
  })
})

test('中文包含匹配：不做完整词边界，包含「前端」命中「资深前端架构师」', () => {
  expect(evaluateKeywordRule('资深前端架构师', rule({ includeWords: ['前端'] }))).toEqual({
    skip: false,
  })
})

test('完整词：React 命中「React开发工程师」（中文不粘连英文词）', () => {
  expect(evaluateKeywordRule('React开发工程师', rule({ includeWords: ['React'] }))).toEqual({
    skip: false,
  })
})

test('混合中英词按子串包含：包含「React开发」命中「React开发工程师」', () => {
  expect(evaluateKeywordRule('React开发工程师', rule({ includeWords: ['React开发'] }))).toEqual({
    skip: false,
  })
})

test('英文词句末点不算 token 一部分：包含 java 命中「Java. 资深后端」', () => {
  expect(evaluateKeywordRule('Java. 资深后端', rule({ includeWords: ['java'] }))).toEqual({
    skip: false,
  })
})

test('中文词未出现时缺少关键词：包含「开发工程师」不命中「Java 后端」', () => {
  expect(evaluateKeywordRule('Java 后端', rule({ includeWords: ['开发工程师'] }))).toEqual({
    skip: true,
    reason: 'missing',
  })
})

test('包含组任一满足：命中「前端」即通过，另一个词未命中不阻断', () => {
  expect(
    evaluateKeywordRule(
      '前端开发工程师',
      rule({ includeWords: ['前端', 'Python'], includeMode: 'any' }),
    ),
  ).toEqual({ skip: false })
})

test('包含组全部满足：两个词都命中才通过（AC-001 同字段任一或全部）', () => {
  expect(
    evaluateKeywordRule(
      'Java 前端开发工程师',
      rule({ includeWords: ['Java', '前端'], includeMode: 'all' }),
    ),
  ).toEqual({ skip: false })
})

test('包含组全部满足：只命中其一时缺少关键词', () => {
  expect(
    evaluateKeywordRule(
      'Java 后端工程师',
      rule({ includeWords: ['Java', '前端'], includeMode: 'all' }),
    ),
  ).toEqual({ skip: true, reason: 'missing' })
})

test('排除组任一命中即拒绝：报告首个命中的排除词', () => {
  expect(
    evaluateKeywordRule(
      'Java 外包驻场',
      rule({ includeWords: ['Java'], excludeWords: ['外包', '驻场'] }),
    ),
  ).toEqual({ skip: true, reason: 'excluded', keyword: '外包' })
})

test('排除组命中拒绝优先于包含组命中：包含与排除并存时排除优先', () => {
  expect(
    evaluateKeywordRule('Java 外包项目', rule({ includeWords: ['Java'], excludeWords: ['外包'] })),
  ).toEqual({ skip: true, reason: 'excluded', keyword: '外包' })
})

test('只设排除组：未命中任何排除词即通过（AC-003 前提）', () => {
  expect(evaluateKeywordRule('自研产品开发', rule({ excludeWords: ['外包'] }))).toEqual({
    skip: false,
  })
})

test('只设排除组：命中即拒绝', () => {
  expect(evaluateKeywordRule('软件外包专员', rule({ excludeWords: ['外包'] }))).toEqual({
    skip: true,
    reason: 'excluded',
    keyword: '外包',
  })
})

test('排除组英文完整词：排除 java 不命中「JavaScript 工程师」', () => {
  expect(evaluateKeywordRule('JavaScript 工程师', rule({ excludeWords: ['Java'] }))).toEqual({
    skip: false,
  })
})

test('isKeywordRuleEmpty：包含组与排除组均空时返回 true（空规则不能启用）', () => {
  expect(isKeywordRuleEmpty(rule({}))).toBe(true)
})

test('isKeywordRuleEmpty：仅包含组有词、仅排除组有词均返回 false', () => {
  expect(isKeywordRuleEmpty(rule({ includeWords: ['Java'] }))).toBe(false)
  expect(isKeywordRuleEmpty(rule({ excludeWords: ['外包'] }))).toBe(false)
})

test('isKeywordRuleEmpty：全部由空白组成的词视为空组', () => {
  expect(isKeywordRuleEmpty(rule({ includeWords: ['  '] }))).toBe(true)
  expect(isKeywordRuleEmpty(rule({ excludeWords: [' '] }))).toBe(true)
})

test('空规则（均空）在求值时缺少关键词而非崩溃', () => {
  expect(evaluateKeywordRule('Java 工程师', rule({}))).toEqual({
    skip: true,
    reason: 'missing',
  })
})

test('文本缺失：包含组非空时 null 文本缺少关键词（不抛错、不放行）', () => {
  expect(evaluateKeywordRule(null, rule({ includeWords: ['Java'] }))).toEqual({
    skip: true,
    reason: 'missing',
  })
})

test('文本缺失：只设排除组时 null 文本未命中排除词即通过', () => {
  expect(evaluateKeywordRule(null, rule({ excludeWords: ['外包'] }))).toEqual({ skip: false })
})

test('文本为空串：包含组非空时缺少关键词', () => {
  expect(evaluateKeywordRule('', rule({ includeWords: ['Java'] }))).toEqual({
    skip: true,
    reason: 'missing',
  })
})

test('文本为空串：只设排除组时通过', () => {
  expect(evaluateKeywordRule('', rule({ excludeWords: ['外包'] }))).toEqual({ skip: false })
})

test('包含词纯空白不参与计数：any 模式命中有效词即通过', () => {
  expect(
    evaluateKeywordRule('Java 后端', rule({ includeWords: ['Java', '  '], includeMode: 'any' })),
  ).toEqual({ skip: false })
})

test('包含词纯空白不参与计数：all 模式只需命中全部有效词', () => {
  expect(
    evaluateKeywordRule('Java 后端', rule({ includeWords: ['Java', '  '], includeMode: 'all' })),
  ).toEqual({ skip: false })
})

test('关键词按字面量匹配而非正则：包含「a+b」不命中「aab」（+ 不是通配符）', () => {
  expect(evaluateKeywordRule('aab 开发', rule({ includeWords: ['a+b'] }))).toEqual({
    skip: true,
    reason: 'missing',
  })
})

test('关键词按字面量匹配：包含「a+b」命中「a+b 开发」（+ 属于 token 字符）', () => {
  expect(evaluateKeywordRule('a+b 开发', rule({ includeWords: ['a+b'] }))).toEqual({
    skip: false,
  })
})

test('版本号后紧跟字母仍不算命中：Java 不命中「Java8s 开发」', () => {
  expect(evaluateKeywordRule('Java8s 开发', rule({ includeWords: ['Java'] }))).toEqual({
    skip: true,
    reason: 'missing',
  })
})

test('排除词报告去除首尾空白：排除「 外包 」命中「外包项目」报告「外包」', () => {
  expect(evaluateKeywordRule('外包项目', rule({ excludeWords: [' 外包 '] }))).toEqual({
    skip: true,
    reason: 'excluded',
    keyword: '外包',
  })
})

test('英文词位于文本末尾：包含 react 命中「前端开发 react」', () => {
  expect(evaluateKeywordRule('前端开发 react', rule({ includeWords: ['React'] }))).toEqual({
    skip: false,
  })
})

test('英文词位于文本末尾且带句末点：包含 react 命中「前端开发 react.」', () => {
  expect(evaluateKeywordRule('前端开发 react.', rule({ includeWords: ['React'] }))).toEqual({
    skip: false,
  })
})

test('英文词位于文本末尾时仍守完整词：包含 java 不命中「前端开发 javaScript」', () => {
  expect(evaluateKeywordRule('前端开发 javascript', rule({ includeWords: ['Java'] }))).toEqual({
    skip: true,
    reason: 'missing',
  })
})
