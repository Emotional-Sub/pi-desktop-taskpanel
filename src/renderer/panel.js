/*
 * 任务清单面板渲染器（v0.5，手风琴：多会话同时显示、各自可折叠）。
 *
 * v0.5：卡片左侧手柄可拖动排序（也可聚焦手柄按 ↑/↓），顺序存 localStorage，
 *   新出现的会话排在最前；卡片头向左划露出「删除」按钮。拖动 / 左划进行中暂停重渲染，
 *   期间到达的新数据在手势结束后再应用，避免手底下的 DOM 被换掉。
 * v0.5.1：拖动的移动改在 window 上监听、换位后重新抓指针捕获，一次按住可连续换位；
 *   卡片跟手、拖到边缘自动滚动，松手事件丢失时自动收尾。
 *
 * 与插件进程（唯一数据源）的约定：
 *   task.pull -> { ok, seq, liveSig, hostAvailable, now, locale, version,
 *                  sessions:[ { id, title, tasks:[{text,status,note?}], summary,
 *                               createdAt, updatedAt, updates, running,
 *                               endedAt, endReason, legacy, noChecklist } ] }
 *   task.remove { id }   // 移除某会话卡片
 *   task.clear           // 清空全部
 *   app.getLocale
 *
 * v0.4：卡片标题 title 已是「真实会话名」（插件直读 pi.sqlite 拿的，改名自动跟上），
 *   拿不到才回退成模型清单名。running/结束状态也以 sqlite 为准。
 *   noChecklist=true 的卡片是「正在运行但还没推清单」的会话，只显示标题+运行中。
 *   重渲染判定：seq（清单版本）或 liveSig（标题/状态/进度/卡片集合）任一变化即重渲染，
 *   所以会话改名、状态变化、新会话出现都能实时反映，不再依赖 seq 单独变化。
 *   折叠状态存 localStorage，跨重渲染保留。
 * 所有来自状态的文本都用 textContent 写入（不用 innerHTML）。无依赖、无构建、无网络。
 *
 * 浏览器预览兜底：没有 window.pluginBridge 时渲染内置示例（两个会话）。
 */
