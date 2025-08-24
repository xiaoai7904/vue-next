import {
  type Component,
  type ComponentInternalInstance,
  type ConcreteComponent,
  type Data,
  getComponentPublicInstance,
  validateComponentName,
} from './component'
import type {
  ComponentOptions,
  MergedComponentOptions,
  RuntimeCompilerOptions,
} from './componentOptions'
import type {
  ComponentCustomProperties,
  ComponentPublicInstance,
} from './componentPublicInstance'
import { type Directive, validateDirectiveName } from './directives'
import type { ElementNamespace, RootRenderFunction } from './renderer'
import type { InjectionKey } from './apiInject'
import { warn } from './warning'
import { type VNode, cloneVNode, createVNode } from './vnode'
import type { RootHydrateFunction } from './hydration'
import { devtoolsInitApp, devtoolsUnmountApp } from './devtools'
import { NO, extend, hasOwn, isFunction, isObject } from '@vue/shared'
import { version } from '.'
import { installAppCompatProperties } from './compat/global'
import type { NormalizedPropsOptions } from './componentProps'
import type { ObjectEmitsOptions } from './componentEmits'
import { ErrorCodes, callWithAsyncErrorHandling } from './errorHandling'
import type { DefineComponent } from './apiDefineComponent'

export interface App<HostElement = any> {
  version: string
  config: AppConfig

  use<Options extends unknown[]>(
    plugin: Plugin<Options>,
    ...options: NoInfer<Options>
  ): this
  use<Options>(plugin: Plugin<Options>, options: NoInfer<Options>): this

  mixin(mixin: ComponentOptions): this
  component(name: string): Component | undefined
  component<T extends Component | DefineComponent>(
    name: string,
    component: T,
  ): this
  directive<
    HostElement = any,
    Value = any,
    Modifiers extends string = string,
    Arg extends string = string,
  >(
    name: string,
  ): Directive<HostElement, Value, Modifiers, Arg> | undefined
  directive<
    HostElement = any,
    Value = any,
    Modifiers extends string = string,
    Arg extends string = string,
  >(
    name: string,
    directive: Directive<HostElement, Value, Modifiers, Arg>,
  ): this
  mount(
    rootContainer: HostElement | string,
    /**
     * @internal
     */
    isHydrate?: boolean,
    /**
     * @internal
     */
    namespace?: boolean | ElementNamespace,
    /**
     * @internal
     */
    vnode?: VNode,
  ): ComponentPublicInstance
  unmount(): void
  onUnmount(cb: () => void): void
  provide<T, K = InjectionKey<T> | string | number>(
    key: K,
    value: K extends InjectionKey<infer V> ? V : T,
  ): this

  /**
   * Runs a function with the app as active instance. This allows using of `inject()` within the function to get access
   * to variables provided via `app.provide()`.
   *
   * @param fn - function to run with the app as active instance
   */
  runWithContext<T>(fn: () => T): T

  // internal, but we need to expose these for the server-renderer and devtools
  _uid: number
  _component: ConcreteComponent
  _props: Data | null
  _container: HostElement | null
  _context: AppContext
  _instance: ComponentInternalInstance | null

  /**
   * @internal custom element vnode
   */
  _ceVNode?: VNode

  /**
   * v2 compat only
   */
  filter?(name: string): Function | undefined
  filter?(name: string, filter: Function): this

  /**
   * @internal v3 compat only
   */
  _createRoot?(options: ComponentOptions): ComponentPublicInstance
}

export type OptionMergeFunction = (to: unknown, from: unknown) => any

export interface AppConfig {
  // @private
  readonly isNativeTag: (tag: string) => boolean

  performance: boolean
  optionMergeStrategies: Record<string, OptionMergeFunction>
  globalProperties: ComponentCustomProperties & Record<string, any>
  errorHandler?: (
    err: unknown,
    instance: ComponentPublicInstance | null,
    info: string,
  ) => void
  warnHandler?: (
    msg: string,
    instance: ComponentPublicInstance | null,
    trace: string,
  ) => void

  /**
   * Options to pass to `@vue/compiler-dom`.
   * Only supported in runtime compiler build.
   */
  compilerOptions: RuntimeCompilerOptions

