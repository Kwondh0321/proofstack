# 요청 소유 재귀 저장 목록

[English](workflow-2-policy-storage-inventory.md) |
[한국어](workflow-2-policy-storage-inventory.ko.md)

상태: 구현 선행 조건입니다. Workflow 2 checkpoint 3은 아직 열려 있으며 2/7개가 승인됐습니다.

`capturePolicyRecordGraph`는 기존 의미 평가용 `roots`, `nodes`, `edges`, manifest 항목과
별도로 `storageInventory`를 만듭니다. 두 목록 모두 검증된 불변 요청의 candidate와 policy에서
두 요청 root를 도출합니다. 미래 기록의 원래 사용 불가 상태를 유지합니다. 저장 선언을
탐색해도 그 기록, 과거 root, 후손이 의미 평가의 피연산자가 되지는 않습니다.

내부 큐는 기존 고정 소유 reader, 설치된 48종의 저장 참조 문법, 원래 시점에 동작하는 네
selector 계열을 사용합니다. 해당하는 유효 저장 부모마다 소유 논리 root를 읽습니다.
독립적으로 검증된 root 본문도 같은 유한 너비 우선 큐에 들어가 자신의 root와 의존성을
탐색합니다. root 포트 설정 누락은 명시적으로 남습니다. 누락·잘못된 형식·scope 불일치
기록의 저장 frontier는 null이며, 검증된 빈 closure라는 뜻이 아닙니다.

반복되는 부모/경로 출현과 protocol 후보의 전체 순서를 간선에 보존합니다. 전체 source
좌표가 일치한 뒤 identity를 중복 제거합니다. 의미 기록·root·selector에서 읽은 원본의
본문, 전체 기록 해시, 실제 receipt가 일치해야 합니다. 의미 상태가 동일한 미래 기록도
예외가 아닙니다. scope·descriptor·관계 실패는 명시적인 frontier로 남으며, 후보를
몰래 선택하거나 보호된 부재를 증명하지 않습니다.

의미 그래프 composer도 저장 selector join을 사용해 동일 조회에서 얻은 자식 본문을
저장 탐색에 보존합니다. 기존 의미 결과를 유지하면서, 첫 미래 자식의 본문을 버린 뒤
나중에 다시 읽는 문제를 방지합니다. 반복 출현마다 고정 소유 조회는 계속 수행합니다.
core selector도 다른 계열과 마찬가지로 조회 전에 부모 전체 재검사 비용을 예약합니다.

내부 `inspectPolicyStorageInventory`는 불변 요청 root와 실제 소유 본문 필드에서 도달
가능성 및 출현 순서를 다시 도출합니다. 원래 논리 root 증거, 유효 저장 selector join,
같은 호출에서 앞서 읽은 원본을 대조합니다. 기록·출처·receipt·대상 누락, 추가, 순서 변경,
대체를 거부합니다. 이는 저장 구조와 일치성의 검증이며 외부 source 인증이 아닙니다.
유효 자식 본문이 없는 실패 응답은 frontier로 남고 부재나 현재 권한을 확정하지 않습니다.

두 탐색은 같은 요청의 누적 meter를 사용하며 metadata transaction 모드에서는 제공된
동일 scope 연결을 사용합니다. 실제 조회와 반환 행/바이트를 계속 계산합니다. 저장
열거 및 독립 재도출도 반복 참조 수와 canonical 바이트를 계산합니다. root 전용 selector
조회 전에 부모 전체 검사를 예약합니다. guarded 재검사는 각 저장 노드, root 결합,
간선을 후손 탐색 전에 대조하고 최종 전체 기록도 다시 비교합니다.

이 변경은 artifact 객체나 key를 읽거나 source를 게시하거나 predicate를 평가하지
않습니다. 후속 [저장 artifact 카탈로그 기반 기능](workflow-2-policy-stored-artifact-catalogs.ko.md)은
별도로 인가된 catalog·소유권·무결성과 알려진 artifact/policy guard origin 전체를 연결하며
분류된 평문을 자동으로 읽지 않습니다. 전체 현재 의미·권한·부재 closure, 관련 저장
관계, native SQL/scan/wire/deadline 한도 및 영속 job 전체 한도는 아직 남아 있습니다.

소유 패키지의 저장 경계는 검사 결과의 전체 canonical JSON을 검증한 뒤 독립적으로
소유한 복사본을 구조적으로 비교합니다. 구조가 같으면 같은 전체 기록을 두 번 직렬화하지
않으며, 다르면 기존 canonical 비교로 `0`/`-0` 의미까지 보존합니다. 전체 본문·범위·원래
시점·해시·수신 시간·Unicode·중첩 한도 검사는 유지합니다. 공유 관찰 cache를 사용하거나
고정된 소유 검증기를 생략하지 않습니다.

의미 closure 재도출도 한도가 있는 root·노드·간선 증거를 한 번 소유합니다. verified
노드에서는 고정 저장 열거기가 원본 저장 기록과 의미 조회를 함께 검증하고, 그 호출의
내부 frontier만 재사용합니다. 원래 시점의 unavailable 기록은 별도로 검사하며 반복
참조와 바이트 예산 계산도 유지합니다.

독립 재구성은 유효하게 보존된 core selector 자식들을 하나의 소유·승인된 부모 아래에서
검사합니다. 각 경로는 전체 소유 문법에 선언돼 있어야 하며 자식 본문은 각각 검증합니다.
희소·초과 입력과 선언되지 않은 경로를 거부하고, 자식 getter가 고정된 부모나 문맥을
바꾸지 못하게 합니다. 부모 검증을 공유해도 반복 참조마다 전체 검사 예산을 유지합니다.

읽기 전용 재검사 transaction은 보고서 반환 전에 끝납니다. publisher는 전체 closure,
현재 migration, worker job/lease/fence/epoch/state 및 실제 DB 만료 시간을 검사하고,
같은 연결에서 모든 guard를 유지한 채 원자적으로 게시해야 합니다. 새 role/grant,
migration, API route, job, worker, 공개 SDK 배포 또는 production 조합은 추가하지 않습니다.
checkpoint 승인이나 production 준비 완료를 뜻하지 않습니다.

검사는 미래 요청/root 전용 source, 반복 출처와 cycle, 누락·잘못된 join, 미래 본문 대체,
순서가 있는 closure 변조, guarded 재검사 및 정확한/하나 모자란 누적 행·참조·바이트 한도를
다룹니다. 기존 커버리지 기준과 실행 제한을 유지합니다.
