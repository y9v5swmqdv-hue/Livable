const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

const stripeSecret     = defineSecret('STRIPE_SECRET');
const stripeWebhookSec = defineSecret('STRIPE_WEBHOOK_SECRET');

const PLATFORM_FEE = 0.20;

const VALID_AMOUNTS = {
  gbp: { 1: 1500, 2: 1700, 3: 2000, 4: 2500 },
  eur: { 1: 1800, 2: 2000, 3: 2400, 4: 2900 }
};

// ── CREATE PAYMENT INTENT ──
exports.createPaymentIntent = onCall(
  { region: 'europe-west1', secrets: [stripeSecret] },
  async (request) => {
    const { projectId, amount, currency, tier } = request.data;

    if (!projectId || !amount || !currency || !tier) {
      throw new HttpsError('invalid-argument', 'Missing required fields.');
    }

    const expectedAmount = VALID_AMOUNTS[currency] && VALID_AMOUNTS[currency][tier];
    if (!expectedAmount || amount !== expectedAmount) {
      throw new HttpsError('invalid-argument', 'Invalid amount for tier.');
    }

    const stripe = require('stripe')(stripeSecret.value());

    const projSnap = await db.collection('projects').doc(projectId).get();
    if (!projSnap.exists) {
      throw new HttpsError('not-found', 'Project not found.');
    }
    const proj = projSnap.data();

    const platformFeeAmount = Math.round(amount * PLATFORM_FEE);

    const paymentIntent = await stripe.paymentIntents.create({
      amount:   amount,
      currency: currency,
      automatic_payment_methods: { enabled: true },
      metadata: {
        projectId:     projectId,
        tier:          String(tier),
        clientName:    proj.clientName  || '',
        clientEmail:   proj.clientEmail || '',
        platformFee:   String(platformFeeAmount),
        designerShare: String(amount - platformFeeAmount)
      },
      description: 'Livable Interior Design - ' + (proj.style || 'Room Design') + ' (Tier ' + tier + ')'
    });

    await db.collection('projects').doc(projectId).update({
      paymentIntentId: paymentIntent.id,
      paymentStatus:   'pending',
      amount:          amount,
      currency:        currency,
      tier:            tier,
      platformFee:     platformFeeAmount,
      designerShare:   amount - platformFeeAmount
    });

    return { clientSecret: paymentIntent.client_secret };
  }
);

// ── STRIPE WEBHOOK ──
exports.stripeWebhook = onRequest(
  { region: 'europe-west1', secrets: [stripeSecret, stripeWebhookSec] },
  async (req, res) => {
    const sig    = req.headers['stripe-signature'];
    const stripe = require('stripe')(stripeSecret.value());

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        sig,
        stripeWebhookSec.value()
      );
    } catch(err) {
      console.log('Webhook signature failed:', err.message);
      return res.status(400).send('Webhook Error: ' + err.message);
    }

    if (event.type === 'payment_intent.succeeded') {
      const intent    = event.data.object;
      const projectId = intent.metadata.projectId;
      if (projectId) {
        await db.collection('projects').doc(projectId).update({
          paid:          true,
          paymentStatus: 'paid',
          paidAt:        admin.firestore.FieldValue.serverTimestamp(),
          status:        'unassigned'
        }).catch(e => console.log('Firestore error:', e.message));
      }
    }

    if (event.type === 'payment_intent.payment_failed') {
      const intent    = event.data.object;
      const projectId = intent.metadata.projectId;
      if (projectId) {
        await db.collection('projects').doc(projectId).update({
          paymentStatus: 'failed'
        }).catch(e => console.log('Firestore error:', e.message));
      }
    }

    res.json({ received: true });
  }
);