  /**
   * @deprecated use config.compilerOptions.isCustomElement
   */
  isCustomElement?: (tag: string) => boolean

  /**
   * TODO document for 3.5
   * Enable warnings for computed getters that recursively trigger itself.
   */
  warnRecursiveComputed?: boolean

  /**
   * Whether to throw unhandled errors in production.
   * Default is `false` to avoid crashing on any error (and only logs it)
   * But in some cases, e.g. SSR, throwing might be more desirable.
   */
  throwUnhandledErrorInProduction?: boolean

  /**
   * Prefix for all useId() calls within this app
   */
  idPrefix?: string
}

export interface AppContext {
  app: App // for devtools
  config: AppConfig
  mixins: ComponentOptions[]
  components: Record<string, Component>
  directives: Record<string, Directive>
  provides: Record<string | symbol, any>

  /**
   * Cache for merged/normalized component options
   * Each app instance has its own cache because app-level global mixins and
   * optionMergeStrategies can affect merge behavior.
   * @internal
   */
  optionsCache: WeakMap<ComponentOptions, MergedComponentOptions>
  /**
   * Cache for normalized props options
   * @internal
   */
  propsCache: WeakMap<ConcreteComponent, NormalizedPropsOptions>
  /**
   * Cache for normalized emits options
   * @internal
   */
  emitsCache: WeakMap<ConcreteComponent, ObjectEmitsOptions | null>
  /**
   * HMR only
   * @internal
   */
  reload?: () => void
  /**
   * v2 compat only
   * @internal
   */
  filters?: Record<string, Function>
}

type PluginInstallFunction<Options = any[]> = Options extends unknown[]
  ? (app: App, ...options: Options) => any
  : (app: App, options: Options) => any

export type ObjectPlugin<Options = any[]> = {
  install: PluginInstallFunction<Options>
}
export type FunctionPlugin<Options = any[]> = PluginInstallFunction<Options> &
  Partial<ObjectPlugin<Options>>

export type Plugin<
  Options = any[],
  // TODO: in next major Options extends unknown[] and remove P
  P extends unknown[] = Options extends unknown[] ? Options : [Options],
> = FunctionPlugin<P> | ObjectPlugin<P>

export function createAppContext(): AppContext {
  return {
    app: null as any,
    config: {
      isNativeTag: NO,
      performance: false,
      globalProperties: {},
      optionMergeStrategies: {},
      errorHandler: undefined,
      warnHandler: undefined,
      compilerOptions: {},
    },
    mixins: [],
    components: {},
    directives: {},
    provides: Object.create(null),
    optionsCache: new WeakMap(),
    propsCache: new WeakMap(),
    emitsCache: new WeakMap(),
  }
}

export type CreateAppFunction<HostElement> = (
  rootComponent: Component,
  rootProps?: Data | null,
) => App<HostElement>

