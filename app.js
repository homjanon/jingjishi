/* 经济师自动化学习站 — 纯前端应用（vanilla JS，无需构建） */
const app = document.getElementById('app');
const DATA = { questions: null, plan: null, notes: null };
const state = { wrong: [], progress: {}, settings: {} };
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
}
async function saveWrong() { await dbSet('wrong', state.wrong); scheduleSync(); }
async function saveProgress() { await dbSet('progress', state.progress); scheduleSync(); }
async function saveSettings() { await dbSet('settings', state.settings); }

/* ---------------- 数据加载 ---------------- */
async function loadData() {
  const [q, p, n] = await Promise.all([
    fetch('data/questions.json').then(r => r.json()),
    fetch('data/plan.json').then(r => r.json()),
    fetch('data/notes.json').then(r => r.json())
  ]);
  DATA.questions = q; DATA.plan = p; DATA.notes = n;
}
function findChapter(subject, cid) {
  const sub = DATA.questions[subject];
  return sub ? sub.chapters.find(c => c.id === cid) : null;
}

/* ---------------- 日期 / 计划 ---------------- */
function localToday() { const d = new Date(); const off = d.getTimezoneOffset(); return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10); }
function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000); }
/* 艾宾浩斯记忆曲线间隔（天）：1→2→4→7→15→30，到 30 天后保持该节奏长期复习 */
const EB_INTERVALS = [1, 2, 4, 7, 15, 30];
const EB_MAX = EB_INTERVALS.length - 1;
function addDays(dateStr, n) { const d = new Date(dateStr + 'T00:00:00'); d.setDate(d.getDate() + n); const off = d.getTimezoneOffset(); return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10); }
function isDue(w) { return !w.due || daysBetween(w.due, localToday()) >= 0; }
function shuffleArr(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
/* 打乱选项顺序（字母随文案一起移动，不影响判分），防止靠位置记忆 */
function shuffleOpts(q) { if (Array.isArray(q.options)) q.options = shuffleArr(q.options.slice()); return q; }
function todaysChapters() {
  const days = daysBetween(DATA.plan.startDate, localToday());
  if (days < 0) return { notStarted: true, days };
  const { economyOrder, businessOrder, pace } = DATA.plan;
  const eco = economyOrder[days * pace.economy];
  const bus = businessOrder[days * pace.business];
  return { days, economy: eco ? findChapter('economy', eco) : null, business: bus ? findChapter('business', bus) : null };
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
/* 重做判分后更新记忆曲线：答对→进一阶（间隔变长），答错→回到第0阶（近期重练） */
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
  const payload = { wrong: state.wrong, progress: state.progress, updatedAt: new Date().toISOString() };
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
    if (payload.wrong) state.wrong = payload.wrong;
    if (payload.progress) state.progress = payload.progress;
    await saveWrong(); await saveProgress();
    toast('已从 GitHub 拉取 ✅'); router();
  } catch (e) { toast('拉取失败：' + e.message); }
}
function scheduleSync() {
  if (!state.settings.auto || !state.settings.token) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(githubSave, 15000);
}

/* ---------------- 路由 ---------------- */
function router() {
  const route = (location.hash || '#/today').replace('#/', '').split('?')[0];
  document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('active', a.dataset.route === route));
  if (route === 'wrong') renderWrong();
  else if (route === 'progress') renderProgress();
  else if (route === 'settings') renderSettings();
  else renderToday();
}
window.addEventListener('hashchange', router);

