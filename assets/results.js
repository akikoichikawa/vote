(function () {
  "use strict";

  var CFG = window.VOTE_CONFIG || {};
  var REFRESH_MS = 6000;
  var TIMEOUT = 12000;
  var hiddenMode = false;

  function $(id) { return document.getElementById(id); }

  /* 投票ページと同じくJSONPで取得（CORSの影響を受けない） */
  function jsonp(params, cb) {
    var name = "__dvr_cb_" + Date.now() + "_" + Math.floor(Math.random() * 1e6);
    var done = false;
    var s = document.createElement("script");

    function finish(err, data) {
      if (done) { return; }
      done = true;
      clearTimeout(timer);
      try { delete window[name]; } catch (e) { window[name] = undefined; }
      if (s.parentNode) { s.parentNode.removeChild(s); }
      cb(err, data);
    }

    var timer = setTimeout(function () { finish(new Error("timeout")); }, TIMEOUT);
    window[name] = function (data) { finish(null, data); };

    var q = [];
    for (var k in params) {
      if (Object.prototype.hasOwnProperty.call(params, k)) {
        q.push(encodeURIComponent(k) + "=" + encodeURIComponent(params[k]));
      }
    }
    q.push("callback=" + name);
    q.push("_=" + Date.now());

    s.src = CFG.GAS_URL + "?" + q.join("&");
    s.onerror = function () { finish(new Error("network")); };
    document.head.appendChild(s);
  }

  /* 番号の照合用キー。シート側が "03" を数値3として保存することがあるため、
     数字だけの番号は先頭のゼロを落として比較する（Code.gs の normId と同じ規則） */
  function normId(v) {
    var t = String(v === null || v === undefined ? "" : v).trim();
    return /^\d+$/.test(t) ? String(parseInt(t, 10)) : t.toLowerCase();
  }

  /* config.js の並び順を基準に、未得票の組も0票として表示する */
  function mergeWithConfig(rows) {
    var list = CFG.DANCERS || [];
    if (!list.length) { return rows; }

    var byId = {};
    rows.forEach(function (r) { byId[normId(r.id)] = r; });

    var merged = list.map(function (d) {
      var key = normId(d.id);
      var hit = byId[key];
      delete byId[key];
      return { id: String(d.id), name: d.name, count: hit ? hit.count : 0 };
    });

    // config に無いIDが記録されていた場合も落とさず拾う
    for (var k in byId) {
      if (Object.prototype.hasOwnProperty.call(byId, k)) { merged.push(byId[k]); }
    }

    merged.sort(function (a, b) {
      if (b.count !== a.count) { return b.count - a.count; }
      return String(a.id) < String(b.id) ? -1 : 1;
    });
    return merged;
  }

  function render(data) {
    var rows = mergeWithConfig(data.rows || []);
    var total = data.total || 0;
    var max = 0;
    rows.forEach(function (r) { if (r.count > max) { max = r.count; } });

    $("total").textContent = total;
    $("caption").textContent = total
      ? "得票数の多い順"
      : "まだ投票がありません";

    var ol = $("chart");
    ol.innerHTML = "";

    rows.forEach(function (r, i) {
      var li = document.createElement("li");
      li.className = "row";

      var rank = document.createElement("span");
      rank.className = "rank";
      rank.textContent = (i + 1);

      var label = document.createElement("div");
      label.className = "label";

      var team = document.createElement("span");
      team.className = "team";
      team.textContent = r.name || ("No." + r.id);

      var value = document.createElement("span");
      value.className = "value";
      var pct = total ? Math.round(r.count / total * 1000) / 10 : 0;
      value.innerHTML = "<b>" + r.count + "</b>票　" + pct + "%";

      label.appendChild(team);
      label.appendChild(value);

      var track = document.createElement("div");
      track.className = "track";
      var bar = document.createElement("div");
      bar.className = "bar";
      track.appendChild(bar);

      li.appendChild(rank);
      li.appendChild(label);
      li.appendChild(track);
      ol.appendChild(li);

      // 反映は次フレームで（幅のアニメーションを効かせるため）
      requestAnimationFrame(function () {
        bar.style.width = (max ? (r.count / max * 100) : 0) + "%";
      });
    });

    $("state").hidden = true;
    ol.hidden = false;
    $("updated").textContent = "最終更新 " + (data.updatedAt || "") + "（自動更新中）";
  }

  function load() {
    if (!CFG.GAS_URL || CFG.GAS_URL.indexOf("script.google.com") === -1) {
      $("state").textContent = "config.js の GAS_URL が未設定です。";
      return;
    }

    jsonp({ action: "results" }, function (err, res) {
      if (err || !res || !res.ok) {
        if ($("chart").hidden) {
          $("state").textContent = "結果を取得できませんでした。再試行します…";
        } else {
          $("updated").textContent = "更新に失敗しました。再試行します…";
        }
        return;
      }
      render(res);
    });
  }

  function init() {
    $("title").textContent = (CFG.EVENT_TITLE || "投票結果") + " 結果";

    $("reloadBtn").addEventListener("click", load);
    $("toggleBtn").addEventListener("click", function () {
      hiddenMode = !hiddenMode;
      $("root").classList.toggle("hidden-mode", hiddenMode);
      this.textContent = hiddenMode ? "結果を表示する" : "結果を伏せる";
    });

    load();
    setInterval(load, REFRESH_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
