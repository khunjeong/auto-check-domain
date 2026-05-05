import 'dotenv/config';
import { google } from 'googleapis';

const ASSET_CONFIGS = [
  {
    assetType: 'certificate',
    envName: 'GOOGLE_CERTIFICATE_SHEET_NAME',
    defaultSheetName: 'Certificates',
    nameHeaders: ['certificate_name', 'service_name', '도메인'],
    expiresAtHeaders: ['expires_at', '인증서만료일']
  },
  {
    assetType: 'domain',
    envName: 'GOOGLE_DOMAIN_SHEET_NAME',
    defaultSheetName: 'Domains',
    nameHeaders: ['domain_name', '도메인'],
    expiresAtHeaders: ['expires_at', '계약 만료일']
  }
];
const VENDOR_HEADERS = ['vendor_key', 'vendor_name'];
const HEADER_ALIASES = {
  owner: ['owner', '담당팀'],
  teamsRecipient: ['teams_recipient', '알림채널'],
  notes: ['notes', '메모', '용도'],
  vendorKey: ['vendor_key', '구매업체'],
  trackedExpiresAt: ['tracked_expires_at'],
  notified30dAt: ['notified_30d_at', '30일전알림일'],
  notified14dAt: ['notified_14d_at', '14일전알림일'],
  status: ['status', '상태'],
  serviceName: ['service_name', '서비스명'],
  serviceDomain: ['service_domain', '서비스도메인'],
  environment: ['environment', '운영환경'],
  contactName: ['contact_name', '담당자'],
  contactEmail: ['contact_email', '담당자이메일'],
  department: ['department', '담당부서'],
  contactChannel: ['contact_channel', '연락채널'],
  serviceNotes: ['service_notes', '서비스메모']
};

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

function getHeaderValue(values, headerIndex, headerName) {
  const columnIndex = headerIndex.get(headerName);
  if (columnIndex === undefined) {
    return '';
  }
  return String(values[columnIndex] ?? '').trim();
}

function resolveHeader(headerIndex, headerNames) {
  return headerNames.find((header) => headerIndex.has(header)) ?? null;
}

function getAliasedHeaderValue(values, headerIndex, headerNames) {
  const headerName = resolveHeader(headerIndex, headerNames);
  return headerName ? getHeaderValue(values, headerIndex, headerName) : '';
}

