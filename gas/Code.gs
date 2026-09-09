/**
 * ============================================================
 *  ダンス投票システム － Google Apps Script（サーバー側）
 *
 *  【使い方】
 *   1. Googleスプレッドシートを新規作成
 *   2. 拡張機能 → Apps Script を開き、このファイルの中身を全部貼り付け
 *   3. 下の「設定」を書き換える
 *   4. 関数 setup を1回実行（初回は権限の承認が出ます）
 *   5. デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
 *        次のユーザーとして実行 : 自分
 *        アクセスできるユーザー : 全員
 *      → 発行されたURLを config.js の GAS_URL に貼る
 *
 *  ※ コードを直したら、必ず「デプロイを管理」→ 鉛筆 →
 *    バージョン「新バージョン」で再デプロイしてください。
 * ============================================================
 */

/* ===================== 設定 ===================== */

/** 会場の合言葉。config.js と同じ文字列にする。使わないなら "" */
var VENUE_CODE = "";

/**
 * 投票の受付開始・終了。"YYYY-MM-DD HH:MM" 形式。
 * 空文字 "" にすると時間制限なし（＝いつでも投票できる）。
 *
 *  ★いまは【テスト用に制限なし】です。
 *   本番当日は、必要なら次のように日時を入れて再デプロイしてください。
 *     var OPEN_AT  = "2026-10-12 14:00";
 *     var CLOSE_AT = "2026-10-12 14:05";
 *   ※ 時間で締め切らず、司会の合図でQRを下げる運用でも問題ありません。
 */
var OPEN_AT  = "";
var CLOSE_AT = "";

/** 投票ログを書き込むシート名 */
var SHEET_LOG = "投票ログ";
/** 集計を書き出すシート名 */
var SHEET_SUM = "集計";

/** 結果ページ(results.html)からの閲覧を許可するか */
var ALLOW_PUBLIC_RESULTS = true;

/* ================= ここから下は通常編集不要 ================= */

var HEADERS = ["日時", "投票者ID", "番号", "チーム名", "端末情報"];


/** 初回セットアップ：シートと見出しを作る */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var log = ss.getSheetByName(SHEET_LOG);
  if (!log) { log = ss.insertSheet(SHEET_LOG); }
  if (log.getLastRow() === 0) {
    log.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
       .setFontWeight("bold").setBackground("#efefef");
    log.setFrozenRows(1);
    log.setColumnWidth(1, 160);
    log.setColumnWidth(2, 300);
    log.setColumnWidth(4, 220);
    log.setColumnWidth(5, 320);
  }
  // 「03」が数値の3に変換されて先頭のゼロが消えるのを防ぐ
  log.getRange("C:C").setNumberFormat("@");

  var sum = ss.getSheetByName(SHEET_SUM);
  if (!sum) { sum = ss.insertSheet(SHEET_SUM); }
  updateSummary();

  notify("準備ができました。次に「デプロイ → 新しいデプロイ → ウェブアプリ」を行ってください。");
}


/**
 * 画面にお知らせを出す。
 * エディタから実行したときは UI が無い／ダイアログがスプレッドシート側に出て
 * 実行が止まって見えるため、トースト通知にして失敗しても先へ進むようにする。
 */
function notify(message) {
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast(message, "ダンス投票", 8);
  } catch (e) {
    // UI が使えない状況（トリガー実行など）ではログだけ残す
  }
  Logger.log(message);
}


/** スプレッドシートを開いたときのメニュー */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("ダンス投票")
    .addItem("集計を更新", "updateSummary")
    .addItem("初期セットアップ", "setup")
    .addSeparator()
    .addItem("投票データを全消去（テスト用）", "clearVotes")
    .addToUi();
}


/* ===================== 受付本体 ===================== */

