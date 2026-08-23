// 用量与费用统计：内存状态 + 本地持久化（app/data/usage.json）
// 每次识别结束时记录一次：时长(秒)、费用(元)、文本、设备ID。
// 按日聚合保存在 daily 中，跨天/重启不丢失，供概览热力图与费用面板使用。
//
// 本模块收敛「用量 / 费用 / 预算」领域逻辑：单价计算、统计快照、CSV 导出、
// 月度预算自动降级。为避免反向依赖 server.js，广播等副作用通过 init() 注入回调。
const fs = require('fs')
const path = require('path')
const { log } = require('./logger')
const { config, saveSettings } = require('./config')
const paths = require('./paths')

const DATA_DIR = paths.dataDir
const USAGE_FILE = path.join(DATA_DIR, 'usage.json')
const HISTORY_MAX = 100      // 最近识别明细最多保留条数
const DAILY_MAX_DAYS = 400   // 按日聚合最多保留天数

const ZERO = { sessions: 0, seconds: 0, costYuan: 0 }

const state = {
  daily: {},          // 'YYYY-MM-DD' -> { costYuan, seconds, sessions }
  total: { ...ZERO },
  last: null,         // { at, seconds, costYuan, text, price, deviceId }
  history: [],        // 每次识别明细，最多 HISTORY_MAX 条
}

// 预算超限自动降级标记（模块内状态，服务重启时用 config.json 里的 provider 恢复）
let budgetAutoDowngraded = false
// 广播回调：由 server.js 注入，用于月度预算超限时向所有在线手机推 toast
let broadcastToPhones = () => {}