/* ---------------- 视图：今日任务 ---------------- */
function renderToday() {
  const t = todaysChapters();
  if (t.notStarted) { app.innerHTML = `<div class="card"><h2>还没开始</h2><p class="muted">计划开始日 ${DATA.plan.startDate}，距今天还有 ${-t.days} 天。</p></div>`; return; }
  const left = daysBetween(localToday(), DATA.plan.examDate);
  const banner = `<div class="banner">📅 第 ${t.days + 1} 天 / 距考试 ${left} 天　|　今日目标：经济基础 + 工商管理 各一章</div>`;
  const dueList = state.wrong.filter(isDue);
  const reviewCard = dueList.length
    ? `<div class="card review"><span class="pill a">错题复习</span>
        <p>艾宾浩斯记忆曲线：今日有 <b>${dueList.length}</b> 道错题到复习时间，建议优先清空。</p>
        <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn" onclick="startWrongDue()">📌 复习待做（${dueList.length}）</button>
          <a class="btn ghost" href="#/wrong">去错题库</a>
        </div></div>`
    : `<div class="card review"><span class="pill g">错题复习</span><p class="muted">今日暂无到期错题，继续保持！错题库共 ${state.wrong.length} 题长期保存中。</p></div>`;
  app.innerHTML = banner + chapterCard('economy', t.economy, '经济基础') + chapterCard('business', t.business, '工商管理') + reviewCard;
}
function chapterCard(subject, ch, label) {
  if (!ch) return `<div class="card"><span class="pill">${label}</span> <b>本章计划已学完 ✅</b><p class="muted">后续进入强化/模考阶段。</p></div>`;
  const note = DATA.notes[ch.id] ? `<div class="note">${esc(DATA.notes[ch.id])}</div>` : '';
  const hasQ = ch.questions && ch.questions.length;
  const btn = hasQ
    ? `<a class="btn" href="#/quiz" data-sub="${subject}" data-ch="${ch.id}">开始刷题（${ch.questions.length}题）</a>`
    : `<span class="muted">本章题库待补充，可先看作三色笔记。</span>`;
  return `<div class="card">
    <span class="pill ${subject === 'business' ? 'g' : ''}">${label}</span>
    <h3>${esc(ch.title)}</h3>
    ${note}
    <div style="margin-top:12px">${btn}</div>
  </div>`;
}

/* ---------------- 视图：刷题 ---------------- */
function startQuiz(subject, chapterId) {
  const ch = findChapter(subject, chapterId);
  if (!ch || !ch.questions.length) { toast('本章暂无题目'); return; }
  const queue = ch.questions.map(q => ({ q, subject, chapterId, chapterTitle: ch.title }));
  quiz = { queue, idx: 0, correct: 0, wrong: 0, title: ch.title };
  renderQuiz();
}
function startAll() {
  const t = todaysChapters();
  const queue = [];
  [['economy', t.economy], ['business', t.business]].forEach(([s, ch]) => { if (ch && ch.questions) ch.questions.forEach(q => queue.push({ q, subject: s, chapterId: ch.id, chapterTitle: ch.title })); });
  if (!queue.length) { toast('今日暂无题目'); return; }
  quiz = { queue, idx: 0, correct: 0, wrong: 0, title: '今日全部' };
  renderQuiz();
}
function renderQuiz() {
  if (quiz.idx >= quiz.queue.length) { renderQuizSummary(); return; }
  sel = new Set();
  const { q } = quiz.queue[quiz.idx];
  const opts = q.options.map((o, i) => `<button class="opt" data-i="${i}">${esc(o)}</button>`).join('');
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
  markStudy(item.subject + ':' + item.chapterId);
  document.getElementById('nav').innerHTML = `<button class="btn" onclick="quizNext()">${quiz.idx + 1 < quiz.queue.length ? '下一题 →' : '查看结果'}</button>`;
  const ab = document.getElementById('aiBox');
  if (ab) ab.innerHTML = `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px">
      <button class="btn ghost" onclick="aiExplainBtn('${q.id}')">🤖 AI 精讲</button>
      <button class="btn ghost" onclick="aiSimilarBtn('${q.id}')">🎯 举一反三</button>
    </div><div id="aiResult"></div>`;
}
function quizNext() { quiz.idx++; renderQuiz(); }
window.quizNext = quizNext;
function renderQuizSummary() {
  const isWrong = quiz.fromWrong;
  app.innerHTML = `<div class="card"><h2>本轮完成 🎉</h2>
    <div class="stat">
      <div class="box"><b>${quiz.queue.length}</b>总题数</div>
      <div class="box"><b style="color:var(--green-d)">${quiz.correct}</b>答对</div>
      <div class="box"><b style="color:var(--red)">${quiz.wrong}</b>答错</div>
    </div>
    <p class="muted">${isWrong ? '已按记忆曲线更新每题的复习排程；答错的题已重置到近日重练，全部留在错题库长期保存。' : '答错的题已自动进入错题库，将按记忆曲线提醒你复习。'}</p>
    <a class="btn" href="#/wrong">${isWrong ? '返回错题库' : '去错题库复习'}</a> <a class="btn ghost" href="#/today">返回今日</a>
  </div>`;
}

