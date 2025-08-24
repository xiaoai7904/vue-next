/**
 * 一、文件职责概览

该文件实现响应式副作用（effect）的核心运行时：创建、依赖收集与清理、触发调度、批处理、脏检查、暂停与恢复、以及与 computed 的协作。
它不直接实现 track/trigger（它们分散在依赖容器 dep 中），但提供了 effect 侧需要的算法与状态位，和 computed 的刷新流程。
二、核心数据结构与标志位

EffectFlags 位掩码：用来描述 effect/计算属性的运行状态与行为开关。定义见 EffectFlags
ACTIVE：处于活动状态（未 stop）
RUNNING：当前正在执行 run
TRACKING：允许收集依赖
NOTIFIED：已被某个 dep 通知过（用于批处理去重）
DIRTY：仅用于 computed，表明其值需要重新求值
ALLOW_RECURSE：允许递归（防止生命周期里自触发死循环的开关）
PAUSED：暂停触发（触发将被排队，恢复时统一触发）
EVALUATED：computed 已至少计算过一次
Subscriber 接口：任何能订阅 deps 的实体（effect 或 computed）都实现它。包含 deps 双向链表头尾指针、flags、notify 等。
ReactiveEffect 类：effect 的具体实现，持有依赖链、生命周期/调度器等。定义见 ReactiveEffect
重要字段与方法：
deps/depsTail：指向该 effect 订阅的所有 dep 的链表（通过 Link 连接）
flags：见上
scheduler：自定义调度器（存在时触发直接调用 scheduler）
run/stop/trigger/runIfDirty/notify/pause/resume 等
三、依赖图与链表设计（性能关键）

双向链表 + 双索引结构：
对于同一个依赖节点 dep（对应某个 reactive key 或 computed 的 value），它维护“订阅者”链表（prevSub/nextSub）。
对于某个订阅者 sub（effect 或 computed），它维护“所依赖 dep 的链表”（prevDep/nextDep）。
两种链表通过 Link 结构体连接（定义在 dep.ts），link.version 记录“当时订阅时的 dep 版本号”。
依赖准备与清理：
prepareDeps：将当前 sub 的每个 link.version 置为 -1，并把 dep.activeLink 暂存到 prevActiveLink，再将 dep.activeLink 指向当前 link。见 prepareDeps
cleanupDeps：遍历 depsTail 向前检查，凡 version 仍为 -1（本轮没有被访问到）则从 dep 的订阅者列表与 sub 的依赖列表双向移除，实现“按需移除过期依赖”。最后恢复 dep.activeLink 并更新 sub 的 deps/depsTail。见 cleanupDeps
removeSub/removeDep：分别在 dep->subs 和 sub->deps 两个维度解除链接。见 removeSub 与 removeDep
四、effect 生命周期与触发路径

创建与首次运行
工厂方法 effect(fn, options) 会创建 ReactiveEffect，合并 options 后立即 run 一次，并返回 runner（可手动再次调用或 stop）。见 effect
run：执行步骤见 ReactiveEffect.run
标记 RUNNING → cleanupEffect（上一次注册的清理函数）→ prepareDeps（为本轮依赖收集做准备）
切换 activeSub = this 且 shouldTrack = true（允许 track）
执行 fn，期间 getter 的 track 会将 dep 与当前 effect 双向链接，且把 link.version 记录为当前 dep.version
finally：cleanupDeps（移除未访问依赖）→ 恢复 activeSub/shouldTrack → 清 RUNNING
stop：取消所有订阅，运行 cleanupEffect 和 onStop 回调，清除 ACTIVE。见 ReactiveEffect.stop
notify/trigger/runIfDirty：
dep 的 trigger 会增长 dep.version，并调用每个订阅者的 notify
effect.notify：设置 NOTIFIED 并进入批处理队列（下面详述）。见 ReactiveEffect.notify
effect.trigger：若 PAUSED 则入队等待恢复；若有 scheduler 则调度；否则 runIfDirty（脏了才运行）。见 ReactiveEffect.trigger
runIfDirty：调用 isDirty 检查（见下一节），脏了再 run。见 ReactiveEffect.runIfDirty
五、脏检查与 computed 协作

isDirty(sub)：遍历当前 sub.deps 的每个 link：
若 dep.version 与 link.version 不等，表示该依赖已变更，返回 true
若 dep 对应的是某个 computed 的 dep（dep.computed 存在），则调用 refreshComputed(computed) 以“拉式”刷新计算值，刷新后再对比 version 判断是否变化。见 isDirty
兼容性兜底：若 sub._dirty（历史库可能手动设置），也视为脏
refreshComputed(computed)：见 refreshComputed
基于 DIRTY 与 globalVersion 快速路径：
若 TRACKING 且不 DIRTY，则直接返回（缓存有效）
若 computed.globalVersion 与全局 globalVersion 一致，说明整个系统没有新变更，直接返回
SSR 情况：没有渲染 effect 订阅，无法依赖脏检查，使用 globalVersion 快速路径保证缓存
若已 EVALUATED 且“无依赖或未脏”，返回
真正求值：
标记 RUNNING，切换 activeSub/shouldTrack，prepareDeps
计算新值，如果 dep.version 为 0 或者 hasChanged(old, new) 为真，则设置 EVALUATED、更新 _value、dep.version++（极关键：computed 的 dep 版本在值变更时增长）
finally：cleanupDeps、恢复上下文、清 RUNNING
关键结论：computed 的刷新是“惰性”的——当 effect 在 isDirty 中看到它依赖的 computed 时，才会尝试 refreshComputed，刷新可能使 computed 的 dep.version 增加，从而使本 effect 判定为脏并运行。
六、批处理（batch）与通知顺序

batch(sub, isComputed)：打上 NOTIFIED 位并链接到 batchedSub 或 batchedComputed 单链上。见 batch
startBatch/endBatch：成对使用，结束时真正执行批量触发。见 startBatch 与 endBatch
处理顺序与策略：
先处理 batchedComputed：仅清理 next 指针与 NOTIFIED 标志，不直接执行刷新
理由：computed 是“拉式”刷新，实际刷新发生在 effect 的 isDirty，被 effect 驱动，从而避免不必要的重复计算
再处理 batchedSub（effects）：清 NOTIFIED 后，若 ACTIVE 则调用 e.trigger()（进而 runIfDirty）
错误收集：逐个 try/catch，最后统一抛出首个错误
价值：去重、聚合触发，避免重复运行 effect；同时 computed 借助“只清标记不执行”的策略，维持惰性模型。
七、调度与暂停/恢复

scheduler：若 effect 配置了 scheduler，则触发时优先用它，这允许上层（runtime-core）做基于任务队列/flush 的调度策略。见 ReactiveEffect.trigger
pause()/resume()：将 effect 暂停，触发会被收集到 pausedQueueEffects；resume 时若在队列中则立即触发一次，确保不丢事件。见 ReactiveEffect.pause 与 ReactiveEffect.resume
ALLOW_RECURSE 与 renderer：在渲染器中通过 toggleRecurse 控制 allowRecurse，从而避免生命周期/渲染钩子里的状态改动造成自触发递归更新；该标志在 ReactiveEffect.notify 中用于“正在 RUNNING 且未允许递归”的情况下直接忽略通知。
八、依赖跟踪开关（全局）

shouldTrack 与 trackStack：用于临时暂停/恢复依赖收集，避免不该追踪的读操作被 track（如只读派生、执行 cleanup 等）。见
shouldTrack
pauseTracking
enableTracking
resetTracking
用法：嵌套调用安全（用栈保存之前的状态），常用于运行 cleanup、只读访问、或框架内部短暂关闭跟踪的场景。
九、清理回调（onEffectCleanup）

onEffectCleanup(fn)：为“下一次 run 之前”或“stop 时”注册清理函数，只能在有 active effect 时调用；否则 DEV 下报警告。见 onEffectCleanup
cleanupEffect(e)：真正执行清理时临时清空 activeSub，以防清理过程被误追踪依赖。见 cleanupEffect
十、public API 与 runner

effect(fn, options) 返回 runner，runner.effect 持有内部实例，支持 stop(runner)。见
effect
stop
十一、典型执行流程小结

普通 effect：
run 阶段：prepareDeps → 执行 fn → getter track 建立 link（记录 link.version = dep.version）→ cleanupDeps
写操作：触发 dep.version++ → 通知 effect.batch → endBatch 时触发 effect.trigger → runIfDirty → isDirty 发现某个 dep 的版本号不同 → 运行 run
依赖 computed 的 effect：
写操作导致 computed 内部依赖变化 → computed 被标记 DIRTY，并把订阅该 computed 的 effect 加入 batchedSub
endBatch：effect.trigger → runIfDirty → isDirty 时遇到 computed 的 dep，先 refreshComputed（惰性求值，若值变化则 computed.dep.version++），再比较版本 → 变更则 run
有 scheduler 的 effect：
触发时不会直接 runIfDirty，而是交给 scheduler；runtime-core 会用它整合到组件更新队列里（flush 时机、优先级等）。
十二、设计优势与对比

以 dep.version + link.version 的“整数比较”替代了旧版的 Set 比较/脏标记，isDirty 极快
双链表的 prepare/cleanup 保证依赖集合是“精确最小集”，且在大多数场景常数开销低
computed 的惰性刷新避免无用计算，和批处理策略协同，提升整体吞吐
 */
