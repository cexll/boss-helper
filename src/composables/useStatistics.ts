import { watchThrottled } from '@vueuse/core'

import { ref } from '#imports'
import { counter } from '@/message'
import type { Statistics } from '@/types/formData'
import { getCurDay } from '@/utils'
import deepmerge, { jsonClone } from '@/utils/deepmerge'
import { logger } from '@/utils/logger'

export const todayKey = 'local:web-geek-job-Today'
export const statisticsKey = 'local:web-geek-job-Statistics'

export const useStatistics = () => {
  const date = getCurDay()

  const todayData = ref<Statistics>({
    date,
    success: 0,
    total: 0,
    repeat: 0,
    activityFilter: 0,
    tasks: {},
  })

  const statisticsData = ref<Statistics[]>([])

  watchThrottled(
    todayData,
    (v) => {
      void counter.storageSet(todayKey, jsonClone(v))
    },
    { throttle: 200, deep: true },
  )

  async function updateStatistics(curData = jsonClone(todayData.value)) {
    void counter.storageGet<Statistics[]>(statisticsKey, []).then((data) => {
      statisticsData.value = data
    })

    const g = await counter.storageGet(todayKey, curData)
    logger.debug('统计数据:', date, g)
    if (g.date === date) {
      todayData.value = deepmerge(curData, g, { clone: false })
      return
    }

    const statistics = await counter.storageGet(statisticsKey, [])

    const newStatistics = [g, ...statistics]
    await counter.storageSet(statisticsKey, newStatistics)
    await counter.storageSet(todayKey, curData)
    statisticsData.value = newStatistics
  }

  return {
    todayData,
    statisticsData,
    updateStatistics,
  }
}
