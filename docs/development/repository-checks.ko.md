# 저장소 전체 검사

[English](repository-checks.md) | [한국어](repository-checks.ko.md)

`pnpm check`는 포맷·아키텍처 경계·문서 링크·공개 주장, 루트 Biome lint, acceptance runner
커버리지와 모든 패키지의 lint·타입·unit test 커버리지·빌드를 유지한다.
PostgreSQL/S3/recovery와 clean-checkout acceptance는 별도의 gate다.

패키지 검사는 동시에 최대 두 작업이 실행되는 하나의 Turbo graph를 사용한다.
타입 검사와 테스트가 같은 빌드를 요구해도 패키지 빌드는 graph에서 한 번만 실행된다.
테스트·타입 검사는 자기 패키지의 빌드가 끝나기를 기다리며, 빌드는 기존 upstream 빌드에
의존한다. 자기 패키지의 export 파일을 빌드가 쓰는 도중 읽는 일을 막는다.
기존 테스트 제한 시간·파일 동시 실행 설정·커버리지 기준·CI job은 변경하지 않는다.

캐시 없는 검사는 다음 명령으로 실행한다.

```bash
CI=true TURBO_FORCE=true pnpm check
```

실제 보고서의 캐시 0, 전체 테스트 수와 빌드 성공을 확인한다. 중단·취소된 실행은 통과가
아니다. Workflow 시간 초과만으로 단언 실패를 주장하지 말고 정확한 job 판정과 annotation을
읽는다. 재검증 시 원래 실패를 보존하고 검사한 commit/tree를 구별한다.

개별 `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`도 사용할 수 있다.
개별 test 명령은 패키지 작업을 순차 실행하며, 합친 전체 검사는 동시에 두 작업만 실행한다.
개별 테스트의 시간 제한이나 단언을 바꾸지 않는다.
