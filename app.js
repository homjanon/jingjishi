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
function dataSources(name){
  const raw = 'https://raw.githubusercontent.com/homjanon/jingjishi/main/data/' + name;
  return [
    'https://proxy.hellohopo.dpdns.org/?url=' + encodeURIComponent(raw),  // ① cors 代理主
    'https://cdn.jsdelivr.net/gh/homjanon/jingjishi@main/data/' + name,   // ② jsdelivr 兜底
    'data/' + name                                                         // ③ 同站兜底
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
  const v = (document.querySelector('meta[name="app-version"]') || {}).content || '';
  const qs = v ? ('?v=' + v) : '';
  const [q, p, n, pat] = await Promise.all([
    fetchJsonFallback('questions.json' + qs),
    fetchJsonFallback('plan.json' + qs),
    fetchJsonFallback('notes.json' + qs),
    fetchJsonFallback('patches.json' + qs).catch(() => ({}))
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
  return Object.assign({}, out, {
    stem: (typeof c.stem === 'string' && c.stem.trim()) ? c.stem : out.stem,
    type: c.type != null ? c.type : out.type,
    explanation: c.explanation != null ? c.explanation : out.explanation,
    answer: trustAns ? nAns : out.answer,
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

/* ---------------- 错题库 ---------------- */
/* 找案例材料题：在所属章内向前 6 题扫「案例（N）」材料题；本题自己就是材料题则返回 null */
function findCaseMaterial(subject, chapterId, qid) {
  const ch = findChapter(subject, chapterId);
  if (!ch || !ch.questions) return null;
  const qs = ch.questions;
  const i = qs.findIndex(x => x.id === qid);
  if (i < 0) return null;
  const isMat = s => /^案例\s*[（(]?[一二三四五六七八九十\d]/.test((s || '').trim()) || /案例[（(]?[一二三四五六七八九十\d]/.test((s || '').slice(0, 10));
  if (isMat(qs[i].stem)) return null;                       // 自己就是材料题，无需回看
  for (let k = i - 1; k >= 0 && i - k <= 6; k--) {
    if (isMat(qs[k].stem)) return qs[k];
  }
  return null;
}
/* 案例材料折叠区 HTML（列表 / 单题重做通用；无材料返回空串） */
function caseMaterialHtml(subject, chapterId, qid) {
  const m = findCaseMaterial(subject, chapterId, qid);
  if (!m) return '';
  const num = ((m.stem || '').match(/案例\s*[（(]?\s*([一二三四五六七八九十\d]+)/) || [])[1] || '';
  return `<details class="case-mat"><summary>📄 案例材料${num ? '（案例' + num + '）' : ''}</summary><div class="stem">${esc(m.stem)}</div></details>`;
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
  if (/^案例\s*[（(]?[一二三四五六七八九十\d]/.test(stem.trim()) || /案例[（(]?[一二三四五六七八九十\d]/.test(stem.slice(0, 10))) return false;
  const m = findCaseMaterial(w.subject, w.chapterId, w.qid);
  if (m) return /材料缺失|（材料|\(材料/.test(m.stem || '');
  // 找不到材料：题干以「该…为( )」开头（强指代前文、悬空引用）或含案例/主体引用词 → 视为无法作答
  return /^该[^，。]{0,12}[为是]\(/.test(stem.trim()) || /案例\s*[（(]?[一二三四五六七八九十\d]|根据上述|上述案例|该企业|该公司|该产品|该款/.test(stem);
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
  return { wrong: state.wrong, progress: state.progress, corrections: state.corrections, updatedAt: new Date().toISOString() };
}
/* 拉取成功后统一的合并落盘（两个平台共用） */
async function applyCloudPayload(payload, who) {
  state.wrong = mergeWrong(payload.wrong, state.wrong);
  state.progress = mergeProgress(payload.progress, state.progress);
  state.corrections = mergeCorrections(payload.corrections, state.corrections);
  await saveWrong(); await saveProgress(); await saveCorrections();
  validateSession(true);   // 另一台设备已有新进度，本机残留会话作废
  state.settings.lastSync = new Date().toISOString(); await saveSettings();
  toast(`已从 ${who} 拉取并合并 ✅（不会覆盖本机新数据）`); router();
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
    merged++;
  }
  if (!merged) { toast('Gitee 拉取失败：没有可读取的数据文件'); return; }
  await saveWrong(); await saveProgress(); await saveCorrections();
  validateSession(true);   // 另一台设备已有新进度，本机残留会话作废
  state.settings.lastSync = new Date().toISOString(); await saveSettings();
  toast(`已从 Gitee 合并 ${merged} 份快照 ✅（不会覆盖本机新数据）`); router();
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
function router() {
  const raw = (location.hash || '#/today').replace('#/', '');
  const _parts = raw.split('?');
  const route = _parts[0];
  const _q = {};
  if (_parts[1]) _parts[1].split('&').forEach(p => { const kv = p.split('='); if (kv[0]) _q[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || ''); });
  window._q = _q;
  document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('active', a.dataset.route === route));
  if (route === 'wrong') renderWrong();
  else if (route === 'notes') renderNotes();
  else if (route === 'plan') renderPlan();
  else if (route === 'progress') renderProgress();
  else if (route === 'settings') renderSettings();
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
  if (t.notStarted || t.finished) {
    app.innerHTML = banner + reviewCard;
  } else {
    app.innerHTML = banner + resume + chapterCard('economy', t.economy, '经济基础') + chapterCard('business', t.business, '工商管理') + reviewCard;
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
  quiz = {
    queue, idx: 0, correct: 0, wrong: 0,
    title: ch.title + `（第${f + 1}-${f + qs.length}题）`, fromWrong: false,
    _doneKeys: [subject + ':' + chapterId + (isSlice ? ('#' + f + '-' + t) : '')],
    _marksDoneWhenComplete: isSlice ? true : (t >= total)
  };
  sessionFromQueue(queue, quiz.title, false, quiz._doneKeys, quiz._marksDoneWhenComplete);
  renderQuiz();
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
  quiz = { queue, idx: 0, correct: 0, wrong: 0, title: '今日全部', fromWrong: false, _doneKeys: doneKeys, _marksDoneWhenComplete: true };
  sessionFromQueue(queue, '今日全部', false, doneKeys, true);
  renderQuiz();
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
  // 案例材料回看：若当前题属于某个案例组（前面 6 题内存在「案例（N）」材料题）→ 提供回到材料题
  const caseLink = (() => {
    const stem = q.stem || '';
    const selfIsCase = /^案例\s*[（(]?[一二三四五六七八九十\d]/.test(stem.trim()) || /案例\s*[（(]?[一二三四五六七八九十\d]/.test(stem);
    if (answered || selfIsCase) return '';
    for (let k = quiz.idx - 1; k >= 0 && k >= quiz.idx - 6; k--) {
      const pk = quiz.queue[k].q.stem || '';
      const isCaseHead = /^案例\s*[（(]?[一二三四五六七八九十\d]/.test(pk.trim()) || /案例\s*[（(]?[一二三四五六七八九十\d]/.test(pk);
      if (isCaseHead) {
        return `<a class="btn ghost" style="padding:4px 10px;font-size:12px;margin-left:8px" onclick="quizGo(${k})" title="回看本案例组的题干材料">📄 案例材料</a>`;
      }
    }
    return '';
  })();
  app.innerHTML = `<div class="card">
    <div class="row"><span class="muted">${esc(quiz.title)}</span><span class="muted">${subjectPill(subOf(quiz.queue[quiz.idx]))} ${quiz.idx + 1}/${quiz.queue.length}</span></div>
    <div class="q"><div class="qtype">${typeBadge(q.type)}${corrBadge}${caseLink}</div><div class="stem">${esc(q.stem)}</div>${opts}
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
    const corr = state.corrections[w.qid];
    const canRedo = Array.isArray(w.options) && w.options.length >= 2;
    const due = isDue(w);
    const matured = (w.box || 0) >= EB_MAX;
    const status = matured ? `已巩固 · 下次 ${w.due || '—'}` : (due ? '⏰ 今日待复习' : `排到 ${w.due || '—'}`);
    const dispAnswer = (corr && corr.answer) ? corr.answer : w.answer;
    const dispExpl = (corr && corr.explanation) ? corr.explanation : w.explanation;
    const corrBadge = (corr && corr.corrected) ? ` <span class="pill a">AI已修正</span>` : '';
    const unBadge = isUnanswerable(w) ? ` <span class="pill bad">⚠️ 无材料·无法作答</span>` : '';
    const subPill = subjectPill(subOf(w));
    return `
    <div class="q">
      <div class="meta"><label class="wselbox"><input type="checkbox" class="wsel" data-qid="${w.qid}" onchange="updateSelCount()"></label>${subPill}${esc(w.chapterTitle || '')}　|　答错 ${w.count || 1} 次　|　${status}　|　你的答案：${w.yourWrong || '—'}${unBadge}</div>
      ${caseMaterialHtml(w.subject, w.chapterId, w.qid)}
      <div class="stem">${esc(w.stem)}</div>
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
  const corr = state.corrections[w.qid];
  const opts = (corr && corr.options) ? corr.options : (w.options || []);
  const ans = (corr && corr.answer) ? corr.answer : (w.answer || '');
  const q = shuffleOpts({ id: qid, type: w.type || 'single', stem: w.stem, options: opts, answer: ans.split('、').filter(Boolean), explanation: w.explanation || '' });
  app.innerHTML = `<div class="card"><div class="row"><span class="muted">重做 · ${esc(w.chapterTitle || '')}</span><span class="muted">${subjectPill(subOf(w))} ❓ ${state.wrong.indexOf(w) + 1}/${state.wrong.length}</span></div>
    <div class="q"><div class="qtype">${typeBadge(q.type)}</div>${caseMaterialHtml(w.subject, w.chapterId, w.qid)}<div class="stem">${esc(q.stem)}</div>
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

function startWrongSession(list, title) {
  const items = list.filter(w => Array.isArray(w.options) && w.options.length >= 2).map(w => ({ subject: w.subject, chapterId: w.chapterId, qid: w.qid }));
  if (!items.length) { toast('没有可重做的题目（需含选项）'); renderWrong(); return; }
  const queue = items.map(it => {
    const q = findQById(it.qid);
    return { q: applyCorrections(q || {}), subject: it.subject, chapterId: it.chapterId, chapterTitle: (findChapter(it.subject, it.chapterId) || {}).title || '' };
  });
  shuffleArr(queue);
  quiz = { queue, idx: 0, correct: 0, wrong: 0, title, fromWrong: true };
  sessionFromQueue(queue, title, true, [], false);
  renderQuiz();
}
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
  const payload = { wrong: state.wrong, progress: state.progress, corrections: state.corrections, exportedAt: new Date().toISOString() };
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
    saveWrong(); saveProgress(); saveCorrections();
    validateSession(true);   // 导入后清掉本机残留会话（数据已来自另一台设备）
    toast(`已合并导入 ✅（错题 ${nW} 道 / 进度 ${nP} 条 / 订正 ${nC} 条，已与本机数据合并）`);
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
