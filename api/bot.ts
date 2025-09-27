import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Telegraf, Markup } from 'telegraf';
import { google } from 'googleapis';

const bot = new Telegraf(process.env.BOT_TOKEN!);

// Google Sheets auth (멀티라인 PEM을 그대로 사용)
const auth = new google.auth.JWT(
  process.env.GS_CLIENT_EMAIL,
  undefined,
  process.env.GS_PRIVATE_KEY, // 멀티라인 그대로 사용 (replace 제거)
  ['https://www.googleapis.com/auth/spreadsheets']
);
const sheets = google.sheets({ version: 'v4', auth });

const SHEET_ID = process.env.GS_SHEET_ID!;
const SHEET_NAME = 'Chat_ID';

// ===== Helpers =====
async function saveRow(chatId: string, name: string) {
  // 서버리스(콜드스타트) 환경에서 매 호출 인증 보장
  await auth.authorize();

  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);

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

  // 기존 행 갱신 또는 새 행 추가
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
}

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

// ForceReply 프롬프트 문구 (답장 여부 판별용)
const REGISTER_PROMPT = '신규 직원 등록을 위해 성함을 입력해 주세요.';

// ===== Triggers / Actions =====
const TRIGGER = /^(?:\/start|start|hi|hello|안녕|하이|헬로)\s*$/i;

bot.start(ctx => replyMenu(ctx));
bot.hears(TRIGGER, ctx => replyMenu(ctx));

// 상태(Map) 대신 ForceReply로 “해당 메시지에 대한 답장인지”로 식별
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

bot.action('purchase_request', async ctx => {
  await ctx.answerCbQuery();
  await ctx.reply('아직 준비 중인 서비스입니다.');
});

bot.command('cancel', async ctx => {
  await ctx.reply('취소되었습니다. /start 로 다시 시작하세요.');
});

// 텍스트 처리: 트리거 우선 → 등록 프롬프트 답장 처리 → 기타 안내
bot.on('text', async ctx => {
  try {
    const text = String(ctx.message?.text || '');
    const asked = ctx.message?.reply_to_message?.text || '';

    // 1) 트리거 텍스트(/start, hi 등)는 어디서 오든 메뉴로!
    if (TRIGGER.test(text)) {
      return replyMenu(ctx);
    }

    // 2) 등록 프롬프트(ForceReply)에 대한 '답장'이면 이름 처리
    if (asked.startsWith(REGISTER_PROMPT)) {
      const name = text.trim().replace(/\s+/g, ' ').slice(0, 50);
      if (!name) return;

      await saveRow(String(ctx.chat!.id), name);
      await ctx.reply(`등록 완료 ✅\n이름: ${name}\nChat ID: ${ctx.chat!.id}`);
      return replyMenu(ctx);
    }

    // 3) 그 외 일반 텍스트 → 가이드
    await ctx.reply('메뉴로 돌아가려면 /start 를 입력하세요.');
  } catch (err) {
    console.error('TEXT_HANDLER_ERROR:', err);
    await ctx.reply('처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
  }
});

// ===== Vercel Handler =====
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method === 'POST') {
      await bot.handleUpdate(req.body as any);
      return res.status(200).send('ok');
    }
    return res.status(200).send('ok'); // 헬스체크
  } catch (e) {
    console.error('HANDLER_ERROR:', e);
    return res.status(200).send('ok');
  }
}
