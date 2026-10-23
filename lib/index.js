const { Schema, h, Logger } = require('koishi')

const name = 'dyks-parser'
const logger = new Logger(name)

/** 支持合并转发（figure / message 节点）的平台 */
const FORWARD_PLATFORMS = new Set([
  'onebot',
  'napcat',
  'red',
  'yunhu',
  'telegram',
  'discord',
])

const Config = Schema.intersect([
  Schema.object({
    endpoint: Schema.string()
      .default('http://127.0.0.1:8051')
      .description('Media-Parser 服务地址，末尾不要带斜杠'),
    apiKey: Schema.string()
      .default('')
      .description('API Key；纯 API 模式（API_ONLY=true）留空即可'),
    enableDouyin: Schema.boolean().default(true).description('解析抖音链接'),
    enableKuaishou: Schema.boolean().default(true).description('解析快手链接'),
    useForward: Schema.boolean()
      .default(true)
      .description('以合并转发发送（仅 onebot / napcat 等支持合并转发的平台）'),
    forwardNickname: Schema.string()
      .default('')
      .description('合并转发节点昵称；留空则使用发链接用户的昵称'),
    videoMode: Schema.union([
      Schema.const('url').description('直链发送（省内存，个别适配器可能拉不动）'),
      Schema.const('buffer').description('先下载再发送（更稳，大视频占内存）'),
    ]).default('url').description('视频发送方式'),
    sendInfo: Schema.boolean().default(true).description('发送标题 / 作者 / 简介 / 原链接'),
    sendCover: Schema.boolean().default(false).description('发送封面图'),
    showWaiting: Schema.boolean().default(true).description('显示“正在解析…”提示'),
    waitingText: Schema.string()
      .role('textarea', { rows: [2, 5] })
      .default('正在解析…')
      .description('“正在解析…”提示的自定义文案（可多行）；留空则使用默认文案'),
    maxImages: Schema.number().min(1).max(30).default(9).description('图集最多发送张数'),
    timeout: Schema.number().default(60000).description('请求超时（毫秒）'),
    dedupeSeconds: Schema.number().min(0).default(30).description('同一链接去重秒数，0 为不去重'),
    parseQuote: Schema.boolean()
      .default(false)
      .description('解析引用消息里的链接（默认关闭，避免引用聊天记录 / 合并转发时误触发）'),
    command: Schema.string().default('').description('仅响应以此开头的消息（如 dyks）；留空则自动识别所有消息'),
  }).description('基础设置'),
])

/**
 * 判断消息 / 引用是否是合并转发（聊天记录）。
 * 合并转发消息的 content 可能是序列化 JSON（含 "forward"/"messages"）或占位文本，
 * 其中的链接不应被当作分享链接解析。
 */
function isForwardLike(source) {
  if (!source) return false
  const elements = source.elements
  if (Array.isArray(elements)) {
    if (elements.some((el) => el && (el.type === 'forward' || el.type === 'figure'))) return true
  }
  const content = typeof source.content === 'string' ? source.content : ''
  return (
    content.includes('"forward"') ||
    content.includes('"messages"') ||
    content.includes('[转发消息]')
  )
}

/** 取当前消息（以及按配置取引用消息）里的纯文本 */
function getText(session, config) {
  const chunks = []
  // 当前消息本身是合并转发时，跳过（避免从转发 JSON 里抠出链接）
  if (session.content && !isForwardLike(session)) chunks.push(session.content)
  if (config.parseQuote && session.quote && session.quote.content && !isForwardLike(session.quote)) {
    chunks.push(session.quote.content)
  }
  return chunks.join('\n')
}

