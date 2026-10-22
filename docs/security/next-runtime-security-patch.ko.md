# Next.js 런타임 보안 업데이트

[English](next-runtime-security-patch.md) | [한국어](next-runtime-security-patch.ko.md)

2026-10-22 UTC의 `b144e82a1bb6748664689db273dbb79cd147545d` CI에서 프로덕션
의존성 감사가 실패했고, 해당 작업의 단위 테스트는 건너뛰어졌습니다. 클라우드의 별도
`--audit-level low` 프로덕션 감사에서도 Next.js 16.3.8의 다음 취약점이 확인됐습니다.

- [GHSA-2464-fhr4-w9xw](https://github.com/advisories/GHSA-2464-fhr4-w9xw): SVG를 사용하는 이미지 최적화의 인증 없는 코드 실행, 치명적.
- [GHSA-p3m5-59mp-jv5r](https://github.com/advisories/GHSA-p3m5-59mp-jv5r): App Router 서버 액션의 서비스 거부, 높음.

두 권고의 Next.js 16 영향 범위는 16.0.0–16.4.0이며 수정 버전은 16.4.1입니다.
[공식 릴리스](https://github.com/vercel/next.js/releases/tag/v16.4.1)와 기본 패키지 정보를
확인했습니다. 2026-10-14에 배포되어 기존 1,440분 대기 기간을 충족하며, Node 요구
버전과 React 피어 범위도 현재 Node 24.19.0·React/React DOM 19.2.8과 호환됩니다.

`apps/web`의 Next.js 핀을 16.4.1로 올렸습니다. 잠금 파일 변경은 Next.js와 해당
`@next/env`·플랫폼별 `@next/swc` 버전에 한정됩니다. 다른 의존성, Node·pnpm·React,
배포 대기 설정, 빌드 허용 설정과 감사 기준은 그대로 적용합니다.

고정 잠금 파일 설치와 프로덕션·전체 의존성의 `low` 감사가 통과했고, 당시 알려진
취약점은 모두 0건입니다. 이전 감사 실패는 보존합니다. 의존성을 바꾸기 전에 실행
중이던 클라우드 전체 검사를 의도적으로 종료했으며, 부분 결과를 전체 성공으로
처리하지 않습니다.

기존 웹 테스트·커버리지, 실제 Next.js 빌드·타입 생성, 캐시 없는 전체 저장소 검사,
정확한 최종 SHA의 CI 13개 작업과 별도 CodeQL로 검증합니다. 검증 내용·커버리지·
시간 제한은 유지합니다. 이 보안 업데이트는 Workflow 2 체크포인트 4의 완료나 제품
권한 경계의 변경을 뜻하지 않습니다.