import { extend, hasChanged } from '@vue/shared'
import type { ComputedRefImpl } from './computed'
import type { TrackOpTypes, TriggerOpTypes } from './constants'
import { type Link, globalVersion } from './dep'
import { activeEffectScope } from './effectScope'
import { warn } from './warning'

export type EffectScheduler = (...args: any[]) => any

export type DebuggerEvent = {
  effect: Subscriber
} & DebuggerEventExtraInfo

export type DebuggerEventExtraInfo = {
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}

export interface DebuggerOptions {
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
}

export interface ReactiveEffectOptions extends DebuggerOptions {
  scheduler?: EffectScheduler
  allowRecurse?: boolean
  onStop?: () => void
}

export interface ReactiveEffectRunner<T = any> {
  (): T
  effect: ReactiveEffect
}

export let activeSub: Subscriber | undefined

export enum EffectFlags {
  /**
   * ReactiveEffect only
   */
  /**
   * - ACTIVE：处于活动状态（未 stop）
   * - RUNNING：当前正在执行 run
   * - TRACKING：允许收集依赖
   * - NOTIFIED：已被某个 dep 通知过（用于批处理去重）
   * - DIRTY：仅用于 computed，表明其值需要重新求值
   * - ALLOW_RECURSE：允许递归（防止生命周期里自触发死循环的开关）
   * - PAUSED：暂停触发（触发将被排队，恢复时统一触发）
   * - EVALUATED：computed 已至少计算过一次
   */
  ACTIVE = 1 << 0,
  RUNNING = 1 << 1,
  TRACKING = 1 << 2,
  NOTIFIED = 1 << 3,
  DIRTY = 1 << 4,
  ALLOW_RECURSE = 1 << 5,
  PAUSED = 1 << 6,
  EVALUATED = 1 << 7,
}

