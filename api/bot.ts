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

/** ========== 스프레드시트/시트 설정 ========== */
// 직원 등록 시트
const EMPLOYEE_SHEET_ID = process.env.GS_SHEET_ID!;
const EMPLOYEE_SHEET = 'Chat_ID';

// 구매 요청 시트 (별도 스프레드시트면 GS_PURCHASE_SHEET_ID 설정)
const PURCHASE_SHEET_ID = process.env.GS_PURCHASE_SHEET_ID || EMPLOYEE_SHEET_ID;
const PURCHASE_SHEET = 'Purchase_List'; // ← 변경 반영

/** ========== 직원 등록 저장 ========== */
async function saveEmployee(chatId: string, name: string) {
  await auth.authorize();
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);

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
  await auth.authorize();
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);

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

/** ========== 메뉴 ========== */
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

/** ========== 구매 요청 상태머신 ========== */
type Stage = 'item' | 'qty' | 'price' | 'reason' | 'note';
type PurchaseState = {
  stage: Stage;
  data: { item?: string; qty?: string; price?: string; reason?: string; note?: string };
};
const purchaseMem = new Map<number, PurchaseState>();

const ask = (ctx: any, message: string) =>
  ctx.reply(message, { reply_markup: { force_reply: true } });

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

/** (추후) 구매 승인 메뉴 자리 */
bot.action('purchase_approve', async ctx => {
  await ctx.answerCbQuery();
  await ctx.reply('구매 승인 메뉴입니다. (다음 단계에서 기능 연결)');
});

/** 뒤로가기 */
bot.action('go_back', async ctx => {
  purchaseMem.delete(ctx.chat!.id);
  await replyMenu(ctx);
});

/** ========== 텍스트 처리 ========== */
bot.on('text', async ctx => {
  try {
    const text = String((ctx.message as any)?.text || '').trim();
    const asked = (ctx.message as any)?.reply_to_message?.text || '';

    // 취소
    if (/^\/cancel$/i.test(text)) {
      purchaseMem.delete(ctx.chat!.id);
      await ctx.reply('취소되었습니다. /start 로 다시 시작하세요.');
      return;
    }

    // 메인 트리거
    if (TRIGGER.test(text)) return replyMenu(ctx);

    // 직원 등록 플로우
    if (asked.startsWith(REGISTER_PROMPT)) {
      const name = text;
      if (!name) return;
      await saveEmployee(String(ctx.chat!.id), name);
      await ctx.reply(`${name}님 신규 직원 등록이 완료되었습니다 🙇`);
      return replyMenu(ctx);
    }

    // 구매 요청 플로우
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

        // 요청자 이름 조회
        let requesterName = '';
        try {
          const res = await sheets.spreadsheets.values.get({
            spreadsheetId: EMPLOYEE_SHEET_ID,
            range: `${EMPLOYEE_SHEET}!A2:B`,
          });
          const rows = res.data.values || [];
          const me = rows.find(r => String(r[0]) === String(ctx.chat!.id));
          requesterName = me?.[1] || '';
        } catch {}

        const reqNo = await savePurchase(
          String(ctx.chat!.id),
          requesterName || `User-${ctx.chat!.id}`,
          data.item!, data.qty!, data.price!, data.reason!, data.note!
        );

        await ctx.reply(
          `구매 요청이 접수되었습니다 ✅\n` +
          `요청번호: ${reqNo}\n` +
          `물품: ${data.item}\n수량: ${data.qty}\n가격: ${Number(data.price).toLocaleString()}`
        );
        return replyMenu(ctx);
      }
    }

    // 그 외
    await ctx.reply('메뉴로 돌아가려면 /start 를 입력하세요. (진행 중 취소: /cancel)');
  } catch (err: any) {
    console.error('TEXT_HANDLER_ERROR', err?.response?.data || err);
    await ctx.reply('처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
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
