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
  state.progress = await dbGet('progress') || { done: {}, streak: 0, lastStudy: '' };
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
async function loadData() {
  // 版本号破坏缓存：data/*.json 带 ?v，确保部署后浏览器拉到最新 app.js/plan.json/questions.json
  const v = (document.querySelector('meta[name="app-version"]') || {}).content || '';
  const qs = v ? ('?v=' + v) : '';
  const [q, p, n, pat] = await Promise.all([
    fetch('data/questions.json' + qs).then(r => r.json()),
    fetch('data/plan.json' + qs).then(r => r.json()),
    fetch('data/notes.json' + qs).then(r => r.json()),
    fetch('data/patches.json' + qs).then(r => r.json()).catch(() => ({}))
  ]);
  DATA.questions = q; DATA.plan = p; DATA.notes = n; DATA.patches = pat || {};
}
function findChapter(subject, cid) {
  const sub = DATA.questions[subject];
  return sub ? sub.chapters.find(c => c.id === cid) : null;
}

/* ---------------- 修正覆盖层（repo patches + 本地 corrections） ---------------- */
function applyCorrections(q) {
  if (!q || !q.id) return q;
  let out = q;
  // 1) 官方订正库（patches.json，站点启动加载，对所有人生效）
  if (DATA.patches && DATA.patches[q.id]) {
    const p = DATA.patches[q.id];
    out = Object.assign({}, out, {
      stem: p.stem != null ? p.stem : out.stem,
      type: p.type != null ? p.type : out.type,
      options: p.options != null ? p.options : out.options,
      answer: p.answer != null ? p.answer : out.answer,
      explanation: p.explanation != null ? p.explanation : out.explanation,
      _patched: !!p.corrected
    });
  }
  // 2) 本地个人订正（覆盖层，离线可用，优先级最高）
  if (state.settings.aiCorrect === false) return out;
  const c = state.corrections[q.id];
  if (!c) return out;
  return Object.assign({}, out, {
    stem: c.stem != null ? c.stem : out.stem,
    type: c.type != null ? c.type : out.type,
    explanation: c.explanation != null ? c.explanation : out.explanation,
    answer: c.answer != null ? c.answer : out.answer,
    options: c.options != null ? c.options : out.options,
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
    if (d.correctAnswer) c.answer = d.correctAnswer;
    if (d.correctOptions) c.options = d.correctOptions;
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

/* ---------------- 答题会话（进度续接） ---------------- */
function sessionFromQueue(queue, title, fromWrong, doneKeys, marksDone) {
  state.session = {
    active: true,
    items: queue.map(it => ({ subject: it.subject, chapterId: it.chapterId, qid: it.q.id })),
    idx: 0, correct: 0, wrong: 0, fromWrong: !!fromWrong, title,
    ts: new Date().toISOString(), doneKeys: doneKeys || [], marksDone: !!marksDone
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
  quiz = { queue, idx: s.idx, correct: s.correct, wrong: s.wrong, title: s.title, fromWrong: s.fromWrong, _doneKeys: s.doneKeys, _marksDoneWhenComplete: s.marksDone };
  return quiz;
}
function resumeQuiz() { const q = quizFromSession(); if (q) renderQuiz(); else router(); }
function discardSession() { state.session = null; saveSession(); toast('已放弃上次进度'); router(); }

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

/* ---------------- GitHub 同步 ---------------- */
function b64encode(str) { return btoa(unescape(encodeURIComponent(str))); }
function b64decode(str) { return decodeURIComponent(escape(atob(str))); }
async function githubSave() {
  const s = state.settings;
  if (!s.token || !s.repo) { toast('请先在设置填写 Token 和仓库'); return; }
  const payload = { wrong: state.wrong, progress: state.progress, corrections: state.corrections, updatedAt: new Date().toISOString() };
  const path = s.path || 'data/user-data.json';
  const url = `https://api.github.com/repos/${s.repo}/contents/${path}`;
  let sha;
  try { const r = await fetch(url, { headers: { Authorization: 'token ' + s.token } }); if (r.ok) sha = (await r.json()).sha; } catch (e) {}
  const body = { message: 'sync econ study data', content: b64encode(JSON.stringify(payload, null, 2)), ...(sha ? { sha } : {}) };
  const r = await fetch(url, { method: 'PUT', headers: { Authorization: 'token ' + s.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (r.ok) { state.settings.lastSync = new Date().toISOString(); await saveSettings(); toast('已同步到 GitHub ✅'); }
  else toast('同步失败：' + r.status + '（检查 Token/仓库/路径）');
}
async function githubLoad() {
  const s = state.settings;
  if (!s.token || !s.repo) { toast('请先填写 Token 和仓库'); return; }
  const path = s.path || 'data/user-data.json';
  const url = `https://api.github.com/repos/${s.repo}/contents/${path}`;
  try {
    const r = await fetch(url, { headers: { Authorization: 'token ' + s.token } });
    if (!r.ok) { toast('拉取失败：' + r.status); return; }
    const j = await r.json();
    const payload = JSON.parse(b64decode(j.content));
    state.wrong = mergeWrong(payload.wrong, state.wrong);
    state.progress = mergeProgress(payload.progress, state.progress);
    state.corrections = mergeCorrections(payload.corrections, state.corrections);
    await saveWrong(); await saveProgress(); await saveCorrections();
    toast('已从 GitHub 拉取并合并 ✅（不会覆盖本机新数据）'); router();
  } catch (e) { toast('拉取失败：' + e.message); }
}
function scheduleSync() {
  if (!state.settings.auto || !state.settings.token) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(githubSave, 15000);
}
/* ---------------- 题库订正推送（patches.json 覆盖层） ---------------- */
async function pushPatchesToRepo(extra) {
  const s = state.settings;
  if (!s.token || !s.repo) { toast('请先在设置填写 GitHub Token 与仓库'); return; }
  const path = 'data/patches.json';
  const url = `https://api.github.com/repos/${s.repo}/contents/${path}`;
  let sha, cur = {};
  try {
    const r = await fetch(url, { headers: { Authorization: 'token ' + s.token } });
    if (r.ok) { const j = await r.json(); sha = j.sha; try { cur = JSON.parse(b64decode(j.content)); } catch (e) { cur = {}; } }
  } catch (e) { /* 文件可能还不存在，忽略 */ }
  Object.assign(cur, extra);
  const body = { message: 'add question patches', content: b64encode(JSON.stringify(cur, null, 2)), ...(sha ? { sha } : {}) };
  try {
    const r = await fetch(url, { method: 'PUT', headers: { Authorization: 'token ' + s.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.ok) toast('已推送到题库 ✅（下次打开站点即生效）');
    else toast('推送失败：' + r.status + '（检查 Token/仓库）');
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
  const route = (location.hash || '#/today').replace('#/', '').split('?')[0];
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
  if (state.progress.dayDone && state.progress.dayDone[td] && state.progress.dayDone[td][subject]) return true;
  const done = state.progress.done || {};
  for (const k in done) if (k.indexOf(subject + ':') === 0 && done[k] === td) return true;
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
  return `<div class="card">
    <span class="pill ${subject === 'business' ? 'g' : ''}">${label}</span>
    <h3>${esc(ch.title)}</h3>
    ${note}
    <div style="margin-top:12px">${btn}</div>
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
function renderQuiz() {
  if (quiz.idx >= quiz.queue.length) { renderQuizSummary(); return; }
  sel = new Set();
  const { q } = quiz.queue[quiz.idx];
  const opts = q.options.map((o, i) => `<button class="opt" data-i="${i}">${esc(o)}</button>`).join('');
  const corrBadge = q._corrected ? `<span class="pill a">⚠️AI修正答案</span>` : '';
  app.innerHTML = `<div class="card">
    <div class="row"><span class="muted">${esc(quiz.title)}</span><span class="muted">${quiz.idx + 1}/${quiz.queue.length}</span></div>
    <div class="q"><div class="stem">${esc(q.stem)}</div>${opts}
      <button class="btn g" id="submitBtn" disabled>提交答案</button>
      <div class="explain" id="explain"></div>
      <div id="aiBox" style="margin-top:10px"></div>
    </div>
    <div id="nav" style="margin-top:10px"></div>
  </div>`;
  app.querySelectorAll('.opt').forEach(b => b.onclick = () => onPick(b, q));
  document.getElementById('submitBtn').onclick = () => onSubmit(q);
}
function onPick(b, q) {
  if (document.getElementById('explain').classList.contains('show')) return;
  const submitBtn = document.getElementById('submitBtn');
  if (q.type === 'single') {
    app.querySelectorAll('.opt').forEach(x => x.classList.remove('sel'));
    b.classList.add('sel'); sel = new Set([+b.dataset.i]); submitBtn.disabled = false;
  } else {
    b.classList.toggle('sel');
    if (b.classList.contains('sel')) sel.add(+b.dataset.i); else sel.delete(+b.dataset.i);
    submitBtn.disabled = sel.size === 0;
  }
}
function onSubmit(q) {
  const correct = [...sel].map(i => q.options[i][0]).sort().join('') === q.answer.slice().sort().join('');
  const explain = document.getElementById('explain');
  app.querySelectorAll('.opt').forEach((b, i) => {
    const letter = q.options[i][0];
    if (q.answer.includes(letter)) b.classList.add('correct');
    else if (sel.has(i)) b.classList.add('wrong');
    else b.classList.add('dim');
    b.disabled = true;
  });
  explain.innerHTML = `<b>答案：</b>${q.answer.join('、')}　|　<b>解析：</b>${esc(q.explanation)}`;
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
      addWrong({ qid: q.id, subject: item.subject, chapterId: item.chapterId, chapterTitle: item.chapterTitle, stem: q.stem, options: q.options, type: q.type, explanation: q.explanation, answer: q.answer.join('、'), yourWrong: [...sel].map(i => q.options[i][0]).join('、') });
    }
  }
  if (state.session) { state.session.correct = quiz.correct; state.session.wrong = quiz.wrong; saveSession(); }
  document.getElementById('nav').innerHTML = `<button class="btn" onclick="quizNext()">${quiz.idx + 1 < quiz.queue.length ? '下一题 →' : '查看结果'}</button>`;
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
  if (!state.wrong.length) { app.innerHTML = `<div class="card empty">🎉 暂无错题，继续保持！</div>`; return; }
  const dueList = state.wrong.filter(isDue);
  const header = `<div class="card"><div class="row"><h2>错题库（${state.wrong.length}）</h2>
      <button class="btn ghost" onclick="clearWrong()">清空</button></div>
    <p class="muted">长期保存 · 按艾宾浩斯记忆曲线自动排程。今日待复习 <b style="color:var(--red)">${dueList.length}</b> 题。AI 修正过的题会标「AI已修正」。</p>
    <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn" onclick="startWrongDue()">📌 复习待做（${dueList.length}）</button>
      <button class="btn g" onclick="startWrongAll()">🔁 全部重做（${state.wrong.length}）</button>
    </div></div>`;
  const items = state.wrong.slice().reverse().map(w => {
    const corr = state.corrections[w.qid];
    const canRedo = Array.isArray(w.options) && w.options.length >= 2;
    const due = isDue(w);
    const matured = (w.box || 0) >= EB_MAX;
    const status = matured ? `已巩固 · 下次 ${w.due || '—'}` : (due ? '⏰ 今日待复习' : `排到 ${w.due || '—'}`);
    const dispAnswer = (corr && corr.answer) ? corr.answer : w.answer;
    const dispExpl = (corr && corr.explanation) ? corr.explanation : w.explanation;
    const corrBadge = (corr && corr.corrected) ? ` <span class="pill a">AI已修正</span>` : '';
    return `
    <div class="q">
      <div class="meta">${esc(w.chapterTitle || '')}　|　答错 ${w.count || 1} 次　|　${status}　|　你的答案：${w.yourWrong || '—'}</div>
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
window.rmWrong = function (qid) { removeWrong(qid); renderWrong(); };
window.clearWrong = function () { if (confirm('确定清空全部错题？')) { state.wrong = []; saveWrong(); renderWrong(); } };

function redoWrong(qid) {
  const w = state.wrong.find(x => x.qid === qid);
  if (!w) { renderWrong(); return; }
  const corr = state.corrections[w.qid];
  const opts = (corr && corr.options) ? corr.options : (w.options || []);
  const ans = (corr && corr.answer) ? corr.answer : (w.answer || '');
  const q = shuffleOpts({ id: qid, type: w.type || 'single', stem: w.stem, options: opts, answer: ans.split('、').filter(Boolean), explanation: w.explanation || '' });
  app.innerHTML = `<div class="card"><div class="row"><span class="muted">重做 · ${esc(w.chapterTitle || '')}</span><span class="muted">❓ ${state.wrong.indexOf(w) + 1}/${state.wrong.length}</span></div>
    <div class="q"><div class="stem">${esc(q.stem)}</div>
    ${q.options.map((o, i) => `<button class="opt" data-i="${i}">${esc(o)}</button>`).join('')}
    <button class="btn g" id="redoSubmit" disabled>提交</button>
    <div class="explain" id="redoExplain"></div></div>
    <div id="redoNav" style="margin-top:10px"></div></div>`;
  let rsel = new Set();
  const optEls = app.querySelectorAll('.opt');
  optEls.forEach(b => b.onclick = () => {
    if (document.getElementById('redoExplain').classList.contains('show')) return;
    if (q.type === 'single') {
      optEls.forEach(x => x.classList.remove('sel'));
      b.classList.add('sel'); rsel = new Set([+b.dataset.i]);
      document.getElementById('redoSubmit').disabled = false;
    } else {
      b.classList.toggle('sel');
      if (b.classList.contains('sel')) rsel.add(+b.dataset.i); else rsel.delete(+b.dataset.i);
      document.getElementById('redoSubmit').disabled = rsel.size === 0;
    }
  });
  document.getElementById('redoSubmit').onclick = () => {
    const correct = [...rsel].map(i => q.options[i][0]).sort().join('') === q.answer.slice().sort().join('');
    const ex = document.getElementById('redoExplain');
    optEls.forEach((b, i) => {
      const letter = q.options[i][0];
      if (q.answer.includes(letter)) b.classList.add('correct');
      else if (rsel.has(i)) b.classList.add('wrong');
      else b.classList.add('dim');
      b.disabled = true;
    });
    ex.innerHTML = `<b>答案：</b>${q.answer.join('、')}　|　<b>解析：</b>${esc(q.explanation)}`;
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
function renderNotes() {
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
      const note = d.note ? `<a class="btn ghost" style="padding:4px 10px;font-size:12px" href="#/notes">看笔记</a>` : '';
      const done = (d.economy && state.progress.done['economy:' + d.economy.chapter]) && (d.business && state.progress.done['business:' + d.business.chapter]);
      const cls = d.date === today ? 'a' : (done ? 'g' : '');
      const status = d.date === today ? '今天' : (d.date < today ? (done ? '已完成' : '待补学') : '待开始');
      rows += `<div class="plan-row"><span class="pdate">${d.date}</span><span class="pill ${cls}">${status}</span>
        <span class="ptitle">${eco}　|　${bus} ${note}</span></div>`;
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
  app.innerHTML = `<div class="card">
    <h2>设置 · GitHub 云同步</h2>
    <p class="muted">错题、进度、AI 修正默认存浏览器本地（IndexedDB）。填写以下信息后，数据会自动备份到你指定的 GitHub 仓库（<b>data/user-data.json</b>）。</p>
    <label>GitHub Token（建议用 fine-grained，仅授权本题库仓库的 Contents 读写）</label>
    <input id="tok" type="password" placeholder="ghp_xxx 或 github_pat_xxx" value="${s.token || ''}">
    <label>仓库（格式 owner/repo）</label>
    <input id="repo" placeholder="yourname/econ-questions" value="${s.repo || ''}">
    <label>分支</label>
    <input id="branch" placeholder="main" value="${s.branch || 'main'}">
    <label>数据文件路径</label>
    <input id="path" placeholder="data/user-data.json" value="${s.path || 'data/user-data.json'}">
    <label><input type="checkbox" id="auto" ${s.auto ? 'checked' : ''}> 自动同步（每次变动 15 秒后静默备份）</label>
    <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn" onclick="saveSet()">保存设置</button>
      <button class="btn g" onclick="ghSave()">立即同步到 GitHub</button>
      <button class="btn ghost" onclick="ghLoad()">从 GitHub 拉取</button>
    </div>
    <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn ghost" onclick="exportBackup()">⬇ 导出备份（下载JSON）</button>
      <label class="btn ghost" style="cursor:pointer;margin:0">⬆ 导入备份<input id="imp" type="file" accept="application/json" style="display:none" onchange="importBackup(this)"></label>
    </div>
    <p class="muted" style="margin-top:8px">⚠️ 若你的网络无法访问 api.github.com，GitHub 云同步会失败；请用「导出/导入备份」做本地备份，效果一样且不依赖网络。</p>
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
  state.settings.token = document.getElementById('tok').value.trim();
  state.settings.repo = document.getElementById('repo').value.trim();
  state.settings.branch = document.getElementById('branch').value.trim() || 'main';
  state.settings.path = document.getElementById('path').value.trim() || 'data/user-data.json';
  state.settings.auto = document.getElementById('auto').checked;
  state.settings.aiCorrect = document.getElementById('aic').checked;
  await saveSettings();
  toast('设置已保存');
};
window.ghSave = githubSave;
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
  qwen35:     { name: "硅基流动 Qwen3.5-35B-A3B（直连✅·轻快）", baseUrl: "https://api.siliconflow.cn/v1/chat/completions", model: "Qwen/Qwen3.5-35B-A3B", key: "siliconflow" },
  siliconflow: { name: "硅基流动 DeepSeek-V4-Flash（直连✅）", baseUrl: "https://api.siliconflow.cn/v1/chat/completions", model: "deepseek-ai/DeepSeek-V4-Flash", key: "siliconflow" },
  agnes:      { name: "Agnes 2.0-Flash（免费·直连✅）", baseUrl: "https://apihub.agnes-ai.com/v1/chat/completions", model: "agnes-2.0-flash", key: "agnes" },
};
const AI_TEACHER_SYS = "你是中级经济师考试（经济基础+工商管理）的辅导老师，擅长用大白话和生活例子讲透考点，并编好记的口诀。面向只想稳过84分的考生，回答通俗、简洁、不啰嗦。";
function aiStore(p) { return "ej_" + p + "Key"; }
function aiModelStore(p) { return "ej_model_" + p; }
function aiGetKey(p) { return localStorage.getItem(aiStore(p)) || ""; }
function aiGetModel(p) { return localStorage.getItem(aiModelStore(p)) || AI_PRESETS[p].model; }
function aiCfg() {
  const p = (state.settings && state.settings.aiProvider && AI_PRESETS[state.settings.aiProvider]) ? state.settings.aiProvider : "qwen35";
  return { provider: p, baseUrl: AI_PRESETS[p].baseUrl, model: aiGetModel(p), key: aiGetKey(p) };
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
async function callLLM(messages, opts) {
  opts = opts || {};
  const cfg = aiCfg();
  if (!cfg.key) return { error: "nokey" };
  const body = { model: cfg.model, messages, temperature: (opts.temperature != null ? opts.temperature : 0.6), stream: false };
  let resp;
  try { resp = await fetch(cfg.baseUrl, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + cfg.key }, body: JSON.stringify(body) }); }
  catch (e) { return { error: "net", msg: String(e) }; }
  if (!resp.ok) { let t = ""; try { t = await resp.text(); } catch (_) {} return { error: "http", status: resp.status, msg: (t || "").slice(0, 300) }; }
  let j; try { j = await resp.json(); } catch (e) { return { error: "parse", msg: String(e) }; }
  const c = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (c == null) return { error: "empty", raw: j };
  if (opts.json) { const p2 = extractJSON(c); if (!p2) return { error: "json", content: c }; return { content: p2 }; }
  return { content: c };
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
  const hints = { nokey: "未配置 API Key：去「设置 → AI 讲解」粘贴对应平台的 Key。", net: "网络/CORS 失败：多为 Key 无效或浏览器拦截，请检查 Key。", http: `接口返回 ${e.status}：${e.msg || ""}`, parse: "返回内容无法解析。", json: "AI 未按要求返回 JSON，已按原文展示。", empty: "AI 返回为空。" };
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
  const user = `【题目】${ctx.stem}\n【选项】\n${optText}\n【标准答案】${ctx.answer.join("、")}\n【官方解析】${ctx.explanation || "（无）"}\n\n请作为老师严格核验：用大白话+一个生活例子讲透考点，并编一句口诀。\n若你认为上方【标准答案】有误，请在 sourceWrong 填 true，并给出 correctAnswer（如 "A" 或 "AC"）和 correctOptions（与原选项同格式数组）；若正确则 sourceWrong 填 false。\n只返回 JSON：{"explain":"...","mnemonic":"...","pitfall":"...","sourceWrong":false,"correctAnswer":"","correctOptions":null}。`;
  callLLM([{ role: "system", content: AI_TEACHER_SYS }, { role: "user", content: user }], { json: true }).then(r => {
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
  body.innerHTML = `
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
  callLLM([{ role: "system", content: AI_TEACHER_SYS }, { role: "user", content: user }], { temperature: 0.5 }).then(r => {
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
  callLLM([{ role: "system", content: AI_TEACHER_SYS }, { role: "user", content: user }], { json: true }).then(r => {
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
  const opts = (data.options || []).map((o, i) => `<button class="opt" data-i="${i}">${esc(o)}</button>`).join("");
  body.innerHTML = `<div class="q"><div class="stem">${esc(data.stem)}</div>${opts}<button class="btn g" id="simSubmit" disabled>提交</button><div class="explain" id="simExpl"></div></div>
    <div class="ai-foot">
      <button class="btn ghost" onclick="aiSimilarBtn('${qid}')">🔄 换一道</button>
      <button class="btn" onclick="replaceOriginal('${qid}')">📥 用此题替换原题</button>
      <button class="btn ghost" onclick="pushOnePatch('${qid}')">📤 推送此题到题库</button>
    </div>`;
  let ssel = new Set();
  const root = body;
  root.querySelectorAll(".opt").forEach(b => b.onclick = () => {
    if (root.querySelector("#simExpl").classList.contains("show")) return;
    if (data.type === "single") { root.querySelectorAll(".opt").forEach(x => x.classList.remove("sel")); b.classList.add("sel"); ssel = new Set([+b.dataset.i]); root.querySelector("#simSubmit").disabled = false; }
    else { b.classList.toggle("sel"); if (b.classList.contains("sel")) ssel.add(+b.dataset.i); else ssel.delete(+b.dataset.i); root.querySelector("#simSubmit").disabled = ssel.size === 0; }
  });
  root.querySelector("#simSubmit").onclick = () => {
    const correct = [...ssel].map(i => data.options[i][0]).sort().join("") === data.answer.slice().sort().join("");
    root.querySelectorAll(".opt").forEach((b, i) => { const L = data.options[i][0]; if (data.answer.includes(L)) b.classList.add("correct"); else if (ssel.has(i)) b.classList.add("wrong"); else b.classList.add("dim"); b.disabled = true; });
    const ex = root.querySelector("#simExpl"); ex.innerHTML = `<b>答案：</b>${data.answer.join("、")}　|　<b>解析：</b>${esc(data.explanation || "")}`; ex.classList.add("show"); root.querySelector("#simSubmit").style.display = "none";
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
    <p class="muted">密钥仅存本机浏览器（localStorage），<b>不会</b>随 GitHub 备份上传。支持 硅基流动 / Agnes 直连，无需代理。</p>
    <label>默认模型</label>
    <select id="aiProv">${opts}</select>
    <label>API Key（对应上面选中的模型）</label>
    <input id="aiKey" type="password" placeholder="粘贴对应平台的 Key（Agnes 免费，可留空试）">
    <p class="muted" id="aiKeyHint"></p>
    <label>自定义模型名（可选，留空用默认）</label>
    <input id="aiModel" placeholder="如 glm-4-flash / deepseek-ai/DeepSeek-V4-Flash">
    <p class="muted">Key 获取：硅基流动 siliconflow.cn ｜ Agnes apihub.agnes-ai.com</p>
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
  if (h) { const hint = { qwen35: "硅基流动 Key 以 sk- 开头", siliconflow: "硅基流动 Key 以 sk- 开头", agnes: "Agnes 免费 Key（apihub 申请），也可留空" }; h.textContent = hint[p] || ""; }
}
window.saveAISet = function () {
  const pv = document.getElementById("aiProv"); if (!pv) return;
  const p = pv.value;
  state.settings.aiProvider = p;
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
  router();
})();