let uid = 0
/**
 *
一、函数签名与返回值

签名
参数 render: RootRenderFunction
，是平台渲染入口（如 runtime-dom 传入的 DOM 渲染函数）。

参数 hydrate?: RootHydrateFunction，可选的同构/水合函数（SSR 客户端激活时使用）。
返回值 CreateAppFunction
：返回一个 createApp(rootComponent, rootProps?) 工厂函数，用于创建 App 实例。

泛型 HostElement
通过泛型把宿主平台容器类型（DOM 的 Element，或自定义渲染器里的其他元素类型）透传到 app.mount 等 API 的参数与返回类型中。
二、createApp 的初始化流程（形参校验与上下文创建）

rootComponent 规整
若传入的 rootComponent 不是函数（即是对象式 options 组件），会先 shallow-clone 一份：rootComponent = extend({}, rootComponent)。避免后续对传入对象的直接突变，保证稳定性。
rootProps 校验
若 rootProps 非 null 且不是对象，会在 DEV 下报警告并忽略设置（置为 null），保证根组件 props 传参的正确性。
创建应用上下文
const context = createAppContext()：初始化 AppContext，包含：
config：全局配置（globalProperties、optionMergeStrategies、compilerOptions、errorHandler、warnHandler 等）
mixins/components/directives：全局注册容器
provides：依赖注入容器（provide/inject）
optionsCache/propsCache/emitsCache：组件选项/props/emits 的归一化缓存（App 级别，便于隔离）
插件与清理钩子
installedPlugins: WeakSet 用于防重复安装插件（按引用去重）
pluginCleanupFns: Array<() => any> 用于在 app.unmount() 时统一调用插件卸载清理函数
装载状态
isMounted: boolean 标记当前 App 是否已挂载，避免重复挂载
三、App 实例结构与字段

app 是一个对象字面量，并赋给 context.app 以便 devtools 使用；核心字段：
_uid：自增应用 id
_component：根组件（ConcreteComponent）
_props：根组件 props
_container：首次挂载后会记录根容器
_context：上文创建的 AppContext
_instance：根组件的内部实例（mount 后才可用）
version：框架版本（从 version 导入）
config getter/setter
get config() { return context.config }：读取应用级全局配置
set config(v) { DEV 下警告不允许整体替换，只能改内部字段 }：防止整块替换导致不一致
四、全局 API 方法逐个解析

1.
use(plugin, ...options)
职责：安装插件，支持对象插件（带 install 方法）与函数插件两种形态。
机制：
重复安装：通过 WeakSet 去重，重复就警告。
对象插件：调用 plugin.install(app, ...options)
函数插件：直接调用 plugin(app, ...options)
非法：DEV 下报警告必须是函数或带 install 的对象
返回 this：支持链式调用
1.
mixin(mixin)
仅在 FEATURE_OPTIONS_API 构建下可用。
防重复：如果已存在则 DEV 下警告；否则 push 到 context.mixins 中。
用于影响后续组件的选项合并行为（每个 App 独立）。
1.
component(name, component?)
注册/获取全局组件：
获取：不传 component 参数返回已注册项
注册：DEV 下校验命名合法性与重复注册；存入 context.components[name]
返回 this：支持链式调用
1.
directive(name, directive?)
注册/获取全局指令：
与 component 类似，校验命名、重复注册、赋值到 context.directives[name]
返回 this：支持链式调用
1.
mount(rootContainer, isHydrate?, namespace?)
核心职责：把根 vnode 渲染进容器，或进行水合激活。
防重挂载与容器复用提示：
DEV 下若 rootContainer.vue_app 已存在，警告先调用上一个 app.unmount()
创建根 vnode：
使用 app._ceVNode（自定义元素路径下会事先构造）或 createVNode(rootComponent, rootProps)
将 app 上下文挂到 vnode.appContext，让根实例继承 app 级别的全局配置/注册项
命名空间处理：
namespace === true -> 'svg'
namespace === false -> undefined
用于控制根节点命名空间渲染（例如直接把根节点当作 SVG）
HMR 支持（DEV）：
context.reload = () => { cloneVNode(vnode) 重渲染并避免 hydration }
渲染/水合：
若 isHydrate 且传入了 hydrate，则调用 hydrate(vnode, rootContainer)
否则调用 render(vnode, rootContainer, namespace)
注意：这里 render 与 hydrate 均来自渲染器注入（即 baseCreateRenderer 的返回值）
完成挂载后：
isMounted = true，app._container 记录容器
在容器上打标记 vue_app = app，便于定位容器所属 App
DEV 或生产带 devtools 支持时：
app._instance = vnode.component（根组件实例）
devtoolsInitApp(app, version) 上报到 devtools
返回根组件的 public instance：getComponentPublicInstance(vnode.component!)
1.
onUnmount(cleanupFn)
注册卸载清理函数，供插件或外部逻辑在 app.unmount() 时统一触发。
DEV 下若 cleanupFn 不是函数会警告。
函数会 push 进 pluginCleanupFns。
1.
unmount()
职责：卸载整个应用。
若已挂载：
首先以 APP_UNMOUNT_CLEANUP 错误代码调用 callWithAsyncErrorHandling(pluginCleanupFns, app._instance, ErrorCodes.APP_UNMOUNT_CLEANUP)，安全执行所有已注册的清理函数
调用 render(null, app._container) 卸载整棵子树
DEV 或带 devtools 构建下：
app._instance = null
devtoolsUnmountApp(app) 通知 devtools
删除容器上的 vue_app 标记
否则 DEV 下警告未挂载不可卸载
1.
provide(key, value)
在 App 级别 provides 上写入依赖注入的值。
DEV 下若 key 已存在会警告：
若是自身定义过（hasOwn），提示将被覆盖
若是从父元素（自定义元素场景）继承的 provides，提示继承值将被覆盖
返回 this：链式调用
1.
runWithContext(fn)
把当前 app 设置到一个全局变量 currentApp，在 fn() 执行期间生效，结束后恢复：
作用：允许在没有明确组件实例上下文的情况下，让 inject 等依赖 currentApp 的能力可用（例如在某些外层调用容器中）。
对应的 currentApp 定义在文件末尾导出：currentApp（变量，用于标识当前 App；此处符号类型以函数占位说明，实际为变量导出）。
五、兼容层注入

末尾若存在 COMPAT 标记（v2 兼容构建），会调用 installAppCompatProperties(app, context, render) 注入 Vue 2 兼容 API（如全局原型、nextTick 别名、legacy 挂载方式等）。
六、关键设计点总结

与渲染器的解耦：createAppAPI 不关心平台细节，render/hydrate 由渲染器注入，这让 runtime-core 能服务多种宿主（DOM、原生、自定义渲染器）。
单一挂载约束：同一 App 实例只能挂载一次；要复挂需重新创建 App。
DevTools/HMR 亲和：在 DEV 或带 prod devtools 构建中自动上报/清理；HMR 提供 context.reload。
插件系统稳健：WeakSet 去重，支持对象/函数两种插件形态，并提供 app.onUnmount 清理钩子。
AppContext 隔离：每个 App 拥有独立的 mixins/components/directives/provides 与缓存，避免多 App 之间相互污染。
provide/inject 的 App 级入口：允许全局 provide，并通过 runWithContext 在非组件上下文中暂时绑定当前 App。
 */
