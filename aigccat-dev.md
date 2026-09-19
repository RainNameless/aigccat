# aigccat dev 分支 · 发布验证文档

> 本文档用于「发布前验证」。你按下面的清单验证，全部通过后我才执行合并。
> **验证通过之前，dev 不会合并到 main。**

## 这个分支是什么

- **来源**：`test` 分支（截至 `dee9302`）的完整代码快照
- **形式**：孤儿分支（单个提交，**不带任何历史**）——test 分支的历史里含内部服务器 IP，
  直接推分支会把历史一起带出去；孤儿快照从根上保证发布内容干净
- **构建**：`docker-compose.allinone.yml` 单容器，与 test 完全一致

## 脱敏报告（发布前已逐项扫描）

| 检查项 | 结果 |
|---|---|
| 服务器 IP（119.28.*.* 等内网/生产地址） | ✅ 代码树零命中 |
| 自定义 API / 中转配置（Sub2API 接入、provider-1/2/3） | ✅ 不在代码里（只存在于数据卷，未随代码发布） |
| API Key / Token（sk-、msy_ 等真实凭据） | ✅ 仅剩文档占位符（`msy_dummy_api_key_for_test_mode_12345678`、`msy_test`），无真实密钥 |
| 生产日志 | ✅ 无任何 .log 文件被追踪 |
| `.ai/`、`.workbuddy/`、`PROGRESS.md` 等内部记录 | ✅ 均在 .gitignore，未追踪 |
| 构建产物（web/target 等） | ✅ 未追踪 |
| git 历史 | ✅ 孤儿分支无历史（历史中的 IP 不会随 dev 泄出） |

## 本版内容（相对上一发布）

1. **多账号池（sub2api 式）**：每家供应商可存多条账号（订阅 / API Key / 自定义模型服务），
   可切换「当前」、可启停、可删除；后台「AI 账号」页统一管理
2. **自定义模型接入**：OpenAI 兼容地址 + Key，保存时自动读取上游 `/models` 全量导入
   （生图/文字按名字归类，识图可显式指定）；「获取模型」可随时补齐
3. **模型分配**：生图 / 文字 LLM（绑骨）/ 识图（多模态）/ 3D 建模四条用途各指定一条模型，
   跨多家可选，改完即生效
4. **构建面板统一**：去掉「网页订阅 / API」双轨，选哪家就是哪家；
   Tripo 走订阅还是 API 由「当前账号」决定
5. **回收站永久删除**：`DELETE /api/assets/{dir}/{id}` 连根删除 MinIO 数据，
   回收站视图新增红色「永久删除所选」（双重确认）
6. **对话测试**回到 AI 账号页底部（常驻 iframe，记录在 IndexedDB）
7. **登录窗口修正**：虚拟屏幕 1920x1080、浏览器最大化、弹窗不再出屏；
   运行时不再自动借用宿主代理（确需代理显式设 `STUDIO_PROXY`）
8. **构建改官方源**：apt 走 `deb.debian.org` + 代理（构建期专用）

## 验证步骤（照着做）

```bash
# 1. 干净克隆 dev 分支
git clone -b dev git@github.com:RainNameless/aigccat.git aigccat-dev-verify
cd aigccat-dev-verify

# 2. 自查敏感内容（应全部零命中）
grep -rE "(119|192)\.(28|168)\.[0-9]+\.[0-9]+|aiping\.icu" . 2>/dev/null | grep -v ".git/" || echo "✅ IP 干净"
git log --oneline   # 应只有 1 个提交（孤儿快照）

# 3. 构建（需要 Docker；Apple Silicon 也可）
docker build -f deploy/allinone/Dockerfile -t aigccat:dev-verify \
  --build-arg APT_MIRROR=deb.debian.org \
  --build-arg RUST_IMAGE=docker.m.daocloud.io/library/rust:1-slim-bookworm \
  --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:22-bookworm-slim \
  --build-arg DEBIAN_IMAGE=docker.m.daocloud.io/library/debian:bookworm-slim .

# 4. 全新卷启动（首次部署会打印初始管理员密码）
docker run -d --name aigccat-dev-verify -p 28080:8080 -v aigccat-dev-verify-data:/data aigccat:dev-verify
docker logs aigccat-dev-verify 2>&1 | grep -i "密码\|password" | head -3
```

### 功能验收清单

- [ ] 打开 `http://localhost:28080`，用初始密码登录
- [ ] 后台 →「AI 账号」：列表为空、可添加账号（订阅 / API Key / 自定义三种）
- [ ] 添加自定义模型服务：填 OpenAI 兼容地址 + Key → 模型自动导入，
      生图模型出现在「图片创作」的图像模型下拉里
- [ ] 「模型分配」四条用途可指定模型；「AI 对话测试」能选模型发消息
- [ ] 工作台 → 模型构建：五家供应商卡片一致；无「网页订阅/API」开关
- [ ] 模型构建：每个参数旁有 ? 帮助按钮，点击弹说明；右下角有「新手向导」小猫入口
- [ ] 资产库 → 回收站：有红色「永久删除所选」按钮；删除后资产从 MinIO 消失
- [ ] `docker exec aigccat-dev-verify ls /srv/static | head`：静态文件正常
- [ ] 验证完清理：`docker rm -f aigccat-dev-verify && docker volume rm aigccat-dev-verify-data`

## 已合并 main

main 分支的 4 个新提交（模型参数帮助 / 新手向导 / 图标提示，d18855e）已合入 dev：
冲突解决原则 = 保留 dev 的统一面板结构（供应商卡片、无订阅/API 双轨），
把 main 的 7 个参数帮助按钮（面数/几何/四边面/纹理/PBR/贴图质量/导出尺寸）
注入到对应字段；新手向导（右下角小猫）与 tooltip 正常工作。
合并后冒烟测试通过；静态资源版本推进到 20260919-merge-1。

## 合并规则

- 以上全部通过 → 通知我「验证通过」，我把 dev 合并进 main 并打 tag
- 任何一项不过 → 告诉我现象，我在 test 上修，修完重新打包 dev（仍是干净孤儿快照），你重新验证
- **在你明确说「验证通过」之前，dev 不会被合并**

## 已知事项

- `origin` 上的 `test` 分支**历史里含内部服务器 IP**（早期文档提交）。dev 已与之隔离；
  若仓库对外可见，建议后续对 test 历史做清理或换用全新远端仓库
- 中转/生产凭据都在**数据卷**里（services.json），与代码发布无关；换环境需重新配置
