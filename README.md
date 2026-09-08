# Straight Distance (golf-pin-range)

골프장(어디든)에서 폰으로 여는 한 페이지. 홈 화면에 추가하면 이름은 **Straight Distance**. 위성지도 위에 내 GPS 위치가 찍히고, 지도를 **꾹 누르면** 그 자리가 핀,
내 위치에서 핀까지 **직선거리(m)** 를 크게 보여준다. 그게 전부다.

- 주소: https://chofafa.github.io/golf-pin-range/ (GitHub Pages, `main` 브랜치 루트)
- 지도: VWorld(국토지리정보원) 위성 타일 `https://xdworld.vworld.kr/2d/Satellite/service/{z}/{x}/{y}.jpeg` — z19(0.24m/px)까지 원본, 그 위는 확대. 키 없이 받아진다(개인 용도)
- 지도 엔진: Leaflet 1.9.4 (cdnjs)
- 저장: 마지막 핀·화면 위치를 그 폰의 localStorage 에
- 기본 화면: 베어크리크 춘천 클럽하우스. GPS 가 잡히면 첫 한 번 내 위치로 옮긴다 — 어느 골프장이든 된다

## 왜 claude.ai 아티팩트가 아닌가

아티팩트는 iframe 안에서 돌아 **위치 권한이 원천 차단**되고, CSP 가 외부 지도 타일을 막는다.
GPS 와 고화질 타일이 핵심이라 독립 호스팅이 필요했다 (2026-09-09).

## 오차

이중주파수 아이폰(14 Pro 이후) ±2~3m, 구형 ±3~5m, 숲·계곡 5~15m. 오른쪽 위 상태칩이 ±m 를 보여준다.
핀을 손으로 찍는 오차 2~3m 를 더하면 실전 ±5m 안팎.

## 고치기

`index.html` 한 파일. push 하면 1분쯤 뒤 반영된다. 로컬 확인은 `python3 -m http.server` 로 열면 되지만
GPS 는 https 또는 localhost 에서만 뜬다.
