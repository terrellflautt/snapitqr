// Configuration Template for SnapIT QR
// Copy this to config.js and fill in your actual values
// NEVER commit config.js to public repositories

window.SNAPIT_CONFIG = {
    // Google OAuth Configuration
    GOOGLE_CLIENT_ID: 'YOUR_GOOGLE_CLIENT_ID_HERE',

    // Stripe Configuration
    STRIPE_PUBLISHABLE_KEY: 'YOUR_STRIPE_PUBLISHABLE_KEY_HERE',

    // Web3Forms Configuration (for contact forms)
    WEB3FORMS_ACCESS_KEY: 'YOUR_WEB3FORMS_ACCESS_KEY_HERE',

    // Business Configuration
    BUSINESS_EMAIL: 'YOUR_BUSINESS_EMAIL_HERE',

    // API Endpoints
    API_BASE_URL: 'https://api.snapitqr.com',
    API_BASE_URL_SNAPITURL: 'https://api.snapiturl.com',

    // Stripe Price IDs (these can be public)
    STRIPE_PLANS: {
        starter: { priceId: 'price_starter_snapitqr', amount: '$3.99', name: 'Starter' },
        professional: { priceId: 'price_professional_snapitqr', amount: '$9.99', name: 'Professional' },
        business: { priceId: 'price_business_snapitqr', amount: '$29.99', name: 'Business' },
        enterprise: { priceId: 'price_enterprise_snapitqr', amount: '$99.99', name: 'Enterprise' }
    }
};

// Instructions:
// 1. Copy this file to config.js
// 2. Replace all 'YOUR_*_HERE' values with actual credentials
// 3. Add config.js to your .gitignore file
// 4. Deploy config.js privately to your hosting environment