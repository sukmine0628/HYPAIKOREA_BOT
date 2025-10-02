// @ts-nocheck
import { Telegraf, Markup } from 'telegraf';
import { google } from 'googleapis';

const bot = new Telegraf(process.env.BOT_TOKEN!);

/** ===== Google Sheets Auth ===== */
const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS!);
const auth = new google.auth.JWT({
  email: creds.client_email,
  key: creds.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

/** ===== Sheet Settings ===== */
const EMPLOYEE_SHEET_ID = process.env.GS_SHEET_ID!;
const EMPLOYEE_SHEET = 'Chat_ID';
const EMP_COL_CHATID = 0;   // A
const EMP_COL_NAME   = 1;   // B
const EMP_COL_ROLE   = 5;   // F (관리자)
const EMP_COL_APPROV = 6;   // G (승인)

const PURCHASE_SHEET_ID = process.env.GS_PURCHASE_SHEET_ID || EMPLOYEE_SHEET_ID;
const PURCHASE_SHEET = 'Purchase_List';

const CANCELLED_SHEET = 'Purchase_Cancelled'; // 취소 로그(공번 처리용 감지)

/** ===== Mgmt Support Settings ===== */
const MGMT_SUPPORT_CHAT_ID = '-4906337098'; // 경영지원 요청이 도착할 대상(그룹/채널) Chat ID

/** ===== Utils ===== */
async function authorize() { await auth.authorize(); }
const nowDate = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${dd}`;
};

async function getSpreadsheetMeta(spreadsheetId: string) {
  await authorize();
  return sheets.spreadsheets.get({ spreadsheetId });
}
async function getSheetIdIfExists(spreadsheetId: string, title: string) {
  const meta = await getSpreadsheetMeta(spreadsheetId);
  const s = meta.data.sheets?.find(x => x.properties?.title === title);
  return s?.properties?.sheetId;
}
async function ensureSheet(spreadsheetId: string, title: string) {
  let sid = await getSheetIdIfExists(spreadsheetId, title);
  if (sid !== undefined) return sid!;
  const r = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title } } }] },
  });
  return r.data.replies?.[0]?.addSheet?.properties?.sheetId!;
}

async function getEmployeeRow(chatId: string) {
  await authorize();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: EMPLOYEE_SHEET_ID,
    range: `${EMPLOYEE_SHEET}!A2:G`,
  });
  const rows = res.data.values || [];
  const idx = rows.findIndex(r => String(r[EMP_COL_CHATID]) === String(chatId));
  return idx >= 0 ? { rowIndex: idx + 2, row: rows[idx] } : null;
}
async function getEmployeeNameByChatId(chatId: string) {
  const hit = await getEmployeeRow(chatId);
  return hit?.row?.[EMP_COL_NAME] || '';
}
async function isApprovedEmployee(chatId: string) {
  const hit = await getEmployeeRow(chatId);
  return (hit?.row?.[EMP_COL_APPROV] || '').toString().trim() === '승인';
}
async function isManager(chatId: string) {
  const hit = await getEmployeeRow(chatId);
  return (hit?.row?.[EMP_COL_ROLE] || '').toString().trim() === '관리자';
}
async function getManagers() {
  await authorize();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: EMPLOYEE_SHEET_ID,
    range: `${EMPLOYEE_SHEET}!A2:G`,
  });
  const rows = res.data.values || [];
  return rows
    .filter(r => (r?.[EMP_COL_ROLE] || '').toString().trim() === '관리자')
    .map(r => ({ chatId: String(r[EMP_COL_CHATID]).trim(), name: String(r[EMP_COL_NAME] || '').trim() }));
}

async function findPurchaseRowByNo(reqNo: string) {
  await authorize();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!A2:A`,
  });
  const rows = res.data.values || [];
  for (let i = 0; i < rows.length; i++) if (String(rows[i][0]) === reqNo) return i + 2;
  return null;
}

