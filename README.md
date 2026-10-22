# OpenCodex fork automation

독립 관리 저장소입니다. `luvs01/opencodex`의 기본 브랜치에 자동화 코드를 추가하지 않으므로 Sync fork로 상류와 동일하게 유지할 수 있습니다.

## CodeRabbit review queue

- 대상은 `luvs01/opencodex`의 `luvs01` 작성, 열린 PR(초안 포함)만입니다. 상류 PR이나 이 관리 저장소 PR에는 리뷰를 요청하지 않습니다.
- 매시 2·7·12·…·57분에 자격을 확인하도록 예약하며, 마지막 사용자 리뷰 요청으로부터 최소 1시간 및 CodeRabbit이 알려준 쿨타임 중 늦은 시각을 지킵니다. 1시간은 대상 포크 [#736](https://github.com/luvs01/opencodex/pull/736#issuecomment-6158411001)·[#737](https://github.com/luvs01/opencodex/pull/737#issuecomment-6256858477)의 실제 CodeRabbit 응답에서 확인된 포함 리뷰 한도입니다. 일반 요금제 문구로 이 포크의 한도를 높이지 않습니다. GitHub 예약 실행은 지연될 수 있어 정확한 시각을 보장하지 않습니다.
- 한 번에 하나만 요청합니다. 진행 중인 리뷰, 미확인 요청, 동일 HEAD 완료, pause/ignore를 구분하며, 불명확한 POST/PATCH는 자동 재시도하지 않습니다. 댓글·봇 응답으로도 바뀌는 PR `updated_at`에는 별도의 15분 대기를 적용하지 않습니다. 전송 직전 현재 HEAD와 상태·쿨타임을 다시 확인합니다.
- 쿨타임과 요청 상태는 대상 PR의 실제 댓글·리뷰·반응에서 복구하므로 포크 동기화, runner 재시작, 자동화 이관으로 초기화되지 않습니다.
- Actions 요약에서 이유, PR별 상태, 다음 요청 가능 시각을 확인합니다. 수동 실행은 기본 `dry_run=true`입니다.
- 기존 댓글 명령은 ack 후 2시간 또는 무반응 2시간이 지나면 동일 HEAD 기준 최대 3회까지 자동 재요청하고, 초과하면 `needs-manual`로 표시합니다. checkbox 요청은 수락 근거가 없으면 `trigger-pending`으로 유지하며 자동 재전송하지 않습니다. 진행·거부 등 독립적인 봇 근거가 확인된 요청에는 기존 대기·재시도 한도를 적용합니다.

### Manual review checkbox

- CodeRabbit 본인 댓글의 `Trigger a manual review`, 기존 `Trigger review`, `Check again to try again` checkbox를 인식합니다. `Autofix` 등 다른 checkbox는 건드리지 않습니다. 초안 상태는 유지하며 GraphQL 상태 변경을 사용하지 않습니다.
- 먼저 HEAD별 `trig` 마커를 남기고 해당 checkbox 하나를 선택합니다. 마커에는 편집 전 봇 댓글 ID와 관련 신호의 최소 비교 정보를 기록합니다. 최신 유효 버튼 댓글 전체가 이전 버튼을 대체하며, 최신 버튼이 체크돼 있으면 `trigger-control-checked`로 보류합니다. 이 경우 이전 버튼이나 Ready PR의 명령 댓글로 우회하지 않습니다. 실행 가능한 버튼이 없는 초안은 `no-trigger-surface`로 표시하고 다음 후보를 검사합니다. Ready PR에 버튼 자체가 없을 때만 기존 사용자 리뷰 명령 댓글을 사용합니다.
- 즉시 readback한 뒤 최대 4분간 15초 간격으로 실제 봇 진행·완료·거부를 확인합니다. 거부를 먼저 판정하며, 요청 이전의 댓글 내용이나 다른 HEAD의 신호는 수락 근거로 쓰지 않습니다. checkbox가 빠르게 해제돼도 오류로 단정하지 않고 독립적인 근거를 확인합니다. 버튼 소실·문구 변경·체크 해제만으로 수락을 확정하지 않습니다.
- PATCH 결과가 불명확하면 마커를 보존하고 실제 댓글을 읽어 확인합니다. 동일 PATCH나 대체 명령을 자동으로 보내지 않습니다. 이 상태는 다음 실행에서도 `trigger-pending`으로 복구됩니다.
- 확인된 진행·완료는 HEAD·근거 댓글/리뷰 ID·관측 시각을 자체 마커에 저장하고 readback합니다. 후속 저장이 실패하거나 불명확해도 최초 마커의 비교 정보로 오래된 봇 댓글에 새로 추가된 진행 신호를 복구하여 확인된 리뷰의 2시간 보호를 유지합니다. 우리의 checkbox 편집으로 수정 시각만 바뀐 기존 문구는 새 근거가 되지 않습니다. 근거 없는 `trigger-pending`을 전역 진행 상태로 간주하지는 않습니다.
- API가 checkbox 편집을 명시적으로 거부하면 `trig-rejected`로 마커를 수정하고 readback합니다. 이 기록은 리뷰 소진으로 계산하지 않으며, 해당 HEAD는 `trigger-write-rejected`로 자동 재시도에서 제외합니다. 거부 기록의 저장 결과까지 불명확하면 기존 마커를 보수적으로 보류합니다.
- CodeRabbit이 요청 후 `Draft PR not reviewed` 등으로 명시 거부하면 동일 HEAD 기준 6시간 후에만 재시도합니다. provider 제한 응답은 그 응답의 재시도 시각을 지키며 HEAD별 최대 3회 이후 `needs-manual`로 표시합니다.
- 이 큐는 CodeRabbit 리뷰 요청을 관리합니다. 리뷰 지적에 대한 코드 수정이나 스레드 답변·해결은 별도 작업입니다.

## Credential and isolation

관리 저장소의 Actions secret `CODERABBIT_REVIEW_TOKEN`은 `luvs01`의 fine-grained PAT입니다. **접근 대상 저장소는 `luvs01/opencodex` 하나**이며, 댓글·checkbox 편집용 **Issues: read/write**, PR·리뷰 조회용 **Pull requests: read**, Metadata: read를 사용합니다. Draft lift용 Pull requests: write/GraphQL 권한은 사용하지 않습니다. 관리 저장소에 대한 쓰기 권한은 필요 없습니다. 토큰은 채팅이나 소스에 기록하지 않습니다. 이 문서 변경은 실제 토큰·권한을 변경하지 않습니다.

실제 리뷰 요청은 봇이 아닌 사용자 인증으로 전송됩니다. 실행 시 로그인 주체를 검증합니다. 리뷰 workflow의 기본 `GITHUB_TOKEN`은 관리 저장소 읽기에만 사용합니다. 아래 점검 workflow만 관리 저장소의 `actions: write` 권한으로 기존 큐를 호출합니다. 기존 PAT의 권한은 확대하지 않습니다. 리뷰 workflow는 `main`의 schedule/manual에서만 실행하며, PR 이벤트는 secret 없는 테스트만 수행합니다. 대상 PR의 코드를 가져오거나 실행하지 않습니다.

## Internal scheduling recovery

- `Queue scheduling watchdog`은 매시 7·22·37·52분과 이 관리 저장소 `main` push의 `Queue tests` 성공 후 실행됩니다. 별도 수동 실행은 기본 dry run입니다.
- 기존 큐가 활성화돼 있고, 진행 중인 실행이 없으며, 최근 실행 생성 후 15분 이상 지났을 때만 `workflow_dispatch`를 한 번 보냅니다. 직전 실행이 취소됐거나 승인을 요구하면 자동 복구하지 않습니다.
- `Internal review clock` 체인이 죽어 있으면(마지막 실행이 성공·실패로 끝났고 대기 중인 후속 실행이 없음) `parent_run_id`를 비운 새 체인 루트를 dispatch해 자동으로 재시작합니다. 마지막 실행이 취소됐거나 승인을 요구하면 사람이 멈춘 것으로 보고 재시작하지 않고 경고만 남깁니다.
- 자동 복구로 해결할 수 없는 문제가 있으면 `<!-- ocx-watchdog-alert -->` 마커가 붙은 열린 이슈 하나를 만들거나 기존 이슈에 댓글을 남깁니다. 복구되면 같은 이슈를 자동으로 닫습니다.
- 이 점검은 리뷰 댓글을 작성하지 않습니다. 모든 실제 리뷰 요청은 기존 큐의 concurrency 및 PR 댓글 기반 쿨타임·중복 검사를 다시 거칩니다. 전송 결과가 불명확한 API 요청을 자동 재시도하지 않습니다.
- 다른 저장소·브랜치, PR 테스트 완료, 실패한 테스트, 리뷰 큐 자체의 완료는 복구 이벤트로 받지 않습니다. 신뢰된 `main` 코드만 실행하고 두 workflow가 서로 반복 호출하는 루프는 만들지 않습니다.
- 점검 요약에는 마지막 큐 실행 ID, 경과 시간, 복구 호출 여부가 남습니다. workflow를 비활성화해 둔 경우 다시 켜지 않습니다.
- 별도 예약도 GitHub의 같은 스케줄러를 사용하므로 공통 장애를 해결하거나 정시 실행을 보장하지 않습니다. 주 예약 시간 분산과 별도 점검·테스트 완료 이벤트는 복구 기회를 늘리는 완화책입니다.

## Environment timer fallback

`Internal review clock`은 `schedule`에 의존하지 않는 내부 대안입니다. 시작하면 GitHub Environment의 **15분 wait timer**에서 runner 배정 없이 기다린 뒤, 기존 리뷰 큐와 다음 타이머 실행을 각각 호출합니다. 쿨타임 종료 시점을 놓치지 않도록 15분마다 확인하지만 실제 리뷰 요청은 여전히 기존 큐가 최소 1시간 간격으로 제한합니다.

- Environment `review-clock-quarter-hour`에 `wait_timer: 15`, 관리자 우회 불가, `main` 브랜치만 허용을 설정해야 합니다. 코드는 환경 설정과 실제 경과 시간도 검사하므로 타이머 누락·단축 시 후속 호출을 거부합니다.
- 기다리는 동안 runner를 점유하지 않습니다. [GitHub wait timer 문서](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments#wait-timer)는 이 대기 시간을 과금 시간에 포함하지 않는다고 명시합니다.
- 각 실행은 짧은 작업 후 종료하고 다음 실행은 새 대기 시간을 거칩니다. `workflow_dispatch`는 `GITHUB_TOKEN`으로 호출해도 후속 실행을 만들 수 있는 [공식 예외](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)입니다. PAT 권한 확대나 외부 타이머가 필요 없습니다.
- 이미 대기 중인 다른 타이머가 있으면 추가 후속 실행을 만들지 않습니다. 이전 실행 재실행(`Re-run jobs`)은 거부합니다. 전송 결과가 불명확하면 실제 자식 실행을 확인한 뒤 복구해야 합니다.
- 중지: `Internal review clock` workflow를 비활성화하고 현재 대기 중인 실행을 취소합니다. 리뷰 큐를 비활성화한 경우에도 타이머는 후속 호출을 멈춥니다. 다시 시작할 때 활성 실행이 없는지 확인한 뒤 `parent_run_id`를 비워 수동 실행합니다.
- 취소, 권한 오류, GitHub Actions 전체 장애 등으로 연결이 끊길 수 있어 무중단 보장은 아닙니다. 끊겨도 watchdog이 다음 점검에서 새 체인 루트로 재시작합니다. 수동으로 멈춘 경우에는 경고 이슈만 남깁니다. 주 예약과 watchdog은 별도 복구 경로로 유지합니다. 기존 PR 코드는 실행하지 않습니다.
- `Internal clock bounded probe`는 별도 1분 환경에서 두 번만 실행되고 종료합니다. probe 자체는 리뷰를 요청하지 않습니다.

## Operation

`node --test`로 네트워크 없이 회귀 검사를 수행합니다. workflow 비활성화로 자동 요청을 중단할 수 있습니다. 비활성화는 이미 시작된 CodeRabbit 리뷰를 취소하지 않습니다. 토큰 만료·취소는 실패로 표시되며 bot credential로 우회하지 않습니다.

포크 `dev`에서 workflow를 다시 설치하지 마세요. 큐를 추가로 켜면 저장소 간 concurrency가 공유되지 않습니다. 수동 리뷰 요청은 다음 검사에 반영되지만 정확히 동시에 보낸 요청까지 원자적으로 막는 것은 아닙니다.

공개 저장소의 예약 workflow는 저장소 활동이 60일간 없으면 GitHub가 비활성화할 수 있습니다. 관리 시 Actions 상태를 확인해야 합니다. 이를 피하려는 빈 활동 커밋은 만들지 않습니다. [GitHub 정책](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
