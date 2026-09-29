# OpenCodex fork automation

독립 관리 저장소입니다. `luvs01/opencodex`의 기본 브랜치에 자동화 코드를 추가하지 않으므로 Sync fork로 상류와 동일하게 유지할 수 있습니다.

## CodeRabbit review queue

- 대상은 `luvs01/opencodex`의 `luvs01` 작성, 열린 비초안 PR만입니다. 상류 PR이나 이 관리 저장소 PR에는 리뷰를 요청하지 않습니다.
- 5분마다 자격을 확인하고, 마지막 사용자 리뷰 요청으로부터 최소 1시간 및 CodeRabbit이 알려준 쿨타임을 모두 지킵니다. GitHub 예약 실행은 지연될 수 있어 정확한 시각을 보장하지 않습니다.
- 한 번에 하나만 요청합니다. 진행 중인 리뷰, 미확인 요청, 동일 HEAD 완료, pause/ignore, 최근 변경을 구분하며, 불명확한 POST는 자동 재시도하지 않습니다.
- 쿨타임과 요청 상태는 대상 PR의 실제 댓글·리뷰·반응에서 복구하므로 포크 동기화, runner 재시작, 자동화 이관으로 초기화되지 않습니다.
- Actions 요약에서 이유, PR별 상태, 다음 요청 가능 시각을 확인합니다. 수동 실행은 기본 `dry_run=true`입니다.

## Credential and isolation

관리 저장소의 Actions secret `CODERABBIT_REVIEW_TOKEN`은 `luvs01`의 fine-grained PAT입니다. **접근 대상 저장소는 `luvs01/opencodex` 하나**, 권한은 **Pull requests: read/write**, Metadata: read만 필요합니다. 관리 저장소에 대한 쓰기 권한은 필요 없습니다. 토큰은 채팅이나 소스에 기록하지 않습니다.

실제 리뷰 요청은 봇이 아닌 사용자 인증으로 전송됩니다. 실행 시 로그인 주체를 검증합니다. 기본 `GITHUB_TOKEN`은 관리 저장소 읽기에만 사용합니다. 리뷰 workflow는 `main`의 schedule/manual에서만 실행하며, PR 이벤트는 secret 없는 테스트만 수행합니다. 대상 PR의 코드를 가져오거나 실행하지 않습니다.

## Operation

`node --test`로 네트워크 없이 회귀 검사를 수행합니다. workflow 비활성화로 자동 요청을 중단할 수 있습니다. 비활성화는 이미 시작된 CodeRabbit 리뷰를 취소하지 않습니다. 토큰 만료·취소는 실패로 표시되며 bot credential로 우회하지 않습니다.

포크 `dev`에서 workflow를 다시 설치하지 마세요. 큐를 추가로 켜면 저장소 간 concurrency가 공유되지 않습니다. 수동 리뷰 요청은 다음 검사에 반영되지만 정확히 동시에 보낸 요청까지 원자적으로 막는 것은 아닙니다.

Public repository scheduled workflows can be disabled by GitHub after 60 days without repository activity. Check the Actions status when maintaining this queue; it does not create artificial activity commits.
