# OpenCodex fork automation

독립 관리 저장소입니다. `luvs01/opencodex`의 기본 브랜치에 자동화 코드를 추가하지 않으므로 Sync fork로 상류와 동일하게 유지할 수 있습니다.

## CodeRabbit review queue

- 대상은 `luvs01/opencodex`의 `luvs01` 작성, 열린 비초안 PR만입니다. 상류 PR이나 이 관리 저장소 PR에는 리뷰를 요청하지 않습니다.
- 매시 2·7·12·…·57분에 자격을 확인하도록 예약하며, 마지막 사용자 리뷰 요청으로부터 최소 1시간 및 CodeRabbit이 알려준 쿨타임을 모두 지킵니다. GitHub 예약 실행은 지연될 수 있어 정확한 시각을 보장하지 않습니다.
- 한 번에 하나만 요청합니다. 진행 중인 리뷰, 미확인 요청, 동일 HEAD 완료, pause/ignore, 최근 변경을 구분하며, 불명확한 POST는 자동 재시도하지 않습니다.
- 쿨타임과 요청 상태는 대상 PR의 실제 댓글·리뷰·반응에서 복구하므로 포크 동기화, runner 재시작, 자동화 이관으로 초기화되지 않습니다.
- Actions 요약에서 이유, PR별 상태, 다음 요청 가능 시각을 확인합니다. 수동 실행은 기본 `dry_run=true`입니다.

## Credential and isolation

관리 저장소의 Actions secret `CODERABBIT_REVIEW_TOKEN`은 `luvs01`의 fine-grained PAT입니다. **접근 대상 저장소는 `luvs01/opencodex` 하나**, 권한은 **Pull requests: read/write**, Metadata: read만 필요합니다. 관리 저장소에 대한 쓰기 권한은 필요 없습니다. 토큰은 채팅이나 소스에 기록하지 않습니다.

실제 리뷰 요청은 봇이 아닌 사용자 인증으로 전송됩니다. 실행 시 로그인 주체를 검증합니다. 리뷰 workflow의 기본 `GITHUB_TOKEN`은 관리 저장소 읽기에만 사용합니다. 아래 점검 workflow만 관리 저장소의 `actions: write` 권한으로 기존 큐를 호출합니다. 기존 PAT의 권한은 확대하지 않습니다. 리뷰 workflow는 `main`의 schedule/manual에서만 실행하며, PR 이벤트는 secret 없는 테스트만 수행합니다. 대상 PR의 코드를 가져오거나 실행하지 않습니다.

## Internal scheduling recovery

- `Queue scheduling watchdog`은 매시 7·22·37·52분과 이 관리 저장소 `main` push의 `Queue tests` 성공 후 실행됩니다. 별도 수동 실행은 기본 dry run입니다.
- 기존 큐가 활성화돼 있고, 진행 중인 실행이 없으며, 최근 실행 생성 후 15분 이상 지났을 때만 `workflow_dispatch`를 한 번 보냅니다. 직전 실행이 취소됐거나 승인을 요구하면 자동 복구하지 않습니다.
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
- 취소, 권한 오류, GitHub Actions 전체 장애 등으로 연결이 끊길 수 있어 무중단 보장은 아닙니다. 주 예약과 watchdog은 별도 복구 경로로 유지합니다. 기존 PR 코드는 실행하지 않습니다.
- `Internal clock bounded probe`는 별도 1분 환경에서 두 번만 실행되고 종료합니다. probe 자체는 리뷰를 요청하지 않습니다.

## Operation

`node --test`로 네트워크 없이 회귀 검사를 수행합니다. workflow 비활성화로 자동 요청을 중단할 수 있습니다. 비활성화는 이미 시작된 CodeRabbit 리뷰를 취소하지 않습니다. 토큰 만료·취소는 실패로 표시되며 bot credential로 우회하지 않습니다.

포크 `dev`에서 workflow를 다시 설치하지 마세요. 큐를 추가로 켜면 저장소 간 concurrency가 공유되지 않습니다. 수동 리뷰 요청은 다음 검사에 반영되지만 정확히 동시에 보낸 요청까지 원자적으로 막는 것은 아닙니다.

공개 저장소의 예약 workflow는 저장소 활동이 60일간 없으면 GitHub가 비활성화할 수 있습니다. 관리 시 Actions 상태를 확인해야 합니다. 이를 피하려는 빈 활동 커밋은 만들지 않습니다. [GitHub 정책](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
