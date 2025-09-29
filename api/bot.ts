// @ts-nocheck
import { Telegraf, Markup } from 'telegraf';
import { google } from 'googleapis';

const bot = new Telegraf(process.env.BOT_TOKEN!);

/** ========== Google Sheets Auth ========== */
const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS!);
const auth = new google.auth.JWT({
  email: creds.client_email,
  key: creds.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

/** ========== 시트 설정 ========== */
const EMPLOYEE_SHEET_ID = process.env.GS_SHEET_ID!;
const EMPLOYEE_SHEET = 'Chat_ID';
const COL_MANAGER = 5;      // F열(0-based): '관리자'
const COL_EMP_APPROVED = 6; // G열(0-based): '직원승인' (값: '승인')

const PURCHASE_SHEET_ID = process.env.GS_PURCHASE_SHEET_ID || EMPLOYEE_SHEET_ID;
const PURCHASE_SHEET = 'Purchase_List';

/** ========== 공통 유틸 ========== */
async function authorize() { await auth.authorize(); }
const nowTS = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

async function getEmployeeRow(chatId: string) {
  await authorize();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: EMPLOYEE_SHEET_ID,
    range: `${EMPLOYEE_SHEET}!A2:G`,
  });
  const rows = res.data.values || [];
  const idx = rows.findIndex(r => String(r?.[0] || '') === String(chatId));
  if (idx === -1) return null;
  const rowNum = idx + 2;
  const r = rows[idx];
  return {
    rowNum,
    chatId: r?.[0] || '',
    name: r?.[1] || '',
    isManager: (r?.[COL_MANAGER] || '').toString().replace(/\s+/g,'') === '관리자',
    isApproved: (r?.[COL_EMP_APPROVED] || '').toString().replace(/\s+/g,'') === '승인',
  };
}
async function getEmployeeNameByChatId(chatId: string) {
  const r = await getEmployeeRow(chatId);
  return r?.name || '';
}
async function getManagers() {
  await authorize();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: EMPLOYEE_SHEET_ID,
    range: `${EMPLOYEE_SHEET}!A2:G`,
  });
  const rows = res.data.values || [];
  return rows
    .filter(r => (r?.[COL_MANAGER] || '').toString().replace(/\s+/g,'')==='관리자')
    .map(r => ({ chatId: r?.[0] || '', name: r?.[1] || '' }));
}
async function requireApprovedEmployee(ctx: any) {
  const row = await getEmployeeRow(String(ctx.from?.id));
  if (!row || !row.isApproved) {
    await ctx.reply('접근권한이 없습니다. 신규 직원 등록 후 관리자에게 문의하세요.');
    return false;
  }
  return true;
}

/** 구매요청 헬퍼 */
async function findPurchaseRowByNo(reqNo: string) {
  await authorize();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!A2:A`,
  });
  const rows = res.data.values || [];
  for (let i=0;i<rows.length;i++){
    if (String(rows[i][0])===reqNo) return i+2;
  }
  return null;
}
async function getPurchaseByNo(reqNo: string) {
  await authorize();
  const row = await findPurchaseRowByNo(reqNo);
  if (!row) return null;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!A${row}:M${row}`,
  });
  const v = res.data.values?.[0] || [];
  return {
    reqNo: v[0], requesterName: v[1], requesterChatId: v[2],
    item: v[3], qty: v[4], price: v[5], reason: v[6], note: v[7],
    status: v[8], approver: v[9], rejectReason: v[10],
    requestedAt: v[11], decidedAt: v[12],
  };
}
async function getPendingRequests() {
  await authorize();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!A2:M`,
  });
  const rows = res.data.values || [];
  return rows
    .filter(r => (r?.[8] || '') === '' || (r?.[8] || '') === '대기중')
    .map(r => ({ reqNo: r?.[0] || '' }))
    .filter(x => !!x.reqNo);
}
async function getMyPending(chatId: string) {
  await authorize();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!A2:M`,
  });
  const rows = res.data.values || [];
  return rows
    .filter(r => String(r?.[2] || '')===String(chatId) && ((r?.[8] || '')==='' || (r?.[8] || '')==='대기중'))
    .map(r => ({ reqNo: r?.[0] || '' }))
    .filter(x => !!x.reqNo);
}

