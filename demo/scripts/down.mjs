// Stops and removes the demo services. OPSILUME itself keeps running; `docker compose --profile app down` stops that.
import { compose, log } from './lib.mjs';

const services = ['demo-load', 'demo-bridge', 'demo-gateway', 'demo-orders', 'demo-payments', 'demo-jaeger', 'demo-redis', 'demo-postgres'];
compose(['rm', '-sf', ...services]);
log('demo services stopped and removed. Their data lived in memory and is gone; the demo organisation in OPSILUME is kept.');