/**
 * Subscriber is a type that tracks (or subscribes to) a list of deps.
 */
export interface Subscriber extends DebuggerOptions {
  /**
   * Head of the doubly linked list representing the deps
   * @internal
   */
  deps?: Link
  /**
   * Tail of the same list
   * @internal
   */
  depsTail?: Link
  /**
   * @internal
   */
  flags: EffectFlags
  /**
   * @internal
   */
  next?: Subscriber
  /**
   * returning `true` indicates it's a computed that needs to call notify
   * on its dep too
   * @internal
   */
  notify(): true | void
}

const pausedQueueEffects = new WeakSet<ReactiveEffect>()

export class ReactiveEffect<T = any>
  implements Subscriber, ReactiveEffectOptions
{
  /**
   * @internal
   */
  deps?: Link = undefined
  /**
   * @internal
   */
  depsTail?: Link = undefined
  /**
   * @internal
   */
  flags: EffectFlags = EffectFlags.ACTIVE | EffectFlags.TRACKING
  /**
   * @internal
   */
  next?: Subscriber = undefined
  /**
   * @internal
   */
  cleanup?: () => void = undefined

  scheduler?: EffectScheduler = undefined
  onStop?: () => void
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void

  constructor(public fn: () => T) {
    if (activeEffectScope && activeEffectScope.active) {
      activeEffectScope.effects.push(this)
    }
  }

  pause(): void {
    this.flags |= EffectFlags.PAUSED
  }

  resume(): void {
    if (this.flags & EffectFlags.PAUSED) {
      this.flags &= ~EffectFlags.PAUSED
      if (pausedQueueEffects.has(this)) {
        pausedQueueEffects.delete(this)
        this.trigger()
      }
    }
  }

  /**
   * @internal
   */
  notify(): void {
    if (
      this.flags & EffectFlags.RUNNING &&
      !(this.flags & EffectFlags.ALLOW_RECURSE)
    ) {
      return
    }
    if (!(this.flags & EffectFlags.NOTIFIED)) {
      batch(this)
    }
  }

  run(): T {
    // TODO cleanupEffect

    if (!(this.flags & EffectFlags.ACTIVE)) {
      // stopped during cleanup
      return this.fn()
    }

    this.flags |= EffectFlags.RUNNING
    cleanupEffect(this)
    prepareDeps(this)
    const prevEffect = activeSub
    const prevShouldTrack = shouldTrack
    activeSub = this
    shouldTrack = true

    try {
      return this.fn()
    } finally {
      if (__DEV__ && activeSub !== this) {
        warn(
          'Active effect was not restored correctly - ' +
            'this is likely a Vue internal bug.',
        )
      }
      cleanupDeps(this)
      activeSub = prevEffect
      shouldTrack = prevShouldTrack
      this.flags &= ~EffectFlags.RUNNING
    }
  }

  stop(): void {
    if (this.flags & EffectFlags.ACTIVE) {
      for (let link = this.deps; link; link = link.nextDep) {
        removeSub(link)
      }
      this.deps = this.depsTail = undefined
      cleanupEffect(this)
      this.onStop && this.onStop()
      this.flags &= ~EffectFlags.ACTIVE
    }
  }

  trigger(): void {
    if (this.flags & EffectFlags.PAUSED) {
      pausedQueueEffects.add(this)
    } else if (this.scheduler) {
      this.scheduler()
    } else {
      this.runIfDirty()
    }
  }

  /**
   * @internal
   */
  runIfDirty(): void {
    if (isDirty(this)) {
      this.run()
    }
  }

  get dirty(): boolean {
    return isDirty(this)
  }
}