export function createAppAPI<HostElement>(
  render: RootRenderFunction<HostElement>,
  hydrate?: RootHydrateFunction,
): CreateAppFunction<HostElement> {
  return function createApp(rootComponent, rootProps = null) {
    if (!isFunction(rootComponent)) {
      rootComponent = extend({}, rootComponent)
    }

    if (rootProps != null && !isObject(rootProps)) {
      __DEV__ && warn(`root props passed to app.mount() must be an object.`)
      rootProps = null
    }

    const context = createAppContext()
    const installedPlugins = new WeakSet()
    const pluginCleanupFns: Array<() => any> = []

    let isMounted = false

    const app: App = (context.app = {
      _uid: uid++,
      _component: rootComponent as ConcreteComponent,
      _props: rootProps,
      _container: null,
      _context: context,
      _instance: null,

      version,

      get config() {
        return context.config
      },

      set config(v) {
        if (__DEV__) {
          warn(
            `app.config cannot be replaced. Modify individual options instead.`,
          )
        }
      },

      use(plugin: Plugin, ...options: any[]) {
        if (installedPlugins.has(plugin)) {
          __DEV__ && warn(`Plugin has already been applied to target app.`)
        } else if (plugin && isFunction(plugin.install)) {
          installedPlugins.add(plugin)
          plugin.install(app, ...options)
        } else if (isFunction(plugin)) {
          installedPlugins.add(plugin)
          plugin(app, ...options)
        } else if (__DEV__) {
          warn(
            `A plugin must either be a function or an object with an "install" ` +
              `function.`,
          )
        }
        return app
      },

      mixin(mixin: ComponentOptions) {
        if (__FEATURE_OPTIONS_API__) {
          if (!context.mixins.includes(mixin)) {
            context.mixins.push(mixin)
          } else if (__DEV__) {
            warn(
              'Mixin has already been applied to target app' +
                (mixin.name ? `: ${mixin.name}` : ''),
            )
          }
        } else if (__DEV__) {
          warn('Mixins are only available in builds supporting Options API')
        }
        return app
      },

      component(name: string, component?: Component): any {
        if (__DEV__) {
          validateComponentName(name, context.config)
        }
        if (!component) {
          return context.components[name]
        }
        if (__DEV__ && context.components[name]) {
          warn(`Component "${name}" has already been registered in target app.`)
        }
        context.components[name] = component
        return app
      },

      directive(name: string, directive?: Directive) {
        if (__DEV__) {
          validateDirectiveName(name)
        }

        if (!directive) {
          return context.directives[name] as any
        }
        if (__DEV__ && context.directives[name]) {
          warn(`Directive "${name}" has already been registered in target app.`)
        }
        context.directives[name] = directive
        return app
      },

      mount(
        rootContainer: HostElement,
        isHydrate?: boolean,
        namespace?: boolean | ElementNamespace,
      ): any {
        if (!isMounted) {
          // #5571
          if (__DEV__ && (rootContainer as any).__vue_app__) {
            warn(
              `There is already an app instance mounted on the host container.\n` +
                ` If you want to mount another app on the same host container,` +
                ` you need to unmount the previous app by calling \`app.unmount()\` first.`,
            )
          }
          const vnode = app._ceVNode || createVNode(rootComponent, rootProps)
          // store app context on the root VNode.
          // this will be set on the root instance on initial mount.
          vnode.appContext = context

          if (namespace === true) {
            namespace = 'svg'
          } else if (namespace === false) {
            namespace = undefined
          }

          // HMR root reload
          if (__DEV__) {
            context.reload = () => {
              const cloned = cloneVNode(vnode)
              // avoid hydration for hmr updating
              cloned.el = null
              // casting to ElementNamespace because TS doesn't guarantee type narrowing
              // over function boundaries
              render(cloned, rootContainer, namespace as ElementNamespace)
            }
          }

          if (isHydrate && hydrate) {
            hydrate(vnode as VNode<Node, Element>, rootContainer as any)
          } else {
            render(vnode, rootContainer, namespace)
          }
          isMounted = true
          app._container = rootContainer
          // for devtools and telemetry
          ;(rootContainer as any).__vue_app__ = app

          if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
            app._instance = vnode.component
            devtoolsInitApp(app, version)
          }

          return getComponentPublicInstance(vnode.component!)
        } else if (__DEV__) {
          warn(
            `App has already been mounted.\n` +
              `If you want to remount the same app, move your app creation logic ` +
              `into a factory function and create fresh app instances for each ` +
              `mount - e.g. \`const createMyApp = () => createApp(App)\``,
          )
        }
      },

      onUnmount(cleanupFn: () => void) {
        if (__DEV__ && typeof cleanupFn !== 'function') {
          warn(
            `Expected function as first argument to app.onUnmount(), ` +
              `but got ${typeof cleanupFn}`,
          )
        }
        pluginCleanupFns.push(cleanupFn)
      },

      unmount() {
        if (isMounted) {
          callWithAsyncErrorHandling(
            pluginCleanupFns,
            app._instance,
            ErrorCodes.APP_UNMOUNT_CLEANUP,
          )
          render(null, app._container)
          if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
            app._instance = null
            devtoolsUnmountApp(app)
          }
          delete app._container.__vue_app__
        } else if (__DEV__) {
          warn(`Cannot unmount an app that is not mounted.`)
        }
      },

      provide(key, value) {
        if (__DEV__ && (key as string | symbol) in context.provides) {
          if (hasOwn(context.provides, key as string | symbol)) {
            warn(
              `App already provides property with key "${String(key)}". ` +
                `It will be overwritten with the new value.`,
            )
          } else {
            // #13212, context.provides can inherit the provides object from parent on custom elements
            warn(
              `App already provides property with key "${String(key)}" inherited from its parent element. ` +
                `It will be overwritten with the new value.`,
            )
          }
        }

        context.provides[key as string | symbol] = value

        return app
      },

      runWithContext(fn) {
        const lastApp = currentApp
        currentApp = app
        try {
          return fn()
        } finally {
          currentApp = lastApp
        }
      },
    })

    if (__COMPAT__) {
      installAppCompatProperties(app, context, render)
    }

    return app
  }
}

/**
 * @internal Used to identify the current app when using `inject()` within
 * `app.runWithContext()`.
 */
export let currentApp: App<unknown> | null = null