function queueUpdateIfHeaderExists(updates, sheetName, headerIndex, headerNames, rowNumber, value) {
  const headerName = resolveHeader(headerIndex, headerNames);
  if (!headerName) {
    return;
  }

  updates.push({
    range: `${sheetName}!${columnToLetter(headerIndex.get(headerName))}${rowNumber}`,
    values: [[value]]
  });
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

function isDryRun() {
  return ['1', 'true', 'yes'].includes(String(process.env.DRY_RUN ?? '').trim().toLowerCase());
}

async function getSheetRows(sheets, spreadsheetId, sheetName) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A:ZZ`
  });
  return response.data.values ?? [];
}

async function loadVendors(sheets, spreadsheetId, sheetName) {
  try {
    const rows = await getSheetRows(sheets, spreadsheetId, sheetName);
    if (rows.length === 0) {
      return new Map();
    }

    const headers = rows[0].map(normalizeHeader);
    const headerIndex = new Map(headers.map((header, index) => [header, index]));
    for (const requiredHeader of VENDOR_HEADERS) {
      if (!headerIndex.has(requiredHeader)) {
        throw new Error(`Missing vendor header: ${requiredHeader}`);
      }
    }

    const vendorMap = new Map();
    for (let i = 1; i < rows.length; i += 1) {
      const values = rows[i];
      const vendorKey = getHeaderValue(values, headerIndex, 'vendor_key');
      if (!vendorKey) {
        continue;
      }

      vendorMap.set(vendorKey, {
        vendorKey,
        vendorName: getHeaderValue(values, headerIndex, 'vendor_name'),
        vendorContact: getHeaderValue(values, headerIndex, 'vendor_contact'),
        vendorEmail: getHeaderValue(values, headerIndex, 'vendor_email'),
        vendorNotes: getHeaderValue(values, headerIndex, 'vendor_notes')
      });
    }

    return vendorMap;
  } catch (error) {
    console.warn(`Vendor sheet "${sheetName}" could not be loaded: ${error.message}`);
    return new Map();
  }
}

async function processAssetSheet({ sheets, spreadsheetId, workflowUrl, sheetName, assetType, nameHeaders, vendorMap, nowIso, todayUtc, dryRun }) {
  const rows = await getSheetRows(sheets, spreadsheetId, sheetName);
  if (rows.length === 0) {
    console.log(`No rows found in ${sheetName}.`);
    return { sentCount: 0 };
  }

  const headers = rows[0].map(normalizeHeader);
  const headerIndex = new Map(headers.map((header, index) => [header, index]));
  const assetNameHeader = resolveHeader(headerIndex, nameHeaders);
  if (!assetNameHeader) {
    throw new Error(`Missing required asset name header in ${sheetName}: one of ${nameHeaders.join(', ')}`);
  }
  const expiresAtHeader = resolveHeader(headerIndex, ASSET_CONFIGS.find((config) => config.assetType === assetType).expiresAtHeaders);
  if (!expiresAtHeader) {
    throw new Error(`Missing required expiry header in ${sheetName}`);
  }
  const has30dStateHeader = resolveHeader(headerIndex, HEADER_ALIASES.notified30dAt);
  const has14dStateHeader = resolveHeader(headerIndex, HEADER_ALIASES.notified14dAt);
  if (!has30dStateHeader || !has14dStateHeader) {
    throw new Error(`Missing notification state headers in ${sheetName}`);
  }

  const updates = [];
  let sentCount = 0;

  for (let i = 1; i < rows.length; i += 1) {
    const rowNumber = i + 1;
    const values = rows[i];
    const assetName = getHeaderValue(values, headerIndex, assetNameHeader);
    const expiresRaw = values[headerIndex.get(expiresAtHeader)];

    if (!assetName && !expiresRaw) {
      continue;
    }

    const status = getAliasedHeaderValue(values, headerIndex, HEADER_ALIASES.status);
    if (status && status.toUpperCase() !== 'ACTIVE') {
      continue;
    }

    const expiresAt = parseSheetDate(expiresRaw);
    if (!expiresAt) {
      console.warn(`Skipping ${sheetName} row ${rowNumber}: invalid expires_at value "${expiresRaw}"`);
      continue;
    }

    const expiresAtIso = toIsoDate(expiresAt);
    const trackedExpiresAt = getAliasedHeaderValue(values, headerIndex, HEADER_ALIASES.trackedExpiresAt);
    const notified30dAt = getAliasedHeaderValue(values, headerIndex, HEADER_ALIASES.notified30dAt);
    const notified14dAt = getAliasedHeaderValue(values, headerIndex, HEADER_ALIASES.notified14dAt);
    const owner = getAliasedHeaderValue(values, headerIndex, HEADER_ALIASES.owner);
    const teamsRecipient = getAliasedHeaderValue(values, headerIndex, HEADER_ALIASES.teamsRecipient);
    const notes = getAliasedHeaderValue(values, headerIndex, HEADER_ALIASES.notes);
    const vendorKey = getAliasedHeaderValue(values, headerIndex, HEADER_ALIASES.vendorKey);
    const vendor = vendorMap.get(vendorKey) ?? null;
    const serviceName = getAliasedHeaderValue(values, headerIndex, HEADER_ALIASES.serviceName);
    const serviceDomain = getAliasedHeaderValue(values, headerIndex, HEADER_ALIASES.serviceDomain);
    const environment = getAliasedHeaderValue(values, headerIndex, HEADER_ALIASES.environment);
    const contactName = getAliasedHeaderValue(values, headerIndex, HEADER_ALIASES.contactName);
    const contactEmail = getAliasedHeaderValue(values, headerIndex, HEADER_ALIASES.contactEmail);
    const department = getAliasedHeaderValue(values, headerIndex, HEADER_ALIASES.department);
    const contactChannel = getAliasedHeaderValue(values, headerIndex, HEADER_ALIASES.contactChannel);
    const serviceNotes = getAliasedHeaderValue(values, headerIndex, HEADER_ALIASES.serviceNotes);
    const rowModel = {
      notified30dAt,
      notified14dAt
    };

    if (trackedExpiresAt && trackedExpiresAt !== expiresAtIso) {
      rowModel.notified30dAt = '';
      rowModel.notified14dAt = '';

      queueUpdateIfHeaderExists(updates, sheetName, headerIndex, HEADER_ALIASES.trackedExpiresAt, rowNumber, expiresAtIso);
      queueUpdateIfHeaderExists(updates, sheetName, headerIndex, HEADER_ALIASES.notified30dAt, rowNumber, '');
      queueUpdateIfHeaderExists(updates, sheetName, headerIndex, HEADER_ALIASES.notified14dAt, rowNumber, '');
    } else if (!trackedExpiresAt) {
      queueUpdateIfHeaderExists(updates, sheetName, headerIndex, HEADER_ALIASES.trackedExpiresAt, rowNumber, expiresAtIso);
    }

    const daysRemaining = daysBetween(todayUtc, expiresAt);
    const alertWindow = getAlertWindow(daysRemaining, rowModel);
    if (!alertWindow) {
      continue;
    }

    const vendorSummary = vendor?.vendorName ?? vendorKey;
    const payload = {
      eventType: 'asset_expiry_alert',
      assetType,
      assetName,
      owner,
      teamsRecipient,
      expiresAt: expiresAtIso,
      daysRemaining,
      alertWindowDays: alertWindow,
      notes,
      vendorKey,
      vendor,
      service: {
        serviceName,
        serviceDomain,
        environment,
        contactName,
        contactEmail,
        department,
        contactChannel,
        serviceNotes
      },
      rowNumber,
      sheetName,
      summary: `[${assetType === 'domain' ? '도메인' : '인증서'} D-${alertWindow}] ${assetName} 만료 예정일은 ${expiresAtIso} 입니다.`,
      markdown: [
        `자산 유형: ${assetType === 'domain' ? '도메인' : '인증서'}`,
        `자산 이름: ${assetName}`,
        serviceName ? `서비스명: ${serviceName}` : null,
        serviceDomain ? `서비스 도메인: ${serviceDomain}` : null,
        environment ? `운영환경: ${environment}` : null,
        owner ? `담당자: ${owner}` : null,
        contactName ? `서비스 담당자: ${contactName}` : null,
        contactEmail ? `담당자 이메일: ${contactEmail}` : null,
        department ? `담당부서: ${department}` : null,
        contactChannel ? `연락채널: ${contactChannel}` : null,
        teamsRecipient ? `Teams 수신자: ${teamsRecipient}` : null,
        `만료일: ${expiresAtIso}`,
        `남은 일수: ${daysRemaining}일`,
        vendorSummary ? `관리 업체: ${vendorSummary}` : null,
        vendor?.vendorContact ? `업체 담당자: ${vendor.vendorContact}` : null,
        vendor?.vendorEmail ? `업체 이메일: ${vendor.vendorEmail}` : null,
        notes ? `비고: ${notes}` : null,
        serviceNotes ? `서비스 메모: ${serviceNotes}` : null,
        vendor?.vendorNotes ? `업체 메모: ${vendor.vendorNotes}` : null
      ]
        .filter(Boolean)
        .join('\n')
    };

    if (dryRun) {
      console.log(`Dry run alert payload for ${sheetName} row ${rowNumber}:`);
      console.log(JSON.stringify(payload, null, 2));
    } else {
      await sendTeamsAlert(workflowUrl, payload);
    }

    const notifiedHeaderAliases = alertWindow === 30 ? HEADER_ALIASES.notified30dAt : HEADER_ALIASES.notified14dAt;
    queueUpdateIfHeaderExists(updates, sheetName, headerIndex, notifiedHeaderAliases, rowNumber, nowIso);
    sentCount += 1;
    console.log(`Alert sent for ${sheetName} row ${rowNumber}: ${assetName} (${assetType}, D-${alertWindow})`);
  }

  if (updates.length > 0 && !dryRun) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: updates
      }
    });
  } else if (updates.length > 0 && dryRun) {
    console.log(`Dry run skipped ${updates.length} sheet update(s) for ${sheetName}.`);
  }

  return { sentCount };
}

async function main() {
  const serviceAccountJson = requireEnv('GOOGLE_SERVICE_ACCOUNT_JSON');
  const spreadsheetId = requireEnv('GOOGLE_SHEET_ID');
  const dryRun = isDryRun();
  const workflowUrl = dryRun ? process.env.TEAMS_WORKFLOW_URL || 'dry-run' : requireEnv('TEAMS_WORKFLOW_URL');
  const vendorSheetName = process.env.GOOGLE_VENDOR_SHEET_NAME || 'Vendors';

  const sheets = await getSheetsClient(serviceAccountJson);
  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const nowIso = new Date().toISOString();
  const vendorMap = await loadVendors(sheets, spreadsheetId, vendorSheetName);
  let sentCount = 0;

  for (const config of ASSET_CONFIGS) {
    const sheetName = requireEnv(config.envName, config.defaultSheetName);
    const result = await processAssetSheet({
      sheets,
      spreadsheetId,
      workflowUrl,
      sheetName,
      assetType: config.assetType,
      nameHeaders: config.nameHeaders,
      vendorMap,
      nowIso,
      todayUtc,
      dryRun
    });
    sentCount += result.sentCount;
  }

  console.log(`Finished. Alerts sent: ${sentCount}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
