# 제한된 정책 평가 TypeScript SDK

[English](workflow-2-policy-evaluation-sdk.md) | [한국어](workflow-2-policy-evaluation-sdk.ko.md)

상태: 구현 선행 조건입니다. Workflow 2 checkpoint 3은 열려 있으며 2/7만 승인되었습니다.

Workspace 전용 `@proofstack/sdk`의 `ProofStackPolicyEvaluationClient`는
[control·역사적 조회 API](workflow-2-policy-evaluation-api.ko.md)를 사용합니다. 예상 tenant·project·
environment 전체, 명시적 인증과 endpoint를 요구합니다. 이후 조회에는 보존한 불변
`{ jobId, definitionSha256 }`가 필요하며 암묵적 latest 선택은 없습니다. 실행 credential·계산된
결과 게시·자동 mutation 재시도·scheduler를 제공하지 않습니다. 사용 예는 영문 가이드를 참고합니다.

인증은 loopback 개발 모드, workload API key, mutation용 CSRF token을 명시하는 browser session입니다.
Loopback 외부는 HTTPS를 요구하며 URL 내 credential은 거부합니다. 생성할 때 승인된 scope·인증·
옵션을 복사합니다. SDK는 package registry에 게시되지 않았습니다.

메서드는 `enqueue`, `readJob`, `readRequest`, `cancel`, `readSnapshot`, `readSnapshotPage`,
`readCompleteSnapshot`, `readResult`, `readHistoryHead`, `readHistoryPage`입니다. 취소는 엄격한
reason 계약만 전송하는 서버 job 연산입니다. Client abort는 서버 job을 취소·rollback하지 않습니다.
동일 요청·취소의 재시도는 호출자가 명시적으로 결정하고 원래 identity와 payload를 유지해야 합니다.

각 연산은 선택 `AbortSignal`을 받습니다. 기본 5,000 ms, 최대 60,000 ms의 단일 deadline이 해당
연산의 모든 fetch·stream read·검증 지점과 전체 snapshot의 모든 page를 포함합니다. 주입한
fetch/reader가 협조하지 않아도 timeout·abort는 호출을 실패시킵니다. 늦은 응답 정리는 best effort이며
임의 fetch 구현이나 이미 실행 중인 Web Crypto 작업을 물리적으로 중단한다고 주장하지 않습니다.

Redirect와 redirected·opaque redirect 응답을 거부합니다. 요청·응답은 `no-store`를 유지해야 하며
예상 JSON 성공·problem media type과 status만 허용합니다. Route별 응답 상한에 더해
`maxResponseBytes`도 적용하며 최대 512 KiB입니다. 실제 stream byte를 센 뒤 엄격한 UTF-8을
해석합니다. 선언 길이도 제한하고 identity encoding의 실제 길이와 비교하며 압축 wire 길이를
해제된 stream 길이와 혼동하지 않습니다. Reader 취소·release, timer·listener 정리 과정은
최초 오류와 별개의 정리 오류를 보존합니다. 자동 네트워크 재시도는 없습니다.

`maxSnapshotInputBytes`로 전체 입력 예산을 낮출 수 있으며 기본·protocol 최대는 64 MiB입니다.
할당·page 취득 전에 header descriptor와 크기를 확인합니다. 원래 sealing attempt·snapshot identity·
순서 있는 frame/page descriptor·canonical digest에 모든 page를 결속합니다. 완전한 조립은 실제 byte·
UTF-8·canonical JSON·domain/version·엄격한 입력 schema와 원래 request/candidate/policy/algorithm/
평가 시간/manifest 관계를 확인합니다. 재시도의 다른 deciding worker/fence가 원래 seal·receipt를
다시 쓰지 않습니다.

결과는 원래 snapshot, 순서 있는 rule ID·kind·개수, deciding attempt/fence와 완료 receipt에도
결속합니다. 이는 보존된 identity·무결성 검사이며 서버의 owning semantic 재계산을 대체하거나 새
source·인간 승인·release·배포 권한을 만들지 않습니다. 보존된 history head로 page·entry hash를
결속하고 이후 page 경계를 검증할 때 이전 entry를 제공합니다. 중간 page 하나로 전체 chain이나
동시에 관찰한 현재 job/head를 입증하지 않습니다.

체크인된 합성 vector는
[`policy-evaluation-api-v1.fixture.json`](../../sdks/typescript/vectors/policy-evaluation-api-v1.fixture.json)입니다.
실제 memory owning port로 7개 rule·원래 snapshot 3개 page·별개 sealing/deciding attempt·101개
entry의 2개 history page를 만들었습니다. 시험은 canonical frame을 독립 해석하고 HTTP 대역으로
identity·digest·순서·transport·한계·timeout/abort·정리를 검증합니다. Recovery package에서는 실제
API와 일관된 memory 저장소에 공개 client를 연결합니다. 개발 인증 증거이며 native PostgreSQL/S3
승인이나 provider 진실성 증거가 아닙니다.

실제 PostgreSQL/S3의 완전한 기여자 graph·모든 predicate/outcome·사용성/보안 검토·독립 종료 감사는
남습니다. [진입 감사](workflow-2-policy-evaluation-entry-audit.ko.md)와
[별도 worker](workflow-2-policy-worker-executable.ko.md)를 참고합니다.
