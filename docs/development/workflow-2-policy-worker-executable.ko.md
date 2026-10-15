# 정책 워커 reference credential과 일회 실행 파일

[English](workflow-2-policy-worker-executable.md) | [한국어](workflow-2-policy-worker-executable.ko.md)

구현 선행조건이며 Workflow 2 체크포인트 3은 아직 열려 있습니다(승인 2/7).

[Native runtime](workflow-2-policy-worker-runtime.ko.md)을 사용하는 실제 실행 파일을 추가했습니다.
설치·빌드 뒤 `pnpm --filter @proofstack/policy-worker start execute <project-id> <environment-id>
<job-id>`로 이미 등록된 정확한 작업 하나를 처리하고 종료합니다. 자동 재시도·큐 polling·사용자
principal/fence/result·배포·지속 스케줄러는 없습니다. 공개 등록/조회/취소 API와 SDK는 별도
필수 작업이며, 실행을 위해 운영 테이블을 직접 수정하면 안 됩니다.

토큰과 절대 경로의 credential 파일은 `PROOFSTACK_POLICY_WORKER_SERVICE_TOKEN`,
`PROOFSTACK_POLICY_WORKER_CREDENTIALS_FILE`로 전달합니다. 원본 토큰을 argv·소스·URL·로그·
delivery에 넣지 않습니다. 운영자 측 발급에는 identity workspace의 `generateServiceToken`,
`hashServiceTokenSecret`을 사용하고 파일에는 prefix와 제한된 scrypt-v1 hash만 저장합니다.
기존 API 키 발급·위임 권한이나 workload capability를 확대하지 않습니다.

엄격한 파일 형식은 `{schemaVersion:"0.1", revision, credentials}`이며 최대 64개·64KiB입니다.
각 record는 service token 종류·고유 credential ID/prefix·고정 hash·주체/tenant·정확한 실행 및
artifact-read capability·명시적인 project/environment 범위·active/revoked 상태·양의
notBefore/expiresAt 구간을 가집니다. 중복·미래 형식·알 수 없는 필드·잘못된 hash·암묵적인 광역
권한은 전체 파일을 거부합니다. 정확한 필드와 설정 목록은 [영문 가이드](workflow-2-policy-worker-executable.md)에 있습니다.

실제 파일을 읽어 비밀값을 검증한 뒤 다시 읽고 원래 identity·hash·grant·유효 구간을 대조합니다.
not-before는 포함하고 만료 시각은 제외합니다. 원자적 파일 교체로 폐기/교체하며 검증 도중 변경·
만료·삭제·오류로 인증할 수 없습니다. 다른 credential만 교체하면 원래 record는 유지할 수 있습니다.
파일 폐기는 새 인증을 막으며 이미 인증된 DB lease의 자동 취소는 아닙니다. 활성 작업은 DB
lease/fence/deadline과 명시적인 control 취소의 적용을 받습니다.

POSIX reference 리더는 실행 UID 소유·hard link 1개·group/other 권한 없는 일반 파일을
요구합니다. 운영자 소유 private 디렉터리에 `0600`으로 저장합니다. No-follow/nonblocking open,
고정 byte 상한, 완전한 EOF, 엄격한 UTF-8과 읽기 전후 inode/소유권/mode/size/ns 시각 검사를
적용합니다. 모든 경로에서 descriptor를 닫고 원래 오류와 정리 오류를 보존합니다. 필요한 OS
보호가 없으면 거부하며 same-user 격리·운영 secret store·파일시스템 가용성·Windows 지원은
입증하지 않습니다.

실제 token·범위 인증 후 DB/S3·키·설치 catalogue 설정을 읽습니다. `PROOFSTACK_ENV`는
development/test만 허용하고 운영 local-key 조합은 거부합니다. S3는 명시적인 별도 자격증명만
쓰고 ambient credential fallback은 없습니다. 선택적인 설치 파일도 owner 보호와 16MiB 상한을
지키며 owning validator를 재사용합니다. 빠진 authority는 unavailable로 남습니다. 로컬 keyring의
기존 8개·고유 material 제한을 유지하고 복사 후 임시 decoded buffer를 지우지만 운영 KMS나
프로세스 메모리 완전 삭제는 주장하지 않습니다.

출력은 scope/job·작업 상태·snapshot/result 참조와 네 결과 종류의 개수만 포함하는 작은 JSON입니다.
종료 코드 0은 indeterminate/violated 결과도 포함하는 작업 완료이며 정책 만족·승인·출시 허가가
아닙니다. deferred/다른 terminal 관찰은 2, 명령 오류는 1, 사용법 오류는 64입니다. 오류는 고정된
메시지만 출력하고 원인·키·credential·locator·설정 내용을 노출하지 않습니다.

단위 검사는 실제 private 파일·부분 읽기·권한/소유자/link/type/크기/encoding·읽기 중 변경·정리,
검증 도중 만료/폐기/권한 교체·실제 secret 검증·권한 선검사와 상태/출력 경계를 다룹니다.
argv/exit만 연결하는 작은 진입점은 실제 프로세스 검사로 확인하며 업무 모듈의 100% 기준은
유지합니다. 실제 PostgreSQL/S3 검사에서는 별도 Node 프로세스로 실행하고 원본 페이지/결과를
독립 재조회해 재시작 시 receipt/비용 보존과 잘못된 토큰/파일 권한의 무변경 거부를 확인합니다.
합성 reference fixture이며 live identity/provider·운영 키 증거는 아닙니다.

프로세스 간 crash/reclaim/취소의 결정적 barrier, 전체 상태 복구, 공개 API/OpenAPI/SDK, 모든
predicate/outcome의 기여자 흐름과 독립 종료 감사가 남습니다. 이후 결정/승인·attestation·CI adapter·
측정 운영도 각자의 진입/종료 검증이 필요합니다. 이 실행 파일은 그 단계나 전체 개발 목표의
완료 또는 자동 목표 생성을 뜻하지 않습니다.
