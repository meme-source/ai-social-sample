# CLAUDE.md

这个仓库是老师给的样板，我（学生）在上面把它改成自己的作品集项目。我是设计背景的初学者：请用中文、用大白话跟我说话。

## 项目

真人和 AI 成员混在同一个话题群里聊天的网页 App，在 iPhone 上添加到主屏幕使用。要办两场 5–8 人的多人测试，用测试数据决定下一版改什么。

- 技术说明：README.md（第 2 部分是上线步骤，最后一节 Known limits 是已知问题，可以当迭代起点）
- 测试场怎么办：TESTING.md；收集了哪些数据：DATA.md
- 我的研究问题、v2 清单、待定事项、每天的进度：PROGRESS.md

## 技术栈（不要换）

- 前端：Vite + React + TypeScript + Tailwind CSS，部署在 Vercel，main 分支就是线上正式版
- 后端：Supabase（匿名登录、Postgres + RLS、Realtime、Edge Function `room-ai`）
- 大模型：OpenAI 兼容格式，默认 DeepSeek，只在 Edge Function 里调用；`LLM_BASE_URL`、`LLM_MODEL`、`LLM_API_KEY` 放在 Supabase Secrets

## 规矩

1. 一次只做一件事。动手前先用大白话说计划，我同意了再改。
2. 密钥不进代码、不进 Git，也不要让我把密钥贴给你；告诉我去哪个后台自己填。
3. 只改界面的时候，不动数据库、实时消息、AI 规则和数据记录的逻辑。
4. 数据库改动写成 `supabase/migrations/` 里的新文件，不改已有的迁移文件。线上的群、AI 人设和题库也用新迁移来改，同时更新 `supabase/seed.sql`。
5. 改了 `supabase/functions/` 下的文件（包括 `_shared/ai-rules.ts`），提交后 Vercel 只会更新网页；要提醒我运行 `npx supabase functions deploy room-ai`，线上的 AI 才会用上新代码。
6. 改完先跑 `npm run typecheck`、`npm run lint`、`npm test`，都通过再提交。告诉我改了哪些文件、在 iPhone 上怎么验证。
7. 每做完一件事，在 PROGRESS.md 的日志里记一行（日期、做了什么、遇到的问题），再提交。提交信息写清改了什么，比如「feat: 群聊页换成 Figma 样式」。
8. 出错时先说原因再改；我没听懂就换个说法再讲一遍。
9. 样式照 `design/` 里的 Figma 截图和 `tokens.md`。
10. 发新版（v1.1、v2）时，把 package.json 的 `version` 改成 0.1.1、0.2.0，再打一个 git 标签（`v1.1`、`v2`）一起推到 GitHub。页面角落和每条测试记录里的版本号会跟着变，GitHub 上也能直接对比两版。
11. 测试进行中不发新版本。

## AI 发言规则

规则数字都在 `supabase/functions/_shared/ai-rules.ts` 的 `AI_RULES` 里，网页和 AI 函数共用这一份。

- 触发：有人进群 → 主持人用模板欢迎（不调模型）；被 @ → 被 @ 的 AI 回应；冷场 45 秒（`silenceMs`）且有真人在线 → 主持人抛一个话题，同一次冷场只接一次
- 刹车：同一群 15 秒内最多 1 条 AI 消息（数据库原子抢锁；SQL 函数 `ai_try_lock` 里也写着 15 秒，改的话两处一起改）；任意连续 12 条消息里 AI 最多 4 条；每群每小时最多 60 次模型调用
- 上下文：话题 + 人设 + 最近 20 条消息；每条回复最多 2 句、280 个字符
- 被问是不是 AI：不撒谎、不承认，也不说自己是真人；轻轻带过，回到话题
- 兜底：模型出错、超时（8 秒）或余额不足时，从 `question_bank` 抽一个问题，群里不显示报错
- 人设在 `bots` 表：`role`（host 或 participant）、`language`、`tags`、`activity_level`（1–3）、`professionalism`（1–3）、`banned_words`、`custom_chat_style`（人设描述，最多 600 字）；名字和头像在 `profiles` 表

## 测试数据（新功能都要接上）

- 每条记录都带场次（`test_sessions`）和版本号
- 测试者反馈 → `feedback`
- 页面报错、断线重连、补拉、重复、顺序错乱、延迟 → `client_events`（每 10 秒批量上传，不存聊天内容）
- AI 每次说或不说、原因、耗时、用量、是否兜底 → `ai_events`
- 场后核对 `run_checks()` → `anomalies`
- 后台 `/admin` 只有 `admins` 表里的人能看
