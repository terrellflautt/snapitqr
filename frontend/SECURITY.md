# Security Configuration for SnapIT QR

## 🔒 Sensitive Data Protection

This repository has been secured to protect sensitive information. All sensitive configuration has been moved to external files that are not tracked in version control.

## 📋 Required Configuration Files

### 1. config.js (REQUIRED - Not in repository)

Copy `config.template.js` to `config.js` and fill in your actual values:

```javascript
window.SNAPIT_CONFIG = {
    GOOGLE_CLIENT_ID: 'your-google-oauth-client-id',
    STRIPE_PUBLISHABLE_KEY: 'your-stripe-publishable-key',
    WEB3FORMS_ACCESS_KEY: 'your-web3forms-access-key',
    BUSINESS_EMAIL: 'your-business-email@domain.com'
};
```

### 2. AWS SSM Parameters

Store sensitive server-side values in AWS Systems Manager Parameter Store:

- `/snapitqr/google/client-secret`
- `/snapitqr/stripe/secret-key`
- `/snapitqr/jwt/secret`

## 🚨 Security Best Practices

### What NOT to commit:
- ❌ API keys or secrets
- ❌ OAuth client secrets
- ❌ Database credentials
- ❌ Email access codes
- ❌ Live Stripe keys
- ❌ Business email addresses

### What IS safe to commit:
- ✅ Public configuration templates
- ✅ Code structure and logic
- ✅ Documentation
- ✅ Frontend assets

## 🔧 Deployment Instructions

1. **Local Development:**
   ```bash
   cp config.template.js config.js
   # Edit config.js with your development values
   ```

2. **Production Deployment:**
   - Deploy `config.js` separately through secure channels
   - Ensure config.js is served over HTTPS
   - Verify config.js is not accessible publicly

3. **Verify Security:**
   ```bash
   # Check that sensitive files are ignored
   git status
   # Should not show config.js or any *-secret.txt files
   ```

## 🛡️ Security Checklist

- [ ] config.js created with real values
- [ ] All sensitive data moved to config.js
- [ ] .gitignore includes sensitive file patterns
- [ ] AWS SSM parameters configured
- [ ] Production Stripe keys in place
- [ ] OAuth secrets secured

## 📞 Support

For security-related questions, contact the development team privately.

**DO NOT** post sensitive configuration questions in public forums or GitHub issues.