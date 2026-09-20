<template>
  <div class="panel" style="margin-top:12px">
    <div class="panel-head">
      <h4>📈 实时价格 + K线</h4>
      <div class="legend" v-if="validCount >= MIN_POINTS">
        <span class="swatch"></span>价格
        <span class="latest">{{ derived.lastPrice.toFixed(2) }}</span>
        <span class="latest-time">{{ derived.lastTime }}</span>
      </div>
    </div>
    <div class="chart-wrap" :class="{frozen: store.wsStatus==='closed' && validCount >= MIN_POINTS}">
      <div ref="chartEl" class="chart"></div>

      <div v-if="overlay" class="overlay">
        <p>{{ overlay.text }}</p>
        <button v-if="overlay.canRetry" class="retry-btn" :disabled="retrying" @click="retry">
          {{ retrying ? '重试中…' : '↻ 重试' }}
        </button>
      </div>

      <div v-else-if="store.wsStatus==='closed'" class="banner">
        <span>⚠️ {{ store.lastError || '行情连接已中断' }}，曲线停留在 {{ derived.lastTime }} 的价格，不再延伸</span>
        <button class="retry-btn sm" :disabled="retrying" @click="retry">{{ retrying ? '重试中…' : '↻ 重试' }}</button>
      </div>
    </div>
  </div>
</template>
<script setup lang="ts">
import { ref, computed, watch, onMounted, onActivated, onUnmounted } from 'vue'
import * as echarts from 'echarts'
import { useTradingStore } from '../store/trading'
import type { Tick } from '../types'

const store = useTradingStore()
const chartEl = ref<HTMLDivElement>()
let inst: echarts.ECharts | null = null
const retrying = ref(false)

const MIN_POINTS = 2          // 少于两笔无法成线
const GAP_FACTOR = 3          // 相邻间隔超过中位间隔的 3 倍视为时间跳空
const GAP_MIN_MS = 1500       // 且至少 1.5s，避免正常抖动被误判
const PRICE_GAP_PCT = 0.05    // 相邻价格跳动超过 5% 视为价格跳空

type Point = [number, number | null]

interface Derived {
  points: Point[]          // 含跳空断点(null)的同一份序列
  lastPrice: number
  lastTime: string
  interval: number         // 典型(tick)间隔
}

// HH:mm:ss 时间戳：优先用后端毫秒时间戳，兼容只有 time 字符串的旧数据
function tickTs(t: Tick): number {
  if (typeof t.ts === 'number' && Number.isFinite(t.ts)) return t.ts
  const parts = t.time.split(':').map(Number)
  const d = new Date()
  d.setHours(parts[0] || 0, parts[1] || 0, parts[2] || 0, 0)
  return d.getTime()
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

function median(values: number[]): number {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  return s[s.length >> 1]
}

// 坐标轴、曲线、图例、最新价全部由这同一份序列派生
const derived = computed<Derived>(() => {
  const pts: Point[] = store.ticks.map(t => [tickTs(t), t.price])
  pts.sort((a, b) => a[0] - b[0])

  const interval = median(pts.slice(1).map((p, i) => p[0] - pts[i][0]).filter(d => d > 0))
  const gapMs = Math.max(interval * GAP_FACTOR, GAP_MIN_MS)

  if (pts.length > 1) {
    const withBreaks: Point[] = [pts[0]]
    let prevPrice = pts[0][1]
    for (let i = 1; i < pts.length; i++) {
      const [t, p] = pts[i]
      const timeGap = interval > 0 && t - pts[i - 1][0] > gapMs
      const priceGap = p != null && prevPrice != null && Math.abs(p - prevPrice) / Math.max(Math.abs(prevPrice), 1e-9) >= PRICE_GAP_PCT
      if (timeGap || priceGap) withBreaks.push([t, null])  // 跳空：留断点而不是连成直线
      withBreaks.push([t, p])
      prevPrice = p
    }
    pts.splice(0, pts.length, ...withBreaks)
  }

  const valid = pts.filter((p): p is [number, number] => p[1] != null)
  const last = valid.length ? valid[valid.length - 1] : null
  return {
    points: pts,
    lastPrice: last ? last[1] : NaN,
    lastTime: last ? fmtTime(last[0]) : '--:--:--',
    interval
  }
})

const validCount = computed(() => store.ticks.length)

const overlay = computed<{ text: string; canRetry: boolean } | null>(() => {
  const n = store.ticks.length
  if (n === 0) {
    if (store.wsStatus === 'closed')
      return { text: `✕ ${store.lastError || '行情连接已中断'}，尚未收到任何行情数据`, canRetry: true }
    if (store.wsStatus === 'connecting')
      return { text: '正在连接行情服务，尚未收到行情数据…', canRetry: false }
    return { text: '已连接，等待第一笔行情数据…', canRetry: false }
  }
  if (n < MIN_POINTS) {
    if (store.wsStatus === 'closed')
      return { text: `✕ ${store.lastError || '行情连接已中断'}：仅有 ${n} 笔行情（至少 ${MIN_POINTS} 笔才能成线）`, canRetry: true }
    return { text: `行情数据不足：仅 ${n} 笔（至少需要 ${MIN_POINTS} 笔），等待更多成交…`, canRetry: false }
  }
  return null
})

function buildOption(d: Derived): echarts.EChartsOption {
  const valid = d.points.filter((p): p is [number, number] => p[1] != null)
  const ready = valid.length >= MIN_POINTS
  const firstTs = ready ? valid[0][0] : undefined
  const lastTs = ready ? valid[valid.length - 1][0] : undefined
  // 坐标轴末端锚定最近一笔行情，只留一个 tick 的余量，刻度与最新行情对齐
  const maxTs = ready && lastTs != null ? (d.interval > 0 ? lastTs + d.interval : lastTs) : undefined

  return {
    backgroundColor: 'transparent',
    grid: { left: 50, right: 15, top: 10, bottom: 25 },
    xAxis: {
      type: 'time',
      min: firstTs,
      max: maxTs,
      axisLabel: { color: '#94a3b8', fontSize: 9 }
    },
    yAxis: { type: 'value', axisLabel: { color: '#94a3b8' } },
    series: [{
      type: 'line',
      data: ready ? d.points : [],
      symbol: 'none',
      connectNulls: false,   // 跳空断口，绝不补线
      lineStyle: { color: '#4fc3f7', width: 1.5 },
      areaStyle: {
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: 'rgba(79,195,247,0.3)' },
          { offset: 1, color: 'rgba(79,195,247,0)' }
        ])
      },
      markLine: ready && lastTs != null ? {
        symbol: 'none',
        silent: true,
        animation: false,
        lineStyle: { color: 'rgba(148,163,184,0.35)', type: 'dashed' },
        label: { formatter: d.lastTime, color: '#94a3b8', fontSize: 9, position: 'insideEndTop' },
        data: [{ xAxis: lastTs }]
      } : undefined
    }],
    animation: false
  }
}

