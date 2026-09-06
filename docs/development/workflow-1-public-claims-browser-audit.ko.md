# Workflow 1 공개 주장·브라우저 감사

[English](workflow-1-public-claims-browser-audit.md) |
[한국어](workflow-1-public-claims-browser-audit.ko.md)

- 상태: 공개 주장·브라우저 finding 승인
- 검토일: 2026-09-06
- 구현 범위: `824c7f8`, `f99b3ef`, `7df28c6`
- 프로덕션 준비: 승인되지 않음
- Workflow 1 종료: 이 집중 감사만으로는 승인되지 않음
- Workflow 2 진입: 이후 최종 Workflow 1 감사에서 열림

## 결정

Workflow 1 종료 검토의 공개 주장·브라우저 finding을 제한된 operator-view 경계에서
승인합니다. 공개 영어·한국어 진입점은 이제 연결된 evidence와 causal proof, 설명형
comparison과 policy·approval, 구현된 workspace SDK와 배포된 package, 기준 복구와 프로덕션
재해 복구를 구분합니다. 실행 가능한 claim 검사는 검토한 공개 surface가 오래된 문구로
조용히 되돌아가는 것을 막습니다.

Operator console은 실제 API 상태를 읽습니다. 검증한 server-side browser session을 전달하고,
요청한 trace identity나 설정 scope를 바꾼 응답을 거부하고, cache할 수 없는 JSON 응답과 4 MiB
trace body 상한을 요구하고, 제한된 적대 문자열을 실행 불가능한 text로 렌더링합니다.
Comparison route는 표시 전에 모든 불변 record digest와 record 사이 lineage를 계속
검증합니다. API를 사용할 수 없을 때 어느 route도 demonstration data를 대신 넣지 않습니다.

이 결정은 Workflow 1 전체를 승인하지 않습니다. 대표성 있는 agent 성능, causal improvement,
source truth, reviewer 전문성, 프로덕션 인증, 보조 기술 인증, 배포 준비, policy 집행, approval,
release authority도 증명하지 않습니다.

## 실행·브라우저 근거

| 경계 | 근거 | 결과 |
| --- | --- | --- |
| 공개 주장 | `pnpm claims:check`는 두 README, 현재 product 문서, 모든 공개 guide, operator 진입 surface, OpenAPI source를 읽습니다. 이번 검토에서 29개 surface를 금지 주장 pattern 6개와 필수 경계 문구 8개에 대조했습니다. 이 명령은 `pnpm check`에 포함됩니다. | 승인 |
| Trace transport | API·OpenAPI test는 `Cache-Control: no-store`를 요구합니다. Web test는 JSON media type, `no-store`, 선언·stream 4 MiB 상한, 유효 contract, outer·event trace ID, 설정 project·environment, 내부적으로 일관된 tenant, 유효 cursor, 검증된 server-only session cookie를 요구합니다. | 승인 |
| 적대 렌더링 | Component test는 script 형태 event name과 image-handler 형태 service name을 렌더링하고 React가 실행 요소 없이 escape된 text를 내보내는지 확인합니다. Source-level 회귀 test는 좁은 layout에 필요한 shrink·wrap rule을 고정합니다. | 승인 |
| 실제 comparison view | 새 loopback API가 실제 HTTP comparison route로 `result_latency_service`를 게시했습니다. Browser는 production server component로 결과를 읽고 `125/1`, `100/1`, `-25/1 milliseconds`, 정확 source identity·digest, 보존 limitation, 명시적 non-approval 안내를 표시했습니다. | 승인 |
| 반응형 layout | 정확한 390×844 CSS viewport에서 overview, comparison, hostile trace document는 각각 390 CSS pixel 폭을 유지했습니다. 네 comparison overflow 영역은 document를 넓히지 않고 내부에서 scroll됐습니다. | 승인 |
| 의미 구조·keyboard | Comparison DOM은 이름과 focus가 있는 overflow 영역 4개, caption 4개, column header 17개, row header 8개를 노출했습니다. Keyboard focus는 눈에 보이는 solid outline을 만들었고, 물리 right-arrow 3회로 첫 영역이 0에서 약 218 CSS pixel로 이동했으며 document 폭은 늘지 않았습니다. | 승인 |
| 적대 browser 상태 | Browser는 run-local trace `6a966011b2a3f4cc5da21834a264fc95`를 읽고 두 적대 문자열을 literal text로 보존했으며 hostile `script`·`img` node는 0개, injected marker는 unset이었습니다. `7df28c6` 뒤 정확한 390-pixel document 폭도 유지했습니다. | 승인 |
| 보수적 장애 | API process를 중단한 뒤 정확 comparison URL과 hostile trace URL 모두 명시적인 no-placeholder 문구와 함께 `API is not reachable`을 표시했습니다. Cache되거나 일부만 검증된 evidence는 남지 않았습니다. | 승인 |
| Port 소유권 | 정상 console port는 3000입니다. 이번 감사에서는 Grafana가 3000을 사용 중이어서 선택형 3011만 사용했습니다. 어떤 service·guide도 3010을 요구하지 않으며 repository의 두 언급은 일회성 acceptance runner에 그 port가 필요 없다고 명시합니다. 두 감사 service를 종료하고 listener가 없음을 확인했습니다. | 승인 |
| 영속 seam | 시각 검사는 의도적으로 memory-backed인 HTTP 예제를 사용했습니다. 별도로 PostgreSQL web integration과 전체 Workflow 1 acceptance는 재시작 뒤 같은 production comparison projection을 읽고, 조정 복구 suite는 empty-target 복원 뒤 정확 graph를 읽습니다. 따라서 browser 검사는 표시 동작을 증명할 뿐 그 자체로 PostgreSQL persistence를 증명하지 않습니다. | 명시된 분리 조건으로 승인 |

