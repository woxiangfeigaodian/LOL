# 部署清单：拿到一个谁都能打开的网址

目标：得到一个形如 `https://lol-spy-xxxx.onrender.com` 的固定网址。
任何人打开它都能**自己创建房间、自己当房主**，完全不需要你的电脑开着。

整个流程分三步，大约 10 分钟，中间只有两步需要你在浏览器里点。

---

## 第 1 步：把代码放到 GitHub

代码已经在本机提交成一个 git 仓库了（位置：`outputs\lol-spy`），只差"推到网上"。
下面两条路选一条。

### 路线 A：网页上传（不用碰命令行）

1. 打开 [github.com](https://github.com) 注册或登录。
2. 右上角 `+` → `New repository`。
3. 填 `Repository name`：`lol-spy`；下面选 **Public**；
   **不要**勾 `Add a README file`、`.gitignore`、`license`（勾了会产生冲突）。
4. 点 `Create repository`，然后在新页面点 `uploading an existing file`。
5. 在文件资源管理器里打开 `C:\Users\dengcong\Documents\Codex\2026-09-24\bang\outputs\lol-spy`，
   按 `Ctrl+A` 全选里面的**内容**，拖进浏览器那个上传框。
   （`.git` 文件夹是隐藏的，全选不会带上它，正好。要拖的是文件夹**里面**的东西，不要拖 `lol-spy` 这个文件夹本身。）
6. 点绿按钮 `Commit changes`。

完成后仓库首页应该直接看得到 `server.js`、`README.md`、`public` 等文件。

### 路线 B：命令行推送（机器上已经装好 git 了）

先在 GitHub 上按上面第 1–4 步建一个**空仓库**（名字同样叫 `lol-spy`），
然后把页面上给出的仓库地址复制下来，执行：

```powershell
cd C:\Users\dengcong\Documents\Codex\2026-09-24\bang\outputs\lol-spy
git remote add origin https://github.com/你的用户名/lol-spy.git
git push -u origin main
```

推送时 Windows 会弹出登录 GitHub 的窗口，登录一次即可（凭据会被记住）。

---

## 第 2 步：在 Render 上建服务

1. 打开 [render.com](https://render.com)，用 GitHub 账号登录（这样省掉授权那一步）。
2. 右上角 `New +` → **`Blueprint`** → 选中刚才的 `lol-spy` 仓库 → `Connect`。
   Render 会自动读取仓库里的 `render.yaml`，把服务配置好（免费实例、启动命令 `node server.js`、健康检查 `/healthz`）。
3. 如果它要你确认 `Instance Type`，保持 **Free**；`Region` 建议选 **Singapore**（离国内最近）。
4. 点 `Apply` / `Create`，等 1–2 分钟。

> 如果 Blueprint 那一步报错或找不到仓库，改用 `New +` → `Web Service`，
> 手动填：Runtime = `Node`，Build Command = **留空**（项目零依赖，不需要装任何东西），
> Start Command = `node server.js`，Instance Type = `Free`。

部署完成后，页面顶部会显示你的网址，例如 `https://lol-spy-abc1.onrender.com`。

---

## 第 3 步：验证（一分钟）

浏览器打开 `你的网址/healthz`，应该看到 `{"ok":true,...}`。

再打开 `你的网址`，能创建房间就成功了。把这个网址发群里，任何人都能自己开一间房当房主。

---

## 第 4 步（强烈建议）：加个监控，让它别睡

Render 免费实例**15 分钟没人访问就休眠**，下一个人打开要等 30–60 秒冷启动，
容易被人当成"网站挂了"。解决方法是找个免费监控定时戳它一下：

1. 注册 [uptimerobot.com](https://uptimerobot.com)（免费档够用）。
2. `Add New Monitor` → 类型选 `HTTP(s)`。
3. URL 填 `你的网址/healthz`，检查间隔 `5 minutes`。

这样服务会一直醒着，冷启动问题消失。代价是它 24 小时占用一点免费额度，日常使用完全没问题。

---

## 需要知道的取舍

- **房间数据存在内存里**：服务重启或你重新部署新版本，正在进行的房间会消失（页面会提示"会话已失效"），重新开一间即可。加了第 4 步的监控之后，休眠导致的丢房间基本不会发生了。
- **必须保持单实例**：不要给这个服务开多实例/自动扩容，房间状态在内存里，多实例会各存一份。
- **仓库必须是 Public 最省事**：私有仓库也能部署，但要在 Render 里额外授权访问权限。

## 常见报错

| 现象 | 原因 |
| --- | --- |
| Render 构建失败，提示找不到 `package.json` | 仓库根目录不是项目根目录。仓库首页必须直接看得到 `package.json`，不能是 `lol-spy/package.json` |
| 打开网址一直转圈 | 免费实例在冷启动，等 30–60 秒；或去看 Render 的 Logs 页 |
| 提示 `SESSION_GONE` | 服务重启过，房间没了，重新开一间 |
| 能创建房间但别人打不开 | 把完整网址再确认一遍，注意是 `https://` 开头、没有多余空格 |
