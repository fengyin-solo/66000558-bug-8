import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import axios from 'axios'
import type { Tick, OrderBook, GridConfig, GridResult } from '@/types'

export type ConnState = 'idle' | 'connecting' | 'connected' | 'closed'

export const useTradingStore = defineStore('trading', () => {
  const loading = ref(false)
  const ticks = ref<Tick[]>([])
  const orderBook = ref<OrderBook | null>(null)
  const gridResult = ref<GridResult | null>(null)
  const connState = ref<ConnState>('idle')
  const config = ref<GridConfig>({ lowerPrice: 95, upperPrice: 115, gridCount: 20, capitalPerGrid: 1000, initialCapital: 100000 })

  const wsConnected = computed(() => connState.value === 'connected')

  let ws: WebSocket | null = null
  let socketSeq = 0

  function connectWS() {
    // 重连前先丢弃旧连接与上一段行情，保证重连后不残留旧曲线
    if (ws) { try { ws.close() } catch {} ; ws = null }
    socketSeq += 1
    const seq = socketSeq
    ticks.value = []
    orderBook.value = null
    connState.value = 'connecting'

    const socket = new WebSocket(`ws://${location.hostname}:8000/ws`)
    ws = socket
    socket.onopen = () => { if (seq === socketSeq) connState.value = 'connected' }
    socket.onmessage = (e) => {
      if (seq !== socketSeq) return
      try {
        const d = JSON.parse(e.data)
        if (Array.isArray(d.ticks)) ticks.value = d.ticks.slice(-60)
        if (d.orderBook) orderBook.value = d.orderBook
      } catch {}
    }
    socket.onclose = () => {
      if (seq !== socketSeq) return
      connState.value = 'closed'
      orderBook.value = null
    }
    socket.onerror = () => { if (seq === socketSeq) connState.value = 'closed' }
  }

  function retryWS() { connectWS() }

  async function runBacktest() {
    loading.value = true
    try { const { data } = await axios.post('/api/backtest', config.value) ; gridResult.value = data }
    finally { loading.value = false }
  }

  function disconnectWS() {
    socketSeq += 1
    if (ws) { try { ws.close() } catch {} ; ws = null }
    connState.value = 'idle'
    ticks.value = []
    orderBook.value = null
  }

  return { loading, ticks, orderBook, gridResult, connState, wsConnected, config, connectWS, retryWS, runBacktest, disconnectWS }
})
