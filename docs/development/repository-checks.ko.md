# 저장소 전체 검사

[English](repository-checks.md) | [한국어](repository-checks.ko.md)

`pnpm check`는 포맷·아키텍처 경계·문서 링크·공개 주장, 루트 Biome lint, acceptance runner
커버리지와 모든 패키지의 lint·타입·unit test 커버리지·빌드를 유지한다.
PostgreSQL/S3/recovery와 clean-checkout acceptance는 별도의 gate다.

패키지 검사는 동시에 최대 네 작업이 실행되는 하나의 Turbo graph를 사용한다.
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
개별 test 명령은 패키지 작업을 순차 실행하며, 합친 전체 검사는 동시에 네 작업만 실행한다.
개별 테스트의 시간 제한이나 단언을 바꾸지 않는다.

## 측정에 따른 실행 조정 — 2026-10-15

`4d0a3444e5e814bdaed3e0ade32c998292afd3df`는 정확한 전체 로컬 검사를 통과했지만
[원격 Quality gates](https://github.com/Kwondh0321/proofstack/actions/runs/38738640268)가
기존 20분 한도를 넘었다. 다른 CI 11개와 CodeQL은 통과했다. 이 취소는 승인 실패로 보존하며
테스트 단언 실패나 성공한 실행으로 바꾸어 기록하지 않는다.

동일한 깨끗한 소스와 CPU quota 4개인 같은 클라우드 머신에서 작업 슬롯 2개·4개로 캐시 없는
패키지 작업 122개를 실행했고, 양쪽 모두 unit test 16,305개와 빌드 31개를 통과했다.
Turbo 시간은 17m17.507s에서 15m39.785s로 약 9.4% 줄었다. 이 시간은 패키지 graph의 시간이며
전체 명령의 루트 검사와 acceptance runner 검사도 계속 유지한다. 두 로그의 SHA-256은 각각
`26067d5376f8b99342f725b13d4e7aecc93fde0c6fb3472c8e895fc398493bd0`과
`a5c5b082d28682388348595cb53cd3db7c604c1d18b33cf7e47bb0dc88f836c4`다.

네 작업 슬롯은 실행 순서만 바꾼다. 무거운 core/policy 테스트 파일은 직렬, 명시한 race 검사는
동시 실행하고 빌드 의존 barrier도 유지한다. 테스트·coverage·timeout·독립 CI 작업을 제거하거나
완화하지 않는다. 한 머신의 측정은 보편적 실행 시간 보장이 아니며 정확한 커밋의 원격 검사로
최종 승인 여부를 확인한다.
