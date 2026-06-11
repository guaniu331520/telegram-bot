const TOKEN = ENV_BOT_TOKEN
const WEBHOOK = '/endpoint'
const SECRET = ENV_BOT_SECRET
const ADMIN_UID = ENV_ADMIN_UID

function apiUrl(methodName, params = null) {
  let query = params ? '?' + new URLSearchParams(params).toString() : ''
  return `https://api.telegram.org/bot${TOKEN}/${methodName}${query}`
}

function requestTelegram(methodName, body) {
  return fetch(apiUrl(methodName), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }).then(r => r.json())
}

function sendMessage(chat_id, text) {
  return requestTelegram('sendMessage', { chat_id, text })
}

function copyMessage(chat_id, from_chat_id, message_id) {
  return requestTelegram('copyMessage', { chat_id, from_chat_id, message_id })
}

function forwardMessage(chat_id, from_chat_id, message_id) {
  return requestTelegram('forwardMessage', { chat_id, from_chat_id, message_id })
}

// 生成验证码
function generateCaptcha() {
  const a = Math.floor(Math.random() * 20) + 5
  const b = Math.floor(Math.random() * 15) + 5
  return {
    question: `请回答：${a} + ${b} = ? （只回复数字）`,
    answer: (a + b).toString()
  }
}

// ====================== 主逻辑 ======================
addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  
  if (url.pathname === WEBHOOK) {
    event.respondWith(handleWebhook(event))
  } 
  else if (url.pathname === '/' || url.pathname === '') {
    event.respondWith(activateBot(event, url))
  } 
  else {
    event.respondWith(new Response('Ok'))
  }
})

async function activateBot(event, requestUrl) {
  const webhookUrl = `${requestUrl.protocol}//${requestUrl.hostname}${WEBHOOK}`
  const r = await fetch(apiUrl('setWebhook', { url: webhookUrl, secret_token: SECRET }))
  const json = await r.json()
  return new Response('ok' in json && json.ok ? 'Ok' : JSON.stringify(json, null, 2))
}

async function handleWebhook(event) {
  if (event.request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== SECRET) {
    return new Response('Unauthorized', { status: 403 })
  }
  const update = await event.request.json()
  event.waitUntil(onUpdate(update))
  return new Response('Ok')
}

async function onUpdate(update) {
  if ('message' in update) {
    await onMessage(update.message)
  }
}

async function onMessage(message) {
  const chatId = message.chat.id
  if (chatId.toString() === ADMIN_UID) {
    return handleAdminMessage(message)
  }
  return handleGuestMessage(message)
}

// =============== 管理员消息处理 ===============
async function handleAdminMessage(message) {
  if (!message?.reply_to_message?.chat) {
    return sendMessage(ADMIN_UID, '请回复用户消息后再操作')
  }
  if (/^\/block$/.exec(message.text)) return handleBlock(message)
  if (/^\/unblock$/.exec(message.text)) return handleUnBlock(message)
  if (/^\/checkblock$/.exec(message.text)) return checkBlock(message)

  const guestChatId = await nfd.get('msg-map-' + message.reply_to_message.message_id, { type: "json" })
  if (guestChatId) {
    await copyMessage(guestChatId, message.chat.id, message.message_id)
  }
}

// =============== 用户消息处理（严格按你要求流程）===============
async function handleGuestMessage(message) {
  const chatId = message.chat.id
  const text = (message.text || '').trim()

  // 检查7天免验证期
  const verifiedUntil = await nfd.get(`verified_until-${chatId}`, { type: "json" })
  const now = Date.now()

  if (verifiedUntil && now < verifiedUntil) {
    return normalForward(message)
  }

  // 正在等待验证码答案
  let currentAnswer = await nfd.get(`current_answer-${chatId}`)
  let pendingMessageId = await nfd.get(`pending_msg-${chatId}`, { type: "json" })

  if (currentAnswer) {
    // 用户回复的是验证码答案
    if (text === currentAnswer) {
      await nfd.delete(`current_answer-${chatId}`)

      let verifyStep = await nfd.get(`verify_step-${chatId}`, { type: "json" }) || 0
      verifyStep++
      await nfd.put(`verify_step-${chatId}`, verifyStep, { expirationTtl: 3600 })

      if (verifyStep === 1) {
        await sendMessage(chatId, "✅ 验证通过！\n剩余还需验证次数 1 次\n\n请继续发送您的消息。")
        // 转发之前的那条触发验证的消息（A消息）
        if (pendingMessageId) {
          await normalForwardById(chatId, pendingMessageId)
          await nfd.delete(`pending_msg-${chatId}`)
        }
        return
      } 
      else if (verifyStep === 2) {
        const expireTime = now + 7 * 24 * 60 * 60 * 1000
        await nfd.put(`verified_until-${chatId}`, expireTime, { expirationTtl: 7 * 24 * 60 * 60 })
        await nfd.delete(`verify_step-${chatId}`)
        await sendMessage(chatId, "✅ 验证全部通过！\n\n您已获得7天免验证权限。")
        // 转发之前的那条触发验证的消息（B消息）
        if (pendingMessageId) {
          await normalForwardById(chatId, pendingMessageId)
          await nfd.delete(`pending_msg-${chatId}`)
        }
        return
      }
    } else {
      return sendMessage(chatId, "❌ 答案错误，请重新回答上面的题目。")
    }
  }

  // 用户发送的是新消息，需要触发验证
  const captcha = generateCaptcha()
  await nfd.put(`current_answer-${chatId}`, captcha.answer, { expirationTtl: 600 })
  await nfd.put(`pending_msg-${chatId}`, message.message_id, { expirationTtl: 600 }) // 记录这条消息
  return sendMessage(chatId, captcha.question)
}

async function normalForward(message) {
  const chatId = message.chat.id
  const forwardReq = await forwardMessage(ADMIN_UID, chatId, message.message_id)
  if (forwardReq.ok) {
    await nfd.put('msg-map-' + forwardReq.result.message_id, chatId)
  }
}

async function normalForwardById(chatId, messageId) {
  const forwardReq = await forwardMessage(ADMIN_UID, chatId, messageId)
  if (forwardReq.ok) {
    await nfd.put('msg-map-' + forwardReq.result.message_id, chatId)
  }
}

// 屏蔽相关函数（保持不变）
async function handleBlock(message) {
  const guestId = await nfd.get('msg-map-' + message.reply_to_message.message_id, { type: "json" })
  if (guestId === ADMIN_UID) return sendMessage(ADMIN_UID, '不能屏蔽自己')
  await nfd.put('isblocked-' + guestId, true)
  return sendMessage(ADMIN_UID, `UID:${guestId} 已屏蔽`)
}

async function handleUnBlock(message) {
  const guestId = await nfd.get('msg-map-' + message.reply_to_message.message_id, { type: "json" })
  await nfd.put('isblocked-' + guestId, false)
  return sendMessage(ADMIN_UID, `UID:${guestId} 已解除屏蔽`)
}

async function checkBlock(message) {
  const guestId = await nfd.get('msg-map-' + message.reply_to_message.message_id, { type: "json" })
  const blocked = await nfd.get('isblocked-' + guestId, { type: "json" })
  return sendMessage(ADMIN_UID, `UID:${guestId} ${blocked ? '已被屏蔽' : '未被屏蔽'}`)
}
