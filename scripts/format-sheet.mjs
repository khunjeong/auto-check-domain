import 'dotenv/config';
import { google } from 'googleapis';

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

function requireEnv(name, fallback = undefined) {
  const rawValue = process.env[name];
  const value = rawValue === undefined || rawValue === null || rawValue === '' ? fallback : rawValue;
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function repeatColumnFormat(sheetId, rowCount, columnIndex, userEnteredFormat) {
  return {
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: 1,
        endRowIndex: rowCount,
        startColumnIndex: columnIndex,
        endColumnIndex: columnIndex + 1
      },
      cell: { userEnteredFormat },
      fields: 'userEnteredFormat'
    }
  };
}

async function getSheetsClient() {
  const credentials = JSON.parse(requireEnv('GOOGLE_SERVICE_ACCOUNT_JSON'));
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  return google.sheets({ version: 'v4', auth });
}

async function main() {
  const spreadsheetId = requireEnv('GOOGLE_SHEET_ID');
  const sheetName = requireEnv('GOOGLE_CERTIFICATE_SHEET_NAME', '시트1');
  const sheets = await getSheetsClient();

  const metadata = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties(sheetId,title,gridProperties)'
  });
  const sheet = metadata.data.sheets?.find((item) => item.properties?.title === sheetName);
  if (!sheet) {
    throw new Error(`Sheet not found: ${sheetName}`);
  }

  const sheetId = sheet.properties.sheetId;
  const rowCount = sheet.properties.gridProperties?.rowCount ?? 1000;
  const headerResponse = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A1:AZ1`
  });
  const headers = headerResponse.data.values?.[0] ?? [];
  const headerCount = headers.length;
  const requests = [];

  requests.push({
    updateSheetProperties: {
      properties: {
        sheetId,
        gridProperties: { frozenRowCount: 1 }
      },
      fields: 'gridProperties.frozenRowCount'
    }
  });

  requests.push({
    setBasicFilter: {
      filter: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: rowCount,
          startColumnIndex: 0,
          endColumnIndex: headerCount
        }
      }
    }
  });

  requests.push({
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: 0,
        endRowIndex: 1,
        startColumnIndex: 0,
        endColumnIndex: headerCount
      },
      cell: {
        userEnteredFormat: {
          backgroundColor: { red: 0.1, green: 0.22, blue: 0.36 },
          horizontalAlignment: 'CENTER',
          textFormat: {
            foregroundColor: { red: 1, green: 1, blue: 1 },
            bold: true
          }
        }
      },
      fields: 'userEnteredFormat(backgroundColor,horizontalAlignment,textFormat)'
    }
  });

  requests.push({
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: 1,
        endRowIndex: rowCount,
        startColumnIndex: 0,
        endColumnIndex: headerCount
      },
      cell: {
        userEnteredFormat: {
          verticalAlignment: 'MIDDLE',
          wrapStrategy: 'WRAP'
        }
      },
      fields: 'userEnteredFormat(verticalAlignment,wrapStrategy)'
    }
  });

  const dateHeaders = ['인증서발급일', '인증서만료일', '계약 만료일', '30일전알림일', '14일전알림일'];
  for (const header of dateHeaders) {
    const index = headers.indexOf(header);
    if (index >= 0) {
      requests.push(
        repeatColumnFormat(sheetId, rowCount, index, {
          numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' },
          horizontalAlignment: 'CENTER'
        })
      );
    }
  }

  const centerHeaders = ['인증서수량', 'Year', '상태', '운영환경'];
  for (const header of centerHeaders) {
    const index = headers.indexOf(header);
    if (index >= 0) {
      requests.push(
        repeatColumnFormat(sheetId, rowCount, index, {
          horizontalAlignment: 'CENTER'
        })
      );
    }
  }

  const widths = {
    구매업체: 150,
    기업: 150,
    도메인: 230,
    용도: 150,
    인증서수량: 90,
    인증서발급일: 120,
    인증서만료일: 120,
    '계약 만료일': 120,
    Brand: 120,
    인증서종류: 140,
    Year: 80,
    상태: 100,
    담당팀: 150,
    알림채널: 180,
    '30일전알림일': 140,
    '14일전알림일': 140,
    메모: 220,
    서비스명: 180,
    서비스도메인: 230,
    운영환경: 110,
    담당자: 120,
    담당자이메일: 220,
    담당부서: 150,
    연락채널: 180,
    서비스메모: 220
  };

  headers.forEach((header, index) => {
    requests.push({
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: 'COLUMNS',
          startIndex: index,
          endIndex: index + 1
        },
        properties: { pixelSize: widths[header] ?? 130 },
        fields: 'pixelSize'
      }
    });
  });

  const statusIndex = headers.indexOf('상태');
  if (statusIndex >= 0) {
    requests.push({
      addConditionalFormatRule: {
        index: 0,
        rule: {
          ranges: [
            {
              sheetId,
              startRowIndex: 1,
              endRowIndex: rowCount,
              startColumnIndex: statusIndex,
              endColumnIndex: statusIndex + 1
            }
          ],
          booleanRule: {
            condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'ACTIVE' }] },
            format: {
              backgroundColor: { red: 0.85, green: 0.95, blue: 0.88 },
              textFormat: { foregroundColor: { red: 0.05, green: 0.36, blue: 0.16 }, bold: true }
            }
          }
        }
      }
    });
    requests.push({
      addConditionalFormatRule: {
        index: 0,
        rule: {
          ranges: [
            {
              sheetId,
              startRowIndex: 1,
              endRowIndex: rowCount,
              startColumnIndex: statusIndex,
              endColumnIndex: statusIndex + 1
            }
          ],
          booleanRule: {
            condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'INACTIVE' }] },
            format: {
              backgroundColor: { red: 0.96, green: 0.88, blue: 0.88 },
              textFormat: { foregroundColor: { red: 0.55, green: 0.08, blue: 0.08 }, bold: true }
            }
          }
        }
      }
    });
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests }
  });

  console.log(`Formatted ${sheetName} (${columnToLetter(headerCount - 1)} column).`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