/**
 * For debugging
 */
// function printDeps(sub: Subscriber) {
//   let d = sub.deps
//   let ds = []
//   while (d) {
//     ds.push(d)
//     d = d.nextDep
//   }
//   return ds.map(d => ({
//     id: d.id,
//     prev: d.prevDep?.id,
//     next: d.nextDep?.id,
//   }))
// }

let batchDepth = 0
let batchedSub: Subscriber | undefined
let batchedComputed: Subscriber | undefined

export function batch(sub: Subscriber, isComputed = false): void {
  sub.flags |= EffectFlags.NOTIFIED
  if (isComputed) {
    sub.next = batchedComputed
    batchedComputed = sub
    return
  }
  sub.next = batchedSub
  batchedSub = sub
}

/**
 * @internal
 */
export function startBatch(): void {
  batchDepth++
}

/**
 * Run batched effects when all batches have ended
 * @internal
 */
export function endBatch(): void {
  if (--batchDepth > 0) {
    return
  }

  if (batchedComputed) {
    let e: Subscriber | undefined = batchedComputed
    batchedComputed = undefined
    while (e) {
      const next: Subscriber | undefined = e.next
      e.next = undefined
      e.flags &= ~EffectFlags.NOTIFIED
      e = next
    }
  }

  let error: unknown
  while (batchedSub) {
    let e: Subscriber | undefined = batchedSub
    batchedSub = undefined
    while (e) {
      const next: Subscriber | undefined = e.next
      e.next = undefined
      e.flags &= ~EffectFlags.NOTIFIED
      if (e.flags & EffectFlags.ACTIVE) {
        try {
          // ACTIVE flag is effect-only
          ;(e as ReactiveEffect).trigger()
        } catch (err) {
          if (!error) error = err
        }
      }
      e = next
    }
  }

  if (error) throw error
}

