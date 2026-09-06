# Workflow 2 불변 릴리스 후보 감사

[English](workflow-2-release-candidate-audit.md) |
[한국어](workflow-2-release-candidate-audit.ko.md)

- 상태: Workflow 2 첫 번째 체크포인트 승인
- 검토일: 2026-09-06
- 감사한 구현: `313d14de20d60cd8c2eed293f6a25ebe762d7fe7`부터
  `f697638416727b10dc2d04ed5115540bc8c0feae`까지
- 아키텍처: [ADR-0021](../architecture/0021-separate-release-policy-authority.md)
- 프로덕션 준비 상태: 승인하지 않음
- policy, approval, decision, attestation, CI enforcement, deployment, release 권한: 포함하지
  않음
- 다음 체크포인트: versioned policy definition 진입 가능

## 결정

불변 release-candidate 체크포인트를 승인한다. ProofStack은 이제 source code, build provenance,
prompt·tool artifact, runtime declaration, target release, dataset, assessment, model assurance,
설명형 comparison result를 결합한 정확하고 policy와 독립적인 subject 하나를 보존할 수 있다.
record는 append-only이고 exact-scope이며 canonical digest를 검증한다. 발행 전에 모든 source를
독립적으로 해석하고, 같은 요청을 재시도하면 멱등 처리되며, memory, PostgreSQL, HTTP,
OpenAPI, TypeScript SDK, 재시작, 조정 복구 경계에서 사용할 수 있다.

독립 교차 검증은 의도적으로 보수적인 참조를 사용했다. Workflow 1 comparison은
`incomparable`이고 model identity는 `provider_alias_only`로 남으며, candidate는 policy,
approval, attestation, CI 상태, deployment action이 없다고 명시한다. 따라서 upstream evidence를
release verdict로 재해석하지 않았다.

이 결정은 이후 policy evaluation에 사용할 **불변 subject**만 승인한다. requester instruction,
보존 criteria, source material, model output, assessment, business objective가 옳다는 것을
증명하지 않는다. agent action이나 software release를 허가하지도 않는다.

## 승인한 subject chain

```text
정확한 Git commit과 commit tree
  + 보존된 Workflow 1 artifact와 record
  + 설치 환경 소유 runtime declaration
  -> 정확한 ReleaseCandidate definition
  -> server 작성 불변 record와 outbox intent
  -> exact-version API·SDK read
```

candidate에는 mutable alias나 `latest` 조회가 없다. 선택적 predecessor는 동일 candidate와
scope에 속한 다른 정확한 candidate ID, version, digest이다. 어느 version도 덮어쓰지 않고
lineage를 설명한다.

## 승인 매트릭스

| 경계 | 독립 근거 | 결정 |
| --- | --- | --- |
| 계약 | 엄격하고 schema version이 있는 contract가 full Git commit/tree object ID, component와 고유 role, target purpose·risk, exact target release, artifact, dataset, assessment, assurance, comparison, omission, limitation, 선택적 predecessor를 결합하고 server, policy, approval, credential, deployment field 밀어넣기를 거부한다 | 승인 |
| Canonical 무결성 | domain이 분리된 canonical encoder와 고정 public UTF-8/SHA-256 vector가 schema·encoding version, exact scope, ordering, 모든 semantic field와 predecessor identity를 결합하고 server receipt metadata만 제외한다 | 승인 |
| Source 열거 | core logic은 모든 artifact, dataset, evaluation, comparison, replay, revision, model declaration, adapter dependency를 고정된 순서로 열거한다. 잘못된 순서와 candidate 작성 authority field는 해석 전에 실패한다 | 승인 |
| Source 권위 | 보존 byte와 exact repository record를 독립적으로 다시 읽고 digest를 검사한다. operator 범위 local Git authority는 network 없이 full commit·tree object와 관계를 해석하고, 설치 환경 소유 registry가 exact runtime declaration을 대조한다 | 문서화된 참조 authority에 대해 승인 |
| Core 발행 | authorization이 parsing과 dependency보다 먼저 실행되고 모든 source가 server time·persistence보다 먼저 해석된다. exact retry는 재해석 없이 원래 record를 반환하며 unavailable source, 잘못된 route identity·lineage, malformed repository output, 충돌 version은 보수적으로 실패한다 | 승인 |
| Memory repository | 공통 conformance가 exact creation, retry, conflict, predecessor, resource collision, hidden absence, defensive copy, append-only, scope isolation을 포함한다 | 승인 |
| PostgreSQL | migration `0045`, 정규화된 candidate registry/resource/lineage/body table, constraint·immutable trigger, canonical validation, 최소 권한 function, 강제 row-level security, public DML 차단, atomic outbox intent가 발행 하나를 보존한다 | 승인 |
| Tenant·role 격리 | 세 tenant가 충돌하는 candidate ID를 사용하며 guessed read, cross-scope lineage, transaction scope 누락, pooled context 재사용, candidate 권한이 없는 runtime role 발행을 거부한다 | 승인 |
| 복구 | 조정된 logical backup이 candidate와 정확한 successor를 빈 database에 복원하고 두 canonical record와 predecessor edge를 보존하며 runtime role을 다시 구성하고 멱등 발행을 유지한다 | 고정된 참조 복구 절차에 대해 승인 |
| API·OpenAPI | exact candidate/version POST·GET operation은 분리된 `release:manage`·`release:read` capability를 강제하고 parsing 전에 인증하며 안정적이고 제한된 problem document를 반환한다. create와 retry를 구분하고 malformed use-case output을 거부하며 생성된 OpenAPI 3.2 문서와 일치한다 | 승인 |
| TypeScript SDK | client가 endpoint, 인증, route, request, media type, cache policy, body limit, redirect, status/created 의미, exact identity, canonical digest, lineage를 검증한다. workload credential은 read-only이고 mutation은 자동 retry하지 않는다 | workspace SDK에 대해 승인 |
| 엔드투엔드 수용 | clean-checkout 명령이 실제 Workflow 1 PostgreSQL/S3 graph 전체를 만들고 API·worker를 재시작하며 checkout Git commit/tree와 등록 runtime을 해석한다. public SDK로 발행·retry하고 API를 재시작한 뒤 같은 candidate record를 읽는다 | 승인 |
| 오픈소스 사용성 | 영어 기본 [candidate 가이드](../guides/workflow-2-release-candidate.md), 연결된 한국어 가이드, root 명령 하나, frozen install, 무작위 loopback port, 일회성 service, 예상 출력, 실패 동작, cleanup, authority 전제, 지원하지 않는 주장이 문서화되고 link check를 통과했다 | 승인 |
| 저장소 | frozen dependency policy, format, architecture boundary, 문서 link, public-claim guard, lint, strict type, unit coverage, build, production dependency audit, secret scan, CodeQL, PostgreSQL, S3, artifact lifecycle, recovery, Workflow 1, Workflow 2 candidate gate가 green이다 | 승인 |

