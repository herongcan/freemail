/**
 * 邮件事件处理器
 * @module email/handler
 */

import { getInitializedDatabase } from '../db/index.js';
import { extractEmail, normalizeEmailAlias } from '../utils/common.js';
import { forwardByLocalPart, forwardByMailboxConfig } from './forwarder.js';
import { parseEmailBody, extractVerificationCode } from './parser.js';
import { getForwardTarget } from '../db/mailboxes.js';
import { invalidateSystemStatCache } from '../utils/cache.js';

export async function handleEmailEvent(message, env, ctx) {
  let DB;
  try {
    DB = await getInitializedDatabase(env);
  } catch (error) {
    console.error('邮件处理时数据库连接失败:', error.message);
    return;
  }

  try {
    const headers = message.headers;
    const toHeader = headers.get('to') || headers.get('To') || '';
    const fromHeader = headers.get('from') || headers.get('From') || '';
    const subject = headers.get('subject') || headers.get('Subject') || '(无主题)';

    let envelopeTo = '';
    try {
      const toValue = message.to;
      if (Array.isArray(toValue) && toValue.length > 0) {
        envelopeTo = typeof toValue[0] === 'string' ? toValue[0] : (toValue[0].address || '');
      } else if (typeof toValue === 'string') {
        envelopeTo = toValue;
      }
    } catch (_) { }

    const resolvedRecipient = (envelopeTo || toHeader || '').toString();
    const resolvedAddr = extractEmail(resolvedRecipient);
    const normalizedAddr = normalizeEmailAlias(resolvedAddr);
    const localPart = (normalizedAddr.split('@')[0] || '').toLowerCase();

    const mailboxForwardTo = await getForwardTarget(DB, normalizedAddr);
    let result;
    if (mailboxForwardTo) {
      result = forwardByMailboxConfig(message, mailboxForwardTo, ctx);
    } else {
      result = forwardByLocalPart(message, localPart, ctx, env);
    }
    if (result.hasTarget && !result.forwarded) {
      message.setReject('Forward failed');
    }

    let textContent = '';
    let htmlContent = '';
    let decodedSubject = '';
    let rawBuffer = null;
    try {
      const resp = new Response(message.raw);
      rawBuffer = await resp.arrayBuffer();
      const rawText = new TextDecoder().decode(rawBuffer);
      const parsed = await parseEmailBody(rawText);
      textContent = parsed.text || '';
      htmlContent = parsed.html || '';
      decodedSubject = parsed.subject || '';
      if (!textContent && !htmlContent) textContent = (rawText || '').slice(0, 100000);
    } catch (_) { }

    const mailbox = normalizedAddr || normalizeEmailAlias(extractEmail(toHeader));
    const sender = extractEmail(fromHeader);

    const r2 = env.MAIL_EML;
    let objectKey = '';
    try {
      const now = new Date();
      const y = now.getUTCFullYear();
      const m = String(now.getUTCMonth() + 1).padStart(2, '0');
      const d = String(now.getUTCDate()).padStart(2, '0');
      const hh = String(now.getUTCHours()).padStart(2, '0');
      const mm = String(now.getUTCMinutes()).padStart(2, '0');
      const ss = String(now.getUTCSeconds()).padStart(2, '0');
      const keyId = (globalThis.crypto?.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const safeMailbox = (mailbox || 'unknown').toLowerCase().replace(/[^a-z0-9@._-]/g, '_');
      objectKey = `${y}/${m}/${d}/${safeMailbox}/${hh}${mm}${ss}-${keyId}.eml`;
      if (r2 && rawBuffer) {
        await r2.put(objectKey, new Uint8Array(rawBuffer), { httpMetadata: { contentType: 'message/rfc822' } });
      }
    } catch (e) { console.error('R2 put failed:', e); }

    // 未绑定 R2 时清空对象键：正文已存 D1，此时不应再给出无法下载的 .eml 入口
    if (!r2) objectKey = '';

    const preview = String(
      (textContent?.trim() ? textContent : (htmlContent || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()) || ''
    ).slice(0, 120);
    // 主题优先用解码后的值，避免中文主题显示成 =?UTF-8?B?...?=
    const finalSubject = decodedSubject || subject || '(无主题)';

    let verificationCode = '';
    try { verificationCode = extractVerificationCode({ subject: finalSubject, text: textContent, html: htmlContent }); } catch (_) { }

    const resMb = await DB.prepare('SELECT id FROM mailboxes WHERE address = ?').bind(mailbox.toLowerCase()).all();
    let mailboxId;
    if (Array.isArray(resMb?.results) && resMb.results.length) {
      mailboxId = resMb.results[0].id;
    } else {
      const [localPartMb, domain] = (mailbox || '').toLowerCase().split('@');
      if (localPartMb && domain) {
        await DB.prepare('INSERT INTO mailboxes (address, local_part, domain, password_hash, last_accessed_at) VALUES (?, ?, ?, NULL, CURRENT_TIMESTAMP)')
          .bind((mailbox || '').toLowerCase(), localPartMb, domain).run();
        invalidateSystemStatCache('total_mailboxes');
        const created = await DB.prepare('SELECT id FROM mailboxes WHERE address = ?').bind((mailbox || '').toLowerCase()).all();
        mailboxId = created?.results?.[0]?.id;
      }
    }
    if (!mailboxId) throw new Error('无法解析或创建 mailbox 记录');

    let toAddrs = '';
    try {
      const toValue = message.to;
      if (Array.isArray(toValue)) {
        toAddrs = toValue.map(v => (typeof v === 'string' ? v : (v?.address || ''))).filter(Boolean).join(',');
      } else if (typeof toValue === 'string') {
        toAddrs = toValue;
      } else {
        toAddrs = resolvedRecipient || toHeader || '';
      }
    } catch (_) { toAddrs = resolvedRecipient || toHeader || ''; }

    // 完整正文落库：未启用 R2 时这是正文的唯一来源，读取端已有回退逻辑消费这两列
    // 单列限长防止超出 D1 单行大小限制（超长邮件截断，不影响验证码与关键信息）
    const storedText = String(textContent || '').slice(0, 100000);
    const storedHtml = String(htmlContent || '').slice(0, 200000);

    try {
      await DB.prepare(`
        INSERT INTO messages (mailbox_id, sender, to_addrs, subject, verification_code, preview, r2_bucket, r2_object_key, content, html_content)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(mailboxId, sender, String(toAddrs || ''), finalSubject, verificationCode || null, preview || null, 'mail-eml', objectKey || '', storedText || null, storedHtml || null).run();
    } catch (insertErr) {
      // 老库未迁移（缺 content 列）时降级为原写入方式，保证邮件不丢
      console.error('正文落库失败，降级写入:', insertErr.message);
      await DB.prepare(`
        INSERT INTO messages (mailbox_id, sender, to_addrs, subject, verification_code, preview, r2_bucket, r2_object_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(mailboxId, sender, String(toAddrs || ''), finalSubject, verificationCode || null, preview || null, 'mail-eml', objectKey || '').run();
    }
  } catch (err) {
    console.error('Email event handling error:', err);
  }
}