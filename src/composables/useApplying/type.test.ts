import { describe, expect, test } from 'bun:test'

import { DependencyMissingError, createLazyObject, isInitialized } from './type'

/**
 * type.ts 的惰性代理与初始化探测（createLazyObject / isInitialized 此前随模块落在
 * baseline.legacy_untested_files；本轮 useApplying 环修复必须改 type.ts，把它拉进
 * coverage/CRAP 门禁的 changed 范围，因此补齐这两个函数的真实行为断言，实现零改动）：
 * - createLazyObject：未初始化读取抛 DependencyMissingError（taskId 随异常携带）、
 *   __isProxy/__initialized 标记、符号与 __v_ 前缀探测、set 即初始化、键枚举与描述符语义
 * - isInitialized：代理按 __initialized 判定，非代理值恒 true
 */

/** 魔法标记位在类型上显式声明，避免用 any 绕过检查 */
type LazyProbe = { foo: string; __isProxy: boolean; __initialized: boolean }

describe('createLazyObject 惰性代理', () => {
  test('未初始化读取普通属性抛 DependencyMissingError，taskId 与 message 随异常携带', () => {
    const lazy = createLazyObject<{ foo: string }>('task-a')
    const readFoo = () => lazy.foo
    expect(isInitialized(lazy)).toBe(false)
    expect(readFoo).toThrow(DependencyMissingError)

    let caught: unknown
    try {
      readFoo()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(DependencyMissingError)
    expect((caught as DependencyMissingError).taskId).toBe('task-a')
    expect((caught as DependencyMissingError).message).toBe('Task dependency missing: task-a')
  })

  test('魔法标记位：__isProxy 恒真、__initialized 反映状态、符号与 __v_ 前缀读 undefined', () => {
    const lazy = createLazyObject<LazyProbe>('task-b')
    expect(lazy.__isProxy).toBe(true)
    expect(lazy.__initialized).toBe(false)

    const probe: Record<string | symbol, unknown> = lazy
    expect(probe[Symbol('probe')]).toBeUndefined()
    expect(probe.__v_isRef).toBeUndefined()
    // 探测位不触发未初始化异常
    expect(isInitialized(lazy)).toBe(false)
  })

  test('set 即初始化：赋值后读取命中、__initialized 翻转、isInitialized 转 true', () => {
    const lazy = createLazyObject<LazyProbe>('task-c')
    lazy.foo = 'bar'
    expect(lazy.foo).toBe('bar')
    expect(lazy.__initialized).toBe(true)
    expect(isInitialized(lazy)).toBe(true)
  })

  test('初始化前后枚举与描述符语义：空键 → 真实键，数据描述符由缺位到可读', () => {
    const lazy = createLazyObject<LazyProbe>('task-d')
    expect(Object.keys(lazy)).toEqual([])
    expect(Object.getOwnPropertyDescriptor(lazy, 'foo')).toBeUndefined()
    expect(Object.getOwnPropertyDescriptor(lazy, '__isProxy')?.value).toBe(true)
    expect(Object.getOwnPropertyDescriptor(lazy, '__isProxy')?.writable).toBe(false)
    expect(Object.getOwnPropertyDescriptor(lazy, '__initialized')?.value).toBe(false)

    lazy.foo = 'baz'
    expect(Object.keys(lazy)).toEqual(['foo'])
    expect(Object.getOwnPropertyDescriptor(lazy, 'foo')).toEqual({
      value: 'baz',
      writable: true,
      enumerable: true,
      configurable: true,
    })
    expect(Object.getOwnPropertyDescriptor(lazy, '__initialized')?.value).toBe(true)
  })
})

describe('isInitialized 初始化探测', () => {
  test('代理：未初始化 false，赋值后 true', () => {
    const lazy = createLazyObject<{ foo: string }>('task-e')
    expect(isInitialized(lazy)).toBe(false)
    lazy.foo = 'x'
    expect(isInitialized(lazy)).toBe(true)
  })

  test('非代理值恒 true（null/undefined/原始值/普通对象）', () => {
    expect(isInitialized(null)).toBe(true)
    expect(isInitialized(undefined)).toBe(true)
    expect(isInitialized('str')).toBe(true)
    expect(isInitialized(0)).toBe(true)
    expect(isInitialized({ foo: 1 })).toBe(true)
  })
})