## 최종 실행 근거

최종 감사 상태 `f697638416727b10dc2d04ed5115540bc8c0feae`는
[CI run 34049407702](https://github.com/Kwondh0321/proofstack/actions/runs/34049407702)를
통과했다.

- frozen install, production dependency audit, 전체 repository check를 포함한 quality gate
- PostgreSQL, S3-compatible, artifact-lifecycle, coordinated-recovery integration
- 변경하지 않은 Workflow 1 clean-checkout acceptance
- Workflow 2 candidate clean-checkout acceptance
- secret scanning

같은 SHA는 [Security run 34049407721](https://github.com/Kwondh0321/proofstack/actions/runs/34049407721)의
CodeQL도 통과했다. Dependency review는 pull request 범위라 push에서 skip되었으며 quality job이
frozen production dependency audit를 별도로 실행했다.

구현 수용 상태 `c7a71cff5fe6a5704c4755f43c2ced4a77cd3e93`도 새 clean-checkout candidate
job을 3분 53초에 포함해
[CI run 34048728111](https://github.com/Kwondh0321/proofstack/actions/runs/34048728111)과
[Security run 34048728039](https://github.com/Kwondh0321/proofstack/actions/runs/34048728039)를
통과했다. 최종 문서 run은 candidate job을 4분 3초에 다시 통과했다.

구현 candidate는 모든 28개 workspace project에 대해 local `CI=true pnpm check`도 통과했다.
format, boundary, documentation, public claim, lint, strict type, 모든 unit suite·coverage threshold,
production build를 포함했다. 이 host에는 `docker` executable이 없어 일회성 container 명령을
로컬에서 시작할 수 없었다(`spawn docker ENOENT`). 대신 위의 깨끗한 GitHub Actions job이
체크인된 동일 root 명령을 두 번 실행했다. memory-storage fallback은 사용하지 않았다.

## 교차 검증에서 바로잡은 항목

1. **Version label이 mutable source identity를 숨길 수 있었다.** Contract가 선언된 object
   algorithm을 포함한 full Git commit·tree object ID를 요구하며, 참조 Git authority가 두
   object와 commit-to-tree 관계를 해석한다.
2. **문법상 유효한 reference가 unavailable 또는 변경된 content를 가리킬 수 있었다.** Source
   graph를 독립적으로 열거하고 repository resolver가 발행 전에 보존 artifact byte와 모든 exact
   Workflow 1 record를 다시 읽는다.
3. **Candidate가 자신의 model authority를 만들어낼 수 있었다.** Runtime declaration은 설치
   환경이 소유한 scope-bound configuration과 일치해야 한다. candidate가 작성한 role 이름은
   registry authority를 주지 않으며 alias-only model resolution은 한계를 보존한다.
4. **Canonical JSON만으로 semantic context를 빠뜨릴 수 있었다.** Encoder는 domain, encoding
   version, schema version, scope, 모든 definition field를 고정 public digest vector에 결합한다.
   server receipt field는 digest 경계 밖이며 입력에서 거부된다.
5. **Write 뒤 source를 검사하면 부분적으로 신뢰된 record가 남을 수 있었다.** Use case는
   management authority를 검사하고 모든 source를 해석한 뒤에만 timestamp·repository를 호출한다.
6. **Retry가 provenance를 다시 쓰거나 delivery intent를 중복 생성할 수 있었다.** Memory·
   PostgreSQL conformance는 exact retry에 원래 record를 반환하고 semantic conflict를 거부하며
   canonical atomic outbox intent 하나를 보존한다.
7. **Application 검사만으로 durable isolation을 증명할 수 없었다.** Migration `0045`가 정규화
   scope key, forced RLS, append-only trigger, private DML, least-privilege function, three-tenant
   collision matrix를 추가한다.
8. **Root record는 남지만 predecessor graph가 사라질 수 있었다.** 조정된 empty-target recovery가
   두 exact version과 predecessor edge를 복원하고 멱등성을 다시 검사한다.
9. **성공 HTTP status가 변경된 candidate semantics를 숨길 수 있었다.** TypeScript SDK가
   status/created 일관성, exact route identity, request semantics, lineage, response bound,
   재계산한 canonical digest를 독립적으로 검증한다.
10. **Unit 경계만으로 실제 보존 upstream graph를 증명할 수 없었다.** 전용 Workflow 2 candidate
    job이 완전한 Workflow 1 PostgreSQL/S3 acceptance data, public SDK client, 실제 Git object,
    무작위 runtime role, 두 번의 API restart를 사용한다.
11. **두 번째 flow 추가가 승인된 첫 workflow를 약화할 수 있었다.** Workflow 1은 별도의 변경
    없는 command·CI job으로 남으며 감사 SHA에서 두 clean-checkout job이 모두 통과한다.
12. **Authority 문서가 없는 실행 명령은 operator를 오도할 수 있었다.** Contributor guide가
    trusted-checkout 전제, static-registry 경계, alias-only model 한계, 정확한 cleanup, 아직 없는
    모든 후속 policy·enforcement 기능을 기록한다.

이 감사에서 Workflow 2 첫 번째 체크포인트를 무효로 만드는 미해결 항목은 없다.

## 승인된 한계

- Release candidate는 policy와 독립적인 subject이다. policy rule, threshold, mode, policy
  selection, evaluation outcome, exception, approval, decision, signature, CI status, credential,
  deployment action, rollback, break-glass authority가 없다.
- Local Git authority는 operator가 의도한 checkout과 repository URL을 골랐다고 전제한다.
  repository ownership을 확립하거나 remote state를 fetch하거나 hosting-provider signature를
  검증하거나 code가 옳다고 증명하지 않는다.
- 참조 runtime registry는 API 시작 시 복사되는 static 설치 configuration이다. discovery service,
  hardware attestation, provider identity API, production key authority가 아니다.
- Synthetic 참조 model은 선언된 alias만 노출한다. ProofStack은 `provider_alias_only`를 보존하고
  immutable served-model version을 만들어내지 않는다.
- Exact ID, retained byte, provenance, source availability, digest는 제한된 input·integrity chain을
  확립한다. instruction의 진실성, criteria 충분성, dataset 대표성, reviewer 전문성, model
  correctness, causal improvement, business suitability, lawfulness, release safety는 증명하지 않는다.
- Search·retrieval은 가능한 source나 counterevidence를 찾을 수 있다. Rank, snippet, source
  branding, 생성 summary, majority vote는 source·policy authority가 아니다.
- Clean-checkout acceptance는 실제 Workflow 1 graph에서 만든 candidate의 restart persistence를
  증명한다. Coordinated recovery job은 같은 repository·migration contract를 통해 대표
  candidate/successor graph를 사용한다. acceptance run의 ephemeral data를 복구하거나 production
  RPO·RTO를 확립하지 않는다.
- TypeScript SDK는 이 workspace 안에서 소비된다. registry 발행이나 독립된 제3자 package 소비를
  주장하지 않는다.
- 새 browser site나 release control은 추가하지 않았다. 승인한 user surface는 문서화된 root
  acceptance command와 exact API·SDK operation이다. 이후 operator UI도 해당 체크포인트 전에는
  decision authority를 암시할 수 없다.
- 고정된 참조 service는 live-provider compatibility, cloud portability, high availability,
  regional failover, continuous operation, production readiness를 확립하지 않는다.

## 다음 의존성 순서 체크포인트

다음 체크포인트는 **versioned policy definition**이다. 구현 전에 entry audit가 contract
vocabulary, installation binding, policy-author capability·PostgreSQL role, exact applicability,
advisory/mandatory mode, source trust, immutable lifecycle, expiry, withdrawal, supersession,
failure matrix를 고정해야 한다.

이 작업은 requester criteria를 숨은 business policy로 재사용하거나 evaluation 중 mutable state를
가져오면 안 된다. evidence가 무엇을 주장하는지, policy가 무엇을 요구하는지, 이후 책임 있는
decision이 무엇을 허가하는지 분리해야 한다. Deterministic policy evaluation, approval,
attestation, CI adapter, deployment, rollback, break-glass는 순서상 체크포인트가 독립적으로
승인될 때까지 닫혀 있다.
