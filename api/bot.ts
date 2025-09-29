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
const EMPLOYEE_MANAGER_COL_INDEX = 5; // F열

const PURCHASE_SHEET_ID = process.env.GS_PURCHASE_SHEET_ID || EMPLOYEE_SHEET_ID;
const PURCHASE_SHEET = 'Purchase_List';

/** ===== Utils ===== */
async function authorize() { await auth.authorize(); }
const nowTS = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

async function getEmployeeNameByChatId(chatId: string) {
  await authorize();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: EMPLOYEE_SHEET_ID,
    range: `${EMPLOYEE_SHEET}!A2:B`,
  });
  const rows = res.data.values || [];
  const hit = rows.find(r => String(r[0]) === String(chatId));
  return hit?.[1] || '';
}

async function getManagers() {
  await authorize();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: EMPLOYEE_SHEET_ID,
    range: `${EMPLOYEE_SHEET}!A2:F`,
  });
  const rows = res.data.values || [];
  return rows
    .filter(r => (r?.[0] ?? '') && String(r?.[EMPLOYEE_MANAGER_COL_INDEX] || '').replace(/\s+/g, '') === '관리자')
    .map(r => ({ chatId: String(r[0]).trim(), name: String(r[1] || '').trim() }));
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

async function getSheetIdByTitle(spreadsheetId: string, title: string) {
  await authorize();
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = meta.data.sheets?.find(s => s.properties?.title === title);
  if (sheet?.properties?.sheetId === undefined) throw new Error(`시트 없음: ${title}`);
  return sheet.properties.sheetId!;
}

async function listMyPendingRequests(chatId: string, limit = 10) {
  await authorize();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!A2:M`,
  });
  const rows = res.data.values || [];
  const mine = rows.filter(r => String(r[2]) === String(chatId) && (r[8] || '') === '대기중');
  mine.sort((a, b) => (b[11] || '').localeCompare(a[11] || ''));
  return mine.slice(0, limit);
}

/** ===== Data Ops ===== */
async function saveEmployee(chatId: string, name: string) {
  await authorize();
  const ts = nowTS();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: EMPLOYEE_SHEET_ID,
    range: `${EMPLOYEE_SHEET}!A2:A`,
  });
  const rows = res.data.values || [];
  const idx = rows.findIndex(r => String(r[0]) === chatId);
  if (idx >= 0) {
    const row = idx + 2;
    await sheets.spreadsheets.values.update({
      spreadsheetId: EMPLOYEE_SHEET_ID,
      range: `${EMPLOYEE_SHEET}!B${row}:E${row}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[name, '', '', ts]] },
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: EMPLOYEE_SHEET_ID,
      range: `${EMPLOYEE_SHEET}!A:E`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[chatId, name, '', '', ts]] },
    });
  }
}

async function savePurchase(chatId: string, name: string, item: string, qty: string, price: string, reason: string, note: string) {
  await authorize();
  const ts = nowTS();
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
      nextNo, name, chatId, item, qty, price, reason, note, '대기중', '', '', ts, ''
    ]]},
  });

  return nextNo;
}

async function updateStatusApproved(reqNo: string, approverName: string) {
  await authorize();
  const row = await findPurchaseRowByNo(reqNo);
  if (!row) throw new Error('요청 행 없음');

  const cur = await sheets.spreadsheets.values.get({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!A${row}:M${row}`,
  });
  const curVals = cur.data.values?.[0] || [];
  if ((curVals[8] || '') !== '대기중') return { already: true, status: curVals[8], curVals };

  const ts = nowTS();
  await sheets.spreadsheets.values.update({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!I${row}:M${row}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [['승인', approverName, '', curVals[11] || '', ts]] },
  });
  return { already: false, curVals };
}

async function updateStatusRejected(reqNo: string, approverName: string, reason: string) {
  await authorize();
  const row = await findPurchaseRowByNo(reqNo);
  if (!row) throw new Error('요청 행 없음');

  const cur = await sheets.spreadsheets.values.get({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!A${row}:M${row}`,
  });
  const curVals = cur.data.values?.[0] || [];
  if ((curVals[8] || '') !== '대기중') return { already: true, status: curVals[8], curVals };

  const ts = nowTS();
  await sheets.spreadsheets.values.update({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!I${row}:M${row}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [['반려', approverName, reason, curVals[11] || '', ts]] },
  });
  return { already: false, curVals };
}

async function deleteRequestRow(reqNo: string) {
  await authorize();
  const rowIndex = await findPurchaseRowByNo(reqNo);
  if (!rowIndex) throw new Error('요청 행 없음');
  const sheetId = await getSheetIdByTitle(PURCHASE_SHEET_ID, PURCHASE_SHEET);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: PURCHASE_SHEET_ID,
    requestBody: { requests: [{
      deleteDimension: {
        range: { sheetId, dimension: 'ROWS', startIndex: rowIndex - 1, endIndex: rowIndex }
      }
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
    ])
  );
}

const REGISTER_PROMPT = '신규 직원 등록을 위해 성함을 입력해 주세요.';
const TRIGGER = /^(?:\/start|start|hi|hello|안녕|하이|헬로)\s*$/i;

bot.start(ctx => replyMenu(ctx));
bot.hears(TRIGGER, ctx => replyMenu(ctx));

/** 상태머신 */
type Stage = 'item' | 'qty' | 'price' | 'reason' | 'note';
type PurchaseState = { stage: Stage; data: { item?: string; qty?: string; price?: string; reason?: string; note?: string } };
const purchaseMem = new Map<number, PurchaseState>();
const ask = (ctx: any, message: string) => ctx.reply(message, { reply_markup: { force_reply: true } });

