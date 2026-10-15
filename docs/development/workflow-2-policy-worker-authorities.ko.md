# Native 정책 worker의 후보 reference 권한

[English](workflow-2-policy-worker-authorities.md) | [한국어](workflow-2-policy-worker-authorities.ko.md)

상태: 구현 선행 조건입니다. Workflow 2 checkpoint 3은 열려 있으며 2/7만 승인되었습니다.

[별도 worker](workflow-2-policy-worker-executable.ko.md)에 기존 capture composer의 운영자 소유
candidate revision/runtime 권한 포트를 연결합니다. Reference 검사이며 source content·semantic
qualification·worker 실행 권한·release 승인과는 별개입니다. 설정이 없으면 권한은 미확인이고
해당 결과는 indeterminate를 유지합니다. 프로세스 종료 코드 0을 정책 만족으로 표시하지 않습니다.

선택 `PROOFSTACK_POLICY_WORKER_AUTHORITIES_FILE`은 절대 경로의 비공개 JSON 파일입니다.
운영자 전용 디렉터리와 `0600`을 사용합니다. 기존 credential reader와 동일한 소유 UID·일반 파일·
단일 hard link·no-follow/nonblocking·읽기 전후 metadata·엄격한 UTF-8 검사를 적용하며 상한은
16 MiB입니다. 실제 service token·정확한 실행 범위 인증 뒤에 읽습니다. 설정·오류 내부 값을
출력하지 않습니다. POSIX reference 구성이며 운영 secret store·OS 격리를 주장하지 않습니다.

엄격한 root는 `repositories`, `modelDeclarations`, `runtimeAdapters` 배열을 모두 요구하며 각
최대 256개입니다. 빈 배열은 아무 reference도 승인하지 않습니다. Repository entry는 절대 local
checkout과 URL·정확한 tenant/project/environment의 `{ checkoutPath, repositoryUrl, scope }`입니다.
Model은 기존 엄격한 선언의 `{ declaration, scope }`, adapter는 정확한 reference의
`{ adapter, scope }`입니다. 알 수 없는 필드·중복 binding·잘못된 파일 전체를 거부합니다.
Candidate나 delivery에서 scope를 추정·확대하지 않습니다. 형식 예시는 영문 가이드에 있습니다.

Workspace 전용 `@proofstack/source-authority`가 기존 API adapter와 동일한 검사를 공유합니다.
고정된 시간·출력 상한의 local Git 명령으로 object format·완전한 commit/tree ID·객체 존재와
commit-tree 관계를 확인하며 network fetch를 하지 않습니다. Model/adapter는 복사한 전체 선언과
정확한 scope가 일치해야 합니다. 같은 ID·다른 digest·다른 tenant·이후 options 변경으로 권한을
추가하지 못합니다. Native runtime이 승인한 포트 묶음을 한 번 복사해 초기 capture와 held
reinspection에 사용합니다. HTTP 요청·CLI delivery로 path·URL·callback·명령을 고르지 못합니다.

파일 교체는 다음 호출에 적용됩니다. 이미 승인한 불변 선언 묶음은 실시간 폐기 feed가 아니며
재검사가 그 파일이나 운영자의 이후 설정을 다시 읽지 않습니다. 기존 job 취소·DB lease/fence/만료와
명시적인 설치 권한 계약은 별개의 경계를 유지합니다.

실제 임시 Git 저장소를 쓰는 기존 시험과 assertion을 그대로 이동합니다. Worker는 비공개 설정·
잘못된 권한/데이터·포트 복사·CLI 전달·인증 우선을 검증합니다. Native PostgreSQL/S3 시험은
현재 checkout의 Git subject와 복사한 합성 선언으로 실제 worker 프로세스를 실행하고 두 원래
권한 관찰과 재시작 후 snapshot/result 재조회를 확인합니다. 다른 policy/runtime-definition의
부족한 선행 조건은 indeterminate입니다. 완전한 정책 만족·실제 provider·로드된 코드 증거가 아닙니다.

기존 철회 이력을 보존하고 별도의 활성 정책·완전한 실제 graph·7개 predicate/4개 outcome·공개 SDK
구성·독립 종료 감사를 마쳐야 checkpoint를 승인할 수 있습니다.
[ADR-0035](../architecture/0035-share-scoped-candidate-reference-authorities.md)와
[진입 감사](workflow-2-policy-evaluation-entry-audit.ko.md)를 참고합니다.
