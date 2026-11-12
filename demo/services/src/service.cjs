// Entry point: SERVICE_ROLE picks which of the three services this process is.
const role = process.env.SERVICE_ROLE;
if (!['gateway', 'orders', 'payments'].includes(role)) throw new Error(`SERVICE_ROLE must be gateway, orders or payments (got ${role})`);
require(`./${role}.cjs`);
