/* Public recruitment text only. No spreadsheet, Gmail, DOM, or network calls. */
var LK_RM_CORE_V1 = (function () {
  "use strict";

  var SUBJECTS = [
    "【案件メール】",
    "【何とか埋めたい案件】",
    "【緊急案件】",
    "【着ぐるみ有：案件メール】"
  ];
  var INTRO = "お疲れ様です！\n\n下記案件でスタッフを募集しております。\n希望者はご連絡ください。\n\n";
  var CONDITIONS = "【条件】\n日給10,000円＋交通費＆通信費全額支給\n※別条件の場合は、案件毎に記載有";
  var WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

  function plain(value) {
    return typeof value === "string"
      ? value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim()
      : "";
  }

  function inline(value) {
    return plain(value).replace(/\s+/g, " ");
  }

  function normalizeNotice(value) {
    var notice = plain(value);
    if (notice.charAt(0) === "＜" && notice.charAt(notice.length - 1) === "＞") {
      notice = notice.slice(1, -1).trim();
    }
    return notice;
  }

  function parseDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    var parts = value.split("-").map(Number);
    var date = new Date(0);
    date.setUTCFullYear(parts[0], parts[1] - 1, parts[2]);
    date.setUTCHours(0, 0, 0, 0);
    if (date.getUTCFullYear() !== parts[0] || date.getUTCMonth() !== parts[1] - 1 || date.getUTCDate() !== parts[2]) return null;
    return date;
  }

  function dateLabel(iso, includeYear) {
    var date = parseDate(iso);
    return (includeYear ? date.getUTCFullYear() + "/" : "") +
      (date.getUTCMonth() + 1) + "/" + date.getUTCDate() + "（" + WEEKDAYS[date.getUTCDay()] + "）";
  }

  function parseTime(value, permitMidnightEnd) {
    var source = inline(value).replace(/：/g, ":");
    var match = /^(\d{1,2}):(\d{2})$/.exec(source);
    if (!match) return null;
    var hour = Number(match[1]);
    var minute = Number(match[2]);
    if (minute > 59 || hour > 24 || (hour === 24 && (!permitMidnightEnd || minute !== 0))) return null;
    return { text: hour + ":" + (minute < 10 ? "0" : "") + minute, minutes: hour * 60 + minute };
  }

  function parseExecution(value) {
    var source = inline(value).replace(/：/g, ":");
    var match = /^(\d{1,2}:\d{2})\s*[～〜~\-－–—]\s*(\d{1,2}:\d{2})$/.exec(source);
    if (!match) return null;
    var start = parseTime(match[1], false);
    var end = parseTime(match[2], true);
    if (!start || !end || end.minutes <= start.minutes) return null;
    return start.text + "～" + end.text;
  }

  function validMoney(value, allowZero) {
    return typeof value === "number" && isFinite(value) && Math.floor(value) === value &&
      value <= 9007199254740991 && (allowZero ? value >= 0 : value > 0);
  }

  function yen(value) {
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "円";
  }

  function invalid(index, code) {
    // Do not put raw source values, case IDs, or supplier/internal data in warnings.
    return { caseIndex: index + 1, code: code, message: "入力" + (index + 1) + "件目を除外しました（" + code + "）。" };
  }

  function normalizeCase(source, index, warnings) {
    function reject(code) { warnings.push(invalid(index, code)); return null; }
    if (!source || typeof source !== "object" || Array.isArray(source)) return reject("INVALID_CASE");
    if (!parseDate(source.date)) return reject("INVALID_DATE");
    var client = inline(source.client);
    var store = inline(source.store);
    var arrival = parseTime(source.arrival, false);
    var execution = parseExecution(source.execution);
    if (!client) return reject("MISSING_CLIENT");
    if (!store) return reject("MISSING_STORE");
    if (!arrival || !execution) return reject("INVALID_TIME");
    if (!validMoney(source.basePay, false)) return reject("INVALID_BASE_PAY");

    var allowances = [];
    if (source.allowances !== undefined && !Array.isArray(source.allowances)) return reject("INVALID_ALLOWANCES");
    var sourceAllowances = source.allowances || [];
    for (var a = 0; a < sourceAllowances.length; a += 1) {
      var allowance = sourceAllowances[a];
      if (!allowance || typeof allowance !== "object" || !validMoney(allowance.amount, true)) return reject("INVALID_ALLOWANCE");
      var label = inline(allowance.label);
      if (!label) return reject("INVALID_ALLOWANCE_LABEL");
      if (allowance.amount > 0) allowances.push({ label: label, amount: allowance.amount });
    }

    var notes = [];
    if (source.notes !== undefined && !Array.isArray(source.notes)) return reject("INVALID_PUBLIC_NOTES");
    var sourceNotes = source.notes || [];
    for (var n = 0; n < sourceNotes.length; n += 1) {
      if (typeof sourceNotes[n] !== "string") return reject("INVALID_PUBLIC_NOTES");
      var note = plain(sourceNotes[n]);
      if (note) notes.push(note);
    }

    var consecutiveDates = [];
    if (source.consecutiveDates !== undefined && !Array.isArray(source.consecutiveDates)) return reject("INVALID_CONSECUTIVE_DATES");
    var sourceDates = source.consecutiveDates || [];
    for (var d = 0; d < sourceDates.length; d += 1) {
      if (!parseDate(sourceDates[d])) return reject("INVALID_CONSECUTIVE_DATES");
      if (consecutiveDates.indexOf(sourceDates[d]) === -1) consecutiveDates.push(sourceDates[d]);
    }
    consecutiveDates.sort();
    if (consecutiveDates.length && consecutiveDates.indexOf(source.date) === -1) return reject("CONSECUTIVE_DATE_MISMATCH");

    // Explicit public-field whitelist: never copy or spread the source object.
    return {
      date: source.date,
      client: client,
      manufacturer: inline(source.manufacturer) || "未定",
      menu: inline(source.menu) || "未定",
      store: store,
      arrival: arrival.text,
      execution: execution,
      basePay: source.basePay,
      allowances: allowances,
      notes: notes,
      consecutiveDates: consecutiveDates,
      sourceIndex: index
    };
  }

  function groupKey(item) {
    return JSON.stringify([
      item.manufacturer, item.menu, item.execution, item.basePay,
      item.allowances, item.notes, item.arrival, item.consecutiveDates
    ]);
  }

  function splitStore(store) {
    // Only known prefixes required by the existing recruitment format.
    // Other store names remain intact, rather than guessing their chain.
    var chain = "";
    if (/^イオン/.test(store) && !/^イオン(?:モール|タウン|スーパーセンター)/.test(store)) chain = "イオン";
    else if (/^ライフ/.test(store) && !/^ライフスタイル/.test(store)) chain = "ライフ";
    if (!chain) return { chain: "", name: store };
    var name = store.slice(chain.length).replace(/^[\s／/:：・]+/, "").trim();
    return name ? { chain: chain, name: name } : { chain: "", name: store };
  }

  function renderStores(stores) {
    var buckets = [];
    stores.forEach(function (store) {
      var split = splitStore(store);
      var bucket = null;
      for (var b = 0; b < buckets.length; b += 1) {
        if (buckets[b].chain === split.chain) { bucket = buckets[b]; break; }
      }
      if (!bucket) { bucket = { chain: split.chain, stores: [] }; buckets.push(bucket); }
      var found = null;
      for (var s = 0; s < bucket.stores.length; s += 1) {
        if (bucket.stores[s].name === split.name) { found = bucket.stores[s]; break; }
      }
      if (found) found.count += 1;
      else bucket.stores.push({ name: split.name, count: 1 });
    });
    var lines = [];
    buckets.forEach(function (bucket) {
      if (bucket.chain) lines.push("●" + bucket.chain);
      bucket.stores.forEach(function (store) {
        lines.push("・" + store.name + (store.count > 1 ? "（" + store.count + "名募集）" : ""));
      });
    });
    return lines;
  }

  function renderGroup(group) {
    var item = group.item;
    var lines = [item.manufacturer + "：" + item.menu];
    if (item.consecutiveDates.length) {
      var includeYear = item.consecutiveDates[0].slice(0, 4) !== item.consecutiveDates[item.consecutiveDates.length - 1].slice(0, 4);
      lines.push("★連日実施：" + item.consecutiveDates.map(function (date) { return dateLabel(date, includeYear); }).join("・"));
    }
    if (item.basePay !== 10000) lines.push("★日給" + yen(item.basePay));
    item.allowances.forEach(function (allowance) { lines.push("★" + allowance.label + yen(allowance.amount)); });
    lines.push("入店" + item.arrival + "／実施" + item.execution);
    item.notes.forEach(function (note) { lines.push(note); });
    return lines.concat(renderStores(group.stores)).join("\n");
  }

  function renderCases(items) {
    var dates = [];
    items.forEach(function (item) {
      var day = dates.length && dates[dates.length - 1].date === item.date ? dates[dates.length - 1] : null;
      if (!day) { day = { date: item.date, clients: [] }; dates.push(day); }
      var client = null;
      for (var c = 0; c < day.clients.length; c += 1) {
        if (day.clients[c].name === item.client) { client = day.clients[c]; break; }
      }
      if (!client) { client = { name: item.client, groups: [] }; day.clients.push(client); }
      var key = groupKey(item);
      var group = null;
      for (var g = 0; g < client.groups.length; g += 1) {
        if (client.groups[g].key === key) { group = client.groups[g]; break; }
      }
      if (!group) { group = { key: key, item: item, stores: [] }; client.groups.push(group); }
      group.stores.push(item.store);
    });
    return dates.map(function (day) {
      return "【" + dateLabel(day.date, false) + "】\n" + day.clients.map(function (client) {
        return "※" + client.name + "\n" + client.groups.map(renderGroup).join("\n\n");
      }).join("\n\n");
    }).join("\n\n");
  }

  function compose(cases, request) {
    if (!request || SUBJECTS.indexOf(request.subject) === -1) {
      var subjectError = new Error("件名は指定の4種類から選択してください。");
      subjectError.code = "INVALID_SUBJECT";
      throw subjectError;
    }
    if (!Array.isArray(cases)) {
      var inputError = new Error("案件データは配列で指定してください。");
      inputError.code = "INVALID_CASES";
      throw inputError;
    }
    var warnings = [];
    var items = [];
    cases.forEach(function (source, index) {
      var item = normalizeCase(source, index, warnings);
      if (item) items.push(item);
    });
    if (!items.length) {
      var emptyError = new Error("募集文に掲載できる案件がありません。入力内容・募集状態を確認してください。");
      emptyError.code = "NO_ELIGIBLE_CASES";
      emptyError.warnings = warnings;
      throw emptyError;
    }
    items.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.sourceIndex - b.sourceIndex; });
    var notice = normalizeNotice(request.notice);
    var prefix = INTRO + (notice ? "＜お知らせ＞\n" + notice + "\n\n" : "") + CONDITIONS;
    return {
      subject: request.subject,
      body: prefix + "\n\n" + renderCases(items),
      caseCount: items.length,
      warnings: warnings
    };
  }

  return {
    compose: compose,
    subjects: function () { return SUBJECTS.slice(); },
    normalizeNotice: normalizeNotice
  };
}());

if (typeof module !== "undefined" && module.exports) module.exports = LK_RM_CORE_V1;
