# Outlook renewal request automation

이 문서는 회사 PC에서 Power Automate / Teams Workflows를 이용해 특정 업체에 갱신 요청 메일을 자동 발송하는 절차입니다.

## Goal

현재 배치 흐름은 아래와 같습니다.

```text
GitHub Actions
-> Google Sheets 만료 체크
-> D-30 / D-14 대상 발견
-> Teams Workflow HTTP URL로 payload 전송
-> Teams 알림 발송
```

여기에 아래 단계를 추가합니다.

```text
-> 구매업체가 한국전자인증이면
-> Outlook Send an email (V2)로 특정 메일에 갱신 요청 발송
```

## Recommended approach

Outlook 메일 발송은 GitHub Actions 코드에서 직접 하지 않고 Power Automate / Teams Workflow 안에서 처리합니다.

이 방식을 권장하는 이유:

- 개인 Outlook 계정 인증을 GitHub Secrets에 보관하지 않아도 됩니다.
- Microsoft Graph OAuth 토큰, refresh token, Azure 앱 등록을 직접 관리하지 않아도 됩니다.
- 회사 Microsoft 365 정책 안에서 Outlook connector 권한으로 발송됩니다.
- Teams 알림과 메일 발송을 같은 Workflow 안에서 조건 분기할 수 있습니다.

## Incoming payload

GitHub Actions가 Teams Workflow로 보내는 payload 예시는 아래와 같습니다.

```json
{
  "eventType": "asset_expiry_alert",
  "assetType": "certificate",
  "assetName": "*.kyobobook.co.kr",
  "owner": "",
  "teamsRecipient": "",
  "expiresAt": "2026-05-27",
  "daysRemaining": 22,
  "alertWindowDays": 30,
  "notes": "",
  "vendorKey": "한국전자인증",
  "vendor": null,
  "service": {
    "serviceName": "",
    "serviceDomain": "",
    "environment": "",
    "contactName": "",
    "contactEmail": "",
    "department": "",
    "contactChannel": "",
    "serviceNotes": ""
  },
  "rowNumber": 3,
  "sheetName": "인증서",
  "summary": "[인증서 D-30] *.kyobobook.co.kr 만료 예정일은 2026-05-27 입니다.",
  "markdown": "자산 유형: 인증서\n자산 이름: *.kyobobook.co.kr\n만료일: 2026-05-27\n남은 일수: 22일\n관리 업체: 한국전자인증"
}
```

메일 조건에는 우선 `vendorKey`를 사용합니다.

```text
vendorKey == 한국전자인증
```

## Workflow steps

1. Power Automate 또는 Teams Workflows에서 기존 HTTP request trigger Workflow를 엽니다.
2. 현재 Teams 메시지 발송 단계 아래에 `Condition`을 추가합니다.
3. 조건 왼쪽 값에 HTTP payload의 `vendorKey`를 넣습니다.
4. 조건 연산자는 `is equal to`를 선택합니다.
5. 조건 오른쪽 값은 아래처럼 입력합니다.

```text
한국전자인증
```

6. `If yes` 분기에 Outlook 액션을 추가합니다.
7. 액션은 `Office 365 Outlook` -> `Send an email (V2)`를 선택합니다.
8. `To`에는 갱신 요청을 받을 특정 메일 주소를 넣습니다.
9. `Subject`와 `Body`는 아래 예시를 사용합니다.
10. `If no` 분기는 비워두거나 아무 작업도 하지 않게 둡니다.

## Mail subject

권장 제목:

```text
[갱신 요청] @{triggerBody()?['assetName']} @{triggerBody()?['assetType']} 만료 D-@{triggerBody()?['alertWindowDays']}
```

좀 더 단순하게 시작하려면 아래처럼 고정 문구로 시작해도 됩니다.

```text
[갱신 요청] 인증서/도메인 만료 알림
```

## Mail body

권장 본문:

```text
안녕하세요.

아래 항목의 갱신 요청드립니다.

구분: @{triggerBody()?['assetType']}
대상: @{triggerBody()?['assetName']}
만료일: @{triggerBody()?['expiresAt']}
남은 일수: @{triggerBody()?['daysRemaining']}일
구매업체: @{triggerBody()?['vendorKey']}

서비스명: @{triggerBody()?['service']?['serviceName']}
서비스 도메인: @{triggerBody()?['service']?['serviceDomain']}
운영환경: @{triggerBody()?['service']?['environment']}
담당자: @{triggerBody()?['service']?['contactName']}
담당자 이메일: @{triggerBody()?['service']?['contactEmail']}
담당부서: @{triggerBody()?['service']?['department']}

비고:
@{triggerBody()?['notes']}

확인 후 갱신 진행 부탁드립니다.
```

## Suggested sheet columns

메일 발송까지 운영하려면 Google Sheet에 아래 컬럼을 추가하는 것을 권장합니다.

```text
갱신요청메일
자동갱신요청
갱신요청발송일
```

용도:

- `갱신요청메일`: 업체 또는 내부 담당자 메일 주소
- `자동갱신요청`: `Y` 또는 `N`
- `갱신요청발송일`: 메일 발송 후 기록할 날짜

초기에는 Power Automate에서 수신자를 고정 메일로 두고 시작해도 됩니다. 운영이 안정화되면 `갱신요청메일` 컬럼을 payload에 포함하도록 코드를 확장하는 편이 좋습니다.

## Test flow

1. Google Sheet에서 D-30 조건에 걸리는 테스트 행을 준비합니다.
2. `vendorKey` 또는 `구매업체` 값이 `한국전자인증`인지 확인합니다.
3. 로컬에서 먼저 dry run을 실행합니다.

```bash
DRY_RUN=true npm run check
```

4. payload에서 `vendorKey`가 `한국전자인증`으로 나오는지 확인합니다.
5. Teams Workflow URL을 `.env`에 넣습니다.
6. 실제 발송을 실행합니다.

```bash
npm run check
```

7. Teams 메시지가 발송되는지 확인합니다.
8. Outlook 메일이 지정한 수신자에게 발송되는지 확인합니다.

## Notes

- `DRY_RUN=true`에서는 Teams Workflow를 호출하지 않으므로 Outlook 메일도 발송되지 않습니다.
- 실제 메일 발송 테스트는 `npm run check` 또는 GitHub Actions 수동 실행으로 해야 합니다.
- Power Automate의 Outlook connector는 회사 정책에 따라 사용이 막혀 있을 수 있습니다.
- 개인 계정이 아니라 공유 사서함으로 보내야 한다면 `Send an email from a shared mailbox (V2)` 사용 가능 여부를 회사 Microsoft 365 관리자에게 확인해야 합니다.
