(function () {
  "use strict";

  var CFG = window.VOTE_CONFIG || {};
  var LS_VOTER = "danceVote.voterId";
  var LS_DONE  = "danceVote.done";
  var TIMEOUT  = 12000;

  var selected = null;
  var sending  = false;

  /* ---------------- 小道具 ---------------- */

  function $(id) { return document.getElementById(id); }

  function show(id) {
    ["view-vote", "view-sending", "view-done", "view-already", "view-closed"]
      .forEach(function (v) { $(v).hidden = (v !== id); });
    $("submitBar").hidden = (id !== "view-vote");
    window.scrollTo(0, 0);
  }

  /* localStorage はプライベートブラウズで落ちることがあるので必ず包む */
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* noop */ } }

  function cookieGet(k) {
    var m = document.cookie.match(new RegExp("(^|; )" + k + "=([^;]*)"));
    return m ? decodeURIComponent(m[2]) : null;
  }
  function cookieSet(k, v) {
    try {
      document.cookie = k + "=" + encodeURIComponent(v) +
        ";path=/;max-age=31536000;samesite=lax" +
        (location.protocol === "https:" ? ";secure" : "");
    } catch (e) { /* noop */ }
  }

  function uuid() {
    if (window.crypto && crypto.randomUUID) { return crypto.randomUUID(); }
    var b = new Uint8Array(16);
    if (window.crypto && crypto.getRandomValues) { crypto.getRandomValues(b); }
    else { for (var i = 0; i < 16; i++) { b[i] = Math.floor(Math.random() * 256); } }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = [];
    for (var j = 0; j < 16; j++) { h.push(("0" + b[j].toString(16)).slice(-2)); }
    return h.slice(0, 4).join("") + "-" + h.slice(4, 6).join("") + "-" +
           h.slice(6, 8).join("") + "-" + h.slice(8, 10).join("") + "-" + h.slice(10).join("");
  }

  /* 端末を識別するID。localStorage と Cookie の両方に置き、
     どちらかが消えても復元できるようにする（＝二重投票がしにくい） */
  function getVoterId() {
    var id = lsGet(LS_VOTER) || cookieGet("dvid");
    if (!id) { id = uuid(); }
    lsSet(LS_VOTER, id);
    cookieSet("dvid", id);
    return id;
  }

  function markDoneLocally(dancerId, dancerName) {
    var rec = JSON.stringify({ id: dancerId, name: dancerName, at: Date.now() });
    lsSet(LS_DONE, rec);
    cookieSet("dvdone", dancerId);
  }

  function getDoneLocally() {
    var raw = lsGet(LS_DONE);
    if (raw) { try { return JSON.parse(raw); } catch (e) { /* fallthrough */ } }
    var cid = cookieGet("dvdone");
    if (cid) { return { id: cid, name: nameOf(cid) }; }
    return null;
  }

  /* 番号の照合用キー。シート側が "03" を数値3として保存することがあるため、
     数字だけの番号は先頭のゼロを落として比較する（Code.gs の normId と同じ規則） */
  function normId(v) {
    var t = String(v === null || v === undefined ? "" : v).trim();
    return /^\d+$/.test(t) ? String(parseInt(t, 10)) : t.toLowerCase();
  }

  function nameOf(id) {
    var list = CFG.DANCERS || [];
    var key = normId(id);
    for (var i = 0; i < list.length; i++) {
      if (normId(list[i].id) === key) { return list[i].name; }
    }
    return "";
  }

  /* ---------------- 通信 ---------------- */

  function buildQuery(params) {
    var q = [];
    for (var k in params) {
      if (Object.prototype.hasOwnProperty.call(params, k)) {
        q.push(encodeURIComponent(k) + "=" + encodeURIComponent(params[k]));
      }
    }
    q.push("_=" + Date.now());
    return q.join("&");
  }

  /* 本命の通信経路。credentials:"omit" が要点で、ブラウザのGoogleログイン情報を
     一切送らずに問い合わせる。ログイン中のアカウントに利用制限がかかっていても
     （13歳未満の管理対象アカウントなど）、匿名アクセスとして扱われるため通る。
     Apps Script 側は Access-Control-Allow-Origin: * を返すので CORS も問題ない。 */
  function fetchJson(params, cb) {
    if (typeof window.fetch !== "function") { cb(new Error("no-fetch")); return; }

    var ctrl = null, timer = null;
    try { ctrl = new AbortController(); } catch (e) { ctrl = null; }
    var opts = { method: "GET", credentials: "omit", cache: "no-store", redirect: "follow" };
    if (ctrl) {
      opts.signal = ctrl.signal;
      timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, TIMEOUT);
    }

    window.fetch(CFG.GAS_URL + "?" + buildQuery(params), opts)
      .then(function (res) {
        if (!res.ok) { throw new Error("HTTP " + res.status); }
        return res.json();
      })
      .then(function (data) {
        if (timer) { clearTimeout(timer); }
        if (!data || typeof data.ok === "undefined") { throw new Error("unexpected"); }
        cb(null, data);
      })
      .catch(function (err) {
        if (timer) { clearTimeout(timer); }
        cb(err || new Error("fetch-failed"));
      });
  }

  /* 予備の通信経路。fetch が使えない古い端末向け。
     script タグはログイン情報を送ってしまうので、あくまで最後の手段。 */
  function jsonp(params, cb) {
    var name = "__dv_cb_" + Date.now() + "_" + Math.floor(Math.random() * 1e6);
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

    s.src = CFG.GAS_URL + "?" + buildQuery(params) + "&callback=" + name;
    s.onerror = function () { finish(new Error("network")); };
    document.head.appendChild(s);
  }

  /* まず fetch、だめなら JSONP */
  function request(params, cb) {
    fetchJson(params, function (err, data) {
      if (!err && data) { cb(null, data); return; }
      jsonp(params, cb);
    });
  }

  function sendVote(dancer, code, cb) {
    request({
      action: "vote",
      voterId: getVoterId(),
      dancerId: dancer.id,
      dancerName: dancer.name,
      code: code || "",
      ua: (navigator.userAgent || "").slice(0, 180)
    }, cb);
  }

  /* ---------------- 画面組み立て ---------------- */

  function renderDancers() {
    var ul = $("dancerList");
    var list = CFG.DANCERS || [];
    ul.innerHTML = "";

    list.forEach(function (d) {
      var li = document.createElement("li");
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "dancer";
      btn.setAttribute("aria-pressed", "false");
      btn.dataset.id = d.id;

      var no = document.createElement("span");
      no.className = "no";
      no.textContent = d.id;

      var body = document.createElement("span");
      body.className = "body";

      var nm = document.createElement("span");
      nm.className = "name";
      nm.textContent = d.name;
      body.appendChild(nm);

      if (d.note) {
        var nt = document.createElement("span");
        nt.className = "note";
        nt.textContent = d.note;
        body.appendChild(nt);
      }

      var mark = document.createElement("span");
      mark.className = "mark";

      btn.appendChild(no);
      btn.appendChild(body);
      btn.appendChild(mark);

      btn.addEventListener("click", function () { select(d, btn); });

      li.appendChild(btn);
      ul.appendChild(li);
    });
  }

  function select(dancer, btn) {
    selected = dancer;
    var all = document.querySelectorAll(".dancer");
    for (var i = 0; i < all.length; i++) {
      all[i].setAttribute("aria-pressed", all[i] === btn ? "true" : "false");
    }
    $("submitBtn").disabled = false;
    $("formError").hidden = true;
  }

  function showError(msg) {
    var el = $("formError");
    el.textContent = msg;
    el.hidden = false;
  }

  function showClosed(title, msg) {
    $("closedTitle").textContent = title;
    $("closedMsg").innerHTML = msg || "";
    show("view-closed");
  }

  /* ---------------- 送信処理 ---------------- */

  function onSubmit() {
    if (sending || !selected) { return; }

    var code = "";
    if (CFG.VENUE_CODE) {
      code = ($("venueCode").value || "").trim();
      if (!code) {
        showError("会場の合言葉を入力してください。");
        $("venueCode").focus();
        return;
      }
    }

    sending = true;
    show("view-sending");

    sendVote(selected, code, function (err, res) {
      sending = false;

      if (err || !res) {
        showClosed("送信できませんでした",
          "電波の状態を確認して、もう一度お試しください。");
        return;
      }

      if (res.ok) {
        markDoneLocally(selected.id, selected.name);
        $("doneDancer").textContent = selected.name;
        show("view-done");
        return;
      }

      switch (res.status) {
        case "duplicate":
          markDoneLocally(res.dancerId || selected.id, res.dancerName || nameOf(res.dancerId));
          // 通信のやり直しで同じ組に二重送信された場合は、投票が通ったものとして見せる
          if (normId(res.dancerId) === normId(selected.id)) {
            $("doneDancer").textContent = selected.name;
            show("view-done");
            break;
          }
          $("alreadyDancer").textContent = res.dancerName || nameOf(res.dancerId) || "";
          show("view-already");
          break;
        case "not_open":
          showClosed("投票はまだ始まっていません", res.message || "開始までお待ちください。");
          break;
        case "closed":
          showClosed("投票は締め切りました", res.message || "ご参加ありがとうございました。");
          break;
        case "bad_code":
          show("view-vote");
          showError("合言葉が違うようです。会場の案内をご確認ください。");
          $("venueCode").focus();
          break;
        default:
          showClosed("エラーが発生しました", res.message || "もう一度お試しください。");
      }
    });
  }

  /* ---------------- 起動 ---------------- */

  function init() {
    document.title = (CFG.EVENT_TITLE || "ダンス投票");
    $("eventTitle").textContent = CFG.EVENT_TITLE || "ダンス投票";
    $("eventSubtitle").textContent = CFG.EVENT_SUBTITLE || "";

    if (CFG.VENUE_CODE) { $("codeBox").hidden = false; }

    if (!CFG.GAS_URL || CFG.GAS_URL.indexOf("script.google.com") === -1) {
      showClosed("設定が未完了です",
        "config.js の GAS_URL に Apps Script のウェブアプリURLを設定してください。");
      $("retryBtn").hidden = true;
      return;
    }

    renderDancers();

    var done = getDoneLocally();
    if (done) {
      $("alreadyDancer").textContent = done.name || nameOf(done.id) || "";
      show("view-already");
      return;
    }

    show("view-vote");
    $("submitBtn").addEventListener("click", onSubmit);
    $("retryBtn").addEventListener("click", function () {
      $("formError").hidden = true;
      show("view-vote");
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
