---
name: x-article-publisher
description: 通过 CDP 自动化发布 X.com (Twitter) 长文（Articles）及配图。支持自动上传 5:2 封面图、HTML 全文粘贴、追加正文架构插图、自动处理保存与确认发布，秒级成文。
---

# X.com 文章快速发布器 (x-article-publisher)

该 Skill 封装了通过 Chrome DevTools Protocol (CDP, 端口 9222) 在已登录 X 账号下自动化发布 X Articles（长文专栏）的标准流程。

已彻底解决 X 文章编辑器的常见坑点：
1. **封面比例要求严格为 5:2**（如 2500×1000），非 5:2 会弹裁切弹窗阻断流程；
2. **Draft.js HTML 格式粘贴与样式保留**；
3. **React Redux 异步上传状态与发布按钮启用判断**；
4. **正文配图如果中途插入会篡改输入焦点**，脚本采用“全文插入后末尾追加插图”的安全时序；
5. **发布确认弹窗的说明文案（Caption）与外链自动绑定**；
6. **发布完成后自动关闭临时标签页**，不污染工作区。

---

## 快速调用命令

```powershell
node "./scripts/publish-article.mjs" `
  --title "文章标题（建议不超过80字）" `
  --bodyFile "path/to/article.html" `
  --cover "path/to/header-5x2.png" `
  --inlineImage "path/to/diagram.png" `
  --caption "推文摘要/说明文案 + #标签"
```

### 批量清理无用草稿：
```powershell
node "./scripts/clean-drafts.mjs" [--max 20] [--keep 0]
```

### 参数说明：
- `--title` (必填): 文章主标题。
- `--bodyFile` (必填/或 `--body`): 包含完整富文本 HTML 的文件路径（`<p>`, `<h2>`, `<ul>`, `<li>`, `<strong>`）。
- `--cover` (可选): 文章顶部封面图。**必须为 5:2 比例**（推荐 `2500x1000` 或 `1536x614`）。
- `--inlineImage` (可选): 正文架构或说明插图（推荐 16:9 或 3:2）。
- `--caption` (可选): 发布弹窗中的推文说明文案（会自动附加文章链接）。

---

## 环境依赖与前置条件

1. **CDP 浏览器已在 9222 端口运行**：
   - 验证：`Invoke-RestMethod http://127.0.0.1:9222/json/version`
   - 启动脚本：`& 'E:\WebstormProjects\x-each-follower\tools\cdp-session.ps1' -StartIfAbsent`
2. **X 账号拥有 Articles 发文权限**：
   - 账号已开通 Premium，具备 `/compose/articles` 专栏发文功能。