function prepareDeps(sub: Subscriber) {
  // Prepare deps for tracking, starting from the head
  for (let link = sub.deps; link; link = link.nextDep) {
    // set all previous deps' (if any) version to -1 so that we can track
    // which ones are unused after the run
    link.version = -1
    // store previous active sub if link was being used in another context
    link.prevActiveLink = link.dep.activeLink
    link.dep.activeLink = link
  }
}

function cleanupDeps(sub: Subscriber) {
  // Cleanup unsued deps
  let head
  let tail = sub.depsTail
  let link = tail
  while (link) {
    const prev = link.prevDep
    if (link.version === -1) {
      if (link === tail) tail = prev
      // unused - remove it from the dep's subscribing effect list
      removeSub(link)
      // also remove it from this effect's dep list
      removeDep(link)
    } else {
      // The new head is the last node seen which wasn't removed
      // from the doubly-linked list
      head = link
    }

    // restore previous active link if any
    link.dep.activeLink = link.prevActiveLink
    link.prevActiveLink = undefined
    link = prev
  }
  // set the new head & tail
  sub.deps = head
  sub.depsTail = tail
}

function isDirty(sub: Subscriber): boolean {
  for (let link = sub.deps; link; link = link.nextDep) {
    if (
      link.dep.version !== link.version ||
      (link.dep.computed &&
        (refreshComputed(link.dep.computed) ||
          link.dep.version !== link.version))
    ) {
      return true
    }
  }
  // @ts-expect-error only for backwards compatibility where libs manually set
  // this flag - e.g. Pinia's testing module
  if (sub._dirty) {
    return true
  }
  return false
}

/**
 * Returning false indicates the refresh failed
 * @internal
 */
export function refreshComputed(computed: ComputedRefImpl): undefined {
  if (
    computed.flags & EffectFlags.TRACKING &&
    !(computed.flags & EffectFlags.DIRTY)
  ) {
    return
  }
  computed.flags &= ~EffectFlags.DIRTY

  // Global version fast path when no reactive changes has happened since
  // last refresh.
  if (computed.globalVersion === globalVersion) {
    return
  }
  computed.globalVersion = globalVersion

  // In SSR there will be no render effect, so the computed has no subscriber
  // and therefore tracks no deps, thus we cannot rely on the dirty check.
  // Instead, computed always re-evaluate and relies on the globalVersion
  // fast path above for caching.
  // #12337 if computed has no deps (does not rely on any reactive data) and evaluated,
  // there is no need to re-evaluate.
  if (
    !computed.isSSR &&
    computed.flags & EffectFlags.EVALUATED &&
    ((!computed.deps && !(computed as any)._dirty) || !isDirty(computed))
  ) {
    return
  }
  computed.flags |= EffectFlags.RUNNING

  const dep = computed.dep
  const prevSub = activeSub
  const prevShouldTrack = shouldTrack
  activeSub = computed
  shouldTrack = true

  try {
    prepareDeps(computed)
    const value = computed.fn(computed._value)
    if (dep.version === 0 || hasChanged(value, computed._value)) {
      computed.flags |= EffectFlags.EVALUATED
      computed._value = value
      dep.version++
    }
  } catch (err) {
    dep.version++
    throw err
  } finally {
    activeSub = prevSub
    shouldTrack = prevShouldTrack
    cleanupDeps(computed)
    computed.flags &= ~EffectFlags.RUNNING
  }
}

