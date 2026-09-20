import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import axios from 'axios';
export const useTradingStore = defineStore('trading', () => {
    const loading = ref(false);
    const ticks = ref([]);
    const orderBook = ref(null);
    const gridResult = ref(null);
    const wsStatus = ref('connecting');
    const wsConnected = computed(() => wsStatus.value === 'open');
    const lastError = ref('');
    const config = ref({ lowerPrice: 95, upperPrice: 115, gridCount: 20, capitalPerGrid: 1000, initialCapital: 100000 });
    let ws = null;
    function applySnapshot(snap) {
        // One authoritative sequence: the panel, axis and legend all derive from it.
        if (Array.isArray(snap.ticks))
            ticks.value = snap.ticks.slice(-60);
        if (snap.orderBook)
            orderBook.value = snap.orderBook;
    }
    // Pull the same sequence over REST. Used for first paint and for the
    // "retry" action while the socket is down.
    async function fetchSnapshot() {
        const { data } = await axios.get('/api/ticks');
        applySnapshot(data);
    }
    function connectWS() {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))
            return;
        // Starting a new segment: drop the previous one so nothing stale lingers.
        wsStatus.value = 'connecting';
        lastError.value = '';
        ticks.value = [];
        orderBook.value = null;
        const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
        ws = socket;
        socket.onopen = async () => {
            if (ws !== socket)
                return;
            wsStatus.value = 'open';
            lastError.value = '';
            // Cover the case where the socket opened before the backend pushed
            // anything: prime the panel from the same sequence via REST.
            try {
                await fetchSnapshot();
            }
            catch { /* WS snapshot will follow */ }
        };
        socket.onmessage = (e) => {
            if (ws !== socket)
                return;
            try {
                const d = JSON.parse(e.data);
                applySnapshot(d);
            }
            catch (err) {
                lastError.value = '行情数据解析失败';
            }
        };
        socket.onerror = () => {
            if (ws !== socket)
                return;
            lastError.value = '行情连接异常';
        };
        socket.onclose = () => {
            if (ws !== socket)
                return;
            ws = null;
            wsStatus.value = 'closed';
            if (!lastError.value)
                lastError.value = '行情连接已中断';
        };
    }
    function reconnectWS() {
        if (ws) {
            try {
                ws.close();
            }
            catch { }
            ws = null;
        }
        connectWS();
    }
    async function retry() {
        // Explicit retry from the panel: reset, reconnect, and re-fetch the
        // current sequence from the same source.
        reconnectWS();
        try {
            await fetchSnapshot();
        }
        catch {
            lastError.value = '暂时无法获取行情，请稍后重试';
        }
    }
    async function runBacktest() {
        loading.value = true;
        try {
            const { data } = await axios.post('/api/backtest', config.value);
            gridResult.value = data;
        }
        finally {
            loading.value = false;
        }
    }
    function disconnectWS() {
        const s = ws;
        ws = null;
        if (s) {
            try {
                s.close();
            }
            catch { }
        }
        wsStatus.value = 'closed';
    }
    return {
        loading, ticks, orderBook, gridResult, wsStatus, wsConnected, lastError,
        config, connectWS, reconnectWS, retry, fetchSnapshot, runBacktest, disconnectWS
    };
});