/** ブラウザからの投票（JSONP）と結果取得を受ける */
function doGet(e) {
  var p = (e && e.parameter) ? e.parameter : {};
  var action = p.action || "";
  var result;

  try {
    if (action === "vote") {
      result = handleVote(p);
    } else if (action === "results") {
      result = handleResults(p);
    } else {
      result = { ok: true, status: "alive", message: "投票システムは稼働中です。" };
    }
  } catch (err) {
    result = { ok: false, status: "error", message: String(err) };
  }

  return respond(result, p.callback);
}


/** POST でも同じ処理を受けられるようにしておく */
function doPost(e) {
  var p = {};
  try {
    if (e && e.postData && e.postData.contents) {
      p = JSON.parse(e.postData.contents);
    }
  } catch (err) {
    p = (e && e.parameter) ? e.parameter : {};
  }
  var result;
  try {
    result = handleVote(p);
  } catch (err2) {
    result = { ok: false, status: "error", message: String(err2) };
  }
  return respond(result, null);
}


/** 1票を記録する */
function handleVote(p) {
  var voterId    = String(p.voterId    || "").trim();
  var dancerId   = String(p.dancerId   || "").trim();
  var dancerName = String(p.dancerName || "").trim();
  var code       = String(p.code       || "").trim();

  if (!voterId || !dancerId) {
    return { ok: false, status: "error", message: "投票内容が正しく送信されませんでした。" };
  }

  // 受付時間のチェック
  var win = checkWindow();
  if (!win.ok) { return win; }

  // 合言葉のチェック
  if (VENUE_CODE && normalize(code) !== normalize(VENUE_CODE)) {
    return { ok: false, status: "bad_code" };
  }

  // 同時アクセスで二重書き込みが起きないようロックする
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    return { ok: false, status: "error", message: "混み合っています。もう一度お試しください。" };
  }

  try {
    var sheet = getLogSheet();

    // すでに同じ端末IDで投票済みかを確認（＝1人1回）
    var prev = findVote(sheet, voterId);
    if (prev) {
      return {
        ok: false,
        status: "duplicate",
        dancerId: String(prev.dancerId),
        dancerName: String(prev.dancerName)
      };
    }

    sheet.appendRow([
      new Date(),
      voterId,
      dancerId,
      dancerName,
      String(p.ua || "")
    ]);

    return { ok: true, status: "recorded", dancerId: dancerId, dancerName: dancerName };
  } finally {
    lock.releaseLock();
  }
}


/** 端末IDで過去の投票を探す */
function findVote(sheet, voterId) {
  var last = sheet.getLastRow();
  if (last < 2) { return null; }

  var values = sheet.getRange(2, 2, last - 1, 3).getValues(); // B:投票者ID D:チーム名 まで
  for (var i = values.length - 1; i >= 0; i--) {
    if (String(values[i][0]) === voterId) {
      return { dancerId: values[i][1], dancerName: values[i][2] };
    }
  }
  return null;
}


/** 受付時間内かどうか */
function checkWindow() {
  var now = new Date();

  var open = parseDate(OPEN_AT);
  if (open && now < open) {
    return {
      ok: false, status: "not_open",
      message: Utilities.formatDate(open, Session.getScriptTimeZone(), "H時mm分") + "から受付開始です。"
    };
  }

  var close = parseDate(CLOSE_AT);
  if (close && now > close) {
    return { ok: false, status: "closed", message: "受付は終了しました。" };
  }

  return { ok: true };
}


/** "YYYY-MM-DD HH:MM" を Date に。空なら null */
function parseDate(s) {
  if (!s) { return null; }
  var m = String(s).match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/);
  if (!m) { return null; }
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0);
}


function normalize(s) {
  return String(s).trim().toLowerCase().replace(/\s+/g, "");
}


/**
 * 番号の照合用キーを作る。
 * シートが "03" を数値 3 として保存してしまう場合があるため、
 * 数字だけの番号は先頭のゼロを落として比較する（"03" も 3 も "3" になる）。
 * config.js 側も同じ規則で正規化している。
 */
