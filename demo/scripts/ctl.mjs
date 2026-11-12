// Switches failure scenarios on and off by hand.
//   npm run demo:scenario -- list
//   npm run demo:scenario -- db-latency on
//   npm run demo:scenario -- db-latency off      (also checks that the shop has recovered)
//   npm run demo:scenario -- baseline            (everything off)
//   npm run demo:scenario -- status
import { admin, dockerRunning, log } from './lib.mjs';
import { SCENARIOS, baseline, probe, verifyRecovered } from './scenarios.mjs';

const [name, action] = process.argv.slice(2);

if (!name || name === 'list') {
  for (const [key, s] of Object.entries(SCENARIOS)) console.log(`\n${key}\n  ${s.title}\n  What it does:   ${s.mechanism}\n  What you see:   ${s.observable}\n  Activate:       npm run demo:scenario -- ${key} on\n  Recover:        npm run demo:scenario -- ${key} off`);
  console.log('\nbaseline\n  Healthy baseline: every fault off, every container running.\n  Activate:       npm run demo:scenario -- baseline\n');
} else if (name === 'status') {
  for (const service of ['shop-orders', 'shop-payments']) console.log(service, JSON.stringify(await admin(service, '/state').catch((e) => ({ unreachable: e.message }))));
  for (const c of ['demo-redis', 'demo-payments', 'demo-postgres']) console.log(c, dockerRunning(`opspilot-${c}-1`) ? 'running' : 'STOPPED');
  console.log('probe through the gateway:', JSON.stringify(await probe(24)));
} else if (name === 'baseline') {
  await baseline();
  log('baseline restored:', JSON.stringify(await verifyRecovered()));
} else if (SCENARIOS[name] && action === 'on') {
  await SCENARIOS[name].on();
  log(`${name} is ON. ${SCENARIOS[name].mechanism}`);
  log(`Look for: ${SCENARIOS[name].observable}`);
  log(`Recover with: npm run demo:scenario -- ${name} off`);
} else if (SCENARIOS[name] && action === 'off') {
  await SCENARIOS[name].off();
  const check = await verifyRecovered();
  log(check.recovered ? `${name} is OFF and the shop has recovered: ${check.requests} requests, 0 failed, p95 ${check.p95Ms} ms.` : `${name} is OFF but the shop has NOT recovered yet: ${JSON.stringify(check)}`);
  process.exit(check.recovered ? 0 : 1);
} else {
  console.error(`Unknown scenario or action. Try: npm run demo:scenario -- list`);
  process.exit(2);
}
