# API 실행 의존성 보안 패치

`2cd14c9`의 운영 의존성 low 이상 검사에서 다음 두 권고를 확인했습니다.

- [GHSA-389g-gv7q-r4x8](https://github.com/advisories/GHSA-389g-gv7q-r4x8): Fastify 5.12.5의
  대소문자를 구분하는 `propertyNames` 헤더 검증 우회. 영향 범위는 `>=5.12.2 <5.12.6`이며
  심각도는 low입니다. 직접 의존성을 수정 버전 5.12.6으로 고정합니다.
- [GHSA-rxp7-6hxx-x8q5](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5):
  `@fastify/rate-limit@11.2.0`이 사용하는 `ip-address@10.7.2`의 IPv6 zone identifier 처리
  비용 문제. `<=10.7.3`에 영향이 있고 심각도는 moderate입니다. 해당 부모·자식 경로만
  수정 버전 10.7.4로 고정합니다. 부모가 선언한 `^10.2.0` 범위에 포함됩니다.

권고 게시 시각은 2026-10-22 16:40:35 UTC와 16:19:39 UTC입니다. 과거 취약점 0건 기록은
당시 관찰로 보존하며 이후 검사 결과를 대신하지 않습니다. 두 권고는 실제 설치된 의존성에
대한 결과이고 운영 배포에서 공격이 발생했다는 증거는 아닙니다. 원격 CI의 high 기준에
미달하더라도 로컬 low 기준을 유지해 수정합니다.

Fastify 수정 버전의 npm 게시 시각은 2026-10-13 06:50:58.498 UTC이고 `ip-address`는
2026-10-11 19:34:42.622 UTC입니다. 기존 1,440분 대기 정책을 충족하므로 예외를 추가하지
않습니다. 공식 [Fastify 릴리스](https://github.com/fastify/fastify/releases/tag/v5.12.6)와
[ip-address 릴리스](https://github.com/beaugunderson/ip-address/releases/tag/v10.7.4)를 대조했고,
레지스트리 무결성 값은 lockfile과 일치합니다. `ip-address`의 Node >=12 요구는 현재
Node 24.19.0에서 충족합니다. pnpm 11.24.0도 유지합니다.

변경 범위는 Fastify 직접 고정, 정확한 rate-limit 경로 override와 두 패키지의 lockfile
항목입니다. 다른 의존성·플러그인·권한·테스트 주장·커버리지·release-age와 기존 예외 목록은
유지합니다. frozen 설치, 운영/전체 의존성 low 검사 0건, API 테스트·빌드·타입, 전체 캐시 없는
검사, 비밀 검사와 정확한 커밋의 CI/CodeQL이 승인 조건입니다. 배포나 운영 준비 완료를 뜻하지
않습니다.

English: [primary guide](api-runtime-security-patches.md).