/** 임시 입력 대기 메모리 */
const rejectMem = new Map<number, { reqNo: string }>(); // 담당자 반려 사유
const cancelMem = new Map<number, { reqNo: string }>(); // 요청자 취소 사유

/** 액션들 */
bot.action('register_start', async ctx => {
  await ctx.answerCbQuery(); await ask(ctx, REGISTER_PROMPT);
});

bot.action('purchase_menu', async ctx => {
  await ctx.answerCbQuery();
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
  purchaseMem.set(ctx.chat!.id, { stage: 'item', data: {} });
  await ask(ctx, '구매 요청을 시작합니다.\n① 물품명을 입력해 주세요.');
});

bot.action('purchase_approve', async ctx => {
  await ctx.answerCbQuery();
  await ctx.reply('승인/반려는 DM으로 오는 알림에서 버튼을 눌러 처리하세요.');
});

bot.action('purchase_mylist', async ctx => {
  await ctx.answerCbQuery();
  const mine = await listMyPendingRequests(String(ctx.chat!.id), 10);
  if (!mine.length) return ctx.reply('대기중인 구매 요청이 없습니다.');

  const text = '내 대기중 요청 (최대 10건)\n' + mine.map(r => {
    const no = r[0], item = r[3], qty = r[4], price = r[5], when = r[11];
    return `• ${no} | ${item} (${qty}) | ₩${Number(price||0).toLocaleString()} | ${when}`;
  }).join('\n');

  // 각 요청별 취소 버튼
  const rows = mine.map(r => [Markup.button.callback(`❌ ${r[0]} 취소`, `cancel|${r[0]}`)]);
  await ctx.reply(text, Markup.inlineKeyboard(rows));
});

bot.action('go_back', async ctx => {
  purchaseMem.delete(ctx.chat!.id);
  await replyMenu(ctx);
});

/** 텍스트 입력 처리 */
bot.on('text', async ctx => {
  try {
    const text = String((ctx.message as any)?.text || '').trim();
    const asked = (ctx.message as any)?.reply_to_message?.text || '';

    if (/^\/cancel$/i.test(text)) {
      purchaseMem.delete(ctx.chat!.id); rejectMem.delete(ctx.chat!.id); cancelMem.delete(ctx.chat!.id);
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
      const managers = await getManagers();
      if (!managers.some(m => String(m.chatId) === String(ctx.chat!.id))) {
        rejectMem.delete(ctx.chat!.id); return ctx.reply('담당자 권한이 없습니다.');
      }
      const approverName = (await getEmployeeNameByChatId(String(ctx.chat!.id))) || `User-${ctx.chat!.id}`;
      const res = await updateStatusRejected(rej.reqNo, approverName, text);
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
      // 본인 건이고 대기중인지 확인
      const row = await findPurchaseRowByNo(reqNo);
      if (!row) { cancelMem.delete(ctx.chat!.id); return ctx.reply('요청을 찾을 수 없습니다.'); }
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

      // 행 삭제(공번 처리)
      await deleteRequestRow(reqNo);

      const name = (await getEmployeeNameByChatId(String(ctx.chat!.id))) || `User-${ctx.chat!.id}`;
      const reason = text;
      await broadcastToManagers(`[구매 요청 취소 안내]\n${reqNo} 요청이 사용자가 취소했습니다.\n요청자: ${name}\n사유: ${reason}`);
      await notifyRequester(String(ctx.chat!.id), `[구매 요청 취소]\n${reqNo} 요청이 취소되었습니다.`);
      cancelMem.delete(ctx.chat!.id);
      return ctx.reply('요청이 취소되었습니다.');
    }

    // 구매요청 플로우
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
          `물품: ${data.item}\n수량: ${data.qty}\n가격: ${Number(data.price).toLocaleString()}`
        );

        // 관리자 알림
        const managers = await getManagers();
        const msg =
          `[구매 요청 알림]\n번호: ${reqNo}\n요청자: ${requesterName}(${ctx.chat!.id})\n` +
          `물품: ${data.item}\n수량: ${data.qty} / 가격: ${Number(data.price).toLocaleString()}\n사유: ${data.reason}\n비고: ${data.note}`;
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
    const reqNo = ctx.match[1];
    const managers = await getManagers();
    if (!managers.some(m => String(m.chatId) === String(ctx.from?.id))) return ctx.reply('담당자 권한이 없습니다.');

    const approverName = (await getEmployeeNameByChatId(String(ctx.from!.id))) || `User-${ctx.from!.id}`;
    const res = await updateStatusApproved(reqNo, approverName);
    if (res.already) return ctx.reply(`이미 처리된 건입니다. (현재상태: ${res.status})`);

    const requesterChatId = res.curVals[2];
    await broadcastToManagers(`[구매 요청 처리 안내]\n${reqNo} 요청이 ✅승인되었습니다.\n처리자: ${approverName}`);
    await notifyRequester(requesterChatId, `[구매 요청 결과]\n${reqNo} 요청이 ✅승인되었습니다.\n처리자: ${approverName}`);
    await ctx.reply('승인 처리되었습니다.');
  } catch { await ctx.reply('처리 중 오류가 발생했습니다.'); }
});

bot.action(/^reject\|(.+)$/, async ctx => {
  try {
    await ctx.answerCbQuery();
    const reqNo = ctx.match[1];
    const managers = await getManagers();
    if (!managers.some(m => String(m.chatId) === String(ctx.from?.id))) return ctx.reply('담당자 권한이 없습니다.');

    // 이미 처리되었는지 확인
    const row = await findPurchaseRowByNo(reqNo);
    if (!row) return ctx.reply('요청을 찾을 수 없습니다.');
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
    // 본인 건/대기중 여부는 텍스트 입력 시 최종 확인
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
