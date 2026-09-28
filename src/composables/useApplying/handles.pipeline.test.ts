import { beforeEach, describe, expect, mock, test } from 'bun:test'

import {
  bossOf,
  brandOf,
  createDrivers,
  defaultFormData,
  jobDataOf,
  makeHelper,
  resetFixtures,
} from './handles.harness.test'

/**
 * handles.ts 处理器矩阵（一）：筛选类硬条件。
 * 投递关键路径（AGENTS.md：批量动作 → 账号封禁风险）的注册门与单字段判定语义。
 * 覆盖：注册门、猎头/好友状态、公司名、薪资范围、公司规模、Hr职位、工作地址、活跃度。
 *
 * 桩与 import 顺序（bun 模块桩只对同文件后续 import 生效）：
 * 先 mock.module('@/message')，再 await import('./handles')。
 */

void mock.module('@/message', () => ({
  counter: {
    storageGet: async (_key: string, fallback?: unknown) => fallback,
    storageSet: async () => true,
    storageRm: async () => true,
  },
  ExtStorage: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  },
}))

const handles = (await import('./handles')) as Record<string, any>
const { TaskRegistry } = handles
const { drive } = createDrivers({
  TaskRegistry,
  defineTaskWorkflow: ((await import('./type')) as Record<string, any>).defineTaskWorkflow,
})

beforeEach(resetFixtures)

// ———————————————— 注册门 ————————————————

describe('筛选器注册门（未启用 / 空规则 = 不注册）', () => {
  test('全部关闭时处理器均不注册；jobTitle/jobContent 的 enable 开着但词表为空同样不注册', async () => {
    const { helper } = makeHelper({
      formData: {
        company: { ...defaultFormData.company, enable: false },
        salaryRange: { ...defaultFormData.salaryRange, enable: false },
        companySizeRange: { ...defaultFormData.companySizeRange, enable: false },
        hrPosition: { ...defaultFormData.hrPosition, enable: false },
        jobAddress: { ...defaultFormData.jobAddress, enable: false },
        sameCompanyFilter: { ...defaultFormData.sameCompanyFilter, value: false },
        sameHrFilter: { ...defaultFormData.sameHrFilter, value: false },
        goldHunterFilter: { ...defaultFormData.goldHunterFilter, value: false },
        friendStatus: { ...defaultFormData.friendStatus, value: false },
        activityFilter: { ...defaultFormData.activityFilter, value: false },
        customGreeting: { ...defaultFormData.customGreeting, enable: false },
        aiGreeting: { ...defaultFormData.aiGreeting, enable: false },
        aiFiltering: { ...defaultFormData.aiFiltering, enable: false },
        amap: { ...defaultFormData.amap, enable: false },
        // FR-002：enable 开着但词表为空（或冲突词）按未启用处理
        jobTitle: { ...defaultFormData.jobTitle, enable: true },
        jobContent: { ...defaultFormData.jobContent, enable: true },
      },
    })
    const ctx = { now: new Date(), helper, index: 0, log: {} }
    const registry = new TaskRegistry()
    const cases: Array<[string, any]> = [
      ['SameCompanyFilter', registry.SameCompanyFilter()],
      ['SameHrFilter', registry.SameHrFilter()],
      ['jobTitle', registry.jobTitle()],
      ['goldHunterFilter', registry.goldHunterFilter()],
      ['company', registry.company()],
      ['salaryRange', registry.salaryRange()],
      ['companySizeRange', registry.companySizeRange()],
      ['jobContent', registry.jobContent()],
      ['hrPosition', registry.hrPosition()],
      ['jobAddress', registry.jobAddress()],
      ['jobFriendStatus', registry.jobFriendStatus()],
      ['activityFilter', registry.activityFilter()],
      ['customGreeting', registry.customGreeting()],
      ['aiGreeting', registry.aiGreeting()],
      ['aiFiltering', registry.aiFiltering()],
      ['amap', registry.amap()],
    ]
    for (const [id, task] of cases) {
      expect([id, await task.task(ctx)]).toEqual([id, undefined])
    }
  })
})