// ---- 日期工具 ----
function pad(n, w = 2) { return String(n).padStart(w, '0') }
function dayKey(d) {
  const dt = d instanceof Date ? d : new Date(d)
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`
}
function inMonth(dateStr, key) { return key.slice(0, 7) === dateStr.slice(0, 7) }

// ---- 持久化 ----
function load() {
  try {
    if (!fs.existsSync(USAGE_FILE)) return
    const data = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'))
    if (data.daily && typeof data.daily === 'object') state.daily = data.daily
    if (data.total && typeof data.total === 'object') state.total = { ...ZERO, ...data.total }
    if (data.last) state.last = data.last
    if (Array.isArray(data.history)) state.history = data.history.slice(-HISTORY_MAX)
    migrateBilling()
    log('usage', `已加载用量统计：累计 ${state.total.sessions} 次 / ¥${state.total.costYuan.toFixed(5)}`)
  } catch (error) {
    log('usage', `usage.json 解析失败，使用空统计: ${error.message}`)
  }
}

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(USAGE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 })
  } catch (error) {
    log('usage', `写入 usage.json 失败: ${error.message}`)
  }
}

function pruneDaily() {
  const keys = Object.keys(state.daily).sort()
  while (keys.length > DAILY_MAX_DAYS) {
    delete state.daily[keys.shift()]
  }
}

// 计费时长：按音频时长向上取整到整数秒，且最小为 1 秒（不足 1 秒按 1 秒计费）。
// 仅用于费用计算；真实时长 seconds 仍按原样记录/展示。
function billableSecondsOf(seconds) {
  const s = Number(seconds)
  if (!(s > 0)) return 0
  return Math.max(1, Math.ceil(s))
}

// ---- 记录一次识别 ----
// opts: { seconds, text, pricePerSecond, deviceId }
function recordUsage(opts) {
  const seconds = Number(opts.seconds) || 0
  const pricePerSecond = Number(opts.pricePerSecond) || 0
  const billableSeconds = billableSecondsOf(seconds)
  const costYuan = billableSeconds * pricePerSecond
  const text = opts.text || ''
  const key = dayKey(new Date())
  const day = state.daily[key] || (state.daily[key] = { ...ZERO })

  state.total.sessions += 1
  state.total.seconds += seconds
  state.total.costYuan += costYuan
  day.sessions += 1
  day.seconds += seconds
  day.costYuan += costYuan

  const record = {
    at: Date.now(),
    seconds,
    billableSeconds,
    costYuan,
    text,
    price: pricePerSecond,
    deviceId: opts.deviceId || null,
  }
  state.last = record
  state.history.push(record)
  if (state.history.length > HISTORY_MAX) state.history.shift()

  pruneDaily()
  persist()
  return record
}

// 一次性迁移：把历史上按「精确秒」计费的记录改为「向上取整到秒、最小 1 秒」计费。
// 仅能精确重算 history 内保留的明细；daily/total 对每条记录的旧费用做差值校正，
// 使最近记录与面板展示保持一致（更早且已被裁剪的无法还原，保持原样）。
function migrateBilling() {
  let totalDelta = 0
  const dailyDelta = {}
  let any = false
  for (const rec of state.history) {
    const seconds = Number(rec.seconds) || 0
    const price = Number(rec.price) || 0
    const billable = billableSecondsOf(seconds)
    const newCost = billable * price
    const oldCost = Number(rec.costYuan) || 0
    const delta = newCost - oldCost
    if (Math.abs(delta) > 1e-9) {
      rec.billableSeconds = billable
      rec.costYuan = newCost
      totalDelta += delta
      const k = dayKey(new Date(rec.at))
      dailyDelta[k] = (dailyDelta[k] || 0) + delta
      any = true
    } else if (rec.billableSeconds == null) {
      rec.billableSeconds = billable
      any = true
    }
  }
  if (any) {
    state.total.costYuan += totalDelta
    for (const [k, d] of Object.entries(dailyDelta)) {
      const day = state.daily[k]
      if (day) day.costYuan = (Number(day.costYuan) || 0) + d
    }
    if (state.last && state.history.length) {
      const lastRec = state.history[state.history.length - 1]
      if (state.last.at === lastRec.at) state.last = lastRec
    }
    persist()
    log('usage', `已修正计费（不满 1 秒按 1 秒）：校对 ${state.history.length} 条明细`)
  }
}

// 供 server.js 在 final 回调后回填真实文本
function patchLastText(text) {
  if (!state.last) return state.last
  state.last.text = text || state.last.text
  const last = state.history[state.history.length - 1]
  if (last && last.at === state.last.at) last.text = state.last.text
  persist()
  return state.last
}

function monthAggregate(nowKey) {
  const agg = { ...ZERO }
  for (const [key, v] of Object.entries(state.daily)) {
    if (inMonth(nowKey, key)) {
      agg.sessions += v.sessions
      agg.seconds += v.seconds
      agg.costYuan += v.costYuan
    }
  }
  return agg
}

// ---- 对外快照：供 /api/stats 使用 ----
function getSnapshot() {
  const now = new Date()
  const todayKey = dayKey(now)
  const today = state.daily[todayKey] || { ...ZERO }
  const month = monthAggregate(todayKey)

  // 最近 12 个月的按日数组（含 0 值），用于热力图
  const daily = []
  const start = new Date(now)
  start.setDate(start.getDate() - 365)
  const cursor = new Date(start)
  while (cursor <= now) {
    const k = dayKey(cursor)
    const v = state.daily[k]
    daily.push(v
      ? { date: k, costYuan: v.costYuan, seconds: v.seconds, sessions: v.sessions }
      : { date: k, costYuan: 0, seconds: 0, sessions: 0 })
    cursor.setDate(cursor.getDate() + 1)
  }

  return {
    total: { ...state.total },
    today: { ...today },
    month: { ...month },
    last: state.last,
    history: state.history.slice(-HISTORY_MAX),
    daily,
  }
}

// ---- 单价 / 统计 / 预算 / 导出（自 server.js 收敛而来，降低 server.js 耦合） ----

// bailian 按音频时长计费：duration(秒) = audioBytes / 2 / 16000
function getAsrPricePerSecond() {
  if (config.asr.provider !== 'bailian') return 0
  const price = Number(config.asr.bailian.pricePerSecond)
  return Number.isFinite(price) && price > 0 ? price : 0.00033
}

// 组装控制面板 /api/stats 响应
function getUsageStats() {
  const snap = getSnapshot()
  return {
    provider: config.asr.provider,
    pricePerSecond: getAsrPricePerSecond(),
    total: snap.total,
    today: snap.today,
    month: snap.month,
    last: snap.last,
    history: snap.history,
    daily: snap.daily,
    autoDowngraded: budgetAutoDowngraded,
  }
}

// 月度费用超限自动降级：当月费用达到预算上限时，把 bailian(在线) 自动切为 sherpa(离线)，
// 避免继续产生费用；不中断当前会话，下次识别即生效。一个月内只触发一次（标记位），
// 用户手动切回在线后也不会被立刻拉回，直到月度重置（费用回落）或主动提高预算。
function checkBudgetAndMaybeDowngrade() {
  if (config.asr.provider !== 'bailian') return
  const limit = Number(config.budget && config.budget.monthlyYuan) || 0
  if (limit <= 0) { budgetAutoDowngraded = false; return }
  const snap = getSnapshot()
  const monthCost = Number(snap.month.costYuan) || 0
  if (monthCost >= limit) {
    if (!budgetAutoDowngraded) {
      budgetAutoDowngraded = true
      config.asr.provider = 'sherpa'
      try {
        saveSettings({ asr: { provider: 'sherpa' } })
        log('usage', `本月费用 ¥${monthCost.toFixed(2)} 已达预算 ¥${limit.toFixed(2)}，自动切换为离线识别(sherpa)`)
        broadcastToPhones(JSON.stringify({ type: 'toast', text: '本月费用已达预算，已自动切换为离线识别', target: 'enter' }))
      } catch (error) {
        log('usage', '自动降级失败（保留在线）:', error.message)
        config.asr.provider = 'bailian'
        budgetAutoDowngraded = false
      }
    }
  } else {
    // 月度费用回到预算内（通常为跨月），允许后续再次进行自动降级保护
    budgetAutoDowngraded = false
  }
}

// 手动保存配置视为一次“重新决策”，清除自动降级标记；返回是否曾处于降级状态。
function resetAutoDowngraded() {
  const was = budgetAutoDowngraded
  budgetAutoDowngraded = false
  return was
}

// CSV 导出：type=history 导出识别明细，type=daily 导出按日聚合。
function csvEscape(v) {
  const s = String(v == null ? '' : v)
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

function usageExportCsv(type) {
  const snap = getSnapshot()
  if (type === 'daily') {
    const rows = [['日期', '次数', '时长(秒)', '费用(元)']]
    for (const d of snap.daily) {
      if (!d.sessions && !d.seconds && !d.costYuan) continue
      rows.push([d.date, d.sessions, d.seconds, d.costYuan.toFixed(6)])
    }
    return '\ufeff' + rows.map((r) => r.map(csvEscape).join(',')).join('\n')
  }
  // 默认 history
  const rows = [['时间', '识别文本', '时长(秒)', '费用(元)', '单价(元/秒)', '设备']]
  for (const h of snap.history) {
    const when = new Date(h.at)
    const time = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`
    rows.push([time, h.text || '', h.seconds, h.costYuan.toFixed(6), h.price ?? '', h.deviceId || ''])
  }
  return '\ufeff' + rows.map((r) => r.map(csvEscape).join(',')).join('\n')
}

// ---- 初始化：注册广播回调并恢复统计 ----
function init(opts = {}) {
  if (typeof opts.broadcastToPhones === 'function') broadcastToPhones = opts.broadcastToPhones
  load()
}

module.exports = {
  init,
  billableSecondsOf,
  recordUsage,
  patchLastText,
  getSnapshot,
  getAsrPricePerSecond,
  getUsageStats,
  checkBudgetAndMaybeDowngrade,
  resetAutoDowngraded,
  usageExportCsv,
}
