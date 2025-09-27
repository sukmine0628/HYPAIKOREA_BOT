// @ts-nocheck
import { Telegraf, Markup } from 'telegraf';
import { google } from 'googleapis';

const bot = new Telegraf(process.env.BOT_TOKEN!);

/** ========== Google Sheets Auth (GOOGLE_CREDENTIALS JSON 사용) ========== */
const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS!);
const auth = new google.auth.JWT({
  email: creds.client_email,
  key: creds.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

/** ========== 시트 설정 ========== */
// 직원 시트(이미 쓰던 것)
const EMPLOYEE_SHEET_ID = process.env.GS_SHEET_ID!;
const EMPLOYEE_SHEET = 'Chat_ID';
// F열에 '관리자'면 승인 담당자
const EMPLOYEE_MANAGER_COL_INDEX = 5; // 0-based (A=0 ... F=5)

// 구매요청 시트(분리 시 GS_PURCHASE_SHEET_ID, 아니면 직원 시트와 동일)
const PURCHASE_SHEET_ID = process.env.GS_PURCHASE_SHEET_ID || EMPLOYEE_SHEET_ID;
const PURCHASE_SHEET = 'Purchase_List';

/** ========== 공통 유틸 ========== */
async function authorize() {
  await auth.authorize();
}

function nowTS() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

async function getEmployeeNameByChatId(chatId: string): Promise<string> {
  await authorize();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: EMPLOYEE_SHEET_ID,
    range: `${EMPLOYEE_SHEET}!A2:B`,
  });
  const rows = res.data.values || [];
  const hit = rows.find(r => String(r[0]) === String(chatId));
  return hit?.[1] || '';
}

async function getManagers(): Promise<Array<{ chatId: string, name: string }>> {
  await authorize();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: EMPLOYEE_SHEET_ID,
    range: `${EMPLOYEE_SHEET}!A2:F`,
  });
  const rows = res.data.values || [];
  const managers: Array<{ chatId: string, name: string }> = [];
  for (const r of rows) {
    const chatId = r[0];
    const name = r[1];
    const role = r[EMPLOYEE_MANAGER_COL_INDEX]; // F열
    if (chatId && role === '관리자') {
      managers.push({ chatId, name: name || '' });
    }
  }
  return managers;
}

async function findPurchaseRowByNo(reqNo: string): Promise<number | null> {
  await authorize();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!A2:A`,
  });
  const rows = res.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][0]) === reqNo) {
      return i + 2; // header offset
    }
  }
  return null;
}

/** ========== 직원 등록 저장 ========== */
async function saveEmployee(chatId: string, name: string) {
  await authorize();
  const ts = nowTS();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: EMPLOYEE_SHEET_ID,
    range: `${EMPLOYEE_SHEET}!A2:A`,
  });
  const rows = res.data.values || [];
  let rowIndex = -1;
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][0]) === chatId) { rowIndex = i + 2; break; }
  }

  if (rowIndex > -1) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: EMPLOYEE_SHEET_ID,
      range: `${EMPLOYEE_SHEET}!B${rowIndex}:E${rowIndex}`,
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

/** ========== 구매 요청 저장(구매 번호 자동증가) ========== */
async function savePurchase(
  chatId: string,
  name: string,
  item: string,
  qty: string,
  price: string,
  reason: string,
  note: string
) {
  await authorize();
  const ts = nowTS();

  // 구매번호 자동 증가
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!A2:A`,
  });
  const rows = res.data.values || [];
  const last = rows.length > 0 ? rows[rows.length - 1][0] : null;

  let nextNo = '구매-001';
  if (last && typeof last === 'string' && last.startsWith('구매-')) {
    const n = parseInt(last.split('-')[1] || '0', 10);
    nextNo = `구매-${String((isNaN(n) ? 0 : n) + 1).padStart(3, '0')}`;
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!A:M`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        nextNo,          // A: 구매 번호
        name,            // B: 요청자 이름
        chatId,          // C: 요청자 Chat ID
        item,            // D: 물품
        qty,             // E: 수량
        price,           // F: 가격
        reason,          // G: 구매사유
        note,            // H: 비고
        '대기중',        // I: 상태
        '',              // J: 승인/반려자
        '',              // K: 반려 사유
        ts,              // L: 요청 시각
        ''               // M: 승인/반려 시각
      ]],
    },
  });

  return nextNo;
}

/** ========== 상태 업데이트 ========== */
async function updateStatusApproved(reqNo: string, approverName: string) {
  await authorize();
  const row = await findPurchaseRowByNo(reqNo);
  if (!row) throw new Error('요청 행을 찾을 수 없습니다.');

  // 현재 상태 확인
  const cur = await sheets.spreadsheets.values.get({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!A${row}:M${row}`,
  });
  const curVals = cur.data.values?.[0] || [];
  const status = curVals[8]; // I
  if (status && status !== '대기중') return { already: true, status, row, curVals };

  const ts = nowTS();
  await sheets.spreadsheets.values.update({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!I${row}:M${row}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[ '승인', approverName, '', curVals[11] || '', ts ]] },
  });
  return { already: false, row, curVals };
}