/** 저장/상태 업데이트 */
async function saveEmployee(chatId: string, name: string) {
  await authorize();
  const ts = nowTS();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: EMPLOYEE_SHEET_ID,
    range: `${EMPLOYEE_SHEET}!A2:A`,
  });
  const rows = res.data.values || [];
  let rowIndex = -1;
  for (let i=0;i<rows.length;i++){ if (String(rows[i][0])===chatId){ rowIndex=i+2; break; } }
  if (rowIndex> -1){
    await sheets.spreadsheets.values.update({
      spreadsheetId: EMPLOYEE_SHEET_ID,
      range: `${EMPLOYEE_SHEET}!B${rowIndex}:E${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[name,'','',ts]] },
    });
  }else{
    await sheets.spreadsheets.values.append({
      spreadsheetId: EMPLOYEE_SHEET_ID,
      range: `${EMPLOYEE_SHEET}!A:E`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[chatId,name,'','',ts]] },
    });
  }
}
async function savePurchase(chatId:string,name:string,item:string,qty:string,price:string,reason:string,note:string){
  await authorize();
  const ts = nowTS();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!A2:A`,
  });
  const rows = res.data.values || [];
  const last = rows.length>0 ? rows[rows.length-1][0] : null;
  let no='구매-001';
  if (last && typeof last==='string' && last.startsWith('구매-')){
    const n = parseInt(last.split('-')[1]||'0',10);
    no = `구매-${String((isNaN(n)?0:n)+1).padStart(3,'0')}`;
  }
  await sheets.spreadsheets.values.append({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!A:M`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[no,name,chatId,item,qty,price,reason,note,'대기중','','',ts,'']] },
  });
  return no;
}
async function updateStatusApproved(reqNo:string, approverName:string){
  await authorize();
  const row = await findPurchaseRowByNo(reqNo);
  if (!row) throw new Error('요청 행을 찾을 수 없습니다.');
  const cur = await sheets.spreadsheets.values.get({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!A${row}:M${row}`,
  });
  const curVals = cur.data.values?.[0]||[];
  const status = curVals[8];
  if (status && status!=='대기중') return { already:true, status, curVals };
  const ts = nowTS();
  await sheets.spreadsheets.values.update({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!I${row}:M${row}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [['승인', approverName, '', curVals[11]||'', ts]] },
  });
  return { already:false, curVals };
}
async function updateStatusRejected(reqNo:string, approverName:string, reason:string){
  await authorize();
  const row = await findPurchaseRowByNo(reqNo);
  if (!row) throw new Error('요청 행을 찾을 수 없습니다.');
  const cur = await sheets.spreadsheets.values.get({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!A${row}:M${row}`,
  });
  const curVals = cur.data.values?.[0]||[];
  const status = curVals[8];
  if (status && status!=='대기중') return { already:true, status, curVals };
  const ts = nowTS();
  await sheets.spreadsheets.values.update({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!I${row}:M${row}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [['반려', approverName, reason, curVals[11]||'', ts]] },
  });
  return { already:false, curVals };
}

/** 알림 */
async function broadcastToManagers(text:string){
  const ms = await getManagers();
  for (const m of ms){ try{ await bot.telegram.sendMessage(m.chatId, text);}catch{} }
}
async function notifyRequester(chatId:string, text:string){
  try{ await bot.telegram.sendMessage(chatId, text);}catch{}
}

/** 메뉴 */
function replyMenu(ctx:any){
  return ctx.reply(
    '안녕하세요. 하이파이코리아입니다. 무엇을 도와드릴까요?',
    Markup.inlineKeyboard([
      [ Markup.button.callback('신규 직원 등록', 'register_start'),
        Markup.button.callback('구매 요청 및 승인', 'purchase_menu') ],
    ])
  );
}

const REGISTER_PROMPT = '신규 직원 등록을 위해 성함을 입력해 주세요.';
const TRIGGER = /^(?:\/start|start|hi|hello|안녕|하이|헬로)\s*$/i;

bot.start(ctx => replyMenu(ctx));
bot.hears(TRIGGER, ctx => replyMenu(ctx));

/** 디버그: 관리자 */
bot.command('debug_admins', async ctx => {
  const admins = await getManagers();
  await ctx.reply(
    admins.length
      ? '관리자 목록:\n' + admins.map(a => `- ${a.name || '(이름없음)'} (${a.chatId})`).join('\n')
      : '관리자가 없습니다. Chat_ID 시트 F열에 "관리자", G열에 "직원승인" 값을 확인하세요.'
  );
});

/** 상태머신 & 반려 메모 */
type Stage = 'item' | 'qty' | 'price' | 'reason' | 'note';
type PurchaseState = { stage: Stage; data: { item?:string; qty?:string; price?:string; reason?:string; note?:string } };
const purchaseMem = new Map<number, PurchaseState>();
const rejectMem = new Map<number, { reqNo:string }>();
const ask = (ctx:any,msg:string)=>ctx.reply(msg,{ reply_markup:{ force_reply:true }});

/** 액션들 */
bot.action('register_start', async ctx => { await ctx.answerCbQuery(); await ask(ctx, REGISTER_PROMPT); });

bot.action('purchase_menu', async ctx => {
  await ctx.answerCbQuery();
  // 1) 직원 승인 필수
  const ok = await requireApprovedEmployee(ctx);
  if (!ok) return;

  await ctx.reply(
    '구매 메뉴입니다. 원하시는 작업을 선택하세요.',
    Markup.inlineKeyboard([
      [ Markup.button.callback('구매 요청', 'purchase_request'),
        Markup.button.callback('구매 승인', 'purchase_approve') ],
      [ Markup.button.callback('내 요청 보기', 'my_requests') ],
      [ Markup.button.callback('뒤로 가기', 'go_back') ],
    ])
  );
});

bot.action('purchase_request', async ctx => {
  await ctx.answerCbQuery();
  // 접근전 승인 체크
  const ok = await requireApprovedEmployee(ctx);
  if (!ok) return;

  purchaseMem.set(ctx.chat!.id, { stage: 'item', data: {} });
  await ask(ctx, '구매 요청을 시작합니다.\n① 물품명을 입력해 주세요.');
});

bot.action('my_requests', async ctx => {
  await ctx.answerCbQuery();
  const ok = await requireApprovedEmployee(ctx);
  if (!ok) return;

  const mine = await getMyPending(String(ctx.from!.id));
  if (mine.length === 0) {
    return ctx.reply('대기중인 나의 구매 요청이 없습니다.');
  }
  const items = mine.slice(0, 30).map(p => Markup.button.callback(p.reqNo, `view|${p.reqNo}`));
  const rows:any[][]=[]; for(let i=0;i<items.length;i+=3) rows.push(items.slice(i,i+3));
  rows.push([Markup.button.callback('뒤로', 'purchase_menu')]);
  await ctx.reply('나의 대기중 요청입니다. 확인할 요청번호를 선택하세요.', Markup.inlineKeyboard(rows));
});

bot.action('purchase_approve', async ctx => {
  await ctx.answerCbQuery();
  // 승인 메뉴: 직원 승인 & 관리자 둘 다 필요
  const okEmp = await requireApprovedEmployee(ctx);
  if (!okEmp) return;

  const managers = await getManagers();
  const isMgr = managers.some(m => String(m.chatId)===String(ctx.from?.id));
  if (!isMgr) return ctx.reply('담당자 권한이 없습니다.');

  const pendings = await getPendingRequests();
  if (pendings.length === 0) return ctx.reply('대기중인 구매요청이 없습니다.');

  const items = pendings.slice(0,30).map(p => Markup.button.callback(p.reqNo, `view|${p.reqNo}`));
  const rows:any[][]=[]; for(let i=0;i<items.length;i+=3) rows.push(items.slice(i,i+3));
  rows.push([Markup.button.callback('뒤로', 'purchase_menu')]);

  await ctx.reply('대기중인 구매요청 목록입니다. 확인할 요청번호를 선택하세요.', Markup.inlineKeyboard(rows));
});

bot.action(/^view\|(.+)$/, async ctx => {
  await ctx.answerCbQuery();
  // 보기 자체도 승인 받은 직원만
  const ok = await requireApprovedEmployee(ctx);
  if (!ok) return;

  const reqNo = ctx.match[1];
  const data = await getPurchaseByNo(reqNo);
  if (!data) return ctx.reply('요청을 찾을 수 없습니다.');

  const text =
    `• 번호: ${data.reqNo}\n` +
    `• 요청자: ${data.requesterName || '-'} (${data.requesterChatId})\n` +
    `• 물품/수량/가격: ${data.item} / ${data.qty} / ${Number(data.price||0).toLocaleString()}\n` +
    `• 사유: ${data.reason || '-'}\n` +
    `• 비고: ${data.note || '-'}\n` +
    `• 상태: ${data.status || '대기중'}\n` +
    `• 요청 시각: ${data.requestedAt || '-'}`;

  // 승인/반려 버튼은 '관리자만' 보이게
  const managers = await getManagers();
  const isMgr = managers.some(m => String(m.chatId)===String(ctx.from?.id));

  const rows:any[][] = [];
  if (isMgr && (!data.status || data.status==='대기중')) {
    rows.push([Markup.button.callback('✅ 승인', `approve|${reqNo}`),
               Markup.button.callback('❌ 반려', `reject|${reqNo}`)]);
  }
  rows.push([Markup.button.callback('목록으로', 'purchase_menu')]);

  await ctx.reply(text, Markup.inlineKeyboard(rows));
});

bot.action('go_back', async ctx => { purchaseMem.delete(ctx.chat!.id); await replyMenu(ctx); });

/** 텍스트 흐름 */
bot.on('text', async ctx => {
  try{
    const text = String((ctx.message as any)?.text || '').trim();
    const asked = (ctx.message as any)?.reply_to_message?.text || '';

    if (/^\/cancel$/i.test(text)){
      purchaseMem.delete(ctx.chat!.id); rejectMem.delete(ctx.chat!.id);
      await ctx.reply('취소되었습니다. /start 로 다시 시작하세요.'); return;
    }
    if (TRIGGER.test(text)) return replyMenu(ctx);

    // 직원 등록
    if (asked.startsWith(REGISTER_PROMPT)){
      const name = text; if (!name) return;
      await saveEmployee(String(ctx.chat!.id), name);
      await ctx.reply(`${name}님 신규 직원 등록이 완료되었습니다 🙇`);
      return replyMenu(ctx);
    }

    // 반려 사유 입력(담당자)
    const rej = rejectMem.get(ctx.chat!.id);
    if (rej){
      const managers = await getManagers();
      const okMgr = managers.some(m => String(m.chatId)===String(ctx.chat!.id));
      if (!okMgr){ await ctx.reply('담당자 권한이 없습니다.'); rejectMem.delete(ctx.chat!.id); return; }
      const approverName = (await getEmployeeNameByChatId(String(ctx.chat!.id))) || `User-${ctx.chat!.id}`;
      const res = await updateStatusRejected(rej.reqNo, approverName, text);
      if (res.already){ await ctx.reply(`이미 처리된 구매요청 건입니다. (현재상태: ${res.status})`); rejectMem.delete(ctx.chat!.id); return; }
      const requesterChatId = res.curVals![2];
      await broadcastToManagers(`[구매 요청 처리 안내]\n${rej.reqNo} 요청이 ❌반려되었습니다.\n처리자: ${approverName}\n사유: ${text}`);
      await notifyRequester(requesterChatId, `[구매 요청 결과]\n${rej.reqNo} 요청이 ❌반려되었습니다.\n처리자: ${approverName}\n사유: ${text}`);
      await ctx.reply('반려 처리되었습니다.'); rejectMem.delete(ctx.chat!.id); return;
    }

    // 구매요청 입력 상태머신
    const state = purchaseMem.get(ctx.chat!.id);
    if (state){
      const data = state.data;
      if (state.stage==='item'){ data.item = text.slice(0,100); state.stage='qty'; await ask(ctx,'② 수량을 입력해 주세요. (숫자만)'); return; }
      if (state.stage==='qty'){
        const n = text.replace(/[, ]/g,''); if (!/^\d+$/.test(n)){ await ask(ctx,'❗ 숫자만 입력해 주세요. 다시 입력: 수량'); return; }
        data.qty = n; state.stage='price'; await ask(ctx,'③ 가격을 입력해 주세요. (숫자만, 단위 없이)'); return;
      }
      if (state.stage==='price'){
        const n = text.replace(/[, ]/g,''); if (!/^\d+$/.test(n)){ await ask(ctx,'❗ 숫자만 입력해 주세요. 다시 입력: 가격'); return; }
        data.price = n; state.stage='reason'; await ask(ctx,'④ 구매 사유를 입력해 주세요.'); return;
      }
      if (state.stage==='reason'){ data.reason = text.slice(0,300); state.stage='note'; await ask(ctx,'⑤ 비고(선택)를 입력해 주세요. 없으면 "없음"이라고 적어주세요.'); return; }
      if (state.stage==='note'){
        data.note = text.slice(0,300); purchaseMem.delete(ctx.chat!.id);

        // 직원 승인 체크 (요청 제출 시에도)
        const ok = await requireApprovedEmployee(ctx);
        if (!ok) return;

        const requesterName = (await getEmployeeNameByChatId(String(ctx.chat!.id))) || `User-${ctx.chat!.id}`;
        const reqNo = await savePurchase(String(ctx.chat!.id), requesterName, data.item!, data.qty!, data.price!, data.reason!, data.note!);

        await ctx.reply(`구매 요청이 접수되었습니다 ✅\n요청번호: ${reqNo}\n물품: ${data.item}\n수량: ${data.qty}\n가격: ${Number(data.price).toLocaleString()}`);

        const managers = await getManagers();
        const msg = `[구매 요청 알림]\n번호: ${reqNo}\n요청자: ${requesterName}(${ctx.chat!.id})\n물품: ${data.item}\n수량: ${data.qty} / 가격: ${Number(data.price).toLocaleString()}\n사유: ${data.reason}\n비고: ${data.note}`;
        const kb  = Markup.inlineKeyboard([[ Markup.button.callback('✅ 승인', `approve|${reqNo}`), Markup.button.callback('❌ 반려', `reject|${reqNo}`) ]]);
        for (const m of managers){ try{ await bot.telegram.sendMessage(m.chatId, msg, kb);}catch{} }
        return replyMenu(ctx);
      }
    }

    await ctx.reply('메뉴로 돌아가려면 /start 를 입력하세요. (진행 중 취소: /cancel)');
  }catch(err:any){
    console.error('TEXT_HANDLER_ERROR', err?.response?.data || err);
    await ctx.reply('처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
  }
});

/** 승인/반려 콜백 */
bot.action(/^approve\|(.+)$/, async ctx => {
  try{
    await ctx.answerCbQuery();
    // 관리자 + 직원승인 둘 다 체크
    const okEmp = await requireApprovedEmployee(ctx); if (!okEmp) return;
    const managers = await getManagers();
    const okMgr = managers.some(m => String(m.chatId)===String(ctx.from?.id));
    if (!okMgr) return ctx.reply('담당자 권한이 없습니다.');

    const reqNo = ctx.match[1];
    const approverName = (await getEmployeeNameByChatId(String(ctx.from!.id))) || `User-${ctx.from!.id}`;
    const res = await updateStatusApproved(reqNo, approverName);
    if (res.already) return ctx.reply(`이미 처리된 구매요청 건입니다. (현재상태: ${res.status})`);

    const requesterChatId = res.curVals![2];
    await broadcastToManagers(`[구매 요청 처리 안내]\n${reqNo} 요청이 ✅승인되었습니다.\n처리자: ${approverName}`);
    await notifyRequester(requesterChatId, `[구매 요청 결과]\n${reqNo} 요청이 ✅승인되었습니다.\n처리자: ${approverName}`);
    await ctx.reply('승인 처리되었습니다.');
  }catch(e:any){
    console.error('APPROVE_ERROR', e?.response?.data || e);
    await ctx.reply('처리 중 오류가 발생했습니다.');
  }
});

bot.action(/^reject\|(.+)$/, async ctx => {
  try{
    await ctx.answerCbQuery();
    const okEmp = await requireApprovedEmployee(ctx); if (!okEmp) return;
    const managers = await getManagers();
    const okMgr = managers.some(m => String(m.chatId)===String(ctx.from?.id));
    if (!okMgr) return ctx.reply('담당자 권한이 없습니다.');

    const reqNo = ctx.match[1];
    const row = await findPurchaseRowByNo(reqNo); if (!row) return ctx.reply('요청을 찾을 수 없습니다.');
    const cur = await sheets.spreadsheets.values.get({
      spreadsheetId: PURCHASE_SHEET_ID,
      range: `${PURCHASE_SHEET}!I${row}:I${row}`,
    });
    const status = cur.data.values?.[0]?.[0] || '';
    if (status && status!=='대기중') return ctx.reply(`이미 처리된 구매요청 건입니다. (현재상태: ${status})`);

    rejectMem.set(ctx.from!.id, { reqNo });
    await ctx.reply('반려 사유를 입력해 주세요.', { reply_markup: { force_reply: true } });
  }catch(e:any){
    console.error('REJECT_START_ERROR', e?.response?.data || e);
    await ctx.reply('처리 중 오류가 발생했습니다.');
  }
});

/** Vercel API */
export default async function handler(req:any,res:any){
  try{
    if (req.method==='POST'){ await bot.handleUpdate(req.body as any); return res.status(200).send('ok'); }
    return res.status(200).send('ok');
  }catch(e){ console.error('HANDLER_ERROR', e); return res.status(200).send('ok'); }
}
