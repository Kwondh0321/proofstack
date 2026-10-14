# Native 정책 snapshot 저장

[English](workflow-2-policy-snapshot-storage.md) | [한국어](workflow-2-policy-snapshot-storage.ko.md)

상태: 구현 선행 요소이며 Workflow 2 checkpoint 3은 미완료입니다(2/7 승인).

`PostgresPolicySnapshotTransactions`는 `sealPolicyEvaluationSnapshot`의 trusted held port를
구현합니다. [ADR-0032](../architecture/0032-persist-policy-snapshots-through-held-worker-ports.md)를
참고하세요. Service-token 실행 및 별도 artifact 읽기 권한을 먼저 검사하며 서버 identity/fence와
repository를 사용합니다. Caller graph/page/operand/outcome은 받지 않습니다. Native 저장은
엄격한 0.2 입력 및 설정된 owning logical-root reader를 요구하고 unavailable은 그대로 보존합니다.

Content/key I/O 후 현재 job/attempt를 잠그고 native 남은 시간과 이전 canonical 이력을 확인합니다.
동일 READ COMMITTED client에서 비차단 metadata/resource guard·전체 재검증·내부 page/root 생성과
저장을 마칩니다. 동일 acquiring attempt의 identity/lease/기존 비용을 유지해 computing binding 및
`sealed` job으로 전환합니다. 지연 page/root 무결성 및 마지막 native fence 검사는 commit 전에
실행됩니다. 오류·취소·만료·오래된 epoch·guard 실패·변조는 page/binding/job/history를 모두 롤백합니다.

Migration 0058은 기존 checksum 및 이력 검사를 보존합니다. Root/page는 정확한
tenant/project/environment 범위의 immutable row이며 canonical frame·전체 input hash와
request/job을 연결합니다. Artifact 인증 retention 원문과 upstream 의미적 시간은 바꾸지 않습니다.
과거 readback이나 이미 종료한 source report는 현재 게시 권한이 아닙니다.

`createPolicyPostgresPool`의 봉인용 실행 한도는 15초·backend protocol 128MiB·DataRow header
200,000개이며 native lease/attempt/job 만료까지 더 줄어듭니다. 미등록 client는 SQL 전에 거부합니다.
기존 일반 작업·owner 복구 한도는 유지합니다. SQL/lock timeout·decoder 전 frame 제한·taint·
만료 port·물리 연결 종료/drain도 유지합니다. Protocol 수치는 의미적 record나 durable job 비용이 아닙니다.

Control/evaluator 역할을 함께 명시적으로 설정합니다. Evaluator만 fenced guard와 snapshot 게시를,
control은 고정된 과거 snapshot 읽기를 허용합니다. Owning source SELECT 및 읽기 전용 intent 확인은
직접 DML·upstream 게시·identity/credential 읽기·기존 unbound guard 권한을 주지 않습니다.
기존 API/작성자/평가자/reviewer 또는 workload/user 자격은 새 실행 권한과 worker pool을 대신하지 못합니다.

실제 PostgreSQL 검사는 동일 attempt 게시/readback, 역할 및 직접 쓰기 거부, guard 부재, epoch/
범위 불일치, content I/O 중 만료, caught/unawaited 오류, 만료 port, page 누락/교체 및 게시 후
전체 rollback을 다룹니다. 실제 PostgreSQL/S3 복구에는 원본 root/page 및 sealed job을 포함하고
원래 bytes/receipt를 보존하면서 lease를 무효화하고 역할을 다시 설정합니다.

운영 worker·공개 route·정책 verdict·승인·release 권한은 아직 추가하지 않습니다. Source I/O 이전의
durable job 전체 비용 집계는 미완료이며 게시 transaction 내부 집계로 rollback 환급을 허용하면 안 됩니다.
Memory/native 전체 공유 conformance, computing/completed 복구 상태, 전체 predicate와 atomic result,
worker/API/SDK/contributor 검사 및 독립 exit audit가 checkpoint 승인 전에 필요합니다.