async function listMyPendingRequests(chatId: string, limit = 10) {
  await authorize();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!A2:M`,
  });
  const rows = res.data.values || [];
  const mine = rows.filter(r => String(r[2]) === String(chatId) && (r[8] || '') === '대기중');
  mine.sort((a,b)=> (b[11]||'').localeCompare(a[11]||'')); // 요청일 내림차순
  return mine.slice(0, limit);
}
async function listAllPending(limit = 20) {
  await authorize();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!A2:M`,
  });
  const rows = res.data.values || [];
  const pend = rows.filter(r => (r[8] || '') === '대기중');
  pend.sort((a,b)=> (a[11]||'').localeCompare(b[11]||'')); // 오래된 순
  return pend.slice(0, limit);
}

async function isCancelledReqNo(reqNo: string) {
  const sid = await getSheetIdIfExists(PURCHASE_SHEET_ID, CANCELLED_SHEET);
  if (sid === undefined) return false;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${CANCELLED_SHEET}!A2:A`,
  });
  const rows = res.data.values || [];
  return rows.some(r => String(r[0]) === reqNo);
}

/** ===== Data Ops ===== */
async function saveEmployee(chatId: string, name: string) {
  await authorize();
  const date = nowDate();
  const hit = await getEmployeeRow(chatId);
  if (hit) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: EMPLOYEE_SHEET_ID,
      range: `${EMPLOYEE_SHEET}!B${hit.rowIndex}:E${hit.rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[name, '', '', date]] },
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: EMPLOYEE_SHEET_ID,
      range: `${EMPLOYEE_SHEET}!A:E`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[chatId, name, '', '', date]] },
    });
  }
}

async function savePurchase(chatId: string, name: string, item: string, qty: string, price: string, reason: string, note: string) {
  await authorize();
  const date = nowDate();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!A2:A`,
  });
  const rows = res.data.values || [];
  const last = rows.length ? rows[rows.length - 1][0] : null;

  let nextNo = '구매-001';
  if (typeof last === 'string' && last.startsWith('구매-')) {
    const n = parseInt(last.split('-')[1] || '0', 10);
    nextNo = `구매-${String((isNaN(n) ? 0 : n) + 1).padStart(3, '0')}`;
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!A:M`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[
      nextNo, name, chatId, item, qty, price, reason, note, '대기중', '', '', date, ''
    ]]},
  });

  return nextNo;
}

async function updateStatusApproved(reqNo: string, approverName: string) {
  await authorize();
  const row = await findPurchaseRowByNo(reqNo);
  if (!row) {
    if (await isCancelledReqNo(reqNo)) return { cancelled: true };
    throw new Error('요청 행 없음');
  }

  const cur = await sheets.spreadsheets.values.get({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!A${row}:M${row}`,
  });
  const curVals = cur.data.values?.[0] || [];
  if ((curVals[8] || '') !== '대기중') return { already: true, status: curVals[8], curVals };

  const date = nowDate();
  await sheets.spreadsheets.values.update({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!I${row}:M${row}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [['승인', approverName, '', curVals[11] || '', date]] },
  });
  return { already: false, curVals };
}

async function updateStatusRejected(reqNo: string, approverName: string, reason: string) {
  await authorize();
  const row = await findPurchaseRowByNo(reqNo);
  if (!row) {
    if (await isCancelledReqNo(reqNo)) return { cancelled: true };
    throw new Error('요청 행 없음');
  }

  const cur = await sheets.spreadsheets.values.get({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!A${row}:M${row}`,
  });
  const curVals = cur.data.values?.[0] || [];
  if ((curVals[8] || '') !== '대기중') return { already: true, status: curVals[8], curVals };

  const date = nowDate();
  await sheets.spreadsheets.values.update({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!I${row}:M${row}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [['반려', approverName, reason, curVals[11] || '', date]] },
  });
  return { already: false, curVals };
}

