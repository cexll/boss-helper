/**
 * Jev 明确结果缓存（t9）与人工确认方向记录（t10）。
 *
 * 判定依据（t9 单 / spec FR-015 / p1 §6.3）：目标岗位方向描述 + 所用 Jev 模型标识。
 * - 只缓存明确终判（t9）：pass（noul ≥ high）与 confirmed-negative（noul ≤ low）；
 *   待复核（不确定 / 超时 / 报错）永不写入（FR-013 / AC-008：再次扫到重新判断）。
 * - 模型标识取响应返回的具体版本（p1 §3.2：如 jev-1.13.0，而非请求别名 jev-latest）：
 *   会话中观测到模型版本变化 → 整库失效（任一变化即失效；防供应商滚动别名后沿用旧判定）。
 * - 目标方向变化 → 键不同 → 自然失效；JEV_CACHE_PROTOCOL 是判定口径修订位
 *   （判定带 JEV_UNCERTAIN_BAND / 问题协议变化时 +1，整库失效）。
 * - 明确结果缓存为模块级内存 Map：仓库没有 Jev 结果持久化通道（t5 只持久化密钥，
 *   t8 交接是内存 Set），故其生命周期 = 一次投递运行（内容脚本会话）；刷新即清空、
 *   会话内不过期、无 TTL（orchestrator 口径；p1 §6.3 的 7 天仍是待用户确认项）。
 *
 * t10 / FR-014 / FR-015 / AC-010：人工确认方向是**持久记录**（spec.md:86
 * 「人工确认是持久记录（随 Jev 缓存）」），经 wxt storage 落在 local:jev-confirmations：
 * - 键与明确结果同一个派生函数 jevDecisionKey（唯一派生来源，同一键形）。确认是人对
 *   「岗位 ∈ 目标方向」的判断而非某次响应（确认时 Jev 可能正是报错 / 超时 / 不确定），
 *   模型槽固定为 HUMAN_CONFIRMATION_MODEL；确认时会话已观测到具体响应版本则记为这批
 *   确认的失效戳（model），观测到不同版本 → 整库失效（与 t9 缓存同一触发）；确认时
 *   尚无响应 → 无版本可失配，首次观测到响应不构成「模型变化」，不销毁确认。
 * - 失效触发与 t9 一致：目标方向变化（确认新方向时旧方向记录整体作废；读取时不同方向
 *   不命中）；模型版本变化（整库失效并擦除持久记录）。
 * - 确认只放行**方向阶段**：judgeJevDirection 经缓存命中直接返回 pass、零请求；
 *   关键词等硬条件在流水线其他步骤照常执行，命中排除词的岗位仍不投递（AC-010），
 *   键含岗位标识 → 同名其他岗位仍各自判断（AC-010）。
 * - 读取路径对损坏存储值归一为空（t7 normalizeJevConfig 同款口径），绝不抛错、
 *   绝不误命中；未与存储对齐（hydrate）前一律不命中 —— 全链路 fail-closed。
 * - 待复核列表本身仍不持久（FR-014）：本文件只管确认记录。
 */

import { counter } from '@/message'

import type { JevDirectionDecision } from './jevDirection'

/** 缓存里只允许明确的终判；待复核结果永不写入（FR-013） */
export type JevCachedDecision =
  | Extract<JevDirectionDecision, { decision: 'pass' }>
  | Extract<JevDirectionDecision, { decision: 'skip' }>

/** 判定口径修订位：判定带或问题协议变化时 +1，整库失效 */
const JEV_CACHE_PROTOCOL = 1

/** 人工确认记录在 wxt storage 的键（旧版本没有这个键：读到 null 即空集，天然兼容） */
export const JEV_CONFIRMATIONS_STORAGE_KEY = 'local:jev-confirmations'

/**
 * 人工确认的模型槽位：确认是人的判断，不绑定某一次 Jev 响应版本；会话观测到的响应
 * 版本作为失效戳记在批次元数据上（JevConfirmationsValue.model），变化即整库失效。
 */
const HUMAN_CONFIRMATION_MODEL = 'human'

/**
 * 判定依据键的唯一派生来源（t9 明确结果与 t10 人工确认共用）：
 * 协议修订位 + 模型标识 + 岗位标识 + 目标方向。目标方向在入口截断（trim），
 * 两侧（确认写入 / 流水线读取）都经此派生，才不会因空白产生静默失效。
 */
function jevDecisionKey(jobKey: string, targetDirection: string, model: string): string {
  return `${JEV_CACHE_PROTOCOL}\0${model}\0${jobKey}\0${targetDirection.trim()}`
}

/** 人工确认的存储面：wxt storage 的最小读写形态，测试注入受控实现 */
export interface JevConfirmationStorage {
  getItem(key: string): Promise<unknown>
  setItem(key: string, value: unknown): Promise<void>
  removeItem(key: string): Promise<void>
}

/** 落盘形态：这批确认依附的目标方向、记录时的会话模型（失效戳）与已确认岗位的键集合 */
interface JevConfirmationsValue {
  direction: string
  model: string
  keys: string[]
}

