# PostgreSQL 통합 CI 빌드 전달

[English](postgres-integration-ci.md) | [한국어](postgres-integration-ci.ko.md)

PostgreSQL CI는 **PostgreSQL integration build** 작업에서 의존성을 빌드한 뒤 테스트 작업으로
전달합니다. 두 작업 모두 통과해야 합니다. 테스트 작업의 기존 15분 제한, 빌드 준비 필터 7개와
제한된 동시성, 고정 의존성 설치, 서비스 버전, 직렬 통합 대상 7개, assertion과 테스트 timeout은
유지합니다. 전체 품질 검사는 별도로 전체 workspace를 빌드하고 검사합니다.
CI는 검증한 산출물 복원 뒤 기존 명령에 Turbo의 `--only`를 전달합니다. 통합 대상 7개는 모두
직렬로 실행하고 빌드 선행조건 22개는 필수 준비 작업의 결과를 사용합니다. Turbo 캐시는 전달하지
않으므로 이 옵션이 없으면 새 테스트 runner가 다시 빌드합니다. 일반 기여자 명령의 빌드
의존성은 유지합니다.

준비 작업은 패키지·앱 경로의 생성된 `dist`와 소스 SHA만 묶고 의존성 디렉터리와 Next 캐시는
제외합니다. 같은 실행에서 준비 작업이 반환한 정확한 숫자 artifact ID를 사용합니다. 테스트
작업은 압축 해제 전에 SHA-256을 준비 작업 출력과 대조하고, 포함된 소스 SHA가 checkout과
같은지 확인합니다. 누락·변조·다른 소스는 실패합니다. 실패한 테스트 작업만 재실행해도 기존의
성공한 준비 작업 출력을 사용할 수 있으며 mutable latest 선택이나 이전 artifact 덮어쓰기는
없습니다.

업로드·다운로드 action은 Node 24 버전의 정확한 커밋에 고정합니다. 빌드 artifact에는 설치된
의존성·실행 credential 파일·운영 DB·테스트 서비스 볼륨이 없습니다. 제품 백업·snapshot 게시·
release seal이 아니며, 테스트 재시도 추가나 취소된 실행의 성공 재분류도 아닙니다.
