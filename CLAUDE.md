# 5σ Alert

Telegram 마켓 알림 봇 + 매매 기록. watchlist와 보유 포지션을 TradingView 데이터로 감시하다가 기준(σ 또는 %)을 넘는 움직임이 생기면 Telegram으로 알리고, AI agent가 뉴스로 원인을 요약해 붙인다. 매매 내역을 기록·수집해 포지션, 손익, 매매 규칙 준수를 관리한다.

범위 밖: 주문 실행(자동 매매), 매수·매도 추천. 거래소 API 키는 조회 전용.

## 구조
- `src/market/` 시세 (TradingView 래퍼, 구독, 일봉/σ, 장 시간, 지연 측정, 종목 해석)
- `src/triggers/` 알림 규칙·cooldown (Phase 3)
- `src/agent/` 뉴스·원인 요약·자연어 (Phase 4)
- `src/journal/` 매매 기록·포지션·손익 (Phase 5)
- `src/bot/` grammy 봇, 명령어, 메시지 포맷
- `src/jobs/` 스케줄 작업
- 설정: `.env`(키), `config.yaml`(threshold·규칙), `aliases.yaml`(종목 별칭)
- LLM: Groq(OpenAI 호환, `src/agent/llm.ts`의 `LlmClient`). fast=`openai/gpt-oss-20b`(자연어→tool), smart=`openai/gpt-oss-120b`(원인 요약)
- 뉴스: Google News RSS (`src/agent/news.ts`의 `NewsSource`). 네이버·Finnhub는 키가 생기면 같은 인터페이스로 추가

## 명령
- `npm run dev` 개발 실행 (tsx watch + pino-pretty)
- `npm test` / `npm run typecheck` / `npm run build`
- 상시 실행(macOS launchd): `npm run service:install` / `service:restart`(코드 변경 후) / `service:uninstall` / `service:logs`
  - dev(`npm run dev`)와 서비스를 동시에 띄우면 Telegram polling이 충돌(409)한다. 둘 중 하나만 실행한다.

## 코딩 규칙
- TypeScript strict, ESM. 외부 입력(LLM 출력, API 응답, 명령어 인자)은 전부 zod로 검증한다.
- 모든 키와 쿠키는 `.env`에만 둔다. `.env`는 `.gitignore`에 있고, 로그에 키·쿠키·계정 정보를 출력하지 않는다.
- 거래소 API는 조회 엔드포인트만 호출한다. 주문 관련 코드는 작성하지 않는다.
- 외부 호출에는 타임아웃과 재시도를 둔다. 뉴스·LLM이 실패해도 숫자 알림은 반드시 나간다.
- 시각은 UTC로 저장하고 표시할 때만 KST로 바꾼다. 가격 시각은 항상 `lp_time` 기준이다.
- TradingView 접근은 `src/market/tradingview.ts` 안에서만 한다. 다른 모듈은 `MarketData` 인터페이스만 쓴다.

## TradingView 실측 메모 (2026-11-10)
- quote `update_mode`가 지연을 알려 준다: KRX `delayed_streaming_1200`, 실시간은 `streaming`. 지연 판정은 이 값을 우선하고, 없으면 `now - lp_time`으로 측정한다.
- 지수 quote(`KRX:KOSPI`)의 `volume`은 `1e100` 같은 무의미한 값이 온다 → 1e90 이상은 버린다.
- 일봉 `time`은 거래소 현지 날짜의 00:00 UTC. 오늘 미완성 봉이 포함되어 오므로 σ 계산에서 제외한다.
- KRX session `0900-1535`, 미국 `0930-1600`(America/New_York), 크립토 `24x7`(Etc/UTC).
- `searchMarkets`는 한글 종목명 검색이 약하다(예: "하이닉스" → 선물). 한글 이름은 `aliases.yaml`에 넣는다.