/**
 * 读取路径归一（t7 normalizeJevConfig 同款口径）：非对象 / 数组 / 缺字段一律空集
 * （direction '' = 没有任何确认），坏键丢掉。存储损坏绝不抛错、绝不误命中。
 */
function normalizeJevConfirmations(value: unknown): JevConfirmationsValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { direction: '', model: '', keys: [] }
  }
  const obj = value as Record<string, unknown>
  if (
    typeof obj.direction !== 'string' ||
    typeof obj.model !== 'string' ||
    !Array.isArray(obj.keys)
  ) {
    return { direction: '', model: '', keys: [] }
  }
  return {
    direction: obj.direction,
    model: obj.model,
    keys: obj.keys.filter((key): key is string => typeof key === 'string'),
  }
}

/**
 * 判定依据是否已变化（纯函数，store 的 record / has 共用）：方向变了（方向是键的一部分），
 * 或模型失效戳与会话当前模型不一致（两侧都是具体响应版本时才算变化；'' / null =
 * 「尚无响应」，不构成变化 —— 确认可能产生于报错 / 超时的会话，首次观测不是变化）。
 */
function basisChanged(
  bag: JevConfirmationsValue,
  direction: string,
  model: string | null,
): boolean {
  if (bag.direction !== '' && bag.direction !== direction) return true
  if (bag.model !== '' && model !== null && bag.model !== model) return true
  return false
}

/** 空批次（尚无任何确认记录）的持久形态；独立常量避免每次读取损坏存储都造新对象 */
const EMPTY_CONFIRMATIONS: JevConfirmationsValue = { direction: '', model: '', keys: [] }

/**
 * 确认记录的读取面（judgeJevDirection 经 JevCache 使用）与写入面（t10 动作使用）。
 * 模型标识传 null = 会话尚未观测到任何 Jev 响应（不构成失效触发）。
 */
export interface JevConfirmationStore {
  /** 与存储对齐（幂等）；损坏值归一为空 */
  restore(): Promise<void>
  /** 记录一条确认（岗位 + 方向）；判定依据变化时旧记录整体作废；写失败抛错 */
  record(jobKey: string, targetDirection: string, model: string | null): Promise<boolean>
  /** 同步读内存镜像：未与存储对齐一律不命中（fail-closed） */
  has(jobKey: string, targetDirection: string, model: string | null): boolean
  /** 撤销一条确认（持久删除）：重试时清掉放行依据 */
  revoke(jobKey: string, targetDirection: string): Promise<boolean>
  /** 模型版本变化（t9 set 的同一触发）：整库失效并擦除持久记录 */
  invalidateAll(): void
}

/**
 * 人工确认 store：内存镜像 + 存储双轨，写路径以存储为权威（重读后再改，
 * 跨标签 / 重载不覆盖别人的记录）。
 */
export function createJevConfirmationStore(storage: JevConfirmationStorage): JevConfirmationStore {
  const memory = new Set<string>()
  /** 这批确认依附的判定依据（方向 + 模型失效戳）；direction '' = 尚无记录 */
  let bag: JevConfirmationsValue = { ...EMPTY_CONFIRMATIONS }
  /** 内存是否与存储对齐；未对齐的读取一律不命中（fail-closed） */
  let hydrated = false

  const applyValue = (value: JevConfirmationsValue): void => {
    memory.clear()
    value.keys.forEach((key) => memory.add(key))
    bag = { direction: value.direction, model: value.model, keys: [...value.keys] }
    hydrated = true
  }

  /** 以存储为权威重读并覆盖内存镜像（存储不可用 → 空集，绝不抛错） */
  async function syncFromStorage(): Promise<void> {
    try {
      applyValue(normalizeJevConfirmations(await storage.getItem(JEV_CONFIRMATIONS_STORAGE_KEY)))
    } catch {
      applyValue({ ...EMPTY_CONFIRMATIONS })
    }
  }

  /** 落盘当前镜像（含判定依据戳）；写失败抛给调用方，由调用方决定回滚 */
  async function persist(): Promise<void> {
    await storage.setItem(JEV_CONFIRMATIONS_STORAGE_KEY, {
      direction: bag.direction,
      model: bag.model,
      keys: [...memory],
    })
  }

  /** 整库作废：内存清空并擦除持久记录（判定依据变化 / 测试隔离） */
  function dropAll(): void {
    memory.clear()
    bag = { ...EMPTY_CONFIRMATIONS }
    hydrated = true
    void storage.removeItem(JEV_CONFIRMATIONS_STORAGE_KEY)
  }

  return {
    async restore() {
      await syncFromStorage()
    },

    async record(jobKey, targetDirection, model) {
      const direction = targetDirection.trim()
      if (direction === '') {
        // FR-010 同源：没有目标方向就没有判定依据，也没有「方向确认」可记
        throw new Error('目标方向为空：无法记录人工确认')
      }
      await syncFromStorage()
      // 判定依据变化 → 旧记录整体作废（spec.md:70「目标变化 → 缓存与人工确认失效」）
      if (bag.direction === '' || basisChanged(bag, direction, model)) {
        memory.clear()
        bag = { direction, model: model ?? '', keys: [] }
      }
      const key = jevDecisionKey(jobKey, direction, HUMAN_CONFIRMATION_MODEL)
      memory.add(key)
      try {
        await persist()
      } catch (error) {
        // 写盘失败：内存不留半条记录（fail-closed），错误交给调用方
        memory.delete(key)
        throw error
      }
      return true
    },

    has(jobKey, targetDirection, model) {
      if (!hydrated || bag.direction === '') return false
      const direction = targetDirection.trim()
      if (bag.direction !== direction) return false
      // 模型失效戳与当前会话模型不一致 → 整库失效（与 t9 缓存的模型变化同一触发）
      if (bag.model !== '' && model !== null && bag.model !== model) {
        dropAll()
        return false
      }
      return memory.has(jevDecisionKey(jobKey, direction, HUMAN_CONFIRMATION_MODEL))
    },

    async revoke(jobKey, targetDirection) {
      await syncFromStorage()
      const key = jevDecisionKey(jobKey, targetDirection.trim(), HUMAN_CONFIRMATION_MODEL)
      if (!memory.has(key)) return false
      memory.delete(key)
      await persist()
      return true
    },

    invalidateAll() {
      dropAll()
    },
  }
}

