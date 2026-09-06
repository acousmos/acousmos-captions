# Acousmos Captions

**给 X(Twitter)视频加上双语 AI 字幕,原文那一行始终在屏幕上。**([English](README.md))

语音识别和翻译都用你自己的 Key。开源,没有订阅。[Acousmos](https://acousmos.com) 出品。

---

## 为什么做这个

X 上的视频大多没有字幕。现有的翻译插件把「AI 生成字幕」锁在订阅后面,就算允许自带 Key,也只开放翻译那一层,语音识别仍然走它们的服务器。开源的替代方案则要装本地程序或自己跑 Docker。

Acousmos Captions 换了一个立场:

- **原文和译文一起显示。** 你多半听得懂一部分原文,只是跟不上语速。原文那一行留在屏幕上当依据,译文在下面当辅助。译文不准的时候,原文救你;只显示译文的字幕做不到这一点。
- **从头到尾自带 Key。** 语音识别的 Key(Deepgram 或 Soniox)和翻译模型的 Key(OpenAI 兼容接口、Gemini、Anthropic)都是你自己的,只存在你的浏览器里,只发给你选的服务商。
- **没有订阅。** X 的视频很短,用自己的 Key 转写一条只要几分钱。这里没有值得每月十美元的东西。

## 它怎么工作

```
X 视频页面 → 视频自带字幕的,直接翻译
          → 没有的,在你自己的浏览器会话里截取视频流(不经过任何服务器下载)
          → 取出纯音频的 HLS 轨道并拼接
          → 带时间戳的语音识别(Deepgram nova-3 或 Soniox stt-async-v5)
          → 生成字幕条:按句合并,只在太长时才切;每个边界都是识别给出的时间戳
          → 翻译模型按字幕条 id 翻译文字(时间戳不离开你的机器)
          → 在原生播放器上叠加双语字幕,可导出 SRT
```

几条硬约束:

- **时间轴不可动。** 翻译模型只拿到「id 加文字」,不能重排、合并或改时间;译文按 id 贴回识别结果的锚点上。
- **原文先出,译文陆续到。** 识别一结束原文字幕就出现,译文按批填进来。
- **你的会话,你的视频。** 音频在你已登录的浏览器会话里获取,和播放器自己取流是同一条路,不经过任何代理。
- **有缓存。** 结果存在本地,重看不花钱。

## 安装

Chrome 应用商店上架之前,按下面装:

1. 下载最新的 release 压缩包并解压,含 `manifest.json` 的那个目录就是扩展。从源码构建(`pnpm build`)得到的是同样的文件,在 `dist/` 里。
2. 打开 `chrome://extensions`,打开右上角的「开发者模式」。
3. 点「加载已解压的扩展程序」,选那个目录。
4. 打开扩展的「设置」,填一个语音识别 Key 和一个翻译 Key。
5. 打开任意一条 X 视频,点播放器上的 **CC**。

### Key 从哪里来

| 层 | 服务商 | 申请地址 |
|---|---|---|
| 语音识别 | Deepgram(默认,`nova-3`) | console.deepgram.com,有不少免费额度 |
| 语音识别 | Soniox(`stt-async-v5`) | console.soniox.com |
| 翻译 | 任何 OpenAI 兼容接口(默认服务商,模型 `gpt-4.1-mini`;也可以是 DeepSeek、Groq、本地模型等) | 可配置接口地址和模型名;填非默认地址时设置页会请求该主机的访问权限 |
| 翻译 | Google Gemini(默认 `gemini-3.5-flash`) | aistudio.google.com/apikey |
| 翻译 | Anthropic(默认 `claude-haiku-4-5`) | console.anthropic.com |

Key 只存在 `chrome.storage.local` 里,不同步,不发给 Acousmos。

## 开发

```sh
pnpm install
pnpm dev        # 监听构建到 dist/
pnpm check      # 类型检查、单元测试、构建
pnpm zip        # 打包到 release/acousmos-captions-<version>.zip
```

技术栈:TypeScript(strict)、esbuild、vitest。零运行时依赖,每个服务商的接入都是普通的 `fetch`。

```
src/
  shared/    类型、设置结构、消息协议、多语言文案
  core/      纯逻辑:HLS 解析、媒体 id 关联、字幕条生成、SRT、语音识别与翻译服务商、缓存 ← 有单元测试
  bg/        MV3 service worker:取流、拼音频、任务流水线
  content/   找播放器、CC 按钮、双语叠加层、SRT 导出
  options/   设置页(Key、语言、显示)
  popup/     状态与快捷开关
```

## 隐私

见 [PRIVACY.md](PRIVACY.md)。一句话:没有遥测,数据链路里没有 Acousmos 的服务器,音频只发给你配置的语音识别服务商,文字只发给你配置的翻译模型。

## 许可

[MIT](LICENSE) © Acousmos
