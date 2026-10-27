# dsh-chatgpt2api-image

DeepSeek Harness 生图插件：把自托管的 chatgpt2api 服务接成 DSH 的 `generate_image` 工具。

结构参考 `dsh-agnes-multimodal`（MIT，原作者啾灵jiuling，镜像仓库 `xuan0708191-sketch/dsh-agnes-multimodal`）的骨架：一个 host 半（配置 API + 工具注册）+ 一个 client 半（设置页 + 图片卡片），图片走 DSH 自带的持久化附件通道、以 `offloaded: true` 的 image 块返回，模型上下文里仍然只有文本、界面照常出图。本插件代码是重新编写的，不含 Agnes 的代码、端点与密钥。

## 组成

| 组成 | 在哪 | 干什么 |
| --- | --- | --- |
| **ChatGPT 生图配置** | 设置 → ChatGPT 生图 | 端点 + 密钥 + 默认模型，持久化到 `$DSH_HOME/chatgpt2api-image.json`（0600 权限） |
| **`generate_image`** | 模型工具 | 文生图；带参考图时走 `/v1/images/edits` 改图/多图融合 |

没有视频工具：chatgpt2api 本来就没有视频接口，这一项是故意砍掉的。

## 先说清楚的几件事

- **没有演示密钥，也没有默认端点。** Agnes 插件留空会回退到一个公开共享密钥，本插件不这么做：不填自己的端点和密钥，工具会直接报错让你去填。别把别人的 ChatGPT 账号额度当免费午餐。本仓库里没有任何预置的服务器地址，首次使用必须自己填。
- **后端服务（需自托管）。** 本插件只是一个 DSH 客户端，它要接你自己的 chatgpt2api 服务才能生图。配套的修改版服务端见 [shimoyanyamua/chatgpt2api-fixed](https://github.com/shimoyanyamua/chatgpt2api-fixed)（基于 zuelu/chatgpt2api v1.9.5，恢复了 Turnstile 处理、放宽了图片流超时）；也可以用其他支持 `/v1/images/generations` 的兼容服务。
- **不要和 dsh-agnes-multimodal 同时启用。** 两者都注册了 `generate_image`，工具名会冲突。先在插件页把 Agnes 那包关掉（或卸掉）再装本包。
- **本包目前没有发布到 npm。** 所以 DSH 桌面版「设置 → 插件 → 输入包名」那条路装不上（市场只接受 curated registry 里的包，见 Agnes 仓库的 INSTALL.md）。先用下面的手动安装。
- **改图那条路还没对自托管服务实测过。** 文生图（`POST /v1/images/generations`，只发 prompt + model）已经在自托管的 1.9.5-fixed 服务上实测出过图；改图用的是标准 OpenAI multipart `/v1/images/edits` 形状，理论上兼容，但还没对该服务跑过。如果服务端拒了，工具会把服务端错误原样报出来，不会悄悄忽略参考图去生一张新图。
- **本插件装在你跑 DSH 的那台机器上，不是我这台 VM 上。** 我没法替你把它装进你的 DSH，下面步骤要你自己动手。
- **不再预填默认端点（v1.2.0 起）。** 设置页的端点框初始为空，公开版里不带任何作者自己的服务器地址；已保存过的配置不受影响（插件每次调用都先读已保存的配置）。
- **单张图显示有高度上限（v1.1.0 起）。** 单张生成的图在对话里最多显示 520px 高（1024×1536 的竖图约显示为 347×520），不再按对话栏宽度铺满一屏半；点击图片仍可放大看原图（lightbox，最大 92vw/92vh）。多张图仍是 64px 缩略图，点击同样放大。只改了显示，生成尺寸和原图文件不受影响。

## 安装（手动）

以 DSH Web UI（`npx @deepseek-ai/dsh web`）为例，桌面版把 `profiles/web` 换成 `profiles/desktop`（注意：从 0.2.0-rc.2 起 desktop profile 由 App 独占管理，命令行改它会被拒绝，桌面版用户请先完全退出 App 再动手，见 Agnes 仓库 INSTALL.md 的约束表）：

1. 备份 `$DSH_HOME/profiles/web/package.json` 和 `cordis.patch.yml`。
2. 把本包整个文件夹拷到 `$DSH_HOME/profiles/web/node_modules/dsh-chatgpt2api-image/`。
3. 打开 `$DSH_HOME/profiles/web/package.json`，在 `dsh.profile.bundles` 数组里加进 `"dsh-chatgpt2api-image"`。注意：只看这个数组本身，包进了 `dependencies` 不等于会被加载。
4. 重启 DSH（`dsh web`），**新开一个对话**再试。当前会话的工具表是插件加载前建立的快照，不会热更新。

验证加载：新会话里问助手「你现在有 `generate_image` 工具吗」。如果它说没有，先确认第 3 步的 bundles 数组真的写进去了，再重启一次。

## 配置

1. 打开 **设置 → ChatGPT 生图**。
2. 端点填你自己的 chatgpt2api 服务地址，结尾带 `/v1`，例如 `http://你的服务器地址:3000/v1`。
3. 密钥填你那台 chatgpt2api 服务配置里的 auth-key（不要发给别人，也不要写进任何公开仓库）。
4. 默认模型选 `gpt-image-2` 或 `gpt-image-2.5`，点「测试」——它发一个 `GET /models`，零成本校验密钥。
5. 点「保存」，新开对话后直接说人话：

```
生成一张图，一只橘猫在窗台上晒太阳
把这张图改成水彩风格          # 先发图，再说这句话（改图路径待实测）
```

## 工具参数（给模型看的，顺便给你参考）

- `prompt`：数组，每条生成一张图
- `model`：`gpt-image-2` / `gpt-image-2.5`，不填就用设置页的默认模型
- `size`：`auto`（默认）或 `1024x1024` / `1024x1536` / `1536x1024` / `1536x864` / `864x1536`
- `quality`：`auto` / `low` / `medium` / `high`
- `image`：参考图，支持用户附件的 64 位 sha256、本地路径、公开 URL、data URI
- `show`：默认 true，出图卡片；false 只落盘不展示

生成是串行的（一个 ChatGPT Plus 账号、一个额度池，并行只会更快撞限流），单张实测约 35–40 秒，工具超时按 360 秒设的。遇到 `upstream_verification_required` 会直接失败、不重试——那是服务端要求人工完成一次交互验证，重试过不了。

## 文件结构

```
dsh-chatgpt2api-image/
├── lib/
│   ├── index.js        # host 半：配置 API、generate_image 工具
│   └── client.js       # client 半：设置页、图片卡片、turn-tail 投递
├── cordis.patch.yml    # 挂载声明（insert 一行 chatgpt2api-image）
├── package.json
└── README.md
```

## 许可

MIT。结构参考的 Agnes 插件版权归原作者啾灵jiuling 所有；本插件的其余代码按 MIT 开源。
