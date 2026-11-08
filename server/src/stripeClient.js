import Stripe from 'stripe';

/** One Stripe client instance. The API version is explicit; the key comes from the environment. */
export function createStripe(config) {
  if (!config.stripeSecretKey) throw new Error('Stripe secret key is not configured');
  return new Stripe(config.stripeSecretKey, {
    apiVersion: config.apiVersion,
    appInfo: { name: 'bracket', url: 'https://github.com/methodicaljon/bracket' },
    maxNetworkRetries: 2
  });
}