function render() {
  if (!inst) return
  // notMerge：坐标轴与整条序列整体替换，重连后不残留上一段曲线
  inst.setOption(buildOption(derived.value), true)
}

async function retry() {
  if (retrying.value) return
  retrying.value = true
  try { await store.retry() }
  finally { window.setTimeout(() => { retrying.value = false }, 400) }
}

function resize() { inst?.resize() }

// 从其他页面 / 后台标签页返回：重新取数、重连并按最新序列重绘
function onVisible() {
  if (document.visibilityState !== 'visible') return
  inst?.resize()
  if (store.wsStatus === 'closed') {
    store.reconnectWS()
    store.fetchSnapshot().catch(() => {})
  }
  render()
}

onMounted(() => {
  if (chartEl.value) {
    inst = echarts.init(chartEl.value)
    render()
  }
  window.addEventListener('resize', resize)
  document.addEventListener('visibilitychange', onVisible)
  if (store.wsStatus === 'closed') store.reconnectWS()
  // 连接尚未建立时，用同一份行情序列先打底；已在推送则不抢占
  if (store.wsStatus !== 'open' && !store.ticks.length) store.fetchSnapshot().catch(() => {})
})

onActivated(() => {
  inst?.resize()
  if (store.wsStatus === 'closed') {
    store.reconnectWS()
    store.fetchSnapshot().catch(() => {})
  }
  render()
})

watch(derived, render)
watch(() => store.wsStatus, render)

onUnmounted(() => {
  window.removeEventListener('resize', resize)
  document.removeEventListener('visibilitychange', onVisible)
  inst?.dispose()
  inst = null
})
</script>
<style scoped>
.panel{background:#0f1535;border-radius:8px;padding:12px;border:1px solid #1e2a5a}
.panel h4{color:#4fc3f7;font-size:13px;margin-bottom:4px}
.panel-head{display:flex;justify-content:space-between;align-items:center}
.legend{display:flex;align-items:center;gap:6px;font-size:11px;color:#94a3b8}
.legend .swatch{display:inline-block;width:10px;height:3px;border-radius:2px;background:#4fc3f7}
.legend .latest{color:#4fc3f7;font-weight:600;font-family:monospace}
.legend .latest-time{color:#64748b;font-family:monospace}
.chart-wrap{position:relative}
.chart{width:100%;height:300px}
.chart-wrap.frozen .chart{opacity:.45}
.overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;background:rgba(10,14,39,.82);border-radius:4px;color:#94a3b8;font-size:12px;text-align:center;padding:12px}
.banner{position:absolute;left:8px;right:8px;top:6px;display:flex;justify-content:space-between;align-items:center;gap:8px;background:rgba(15,21,53,.92);border:1px solid #b45309;border-radius:4px;padding:4px 8px;color:#fbbf24;font-size:11px}
.retry-btn{background:#4fc3f7;color:#0a0e27;border:none;border-radius:4px;padding:6px 16px;font-size:12px;cursor:pointer}
.retry-btn:hover:not(:disabled){background:#29b6f6}
.retry-btn:disabled{opacity:.6;cursor:default}
.retry-btn.sm{padding:2px 10px;font-size:11px;flex:none}
</style>
