# 저장소 전체 검사

[English](repository-checks.md) | [한국어](repository-checks.ko.md)

`pnpm check`는 포맷·아키텍처 경계·문서 링크·공개 주장, 루트 Biome lint, acceptance runner
커버리지와 모든 패키지의 lint·타입·unit test 커버리지·빌드를 유지한다.
PostgreSQL/S3/recovery와 clean-checkout acceptance는 별도의 gate다.

패키지 검사는 순서 있는 두 단계로 실행한다. 첫 Turbo graph는 모든 패키지의 빌드·lint·타입
검사를 동시에 최대 네 작업으로 실행한다. 빌드는 한 번씩 실행하고 upstream 의존성을 유지하며
타입 검사는 자기 빌드를 기다린다. 첫 단계 전체가 통과하면 `turbo run test --only --concurrency=1`로
완료한 빌드를 사용해 패키지 하나씩 테스트한다. `--only`는 `TURBO_FORCE=true`에서도 빌드를 다시
실행하지 않는다. 컴파일러나 다른 패키지 테스트와 CPU를 경쟁하지 않으며 테스트 제한 시간,
파일 동시 실행·명시한 race·coverage 기준·기존 CI 작업은 유지한다.

전체 명령은 `pnpm check:static` 뒤에 `pnpm check:test`를 실행한다. 후자는 현재 소스와 같은
빌드가 완료돼야 하는 내부 단계다. 로컬 전체 gate에는 `pnpm check`를, 빌드 의존성을 자동으로
실행할 때는 일반 `pnpm test`를 사용한다.

캐시 없는 검사는 다음 명령으로 실행한다.

```bash
CI=true TURBO_FORCE=true pnpm check
```

두 단계 각각의 보고서에서 캐시 0, 전체 테스트 수와 빌드 성공을 확인한다. 중단·취소된 실행은 통과가
아니다. Workflow 시간 초과만으로 단언 실패를 주장하지 말고 정확한 job 판정과 annotation을
읽는다. 재검증 시 원래 실패를 보존하고 검사한 commit/tree를 구별한다.

개별 `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`도 사용할 수 있다.
개별 test 명령은 패키지 작업을 순차 실행한다. 합친 전체 검사도 네 작업의 정적 단계 뒤에는
그 테스트 경계를 유지하며 개별 테스트의 시간 제한이나 단언을 바꾸지 않는다.

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

초기 네 작업 슬롯 조정은 실행 순서만 바꿨다. 무거운 core/policy 테스트 파일은 직렬, 명시한 race 검사는
동시 실행하고 빌드 의존 barrier도 유지한다. 테스트·coverage·timeout·독립 CI 작업을 제거하거나
완화하지 않는다. 한 머신의 측정은 보편적 실행 시간 보장이 아니며 정확한 커밋의 원격 검사로
최종 승인 여부를 확인한다.

## 컴파일과 unit test 부하 분리

이후 `47e793d`와 `cc6ea3c`의 게시 검사에서 기존 메모리 snapshot/result·공개 읽기 사례가
패키지 작업 부하 아래 기존 5초 한도를 넘었다. 입력 admission 최적화는 독립 검증을 유지하고
중복 작업을 줄였지만 원격 세 tenant 검사는 여전히 시간 초과했다. 원래 exact-SHA 실패를
보존하며 같은 SHA의 재시도로 해결됐다고 주장하지 않는다.

현재 두 단계는 정확히 같은 실행 작업 122개를 보존한다. 빌드·lint·타입 93개와 unit test
29개이며 task ID의 누락·추가·중복이 없다. `cc6ea3c30d212c2cb4787fcae33d1f5a3930ce0e`에서
실행 계획을 대조했고 증거 SHA-256은
`fafb744c3be6160d4e2a2814b2d5ecff80724db1d9b2fa4eaa32e2909f3d444d`다. fixture 구성이나
세 tenant 검증을 테스트 밖으로 옮기거나 테스트 제한·coverage·Quality의 20분 기한을
제거하지 않는다. 현재 정확한 커밋의 로컬 전체 검사와 모든 원격 검증이 계속 필요하다.

## CI의 필수 품질 준비 작업

`a8e518442fa8dcae11b23aac3ab6bf85f40cb19f`의 로컬 두 단계 전체 검사는 테스트 16,325개,
빌드 31개와 캐시 없는 두 단계(93 + 29 작업)를 통과했지만 원격 Quality가 기존 20분 작업
한도를 넘었다. 이 취소는 승인 실패로 보존한다.

CI는 **Quality build and static checks** 작업을 추가한다. 루트 검사와 runner coverage를
포함한 전체 정적 단계를 실행한 뒤 생성된 workspace `dist`와 소스·Node·pnpm 표식만 전달한다.
의존성·Next cache·자격증명·서비스 데이터는 제외한다. 기존 **Quality gates**는 준비 성공,
frozen 설치와 production 의존성 audit를 요구하고 같은 실행·시도의 정확한 숫자 artifact ID로
산출물을 받아 SHA-256·소스 SHA·런타임 버전을 확인한 뒤 모든 unit 패키지를 검사한다.
두 작업 모두 기존 20분 한도와 강제 캐시 없는 실행을 사용한다. 선행 작업이 실패해도 Quality는
준비 결과 검증을 실행해 정적 검사 누락이 skipped 성공 gate가 되지 않게 한다. 기존 12개
작업 이름과 기한을 보존하며 전체 필수 작업은 13개, CodeQL은 별도다.

실제 workflow 스크립트로 `dist` 30개에 생성된 파일 2,324개의 복사본을 전달해 18개 사례를
확인했다. 정상 복원, 변조, 잘못된 digest·소스·런타임, 누락 출력과 실패·건너뛴 선행 작업을
검증했다. 증거 SHA-256은 `6fdfb520b69303be25dd684825d02b727ccf6844f4582161b06eca7720f98a57`이다.
이는 전달 검증이며 변경한 workflow 자체의 정확한 커밋에서 전체 로컬·원격 검사도 통과해야 한다.
