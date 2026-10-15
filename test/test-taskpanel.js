"use strict";
/*
 * main.js v0.4 逻辑测试：mock pi + 假 home 目录 + 可控时钟 + 临时 pi.sqlite(node:sqlite)。
 * 覆盖：会话隔离、覆盖式更新、open 开关、v0.1 迁移、遗留栏丢弃、空数组移除、
 * turnEnded、task.remove/clear、默认键、JSON 字符串容错、数量上限、TTL 过期、
 * 未知通道、v0.1 兼容字段、
 * 【v0.4】真实会话名/状态来自 pi.sqlite、改名跟随、运行/结束状态、主动发现无清单的运行会话、
 * sqlite 不可用降级。
 */
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP = path.join(process.env.PI_SCRATCH_DIR || __dirname, "tp-test-home");
fs.rmSync(TMP, { recursive: true, force: true });
os.homedir = () => TMP; // 让 dataDir() 与 hostDbPath() 都落到临时目录

let CLOCK = Date.UTC(2026, 8, 28, 0, 0, 0);
const realNow = Date.now;
Date.now = () => CLOCK;

let tool = null;
const cmd = {};
const ev = {};
let openCount = 0;
global.pi = {
  app: { getLocale: async () => "zh-CN" },
  commands: { register: async (c) => { cmd[c.id] = c.run; }, unregister: async () => {} },
  agent: { registerTool: async (t) => { tool = t; }, unregisterTool: async () => {} },
  ui: { openPanel: async () => { openCount++; return true; }, showToast: async () => {} },
  events: { on: (e, h) => { ev[e] = h; }, off: () => {} },
};

const mod = require("../src/main.js");
const STATE = path.join(TMP, ".pi-desktop", "plugins", "data", "local.taskpanel", "state.json");
function reset() { try { fs.rmSync(STATE); } catch {} }
function parse(res) { return JSON.parse(res.content[0].text); }

// 造/改临时 pi.sqlite（sessions 真实标题 + turns 运行状态）；改库后清 main.js 的读取缓存
const DB_FILE = path.join(TMP, ".pi-desktop", "pi.sqlite");
let sqliteMod = null;
try { sqliteMod = require("node:sqlite"); } catch { /* 老 node 无 node:sqlite */ }
function writeHostDb(rows) {
  // rows: [{id, title, status, startedAt?, endedAt?, updatedAt?}]
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  try { fs.rmSync(DB_FILE); } catch {}
  const db = new sqliteMod.DatabaseSync(DB_FILE);
  db.exec("create table sessions(id text, title text, deleted_at integer, updated_at integer, created_at integer)");
  db.exec("create table turns(id text, session_id text, status text, started_at integer, ended_at integer)");
  const si = db.prepare("insert into sessions(id,title,deleted_at,updated_at) values(?,?,?,?)");
  const ti = db.prepare("insert into turns(id,session_id,status,started_at,ended_at) values(?,?,?,?,?)");
  let n = 1;
  for (const r of rows) {
    si.run(r.id, r.title, null, r.updatedAt ?? CLOCK);
    ti.run("turn" + n++, r.id, r.status, r.startedAt ?? CLOCK, r.endedAt ?? null);
  }
  db.close();
  mod._resetForTest();
}
function removeHostDb() {
  try { fs.rmSync(DB_FILE); } catch {}
  mod._resetForTest();
}

let passed = 0;
function ok(name) { console.log("  ok  " + name); passed += 1; }

