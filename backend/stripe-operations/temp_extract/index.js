const AWS = require('aws-sdk');
const crypto = require('crypto');

const dynamodb = new AWS.DynamoDB.DocumentClient();
const ssm = new AWS.SSM();

// Stripe will be initialized after loading secret key
let stripe;
let STRIPE_WEBHOOK_SECRET;

const PRICE_IDS = {
  starter_monthly: 'price_1SH7P0RE8RY21XQR5ENSFeIX',
  starter_yearly: 'price_1SH7PYRE8RY21XQRZ9b45Wkg',
  pro_monthly: 'price_1SH7PZRE8RY21XQRUGGQoU1Q',
  pro_yearly: 'price_1SH7PZRE8RY21XQRhK4D3dLH',
  business_monthly: 'price_1SH7PaRE8RY21XQRNpRVVfeO',
  business_yearly: 'price_1SH7PaRE8RY21XQRPsPo5IuP'
};

const TIER_LIMITS = {
  starter: {
    staticQRs: Infinity,
    dynamicQRs: 50,
    shortURLs: 1000,
    customDomains: 1,
    apiCalls: 0,
    teamMembers: 0
  },
  pro: {
    staticQRs: Infinity,
    dynamicQRs: 500,
    shortURLs: 10000,
    customDomains: Infinity,
    apiCalls: 10000,
    teamMembers: 5
  },
  business: {
    staticQRs: Infinity,
    dynamicQRs: 5000,
    shortURLs: 100000,
    customDomains: Infinity,
    apiCalls: Infinity,
    teamMembers: Infinity
  }
};

exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));

  try {
    // Initialize Stripe if not cached
    if (!stripe) {
      const stripeKey = await getParameter('/snapitqr/stripe-secret-key');
      stripe = require('stripe')(stripeKey);
    }

    if (!STRIPE_WEBHOOK_SECRET) {
      STRIPE_WEBHOOK_SECRET = await getParameter('/snapitqr/stripe-webhook-secret');
    }

    const path = event.resource;
    const method = event.httpMethod;

    // CORS headers
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,Stripe-Signature',
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      'Content-Type': 'application/json'
    };

    // Handle OPTIONS for CORS
    if (method === 'OPTIONS') {
      return { statusCode: 200, headers, body: '' };
    }

    // Route to appropriate handler
    if ((path === '/stripe/create-checkout' || path === '/create-checkout-session') && method === 'POST') {
      return await createCheckoutSession(event, headers);
    } else if (path === '/stripe/webhook' && method === 'POST') {
      return await handleWebhook(event, headers);
    } else if (path === '/stripe/portal' && method === 'POST') {
      return await createPortalSession(event, headers);
    }

    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Not found' })
    };

  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        error: 'Internal server error',
        message: error.message
      })
    };
  }
};

async function createCheckoutSession(event, headers) {
  const userId = event.requestContext.authorizer?.userId;

  if (!userId) {
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: 'Authentication required' })
    };
  }

  const body = JSON.parse(event.body || '{}');
  const { priceId, successUrl, cancelUrl } = body;

  if (!priceId) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Price ID is required' })
    };
  }

  // Validate price ID
  if (!Object.values(PRICE_IDS).includes(priceId)) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid price ID' })
    };
  }

  // Get user
  const result = await dynamodb.get({
    TableName: 'snapitqr-users',
    Key: { userId }
  }).promise();

  if (!result.Item) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'User not found' })
    };
  }

  const user = result.Item;

  // Create or retrieve Stripe customer
  let customerId = user.stripeCustomerId;

  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      name: user.name,
      metadata: {
        userId: userId
      }
    });
    customerId = customer.id;

    // Save customer ID to user record
    await dynamodb.update({
      TableName: 'snapitqr-users',
      Key: { userId },
      UpdateExpression: 'SET stripeCustomerId = :customerId',
      ExpressionAttributeValues: {
        ':customerId': customerId
      }
    }).promise();
  }

  // Determine if this is a recurring or one-time payment
  const isYearly = priceId.includes('yearly');
  const mode = isYearly ? 'payment' : 'subscription';

  // Create checkout session
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: mode,
    payment_method_types: ['card'],
    line_items: [
      {
        price: priceId,
        quantity: 1
      }
    ],
    success_url: successUrl || 'https://snapitqr.com/dashboard?success=true',
    cancel_url: cancelUrl || 'https://snapitqr.com/pricing?canceled=true',
    metadata: {
      userId: userId,
      priceId: priceId
    }
  });

  // Track analytics event
  await trackAnalyticsEvent({
    eventType: 'checkout_initiated',
    userId,
    metadata: {
      priceId,
      sessionId: session.id,
      mode
    }
  });

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      sessionId: session.id,
      url: session.url
    })
  };
}

