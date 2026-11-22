# 해운대 드라이브 (Haeundae Drive)

부산 마린시티에서 해운대, 달맞이길까지 실제 지도를 바탕으로 만든 웹 드라이빙 시뮬레이션 프로토타입입니다. 경주가 아니라 자유롭게 달리는 게임입니다.

**플레이: https://jihunyangai.github.io/haeundae-drive/**

## 실행

```
npm install
npm run dev
```

`npm run build`로 만든 `dist/` 폴더는 정적 호스팅 어디에나 올릴 수 있습니다. 기획과 단계별 결과는 `docs/driving.md`에 있습니다.

## 출처

- 지도: © OpenStreetMap contributors (ODbL).
- 건물 윤곽과 높이: 국토교통부 GIS건물통합정보 (브이월드). 내려받으려면 본인의 인증키가 필요합니다: `VWORLD_KEY=<키> node tools/fetch-buildings.mjs` 후 `node tools/build-map.mjs`.
- 고도: Mapzen Terrarium 타일 (AWS Open Data)
- 인물 모델: Quaternius (quaternius.com), CC0 1.0
- 음악: Kevin MacLeod (incompetech.com), CC BY 4.0
- three.js, Vite
