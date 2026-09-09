# NSR Backend (Express + MongoDB)

Mock API that simulates servers with NSR backup services. It exposes the same
`nsr-status` / `nsr-restart` contract the Wings agent tools call, so it can
stand in for a real Windows/AIX server while you demo the restart agent.

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Health check |
| GET | `/api/servers` | List all servers |
| POST | `/api/servers` | Create a server — `{ name, os_type: "Windows"\|"AIX" }` |
| GET | `/api/servers/:serverName` | Get one server |
| DELETE | `/api/servers/:serverName` | Delete a server |
| POST | `/api/servers/:serverName/services` | Add an NSR service — `{ name }` |
| DELETE | `/api/servers/:serverName/services/:serviceId` | Remove a service |
| POST | `/api/servers/:serverName/fail` | Simulate failure — stops all NSR services |
| GET | `/api/servers/:serverName/nsr-status` | Current status (what the agent polls) |
| POST | `/api/servers/:serverName/nsr-restart` | Restart NSR services — passes through a `restarting` state for ~2.5s before landing on `running`, so the dashboard visibly shows the stop → start cycle |
| GET | `/AIMWebService/api/Accounts?AppID=...&Safe=...&Object=...` | Mocks CyberArk CCP's credential-fetch API — same query params and response shape (`Content`, `UserName`, `Address`, `Safe`) as real CyberArk, so the agent tools' credential-fetch step is unchanged between demo and production |

## Local setup

```bash
npm install
cp .env.example .env
# edit .env with your MongoDB Atlas connection string
npm run dev
```

## MongoDB Atlas

1. Create a free cluster at https://www.mongodb.com/cloud/atlas
2. Database Access → add a user with a password
3. Network Access → allow access from anywhere (`0.0.0.0/0`) so Render can connect
4. Connect → Drivers → copy the connection string, replace `<username>`/`<password>`, and set it as `MONGODB_URI`

## Deploy to Render

1. Push this folder to a GitHub repo
2. Render → New → Web Service → connect the repo
3. Build command: `npm install`  ·  Start command: `npm start`
4. Add environment variables:
   - `MONGODB_URI` — your Atlas connection string
   - `CORS_ORIGIN` — your Vercel frontend URL (e.g. `https://nsr-console.vercel.app`), comma-separate if you need more than one
5. Deploy. Render gives you a URL like `https://nsr-backend.onrender.com` — that's your `NEXT_PUBLIC_API_URL` for the frontend.
