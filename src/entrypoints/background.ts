import { defineProxy } from 'comctx'

import { browser, defineBackground, storage } from '#imports'
import { BackgroundCounter, ProvideBackgroundAdapter } from '@/message/background'
import { JEV_API_KEY_STORAGE_KEY, registerJevBackgroundHandler } from '@/utils/jev'

export default defineBackground({ main })

function main() {
  const [provideBackgroundCounter] = defineProxy(() => new BackgroundCounter(), {
    namespace: '__boss-helper-background__',
  })

  provideBackgroundCounter(new ProvideBackgroundAdapter())

  // FR-017：插件页面无法直连 Jev 时由扩展后台发起请求；密钥只在这里从存储读取，
  // 不经页面消息、不进日志（AGENTS.md 凭证纪律）
  registerJevBackgroundHandler(browser.runtime.onMessage, {
    getApiKey: async () => {
      const key = await storage.getItem(JEV_API_KEY_STORAGE_KEY)
      return typeof key === 'string' ? key : null
    },
  })
}
