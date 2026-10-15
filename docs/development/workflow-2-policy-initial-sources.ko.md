# 정책 초기 소스 읽기의 실행 제한

[English](workflow-2-policy-initial-sources.md) | [한국어](workflow-2-policy-initial-sources.ko.md)

구현 선행 조건입니다. Workflow 2 checkpoint 3은 아직 열려 있고 공식 승인은 2/7입니다.

`createPostgresPolicyInitialSources`는 고정된 owning record·logical root·catalogue·정확한 event·
fixture content metadata 읽기를 제공합니다. 정확한 scope·worker fence·allowance ID 하나에 묶고
설정과 실행 중 argument를 복사합니다. SQL/client callback·content/key 작업·source guard·게시
포트를 노출하지 않습니다. Service principal을 따로 승인하고 credit을 확보한 신뢰된 수집에서 사용합니다.

각 읽기는 첫 SQL 전에 `createPolicyPostgresPool`의 물리 응답 제한을 요구합니다. Migration ledger,
현재 owning job/request·history·canonical intent와 미봉인 acquiring attempt의 정확한 열린
allowance/fence를 확인합니다. 기존 native I/O admission이 DB 만료를 확인하고 monotonic 시간을
줄입니다. 다른·정산된·교체된 credit과 취소된 작업은 다음 읽기를 승인하지 못합니다.

기존 일반 제한인 pool 대기 500ms·transaction 2초·statement 1초·lock 250ms·backend frame 1MiB·
transaction frame 16MiB·DataRow header 32,768개를 유지합니다. 초과 응답은 decoder 전에 거부하며
실패·만료 작업은 taint·drain 후 깨진 연결을 폐기합니다. 봉인·복구의 별도 실행 목적과 기존 일반
pool 호환성은 유지합니다. 새 어댑터만 물리 응답 제한 연결을 명시적으로 요구합니다.

Metadata 읽기의 짧은 transaction 동안만 owning job을 보유하고 콘텐츠·키 I/O 전에 연결을 반환합니다.
최종 source guard를 먼저 잡지 않습니다. 초기 관찰은 바뀔 수 있으며 완전한 현재 재검사와 원자적
게시는 마지막 held 연결의 책임입니다. 과거 응답은 이후 게시 권한이 아닙니다.

기존 normalized reader와 목록 제한을 재사용합니다. Criterion status는 초과 sentinel을 먼저
거부해 부분 목록을 허용하지 않으며, policy 종료 이력은 기존 unique 제약과 validator로 0~1개입니다.
고정 catalogue의 scope·크기 검사도 유지합니다. 기존 evaluator 권한을 사용하고 control 역할은 이를
대체하지 못합니다. Migration·역할/grant·외부 의존성은 추가하지 않습니다.

[기존 수집 composition](workflow-2-policy-acquisition-capture.ko.md)이 credit 확정·전체 의미적
응답/참조 계량·drain·정산을 소유합니다. Wire byte와 JSON byte는 다릅니다. 읽기별 제한은 job 전체
한도·artifact 예약·전체 rule 비용·deadline·retry를 대신하지 않습니다.
[마지막 held 게시](workflow-2-policy-snapshot-storage.ko.md)의 경계도 유지합니다.

단위 transport fault 검사는 모든 고정 reader·argument 복사·scope/credit/admission 오류·SQL 전
일반 연결 거부를 다룹니다. 실제 PostgreSQL에서는 전체 source-to-seal, object I/O 전 모든 worker
연결 반환, credit/fence/취소·역할 거부, decoder 전 초과 응답 거부와 새 연결 복구를 검사합니다.

별도 worker 실행 파일에서 이 어댑터·필수 acquisition/artifact admission·service 인증을 실제로
연결해야 합니다. 모든 상태의 복구·API/SDK·contributor 흐름·독립 exit audit도 남아 있습니다.
체크포인트 승인·사람의 승인·release 권한·운영 준비 완료를 뜻하지 않습니다.
