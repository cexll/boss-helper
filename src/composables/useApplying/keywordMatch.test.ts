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
