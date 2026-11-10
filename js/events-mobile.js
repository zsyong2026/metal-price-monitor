// events-mobile.js —— 手机端事件查看页（只依赖 data/events.json 与 data/events.meta.json）
// 与主站 index.html 解耦：不加载 ECharts、不加载价格日K、不改动主站任何逻辑。
(function () {
  "use strict";

  var PAGE_SIZE = 10;
  var state = { metal: "gold", cat: "all", shown: PAGE_SIZE, events: null, meta: null };

  var $ = function (id) { return document.getElementById(id); };
  var listEl = $("list");
  var moreEl = $("more");
  var emptyEl = $("empty");
  var countEl = $("count");
  var updatedEl = $("updated");

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function safeUrl(u) {
    var s = String(u || "");
    return /^https?:\/\//i.test(s) ? s : "";
  }

  function loadJson(name) {
    return fetch("data/" + name + "?t=" + Date.now(), { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error(name + " HTTP " + r.status);
        return r.json();
      });
  }

  function fmtTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    function p(n) { return n < 10 ? "0" + n : "" + n; }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function currentList() {
    var arr = (state.events && state.events[state.metal]) || [];
    arr = arr.slice().sort(function (a, b) {
      return String(a.date) < String(b.date) ? 1 : String(a.date) > String(b.date) ? -1 : 0;
    });
    if (state.cat !== "all") {
      arr = arr.filter(function (e) { return e.category === state.cat; });
    }
    return arr;
  }

  function impactOf(e) {
    var eff = e.impactEff || e.impact;
    if (eff === "up") return { cls: "b-up", txt: "利多" };
    if (eff === "down") return { cls: "b-down", txt: "利空" };
    return { cls: "b-mixed", txt: "中性" };
  }

  function cardHtml(e) {
    var imp = impactOf(e);
    var tags = (e.tags || []).filter(function (t) { return t !== "走强" && t !== "走弱"; }).slice(0, 6);
    var scope = (e.impactScope || []).slice(0, 5);
    var conclusion = e.impactConclusion || "";
    var degree = e.impactDegree || "";
    var href = safeUrl(e.url);
    var source = e.authoritativeSource || e.source || "";

    var metaRows = "";
    if (scope.length) metaRows += "<div>影响范围：<b>" + esc(scope.join(" · ")) + "</b></div>";
    if (degree) metaRows += "<div>影响程度：<b>" + esc(degree) + "</b></div>";
    if (conclusion) metaRows += "<div>影响结论：<b>" + esc(conclusion) + "</b></div>";

    return "<li class='card'>" +
      "<div class='card-top'>" +
        "<span class='e-date'>" + esc(e.date) + "</span>" +
        "<span class='badge b-cat'>" + esc(e.category || "未分类") + "</span>" +
        "<span class='badge " + imp.cls + "'>" + imp.txt + "</span>" +
      "</div>" +
      "<h3 class='e-title'>" + esc(e.title) + "</h3>" +
      "<p class='e-summary'>" + esc(e.summary || "") + "</p>" +
      (metaRows ? "<div class='e-meta'>" + metaRows + "</div>" : "") +
      (tags.length ? "<div class='e-tags'>" + tags.map(function (t) {
        return "<span class='e-tag'>" + esc(t) + "</span>";
      }).join("") + "</div>" : "") +
      "<div class='e-foot'>" +
        "<span>" + esc(source) + "</span>" +
        (href ? "<a class='e-link' href='" + esc(href) + "' target='_blank' rel='noopener noreferrer'>查看原文</a>" : "") +
      "</div>" +
    "</li>";
  }

  function render() {
    if (!state.events) return;
    var arr = currentList();
    var shown = arr.slice(0, state.shown);
    listEl.innerHTML = shown.map(cardHtml).join("");
    emptyEl.hidden = arr.length > 0;
    moreEl.hidden = arr.length <= state.shown;
    if (arr.length > state.shown) {
      moreEl.textContent = "加载更多（还剩 " + (arr.length - state.shown) + " 条）";
    }
    var mName = state.metal === "gold" ? "金" : state.metal === "silver" ? "银" : "铜";
    var byMetal = state.meta && state.meta.byMetal ? state.meta.byMetal[state.metal] : null;
    countEl.textContent = mName + " · 共 " + arr.length + " 条" +
      (state.cat !== "all" ? "（" + state.cat + "）" : "") +
      (byMetal ? " · 库内 " + byMetal + " 条" : "") +
      " · 已显示 " + shown.length + " 条";
  }

  function setActive(nav, attr, value) {
    var btns = nav.querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) {
      var hit = btns[i].getAttribute(attr) === value;
      if (hit) btns[i].classList.add("active");
      else btns[i].classList.remove("active");
    }
  }

  $("metalTabs").addEventListener("click", function (ev) {
    var b = ev.target.closest("button[data-metal]");
    if (!b) return;
    state.metal = b.getAttribute("data-metal");
    state.shown = PAGE_SIZE;
    setActive(this, "data-metal", state.metal);
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  $("catChips").addEventListener("click", function (ev) {
    var b = ev.target.closest("button[data-cat]");
    if (!b) return;
    state.cat = b.getAttribute("data-cat");
    state.shown = PAGE_SIZE;
    setActive(this, "data-cat", state.cat);
    render();
  });

  moreEl.addEventListener("click", function () {
    state.shown += PAGE_SIZE;
    render();
  });

  Promise.all([
    loadJson("events.json"),
    loadJson("events.meta.json").catch(function () { return null; }),
  ]).then(function (res) {
    state.events = res[0];
    state.meta = res[1];
    var t = fmtTime(state.meta && state.meta.updatedAt);
    updatedEl.textContent = t ? "事件更新于 " + t + " ｜ 数据每 15 分钟校验发布" : "事件数据已载入";
    render();
  }).catch(function (err) {
    updatedEl.textContent = "事件数据读取失败：" + err.message;
    countEl.textContent = "请检查网络后刷新页面，或前往「完整数据页」查看。";
  });
})();