function normId(v) {
  var t = String(v === null || v === undefined ? "" : v).trim();
  return /^\d+$/.test(t) ? String(parseInt(t, 10)) : t.toLowerCase();
}


function getLogSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_LOG);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_LOG);
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight("bold");
    sheet.setFrozenRows(1);
    sheet.getRange("C:C").setNumberFormat("@");
  }
  return sheet;
}


/* ===================== 集計 ===================== */

/** 現在の得票数を返す */
function tally() {
  var sheet = getLogSheet();
  var last = sheet.getLastRow();
  var rows = [];
  var total = 0;

  if (last >= 2) {
    var values = sheet.getRange(2, 3, last - 1, 2).getValues(); // C:番号 D:チーム名
    var map = {};
    var order = [];

    for (var i = 0; i < values.length; i++) {
      var raw = String(values[i][0]).trim();
      var key = normId(raw);
      if (!key) { continue; }
      if (!map[key]) {
        map[key] = { id: key, rawId: raw, name: String(values[i][1]), count: 0 };
        order.push(key);
      }
      map[key].count++;
      total++;
    }

    for (var j = 0; j < order.length; j++) { rows.push(map[order[j]]); }
    rows.sort(function (a, b) {
      if (b.count !== a.count) { return b.count - a.count; }
      return a.id < b.id ? -1 : 1;
    });
  }

  return { total: total, rows: rows };
}


/** 結果ページ用 */
function handleResults(p) {
  if (!ALLOW_PUBLIC_RESULTS) {
    return { ok: false, status: "forbidden", message: "結果は公開されていません。" };
  }
  var t = tally();
  return {
    ok: true,
    status: "results",
    total: t.total,
    rows: t.rows,
    updatedAt: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "HH:mm:ss")
  };
}


/** 「集計」シートを書き換える */
function updateSummary() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sum = ss.getSheetByName(SHEET_SUM);
  if (!sum) { sum = ss.insertSheet(SHEET_SUM); }

  var t = tally();
  sum.clear();

  var out = [["順位", "番号", "チーム名", "得票数", "得票率"]];
  for (var i = 0; i < t.rows.length; i++) {
    var r = t.rows[i];
    out.push([
      i + 1, r.rawId || r.id, r.name, r.count,
      t.total ? (r.count / t.total) : 0
    ]);
  }
  // setValues は全行の列数を揃える必要があるため、空行も5列で作る
  out.push(["", "", "", "", ""]);
  out.push(["合計", "", "", t.total, ""]);

  sum.getRange("B:B").setNumberFormat("@");   // 番号を "03" のまま表示する
  sum.getRange(1, 1, out.length, 5).setValues(out);
  sum.getRange(1, 1, 1, 5).setFontWeight("bold").setBackground("#efefef");
  if (t.rows.length) {
    sum.getRange(2, 5, t.rows.length, 1).setNumberFormat("0.0%");
  }
  sum.setColumnWidth(3, 240);
  sum.setFrozenRows(1);
}


/**
 * テスト用：投票データを消す。
 * 確認ダイアログを出すので、必ずスプレッドシートのメニュー
 * 「ダンス投票 → 投票データを全消去」から実行してください
 * （エディタから実行すると、ダイアログの応答待ちで止まって見えます）。
 */
function clearVotes() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.alert("投票データを全部消します。よろしいですか？", ui.ButtonSet.YES_NO);
  if (res !== ui.Button.YES) { return; }

  var sheet = getLogSheet();
  var last = sheet.getLastRow();
  if (last >= 2) { sheet.deleteRows(2, last - 1); }
  updateSummary();
  notify("投票データを消去しました。");
}


/* ===================== 応答 ===================== */

function respond(obj, callback) {
  var json = JSON.stringify(obj);
  if (callback) {
    return ContentService
      .createTextOutput(callback + "(" + json + ");")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}
