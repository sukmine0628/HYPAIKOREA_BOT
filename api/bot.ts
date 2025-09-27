// @ts-nocheck
import { Telegraf, Markup } from 'telegraf';
import { google } from 'googleapis';

const bot = new Telegraf(process.env.BOT_TOKEN!);

// ===== 크리덴셜(JSON) 파싱 후 Google Sheets 클라이언트 준비 =====
const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS!);

// 런타임 점검 로그
bot.use(async (_ctx, next) => {
  console.log('CREDS_CHECK', {
    env: process.env.VERCEL_ENV,
    email: creds?.client_email,
    hasPrivateKey: !!creds?.private_key,
    pkLines: (creds?.private_key || '').split('\n').length,
  });
  return next();
});

const auth = new google.auth.JWT({
  email: creds.client_email,
  key:   creds.private_key, // 멀티라인 PEM
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

const SHEET_ID = process.env.GS_SHEET_ID!; // <- 시트 ID는 기존대로 사용
const SHEET_NAME = 'Chat_ID';

// ===== 저장 헬퍼 =====
async function saveRow(chatId: string, name: string) {
  await auth.authorize(); // 콜드스타트 대비

  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);

  try {
    // A열에서 chat_id 검색
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A2:A`,
    });
    const rows = res.data.values || [];
    let rowIndex = -1;
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][0]) === chatId) { rowIndex = i + 2; break; }
    }

    if (rowIndex > -1) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!B${rowIndex}:E${rowIndex}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[name, '', '', ts]] },
      });
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!A:E`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[chatId, name, '', '', ts]] },
      });
    }
  } catch (err: any) {
    const gErr = err?.response?.data || err;
    console.error('SHEETS_ERROR', {
      message: err?.message,
      code: gErr?.error?.code,
      status: gErr?.error?.status,
      details: gErr?.error?.message || gErr,
    });
    throw err;
  }
}

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
const TRIGGER = /^(?:\|start|hi|hello|안녕|하이|헬로)\s*$/i;

bot.start(ctx => replyMenu(ctx));
bot.hears(TRIGGER, ctx => replyMenu(ctx));

bot.action('register_start', async ctx => {
  await ctx.answerCbQuery();
  await ctx.reply(REGISTER_PROMPT, { reply_markup: { force_reply: true } });
  await ctx.reply(
    '메뉴로 돌아가려면 아래를 누르세요.',
    Markup.inlineKeyboard([[Markup.button.callback('뒤로 가기', 'go_back')]])
  );
});

bot.action('go_back', async ctx => {
  await ctx.answerCbQuery();
  await replyMenu(ctx);
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

bot.action('purchase_approve', async ctx => {
  await ctx.answerCbQuery();
  await ctx.reply('구매 승인 메뉴입니다. (다음 단계에서 기능 연결)');
});

bot.command('cancel', async ctx => {
  await ctx.reply('취소되었습니다. /start 로 다시 시작하세요.');
});

// 텍스트 처리
bot.on('text', async ctx => {
  try {
    const text  = String((ctx.message as any)?.text || '');
    const asked = (ctx.message as any)?.reply_to_message?.text || '';

    if (TRIGGER.test(text)) return replyMenu(ctx);

    if (asked.startsWith(REGISTER_PROMPT)) {
      const name = text.trim().replace(/\s+/g, ' ').slice(0, 50);
      if (!name) return;
      await saveRow(String(ctx.chat!.id), name);
      await ctx.reply(`신규 직원 등록이 완료되었습니다 🙇\n이름: ${name}\nChat ID: ${ctx.chat!.id}`);
      return replyMenu(ctx);
    }

    await ctx.reply('봇을 호출하려면 Hello 를 입력하세요.');
  } catch (err: any) {
    console.error('TEXT_HANDLER_ERROR', err?.response?.data || err);
    await ctx.reply('처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
  }
});

// ===== Vercel API 핸들러 =====
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
