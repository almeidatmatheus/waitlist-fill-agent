// CLI: simulate the cancellation of a fictional appointment on a running server (dev/test only).
//   npm run trigger -- <appointmentId> [--remove-from-calendar]
//   npm run trigger -- --list
const port = process.env.PORT || '3000';
const base = `http://${process.env.HOST || '127.0.0.1'}:${port}`;
const headers = { authorization: `Bearer ${process.env.ADMIN_API_TOKEN}`, 'content-type': 'application/json' };
const arg = process.argv[2];

try {
  if (!arg || arg === '--list') {
    const r = await (await fetch(`${base}/appointments`, { headers })).json() as { appointments: any[] };
    for (const a of r.appointments.filter(x => x.status === 'scheduled')) console.log(`${a.id}  ${a.local}  ${a.treatment.padEnd(24)} ${a.patient}`);
    if (!arg) console.log('\nusage: npm run trigger -- <appointmentId> [--remove-from-calendar]');
  } else {
    const res = await fetch(`${base}/dev/trigger-cancellation`, { method: 'POST', headers, body: JSON.stringify({ appointmentId: arg, removeFromCalendar: process.argv.includes('--remove-from-calendar') }) });
    console.log(res.status, JSON.stringify(await res.json(), null, 2));
  }
} catch (e) {
  console.error(`could not reach ${base} - is the server running (npm start)? ${(e as Error).message}`);
  process.exit(1);
}
