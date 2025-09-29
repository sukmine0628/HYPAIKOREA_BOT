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
// 직원 시트
const EMPLOYEE_SHEET_ID = process.env.GS_SHEET_ID!;
const EMPLOYEE_SHEET = 'Chat_ID';
// F열이 "관리자"면 승인 담당자 (0-based index → A:0 ... F:5)
const EMPLOYEE_MANAGER_COL_INDEX = 5;

// 구매요청 시트 (분리 시 GS_PURCHASE_SHEET_ID 설정, 없으면 직원 시트와 동일)
const PURCHASE_SHEET_ID = process.env.GS_PURCHASE_SHEET_ID || EMPLOYEE_SHEET_ID;
const PURCHASE_SHEET = 'Purchase_List';

/** ========== 공통 유틸 ========== */
async function authorize() {
  await auth.authorize();
}
const nowTS = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

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

/** 관리자 리스트 (공백/대소문자 안전) + 디버그 로그 */
async function getManagers(): Promise<Array<{ chatId: string, name: string }>> {
  await authorize();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: EMPLOYEE_SHEET_ID,
    range: `${EMPLOYEE_SHEET}!A2:F`,
  });
  const rows = res.data.values || [];
  const managers: Array<{ chatId: string, name: string }> = [];

  for (const r of rows) {
    const chatId = (r?.[0] ?? '').toString().trim();
    const name   = (r?.[1] ?? '').toString().trim();
    const role   = (r?.[EMPLOYEE_MANAGER_COL_INDEX] ?? '').toString().trim();
    // 공백 제거 후 '관리자' 정확 매칭
    if (chatId && role.replace(/\s+/g, '') === '관리자') {
      managers.push({ chatId, name });
    }
  }
  console.log('ADMINS_DEBUG', { count: managers.length, managers });
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
    if (String(rows[i][0]) === reqNo) return i + 2; // header offset
  }
  return null;
}

/** 내가 올린 요청들 불러오기(최신 n개) */
async function listMyRequests(chatId: string, limit = 10) {
  await authorize();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: PURCHASE_SHEET_ID,
    range: `${PURCHASE_SHEET}!A2:M`,
  });
  const rows = res.data.values || [];
  // C열이 요청자 chatId
  const mine = rows.filter(r => String(r[2]) === String(chatId));
  // 최신순 정렬 (요청 시각 L열 기준, 없으면 뒤로)
  mine.sort((a, b) => (b[11] || '').localeCompare(a[11] || ''));
  return mine.slice(0, limit);
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
  if (la
