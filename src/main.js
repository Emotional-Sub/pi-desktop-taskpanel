"use strict";

/**
 * 任务清单面板 —— 在插件自己的面板窗口里实时显示各会话的任务清单。
 *
 * v0.4 变化（关键修复）：
 *   - 卡片标题与运行状态改为**直接只读查 pi.sqlite**（node:sqlite，readOnly）：
 *       · sessions 表拿会话「真实标题」（你给对话起的名字），改名后下次轮询自动跟上；
 *       · 每会话「最新一条 turn」的 status 判断 运行中 / 已结束（完成·中止·出错）。
 *     之前用的 pi.session.get 的 "own" 范围只覆盖插件自己 import 的会话，读不到用户的
 *     真实对话，所以标题一直取不到、回退成模型清单名 —— 这版彻底改掉。
 *   - 主动发现：正在运行(running)但还没调过 task_update 的会话，也会显示一张
 *     「暂无清单」卡片，不再需要每个会话都先推一次才可见。
 *   - 只读 sessions.title 与 turns.status/时间戳，**绝不读任何消息正文**；只读打开、绝不写库。
 *
 * v0.3/v0.2：按会话分卡片、手风琴折叠、覆盖式更新。
 *
 * 数据来源：
 *   pi.sqlite（真实标题 + 运行状态，只读）  +  本插件数据目录的 state.json（模型推的清单）。
 *   面板轮询 task.pull 时，两者按 sessionId 合并后渲染。
 *
 * 权限：ui.panel、agent.tool.register。用 Node fs/sqlite 读本机文件，不联网、不用剪贴板、不用 shell。
 *   清单文本只来自模型的工具调用；标题/状态只来自本机 pi.sqlite（不外发）。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PLUGIN_ID = readPluginId();
const PLUGIN_VERSION = "0.5.1";
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_TASKS = 200;
const MAX_SESSIONS = 12; // 面板最多同时保留的会话卡片数
const SESSION_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 超过 3 天没更新的清单会话自动清掉
const HOST_CACHE_MS = 1000; // pi.sqlite 读取缓存窗口，避免每次 700ms 轮询都开库
const RUNNING_DETECT_MS = 30 * 60 * 1000; // 无清单的 running 会话：最近这段时间内才显示（滤掉卡死的旧 turn）
const TEXT_MAX = 400;
const NOTE_MAX = 400;
const TITLE_MAX = 120;
const STATUSES = new Set(["todo", "doing", "done", "blocked"]);

// 特殊会话键：迁移来的旧清单、示例、无 sessionId 兜底（都没有对应的真实会话）
const LEGACY_KEY = "_legacy";
const SAMPLE_KEY = "_sample";
const DEFAULT_KEY = "_default";

let uiLocale = "zh-CN";
let hostCache = { at: 0, map: null }; // pi.sqlite 读取结果的内存缓存

function readPluginId() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8");
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    if (parsed && typeof parsed.id === "string" && parsed.id) return parsed.id;
  } catch {
    /* 读不到就用默认 id */
  }
  return "local.taskpanel";
}

function pick(zh, en) {
  return String(uiLocale || "").toLowerCase().startsWith("zh") ? zh : en;
}

/* ------------------------------------------------------------------ *
 * 存储（只写本插件自己的数据目录）
 * ------------------------------------------------------------------ */

function dataDir() {
  return path.join(os.homedir(), ".pi-desktop", "plugins", "data", PLUGIN_ID);
}

function statePath() {
  return path.join(dataDir(), "state.json");
}

// pi.sqlite 在用户目录下：~/.pi-desktop/pi.sqlite（与 dataDir 同源，dataDir 已验证可用）
function hostDbPath() {
  return path.join(os.homedir(), ".pi-desktop", "pi.sqlite");
}

function writeJson(file, value) {
  try {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(value), "utf8");
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

function readJson(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_JSON_BYTES) return null;
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    return null;
  }
}