function removeSub(link: Link, soft = false) {
  const { dep, prevSub, nextSub } = link
  if (prevSub) {
    prevSub.nextSub = nextSub
    link.prevSub = undefined
  }
  if (nextSub) {
    nextSub.prevSub = prevSub
    link.nextSub = undefined
  }
  if (__DEV__ && dep.subsHead === link) {
    // was previous head, point new head to next
    dep.subsHead = nextSub
  }

  if (dep.subs === link) {
    // was previous tail, point new tail to prev
    dep.subs = prevSub

    if (!prevSub && dep.computed) {
      // if computed, unsubscribe it from all its deps so this computed and its
      // value can be GCed
      dep.computed.flags &= ~EffectFlags.TRACKING
      for (let l = dep.computed.deps; l; l = l.nextDep) {
        // here we are only "soft" unsubscribing because the computed still keeps
        // referencing the deps and the dep should not decrease its sub count
        removeSub(l, true)
      }
    }
  }

  if (!soft && !--dep.sc && dep.map) {
    // #11979
    // property dep no longer has effect subscribers, delete it
    // this mostly is for the case where an object is kept in memory but only a
    // subset of its properties is tracked at one time
    dep.map.delete(dep.key)
  }
}

function removeDep(link: Link) {
  const { prevDep, nextDep } = link
  if (prevDep) {
    prevDep.nextDep = nextDep
    link.prevDep = undefined
  }
  if (nextDep) {
    nextDep.prevDep = prevDep
    link.nextDep = undefined
  }
}

export interface ReactiveEffectRunner<T = any> {
  (): T
  effect: ReactiveEffect
}

export function effect<T = any>(
  fn: () => T,
  options?: ReactiveEffectOptions,
): ReactiveEffectRunner<T> {
  if ((fn as ReactiveEffectRunner).effect instanceof ReactiveEffect) {
    fn = (fn as ReactiveEffectRunner).effect.fn
  }

  const e = new ReactiveEffect(fn)
  if (options) {
    extend(e, options)
  }
  try {
    e.run()
  } catch (err) {
    e.stop()
    throw err
  }
  const runner = e.run.bind(e) as ReactiveEffectRunner
  runner.effect = e
  return runner
}

/**
 * Stops the effect associated with the given runner.
 *
 * @param runner - Association with the effect to stop tracking.
 */
export function stop(runner: ReactiveEffectRunner): void {
  runner.effect.stop()
}

/**
 * @internal
 */
export let shouldTrack = true
const trackStack: boolean[] = []

/**
 * Temporarily pauses tracking.
 */
export function pauseTracking(): void {
  trackStack.push(shouldTrack)
  shouldTrack = false
}

/**
 * Re-enables effect tracking (if it was paused).
 */
export function enableTracking(): void {
  trackStack.push(shouldTrack)
  shouldTrack = true
}

/**
 * Resets the previous global effect tracking state.
 */
export function resetTracking(): void {
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}

/**
 * Registers a cleanup function for the current active effect.
 * The cleanup function is called right before the next effect run, or when the
 * effect is stopped.
 *
 * Throws a warning if there is no current active effect. The warning can be
 * suppressed by passing `true` to the second argument.
 *
 * @param fn - the cleanup function to be registered
 * @param failSilently - if `true`, will not throw warning when called without
 * an active effect.
 */
export function onEffectCleanup(fn: () => void, failSilently = false): void {
  if (activeSub instanceof ReactiveEffect) {
    activeSub.cleanup = fn
  } else if (__DEV__ && !failSilently) {
    warn(
      `onEffectCleanup() was called when there was no active effect` +
        ` to associate with.`,
    )
  }
}

function cleanupEffect(e: ReactiveEffect) {
  const { cleanup } = e
  e.cleanup = undefined
  if (cleanup) {
    // run cleanup without active effect
    const prevSub = activeSub
    activeSub = undefined
    try {
      cleanup()
    } finally {
      activeSub = prevSub
    }
  }
}