export interface JevCache {
  /** 按「岗位 + 目标方向 + 会话模型」命中时返回缓存的明确终判，否则 undefined */
  get(jobKey: string, targetDirection: string): JevCachedDecision | undefined
  /** 写入一条明确终判；模型标识来自 Jev 响应，模型版本变化时整库失效 */
  set(jobKey: string, targetDirection: string, model: string, decision: JevCachedDecision): void
  /** 清空整库并重置模型指针（页面刷新语义；测试隔离） */
  clear(): void
  /** t10：人工确认当前岗位 + 当前方向（持久化在 store 层）；返回是否成功记录 */
  confirm(jobKey: string, targetDirection: string): Promise<boolean>
  /** t10：撤销人工确认（重试时清掉放行依据，使下一次扫到重新请求 Jev） */
  revokeConfirmation(jobKey: string, targetDirection: string): Promise<boolean>
}

/**
 * 明确结果缓存工厂。`confirmations` 注入人工确认记录面（缺省无确认 = t9 行为），
 * 供单测隔离；生产单例绑定持久 store。
 */
export function createJevCache(
  confirmations: Pick<JevConfirmationStore, 'has' | 'invalidateAll' | 'record' | 'revoke'> = {
    has: () => false,
    invalidateAll: () => {},
    record: async () => false,
    revoke: async () => false,
  },
): JevCache {
  const entries = new Map<string, JevCachedDecision>()
  /** 最近一次响应观测到的具体模型版本；null = 会话内尚未收到任何明确响应 */
  let activeModel: string | null = null

  return {
    get(jobKey, targetDirection) {
      // t10 / FR-015：人工确认与明确结果同键同触发，命中即放行方向阶段（零请求）
      if (confirmations.has(jobKey, targetDirection, activeModel)) {
        return { decision: 'pass' }
      }
      if (activeModel === null) return undefined
      return entries.get(jevDecisionKey(jobKey, targetDirection, activeModel))
    },
    set(jobKey, targetDirection, model, decision) {
      if (activeModel !== null && activeModel !== model) {
        entries.clear()
        // spec.md:70「目标变化 → 缓存与人工确认失效」：模型版本变化同样是整库失效
        confirmations.invalidateAll()
      }
      activeModel = model
      entries.set(jevDecisionKey(jobKey, targetDirection, model), decision)
    },
    clear() {
      entries.clear()
      activeModel = null
    },
    confirm(jobKey, targetDirection) {
      return confirmations.record(jobKey, targetDirection, activeModel)
    },
    revokeConfirmation(jobKey, targetDirection) {
      return confirmations.revoke(jobKey, targetDirection)
    },
  }
}

/**
 * wxt storage 通道（content → background → browser storage，经 @/message counter）。
 * 读失败一律按「没有记录」处理（fail-closed），绝不让存储异常变成放行。
 */
const wxtConfirmationStorage: JevConfirmationStorage = {
  async getItem(key) {
    return counter.storageGet<unknown>(key)
  },
  async setItem(key, value) {
    await counter.storageSet(key, value)
  },
  async removeItem(key) {
    await counter.storageRm(key)
  },
}

/**
 * 人工确认持久 store（t10）。生命周期同扩展安装（跨页面 / 刷新存活），
 * 失效只由判定依据变化负责；与内存的明确结果缓存不同层。
 */
export const jevConfirmations = createJevConfirmationStore(wxtConfirmationStorage)

/** 页面会话级单例：随内容脚本存活，刷新即重建（同 reviewNeededStore / jevHandoff 生命周期） */
export const jevCache = createJevCache(jevConfirmations)