// ———————————————— 单字段硬条件 ————————————————

describe('猎头与好友状态硬条件', () => {
  test('猎头过滤：isHeadhunter 明确为 true 才跳过，非 true / 缺字段放行', async () => {
    const formData = { goldHunterFilter: { value: true } }
    const headhunter = await drive((r) => r.goldHunterFilter(), {
      formData,
      jobData: jobDataOf({ boss: bossOf({ isHeadhunter: true }) }),
    })
    expect(headhunter.res).toEqual({ isSkip: true, reason: '猎头过滤', status: 'warn' })

    const normal = await drive((r) => r.goldHunterFilter(), {
      formData,
      jobData: jobDataOf({ boss: bossOf({ isHeadhunter: false }) }),
    })
    expect(normal.res).toBeUndefined()

    const missing = await drive((r) => r.goldHunterFilter(), {
      formData,
      jobData: jobDataOf({ boss: bossOf() }),
    })
    expect(missing.res).toBeUndefined()
  })

  test('好友状态：isFriend 明确为 true 才跳过', async () => {
    const formData = { friendStatus: { value: true } }
    const friend = await drive((r) => r.jobFriendStatus(), {
      formData,
      jobData: jobDataOf({ boss: bossOf({ isFriend: true }) }),
    })
    expect(friend.res).toEqual({ isSkip: true, reason: '已经是好友了', status: 'warn' })

    const stranger = await drive((r) => r.jobFriendStatus(), {
      formData,
      jobData: jobDataOf({ boss: bossOf({ isFriend: false }) }),
    })
    expect(stranger.res).toBeUndefined()
  })
})

describe('公司名 / 薪资 / 规模硬条件', () => {
  test('公司名：空名跳过；排除模式命中即跳过、未命中放行；包含模式命中放行、未命中跳过', async () => {
    const exclude = { company: { enable: true, include: false, value: ['', '字节跳动'] } }
    const emptyName = await drive((r) => r.company(), {
      formData: exclude,
      jobData: jobDataOf({ brand: brandOf({ name: '' }) }),
    })
    expect(emptyName.res).toEqual({ isSkip: true, reason: '公司名为空', status: 'warn' })

    const excluded = await drive((r) => r.company(), {
      formData: exclude,
      jobData: jobDataOf({ brand: brandOf({ name: '北京字节跳动科技有限公司' }) }),
    })
    expect(excluded.res).toEqual({
      isSkip: true,
      reason: '公司名含有排除关键词 [字节跳动]',
      status: 'warn',
    })

    const otherCompany = await drive((r) => r.company(), {
      formData: exclude,
      jobData: jobDataOf({ brand: brandOf({ name: '腾讯科技' }) }),
    })
    expect(otherCompany.res).toBeUndefined()

    const include = { company: { enable: true, include: true, value: ['字节跳动'] } }
    const allowlisted = await drive((r) => r.company(), {
      formData: include,
      jobData: jobDataOf({ brand: brandOf({ name: '北京字节跳动科技有限公司' }) }),
    })
    expect(allowlisted.res).toBeUndefined()

    const notAllowlisted = await drive((r) => r.company(), {
      formData: include,
      jobData: jobDataOf({ brand: brandOf({ name: '腾讯科技' }) }),
    })
    expect(notAllowlisted.res).toEqual({
      isSkip: true,
      reason: '公司名不包含关键词',
      status: 'warn',
    })
  })

  test('薪资范围：宽松重叠放行、超范围给出预期文案、无单位词不判', async () => {
    const formData = {
      salaryRange: {
        enable: true,
        value: [8, 13, false],
        advancedValue: { H: [15, 25, false], D: [100, 200, false], M: [3000, 5000, false] },
      },
    }
    const overlap = await drive((r) => r.salaryRange(), {
      formData,
      jobData: jobDataOf({ salary: '10-20K' }),
    })
    expect(overlap.res).toBeUndefined()

    const overK = await drive((r) => r.salaryRange(), {
      formData,
      jobData: jobDataOf({ salary: '30K' }),
    })
    expect(overK.res).toEqual({
      isSkip: true,
      reason: '不匹配的薪资范围 30K, 预期: 8 - 13 K 宽松',
      status: 'warn',
    })

    const overMonth = await drive((r) => r.salaryRange(), {
      formData,
      jobData: jobDataOf({ salary: '6000-8000元/月' }),
    })
    expect(overMonth.res).toEqual({
      isSkip: true,
      reason: '不匹配的薪资范围 6000-8000元/月, 预期: 3000 - 5000 元/月 宽松',
      status: 'warn',
    })

    const withinMonth = await drive((r) => r.salaryRange(), {
      formData,
      jobData: jobDataOf({ salary: '4000-4500元/月' }),
    })
    expect(withinMonth.res).toBeUndefined()

    const noUnit = await drive((r) => r.salaryRange(), {
      formData,
      jobData: jobDataOf({ salary: '面议' }),
    })
    expect(noUnit.res).toBeUndefined()
  })

  test('公司规模：严格模式要求职位区间完全落在目标区间内', async () => {
    const formData = { companySizeRange: { enable: true, value: [500, 2000, true] } }
    const inside = await drive((r) => r.companySizeRange(), {
      formData,
      jobData: jobDataOf({ brand: brandOf({ scale: '1000-1500人' }) }),
    })
    expect(inside.res).toBeUndefined()

    const outside = await drive((r) => r.companySizeRange(), {
      formData,
      jobData: jobDataOf({ brand: brandOf({ scale: '50-99人' }) }),
    })
    expect(outside.res).toEqual({
      isSkip: true,
      reason: '不匹配的公司规模 50-99人, 预期: 500 - 2000 人 严格',
      status: 'warn',
    })
  })
})

