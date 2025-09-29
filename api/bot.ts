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
// 직원 시트(이미 사용 중)
const EMPLOYEE_SHEET_ID = process.env.GS_SHEET_ID!;
const EMPLOYEE_SHEET = 'Chat_ID';

// 승인자 표식 열 (F열=index 5) / 승인 여부 열 (G열=index 6) — 필요시 환경에 맞게 조정
const EMPLOYEE_MANAGER_COL_INDEX = 5; // F: "관리자"
const EMPLOYEE_APPROVED_COL_INDEX = 6; // G: "승인"이면 메뉴 접근 가능

// 구매요청 시트(분리 시 GS_PURCHASE_SHEET_ID, 아니면 직원 시트와 동일)
const PURCHASE_SHEET_ID = process.env.GS_PURCHASE_SHEET_ID || EMPLOYEE_SHEET_ID;
const PURCHASE_SHEET = 'Purchase_List'; // 실제 탭 이름 그대로

/** ========== 공통 유틸 ========== */
async function authorize() { await auth.authorize(); }
const nowTS = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

/** 직원 정보/권한 */
async function getEmployeeRowMap() {
  await authorize();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: EMPLOYEE_SHEET_ID,
    range: `${EMPLOYEE_SHEET}!A2:H`,
  });
  const rows = res.data.values || [];
  // A:ChatID, B:이름, ..., F:관리자, G:승인
  const mapByChatId: Record<string, {name?: string, isManager?: boolean, isApproved?: boolean}> = {};
  for (const r of rows) {
    const chatId = (r[0] || '').trim();
    if (!chatId) continue;
    mapByChatId[chatId] = {
      name: r[1] || '',
      isManager: (r[EMPLOYEE_MANAGER_COL_INDEX] || '').trim() === '관리자',
      isApproved: (r[EMPLOYEE_APPROVED_COL_INDEX] || '').trim() === '승인',
    };
  }
  return mapByChatId;
}

async function getEmployeeNameByChatId(chatId: string) {
  const map = await getEmployeeRowMap();
  return map[chatId]?.name || '';
}
async function isApprovedUser(chatId: string) {
  const map = await getEmployeeRowMap();
  return !!map[chatId]?.isApproved;
}
async function isManager(chatId: string) {
  const map = await getEmployeeRowMap();
  return !!map[chatId]?.isManager;
}
async function getManagers() {
  const map = await getEmployeeRowMap();
  return Object.entries(map)
    .filter(([, v]) => v.isManager)
    .map(([chatId, v]) => ({ chatId, name: v.name || '' }));
}