(function () {
  "use strict";

  var POLL_MS = 700;
  var CLOCK_MS = 20000; // 定时刷新「x 分钟前更新」这类相对时间
  var STALE_MS = 10 * 60 * 1000; // 运行中但超过 10 分钟没更新 -> 标黄提示「可能没在推进度」
  var COLLAPSE_KEY = "tp.collapsed";
  var ORDER_KEY = "tp.order"; // 手动拖动后的卡片顺序（会话 id 数组）
  var SWIPE_W = 76; // 左划露出的删除按钮宽度（px）
  var SWIPE_SLOP = 8; // 横向移动超过这么多才算左划，否则算点击
  var DRAG_EDGE = 48; // 拖到列表上 / 下边缘这么近就自动滚动（px）
  var DRAG_SPEED = 18; // 自动滚动最快每帧滚多少（px）

  var STRINGS = {
    en: {
      brand: "Tasks",
      metaLive: "Live",
      metaDemo: "Demo data",
      metaError: "Channel error",
      countTasks: "{n} tasks",
      countTask: "1 task",
      progress: "{done}/{total} done",
      legendDoing: "in progress",
      legendTodo: "todo",
      legendBlocked: "blocked",
      emptyTitle: "No tasks yet",
      emptyBody: "When an agent starts a multi-step task it pushes its plan here. Each conversation gets its own card.",
      statusDoing: "doing",
      statusBlocked: "blocked",
      running: "running",
      ended: "turn ended",
      endedAborted: "turn aborted",
      endedError: "ended with error",
      updatedJustNow: "updated just now",
      updatedMin: "updated {n} min ago",
      updatedHour: "updated {n} h ago",
      updatedDay: "updated {n} d ago",
      staleWarn: "No update for {label} — the agent may not be pushing progress.",
      noChecklist: "Running — no checklist pushed yet.",
      remove: "Remove",
      removeTitle: "Remove this card",
      collapseAll: "Collapse all",
      expandAll: "Expand all",
      pushes: " pushes",
      dragHandle: "Drag to reorder (or focus and press ↑/↓)",
      swipeDelete: "Delete",
      swipeDeleteTitle: "Delete this card",
      resetOrder: "Default order",
      resetOrderTitle: "Back to the automatic order (running first, then most recent)",
    },
    "zh-CN": {
      brand: "任务清单",
      metaLive: "实时",
      metaDemo: "示例数据",
      metaError: "通道错误",
      countTasks: "{n} 个任务",
      countTask: "1 个任务",
      progress: "{done}/{total} 已完成",
      legendDoing: "进行中",
      legendTodo: "待办",
      legendBlocked: "受阻",
      emptyTitle: "还没有任务",
      emptyBody: "Agent 开始多步任务时会把计划推到这里，每个对话有自己的一张卡片。",
      statusDoing: "进行中",
      statusBlocked: "受阻",
      running: "运行中",
      ended: "本轮已结束",
      endedAborted: "本轮已中止",
      endedError: "本轮出错结束",
      updatedJustNow: "刚刚更新",
      updatedMin: "{n} 分钟前更新",
      updatedHour: "{n} 小时前更新",
      updatedDay: "{n} 天前更新",
      staleWarn: "已 {label} 没更新，Agent 可能没在推送进度。",
      noChecklist: "正在运行 —— 还没推送清单。",
      remove: "移除",
      removeTitle: "移除这张卡片",
      collapseAll: "全部折叠",
      expandAll: "全部展开",
      pushes: " 次推送",
      dragHandle: "拖动调整顺序（也可聚焦后按 ↑/↓）",
      swipeDelete: "删除",
      swipeDeleteTitle: "删除这张卡片",
      resetOrder: "默认排序",
      resetOrderTitle: "恢复自动排序（运行中优先，其次按最近更新）",
    },
  };

  var LANG_KEY = "tp.lang";
  var lang = readLang(); // 默认中文；用户切换后记住选择，不跟随宿主 locale
  function readLang() {
    try {
      var saved = window.localStorage.getItem(LANG_KEY);
      if (saved === "zh-CN" || saved === "en") return saved;
    } catch (e) {
      /* localStorage 被禁用时退化为默认 */
    }
    return "zh-CN"; // 默认中文
  }
  function persistLang() {
    try {
      window.localStorage.setItem(LANG_KEY, lang);
    } catch (e) {
      /* 隐私模式等禁用 localStorage 时退化为内存 */
    }
  }
  function setLang(next) {
    lang = next === "en" ? "en" : "zh-CN";
    persistLang();
    document.documentElement.lang = lang;
    // demo 模式清单文本按语言重建；live 模式内容来自模型/sqlite，只需重渲染界面文案
    if (!bridge) {
      lastKey = "\x00";
      apply(demoState(), "demo", true);
    } else {
      renderAll();
    }
  }
  function toggleLang() {
    setLang(lang === "zh-CN" ? "en" : "zh-CN");
  }
  function t(key) {
    var table = STRINGS[lang] || STRINGS["zh-CN"];
    return table[key] != null ? table[key] : STRINGS.en[key] != null ? STRINGS.en[key] : key;
  }
  function fmt(key, vars) {
    return t(key).replace(/\{(\w+)\}/g, function (m, name) {
      return vars && vars[name] != null ? String(vars[name]) : m;
    });
  }

  var bridge =
    window.pluginBridge && typeof window.pluginBridge.invoke === "function" ? window.pluginBridge : null;

  var els = {
    title: document.getElementById("tp-title"),
    count: document.getElementById("tp-count"),
    meta: document.getElementById("tp-meta"),
    toggleAll: document.getElementById("tp-toggle-all"),
    langBtn: document.getElementById("tp-lang"),
    resetOrder: document.getElementById("tp-reset-order"),
    header: document.getElementById("tp-header"),
    root: document.getElementById("tp-root"),
    status: document.getElementById("tp-status"),
  };

  var lastKey = "\x00"; // seq + liveSig + mode 的组合签名，变了才重渲染
  var lastMode = "";
  var sessions = []; // 最近数据快照
  var collapsed = readCollapsed(); // { sessionId: 1 } 折叠状态
  var demoDismissed = {}; // 演示模式下被移除的会话
  var serverNow = Date.now();
  var localAtPull = Date.now();
  var rawSessions = []; // 插件给的原始顺序（运行中优先、最近更新在前）
  var manualOrder = readOrder(); // 拖动后的顺序；空数组 = 用自动顺序
  var gesture = null; // 进行中的拖动 / 左划
  var pendingState = null; // 手势进行中到达的新数据，结束后再应用
  var openSwipeId = null; // 当前露出删除按钮的卡片
  var suppressClickUntil = 0; // 左划刚结束时吞掉随后的那次 click，避免误触折叠

  /* ------------------------------------------------------------- helpers */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }
  function normStatus(status) {
    if (status === "done" || status === "doing" || status === "blocked") return status;
    return "todo";
  }

  function readCollapsed() {
    try {
      var raw = window.localStorage.getItem(COLLAPSE_KEY);
      var o = raw ? JSON.parse(raw) : null;
      return o && typeof o === "object" ? o : {};
    } catch (e) {
      return {};
    }
  }
  function persistCollapsed() {
    try {
      window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed));
    } catch (e) {
      /* 隐私模式等禁用 localStorage 时退化为内存 */
    }
  }
  function isCollapsed(id) {
    return !!collapsed[id];
  }
  function setCollapsed(id, val) {
    if (val) collapsed[id] = 1;
    else delete collapsed[id];
    persistCollapsed();
  }
  function toggleCollapse(id) {
    setCollapsed(id, !isCollapsed(id));
    renderAll();
  }

  /* ------------------------------------------------------------- order */

  function readOrder() {
    try {
      var raw = window.localStorage.getItem(ORDER_KEY);
      var arr = raw ? JSON.parse(raw) : null;
      if (!Array.isArray(arr)) return [];
      return arr.filter(function (x) {
        return typeof x === "string" && x;
      });
    } catch (e) {
      return [];
    }
  }
  function persistOrder() {
    try {
      if (manualOrder.length) window.localStorage.setItem(ORDER_KEY, JSON.stringify(manualOrder));
      else window.localStorage.removeItem(ORDER_KEY);
    } catch (e) {
      /* localStorage 不可用时退化为内存 */
    }
  }
  // 按手动顺序排；手动顺序里没有的（新出现的会话）排在最前，彼此保持自动顺序
  function orderSessions(list) {
    if (!manualOrder.length) return list.slice();
    var pos = {};
    for (var i = 0; i < manualOrder.length; i++) pos[manualOrder[i]] = i;
    var fresh = [];
    var known = [];
    for (var j = 0; j < list.length; j++) {
      if (pos[list[j].id] == null) fresh.push(list[j]);
      else known.push(list[j]);
    }
    known.sort(function (a, b) {
      return pos[a.id] - pos[b.id];
    });
    return fresh.concat(known);
  }
  function setManualOrder(ids) {
    manualOrder = ids.slice();
    persistOrder();
    sessions = orderSessions(rawSessions);
    renderAll();
  }
  function hasClass(node, cls) {
    return (" " + (node.className || "") + " ").indexOf(" " + cls + " ") >= 0;
  }
  function setClass(node, cls, on) {
    var has = hasClass(node, cls);
    if (on && !has) node.className = (node.className + " " + cls).trim();
    if (!on && has) node.className = (" " + node.className + " ").replace(" " + cls + " ", " ").trim();
  }

  // 估算「现在」：用服务端 now + 本地流逝，避免两端时钟差
  function nowEstimate() {
    return serverNow + (Date.now() - localAtPull);
  }

  function relTime(updatedAt) {
    if (!updatedAt) return "";
    var diff = Math.max(0, nowEstimate() - updatedAt);
    var min = Math.floor(diff / 60000);
    if (min < 1) return t("updatedJustNow");
    if (min < 60) return fmt("updatedMin", { n: min });
    var hr = Math.floor(min / 60);
    if (hr < 24) return fmt("updatedHour", { n: hr });
    return fmt("updatedDay", { n: Math.floor(hr / 24) });
  }

  function staleLabel(updatedAt) {
    var diff = Math.max(0, nowEstimate() - updatedAt);
    var min = Math.floor(diff / 60000);
    if (min < 60) return min + (lang === "zh-CN" ? " 分钟" : " min");
    var hr = Math.floor(min / 60);
    if (hr < 24) return hr + (lang === "zh-CN" ? " 小时" : " h");
    return Math.floor(hr / 24) + (lang === "zh-CN" ? " 天" : " d");
  }

  // 会话活跃状态：running / stale（运行中但久未更新）/ ended / idle
  // noChecklist 会话（正在运行但没推清单）恒为 running，不判 stale（没清单谈不上"没推进度"）。
  function liveness(s) {
    if (s.noChecklist) return "running";
    var age = nowEstimate() - (s.updatedAt || 0);
    if (s.running) return age > STALE_MS ? "stale" : "running";
    if (s.endedAt) return "ended";
    return "idle";
  }

  function endedLabel(s) {
    var r = String(s.endReason || "").toLowerCase();
    if (r.indexOf("abort") >= 0 || r.indexOf("cancel") >= 0) return t("endedAborted");
    if (r.indexOf("error") >= 0 || r.indexOf("fail") >= 0) return t("endedError");
    return t("ended");
  }

  // v0.4：title 已是真实会话名（插件端从 pi.sqlite 读的），拿不到才回退
  function cardName(s) {
    return s.title || t("brand");
  }

  /* ------------------------------------------------------------- render */

  function renderMeta(mode) {
    clear(els.meta);
    els.meta.appendChild(el("span", "tp-meta__dot tp-meta__dot--" + mode));
    var label = mode === "error" ? t("metaError") : mode === "demo" ? t("metaDemo") : t("metaLive");
    els.meta.appendChild(el("span", null, label));
  }

  function anyExpanded() {
    for (var i = 0; i < sessions.length; i++) {
      if (!isCollapsed(sessions[i].id)) return true;
    }
    return false;
  }

  function renderToggleAll() {
    if (!els.toggleAll) return;
    if (sessions.length < 2) {
      els.toggleAll.hidden = true;
      return;
    }
    els.toggleAll.hidden = false;
    var label = anyExpanded() ? t("collapseAll") : t("expandAll");
    els.toggleAll.textContent = label;
    els.toggleAll.setAttribute("aria-label", label);
  }

  // 中 / 英切换按钮：显示可切到的目标语言
  function renderLangBtn() {
    if (!els.langBtn) return;
    els.langBtn.textContent = lang === "zh-CN" ? "EN" : "中";
    var label = lang === "zh-CN" ? "Switch to English" : "切换到中文";
    els.langBtn.title = label;
    els.langBtn.setAttribute("aria-label", label);
  }

  // 「默认排序」按钮：只在拖过（有手动顺序）且卡片 ≥2 张时出现
  function renderResetOrder() {
    if (!els.resetOrder) return;
    els.resetOrder.hidden = !(manualOrder.length && sessions.length > 1);
    els.resetOrder.textContent = t("resetOrder");
    els.resetOrder.title = t("resetOrderTitle");
    els.resetOrder.setAttribute("aria-label", t("resetOrderTitle"));
  }

  // 进度条 + 图例，构建并返回一个节点（每张卡片各一份）
  function renderProgress(summary) {
    var wrap = el("div", "tp-card__progress");
    var bar = el("div", "tp-progress__bar");
    var fill = el("span", "tp-progress__fill");
    var pct = summary.total ? Math.round((summary.done / summary.total) * 100) : 0;
    fill.style.width = pct + "%";
    bar.appendChild(fill);
    wrap.appendChild(bar);

    var legend = el("div", "tp-progress__legend");
    legend.appendChild(
      el("strong", "tp-progress__count", fmt("progress", { done: summary.done, total: summary.total }))
    );
    var parts = [];
    if (summary.doing) parts.push([summary.doing, t("legendDoing"), "doing"]);
    if (summary.todo) parts.push([summary.todo, t("legendTodo"), "todo"]);
    if (summary.blocked) parts.push([summary.blocked, t("legendBlocked"), "blocked"]);
    for (var i = 0; i < parts.length; i++) {
      var chip = el("span", "tp-chip tp-chip--" + parts[i][2]);
      chip.appendChild(el("span", "tp-chip__num", String(parts[i][0])));
      chip.appendChild(el("span", null, " " + parts[i][1]));
      legend.appendChild(chip);
    }
    wrap.appendChild(legend);
    return wrap;
  }

  function markGlyph(status) {
    if (status === "done") return "\u2713";
    if (status === "blocked") return "\u2715";
    if (status === "doing") return "\u25CF";
    return "";
  }

  function renderTask(task) {
    var status = normStatus(task.status);
    var row = el("li", "tp-task tp-task--" + status);

    var box = el("span", "tp-task__box tp-task__box--" + status);
    var glyph = markGlyph(status);
    if (glyph) box.textContent = glyph;
    box.setAttribute("aria-hidden", "true");
    row.appendChild(box);

    var body = el("div", "tp-task__body");
    body.appendChild(el("span", "tp-task__text", task.text || ""));
    if (task.note) body.appendChild(el("span", "tp-task__note", task.note));
    row.appendChild(body);

    if (status === "doing" || status === "blocked") {
      row.appendChild(
        el("span", "tp-task__tag tp-task__tag--" + status, status === "doing" ? t("statusDoing") : t("statusBlocked"))
      );
    }
    return row;
  }

  // 单个会话 = 一张可折叠卡片
  function renderCard(s, mode) {
    var live = liveness(s);
    var isCol = isCollapsed(s.id);
    var card = el("section", "tp-card tp-card--" + live + (isCol ? " tp-card--collapsed" : "") + (s.noChecklist ? " tp-card--empty" : ""));

    var sm = s.summary || {};

    // 卡片头 = 左划容器：底下垫「删除」按钮，上面是可左右滑动的头部条
    var swipe = el("div", "tp-swipe");
    var del = el("button", "tp-swipe__delete", t("swipeDelete"));
    del.type = "button";
    del.title = t("swipeDeleteTitle");
    del.setAttribute("aria-label", t("swipeDeleteTitle"));
    del.setAttribute("tabindex", "-1"); // 收起时不可聚焦，露出后才能 Tab 到
    del.setAttribute("aria-hidden", "true");
    swipe.appendChild(del);

    var bar = el("div", "tp-swipe__bar");
    // 拖动手柄：按住拖动调整顺序；聚焦后按 ↑/↓ 也能挪
    var grip = el("span", "tp-card__grip", "\u22EE\u22EE"); // ⋮⋮
    grip.setAttribute("role", "button");
    grip.setAttribute("tabindex", "0");
    grip.title = t("dragHandle");
    grip.setAttribute("aria-label", cardName(s) + " — " + t("dragHandle"));
    bar.appendChild(grip);

    // 头部（点击折叠/展开；向左划露出删除）
    var head = el("button", "tp-card__head");
    head.type = "button";
    head.setAttribute("aria-expanded", isCol ? "false" : "true");
    head.appendChild(el("span", "tp-card__chevron", "\u203A")); // ›
    head.appendChild(el("span", "tp-card__dot tp-card__dot--" + live));
    head.appendChild(el("span", "tp-card__title", cardName(s)));
    // 无清单的运行会话不显示 0/0 计数，避免误导
    if (!s.noChecklist) {
      head.appendChild(el("span", "tp-card__count", (sm.done || 0) + "/" + (sm.total || 0)));
    }
    (function (id) {
      head.addEventListener("click", function () {
        if (Date.now() < suppressClickUntil) return; // 刚划完，不算点击
        if (openSwipeId) {
          closeSwipe(); // 有卡片露着删除按钮时，点一下先收起，不折叠
          return;
        }
        toggleCollapse(id);
      });
      del.addEventListener("click", function () {
        openSwipeId = null;
        removeSession(id, mode);
      });
    })(s.id);
    bar.appendChild(head);
    swipe.appendChild(bar);
    card.appendChild(swipe);

    // 卡片体（折叠时 CSS 隐藏）
    var body = el("div", "tp-card__body");

    var meta = el("div", "tp-card__meta");
    var timeText = relTime(s.updatedAt);
    if (s.updates > 1) timeText += " · " + s.updates + t("pushes");
    if (timeText) meta.appendChild(el("span", "tp-card__time", timeText));
    var stateText = live === "ended" ? endedLabel(s) : live === "running" || live === "stale" ? t("running") : "";
    if (stateText) {
      if (timeText) meta.appendChild(el("span", "tp-card__sep", "·"));
      meta.appendChild(el("span", "tp-card__state tp-card__state--" + live, stateText));
    }
    var rm = el("button", "tp-card__remove", t("remove"));
    rm.type = "button";
    rm.title = t("removeTitle");
    (function (id) {
      rm.addEventListener("click", function () {
        removeSession(id, mode);
      });
    })(s.id);
    meta.appendChild(rm);
    body.appendChild(meta);

    if (s.noChecklist) {
      // 正在运行但还没推清单：给一句占位说明
      body.appendChild(el("p", "tp-card__hint", t("noChecklist")));
    } else {
      if (sm.total) body.appendChild(renderProgress(s.summary));

      if (live === "stale") {
        body.appendChild(el("p", "tp-card__stale", fmt("staleWarn", { label: staleLabel(s.updatedAt) })));
      }

      var tasks = Array.isArray(s.tasks) ? s.tasks : [];
      var list = el("ul", "tp-list");
      for (var i = 0; i < tasks.length; i++) list.appendChild(renderTask(tasks[i]));
      body.appendChild(list);
    }

    card.appendChild(body);

    // 挂引用给手势用（不依赖 querySelector，测试里的 DOM 桩也能跑）
    card._tpId = s.id;
    card._tpBar = bar;
    card._tpDel = del;
    card._tpGrip = grip;
    if (openSwipeId === s.id) openSwipeCard(card); // 重渲染后保持露出状态
    bindSwipe(card, head);
    bindDrag(card, grip);
    return card;
  }

  /* ------------------------------------------------------------- gestures */

  // 拖动 / 左划进行中（「待定」阶段还不算，不挡重渲染）
  function busy() {
    return !!gesture && gesture.type !== "swipe-pending";
  }
  function cardNodes() {
    var out = [];
    var kids = (els.root && els.root.children) || [];
    for (var i = 0; i < kids.length; i++) if (kids[i] && kids[i]._tpId) out.push(kids[i]);
    return out;
  }
  function idsOf(nodes) {
    return nodes.map(function (n) {
      return n._tpId;
    });
  }
  function closeSwipe() {
    var nodes = cardNodes();
    for (var i = 0; i < nodes.length; i++) {
      if (hasClass(nodes[i], "tp-card--swiped")) {
        setClass(nodes[i], "tp-card--swiped", false);
        if (nodes[i]._tpBar) nodes[i]._tpBar.style.transform = "";
        nodes[i]._tpDel.setAttribute("tabindex", "-1");
        nodes[i]._tpDel.setAttribute("aria-hidden", "true");
      }
    }
    openSwipeId = null;
  }
  function openSwipeCard(card) {
    setClass(card, "tp-card--swiped", true);
    card._tpBar.style.transform = "";
    card._tpDel.setAttribute("tabindex", "0");
    card._tpDel.setAttribute("aria-hidden", "false");
    openSwipeId = card._tpId;
  }
  // 手势结束：补上期间被挡住的数据更新
  function flushPending() {
    if (busy()) return;
    if (pendingState) {
      var p = pendingState;
      pendingState = null;
      apply(p.state, p.mode, true);
    }
  }

  // 左划：在卡片头上按下后横向拖动，超过一半宽度松手就停在「露出删除」状态
  function bindSwipe(card, head) {
    head.addEventListener("pointerdown", function (e) {
      if (e && e.button != null && e.button !== 0) return; // 只认左键 / 触摸
      abortGesture(); // 上一个手势的松手事件丢了也不会卡死
      gesture = {
        type: "swipe-pending",
        card: card,
        x0: e.clientX,
        y0: e.clientY,
        base: hasClass(card, "tp-card--swiped") ? -SWIPE_W : 0,
        pid: e.pointerId,
      };
    });
    head.addEventListener("pointermove", function (e) {
      if (!gesture || gesture.card !== card) return;
      var dx = e.clientX - gesture.x0;
      var dy = e.clientY - gesture.y0;
      if (gesture.type === "swipe-pending") {
        if (Math.abs(dy) > SWIPE_SLOP && Math.abs(dy) > Math.abs(dx)) {
          gesture = null; // 竖向为主：当作滚动，放弃左划
          return;
        }
        if (Math.abs(dx) < SWIPE_SLOP) return;
        if (openSwipeId && openSwipeId !== card._tpId) closeSwipe(); // 同一时间只露一张
        gesture.type = "swipe";
        setClass(card, "tp-card--swiping", true);
        if (head.setPointerCapture && gesture.pid != null) {
          try {
            head.setPointerCapture(gesture.pid);
          } catch (err) {
            /* 拿不到捕获也能用，只是指针移出头部后跟手性差一点 */
          }
        }
      }
      if (gesture.type !== "swipe") return;
      var x = Math.max(-SWIPE_W, Math.min(0, gesture.base + dx));
      gesture.x = x;
      card._tpBar.style.transform = "translateX(" + x + "px)";
    });
    head.addEventListener("pointerup", endSwipe);
    head.addEventListener("pointercancel", endSwipe);
  }
  function endSwipe() {
    if (!gesture || (gesture.type !== "swipe" && gesture.type !== "swipe-pending")) return;
    var g = gesture;
    gesture = null;
    if (g.type === "swipe") {
      suppressClickUntil = Date.now() + 350; // 划完紧跟的 click 不当成折叠
      setClass(g.card, "tp-card--swiping", false);
      var x = g.x != null ? g.x : g.base;
      if (x <= -SWIPE_W / 2) openSwipeCard(g.card);
      else {
        closeSwipe();
        g.card._tpBar.style.transform = ""; // 没划够一半：弹回原位
      }
    }
    flushPending();
  }

  // 拖动排序：按住手柄上下拖，越过相邻卡片中线就换位；松手后记住顺序
  function bindDrag(card, grip) {
    grip.addEventListener("pointerdown", function (e) {
      if (e && e.button != null && e.button !== 0) return;
      abortGesture(); // 上一次的松手事件丢了（比如在窗口外松开）也能接着拖
      if (e && e.preventDefault) e.preventDefault(); // 别选中文字
      closeSwipe();
      var r0 = card.getBoundingClientRect();
      gesture = {
        type: "drag",
        card: card,
        grip: grip,
        before: idsOf(cardNodes()),
        pid: e.pointerId,
        y: e.clientY,
        grabOffset: e.clientY - r0.top, // 按在卡片上的哪个位置，跟手时保持不变
        dy: 0,
        timer: null,
      };
      setClass(card, "tp-card--dragging", true);
      bodyClass("tp-dragging-body", true);
      captureGrip(gesture);
    });
    // 移动不挂在手柄上，而是在 window 上统一处理（见 start）：
    // 卡片一换位节点就被挪动，浏览器会释放手柄上的指针捕获，
    // 只靠手柄收事件的话指针一离开手柄就再也拖不动了。
    grip.addEventListener("pointerup", endDrag);
    grip.addEventListener("pointercancel", endDrag);
    // 键盘：聚焦手柄后 ↑ / ↓ 挪一位
    grip.addEventListener("keydown", function (e) {
      var k = e && e.key;
      if (k !== "ArrowUp" && k !== "ArrowDown") return;
      if (e.preventDefault) e.preventDefault();
      moveCardBy(card._tpId, k === "ArrowUp" ? -1 : 1);
    });
  }
  // （重新）抓住手柄的指针捕获：卡片节点被挪动后浏览器会释放它，换位后要再抓一次
  function captureGrip(g) {
    if (!g || !g.grip || !g.grip.setPointerCapture || g.pid == null) return;
    try {
      g.grip.setPointerCapture(g.pid);
    } catch (err) {
      /* 拿不到捕获也没关系：移动在 window 上监听，照样能拖 */
    }
  }
  // 拖动中指针移动（window 级，一次按住可以连续换位多次）
  function dragMove(e) {
    var g = gesture;
    if (!g || g.type !== "drag") return;
    if (g.pid != null && e.pointerId != null && e.pointerId !== g.pid) return; // 只认按下手柄的那根指针
    if (e.pointerType === "mouse" && e.buttons === 0) {
      endDrag(); // 鼠标在窗口外松开、没收到 pointerup：按松手处理
      return;
    }
    if (typeof e.clientY !== "number") return;
    g.y = e.clientY;
    dragReorder(g);
    followPointer(g);
    autoScroll(g);
  }
  // 指针越过相邻卡片中线就把被拖的卡片挪过去
  function dragReorder(g) {
    var nodes = cardNodes();
    var from = nodes.indexOf(g.card);
    if (from < 0) return;
    var target = null; // 插到它前面；null = 放到最后
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i] === g.card) continue;
      var r = nodes[i].getBoundingClientRect();
      if (g.y < r.top + r.height / 2) {
        target = nodes[i];
        break;
      }
    }
    var to = target ? nodes.indexOf(target) : nodes.length;
    if (to === from || to === from + 1) return; // 落点就是原位
    if (target) els.root.insertBefore(g.card, target);
    else els.root.appendChild(g.card);
    captureGrip(g);
  }
  // 被拖的卡片跟着指针走（只是视觉位移，不影响其它卡片的布局）
  function followPointer(g) {
    var r = g.card.getBoundingClientRect();
    var naturalTop = r.top - (g.dy || 0); // 去掉当前位移后的原位
    g.dy = g.y - g.grabOffset - naturalTop;
    g.card.style.transform = g.dy ? "translateY(" + g.dy + "px)" : "";
  }
  // 拖到列表上 / 下边缘时自动滚动，并在滚动中继续换位，长列表也能一路拖到底
  function autoScroll(g) {
    if (g.timer || !autoStep(g)) return;
    g.timer = setInterval(function () {
      if (gesture !== g) {
        clearInterval(g.timer);
        g.timer = null;
        return;
      }
      var step = autoStep(g);
      if (!step || !scrollContentBy(step)) {
        clearInterval(g.timer);
        g.timer = null;
        return;
      }
      dragReorder(g);
      followPointer(g);
    }, 16);
  }
  function autoStep(g) {
    var rr = els.root && els.root.getBoundingClientRect ? els.root.getBoundingClientRect() : null;
    if (!rr) return 0;
    var top = rr.top;
    var bottom = rr.bottom;
    if (els.header && els.header.getBoundingClientRect) {
      top = Math.max(top, els.header.getBoundingClientRect().bottom); // 吸顶表头盖住的部分不算
    }
    var vh = window.innerHeight;
    if (typeof vh === "number" && vh > 0) bottom = Math.min(bottom, vh);
    top = Math.max(top, 0);
    if (g.y < top + DRAG_EDGE) return -Math.ceil(DRAG_SPEED * Math.min(1, (top + DRAG_EDGE - g.y) / DRAG_EDGE));
    if (g.y > bottom - DRAG_EDGE) return Math.ceil(DRAG_SPEED * Math.min(1, (g.y - (bottom - DRAG_EDGE)) / DRAG_EDGE));
    return 0;
  }
  // 先滚卡片列表自己，滚不动再滚整页；返回是否真的滚动了
  function scrollContentBy(step) {
    var boxes = [els.root, document.scrollingElement || document.documentElement];
    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      if (!b || typeof b.scrollTop !== "number") continue;
      if (!(b.scrollHeight > b.clientHeight)) continue;
      var before = b.scrollTop;
      b.scrollTop = before + step;
      if (b.scrollTop !== before) return true;
    }
    return false;
  }
  function bodyClass(cls, on) {
    var body = document.body;
    if (!body) return;
    if (typeof body.className !== "string") body.className = "";
    setClass(body, cls, on);
  }
  // 结束任何残留的手势（上一次的松手事件丢了时，按下新手势前先收尾，避免面板卡死）
  function abortGesture() {
    if (!gesture) return;
    if (gesture.type === "drag") endDrag();
    else endSwipe();
  }
  function endDrag() {
    if (!gesture || gesture.type !== "drag") return;
    var g = gesture;
    gesture = null;
    if (g.timer) {
      clearInterval(g.timer);
      g.timer = null;
    }
    setClass(g.card, "tp-card--dragging", false);
    bodyClass("tp-dragging-body", false);
    g.card.style.transform = ""; // 松手回到列表里的位置
    var after = idsOf(cardNodes());
    if (after.join("|") !== g.before.join("|")) suppressClickUntil = Date.now() + 350; // 拖完紧跟的 click 不当成折叠
    if (pendingState) {
      if (after.join("\n") !== g.before.join("\n")) {
        manualOrder = after;
        persistOrder();
      }
      flushPending(); // 用新数据 + 新顺序一起重渲染
    } else if (after.join("\n") !== g.before.join("\n")) {
      setManualOrder(after);
    }
  }
  function moveCardBy(id, delta) {
    var ids = sessions.map(function (s) {
      return s.id;
    });
    var i = ids.indexOf(id);
    var j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return;
    ids.splice(i, 1);
    ids.splice(j, 0, id);
    setManualOrder(ids);
    // 重渲染后焦点还留在同一张卡片的手柄上，方便连续按
    var nodes = cardNodes();
    for (var n = 0; n < nodes.length; n++) {
      if (nodes[n]._tpId === id && nodes[n]._tpGrip && nodes[n]._tpGrip.focus) nodes[n]._tpGrip.focus();
    }
  }

  function renderEmpty() {
    clear(els.root);
    var wrap = el("div", "tp-empty");
    wrap.appendChild(el("div", "tp-empty__mark"));
    wrap.appendChild(el("h2", "tp-empty__title", t("emptyTitle")));
    wrap.appendChild(el("p", "tp-empty__body", t("emptyBody")));
    els.root.appendChild(wrap);
  }

  function renderAll() {
    if (busy()) return; // 拖动 / 左划进行中不重建 DOM，结束后再补
    var mode = lastMode || "live";
    renderMeta(mode);
    els.title.textContent = t("brand");
    if (els.count) {
      els.count.textContent = !sessions.length
        ? ""
        : sessions.length === 1
        ? t("countTask")
        : fmt("countTasks", { n: sessions.length });
    }
    renderToggleAll();
    renderLangBtn();
    renderResetOrder();

    clear(els.root);
    if (!sessions.length) {
      renderEmpty();
      els.status.textContent = t("emptyTitle");
      return;
    }
    for (var i = 0; i < sessions.length; i++) els.root.appendChild(renderCard(sessions[i], mode));

    // 屏幕阅读器摘要：任务数 + 最近一张卡片进度
    var top = sessions[0];
    var sm = top.summary || {};
    els.status.textContent =
      (sessions.length === 1 ? t("countTask") : fmt("countTasks", { n: sessions.length })) +
      " — " +
      cardName(top) +
      " " +
      fmt("progress", { done: sm.done || 0, total: sm.total || 0 });
  }

  /* ------------------------------------------------------------- remove */

  function removeSession(id, mode) {
    if (bridge && mode !== "demo") {
      bridge.invoke("task.remove", { id: id }).then(poll, poll);
    } else {
      demoDismissed[id] = true;
      apply(demoState(), "demo", true);
    }
  }

  /* ------------------------------------------------------------- poll */

  // 重渲染签名：清单版本 seq + 实时签名 liveSig + 模式。任一变化即重渲染。
  function stateKey(state, mode) {
    var seq = state && Number.isFinite(state.seq) ? state.seq : 0;
    var sig = state && typeof state.liveSig === "string" ? state.liveSig : "";
    return mode + "\x1f" + seq + "\x1f" + sig;
  }

  function apply(state, mode, force) {
    // 语言由面板自己管，不再跟随 state.locale
    document.documentElement.lang = lang;
    if (busy()) {
      pendingState = { state: state, mode: mode }; // 手势结束后再应用最新一份
      return;
    }
    var key = stateKey(state, mode);
    if (!force && key === lastKey) return;
    lastKey = key;
    lastMode = mode;
    serverNow = state && Number.isFinite(state.now) ? state.now : Date.now();
    localAtPull = Date.now();
    rawSessions = normalizeSessions(state);
    sessions = orderSessions(rawSessions);
    // 露着删除按钮的卡片已经不在了 -> 清掉状态
    if (openSwipeId && !sessions.some(function (s) { return s.id === openSwipeId; })) openSwipeId = null;
    renderAll();
  }

  // 把 pull 结果归一化成 sessions 数组；兼容旧版顶层单清单
  function normalizeSessions(state) {
    if (state && Array.isArray(state.sessions)) return state.sessions;
    if (state && Array.isArray(state.tasks) && state.tasks.length) {
      return [
        {
          id: "_single",
          title: state.title || t("brand"),
          tasks: state.tasks,
          summary: state.summary || null,
          updatedAt: state.updatedAt || nowEstimate(),
          updates: 1,
          running: false,
        },
      ];
    }
    return [];
  }

  function poll() {
    if (!bridge) {
      apply(demoState(), "demo");
      return;
    }
    return bridge.invoke("task.pull").then(
      function (res) {
        if (res && res.ok) apply(res, "live");
        else renderMeta("error");
      },
      function () {
        renderMeta("error");
      }
    );
  }

  /* ------------------------------------------------------------- demo */

  function demoState() {
    var zh = lang === "zh-CN";
    var now = Date.now();
    var all = [
      {
        id: "demoA",
        // v0.4：title 即真实会话名（面板从 pi.sqlite 读；演示里直接给真实名）
        title: zh ? "宠物医院多版本功能开发14-17" : "Pet clinic v14-17 build",
        updatedAt: now - 2 * 60000,
        updates: 6,
        running: true,
        tasks: zh
          ? [
              { text: "读现有接口和数据层，摸清写法", status: "done" },
              { text: "查询层加分页参数", status: "done" },
              { text: "路由处理器接收 page/pageSize", status: "doing", note: "正在改 handler" },
              { text: "返回体带上分页元信息", status: "todo" },
              { text: "跑构建 + 相关测试", status: "todo" },
            ]
          : [
              { text: "Read the endpoint and data layer", status: "done" },
              { text: "Add pagination params to the query layer", status: "done" },
              { text: "Accept page/pageSize in the route handler", status: "doing", note: "editing handler" },
              { text: "Return pagination metadata", status: "todo" },
              { text: "Run build + tests", status: "todo" },
            ],
      },
      {
        id: "demoB",
        title: zh ? "论文各版本要求整理" : "Paper requirements",
        updatedAt: now - 12 * 60000,
        updates: 3,
        running: false,
        endedAt: now - 8 * 60000,
        endReason: "completed",
        tasks: zh
          ? [
              { text: "比对版本差异，归纳各自要求", status: "done" },
              { text: "验证 v2 来源", status: "done" },
              { text: "写出 md 文档", status: "done" },
            ]
          : [
              { text: "Compare versions, list requirements", status: "done" },
              { text: "Verify v2 sources", status: "done" },
              { text: "Write the md doc", status: "done" },
            ],
      },
      {
        // 正在运行但还没推清单的会话（主动发现）
        id: "demoC",
        title: zh ? "选择软件版本" : "Pick a version",
        updatedAt: now - 1 * 60000,
        updates: 0,
        running: true,
        tasks: [],
        noChecklist: true,
      },
    ];
    var live = all.filter(function (s) {
      return !demoDismissed[s.id];
    });
    for (var i = 0; i < live.length; i++) live[i].summary = summarizeClient(live[i].tasks);
    // running 优先，再按最近更新倒序（与插件端一致）
    live.sort(function (a, b) {
      if (!!b.running !== !!a.running) return b.running ? 1 : -1;
      return b.updatedAt - a.updatedAt;
    });
    var sig = live
      .map(function (s) {
        return s.id + "|" + s.title + "|" + (s.running ? "1" : "0") + "|" + (s.noChecklist ? "n" : "c");
      })
      .join(";");
    return { seq: 8, liveSig: sig, hostAvailable: true, sessions: live, now: now, locale: lang };
  }

  function summarizeClient(tasks) {
    var total = tasks.length,
      done = 0,
      doing = 0,
      blocked = 0;
    for (var i = 0; i < tasks.length; i++) {
      if (tasks[i].status === "done") done++;
      else if (tasks[i].status === "doing") doing++;
      else if (tasks[i].status === "blocked") blocked++;
    }
    return { total: total, done: done, doing: doing, blocked: blocked, todo: total - done - doing - blocked };
  }

  /* ------------------------------------------------------------- boot */

  function boot() {
    // 语言由面板自己管（localStorage 记忆、默认中文），不跟随宿主 locale
    start();
  }

  function start() {
    document.documentElement.lang = lang;
    if (els.toggleAll) {
      els.toggleAll.addEventListener("click", function () {
        var collapseThem = anyExpanded();
        for (var i = 0; i < sessions.length; i++) {
          if (collapseThem) collapsed[sessions[i].id] = 1;
          else delete collapsed[sessions[i].id];
        }
        persistCollapsed();
        renderAll();
      });
    }
    if (els.langBtn) {
      els.langBtn.addEventListener("click", toggleLang);
    }
    if (els.resetOrder) {
      els.resetOrder.addEventListener("click", function () {
        setManualOrder([]); // 回到自动顺序
      });
    }
    // 兜底：指针在别处松开 / 被系统取消时，也要结束手势，避免面板一直停止刷新
    window.addEventListener("pointerup", function () {
      endSwipe();
      endDrag();
    });
    window.addEventListener("pointercancel", function () {
      endSwipe();
      endDrag();
    });
    // 拖动的移动在 window 上收：卡片换位后指针离开手柄也照样跟手，能一口气连续拖过多张
    window.addEventListener("pointermove", function (e) {
      if (gesture && gesture.type === "drag") dragMove(e || {});
    });
    // 拖到一半切走窗口：直接收尾，别让面板一直停在「拖动中」不刷新
    window.addEventListener("blur", abortGesture);
    // 点卡片以外的地方、或按 Esc，收起露出的删除按钮
    document.addEventListener("pointerdown", function (e) {
      if (!openSwipeId) return;
      var tgt = e && e.target;
      var inside = tgt && tgt.closest ? tgt.closest(".tp-card--swiped") : null;
      if (!inside) closeSwipe();
    });
    document.addEventListener("keydown", function (e) {
      if (e && e.key === "Escape" && openSwipeId) closeSwipe();
    });
    poll();
    setInterval(poll, POLL_MS);
    // 相对时间、staleness 会随时间变化，即使数据没变也定时刷新一次视图
    setInterval(function () {
      if (sessions.length) renderAll();
    }, CLOCK_MS);
    // 面板重新可见/获得焦点时立刻拉一次，避免后台节流下的滞后
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) poll();
    });
    window.addEventListener("focus", poll);
  }

  boot();
})();
