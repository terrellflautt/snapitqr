const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient();

exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));

  try {
    const path = event.resource;
    const method = event.httpMethod;
    const userId = event.requestContext.authorizer?.userId;

    // CORS headers
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Content-Type': 'application/json'
    };

    // Handle OPTIONS for CORS
    if (method === 'OPTIONS') {
      return { statusCode: 200, headers, body: '' };
    }

    if (!userId) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Unauthorized' })
      };
    }

    // Route to appropriate handler
    if (path === '/analytics/url/{shortCode}' && method === 'GET') {
      return await getURLAnalytics(event, userId, headers);
    } else if ((path === '/analytics/dashboard' || path === '/dashboard-data') && method === 'GET') {
      return await getDashboardAnalytics(event, userId, headers);
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

// Get detailed analytics for a specific short URL
async function getURLAnalytics(event, userId, headers) {
  const shortCode = event.pathParameters.shortCode;

  // Get URL details
  const urlResult = await dynamodb.get({
    TableName: 'snapitqr-shorturls',
    Key: { shortCode }
  }).promise();

  if (!urlResult.Item) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Short URL not found' })
    };
  }

  // Check ownership
  if (urlResult.Item.userId !== userId) {
    return {
      statusCode: 403,
      headers,
      body: JSON.stringify({ error: 'Access denied' })
    };
  }

  const url = urlResult.Item;

  // Get analytics events for this short URL
  const analyticsResult = await dynamodb.query({
    TableName: 'snapitqr-analytics',
    IndexName: 'shortCode-timestamp-index',
    KeyConditionExpression: 'shortCode = :shortCode',
    ExpressionAttributeValues: {
      ':shortCode': shortCode
    },
    ScanIndexForward: true // Oldest first for time series
  }).promise();

  // Process analytics by day
  const clicksByDay = {};
  const clicksByCountry = {};
  let totalClicks = 0;

  analyticsResult.Items.forEach(event => {
    if (event.eventType === 'url_clicked') {
      totalClicks++;

      // Group by day
      const day = event.timestamp.split('T')[0]; // Get YYYY-MM-DD
      clicksByDay[day] = (clicksByDay[day] || 0) + 1;

      // Group by country
      const country = event.metadata?.country || 'Unknown';
      clicksByCountry[country] = (clicksByCountry[country] || 0) + 1;
    }
  });

  // Convert to arrays for chart
  const timeSeriesData = Object.entries(clicksByDay).map(([date, clicks]) => ({
    date,
    clicks
  })).sort((a, b) => a.date.localeCompare(b.date));

  const countryData = Object.entries(clicksByCountry)
    .map(([country, clicks]) => ({ country, clicks }))
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 10); // Top 10 countries

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      url: {
        shortCode: url.shortCode,
        originalUrl: url.originalUrl,
        title: url.title,
        createdAt: url.createdAt,
        expiresAt: url.expiresAt,
        status: url.status
      },
      analytics: {
        totalClicks: url.clicks || 0, // Total from URL record
        clicksByDay: timeSeriesData,
        clicksByCountry: countryData,
        recentClicks: analyticsResult.Items
          .filter(e => e.eventType === 'url_clicked')
          .slice(-20) // Last 20 clicks
          .reverse() // Most recent first
          .map(e => ({
            timestamp: e.timestamp,
            userAgent: e.metadata?.userAgent,
            country: e.metadata?.country,
            referer: e.metadata?.referer
          }))
      }
    })
  };
}

// Get dashboard analytics overview for all user's URLs
async function getDashboardAnalytics(event, userId, headers) {
  // Get all URLs for this user
  const urlsResult = await dynamodb.query({
    TableName: 'snapitqr-shorturls',
    IndexName: 'userId-createdAt-index',
    KeyConditionExpression: 'userId = :userId',
    ExpressionAttributeValues: {
      ':userId': userId
    },
    ScanIndexForward: false // Most recent first
  }).promise();

  // For each URL, calculate daily clicks from the last 30 days
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const thirtyDaysAgoISO = thirtyDaysAgo.toISOString();

  const urlsWithAnalytics = await Promise.all(
    urlsResult.Items.map(async (url) => {
      // Get recent clicks for this URL
      const analyticsResult = await dynamodb.query({
        TableName: 'snapitqr-analytics',
        IndexName: 'shortCode-timestamp-index',
        KeyConditionExpression: 'shortCode = :shortCode AND #timestamp >= :startDate',
        ExpressionAttributeNames: {
          '#timestamp': 'timestamp'
        },
        ExpressionAttributeValues: {
          ':shortCode': url.shortCode,
          ':startDate': thirtyDaysAgoISO
        }
      }).promise();

      // Calculate daily clicks
      const clicksByDay = {};
      analyticsResult.Items.forEach(event => {
        if (event.eventType === 'url_clicked') {
          const day = event.timestamp.split('T')[0];
          clicksByDay[day] = (clicksByDay[day] || 0) + 1;
        }
      });

      // Determine which domain was used (from the URL or default)
      const domain = url.shortCode.startsWith('qr-') ? 'snapitqr.com' : 'snapiturl.com';

      // Calculate expiry status
      let expiryStatus = 'active';
      if (url.expiresAt) {
        const expiryDate = new Date(url.expiresAt);
        const now = new Date();
        if (expiryDate < now) {
          expiryStatus = 'expired';
        } else {
          const daysUntilExpiry = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
          expiryStatus = daysUntilExpiry <= 7 ? 'expiring-soon' : 'active';
        }
      }

      return {
        shortCode: url.shortCode,
        shortUrl: `https://${domain}/${url.shortCode}`,
        originalUrl: url.originalUrl,
        title: url.title,
        domain: domain,
        createdAt: url.createdAt,
        expiresAt: url.expiresAt,
        expiryStatus: expiryStatus,
        status: url.status,
        totalClicks: url.clicks || 0,
        clicksLast30Days: Object.values(clicksByDay).reduce((sum, count) => sum + count, 0),
        dailyClicks: clicksByDay // For chart data
      };
    })
  );

  // Calculate summary stats
  const summary = {
    totalUrls: urlsWithAnalytics.length,
    activeUrls: urlsWithAnalytics.filter(u => u.status === 'active').length,
    expiredUrls: urlsWithAnalytics.filter(u => u.expiryStatus === 'expired').length,
    totalClicks: urlsWithAnalytics.reduce((sum, u) => sum + u.totalClicks, 0),
    clicksLast30Days: urlsWithAnalytics.reduce((sum, u) => sum + u.clicksLast30Days, 0)
  };

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      summary,
      urls: urlsWithAnalytics
    })
  };
}
