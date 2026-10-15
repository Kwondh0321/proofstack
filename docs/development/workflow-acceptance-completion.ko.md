# 요청한 기여자 흐름의 완료 검증

[English](workflow-acceptance-completion.md) | [한국어](workflow-acceptance-completion.ko.md)

상태: 승인 검사 수정과 canonical 입력 선행 조건입니다. Workflow 2 checkpoint 3은 열려 있으며
로드맵은 역사적으로 승인된 두 checkpoint를 기록합니다. 운영 준비 승인이 아닙니다.

기존 runner는 환경 플래그로 candidate/policy 모드를 선택했지만 Turbo의 엄격한 환경 전달 목록에
그 플래그가 없었습니다. 따라서 해당 이름의 작업이 성공해도 Workflow 1 분기만 실행했을 수 있습니다.
역사적 작업 상태는 보존하되, 생략된 분기를 독립적으로 입증한 것으로 사용하지 않습니다.
이번 수정은 실제 candidate/policy 경로의 재검증을 요구합니다.

이제 세 모드 플래그와 새 비공개 임시 영수증 경로를 명시적으로 전달합니다. 시험이 게시·동일
재시도·철회·재시작 assertion을 마친 뒤 `0600`·exclusive create로 JSON을 기록합니다.
`workflow1`, `releaseCandidate`,
`releasePolicy`, `canonicalPolicyInputs`가 요청 모드와 정확히 같아야 합니다. 누락·중복·잘못된 JSON·
초과 크기·알 수 없는 필드·모드 불일치가 있으면 child가 0으로 끝나도 명령은 실패합니다.
일반 파일만 읽고 symlink를 거부하며 최대 4097 byte를 읽어 4096-byte 상한·엄격한 UTF-8/JSON을
확인합니다. 모든 경로에서 descriptor를 닫고 최초·정리 오류를 보존합니다. Console 필터링으로
완료 증거가 사라지지 않으며 임시 영수증 디렉터리도 정리합니다. 기존 진단·작업 소유 자원 정리·
상속 stdout의 backpressure를 유지합니다.
검증한 모드 요약은 시험의 console 필터링과 별개로 부모 runner가 출력합니다.

실제 실행에서는 두 fixture 오류도 드러났습니다. Candidate의 엄격한 평가 참조에 annotation까지
복사했고, policy source는 존재하지 않는 discovery 참조를 보존했습니다. 원래 assessment ID/digest만
선택하고 실제 유일한 discovery의 digest·후보 순위·canonical URI를 대조해 결속합니다.
Schema·lineage·assertion·시간·coverage 기준을 완화하지 않습니다.

Node 24 이상·고정 pnpm 11.24.0·Docker Compose와 저장소의 고정 PG/S3 image를 사용합니다.

```sh
pnpm test:acceptance:workflow-1
pnpm test:acceptance:workflow-2-candidate
pnpm test:acceptance:workflow-2-policy
PROOFSTACK_ACCEPT_CANONICAL_POLICY_INPUTS=true pnpm test:acceptance:workflow-2-policy
```

각 명령은 무작위 loopback port와 고유 이름의 disposable 서비스를 사용하고 요청한 완료 영수증을
확인한 뒤 자신의 서비스·네트워크·volume만 정리합니다. 운영 DB·credential을 사용하지 않습니다.
합성 권한과 선언된 reference provider의 증거이며 실제 전문가·provider 진실성·release 안전성은
입증하지 않습니다.

Canonical 준비 모드는 `proofstack_test`를 만들고 실제 source/configuration/specification artifact와
독립 선언된 runtime·isolation·model-adapter·7개 protocol family의 원래 scoped 정의를 보존합니다.
신뢰된 준비 callback이 새 replay plan 게시 전에 자료를 업로드하고 엄격한 두 profile 참조만
반환합니다. 새 plan의 digest는 바뀌지만 실행·budget·lineage와 기존 기록·기본 흐름은 보존됩니다.
Callback 입력을 복사하고 원래 receipt·독립 storage ID·한계를 유지합니다.

Bundle은 공개 source 정의이며 분류된 정규화 요청이나 생성된 target payload를 복제하지 않습니다.
로드된 실행 byte·실제 provider·설치 qualification·OS 격리의 증거가 아닙니다. Canonical 원본이 없는
역사적 임의 digest에 맞는 데이터를 조작하지 않습니다. 새 생성기를 기존 100% coverage 검사에
포함합니다. 이 준비 모드는 정책 평가 실행·release 승인·checkpoint 3 완료가 아닙니다.
실제 SDK·별도 worker의 모든 predicate/outcome 통합 증거와 독립 종료 감사가 남습니다.

Docker 기본 주소 풀이 소진된 경우 적합한 미사용 RFC1918 IPv4 subnet(prefix 8–29)을 명시할 수 있습니다.

```sh
PROOFSTACK_ACCEPTANCE_SUBNET=10.253.6.176/28 \
PROOFSTACK_ACCEPT_CANONICAL_POLICY_INPUTS=true \
pnpm test:acceptance:workflow-2-policy
```

호스트에 적합한 subnet을 선택하며 Docker의 overlap 거부는 유지합니다. 비공개 임시 Compose
network overlay만 만들고 정리하며 daemon 주소 풀·host 공개 정책·allowlist·다른 프로젝트를
바꾸지 않습니다. 미지정 시 기본 할당을 유지합니다. 잘못된 설정은 서비스 생성 전에 실패하고,
실패한 실행을 성공으로 바꾸지 않습니다. 자세한 영수증 예시는 영문 가이드에 있습니다.
