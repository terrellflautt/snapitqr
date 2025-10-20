const AWS = require('aws-sdk');
const lambda = new AWS.Lambda();

// Route mappings to Lambda functions
const ROUTE_MAP = {
  '/auth/google': 'snapitqr-auth-operations',
  '/auth/me': 'snapitqr-auth-operations',
  '/auth/refresh': 'snapitqr-auth-operations',
  '/qr/generate': 'snapitqr-qr-operations',
  '/qr/list': 'snapitqr-qr-operations',
  '/qr-codes': 'snapitqr-qr-operations',
  '/url/shorten': 'snapitqr-url-operations',
  '/url/list': 'snapitqr-url-operations',
  '/url': 'snapitqr-url-operations',
  '/short-urls': 'snapitqr-url-operations',
  '/analytics': 'snapitqr-analytics-operations',
  '/generate': 'snapitqr-qr-operations',
  '/dashboard-data': 'snapitqr-user-operations',
  '/create-checkout-session': 'snapitqr-stripe-operations',
  '/stripe/create-checkout': 'snapitqr-stripe-operations',
  '/stripe/webhook': 'snapitqr-stripe-operations',
  '/stripe/portal': 'snapitqr-stripe-operations',
  '/user/usage': 'snapitqr-user-operations',
  '/user/profile': 'snapitqr-user-operations'
};

exports.handler = async (event) => {
  console.log('Router received event:', JSON.stringify(event, null, 2));

  try {
    // Extract path - handle both direct paths and proxy paths
    let path = event.path || event.rawPath;

    // If resource is a proxy ({proxy+}), use path instead
    if (event.resource === '/{proxy+}') {
      path = event.path;
    }

    // Remove stage prefix if present (e.g., /production/auth/google -> /auth/google)
    path = path.replace(/^\/production/, '');

    const method = event.httpMethod || event.requestContext?.http?.method;

    console.log('Routing request:', { path, method, resource: event.resource, originalPath: event.path });

    // CORS preflight
    if (method === 'OPTIONS') {
      return {
        statusCode: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type,Authorization',
          'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
        },
        body: ''
      };
    }

    // Find matching route
    let targetFunction = null;

    // Try exact match first
    if (ROUTE_MAP[path]) {
      targetFunction = ROUTE_MAP[path];
    } else {
      // Try pattern matching for dynamic routes like /qr/{id}
      for (const [route, funcName] of Object.entries(ROUTE_MAP)) {
        if (path.startsWith(route.split('{')[0])) {
          targetFunction = funcName;
          break;
        }
      }
    }

    if (!targetFunction) {
      console.log('No route found for:', path);
      return {
        statusCode: 404,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ error: 'Route not found', path })
      };
    }

    console.log('Invoking Lambda:', targetFunction);

    // Invoke the target Lambda function
    const result = await lambda.invoke({
      FunctionName: targetFunction,
      InvocationType: 'RequestResponse',
      Payload: JSON.stringify(event)
    }).promise();

    // Parse the response
    const response = JSON.parse(result.Payload);

    console.log('Lambda response:', { statusCode: response.statusCode });

    return response;

  } catch (error) {
    console.error('Router error:', error);
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        error: 'Internal server error',
        message: error.message,
        type: 'RouterError'
      })
    };
  }
};