describe('Hr职位 / 工作地址硬条件', () => {
  test('Hr职位：黑名单精确命中跳过、未命中放行；白名单命中放行、未命中与空 title 跳过', async () => {
    const blacklist = { hrPosition: { enable: true, include: false, value: ['', '技术总监'] } }
    const black = await drive((r) => r.hrPosition(), {
      formData: blacklist,
      jobData: jobDataOf({ boss: bossOf({ title: '技术总监' }) }),
    })
    expect(black.res).toEqual({
      isSkip: true,
      reason: 'Hr职位在黑名单中: 技术总监',
      status: 'warn',
    })

    const notListed = await drive((r) => r.hrPosition(), {
      formData: blacklist,
      jobData: jobDataOf({ boss: bossOf({ title: '人事经理' }) }),
    })
    expect(notListed.res).toBeUndefined()

    const whitelist = { hrPosition: { enable: true, include: true, value: ['技术总监'] } }
    const white = await drive((r) => r.hrPosition(), {
      formData: whitelist,
      jobData: jobDataOf({ boss: bossOf({ title: '技术总监' }) }),
    })
    expect(white.res).toBeUndefined()

    const outsideWhite = await drive((r) => r.hrPosition(), {
      formData: whitelist,
      jobData: jobDataOf({ boss: bossOf({ title: '人事经理' }) }),
    })
    expect(outsideWhite.res).toEqual({
      isSkip: true,
      reason: 'Hr职位不在白名单中: 人事经理',
      status: 'warn',
    })

    const noTitle = await drive((r) => r.hrPosition(), {
      formData: whitelist,
      jobData: jobDataOf({ boss: bossOf({ title: undefined }) }),
    })
    expect(noTitle.res).toEqual({
      isSkip: true,
      reason: 'Hr职位不在白名单中: undefined',
      status: 'warn',
    })
  })

  test('工作地址：空词表 / 空地址不判；包含与排除模式、词大小写归一', async () => {
    const exclude = { jobAddress: { enable: true, include: false, value: ['', '望京'] } }
    const excluded = await drive((r) => r.jobAddress(), {
      formData: exclude,
      jobData: jobDataOf(),
    })
    expect(excluded.res).toEqual({
      isSkip: true,
      reason: '工作地址含有排除关键词 [望京]',
      status: 'warn',
    })

    const notContained = await drive((r) => r.jobAddress(), {
      formData: exclude,
      jobData: jobDataOf({ address: '北京市海淀区中关村' }),
    })
    expect(notContained.res).toEqual({
      isSkip: true,
      reason: '工作地址不包含关键词: 北京市海淀区中关村',
      status: 'warn',
    })

    const emptyWords = await drive((r) => r.jobAddress(), {
      formData: { jobAddress: { enable: true, include: true, value: [] } },
      jobData: jobDataOf(),
    })
    expect(emptyWords.res).toBeUndefined()

    const noAddress = await drive((r) => r.jobAddress(), {
      formData: exclude,
      jobData: jobDataOf({ address: undefined }),
    })
    expect(noAddress.res).toBeUndefined()

    const include = { jobAddress: { enable: true, include: true, value: ['望京'] } }
    const contained = await drive((r) => r.jobAddress(), {
      formData: include,
      jobData: jobDataOf(),
    })
    expect(contained.res).toBeUndefined()

    const upperWord = await drive((r) => r.jobAddress(), {
      formData: { jobAddress: { enable: true, include: false, value: ['WANGJING'] } },
      jobData: jobDataOf({ address: '北京wangjing 大厦' }),
    })
    expect(upperWord.res).toEqual({
      isSkip: true,
      reason: '工作地址含有排除关键词 [WANGJING]',
      status: 'warn',
    })
  })
})

