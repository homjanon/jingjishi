# 经济师刷题站（经济基础 + 工商管理）

纯前端自动化学习站：每日任务派题、刷题即时反馈、错题库自动收集、进度跟踪，支持 GitHub 云同步。

- 部署：GitHub Pages（公开仓库）
- 数据：题库 data/questions.json、计划 data/plan.json、三色笔记 data/notes.json
- 本地预览：python -m http.server 8000 后访问 http://127.0.0.1:8000/

---

## 更新记录

### 2026-08-10
- 绑定自定义域名：`jingjishi.hellohopo.dpdns.org`（GitHub Pages + Cloudflare，CNAME 已配置）
- 题库加载改三源回退，提升国内访问速度：
  1. **Cloudflare CORS 代理**（主源，实时拉取 GitHub raw 数据）
  2. **jsdelivr CDN**（兜底）
  3. **同站相对路径**（最终兜底）
  - 涉及 `app.js` 的 `loadData()`，gitee 同步逻辑不变
