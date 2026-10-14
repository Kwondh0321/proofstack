# 정책 worker 구성을 위한 제한된 object 읽기

[English](workflow-2-policy-bounded-object-reads.md) | [한국어](workflow-2-policy-bounded-object-reads.ko.md)

상태: 어댑터 선행 요소이며 Workflow 2 checkpoint 3은 미완료입니다(2/7 승인).

`createS3BoundedArtifactReader`는 SDK `maxAttempts=1`인 별도 읽기 포트를 생성합니다.
기존 S3 저장소는 기본 세 번 시도를 유지합니다. 일반 client의 명시적 시도 한도는 정수 1–3만
허용하며 전용 factory는 항상 한 번으로 고정합니다. 포트는 `get`과 `destroy`만 제공합니다.

Trusted 구성은 검증된 reference의 예상 encrypted byte 길이와 abort signal을 전달합니다.
입력을 전송 전에 검증·복사하고 `Range: bytes=0-(expectedBytes-1)`로 요청합니다. 응답 길이는
정확히 일치해야 하며 ContentRange가 있으면 전체 객체의 시작·끝·총 길이도 일치해야 합니다.
더 큰 객체의 올바른 prefix도 전체 객체로 인정하지 않습니다. HTTP 200/206만 허용하고 부분
206 응답은 전체 범위를 표시해야 합니다. 잘못되거나 큰 metadata는 body
할당·소비 전에 거부합니다. 기존 stream reader는 초과·절단·비-byte chunk를 거부하고, 거부된
응답을 정리하며 제공된 SHA-256 checksum을 검사합니다.

기존 유한 연결·요청·socket timeout을 적용합니다. 이미 취소된 요청은 전송하지 않고, 취소 후
도착한 응답을 정리합니다. 미완료 HTTP body의 취소는 실제 연결을 닫습니다. 실패·부재는 자동
재시도를 허용하지 않으며 새 물리 읽기는 [새 durable 예약](workflow-2-policy-artifact-admission.ko.md)이
필요합니다.

단위 검사는 정확한 길이·잘못된 한도·전체 객체 geometry·옵션 변경·취소 정리와 기존 동작을
검사합니다. 격리 HTTP endpoint는 재시도 가능한 503에서도 한 번 요청하고 fixture 정리 전에
socket이 닫히는 것을 확인합니다. 고정 SeaweedFS 통합 검사는 정확한 길이·더 짧거나 긴 예상
길이·부재 및 기존 저장소 사례를 포함합니다. Provider의 진실성이나 운영 권한을 승인하지 않습니다.

어댑터 자체는 ciphertext identity·AAD·retention·worker 범위·lease·게시 권한을 검증하지 않습니다.
Owning reader와 repository의 검증이 필요합니다. 선택적 trusted `artifactByteAdmission.objectReader`는
이 포트를 받습니다. ACK의 native lease/attempt/job 잔여 시간을 밀리초로 내리고 예약 전부터의
monotonic 경과 시간을 뺍니다. 만료된 읽기를 거부하고, 협조하는 읽기를 기한에 취소하며 늦거나
길이가 다른 응답을 거부합니다. 비용은 보존합니다. Abort를 무시하는 임의 callback의 종료를
보증하지 않으며 factory만으로 전체 worker 구성을 승인하지 않습니다. 모든 부분 network byte나 숨겨진
transport 할당을 측정하지 않으며 거부할 chunk가 이미 도착할 수 있습니다. 전체 worker의
metadata·record·reference·guarded reinspection 비용 집계는 남아 있습니다. 읽기나 어댑터만으로
정책 verdict·승인·release 권한·checkpoint 완료를 선언하지 않습니다.