/** 从文本里提取抖音 / 快手链接 */
function extractLinks(text) {
  const out = []
  if (!text) return out
  const re = /https?:\/\/[^\s<>"'，。；：！？）)】\]]+/gi
  let m
  while ((m = re.exec(text))) {
    const url = m[0].replace(/[.,;:!?]+$/, '')
    // 跳过序列化 JSON / HTML 转义残留（如 &quot;），那不是用户分享的链接
    if (/&(quot|amp|lt|gt|#\d+);/i.test(url)) continue
    let host
    try {
      host = new URL(url).hostname.toLowerCase()
    } catch {
      continue
    }
    let type = null
    if (host === 'douyin.com' || host.endsWith('.douyin.com')) type = 'douyin'
    else if (host === 'iesdouyin.com' || host.endsWith('.iesdouyin.com')) type = 'douyin'
    else if (host === 'kuaishou.com' || host.endsWith('.kuaishou.com')) type = 'kuaishou'
    if (type && !out.some((x) => x.url === url)) out.push({ url, type })
  }
  return out
}

/**
 * 统一取出响应体。
 * Koishi 4.18+（@cordisjs/plugin-http）的 ctx.http.get 直接返回响应体；
 * 旧版（axios）返回 { data }。两种形态都兼容。
 */
function unwrapBody(res) {
  if (!res || typeof res !== 'object') return res
  if ('succ' in res || 'retcode' in res || 'retdesc' in res) return res
  if (res.data && typeof res.data === 'object') return res.data
  return res
}

/** 下载媒体到内存（带 UA，避免直链被拒） */
async function fetchBuffer(ctx, url, timeout) {
  const res = await ctx.http.get(url, {
    responseType: 'arraybuffer',
    timeout,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    },
  })
  // 同上：直接返回响应体，旧版为 { data }
  return Buffer.from(res && res.data ? res.data : res)
}

/** 拼装文字消息（风格对齐 bilibili 解析插件的模板：标题 / 作者 / 简介 / 链接） */
function buildInfoText(data, link, config) {
  const lines = []
  const title = data.title ? String(data.title).trim() : ''
  const author = data.author && (data.author.nickname || data.author.author_id)
  if (title) lines.push(title.slice(0, 120))
  if (config.sendInfo) {
    if (author) lines.push('作者：' + author)
    if (data.platform) lines.push('平台：' + data.platform)
    const desc = data.desc ? String(data.desc).trim() : ''
    if (desc && desc !== title) {
      lines.push(desc.length > 200 ? desc.slice(0, 200) + '…' : desc)
    }
  }
  lines.push('链接：' + link.url)
  return lines.join('\n')
}

/** 构建视频消息；buffer 模式先下载再发 */
async function buildVideoSegment(ctx, url, config) {
  if (config.videoMode === 'buffer') {
    const buf = await fetchBuffer(ctx, url, Math.max(config.timeout, 120000))
    return h.video('data:video/mp4;base64,' + buf.toString('base64'))
  }
  return h.video(url)
}

/**
 * 发送消息数组。
 * 合并转发：与 koishi-plugin-bilibili-videolink-analysis 相同，用 figure + message 节点。
 * 平台不支持或转发失败时，降级为逐条发送。
 */
async function sendMessages(session, messages, videoUrl, config) {
  if (config.useForward && FORWARD_PLATFORMS.has(session.platform)) {
    try {
      const figure = h('figure')
      const attrs = {
        userId: session.userId,
        nickname: config.forwardNickname || session.author?.nickname || session.username,
      }
      for (const message of messages) {
        figure.children.push(h('message', attrs, message))
      }
      await session.send(figure)
      return
    } catch (e) {
      logger.warn('forward send failed: %s', e && e.message)
      // 降级为逐条发送
    }
  }

  for (const message of messages) {
    try {
      await session.send(message)
    } catch (e) {
      logger.warn('send failed: %s', e && e.message)
      const isVideo = Array.isArray(message) && message.some((seg) => seg && seg.type === 'video')
      if (isVideo && videoUrl) {
        // 视频发不出去时至少把直链给用户
        await session.send('视频发送失败，直链：' + videoUrl).catch(() => {})
      }
    }
  }
}

async function sendResult(ctx, session, data, link, config) {
  const messages = []
  const videoUrl =
    data.video_url || (Array.isArray(data.video_list) ? data.video_list[0] : '')

  const images = []
  for (const item of data.image_list || []) {
    const url = typeof item === 'string' ? item : item && (item.url || item.image)
    if (url) images.push(url)
  }

  if (config.sendInfo) messages.push(buildInfoText(data, link, config))

  if (config.sendCover && data.cover_url) messages.push(h.image(data.cover_url))

  if (videoUrl) {
    try {
      messages.push(await buildVideoSegment(ctx, videoUrl, config))
    } catch (e) {
      logger.warn('video build failed: %s', e && e.message)
      // 视频构建失败不影响其余内容
    }
  } else if (images.length) {
    for (const url of images.slice(0, config.maxImages)) messages.push(h.image(url))
  }

  if (!messages.length) return
  await sendMessages(session, messages, videoUrl, config)
}

function apply(ctx, config) {
  const endpoint = String(config.endpoint || '').replace(/\/+$/, '')
  if (!endpoint) {
    logger.warn('未配置 endpoint，插件不工作')
    return
  }
  const seen = new Map()

  function duplicated(url) {
    if (!config.dedupeSeconds) return false
    const now = Date.now()
    for (const [k, t] of seen) {
      if (now - t > config.dedupeSeconds * 1000) seen.delete(k)
    }
    if (seen.has(url)) return true
    seen.set(url, now)
    return false
  }

  // 用 middleware 而不是 ctx.on('message')：匹配到链接后不调用 next()，
  // 让链接消息在本插件处理完就终止，避免对话插件（chatluna 等）再对同一条消息响应。
  ctx.middleware(async (session, next) => {
    const text = getText(session, config)
    if (config.command && !text.trimStart().startsWith(config.command)) return next()
    const links = extractLinks(text).filter((link) =>
      link.type === 'douyin' ? config.enableDouyin : config.enableKuaishou
    )
    if (!links.length) return next()

    for (const link of links) {
      if (duplicated(link.url)) continue
      try {
        if (config.showWaiting) await session.send(config.waitingText || '正在解析…')
        const res = await ctx.http.get(endpoint + '/api/v1/parse', {
          params: { url: link.url, ...(config.apiKey ? { key: config.apiKey } : {}) },
          timeout: config.timeout,
        })
        const body = unwrapBody(res)
        if (!body || body.succ === false || !body.data) {
          logger.warn('parse failed: %s / %s', link.url, body && body.retdesc)
          await session.send('解析失败：' + ((body && body.retdesc) || '未知错误'))
          continue
        }
        await sendResult(ctx, session, body.data, link, config)
      } catch (e) {
        logger.warn('parse error: %s / %s', link.url, e && e.message)
        await session.send('解析失败，请稍后再试')
      }
    }
    // 不调用 next()：链接消息到此为止，后续插件（对话等）不再响应
  })
}

module.exports = { name, Config, apply }
