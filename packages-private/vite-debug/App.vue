<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'

// 三个分别触发 TEXT / CLASS / STYLE 补丁的响应式数据
const msg = ref('hello')
const cls = ref('a')
const color = ref('#ff0000')
const fontSize = ref(16)

// 用于观察补丁效果的目标元素
const targetEl = ref(null)

// DOM 变更日志（可视化观察哪些 DOM 操作发生）
const logs = ref([])
const pushLog = (text) => {
  const time = new Date().toLocaleTimeString()
  logs.value.push(`${time} - ${text}`)
  if (logs.value.length > 200) logs.value.shift()
}

// 记录 MutationObserver，组件卸载时断开
const observer = ref(null)

onMounted(() => {
  const el = targetEl.value
  if (!el) return

  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes') {
        pushLog(`attributes: ${m.attributeName} -> ${el.getAttribute(m.attributeName)}`)
      } else if (m.type === "characterData") {
        pushLog(`textContent: ${m.target.data}`)
      } else if (m.type === 'childList') {
        pushLog('childList changed')
      }
    }
  })

  // 仅观察 class/style 两类属性 + 文本变化（subtree: true 才能观察到文本节点变化）
  mo.observe(el, {
    attributes: true,
    attributeFilter: ['class', 'style'],
    childList: true,
    characterData: true,
    characterDataOldValue: true,
    subtree: true
  })

  observer.value = mo
})

onBeforeUnmount(() => {
  if (observer.value) observer.value.disconnect()
})

// 便捷按钮
const toggleClass = () => {
  cls.value = cls.value === 'a' ? 'b' : 'a'
}
const toggleMsg = () => {
  msg.value = msg.value === 'hello' ? 'world' : 'hello'
}
</script>

<template>
  <div class="wrap">
    <h1>PatchFlags 精准更新 Demo</h1>

    <section class="controls">
      <div class="row">
        <label>msg：</label>
        <input v-model="msg" />
        <button @click="toggleMsg">切换 msg</button>
      </div>
      <div class="row">
        <label>class：</label>
        <input v-model="cls" placeholder="例如：a 或 b" />
        <button @click="toggleClass">切换 class a/b</button>
      </div>
      <div class="row">
        <label>color：</label>
        <input type="color" v-model="color" />
      </div>
      <div class="row">
        <label>fontSize(px)：</label>
        <input type="number" v-model.number="fontSize" min="10" max="60" />
      </div>
    </section>

    <section class="stage">
      <div class="hint">仅当对应数据变化时，才会触发相应的 DOM 补丁（TEXT / CLASS / STYLE）</div>
      <div
        ref="targetEl"
        :class="cls"
        :style="{ color, fontSize: fontSize + 'px' }"
      >{{ msg }}</div>
    </section>

    <section class="log">
      <h3>DOM 变更日志</h3>
      <ul>
        <li v-for="(l,i) in logs" :key="i">{{ l }}</li>
      </ul>
    </section>
  </div>
</template>

<style>
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"; }

.wrap { max-width: 900px; margin: 0 auto; padding: 20px; }

.controls { display: grid; gap: 10px; padding: 12px; border: 1px dashed #8884; border-radius: 8px; }
.row { display: flex; align-items: center; gap: 10px; }
.row label { width: 120px; text-align: right; opacity: .8; }
.row input { padding: 6px 8px; }
.row button { padding: 6px 10px; cursor: pointer; }

.stage { margin-top: 18px; padding: 16px; border: 1px solid #8884; border-radius: 8px; }
.stage .hint { opacity: .7; margin-bottom: 6px; font-size: 12px; }
.stage [ref] { display: inline-block; }

.log { margin-top: 18px; padding: 16px; border: 1px solid #8884; border-radius: 8px; }
.log ul { list-style: none; padding: 0; margin: 0; max-height: 220px; overflow: auto; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 12px; }
.log li { padding: 3px 0; border-bottom: 1px dashed #8882; }

/* 演示用的两个 class */
.a { background: #f0f7ff; border: 1px solid #3b82f6; }
.b { background: #fff7f0; border: 1px solid #f59e0b; }

/* 目标元素的基础样式 */
[ref="targetEl"] { padding: 10px 12px; border-radius: 6px; }
</style>
