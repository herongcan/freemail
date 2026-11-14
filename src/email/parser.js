/**
 * 邮件解析模块
 * @module email/parser
 */

import PostalMime from 'postal-mime';

// 单个附件落库上限：base64 后约为原始的 1.37 倍，1MB 可安全落在 D1 单行 2MB 限制内
const MAX_ATTACHMENT_BYTES = 1024 * 1024;

/**
 * 将二进制内容编码为 base64（Workers 无 Buffer，分块拼串避免超长参数栈溢出）
 * @param {Uint8Array} bytes - 字节数组
 * @returns {string} base64 字符串
 */
function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * 归一化 MIME 部件内容为字节数组
 * @param {ArrayBuffer|Uint8Array|string} content - 部件内容
 * @returns {Uint8Array|null} 字节数组
 */
function toBytes(content) {
  if (!content) return null;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  if (ArrayBuffer.isView(content)) return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  if (typeof content === 'string') return new TextEncoder().encode(content);
  return null;
}

/**
 * 解析邮件正文与附件，提取文本、HTML、已解码主题和内嵌图片
 * 说明：message.headers 取到的是 RFC 2047 原始编码串（如 =?UTF-8?B?xxx?=），
 * 需借用 postal-mime 解码后才能正常显示中文主题；
 * HTML 中的内嵌图片是 cid: 引用，必须连同附件一起保存才能显示。
 * @param {string} raw - 原始邮件内容 (EML 格式)
 * @returns {Promise<object>} 包含 text、html、subject、attachments 属性的对象
 */
export async function parseEmailBody(raw) {
  if (!raw) return { text: '', html: '', subject: '', attachments: [] };
  const email = await PostalMime.parse(raw);

  const attachments = [];
  for (const part of (email.attachments || [])) {
    try {
      const bytes = toBytes(part.content);
      if (!bytes || bytes.length === 0) continue;
      const disposition = String(part.disposition || '').toLowerCase();
      attachments.push({
        filename: part.filename || '',
        mimeType: part.mimeType || 'application/octet-stream',
        contentId: String(part.contentId || '').replace(/^</, '').replace(/>$/, ''),
        size: bytes.length,
        isInline: disposition === 'inline' || !!part.contentId || !!part.related,
        // 超过上限的附件只留元信息，正文里会降级为下载入口，不至于撑爆 D1 单行
        base64: bytes.length <= MAX_ATTACHMENT_BYTES ? bytesToBase64(bytes) : '',
      });
    } catch (_) { }
  }

  return {
    text: email.text || '',
    html: email.html || '',
    subject: email.subject || '',
    attachments,
  };
}

/**
 * 从邮件主题、文本和HTML中智能提取验证码（4-8位数字）
 * @param {object} params - 提取参数对象
 * @param {string} params.subject - 邮件主题
 * @param {string} params.text - 纯文本内容
 * @param {string} params.html - HTML内容
 * @returns {string} 提取的验证码，如果未找到返回空字符串
 */
export function extractVerificationCode({ subject = '', text = '', html = '' } = {}) {
  const subjectText = String(subject || '');
  const textBody = String(text || '').replace(/\s+/g, ' ').trim();
  const htmlBody = stripHtml(html).replace(/\s+/g, ' ').trim();

  const sources = {
    subject: subjectText,
    body: (textBody || htmlBody || '').trim()
  };

  const minLen = 4;
  const maxLen = 8;

  function normalizeDigits(s) {
    const digits = String(s || '').replace(/\D+/g, '');
    if (digits.length >= minLen && digits.length <= maxLen) return digits;
    return '';
  }

  const kw = '(?:verification|one[-\\s]?time|two[-\\s]?factor|2fa|security|auth|login|confirm|code|otp|验证码|校验码|驗證碼|確認碼|認證碼|認証コード|인증코드|코드)';
  const sepClass = "[\\u00A0\\s\\-–—_.·•∙‧'']";
  const codeChunk = `([0-9](?:${sepClass}?[0-9]){3,7})`;

  const subjectOrdereds = [
    new RegExp(`${kw}[^\n\r\d]{0,20}(?<!\\d)${codeChunk}(?!\\d)`, 'i'),
    new RegExp(`(?<!\\d)${codeChunk}(?!\\d)[^\n\r\d]{0,20}${kw}`, 'i'),
  ];
  for (const r of subjectOrdereds) {
    const m = sources.subject.match(r);
    if (m && m[1]) {
      const n = normalizeDigits(m[1]);
      if (n) return n;
    }
  }

  const bodyOrdereds = [
    new RegExp(`${kw}[\\s\\S]{0,30}?(?<!\\d)${codeChunk}(?!\\d)`, 'i'),
    new RegExp(`(?<!\\d)${codeChunk}(?!\\d)[\\s\\S]{0,30}?${kw}`, 'i'),
  ];
  for (const r of bodyOrdereds) {
    const m = sources.body.match(r);
    if (m && m[1]) {
      const n = normalizeDigits(m[1]);
      if (n) return n;
    }
  }

  const looseBodyOrdereds = [
    new RegExp(`${kw}[\\s\\S]{0,80}?(?<!\\d)${codeChunk}(?!\\d)`, 'i'),
    new RegExp(`(?<!\\d)${codeChunk}(?!\\d)[\\s\\S]{0,80}?${kw}`, 'i'),
  ];
  for (const r of looseBodyOrdereds) {
    const m = sources.body.match(r);
    if (m && m[1]) {
      const n = normalizeDigits(m[1]);
      if (n && !isLikelyNonVerificationCode(n, sources.body)) {
        return n;
      }
    }
  }

  return '';
}

function stripHtml(html) {
  const s = String(html || '');
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, n) => {
      try { return String.fromCharCode(parseInt(n, 10)); } catch (_) { return ' '; }
    })
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLikelyNonVerificationCode(digits, context = '') {
  if (!digits) return true;

  const year = parseInt(digits, 10);
  if (digits.length === 4 && year >= 2000 && year <= 2099) {
    return true;
  }

  if (digits.length === 5) {
    const lowerContext = context.toLowerCase();
    if (lowerContext.includes('address') ||
      lowerContext.includes('street') ||
      lowerContext.includes('zip') ||
      lowerContext.includes('postal') ||
      /\b[a-z]{2,}\s+\d{5}\b/i.test(context)) {
      return true;
    }
  }

  const addressPattern = new RegExp(`\\b${digits}\\s+[A-Z][a-z]+(?:,|\\b)`, 'i');
  if (addressPattern.test(context)) {
    return true;
  }

  return false;
}