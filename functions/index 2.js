const functions  = require('firebase-functions');
const admin      = require('firebase-admin');
const stripe     = require('stripe')(functions.config().stripe.secret);

admin.initializeApp();
const db = admin.firestore();

// Platform fee percentage Livable keeps (20%)
const PLATFORM_FEE = 0.20;

// ── CREATE PAYMENT INTENT ──
exports.createPaymentIntent = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const { projectId, amount, currency, tier } = data;

    if (!projectId || !amount || !currency) {
      throw new functions.https.HttpsError('invalid-argument', 'Missing required fields.');
    }

    // Validate amount matches expected tier pricing
    const validAmounts = {
      gbp: { 1: 1500, 2: 1700, 3: 2000, 4: 2500 },
      eur: { 1: 1800, 2: 2000, 3: 2400, 4: 2900 }
    };

    const expectedAmount = validAmounts[currency] && validAmounts[currency][tier];
    if (!expectedAmount || amount !== expectedAmount) {
      throw new functions.https.HttpsError('invalid-argument', 'Invalid amount for tier.');
    }

    // Get project details
    const projSnap = await db.collection('projects').doc(projectId).get();
    if (!projSnap.exists) {
      throw new functions.https.HttpsError('not-found', 'Project not found.');
    }
    const proj = projSnap.data();

    // Calculate platform fee (Livable keeps 20%, designer gets 80%)
    const platformFeeAmount = Math.round(amount * PLATFORM_FEE);

    // Create PaymentIntent
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

    // Save intent ID to Firestore
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
  });

// ── STRIPE WEBHOOK ──
// Handles payment confirmation from Stripe
exports.stripeWebhook = functions
  .region('europe-west1')
  .https.onRequest(async (req, res) => {
    const sig     = req.headers['stripe-signature'];
    const secret  = functions.config().stripe.webhook_secret;

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.rawBody, sig, secret);
    } catch(err) {
      console.log('Webhook signature failed:', err.message);
      return res.status(400).send('Webhook Error: ' + err.message);
    }

    if (event.type === 'payment_intent.succeeded') {
      const intent    = event.data.object;
      const projectId = intent.metadata.projectId;

      if (projectId) {
        try {
          await db.collection('projects').doc(projectId).update({
            paid:          true,
            paymentStatus: 'paid',
            paidAt:        admin.firestore.FieldValue.serverTimestamp(),
            status:        'unassigned'
          });
          console.log('Payment confirmed for project:', projectId);
        } catch(e) {
          console.log('Firestore update error:', e.message);
        }
      }
    }

    if (event.type === 'payment_intent.payment_failed') {
      const intent    = event.data.object;
      const projectId = intent.metadata.projectId;
      if (projectId) {
        await db.collection('projects').doc(projectId).update({
          paymentStatus: 'failed'
        }).catch(function(){});
      }
    }

    res.json({ received: true });
  });