/* ---------------- 视图：错题库 ---------------- */
function renderWrong() {
  if (!state.wrong.length) { app.innerHTML = `<div class="card empty">🎉 暂无错题，继续保持！</div>`; return; }
  const dueList = state.wrong.filter(isDue);
  const header = `<div class="card"><div class="row"><h2>错题库（${state.wrong.length}）</h2>
      <button class="btn ghost" onclick="clearWrong()">清空</button></div>
    <p class="muted">长期保存 · 按艾宾浩斯记忆曲线自动排程。今日待复习 <b style="color:var(--red)">${dueList.length}</b> 题。</p>
    <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn" onclick="startWrongDue()">📌 复习待做（${dueList.length}）</button>
      <button class="btn g" onclick="startWrongAll()">🔁 全部重做（${state.wrong.length}）</button>
    </div></div>`;
  const items = state.wrong.slice().reverse().map(w => {
    const canRedo = Array.isArray(w.options) && w.options.length >= 2;
    const due = isDue(w);
    const matured = (w.box || 0) >= EB_MAX;
    const status = matured ? `已巩固 · 下次 ${w.due || '—'}` : (due ? '⏰ 今日待复习' : `排到 ${w.due || '—'}`);
    return `
    <div class="q">
      <div class="meta">${esc(w.chapterTitle || '')}　|　答错 ${w.count || 1} 次　|　${status}　|　你的答案：${w.yourWrong || '—'}</div>
      <div class="stem">${esc(w.stem)}</div>
      <div class="explain show"><b>正确答案：</b>${esc(w.answer)}</div>
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

/* 错题库单题重做：重新作答，判分后更新记忆曲线（答对进阶层、答错重置），长期保留 */
function redoWrong(qid) {
  const w = state.wrong.find(x => x.qid === qid);
  if (!w) { renderWrong(); return; }
  const q = shuffleOpts({ id: qid, type: w.type || 'single', stem: w.stem, options: w.options || [], answer: (w.answer || '').split('、').filter(Boolean), explanation: w.explanation || '' });
  app.innerHTML = `<div class="card"><div class="row"><span class="muted">重做 · ${esc(w.chapterTitle || '')}</span><span class="muted">❓ ${state.wrong.indexOf(w) + 1}/${state.wrong.length}</span></div>
    <div class="q"><div class="stem">${esc(q.stem)}</div>
    ${q.options.map((o, i) => `<button class="opt" data-i="${i}">${esc(o)}</button>`).join('')}
    <button class="btn g" id="redoSubmit" disabled>提交</button>
    <div class="explain" id="redoExplain"></div></div>
    <div id="redoNav" style="margin-top:10px"></div></div>`;
  let rsel = new Set();
  const opts = app.querySelectorAll('.opt');
  opts.forEach(b => b.onclick = () => {
    if (document.getElementById('redoExplain').classList.contains('show')) return;
    if (q.type === 'single') {
      opts.forEach(x => x.classList.remove('sel'));
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
    opts.forEach((b, i) => {
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

/* 批量重做会话：可从「待复习」或「全部」进入；选项/顺序均打乱，判分经 onSubmit→gradeWrong 更新曲线 */
function startWrongSession(list, title) {
  const queue = list.filter(w => Array.isArray(w.options) && w.options.length >= 2).map(w => ({
    q: shuffleOpts({ id: w.qid, type: w.type || 'single', stem: w.stem, options: w.options, answer: (w.answer || '').split('、').filter(Boolean), explanation: w.explanation || '' }),
    subject: w.subject, chapterId: w.chapterId, chapterTitle: w.chapterTitle
  }));
  if (!queue.length) { toast('没有可重做的题目（需含选项）'); renderWrong(); return; }
  shuffleArr(queue);
  quiz = { queue, idx: 0, correct: 0, wrong: 0, title, fromWrong: true };
  renderQuiz();
}
function startWrongDue() { startWrongSession(state.wrong.filter(isDue), '错题 · 待复习'); }
function startWrongAll() { startWrongSession(state.wrong, '错题 · 全部重做'); }
window.startWrongDue = startWrongDue;
window.startWrongAll = startWrongAll;

/* ---------------- 视图：进度 ---------------- */
function renderProgress() {
  const t = todaysChapters();
  const doneCount = Object.keys(state.progress.done || {}).length;
  const left = daysBetween(localToday(), DATA.plan.examDate);
  const dueCount = state.wrong.filter(isDue).length;
  const masteredCount = state.wrong.filter(w => (w.box || 0) >= EB_MAX).length;
  app.innerHTML = `<div class="card">
    <h2>学习进度</h2>
    <div class="stat">
      <div class="box"><b>${t.notStarted ? 0 : t.days + 1}</b>已进行天数</div>
      <div class="box"><b>${left}</b>距考试天数</div>
      <div class="box"><b>${doneCount}</b>已完成章节</div>
      <div class="box"><b style="color:var(--red)">${state.wrong.length}</b>错题库(长期保存)</div>
      <div class="box"><b style="color:var(--amber-d)">${dueCount}</b>今日待复习</div>
      <div class="box"><b style="color:var(--green-d)">${masteredCount}</b>已巩固</div>
      <div class="box"><b>${state.progress.streak || 0}</b>连续学习</div>
    </div>
    <p class="muted">开始日 ${DATA.plan.startDate}　·　考试日 ${DATA.plan.examDate}　|　错题库按艾宾浩斯曲线自动排程，答对进阶层、答错重置。</p>
  </div>`;
}

/* ---------------- 视图：设置 ---------------- */
function renderSettings() {
  const s = state.settings;
  const last = s.lastSync ? new Date(s.lastSync).toLocaleString() : '从未';
  app.innerHTML = `<div class="card">
    <h2>设置 · GitHub 云同步</h2>
    <p class="muted">错题与进度默认存浏览器本地（IndexedDB）。填写以下信息后，数据会自动备份到你指定的 GitHub 仓库（<b>data/user-data.json</b>）。</p>
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
    <div class="note">⚠️ 若仓库为「公开」，你的错题数据也会公开可见。需要隐私请：① 仓库设私有 + 升级 GitHub Pro 后用 GitHub Pages；或 ② 改用 Cloudflare Pages（免费支持私有仓库）。</div>
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
  await saveSettings();
  toast('设置已保存');
};
window.ghSave = githubSave;
window.ghLoad = githubLoad;
window.exportBackup = function () {
  const payload = { wrong: state.wrong, progress: state.progress, exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'econ-backup-' + localToday() + '.json'; a.click();
  toast('已导出备份文件');
};
window.importBackup = function (input) {
  const f = input.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => { try { const p = JSON.parse(r.result); if (p.wrong) state.wrong = p.wrong; if (p.progress) state.progress = p.progress; saveWrong(); saveProgress(); toast('已导入备份 ✅'); renderWrong(); } catch (e) { toast('导入失败：' + e.message); } };
  r.readAsText(f);
};

/* 拦截今日卡片里的刷题按钮 */
app.addEventListener('click', e => {
  const a = e.target.closest('a[data-sub]');
  if (a) { e.preventDefault(); startQuiz(a.dataset.sub, a.dataset.ch); }
});

/* ================ AI 讲解（浏览器直连 LLM，镜像 delivery-ocr 模式） ================ */
window.currentAIQid = null;
const AI_PRESETS = {
  zhipu:      { name:"智谱 GLM-4.6V-Flash（直连✅）", baseUrl:"https://open.bigmodel.cn/api/paas/v4/chat/completions", model:"glm-4.6v-flash", key:"zhipu" },
  siliconflow:{ name:"硅基流动 Qwen3.5-35B-A3B（直连✅）", baseUrl:"https://api.siliconflow.cn/v1/chat/completions", model:"Qwen/Qwen3.5-35B-A3B", key:"siliconflow" },
  agnes:      { name:"Agnes 2.0-Flash（免费·直连✅）", baseUrl:"https://apihub.agnes-ai.com/v1/chat/completions", model:"agnes-2.0-flash", key:"agnes" },
};
const AI_TEACHER_SYS = "你是中级经济师考试（经济基础+工商管理）的辅导老师，擅长用大白话和生活例子讲透考点，并编好记的口诀。面向只想稳过84分的考生，回答通俗、简洁、不啰嗦。";
function aiStore(p){ return "ej_" + p + "Key"; }
function aiModelStore(p){ return "ej_model_" + p; }
function aiGetKey(p){ return localStorage.getItem(aiStore(p)) || ""; }
function aiGetModel(p){ return localStorage.getItem(aiModelStore(p)) || AI_PRESETS[p].model; }
function aiCfg(){
  const p = (state.settings && state.settings.aiProvider && AI_PRESETS[state.settings.aiProvider]) ? state.settings.aiProvider : "zhipu";
  return { provider:p, baseUrl:AI_PRESETS[p].baseUrl, model:aiGetModel(p), key:aiGetKey(p) };
}
function extractJSON(text){
  if(!text) return null;
  let s = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if(fence) s = fence[1];
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if(a<0||b<a) return null;
  s = s.slice(a, b+1);
  try { return JSON.parse(s); } catch(e){}
  return repairJSON(s);
}
function repairJSON(s){
  try {
    let out = s, depth = 0, inStr = false, esc = false;
    for(const ch of s){ if(esc){esc=false;continue;} if(ch==="\\"){esc=true;continue;} if(ch==='"'){inStr=!inStr;continue;} if(inStr)continue; if(ch==="{")depth++; else if(ch==="}")depth--; }
    if(inStr) out += '"';
    while(depth>0){ out += "}"; depth--; }
    return JSON.parse(out);
  } catch(e){ return null; }
}
async function callLLM(messages, opts){
  opts = opts || {};
  const cfg = aiCfg();
  if(!cfg.key) return { error:"nokey" };
  const body = { model:cfg.model, messages, temperature:(opts.temperature!=null?opts.temperature:0.6), stream:false };
  let resp;
  try { resp = await fetch(cfg.baseUrl, { method:"POST", headers:{ "Content-Type":"application/json", "Authorization":"Bearer "+cfg.key }, body:JSON.stringify(body) }); }
  catch(e){ return { error:"net", msg:String(e) }; }
  if(!resp.ok){ let t=""; try{ t = await resp.text(); }catch(_){} return { error:"http", status:resp.status, msg:(t||"").slice(0,300) }; }
  let j; try{ j = await resp.json(); }catch(e){ return { error:"parse", msg:String(e) }; }
  const c = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if(c==null) return { error:"empty", raw:j };
  if(opts.json){ const p2 = extractJSON(c); if(!p2) return { error:"json", content:c }; return { content:p2 }; }
  return { content:c };
}
function findQById(id){
  for(const sub of ["economy","business"]){
    const s = DATA.questions[sub]; if(!s) continue;
    for(const ch of s.chapters){ if(!ch.questions) continue; const q = ch.questions.find(x=>x.id===id); if(q) return q; }
  }
  return null;
}
function qCtxOf(q){
  if(!q) return { stem:"", options:[], answer:[], explanation:"", type:"single" };
  let ans = q.answer;
  if(typeof ans === "string") ans = ans.split("、").filter(Boolean);
  if(!Array.isArray(ans)) ans = [];
  return { stem:q.stem, options:q.options||[], answer:ans, explanation:q.explanation||"", type:q.type||"single", ai_explain:q.ai_explain||null, mnemonic:q.mnemonic||null, pitfall:q.pitfall||null };
}
function aiBoxShell(box, title){
  box.innerHTML = `<div class="ai-card"><div class="ai-head">${title} <span class="ai-badge" id="aiBadge"></span></div><div class="ai-body" id="aiBody"></div></div>`;
  return box.querySelector("#aiBody");
}
function aiLoading(body){ body.innerHTML = `<div class="ai-loading"><span class="spin"></span> AI 正在思考…</div>`; }
function aiErr(body, e){
  const hints = { nokey:"未配置 API Key：去「设置 → AI 讲解」粘贴对应平台的 Key。", net:"网络/CORS 失败：多为 Key 无效或浏览器拦截，请检查 Key。", http:`接口返回 ${e.status}：${e.msg||""}`, parse:"返回内容无法解析。", json:"AI 未按要求返回 JSON，已按原文展示。", empty:"AI 返回为空。" };
  body.innerHTML = `<div class="ai-err">⚠️ ${hints[e.error]||"调用失败"}</div>` + (e.content?`<div class="ai-raw">${esc(e.content)}</div>`:"");
}
function aiExplainBtn(qid, force){
  const box = document.getElementById("aiResult"); if(!box) return;
  window.currentAIQid = qid;
  const ctx = qCtxOf(findQById(qid) || {});
  const body = aiBoxShell(box, "🤖 AI 精讲（大白话+口诀）");
  if(!force && (ctx.ai_explain || ctx.mnemonic)){
    renderExplainResult(body, { explain:ctx.ai_explain, mnemonic:ctx.mnemonic, pitfall:ctx.pitfall }, true);
    return;
  }
  aiLoading(body);
  const optText = (ctx.options||[]).map(o=>"  "+o).join("\n");
  const user = `【题目】${ctx.stem}\n【选项】\n${optText}\n【正确答案】${ctx.answer.join("、")}\n【官方解析】${ctx.explanation||"（无）"}\n\n请用 JSON 返回：{"explain":"用大白话+一个生活例子讲透考点（150字内）","mnemonic":"一句好记的口诀或顺口溜","pitfall":"考生最易踩的坑/易混点（80字内）"}。只返回 JSON，不要多余文字。`;
  callLLM([{role:"system",content:AI_TEACHER_SYS},{role:"user",content:user}], {json:true}).then(r=>{
    if(r.error){ aiErr(body, r); return; }
    renderExplainResult(body, r.content, false);
  });
}
function renderExplainResult(body, d, baked){
  const badge = body.parentElement.querySelector("#aiBadge");
  if(badge) badge.innerHTML = baked ? `<span class="ai-badge ok">离线缓存</span>` : `<span class="ai-badge ok">已生成</span>`;
  body.innerHTML = `
    ${d.explain?`<div class="ai-sec"><b>📘 大白话</b><p>${esc(d.explain)}</p></div>`:""}
    ${d.mnemonic?`<div class="ai-sec"><b>🔑 记忆口诀</b><p class="mnem">${esc(d.mnemonic)}</p></div>`:""}
    ${d.pitfall?`<div class="ai-sec"><b>⚠️ 易错提醒</b><p>${esc(d.pitfall)}</p></div>`:""}
    <div class="ai-foot"><button class="btn ghost" onclick="aiExplainBtn(currentAIQid, true)">🔄 重新生成</button></div>`;
}
function aiDiagnoseBtn(qid){
  const w = state.wrong.find(x=>x.qid===qid); if(!w) return;
  const box = document.getElementById("aiResult_"+qid); if(!box) return;
  const body = aiBoxShell(box, "🩺 AI 诊断（你为什么错）");
  if(!w.yourWrong){ body.innerHTML = `<div class="ai-err">这道题没有记录你的作答，无法诊断。可先点「重做」再诊断。</div>`; return; }
  aiLoading(body);
  const optText = (w.options||[]).map(o=>"  "+o).join("\n");
  const user = `【题目】${w.stem}\n【选项】\n${optText}\n【你选了】${w.yourWrong}（这是错的）\n【正确答案】${w.answer}\n\n请像老师一样，用大白话分三点说明：① 我为什么会选错（常见误区是什么）；② 正确答案为什么对；③ 以后怎么避开这个坑。简洁、直击痛点。`;
  callLLM([{role:"system",content:AI_TEACHER_SYS},{role:"user",content:user}], {temperature:0.5}).then(r=>{
    if(r.error){ aiErr(body, r); return; }
    const badge = body.parentElement.querySelector("#aiBadge");
    if(badge) badge.innerHTML = `<span class="ai-badge ok">已诊断</span>`;
    body.innerHTML = `<div class="ai-sec"><p>${esc(r.content)}</p></div><div class="ai-foot"><button class="btn ghost" onclick="aiDiagnoseBtn('${qid}')">🔄 重新诊断</button></div>`;
  });
}
function aiSimilarBtn(qid){
  const box = document.getElementById("aiResult") || document.getElementById("aiResult_"+qid);
  if(!box) return;
  const src = findQById(qid) || (state.wrong.find(x=>x.qid===qid)) || {};
  const ctx = qCtxOf(src);
  const body = aiBoxShell(box, "🎯 举一反三（AI 出题）");
  aiLoading(body);
  const optText = (ctx.options||[]).map(o=>"  "+o).join("\n");
  const user = `基于下面这道真题的考点，出一道新的、不重复的同类练习题（题型可同可不同）。\n【原题】${ctx.stem}\n【原选项】${optText}\n【原答案】${ctx.answer.join("、")}\n\n返回 JSON：{"type":"single或multiple","stem":"题干","options":["A ...","B ...","C ...","D ..."],"answer":["A"],"explanation":"简短解析"}。只返回 JSON，选项必须以 A/B/C/D 开头。`;
  callLLM([{role:"system",content:AI_TEACHER_SYS},{role:"user",content:user}], {json:true}).then(r=>{
    if(r.error){ aiErr(body, r); return; }
    const d = r.content;
    if(!d || !Array.isArray(d.options)){ aiErr(body, {error:"json", content:(typeof d==="string"?d:JSON.stringify(d))}); return; }
    const badge = body.parentElement.querySelector("#aiBadge");
    if(badge) badge.innerHTML = `<span class="ai-badge ok">已出题</span>`;
    renderSimilarQuiz(body, d, qid);
  });
}
function renderSimilarQuiz(body, data, qid){
  const opts = (data.options||[]).map((o,i)=>`<button class="opt" data-i="${i}">${esc(o)}</button>`).join("");
  body.innerHTML = `<div class="q"><div class="stem">${esc(data.stem)}</div>${opts}<button class="btn g" id="simSubmit" disabled>提交</button><div class="explain" id="simExpl"></div></div>
    <div class="ai-foot"><button class="btn ghost" onclick="aiSimilarBtn('${qid}')">🔄 换一道</button></div>`;
  let ssel = new Set();
  const root = body;
  root.querySelectorAll(".opt").forEach(b=>b.onclick=()=>{
    if(root.querySelector("#simExpl").classList.contains("show")) return;
    if(data.type==="single"){ root.querySelectorAll(".opt").forEach(x=>x.classList.remove("sel")); b.classList.add("sel"); ssel = new Set([+b.dataset.i]); root.querySelector("#simSubmit").disabled = false; }
    else { b.classList.toggle("sel"); if(b.classList.contains("sel")) ssel.add(+b.dataset.i); else ssel.delete(+b.dataset.i); root.querySelector("#simSubmit").disabled = ssel.size===0; }
  });
  root.querySelector("#simSubmit").onclick = ()=>{
    const correct = [...ssel].map(i=>data.options[i][0]).sort().join("") === data.answer.slice().sort().join("");
    root.querySelectorAll(".opt").forEach((b,i)=>{ const L = data.options[i][0]; if(data.answer.includes(L)) b.classList.add("correct"); else if(ssel.has(i)) b.classList.add("wrong"); else b.classList.add("dim"); b.disabled = true; });
    const ex = root.querySelector("#simExpl"); ex.innerHTML = `<b>答案：</b>${data.answer.join("、")}　|　<b>解析：</b>${esc(data.explanation||"")}`; ex.classList.add("show"); root.querySelector("#simSubmit").style.display = "none";
  };
}
function renderAISettings(){
  const p = aiCfg().provider;
  const opts = Object.keys(AI_PRESETS).map(k=>`<option value="${k}" ${k===p?"selected":""}>${AI_PRESETS[k].name}</option>`).join("");
  return `<div class="card">
    <h2>🤖 AI 讲解（浏览器直连大模型）</h2>
    <p class="muted">密钥仅存本机浏览器（localStorage），<b>不会</b>随 GitHub 备份上传。支持智谱 / 硅基流动 / Agnes 三家，浏览器直连无需代理。</p>
    <label>默认模型</label>
    <select id="aiProv">${opts}</select>
    <label>API Key（对应上面选中的模型）</label>
    <input id="aiKey" type="password" placeholder="粘贴对应平台的 Key（Agnes 免费，可留空试）">
    <p class="muted" id="aiKeyHint"></p>
    <label>自定义模型名（可选，留空用默认）</label>
    <input id="aiModel" placeholder="如 glm-4-flash / Qwen/Qwen3.5-35B-A3B">
    <p class="muted">Key 获取：智谱 bigmodel.cn ｜ 硅基流动 siliconflow.cn ｜ Agnes apihub.agnes-ai.com</p>
    <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn" onclick="saveAISet()">保存</button>
      <button class="btn g" onclick="testAICall()">测试连接</button>
    </div>
  </div>`;
}
function loadAIKeyInput(){
  const pv = document.getElementById("aiProv"); if(!pv) return;
  const p = pv.value;
  const k = document.getElementById("aiKey"), m = document.getElementById("aiModel"), h = document.getElementById("aiKeyHint");
  if(k) k.value = aiGetKey(p);
  if(m) m.value = aiGetModel(p);
  if(h){ const hint = { zhipu:"智谱 Key 形如 xxxx.xxxxxx", siliconflow:"硅基流动 Key 以 sk- 开头", agnes:"Agnes 免费 Key（apihub 申请），也可留空" }; h.textContent = hint[p] || ""; }
}
window.saveAISet = function(){
  const pv = document.getElementById("aiProv"); if(!pv) return;
  const p = pv.value;
  state.settings.aiProvider = p;
  localStorage.setItem(aiStore(p), (document.getElementById("aiKey").value||"").trim());
  localStorage.setItem(aiModelStore(p), (document.getElementById("aiModel").value||"").trim());
  saveSettings();
  toast("AI 设置已保存（Key 仅存本机）");
};
window.testAICall = function(){
  toast("正在测试连接…");
  callLLM([{role:"user",content:"回复两个字：可用"}]).then(r=>{
    if(r.error) toast("测试失败：" + (r.error==="nokey" ? "未填 Key" : r.error));
    else toast("AI 连接成功 ✅");
  });
};
window.aiExplainBtn = aiExplainBtn;
window.aiDiagnoseBtn = aiDiagnoseBtn;
window.aiSimilarBtn = aiSimilarBtn;
window.loadAIKeyInput = loadAIKeyInput;
window.findQById = findQById;

/* ---------------- 启动 ---------------- */
(async function init() {
  try { await loadData(); }
  catch (err) { app.innerHTML = `<div class="card empty">⚠️ 数据加载失败。<br>请用本地服务器访问（如 <code>python -m http.server</code>），或直接部署到 GitHub Pages，<br>不能用 file:// 直接打开。</div>`; return; }
  await loadState();
  router();
})();
