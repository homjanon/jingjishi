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
  else state.wrong.push({ ...item, count: 1, last: localToday() });
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
  app.innerHTML = banner + chapterCard('economy', t.economy, '经济基础') + chapterCard('business', t.business, '工商管理');
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
  if (correct) quiz.correct++; else {
    quiz.wrong++;
    const item = quiz.queue[quiz.idx];
    addWrong({ qid: q.id, subject: item.subject, chapterId: item.chapterId, chapterTitle: item.chapterTitle, stem: q.stem, answer: q.answer.join('、'), yourWrong: [...sel].map(i => q.options[i][0]).join('、') });
  }
  const item2 = quiz.queue[quiz.idx];
  markStudy(item2.subject + ':' + item2.chapterId);
  document.getElementById('nav').innerHTML = `<button class="btn" onclick="quizNext()">${quiz.idx + 1 < quiz.queue.length ? '下一题 →' : '查看结果'}</button>`;
}
function quizNext() { quiz.idx++; renderQuiz(); }
window.quizNext = quizNext;
function renderQuizSummary() {
  app.innerHTML = `<div class="card"><h2>本轮完成 🎉</h2>
    <div class="stat">
      <div class="box"><b>${quiz.queue.length}</b>总题数</div>
      <div class="box"><b style="color:var(--green-d)">${quiz.correct}</b>答对</div>
      <div class="box"><b style="color:var(--red)">${quiz.wrong}</b>答错(已入错题库)</div>
    </div>
    <a class="btn" href="#/wrong">去错题库复习</a> <a class="btn ghost" href="#/today">返回今日</a>
  </div>`;
}

/* ---------------- 视图：错题库 ---------------- */
function renderWrong() {
  if (!state.wrong.length) { app.innerHTML = `<div class="card empty">🎉 暂无错题，继续保持！</div>`; return; }
  const items = state.wrong.slice().reverse().map(w => `
    <div class="q">
      <div class="meta">${esc(w.chapterTitle || '')}　|　答错 ${w.count || 1} 次　|　最近 ${w.last || ''}　|　你的答案：${w.yourWrong || '—'}</div>
      <div class="stem">${esc(w.stem)}</div>
      <div class="explain show"><b>正确答案：</b>${esc(w.answer)}</div>
      <div style="margin-top:10px"><button class="btn ghost" onclick="rmWrong('${w.qid}')">移除</button></div>
    </div>`).join('');
  app.innerHTML = `<div class="card"><div class="row"><h2>错题库（${state.wrong.length}）</h2>
    <button class="btn ghost" onclick="clearWrong()">清空</button></div></div>${items}`;
}
window.rmWrong = function (qid) { removeWrong(qid); renderWrong(); };
window.clearWrong = function () { if (confirm('确定清空全部错题？')) { state.wrong = []; saveWrong(); renderWrong(); } };

/* ---------------- 视图：进度 ---------------- */
function renderProgress() {
  const t = todaysChapters();
  const doneCount = Object.keys(state.progress.done || {}).length;
  const left = daysBetween(localToday(), DATA.plan.examDate);
  app.innerHTML = `<div class="card">
    <h2>学习进度</h2>
    <div class="stat">
      <div class="box"><b>${t.notStarted ? 0 : t.days + 1}</b>已进行天数</div>
      <div class="box"><b>${left}</b>距考试天数</div>
      <div class="box"><b>${doneCount}</b>已完成章节</div>
      <div class="box"><b style="color:var(--red)">${state.wrong.length}</b>错题库</div>
      <div class="box"><b>${state.progress.streak || 0}</b>连续学习</div>
    </div>
    <p class="muted">开始日 ${DATA.plan.startDate}　·　考试日 ${DATA.plan.examDate}</p>
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
  </div>`;
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

/* ---------------- 启动 ---------------- */
(async function init() {
  try { await loadData(); }
  catch (err) { app.innerHTML = `<div class="card empty">⚠️ 数据加载失败。<br>请用本地服务器访问（如 <code>python -m http.server</code>），或直接部署到 GitHub Pages，<br>不能用 file:// 直接打开。</div>`; return; }
  await loadState();
  router();
})();
