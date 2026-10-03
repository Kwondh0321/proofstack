# 수집한 평가 실행과 재현 기록의 연결

[English](workflow-2-evaluation-replay-bindings.md) | [한국어](workflow-2-evaluation-replay-bindings.ko.md)

상태: 보존된 도메인 간 관계 검사입니다. Workflow 2의 세 번째 체크포인트는 미완료입니다.

`capturePolicyRecordGraph`의 `evaluationReplays`는 여러 assessment가 공유하는 실행까지 포함해
모든 수집된 평가 실행을 검사합니다. 개별 실행과 계획의 해시가 유효하더라도 서로 다른 dataset이나
target을 가리킬 수 있습니다. 추가 저장소 조회 없이 정확한 계획·종결 결과와 기존 소유 도메인의
계획·결과 검사 보고서를 연결합니다.

| 검사 | 의미 |
| --- | --- |
| `plan_dataset` | 계획과 평가 실행의 dataset 참조가 정의 해시까지 정확히 일치합니다. |
| `plan_target` | 계획과 실행의 replay target이 adapter·worker protocol까지 일치합니다. |
| `plan_receipt` | 계획의 기록 시각이 선언된 재현 완료 시각 이하여야 하며 원래 시각 정밀도를 유지합니다. 실제 job 생성과 계획 기록의 순서는 소유 결과 보고서가 별도로 확인합니다. |
| `plan_prerequisites` | 동일한 출처·전체 해시의 계획 보고서에 모순이나 사용 불가 의존성이 없어야 합니다. 개별 계획 검사에 요약되지 않는 isolation 기록도 포함합니다. |
| `result_history` | 동일한 출처·전체 해시의 결과 보고서가 같은 계획 관측에 연결되며 이전 시도와 확인 불가 시간·사용량까지 소유 이력 검사를 보존합니다. |

하나의 소유 보고서를 요약할 때 알려진 모순은 사용 불가보다 우선합니다. 개별 검사는 분리하므로
결과 누락이 dataset 불일치를 지우지 않으며 선언 일치가 누락된 의존성을 사용 가능하게 만들지
않습니다. 읽을 수 없는 실행은 원래 관측과 함께 `unavailableParents`에 남습니다. 내부 간선·해시·
참조가 바뀌거나 필수 소유 보고서가 누락되면 수집을 실패시킵니다.

fixture마다 별도 계획을 요구하지 않습니다. 계획은 dataset과 여러 경계 선언을 가지므로 여러
평가 fixture가 공유할 수 있습니다. dataset의 fixture 소속과 기록형 경계의 개별 invocation·
fixture 검사는 기존 소유 보고서에서 유지합니다.

각 부모의 정확한 출처·전체 해시와 원래 간선 인덱스를 보존합니다. 계획의 dataset·target 간선은
계획을 부모로 유지합니다. 공유 계획·결과를 한 번 조회해도 각 실행의 반복 의미 검사 참조 수와
정규 바이트는 다시 계산하며, `inspectionUsage`를 요청 전체 예산에 합산합니다. 정확한 한도는
허용하고 초과 시 부분 성공 없이 실패합니다. 소유 보고서 요약은 한 번 인덱싱해 재사용하며 입력과
출력은 분리됩니다. CPU·전송량·전체 메모리·영속 재시도 계측을 주장하지 않습니다.

테스트는 실제 메모리 평가·dataset·계획·job 저장소와 검증된 정적 runtime catalogue를 사용합니다.
공유 계획 사례는 simulation 경계를 선언하며 성공 job 이력을 기록한 것이 실제 simulator 실행을
뜻하지는 않습니다. 정상 공유, 다른 dataset·target, 부모·의존성 누락, 누락과 모순의 공존,
서브밀리초 시간 경계, 원래 간선·해시, 출처 훼손, 결과 복사와 반복 사용량 한도를 검사합니다.

기존 `evaluationSnapshots`·`candidateAssessmentLineage`의 검사 범위는 바꾸지 않습니다. 전체
closure와 입력 봉인에는 이 결과 및 비교·dataset·fixture·권한·아티팩트·선택자 관측을 함께
검증해야 합니다. 관계 일치는 실행·실측 사용량·설치 권한·현재 출처 신뢰나 정책 판정이 아닙니다.
새 경로·역할·스케줄러·스냅샷 게시·출시 승인은 추가하지 않았습니다.