async function appendCancelledLog(rowVals: any[], cancelReason: string, cancelledById: string, cancelledByName: string) {
  await authorize();
  await ensureSheet(PURCHASE_SHEET_ID, CANCELLED_SHEET);
  const date = nowDate();
  await sheets.spreadsheets.values.append({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${CANCELLED_SHEET}!A:K`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[
      rowVals[0], // 번호
      rowVals[1], // 요청자 이름
      rowVals[2], // 요청자 ID
      rowVals[3], // 물품
      rowVals[4], // 수량
      rowVals[5], // 가격
      rowVals[11],// 요청일
      cancelReason,
      date,       // 취소일
      cancelledByName,
      cancelledById
    ]]},
  });
}

async function deleteRequestRow(reqNo: string) {
  await authorize();
  const rowIndex = await findPurchaseRowByNo(reqNo);
  if (!rowIndex) throw new Error('요청 행 없음');
  const sheetId = await ensureSheet(PURCHASE_SHEET_ID, PURCHASE_SHEET);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: PURCHASE_SHEET_ID,
    requestBody: { requests: [{
      deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: rowIndex - 1, endIndex: rowIndex } }
    }]},
  });
}

/** ===== Notify ===== */
async function broadcastToManagers(text: string) {
  const managers = await getManagers();
  for (const m of managers) { try { await bot.telegram.sendMessage(m.chatId, text); } catch {} }
}
async function notifyRequester(chatId: string, text: string) {
  try { await bot.telegram.sendMessage(chatId, text); } catch {}
}

/** ===== UI & Flow ===== */
function replyMenu(ctx: any) {
  return ctx.reply(
    '안녕하세요. 하이파이코리아입니다. 무엇을 도와드릴까요?',
    Markup.inlineKeyboard([
      [
        Markup.button.callback('신규 직원 등록', 'register_start'),
        Markup.button.callback('구매 요청 및 승인', 'purchase_menu'),
      ],
      [
        Markup.button.callback('경영지원 요청', 'support_request'),
      ],
    ])
  );
}

const REGISTER_PROMPT = '신규 직원 등록을 위해 성함을 입력해 주세요.';
const TRIGGER = /^(?:\/start|start|hi|hello|안녕|하이|헬로)\s*$/i;

bot.start(ctx => replyMenu(ctx));
bot.hears(TRIGGER, ctx => replyMenu(ctx));

/** 상태머신 & 메모리 */
type Stage = 'item' | 'qty' | 'price' | 'reason' | 'note';
type PurchaseState = { stage: Stage; data: { item?: string; qty?: string; price?: string; reason?: string; note?: string } };
const purchaseMem = new Map<number, PurchaseState>();
const ask = (ctx: any, message: string) => ctx.reply(message, { reply_markup: { force_reply: true } });

const rejectMem = new Map<number, { reqNo: string }>(); // 담당자 반려 사유
const cancelMem = new Map<number, { reqNo: string }>(); // 요청자 취소 사유

// === 경영지원 요청 상태 ===
type SupportStage = 'content' | 'deadline';
type SupportState = { stage: SupportStage; data: { content?: string; deadline?: string } };
const supportMem = new Map<number, SupportState>();
const supportConfirm = new Map<number, { content: string; deadline: string }>();

/** 액션들 */
bot.action('register_start', async ctx => {
  await ctx.answerCbQuery(); await ask(ctx, REGISTER_PROMPT);
});

bot.action('purchase_menu', async ctx => {
  await ctx.answerCbQuery();
  const approved = await isApprovedEmployee(String(ctx.from!.id));
  if (!approved) {
    return ctx.reply('사내 직원만 접근이 가능한 메뉴입니다. 관리자에게 승인 요청을 해주세요.');
  }
  await ctx.reply(
    '구매 메뉴입니다. 원하시는 작업을 선택하세요.',
    Markup.inlineKeyboard([
      [
        Markup.button.callback('구매 요청', 'purchase_request'),
        Markup.button.callback('구매 승인', 'purchase_approve'),
      ],
      [
        Markup.button.callback('내 요청 보기', 'purchase_mylist'),
        Markup.button.callback('뒤로 가기', 'go_back'),
      ],
    ])
  );
});

bot.action('purchase_request', async ctx => {
  await ctx.answerCbQuery();
  const approved = await isApprovedEmployee(String(ctx.from!.id));
  if (!approved) return ctx.reply('사내 직원 승인 후 이용 가능합니다.');
  purchaseMem.set(ctx.chat!.id, { stage: 'item', data: {} });
  await ask(ctx, '구매 요청을 시작합니다.\n① 물품명을 입력해 주세요.');
});

bot.action('purchase_approve', async ctx => {
  await ctx.answerCbQuery();
  if (!(await isManager(String(ctx.from!.id)))) {
    return ctx.reply('해당 메뉴에 대한 권한이 없습니다. 관리자에게 문의해주세요.');
  }
  const pend = await listAllPending(20);
  if (!pend.length) return ctx.reply('대기중인 구매 요청이 없습니다.');
  const lines = pend.map(r => `• ${r[0]} | ${r[3]} (${r[4]}) | ${r[1]} | ₩${Number(r[5]||0).toLocaleString()} | ${r[11]}`);
  const kb = Markup.inlineKeyboard(pend.map(r => [Markup.button.callback(`🔎 ${r[0]} 자세히`, `view|${r[0]}`)]));
  await ctx.reply('대기중 요약 목록\n' + lines.join('\n'), kb);
});

bot.action(/^view\|(.+)$/, async ctx => {
  await ctx.answerCbQuery();
  if (!(await isManager(String(ctx.from!.id)))) return ctx.reply('담당자 권한이 없습니다.');
  const reqNo = ctx.match[1];
  const row = await findPurchaseRowByNo(reqNo);
  if (!row) {
    if (await isCancelledReqNo(reqNo)) return ctx.reply(`이미 취소된 건입니다. (${reqNo})`);
    return ctx.reply('요청을 찾을 수 없습니다.');
  }
  const cur = await sheets.spreadsheets.values.get({
    spreadsheetId: PURCHASE_SHEET_ID, range: `${PURCHASE_SHEET}!A${row}:M${row}`,
  });
  const v = cur.data.values?.[0] || [];
  const msg =
    `번호: ${v[0]}\n요청자: ${v[1]}(${v[2]})\n물품: ${v[3]}\n수량: ${v[4]}\n가격: ₩${Number(v[5]||0).toLocaleString()}\n` +
    `사유: ${v[6]}\n비고: ${v[7]}\n상태: ${v[8]}\n요청일: ${v[11]}`;
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('✅ 승인', `approve|${reqNo}`), Markup.button.callback('❌ 반려', `reject|${reqNo}`)],
  ]);
  await ctx.reply(msg, kb);
});

bot.action('purchase_mylist', async ctx => {
  await ctx.answerCbQuery();
  const approved = await isApprovedEmployee(String(ctx.from!.id));
  if (!approved) return ctx.reply('사내 직원 승인 후 이용 가능합니다.');
  const mine = await listMyPendingRequests(String(ctx.chat!.id), 10);
  if (!mine.length) return ctx.reply('대기중인 구매 요청이 없습니다.');
  const text = '내 대기중 요청 (최대 10건)\n' + mine.map(r =>
    `• ${r[0]} | ${r[3]} (${r[4]}) | ₩${Number(r[5]||0).toLocaleString()} | ${r[11]}`
  ).join('\n');
  const rows = mine.map(r => [Markup.button.callback(`❌ ${r[0]} 취소`, `cancel|${r[0]}`)]);
  await ctx.reply(text, Markup.inlineKeyboard(rows));
});

bot.action('go_back', async ctx => {
  purchaseMem.delete(ctx.chat!.id);
  supportMem.delete(ctx.chat!.id);
  await replyMenu(ctx);
});

// === 경영지원 요청 시작 ===
bot.action('support_request', async ctx => {
  await ctx.answerCbQuery();
  const approved = await isApprovedEmployee(String(ctx.from!.id));
  if (!approved) return ctx.reply('사내 직원 승인 후 이용 가능합니다.');

  supportMem.set(ctx.chat!.id, { stage: 'content', data: {} });
  await ctx.reply(
    '경영 지원 요청 메뉴입니다. 아래에 요청사항을 작성해주세요.\n① 요청내용을 입력해 주세요.',
    { reply_markup: { force_reply: true } }
  );
});

// === 경영지원 요청 전송/취소 콜백 ===
bot.action('support_send', async ctx => {
  try {
    await ctx.answerCbQuery();
    const draft = supportConfirm.get(ctx.from!.id);
    if (!draft) return ctx.reply('요청 정보가 없습니다. 처음부터 다시 진행해 주세요.');

    const requesterName = (await getEmployeeNameByChatId(String(ctx.from!.id))) || `User-${ctx.from!.id}`;
    const msg =
      `[경영지원 요청]\n` +
      `요청자: ${requesterName}\n` + // ID는 표시하지 않음(내부정책)
      `요청내용: ${draft.content}\n` +
      `요청기한: ${draft.deadline}\n` +
      `요청일: ${nowDate()}`;

    try { await bot.telegram.sendMessage(MGMT_SUPPORT_CHAT_ID, msg); } catch {}

    supportConfirm.delete(ctx.from!.id);
    await ctx.reply('요청이 경영지원팀에 전달되었습니다. 감사합니다.');
    return replyMenu(ctx);
  } catch {
    await ctx.reply('처리 중 오류가 발생했습니다.');
  }
});

bot.action('support_cancel', async ctx => {
  try {
    await ctx.answerCbQuery();
    supportConfirm.delete(ctx.from!.id);
    await ctx.reply('요청이 취소되었습니다.');
    return replyMenu(ctx);
  } catch {
    await ctx.reply('처리 중 오류가 발생했습니다.');
  }
});

/** 텍스트 입력 처리 */
bot.on('text', async ctx => {
  try {
    const text = String((ctx.message as any)?.text || '').trim();
    const asked = (ctx.message as any)?.reply_to_message?.text || '';

    if (/^\/cancel$/i.test(text)) {
      purchaseMem.delete(ctx.chat!.id); rejectMem.delete(ctx.chat!.id); cancelMem.delete(ctx.chat!.id);
      supportMem.delete(ctx.chat!.id); supportConfirm.delete(ctx.chat!.id);
      await ctx.reply('취소되었습니다. /start 로 다시 시작하세요.'); return;
    }

    if (TRIGGER.test(text)) return replyMenu(ctx);

    // 직원 등록
    if (asked.startsWith(REGISTER_PROMPT)) {
      const name = text; if (!name) return;
      await saveEmployee(String(ctx.chat!.id), name);
      await ctx.reply(`${name}님 신규 직원 등록이 완료되었습니다 🙇`);
      return replyMenu(ctx);
    }

    // 반려 사유 입력(담당자)
    const rej = rejectMem.get(ctx.chat!.id);
    if (rej) {
      if (!(await isManager(String(ctx.chat!.id)))) {
        rejectMem.delete(ctx.chat!.id); return ctx.reply('담당자 권한이 없습니다.');
      }
      const approverName = (await getEmployeeNameByChatId(String(ctx.chat!.id))) || `User-${ctx.chat!.id}`;
      const res = await updateStatusRejected(rej.reqNo, approverName, text);
      if (res.cancelled) { rejectMem.delete(ctx.chat!.id); return ctx.reply(`이미 취소된 건입니다. (${rej.reqNo})`); }
      if (res.already) { rejectMem.delete(ctx.chat!.id); return ctx.reply(`이미 처리된 건입니다. (현재상태: ${res.status})`); }
      const requesterChatId = res.curVals[2];
      await broadcastToManagers(`[구매 요청 처리 안내]\n${rej.reqNo} 요청이 ❌반려되었습니다.\n처리자: ${approverName}\n사유: ${text}`);
      await notifyRequester(requesterChatId, `[구매 요청 결과]\n${rej.reqNo} 요청이 ❌반려되었습니다.\n처리자: ${approverName}\n사유: ${text}`);
      rejectMem.delete(ctx.chat!.id);
      return ctx.reply('반려 처리되었습니다.');
    }

    // 취소 사유 입력(요청자)
    const can = cancelMem.get(ctx.chat!.id);
    if (can) {
      const reqNo = can.reqNo;
      const row = await findPurchaseRowByNo(reqNo);
      if (!row) { cancelMem.delete(ctx.chat!.id); return ctx.reply('이미 취소되었거나 존재하지 않는 건입니다.'); }
      const cur = await sheets.spreadsheets.values.get({
        spreadsheetId: PURCHASE_SHEET_ID, range: `${PURCHASE_SHEET}!A${row}:M${row}`,
      });
      const v = cur.data.values?.[0] || [];
      if (String(v[2]) !== String(ctx.chat!.id)) {
        cancelMem.delete(ctx.chat!.id); return ctx.reply('본인 요청만 취소할 수 있습니다.');
      }
      if ((v[8] || '') !== '대기중') {
        cancelMem.delete(ctx.chat!.id); return ctx.reply(`이미 처리된 건입니다. (현재상태: ${v[8]})`);
      }

      // 로그 남기고(취소 시트) → 행 삭제(공번)
      const name = (await getEmployeeNameByChatId(String(ctx.chat!.id))) || `User-${ctx.chat!.id}`;
      await appendCancelledLog(v, text, String(ctx.chat!.id), name);
      await deleteRequestRow(reqNo);

      await broadcastToManagers(`[구매 요청 취소 안내]\n${reqNo} 요청이 사용자가 취소했습니다.\n요청자: ${name}\n사유: ${text}`);
      await notifyRequester(String(ctx.chat!.id), `[구매 요청 취소]\n${reqNo} 요청이 취소되었습니다.`);
      cancelMem.delete(ctx.chat!.id);
      return ctx.reply('요청이 취소되었습니다.');
    }

    // === 경영지원 요청 플로우 ===
    const sState = supportMem.get(ctx.chat!.id);
    if (sState) {
      const data = sState.data;

      if (sState.stage === 'content') {
        data.content = text.slice(0, 1000);
        sState.stage = 'deadline';
        return ask(ctx, '② 요청기한을 입력해 주세요. (예: 2025-10-10, 이번주 금요일, 긴급 등)');
      }

      if (sState.stage === 'deadline') {
        data.deadline = text.slice(0, 200);
        // 요약 및 확인
        const requesterName = (await getEmployeeNameByChatId(String(ctx.chat!.id))) || `User-${ctx.chat!.id}`;
        const summary =
          `아래 내용으로 요청하시겠습니까?\n\n` +
          `— 요청자: ${requesterName}\n` + // 표시만, ID 비노출
          `— 요청내용: ${data.content}\n` +
          `— 요청기한: ${data.deadline}`;

        supportConfirm.set(ctx.chat!.id, { content: data.content!, deadline: data.deadline! });
        supportMem.delete(ctx.chat!.id);

        const kb = Markup.inlineKeyboard([
          [Markup.button.callback('📨 요청 보내기', 'support_send'), Markup.button.callback('취소', 'support_cancel')],
        ]);
        return ctx.reply(summary, kb);
      }
    }

    // === 구매요청 플로우 ===
    const state = purchaseMem.get(ctx.chat!.id);
    if (state) {
      const data = state.data;

      if (state.stage === 'item') {
        data.item = text.slice(0, 100);
        state.stage = 'qty';
        return ask(ctx, '② 수량/단위를 입력해 주세요. (예: 1박스, 3세트, 10kg)');
      }
      if (state.stage === 'qty') {
        data.qty = text.slice(0, 100);
        state.stage = 'price';
        return ask(ctx, '③ 가격을 입력해 주세요. (숫자만, 단위 없이)');
      }
      if (state.stage === 'price') {
        const n = text.replace(/[, ]/g, '');
        if (!/^\d+$/.test(n)) return ask(ctx, '❗ 숫자만 입력해 주세요. 다시 입력: 가격');
        data.price = n;
        state.stage = 'reason';
        return ask(ctx, '④ 구매 사유를 입력해 주세요.');
      }
      if (state.stage === 'reason') {
        data.reason = text.slice(0, 300);
        state.stage = 'note';
        return ask(ctx, '⑤ 비고(선택)를 입력해 주세요. 없으면 "없음"이라고 적어주세요.');
      }
      if (state.stage === 'note') {
        data.note = text.slice(0, 300);
        purchaseMem.delete(ctx.chat!.id);

        const requesterName = (await getEmployeeNameByChatId(String(ctx.chat!.id))) || `User-${ctx.chat!.id}`;
        const reqNo = await savePurchase(String(ctx.chat!.id), requesterName, data.item!, data.qty!, data.price!, data.reason!, data.note!);

        await ctx.reply(
          `구매 요청이 접수되었습니다 ✅\n` +
          `요청번호: ${reqNo}\n` +
          `물품: ${data.item}\n수량: ${data.qty}\n가격: ₩${Number(data.price).toLocaleString()}`
        );

        // 관리자 알림
        const managers = await getManagers();
        const msg =
          `[구매 요청 알림]\n번호: ${reqNo}\n요청자: ${requesterName}\n` + // Chat ID 비노출
          `물품: ${data.item}\n수량: ${data.qty} / 가격: ₩${Number(data.price).toLocaleString()}\n사유: ${data.reason}\n비고: ${data.note}`;
        const kb = Markup.inlineKeyboard([
          [Markup.button.callback('✅ 승인', `approve|${reqNo}`),
           Markup.button.callback('❌ 반려',  `reject|${reqNo}`)]
        ]).reply_markup;

        for (const m of managers) { try { await bot.telegram.sendMessage(m.chatId, msg, { reply_markup: kb }); } catch {} }
        return replyMenu(ctx);
      }
    }

    await ctx.reply('메뉴로 돌아가려면 /start 를 입력하세요. (진행 중 취소: /cancel)');
  } catch (e) {
    await ctx.reply('처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
  }
});

/** 승인/반려 콜백 */
bot.action(/^approve\|(.+)$/, async ctx => {
  try {
    await ctx.answerCbQuery();
    if (!(await isManager(String(ctx.from!.id)))) return ctx.reply('담당자 권한이 없습니다.');
    const reqNo = ctx.match[1];
    const approverName = (await getEmployeeNameByChatId(String(ctx.from!.id))) || `User-${ctx.from!.id}`;
    const res = await updateStatusApproved(reqNo, approverName);
    if ((res as any).cancelled) return ctx.reply(`이미 취소된 건입니다. (${reqNo})`);
    if ((res as any).already) return ctx.reply(`이미 처리된 건입니다. (현재상태: ${(res as any).status})`);
    const requesterChatId = (res as any).curVals[2];
    await broadcastToManagers(`[구매 요청 처리 안내]\n${reqNo} 요청이 ✅승인되었습니다.\n처리자: ${approverName}`);
    await notifyRequester(requesterChatId, `[구매 요청 결과]\n${reqNo} 요청이 ✅승인되었습니다.\n처리자: ${approverName}`);
  } catch { await ctx.reply('처리 중 오류가 발생했습니다.'); }
});

bot.action(/^reject\|(.+)$/, async ctx => {
  try {
    await ctx.answerCbQuery();
    if (!(await isManager(String(ctx.from!.id)))) return ctx.reply('담당자 권한이 없습니다.');
    const reqNo = ctx.match[1];

    // 미존재 시 취소 여부 구분
    const row = await findPurchaseRowByNo(reqNo);
    if (!row) {
      if (await isCancelledReqNo(reqNo)) return ctx.reply(`이미 취소된 건입니다. (${reqNo})`);
      return ctx.reply('요청을 찾을 수 없습니다.');
    }
    // 아직 대기중인지 확인
    const cur = await sheets.spreadsheets.values.get({
      spreadsheetId: PURCHASE_SHEET_ID, range: `${PURCHASE_SHEET}!I${row}:I${row}`,
    });
    const status = cur.data.values?.[0]?.[0] || '';
    if (status && status !== '대기중') return ctx.reply(`이미 처리된 건입니다. (현재상태: ${status})`);

    rejectMem.set(ctx.from!.id, { reqNo });
    await ctx.reply('반려 사유를 입력해 주세요.', { reply_markup: { force_reply: true } });
  } catch { await ctx.reply('처리 중 오류가 발생했습니다.'); }
});

/** 취소 버튼 콜백 (요청자) */
bot.action(/^cancel\|(.+)$/, async ctx => {
  try {
    await ctx.answerCbQuery();
    const reqNo = ctx.match[1];
    cancelMem.set(ctx.chat!.id, { reqNo });
    await ctx.reply(`요청번호 ${reqNo} 취소 사유를 입력해 주세요.`, { reply_markup: { force_reply: true } });
  } catch { await ctx.reply('처리 중 오류가 발생했습니다.'); }
});

/** ===== Vercel Handler ===== */
export default async function handler(req: any, res: any) {
  try {
    if (req.method === 'POST') { await bot.handleUpdate(req.body as any); return res.status(200).send('ok'); }
    return res.status(200).send('ok');
  } catch { return res.status(200).send('ok'); }
}