Trace 경계 구현 `824c7f8`은
[CI 실행 34032702889](https://github.com/Kwondh0321/proofstack/actions/runs/34032702889)와
[Security 실행 34032702891](https://github.com/Kwondh0321/proofstack/actions/runs/34032702891)을
통과했습니다. 공개 claim 구현 `f99b3ef`은
[CI 실행 34033189213](https://github.com/Kwondh0321/proofstack/actions/runs/34033189213)와
[Security 실행 34033189343](https://github.com/Kwondh0321/proofstack/actions/runs/34033189343)을
통과했습니다. 좁은 hostile detail 수정 `7df28c6`은 로컬 focused web test와 production build를
통과했습니다. Remote 결과는 여기서 추정하지 않고 최종 Workflow 1 repository gate에
기록합니다.

## 닫힌 finding

1. **공개 workflow 설명이 causal trace 검사와 현재 release 차단을 주장했습니다.** 커밋
   `f99b3ef`은 연결된 evidence와 구현된 설명형 incident-to-comparison 경로를 설명하고 policy와
   release authority를 Workflow 2에 남깁니다.
2. **공개 상태가 완료된 comparison surface를 빠뜨렸습니다.** 커밋 `f99b3ef`은
   repository-backed source resolver, 불변 API/OpenAPI record, workspace SDK client,
   digest 검증 operator route를 기록하면서 SDK가 registry에 배포되지 않았다고 명시합니다.
3. **Trace browser session과 API 응답 검증이 comparison 응답보다 약했습니다.** 커밋
   `824c7f8`은 검증한 server-only session을 전달하고 response size, media type, cache, identity,
   project, environment, tenant coherence 검사를 추가합니다.
4. **Hostile trace detail은 실행되지 않았지만 mobile document를 넓혔습니다.** 첫 390×844
   실행은 `white-space: nowrap` detail이 minimum content width를 유지해 422 CSS pixel을
   기록했습니다. 커밋 `7df28c6`은 clipping을 없애고 grid child shrink와 전체 literal value
   wrapping을 허용합니다. 반복 실행은 정확히 390 pixel이었습니다.
5. **오래 실행된 감사 service가 과거 build를 현재처럼 보이게 할 수 있었습니다.** 검토는
   18시간 된 comparison API와 19시간 된 web process를 찾아 중단하고 workspace를 다시 build한
   뒤 새 process로 browser 결과를 승인했습니다.

이 집중 감사에서 해결되지 않은 finding 때문에 exit finding 6을 열어 둘 이유는 없습니다. 이
집중 결정 시점에는 독립적인 Workflow 1 단계 결정과 최종 전체 repository gate가 별도 작업으로
남아 있었고, 이후 [최종 감사](workflow-1-audit.ko.md)가 그 승인을 기록합니다.

## 승인된 한계

- Browser 상태는 synthetic·memory-backed입니다. 실제 API/web seam과 장애 동작을 증명하지만
  그 자체로 대표 성능이나 persistence를 증명하지 않습니다.
- 접근성 근거는 semantic HTML, browser accessibility tree, focus visibility, 물리 keyboard
  scrolling을 포함합니다. 완전한 VoiceOver·NVDA·JAWS 또는 사용성 연구 인증은 아닙니다.
- 4 MiB trace-page ceiling은 console 안전 상한이며 모든 contract-valid trace page 표시 약속이
  아닙니다. Console은 이 경계를 넘으면 fail closed합니다.
- Console은 제한된 operator projection입니다. 분류된 prompt·response·artifact byte,
  credential, private review text를 의도적으로 생략합니다.
- Search·retrieval은 discovery tool일 뿐입니다. 누락된 authority를 제공하거나 requester claim을
  truth로 바꿀 수 없습니다.
- 어떤 view·comparison result도 capability를 부여하거나 exception을 승인하거나 code를
  deploy하거나 release를 차단하거나 책임 있는 결정을 대체하지 않습니다.

## 이후 최종 gate

이후 [최종 Workflow 1 감사](workflow-1-audit.ko.md)는 `e19908b`에서 전체 repository gate를
실행하고 CI·CodeQL을 확인하고 모든 exit-matrix row를 대조해 제한된 단계를 승인하고
Workflow 2 개발 진입을 열었습니다. 그 이후 결정도 이 집중 browser finding을 프로덕션 준비,
policy, approval, deployment, release 주장으로 확장하지 않습니다.
