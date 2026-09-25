# Workflow 2: 보존된 런타임 정의 수집

[English](workflow-2-policy-evaluation-runtime-definitions.md)

상태: 불변 기록·직접 의존성 경계 구현. 설치 권한이나 체크포인트 완료가 아니다.

[ADR-0023](../architecture/0023-retain-runtime-definitions-separately-from-installation.ko.md)은 남은
세 종류의 참조에 Boolean 허용 목록이 아닌 실제 정의 본문이 필요한 이유를 설명한다.

## 구현 경계

- [계약](../../packages/contracts/src/runtime-definition.ts): 런타임 프로파일·격리 프로파일·
  런타임 어댑터의 엄격한 정의와 기록. 구현·설정의 정확한 아티팩트를 참조하고 어댑터는
  인터페이스 계약도 참조한다.
- [인코딩](../../packages/contracts/src/runtime-definition-encoding.ts): 의미 필드 전체·종류·범위를
  결속한다. [공개 벡터](../../packages/contracts/vectors/runtime-definition-v1.json)는 세 종류의
  고정 UTF-8 길이·SHA-256을 제공한다. 벡터의 아티팩트는 테스트 데이터이며 운영 바이트의
  존재를 주장하지 않는다.
- [검증](../../packages/core/src/runtime/runtime-definition-record.ts): 엄격한 파싱 후 의미 해시를
  재계산하며 등록 receipt는 의미 해시와 구분한다.
- [카탈로그](../../packages/core/src/runtime/runtime-definition-catalogue.ts): 시작 시 운영자 기록을
  최대 256개 복사하고 같은 저장 식별자를 중복 허용하지 않으며 범위별 정확한 읽기만 제공한다.
  요청으로 누락 기록을 만들거나 탐색하지 않는다.
- [정책 읽기·추출](../../packages/core/src/policy/policy-evaluation-runtime-reader.ts): 범위, 참조의
  모든 필드, 원래 등록 시각, 의미 해시와 전체 기록 해시를 검사하고 캡처 부모를 재검사한 뒤
  한도가 있는 아티팩트 출현을 추출한다.

신뢰된 설치 설정에 실제로 보존된 등록 기록으로 `StaticRuntimeDefinitionCatalogue`를 만들고
`RuntimeDefinitionReader`를 `readPolicyEvaluationRuntimeRecord`에 주입한다. 후보·평가 요청으로
카탈로그를 만들지 않는다. `inspectPolicyEvaluationRuntimeRecord`는 입력 본문 검사이며 수집
출처를 증명하지 않는다. `enumeratePolicyEvaluationRuntimeReferences`는 본문·전체 해시를
재검사하고 JSON 포인터 출현을 반환한다. 설정·구현·인터페이스 바이트를 가져오거나 해석·설치·
실행하지 않는다.

다른 테넌트·프로젝트·환경이나 다른 프로파일 계열·격리 종류·어댑터 논리 ID·버전·해시는
대체할 수 없다. 부재, 잘못된 기록, 참조 불일치, 미래 receipt, 저장소 예외를 구분한다.
예외는 부재나 충족으로 바꾸지 않고 전파한다. 같은 아티팩트의 반복은 보존하고 동일 ID의
모순된 정확한 참조는 거부한다. 정확한 개수·바이트 한도는 허용하고 초과 시 부분 결과를 반환하지 않는다.

## 호환성과 신뢰 한계

기존 재현 계획·시도·후보 허용 목록·대상 실행 계약은 바꾸지 않는다. 요청된 해시를 본문에
복사해 과거 임의 참조를 검증 완료로 만들 수 없다. 독립적으로 보존된 본문이 실제 일치하지
않으면 부재/무효로 남긴다. 과거 기록 수정이나 등록 시각 소급으로 통과시키지 않는다.
카탈로그는 설정된 receipt를 검증하지만 운영자 인증이나 실제 등록 시점의 증명은 아니며
이는 설치 신뢰 경계다.

범용 실행 언어를 새로 만들지 않고 설정·인터페이스 콘텐츠를 고정한다. 후속 수집은 인가된
바이트의 정확한 메타데이터·해시를 검증해야 한다. 필요한 설정 해석은 고정된 버전별 도메인
파서가 맡아야 하며 임의 설정 코드를 정책 평가기에서 실행하면 안 된다. 현재 읽기는 바이트·
소유권·보관 상태·설치 호환성·OS 제어·공급자 신원·수명주기/폐기·실행 허가를 검증하지 않는다.
`container` 정의는 컨테이너 실행기가 아니며 기존 자식 프로세스 격리 한계는 유지된다.

## 검증과 남은 작업

별도 정렬 JSON·해시 계산과 공개 벡터, 모든 의미 필드, 엄격한 필드 거부, 종류·크기·순서
한도, 모든 범위/참조 필드, 잘못된 종류, 시점·receipt만의 변경, 실제 카탈로그와 단일 포트,
부재/무효/예외, 입력·포트·반환 값 변경, 중복·등록 한도, 접근자 본문·늘어나는 배열,
부모별 개수·바이트 한도, 반복·충돌 아티팩트를 검사한다.

기록 수집과 직접 의존 관계 열거는 각각 **44종 중 44종**을 다룬다. 출처 종류 목록이지 재귀
그래프 완전성이나 프로젝트 완료율이 아니다. 신뢰된 워커 조립·선택자 해소·재귀 계보·전역
한도·실제 바이트·설치/수명주기 리비전 관찰·스냅샷 봉인·결정론적 규칙·영속 워커/API/SDK
통합·실제 서비스 검증은 [진입 검토](workflow-2-policy-evaluation-entry-audit.ko.md)에 따라
미완료로 남는다. 로드맵 완료 표시는 변경하지 않는다.
