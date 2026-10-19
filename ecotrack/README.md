# EcoTrack

A responsive, full-stack community waste reporting demo with a Node.js API, persistent JSON database, image/video uploads, localized English/Tamil/Hindi interface, and interactive OpenStreetMap map.

## Run locally

Requirements: Node.js 18+

```sh
npm install
npm start
```

Open `http://localhost:4173` (or set `PORT`). The database is created at `data/db.json` and evidence uploads are saved under `uploads/`. Both can be moved with `ECOTRACK_DB` and `ECOTRACK_UPLOADS`.

### Demo accounts

- Community member: `demo@ecotrack.in` / `Demo123!`
- Department team: `team@ecotrack.in` / `Clean123!`

Choose the preferred language when prompted after signing in. The demo database, accounts, reports, events, and reward points persist across restarts. The initial sample accounts are created on the first run.

## Features

- Email/password registration and sign-in with scrypt-hashed passwords; per-process bearer-token sessions.
- English, Tamil, and Hindi translations; selected language persists in the user database.
- Citizen dashboard, global community leaderboard, report status, and reward points (+4 when a department resolves a report).
- Report submission with place-name suggestions, an interactive map pin or GPS selection, waste category, quantity, bin fill level, required photo/video, and a description for full bins.
- Any signed-in community member or department account can add a future community event with a searched, map-pinned, or GPS-selected location; neighbors can RSVP, see attendee counts, and find each event pinned on the map.
- Password-gated Workers menu has its own short-lived staff session, private user directory, all-report dashboard, report status controls, completion check, pinned report locations, and reporter email links. Only the authenticated account that unlocks workers can use its staff session; ordinary community accounts see only their own reports. The initial worker passcode is `4321`; set `ECOTRACK_WORKER_PASSWORD` before deployment and use HTTPS.
- Interactive Leaflet/OpenStreetMap map with community report and event pins; place-name suggestions and address lookups use the Photon geocoding service, while GPS selection uses browser geolocation permission.
- Responsive layout with mobile bottom navigation.

## Operational notes

This is a deployable prototype rather than a production municipal service: report notifications are reflected in the persisted department dashboard, but SMS/phone verification requires a configured communications provider; the app does not place phone calls. Map tiles and Photon place-name suggestions/address lookups require an internet connection; users can still pin a point on the map when search is unavailable. For public deployment, put the server behind HTTPS, use managed persistent storage and a production database, and add stronger staff identity verification and managed access controls before treating the prototype passcode as production security.