async function createPortalSession(event, headers) {
  const userId = event.requestContext.authorizer?.userId;

  if (!userId) {
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: 'Authentication required' })
    };
  }

  const body = JSON.parse(event.body || '{}');
  const { returnUrl } = body;

  // Get user
  const result = await dynamodb.get({
    TableName: 'snapitqr-users',
    Key: { userId }
  }).promise();

  if (!result.Item || !result.Item.stripeCustomerId) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'No active subscription' })
    };
  }

  // Create portal session
  const session = await stripe.billingPortal.sessions.create({
    customer: result.Item.stripeCustomerId,
    return_url: returnUrl || 'https://snapitqr.com/dashboard'
  });

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      url: session.url
    })
  };
}

async function handleWebhook(event, headers) {
  const sig = event.headers['Stripe-Signature'] || event.headers['stripe-signature'];

  if (!sig) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Missing Stripe signature' })
    };
  }

  let stripeEvent;

  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid signature' })
    };
  }

  console.log('Stripe event type:', stripeEvent.type);

  // Handle the event
  switch (stripeEvent.type) {
    case 'checkout.session.completed':
      await handleCheckoutCompleted(stripeEvent.data.object);
      break;

    case 'customer.subscription.created':
      await handleSubscriptionCreated(stripeEvent.data.object);
      break;

    case 'customer.subscription.updated':
      await handleSubscriptionUpdated(stripeEvent.data.object);
      break;

    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(stripeEvent.data.object);
      break;

    case 'invoice.payment_succeeded':
      await handlePaymentSucceeded(stripeEvent.data.object);
      break;

    case 'invoice.payment_failed':
      await handlePaymentFailed(stripeEvent.data.object);
      break;

    default:
      console.log('Unhandled event type:', stripeEvent.type);
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ received: true })
  };
}

async function handleCheckoutCompleted(session) {
  const userId = session.metadata.userId;
  const priceId = session.metadata.priceId;

  if (!userId) {
    console.error('No userId in session metadata');
    return;
  }

  // Determine tier from price ID
  const tier = getTierFromPriceId(priceId);
  const isYearly = priceId.includes('yearly');

  // Update user record
  await dynamodb.update({
    TableName: 'snapitqr-users',
    Key: { userId },
    UpdateExpression: 'SET tier = :tier, subscriptionStatus = :status, stripeCustomerId = :customerId, usageLimits = :limits, updatedAt = :updatedAt',
    ExpressionAttributeValues: {
      ':tier': tier,
      ':status': 'active',
      ':customerId': session.customer,
      ':limits': TIER_LIMITS[tier],
      ':updatedAt': new Date().toISOString()
    }
  }).promise();

  // Track analytics event
  await trackAnalyticsEvent({
    eventType: 'subscription_started',
    userId,
    metadata: {
      tier,
      priceId,
      isYearly,
      sessionId: session.id
    }
  });

  console.log(`User ${userId} upgraded to ${tier}`);
}

async function handleSubscriptionCreated(subscription) {
  const customerId = subscription.customer;
  const priceId = subscription.items.data[0].price.id;
  const tier = getTierFromPriceId(priceId);

  // Find user by Stripe customer ID
  const users = await dynamodb.query({
    TableName: 'snapitqr-users',
    IndexName: 'stripeCustomerId-index',
    KeyConditionExpression: 'stripeCustomerId = :customerId',
    ExpressionAttributeValues: {
      ':customerId': customerId
    }
  }).promise();

  if (!users.Items || users.Items.length === 0) {
    console.error('User not found for customer:', customerId);
    return;
  }

  const userId = users.Items[0].userId;

  // Update user record
  await dynamodb.update({
    TableName: 'snapitqr-users',
    Key: { userId },
    UpdateExpression: 'SET tier = :tier, subscriptionStatus = :status, stripeSubscriptionId = :subId, usageLimits = :limits, updatedAt = :updatedAt',
    ExpressionAttributeValues: {
      ':tier': tier,
      ':status': subscription.status,
      ':subId': subscription.id,
      ':limits': TIER_LIMITS[tier],
      ':updatedAt': new Date().toISOString()
    }
  }).promise();

  console.log(`Subscription created for user ${userId}: ${tier}`);
}