async function updateStatusRejected(reqNo: string, approverName: string, reason: string) {
  await authorize();
  const row = await findPurchaseRowByNo(reqNo);
  if (!row) throw new Error('요청 행을 찾을 수 없습니다.');

  const cur = await sheets.spreadsheets.values.get({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!A${row}:M${row}`,
  });
  const curVals = cur.data.values?.[0] || [];
  const status = curVals[8]; // I
  if (status && status !== '대기중') return { already: true, status, row, curVals };

  const ts = nowTS();
  await sheets.spreadsheets.values.update({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!I${row}:M${row}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[ '반려', approverName, reason, curVals[11] || '', ts ]] },
  });
  return { already: false, row, curVals };
}

/** ========== 알림(브로드캐스트/요청자) ========== */
async function broadcastToManagers(text: string) {
  const managers = await getManagers();
  for (const m of managers) {
    try { await bot.telegram.sendMessage(m.chatId, text); } catch {}
  }
}

async function notifyRequester(chatId: string, text: string) {
  try { await bot.telegram.sendMessage(chatId, text); } catch {}
}

/** ========== 메뉴 & 플로우 ========== */
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

/** 구매 요청 상태머신 */
type Stage = 'item' | 'qty' | 'price' | 'reason' | 'note';
type PurchaseState = {
  stage: Stage;
  data: { item?: string; qty?: string; price?: string; reason?: string; note?: string };
};
const purchaseMem = new Map<number, PurchaseState>();

const ask = (ctx: any, message: string) =>
  ctx.reply(message, { reply_markup: { force_reply: true } });

/** 반려 사유 입력 대기 상태(담당자별) */
const rejectMem = new Map<number, { reqNo: string }>();

/** 신규 직원 등록 */
bot.action('register_start', async ctx => {
  await ctx.answerCbQuery();
  await ask(ctx, REGISTER_PROMPT);
});

/** 구매 메뉴 */
bot.action('purchase_menu', async ctx => {
  await ctx.answerCbQuery();
  await ctx.reply(
    '구매 메뉴입니다. 원하시는 작업을 선택하세요.',
    Markup.inlineKeyboard([
      [
        Markup.button.callback('구매 요청', 'purchase_request'),
        Markup.button.callback('구매 승인', 'purchase_approve'),
      ],
      [Markup.button.callback('뒤로 가기', 'go_back')],
    ])
  );
});

/** 구매 요청 시작 */
bot.action('purchase_request', async ctx => {
  await ctx.answerCbQuery();
  purchaseMem.set(ctx.chat!.id, { stage: 'item', data: {} });
  await ask(ctx, '구매 요청을 시작합니다.\n① 물품명을 입력해 주세요.');
});

/** 승인 메뉴(안내) */
bot.action('purchase_approve', async ctx => {
  await ctx.answerCbQuery();
  await ctx.reply('승인/반려는 DM으로 오는 알림에서 버튼을 눌러 처리하세요.');
});

/** 뒤로가기 */
bot.action('go_back', async ctx => {
  purchaseMem.delete(ctx.chat!.id);
  await replyMenu(ctx);
});

/** ========== 구매요청 입력 플로우 ========== */
bot.on('text', async ctx => {
  try {
    const text = String((ctx.message as any)?.text || '').trim();
    const asked = (ctx.message as any)?.reply_to_message?.text || '';

    // /cancel
    if (/^\/cancel$/i.test(text)) {
      purchaseMem.delete(ctx.chat!.id);
      rejectMem.delete(ctx.chat!.id);
      await ctx.reply('취소되었습니다. /start 로 다시 시작하세요.');
      return;
    }

    // 메인 트리거
    if (TRIGGER.test(text)) return replyMenu(ctx);

    // 직원 등록
    if (asked.startsWith(REGISTER_PROMPT)) {
      const name = text;
      if (!name) return;
      await saveEmployee(String(ctx.chat!.id), name);
      await ctx.reply(`${name}님 신규 직원 등록이 완료되었습니다 🙇`);
      return replyMenu(ctx);
    }

    // 반려 사유 입력(담당자)
    const rej = rejectMem.get(ctx.chat!.id);
    if (rej) {
      // 권한 확인(담당자만)
      const managers = await getManagers();
      const ok = managers.some(m => String(m.chatId) === String(ctx.chat!.id));
      if (!ok) {
        await ctx.reply('담당자 권한이 없습니다.');
        rejectMem.delete(ctx.chat!.id);
        return;
      }

      const approverName = await getEmployeeNameByChatId(String(ctx.chat!.id)) || `User-${ctx.chat!.id}`;
      const res = await updateStatusRejected(rej.reqNo, approverName, text);
      if (res.already) {
        await ctx.reply(`이미 처리된 구매요청 건입니다. (현재상태: ${res.status})`);
        rejectMem.delete(ctx.chat!.id);
        return;
      }

      const rowVals = res.curVals;
      const requesterChatId = rowVals[2]; // C열
      // 브로드캐스트 & 요청자 통보
      await broadcastToManagers(
        `[구매 요청 처리 안내]\n${rej.reqNo} 요청이 ❌반려되었습니다.\n처리자: ${approverName}\n사유: ${text}`
      );
      await notifyRequester(
        requesterChatId,
        `[구매 요청 결과]\n${rej.reqNo} 요청이 ❌반려되었습니다.\n처리자: ${approverName}\n사유: ${text}`
      );
      await ctx.reply('반려 처리되었습니다.');
      rejectMem.delete(ctx.chat!.id);
      return;
    }

    // 구매요청 플로우
    const state = purchaseMem.get(ctx.chat!.id);
    if (state) {
      const data = state.data;

      if (state.stage === 'item') {
        data.item = text.slice(0, 100);
        state.stage = 'qty';
        await ask(ctx, '② 수량을 입력해 주세요. (숫자만)');
        return;
      }

      if (state.stage === 'qty') {
        const n = text.replace(/[, ]/g, '');
        if (!/^\d+$/.test(n)) {
          await ask(ctx, '❗ 숫자만 입력해 주세요. 다시 입력: 수량');
          return;
        }
        data.qty = n;
        state.stage = 'price';
        await ask(ctx, '③ 가격을 입력해 주세요. (숫자만, 단위 없이)');
        return;
      }

      if (state.stage === 'price') {
        const n = text.replace(/[, ]/g, '');
        if (!/^\d+$/.test(n)) {
          await ask(ctx, '❗ 숫자만 입력해 주세요. 다시 입력: 가격');
          return;
        }
        data.price = n;
        state.stage = 'reason';
        await ask(ctx, '④ 구매 사유를 입력해 주세요.');
        return;
      }

      if (state.stage === 'reason') {
        data.reason = text.slice(0, 300);
        state.stage = 'note';
        await ask(ctx, '⑤ 비고(선택)를 입력해 주세요. 없으면 "없음"이라고 적어주세요.');
        return;
      }

      if (state.stage === 'note') {
        data.note = text.slice(0, 300);
        purchaseMem.delete(ctx.chat!.id);

        const requesterName =
          (await getEmployeeNameByChatId(String(ctx.chat!.id))) ||
          `User-${ctx.chat!.id}`;

        const reqNo = await savePurchase(
          String(ctx.chat!.id),
          requesterName,
          data.item!, data.qty!, data.price!, data.reason!, data.note!
        );

        await ctx.reply(
          `구매 요청이 접수되었습니다 ✅\n` +
          `요청번호: ${reqNo}\n` +
          `물품: ${data.item}\n수량: ${data.qty}\n가격: ${Number(data.price).toLocaleString()}`
        );

        // 담당자에게 알림 + 버튼
        const managers = await getManagers();
        const msg =
          `[구매 요청 알림]\n` +
          `번호: ${reqNo}\n` +
          `요청자: ${requesterName}(${ctx.chat!.id})\n` +
          `물품: ${data.item}\n수량: ${data.qty} / 가격: ${Number(data.price).toLocaleString()}\n` +
          `사유: ${data.reason}\n비고: ${data.note}`;

        const kb = Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ 승인', `approve|${reqNo}`),
            Markup.button.callback('❌ 반려', `reject|${reqNo}`),
          ]
        ]);

        for (const m of managers) {
          try { await bot.telegram.sendMessage(m.chatId, msg, kb); } catch {}
        }

        return replyMenu(ctx);
      }
    }

    await ctx.reply('메뉴로 돌아가려면 /start 를 입력하세요. (진행 중 취소: /cancel)');
  } catch (err: any) {
    console.error('TEXT_HANDLER_ERROR', err?.response?.data || err);
    await ctx.reply('처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
  }
});

/** ========== 승인/반려 콜백 처리 ========== */
bot.action(/^approve\|(.+)$/, async ctx => {
  try {
    await ctx.answerCbQuery();
    const reqNo = ctx.match[1];

    // 담당자 권한 확인
    const managers = await getManagers();
    const ok = managers.some(m => String(m.chatId) === String(ctx.from?.id));
    if (!ok) return ctx.reply('담당자 권한이 없습니다.');

    const approverName =
      (await getEmployeeNameByChatId(String(ctx.from!.id))) ||
      `User-${ctx.from!.id}`;

    const res = await updateStatusApproved(reqNo, approverName);
    if (res.already) {
      return ctx.reply(`이미 처리된 구매요청 건입니다. (현재상태: ${res.status})`);
    }

    const row = res.row!;
    const rowVals = res.curVals!;
    const requesterChatId = rowVals[2]; // C열

    await broadcastToManagers(
      `[구매 요청 처리 안내]\n${reqNo} 요청이 ✅승인되었습니다.\n처리자: ${approverName}`
    );
    await notifyRequester(
      requesterChatId,
      `[구매 요청 결과]\n${reqNo} 요청이 ✅승인되었습니다.\n처리자: ${approverName}`
    );
    await ctx.reply('승인 처리되었습니다.');
  } catch (e: any) {
    console.error('APPROVE_ERROR', e?.response?.data || e);
    await ctx.reply('처리 중 오류가 발생했습니다.');
  }
});

bot.action(/^reject\|(.+)$/, async ctx => {
  try {
    await ctx.answerCbQuery();
    const reqNo = ctx.match[1];

    // 담당자 권한 확인
    const managers = await getManagers();
    const ok = managers.some(m => String(m.chatId) === String(ctx.from?.id));
    if (!ok) return ctx.reply('담당자 권한이 없습니다.');

    // 이미 처리되었는지 미리 체크
    const row = await findPurchaseRowByNo(reqNo);
    if (!row) return ctx.reply('요청을 찾을 수 없습니다.');
    const cur = await sheets.spreadsheets.values.get({
      spreadsheetId: PURCHASE_SHEET_ID,
      range: `${PURCHASE_SHEET}!I${row}:I${row}`,
    });
    const status = cur.data.values?.[0]?.[0] || '';
    if (status && status !== '대기중') {
      return ctx.reply(`이미 처리된 구매요청 건입니다. (현재상태: ${status})`);
    }

    rejectMem.set(ctx.from!.id, { reqNo });
    await ctx.reply('반려 사유를 입력해 주세요.', { reply_markup: { force_reply: true } });
  } catch (e: any) {
    console.error('REJECT_START_ERROR', e?.response?.data || e);
    await ctx.reply('처리 중 오류가 발생했습니다.');
  }
});

/** ========== Vercel API Handler ========== */
export default async function handler(req: any, res: any) {
  try {
    if (req.method === 'POST') {
      await bot.handleUpdate(req.body as any);
      return res.status(200).send('ok');
    }
    return res.status(200).send('ok');
  } catch (e) {
    console.error('HANDLER_ERROR', e);
    return res.status(200).send('ok');
  }
}
