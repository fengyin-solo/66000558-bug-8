/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { ref, computed, watch, onMounted, onActivated, onUnmounted } from 'vue';
import * as echarts from 'echarts';
import { useTradingStore } from '../store/trading';
const store = useTradingStore();
const chartEl = ref();
let inst = null;
const retrying = ref(false);
const MIN_POINTS = 2; // 少于两笔无法成线
const GAP_FACTOR = 3; // 相邻间隔超过中位间隔的 3 倍视为时间跳空
const GAP_MIN_MS = 1500; // 且至少 1.5s，避免正常抖动被误判
const PRICE_GAP_PCT = 0.05; // 相邻价格跳动超过 5% 视为价格跳空
// HH:mm:ss 时间戳：优先用后端毫秒时间戳，兼容只有 time 字符串的旧数据
function tickTs(t) {
    if (typeof t.ts === 'number' && Number.isFinite(t.ts))
        return t.ts;
    const parts = t.time.split(':').map(Number);
    const d = new Date();
    d.setHours(parts[0] || 0, parts[1] || 0, parts[2] || 0, 0);
    return d.getTime();
}
function fmtTime(ts) {
    const d = new Date(ts);
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
}
function median(values) {
    if (!values.length)
        return 0;
    const s = [...values].sort((a, b) => a - b);
    return s[s.length >> 1];
}
// 坐标轴、曲线、图例、最新价全部由这同一份序列派生
const derived = computed(() => {
    const pts = store.ticks.map(t => [tickTs(t), t.price]);
    pts.sort((a, b) => a[0] - b[0]);
    const interval = median(pts.slice(1).map((p, i) => p[0] - pts[i][0]).filter(d => d > 0));
    const gapMs = Math.max(interval * GAP_FACTOR, GAP_MIN_MS);
    if (pts.length > 1) {
        const withBreaks = [pts[0]];
        let prevPrice = pts[0][1];
        for (let i = 1; i < pts.length; i++) {
            const [t, p] = pts[i];
            const timeGap = interval > 0 && t - pts[i - 1][0] > gapMs;
            const priceGap = p != null && prevPrice != null && Math.abs(p - prevPrice) / Math.max(Math.abs(prevPrice), 1e-9) >= PRICE_GAP_PCT;
            if (timeGap || priceGap)
                withBreaks.push([t, null]); // 跳空：留断点而不是连成直线
            withBreaks.push([t, p]);
            prevPrice = p;
        }
        pts.splice(0, pts.length, ...withBreaks);
    }
    const valid = pts.filter((p) => p[1] != null);
    const last = valid.length ? valid[valid.length - 1] : null;
    return {
        points: pts,
        lastPrice: last ? last[1] : NaN,
        lastTime: last ? fmtTime(last[0]) : '--:--:--',
        interval
    };
});
const validCount = computed(() => store.ticks.length);
const overlay = computed(() => {
    const n = store.ticks.length;
    if (n === 0) {
        if (store.wsStatus === 'closed')
            return { text: `✕ ${store.lastError || '行情连接已中断'}，尚未收到任何行情数据`, canRetry: true };
        if (store.wsStatus === 'connecting')
            return { text: '正在连接行情服务，尚未收到行情数据…', canRetry: false };
        return { text: '已连接，等待第一笔行情数据…', canRetry: false };
    }
    if (n < MIN_POINTS) {
        if (store.wsStatus === 'closed')
            return { text: `✕ ${store.lastError || '行情连接已中断'}：仅有 ${n} 笔行情（至少 ${MIN_POINTS} 笔才能成线）`, canRetry: true };
        return { text: `行情数据不足：仅 ${n} 笔（至少需要 ${MIN_POINTS} 笔），等待更多成交…`, canRetry: false };
    }
    return null;
});
function buildOption(d) {
    const valid = d.points.filter((p) => p[1] != null);
    const ready = valid.length >= MIN_POINTS;
    const firstTs = ready ? valid[0][0] : undefined;
    const lastTs = ready ? valid[valid.length - 1][0] : undefined;
    // 坐标轴末端锚定最近一笔行情，只留一个 tick 的余量，刻度与最新行情对齐
    const maxTs = ready && lastTs != null ? (d.interval > 0 ? lastTs + d.interval : lastTs) : undefined;
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
                connectNulls: false, // 跳空断口，绝不补线
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
    };
}
function render() {
    if (!inst)
        return;
    // notMerge：坐标轴与整条序列整体替换，重连后不残留上一段曲线
    inst.setOption(buildOption(derived.value), true);
}
async function retry() {
    if (retrying.value)
        return;
    retrying.value = true;
    try {
        await store.retry();
    }
    finally {
        window.setTimeout(() => { retrying.value = false; }, 400);
    }
}
function resize() { inst?.resize(); }
// 从其他页面 / 后台标签页返回：重新取数、重连并按最新序列重绘
function onVisible() {
    if (document.visibilityState !== 'visible')
        return;
    inst?.resize();
    if (store.wsStatus === 'closed')
        store.reconnectWS();
    store.fetchSnapshot().catch(() => { });
    render();
}
onMounted(() => {
    if (chartEl.value) {
        inst = echarts.init(chartEl.value);
        render();
    }
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', onVisible);
    if (store.wsStatus === 'closed')
        store.reconnectWS();
    if (!store.ticks.length)
        store.fetchSnapshot().catch(() => { });
});
onActivated(() => {
    inst?.resize();
    if (store.wsStatus === 'closed')
        store.reconnectWS();
    store.fetchSnapshot().catch(() => { });
    render();
});
watch(derived, render);
watch(() => store.wsStatus, render);
onUnmounted(() => {
    window.removeEventListener('resize', resize);
    document.removeEventListener('visibilitychange', onVisible);
    inst?.dispose();
    inst = null;
});
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['panel']} */ ;
/** @type {__VLS_StyleScopedClasses['legend']} */ ;
/** @type {__VLS_StyleScopedClasses['legend']} */ ;
/** @type {__VLS_StyleScopedClasses['legend']} */ ;
/** @type {__VLS_StyleScopedClasses['chart-wrap']} */ ;
/** @type {__VLS_StyleScopedClasses['chart']} */ ;
/** @type {__VLS_StyleScopedClasses['retry-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['retry-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['retry-btn']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "panel" },
    ...{ style: {} },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "panel-head" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h4, __VLS_intrinsicElements.h4)({});
if (__VLS_ctx.validCount >= __VLS_ctx.MIN_POINTS) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "legend" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "swatch" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "latest" },
    });
    (__VLS_ctx.derived.lastPrice.toFixed(2));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "latest-time" },
    });
    (__VLS_ctx.derived.lastTime);
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "chart-wrap" },
    ...{ class: ({ frozen: __VLS_ctx.store.wsStatus === 'closed' && __VLS_ctx.validCount >= __VLS_ctx.MIN_POINTS }) },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ref: "chartEl",
    ...{ class: "chart" },
});
/** @type {typeof __VLS_ctx.chartEl} */ ;
if (__VLS_ctx.overlay) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "overlay" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({});
    (__VLS_ctx.overlay.text);
    if (__VLS_ctx.overlay.canRetry) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (__VLS_ctx.retry) },
            ...{ class: "retry-btn" },
            disabled: (__VLS_ctx.retrying),
        });
        (__VLS_ctx.retrying ? '重试中…' : '↻ 重试');
    }
}
else if (__VLS_ctx.store.wsStatus === 'closed') {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "banner" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
    (__VLS_ctx.store.lastError || '行情连接已中断');
    (__VLS_ctx.derived.lastTime);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.retry) },
        ...{ class: "retry-btn sm" },
        disabled: (__VLS_ctx.retrying),
    });
    (__VLS_ctx.retrying ? '重试中…' : '↻ 重试');
}
/** @type {__VLS_StyleScopedClasses['panel']} */ ;
/** @type {__VLS_StyleScopedClasses['panel-head']} */ ;
/** @type {__VLS_StyleScopedClasses['legend']} */ ;
/** @type {__VLS_StyleScopedClasses['swatch']} */ ;
/** @type {__VLS_StyleScopedClasses['latest']} */ ;
/** @type {__VLS_StyleScopedClasses['latest-time']} */ ;
/** @type {__VLS_StyleScopedClasses['chart-wrap']} */ ;
/** @type {__VLS_StyleScopedClasses['chart']} */ ;
/** @type {__VLS_StyleScopedClasses['overlay']} */ ;
/** @type {__VLS_StyleScopedClasses['retry-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['banner']} */ ;
/** @type {__VLS_StyleScopedClasses['retry-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['sm']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            store: store,
            chartEl: chartEl,
            retrying: retrying,
            MIN_POINTS: MIN_POINTS,
            derived: derived,
            validCount: validCount,
            overlay: overlay,
            retry: retry,
        };
    },
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
});
; /* PartiallyEnd: #4569/main.vue */