function emptyState() {
  // dismissed：被用户删掉的会话 { key: 删除时间 }；clearedAt：「清空全部」的时间。
  // 删除后在没有新动静（新推送 / 新一轮 turn）之前保持隐藏，避免被「主动发现」立刻拉回来。
  return { schema: 2, seq: 0, sessions: {}, dismissed: {}, clearedAt: 0 };
}

function normalizeDismissed(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const k of Object.keys(raw)) {
    if (Number.isFinite(raw[k])) out[k] = raw[k];
  }
  return out;
}

/**
 * 读状态。识别 v2（按会话存），并把 v0.1 的单份全局清单迁移成一个「遗留」会话，
 * 这样升级后面板不会立刻空掉；等真实会话下次推送就会替换掉它。
 */
function loadState() {
  const raw = readJson(statePath());
  if (!raw || typeof raw !== "object") return emptyState();

  if (raw.schema === 2 && raw.sessions && typeof raw.sessions === "object") {
    return {
      schema: 2,
      seq: Number.isFinite(raw.seq) ? raw.seq : 0,
      sessions: raw.sessions,
      dismissed: normalizeDismissed(raw.dismissed),
      clearedAt: Number.isFinite(raw.clearedAt) ? raw.clearedAt : 0,
    };
  }

  // v0.1 迁移
  if (Array.isArray(raw.tasks)) {
    const tasks = normalizeTasks(raw.tasks);
    const seq = Number.isFinite(raw.seq) ? raw.seq : 1;
    const at = Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now();
    const state = emptyState();
    state.seq = seq;
    state.sessions[LEGACY_KEY] = {
      id: LEGACY_KEY,
      sessionId: null,
      seq,
      title: (typeof raw.title === "string" && raw.title) || pick("升级前的清单", "Pre-upgrade list"),
      tasks,
      summary: summarize(tasks),
      createdAt: at,
      updatedAt: at,
      updates: 1,
      running: false,
      turnId: null,
      endedAt: null,
      endReason: null,
      legacy: true,
    };
    return state;
  }

  return emptyState();
}

// 清掉过期会话，按最近更新排序后只留 MAX_SESSIONS 个
function pruneSessions(state) {
  const now = Date.now();
  const kept = Object.values(state.sessions)
    .filter((s) => s && typeof s === "object" && now - (s.updatedAt || 0) <= SESSION_TTL_MS)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, MAX_SESSIONS);
  const sessions = {};
  for (const s of kept) sessions[s.id] = s;
  state.sessions = sessions;
  // 删除记录同样按 TTL 过期，避免无限增长
  const dismissed = {};
  const src = normalizeDismissed(state.dismissed);
  for (const k of Object.keys(src)) {
    if (now - src[k] <= SESSION_TTL_MS) dismissed[k] = src[k];
  }
  state.dismissed = dismissed;
  if (!Number.isFinite(state.clearedAt)) state.clearedAt = 0;
  return state;
}

function saveState(state) {
  pruneSessions(state);
  if (!writeJson(statePath(), state)) throw new Error("state write failed");
  return state;
}

function bumpSeq(state) {
  state.seq = (Number.isFinite(state.seq) ? state.seq : 0) + 1;
  return state.seq;
}

/* ------------------------------------------------------------------ *
 * 归一化
 * ------------------------------------------------------------------ */

