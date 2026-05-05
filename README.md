# 머니플러스 보드 (Money Plus Board)

> 한국경제TV 〈머니플러스〉 방송팀을 위한 실시간 협업 메모 보드

방송 그래픽 톤(딥 네이비 + 골드 + 코랄)으로 디자인된 실시간 협업 화이트보드입니다. 카테고리별 메모(시황 / 종목 / 일정 / 이슈 / 메모)를 추가하고, 다른 접속자에게 즉시 반영됩니다.

## ✨ 기능

- 🔴 **실시간 동기화** — Socket.io 기반 WebSocket으로 즉시 반영
- 📺 **방송 그래픽 스타일** — 카테고리별 헤더 바 + 출처 라인 + 작성자 푸터
- ✍️ **작성자/수정자 자동 추적** — 누가 만들고 수정했는지 표시
- 🟡 **하단 LIVE 인디케이터** — 접속자 수, 최근 활동 표시
- 💾 **JSON 파일 영속성** — 단순하고 디버깅하기 쉬운 저장 방식

---

## 🚀 로컬 실행

```bash
npm install
npm start
```

브라우저에서 `http://localhost:3000` 접속.

---

## 🚂 Railway 배포

### 1. GitHub 저장소 만들기

```bash
git init
git add .
git commit -m "Initial commit: Money Plus Board"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/money-plus-board.git
git push -u origin main
```

### 2. Railway에서 새 프로젝트 생성

1. https://railway.app 접속 → **New Project** → **Deploy from GitHub repo**
2. 위에서 만든 `money-plus-board` 저장소 선택
3. Railway가 자동으로 Node.js 프로젝트를 감지하고 `npm start`로 실행

### 3. (중요) 영속 볼륨 설정

⚠️ Railway는 기본적으로 파일시스템이 휘발성입니다. 메모 데이터를 영구 보존하려면 **Volume**을 마운트해야 합니다.

1. Railway 프로젝트 → **Settings** → **Volumes** → **+ New Volume**
2. **Mount Path**: `/data`
3. **Volume Name**: `money-plus-data` (자유)
4. 그다음 Variables 탭에서 환경변수 추가:
   - `DATA_DIR` = `/data`

볼륨이 없으면 재배포 시 메모가 초기화됩니다. (테스트용으로는 OK)

### 4. 도메인 받기

Settings → **Networking** → **Generate Domain** 누르면 `*.up.railway.app` 도메인이 발급됩니다. 그 URL을 팀원들에게 공유하세요.

---

## 🎨 톤앤매너 커스터마이징

`public/styles.css` 상단의 `:root` CSS 변수로 색상을 조정할 수 있습니다:

```css
--navy-1: #08163a;       /* 메인 다크 네이비 */
--gold-1: #f5c500;       /* 머니플러스 골드 */
--coral: #d85050;        /* 종목 카드 */
--red-callout: #c41e1e;  /* 이슈 카드 */
```

카테고리 추가/변경은 다음 두 곳을 함께 수정:
- `public/app.js`의 `CATEGORY_LABELS` 객체
- `public/index.html`의 `category-picker` 영역
- `public/styles.css`의 `.note[data-category="..."]` 규칙

---

## 📁 프로젝트 구조

```
money-plus-board/
├── server.js           # Express + Socket.io 백엔드
├── package.json
├── data/
│   └── notes.json      # 메모 데이터 (자동 생성)
├── public/
│   ├── index.html      # 메인 페이지
│   ├── styles.css      # 머니플러스 브랜드 스타일
│   └── app.js          # 프론트엔드 로직
└── README.md
```

---

## 💡 향후 추가 가능한 기능

- 카테고리 필터 / 검색
- 메모 정렬 (격자 정렬, 카테고리별 정렬)
- 이미지 첨부
- 메모 간 화살표 연결 (마인드맵)
- CSV / Excel로 내보내기
- 비밀번호 보호 또는 Google 로그인
- 다크/라이트 모드 토글

---

## 🛡️ 라이선스

MIT — 자유롭게 수정·재배포 가능
