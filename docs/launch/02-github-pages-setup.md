# GitHub Pages 部署协议页指南

> 目标: 把 `agreement.html` + `privacy.html` 部署到公开 URL, 提审时填入。
> 优点: 免费 / 稳定 / 微信可达 / HTTPS 自动。

---

## 方案 A: 独立 repo（推荐）

### 步骤

```bash
# 1. 在 GitHub 创建新 repo (公开)
#    名称: unequal-legal (或你喜欢的)
#    描述: 育儿不等号 用户协议 / 隐私政策

# 2. 本地初始化
mkdir unequal-legal
cd unequal-legal
cp /Users/Mark/cc_project/unequal/docs/launch/legal/agreement.html ./index.html
cp /Users/Mark/cc_project/unequal/docs/launch/legal/privacy.html ./privacy.html

# 3. 提交
git init
git add .
git commit -m "feat: initial legal pages"
git branch -M main
git remote add origin git@github.com:YOUR_GITHUB_USERNAME/unequal-legal.git
git push -u origin main

# 4. GitHub → Settings → Pages
#    - Source: Deploy from a branch
#    - Branch: main / root
#    - Save
#    等待 1-2 分钟, URL: https://YOUR_GITHUB_USERNAME.github.io/unequal-legal/

# 5. 验证
curl -I https://YOUR_GITHUB_USERNAME.github.io/unequal-legal/index.html
# 期望: HTTP/2 200

# 6. 微信小程序提审填入
#    - 用户协议 URL: https://YOUR_GITHUB_USERNAME.github.io/unequal-legal/index.html
#    - 隐私政策 URL: https://YOUR_GITHUB_USERNAME.github.io/unequal-legal/privacy.html
```

### 注意事项
- 把上面的 `YOUR_GITHUB_USERNAME` 替换成你的 GitHub 用户名
- repo 必须是**公开**（GitHub Pages 公开 repo 才能用）
- 建议在 repo 根目录加个 README 注明: "本页是微信小程序「育儿不等号」的法定文档, 内容由 unequal 项目维护"

---

## 方案 B: 现有 unequal repo 的 `docs/legal/` 路径

如果你不想建新 repo, 可以在 unequal repo 里建一个 `docs/legal/` 子目录, 用 GitHub Pages 部署子路径。

```bash
# 1. 准备 gh-pages 分支
cd /Users/Mark/cc_project/unequal
git checkout --orphan gh-pages
git rm -rf .
mkdir legal
cp docs/launch/legal/agreement.html legal/index.html
cp docs/launch/legal/privacy.html legal/privacy.html
touch .nojekyll
git add .
git commit -m "feat: deploy legal pages to GitHub Pages"
git push origin gh-pages

# 2. GitHub → Settings → Pages
#    - Source: gh-pages branch / root
#    - URL: https://YOUR_GITHUB_USERNAME.github.io/unequal/legal/index.html
```

**缺点**: 每次更新协议内容要切分支, 麻烦。**推荐方案 A**。

---

## 方案 C: Vercel / Cloudflare Pages (备选)

如果你已经有 Vercel 或 Cloudflare Pages 部署经验, 也可以用同样的方式部署。

**Vercel:**
```bash
npm i -g vercel
cd unequal-legal
vercel --prod
# 跟着提示走, 1 分钟部署完
```

**Cloudflare Pages:**
```bash
# 1. 登录 dash.cloudflare.com → Pages → Create a project
# 2. Connect to Git → 选择 unequal-legal repo
# 3. Build settings: 留空 (静态 HTML 无需 build)
# 4. Deploy
```

---

## 验证 checklist

部署完确认:
- [ ] `index.html` 公开可访问（无登录墙）
- [ ] `privacy.html` 公开可访问
- [ ] HTTPS 证书正常（绿色锁）
- [ ] 移动端友好（手机浏览器可读）
- [ ] 内容正确显示中文, 没有乱码
- [ ] **微信内可打开** (重要！有些 GitHub Pages 在微信内被屏蔽)

### 微信内打开测试

1. 把 URL 发到任意微信群 / 好友
2. 点击链接 → 应该直接在微信内置浏览器打开
3. 如果是 GitHub Pages 默认域名 `*.github.io` 偶尔被微信屏蔽, 改用方案 C (Vercel/CF Pages) 即可

---

## 邮箱占位符

两个 HTML 里都有 `[填入你的邮箱]` 占位符, 部署前请替换:

```bash
cd unequal-legal
# macOS
sed -i '' 's/\[填入你的邮箱\]/your-real-email@example.com/g' *.html
# Linux
sed -i 's/\[填入你的邮箱\]/your-real-email@example.com/g' *.html
git add . && git commit -m "fix: replace email placeholder" && git push
```

---

## 完成后

把两个 URL 填入 `docs/launch/01-submission-materials.md` 的 checklist:

- 用户协议 URL: `https://YOUR_GITHUB_USERNAME.github.io/unequal-legal/`
- 隐私政策 URL: `https://YOUR_GITHUB_USERNAME.github.io/unequal-legal/privacy.html`

然后到微信开发者工具提交审核时填入即可。
