/* STV SOR Trace Viewer — mobile core (stage M1).
 * Read-only SOR (Telcordia SR-4731 v2) reader and the measurement logic of
 * STV 0.4.0 (desktop), ported 1:1 from Python:
 *   importers/sor.py + otdrparser 0.2.3  -> parseSor()
 *   quality.py                          -> evaluate(), combine(), profiles
 *   sections.py                         -> buildRows(), traceChecks()
 *   losses.py                           -> makeContext(), sectionLoss(), cumulativeAt(), spanTotal()
 *   span.py                             -> computeSpan()
 * The SOR reader follows otdrparser 0.2.3 (BSD-2-Clause, (c) its authors),
 * itself based on pyOTDR and the SR-4731 reverse-engineering notes.
 * No Qt, no DOM: runs in a browser and in Node (for verification against the desktop).
 */
(function (root) {
  "use strict";
  var C_M = 0.299792458 * 1000; // speed of light, m/us

  // ------------------------------------------------------------------ reader
  function Reader(buf, start, end) {
    this.dv = new DataView(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength);
    this.pos = start || 0;
    this.end = end === undefined ? this.dv.byteLength : end;
  }
  Reader.prototype.need = function (n) {
    if (this.pos + n > this.end) throw new Error("файл обрезан: ожидалось ещё " + n + " байт");
  };
  Reader.prototype.u2 = function () { this.need(2); var v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; };
  Reader.prototype.s2 = function () { this.need(2); var v = this.dv.getInt16(this.pos, true); this.pos += 2; return v; };
  Reader.prototype.u4 = function () { this.need(4); var v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; };
  Reader.prototype.s4 = function () { this.need(4); var v = this.dv.getInt32(this.pos, true); this.pos += 4; return v; };
  Reader.prototype.zstr = function () {
    var s = "";
    for (;;) {
      if (this.pos >= this.end) throw new Error("файл обрезан внутри строки");
      var c = this.dv.getUint8(this.pos++);
      if (c === 0) return s.trim();
      s += String.fromCharCode(c); // latin-1
    }
  };
  Reader.prototype.fstr = function (n) {
    this.need(n); var s = "";
    for (var i = 0; i < n; i++) s += String.fromCharCode(this.dv.getUint8(this.pos + i));
    this.pos += n; return s.trim();
  };

  var FIBER_TYPES = { 0: 1, 651: 1, 652: 1, 653: 1, 654: 1, 655: 1 };

  function parseMap(r) {
    var m = { name: r.zstr(), version: r.u2() / 100, numbytes: r.u4(), numblocks: r.u2(), maps: [] };
    if (m.name !== "Map") throw new Error("это не SOR версии 2 (нет блока Map)");
    if (!(m.version >= 2 && m.version < 3)) throw new Error("поддерживается только SOR версии 2 (в файле " + m.version + ")");
    if (m.numbytes <= 0 || m.numblocks < 1) throw new Error("неверный блок Map");
    for (var i = 1; i < m.numblocks; i++) {
      var e = { name: r.zstr(), version: r.u2() / 100, numbytes: r.u4() };
      if (e.numbytes <= 0) throw new Error("неверный размер блока " + e.name);
      m.maps.push(e);
    }
    return m;
  }

  function parseGen(r) {
    var d = {};
    d.name = r.zstr();
    if (r.fstr(1) !== "\u0000") { r.pos -= 1; } // optional extra \0 after the name
    var save = r.pos, lang = r.fstr(2);
    if (/^[A-Z]{2}$/.test(lang)) d.language = lang; else r.pos = save;
    d.cable_id = r.zstr();
    d.fiber_id = r.zstr();
    for (;;) { var ft = r.s2(); if (FIBER_TYPES[ft]) { d.fiber_type = ft; break; } }
    d.wavelength = r.u2();
    d.location_a = r.zstr(); d.location_b = r.zstr(); d.cable_code = r.zstr();
    d.build_condition = r.fstr(2);
    d.user_offset = r.s4(); d.user_offset_distance = r.s4();
    d.operator = r.zstr(); d.comments = r.zstr();
    return d;
  }

  function parseSup(r) {
    return { name: r.zstr(), supplier_name: r.zstr(), otdr_name: r.zstr(), otdr_serial_number: r.zstr(),
      module_name: r.zstr(), module_serial_number: r.zstr(), software_version: r.zstr(), other: r.zstr() };
  }

  function parseFxd(r) {
    var d = { name: r.zstr(), date_time: r.u4(), units: r.fstr(2), wavelength: r.u2() / 10,
      acquisition_offset: r.s4(), acquisition_offset_distance: r.s4(), number_of_pulse_width_entries: r.u2() };
    if (d.number_of_pulse_width_entries !== 1) throw new Error("несколько длительностей импульса в одном файле не поддерживаются");
    d.pulse_width = r.u2(); d.sample_spacing = r.u4(); d.number_of_data_points = r.u4();
    d.index_of_refraction = r.u4() / 100000; d.backscattering_coefficient = r.u2() * -0.1;
    d.number_of_averages = r.u4(); d.averaging_time = r.u2() * 0.1; d.range = r.u4() * 2e-5;
    d.acquisition_range_distance = r.s4(); d.front_panel_offset = r.s4(); d.noise_floor_level = r.u2();
    d.noise_floor_scaling_factor = r.s2(); d.power_offset_first_point = r.u2();
    d.loss_threshold = r.u2() * 0.001; d.reflection_threshold = r.u2() * -0.001;
    d.end_of_transmission_threshold = r.u2() * 0.001; d.trace_type = r.fstr(2);
    if (d.sample_spacing <= 0) throw new Error("шаг отсчётов должен быть > 0");
    if (d.index_of_refraction <= 0) throw new Error("показатель преломления должен быть > 0");
    return d;
  }

  function parseData(r, spacing, ior) {
    var d = { name: r.zstr(), n: r.u4(), traces: r.u2() };
    if (d.traces !== 1) throw new Error("несколько трасс в одном файле не поддерживаются");
    var n2 = r.u4(), sf = r.u2();
    if (n2 !== d.n) throw new Error("число точек в DataPts не согласовано");
    if (sf <= 0) throw new Error("масштаб DataPts должен быть > 0");
    r.need(2 * d.n);
    var x = new Float64Array(d.n), y = new Float64Array(d.n);
    var step = spacing / 1e8 * C_M / ior;
    for (var i = 0; i < d.n; i++) {
      x[i] = i * step;
      y[i] = r.dv.getUint16(r.pos, true) * -sf / 1e6; r.pos += 2;
    }
    d.x = x; d.y = y;
    return d;
  }

  function parseKey(r, ior) {
    var d = { name: r.zstr(), events: [] };
    var count = r.u2();
    for (var i = 0; i < count; i++) {
      var e = { event_number: r.u2(), time_of_travel: r.u4() * 0.1, slope: r.s2() * 0.001,
        splice_loss: r.s2() * 0.001, reflection_loss: r.s4() * 0.001, event_type: r.fstr(8) };
      r.s4(); r.s4(); r.s4(); r.s4(); r.s4(); // markers
      e.comment = r.zstr();
      e.distance = e.time_of_travel / 1000 * C_M / ior;
      d.events.push(e);
    }
    d.total_loss = r.s4() * 0.001;
    d.fiber_start_position = r.s4() / 10000 * C_M / ior;
    d.fiber_length = r.s4() / 10000 * C_M / ior;
    d.optical_return_loss = r.u2() * 0.001;
    return d;
  }

  function parseBlocks(bytes) {
    var r = new Reader(bytes, 0);
    var map = parseMap(r);
    var blocks = { Map: map }, fxd = null, order = ["Map"];
    for (var i = 0; i < map.maps.length; i++) {
      var ent = map.maps[i], start = r.pos, end = start + ent.numbytes;
      if (end > r.dv.byteLength) throw new Error("файл обрезан в блоке " + ent.name);
      var br = new Reader(bytes, start, end), b;
      if (ent.name === "GenParams") b = parseGen(br);
      else if (ent.name === "SupParams") b = parseSup(br);
      else if (ent.name === "FxdParams") { b = parseFxd(br); fxd = b; }
      else if (ent.name === "DataPts") {
        if (!fxd) throw new Error("DataPts раньше FxdParams");
        b = parseData(br, fxd.sample_spacing, fxd.index_of_refraction);
      } else if (ent.name === "KeyEvents") {
        if (!fxd) throw new Error("KeyEvents раньше FxdParams");
        b = parseKey(br, fxd.index_of_refraction);
      } else b = { name: br.zstr() };
      if (b.name !== ent.name) throw new Error("ожидался блок " + ent.name + ", найден " + b.name);
      if (!(ent.name in blocks)) blocks[ent.name] = b;
      order.push(ent.name);
      r.pos = end;
    }
    if (!blocks.FxdParams || !blocks.DataPts) throw new Error("в файле нет обязательных блоков FxdParams/DataPts");
    blocks._order = order;
    return blocks;
  }

  function finite(v) { return typeof v === "number" && isFinite(v) ? v : null; }

  /** Parse SOR bytes -> Measurement (same fields and meaning as desktop model.py). */
  function parseSor(bytes, name) {
    if (!bytes || bytes.byteLength === 0) throw new Error("Файл пуст");
    var b = parseBlocks(bytes);
    var fx = b.FxdParams, gp = b.GenParams || {}, sp = b.SupParams || {}, ke = b.KeyEvents || { events: [] };
    var x = b.DataPts.x, y = b.DataPts.y;
    if (fx.acquisition_offset) {
      var off = fx.acquisition_offset * 1e-10 * 299792458.0 / fx.index_of_refraction;
      for (var i = 0; i < x.length; i++) x[i] += off;
    }
    if (x.length < 2) throw new Error("Для графика нужны как минимум две точки");
    var nominal = null;
    [gp.wavelength, fx.wavelength].some(function (w) { var v = finite(w); if (v !== null && v > 0) { nominal = v; return true; } return false; });
    var events = ke.events.map(function (e, i) {
      return { number: e.event_number || i + 1, distance: e.distance, loss: e.splice_loss, refl: e.reflection_loss,
        comment: e.comment || "", typeCode: e.event_type || "", slope: finite(e.slope) };
    });
    var params = [];
    function add(k, v) { if (v !== null && v !== undefined && v !== "") params.push([k, String(v)]); }
    if (fx.date_time > 0) add("Дата измерения (UTC)", new Date(fx.date_time * 1000).toISOString().replace("T", " ").slice(0, 19));
    add("Начало отсчётов", x[0].toFixed(6) + " м");
    add("Длина волны", fx.wavelength ? fx.wavelength + " нм" : (gp.wavelength ? gp.wavelength + " нм" : null));
    add("Длина волны для порогов", nominal === null ? null : fmtG(nominal) + " нм");
    add("Ширина импульса", fx.pulse_width ? fx.pulse_width + " нс" : null);
    add("Показатель преломления", fx.index_of_refraction);
    add("Время усреднения", fx.averaging_time ? fmtG(round(fx.averaging_time, 3)) + " с" : null);
    add("Волокно", gp.fiber_id); add("Кабель", gp.cable_id);
    add("Прибор", sp.otdr_name || sp.module_name);
    add("Серийный номер", sp.otdr_serial_number || sp.module_serial_number);
    add("Потеря линии", ke.total_loss !== undefined ? fmtG(round(ke.total_loss, 3)) + " дБ" : null);
    add("Длина волокна", ke.fiber_length !== undefined ? ke.fiber_length + " м" : null);
    add("ORL линии (SOR)", ke.optical_return_loss !== undefined ? fmtG(round(ke.optical_return_loss, 3)) + " дБ" : null);
    for (var j = 1; j < x.length; j++) if (!(x[j] > x[j - 1])) throw new Error("Расстояния точек должны возрастать");
    return { source: name || "trace.sor", distance: x, signal: y, params: params, events: events,
      wavelength: nominal, totalLoss: finite(ke.total_loss), orl: finite(ke.optical_return_loss),
      fiberLength: finite(ke.fiber_length), fiberStart: finite(ke.fiber_start_position),
      instrument: [sp.supplier_name, sp.otdr_name].filter(Boolean).join(" "), blocks: b._order };
  }
  function round(v, n) { var p = Math.pow(10, n); return Math.round(v * p) / p; }
  function fmtG(v) { return String(Number(v)); }

  // ------------------------------------------------------------- events
  function reflectionClass(e) { return { "0": "non-reflective", "1": "reflective", "2": "saturated-reflective" }[e.typeCode.charAt(0)] || null; }
  function isEndOfFiber(e) { var c = e.typeCode.charAt(1); return c === "E" || c === "D"; }

  // ------------------------------------------------------------ quality
  var Status = { PASS: "pass", WARN: "warn", FAIL: "fail", NO_DATA: "no_data" };
  var STATUS_TEXT = { pass: "Норма", warn: "Внимание", fail: "Нарушение", no_data: "Нет данных" };
  var DEFAULT_PALETTE = { pass: "#2e9e48", warn: "#e0b000", fail: "#d93025", no_data: "#9e9e9e" };
  var METRICS = [
    { id: "splice_loss", title: "Splice loss (потеря сварки)", unit: "дБ", dirs: ["upper", "interval"] },
    { id: "connector_loss", title: "Connector loss (потеря соединителя)", unit: "дБ", dirs: ["upper", "interval"] },
    { id: "reflectance", title: "Reflectance (отражение)", unit: "дБ", dirs: ["upper", "interval"] },
    { id: "slope", title: "Slope (затухание)", unit: "дБ/км", dirs: ["upper", "interval"] },
    { id: "total_loss", title: "Total loss (потери линии)", unit: "дБ", dirs: ["upper", "interval"] },
    { id: "total_orl", title: "Total ORL", unit: "дБ", dirs: ["lower", "interval"], nonneg: true },
    { id: "fiber_length", title: "Fiber length (длина волокна)", unit: "м", dirs: ["lower", "upper", "interval"], nonneg: true }
  ];
  var METRIC_BY_ID = {}; METRICS.forEach(function (m) { METRIC_BY_ID[m.id] = m; });
  var LIMIT_KEYS = ["warn_low", "fail_low", "warn_high", "fail_high"];

  function wavelengthKey(nm) {
    if (nm === null || nm === undefined || !isFinite(nm) || nm <= 0) return null;
    return String(round(nm, 3));
  }
  function newProfile(name) {
    var p = { name: name || "Пользовательский профиль 1", checksEnabled: true, rules: {}, limits: {} };
    METRICS.forEach(function (m) { p.rules[m.id] = { enabled: true, direction: m.dirs[0] }; });
    return p;
  }
  function relevantKeys(dir) { return { upper: ["warn_high", "fail_high"], lower: ["warn_low", "fail_low"], interval: LIMIT_KEYS }[dir]; }
  function validateLimits(metricId, dir, v) {
    var m = METRIC_BY_ID[metricId], errors = [];
    if (m.dirs.indexOf(dir) < 0) return ["направление недопустимо"];
    var keys = relevantKeys(dir), any = false;
    keys.forEach(function (k) {
      var x = v[k];
      if (x !== null && x !== undefined) {
        any = true;
        if (!isFinite(x)) errors.push("значение должно быть конечным числом");
        if (m.nonneg && x < 0) errors.push("значение не может быть отрицательным");
      }
    });
    if (errors.length || !any) return errors;
    function has(k) { return v[k] !== null && v[k] !== undefined; }
    if (dir === "upper") { if (has("warn_high") && has("fail_high") && v.warn_high > v.fail_high) errors.push("предупредительный порог должен быть не больше аварийного"); }
    else if (dir === "lower") { if (has("warn_low") && has("fail_low") && v.warn_low < v.fail_low) errors.push("предупредительный порог должен быть не меньше аварийного"); }
    else {
      var lows = ["fail_low", "warn_low"].filter(has).map(function (k) { return v[k]; });
      var highs = ["warn_high", "fail_high"].filter(has).map(function (k) { return v[k]; });
      if (!lows.length || !highs.length) errors.push("для интервала нужен хотя бы один нижний и один верхний порог");
      if (has("fail_low") && has("warn_low") && v.fail_low > v.warn_low) errors.push("нижний аварийный порог должен быть не больше нижнего предупредительного");
      if (has("warn_high") && has("fail_high") && v.warn_high > v.fail_high) errors.push("верхний предупредительный порог должен быть не больше верхнего аварийного");
      if (lows.length && highs.length && Math.max.apply(null, lows) >= Math.min.apply(null, highs)) errors.push("нижние пороги должны быть меньше верхних");
    }
    return errors;
  }
  function limitText(dir, v, unit) {
    function f(x) { return x === null || x === undefined ? "—" : fmtG(x); }
    if (dir === "upper") return "≤ " + f(v.warn_high) + " предупр., ≤ " + f(v.fail_high) + " авар. " + unit;
    if (dir === "lower") return "≥ " + f(v.warn_low) + " предупр., ≥ " + f(v.fail_low) + " авар. " + unit;
    return "авар. [" + f(v.fail_low) + "; " + f(v.fail_high) + "], предупр. [" + f(v.warn_low) + "; " + f(v.warn_high) + "] " + unit;
  }
  function check(metricId, status, value, wl, limit, reason) { return { metric: metricId, status: status, value: value, wl: wl, limit: limit, reason: reason }; }
  function describe(c) {
    var m = METRIC_BY_ID[c.metric];
    var val = c.value === null || c.value === undefined ? "—" : c.value.toFixed(3) + " " + m.unit;
    return m.title + ": " + STATUS_TEXT[c.status] + ". Значение: " + val + "; порог: " + c.limit + "; длина волны: " +
      (c.wl ? c.wl + " нм" : "не определена") + "; причина: " + c.reason;
  }
  function evaluate(profile, metricId, value, wavelength, missingReason) {
    var m = METRIC_BY_ID[metricId], wl = wavelengthKey(wavelength);
    function nd(reason, lt) { return check(metricId, Status.NO_DATA, value, wl, lt || "не применяется", reason); }
    if (!profile) return nd("профиль не выбран");
    if (!profile.checksEnabled) return nd("все проверки отключены в профиле");
    var rule = profile.rules[metricId];
    if (!rule.enabled) return nd("критерий выключен");
    if (value === null || value === undefined || !isFinite(value)) return nd(missingReason || "величина отсутствует в данных");
    if (wl === null) return nd("длина волны трассы не определена — настроить");
    var v = (profile.limits[wl] || {})[metricId];
    var keys = relevantKeys(rule.direction);
    if (!v || keys.every(function (k) { return v[k] === null || v[k] === undefined; })) return nd("для " + wl + " нм порог не задан — настроить");
    if (validateLimits(metricId, rule.direction, v).length) return nd("пороги заданы некорректно");
    var text = limitText(rule.direction, v, m.unit), st = Status.PASS, reason = "в пределах порогов";
    function has(k) { return v[k] !== null && v[k] !== undefined; }
    if (rule.direction === "upper" || rule.direction === "interval") {
      if (has("fail_high") && value > v.fail_high) { st = Status.FAIL; reason = "больше аварийного порога " + fmtG(v.fail_high); }
      else if (has("warn_high") && value > v.warn_high) { st = Status.WARN; reason = "больше предупредительного порога " + fmtG(v.warn_high); }
    }
    if (st === Status.PASS && (rule.direction === "lower" || rule.direction === "interval")) {
      if (has("fail_low") && value < v.fail_low) { st = Status.FAIL; reason = "меньше аварийного порога " + fmtG(v.fail_low); }
      else if (has("warn_low") && value < v.warn_low) { st = Status.WARN; reason = "меньше предупредительного порога " + fmtG(v.warn_low); }
    }
    return check(metricId, st, value, wl, text, reason);
  }
  function combine(list) {
    var s = list.map(function (c) { return c.status; });
    if (s.indexOf("fail") >= 0) return "fail";
    if (s.indexOf("warn") >= 0) return "warn";
    if (s.indexOf("pass") >= 0) return "pass";
    return "no_data";
  }

  // ------------------------------------------------------------ order
  function physicalOrder(m) {
    var valid = [], invalid = [];
    m.events.forEach(function (e, i) { (isFinite(e.distance) ? valid : invalid).push(i); });
    valid.sort(function (a, b) { return m.events[a].distance - m.events[b].distance || a - b; });
    return { valid: valid, invalid: invalid };
  }
  function endOfFiberIndex(m, ordered) {
    for (var i = 0; i < ordered.length; i++) if (isEndOfFiber(m.events[ordered[i]])) return ordered[i];
    return null;
  }

  // ------------------------------------------------------------ losses
  var SOURCE_SECTION = "расчёт: затухание из SOR (lead-in slope события в конце участка) × длина участка";
  function V(value, reason, estimate) { return { value: value === undefined ? null : value, reason: reason || "", estimate: !!estimate }; }
  function coefficient(slope) {
    if (slope === null || slope === undefined || !isFinite(slope)) return V(null, "затухание участка отсутствует в SOR");
    if (slope === 0) return V(null, "в SOR записано 0.000 дБ/км — затухание участка не задано");
    if (slope < 0) return V(null, "в SOR отрицательное затухание " + slope.toFixed(3) + " дБ/км — недостоверно");
    return V(slope, SOURCE_SECTION);
  }
  function sectionLoss(slope, length) {
    if (length === null || length === undefined || !isFinite(length) || length <= 0) return V(null, "длина участка не определена");
    var k = coefficient(slope);
    if (k.value === null) return k;
    return V(k.value * length / 1000, SOURCE_SECTION);
  }
  function buildProfile(m) {
    var o = physicalOrder(m).valid, eof = endOfFiberIndex(m, o);
    var used = eof === null ? o : o.slice(0, o.indexOf(eof) + 1);
    var start = Math.max(m.fiberStart !== null && m.fiberStart !== undefined ? m.fiberStart : 0, 0);
    var prof = { segments: [], events: used, eof: eof, fiberStart: start };
    var prev = start, label = "начало волокна";
    used.forEach(function (idx) {
      var e = m.events[idx], d = e.distance;
      if (d > prev + 0.5) prof.segments.push({ start: prev, end: d, slope: coefficient(e.slope), endEvent: idx, label: label + " → событие №" + e.number });
      prev = Math.max(prev, d); label = "событие №" + e.number;
    });
    return prof;
  }
  function eventLoss(m, idx) {
    var e = m.events[idx];
    if (isEndOfFiber(e)) return V(0, "конец волокна: потеря события не учитывается");
    if (e.loss === null || e.loss === undefined || !isFinite(e.loss)) return V(null, "потеря события №" + e.number + " отсутствует в SOR");
    return V(e.loss, "записано в SOR");
  }
  function lossBetween(m, prof, a, b, includeAt) {
    if (!isFinite(a) || !isFinite(b) || b < a) return V(null, "границы не определены");
    if (prof.eof !== null && b > m.events[prof.eof].distance + 1e-6) return V(null, "граница за событием «конец волокна» — потери не определены");
    var total = 0, eps = 1e-6, i;
    if (includeAt !== null && includeAt !== undefined) {
      var v0 = eventLoss(m, includeAt); if (v0.value === null) return v0; total += v0.value;
    }
    for (i = 0; i < prof.segments.length; i++) {
      var s = prof.segments[i], lo = Math.max(s.start, a), hi = Math.min(s.end, b);
      if (hi - lo <= eps) continue;
      if (s.slope.value === null) return V(null, "участок " + s.label + ": " + s.slope.reason);
      total += s.slope.value * (hi - lo) / 1000;
    }
    if (prof.segments.length && a < prof.segments[0].start - eps && b > a + eps) return V(null, "граница раньше начала волокна — затухание до начала не задано");
    for (i = 0; i < prof.events.length; i++) {
      var d = m.events[prof.events[i]].distance;
      if (a + eps < d && d < b - eps) { var v = eventLoss(m, prof.events[i]); if (v.value === null) return v; total += v.value; }
    }
    return V(total, SOURCE_SECTION + " + потери событий из SOR");
  }
  function fullFiberCheck(m, prof) {
    prof = prof || buildProfile(m);
    var rec = m.totalLoss;
    if (prof.eof === null) return { computed: V(null, "нет события «конец волокна»"), recorded: rec, diff: null, tol: null, text: "сверка невозможна: в SOR нет события «конец волокна»" };
    var end = m.events[prof.eof].distance, first = prof.events.length ? prof.events[0] : null;
    var include = first !== null && m.events[first].distance <= prof.fiberStart + 0.5 ? first : null;
    var c = lossBetween(m, prof, prof.fiberStart, end, include);
    if (c.value === null) return { computed: c, recorded: rec, diff: null, tol: null, text: "сумма составляющих не рассчитана: " + c.reason };
    if (rec === null || rec === undefined) return { computed: c, recorded: null, diff: null, tol: null, text: "в SOR нет Total loss для сверки" };
    var tol = 0.0005 * (end - prof.fiberStart) / 1000 + 0.0005 * (prof.events.length + 1);
    var diff = c.value - rec, text;
    if (Math.abs(diff) <= tol) text = "сумма составляющих " + c.value.toFixed(3) + " дБ совпадает с Total loss прибора " + rec.toFixed(3) + " дБ в пределах округления (±" + tol.toFixed(3) + " дБ)";
    else text = "сумма составляющих " + c.value.toFixed(3) + " дБ отличается от Total loss прибора " + rec.toFixed(3) + " дБ на " + (diff >= 0 ? "+" : "") + diff.toFixed(3) + " дБ: прибор определил итог другим способом (например, по уровням трассы). Потери участков — оценка по коэффициентам затухания из SOR";
    return { computed: c, recorded: rec, diff: diff, tol: tol, text: text };
  }
  function makeContext(m, allowEstimates) {
    var prof = buildProfile(m), chk = fullFiberCheck(m, prof);
    var ctx = { m: m, profile: prof, check: chk, allowEstimates: !!allowEstimates };
    ctx.trusted = chk.diff !== null && Math.abs(chk.diff) <= chk.tol;
    ctx.gate = function (v) {
      if (v.value === null || ctx.trusted) return v;
      if (ctx.allowEstimates) return V(v.value, "ОЦЕНКА, не подтверждена прибором: " + chk.text, true);
      return V(null, "не рассчитано: " + chk.text);
    };
    return ctx;
  }
  function cumulativeAt(ctx, span, pos, atBeginEvent) {
    if (!span || !span.valid) return V(null, "Span некорректен");
    var eps = 1e-6;
    if (pos < span.begin - eps) return V(null, "до начала Span");
    if (pos > span.end + eps) return V(null, "за концом Span");
    if (atBeginEvent || Math.abs(pos - span.begin) <= eps) return ctx.gate(V(0, "начало Span"));
    var include = null;
    if (span.includeBegin) {
      if (span.beginEvent === null) return V(null, "Include Begin loss: начало Span не совпадает с событием — потеря начала не определена");
      include = span.beginEvent;
    }
    return ctx.gate(lossBetween(ctx.m, ctx.profile, span.begin, pos, include));
  }
  function spanTotal(ctx, span) {
    if (!span || !span.valid) return V(null, "Span некорректен");
    var v = cumulativeAt(ctx, span, span.end);
    if (v.value === null) return v;
    var total = v.value, reason = v.reason;
    if (span.includeEnd) {
      if (span.endEvent === null) return V(null, "Include End loss: конец Span не совпадает с событием — потеря конца не определена");
      if (isEndOfFiber(ctx.m.events[span.endEvent])) reason += "; Include End loss: конец Span — «конец волокна», его потеря (спад в шум) не учитывается";
      else { var e = eventLoss(ctx.m, span.endEvent); if (e.value === null) return e; total += e.value; }
    }
    return V(total, reason, v.estimate);
  }

  // ------------------------------------------------------------ span
  function defaultSpanSettings() {
    return { beginEnabled: false, beginMode: "index", beginIndex: 1, beginLength: 0,
      endEnabled: false, endMode: "reverse_index", endIndex: 1, endLength: 0, includeBegin: false, includeEnd: false };
  }
  function reverseReference(m) {
    var o = physicalOrder(m).valid, eof = endOfFiberIndex(m, o);
    return eof === null ? o : o.slice(0, o.indexOf(eof) + 1);
  }
  function computeSpan(m, s, ctx) {
    var r = { valid: false, errors: [], begin: null, end: null, beginText: "", endText: "", beginEvent: null, endEvent: null,
      includeBegin: s.includeBegin, includeEnd: s.includeEnd, boundaryLoss: null, boundaryText: "", total: null, totalEstimate: false, totalText: "не рассчитано" };
    var o = physicalOrder(m).valid, ref = reverseReference(m), ev = m.events;
    var x0 = m.distance[0], x1 = m.distance[m.distance.length - 1];
    if (!s.beginEnabled) {
      if (o.length) { r.beginEvent = o[0]; r.begin = ev[o[0]].distance; r.beginText = "событие №" + ev[o[0]].number + " (первое событие)"; }
      else { r.begin = x0; r.beginText = "начало трассы"; }
    } else if (s.beginMode === "index") {
      if (s.beginIndex >= 1 && s.beginIndex <= o.length) { var bi = o[s.beginIndex - 1]; r.beginEvent = bi; r.begin = ev[bi].distance; r.beginText = "Index " + s.beginIndex + ": событие №" + ev[bi].number; }
      else r.errors.push("Index начала " + s.beginIndex + " вне диапазона 1…" + o.length);
    } else {
      if (!isFinite(s.beginLength) || s.beginLength < 0) r.errors.push("длина запускного шнура должна быть ≥ 0");
      else { r.begin = s.beginLength; r.beginText = "Length: " + s.beginLength.toFixed(3) + " м от начала"; }
    }
    if (!s.endEnabled) {
      if (ref.length) { var ei = ref[ref.length - 1]; r.endEvent = ei; r.end = ev[ei].distance; r.endText = "событие №" + ev[ei].number + " (" + (isEndOfFiber(ev[ei]) ? "конец волокна" : "последнее событие") + ")"; }
      else { r.end = x1; r.endText = "конец трассы"; }
    } else if (s.endMode === "reverse_index") {
      if (s.endIndex >= 1 && s.endIndex <= ref.length) { var ej = ref[ref.length - s.endIndex]; r.endEvent = ej; r.end = ev[ej].distance; r.endText = "Reverse Index " + s.endIndex + ": событие №" + ev[ej].number; }
      else r.errors.push("Reverse Index конца " + s.endIndex + " вне диапазона 1…" + ref.length);
    } else {
      var eof = endOfFiberIndex(m, o);
      if (!isFinite(s.endLength) || s.endLength < 0) r.errors.push("длина приёмного шнура должна быть ≥ 0");
      else if (eof === null) r.errors.push("в SOR нет события «конец волокна» — Reverse Length не определён");
      else { r.end = ev[eof].distance - s.endLength; r.endText = "Reverse Length: " + s.endLength.toFixed(3) + " м до конца волокна"; }
    }
    [["начало", r.begin], ["конец", r.end]].forEach(function (p) {
      if (p[1] !== null && !(x0 <= p[1] && p[1] <= x1)) r.errors.push(p[0] + " Span " + p[1].toFixed(3) + " м вне трассы");
    });
    if (r.begin !== null && r.end !== null && !(r.begin < r.end)) r.errors.push("начало Span должно быть меньше конца");
    r.valid = !r.errors.length && r.begin !== null && r.end !== null;
    r.length = r.valid ? r.end - r.begin : null;
    // boundary losses (recorded only), as desktop
    var parts = [], tot = 0, missing = [];
    [["начала", s.includeBegin, r.beginEvent], ["конца", s.includeEnd, r.endEvent]].forEach(function (p) {
      if (!p[1]) return;
      var loss = p[2] === null ? null : ev[p[2]].loss;
      if (loss === null || loss === undefined) missing.push(p[0] + (p[2] === null ? " (граница не совпадает с событием)" : ""));
      else { tot += loss; parts.push(p[0] + " " + loss.toFixed(3) + " дБ"); }
    });
    if (!r.valid) r.boundaryText = "Span некорректен";
    else if (!(s.includeBegin || s.includeEnd)) r.boundaryText = "граничные потери не включены";
    else if (missing.length) r.boundaryText = "не рассчитано: нет потери события " + missing.join(", ");
    else { r.boundaryLoss = tot; r.boundaryText = tot.toFixed(3) + " дБ (" + parts.join(" + ") + ", значения из SOR)"; }
    ctx = ctx && ctx.m === m ? ctx : makeContext(m);
    var t = spanTotal(ctx, r);
    if (t.value !== null) { r.total = t.value; r.totalEstimate = t.estimate; r.totalText = (t.estimate ? "≈ " : "") + t.value.toFixed(3) + " дБ — " + t.reason; }
    else r.totalText = t.reason.indexOf("не рассчитано") === 0 ? t.reason : "не рассчитано: " + t.reason;
    return r;
  }

  // ------------------------------------------------------------ rows
  var REPAIR_TEXT = { warn: "Проверить соединение", fail: "Проверить соединение / возможен ремонт" };
  function recordedReflectance(e) {
    var r = e.refl;
    if (r === null || r === undefined || !isFinite(r)) return [null, "отражение отсутствует в SOR"];
    if (r === 0 && reflectionClass(e) === "non-reflective") return [null, "неотражающее событие: в SOR 0.000 дБ — отражение не измерено"];
    return [r, "отражение отсутствует в SOR"];
  }
  function kindText(e) {
    var t = { "non-reflective": "неотражающее", "reflective": "отражающее", "saturated-reflective": "отражающее (насыщение)" }[reflectionClass(e)] || "не распознано";
    return isEndOfFiber(e) ? t + ", конец волокна" : t;
  }
  function eventChecks(e, profile, wl) {
    var checks = [], cls = reflectionClass(e);
    if (isEndOfFiber(e)) { var r0 = "конец волокна: потеря события не оценивается"; checks.push(evaluate(profile, "splice_loss", null, wl, r0), evaluate(profile, "connector_loss", null, wl, r0)); }
    else if (cls === "non-reflective") checks.push(evaluate(profile, "splice_loss", e.loss, wl, "потеря отсутствует в SOR"), evaluate(profile, "connector_loss", null, wl, "неотражающее событие — не соединитель"));
    else if (cls) checks.push(evaluate(profile, "splice_loss", null, wl, "отражающее событие — не сварка"), evaluate(profile, "connector_loss", e.loss, wl, "потеря отсутствует в SOR"));
    else { var r1 = "тип события в SOR не распознан (сварка/соединитель)"; checks.push(evaluate(profile, "splice_loss", null, wl, r1), evaluate(profile, "connector_loss", null, wl, r1)); }
    var rr = recordedReflectance(e);
    checks.push(evaluate(profile, "reflectance", rr[0], wl, rr[1]));
    return { checks: checks, cells: { loss: cls === "non-reflective" ? checks[0] : checks[1], reflectance: checks[2] } };
  }
  function repair(row) {
    var f = [row.cells.loss, row.cells.reflectance].filter(function (c) { return c && (c.status === "warn" || c.status === "fail"); });
    if (!f.length) return;
    row.repairStatus = f.some(function (c) { return c.status === "fail"; }) ? "fail" : "warn";
    row.repairText = REPAIR_TEXT[row.repairStatus];
    row.repairReasons = f.map(describe);
  }
  function sectionSlope(next) {
    if (next.slope === null || next.slope === undefined) return [null, "затухание отсутствует в SOR"];
    if (next.slope === 0) return [null, "в SOR записано 0.000 дБ/км — трактуется как «не задано»"];
    return [next.slope, "из SOR: lead-in slope события в конце участка"];
  }
  function buildRows(m, profile, ctx, span) {
    ctx = ctx && ctx.m === m ? ctx : makeContext(m);
    span = span || computeSpan(m, defaultSpanSettings(), ctx);
    var wl = m.wavelength, po = physicalOrder(m), valid = po.valid, eof = endOfFiberIndex(m, valid);
    var eofD = eof === null ? null : m.events[eof].distance, rows = [];
    function cum(row, pos, atEvent) {
      if (eofD !== null && pos > eofD + 1e-6) { row.cumNote = "за событием «конец волокна» — потери не определены"; return; }
      var v = cumulativeAt(ctx, span, pos, atEvent !== null && atEvent === span.beginEvent);
      row.cum = v.value; row.cumEstimate = v.estimate; row.cumNote = v.reason;
    }
    function eventRow(idx, from) {
      var e = m.events[idx], rr = recordedReflectance(e);
      var row = { kind: "event", num: String(e.number), type: kindText(e), from: from, loss: e.loss, refl: rr[0], comment: e.comment,
        note: "", eventIndex: idx, cum: null, cumNote: "", cumEstimate: false, repairStatus: null, repairText: "", repairReasons: [] };
      if (rr[0] === null && e.refl !== null && e.refl !== undefined) row.note = rr[1];
      var ec = eventChecks(e, profile, wl); row.checks = ec.checks; row.cells = ec.cells; row.status = combine(ec.checks);
      repair(row);
      return row;
    }
    valid.forEach(function (idx, pos) {
      var e = m.events[idx], row = eventRow(idx, e.distance);
      if (eofD !== null && e.distance > eofD) row.note = ["за событием «конец волокна»", row.note].filter(Boolean).join("; ");
      cum(row, e.distance, idx);
      rows.push(row);
      if (pos + 1 < valid.length) {
        var nx = m.events[valid[pos + 1]], len = nx.distance - e.distance;
        var sec = { kind: "section", num: "У" + (pos + 1), type: "Участок " + e.number + "→" + nx.number, from: e.distance, to: nx.distance,
          length: null, slope: null, secLoss: null, secNote: "", secEstimate: false, cum: null, cumNote: "", cumEstimate: false, note: "", checks: [], cells: {} };
        if (len <= 0) { sec.note = "совпадающие координаты событий — длина участка не определяется"; sec.checks = [evaluate(profile, "slope", null, wl, "участок нулевой длины")]; }
        else {
          sec.length = len;
          var ss = sectionSlope(nx); sec.slope = ss[0]; sec.note = ss[1];
          if (eofD !== null && e.distance >= eofD) sec.note += "; участок за концом волокна";
          sec.checks = [evaluate(profile, "slope", ss[0], wl, ss[1])]; sec.cells = { slope: sec.checks[0] };
          if (eofD !== null && e.distance >= eofD) { sec.secNote = "участок за концом волокна — потери не определены"; sec.cumNote = sec.secNote; }
          else {
            var v = ctx.gate(sectionLoss(nx.slope, len)); sec.secLoss = v.value; sec.secEstimate = v.estimate; sec.secNote = v.reason;
            if (span.valid && nx.distance <= span.begin + 1e-6) sec.cumNote = "участок до начала Span";
            else cum(sec, nx.distance, null);
            if (sec.cum !== null) sec.cumNote = "до конца участка (без потери события №" + nx.number + "): " + sec.cumNote;
          }
        }
        sec.status = combine(sec.checks);
        rows.push(sec);
      }
    });
    po.invalid.forEach(function (idx) {
      var row = eventRow(idx, null); row.note = "координата события некорректна — участки не строятся"; row.cumNote = "координата события некорректна"; rows.push(row);
    });
    return rows;
  }
  function traceChecks(m, profile) {
    var wl = m.wavelength, orl = m.orl, orlR = "ORL отсутствует в SOR";
    if (orl !== null && orl === 0) { orl = null; orlR = "в SOR записано ORL 0.000 дБ — трактуется как «не задано»"; }
    var len = m.fiberLength, lenR = "длина волокна отсутствует в SOR";
    if (len !== null && len <= 0) { len = null; lenR = "в SOR длина волокна ≤ 0 — не задана"; }
    return [evaluate(profile, "total_loss", m.totalLoss, wl, "потери линии отсутствуют в SOR"),
      evaluate(profile, "total_orl", orl, wl, orlR), evaluate(profile, "fiber_length", len, wl, lenR)];
  }

  var api = { parseSor: parseSor, parseBlocks: parseBlocks, reflectionClass: reflectionClass, isEndOfFiber: isEndOfFiber,
    Status: Status, STATUS_TEXT: STATUS_TEXT, DEFAULT_PALETTE: DEFAULT_PALETTE, METRICS: METRICS, METRIC_BY_ID: METRIC_BY_ID,
    wavelengthKey: wavelengthKey, newProfile: newProfile, validateLimits: validateLimits, evaluate: evaluate, combine: combine,
    describe: describe, physicalOrder: physicalOrder, sectionLoss: sectionLoss, makeContext: makeContext, fullFiberCheck: fullFiberCheck,
    cumulativeAt: cumulativeAt, spanTotal: spanTotal, defaultSpanSettings: defaultSpanSettings, computeSpan: computeSpan,
    buildRows: buildRows, traceChecks: traceChecks, recordedReflectance: recordedReflectance, REPAIR_TEXT: REPAIR_TEXT,
    reverseReference: reverseReference, version: "M1 (ядро 0.4.0)" };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.STV = api;
})(typeof window !== "undefined" ? window : this);
