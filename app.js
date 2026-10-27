/* 经济师自动化学习站 — 纯前端应用（vanilla JS，无需构建） */
const app = document.getElementById('app');
const DATA = { questions: null, plan: null, notes: null };
const state = { wrong: [], progress: {}, settings: {}, corrections: {}, session: null };
let quiz = { queue: [], idx: 0, correct: 0, wrong: 0, title: '' };
let sel = new Set();
let syncTimer = null;

/* ---------------- 本地数据库（IndexedDB） ---------------- */
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('econ_study', 1);
    r.onupgradeneeded = e => { const db = e.target.result; if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv'); };
    r.onsuccess = e => res(e.target.result);
    r.onerror = () => rej(r.error);
  });
}
async function dbGet(key) {
  const db = await openDB();
  return new Promise((res) => { const tx = db.transaction('kv', 'readonly'); const rq = tx.objectStore('kv').get(key); rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null); });
}
async function dbSet(key, val) {
  const db = await openDB();
  return new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(val, key); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
}
async function loadState() {
  state.wrong = await dbGet('wrong') || [];
  state.progress = await dbGet('progress') || { done: {}, notesDone: {}, streak: 0, lastStudy: '' };
  state.settings = await dbGet('settings') || {};
  state.corrections = await dbGet('corrections') || {};
  state.session = await dbGet('session') || null;
}
async function saveWrong() { await dbSet('wrong', state.wrong); scheduleSync(); }
async function saveProgress() { await dbSet('progress', state.progress); scheduleSync(); }
async function saveSettings() { await dbSet('settings', state.settings); }
async function saveCorrections() { await dbSet('corrections', state.corrections); }
async function saveSession() { await dbSet('session', state.session); }

/* ---------------- 数据加载 ---------------- */
/** 数据加载（C 方案：cors 代理主 → jsdelivr 兜底 → 同站兜底） */
/* 资源版本号：取 app.js 的 ?v= 参数（deploy_site.py 每次部署都会刷新）。
   2026-10-21 加：数据请求带上版本参数，避免 CF 代理 / jsDelivr / GitHub raw 的边缘缓存
   继续返回旧版 questions.json、patches.json（此前表现为「代码已更新但题库还是旧的」）。 */
function assetVer(){
  try{
    const el = document.querySelector('script[src*="app.js"]');
    const m = el && el.src.match(/[?&]v=([\w.-]+)/);
    return m ? m[1] : '';
  }catch(e){ return ''; }
}
function dataSources(name){
  const v = assetVer();
  const q = v ? ('?v=' + v) : '';
  const iso = name.split('?')[0];   // 防重复参数：调用方若已带 ?v= 也能正确取文件名
  const raw = 'https://raw.githubusercontent.com/homjanon/jingjishi/main/data/' + iso + q;
  /* 2026-10-25 调整顺序：同站第一。
     GitHub raw 的 CDN 会缓存 up to 几分钟，代理拿到的仍是旧文件（实测部署 2 分钟后
     proxy 返回 1582787 字节旧版、同站已是新版 1579247）。同站是 Pages 构建产物，
     构建完成即最新，且同域无 CORS 问题，故设为首选；代理/jsDelivr 仅作兜底。 */
  return [
    'data/' + iso + q,                                                      // ① 同站（构建完成即最新）
    'https://proxy.hellohopo.dpdns.org/?url=' + encodeURIComponent(raw),   // ② cors 代理兜底
    'https://cdn.jsdelivr.net/gh/homjanon/jingjishi@main/data/' + iso + q   // ③ jsdelivr 兜底
  ];
}
async function fetchJsonFallback(name){
  let lastErr = null;
  for(const url of dataSources(name)){
    try{
      const r = await fetch(url, {cache:'no-store'});
      if(!r.ok) throw new Error('HTTP '+r.status);
      return await r.json();
    }catch(e){ lastErr = e; }
  }
  throw lastErr || new Error('全部数据源失败: '+name);
}
async function loadData() {
  // 版本号破坏缓存：data/*.json 带 ?v，确保部署后浏览器拉到最新 app.js/plan.json/questions.json
  /* 版本参数统一由 dataSources() 追加，这里传纯文件名，避免出现 ?v=x?v=x 的双参数 */
  const [q, p, n, pat] = await Promise.all([
    fetchJsonFallback('questions.json'),
    fetchJsonFallback('plan.json'),
    fetchJsonFallback('notes.json'),
    fetchJsonFallback('patches.json').catch(() => ({}))
  ]);
  DATA.questions = q; DATA.plan = p; DATA.notes = n; DATA.patches = pat || {};
}
function findChapter(subject, cid) {
  const sub = DATA.questions[subject];
  return sub ? sub.chapters.find(c => c.id === cid) : null;
}

/* ---------------- 修正覆盖层（repo patches + 本地 corrections） ---------------- */
/* answer 规范化：兼容历史脏数据（字符串 "D" / 数组 ["D"] / "AC" / "A、C"） */
function normAnswer(a) {
  if (Array.isArray(a)) return a.map(x => String(x).trim()).filter(Boolean);
  if (typeof a === 'string') {
    const t = a.trim();
    if (!t) return [];
    if (/^[A-Za-z]+$/.test(t)) return t.split('');           // "AC" → ["A","C"]
    return t.split(/[、,，\s]+/).map(s => s.trim()).filter(Boolean);
  }
  return [];
}
function applyCorrections(q) {
  if (!q || !q.id) return q;
  let out = q;
  // 1) 官方订正库（patches.json，站点启动加载，对所有人生效）
  if (DATA.patches && DATA.patches[q.id]) {
    const p = DATA.patches[q.id];
    const okOpts = Array.isArray(p.options) && p.options.length >= 2 && p.options.every(o => typeof o === 'string' && o.trim().length > 0);
    const nAns = normAnswer(p.answer);
    const trustAns = nAns.length && (p.options == null || okOpts);
    out = Object.assign({}, out, {
      stem: (typeof p.stem === 'string' && p.stem.trim()) ? p.stem : out.stem,
      type: p.type != null ? p.type : out.type,
      options: okOpts ? p.options : out.options,
      answer: trustAns ? nAns : out.answer,
      explanation: p.explanation != null ? p.explanation : out.explanation,
      _patched: !!p.corrected
    });
  }
  // 2) 本地个人订正（覆盖层，离线可用，优先级最高）
  if (state.settings.aiCorrect === false) return out;
  const c = state.corrections[q.id];
  if (!c) return out;
  // 防御：options 必须是 ≥2 个完整选项的数组才覆盖，防止 AI 把答案字母当成选项数组
  const okOpts = Array.isArray(c.options) && c.options.length >= 2 && c.options.every(o => typeof o === 'string' && o.trim().length > 0);
  const nAns = normAnswer(c.answer);
  // 订正若携带畸形 options（同一次 AI 误判），answer 一并回退原题，避免只改答案不改选项导致错乱
  const trustAns = nAns.length && (c.options == null || okOpts);
  // 权威锁定答案（源卷逐题核对过）：个人 AI 订正不得覆盖，避免旧误判影响模考判分
  const lockedAnswer = !!(DATA.patches && DATA.patches[q.id] && DATA.patches[q.id].lock);
  return Object.assign({}, out, {
    stem: (typeof c.stem === 'string' && c.stem.trim()) ? c.stem : out.stem,
    type: c.type != null ? c.type : out.type,
    explanation: c.explanation != null ? c.explanation : out.explanation,
    answer: lockedAnswer ? out.answer : (trustAns ? nAns : out.answer),
    options: okOpts ? c.options : out.options,
    ai_explain: c.ai_explain, mnemonic: c.mnemonic, pitfall: c.pitfall,
    _corrected: !!c.corrected || !!out._patched
  });
}
function saveCorrection(qid, d) {
  if (state.settings.aiCorrect === false) return;
  const c = state.corrections[qid] || {};
  c.ai_explain = d.explain || c.ai_explain;
  c.mnemonic = d.mnemonic || c.mnemonic;
  c.pitfall = d.pitfall || c.pitfall;
  c.explanation = d.explain || c.explanation;            // 用 AI 解析替换空白/错误源解析
  if (d.sourceWrong) {                                    // 仅当 AI 判定源答案有误才覆盖答案
    c.corrected = true;
    const nAns = normAnswer(d.correctAnswer);
    if (nAns.length) c.answer = nAns;
    // correctOptions 必须是 ≥2 个完整选项数组才写入，AI 只给了答案字母就放弃覆盖选项
    if (Array.isArray(d.correctOptions) && d.correctOptions.length >= 2 && d.correctOptions.every(o => typeof o === 'string' && o.trim().length > 0)) {
      c.options = d.correctOptions;
    }
  }
  c.ts = new Date().toISOString();
  state.corrections[qid] = c;
  saveCorrections();
}
/* 把旧备份里 id 为 xxx_None 的孤儿错题，按 chapterId+题干 重新匹配到正确 id */
function migrateWrong() {
  let changed = false;
  for (const w of state.wrong) {
    if (w.qid && w.qid.indexOf('_None') >= 0 && w.chapterId && w.stem) {
      const ch = findChapter(w.subject, w.chapterId);
      if (ch && ch.questions) {
        const key = w.stem.replace(/\s/g, '').slice(0, 24);
        const m = ch.questions.find(q => q.stem && q.stem.replace(/\s/g, '').slice(0, 24) === key);
        if (m) { w.qid = m.id; changed = true; }
      }
    }
  }
  if (changed) saveWrong();
}
function clearCorrections() { state.corrections = {}; saveCorrections(); toast('已清除全部 AI 修正'); router(); }

/* ---------------- 答题会话（进度续接 + 上一题/下一题回看） ---------------- */
/* 统一的“开新答题会话”入口（2026-10-06）
   ⚠️ 必须同时设置全局 quiz 与 state.session：sessionFromQueue 只写 state.session，
   若忘记赋值全局 quiz，renderQuiz() 会渲染上一轮遗留的题目
   （历史 bug：专项强化点“练一练”却显示成错题库的题）。所有组卷入口一律走本函数。 */
function beginQuiz(queue, title, fromWrong, doneKeys, marksDone) {
  quiz = {
    queue, idx: 0, correct: 0, wrong: 0, title, fromWrong: !!fromWrong,
    _doneKeys: doneKeys || [], _marksDoneWhenComplete: !!marksDone, _answers: {}
  };
  sessionFromQueue(queue, title, !!fromWrong, quiz._doneKeys, quiz._marksDoneWhenComplete);
  renderQuiz();
}
function sessionFromQueue(queue, title, fromWrong, doneKeys, marksDone) {
  state.session = {
    active: true,
    items: queue.map(it => ({ subject: it.subject, chapterId: it.chapterId, qid: it.q.id })),
    idx: 0, correct: 0, wrong: 0, fromWrong: !!fromWrong, title,
    ts: new Date().toISOString(), doneKeys: doneKeys || [], marksDone: !!marksDone,
    answers: {}   // 每题作答记录 { qid: { sel:[index...], submitted:bool, correct:bool } }，支持回看
  };
  saveSession();
}
function quizFromSession() {
  if (!state.session || !state.session.active) return null;
  const s = state.session;
  if (s.idx >= s.items.length) { state.session = null; saveSession(); return null; }
  const queue = s.items.map(it => ({
    q: applyCorrections(findQById(it.qid) || {}), subject: it.subject, chapterId: it.chapterId,
    chapterTitle: (findChapter(it.subject, it.chapterId) || {}).title || ''
  }));
  quiz = { queue, idx: s.idx, correct: s.correct, wrong: s.wrong, title: s.title, fromWrong: s.fromWrong, _doneKeys: s.doneKeys, _marksDoneWhenComplete: s.marksDone, _answers: s.answers || {} };
  return quiz;
}
function resumeQuiz() { const q = quizFromSession(); if (q) renderQuiz(); else router(); }
function discardSession() { state.session = null; saveSession(); toast('已放弃上次进度'); router(); }
/* 会话自愈：自动清理"孤儿会话"，避免今日页「未完成答题」横幅永久残留。
   触发场景：中途关标签页/切设备 → session 从不被置否；导入备份或云同步只合并 wrong/progress/corrections，从不碰 session。
   force=true 用于导入/云拉取之后（另一台设备已有新进度，本机残留会话一律作废）。
   真正进行中的会话（idx>0 或刚建 <10 分钟）不受影响，「🔁 继续答题」照常可用。 */
function validateSession(force) {
  if (!state.session || !state.session.active) return false;
  const s = state.session;
  const kill = () => { state.session = null; saveSession(); return true; };
  if (!Array.isArray(s.items) || !s.items.length) return kill();
  if (s.idx >= s.items.length) return kill();                       // 已答完却没进结算页
  const sub = (s.items[0] && s.items[0].subject) || ((s.doneKeys && s.doneKeys[0] || '').split(':')[0]);
  if (!s.fromWrong && sub && subjectDoneToday(sub)) return kill();  // 今日该科已完成 → 旧会话必冗余
  if (force) return kill();                                         // 导入 / 云同步之后
  if (s.idx === 0 && s.ts && Date.now() - new Date(s.ts).getTime() > 10 * 60 * 1000) return kill(); // 开了头但零进度的孤儿
  return false;
}

