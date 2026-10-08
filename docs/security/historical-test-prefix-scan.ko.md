# 과거 합성 접두사 탐지

고정된 Gitleaks 액션은 8.24.3 버전을 사용합니다. Push 이벤트는 지정된
커밋 범위를 검사하고 수동 실행은 보존된 전체 Git 이력을 검사합니다.
`8d054d4322c508ab574559f818d02bdb2810acef`의 수동 실행에서 과거 PostgreSQL
workload-identity 통합 테스트의 `generic-api-key` 탐지 한 건이 확인됐습니다.
[영문 설명](historical-test-prefix-scan.md).

## 정확한 처리 범위

해당 위치는 `d7c1f08358d2a1128381c5d73ab8ccadc4abd85e` 커밋의
`packages/postgres/src/workload-identity-migration.integration.test.ts` 177번째
줄입니다. `createValues`의 두 번째 인자인 12글자 합성 공개 조회 접두사이며,
완전한 API 키, 비밀번호 또는 제공자 인증값이 아닙니다. 테스트는 명시적인
합성 해시 데이터를 사용하며 tenant context가 없으면 거부되는지 확인합니다.
현재 테스트도 `testPrefix`를 통해 같은 접두사를 구성합니다. 서비스 인증값을
테스트 데이터에 복사하지 않습니다.

루트 [.gitleaksignore](../../.gitleaksignore)는
[8.24.3 문서](https://github.com/gitleaks/gitleaks/blob/v8.24.3/README.md#gitleaksignore)에
따라 이 커밋·경로·규칙·줄 번호의 정확한 fingerprint 한 건만 기록합니다.
파일 전체, 규칙, 값 또는 다른 커밋을 제외하지 않습니다. 검사 버전, 기본
규칙, 이벤트별 검사 범위와 실패 종료 코드는 유지합니다. 기존 실패한 CI는
실패한 기록으로 남으며, 이후 통과한 검사가 그 기록이나 Git 이력을 바꾸지 않습니다.

## 검증

고정 버전과 100% 마스킹으로 전체 이력을 검사합니다. 처리 전에는 이 과거
fingerprint 한 건이 탐지되고, 정확한 fingerprint 처리 후에는 전체 이력 검사가
통과하는지 확인합니다. 별도의 일회용 저장소에 과거 테스트 내용과 이 ignore
파일을 새로 커밋하여 동일한 합성 접두사가 새 커밋의 fingerprint로 계속
탐지되고 검사가 실패하는지 확인합니다. 검토 출력에는 마스킹된 보고서와
탐지 위치만 남깁니다. 이 대조 검사는 새 발생이 제외되지 않음을 확인하며,
모든 비밀정보를 탐지할 수 있음을 증명하지 않습니다.
