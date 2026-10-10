# Market Results Dashboard

A responsive React + Vite dashboard prototype using plain CSS (no Tailwind). It currently uses sample/demo data and does not connect to Firebase.

## Requirements
- Node.js 18+ (Node 22 is fine)
- npm

## Run locally
```bash
npm install
npm run dev
```
Open the local URL printed by Vite, usually `http://localhost:5173`.

## Production build
```bash
npm run build
npm run preview
```

## Included
- Responsive dark dashboard
- Market results table for open/close stages
- Search and status/stage filters
- Source-agreement visualization
- Market details modal and source list
- Demo refresh action
- CSV export for the currently visible rows

## Before using live
Replace `SAMPLE_MARKETS` in `src/App.jsx` with data from the deployed API/Firestore-backed endpoint. All displayed values are explicitly demo/sample values. The refresh button currently only refreshes the demo timestamp; it does not call the scraper or upload results.
