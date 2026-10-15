"use strict";
/*
 * panel.js v0.4 渲染测试：DOM stub + 假 pluginBridge 在 Node 里跑手风琴渲染逻辑。
 * 覆盖：演示模式三张卡片同时显示（含 noChecklist 运行卡）、标题即真实会话名、
 *       running 优先排序、点卡头折叠/展开且状态存 localStorage、全部折叠/展开、移除卡片；
 *       实时模式跟随渲染、title 即真实会话名、运行中/已结束状态、noChecklist 占位、
 *       task.remove 调用、running 但久未更新标 stale、liveSig 变化触发重渲染、pull 失败降级。
 * 用 vm 沙箱隔离每次加载，各自独立的 document/window。
 */
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "panel.js"), "utf8");

let passed = 0;
function ok(name) { console.log("  ok  " + name); passed += 1; }

/* --------- 极简 DOM stub（够 panel.js 用：className/textContent/子节点/事件/attr） --------- */
function makeNode(tag) {
  return {
    tagName: tag,
    className: "",
    _text: "",
    type: "",
    title: "",
    hidden: false,
    style: {},
    children: [],
    parentNode: null,
    listeners: {},
    attrs: {},
    set textContent(v) {
      this._text = v == null ? "" : String(v);
      this.children.forEach((c) => { c.parentNode = null; });
      this.children = [];
    },
    get textContent() { return this._text; },
    // 和真 DOM 一样：插入已在别处的节点会先把它摘下来（拖动排序靠这个）
    appendChild(c) { detach(c); c.parentNode = this; this.children.push(c); return c; },
    insertBefore(c, ref) {
      detach(c);
      c.parentNode = this;
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i < 0) this.children.push(c);
      else this.children.splice(i, 0, c);
      return c;
    },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; },
    get firstChild() { return this.children[0] || null; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    fire(ev, e) { (this.listeners[ev] || []).forEach((fn) => fn(e || {})); },
    click() { this.fire("click", {}); },
    // 布局桩：每个节点高 100px，按它在父节点里的下标竖着排
    getBoundingClientRect() {
      const i = this.parentNode ? this.parentNode.children.indexOf(this) : 0;
      // 和真 DOM 一样把 translateY 位移算进去（被拖的卡片跟手时靠这个）
      const m = /translateY\((-?[\d.]+)px\)/.exec((this.style && this.style.transform) || "");
      const top = i * 100 + (m ? Number(m[1]) : 0);
      return { top, bottom: top + 100, height: 100, left: 0, right: 300, width: 300 };
    },
  };
}
function detach(c) {
  if (c && c.parentNode) c.parentNode.children = c.parentNode.children.filter((x) => x !== c);
}
function hasCls(n, c) { return (" " + (n.className || "") + " ").indexOf(" " + c + " ") >= 0; }
// 递归找出所有带某 class 的节点
function collect(node, cls, out) {
  out = out || [];
  if (!node) return out;
  if (node.className && (" " + node.className + " ").indexOf(" " + cls + " ") >= 0) out.push(node);
  (node.children || []).forEach((c) => collect(c, cls, out));
  return out;
}
function allText(node) {
  if (!node) return "";
  let s = node._text || "";
  (node.children || []).forEach((c) => { s += " " + allText(c); });
  return s;
}
// 卡片头（点击折叠/展开）
function headOf(card) { return collect(card, "tp-card__head")[0]; }
function cards(env) { return collect(env.ids["tp-root"], "tp-card"); }
function collapsedCount(env) { return collect(env.ids["tp-root"], "tp-card--collapsed").length; }

