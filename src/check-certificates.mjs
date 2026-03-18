import { google } from 'googleapis';

const REQUIRED_HEADERS = ['service_name', 'expires_at'];
const STATE_HEADERS = ['tracked_expires_at', 'notified_30d_at', 'notified_14d_at'];

function requireEnv(name, fallback = undefined) {
  const rawValue = process.env[name];
  const value = rawValue === undefined || rawValue === null || rawValue === '' ? fallback : rawValue;
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function normalizeHeader(header) {
  return String(header ?? '').trim().toLowerCase();
}

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function parseSheetDate(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value === 'number') {
    const base = new Date(Date.UTC(1899, 11, 30));
    base.setUTCDate(base.getUTCDate() + value);
    return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
  }

  const raw = String(value).trim();
  if (!raw) {
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [year, month, day] = raw.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day));
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

function daysBetween(from, to) {
  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((to - from) / millisecondsPerDay);
}

function columnToLetter(columnIndex) {
  let current = columnIndex + 1;
  let result = '';

  while (current > 0) {
    const remainder = (current - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    current = Math.floor((current - 1) / 26);
  }

  return result;
}

function getAlertWindow(daysRemaining, row) {
  if (daysRemaining <= 14 && daysRemaining >= 0 && !row.notified14dAt) {
    return 14;
  }

  if (daysRemaining <= 30 && daysRemaining > 14 && !row.notified30dAt) {
    return 30;
  }

  return null;
}

async function getSheetsClient(serviceAccountJson) {
  const credentials = JSON.parse(serviceAccountJson);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  return google.sheets({ version: 'v4', auth });
}

async function sendTeamsAlert(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Teams workflow request failed: ${response.status} ${body}`);
  }
}

async function main() {
  const serviceAccountJson = requireEnv('GOOGLE_SERVICE_ACCOUNT_JSON');
  const spreadsheetId = requireEnv('GOOGLE_SHEET_ID');
  const workflowUrl = requireEnv('TEAMS_WORKFLOW_URL');
  const sheetName = requireEnv('GOOGLE_SHEET_NAME', 'Inventory');

  const sheets = await getSheetsClient(serviceAccountJson);
  const readRange = `${sheetName}!A:ZZ`;
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: readRange
  });

  const rows = response.data.values ?? [];
  if (rows.length === 0) {
    console.log('No rows found.');
    return;
  }

  const headers = rows[0].map(normalizeHeader);
  for (const requiredHeader of REQUIRED_HEADERS) {
    if (!headers.includes(requiredHeader)) {
      throw new Error(`Missing required sheet header: ${requiredHeader}`);
    }
  }

  const headerIndex = new Map(headers.map((header, index) => [header, index]));
  const updates = [];
  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const nowIso = new Date().toISOString();

  for (const header of STATE_HEADERS) {
    if (!headerIndex.has(header)) {
      throw new Error(`Missing state header: ${header}`);
    }
  }

  let sentCount = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const rowNumber = i + 1;
    const values = rows[i];
    const serviceName = String(values[headerIndex.get('service_name')] ?? '').trim();
    const expiresRaw = values[headerIndex.get('expires_at')];

    if (!serviceName && !expiresRaw) {
      continue;
    }

    const expiresAt = parseSheetDate(expiresRaw);
    if (!expiresAt) {
      console.warn(`Skipping row ${rowNumber}: invalid expires_at value "${expiresRaw}"`);
      continue;
    }

    const expiresAtIso = toIsoDate(expiresAt);
    const trackedExpiresAt = String(values[headerIndex.get('tracked_expires_at')] ?? '').trim();
    const notified30dAt = String(values[headerIndex.get('notified_30d_at')] ?? '').trim();
    const notified14dAt = String(values[headerIndex.get('notified_14d_at')] ?? '').trim();
    const owner = String(values[headerIndex.get('owner')] ?? '').trim();
    const teamsRecipient = String(values[headerIndex.get('teams_recipient')] ?? '').trim();
    const notes = String(values[headerIndex.get('notes')] ?? '').trim();

    const rowModel = {
      notified30dAt,
      notified14dAt
    };

    if (trackedExpiresAt !== expiresAtIso) {
      rowModel.notified30dAt = '';
      rowModel.notified14dAt = '';

      updates.push({
        range: `${sheetName}!${columnToLetter(headerIndex.get('tracked_expires_at'))}${rowNumber}`,
        values: [[expiresAtIso]]
      });
      updates.push({
        range: `${sheetName}!${columnToLetter(headerIndex.get('notified_30d_at'))}${rowNumber}`,
        values: [['']]
      });
      updates.push({
        range: `${sheetName}!${columnToLetter(headerIndex.get('notified_14d_at'))}${rowNumber}`,
        values: [['']]
      });
    }

    const daysRemaining = daysBetween(todayUtc, expiresAt);
    const alertWindow = getAlertWindow(daysRemaining, rowModel);
    if (!alertWindow) {
      continue;
    }

    const payload = {
      eventType: 'certificate_expiry_alert',
      serviceName,
      owner,
      teamsRecipient,
      expiresAt: expiresAtIso,
      daysRemaining,
      alertWindowDays: alertWindow,
      notes,
      rowNumber,
      summary: `[D-${alertWindow}] ${serviceName} certificate expires on ${expiresAtIso}`,
      markdown: [
        `Service: ${serviceName}`,
        owner ? `Owner: ${owner}` : null,
        teamsRecipient ? `Teams recipient: ${teamsRecipient}` : null,
        `Expires at: ${expiresAtIso}`,
        `Days remaining: ${daysRemaining}`,
        notes ? `Notes: ${notes}` : null
      ]
        .filter(Boolean)
        .join('\n')
    };

    await sendTeamsAlert(workflowUrl, payload);

    const notifiedHeader = alertWindow === 30 ? 'notified_30d_at' : 'notified_14d_at';
    updates.push({
      range: `${sheetName}!${columnToLetter(headerIndex.get(notifiedHeader))}${rowNumber}`,
      values: [[nowIso]]
    });
    sentCount += 1;
    console.log(`Alert sent for row ${rowNumber}: ${serviceName} (D-${alertWindow})`);
  }

  if (updates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: updates
      }
    });
  }

  console.log(`Finished. Alerts sent: ${sentCount}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
