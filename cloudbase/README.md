# 潞河冲刺站家庭同步

学习版仍发布到 GitHub Pages，线上配置位于 `cloudbase-config.mjs`。只打开普通网址时，本机学习和复制摘要照常使用。同步内容包括已提交的任务、实际用时、单词打卡和按日期查询的历史。图片、录音、错题、日志和单词笔记保存在原浏览器。

## 配置测试环境

1. 登录腾讯云 CloudBase 并开通免费环境。建立文档集合 `sprint_completion`，权限设为仅管理员可读写。使用 PostgreSQL 模式时先启用文档能力。
2. 把本目录的 `index.js`、`handler.cjs`、`http.cjs`、`package.json` 部署为普通 Node.js 云函数 `sprint-sync`，入口 `index.main`。启用云端依赖安装。
3. 为学生和家长分别生成 32 字节随机令牌。云函数环境变量 `SPRINT_STUDENT_SHA256` 和 `SPRINT_PARENT_SHA256` 只填对应的 SHA-256 十六进制摘要。原始令牌通过家庭专属链接私下保管，不提交到 Git。测试和正式环境使用不同的令牌。可选的 `SPRINT_TEST_STUDENT_SHA256` 和 `SPRINT_TEST_PARENT_SHA256` 将合成测试与家庭记录分开。
4. 在 HTTP 网关的默认域名下创建 `/sync` 路由，指向 `sprint-sync`。在此路由关闭网关跨域校验，由函数仅向 `https://jjia53-lang.github.io` 返回跨域访问头。所有数据操作都在函数内校验学生或家长令牌，数据库无客户端权限。网页配置只包含网关 URL。
5. 学生和家长分别打开带自己 `#sync=原始令牌` 的网址。用合成记录检查北京写入、美国读取、历史日期查询、家长只读和断网重试。确认后启用正式配置。等需要导入本机历史时，再将配置中的 `allowImport` 设为 `true`，由学生在原浏览器主动导入。

## 本地验证

运行 `node cloudbase/check-sync.mjs` 验证角色、重试、修订、日期查询和链接处理。测试用内存模拟数据库，不会触及线上学习记录。