/* ---------------- 日期 / 计划 ---------------- */
function localToday() { const d = new Date(); const off = d.getTimezoneOffset(); return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10); }
function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000); }
/* 艾宾浩斯记忆曲线间隔（天）：1→2→4→7→15→30 */
const EB_INTERVALS = [1, 2, 4, 7, 15, 30];
const EB_MAX = EB_INTERVALS.length - 1;
function addDays(dateStr, n) { const d = new Date(dateStr + 'T00:00:00'); d.setDate(d.getDate() + n); const off = d.getTimezoneOffset(); return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10); }
function isDue(w) { return !w.due || daysBetween(w.due, localToday()) >= 0; }
function shuffleArr(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function shuffleOpts(q) { if (Array.isArray(q.options)) q.options = shuffleArr(q.options.slice()); return q; }
function todaysChapters() {
  const days = (DATA.plan && DATA.plan.days) || [];
  const today = localToday();
  if (!days.length) return { finished: true };
  if (today < days[0].date) return { notStarted: true, days: daysBetween(today, days[0].date) };
  const d = days.find(x => x.date === today);
  if (!d) return { finished: true };
  const eco = d.economy ? sliceChapter('economy', d.economy) : null;
  const bus = d.business ? sliceChapter('business', d.business) : null;
  return { day: d, economy: eco, business: bus };
}
function sliceChapter(sub, spec) {
  const ch = findChapter(sub, spec.chapter);
  if (!ch) return null;
  const total = ch.questions ? ch.questions.length : 0;
  const from = spec.from || 0;
  const to = (spec.to == null) ? total : spec.to;
  return Object.assign({}, ch, { _from: from, _to: to, _note: spec.note || null, _total: total });
}

/* ---------------- 工具 ---------------- */
function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._tm); t._tm = setTimeout(() => t.classList.remove('show'), 2200);
}
function esc(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
/* 题干/材料渲染（2026-09-12）：支持「|」表格行语法——连续以|开头的行渲染为 HTML 表格，
   首行为表头；其余行按原文换行保留（配合 .stem 的 pre-wrap）。 */
function renderStem(text) {
  const lines = String(text || '').split('\n');
  let html = '', tbl = [];
  const flushTbl = () => {
    if (!tbl.length) return;
    html += '<table class="stem-table">' + tbl.map((row, ri) =>
      '<tr>' + row.map(c => `<${ri === 0 ? 'th' : 'td'}>${esc(c)}</${ri === 0 ? 'th' : 'td'}>`).join('') + '</tr>'
    ).join('') + '</table>';
    tbl = [];
  };
  for (const ln of lines) {
    if (/^\s*\|/.test(ln)) {
      const cells = ln.split('|').slice(1).map(s => s.trim());
      if (cells.length && cells[cells.length - 1] === '') cells.pop();
      /* 防御（2026-09-12）：末格异常长 = 表格行后粘连的正文（题干等），
         移出表格单独成行，避免题干被吞进表格最后一格。
         依据：全库合法单元格最长 11 字（年金现值系数（10%）），阈值取 12。 */
      let tailCell = '';
      if (cells.length > 1 && cells[cells.length - 1].length > 12) tailCell = cells.pop();
      tbl.push(cells);
      if (tailCell) { flushTbl(); html += esc(tailCell) + '\n'; }
    } else {
      flushTbl();
      html += esc(ln) + '\n';
    }
  }
  flushTbl();
  return html;
}

/* ---------------- 错题库 ---------------- */
/* 找案例材料题：在所属章内向前 6 题扫「案例（N）」材料题；本题自己就是材料题则返回 null
   2026-09-03 收紧：仅认「题干以案例（N）开头」的材料题——防止题干中间含"案例"字样的
   普通题被误判为材料题，导致独立单选/多选题错挂无关案例材料 */
function findCaseMaterial(subject, chapterId, qid) {
  const ch = findChapter(subject, chapterId);
  if (!ch || !ch.questions) return null;
  const qs = ch.questions;
  const i = qs.findIndex(x => x.id === qid);
  if (i < 0) return null;
  const isMat = s => /^案例\s*[（(]?[一二三四五六七八九十\d]/.test((s || '').trim());
  if (isMat(qs[i].stem)) return null;                       // 自己就是材料题，无需回看
  if (qs[i].standalone) return null;                        // 独立题：不属于任何案例组
  for (let k = i - 1; k >= 0 && i - k <= 6; k--) {
    if (qs[k].standalone) return null;                      // 独立题边界：不属于任何案例组
    if (isMat(qs[k].stem)) return qs[k];
  }
  return null;
}
/* 案例材料折叠区 HTML（列表 / 单题重做通用；无材料返回空串）
   2026-09-03：材料内容含「材料缺失」占位时不再渲染折叠区（避免显示无关残缺文本） */
function caseMaterialHtml(subject, chapterId, qid) {
  const m = findCaseMaterial(subject, chapterId, qid);
  if (!m || /材料缺失/.test(m.stem || '')) return '';
  const num = ((m.stem || '').match(/案例\s*[（(]?\s*([一二三四五六七八九十\d]+)/) || [])[1] || '';
  return `<details class="case-mat"><summary>📄 案例材料${num ? '（案例' + num + '）' : ''}</summary><div class="stem">${renderStem(m.stem)}</div></details>`;
}
function addWrong(item) {
  const ex = state.wrong.find(w => w.qid === item.qid);
  if (ex) { ex.count = (ex.count || 1) + 1; ex.last = localToday(); }
  else state.wrong.push({ ...item, count: 1, last: localToday(), box: 0, due: localToday(), reps: 0 });
  saveWrong();
}
function gradeWrong(w, correct) {
  if (correct) { w.box = Math.min((w.box || 0) + 1, EB_MAX); w.reps = (w.reps || 0) + 1; }
  else { w.box = 0; w.reps = 0; }
  w.due = addDays(localToday(), EB_INTERVALS[Math.min(w.box, EB_MAX)]);
  w.last = localToday();
  if (!correct) w.count = (w.count || 1) + 1;
  saveWrong();
}
function removeWrong(qid) { state.wrong = state.wrong.filter(w => w.qid !== qid); saveWrong(); }
/* 2026 考纲已整章删除的题（如工商「电子商务」）：题库里打 retired 标记，
   错题库显示灰标并支持一键清除，避免把时间浪费在不考的内容上。 */
function retiredQids() {
  const s = new Set();
  for (const sub of ['economy', 'business']) {
    const d = DATA.questions && DATA.questions[sub];
    if (!d || !d.chapters) continue;
    for (const c of d.chapters) for (const q of (c.questions || [])) if (q.retired) s.add(q.id);
  }
  return s;
}
/* 错题库显示的权威答案/解析：patches（含 lock）→ 个人 AI 订正 → 记录快照。
   与判分链路 applyCorrections 保持一致，避免「错题库显示的答案 ≠ 模考判分依据」。 */
function wrongAnswerView(w) {
  const base = { id: w.qid, stem: w.stem, options: w.options, type: w.type, answer: w.answer, explanation: w.explanation };
  let q = base;
  try { q = applyCorrections(base) || base; } catch (e) { q = base; }
  return {
    answer: Array.isArray(q.answer) ? q.answer.join('') : (q.answer || ''),
    explanation: q.explanation,
    options: (Array.isArray(q.options) && q.options.length >= 2) ? q.options : (w.options || []),
    type: q.type || w.type,
    stem: q.stem || w.stem,
    corrected: !!(q._corrected || q._patched)
  };
}
/* 科目名映射：economy=经济基础（蓝 pill）/ business=工商管理（绿 pill.g）/ 未知=灰 */
function subjectName(subject) { return subject === 'economy' ? '经济基础' : subject === 'business' ? '工商管理' : '未知科目'; }
function subjectPill(subject) { return subject === 'economy' ? '<span class="pill">经济基础</span>' : subject === 'business' ? '<span class="pill g">工商管理</span>' : '<span class="pill">未知</span>'; }
/* 错题归属科目：快照 subject 优先；缺失时按 qid 反查题库补全；查不到返回 null */
function subOf(w) {
  if (!w) return null;
  if (w.subject === 'economy' || w.subject === 'business') return w.subject;
  for (const sub of ["economy", "business"]) {
    const s = DATA.questions[sub];
    if (s && s.chapters.some(c => c.questions && c.questions.some(x => x.id === w.qid))) return sub;
  }
  return null;
}
/* 识别"无法作答"的错题：① 关联到的材料题本身材料缺失（如「案例（四）(材料缺失)」）；
   ② 疑似案例子题但关联不到材料（快照缺 subject/chapterId 或题库无该材料）。
   材料题自身（题干以「案例（N）」开头）不算——它有完整题干/选项可作答 */
function isUnanswerable(w) {
  if (!w) return false;
  const stem = w.stem || '';
  if (/^案例\s*[（(]?[一二三四五六七八九十\d]/.test(stem.trim())) return false;
  const m = findCaseMaterial(w.subject, w.chapterId, w.qid);
  if (m) return /材料缺失|（材料|\(材料/.test(m.stem || '');
  // 找不到材料：仅「该X…为/是(」强指代开头才判无法作答（2026-09-03 收紧——
  // 题干中间含"该公司/该企业"属正常措辞，旧宽匹配曾对完整题干产生 90+ 误报）
  return /^该[^，。]{0,12}[为是]\(/.test(stem.trim());
}
window.toggleAllSel = function () {
  const boxes = app.querySelectorAll('.wsel');
  if (!boxes.length) return;
  const allOn = [...boxes].every(b => b.checked);
  boxes.forEach(b => b.checked = !allOn);
  updateSelCount();
};
window.updateSelCount = function () {
  const n = app.querySelectorAll('.wsel:checked').length;
  const el = document.getElementById('selCount');
  if (el) el.textContent = n;
};
window.rmWrongBatch = function () {
  const qids = [...app.querySelectorAll('.wsel:checked')].map(b => b.dataset.qid);
  if (!qids.length) { toast('请先勾选要删除的错题'); return; }
  if (!confirm('确定删除所选 ' + qids.length + ' 道错题？')) return;
  const set = new Set(qids);
  state.wrong = state.wrong.filter(w => !set.has(w.qid));
  saveWrong(); renderWrong();
  toast('已删除 ' + qids.length + ' 道错题');
};
window.rmUnanswerable = function () {
  const bad = state.wrong.filter(isUnanswerable);
  if (!bad.length) { toast('没有识别到无法作答的题'); return; }
  if (!confirm('确定删除 ' + bad.length + ' 道「无材料 / 无法作答」的错题？')) return;
  const set = new Set(bad.map(w => w.qid));
  state.wrong = state.wrong.filter(w => !set.has(w.qid));
  saveWrong(); renderWrong();
  toast('已删除 ' + bad.length + ' 道无法作答题');
};
/* 按清单清理（2026-09-07）：粘贴 qid 清单批量删除过时错题 */
window.rmWrongByList = function () {
  const input = prompt('粘贴要删除的错题 qid 清单（逗号/空格/换行分隔均可）：');
  if (!input) return;
  const qids = input.split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean);
  if (!qids.length) { toast('清单为空'); return; }
  const found = state.wrong.filter(w => qids.includes(w.qid));
  if (!found.length) { toast('清单中没有匹配到当前错题'); return; }
  const missing = qids.filter(q => !found.some(w => w.qid === q));
  const msg = '清单 ' + qids.length + ' 个 qid，匹配到 ' + found.length + ' 道错题。\n'
    + (missing.length ? '未匹配（将跳过）：' + missing.join('、') + '\n' : '')
    + '\n确定删除这 ' + found.length + ' 道错题？';
  if (!confirm(msg)) return;
  const set = new Set(found.map(w => w.qid));
  state.wrong = state.wrong.filter(w => !set.has(w.qid));
  saveWrong(); renderWrong();
  toast('已按清单删除 ' + found.length + ' 道错题');
};
/* 一键清除「2026 考纲已删除章节」的错题（如电子商务整章） */
window.rmRetiredWrong = function () {
  const set = retiredQids();
  const hit = state.wrong.filter(w => set.has(w.qid));
  if (!hit.length) { toast('没有已删章节的错题'); return; }
  if (!confirm('将从错题库删除 ' + hit.length + ' 道「2026 考纲已删除章节」的题（如电子商务），不影响错题以外的数据。确定？')) return;
  state.wrong = state.wrong.filter(w => !set.has(w.qid));
  saveWrong(); renderWrong();
  toast('已清除 ' + hit.length + ' 道已删章节错题');
};
function markStudy(chapterKey) {
  const today = localToday();
  state.progress.done = state.progress.done || {};
  state.progress.done[chapterKey] = today;
  const last = state.progress.lastStudy || '';
  if (last === today) { /* same day, streak unchanged */ }
  else if (last && daysBetween(last, today) === 1) state.progress.streak = (state.progress.streak || 0) + 1;
  else state.progress.streak = 1;
  state.progress.lastStudy = today;
  saveProgress();
}

/* ---------------- 云同步：GitHub / Gitee 双通道 ---------------- */
function b64encode(str) { return btoa(unescape(encodeURIComponent(str))); }
function b64decode(str) { return decodeURIComponent(escape(atob(str))); }
function syncPayload() {
  /* 2026-10-25：模考记录（mockHistory）一并上云，否则「单位做模考 → 回家拉取」看不到成绩与逐题明细。
     不同步 mockSession：进行中的答题纸属于单机状态，跨设备续答会造成计时/答案错乱。 */
  return { wrong: state.wrong, progress: state.progress, corrections: state.corrections, mockHistory: mockHistory(), updatedAt: new Date().toISOString() };
}
/* 拉取成功后统一的合并落盘（两个平台共用） */
async function applyCloudPayload(payload, who) {
  const mhBefore = mockHistory().length;
  state.wrong = mergeWrong(payload.wrong, state.wrong);
  state.progress = mergeProgress(payload.progress, state.progress);
  state.corrections = mergeCorrections(payload.corrections, state.corrections);
  const mh = mergeMockHistory(payload.mockHistory, mockHistory());
  mockSaveHistory(mh);
  await saveWrong(); await saveProgress(); await saveCorrections();
  validateSession(true);   // 另一台设备已有新进度，本机残留会话作废
  state.settings.lastSync = new Date().toISOString(); await saveSettings();
  const mhAdd = mh.length - mhBefore;
  toast(`已从 ${who} 拉取并合并 ✅（不会覆盖本机新数据${mhAdd > 0 ? `，新增模考记录 ${mhAdd} 场` : ''}）`); router();
}

/* ---------------- GitHub 写：Git Data API 六步（2026-08-03 重构，一劳永逸）
   不再「GET sha → PUT」猜 sha，改走底层 Git 对象接口：
   ref/heads/{branch} → blobs → trees → commits → refs，所有 sha 由服务端生成并返回，
   从根上免疫 409/400「sha 不匹配」类冲突。已用真实仓库实测 6 步全 200。 ---------------- */
async function githubWrite(repo, path, payloadObj, message, token) {
  const B = `https://api.github.com/repos/${repo}`;
  const H = { Authorization: 'token ' + token, 'Content-Type': 'application/json' };
  const branch = (state.settings.branch || 'main');
  const gi = async (method, seg, data) => {
    const r = await fetch(`${B}/git/${seg}`, { method, headers: H, body: data ? JSON.stringify(data) : undefined });
    return r;
  };
  // 1) 取当前分支 head commit（main 优先，master 兜底）
  let head = null;
  for (const b of [branch, 'main', 'master']) {
    const r = await fetch(`${B}/git/ref/heads/${b}`, { headers: { Authorization: 'token ' + token } });
    if (r.ok) { head = (await r.json()).object.sha; break; }
  }
  if (!head) { const e = await (await fetch(`${B}/git/ref/heads/${branch}`, { headers: { Authorization: 'token ' + token } })).text(); throw new Error('无法获取分支 head：' + e.slice(0, 120)); }
  // 2) 上传文件内容为 blob（服务端返回 sha）
  const blob = await gi('POST', 'blobs', { content: b64encode(JSON.stringify(payloadObj, null, 2)), encoding: 'base64' });
  if (!blob.ok) { const e = await blob.text(); throw new Error('创建 blob 失败：' + e.slice(0, 120)); }
  const blobSha = (await blob.json()).sha;
  // 3) 取当前全树（含 data/user-data.json 的现有 entry）
  const treeResp = await gi('GET', `trees/${head}?recursive=1`);
  if (!treeResp.ok) { const e = await treeResp.text(); throw new Error('读取树失败：' + e.slice(0, 120)); }
  const tree = await treeResp.json();
  // 4) 建新树：把目标路径的 entry 替换成新 blob sha（不存在则新增）
  const newTree = await gi('POST', 'trees', {
    base_tree: tree.sha,
    tree: [{ path, mode: '100644', type: 'blob', sha: blobSha }]
  });
  if (!newTree.ok) { const e = await newTree.text(); throw new Error('创建树失败：' + e.slice(0, 120)); }
  const treeSha = (await newTree.json()).sha;
  // 5) 创建 commit（父 = 原 head）
  const commit = await gi('POST', 'commits', { message, tree: treeSha, parents: [head] });
  if (!commit.ok) { const e = await commit.text(); throw new Error('创建 commit 失败：' + e.slice(0, 120)); }
  const commitSha = (await commit.json()).sha;
  // 6) 更新分支指向（force 覆盖，用户语义：以本机为准直接覆盖云端）
  const ref = await gi('PATCH', `refs/heads/${branch}`, { sha: commitSha, force: true });
  if (!ref.ok) { const e = await ref.text(); throw new Error('更新分支失败：' + e.slice(0, 120)); }
  return true;
}
async function githubSave(silent) {
  const s = state.settings;
  if (!s.token || !s.repo) { toast('请先在设置填写 GitHub Token 和仓库'); return; }
  try {
    await githubWrite(s.repo, s.path || 'data/user-data.json', syncPayload(), 'sync econ study data', s.token);
    state.settings.lastSync = new Date().toISOString(); await saveSettings();
    if (!silent) toast('已同步到 GitHub ✅');
  } catch (e) { toast('GitHub 同步失败：' + e.message); }
}
async function githubLoad() {
  const s = state.settings;
  if (!s.token || !s.repo) { toast('请先填写 GitHub Token 和仓库'); return; }
  const path = s.path || 'data/user-data.json';
  const url = `https://api.github.com/repos/${s.repo}/contents/${path}`;
  try {
    const r = await fetch(url, { headers: { Authorization: 'token ' + s.token } });
    if (r.status === 404) { toast('云端还没有数据，请先点「同步到云端」备份一次'); return; }
    if (!r.ok) { toast('拉取失败：' + r.status); return; }
    const j = await r.json();
    await applyCloudPayload(JSON.parse(b64decode(j.content)), 'GitHub');
  } catch (e) { toast('拉取失败：' + e.message); }
}

/* Gitee（码云）：国内直连，单位网络可用。令牌只需勾选 projects 权限。
   ★ 2026-08-04 重构：写入改为「时间戳新文件」策略——
   Gitee 的 Contents API 更新已存在文件必须带 sha（且无 Git Data API 写端点），sha 过期即 400/409；
   改为每次生成 user-data-YYYYMMDD-HHMMSS.json 新文件（POST 新建、永不需要 sha），
   读取时列出目录取时间戳最新者。天然防并发冲突，旧文件保留当历史备份。
   giteePath 语义 = 目录（默认 jingjishidata/，可留空用仓库根目录）。 */
function giteeCfg() {
  const s = state.settings;
  const dir = (s.giteePath || '').trim();
  return { token: (s.giteeToken || '').trim(), repo: (s.giteeRepo || '').trim(), dir: dir && !/\/$/.test(dir) ? dir + '/' : dir };
}
function giteeDirUrl(c) {
  return `https://gitee.com/api/v5/repos/${c.repo}/contents/${c.dir || ''}`;
}
function giteeFileUrl(c, name) {
  return `https://gitee.com/api/v5/repos/${c.repo}/contents/${c.dir}${name}`;
}
function giteeStampName() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `user-data-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.json`;
}
/* Gitee 请求带鉴权双保险：?access_token= 查询串 → 401/403 降级 Bearer 头；no-store 防缓存 */
async function giteeReq(url, c, method, body) {
  const authHeader = 'Bearer ' + c.token;
  const init = { method: method || 'GET', headers: {}, cache: 'no-store' };
  if (method && method !== 'GET') {
    init.headers['Content-Type'] = 'application/json';
    init.headers['Authorization'] = authHeader;
    init.body = JSON.stringify(body || {});
  }
  let resp = await fetch(url + (method === 'GET' ? '?access_token=' + encodeURIComponent(c.token) : ''), init);
  if (resp.status === 401 || resp.status === 403 && method === 'GET') {
    resp = await fetch(url, { ...init, headers: { Authorization: authHeader, ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }) } });
  }
  return resp;
}
async function giteeSave(silent) {
  const c = giteeCfg();
  if (!c.token || !c.repo) { toast('请先在设置填写 Gitee 令牌和仓库'); return; }
  const content = b64encode(JSON.stringify(syncPayload(), null, 2));
  // 时间戳文件名 → POST 新建（无需 sha，免疫 400/409）
  let name = giteeStampName();
  try {
    const url = giteeFileUrl(c, name);
    const r = await giteeReq(url, c, 'POST', { content, message: 'sync econ study data' });
    if (r.ok) { state.settings.lastSync = new Date().toISOString(); await saveSettings(); if (!silent) toast('已同步到 Gitee ✅'); return; }
    // 同秒撞名 → 追加秒级随机数重试一次
    if (r.status === 400 || r.status === 409 || r.status === 422) {
      name = giteeStampName().replace('.json', '-' + Math.floor(Math.random() * 900 + 100) + '.json');
      const r2 = await giteeReq(giteeFileUrl(c, name), c, 'POST', { content, message: 'sync econ study data' });
      if (r2.ok) { state.settings.lastSync = new Date().toISOString(); await saveSettings(); if (!silent) toast('已同步到 Gitee ✅'); return; }
      const t = (await r2.text().catch(() => '')).slice(0, 120);
      toast('Gitee 同步失败：' + r2.status + ' ' + t); return;
    }
    const t = (await r.text().catch(() => '')).slice(0, 120);
    toast('Gitee 同步失败：' + r.status + ' ' + t);
  } catch (e) { toast('Gitee 同步失败：' + e.message); }
}
async function giteeLoad() {
  const c = giteeCfg();
  if (!c.token || !c.repo) { toast('请先填写 Gitee 令牌和仓库'); return; }
  try {
    // 列目录 → 全部 user-data-*.json 快照，按时间倒序
    const listResp = await giteeReq(giteeDirUrl(c), c, 'GET');
    if (listResp.status === 404) { toast('云端还没有数据，请先点「同步到云端」备份一次'); return; }
    if (listResp.status === 401 || listResp.status === 403) { toast('Gitee 拉取失败：' + listResp.status + '（令牌无效或权限不足）'); return; }
    if (!listResp.ok) { toast('Gitee 拉取失败：' + listResp.status); return; }
    const list = await listResp.json().catch(() => []);
    const files = (Array.isArray(list) ? list : []).filter(f => f && f.name && /^user-data-\d{8}-\d{6}(-\d+)?\.json$/.test(f.name)).sort((a, b) => b.name.localeCompare(a.name));
    if (!files.length) { toast('云端还没有数据，请先点「同步到云端」备份一次'); return; }
    renderGiteePicker(c, files);
  } catch (e) { toast('Gitee 拉取失败：' + e.message); }
}
/* 拉取文件选择界面：列出云端全部快照，默认勾选最新一份，可多选，也可一键合并全部 */
function renderGiteePicker(c, files) {
  app.innerHTML = `<div class="card">
    <h2>📥 从 Gitee 拉取 · 选择快照</h2>
    <p class="muted">云端共 <b>${files.length}</b> 份历史快照（按时间倒序，最新在上）。可勾选多份或一键合并全部——合并为<b>幂等并集</b>，不会覆盖本机新数据，只会越合越全。</p>
    <div style="margin:12px 0;display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn g" onclick="mergeGiteeFiles('all')">✅ 合并全部 ${files.length} 份</button>
      <button class="btn" onclick="mergeGiteeFiles('pick')">📥 合并所选（${files.length} 份中勾选）</button>
      <button class="btn ghost" onclick="router()">取消</button>
    </div>
    <div style="max-height:58vh;overflow:auto;margin-top:6px">
      ${files.map((f, i) => `<label class="gfile"><input type="checkbox" data-name="${esc(f.name)}" ${i === 0 ? 'checked' : ''}> <b>${esc(f.name)}</b> <span class="muted">${f.size ? Math.max(1, Math.round(f.size / 1024)) + ' KB' : ''}</span></label>`).join('')}
    </div>
  </div>`;
  window._giteeFiles = files;
  window._giteeCfg = c;
}
window.mergeGiteeFiles = async function (mode) {
  const files = window._giteeFiles || [];
  const c = window._giteeCfg;
  if (!files.length || !c) return;
  let pick;
  if (mode === 'pick') {
    pick = files.filter(f => { const el = document.querySelector('input[data-name="' + f.name + '"]'); return el && el.checked; });
    if (!pick.length) { toast('请至少勾选一份快照'); return; }
  } else pick = files.slice();
  toast(`正在合并 ${pick.length} 份快照…`);
  pick.sort((a, b) => a.name.localeCompare(b.name));   // 旧→新逐个合并，幂等
  let merged = 0;
  const mhBefore = mockHistory().length;
  let mhAll = mockHistory();
  for (const f of pick) {
    const fileResp = await giteeReq(giteeFileUrl(c, f.name), c, 'GET');
    if (!fileResp.ok) continue;
    const j = await fileResp.json().catch(() => ({}));
    if (!j.content) continue;
    let payload;
    try { payload = JSON.parse(b64decode(j.content)); } catch (e) { continue; }
    state.wrong = mergeWrong(payload.wrong, state.wrong);
    state.progress = mergeProgress(payload.progress, state.progress);
    state.corrections = mergeCorrections(payload.corrections, state.corrections);
    mhAll = mergeMockHistory(payload.mockHistory, mhAll);   // 模考记录逐份并集
    merged++;
  }
  if (!merged) { toast('Gitee 拉取失败：没有可读取的数据文件'); return; }
  mockSaveHistory(mhAll);
  await saveWrong(); await saveProgress(); await saveCorrections();
  validateSession(true);   // 另一台设备已有新进度，本机残留会话作废
  state.settings.lastSync = new Date().toISOString(); await saveSettings();
  const mhAdd = mhAll.length - mhBefore;
  toast(`已从 Gitee 合并 ${merged} 份快照 ✅（不会覆盖本机新数据${mhAdd > 0 ? `，新增模考记录 ${mhAdd} 场` : ''}）`); router();
};

/* 平台路由：设置里的「同步方式」决定走哪条通道 */
function cloudProvider() { return state.settings.provider === 'gitee' ? 'gitee' : 'github'; }
function cloudName() { return cloudProvider() === 'gitee' ? 'Gitee' : 'GitHub'; }
function cloudReady() {
  const s = state.settings;
  return cloudProvider() === 'gitee' ? !!(s.giteeToken && s.giteeRepo) : !!(s.token && s.repo);
}
async function cloudSave(silent) { return cloudProvider() === 'gitee' ? giteeSave(silent) : githubSave(silent); }
async function cloudLoad() { return cloudProvider() === 'gitee' ? giteeLoad() : githubLoad(); }
function scheduleSync() {
  if (!state.settings.auto || !cloudReady()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => cloudSave(true), 15000);   // 静默上传：成功不打扰，失败才提示
}
/* ---------------- 题库订正推送（patches.json 覆盖层） ---------------- */
async function pushPatchesToRepo(extra) {
  const s = state.settings;
  if (!s.token || !s.repo) { toast('请先在设置填写 GitHub Token 与仓库'); return; }
  const path = 'data/patches.json';
  // 先读现有 patches 合并（Git Data API 六步写入，服务端生成 sha，免疫 409）
  let cur = {};
  try {
    const url = `https://api.github.com/repos/${s.repo}/contents/${path}`;
    const r = await fetch(url, { headers: { Authorization: 'token ' + s.token }, cache: 'no-store' });
    if (r.ok) { const j = await r.json(); try { cur = JSON.parse(b64decode(j.content)); } catch (e) { cur = {}; } }
  } catch (e) { /* 文件可能还不存在，忽略 */ }
  Object.assign(cur, extra);
  try {
    await githubWrite(s.repo, path, cur, 'add question patches', s.token);
    toast('已推送到题库 ✅（下次打开站点即生效）');
  } catch (e) { toast('推送失败：' + e.message); }
}
function pushOnePatch(qid) {
  const c = state.corrections[qid];
  if (!c) { toast('本题暂无本地订正'); return; }
  pushPatchesToRepo({ [qid]: c });
}
window.pushOnePatch = pushOnePatch;
window.pushPatchesToRepo = pushPatchesToRepo;
window.pushMyCorrections = function () { pushPatchesToRepo(Object.assign({}, state.corrections)); };

/* ---------------- 路由 ---------------- */

/* ---------------- 专项强化：曲线图鉴 + 计算专练（2026-09-28） ---------------- */
/* 曲线 8 图（仅收录 2020-2025 真题实际考过的考点；练习题全部复用题库原 qid，做错照常进错题库） */
const DRILL_CURVES = [
{id: "demand_supply",title: "需求 / 供给曲线（产品市场）",svg: `<svg viewBox='0 0 260 150' xmlns='http://www.w3.org/2000/svg'><path d='M30 12 V128 H250' stroke='#adb5bd' fill='none' stroke-width='1.5'/><line x1='50' y1='25' x2='150' y2='115' stroke='#1971c2' stroke-width='2.2'/><line x1='80' y1='25' x2='180' y2='115' stroke='#1971c2' stroke-width='1.8' stroke-dasharray='5 4'/><line x1='60' y1='120' x2='185' y2='35' stroke='#e8590c' stroke-width='2.2'/><circle cx='114' cy='83' r='3.5' fill='#212529'/><circle cx='132' cy='71' r='3.5' fill='#212529'/><text x='143' y='122' font-size='11' fill='#1971c2'>D</text><text x='184' y='119' font-size='11' fill='#1971c2'>D'</text><text x='190' y='33' font-size='11' fill='#e8590c'>S</text><text x='104' y='96' font-size='10' fill='#212529'>E</text><text x='137' y='64' font-size='10' fill='#212529'>E'</text></svg>`,qids: ["e43q21","e48q56","e41q6","e38_30","e45q92"],points: ["需求曲线向右下方倾斜：价格↑→需求量↓（沿线的\"点移动\"）","收入、偏好、替代品/互补品价格等非价格因素 → 整条曲线\"线移动\"","供求相交 = 均衡价格 E；需求右移（D→D'）→ 均衡价格与数量同升","考法：区分\"点移动 vs 线移动\"、判断均衡变化方向"]},
{id: "elasticity_tax",title: "弹性与税负转嫁（谁弹性小谁承担）",svg: `<svg viewBox='0 0 260 150' xmlns='http://www.w3.org/2000/svg'><path d='M30 12 V128 H250' stroke='#adb5bd' fill='none' stroke-width='1.5'/><line x1='70' y1='25' x2='115' y2='120' stroke='#1971c2' stroke-width='2.2'/><line x1='45' y1='110' x2='220' y2='70' stroke='#e8590c' stroke-width='2.2'/><line x1='45' y1='90' x2='220' y2='50' stroke='#e8590c' stroke-width='1.8' stroke-dasharray='5 4'/><circle cx='99' cy='87' r='3.5' fill='#212529'/><circle cx='91' cy='70' r='3.5' fill='#212529'/><text x='100' y='118' font-size='11' fill='#1971c2'>D（陡峭=弹性小）</text><text x='196' y='66' font-size='11' fill='#e8590c'>S</text><text x='196' y='46' font-size='11' fill='#e8590c'>S'+税</text><text x='86' y='62' font-size='10' fill='#212529'>E'</text><text x='104' y='100' font-size='10' fill='#212529'>E</text></svg>`,qids: ["e42q66","e47q39","e40q22","e42q74","e42q29","e49q17"],points: ["需求价格弹性 = 需求量变动% ÷ 价格变动%；＞1 富有弹性（奢侈品），＜1 缺乏弹性（必需品）","税负转嫁规律：谁的弹性小，谁承担的税负多","需求弹性小（生活必需品）→ 税负易\"前转\"给消费者；供给弹性小 → 生产者自己扛","考法：给商品判弹性大小 → 判断转嫁方向与承担比例"]},
{id: "cost_curves",title: "短期成本曲线族",svg: `<svg viewBox='0 0 260 150' xmlns='http://www.w3.org/2000/svg'><path d='M30 12 V128 H250' stroke='#adb5bd' fill='none' stroke-width='1.5'/><line x1='35' y1='55' x2='235' y2='55' stroke='#adb5bd' stroke-width='1.6' stroke-dasharray='4 4'/><path d='M45 40 C 80 100 130 102 235 72' stroke='#1971c2' fill='none' stroke-width='2'/><path d='M45 55 C 85 108 125 108 235 84' stroke='#7048e8' fill='none' stroke-width='1.8'/><path d='M45 112 C 90 128 115 92 140 88 C 170 82 205 58 235 40' stroke='#d9480f' fill='none' stroke-width='2'/><circle cx='128' cy='99' r='3' fill='#212529'/><circle cx='146' cy='88' r='3' fill='#212529'/><text x='210' y='52' font-size='11' fill='#d9480f'>MC</text><text x='215' y='68' font-size='11' fill='#1971c2'>AC</text><text x='215' y='82' font-size='11' fill='#7048e8'>AVC</text><text x='210' y='50' font-size='10' fill='#212529'></text><text x='212' y='49' font-size='11' fill='#868e96'>FC</text></svg>`,qids: ["e43q48","e44q19","e46q77","e49q18"],points: ["FC 固定成本：不随产量变，水平线；TVC 随产量上升","AC / AVC 呈 U 形：先因规模效应下降，后因边际报酬递减上升","MC 边际成本先降后升，分别从下方穿过 AVC、AC 的最低点","MC＜AC 时 AC 下降；MC＞AC 时 AC 上升（记住\"MC 交平均线最低点\"）"]},
{id: "market_struct",title: "不同市场结构的需求曲线",svg: `<svg viewBox='0 0 260 150' xmlns='http://www.w3.org/2000/svg'><path d='M30 12 V128 H250' stroke='#adb5bd' fill='none' stroke-width='1.5'/><path d='M30 12 V128 H250' stroke='#adb5bd' fill='none' stroke-width='1.2'/><line x1='45' y1='62' x2='100' y2='62' stroke='#1971c2' stroke-width='2.2'/><text x='46' y='52' font-size='9' fill='#1971c2'>P=AR=MR</text><text x='48' y='120' font-size='10' fill='#495057'>完全竞争</text><line x1='118' y1='35' x2='168' y2='105' stroke='#1971c2' stroke-width='2.2'/><line x1='120' y1='50' x2='158' y2='100' stroke='#d9480f' stroke-width='1.6'/><text x='146' y='55' font-size='10' fill='#1971c2'>D</text><text x='128' y='120' font-size='10' fill='#495057'>垄断</text><path d='M195 40 L218 62 L245 112' stroke='#1971c2' fill='none' stroke-width='2.2'/><circle cx='218' cy='62' r='3' fill='#212529'/><text x='222' y='58' font-size='10' fill='#495057'>弯折点</text><text x='212' y='120' font-size='10' fill='#495057'>寡头</text></svg>`,qids: ["e42q31","e47q54","e46q1","e42q11","e48q92"],points: ["完全竞争：个别企业面对水平需求曲线，P=AR=MR","完全垄断：需求曲线右下倾，MR 在 D 下方（MR＜AR）","寡头：弯折需求曲线（斯威齐模型），弯折点价格粘性","垄断竞争：右下倾且较平缓（产品替代性强）","考法：给市场形态 → 判断需求曲线形状与 AR/MR 关系"]},
{id: "factor_market",title: "要素市场：劳动供给曲线 + MRP/VMP",svg: `<svg viewBox='0 0 260 150' xmlns='http://www.w3.org/2000/svg'><path d='M30 12 V128 H250' stroke='#adb5bd' fill='none' stroke-width='1.5'/><path d='M60 115 C 112 106 152 92 158 70 C 162 55 148 42 126 47' stroke='#d9480f' fill='none' stroke-width='2.4'/><path d='M129 40 L124 50 L134 52 Z' fill='#d9480f'/><circle cx='158' cy='70' r='3.5' fill='#212529'/><text x='163' y='74' font-size='10' fill='#495057'>弯曲点</text><text x='34' y='20' font-size='10' fill='#495057'>工资W</text><text x='218' y='122' font-size='10' fill='#495057'>劳动量</text><text x='70' y='132' font-size='10' fill='#e8590c'>替代效应＞收入效应 → 收入效应＞替代效应</text></svg>`,qids: ["e47q50","e49q33","e42q51","e48q4","e47q82"],points: ["劳动供给曲线向后弯曲：工资低→替代效应主导（多干活）；工资高→收入效应主导（少干活）","要素需求曲线 = MRP（边际收益产品）曲线，向右下方倾斜","⚠️ 2026 新口径：完全竞争要素市场 MFC = VMP（边际产品价值）；旧教材 MFC=MRP 表述已废，按 VMP 作答","考法：向后弯曲的原因（收入/替代效应博弈）"]},
{id: "adas",title: "总需求 - 总供给模型（AD-AS）",svg: `<svg viewBox='0 0 260 150' xmlns='http://www.w3.org/2000/svg'><path d='M30 12 V128 H250' stroke='#adb5bd' fill='none' stroke-width='1.5'/><line x1='45' y1='35' x2='200' y2='115' stroke='#1971c2' stroke-width='2.2'/><path d='M45 112 L110 112 C 150 108 170 80 190 45 L190 18' stroke='#e8590c' fill='none' stroke-width='2.4'/><circle cx='128' cy='107' r='3.5' fill='#212529'/><circle cx='182' cy='55' r='3.5' fill='#212529'/><text x='185' y='112' font-size='11' fill='#1971c2'>AD</text><text x='196' y='40' font-size='11' fill='#e8590c'>AS</text><text x='60' y='105' font-size='9' fill='#868e96'>萧条(水平)</text><text x='146' y='96' font-size='9' fill='#868e96'>中间</text><text x='196' y='70' font-size='9' fill='#868e96'>充分就业</text></svg>`,qids: ["e39q44","e39q58","e38_28","e42q86","e47q42"],points: ["AD 右下倾：价格总水平↑ → 总需求↓","AS 三段：水平段（萧条）→ 右上段（中间）→ 垂直段（充分就业）","AD 右移：在水平段只增产不涨价；在垂直段只涨价不增产（通胀）","考法：AS 三段形态识别 + 政策效果判断"]},
{id: "islm",title: "货币市场与 IS-LM 模型",svg: `<svg viewBox='0 0 260 150' xmlns='http://www.w3.org/2000/svg'><path d='M30 12 V128 H250' stroke='#adb5bd' fill='none' stroke-width='1.5'/><line x1='50' y1='25' x2='190' y2='115' stroke='#1971c2' stroke-width='2.2'/><line x1='60' y1='110' x2='180' y2='25' stroke='#e8590c' stroke-width='2.2'/><circle cx='118' cy='69' r='3.5' fill='#212529'/><text x='176' y='120' font-size='11' fill='#1971c2'>IS</text><text x='184' y='26' font-size='11' fill='#e8590c'>LM</text><text x='124' y='66' font-size='10' fill='#212529'>E</text></svg>`,qids: ["e39q40","e42q96","e45q38","e46q90"],points: ["IS：产品市场均衡（I=S），右下倾——利率↓→投资↑→国民收入↑","LM：货币市场均衡（L=M），右上倾——收入↑→货币需求↑→利率↑","交点 E：产品与货币市场同时均衡","流动性陷阱：利率极低时货币需求无限大，LM 近水平，货币政策失效","考法：IS/LM 移动因素（财政政策动 IS，货币政策动 LM）"]},
{id: "phillips_cycle",title: "菲利普斯曲线与经济周期",svg: `<svg viewBox='0 0 260 150' xmlns='http://www.w3.org/2000/svg'><path d='M30 12 V128 H250' stroke='#adb5bd' fill='none' stroke-width='1.5'/><path d='M28 12 V128 H126' stroke='#adb5bd' fill='none' stroke-width='1.2'/><path d='M42 32 C 68 45 88 80 106 114' stroke='#d9480f' fill='none' stroke-width='2.2'/><text x='100' y='42' font-size='10' fill='#d9480f'>PC</text><text x='32' y='24' font-size='9' fill='#495057'>通胀</text><text x='108' y='122' font-size='9' fill='#495057'>失业</text><path d='M150 12 V128 H252' stroke='#adb5bd' fill='none' stroke-width='1.2'/><line x1='158' y1='70' x2='248' y2='70' stroke='#868e96' stroke-width='1.4' stroke-dasharray='4 3'/><path d='M160 82 C 175 45 190 98 205 62 C 218 34 236 92 248 64' stroke='#1971c2' fill='none' stroke-width='2'/><text x='160' y='62' font-size='9' fill='#868e96'>潜在产出</text><text x='196' y='120' font-size='9' fill='#495057'>实际产出波动</text></svg>`,qids: ["e40q20","e41q32","e48q27","e49q102"],points: ["菲利普斯曲线：失业率与通胀率此消彼长（短期右下倾）","经济周期四阶段：繁荣 → 衰退 → 萧条 → 复苏","古典型周期：总量绝对下降；增长型周期：增速放缓但未负增长","关联考点：奥肯定律——产出缺口与失业率反向变动"]}
];
/* 工商管理计算专练 7 组（题目复用题库 qid；全部 42 题已逐题验算答案与表格） */
const DRILL_CALCS = [
{id: "prod_capacity",title: "生产能力核算（设备组/流水线/假定产品/代表产品）",qids: ["b16q20","b19q85","b20q10","b24q3"],formulas: ["设备组：M＝F（单位有效工时）×S（设备数）×P（产量定额）","流水线：M＝F÷r（r 为节拍）","假定产品法：t＝Σ(wi×ti)，M＝F×S÷t，某产品产能＝M×wi","代表产品法：Ki＝ti÷td，Md＝F×S÷td，Mi 按产量比重与 Ki 折算"]},
{id: "prod_plan",title: "生产作业计划编制（在制品定额法/累计编号法）",qids: ["b13q76","b20q81","b16q53"],formulas: ["在制品定额法：本车间出产量＝后续车间投入量＋半成品外售量＋(期末库存定额－期初预计结存)","在制品定额法：本车间投入量＝本车间出产量＋计划废品量＋(期末在制品定额－期初预计在制品结存)","累计编号法（提前期法）：出产累计号＝最后车间出产累计号＋本车间出产提前期×最后车间平均日产量","累计编号法（提前期法）：投入累计号＝最后车间出产累计号＋本车间投入提前期×最后车间平均日产量"]},
{id: "risk_decision",title: "风险型决策（期望损益/决策树）",qids: ["b19q33","b24q1"],formulas: ["期望值＝Σ(各状态损益值×该状态概率)；比较各方案期望值取最大","决策树：从右向左逐级计算状态节点期望值，在决策节点“取大”"]},
{id: "decision",title: "不确定型决策（后悔值/折中）",qids: ["b16q39","b21q95"],formulas: ["后悔值＝该状态列最大损益值－本方案损益值；再取各方案最大后悔值“大中取小”","折中值＝α×方案最大损益值＋(1－α)×方案最小损益值；给“最小值系数”要先换算 α＝1－最小值系数"]},
{id: "bep_pricing",title: "确定型决策与定价（量本利/线性规划/成本加成/目标利润）",qids: ["b2q5","b24q2","b14q87","b19q62"],formulas: ["盈亏平衡产量 Q*＝F÷(P－V)","线性规划：列约束→求可行域顶点→代入目标函数取最优","成本加成价＝单位成本×(1＋加成率)，单位成本＝单位可变成本＋固定成本÷销量","目标利润价＝(总成本＋投资额×投资收益率)÷预期销量"]},
{id: "invest",title: "投资决策（现金流量/NPV/回收期/获利指数/IRR）",qids: ["b20q88","b21q21","b22q98","b24q5","b24q6"],formulas: ["初始现金流量＝固定资产投资＋流动资产投资＋其他投资费用－原有固定资产变价收入","NPV＝未来报酬总现值－初始投资；净现值≥0 可行","静态投资回收期＝原始投资额÷每年 NCF","获利指数 PI＝未来报酬总现值÷初始投资额；PI≥1 可行","IRR 插值：IRR≈i₁＋[NPV₁÷(|NPV₁|＋|NPV₂|)]×(i₂－i₁)"]},
{id: "capital_fin",title: "资本成本与杠杆（借款/债券/综合资本成本/杠杆/无差别点）",qids: ["b19q139","b20q31","b21q97","b21q98","b24q7"],formulas: ["借款资本成本率＝年利率×(1－T)÷(1－筹资费用率)","债券资本成本率＝年利息×(1－T)÷[筹资额×(1－筹资费用率)]","综合资本成本＝Σ(各方式资本成本×该方式筹资比重)","总杠杆系数＝营业杠杆系数×财务杠杆系数","每股利润无差别点：(EBIT－I₁)(1－T)/N₁＝(EBIT－I₂)(1－T)/N₂"]},
{id: "inventory",title: "库存控制（EOQ/订购点/订购间隔期）",qids: ["b19q99","b12q4","b24q4"],formulas: ["经济订购批量 EOQ＝√(2×年需求量D×每次订购成本K÷单位年持有成本Kc)","订购点＝平均日需求量×备运时间＋安全库存量","定期控制：最佳年订购次数 m₀＝√(D×K÷2C)；订购间隔期 T₀＝1÷m₀"]},
{id: "hr_forecast",title: "人力资源需求预测（转换比率/一元回归/马尔可夫）",qids: ["b19q121","b21q81","b14q80"],formulas: ["转换比率法：先算需增加总人数，再按各类人员比例分配","一元回归：y＝a＋b·x（x 为销售额等驱动量）","马尔可夫模型：一年后某职务内部供给＝本职务现有人数×留任概率＋下级职务人数×调升概率"]},
{id: "salary",title: "薪酬区间与浮动率",qids: ["b21q6","b20q84"],formulas: ["薪酬区间最高值＝区间中值×(1＋薪酬浮动率)；最低值＝中值×(1－浮动率)","各薪酬级别差距＝(最高值－最低值)÷(级别数－1)"]},
{id: "tech_value",title: "技术价值评估（成本模型）",qids: ["b14q77"],formulas: ["成本模型：以重置成本为基础，按成新率折算技术评估值"]},
{id: "quality",title: "工序能力指数（Cp / Cpk）",qids: ["b23q12","b24q9"],formulas: ["工序能力 B＝6σ；中心重合时 Cp＝T÷(6σ)","中心偏移时 Cpk＝(T－2ε)÷(6σ)（ε 为分布中心对公差中心的偏移量）","等级：≥1.67 特级；1.33~1.67 一级；1.00~1.33 二级；0.67~1.00 三级；＜0.67 四级"]},
{id: "channel_fin",title: "渠道财务绩效（费用利润率）",qids: ["b21q53"],formulas: ["渠道费用利润率＝渠道利润额÷分销渠道费用×100%"]},
{id: "value_eval",title: "企业价值评估（市盈率法）",qids: ["b24q8"],formulas: ["市盈率法：目标企业价值＝企业净利润总额×标准市盈率"]}
];
let _bankIdx = null;
function bankIdx() {
  if (_bankIdx) return _bankIdx;
  _bankIdx = {};
  ['economy', 'business'].forEach(s => {
    const sub = DATA.questions[s];
    if (!sub) return;
    sub.chapters.forEach(ch => ch.questions.forEach(q => { _bankIdx[q.id] = { q, subject: s, chapterId: ch.id, chapterTitle: ch.title }; }));
  });
  return _bankIdx;
}
/* 按专项组卷：不写 progress（不动每日完成状态），判分/错题入库与常规刷题完全一致 */
window.startDrillQuiz = function (kind, idx) {
  const item = (kind === 'curves' ? DRILL_CURVES : DRILL_CALCS)[idx];
  if (!item) { toast('专项不存在'); return; }
  const idxMap = bankIdx();
  const queue = item.qids.filter(qid => idxMap[qid]).map(qid => {
    const hit = idxMap[qid];
    return { q: applyCorrections(hit.q), subject: hit.subject, chapterId: hit.chapterId, chapterTitle: hit.chapterTitle };
  });
  if (!queue.length) { toast('该专项暂无可用题目'); return; }
  beginQuiz(queue, item.title + '（专项）', false, [], false);
};
window.startDrillAll = function (kind) {
  const list = kind === 'curves' ? DRILL_CURVES : DRILL_CALCS;
  const idxMap = bankIdx();
  const seen = new Set(), queue = [];
  list.forEach(it => it.qids.forEach(qid => {
    if (seen.has(qid) || !idxMap[qid]) return;
    seen.add(qid);
    const hit = idxMap[qid];
    queue.push({ q: applyCorrections(hit.q), subject: hit.subject, chapterId: hit.chapterId, chapterTitle: hit.chapterTitle });
  }));
  if (!queue.length) { toast('清单为空'); return; }
  beginQuiz(queue, (kind === 'curves' ? '曲线专项全刷' : '计算专项全刷') + `（${queue.length}题）`, false, [], false);
};
/* 实际可用题数：题库尚未同步（如 CDN 缓存旧 questions.json）时如实显示，不虚标 */
function avail(group) {
  const ix = bankIdx();
  return group.qids.filter(qid => ix[qid]).length;
}
function renderDrill() {
  const app = document.getElementById('app');
  const curveCards = DRILL_CURVES.map((c, i) => `<div class="card drill-card">
    <div class="row"><b>${c.title}</b><span class="pill b">${avail(c)} 题</span></div>
    <div class="drill-svg">${c.svg}</div>
    <ul class="drill-points">${c.points.map(p => `<li>${p}</li>`).join('')}</ul>
    <button class="btn" onclick="startDrillQuiz('curves', ${i})">练一练（${avail(c)}）</button>
  </div>`).join('');
  const calcCards = DRILL_CALCS.map((c, i) => `<div class="card drill-card">
    <div class="row"><b>${c.title}</b><span class="pill a">${avail(c)} 题</span></div>
    <div class="drill-formula">${c.formulas.map(f => `📐 ${f}`).join('<br>')}</div>
    <button class="btn" onclick="startDrillQuiz('calcs', ${i})">练一练（${avail(c)}）</button>
  </div>`).join('');
  const nC = DRILL_CURVES.reduce((a, c) => a + avail(c), 0);
  const nK = DRILL_CALCS.reduce((a, c) => a + avail(c), 0);
  app.innerHTML = `<div class="card"><div class="row"><b>🎯 专项强化</b><a class="btn ghost" href="#/today" style="padding:4px 12px">返回今日</a></div>
    <p class="muted" style="font-size:13px">曲线图鉴：先学图、再做题（仅 2020-2025 真题考过的曲线）；计算专练：历年真题计算题按公式分组，已逐题验算。做错的题照常进错题库。</p></div>
    <div class="row" style="margin:4px 2px"><b>📈 曲线图鉴</b><span class="muted" style="font-size:12px">共 ${nC} 题</span><button class="btn ghost" style="padding:4px 12px;margin-left:auto" onclick="startDrillAll('curves')">连刷全部</button></div>
    <div class="drill-grid">${curveCards}</div>
    <div class="row" style="margin:14px 2px 4px"><b>🧮 工商计算专练</b><span class="muted" style="font-size:12px">共 ${nK} 题</span><button class="btn ghost" style="padding:4px 12px;margin-left:auto" onclick="startDrillAll('calcs')">连刷全部</button></div>
    <div class="drill-grid">${calcCards}</div>`;
}

/* ================= 真题模考模块（2026-10-21） ================= */
/* 卷面配置：严格按真题结构（题号区间 → 题型/分值），案例题按不定项 2 分处理，
   不依赖题目自身的 type 字段（案例题在题库里 single/multiple 混杂）。 */
const MOCK_PAPERS = [
  {
    id: 'e49', subject: 'economy',
    title: '2025 经济基础真题 · 11.2 下午场',
    minutes: 90, totalScore: 140,
    sections: [{ label: '一、单选题', from: 0, to: 70, type: 'single', score: 1 }, { label: '二、多选题', from: 70, to: 105, type: 'multiple', score: 2 }],
    order: [{ c: 'e49', q: 'e49q1' }, { c: 'e49', q: 'e49q2' }, { c: 'e49', q: 'e49q3' }, { c: 'e49', q: 'e49q4' }, { c: 'e49', q: 'e49q5' }, { c: 'e49', q: 'e49q6' }, { c: 'e49', q: 'e49q7' }, { c: 'e49', q: 'e49q8' }, { c: 'e49', q: 'e49q9' }, { c: 'e49', q: 'e49q10' }, { c: 'e49', q: 'e49q11' }, { c: 'e49', q: 'e49q12' }, { c: 'e49', q: 'e49q13' }, { c: 'e49', q: 'e49q14' }, { c: 'e49', q: 'e49q15' }, { c: 'e49', q: 'e49q16' }, { c: 'e49', q: 'e49q17' }, { c: 'e49', q: 'e49q18' }, { c: 'e49', q: 'e49q19' }, { c: 'e49', q: 'e49q20' }, { c: 'e49', q: 'e49q21' }, { c: 'e49', q: 'e49q22' }, { c: 'e49', q: 'e49q23' }, { c: 'e49', q: 'e49q24' }, { c: 'e49', q: 'e49q25' }, { c: 'e49', q: 'e49q26' }, { c: 'e49', q: 'e49q27' }, { c: 'e49', q: 'e49q28' }, { c: 'e49', q: 'e49q29' }, { c: 'e49', q: 'e49q30' }, { c: 'e49', q: 'e49q31' }, { c: 'e49', q: 'e49q32' }, { c: 'e49', q: 'e49q33' }, { c: 'e49', q: 'e49q34' }, { c: 'e49', q: 'e49q35' }, { c: 'e49', q: 'e49q36' }, { c: 'e49', q: 'e49q37' }, { c: 'e49', q: 'e49q38' }, { c: 'e49', q: 'e49q39' }, { c: 'e49', q: 'e49q40' }, { c: 'e49', q: 'e49q41' }, { c: 'e49', q: 'e49q42' }, { c: 'e49', q: 'e49q43' }, { c: 'e49', q: 'e49q44' }, { c: 'e49', q: 'e49q45' }, { c: 'e49', q: 'e49q46' }, { c: 'e49', q: 'e49q47' }, { c: 'e49', q: 'e49q48' }, { c: 'e49', q: 'e49q49' }, { c: 'e49', q: 'e49q50' }, { c: 'e49', q: 'e49q51' }, { c: 'e49', q: 'e49q52' }, { c: 'e49', q: 'e49q53' }, { c: 'e49', q: 'e49q54' }, { c: 'e49', q: 'e49q55' }, { c: 'e49', q: 'e49q56' }, { c: 'e49', q: 'e49q57' }, { c: 'e49', q: 'e49q58' }, { c: 'e49', q: 'e49q59' }, { c: 'e49', q: 'e49q60' }, { c: 'e49', q: 'e49q61' }, { c: 'e49', q: 'e49q62' }, { c: 'e49', q: 'e49q63' }, { c: 'e49', q: 'e49q64' }, { c: 'e49', q: 'e49q65' }, { c: 'e49', q: 'e49q66' }, { c: 'e49', q: 'e49q67' }, { c: 'e49', q: 'e49q68' }, { c: 'e49', q: 'e49q69' }, { c: 'e49', q: 'e49q70' }, { c: 'e49', q: 'e49q71' }, { c: 'e49', q: 'e49q72' }, { c: 'e49', q: 'e49q73' }, { c: 'e49', q: 'e49q74' }, { c: 'e49', q: 'e49q75' }, { c: 'e49', q: 'e49q76' }, { c: 'e49', q: 'e49q77' }, { c: 'e49', q: 'e49q78' }, { c: 'e49', q: 'e49q79' }, { c: 'e49', q: 'e49q80' }, { c: 'e49', q: 'e49q81' }, { c: 'e49', q: 'e49q82' }, { c: 'e49', q: 'e49q83' }, { c: 'e49', q: 'e49q84' }, { c: 'e49', q: 'e49q85' }, { c: 'e49', q: 'e49q86' }, { c: 'e49', q: 'e49q87' }, { c: 'e49', q: 'e49q88' }, { c: 'e49', q: 'e49q89' }, { c: 'e49', q: 'e49q90' }, { c: 'e49', q: 'e49q91' }, { c: 'e49', q: 'e49q92' }, { c: 'e49', q: 'e49q93' }, { c: 'e49', q: 'e49q94' }, { c: 'e49', q: 'e49q95' }, { c: 'e49', q: 'e49q96' }, { c: 'e49', q: 'e49q97' }, { c: 'e49', q: 'e49q98' }, { c: 'e49', q: 'e49q99' }, { c: 'e49', q: 'e49q100' }, { c: 'e49', q: 'e49q101' }, { c: 'e49', q: 'e49q102' }, { c: 'e49', q: 'e49q103' }, { c: 'e49', q: 'e49q104' }, { c: 'e49', q: 'e49q105' }]
  },
  {
    id: 'b22', subject: 'business',
    title: '2025 工商管理真题 · 11.2 下午场',
    minutes: 90, totalScore: 140,
    sections: [{ label: '一、单选题', from: 0, to: 60, type: 'single', score: 1 }, { label: '二、多选题', from: 60, to: 80, type: 'multiple', score: 2 }, { label: '三、案例分析题（不定项）', from: 80, to: 100, type: 'case', score: 2 }],
    order: [{ c: 'b22', q: 'b22q1' }, { c: 'b22', q: 'b22q2' }, { c: 'b22', q: 'b22q3' }, { c: 'b22', q: 'b22q4' }, { c: 'b22', q: 'b22q5' }, { c: 'b22', q: 'b22q6' }, { c: 'b22', q: 'b22q7' }, { c: 'b22', q: 'b22q8' }, { c: 'b22', q: 'b22q9' }, { c: 'b22', q: 'b22q10' }, { c: 'b22', q: 'b22q11' }, { c: 'b22', q: 'b22q12' }, { c: 'b22', q: 'b22q13' }, { c: 'b22', q: 'b22q14' }, { c: 'b22', q: 'b22q15' }, { c: 'b22', q: 'b22q16' }, { c: 'b22', q: 'b22q17' }, { c: 'b22', q: 'b22q18' }, { c: 'b22', q: 'b22q19' }, { c: 'b22', q: 'b22q20' }, { c: 'b22', q: 'b22q21' }, { c: 'b22', q: 'b22q22' }, { c: 'b22', q: 'b22q23' }, { c: 'b22', q: 'b22q24' }, { c: 'b22', q: 'b22q25' }, { c: 'b22', q: 'b22q26' }, { c: 'b22', q: 'b22q27' }, { c: 'b22', q: 'b22q28' }, { c: 'b22', q: 'b22q29' }, { c: 'b22', q: 'b22q30' }, { c: 'b22', q: 'b22q31' }, { c: 'b22', q: 'b22q32' }, { c: 'b22', q: 'b22q33' }, { c: 'b22', q: 'b22q34' }, { c: 'b22', q: 'b22q35' }, { c: 'b22', q: 'b22q36' }, { c: 'b22', q: 'b22q37' }, { c: 'b22', q: 'b22q38' }, { c: 'b22', q: 'b22q39' }, { c: 'b22', q: 'b22q40' }, { c: 'b22', q: 'b22q41' }, { c: 'b22', q: 'b22q42' }, { c: 'b22', q: 'b22q43' }, { c: 'b22', q: 'b22q44' }, { c: 'b22', q: 'b22q45' }, { c: 'b22', q: 'b22q46' }, { c: 'b22', q: 'b22q47' }, { c: 'b22', q: 'b22q48' }, { c: 'b22', q: 'b22q49' }, { c: 'b22', q: 'b22q50' }, { c: 'b22', q: 'b22q51' }, { c: 'b22', q: 'b22q52' }, { c: 'b22', q: 'b22q53' }, { c: 'b22', q: 'b22q54' }, { c: 'b22', q: 'b22q55' }, { c: 'b22', q: 'b22q56' }, { c: 'b22', q: 'b22q57' }, { c: 'b22', q: 'b22q58' }, { c: 'b22', q: 'b22q59' }, { c: 'b22', q: 'b22q60' }, { c: 'b22', q: 'b22q61' }, { c: 'b22', q: 'b22q62' }, { c: 'b22', q: 'b22q63' }, { c: 'b22', q: 'b22q64' }, { c: 'b22', q: 'b22q65' }, { c: 'b22', q: 'b22q66' }, { c: 'b22', q: 'b22q67' }, { c: 'b22', q: 'b22q68' }, { c: 'b22', q: 'b22q69' }, { c: 'b22', q: 'b22q70' }, { c: 'b22', q: 'b22q71' }, { c: 'b22', q: 'b22q72' }, { c: 'b22', q: 'b22q73' }, { c: 'b22', q: 'b22q74' }, { c: 'b22', q: 'b22q75' }, { c: 'b22', q: 'b22q76' }, { c: 'b22', q: 'b22q77' }, { c: 'b22', q: 'b22q78' }, { c: 'b22', q: 'b22q79' }, { c: 'b22', q: 'b22q80' }, { c: 'b22', q: 'b22q81' }, { c: 'b22', q: 'b22q82' }, { c: 'b22', q: 'b22q83' }, { c: 'b22', q: 'b22q84' }, { c: 'b22', q: 'b22q85' }, { c: 'b22', q: 'b22q86' }, { c: 'b22', q: 'b22q87' }, { c: 'b22', q: 'b22q88' }, { c: 'b22', q: 'b22q89' }, { c: 'b22', q: 'b22q90' }, { c: 'b22', q: 'b22q91' }, { c: 'b22', q: 'b22q92' }, { c: 'b22', q: 'b22q93' }, { c: 'b22', q: 'b22q94' }, { c: 'b22', q: 'b22q95' }, { c: 'b22', q: 'b22q96' }, { c: 'b22', q: 'b22q97' }, { c: 'b22', q: 'b22q98' }, { c: 'b22', q: 'b22q99' }, { c: 'b22', q: 'b22q100' }]
  },
  {
    id: 'e48', subject: 'economy',
    title: '2025 经济基础真题 · 11.2 上午场',
    minutes: 90, totalScore: 140,
    sections: [{ label: '一、单选题', from: 0, to: 70, type: 'single', score: 1 }, { label: '二、多选题', from: 70, to: 105, type: 'multiple', score: 2 }],
    order: [{ c: 'e48', q: 'e48q1' }, { c: 'e48', q: 'e48q2' }, { c: 'e48', q: 'e48q3' }, { c: 'e48', q: 'e48q4' }, { c: 'e48', q: 'e48q5' }, { c: 'e48', q: 'e48q6' }, { c: 'e48', q: 'e48q7' }, { c: 'e48', q: 'e48q8' }, { c: 'e48', q: 'e48q9' }, { c: 'e48', q: 'e48q10' }, { c: 'e48', q: 'e48q11' }, { c: 'e48', q: 'e48q12' }, { c: 'e48', q: 'e48q13' }, { c: 'e48', q: 'e48q14' }, { c: 'e48', q: 'e48q15' }, { c: 'e48', q: 'e48q16' }, { c: 'e48', q: 'e48q17' }, { c: 'e48', q: 'e48q18' }, { c: 'e48', q: 'e48q19' }, { c: 'e48', q: 'e48q20' }, { c: 'e48', q: 'e48q21' }, { c: 'e48', q: 'e48q22' }, { c: 'e48', q: 'e48q23' }, { c: 'e48', q: 'e48q24' }, { c: 'e48', q: 'e48q25' }, { c: 'e48', q: 'e48q26' }, { c: 'e48', q: 'e48q27' }, { c: 'e48', q: 'e48q28' }, { c: 'e48', q: 'e48q29' }, { c: 'e48', q: 'e48q30' }, { c: 'e48', q: 'e48q31' }, { c: 'e48', q: 'e48q32' }, { c: 'e48', q: 'e48q33' }, { c: 'e48', q: 'e48q34' }, { c: 'e48', q: 'e48q35' }, { c: 'e48', q: 'e48q36' }, { c: 'e48', q: 'e48q37' }, { c: 'e48', q: 'e48q38' }, { c: 'e48', q: 'e48q39' }, { c: 'e48', q: 'e48q40' }, { c: 'e48', q: 'e48q41' }, { c: 'e48', q: 'e48q42' }, { c: 'e48', q: 'e48q43' }, { c: 'e48', q: 'e48q44' }, { c: 'e48', q: 'e48q45' }, { c: 'e48', q: 'e48q46' }, { c: 'e48', q: 'e48q47' }, { c: 'e48', q: 'e48q48' }, { c: 'e48', q: 'e48q49' }, { c: 'e48', q: 'e48q50' }, { c: 'e48', q: 'e48q51' }, { c: 'e48', q: 'e48q52' }, { c: 'e48', q: 'e48q53' }, { c: 'e48', q: 'e48q54' }, { c: 'e48', q: 'e48q55' }, { c: 'e48', q: 'e48q56' }, { c: 'e48', q: 'e48q57' }, { c: 'e48', q: 'e48q58' }, { c: 'e48', q: 'e48q59' }, { c: 'e48', q: 'e48q60' }, { c: 'e48', q: 'e48q61' }, { c: 'e48', q: 'e48q62' }, { c: 'e48', q: 'e48q63' }, { c: 'e48', q: 'e48q64' }, { c: 'e48', q: 'e48q65' }, { c: 'e48', q: 'e48q66' }, { c: 'e48', q: 'e48q67' }, { c: 'e48', q: 'e48q68' }, { c: 'e48', q: 'e48q69' }, { c: 'e48', q: 'e48q70' }, { c: 'e48', q: 'e48q71' }, { c: 'e48', q: 'e48q72' }, { c: 'e48', q: 'e48q73' }, { c: 'e48', q: 'e48q74' }, { c: 'e48', q: 'e48q75' }, { c: 'e48', q: 'e48q76' }, { c: 'e48', q: 'e48q77' }, { c: 'e48', q: 'e48q78' }, { c: 'e48', q: 'e48q79' }, { c: 'e48', q: 'e48q80' }, { c: 'e48', q: 'e48q81' }, { c: 'e48', q: 'e48q82' }, { c: 'e48', q: 'e48q83' }, { c: 'e48', q: 'e48q84' }, { c: 'e48', q: 'e48q85' }, { c: 'e48', q: 'e48q86' }, { c: 'e48', q: 'e48q87' }, { c: 'e48', q: 'e48q88' }, { c: 'e48', q: 'e48q89' }, { c: 'e48', q: 'e48q90' }, { c: 'e48', q: 'e48q91' }, { c: 'e48', q: 'e48q92' }, { c: 'e48', q: 'e48q93' }, { c: 'e48', q: 'e48q94' }, { c: 'e48', q: 'e48q95' }, { c: 'e48', q: 'e48q96' }, { c: 'e48', q: 'e48q97' }, { c: 'e48', q: 'e48q98' }, { c: 'e48', q: 'e48q99' }, { c: 'e48', q: 'e48q100' }, { c: 'e48', q: 'e48q101' }, { c: 'e48', q: 'e48q102' }, { c: 'e48', q: 'e48q103' }, { c: 'e48', q: 'e48q104' }, { c: 'e48', q: 'e48q105' }]
  },
  {
    id: 'b21', subject: 'business',
    title: '2025 工商管理真题 · 11.2 上午场',
    minutes: 90, totalScore: 140,
    sections: [{ label: '一、单选题', from: 0, to: 60, type: 'single', score: 1 }, { label: '二、多选题', from: 60, to: 80, type: 'multiple', score: 2 }, { label: '三、案例分析题（不定项）', from: 80, to: 100, type: 'case', score: 2 }],
    order: [{ c: 'b21', q: 'b21q1' }, { c: 'b21', q: 'b21q2' }, { c: 'b21', q: 'b21q3' }, { c: 'b21', q: 'b21q4' }, { c: 'b21', q: 'b21q5' }, { c: 'b21', q: 'b21q6' }, { c: 'b21', q: 'b21q7' }, { c: 'b21', q: 'b21q8' }, { c: 'b21', q: 'b21q9' }, { c: 'b21', q: 'b21q10' }, { c: 'b21', q: 'b21q11' }, { c: 'b21', q: 'b21q12' }, { c: 'b21', q: 'b21q13' }, { c: 'b21', q: 'b21q14' }, { c: 'b21', q: 'b21q15' }, { c: 'b21', q: 'b21q16' }, { c: 'b21', q: 'b21q17' }, { c: 'b21', q: 'b21q18' }, { c: 'b21', q: 'b21q19' }, { c: 'b21', q: 'b21q20' }, { c: 'b21', q: 'b21q21' }, { c: 'b21', q: 'b21q22' }, { c: 'b21', q: 'b21q23' }, { c: 'b21', q: 'b21q24' }, { c: 'b21', q: 'b21q25' }, { c: 'b21', q: 'b21q26' }, { c: 'b21', q: 'b21q27' }, { c: 'b21', q: 'b21q28' }, { c: 'b21', q: 'b21q29' }, { c: 'b21', q: 'b21q30' }, { c: 'b21', q: 'b21q31' }, { c: 'b21', q: 'b21q32' }, { c: 'b21', q: 'b21q33' }, { c: 'b21', q: 'b21q34' }, { c: 'b21', q: 'b21q35' }, { c: 'b21', q: 'b21q36' }, { c: 'b21', q: 'b21q37' }, { c: 'b21', q: 'b21q38' }, { c: 'b21', q: 'b21q39' }, { c: 'b21', q: 'b21q40' }, { c: 'b21', q: 'b21q41' }, { c: 'b21', q: 'b21q42' }, { c: 'b21', q: 'b21q43' }, { c: 'b21', q: 'b21q44' }, { c: 'b21', q: 'b21q45' }, { c: 'b21', q: 'b21q46' }, { c: 'b21', q: 'b21q47' }, { c: 'b21', q: 'b21q48' }, { c: 'b21', q: 'b21q49' }, { c: 'b21', q: 'b21q50' }, { c: 'b21', q: 'b21q51' }, { c: 'b21', q: 'b21q52' }, { c: 'b21', q: 'b21q53' }, { c: 'b21', q: 'b21q54' }, { c: 'b21', q: 'b21q55' }, { c: 'b21', q: 'b21q56' }, { c: 'b21', q: 'b21q57' }, { c: 'b21', q: 'b21q58' }, { c: 'b21', q: 'b21q59' }, { c: 'b21', q: 'b21q60' }, { c: 'b21', q: 'b21q61' }, { c: 'b21', q: 'b21q62' }, { c: 'b21', q: 'b21q63' }, { c: 'b21', q: 'b21q64' }, { c: 'b21', q: 'b21q65' }, { c: 'b21', q: 'b21q66' }, { c: 'b21', q: 'b21q67' }, { c: 'b21', q: 'b21q68' }, { c: 'b21', q: 'b21q69' }, { c: 'b21', q: 'b21q70' }, { c: 'b21', q: 'b21q71' }, { c: 'b21', q: 'b21q72' }, { c: 'b21', q: 'b21q73' }, { c: 'b21', q: 'b21q74' }, { c: 'b21', q: 'b21q75' }, { c: 'b21', q: 'b21q76' }, { c: 'b21', q: 'b21q77' }, { c: 'b21', q: 'b21q78' }, { c: 'b21', q: 'b21q79' }, { c: 'b21', q: 'b21q80' }, { c: 'b21', q: 'b21q81' }, { c: 'b21', q: 'b21q82' }, { c: 'b21', q: 'b21q83' }, { c: 'b21', q: 'b21q84' }, { c: 'b21', q: 'b21q85' }, { c: 'b21', q: 'b21q86' }, { c: 'b21', q: 'b21q87' }, { c: 'b21', q: 'b21q88' }, { c: 'b21', q: 'b21q89' }, { c: 'b21', q: 'b21q90' }, { c: 'b21', q: 'b21q91' }, { c: 'b21', q: 'b21q92' }, { c: 'b21', q: 'b21q93' }, { c: 'b21', q: 'b21q94' }, { c: 'b21', q: 'b21q95' }, { c: 'b21', q: 'b21q96' }, { c: 'b21', q: 'b21q97' }, { c: 'b21', q: 'b21q98' }, { c: 'b21', q: 'b21q99' }, { c: 'b21', q: 'b21q100' }]
  },
  {
    id: 'e47', subject: 'economy',
    title: '2025 经济基础真题 · 11.1 下午场',
    minutes: 90, totalScore: 140,
    sections: [{ label: '一、单选题', from: 0, to: 70, type: 'single', score: 1 }, { label: '二、多选题', from: 70, to: 105, type: 'multiple', score: 2 }],
    order: [{ c: 'e47', q: 'e47q1' }, { c: 'e47', q: 'e47q2' }, { c: 'e47', q: 'e47q3' }, { c: 'e47', q: 'e47q4' }, { c: 'e47', q: 'e47q5' }, { c: 'e47', q: 'e47q6' }, { c: 'e47', q: 'e47q7' }, { c: 'e47', q: 'e47q8' }, { c: 'e47', q: 'e47q9' }, { c: 'e47', q: 'e47q10' }, { c: 'e47', q: 'e47q11' }, { c: 'e47', q: 'e47q12' }, { c: 'e47', q: 'e47q13' }, { c: 'e47', q: 'e47q14' }, { c: 'e47', q: 'e47q15' }, { c: 'e47', q: 'e47q16' }, { c: 'e47', q: 'e47q17' }, { c: 'e47', q: 'e47q18' }, { c: 'e47', q: 'e47q19' }, { c: 'e47', q: 'e47q20' }, { c: 'e47', q: 'e47q21' }, { c: 'e47', q: 'e47q22' }, { c: 'e47', q: 'e47q23' }, { c: 'e47', q: 'e47q24' }, { c: 'e47', q: 'e47q25' }, { c: 'e47', q: 'e47q26' }, { c: 'e47', q: 'e47q27' }, { c: 'e47', q: 'e47q28' }, { c: 'e47', q: 'e47q29' }, { c: 'e47', q: 'e47q30' }, { c: 'e47', q: 'e47q31' }, { c: 'e47', q: 'e47q32' }, { c: 'e47', q: 'e47q33' }, { c: 'e47', q: 'e47q34' }, { c: 'e47', q: 'e47q35' }, { c: 'e47', q: 'e47q36' }, { c: 'e47', q: 'e47q37' }, { c: 'e47', q: 'e47q38' }, { c: 'e47', q: 'e47q39' }, { c: 'e47', q: 'e47q40' }, { c: 'e47', q: 'e47q41' }, { c: 'e47', q: 'e47q42' }, { c: 'e47', q: 'e47q43' }, { c: 'e47', q: 'e47q44' }, { c: 'e47', q: 'e47q45' }, { c: 'e47', q: 'e47q46' }, { c: 'e47', q: 'e47q47' }, { c: 'e47', q: 'e47q48' }, { c: 'e47', q: 'e47q49' }, { c: 'e47', q: 'e47q50' }, { c: 'e47', q: 'e47q51' }, { c: 'e47', q: 'e47q52' }, { c: 'e47', q: 'e47q53' }, { c: 'e47', q: 'e47q54' }, { c: 'e47', q: 'e47q55' }, { c: 'e47', q: 'e47q56' }, { c: 'e47', q: 'e47q57' }, { c: 'e47', q: 'e47q58' }, { c: 'e47', q: 'e47q59' }, { c: 'e47', q: 'e47q60' }, { c: 'e47', q: 'e47q61' }, { c: 'e47', q: 'e47q62' }, { c: 'e47', q: 'e47q63' }, { c: 'e47', q: 'e47q64' }, { c: 'e47', q: 'e47q65' }, { c: 'e47', q: 'e47q66' }, { c: 'e47', q: 'e47q67' }, { c: 'e47', q: 'e47q68' }, { c: 'e47', q: 'e47q69' }, { c: 'e47', q: 'e47q70' }, { c: 'e47', q: 'e47q71' }, { c: 'e47', q: 'e47q72' }, { c: 'e47', q: 'e47q73' }, { c: 'e47', q: 'e47q74' }, { c: 'e47', q: 'e47q75' }, { c: 'e47', q: 'e47q76' }, { c: 'e47', q: 'e47q77' }, { c: 'e47', q: 'e47q78' }, { c: 'e47', q: 'e47q79' }, { c: 'e47', q: 'e47q80' }, { c: 'e47', q: 'e47q81' }, { c: 'e47', q: 'e47q82' }, { c: 'e47', q: 'e47q83' }, { c: 'e47', q: 'e47q84' }, { c: 'e47', q: 'e47q85' }, { c: 'e47', q: 'e47q86' }, { c: 'e47', q: 'e47q87' }, { c: 'e47', q: 'e47q88' }, { c: 'e47', q: 'e47q89' }, { c: 'e47', q: 'e47q90' }, { c: 'e47', q: 'e47q91' }, { c: 'e47', q: 'e47q92' }, { c: 'e47', q: 'e47q93' }, { c: 'e47', q: 'e47q94' }, { c: 'e47', q: 'e47q95' }, { c: 'e47', q: 'e47q96' }, { c: 'e47', q: 'e47q97' }, { c: 'e47', q: 'e47q98' }, { c: 'e47', q: 'e47q99' }, { c: 'e47', q: 'e47q100' }, { c: 'e47', q: 'e47q101' }, { c: 'e47', q: 'e47q102' }, { c: 'e47', q: 'e47q103' }, { c: 'e47', q: 'e47q104' }, { c: 'e47', q: 'e47q105' }]
  },
  {
    id: 'e46', subject: 'economy',
    title: '2025 经济基础真题 · 11.1 上午场',
    minutes: 90, totalScore: 140,
    sections: [{ label: '一、单选题', from: 0, to: 70, type: 'single', score: 1 }, { label: '二、多选题', from: 70, to: 105, type: 'multiple', score: 2 }],
    order: [{ c: 'e46', q: 'e46q1' }, { c: 'e46', q: 'e46q2' }, { c: 'e46', q: 'e46q3' }, { c: 'e46', q: 'e46q4' }, { c: 'e46', q: 'e46q5' }, { c: 'e46', q: 'e46q6' }, { c: 'e46', q: 'e46q7' }, { c: 'e46', q: 'e46q8' }, { c: 'e46', q: 'e46q9' }, { c: 'e46', q: 'e46q10' }, { c: 'e46', q: 'e46q11' }, { c: 'e46', q: 'e46q12' }, { c: 'e46', q: 'e46q13' }, { c: 'e46', q: 'e46q14' }, { c: 'e46', q: 'e46q15' }, { c: 'e46', q: 'e46q16' }, { c: 'e46', q: 'e46q17' }, { c: 'e46', q: 'e46q18' }, { c: 'e46', q: 'e46q19' }, { c: 'e46', q: 'e46q20' }, { c: 'e46', q: 'e46q21' }, { c: 'e46', q: 'e46q22' }, { c: 'e46', q: 'e46q23' }, { c: 'e46', q: 'e46q24' }, { c: 'e46', q: 'e46q25' }, { c: 'e46', q: 'e46q26' }, { c: 'e46', q: 'e46q27' }, { c: 'e46', q: 'e46q28' }, { c: 'e46', q: 'e46q29' }, { c: 'e46', q: 'e46q30' }, { c: 'e46', q: 'e46q31' }, { c: 'e46', q: 'e46q32' }, { c: 'e46', q: 'e46q33' }, { c: 'e46', q: 'e46q34' }, { c: 'e46', q: 'e46q35' }, { c: 'e46', q: 'e46q36' }, { c: 'e46', q: 'e46q37' }, { c: 'e46', q: 'e46q38' }, { c: 'e46', q: 'e46q39' }, { c: 'e46', q: 'e46q40' }, { c: 'e46', q: 'e46q41' }, { c: 'e46', q: 'e46q42' }, { c: 'e46', q: 'e46q43' }, { c: 'e46', q: 'e46q44' }, { c: 'e46', q: 'e46q45' }, { c: 'e46', q: 'e46q46' }, { c: 'e46', q: 'e46q47' }, { c: 'e46', q: 'e46q48' }, { c: 'e46', q: 'e46q49' }, { c: 'e46', q: 'e46q50' }, { c: 'e46', q: 'e46q51' }, { c: 'e46', q: 'e46q52' }, { c: 'e46', q: 'e46q53' }, { c: 'e46', q: 'e46q54' }, { c: 'e46', q: 'e46q55' }, { c: 'e46', q: 'e46q56' }, { c: 'e46', q: 'e46q57' }, { c: 'e46', q: 'e46q58' }, { c: 'e46', q: 'e46q59' }, { c: 'e46', q: 'e46q60' }, { c: 'e46', q: 'e46q61' }, { c: 'e46', q: 'e46q62' }, { c: 'e46', q: 'e46q63' }, { c: 'e46', q: 'e46q64' }, { c: 'e46', q: 'e46q65' }, { c: 'e46', q: 'e46q66' }, { c: 'e46', q: 'e46q67' }, { c: 'e46', q: 'e46q68' }, { c: 'e46', q: 'e46q69' }, { c: 'e46', q: 'e46q70' }, { c: 'e46', q: 'e46q71' }, { c: 'e46', q: 'e46q72' }, { c: 'e46', q: 'e46q73' }, { c: 'e46', q: 'e46q74' }, { c: 'e46', q: 'e46q75' }, { c: 'e46', q: 'e46q76' }, { c: 'e46', q: 'e46q77' }, { c: 'e46', q: 'e46q78' }, { c: 'e46', q: 'e46q79' }, { c: 'e46', q: 'e46q80' }, { c: 'e46', q: 'e46q81' }, { c: 'e46', q: 'e46q82' }, { c: 'e46', q: 'e46q83' }, { c: 'e46', q: 'e46q84' }, { c: 'e46', q: 'e46q85' }, { c: 'e46', q: 'e46q86' }, { c: 'e46', q: 'e46q87' }, { c: 'e46', q: 'e46q88' }, { c: 'e46', q: 'e46q89' }, { c: 'e46', q: 'e46q90' }, { c: 'e46', q: 'e46q91' }, { c: 'e46', q: 'e46q92' }, { c: 'e46', q: 'e46q93' }, { c: 'e46', q: 'e46q94' }, { c: 'e46', q: 'e46q95' }, { c: 'e46', q: 'e46q96' }, { c: 'e46', q: 'e46q97' }, { c: 'e46', q: 'e46q98' }, { c: 'e46', q: 'e46q99' }, { c: 'e46', q: 'e46q100' }, { c: 'e46', q: 'e46q101' }, { c: 'e46', q: 'e46q102' }, { c: 'e46', q: 'e46q103' }, { c: 'e46', q: 'e46q104' }, { c: 'e46', q: 'e46q105' }]
  },
  {
    id: 'x24e', subject: 'economy',
    title: '2024 经济基础真题 · 拼卷（演练卷 87 ＋ 2023 补 18）',
    minutes: 90, totalScore: 140,
    sections: [{ label: '一、单选题', from: 0, to: 70, type: 'single', score: 1 }, { label: '二、多选题', from: 70, to: 105, type: 'multiple', score: 2 }],
    order: [{ c: 'e38', q: 'e38_1' }, { c: 'e38', q: 'e38_2' }, { c: 'e38', q: 'e38_3' }, { c: 'e38', q: 'e38_4' }, { c: 'e38', q: 'e38_5' }, { c: 'e38', q: 'e38_6' }, { c: 'e38', q: 'e38_7' }, { c: 'e38', q: 'e38_8' }, { c: 'e38', q: 'e38_9' }, { c: 'e38', q: 'e38_10' }, { c: 'e38', q: 'e38_11' }, { c: 'e38', q: 'e38_12' }, { c: 'e38', q: 'e38_13' }, { c: 'e38', q: 'e38_14' }, { c: 'e38', q: 'e38_15' }, { c: 'e38', q: 'e38_16' }, { c: 'e38', q: 'e38_17' }, { c: 'e38', q: 'e38_18' }, { c: 'e38', q: 'e38_19' }, { c: 'e38', q: 'e38_20' }, { c: 'e38', q: 'e38_21' }, { c: 'e38', q: 'e38_22' }, { c: 'e38', q: 'e38_23' }, { c: 'e38', q: 'e38_24' }, { c: 'e38', q: 'e38_25' }, { c: 'e38', q: 'e38_26' }, { c: 'e38', q: 'e38_27' }, { c: 'e38', q: 'e38_28' }, { c: 'e38', q: 'e38_29' }, { c: 'e38', q: 'e38_30' }, { c: 'e38', q: 'e38_31' }, { c: 'e38', q: 'e38_32' }, { c: 'e38', q: 'e38_33' }, { c: 'e38', q: 'e38_34' }, { c: 'e38', q: 'e38_35' }, { c: 'e38', q: 'e38_36' }, { c: 'e38', q: 'e38_37' }, { c: 'e38', q: 'e38_38' }, { c: 'e38', q: 'e38_39' }, { c: 'e38', q: 'e38_40' }, { c: 'e38', q: 'e38_41' }, { c: 'e38', q: 'e38_42' }, { c: 'e38', q: 'e38_43' }, { c: 'e38', q: 'e38_44' }, { c: 'e38', q: 'e38_45' }, { c: 'e38', q: 'e38_46' }, { c: 'e38', q: 'e38_47' }, { c: 'e38', q: 'e38_48' }, { c: 'e38', q: 'e38_49' }, { c: 'e38', q: 'e38_50' }, { c: 'e38', q: 'e38_51' }, { c: 'e38', q: 'e38_52' }, { c: 'e38', q: 'e38_53' }, { c: 'e38', q: 'e38_54' }, { c: 'e38', q: 'e38_55' }, { c: 'e38', q: 'e38_56' }, { c: 'e38', q: 'e38_57' }, { c: 'e45', q: 'e45q1' }, { c: 'e45', q: 'e45q2' }, { c: 'e45', q: 'e45q3' }, { c: 'e45', q: 'e45q4' }, { c: 'e45', q: 'e45q5' }, { c: 'e45', q: 'e45q6' }, { c: 'e45', q: 'e45q7' }, { c: 'e45', q: 'e45q8' }, { c: 'e45', q: 'e45q9' }, { c: 'e45', q: 'e45q10' }, { c: 'e45', q: 'e45q11' }, { c: 'e45', q: 'e45q12' }, { c: 'e45', q: 'e45q13' }, { c: 'e38', q: 'e38_58' }, { c: 'e38', q: 'e38_59' }, { c: 'e38', q: 'e38_60' }, { c: 'e38', q: 'e38_61' }, { c: 'e38', q: 'e38_62' }, { c: 'e38', q: 'e38_63' }, { c: 'e38', q: 'e38_64' }, { c: 'e38', q: 'e38_65' }, { c: 'e38', q: 'e38_66' }, { c: 'e38', q: 'e38_67' }, { c: 'e38', q: 'e38_68' }, { c: 'e38', q: 'e38_69' }, { c: 'e38', q: 'e38_70' }, { c: 'e38', q: 'e38_71' }, { c: 'e38', q: 'e38_72' }, { c: 'e38', q: 'e38_73' }, { c: 'e38', q: 'e38_74' }, { c: 'e38', q: 'e38_75' }, { c: 'e38', q: 'e38_76' }, { c: 'e38', q: 'e38_77' }, { c: 'e38', q: 'e38_78' }, { c: 'e38', q: 'e38_79' }, { c: 'e38', q: 'e38_80' }, { c: 'e38', q: 'e38_81' }, { c: 'e38', q: 'e38_82' }, { c: 'e38', q: 'e38_83' }, { c: 'e38', q: 'e38_84' }, { c: 'e38', q: 'e38_85' }, { c: 'e38', q: 'e38_86' }, { c: 'e38', q: 'e38_87' }, { c: 'e45', q: 'e45q69' }, { c: 'e45', q: 'e45q70' }, { c: 'e45', q: 'e45q71' }, { c: 'e45', q: 'e45q72' }, { c: 'e45', q: 'e45q73' }]
  },
  {
    id: 'x24b1', subject: 'business',
    title: '2024 工商管理真题 · 拼卷A（卷一 55 ＋ 上午场 45）',
    minutes: 90, totalScore: 140,
    sections: [{ label: '一、单选题', from: 0, to: 60, type: 'single', score: 1 }, { label: '二、多选题', from: 60, to: 80, type: 'multiple', score: 2 }, { label: '三、案例分析题（不定项）', from: 80, to: 100, type: 'case', score: 2 }],
    order: [{ c: 'b16', q: 'b16q1' }, { c: 'b16', q: 'b16q2' }, { c: 'b16', q: 'b16q3' }, { c: 'b16', q: 'b16q4' }, { c: 'b16', q: 'b16q5' }, { c: 'b16', q: 'b16q6' }, { c: 'b16', q: 'b16q7' }, { c: 'b16', q: 'b16q8' }, { c: 'b16', q: 'b16q9' }, { c: 'b16', q: 'b16q10' }, { c: 'b16', q: 'b16q11' }, { c: 'b16', q: 'b16q12' }, { c: 'b16', q: 'b16q13' }, { c: 'b16', q: 'b16q15' }, { c: 'b16', q: 'b16q16' }, { c: 'b16', q: 'b16q17' }, { c: 'b16', q: 'b16q19' }, { c: 'b16', q: 'b16q20' }, { c: 'b16', q: 'b16q21' }, { c: 'b16', q: 'b16q22' }, { c: 'b16', q: 'b16q23' }, { c: 'b16', q: 'b16q24' }, { c: 'b16', q: 'b16q25' }, { c: 'b16', q: 'b16q26' }, { c: 'b16', q: 'b16q27' }, { c: 'b16', q: 'b16q28' }, { c: 'b12', q: 'b12q1' }, { c: 'b12', q: 'b12q2' }, { c: 'b12', q: 'b12q3' }, { c: 'b12', q: 'b12q4' }, { c: 'b12', q: 'b12q5' }, { c: 'b12', q: 'b12q6' }, { c: 'b12', q: 'b12q7' }, { c: 'b12', q: 'b12q8' }, { c: 'b12', q: 'b12q9' }, { c: 'b12', q: 'b12q10' }, { c: 'b12', q: 'b12q11' }, { c: 'b12', q: 'b12q12' }, { c: 'b12', q: 'b12q13' }, { c: 'b12', q: 'b12q14' }, { c: 'b12', q: 'b12q15' }, { c: 'b12', q: 'b12q16' }, { c: 'b12', q: 'b12q17' }, { c: 'b12', q: 'b12q18' }, { c: 'b12', q: 'b12q19' }, { c: 'b12', q: 'b12q20' }, { c: 'b12', q: 'b12q21' }, { c: 'b12', q: 'b12q22' }, { c: 'b12', q: 'b12q23' }, { c: 'b12', q: 'b12q24' }, { c: 'b12', q: 'b12q25' }, { c: 'b12', q: 'b12q26' }, { c: 'b12', q: 'b12q27' }, { c: 'b12', q: 'b12q28' }, { c: 'b12', q: 'b12q29' }, { c: 'b12', q: 'b12q30' }, { c: 'b12', q: 'b12q31' }, { c: 'b12', q: 'b12q32' }, { c: 'b12', q: 'b12q33' }, { c: 'b12', q: 'b12q34' }, { c: 'b16', q: 'b16q14' }, { c: 'b16', q: 'b16q18' }, { c: 'b16', q: 'b16q29' }, { c: 'b16', q: 'b16q30' }, { c: 'b16', q: 'b16q31' }, { c: 'b16', q: 'b16q32' }, { c: 'b16', q: 'b16q33' }, { c: 'b16', q: 'b16q34' }, { c: 'b16', q: 'b16q35' }, { c: 'b12', q: 'b12q58' }, { c: 'b12', q: 'b12q59' }, { c: 'b12', q: 'b12q60' }, { c: 'b12', q: 'b12q61' }, { c: 'b12', q: 'b12q62' }, { c: 'b12', q: 'b12q63' }, { c: 'b12', q: 'b12q64' }, { c: 'b12', q: 'b12q65' }, { c: 'b12', q: 'b12q66' }, { c: 'b12', q: 'b12q67' }, { c: 'b12', q: 'b12q68' }, { c: 'b16', q: 'b16q36' }, { c: 'b16', q: 'b16q37' }, { c: 'b16', q: 'b16q38' }, { c: 'b16', q: 'b16q39' }, { c: 'b16', q: 'b16q40' }, { c: 'b16', q: 'b16q41' }, { c: 'b16', q: 'b16q42' }, { c: 'b16', q: 'b16q43' }, { c: 'b16', q: 'b16q44' }, { c: 'b16', q: 'b16q45' }, { c: 'b16', q: 'b16q46' }, { c: 'b16', q: 'b16q47' }, { c: 'b16', q: 'b16q48' }, { c: 'b16', q: 'b16q49' }, { c: 'b16', q: 'b16q50' }, { c: 'b16', q: 'b16q51' }, { c: 'b16', q: 'b16q52' }, { c: 'b16', q: 'b16q53' }, { c: 'b16', q: 'b16q54' }, { c: 'b16', q: 'b16q55' }]
  },
  {
    id: 'x24b2', subject: 'business',
    title: '2024 工商管理真题 · 拼卷B（下午场 83 ＋ 2023 补 17）',
    minutes: 90, totalScore: 140,
    sections: [{ label: '一、单选题', from: 0, to: 60, type: 'single', score: 1 }, { label: '二、多选题', from: 60, to: 80, type: 'multiple', score: 2 }, { label: '三、案例分析题（不定项）', from: 80, to: 100, type: 'case', score: 2 }],
    order: [{ c: 'b13', q: 'b13q1' }, { c: 'b13', q: 'b13q2' }, { c: 'b13', q: 'b13q3' }, { c: 'b13', q: 'b13q4' }, { c: 'b13', q: 'b13q5' }, { c: 'b13', q: 'b13q6' }, { c: 'b13', q: 'b13q7' }, { c: 'b13', q: 'b13q8' }, { c: 'b13', q: 'b13q9' }, { c: 'b13', q: 'b13q10' }, { c: 'b13', q: 'b13q11' }, { c: 'b13', q: 'b13q12' }, { c: 'b13', q: 'b13q13' }, { c: 'b13', q: 'b13q14' }, { c: 'b13', q: 'b13q15' }, { c: 'b13', q: 'b13q16' }, { c: 'b13', q: 'b13q17' }, { c: 'b13', q: 'b13q18' }, { c: 'b13', q: 'b13q19' }, { c: 'b13', q: 'b13q20' }, { c: 'b13', q: 'b13q21' }, { c: 'b13', q: 'b13q22' }, { c: 'b13', q: 'b13q23' }, { c: 'b13', q: 'b13q24' }, { c: 'b13', q: 'b13q25' }, { c: 'b13', q: 'b13q26' }, { c: 'b13', q: 'b13q27' }, { c: 'b13', q: 'b13q28' }, { c: 'b13', q: 'b13q29' }, { c: 'b13', q: 'b13q30' }, { c: 'b13', q: 'b13q31' }, { c: 'b13', q: 'b13q32' }, { c: 'b13', q: 'b13q33' }, { c: 'b13', q: 'b13q34' }, { c: 'b13', q: 'b13q35' }, { c: 'b13', q: 'b13q36' }, { c: 'b13', q: 'b13q37' }, { c: 'b13', q: 'b13q38' }, { c: 'b13', q: 'b13q39' }, { c: 'b13', q: 'b13q40' }, { c: 'b13', q: 'b13q41' }, { c: 'b13', q: 'b13q42' }, { c: 'b13', q: 'b13q43' }, { c: 'b13', q: 'b13q44' }, { c: 'b13', q: 'b13q45' }, { c: 'b13', q: 'b13q46' }, { c: 'b13', q: 'b13q47' }, { c: 'b13', q: 'b13q48' }, { c: 'b13', q: 'b13q49' }, { c: 'b13', q: 'b13q50' }, { c: 'b13', q: 'b13q51' }, { c: 'b13', q: 'b13q52' }, { c: 'b13', q: 'b13q53' }, { c: 'b13', q: 'b13q54' }, { c: 'b13', q: 'b13q55' }, { c: 'b13', q: 'b13q56' }, { c: 'b13', q: 'b13q82' }, { c: 'b13', q: 'b13q83' }, { c: 'b17', q: 'b17q1' }, { c: 'b17', q: 'b17q2' }, { c: 'b13', q: 'b13q57' }, { c: 'b13', q: 'b13q58' }, { c: 'b13', q: 'b13q59' }, { c: 'b13', q: 'b13q60' }, { c: 'b13', q: 'b13q61' }, { c: 'b13', q: 'b13q62' }, { c: 'b13', q: 'b13q63' }, { c: 'b13', q: 'b13q64' }, { c: 'b13', q: 'b13q65' }, { c: 'b13', q: 'b13q66' }, { c: 'b13', q: 'b13q67' }, { c: 'b13', q: 'b13q68' }, { c: 'b13', q: 'b13q69' }, { c: 'b13', q: 'b13q70' }, { c: 'b13', q: 'b13q71' }, { c: 'b13', q: 'b13q72' }, { c: 'b13', q: 'b13q73' }, { c: 'b14', q: 'b14q56' }, { c: 'b14', q: 'b14q57' }, { c: 'b14', q: 'b14q58' }, { c: 'b13', q: 'b13q74' }, { c: 'b13', q: 'b13q75' }, { c: 'b13', q: 'b13q76' }, { c: 'b13', q: 'b13q77' }, { c: 'b13', q: 'b13q78' }, { c: 'b13', q: 'b13q79' }, { c: 'b13', q: 'b13q80' }, { c: 'b13', q: 'b13q81' }, { c: 'b14', q: 'b14q75' }, { c: 'b14', q: 'b14q76' }, { c: 'b14', q: 'b14q77' }, { c: 'b14', q: 'b14q78' }, { c: 'b14', q: 'b14q79' }, { c: 'b14', q: 'b14q80' }, { c: 'b14', q: 'b14q81' }, { c: 'b14', q: 'b14q82' }, { c: 'b14', q: 'b14q83' }, { c: 'b14', q: 'b14q84' }, { c: 'b14', q: 'b14q85' }, { c: 'b14', q: 'b14q86' }]
  },
  {
    id: 'x24b3', subject: 'business',
    title: '2024 工商管理 · 模拟卷（真题 ＋ 精选习题案例 15）',
    minutes: 90, totalScore: 140,
    sections: [{ label: '一、单选题', from: 0, to: 60, type: 'single', score: 1 }, { label: '二、多选题', from: 60, to: 80, type: 'multiple', score: 2 }, { label: '三、案例分析题（不定项）', from: 80, to: 100, type: 'case', score: 2 }],
    order: [{ c: 'b15', q: 'b15q1' }, { c: 'b15', q: 'b15q2' }, { c: 'b15', q: 'b15q3' }, { c: 'b15', q: 'b15q4' }, { c: 'b15', q: 'b15q5' }, { c: 'b15', q: 'b15q6' }, { c: 'b15', q: 'b15q7' }, { c: 'b15', q: 'b15q8' }, { c: 'b15', q: 'b15q9' }, { c: 'b15', q: 'b15q10' }, { c: 'b15', q: 'b15q11' }, { c: 'b15', q: 'b15q15' }, { c: 'b15', q: 'b15q16' }, { c: 'b15', q: 'b15q17' }, { c: 'b15', q: 'b15q18' }, { c: 'b15', q: 'b15q19' }, { c: 'b15', q: 'b15q20' }, { c: 'b15', q: 'b15q21' }, { c: 'b15', q: 'b15q22' }, { c: 'b15', q: 'b15q23' }, { c: 'b15', q: 'b15q26' }, { c: 'b15', q: 'b15q27' }, { c: 'b15', q: 'b15q28' }, { c: 'b15', q: 'b15q29' }, { c: 'b15', q: 'b15q30' }, { c: 'b15', q: 'b15q31' }, { c: 'b15', q: 'b15q32' }, { c: 'b15', q: 'b15q33' }, { c: 'b15', q: 'b15q34' }, { c: 'b15', q: 'b15q38' }, { c: 'b15', q: 'b15q39' }, { c: 'b15', q: 'b15q40' }, { c: 'b15', q: 'b15q41' }, { c: 'b15', q: 'b15q42' }, { c: 'b15', q: 'b15q43' }, { c: 'b15', q: 'b15q44' }, { c: 'b15', q: 'b15q45' }, { c: 'b15', q: 'b15q46' }, { c: 'b15', q: 'b15q47' }, { c: 'b15', q: 'b15q48' }, { c: 'b15', q: 'b15q49' }, { c: 'b15', q: 'b15q50' }, { c: 'b15', q: 'b15q51' }, { c: 'b15', q: 'b15q52' }, { c: 'b15', q: 'b15q53' }, { c: 'b15', q: 'b15q54' }, { c: 'b15', q: 'b15q55' }, { c: 'b15', q: 'b15q56' }, { c: 'b15', q: 'b15q57' }, { c: 'b12', q: 'b12q35' }, { c: 'b12', q: 'b12q36' }, { c: 'b12', q: 'b12q37' }, { c: 'b12', q: 'b12q38' }, { c: 'b12', q: 'b12q39' }, { c: 'b12', q: 'b12q40' }, { c: 'b12', q: 'b12q41' }, { c: 'b12', q: 'b12q42' }, { c: 'b12', q: 'b12q43' }, { c: 'b12', q: 'b12q44' }, { c: 'b12', q: 'b12q45' }, { c: 'b15', q: 'b15q12' }, { c: 'b15', q: 'b15q13' }, { c: 'b15', q: 'b15q14' }, { c: 'b15', q: 'b15q24' }, { c: 'b15', q: 'b15q25' }, { c: 'b15', q: 'b15q35' }, { c: 'b15', q: 'b15q36' }, { c: 'b15', q: 'b15q37' }, { c: 'b15', q: 'b15q58' }, { c: 'b15', q: 'b15q59' }, { c: 'b15', q: 'b15q60' }, { c: 'b15', q: 'b15q61' }, { c: 'b15', q: 'b15q62' }, { c: 'b15', q: 'b15q63' }, { c: 'b12', q: 'b12q69' }, { c: 'b12', q: 'b12q70' }, { c: 'b12', q: 'b12q71' }, { c: 'b12', q: 'b12q72' }, { c: 'b12', q: 'b12q73' }, { c: 'b12', q: 'b12q74' }, { c: 'b15', q: 'b15q64' }, { c: 'b15', q: 'b15q65' }, { c: 'b15', q: 'b15q66' }, { c: 'b15', q: 'b15q67' }, { c: 'b15', q: 'b15q68' }, { c: 'b20', q: 'b20q73' }, { c: 'b20', q: 'b20q74' }, { c: 'b20', q: 'b20q75' }, { c: 'b20', q: 'b20q76' }, { c: 'b20', q: 'b20q77' }, { c: 'b20', q: 'b20q78' }, { c: 'b20', q: 'b20q79' }, { c: 'b20', q: 'b20q80' }, { c: 'b20', q: 'b20q81' }, { c: 'b20', q: 'b20q82' }, { c: 'b20', q: 'b20q83' }, { c: 'b20', q: 'b20q84' }, { c: 'b20', q: 'b20q85' }, { c: 'b20', q: 'b20q86' }, { c: 'b20', q: 'b20q87' }]
  },
  {
    id: 'x22b2', subject: 'business',
    title: '2022 工商管理真题 · 补考场（100 题）',
    minutes: 90, totalScore: 140,
    sections: [{label:'一、单选题',from:0,to:60,type:'single',score:1},{label:'二、多选题',from:60,to:80,type:'multiple',score:2},{label:'三、案例分析题（不定项）',from:80,to:100,type:'case',score:2}],
    order: [{c:'b25',q:'b25q1'}, {c:'b25',q:'b25q2'}, {c:'b25',q:'b25q3'}, {c:'b25',q:'b25q4'}, {c:'b25',q:'b25q5'}, {c:'b25',q:'b25q6'}, {c:'b25',q:'b25q7'}, {c:'b25',q:'b25q8'}, {c:'b25',q:'b25q9'}, {c:'b25',q:'b25q10'}, {c:'b25',q:'b25q11'}, {c:'b25',q:'b25q12'}, {c:'b25',q:'b25q13'}, {c:'b25',q:'b25q14'}, {c:'b25',q:'b25q15'}, {c:'b25',q:'b25q16'}, {c:'b25',q:'b25q17'}, {c:'b25',q:'b25q18'}, {c:'b25',q:'b25q19'}, {c:'b25',q:'b25q20'}, {c:'b25',q:'b25q21'}, {c:'b25',q:'b25q22'}, {c:'b25',q:'b25q23'}, {c:'b25',q:'b25q24'}, {c:'b25',q:'b25q25'}, {c:'b25',q:'b25q26'}, {c:'b25',q:'b25q27'}, {c:'b25',q:'b25q28'}, {c:'b25',q:'b25q29'}, {c:'b25',q:'b25q30'}, {c:'b25',q:'b25q31'}, {c:'b25',q:'b25q32'}, {c:'b25',q:'b25q33'}, {c:'b25',q:'b25q34'}, {c:'b25',q:'b25q35'}, {c:'b25',q:'b25q36'}, {c:'b25',q:'b25q37'}, {c:'b25',q:'b25q38'}, {c:'b25',q:'b25q39'}, {c:'b25',q:'b25q40'}, {c:'b25',q:'b25q41'}, {c:'b25',q:'b25q42'}, {c:'b25',q:'b25q43'}, {c:'b25',q:'b25q44'}, {c:'b25',q:'b25q45'}, {c:'b25',q:'b25q46'}, {c:'b25',q:'b25q47'}, {c:'b25',q:'b25q48'}, {c:'b25',q:'b25q49'}, {c:'b25',q:'b25q50'}, {c:'b25',q:'b25q51'}, {c:'b25',q:'b25q52'}, {c:'b25',q:'b25q53'}, {c:'b25',q:'b25q54'}, {c:'b25',q:'b25q55'}, {c:'b25',q:'b25q56'}, {c:'b25',q:'b25q57'}, {c:'b25',q:'b25q58'}, {c:'b25',q:'b25q59'}, {c:'b25',q:'b25q60'}, {c:'b25',q:'b25q61'}, {c:'b25',q:'b25q62'}, {c:'b25',q:'b25q63'}, {c:'b25',q:'b25q64'}, {c:'b25',q:'b25q65'}, {c:'b25',q:'b25q66'}, {c:'b25',q:'b25q67'}, {c:'b25',q:'b25q68'}, {c:'b25',q:'b25q69'}, {c:'b25',q:'b25q70'}, {c:'b25',q:'b25q71'}, {c:'b25',q:'b25q72'}, {c:'b25',q:'b25q73'}, {c:'b25',q:'b25q74'}, {c:'b25',q:'b25q75'}, {c:'b25',q:'b25q76'}, {c:'b25',q:'b25q77'}, {c:'b25',q:'b25q78'}, {c:'b25',q:'b25q79'}, {c:'b25',q:'b25q80'}, {c:'b25',q:'b25q81'}, {c:'b25',q:'b25q82'}, {c:'b25',q:'b25q83'}, {c:'b25',q:'b25q84'}, {c:'b25',q:'b25q85'}, {c:'b25',q:'b25q86'}, {c:'b25',q:'b25q87'}, {c:'b25',q:'b25q88'}, {c:'b25',q:'b25q89'}, {c:'b25',q:'b25q90'}, {c:'b25',q:'b25q91'}, {c:'b25',q:'b25q92'}, {c:'b25',q:'b25q93'}, {c:'b25',q:'b25q94'}, {c:'b25',q:'b25q95'}, {c:'b25',q:'b25q96'}, {c:'b25',q:'b25q97'}, {c:'b25',q:'b25q98'}, {c:'b25',q:'b25q99'}, {c:'b25',q:'b25q100'}]
  },
  {
    id: 'x23b2', subject: 'business',
    title: '2023 工商管理真题 · 11.12 下午场（拼卷 89＋11）',
    minutes: 90, totalScore: 140,
    sections: [{label:'一、单选题',from:0,to:60,type:'single',score:1},{label:'二、多选题',from:60,to:80,type:'multiple',score:2},{label:'三、案例分析题（不定项）',from:80,to:100,type:'case',score:2}],
    order: [{c:'b26',q:'b26q1'}, {c:'b26',q:'b26q2'}, {c:'b26',q:'b26q3'}, {c:'b26',q:'b26q4'}, {c:'b26',q:'b26q5'}, {c:'b26',q:'b26q6'}, {c:'b26',q:'b26q7'}, {c:'b26',q:'b26q8'}, {c:'b26',q:'b26q9'}, {c:'b26',q:'b26q10'}, {c:'b26',q:'b26q11'}, {c:'b26',q:'b26q12'}, {c:'b26',q:'b26q13'}, {c:'b26',q:'b26q14'}, {c:'b26',q:'b26q15'}, {c:'b26',q:'b26q16'}, {c:'b26',q:'b26q17'}, {c:'b26',q:'b26q18'}, {c:'b26',q:'b26q19'}, {c:'b26',q:'b26q20'}, {c:'b26',q:'b26q21'}, {c:'b26',q:'b26q22'}, {c:'b26',q:'b26q23'}, {c:'b26',q:'b26q24'}, {c:'b26',q:'b26q25'}, {c:'b26',q:'b26q26'}, {c:'b26',q:'b26q27'}, {c:'b26',q:'b26q28'}, {c:'b26',q:'b26q29'}, {c:'b26',q:'b26q30'}, {c:'b26',q:'b26q31'}, {c:'b26',q:'b26q32'}, {c:'b26',q:'b26q33'}, {c:'b26',q:'b26q34'}, {c:'b26',q:'b26q35'}, {c:'b26',q:'b26q36'}, {c:'b26',q:'b26q37'}, {c:'b26',q:'b26q38'}, {c:'b26',q:'b26q39'}, {c:'b26',q:'b26q40'}, {c:'b26',q:'b26q41'}, {c:'b26',q:'b26q42'}, {c:'b26',q:'b26q43'}, {c:'b26',q:'b26q44'}, {c:'b26',q:'b26q45'}, {c:'b26',q:'b26q46'}, {c:'b26',q:'b26q47'}, {c:'b26',q:'b26q48'}, {c:'b26',q:'b26q49'}, {c:'b26',q:'b26q50'}, {c:'b26',q:'b26q51'}, {c:'b26',q:'b26q52'}, {c:'b26',q:'b26q53'}, {c:'b26',q:'b26q54'}, {c:'b26',q:'b26q55'}, {c:'b26',q:'b26q56'}, {c:'b14',q:'b14q4'}, {c:'b14',q:'b14q18'}, {c:'b14',q:'b14q33'}, {c:'b14',q:'b14q48'}, {c:'b26',q:'b26q57'}, {c:'b26',q:'b26q58'}, {c:'b26',q:'b26q59'}, {c:'b26',q:'b26q60'}, {c:'b26',q:'b26q61'}, {c:'b26',q:'b26q62'}, {c:'b26',q:'b26q63'}, {c:'b26',q:'b26q64'}, {c:'b26',q:'b26q65'}, {c:'b26',q:'b26q66'}, {c:'b26',q:'b26q67'}, {c:'b26',q:'b26q68'}, {c:'b26',q:'b26q69'}, {c:'b14',q:'b14q56'}, {c:'b14',q:'b14q59'}, {c:'b14',q:'b14q63'}, {c:'b14',q:'b14q66'}, {c:'b14',q:'b14q70'}, {c:'b14',q:'b14q73'}, {c:'b14',q:'b14q81'}, {c:'b26',q:'b26q70'}, {c:'b26',q:'b26q71'}, {c:'b26',q:'b26q72'}, {c:'b26',q:'b26q73'}, {c:'b26',q:'b26q74'}, {c:'b26',q:'b26q75'}, {c:'b26',q:'b26q76'}, {c:'b26',q:'b26q77'}, {c:'b26',q:'b26q78'}, {c:'b26',q:'b26q79'}, {c:'b26',q:'b26q80'}, {c:'b26',q:'b26q81'}, {c:'b26',q:'b26q82'}, {c:'b26',q:'b26q83'}, {c:'b26',q:'b26q84'}, {c:'b26',q:'b26q85'}, {c:'b26',q:'b26q86'}, {c:'b26',q:'b26q87'}, {c:'b26',q:'b26q88'}, {c:'b26',q:'b26q89'}]
  },
  {
    id: 'x22b1', subject: 'business',
    title: '2022 工商管理真题 · 网友回忆版（94 题 · 缺 12 道案例，满分 122）',
    minutes: 85, totalScore: 122,
    sections: [{label:'一、单选题',from:0,to:66,type:'single',score:1},
               {label:'二、多选题',from:66,to:86,type:'multiple',score:2},
               {label:'三、案例分析题（不定项）',from:86,to:94,type:'case',score:2}],
    order: [{c:'b27',q:'b27q1'}, {c:'b27',q:'b27q2'}, {c:'b27',q:'b27q3'}, {c:'b27',q:'b27q4'}, {c:'b27',q:'b27q5'}, {c:'b27',q:'b27q6'}, {c:'b27',q:'b27q7'}, {c:'b27',q:'b27q8'}, {c:'b27',q:'b27q9'}, {c:'b27',q:'b27q10'}, {c:'b27',q:'b27q11'}, {c:'b27',q:'b27q12'}, {c:'b27',q:'b27q13'}, {c:'b27',q:'b27q14'}, {c:'b27',q:'b27q15'}, {c:'b27',q:'b27q16'}, {c:'b27',q:'b27q17'}, {c:'b27',q:'b27q18'}, {c:'b27',q:'b27q19'}, {c:'b27',q:'b27q20'}, {c:'b27',q:'b27q21'}, {c:'b27',q:'b27q22'}, {c:'b27',q:'b27q23'}, {c:'b27',q:'b27q24'}, {c:'b27',q:'b27q25'}, {c:'b27',q:'b27q26'}, {c:'b27',q:'b27q27'}, {c:'b27',q:'b27q28'}, {c:'b27',q:'b27q29'}, {c:'b27',q:'b27q30'}, {c:'b27',q:'b27q31'}, {c:'b27',q:'b27q32'}, {c:'b27',q:'b27q33'}, {c:'b27',q:'b27q34'}, {c:'b27',q:'b27q35'}, {c:'b27',q:'b27q36'}, {c:'b27',q:'b27q37'}, {c:'b27',q:'b27q38'}, {c:'b27',q:'b27q39'}, {c:'b27',q:'b27q40'}, {c:'b27',q:'b27q41'}, {c:'b27',q:'b27q42'}, {c:'b27',q:'b27q43'}, {c:'b27',q:'b27q44'}, {c:'b27',q:'b27q45'}, {c:'b27',q:'b27q46'}, {c:'b27',q:'b27q47'}, {c:'b27',q:'b27q48'}, {c:'b27',q:'b27q49'}, {c:'b27',q:'b27q50'}, {c:'b27',q:'b27q51'}, {c:'b27',q:'b27q52'}, {c:'b27',q:'b27q53'}, {c:'b27',q:'b27q54'}, {c:'b27',q:'b27q55'}, {c:'b27',q:'b27q56'}, {c:'b27',q:'b27q57'}, {c:'b27',q:'b27q58'}, {c:'b27',q:'b27q59'}, {c:'b27',q:'b27q60'}, {c:'b27',q:'b27q61'}, {c:'b27',q:'b27q62'}, {c:'b27',q:'b27q63'}, {c:'b27',q:'b27q64'}, {c:'b27',q:'b27q65'}, {c:'b27',q:'b27q66'}, {c:'b27',q:'b27q67'}, {c:'b27',q:'b27q68'}, {c:'b27',q:'b27q69'}, {c:'b27',q:'b27q70'}, {c:'b27',q:'b27q71'}, {c:'b27',q:'b27q72'}, {c:'b27',q:'b27q73'}, {c:'b27',q:'b27q74'}, {c:'b27',q:'b27q75'}, {c:'b27',q:'b27q76'}, {c:'b27',q:'b27q77'}, {c:'b27',q:'b27q78'}, {c:'b27',q:'b27q79'}, {c:'b27',q:'b27q80'}, {c:'b27',q:'b27q81'}, {c:'b27',q:'b27q82'}, {c:'b27',q:'b27q83'}, {c:'b27',q:'b27q84'}, {c:'b27',q:'b27q85'}, {c:'b27',q:'b27q86'}, {c:'b27',q:'b27q87'}, {c:'b27',q:'b27q88'}, {c:'b27',q:'b27q89'}, {c:'b27',q:'b27q90'}, {c:'b27',q:'b27q91'}, {c:'b27',q:'b27q92'}, {c:'b27',q:'b27q93'}, {c:'b27',q:'b27q94'}]
  }
];
const MOCK_SESS_KEY = 'mock_session_v1';
const MOCK_HIS_KEY = 'mock_history_v1';
let mock = null, mockTick = null;

function mockPaper(id) { return MOCK_PAPERS.find(p => p.id === id) || null; }
function mockSec(paper, i) {
  return paper.sections.find(s => i >= s.from && i < s.to) || paper.sections[paper.sections.length - 1];
}
function mockItems(paper) {
  // 拼卷：按 order 中显式指定的 qid 顺序组卷（可跨章节）
  if (paper.order && paper.order.length) {
    return paper.order.map(o => {
      const ch = findChapter(paper.subject, o.c);
      const q = ch && ch.questions ? ch.questions.find(x => x.id === o.q) : null;
      return q ? { q: applyCorrections(q), subject: paper.subject, chapterId: o.c, chapterTitle: ch.title } : null;
    }).filter(Boolean);
  }
  const ch = findChapter(paper.subject, paper.chapterId);
  if (!ch || !ch.questions) return [];
  return ch.questions.map(q => ({ q: applyCorrections(q), subject: paper.subject, chapterId: paper.chapterId, chapterTitle: ch.title }));
}
/* 某次记录要回看的题数 = 错选 + 少选 + 未答（优先按逐题明细统计，兼容旧记录缺 part 的情况） */
function mockBadCount(h) {
  if (!h) return 0;
  if (h.rows && h.rows.length) return h.rows.filter(r => r[5] !== 'right').length;
  return (h.wrong || 0) + (h.part || 0) + (h.blank || 0);
}
/* ---------- 模考记录跨设备同步（2026-10-25 新增） ----------
   指纹 = 试卷ID|日期|用时|明细行数：跨设备拉取时同一场只保留一份，重复上传也不会膨胀。
   排序按时间升序（无 ts 的旧记录用日期兜底），并从最新往旧累计体积，超过预算就裁掉更早的场次。 */
function mockHisKey(h) {
  if (!h) return '';
  return [h.paperId || '', h.date || '', h.usedSec || 0, (h.rows && h.rows.length) || 0].join('|');
}
function mockHisTs(h) {
  if (h && h.ts) return h.ts;
  const d = h && h.date ? new Date(h.date + 'T00:00:00').getTime() : 0;
  return isNaN(d) ? 0 : d;
}
function trimMockHistory(list) {
  const arr = (list || []).filter(Boolean).sort((a, b) => mockHisTs(a) - mockHisTs(b));
  const kept = [];
  let bytes = 0;
  for (let i = arr.length - 1; i >= 0; i--) {          // 从最新一场往前装
    const s = JSON.stringify(arr[i]).length;
    if (kept.length >= 10 && bytes + s > 260000) break; // 至少保留 10 场，其余按体积让位
    kept.unshift(arr[i]); bytes += s;
    if (kept.length >= 50) break;                       // 上限 50 场
  }
  return kept;
}
function mergeMockHistory(inc, cur) {
  const map = new Map();
  for (const h of (cur || [])) if (h && h.paperId) map.set(mockHisKey(h), h);
  for (const h of (inc || [])) if (h && h.paperId) {
    const k = mockHisKey(h);
    if (!map.has(k)) map.set(k, h);     // 指纹相同视为同一场，保留本机副本
  }
  return trimMockHistory(Array.from(map.values()));
}
function mockHistory() { try { return JSON.parse(localStorage.getItem(MOCK_HIS_KEY) || '[]'); } catch (e) { return []; } }
function mockSaveHistory(h) { localStorage.setItem(MOCK_HIS_KEY, JSON.stringify(trimMockHistory(h))); }
function loadMockSession() { try { return JSON.parse(localStorage.getItem(MOCK_SESS_KEY) || 'null'); } catch (e) { return null; } }
function saveMockSession() { if (mock) localStorage.setItem(MOCK_SESS_KEY, JSON.stringify(mock)); }
function clearMockSession() { mock = null; localStorage.removeItem(MOCK_SESS_KEY); stopMockTick(); }
function stopMockTick() { if (mockTick) { clearInterval(mockTick); mockTick = null; } }
function mockRemain() {
  if (!mock) return 0;
  const p = mockPaper(mock.paperId);
  if (!p) return 0;
  return Math.max(0, p.minutes * 60 - Math.floor((Date.now() - mock.startedAt) / 1000));
}
function mockFmt(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

/* ---------- 列表页 ---------- */
window.startMock = function (paperId) {
  const saved = loadMockSession();
  if (saved && saved.paperId === paperId && !saved.submitted) {
    mock = saved;
  } else {
    mock = { paperId, idx: 0, answers: {}, startedAt: Date.now(), submitted: false };
  }
  saveMockSession();
  location.hash = '#/mock';
  renderMock();
};
window.mockResume = function () {
  const saved = loadMockSession();
  if (!saved || saved.submitted) { toast('没有进行中的模考'); return; }
  mock = saved;
  location.hash = '#/mock';
  renderMock();
};
window.mockDiscard = function () {
  if (!confirm('放弃本次模考？已作答内容将被清空。')) return;
  clearMockSession();
  renderMock();
};
window.mockBackList = function () {
  const saved = loadMockSession();
  if (saved && !saved.submitted) {
    if (!confirm('退出后计时继续，下次可继续作答。确定退出？')) return;
    stopMockTick();
    location.hash = '#/today';
    return;
  }
  clearMockSession();
  renderMock();
};
window.mockStartFresh = function (paperId) {
  if (loadMockSession()) clearMockSession();
  startMock(paperId);
};

function renderMock() {
  const app = document.getElementById('app');
  let saved = loadMockSession();
  // 卷面调整后，旧会话可能指向已下线的卷 → 清理，避免读取 null 报错
  if (saved && !mockPaper(saved.paperId)) { clearMockSession(); saved = null; }
  /* 历史场次回看（#/mock?h=<索引>）：优先于成绩页，
     这样交卷后即使点了「返回模考列表」，仍能从列表再次打开那次的逐题明细 */
  const hv = window._q && window._q.h;
  if (hv !== undefined && hv !== '') { stopMockTick(); renderMockHis(parseInt(hv, 10)); return; }
  /* ?list=1：从历史回看页返回时强制显示列表（否则会被未交卷的会话拉回考试页） */
  const forceList = window._q && window._q.list;
  if (!forceList) {
    /* 关键：全局 mock 必须与本地会话同步。
       2026-10-25 修：重开站点后 mock 为 null，直接调 renderMockExam/Result 会抛
       "Cannot read properties of null (reading 'paperId')"，表现就是点「模考」没反应。 */
    if (saved && !saved.submitted) { mock = saved; renderMockExam(); return; }
    /* 已交卷的会话只在「本次打开站点、刚交完卷」时占据入口（保留交卷后回看成绩的习惯）；
       刷新/重新进入站点后回到列表，成绩与逐题明细从历史「回看」进，避免老成绩页顶住入口。 */
    if (saved && saved.submitted && mock && mock.submitted && mock.paperId === saved.paperId) {
      mock = saved; renderMockResult(); return;
    }
  }
  stopMockTick();
  const his = mockHistory();
  const cards = MOCK_PAPERS.map(p => {
    const runs = his.filter(h => h.paperId === p.id);
    const best = runs.length ? Math.max.apply(null, runs.map(h => h.score)) : null;
    const last = runs.length ? runs[runs.length - 1] : null;
    const lastIdx = last ? his.indexOf(last) : -1;
    const n = mockItems(p).length;
    return `<div class="card mock-paper">
      <div class="row"><b>${esc(p.title)}</b><span class="pill g">${n} 题 · ${p.minutes} 分钟 · ${p.totalScore} 分</span></div>
      <p class="muted" style="font-size:13px;margin:6px 0 10px">${p.sections.map(s => s.label + ' ' + (s.to - s.from) + ' 题').join(' · ')}</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button class="btn" onclick="mockStartFresh('${p.id}')">开始模考</button>
        ${runs.length
          ? `<span class="pill g">已完成 ${runs.length} 次</span>
             <span class="muted" style="font-size:12.5px">最高得分 <b>${best}</b> 分 · 最近 ${last.score} 分（${last.date}）</span>
             ${lastIdx >= 0 ? `<button class="btn ghost" onclick="mockViewHis(${lastIdx})">📋 上次错题回看（${mockBadCount(last)} 题）</button>` : ''}`
          : '<span class="muted" style="font-size:12px">尚未开始</span>'}
      </div>
    </div>`;
  }).join('');
  const hisRows = his.slice().reverse().slice(0, 10).map((h, k) => {
    const idx = his.length - 1 - k;
    const badN = mockBadCount(h);
    return `<tr><td>${h.date}</td><td>${esc(h.title)}</td><td class="c">${h.score}/${h.total}</td><td class="c">${mockFmt(h.usedSec)}</td><td class="c">${h.right}对 / ${h.wrong}错 / ${h.blank}未答</td><td class="c" style="white-space:nowrap">${h.rows
      ? `<button class="btn ghost" style="padding:2px 8px;font-size:12px" onclick="mockViewHis(${idx})">回看（${badN}）</button>
         <button class="btn ghost" style="padding:2px 8px;font-size:12px" onclick="mockExportHis(${idx})">导出</button>`
      : '—'}</td></tr>`;
  }).join('');
  app.innerHTML = `<div class="card"><div class="row"><b>🧪 真题模考</b><a class="btn ghost" href="#/today" style="padding:4px 12px">返回今日</a></div>
    <p class="muted" style="font-size:13px">按真实考试规则计时与评分：单选 1 分；多选/案例 2 分，错选不得分、少选每项 0.5 分。交卷后错题自动进入错题库；模考不占用每日计划进度。</p></div>
    ${cards}
    ${his.length ? `<div class="card"><b>历史成绩</b><table class="mock-his"><thead><tr><th>日期</th><th>试卷</th><th>得分</th><th>用时</th><th>结果</th><th>明细</th></tr></thead><tbody>${hisRows}</tbody></table></div>` : ''}`;
}

/* ---------- 答题页 ---------- */
function renderMockExam(keepScroll) {
  const app = document.getElementById('app');
  const paper = mockPaper(mock.paperId);
  const items = mockItems(paper);
  if (!items.length) { app.innerHTML = '<div class="card empty">该试卷暂无题目</div>'; return; }
  const i = Math.min(mock.idx, items.length - 1);
  const it = items[i], q = it.q, sec = mockSec(paper, i);
  const rec = mock.answers[q.id] || { sel: [], marked: false };
  const multi = sec.type !== 'single';
  const opts = q.options.map((o, k) => {
    const on = rec.sel.indexOf(k) >= 0;
    return `<button class="mock-opt${on ? ' on' : ''}" onclick="mockPick(${k})">${esc(o)}</button>`;
  }).join('');
  const remain = mockRemain();
  const clockCls = remain <= 600 ? ' warn' : '';
  const answered = items.filter(x => (mock.answers[x.q.id] || {}).sel && (mock.answers[x.q.id] || {}).sel.length).length;
  const cardNums = items.map((x, k) => {
    const r = mock.answers[x.q.id] || {};
    const cls = (r.sel && r.sel.length ? ' done' : '') + (r.marked ? ' mark' : '') + (k === i ? ' cur' : '');
    return `<div class="mock-num${cls}" onclick="mockGo(${k})">${k + 1}</div>`;
  }).join('');
  const mat = caseMaterialInline(it.subject, it.chapterId, q.id);
  app.innerHTML = `<div class="card">
    <div class="row mock-head"><b>${esc(paper.title)}</b>
      <span class="mock-clock${clockCls}" id="mockClock">${mockFmt(remain)}</span>
      <span class="muted" style="font-size:12px">已答 ${answered}/${items.length}</span>
      <button class="btn ghost" style="padding:4px 10px;font-size:12px" onclick="mockToggleCard()">答题卡</button>
      <button class="btn" style="padding:4px 12px" onclick="mockSubmit(false)">交卷</button>
    </div>
    <div class="mock-sec">${sec.label}　第 ${i + 1} 题 / 共 ${items.length} 题　（本大题每题 ${sec.score} 分${multi ? '，少选按项给分' : ''}）</div>
    <div class="q">${mat}
      <div class="qtype"><span class="pill${multi ? ' a' : ''}">${multi ? '多选/不定项' : '单选'}</span>
        ${rec.marked ? '<span class="pill a">已标记</span>' : ''}</div>
      <div class="stem">${renderStem(q.stem)}</div>
      <div class="mock-opts">${opts}</div>
    </div>
    <div id="mockCardBox" style="display:none" class="mock-card">${cardNums}</div>
    <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <button class="btn ghost" ${i === 0 ? 'disabled' : ''} onclick="mockGo(${i - 1})">‹ 上一题</button>
      <button class="btn ghost" onclick="mockMark()">${rec.marked ? '取消标记' : '标记待定'}</button>
      <button class="btn ghost" ${i === items.length - 1 ? 'disabled' : ''} onclick="mockGo(${i + 1})">下一题 ›</button>
      <a class="btn ghost" style="margin-left:auto;padding:4px 10px;font-size:12px" href="javascript:void(0)" onclick="mockBackList()">退出</a>
    </div>
  </div>`;
  if (keepScroll) window.scrollTo(0, keepScroll);
  startMockTick();
}
function startMockTick() {
  stopMockTick();
  const tick = () => {
    const el = document.getElementById('mockClock');
    const r = mockRemain();
    if (el) { el.textContent = mockFmt(r); el.className = 'mock-clock' + (r <= 600 ? ' warn' : ''); }
    if (r <= 0) { stopMockTick(); if ((location.hash || '').indexOf('#/mock') === 0) { toast('考试时间到，自动交卷'); mockSubmit(true); } }
  };
  mockTick = setInterval(tick, 1000);
  tick();
}
window.mockPick = function (k) {
  const y = window.scrollY;
  const paper = mockPaper(mock.paperId);
  const items = mockItems(paper);
  const q = items[mock.idx].q, sec = mockSec(paper, mock.idx);
  const rec = mock.answers[q.id] || (mock.answers[q.id] = { sel: [], marked: false });
  if (sec.type === 'single') rec.sel = rec.sel.length === 1 && rec.sel[0] === k ? [] : [k];
  else {
    const p = rec.sel.indexOf(k);
    if (p >= 0) rec.sel.splice(p, 1); else rec.sel.push(k);
  }
  saveMockSession();
  renderMockExam(y);
};
window.mockGo = function (i) {
  const y = window.scrollY;
  const paper = mockPaper(mock.paperId);
  const n = mockItems(paper).length;
  mock.idx = Math.max(0, Math.min(n - 1, i));
  saveMockSession();
  renderMockExam(0);
};
window.mockMark = function () {
  const y = window.scrollY;
  const items = mockItems(mockPaper(mock.paperId));
  const q = items[mock.idx].q;
  const rec = mock.answers[q.id] || (mock.answers[q.id] = { sel: [], marked: false });
  rec.marked = !rec.marked;
  saveMockSession();
  renderMockExam(y);
};
/* 把一次作答压成逐题行：[题号, qid, 题型, 正确答案, 你的答案, 状态, 得分] */
function mockRowsOf(paper, items, r) {
  return items.map((it, i) => {
    const rec = mock.answers[it.q.id] || {};
    const st = r.detail[i] || {};
    const sec = mockSec(paper, i);
    const full = sec.type === 'auto' ? (it.q.type === 'multiple' ? 2 : 1) : sec.score;
    return [i + 1, it.q.id, sec.type === 'auto' ? it.q.type : sec.type,
            normAnswer(it.q.answer).join(''),
            (rec.sel || []).map(k => it.q.options[k][0]).join(''),
            st.state || 'blank',
            st.state === 'right' ? full : (st.state === 'part' ? (st.score || 0) : 0)];
  });
}
/* 由逐题行生成可读的错题清单文本（便于复制给 AI 复核） */
function mockWrongText(paper, rows) {
  const bad = rows.filter(r => r[5] !== 'right');
  const lines = [`【${paper.title}】错题回顾　共 ${bad.length} 题（错选/少选/未答）`];
  bad.forEach(r => {
    const state = r[5] === 'part' ? `少选（得 ${r[6]} 分）` : r[5] === 'blank' ? '未答' : '错选';
    lines.push(`${r[0]}. ${r[1]} [${r[2]}] 你：${r[4] || '—'}　正确：${r[3]}　${state}`);
  });
  return lines.join('\n');
}
/* 导出本次成绩明细：逐题记录 你的答案/正确答案/得分，便于事后复核 */
window.mockExportDetail = function () {
  if (!mock || !mock.submitted) { toast('还没有交卷的成绩'); return; }
  const paper = mockPaper(mock.paperId), items = mockItems(paper);
  const r = mockGrade(paper, items);
  const rows = mockRowsOf(paper, items, r).map(x => ({
    n: x[0], qid: x[1], type: x[2], correct: x[3], yours: x[4], state: x[5], score: x[6]
  }));
  const data = {
    exportedAt: new Date().toISOString(), paperId: paper.id, title: paper.title,
    total: paper.totalScore, score: r.score, right: r.right, wrong: r.wrong, part: r.part, blank: r.blank,
    usedSec: mock.usedSec || 0, rows
  };
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'mock-' + paper.id + '-' + localToday() + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  toast('成绩明细已导出');
};
/* 复制本次错题清单（纯文本，可直接发给我核对） */
window.mockCopyWrong = function () {
  if (!mock || !mock.submitted) { toast('还没有交卷的成绩'); return; }
  const paper = mockPaper(mock.paperId), items = mockItems(paper);
  const r = mockGrade(paper, items);
  const txt = mockWrongText(paper, mockRowsOf(paper, items, r));
  const done = () => toast('错题清单已复制');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(txt).then(done).catch(() => fallbackCopy(txt, done));
  } else fallbackCopy(txt, done);
};
function fallbackCopy(txt, done) {
  const ta = document.createElement('textarea');
  ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { alert(txt); }
  document.body.removeChild(ta);
}
/* 导出某次历史成绩明细（新记录才有 rows） */
window.mockExportHis = function (idx) {
  const h = mockHistory()[idx];
  if (!h || !h.rows) { toast('该次记录没有明细'); return; }
  const data = {
    exportedAt: new Date().toISOString(), paperId: h.paperId, title: h.title, date: h.date,
    total: h.total, score: h.score, right: h.right, wrong: h.wrong, blank: h.blank, usedSec: h.usedSec,
    rows: h.rows.map(x => ({ n: x[0], qid: x[1], type: x[2], correct: x[3], yours: x[4], state: x[5], score: x[6] }))
  };
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'mock-' + h.paperId + '-' + h.date + '-detail.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  toast('已导出该次明细');
};
window.mockToggleCard = function () {
  const box = document.getElementById('mockCardBox');
  if (box) box.style.display = box.style.display === 'none' ? 'grid' : 'none';
};

/* ---------- 评分 ---------- */
function mockGrade(paper, items) {
  let score = 0, right = 0, wrong = 0, blank = 0, part = 0;
  const detail = [];
  items.forEach((it, i) => {
    const sec = mockSec(paper, i);
    const secType = sec.type === 'auto' ? (it.q.type === 'multiple' ? 'multiple' : 'single') : sec.type;
    const secScore = sec.type === 'auto' ? (secType === 'single' ? 1 : 2) : sec.score;
    const ans = normAnswer(it.q.answer);
    const sel = ((mock.answers[it.q.id] || {}).sel) || [];
    if (!sel.length) { blank++; detail.push({ state: 'blank' }); return; }
    const picked = sel.map(k => it.q.options[k][0]);
    if (secType === 'single') {
      if (picked.length === 1 && picked[0] === ans[0]) { score += secScore; right++; detail.push({ state: 'right' }); }
      else { wrong++; detail.push({ state: 'wrong' }); }
    } else {
      const bad = picked.some(p => ans.indexOf(p) < 0);
      if (bad) { wrong++; detail.push({ state: 'wrong' }); }
      else if (picked.length === ans.length) { score += secScore; right++; detail.push({ state: 'right' }); }
      else { const s = Math.round(0.5 * picked.length * 10) / 10; score += s; part++; detail.push({ state: 'part', score: s }); }
    }
  });
  return { score: Math.round(score * 10) / 10, right, wrong, blank, part, detail };
}

window.mockSubmit = function (auto) {
  if (!mock || mock.submitted) return;
  const paper = mockPaper(mock.paperId);
  const items = mockItems(paper);
  if (!auto) {
    const un = items.filter(x => !((mock.answers[x.q.id] || {}).sel || []).length).length;
    if (un && !confirm('还有 ' + un + ' 题未作答，确定交卷？')) return;
  }
  stopMockTick();
  const res = mockGrade(paper, items);
  const used = Math.min(paper.minutes * 60, Math.floor((Date.now() - mock.startedAt) / 1000));
  mock.submitted = true; mock.result = res; mock.usedSec = used;
  saveMockSession();
  const h = mockHistory();
  h.push({
    paperId: paper.id, title: paper.title, date: localToday(), score: res.score, total: paper.totalScore,
    usedSec: used, right: res.right, wrong: res.wrong, part: res.part, blank: res.blank,
    ts: Date.now(),                        // 跨设备合并时用于稳定排序
    rows: mockRowsOf(paper, items, res)   // 逐题明细：题号/qid/题型/正确答案/你的答案/状态/得分
  });
  mockSaveHistory(h);
  scheduleSync();   // 2026-10-25：交卷后自动把模考记录带上云端（auto 开启时才生效）
  // 错题入库（错选 / 少选 / 未答）
  items.forEach((it, i) => {
    const st = res.detail[i].state;
    if (st === 'right' || st === 'blank') return;   // 未答不入错题库（可在成绩页回看、重考）
    const sel = (((mock.answers[it.q.id] || {}).sel) || []).map(k => it.q.options[k][0]).join('');
    addWrong({
      qid: it.q.id, subject: it.subject, chapterId: it.chapterId, chapterTitle: it.chapterTitle,
      stem: it.q.stem, options: it.q.options, type: it.q.type, explanation: it.q.explanation,
      answer: normAnswer(it.q.answer).join(''), yourWrong: sel
    });
  });
  renderMockResult();
};

/* ---------- 成绩页 ---------- */
window.mockShowAll = function () {
  mock._showAll = !mock._showAll;
  saveMockSession();
  renderMockResult();
};
function renderMockResult() {
  const app = document.getElementById('app');
  const paper = mockPaper(mock.paperId);
  const items = mockItems(paper);
  const stored = mock.result || null;
  const r = mockGrade(paper, items);           // 按当前题库重算（题库若有订正会影响结果）
  const pct = Math.round(r.score / paper.totalScore * 100);
  const drift = stored && Math.abs(stored.score - r.score) > 0.05
    ? `<p class="muted" style="font-size:12px;margin-top:6px;color:#b45309">交卷时记录 ${stored.score} 分，按当前题库重算为 ${r.score} 分（期间题库有订正，以重算为准）</p>`
    : '';
  const secRows = paper.sections.map(s => {
    let got = 0, cnt = 0, full = 0;
    for (let i = s.from; i < Math.min(s.to, items.length); i++) {
      cnt++;
      const sc = s.type === 'auto' ? (items[i].q.type === 'multiple' ? 2 : 1) : s.score;
      full += sc;
      const st = r.detail[i] || {};
      if (st.state === 'right') got += sc; else if (st.state === 'part') got += st.score || 0;
    }
    return `<tr><td>${s.label}</td><td class="c">${cnt} 题</td><td class="c">${Math.round(got * 10) / 10} / ${full}</td></tr>`;
  }).join('');
  const showAll = !!mock._showAll;
  // 本次错题回顾：错选/少选/未答逐题列出（含得分与解析），并可一键复制/导出
  const badList = items.map((it, i) => ({ it, i, st: r.detail[i] || {} }))
    .filter(x => x.st.state && x.st.state !== 'right');
  const reviewCard = `<div class="card">
    <div class="row"><b>📌 本次错题回顾</b><span class="pill ${badList.length ? 'a' : 'g'}">${badList.length} 题</span></div>
    <p class="muted" style="font-size:12.5px;margin:6px 0 10px">范围＝本套卷的错选 / 少选 / 未答；每题标注你选的、正确的、拿到的分数。核对结果时把这份清单发我即可。</p>
    ${badList.length ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
      <button class="btn" onclick="mockCopyWrong()">📋 复制错题清单</button>
      <button class="btn ghost" onclick="mockExportDetail()">⬇ 导出明细（JSON）</button>
    </div>
    <div class="mock-rev-list">${badList.map(x => {
      const it = x.it, st = x.st;
      const your = ((mock.answers[it.q.id] || {}).sel || []).map(k => it.q.options[k][0]).join('') || '未答';
      const ans = normAnswer(it.q.answer).join('');
      const sec = mockSec(paper, x.i);
      const full = sec.type === 'auto' ? (it.q.type === 'multiple' ? 2 : 1) : sec.score;
      const got = st.state === 'part' ? (st.score || 0) : 0;
      const tag = st.state === 'part' ? `<span class="pill a">少选 ${got}/${full}</span>`
        : st.state === 'blank' ? '<span class="pill">未答 0 分</span>'
        : `<span class="pill" style="background:#ffe3e3;color:#c92a2a">错选 0/${full}</span>`;
      return `<div class="mock-rev">
        <div class="row"><b>${x.i + 1}.</b> ${tag}<span class="muted" style="font-size:12px">${it.q.id} · 你：${esc(your)}　正确：${esc(ans)}</span></div>
        <div class="stem" style="margin-top:4px">${renderStem(it.q.stem)}</div>
        <div class="mock-exp">${esc(it.q.explanation || '（暂无解析）')}</div>
      </div>`;
    }).join('')}` : '<p class="muted">本套全对，没有错题。</p>'}
  </div>`;
  const rows = items.map((it, i) => {
    const st = r.detail[i] || {};
    if (!showAll && st.state === 'right') return '';
    const rec = mock.answers[it.q.id] || {};
    const your = (rec.sel || []).map(k => it.q.options[k][0]).join('') || '未答';
    const ans = normAnswer(it.q.answer).join('');
    const badge = st.state === 'right' ? '<span class="pill g">正确</span>'
      : st.state === 'part' ? `<span class="pill a">少选 ${st.score} 分</span>`
      : st.state === 'blank' ? '<span class="pill">未答</span>' : '<span class="pill" style="background:#ffe3e3;color:#c92a2a">错误</span>';
    return `<div class="mock-rev">
      <div class="row"><b>${i + 1}.</b> ${badge}<span class="muted" style="font-size:12px">你：${esc(your)}　正确：${esc(ans)}</span></div>
      <div class="stem" style="margin-top:4px">${renderStem(it.q.stem)}</div>
      ${(it.q.options || []).map(o => `<div class="mock-ropt${normAnswer(it.q.answer).indexOf(o[0]) >= 0 ? ' ok' : ''}">${esc(o)}</div>`).join('')}
      <div class="mock-exp">${esc(it.q.explanation || '')}</div>
    </div>`;
  }).join('');
  app.innerHTML = `<div class="card">
    <div class="row"><b>${esc(paper.title)} · 成绩</b><span class="pill ${r.score >= paper.totalScore * 0.6 ? 'g' : 'a'}">${pct}%</span></div>
    <div class="mock-res">
      <div><span class="muted">总分</span><b>${r.score}</b><span class="muted">/ ${paper.totalScore}</span></div>
      <div><span class="muted">对</span><b>${r.right}</b></div>
      <div><span class="muted">错</span><b>${r.wrong}</b></div>
      <div><span class="muted">少选</span><b>${r.part}</b></div>
      <div><span class="muted">未答</span><b>${r.blank}</b></div>
      <div><span class="muted">用时</span><b>${mockFmt(mock.usedSec || 0)}</b></div>
    </div>
    <table class="mock-his" style="margin-top:12px"><thead><tr><th>题型</th><th>题量</th><th>得分</th></tr></thead><tbody>${secRows}</tbody></table>
    ${drift}
    <p class="muted" style="font-size:12px;margin-top:10px">错选与少选的题已自动加入错题库（未答不计入，可在下方回看）；模考记录不影响每日进度。</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
      <button class="btn" onclick="mockStartFresh('${paper.id}')">再考一次</button>
      <button class="btn ghost" onclick="mockBackList()">返回模考列表</button>
      <button class="btn ghost" onclick="mockShowAll()">${showAll ? '只看错题' : '显示全部题目'}</button>
      <button class="btn ghost" onclick="mockExportDetail()">⬇ 导出成绩明细</button>
      <a class="btn ghost" href="#/wrong">去错题库</a>
    </div>
  </div>
  ${reviewCard}
  <div class="card"><b>逐题解析${showAll ? '（全部）' : '（仅错题/少选/未答）'}</b>${rows || '<p class="muted">全对，没有需要复盘的题目。</p>'}</div>`;
}

/* ---------- 历史场次逐题回看（交卷后返回列表仍可随时打开） ---------- */
let mockHisAll = false;
window.mockViewHis = function (idx) {
  mockHisAll = false;
  const want = '#/mock?h=' + idx;
  if (location.hash === want) renderMock(); else location.hash = want;
};
window.mockHisToggleAll = function () { mockHisAll = !mockHisAll; renderMock(); };
window.mockCopyHis = function (idx) {
  const h = mockHistory()[idx];
  if (!h || !h.rows) { toast('该次记录没有明细'); return; }
  const txt = mockWrongText({ title: h.title + '（' + h.date + '）' }, h.rows);
  const done = () => toast('错题清单已复制');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(txt).then(done).catch(() => fallbackCopy(txt, done));
  } else fallbackCopy(txt, done);
};
function renderMockHis(idx) {
  const app = document.getElementById('app');
  const his = mockHistory();
  const h = his[idx];
  if (!h) {
    app.innerHTML = `<div class="card"><b>该次记录已不存在</b>
      <p class="muted">历史记录最多保留最近 50 次，可能已被清理。</p>
      <a class="btn" href="#/mock?list=1">← 返回模考列表</a></div>`;
    return;
  }
  const rows = h.rows || [];
  const ix = bankIdx();
  const part = h.part == null ? rows.filter(r => r[5] === 'part').length : h.part;
  const bad = rows.filter(r => r[5] !== 'right');
  const list = mockHisAll ? rows : bad;
  const tag = r => r[5] === 'part' ? `<span class="pill a">少选 ${r[6]} 分</span>`
    : r[5] === 'blank' ? '<span class="pill">未答 0 分</span>'
    : r[5] === 'right' ? `<span class="pill g">正确 ${r[6]} 分</span>`
    : '<span class="pill" style="background:#ffe3e3;color:#c92a2a">错选 0 分</span>';
  const body = list.map(r => {
    const rec = ix[r[1]];
    const q = rec ? rec.q : null;
    const ans = normAnswer(r[3]);
    const stem = q ? renderStem(q.stem) : '<span class="muted">（该题已不在题库中）</span>';
    const opts = q ? (q.options || []).map(o =>
      `<div class="mock-ropt${ans.indexOf(o[0]) >= 0 ? ' ok' : ''}">${esc(o)}</div>`).join('') : '';
    const exp = q ? esc(q.explanation || '（暂无解析）') : '';
    const mat = q && !/^案例\s*[（(]/.test((q.stem || '').trim())
      ? caseMaterialInline(rec.subject, rec.chapterId, q.id) : '';
    return `<div class="mock-rev">
      <div class="row"><b>${r[0]}.</b> ${tag(r)}<span class="muted" style="font-size:12px">${r[1]} · 你：${esc(r[4] || '—')}　正确：${esc(r[3])}</span></div>
      ${mat}
      <div class="stem" style="margin-top:4px">${stem}</div>
      ${opts}
      <div class="mock-exp">${exp}</div>
    </div>`;
  }).join('');
  const pct = Math.round(h.score / h.total * 100);
  app.innerHTML = `<div class="card">
    <div class="row"><b>${esc(h.title)}</b><span class="pill ${h.score >= h.total * 0.6 ? 'g' : 'a'}">${pct}%</span></div>
    <p class="muted" style="font-size:12.5px;margin:4px 0 0">${h.date} 那场 · 历史记录回看</p>
    <div class="mock-res">
      <div><span class="muted">得分</span><b>${h.score}</b><span class="muted">/ ${h.total}</span></div>
      <div><span class="muted">对</span><b>${h.right}</b></div>
      <div><span class="muted">错</span><b>${h.wrong}</b></div>
      <div><span class="muted">少选</span><b>${part}</b></div>
      <div><span class="muted">未答</span><b>${h.blank || 0}</b></div>
      <div><span class="muted">用时</span><b>${mockFmt(h.usedSec || 0)}</b></div>
    </div>
    <p class="muted" style="font-size:12px;margin-top:10px">答案与解析按<b>当前题库</b>显示（若期间有订正，可能与你当时看到的不同）。需要复核时把清单复制给我即可。</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
      <a class="btn ghost" href="#/mock?list=1">← 返回模考列表</a>
      <button class="btn ghost" onclick="mockHisToggleAll()">${mockHisAll ? '只看错题' : '显示全部题目'}</button>
      ${rows.length ? `<button class="btn" onclick="mockCopyHis(${idx})">📋 复制错题清单</button>
        <button class="btn ghost" onclick="mockExportHis(${idx})">⬇ 导出该次明细</button>` : ''}
    </div>
  </div>
  <div class="card"><div class="row"><b>${mockHisAll ? '逐题解析（全部）' : '错题回顾'}</b>
      <span class="pill ${bad.length ? 'a' : 'g'}">${bad.length} 题</span></div>
    ${rows.length
      ? (body || '<p class="muted">该次没有错题。</p>')
      : '<p class="muted">这次记录没有保存逐题明细（可能是较早版本导出的记录）。</p>'}
  </div>`;
}

function router() {
  const raw = (location.hash || '#/today').replace('#/', '');
  const _parts = raw.split('?');
  const route = _parts[0];
  const _q = {};
  if (_parts[1]) _parts[1].split('&').forEach(p => { const kv = p.split('='); if (kv[0]) _q[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || ''); });
  window._q = _q;
  if (route !== 'mock') stopMockTick();
  document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('active', a.dataset.route === route));
  if (route === 'wrong') renderWrong();
  else if (route === 'notes') renderNotes();
  else if (route === 'plan') renderPlan();
  else if (route === 'progress') renderProgress();
  else if (route === 'settings') renderSettings();
  else if (route === 'drill') renderDrill();
  else if (route === 'mock') renderMock();
  else renderToday();
}
window.addEventListener('hashchange', router);
/* 强制导航：当目标 hash 与当前相同（如刷题期间地址栏一直是 #/today）时，
   直接调用 router 重渲染，避免"返回当日"点击无效。 */
function nav(route) {
  const h = '#/' + route;
  if (location.hash === h) router();
  else location.hash = h;
}
window.nav = nav;

/* ---------------- 视图：今日任务 ---------------- */
function renderToday() {
  /* 入口条：专项强化 · 真题模考 · 2026 新增考点（b23，2026-10-25 重建后重新放回入口） */
  const b23ch = findChapter('business', 'b23');
  const b23n = (b23ch && b23ch.questions) ? b23ch.questions.length : 0;
  const b23Btn = b23n
    ? `<button class="btn ghost" onclick="startQuiz('business','b23')" title="第6章质量管理与安全生产 + ESG/数字化战略 + 创新新模式 + 治理重写">🆕 新增考点（${b23n}）</button>`
    : '';
  const drillEntry = `<div class="card review" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><a class="btn" href="#/drill">🎯 专项强化</a><a class="btn ghost" href="#/mock">🧪 真题模考</a>${b23Btn}<span class="muted" style="font-size:12px">曲线图鉴 · 计算专练 · 整卷模考 · 2026 新增考点</span></div>`;
  validateSession(false);   // 进今日页先净化孤儿会话，避免「未完成答题」横幅误报
  const t = todaysChapters();
  let banner;
  if (t.notStarted) banner = `<div class="banner">📅 计划还未开始，距开始还有 ${-t.days} 天（${DATA.plan.startDate}）。</div>`;
  else if (t.finished) banner = `<div class="banner">🎉 计划已全部完成！可进入自由复习 / 错题清零模式。</div>`;
  else {
    const left = daysBetween(localToday(), DATA.plan.examDate);
    banner = `<div class="banner">📅 ${t.day.date}　|　${esc(t.day.focus || '今日任务')}　|　距考试 ${left} 天</div>`;
  }
  const resume = (state.session && state.session.active) ? (() => {
    const remain = Math.max(0, state.session.items.length - state.session.idx);
    return `<div class="card review"><span class="pill a">未完成答题</span>
      <p>检测到上次答题「${esc(state.session.title)}」尚未完成，剩余 <b>${remain}</b> 题。</p>
      <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn" onclick="resumeQuiz()">🔁 继续答题</button>
        <button class="btn ghost" onclick="discardSession()">放弃并重来</button>
      </div></div>`;
  })() : '';
  const dueList = state.wrong.filter(isDue);
  const reviewCard = dueList.length
    ? `<div class="card review"><span class="pill a">错题复习</span>
        <p>艾宾浩斯记忆曲线：今日有 <b>${dueList.length}</b> 道错题到复习时间，建议优先清空。</p>
        <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn" onclick="startWrongDue()">📌 复习待做（${dueList.length}）</button>
          <a class="btn ghost" href="#/wrong">去错题库</a>
        </div></div>`
    : `<div class="card review"><span class="pill g">错题复习</span><p class="muted">今日暂无到期错题，继续保持！错题库共 ${state.wrong.length} 题长期保存中。</p></div>`;
  /* 2026变动考点专练已完成（b23 9/15、e50 9/14），入口撤下（2026-09-20）；
     章节 b23/e50 保留在题库中，其错题照常走错题库复习 */
  if (t.notStarted || t.finished) {
    app.innerHTML = banner + resume + drillEntry + reviewCard;
  } else {
    app.innerHTML = banner + resume + chapterCard('economy', t.economy, '经济基础') + chapterCard('business', t.business, '工商管理') + drillEntry + reviewCard;
  }
}
/* 今日某科是否已完成：dayDone 优先，兜底为 progress.done 中任一带今天日期的 {科}:* 完成
   （兼容"导入旧备份但缺 dayDone"以及"按旧计划做了不同章"的情况，使今日页正确显示已完成） */
function subjectDoneToday(subject) {
  const td = localToday();
  return dayDoneAt(subject, null, td);
}
/* 某计划日期某科是否已完成（供计划页使用）：
   dayDone[日期][科] 优先；兜底匹配 progress.done 中以 "科:当天章" 开头的键
   （兼容 #题段切片 后缀，如 economy:e38#0-40，以及旧版无切片键 economy:e39），
   且完成日期 == 该计划日期。 */
function dayDoneAt(subject, chapterId, date) {
  const dd = state.progress.dayDone || {};
  if (dd[date] && dd[date][subject]) return true;
  const done = state.progress.done || {};
  const prefix = subject + ':' + (chapterId || '');
  for (const k in done) {
    // chapterId 为空 → 匹配该科任意章（subjectDoneToday 用）；否则要求以 "科:章" 精确匹配或后接 #切片
    const hit = chapterId == null
      ? k.indexOf(prefix) === 0
      : (k === prefix || (k.indexOf(prefix) === 0 && k[prefix.length] === '#'));
    if (hit && done[k] === date) return true;
  }
  return false;
}
function chapterCard(subject, ch, label) {
  if (!ch) return `<div class="card"><span class="pill">${label}</span> <b>本章计划已学完 ✅</b><p class="muted">后续进入强化/模考阶段。</p></div>`;
  const noteTxt = (ch._note && DATA.notes[ch._note]) ? DATA.notes[ch._note] : (DATA.notes[ch.id] ? DATA.notes[ch.id] : '');
  const note = noteTxt ? `<div class="note">${esc(noteTxt)}</div>` : '';
  const cnt = (ch._to != null) ? (ch._to - ch._from) : (ch.questions ? ch.questions.length : 0);
  const hasQ = ch.questions && ch.questions.length;
  const done = subjectDoneToday(subject);
  let btn;
  if (done) {
    btn = `<span class="pill g">✅ 今日已完成</span> <button class="btn ghost" onclick="startQuiz('${subject}','${ch.id}',${ch._from != null ? ch._from : 'null'},${ch._to != null ? ch._to : 'null'})">重做本段</button>`;
  } else if (hasQ) {
    const df = (ch._from != null) ? ` data-from="${ch._from}"` : '';
    const dt = (ch._to != null) ? ` data-to="${ch._to}"` : '';
    btn = `<a class="btn" href="#/quiz" data-sub="${subject}" data-ch="${ch.id}"${df}${dt}>开始刷题（${cnt}题）</a>`;
  } else {
    btn = `<span class="muted">本章题库待补充，可先看笔记。</span>`;
  }
  const ncid = todayNoteChapter(subject);
  const noteRead = ncid && isNoteRead(subject, ncid);
  const noteBtn = `<a class="btn ghost" href="#/notes?date=${localToday()}" title="看今日教材笔记">📒 看笔记${noteRead ? '✓' : ''}</a>`;
  return `<div class="card">
    <span class="pill ${subject === 'business' ? 'g' : ''}">${label}</span>
    <h3>${esc(ch.title)}</h3>
    ${note}
    <div style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap">${btn} ${noteBtn}</div>
  </div>`;
}

/* ---------------- 视图：刷题 ---------------- */
function startQuiz(subject, chapterId, from, to) {
  const ch = findChapter(subject, chapterId);
  if (!ch || !ch.questions || !ch.questions.length) { toast('本章暂无题目'); return; }
  const f = (from == null) ? 0 : +from;
  const total = ch.questions.length;
  const t = (to == null) ? total : +to;
  const qs = ch.questions.slice(f, t);
  if (!qs.length) { toast('该段暂无题目'); return; }
  const queue = qs.map(q => ({ q: applyCorrections(q), subject, chapterId, chapterTitle: ch.title }));
  const isSlice = (from != null) || (to != null);
  const title = ch.title + `（第${f + 1}-${f + qs.length}题）`;
  const doneKeys = [subject + ':' + chapterId + (isSlice ? ('#' + f + '-' + t) : '')];
  beginQuiz(queue, title, false, doneKeys, isSlice ? true : (t >= total));
}
function startAll() {
  const t = todaysChapters();
  if (t.notStarted || t.finished) { toast('今日无计划'); return; }
  const items = [];
  [['economy', t.economy], ['business', t.business]].forEach(([s, ch]) => { if (ch && ch.questions) ch.questions.forEach(q => items.push({ s, ch, q })); });
  if (!items.length) { toast('今日暂无题目'); return; }
  const queue = items.map(it => ({ q: applyCorrections(it.q), subject: it.s, chapterId: it.ch.id, chapterTitle: it.ch.title }));
  const doneKeys = [];
  if (t.economy) doneKeys.push('economy:' + t.economy.id + '#' + t.economy._from + '-' + t.economy._to);
  if (t.business) doneKeys.push('business:' + t.business.id + '#' + t.business._from + '-' + t.business._to);
  beginQuiz(queue, '今日全部', false, doneKeys, true);
}
/* ---------------- 题型工具 ----------------
   历史数据里多选写法有 multiple / multi 两种（2026-08-01 已归一化为 multiple），
   这里仍用白名单兜底，避免任何一处判定漏掉某种写法导致多选被当单选渲染。 */
const MULTI_TYPES = new Set(['multiple', 'multi', 'case', '多选']);
function isMulti(t) { return MULTI_TYPES.has(String(t == null ? '' : t).trim().toLowerCase()); }
function typeBadge(t) {
  return isMulti(t)
    ? `<span class="tbadge multi">多选题 · 至少 2 项 · 错选不得分</span>`
    : `<span class="tbadge single">单选题</span>`;
}
function submitLabel(t, n, base) {
  base = base || '提交答案';
  if (!isMulti(t) || n === 0) return base;
  return n === 1 ? `${base}（仅选 1 项 ⚠️）` : `${base}（已选 ${n} 项）`;
}
function optHtml(options, t) {
  const cls = isMulti(t) ? 'opt multi' : 'opt';
  return options.map((o, i) => `<button class="${cls}" data-i="${i}">${esc(o)}</button>`).join('');
}
/* 判分（2026-08-14 升级，考试口径）：单选=全对；多选=每题 2 分、错选 0 分、少选每对项 0.5 分，
   「得分≥50% 即判正确」⇔ 无错选 且 选对 ≥2 项。selLetters 为作答字母数组（如 ["A","C"]）。 */
function multiPass(q, selLetters) {
  const ans = normAnswer(q.answer);
  if (!ans.length || !selLetters || !selLetters.length) return false;
  if (!isMulti(q.type)) return selLetters.slice().sort().join('') === ans.slice().sort().join('');
  if (selLetters.some(l => !ans.includes(l))) return false;   // 错选 → 0 分
  return selLetters.length >= 2;                               // 无错选且选对≥2 → ≥50%
}
/* 存量多选错题重判：错题快照存了 yourWrong（进错题库那次的作答字母），用新规则重判；
   应判对（得分≥50%）→ 移出错题库；缺作答记录的维持现状。幂等。返回恢复数量。 */
function auditWrongMulti(silent) {
  if (!state.wrong || !state.wrong.length) return 0;
  let restored = 0;
  const kept = [];
  for (const w of state.wrong) {
    if (isMulti(w.type) && w.yourWrong) {
      const letters = String(w.yourWrong).split(/[、，,]/).map(s => s.trim().toUpperCase()).filter(Boolean);
      const q = findQById(w.qid);
      if (letters.length && q && multiPass(q, letters)) { restored++; continue; }
    }
    kept.push(w);
  }
  if (restored) {
    state.wrong = kept;
    saveWrong();
    if (!silent) toast(`按新规则（多选≥50%）恢复 ${restored} 道错题`);
  }
  return restored;
}
/* 订正后冤案自动恢复：错题快照存的 yourWrong（进错题库那次的作答）若等于「当前生效答案」
   （题库 + patches + 本机订正应用后），说明该题答案后来被订正成用户当初的选择、
   当时按旧答案被判错是"冤判" → 自动移出错题库。单选/多选通用，幂等。 */
function auditWrongByCorrection(silent) {
  if (!state.wrong || !state.wrong.length) return 0;
  let restored = 0;
  const kept = [];
  for (const w of state.wrong) {
    if (!w.yourWrong) { kept.push(w); continue; }
    const q = findQById(w.qid);
    if (!q) { kept.push(w); continue; }
    const effAns = normAnswer(applyCorrections(q).answer).slice().sort();
    const yourAns = normAnswer(String(w.yourWrong)).slice().sort();
    if (effAns.length && JSON.stringify(effAns) === JSON.stringify(yourAns)) { restored++; continue; }
    kept.push(w);
  }
  if (restored) {
    state.wrong = kept;
    saveWrong();
    if (!silent) toast(`按订正恢复 ${restored} 道错题（你的作答即订正后答案）`);
  }
  return restored;
}

/* 案例材料内嵌直显（2026-09-08）：当前题属于某案例组时，直接在题干上方展示材料全文，
   不再跳转回材料题。材料题自身（题干已含材料）不重复显示。 */
function caseMaterialInline(subject, chapterId, qid) {
  const m = findCaseMaterial(subject, chapterId, qid);
  if (!m || /材料缺失/.test(m.stem || '')) return '';
  const num = ((m.stem || '').match(/案例\s*[（(]?\s*([一二三四五六七八九十\d]+)/) || [])[1] || '';
  return `<div class="case-mat-inline"><div class="cm-title">📄 案例材料${num ? '（案例' + num + '）' : ''}</div><div class="cm-body">${renderStem(m.stem)}</div></div>`;
}
function renderQuiz() {
  if (quiz.idx >= quiz.queue.length) { renderQuizSummary(); return; }
  if (!quiz._answers) quiz._answers = {};
  sel = new Set();
  const { q } = quiz.queue[quiz.idx];
  const opts = optHtml(q.options, q.type);
  const corrBadge = q._corrected ? `<span class="pill a">⚠️AI修正答案</span>` : '';
  // 回看：该题已提交过 → 恢复选项选中态与判分展示
  const rec = quiz._answers && quiz._answers[q.id];
  const answered = !!(rec && rec.submitted);
  const submitBtnHtml = answered
    ? '<span class="pill g" style="margin-right:6px">✅ 已提交</span>'
    : '<button class="btn g" id="submitBtn" disabled>提交答案</button>';
  // 案例材料内嵌直显（2026-09-08）：当前题属于某案例组 → 题干上方直接展示材料全文，不再跳转。
  // 材料题自身（题干已含材料）不重复显示。已提交回看时同样显示，方便复盘。
  const item = quiz.queue[quiz.idx];
  const caseMat = caseMaterialInline(item.subject, item.chapterId, q.id);
  app.innerHTML = `<div class="card">
    <div class="row"><span class="muted">${esc(quiz.title)}</span><span class="muted">${subjectPill(subOf(quiz.queue[quiz.idx]))} ${quiz.idx + 1}/${quiz.queue.length}</span></div>
    <div class="q">${caseMat}<div class="qtype">${typeBadge(q.type)}${corrBadge}</div><div class="stem">${renderStem(q.stem)}</div>${opts}
      ${submitBtnHtml}
      <div class="explain" id="explain"></div>
      <div id="aiBox" style="margin-top:10px"></div>
    </div>
    <div id="nav" style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <button class="btn ghost" id="prevBtn" ${quiz.idx > 0 ? '' : 'disabled'}>‹ 上一题</button>
      <button class="btn ghost" id="nextBtn">下一题 ›</button>
      ${quiz.fromWrong ? `<button class="btn" style="color:var(--red)" onclick="delWrongInQuiz('${q.id}')">🗑 删除此题</button>` : ''}
      <span class="muted" style="margin-left:auto;font-size:12px">可直接跳转；已提交的题可回看，未提交的回头再答</span>
    </div>
  </div>`;
  document.getElementById('prevBtn').onclick = () => quizGo(quiz.idx - 1);
  document.getElementById('nextBtn').onclick = () => quizGo(quiz.idx + 1);
  app.querySelectorAll('.opt').forEach(b => b.onclick = () => onPick(b, q));
  const sb = document.getElementById('submitBtn');
  if (sb) sb.onclick = () => onSubmit(q);
  // 已提交的题：回看时展示原选项与判分结果
  if (answered && rec) {
    sel = new Set(rec.sel || []);
    const ex = document.getElementById('explain');
    app.querySelectorAll('.opt').forEach((b, i) => {
      const letter = q.options[i][0];
      if (q.answer.includes(letter)) b.classList.add('correct');
      else if ((rec.sel || []).includes(i)) b.classList.add('wrong');
      else b.classList.add('dim');
      b.disabled = true;
    });
    ex.innerHTML = `<b>答案：</b>${normAnswer(q.answer).join('、')}　|　<b>解析：</b>${esc(q.explanation)}`;
    ex.classList.add('show');
    const ab = document.getElementById('aiBox');
    if (ab) ab.innerHTML = `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px">
        <button class="btn ghost" onclick="aiExplainBtn('${q.id}')">🤖 AI 精讲</button>
        <button class="btn ghost" onclick="aiSimilarBtn('${q.id}')">🎯 举一反三</button>
      </div><div id="aiResult"></div>`;
  }
}
function quizGo(i) {
  if (i < 0 || i >= quiz.queue.length) return;
  quiz.idx = i;
  if (state.session) { state.session.idx = i; saveSession(); }
  renderQuiz();
}
window.quizGo = quizGo;
function onPick(b, q) {
  if (document.getElementById('explain').classList.contains('show')) return;
  const submitBtn = document.getElementById('submitBtn');
  if (!isMulti(q.type)) {
    app.querySelectorAll('.opt').forEach(x => x.classList.remove('sel'));
    b.classList.add('sel'); sel = new Set([+b.dataset.i]); submitBtn.disabled = false;
  } else {
    b.classList.toggle('sel');
    if (b.classList.contains('sel')) sel.add(+b.dataset.i); else sel.delete(+b.dataset.i);
    submitBtn.disabled = sel.size === 0;
  }
  submitBtn.textContent = submitLabel(q.type, sel.size);
}
function onSubmit(q) {
  const correct = multiPass(q, [...sel].map(i => q.options[i][0]));
  const explain = document.getElementById('explain');
  app.querySelectorAll('.opt').forEach((b, i) => {
    const letter = q.options[i][0];
    if (q.answer.includes(letter)) b.classList.add('correct');
    else if (sel.has(i)) b.classList.add('wrong');
    else b.classList.add('dim');
    b.disabled = true;
  });
  explain.innerHTML = `<b>答案：</b>${normAnswer(q.answer).join('、')}　|　<b>解析：</b>${esc(q.explanation)}${correct && isMulti(q.type) && sel.size < normAnswer(q.answer).length ? '　<span style="color:var(--amber-d)">✅ 得分≥50%（少选），建议回看补全其余正确项</span>' : ''}`;
  explain.classList.add('show');
  document.getElementById('submitBtn').style.display = 'none';
  const item = quiz.queue[quiz.idx];
  if (quiz.fromWrong) {
    const w = state.wrong.find(x => x.qid === q.id);
    if (w) gradeWrong(w, correct);
  } else {
    if (correct) quiz.correct++;
    else {
      quiz.wrong++;
      addWrong({ qid: q.id, subject: item.subject, chapterId: item.chapterId, chapterTitle: item.chapterTitle, stem: q.stem, options: q.options, type: q.type, explanation: q.explanation, answer: normAnswer(q.answer).join('、'), yourWrong: [...sel].map(i => q.options[i][0]).join('、') });
    }
  }
  if (state.session) { state.session.correct = quiz.correct; state.session.wrong = quiz.wrong; saveSession(); }
  // 记录本题作答（供上一题回看）
  quiz._answers = quiz._answers || {};
  quiz._answers[q.id] = { sel: [...sel], submitted: true, correct };
  if (state.session) { state.session.answers = quiz._answers; saveSession(); }
  document.getElementById('nav').innerHTML = `<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
    <button class="btn ghost" onclick="quizGo(${quiz.idx - 1})" ${quiz.idx > 0 ? '' : 'disabled'}>‹ 上一题</button>
    <button class="btn" onclick="quizNext()">${quiz.idx + 1 < quiz.queue.length ? '下一题 →' : '查看结果'}</button>
  </div>`;
  const ab = document.getElementById('aiBox');
  if (ab) ab.innerHTML = `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px">
      <button class="btn ghost" onclick="aiExplainBtn('${q.id}')">🤖 AI 精讲</button>
      <button class="btn ghost" onclick="aiSimilarBtn('${q.id}')">🎯 举一反三</button>
    </div><div id="aiResult"></div>`;
}
function quizNext() {
  quiz.idx++;
  if (state.session) { state.session.idx = quiz.idx; saveSession(); }
  renderQuiz();
}
window.quizNext = quizNext;
function renderQuizSummary() {
  if (state.session) { state.session = null; saveSession(); }
  if (quiz._doneKeys && quiz._marksDoneWhenComplete) {
    quiz._doneKeys.forEach(k => markStudy(k));
    // 按题段记录当日完成态（供今日页显示"已完成"）
    const td = localToday();
    state.progress.dayDone = state.progress.dayDone || {};
    state.progress.dayDone[td] = state.progress.dayDone[td] || {};
    quiz._doneKeys.forEach(k => { const sub = k.split(':')[0]; state.progress.dayDone[td][sub] = true; });
    saveProgress();
  }
  const isWrong = quiz.fromWrong;
  app.innerHTML = `<div class="card"><h2>本轮完成 🎉</h2>
    <div class="stat">
      <div class="box"><b>${quiz.queue.length}</b>总题数</div>
      <div class="box"><b style="color:var(--green-d)">${quiz.correct}</b>答对</div>
      <div class="box"><b style="color:var(--red)">${quiz.wrong}</b>答错</div>
    </div>
    <p class="muted">${isWrong ? '已按记忆曲线更新每题的复习排程；答错的题已重置到近日重练，全部留在错题库长期保存。' : '答错的题已自动进入错题库，将按记忆曲线提醒你复习。'}</p>
    <button class="btn" onclick="nav('${isWrong ? 'wrong' : 'today'}')">${isWrong ? '返回错题库' : '去错题库复习'}</button> <button class="btn ghost" onclick="nav('today')">返回今日</button>
  </div>`;
}

/* ---------------- 视图：错题库 ---------------- */
function renderWrong() {
  auditWrongMulti(true);   // 进错题库再审计一次（幂等，静默；恢复后继续用新列表渲染）
  auditWrongByCorrection(true);   // 订正后冤案同样静默审计
  if (!state.wrong.length) { app.innerHTML = `<div class="card empty">🎉 暂无错题，继续保持！</div>`; return; }
  const dueList = state.wrong.filter(isDue);
  const unCount = state.wrong.filter(isUnanswerable).length;
  const cntStub = state.wrong.filter(w => (w.count || 1) >= 3).length;
  const cntHard = state.wrong.filter(w => (w.count || 1) >= 3 && (w.box || 0) === 0).length;
  const retSet = retiredQids();
  const retCnt = state.wrong.filter(w => retSet.has(w.qid)).length;
  const sortMode = state.settings.wrongSort || 'rand';
  const subFilter = state.settings.wrongSub || 'all';   // all / economy / business（临时筛选）
  const cntE = state.wrong.filter(w => subOf(w) === 'economy').length;
  const cntB = state.wrong.filter(w => subOf(w) === 'business').length;
  const sortBtn = m => `<button class="btn ghost ${sortMode === m ? 'sel' : ''}" onclick="setWrongSort('${m}')">${m === 'rand' ? '🎲 随机' : m === 'new' ? '🕐 最新在前' : '🕐 最早在前'}</button>`;
  const subBtn = (v, label) => `<button class="btn ghost ${subFilter === v ? 'sel' : ''}" onclick="setWrongSub('${v}')">${label}</button>`;
  const header = `<div class="card"><div class="row"><h2>错题库（${state.wrong.length}）</h2>
      <button class="btn ghost" onclick="clearWrong()">清空</button></div>
    <p class="muted">长期保存 · 按艾宾浩斯记忆曲线自动排程。今日待复习 <b style="color:var(--red)">${dueList.length}</b> 题。AI 修正过的题会标「AI已修正」。</p>
    <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn" onclick="startWrongDue()">📌 复习待做（${dueList.length}）</button>
      <button class="btn g" onclick="startWrongAll()">🔁 全部重做（${state.wrong.length}）</button>
    </div>
    <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">
      <span class="muted" style="font-size:13px">科目：</span>${subBtn('all', '全部')}${subBtn('economy', `经济基础（${cntE}）`)}${subBtn('business', `工商管理（${cntB}）`)}
    </div>
    <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">
      <span class="muted" style="font-size:13px">排序：</span>${sortBtn('rand')}${sortBtn('new')}${sortBtn('old')}
      <span class="muted" style="font-size:12px">${sortMode === 'rand' ? '随机打乱，待复习题置顶' : ''}</span>
    </div>
    <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;border-top:1px solid var(--line);padding-top:10px">
      <button class="btn ghost" onclick="toggleAllSel()">☐ 全选</button>
      <button class="btn" onclick="rmWrongBatch()">🗑 删除所选（<span id="selCount">0</span>）</button>
      ${unCount ? `<button class="btn" style="color:var(--red)" onclick="rmUnanswerable()">⚠️ 一键删除无法作答（${unCount}）</button>` : ''}
      <button class="btn ghost" onclick="startStubborn(3)" title="累计做错≥3次的题，按错误次数从高到低">🔁 顽固错题（${cntStub}）</button>
      <button class="btn ghost" onclick="startStubborn(3, true)" title="错≥3次且至今一次没做对过">💀 从未做对（${cntHard}）</button>
      <button class="btn ghost" onclick="rmWrongByList()">🧹 按清单清理</button>
      ${retCnt ? `<button class="btn ghost" onclick="rmRetiredWrong()" title="2026 考纲整章删除的题（如电子商务），一键从错题库剔除">🧹 清除已删章节（${retCnt}）</button>` : ''}
    </div></div>`;
  let list = state.wrong.slice();
  if (subFilter !== 'all') list = list.filter(w => subOf(w) === subFilter);
  if (sortMode === 'rand') {
    const due = list.filter(isDue), rest = list.filter(w => !isDue(w));
    shuffleArr(due); shuffleArr(rest);
    list = due.concat(rest);
  } else if (sortMode === 'new') {
    list.reverse();
  }
  const items = list.map(w => {
    const v = wrongAnswerView(w);
    const canRedo = Array.isArray(w.options) && w.options.length >= 2;
    const due = isDue(w);
    const matured = (w.box || 0) >= EB_MAX;
    const status = matured ? `已巩固 · 下次 ${w.due || '—'}` : (due ? '⏰ 今日待复习' : `排到 ${w.due || '—'}`);
    const dispAnswer = v.answer;
    const dispExpl = v.explanation;
    const corrBadge = v.corrected ? ` <span class="pill a">AI已修正</span>` : '';
    const unBadge = isUnanswerable(w) ? ` <span class="pill bad">⚠️ 无材料·无法作答</span>` : '';
    const subPill = subjectPill(subOf(w));
    return `
    <div class="q">
      <div class="meta"><label class="wselbox"><input type="checkbox" class="wsel" data-qid="${w.qid}" onchange="updateSelCount()"></label>${subPill}${esc(w.chapterTitle || '')}　|　答错 ${w.count || 1} 次　|　${status}　|　你的答案：${w.yourWrong || '—'}${unBadge}${retSet.has(w.qid) ? ' <span class="pill" style="background:#eceff3;color:#5b6472">2026 已删·可跳过</span>' : ''}</div>
      ${caseMaterialHtml(w.subject, w.chapterId, w.qid)}
      <div class="stem">${renderStem(w.stem)}</div>
      <div class="explain show"><b>正确答案：</b>${esc(dispAnswer)} ${corrBadge}</div>
      ${dispExpl ? `<div class="explain show" style="background:var(--amber-l)"><b>解析：</b>${esc(dispExpl)}</div>` : ''}
      <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap">
        ${canRedo ? `<button class="btn" onclick="redoWrong('${w.qid}')">重做</button>` : ''}
        <button class="btn ghost" onclick="rmWrong('${w.qid}')">移除</button>
        ${w.yourWrong ? `<button class="btn ghost" onclick="aiDiagnoseBtn('${w.qid}')">🩺 AI 诊断</button>` : ''}
        <button class="btn ghost" onclick="aiSimilarBtn('${w.qid}')">🎯 举一反三</button>
      </div>
      <div id="aiResult_${w.qid}"></div>
    </div>`;
  }).join('');
  app.innerHTML = header + items;
}
window.setWrongSort = function (m) { state.settings.wrongSort = m; saveSettings(); renderWrong(); };
window.setWrongSub = function (v) { state.settings.wrongSub = v; saveSettings(); renderWrong(); };
window.rmWrong = function (qid) { removeWrong(qid); renderWrong(); };
window.clearWrong = function () { if (confirm('确定清空全部错题？')) { state.wrong = []; saveWrong(); renderWrong(); } };
/* 答题页删除当前错题：从错题库移除 + 从当前队列剔除（删完队列空则返回） */
window.delWrongInQuiz = function (qid) {
  if (!confirm('确定删除这道错题？删除后不再出现在错题库和复习中。')) return;
  removeWrong(qid);
  const i = quiz.queue.findIndex(it => it.q && it.q.id === qid);
  if (i >= 0) quiz.queue.splice(i, 1);
  if (i < quiz.idx) quiz.idx--;
  if (state.session) { state.session.items = quiz.queue.map(it => ({ subject: it.subject, chapterId: it.chapterId, qid: it.q.id })); state.session.idx = quiz.idx; saveSession(); }
  toast('已删除该错题');
  if (!quiz.queue.length) { state.session = null; saveSession(); router(); return; }
  if (quiz.idx >= quiz.queue.length) quiz.idx = quiz.queue.length - 1;
  renderQuiz();
};
/* 单题重做页删除 */
window.delWrongSingle = function (qid) {
  if (!confirm('确定删除这道错题？删除后不再出现在错题库和复习中。')) return;
  removeWrong(qid);
  toast('已删除该错题');
  renderWrong();
};

function redoWrong(qid) {
  const w = state.wrong.find(x => x.qid === qid);
  if (!w) { renderWrong(); return; }
  const v = wrongAnswerView(w);
  const opts = v.options;
  const ans = v.answer || '';
  const q = shuffleOpts({ id: qid, type: v.type || 'single', stem: v.stem, options: opts, answer: normAnswer(ans), explanation: v.explanation || '' });
  app.innerHTML = `<div class="card"><div class="row"><span class="muted">重做 · ${esc(w.chapterTitle || '')}</span><span class="muted">${subjectPill(subOf(w))} ❓ ${state.wrong.indexOf(w) + 1}/${state.wrong.length}</span></div>
    <div class="q">${caseMaterialInline(w.subject, w.chapterId, w.qid)}<div class="qtype">${typeBadge(q.type)}</div><div class="stem">${renderStem(q.stem)}</div>
    ${optHtml(q.options, q.type)}
    <button class="btn g" id="redoSubmit" disabled>提交</button>
    <button class="btn" style="color:var(--red)" onclick="delWrongSingle('${qid}')">🗑 删除此题</button>
    <div class="explain" id="redoExplain"></div></div>
    <div id="redoNav" style="margin-top:10px"></div></div>`;
  let rsel = new Set();
  const optEls = app.querySelectorAll('.opt');
  optEls.forEach(b => b.onclick = () => {
    if (document.getElementById('redoExplain').classList.contains('show')) return;
    if (!isMulti(q.type)) {
      optEls.forEach(x => x.classList.remove('sel'));
      b.classList.add('sel'); rsel = new Set([+b.dataset.i]);
      document.getElementById('redoSubmit').disabled = false;
    } else {
      b.classList.toggle('sel');
      if (b.classList.contains('sel')) rsel.add(+b.dataset.i); else rsel.delete(+b.dataset.i);
      document.getElementById('redoSubmit').disabled = rsel.size === 0;
    }
    document.getElementById('redoSubmit').textContent = submitLabel(q.type, rsel.size, '提交');
  });
  document.getElementById('redoSubmit').onclick = () => {
    const correct = multiPass(q, [...rsel].map(i => q.options[i][0]));
    const ex = document.getElementById('redoExplain');
    optEls.forEach((b, i) => {
      const letter = q.options[i][0];
      if (q.answer.includes(letter)) b.classList.add('correct');
      else if (rsel.has(i)) b.classList.add('wrong');
      else b.classList.add('dim');
      b.disabled = true;
    });
    ex.innerHTML = `<b>答案：</b>${normAnswer(q.answer).join('、')}　|　<b>解析：</b>${esc(q.explanation)}`;
    ex.classList.add('show');
    document.getElementById('redoSubmit').style.display = 'none';
    gradeWrong(w, correct);
    const nav = document.getElementById('redoNav');
    if (correct) {
      const matured = (w.box || 0) >= EB_MAX;
      nav.innerHTML = `<span class="muted">✓ 答对了！已按记忆曲线排到 <b>${w.due}</b> 复习${matured ? '（已巩固）' : ''}。</span> <button class="btn ghost" onclick="renderWrong()">返回错题库</button>`;
    } else {
      nav.innerHTML = `<span class="muted">答错了，已重置到近日重练。看解析 →</span> <button class="btn ghost" onclick="renderWrong()">返回错题库</button>`;
    }
  };
}
window.redoWrong = redoWrong;

function startWrongSession(list, title, keepOrder) {
  const items = list.filter(w => Array.isArray(w.options) && w.options.length >= 2).map(w => ({ subject: w.subject, chapterId: w.chapterId, qid: w.qid }));
  if (!items.length) { toast('没有可重做的题目（需含选项）'); renderWrong(); return; }
  const queue = items.map(it => {
    const q = findQById(it.qid);
    return { q: applyCorrections(q || {}), subject: it.subject, chapterId: it.chapterId, chapterTitle: (findChapter(it.subject, it.chapterId) || {}).title || '' };
  });
  if (!keepOrder) shuffleArr(queue);
  beginQuiz(queue, title, true, [], false);
}
/* 顽固错题循环练（2026-10-17）：按累计做错次数筛选，次数高的排前面
   onlyNever=true 时只看“至今一次没做对过”(box=0) 的硬骨头 */
window.startStubborn = function (minCount, onlyNever) {
  const mc = minCount || 3;
  let list = state.wrong.filter(w => (w.count || 1) >= mc);
  if (onlyNever) list = list.filter(w => (w.box || 0) === 0);
  if (!list.length) { toast('没有符合条件的顽固错题'); return; }
  list = list.slice().sort((a, b) => (b.count || 1) - (a.count || 1));
  const title = (onlyNever ? '顽固错题 · 从未做对' : '顽固错题 · 错≥' + mc + '次') + '（' + list.length + '）';
  startWrongSession(list, title, true);
};
function startWrongDue() { startWrongSession(state.wrong.filter(isDue), '错题 · 待复习'); }
function startWrongAll() { startWrongSession(state.wrong, '错题 · 全部重做'); }
window.startWrongDue = startWrongDue;
window.startWrongAll = startWrongAll;

/* ---------------- 视图：笔记 ---------------- */
function isNoteRead(sub, chapter) {
  return !!(state.progress.notesDone && state.progress.notesDone[sub + ':' + chapter]);
}
function todayNoteChapter(subject) {
  const t = (DATA.plan.days || []).find(d => d.date === localToday());
  return t && t[subject] ? t[subject].noteChapter || null : null;
}
function renderDayNotes(date) {
  const P = DATA.plan;
  const day = (P.days || []).find(d => d.date === date);
  if (!day) {
    app.innerHTML = `<div class="card"><h2>📒 今日笔记</h2><p class="muted">未找到 ${date} 的计划。</p><a class="btn" href="#/plan">← 返回计划</a></div>`;
    return;
  }
  const subs = [];
  if (day.economy && day.economy.noteChapter) subs.push(['economy', '经济基础', day.economy.noteChapter]);
  if (day.business && day.business.noteChapter) subs.push(['business', '工商管理', day.business.noteChapter]);
  if (!subs.length) { app.innerHTML = `<div class="card"><h2>📒 今日笔记</h2><p class="muted">当天未安排笔记章节。</p><a class="btn" href="#/plan">← 返回计划</a></div>`; return; }
  let body = '', allRead = true, anyNote = false;
  for (const [sub, label, cid] of subs) {
    const ch = findChapter(sub, cid);
    const title = ch ? ch.title : cid;
    const note = DATA.notes[cid];
    const read = isNoteRead(sub, cid);
    if (!read) allRead = false;
    if (note) anyNote = true;
    const inner = note ? `<div class="note">${esc(note)}</div>` : `<p class="muted">本节无配套笔记，可直接刷题。</p>`;
    body += `<div class="card note-item">
      <span class="pill ${sub === 'business' ? 'g' : ''}">${label}</span>
      <h3>${esc(title)} ${read ? '<span class="pill g">📒 已读</span>' : ''}</h3>
      ${inner}
      <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap">
        ${ch && ch.questions && ch.questions.length ? `<a class="btn" href="#/quiz" data-sub="${sub}" data-ch="${cid}">去刷题（${ch.questions.length}）</a>` : ''}
        <button class="btn ghost" onclick="markNoteRead('${sub}','${cid}','${date}')">${read ? '✓ 已读' : '标记为已读'}</button>
      </div></div>`;
  }
  const isToday = date === localToday();
  const markAll = (day.economy && day.business) ? `<button class="btn" onclick="markDayNotesRead('${date}')">✓ 我已读完今日笔记</button>` : '';
  app.innerHTML = `<div class="card">
    <a class="btn ghost" href="#/plan">← 返回 ${date} 计划</a>
    <h2>📒 ${date} 笔记任务</h2>
    <p class="muted">${day.focus || '今日配套笔记'}　|　${isToday ? '今日' : '复习日'}：经济基础 + 工商管理 各一章${anyNote ? '' : '（本章暂无笔记）'}</p>
    ${allRead ? '<span class="pill g">📒 今日笔记已全部读完</span>' : ''}
    <div style="margin-top:10px">${markAll}</div>
  </div>${body}`;
}
window.markNoteRead = function (sub, cid, date) {
  state.progress.notesDone = state.progress.notesDone || {};
  state.progress.notesDone[sub + ':' + cid] = localToday();
  saveProgress();
  toast('已标记笔记已读 ✅');
  renderDayNotes(date);
};
window.markDayNotesRead = function (date) {
  const day = (DATA.plan.days || []).find(d => d.date === date);
  if (!day) return;
  state.progress.notesDone = state.progress.notesDone || {};
  if (day.economy) state.progress.notesDone['economy:' + day.economy.chapter] = localToday();
  if (day.business) state.progress.notesDone['business:' + day.business.chapter] = localToday();
  saveProgress();
  toast('今日笔记已全部标记已读 ✅');
  renderDayNotes(date);
};
function renderNotes() {
  if (window._q && window._q.date) { renderDayNotes(window._q.date); return; }
  const subjects = [['economy', '经济基础'], ['business', '工商管理']];
  let html = `<div class="card"><h2>📒 三色 / 四色笔记</h2>
    <p class="muted">按教材章节整理：<b style="color:var(--red)">红</b>=必考　<b style="color:var(--amber-d)">黄</b>=易混　<b style="color:var(--blue-d)">蓝</b>=真题出处。点击「去刷题」可做该章真题。</p>
    <input id="noteSearch" placeholder="搜索章节或笔记关键词…" style="margin-top:10px"></div>`;
  for (const [sub, label] of subjects) {
    const order = sub === 'economy' ? DATA.plan.economyOrder : DATA.plan.businessOrder;
    let cards = '';
    for (const cid of order) {
      const note = DATA.notes[cid]; if (!note) continue;
      const ch = findChapter(sub, cid);
      const title = ch ? ch.title : cid;
      const hasQ = ch && ch.questions && ch.questions.length;
      const btn = hasQ
        ? `<a class="btn" href="#/quiz" data-sub="${sub}" data-ch="${cid}">去刷题（${ch.questions.length}）</a>`
        : `<span class="muted">本节无题，仅看笔记</span>`;
      cards += `<div class="card note-item" data-text="${(title + ' ' + note).replace(/"/g, '')}">
        <span class="pill ${sub === 'business' ? 'g' : ''}">${label}</span><h3>${esc(title)}</h3>
        <div class="note">${esc(note)}</div>
        <div style="margin-top:10px">${btn}</div></div>`;
    }
    html += `<div class="note-group">${cards}</div>`;
  }
  app.innerHTML = html;
  const inp = document.getElementById('noteSearch');
  if (inp) inp.addEventListener('input', () => {
    const q = inp.value.trim().toLowerCase();
    app.querySelectorAll('.note-item').forEach(el => {
      const t = (el.dataset.text || '').toLowerCase();
      el.style.display = (!q || t.includes(q)) ? '' : 'none';
    });
  });
}

/* ---------------- 视图：计划 ---------------- */
function dayCell(sub, spec) {
  const ch = findChapter(sub, spec.chapter);
  const title = ch ? ch.title : spec.chapter;
  const from = spec.from || 0;
  const to = (spec.to == null) ? (ch ? ch.questions.length : 0) : spec.to;
  const n = to - from;
  return `<a class="btn" style="padding:4px 10px;font-size:12px" href="#/quiz" data-sub="${sub}" data-ch="${spec.chapter}" data-from="${from}" data-to="${to}">${esc(title.slice(0, 12))}（${n}）</a>`;
}
function renderPlan() {
  const P = DATA.plan;
  const today = localToday();
  const left = daysBetween(today, P.examDate);
  const pace = P.pace || { economy: 40, business: 35 };
  let html = `<div class="card"><h2>🗓️ 学习计划</h2>
    <div class="stat">
      <div class="box"><b>${P.startDate}</b>开始日</div>
      <div class="box"><b>${P.examDate}</b>考试日</div>
      <div class="box"><b>${left}</b>距考试天数</div>
    </div>
    <p class="muted">三阶段：基础通关 → 强化专项 → 冲刺模考。每天经济+工商各一组（封顶 ${pace.economy}/${pace.business} 题），配套读三色笔记 + 自动带入到期错题。点章可直接刷该段题。</p></div>`;
  const phases = P.phases || [];
  const days = P.days || [];
  for (const ph of phases) {
    const phDays = days.filter(d => d.date >= ph.start && d.date <= ph.end);
    let rows = '';
    for (const d of phDays) {
      const eco = d.economy ? dayCell('economy', d.economy) : '<span class="muted">—</span>';
      const bus = d.business ? dayCell('business', d.business) : '<span class="muted">—</span>';
      const ne = d.economy && d.economy.noteChapter;
      const nb = d.business && d.business.noteChapter;
      const noteChaps = [ne, nb].filter(Boolean);
      const noteRead = noteChaps.length && noteChaps.every(c => isNoteRead((ne === c) ? 'economy' : 'business', c));
      const note = noteChaps.length ? `<a class="btn ghost" style="padding:4px 10px;font-size:12px" href="#/notes?date=${d.date}" title="今日配套笔记（教材三色笔记）">📒 看笔记(${noteChaps.join('/')})${noteRead ? '✓' : ''}</a>` : '';
      // 每科完成判定：真题(dayDoneAt 优先+done 前缀兜底) 且 笔记读完；无计划视为完成
      const ecoDone = d.economy ? dayDoneAt('economy', d.economy.chapter, d.date) : true;
      const ecoNoteOk = ne ? isNoteRead('economy', ne) : true;
      const ecoFull = d.economy ? (ecoDone && ecoNoteOk) : true;
      const busDone = d.business ? dayDoneAt('business', d.business.chapter, d.date) : true;
      const busNoteOk = nb ? isNoteRead('business', nb) : true;
      const busFull = d.business ? (busDone && busNoteOk) : true;
      const done = ecoFull && busFull;
      const anyDone = ecoDone || busDone;                 // 任一小项完成 → 部分完成
      const cls = d.date === today ? 'a' : (done ? 'g' : (d.date < today && anyDone ? 'a' : ''));
      const status = d.date === today ? '今天'
        : (d.date < today ? (done ? '已完成✓' : (anyDone ? '部分完成' : '待补学')) : '待开始');
      // 每科旁打勾：该科真题+笔记全部完成才显示 ✓
      const ecoTick = d.economy && ecoFull ? ' <span class="ok">✓</span>' : '';
      const busTick = d.business && busFull ? ' <span class="ok">✓</span>' : '';
      rows += `<div class="plan-row"><span class="pdate">${d.date}</span><span class="pill ${cls}">${status}</span>
        <span class="ptitle">${eco}${ecoTick}　|　${bus}${busTick} ${note}</span></div>`;
    }
    const phCls = ph.name.indexOf('强化') >= 0 ? 'a' : (ph.name.indexOf('冲刺') >= 0 ? '' : 'g');
    html += `<div class="card"><span class="pill ${phCls}">${ph.name}</span><h3>${ph.start} ~ ${ph.end}（${phDays.length} 天）</h3>${rows}</div>`;
  }
  app.innerHTML = html;
}

/* ---------------- 视图：进度 ---------------- */
function renderProgress() {
  const doneCount = Object.keys(state.progress.done || {}).length;
  const left = daysBetween(localToday(), DATA.plan.examDate);
  const dueCount = state.wrong.filter(isDue).length;
  const masteredCount = state.wrong.filter(w => (w.box || 0) >= EB_MAX).length;
  const elapsed = Math.max(0, daysBetween(DATA.plan.startDate, localToday()) + 1);
  app.innerHTML = `<div class="card">
    <h2>学习进度</h2>
    <div class="stat">
      <div class="box"><b>${elapsed}</b>已进行天数</div>
      <div class="box"><b>${left}</b>距考试天数</div>
      <div class="box"><b>${doneCount}</b>已完成章节</div>
      <div class="box"><b style="color:var(--red)">${state.wrong.length}</b>错题库(长期保存)</div>
      <div class="box"><b style="color:var(--amber-d)">${dueCount}</b>今日待复习</div>
      <div class="box"><b style="color:var(--green-d)">${masteredCount}</b>已巩固</div>
      <div class="box"><b>${state.progress.streak || 0}</b>连续学习</div>
    </div>
    <p class="muted">开始日 ${DATA.plan.startDate}　·　考试日 ${DATA.plan.examDate}　|　错题库按艾宾浩斯曲线自动排程，答对进阶层、答错重置。AI 修正 ${Object.keys(state.corrections).length} 题。</p>
  </div>`;
}

/* ---------------- 视图：设置 ---------------- */
function renderSettings() {
  const s = state.settings;
  const last = s.lastSync ? new Date(s.lastSync).toLocaleString() : '从未';
  const prov = cloudProvider();
  app.innerHTML = `<div class="card">
    <h2>设置 · 云同步（GitHub / Gitee）</h2>
    <p class="muted">错题、进度、AI 修正默认存浏览器本地（IndexedDB）。选择同步方式后，这三类数据会备份到你指定的云端仓库，实现「单位 ↔ 家」自动同步，无需再手动导出/导入 JSON。</p>
    <label>同步方式</label>
    <select id="prov" onchange="onProvChange()">
      <option value="github" ${prov === 'github' ? 'selected' : ''}>GitHub（家里网络可用）</option>
      <option value="gitee" ${prov === 'gitee' ? 'selected' : ''}>Gitee 码云（国内直连 · 单位可用）</option>
    </select>
    <div class="note" style="margin-top:12px;white-space:normal">
      <b>① GitHub</b>　<span class="muted">（Token 同时用于「推送订正到题库」，建议始终填写）</span>
      <label>GitHub Token（建议用 fine-grained，仅授权本题库仓库的 Contents 读写）</label>
      <input id="tok" type="password" placeholder="ghp_xxx 或 github_pat_xxx" value="${s.token || ''}">
      <label>仓库（格式 owner/repo）</label>
      <input id="repo" placeholder="homjanon/jingjishi" value="${s.repo || ''}">
      <label>分支</label>
      <input id="branch" placeholder="main" value="${s.branch || 'main'}">
      <label>数据文件路径</label>
      <input id="path" placeholder="data/user-data.json" value="${s.path || 'data/user-data.json'}">
    </div>
    <div class="note" style="margin-top:10px;white-space:normal">
      <b>② Gitee 码云</b>　<span class="muted">（私人令牌只需勾选 <b>projects</b> 权限；建议用<b>私有仓</b>，数据不公开）</span>
      <label>Gitee 私人令牌</label>
      <input id="gtok" type="password" placeholder="Gitee 私人令牌" value="${s.giteeToken || ''}">
      <label>Gitee 仓库（格式 owner/repo）</label>
      <input id="grepo" placeholder="homjanon/jingjishidata" value="${s.giteeRepo || ''}">
      <label>Gitee 数据目录（用仓库默认分支；可留空=仓库根目录）</label>
      <input id="gpath" placeholder="jingjishidata/" value="${s.giteePath || 'jingjishidata/'}">
      <p class="muted" style="font-size:12px">每次同步生成 <b>user-data-日期-时间.json</b> 新文件（无需覆盖旧文件，天然免 sha 冲突）；拉取自动读取时间戳最新的那份，旧文件保留为历史备份。</p>
    </div>
    <label style="margin-top:12px"><input type="checkbox" id="auto" ${s.auto ? 'checked' : ''}> 自动同步（数据变动 15 秒后静默上传到<b id="autoProv">${cloudName()}</b>，成功不打扰、失败才提示）</label>
    <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn" onclick="saveSet()">保存设置</button>
      <button class="btn g" onclick="cloudSaveBtn()">☁️ 同步到云端（<span id="btnUp">${cloudName()}</span>）</button>
      <button class="btn ghost" onclick="cloudLoadBtn()">📥 从云端拉取（<span id="btnDown">${cloudName()}</span>）</button>
    </div>
    <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn ghost" onclick="exportBackup()">⬇ 导出备份（下载JSON）</button>
      <label class="btn ghost" style="cursor:pointer;margin:0">⬆ 导入备份<input id="imp" type="file" accept="application/json" style="display:none" onchange="importBackup(this)"></label>
    </div>
    <p class="muted" style="margin-top:8px">💡 推荐用法：<b>单位选 Gitee</b>（国内直连不需代理），做完题点「同步到云端」；<b>回家点「从云端拉取」</b>合并，再按需「批量推送订正到题库」写回 GitHub。两平台数据格式一致，可随时切换；导出/导入备份始终可用作离线兜底。</p>
    <p class="muted" style="margin-top:10px">上次同步：${last}</p>
    <div class="note" style="margin-top:12px">
      <label style="margin:0 0 4px"><input type="checkbox" id="aic" ${s.aiCorrect === false ? '' : 'checked'}> 启用 <b>AI 自动修正</b>（精讲后自动补全/修正本题解析与答案）</label>
      <div style="margin-top:8px;display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn ghost" onclick="clearCorrections()">清除全部 AI 修正（${Object.keys(state.corrections).length}）</button>
        <button class="btn" onclick="pushMyCorrections()">📤 批量推送我的订正到题库（${Object.keys(state.corrections).length}）</button>
      </div>
      <p class="muted" style="margin-top:6px">📥 站点启动会自动加载 <b>data/patches.json</b>（官方订正库），与你本地订正合并生效。推送需 GitHub Token；工作地无网时本地照常用，回家有网再点推送。</p>
    </div>
    <div class="note" style="margin-top:10px">⚠️ 若仓库为「公开」，你的错题/进度数据也会公开可见。需要隐私请：① 仓库设私有 + 升级 GitHub Pro 后用 GitHub Pages；或 ② 改用 Cloudflare Pages（免费支持私有仓库）。</div>
  </div>${renderAISettings()}`;
  const pv = document.getElementById('aiProv');
  if (pv) { pv.addEventListener('change', loadAIKeyInput); loadAIKeyInput(); }
}
window.saveSet = async function () {
  const val = (id, d) => { const el = document.getElementById(id); return el ? (el.value.trim() || d || '') : (d || ''); };
  state.settings.provider = val('prov', 'github') === 'gitee' ? 'gitee' : 'github';
  state.settings.token = val('tok');
  state.settings.repo = val('repo');
  state.settings.branch = val('branch', 'main');
  state.settings.path = val('path', 'data/user-data.json');
  state.settings.giteeToken = val('gtok');
  state.settings.giteeRepo = val('grepo');
  state.settings.giteePath = val('gpath', 'jingjishidata/');
  state.settings.auto = document.getElementById('auto').checked;
  state.settings.aiCorrect = document.getElementById('aic').checked;
  await saveSettings();
  toast('设置已保存（当前同步方式：' + cloudName() + '）');
};
/* 下拉切换即时生效：无需先点保存，按钮文案同步更新 */
window.onProvChange = async function () {
  const el = document.getElementById('prov');
  state.settings.provider = el && el.value === 'gitee' ? 'gitee' : 'github';
  await saveSettings();
  ['btnUp', 'btnDown', 'autoProv'].forEach(id => { const n = document.getElementById(id); if (n) n.textContent = cloudName(); });
  toast('同步方式已切换为 ' + cloudName());
};
window.cloudSaveBtn = function () { cloudSave(false); };
window.cloudLoadBtn = function () { cloudLoad(); };
window.ghSave = function () { githubSave(false); };
window.ghLoad = githubLoad;
window.exportBackup = function () {
  const payload = {
    wrong: state.wrong, progress: state.progress, corrections: state.corrections,
    mockHistory: mockHistory(), mockSession: loadMockSession(),   // 模考成绩与答题纸，便于复核
    exportedAt: new Date().toISOString()
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'econ-backup-' + localToday() + '.json'; a.click();
  toast('已导出备份文件');
};
/* 合并式导入：错题按 qid 去重并集、进度 done+dayDone 取晚、订正按 qid 取新 ts；绝不覆盖 settings */
function mergeWrong(inc, cur) {
  const map = {};
  for (const w of (cur || [])) if (w && w.qid) map[w.qid] = w;
  for (const w of (inc || [])) {
    if (!w || !w.qid) continue;
    const ex = map[w.qid];
    if (!ex) { map[w.qid] = w; continue; }
    const a = new Date(w.last || 0).getTime(), b = new Date(ex.last || 0).getTime();
    map[w.qid] = (a >= b) ? w : ex; // 取较新记录
  }
  return Object.values(map);
}
function mergeProgress(inc, cur) {
  const out = Object.assign({}, cur || {});
  out.done = Object.assign({}, (cur && cur.done) || {});
  if (inc && inc.done) for (const k in inc.done) {
    const d1 = inc.done[k], d0 = out.done[k];
    if (!d0 || new Date(d1) >= new Date(d0)) out.done[k] = d1; // 日期取较晚
  }
  out.dayDone = Object.assign({}, (cur && cur.dayDone) || {});
  if (inc && inc.dayDone) for (const dt in inc.dayDone) out.dayDone[dt] = Object.assign({}, out.dayDone[dt], inc.dayDone[dt]);
  // 笔记已读合并：按 chapterKey 取较晚日期（与 done 同策略）
  out.notesDone = Object.assign({}, (cur && cur.notesDone) || {});
  if (inc && inc.notesDone) for (const k in inc.notesDone) {
    const d1 = inc.notesDone[k], d0 = out.notesDone[k];
    if (!d0 || new Date(d1) >= new Date(d0)) out.notesDone[k] = d1;
  }
  // 迁移：备份缺 dayDone 但有旧 progress.done → 按 chapterKey→subject→date 重建，历史完成态不丢
  if (inc && inc.done) for (const k in inc.done) {
    const sub = k.split(':')[0], dt = inc.done[k];
    out.dayDone[dt] = out.dayDone[dt] || {};
    out.dayDone[dt][sub] = true;
  }
  if (inc) {
    out.streak = Math.max(out.streak || 0, inc.streak || 0);
    if (!out.lastStudy || (inc.lastStudy && new Date(inc.lastStudy) > new Date(out.lastStudy))) out.lastStudy = inc.lastStudy;
  }
  return out;
}
function mergeCorrections(inc, cur) {
  const out = Object.assign({}, cur || {});
  if (inc) for (const k in inc) {
    const c0 = out[k], c1 = inc[k];
    if (!c0) { out[k] = c1; continue; }
    const t0 = new Date(c0.ts || 0).getTime(), t1 = new Date(c1.ts || 0).getTime();
    out[k] = (t1 >= t0) ? c1 : c0; // 取较新版本
  }
  return out;
}
window.importBackup = function (input) {
  const f = input.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => { try {
    const p = JSON.parse(r.result);
    const nW = (p.wrong || []).length, nP = Object.keys(p.progress && p.progress.done || {}).length, nC = Object.keys(p.corrections || {}).length;
    state.wrong = mergeWrong(p.wrong, state.wrong);
    state.progress = mergeProgress(p.progress, state.progress);
    state.corrections = mergeCorrections(p.corrections, state.corrections);
    const mhBefore = mockHistory().length;
    const mh = mergeMockHistory(p.mockHistory, mockHistory());
    mockSaveHistory(mh);
    saveWrong(); saveProgress(); saveCorrections();
    validateSession(true);   // 导入后清掉本机残留会话（数据已来自另一台设备）
    const mhAdd = mh.length - mhBefore;
    toast(`已合并导入 ✅（错题 ${nW} 道 / 进度 ${nP} 条 / 订正 ${nC} 条${mhAdd > 0 ? ` / 模考记录 +${mhAdd} 场` : ''}，已与本机数据合并）`);
    router();
  } catch (e) { toast('导入失败：' + e.message); } };
  r.readAsText(f);
};

/* 拦截今日卡片里的刷题按钮（支持题段 from/to） */
app.addEventListener('click', e => {
  const a = e.target.closest('a[data-sub]');
  if (a) {
    e.preventDefault();
    const from = a.dataset.from !== undefined ? +a.dataset.from : undefined;
    const to = a.dataset.to !== undefined ? +a.dataset.to : undefined;
    startQuiz(a.dataset.sub, a.dataset.ch, from, to);
  }
});

/* ================ AI 讲解（浏览器直连 LLM，镜像 delivery-ocr 模式） ================ */
window.currentAIQid = null;
const AI_PRESETS = {
  zhipu:    { name: "智谱 AI glm-4.6v（直连✅）", baseUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions", model: "glm-4.6v", key: "zhipu" },
  siliconflow: { name: "硅基流动 DeepSeek-V4-Flash（备用）", baseUrl: "https://api.siliconflow.cn/v1/chat/completions", model: "deepseek-ai/DeepSeek-V4-Flash", key: "siliconflow" },
  agnes:    { name: "Agnes 2.0-Flash（免费·备用）", baseUrl: "https://apihub.agnes-ai.com/v1/chat/completions", model: "agnes-2.0-flash", key: "agnes" },
};
const AI_TEACHER_SYS = "你是中级经济师考试（经济基础+工商管理）的辅导老师，擅长用大白话和生活例子讲透考点，并编好记的口诀。面向只想稳过84分的考生，回答通俗、简洁、不啰嗦。";
function aiStore(p) { return "ej_" + p + "Key"; }
function aiModelStore(p) { return "ej_model_" + p; }
function aiGetKey(p) { return localStorage.getItem(aiStore(p)) || ""; }
function aiGetModel(p) { return localStorage.getItem(aiModelStore(p)) || AI_PRESETS[p].model; }
function aiCfg() {
  let p = state.settings.aiProvider;
  if (!p || !AI_PRESETS[p]) p = "zhipu";   // 旧值（如 qwen35）自动落到默认智谱
  return { provider: p, baseUrl: AI_PRESETS[p].baseUrl, model: aiGetModel(p), key: aiGetKey(p) };
}
/* CORS 代理（可选）：设置里填代理前缀，请求走 代理?url=<目标>；留空直连 */
function proxiedUrl(base) {
  const p = (state.settings.aiProxy || "").trim();
  if (!p) return base;
  const enc = encodeURIComponent(base);
  if (p.indexOf("url=") >= 0) return p + enc;
  return p + (p.indexOf("?") >= 0 ? "&" : "?") + "url=" + enc;
}
function extractJSON(text) {
  if (!text) return null;
  let s = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1];
  const a = s.indexOf("{"); const b = s.lastIndexOf("}");
  if (a < 0 || b < a) return null;
  s = s.slice(a, b + 1);
  try { return JSON.parse(s); } catch (e) {}
  return repairJSON(s);
}
function repairJSON(s) {
  try {
    let out = s, depth = 0, inStr = false, esc = false;
    for (const ch of s) { if (esc) { esc = false; continue; } if (ch === "\\") { esc = true; continue; } if (ch === '"') { inStr = !inStr; continue; } if (inStr) continue; if (ch === "{") depth++; else if (ch === "}") depth--; }
    if (inStr) out += '"';
    while (depth > 0) { out += "}"; depth--; }
    return JSON.parse(out);
  } catch (e) { return null; }
}
/* 单次调用（无降级）：onToken(t, full) 回调增量 → 流式；否则非流式。90s（流式 120s）超时 */
async function callLLMOnce(cfg, messages, opts) {
  const stream = !!opts.onToken;
  const body = { model: cfg.model, messages, temperature: (opts.temperature != null ? opts.temperature : 0.6), stream };
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), stream ? 120000 : 90000);
  let resp;
  try {
    resp = await fetch(proxiedUrl(cfg.baseUrl), { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + cfg.key }, body: JSON.stringify(body), signal: ctl.signal });
  } catch (e) { clearTimeout(to); return { error: "net", msg: String(e) }; }
  clearTimeout(to);
  if (!resp.ok) { let t = ""; try { t = await resp.text(); } catch (_) {} return { error: "http", status: resp.status, msg: (t || "").slice(0, 300) }; }
  if (stream) {
    try {
      if (!resp.body) return { error: "parse", msg: "no stream body" };
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = "", full = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
          if (line.indexOf("data:") !== 0) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const j = JSON.parse(data);
            const delta = (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) || "";
            if (delta) { full += delta; opts.onToken(delta, full); }
          } catch (e) {}
        }
      }
      if (!full) return { error: "empty" };
      if (opts.json) { const p2 = extractJSON(full); if (!p2) return { error: "json", content: full }; return { content: p2 }; }
      return { content: full };
    } catch (e) { return { error: "net", msg: String(e) }; }
  }
  let j; try { j = await resp.json(); } catch (e) { return { error: "parse", msg: String(e) }; }
  const c = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (c == null) return { error: "empty", raw: j };
  if (opts.json) { const p2 = extractJSON(c); if (!p2) return { error: "json", content: c }; return { content: p2 }; }
  return { content: c };
}
/* 带自动降级的调用：主通道失败 → 按预设顺序切备用（无 Key 的跳过）；切换时调 onReset() 清空已显示内容 */
async function callLLM(messages, opts) {
  opts = opts || {};
  const cur = aiCfg().provider;
  const order = [cur].concat(Object.keys(AI_PRESETS).filter(p => p !== cur));
  let lastErr = null;
  for (let i = 0; i < order.length; i++) {
    const p = order[i];
    const cfg = { provider: p, baseUrl: AI_PRESETS[p].baseUrl, model: aiGetModel(p), key: aiGetKey(p) };
    if (!cfg.key) continue;
    if (i > 0) {
      if (opts.onReset) opts.onReset();
      toast("AI 主通道不可用，已自动切换 " + AI_PRESETS[p].name);
    }
    const r = await callLLMOnce(cfg, messages, opts);
    if (!r.error) return r;
    lastErr = r;
  }
  return lastErr;
}
function findQById(id) {
  for (const sub of ["economy", "business"]) {
    const s = DATA.questions[sub]; if (!s) continue;
    for (const ch of s.chapters) { if (!ch.questions) continue; const q = ch.questions.find(x => x.id === id); if (q) return q; }
  }
  return null;
}
function qCtxOf(q) {
  if (!q) return { stem: "", options: [], answer: [], explanation: "", type: "single" };
  let ans = q.answer;
  if (typeof ans === "string") ans = ans.split("、").filter(Boolean);
  if (!Array.isArray(ans)) ans = [];
  return { stem: q.stem, options: q.options || [], answer: ans, explanation: q.explanation || "", type: q.type || "single", ai_explain: q.ai_explain || null, mnemonic: q.mnemonic || null, pitfall: q.pitfall || null };
}
function aiBoxShell(box, title) {
  box.innerHTML = `<div class="ai-card"><div class="ai-head">${title} <span class="ai-badge" id="aiBadge"></span></div><div class="ai-body" id="aiBody"></div></div>`;
  return box.querySelector("#aiBody");
}
function aiLoading(body) { body.innerHTML = `<div class="ai-loading"><span class="spin"></span> AI 正在思考…</div>`; }
function aiErr(body, e) {
  const hints = { nokey: "未配置 API Key：去「设置 → AI 讲解」粘贴对应平台的 Key。", net: "网络/CORS 失败：多为 Key 无效或浏览器拦截，请检查 Key。", http: `接口返回 ${e.status}：${e.msg || ""}`, parse: "返回内容无法解析。", json: "AI 未按要求返回 JSON，已按原文展示。", empty: "AI 返回为空。", timeout: "请求超时（90 秒），已自动尝试备用通道；若仍失败请稍后再试。" };
  body.innerHTML = `<div class="ai-err">⚠️ ${hints[e.error] || "调用失败"}</div>` + (e.content ? `<div class="ai-raw">${esc(e.content)}</div>` : "");
}
function aiExplainBtn(qid, force) {
  const box = document.getElementById("aiResult"); if (!box) return;
  window.currentAIQid = qid;
  const ctx = qCtxOf(findQById(qid) || {});
  const body = aiBoxShell(box, "🤖 AI 精讲（大白话+口诀）");
  if (!force && (ctx.ai_explain || ctx.mnemonic)) {
    renderExplainResult(body, { explain: ctx.ai_explain, mnemonic: ctx.mnemonic, pitfall: ctx.pitfall }, true, qid);
    return;
  }
  aiLoading(body);
  const optText = (ctx.options || []).map(o => "  " + o).join("\n");
  const user = `【题目】${ctx.stem}\n【选项】\n${optText}\n【标准答案】${ctx.answer.join("、")}\n【官方解析】${ctx.explanation || "（无）"}\n\n请作为老师严格核验：用大白话+一个生活例子讲透考点，并编一句口诀。\n若你认为上方【标准答案】有误，请在 sourceWrong 填 true，并给出 correctAnswer（如 "A" 或 "AC"）和 correctOptions（与原选项同格式数组）；且此时大白话（explain）必须**以「正确答案应为：X」开头**，先说清修正成什么再展开讲解；若正确则 sourceWrong 填 false。\n只返回 JSON：{"explain":"...","mnemonic":"...","pitfall":"...","sourceWrong":false,"correctAnswer":"","correctOptions":null}。`;
  callLLM([{ role: "system", content: AI_TEACHER_SYS }, { role: "user", content: user }], {
    json: true,
    onToken: (t, full) => { body.innerHTML = `<div class="ai-stream">${esc(full)}</div>`; },
    onReset: () => { body.innerHTML = `<div class="ai-loading"><span class="spin"></span> 切换备用通道重试…</div>`; }
  }).then(r => {
    if (r.error) { aiErr(body, r); return; }
    renderExplainResult(body, r.content, false, qid);
    saveCorrection(qid, r.content);
    if (r.content && r.content.sourceWrong) toast('⚠️ 已用 AI 解析修正本题答案（本机已存，可推送到题库）');
    else toast('已用 AI 解析补全本题');
  });
}
function renderExplainResult(body, d, baked, qid) {
  const corrected = d && d.sourceWrong;
  const badge = body.parentElement.querySelector("#aiBadge");
  if (badge) badge.innerHTML = corrected ? `<span class="ai-badge" style="background:var(--red)">已修正答案</span>` : (baked ? `<span class="ai-badge ok">离线缓存</span>` : `<span class="ai-badge ok">已生成</span>`);
  // 修正答案高亮区块：AI 判定原答案有误时，固定展示"修正成什么"（不依赖大白话是否提及）
  const fixBlock = (() => {
    if (!corrected) return '';
    let ans = [];
    if (d.correctAnswer) ans = normAnswer(d.correctAnswer);
    else if (state.corrections[qid] && state.corrections[qid].answer) ans = normAnswer(state.corrections[qid].answer);
    if (!ans.length) return `<div class="ai-fix"><b>⚠️ 已判定原答案有误，但未提供新答案</b> —— 建议点「🔄 重新生成」再试。</div>`;
    let optTxt = '';
    if (Array.isArray(d.correctOptions) && d.correctOptions.length >= 2) {
      optTxt = d.correctOptions.map(o => esc(o)).join('<br>');
    } else {
      const src = findQById(qid);
      if (src && src.options) {
        optTxt = ans.map(a => {
          const o = src.options.find(x => String(x || '').trim().toUpperCase().indexOf(a) === 0);
          return o ? esc(o) : a;
        }).join('<br>');
      }
    }
    return `<div class="ai-fix"><b>✅ 修正后答案：${esc(ans.join('、'))}</b>${optTxt ? `<div class="ai-fix-opts">${optTxt}</div>` : ''}</div>`;
  })();
  body.innerHTML = `
    ${fixBlock}
    ${d.explain ? `<div class="ai-sec"><b>📘 大白话</b><p>${esc(d.explain)}</p></div>` : ""}
    ${d.mnemonic ? `<div class="ai-sec"><b>🔑 记忆口诀</b><p class="mnem">${esc(d.mnemonic)}</p></div>` : ""}
    ${d.pitfall ? `<div class="ai-sec"><b>⚠️ 易错提醒</b><p>${esc(d.pitfall)}</p></div>` : ""}
    <div class="ai-foot">
      <button class="btn ghost" onclick="aiExplainBtn(currentAIQid, true)">🔄 重新生成</button>
      ${corrected ? `<button class="btn" onclick="pushOnePatch('${qid}')">📤 推送此题订正到题库</button>` : ''}
    </div>`;
}
function aiDiagnoseBtn(qid) {
  const w = state.wrong.find(x => x.qid === qid); if (!w) return;
  const box = document.getElementById("aiResult_" + qid); if (!box) return;
  const body = aiBoxShell(box, "🩺 AI 诊断（你为什么错）");
  if (!w.yourWrong) { body.innerHTML = `<div class="ai-err">这道题没有记录你的作答，无法诊断。可先点「重做」再诊断。</div>`; return; }
  aiLoading(body);
  const optText = (w.options || []).map(o => "  " + o).join("\n");
  const user = `【题目】${w.stem}\n【选项】\n${optText}\n【你选了】${w.yourWrong}（这是错的）\n【正确答案】${w.answer}\n\n请像老师一样，用大白话分三点说明：① 我为什么会选错（常见误区是什么）；② 正确答案为什么对；③ 以后怎么避开这个坑。简洁、直击痛点。`;
  callLLM([{ role: "system", content: AI_TEACHER_SYS }, { role: "user", content: user }], {
    temperature: 0.5,
    onToken: (t, full) => { body.innerHTML = `<div class="ai-sec"><p>${esc(full)}</p></div>`; },
    onReset: () => { body.innerHTML = `<div class="ai-loading"><span class="spin"></span> 切换备用通道重试…</div>`; }
  }).then(r => {
    if (r.error) { aiErr(body, r); return; }
    const badge = body.parentElement.querySelector("#aiBadge");
    if (badge) badge.innerHTML = `<span class="ai-badge ok">已诊断</span>`;
    body.innerHTML = `<div class="ai-sec"><p>${esc(r.content)}</p></div><div class="ai-foot"><button class="btn ghost" onclick="aiDiagnoseBtn('${qid}')">🔄 重新诊断</button></div>`;
  });
}
function aiSimilarBtn(qid) {
  const box = document.getElementById("aiResult") || document.getElementById("aiResult_" + qid);
  if (!box) return;
  const src = findQById(qid) || (state.wrong.find(x => x.qid === qid)) || {};
  const ctx = qCtxOf(src);
  const body = aiBoxShell(box, "🎯 举一反三（AI 出题）");
  aiLoading(body);
  const optText = (ctx.options || []).map(o => "  " + o).join("\n");
  const user = `基于下面这道真题的考点，出一道新的、不重复的同类练习题（题型可同可不同）。\n【原题】${ctx.stem}\n【原选项】${optText}\n【原答案】${ctx.answer.join("、")}\n\n返回 JSON：{"type":"single或multiple","stem":"题干","options":["A ...","B ...","C ...","D ..."],"answer":["A"],"explanation":"简短解析"}。只返回 JSON，选项必须以 A/B/C/D 开头。`;
  callLLM([{ role: "system", content: AI_TEACHER_SYS }, { role: "user", content: user }], {
    json: true,
    onToken: (t, full) => { body.innerHTML = `<div class="ai-stream">${esc(full)}</div>`; },
    onReset: () => { body.innerHTML = `<div class="ai-loading"><span class="spin"></span> 切换备用通道重试…</div>`; }
  }).then(r => {
    if (r.error) { aiErr(body, r); return; }
    const d = r.content;
    if (!d || !Array.isArray(d.options)) { aiErr(body, { error: "json", content: (typeof d === "string" ? d : JSON.stringify(d)) }); return; }
    const badge = body.parentElement.querySelector("#aiBadge");
    if (badge) badge.innerHTML = `<span class="ai-badge ok">已出题</span>`;
    window._similar = window._similar || {};
    window._similar[qid] = d;
    renderSimilarQuiz(body, d, qid);
  });
}
function renderSimilarQuiz(body, data, qid) {
  const opts = optHtml(data.options || [], data.type);
  body.innerHTML = `<div class="q"><div class="qtype">${typeBadge(data.type)}</div><div class="stem">${esc(data.stem)}</div>${opts}<button class="btn g" id="simSubmit" disabled>提交</button><div class="explain" id="simExpl"></div></div>
    <div class="ai-foot">
      <button class="btn ghost" onclick="aiSimilarBtn('${qid}')">🔄 换一道</button>
      <button class="btn" onclick="replaceOriginal('${qid}')">📥 用此题替换原题</button>
      <button class="btn ghost" onclick="pushOnePatch('${qid}')">📤 推送此题到题库</button>
    </div>`;
  let ssel = new Set();
  const root = body;
  root.querySelectorAll(".opt").forEach(b => b.onclick = () => {
    if (root.querySelector("#simExpl").classList.contains("show")) return;
    if (!isMulti(data.type)) { root.querySelectorAll(".opt").forEach(x => x.classList.remove("sel")); b.classList.add("sel"); ssel = new Set([+b.dataset.i]); root.querySelector("#simSubmit").disabled = false; }
    else { b.classList.toggle("sel"); if (b.classList.contains("sel")) ssel.add(+b.dataset.i); else ssel.delete(+b.dataset.i); root.querySelector("#simSubmit").disabled = ssel.size === 0; }
    root.querySelector("#simSubmit").textContent = submitLabel(data.type, ssel.size, "提交");
  });
  root.querySelector("#simSubmit").onclick = () => {
    const correct = multiPass(data, [...ssel].map(i => data.options[i][0]));
    root.querySelectorAll(".opt").forEach((b, i) => { const L = data.options[i][0]; if (data.answer.includes(L)) b.classList.add("correct"); else if (ssel.has(i)) b.classList.add("wrong"); else b.classList.add("dim"); b.disabled = true; });
    const ex = root.querySelector("#simExpl"); ex.innerHTML = `<b>答案：</b>${normAnswer(data.answer).join("、")}　|　<b>解析：</b>${esc(data.explanation || "")}`; ex.classList.add("show"); root.querySelector("#simSubmit").style.display = "none";
  };
}
/* 用举一反三生成的新题直接替换原题（写入本地 corrections 覆盖层，可选推送题库） */
function replaceOriginal(qid) {
  const d = (window._similar || {})[qid];
  if (!d || !Array.isArray(d.options)) { toast('请先生成举一反三题目'); return; }
  const ans = Array.isArray(d.answer) ? d.answer : [d.answer];
  const patch = { type: d.type || 'single', stem: d.stem, options: d.options, answer: ans, explanation: d.explanation || '', corrected: true, ts: new Date().toISOString() };
  state.corrections[qid] = Object.assign(state.corrections[qid] || {}, patch);
  saveCorrections();
  toast('已用新题替换原题（本机生效，可推送到题库）');
}
window.replaceOriginal = replaceOriginal;
function renderAISettings() {
  const p = aiCfg().provider;
  const opts = Object.keys(AI_PRESETS).map(k => `<option value="${k}" ${k === p ? "selected" : ""}>${AI_PRESETS[k].name}</option>`).join("");
  return `<div class="card">
    <h2>🤖 AI 讲解（浏览器直连大模型）</h2>
    <p class="muted">密钥仅存本机浏览器（localStorage），<b>不会</b>随 GitHub 备份上传。支持 智谱 / 硅基流动 / Agnes 直连，慢或连不上时自动切换备用通道。</p>
    <label>默认模型</label>
    <select id="aiProv">${opts}</select>
    <label>API Key（对应上面选中的模型）</label>
    <input id="aiKey" type="password" placeholder="粘贴对应平台的 Key（Agnes 免费，可留空试）">
    <p class="muted" id="aiKeyHint"></p>
    <label>自定义模型名（可选，留空用默认）</label>
    <input id="aiModel" placeholder="如 glm-4.6v / deepseek-ai/DeepSeek-V4-Flash">
    <label>AI CORS 代理地址（可选，留空=直连）</label>
    <input id="aiProxy" placeholder="如 https://proxy.hellohopo.dpdns.org/ （填了走 代理?url=目标）" value="${esc(state.settings.aiProxy || '')}">
    <p class="muted">海外接口（如 Agnes）国内直连不稳时，填你自己的 CORS 代理可显著改善；国内接口（智谱/硅基流动）直连即可，可不填。</p>
    <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn" onclick="saveAISet()">保存</button>
      <button class="btn g" onclick="testAICall()">测试连接</button>
    </div>
  </div>`;
}
function loadAIKeyInput() {
  const pv = document.getElementById("aiProv"); if (!pv) return;
  const p = pv.value;
  const k = document.getElementById("aiKey"), m = document.getElementById("aiModel"), h = document.getElementById("aiKeyHint");
  if (k) k.value = aiGetKey(p);
  if (m) m.value = aiGetModel(p);
  if (h) { const hint = { zhipu: "智谱开放平台 Key（{id}.{secret} 格式，open.bigmodel.cn）", siliconflow: "硅基流动 Key 以 sk- 开头", agnes: "Agnes 免费 Key（apihub 申请），也可留空" }; h.textContent = hint[p] || ""; }
}
window.saveAISet = function () {
  const pv = document.getElementById("aiProv"); if (!pv) return;
  const p = pv.value;
  state.settings.aiProvider = p;
  state.settings.aiProxy = (document.getElementById("aiProxy").value || "").trim();
  localStorage.setItem(aiStore(p), (document.getElementById("aiKey").value || "").trim());
  localStorage.setItem(aiModelStore(p), (document.getElementById("aiModel").value || "").trim());
  saveSettings();
  toast("AI 设置已保存（Key 仅存本机）");
};
window.testAICall = function () {
  toast("正在测试连接…");
  callLLM([{ role: "user", content: "回复两个字：可用" }]).then(r => {
    if (r.error) toast("测试失败：" + (r.error === "nokey" ? "未填 Key" : r.error));
    else toast("AI 连接成功 ✅");
  });
};
window.aiExplainBtn = aiExplainBtn;
window.aiDiagnoseBtn = aiDiagnoseBtn;
window.aiSimilarBtn = aiSimilarBtn;
window.loadAIKeyInput = loadAIKeyInput;
window.findQById = findQById;
window.clearCorrections = clearCorrections;
window.resumeQuiz = resumeQuiz;
window.discardSession = discardSession;

/* ---------------- 启动 ---------------- */
(async function init() {
  try { await loadData(); }
  catch (err) { app.innerHTML = `<div class="card empty">⚠️ 数据加载失败。<br>请用本地服务器访问（如 <code>python -m http.server</code>），或直接部署到 GitHub Pages，<br>不能用 file:// 直接打开。</div>`; return; }
  await loadState();
  migrateWrong();
  auditWrongMulti();        // 存量多选错题按新规则（≥50%）重判，应判对的自动恢复
  auditWrongByCorrection(); // 答案被订正成你当初作答的"冤案"错题自动恢复
  validateSession(false);   // 启动即自愈：清理上次遗留的孤儿会话
  router();
})();