function clampStr(value, max) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function normalizeTasks(input) {
  // 少数模型会把数组序列化成 JSON 字符串传进来，容错解析一次
  let arr = input;
  if (typeof arr === "string") {
    try {
      arr = JSON.parse(arr);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const raw of arr) {
    if (out.length >= MAX_TASKS) break;
    if (!raw || typeof raw !== "object") continue;
    const text = clampStr(raw.text, TEXT_MAX);
    if (!text) continue;
    let status = typeof raw.status === "string" ? raw.status.toLowerCase() : "todo";
    if (!STATUSES.has(status)) status = "todo";
    const note = clampStr(raw.note, NOTE_MAX);
    const task = { text, status };
    if (note) task.note = note;
    out.push(task);
  }
  return out;
}

function summarize(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const total = list.length;
  let done = 0;
  let doing = 0;
  let blocked = 0;
  for (const t of list) {
    if (t.status === "done") done += 1;
    else if (t.status === "doing") doing += 1;
    else if (t.status === "blocked") blocked += 1;
  }
  return { total, done, doing, blocked, todo: total - done - doing - blocked };
}

// 把 ctx.sessionId 清洗成存储键；缺失时用兜底键
function sessionKey(ctx) {
  const raw = ctx && typeof ctx.sessionId === "string" ? ctx.sessionId.trim() : "";
  if (!raw) return DEFAULT_KEY;
  const cleaned = raw.replace(/[^\w-]/g, "").slice(0, 64);
  return cleaned || DEFAULT_KEY;
}

// 拿到能查 sqlite 的原始 sessionId：优先存的 sessionId，其次是非特殊键本身
// （UUID 不含特殊字符，清洗后原样保留，所以键==sessionId）。
function rawIdOf(entry) {
  if (entry && typeof entry.sessionId === "string" && entry.sessionId) return entry.sessionId;
  if (entry && typeof entry.id === "string" && entry.id && entry.id[0] !== "_") return entry.id;
  return null;
}

/* ------------------------------------------------------------------ *
 * 真实会话名 + 运行状态（只读 pi.sqlite，node:sqlite）
 * ------------------------------------------------------------------ */

/**
 * 只读打开 pi.sqlite，返回 Map<sessionId, {title, status, startedAt, endedAt, updatedAt}>。
 * 拿不到（无 node:sqlite / 文件不存在 / 出错）返回 null，调用方降级用存储里的兜底状态。
 * 结果缓存 HOST_CACHE_MS，避免每次 700ms 轮询都开一次库。
 */
function readHostSessions() {
  const now = Date.now();
  if (hostCache.map && now - hostCache.at < HOST_CACHE_MS) return hostCache.map;

  let sqlite;
  try {
    sqlite = require("node:sqlite");
  } catch {
    hostCache = { at: now, map: null };
    return null;
  }
  if (!sqlite || !sqlite.DatabaseSync) {
    hostCache = { at: now, map: null };
    return null;
  }

  const dbFile = hostDbPath();
  let db = null;
  try {
    if (!fs.existsSync(dbFile)) {
      hostCache = { at: now, map: null };
      return null;
    }
    db = new sqlite.DatabaseSync(dbFile, { readOnly: true });
    // 每会话取「最新一条 turn」的状态；只读标题与状态，不碰消息正文。
    const rows =
      db
        .prepare(
          "select s.id as id, s.title as title, s.updated_at as updatedAt, " +
            "t.status as status, t.started_at as startedAt, t.ended_at as endedAt " +
            "from sessions s left join turns t on t.id = (" +
            "select id from turns where session_id = s.id order by started_at desc, id desc limit 1) " +
            "where s.deleted_at is null"
        )
        .all() || [];
    const map = new Map();
    for (const r of rows) {
      const id = r && typeof r.id === "string" ? r.id : String((r && r.id) || "");
      if (!id) continue;
      map.set(id, {
        title: typeof r.title === "string" ? r.title : "",
        status: typeof r.status === "string" ? r.status.toLowerCase() : "",
        startedAt: Number(r.startedAt) || 0,
        endedAt: Number(r.endedAt) || 0,
        updatedAt: Number(r.updatedAt) || 0,
      });
    }
    hostCache = { at: now, map };
    return map;
  } catch {
    hostCache = { at: now, map: null };
    return null;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }
}

// turn 状态 -> 运行/结束语义
function hostLiveness(status) {
  const s = String(status || "").toLowerCase();
  if (s === "running" || s === "queued" || s === "pending") return { running: true, endReason: null };
  if (s === "completed") return { running: false, endReason: "completed" };
  if (s === "aborted" || s === "canceled" || s === "cancelled") return { running: false, endReason: "aborted" };
  if (s === "error" || s === "failed") return { running: false, endReason: "error" };
  return { running: false, endReason: null };
}

/* ------------------------------------------------------------------ *
 * 写入 / 变更
 * ------------------------------------------------------------------ */

/**
 * 暂存某个会话的清单：归一化、按会话键写入、bump 全局 seq（让面板知道要重渲染）。
 * 传空数组 = 从面板移除本会话这一栏。
 * opts.running 缺省 true（仅作 sqlite 不可用时的兜底状态；正常运行状态以 sqlite 为准）。
 */
function stageTasks(args, ctx, opts) {
  const key = sessionKey(ctx);
  const rawId = ctx && typeof ctx.sessionId === "string" ? ctx.sessionId.trim() : "";
  const state = loadState();
  const prev = state.sessions[key];
  const tasks = normalizeTasks(args && args.tasks);
  const now = Date.now();

  // 空清单：移除本会话看板，并记录删除时间，避免运行中又被「主动发现」拉回来
  if (!tasks.length) {
    if (state.sessions[key]) delete state.sessions[key];
    state.dismissed = normalizeDismissed(state.dismissed);
    state.dismissed[key] = now;
    const seq = bumpSeq(state);
    saveState(state);
    return { key, entry: null, removed: true, seq, sessionCount: Object.keys(state.sessions).length };
  }

  const title =
    (args && clampStr(args.title, TITLE_MAX)) ||
    (prev && typeof prev.title === "string" ? prev.title : "") ||
    pick("任务清单", "Tasks");

  const seq = bumpSeq(state);
  const running = !opts || opts.running !== false;
  const entry = {
    id: key,
    sessionId: rawId || (prev && prev.sessionId) || null,
    seq,
    title, // 模型清单标题：仅作拿不到真实会话名时的兜底
    tasks,
    summary: summarize(tasks),
    createdAt: prev && Number.isFinite(prev.createdAt) ? prev.createdAt : now,
    updatedAt: now,
    updates: prev && Number.isFinite(prev.updates) ? prev.updates + 1 : 1,
    running, // sqlite 不可用时的兜底
    turnId: (ctx && typeof ctx.turnId === "string" && ctx.turnId) || null,
    endedAt: null,
    endReason: null,
  };
  state.sessions[key] = entry;
  // 主动推送 = 想显示：撤销之前的删除记录
  if (state.dismissed && state.dismissed[key]) delete state.dismissed[key];

  // 真实会话推送后，丢掉迁移来的遗留栏，避免重复显示
  if (key !== LEGACY_KEY && state.sessions[LEGACY_KEY]) delete state.sessions[LEGACY_KEY];

  saveState(state);
  return { key, entry, seq, sessionCount: Object.keys(state.sessions).length };
}

// 宿主广播 session:turnEnded 时，把对应会话的兜底状态标记为已结束
// （正常运行状态以 sqlite 为准；这里只在 sqlite 不可用时起作用）
function markTurnEnded(payload) {
  const rawId = payload && typeof payload.sessionId === "string" ? payload.sessionId : "";
  if (!rawId) return;
  const key = sessionKey({ sessionId: rawId });
  const state = loadState();
  const entry = state.sessions[key];
  if (!entry || !entry.running) return;
  entry.running = false;
  entry.endedAt = Date.now();
  entry.endReason = clampStr(payload && payload.reason, 40) || "";
  bumpSeq(state);
  saveState(state);
}

// 用户删除一张卡片：删掉清单，并记下删除时间。
// 只删清单不记时间的话，仍在运行的会话下一次轮询会被「主动发现」当成无清单卡片拉回来。
function removeSession(id) {
  const raw = typeof id === "string" ? id.trim() : "";
  if (!raw) return;
  const key = sessionKey({ sessionId: raw });
  const state = loadState();
  if (state.sessions[key]) delete state.sessions[key];
  state.dismissed = normalizeDismissed(state.dismissed);
  state.dismissed[key] = Date.now();
  bumpSeq(state);
  saveState(state);
}

function clearAll() {
  const state = loadState();
  state.sessions = {};
  state.dismissed = {};
  state.clearedAt = Date.now(); // 清空时正在运行的会话也一起隐藏，直到有新动静
  bumpSeq(state); // 保持 seq 单调递增，避免面板漏掉「清空」这次变化
  saveState(state);
}

// 某会话被删除/清空的时间；之后的新推送或新一轮 turn 才会让它重新出现
function hiddenSince(state, key) {
  const d = state.dismissed && Number.isFinite(state.dismissed[key]) ? state.dismissed[key] : 0;
  const c = Number.isFinite(state.clearedAt) ? state.clearedAt : 0;
  return Math.max(d, c);
}

/* ------------------------------------------------------------------ *
 * 面板读取（合并 pi.sqlite 真实标题/状态 + state.json 清单）
 * ------------------------------------------------------------------ */

// 有清单的会话：清单来自 state.json，标题/运行状态优先取 sqlite
function mergeView(entry, hostInfo) {
  const tasks = entry.tasks || [];
  const summary = entry.summary || summarize(tasks);
  const title = (hostInfo && hostInfo.title) || entry.title || pick("任务清单", "Tasks");
  let running;
  let endReason;
  let endedAt;
  if (hostInfo) {
    const live = hostLiveness(hostInfo.status);
    running = live.running;
    endReason = live.endReason;
    endedAt = live.running ? null : hostInfo.endedAt || null;
  } else {
    // sqlite 不可用：回退到存储的兜底状态
    running = !!entry.running;
    endReason = entry.endReason || null;
    endedAt = entry.endedAt || null;
  }
  return {
    id: entry.id,
    seq: entry.seq,
    title,
    tasks,
    summary,
    createdAt: entry.createdAt || null,
    updatedAt: entry.updatedAt || null,
    updates: entry.updates || 1,
    running,
    endedAt,
    endReason,
    legacy: !!entry.legacy,
    noChecklist: false,
  };
}

// 正在运行但还没推清单的会话：只有真实标题 + running，任务列表为空
function runningNoChecklistView(sid, info, now) {
  return {
    id: sid,
    seq: 0,
    title: info.title || pick("未命名会话", "Untitled session"),
    tasks: [],
    summary: summarize([]),
    createdAt: info.startedAt || null,
    updatedAt: info.updatedAt || info.startedAt || now,
    updates: 0,
    running: true,
    endedAt: null,
    endReason: null,
    legacy: false,
    noChecklist: true,
  };
}

function pullPayload() {
  const state = loadState();
  const host = readHostSessions(); // Map<sessionId,...> 或 null
  const now = Date.now();
  const shown = [];
  const usedIds = new Set();

  // 1) 有清单的会话（TTL 内）
  const entries = Object.values(state.sessions).filter(
    (s) => s && now - (s.updatedAt || 0) <= SESSION_TTL_MS
  );
  for (const e of entries) {
    const sid = rawIdOf(e);
    const hostInfo = sid && host ? host.get(sid) : null;
    if (sid) usedIds.add(sid);
    // 被删除/清空后，没有新推送、也没开新一轮 turn -> 继续隐藏
    const hs = hiddenSince(state, e.id);
    const marker = Math.max(e.updatedAt || 0, (hostInfo && hostInfo.startedAt) || 0);
    if (hs && marker <= hs) continue;
    shown.push(mergeView(e, hostInfo));
  }

  // 2) 正在运行、还没清单的会话（主动发现；滤掉卡死的旧 turn）
  if (host) {
    for (const [sid, info] of host) {
      if (usedIds.has(sid)) continue;
      if (!hostLiveness(info.status).running) continue;
      const activeAt = Math.max(info.updatedAt || 0, info.startedAt || 0);
      if (now - activeAt > RUNNING_DETECT_MS) continue;
      // 删除之后同一轮 turn 不再拉回；开了新一轮才重新出现
      const hs = hiddenSince(state, sessionKey({ sessionId: sid }));
      if (hs && (info.startedAt || 0) <= hs) continue;
      shown.push(runningNoChecklistView(sid, info, now));
    }
  }

  // 排序：运行中优先，其次按最近更新倒序
  shown.sort((a, b) => {
    if (!!b.running !== !!a.running) return b.running ? 1 : -1;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
  const sessions = shown.slice(0, MAX_SESSIONS);
  const latest = sessions[0] || null;

  // 实时签名：标题/运行状态/结束原因/进度/卡片集合任一变化都触发面板重渲染
  const liveSig = sessions
    .map(
      (s) =>
        s.id +
        "|" +
        (s.title || "") +
        "|" +
        (s.running ? "1" : "0") +
        "|" +
        (s.endReason || "") +
        "|" +
        (s.summary ? s.summary.done + "/" + s.summary.total : "-") +
        "|" +
        (s.noChecklist ? "n" : "c")
    )
    .join(";");

  return {
    ok: true,
    seq: Number.isFinite(state.seq) ? state.seq : 0,
    liveSig,
    hostAvailable: !!host,
    sessions,
    now,
    locale: uiLocale,
    version: PLUGIN_VERSION,
    // 兼容升级后尚未重开的旧面板（读顶层字段）
    title: latest ? latest.title : null,
    tasks: latest ? latest.tasks : [],
    summary: latest ? latest.summary : summarize([]),
    updatedAt: latest ? latest.updatedAt : null,
  };
}

async function openPanel() {
  try {
    await pi.ui.openPanel();
    return true;
  } catch {
    return false;
  }
}

function textResult(obj) {
  return {
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
    details: {},
  };
}

/* ------------------------------------------------------------------ *
 * 示例（命令 taskpanel.sample）
 * ------------------------------------------------------------------ */

function sampleArgs() {
  const zh = String(uiLocale || "").toLowerCase().startsWith("zh");
  const tasks = zh
    ? [
        { text: "读现有接口和数据层，摸清写法", status: "done" },
        { text: "查询层加分页参数", status: "done" },
        { text: "路由处理器接收 page/pageSize", status: "doing", note: "正在改 handler" },
        { text: "返回体带上分页元信息", status: "todo" },
        { text: "跑构建 + 相关测试", status: "todo" },
        { text: "等待接口密钥", status: "blocked", note: "卡在缺少测试环境密钥" },
      ]
    : [
        { text: "Read the endpoint and data layer", status: "done" },
        { text: "Add pagination params to the query layer", status: "done" },
        { text: "Accept page/pageSize in the route handler", status: "doing", note: "editing handler" },
        { text: "Return pagination metadata", status: "todo" },
        { text: "Run build + tests", status: "todo" },
        { text: "Waiting on API key", status: "blocked", note: "no staging key yet" },
      ];
  return { title: zh ? "开发计划（示例）" : "Dev plan (sample)", tasks };
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

const TOOL_DESC_ZH =
  "更新任务清单面板：把当前会话的开发计划 / 待办清单推送到独立的「任务清单」面板。" +
  "面板按会话分卡片，每个会话一张可折叠卡片、互不覆盖，卡片标题用你给这个对话起的真实名字（面板自动从本机读取），" +
  "多个正在跑的任务同时显示，实时显示已完成 / 进行中 / 待办 / 受阻。" +
  "【推送纪律，务必遵守】① 开始多步任务时立刻推一份粗清单；" +
  "② 每当一项开始 / 完成 / 卡住，就【立刻】再推一次，禁止攒着几项一起推——面板进度只有你推了才更新，不推就一直停在上次的数字；" +
  "③ 长任务里即便没有状态变化，每推进几步也要回推一次，表明还在动（长会话容易忘，务必主动，别埋头干活忘了报进度）。" +
  "每次都传完整清单（覆盖本会话这一栏）。title 可写清单名，但面板优先显示真实会话名。" +
  "tasks 必须是对象数组、不要传 JSON 字符串。传空数组则移除本会话这一栏。返回已完成数 / 总数。";
const TOOL_DESC_EN =
  "Update the Task Panel with this session's plan / checklist. The panel is split by session — each session is its own " +
  "collapsible card that others never overwrite, titled with the conversation's real name (read locally by the panel) — showing " +
  "done / in-progress / todo / blocked live, with several running tasks at once. " +
  "[Pushing discipline — follow it] (1) Push a rough list the moment a multi-step task starts; " +
  "(2) the moment any item starts / completes / gets blocked, push again IMMEDIATELY — never batch several changes, because the " +
  "panel's progress only updates when you push, and otherwise stays frozen at the last numbers; " +
  "(3) on long tasks, push again every few steps even with no status change, to show you're still moving (long sessions forget " +
  "easily — be proactive, don't get heads-down and forget to report). " +
  "Pass the full list each time (it replaces this session's card). title may name the checklist, but the panel prefers the real " +
  "conversation name. tasks must be an array of objects, not a JSON string. An empty array removes this session's card. Returns done / total counts.";

async function onLoad() {
  try {
    uiLocale = (await pi.app.getLocale()) || "zh-CN";
  } catch {
    uiLocale = "zh-CN";
  }

  await pi.commands.register({
    id: "taskpanel.open",
    title: pick("任务清单: 打开面板", "Task Panel: Open"),
    keywords: ["task", "todo", "checklist", "panel", "任务", "清单", "待办"],
    category: "Task Panel",
    run: async () => {
      await openPanel();
    },
  });

  await pi.commands.register({
    id: "taskpanel.clear",
    title: pick("任务清单: 清空全部", "Task Panel: Clear all"),
    keywords: ["task", "clear", "清空", "清单"],
    category: "Task Panel",
    run: async () => {
      clearAll();
      try {
        await pi.ui.showToast(pick("任务清单已清空", "Task Panel cleared"));
      } catch {
        /* toast 尽力而为 */
      }
    },
  });

  await pi.commands.register({
    id: "taskpanel.sample",
    title: pick("任务清单: 渲染示例", "Task Panel: Render sample"),
    keywords: ["task", "sample", "demo", "示例"],
    category: "Task Panel",
    run: async () => {
      const res = stageTasks(sampleArgs(), { sessionId: SAMPLE_KEY }, { running: false });
      await openPanel();
      try {
        const s = res.entry ? res.entry.summary : { done: 0, total: 0 };
        await pi.ui.showToast(`${s.done}/${s.total}`);
      } catch {
        /* toast 尽力而为 */
      }
    },
  });

  await pi.agent.registerTool({
    name: "task_update",
    description: pick(TOOL_DESC_ZH, TOOL_DESC_EN),
    risk: "low",
    schema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: pick(
            "清单标题，可选。面板优先显示对话的真实名字，此项仅在拿不到会话名时兜底。",
            "Checklist title, optional. The panel prefers the conversation's real name; this is only a fallback."
          ),
        },
        tasks: {
          type: "array",
          description: pick(
            "完整的任务项数组，按显示顺序排列。每次调用都传全量，覆盖本会话这一栏。传空数组则移除本会话。",
            "The full array of tasks in display order. Pass the complete list every time; it replaces this session's card. An empty array removes this session."
          ),
          items: {
            type: "object",
            properties: {
              text: { type: "string", description: pick("任务描述", "Task description") },
              status: {
                type: "string",
                enum: ["todo", "doing", "done", "blocked"],
                description: pick(
                  "todo=待办（默认）, doing=进行中, done=已完成, blocked=受阻",
                  "todo (default), doing, done, blocked"
                ),
              },
              note: { type: "string", description: pick("可选补充说明", "Optional note") },
            },
            required: ["text"],
          },
        },
        open: {
          type: "boolean",
          description: pick("是否打开/前置面板窗口，默认 true", "Open/focus the panel window; default true"),
        },
      },
      required: ["tasks"],
    },
    async execute(args, ctx) {
      try {
        const c = ctx || {};
        const rawId = typeof c.sessionId === "string" ? c.sessionId.trim() : "";
        const res = stageTasks(args || {}, c, {});
        let panelOpened = false;
        if (!args || args.open !== false) panelOpened = await openPanel();

        if (res.removed) {
          return textResult({
            ok: true,
            seq: res.seq,
            removed: true,
            total: 0,
            done: 0,
            doing: 0,
            todo: 0,
            blocked: 0,
            panelOpened,
            hint: pick("已从面板移除本会话这一栏。", "Removed this session's card from the panel."),
          });
        }

        // 顺带只读查一次真实会话名放进返回（面板本身也会实时读，取不到不影响）
        let realTitle = "";
        try {
          const host = readHostSessions();
          if (host && rawId && host.get(rawId)) realTitle = host.get(rawId).title || "";
        } catch {
          /* 取不到就用清单标题 */
        }

        const s = res.entry.summary;
        return textResult({
          ok: true,
          seq: res.seq,
          title: realTitle || res.entry.title,
          total: s.total,
          done: s.done,
          doing: s.doing,
          todo: s.todo,
          blocked: s.blocked,
          sessions: res.sessionCount,
          panelOpened,
          hint: pick(
            "已更新到面板里本会话专属的卡片（标题自动用真实会话名）。每开始/完成一项或卡住时再调一次；某项做很久时用 note 汇报进展。正文仍照常保留 Markdown 清单。",
            "Updated this session's own card (auto-titled with the real conversation name). Call again whenever an item starts/completes or gets blocked; use note to report progress on long items. Keep the Markdown checklist in your reply."
          ),
        });
      } catch (err) {
        return textResult({ ok: false, error: String((err && err.message) || err) });
      }
    },
  });

  if (pi.events && typeof pi.events.on === "function") {
    pi.events.on("plugin:settingsChanged", async () => {
      try {
        uiLocale = (await pi.app.getLocale()) || uiLocale;
      } catch {
        /* 保持当前语言 */
      }
    });
    // 会话本轮结束 -> 更新兜底状态（正常以 sqlite 为准）
    pi.events.on("session:turnEnded", (payload) => {
      try {
        markTurnEnded(payload || {});
      } catch {
        /* 尽力而为，不影响会话 */
      }
    });
  }
}

async function onUnload() {
  for (const id of ["taskpanel.open", "taskpanel.clear", "taskpanel.sample"]) {
    try {
      await pi.commands.unregister(id);
    } catch {
      /* 尽力而为 */
    }
  }
  try {
    await pi.agent.unregisterTool("task_update");
  } catch {
    /* 尽力而为 */
  }
}

/* ------------------------------------------------------------------ *
 * 面板通道
 * ------------------------------------------------------------------ */

async function onPanelInvoke(channel, payload) {
  const name = typeof channel === "string" ? channel : "";

  if (name === "app.getLocale") return { ok: true, locale: uiLocale };

  // 面板轮询这个。seq（清单版本）或 liveSig（实时标题/状态）变了就重渲染
  if (name === "task.pull") return pullPayload();

  if (name === "task.remove") {
    removeSession(payload && payload.id);
    return { ok: true };
  }

  if (name === "task.clear") {
    if (payload && typeof payload.id === "string" && payload.id) removeSession(payload.id);
    else clearAll();
    return { ok: true };
  }

  const err = new Error("unsupported panel channel: " + name);
  err.code = "UNSUPPORTED";
  throw err;
}

module.exports = {
  onLoad,
  onUnload,
  onPanelInvoke,
  // 仅供测试：清掉 pi.sqlite 读取缓存
  _resetForTest() {
    hostCache = { at: 0, map: null };
  },
};
