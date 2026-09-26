import { TaskRegistry, taskResult } from '@/composables/useApplying/handles'
import type { JevAskFn, JevStageHandoff } from '@/composables/useApplying/jevDirection'
import { createJevStageHandoff } from '@/composables/useApplying/jevDirection'
import { defineTaskHandler, defineTaskWorkflow } from '@/composables/useApplying/type'
import { counter } from '@/message'
import type { JevKeyReader } from '@/utils/jev'
import { askJev as askJevClient, JEV_API_KEY_STORAGE_KEY } from '@/utils/jev'

import { getBossData, sendPublishReq } from './requests'
import type { BossHelperCtx } from './runtime'
import type { BossZpJobItemData, BossZpDetailData, BossZpBossData } from './types'

export type BoosJobData = {
  jobitem: BossZpJobItemData
  detail: BossZpDetailData
  boss: BossZpBossData
}

const tasks = new TaskRegistry<BossHelperCtx, BoosJobData>()

/**
 * 标题阶段 → 详情复判阶段的交接：随流水线模块生命周期（FR-012）。
 * 标题阶段含糊时记待复判，详情阶段的本地硬条件通过后由复判步骤消费并再问一次 Jev；
 * 标题阶段已定论的岗位不残留标记，复判步骤零请求放行。
 */
const jevHandoff: JevStageHandoff = createJevStageHandoff()

/**
 * 密钥读取（FR-010：只存浏览器存储）：页面路径与后台 FR-017 同键 `local:jev-api-key`。
 * 经 counter（content↔background 通道）读取，密钥不进页面消息体、不进日志。
 */
const getJevApiKey: JevKeyReader = async () => {
  const stored = await counter.storageGet<string>(JEV_API_KEY_STORAGE_KEY)
  return typeof stored === 'string' ? stored : null
}

/**
 * t5 页面侧客户端（askJev）：单次尝试、单次超时（t5 JEV_TIMEOUT_MS，p1 §6.1），
 * 密钥由注入的读取器供给。页面上下文不可达时的 error outcome 由 jevDirection
 * 收敛为待复核（AC-012：如实说明，不引入其他模型或中转）。
 */
const askJev: JevAskFn = (job, question, getApiKey) =>
  askJevClient(job, question, { getApiKey: getApiKey ?? getJevApiKey })

export const bossWorkflow = defineTaskWorkflow<BossHelperCtx, BoosJobData>(
  defineTaskHandler(
    '已沟通',
    async () => {
      return async (_, { rawData }) => {
        if (rawData.jobitem.contact) {
          return taskResult.skip('已沟通')
        }
      }
    },
    {
      desc: '已沟通过滤',
    },
  ), // 已沟通过滤
  tasks.SameCompanyFilter(), // 相同公司过滤
  tasks.SameHrFilter(), // 相同hr过滤
  tasks.jobTitle(), // 岗位名筛选
  tasks.company(), // 公司名筛选
  tasks.salaryRange(), // 薪资筛选
  tasks.companySizeRange(), // 公司规模筛选
  tasks.goldHunterFilter(), // 猎头过滤
  tasks.jevDirection({
    stage: 'title',
    askJev,
    handoff: jevHandoff,
    getApiKey: getJevApiKey,
  }), // Jev标题判断：判不相关则不取详情、不调 AI 筛选（FR-012 / AC-007）
  defineTaskHandler(
    '岗位详情获取',
    () => async (ctx, job) => {
      await ctx.helper.onJobCardClick(job.jobData.key)
    },
    {
      state: 'request',
      stateMsg: '获取岗位详情',
    },
  ), // 获取岗位详情
  tasks.activityFilter({ deps: ['岗位详情获取'] }), // 活跃度过滤
  tasks.hrPosition({ deps: ['岗位详情获取'] }), // Hr职位筛选
  tasks.jobAddress({ deps: ['岗位详情获取'] }), // 工作地址筛选
  tasks.jobFriendStatus({ deps: ['岗位详情获取'] }), // 好友状态过滤
  tasks.jobContent({ deps: ['岗位详情获取'] }), // 工作内容筛选

  defineTaskHandler(
    '金牌面试官',
    (ctx) => {
      if (!ctx.helper.conf.formData.bossGoldMedalHr.value) {
        return
      }
      return async (_, { rawData }) => {
        if (
          rawData?.detail?.bossInfo?.avatarStickerUrl?.includes(
            '492b4ca74ee6ee7bfecf8d0d363780c68ad8b582857d894c8eae833b21840fb6',
          )
        ) {
          return taskResult.skip('金牌HR')
        }
      }
    },
    { deps: ['岗位详情获取'] },
  ), // 金牌面试官过滤

  tasks.amap({ deps: ['岗位详情获取'] }), // 高德地图
  tasks.jevDirection({
    stage: 'recheck',
    askJev,
    handoff: jevHandoff,
    getApiKey: getJevApiKey,
    deps: ['岗位详情获取'],
  }), // Jev方向复判：标题阶段含糊的岗位仍不确定 → 待复核（FR-012）
  tasks.aiFiltering({ deps: ['岗位详情获取'] }), // AI过滤（Jev 在前，方向不匹配不进入：FR-016）

  defineTaskHandler('岗位投递', () => async (_, { rawData }) => {
    await sendPublishReq({
      securityId: rawData.jobitem.securityId,
      encryptJobId: rawData.jobitem.encryptJobId,
    })
    return {
      status: 'success',
      msg: '投递成功',
    }
  }), // 投递

  defineTaskHandler('Boss信息获取', () => async (ctx, { rawData }) => {
    ctx.log.info('获取Boss信息', {
      securityId: rawData.jobitem.securityId,
      encryptJobId: rawData.jobitem.encryptJobId,
    })
    const bossData = await getBossData({
      securityId: rawData.jobitem.securityId,
      encryptUserId: ctx.helper.uid,
    })
    rawData.boss = bossData
  }), // Boss信息获取

  tasks.customGreeting({ deps: ['岗位详情获取', '岗位投递', 'Boss信息获取'] }), // 自定义招呼语
  tasks.aiGreeting({ deps: ['岗位详情获取', '岗位投递', 'Boss信息获取'] }), // AI招呼语
)