async function handleSubscriptionUpdated(subscription) {
  const customerId = subscription.customer;
  const priceId = subscription.items.data[0].price.id;
  const tier = getTierFromPriceId(priceId);

  // Find user
  const users = await dynamodb.query({
    TableName: 'snapitqr-users',
    IndexName: 'stripeCustomerId-index',
    KeyConditionExpression: 'stripeCustomerId = :customerId',
    ExpressionAttributeValues: {
      ':customerId': customerId
    }
  }).promise();

  if (!users.Items || users.Items.length === 0) {
    console.error('User not found for customer:', customerId);
    return;
  }

  const userId = users.Items[0].userId;

  // Update user record
  await dynamodb.update({
    TableName: 'snapitqr-users',
    Key: { userId },
    UpdateExpression: 'SET tier = :tier, subscriptionStatus = :status, usageLimits = :limits, updatedAt = :updatedAt',
    ExpressionAttributeValues: {
      ':tier': tier,
      ':status': subscription.status,
      ':limits': TIER_LIMITS[tier],
      ':updatedAt': new Date().toISOString()
    }
  }).promise();

  // Track analytics event
  await trackAnalyticsEvent({
    eventType: 'subscription_updated',
    userId,
    metadata: {
      tier,
      status: subscription.status,
      priceId
    }
  });

  console.log(`Subscription updated for user ${userId}: ${tier} (${subscription.status})`);
}

async function handleSubscriptionDeleted(subscription) {
  const customerId = subscription.customer;

  // Find user
  const users = await dynamodb.query({
    TableName: 'snapitqr-users',
    IndexName: 'stripeCustomerId-index',
    KeyConditionExpression: 'stripeCustomerId = :customerId',
    ExpressionAttributeValues: {
      ':customerId': customerId
    }
  }).promise();

  if (!users.Items || users.Items.length === 0) {
    console.error('User not found for customer:', customerId);
    return;
  }

  const userId = users.Items[0].userId;

  // Downgrade to free tier
  await dynamodb.update({
    TableName: 'snapitqr-users',
    Key: { userId },
    UpdateExpression: 'SET tier = :tier, subscriptionStatus = :status, usageLimits = :limits, updatedAt = :updatedAt',
    ExpressionAttributeValues: {
      ':tier': 'free',
      ':status': 'canceled',
      ':limits': {
        staticQRs: Infinity,
        dynamicQRs: 3,
        shortURLs: 100,
        apiCalls: 0
      },
      ':updatedAt': new Date().toISOString()
    }
  }).promise();

  // Track analytics event
  await trackAnalyticsEvent({
    eventType: 'subscription_canceled',
    userId,
    metadata: {
      subscriptionId: subscription.id
    }
  });

  console.log(`Subscription canceled for user ${userId}, downgraded to free tier`);
}

async function handlePaymentSucceeded(invoice) {
  const customerId = invoice.customer;

  // Find user
  const users = await dynamodb.query({
    TableName: 'snapitqr-users',
    IndexName: 'stripeCustomerId-index',
    KeyConditionExpression: 'stripeCustomerId = :customerId',
    ExpressionAttributeValues: {
      ':customerId': customerId
    }
  }).promise();

  if (!users.Items || users.Items.length === 0) {
    console.error('User not found for customer:', customerId);
    return;
  }

  const userId = users.Items[0].userId;

  // Track analytics event
  await trackAnalyticsEvent({
    eventType: 'payment_succeeded',
    userId,
    metadata: {
      invoiceId: invoice.id,
      amount: invoice.amount_paid / 100,
      currency: invoice.currency
    }
  });

  console.log(`Payment succeeded for user ${userId}: $${invoice.amount_paid / 100}`);
}

async function handlePaymentFailed(invoice) {
  const customerId = invoice.customer;

  // Find user
  const users = await dynamodb.query({
    TableName: 'snapitqr-users',
    IndexName: 'stripeCustomerId-index',
    KeyConditionExpression: 'stripeCustomerId = :customerId',
    ExpressionAttributeValues: {
      ':customerId': customerId
    }
  }).promise();

  if (!users.Items || users.Items.length === 0) {
    console.error('User not found for customer:', customerId);
    return;
  }

  const userId = users.Items[0].userId;

  // Track analytics event
  await trackAnalyticsEvent({
    eventType: 'payment_failed',
    userId,
    metadata: {
      invoiceId: invoice.id,
      amount: invoice.amount_due / 100,
      currency: invoice.currency
    }
  });

  console.log(`Payment failed for user ${userId}`);
}

function getTierFromPriceId(priceId) {
  if (priceId.includes('1SH7P0') || priceId.includes('1SH7PY')) {
    return 'starter';
  } else if (priceId.includes('1SH7PZ')) {
    return 'pro';
  } else if (priceId.includes('1SH7Pa')) {
    return 'business';
  }
  return 'free';
}

async function getParameter(name) {
  const result = await ssm.getParameter({
    Name: name,
    WithDecryption: true
  }).promise();

  return result.Parameter.Value;
}

async function trackAnalyticsEvent(event) {
  const { v4: uuidv4 } = require('uuid');
  const eventId = uuidv4();
  const now = new Date();
  const ttl = Math.floor(now.getTime() / 1000) + (365 * 24 * 60 * 60); // 1 year TTL

  await dynamodb.put({
    TableName: 'snapitqr-analytics',
    Item: {
      eventId,
      ...event,
      timestamp: now.toISOString(),
      ttl
    }
  }).promise();
}
