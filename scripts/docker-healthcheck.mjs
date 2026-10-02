const port = Number(process.env.ISEOL_WEB_PORT || 3000);
const response = await fetch(`http://127.0.0.1:${port}/health`);
if (!response.ok) process.exit(1);
const body = await response.json();
if (body?.status !== "ok") process.exit(1);