/** 구매요청 행 접근 */
async function getAllPurchases() {
  await authorize();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!A2:M`,
  });
  // A:번호,B:요청자이름,C:요청자ChatID,D:물품,E:수량,F:가격,G:사유,H:비고,I:상태,J:처리자,K:반려사유,L:요청시각,M:처리시각
  return res.data.values || [];
}
function purchaseRowToObject(row, idxFrom2=2) {
  return {
    rowNumber: idxFrom2,                // 실제 시트상의 행 번호
    no: row[0] || '',
    requesterName: row[1] || '',
    requesterChatId: row[2] || '',
    item: row[3] || '',
    qty: row[4] || '',
    price: row[5] || '',
    reason: row[6] || '',
    note: row[7] || '',
    status: row[8] || '',
    approver: row[9] || '',
    rejectReason: row[10] || '',
    requestedAt: row[11] || '',
    processedAt: row[12] || '',
  };
}
async function findPurchaseByNo(reqNo: string) {
  const rows = await getAllPurchases();
  for (let i=0;i<rows.length;i++){
    if ((rows[i][0]||'') === reqNo) {
      return purchaseRowToObject(rows[i], i+2);
    }
  }
  return null;
}

/** 직원 등록 저장 */
async function saveEmployee(chatId: string, name: string) {
  await authorize();
  const ts = nowTS();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: EMPLOYEE_SHEET_ID,
    range: `${EMPLOYEE_SHEET}!A2:A`,
  });
  const rows = res.data.values || [];
  let rowIndex = -1;
  for (let i=0;i<rows.length;i++){
    if (String(rows[i][0]) === chatId) { rowIndex = i+2; break; }
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
      range: `${EMPLOYEE_SHEET}!A:H`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[chatId, name, '', '', ts, '', '']] }, // F,G 비워둠(관리자/승인)
    });
  }
}

/** 구매 요청 저장(번호 자동증가) */
async function savePurchase(chatId, name, item, qty, price, reason, note) {
  await authorize();
  const ts = nowTS();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!A2:A`,
  });
  const rows = res.data.values || [];
  const last = rows.length>0 ? rows[rows.length-1][0] : null;
  let nextNo = '구매-001';
  if (last && typeof last === 'string' && last.startsWith('구매-')) {
    const n = parseInt(last.split('-')[1] || '0', 10);
    nextNo = `구매-${String((isNaN(n)?0:n)+1).padStart(3,'0')}`;
  }
  await sheets.spreadsheets.values.append({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!A:M`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[
      nextNo, name, chatId, item, qty, price, reason, note,
      '대기중', '', '', ts, ''
    ]]},
  });
  return nextNo;
}

/** 상태 업데이트 */
async function updateStatusApproved(reqNo: string, approverName: string) {
  await authorize();
  const row = await findPurchaseByNo(reqNo);
  if (!row) throw new Error('요청 행을 찾을 수 없습니다.');
  if (row.status && row.status !== '대기중') return { already: true, status: row.status, row };
  const ts = nowTS();
  await sheets.spreadsheets.values.update({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!I${row.rowNumber}:M${row.rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[ '승인', approverName, '', row.requestedAt || '', ts ]] },
  });
  return { already: false, row };
}

async function updateStatusRejected(reqNo: string, approverName: string, reason: string) {
  await authorize();
  const row = await findPurchaseByNo(reqNo);
  if (!row) throw new Error('요청 행을 찾을 수 없습니다.');
  if (row.status && row.status !== '대기중') return { already: true, status: row.status, row };
  const ts = nowTS();
  await sheets.spreadsheets.values.update({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!I${row.rowNumber}:M${row.rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[ '반려', approverName, reason, row.requestedAt || '', ts ]] },
  });
  return { already: false, row };
}

async function updateStatusCancelled(reqNo: string, requesterName: string, reason: string) {
  await authorize();
  const row = await findPurchaseByNo(reqNo);
  if (!row) throw new Error('요청 행을 찾을 수 없습니다.');
  if (row.status && row.status !== '대기중') return { already: true, status: row.status, row };
  const ts = nowTS();
  await sheets.spreadsheets.values.update({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!I${row.rowNumber}:M${row.rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[ '취소', requesterName, reason, row.requestedAt || '', ts ]] },
  });
  return { already: false, row };
}

/** 알림 */
async function broadcastToManagers(text: string, extraMarkup?: any) {
  const managers = await getManagers();
  for (const m of managers) {
    try {
      if (extraMarkup) {
        await bot.telegram.sendMessage(m.chatId, text, extraMarkup);
      } else {
        await bot.telegram.sendMessage(m.chatId, text);
      }
    } catch {}
  }
}
async function notifyUser(chatId: string, text: string, extraMarkup?: any) {
  try {
    if (extraMarkup) await bot.telegram.sendMessage(chatId, text, extraMarkup);
    else await bot.telegram.sendMessage(chatId, text);
  } catch {}
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

/** ========== 상태 메모 ========== */
type Stage = 'item' | 'qty' | 'price' | 'reason' | 'note' | 'confirm';
type Draft = { item?: string; qty?: string; price?: string; reason?: string; note?: string };
const purchaseMem = new Map<number, { stage: Stage, draft: Draft }>();
const rejectMem = new Map<number, { reqNo: string }>();   // 담당자 반려 사유 입력 대기
const cancelMem = new Map<number, { reqNo: string }>();   // 요청자 취소 사유 입력 대기

const ask = (ctx: any, message: string) =>
  ctx.reply(message, { reply_markup: { force_reply: true } });

/** ========== 액션들 ========== */
bot.action('register_start', async ctx => {
  await ctx.answerCbQuery();
  await ask(ctx, REGISTER_PROMPT);
});

bot.action('purchase_menu', async ctx => {
  await ctx.answerCbQuery();

  // 접근 권한(직원 승인 여부) 체크
  const ok = await isApprovedUser(String(ctx.from!.id));
  if (!ok) {
    return ctx.reply('접근 권한이 없습니다. 신규 직원 등록 후 관리자에게 승인을 요청해 주세요.');
  }

  await ctx.reply(
    '구매 메뉴입니다. 원하시는 작업을 선택하세요.',
    Markup.inlineKeyboard([
      [
        Markup.button.callback('구매 요청', 'purchase_request'),
        Markup.button.callback('구매 승인', 'purchase_approve'),
      ],
      [ Markup.button.callback('내 요청 보기', 'my_requests') ],
      [ Markup.button.callback('뒤로 가기', 'go_back') ],
    ])
  );
});

/** 구매요청 시작 */
bot.action('purchase_request', async ctx => {
  await ctx.answerCbQuery();
  purchaseMem.set(ctx.chat!.id, { stage: 'item', draft: {} });
  await ask(ctx, '구매 요청을 시작합니다.\n① 물품명을 입력해 주세요.');
});

/** 구매승인(대기목록 요약) */
bot.action('purchase_approve', async ctx => {
  await ctx.answerCbQuery();

  // 관리자만 접근
  const ok = await isManager(String(ctx.from!.id));
  if (!ok) return ctx.reply('담당자 권한이 없습니다.');

  const all = await getAllPurchases();
  const pending = all
    .map((r,i)=>purchaseRowToObject(r,i+2))
    .filter(o => o.status === '대기중');

  if (pending.length === 0) {
    return ctx.reply('대기 중인 구매요청이 없습니다. 👍');
  }

  const summary = `대기 중인 구매요청: ${pending.length}건\n요청번호 목록을 눌러 상세 확인/처리하세요.`;
  const rows = [];
  for (const p of pending.slice(0, 10)) { // 처음 10개만 버튼
    rows.push([Markup.button.callback(p.no, `req|${p.no}`)]);
  }
  if (pending.length > 10) {
    rows.push([Markup.button.callback(`…외 ${pending.length-10}건`, 'noop')]);
  }
  rows.push([Markup.button.callback('뒤로 가기', 'go_back')]);

  await ctx.reply(summary, Markup.inlineKeyboard(rows));
});

/** 내 요청 보기(대기중만 요약 + 취소 버튼) */
bot.action('my_requests', async ctx => {
  await ctx.answerCbQuery();

  const myId = String(ctx.from!.id);
  const all = await getAllPurchases();
  const minePending = all
    .map((r,i)=>purchaseRowToObject(r,i+2))
    .filter(o => o.requesterChatId === myId && o.status === '대기중');

  if (minePending.length === 0) {
    return ctx.reply('대기 중인 나의 구매요청이 없습니다.');
  }

  const head = `나의 대기중 요청: ${minePending.length}건`;
  const blocks: any[] = [];
  for (const p of minePending.slice(0, 10)) {
    const line = `• ${p.no} | ${p.item} (${p.qty}) / ${Number(p.price||0).toLocaleString()}원`;
    const kb = Markup.inlineKeyboard([
      [ Markup.button.callback('상세보기', `req|${p.no}`),
        Markup.button.callback('요청 취소', `cancelreq|${p.no}`) ],
    ]);
    blocks.push({ line, kb });
  }

  await ctx.reply(head);
  for (const b of blocks) await ctx.reply(b.line, b.kb);
});

/** 상세 보기(관리자/요청자 공통) */
bot.action(/^req\|(.+)$/, async ctx => {
  await ctx.answerCbQuery();
  const reqNo = ctx.match[1];
  const row = await findPurchaseByNo(reqNo);
  if (!row) return ctx.reply('요청을 찾을 수 없습니다.');

  const text =
    `[구매 요청 상세]\n` +
    `번호: ${row.no}\n요청자: ${row.requesterName}(${row.requesterChatId})\n` +
    `물품: ${row.item}\n수량: ${row.qty}\n가격: ${Number(row.price||0).toLocaleString()}원\n` +
    `사유: ${row.reason}\n비고: ${row.note}\n` +
    `상태: ${row.status}\n요청시각: ${row.requestedAt}\n처리자: ${row.approver || '-'}`;

  // 버튼 구성: 관리자면 승인/반려, 요청자면 취소
  const myId = String(ctx.from!.id);
  const kbRows: any[] = [];
  if (await isManager(myId) && row.status === '대기중') {
    kbRows.push([
      Markup.button.callback('✅ 승인', `approve|${row.no}`),
      Markup.button.callback('❌ 반려', `reject|${row.no}`),
    ]);
  }
  if (row.requesterChatId === myId && row.status === '대기중') {
    kbRows.push([Markup.button.callback('요청 취소', `cancelreq|${row.no}`)]);
  }
  kbRows.push([Markup.button.callback('뒤로 가기', 'go_back')]);

  await ctx.reply(text, Markup.inlineKeyboard(kbRows));
});

/** 요청자: 취소 시작 → 사유 입력 대기 */
bot.action(/^cancelreq\|(.+)$/, async ctx => {
  await ctx.answerCbQuery();
  const reqNo = ctx.match[1];
  const row = await findPurchaseByNo(reqNo);
  if (!row) return ctx.reply('요청을 찾을 수 없습니다.');
  const myId = String(ctx.from!.id);
  if (row.requesterChatId !== myId) return ctx.reply('본인 요청만 취소할 수 있습니다.');
  if (row.status !== '대기중') return ctx.reply(`이미 처리된 요청입니다. (상태: ${row.status})`);

  cancelMem.set(ctx.from!.id, { reqNo });
  await ctx.reply('요청 취소 사유를 입력해 주세요.', { reply_markup: { force_reply: true } });
});

/** 뒤로가기 */
bot.action('go_back', async ctx => {
  purchaseMem.delete(ctx.chat!.id);
  rejectMem.delete(ctx.chat!.id);
  cancelMem.delete(ctx.chat!.id);
  await replyMenu(ctx);
});

bot.action('noop', async ctx => ctx.answerCbQuery());

/** ========== 텍스트 처리 (입력 플로우) ========== */
bot.on('text', async ctx => {
  try {
    const text = String((ctx.message as any)?.text || '').trim();
    const asked = (ctx.message as any)?.reply_to_message?.text || '';

    // /cancel
    if (/^\/cancel$/i.test(text)) {
      purchaseMem.delete(ctx.chat!.id);
      rejectMem.delete(ctx.chat!.id);
      cancelMem.delete(ctx.chat!.id);
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

    // 담당자 반려 사유 입력
    const rej = rejectMem.get(ctx.chat!.id);
    if (rej) {
      const ok = await isManager(String(ctx.chat!.id));
      if (!ok) {
        rejectMem.delete(ctx.chat!.id);
        return ctx.reply('담당자 권한이 없습니다.');
      }
      const approverName = (await getEmployeeNameByChatId(String(ctx.chat!.id))) || `User-${ctx.chat!.id}`;
      const res = await updateStatusRejected(rej.reqNo, approverName, text);
      if (res.already) {
        rejectMem.delete(ctx.chat!.id);
        return ctx.reply(`이미 처리된 구매요청 건입니다. (현재상태: ${res.status})`);
      }
      const row = res.row!;
      await broadcastToManagers(
        `[구매 요청 처리 안내]\n${row.no} 요청이 ❌반려되었습니다.\n처리자: ${approverName}\n사유: ${text}`
      );
      await notifyUser(
        row.requesterChatId,
        `[구매 요청 결과]\n${row.no} 요청이 ❌반려되었습니다.\n처리자: ${approverName}\n사유: ${text}`
      );
      rejectMem.delete(ctx.chat!.id);
      return ctx.reply('반려 처리되었습니다.');
    }

    // 요청자 취소 사유 입력
    const can = cancelMem.get(ctx.chat!.id);
    if (can) {
      const myName = (await getEmployeeNameByChatId(String(ctx.chat!.id))) || `User-${ctx.chat!.id}`;
      const res = await updateStatusCancelled(can.reqNo, myName, text);
      if (res.already) {
        cancelMem.delete(ctx.chat!.id);
        return ctx.reply(`이미 처리된 구매요청 건입니다. (현재상태: ${res.status})`);
      }
      const row = res.row!;
      await broadcastToManagers(
        `[구매 요청 취소]\n${row.no} 요청이 요청자에 의해 취소되었습니다.\n요청자: ${row.requesterName}(${row.requesterChatId})\n사유: ${text}`
      );
      cancelMem.delete(ctx.chat!.id);
      return ctx.reply('요청 취소 처리되었습니다.');
    }

    // 구매요청 단계별 입력
    const state = purchaseMem.get(ctx.chat!.id);
    if (state) {
      const d = state.draft;

      if (state.stage === 'item') {
        d.item = text.slice(0, 100);
        state.stage = 'qty';
        return ask(ctx, '② 수량을 입력해 주세요. (숫자만)');
      }

      if (state.stage === 'qty') {
        const n = text.replace(/[, ]/g, '');
        if (!/^\d+$/.test(n)) return ask(ctx, '❗ 숫자만 입력해 주세요. 다시 입력: 수량');
        d.qty = n;
        state.stage = 'price';
        return ask(ctx, '③ 가격을 입력해 주세요. (숫자만, 단위 없이)');
      }

      if (state.stage === 'price') {
        const n = text.replace(/[, ]/g, '');
        if (!/^\d+$/.test(n)) return ask(ctx, '❗ 숫자만 입력해 주세요. 다시 입력: 가격');
        d.price = n;
        state.stage = 'reason';
        return ask(ctx, '④ 구매 사유를 입력해 주세요.');
      }

      if (state.stage === 'reason') {
        d.reason = text.slice(0, 300);
        state.stage = 'note';
        return ask(ctx, '⑤ 비고(선택)를 입력해 주세요. 없으면 "없음"이라고 적어주세요.');
      }

      if (state.stage === 'note') {
        d.note = text.slice(0, 300);

        // 🔶 미리보기 & 확정/취소
        state.stage = 'confirm';
        const preview =
          `[구매 요청 미리보기]\n` +
          `물품: ${d.item}\n수량: ${d.qty}\n가격: ${Number(d.price||0).toLocaleString()}원\n` +
          `사유: ${d.reason}\n비고: ${d.note}\n\n위 내용으로 요청하시겠어요?`;
        const kb = Markup.inlineKeyboard([
          [ Markup.button.callback('🟩 요청하기', 'confirm_submit'),
            Markup.button.callback('🟥 취소하기', 'cancel_submit') ],
        ]);
        return ctx.reply(preview, kb);
      }
    }

    await ctx.reply('메뉴로 돌아가려면 /start 를 입력하세요. (진행 중 취소: /cancel)');
  } catch (err: any) {
    console.error('TEXT_HANDLER_ERROR', err?.response?.data || err);
    await ctx.reply('처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
  }
});

/** 미리보기 → 확정 제출 */
bot.action('confirm_submit', async ctx => {
  await ctx.answerCbQuery();
  const st = purchaseMem.get(ctx.chat!.id);
  if (!st || st.stage !== 'confirm') return ctx.reply('확정할 요청이 없습니다.');
  const d = st.draft;

  const requesterName =
    (await getEmployeeNameByChatId(String(ctx.chat!.id))) || `User-${ctx.chat!.id}`;

  const reqNo = await savePurchase(
    String(ctx.chat!.id),
    requesterName,
    d.item!, d.qty!, d.price!, d.reason!, d.note!
  );

  await ctx.reply(
    `구매 요청이 접수되었습니다 ✅\n요청번호: ${reqNo}\n물품: ${d.item}\n수량: ${d.qty}\n가격: ${Number(d.price||0).toLocaleString()}원`
  );
  purchaseMem.delete(ctx.chat!.id);

  // 담당자 알림(요약 → 상세/승인/반려 버튼)
  const msg =
    `[구매 요청 알림]\n` +
    `번호: ${reqNo}\n요청자: ${requesterName}(${ctx.chat!.id})\n` +
    `물품: ${d.item}\n수량: ${d.qty} / 가격: ${Number(d.price||0).toLocaleString()}원\n` +
    `사유: ${d.reason}\n비고: ${d.note}`;
  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ 승인', `approve|${reqNo}`),
      Markup.button.callback('❌ 반려', `reject|${reqNo}`),
    ],
    [Markup.button.callback('상세 보기', `req|${reqNo}`)],
  ]);
  await broadcastToManagers(msg, kb);

  return replyMenu(ctx);
});

/** 미리보기 → 취소 */
bot.action('cancel_submit', async ctx => {
  await ctx.answerCbQuery();
  purchaseMem.delete(ctx.chat!.id);
  await ctx.reply('구매 요청이 취소되었습니다. 처음부터 다시 진행해 주세요.');
  return replyMenu(ctx);
});

/** 승인 */
bot.action(/^approve\|(.+)$/, async ctx => {
  try {
    await ctx.answerCbQuery();
    const reqNo = ctx.match[1];
    if (!await isManager(String(ctx.from!.id))) return ctx.reply('담당자 권한이 없습니다.');

    const approverName =
      (await getEmployeeNameByChatId(String(ctx.from!.id))) || `User-${ctx.from!.id}`;

    const res = await updateStatusApproved(reqNo, approverName);
    if (res.already) return ctx.reply(`이미 처리된 구매요청 건입니다. (현재상태: ${res.status})`);

    const row = res.row!;
    await broadcastToManagers(
      `[구매 요청 처리 안내]\n${row.no} 요청이 ✅승인되었습니다.\n처리자: ${approverName}`
    );
    await notifyUser(
      row.requesterChatId,
      `[구매 요청 결과]\n${row.no} 요청이 ✅승인되었습니다.\n처리자: ${approverName}`
    );
    await ctx.reply('승인 처리되었습니다.');
  } catch (e:any) {
    console.error('APPROVE_ERROR', e?.response?.data || e);
    await ctx.reply('처리 중 오류가 발생했습니다.');
  }
});

/** 반려 시작 → 사유 입력 대기 */
bot.action(/^reject\|(.+)$/, async ctx => {
  try {
    await ctx.answerCbQuery();
    const reqNo = ctx.match[1];
    if (!await isManager(String(ctx.from!.id))) return ctx.reply('담당자 권한이 없습니다.');

    // 상태 확인
    const row = await findPurchaseByNo(reqNo);
    if (!row) return ctx.reply('요청을 찾을 수 없습니다.');
    if (row.status !== '대기중') return ctx.reply(`이미 처리된 요청입니다. (상태: ${row.status})`);

    rejectMem.set(ctx.from!.id, { reqNo });
    await ctx.reply('반려 사유를 입력해 주세요.', { reply_markup: { force_reply: true } });
  } catch (e:any) {
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
