# 潞河冲刺站家庭同步

学习版仍发布到 GitHub Pages，线上配置位于 `cloudbase-config.mjs`。默认配置为 `null`，本机学习和复制摘要照常使用。同步内容包括已提交的任务、实际用时、单词打卡和按日期查询的历史。图片、录音、错题、日志和单词笔记保存在原浏览器。

## 配置测试环境

1. 登录腾讯云 CloudBase 并开通免费环境。建立文档集合 `sprint_completion`，权限设为仅管理员可读写。使用 PostgreSQL 模式时先启用文档能力。
2. 把本目录的 `index.js`、`handler.cjs`、`package.json` 部署为普通 Node.js 云函数 `sprintSync`，入口 `index.main`。启用云端依赖安装。
3. 为学生和家长分别生成 32 字节随机令牌。云函数环境变量 `SPRINT_STUDENT_SHA256` 和 `SPRINT_PARENT_SHA256` 只填对应的 SHA-256 十六进制摘要。原始令牌通过家庭专属链接私下保管，不提交到 Git。测试环境和正式环境使用不同的令牌。
4. 在云开发设置添加 Web 安全域名 `jjia53-lang.github.io`。允许浏览器通过 Web SDK 调用 `sprintSync`。文档集合的客户端读写权限保持关闭。填写测试网页的 CloudBase 环境 ID、地域和专供浏览器使用的 Publishable Key，管理密钥不得出现在网页或仓库。
5. 学生和家长分别打开带自己 `#sync=原始令牌` 的网址。用合成记录检查北京写入、美国读取、历史日期查询、家长只读和断网重试。确认后启用正式配置。等需要导入本机历史时，再将配置中的 `allowImport` 设为 `true`，由学生在原浏览器主动导入。

## 本地验证

运行 `node cloudbase/check-sync.mjs` 验证角色、重试、修订、日期查询和链接处理。测试用内存模拟数据库，不会触及线上学习记录。