describe('活跃度过滤', () => {
  test('无活跃字段 / 超 7 天 / 含月年 各自跳过并计数；近期活跃与仅字符串活跃放行', async () => {
    const formData = { activityFilter: { value: true } }
    const now = new Date('2026-09-29T10:00:00.000Z')

    const none = await drive((r) => r.activityFilter(), {
      formData,
      now,
      jobData: jobDataOf({ activeTimeStr: undefined, activeTime: undefined }),
    })
    expect(none.res).toEqual({
      isSkip: true,
      reason: '无活跃内容,如果全失败请反馈',
      status: 'warn',
    })
    expect(none.statistics.activityFilter).toBe(1)

    const old = new Date('2026-09-01T00:00:00.000Z').getTime()
    const stale = await drive((r) => r.activityFilter(), {
      formData,
      now,
      jobData: jobDataOf({ activeTimeStr: undefined, activeTime: old }),
    })
    expect(stale.res).toEqual({
      isSkip: true,
      reason: `不活跃 [${new Date(old).toLocaleString()}]`,
      status: 'warn',
    })
    expect(stale.statistics.activityFilter).toBe(1)

    const recent = await drive((r) => r.activityFilter(), {
      formData,
      now,
      jobData: jobDataOf({
        activeTimeStr: undefined,
        activeTime: now.getTime() - 24 * 60 * 60 * 1000,
      }),
    })
    expect(recent.res).toBeUndefined()
    expect(recent.statistics.activityFilter).toBe(0)

    const monthly = await drive((r) => r.activityFilter(), {
      formData,
      now,
      jobData: jobDataOf({ activeTimeStr: '3月内活跃', activeTime: undefined }),
    })
    expect(monthly.res).toEqual({ isSkip: true, reason: '不活跃, [3月内活跃]', status: 'warn' })
    expect(monthly.statistics.activityFilter).toBe(1)

    const fresh = await drive((r) => r.activityFilter(), {
      formData,
      now,
      jobData: jobDataOf({ activeTimeStr: '刚刚活跃', activeTime: undefined }),
    })
    expect(fresh.res).toBeUndefined()
    expect(fresh.statistics.activityFilter).toBe(0)
  })
})
