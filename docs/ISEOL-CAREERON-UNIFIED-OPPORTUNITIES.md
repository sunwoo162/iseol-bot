# 이설 → Discord + CareerOn: 공모전·채용 통합 파이프라인

**상태:** `feat/unified-opportunities-v1` Draft PR. **운영 서버/실제 Discord 채널/커리온 DB 변경 없음.**

## 아키텍처

- **공모전:** 기존 이설 7개 출처의 HTML 수집, 매일 09:00 KST 갱신 → 기존 디스코드 공모전 채널 / CareerOn 서명 outbox
- **채용:** `ISEOL_JOB_SOURCES_JSON`으로 명시한 공개 채용 페이지 HTML, Greenhouse, Ashby, Lever(global/EU) → 매일 09:10 KST 갱신 → `ISEOL_JOB_DISCORD_CHANNEL_IDS`에 설정된 별도 채용공고 채널 / 같은 CareerOn 서명 outbox
- **커리온:** `POST /api/integrations/iseol/opportunities`에서 HMAC 검증 → 공모전/채용 구분·검증 → SQLite 원자적 업서트 → 기존 내 기회 / 채용 공고 UI·기술별 학습 매칭
- **장애 분리:** 사이트 한 곳 실패 시 다른 소스의 검증된 공고 전송은 유지. Discord 실패와 CareerOn 실패는 각자 재시도. 빈/깨진 소스를 정상 데이터로 덮어쓰지 않는다.
- **ID:** 원문 URL 해시로 중복 공고 감지. Discord는 성공적으로 발송한 항목의 SHA-256을 채널별 영속 파일로 기록. 커리온은 고유 source ID로 멱등 업서트.
- 인코딩 검사는 `src/services/html-scrape-quality.ts` 공통 모듈을 사용한다(UTF-8, EUC-KR/CP949, replacement, 차단/오류 페이지, 응답 용량). 신뢰할 수 없는 결과는 저장/발송하지 않는다.

## 사전 설정

이설 운영 서버에 아래 값을 **환경 변수로만 설정**한다. 예제 이름/주소는 실존 모집을 뜻하지 않으므로 실제 공식 채용 보드에 맞춰 수정한다.

```dotenv
# 필수: 운영자가 검증한 공개 채용 소스 1~12개만
ISEOL_JOB_SOURCES_JSON=[{"provider":"html","company":"예시 채용사","listUrl":"https://jobs.example.org/careers?page={page}","detailPathPrefix":"/jobs/","maxPages":2},{"provider":"greenhouse","company":"예시 Greenhouse 회사","board":"example"},{"provider":"ashby","company":"예시 Ashby 회사","board":"example"},{"provider":"lever","company":"예시 Lever 회사","board":"example"}]

# 기존 공모전 채널에는 영향 없음. 채용은 명시한 텍스트 채널로만 보냄
ISEOL_JOB_DISCORD_CHANNEL_IDS=123456789012345678

# Discord 게시 이력을 재시작/배포 뒤에도 유지하는 지속 디렉터리
ISEOL_JOB_FEED_DATA_DIR=/home/ubuntu/iseol/data

# CareerOn 서명 전송: 기존 설정과 동일. 양쪽 secret 일치 필수.
CAREERON_INGEST_URL=https://chwippo.https.gsmsv.site/api/integrations/iseol/opportunities
CAREERON_WEBHOOK_SECRET=<서버 내부의 32자 이상 비밀값>
```

커리온 서버에는 같은 비밀값을 `ISEOL_WEBHOOK_SECRET`으로 별도 설정한다. 예제 환경 변수와 비밀키를 GitHub/Discord/채팅 기록에 붙이지 않는다.

- 위의 `example.org`, `example`, 숫자형 Discord ID는 **자리표시자**다. 이 상태로 실행하면 정상 수집되지 않는다.
- **HTML 모드:** `listUrl`은 브라우저에서 직접 열리는 공개 채용 목록, `detailPathPrefix`는 같은 호스트의 채용 상세 경로. 첫 목록 공고 링크가 없거나 하나라도 상세 페이지 접근 실패하면 그 소스 전체를 실패 처리한다. React 등 JS 렌더링 전용 채용 사이트는 현재 HTML 모드로 지원되지 않으며, 사이트별 허용된 별도 어댑터가 필요하다.
- **ATS 모드:** 등록한 board 식별자에서만 공식 공개 GET 요청. 로그인 우회, 유료 API, 자동 지원 제출, 미승인 과도한 트래픽 없음.
- **디스코드:** 한 번에 최대 25건 신규 메시지. 같은 URL은 같은 채널에 재게시하지 않음. 장애 중 메시지 송신 성공 직후 영속 기록 실패 시 중복 가능.
- **커리온:** 25건씩 서명된 POST를 outbox에서 재시도. 모르는/잘못된 외부 데이터는 거부. 서명 필수.
- **실패:** 설정 누락 시 채용 수집 비활성이고 공모전 기능은 정상 동작. 수집 도중 예외·부분 누락은 `ISEOL_JOB_SCRAPE_HEALTH` 로그에 남는다.

## 릴리스 검증 게이트

1. 두 저장소 각각 빌드/타입체크/Node 테스트, 브라우저 QA 통과 확인.
2. 사이트별 robots.txt / 이용약관 / 공식 채용 링크 확인 후 게시·재배포 조건을 준수.
3. 개발·스테이징에서 등록 사이트 샘플 직접 GET, 인코딩/DOM 파싱, 0건/429/차단/정상 변동 검증.
4. 이설 DB/상태 파일 백업, outbox 영속 경로 설정, 중복·재시도·배포 재시작 점검.
5. **커리온 수신 PR을 먼저 통합**하고 서버 secret/URL/SSL 검증한 후 이설 운영 배포 승인. 역순 배포하면 404·outbox 누적 가능.
6. 실제 Discord 채널 ID/권한 확인, 테스트 길드 1건 시험 송신, 운영 채널 관리자 승인 후 자동 게시 활성화.
7. 운영 첫 24시간 수집 성공/실패, 전달 대기, 게시 중복, 외부 HTTP 429 등을 모니터링.

향후 확장: 회사 채용 페이지별 CSS/JSON-LD 파서, 변경 내용 알림, 공고 삭제 확인, 고2 지원 가능성 분류, 직무·기술 요구사항과 커리온 학습·코딩테스트/PR 증빙 연결.