(async () => {
  assert(sqliteMod && sqliteMod.DatabaseSync, "node:sqlite 可用（测试前置）");
  await mod.onLoad();
  assert(tool && typeof tool.execute === "function", "tool registered");
  assert(cmd["taskpanel.open"] && cmd["taskpanel.clear"] && cmd["taskpanel.sample"], "commands registered");
  assert(typeof ev["session:turnEnded"] === "function", "turnEnded handler registered");
  ok("onLoad 注册工具 + 命令 + turnEnded 事件");

  // 以下 1-15 项：不造 pi.sqlite（不存在），readHostSessions 返回 null，走存储兜底状态
  removeHostDb();

  // 1. 会话隔离，按最近更新倒序（都 running，按 updatedAt）
  reset();
  await tool.execute({ title: "A", tasks: [{ text: "a1", status: "done" }, { text: "a2", status: "doing" }, { text: "a3" }] }, { sessionId: "sessA", turnId: "t1" });
  CLOCK += 1000;
  await tool.execute({ title: "B", tasks: [{ text: "b1", status: "done" }, { text: "b2" }] }, { sessionId: "sessB", turnId: "t2" });
  mod._resetForTest();
  let pull = await mod.onPanelInvoke("task.pull");
  assert.equal(pull.sessions.length, 2, "两个会话");
  assert.equal(pull.sessions[0].id, "sessB", "最近的在前");
  assert.equal(pull.sessions[0].tasks.length, 2, "B 的任务完整");
  assert.equal(pull.sessions[1].id, "sessA", "A 在后");
  assert.equal(pull.sessions[1].tasks.length, 3, "A 的任务没被覆盖");
  ok("两个会话互不覆盖、按最近更新排序");

  // 2. 覆盖式更新同一会话，保留标题、createdAt，updates 递增
  const aCreated = pull.sessions[1].createdAt;
  CLOCK += 1000;
  const rA2 = parse(await tool.execute({ tasks: [{ text: "a1", status: "done" }, { text: "a2", status: "done" }, { text: "a3", status: "done" }] }, { sessionId: "sessA", turnId: "t3" }));
  assert.equal(rA2.title, "A", "省略 title 时沿用上次");
  assert.equal(rA2.done, 3, "A 现在 3 项完成");
  mod._resetForTest();
  pull = await mod.onPanelInvoke("task.pull");
  const a = pull.sessions.find((s) => s.id === "sessA");
  assert.equal(a.updates, 2, "updates 递增");
  assert.equal(a.createdAt, aCreated, "createdAt 保留");
  assert(a.updatedAt > a.createdAt, "updatedAt 前进");
  ok("覆盖式更新保留标题/createdAt、递增 updates");

  // 3. open 开关
  reset();
  openCount = 0;
  await tool.execute({ title: "X", tasks: [{ text: "x" }] }, { sessionId: "sx" });
  assert.equal(openCount, 1, "默认打开面板");
  await tool.execute({ title: "X", tasks: [{ text: "x", status: "done" }], open: false }, { sessionId: "sx" });
  assert.equal(openCount, 1, "open:false 不打开");
  ok("open 开关控制是否前置面板");

  // 4. v0.1 迁移
  reset();
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify({ seq: 5, updatedAt: CLOCK, title: "Old", tasks: [{ text: "o1", status: "done" }, { text: "o2" }] }));
  mod._resetForTest();
  pull = await mod.onPanelInvoke("task.pull");
  assert.equal(pull.sessions.length, 1, "v0.1 迁移成 1 个会话");
  assert.equal(pull.sessions[0].legacy, true, "标记为遗留");
  assert.equal(pull.sessions[0].title, "Old", "遗留标题保留");
  assert.equal(pull.seq, 5, "遗留 seq 沿用");
  assert.equal(pull.title, "Old", "兼容顶层 title");
  ok("v0.1 单份清单迁移成遗留会话");

  // 5. 真实会话推送后丢弃遗留栏
  CLOCK += 1000;
  await tool.execute({ title: "New", tasks: [{ text: "n1" }] }, { sessionId: "sNew", turnId: "tn" });
  pull = await mod.onPanelInvoke("task.pull");
  assert.equal(pull.sessions.length, 1, "遗留栏被丢弃");
  assert.equal(pull.sessions[0].id, "sNew", "只剩真实会话");
  ok("真实会话推送后丢弃迁移来的遗留栏");

  // 6. 空数组移除会话
  reset();
  await tool.execute({ title: "R", tasks: [{ text: "r1" }] }, { sessionId: "sr" });
  const rr = parse(await tool.execute({ tasks: [] }, { sessionId: "sr" }));
  assert.equal(rr.removed, true, "removed 标志");
  pull = await mod.onPanelInvoke("task.pull");
  assert.equal(pull.sessions.length, 0, "会话被移除");
  ok("传空数组移除本会话这一栏");

  // 7. turnEnded 兜底标记结束（sqlite 不可用时生效）、记录 reason、忽略未知会话
  reset();
  await tool.execute({ title: "E", tasks: [{ text: "e1", status: "doing" }] }, { sessionId: "se", turnId: "te" });
  let before = await mod.onPanelInvoke("task.pull");
  assert.equal(before.sessions[0].running, true, "结束前 running");
  CLOCK += 1000;
  ev["session:turnEnded"]({ sessionId: "se", turnId: "te", reason: "completed" });
  let after = await mod.onPanelInvoke("task.pull");
  assert.equal(after.sessions[0].running, false, "结束后非 running");
  assert.equal(after.sessions[0].endReason, "completed", "记录结束原因");
  ev["session:turnEnded"]({ sessionId: "nope", turnId: "x", reason: "completed" });
  ok("turnEnded 兜底标记结束、记录 reason、忽略未知会话");

  // 8. task.remove
  reset();
  await tool.execute({ title: "D", tasks: [{ text: "d1" }] }, { sessionId: "sd" });
  await mod.onPanelInvoke("task.remove", { id: "sd" });
  pull = await mod.onPanelInvoke("task.pull");
  assert.equal(pull.sessions.length, 0, "task.remove 移除会话");
  ok("task.remove 移除指定会话");

  // 9. task.clear 按 id / 全部，seq 单调
  reset();
  await tool.execute({ title: "C1", tasks: [{ text: "c1" }] }, { sessionId: "sc1" });
  await tool.execute({ title: "C2", tasks: [{ text: "c2" }] }, { sessionId: "sc2" });
  let pc = await mod.onPanelInvoke("task.pull");
  const seqPre = pc.seq;
  await mod.onPanelInvoke("task.clear", { id: "sc1" });
  pc = await mod.onPanelInvoke("task.pull");
  assert.equal(pc.sessions.length, 1, "带 id 清除一个");
  assert.equal(pc.sessions[0].id, "sc2", "另一个保留");
  await mod.onPanelInvoke("task.clear");
  pc = await mod.onPanelInvoke("task.pull");
  assert.equal(pc.sessions.length, 0, "清空全部");
  assert(pc.seq > seqPre, "清空后 seq 仍单调递增");
  ok("task.clear 支持按 id 与全部，seq 单调");

  // 10. 缺 sessionId 用默认键
  reset();
  const rd = parse(await tool.execute({ title: "Def", tasks: [{ text: "d" }] }, {}));
  assert.equal(rd.ok, true, "默认 ctx 正常");
  pull = await mod.onPanelInvoke("task.pull");
  assert.equal(pull.sessions.length, 1, "一个默认会话");
  ok("缺 sessionId 时落到默认键");

  // 11. JSON 字符串容错
  reset();
  await tool.execute({ title: "S", tasks: JSON.stringify([{ text: "s1", status: "done" }, { text: "s2" }]) }, { sessionId: "ss" });
  pull = await mod.onPanelInvoke("task.pull");
  assert.equal(pull.sessions.length, 1, "字符串 tasks 被解析");
  assert.equal(pull.sessions[0].tasks.length, 2, "解析出 2 项");
  ok("normalizeTasks 容错 JSON 字符串");

  // 12. 数量上限
  reset();
  for (let i = 0; i < 14; i += 1) { CLOCK += 1000; await tool.execute({ title: "P" + i, tasks: [{ text: "p" }] }, { sessionId: "sp" + i }); }
  pull = await mod.onPanelInvoke("task.pull");
  assert.equal(pull.sessions.length, 12, "裁剪到 MAX_SESSIONS");
  assert.equal(pull.sessions[0].id, "sp13", "保留最近的");
  ok("超过上限时保留最近的会话");

  // 13. TTL 过期
  reset();
  await tool.execute({ title: "Fresh", tasks: [{ text: "f" }] }, { sessionId: "sf" });
  CLOCK += 4 * 24 * 60 * 60 * 1000;
  pull = await mod.onPanelInvoke("task.pull");
  assert.equal(pull.sessions.length, 0, "超 TTL 的会话在 pull 时消失");
  ok("超过 TTL 的会话读取时被过滤");

  // 14. 未知通道抛错
  let threw = false;
  try { await mod.onPanelInvoke("bogus.channel"); } catch (e) { threw = true; }
  assert(threw, "未知通道抛错");
  ok("未知面板通道抛错");

  // 15. v0.1 兼容顶层字段
  reset();
  await tool.execute({ title: "Cmp", tasks: [{ text: "c1", status: "done" }, { text: "c2" }] }, { sessionId: "scmp" });
  pull = await mod.onPanelInvoke("task.pull");
  assert.equal(pull.tasks.length, 2, "兼容顶层 tasks = 最新会话");
  assert(pull.summary && pull.summary.total === 2, "兼容顶层 summary");
  ok("v0.1 面板兼容：顶层字段镜像最新会话");

  // ---------------- v0.4：pi.sqlite 直读真实会话名 / 状态 ----------------

  // 16. 真实会话名来自 pi.sqlite：卡片 title 用真实名，execute 返回也用真实名
  reset();
  writeHostDb([{ id: "realsess", title: "宠物医院多版本功能开发14-17", status: "running" }]);
  const r16 = parse(await tool.execute({ title: "开发计划", tasks: [{ text: "t1" }] }, { sessionId: "realsess", turnId: "tr" }));
  assert.equal(r16.title, "宠物医院多版本功能开发14-17", "execute 返回 sqlite 真实会话名，不是清单 title");
  mod._resetForTest();
  pull = await mod.onPanelInvoke("task.pull");
  const rs = pull.sessions.find((s) => s.id === "realsess");
  assert.equal(rs.title, "宠物医院多版本功能开发14-17", "卡片标题用 sqlite 真实名");
  assert.equal(rs.running, true, "sqlite turn=running -> running");
  assert.equal(rs.noChecklist, false, "有清单");
  assert.equal(pull.hostAvailable, true, "hostAvailable=true");
  ok("真实会话名/状态来自 pi.sqlite（非模型清单名）");

  // 17. 改名检测：改 sqlite title -> 下次 pull 自动跟上
  writeHostDb([{ id: "realsess", title: "宠物医院最终版", status: "running" }]);
  pull = await mod.onPanelInvoke("task.pull");
  const rs17 = pull.sessions.find((s) => s.id === "realsess");
  assert.equal(rs17.title, "宠物医院最终版", "改名后 pull 跟上新会话名");
  ok("会话改名后面板自动跟上（重查 sqlite）");

  // 18. 运行状态以 sqlite 为准：turn completed -> running=false, endReason=completed
  writeHostDb([{ id: "realsess", title: "宠物医院最终版", status: "completed", endedAt: CLOCK }]);
  pull = await mod.onPanelInvoke("task.pull");
  const rs18 = pull.sessions.find((s) => s.id === "realsess");
  assert.equal(rs18.running, false, "completed -> 非 running");
  assert.equal(rs18.endReason, "completed", "结束原因 completed");
  ok("运行/结束状态以 sqlite turn 状态为准");

  // 19. 主动发现：sqlite 有 running 会话但没推清单 -> 出现 noChecklist 卡片
  reset();
  writeHostDb([
    { id: "hasList", title: "有清单会话", status: "running" },
    { id: "noList", title: "选择软件版本", status: "running" },
  ]);
  await tool.execute({ title: "L", tasks: [{ text: "x" }] }, { sessionId: "hasList" });
  mod._resetForTest();
  pull = await mod.onPanelInvoke("task.pull");
  const no = pull.sessions.find((s) => s.id === "noList");
  assert(no, "运行中但没清单的会话也出现在面板");
  assert.equal(no.noChecklist, true, "标记 noChecklist");
  assert.equal(no.title, "选择软件版本", "用真实会话名");
  assert.equal(no.tasks.length, 0, "任务列表为空");
  const has = pull.sessions.find((s) => s.id === "hasList");
  assert.equal(has.noChecklist, false, "有清单的正常显示");
  ok("主动发现正在运行但还没推清单的会话");

  // 19b. 主动发现只认「最近」的 running：过久未活动的 running turn 不显示
  reset();
  writeHostDb([{ id: "stale", title: "卡死的旧会话", status: "running", startedAt: CLOCK - 60 * 60 * 1000, updatedAt: CLOCK - 60 * 60 * 1000 }]);
  pull = await mod.onPanelInvoke("task.pull");
  assert(!pull.sessions.find((s) => s.id === "stale"), "超过检测窗口的 running 会话不主动显示");
  ok("主动发现滤掉久未活动的卡死 running turn");

  // 19c. 删除运行中的会话：不会被「主动发现」当成无清单卡片拉回来
  reset();
  writeHostDb([{ id: "runA", title: "运行中会话", status: "running", startedAt: CLOCK - 60000 }]);
  await tool.execute({ title: "L", tasks: [{ text: "x" }] }, { sessionId: "runA" });
  CLOCK += 1000;
  await mod.onPanelInvoke("task.remove", { id: "runA" });
  mod._resetForTest();
  pull = await mod.onPanelInvoke("task.pull");
  assert(!pull.sessions.find((s) => s.id === "runA"), "删除后不再出现（不会变成无清单卡片）");
  ok("删除运行中的会话后不会被主动发现拉回来");

  // 19d. 删除后该会话又推了新清单 -> 重新出现
  CLOCK += 1000;
  await tool.execute({ title: "L", tasks: [{ text: "y" }] }, { sessionId: "runA" });
  mod._resetForTest();
  pull = await mod.onPanelInvoke("task.pull");
  const back = pull.sessions.find((s) => s.id === "runA");
  assert(back && back.noChecklist === false && back.tasks[0].text === "y", "新推送后重新出现");
  ok("删除后会话再推清单会重新出现");

  // 19e. 删除「运行中 · 无清单」卡片：本轮不再出现，开新一轮 turn 才回来
  reset();
  const t0 = CLOCK - 60000;
  writeHostDb([{ id: "disc", title: "被发现的会话", status: "running", startedAt: t0 }]);
  CLOCK += 1000;
  await mod.onPanelInvoke("task.remove", { id: "disc" });
  mod._resetForTest();
  pull = await mod.onPanelInvoke("task.pull");
  assert(!pull.sessions.find((s) => s.id === "disc"), "同一轮 turn 不再拉回");
  CLOCK += 1000;
  writeHostDb([{ id: "disc", title: "被发现的会话", status: "running", startedAt: CLOCK }]);
  pull = await mod.onPanelInvoke("task.pull");
  assert(pull.sessions.find((s) => s.id === "disc" && s.noChecklist), "新一轮 turn 开始后重新出现");
  ok("删除无清单卡片后同一轮不回弹、新一轮才出现");

  // 19f. 清空全部：当时正在运行的无清单会话也一起隐藏
  reset();
  writeHostDb([{ id: "c1", title: "甲", status: "running", startedAt: CLOCK - 60000 }]);
  CLOCK += 1000;
  await mod.onPanelInvoke("task.clear");
  mod._resetForTest();
  pull = await mod.onPanelInvoke("task.pull");
  assert.equal(pull.sessions.length, 0, "清空后正在运行的会话也不再显示");
  ok("清空全部同时隐藏正在运行的无清单会话");

  // 19g. 模型推空清单移除自己的卡片：同样不会被主动发现拉回
  reset();
  writeHostDb([{ id: "selfrm", title: "自己移除", status: "running", startedAt: CLOCK - 60000 }]);
  await tool.execute({ title: "L", tasks: [{ text: "x" }] }, { sessionId: "selfrm" });
  CLOCK += 1000;
  await tool.execute({ tasks: [] }, { sessionId: "selfrm" });
  mod._resetForTest();
  pull = await mod.onPanelInvoke("task.pull");
  assert(!pull.sessions.find((s) => s.id === "selfrm"), "推空清单后不回弹");
  ok("模型推空清单移除卡片后不会被主动发现拉回");

  // 20. sqlite 不可用 -> 降级用存储兜底状态
  reset();
  removeHostDb();
  await tool.execute({ title: "兜底清单", tasks: [{ text: "t" }] }, { sessionId: "fb", turnId: "t" });
  const r20 = parse(await tool.execute({ title: "兜底清单", tasks: [{ text: "t", status: "done" }] }, { sessionId: "fb", turnId: "t2" }));
  assert.equal(r20.title, "兜底清单", "sqlite 不可用时 execute 返回清单 title");
  mod._resetForTest();
  pull = await mod.onPanelInvoke("task.pull");
  assert.equal(pull.hostAvailable, false, "hostAvailable=false");
  const fb = pull.sessions.find((s) => s.id === "fb");
  assert.equal(fb.title, "兜底清单", "降级用清单 title");
  assert.equal(fb.running, true, "降级用兜底 running");
  ok("pi.sqlite 不可用时降级用清单标题与兜底状态");

  // 21. 状态文件落在假 home
  assert(fs.existsSync(STATE), "state.json 在假 home 数据目录");
  ok("状态文件写在插件自己的数据目录");

  Date.now = realNow;
  console.log("\n全部通过：" + passed + " 项");
})().catch((e) => {
  Date.now = realNow;
  console.error("测试失败：", e && e.stack ? e.stack : e);
  process.exit(1);
});