function makeEnv(bridge, seed) {
  const ids = {};
  const buttons = ["tp-toggle-all", "tp-lang", "tp-reset-order"];
  ["tp-title", "tp-count", "tp-meta", "tp-toggle-all", "tp-reset-order", "tp-lang", "tp-root", "tp-status"].forEach((id) => {
    ids[id] = makeNode(buttons.indexOf(id) >= 0 ? "button" : "div");
  });
  ids["tp-toggle-all"].hidden = true; // index.html 里初始 hidden
  ids["tp-reset-order"].hidden = true;
  const timers = [];
  const doc = {
    documentElement: {},
    hidden: false,
    getElementById: (id) => ids[id] || null,
    createElement: (tag) => makeNode(tag),
    addEventListener() {},
  };
  const store = Object.assign({}, seed || {}); // 可预置 localStorage（测试「重开面板仍记得顺序」）
  const win = {
    pluginBridge: bridge,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    // window 级监听：记下来，测试里用 win.fire 派发（拖动的 pointermove / pointerup 在这里收）
    listeners: {},
    addEventListener(ev, fn) { (win.listeners[ev] = win.listeners[ev] || []).push(fn); },
    fire(ev, e) { (win.listeners[ev] || []).forEach((fn) => fn(e || {})); },
  };
  const sandbox = {
    window: win,
    document: doc,
    navigator: { language: "zh-CN" },
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearInterval() {},
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { ids, timers, store, win };
}

function tick() { return new Promise((r) => setTimeout(r, 5)); }

(async () => {
  /* ---------------- 演示模式（无 bridge，3 张卡：宠物医院 running / 论文 ended / 选择版本 noChecklist） ---------------- */
  {
    const env = makeEnv(null);
    await tick();

    let cs = cards(env);
    assert.equal(cs.length, 3, "演示模式：三张卡片同时渲染（手风琴，不是 tab 切换）");
    const titles = collect(env.ids["tp-root"], "tp-card__title").map(allText);
    assert(titles.some((t) => t.indexOf("宠物医院") >= 0), "卡片标题=宠物医院会话名");
    assert(titles.some((t) => t.indexOf("论文") >= 0), "卡片标题=论文会话名");
    assert(titles.some((t) => t.indexOf("选择软件版本") >= 0), "卡片标题=选择软件版本（无清单会话）");
    assert(allText(env.ids["tp-meta"]).indexOf("示例") >= 0, "meta 标注示例数据");
    ok("演示模式三张卡片同时渲染、标题即真实会话名");

    // running 优先排序：宠物医院、选择软件版本（都 running）排在已结束的论文之前
    assert(allText(cs[0]).indexOf("论文") < 0, "已结束的论文卡不在最前");
    assert(allText(cs[2]).indexOf("论文") >= 0, "已结束的论文卡排在最后");
    ok("running 会话优先、已结束靠后");

    // noChecklist 卡片：显示占位说明，不显示 0/0 计数
    const emptyCard = cs.find((c) => (" " + c.className + " ").indexOf(" tp-card--empty ") >= 0);
    assert(emptyCard, "存在 noChecklist 占位卡");
    assert(allText(emptyCard).indexOf("还没推送清单") >= 0, "占位卡显示『还没推送清单』");
    assert.equal(collect(emptyCard, "tp-card__count").length, 0, "占位卡不显示 0/0 计数");
    ok("noChecklist 卡片显示占位说明、不显示计数");

    assert.equal(env.ids["tp-toggle-all"].hidden, false, "多会话时全部折叠/展开按钮可见");
    ok("多卡片时显示全部折叠/展开按钮");

    // 默认全展开 -> 点第一张卡头折叠
    assert.equal(collapsedCount(env), 0, "默认全部展开");
    headOf(cs[0]).click();
    await tick();
    assert.equal(collapsedCount(env), 1, "点卡头后折叠一张");
    assert(env.store["tp.collapsed"], "折叠状态写入 localStorage");
    ok("点卡片头折叠、状态存 localStorage");

    // 再点展开（DOM 已重建，重新取卡片）
    cs = cards(env);
    headOf(cs[0]).click();
    await tick();
    assert.equal(collapsedCount(env), 0, "再点卡头展开");
    ok("再点卡片头展开");

    // 全部折叠 -> 全部展开
    env.ids["tp-toggle-all"].click();
    await tick();
    assert.equal(collapsedCount(env), 3, "全部折叠按钮折叠所有卡片");
    env.ids["tp-toggle-all"].click();
    await tick();
    assert.equal(collapsedCount(env), 0, "全部展开按钮展开所有卡片");
    ok("全部折叠 / 全部展开按钮生效");

    // 移除排最前的卡片（演示模式本地移除）
    cs = cards(env);
    collect(cs[0], "tp-card__remove")[0].click();
    await tick();
    assert.equal(cards(env).length, 2, "移除后剩 2 张");
    ok("演示模式移除卡片");
  }

  /* ---------------- 语言切换（默认中文，点按钮切英文，记 localStorage） ---------------- */
  {
    const env = makeEnv(null);
    await tick();
    // 默认中文：meta 显示「示例数据」，切换按钮显示可切到的目标语言 EN
    assert(allText(env.ids["tp-meta"]).indexOf("示例") >= 0, "默认中文");
    assert.equal(env.ids["tp-lang"].textContent, "EN", "中文时按钮显示 EN");
    // 点一下切到英文
    env.ids["tp-lang"].click();
    await tick();
    assert(allText(env.ids["tp-meta"]).indexOf("Demo") >= 0, "切换后 meta 变英文");
    assert.equal(env.ids["tp-lang"].textContent, "中", "英文时按钮显示 中");
    assert.equal(env.store["tp.lang"], "en", "语言选择写入 localStorage");
    ok("语言切换：默认中文、点按钮切英文、记住选择");
  }

  /* ---------------- 拖动排序：手柄拖动、记住顺序、键盘 ↑/↓、恢复默认 ---------------- */
  {
    const env = makeEnv(null);
    await tick();
    const ids0 = cards(env).map((c) => c._tpId);
    assert.equal(ids0.length, 3, "三张卡片");
    assert.equal(env.ids["tp-reset-order"].hidden, true, "没拖过时不显示「默认排序」");

    // 按住第一张的手柄，拖到最后一张中线以下（布局桩：每张 100px 高）
    const grip = collect(cards(env)[0], "tp-card__grip")[0];
    grip.fire("pointerdown", { button: 0, clientX: 10, clientY: 50, pointerId: 1 });
    assert(hasCls(cards(env)[0], "tp-card--dragging"), "拖动中加 dragging 样式");
    env.win.fire("pointermove", { clientX: 10, clientY: 280, pointerId: 1 });
    grip.fire("pointerup", { pointerId: 1 });
    await tick();
    const ids1 = cards(env).map((c) => c._tpId);
    assert.deepEqual(ids1, [ids0[1], ids0[2], ids0[0]], "第一张被拖到最后");
    assert.equal(env.store["tp.order"], JSON.stringify(ids1), "顺序写入 localStorage");
    assert.equal(env.ids["tp-reset-order"].hidden, false, "拖过之后出现「默认排序」");
    ok("按住手柄拖动调整卡片顺序，并记住顺序");

    // 键盘：聚焦第二张手柄按 ↑，和第一张对调
    collect(cards(env)[1], "tp-card__grip")[0].fire("keydown", { key: "ArrowUp", preventDefault() {} });
    const ids2 = cards(env).map((c) => c._tpId);
    assert.deepEqual(ids2, [ids1[1], ids1[0], ids1[2]], "↑ 上移一位");
    ok("聚焦手柄按 ↑/↓ 也能调整顺序");

    // 恢复默认排序
    env.ids["tp-reset-order"].click();
    assert.deepEqual(cards(env).map((c) => c._tpId), ids0, "回到自动顺序");
    assert.equal(env.store["tp.order"], undefined, "清掉保存的顺序");
    assert.equal(env.ids["tp-reset-order"].hidden, true, "「默认排序」按钮隐藏");
    ok("「默认排序」恢复自动顺序");
  }

  /* ---------------- 连续拖动：一次按住换位多次、卡片跟手、定时刷新不打断、松手在手柄外也算 ---------------- */
  {
    const env = makeEnv(null);
    await tick();
    const [A, B, C] = cards(env).map((c) => c._tpId);
    const dragged = cards(env)[0];
    const grip = collect(dragged, "tp-card__grip")[0];

    // 按在 A 的 y=30 处，不松手连续往下拖：先越过 B，再越过 C（以前第一次换位后就拖不动了）
    grip.fire("pointerdown", { button: 0, clientX: 10, clientY: 30, pointerId: 7 });
    env.win.fire("pointermove", { clientX: 10, clientY: 160, pointerId: 7 });
    assert.deepEqual(cards(env).map((c) => c._tpId), [B, A, C], "第一次换位：越过 B");
    env.win.fire("pointermove", { clientX: 10, clientY: 270, pointerId: 7 });
    assert.deepEqual(cards(env).map((c) => c._tpId), [B, C, A], "同一次按住继续换位：越过 C");
    // 卡片跟手：被拖卡片的顶边 = 指针位置 - 按下时在卡片上的偏移
    assert.equal(dragged.getBoundingClientRect().top, 270 - 30, "被拖的卡片跟着指针走");
    // 再一路拖回顶上
    env.win.fire("pointermove", { clientX: 10, clientY: 20, pointerId: 7 });
    assert.deepEqual(cards(env).map((c) => c._tpId), [A, B, C], "往回拖也能连续换位");
    assert.equal(dragged.getBoundingClientRect().top, 20 - 30, "往回拖仍然跟手");
    ok("一次按住可连续换位多次，卡片跟着指针移动");

    // 拖动中「x 分钟前更新」的定时刷新到点：不重建卡片、不打断拖动
    const clock = env.timers.find((x) => x.ms === 20000);
    assert(clock, "存在定时刷新");
    clock.fn();
    assert.equal(cards(env)[0], dragged, "拖动中定时刷新不重建 DOM");
    assert(hasCls(dragged, "tp-card--dragging"), "拖动状态还在");
    ok("拖动中定时刷新不会打断拖动");

    // 在手柄以外的地方松手（window 收到 pointerup）也能正常落位并记住
    env.win.fire("pointermove", { clientX: 10, clientY: 270, pointerId: 7 });
    env.win.fire("pointerup", { pointerId: 7 });
    const after = cards(env).map((c) => c._tpId);
    assert.deepEqual(after, [B, C, A], "松手落位");
    assert.equal(env.store["tp.order"], JSON.stringify(after), "顺序写入 localStorage");
    assert(cards(env).every((c) => !c.style.transform), "松手后卡片回到列表位置（无残留位移）");
    ok("在手柄外松手也能落位并记住顺序");

    // 紧接着再拖第二次（以前第二次也会失灵）
    const grip2 = collect(cards(env)[2], "tp-card__grip")[0]; // A 现在在最后
    grip2.fire("pointerdown", { button: 0, clientX: 10, clientY: 230, pointerId: 8 });
    env.win.fire("pointermove", { clientX: 10, clientY: 40, pointerId: 8 });
    env.win.fire("pointerup", { pointerId: 8 });
    assert.deepEqual(cards(env).map((c) => c._tpId), [A, B, C], "第二次拖动正常");
    ok("连续进行多次拖动都正常");

    // 上一次的松手事件丢了（比如在窗口外松开）：再按下另一个手柄会先收尾旧手势，不会卡住
    const gA = collect(cards(env)[0], "tp-card__grip")[0];
    const gB = collect(cards(env)[1], "tp-card__grip")[0];
    gA.fire("pointerdown", { button: 0, clientX: 10, clientY: 50, pointerId: 9 });
    gB.fire("pointerdown", { button: 0, clientX: 10, clientY: 150, pointerId: 10 });
    assert(!hasCls(cards(env)[0], "tp-card--dragging"), "旧的拖动已收尾");
    assert(hasCls(cards(env)[1], "tp-card--dragging"), "新的拖动正常开始");
    // 鼠标移动时已经没有按键按着：视为松手
    env.win.fire("pointermove", { pointerType: "mouse", buttons: 0, clientX: 10, clientY: 150, pointerId: 10 });
    assert(cards(env).every((c) => !hasCls(c, "tp-card--dragging")), "按键已松开的移动会结束拖动");
    ok("松手事件丢失时自动收尾，不会卡在拖动中");
  }

  /* ---------------- 重开面板仍记得顺序；新出现的会话排最前 ---------------- */
  {
    const env = makeEnv(null, { "tp.order": JSON.stringify(["demoB", "demoA"]) });
    await tick();
    const ids = cards(env).map((c) => c._tpId);
    assert.deepEqual(ids, ["demoC", "demoB", "demoA"], "已保存的按保存顺序，没保存过的 demoC 排最前");
    ok("重开面板沿用保存的顺序，新会话排在最前");
  }

  /* ---------------- 左划：露出删除按钮、点删除移除、点头部只算点击、竖划不触发 ---------------- */
  {
    const env = makeEnv(null);
    await tick();
    let head = headOf(cards(env)[0]);

    // 只动了一点点（< 8px）：算点击，不左划
    head.fire("pointerdown", { button: 0, clientX: 200, clientY: 10, pointerId: 2 });
    head.fire("pointermove", { clientX: 196, clientY: 10, pointerId: 2 });
    head.fire("pointerup", { pointerId: 2 });
    assert(!hasCls(cards(env)[0], "tp-card--swiped"), "小幅移动不算左划");

    // 竖向为主：当作滚动，不左划
    head.fire("pointerdown", { button: 0, clientX: 200, clientY: 10, pointerId: 3 });
    head.fire("pointermove", { clientX: 198, clientY: 40, pointerId: 3 });
    head.fire("pointermove", { clientX: 120, clientY: 42, pointerId: 3 });
    head.fire("pointerup", { pointerId: 3 });
    assert(!hasCls(cards(env)[0], "tp-card--swiped"), "竖着划不会露出删除");
    ok("小幅移动和竖向滑动都不会误触左划");

    // 向左划过一半：停在露出删除状态
    head.fire("pointerdown", { button: 0, clientX: 200, clientY: 10, pointerId: 4 });
    head.fire("pointermove", { clientX: 150, clientY: 11, pointerId: 4 });
    const bar = collect(cards(env)[0], "tp-swipe__bar")[0];
    assert.equal(bar.style.transform, "translateX(-50px)", "跟手位移");
    head.fire("pointermove", { clientX: 100, clientY: 11, pointerId: 4 });
    assert.equal(bar.style.transform, "translateX(-76px)", "位移不超过删除按钮宽度");
    head.fire("pointerup", { pointerId: 4 });
    const card0 = cards(env)[0];
    const del = collect(card0, "tp-swipe__delete")[0];
    assert(hasCls(card0, "tp-card--swiped"), "松手后停在露出删除状态");
    assert.equal(del.attrs.tabindex, "0", "露出后删除按钮可聚焦");
    // 划完紧跟的那次 click 不当成折叠
    head.click();
    assert.equal(collapsedCount(env), 0, "划完的 click 不触发折叠");
    ok("向左划露出删除按钮");

    // 向右划回去：收起
    head.fire("pointerdown", { button: 0, clientX: 100, clientY: 10, pointerId: 5 });
    head.fire("pointermove", { clientX: 170, clientY: 10, pointerId: 5 });
    head.fire("pointerup", { pointerId: 5 });
    assert(!hasCls(cards(env)[0], "tp-card--swiped"), "向右划回去收起删除按钮");
    ok("向右划回去收起删除按钮");

    // 再划开，点删除：卡片被移除
    const goneId = cards(env)[0]._tpId;
    head.fire("pointerdown", { button: 0, clientX: 200, clientY: 10, pointerId: 6 });
    head.fire("pointermove", { clientX: 110, clientY: 10, pointerId: 6 });
    head.fire("pointerup", { pointerId: 6 });
    collect(cards(env)[0], "tp-swipe__delete")[0].click();
    await tick();
    assert.equal(cards(env).length, 2, "点删除后少一张");
    assert(!cards(env).some((c) => c._tpId === goneId), "被删的那张不在了");
    ok("左划后点删除移除卡片");
  }

  /* ---------------- 实时模式（假 bridge）：title 即真实会话名、运行中/已结束 ---------------- */
  {
    let removeArg = null;
    const now = Date.UTC(2026, 8, 28, 12, 0, 0);
    const payload = {
      ok: true, seq: 10, liveSig: "sA|会话甲真名|1|-|1/2|c;sB|会话乙真名|0|completed|1/1|c", hostAvailable: true, now: now, locale: "zh-CN",
      sessions: [
        { id: "sA", title: "会话甲真名", tasks: [{ text: "a1", status: "done" }, { text: "a2", status: "doing" }], summary: { total: 2, done: 1, doing: 1, blocked: 0, todo: 0 }, createdAt: now - 60000, updatedAt: now - 60000, updates: 3, running: true, endedAt: null, endReason: null, noChecklist: false },
        { id: "sB", title: "会话乙真名", tasks: [{ text: "b1", status: "done" }], summary: { total: 1, done: 1, doing: 0, blocked: 0, todo: 0 }, createdAt: now - 50 * 60000, updatedAt: now - 50 * 60000, updates: 2, running: false, endedAt: now - 40 * 60000, endReason: "completed", noChecklist: false },
      ],
    };
    const bridge = {
      invoke: (channel, arg) => {
        if (channel === "app.getLocale") return Promise.resolve({ ok: true, locale: "zh-CN" });
        if (channel === "task.pull") return Promise.resolve(payload);
        if (channel === "task.remove") { removeArg = arg; return Promise.resolve({ ok: true }); }
        return Promise.resolve({ ok: true });
      },
    };
    const env = makeEnv(bridge);
    await tick();
    await tick();

    assert(allText(env.ids["tp-meta"]).indexOf("实时") >= 0, "meta 显示实时");
    const cs = cards(env);
    assert.equal(cs.length, 2, "实时模式渲染两张卡片");
    const titles = collect(env.ids["tp-root"], "tp-card__title").map(allText);
    assert(titles.some((t) => t.indexOf("会话甲真名") >= 0), "卡片标题用真实会话名");
    assert(titles.some((t) => t.indexOf("会话乙真名") >= 0), "另一张卡片标题用真实会话名");
    ok("实时模式渲染卡片、标题即真实会话名");

    assert(allText(cs[0]).indexOf("运行中") >= 0, "会话甲显示运行中");
    assert(allText(cs[1]).indexOf("已结束") >= 0, "会话乙显示本轮已结束");
    ok("卡片显示运行中 / 本轮已结束状态");

    collect(cs[1], "tp-card__remove")[0].click();
    await tick();
    assert(removeArg && removeArg.id === "sB", "task.remove 传对 id");
    ok("实时模式移除卡片调 task.remove 带 id");
  }

  /* ---------------- 实时模式：noChecklist 会话（正在运行但没推清单） ---------------- */
  {
    const now = Date.UTC(2026, 8, 28, 12, 0, 0);
    const payload = {
      ok: true, seq: 0, liveSig: "sNew|选择软件版本|1|-|0/0|n", hostAvailable: true, now: now, locale: "zh-CN",
      sessions: [
        { id: "sNew", title: "选择软件版本", tasks: [], summary: { total: 0, done: 0, doing: 0, blocked: 0, todo: 0 }, createdAt: now - 60000, updatedAt: now - 60000, updates: 0, running: true, endedAt: null, endReason: null, noChecklist: true },
      ],
    };
    const bridge = {
      invoke: (channel) => {
        if (channel === "app.getLocale") return Promise.resolve({ ok: true, locale: "zh-CN" });
        if (channel === "task.pull") return Promise.resolve(payload);
        return Promise.resolve({ ok: true });
      },
    };
    const env = makeEnv(bridge);
    await tick();
    await tick();
    const cs = cards(env);
    assert.equal(cs.length, 1, "渲染一张卡");
    assert(allText(cs[0]).indexOf("选择软件版本") >= 0, "用真实会话名");
    assert(allText(cs[0]).indexOf("还没推送清单") >= 0, "显示 noChecklist 占位说明");
    assert(allText(cs[0]).indexOf("运行中") >= 0, "显示运行中");
    ok("noChecklist 运行会话：真实名 + 占位说明 + 运行中");
  }

  /* ---------------- 实时模式：running 但久未更新 -> stale ---------------- */
  {
    const now = Date.UTC(2026, 8, 28, 12, 0, 0);
    const payload = {
      ok: true, seq: 3, liveSig: "sStale|卡住的会话|1|-|0/1|c", hostAvailable: true, now: now, locale: "zh-CN",
      sessions: [
        { id: "sStale", title: "卡住的会话", tasks: [{ text: "t", status: "doing" }], summary: { total: 1, done: 0, doing: 1, blocked: 0, todo: 0 }, createdAt: now - 60 * 60000, updatedAt: now - 45 * 60000, updates: 5, running: true, endedAt: null, endReason: null, noChecklist: false },
      ],
    };
    const bridge = {
      invoke: (channel) => {
        if (channel === "app.getLocale") return Promise.resolve({ ok: true, locale: "zh-CN" });
        if (channel === "task.pull") return Promise.resolve(payload);
        return Promise.resolve({ ok: true });
      },
    };
    const env = makeEnv(bridge);
    await tick();
    await tick();
    assert.equal(collect(env.ids["tp-root"], "tp-card--stale").length, 1, "running 但久未更新 -> stale 卡片");
    assert.equal(collect(env.ids["tp-root"], "tp-card__stale").length, 1, "显示 stale 提醒文案");
    ok("running 但久未更新（有清单）的会话标 stale 并提醒");
  }

  /* ---------------- 实时模式：liveSig 变化触发重渲染（seq 不变也重渲） ---------------- */
  {
    const now = Date.UTC(2026, 8, 28, 12, 0, 0);
    let payload = {
      ok: true, seq: 5, liveSig: "sX|旧名字|1|-|0/1|c", hostAvailable: true, now: now, locale: "zh-CN",
      sessions: [
        { id: "sX", title: "旧名字", tasks: [{ text: "t", status: "doing" }], summary: { total: 1, done: 0, doing: 1, blocked: 0, todo: 0 }, createdAt: now - 60000, updatedAt: now - 60000, updates: 1, running: true, endedAt: null, endReason: null, noChecklist: false },
      ],
    };
    let pulls = 0;
    const bridge = {
      invoke: (channel) => {
        if (channel === "app.getLocale") return Promise.resolve({ ok: true, locale: "zh-CN" });
        if (channel === "task.pull") { pulls += 1; return Promise.resolve(payload); }
        return Promise.resolve({ ok: true });
      },
    };
    const env = makeEnv(bridge);
    await tick();
    await tick();
    assert(allText(env.ids["tp-root"]).indexOf("旧名字") >= 0, "先渲染旧名字");

    // seq 不变，仅改名（liveSig 变）——手动触发一次 poll 定时器
    payload = {
      ok: true, seq: 5, liveSig: "sX|新名字|1|-|0/1|c", hostAvailable: true, now: now, locale: "zh-CN",
      sessions: [
        { id: "sX", title: "新名字", tasks: [{ text: "t", status: "doing" }], summary: { total: 1, done: 0, doing: 1, blocked: 0, todo: 0 }, createdAt: now - 60000, updatedAt: now - 60000, updates: 1, running: true, endedAt: null, endReason: null, noChecklist: false },
      ],
    };
    const pollTimer = env.timers.find((x) => x.ms === 700);
    assert(pollTimer, "存在 700ms 轮询定时器");
    await pollTimer.fn();
    await tick();
    assert(allText(env.ids["tp-root"]).indexOf("新名字") >= 0, "seq 未变、liveSig 变 -> 跟上新名字");
    assert(allText(env.ids["tp-root"]).indexOf("旧名字") < 0, "旧名字已被替换");
    ok("seq 不变但 liveSig 变化（改名/状态）也触发重渲染");
  }

  /* ---------------- 实时模式：pull 失败显示通道错误 ---------------- */
  {
    const bridge = {
      invoke: (channel) => {
        if (channel === "app.getLocale") return Promise.resolve({ ok: true, locale: "zh-CN" });
        return Promise.reject(new Error("boom"));
      },
    };
    const env = makeEnv(bridge);
    await tick();
    await tick();
    assert(allText(env.ids["tp-meta"]).indexOf("通道错误") >= 0, "pull 失败显示通道错误");
    ok("pull 失败降级为通道错误");
  }

  console.log("\n全部通过：" + passed + " 项");
})().catch((e) => {
  console.error("测试失败：", e && e.stack ? e.stack : e);
  process.exit(1);
});
