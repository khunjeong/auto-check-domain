# auto-check-domain

Google Sheets를 인증서 inventory로 사용하고, GitHub Actions가 매일 실행되어 만료 D-30 / D-14 알림을 Microsoft Teams Workflows로 전송하는 배치 프로젝트입니다.

## Architecture

- Google Sheets: 인증서 inventory 및 알림 상태 저장
- GitHub Actions: 매일 스케줄 실행
- Node.js script: 시트 조회, 만료 계산, Teams Workflows 호출, 시트 상태 업데이트
- Teams Workflows: 수신한 JSON payload를 개인 또는 채널 메시지로 전달

## Sheet schema

기본 시트 이름은 `Inventory`입니다. 첫 번째 행은 헤더여야 합니다.

필수 컬럼:

- `service_name`: 서비스 또는 인증서 이름
- `expires_at`: 만료일 (`YYYY-MM-DD` 권장)

선택 컬럼:

- `owner`: 담당자 이름 또는 팀명
- `teams_recipient`: Teams Workflow에서 사용할 대상 힌트
- `notes`: 부가 설명

상태 컬럼:

- `tracked_expires_at`: 마지막으로 추적한 만료일. 만료일이 바뀌면 알림 상태를 초기화하는 데 사용
- `notified_30d_at`: D-30 구간 알림 발송 시각
- `notified_14d_at`: D-14 구간 알림 발송 시각

예시:

| service_name | expires_at | owner | teams_recipient | notes | tracked_expires_at | notified_30d_at | notified_14d_at |
| --- | --- | --- | --- | --- | --- | --- | --- |
| bastion-prod | 2026-04-17 | Platform Team | user@company.com | SSH host cert |  |  |  |

## GitHub Secrets

다음 Secrets를 저장소에 추가해야 합니다.

- `GOOGLE_SERVICE_ACCOUNT_JSON`: Google service account JSON 전체 문자열
- `GOOGLE_SHEET_ID`: Google Sheets 문서 ID
- `TEAMS_WORKFLOW_URL`: Teams Workflow HTTP trigger URL

선택 Variables / Secrets:

- `GOOGLE_SHEET_NAME`: 기본값 `Inventory`

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
  "eventType": "certificate_expiry_alert",
  "serviceName": "bastion-prod",
  "owner": "Platform Team",
  "teamsRecipient": "user@company.com",
  "expiresAt": "2026-04-17",
  "daysRemaining": 30,
  "alertWindowDays": 30,
  "summary": "[D-30] bastion-prod certificate expires on 2026-04-17",
  "markdown": "Service: bastion-prod\nOwner: Platform Team\nExpires at: 2026-04-17\nDays remaining: 30"
}
```

## Local usage

```bash
npm install
npm run check
```

필요한 환경 변수:

```bash
export GOOGLE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
export GOOGLE_SHEET_ID='your-sheet-id'
export TEAMS_WORKFLOW_URL='https://...'
export GOOGLE_SHEET_NAME='Inventory'
```

## Alert behavior

- `daysRemaining <= 30 && daysRemaining > 14` 이고 `notified_30d_at`가 비어 있으면 D-30 알림 전송
- `daysRemaining <= 14 && daysRemaining >= 0` 이고 `notified_14d_at`가 비어 있으면 D-14 알림 전송
- `expires_at` 값이 바뀌면 `tracked_expires_at`을 갱신하고 기존 발송 상태를 초기화

이 방식은 GitHub Actions 스케줄 지연이 있더라도 알림을 놓칠 확률을 줄입니다.
