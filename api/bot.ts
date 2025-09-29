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
  return { already: false, curVal
