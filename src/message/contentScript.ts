import type { StorageItemKey } from '#imports'
import { browser, storage } from '#imports'
import type { JevRequestBody } from '@/utils/jev'
import type { JEV_ASK_MESSAGE } from '@/utils/jev'

import type { BackgroundCounter } from './background'
export { ProvideContentAdapter } from './contentScriptShare'

function genKey(key: string): StorageItemKey {
  const prefixes = ['local:', 'session:', 'sync:', 'managed:'] as const
  return prefixes.some((prefix) => key.startsWith(prefix)) ? (key as StorageItemKey) : `sync:${key}`
}

export class ContentCounter implements BackgroundCounter {
  public background: BackgroundCounter
  public routerHooks: Array<(path: string) => void> = []

  constructor(background: BackgroundCounter) {
    this.background = background
  }

  _addRouterHook(hook: (path: string) => void) {
    this.routerHooks.push(hook)
  }

  async callRouterHooks(path: string) {
    for (const hook of this.routerHooks) {
      try {
        hook(path)
      } catch (e) {
        console.error('调用路由hook失败', e)
      }
    }
  }

  async request(...args: Parameters<BackgroundCounter['request']>) {
    return this.background.request(...args)
  }

  async notify(...args: Parameters<BackgroundCounter['notify']>) {
    return this.background.notify(...args)
  }

  async backgroundTest(...args: Parameters<BackgroundCounter['backgroundTest']>) {
    return this.background.backgroundTest(...args)
  }

  async fetch(...args: Parameters<typeof fetch>) {
    return this.background.fetch(...args)
  }

  async getImage(...args: Parameters<BackgroundCounter['getImage']>) {
    return this.background.getImage(...args)
  }
  async setImage(...args: Parameters<BackgroundCounter['setImage']>) {
    return this.background.setImage(...args)
  }

  /**
   * F-028：页面（MAIN world）无法直连 Jev 时，经 content script 把 `jev:ask` 消息
   * 转给扩展后台代发（FR-017）。载荷只含岗位标题/描述问题结构（t5 协议），
   * 密钥留在后台存储里，不经这条页面消息、不进日志。
   */
  async askJevBackground(message: { type: typeof JEV_ASK_MESSAGE; payload: JevRequestBody }) {
    return browser.runtime.sendMessage(message)
  }

  async storageGet<T>(key: string, defaultValue: T): Promise<T>
  async storageGet<T>(key: string): Promise<T | null>
  async storageGet<T>(key: string, defaultValue?: T): Promise<T | null> {
    return storage.getItem<T>(genKey(key), { fallback: defaultValue })
  }

  async storageSet<T>(key: string, value: T) {
    await storage.setItem(genKey(key), value)
    return true
  }

  async storageRm(key: string) {
    await storage.removeItem(genKey(key))
    return true
  }

  async contentScriptTest(type: 'success' | 'error') {
    if (type === 'error') {
      throw new Error(`test error date: ${Date.now()}`)
    }
    return Date.now()
  }
}
