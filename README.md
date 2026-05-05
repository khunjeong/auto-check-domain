# auto-check-domain

Google Sheets를 inventory로 사용하고, GitHub Actions가 매일 실행되어 `도메인`과 `인증서`의 만료 D-30 / D-14 알림을 Microsoft Teams Workflows로 전송하는 배치 프로젝트입니다.

## Architecture

- Google Sheets: 도메인 / 인증서 inventory 및 업체 정보 저장
- GitHub Actions: 매일 스케줄 실행
- Node.js script: 다중 시트 조회, 만료 계산, Teams Workflows 호출, 시트 상태 업데이트
- Teams Workflows: 수신한 JSON payload를 개인 또는 채널 메시지로 전달

## Sheet layout

기본 시트는 3개입니다.

- `Certificates`
- `Domains`
- `Vendors`

첫 번째 행은 모두 헤더여야 합니다.

## Certificates sheet schema

필수 컬럼:

- `certificate_name` 또는 `service_name`
- `expires_at`

선택 컬럼:

- `owner`
- `teams_recipient`
- `notes`
- `vendor_key`

상태 컬럼:

- `tracked_expires_at`
- `notified_30d_at`
- `notified_14d_at`

예시:

| certificate_name | expires_at | owner | teams_recipient | vendor_key | notes | tracked_expires_at | notified_30d_at | notified_14d_at |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| api-prod-cert | 2026-04-17 | Platform Team | user@company.com | vendor-acme | Wildcard cert |  |  |  |

## Domains sheet schema

필수 컬럼:

- `domain_name`
- `expires_at`

선택 컬럼:

- `owner`
- `teams_recipient`
- `notes`
- `vendor_key`

상태 컬럼:

- `tracked_expires_at`
- `notified_30d_at`
- `notified_14d_at`

예시:

| domain_name | expires_at | owner | teams_recipient | vendor_key | notes | tracked_expires_at | notified_30d_at | notified_14d_at |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| example.com | 2026-05-01 | Growth Team | owner@company.com | vendor-registrar-1 | Main public domain |  |  |  |

## Vendors sheet schema

필수 컬럼:

- `vendor_key`
- `vendor_name`

선택 컬럼:

- `vendor_contact`
- `vendor_email`
- `vendor_notes`

예시:

| vendor_key | vendor_name | vendor_contact | vendor_email | vendor_notes |
| --- | --- | --- | --- | --- |
| vendor-acme | ACME Security | Kim Ops | ops@acme.example | Certificate renewals |
| vendor-registrar-1 | Example Registrar | Lee AM | am@registrar.example | Domain renewals |

## GitHub Secrets

다음 Secrets를 저장소에 추가해야 합니다.

- `GOOGLE_SERVICE_ACCOUNT_JSON`: Google service account JSON 전체 문자열
- `GOOGLE_SHEET_ID`: Google Sheets 문서 ID
- `TEAMS_WORKFLOW_URL`: Teams Workflow HTTP trigger URL

선택 Variables / Secrets:

- `GOOGLE_CERTIFICATE_SHEET_NAME`: 기본값 `Certificates`
- `GOOGLE_DOMAIN_SHEET_NAME`: 기본값 `Domains`
- `GOOGLE_VENDOR_SHEET_NAME`: 기본값 `Vendors`

로컬 실행은 `.env` 파일로 관리할 수 있습니다.

## Google setup

1. Google Cloud에서 Sheets API를 활성화합니다.
2. Service account를 생성합니다.
3. Inventory 스프레드시트를 service account 이메일에 공유합니다.
4. 서비스 계정 JSON을 `GOOGLE_SERVICE_ACCOUNT_JSON`로 GitHub Secrets에 저장합니다.

## Teams Workflows setup

권장 구성:

1. Teams에서 Workflow를 생성합니다.
2. 트리거는 HTTP request 수신 방식으로 설정합니다.
3. 본 스크립트가 보내는 JSON payload를 받아 개인 메시지 또는 채널 메시지를 전송하도록 구성합니다.
4. Workflow owner 외에 co-owner를 추가합니다.

스크립트가 보내는 payload 예시:

```json
{
  "eventType": "asset_expiry_alert",
  "assetType": "domain",
  "assetName": "example.com",
  "owner": "Platform Team",
  "teamsRecipient": "user@company.com",
  "expiresAt": "2026-05-01",
  "daysRemaining": 30,
  "alertWindowDays": 30,
  "vendorKey": "vendor-registrar-1",
  "vendor": {
    "vendorKey": "vendor-registrar-1",
    "vendorName": "Example Registrar",
    "vendorContact": "Lee AM",
    "vendorEmail": "am@registrar.example",
    "vendorNotes": "Domain renewals"
  },
  "summary": "[도메인 D-30] example.com 만료 예정일은 2026-05-01 입니다.",
  "markdown": "자산 유형: 도메인\n자산 이름: example.com\n담당자: Platform Team\n만료일: 2026-05-01\n남은 일수: 30일\n관리 업체: Example Registrar"
}
```

## Local usage

```bash
npm install
npm run check
```

필요한 환경 변수는 `.env` 또는 shell 환경 변수로 제공합니다.

```bash
GOOGLE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
GOOGLE_SHEET_ID='your-sheet-id'
TEAMS_WORKFLOW_URL='https://...'
GOOGLE_CERTIFICATE_SHEET_NAME='Certificates'
GOOGLE_DOMAIN_SHEET_NAME='Domains'
GOOGLE_VENDOR_SHEET_NAME='Vendors'
```

GitHub Actions에서는 `.env`를 읽지 않으므로, 실제 워크플로 실행에는 동일 값을 GitHub Secrets / Variables로 넣어야 합니다.

## Test

가장 안전한 테스트는 `DRY_RUN=true`로 실행하는 것입니다. 이 모드에서는 Google Sheets를 읽지만 Teams로 메시지를 보내지 않고, 시트 상태 컬럼도 업데이트하지 않습니다.

```bash
DRY_RUN=true npm run check
```

`DRY_RUN=true`에서는 `TEAMS_WORKFLOW_URL`이 없어도 실행됩니다.

테스트용 행을 만들 때는 `expires_at`을 오늘 기준 30일 이내 또는 14일 이내로 넣고, `notified_30d_at`, `notified_14d_at`은 비워 둡니다. 예를 들어 오늘이 2026-05-05라면 D-30 테스트는 `2026-06-04`, D-14 테스트는 `2026-05-19`를 사용합니다.

실제 Teams 알림까지 확인하려면 `DRY_RUN`을 제거하고 수동 실행합니다.

```bash
npm run check
```

## Alert behavior

- `Certificates` 시트와 `Domains` 시트를 모두 순회
- `daysRemaining <= 30 && daysRemaining > 14` 이고 `notified_30d_at`가 비어 있으면 D-30 알림 전송
- `daysRemaining <= 14 && daysRemaining >= 0` 이고 `notified_14d_at`가 비어 있으면 D-14 알림 전송
- `expires_at` 값이 바뀌면 `tracked_expires_at`을 갱신하고 기존 발송 상태를 초기화
- `vendor_key`가 있으면 `Vendors` 시트에서 업체 정보를 찾아 알림 payload에 포함

이 방식은 GitHub Actions 스케줄 지연이 있더라도 알림을 놓칠 확률을 줄입니다.
