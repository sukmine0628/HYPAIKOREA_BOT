// @ts-nocheck
import { Telegraf, Markup } from 'telegraf';
import { google } from 'googleapis';

const bot = new Telegraf(process.env.BOT_TOKEN!);

// ===== 구글 인증 =====
const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS!);
const auth = new google.auth.JWT({
  email: creds.client_email,
  key: creds.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

// === 스프레드시트/시트명 ===
// 직원 정보(이미 등록된 스프레드시트 ID)
const EMPLOYEE_SHEET_ID = process.env.GS_SHEET_ID!;
// 구매 요청은 따로 쓰고 싶으면 GS_PURCHASE_SHEET_ID 추가, 없으면 위 ID 재사용
const PURCHASE_SHEET_ID = process.env.GS_PURCHASE_SHEET_ID || EMPLOYEE_SHEET_ID;

const EMPLOYEE_SHEET = 'Chat_ID';   // 직원 탭 이름
const PURCHASE_SHEET = '구매 요청'; // 구매 요청 탭 이름

// ===== 직원 등록 저장 =====
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

// ===== 구매 요청 저장(번호 자동 증가 포함) =====
async function savePurchase(chatId: string, name: string, item: string, qty: string, price: string, reason: string, note: string) {
  await auth.authorize();
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);

  // 구매 번호 자동 증가
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!A2:A`,
  });
  const rows = res.data.values || [];
  const last = rows.length > 0 ? rows[rows.length - 1][0] : null;
  let nextNo = "구매-001";
  if (last && last.startsWith("구매-")) {
    const num = parseInt(last.split("-")[1]) + 1;
    nextNo = `구매-${String(num).padStart(3, "0")}`;
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!A:M`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        nextNo,          // 구매 번호
        name,            // 요청자 이름
        chatId,          // 요청자 Chat ID
        item, qty, price,
        reason, note,    // 구매사유, 비고
        "대기중",        // 상태
        "",              // 승인/반려자
        "",              // 반려 사유
        ts,              // 요청 시각
        ""               // 승인/반려 시각
      ]],
    },
  });

  return nextNo;
}

// ===== 메뉴 =====
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

bot.action('register_start', async ctx => {
  await ctx.answerCbQuery();
  await ctx.reply(REGISTER_PROMPT, { reply_markup: { force_reply: true } });
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
      [Markup.button.callback('뒤로 가기', 'go_back')],
    ])
  );
});

bot.action('purchase_request', async ctx => {
  await ctx.answerCbQuery();
  await ctx.reply("구매 요청을 시작합니다.\n물품명을 입력해 주세요.", { reply_markup: { force_reply: true } });
  // 👉 다음 단계에서 순차 입력(물품→수량→가격→사유→비고) 붙여서 savePurchase 호출 예정
});

bot.action('purchase_approve', async ctx => {
  await ctx.answerCbQuery();
  await ctx.reply('구매 승인 메뉴입니다. (다음 단계에서 기능 연결)');
});

bot.action('go_back', async ctx => replyMenu(ctx));

bot.on('text', async ctx => {
  try {
    const text  = String((ctx.message as any)?.text || '');
    const asked = (ctx.message as any)?.reply_to_message?.text || '';

    if (TRIGGER.test(text)) return replyMenu(ctx);

    // 직원 등록 처리
    if (asked.startsWith(REGISTER_PROMPT)) {
      const name = text.trim();
      if (!name) return;
      await saveEmployee(String(ctx.chat!.id), name);
      await ctx.reply(`${name}님 신규 직원 등록이 완료되었습니다 🙇`);
      return replyMenu(ctx);
    }

    await ctx.reply('메뉴로 돌아가려면 /start 를 입력하세요.');
  } catch (err: any) {
    console.error('TEXT_HANDLER_ERROR', err?.response?.data || err);
    await ctx.reply('처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
  }
});

// ===== Vercel Handler =====
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
