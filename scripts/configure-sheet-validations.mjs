import 'dotenv/config';
import { google } from 'googleapis';

function requireEnv(name, fallback = undefined) {
  const rawValue = process.env[name];
  const value = rawValue === undefined || rawValue === null || rawValue === '' ? fallback : rawValue;
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function quoteSheetName(sheetName) {
  return `'${sheetName.replaceAll("'", "''")}'`;
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
  const inventorySheetName = requireEnv('GOOGLE_CERTIFICATE_SHEET_NAME', '시트1');
  const optionsSheetName = requireEnv('GOOGLE_OPTIONS_SHEET_NAME', 'Options');
  const sheets = await getSheetsClient();

  const metadata = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties(sheetId,title,gridProperties)'
  });
  const existingSheets = new Map(
    (metadata.data.sheets ?? []).map((sheet) => [sheet.properties.title, sheet.properties])
  );
  const inventorySheet = existingSheets.get(inventorySheetName);
  if (!inventorySheet) {
    throw new Error(`Inventory sheet not found: ${inventorySheetName}`);
  }

  if (!existingSheets.has(optionsSheetName)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: {
                title: optionsSheetName,
                gridProperties: {
                  rowCount: 100,
                  columnCount: 5
                }
              }
            }
          }
        ]
      }
    });
  }

  const inventoryResponse = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${quoteSheetName(inventorySheetName)}!A1:AZ1000`
  });
  const rows = inventoryResponse.data.values ?? [];
  const headers = rows[0] ?? [];
  const usageColumnIndex = headers.indexOf('용도');
  if (usageColumnIndex < 0) {
    throw new Error('Missing 용도 header in inventory sheet.');
  }

  const existingUsages = rows
    .slice(1)
    .map((row) => String(row[usageColumnIndex] ?? '').trim())
    .filter(Boolean);
  const defaultUsages = ['Apache용', 'Resin용', 'tomcat용', 'netty용', '기타'];
  const usageOptions = [...new Set([...existingUsages, ...defaultUsages])].sort((a, b) =>
    a.localeCompare(b, 'ko')
  );

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${quoteSheetName(optionsSheetName)}!A1:A${usageOptions.length + 1}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [['용도'], ...usageOptions.map((value) => [value])]
    }
  });

  const refreshedMetadata = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties(sheetId,title,gridProperties)'
  });
  const refreshedSheets = new Map(
    (refreshedMetadata.data.sheets ?? []).map((sheet) => [sheet.properties.title, sheet.properties])
  );
  const optionsSheet = refreshedSheets.get(optionsSheetName);
  const rowCount = inventorySheet.gridProperties?.rowCount ?? 1000;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: {
              sheetId: optionsSheet.sheetId,
              startRowIndex: 0,
              endRowIndex: 1,
              startColumnIndex: 0,
              endColumnIndex: 1
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
        },
        {
          updateDimensionProperties: {
            range: {
              sheetId: optionsSheet.sheetId,
              dimension: 'COLUMNS',
              startIndex: 0,
              endIndex: 1
            },
            properties: { pixelSize: 160 },
            fields: 'pixelSize'
          }
        },
        {
          setDataValidation: {
            range: {
              sheetId: inventorySheet.sheetId,
              startRowIndex: 1,
              endRowIndex: rowCount,
              startColumnIndex: usageColumnIndex,
              endColumnIndex: usageColumnIndex + 1
            },
            rule: {
              condition: {
                type: 'ONE_OF_LIST',
                values: usageOptions.map((value) => ({ userEnteredValue: value }))
              },
              strict: false,
              showCustomUi: true
            }
          }
        }
      ]
    }
  });

  console.log(`Configured 용도 dropdown with ${usageOptions.length} option(s).`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
