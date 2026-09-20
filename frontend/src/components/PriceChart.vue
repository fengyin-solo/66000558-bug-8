<template>
  <div class="panel" style="margin-top:12px">
    <h4>📈 实时价格 + K线</h4>
    <div class="chart-wrap">
      <div ref="chart" class="chart"></div>
      <div v-if="notice" class="overlay">
        <div class="notice-title">{{ notice.title }}</div>
        <div class="notice-desc">{{ notice.desc }}</div>
        <button class="retry-btn" @click="retry">重试连接</button>
      </div>
    </div>
  </div>
</template>
<script setup lang="ts">
import { ref, computed, watch, onMounted, onActivated, onUnmounted } from 'vue'
import * as echarts from 'echarts'
import { useTradingStore } from '../store/trading'

const store = useTradingStore()
const chart = ref<HTMLDivElement>()
let inst: echarts.ECharts | null = null

// 正常推 tick 间隔约 0.5s，间隔超过该值视为时间跳空（如断线重连），曲线在此断开
const GAP_SECONDS = 2
const MIN_POINTS = 2

// 后端时间为 HH:mm:ss，解析为当日秒数，作为时间轴的真实坐标
function toSeconds(t: string): number {
  const [h, m, s] = t.split(':').map(Number)
  return h * 3600 + m * 60 + s
}
function pad2(n: number) { return n < 10 ? '0' + n : '' + n }
function fmtTime(v: number): string {
  const h = Math.floor(v / 3600), m = Math.floor(v % 3600 / 60), s = Math.floor(v % 60)
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`
}

// 面板状态：无数据 / 连接中断 / 数据不足时给出明确原因与重试入口
const notice = computed(() => {
  if (store.connState === 'closed')
    return { title: '连接中断', desc: '与行情服务器的连接已断开，曲线已暂停更新，点击重试重新取数。' }
  if (store.connState === 'connecting' || store.connState === 'idle')
    return { title: '正在连接行情…', desc: '还没有收到任何行情数据，请稍候，也可点击重试。' }
  if (store.ticks.length === 0)
    return { title: '暂无行情数据', desc: '已连接行情服务器，但还没有收到任何行情，请稍候或重试。' }
  if (store.ticks.length < MIN_POINTS)
    return { title: '行情数据不足', desc: `当前只有 ${store.ticks.length} 个数据点，至少需要 ${MIN_POINTS} 个点才能绘制曲线。` }
  return null
})

function retry() { store.retryWS() }

// 始终基于同一份 store.ticks 序列重算；相邻 tick 时间间隔异常时插入空点，使跳空不被连线
function buildPoints(): any[] {
  const pts: any[] = []
  let prevTs: number | null = null
  for (const t of store.ticks) {
    const ts = toSeconds(t.time)
    if (prevTs !== null && ts - prevTs > GAP_SECONDS && ts >= prevTs)
      pts.push([prevTs + (ts - prevTs) / 2, null])
    pts.push([ts, t.price])
    prevTs = ts
  }
  return pts
}

function render() {
  if (!inst) return
  // 异常状态下清空画布，不保留/延伸任何旧曲线
  if (notice.value) { inst.clear(); return }

  const pts = buildPoints()
  const tsValues = pts.map(p => p[0])
  const firstTs = Math.min(...tsValues)
  const lastTs = Math.max(...tsValues)
  const last = store.ticks[store.ticks.length - 1]

  inst.setOption({
    backgroundColor: 'transparent',
    grid: { left: 50, right: 15, top: 28, bottom: 25 },
    legend: {
      top: 0, right: 10,
      data: [`最新价 ${last.price}　${last.time}`],
      textStyle: { color: '#4fc3f7', fontSize: 11 }
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#0f1535', borderColor: '#1e2a5a',
      textStyle: { color: '#e0e0e0', fontSize: 11 },
      formatter: (params: any) => {
        const p = Array.isArray(params) ? params[0] : params
        return `${fmtTime(p.value[0])}<br/>价格 ${p.value[1] ?? '--'}`
      }
    },
    // 数值时间轴：刻度按真实时间分布，最后一条行情与轴末端对齐
    xAxis: {
      type: 'value',
      min: firstTs - 0.5, max: lastTs + 0.5,
      axisLabel: { color: '#94a3b8', fontSize: 9, formatter: (v: number) => fmtTime(v) }
    },
    yAxis: { type: 'value', axisLabel: { color: '#94a3b8' } },
    series: [
      {
        name: `最新价 ${last.price}　${last.time}`,
        type: 'line', data: pts, symbol: 'none', connectNulls: false,
        lineStyle: { color: '#4fc3f7', width: 1.5 },
        areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(79,195,247,0.3)' }, { offset: 1, color: 'rgba(79,195,247,0)' }]) }
      }
    ],
    animation: false
  }, true) // notMerge：坐标、图例、取值整组替换，不残留上一段曲线
}

onMounted(() => { if (chart.value) { inst = echarts.init(chart.value); render() } })
onActivated(() => { inst?.resize(); render() })
watch([() => store.ticks, () => store.connState], render, { deep: true })
onUnmounted(() => { inst?.dispose(); inst = null })
</script>
<style scoped>
.panel{background:#0f1535;border-radius:8px;padding:12px;border:1px solid #1e2a5a}
.panel h4{color:#4fc3f7;font-size:13px;margin-bottom:4px}
.chart-wrap{position:relative}
.chart{width:100%;height:300px}
.overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;background:rgba(10,14,39,0.85);border-radius:4px}
.notice-title{color:#f8fafc;font-size:13px;font-weight:600}
.notice-desc{color:#94a3b8;font-size:11px;text-align:center;max-width:280px;line-height:1.6}
.retry-btn{margin-top:4px;padding:5px 16px;font-size:12px;color:#4fc3f7;background:transparent;border:1px solid #4fc3f7;border-radius:4px;cursor:pointer}
.retry-btn:hover{background:rgba(79,195,247,0.12)}
</style>
