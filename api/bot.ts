import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Telegraf, Markup } from 'telegraf';
import { google } from 'googleapis';

const bot = new Telegraf(process.env.BOT_TOKEN!);

const auth = new google.auth.JWT(
  process.env.GS_CLIENT_EMAIL,
  undefined,
  (process.env.GS_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  ['https://www.googleapis.com/auth/spreadsheets']
);
const sheets = google.sheets({ version: 'v4', auth });

const SHEET_ID = process.env.GS_SHEET_ID!;
const SHEET_NAME = 'Chat_ID';

async function saveRow(chatId: string, name: string) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
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
      valueInputOption: 'RAW',
      requestBody: { values: [[name, '', '', ts]] },
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A:E`,
      valueInputOption: 'RAW',
      requestBody: { values: [[chatId, name, '', '', ts]] },
    });
  }
}

const TRIGGER = /^(?:\/start|hi|hello|안녕|하이)\s*$/i;
const mem = new Map<number, string>();

function replyMenu(ctx: any) {
  return ctx.reply(
    '안녕하세요. 하이파이코리아입니다. 무엇을 도와드릴까요?',
    Markup.inlineKeyboard([
      [
        Markup.button.callback('신규 직원 등록', 'register_start'),
        Markup.button.callback('구매 요청하기', 'purchase_request'),
      ],
    ])
  );
}

bot.start(ctx => replyMenu(ctx));
bot.hears(TRIGGER, ctx => replyMenu(ctx));

bot.action('register_start', async ctx => {
  mem.set(ctx.chat!.id, 'awaiting_name');
  await ctx.answerCbQuery();
  await ctx.reply(
    '신규 직원 등록을 위해 성함을 입력해 주세요. (취소: /cancel)',
    Markup.inlineKeyboard([[Markup.button.callback('뒤로 가기', 'go_back')]])
  );
});

bot.action('go_back', async ctx => {
  mem.delete(ctx.chat!.id);
  await ctx.answerCbQuery();
  await replyMenu(ctx);
});

bot.action('purchase_request', async ctx => {
  await ctx.answerCbQuery();
  await ctx.reply('아직 준비 중인 서비스입니다.');
});

bot.command('cancel', async ctx => {
  mem.delete(ctx.chat!.id);
  await ctx.reply('취소되었습니다. /start 로 다시 시작하세요.');
});

bot.on('text', async ctx => {
  const state = mem.get(ctx.chat!.id);
  if (state === 'awaiting_name') {
    const name = ctx.message.text.trim().replace(/\s+/g, ' ').slice(0, 50);
    if (!name) return;
    await saveRow(String(ctx.chat!.id), name);
    mem.delete(ctx.chat!.id);
    await ctx.reply(`등록 완료 ✅\n이름: ${name}\nChat ID: ${ctx.chat!.id}`);
    await replyMenu(ctx);
  }
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'POST') {
    try { await bot.handleUpdate(req.body as any); } catch (e) { console.error(e); }
    return res.status(200).send('ok');
  }
  return res.status(200).send('ok');
}
